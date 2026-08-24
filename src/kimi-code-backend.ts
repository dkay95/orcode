import { randomUUID } from "node:crypto";
import {
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderHealth,
  type ProviderInspectionRequest,
} from "./backends.js";
import { normalizeProviderSecret } from "./credentials.js";
import {
  KIMI_CODE_MODELS,
  KimiCodeRequestError,
  KimiCodeService,
  issuedKimiCodeFailure,
  kimiCodeAccountFingerprint,
  type KimiCodeFailure,
  type KimiCodeModelDefinition,
} from "./kimi-code.js";
import type {
  ProviderAuthorityReadLease,
  ProviderCredentialAccessResult,
  ProviderCredentialAuthorityLike,
  ProviderCredentialUseContext,
} from "./provider-authority.js";

export const KIMI_CODE_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: "kimi-code",
  displayName: "Kimi Code",
  maturity: "preview",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "provider-managed",
  capabilities: Object.freeze({ models: true, tools: true, reasoning: true }),
});

export interface KimiCodeIdentityStore {
  getOrCreateAccountHmacKey(): Promise<Uint8Array>;
}

export interface KimiCodeInspection {
  backendId: "kimi-code";
  connectionId: string;
  health: ProviderHealth;
  headline: ReturnType<typeof deriveProviderHeadline>;
  accountFingerprint: string | null;
  billingRealm: "kimi-code-membership-provider-managed-overage";
  routeEligible: boolean;
  retryable: boolean;
  explanationCode: string;
}

export interface KimiCodeBackendAdapterOptions {
  service: KimiCodeService;
  credentials: KimiCodeIdentityStore;
  credentialAuthority: ProviderCredentialAuthorityLike;
  now?: () => number;
  createCandidateId?: () => string;
  createConnectionId?: () => string;
  accountFingerprint?: (
    localIdentityKey: Uint8Array,
    normalizedKey: string,
  ) => string;
}

interface CandidateMetadata {
  readonly candidateId: string;
  readonly connectionId: string;
  readonly accountFingerprint: string;
  readonly models: readonly BackendModelDescriptor[];
  readonly generation: number;
  readonly deadlineAt: number;
  readonly health: ProviderHealth;
}

interface ActiveInspectionMetadata {
  readonly connectionId: string;
  readonly accountFingerprint: string;
  readonly models: readonly BackendModelDescriptor[];
  readonly generation: number;
  readonly deadlineAt: number;
  readonly health: ProviderHealth;
}

interface InspectedMetadata {
  inspection: KimiCodeInspection;
  metadata: ActiveInspectionMetadata | null;
}

interface InspectionAttempt {
  token: symbol;
  previous: ActiveInspectionMetadata | null;
}

type InspectionCredentialAccess = (
  use: (secret: string, context: ProviderCredentialUseContext) => Promise<InspectedMetadata>,
) => Promise<ProviderCredentialAccessResult<InspectedMetadata>>;

export class KimiCodeBackendAdapter implements BackendAdapter {
  readonly backendId = "kimi-code" as const;
  readonly #service: KimiCodeService;
  readonly #credentials: KimiCodeIdentityStore;
  readonly #credentialAuthority: ProviderCredentialAuthorityLike;
  readonly #now: () => number;
  readonly #createCandidateId: () => string;
  readonly #createConnectionId: () => string;
  readonly #accountFingerprint: (
    localIdentityKey: Uint8Array,
    normalizedKey: string,
  ) => string;
  readonly #candidates = new Map<string, CandidateMetadata>();
  readonly #activeInspections = new Map<string, ActiveInspectionMetadata>();
  readonly #connectionGenerations = new Map<string, number>();
  readonly #inspectionAttempts = new Map<string, symbol>();

  constructor(options: KimiCodeBackendAdapterOptions) {
    this.#service = options.service;
    this.#credentials = options.credentials;
    this.#credentialAuthority = options.credentialAuthority;
    this.#now = options.now ?? Date.now;
    this.#createCandidateId = options.createCandidateId ?? randomUUID;
    this.#createConnectionId = options.createConnectionId ?? randomUUID;
    this.#accountFingerprint = options.accountFingerprint ?? kimiCodeAccountFingerprint;
  }

  async inspect(request: ProviderInspectionRequest): Promise<KimiCodeInspection> {
    const attempt = this.#beginInspection(request.connectionId, request.generation);
    if (attempt === null) {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-inspection-stale",
      );
    }
    if (request.environmentEligibility !== undefined
      && request.environmentEligibility !== "forbidden") {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-credential-unavailable",
      );
    }
    return this.#inspectWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredential(
        this.#credentialRequest(request),
        use,
      ),
      attempt,
    );
  }

  async inspectUnderAuthorityLease(
    request: ProviderInspectionRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<KimiCodeInspection> {
    const attempt = this.#beginInspection(request.connectionId, request.generation);
    if (attempt === null) {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-inspection-stale",
      );
    }
    if (!this.#credentialAuthority.withCredentialUnderLease) {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-credential-unavailable",
      );
    }
    return this.#inspectWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredentialUnderLease!(
        this.#credentialRequest(request),
        lease,
        use,
      ),
      attempt,
      lease,
    );
  }

  async #inspectWithCredentialAccess(
    request: ProviderInspectionRequest,
    access: InspectionCredentialAccess,
    attempt: InspectionAttempt,
    lease?: ProviderAuthorityReadLease,
  ): Promise<KimiCodeInspection> {
    try {
      return await this.#inspectWithCredentialAccessCurrent(
        request,
        access,
        attempt,
        lease,
      );
    } catch {
      if (this.#isInspectionCurrent(request.connectionId, request.generation, attempt.token)) {
        this.#activeInspections.delete(request.connectionId);
        this.#inspectionAttempts.delete(request.connectionId);
      }
      if (request.signal.aborted) throwIfAborted(request.signal);
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-recovery-required",
      );
    }
  }

  async #inspectWithCredentialAccessCurrent(
    request: ProviderInspectionRequest,
    access: InspectionCredentialAccess,
    attempt: InspectionAttempt,
    lease?: ProviderAuthorityReadLease,
  ): Promise<KimiCodeInspection> {
    const selected = await this.#awaitDependency(() => access(async (secret, context) => {
      if (!this.#isInspectionCurrent(
        request.connectionId,
        request.generation,
        attempt.token,
      )) {
        return {
          inspection: this.#emptyInspection(
            request.connectionId,
            request.generation,
            "kimi-code-inspection-stale",
          ),
          metadata: null,
        };
      }
      this.#assertCurrent(request.deadlineAt, request.signal);
      if (!validKimiCredentialContext(context, request.connectionId)) {
        return {
          inspection: this.#emptyInspection(
            request.connectionId,
            request.generation,
            "kimi-code-credential-unavailable",
          ),
          metadata: null,
        };
      }
      await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
      const inspected = await this.#inspectSecret(
        secret,
        request.connectionId,
        request.generation,
        request.deadlineAt,
        request.signal,
        context.binding.accountFingerprint,
        attempt.previous,
      );
      await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
      let publicationDecision: InspectedMetadata | null = null;
      if (this.#isInspectionCurrent(request.connectionId, request.generation, attempt.token)) {
        await this.#awaitDependency(() => context.publishIfCurrent(() => {
          const publicationObservedAt = this.#readNow();
          throwIfAborted(request.signal);
          if (!this.#isInspectionCurrent(
            request.connectionId,
            request.generation,
            attempt.token,
          )) return;
          if (
            !Number.isFinite(request.deadlineAt)
            || request.deadlineAt <= publicationObservedAt
          ) {
            throw new KimiCodeRequestError(offlineFailure());
          }
          if (
            inspected.metadata
            && inspected.metadata.deadlineAt <= publicationObservedAt
          ) {
            publicationDecision = this.#withoutExpiredReusedMetadata(
              inspected,
              publicationObservedAt,
            );
            this.#activeInspections.delete(request.connectionId);
            return;
          }
          if (inspected.metadata) {
            this.#activeInspections.set(request.connectionId, inspected.metadata);
          } else {
            this.#activeInspections.delete(request.connectionId);
          }
          publicationDecision = inspected;
        }), request.deadlineAt, request.signal);
      }
      return publicationDecision ?? {
        inspection: this.#emptyInspection(
          request.connectionId,
          request.generation,
          "kimi-code-inspection-stale",
        ),
        metadata: null,
      };
    }), request.deadlineAt, request.signal);
    if (selected.kind !== "available") {
      if (!this.#isInspectionCurrent(request.connectionId, request.generation, attempt.token)) {
        return this.#emptyInspection(
          request.connectionId,
          request.generation,
          "kimi-code-inspection-stale",
        );
      }
      this.#activeInspections.delete(request.connectionId);
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        explanationForCredentialAccess(selected),
      );
    }
    await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
    if (!this.#isInspectionCurrent(request.connectionId, request.generation, attempt.token)) {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "kimi-code-inspection-stale",
      );
    }
    return selected.value.inspection;
  }

  #credentialRequest(request: ProviderInspectionRequest) {
    return {
      backendId: "kimi-code" as const,
      connectionId: request.connectionId,
      credentialKind: "inference" as const,
      purpose: request.purpose ?? "startup-inspect",
      environmentEligibility: "forbidden" as const,
      allowDisabled: request.allowDisabled ?? false,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
    };
  }

  async connect(request: {
    connectionId?: string;
    candidate: unknown;
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    return this.#connectCandidate(request);
  }

  async connectUnderAuthorityLease(
    request: {
      connectionId?: string;
      candidate: unknown;
      generation: number;
      deadlineAt: number;
      signal: AbortSignal;
    },
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidate> {
    return this.#connectCandidate(request, lease);
  }

  async #connectCandidate(
    request: {
      connectionId?: string;
      candidate: unknown;
      generation: number;
      deadlineAt: number;
      signal: AbortSignal;
    },
    lease?: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidate> {
    if (typeof request.candidate !== "string") {
      throw new KimiCodeRequestError(invalidResponseFailure());
    }
    let normalized = "";
    try {
      normalized = normalizeProviderSecret(request.candidate);
    } catch {
      throw new KimiCodeRequestError(invalidResponseFailure());
    }
    let connectionId: string;
    if (request.connectionId === undefined) {
      try {
        connectionId = this.#createConnectionId();
      } catch {
        throw new KimiCodeRequestError(offlineFailure());
      }
    } else {
      connectionId = request.connectionId;
    }
    try {
      assertConnectionId(connectionId);
    } catch {
      throw new KimiCodeRequestError(invalidResponseFailure());
    }
    try {
      this.#assertCurrent(request.deadlineAt, request.signal);
      if (!this.#claimGeneration(connectionId, request.generation)) {
        throw new KimiCodeRequestError(offlineFailure());
      }
      await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
      let catalog: readonly KimiCodeModelDefinition[];
      try {
        catalog = await this.#service.inspectModels(normalized, {
          signal: request.signal,
          deadlineAt: request.deadlineAt,
        });
      } catch (error) {
        if (request.signal.aborted) throwIfAborted(request.signal);
        throw new KimiCodeRequestError(
          issuedKimiCodeFailure(error) ?? offlineFailure(),
        );
      }
      await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
      this.#assertCurrent(request.deadlineAt, request.signal);
      if (!this.#isGenerationCurrent(connectionId, request.generation)) {
        throw new KimiCodeRequestError(offlineFailure());
      }
      if (catalog.length === 0) {
        throw new KimiCodeRequestError(invalidResponseFailure());
      }
      const hmacKey = await this.#awaitDependency(
        () => this.#credentials.getOrCreateAccountHmacKey(),
        request.deadlineAt,
        request.signal,
      );
      let accountFingerprint: string;
      try {
        accountFingerprint = this.#fingerprint(hmacKey, normalized);
      } catch {
        throw new KimiCodeRequestError(offlineFailure());
      }
      await this.#assertLeaseCurrent(lease, request.deadlineAt, request.signal);
      this.#assertCurrent(request.deadlineAt, request.signal);
      if (!this.#isGenerationCurrent(connectionId, request.generation)) {
        throw new KimiCodeRequestError(offlineFailure());
      }
      const models = modelsForCatalog(catalog);
      let candidateId: string;
      try {
        candidateId = this.#createCandidateId();
      } catch {
        throw new KimiCodeRequestError(offlineFailure());
      }
      if (typeof candidateId !== "string" || candidateId.length === 0) {
        throw new Error("Kimi Code candidate identifier is invalid.");
      }
      const observedAt = this.#readNow();
      throwIfAborted(request.signal);
      if (
        observedAt >= request.deadlineAt
        || !this.#isGenerationCurrent(connectionId, request.generation)
      ) {
        throw new KimiCodeRequestError(offlineFailure());
      }
      const health = healthy(observedAt, request.generation);
      const metadata: CandidateMetadata = Object.freeze({
        candidateId,
        connectionId,
        accountFingerprint,
        models,
        generation: request.generation,
        deadlineAt: request.deadlineAt,
        health,
      });
      this.#candidates.set(candidateId, metadata);
      return {
        candidateId,
        backendId: "kimi-code",
        connectionId,
        accountFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        health,
      };
    } catch (error) {
      if (error instanceof KimiCodeRequestError) throw error;
      if (request.signal.aborted) throwIfAborted(request.signal);
      throw new KimiCodeRequestError(offlineFailure());
    } finally {
      normalized = "";
    }
  }

  async listModels(request: {
    connectionId?: string;
    candidateId?: string;
    signal: AbortSignal;
  }): Promise<readonly BackendModelDescriptor[]> {
    throwIfAborted(request.signal);
    const candidate = request.candidateId
      ? this.#candidates.get(request.candidateId) ?? null
      : null;
    const active = !candidate && request.connectionId
      ? this.#activeInspections.get(request.connectionId) ?? null
      : null;
    const metadata = candidate ?? active;
    if (!metadata) {
      throw new Error("Kimi Code metadata inspection must succeed before model listing.");
    }
    if (
      metadata.deadlineAt <= this.#readNow()
      || !this.#isGenerationCurrent(metadata.connectionId, metadata.generation)
    ) {
      if (candidate) this.#candidates.delete(candidate.candidateId);
      if (active) this.#activeInspections.delete(active.connectionId);
      throw new KimiCodeRequestError(offlineFailure());
    }
    return metadata.models;
  }

  async activate(request: {
    candidateId: string;
    model: BackendModelDescriptor;
    signal: AbortSignal;
  }): Promise<CandidateProviderState> {
    throwIfAborted(request.signal);
    const candidate = this.#candidates.get(request.candidateId);
    if (!candidate) {
      throw new Error("Kimi Code candidate is unavailable or no longer valid.");
    }
    if (!this.#isGenerationCurrent(candidate.connectionId, candidate.generation)) {
      this.#candidates.delete(request.candidateId);
      throw new KimiCodeRequestError(offlineFailure());
    }
    const selected = candidate.models.find((model) => sameModel(model, request.model));
    if (!selected || request.model.backendId !== "kimi-code") {
      throw new Error("Kimi Code model selection is invalid.");
    }
    const active: ActiveInspectionMetadata = Object.freeze({
      connectionId: candidate.connectionId,
      accountFingerprint: candidate.accountFingerprint,
      models: candidate.models,
      generation: candidate.generation,
      deadlineAt: candidate.deadlineAt,
      health: candidate.health,
    });
    this.#activeInspections.set(candidate.connectionId, active);
    return {
      candidateId: request.candidateId,
      backendId: "kimi-code",
      connectionId: candidate.connectionId,
      accountFingerprint: candidate.accountFingerprint,
      billingRealm: "kimi-code-membership-provider-managed-overage",
      route: {
        version: 1,
        backendId: "kimi-code",
        accountFingerprint: candidate.accountFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        requestedModelId: selected.requestedModelId,
        canonicalModelId: selected.canonicalModelId,
        resolutionState: "resolved",
      },
    };
  }

  reconnect(request: ProviderInspectionRequest): Promise<KimiCodeInspection> {
    return this.inspect({ ...request, purpose: request.purpose ?? "reconnect" });
  }

  async logout(request: { signal: AbortSignal }): Promise<void> {
    throwIfAborted(request.signal);
    this.#candidates.clear();
    this.#activeInspections.clear();
    this.#connectionGenerations.clear();
    this.#inspectionAttempts.clear();
  }

  async discardCandidate(candidateId: string): Promise<void> {
    this.#candidates.delete(candidateId);
  }

  async #inspectSecret(
    secret: string,
    connectionId: string,
    generation: number,
    deadlineAt: number,
    signal: AbortSignal,
    expectedFingerprint: string,
    previous: ActiveInspectionMetadata | null,
  ): Promise<InspectedMetadata> {
    let catalog: readonly KimiCodeModelDefinition[];
    let failure: KimiCodeFailure | null = null;
    try {
      catalog = await this.#service.inspectModels(secret, { signal, deadlineAt });
    } catch (error) {
      catalog = Object.freeze([]);
      failure = issuedKimiCodeFailure(error) ?? offlineFailure();
    }
    this.#assertCurrent(deadlineAt, signal);

    let accountFingerprint: string;
    try {
      const hmacKey = await this.#awaitDependency(
        () => this.#credentials.getOrCreateAccountHmacKey(),
        deadlineAt,
        signal,
      );
      accountFingerprint = this.#fingerprint(hmacKey, secret);
    } catch {
      this.#assertCurrent(deadlineAt, signal);
      return {
        inspection: this.#emptyInspection(
          connectionId,
          generation,
          "kimi-code-account-identity-unavailable",
        ),
        metadata: null,
      };
    }
    this.#assertCurrent(deadlineAt, signal);
    if (accountFingerprint !== expectedFingerprint) {
      return {
        inspection: this.#emptyInspection(
          connectionId,
          generation,
          "kimi-code-credential-stale",
        ),
        metadata: null,
      };
    }

    if (failure) {
      return this.#inspectionFromFailure(
        failure,
        connectionId,
        accountFingerprint,
        generation,
        deadlineAt,
        previous,
      );
    }

    const models = modelsForCatalog(catalog);
    const health = healthy(this.#readNow(), generation);
    const routeEligible = models.length > 0;
    const metadata = routeEligible
      ? Object.freeze({
          connectionId,
          accountFingerprint,
          models,
          generation,
          deadlineAt,
          health,
        })
      : null;
    return {
      inspection: {
        backendId: "kimi-code",
        connectionId,
        health,
        headline: routeEligible ? deriveProviderHeadline(health) : "unknown",
        accountFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        routeEligible,
        retryable: false,
        explanationCode: routeEligible
          ? "kimi-code-ready"
          : "kimi-code-model-catalog-empty",
      },
      metadata,
    };
  }

  #inspectionFromFailure(
    failure: KimiCodeFailure,
    connectionId: string,
    accountFingerprint: string,
    generation: number,
    deadlineAt: number,
    previous: ActiveInspectionMetadata | null,
  ): InspectedMetadata {
    const observedAt = this.#readNow();
    if (
      failure.code === "kimi-code-model-unavailable"
      && failure.unavailableModelId
      && previous
      && previous.accountFingerprint === accountFingerprint
      && previous.deadlineAt > observedAt
      && this.#isGenerationCurrent(connectionId, generation)
    ) {
      const models = Object.freeze(previous.models.filter(
        (model) => model.canonicalModelId !== failure.unavailableModelId,
      ));
      if (models.length > 0) {
        const health = healthy(observedAt, generation);
        const metadata = Object.freeze({
          connectionId,
          accountFingerprint,
          models,
          generation,
          deadlineAt: Math.min(previous.deadlineAt, deadlineAt),
          health,
        });
        return {
          inspection: {
            backendId: "kimi-code",
            connectionId,
            health,
            headline: "ready",
            accountFingerprint,
            billingRealm: "kimi-code-membership-provider-managed-overage",
            routeEligible: true,
            retryable: failure.retryable,
            explanationCode: failure.code,
          },
          metadata,
        };
      }
    }

    const health = healthFromFailure(failure, observedAt, generation);
    return {
      inspection: {
        backendId: "kimi-code",
        connectionId,
        health,
        headline: headlineFromFailure(failure, health),
        accountFingerprint: failure.credential === "rejected" ? null : accountFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        routeEligible: false,
        retryable: failure.retryable,
        explanationCode: failure.code,
      },
      metadata: null,
    };
  }

  #withoutExpiredReusedMetadata(
    inspected: InspectedMetadata,
    observedAt: number,
  ): InspectedMetadata {
    const health: ProviderHealth = Object.freeze({
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "policy-unavailable",
      observedAt,
      generation: inspected.inspection.health.generation,
    });
    return {
      inspection: {
        ...inspected.inspection,
        health,
        headline: deriveProviderHeadline(health),
        routeEligible: false,
      },
      metadata: null,
    };
  }

  #fingerprint(hmacKey: Uint8Array, secret: string): string {
    const fingerprint = this.#accountFingerprint(hmacKey, secret);
    if (!/^acct_kimi_[A-Za-z0-9_-]{43}$/u.test(fingerprint)) {
      throw new Error("Kimi Code account fingerprint is invalid.");
    }
    return fingerprint;
  }

  async #assertLeaseCurrent(
    lease: ProviderAuthorityReadLease | undefined,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!lease) return;
    await this.#awaitDependency(() => lease.assertHeld(), deadlineAt, signal);
  }

  async #awaitDependency<T>(
    operation: () => Promise<T>,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<T> {
    this.#assertCurrent(deadlineAt, signal);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      const remaining = Math.max(0, deadlineAt - this.#readNow());
      const deadline = new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new KimiCodeRequestError(offlineFailure())),
          Math.min(remaining, 0x7fff_ffff),
        );
      });
      const aborted = new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(new KimiCodeRequestError(offlineFailure()));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const dependency = Promise.resolve()
        .then(operation)
        .catch(() => {
          throw new KimiCodeRequestError(offlineFailure());
        });
      const value = await Promise.race([dependency, deadline, aborted]);
      this.#assertCurrent(deadlineAt, signal);
      return value;
    } catch {
      if (signal.aborted) throwIfAborted(signal);
      throw new KimiCodeRequestError(offlineFailure());
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    }
  }

  #claimGeneration(connectionId: string, generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    const current = this.#connectionGenerations.get(connectionId);
    if (current !== undefined && generation < current) return false;
    if (current === undefined || generation > current) {
      this.#connectionGenerations.set(connectionId, generation);
      for (const [candidateId, candidate] of this.#candidates) {
        if (candidate.connectionId === connectionId && candidate.generation !== generation) {
          this.#candidates.delete(candidateId);
        }
      }
    }
    return true;
  }

  #beginInspection(connectionId: string, generation: number): InspectionAttempt | null {
    if (!this.#claimGeneration(connectionId, generation)) return null;
    const token = Symbol("kimi-code-inspection-attempt");
    const previous = this.#activeInspections.get(connectionId) ?? null;
    this.#activeInspections.delete(connectionId);
    this.#inspectionAttempts.set(connectionId, token);
    return { token, previous };
  }

  #isInspectionCurrent(
    connectionId: string,
    generation: number,
    attempt: symbol,
  ): boolean {
    return this.#isGenerationCurrent(connectionId, generation)
      && this.#inspectionAttempts.get(connectionId) === attempt;
  }

  #isGenerationCurrent(connectionId: string, generation: number): boolean {
    return this.#connectionGenerations.get(connectionId) === generation;
  }

  #assertCurrent(deadlineAt: number, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= this.#readNow()) {
      throw new KimiCodeRequestError(offlineFailure());
    }
  }

  #readNow(): number {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw new KimiCodeRequestError(offlineFailure());
    }
    if (!Number.isFinite(now)) throw new KimiCodeRequestError(offlineFailure());
    return now;
  }

  #safeObservedAt(): number {
    try {
      return this.#readNow();
    } catch {
      return 0;
    }
  }

  #emptyInspection(
    connectionId: string,
    generation: number,
    explanationCode: string,
  ): KimiCodeInspection {
    const health: ProviderHealth = {
      credential: "unknown",
      connectivity: "unknown",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: this.#safeObservedAt(),
      generation,
    };
    return {
      backendId: "kimi-code",
      connectionId,
      health,
      headline: "unknown",
      accountFingerprint: null,
      billingRealm: "kimi-code-membership-provider-managed-overage",
      routeEligible: false,
      retryable: true,
      explanationCode,
    };
  }
}

function modelsForCatalog(
  catalog: readonly KimiCodeModelDefinition[],
): readonly BackendModelDescriptor[] {
  return Object.freeze(catalog.map((model) => Object.freeze({
    backendId: "kimi-code" as const,
    requestedModelId: model.id,
    canonicalModelId: model.id,
    displayName: model.displayName,
    capabilities: Object.freeze({
      textInput: true,
      textOutput: true,
      tools: true,
      reasoning: true,
    }),
  })));
}

function validKimiCredentialContext(
  context: ProviderCredentialUseContext,
  connectionId: string,
): boolean {
  const binding = context.binding;
  return context.source === "saved"
    && binding.version === 2
    && binding.connectionId === connectionId
    && binding.backendId === "kimi-code"
    && binding.billingRealm === "kimi-code-membership-provider-managed-overage"
    && binding.credentialPointer.kind === "versioned"
    && binding.credentialPointer.slot.kind === "kimi-code";
}

function healthy(now: number, generation: number): ProviderHealth {
  return Object.freeze({
    credential: "valid",
    connectivity: "connected",
    spend: "unknown",
    runtime: "not-applicable",
    observedAt: now,
    generation,
  });
}

function healthFromFailure(
  failure: KimiCodeFailure,
  now: number,
  generation: number,
): ProviderHealth {
  const runtime = failure.code === "kimi-code-model-unavailable"
    || failure.code === "kimi-code-access-terminated"
    ? "policy-unavailable" as const
    : "not-applicable" as const;
  return {
    credential: failure.credential,
    connectivity: failure.connectivity,
    spend: failure.spend,
    runtime,
    observedAt: now,
    generation,
  };
}

function headlineFromFailure(
  failure: KimiCodeFailure,
  health: ProviderHealth,
): ReturnType<typeof deriveProviderHeadline> {
  switch (failure.code) {
    case "kimi-code-membership-unavailable":
    case "kimi-code-overloaded":
    case "kimi-code-invalid-response":
    case "kimi-code-cancelled":
      return "unknown";
    case "kimi-code-auth-rejected":
    case "kimi-code-model-unavailable":
    case "kimi-code-access-terminated":
    case "kimi-code-limit-reached":
    case "kimi-code-offline":
      return deriveProviderHeadline(health);
  }
}

function explanationForCredentialAccess(
  result: Exclude<ProviderCredentialAccessResult<unknown>, { kind: "available" }>,
): string {
  if (result.kind === "forget-pending") return "kimi-code-credential-forget-pending";
  if (result.kind === "invalid-pointer") return "kimi-code-credential-invalid-pointer";
  if (result.kind === "stale") return "kimi-code-credential-stale";
  if (result.kind === "disabled") return "kimi-code-credential-disabled";
  if (result.kind === "recovery-required") return "kimi-code-recovery-required";
  return "kimi-code-credential-unavailable";
}

function sameModel(left: BackendModelDescriptor, right: BackendModelDescriptor): boolean {
  return left.backendId === right.backendId
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.displayName === right.displayName
    && left.capabilities.textInput === right.capabilities.textInput
    && left.capabilities.textOutput === right.capabilities.textOutput
    && left.capabilities.tools === right.capabilities.tools
    && left.capabilities.reasoning === right.capabilities.reasoning;
}

function assertConnectionId(connectionId: string): void {
  if (
    connectionId.length === 0
    || connectionId.length > 256
    || /[\0-\x1f\x7f]/u.test(connectionId)
  ) {
    throw new Error("Kimi Code connection identifier is invalid.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new KimiCodeRequestError(Object.freeze({
      code: "kimi-code-cancelled",
      retryable: false,
      credential: "unknown",
      connectivity: "unknown",
      spend: "unknown",
    }));
  }
}

function invalidResponseFailure(): KimiCodeFailure {
  return Object.freeze({
    code: "kimi-code-invalid-response",
    retryable: false,
    credential: "unknown",
    connectivity: "unknown",
    spend: "unknown",
  });
}

function offlineFailure(): KimiCodeFailure {
  return Object.freeze({
    code: "kimi-code-offline",
    retryable: true,
    credential: "unknown",
    connectivity: "offline",
    spend: "unknown",
  });
}
