import {
  assertNoPrivateProviderStateLeaves,
  type ProviderConnectionAuthorityStateV1,
  type ProviderSetupStateV3,
} from "./provider-state.js";
import { redactText, scanForSecrets } from "./redaction.js";
import type {
  DesktopActiveRoute,
  DesktopCapabilitySnapshot,
  DesktopCostKnowledge,
  DesktopDataPolicyKnowledge,
  DesktopDisabledPresentation,
  DesktopModelCapability,
  DesktopMultiProfileCapability,
  DesktopProviderCapability,
  DesktopProviderState,
  DesktopRouteCandidate,
  DesktopSetupMethod,
} from "./desktop-contracts.js";
import {
  isDesktopKimiRuntimeCapability,
  type DesktopKimiRuntimeCapability,
} from "./kimi-execution-origin.js";

const UNKNOWN_COST: DesktopCostKnowledge = { kind: "unknown", label: "Kosten unbekannt" };
const UNKNOWN_DATA_POLICY: DesktopDataPolicyKnowledge = {
  kind: "unknown",
  label: "Datenrichtlinie unbekannt",
};
const KIMI_UNAVAILABLE: DesktopDisabledPresentation = Object.freeze({
  code: "native-local-action-unavailable",
  label: "Lokale Bestätigung ist nicht verfügbar",
  recoveryLabel: "Signierte Desktop-App verwenden",
});
const UNSAFE_PUBLIC_LABEL = /(?:\b(?:https?|wss?):\/\/|\bwww\.|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:acct_(?:or|kimi|nano|legacy)_[A-Za-z0-9_-]{6,}|v1:(?:inference|management|kimi-code|nano-gpt):[A-Za-z0-9-]{8,})|\b[a-f0-9]{24,}\b|canary|\b(?:error|fehler|exception|diagnostic|diagnose|stack(?:trace)?|traceback|http\s*[45]\d{2})\b|[\r\n])/i;
const PROJECTION_REJECTED = "Desktop-Daten konnten nicht sicher dargestellt werden.";

type AuthorityKnowledge = {
  readonly source: "provider" | "subscription" | "owner-config";
  readonly label: string;
  readonly rawBody?: string;
};

export interface CodexProviderProjectionInput {
  readonly connectionId: string | null;
  readonly accountLabel: string | null;
  readonly state: DesktopProviderState;
  readonly routes: readonly DesktopRouteCandidate[];
  readonly multiProfile: DesktopMultiProfileCapability;
  readonly disabled?: DesktopDisabledPresentation;
  readonly repair?: DesktopDisabledPresentation;
}

/**
 * Complete Foundation projection for the managed ChatGPT/Codex provider.
 * Login method IDs are descriptive only in Task 4; callers must pair them
 * with the mapped unavailable presentation until a native invocation exists.
 */
export function projectCodexProviderCapability(
  input: CodexProviderProjectionInput,
): DesktopProviderCapability {
  const provider: DesktopProviderCapability = {
    providerId: "codex",
    providerLabel: "ChatGPT / Codex",
    connectionId: input.connectionId,
    accountLabel: input.accountLabel,
    state: input.state,
    setupMethods: ["codex-browser-login", "codex-device-login"],
    multiProfile: structuredClone(input.multiProfile),
    routes: structuredClone(input.routes),
    ...(input.disabled === undefined ? {} : { disabled: structuredClone(input.disabled) }),
    ...(input.repair === undefined ? {} : { repair: structuredClone(input.repair) }),
  };
  assertNoPrivateProviderStateLeaves(provider);
  return Object.freeze(provider);
}

interface DesktopAuthorityRoute {
  readonly handle: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly accountLabel: string;
  readonly canonicalModelId: string;
  readonly displayName: string;
  readonly reasoning: "supported" | "unsupported" | "unknown";
  readonly capabilities: readonly DesktopModelCapability[];
  readonly cost: AuthorityKnowledge | null;
  readonly dataPolicy: AuthorityKnowledge | null;
  readonly runnable: boolean;
  readonly disabled?: DesktopDisabledPresentation;
}

interface DesktopAuthorityProvider {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly connection: ProviderConnectionAuthorityStateV1 | null;
  readonly connectionId: string | null;
  readonly accountLabel: string | null;
  readonly state: DesktopProviderState;
  readonly setupMethods: readonly DesktopSetupMethod[];
  readonly multiProfile: DesktopMultiProfileCapability;
  readonly routes: readonly DesktopAuthorityRoute[];
  readonly disabled?: DesktopDisabledPresentation;
  readonly repair?: DesktopDisabledPresentation;
}

interface DesktopAuthorityActiveRoute {
  readonly routeHandle: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly accountLabel: string | null;
}

export interface DesktopCapabilityInput {
  readonly state: ProviderSetupStateV3;
  readonly generation: number;
  /** Supplied only after SetupOrchestrator has established current routability. */
  readonly routeRunnable: boolean;
  readonly providers: readonly DesktopAuthorityProvider[];
  readonly activeRoute: DesktopAuthorityActiveRoute | null;
  readonly undoAvailable: boolean;
  readonly appearance: { readonly showLargeLogo: boolean; readonly showHeaderMark: boolean };
  readonly desktopKimiCapability?: DesktopKimiRuntimeCapability;
}

export function projectDesktopCapabilities(input: DesktopCapabilityInput): DesktopCapabilitySnapshot {
  const connections = new Map(input.state.connections.map((connection) => [
    connection.id,
    { id: connection.id, backendId: connection.backendId },
  ]));
  const packagedRuntimeReady = isDesktopKimiRuntimeCapability(input.desktopKimiCapability);
  const providers = input.providers.map((provider) => projectProvider(provider, connections, packagedRuntimeReady));
  const activeRoute = projectActiveRoute(input.activeRoute, providers);
  const snapshot: DesktopCapabilitySnapshot = {
    schemaVersion: 1,
    revision: input.state.revision,
    generation: input.generation,
    routeRunnable: input.routeRunnable && activeRoute !== null,
    activeRoute,
    providers,
    undoAvailable: input.undoAvailable,
    appearance: {
      showLargeLogo: input.appearance.showLargeLogo,
      showHeaderMark: input.appearance.showHeaderMark,
    },
  };
  assertNoPrivateProviderStateLeaves(snapshot);
  return Object.freeze(snapshot);
}

function projectProvider(
  provider: DesktopAuthorityProvider,
  connections: ReadonlyMap<string, { readonly id: string; readonly backendId: string }>,
  kimiAttested: boolean,
): DesktopProviderCapability {
  assertConnectionConsistent(provider, connections);
  assertRequiredSafeLabel(provider.providerLabel);
  assertSafeLabel(provider.accountLabel);
  const routes = provider.routes.map(projectRoute);
  if (provider.providerId === "kimi-code" && !kimiAttested) {
    return {
      providerId: provider.providerId,
      providerLabel: provider.providerLabel,
      connectionId: provider.connection?.id ?? null,
      accountLabel: provider.accountLabel,
      state: "disabled",
      setupMethods: [...provider.setupMethods],
      multiProfile: projectMultiProfile(provider.multiProfile),
      routes: routes.map((route) => ({
        ...route,
        runnable: false,
        disabled: KIMI_UNAVAILABLE,
      })),
      disabled: KIMI_UNAVAILABLE,
    };
  }
  return {
    providerId: provider.providerId,
    providerLabel: provider.providerLabel,
    connectionId: provider.connection?.id ?? null,
    accountLabel: provider.accountLabel,
    state: provider.state,
    setupMethods: [...provider.setupMethods],
    multiProfile: projectMultiProfile(provider.multiProfile),
    routes,
    ...(provider.disabled === undefined ? {} : { disabled: projectDisabled(provider.disabled) }),
    ...(provider.repair === undefined ? {} : { repair: projectDisabled(provider.repair) }),
  };
}

function projectRoute(route: DesktopAuthorityRoute): DesktopRouteCandidate {
  assertSafeLabel(route.accountLabel);
  assertSafeLabel(route.displayName);
  return {
    handle: route.handle,
    providerId: route.providerId,
    connectionId: route.connectionId,
    accountLabel: route.accountLabel,
    canonicalModelId: route.canonicalModelId,
    displayName: route.displayName,
    reasoning: route.reasoning,
    capabilities: [...route.capabilities],
    cost: projectCost(route.cost),
    dataPolicy: projectDataPolicy(route.dataPolicy),
    runnable: route.runnable,
    ...(route.disabled === undefined ? {} : { disabled: projectDisabled(route.disabled) }),
  };
}

function projectCost(value: AuthorityKnowledge | null): DesktopCostKnowledge {
  if (
    (value?.source === "provider" || value?.source === "subscription")
    && isSafeLabel(value.label)
  ) {
    return { kind: "known", label: value.label, source: value.source };
  }
  return UNKNOWN_COST;
}

function projectDataPolicy(value: AuthorityKnowledge | null): DesktopDataPolicyKnowledge {
  if (
    (value?.source === "provider" || value?.source === "owner-config")
    && isSafeLabel(value.label)
  ) {
    return { kind: "known", label: value.label, source: value.source };
  }
  return UNKNOWN_DATA_POLICY;
}

function projectMultiProfile(value: DesktopMultiProfileCapability): DesktopMultiProfileCapability {
  return {
    enabled: value.enabled,
    ...(value.disabled === undefined ? {} : { disabled: projectDisabled(value.disabled) }),
  };
}

function projectDisabled(value: DesktopDisabledPresentation): DesktopDisabledPresentation {
  assertSafeLabel(value.label);
  assertSafeLabel(value.recoveryLabel);
  return {
    code: value.code,
    label: value.label,
    ...(value.recoveryLabel === undefined ? {} : { recoveryLabel: value.recoveryLabel }),
  };
}

function projectActiveRoute(
  value: DesktopAuthorityActiveRoute | null,
  providers: readonly DesktopProviderCapability[],
): DesktopActiveRoute | null {
  if (value === null) return null;
  assertSafeLabel(value.providerLabel);
  assertSafeLabel(value.modelLabel);
  assertSafeLabel(value.accountLabel);
  const matches = providers.flatMap((provider) => provider.routes
    .filter((route) => (
      route.handle === value.routeHandle
      && route.runnable
      && route.disabled === undefined
    ))
    .map((route) => ({ provider, route })));
  if (
    matches.length !== 1
    || matches[0]!.provider.providerLabel !== value.providerLabel
    || matches[0]!.route.displayName !== value.modelLabel
    || matches[0]!.route.accountLabel !== value.accountLabel
  ) return null;
  return {
    routeHandle: value.routeHandle,
    providerLabel: value.providerLabel,
    modelLabel: value.modelLabel,
    accountLabel: value.accountLabel,
  };
}

function assertConnectionConsistent(
  provider: DesktopAuthorityProvider,
  connections: ReadonlyMap<string, { readonly id: string; readonly backendId: string }>,
): void {
  const connection = provider.connection;
  if (
    (connection === null && provider.connectionId !== null)
    || (connection !== null && (
      connection.id !== provider.connectionId
      || connection.backendId !== provider.providerId
      || connections.get(connection.id)?.backendId !== connection.backendId
    ))
    || provider.routes.some((route) => (
      route.providerId !== provider.providerId
      || connections.get(route.connectionId)?.backendId !== provider.providerId
    ))
  ) throw new Error(PROJECTION_REJECTED);
}

function assertSafeLabel(value: string | null | undefined): void {
  if (!isSafeLabel(value)) throw new Error(PROJECTION_REJECTED);
}

function assertRequiredSafeLabel(value: string | null | undefined): asserts value is string {
  if (value === null || value === undefined || !isSafeLabel(value)) {
    throw new Error(PROJECTION_REJECTED);
  }
}

function isSafeLabel(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return value.trim().length > 0
    && value === redactText(value)
    && scanForSecrets(value).length === 0
    && !UNSAFE_PUBLIC_LABEL.test(value);
}
