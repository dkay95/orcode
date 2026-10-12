import { randomUUID } from "node:crypto";

import type { RouteIdentityV1 } from "./backends.js";
import type {
  DesktopCapabilitySnapshot, DesktopCostKnowledge, DesktopDataPolicyKnowledge,
  DesktopDisabledPresentation, DesktopRouteCandidate,
} from "./desktop-contracts.js";

export type RoutePickerRole = "main" | "compressor" | "lead" | "challenger" | "executor";
export interface RoutePickerRequest { readonly role: RoutePickerRole; readonly connectionId?: string }
export interface RoutePickerSelectionIntent { readonly handle: string; readonly revision: number; readonly generation: number }
/** A route row plus the canonical safe provider label of its owning snapshot row. */
export interface DesktopRoutePickerCandidate extends DesktopRouteCandidate {
  readonly providerLabel: string;
}
export interface RoutePickerView { readonly revision: number; readonly generation: number; readonly candidates: readonly DesktopRoutePickerCandidate[] }
/** Core-private. Never serialize or return through a surface/controller. */
export interface ResolvedRoutePickerSelection {
  readonly selection: RoutePickerSelectionIntent; readonly candidate: DesktopRoutePickerCandidate;
  readonly route: RouteIdentityV1; readonly connectionId: string;
}
export interface RoutePickerAuthority {
  view(request: RoutePickerRequest): RoutePickerView;
  resolve(request: RoutePickerRequest, selection: RoutePickerSelectionIntent): ResolvedRoutePickerSelection;
}
export interface RoutePickerBinding { readonly connectionId: string; readonly route: RouteIdentityV1 }
export interface RoutePickerCapture {
  readonly snapshot: DesktopCapabilitySnapshot;
  readonly bindings: ReadonlyMap<string, RoutePickerBinding>;
  /** Private catalogue proof, never serialized: confirmed text-only models are not coding routes. */
  readonly codingIneligibleHandles?: ReadonlySet<string>;
}
interface RoutePickerSource {
  capture(): RoutePickerCapture;
}
interface OwnedRoutePickerBinding {
  readonly sourceHandle: string; readonly candidate: DesktopRoutePickerCandidate; readonly bindingKey: string;
}
interface PublicSourceBinding { readonly handle: string; readonly bindingKey: string }
interface RoutePickerState {
  readonly source: RoutePickerSource; epoch: string;
  owned: Map<string, OwnedRoutePickerBinding>;
  publicBySource: Map<string, PublicSourceBinding>;
}
export interface CoreRoutePickerProjection {
  readonly view: RoutePickerView;
  handleForSource(sourceHandle: string): string | undefined;
}
export interface AcceptedRoutePickerActivation {
  readonly routeHandle: string; readonly revision: number; readonly generation: number;
}

const ROUTE_PICKER_ROLES: ReadonlySet<string> = Object.freeze(new Set<RoutePickerRole>([
  "main", "compressor", "lead", "challenger", "executor",
]));
const ROUTE_PICKER_FAILURE = "Route picker is unavailable.";
const CODING_TOOLS_REQUIRED: DesktopDisabledPresentation = Object.freeze({
  code: "model-not-runnable",
  label: "Dieses Modell unterstützt keine Werkzeuge für Coding-Aufgaben.",
  recoveryLabel: "Ein Modell mit Werkzeugunterstützung wählen",
});
const STATE = new WeakMap<RoutePickerAuthority, RoutePickerState>();

export function createRoutePickerAuthority(source: RoutePickerSource): RoutePickerAuthority {
  const state: RoutePickerState = { source, epoch: "", owned: new Map(), publicBySource: new Map() };
  const authority: RoutePickerAuthority = Object.freeze({
    view(request: RoutePickerRequest): RoutePickerView {
      assertRole(request);
      return projectCoreRoutePickerView(authority, request, readCapture(state)).view;
    },
    resolve(request: RoutePickerRequest, selection: RoutePickerSelectionIntent): ResolvedRoutePickerSelection {
      assertRole(request);
      if (!selection || typeof selection.handle !== "string") throw new Error("Route selection is unavailable.");
      return resolveCoreRoutePickerSelection(authority, request, selection, readCapture(state));
    },
  });
  STATE.set(authority, state);
  return authority;
}

/** Core-only: resolves against one already-captured immutable authority view. */
export function resolveCoreRoutePickerSelection(
  authority: RoutePickerAuthority,
  request: RoutePickerRequest,
  selection: RoutePickerSelectionIntent,
  capture: RoutePickerCapture,
): ResolvedRoutePickerSelection {
      const state = STATE.get(authority);
      if (!state) throw new Error(ROUTE_PICKER_FAILURE);
      assertRole(request);
      capture = validateCapture(capture);
      if (!selection || typeof selection.handle !== "string") throw new Error("Route selection is unavailable.");
      const snapshot = capture.snapshot;
      syncEpoch(state, snapshot);
      retireCapturedDrift(state, snapshot, capture.bindings);
      if (selection.revision !== snapshot.revision || selection.generation !== snapshot.generation) {
        throw new Error("Route selection is stale.");
      }
      const binding = state.owned.get(selection.handle);
      if (!binding || state.publicBySource.get(binding.sourceHandle)?.handle !== selection.handle) {
        throw new Error("Route selection is unavailable.");
      }
      const currentCandidates = sourceCandidates(snapshot);
      const currentMatches = currentCandidates.filter((candidate) => candidate.handle === binding.sourceHandle);
      if (currentMatches.length !== 1) throw new Error("Route selection has a duplicate or missing binding.");
      const current = currentMatches[0]!;
      if (!requestAllows(request, current) || !samePublicCandidate(binding.candidate, current)) {
        throw new Error("Route selection does not match the current route.");
      }
      const roleCandidate = candidateForRole(current, request, capture);
      if (!roleCandidate.runnable || roleCandidate.disabled) throw new Error("Route selection is unavailable.");
      const privateBinding = capture.bindings.get(binding.sourceHandle);
      if (!privateBinding || exactRouteKey(privateBinding) !== binding.bindingKey
        || !privateRouteMatchesCandidate(privateBinding, current)) {
        throw new Error("Route selection does not match the current runtime binding.");
      }
      const selectedIdentity = canonicalRouteIdentityKey(privateBinding.route);
      let identityOccurrences = 0;
      for (const candidate of currentCandidates) {
        if (!requestAllows(request, candidate)) continue;
        const candidateBinding = capture.bindings.get(candidate.handle);
        if (candidateBinding && privateRouteMatchesCandidate(candidateBinding, candidate)
          && canonicalRouteIdentityKey(candidateBinding.route) === selectedIdentity) identityOccurrences += 1;
      }
      if (identityOccurrences !== 1) throw new Error("Route selection is ambiguous.");
      return Object.freeze({
        selection: Object.freeze({ handle: selection.handle, revision: selection.revision, generation: selection.generation }),
        candidate: rebuildCandidate(roleCandidate, selection.handle),
        route: Object.freeze(structuredClone(privateBinding.route)),
        connectionId: privateBinding.connectionId,
      });
}

/** Core-only: projects one already-captured snapshot without rereading its source. */
export function projectCoreRoutePickerView(
  authority: RoutePickerAuthority,
  request: RoutePickerRequest,
  capture: RoutePickerCapture,
): CoreRoutePickerProjection {
  assertRole(request);
  const state = STATE.get(authority);
  if (!state) throw new Error(ROUTE_PICKER_FAILURE);
  try {
    capture = validateCapture(capture);
    const snapshot = capture.snapshot;
    const all = sourceCandidates(snapshot);
    const seenSourceHandles = new Set(all.map((candidate) => candidate.handle));
    const privateRoutes = new Set<string>();
    for (const candidate of all) {
      const privateBinding = capture.bindings.get(candidate.handle)!;
      if (requestAllows(request, candidate)) {
        const privateRouteKey = canonicalRouteIdentityKey(privateBinding.route);
        if (privateRoutes.has(privateRouteKey)) throw new Error("duplicate-private-route");
        privateRoutes.add(privateRouteKey);
      }
    }
    const nextEpoch = `${snapshot.revision}:${snapshot.generation}`;
    const nextOwned = nextEpoch === state.epoch ? new Map(state.owned) : new Map<string, OwnedRoutePickerBinding>();
    const nextPublicBySource = nextEpoch === state.epoch
      ? new Map(state.publicBySource) : new Map<string, PublicSourceBinding>();
    for (const [sourceHandle, publicBinding] of nextPublicBySource) {
      if (!seenSourceHandles.has(sourceHandle)) {
        nextPublicBySource.delete(sourceHandle);
        nextOwned.delete(publicBinding.handle);
      }
    }
    for (const candidate of all) {
      const current = nextPublicBySource.get(candidate.handle);
      if (current && current.bindingKey !== exactRouteKey(capture.bindings.get(candidate.handle)!)) {
        nextOwned.delete(current.handle);
        nextPublicBySource.delete(candidate.handle);
      }
    }
    const handles = new Map<string, string>();
    const candidates = all.filter((candidate) => requestAllows(request, candidate)).map((candidate) => {
      const privateBinding = capture.bindings.get(candidate.handle)!;
      const bindingKey = exactRouteKey(privateBinding);
      let publicBinding = nextPublicBySource.get(candidate.handle);
      if (!publicBinding || publicBinding.bindingKey !== bindingKey) {
        if (publicBinding) nextOwned.delete(publicBinding.handle);
        publicBinding = { handle: randomUUID(), bindingKey };
        nextPublicBySource.set(candidate.handle, publicBinding);
      }
      const projected = rebuildCandidate(candidate, publicBinding.handle);
      nextOwned.set(publicBinding.handle, {
        sourceHandle: candidate.handle,
        candidate: rebuildCandidate(projected, projected.handle),
        bindingKey,
      });
      handles.set(candidate.handle, publicBinding.handle);
      return rebuildCandidate(candidateForRole(candidate, request, capture), projected.handle);
    });
    const view: RoutePickerView = Object.freeze({
      revision: snapshot.revision, generation: snapshot.generation, candidates: Object.freeze(candidates),
    });
    state.epoch = nextEpoch;
    state.owned = nextOwned;
    state.publicBySource = nextPublicBySource;
    return Object.freeze({ view, handleForSource: (sourceHandle: string) => handles.get(sourceHandle) });
  } catch {
    throw new Error(ROUTE_PICKER_FAILURE);
  }
}

export function validateResolvedRoutePickerPair(first: ResolvedRoutePickerSelection, second: ResolvedRoutePickerSelection): void {
  if (sameCanonicalRouteIdentity(first.route, second.route)) {
    throw new Error("Paired route-picker roles need two distinct routes.");
  }
}

/** Core-only: proves the exact inner result against one deferred rebound capture. */
export async function proveActivatedRoutePickerSelection(
  authority: RoutePickerAuthority,
  target: ResolvedRoutePickerSelection,
  accepted: AcceptedRoutePickerActivation,
  reboundCapture: () => RoutePickerCapture | Promise<RoutePickerCapture>,
): Promise<AcceptedRoutePickerActivation> {
  const capture = validateCapture(await reboundCapture());
  const snapshot = capture.snapshot;
  if (snapshot.revision !== accepted.revision || snapshot.generation !== accepted.generation
    || snapshot.activeRoute?.routeHandle !== accepted.routeHandle || !snapshot.routeRunnable) {
    throw new Error("Route selection is unavailable.");
  }
  const projection = projectCoreRoutePickerView(authority, { role: "main", connectionId: target.connectionId }, capture);
  const publicHandle = projection.handleForSource(accepted.routeHandle);
  if (!publicHandle) throw new Error("Route selection is unavailable.");
  const rebound = resolveCoreRoutePickerSelection(authority, { role: "main", connectionId: target.connectionId }, {
    handle: publicHandle, revision: snapshot.revision, generation: snapshot.generation,
  }, capture);
  if (rebound.connectionId !== target.connectionId || exactRouteKey(rebound) !== exactRouteKey(target)) {
    throw new Error("Route selection is unavailable.");
  }
  return Object.freeze({ routeHandle: publicHandle, revision: snapshot.revision, generation: snapshot.generation });
}

function assertRole(request: RoutePickerRequest): void {
  if (!request || !ROUTE_PICKER_ROLES.has(request.role)) throw new Error("Route picker role is unavailable.");
}
function readCapture(state: RoutePickerState): RoutePickerCapture {
  try { return state.source.capture(); } catch { throw new Error(ROUTE_PICKER_FAILURE); }
}

function validateCapture(source: RoutePickerCapture): RoutePickerCapture {
  try {
    const rawSnapshot = structuredClone(source.snapshot);
    const candidates = sourceCandidates(rawSnapshot);
    const seen = new Set<string>();
    const rebuiltBySource = new Map<string, DesktopRoutePickerCandidate>();
    for (const candidate of candidates) {
      if (seen.has(candidate.handle)) throw new Error("duplicate-source");
      seen.add(candidate.handle);
      rebuiltBySource.set(candidate.handle, rebuildCandidate(candidate, candidate.handle));
    }
    const bindings = new Map<string, RoutePickerBinding>();
    for (const [rawHandle, rawBinding] of source.bindings) {
      const handle = String(rawHandle);
      if (!seen.has(handle) || bindings.has(handle)) throw new Error("extra-binding");
      const binding = Object.freeze({
        connectionId: rawBinding.connectionId,
        route: Object.freeze(structuredClone(rawBinding.route)),
      });
      if (!privateRouteMatchesCandidate(binding, rebuiltBySource.get(handle)!)) throw new Error("binding-mismatch");
      exactRouteKey(binding);
      bindings.set(handle, binding);
    }
    if (bindings.size !== seen.size) throw new Error("missing-binding");
    const codingIneligibleHandles = new Set<string>();
    for (const handle of source.codingIneligibleHandles ?? []) {
      const candidate = rebuiltBySource.get(handle);
      if (!candidate || candidate.capabilities.includes("tools")) throw new Error("invalid-coding-eligibility");
      codingIneligibleHandles.add(handle);
    }
    const providers = rawSnapshot.providers.map((provider) => Object.freeze({
      ...provider,
      routes: Object.freeze(provider.routes.map((candidate) => rebuiltBySource.get(candidate.handle)!)),
    }));
    const snapshot = Object.freeze({ ...rawSnapshot, providers: Object.freeze(providers) });
    return Object.freeze({ snapshot, bindings, codingIneligibleHandles });
  } catch { throw new Error(ROUTE_PICKER_FAILURE); }
}
function syncEpoch(state: RoutePickerState, snapshot: DesktopCapabilitySnapshot): void {
  const nextEpoch = `${snapshot.revision}:${snapshot.generation}`;
  if (nextEpoch === state.epoch) return;
  state.epoch = nextEpoch; state.owned.clear(); state.publicBySource.clear();
}
function retireCapturedDrift(
  state: RoutePickerState,
  snapshot: DesktopCapabilitySnapshot,
  bindings: ReadonlyMap<string, RoutePickerBinding>,
): void {
  const present = new Set(sourceCandidates(snapshot).map((candidate) => candidate.handle));
  const nextOwned = new Map(state.owned);
  const nextPublic = new Map(state.publicBySource);
  for (const [sourceHandle, current] of nextPublic) {
    const binding = bindings.get(sourceHandle);
    if (!present.has(sourceHandle) || !binding || current.bindingKey !== exactRouteKey(binding)) {
      nextOwned.delete(current.handle);
      nextPublic.delete(sourceHandle);
    }
  }
  state.owned = nextOwned;
  state.publicBySource = nextPublic;
}
function sourceCandidates(snapshot: DesktopCapabilitySnapshot): readonly DesktopRoutePickerCandidate[] {
  return snapshot.providers.flatMap((provider) => provider.routes.map((candidate) => Object.freeze({
    ...candidate,
    // The owning provider row is the authority for display copy. Never turn
    // the routing `providerId` into user-facing text.
    providerLabel: provider.providerLabel,
  })));
}
function requestAllows(request: RoutePickerRequest, candidate: DesktopRoutePickerCandidate): boolean {
  return (request.connectionId === undefined || candidate.connectionId === request.connectionId)
    && candidate.capabilities.includes("text");
}
function candidateForRole(
  candidate: DesktopRoutePickerCandidate,
  request: RoutePickerRequest,
  capture: RoutePickerCapture,
): DesktopRoutePickerCandidate {
  return request.role !== "compressor" && capture.codingIneligibleHandles?.has(candidate.handle)
    ? { ...candidate, runnable: false, disabled: candidate.disabled ?? CODING_TOOLS_REQUIRED }
    : candidate;
}
function samePublicCandidate(projected: DesktopRoutePickerCandidate, current: DesktopRoutePickerCandidate): boolean {
  // `handle` is intentionally excluded: the authority owns a reminted public
  // handle while `current` still carries the core-private source handle.
  return projected.providerId === current.providerId && projected.providerLabel === current.providerLabel
    && projected.connectionId === current.connectionId
    && projected.accountLabel === current.accountLabel
    && projected.canonicalModelId === current.canonicalModelId
    && projected.displayName === current.displayName
    && projected.reasoning === current.reasoning
    && sameCapabilities(projected.capabilities, current.capabilities)
    && sameCost(projected.cost, current.cost)
    && sameDataPolicy(projected.dataPolicy, current.dataPolicy)
    && projected.runnable === current.runnable
    && sameDisabled(projected.disabled, current.disabled);
}
function sameCapabilities(
  projected: DesktopRouteCandidate["capabilities"],
  current: DesktopRouteCandidate["capabilities"],
): boolean {
  if (projected.length !== current.length) return false;
  const projectedSorted = [...projected].sort();
  const currentSorted = [...current].sort();
  return projectedSorted.every((capability, index) => capability === currentSorted[index]);
}
function sameCost(projected: DesktopCostKnowledge, current: DesktopCostKnowledge): boolean {
  if (projected.kind !== current.kind || projected.label !== current.label) return false;
  return projected.kind === "unknown" || (current.kind === "known" && projected.source === current.source);
}
function sameDataPolicy(projected: DesktopDataPolicyKnowledge, current: DesktopDataPolicyKnowledge): boolean {
  if (projected.kind !== current.kind || projected.label !== current.label) return false;
  return projected.kind === "unknown" || (current.kind === "known" && projected.source === current.source);
}
function sameDisabled(
  projected: DesktopDisabledPresentation | undefined,
  current: DesktopDisabledPresentation | undefined,
): boolean {
  if (!projected || !current) return projected === current;
  return projected.code === current.code && projected.label === current.label
    && projected.recoveryLabel === current.recoveryLabel;
}
function privateRouteMatchesCandidate(binding: RoutePickerBinding, candidate: DesktopRoutePickerCandidate): boolean {
  return binding.connectionId === candidate.connectionId && binding.route.backendId === candidate.providerId
    && binding.route.resolutionState === "resolved" && binding.route.canonicalModelId === candidate.canonicalModelId;
}
function sameCanonicalRouteIdentity(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return canonicalRouteIdentityKey(left) === canonicalRouteIdentityKey(right);
}
function canonicalRouteIdentityKey(route: RouteIdentityV1): string {
  return JSON.stringify([route.backendId, route.accountFingerprint, route.billingRealm, route.canonicalModelId]);
}
function exactRouteKey(binding: RoutePickerBinding): string {
  const route = binding.route;
  return JSON.stringify([
    binding.connectionId, route.version, route.backendId, route.accountFingerprint,
    route.billingRealm, route.requestedModelId, route.canonicalModelId, route.resolutionState,
  ]);
}
function rebuildCandidate(candidate: DesktopRoutePickerCandidate, handle: string): DesktopRoutePickerCandidate {
  const cost: DesktopCostKnowledge = candidate.cost.kind === "known"
    ? Object.freeze({ kind: "known", label: candidate.cost.label, source: candidate.cost.source })
    : Object.freeze({ kind: "unknown", label: "Kosten unbekannt" });
  const dataPolicy: DesktopDataPolicyKnowledge = candidate.dataPolicy.kind === "known"
    ? Object.freeze({ kind: "known", label: candidate.dataPolicy.label, source: candidate.dataPolicy.source })
    : Object.freeze({ kind: "unknown", label: "Datenrichtlinie unbekannt" });
  const disabled: DesktopDisabledPresentation | undefined = candidate.disabled ? Object.freeze({
    code: candidate.disabled.code, label: candidate.disabled.label,
    ...(candidate.disabled.recoveryLabel === undefined ? {} : { recoveryLabel: candidate.disabled.recoveryLabel }),
  }) : undefined;
  return Object.freeze({
    handle, providerId: candidate.providerId, providerLabel: candidate.providerLabel,
    connectionId: candidate.connectionId,
    accountLabel: candidate.accountLabel, canonicalModelId: candidate.canonicalModelId,
    displayName: candidate.displayName, reasoning: candidate.reasoning,
    capabilities: Object.freeze([...candidate.capabilities]), cost, dataPolicy,
    runnable: candidate.runnable, ...(disabled ? { disabled } : {}),
  });
}
