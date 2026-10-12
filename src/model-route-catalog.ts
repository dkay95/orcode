import type { BackendModelDescriptor, RouteIdentityV1 } from "./backends.js";
import type { RuntimeModelInfo, RuntimeModelPrice } from "./model-runtime.js";
import type {
  RoutePickerRequest,
  RoutePickerSelectionIntent,
  RoutePickerView,
} from "./route-picker.js";

const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g;
const STRING_SEQUENCE = /\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/g;
const ESCAPE_SEQUENCE = /\u001b[@-_]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export interface SelectableModelRoute {
  readonly route: RouteIdentityV1;
  readonly providerLabel: string;
  readonly model: RuntimeModelInfo;
  readonly supportsTools: boolean;
  readonly supportsReasoning: boolean;
  readonly selected: boolean;
}

export interface ModelRouteCatalogPort {
  listSelectableModelRoutes(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly SelectableModelRoute[]>;
}

export interface ModelRoutePickerPort {
  pickModelRoute(input: {
    readonly title: string;
    readonly role: "main" | "compressor" | "lead" | "challenger" | "executor";
    readonly current: RouteIdentityV1 | null;
    /** Persisted role model when it differs from the active main route. */
    readonly currentModelId?: string;
    readonly exclude?: RouteIdentityV1;
    /**
     * F1b: the same exclusion, named instead of carried, for a caller that
     * must not hold the route — Settings, whose snapshot reduces the Cross
     * pair to model ids. The picker resolves this role against the runtime's
     * own Cross pair; `exclude` above still wins when a caller that DOES hold
     * the route passes one (the Cross gate, which stages its own pair).
     */
    readonly excludeCrossRole?: "lead" | "challenger";
    readonly preserveDraft: boolean;
  }): Promise<SelectableModelRoute | null>;
}

/** Surface-only picker. It can display public rows but can never observe a route. */
export interface PublicModelRoutePickerPort {
  pickModelRoute(input: {
    readonly request: RoutePickerRequest;
    readonly view: RoutePickerView;
    readonly title: string;
    readonly currentHandle?: string;
  }): Promise<RoutePickerSelectionIntent | null>;
}

/** Exact public boundary parser; surplus private fields fail closed. */
export function parsePublicRoutePickerSelection(value: unknown): RoutePickerSelectionIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3
    || typeof record.handle !== "string" || record.handle.length === 0
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 0) return null;
  return Object.freeze({
    handle: record.handle,
    revision: record.revision as number,
    generation: record.generation as number,
  });
}

export interface ProviderModelRouteCandidate {
  readonly providerLabel: string;
  readonly route: RouteIdentityV1;
  readonly model: BackendModelDescriptor;
  readonly price: RuntimeModelPrice;
  readonly contextLength?: number;
}

/** Exact identity used for selection, independent of display metadata. */
export function sameCanonicalModelRoute(
  left: RouteIdentityV1,
  right: RouteIdentityV1,
): boolean {
  return left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.canonicalModelId !== null
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === "resolved"
    && right.resolutionState === "resolved";
}

/**
 * Projects authority-proven adapter descriptors into the one safe selection
 * identity.  Loading belongs to the provider runtime; this pure projection
 * intentionally cannot make a disabled or unproven route selectable.
 */
export function projectSelectableModelRoutes(
  candidates: readonly ProviderModelRouteCandidate[],
  current: RouteIdentityV1 | null,
): readonly SelectableModelRoute[] {
  const seen = new Set<string>();
  const rows: SelectableModelRoute[] = [];
  for (const candidate of candidates) {
    const { route, model } = candidate;
    if (
      route.resolutionState !== "resolved"
      || !route.canonicalModelId
      || route.backendId !== model.backendId
      || route.requestedModelId !== model.requestedModelId
      || route.canonicalModelId !== model.canonicalModelId
      || !model.capabilities.textInput
      || !model.capabilities.textOutput
      || !model.capabilities.tools
      || !isSafeCatalogIdentifier(route.requestedModelId)
      || !isSafeCatalogIdentifier(route.canonicalModelId)
    ) continue;
    const key = [
      route.backendId,
      route.accountFingerprint,
      route.billingRealm,
      route.canonicalModelId,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(Object.freeze({
      route: Object.freeze(structuredClone(route)),
      providerLabel: safeCatalogLine(candidate.providerLabel) || route.backendId,
      model: Object.freeze({
        id: model.requestedModelId,
        name: safeCatalogLine(model.displayName) || model.requestedModelId,
        contextLength: Number.isSafeInteger(candidate.contextLength)
          && candidate.contextLength! > 0
          ? candidate.contextLength!
          : 0,
        reasoning: model.capabilities.reasoning
          ? {
              mandatory: false,
              supportedEfforts: null,
              supportsMaxTokens: false,
            }
          : undefined,
        price: candidate.price,
      }),
      supportsTools: true,
      supportsReasoning: model.capabilities.reasoning,
      selected: current !== null && sameCanonicalModelRoute(route, current),
    }));
  }
  return Object.freeze(rows);
}

function safeCatalogLine(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_CONTROL, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSafeCatalogIdentifier(value: string): boolean {
  return value.length > 0 && safeCatalogLine(value) === value;
}
