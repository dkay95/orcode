#!/usr/bin/env node

/**
 * Task J1 (owner-journey end-to-end checks). Companion to
 * `tests/fixtures/pty-harness.mjs` (component-level suspend/resume/settings
 * PTY smoke) — this harness instead drives whole OWNER JOURNEYS through the
 * REAL built `dist/cli.js`/`dist/tui.js` over a real POSIX PTY: the exact
 * gap the owner named ("why was it never fully implemented although we
 * talked about it?") was that every task verified its own component but
 * nobody drove the actual binary through a full start-to-finish journey the
 * way the owner does. This file is the child process one PTY session runs;
 * `scripts/check-journeys.mjs` is the driver + Python PTY controller (same
 * split as `pty-harness.mjs`/`scripts/check-pty.mjs`).
 *
 * Same synthetic-runtime technique as `pty-harness.mjs`: a real workspace
 * and app-home on disk, a real `SessionStore`/`RuleStore`/`OpenRouterService`,
 * but a stubbed `ProviderRuntime` so no network call is ever made and no
 * route/model is ever mutated by a journey that isn't supposed to touch one.
 * `openRouter.listModels` is overridden on the real `OpenRouterService`
 * instance (not replaced by a fake object) so `resolveMainModelCandidate`'s
 * real capability checks (`isMainModelCandidate`) still run — the synthetic
 * model is deliberately priced (non-zero prompt/completion price) so J-E can
 * prove the real per-prompt cost forecast segment (`cost-forecast.ts`)
 * actually appears once the catalog has real pricing, instead of only ever
 * exercising its "no price known" honest-silence branch.
 *
 * `process.argv[2]` selects the scenario (one of the J-A..J-E ids below);
 * each one drives the exact same bootstrap (a workspace whose app-home
 * already has ONE populated prior chat — "the owner's screenshots kept
 * being the first end-to-end test" starts from a folder that already has
 * history, not an empty one) and only the PTY key sequence
 * (`scripts/check-journeys.mjs`) and the assertions made on the captured
 * output differ per scenario.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliModuleUrl = process.env.ORCODE_JOURNEY_CLI_MODULE;
if (!cliModuleUrl) throw new Error("ORCODE_JOURNEY_CLI_MODULE is missing.");
const tuiModuleUrl = process.env.ORCODE_JOURNEY_TUI_MODULE;
if (!tuiModuleUrl) throw new Error("ORCODE_JOURNEY_TUI_MODULE is missing.");
const scenario = process.argv[2];
if (!scenario) throw new Error("A journey scenario id is required as argv[2].");

const cli = await import(cliModuleUrl);
// Imported for its TUI module registration side effects only (mirrors
// `pty-harness.mjs`) — `tui.js` must be loaded before `cli.runDashboard`
// constructs a `TerminalUi` against the real PTY.
await import(tuiModuleUrl);
const config = await import(new URL("./config.js", cliModuleUrl));
const { SessionStore } = await import(new URL("./session.js", cliModuleUrl));
const { RuleStore } = await import(new URL("./rules.js", cliModuleUrl));
const { OpenRouterService } = await import(new URL("./openrouter.js", cliModuleUrl));
const { CHAT_ARTIFACT_REGISTRY } = await import(new URL("./storage.js", cliModuleUrl));

const root = await mkdtemp(join(tmpdir(), "orcode-journey-"));
const workspace = join(root, "workspace");
const appHome = join(root, "app");
const configPath = join(appHome, "config.json");
await mkdir(workspace, { recursive: true });
await mkdir(appHome, { recursive: true });
await writeFile(
  join(workspace, "package.json"),
  JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
);

const MODEL_ID = "vendor/journey-main";
const persisted = structuredClone(config.DEFAULT_CONFIG);
persisted.mainModel = MODEL_ID;
persisted.appearance = {
  ...persisted.appearance,
  // Task J1 scope guard: tests only. Disabling the large ASCII logo keeps
  // the hub's welcome box the FIRST expansion alternative at the harness's
  // fixed 100x30 PTY size (the richest alternative that still fits) without
  // touching any production default — a real owner can still see the large
  // logo; only this harness's own seeded config opts out of it, same as the
  // suspend/resume PTY harness's own Appearance save already does.
  showLargeLogo: false,
  showHeaderMark: true,
  glyphMode: "ascii",
};
await config.saveConfig(persisted, configPath);

// The owner's real shape, for the two journeys that actually open Settings:
// the file says one main model, the OPEN CHAT runs on another, because a
// resumed chat's model preference is restored into the runtime config in
// memory and deliberately never written back to disk (`#adoptExactSessionRoute`,
// cli.ts). Settings compared the file against that runtime copy and read the
// process's own override as a foreign write, so it opened locked — on every
// real install whose chat differs from the stored `mainModel`. J-F/J-G walk
// into a Settings EDITOR, which a locked surface can never open, so the
// journeys prove on the shipped binary that it does not.
const SESSION_MODEL_ID = "vendor/journey-session";
if (scenario === "zones-on-screen" || scenario === "zones-on-screen-no-color") {
  persisted.mainModel = SESSION_MODEL_ID;
}

const route = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "journey-pty-account",
  billingRealm: "openrouter-payg",
  requestedModelId: MODEL_ID,
  canonicalModelId: MODEL_ID,
  resolutionState: "resolved",
});

// J-A/J-C/J-D's shared precondition: "a folder whose workspace already has a
// populated chat" — created and saved BEFORE the harness ever calls
// `cli.runCli`, exactly like a real prior orcode session would have left it.
const PRIOR_CHAT_TITLE = "River Facts";
const PRIOR_USER_TURN = "What is the longest river in Europe?";
const PRIOR_ASSISTANT_TURN =
  "The Volga is the longest river in Europe, flowing about 3,530 km before reaching the Caspian Sea.";
const priorChat = SessionStore.create(workspace, appHome, PRIOR_CHAT_TITLE);
priorChat.addTurn("user", PRIOR_USER_TURN);
priorChat.addTurn("assistant", PRIOR_ASSISTANT_TURN);
priorChat.setPreferences(MODEL_ID, { mode: "auto" }, route);
await priorChat.save();
const existingChatId = priorChat.data.id;

// The fresh, in-memory-only chat a bare interactive launch opens by default
// (controller ruling D8c) — `SessionStore.create` never writes on its own;
// see `session.ts`'s `isUntouched` doc comment for why that laziness matters
// (J-D's ghost check exercises exactly this).
const freshSession = SessionStore.create(workspace, appHome);
const rules = await RuleStore.load(appHome);

let liveRoute = route;
let providerCalls = 0;
let agentCalls = 0;

const openRouter = new OpenRouterService(undefined);
const journeyModel = Object.freeze({
  id: MODEL_ID,
  name: "Journey Main",
  description: "Synthetic priced model for the owner-journey PTY harness.",
  contextLength: 128_000,
  // Non-zero on purpose (J-E): a real catalog price is what makes
  // `classifyCostForecastPrice` return `"priced"` instead of `"unpriced"` —
  // `pty-harness.mjs`'s own fixture model uses 0/0, which is technically
  // "priced" too (a real, if degenerate, catalog entry) but reads
  // indistinguishably from "no price known" in a quick visual scan. Real
  // OpenRouter-scale per-token pricing here makes the forecast segment's
  // presence an unambiguous, non-degenerate proof.
  promptPrice: 0.000003,
  completionPrice: 0.000015,
  supportedParameters: ["tools"],
  inputModalities: ["text"],
  outputModalities: ["text"],
});
// Duck-typed override on the REAL `OpenRouterService` instance (same
// monkey-patch technique `pty-harness.mjs` uses on `TerminalUi.prototype`) —
// keeps every other real method (`checkBalance`, `safeMessage`, `hasKey`,
// …) intact while removing the only network call `loadProviderModelSnapshot`
// would otherwise make. Emits a marker on first resolution so the PTY
// controller can deterministically wait for the async
// `loadProviderModelSnapshot(...).then(...)` assignment inside
// `runDashboard` to have landed before J-E types its draft — the actual
// pass/fail assertion is still made on the rendered cost-forecast text, this
// is only a synchronization aid (same role `pty-harness.mjs`'s own
// `ORCODE_PTY_FIXTURE`/`ORCODE_PTY_SUSPEND_CONTROL` markers play).
let modelResolvedAnnounced = false;
openRouter.listModels = async () => {
  if (!modelResolvedAnnounced) {
    modelResolvedAnnounced = true;
    process.stdout.write(`ORCODE_JOURNEY_MODEL_RESOLVED:${JSON.stringify({ id: journeyModel.id })}\n`);
  }
  return [journeyModel];
};

const runtime = {
  openRouter,
  credentials: {},
  providerCredentials: {},
  preparedRoles: null,
  async inspectStartup() {
    return {
      mode: "ready",
      generation: 1,
      defaultRoute: liveRoute,
      readyRoutes: [liveRoute],
      warnings: [],
      crossEnabled: false,
    };
  },
  async resolveLegacyDefaultRoute() {
    return this.inspectStartup();
  },
  async runSetup() {
    return { kind: "ready", route: liveRoute };
  },
  ensureRunnableRoute() {
    return liveRoute;
  },
  currentSessionRoute() {
    return liveRoute;
  },
  modelRuntime() {
    return {};
  },
  adoptSession() {},
  migratedSessionConnection() {
    return undefined;
  },
  async selectSessionRoute(next) {
    liveRoute = next;
    return next;
  },
  async runWithReadyRoute(run) {
    return run(liveRoute);
  },
  activity() {
    return { runActive: false, activationHeld: false };
  },
  async runSettingsConfigMutation(task) {
    return task();
  },
  readCachedSettingsRoute() {
    return {
      backendId: "openrouter",
      providerLabel: "OpenRouter",
      requestedModelId: liveRoute.requestedModelId,
      canonicalModelId: liveRoute.canonicalModelId,
      modelLabel: "Journey Main",
      billingRealm: "openrouter-payg",
    };
  },
  readCachedProviderStatus() {
    return [{
      backendId: "openrouter",
      displayName: "OpenRouter",
      availability: "connectable",
      configuration: "enabled",
      maturity: "stable",
      billingRealm: "openrouter-payg",
      headline: "synthetic runtime",
      health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" },
      isDefault: true,
      allowedActions: [],
    }];
  },
  readCachedSettingsModels() {
    return [journeyModel];
  },
  prepareSettingsModelPublication(next) {
    return {
      publish() {
        liveRoute = next;
      },
    };
  },
  readModelPreferenceAuthority() {
    return { route: liveRoute, providerRevision: 1, connectionId: "journey-pty" };
  },
  async transitionSessionModel() {
    throw new Error("Journey PTY scenario must not mutate provider routes");
  },
  async execute() {
    providerCalls += 1;
    throw new Error("Journey PTY scenario must not call provider actions");
  },
};

process.stdout.write(`ORCODE_JOURNEY_READY:${JSON.stringify({
  stdinTTY: process.stdin.isTTY === true,
  stdoutTTY: process.stdout.isTTY === true,
  columns: process.stdout.columns ?? null,
  rows: process.stdout.rows ?? null,
  scenario,
  existingChatId,
  freshSessionId: freshSession.data.id,
})}\n`);
process.chdir(workspace);

let exitCode;
try {
  // Deliberately bare argv (no `--new`, no `--chat`): the exact launch shape
  // the owner actually uses, and the one D8c changed the meaning of — this
  // is the scenario the owner's own complaint was about, not a flag-assisted
  // shortcut around it.
  exitCode = await cli.runCli([], {
    initializeStorage: async () => ({
      appHome,
      configPath,
      migrationWarning: null,
      retentionWarnings: [],
      config: persisted,
      ruleStore: rules,
      session: freshSession,
    }),
    createProviderRuntime: async () => runtime,
    createAgent: async () => ({
      run: async () => {
        agentCalls += 1;
        return {};
      },
    }),
    runPlain: cli.runPlainLoop,
    runDashboard: async (input) => {
      await cli.runDashboard(input);
    },
    stdout: process.stdout,
    stderr: process.stderr,
    environment: { ...process.env, ORCODE_ASCII: "1" },
  });
} finally {
  // Self-reported, real `fs` reads against the real files this same process
  // just created (same trust basis `pty-harness.mjs`'s own
  // `ORCODE_PTY_RESULT` marker uses for `configRaw`/`configMode`) — the
  // ghost-file check (J-D) and the "did a chat switch write a stray file"
  // cross-check (J-B/J-C) both read off this list, not off internal state.
  const chatArtifacts = await CHAT_ARTIFACT_REGISTRY.all("chat", appHome);
  process.stdout.write(`\nORCODE_JOURNEY_RESULT:${JSON.stringify({
    scenario,
    exitCode: exitCode ?? null,
    agentCalls,
    providerCalls,
    existingChatId,
    freshSessionId: freshSession.data.id,
    chatFileIds: chatArtifacts.map((artifact) => artifact.chatId).sort(),
  })}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exitCode = exitCode;
