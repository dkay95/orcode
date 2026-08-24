import {
  normalizeProviderSecret,
  type CredentialKind,
  type CredentialSlotRef,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import type {
  ProviderConnectionStateV1,
  ProviderSetupStateV1,
  ProviderStateStore,
} from "./provider-state.js";
import type { RouteIdentityV1 } from "./backends.js";

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

export type OpenRouterCredentialPointer =
  | { kind: "legacy"; id: "legacy:inference" }
  | { kind: "versioned"; slot: CredentialSlotRef };

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

export type ProviderBindingSelection =
  | { kind: "exact"; binding: ProviderConnectionBindingV1 }
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
  connectionId: string;
  credentialKind?: CredentialKind;
  purpose: CredentialAccessPurpose;
  environmentEligibility: EnvironmentEligibility;
  allowDisabled?: boolean;
  deadlineAt: number;
  signal: AbortSignal;
}

export interface ProviderCredentialAuthorityLike {
  withCredential<T>(
    request: ProviderCredentialRequest,
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
      },
    ) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>>;
  withCredentialUnderLease?<T>(
    request: ProviderCredentialRequest,
    lease: ProviderAuthorityReadLease,
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
      },
    ) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>>;
}

export interface ProviderCredentialAuthorityOptions {
  stateStore: ProviderStateStore;
  credentials: VersionedCredentialStoreLike;
  environment?: Readonly<Record<string, string | undefined>>;
  coordinator: () => ProviderAuthorityCoordinator;
  now?: () => number;
}

type ProviderBindingSelector =
  | { kind: "connection"; connectionId: string }
  | { kind: "route"; route: RouteIdentityV1 }
  | { kind: "default" }
  | { kind: "backend"; backendId: "openrouter" };

interface CredentialPermit {
  binding: ProviderConnectionBindingV1;
  secret: string;
  source: "saved" | "environment";
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

  select(
    selector: ProviderBindingSelector,
    options: { allowDisabled?: boolean } = {},
  ): ProviderBindingSelection {
    return selectOpenRouterBinding(
      this.#stateStore.read(),
      selector,
      options.allowDisabled ?? false,
    );
  }

  async withCredential<T>(
    request: ProviderCredentialRequest,
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
      },
    ) => Promise<T>,
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
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
      },
    ) => Promise<T>,
  ): Promise<ProviderCredentialAccessResult<T>> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      return { kind: "stale" };
    }
    let permit: CredentialPermit | ProviderCredentialAccessResult<never>;
    try {
      permit = await this.#readPermitUnderLease(request, lease);
      await lease.assertHeld();
    } catch (error) {
      return this.#authorityFailure(request, error);
    }
    return this.#usePermit(request, permit, use);
  }

  async #readPermitUnderLease(
    request: ProviderCredentialRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    await lease.assertHeld();
    const before = await this.#readAuthoritativeState();
    const selected = selectOpenRouterBinding(
      before,
      { kind: "connection", connectionId: request.connectionId },
      request.allowDisabled ?? false,
    );
    if (selected.kind !== "exact") {
      return { kind: selected.kind } as ProviderCredentialAccessResult<never>;
    }
    const binding = selected.binding;
    let permit = request.credentialKind === "management"
      ? await this.#readManagementPermit(request, binding, before)
      : await this.#readInferencePermit(request, binding, before);
    await lease.assertHeld();
    if ("secret" in permit) {
      const after = selectOpenRouterBinding(
        await this.#readAuthoritativeState(),
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
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
      },
    ) => Promise<T>,
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
    try {
      return {
        kind: "available",
        value: await use(secret, { source, binding: structuredClone(binding) }),
      };
    } finally {
      secret = null;
    }
  }

  #authorityFailure<T>(
    request: ProviderCredentialRequest,
    error: unknown,
  ): ProviderCredentialAccessResult<T> {
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

  async #readInferencePermit(
    request: ProviderCredentialRequest,
    binding: ProviderConnectionBindingV1,
    state: ProviderSetupStateV1,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    let stored: string | null;
    try {
      stored = binding.credentialPointer.kind === "legacy"
        ? await this.#credentials.get("inference")
        : await this.#credentials.readSlot(binding.credentialPointer.slot);
    } catch {
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

  async #readAuthoritativeState(): Promise<ProviderSetupStateV1> {
    const expectedRevision = this.#stateStore.read().revision;
    try {
      await this.#stateStore.commit(expectedRevision, (authoritative) => {
        throw new ProviderAuthoritySnapshot(authoritative);
      });
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
    binding: ProviderConnectionBindingV1,
    state: ProviderSetupStateV1,
  ): Promise<CredentialPermit | ProviderCredentialAccessResult<never>> {
    let stored: string | null;
    try {
      stored = await this.#credentials.get("management");
    } catch {
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
    binding: ProviderConnectionBindingV1,
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
    binding: ProviderConnectionBindingV1,
    state: ProviderSetupStateV1,
  ): boolean {
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
}

export class ProviderAuthoritySnapshot extends Error {
  constructor(readonly state: ProviderSetupStateV1) {
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

export function selectOpenRouterBinding(
  state: ProviderSetupStateV1,
  selector: ProviderBindingSelector,
  allowDisabled = false,
): ProviderBindingSelection {
  let matches: ProviderConnectionStateV1[];
  if (selector.kind === "connection") {
    matches = state.connections.filter((connection) =>
      connection.backendId === "openrouter" && connection.id === selector.connectionId
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
  const pointer = parseOpenRouterCredentialPointer(connection.credentialSlot);
  if (!pointer) return { kind: "invalid-pointer" };
  return {
    kind: "exact",
    binding: {
      version: 1,
      stateRevision: state.revision,
      connectionId: connection.id,
      backendId: "openrouter",
      enabled: connection.enabled,
      credentialPointer: pointer,
      accountFingerprint: connection.accountFingerprint,
      billingRealm: "openrouter-payg",
      isDefault: Boolean(
        state.defaultRoute
        && connection.backendId === state.defaultRoute.backendId
        && connection.accountFingerprint === state.defaultRoute.accountFingerprint
        && connection.billingRealm === state.defaultRoute.billingRealm
      ),
    },
  };
}

function connectionsForRoute(
  state: ProviderSetupStateV1,
  route: RouteIdentityV1,
): ProviderConnectionStateV1[] {
  if (route.backendId !== "openrouter") return [];
  return state.connections.filter((connection) =>
    connection.backendId === route.backendId
    && connection.accountFingerprint === route.accountFingerprint
    && connection.billingRealm === route.billingRealm
  );
}

function sameBinding(
  left: ProviderConnectionBindingV1,
  right: ProviderConnectionBindingV1,
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
