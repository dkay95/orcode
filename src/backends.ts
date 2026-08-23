export const BACKEND_IDS = ["openrouter", "codex", "anthropic"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];
export type BackendMaturity = "stable" | "preview" | "coming-soon";
export type BillingRealm =
  | "openrouter-payg"
  | "chatgpt-subscription-provider-managed-overage"
  | "chatgpt-account-provider-managed-limits"
  | "none";

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

export interface BackendAdapter {
  readonly backendId: BackendId;
  inspect(request: { generation: number; deadlineAt: number; signal: AbortSignal }): Promise<ProviderInspection>;
  connect(request: { candidate: unknown; generation: number; signal: AbortSignal }): Promise<ProviderCandidate>;
  listModels(request: { candidateId?: string; signal: AbortSignal }): Promise<readonly BackendModelDescriptor[]>;
  activate(request: { candidateId: string; model: BackendModelDescriptor; signal: AbortSignal }): Promise<CandidateProviderState>;
  reconnect(request: { generation: number; deadlineAt: number; signal: AbortSignal }): Promise<ProviderInspection>;
  logout(request: { signal: AbortSignal }): Promise<void>;
  discardCandidate(candidateId: string): Promise<void>;
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

export class ProviderComingSoonError extends Error {
  constructor(backendId: BackendId) {
    super(`Backend ${backendId} is coming soon and cannot be connected.`);
    this.name = "ProviderComingSoonError";
  }
}

export class ProviderSetupRequiredError extends Error {
  constructor(message = "Provider setup is required.") {
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
      if (descriptor.id === "codex") {
        throw new Error("Backend codex is reserved in Slice 1 and cannot be registered.");
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
