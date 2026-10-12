#!/usr/bin/env node
/**
 * Phase 8 final-verification evidence harness (.ai-collab/evidence/20260827-phase8/).
 *
 * NOT part of `npm run test:pty` — this is a one-off evidence-capture fixture,
 * deliberately separate from `tests/fixtures/pty-harness.mjs` (the release
 * smoke's own fixture) so nothing here can destabilize that suite. It follows
 * the exact same proven techniques:
 *
 *   - a fake `ProviderRuntime` that never calls a real provider (`execute()`
 *     throws, matching the release harness's own guard) and pre-populates a
 *     resolved, distinct Cross pair so `/cross` and the Settings Cross rows
 *     are reachable without any network call;
 *   - `/settings`, `/cross`, and `/ssh` are driven as real typed keystrokes
 *     (the composer's own early-submit path resolves and executes a
 *     complete command directly, the same mechanism the release harness
 *     relies on for `/image <path>` + one Enter — see the note above the
 *     (now-empty) signal-handler section below);
 *   - direct `terminal.handleRunEvent(...)` / `setInterjectHandler` /
 *     `setEndThinkingHandler` calls from a second signal handler to prove the
 *     mid-run interjection and thinking-hint UI without a real model call —
 *     the identical technique `scripts/check-pty-esc-split.mjs` already uses
 *     and that suite's own doc comment explains why a real `OrcodeAgent.run()`
 *     is deliberately out of reach here (`ensureRunnableModelConfiguration`
 *     needs real/faked network model listing).
 *   - `CommandContext`'s existing `/ssh` test seams (`sshConfigPath`,
 *     `sshRunner`, `sshAppHome` — see `tests/ssh-slash-command.test.ts`) so
 *     `/ssh <alias>` never touches the real `~/.ssh/config` or spawns a real
 *     `ssh` binary.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliModuleUrl = process.env.ORCODE_PTY_CLI_MODULE;
if (!cliModuleUrl) throw new Error("ORCODE_PTY_CLI_MODULE missing.");
const tuiModuleUrl = process.env.ORCODE_PTY_TUI_MODULE;
if (!tuiModuleUrl) throw new Error("ORCODE_PTY_TUI_MODULE missing.");

const cli = await import(cliModuleUrl);
const tui = await import(tuiModuleUrl);
const config = await import(new URL("./config.js", cliModuleUrl));
const { SessionStore } = await import(new URL("./session.js", cliModuleUrl));
const { RuleStore } = await import(new URL("./rules.js", cliModuleUrl));
const { OpenRouterService } = await import(new URL("./openrouter.js", cliModuleUrl));

const root = await mkdtemp(join(tmpdir(), "orcode-pty-evidence-"));
const workspace = join(root, "workspace");
const appHome = join(root, "app");
const configPath = join(appHome, "config.json");
const sshAppHome = join(root, "ssh-app-home");
const sshConfigPath = join(root, "ssh-config");
await mkdir(workspace, { recursive: true });
await mkdir(appHome, { recursive: true });
// Two fake, always-reachable hosts — /ssh never spawns a real `ssh` process
// because `sshRunner` below is a fake that always returns exit code 0.
await writeFile(
  sshConfigPath,
  "Host vps\n  HostName 203.0.113.9\n  User owner\n\nHost staging\n  HostName 198.51.100.4\n",
);

const persisted = structuredClone(config.DEFAULT_CONFIG);
persisted.mainModel = "vendor/main";
await config.saveConfig(persisted, configPath);
const session = SessionStore.create(workspace, appHome, "Phase 8 evidence");
const mainRoute = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "evidence-account",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/main",
  canonicalModelId: "vendor/main",
  resolutionState: "resolved",
});
session.setPreferences("vendor/main", { mode: "auto" }, mainRoute);
await session.save();
const rules = await RuleStore.load(appHome);

// A pre-set, fully resolved, DISTINCT Cross pair — Settings' Cross rows and
// `/cross`'s gate must both show it pre-filled without either ever having to
// auto-select anything (the audit's hard requirement: never auto-select
// either Cross model; this pair models a pair the *owner* chose earlier).
let liveRoute = mainRoute;
const leadRoute = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "evidence-account",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/lead-model",
  canonicalModelId: "vendor/lead-model",
  resolutionState: "resolved",
});
const challengerRoute = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "evidence-account",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/challenger-model",
  canonicalModelId: "vendor/challenger-model",
  resolutionState: "resolved",
});
let crossPreferences = { lead: leadRoute, challenger: challengerRoute };
let crossPublishCalls = 0;
let providerCalls = 0;

const runtime = {
  openRouter: new OpenRouterService(undefined),
  credentials: {},
  providerCredentials: {},
  preparedRoles: null,
  async inspectStartup() {
    return { mode: "ready", generation: 1, defaultRoute: liveRoute, readyRoutes: [liveRoute], warnings: [], crossEnabled: true };
  },
  async resolveLegacyDefaultRoute() { return this.inspectStartup(); },
  async runSetup() { return { kind: "ready", route: liveRoute }; },
  ensureRunnableRoute() { return liveRoute; },
  currentSessionRoute() { return liveRoute; },
  modelRuntime() { return {}; },
  adoptSession() {},
  async selectSessionRoute(next) { liveRoute = next; return next; },
  async runWithReadyRoute(run) { return run(liveRoute); },
  activity() { return { runActive: false, activationHeld: false }; },
  async runSettingsConfigMutation(task) { return task(); },
  readCachedSettingsRoute() {
    return { backendId: "openrouter", providerLabel: "OpenRouter", requestedModelId: liveRoute.requestedModelId, canonicalModelId: liveRoute.canonicalModelId, modelLabel: "Synthetic main", billingRealm: "openrouter-payg" };
  },
  readCachedProviderStatus() {
    return [{ backendId: "openrouter", displayName: "OpenRouter", availability: "connectable", configuration: "enabled", maturity: "stable", billingRealm: "openrouter-payg", headline: "evidence runtime", health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" }, isDefault: true, allowedActions: [] }];
  },
  readCachedSettingsModels() {
    return [
      { id: "vendor/main", name: "Synthetic main", description: "local evidence model", contextLength: 128000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/lead-model", name: "Synthetic lead", description: "local evidence model", contextLength: 128000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/challenger-model", name: "Synthetic challenger", description: "local evidence model", contextLength: 128000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
    ];
  },
  prepareSettingsModelPublication(next) { return { publish() { liveRoute = next; } }; },
  readModelPreferenceAuthority() { return { route: liveRoute, providerRevision: 1, connectionId: "evidence-runtime" }; },
  async transitionSessionModel() { throw new Error("Evidence scenario must not mutate provider routes"); },
  async execute() { providerCalls += 1; throw new Error("Evidence scenario must not call provider actions"); },
  // --- Cross wiring (Phase 2/6): both required so `/cross` and Settings'
  // Cross rows report `available: true` (see `crossUnavailableReasonFor`,
  // src/cli.ts) instead of "Cross is not available in this runtime". ---
  readCrossPreferences() {
    return structuredClone(crossPreferences);
  },
  async publishCrossPreferences(next) {
    crossPublishCalls += 1;
    crossPreferences = structuredClone(next);
    return structuredClone(crossPreferences);
  },
  // --- ModelRouteCatalogPort (used by the model-route picker for both main/
  // compressor/Cross roles) — cached-only, no network. ---
  async listSelectableModelRoutes() {
    return [
      { route: mainRoute, providerLabel: "OpenRouter", model: { id: "vendor/main", name: "Synthetic main", price: { kind: "unknown" } }, supportsTools: true, supportsReasoning: true },
      { route: leadRoute, providerLabel: "OpenRouter", model: { id: "vendor/lead-model", name: "Synthetic lead", price: { kind: "unknown" } }, supportsTools: true, supportsReasoning: true },
      { route: challengerRoute, providerLabel: "OpenRouter", model: { id: "vendor/challenger-model", name: "Synthetic challenger", price: { kind: "unknown" } }, supportsTools: true, supportsReasoning: true },
    ];
  },
};

process.stdout.write(`ORCODE_PTY_READY:${JSON.stringify({ stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true, columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null })}\n`);
process.chdir(workspace);

let dashboardInput;
let capturedUi;
const startTerminalUi = tui.TerminalUi.prototype.start;
tui.TerminalUi.prototype.start = function (...args) {
  capturedUi = this;
  return startTerminalUi.apply(this, args);
};

// `/settings`, `/cross`, and `/ssh` are all driven as REAL typed keystrokes
// (composer text + Enter) by the evidence driver, not via a signal-triggered
// direct `handleSlashCommand` call: `TerminalUi`'s own early-submit check
// (`this.#commandMenu && this.#commandMenuDraft === null && (return/enter) &&
// resolveSlashCommand(this.#inputChars.join(""))`, src/tui.ts:2344-2352)
// submits a fully-resolvable typed command straight through, bypassing the
// inline command-menu's row-accept step — exactly the mechanism
// `scripts/check-pty.mjs` relies on for `/image <path>` + one Enter. That
// makes a genuine keyboard path available for every command this evidence
// run exercises, so no direct-call shortcut is needed here.

/**
 * Stage machine advanced by SIGUSR2 — proves the mid-run interjection path
 * and the thinking hint/esc-split without a real model call, reusing the
 * exact mechanism `scripts/check-pty-esc-split.mjs` already validates (that
 * script's own doc comment explains why a real agent run is out of scope for
 * a PTY fixture with no faked network model listing).
 */
let signalStage = "not-started";
process.on("SIGUSR2", () => {
  const terminal = capturedUi;
  if (!terminal) return;
  if (signalStage === "not-started") {
    signalStage = "run-armed";
    terminal.handleRunEvent({ type: "run-start", model: "vendor/main", maxSteps: 10, timestamp: Date.now() });
    terminal.setCancelHandler(() => {
      process.stdout.write("ORCODE_EVIDENCE:cancel-handler-fired\n");
    });
    terminal.setInterjectHandler((text) => {
      process.stdout.write(`ORCODE_EVIDENCE:interjection-received:${text}\n`);
    });
    process.stdout.write("ORCODE_EVIDENCE:run-armed\n");
    return;
  }
  if (signalStage === "run-armed") {
    signalStage = "reasoning-armed";
    terminal.setEndThinkingHandler(() => {
      process.stdout.write("ORCODE_EVIDENCE:end-thinking-fired\n");
    });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "vendor/main",
      step: 1,
      delta: "Weighing the two approaches before writing any code.",
      timestamp: Date.now(),
    });
    process.stdout.write("ORCODE_EVIDENCE:reasoning-armed\n");
    return;
  }
  if (signalStage === "reasoning-armed") {
    signalStage = "run-ended";
    // Formally end the scripted fake run and release every registered
    // handler, mirroring what the real dashboard loop does once a real
    // `OrcodeAgent.run()` promise settles (src/cli.ts, `setInterjectHandler()`
    // / `setEndThinkingHandler()` called with no argument "when the run
    // ends"). Without this, `#mode` would stay "busy" forever and a
    // subsequently typed `/ssh` command would be swallowed as an
    // interjection instead of executing.
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "complete",
      durationMs: 1000,
      toolCount: 0,
      timestamp: Date.now(),
    });
    terminal.setInterjectHandler();
    terminal.setCancelHandler();
    terminal.setEndThinkingHandler();
    // `finishAssistant()` (not a manual setStatus) is the exact call the
    // real dashboard loop makes once a real agent run promise settles
    // (src/cli.ts:8328/:8353, `ui.finishAssistant(result.text)`) — it nulls
    // the run snapshot (`finishRun()`) AND flips the mode back to "idle" in
    // one step. Without it `#run` stays non-null forever (stale "Run
    // complete" status panel) even after `setStatus(..., false)`.
    terminal.finishAssistant();
    process.stdout.write("ORCODE_EVIDENCE:run-ended\n");
    return;
  }
});

let exitCode;
try {
  exitCode = await cli.runCli(["--new"], {
    initializeStorage: async () => ({ appHome, configPath, migrationWarning: null, retentionWarnings: [], config: persisted, ruleStore: rules, session }),
    createProviderRuntime: async () => runtime,
    createAgent: async () => ({ run: async () => { return {}; } }),
    runPlain: cli.runPlainLoop,
    runDashboard: async (input) => {
      dashboardInput = input;
      // `/ssh` seams (tests/ssh-slash-command.test.ts pattern): a fake
      // always-reachable runner and a fake config file, so `/ssh vps` never
      // touches the real `~/.ssh/config` or spawns a real `ssh` binary.
      dashboardInput.sshConfigPath = sshConfigPath;
      dashboardInput.sshAppHome = sshAppHome;
      dashboardInput.sshRunner = async () => ({
        code: 0, stdout: "", stderr: "", truncated: false, timedOut: false, aborted: false,
      });
      await cli.runDashboard(input);
    },
    stdout: process.stdout,
    stderr: process.stderr,
    environment: { ...process.env },
  });
  process.stdout.write(
    `\nORCODE_PTY_RESULT:${JSON.stringify({ exitCode, providerCalls, crossPublishCalls })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = exitCode;
