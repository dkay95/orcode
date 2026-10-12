#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliModuleUrl = process.env.ORCODE_PTY_CLI_MODULE;
if (!cliModuleUrl) throw new Error("ORCODE_PTY_CLI_MODULE fehlt.");
const tuiModuleUrl = process.env.ORCODE_PTY_TUI_MODULE;
if (!tuiModuleUrl) throw new Error("ORCODE_PTY_TUI_MODULE fehlt.");

const cli = await import(cliModuleUrl);
const tui = await import(tuiModuleUrl);
const config = await import(new URL("./config.js", cliModuleUrl));
const { SessionStore } = await import(new URL("./session.js", cliModuleUrl));
const { RuleStore } = await import(new URL("./rules.js", cliModuleUrl));
const { OpenRouterService } = await import(new URL("./openrouter.js", cliModuleUrl));
const { handleSlashCommand } = await import(new URL("./commands.js", cliModuleUrl));

const root = await mkdtemp(join(tmpdir(), "orcode-pty-lifecycle-"));
const workspace = join(root, "workspace");
const appHome = join(root, "app");
const configPath = join(appHome, "config.json");
const fixturePath = join(workspace, "fixture.png");
const suspendTriggerPath = join(root, "suspend.trigger");
await mkdir(workspace, { recursive: true });
await mkdir(appHome, { recursive: true });
await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit" } }));
await writeFile(
  fixturePath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Jw5kAAAAASUVORK5CYII=", "base64"),
);
const persisted = structuredClone(config.DEFAULT_CONFIG);
persisted.mainModel = "vendor/main";
persisted.appearance = { ...persisted.appearance, glyphMode: "ascii" };
await config.saveConfig(persisted, configPath);
const session = SessionStore.create(workspace, appHome, "PTY lifecycle");
const route = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "synthetic-pty-account",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/main",
  canonicalModelId: "vendor/main",
  resolutionState: "resolved",
});
session.setPreferences("vendor/main", { mode: "auto" }, route);
await session.save();
const rules = await RuleStore.load(appHome);
let liveRoute = route;
let providerCalls = 0;
let agentCalls = 0;
const runtime = {
  openRouter: new OpenRouterService(undefined),
  credentials: {},
  providerCredentials: {},
  preparedRoles: null,
  async inspectStartup() {
    return { mode: "ready", generation: 1, defaultRoute: liveRoute, readyRoutes: [liveRoute], warnings: [], crossEnabled: false };
  },
  async resolveLegacyDefaultRoute() { return this.inspectStartup(); },
  async runSetup() { return { kind: "ready", route: liveRoute }; },
  ensureRunnableRoute() { return liveRoute; },
  currentSessionRoute() { return liveRoute; },
  modelRuntime() { return {}; },
  adoptSession() {},
  // Composition phase: the neutral start hub's "Recent" section (D8,
  // superseding the old single-slot "Continue" quick action) loads the
  // recent-chats list at every dashboard startup now (previously only on
  // an explicit chat switch), so this synthetic runtime needs the method too.
  migratedSessionConnection() { return undefined; },
  async selectSessionRoute(next) { liveRoute = next; return next; },
  async runWithReadyRoute(run) { return run(liveRoute); },
  activity() { return { runActive: false, activationHeld: false }; },
  async runSettingsConfigMutation(task) { return task(); },
  readCachedSettingsRoute() {
    return { backendId: "openrouter", providerLabel: "OpenRouter", requestedModelId: liveRoute.requestedModelId, canonicalModelId: liveRoute.canonicalModelId, modelLabel: "Synthetic main", billingRealm: "openrouter-payg" };
  },
  readCachedProviderStatus() {
    return [{ backendId: "openrouter", displayName: "OpenRouter", availability: "connectable", configuration: "enabled", maturity: "stable", billingRealm: "openrouter-payg", headline: "synthetic runtime", health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" }, isDefault: true, allowedActions: [] }];
  },
  readCachedSettingsModels() {
    return [{ id: "vendor/main", name: "Synthetic main", description: "local PTY model", contextLength: 128000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] }];
  },
  prepareSettingsModelPublication(next) { return { publish() { liveRoute = next; } }; },
  readModelPreferenceAuthority() { return { route: liveRoute, providerRevision: 1, connectionId: "synthetic-pty" }; },
  async transitionSessionModel() { throw new Error("PTY scenario must not mutate provider routes"); },
  async execute() { providerCalls += 1; throw new Error("PTY scenario must not call provider actions"); },
};

process.stdout.write(`ORCODE_PTY_READY:${JSON.stringify({ stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true, columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null })}\n`);
process.stdout.write(`ORCODE_PTY_FIXTURE:${fixturePath}\n`);
process.stdout.write(`ORCODE_PTY_SUSPEND_CONTROL:${suspendTriggerPath}\n`);
process.chdir(workspace);

let dashboardInput;
let settingsRequested = false;
let capturedUi;
const startTerminalUi = tui.TerminalUi.prototype.start;
tui.TerminalUi.prototype.start = function (...args) {
  capturedUi = this;
  return startTerminalUi.apply(this, args);
};
process.on("SIGUSR1", () => {
  if (!dashboardInput) return;
  if (settingsRequested) return;
  settingsRequested = true;
  void handleSlashCommand("/settings", dashboardInput).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
});

/**
 * Phase 3b, Part C end-to-end esc-split proof (scripts/check-pty-esc-split.mjs):
 * drives the REAL captured TerminalUi's REAL key routing with REAL raw ESC
 * bytes over the real PTY, deliberately WITHOUT going through a real
 * `OrcodeAgent.run()` call — `ensureRunnableModelConfiguration` sits between
 * a real prompt submission and the agent and would need real/fake network
 * model listing this harness does not set up. The agent-side mechanism
 * (abort + continuation + reasoning `none` + cost booking) has its own
 * fake-runtime coverage in tests/agent.test.ts; this stage exists to prove
 * the one thing only a real terminal can: that a genuine ESC byte, parsed by
 * the real key handler, reaches `setEndThinkingHandler` while reasoning is
 * live and `setCancelHandler` otherwise — exactly the state-dependent split
 * task-3b-brief.md Part C.2 requires, with zero timing heuristics.
 *
 * Fix round 1, Critical 2: stage 2 clears the live reasoning block via a
 * "model-start" event (not "model-end") — exactly what the end-thinking
 * continuation actually emits (announceModelStep at the top of every
 * executeModelPhase call in src/agent.ts) and exactly the event that used to
 * NOT clear it (view-model.ts's "model-start" case only set `#step` before
 * the fix). Using "model-end" here would validate a path the bug never
 * touched; "model-start" proves the real fix over the real PTY.
 */
let escSplitStage = "not-started";
process.on("SIGUSR2", () => {
  const terminal = capturedUi;
  if (!terminal) return;
  if (escSplitStage === "not-started") {
    escSplitStage = "reasoning-armed";
    terminal.setCancelHandler(() => {
      process.stdout.write("ORCODE_PTY_ESC_SPLIT:cancel-1\n");
    });
    terminal.setEndThinkingHandler(() => {
      process.stdout.write("ORCODE_PTY_ESC_SPLIT:end-thinking\n");
    });
    terminal.handleRunEvent({ type: "run-start", model: "vendor/main", maxSteps: 10, timestamp: Date.now() });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "vendor/main",
      step: 1,
      delta: "Analysiere den Auftrag im Detail.",
      timestamp: Date.now(),
    });
    process.stdout.write("ORCODE_PTY_ESC_SPLIT:armed-reasoning\n");
    return;
  }
  if (escSplitStage === "reasoning-armed") {
    escSplitStage = "otherwise-armed";
    // The continuation after esc ends thinking — a fresh model phase,
    // never a "model-end" for the aborted one (that request never
    // completed). This is the exact transition Critical 2 was about:
    // `reasoningLive` must flip false here, or a second esc would wrongly
    // re-arm end-thinking instead of routing to run-abort.
    terminal.handleRunEvent({ type: "model-start", model: "vendor/main", step: 2, timestamp: Date.now() });
    terminal.setEndThinkingHandler(() => {
      process.stdout.write("ORCODE_PTY_ESC_SPLIT:end-thinking-2\n");
    });
    terminal.setCancelHandler(() => {
      process.stdout.write("ORCODE_PTY_ESC_SPLIT:cancel-2\n");
    });
    process.stdout.write("ORCODE_PTY_ESC_SPLIT:armed-otherwise\n");
  }
});

const suspendPoll = setInterval(() => {
  const terminal = capturedUi;
  if (!terminal || !existsSync(suspendTriggerPath)) return;
  clearInterval(suspendPoll);
  void terminal.suspend(async () => {
    process.kill(process.pid, "SIGSTOP");
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}, 10);
suspendPoll.unref();

let exitCode;
try {
  exitCode = await cli.runCli(["--new"], {
    initializeStorage: async () => ({ appHome, configPath, migrationWarning: null, retentionWarnings: [], config: persisted, ruleStore: rules, session }),
    createProviderRuntime: async () => runtime,
    createAgent: async () => ({ run: async () => { agentCalls += 1; return {}; } }),
    runPlain: cli.runPlainLoop,
    runDashboard: async (input) => {
      dashboardInput = input;
      await cli.runDashboard(input);
    },
    stdout: process.stdout,
    stderr: process.stderr,
    environment: { ...process.env, ORCODE_ASCII: "1" },
  });
  const configRaw = await readFile(configPath, "utf8");
  const configMode = (await stat(configPath)).mode & 0o777;
  process.stdout.write(`\nORCODE_PTY_RESULT:${JSON.stringify({ agentCalls, sessionTurns: session.data.turns.length, configRaw, configMode, exitCode, providerCalls })}\n`);
} finally {
  clearInterval(suspendPoll);
  await rm(root, { recursive: true, force: true });
}
process.exitCode = exitCode;
