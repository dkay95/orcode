import {
  BACKEND_IDS,
  sameRoute,
  type BackendId,
  type BillingRealm,
  type ProviderHealth,
  type RouteIdentityV1,
} from "./backends.js";
import { parseCredentialSlotRef } from "./credentials.js";
import { parseCodexHomeId, type CodexHomeId } from "./codex-profile.js";
import { parseOpenRouterCredentialPointer } from "./provider-authority.js";
import { isRecord } from "./utils.js";

export const PROVIDER_SETUP_SCHEMA_VERSION = 3 as const;

const BILLING_REALMS: readonly BillingRealm[] = [
  "openrouter-payg",
  "nanogpt-subscription",
  "nanogpt-payg",
  "kimi-code-membership-provider-managed-overage",
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

/** @deprecated Migration-only input shape. Current provider state is always V3. */
export type ProviderConnectionStateV2 = ProviderConnectionStateV1;

export type ProviderCredentialBindingV1 =
  | Readonly<{ kind: "orcode-keychain"; pointer: string }>
  | Readonly<{ kind: "provider-runtime"; homeId: CodexHomeId }>;

export interface ProviderConnectionStateV3 extends Omit<ProviderConnectionStateV2, "credentialSlot"> {
  credentialBinding: ProviderCredentialBindingV1;
}

/**
 * Authority-owned connection truth that may be used when deriving a desktop
 * capability. Credential slots and account fingerprints stay out of this view.
 */
export type ProviderConnectionAuthorityStateV1 = Pick<
  ProviderConnectionStateV3,
  "id" | "backendId" | "enabled" | "maturity" | "billingRealm" | "lastHealth"
>;

/** @deprecated Migration-only input shape. Current provider state is always V3. */
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

/** @deprecated Migration-only input shape. Current provider state is always V3. */
export interface ProviderSetupStateV2 {
  schemaVersion: 2;
  revision: number;
  lifecycle: "never-configured" | "cancelled" | "migrated" | "configured";
  connections: ProviderConnectionStateV2[];
  defaultRoute: RouteIdentityV1 | null;
  cross: {
    enabled: false;
    preferredLead: RouteIdentityV1 | null;
    preferredChallenger: RouteIdentityV1 | null;
  };
}

export interface ProviderSetupStateV3 extends Omit<ProviderSetupStateV2, "schemaVersion" | "connections"> {
  schemaVersion: 3;
  connections: ProviderConnectionStateV3[];
}

export type ProviderStateIssue =
  | { kind: "corrupt" }
  | { kind: "future-version"; version: number };

export type ProviderSetupState = ProviderSetupStateV3 | ProviderStateIssue;

export interface ProviderStateCommitRequest {
  expectedRevision: number;
  build(current: ProviderSetupStateV3): ProviderSetupStateV3;
  assertCurrent(): void;
  adopt(committed: ProviderSetupStateV3): void;
}

const durableCommitAdopters = new WeakMap<
  ProviderStateCommitRequest,
  (committed: ProviderSetupStateV3) => void
>();
const durableCommitOutcomes = new WeakMap<object, ProviderSetupStateV3>();

/**
 * Reports an exact durable candidate that was already adopted before a later
 * persistence-owner failure rejected. Callers must complete that committed
 * tuple instead of attempting rollback or runtime cleanup.
 */
class ProviderStateCommitAdoptedError extends Error {
  constructor(committed: ProviderSetupStateV3) {
    super("Provider state commit completed before persistence ownership settled.");
    this.name = "ProviderStateCommitAdoptedError";
    durableCommitOutcomes.set(this, structuredClone(committed));
  }
}

export function readProviderStateCommitAdoption(
  error: unknown,
): ProviderSetupStateV3 | null {
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
  committed: ProviderSetupStateV3,
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
  persist?: (request: ProviderStateCommitRequest) => Promise<ProviderSetupStateV3>;
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

export function createNeverConfiguredProviderState(): ProviderSetupStateV3 {
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
): ProviderSetupStateV3 {
  if (!options.connectionId) {
    throw new Error("Legacy provider migration requires a CSPRNG connection ID.");
  }
  const connection: ProviderConnectionStateV3 = {
    id: options.connectionId,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain", pointer: "legacy:inference" },
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
  connection: Pick<ProviderConnectionStateV1, "accountFingerprint">,
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
  connection: Pick<ProviderConnectionStateV1, "accountFingerprint">,
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

export function migrateProviderSetupV1ToV2(value: unknown): ProviderSetupStateV2 {
  if (isRecord(value) && value.schemaVersion === 2) {
    const current = validateProviderSetupStateV2(value);
    if (!isProviderStateIssue(current)) return current;
  }
  const legacy = validateProviderSetupStateV1(value);
  if (isProviderStateIssue(legacy)) {
    throw new Error(`Provider setup state is ${legacy.kind} and cannot be migrated.`);
  }
  const migrated = {
    ...structuredClone(legacy),
    schemaVersion: 2 as const,
  };
  const validated = validateProviderSetupStateV2(migrated);
  if (isProviderStateIssue(validated)) {
    throw new Error(`Provider setup state is ${validated.kind} after migration.`);
  }
  return validated;
}

export function migrateProviderSetupStateV2ToV3(value: unknown): ProviderSetupStateV3 {
  if (isRecord(value) && value.schemaVersion === 3) {
    const current = validateProviderSetupStateV3(value);
    if (!isProviderStateIssue(current)) return current;
  }
  const legacy = validateProviderSetupStateV2(value);
  if (isProviderStateIssue(legacy)) {
    throw new Error(`Provider setup state is ${legacy.kind} and cannot be migrated to V3.`);
  }
  if (legacy.connections.some((connection) => connection.backendId === "codex")) {
    throw new Error("A global Codex credential cannot be migrated into an isolated provider runtime.");
  }
  const migrated: ProviderSetupStateV3 = {
    ...structuredClone(legacy),
    schemaVersion: 3,
    connections: legacy.connections.map(({ credentialSlot, ...connection }) => ({
      ...connection,
      credentialBinding: {
        kind: "orcode-keychain",
        pointer: credentialSlot,
      },
    })),
  };
  const validated = validateProviderSetupStateV3(migrated);
  if (isProviderStateIssue(validated)) {
    throw new Error(`Provider setup state is ${validated.kind} after migration to V3.`);
  }
  return validated;
}

export function credentialBindingForConnection(
  connection: Pick<ProviderConnectionStateV3, "credentialBinding">,
): ProviderCredentialBindingV1 {
  return connection.credentialBinding;
}

export function requireKeychainCredentialPointer(
  connection: Pick<ProviderConnectionStateV3, "credentialBinding">,
): string {
  const binding = credentialBindingForConnection(connection);
  if (binding.kind !== "orcode-keychain") {
    throw new Error("provider-runtime has no keychain pointer");
  }
  return binding.pointer;
}

export function sameProviderCredentialBinding(
  left: ProviderCredentialBindingV1,
  right: ProviderCredentialBindingV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "orcode-keychain"
    ? left.pointer === (right as Extract<ProviderCredentialBindingV1, { kind: "orcode-keychain" }>).pointer
    : left.homeId === (right as Extract<ProviderCredentialBindingV1, { kind: "provider-runtime" }>).homeId;
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
  if (value.schemaVersion === 1) {
    try {
      return migrateProviderSetupStateV2ToV3(migrateProviderSetupV1ToV2(value));
    } catch {
      return { kind: "corrupt" };
    }
  }
  if (value.schemaVersion === 2) {
    try {
      return migrateProviderSetupStateV2ToV3(value);
    } catch {
      return { kind: "corrupt" };
    }
  }
  if (value.schemaVersion !== PROVIDER_SETUP_SCHEMA_VERSION) {
    return { kind: "corrupt" };
  }
  return validateProviderSetupStateV3(value);
}

function validateProviderSetupStateV1(value: unknown): ProviderSetupStateV1 | ProviderStateIssue {
  return validateProviderSetupStateStructure(value, 1) as ProviderSetupStateV1 | ProviderStateIssue;
}

function validateProviderSetupStateV2(value: unknown): ProviderSetupStateV2 | ProviderStateIssue {
  return validateProviderSetupStateStructure(value, 2) as ProviderSetupStateV2 | ProviderStateIssue;
}

function validateProviderSetupStateV3(value: unknown): ProviderSetupStateV3 | ProviderStateIssue {
  return validateProviderSetupStateStructure(value, 3) as ProviderSetupStateV3 | ProviderStateIssue;
}

function validateProviderSetupStateStructure(
  value: unknown,
  schemaVersion: 1 | 2 | 3,
): ProviderSetupStateV1 | ProviderSetupStateV2 | ProviderSetupStateV3 | ProviderStateIssue {
  if (!isRecord(value) || value.schemaVersion !== schemaVersion) return { kind: "corrupt" };
  if (
    !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !isLifecycle(value.lifecycle)
    || !Array.isArray(value.connections)
    || !value.connections.every((connection) => isProviderConnectionState(connection, schemaVersion))
    || new Set(value.connections.map((connection) => connection.id)).size !== value.connections.length
    || !isNullableRoute(value.defaultRoute)
    || !isRecord(value.cross)
    || !hasExactKeys(value.cross, ["enabled", "preferredLead", "preferredChallenger"])
    || value.cross.enabled !== false
    || !isNullableRoute(value.cross.preferredLead)
    || !isNullableRoute(value.cross.preferredChallenger)
  ) {
    return { kind: "corrupt" };
  }
  const connections = value.connections as unknown as ProviderConnectionStateV3[];
  const routes = [
    value.defaultRoute,
    value.cross.preferredLead,
    value.cross.preferredChallenger,
  ].filter((route): route is RouteIdentityV1 => route !== null);
  if (!routes.every((route) => routeMatchesConnection(route, connections))) {
    return { kind: "corrupt" };
  }
  const preferredLead = value.cross.preferredLead as RouteIdentityV1 | null;
  const preferredChallenger = value.cross.preferredChallenger as RouteIdentityV1 | null;
  if (
    (preferredLead !== null && preferredLead.resolutionState !== "resolved")
    || (preferredChallenger !== null && preferredChallenger.resolutionState !== "resolved")
    || (
      preferredLead !== null
      && preferredChallenger !== null
      && sameRoute(preferredLead, preferredChallenger)
    )
  ) {
    return { kind: "corrupt" };
  }
  return structuredClone(value) as unknown as ProviderSetupStateV1 | ProviderSetupStateV2 | ProviderSetupStateV3;
}

export function isProviderStateIssue(
  value: ProviderSetupState | ProviderSetupStateV1 | ProviderSetupStateV2,
): value is ProviderStateIssue {
  return "kind" in value;
}

export function requirePersistableProviderState(
  value: ProviderSetupState,
): ProviderSetupStateV3 {
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
  #state: ProviderSetupStateV3;
  readonly #persist: ProviderStateStoreOptions["persist"];

  constructor(initial: ProviderSetupState, options: ProviderStateStoreOptions = {}) {
    this.#state = structuredClone(requirePersistableProviderState(initial));
    this.#persist = options.persist;
  }

  read(): ProviderSetupStateV3 {
    return structuredClone(this.#state);
  }

  replace(next: ProviderSetupState, expectedRevision: number): ProviderSetupStateV3 {
    this.#assertExpectedRevision(expectedRevision);
    this.#state = this.#prepareNext(next, expectedRevision, true);
    return this.read();
  }

  async commit(
    expectedRevision: number,
    build: (current: ProviderSetupStateV3) => ProviderSetupStateV3,
    assertCurrent: () => void = () => undefined,
  ): Promise<ProviderSetupStateV3> {
    this.#assertExpectedRevision(expectedRevision);
    const stateBeforeCommit = this.read();
    let buildCalls = 0;
    let builtCandidate: ProviderSetupStateV3 | null = null;
    let adoptedCandidate: ProviderSetupStateV3 | null = null;
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

    const buildCandidate = (current: ProviderSetupStateV3): ProviderSetupStateV3 => {
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

    const adopt = (committed: ProviderSetupStateV3): void => {
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
    const adoptCommitted = (committed: ProviderSetupStateV3): void => {
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
  ): ProviderSetupStateV3 {
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

function isProviderConnectionState(
  value: unknown,
  schemaVersion: 1 | 2 | 3,
): value is ProviderConnectionStateV3 {
  if (!(isRecord(value)
    && nonEmptyString(value.id)
    && isBackendId(value.backendId)
    && typeof value.enabled === "boolean"
    && (value.maturity === "stable" || value.maturity === "preview")
    && nonEmptyString(value.accountFingerprint)
    && (value.accountFingerprintState === "provisional" || value.accountFingerprintState === "verified")
    && isBillingRealm(value.billingRealm)
    && (value.lastHealth === null || isProviderHealth(value.lastHealth)))) {
    return false;
  }
  if (!matchesBackendContract(value as unknown as ProviderConnectionStateV3, schemaVersion)) {
    return false;
  }
  let credentialPointer: string | null = null;
  if (schemaVersion === 3) {
    if (!hasExactKeys(value, [
      "id",
      "backendId",
      "enabled",
      "maturity",
      "credentialBinding",
      "accountFingerprint",
      "accountFingerprintState",
      "billingRealm",
      "lastHealth",
    ]) || !isProviderCredentialBinding(value.backendId, value.credentialBinding)) {
      return false;
    }
    if ((value.credentialBinding as ProviderCredentialBindingV1).kind === "orcode-keychain") {
      credentialPointer = (value.credentialBinding as { pointer: string }).pointer;
    }
  } else {
    if (typeof value.credentialSlot !== "string"
      || !hasValidCredentialSlot(value.backendId, value.credentialSlot, schemaVersion)) {
      return false;
    }
    credentialPointer = value.credentialSlot;
  }
  if (value.accountFingerprintState === "provisional") {
    return value.backendId === "openrouter"
      && value.enabled === true
      && value.maturity === "stable"
      && credentialPointer === "legacy:inference"
      && value.accountFingerprint === `acct_legacy_${value.id}`
      && value.billingRealm === "openrouter-payg"
      && value.lastHealth === null;
  }
  return true;
}

function hasValidCredentialSlot(
  backendId: BackendId,
  credentialSlot: string,
  schemaVersion: 1 | 2,
): boolean {
  if (backendId === "kimi-code" || backendId === "nano-gpt") {
    if (schemaVersion !== 2) return false;
    try {
      return parseCredentialSlotRef(credentialSlot).kind === backendId;
    } catch {
      return false;
    }
  }
  return parseOpenRouterCredentialPointer(credentialSlot) !== null;
}

function isProviderCredentialBinding(
  backendId: BackendId,
  value: unknown,
): value is ProviderCredentialBindingV1 {
  if (!isRecord(value)) return false;
  if (value.kind === "provider-runtime") {
    if (
      !hasExactKeys(value, ["kind", "homeId"])
      || backendId !== "codex"
      || typeof value.homeId !== "string"
    ) return false;
    try {
      parseCodexHomeId(value.homeId as string);
      return true;
    } catch {
      return false;
    }
  }
  if (
    value.kind !== "orcode-keychain"
    || !hasExactKeys(value, ["kind", "pointer"])
    || typeof value.pointer !== "string"
    || backendId === "codex"
  ) return false;
  return hasValidCredentialSlot(backendId, value.pointer, 2);
}

function matchesBackendContract(
  connection: ProviderConnectionStateV3,
  schemaVersion: 1 | 2 | 3,
): boolean {
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
  if (connection.backendId === "kimi-code") {
    return schemaVersion !== 1
      && connection.maturity === "preview"
      && connection.billingRealm === "kimi-code-membership-provider-managed-overage";
  }
  if (connection.backendId === "nano-gpt") {
    return schemaVersion !== 1
      && connection.maturity === "preview"
      && (connection.billingRealm === "nanogpt-subscription" || connection.billingRealm === "nanogpt-payg");
  }
  return false;
}

function routeMatchesConnection(
  route: RouteIdentityV1,
  connections: readonly ProviderConnectionStateV3[],
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
    && (value.backendId === "nano-gpt"
      ? (value.billingRealm === "nanogpt-subscription" || value.billingRealm === "nanogpt-payg")
        && value.resolutionState === "resolved" && value.requestedModelId === value.canonicalModelId
      : value.billingRealm !== "nanogpt-subscription" && value.billingRealm !== "nanogpt-payg")
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

const PRIVATE_PROVIDER_STATE_KEYS = new Set([
  "credentialslot",
  "credentialbinding",
  "pointer",
  "homeid",
  "codexhome",
]);

const PRIVATE_PROVIDER_STATE_VALUES = [
  /^codex-[0-9a-f]{32}$/,
  /^keychain-pointer-canary$/,
  /^legacy:inference$/,
  /^v1:(?:inference|kimi-code|nano-gpt):[0-9a-f-]{36}$/,
  /(?:^|\/)provider-home(?:-|\/|$)/,
  /(?:^|\/)providers\/codex\/codex-[0-9a-f]{32}\/?$/,
];

/**
 * Defense-in-depth guard for every serialized/public projection. It rejects
 * both known private field names and recognizable opaque binding/path leaves,
 * recursively through arrays and nested records.
 */
export function assertNoPrivateProviderStateLeaves(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (
        candidate === "orcode-keychain"
        || candidate === "provider-runtime"
        || PRIVATE_PROVIDER_STATE_VALUES.some((pattern) => pattern.test(candidate))
      ) {
        throw new Error("Private provider state reached a public boundary.");
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, item] of Object.entries(candidate)) {
      if (PRIVATE_PROVIDER_STATE_KEYS.has(key.toLowerCase())) {
        throw new Error("Private provider state reached a public boundary.");
      }
      visit(item);
    }
  };
  visit(value);
}
