import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  BackendModelDescriptor,
  CandidateProviderState,
  ProviderCandidate,
  RouteIdentityV1,
} from "./backends.js";
import {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
  saveConfig as saveConfigDefault,
  validateConfig,
  type ConfigInput,
  type OrcodeConfigWithBudget,
} from "./config.js";
import {
  normalizeProviderSecret,
  type CredentialSlotRef,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import type { OpenRouterBackendAdapter } from "./openrouter-backend.js";
import {
  PrivateStore,
  type PrivateDirectoryClaim,
} from "./private-store.js";
import {
  ProviderStateStore,
  isProviderStateIssue,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderSetupStateV1,
} from "./provider-state.js";
import { isRecord } from "./utils.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVATION_DIRECTORY = "provider-activation";
const LEASE_DIRECTORY = "provider-setup.lock";
const OWNER_FILE_LIMIT = 4_096;
const MANIFEST_FILE_LIMIT = 64 * 1_024;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_LEASE_ATTEMPTS = 64;

export const PROVIDER_ACTIVATION_BOUNDARIES = [
  "candidate-validated",
  "journal-written",
  "slot-written",
  "slot-readback",
  "candidate-revalidated",
  "models-loaded",
  "model-selected",
  "config-written",
  "config-readback",
  "runtime-activated",
  "old-slot-cleaned",
] as const;

export type ProviderActivationBoundary =
  (typeof PROVIDER_ACTIVATION_BOUNDARIES)[number];

export interface ProviderActivationJournalV1 {
  version: 1;
  transactionId: string;
  expectedRevision: number;
  phase: "prepared" | "credential-staged" | "config-committed";
  backendId: "openrouter";
  candidateSlot: CredentialSlotRef;
  previousSlot:
    | CredentialSlotRef
    | { version: 0; kind: "inference"; id: "legacy:inference" }
    | null;
  candidateConnectionId: string;
  candidateRoute: RouteIdentityV1;
}

export interface ProviderActivationResult {
  persisted: boolean;
  route: RouteIdentityV1;
  state: ProviderSetupStateV1 | null;
  warnings: readonly string[];
}

export interface ProviderActivationRuntimeLease {
  assertHeld(): void | Promise<void>;
  release(): void | Promise<void>;
}

export interface ProviderActivationRuntimeGuard {
  acquire(signal: AbortSignal): Promise<ProviderActivationRuntimeLease>;
}

export interface ProviderActivationRequest {
  expectedRevision: number;
  candidate: string;
  selectedCanonicalModelId: string;
  generation: number;
  signal: AbortSignal;
  persistence: "persisted" | "process-only";
  onPersistenceFailure?: () => Promise<"process-only" | "decline">;
}

export interface ProviderActivationRecoveryRequest {
  signal: AbortSignal;
  inspectCommitted?: boolean;
}

interface ActivationAdapter {
  connect(request: {
    candidate: unknown;
    generation: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate>;
  listModels(request: {
    candidateId?: string;
    signal: AbortSignal;
  }): Promise<readonly BackendModelDescriptor[]>;
  activate(request: {
    candidateId: string;
    model: BackendModelDescriptor;
    signal: AbortSignal;
  }): Promise<CandidateProviderState>;
  discardCandidate(candidateId: string): Promise<void>;
}

export interface ProviderActivationCoordinatorOptions {
  appHome: string;
  configPath: string;
  privateStore: PrivateStore;
  credentials: VersionedCredentialStoreLike;
  adapter: OpenRouterBackendAdapter | ActivationAdapter;
  stateStore: ProviderStateStore;
  runtimeGuard: ProviderActivationRuntimeGuard;
  now?: () => number;
  createUuid?: () => string;
  leaseDurationMs?: number;
  leaseAttempts?: number;
  waitForLease?: () => Promise<void>;
  saveConfig?: typeof saveConfigDefault;
  onBoundary?: (boundary: ProviderActivationBoundary) => void | Promise<void>;
}

interface LeaseOwnerV1 {
  version: 1;
  ownerId: string;
  acquiredAt: number;
  expiresAt: number;
}

interface HeldProviderLease {
  claim: PrivateDirectoryClaim;
  owner: LeaseOwnerV1;
  rawOwner: string;
}

interface TransactionJournal {
  path: string;
  manifestPath: string;
  manifest: ProviderActivationJournalV1;
}

type ConfigFacts =
  | { kind: "valid"; config: OrcodeConfigWithBudget }
  | { kind: "absent"; config: OrcodeConfigWithBudget }
  | { kind: "corrupt" | "future" | "unreadable" };

export class ProviderActivationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderActivationError";
  }
}

export class StaleProviderGenerationError extends ProviderActivationError {
  constructor() {
    super("provider-activation-stale", "Provider activation revision is stale.");
    this.name = "StaleProviderGenerationError";
  }
}

export class ProviderActivationRecoveryRequiredError extends ProviderActivationError {
  constructor(code = "provider-activation-recovery-required") {
    super(code, "Provider activation requires exact recovery before it can continue.");
    this.name = "ProviderActivationRecoveryRequiredError";
  }
}

export class ProviderActivationBusyError extends ProviderActivationError {
  constructor() {
    super("provider-activation-busy", "Provider activation lease is busy.");
    this.name = "ProviderActivationBusyError";
  }
}

export class ProviderActivationCoordinator {
  readonly #options: Required<Pick<
    ProviderActivationCoordinatorOptions,
    "now" | "createUuid" | "leaseDurationMs" | "leaseAttempts" | "waitForLease" | "saveConfig" | "onBoundary"
  >> & Omit<ProviderActivationCoordinatorOptions,
    "now" | "createUuid" | "leaseDurationMs" | "leaseAttempts" | "waitForLease" | "saveConfig" | "onBoundary">;

  constructor(options: ProviderActivationCoordinatorOptions) {
    if (!Number.isSafeInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS)
      || (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS) < 1) {
      throw new Error("Provider activation lease duration is invalid.");
    }
    if (!Number.isSafeInteger(options.leaseAttempts ?? DEFAULT_LEASE_ATTEMPTS)
      || (options.leaseAttempts ?? DEFAULT_LEASE_ATTEMPTS) < 1) {
      throw new Error("Provider activation lease attempts are invalid.");
    }
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      createUuid: options.createUuid ?? randomUUID,
      leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      leaseAttempts: options.leaseAttempts ?? DEFAULT_LEASE_ATTEMPTS,
      waitForLease: options.waitForLease
        ?? (() => new Promise<void>((resolve) => setImmediate(resolve))),
      saveConfig: options.saveConfig ?? saveConfigDefault,
      onBoundary: options.onBoundary ?? (() => undefined),
    };
  }

  async activate(request: ProviderActivationRequest): Promise<ProviderActivationResult> {
    throwIfAborted(request.signal);
    let runtimeLease: ProviderActivationRuntimeLease;
    try {
      runtimeLease = await this.#options.runtimeGuard.acquire(request.signal);
    } catch (error) {
      if (isAbort(error, request.signal)) throw abortFrom(request.signal);
      throw new ProviderActivationError(
        "provider-runtime-not-idle",
        "Provider runtime is not idle and drained.",
      );
    }
    let simulatedCrash = false;
    let providerLease: HeldProviderLease | null = null;
    let transaction: TransactionJournal | null = null;
    let initialCandidateId: string | null = null;
    let revalidatedCandidateId: string | null = null;
    try {
      await assertRuntimeLease(runtimeLease);
      const normalized = normalizeProviderSecret(request.candidate);
      const candidate = await this.#connectCandidate(
        normalized,
        request.generation,
        request.signal,
      );
      initialCandidateId = candidate.candidateId;
      await this.#boundary("candidate-validated");
      const models = await this.#listModels(candidate.candidateId, request.signal);
      await this.#boundary("models-loaded");
      const selectedModel = selectExplicitModel(models, request.selectedCanonicalModelId);
      const candidateRoute = routeForCandidate(candidate, selectedModel);
      await this.#boundary("model-selected");

      if (request.persistence === "process-only") {
        await assertRuntimeLease(runtimeLease);
        const activated = await this.#activateRuntime(
          candidate.candidateId,
          selectedModel,
          request.signal,
        );
        assertActivatedRoute(candidateRoute, activated);
        await this.#boundary("runtime-activated");
        return {
          persisted: false,
          route: structuredClone(candidateRoute),
          state: null,
          warnings: Object.freeze([]),
        };
      }

      providerLease = await this.#acquireProviderLease(request.signal);
      await this.#assertFence(providerLease);
      await this.#recoverUnderLease({
        signal: request.signal,
        inspectCommitted: false,
      }, providerLease, runtimeLease);
      await this.#assertFence(providerLease);
      await assertRuntimeLease(runtimeLease);
      const configFacts = await readConfigFacts(this.#options.configPath);
      if (configFacts.kind !== "valid" && configFacts.kind !== "absent") {
        throw new ProviderActivationRecoveryRequiredError("provider-config-unreadable");
      }
      const current = requireCurrentProviderState(configFacts.config);
      if (current.revision !== request.expectedRevision) {
        throw new StaleProviderGenerationError();
      }
      if (!Number.isSafeInteger(current.revision)
        || current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new ProviderActivationError(
          "provider-revision-overflow",
          "Provider activation revision is not safely incrementable.",
        );
      }
      await this.#assertFence(providerLease);
      let candidateSlot: CredentialSlotRef;
      try {
        candidateSlot = this.#options.credentials.reserveSlot("inference");
      } catch {
        throw new ProviderActivationError(
          "provider-credential-reservation-failed",
          "Provider credential reservation failed.",
        );
      }
      if (!Object.isFrozen(candidateSlot) || !isInferenceSlot(candidateSlot)) {
        throw new ProviderActivationError(
          "provider-credential-reservation-invalid",
          "Provider credential reservation is invalid.",
        );
      }
      const previousSlot = previousSlotFromState(current, candidate.connectionId);
      const transactionId = createCanonicalUuid(this.#options.createUuid);
      const manifest: ProviderActivationJournalV1 = {
        version: 1,
        transactionId,
        expectedRevision: current.revision,
        phase: "prepared",
        backendId: "openrouter",
        candidateSlot,
        previousSlot,
        candidateConnectionId: candidate.connectionId,
        candidateRoute,
      };
      transaction = await this.#createJournal(manifest, providerLease);
      await this.#boundary("journal-written");

      try {
        await this.#assertFence(providerLease);
        await assertRuntimeLease(runtimeLease);
        await this.#options.credentials.writeSlot(candidateSlot, normalized);
        await this.#assertFence(providerLease);
        await this.#boundary("slot-written");
        await this.#assertFence(providerLease);
        const readback = await this.#options.credentials.readSlot(candidateSlot);
        await this.#assertFence(providerLease);
        if (readback !== normalized) {
          throw new ProviderActivationRecoveryRequiredError("provider-candidate-readback-mismatch");
        }
        await this.#boundary("slot-readback");
        await this.#assertFence(providerLease);
        const revalidated = await this.#connectCandidate(
          readback,
          request.generation,
          request.signal,
        );
        revalidatedCandidateId = revalidated.candidateId;
        assertSameCandidate(candidate, revalidated);
        await this.#assertFence(providerLease);
        await this.#boundary("candidate-revalidated");
      } catch (error) {
        if (isBoundaryFault(error)) throw error;
        if (error instanceof ProviderActivationRecoveryRequiredError) throw error;
        const decision = request.onPersistenceFailure
          ? await request.onPersistenceFailure()
          : "decline";
        const cleaned = await this.#cleanupFailedCandidate(
          candidateSlot,
          normalized,
          transaction,
          providerLease,
        );
        transaction = cleaned ? null : transaction;
        if (!cleaned) {
          throw new ProviderActivationRecoveryRequiredError(
            "provider-candidate-cleanup-ambiguous",
          );
        }
        if (decision !== "process-only") {
          throw new ProviderActivationError(
            "provider-credential-persistence-failed",
            "Provider credential persistence failed without changing the active route.",
          );
        }
        await this.#releaseProviderLease(providerLease);
        providerLease = null;
        await assertRuntimeLease(runtimeLease);
        const activated = await this.#activateRuntime(
          candidate.candidateId,
          selectedModel,
          request.signal,
        );
        assertActivatedRoute(candidateRoute, activated);
        await this.#boundary("runtime-activated");
        return {
          persisted: false,
          route: structuredClone(candidateRoute),
          state: null,
          warnings: Object.freeze([]),
        };
      }

      manifest.phase = "credential-staged";
      await this.#writeJournal(transaction, manifest, providerLease);
      const nextState = buildNextState(
        current,
        candidate,
        candidateSlot,
        candidateRoute,
      );
      await this.#assertFence(providerLease);
      const beforeSave = await readConfigFacts(this.#options.configPath);
      await this.#assertFence(providerLease);
      if ((beforeSave.kind !== "valid" && beforeSave.kind !== "absent")
        || requireCurrentProviderState(beforeSave.config).revision !== current.revision) {
        throw new StaleProviderGenerationError();
      }
      const nextConfig = {
        ...beforeSave.config,
        providerSetup: nextState,
      } satisfies OrcodeConfigWithBudget;
      let saveError: unknown;
      try {
        await this.#options.saveConfig(nextConfig, this.#options.configPath);
      } catch (error) {
        saveError = error;
      }
      await this.#assertFence(providerLease);
      await this.#boundary("config-written");
      await this.#assertFence(providerLease);
      const afterSave = await readConfigFacts(this.#options.configPath);
      await this.#assertFence(providerLease);
      if ((afterSave.kind === "valid" || afterSave.kind === "absent")
        && exactCandidateState(afterSave.config.providerSetup, manifest)) {
        // A post-rename error is non-authoritative; exact readback is the fact.
      } else if ((afterSave.kind === "valid" || afterSave.kind === "absent")
        && exactOldState(afterSave.config.providerSetup, manifest)) {
        const cleaned = await this.#cleanupFailedCandidate(
          candidateSlot,
          normalized,
          transaction,
          providerLease,
        );
        transaction = cleaned ? null : transaction;
        if (!cleaned) {
          throw new ProviderActivationRecoveryRequiredError(
            "provider-candidate-cleanup-ambiguous",
          );
        }
        throw new ProviderActivationError(
          "provider-config-persistence-failed",
          "Provider config persistence failed without changing the active route.",
        );
      } else {
        void saveError;
        throw new ProviderActivationRecoveryRequiredError("provider-config-commit-ambiguous");
      }
      await this.#boundary("config-readback");
      manifest.phase = "config-committed";
      await this.#writeJournal(transaction, manifest, providerLease);
      try {
        this.#options.stateStore.replace(nextState, current.revision);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-state-adoption-failed");
      }
      await this.#assertFence(providerLease);
      await assertRuntimeLease(runtimeLease);
      let activated: CandidateProviderState;
      try {
        activated = await this.#activateRuntime(
          revalidatedCandidateId ?? candidate.candidateId,
          selectedModel,
          request.signal,
        );
        assertActivatedRoute(candidateRoute, activated);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-runtime-bind-ambiguous");
      }
      await this.#assertFence(providerLease);
      await this.#boundary("runtime-activated");
      const warnings: string[] = [];
      const oldCleaned = await this.#cleanupPreviousSlot(
        previousSlot,
        nextState,
        transaction,
        providerLease,
      );
      if (!oldCleaned) warnings.push("provider-candidate-cleanup-retained");
      await this.#boundary("old-slot-cleaned");
      if (oldCleaned) {
        await this.#removeJournal(transaction, providerLease);
        transaction = null;
      }
      return {
        persisted: true,
        route: structuredClone(candidateRoute),
        state: structuredClone(nextState),
        warnings: Object.freeze(warnings),
      };
    } catch (error) {
      if (isBoundaryFault(error)) simulatedCrash = true;
      throw error;
    } finally {
      if (initialCandidateId) {
        await this.#options.adapter.discardCandidate(initialCandidateId).catch(() => undefined);
      }
      if (revalidatedCandidateId) {
        await this.#options.adapter.discardCandidate(revalidatedCandidateId).catch(() => undefined);
      }
      if (!simulatedCrash && providerLease) {
        await this.#releaseProviderLease(providerLease).catch(() => undefined);
      }
      if (!simulatedCrash) {
        await Promise.resolve(runtimeLease.release()).catch(() => undefined);
      }
      void transaction;
    }
  }

  async recover(request: ProviderActivationRecoveryRequest): Promise<readonly string[]> {
    throwIfAborted(request.signal);
    let runtimeLease: ProviderActivationRuntimeLease;
    try {
      runtimeLease = await this.#options.runtimeGuard.acquire(request.signal);
    } catch (error) {
      if (isAbort(error, request.signal)) throw abortFrom(request.signal);
      throw new ProviderActivationError(
        "provider-runtime-not-idle",
        "Provider runtime is not idle and drained.",
      );
    }
    let providerLease: HeldProviderLease | null = null;
    try {
      providerLease = await this.#acquireProviderLease(request.signal);
      return await this.#recoverUnderLease(request, providerLease, runtimeLease);
    } finally {
      if (providerLease) {
        await this.#releaseProviderLease(providerLease).catch(() => undefined);
      }
      await Promise.resolve(runtimeLease.release()).catch(() => undefined);
    }
  }

  async #recoverUnderLease(
    request: ProviderActivationRecoveryRequest,
    lease: HeldProviderLease,
    runtimeLease: ProviderActivationRuntimeLease,
  ): Promise<readonly string[]> {
    await this.#assertFence(lease);
    const journals = await this.#readAllJournals();
    await this.#assertFence(lease);
    if (journals.length === 0) return Object.freeze([]);
    if (journals.length !== 1) {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-ambiguous");
    }
    const transaction = journals[0]!;
    const manifest = transaction.manifest;
    const facts = await readConfigFacts(this.#options.configPath);
    await this.#assertFence(lease);
    if (facts.kind !== "valid" && facts.kind !== "absent") {
      throw new ProviderActivationRecoveryRequiredError("provider-config-unreadable");
    }
    const current = requireCurrentProviderState(facts.config);
    let candidateSecret: string | null;
    try {
      candidateSecret = await this.#options.credentials.readSlot(manifest.candidateSlot);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-slot-unreadable");
    }
    await this.#assertFence(lease);

    if (exactOldState(current, manifest)) {
      if (stateReferencesSlot(current, manifest.candidateSlot.id)) {
        throw new ProviderActivationRecoveryRequiredError("provider-recovery-pointer-ambiguous");
      }
      if (candidateSecret !== null) {
        try {
          await this.#options.credentials.deleteSlot(manifest.candidateSlot);
          await this.#assertFence(lease);
          if (await this.#options.credentials.readSlot(manifest.candidateSlot) !== null) {
            throw new Error("candidate-slot-remains");
          }
          await this.#assertFence(lease);
        } catch {
          throw new ProviderActivationRecoveryRequiredError("provider-candidate-cleanup-ambiguous");
        }
      }
      await this.#removeJournal(transaction, lease);
      return Object.freeze([]);
    }

    if (!exactCandidateState(current, manifest)) {
      throw new ProviderActivationRecoveryRequiredError("provider-recovery-pointer-ambiguous");
    }
    if (candidateSecret === null) {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-slot-missing");
    }
    if (!request.inspectCommitted) {
      return Object.freeze(["provider-activation-verification-pending"]);
    }

    await assertRuntimeLease(runtimeLease);
    const candidate = await this.#connectCandidate(
      candidateSecret,
      manifest.expectedRevision + 1,
      request.signal,
    );
    if (candidate.connectionId !== manifest.candidateConnectionId
      || candidate.accountFingerprint !== manifest.candidateRoute.accountFingerprint
      || candidate.billingRealm !== manifest.candidateRoute.billingRealm) {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-identity-mismatch");
    }
    const models = await this.#listModels(candidate.candidateId, request.signal);
    const model = models.find((entry) =>
      entry.backendId === "openrouter"
      && entry.requestedModelId === manifest.candidateRoute.requestedModelId
      && entry.canonicalModelId === manifest.candidateRoute.canonicalModelId
    );
    if (!model) {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-model-mismatch");
    }
    await this.#assertFence(lease);
    try {
      const activated = await this.#activateRuntime(candidate.candidateId, model, request.signal);
      assertActivatedRoute(manifest.candidateRoute, activated);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-runtime-bind-ambiguous");
    } finally {
      await this.#options.adapter.discardCandidate(candidate.candidateId).catch(() => undefined);
    }
    await this.#assertFence(lease);
    if (this.#options.stateStore.read().revision === manifest.expectedRevision) {
      try {
        this.#options.stateStore.replace(current, manifest.expectedRevision);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-state-adoption-failed");
      }
    }
    const oldCleaned = await this.#cleanupPreviousSlot(
      manifest.previousSlot,
      current,
      transaction,
      lease,
    );
    if (!oldCleaned) return Object.freeze(["provider-candidate-cleanup-retained"]);
    await this.#removeJournal(transaction, lease);
    return Object.freeze([]);
  }

  async #connectCandidate(
    secret: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<ProviderCandidate> {
    try {
      const candidate = await this.#options.adapter.connect({
        candidate: secret,
        generation,
        signal,
      });
      if (candidate.backendId !== "openrouter"
        || candidate.billingRealm !== "openrouter-payg"
        || candidate.health.credential !== "valid"
        || candidate.health.connectivity !== "connected"
        || candidate.health.spend === "limit-reached"
        || !candidate.accountFingerprint) {
        throw new Error("candidate-unavailable");
      }
      return candidate;
    } catch (error) {
      if (isAbort(error, signal)) throw abortFrom(signal);
      throw new ProviderActivationError(
        "provider-candidate-validation-failed",
        "Provider candidate validation failed.",
      );
    }
  }

  async #listModels(
    candidateId: string,
    signal: AbortSignal,
  ): Promise<readonly BackendModelDescriptor[]> {
    try {
      return await this.#options.adapter.listModels({ candidateId, signal });
    } catch (error) {
      if (isAbort(error, signal)) throw abortFrom(signal);
      throw new ProviderActivationError(
        "provider-model-list-failed",
        "Provider model selection is unavailable.",
      );
    }
  }

  async #activateRuntime(
    candidateId: string,
    model: BackendModelDescriptor,
    signal: AbortSignal,
  ): Promise<CandidateProviderState> {
    try {
      return await this.#options.adapter.activate({ candidateId, model, signal });
    } catch (error) {
      if (isAbort(error, signal)) throw abortFrom(signal);
      throw new ProviderActivationError(
        "provider-runtime-bind-failed",
        "Provider runtime activation failed.",
      );
    }
  }

  async #boundary(boundary: ProviderActivationBoundary): Promise<void> {
    try {
      await this.#options.onBoundary(boundary);
    } catch (error) {
      if (error instanceof Error) {
        Object.defineProperty(error, BOUNDARY_FAULT, { value: true });
      }
      throw error;
    }
  }

  async #acquireProviderLease(signal: AbortSignal): Promise<HeldProviderLease> {
    const leasePath = join(this.#options.appHome, LEASE_DIRECTORY);
    for (let attempt = 0; attempt < this.#options.leaseAttempts; attempt += 1) {
      throwIfAborted(signal);
      let claim: PrivateDirectoryClaim | null;
      try {
        claim = await this.#options.privateStore.createDirectoryExclusive(leasePath);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-lease-identity-failed");
      }
      if (claim) {
        const acquiredAt = this.#leaseNow();
        const expiresAt = acquiredAt + this.#options.leaseDurationMs;
        if (!Number.isSafeInteger(acquiredAt) || !Number.isSafeInteger(expiresAt)) {
          throw new ProviderActivationRecoveryRequiredError("provider-lease-clock-invalid");
        }
        const owner: LeaseOwnerV1 = {
          version: 1,
          ownerId: createCanonicalUuid(this.#options.createUuid),
          acquiredAt,
          expiresAt,
        };
        const rawOwner = `${JSON.stringify(owner)}\n`;
        try {
          await this.#options.privateStore.writeClaimOwner(claim, rawOwner);
          const readback = await this.#options.privateStore.readClaimOwner(
            claim,
            OWNER_FILE_LIMIT,
          );
          if (readback !== rawOwner) {
            throw new Error("owner-readback-mismatch");
          }
          return { claim, owner, rawOwner };
        } catch {
          throw new ProviderActivationRecoveryRequiredError("provider-lease-owner-failed");
        }
      }

      let adopted: Awaited<ReturnType<PrivateStore["adoptDirectoryClaim"]>>;
      try {
        adopted = await this.#options.privateStore.adoptDirectoryClaim(leasePath);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-lease-adoption-failed");
      }
      let rawOwner: string;
      try {
        rawOwner = await this.#options.privateStore.readClaimOwner(
          adopted.claim,
          OWNER_FILE_LIMIT,
        );
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          if (this.#leaseNow() - adopted.modifiedAtMs >= this.#options.leaseDurationMs) {
            try {
              await this.#options.privateStore.releaseDirectoryClaim(adopted.claim, null);
              continue;
            } catch {
              throw new ProviderActivationRecoveryRequiredError("provider-ownerless-lease-ambiguous");
            }
          }
          await this.#waitForLease(signal);
          continue;
        }
        throw new ProviderActivationRecoveryRequiredError("provider-lease-owner-unreadable");
      }
      const owner = parseLeaseOwner(rawOwner);
      if (!owner) {
        throw new ProviderActivationRecoveryRequiredError("provider-lease-owner-invalid");
      }
      if (this.#leaseNow() >= owner.expiresAt) {
        try {
          await this.#options.privateStore.releaseDirectoryClaim(adopted.claim, rawOwner);
          continue;
        } catch {
          throw new ProviderActivationRecoveryRequiredError("provider-stale-lease-ambiguous");
        }
      }
      await this.#waitForLease(signal);
    }
    throw new ProviderActivationBusyError();
  }

  async #assertFence(lease: HeldProviderLease): Promise<void> {
    try {
      await this.#options.privateStore.assertDirectoryClaim(lease.claim);
      const owner = await this.#options.privateStore.readClaimOwner(
        lease.claim,
        OWNER_FILE_LIMIT,
      );
      await this.#options.privateStore.assertDirectoryClaim(lease.claim);
      if (owner !== lease.rawOwner || this.#leaseNow() >= lease.owner.expiresAt) {
        throw new Error("lease-fence-mismatch");
      }
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-lease-fence-lost");
    }
  }

  async #releaseProviderLease(lease: HeldProviderLease): Promise<void> {
    try {
      await this.#options.privateStore.assertDirectoryClaim(lease.claim);
      const owner = await this.#options.privateStore.readClaimOwner(
        lease.claim,
        OWNER_FILE_LIMIT,
      );
      if (owner !== lease.rawOwner) {
        throw new Error("lease-owner-mismatch");
      }
      await this.#options.privateStore.releaseDirectoryClaim(lease.claim, lease.rawOwner);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-lease-release-ambiguous");
    }
  }

  #leaseNow(): number {
    let value: number;
    try {
      value = this.#options.now();
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-lease-clock-invalid");
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProviderActivationRecoveryRequiredError("provider-lease-clock-invalid");
    }
    return value;
  }

  async #waitForLease(signal: AbortSignal): Promise<void> {
    try {
      await this.#options.waitForLease();
    } catch (error) {
      if (isAbort(error, signal)) throw abortFrom(signal);
      throw new ProviderActivationRecoveryRequiredError("provider-lease-wait-failed");
    }
    throwIfAborted(signal);
  }

  async #createJournal(
    manifest: ProviderActivationJournalV1,
    lease: HeldProviderLease,
  ): Promise<TransactionJournal> {
    const activationRoot = join(this.#options.appHome, ACTIVATION_DIRECTORY);
    const path = join(activationRoot, manifest.transactionId);
    const manifestPath = join(path, "manifest.json");
    try {
      await this.#assertFence(lease);
      await this.#options.privateStore.ensureDirectory(activationRoot);
      await this.#assertFence(lease);
      const transactionClaim = await this.#options.privateStore.createDirectoryExclusive(path);
      await this.#assertFence(lease);
      if (!transactionClaim) {
        throw new ProviderActivationRecoveryRequiredError("provider-transaction-collision");
      }
    } catch (error) {
      if (error instanceof ProviderActivationError) throw error;
      throw new ProviderActivationRecoveryRequiredError("provider-journal-create-failed");
    }
    const transaction = { path, manifestPath, manifest: structuredClone(manifest) };
    await this.#writeJournal(transaction, manifest, lease);
    return transaction;
  }

  async #writeJournal(
    transaction: TransactionJournal,
    manifest: ProviderActivationJournalV1,
    lease: HeldProviderLease,
  ): Promise<void> {
    try {
      validateJournal(manifest, manifest.transactionId);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-invalid");
    }
    const serialized = `${JSON.stringify(manifest)}\n`;
    await this.#assertFence(lease);
    try {
      await this.#options.privateStore.writeTextAtomic(
        transaction.manifestPath,
        serialized,
      );
    } catch {
      // The atomic publish may already have completed; exact readback is authoritative.
    }
    await this.#assertFence(lease);
    let readback: string;
    try {
      readback = await this.#options.privateStore.readText(transaction.manifestPath);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-readback-failed");
    }
    await this.#assertFence(lease);
    const parsed = parseJournal(readback, manifest.transactionId);
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(manifest)) {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-readback-failed");
    }
    transaction.manifest = structuredClone(manifest);
  }

  async #readAllJournals(): Promise<TransactionJournal[]> {
    const root = join(this.#options.appHome, ACTIVATION_DIRECTORY);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw new ProviderActivationRecoveryRequiredError("provider-journal-list-failed");
    }
    const transactions: TransactionJournal[] = [];
    for (const name of names.sort()) {
      if (!CANONICAL_UUID.test(name)) {
        throw new ProviderActivationRecoveryRequiredError("provider-journal-name-invalid");
      }
      const path = join(root, name);
      const manifestPath = join(path, "manifest.json");
      let raw: string;
      try {
        raw = await this.#options.privateStore.readText(manifestPath);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-journal-unreadable");
      }
      if (Buffer.byteLength(raw, "utf8") > MANIFEST_FILE_LIMIT) {
        throw new ProviderActivationRecoveryRequiredError("provider-journal-too-large");
      }
      const manifest = parseJournal(raw, name);
      if (!manifest) {
        throw new ProviderActivationRecoveryRequiredError("provider-journal-invalid");
      }
      transactions.push({ path, manifestPath, manifest });
    }
    return transactions;
  }

  async #cleanupFailedCandidate(
    slot: CredentialSlotRef,
    expectedSecret: string,
    transaction: TransactionJournal,
    lease: HeldProviderLease,
  ): Promise<boolean> {
    try {
      await this.#assertFence(lease);
      const facts = await readConfigFacts(this.#options.configPath);
      await this.#assertFence(lease);
      if ((facts.kind !== "valid" && facts.kind !== "absent")
        || !exactOldState(facts.config.providerSetup, transaction.manifest)) {
        return false;
      }
      const journals = await this.#readAllJournals();
      await this.#assertFence(lease);
      const referencedElsewhere = journals.some((entry) =>
        entry.manifest.transactionId !== transaction.manifest.transactionId
        && (entry.manifest.candidateSlot.id === slot.id
          || entry.manifest.previousSlot?.id === slot.id)
      );
      if (referencedElsewhere) return false;
      const existing = await this.#options.credentials.readSlot(slot);
      await this.#assertFence(lease);
      if (existing !== null && existing !== expectedSecret) return false;
      if (existing === expectedSecret) {
        await this.#options.credentials.deleteSlot(slot);
        await this.#assertFence(lease);
        if (await this.#options.credentials.readSlot(slot) !== null) return false;
      }
      await this.#removeJournal(transaction, lease);
      return true;
    } catch {
      return false;
    }
  }

  async #cleanupPreviousSlot(
    previous: ProviderActivationJournalV1["previousSlot"],
    activeState: ProviderSetupStateV1,
    transaction: TransactionJournal,
    lease: HeldProviderLease,
  ): Promise<boolean> {
    if (!previous || previous.version === 0) return true;
    try {
      await this.#assertFence(lease);
      const facts = await readConfigFacts(this.#options.configPath);
      await this.#assertFence(lease);
      if ((facts.kind !== "valid" && facts.kind !== "absent")
        || !exactCandidateState(facts.config.providerSetup, transaction.manifest)
        || stateReferencesSlot(activeState, previous.id)
        || stateReferencesSlot(
          requireCurrentProviderState(facts.config),
          previous.id,
        )) {
        return false;
      }
      const journals = await this.#readAllJournals();
      await this.#assertFence(lease);
      const referencedElsewhere = journals.some((entry) =>
        entry.manifest.transactionId !== transaction.manifest.transactionId
        && (entry.manifest.candidateSlot.id === previous.id
          || entry.manifest.previousSlot?.id === previous.id)
      );
      if (referencedElsewhere) return false;
      await this.#options.credentials.deleteSlot(previous);
      await this.#assertFence(lease);
      if (await this.#options.credentials.readSlot(previous) !== null) return false;
      void transaction;
      return true;
    } catch {
      return false;
    }
  }

  async #removeJournal(
    transaction: TransactionJournal,
    lease: HeldProviderLease,
  ): Promise<void> {
    await this.#assertFence(lease);
    try {
      await this.#options.privateStore.removeTree(transaction.path);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-cleanup-failed");
    }
    await this.#assertFence(lease);
  }
}

export async function recoverProviderActivation(
  options: ProviderActivationCoordinatorOptions,
  request: ProviderActivationRecoveryRequest,
): Promise<readonly string[]> {
  return new ProviderActivationCoordinator(options).recover(request);
}

function buildNextState(
  current: ProviderSetupStateV1,
  candidate: ProviderCandidate,
  candidateSlot: CredentialSlotRef,
  route: RouteIdentityV1,
): ProviderSetupStateV1 {
  if (!candidate.accountFingerprint) {
    throw new ProviderActivationError(
      "provider-candidate-identity-missing",
      "Provider candidate identity is unavailable.",
    );
  }
  const connection = {
    id: candidate.connectionId,
    backendId: "openrouter" as const,
    enabled: true,
    maturity: "stable" as const,
    credentialSlot: candidateSlot.id,
    accountFingerprint: candidate.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: "openrouter-payg" as const,
    lastHealth: structuredClone(candidate.health),
  };
  const connections = current.connections
    .filter((entry) => entry.id !== candidate.connectionId)
    .concat(connection);
  const next: ProviderSetupStateV1 = {
    ...structuredClone(current),
    revision: current.revision + 1,
    lifecycle: "configured",
    connections,
    defaultRoute: structuredClone(route),
    cross: {
      enabled: false,
      preferredLead: current.cross.preferredLead,
      preferredChallenger: current.cross.preferredChallenger,
    },
  };
  const validated = validateProviderSetupState(next);
  if (isProviderStateIssue(validated)) {
    throw new ProviderActivationError(
      "provider-candidate-state-invalid",
      "Provider candidate state is invalid.",
    );
  }
  return validated;
}

function previousSlotFromState(
  state: ProviderSetupStateV1,
  connectionId: string,
): ProviderActivationJournalV1["previousSlot"] {
  const value = state.connections.find((connection) => connection.id === connectionId)
    ?.credentialSlot;
  if (!value) return null;
  if (value === "legacy:inference") {
    return { version: 0, kind: "inference", id: "legacy:inference" };
  }
  const parsed = parseCredentialSlot({ version: 1, kind: "inference", id: value });
  return parsed;
}

function routeForCandidate(
  candidate: ProviderCandidate,
  model: BackendModelDescriptor,
): RouteIdentityV1 {
  if (!candidate.accountFingerprint) {
    throw new ProviderActivationError(
      "provider-candidate-identity-missing",
      "Provider candidate identity is unavailable.",
    );
  }
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: candidate.accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved",
  };
}

function selectExplicitModel(
  models: readonly BackendModelDescriptor[],
  canonicalModelId: string,
): BackendModelDescriptor {
  const selected = models.find((model) =>
    model.backendId === "openrouter"
    && model.canonicalModelId === canonicalModelId
    && model.capabilities.textInput
    && model.capabilities.textOutput
    && model.capabilities.tools
  );
  if (!selected) {
    throw new ProviderActivationError(
      "provider-model-selection-invalid",
      "Provider model selection is invalid.",
    );
  }
  return selected;
}

function assertSameCandidate(
  initial: ProviderCandidate,
  revalidated: ProviderCandidate,
): void {
  if (initial.backendId !== revalidated.backendId
    || initial.connectionId !== revalidated.connectionId
    || initial.accountFingerprint !== revalidated.accountFingerprint
    || initial.billingRealm !== revalidated.billingRealm
    || revalidated.health.credential !== "valid"
    || revalidated.health.connectivity !== "connected"
    || revalidated.health.spend === "limit-reached") {
    throw new ProviderActivationRecoveryRequiredError("provider-candidate-revalidation-mismatch");
  }
}

function assertActivatedRoute(
  expected: RouteIdentityV1,
  activated: CandidateProviderState,
): void {
  if (!exactRoute(activated.route, expected)
    || activated.connectionId.length === 0
    || activated.accountFingerprint !== expected.accountFingerprint
    || activated.billingRealm !== expected.billingRealm) {
    throw new ProviderActivationRecoveryRequiredError("provider-runtime-route-mismatch");
  }
}

function exactCandidateState(
  state: unknown,
  manifest: ProviderActivationJournalV1,
): state is ProviderSetupStateV1 {
  const validated = validateProviderSetupState(state);
  if (isProviderStateIssue(validated)
    || validated.revision !== manifest.expectedRevision + 1
    || !exactRoute(validated.defaultRoute, manifest.candidateRoute)) {
    return false;
  }
  const connection = validated.connections.find((entry) =>
    entry.id === manifest.candidateConnectionId
  );
  return connection?.backendId === "openrouter"
    && connection.enabled
    && connection.maturity === "stable"
    && connection.credentialSlot === manifest.candidateSlot.id
    && connection.accountFingerprint === manifest.candidateRoute.accountFingerprint
    && connection.accountFingerprintState === "verified"
    && connection.billingRealm === manifest.candidateRoute.billingRealm;
}

function exactOldState(
  state: unknown,
  manifest: ProviderActivationJournalV1,
): state is ProviderSetupStateV1 {
  const validated = validateProviderSetupState(state);
  if (isProviderStateIssue(validated)
    || validated.revision !== manifest.expectedRevision
    || stateReferencesSlot(validated, manifest.candidateSlot.id)) {
    return false;
  }
  const previousId = manifest.previousSlot?.id ?? null;
  const previousConnection = validated.connections.find((entry) =>
    entry.id === manifest.candidateConnectionId
  );
  return previousId === null
    ? previousConnection === undefined
    : previousConnection?.credentialSlot === previousId;
}

function exactRoute(
  left: RouteIdentityV1 | null,
  right: RouteIdentityV1,
): boolean {
  return left !== null
    && left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function stateReferencesSlot(state: ProviderSetupStateV1, slotId: string): boolean {
  return state.connections.some((connection) => connection.credentialSlot === slotId);
}

function requireCurrentProviderState(config: OrcodeConfigWithBudget): ProviderSetupStateV1 {
  const state = validateProviderSetupState(config.providerSetup);
  if (isProviderStateIssue(state)) {
    throw new ProviderActivationRecoveryRequiredError("provider-state-invalid");
  }
  return state;
}

async function readConfigFacts(path: string): Promise<ConfigFacts> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return {
        kind: "absent",
        config: structuredClone(DEFAULT_CONFIG),
      };
    }
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(parsed)) return { kind: "corrupt" };
  if (typeof parsed.schemaVersion === "number"
    && parsed.schemaVersion > CONFIG_SCHEMA_VERSION) {
    return { kind: "future" };
  }
  if (!("providerSetup" in parsed)) return { kind: "corrupt" };
  const providerState = validateProviderSetupState(parsed.providerSetup);
  if (isProviderStateIssue(providerState)) {
    return { kind: providerState.kind === "future-version" ? "future" : "corrupt" };
  }
  try {
    return {
      kind: "valid",
      config: validateConfig({
        ...DEFAULT_CONFIG,
        ...(parsed as unknown as ConfigInput),
        providerSetup: providerState,
      }),
    };
  } catch {
    return { kind: "corrupt" };
  }
}

function parseJournal(raw: string, transactionId: string): ProviderActivationJournalV1 | null {
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_FILE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    validateJournal(parsed, transactionId);
    return structuredClone(parsed as ProviderActivationJournalV1);
  } catch {
    return null;
  }
}

function validateJournal(value: unknown, transactionId: string): asserts value is ProviderActivationJournalV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "version",
      "transactionId",
      "expectedRevision",
      "phase",
      "backendId",
      "candidateSlot",
      "previousSlot",
      "candidateConnectionId",
      "candidateRoute",
    ])
    || value.version !== 1
    || value.transactionId !== transactionId
    || !CANONICAL_UUID.test(transactionId)
    || !Number.isSafeInteger(value.expectedRevision)
    || Number(value.expectedRevision) < 0
    || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER
    || (value.phase !== "prepared"
      && value.phase !== "credential-staged"
      && value.phase !== "config-committed")
    || value.backendId !== "openrouter"
    || !isInferenceSlot(value.candidateSlot)
    || !validPreviousSlot(value.previousSlot)
    || typeof value.candidateConnectionId !== "string"
    || value.candidateConnectionId.length === 0
    || validateRouteIdentityV1(value.candidateRoute) === null
    || (value.candidateRoute as RouteIdentityV1).backendId !== "openrouter"
    || (value.candidateRoute as RouteIdentityV1).billingRealm !== "openrouter-payg"
    || (value.candidateRoute as RouteIdentityV1).resolutionState !== "resolved") {
    throw new Error("invalid-provider-activation-journal");
  }
}

function parseCredentialSlot(value: unknown): CredentialSlotRef | null {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "kind", "id"])
    || value.version !== 1
    || (value.kind !== "inference" && value.kind !== "management")
    || typeof value.id !== "string") {
    return null;
  }
  const prefix = `v1:${value.kind}:`;
  if (!value.id.startsWith(prefix) || !CANONICAL_UUID.test(value.id.slice(prefix.length))) {
    return null;
  }
  return {
    version: 1,
    kind: value.kind,
    id: value.id,
  };
}

function validPreviousSlot(value: unknown): boolean {
  return value === null
    || isInferenceSlot(value)
    || (isRecord(value)
      && exactKeys(value, ["version", "kind", "id"])
      && value.version === 0
      && value.kind === "inference"
      && value.id === "legacy:inference");
}

function isInferenceSlot(value: unknown): boolean {
  return parseCredentialSlot(value)?.kind === "inference";
}

function parseLeaseOwner(raw: string): LeaseOwnerV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, ["version", "ownerId", "acquiredAt", "expiresAt"])
    || parsed.version !== 1
    || typeof parsed.ownerId !== "string"
    || !CANONICAL_UUID.test(parsed.ownerId)
    || !Number.isSafeInteger(parsed.acquiredAt)
    || !Number.isSafeInteger(parsed.expiresAt)
    || Number(parsed.acquiredAt) < 0
    || Number(parsed.expiresAt) <= Number(parsed.acquiredAt)) {
    return null;
  }
  return parsed as unknown as LeaseOwnerV1;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function createCanonicalUuid(createUuid: () => string): string {
  let value: string;
  try {
    value = createUuid();
  } catch {
    throw new ProviderActivationError(
      "provider-uuid-invalid",
      "Provider activation identifier generation failed.",
    );
  }
  if (!CANONICAL_UUID.test(value)) {
    throw new ProviderActivationError(
      "provider-uuid-invalid",
      "Provider activation identifier generation failed.",
    );
  }
  return value;
}

async function assertRuntimeLease(lease: ProviderActivationRuntimeLease): Promise<void> {
  try {
    await lease.assertHeld();
  } catch {
    throw new ProviderActivationError(
      "provider-runtime-guard-lost",
      "Provider runtime guard was lost before activation completed.",
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortFrom(signal);
}

function abortFrom(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

const BOUNDARY_FAULT: unique symbol = Symbol("provider-activation-boundary-fault");

function isBoundaryFault(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { [BOUNDARY_FAULT]?: unknown })[BOUNDARY_FAULT] === true;
}
