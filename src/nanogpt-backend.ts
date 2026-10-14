import { randomUUID } from "node:crypto";
import { deriveProviderHeadline, type BackendAdapter, type BackendDescriptor, type BackendModelDescriptor, type CandidateProviderState, type ProviderCandidate, type ProviderHealth, type ProviderInspection, type ProviderInspectionRequest } from "./backends.js";
import { normalizeProviderSecret } from "./credentials.js";
import { NanoGptRequestError, NanoGptService, issuedNanoGptFailure, nanoGptAccountFingerprint, nanoGptBillingRealm, type NanoGptBillingMode, type NanoGptFailure, type NanoGptModel } from "./nanogpt.js";
import type { ProviderAuthorityReadLease, ProviderCredentialAuthorityLike, ProviderCredentialUseContext } from "./provider-authority.js";

export const NANO_GPT_DESCRIPTOR: BackendDescriptor = Object.freeze({ id: "nano-gpt", displayName: "Nano-GPT", maturity: "preview", connectable: true, kind: "raw-model", credentialOwner: "orcode-keychain", billingRealmKind: "provider-managed", capabilities: Object.freeze({ models: true, tools: true, reasoning: true }) });
export interface NanoGptIdentityStore { getOrCreateAccountHmacKey(): Promise<Uint8Array> }
export interface NanoGptBackendAdapterOptions {
  service: NanoGptService;
  credentials: NanoGptIdentityStore;
  credentialAuthority: ProviderCredentialAuthorityLike;
  now?: () => number;
  createCandidateId?: () => string;
  createConnectionId?: () => string;
  accountFingerprint?: (key: Uint8Array, secret: string) => string;
}
export interface NanoGptCandidateInput { apiKey: string; billingMode: NanoGptBillingMode }
type ConnectRequest = Parameters<BackendAdapter["connect"]>[0];
interface Metadata {
  readonly connectionId: string;
  readonly accountFingerprint: string;
  readonly billingMode: NanoGptBillingMode;
  readonly models: readonly BackendModelDescriptor[];
  readonly generation: number;
  readonly deadlineAt: number;
  readonly health: ProviderHealth;
}

/** Retains only metadata. Candidate secrets remain owned by transactional activation. */
export class NanoGptBackendAdapter implements BackendAdapter {
  readonly backendId = "nano-gpt" as const;
  readonly #options: NanoGptBackendAdapterOptions;
  readonly #now: () => number;
  readonly #candidates = new Map<string, Metadata>();
  readonly #active = new Map<string, Metadata>();
  readonly #generations = new Map<string, number>();
  readonly #attempts = new Map<string, symbol>();
  constructor(options: NanoGptBackendAdapterOptions) { this.#options = options; this.#now = options.now ?? Date.now; }

  async inspect(request: ProviderInspectionRequest): Promise<ProviderInspection> { return this.#inspect(request); }
  async inspectUnderAuthorityLease(request: ProviderInspectionRequest, lease: ProviderAuthorityReadLease): Promise<ProviderInspection> { return this.#inspect(request, lease); }
  async #inspect(request: ProviderInspectionRequest, lease?: ProviderAuthorityReadLease): Promise<ProviderInspection> {
    if (!this.#claim(request.connectionId, request.generation)) return this.#empty(request, "nanogpt-inspection-stale");
    const token = Symbol("nano-inspection");
    this.#attempts.set(request.connectionId, token);
    this.#active.delete(request.connectionId);
    const current = () => this.#generations.get(request.connectionId) === request.generation && this.#attempts.get(request.connectionId) === token;
    if (request.environmentEligibility !== undefined && request.environmentEligibility !== "forbidden") return this.#empty(request, "nanogpt-credential-unavailable");
    if (lease && !this.#options.credentialAuthority.withCredentialUnderLease) return this.#empty(request, "nanogpt-credential-unavailable");
    let billingMode: NanoGptBillingMode | undefined;
    let accountFingerprint: string | undefined;
    try {
      this.#assert(request);
      await this.#lease(lease, request);
      const credentialRequest = { backendId: "nano-gpt" as const, connectionId: request.connectionId, credentialKind: "inference" as const, purpose: request.purpose ?? "startup-inspect", environmentEligibility: "forbidden" as const, allowDisabled: request.allowDisabled ?? false, deadlineAt: request.deadlineAt, signal: request.signal };
      const use = async (secret: string, context: ProviderCredentialUseContext): Promise<ProviderInspection> => {
        if (!current()) return this.#empty(request, "nanogpt-inspection-stale");
        this.#assert(request);
        billingMode = boundMode(context, request.connectionId) ?? undefined;
        if (!billingMode) return this.#empty(request, "nanogpt-credential-unavailable");
        await this.#lease(lease, request);
        const normalized = normalizeProviderSecret(secret);
        accountFingerprint = await this.#fingerprint(normalized, request);
        if (accountFingerprint !== context.binding.accountFingerprint) return this.#empty(request, "nanogpt-credential-stale", billingMode);
        const result = await this.#wait(() => this.#options.service.inspect(normalized, billingMode!, request), request);
        await this.#lease(lease, request);
        this.#assert(request);
        const metadata: Metadata = Object.freeze({ connectionId: request.connectionId, generation: request.generation, deadlineAt: request.deadlineAt, accountFingerprint, billingMode, models: descriptors(result.models), health: this.#health(request.generation, result.spend) });
        let published = false;
        await this.#wait(() => context.publishIfCurrent(() => {
          this.#assert(request);
          if (!current()) return;
          if (metadata.models.length > 0) this.#active.set(request.connectionId, metadata);
          published = true;
        }), request);
        if (!published || !current()) return this.#empty(request, "nanogpt-inspection-stale", billingMode);
        return this.#inspection(metadata);
      };
      const selected = await this.#wait(() => lease ? this.#options.credentialAuthority.withCredentialUnderLease!(credentialRequest, lease, use) : this.#options.credentialAuthority.withCredential(credentialRequest, use), request);
      await this.#lease(lease, request);
      this.#assert(request);
      if (!current()) return this.#empty(request, "nanogpt-inspection-stale", billingMode);
      if (selected.kind !== "available") return this.#empty(request, `nanogpt-credential-${selected.kind}`, billingMode);
      return selected.value;
    } catch (failure) {
      if (current()) {
        this.#active.delete(request.connectionId);
        this.#attempts.delete(request.connectionId);
      }
      const trusted = issuedNanoGptFailure(failure);
      if (request.signal.aborted) throw new NanoGptRequestError("nanogpt-cancelled");
      if (trusted && billingMode) return this.#failed(request, billingMode, accountFingerprint, trusted);
      return this.#empty(request, "nanogpt-recovery-required", billingMode);
    }
  }

  async connect(request: ConnectRequest): Promise<ProviderCandidate> { return this.#connect(request); }
  async connectUnderAuthorityLease(request: ConnectRequest, lease: ProviderAuthorityReadLease): Promise<ProviderCandidate> { return this.#connect(request, lease); }
  async #connect(request: ConnectRequest, lease?: ProviderAuthorityReadLease): Promise<ProviderCandidate> {
    let normalized = "";
    try {
      const value = request.candidate;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NanoGptRequestError("nanogpt-invalid-response");
      const input = value as Partial<NanoGptCandidateInput>;
      if (typeof input.apiKey !== "string" || (input.billingMode !== "subscription" && input.billingMode !== "payg")) throw new NanoGptRequestError("nanogpt-invalid-response");
      normalized = normalizeProviderSecret(input.apiKey);
      this.#assert(request);
      const connectionId = request.connectionId ?? (this.#options.createConnectionId ?? randomUUID)();
      if (!validIdentifier(connectionId) || !this.#claim(connectionId, request.generation)) throw new NanoGptRequestError("nanogpt-invalid-response");
      const attempt = Symbol("nano-connect");
      this.#attempts.set(connectionId, attempt);
      const current = () => this.#generations.get(connectionId) === request.generation && this.#attempts.get(connectionId) === attempt;
      await this.#lease(lease, request);
      const result = await this.#wait(() => this.#options.service.inspect(normalized, input.billingMode!, request), request);
      await this.#lease(lease, request);
      const accountFingerprint = await this.#fingerprint(normalized, request);
      await this.#lease(lease, request);
      this.#assert(request);
      if (!current() || result.models.length === 0) throw new NanoGptRequestError("nanogpt-invalid-response");
      const candidateId = (this.#options.createCandidateId ?? randomUUID)();
      if (!validIdentifier(candidateId) || this.#candidates.has(candidateId)) throw new NanoGptRequestError("nanogpt-invalid-response");
      const metadata: Metadata = Object.freeze({ connectionId, accountFingerprint, billingMode: input.billingMode!, models: descriptors(result.models), generation: request.generation, deadlineAt: request.deadlineAt, health: this.#health(request.generation, result.spend) });
      this.#assert(request);
      if (!current()) throw new NanoGptRequestError("nanogpt-offline");
      this.#candidates.set(candidateId, metadata);
      return { candidateId, backendId: "nano-gpt", connectionId, accountFingerprint, billingRealm: nanoGptBillingRealm(metadata.billingMode), health: metadata.health };
    } catch (failure) {
      if (request.signal.aborted) throw new NanoGptRequestError("nanogpt-cancelled");
      // Never rethrow dependency errors, including decorated provider-error lookalikes.
      throw new NanoGptRequestError(issuedNanoGptFailure(failure)?.code ?? (failure instanceof NanoGptRequestError ? failure.failure.code : "nanogpt-offline"));
    } finally { normalized = ""; }
  }

  async listModels(request: { connectionId?: string; candidateId?: string; signal: AbortSignal }): Promise<readonly BackendModelDescriptor[]> {
    if (request.signal.aborted) throw new NanoGptRequestError("nanogpt-cancelled");
    const metadata = request.candidateId ? this.#candidates.get(request.candidateId) : request.connectionId ? this.#active.get(request.connectionId) : undefined;
    if (!metadata || !this.#metadataCurrent(metadata)) throw new NanoGptRequestError("nanogpt-model-unavailable");
    return metadata.models;
  }
  async activate(request: { candidateId: string; model: BackendModelDescriptor; signal: AbortSignal }): Promise<CandidateProviderState> {
    if (request.signal.aborted) throw new NanoGptRequestError("nanogpt-cancelled");
    const metadata = this.#candidates.get(request.candidateId);
    if (!metadata || !this.#metadataCurrent(metadata)) throw new NanoGptRequestError("nanogpt-model-unavailable");
    const model = metadata.models.find((item) => sameModel(item, request.model));
    if (!model) throw new NanoGptRequestError("nanogpt-model-unavailable");
    this.#active.set(metadata.connectionId, metadata);
    const billingRealm = nanoGptBillingRealm(metadata.billingMode);
    return { candidateId: request.candidateId, backendId: "nano-gpt", connectionId: metadata.connectionId, accountFingerprint: metadata.accountFingerprint, billingRealm, route: { version: 1, backendId: "nano-gpt", accountFingerprint: metadata.accountFingerprint, billingRealm, requestedModelId: model.requestedModelId, canonicalModelId: model.canonicalModelId, resolutionState: "resolved" } };
  }
  reconnect(request: ProviderInspectionRequest): Promise<ProviderInspection> { return this.inspect({ ...request, purpose: request.purpose ?? "reconnect" }); }
  async logout(request: { signal: AbortSignal }): Promise<void> { if (request.signal.aborted) throw new NanoGptRequestError("nanogpt-cancelled"); this.#candidates.clear(); this.#active.clear(); this.#generations.clear(); this.#attempts.clear(); }
  async discardCandidate(candidateId: string): Promise<void> { this.#candidates.delete(candidateId); }

  #claim(connectionId: string, generation: number): boolean {
    if (!validIdentifier(connectionId) || !Number.isSafeInteger(generation) || generation < 0) return false;
    const existing = this.#generations.get(connectionId);
    if (existing !== undefined && existing > generation) return false;
    this.#generations.set(connectionId, generation);
    if (existing !== generation) {
      this.#active.delete(connectionId);
      for (const [id, metadata] of this.#candidates) if (metadata.connectionId === connectionId) this.#candidates.delete(id);
    }
    return true;
  }
  #metadataCurrent(metadata: Metadata): boolean { return this.#generations.get(metadata.connectionId) === metadata.generation && this.#readNow() < metadata.deadlineAt; }
  async #fingerprint(secret: string, request: { signal: AbortSignal; deadlineAt: number }): Promise<string> {
    const key = await this.#wait(() => this.#options.credentials.getOrCreateAccountHmacKey(), request);
    const fingerprint = (this.#options.accountFingerprint ?? nanoGptAccountFingerprint)(key, secret);
    if (!/^acct_nano_[A-Za-z0-9_-]{43}$/u.test(fingerprint)) throw new NanoGptRequestError("nanogpt-invalid-response");
    return fingerprint;
  }
  async #lease(lease: ProviderAuthorityReadLease | undefined, request: { signal: AbortSignal; deadlineAt: number }): Promise<void> { if (lease) await this.#wait(() => lease.assertHeld(), request); }
  async #wait<T>(operation: () => Promise<T>, request: { signal: AbortSignal; deadlineAt: number }): Promise<T> {
    this.#assert(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new NanoGptRequestError("nanogpt-cancelled")); timer = setTimeout(abort, Math.min(request.deadlineAt - this.#readNow(), 0x7fff_ffff)); request.signal.addEventListener("abort", abort, { once: true }); if (request.signal.aborted) abort(); });
      const value = await Promise.race([Promise.resolve().then(operation), cancelled]);
      this.#assert(request);
      return value;
    } finally { if (timer !== undefined) clearTimeout(timer); if (abort) request.signal.removeEventListener("abort", abort); }
  }
  #assert(request: { signal: AbortSignal; deadlineAt: number }): void { if (request.signal.aborted || !Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#readNow()) throw new NanoGptRequestError("nanogpt-cancelled"); }
  #readNow(): number { try { const now = this.#now(); if (Number.isFinite(now)) return now; } catch {} throw new NanoGptRequestError("nanogpt-offline"); }
  #health(generation: number, spend: ProviderHealth["spend"]): ProviderHealth { return Object.freeze({ credential: "valid", connectivity: "connected", spend, runtime: "not-applicable", observedAt: this.#readNow(), generation }); }
  #inspection(metadata: Metadata): ProviderInspection { const eligible = metadata.models.length > 0; return { backendId: "nano-gpt", connectionId: metadata.connectionId, health: metadata.health, headline: eligible ? deriveProviderHeadline(metadata.health) : "unknown", accountFingerprint: metadata.accountFingerprint, billingRealm: nanoGptBillingRealm(metadata.billingMode), routeEligible: eligible, retryable: false, explanationCode: eligible ? "nanogpt-ready" : "nanogpt-model-catalog-empty" }; }
  #empty(request: ProviderInspectionRequest, explanationCode: string, mode?: NanoGptBillingMode): ProviderInspection {
    let now = 0; try { now = this.#readNow(); } catch {}
    return { backendId: "nano-gpt", connectionId: request.connectionId, health: { credential: "unknown", connectivity: "unknown", spend: "unknown", runtime: "not-applicable", observedAt: now, generation: request.generation }, headline: "unknown", accountFingerprint: null, billingRealm: mode ? nanoGptBillingRealm(mode) : "none", routeEligible: false, retryable: true, explanationCode };
  }
  #failed(request: ProviderInspectionRequest, mode: NanoGptBillingMode, fingerprint: string | undefined, failure: NanoGptFailure): ProviderInspection {
    const health: ProviderHealth = { credential: failure.credential, connectivity: failure.connectivity, spend: failure.spend, runtime: failure.code === "nanogpt-subscription-policy-unsafe" || failure.code === "nanogpt-billing-unavailable" ? "policy-unavailable" : "not-applicable", observedAt: this.#readNow(), generation: request.generation };
    return { backendId: "nano-gpt", connectionId: request.connectionId, health, headline: deriveProviderHeadline(health), accountFingerprint: failure.credential === "rejected" ? null : fingerprint ?? null, billingRealm: nanoGptBillingRealm(mode), routeEligible: false, retryable: failure.retryable, explanationCode: failure.code };
  }
}
function validIdentifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/u.test(value); }
function boundMode(context: ProviderCredentialUseContext, connectionId: string): NanoGptBillingMode | null {
  const binding = context.binding;
  if (context.source !== "saved" || binding.version !== 2 || binding.connectionId !== connectionId || binding.backendId !== "nano-gpt" || binding.credentialPointer.kind !== "versioned" || binding.credentialPointer.slot.kind !== "nano-gpt") return null;
  return binding.billingRealm === "nanogpt-subscription" ? "subscription" : binding.billingRealm === "nanogpt-payg" ? "payg" : null;
}
function descriptors(models: readonly NanoGptModel[]): readonly BackendModelDescriptor[] { return Object.freeze(models.map((model) => Object.freeze({ backendId: "nano-gpt" as const, requestedModelId: model.id, canonicalModelId: model.id, displayName: model.name, capabilities: Object.freeze({ textInput: true, textOutput: true, tools: model.tools, reasoning: model.reasoning }) }))); }
function sameModel(left: BackendModelDescriptor, right: BackendModelDescriptor): boolean { return left.backendId === right.backendId && left.requestedModelId === right.requestedModelId && left.canonicalModelId === right.canonicalModelId && left.displayName === right.displayName && left.capabilities.textInput === right.capabilities.textInput && left.capabilities.textOutput === right.capabilities.textOutput && left.capabilities.tools === right.capabilities.tools && left.capabilities.reasoning === right.capabilities.reasoning; }
