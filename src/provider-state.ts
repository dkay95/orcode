import {
  BACKEND_IDS,
  type BackendId,
  type BillingRealm,
  type ProviderHealth,
  type RouteIdentityV1,
} from "./backends.js";
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
    !Number.isInteger(value.revision)
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

  constructor(initial: ProviderSetupState) {
    this.#state = structuredClone(requirePersistableProviderState(initial));
  }

  read(): ProviderSetupStateV1 {
    return structuredClone(this.#state);
  }

  replace(next: ProviderSetupState, expectedRevision = this.#state.revision): ProviderSetupStateV1 {
    if (expectedRevision !== this.#state.revision) {
      throw new Error(
        `Stale provider state revision ${expectedRevision}; current revision is ${this.#state.revision}.`,
      );
    }
    const validated = requirePersistableProviderState(validateProviderSetupState(next));
    this.#state = {
      ...structuredClone(validated),
      revision: expectedRevision + 1,
    };
    return this.read();
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
  return isRecord(value)
    && nonEmptyString(value.id)
    && isBackendId(value.backendId)
    && typeof value.enabled === "boolean"
    && (value.maturity === "stable" || value.maturity === "preview")
    && nonEmptyString(value.credentialSlot)
    && nonEmptyString(value.accountFingerprint)
    && (value.accountFingerprintState === "provisional" || value.accountFingerprintState === "verified")
    && isBillingRealm(value.billingRealm)
    && (value.lastHealth === null || isProviderHealth(value.lastHealth));
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
