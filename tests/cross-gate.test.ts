import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CROSS_GATE_ARMED_CONTINUATION_DETAIL,
  CROSS_GATE_ARMED_IDLE_DETAIL,
  CROSS_GATE_ARMED_RUNNING_DETAIL,
  CROSS_GATE_CALL_RANGE,
  CROSS_GATE_CODING_ROLE_LABEL,
  CROSS_GATE_CONTINUATION_TASK,
  CROSS_GATE_INCOMPLETE_REASON,
  CROSS_GATE_KEEP_ACTIVE_LABEL,
  CROSS_GATE_NOT_SET,
  CROSS_GATE_PENDING_ONESHOT_DETAIL,
  CROSS_GATE_PUBLISHING_LABEL,
  CROSS_GATE_REVIEW_ROLE_LABEL,
  CROSS_GATE_SAME_ROUTE_REASON,
  CROSS_GATE_START_LABEL,
  CROSS_GATE_SWAP_LABEL,
  CROSS_GATE_THINKING_SEPARATOR,
  crossGateConsequence,
  crossGateContinuationTaskLabel,
  crossGateKeepActiveConsequence,
  CROSS_GATE_FOLLOW_ROUND_DISCLOSURE,
  crossGateConsequenceParts,
  desktopCrossPreflight,
  desktopCrossRoutePresentation,
  formatCrossGateConsequence,
  runCrossGate,
  type CrossGateAction,
  type CrossGateDeps,
  type CrossGateView,
} from "../src/cross-gate.js";
import {
  createCrossCommandRuntime,
  createDashboardCrossGateSurface,
  createPlainCrossGateSurface,
} from "../src/cli.js";
import type { CrossPreferencesV1, CrossRunResult } from "../src/collaboration.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import type { DesktopCapabilitySnapshot, DesktopRouteCandidate } from "../src/desktop-contracts.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";
import { estimatePanelModelCostUsd, modelCapabilities } from "../src/openrouter.js";
import {
  createRoutePickerAuthority,
  type DesktopRoutePickerCandidate,
} from "../src/route-picker.js";
import type { ModelInfo } from "../src/types.js";
import type { ChoicePickerItem } from "../src/tui.js";

function route(model: string, account = `acct-${model}`): RouteIdentityV1 {
  return Object.freeze({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: account,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
}

function candidate(value: RouteIdentityV1): SelectableModelRoute {
  return {
    route: value,
    providerLabel: "OpenRouter",
    model: {
      id: value.requestedModelId,
      name: value.requestedModelId,
      contextLength: 128_000,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: false,
  };
}

function modelInfo(id: string, promptPrice: number, completionPrice: number): ModelInfo {
  return {
    id,
    name: id,
    description: "",
    contextLength: 128_000,
    promptPrice,
    completionPrice,
    supportedParameters: [],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}

function desktopRoute(
  handle: string,
  model: string,
  accountLabel: string,
): DesktopRoutePickerCandidate {
  return {
    handle,
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    connectionId: `connection-${handle}`,
    accountLabel,
    canonicalModelId: model,
    displayName: model,
    reasoning: "supported",
    capabilities: ["text", "tools"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    runnable: true,
  };
}

test("Desktop Cross starts empty and disabled", () => {
  const projection = desktopCrossPreflight({
    leadCandidate: null,
    challengerCandidate: null,
    consequence: { callRange: CROSS_GATE_CALL_RANGE, cost: "unknown" },
    canStart: false,
  }, null);

  assert.equal(projection.lead, null);
  assert.equal(projection.challenger, null);
  assert.equal(projection.duration, null);
  assert.deepEqual(projection.startDisabled, {
    code: "cross-selection-incomplete",
    label: "Lead, Challenger und Dauer auswählen",
    recoveryLabel: "Beide Modelle und Dauer wählen",
  });
  assert.deepEqual(projection.estimatedCalls, { min: 4, max: 6 });
  assert.deepEqual(projection.cost, { kind: "unknown", label: "Kosten unbekannt" });
});

test("Desktop Cross presents same-named routes by safe provider, account and canonical model identity", () => {
  const first = {
    ...desktopRoute("first", "vendor/first-model", "Privat"),
    providerLabel: "Provider Eins",
    displayName: "Shared Model",
  };
  const second = {
    ...desktopRoute("second", "vendor/second-model", "Privat"),
    providerLabel: "Provider Zwei",
    displayName: "Shared Model",
  };

  assert.equal(
    desktopCrossRoutePresentation(first),
    "Provider Eins · Privat · Shared Model · vendor/first-model",
  );
  assert.equal(
    desktopCrossRoutePresentation(second),
    "Provider Zwei · Privat · Shared Model · vendor/second-model",
  );
  assert.notEqual(desktopCrossRoutePresentation(first), desktopCrossRoutePresentation(second));
});

test("Desktop Cross enables only two explicit distinct runnable routes plus duration", () => {
  const lead = desktopRoute("lead", "openai/gpt-5.4-codex", "Codex Privat");
  const challenger = desktopRoute("challenger", "moonshotai/kimi-k3", "Kimi Privat");
  const consequence = { callRange: CROSS_GATE_CALL_RANGE, cost: { min: 0.04, max: 0.08 } } as const;

  const missingDuration = desktopCrossPreflight({
    leadCandidate: lead,
    challengerCandidate: challenger,
    consequence,
    canStart: true,
  }, null);
  assert.equal(missingDuration.startDisabled?.code, "cross-selection-incomplete");

  const ready = desktopCrossPreflight({
    leadCandidate: lead,
    challengerCandidate: challenger,
    consequence,
    canStart: true,
  }, "one-task");
  assert.equal(ready.startDisabled, null);
  assert.deepEqual(ready.cost, {
    kind: "known",
    label: "Mindestens $0.040–$0.080",
    source: "provider",
  });

  const same = desktopCrossPreflight({
    leadCandidate: lead,
    challengerCandidate: {
      ...challenger,
      providerId: lead.providerId,
      connectionId: lead.connectionId,
      canonicalModelId: lead.canonicalModelId,
    },
    consequence,
    canStart: false,
  }, "chat");
  assert.deepEqual(same.startDisabled, {
    code: "cross-routes-must-differ",
    label: "Lead und Challenger müssen verschieden sein",
    recoveryLabel: "Anderes Modell wählen",
  });
});

test("desktop journey route generations cannot silently mix at the final Cross proof", async () => {
  const actions: CrossGateAction[] = ["coding", "review", "start"];
  const h = gateHarness({ chooseGate: async () => actions.shift() ?? null });
  const intents = {
    lead: { handle: "lead", revision: 4, generation: 8 },
    challenger: { handle: "challenger", revision: 4, generation: 8 },
  } as const;
  let finalProofs = 0;
  await runCrossGate({
    ...h.deps,
    publicPicker: { async pickModelRoute(input) { return intents[input.request.role as keyof typeof intents]; } },
    routeAuthority: {
      view(request) {
        const role = request.role as keyof typeof intents;
        return { revision: 4, generation: 8, candidates: [desktopRoute(role, role, `${role} account`)] };
      },
      resolve(request, intent) {
        const role = request.role as keyof typeof intents;
        if (++finalProofs > 2 && role === "challenger") throw new Error("stale generation");
        return {
          selection: intent,
          candidate: desktopRoute(role, role, `${role} account`),
          route: route(role),
          connectionId: role,
        };
      },
    },
  }, "journey task");
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.publishes, []);
  assert.deepEqual(h.restores, ["journey task"]);
});

/** Minimal fake CrossCommandPort slice — no real coordinator involved. */
function gateHarness(overrides: {
  preferences?: CrossPreferencesV1;
  chooseGate?: (view: CrossGateView) => Promise<CrossGateAction | null>;
  pickModelRoute?: SelectableModelRoute | null;
  unavailableReason?: string | null;
  cachedModels?: readonly ModelInfo[];
  publishPreferences?: (next: CrossPreferencesV1) => Promise<void>;
  start?: (task: string, pair?: CrossPreferencesV1) => Promise<CrossRunResult>;
  launchRun?: (run: Promise<CrossRunResult>) => void;
  armForChat?: (pair: CrossPreferencesV1) => Promise<void>;
  armPendingOneShot?: (pair: CrossPreferencesV1) => Promise<void>;
  chatHistoryCount?: number;
  chatContextChars?: number;
  thinkingLabel?: (route: RouteIdentityV1) => string | null;
} = {}) {
  const starts: string[] = [];
  const startPairs: Array<CrossPreferencesV1 | undefined> = [];
  const restores: string[] = [];
  const publishes: CrossPreferencesV1[] = [];
  const armed: CrossPreferencesV1[] = [];
  const armedOneShot: CrossPreferencesV1[] = [];
  const activations: Array<{ pair: CrossPreferencesV1; detail: string }> = [];
  const pickerCalls: Array<{ role: string; current: RouteIdentityV1 | null; exclude?: RouteIdentityV1 }> = [];
  let preferences: CrossPreferencesV1 = overrides.preferences ?? { lead: null, challenger: null };
  const views: CrossGateView[] = [];
  const actions = overrides.chooseGate;
  const deps: CrossGateDeps = {
    port: {
      async start(task, pair) {
        starts.push(task);
        startPairs.push(pair === undefined ? undefined : structuredClone(pair));
        return overrides.start
          ? overrides.start(task, pair)
          : { phase: "completed", snapshot: {} } as unknown as CrossRunResult;
      },
    },
    launchRun: overrides.launchRun,
    picker: {
      async pickModelRoute(request) {
        pickerCalls.push({ role: request.role, current: request.current, exclude: request.exclude });
        return overrides.pickModelRoute ?? null;
      },
    },
    readPreferences: () => structuredClone(preferences),
    publishPreferences: overrides.publishPreferences ?? (async (next) => {
      publishes.push(structuredClone(next));
      preferences = structuredClone(next);
    }),
    surface: {
      async chooseGate(view) {
        views.push(view);
        return actions ? actions(view) : null;
      },
    },
    restoreDraft: (draft: string) => { restores.push(draft); },
    unavailableReason: () => overrides.unavailableReason ?? null,
    cachedModels: () => overrides.cachedModels ?? [],
    armForChat: overrides.armForChat ?? (async (pair) => { armed.push(structuredClone(pair)); }),
    armPendingOneShot: overrides.armPendingOneShot ?? (async (pair) => { armedOneShot.push(structuredClone(pair)); }),
    notifyActivated: (pair, detail) => { activations.push({ pair: structuredClone(pair), detail }); },
    chatHistoryCount: () => overrides.chatHistoryCount ?? 0,
    // FIX-14 ticket 4: `chatContextChars` is a REQUIRED dep now, so the
    // harness always supplies it. A double that means "no packet" says 0
    // explicitly instead of omitting the dep and letting the gate invent
    // the same number silently.
    chatContextChars: () => overrides.chatContextChars ?? 0,
    ...(overrides.thinkingLabel ? { thinkingLabel: overrides.thinkingLabel } : {}),
  };
  return { deps, starts, startPairs, restores, publishes, armed, armedOneShot, activations, pickerCalls, views };
}

test("stored valid pair confirms once and starts exactly once with the preserved task", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => "start",
  });

  await runCrossGate(h.deps, "prüfe exakt einmal");

  assert.deepEqual(h.starts, ["prüfe exakt einmal"]);
  assert.deepEqual(h.startPairs, [{ lead, challenger }], "the confirmed exact pair must cross the start seam");
  assert.deepEqual(h.publishes, [], "an already-durable pair must not be republished");
  assert.equal(h.restores.length, 0);
  assert.equal(h.views.length, 1, "exactly one confirmation screen before start");
  assert.equal(h.views[0]!.canStart, true);
  assert.equal(h.views[0]!.startBlockedReason, null);
});

test("opaque Cross ignores stored preferences, requires two explicit intents, and resolves both before publishing", async () => {
  const old = { lead: route("vendor/old-lead"), challenger: route("vendor/old-review") };
  const selected = {
    lead: route("vendor/same", "acct-lead"),
    challenger: route("vendor/same", "acct-review"),
  };
  const actions: CrossGateAction[] = ["coding", "review", "start"];
  const h = gateHarness({
    preferences: old,
    cachedModels: [modelInfo("vendor/same", 0.000003, 0.000015)],
    chooseGate: async () => actions.shift() ?? null,
  });
  const intents = {
    lead: { handle: "lead-handle", revision: 4, generation: 8 },
    challenger: { handle: "review-handle", revision: 4, generation: 8 },
  } as const;
  const resolveOrder: string[] = [];
  const publicRows = (role: "lead" | "challenger") => [{
    handle: intents[role].handle, providerId: "openrouter", providerLabel: "OpenRouter", connectionId: `connection-${role}`,
    accountLabel: role, canonicalModelId: "vendor/same", displayName: "Same model",
    reasoning: "supported" as const, capabilities: ["text", "tools"] as const,
    cost: { kind: "unknown" as const, label: "Kosten unbekannt" as const },
    dataPolicy: { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const },
    runnable: true,
  }];
  await runCrossGate({
    ...h.deps,
    publicPicker: { async pickModelRoute(input) { return intents[input.request.role as "lead" | "challenger"]; } },
    routeAuthority: {
      view(request) { return { revision: 4, generation: 8, candidates: publicRows(request.role as "lead" | "challenger") }; },
      resolve(request, intent) {
        const role = request.role as "lead" | "challenger";
        resolveOrder.push(role);
        assert.deepEqual(intent, intents[role]);
        return { selection: intent, candidate: publicRows(role)[0]!, route: selected[role], connectionId: `connection-${role}` };
      },
    },
  }, "explicit task");
  assert.equal(h.views[0]!.canStart, false, "saved routes must not become implicit selections");
  assert.deepEqual(resolveOrder, ["lead", "challenger", "lead", "challenger"],
    "each intent resolves when staged and again immediately before effects");
  assert.notEqual(h.views[2]?.consequence?.cost, "unknown",
    "the fully staged opaque pair must expose its known cached consequence before Start");
  assert.deepEqual(h.publishes, [selected], "same model on distinct accounts remains a valid exact pair");
  assert.deepEqual(h.starts, ["explicit task"]);
});

test("opaque Cross re-resolves both intents at Start and either stale intent has zero effects", async () => {
  const intent = (role: string) => ({ handle: role, revision: 1, generation: 1 });
  const row = (role: string) => ({
    handle: role, providerId: "openrouter", providerLabel: "OpenRouter", connectionId: role, accountLabel: role,
    canonicalModelId: role, displayName: role, reasoning: "supported" as const,
    capabilities: ["text", "tools"] as const,
    cost: { kind: "unknown" as const, label: "Kosten unbekannt" as const },
    dataPolicy: { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const },
    runnable: true,
  });
  for (const staleRole of ["lead", "challenger"] as const) {
    const actions: Array<CrossGateAction | null> = ["coding", "review", "start", null];
    const h = gateHarness({ chooseGate: async () => actions.shift() ?? null });
    const resolveCounts = { lead: 0, challenger: 0 };
    const resolveOrder: string[] = [];
    await runCrossGate({
      ...h.deps,
      publicPicker: { async pickModelRoute(input) { return intent(input.request.role); } },
      routeAuthority: {
        view(request) { return { revision: 1, generation: 1, candidates: [row(request.role)] }; },
        resolve(request, selection) {
          const role = request.role as "lead" | "challenger";
          resolveCounts[role] += 1;
          resolveOrder.push(`${role}:${resolveCounts[role]}`);
          if (role === staleRole && resolveCounts[role] === 2) throw new Error("stale at final proof");
          return { selection, candidate: row(request.role), route: route(request.role), connectionId: request.role };
        },
      },
    }, "task");
    assert.deepEqual(resolveOrder, staleRole === "lead"
      ? ["lead:1", "challenger:1", "lead:2"]
      : ["lead:1", "challenger:1", "lead:2", "challenger:2"]);
    assert.deepEqual(h.restores, ["task"], staleRole);
    assert.deepEqual(h.publishes, [], staleRole);
    assert.deepEqual(h.starts, [], staleRole);
    assert.deepEqual(h.armed, [], staleRole);
    assert.deepEqual(h.armedOneShot, [], staleRole);
    assert.deepEqual(h.activations, [], staleRole);
    const cleared = h.views.at(-1)!;
    assert.equal(cleared.coding, "Not selected", staleRole);
    assert.equal(cleared.review, "Not selected", staleRole);
    assert.equal(cleared.canStart, false, staleRole);
    assert.equal(desktopCrossPreflight(cleared, "one-task").startDisabled?.code, "route-stale", staleRole);
    assert.match(cleared.startBlockedReason ?? "", /Konten.*Cross erneut öffnen/i, staleRole);
  }
});

test("real route authority revocation at final Cross Start has zero effects and requires new selection", async () => {
  const desktopCandidate = (
    handle: string,
    connectionId: string,
    model: string,
    capabilities: DesktopRouteCandidate["capabilities"] = ["text", "tools"],
  ): DesktopRouteCandidate => ({
    handle, providerId: "openrouter", connectionId, accountLabel: connectionId,
    canonicalModelId: model, displayName: model, reasoning: "supported", capabilities,
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
  });
  const lead = desktopCandidate("source-lead", "connection-lead", "vendor/lead");
  const challenger = desktopCandidate("source-challenger", "connection-challenger", "vendor/challenger");
  const capabilitySnapshot = (leadCapabilities: DesktopRouteCandidate["capabilities"]): DesktopCapabilitySnapshot => ({
    schemaVersion: 1, revision: 17, generation: 23, routeRunnable: false, activeRoute: null,
    providers: [{
      providerId: "openrouter", providerLabel: "OpenRouter",
      connectionId: null, accountLabel: null, state: "ready",
      setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: true },
      routes: [{ ...lead, capabilities: leadCapabilities }, challenger],
    }],
    undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
  });
  let current = capabilitySnapshot(["text", "tools"]);
  const authority = createRoutePickerAuthority({
    capture: () => ({
      snapshot: current,
      bindings: new Map([
        [lead.handle, { connectionId: lead.connectionId, route: route(lead.canonicalModelId, "acct-lead") }],
        [challenger.handle, { connectionId: challenger.connectionId, route: route(challenger.canonicalModelId, "acct-challenger") }],
      ]),
    }),
  });
  const actions: Array<CrossGateAction | null> = ["coding", "review", "start", "coding", null];
  const h = gateHarness({
    chooseGate: async () => {
      const action = actions.shift() ?? null;
      if (action === "start") current = capabilitySnapshot(["text"]);
      return action;
    },
  });
  const pickerRoles: string[] = [];

  await runCrossGate({
    ...h.deps,
    publicPicker: {
      async pickModelRoute(input) {
        const role = input.request.role as "lead" | "challenger";
        pickerRoles.push(role);
        if (pickerRoles.length > 2) return null;
        const connectionId = role === "lead" ? lead.connectionId : challenger.connectionId;
        const selected = input.view.candidates.find((candidate) => candidate.connectionId === connectionId)!;
        return { handle: selected.handle, revision: input.view.revision, generation: input.view.generation };
      },
    },
    routeAuthority: authority,
  }, "revoked task");

  assert.deepEqual(pickerRoles, ["lead", "challenger", "lead"], "final proof must clear both roles and reopen selection");
  assert.deepEqual(h.publishes, []);
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.armed, []);
  assert.deepEqual(h.armedOneShot, []);
  assert.deepEqual(h.activations, []);
  assert.deepEqual(h.restores, ["revoked task"]);
  const cleared = h.views.at(-1)!;
  assert.equal(cleared.coding, "Not selected");
  assert.equal(cleared.review, "Not selected");
  assert.equal(cleared.canStart, false);
  assert.equal(desktopCrossPreflight(cleared, "one-task").startDisabled?.code, "route-stale");
  assert.match(cleared.startBlockedReason ?? "", /Konten.*Cross erneut öffnen/i);
});

test("opaque Cross swaps exact private identities and keep publishes then arms then starts", async () => {
  const actions: Array<CrossGateAction | null> = ["coding", "review", "swap", "keep-active"];
  const order: string[] = [];
  const h = gateHarness({
    chooseGate: async () => actions.shift() ?? null,
    publishPreferences: async (pair) => { order.push("publish"); h.publishes.push(structuredClone(pair)); },
    armForChat: async (pair) => { order.push("arm"); h.armed.push(structuredClone(pair)); },
    start: async (task) => { order.push(`start:${task}`); return { phase: "completed", snapshot: {} } as never; },
  });
  const a = route("vendor/a", "acct-a");
  const b = route("vendor/b", "acct-b");
  const intents = { lead: { handle: "a", revision: 1, generation: 1 }, challenger: { handle: "b", revision: 1, generation: 1 } } as const;
  const row = (handle: string) => ({
    handle, providerId: "openrouter", providerLabel: "OpenRouter", connectionId: `connection-${handle}`, accountLabel: handle,
    canonicalModelId: `vendor/${handle}`, displayName: handle, reasoning: "supported" as const,
    capabilities: ["text", "tools"] as const, cost: { kind: "unknown" as const, label: "Kosten unbekannt" as const },
    dataPolicy: { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const }, runnable: true,
  });
  await runCrossGate({ ...h.deps,
    publicPicker: { async pickModelRoute(input) { return intents[input.request.role as "lead" | "challenger"]; } },
    routeAuthority: {
      view() { return { revision: 1, generation: 1, candidates: [row("a"), row("b")] }; },
      resolve(_request, selection) {
        return { selection, candidate: row(selection.handle), route: selection.handle === "a" ? a : b, connectionId: `connection-${selection.handle}` };
      },
    },
  }, "swapped task");
  assert.deepEqual(h.publishes, [{ lead: b, challenger: a }]);
  assert.deepEqual(h.armed, [{ lead: b, challenger: a }]);
  assert.deepEqual(order, ["publish", "arm", "start:swapped task"]);
});

test("opaque Cross cancel and exact-same resolution have zero effects", async () => {
  for (const exactSame of [false, true]) {
    const actions: Array<CrossGateAction | null> = exactSame ? ["coding", "review", "start", null] : ["coding", null];
    const h = gateHarness({ chooseGate: async () => actions.shift() ?? null });
    const publicPicker = { async pickModelRoute(input: { request: { role: string } }) {
      return { handle: input.request.role, revision: 1, generation: 1 };
    } };
    await runCrossGate({ ...h.deps, publicPicker: publicPicker as never, routeAuthority: {
      view(request) { return { revision: 1, generation: 1, candidates: [{
        handle: request.role, providerId: "openrouter", providerLabel: "OpenRouter", connectionId: request.role, accountLabel: request.role,
        canonicalModelId: "same", displayName: "same", reasoning: "supported", capabilities: ["text", "tools"],
        cost: { kind: "unknown", label: "Kosten unbekannt" }, dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
      }] }; },
      resolve(request, selection) {
        const value = exactSame ? route("same", "same-account") : route(request.role);
        return { selection, candidate: this.view(request).candidates[0]!, route: value,
          connectionId: exactSame ? "same-connection" : request.role };
      },
    } }, "cancelled");
    assert.deepEqual(h.publishes, []);
    assert.deepEqual(h.starts, []);
    assert.deepEqual(h.armed, []);
    if (exactSame) {
      const completeView = h.views[2]!;
      assert.equal(completeView.canStart, false);
      assert.equal(completeView.startBlockedReason, CROSS_GATE_SAME_ROUTE_REASON);
    }
  }
});

test("opaque Cross blocks canonical duplicates with alias requested ids and distinct connection records before Start", async () => {
  const actions: Array<CrossGateAction | null> = ["coding", "review", "start"];
  const h = gateHarness({ chooseGate: async () => actions.shift() ?? null });
  const selections = {
    lead: { handle: "alias-a", revision: 1, generation: 1 },
    challenger: { handle: "alias-b", revision: 1, generation: 1 },
  } as const;
  await runCrossGate({ ...h.deps,
    publicPicker: { async pickModelRoute(input) { return selections[input.request.role as "lead" | "challenger"]; } },
    routeAuthority: {
      view(request) { return { revision: 1, generation: 1, candidates: [{
        handle: selections[request.role as "lead" | "challenger"].handle,
        providerId: "openrouter", providerLabel: "OpenRouter", connectionId: `connection-${request.role}`, accountLabel: "same owner",
        canonicalModelId: "vendor/canonical", displayName: String(request.role), reasoning: "supported",
        capabilities: ["text", "tools"], cost: { kind: "unknown", label: "Kosten unbekannt" },
        dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
      }] }; },
      resolve(request, selection) {
        return { selection, candidate: this.view(request).candidates[0]!, connectionId: `connection-${request.role}`,
          route: { ...route(`vendor/alias-${request.role}`, "same-owner"), canonicalModelId: "vendor/canonical" } };
      },
    },
  }, "canonical duplicate");
  assert.equal(h.views[2]?.canStart, false);
  assert.equal(h.views[2]?.startBlockedReason, CROSS_GATE_SAME_ROUTE_REASON);
  assert.deepEqual(h.publishes, []);
  assert.deepEqual(h.starts, []);
});

test("real Cross runtime preserves either partial public wiring and fails closed before legacy preferences", async () => {
  for (const half of ["picker", "authority"] as const) {
    let reads = 0;
    let starts = 0;
    const base = {
      worker: { async analyze() { throw new Error("unused"); }, async implement() { throw new Error("unused"); }, async review() { throw new Error("unused"); } },
      verification: { async run() { throw new Error("unused"); } },
      readPreferences: () => { reads += 1; return { lead: route("legacy/a"), challenger: route("legacy/b") }; },
      async publishPreferences() { throw new Error("must not publish"); },
      picker: { async pickModelRoute() { throw new Error("must not pick legacy"); } },
      surface: { restoreDraft() {}, discardDraft() {}, publishResult() {} },
      gateSurface: { async chooseGate() { starts += 1; return "start" as const; } },
      crossUnavailableReason: () => null,
      cachedModels: () => [], context: () => ({}),
    };
    const runtime = createCrossCommandRuntime({ ...base,
      ...(half === "picker" ? { publicPicker: { async pickModelRoute() { return null; } } } : {}),
      ...(half === "authority" ? { routeAuthority: { view() { throw new Error("unused"); }, resolve() { throw new Error("unused"); } } } : {}),
    } as never);
    await assert.rejects(runtime.openGate("draft"), /route picker is unavailable/i);
    assert.equal(reads, 0, half);
    assert.equal(starts, 0, half);
  }
});

test("opaque Cross rejects a no-tools candidate for either role at staging with zero effects", async () => {
  for (const role of ["lead", "challenger"] as const) {
    const actions: Array<CrossGateAction | null> = [role === "lead" ? "coding" : "review", null];
    const h = gateHarness({ chooseGate: async () => actions.shift() ?? null });
    const selection = { handle: `${role}-no-tools`, revision: 1, generation: 1 };
    await runCrossGate({ ...h.deps,
      publicPicker: { async pickModelRoute() { return selection; } },
      routeAuthority: {
        view() { return { revision: 1, generation: 1, candidates: [{
          handle: selection.handle, providerId: "openrouter", providerLabel: "OpenRouter", connectionId: role,
          accountLabel: role, canonicalModelId: `vendor/${role}`, displayName: role,
          reasoning: "supported", capabilities: ["text"],
          cost: { kind: "unknown", label: "Kosten unbekannt" },
          dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
        }] }; },
        resolve(request, intent) { return {
          selection: intent, candidate: this.view(request).candidates[0]!,
          route: route(`vendor/${role}`), connectionId: role,
        }; },
      },
    }, "blocked");
    assert.equal(h.views.at(-1)!.canStart, false, role);
    const presentation = desktopCrossPreflight(h.views.at(-1)!, "one-task");
    assert.equal(presentation.startDisabled?.code, "model-not-runnable");
    assert.match(presentation.startDisabled?.label ?? "", /Werkzeug/i);
    assert.match(presentation.startDisabled?.recoveryLabel ?? "", /Modell/i);
    assert.match(h.views.at(-1)!.startBlockedReason ?? "", /Werkzeug/i);
    assert.deepEqual(h.publishes, [], role);
    assert.deepEqual(h.starts, [], role);
    assert.deepEqual(h.armed, [], role);
  }
});

test("Cross prepares its catalogue before presenting role choices and reports refresh failure without effects", async () => {
  const order: string[] = [];
  const h = gateHarness({ chooseGate: async () => { order.push("gate"); return null; } });
  await runCrossGate({ ...h.deps,
    prepareRoutePicker: async () => { order.push("refresh"); throw new Error("PRIVATE_CATALOG_FAILURE"); },
    publicPicker: { async pickModelRoute() { throw new Error("must not pick"); } },
    routeAuthority: {
      view() { throw new Error("failed refresh must not read stale candidates"); },
      resolve() { throw new Error("must not resolve"); },
    },
  }, "preserved task");
  assert.deepEqual(order, ["refresh", "gate"]);
  assert.match(h.views[0]!.unavailableReason ?? "", /Modellkatalog/);
  assert.match(h.views[0]!.unavailableReason ?? "", /Konto|erneut|Einstellungen/);
  assert.doesNotMatch(JSON.stringify(h.views), /PRIVATE_CATALOG_FAILURE/);
  assert.deepEqual(h.restores, ["preserved task"]);
  assert.deepEqual(h.publishes, []);
  assert.deepEqual(h.starts, []);
});

for (const fails of [false, true]) {
  test(`Cross catalogue loading is visible and clears after delayed ${fails ? "failure" : "success"}`, async () => {
    const h = gateHarness();
    const statuses: Array<{ text: string; busy: boolean | undefined }> = [];
    let finish!: () => void;
    const preparation = new Promise<void>((resolve, reject) => {
      finish = () => fails ? reject(new Error("PRIVATE_CATALOG_FAILURE")) : resolve();
    });
    const surface = createDashboardCrossGateSurface({
      setStatus(text, busy) { statuses.push({ text, busy }); },
      async pickChoice() { throw new Error("legacy picker must not run"); },
    }, {
      publishPreflight() {},
      async pickPreflightChoice() { return null; },
      async confirmStart() { throw new Error("must not confirm"); },
    });
    const pending = runCrossGate({ ...h.deps, surface,
      prepareRoutePicker: () => preparation,
      publicPicker: { async pickModelRoute() { throw new Error("must not select"); } },
      routeAuthority: {
        view() { return { revision: 7, generation: 4, candidates: [] }; },
        resolve() { throw new Error("must not resolve"); },
      },
    }, "preserved task");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(statuses, [{ text: "Modellkatalog wird geladen …", busy: true }]);
    } finally {
      finish();
      await pending;
    }
    assert.deepEqual(statuses[1], { text: "Bereit", busy: false });
    if (fails) assert.match(statuses.at(-1)!.text, /Modellkatalog konnte nicht geladen/);
    assert.doesNotMatch(JSON.stringify(statuses), /PRIVATE_CATALOG_FAILURE/);
    assert.deepEqual(h.restores, ["preserved task"]);
    assert.deepEqual(h.publishes, []);
    assert.deepEqual(h.starts, []);
  });
}

test("when a launchRun hook is provided, the gate hands off the started run and returns without awaiting it", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  let release!: (result: CrossRunResult) => void;
  const pending = new Promise<CrossRunResult>((resolve) => { release = resolve; });
  let handedOff: Promise<CrossRunResult> | null = null;
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => "start",
    start: async () => pending,
    launchRun: (run) => { handedOff = run; },
  });

  const gateVisit = runCrossGate(h.deps, "background task");
  const returnedImmediately = await Promise.race([
    gateVisit.then(() => true),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(returnedImmediately, true, "openGate must not block on the run itself once handed off");
  assert.ok(handedOff, "the started run must be handed to launchRun");
  assert.deepEqual(h.starts, ["background task"]);

  const completed: CrossRunResult = { phase: "completed", snapshot: {} } as unknown as CrossRunResult;
  release(completed);
  assert.equal(await handedOff, completed);
  await gateVisit;
});

test("cancel restores the draft and never starts", async () => {
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: route("vendor/challenger") },
    chooseGate: async () => null,
  });

  await runCrossGate(h.deps, "unfinished thought");

  assert.deepEqual(h.starts, []);
  assert.equal(h.restores.length, 1);
  // FIX-20, finding 6: WHAT is restored, not just that something was. The
  // gate hands the exact pending task back, which is the only way the
  // `/cross run <task>` argument path can be restored at all — its text
  // never passed through the composer, so the surface has nothing of its
  // own to put back.
  assert.deepEqual(h.restores, ["unfinished thought"]);
});

/**
 * FIX-20, finding 6: `/cross run <task>` + Esc silently discarded the task.
 * The argument path reaches `runCrossGate` exactly like a composer draft
 * does (`openGate(args.join(" "))`, commands.ts), so the same restore
 * contract has to hold for it — and it is the case where the surface has
 * nothing captured to fall back on.
 */
test("cancelling a gate opened from a command argument hands that argument text back", async () => {
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: route("vendor/challenger") },
    chooseGate: async () => null,
  });

  await runCrossGate(h.deps, "refactor the frame builder");

  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.restores, ["refactor the frame builder"]);
});

test("an incomplete pair disables Start with the concrete reason and blocks a forced start", async () => {
  let calls = 0;
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: null },
    // Simulates a malicious surface forcing Start despite the disabled row.
    chooseGate: async () => { calls += 1; return calls === 1 ? "start" : null; },
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.starts, [], "Start must never fire while the pair is incomplete");
  assert.equal(h.views[0]!.canStart, false);
  assert.equal(h.views[0]!.startBlockedReason, CROSS_GATE_INCOMPLETE_REASON);
  assert.equal(h.views.length, 1, "a forced blocked action must fail closed instead of looping");
  assert.deepEqual(h.restores, ["draft"]);
});

test("a same-canonical-route pair disables Start with the distinct-models reason", async () => {
  let calls = 0;
  const shared = route("vendor/shared");
  const h = gateHarness({
    preferences: { lead: shared, challenger: structuredClone(shared) },
    chooseGate: async () => { calls += 1; return calls === 1 ? "start" : null; },
  });

  await runCrossGate(h.deps, "draft");

  assert.equal(h.views[0]!.canStart, false);
  assert.equal(h.views[0]!.startBlockedReason, CROSS_GATE_SAME_ROUTE_REASON);
  assert.deepEqual(h.starts, []);
});

test("a staged role change is never published on its own — only together with Start", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  let calls = 0;
  const h = gateHarness({
    preferences: { lead, challenger },
    pickModelRoute: candidate(replacement),
    chooseGate: async () => {
      calls += 1;
      if (calls === 1) return "coding";
      return null; // cancel after staging
    },
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.publishes, [], "staged-but-cancelled change must never reach the durable store");
  assert.equal(h.pickerCalls.length, 1);
  assert.equal(h.pickerCalls[0]!.role, "lead");
  assert.deepEqual(h.pickerCalls[0]!.exclude, challenger);
  assert.equal(h.restores.length, 1);
});

test("swap stages an atomic exchange that only publishes together with Start", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  let calls = 0;
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => {
      calls += 1;
      return calls === 1 ? "swap" : "start";
    },
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.publishes, [{ lead: challenger, challenger: lead }]);
  assert.deepEqual(h.starts, ["draft"]);
});

test("a publish failure during Start restores the draft and propagates instead of adopting the stale pair", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  const h = gateHarness({
    preferences: { lead, challenger },
    pickModelRoute: candidate(replacement),
    chooseGate: async (view) => {
      if (view.coding.includes("replacement")) return "start";
      return "coding";
    },
    publishPreferences: async () => { throw new Error("publication failed"); },
  });

  await assert.rejects(runCrossGate(h.deps, "draft"), /publication failed/);
  assert.equal(h.restores.length, 1);
  assert.deepEqual(h.starts, []);
});

test("Kimi (unavailable) route shows the concrete reason and never opens a picker or starts", async () => {
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: route("vendor/challenger") },
    unavailableReason: "Cross is unavailable on Kimi Code routes",
    // Adversarial surface: tries to force a picker/start anyway.
    chooseGate: async () => "coding",
  });

  await runCrossGate(h.deps, "draft");

  assert.equal(h.views[0]!.unavailableReason, "Cross is unavailable on Kimi Code routes");
  assert.equal(h.views[0]!.consequence, null);
  assert.equal(h.views[0]!.canStart, false);
  assert.equal(h.pickerCalls.length, 0, "no picker may open on an unavailable route");
  assert.deepEqual(h.starts, []);
  assert.equal(h.restores.length, 1);
});

test("the consequence line reports a real estimate when both routes have known cached pricing", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const leadInfo = modelInfo("vendor/lead", 0.000003, 0.000015);
  const challengerInfo = modelInfo("vendor/challenger", 0.000001, 0.000005);
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: [leadInfo, challengerInfo],
    chooseGate: async () => null,
  });

  await runCrossGate(h.deps, "some task text");

  const leadPerCall = estimatePanelModelCostUsd(modelCapabilities(leadInfo), "some task text".length)!;
  const challengerPerCall = estimatePanelModelCostUsd(modelCapabilities(challengerInfo), "some task text".length)!;
  const consequence = h.views[0]!.consequence!;
  assert.deepEqual(consequence.callRange, CROSS_GATE_CALL_RANGE);
  assert.notEqual(consequence.cost, "unknown");
  const cost = consequence.cost as { min: number; max: number };
  assert.ok(Math.abs(cost.min - (leadPerCall * 2 + challengerPerCall * 2)) < 1e-9);
  assert.ok(Math.abs(cost.max - (leadPerCall * 3 + challengerPerCall * 3)) < 1e-9);
  assert.equal(
    formatCrossGateConsequence(consequence),
    "4-6 agent phases · provider requests and cost can vary with tool work",
  );
});

test("Cross consent describes agent phases and variable provider work, never a fixed model-call ceiling", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: [
      modelInfo("vendor/lead", 0.000003, 0.000015),
      modelInfo("vendor/challenger", 0.000001, 0.000005),
    ],
    chooseGate: async () => null,
  });

  await runCrossGate(h.deps, "tool-heavy task");

  const copy = formatCrossGateConsequence(h.views[0]!.consequence!);
  assert.match(copy, /4-6 agent phases/i);
  assert.match(copy, /provider requests and cost (?:can )?vary with tool work/i);
  assert.doesNotMatch(copy, /model calls|est\. from \$/i);
  assert.match(crossGateKeepActiveConsequence(), /4-6 agent phases/i);
});

test("the consequence line is honestly unknown when either route's pricing is unknown — never free", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/dynamic");
  const dynamicInfo = modelInfo("vendor/dynamic", -1, -1); // same "-1 = unknown/dynamic" sentinel as priceSummary()/Kimi routes
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: [modelInfo("vendor/lead", 0.000003, 0.000015), dynamicInfo],
    chooseGate: async () => null,
  });

  await runCrossGate(h.deps, "task");

  assert.equal(h.views[0]!.consequence!.cost, "unknown");
  assert.equal(
    formatCrossGateConsequence(h.views[0]!.consequence!),
    `${CROSS_GATE_CALL_RANGE.min}-${CROSS_GATE_CALL_RANGE.max} agent phases · ${CROSS_GATE_FOLLOW_ROUND_DISCLOSURE}`,
  );
});

test("priced consequence copy does not claim a fixed request-cost estimate", () => {
  const models = [
    modelInfo("vendor/lead", 0.000003, 0.000015),
    modelInfo("vendor/challenger", 0.000001, 0.000005),
  ];
  const consequence = crossGateConsequence(models, route("vendor/lead"), route("vendor/challenger"), 4_000);
  const line = formatCrossGateConsequence(consequence);

  assert.match(line, /^4-6 agent phases ·/);
  assert.ok(line.endsWith(CROSS_GATE_FOLLOW_ROUND_DISCLOSURE), line);
  assert.doesNotMatch(line, /\$|model calls|est\./i);
});

test("unknown-cost consequence uses the same honest phase and variable-work copy", () => {
  const consequence = crossGateConsequence([], route("vendor/lead"), route("vendor/challenger"), 10);
  const line = formatCrossGateConsequence(consequence);
  assert.equal(line, `${CROSS_GATE_CALL_RANGE.min}-${CROSS_GATE_CALL_RANGE.max} agent phases · ${CROSS_GATE_FOLLOW_ROUND_DISCLOSURE}`);
  assert.doesNotMatch(line, /\$|model calls|est\./i);
});

test("the consequence line is unknown when a route's model is not in the cached catalog at all", () => {
  const consequence = crossGateConsequence([], route("vendor/lead"), route("vendor/challenger"), 10);
  assert.equal(consequence.cost, "unknown");
});

// ---------------------------------------------------------------------------
// FIX-10 H1 (money honesty): the Start row's estimate prices the chars the
// run will ACTUALLY send — context packet + task — never the draft alone.
// ---------------------------------------------------------------------------

test("H1: an empty draft with history is priced as context packet + continuation task — strictly above the old draft-only estimate", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const models = [
    modelInfo("vendor/lead", 0.000003, 0.000015),
    modelInfo("vendor/challenger", 0.000001, 0.000005),
  ];
  const contextChars = 4_000;
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: models,
    chooseGate: async () => null,
    chatHistoryCount: 8,
    chatContextChars: contextChars,
  });

  await runCrossGate(h.deps, "");

  const consequence = h.views[0]!.consequence!;
  assert.notEqual(consequence.cost, "unknown");
  const cost = consequence.cost as { min: number; max: number };
  // The pre-fix disclosure: draft-only chars (0 for an empty draft) — the
  // estimate collapsed to the fixed output allowance alone.
  const draftOnly = crossGateConsequence(models, lead, challenger, 0);
  const draftOnlyCost = draftOnly.cost as { min: number; max: number };
  assert.ok(
    cost.min > draftOnlyCost.min && cost.max > draftOnlyCost.max,
    "the consent-point estimate must exceed the understated draft-only value once history ships",
  );
  // Exactly the packet + continuation-task chars, through the one estimator.
  assert.deepEqual(
    consequence,
    crossGateConsequence(models, lead, challenger, contextChars + CROSS_GATE_CONTINUATION_TASK.length),
  );
  assert.match(formatCrossGateConsequence(consequence), /^\d-\d agent phases · provider requests and cost can vary/i);
});

test("H1: a typed draft with history is priced as context packet + draft, not the draft alone", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const models = [
    modelInfo("vendor/lead", 0.000003, 0.000015),
    modelInfo("vendor/challenger", 0.000001, 0.000005),
  ];
  const draft = "please refactor the parser";
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: models,
    chooseGate: async () => null,
    chatHistoryCount: 8,
    chatContextChars: 4_000,
  });

  await runCrossGate(h.deps, draft);

  assert.deepEqual(
    h.views[0]!.consequence,
    crossGateConsequence(models, lead, challenger, 4_000 + draft.length),
  );
});

test("H1: a chatContextChars of 0 prices the draft alone — never a fabricated context figure (FIX-14 ticket 4: the dep is required, so 0 is now stated, not defaulted)", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const models = [
    modelInfo("vendor/lead", 0.000003, 0.000015),
    modelInfo("vendor/challenger", 0.000001, 0.000005),
  ];
  const h = gateHarness({
    preferences: { lead, challenger },
    cachedModels: models,
    chooseGate: async () => null,
    chatContextChars: 0,
  });

  await runCrossGate(h.deps, "task");

  assert.deepEqual(
    h.views[0]!.consequence,
    crossGateConsequence(models, lead, challenger, "task".length),
  );
});

// ---------------------------------------------------------------------------
// Phase 10: "Keep Cross active for this chat" — the one explicit arming
// confirmation for persistent Cross mode.
// ---------------------------------------------------------------------------

test("controller ruling 1: the keep-active consequence line is exact and derived from the call-range constants", () => {
  assert.equal(
    crossGateKeepActiveConsequence(),
    `every message in this chat will use ${CROSS_GATE_CALL_RANGE.min}-${CROSS_GATE_CALL_RANGE.max} agent phases; provider requests and cost can vary with tool work until /cross off`,
  );
  assert.equal(
    crossGateKeepActiveConsequence(),
    "every message in this chat will use 4-6 agent phases; provider requests and cost can vary with tool work until /cross off",
  );
});

test("choosing keep-active arms the chat with the exact pair, and still starts exactly once with the preserved task", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => "keep-active",
  });

  await runCrossGate(h.deps, "arm this chat");

  assert.deepEqual(h.armed, [{ lead, challenger }]);
  assert.deepEqual(h.starts, ["arm this chat"]);
  assert.deepEqual(h.publishes, [], "an already-durable pair must not be republished");
});

test("keep-active arms with the freshly staged pair, not the previously stored one", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  let calls = 0;
  const h = gateHarness({
    preferences: { lead, challenger },
    pickModelRoute: candidate(replacement),
    chooseGate: async () => {
      calls += 1;
      return calls === 1 ? "coding" : "keep-active";
    },
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.publishes, [{ lead: replacement, challenger }]);
  assert.deepEqual(h.armed, [{ lead: replacement, challenger }]);
});

test("keep-active never arms when the pair is incomplete — the defensive re-check blocks it exactly like Start", async () => {
  let calls = 0;
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: null },
    chooseGate: async () => { calls += 1; return calls === 1 ? "keep-active" : null; },
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.armed, [], "an invalid pair must never be armed");
  assert.deepEqual(h.starts, []);
});

test("keep-active never arms when Cross itself is unavailable (Kimi) — the view discloses no consequence line either", async () => {
  const h = gateHarness({
    preferences: { lead: route("vendor/lead"), challenger: route("vendor/challenger") },
    unavailableReason: "Cross is unavailable on Kimi Code routes",
    chooseGate: async () => "keep-active",
  });

  await runCrossGate(h.deps, "draft");

  assert.deepEqual(h.armed, []);
  assert.equal(h.views[0]!.keepActiveConsequence, null);
});

test("a publish failure during keep-active restores the draft, propagates, and never arms the chat", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  const h = gateHarness({
    preferences: { lead, challenger },
    pickModelRoute: candidate(replacement),
    chooseGate: async (view) => (view.coding.includes("replacement") ? "keep-active" : "coding"),
    publishPreferences: async () => { throw new Error("publication failed"); },
  });

  await assert.rejects(runCrossGate(h.deps, "draft"), /publication failed/);
  assert.equal(h.restores.length, 1);
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.armed, [], "a failed publish must never lead to arming");
});

// ---------------------------------------------------------------------------
// Fix round 1 (owner's final ruling): an empty draft is never refused, on
// either action. With chat history, it means "continue the conversation"
// (CROSS_GATE_CONTINUATION_TASK). With NO history either, Start arms a
// PENDING one-shot and waits (armPendingOneShot) instead of firing a doomed
// empty-task run or refusing outright — "if I start a chat and the first
// thing I do is /cross, it should simply wait until the first input comes."
// Keep-active's own empty+empty behavior (arm persistent, wait) is
// unchanged from the earlier round.
// ---------------------------------------------------------------------------

test("Start with an empty draft and no chat history arms a PENDING one-shot and waits — never refuses, never fires a doomed run", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 0,
    chooseGate: async () => "start",
  });

  await runCrossGate(h.deps, "");

  assert.deepEqual(h.starts, [], "no doomed empty-task run fires");
  assert.deepEqual(h.armed, [], "this is a ONE-SHOT arm, not persistent keep-active");
  assert.deepEqual(h.armedOneShot, [{ lead, challenger }]);
  assert.deepEqual(h.activations, [{ pair: { lead, challenger }, detail: CROSS_GATE_PENDING_ONESHOT_DETAIL }]);
  assert.equal(h.views[0]!.startWaitingLabel, CROSS_GATE_PENDING_ONESHOT_DETAIL, "the gate never hides that Start arms-and-waits here");
  assert.equal(h.views[0]!.continuationTaskLabel, null, "nothing to continue with no history either");
  assert.equal(h.restores.length, 0, "this is a successful arm, not a cancel — the draft is not restored");
});

test("Start with an empty draft but existing chat history fires the fixed continuation task instead of arming", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 3,
    chooseGate: async () => "start",
  });

  await runCrossGate(h.deps, "");

  assert.deepEqual(h.starts, [CROSS_GATE_CONTINUATION_TASK]);
  assert.deepEqual(h.armed, [], "a one-shot continuation run never arms anything");
  assert.deepEqual(h.armedOneShot, []);
  assert.deepEqual(h.activations, [], "no arming happened — no activation notice either");
  assert.equal(h.views[0]!.startWaitingLabel, null, "history covers the empty draft — Start is not waiting for anything");
  assert.equal(h.views[0]!.continuationTaskLabel, crossGateContinuationTaskLabel(3));
});

test("Start with a non-empty draft never shows a continuation or waiting preview, even with no history", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 0,
    chooseGate: async () => "start",
  });

  await runCrossGate(h.deps, "a real typed task");

  assert.deepEqual(h.starts, ["a real typed task"]);
  assert.equal(h.views[0]!.continuationTaskLabel, null, "the user already sees what they typed — nothing hidden to preview");
  assert.equal(h.views[0]!.startWaitingLabel, null);
});

test("an arm-save failure during Start's pending one-shot restores the draft, propagates an honest failure, and never starts a run", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 0,
    chooseGate: async () => "start",
    armPendingOneShot: async () => { throw new Error("disk full"); },
  });

  await assert.rejects(runCrossGate(h.deps, ""), /Cross could not be armed for this chat: disk full/);
  assert.equal(h.restores.length, 1, "the typed (empty) task state must not be silently lost");
  assert.deepEqual(h.starts, [], "an arming failure must not silently proceed to a run");
});

test("keep-active with an empty draft and no chat history arms but does not fire a run, and activates with the idle detail", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 0,
    chooseGate: async () => "keep-active",
  });

  await runCrossGate(h.deps, "");

  assert.deepEqual(h.armed, [{ lead, challenger }], "arming still happens on an empty draft");
  assert.deepEqual(h.armedOneShot, [], "keep-active is persistent, never a one-shot");
  assert.deepEqual(h.starts, [], "no doomed empty-task run fires");
  assert.deepEqual(h.activations, [{ pair: { lead, challenger }, detail: CROSS_GATE_ARMED_IDLE_DETAIL }]);
  assert.equal(h.restores.length, 0, "this is a successful arm, not a cancel — the draft is not restored");
});

test("keep-active with an empty draft but existing chat history arms AND immediately fires the continuation run, activating with the continuation detail", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 5,
    chooseGate: async () => "keep-active",
  });

  await runCrossGate(h.deps, "");

  assert.deepEqual(h.armed, [{ lead, challenger }]);
  assert.deepEqual(
    h.starts,
    [CROSS_GATE_CONTINUATION_TASK],
    "owner direction: activation directly engages the pair on the history, not just arming for later",
  );
  assert.deepEqual(h.activations, [{ pair: { lead, challenger }, detail: CROSS_GATE_ARMED_CONTINUATION_DETAIL }]);
});

test("keep-active with a non-empty draft arms, runs the typed task, and activates with the running detail", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chatHistoryCount: 5,
    chooseGate: async () => "keep-active",
  });

  await runCrossGate(h.deps, "a real typed task");

  assert.deepEqual(h.starts, ["a real typed task"]);
  assert.deepEqual(h.activations, [{ pair: { lead, challenger }, detail: CROSS_GATE_ARMED_RUNNING_DETAIL }]);
});

test("an arm-save failure during keep-active restores the draft, propagates an honest failure, and never starts a run (fix round 1, MINOR 4)", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => "keep-active",
    armForChat: async () => { throw new Error("disk full"); },
  });

  await assert.rejects(runCrossGate(h.deps, "a task"), /Cross could not be armed for this chat: disk full/);
  assert.equal(h.restores.length, 1, "the typed task must not be silently lost");
  assert.deepEqual(h.starts, [], "an arming failure must not silently downgrade into an unpersisted run");
});

test("role labels replace bare Lead/Challenger in every gate-rendered surface", () => {
  assert.equal(CROSS_GATE_CODING_ROLE_LABEL, "Coding model · writes files");
  assert.equal(CROSS_GATE_REVIEW_ROLE_LABEL, "Review model · read-only");
  assert.doesNotMatch(CROSS_GATE_CODING_ROLE_LABEL, /^Lead$/);
  assert.doesNotMatch(CROSS_GATE_REVIEW_ROLE_LABEL, /^Challenger$/);
});

test("the publishing label is English-first like every other gate string (Phase 7, E-VIS-02)", () => {
  assert.equal(CROSS_GATE_PUBLISHING_LABEL, "Publishing …");
  assert.doesNotMatch(CROSS_GATE_PUBLISHING_LABEL, /[äöüßÄÖÜ]/, "the gate is English-first (cross-gate.ts header)");
});

test("the fixed continuation task carries the cheap no-task fallback (testrun finding, owner live test 2026-08-28)", () => {
  assert.match(CROSS_GATE_CONTINUATION_TASK, /^Continue the conversation above: address the latest user request\./);
  assert.match(
    CROSS_GATE_CONTINUATION_TASK,
    /no actionable request.*reply briefly asking what to work on.*do not investigate the workspace or produce analysis/i,
    "an empty draft with no real request must ask, not invent workspace investigation or analysis",
  );
  assert.doesNotMatch(CROSS_GATE_CONTINUATION_TASK, /[äöüßÄÖÜ]/, "the gate is English-first (cross-gate.ts header)");
});

// ---------------------------------------------------------------------------
// The two production CrossGateSurface factories (src/cli.ts) — pinning
// CROSS_GATE_PUBLISHING_LABEL in isolation (above) does not prove either
// real surface actually calls out.text/ui.setStatus with it. These drive
// the real, exported factories directly.
// ---------------------------------------------------------------------------

test("the plain CrossGateSurface's setBusy prints exactly the publishing label, and prints nothing when clearing", () => {
  const calls: unknown[][] = [];
  const surface = createPlainCrossGateSurface({
    text: (...args: unknown[]) => calls.push(args),
  });

  surface.setBusy!(true);
  assert.deepEqual(calls, [[CROSS_GATE_PUBLISHING_LABEL]]);

  surface.setBusy!(false);
  assert.deepEqual(calls, [[CROSS_GATE_PUBLISHING_LABEL]], "clearing busy must not print anything on the plain surface");
});

test("the dashboard CrossGateSurface's setBusy calls setStatus with exactly the publishing label, and nothing when clearing", () => {
  const calls: unknown[][] = [];
  const surface = createDashboardCrossGateSurface({
    setStatus: (...args: unknown[]) => { calls.push(args); },
    pickChoice: async () => null,
  });

  surface.setBusy!(true);
  assert.deepEqual(calls, [[CROSS_GATE_PUBLISHING_LABEL]], "must call setStatus with exactly one argument: the label (busy defaults true)");

  surface.setBusy!(false);
  assert.deepEqual(calls, [[CROSS_GATE_PUBLISHING_LABEL]], "clearing busy must not call setStatus on the dashboard surface");
});

// ---------------------------------------------------------------------------
// F1/F6: `createPlainCrossGateSurface`'s `chooseGate` was never exercised
// interactively (only `setBusy`, above) — unlike the dashboard surface,
// `chooseGate` takes no injectable picker: it calls `pickFromListPlain`
// (src/ui/list-plain.ts) with no `io` argument, so it always reads the
// process's real stdin/stdout. `pickFromListPlain` reads that default at
// call time (`io: PlainListIo = defaultIo()`), so swapping the two
// properties in before calling `chooseGate` — restored in `finally`,
// exactly like a config/env stub elsewhere in this suite — reaches it
// without changing `createPlainCrossGateSurface`'s own signature.
// ---------------------------------------------------------------------------

class FakeGateInput extends EventEmitter {
  isTTY = true;
  setRawMode(_value: boolean): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeGateOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  output = "";
  write(value: string): boolean {
    this.output += value;
    return true;
  }
}

function availableView(): CrossGateView {
  return {
    leadCandidate: null,
    challengerCandidate: null,
    coding: "openrouter/model-a",
    review: "openrouter/model-b",
    draft: "task draft",
    canStart: true,
    startBlockedReason: null,
    continuationTaskLabel: null,
    startWaitingLabel: null,
    unavailableReason: null,
    consequence: { callRange: CROSS_GATE_CALL_RANGE, cost: "unknown" },
    keepActiveConsequence: crossGateKeepActiveConsequence(),
  };
}

async function withFakeProcessStdio<T>(
  run: (stdin: FakeGateInput, stdout: FakeGateOutput) => Promise<T>,
): Promise<T> {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  const stdin = new FakeGateInput();
  const stdout = new FakeGateOutput();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
  try {
    return await run(stdin, stdout);
  } finally {
    Object.defineProperty(process, "stdin", originalStdin);
    Object.defineProperty(process, "stdout", originalStdout);
  }
}

function pressGateKey(stdin: FakeGateInput, name: string, character = ""): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false });
}

// F7 (ruling 5): the explicit "Cancel" row is removed — Esc plus the
// footer's own "Esc cancel" back-verb hint suffice, matching the fullscreen
// dashboard surface (`createDashboardCrossGateSurface`, above), which never
// had a Cancel row of its own. Cancel-row assertions become Esc-resolves-
// null (the next test) plus a footer-hint assertion (below); this is a
// sanctioned spec change, not a weakening — Esc must still, and does still,
// resolve null (cancel-never-success is unchanged).
test("the plain CrossGateSurface's chooseGate shows every role label with no separate Cancel row", async () => {
  await withFakeProcessStdio(async (stdin, stdout) => {
    const surface = createPlainCrossGateSurface({ text: () => {} });
    const chosen = surface.chooseGate(availableView());
    // Rows in order: Coding, Review, Swap, Start — three presses of "down"
    // from the default top selection reaches the last row, Start.
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "return");
    assert.equal(await chosen, "start", "the last row is Start, not a Cancel row");
    assert.match(stdout.output, new RegExp(CROSS_GATE_CODING_ROLE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(stdout.output, new RegExp(CROSS_GATE_REVIEW_ROLE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(stdout.output, new RegExp(CROSS_GATE_SWAP_LABEL));
    assert.match(stdout.output, new RegExp(CROSS_GATE_START_LABEL));
    assert.doesNotMatch(stdout.output, /\bCancel\b/, "ruling 5: no explicit Cancel row remains");
    // V4-A: the footer is the action bar, so the back-verb hint is a chip
    // (`[Esc] cancel` at colour level 0). Same key, same word, same line.
    assert.match(stdout.output, /\[Esc\] cancel/i, "the action bar's own back-verb chip must still be visible");
  });
});

// Phase 10: the consequence line ("every message in this chat will use
// ~4-6 model calls until /cross off") must be pinned on both production
// surfaces — the gate is where the audit's conscious-confirmation
// requirement is satisfied, so a surface that silently dropped this text
// would defeat the whole point of arming.
test("the plain CrossGateSurface's chooseGate shows the keep-active row with the exact consequence line", async () => {
  await withFakeProcessStdio(async (stdin, stdout) => {
    const surface = createPlainCrossGateSurface({ text: () => {} });
    const chosen = surface.chooseGate(availableView());
    // Rows in order: Coding, Review, Swap, Start, Keep active — four presses
    // of "down" from the default top selection reaches the last row.
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "return");
    assert.equal(await chosen, "keep-active");
    assert.match(stdout.output, new RegExp(CROSS_GATE_KEEP_ACTIVE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The fixed 100-column fake terminal truncates the row's full
    // description with an ellipsis — this asserts the visible prefix, which
    // is exactly `crossGateKeepActiveConsequence()`'s own text (pinned above
    // in isolation) rather than re-asserting the full sentence here.
    assert.match(
      stdout.output,
      /every message in this chat will use 4-6 agent phases/,
      "the exact consequence line must be visible on the plain surface",
    );
  });
});

/**
 * FIX-20, finding 4: `· active` had grown three different meanings — the
 * current value in a picker (correct), a marker sitting on ACTION rows, and
 * "Not set · active", which claimed an empty value was the active one. It
 * marks a current VALUE, and nothing else.
 *
 * The gate's rows are all actions (pick a model, swap, start, keep active),
 * so none of them may carry the tag. `pickChoice` keeps "which row is the
 * current value" and "which row the cursor starts on" as separate
 * arguments precisely so this cannot be conflated again.
 */
test("the dashboard Cross gate marks no row as a current value, and still starts the cursor on the right one", async () => {
  const seen: Array<{ current: string; initial: string | undefined }> = [];
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice(_title, _choices, currentValue, initialValue) {
      seen.push({ current: currentValue, initial: initialValue });
      return null;
    },
  });

  await surface.chooseGate(availableView());
  assert.deepEqual(
    seen,
    [{ current: "", initial: "start" }],
    "a startable gate opens on Start without calling any row the current value",
  );

  // The same holds while the pair is incomplete — the very state that
  // produced the owner's "Not set · active": the cursor moves to the coding
  // row, but "Not set" is still not a value anything can be current of.
  seen.length = 0;
  await surface.chooseGate({
    ...availableView(),
    coding: CROSS_GATE_NOT_SET,
    canStart: false,
    startBlockedReason: CROSS_GATE_INCOMPLETE_REASON,
  });
  assert.deepEqual(seen, [{ current: "", initial: "coding" }]);
});

test("the dashboard CrossGateSurface offers the keep-active row with the exact consequence line", async () => {
  let offered: ChoicePickerItem[] = [];
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice(_title, choices) {
      offered = [...choices];
      return choices.find((choice) => choice.value === "keep-active") ?? null;
    },
  });

  const chosen = await surface.chooseGate(availableView());

  assert.equal(chosen, "keep-active");
  const row = offered.find((choice) => choice.value === "keep-active");
  assert.ok(row, "the keep-active row must be offered");
  assert.equal(row!.label, CROSS_GATE_KEEP_ACTIVE_LABEL);
  assert.equal(
    row!.description,
    "every message in this chat will use 4-6 agent phases; provider requests and cost can vary with tool work until /cross off",
    "the exact consequence line must be visible on the dashboard surface",
  );
});

test("the Desktop Cross surface forgets duration after an abandoned gate visit", async () => {
  const lead = desktopRoute("lead", "openai/gpt-5.4-codex", "Codex Privat");
  const challenger = desktopRoute("challenger", "moonshotai/kimi-k3", "Kimi Privat");
  const published: Array<"one-task" | "chat" | null> = [];
  const answers = ["duration-chat", null, null] as const;
  let answerIndex = 0;
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice() { return null; },
  }, {
    publishPreflight(view) {
      if (view) published.push(view.duration);
    },
    async pickPreflightChoice({ items }) {
      const value = answers[answerIndex++];
      return value ? items.find((item) => item.value === value) ?? null : null;
    },
    async confirmStart() { return false; },
  });
  const view = {
    ...availableView(),
    leadCandidate: lead,
    challengerCandidate: challenger,
  };

  assert.equal(await surface.chooseGate(view), null);
  assert.equal(await surface.chooseGate(view), null);
  assert.deepEqual(published, [null, "chat", null]);
});

test("the Desktop Cross surface confirms model, account, duration, calls and cost before mapping duration", async () => {
  const lead = {
    ...desktopRoute("lead", "openai/gpt-5.4-codex", "Privat"),
    providerLabel: "ChatGPT / Codex",
    displayName: "Shared Model",
  };
  const challenger = {
    ...desktopRoute("challenger", "moonshotai/kimi-k3", "Privat"),
    providerLabel: "Kimi Code",
    displayName: "Shared Model",
  };
  const confirmations: Array<{ title: string; consequence: string }> = [];
  const answers = ["duration-chat", "start"];
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice() { return null; },
  }, {
    publishPreflight() {},
    async pickPreflightChoice({ items }) {
      const value = answers.shift();
      return items.find((item) => item.value === value) ?? null;
    },
    async confirmStart(title, consequence) {
      confirmations.push({ title, consequence });
      return true;
    },
  });

  const action = await surface.chooseGate({
    ...availableView(),
    leadCandidate: lead,
    challengerCandidate: challenger,
    consequence: { callRange: CROSS_GATE_CALL_RANGE, cost: { min: 0.04, max: 0.08 } },
  });
  assert.equal(action, "keep-active");
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!.consequence, /Lead: ChatGPT \/ Codex · Privat · Shared Model · openai\/gpt-5\.4-codex/);
  assert.match(confirmations[0]!.consequence, /Challenger: Kimi Code · Privat · Shared Model · moonshotai\/kimi-k3/);
  assert.match(confirmations[0]!.consequence, /Denkmodus: unterstützt/);
  assert.match(confirmations[0]!.consequence, /Fähigkeiten: Text · Werkzeuge/);
  assert.match(confirmations[0]!.consequence, /Dauer: Für diesen Chat/);
  assert.match(confirmations[0]!.consequence, /4–6 Modellaufrufe je Aufgabe/);
  assert.match(confirmations[0]!.consequence, /Mindestens \$0\.040–\$0\.080/);
});

// ---------------------------------------------------------------------------
// Fix round 1 (owner direction/final ruling): the continuation-task preview
// and the pending-one-shot "waiting" preview, pinned on both production
// surfaces' rendered rows.
// ---------------------------------------------------------------------------

test("the dashboard CrossGateSurface shows the continuation-task preview on Start's row when the draft is empty but history exists", async () => {
  let offered: ChoicePickerItem[] = [];
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice(_title, choices) {
      offered = [...choices];
      return choices.find((choice) => choice.value === "start") ?? null;
    },
  });

  const view: CrossGateView = {
    ...availableView(),
    draft: "",
    continuationTaskLabel: crossGateContinuationTaskLabel(4),
  };
  const chosen = await surface.chooseGate(view);

  assert.equal(chosen, "start");
  const row = offered.find((choice) => choice.value === "start");
  assert.ok(row, "the Start row must be offered");
  assert.match(row!.description, /Task: continue the current chat \(4 recent messages\)/);
});

test("the dashboard CrossGateSurface shows the pending-one-shot waiting preview on Start's row when there is no history either — Start stays fully actionable", async () => {
  let offered: ChoicePickerItem[] = [];
  const surface = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice(_title, choices) {
      offered = [...choices];
      return choices.find((choice) => choice.value === "start") ?? null;
    },
  });

  const view: CrossGateView = {
    ...availableView(),
    draft: "",
    startWaitingLabel: CROSS_GATE_PENDING_ONESHOT_DETAIL,
  };
  const chosen = await surface.chooseGate(view);

  assert.equal(chosen, "start", "Start must still be selectable — nothing refuses here any more");
  const row = offered.find((choice) => choice.value === "start");
  assert.ok(row, "the Start row must be offered");
  assert.match(row!.description, new RegExp(CROSS_GATE_PENDING_ONESHOT_DETAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the plain CrossGateSurface shows the continuation-task preview on Start's row when the draft is empty but history exists", async () => {
  await withFakeProcessStdio(async (stdin, stdout) => {
    const surface = createPlainCrossGateSurface({ text: () => {} });
    const view: CrossGateView = {
      ...availableView(),
      draft: "",
      continuationTaskLabel: crossGateContinuationTaskLabel(2),
    };
    const chosen = surface.chooseGate(view);
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "down");
    pressGateKey(stdin, "return");
    assert.equal(await chosen, "start");
    assert.match(stdout.output, /Task: continue the current chat \(2 recent messages\)/);
  });
});

test("the plain CrossGateSurface's chooseGate resolves null on Escape", async () => {
  await withFakeProcessStdio(async (stdin) => {
    const surface = createPlainCrossGateSurface({ text: () => {} });
    const chosen = surface.chooseGate(availableView());
    pressGateKey(stdin, "escape");
    assert.equal(await chosen, null);
  });
});

// ---------------------------------------------------------------------------
// Real-coordinator harness (fake worker/verification/picker/surface ports) —
// proves the cli.ts wiring (`createCrossCommandRuntime(...).openGate`), not
// just the gate's own standalone logic above.
// ---------------------------------------------------------------------------

test("openGate on the real runtime starts the coordinator exactly once with the preserved task reaching both roles", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const tasks: string[] = [];
  const results: string[] = [];
  let snapshotPublishes = 0;
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze(input) {
        tasks.push(input.context.request);
        return { text: input.role, outcome: "completed" };
      },
      async implement() { return { text: "unified", changed: false, outcome: "completed" }; },
      async review() { return { blocking: false, finding: "" }; },
    },
    verification: { async run() { return { diff: "", outcome: { status: "passed" } }; } },
    readPreferences: () => ({ lead, challenger }),
    async publishPreferences() {},
    picker: { async pickModelRoute() { return null; } },
    surface: {
      restoreDraft() {},
      discardDraft() {},
      publishResult(result) { results.push(result.text); },
      // FIX-20, finding 3: `/cross status` publishes through `publishStatus`
      // (armed state + the run's own facts, one call); `publishSnapshot` is
      // `stop()`'s alone now.
      publishStatus() { snapshotPublishes += 1; },
    },
    gateSurface: {
      async chooseGate() { return "start"; },
    },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
  });

  await runtime.openGate("prüfe exakt einmal");
  runtime.status();
  assert.equal(snapshotPublishes, 1, "explicit status still publishes immediately");

  assert.deepEqual(tasks, ["prüfe exakt einmal", "prüfe exakt einmal"]);
  assert.deepEqual(results, ["unified"]);
});

test("openGate cancellation discards a staged role change when a complete pair already exists", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  let preferences: CrossPreferencesV1 = { lead, challenger };
  const commits: CrossPreferencesV1[] = [];
  const actions = ["coding", null] as Array<"coding" | null>;
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze(input) { return { text: input.role, outcome: "completed" }; },
      async implement() { return { text: "result", changed: false, outcome: "completed" }; },
      async review() { return { blocking: false, finding: "" }; },
    },
    verification: { async run() { return { diff: "", outcome: { status: "passed" } }; } },
    readPreferences: () => structuredClone(preferences),
    async publishPreferences(next) {
      commits.push(structuredClone(next));
      preferences = structuredClone(next);
    },
    picker: { async pickModelRoute() { return candidate(replacement); } },
    surface: {
      restoreDraft() {},
      discardDraft() {},
      publishResult() {},
    },
    gateSurface: {
      async chooseGate() { return actions.shift() ?? null; },
    },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
  });

  await runtime.openGate("unchanged draft");
  assert.deepEqual(commits, []);
  assert.deepEqual(preferences, { lead, challenger });
});

test("openGate propagates a real publication failure and restores the draft instead of starting", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const replacement = route("vendor/replacement");
  let restored = 0;
  let analyzeCalls = 0;
  const actions = ["coding", "start"] as Array<"coding" | "start">;
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze() { analyzeCalls += 1; return { text: "x", outcome: "completed" }; },
      async implement() { return { text: "", changed: false, outcome: "completed" }; },
      async review() { return { blocking: false, finding: "" }; },
    },
    verification: { async run() { return { diff: "", outcome: { status: "passed" } }; } },
    readPreferences: () => ({ lead, challenger }),
    async publishPreferences() { throw new Error("publication failed"); },
    picker: { async pickModelRoute() { return candidate(replacement); } },
    surface: {
      restoreDraft() { restored += 1; },
      discardDraft() {},
      publishResult() {},
    },
    gateSurface: {
      async chooseGate() { return actions.shift() ?? null; },
    },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
  });

  await assert.rejects(runtime.openGate("exact draft"), /publication failed/);
  assert.equal(restored, 1);
  assert.equal(analyzeCalls, 0, "a failed publish must never lead to a run");
});

// ---------------------------------------------------------------------------
// Phase 10: the armed-dispatch seam — `CrossCommandRuntimeInput.armForChat`
// wired through `openGate`'s "keep-active" action, and `start`'s `pair`
// override reaching the coordinator directly (the mechanism
// `runPlainLoop`/`runDashboard` use for every later armed message).
// ---------------------------------------------------------------------------

test("openGate's keep-active action arms the chat via CrossCommandRuntimeInput.armForChat and still starts the coordinator", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const armed: CrossPreferencesV1[] = [];
  const tasks: string[] = [];
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze(input) {
        tasks.push(input.context.request);
        return { text: input.role, outcome: "completed" };
      },
      async implement() { return { text: "unified", changed: false, outcome: "completed" }; },
      async review() { return { blocking: false, finding: "" }; },
    },
    verification: { async run() { return { diff: "", outcome: { status: "passed" } }; } },
    readPreferences: () => ({ lead, challenger }),
    async publishPreferences() {},
    picker: { async pickModelRoute() { return null; } },
    surface: {
      restoreDraft() {},
      discardDraft() {},
      publishResult() {},
    },
    gateSurface: {
      async chooseGate() { return "keep-active"; },
    },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
    async armForChat(pair) { armed.push(structuredClone(pair)); },
  });

  await runtime.openGate("arm via runtime");

  assert.deepEqual(armed, [{ lead, challenger }]);
  assert.deepEqual(tasks, ["arm via runtime", "arm via runtime"], "keep-active must still start exactly one real run");
});

test("start's pair override reaches the coordinator directly, instead of readPreferences() — the armed-dispatch seam", async () => {
  const globalLead = route("vendor/global-lead");
  const globalChallenger = route("vendor/global-challenger");
  const armedLead = route("vendor/armed-lead");
  const armedChallenger = route("vendor/armed-challenger");
  const seenRoutes: RouteIdentityV1[] = [];
  let currentPreferences: CrossPreferencesV1 = { lead: globalLead, challenger: globalChallenger };
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze(input) { seenRoutes.push(input.route); return { text: input.role, outcome: "completed" }; },
      async implement(input) { seenRoutes.push(input.route); return { text: "unified", changed: false, outcome: "completed" }; },
      async review(input) { seenRoutes.push(input.route); return { blocking: false, finding: "" }; },
    },
    verification: { async run() { return { diff: "", outcome: { status: "passed" } }; } },
    readPreferences: () => structuredClone(currentPreferences),
    async publishPreferences() {},
    picker: { async pickModelRoute() { return null; } },
    surface: {
      restoreDraft() {},
      discardDraft() {},
      publishResult() {},
    },
    gateSurface: { async chooseGate() { return null; } },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
  });

  assert.deepEqual(runtime.dashboardPreferences(), {
    run: { lead: globalLead, challenger: globalChallenger },
    current: { lead: globalLead, challenger: globalChallenger },
  }, "before the first run both projections use the full current pair");

  const result = await runtime.start("armed message", { lead: armedLead, challenger: armedChallenger });
  currentPreferences = { lead: globalChallenger, challenger: globalLead };

  assert.equal(result.phase, "completed");
  assert.ok(seenRoutes.length > 0);
  assert.ok(
    seenRoutes.every((seen) => seen.requestedModelId.startsWith("vendor/armed-")),
    "the armed pair passed to start(), not the global Cross preferences, must reach every worker call",
  );
  assert.deepEqual(runtime.dashboardPreferences(), {
    run: { lead: armedLead, challenger: armedChallenger },
    current: currentPreferences,
  }, "the completed run stays exact while the next-run selection may drift independently");
});

// ---------------------------------------------------------------------------
// P15 item 1 (owner: "du als Crossmodel, du hast auch ein Denklevel"): the
// think level each role will actually run with is visible at the consent
// point, not only inside Settings.
// ---------------------------------------------------------------------------

test("P15: the gate's role rows disclose each role's own think level", async () => {
  const lead = route("vendor/lead");
  const challenger = route("vendor/challenger");
  const levels: Record<string, string> = {
    "vendor/lead": "high",
    "vendor/challenger": "4K",
  };
  const h = gateHarness({
    preferences: { lead, challenger },
    chooseGate: async () => null,
    thinkingLabel: (candidate) => levels[candidate.requestedModelId] ?? null,
  });

  await runCrossGate(h.deps, "");

  const view = h.views[0]!;
  assert.equal(view.coding, `lead${CROSS_GATE_THINKING_SEPARATOR}high`);
  assert.equal(view.review, `challenger${CROSS_GATE_THINKING_SEPARATOR}4K`);
});

test("P15: an unset role, or a runtime with no think level to report, never fabricates one", async () => {
  const lead = route("vendor/lead");
  const unset = gateHarness({
    preferences: { lead, challenger: null },
    chooseGate: async () => null,
    thinkingLabel: () => "high",
  });
  await runCrossGate(unset.deps, "");
  assert.equal(unset.views[0]!.review, CROSS_GATE_NOT_SET, "an unset role stays exactly 'Not set'");
  assert.equal(unset.views[0]!.coding, `lead${CROSS_GATE_THINKING_SEPARATOR}high`);

  // No dep at all (a minimal test double, or a runtime that cannot resolve a
  // level): the row is the bare model name, exactly as before P15.
  const bare = gateHarness({
    preferences: { lead, challenger: route("vendor/challenger") },
    chooseGate: async () => null,
  });
  await runCrossGate(bare.deps, "");
  assert.equal(bare.views[0]!.coding, "lead");

  const unknown = gateHarness({
    preferences: { lead, challenger: route("vendor/challenger") },
    chooseGate: async () => null,
    thinkingLabel: () => null,
  });
  await runCrossGate(unknown.deps, "");
  assert.equal(unknown.views[0]!.coding, "lead");
});

test("P15: both production gate surfaces render the think level they are handed", async () => {
  const view: CrossGateView = {
    ...availableView(),
    coding: `model-a${CROSS_GATE_THINKING_SEPARATOR}high`,
    review: `model-b${CROSS_GATE_THINKING_SEPARATOR}auto`,
  };

  let offered: ChoicePickerItem[] = [];
  const dashboard = createDashboardCrossGateSurface({
    setStatus: () => {},
    async pickChoice(_title, choices) {
      offered = [...choices];
      return null;
    },
  });
  await dashboard.chooseGate(view);
  assert.equal(offered.find((choice) => choice.value === "coding")?.description, view.coding);
  assert.equal(offered.find((choice) => choice.value === "review")?.description, view.review);

  await withFakeProcessStdio(async (stdin, stdout) => {
    const plain = createPlainCrossGateSurface({ text: () => {} });
    const chosen = plain.chooseGate(view);
    // Let the list paint its first frame before cancelling — an escape in the
    // same tick resolves the picker before anything has been written.
    await new Promise((resolve) => { setImmediate(resolve); });
    pressGateKey(stdin, "escape");
    await chosen;
    assert.match(stdout.output, /thinking high/, "the plain surface shows the coding role's level");
    assert.match(stdout.output, /thinking auto/, "…and the review role's");
  });
});

/**
 * FIX-14 fix round 1 (review M1, controller ruling): the floor marker and
 * the figure it qualifies are ONE part, so a row that cannot fit them drops
 * both together rather than rendering `est. from $0…`.
 */
test("agent-phase and variable-work consent clauses remain indivisible parts", () => {
  const models = [
    modelInfo("vendor/lead", 0.000003, 0.000015),
    modelInfo("vendor/challenger", 0.000001, 0.000005),
  ];
  const consequence = crossGateConsequence(models, route("vendor/lead"), route("vendor/challenger"), 4_000);
  const parts = crossGateConsequenceParts(consequence);

  assert.deepEqual(parts, ["4-6 agent phases", CROSS_GATE_FOLLOW_ROUND_DISCLOSURE]);
  assert.doesNotMatch(parts.join(" "), /\$|model calls|est\./i);
  assert.equal(parts.at(-1), CROSS_GATE_FOLLOW_ROUND_DISCLOSURE);

  // One wording: the string form is exactly the join of the parts.
  assert.equal(formatCrossGateConsequence(consequence), parts.join(" · "));
});

test("unknown-cost consequence retains the same two honest consent clauses", () => {
  const consequence = crossGateConsequence([], route("vendor/lead"), route("vendor/challenger"), 10);
  const parts = crossGateConsequenceParts(consequence);
  assert.deepEqual([...parts], [
    `${CROSS_GATE_CALL_RANGE.min}-${CROSS_GATE_CALL_RANGE.max} agent phases`,
    CROSS_GATE_FOLLOW_ROUND_DISCLOSURE,
  ]);
  assert.equal(formatCrossGateConsequence(consequence), parts.join(" · "));
});
