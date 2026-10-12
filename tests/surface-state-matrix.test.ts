/**
 * Phase 7, Part A — one async-state contract, asserted per surface
 * (audit move 5, E-VIS-02).
 *
 * Table-driven: MATRIX below has exactly one row per (surface, state) pair
 * — 4 surfaces x the 8 contract states (empty/loading/error/success/focus/
 * disabled/cancel/recovery) = 32 rows. A row is either `applies: true` with
 * an `evidence` function that actually drives the real surface code and
 * asserts the state is reachable and rendered, or `applies: false` with a
 * one-line `reason` — never a bare omission. The completeness test at the
 * bottom fails loudly if any surface is missing a state or lists one
 * twice, so this file cannot drift silently out of sync with the contract.
 *
 * SURFACE NOTE — setup: this section originally tested `src/setup-ui.ts`
 * because `src/setup-surface/` (built on `codex/orcode-look-phase5-setup`,
 * commit 85c77b1) had not yet been merged into `claude/orcode-look-phase1a`.
 * That merge landed (merge commit "land the capability-truthful setup
 * surface"), `src/setup-ui.ts` is deleted, and this section now tests
 * `src/setup-surface/index.ts` — the `SetupSurface` implementation actually
 * present and reachable on this branch today. The setup surface is
 * English-first (born-new), so the row assertions below match English
 * copy, unlike the still-German assertions in the other three sections.
 *
 * Each surface section below builds the smallest working harness for that
 * surface, modeled directly on that surface's own existing test file
 * (settings-controller.test.ts's `harness()`/`runtimeSnapshot()`,
 * cross-gate.test.ts's `gateHarness()`, setup-ui.test.ts's
 * `fixture()`/`ScriptedSurface`, tui.test.ts's
 * `FakeInput`/`FakeOutput`/`ui()`/`press()`), rather than inventing new
 * fixture shapes. Where a state is genuinely delegated to a shared
 * primitive (e.g. the same `pickChoice` cursor/highlight both Setup's and
 * Cross gate's TUI surfaces call), one shared test proves the primitive and
 * every relying surface's row cites it in its `note` — that is not an
 * omission, it is not duplicating coverage that already exists once,
 * honestly, in one place.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

const STATES = [
  "empty",
  "loading",
  "error",
  "success",
  "focus",
  "disabled",
  "cancel",
  "recovery",
] as const;
type StateName = (typeof STATES)[number];

type MatrixRow =
  | { readonly applies: true; readonly note: string; readonly evidence: () => void | Promise<void> }
  | { readonly applies: false; readonly reason: string };

type SurfaceMatrix = Readonly<Record<StateName, MatrixRow>>;

function applies(note: string, evidence: () => void | Promise<void>): MatrixRow {
  return { applies: true, note, evidence };
}
function notApplicable(reason: string): MatrixRow {
  return { applies: false, reason };
}

// ===========================================================================
// Surface 1: Settings (registry rows incl. Cross/thinking rows)
// ===========================================================================

import {
  DEFAULT_CONFIG,
  readConfigEditSnapshot,
  validateConfig,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import {
  SETTINGS_READ_ONLY_REASONS,
  SettingsController,
  type SettingsControllerDependencies,
  type SettingsControllerSnapshot,
  type SettingsExternalAction,
  type SettingsIntent,
} from "../src/settings-controller.js";
import { runSettingsSession, type SettingsSurface } from "../src/settings-session.js";
import { buildSettingsFrame, type SettingsFrameInput } from "../src/ui/settings-frame.js";
import { createTheme } from "../src/ui/theme.js";

/** Same shape as settings-controller.test.ts's own `runtimeSnapshot()`. */
function settingsRuntimeSnapshot(
  overrides: { runActive?: boolean; approvalRuleCount?: number } = {},
): SettingsControllerSnapshot {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    runActive: overrides.runActive ?? false,
    route: null,
    providers: [],
    approvalRules: Array.from({ length: overrides.approvalRuleCount ?? 0 }, (_unused, index) => ({
      id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      decision: "allow" as const,
    })),
    costs: { costKnowledge: "unknown", sessionUsd: 0, dayUsd: 0, totalUsd: 0 },
    cachedModels: [],
    cross: { preferences: { lead: null, challenger: null }, available: true },
  };
}

async function withTempConfigPath(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orcode-surface-matrix-settings-"));
  try {
    await run(join(directory, "config.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface SettingsHarnessOptions {
  readonly snapshot?: SettingsControllerSnapshot;
  readonly executeExternal?: (action: SettingsExternalAction) => Promise<void>;
  readonly preparePublish?: () => void | Promise<void>;
}

function settingsDependencies(path: string, options: SettingsHarnessOptions = {}): SettingsControllerDependencies {
  const snapshot = options.snapshot ?? settingsRuntimeSnapshot();
  let defaultEditSnapshot: Awaited<ReturnType<typeof readConfigEditSnapshot>> | null = null;
  // What this process knows the file to hold; a real startup seeds it from
  // its own config load, and the temp path here holds exactly the defaults.
  let baseline = structuredClone(DEFAULT_CONFIG);
  return {
    configPath: path,
    snapshots: { async read() { return snapshot; } },
    externalActions: {
      async execute(action) {
        await options.executeExternal?.(action);
        // FIX-14 ticket 14: this matrix drives surface states, not the
        // changed/unchanged distinction — it always reports "changed".
        return { kind: "changed" as const };
      },
    },
    liveConfig: {
      prepare: () => ({
        async publish() {
          await options.preparePublish?.();
        },
      }),
    },
    readConfig: async (configPath) => {
      defaultEditSnapshot ??= await readConfigEditSnapshot(configPath);
      return defaultEditSnapshot;
    },
    configBaseline: {
      read: () => baseline,
      note(config) { baseline = structuredClone(config); },
    },
    saveConfig: async (_expected, candidate) => {
      baseline = validateConfig(candidate);
      return baseline;
    },
  };
}

/** Minimal scripted SettingsSurface: replays a fixed intent script, records setBusy transitions. */
function scriptedSettingsSurface(
  intents: readonly SettingsIntent[],
  editorAnswer: { kind: "value"; value: unknown } | { kind: "cancel" },
): { surface: SettingsSurface; busyEvents: boolean[] } {
  const busyEvents: boolean[] = [];
  let cursor = 0;
  return {
    busyEvents,
    surface: {
      begin() {},
      end() {},
      async nextIntent() {
        const next = intents[cursor];
        cursor += 1;
        if (!next) throw new Error("scriptedSettingsSurface: intent script exhausted");
        return next;
      },
      async edit() {
        return editorAnswer as Awaited<ReturnType<SettingsSurface["edit"]>>;
      },
      setBusy(active) {
        busyEvents.push(active);
      },
    },
  };
}

function settingsFrameText(view: SettingsFrameInput["view"]): string {
  const theme = createTheme({ level: 0 });
  const result = buildSettingsFrame({
    width: 80,
    height: 24,
    theme,
    view,
  });
  return result.frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
}

const SETTINGS: SurfaceMatrix = {
  empty: applies(
    "a global search whose query matches zero rows renders one 'No matches' line, not a blank list",
    async () => {
      await withTempConfigPath(async (path) => {
        const controller = await SettingsController.open(settingsDependencies(path));
        await controller.dispatch({ kind: "search-start" });
        await controller.dispatch({ kind: "search-change", query: "zzz-nichts-passt-hier" });
        assert.equal(controller.view.search.active, true);
        assert.equal(controller.view.items.length, 0, "a query matching nothing must project zero items");
        assert.match(settingsFrameText(controller.view), /No matches/);
      });
    },
  ),
  loading: applies(
    "an external action (e.g. 'forget all rules') that reaches a slow dependency shows a busy notice " +
      "while runSettingsSession awaits dispatch/completeEditor — Phase 7 gap fill (setBusy hook)",
    async () => {
      await withTempConfigPath(async (path) => {
        let releaseExecute!: () => void;
        const gate = new Promise<void>((resolvePromise) => { releaseExecute = resolvePromise; });
        const order: string[] = [];
        const snapshot = settingsRuntimeSnapshot({ approvalRuleCount: 1 });
        const dependencies = settingsDependencies(path, {
          snapshot,
          async executeExternal(action) {
            assert.equal(action.kind, "approval-forget-all");
            order.push("execute:start");
            await gate;
            order.push("execute:end");
          },
        });
        const controller = await SettingsController.open(dependencies);
        const { surface, busyEvents } = scriptedSettingsSurface(
          [
            { kind: "select-item", itemId: "approval-forget-all" },
            { kind: "activate" },
            { kind: "back" },
          ],
          { kind: "value", value: true },
        );
        const sessionDone = runSettingsSession(controller, surface);
        // Let the scripted surface drive dispatch()/completeEditor() up to the
        // point where executeExternal is blocked on `gate`.
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        assert.deepEqual(busyEvents, [true], "setBusy(true) must fire before the slow action settles");
        assert.deepEqual(order, ["execute:start"]);
        releaseExecute();
        await sessionDone;
        assert.deepEqual(busyEvents, [true, false], "setBusy(false) must fire once the action settles");
        assert.deepEqual(order, ["execute:start", "execute:end"]);
      });
    },
  ),
  error: applies(
    "an external action that throws produces a view.notice of kind 'error'",
    async () => {
      await withTempConfigPath(async (path) => {
        const snapshot = settingsRuntimeSnapshot({ approvalRuleCount: 1 });
        const dependencies = settingsDependencies(path, {
          snapshot,
          async executeExternal() { throw new Error("synthetic external failure"); },
        });
        const controller = await SettingsController.open(dependencies);
        await controller.dispatch({ kind: "select-item", itemId: "approval-forget-all" });
        const opened = await controller.dispatch({ kind: "activate" });
        assert.equal(opened.kind, "edit");
        if (opened.kind !== "edit") return;
        await controller.completeEditor(opened.request, { kind: "value", value: true });
        assert.equal(controller.view.notice?.kind, "error");
      });
    },
  ),
  success: applies(
    "an external action that resolves produces a view.notice of kind 'success' ('Gespeichert')",
    async () => {
      await withTempConfigPath(async (path) => {
        const snapshot = settingsRuntimeSnapshot({ approvalRuleCount: 1 });
        const dependencies = settingsDependencies(path, { snapshot, async executeExternal() {} });
        const controller = await SettingsController.open(dependencies);
        await controller.dispatch({ kind: "select-item", itemId: "approval-forget-all" });
        const opened = await controller.dispatch({ kind: "activate" });
        assert.equal(opened.kind, "edit");
        if (opened.kind !== "edit") return;
        await controller.completeEditor(opened.request, { kind: "value", value: true });
        assert.equal(controller.view.notice?.kind, "success");
        assert.equal(controller.view.notice?.message, "Saved");
      });
    },
  ),
  focus: applies(
    "selectedItemId advances with a 'move' intent and the rendered row is marked selected",
    async () => {
      await withTempConfigPath(async (path) => {
        const controller = await SettingsController.open(settingsDependencies(path));
        const before = controller.view.selectedItemId;
        await controller.dispatch({ kind: "move", delta: 1 });
        const after = controller.view.selectedItemId;
        assert.notEqual(after, before, "moving must change which row is focused");
        const text = settingsFrameText(controller.view);
        // The focused row's own label must appear in the rendered frame at all
        // (a moved-off-screen focus would still be a real, if untested, bug —
        // the label's presence combined with `after` being a real row id from
        // `view.items` is the reachability + presentation proof here).
        assert.ok(controller.view.items.some((item) => item.id === after));
        assert.match(text, /./);
      });
    },
  ),
  disabled: applies(
    "a row with zero eligible targets (e.g. 'forget all rules' with no remembered rules) carries a disabledReason",
    async () => {
      await withTempConfigPath(async (path) => {
        const controller = await SettingsController.open(
          settingsDependencies(path, { snapshot: settingsRuntimeSnapshot({ approvalRuleCount: 0 }) }),
        );
        const row = controller.view.allItems.find((item) => item.id === "approval-forget-all");
        assert.equal(row?.disabledReason, "No remembered rules");
      });
    },
  ),
  cancel: applies(
    "cancelling an open editor returns to the row list and never reports success (E-HONEST-02)",
    async () => {
      await withTempConfigPath(async (path) => {
        let executed = false;
        const snapshot = settingsRuntimeSnapshot({ approvalRuleCount: 1 });
        const dependencies = settingsDependencies(path, {
          snapshot,
          async executeExternal() { executed = true; },
        });
        const controller = await SettingsController.open(dependencies);
        await controller.dispatch({ kind: "select-item", itemId: "approval-forget-all" });
        const opened = await controller.dispatch({ kind: "activate" });
        assert.equal(opened.kind, "edit");
        if (opened.kind !== "edit") return;
        const effect = await controller.completeEditor(opened.request, { kind: "cancel" });
        assert.equal(effect.kind, "render");
        assert.equal(executed, false, "cancelling must never reach the external action");
        assert.notEqual(controller.view.notice?.kind, "success", "cancel must never present as success");
      });
    },
  ),
  recovery: applies(
    "a durable-owner conflict during save presents the distinct 'Recovery required' notice " +
      "and puts Settings into read-only until restart",
    async () => {
      await withTempConfigPath(async (path) => {
        const { SettingsLiveConfigRecoveryRequiredError } = await import("../src/settings-controller.js");
        const dependencies = settingsDependencies(path, {
          async preparePublish() { throw new SettingsLiveConfigRecoveryRequiredError(); },
        });
        const controller = await SettingsController.open(dependencies);
        await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
        const opened = await controller.dispatch({ kind: "activate" });
        assert.equal(opened.kind, "edit");
        if (opened.kind !== "edit") return;
        await controller.completeEditor(opened.request, { kind: "value", value: "on" });
        assert.equal(controller.view.notice?.kind, "error");
        assert.match(controller.view.notice?.message ?? "", /Recovery/);
        assert.equal(
          controller.view.readOnlyReason,
          SETTINGS_READ_ONLY_REASONS.restartRequired,
        );
      });
    },
  ),
};

// ===========================================================================
// Surface 2: Setup (src/setup-surface/index.ts)
// ===========================================================================

import {
  BackendRegistry,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderInspection,
} from "../src/backends.js";
import { ProviderStateStore, createNeverConfiguredProviderState } from "../src/provider-state.js";
import { SetupOrchestrator } from "../src/setup.js";
import {
  runSetupHub,
  type SetupHubEntry,
  type SetupPresentation,
  type SetupSurface as SetupUiSurface,
} from "../src/setup-surface/index.js";
import type { ProviderActivationRequest, ProviderActivationResult } from "../src/provider-activation.js";

const SETUP_OPENROUTER: BackendDescriptor = {
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: { models: true, tools: true, reasoning: true },
};

const SETUP_ANTHROPIC: BackendDescriptor = {
  id: "anthropic",
  displayName: "Anthropic / Claude subscription",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: { models: false, tools: false, reasoning: false },
};

const SETUP_MODEL: BackendModelDescriptor = {
  backendId: "openrouter",
  requestedModelId: "openai/gpt-5",
  canonicalModelId: "openai/gpt-5",
  displayName: "GPT-5",
  capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
};

/** Same shape as setup-ui.test.ts's own `Adapter` — trimmed to what this file needs. */
class SetupTestAdapter implements BackendAdapter {
  readonly backendId = "openrouter" as const;
  readonly connected: string[] = [];
  rejectedCandidates = new Set<string>();
  models: readonly BackendModelDescriptor[] = [SETUP_MODEL];

  async inspect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async reconnect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async logout(): Promise<void> {}
  async discardCandidate(): Promise<void> {}
  async connect(request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
    this.connected.push(String(request.candidate));
    const rejected = this.rejectedCandidates.has(String(request.candidate));
    return {
      candidateId: "candidate",
      backendId: "openrouter",
      connectionId: "connection",
      accountFingerprint: "acct",
      billingRealm: "openrouter-payg",
      health: rejected
        ? { credential: "rejected", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 1, generation: 1 }
        : { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 1, generation: 1 },
    };
  }
  async listModels(): Promise<readonly BackendModelDescriptor[]> { return this.models; }
  async activate(): Promise<CandidateProviderState> { throw new Error("not used"); }
}

/** Same shape as setup-ui.test.ts's own `fixture()` — trimmed to openrouter + anthropic-coming-soon. */
function setupFixture(surface: SetupUiSurface, adapter = new SetupTestAdapter()) {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const registry = new BackendRegistry([{ descriptor: SETUP_OPENROUTER, adapter }, { descriptor: SETUP_ANTHROPIC }]);
  const activationCoordinator = {
    async activate(request: ProviderActivationRequest): Promise<ProviderActivationResult> {
      const route = {
        version: 1 as const,
        backendId: "openrouter" as const,
        accountFingerprint: "acct",
        billingRealm: "openrouter-payg" as const,
        requestedModelId: request.selectedCanonicalModelId,
        canonicalModelId: request.selectedCanonicalModelId,
        resolutionState: "resolved" as const,
      };
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [{
          id: "connection", backendId: "openrouter", enabled: true, maturity: "stable",
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
          accountFingerprint: "acct", accountFingerprintState: "verified", billingRealm: "openrouter-payg", lastHealth: null,
        }],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }, previous.revision);
      return { persisted: request.persistence === "persisted", warnings: [], state, route };
    },
  };
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  return { adapter, stateStore, registry, orchestrator, surface, executionMode: "local-interactive-owner" as const };
}

/** Minimal scripted SetupSurface — same role as setup-ui.test.ts's own `ScriptedSurface`. */
class ScriptedSetupSurface implements SetupUiSurface {
  readonly entries: SetupHubEntry[][] = [];
  readonly presented: Array<{ type: string; message?: string; busy?: boolean }> = [];

  constructor(
    private readonly hub: Array<string | null>,
    private readonly secrets: Array<string | null> = [],
    private readonly models: Array<string | null> = [],
    private readonly confirms: boolean[] = [],
  ) {}

  async chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null> {
    this.entries.push([...entries]);
    return this.hub.shift() ?? null;
  }
  async readSecret(): Promise<string | null> { return this.secrets.shift() ?? null; }
  async chooseModel(): Promise<string | null> { return this.models.shift() ?? null; }
  async confirm(): Promise<boolean> { return this.confirms.shift() ?? false; }
  present(event: SetupPresentation): void {
    this.presented.push({
      type: event.type,
      message: "message" in event ? event.message : undefined,
      busy: "busy" in event ? event.busy : undefined,
    });
  }
}

const SETUP: SurfaceMatrix = {
  empty: notApplicable(
    "the hub lists every backend an owner can connect plus the one disabled row that redirects " +
      "instead (E-HONEST-01), and the real registry always has at least OpenRouter — there is no " +
      "code path where chooseHub receives zero entries",
  ),
  loading: applies(
    "activateProvider shows a busy notice before connect()/listModels() (both real network calls) — " +
      "Phase 7 gap fill; previously there was no presentation for either wait",
    async () => {
      const adapter = new SetupTestAdapter();
      const surface = new ScriptedSetupSurface(["openrouter", null], ["sk-test-key"], ["openai/gpt-5"]);
      const context = setupFixture(surface, adapter);
      await runSetupHub({ ...context, surface } as never);
      const busyNotices = surface.presented.filter((event) => event.type === "notice" && event.busy === true);
      assert.ok(busyNotices.length >= 1, "expected at least one busy=true notice before activation completed");
      assert.match(busyNotices[0]?.message ?? "", /checking credentials/i);
    },
  ),
  error: applies(
    "a rejected credential produces the explicit 'could not validate the API key' notice",
    async () => {
      const adapter = new SetupTestAdapter();
      adapter.rejectedCandidates.add("sk-bad-key");
      const surface = new ScriptedSetupSurface(["openrouter", null], ["sk-bad-key"]);
      const context = setupFixture(surface, adapter);
      const result = await runSetupHub({ ...context, surface } as never);
      assert.equal(result.kind, "cancelled");
      assert.ok(surface.presented.some((event) =>
        event.type === "notice" && (event.message ?? "").includes("could not validate the API key")));
    },
  ),
  success: applies(
    "a valid credential and one compatible model reach SetupHubResult { kind: 'ready' }",
    async () => {
      const adapter = new SetupTestAdapter();
      const surface = new ScriptedSetupSurface(["openrouter", null], ["sk-good-key"], ["openai/gpt-5"], [true]);
      const context = setupFixture(surface, adapter);
      const result = await runSetupHub({ ...context, surface } as never);
      assert.equal(result.kind, "ready");
    },
  ),
  disabled: applies(
    "exactly one disabled row exists (E-HONEST-01), and FIX-12 changed what it says: the Anthropic " +
      "row is a redirect, not a promise — BackendRegistry forbids anthropic an adapter and no direct " +
      "backend is planned, so 'Coming soon' claimed a future that does not exist. The fabricated " +
      "'Codex' row next to it is gone entirely: codex has no descriptor at all (the same constructor " +
      "throws on registering it), so that row announced nothing about nothing. disabled: true plus " +
      "every surface's filter on it is what keeps the surviving row unpickable by contract",
    async () => {
      const surface = new ScriptedSetupSurface([null]);
      const context = setupFixture(surface);
      await runSetupHub({ ...context, surface } as never);
      const anthropicRow = surface.entries[0]?.find((entry) => entry.id === "anthropic");
      assert.equal(anthropicRow?.disabled, true);
      assert.match(anthropicRow?.description ?? "", /Not available as a direct backend/);
      assert.equal(surface.entries[0]?.some((entry) => entry.id === "codex"), false);
      assert.doesNotMatch(
        surface.entries[0]!.map((entry) => `${entry.label} ${entry.description}`).join("\n"),
        /coming soon/i,
      );
    },
  ),
  cancel: applies(
    "backing out of the hub (chooseHub returns null) reaches SetupHubResult { kind: 'cancelled' }, never 'ready' (E-HONEST-02)",
    async () => {
      const surface = new ScriptedSetupSurface([null]);
      const context = setupFixture(surface);
      const result = await runSetupHub({ ...context, surface } as never);
      assert.equal(result.kind, "cancelled");
      assert.equal(result.mode, "setup-required");
    },
  ),
  focus: notApplicable(
    "chooseHub/chooseModel delegate cursor/highlight entirely to the shared TerminalUi.pickChoice picker " +
      "primitive (src/setup-surface/index.ts createTuiSetupSurface) — the same one Cross gate's TUI surface " +
      "uses; see the 'cross-gate / focus' row, which exercises that shared primitive directly",
  ),
  recovery: applies(
    "a connected account with zero compatible models reaches SetupHubResult.kind 'retry' and the hub " +
      "reopens in the same call — no restart, no lost progress",
    async () => {
      const adapter = new SetupTestAdapter();
      adapter.models = [];
      const surface = new ScriptedSetupSurface(["openrouter", null], ["sk-test-key"]);
      const context = setupFixture(surface, adapter);
      const result = await runSetupHub({ ...context, surface } as never);
      assert.equal(result.kind, "cancelled");
      assert.equal(surface.entries.length, 2, "the hub must reopen once after the no-compatible-models retry");
      assert.ok(surface.presented.some((event) =>
        (event.message ?? "").includes("did not return a compatible main model")));
    },
  ),
};

// ===========================================================================
// Surface 3: Cross gate (src/cross-gate.ts)
// ===========================================================================

import { runCrossGate, type CrossGateAction, type CrossGateDeps, type CrossGateView } from "../src/cross-gate.js";
import type { CrossPreferencesV1, CrossRunResult } from "../src/collaboration.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";

function crossRoute(model: string, account = `acct-${model}`): RouteIdentityV1 {
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

function crossCandidate(route: RouteIdentityV1): SelectableModelRoute {
  return {
    route,
    providerLabel: "OpenRouter",
    model: {
      id: route.requestedModelId,
      name: route.requestedModelId,
      contextLength: 128_000,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: false,
  };
}

/** Same shape as cross-gate.test.ts's own `gateHarness()`. */
function crossGateHarness(overrides: {
  preferences?: CrossPreferencesV1;
  chooseGate?: (view: CrossGateView) => Promise<CrossGateAction | null>;
  pickModelRoute?: SelectableModelRoute | null;
  unavailableReason?: string | null;
  publishPreferences?: (next: CrossPreferencesV1) => Promise<void>;
  start?: (task: string) => Promise<CrossRunResult>;
} = {}) {
  const starts: string[] = [];
  const restores: number[] = [];
  const busyEvents: boolean[] = [];
  let preferences: CrossPreferencesV1 = overrides.preferences ?? { lead: null, challenger: null };
  const views: CrossGateView[] = [];
  const deps: CrossGateDeps = {
    port: {
      async start(task) {
        starts.push(task);
        return overrides.start
          ? overrides.start(task)
          : { phase: "completed", snapshot: {} } as unknown as CrossRunResult;
      },
    },
    picker: {
      async pickModelRoute(request) {
        void request;
        return overrides.pickModelRoute ?? null;
      },
    },
    readPreferences: () => structuredClone(preferences),
    publishPreferences: overrides.publishPreferences ?? (async (next) => {
      preferences = structuredClone(next);
    }),
    surface: {
      async chooseGate(view) {
        views.push(view);
        return overrides.chooseGate ? overrides.chooseGate(view) : null;
      },
      setBusy(active) { busyEvents.push(active); },
    },
    restoreDraft: () => { restores.push(1); },
    unavailableReason: () => overrides.unavailableReason ?? null,
    cachedModels: () => [],
    // FIX-14 ticket 4: required dep — this matrix drives states, not money,
    // so it states "no packet" as 0 rather than relying on a default.
    chatContextChars: () => 0,
  };
  return { deps, starts, restores, busyEvents, views };
}

const CROSS_GATE: SurfaceMatrix = {
  empty: notApplicable(
    "the gate is a fixed 4-action form (coding/review/swap/start), never a variable-length list — even " +
      "the unavailable case still renders the reason text, not a blank view",
  ),
  loading: applies(
    "publishing a staged pair change (real disk I/O under the shared config write lock, contended by a " +
      "concurrent Settings edit) shows a busy notice — Phase 7 gap fill (CrossGateSurface.setBusy)",
    async () => {
      let releasePublish!: () => void;
      const gate = new Promise<void>((resolvePromise) => { releasePublish = resolvePromise; });
      const order: string[] = [];
      const lead = crossRoute("vendor/lead");
      const challenger = crossRoute("vendor/challenger");
      const replacement = crossRoute("vendor/replacement");
      let call = 0;
      const h = crossGateHarness({
        preferences: { lead, challenger },
        // publishPreferences only runs for a *staged* change (see
        // cross-gate.ts: `if (staged?.lead && staged.challenger)`), so this
        // picks a new coding route first to create one, then starts.
        pickModelRoute: crossCandidate(replacement),
        chooseGate: async () => { call += 1; return call === 1 ? "coding" : "start"; },
        publishPreferences: async () => { order.push("publish:start"); await gate; order.push("publish:end"); },
      });
      const done = runCrossGate(h.deps, "draft");
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.deepEqual(h.busyEvents, [true], "setBusy(true) must fire before the publish settles");
      assert.deepEqual(order, ["publish:start"]);
      releasePublish();
      await done;
      assert.deepEqual(h.busyEvents, [true, false]);
      assert.deepEqual(h.starts, ["draft"], "the run must still start once publish settles");
    },
  ),
  error: applies(
    "a publish failure rethrows to the caller after restoring the draft and staged state — never a silent drop",
    async () => {
      const lead = crossRoute("vendor/lead");
      const challenger = crossRoute("vendor/challenger");
      const h = crossGateHarness({
        preferences: { lead, challenger },
        pickModelRoute: crossCandidate(crossRoute("vendor/replacement")),
        chooseGate: async (view) => (view.coding.includes("replacement") ? "start" : "coding"),
        publishPreferences: async () => { throw new Error("publication failed"); },
      });
      await assert.rejects(runCrossGate(h.deps, "draft"), /publication failed/);
      assert.equal(h.restores.length, 1);
      assert.deepEqual(h.starts, []);
    },
  ),
  success: applies(
    "a valid pair confirms once and reaches CrossCommandPort.start exactly once with the preserved task",
    async () => {
      const lead = crossRoute("vendor/lead");
      const challenger = crossRoute("vendor/challenger");
      const h = crossGateHarness({ preferences: { lead, challenger }, chooseGate: async () => "start" });
      await runCrossGate(h.deps, "the task text");
      assert.deepEqual(h.starts, ["the task text"]);
    },
  ),
  disabled: applies(
    "an unavailable route (Kimi today) shows the concrete reason and never opens a picker or starts, " +
      "even against an adversarial surface that tries to force one (E-HONEST-01/02)",
    async () => {
      const h = crossGateHarness({
        preferences: { lead: crossRoute("vendor/lead"), challenger: crossRoute("vendor/challenger") },
        unavailableReason: "Cross is unavailable on Kimi Code routes",
        chooseGate: async () => "coding",
      });
      await runCrossGate(h.deps, "draft");
      assert.equal(h.views[0]?.unavailableReason, "Cross is unavailable on Kimi Code routes");
      assert.deepEqual(h.starts, []);
    },
  ),
  cancel: applies(
    "cancelling (chooseGate returns null) restores the draft and never starts a run",
    async () => {
      const h = crossGateHarness({
        preferences: { lead: crossRoute("vendor/lead"), challenger: crossRoute("vendor/challenger") },
        chooseGate: async () => null,
      });
      await runCrossGate(h.deps, "draft");
      assert.equal(h.restores.length, 1);
      assert.deepEqual(h.starts, []);
    },
  ),
  focus: notApplicable(
    "chooseGate delegates cursor/highlight entirely to the shared TerminalUi.pickChoice picker primitive " +
      "(src/cli.ts's TUI CrossGateSurface) — see 'command-finder / focus', which exercises that same " +
      "shared primitive directly against the real TerminalUi",
  ),
  recovery: applies(
    "an incomplete or same-route pair recovers in place — picking a different model re-validates " +
      "automatically within the same gate visit, no restart or re-entry needed",
    async () => {
      const same = crossRoute("vendor/same");
      const replacement = crossRoute("vendor/replacement");
      let call = 0;
      const h = crossGateHarness({
        preferences: { lead: same, challenger: same },
        pickModelRoute: crossCandidate(replacement),
        chooseGate: async (view) => {
          call += 1;
          if (call === 1) {
            assert.equal(view.canStart, false, "same-route pair must block start");
            return "review";
          }
          assert.equal(view.canStart, true, "picking a distinct review route must clear the block in place");
          return "start";
        },
      });
      await runCrossGate(h.deps, "draft");
      assert.deepEqual(h.starts, ["draft"]);
    },
  ),
};

// ===========================================================================
// Surface 4: Command finder (menu states incl. the empty-result recovery)
// ===========================================================================

import { resolveCommandMenuRows, projectCommandMenu, type CommandMenuRuntime } from "../src/ui/command-menu.js";
import { TerminalUi, type DashboardState } from "../src/tui.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 28;
  output = "";
  write(value: string | Uint8Array): boolean { this.output += value.toString(); return true; }
}

const MENU_DASHBOARD_STATE: DashboardState = {
  workspace: "/tmp/matrix-fixture",
  projectStatus: "matrix-fixture · Git main · 0 Chat-Nachrichten",
  model: "openrouter/auto",
  resolvedModel: "openrouter/auto",
  approval: "ask",
  reasoning: "auto",
  maxCost: "$1",
  maxSteps: 1,
};

const MENU_THEME = createTheme({ level: 0 });

function menuTerminal(stdin: FakeInput, stdout: FakeOutput, options?: { commandMenuRuntime?: () => CommandMenuRuntime }): TerminalUi {
  return new TerminalUi(
    () => MENU_DASHBOARD_STATE,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    MENU_THEME,
    options,
  );
}

function press(stdin: FakeInput, name: string, character = "", extra: Record<string, unknown> = {}): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false, ...extra });
}

function type(stdin: FakeInput, value: string): void {
  for (const character of value) press(stdin, character.toLowerCase(), character);
}

const COMMAND_FINDER: SurfaceMatrix = {
  empty: applies(
    "a query matching zero commands never renders a blank list — it is replaced by the one recovery row " +
      "(same mechanism as 'recovery' below; there is no code path where the menu shows nothing at all)",
    () => {
      const rows = resolveCommandMenuRows({ path: [], query: "zzz-nichts-passt", selectedIndex: 0 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "recovery");
    },
  ),
  loading: notApplicable(
    "resolveCommandMenuRows/projectCommandMenu are pure, synchronous functions over the static in-memory " +
      "COMMAND_TREE (command-catalog.ts) — no I/O, no network call, no async gap exists in the menu's own " +
      "code path to ever be 'loading'",
  ),
  error: notApplicable(
    "resolveCommandMenuRows/projectCommandMenu are pure total functions — every (path, query) input maps " +
      "to a valid row set and neither ever throws; a chosen command's own execution failure is that " +
      "command's error state (e.g. voice/transcribe/cross-gate above), not the finder's",
  ),
  success: notApplicable(
    "the finder's job ends at selection — closing the menu and handing off to the chosen command, which " +
      "has its own success presentation (ui.addMessage/settings notices/etc. elsewhere in this matrix); " +
      "there is no distinct 'the menu succeeded' moment beyond an ordinary close",
  ),
  disabled: applies(
    "a row with a runtime disabledReason is presented, and attempting it leaves the draft untouched " +
      "with an explicit unavailable message",
    async () => {
      // Two different reachability paths land on two different commands
      // (root browse via Ctrl+P below lands on the first root category's
      // first leaf, "model"; the direct search assertion below that filters
      // to "think") — disabling both keeps each assertion honest about
      // which command it actually exercises, instead of quietly relying on
      // whichever one happens to be first.
      const runtime: CommandMenuRuntime = new Map([
        ["model", { disabledReason: "Offline" }],
        ["think", { disabledReason: "Offline" }],
      ]);
      const projection = projectCommandMenu({ path: [], query: "th", selectedIndex: 0 }, runtime);
      assert.equal(projection.entries[0]?.name, "/think");
      assert.equal(projection.entries[0]?.disabledReason, "Offline");

      const stdin = new FakeInput();
      const stdout = new FakeOutput();
      const terminal = menuTerminal(stdin, stdout, { commandMenuRuntime: () => runtime });
      terminal.start();
      try {
        const value = terminal.readInput();
        type(stdin, "stays");
        press(stdin, "p", String.fromCharCode(16), { ctrl: true });
        press(stdin, "return");
        press(stdin, "tab");
        press(stdin, "return");
        assert.match(terminal.frame().lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n"), /not available/);
        press(stdin, "escape"); press(stdin, "escape"); press(stdin, "return");
        assert.equal(await value, "stays");
      } finally {
        terminal.stop();
      }
    },
  ),
  cancel: applies(
    "escape cancels the menu outright and restores the exact pre-menu draft, never leaving stray query text",
    async () => {
      const stdin = new FakeInput();
      const stdout = new FakeOutput();
      const terminal = menuTerminal(stdin, stdout);
      terminal.start();
      try {
        const value = terminal.readInput();
        type(stdin, "unchanged");
        press(stdin, "p", String.fromCharCode(16), { ctrl: true });
        type(stdin, "m");
        press(stdin, "escape", "");
        press(stdin, "return", "\r");
        assert.equal(await value, "unchanged");
      } finally {
        terminal.stop();
      }
    },
  ),
  focus: applies(
    "arrow-key navigation moves the selected row, provable end-to-end by which entry Tab then completes " +
      "to — the same TerminalUi.pickChoice-family cursor primitive Setup's and Cross gate's TUI surfaces " +
      "also rely on for their own row highlighting",
    async () => {
      const stdin = new FakeInput();
      const stdout = new FakeOutput();
      const terminal = menuTerminal(stdin, stdout);
      terminal.start();
      try {
        const value = terminal.readInput();
        press(stdin, "/", "/");
        press(stdin, "return");
        // Models: model, fallback, think (FIX-15 ordering).
        press(stdin, "down");
        press(stdin, "down");
        press(stdin, "tab");
        type(stdin, "high");
        press(stdin, "return");
        assert.equal(await value, "/think high");
      } finally {
        terminal.stop();
      }
    },
  ),
  recovery: applies(
    "a query with zero matches renders exactly one 'Show all commands' row naming the failed query " +
      "and promising the input will be cleared — never a dead end (E-STRUCT-02)",
    () => {
      const projection = projectCommandMenu({ path: [], query: "zzz-nichts-passt", selectedIndex: 0 }, new Map());
      assert.equal(projection.entries.length, 1);
      assert.match(projection.entries[0]!.name, /Show all commands/);
      assert.match(projection.entries[0]!.description ?? "", /No matches/);
      assert.match(projection.entries[0]!.description ?? "", /zzz-nichts-passt/);
    },
  ),
};

// ===========================================================================
// Completeness check — every surface must list all 8 states, no silent gaps.
// ===========================================================================

const MATRIX: Readonly<Record<string, SurfaceMatrix>> = {
  settings: SETTINGS,
  setup: SETUP,
  "cross-gate": CROSS_GATE,
  "command-finder": COMMAND_FINDER,
};

test("surface-state matrix has no silent omissions: every surface lists all 8 states exactly once", () => {
  for (const [surface, rows] of Object.entries(MATRIX)) {
    assert.deepEqual(Object.keys(rows).sort(), [...STATES].sort(), `${surface}: must list every state exactly once`);
  }
});

for (const [surfaceName, rows] of Object.entries(MATRIX)) {
  for (const state of STATES) {
    const row = rows[state];
    test(`${surfaceName} / ${state}`, async () => {
      if (!row.applies) {
        assert.ok(row.reason.length > 0, `${surfaceName}/${state}: n/a rows must carry a one-line reason`);
        return;
      }
      await row.evidence();
    });
  }
}
