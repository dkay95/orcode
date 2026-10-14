export const BACKEND_IDS = ["openrouter", "kimi-code", "nano-gpt", "codex", "anthropic"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];
export type BackendMaturity = "stable" | "preview" | "coming-soon";
export type BillingRealm =
  | "openrouter-payg"
  | "nanogpt-subscription"
  | "nanogpt-payg"
  | "kimi-code-membership-provider-managed-overage"
  | "chatgpt-subscription-provider-managed-overage"
  | "chatgpt-account-provider-managed-limits"
  | "none";

/** Fixed trust boundary for the first supported official Codex App Server. */
export const CODEX_APP_SERVER_RUNTIME_POLICY = Object.freeze({
  cliVersion: "0.159.1",
  versionOutput: "codex-cli 0.159.1",
  teamIdentifier: "2DC432GLL2",
} as const);

export interface RouteIdentityV1 {
  version: 1;
  backendId: BackendId;
  accountFingerprint: string;
  billingRealm: BillingRealm;
  requestedModelId: string;
  canonicalModelId: string | null;
  resolutionState: "legacy-unverified" | "resolved";
}

export interface ProviderHealth {
  credential: "valid" | "rejected" | "expired" | "login-required" | "unknown" | "not-applicable";
  connectivity: "connected" | "offline" | "unknown";
  spend: "available" | "limit-reached" | "unknown";
  runtime: "ready" | "missing" | "incompatible" | "policy-unavailable" | "not-applicable";
  observedAt: number;
  generation: number;
}

export type ProviderHeadline =
  | "ready"
  | "login-required"
  | "auth-rejected"
  | "credential-expired"
  | "offline"
  | "limit-reached"
  | "runtime-missing"
  | "incompatible-runtime"
  | "policy-unavailable"
  | "unknown";

export interface BackendDescriptor {
  id: BackendId;
  displayName: string;
  maturity: BackendMaturity;
  connectable: boolean;
  kind: "raw-model" | "managed-agent";
  credentialOwner: "orcode-keychain" | "provider-runtime" | "none";
  billingRealmKind: "api-payg" | "provider-managed" | "none";
  capabilities: {
    models: boolean;
    tools: boolean;
    reasoning: boolean;
  };
}

/** Exact managed-provider contract for the first official Codex App Server. */
export const CODEX_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: "codex",
  displayName: "ChatGPT / Codex",
  maturity: "preview",
  connectable: true,
  kind: "managed-agent",
  credentialOwner: "provider-runtime",
  billingRealmKind: "provider-managed",
  capabilities: Object.freeze({ models: true, tools: true, reasoning: true }),
});

export interface BackendAdapter {
  readonly backendId: BackendId;
  inspect(request: ProviderInspectionRequest): Promise<ProviderInspection>;
  connect(request: {
    connectionId?: string;
    candidate: unknown;
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate>;
  connectUnderAuthorityLease?(
    request: {
      connectionId?: string;
      candidate: unknown;
      generation: number;
      deadlineAt: number;
      signal: AbortSignal;
    },
    lease: { assertHeld(): Promise<void> },
  ): Promise<ProviderCandidate>;
  listModels(request: { connectionId?: string; candidateId?: string; signal: AbortSignal }): Promise<readonly BackendModelDescriptor[]>;
  activate(request: { candidateId: string; model: BackendModelDescriptor; signal: AbortSignal }): Promise<CandidateProviderState>;
  reconnect(request: ProviderInspectionRequest): Promise<ProviderInspection>;
  bindRuntime?(request: { connectionId: string; generation: number; deadlineAt: number; signal: AbortSignal }): Promise<void>;
  logout(request: { signal: AbortSignal }): Promise<void>;
  discardCandidate(candidateId: string): Promise<void>;
}

export interface ProviderInspectionRequest {
  connectionId: string;
  generation: number;
  deadlineAt: number;
  signal: AbortSignal;
  purpose?: "startup-inspect" | "reconnect" | "runtime-bind" | "explicit-enable" | "explicit-repair";
  environmentEligibility?: "forbidden" | "automatic-if-no-saved" | "explicit-repair";
  allowDisabled?: boolean;
}

export interface BackendModelDescriptor {
  backendId: BackendId;
  requestedModelId: string;
  canonicalModelId: string;
  displayName: string;
  capabilities: { textInput: boolean; textOutput: boolean; tools: boolean; reasoning: boolean };
}

export interface ProviderInspection {
  backendId: BackendId;
  connectionId: string;
  health: ProviderHealth;
  headline: ProviderHeadline;
  accountFingerprint: string | null;
  billingRealm: BillingRealm;
  routeEligible: boolean;
  retryable: boolean;
  explanationCode: string;
}

export interface ProviderCandidate {
  candidateId: string;
  backendId: BackendId;
  connectionId: string;
  accountFingerprint: string | null;
  billingRealm: BillingRealm;
  health: ProviderHealth;
}

export interface CandidateProviderState {
  candidateId: string;
  backendId: BackendId;
  connectionId: string;
  accountFingerprint: string;
  billingRealm: BillingRealm;
  route: RouteIdentityV1;
}

/**
 * FIX-12: the one sentence every surface uses when an owner goes looking
 * for Claude as a backend of its own. It used to read "Coming soon", which
 * promised a backend nobody is building — this class's own constructor
 * requires `anthropic` to be registered WITHOUT an adapter, so there has
 * never been anything to be soon about. Saying so plainly is also the more
 * useful answer: it names the route that works today instead of a date
 * that does not exist. Shared from here so the setup hub, `/provider`'s
 * coming-soon funnel and the command catalog cannot drift apart on it.
 */
export const ANTHROPIC_DIRECT_BACKEND_NOTICE =
  "Not available as a direct backend — Claude models run today via OpenRouter.";

/** The same fact as a status-row role, where only a few words fit. */
export const ANTHROPIC_DIRECT_BACKEND_ROLE = "not a direct backend";

export class ProviderComingSoonError extends Error {
  constructor(backendId: BackendId) {
    super(`Backend ${backendId} has no adapter and cannot be connected.`);
    this.name = "ProviderComingSoonError";
  }
}

export class ProviderSetupRequiredError extends Error {
  readonly code = "provider-setup-required" as const;
  readonly exitCode = 1 as const;

  // FIX-18 (advice triangle): every provider-missing refusal names the ONE
  // working next step. "/provider setup" is that step — /balance and
  // /key set both dead-end without a connected provider, and each used to
  // point at the other.
  constructor(message = "Provider setup is required. Run /provider setup to connect an account.") {
    super(message);
    this.name = "ProviderSetupRequiredError";
  }
}

export function deriveProviderHeadline(health: ProviderHealth): ProviderHeadline {
  if (health.credential === "login-required") return "login-required";
  if (health.credential === "rejected") return "auth-rejected";
  if (health.credential === "expired") return "credential-expired";
  if (health.connectivity === "offline") return "offline";
  if (health.runtime === "missing") return "runtime-missing";
  if (health.runtime === "incompatible") return "incompatible-runtime";
  if (health.runtime === "policy-unavailable") return "policy-unavailable";
  if (health.spend === "limit-reached") return "limit-reached";
  if (
    health.credential === "valid"
    && health.connectivity === "connected"
    && (health.runtime === "ready" || health.runtime === "not-applicable")
  ) {
    return "ready";
  }
  return "unknown";
}

/** Equality for the stable runnable-route tuple, not its display metadata. */
export function sameRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.canonicalModelId === right.canonicalModelId;
}

export interface BackendRegistryEntry {
  descriptor: BackendDescriptor;
  adapter?: BackendAdapter;
}

export class BackendRegistry {
  readonly #descriptors = new Map<BackendId, BackendDescriptor>();
  readonly #adapters = new Map<BackendId, BackendAdapter>();
  readonly #entries: readonly BackendDescriptor[];

  constructor(entries: readonly BackendRegistryEntry[]) {
    const descriptors: BackendDescriptor[] = [];
    for (const entry of entries) {
      const { descriptor, adapter } = entry;
      if (
        descriptor.id === "codex"
        && (
          descriptor.maturity !== "preview"
          || !descriptor.connectable
          || !adapter
          || descriptor.kind !== "managed-agent"
          || descriptor.credentialOwner !== "provider-runtime"
          || descriptor.billingRealmKind !== "provider-managed"
        )
      ) {
        throw new Error("Backend codex must remain an explicitly connectable Preview managed provider runtime.");
      }
      if (
        descriptor.id === "kimi-code"
        && (
          descriptor.maturity !== "preview"
          || !descriptor.connectable
          || !adapter
          || descriptor.kind !== "raw-model"
          || descriptor.credentialOwner !== "orcode-keychain"
          || descriptor.billingRealmKind !== "provider-managed"
        )
      ) {
        throw new Error("Backend kimi-code must remain an explicitly connectable Preview adapter.");
      }
      if (
        descriptor.id === "nano-gpt"
        && (descriptor.maturity !== "preview" || !descriptor.connectable || !adapter
          || descriptor.kind !== "raw-model" || descriptor.credentialOwner !== "orcode-keychain"
          || descriptor.billingRealmKind !== "provider-managed")
      ) {
        throw new Error("Backend nano-gpt must remain an explicitly connectable Preview keychain adapter.");
      }
      if (
        descriptor.id === "anthropic"
        && (descriptor.maturity !== "coming-soon" || descriptor.connectable || adapter)
      ) {
        throw new Error("Backend anthropic is coming-soon and non-connectable in Slice 1; it must not have an adapter.");
      }
      if (this.#descriptors.has(descriptor.id)) {
        throw new Error(`Duplicate backend descriptor ID: ${descriptor.id}.`);
      }
      if (adapter && adapter.backendId !== descriptor.id) {
        throw new Error(`Adapter backend ID ${adapter.backendId} does not match descriptor ${descriptor.id}.`);
      }
      if (descriptor.maturity === "coming-soon" && adapter) {
        throw new Error(`Coming-soon backend ${descriptor.id} must not have an adapter.`);
      }
      if (descriptor.connectable && !adapter) {
        throw new Error(`Connectable backend ${descriptor.id} requires an adapter.`);
      }
      if (!descriptor.connectable && adapter) {
        throw new Error(`Non-connectable backend ${descriptor.id} must not have an adapter.`);
      }

      this.#descriptors.set(descriptor.id, descriptor);
      if (adapter) this.#adapters.set(descriptor.id, adapter);
      descriptors.push(descriptor);
    }
    this.#entries = descriptors;
  }

  entries(): readonly BackendDescriptor[] {
    return this.#entries;
  }

  descriptor(id: BackendId): BackendDescriptor {
    const descriptor = this.#descriptors.get(id);
    if (!descriptor) throw new Error(`Unknown backend: ${id}.`);
    return descriptor;
  }

  adapter(id: BackendId): BackendAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter) return adapter;

    const descriptor = this.#descriptors.get(id);
    if (!descriptor) throw new Error(`Unknown backend: ${id}.`);
    throw new ProviderComingSoonError(id);
  }
}
