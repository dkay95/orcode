import { createHmac, randomBytes } from "node:crypto";
import {
  normalizeProviderSecret,
  type CredentialKind,
  type CredentialSlotKind,
  type CredentialSlotRef,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import type {
  ProviderConnectionStateV1,
  ProviderSetupStateV2,
  ProviderStateStore,
} from "./provider-state.js";
import type { BackendId, RouteIdentityV1 } from "./backends.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CredentialAccessPurpose =
  | "startup-inspect"
  | "reconnect"
  | "runtime-bind"
  | "explicit-enable"
  | "explicit-repair";

export type EnvironmentEligibility =
  | "forbidden"
  | "automatic-if-no-saved"
  | "explicit-repair";

export type ProviderCredentialPointer =
  | { kind: "legacy"; id: "legacy:inference" }
  | { kind: "versioned"; slot: CredentialSlotRef };

/** @deprecated Use ProviderCredentialPointer for backend-aware code. */
export type OpenRouterCredentialPointer = ProviderCredentialPointer;

export interface ProviderCredentialPolicy {
  backendId: "openrouter" | "kimi-code";
  savedSlotKinds: readonly CredentialSlotKind[];
  legacyInferenceAllowed: boolean;
  environmentVariable: "OPENROUTER_API_KEY" | null;
  billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage";
  accountIdentity: "documented-provider-account" | "normalized-secret-hmac";
  secretFingerprintDomain: "orcode-kimi-code-credential/v1\0" | null;
}

const PROVIDER_CREDENTIAL_POLICIES = {
  openrouter: Object.freeze({
    backendId: "openrouter",
    savedSlotKinds: Object.freeze(["inference"] as const),
    legacyInferenceAllowed: true,
    environmentVariable: "OPENROUTER_API_KEY",
    billingRealm: "openrouter-payg",
    accountIdentity: "documented-provider-account",
    secretFingerprintDomain: null,
  }),
  "kimi-code": Object.freeze({
    backendId: "kimi-code",
    savedSlotKinds: Object.freeze(["kimi-code"] as const),
    legacyInferenceAllowed: false,
    environmentVariable: null,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    accountIdentity: "normalized-secret-hmac",
    secretFingerprintDomain: "orcode-kimi-code-credential/v1\0",
  }),
} as const satisfies Readonly<Record<ProviderCredentialPolicy["backendId"], ProviderCredentialPolicy>>;

export function providerCredentialPolicy(
  backendId: BackendId,
): ProviderCredentialPolicy | null {
  return PROVIDER_CREDENTIAL_POLICIES[backendId as ProviderCredentialPolicy["backendId"]] ?? null;
}

export interface ProviderConnectionBindingV1 {
  version: 1;
  stateRevision: number;
  connectionId: string;
  backendId: "openrouter";
  enabled: boolean;
  credentialPointer: OpenRouterCredentialPointer;
  accountFingerprint: string;
  billingRealm: "openrouter-payg";
  isDefault: boolean;
}

export interface ProviderConnectionBindingV2 {
  version: 2;
  stateRevision: number;
  connectionId: string;
  backendId: "openrouter" | "kimi-code";
  enabled: boolean;
  credentialPointer: ProviderCredentialPointer;
  accountFingerprint: string;
  billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage";
  isDefault: boolean;
}

export type ProviderBindingSelection =
  | { kind: "exact"; binding: ProviderConnectionBindingV2 }
  | { kind: "none" }
  | { kind: "disabled" }
  | { kind: "ambiguous" }
  | { kind: "invalid-pointer" }
  | { kind: "forget-pending" }
  | { kind: "recovery-required" };

export type ProviderCredentialAccessResult<T> =
  | { kind: "available"; value: T }
  | { kind: Exclude<ProviderBindingSelection["kind"], "exact"> }
  | { kind: "absent" | "invalid" | "stale" };

export interface ProviderAuthorityReadLease {
  assertHeld(): Promise<void>;
}

export interface ProviderAuthorityCoordinator {
  readAuthority<T>(
    request: { signal: AbortSignal },
    operation: (lease: ProviderAuthorityReadLease) => Promise<T>,
  ): Promise<T>;
}

export interface ProviderCredentialRequest {
  backendId: "openrouter" | "kimi-code";
  connectionId: string;
  credentialKind?: CredentialKind;
  purpose: CredentialAccessPurpose;
  environmentEligibility: EnvironmentEligibility;
  allowDisabled?: boolean;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ProviderCredentialUseContext {
  source: "saved" | "environment";
  binding: ProviderConnectionBindingV2;
  candidatePermit: ProviderCandidateCredentialPermit;
  publishIfCurrent(publish: () => void): Promise<void>;
}

export interface ProviderCandidateCredentialPermit {
  readonly version: 1;
}

export interface ProviderCandidatePreflightRequest {
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ProviderCandidateAuthorityRequest extends ProviderCandidatePreflightRequest {
  credentialPermit?: ProviderCandidateCredentialPermit | null;
  requireCredentialPermit?: boolean;
}

export interface ProviderCandidateSnapshotAuthorityRequest
  extends ProviderCandidateAuthorityRequest {
  candidate: string;
  authoritativeState: ProviderSetupStateV2;
}

export type ProviderCandidatePreflightResult =
  | { kind: "ready" }
  | { kind: "forget-pending" | "recovery-required" | "stale" };

export interface ProviderCandidateAuthorityLease extends ProviderAuthorityReadLease {
  assertCurrent(): Promise<void>;
}

export type ProviderCandidateAuthorityResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "forget-pending" | "recovery-required" | "stale" };

export interface ProviderCredentialAuthorityLike {
  environmentCandidatePermit?(
    candidate: string,
  ): ProviderCandidateCredentialPermit | null;
  preflightCandidate?(
    request: ProviderCandidatePreflightRequest,
  ): Promise<ProviderCandidatePreflightResult>;
  withCandidateAuthority?<T>(
    request: ProviderCandidateAuthorityRequest,
    use: (lease: ProviderCandidateAuthorityLease) => Promise<T>,
  ): Promise<ProviderCandidateAuthorityResult<T>>;
  validateCandidatePermitUnderLease?(
    request: ProviderCandidateAuthorityRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidatePreflightResult>;
  validateCandidatePermitAgainstSnapshotUnderLease?(
    request: ProviderCandidateSnapshotAuthorityRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidatePreflightResult>;
  withCredential<T>(
    request: ProviderCredentialRequest,
    use: (secret: string, context: ProviderCredentialUseContext) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>>;
  withCredentialUnderLease?<T>(
    request: ProviderCredentialRequest,
    lease: ProviderAuthorityReadLease,
    use: (secret: string, context: ProviderCredentialUseContext) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>>;
}

export interface ProviderCredentialAuthorityOptions {
  stateStore: ProviderStateStore;
  credentials: VersionedCredentialStoreLike;
  environment?: Readonly<Record<string, string | undefined>>;
  coordinator: () => ProviderAuthorityCoordinator;
  now?: () => number;
}

export type ProviderBindingSelector =
  | { kind: "connection"; connectionId: string }
  | { kind: "route"; route: RouteIdentityV1 }
  | { kind: "default" }
  | { kind: "backend"; backendId: "openrouter" | "kimi-code" };

interface CredentialPermit {
  binding: ProviderConnectionBindingV2;
  secret: string;
  source: "saved" | "environment";
}

interface CandidateCredentialProof {
  source: "saved" | "environment";
  binding: ProviderConnectionBindingV2 | null;
  stateRevision: number;
  fingerprint: string;
}

/**
 * Single process authority for mapping durable provider bindings to callback-
 * scoped credentials. Secrets are never returned from this API.
 */
export class ProviderCredentialAuthority implements ProviderCredentialAuthorityLike {
  readonly #stateStore: ProviderStateStore;
  readonly #credentials: VersionedCredentialStoreLike;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #coordinator: () => ProviderAuthorityCoordinator;
  readonly #now: () => number;
  readonly #candidateFingerprintKey = randomBytes(32);
  readonly #candidatePermits = new WeakMap<
    ProviderCandidateCredentialPermit,
    CandidateCredentialProof
  >();
  #automaticEnvironmentRevoked = false;

  constructor(options: ProviderCredentialAuthorityOptions) {
    this.#stateStore = options.stateStore;
    this.#credentials = options.credentials;
    this.#environment = options.environment ?? process.env;
    this.#coordinator = options.coordinator;
    this.#now = options.now ?? Date.now;
  }

  revokeAutomaticEnvironment(): void {
    this.#automaticEnvironmentRevoked = true;
  }

  environmentCandidatePermit(candidate: string): ProviderCandidateCredentialPermit | null {
    let expected: string;
    let current: string;
    try {
      expected = normalizeProviderSecret(candidate);
      current = normalizeProviderSecret(this.#environment.OPENROUTER_API_KEY ?? "");
    } catch {
      return null;
    }
    if (expected !== current) return null;
    return this.#issueCandidatePermit({
      source: "environment",
      binding: null,
      stateRevision: this.#stateStore.read().revision,
      fingerprint: this.#candidateFingerprint(expected),
    });
  }

  select(
    selector: ProviderBindingSelector,
    options: { allowDisabled?: boolean } = {},
  ): ProviderBindingSelection {
    return selectProviderBinding(
      this.#stateStore.read(),
      selector,
      options.allowDisabled ?? false,
    );
  }

  async preflightCandidate(
    request: ProviderCandidatePreflightRequest,
  ): Promise<ProviderCandidatePreflightResult> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    try {
      await this.#coordinator().readAuthority({ signal: request.signal }, async (lease) => {
        await this.#bounded(request, () => lease.assertHeld());
      });
      return { kind: "ready" };
    } catch (error) {
      return this.#preflightFailure(request, error);
    }
  }

  async withCandidateAuthority<T>(
    request: ProviderCandidateAuthorityRequest,
    use: (lease: ProviderCandidateAuthorityLease) => Promise<T>,
  ): Promise<ProviderCandidateAuthorityResult<T>> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    const credentialProof = request.credentialPermit
      ? this.#candidatePermits.get(request.credentialPermit)
      : undefined;
    if ((request.requireCredentialPermit || request.credentialPermit) && !credentialProof) {
      return { kind: "stale" };
    }
    try {
      const value = await this.#coordinator().readAuthority(
        { signal: request.signal },
        async (providerLease) => {
          let candidateAuthorityOpen = true;
          const assertCurrent = async () => {
            if (!candidateAuthorityOpen) throw new ProviderAuthorityDeadlineError();
            await this.#bounded(request, () => providerLease.assertHeld());
            if (credentialProof) {
              await this.#assertCandidateCredentialCurrent(
                request,
                providerLease,
                credentialProof,
              );
            }
            if (!candidateAuthorityOpen) throw new ProviderAuthorityDeadlineError();
          };
          const lease: ProviderCandidateAuthorityLease = {
            assertHeld: assertCurrent,
            assertCurrent,
          };
          try {
            await lease.assertCurrent();
            const result = await this.#bounded(request, () => use(lease));
            await lease.assertCurrent();
            return result;
          } finally {
            candidateAuthorityOpen = false;
          }
        },
      );
      return { kind: "ready", value };
    } catch (error) {
      return this.#preflightFailure(request, error);
    }
  }

  /**
   * Revalidates an opaque candidate proof while activation already owns the
   * provider lease. This deliberately never reacquires provider authority.
   */
  async validateCandidatePermitUnderLease(
    request: ProviderCandidateAuthorityRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidatePreflightResult> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    const credentialProof = request.credentialPermit
      ? this.#candidatePermits.get(request.credentialPermit)
      : undefined;
    if ((request.requireCredentialPermit || request.credentialPermit) && !credentialProof) {
      return { kind: "stale" };
    }
    try {
      await this.#bounded(request, () => lease.assertHeld());
      if (credentialProof) {
        await this.#assertCandidateCredentialCurrent(request, lease, credentialProof);
      }
      await this.#bounded(request, () => lease.assertHeld());
      return { kind: "ready" };
    } catch (error) {
      return this.#preflightFailure(request, error);
    }
  }

  /**
   * Revalidates an opaque candidate proof against an authoritative config
   * snapshot while the caller already owns Runtime -> Provider -> Config.
   * This path must never reacquire provider or config ownership.
   */
  async validateCandidatePermitAgainstSnapshotUnderLease(
    request: ProviderCandidateSnapshotAuthorityRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidatePreflightResult> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    const credentialProof = request.credentialPermit
      ? this.#candidatePermits.get(request.credentialPermit)
      : undefined;
    if ((request.requireCredentialPermit || request.credentialPermit) && !credentialProof) {
      return { kind: "stale" };
    }
    try {
      await this.#bounded(request, () => lease.assertHeld());
      if (credentialProof) {
        await this.#assertCandidateCredentialMatchesSnapshot(request, credentialProof);
      }
      await this.#bounded(request, () => lease.assertHeld());
      return { kind: "ready" };
    } catch (error) {
      return this.#preflightFailure(request, error);
    }
  }

  async withCredential<T>(
    request: ProviderCredentialRequest,
    use: (secret: string, context: ProviderCredentialUseContext) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    let permit: CredentialPermit | ProviderCredentialAccessResult<never> | null = null;
    try {
      await this.#coordinator().readAuthority({ signal: request.signal }, async (lease) => {
        permit = await this.#readPermitUnderLease(request, lease);
      });
    } catch (error) {
      return this.#authorityFailure(request, error);
    }
    return this.#usePermit(request, permit, use);
  }

  async withCredentialUnderLease<T>(
    request: ProviderCredentialRequest,
    lease: ProviderAuthorityReadLease,
    use: (secret: string, context: ProviderCredentialUseContext) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    let permit: CredentialPermit | ProviderCredentialAccessResult<never>;
    try {
      permit = await this.#readPermitUnderLease(request, lease);
      await this.#bounded(request, () => lease.assertHeld());
    } catch (error) {
      return this.#authorityFailure(request, error);
    }
    return this.#usePermit(request, permit, use, lease);
  }

  async #readPermitUnderLease(
    request: ProviderCredentialRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    await this.#bounded(request, () => lease.assertHeld());
    const before = await this.#readAuthoritativeState(request);
    const selected = selectProviderBinding(
      before,
      { kind: "connection", connectionId: request.connectionId },
      request.allowDisabled ?? false,
    );
    if (selected.kind !== "exact") {
      return { kind: selected.kind } as ProviderCredentialAccessResult<never>;
    }
    const binding = selected.binding;
    if (binding.backendId !== request.backendId) return { kind: "stale" };
    if (request.credentialKind === "management" && binding.backendId !== "openrouter") {
      return { kind: "invalid-pointer" };
    }
    let permit = request.credentialKind === "management"
      ? await this.#readManagementPermit(request, binding, before)
      : await this.#readInferencePermit(request, binding, before);
    await this.#bounded(request, () => lease.assertHeld());
    if ("secret" in permit) {
      const after = selectProviderBinding(
        await this.#readAuthoritativeState(request),
        { kind: "connection", connectionId: request.connectionId },
        request.allowDisabled ?? false,
      );
      if (after.kind !== "exact" || !sameBinding(binding, after.binding)) {
        permit = { kind: "stale" };
      }
    }
    return permit;
  }

  async #usePermit<T>(
    request: ProviderCredentialRequest,
    permit: CredentialPermit | ProviderCredentialAccessResult<never> | null,
    use: (secret: string, context: ProviderCredentialUseContext) => Promise<T>,
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<ProviderCredentialAccessResult<T>> {
    const resolvedPermit = permit;
    if (!resolvedPermit || !("secret" in resolvedPermit)) {
      return resolvedPermit ?? { kind: "recovery-required" };
    }
    throwIfAborted(request.signal);
    if (request.deadlineAt <= this.#now()) return { kind: "stale" };
    const { binding, source } = resolvedPermit;
    let secret: string | null = resolvedPermit.secret;
    if (secret === null) return { kind: "stale" };
    const candidatePermit = this.#issueCandidatePermit({
      source,
      binding: structuredClone(binding),
      stateRevision: binding.stateRevision,
      fingerprint: this.#candidateFingerprint(secret),
    });
    const publishIfCurrent = async (publish: () => void): Promise<void> => {
      const expectedSecret = secret;
      if (expectedSecret === null) throw new ProviderAuthorityStaleError();
      await this.#publishIfCurrent(
        request,
        { binding, source, secret: expectedSecret },
        publish,
        authorityLease,
      );
    };
    try {
      const value = await this.#bounded(
        request,
        () => use(secret!, {
          source,
          binding: structuredClone(binding),
          candidatePermit,
          publishIfCurrent,
        }),
      );
      return { kind: "available", value };
    } catch (error) {
      return this.#authorityFailure(request, error);
    } finally {
      secret = null;
    }
  }

  #authorityFailure<T>(
    request: ProviderCredentialRequest,
    error: unknown,
  ): ProviderCredentialAccessResult<T> {
    if (
      error instanceof ProviderAuthorityDeadlineError
      || error instanceof ProviderAuthorityStaleError
    ) return { kind: "stale" };
    const code = errorCode(error);
    if (code === "provider-credential-cleanup-pending") {
      return { kind: "forget-pending" };
    }
    if (code?.includes("journal") || code?.includes("recovery")) {
      return { kind: "recovery-required" };
    }
    if (request.signal.aborted) throw abortFrom(request.signal);
    return { kind: "recovery-required" };
  }

  async #publishIfCurrent(
    request: ProviderCredentialRequest,
    expected: CredentialPermit,
    publish: () => void,
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<void> {
    const publishUnderLease = async (lease: ProviderAuthorityReadLease): Promise<void> => {
      const current = await this.#readPermitUnderLease(request, lease);
      if (
        !("secret" in current)
        || current.source !== expected.source
        || current.secret !== expected.secret
        || !sameBinding(current.binding, expected.binding)
      ) {
        throw new ProviderAuthorityStaleError();
      }
      await this.#bounded(request, () => lease.assertHeld());
      this.#assertAttemptCurrent(request);
      publish();
    };
    if (authorityLease) {
      await publishUnderLease(authorityLease);
      return;
    }
    await this.#coordinator().readAuthority(
      { signal: request.signal },
      publishUnderLease,
    );
  }

  async #assertCandidateCredentialCurrent(
    request: ProviderCandidateAuthorityRequest,
    lease: ProviderAuthorityReadLease,
    expected: CandidateCredentialProof,
  ): Promise<void> {
    if (!expected.binding) {
      const state = await this.#readAuthoritativeState(request);
      let current: string;
      try {
        current = normalizeProviderSecret(this.#environment.OPENROUTER_API_KEY ?? "");
      } catch {
        throw new ProviderAuthorityStaleError();
      }
      if (
        state.revision !== expected.stateRevision
        || expected.source !== "environment"
        || this.#candidateFingerprint(current) !== expected.fingerprint
      ) {
        throw new ProviderAuthorityStaleError();
      }
      return;
    }
    const current = await this.#readPermitUnderLease({
      backendId: expected.binding.backendId,
      connectionId: expected.binding.connectionId,
      credentialKind: "inference",
      purpose: "explicit-repair",
      environmentEligibility: expected.source === "environment"
        ? "explicit-repair"
        : "forbidden",
      allowDisabled: !expected.binding.enabled,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
    }, lease);
    if (
      !("secret" in current)
      || current.source !== expected.source
      || !sameBinding(current.binding, expected.binding)
      || this.#candidateFingerprint(current.secret) !== expected.fingerprint
    ) {
      throw new ProviderAuthorityStaleError();
    }
  }

  async #assertCandidateCredentialMatchesSnapshot(
    request: ProviderCandidateSnapshotAuthorityRequest,
    expected: CandidateCredentialProof,
  ): Promise<void> {
    let candidate: string;
    try {
      candidate = normalizeProviderSecret(request.candidate);
    } catch {
      throw new ProviderAuthorityStaleError();
    }
    const state = request.authoritativeState;
    if (
      state.revision !== expected.stateRevision
      || this.#candidateFingerprint(candidate) !== expected.fingerprint
    ) {
      throw new ProviderAuthorityStaleError();
    }
    if (!expected.binding) {
      let current: string;
      try {
        current = normalizeProviderSecret(this.#environment.OPENROUTER_API_KEY ?? "");
      } catch {
        throw new ProviderAuthorityStaleError();
      }
      if (
        expected.source !== "environment"
        || this.#candidateFingerprint(current) !== expected.fingerprint
      ) {
        throw new ProviderAuthorityStaleError();
      }
      return;
    }
    const selected = selectProviderBinding(
      state,
      { kind: "connection", connectionId: expected.binding.connectionId },
      !expected.binding.enabled,
    );
    if (selected.kind !== "exact" || !sameBinding(selected.binding, expected.binding)) {
      throw new ProviderAuthorityStaleError();
    }
    const current = await this.#readInferencePermit({
      backendId: expected.binding.backendId,
      connectionId: expected.binding.connectionId,
      credentialKind: "inference",
      purpose: "explicit-repair",
      environmentEligibility: expected.source === "environment"
        ? "explicit-repair"
        : "forbidden",
      allowDisabled: !expected.binding.enabled,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
    }, selected.binding, state);
    if (
      !("secret" in current)
      || current.source !== expected.source
      || !sameBinding(current.binding, expected.binding)
      || this.#candidateFingerprint(current.secret) !== expected.fingerprint
    ) {
      throw new ProviderAuthorityStaleError();
    }
  }

  #issueCandidatePermit(
    proof: CandidateCredentialProof,
  ): ProviderCandidateCredentialPermit {
    const permit = Object.freeze({ version: 1 as const });
    this.#candidatePermits.set(permit, {
      ...proof,
      binding: proof.binding ? structuredClone(proof.binding) : null,
    });
    return permit;
  }

  #candidateFingerprint(secret: string): string {
    return createHmac("sha256", this.#candidateFingerprintKey)
      .update(secret, "utf8")
      .digest("hex");
  }

  #preflightFailure(
    request: ProviderCandidatePreflightRequest,
    error: unknown,
  ): Exclude<ProviderCandidatePreflightResult, { kind: "ready" }> {
    if (error instanceof ProviderAuthorityDeadlineError) return { kind: "stale" };
    const code = errorCode(error);
    if (code === "provider-credential-cleanup-pending") {
      return { kind: "forget-pending" };
    }
    if (request.signal.aborted) throw abortFrom(request.signal);
    return { kind: "recovery-required" };
  }

  async #readInferencePermit(
    request: ProviderCredentialRequest,
    binding: ProviderConnectionBindingV2,
    state: ProviderSetupStateV2,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    let stored: string | null;
    const policy = providerCredentialPolicy(binding.backendId);
    if (!policy || binding.backendId !== request.backendId) return { kind: "invalid-pointer" };
    const pointer = binding.credentialPointer;
    if (pointer.kind === "legacy" && !policy.legacyInferenceAllowed) {
      return { kind: "invalid-pointer" };
    }
    if (pointer.kind === "versioned" && !policy.savedSlotKinds.includes(pointer.slot.kind)) {
      return { kind: "invalid-pointer" };
    }
    try {
      stored = pointer.kind === "legacy"
        ? await this.#bounded(request, () => this.#credentials.get("inference"))
        : await this.#bounded(
            request,
            () => this.#credentials.readSlot(pointer.slot),
          );
    } catch (error) {
      if (this.#isAttemptInterruption(request, error)) throw error;
      return { kind: "invalid" };
    }
    if (stored !== null) {
      try {
        return {
          binding,
          secret: normalizeProviderSecret(stored),
          source: "saved",
        };
      } catch {
        return { kind: "invalid" };
      }
    }
    if (!this.#environmentAllowed(request, binding, state)) return { kind: "absent" };
    return this.#environmentPermit(binding, "OPENROUTER_API_KEY");
  }

  async #readAuthoritativeState(
    request: ProviderCandidatePreflightRequest,
  ): Promise<ProviderSetupStateV2> {
    const expectedRevision = this.#stateStore.read().revision;
    try {
      await this.#bounded(
        request,
        () => this.#stateStore.commit(
          expectedRevision,
          (authoritative) => {
            throw new ProviderAuthoritySnapshot(authoritative);
          },
          () => this.#assertAttemptCurrent(request),
        ),
      );
    } catch (error) {
      if (error instanceof ProviderAuthoritySnapshot) {
        return structuredClone(error.state);
      }
      throw error;
    }
    throw new Error("Provider authority snapshot did not settle.");
  }

  async #readManagementPermit(
    request: ProviderCredentialRequest,
    binding: ProviderConnectionBindingV2,
    state: ProviderSetupStateV2,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    let stored: string | null;
    try {
      stored = await this.#bounded(request, () => this.#credentials.get("management"));
    } catch (error) {
      if (this.#isAttemptInterruption(request, error)) throw error;
      return { kind: "invalid" };
    }
    if (stored !== null) {
      try {
        return {
          binding,
          secret: normalizeProviderSecret(stored),
          source: "saved",
        };
      } catch {
        return { kind: "invalid" };
      }
    }
    if (!this.#environmentAllowed(request, binding, state)) return { kind: "absent" };
    return this.#environmentPermit(binding, "OPENROUTER_MANAGEMENT_KEY");
  }

  #environmentPermit(
    binding: ProviderConnectionBindingV2,
    name: "OPENROUTER_API_KEY" | "OPENROUTER_MANAGEMENT_KEY",
  ): CredentialPermit | ProviderCredentialAccessResult<never> {
    const raw = this.#environment[name];
    if (!raw) return { kind: "absent" };
    try {
      return {
        binding,
        secret: normalizeProviderSecret(raw),
        source: "environment",
      };
    } catch {
      return { kind: "invalid" };
    }
  }

  #environmentAllowed(
    request: ProviderCredentialRequest,
    binding: ProviderConnectionBindingV2,
    state: ProviderSetupStateV2,
  ): boolean {
    const policy = providerCredentialPolicy(binding.backendId);
    if (!policy || policy.environmentVariable === null || binding.backendId !== request.backendId) return false;
    if (request.environmentEligibility === "forbidden") return false;
    if (request.environmentEligibility === "explicit-repair") return true;
    if (this.#automaticEnvironmentRevoked || !binding.enabled) return false;
    const enabled = state.connections.filter((connection) =>
      connection.backendId === "openrouter" && connection.enabled
    );
    return binding.credentialPointer.kind === "legacy"
      && enabled.length === 1
      && enabled[0]?.id === binding.connectionId;
  }

  #assertAttemptCurrent(request: ProviderCandidatePreflightRequest): void {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      throw new ProviderAuthorityDeadlineError();
    }
  }

  #isAttemptInterruption(
    request: ProviderCandidatePreflightRequest,
    error: unknown,
  ): boolean {
    return error instanceof ProviderAuthorityDeadlineError || request.signal.aborted;
  }

  async #bounded<T>(
    request: ProviderCandidatePreflightRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertAttemptCurrent(request);
    const remaining = Math.max(0, request.deadlineAt - this.#now());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(abortFrom(request.signal)));
      if (remaining <= 0x7fff_ffff) {
        timer = setTimeout(
          () => finish(() => reject(new ProviderAuthorityDeadlineError())),
          remaining,
        );
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve()
        .then(() => {
          if (settled) throw new ProviderAuthorityDeadlineError();
          this.#assertAttemptCurrent(request);
          return operation();
        })
        .then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
    });
  }
}

class ProviderAuthorityDeadlineError extends Error {
  constructor() {
    super("Provider authority deadline expired.");
    this.name = "ProviderAuthorityDeadlineError";
  }
}

class ProviderAuthorityStaleError extends Error {
  constructor() {
    super("Provider credential authority changed before publication.");
    this.name = "ProviderAuthorityStaleError";
  }
}

export class ProviderAuthoritySnapshot extends Error {
  constructor(readonly state: ProviderSetupStateV2) {
    super("Provider authority snapshot captured.");
    this.name = "ProviderAuthoritySnapshot";
  }
}

export function parseOpenRouterCredentialPointer(
  value: string,
): OpenRouterCredentialPointer | null {
  if (value === "legacy:inference") return { kind: "legacy", id: value };
  const prefix = "v1:inference:";
  if (!value.startsWith(prefix)) return null;
  const uuid = value.slice(prefix.length);
  if (!CANONICAL_UUID.test(uuid)) return null;
  return {
    kind: "versioned",
    slot: Object.freeze({ version: 1, kind: "inference", id: value }),
  };
}

export function parseProviderCredentialPointer(
  backendId: "openrouter" | "kimi-code",
  value: string,
): ProviderCredentialPointer | null {
  const policy = providerCredentialPolicy(backendId);
  if (!policy) return null;
  if (value === "legacy:inference") {
    return policy.legacyInferenceAllowed ? { kind: "legacy", id: value } : null;
  }
  const match = /^v1:(inference|management|kimi-code):([0-9a-f-]+)$/u.exec(value);
  if (!match || !CANONICAL_UUID.test(match[2] ?? "")) return null;
  const kind = match[1] as CredentialSlotKind;
  if (!policy.savedSlotKinds.includes(kind)) return null;
  return {
    kind: "versioned",
    slot: Object.freeze({ version: 1, kind, id: value }),
  };
}

export function selectProviderBinding(
  state: ProviderSetupStateV2,
  selector: ProviderBindingSelector,
  allowDisabled = false,
): ProviderBindingSelection {
  let matches: ProviderConnectionStateV1[];
  if (selector.kind === "connection") {
    matches = state.connections.filter((connection) =>
      connection.id === selector.connectionId
    );
  } else if (selector.kind === "route") {
    matches = connectionsForRoute(state, selector.route);
  } else if (selector.kind === "default") {
    matches = state.defaultRoute ? connectionsForRoute(state, state.defaultRoute) : [];
  } else {
    matches = state.connections.filter((connection) =>
      connection.backendId === selector.backendId && (allowDisabled || connection.enabled)
    );
  }
  if (!allowDisabled) {
    const enabled = matches.filter((connection) => connection.enabled);
    if (enabled.length === 0 && matches.length > 0) return { kind: "disabled" };
    matches = enabled;
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length !== 1) return { kind: "ambiguous" };
  const connection = matches[0]!;
  if (connection.backendId !== "openrouter" && connection.backendId !== "kimi-code") {
    return { kind: "invalid-pointer" };
  }
  const policy = providerCredentialPolicy(connection.backendId);
  if (!policy || connection.billingRealm !== policy.billingRealm) return { kind: "invalid-pointer" };
  const pointer = parseProviderCredentialPointer(connection.backendId, connection.credentialSlot);
  if (!pointer) return { kind: "invalid-pointer" };
  return {
    kind: "exact",
    binding: {
      version: 2,
      stateRevision: state.revision,
      connectionId: connection.id,
      backendId: connection.backendId,
      enabled: connection.enabled,
      credentialPointer: pointer,
      accountFingerprint: connection.accountFingerprint,
      billingRealm: policy.billingRealm,
      isDefault: Boolean(
        state.defaultRoute
        && connection.backendId === state.defaultRoute.backendId
        && connection.accountFingerprint === state.defaultRoute.accountFingerprint
        && connection.billingRealm === state.defaultRoute.billingRealm
      ),
    },
  };
}

/** Compatibility wrapper for the existing OpenRouter-only call sites. */
export function selectOpenRouterBinding(
  state: ProviderSetupStateV2,
  selector: ProviderBindingSelector,
  allowDisabled = false,
): ProviderBindingSelection {
  const selected = selectProviderBinding(state, selector, allowDisabled);
  if (selected.kind !== "exact" || selected.binding.backendId === "openrouter") return selected;
  return { kind: "none" };
}

function connectionsForRoute(
  state: ProviderSetupStateV2,
  route: RouteIdentityV1,
): ProviderConnectionStateV1[] {
  return state.connections.filter((connection) =>
    connection.backendId === route.backendId
    && connection.accountFingerprint === route.accountFingerprint
    && connection.billingRealm === route.billingRealm
  );
}

function sameBinding(
  left: ProviderConnectionBindingV2,
  right: ProviderConnectionBindingV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortFrom(signal);
}

function abortFrom(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
