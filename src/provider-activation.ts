import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  BackendAdapter,
  BackendId,
  BackendModelDescriptor,
  CandidateProviderState,
  ProviderCandidate,
  RouteIdentityV1,
} from "./backends.js";
import {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
  assertConfigFileSnapshot,
  isAtomicFilePostPublicationError,
  readConfigFileSnapshot,
  saveConfig as saveConfigDefault,
  withConfigWriteLock,
  writeFileAtomicCreateSecure,
  writeFileAtomicSecure,
  type ConfigFileSnapshot,
} from "./config.js";
import {
  normalizeProviderSecret,
  type CredentialSlotKind,
  type CredentialSlotRef,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import type {
  ProviderCandidateCredentialPermit,
  ProviderCredentialAuthorityLike,
  ProviderCredentialPolicy,
} from "./provider-authority.js";
import { providerCredentialPolicy } from "./provider-authority.js";
import {
  PrivateStore,
  type PrivateDirectoryClaim,
} from "./private-store.js";
import {
  ProviderStateStore,
  isProviderStateIssue,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderSetupStateV2,
} from "./provider-state.js";
import { isRecord } from "./utils.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVATION_DIRECTORY = "provider-activation";
const LEASE_DIRECTORY = "provider-setup.lock";
export const PROVIDER_CREDENTIAL_FORGET_DIRECTORY = "provider-forget-v1";
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
  expectedProviderSetupSha256: string;
  candidateProviderSetupSha256: string;
}

export interface ProviderActivationJournalV2 {
  version: 2;
  transactionId: string;
  expectedRevision: number;
  phase: "prepared" | "credential-staged" | "config-committed";
  backendId: "openrouter" | "kimi-code";
  credentialSlotKind: CredentialSlotKind;
  candidateSlot: CredentialSlotRef;
  previousSlot: CredentialSlotRef | { version: 0; kind: "inference"; id: "legacy:inference" } | null;
  candidateConnectionId: string;
  candidateRoute: RouteIdentityV1;
  expectedProviderSetupSha256: string;
  candidateProviderSetupSha256: string;
}

type ProviderActivationJournal = ProviderActivationJournalV1 | ProviderActivationJournalV2;

export interface ProviderActivationResult {
  persisted: boolean;
  route: RouteIdentityV1;
  state: ProviderSetupStateV2 | null;
  warnings: readonly string[];
}

export interface ProviderActivationRuntimeLease {
  assertHeld(): void | Promise<void>;
  assertHeldSynchronously?(): void;
  release(): void | Promise<void>;
}

export interface ProviderActivationRuntimeGuard {
  acquire(signal: AbortSignal): Promise<ProviderActivationRuntimeLease>;
}

export interface ProviderActivationRequest {
  backendId: "openrouter" | "kimi-code";
  expectedRevision: number;
  candidate: string;
  expectedRequestedModelId: string;
  selectedCanonicalModelId: string;
  generation: number;
  signal: AbortSignal;
  deadlineAt: number;
  persistence: "persisted" | "process-only";
  candidatePermit?: ProviderCandidateCredentialPermit | null;
  requireCandidatePermit?: boolean;
  targetConnectionId?: string;
  onPersistenceFailure?: () => Promise<"process-only" | "decline">;
}

export interface ProviderActivationRecoveryRequest {
  signal: AbortSignal;
  inspectCommitted?: boolean;
}

export interface ProviderCoordinatorLease {
  assertHeld(): Promise<void>;
}

export interface ProviderAuthorityReadLease {
  assertHeld(): Promise<void>;
}

interface ActivationAdapter {
  readonly backendId: BackendId;
  connect(request: {
    connectionId?: string;
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
  /** Resolves the exact backend at every operation boundary. */
  adapterResolver: (backendId: "openrouter" | "kimi-code") => ActivationAdapter | BackendAdapter;
  stateStore: ProviderStateStore;
  runtimeGuard: ProviderActivationRuntimeGuard;
  candidateAuthority?: Pick<
    ProviderCredentialAuthorityLike,
    | "validateCandidatePermitUnderLease"
    | "validateCandidatePermitAgainstSnapshotUnderLease"
  >;
  now?: () => number;
  createUuid?: () => string;
  leaseDurationMs?: number;
  leaseAttempts?: number;
  waitForLease?: () => Promise<void>;
  writeConfigAtomic?: (
    path: string,
    content: string,
    beforePublish?: () => Promise<void>,
    beforeRename?: () => void,
  ) => Promise<void>;
  writeConfigAtomicCreate?: (
    path: string,
    content: string,
    beforePublish?: () => Promise<void>,
    beforeLink?: () => void,
  ) => Promise<void>;
  /** @deprecated Transactional activation uses writeConfigAtomic for byte preservation. */
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
  claim: PrivateDirectoryClaim;
  rawManifest: string;
  manifest: ProviderActivationJournal;
}

type ConfigFacts =
  | {
    kind: "valid" | "absent";
    prefix: string;
    suffix: string;
    state: ProviderSetupStateV2;
    digest: string;
    target: ConfigFileSnapshot;
  }
  | { kind: "corrupt" | "future" | "unreadable" };

type RecoveryDisposition =
  | { kind: "complete"; warnings: readonly string[] }
  | { kind: "verification-pending"; warnings: readonly string[] }
  | { kind: "recovery-required"; error: ProviderActivationRecoveryRequiredError };

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
  readonly #adapterResolver: (backendId: "openrouter" | "kimi-code") => ActivationAdapter | BackendAdapter;
  readonly #options: Required<Pick<
    ProviderActivationCoordinatorOptions,
    "now" | "createUuid" | "leaseDurationMs" | "leaseAttempts" | "waitForLease" | "writeConfigAtomic" | "writeConfigAtomicCreate" | "onBoundary"
  >> & Omit<ProviderActivationCoordinatorOptions,
    "now" | "createUuid" | "leaseDurationMs" | "leaseAttempts" | "waitForLease" | "saveConfig" | "writeConfigAtomic" | "writeConfigAtomicCreate" | "onBoundary">;

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
      writeConfigAtomic: options.writeConfigAtomic ?? writeFileAtomicSecure,
      writeConfigAtomicCreate: options.writeConfigAtomicCreate ?? writeFileAtomicCreateSecure,
      onBoundary: options.onBoundary ?? (() => undefined),
    };
    this.#adapterResolver = options.adapterResolver;
  }

  async activate(request: ProviderActivationRequest): Promise<ProviderActivationResult> {
    const deadline = this.#activationDeadline(request);
    request = { ...request, signal: deadline.signal };
    this.#assertActivationAttemptCurrent(request);
    // Candidate IDs belong to one adapter instance. Pin a verified resolver
    // result before any activation lease, credential, or config mutation.
    let adapter: ActivationAdapter | BackendAdapter;
    try {
      adapter = this.#adapterFor(request.backendId);
    } catch (error) {
      deadline.dispose();
      throw error;
    }
    let runtimeLease: ProviderActivationRuntimeLease;
    try {
      runtimeLease = await this.#awaitRuntimeLease(request);
    } catch (error) {
      deadline.dispose();
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
    let primaryFailed = false;
    try {
      await assertRuntimeLease(runtimeLease);
      providerLease = await this.#acquireProviderLease(request.signal);
      await this.#assertFence(providerLease);
      const recovery = await this.#recoverDisposition({
        signal: request.signal,
        inspectCommitted: false,
      }, providerLease, runtimeLease);
      if (recovery.kind !== "complete") {
        throw recovery.kind === "recovery-required"
          ? recovery.error
          : new ProviderActivationRecoveryRequiredError();
      }
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
      const preflight = await this.#awaitActivation(
        request,
        () => readConfigFacts(this.#options.configPath),
      );
      if (preflight.kind !== "valid" && preflight.kind !== "absent") {
        throw new ProviderActivationRecoveryRequiredError("provider-config-unreadable");
      }
      if (
        preflight.state.revision !== request.expectedRevision
        || this.#options.stateStore.read().revision !== request.expectedRevision
      ) {
        throw new StaleProviderGenerationError();
      }
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
      await this.#validateCandidatePermit(request, providerLease, runtimeLease);
      const normalized = normalizeProviderSecret(request.candidate);
      const policy = requireActivationPolicy(request.backendId);
      const candidate = await this.#connectCandidate(
        normalized,
        request.generation,
        request.signal,
        request.targetConnectionId,
        adapter,
      );
      if (candidate.backendId !== request.backendId || candidate.billingRealm !== policy.billingRealm) {
        throw new ProviderActivationError("provider-candidate-backend-mismatch", "Provider candidate backend is invalid.");
      }
      initialCandidateId = candidate.candidateId;
      await this.#awaitActivation(request, () => this.#boundary("candidate-validated"));
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
      assertNoRetainedIdentityCollision(preflight.state, candidate);
      const models = await this.#listModels(candidate.candidateId, request.signal, adapter);
      await this.#awaitActivation(request, () => this.#boundary("models-loaded"));
      const selectedModel = selectExplicitModel(
        models,
        request.expectedRequestedModelId,
        request.selectedCanonicalModelId,
        request.backendId,
      );
      const candidateRoute = routeForCandidate(candidate, selectedModel);
      await this.#awaitActivation(request, () => this.#boundary("model-selected"));

      if (request.persistence === "process-only") {
        await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
        await this.#validateCandidatePermit(request, providerLease, runtimeLease);
        const activated = await this.#activateRuntime(
          candidate.candidateId,
          selectedModel,
          request.signal,
          adapter,
        );
        await assertRuntimeLease(runtimeLease);
        await this.#assertFence(providerLease);
        assertActivatedRoute(candidateRoute, activated);
        // Runtime activation may already have published process state. Preserve
        // the exact completion path if caller cancellation arrives after it.
        await this.#boundary("runtime-activated");
        return {
          persisted: false,
          route: structuredClone(candidateRoute),
          state: null,
          warnings: Object.freeze([]),
        };
      }

      await this.#assertFence(providerLease);
      await assertRuntimeLease(runtimeLease);
      const configFacts = await this.#awaitActivation(
        request,
        () => readConfigFacts(this.#options.configPath),
      );
      if (configFacts.kind !== "valid" && configFacts.kind !== "absent") {
        throw new ProviderActivationRecoveryRequiredError("provider-config-unreadable");
      }
      const current = configFacts.state;
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
      assertNoRetainedIdentityCollision(current, candidate);
      await this.#validateCandidatePermit(request, providerLease, runtimeLease);
      let candidateSlot: CredentialSlotRef;
      try {
        candidateSlot = this.#options.credentials.reserveSlot(policy.savedSlotKinds[0]!);
      } catch {
        throw new ProviderActivationError(
          "provider-credential-reservation-failed",
          "Provider credential reservation failed.",
        );
      }
      if (!Object.isFrozen(candidateSlot) || candidateSlot.kind !== policy.savedSlotKinds[0]) {
        throw new ProviderActivationError(
          "provider-credential-reservation-invalid",
          "Provider credential reservation is invalid.",
        );
      }
      const previousSlot = previousSlotFromState(current, candidate.connectionId);
      const nextState = buildNextState(
        current,
        candidate,
        candidateSlot,
        candidateRoute,
      );
      const transactionId = createCanonicalUuid(this.#options.createUuid);
      const manifest: ProviderActivationJournalV2 = {
        version: 2,
        transactionId,
        expectedRevision: current.revision,
        phase: "prepared",
        backendId: request.backendId,
        credentialSlotKind: policy.savedSlotKinds[0]!,
        candidateSlot,
        previousSlot,
        candidateConnectionId: candidate.connectionId,
        candidateRoute,
        expectedProviderSetupSha256: configFacts.digest,
        candidateProviderSetupSha256: providerSetupDigest(nextState),
      };
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
      transaction = await this.#createJournal(manifest, providerLease);
      await this.#awaitActivation(request, () => this.#boundary("journal-written"));

      try {
        await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
        // Slot writes are irreversible until the journal proves cleanup. Do
        // not race this promise with deadline/abort; retain ownership and the
        // journal through its actual settlement.
        await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
        await this.#options.credentials.writeSlot(candidateSlot, normalized);
        await this.#assertFence(providerLease);
        await this.#awaitActivation(request, () => this.#boundary("slot-written"));
        await this.#assertFence(providerLease);
        const readback = await this.#awaitActivation(
          request,
          () => this.#options.credentials.readSlot(candidateSlot),
        );
        await this.#assertFence(providerLease);
        if (readback !== normalized) {
          throw new ProviderActivationRecoveryRequiredError("provider-candidate-readback-mismatch");
        }
        await this.#awaitActivation(request, () => this.#boundary("slot-readback"));
        await this.#assertFence(providerLease);
        const revalidated = await this.#connectCandidate(
          readback,
          request.generation,
          request.signal,
          candidate.connectionId,
          adapter,
        );
        revalidatedCandidateId = revalidated.candidateId;
        assertSameCandidate(candidate, revalidated);
        await this.#assertFence(providerLease);
        await this.#awaitActivation(request, () => this.#boundary("candidate-revalidated"));
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
        if (error instanceof StaleProviderGenerationError) throw error;
        if (decision !== "process-only") {
          throw new ProviderActivationError(
            "provider-credential-persistence-failed",
            "Provider credential persistence failed without changing the active route.",
          );
        }
        await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
        await this.#validateCandidatePermit(request, providerLease, runtimeLease);
        const activated = await this.#activateRuntime(
          candidate.candidateId,
          selectedModel,
          request.signal,
          adapter,
        );
        await assertRuntimeLease(runtimeLease);
        await this.#assertFence(providerLease);
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
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, request.signal);
      await this.#writeJournal(transaction, manifest, providerLease);
      await this.#assertFence(providerLease);
      let publication: "candidate" | "old" | "ambiguous";
      const configCommit = this.#configCommitSignal(request.signal);
      try {
        publication = await withConfigWriteLock(
          this.#options.configPath,
          async (ownership): Promise<"candidate" | "old" | "ambiguous"> => {
            await ownership.assertHeld();
            await this.#assertFence(providerLease!);
            await assertRuntimeLease(runtimeLease);
            await ownership.assertHeld();
            const beforeSave = await readConfigFacts(ownership.canonicalPath);
            await ownership.assertHeld();
            await this.#assertFence(providerLease!);
            await ownership.assertHeld();
            if ((beforeSave.kind !== "valid" && beforeSave.kind !== "absent")
              || beforeSave.digest !== manifest.expectedProviderSetupSha256) {
              throw new ProviderActivationRecoveryRequiredError(
                "provider-config-cas-mismatch",
              );
            }
            const nextRaw = `${beforeSave.prefix}${JSON.stringify(nextState)}${beforeSave.suffix}`;
            await assertRuntimeLease(runtimeLease);
            await ownership.assertHeld();
            let writeDisposition: "succeeded" | "pre-publication-failed" | "post-publication-failed"
              = "succeeded";
            try {
              await this.#assertMutationAllowed(
                providerLease!,
                runtimeLease,
                true,
                request.signal,
              );
              const writeConfigAtomic = beforeSave.kind === "absent"
                ? this.#options.writeConfigAtomicCreate
                : this.#options.writeConfigAtomic;
              // From this point an abort can coincide with an atomic rename.
              // The writer's pre-publication callback still rejects it before
              // mutation; after that, readback under retained ownership must
              // classify the durable outcome instead of abandoning it.
              configCommit.detach();
              await writeConfigAtomic(
                ownership.canonicalPath,
                nextRaw,
                async () => {
                  throwIfAborted(request.signal);
                  await ownership.assertHeld();
                  await this.#assertFence(providerLease!);
                  await assertRuntimeLease(runtimeLease);
                  await this.#validateCandidatePermitAgainstSnapshot(
                    request,
                    beforeSave.state,
                    providerLease!,
                    runtimeLease,
                  );
                  await assertConfigFileSnapshot(
                    ownership.canonicalPath,
                    beforeSave.target,
                  );
                  await ownership.assertHeld();
                  throwIfAborted(request.signal);
                },
                () => {
                  this.#assertActivationAttemptCurrent(request);
                  this.#assertSynchronousProviderFence(providerLease!);
                  assertRuntimeLeaseSynchronously(runtimeLease);
                  this.#assertActivationAttemptCurrent(request);
                },
              );
              await this.#observeCriticalConfigWritten(request.signal);
            } catch (error) {
              if (isBoundaryFault(error)) throw error;
              writeDisposition = isAtomicFilePostPublicationError(error)
                ? "post-publication-failed"
                : "pre-publication-failed";
              // The non-forgeable phase proof and exact readback are both
              // required while config/provider/runtime ownership is held.
            }
            await assertRuntimeLease(runtimeLease);
            await ownership.assertHeld();
            await this.#assertFence(providerLease!);
            await assertRuntimeLease(runtimeLease);
            await ownership.assertHeld();
            // Read the durable file while we still own all fences. The
            // critical config-written observer above has either faulted
            // immediately or been detached as a non-production observer.
            const afterSave = await readConfigFacts(ownership.canonicalPath);
            await ownership.assertHeld();
            await this.#assertFence(providerLease!);
            await ownership.assertHeld();
            if ((afterSave.kind === "valid" || afterSave.kind === "absent")
              && exactCandidateState(afterSave, manifest)
              && writeDisposition !== "pre-publication-failed"
              && afterSave.prefix === beforeSave.prefix
              && afterSave.suffix === beforeSave.suffix) {
              return "candidate";
            }
            if ((afterSave.kind === "valid" || afterSave.kind === "absent")
              && writeDisposition === "pre-publication-failed"
              && exactOldState(afterSave, manifest)) {
              return "old";
            }
            return "ambiguous";
          },
          { signal: configCommit.signal },
        );
      } catch (error) {
        if (isBoundaryFault(error)
          || isAbort(error, request.signal)
          || error instanceof ProviderActivationError) {
          throw error;
        }
        throw new ProviderActivationRecoveryRequiredError(
          "provider-config-writer-ownership-failed",
        );
      } finally {
        configCommit.dispose();
      }
      if (publication === "old") {
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
      }
      if (publication === "ambiguous") {
        throw new ProviderActivationRecoveryRequiredError("provider-config-commit-ambiguous");
      }
      // The exact candidate config is now durable. Caller cancellation is too
      // late to roll it back, so retain Runtime -> Provider ownership and
      // finish adopting that exact tuple instead of exposing a detached half
      // commit. Provider/runtime ownership failures still fail closed below.
      const committedSignal = new AbortController().signal;
      const committedRequest: ProviderActivationRequest = {
        ...request,
        signal: committedSignal,
        deadlineAt: Number.MAX_SAFE_INTEGER,
      };
      // Config readback remains a recovery checkpoint while all ownership is
      // held. It runs on the committed signal because the durable tuple must
      // be reconciled even after the original caller cancels.
      await this.#awaitActivation(committedRequest, () => this.#boundary("config-readback"));
      manifest.phase = "config-committed";
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, committedSignal);
      await this.#writeJournal(transaction, manifest, providerLease);
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, committedSignal);
      try {
        this.#options.stateStore.replace(nextState, current.revision);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-state-adoption-failed");
      }
      await this.#assertMutationAllowed(providerLease, runtimeLease, true, committedSignal);
      let activated: CandidateProviderState;
      try {
        activated = await this.#activateRuntime(
          revalidatedCandidateId ?? candidate.candidateId,
          selectedModel,
          committedSignal,
          adapter,
        );
        await assertRuntimeLease(runtimeLease);
        await this.#assertFence(providerLease);
        assertActivatedRoute(candidateRoute, activated);
      } catch (error) {
        if (error instanceof ProviderActivationRecoveryRequiredError) throw error;
        throw new ProviderActivationRecoveryRequiredError("provider-runtime-bind-ambiguous");
      }
      await this.#awaitActivation(committedRequest, () => this.#boundary("runtime-activated"));
      const warnings: string[] = [];
      const oldCleaned = await this.#cleanupPreviousSlot(
        previousSlot,
        nextState,
        transaction,
        providerLease,
      );
      if (!oldCleaned) warnings.push("provider-candidate-cleanup-retained");
      await this.#awaitActivation(committedRequest, () => this.#boundary("old-slot-cleaned"));
      if (oldCleaned) {
        await this.#assertMutationAllowed(providerLease, runtimeLease, true, committedSignal);
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
      primaryFailed = true;
      if (isBoundaryFault(error)) simulatedCrash = true;
      throw error;
    } finally {
      if (initialCandidateId) {
        const candidateId = initialCandidateId;
        await Promise.resolve().then(() => adapter.discardCandidate(candidateId)).catch(() => undefined);
      }
      if (revalidatedCandidateId) {
        const candidateId = revalidatedCandidateId;
        await Promise.resolve().then(() => adapter.discardCandidate(candidateId)).catch(() => undefined);
      }
      if (!simulatedCrash) {
        let releaseFailed = false;
        if (providerLease) {
          try {
            await this.#releaseProviderLease(providerLease);
          } catch {
            releaseFailed = true;
          }
        }
        try {
          await Promise.resolve(runtimeLease.release());
        } catch {
          releaseFailed = true;
        }
        if (releaseFailed && !primaryFailed) {
          throw new ProviderActivationRecoveryRequiredError(
            "provider-activation-release-failed",
          );
        }
      }
      void transaction;
      deadline.dispose();
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
    let primaryFailed = false;
    try {
      providerLease = await this.#acquireProviderLease(request.signal);
      const disposition = await this.#recoverDisposition(
        request,
        providerLease,
        runtimeLease,
      );
      if (disposition.kind === "recovery-required") throw disposition.error;
      return disposition.warnings;
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      let releaseFailed = false;
      if (providerLease) {
        try {
          await this.#releaseProviderLease(providerLease);
        } catch {
          releaseFailed = true;
        }
      }
      try {
        await Promise.resolve(runtimeLease.release());
      } catch {
        releaseFailed = true;
      }
      if (releaseFailed && !primaryFailed) {
        throw new ProviderActivationRecoveryRequiredError(
          "provider-activation-release-failed",
        );
      }
    }
  }

  async runExclusive<T>(
    request: ProviderActivationRecoveryRequest,
    operation: (lease: ProviderCoordinatorLease) => Promise<T>,
  ): Promise<T> {
    const result = await this.#recoverAndRun(request, true, operation);
    return result.value;
  }

  async recoverAndRun<T>(
    request: ProviderActivationRecoveryRequest,
    operation: (lease: ProviderCoordinatorLease) => Promise<T>,
  ): Promise<{ warnings: readonly string[]; value: T }> {
    return this.#recoverAndRun(request, false, operation);
  }

  /**
   * Provider-only read fence. It deliberately does not acquire the runtime
   * guard, so parallel read inspections cannot invert runtime -> provider
   * mutation ordering.
   */
  async readAuthority<T>(
    request: { signal: AbortSignal },
    operation: (lease: ProviderAuthorityReadLease) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(request.signal);
    let providerLease: HeldProviderLease | null = null;
    let primaryFailed = false;
    try {
      providerLease = await this.#acquireProviderLease(request.signal);
      const assertHeld = async () => {
        throwIfAborted(request.signal);
        await this.#assertFence(providerLease!);
        throwIfAborted(request.signal);
        await this.#assertNoPendingCredentialForget(providerLease!);
        throwIfAborted(request.signal);
        await this.#assertFence(providerLease!);
        if ((await this.#readAllJournals()).length !== 0) {
          throw new ProviderActivationRecoveryRequiredError(
            "provider-activation-journal-pending",
          );
        }
        await this.#assertFence(providerLease!);
        throwIfAborted(request.signal);
      };
      const lease: ProviderAuthorityReadLease = { assertHeld };
      await lease.assertHeld();
      const value = await operation(lease);
      throwIfAborted(request.signal);
      await lease.assertHeld();
      return value;
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      if (providerLease) {
        try {
          await this.#releaseProviderLease(providerLease);
        } catch {
          if (!primaryFailed) {
            throw new ProviderActivationRecoveryRequiredError(
              "provider-authority-release-failed",
            );
          }
        }
      }
    }
  }

  async #recoverAndRun<T>(
    request: ProviderActivationRecoveryRequest,
    rejectPendingForget: boolean,
    operation: (lease: ProviderCoordinatorLease) => Promise<T>,
  ): Promise<{ warnings: readonly string[]; value: T }> {
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
    let primaryFailed = false;
    try {
      providerLease = await this.#acquireProviderLease(request.signal);
      const disposition = await this.#recoverDisposition(
        request,
        providerLease,
        runtimeLease,
      );
      if (disposition.kind === "recovery-required") throw disposition.error;
      if (disposition.kind === "verification-pending" && !request.inspectCommitted) {
        throw new ProviderActivationRecoveryRequiredError();
      }
      if (rejectPendingForget) {
        await this.#assertNoPendingCredentialForget(providerLease);
      }
      const coordinatorLease: ProviderCoordinatorLease = {
        assertHeld: () => this.#assertMutationAllowed(
          providerLease!,
          runtimeLease,
          rejectPendingForget,
          request.signal,
        ),
      };
      await coordinatorLease.assertHeld();
      const value = await operation(coordinatorLease);
      await coordinatorLease.assertHeld();
      return { warnings: disposition.warnings, value };
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      let releaseFailed = false;
      if (providerLease) {
        try {
          await this.#releaseProviderLease(providerLease);
        } catch {
          releaseFailed = true;
        }
      }
      try {
        await Promise.resolve(runtimeLease.release());
      } catch {
        releaseFailed = true;
      }
      if (releaseFailed && !primaryFailed) {
        throw new ProviderActivationRecoveryRequiredError(
          "provider-activation-release-failed",
        );
      }
    }
  }

  async #recoverDisposition(
    request: ProviderActivationRecoveryRequest,
    lease: HeldProviderLease,
    runtimeLease: ProviderActivationRuntimeLease,
  ): Promise<RecoveryDisposition> {
    try {
      const warnings = await this.#recoverUnderLease(request, lease, runtimeLease);
      return warnings.length === 0
        ? { kind: "complete", warnings }
        : { kind: "verification-pending", warnings };
    } catch (error) {
      if (error instanceof ProviderActivationRecoveryRequiredError) {
        return { kind: "recovery-required", error };
      }
      throw error;
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
    // Recovery has the same adapter-instance boundary as a new activation:
    // resolve once before reading or changing a journal tuple.
    const adapter = this.#adapterFor(manifest.backendId);
    const facts = await readConfigFacts(this.#options.configPath);
    await this.#assertFence(lease);
    if (facts.kind !== "valid" && facts.kind !== "absent") {
      throw new ProviderActivationRecoveryRequiredError("provider-config-unreadable");
    }
    const current = facts.state;
    let candidateSecret: string | null;
    try {
      candidateSecret = await this.#options.credentials.readSlot(manifest.candidateSlot);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-slot-unreadable");
    }
    await this.#assertFence(lease);

    if (exactOldState(facts, manifest)) {
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

    if (!exactCandidateState(facts, manifest)) {
      throw new ProviderActivationRecoveryRequiredError("provider-recovery-pointer-ambiguous");
    }
    if (candidateSecret === null) {
      throw new ProviderActivationRecoveryRequiredError("provider-candidate-slot-missing");
    }
    if (!request.inspectCommitted) {
      return Object.freeze(["provider-activation-verification-pending"]);
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

    await assertRuntimeLease(runtimeLease);
    const candidate = await this.#connectCandidate(
      candidateSecret,
      manifest.expectedRevision + 1,
      request.signal,
      manifest.candidateConnectionId,
      adapter,
    );
    try {
      await assertRuntimeLease(runtimeLease);
      if (candidate.connectionId !== manifest.candidateConnectionId
        || candidate.accountFingerprint !== manifest.candidateRoute.accountFingerprint
        || candidate.billingRealm !== manifest.candidateRoute.billingRealm) {
        throw new ProviderActivationRecoveryRequiredError("provider-candidate-identity-mismatch");
      }
      const models = await this.#listModels(candidate.candidateId, request.signal, adapter);
      await assertRuntimeLease(runtimeLease);
      const model = models.find((entry) =>
        entry.backendId === manifest.backendId
        && entry.requestedModelId === manifest.candidateRoute.requestedModelId
        && entry.canonicalModelId === manifest.candidateRoute.canonicalModelId
      );
      if (!model) {
        throw new ProviderActivationRecoveryRequiredError("provider-candidate-model-mismatch");
      }
      await this.#assertFence(lease);
      await assertRuntimeLease(runtimeLease);
      await this.#removeJournal(transaction, lease);
      await assertRuntimeLease(runtimeLease);
      try {
        const activated = await this.#activateRuntime(candidate.candidateId, model, request.signal, adapter);
        await assertRuntimeLease(runtimeLease);
        assertActivatedRoute(manifest.candidateRoute, activated);
      } catch {
        throw new ProviderActivationRecoveryRequiredError("provider-runtime-bind-ambiguous");
      }
    } finally {
      await Promise.resolve().then(() => adapter.discardCandidate(candidate.candidateId)).catch(() => undefined);
    }
    return Object.freeze([]);
  }

  async #connectCandidate(
    secret: string,
    generation: number,
    signal: AbortSignal,
    connectionId: string | undefined,
    adapter: ActivationAdapter | BackendAdapter,
  ): Promise<ProviderCandidate> {
    try {
      const candidate = await abortableDependency(
        () => adapter.connect({
          ...(connectionId ? { connectionId } : {}),
          candidate: secret,
          generation,
          signal,
        }),
        signal,
        (lateCandidate) => Promise.resolve()
          .then(() => adapter.discardCandidate(lateCandidate.candidateId))
          .catch(() => undefined),
      );
      const policy = requireActivationPolicy(adapter.backendId as "openrouter" | "kimi-code");
      if (candidate.health.generation !== generation) {
        throw new StaleProviderGenerationError();
      }
      if (candidate.backendId !== adapter.backendId
        || candidate.billingRealm !== policy.billingRealm
        || candidate.health.credential !== "valid"
        || candidate.health.connectivity !== "connected"
        || candidate.health.spend === "limit-reached"
        || !candidate.accountFingerprint) {
        throw new Error("candidate-unavailable");
      }
      return candidate;
    } catch (error) {
      if (error instanceof StaleProviderGenerationError) throw error;
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
    adapter: ActivationAdapter | BackendAdapter,
  ): Promise<readonly BackendModelDescriptor[]> {
    try {
      return await abortableDependency(
        () => adapter.listModels({ candidateId, signal }),
        signal,
      );
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
    adapter: ActivationAdapter | BackendAdapter,
  ): Promise<CandidateProviderState> {
    try {
      throwIfAborted(signal);
      // Runtime activation can publish process state. Once invoked it must
      // settle while Runtime -> Provider ownership remains held; abort may be
      // observed by the adapter but must never detach its publication promise.
      if (model.backendId !== adapter.backendId) throw new Error("adapter-model-mismatch");
      return await adapter.activate({ candidateId, model, signal });
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

  async #observeCriticalConfigWritten(signal: AbortSignal): Promise<void> {
    try {
      await abortableDependency(
        () => this.#boundary("config-written"),
        signal,
      );
    } catch (error) {
      // An observer may be detached only after cancellation/deadline. A real
      // immediate boundary fault still escapes to preserve the crash point.
      if (isAbort(error, signal)) return;
      throw error;
    }
  }

  #configCommitSignal(signal: AbortSignal): {
    signal: AbortSignal;
    detach(): void;
    dispose(): void;
  } {
    const controller = new AbortController();
    let attached = true;
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    if (signal.aborted) relay();
    const detach = () => {
      if (!attached) return;
      attached = false;
      signal.removeEventListener("abort", relay);
    };
    return {
      signal: controller.signal,
      detach,
      dispose: detach,
    };
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

  #assertSynchronousProviderFence(lease: HeldProviderLease): void {
    if (this.#leaseNow() >= lease.owner.expiresAt) {
      throw new ProviderActivationRecoveryRequiredError("provider-lease-fence-lost");
    }
  }

  #assertActivationAttemptCurrent(request: ProviderActivationRequest): void {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || this.#leaseNow() >= request.deadlineAt) {
      throw new ProviderActivationError(
        "provider-activation-deadline",
        "Provider activation deadline expired.",
      );
    }
  }

  async #validateCandidatePermit(
    request: ProviderActivationRequest,
    lease: HeldProviderLease,
    runtimeLease: ProviderActivationRuntimeLease,
  ): Promise<void> {
    this.#assertActivationAttemptCurrent(request);
    if (!request.candidatePermit && !request.requireCandidatePermit) return;
    const validate = this.#options.candidateAuthority?.validateCandidatePermitUnderLease;
    if (!validate) {
      throw new ProviderActivationError(
        "provider-candidate-authority-stale",
        "Provider candidate authority is unavailable.",
      );
    }
    const result = await this.#awaitActivation(request, () => validate.call(
      this.#options.candidateAuthority,
      {
        deadlineAt: request.deadlineAt,
        signal: request.signal,
        credentialPermit: request.candidatePermit,
        requireCredentialPermit: request.requireCandidatePermit,
      },
      {
        assertHeld: () => this.#assertMutationAllowed(
          lease,
          runtimeLease,
          true,
          request.signal,
        ),
      },
    ));
    if (result.kind !== "ready") {
      throw new ProviderActivationError(
        "provider-candidate-authority-stale",
        "Provider candidate authority changed before activation.",
      );
    }
  }

  async #validateCandidatePermitAgainstSnapshot(
    request: ProviderActivationRequest,
    authoritativeState: ProviderSetupStateV2,
    lease: HeldProviderLease,
    runtimeLease: ProviderActivationRuntimeLease,
  ): Promise<void> {
    this.#assertActivationAttemptCurrent(request);
    if (!request.candidatePermit && !request.requireCandidatePermit) return;
    const validate = this.#options.candidateAuthority
      ?.validateCandidatePermitAgainstSnapshotUnderLease;
    if (!validate) {
      throw new ProviderActivationError(
        "provider-candidate-authority-stale",
        "Provider candidate authority is unavailable.",
      );
    }
    const result = await this.#awaitActivation(request, () => validate.call(
      this.#options.candidateAuthority,
      {
        deadlineAt: request.deadlineAt,
        signal: request.signal,
        credentialPermit: request.candidatePermit,
        requireCredentialPermit: request.requireCandidatePermit,
        candidate: request.candidate,
        authoritativeState,
      },
      {
        assertHeld: () => this.#assertMutationAllowed(
          lease,
          runtimeLease,
          true,
          request.signal,
        ),
      },
    ));
    if (result.kind !== "ready") {
      throw new ProviderActivationError(
        "provider-candidate-authority-stale",
        "Provider candidate authority changed before activation.",
      );
    }
  }

  async #assertMutationAllowed(
    lease: HeldProviderLease,
    runtimeLease: ProviderActivationRuntimeLease,
    rejectPendingForget: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await assertRuntimeLease(runtimeLease);
    throwIfAborted(signal);
    await this.#assertFence(lease);
    throwIfAborted(signal);
    if (rejectPendingForget) {
      await this.#assertNoPendingCredentialForget(lease);
      throwIfAborted(signal);
      await this.#assertFence(lease);
    }
    throwIfAborted(signal);
    await assertRuntimeLease(runtimeLease);
    throwIfAborted(signal);
  }

  async #assertNoPendingCredentialForget(lease: HeldProviderLease): Promise<void> {
    const path = join(this.#options.appHome, PROVIDER_CREDENTIAL_FORGET_DIRECTORY);
    let emptyClaim: PrivateDirectoryClaim | null;
    try {
      await this.#assertFence(lease);
      emptyClaim = await this.#options.privateStore.createDirectoryExclusive(path);
      await this.#assertFence(lease);
    } catch (error) {
      if (error instanceof ProviderActivationError) throw error;
      throw new ProviderActivationRecoveryRequiredError(
        "provider-credential-cleanup-identity-failed",
      );
    }
    if (!emptyClaim) {
      throw new ProviderActivationRecoveryRequiredError(
        "provider-credential-cleanup-pending",
      );
    }
    try {
      await this.#options.privateStore.releaseDirectoryClaim(emptyClaim, null);
      await this.#assertFence(lease);
    } catch {
      throw new ProviderActivationRecoveryRequiredError(
        "provider-credential-cleanup-identity-failed",
      );
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

  #adapterFor(backendId: "openrouter" | "kimi-code"): ActivationAdapter | BackendAdapter {
    try {
      const adapter = this.#adapterResolver(backendId);
      if (!adapter || adapter.backendId !== backendId) throw new Error("adapter-mismatch");
      return adapter;
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-adapter-unavailable");
    }
  }

  #activationDeadline(request: ProviderActivationRequest): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const controller = new AbortController();
    const remaining = Math.max(0, request.deadlineAt - this.#leaseNow());
    const abort = () => controller.abort(new ProviderActivationError(
      "provider-activation-deadline",
      "Provider activation deadline expired.",
    ));
    const timer = remaining <= 0x7fff_ffff ? setTimeout(abort, remaining) : null;
    const relayAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", relayAbort, { once: true });
    if (request.signal.aborted) relayAbort();
    return {
      signal: controller.signal,
      dispose: () => {
        if (timer !== null) clearTimeout(timer);
        request.signal.removeEventListener("abort", relayAbort);
      },
    };
  }

  async #awaitActivation<T>(
    request: ProviderActivationRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertActivationAttemptCurrent(request);
    const value = await abortableDependency(operation, request.signal);
    this.#assertActivationAttemptCurrent(request);
    return value;
  }

  async #awaitRuntimeLease(
    request: ProviderActivationRequest,
  ): Promise<ProviderActivationRuntimeLease> {
    this.#assertActivationAttemptCurrent(request);
    const lease = await abortableDependency(
      () => this.#options.runtimeGuard.acquire(request.signal),
      request.signal,
      (lateLease) => Promise.resolve(lateLease.release()).catch(() => undefined),
    );
    this.#assertActivationAttemptCurrent(request);
    return lease;
  }

  async #waitForLease(signal: AbortSignal): Promise<void> {
    try {
      await abortableDependency(
        () => this.#options.waitForLease(),
        signal,
      );
    } catch (error) {
      if (isAbort(error, signal)) throw abortFrom(signal);
      throw new ProviderActivationRecoveryRequiredError("provider-lease-wait-failed");
    }
    throwIfAborted(signal);
  }

  async #createJournal(
    manifest: ProviderActivationJournal,
    lease: HeldProviderLease,
  ): Promise<TransactionJournal> {
    const activationRoot = join(this.#options.appHome, ACTIVATION_DIRECTORY);
    const path = join(activationRoot, manifest.transactionId);
    let transactionClaim: PrivateDirectoryClaim;
    try {
      await this.#assertFence(lease);
      await this.#options.privateStore.ensureDirectory(activationRoot);
      await this.#assertFence(lease);
      const acquired = await this.#options.privateStore.createDirectoryExclusive(path);
      await this.#assertFence(lease);
      if (!acquired) {
        throw new ProviderActivationRecoveryRequiredError("provider-transaction-collision");
      }
      transactionClaim = acquired;
    } catch (error) {
      if (error instanceof ProviderActivationError) throw error;
      throw new ProviderActivationRecoveryRequiredError("provider-journal-create-failed");
    }
    const transaction = {
      claim: transactionClaim!,
      rawManifest: "",
      manifest: structuredClone(manifest),
    };
    await this.#writeJournal(transaction, manifest, lease);
    return transaction;
  }

  async #writeJournal(
    transaction: TransactionJournal,
    manifest: ProviderActivationJournal,
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
      await this.#options.privateStore.writeClaimManifest(
        transaction.claim,
        serialized,
        transaction.rawManifest === "" ? null : transaction.rawManifest,
      );
    } catch {
      // The atomic publish may already have completed; exact readback is authoritative.
    }
    await this.#assertFence(lease);
    let readback: string;
    try {
      readback = await this.#options.privateStore.readClaimManifest(
        transaction.claim,
        MANIFEST_FILE_LIMIT,
      );
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-readback-failed");
    }
    await this.#assertFence(lease);
    const parsed = parseJournal(readback, manifest.transactionId);
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(manifest)) {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-readback-failed");
    }
    transaction.rawManifest = readback;
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
      let claim: PrivateDirectoryClaim;
      let raw: string;
      try {
        const adopted = await this.#options.privateStore.adoptDirectoryClaim(path);
        claim = adopted.claim;
        raw = await this.#options.privateStore.readClaimManifest(
          claim,
          MANIFEST_FILE_LIMIT,
        );
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
      transactions.push({ claim: claim!, rawManifest: raw, manifest });
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
        || !exactOldState(facts, transaction.manifest)) {
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
    previous: ProviderActivationJournal["previousSlot"],
    activeState: ProviderSetupStateV2,
    transaction: TransactionJournal,
    lease: HeldProviderLease,
  ): Promise<boolean> {
    if (!previous || previous.version === 0) return true;
    try {
      await this.#assertFence(lease);
      const facts = await readConfigFacts(this.#options.configPath);
      await this.#assertFence(lease);
      if ((facts.kind !== "valid" && facts.kind !== "absent")
        || !exactCandidateState(facts, transaction.manifest)
        || stateReferencesSlot(activeState, previous.id)
        || stateReferencesSlot(facts.state, previous.id)) {
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
      await this.#options.privateStore.removeClaimManifest(
        transaction.claim,
        transaction.rawManifest,
      );
      await this.#assertFence(lease);
      await this.#options.privateStore.releaseDirectoryClaim(transaction.claim, null);
    } catch {
      throw new ProviderActivationRecoveryRequiredError("provider-journal-cleanup-failed");
    }
    await this.#assertFence(lease);
  }
}

function requireActivationPolicy(backendId: "openrouter" | "kimi-code"): ProviderCredentialPolicy {
  const policy = providerCredentialPolicy(backendId);
  if (!policy || policy.savedSlotKinds.length !== 1) {
    throw new ProviderActivationError("provider-credential-policy-invalid", "Provider credential policy is invalid.");
  }
  return policy;
}

export async function recoverProviderActivation(
  options: ProviderActivationCoordinatorOptions,
  request: ProviderActivationRecoveryRequest,
): Promise<readonly string[]> {
  return new ProviderActivationCoordinator(options).recover(request);
}

function buildNextState(
  current: ProviderSetupStateV2,
  candidate: ProviderCandidate,
  candidateSlot: CredentialSlotRef,
  route: RouteIdentityV1,
): ProviderSetupStateV2 {
  if (!candidate.accountFingerprint) {
    throw new ProviderActivationError(
      "provider-candidate-identity-missing",
      "Provider candidate identity is unavailable.",
    );
  }
  const connection = {
    id: candidate.connectionId,
    backendId: candidate.backendId,
    enabled: true,
    maturity: candidate.backendId === "openrouter" ? "stable" as const : "preview" as const,
    credentialSlot: candidateSlot.id,
    accountFingerprint: candidate.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: candidate.billingRealm,
    lastHealth: structuredClone(candidate.health),
  };
  const connections = current.connections
    .filter((entry) => entry.id !== candidate.connectionId)
    .concat(connection);
  const next: ProviderSetupStateV2 = {
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

function assertNoRetainedIdentityCollision(
  state: ProviderSetupStateV2,
  candidate: ProviderCandidate,
): void {
  if (!candidate.accountFingerprint) return;
  const collision = state.connections.some((connection) =>
    connection.id !== candidate.connectionId
    && connection.backendId === candidate.backendId
    && connection.accountFingerprint === candidate.accountFingerprint
    && connection.billingRealm === candidate.billingRealm
  );
  if (collision) {
    throw new ProviderActivationError(
      "provider-connection-identity-collision",
      "Provider connection identity is already retained.",
    );
  }
}

function previousSlotFromState(
  state: ProviderSetupStateV2,
  connectionId: string,
): ProviderActivationJournal["previousSlot"] {
  const existing = state.connections.find((connection) => connection.id === connectionId);
  const value = existing?.credentialSlot;
  if (!value) return null;
  if (value === "legacy:inference") {
    return { version: 0, kind: "inference", id: "legacy:inference" };
  }
  const policy = existing ? providerCredentialPolicy(existing.backendId) : null;
  const parsed = policy
    ? parseCredentialSlot({ version: 1, kind: policy.savedSlotKinds[0]!, id: value })
    : null;
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
    backendId: candidate.backendId,
    accountFingerprint: candidate.accountFingerprint,
    billingRealm: candidate.billingRealm,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved",
  };
}

function selectExplicitModel(
  models: readonly BackendModelDescriptor[],
  requestedModelId: string,
  canonicalModelId: string,
  backendId: "openrouter" | "kimi-code",
): BackendModelDescriptor {
  const selected = models.find((model) =>
    model.backendId === backendId
    && model.requestedModelId === requestedModelId
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
  facts: Extract<ConfigFacts, { kind: "valid" | "absent" }>,
  manifest: ProviderActivationJournal,
): boolean {
  return facts.digest === manifest.candidateProviderSetupSha256;
}

function exactOldState(
  facts: Extract<ConfigFacts, { kind: "valid" | "absent" }>,
  manifest: ProviderActivationJournal,
): boolean {
  return facts.digest === manifest.expectedProviderSetupSha256;
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

function stateReferencesSlot(state: ProviderSetupStateV2, slotId: string): boolean {
  return state.connections.some((connection) => connection.credentialSlot === slotId);
}

async function readConfigFacts(path: string): Promise<ConfigFacts> {
  let raw: string;
  let kind: "valid" | "absent" = "valid";
  let target: ConfigFileSnapshot;
  try {
    target = await readConfigFileSnapshot(path);
  } catch {
    return { kind: "unreadable" };
  }
  if (target.kind === "absent") {
    kind = "absent";
    raw = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  } else {
    raw = target.raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(parsed)) return { kind: "corrupt" };
  if (!Number.isInteger(parsed.schemaVersion) || Number(parsed.schemaVersion) < 0) {
    return { kind: "corrupt" };
  }
  if (Number(parsed.schemaVersion) > CONFIG_SCHEMA_VERSION) {
    return { kind: "future" };
  }
  if (!("providerSetup" in parsed)) return { kind: "corrupt" };
  const looseState = validateProviderSetupState(parsed.providerSetup);
  if (isProviderStateIssue(looseState)) {
    return { kind: looseState.kind === "future-version" ? "future" : "corrupt" };
  }
  const state = strictProviderSetup(parsed.providerSetup);
  const span = findTopLevelJsonValue(raw, "providerSetup");
  if (!state || !span) return { kind: "corrupt" };
  return {
    kind,
    prefix: raw.slice(0, span.start),
    suffix: raw.slice(span.end),
    state,
    digest: providerSetupDigest(state),
    target,
  };
}

function providerSetupDigest(value: unknown): string {
  const state = strictProviderSetup(value);
  if (!state) {
    throw new ProviderActivationRecoveryRequiredError("provider-state-invalid");
  }
  return createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex");
}

function strictProviderSetup(value: unknown): ProviderSetupStateV2 | null {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "revision",
      "lifecycle",
      "connections",
      "defaultRoute",
      "cross",
    ])
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !Array.isArray(value.connections)
    || !value.connections.every((connection) => isRecord(connection)
      && exactKeys(connection, [
        "id",
        "backendId",
        "enabled",
        "maturity",
        "credentialSlot",
        "accountFingerprint",
        "accountFingerprintState",
        "billingRealm",
        "lastHealth",
      ])
      && (connection.lastHealth === null || (isRecord(connection.lastHealth)
        && exactKeys(connection.lastHealth, [
          "credential",
          "connectivity",
          "spend",
          "runtime",
          "observedAt",
          "generation",
        ]))))
    || !strictNullableRouteShape(value.defaultRoute)
    || !isRecord(value.cross)
    || !exactKeys(value.cross, ["enabled", "preferredLead", "preferredChallenger"])
    || !strictNullableRouteShape(value.cross.preferredLead)
    || !strictNullableRouteShape(value.cross.preferredChallenger)) {
    return null;
  }
  const validated = validateProviderSetupState(value);
  if (isProviderStateIssue(validated)) return null;
  return {
    schemaVersion: 2,
    revision: validated.revision,
    lifecycle: validated.lifecycle,
    connections: validated.connections.map((connection) => ({
      id: connection.id,
      backendId: connection.backendId,
      enabled: connection.enabled,
      maturity: connection.maturity,
      credentialSlot: connection.credentialSlot,
      accountFingerprint: connection.accountFingerprint,
      accountFingerprintState: connection.accountFingerprintState,
      billingRealm: connection.billingRealm,
      lastHealth: connection.lastHealth === null ? null : {
        credential: connection.lastHealth.credential,
        connectivity: connection.lastHealth.connectivity,
        spend: connection.lastHealth.spend,
        runtime: connection.lastHealth.runtime,
        observedAt: connection.lastHealth.observedAt,
        generation: connection.lastHealth.generation,
      },
    })),
    defaultRoute: cloneExactRoute(validated.defaultRoute),
    cross: {
      enabled: false,
      preferredLead: cloneExactRoute(validated.cross.preferredLead),
      preferredChallenger: cloneExactRoute(validated.cross.preferredChallenger),
    },
  };
}

function strictNullableRouteShape(value: unknown): boolean {
  return value === null || (isRecord(value) && exactKeys(value, [
    "version",
    "backendId",
    "accountFingerprint",
    "billingRealm",
    "requestedModelId",
    "canonicalModelId",
    "resolutionState",
  ]));
}

function cloneExactRoute(value: RouteIdentityV1 | null): RouteIdentityV1 | null {
  if (value === null) return null;
  return {
    version: 1,
    backendId: value.backendId,
    accountFingerprint: value.accountFingerprint,
    billingRealm: value.billingRealm,
    requestedModelId: value.requestedModelId,
    canonicalModelId: value.canonicalModelId,
    resolutionState: value.resolutionState,
  };
}

function findTopLevelJsonValue(
  raw: string,
  wantedKey: string,
): { start: number; end: number } | null {
  let index = skipJsonWhitespace(raw, 0);
  if (raw[index] !== "{") return null;
  index = skipJsonWhitespace(raw, index + 1);
  let found: { start: number; end: number } | null = null;
  while (index < raw.length && raw[index] !== "}") {
    const keyToken = scanJsonString(raw, index);
    if (!keyToken) return null;
    let key: unknown;
    try { key = JSON.parse(raw.slice(index, keyToken)); } catch { return null; }
    index = skipJsonWhitespace(raw, keyToken);
    if (raw[index] !== ":") return null;
    const start = skipJsonWhitespace(raw, index + 1);
    const end = scanJsonValue(raw, start);
    if (end === null) return null;
    if (key === wantedKey) {
      if (found) return null;
      found = { start, end };
    }
    index = skipJsonWhitespace(raw, end);
    if (raw[index] === ",") index = skipJsonWhitespace(raw, index + 1);
    else if (raw[index] !== "}") return null;
  }
  return found;
}

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
  return index;
}

function scanJsonString(raw: string, start: number): number | null {
  if (raw[start] !== '"') return null;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") index += 1;
    else if (raw[index] === '"') return index + 1;
  }
  return null;
}

function scanJsonValue(raw: string, start: number): number | null {
  if (raw[start] === '"') return scanJsonString(raw, start);
  if (raw[start] === "{" || raw[start] === "[") {
    const stack = [raw[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < raw.length; index += 1) {
      if (raw[index] === '"') {
        const end = scanJsonString(raw, index);
        if (end === null) return null;
        index = end - 1;
      } else if (raw[index] === "{") stack.push("}");
      else if (raw[index] === "[") stack.push("]");
      else if (raw[index] === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return null;
  }
  let index = start;
  while (index < raw.length && !/[\s,}\]]/.test(raw[index]!)) index += 1;
  return index > start ? index : null;
}

function parseJournal(raw: string, transactionId: string): ProviderActivationJournal | null {
  if (Buffer.byteLength(raw, "utf8") > MANIFEST_FILE_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    if (!isRecord(parsed)) return null;
    if (parsed.version === 1) return parseLegacyOpenRouterJournalV1(parsed, transactionId);
    if (parsed.version !== 2) return null;
    validateJournalV2(parsed, transactionId);
    const value = parsed as unknown as Record<string, unknown>;
    const candidateSlot = parseCredentialSlot(value.candidateSlot);
    const backendId = value.backendId;
    if (backendId !== "openrouter" && backendId !== "kimi-code") return null;
    const policy = providerCredentialPolicy(backendId);
    if (!policy) return null;
    const previousSlot = parsePreviousSlot(value.previousSlot, backendId);
    const candidateRoute = parseStrictRoute(value.candidateRoute);
    if (!candidateSlot || candidateSlot.kind !== value.credentialSlotKind
      || !policy.savedSlotKinds.includes(candidateSlot.kind)
      || previousSlot === undefined || !candidateRoute
      || candidateRoute.backendId !== backendId
      || candidateRoute.billingRealm !== policy.billingRealm) return null;
    return {
      version: 2,
      transactionId,
      expectedRevision: Number(value.expectedRevision),
      phase: value.phase as ProviderActivationJournalV2["phase"],
      backendId,
      credentialSlotKind: candidateSlot.kind,
      candidateSlot,
      previousSlot,
      candidateConnectionId: String(value.candidateConnectionId),
      candidateRoute,
      expectedProviderSetupSha256: String(value.expectedProviderSetupSha256),
      candidateProviderSetupSha256: String(value.candidateProviderSetupSha256),
    };
  } catch {
    return null;
  }
}

/** Frozen parser: journal-v1 is OpenRouter-only and never reinterprets Kimi. */
function parseLegacyOpenRouterJournalV1(
  value: Record<string, unknown>,
  transactionId: string,
): ProviderActivationJournalV1 | null {
  if (!isFrozenOpenRouterJournalV1Shape(value, transactionId)) return null;
  const candidateSlot = parseFrozenOpenRouterInferenceSlotV1(value.candidateSlot);
  const previousSlot = parseFrozenOpenRouterPreviousSlotV1(value.previousSlot);
  const candidateRoute = parseFrozenOpenRouterRouteV1(value.candidateRoute);
  if (!candidateSlot || previousSlot === undefined || !candidateRoute) return null;
  return {
    version: 1,
    transactionId,
    expectedRevision: value.expectedRevision,
    phase: value.phase,
    backendId: "openrouter",
    candidateSlot,
    previousSlot,
    candidateConnectionId: value.candidateConnectionId,
    candidateRoute,
    expectedProviderSetupSha256: value.expectedProviderSetupSha256,
    candidateProviderSetupSha256: value.candidateProviderSetupSha256,
  };
}

function validateJournal(value: ProviderActivationJournal, transactionId: string): void {
  if (value.version === 1) {
    if (!isRecord(value) || !parseLegacyOpenRouterJournalV1(value, transactionId)) {
      throw new Error("invalid-provider-activation-journal");
    }
    return;
  }
  validateJournalV2(value, transactionId);
}

function isFrozenOpenRouterJournalV1Shape(
  value: Record<string, unknown>,
  transactionId: string,
): value is Record<string, unknown> & {
  version: 1;
  transactionId: string;
  expectedRevision: number;
  phase: ProviderActivationJournalV1["phase"];
  backendId: "openrouter";
  candidateConnectionId: string;
  expectedProviderSetupSha256: string;
  candidateProviderSetupSha256: string;
} {
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
      "expectedProviderSetupSha256",
      "candidateProviderSetupSha256",
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
    || typeof value.candidateConnectionId !== "string"
    || value.candidateConnectionId.length === 0
    || value.candidateConnectionId.length > 256
    || typeof value.expectedProviderSetupSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.expectedProviderSetupSha256)
    || typeof value.candidateProviderSetupSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.candidateProviderSetupSha256)) return false;
  return true;
}

function parseFrozenOpenRouterInferenceSlotV1(value: unknown): CredentialSlotRef | null {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "kind", "id"])
    || value.version !== 1
    || value.kind !== "inference"
    || typeof value.id !== "string"
    || !value.id.startsWith("v1:inference:")
    || !CANONICAL_UUID.test(value.id.slice("v1:inference:".length))) return null;
  return Object.freeze({ version: 1 as const, kind: "inference" as const, id: value.id });
}

function parseFrozenOpenRouterPreviousSlotV1(
  value: unknown,
): ProviderActivationJournalV1["previousSlot"] | undefined {
  if (value === null) return null;
  const slot = parseFrozenOpenRouterInferenceSlotV1(value);
  if (slot) return slot;
  if (isRecord(value)
    && exactKeys(value, ["version", "kind", "id"])
    && value.version === 0
    && value.kind === "inference"
    && value.id === "legacy:inference") {
    return { version: 0, kind: "inference", id: "legacy:inference" };
  }
  return undefined;
}

function parseFrozenOpenRouterRouteV1(value: unknown): RouteIdentityV1 | null {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "backendId", "accountFingerprint", "billingRealm", "requestedModelId", "canonicalModelId", "resolutionState"])
    || value.version !== 1
    || value.backendId !== "openrouter"
    || value.billingRealm !== "openrouter-payg"
    || value.resolutionState !== "resolved"
    || typeof value.accountFingerprint !== "string" || value.accountFingerprint.length === 0 || value.accountFingerprint.length > 512
    || typeof value.requestedModelId !== "string" || value.requestedModelId.length === 0 || value.requestedModelId.length > 512
    || typeof value.canonicalModelId !== "string" || value.canonicalModelId.length === 0 || value.canonicalModelId.length > 512) return null;
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: value.accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: value.requestedModelId,
    canonicalModelId: value.canonicalModelId,
    resolutionState: "resolved",
  };
}

function validateJournalV2(value: unknown, transactionId: string): asserts value is ProviderActivationJournalV2 {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "transactionId", "expectedRevision", "phase", "backendId", "credentialSlotKind", "candidateSlot", "previousSlot", "candidateConnectionId", "candidateRoute", "expectedProviderSetupSha256", "candidateProviderSetupSha256"])
    || value.version !== 2 || value.transactionId !== transactionId || !CANONICAL_UUID.test(transactionId)
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER
    || (value.phase !== "prepared" && value.phase !== "credential-staged" && value.phase !== "config-committed")
    || (value.backendId !== "openrouter" && value.backendId !== "kimi-code")
    || (value.credentialSlotKind !== "inference" && value.credentialSlotKind !== "kimi-code")
    || typeof value.candidateConnectionId !== "string" || value.candidateConnectionId.length === 0 || value.candidateConnectionId.length > 256
    || typeof value.expectedProviderSetupSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.expectedProviderSetupSha256)
    || typeof value.candidateProviderSetupSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.candidateProviderSetupSha256)) {
    throw new Error("invalid-provider-activation-journal");
  }
  const policy = providerCredentialPolicy(value.backendId);
  const candidateSlot = parseCredentialSlot(value.candidateSlot);
  const previousSlot = parsePreviousSlot(value.previousSlot, value.backendId);
  const route = parseStrictRoute(value.candidateRoute);
  if (!policy
    || !candidateSlot
    || candidateSlot.kind !== value.credentialSlotKind
    || !policy.savedSlotKinds.includes(candidateSlot.kind)
    || previousSlot === undefined
    || !route
    || route.backendId !== value.backendId
    || route.billingRealm !== policy.billingRealm) {
    throw new Error("invalid-provider-activation-journal");
  }
}

function parseCredentialSlot(value: unknown): CredentialSlotRef | null {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "kind", "id"])
    || value.version !== 1
    || (value.kind !== "inference" && value.kind !== "management" && value.kind !== "kimi-code")
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

function parsePreviousSlot(
  value: unknown,
  backendId: "openrouter" | "kimi-code",
): ProviderActivationJournal["previousSlot"] | undefined {
  if (value === null) return null;
  const current = parseCredentialSlot(value);
  const policy = providerCredentialPolicy(backendId);
  if (current && policy?.savedSlotKinds.includes(current.kind)) return current;
  if (isRecord(value)
      && exactKeys(value, ["version", "kind", "id"])
      && value.version === 0
      && value.kind === "inference"
      && value.id === "legacy:inference" && backendId === "openrouter") {
    return { version: 0, kind: "inference", id: "legacy:inference" };
  }
  return undefined;
}

function parseStrictRoute(value: unknown): RouteIdentityV1 | null {
  if (!isRecord(value)
    || !exactKeys(value, [
      "version",
      "backendId",
      "accountFingerprint",
      "billingRealm",
      "requestedModelId",
      "canonicalModelId",
      "resolutionState",
    ])) return null;
  const validated = validateRouteIdentityV1(value);
  if (!validated
    || (validated.backendId !== "openrouter" && validated.backendId !== "kimi-code")
    || validated.billingRealm !== providerCredentialPolicy(validated.backendId)?.billingRealm
    || validated.resolutionState !== "resolved"
    || validated.accountFingerprint.length > 512
    || validated.requestedModelId.length > 512
    || validated.canonicalModelId === null
    || validated.canonicalModelId.length > 512) return null;
  return {
    version: 1,
    backendId: validated.backendId,
    accountFingerprint: validated.accountFingerprint,
    billingRealm: validated.billingRealm,
    requestedModelId: validated.requestedModelId,
    canonicalModelId: validated.canonicalModelId,
    resolutionState: "resolved",
  };
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
    throw new ProviderActivationRecoveryRequiredError(
      "provider-runtime-guard-lost",
    );
  }
}

function assertRuntimeLeaseSynchronously(lease: ProviderActivationRuntimeLease): void {
  try {
    lease.assertHeldSynchronously?.();
  } catch {
    throw new ProviderActivationRecoveryRequiredError(
      "provider-runtime-guard-lost",
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

function abortableDependency<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateResolve?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFrom(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortFrom(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => {
        if (settled) {
          if (onLateResolve) void Promise.resolve(onLateResolve(value)).catch(() => undefined);
          return;
        }
        finish(() => resolve(value));
      },
      (error) => {
        if (settled) return;
        finish(() => reject(error));
      },
    );
  });
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
