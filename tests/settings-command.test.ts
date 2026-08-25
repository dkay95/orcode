import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { ApprovalManager } from "../src/approval.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import {
  handleSlashCommand,
  type CommandContext,
  type SettingsCommandPort,
} from "../src/commands.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import {
  createSettingsCommandPort,
  createSettingsSession,
  runPlainLoop,
  runSettingsProviderAction,
  runSettingsVerifySuggestion,
  runSettingsTerminalOwner,
} from "../src/cli.js";
import * as cliModule from "../src/cli.js";
import { SessionProviderRuntimeGuard } from "../src/cli.js";
import { OpenRouterService } from "../src/openrouter.js";
import { RuleStore, shellApprovalSubject } from "../src/rules.js";
import { SessionStore } from "../src/session.js";
import type { ProviderExecutionMode } from "../src/setup.js";
import { describeOpenRouterFailure, formatFailure } from "../src/openrouter.js";
import { TerminalUi } from "../src/tui.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { errorMessage } from "../src/utils.js";

const SETTINGS_INTERACTIVE_REQUIRED_CODE = "settings-interactive-required";
const SETTINGS_INTERACTIVE_REQUIRED_MESSAGE =
  "settings-interactive-required · /settings ist nur im lokalen interaktiven Eigentümer-Terminal verfügbar.";

test("Settings command factory fails closed before creating a session outside an owner TTY", async () => {
  const modes: readonly ProviderExecutionMode[] = [
    "local-interactive-owner",
    "json",
    "piped",
    "scheduled",
    "batch",
    "relay",
    "collaborator",
    "shared-service",
    "multi-user",
    "unenrolled-device",
  ];
  for (const executionMode of modes) {
    for (const [stdinIsTty, stdoutIsTty] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      let created = 0;
      const port = createSettingsCommandPort({
        executionMode,
        stdinIsTty,
        stdoutIsTty,
        async createSession() {
          created += 1;
          return { async open() {} };
        },
      });
      const accepted = executionMode === "local-interactive-owner" && stdinIsTty && stdoutIsTty;
      assert.equal(port === undefined, !accepted, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
      assert.equal(created, 0, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
      if (port) await port.open();
      assert.equal(created, accepted ? 1 : 0, `${executionMode}/${stdinIsTty}/${stdoutIsTty}`);
    }
  }
});

test("cached runtime activity reflects a run without acquiring a lease", () => {
  const guard = new SessionProviderRuntimeGuard();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
  const release = guard.beginRun();
  assert.deepEqual(guard.activity(), { runActive: true, activationHeld: false });
  release();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
});

test("/settings opens the installed command port exactly once and stays in chat", async () => {
  const argumentCounts: number[] = [];
  const settings = {
    async open() {
      argumentCounts.push(arguments.length);
    },
  } satisfies SettingsCommandPort;
  const context = {
    settings,
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/settings", context), "continue");
  assert.deepEqual(argumentCounts, [0]);
});

test("Plain besitzt temporär Raw/Alternate, Dashboard nutzt den aktiven Owner und beide bewahren den Chat-Draft", async () => {
  const calls: string[] = [];
  let raw = false;
  let alternate = false;
  let draft = "unveränderter chat-draft";
  const surface = {
    start() {
      calls.push("start");
      raw = true;
      alternate = true;
    },
    stop() {
      calls.push("stop");
      raw = false;
      alternate = false;
    },
  };

  await assert.rejects(
    runSettingsTerminalOwner(surface, true, async () => {
      calls.push("plain-settings");
      assert.equal(raw, true);
      assert.equal(alternate, true);
      assert.equal(draft, "unveränderter chat-draft");
      throw new Error("scripted-escape");
    }),
    /scripted-escape/,
  );
  assert.equal(raw, false);
  assert.equal(alternate, false);
  assert.equal(draft, "unveränderter chat-draft");

  await runSettingsTerminalOwner(surface, false, async () => {
    calls.push("dashboard-settings");
    draft = `${draft}`;
  });
  assert.deepEqual(calls, ["start", "plain-settings", "stop", "dashboard-settings"]);
  assert.equal(draft, "unveränderter chat-draft");
});

class OwnerTtyInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  readonly rawTransitions: boolean[] = [];

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawTransitions.push(value);
    return this;
  }

  resume(): this { return this; }
  pause(): this { return this; }
}

class OwnerTtyOutput extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  output = "";

  write(value: string | Uint8Array): boolean {
    this.output += value.toString();
    return true;
  }
}

function pressOwnerKey(stdin: OwnerTtyInput, name: string, character = ""): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false, shift: false });
}

async function waitForOwnerState(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("scripted owner Settings state did not settle");
}

function ownerFrameText(terminal: TerminalUi): string {
  return terminal.frame().lines.map(plainText).join("\n");
}

function ownerFrameSelects(terminal: TerminalUi, value: string): boolean {
  return terminal.frame().lines.some((line) => line.spans.some((span) =>
    (span.role === "active" || span.role === "accent")
    && span.text.trim() === value));
}

test("Plain /settings dispatch drives the real TerminalUi and applies appearance before restoring the next prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-owner-lifecycle-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    const config = structuredClone(DEFAULT_CONFIG);
    config.appearance.showLargeLogo = true;
    await saveConfig(config, configPath);
    const route: RouteIdentityV1 = {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_settings_owner_lifecycle",
      billingRealm: "openrouter-payg",
      requestedModelId: config.mainModel,
      canonicalModelId: config.mainModel,
      resolutionState: "resolved",
    };
    const session = SessionStore.create(workspace, appHome, "Owner lifecycle");
    session.setPreferences(config.mainModel, { mode: "auto" }, route);
    await session.save();
    const sessionBefore = structuredClone(session.data);
    const rules = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { workspace, ruleStore: rules });
    const guard = new SessionProviderRuntimeGuard();
    const stdin = new OwnerTtyInput();
    const stdout = new OwnerTtyOutput();
    let terminal: TerminalUi | null = null;
    let script: Promise<void> | null = null;
    let promptReads = 0;
    const context = {
      executionMode: "local-interactive-owner",
      workspace,
      configPath,
      config,
      approvals,
      openRouter: new OpenRouterService(undefined),
      session,
      agent: null,
      localRuntime: {} as never,
      providerCredentials: {} as never,
      providerCommands: {} as never,
      providerRoutes: {} as never,
      providerRouteSurface: "plain",
      providerRuntime: {
        activity: () => guard.activity(),
        currentSessionRoute: () => structuredClone(route),
        readCachedSettingsRoute: () => ({
          backendId: "openrouter" as const,
          providerLabel: "OpenRouter",
          requestedModelId: route.requestedModelId,
          canonicalModelId: route.canonicalModelId!,
          modelLabel: route.requestedModelId,
          billingRealm: "openrouter-payg" as const,
        }),
        readCachedProviderStatus: () => [],
        readCachedModels: () => [],
        async runSettingsConfigMutation<T>(task: () => Promise<T>): Promise<T> {
          const lease = await guard.acquire(new AbortController().signal);
          try { return await task(); } finally { lease.release(); }
        },
      } as never,
      credentials: {} as never,
      out: { text() {}, error() {} },
      ruleStore: rules,
      sshSession: { active: null },
      async ensureAgentForPrompt() { throw new Error("agent must not be constructed"); },
      createTemporarySettingsUi() {
        terminal = new TerminalUi(
          () => ({
            workspace,
            projectStatus: "Settings lifecycle",
            model: config.mainModel,
            approval: approvals.mode,
            compressor: config.compressionMode,
            compressorModel: config.compressorModel,
            reasoning: "auto",
            balance: "cached",
            sessionCost: "$0.00",
            maxCost: "$1.00",
            maxSteps: config.maxSteps,
            keyStatus: "not-read",
          }),
          stdin as unknown as ReadStream,
          stdout as unknown as WriteStream,
          createTheme({ level: 0 }),
        );
        script = (async () => {
          await waitForOwnerState(() => ownerFrameText(terminal!).includes("Einstellungen"));
          assert.match(ownerFrameText(terminal!), /╭────────╮/u);
          pressOwnerKey(stdin, "6", "6");
          await waitForOwnerState(() => ownerFrameText(terminal!).includes("Einstellungen · Darstellung"));
          pressOwnerKey(stdin, "return");
          await waitForOwnerState(() => ownerFrameText(terminal!).includes("Großes Route-Core-Logo auswählen"));
          pressOwnerKey(stdin, "down");
          await waitForOwnerState(() => ownerFrameSelects(terminal!, "Aus"));
          pressOwnerKey(stdin, "return");
          await waitForOwnerState(() => config.appearance.showLargeLogo === false
            && ownerFrameText(terminal!).includes("Einstellungen · Darstellung"));
          assert.doesNotMatch(
            ownerFrameText(terminal!),
            /╭────────╮/u,
            "the live owner surface must adopt the durable appearance before Escape",
          );
          pressOwnerKey(stdin, "escape");
        })();
        return terminal;
      },
      async readPlainInput() {
        promptReads += 1;
        if (promptReads === 1) return "/settings";
        assert.equal(stdin.isRaw, false, "Plain must release raw mode before the next prompt");
        assert.match(stdout.output, /\u001b\[\?1049l/u, "Plain must leave alternate screen before the next prompt");
        return "/exit";
      },
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never;

    await runPlainLoop(context, { resume: false, noResume: true });
    await script;

    assert.deepEqual(stdin.rawTransitions, [true, false]);
    assert.equal(promptReads, 2);
    assert.deepEqual(session.data, sessionBefore);
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.equal(stored.appearance.showLargeLogo, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dashboard /settings dispatch keeps the active TerminalUi owner and restores its real pending draft", async () => {
  const createProductionSettingsSession = (cliModule as unknown as {
    createSettingsSession?: (
      context: unknown,
      surface: TerminalUi,
      ownsTerminal: boolean,
    ) => { open(): Promise<void> };
  }).createSettingsSession;
  assert.equal(
    typeof createProductionSettingsSession,
    "function",
    "the dashboard lifecycle proof must exercise the production Settings session adapter",
  );

  const root = await mkdtemp(join(tmpdir(), "orcode-settings-dashboard-lifecycle-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    const config = structuredClone(DEFAULT_CONFIG);
    await saveConfig(config, configPath);
    const route: RouteIdentityV1 = {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_settings_dashboard_owner",
      billingRealm: "openrouter-payg",
      requestedModelId: config.mainModel,
      canonicalModelId: config.mainModel,
      resolutionState: "resolved",
    };
    const session = SessionStore.create(workspace, appHome, "Dashboard lifecycle");
    session.setPreferences(config.mainModel, { mode: "auto" }, route);
    await session.save();
    const sessionBefore = structuredClone(session.data);
    const rules = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { workspace, ruleStore: rules });
    const guard = new SessionProviderRuntimeGuard();
    const stdin = new OwnerTtyInput();
    const stdout = new OwnerTtyOutput();
    const terminal = new TerminalUi(
      () => ({
        workspace,
        projectStatus: "Dashboard lifecycle",
        model: config.mainModel,
        approval: approvals.mode,
        compressor: config.compressionMode,
        compressorModel: config.compressorModel,
        reasoning: "auto",
        balance: "cached",
        sessionCost: "$0.00",
        maxCost: "$1.00",
        maxSteps: config.maxSteps,
        keyStatus: "not-read",
      }),
      stdin as unknown as ReadStream,
      stdout as unknown as WriteStream,
      createTheme({ level: 0 }),
    );
    const context = {
      executionMode: "local-interactive-owner",
      workspace,
      configPath,
      config,
      approvals,
      openRouter: new OpenRouterService(undefined),
      session,
      agent: null,
      localRuntime: {} as never,
      providerCredentials: {} as never,
      providerCommands: {} as never,
      providerRoutes: {} as never,
      providerRouteSurface: "fullscreen",
      providerRuntime: {
        activity: () => guard.activity(),
        currentSessionRoute: () => structuredClone(route),
        readCachedSettingsRoute: () => ({
          backendId: "openrouter" as const,
          providerLabel: "OpenRouter",
          requestedModelId: route.requestedModelId,
          canonicalModelId: route.canonicalModelId!,
          modelLabel: route.requestedModelId,
          billingRealm: "openrouter-payg" as const,
        }),
        readCachedProviderStatus: () => [],
        readCachedModels: () => [],
        async runSettingsConfigMutation<T>(task: () => Promise<T>): Promise<T> {
          const lease = await guard.acquire(new AbortController().signal);
          try { return await task(); } finally { lease.release(); }
        },
      } as never,
      credentials: {} as never,
      out: { text() {}, error() {} },
      ruleStore: rules,
      sshSession: { active: null },
      settings: undefined as SettingsCommandPort | undefined,
    };
    context.settings = createSettingsCommandPort({
      executionMode: "local-interactive-owner",
      stdinIsTty: true,
      stdoutIsTty: true,
      createSession: async () => createProductionSettingsSession!(context, terminal, false),
    });

    terminal.start();
    try {
      const pendingDraft = terminal.readInput();
      for (const character of "unveränderter dashboard-draft") {
        pressOwnerKey(stdin, character, character);
      }
      const dispatched = handleSlashCommand("/settings", context as unknown as CommandContext);
      await waitForOwnerState(() => ownerFrameText(terminal).includes("Einstellungen"));
      pressOwnerKey(stdin, "6", "6");
      await waitForOwnerState(() => ownerFrameText(terminal).includes("Einstellungen · Darstellung"));
      pressOwnerKey(stdin, "return");
      await waitForOwnerState(() => ownerFrameText(terminal).includes("Großes Route-Core-Logo auswählen"));
      pressOwnerKey(stdin, "down");
      await waitForOwnerState(() => ownerFrameSelects(terminal, "Aus"));
      pressOwnerKey(stdin, "return");
      await waitForOwnerState(() => config.appearance.showLargeLogo === false
        && ownerFrameText(terminal).includes("Einstellungen · Darstellung"));
      pressOwnerKey(stdin, "escape");
      assert.equal(await dispatched, "continue");
      assert.equal(stdin.isRaw, true, "Dashboard keeps ownership after Settings closes");
      assert.equal(stdout.output.includes("\u001b[?1049l"), false, "Dashboard must not leave alternate screen for Settings");
      pressOwnerKey(stdin, "return");
      assert.equal(await pendingDraft, "unveränderter dashboard-draft");
      assert.deepEqual(session.data, sessionBefore);
      assert.deepEqual(route, session.data.route);
    } finally {
      terminal.stop();
    }
    assert.equal(stdin.isRaw, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Settings session adapter dispatches every enabled external family through the controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-production-adapter-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: {
      check: "tsc --noEmit", test: "node --test", build: "tsc",
    } }), "utf8");
    const route: RouteIdentityV1 = {
      version: 1, backendId: "openrouter", accountFingerprint: "acct_production_adapter",
      billingRealm: "openrouter-payg", requestedModelId: "vendor/main",
      canonicalModelId: "vendor/main", resolutionState: "resolved",
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = route.requestedModelId;
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "production adapter");
    session.setPreferences(config.mainModel, { mode: "auto" }, route);
    await session.save();
    const rules = await RuleStore.load(appHome);
    const remembered = await Promise.all(["one", "two"].map((command) => rules.remember({
      workspace, tool: "shell", decision: "allow",
      subject: shellApprovalSubject({ platform: "darwin", executable: "/bin/echo", mode: [], cwd: ".", command }),
    })));
    const models = [
      { id: "vendor/main", name: "Main", description: "main", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools", "reasoning"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/compressor", name: "Compressor", description: "compress", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: [], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/panel", name: "Panel", description: "panel", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/audio", name: "Audio", description: "audio", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: [], inputModalities: ["text", "audio"], outputModalities: ["text"] },
    ];
    const providerIntents: string[] = [];
    let mainAuthorityCalls = 0;
    const intents: Array<{ kind: "select-item"; itemId: string } | { kind: "activate" } | { kind: "back" }> = [];
    const activate = (itemId: string) => intents.push({ kind: "select-item", itemId }, { kind: "activate" });
    activate("provider-action:openrouter:connect");
    activate("main-model"); // cancellation must preserve the real transaction boundary.
    activate("compressor-model");
    activate(`approval-forget:${remembered[0]!.id}`);
    activate("approval-forget-all");
    activate("verify-suggest");
    activate("panel-models");
    activate("transcription-model");
    intents.push({ kind: "back" });
    const livePublishes: string[] = [];
    const surface = {
      begin() {},
      async nextIntent() {
        const next = intents.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
      async edit(request: { itemId: string }) {
        if (request.itemId === "main-model") return { kind: "cancel" as const };
        if (request.itemId === "compressor-model") return { kind: "value" as const, value: "vendor/compressor" };
        if (request.itemId === "panel-models") return { kind: "value" as const, value: ["vendor/main", "vendor/panel"] };
        if (request.itemId === "transcription-model") return { kind: "value" as const, value: "vendor/audio" };
        return { kind: "value" as const, value: true };
      },
      end() {},
      applyAppearance() { livePublishes.push("live"); },
      async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const context = {
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute(intent: { kind: string }) {
        providerIntents.push(intent.kind);
        return { kind: "changed", operation: intent.kind, backendId: "openrouter" };
      } },
      providerRuntime: {
        activity: () => ({ runActive: false, activationHeld: false }), currentSessionRoute: () => structuredClone(route),
        readCachedSettingsRoute: () => ({ backendId: "openrouter" as const, providerLabel: "OpenRouter", requestedModelId: route.requestedModelId, canonicalModelId: route.canonicalModelId!, modelLabel: "Main", billingRealm: "openrouter-payg" as const }),
        readCachedProviderStatus: () => [{ backendId: "openrouter", displayName: "OpenRouter", availability: "connectable", configuration: "enabled", maturity: "stable", billingRealm: "openrouter-payg", headline: "synthetic ready", health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" }, isDefault: true, allowedActions: ["connect"], selectedModel: null }],
        readCachedSettingsModels: () => models,
        async runSettingsConfigMutation<T>(task: () => Promise<T>) { return task(); },
        prepareSettingsModelPublication() { mainAuthorityCalls += 1; return { publish() {} }; },
        readModelPreferenceAuthority() { mainAuthorityCalls += 1; return { route, providerRevision: 1, connectionId: "synthetic" }; },
        async transitionSessionModel() { mainAuthorityCalls += 1; return route; },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;

    await createSettingsSession(context, surface, false).open();

    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.deepEqual(providerIntents, ["connect"], "production provider adapter delegation");
    assert.equal(mainAuthorityCalls, 0, "cancelled main-model editor must not enter transaction authority");
    assert.equal(stored.compressorModel, "vendor/compressor", "compressor external action reaches durable config");
    assert.deepEqual(stored.panelModels, ["vendor/main", "vendor/panel"], "panel external action reaches durable config");
    assert.equal(stored.transcriptionModel, "vendor/audio", "transcription external action reaches durable config");
    assert.deepEqual(stored.verify.commands, ["npm run check", "npm run test", "npm run build"], "verify suggestion confirms then persists");
    assert.deepEqual(rules.list(workspace), [], "approval forget and forget-all reach the real rule store");
    assert.ok(livePublishes.length >= 3, "durable external model config changes publish to the live consumer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Settings session leaves Kimi-disabled compressor, panel, and audio rows before every authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-kimi-disabled-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const route: RouteIdentityV1 = {
      version: 1, backendId: "kimi-code", accountFingerprint: "acct_kimi_disabled",
      billingRealm: "kimi-code-membership-provider-managed-overage", requestedModelId: "k3",
      canonicalModelId: "k3", resolutionState: "resolved",
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = "k3";
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "kimi disabled");
    session.setPreferences("k3", { mode: "auto" }, route);
    await session.save();
    const rules = await RuleStore.load(appHome);
    const intents: Array<{ kind: "select-item"; itemId: string } | { kind: "activate" } | { kind: "back" }> = ["compressor-model", "panel-models", "transcription-model"]
      .flatMap((itemId) => [{ kind: "select-item" as const, itemId }, { kind: "activate" as const }]);
    intents.push({ kind: "back" as const });
    let editorCalls = 0;
    let externalAuthorityCalls = 0;
    const surface = {
      begin() {}, async nextIntent() { return intents.shift()!; },
      async edit() { editorCalls += 1; return { kind: "cancel" as const }; }, end() {},
      applyAppearance() {}, async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const context = {
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute() { externalAuthorityCalls += 1; return { kind: "changed", operation: "connect", backendId: "kimi-code" }; } },
      providerRuntime: {
        activity: () => ({ runActive: false, activationHeld: false }), currentSessionRoute: () => route,
        readCachedSettingsRoute: () => ({ backendId: "kimi-code" as const, providerLabel: "Kimi Code", requestedModelId: "k3", canonicalModelId: "k3", modelLabel: "K3", billingRealm: "kimi-code-membership-provider-managed-overage" as const }),
        readCachedProviderStatus: () => [], readCachedSettingsModels: () => [{ id: "k3", name: "K3", description: "Kimi", contextLength: 1, promptPrice: 0, completionPrice: 0, supportedParameters: [], inputModalities: ["text"], outputModalities: ["text"] }],
        async runSettingsConfigMutation<T>(task: () => Promise<T>) { externalAuthorityCalls += 1; return task(); },
      }, localRuntime: { guard: { async resolvePath() { return join(workspace, "package.json"); } } },
    } as never;
    await createSettingsSession(context, surface, false).open();
    assert.equal(editorCalls, 0, "enabling a disabled Kimi external row would open an editor");
    assert.equal(externalAuthorityCalls, 0, "enabling a disabled Kimi external row would call an authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Verify-Suggest übernimmt echte Skripte typisiert und lässt bestehende Kommandos bei Cancel/Fehler unverändert", async () => {
  let commands = ["npm run existing"];
  let persists = 0;
  await assert.rejects(runSettingsVerifySuggestion({
    packageJson: { scripts: { check: "tsc", test: "node --test" } },
    confirm: async () => false,
    persist: async (next) => {
      persists += 1;
      commands = [...next];
    },
  }), (error: unknown) => error instanceof Error && error.name === "SettingsExternalActionCancelledError");
  assert.deepEqual(commands, ["npm run existing"]);
  assert.equal(persists, 0);

  await assert.rejects(runSettingsVerifySuggestion({
    packageJson: { scripts: { check: "tsc" } },
    confirm: async () => true,
    persist: async () => {
      persists += 1;
      throw new Error("durable-config-failure");
    },
  }), /durable-config-failure/);
  assert.deepEqual(commands, ["npm run existing"]);

  await runSettingsVerifySuggestion({
    packageJson: { scripts: { build: "vite build", test: "node --test", check: "tsc" } },
    confirm: async (next) => {
      assert.deepEqual(next, ["npm run check", "npm run test", "npm run build"]);
      return true;
    },
    persist: async (next) => {
      persists += 1;
      commands = [...next];
    },
  });
  assert.deepEqual(commands, ["npm run check", "npm run test", "npm run build"]);
  assert.equal(persists, 2);
});

test("Settings-Providerbestätigung bindet den echten Token an exakte Aktion und Backend", async () => {
  const seen: unknown[] = [];
  const surface = {} as never;
  await runSettingsProviderAction({
    intent: { kind: "logout", backendId: "kimi-code" },
    surface,
    execute: async (intent) => {
      seen.push(intent);
      if (!("confirmationToken" in intent)) {
        return {
          kind: "confirmation-required",
          operation: "logout",
          backendId: "kimi-code",
          message: "Kimi wirklich abmelden?",
          confirmationToken: "real-authority-token",
        };
      }
      return {
        kind: "changed",
        operation: "logout",
        backendId: "kimi-code",
        setupRequired: true,
        defaultCleared: true,
      };
    },
    confirm: async (message) => message === "Kimi wirklich abmelden?",
  });
  assert.deepEqual(seen, [
    { kind: "logout", backendId: "kimi-code" },
    { kind: "logout", backendId: "kimi-code", confirmationToken: "real-authority-token" },
  ]);

  let cancelledCalls = 0;
  await assert.rejects(runSettingsProviderAction({
    intent: { kind: "disable", backendId: "openrouter" },
    surface,
    execute: async () => {
      cancelledCalls += 1;
      return {
        kind: "confirmation-required",
        operation: "disable",
        backendId: "openrouter",
        message: "Deaktivieren?",
        confirmationToken: "must-not-be-used",
      };
    },
    confirm: async () => false,
  }), (error: unknown) => error instanceof Error && error.name === "SettingsExternalActionCancelledError");
  assert.equal(cancelledCalls, 1);
});

test("a missing /settings port rejects before config, credentials, providers, routes, sessions, or network", async () => {
  const forbiddenReads: PropertyKey[] = [];
  const context = new Proxy(
    Object.create(null) as Record<PropertyKey, unknown>,
    {
      get(_target, property) {
        if (property === "settings") return undefined;
        forbiddenReads.push(property);
        throw new Error(`forbidden pre-gate read: ${String(property)}`);
      },
    },
  ) as unknown as CommandContext;

  let caught: unknown;
  try {
    await handleSlashCommand("/settings", context);
  } catch (error) {
    caught = error;
  }

  const commands = await import("../src/commands.js") as unknown as Record<string, unknown>;
  const ErrorType = commands.SettingsInteractiveRequiredError as
    | (new () => Error & { readonly code: string })
    | undefined;
  assert.equal(typeof ErrorType, "function");
  assert.ok(caught instanceof ErrorType!);
  assert.equal(caught.name, "SettingsInteractiveRequiredError");
  assert.equal(caught.code, SETTINGS_INTERACTIVE_REQUIRED_CODE);
  assert.equal(caught.message, SETTINGS_INTERACTIVE_REQUIRED_MESSAGE);
  assert.equal(errorMessage(caught), SETTINGS_INTERACTIVE_REQUIRED_MESSAGE);
  assert.equal(
    formatFailure(describeOpenRouterFailure(caught)),
    SETTINGS_INTERACTIVE_REQUIRED_MESSAGE,
  );
  assert.deepEqual(forbiddenReads, []);

  const rendered = JSON.stringify({
    code: caught.code,
    message: errorMessage(caught),
  });
  assert.deepEqual(JSON.parse(rendered), {
    code: SETTINGS_INTERACTIVE_REQUIRED_CODE,
    message: SETTINGS_INTERACTIVE_REQUIRED_MESSAGE,
  });
  assert.doesNotMatch(
    rendered,
    /api[-_]?key|secret|credential|account(?:Fingerprint|Id)|requestId|cookie|authorization|\/Users\//i,
  );
});
