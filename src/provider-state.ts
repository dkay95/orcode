import {
  BACKEND_IDS,
  type BackendId,
  type BillingRealm,
  type ProviderHealth,
  type RouteIdentityV1,
} from "./backends.js";
import { parseOpenRouterCredentialPointer } from "./provider-authority.js";
import { isRecord } from "./utils.js";

export const PROVIDER_SETUP_SCHEMA_VERSION = 1 as const;

const BILLING_REALMS: readonly BillingRealm[] = [
  "openrouter-payg",
  "chatgpt-subscription-provider-managed-overage",
  "chatgpt-account-provider-managed-limits",
  "none",
];

export interface ProviderConnectionStateV1 {
  id: string;
  backendId: BackendId;
  enabled: boolean;
  maturity: "stable" | "preview";
  credentialSlot: string;
  accountFingerprint: string;
  accountFingerprintState: "provisional" | "verified";
  billingRealm: BillingRealm;
  lastHealth: ProviderHealth | null;
}

export interface ProviderSetupStateV1 {
  schemaVersion: 1;
  revision: number;
  lifecycle: "never-configured" | "cancelled" | "migrated" | "configured";
  connections: ProviderConnectionStateV1[];
  defaultRoute: RouteIdentityV1 | null;
  cross: {
    enabled: false;
    preferredLead: RouteIdentityV1 | null;
    preferredChallenger: RouteIdentityV1 | null;
  };
}

export type ProviderStateIssue =
  | { kind: "corrupt" }
  | { kind: "future-version"; version: number };

export type ProviderSetupState = ProviderSetupStateV1 | ProviderStateIssue;

export interface ProviderStateCommitRequest {
  expectedRevision: number;
  build(current: ProviderSetupStateV1): ProviderSetupStateV1;
  assertCurrent(): void;
  adopt(committed: ProviderSetupStateV1): void;
}

const durableCommitAdopters = new WeakMap<
  ProviderStateCommitRequest,
  (committed: ProviderSetupStateV1) => void
>();
const durableCommitOutcomes = new WeakMap<object, ProviderSetupStateV1>();

/**
 * Reports an exact durable candidate that was already adopted before a later
 * persistence-owner failure rejected. Callers must complete that committed
 * tuple instead of attempting rollback or runtime cleanup.
 */
class ProviderStateCommitAdoptedError extends Error {
  constructor(committed: ProviderSetupStateV1) {
    super("Provider state commit completed before persistence ownership settled.");
    this.name = "ProviderStateCommitAdoptedError";
    durableCommitOutcomes.set(this, structuredClone(committed));
  }
}

export function readProviderStateCommitAdoption(
  error: unknown,
): ProviderSetupStateV1 | null {
  if (
    error === null
    || (typeof error !== "object" && typeof error !== "function")
  ) return null;
  const committed = durableCommitOutcomes.get(error);
  return committed ? structuredClone(committed) : null;
}

/**
 * Completes adoption only for an exact request issued by ProviderStateStore.
 * The WeakMap-held capability is unavailable to structurally forged requests;
 * the ordinary fallback retains the public persistence callback contract but
 * cannot override a stale fence after durable publication.
 */
export function adoptDurablyCommittedProviderState(
  request: ProviderStateCommitRequest,
  committed: ProviderSetupStateV1,
): void {
  const adoptCommitted = durableCommitAdopters.get(request);
  if (adoptCommitted) {
    adoptCommitted(committed);
    return;
  }
  request.assertCurrent();
  request.adopt(committed);
}

export interface ProviderStateStoreOptions {
  /**
   * Durable implementations run this request under their exact providerSetup
   * writer/CAS ownership. They must build from the authoritative snapshot and
   * adopt the committed snapshot before releasing that ownership.
   */
  persist?: (request: ProviderStateCommitRequest) => Promise<ProviderSetupStateV1>;
}

export interface LegacyOpenRouterModelPreferences {
  mainModel: string;
  fallbackModels: string[];
  compressorModel: string;
  transcriptionModel: string;
  panelModels: string[];
  reasoningByModel: Record<string, unknown>;
}

export interface LegacyModelRouteProjection {
  default: RouteIdentityV1;
  fallbacks: RouteIdentityV1[];
  compressor: RouteIdentityV1;
  transcription: RouteIdentityV1;
  panel: RouteIdentityV1[];
  reasoning: Record<string, RouteIdentityV1>;
}

export function createNeverConfiguredProviderState(): ProviderSetupStateV1 {
  return {
    schemaVersion: PROVIDER_SETUP_SCHEMA_VERSION,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: {
      enabled: false,
      preferredLead: null,
      preferredChallenger: null,
    },
  };
}

export function migrateLegacyOpenRouterState(
  legacyConfig: Record<string, unknown>,
  options: { connectionId: string },
): ProviderSetupStateV1 {
  if (!options.connectionId) {
    throw new Error("Legacy provider migration requires a CSPRNG connection ID.");
  }
  const connection: ProviderConnectionStateV1 = {
    id: options.connectionId,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: `acct_legacy_${options.connectionId}`,
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const mainModel = exactModelId(legacyConfig.mainModel);
  return {
    schemaVersion: PROVIDER_SETUP_SCHEMA_VERSION,
    revision: 0,
    lifecycle: "migrated",
    connections: [connection],
    defaultRoute: mainModel === null
      ? null
      : mapLegacyOpenRouterModel(mainModel, connection),
    cross: {
      enabled: false,
      preferredLead: null,
      preferredChallenger: null,
    },
  };
}

export function mapLegacyOpenRouterModel(
  requestedModelId: string,
  connection: ProviderConnectionStateV1,
): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: connection.accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId,
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  };
}

export function projectLegacyModelRoutes(
  legacyConfig: LegacyOpenRouterModelPreferences,
  connection: ProviderConnectionStateV1,
): LegacyModelRouteProjection {
  return {
    default: mapLegacyOpenRouterModel(legacyConfig.mainModel, connection),
    fallbacks: legacyConfig.fallbackModels.map((modelId) =>
      mapLegacyOpenRouterModel(modelId, connection)
    ),
    compressor: mapLegacyOpenRouterModel(legacyConfig.compressorModel, connection),
    transcription: mapLegacyOpenRouterModel(legacyConfig.transcriptionModel, connection),
    panel: legacyConfig.panelModels.map((modelId) =>
      mapLegacyOpenRouterModel(modelId, connection)
    ),
    reasoning: Object.fromEntries(
      Object.keys(legacyConfig.reasoningByModel).map((modelId) => [
        modelId,
        mapLegacyOpenRouterModel(modelId, connection),
      ]),
    ),
  };
}

export function validateProviderSetupState(value: unknown): ProviderSetupState {
  if (!isRecord(value)) {
    return { kind: "corrupt" };
  }
  if (
    typeof value.schemaVersion === "number"
    && Number.isInteger(value.schemaVersion)
    && value.schemaVersion > PROVIDER_SETUP_SCHEMA_VERSION
  ) {
    return { kind: "future-version", version: value.schemaVersion };
  }
  if (value.schemaVersion !== PROVIDER_SETUP_SCHEMA_VERSION) {
    return { kind: "corrupt" };
  }
  if (
    !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !isLifecycle(value.lifecycle)
    || !Array.isArray(value.connections)
    || !value.connections.every(isProviderConnectionStateV1)
    || new Set(value.connections.map((connection) => connection.id)).size !== value.connections.length
    || !isNullableRoute(value.defaultRoute)
    || !isRecord(value.cross)
    || value.cross.enabled !== false
    || !isNullableRoute(value.cross.preferredLead)
    || !isNullableRoute(value.cross.preferredChallenger)
  ) {
    return { kind: "corrupt" };
  }
  const connections = value.connections as unknown as ProviderConnectionStateV1[];
  const routes = [
    value.defaultRoute,
    value.cross.preferredLead,
    value.cross.preferredChallenger,
  ].filter((route): route is RouteIdentityV1 => route !== null);
  if (!routes.every((route) => routeMatchesConnection(route, connections))) {
    return { kind: "corrupt" };
  }
  return structuredClone(value) as unknown as ProviderSetupStateV1;
}

export function isProviderStateIssue(value: ProviderSetupState): value is ProviderStateIssue {
  return "kind" in value;
}

export function requirePersistableProviderState(
  value: ProviderSetupState,
): ProviderSetupStateV1 {
  if (isProviderStateIssue(value)) {
    throw new Error(`Provider setup state is ${value.kind} and cannot be saved.`);
  }
  return value;
}

/**
 * Small in-memory revision boundary used by provider transactions. Durable
 * persistence remains in the existing private config store.
 */
export class ProviderStateStore {
  #state: ProviderSetupStateV1;
  readonly #persist: ProviderStateStoreOptions["persist"];

  constructor(initial: ProviderSetupState, options: ProviderStateStoreOptions = {}) {
    this.#state = structuredClone(requirePersistableProviderState(initial));
    this.#persist = options.persist;
  }

  read(): ProviderSetupStateV1 {
    return structuredClone(this.#state);
  }

  replace(next: ProviderSetupState, expectedRevision: number): ProviderSetupStateV1 {
    this.#assertExpectedRevision(expectedRevision);
    this.#state = this.#prepareNext(next, expectedRevision, true);
    return this.read();
  }

  async commit(
    expectedRevision: number,
    build: (current: ProviderSetupStateV1) => ProviderSetupStateV1,
    assertCurrent: () => void = () => undefined,
  ): Promise<ProviderSetupStateV1> {
    this.#assertExpectedRevision(expectedRevision);
    const stateBeforeCommit = this.read();
    let buildCalls = 0;
    let builtCandidate: ProviderSetupStateV1 | null = null;
    let adoptedCandidate: ProviderSetupStateV1 | null = null;
    let publicationCommitted = false;
    let protocolInvalid = false;
    let capabilitiesOpen = true;

    const assertCapabilityOpen = (): void => {
      if (!capabilitiesOpen) {
        throw new Error("Provider state CAS capability is closed after settlement.");
      }
    };

    const assertCurrentCapability = (): void => {
      assertCapabilityOpen();
      if (publicationCommitted) return;
      try {
        assertCurrent();
      } catch (error) {
        protocolInvalid = true;
        throw error;
      }
    };

    const buildCandidate = (current: ProviderSetupStateV1): ProviderSetupStateV1 => {
      assertCapabilityOpen();
      try {
        if (adoptedCandidate) {
          throw new Error("Provider state CAS build capability is closed after adoption.");
        }
        buildCalls += 1;
        if (buildCalls !== 1) {
          throw new Error("Provider state CAS may build exactly one candidate.");
        }
        assertCurrent();
        const authoritative = requirePersistableProviderState(
          validateProviderSetupState(current),
        );
        if (authoritative.revision !== expectedRevision) {
          throw new Error(
            `Stale provider state revision ${expectedRevision}; authoritative revision is ${authoritative.revision}.`,
          );
        }
        builtCandidate = this.#prepareNext(
          build(structuredClone(authoritative)),
          expectedRevision,
        );
        return structuredClone(builtCandidate);
      } catch (error) {
        protocolInvalid = true;
        throw error;
      }
    };

    const adopt = (committed: ProviderSetupStateV1): void => {
      assertCapabilityOpen();
      try {
        if (adoptedCandidate) throw new Error("Provider state CAS may adopt exactly once.");
        if (protocolInvalid || buildCalls !== 1 || !builtCandidate) {
          throw new Error("Provider state CAS must build exactly once before adoption.");
        }
        this.#assertExpectedRevision(expectedRevision);
        assertCurrent();
        const validated = requirePersistableProviderState(
          validateProviderSetupState(committed),
        );
        if (validated.revision !== expectedRevision + 1) {
          throw new Error("Provider state CAS returned an invalid committed revision.");
        }
        if (JSON.stringify(validated) !== JSON.stringify(builtCandidate)) {
          throw new Error("Provider state CAS may adopt only its exact built candidate.");
        }
        this.#state = structuredClone(validated);
        adoptedCandidate = structuredClone(validated);
      } catch (error) {
        protocolInvalid = true;
        throw error;
      }
    };
    const adoptCommitted = (committed: ProviderSetupStateV1): void => {
      assertCapabilityOpen();
      let interrupted = false;
      try {
        if (adoptedCandidate) throw new Error("Provider state CAS may adopt exactly once.");
        if (protocolInvalid || buildCalls !== 1 || !builtCandidate) {
          throw new Error("Provider state CAS must build exactly once before adoption.");
        }
        this.#assertExpectedRevision(expectedRevision);
        try {
          assertCurrent();
        } catch {
          interrupted = true;
        }
        const validated = requirePersistableProviderState(
          validateProviderSetupState(committed),
        );
        if (validated.revision !== expectedRevision + 1) {
          throw new Error("Provider state CAS returned an invalid committed revision.");
        }
        if (JSON.stringify(validated) !== JSON.stringify(builtCandidate)) {
          throw new Error("Provider state CAS may adopt only its exact built candidate.");
        }
        this.#state = structuredClone(validated);
        adoptedCandidate = structuredClone(validated);
        publicationCommitted = true;
      } catch (error) {
        if (!interrupted || !adoptedCandidate) protocolInvalid = true;
        throw error;
      }
      if (interrupted) {
        throw new ProviderStateCommitAdoptedError(adoptedCandidate);
      }
    };

    if (!this.#persist) {
      const candidate = buildCandidate(this.read());
      adopt(candidate);
      return this.read();
    }

    const request: ProviderStateCommitRequest = {
      expectedRevision,
      build: buildCandidate,
      assertCurrent: assertCurrentCapability,
      adopt,
    };
    durableCommitAdopters.set(request, adoptCommitted);
    try {
      const returned = await this.#persist(request);
      if (
        protocolInvalid
        || buildCalls !== 1
        || !builtCandidate
        || !adoptedCandidate
      ) {
        throw new Error("Provider state durable commit did not complete its exact CAS protocol.");
      }
      const validatedReturn = requirePersistableProviderState(
        validateProviderSetupState(returned),
      );
      if (
        JSON.stringify(validatedReturn) !== JSON.stringify(builtCandidate)
        || JSON.stringify(validatedReturn) !== JSON.stringify(adoptedCandidate)
        || JSON.stringify(validatedReturn) !== JSON.stringify(this.#state)
      ) {
        throw new Error("Provider state durable commit readback is ambiguous.");
      }
      return this.read();
    } catch (error) {
      const exactAdoption = adoptedCandidate
        && JSON.stringify(this.#state) === JSON.stringify(adoptedCandidate)
        ? adoptedCandidate
        : null;
      if (
        !publicationCommitted
        && protocolInvalid
        && exactAdoption
      ) {
        this.#state = structuredClone(stateBeforeCommit);
      }
      if (exactAdoption && (publicationCommitted || !protocolInvalid)) {
        throw new ProviderStateCommitAdoptedError(exactAdoption);
      }
      throw error;
    } finally {
      durableCommitAdopters.delete(request);
      capabilitiesOpen = false;
    }
  }

  #assertExpectedRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Provider state revision must be a non-negative safe integer.");
    }
    if (expectedRevision !== this.#state.revision) {
      throw new Error(
        `Stale provider state revision ${expectedRevision}; current revision is ${this.#state.revision}.`,
      );
    }
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Provider state revision cannot overflow the safe-integer range.");
    }
  }

  #prepareNext(
    next: ProviderSetupState,
    expectedRevision: number,
    acceptAlreadyIncremented = false,
  ): ProviderSetupStateV1 {
    const validated = requirePersistableProviderState(validateProviderSetupState(next));
    if (
      validated.revision !== expectedRevision
      && !(acceptAlreadyIncremented && validated.revision === expectedRevision + 1)
    ) {
      throw new Error("Provider state transform must preserve the captured revision.");
    }
    const candidate = {
      ...structuredClone(validated),
      revision: expectedRevision + 1,
    };
    return requirePersistableProviderState(validateProviderSetupState(candidate));
  }
}

function exactModelId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isLifecycle(value: unknown): value is ProviderSetupStateV1["lifecycle"] {
  return value === "never-configured"
    || value === "cancelled"
    || value === "migrated"
    || value === "configured";
}

function isProviderConnectionStateV1(value: unknown): value is ProviderConnectionStateV1 {
  if (!(isRecord(value)
    && nonEmptyString(value.id)
    && isBackendId(value.backendId)
    && typeof value.enabled === "boolean"
    && (value.maturity === "stable" || value.maturity === "preview")
    && typeof value.credentialSlot === "string"
    && parseOpenRouterCredentialPointer(value.credentialSlot) !== null
    && nonEmptyString(value.accountFingerprint)
    && (value.accountFingerprintState === "provisional" || value.accountFingerprintState === "verified")
    && isBillingRealm(value.billingRealm)
    && (value.lastHealth === null || isProviderHealth(value.lastHealth)))) {
    return false;
  }
  if (!matchesBackendContract(value as unknown as ProviderConnectionStateV1)) {
    return false;
  }
  if (value.accountFingerprintState === "provisional") {
    return value.backendId === "openrouter"
      && value.enabled === true
      && value.maturity === "stable"
      && value.credentialSlot === "legacy:inference"
      && value.accountFingerprint === `acct_legacy_${value.id}`
      && value.billingRealm === "openrouter-payg"
      && value.lastHealth === null;
  }
  return true;
}

function matchesBackendContract(connection: ProviderConnectionStateV1): boolean {
  if (connection.backendId === "openrouter") {
    return connection.maturity === "stable"
      && connection.billingRealm === "openrouter-payg";
  }
  if (connection.backendId === "codex") {
    return connection.maturity === "preview"
      && (
        connection.billingRealm === "chatgpt-subscription-provider-managed-overage"
        || connection.billingRealm === "chatgpt-account-provider-managed-limits"
      );
  }
  return false;
}

function routeMatchesConnection(
  route: RouteIdentityV1,
  connections: readonly ProviderConnectionStateV1[],
): boolean {
  const connection = connections.find((candidate) =>
    candidate.backendId === route.backendId
    && candidate.accountFingerprint === route.accountFingerprint
    && candidate.billingRealm === route.billingRealm
  );
  return connection !== undefined
    && !(route.resolutionState === "resolved" && connection.accountFingerprintState === "provisional");
}

function isNullableRoute(value: unknown): value is RouteIdentityV1 | null {
  return value === null || isRouteIdentityV1(value);
}

export function validateRouteIdentityV1(value: unknown): RouteIdentityV1 | null {
  return isRouteIdentityV1(value) ? structuredClone(value) : null;
}

function isRouteIdentityV1(value: unknown): value is RouteIdentityV1 {
  return isRecord(value)
    && value.version === 1
    && isBackendId(value.backendId)
    && nonEmptyString(value.accountFingerprint)
    && isBillingRealm(value.billingRealm)
    && nonEmptyString(value.requestedModelId)
    && (value.canonicalModelId === null || nonEmptyString(value.canonicalModelId))
    && (value.resolutionState === "legacy-unverified" || value.resolutionState === "resolved")
    && (value.resolutionState !== "resolved" || value.canonicalModelId !== null)
    && (value.resolutionState !== "legacy-unverified" || value.canonicalModelId === null);
}

function isProviderHealth(value: unknown): value is ProviderHealth {
  return isRecord(value)
    && includes(["valid", "rejected", "expired", "login-required", "unknown", "not-applicable"] as const, value.credential)
    && includes(["connected", "offline", "unknown"] as const, value.connectivity)
    && includes(["available", "limit-reached", "unknown"] as const, value.spend)
    && includes(["ready", "missing", "incompatible", "policy-unavailable", "not-applicable"] as const, value.runtime)
    && typeof value.observedAt === "number"
    && Number.isFinite(value.observedAt)
    && Number.isInteger(value.generation)
    && Number(value.generation) >= 0;
}

function isBackendId(value: unknown): value is BackendId {
  return includes(BACKEND_IDS, value);
}

function isBillingRealm(value: unknown): value is BillingRealm {
  return includes(BILLING_REALMS, value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
