#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliModuleUrl = process.env.ORCODE_PTY_CLI_MODULE;
if (!cliModuleUrl) throw new Error("ORCODE_PTY_CLI_MODULE fehlt.");

const cli = await import(cliModuleUrl);
const config = await import(new URL("./config.js", cliModuleUrl));
const { SessionStore } = await import(new URL("./session.js", cliModuleUrl));
const { RuleStore } = await import(new URL("./rules.js", cliModuleUrl));
const { OpenRouterService } = await import(new URL("./openrouter.js", cliModuleUrl));

const root = await mkdtemp(join(tmpdir(), "orcode-pty-lifecycle-"));
const workspace = join(root, "workspace");
const appHome = join(root, "app");
const configPath = join(appHome, "config.json");
const fixturePath = join(workspace, "fixture.png");
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
process.chdir(workspace);

const exitCode = await cli.runCli(["--new"], {
  initializeStorage: async () => ({ appHome, configPath, migrationWarning: null, retentionWarnings: [], config: persisted, ruleStore: rules, session }),
  createProviderRuntime: async () => runtime,
  createAgent: async () => ({}),
  runPlain: cli.runPlainLoop,
  runDashboard: cli.runDashboard,
  stdout: process.stdout,
  stderr: process.stderr,
  environment: { ...process.env, ORCODE_ASCII: "1" },
});

const configRaw = await readFile(configPath, "utf8");
const configMode = (await stat(configPath)).mode & 0o777;
process.stdout.write(`\nORCODE_PTY_RESULT:${JSON.stringify({ value: "Erste Zeile\nZweite Zeile", configRaw, configMode, exitCode, providerCalls })}\n`);
process.exitCode = exitCode;
