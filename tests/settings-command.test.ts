import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { ApprovalManager } from "../src/approval.js";
import { BackendRegistry, type RouteIdentityV1 } from "../src/backends.js";
import {
  handleSlashCommand,
  type CommandContext,
  type SettingsCommandPort,
} from "../src/commands.js";
import {
  DEFAULT_CONFIG,
  readConfigEditSnapshot,
  saveConfig,
  saveConfigEdit,
} from "../src/config.js";
import {
  SETTINGS_READ_ONLY_REASONS,
  type SettingsViewModel,
} from "../src/settings-controller.js";
import {
  createSettingsCommandPort,
  createSettingsSession,
  createCrossRuntimeForContext,
  DefaultProviderRuntime,
  persistProviderSetupState,
  runPlainLoop,
  runSettingsProviderAction,
  runSettingsVerifySuggestion,
  runSettingsTerminalOwner,
} from "../src/cli.js";
import * as cliModule from "../src/cli.js";
import { SessionProviderRuntimeGuard } from "../src/cli.js";
import { OpenRouterService } from "../src/openrouter.js";
import { KIMI_CODE_DESCRIPTOR } from "../src/kimi-code-backend.js";
import { KIMI_CODE_MODELS } from "../src/kimi-code.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { ProviderCredentialAuthority } from "../src/provider-authority.js";
import { ProviderStateStore, type ProviderSetupStateV3 } from "../src/provider-state.js";
import type { CrossPreferencesV1 } from "../src/collaboration.js";
import { PrivateStore } from "../src/private-store.js";
import { RuleStore, shellApprovalSubject } from "../src/rules.js";
import { readSessionEditSnapshot, SessionStore } from "../src/session.js";
import { SetupOrchestrator, type ProviderExecutionMode } from "../src/setup.js";
import { describeOpenRouterFailure, formatFailure } from "../src/openrouter.js";
import { TerminalUi } from "../src/tui.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { errorMessage } from "../src/utils.js";
import { createRoutePickerAuthority } from "../src/route-picker.js";

const SETTINGS_INTERACTIVE_REQUIRED_CODE = "settings-interactive-required";
const SETTINGS_INTERACTIVE_REQUIRED_MESSAGE =
  "settings-interactive-required · /settings is only available in a local interactive owner terminal.";

test("high-level Cross partial public wiring rejects lazily and restores the exact draft before all effects", async () => {
  for (const half of ["picker", "authority"] as const) {
    let preferenceReads = 0;
    let ownerReads = 0;
    let gateReads = 0;
    let publishes = 0;
    let starts = 0;
    let legacyPicks = 0;
    let arms = 0;
    let pendingArms = 0;
    const restores: string[] = [];
    const authority = { view() { throw new Error("unused"); }, resolve() { throw new Error("unused"); } };
    const runtime = createCrossRuntimeForContext({
      workspace: "/synthetic/workspace",
      session: { appHome: "/synthetic/home", armCrossMode(pair: { oneShot?: boolean }) {
        if (pair.oneShot) pendingArms += 1; else arms += 1;
      }, async save() {} },
      config: { ...structuredClone(DEFAULT_CONFIG), verify: { commands: [] } },
      approvals: {}, openRouter: { safeMessage: errorMessage }, localRuntime: { guard: {} },
      providerRuntime: {
        readCrossPreferences() { preferenceReads += 1; return { lead: null, challenger: null }; },
        terminalOwnerRoutePickerAuthority() { ownerReads += 1; return authority; },
        currentSessionRoute() { throw new Error("must reject before availability"); },
        publishCrossPreferences() { publishes += 1; throw new Error("must not publish"); },
      },
    } as never,
    { async pickModelRoute() { legacyPicks += 1; throw new Error("legacy picker must not run"); } },
    { restoreDraft(draft: string) { restores.push(draft); }, discardDraft() {}, async publishResult() {}, beginRun() { starts += 1; } },
    { async chooseGate() { gateReads += 1; return "start" as const; } },
    half === "picker" ? { async pickModelRoute() { return null; } } : undefined,
    half === "authority" ? authority as never : null);

    await assert.rejects(runtime.openGate(`draft-${half}`), /route picker is unavailable/i);
    assert.deepEqual(restores, [`draft-${half}`]);
    assert.equal(preferenceReads, 0);
    assert.equal(ownerReads, 0);
    assert.equal(gateReads, 0);
    assert.equal(publishes, 0);
    assert.equal(starts, 0);
    assert.equal(legacyPicks, 0);
    assert.equal(arms, 0);
    assert.equal(pendingArms, 0);
  }
});

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

// FIX-15 moved this pin DELIBERATELY. It was written to prove `/settings`
// opens the port ONCE and hands it nothing that could turn into a second
// navigation step — that is still exactly what it proves. What changed is
// that the port now takes one optional argument: the category `/settings
// <category>` (and its `/appearance` / `/theme` aliases) deep-links to,
// which is the controller's own `initialCategory` plumbed through. Bare
// `/settings` still passes `undefined`, so the controller keeps its default.
test("/settings opens the installed command port exactly once, with the category it was asked for", async () => {
  const opens: Array<string | undefined> = [];
  const settings = {
    async open(category?: string) {
      opens.push(category);
    },
  } as unknown as SettingsCommandPort;
  const context = {
    settings,
    out: { text() {}, error() {} },
  } as unknown as CommandContext;

  assert.equal(await handleSlashCommand("/settings", context), "continue");
  assert.deepEqual(opens, [undefined]);

  for (const [input, expected] of [
    ["/settings appearance", "appearance"],
    ["/settings theme", "appearance"],
    ["/theme", "appearance"],
    ["/appearance", "appearance"],
    ["/settings approvals", "approvals-costs"],
    ["/settings approvals-costs", "approvals-costs"],
    ["/settings models", "models"],
    ["/settings accounts", "accounts"],
    ["/settings tools", "tools"],
  ] as const) {
    opens.length = 0;
    assert.equal(await handleSlashCommand(input, context), "continue");
    assert.deepEqual(opens, [expected], input);
  }

  // A token that names no category is refused with the catalog's own usage —
  // never silently opened at the default page. Fix round 1 (F5): the
  // prototype keys are in this list because they used to slip through the
  // alias table and open Settings with `Object` as its category — neither
  // refused nor a real page.
  opens.length = 0;
  for (const input of [
    "/settings nonsense",
    "/settings appearance extra",
    "/theme nonsense",
    "/settings constructor",
    "/settings __proto__",
    "/settings toString",
  ]) {
    await assert.rejects(handleSlashCommand(input, context), (error: unknown) =>
      error instanceof Error
      && error.message === "Usage: /settings [models|accounts|approvals|tools|appearance]", input);
  }
  assert.deepEqual(opens, [], "a refused deep link must never open Settings at all");
});

test("Plain besitzt temporär Raw/Alternate, Dashboard nutzt den aktiven Owner und beide bewahren den Chat-Draft", async () => {
  const calls: string[] = [];
  let raw = false;
  let alternate = false;
  let draft = "unchanged chat-draft";
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
      assert.equal(draft, "unchanged chat-draft");
      throw new Error("scripted-escape");
    }),
    /scripted-escape/,
  );
  assert.equal(raw, false);
  assert.equal(alternate, false);
  assert.equal(draft, "unchanged chat-draft");

  await runSettingsTerminalOwner(surface, false, async () => {
    calls.push("dashboard-settings");
    draft = `${draft}`;
  });
  assert.deepEqual(calls, ["start", "plain-settings", "stop", "dashboard-settings"]);
  assert.equal(draft, "unchanged chat-draft");
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
    // D1 ruling 1 (menu clarity): a `choice-picker` value editor (e.g. the
    // appearance boolean toggle this helper drives below) now renders its
    // selected row as one uniform `inverse` bar instead of an `accent`/
    // `active` name span — `list-core.ts`'s shared `buildListLines`. The
    // settings category/item list (`settings-frame.ts`) is a separate,
    // bespoke renderer untouched by that change and still marks its own
    // selection with `active` directly, so both roles stay checked here.
    (span.role === "active" || span.role === "accent" || span.role === "inverse")
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
            reasoning: "auto",
            balance: "cached",
            maxCost: "$1.00",
            maxSteps: config.maxSteps,
          }),
          stdin as unknown as ReadStream,
          stdout as unknown as WriteStream,
          createTheme({ level: 0 }),
        );
        script = (async () => {
          // D8: the neutral start hub's own "Settings" quick-action label
          // (`tui.ts`'s `WORKBENCH_QUICK_ACTIONS`) would otherwise satisfy a
          // bare `.includes("Settings")` on the very first hub frame, before
          // the settings surface has even opened — wait for the surface's
          // own heading instead, the same string asserted right below.
          await waitForOwnerState(() => ownerFrameText(terminal!).includes("Settings › Models"));
          assert.doesNotMatch(ownerFrameText(terminal!), /─────────●/u);
          // V4-B: the surface names itself with its title-bar crumb.
          assert.match(ownerFrameText(terminal!), /Settings › Models/u);
          pressOwnerKey(stdin, "5", "5");
          await waitForOwnerState(() => ownerFrameText(terminal!).includes("Settings › Appearance"));
          pressOwnerKey(stdin, "return");
          // V4-B (V4-A concern 5): entering an editor GROWS the crumb, so the
          // picker says where in Settings it came from instead of the old
          // `Choose <label>`, which named the row but not its home.
          await waitForOwnerState(() =>
            ownerFrameText(terminal!).includes("Settings › Appearance › Large ORCODE logo"));
          pressOwnerKey(stdin, "down");
          await waitForOwnerState(() => ownerFrameSelects(terminal!, "Off"));
          pressOwnerKey(stdin, "return");
          await waitForOwnerState(() => config.appearance.showLargeLogo === false
            && ownerFrameText(terminal!).includes("Settings › Appearance"));
          assert.doesNotMatch(
            ownerFrameText(terminal!),
            /─────────●/u,
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

    await runPlainLoop(context, { recover: false, noRecover: true });
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
        reasoning: "auto",
        balance: "cached",
        maxCost: "$1.00",
        maxSteps: config.maxSteps,
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
      for (const character of "unchanged dashboard-draft") {
        pressOwnerKey(stdin, character, character);
      }
      const dispatched = handleSlashCommand("/settings", context as unknown as CommandContext);
      // D8: same collision as the plain-mode test above — the hub's own
      // "Settings" quick-action label satisfies a bare `.includes("Settings")`
      // on the very first (pre-dispatch) frame, before the settings surface
      // has actually opened.
      await waitForOwnerState(() => ownerFrameText(terminal).includes("Settings › Models"));
      pressOwnerKey(stdin, "5", "5");
      await waitForOwnerState(() => ownerFrameText(terminal).includes("Settings › Appearance"));
      pressOwnerKey(stdin, "return");
      await waitForOwnerState(() =>
        ownerFrameText(terminal).includes("Settings › Appearance › Large ORCODE logo"));
      pressOwnerKey(stdin, "down");
      await waitForOwnerState(() => ownerFrameSelects(terminal, "Off"));
      pressOwnerKey(stdin, "return");
      await waitForOwnerState(() => config.appearance.showLargeLogo === false
        && ownerFrameText(terminal).includes("Settings › Appearance"));
      pressOwnerKey(stdin, "escape");
      assert.equal(await dispatched, "continue");
      assert.equal(stdin.isRaw, true, "Dashboard keeps ownership after Settings closes");
      assert.equal(stdout.output.includes("\u001b[?1049l"), false, "Dashboard must not leave alternate screen for Settings");
      pressOwnerKey(stdin, "return");
      assert.equal(await pendingDraft, "unchanged dashboard-draft");
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

async function withProductionSettingsConfigEdit(
  itemId: "approval-mode" | "reasoning" | "reasoning-compressor",
  value: string,
  verify: (fixture: {
    readonly appHome: string;
    readonly configPath: string;
    readonly config: typeof DEFAULT_CONFIG;
    readonly session: SessionStore;
    readonly approvals: ApprovalManager;
    /** Every view the surface was actually asked to render, in order. */
    readonly views: readonly SettingsViewModel[];
  }) => Promise<void>,
  arrange?: (fixture: {
    readonly configPath: string;
    readonly config: typeof DEFAULT_CONFIG;
    readonly session: SessionStore;
    readonly route: RouteIdentityV1;
  }) => Promise<void> | void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-live-config-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    const route: RouteIdentityV1 = {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_settings_live_config",
      billingRealm: "openrouter-payg",
      requestedModelId: config.mainModel,
      canonicalModelId: config.mainModel,
      resolutionState: "resolved",
    };
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "Settings live config");
    session.setPreferences(config.mainModel, { mode: "auto" }, route);
    await session.save();
    const rules = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { workspace, ruleStore: rules });
    const intents: Array<
      { kind: "select-item"; itemId: string }
      | { kind: "activate" }
      | { kind: "back" }
    > = [{ kind: "select-item", itemId }, { kind: "activate" }, { kind: "back" }];
    const views: SettingsViewModel[] = [];
    const surface = {
      begin() {},
      async nextIntent(view: SettingsViewModel) {
        views.push(view);
        return intents.shift()!;
      },
      async edit() { return { kind: "value" as const, value }; },
      end() {},
      applyAppearance() {},
      async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const context = {
      executionMode: "local-interactive-owner",
      workspace,
      configPath,
      config,
      approvals,
      session,
      ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute() { throw new Error("unused provider command"); } },
      providerRuntime: {
        activity: () => ({ runActive: false, activationHeld: false }),
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
        readCachedSettingsModels: () => [
          {
            id: route.requestedModelId,
            name: route.requestedModelId,
            description: "current main model",
            contextLength: 128_000,
            promptPrice: 0,
            completionPrice: 0,
            supportedParameters: ["tools", "reasoning"],
            inputModalities: ["text"],
            outputModalities: ["text"],
          },
          {
            id: config.compressorModel,
            name: config.compressorModel,
            description: "current compressor model",
            contextLength: 128_000,
            promptPrice: 0,
            completionPrice: 0,
            supportedParameters: ["tools", "reasoning"],
            inputModalities: ["text"],
            outputModalities: ["text"],
          },
        ],
        async runSettingsConfigMutation<T>(task: () => Promise<T>) { return task(); },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;

    await arrange?.({ configPath, config, session, route });
    await createSettingsSession(context, surface, false).open();
    await verify({ appHome, configPath, config, session, approvals, views });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("production Settings bleibt editierbar, wenn der offene Chat ein anderes Modell fährt als die Datei", async () => {
  await withProductionSettingsConfigEdit(
    "approval-mode",
    "read-only",
    async ({ configPath, config, approvals, views }) => {
      for (const view of views) {
        assert.equal(view.readOnlyReason, null, "die eigene Session-Präferenz ist kein fremder Schreiber");
      }
      const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
      assert.equal(stored.approvalMode, "read-only", "der Save muss end-to-end durable werden");
      assert.equal(approvals.mode, "read-only");
      assert.equal(
        stored.mainModel,
        DEFAULT_CONFIG.mainModel,
        "ein Settings-Save schreibt das Session-Modell nie auf die Platte",
      );
      assert.equal(
        config.mainModel,
        "qwen/qwen3.8-max",
        "und hängt den laufenden Chat nie auf das Datei-Modell um",
      );
    },
    ({ config }) => {
      // Exakt die Gestalt der Owner-Meldung und exakt der Startup-Restore:
      // `openrouter/auto` steht auf der Platte, der fortgesetzte Chat fährt
      // ein konkretes Modell, und diese Präferenz liegt NUR in der Runtime.
      assert.equal(config.mainModel, "openrouter/auto");
      config.mainModel = "qwen/qwen3.8-max";
    },
  );
});

test("production Settings sperrt bei echtem Fremdschreiber und nennt Grund und Ausweg", async () => {
  await withProductionSettingsConfigEdit(
    "approval-mode",
    "read-only",
    async ({ configPath, config, approvals, views }) => {
      assert.ok(views.length > 0);
      for (const view of views) {
        assert.equal(view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.foreignConfig);
      }
      const locked = views[0]!.allItems.find(({ id }) => id === "approval-mode");
      assert.equal(locked?.disabledReason, SETTINGS_READ_ONLY_REASONS.foreignConfig);
      const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
      assert.equal(stored.approvalMode, "ask", "eine gesperrte Zeile darf nichts publizieren");
      assert.equal(stored.compressorModel, "vendor/foreign-compressor");
      assert.equal(approvals.mode, "ask");
    },
    async ({ configPath }) => {
      // Ein zweites orcode publiziert eigene Bytes, nachdem diese Instanz
      // geladen hat — genau der Fall, für den es die Sperre gibt.
      const stored = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      stored.compressorModel = "vendor/foreign-compressor";
      await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    },
  );
});

test("production Settings approval save publishes the exact live ApprovalManager after durable config", async () => {
  await withProductionSettingsConfigEdit("approval-mode", "read-only", async ({
    configPath,
    config,
    approvals,
  }) => {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.equal(stored.approvalMode, "read-only", "approval mode must be durable before Settings returns");
    assert.equal(config.approvalMode, "read-only", "live config must match the durable approval mode");
    assert.equal(approvals.mode, "read-only", "subsequent tool calls must use the exact updated ApprovalManager");
  });
});

test("production Settings reasoning save persists the current session so the next prompt keeps it", async () => {
  await withProductionSettingsConfigEdit("reasoning", "effort:high", async ({
    configPath,
    config,
    session,
  }) => {
    const expected = { mode: "effort" as const, effort: "high" as const };
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const durableSession = await readSessionEditSnapshot(session.path);
    assert.deepEqual(stored.reasoningByModel[config.mainModel], expected, "reasoning must be durable in config");
    assert.deepEqual(config.reasoningByModel[config.mainModel], expected, "live config must expose the saved reasoning");
    assert.deepEqual(session.data.reasoning, expected, "ensureAgentForPrompt must read the new live session reasoning");
    assert.deepEqual(durableSession.data.reasoning, expected, "the next process must reopen the same reasoning from session storage");
  });
});

test("production Settings compressor reasoning save is durable but never rewrites the main chat session", async () => {
  await withProductionSettingsConfigEdit("reasoning-compressor", "effort:high", async ({
    configPath,
    config,
    session,
  }) => {
    const expected = { mode: "effort" as const, effort: "high" as const };
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const durableSession = await readSessionEditSnapshot(session.path);
    assert.deepEqual(
      stored.reasoningByModel[config.compressorModel],
      expected,
      "compressor reasoning must be durable in config",
    );
    assert.deepEqual(
      config.reasoningByModel[config.compressorModel],
      expected,
      "live config must expose the saved compressor reasoning",
    );
    assert.equal(
      stored.reasoningByModel[config.mainModel],
      undefined,
      "the main role's own entry must stay untouched",
    );
    // The liveConfig publication in src/cli.ts only calls
    // session.setPreferences when the MAIN model's setting changed; a
    // compressor-only change must never rewrite the live or durable session.
    assert.deepEqual(
      session.data.reasoning,
      { mode: "auto" },
      "a non-main role change must never rewrite the live session",
    );
    assert.deepEqual(
      durableSession.data.reasoning,
      { mode: "auto" },
      "a non-main role change must never rewrite the durable session",
    );
  });
});

test("production Settings reasoning recovery preserves exact durable and live Kimi Cross state", async () => {
  let saveAfterRecovery!: () => ReturnType<SessionStore["save"]>;
  let expectedCrossMode: unknown;
  await withProductionSettingsConfigEdit("reasoning", "effort:high", async ({
    appHome,
    configPath,
    config,
    session,
  }) => {
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const durableSession = await readSessionEditSnapshot(session.path);
    assert.equal(stored.reasoningByModel[config.mainModel], undefined);
    assert.equal(config.reasoningByModel[config.mainModel], undefined);
    assert.deepEqual(session.data.reasoning, { mode: "auto" });
    assert.deepEqual(durableSession.data.reasoning, { mode: "auto" });
    assert.equal(durableSession.data.route?.backendId, "kimi-code");
    assert.deepEqual(durableSession.data.crossMode, expectedCrossMode, "reasoning recovery must preserve Cross");
    assert.deepEqual(session.data.crossMode, expectedCrossMode, "the live owner must adopt the same complete recovered snapshot");

    session.addTurn("user", "merge-base must already equal the recovered durable session");
    await saveAfterRecovery();
    const reopened = await SessionStore.openById(session.data.workspace, session.data.id, appHome);
    assert.deepEqual(reopened.data.crossMode, expectedCrossMode);
    assert.equal(reopened.data.turns.at(-1)?.content, "merge-base must already equal the recovered durable session");
  }, async ({ session, route }) => {
    Object.assign(route, {
      backendId: "kimi-code" as const,
      accountFingerprint: "acct_kimi_settings_reasoning_recovery",
      billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    });
    session.setPreferences(route.requestedModelId, { mode: "auto" }, route);
    session.armCrossMode({
      lead: route,
      challenger: {
        ...route,
        requestedModelId: `${route.requestedModelId}-review`,
        canonicalModelId: `${route.canonicalModelId}-review`,
      },
    });
    expectedCrossMode = structuredClone(session.data.crossMode);
    await session.save();
    const productionSave = session.save.bind(session);
    saveAfterRecovery = productionSave;
    let calls = 0;
    Object.defineProperty(session, "save", {
      configurable: true,
      async value() {
        calls += 1;
        if (calls === 1) {
          await productionSave();
          throw new Error("synthetic failure after session publication");
        }
        throw new Error("synthetic rollback save failure");
      },
    });
  });
});

test("production Settings reasoning recovery follows authoritative config after a rollback CAS race", async () => {
  await withProductionSettingsConfigEdit("reasoning", "effort:high", async ({
    configPath,
    config,
    session,
  }) => {
    const expected = { mode: "effort" as const, effort: "low" as const };
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const durableSession = await readSessionEditSnapshot(session.path);
    assert.deepEqual(stored.reasoningByModel[config.mainModel], expected);
    assert.deepEqual(config.reasoningByModel[config.mainModel], expected);
    assert.deepEqual(session.data.reasoning, expected);
    assert.deepEqual(durableSession.data.reasoning, expected);
  }, async ({ configPath, session }) => {
    Object.defineProperty(session, "save", {
      configurable: true,
      async value() {
        const current = await readConfigEditSnapshot(configPath);
        const concurrent = structuredClone(current.config);
        concurrent.reasoningByModel[concurrent.mainModel] = { mode: "effort", effort: "low" };
        await saveConfigEdit(current, concurrent, configPath);
        throw new Error("synthetic session failure after concurrent config publication");
      },
    });
  });
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
    const nextRoute: RouteIdentityV1 = {
      ...route,
      requestedModelId: "vendor/next",
      canonicalModelId: "vendor/next",
    };
    const connectionId = "production-settings-connection";
    const credentialPointer = "v1:inference:51515151-5151-4151-8151-515151515151";
    const initialProviderState: ProviderSetupStateV3 = {
      schemaVersion: 3,
      revision: 4,
      lifecycle: "configured",
      connections: [{
        id: connectionId,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: credentialPointer },
        accountFingerprint: route.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "ready",
          observedAt: 1,
          generation: 0,
        },
      }],
      defaultRoute: route,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = route.requestedModelId;
    config.providerSetup = structuredClone(initialProviderState);
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "production adapter");
    session.setPreferences(config.mainModel, { mode: "auto" }, route);
    await session.save();
    const rules = await RuleStore.load(appHome);
    const remembered = [];
    for (const command of ["one", "two"]) {
      remembered.push(await rules.remember({
        workspace, tool: "shell", decision: "allow",
        subject: shellApprovalSubject({ platform: "darwin", executable: "/bin/echo", mode: [], cwd: ".", command }),
      }));
    }
    const models = [
      { id: "vendor/main", name: "Main", description: "main", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools", "reasoning"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/next", canonicalSlug: "vendor/next", name: "Next", description: "next", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools", "reasoning"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/compressor", name: "Compressor", description: "compress", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/no-tools", name: "No tools", description: "negative role proof", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: [], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/panel", name: "Panel", description: "panel", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] },
      { id: "vendor/audio", name: "Audio", description: "audio", contextLength: 128_000, promptPrice: 0, completionPrice: 0, supportedParameters: [], inputModalities: ["text", "audio"], outputModalities: ["text"] },
    ];
    const secret = "synthetic-production-settings-secret";
    const slots = new Map<string, string>([[credentialPointer, secret]]);
    let slotSequence = 1;
    const credentials = {
      location: "synthetic-versioned-store",
      async get() { return null; },
      async set() {},
      async delete() { return false; },
      async has() { return false; },
      reserveSlot(kind: string) {
        return Object.freeze({
          version: 1 as const,
          kind,
          id: `v1:${kind}:52525252-5252-4252-8252-${String(slotSequence++).padStart(12, "0")}`,
        });
      },
      async writeSlot(slot: { id: string }, value: string) { slots.set(slot.id, value); },
      async readSlot(slot: { id: string }) { return slots.get(slot.id) ?? null; },
      async deleteSlot(slot: { id: string }) { return slots.delete(slot.id); },
      async getOrCreateAccountHmacKey() { return new Uint8Array(32).fill(5); },
    };
    const stateStore = new ProviderStateStore(initialProviderState, {
      persist: (request) => persistProviderSetupState(configPath, request),
    });
    let coordinator!: ProviderActivationCoordinator;
    const credentialAuthority = new ProviderCredentialAuthority({
      stateStore,
      credentials: credentials as never,
      environment: {},
      coordinator: () => coordinator,
    });
    const publicationOrder: string[] = [];
    let runtime!: DefaultProviderRuntime;
    let candidateSequence = 1;
    const adapter = {
      backendId: "openrouter" as const,
      async inspect() { throw new Error("unused production Settings inspection"); },
      async reconnect() { throw new Error("unused production Settings reconnect"); },
      async bindRuntime() {},
      async logout() {},
      async connect(request: { generation: number }) {
        return {
          candidateId: `settings-candidate-${candidateSequence++}`,
          backendId: "openrouter" as const,
          connectionId,
          accountFingerprint: route.accountFingerprint,
          billingRealm: "openrouter-payg" as const,
          health: {
            credential: "valid" as const,
            connectivity: "connected" as const,
            spend: "available" as const,
            runtime: "ready" as const,
            observedAt: 2,
            generation: request.generation,
          },
        };
      },
      async listModels() {
        return [route, nextRoute].map((candidate) => ({
          backendId: "openrouter" as const,
          requestedModelId: candidate.requestedModelId,
          canonicalModelId: candidate.canonicalModelId!,
          displayName: candidate.requestedModelId,
          capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
        }));
      },
      async activate(request: { candidateId: string; model: { requestedModelId: string } }) {
        const durableConfig = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
        const durableSession = await readSessionEditSnapshot(session.path);
        assert.equal(durableConfig.mainModel, nextRoute.requestedModelId, "publication persist precedes provider runtime activation");
        assert.deepEqual((durableConfig.providerSetup as ProviderSetupStateV3).defaultRoute, nextRoute, "provider route is durable before live publication");
        assert.equal(durableSession.data.model, nextRoute.requestedModelId, "session model is durable before live publication");
        assert.deepEqual(durableSession.data.route, nextRoute, "session route is durable before live publication");
        assert.equal(config.mainModel, route.requestedModelId, "live config remains OLD until publication publish");
        assert.equal(session.data.model, route.requestedModelId, "live session remains OLD until publication publish");
        assert.deepEqual(runtime.currentSessionRoute(), route, "live runtime remains OLD until publication publish");
        publicationOrder.push("persist");
        return {
          candidateId: request.candidateId,
          backendId: "openrouter" as const,
          connectionId,
          accountFingerprint: route.accountFingerprint,
          billingRealm: "openrouter-payg" as const,
          route: nextRoute,
        };
      },
      async discardCandidate() {},
    };
    const registry = new BackendRegistry([{
      descriptor: {
        id: "openrouter",
        displayName: "OpenRouter",
        maturity: "stable",
        connectable: true,
        kind: "raw-model",
        credentialOwner: "orcode-keychain",
        billingRealmKind: "api-payg",
        capabilities: { models: true, tools: true, reasoning: true },
      },
      adapter: adapter as never,
    }]);
    const runtimeGuard = new SessionProviderRuntimeGuard();
    coordinator = new ProviderActivationCoordinator({
      appHome,
      configPath,
      privateStore: new PrivateStore({ root: appHome }),
      credentials: credentials as never,
      adapterResolver: () => adapter as never,
      stateStore,
      runtimeGuard,
      candidateAuthority: credentialAuthority,
      createUuid: () => `53535353-5353-4353-8353-${String(candidateSequence++).padStart(12, "0")}`,
    });
    const orchestrator = new SetupOrchestrator({
      registry,
      stateStore,
      activationCoordinator: coordinator,
    });
    runtime = new DefaultProviderRuntime(
      new OpenRouterService(secret),
      credentials as never,
      registry,
      stateStore,
      orchestrator,
      coordinator,
      runtimeGuard,
      {} as never,
      null,
      null,
      route.requestedModelId,
      config,
      session,
      {
        credentialAuthority,
        adapter: adapter as never,
        forgetJournal: {} as never,
        async recover() {},
      },
      "local-interactive-owner",
    );
    runtime.adoptCredentialActivation(route, true, secret);
    await runtime.runModelCatalog(async () => models as never);
    const desktopRoutePickerAuthority = runtime.routePickerAuthority();
    const routePickerAuthority = runtime.terminalOwnerRoutePickerAuthority();
    const selectionFor = (role: "main" | "compressor" | "executor", modelId: string) => {
      const view = routePickerAuthority.view({ role });
      const candidate = view.candidates.find((row) => row.canonicalModelId === modelId)!;
      assert.ok(candidate, `missing ${role} authority row ${modelId}`);
      return { handle: candidate.handle, revision: view.revision, generation: view.generation };
    };
    await session.save();
    const providerIntents: string[] = [];
    const providerStatePath = join(appHome, "synthetic-provider-state.json");
    let providerConnected = false;
    const providerStatus = () => [{ backendId: "openrouter", displayName: "OpenRouter", availability: "connectable", configuration: providerConnected ? "enabled" : "disabled", maturity: "stable", billingRealm: "openrouter-payg", headline: providerConnected ? "synthetic connected" : "synthetic ready", health: { credential: "valid", connectivity: providerConnected ? "connected" : "unknown", spend: "available", runtime: providerConnected ? "ready" : "not-applicable" }, isDefault: true, allowedActions: ["connect"], selectedModel: null }];
    const intents: Array<{ kind: "select-item"; itemId: string } | { kind: "activate" } | { kind: "back" }> = [];
    const activate = (itemId: string) => intents.push({ kind: "select-item", itemId }, { kind: "activate" });
    activate("provider-action:openrouter:connect");
    activate("main-model"); // opaque provider publication requires the real coordinator.
    activate("compressor-model");
    activate(`approval-forget:${remembered[0]!.id}`);
    activate("approval-forget-all");
    activate("verify-suggest");
    activate("panel-models");
    activate("transcription-model");
    activate("architect-executor-model");
    intents.push({ kind: "back" });
    let appearancePublishes = 0;
    const surface = {
      begin() {},
      async nextIntent() {
        const next = intents.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
      async edit(request: { itemId: string }) {
        if (request.itemId === "main-model") return {
          kind: "value" as const,
          value: {
            kind: "model-route" as const,
            selection: selectionFor("main", nextRoute.canonicalModelId!),
          },
        };
        if (request.itemId === "compressor-model") return {
          kind: "value" as const,
          value: {
            kind: "model-route" as const,
            selection: await runtime.runModelCatalog(
              async () => models as never,
            ).then(() => selectionFor("compressor", "vendor/compressor")),
          },
        };
        if (request.itemId === "panel-models") return { kind: "value" as const, value: ["vendor/main", "vendor/panel"] };
        if (request.itemId === "transcription-model") return { kind: "value" as const, value: "vendor/audio" };
        if (request.itemId === "architect-executor-model") return {
          kind: "value" as const,
          value: { kind: "model-route" as const, selection: selectionFor("executor", "vendor/no-tools") },
        };
        return { kind: "value" as const, value: true };
      },
      end() {},
      applyAppearance() { appearancePublishes += 1; },
      async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const context = {
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute(intent: { kind: string }) {
        providerIntents.push(intent.kind);
        providerConnected = true;
        await writeFile(providerStatePath, JSON.stringify({ connected: true }), "utf8");
        return { kind: "changed", operation: intent.kind, backendId: "openrouter" };
      } },
      providerRuntime: {
        routePickerAuthority: () => desktopRoutePickerAuthority,
        terminalOwnerRoutePickerAuthority: () => routePickerAuthority,
        activity: () => runtime.activity(), currentSessionRoute: () => runtime.currentSessionRoute(),
        readCachedSettingsRoute: () => ({ backendId: "openrouter" as const, providerLabel: "OpenRouter", requestedModelId: route.requestedModelId, canonicalModelId: route.canonicalModelId!, modelLabel: "Main", billingRealm: "openrouter-payg" as const }),
        readCachedProviderStatus: providerStatus,
        readCachedSettingsModels: () => models,
        async listSelectableModelRoutes(query: string) {
          if (query !== "vendor/compressor") return [];
          const compressorRoute: RouteIdentityV1 = {
            ...nextRoute,
            requestedModelId: "vendor/compressor",
            canonicalModelId: "vendor/compressor",
          };
          return [{
            route: compressorRoute,
            providerLabel: "OpenRouter",
            model: {
              id: "vendor/compressor",
              name: "Compressor",
              contextLength: 128_000,
              reasoning: undefined,
              price: { kind: "known" as const, promptUsdPerToken: 0, completionUsdPerToken: 0 },
            },
            supportsTools: true,
            supportsReasoning: false,
            selected: false,
          }];
        },
        async runSettingsConfigMutation<T>(task: () => Promise<T>) { return runtime.runSettingsConfigMutation(task); },
        prepareSettingsModelPublication(next: RouteIdentityV1) {
          return runtime.prepareSettingsModelPublication(next);
        },
        readModelPreferenceAuthority() {
          return runtime.readModelPreferenceAuthority();
        },
        async transitionSessionRoute(
          route: RouteIdentityV1,
          publication: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[1],
          setupSurface: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[2],
        ) {
          return runtime.transitionSessionRoute(route, publication, setupSurface);
        },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;

    await createSettingsSession(context, surface, false).open();

    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.deepEqual(publicationOrder, ["persist"], "main-model durable stage is reached before final live assertions");
    assert.deepEqual(providerIntents, ["connect"], "production provider adapter delegation");
    assert.deepEqual(JSON.parse(await readFile(providerStatePath, "utf8")), { connected: true }, "provider connect durably updates its lower-level state");
    assert.equal(providerStatus()[0].headline, "synthetic connected", "provider view refreshes from the durable mutation");
    assert.equal(stored.mainModel, "vendor/next", "accepted main-model editor reaches durable config");
    assert.deepEqual((stored.providerSetup as ProviderSetupStateV3).defaultRoute, nextRoute, "accepted main-model editor reaches the durable provider route");
    assert.equal(config.mainModel, "vendor/next", "accepted main-model editor publishes the live config");
    assert.equal(session.data.model, "vendor/next", "accepted main-model editor reaches the live session");
    assert.deepEqual(session.data.route, nextRoute, "accepted main-model editor publishes the exact live session route");
    assert.deepEqual(runtime.currentSessionRoute(), nextRoute, "accepted main-model editor publishes the exact live runtime route");
    publicationOrder.push("publish");
    assert.deepEqual(publicationOrder, ["persist", "publish"], "main-model publication persists before it publishes live state");
    assert.equal(stored.compressorModel, "vendor/compressor", "compressor external action reaches durable config");
    assert.notEqual(stored.architectExecutor?.requestedModelId, "vendor/no-tools", "executor without tools is rejected before config mutation");
    assert.deepEqual(stored.panelModels, ["vendor/main", "vendor/panel"], "panel external action reaches durable config");
    assert.equal(stored.transcriptionModel, "vendor/audio", "transcription external action reaches durable config");
    assert.deepEqual(stored.verify.commands, ["npm run check", "npm run test", "npm run build"], "verify suggestion confirms then persists");
    assert.deepEqual(rules.list(workspace), [], "approval forget and forget-all reach the real rule store");
    assert.equal(config.compressorModel, "vendor/compressor", "compressor live consumer observes its own config field");
    assert.deepEqual(config.panelModels, ["vendor/main", "vendor/panel"], "panel live consumer observes its own config field");
    assert.equal(config.transcriptionModel, "vendor/audio", "transcription live consumer observes its own config field");
    assert.equal(appearancePublishes, 0, "external model rows must not use appearance publication as a live-consumer proxy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Settings and /model publish Kimi with Cross disarmed in the preference transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-kimi-transaction-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const connectionId = "61616161-6161-4161-8161-616161616161";
    const credentialPointer = "v1:kimi-code:62626262-6262-4262-8262-626262626262";
    const fingerprint = "acct_kimi_settings_transaction";
    const current = { version: 1, backendId: "kimi-code", accountFingerprint: fingerprint,
      billingRealm: "kimi-code-membership-provider-managed-overage", requestedModelId: "kimi-for-coding",
      canonicalModelId: "kimi-for-coding", resolutionState: "resolved" } as const satisfies RouteIdentityV1;
    const target = { ...current, requestedModelId: "kimi-for-coding-highspeed",
      canonicalModelId: "kimi-for-coding-highspeed" } satisfies RouteIdentityV1;
    const initialState: ProviderSetupStateV3 = {
      schemaVersion: 3, revision: 4, lifecycle: "configured",
      connections: [{ id: connectionId, backendId: "kimi-code", enabled: true, maturity: "preview",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: credentialPointer }, accountFingerprint: fingerprint, accountFingerprintState: "verified",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        lastHealth: { credential: "valid", connectivity: "connected", spend: "available",
          runtime: "not-applicable", observedAt: 1, generation: 0 } }],
      defaultRoute: current, cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = current.requestedModelId;
    config.providerSetup = structuredClone(initialState);
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "Kimi transaction");
    session.setPreferences(current.requestedModelId, { mode: "auto" }, current);
    session.armCrossMode({ lead: current, challenger: target });
    await session.save();
    const rules = await RuleStore.load(appHome);
    const secrets = new Map([[credentialPointer, "synthetic-kimi-membership-secret"]]);
    let slotSequence = 1;
    const credentialCalls = { get: 0, set: 0, delete: 0, has: 0, reserve: 0, writeSlot: 0, readSlot: 0, deleteSlot: 0, hmac: 0 };
    const credentials = {
      location: "synthetic-versioned-store", async get() { credentialCalls.get += 1; return null; }, async set() { credentialCalls.set += 1; }, async delete() { credentialCalls.delete += 1; return false; }, async has() { credentialCalls.has += 1; return false; },
      reserveSlot(kind: string) { credentialCalls.reserve += 1; return Object.freeze({ version: 1 as const, kind,
        id: `v1:${kind}:64646464-6464-4464-8464-${String(slotSequence++).padStart(12, "0")}` }); },
      async writeSlot(slot: { id: string }, value: string) { credentialCalls.writeSlot += 1; secrets.set(slot.id, value); },
      async readSlot(slot: { id: string }) { credentialCalls.readSlot += 1; return secrets.get(slot.id) ?? null; },
      async deleteSlot(slot: { id: string }) { credentialCalls.deleteSlot += 1; return secrets.delete(slot.id); },
      async getOrCreateAccountHmacKey() { credentialCalls.hmac += 1; return new Uint8Array(32).fill(6); },
    };
    const stateStore = new ProviderStateStore(initialState, { persist: (request) => persistProviderSetupState(configPath, request) });
    let coordinator!: ProviderActivationCoordinator;
    const credentialAuthority = new ProviderCredentialAuthority({ stateStore, credentials: credentials as never,
      environment: {}, coordinator: () => coordinator });
    let activationCalls = 0;
    const models = KIMI_CODE_MODELS.filter((model) => model.id === current.requestedModelId || model.id === target.requestedModelId);
    const adapter = {
      backendId: "kimi-code" as const,
      async inspect() { throw new Error("unused inspect"); },
      async inspectUnderAuthorityLease() { throw new Error("unused retained inspection"); },
      async reconnect() { throw new Error("unused reconnect"); }, async bindRuntime() {}, async logout() {}, async discardCandidate() {},
      async connect(request: { generation: number }) { return {
        candidateId: "kimi-settings-candidate", backendId: "kimi-code" as const, connectionId,
        accountFingerprint: fingerprint, billingRealm: "kimi-code-membership-provider-managed-overage" as const,
        health: { credential: "valid" as const, connectivity: "connected" as const, spend: "available" as const,
          runtime: "not-applicable" as const, observedAt: 2, generation: request.generation },
      }; },
      async listModels() { return models.map((model) => ({ backendId: "kimi-code" as const,
        requestedModelId: model.id, canonicalModelId: model.id, displayName: model.displayName,
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true } })); },
      async activate(request: { candidateId: string; model: { requestedModelId: string; canonicalModelId: string } }) {
        activationCalls += 1;
        return { candidateId: request.candidateId, backendId: "kimi-code" as const, connectionId,
          accountFingerprint: fingerprint, billingRealm: "kimi-code-membership-provider-managed-overage" as const,
          route: { ...current, requestedModelId: request.model.requestedModelId,
            canonicalModelId: request.model.canonicalModelId } };
      },
    };
    const registry = new BackendRegistry([{ descriptor: KIMI_CODE_DESCRIPTOR, adapter: adapter as never }]);
    const guard = new SessionProviderRuntimeGuard();
    coordinator = new ProviderActivationCoordinator({ appHome, configPath, privateStore: new PrivateStore({ root: appHome }),
      credentials: credentials as never, adapterResolver: () => adapter as never, stateStore, runtimeGuard: guard,
      candidateAuthority: credentialAuthority, createUuid: () => "63636363-6363-4363-8363-636363636363" });
    const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator: coordinator });
    let orchestratorCalls = 0;
    let orchestratorError = "";
    const activateCandidate = orchestrator.activateCandidate.bind(orchestrator);
    orchestrator.activateCandidate = async (...args: Parameters<typeof activateCandidate>) => {
      orchestratorCalls += 1;
      try { return await activateCandidate(...args); } catch (error) { orchestratorError = errorMessage(error); throw error; }
    };
    const runtime = new DefaultProviderRuntime(new OpenRouterService(undefined), credentials as never, registry, stateStore,
      orchestrator, coordinator, guard, {} as never, null, null, current.requestedModelId, config, session,
      { credentialAuthority, adapter: {} as never, kimiAdapter: adapter as never, forgetJournal: {} as never, async recover() {} },
      "local-interactive-owner");
    runtime.adoptCredentialActivation(current, true, "synthetic-kimi-membership-secret");
    await runtime.runModelCatalog(async () => models.map((model) => ({ id: model.id, name: model.displayName,
      description: "synthetic Kimi", contextLength: model.effectiveContextDefault, promptPrice: -1, completionPrice: -1,
      supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"] })));
    await session.save();
    const realSessionSave = session.save.bind(session);
    let settingsPostCommitSaves = 0;
    Object.defineProperty(session, "save", {
      configurable: true,
      value: async () => {
        settingsPostCommitSaves += 1;
        throw new Error("a successful Settings Kimi transaction must not perform a second session save");
      },
    });
    const desktop = runtime.routePickerAuthority();
    const ownerSource = runtime.terminalOwnerRoutePickerAuthority();
    let ownerViews = 0;
    let ownerResolves = 0;
    let desktopReads = 0;
    let prepareCalls = 0;
    let authorityReads = 0;
    let transitionCalls = 0;
    const owner = { view(request: Parameters<typeof ownerSource.view>[0]) { ownerViews += 1; return ownerSource.view(request); },
      resolve(request: Parameters<typeof ownerSource.resolve>[0], selection: Parameters<typeof ownerSource.resolve>[1]) {
        ownerResolves += 1; return ownerSource.resolve(request, selection); } };
    const desktopTrap = { view(request: Parameters<typeof desktop.view>[0]) { desktopReads += 1; return desktop.view(request); },
      resolve(request: Parameters<typeof desktop.resolve>[0], selection: Parameters<typeof desktop.resolve>[1]) {
        desktopReads += 1; return desktop.resolve(request, selection); } };
    const preflightOwnerView = ownerSource.view({ role: "main" });
    assert.ok(preflightOwnerView.candidates.some((row) => row.canonicalModelId === target.canonicalModelId && row.runnable),
      `distinct Kimi target missing from owner authority: ${JSON.stringify(preflightOwnerView.candidates)}`);
    Object.assign(credentialCalls, { get: 0, set: 0, delete: 0, has: 0, reserve: 0, writeSlot: 0, readSlot: 0, deleteSlot: 0, hmac: 0 });
    const intents = [{ kind: "select-item" as const, itemId: "main-model" }, { kind: "activate" as const }, { kind: "back" as const }];
    const notices: string[] = [];
    const messages: string[] = [];
    const surface = { begin() {}, async nextIntent() { return intents.shift()!; }, async edit() {
      const view = owner.view({ role: "main" });
      const candidate = view.candidates.find((row) => row.canonicalModelId === target.canonicalModelId && row.runnable)!;
      assert.ok(candidate, "distinct owner-only Kimi target must be authority-minted and runnable");
      return { kind: "value" as const, value: { kind: "model-route" as const,
        selection: { handle: candidate.handle, revision: view.revision, generation: view.generation } } };
    }, end() {}, applyAppearance() {}, async confirmAction() { return { accepted: true }; },
    async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
    addMessage(_role: string, message: string) { messages.push(message); }, showSettingsNotice(message: string) { notices.push(message); }, restoreSettings() {} } as unknown as TerminalUi;
    const context = { executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined), providerCommands: { async execute() { throw new Error("unused"); } },
      providerRuntime: { routePickerAuthority: () => desktopTrap, terminalOwnerRoutePickerAuthority: () => owner,
        activity: () => runtime.activity(), currentSessionRoute: () => runtime.currentSessionRoute(),
        readCachedSettingsRoute: () => runtime.readCachedSettingsRoute(), readCachedProviderStatus: () => runtime.readCachedProviderStatus(),
        readCachedSettingsModels: () => runtime.readCachedSettingsModels(), prepareSettingsModelPublication: (route: RouteIdentityV1) => { prepareCalls += 1; return runtime.prepareSettingsModelPublication(route); },
        readModelPreferenceAuthority: () => { authorityReads += 1; return runtime.readModelPreferenceAuthority(); },
        transitionSessionRoute: (route: RouteIdentityV1, publication: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[1], setupSurface: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[2]) => { transitionCalls += 1; return runtime.transitionSessionRoute(route, publication, setupSurface); } },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } } } as never;
    await createSettingsSession(context, surface, false).open();
    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const durableSession = await readSessionEditSnapshot(session.path);
    assert.deepEqual((stored.providerSetup as ProviderSetupStateV3).defaultRoute, target, [...notices, ...messages].join(" | "));
    assert.equal((stored.providerSetup as ProviderSetupStateV3).revision, initialState.revision + 1);
    assert.equal(stored.mainModel, target.requestedModelId);
    assert.deepEqual((config.providerSetup as ProviderSetupStateV3).defaultRoute, target);
    assert.deepEqual(durableSession.data.route, target);
    assert.deepEqual(session.data.route, target);
    assert.deepEqual(runtime.currentSessionRoute(), target);
    assert.equal(session.data.crossMode, undefined);
    assert.equal(settingsPostCommitSaves, 0, "Settings must not save the session again after route commit");
    assert.equal(durableSession.data.crossMode, undefined, "the transaction's one session write must disarm Cross");
    assert.deepEqual(messages, [
      "Cross mode off — Kimi Code routes do not support Cross; next message runs single-model.",
    ]);
    assert.equal(ownerViews, 1);
    assert.equal(ownerResolves, 2);
    assert.equal(desktopReads, 0);
    assert.equal(prepareCalls, 1);
    assert.equal(authorityReads, 1);
    assert.equal(transitionCalls, 1);
    assert.equal(orchestratorCalls, 1, orchestratorError);
    assert.equal(activationCalls, 1);
    assert.deepEqual(credentialCalls, { get: 0, set: 0, delete: 0, has: 0, reserve: 1, writeSlot: 1, readSlot: 7, deleteSlot: 1, hmac: 0 });
    assert.deepEqual(await readdir(join(appHome, "transactions/model-preference")).catch(() => []), []);

    Object.defineProperty(session, "save", { configurable: true, value: realSessionSave });
    session.armCrossMode({ lead: current, challenger: target });
    await realSessionSave();
    let modelPostCommitSaves = 0;
    Object.defineProperty(session, "save", {
      configurable: true,
      value: async () => {
        modelPostCommitSaves += 1;
        throw new Error("a successful /model Kimi transaction must not perform a second session save");
      },
    });
    const commandLines: string[] = [];
    const currentModel = models.find((model) => model.id === current.requestedModelId)!;
    Object.assign(context, {
      providerRoutes: {
        async listSelectableModelRoutes(query: string) {
          assert.equal(query, current.requestedModelId);
          return [{
            route: current,
            providerLabel: "Kimi Code",
            model: {
              id: currentModel.id,
              name: currentModel.displayName,
              contextLength: currentModel.effectiveContextDefault,
              reasoning: { mandatory: false, supportedEfforts: null, supportsMaxTokens: false },
              price: { kind: "unknown" as const },
            },
            supportsTools: true,
            supportsReasoning: true,
            selected: false,
          }];
        },
        currentSessionRoute: () => runtime.currentSessionRoute(),
        prepareSettingsModelPublication: (route: RouteIdentityV1) =>
          runtime.prepareSettingsModelPublication(route),
        readModelPreferenceAuthority: () => runtime.readModelPreferenceAuthority(),
        transitionSessionRoute: (
          route: RouteIdentityV1,
          publication: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[1],
          setupSurface: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[2],
        ) => runtime.transitionSessionRoute(route, publication, setupSurface),
        transitionModel: (
          modelId: string,
          canonicalModelId?: string,
          setupSurface?: Parameters<DefaultProviderRuntime["transitionSessionRoute"]>[2],
        ) => runtime.transitionModel(modelId, canonicalModelId, setupSurface),
      },
      providerRouteSurface: "plain",
      out: {
        text(value: string) { commandLines.push(value); },
        error(value: string) { commandLines.push(value); },
      },
    });

    await handleSlashCommand(`/model ${current.requestedModelId}`, context as unknown as CommandContext);

    const afterModelSession = await readSessionEditSnapshot(session.path);
    const afterModelConfig = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.equal(modelPostCommitSaves, 0, "/model must not save the session again after route commit");
    assert.deepEqual(afterModelSession.data.route, current);
    assert.equal(afterModelSession.data.crossMode, undefined);
    assert.deepEqual(session.data.route, current);
    assert.equal(session.data.crossMode, undefined);
    assert.deepEqual(runtime.currentSessionRoute(), current);
    assert.deepEqual((afterModelConfig.providerSetup as ProviderSetupStateV3).defaultRoute, current);
    assert.equal(afterModelConfig.mainModel, current.requestedModelId);
    assert.equal(
      commandLines.filter((line) => line.includes("Cross mode off — Kimi Code routes do not support Cross")).length,
      1,
      commandLines.join(" | "),
    );
    assert.deepEqual(await readdir(join(appHome, "transactions/model-preference")).catch(() => []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Settings reselects the current main route as a no-op and rejects a stale compressor route", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-model-stale-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const route: RouteIdentityV1 = {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_settings_model_stale",
      billingRealm: "openrouter-payg",
      requestedModelId: "vendor/current",
      canonicalModelId: "vendor/current",
      resolutionState: "resolved",
    };
    const staleCompressorRoute: RouteIdentityV1 = {
      ...route,
      requestedModelId: "vendor/stale-compressor",
      canonicalModelId: "vendor/stale-compressor",
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = route.requestedModelId;
    config.compressorModel = "vendor/original-compressor";
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "Settings stale model");
    session.setPreferences(route.requestedModelId, { mode: "auto" }, route);
    await session.save();
    const sessionBefore = structuredClone(session.data);
    const rules = await RuleStore.load(appHome);
    const approvals = new ApprovalManager("ask", { workspace, ruleStore: rules });
    let sourceRoutes = [route, staleCompressorRoute];
    const routePickerAuthority = createRoutePickerAuthority({
      capture: () => ({
        snapshot: {
          schemaVersion: 1, revision: 1, generation: 1,
          routeRunnable: true, activeRoute: null,
          providers: [{
            providerId: "openrouter", providerLabel: "OpenRouter",
            connectionId: null, accountLabel: null, state: "ready",
            setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: false },
            routes: sourceRoutes.map((item, index) => ({
              handle: `stale-source-${index}`, providerId: "openrouter",
              connectionId: "stale-settings-connection", accountLabel: "OpenRouter",
              canonicalModelId: item.canonicalModelId!, displayName: item.requestedModelId,
              reasoning: "supported", capabilities: ["text", "tools"],
              cost: { kind: "unknown", label: "Kosten unbekannt" },
              dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
            })),
          }],
          undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
        },
        bindings: new Map(sourceRoutes.map((item, index) => [
          `stale-source-${index}`, { connectionId: "stale-settings-connection", route: item },
        ])),
      }),
    });
    const intents: Array<
      { kind: "select-item"; itemId: string }
      | { kind: "activate" }
      | { kind: "back" }
    > = [
      { kind: "select-item", itemId: "main-model" },
      { kind: "activate" },
      { kind: "select-item", itemId: "compressor-model" },
      { kind: "activate" },
      { kind: "back" },
    ];
    const notices: string[] = [];
    const trace: string[] = [];
    const surface = {
      begin() {},
      async nextIntent(view: { notice: { message: string } | null }) {
        if (view.notice) notices.push(view.notice.message);
        const next = intents.shift();
        if (!next) throw new Error(`settings test script exhausted: ${trace.join(" -> ")}`);
        trace.push(next.kind === "select-item" ? `select:${next.itemId}` : next.kind);
        return next;
      },
      async edit(request: { itemId: string }) {
        trace.push(`edit:${request.itemId}`);
        const role = request.itemId === "main-model" ? "main" : "compressor";
        const target = role === "main" ? route : staleCompressorRoute;
        const view = routePickerAuthority.view({ role });
        const row = view.candidates.find((candidate) => candidate.canonicalModelId === target.canonicalModelId)!;
        assert.ok(row);
        if (role === "compressor") sourceRoutes = [route];
        return {
          kind: "value" as const,
          value: {
            kind: "model-route" as const,
            selection: { handle: row.handle, revision: view.revision, generation: view.generation },
          },
        };
      },
      end() {},
      applyAppearance() {},
      async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; },
      async readSecret() { return null; },
      async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const calls: string[] = [];
    const cachedModel = (id: string) => ({
      id,
      name: id,
      description: id,
      contextLength: 128_000,
      promptPrice: 0,
      completionPrice: 0,
      supportedParameters: ["tools"],
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const context = {
      executionMode: "local-interactive-owner",
      workspace,
      configPath,
      config,
      approvals,
      session,
      ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute() { throw new Error("unused provider command"); } },
      providerRuntime: {
        routePickerAuthority: () => routePickerAuthority,
        activity: () => ({ runActive: false, activationHeld: false }),
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
        readCachedSettingsModels: () => [
          cachedModel(route.requestedModelId),
          cachedModel(staleCompressorRoute.requestedModelId),
        ],
        async listSelectableModelRoutes(query: string) {
          calls.push(`catalog:${query}`);
          return [];
        },
        prepareSettingsModelPublication() {
          calls.push("prepare-main");
          throw new Error("same route must not prepare a transaction");
        },
        readModelPreferenceAuthority() {
          calls.push("read-main");
          throw new Error("same route must not read mutation authority");
        },
        async transitionSessionRoute() {
          calls.push("transition-main");
          throw new Error("same route must not transition");
        },
        async runSettingsConfigMutation<T>(task: () => Promise<T>) {
          calls.push("config-mutation");
          return task();
        },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;

    await createSettingsSession(context, surface, false).open();

    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    assert.equal(stored.mainModel, route.requestedModelId);
    assert.equal(stored.compressorModel, "vendor/original-compressor");
    assert.equal(config.mainModel, route.requestedModelId);
    assert.equal(config.compressorModel, "vendor/original-compressor");
    assert.deepEqual(session.data, sessionBefore);
    assert.deepEqual(calls, []);
    assert.ok(notices.includes("Saved"), "same-route main selection completes successfully");
    assert.ok(
      notices.some((notice) => /failed|could not be saved|could not be completed/iu.test(notice)),
      `stale compressor selection surfaces an error notice, got: ${notices.join(" | ")}`,
    );
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

test("production Settings Cross availability on a Kimi route fails closed and enables only supported execution modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-cross-kimi-disabled-"));
  try {
    for (const [label, kimiExecutionMode, hasDesktopClaimIssuer, expectedCrossReason] of [
      ["missing", undefined, false, "Cross is unavailable on Kimi Code routes"],
      ["unavailable", "unavailable", false, "Cross is unavailable on Kimi Code routes"],
      ["terminal-local", "terminal-local", false, undefined],
      ["desktop-private-without-claim-issuer", "desktop-private", false, "Cross is unavailable on Kimi Code routes"],
      ["desktop-private-with-claim-issuer", "desktop-private", true, undefined],
    ] as const) {
      const workspace = join(root, `workspace-${label}`);
      const appHome = join(root, `.orcode-${label}`);
      const configPath = join(appHome, "config.json");
      await mkdir(workspace, { recursive: true });
      const route: RouteIdentityV1 = {
        version: 1, backendId: "kimi-code", accountFingerprint: `acct_kimi_cross_${label}`,
        billingRealm: "kimi-code-membership-provider-managed-overage", requestedModelId: "k3",
        canonicalModelId: "k3", resolutionState: "resolved",
      };
      const config = structuredClone(DEFAULT_CONFIG);
      config.mainModel = "k3";
      await saveConfig(config, configPath);
      const session = SessionStore.create(workspace, appHome, `kimi cross ${label}`);
      session.setPreferences("k3", { mode: "auto" }, route);
      await session.save();
      const rules = await RuleStore.load(appHome);
      const crossPreferences: CrossPreferencesV1 = {
        lead: route,
        challenger: {
          ...route,
          requestedModelId: "k3-review",
          canonicalModelId: "k3-review",
        },
      };
      const capturedItems: { readonly id: string; readonly disabledReason?: string }[] = [];
      const surface = {
        begin(view: { allItems: readonly { readonly id: string; readonly disabledReason?: string }[] }) {
          capturedItems.push(...view.allItems);
        },
        async nextIntent() { return { kind: "back" as const }; },
        async edit() { return { kind: "cancel" as const }; },
        end() {},
        applyAppearance() {}, async confirmAction() { return { accepted: true }; },
        async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
        addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
      } as unknown as TerminalUi;
      const providerRuntime = {
        activity: () => ({ runActive: false, activationHeld: false }),
        currentSessionRoute: () => route,
        readCachedSettingsRoute: () => ({ backendId: "kimi-code" as const, providerLabel: "Kimi Code", requestedModelId: "k3", canonicalModelId: "k3", modelLabel: "K3", billingRealm: "kimi-code-membership-provider-managed-overage" as const }),
        readCachedProviderStatus: () => [],
        readCachedSettingsModels: () => [],
        // Present so every case isolates the Kimi execution-mode contract.
        readCrossPreferences: () => structuredClone(crossPreferences),
        async publishCrossPreferences(next: CrossPreferencesV1) { return next; },
        ...(kimiExecutionMode === undefined
          ? {}
          : { kimiCrossExecutionMode: () => kimiExecutionMode }),
        ...(hasDesktopClaimIssuer
          ? { async issueDesktopKimiCrossClaim() { throw new Error("unused desktop Kimi claim issuer"); } }
          : {}),
      };
      const context = {
        executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
        openRouter: new OpenRouterService(undefined),
        providerCommands: { async execute() { throw new Error("unused Cross-Kimi provider command"); } },
        providerRuntime,
        localRuntime: { guard: { async resolvePath() { return join(workspace, "package.json"); } } },
      } as never;
      await createSettingsSession(context, surface, false).open();
      assert.ok(capturedItems.length > 0, `${label}: the settings surface must have received an initial view`);
      for (const id of ["cross-lead-model", "cross-challenger-model", "cross-pair-swap"]) {
        const row = capturedItems.find((entry) => entry.id === id);
        assert.ok(row, `${label}/${id}`);
        assert.equal(row?.disabledReason, expectedCrossReason, `${label}/${id}`);
      }
      // Architect has a separate Kimi route contract and remains unavailable
      // regardless of Cross's private/local execution capability.
      const architectRow = capturedItems.find((entry) => entry.id === "architect-executor-model");
      assert.ok(architectRow, `${label}/architect-executor-model`);
      assert.equal(
        architectRow?.disabledReason,
        "Architect is unavailable on Kimi Code routes",
        `${label}/architect-executor-model`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Settings pins the real stage-then-publish guard: zero publishes and unchanged disk state with only the lead role set, exactly one publish with both, and the Cross runtime bridge reads the identical stored pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-cross-production-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const sessionRoute: RouteIdentityV1 = {
      version: 1, backendId: "openrouter", accountFingerprint: "acct_cross_production",
      billingRealm: "openrouter-payg", requestedModelId: "vendor/main",
      canonicalModelId: "vendor/main", resolutionState: "resolved",
    };
    const leadRoute: RouteIdentityV1 = {
      ...sessionRoute, requestedModelId: "vendor/cross-lead", canonicalModelId: "vendor/cross-lead",
    };
    const challengerRoute: RouteIdentityV1 = {
      ...sessionRoute, requestedModelId: "vendor/cross-challenger", canonicalModelId: "vendor/cross-challenger",
    };
    const initialProviderState: ProviderSetupStateV3 = {
      schemaVersion: 3,
      revision: 1,
      lifecycle: "configured",
      connections: [{
        id: "cross-production-connection",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:61616161-6161-4161-8161-616161616161" },
        accountFingerprint: sessionRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: {
          credential: "valid", connectivity: "connected", spend: "available", runtime: "ready",
          observedAt: 1, generation: 1,
        },
      }],
      defaultRoute: sessionRoute,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = sessionRoute.requestedModelId;
    config.providerSetup = structuredClone(initialProviderState);
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "cross production");
    session.setPreferences(config.mainModel, { mode: "auto" }, sessionRoute);
    await session.save();
    const rules = await RuleStore.load(appHome);

    const stateStore = new ProviderStateStore(initialProviderState, {
      persist: (request) => persistProviderSetupState(configPath, request),
    });
    const runtimeGuard = new SessionProviderRuntimeGuard();
    const runtime = new DefaultProviderRuntime(
      new OpenRouterService(undefined),
      {} as never,
      {} as never,
      stateStore,
      {} as never,
      {} as never,
      runtimeGuard,
      {} as never,
      null,
      null,
      sessionRoute.requestedModelId,
      config,
      session,
      undefined,
      "local-interactive-owner",
    );
    runtime.adoptCredentialActivation(sessionRoute, true, "cross-production-secret");
    await runtime.runModelCatalog(async () => [leadRoute, challengerRoute].map((item) => ({
      id: item.requestedModelId, name: item.requestedModelId, description: "",
      contextLength: 128_000, promptPrice: 0, completionPrice: 0,
      supportedParameters: ["tools"], inputModalities: ["text"], outputModalities: ["text"],
    })));
    const baseRoutePickerAuthority = createRoutePickerAuthority({
      capture: () => ({
        snapshot: {
          schemaVersion: 1, revision: stateStore.read().revision, generation: 1,
          routeRunnable: true, activeRoute: null,
          providers: [{
            providerId: "openrouter", providerLabel: "OpenRouter",
            connectionId: null, accountLabel: null, state: "ready",
            setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: false },
            routes: [leadRoute, challengerRoute].map((item, index) => ({
              handle: `cross-source-${index}`, providerId: "openrouter",
              connectionId: "cross-production-connection", accountLabel: "OpenRouter",
              canonicalModelId: item.canonicalModelId!, displayName: item.requestedModelId,
              reasoning: "supported", capabilities: ["text", "tools"],
              cost: { kind: "unknown", label: "Kosten unbekannt" },
              dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true,
            })),
          }],
          undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
        },
        bindings: new Map([leadRoute, challengerRoute].map((item, index) => [
          `cross-source-${index}`, { connectionId: "cross-production-connection", route: item },
        ])),
      }),
    });
    const resolvedRoles: string[] = [];
    const routePickerAuthority = {
      view: baseRoutePickerAuthority.view.bind(baseRoutePickerAuthority),
      resolve(request: Parameters<typeof baseRoutePickerAuthority.resolve>[0], selection: Parameters<typeof baseRoutePickerAuthority.resolve>[1]) {
        resolvedRoles.push(request.role);
        return baseRoutePickerAuthority.resolve(request, selection);
      },
    };
    const revisionBefore = stateStore.read().revision;
    // Counts real invocations of the runtime's own publishCrossPreferences —
    // the one call executeSettingsCrossRole (src/cli.ts) is allowed to make,
    // and only once both roles resolve. Not fake-port bookkeeping: this
    // wraps the exact function the real, unexported executor calls through
    // context.providerRuntime.
    let publishCalls = 0;

    const intents: Array<{ kind: "select-item"; itemId: string } | { kind: "activate" } | { kind: "back" }> = [
      { kind: "select-item", itemId: "cross-lead-model" },
      { kind: "activate" },
      { kind: "select-item", itemId: "cross-challenger-model" },
      { kind: "activate" },
      { kind: "back" },
    ];
    let nextIntentCalls = 0;
    const modelRouteValue = (role: "lead" | "challenger", route: RouteIdentityV1) => {
      const view = routePickerAuthority.view({ role });
      const candidate = view.candidates.find((row) => row.canonicalModelId === route.canonicalModelId)!;
      assert.ok(candidate);
      return ({
      kind: "value" as const,
      value: {
        kind: "model-route" as const,
        selection: { handle: candidate.handle, revision: view.revision, generation: view.generation },
      },
      });
    };
    const surface = {
      begin() {},
      async nextIntent() {
        nextIntentCalls += 1;
        // After select-item(lead) + activate() have both been dispatched and
        // awaited (runSettingsSession always awaits completeEditor before
        // asking for the next intent), but strictly before challenger is
        // touched: the real executeSettingsCrossRole must have staged, not
        // published.
        if (nextIntentCalls === 3) {
          assert.equal(publishCalls, 0, "setting the lead role alone must not call publishCrossPreferences");
          const midStored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
          assert.deepEqual(
            (midStored.providerSetup as ProviderSetupStateV3).cross,
            { enabled: false, preferredLead: null, preferredChallenger: null },
            "providerSetup.cross on disk must be untouched while only the lead role is staged",
          );
        }
        return intents.shift()!;
      },
      async edit(request: { itemId: string }) {
        if (request.itemId === "cross-lead-model") return modelRouteValue("lead", leadRoute);
        if (request.itemId === "cross-challenger-model") return modelRouteValue("challenger", challengerRoute);
        return { kind: "value" as const, value: true };
      },
      end() {},
      applyAppearance() {}, async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
    } as unknown as TerminalUi;
    const context = {
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute() { throw new Error("unused production Cross provider command"); } },
      providerRuntime: {
        routePickerAuthority: () => routePickerAuthority,
        activity: () => runtime.activity(),
        currentSessionRoute: () => runtime.currentSessionRoute(),
        readCachedSettingsRoute: () => ({
          backendId: "openrouter" as const, providerLabel: "OpenRouter",
          requestedModelId: sessionRoute.requestedModelId, canonicalModelId: sessionRoute.canonicalModelId!,
          modelLabel: "Main", billingRealm: "openrouter-payg" as const,
        }),
        readCachedProviderStatus: () => [],
        readCachedSettingsModels: () => [],
        readCrossPreferences: () => runtime.readCrossPreferences(),
        publishCrossPreferences: (next: CrossPreferencesV1) => {
          publishCalls += 1;
          return runtime.publishCrossPreferences(next);
        },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;

    await createSettingsSession(context, surface, false).open();

    const stored = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    const storedProviderSetup = stored.providerSetup as ProviderSetupStateV3;
    assert.deepEqual(
      storedProviderSetup.defaultRoute,
      sessionRoute,
      "publishing the Cross pair must never touch the active default route",
    );
    assert.deepEqual(storedProviderSetup.cross.preferredLead, leadRoute);
    assert.deepEqual(storedProviderSetup.cross.preferredChallenger, challengerRoute);
    assert.ok(
      storedProviderSetup.revision > revisionBefore,
      "publishing the completed pair must bump the durable provider-state revision",
    );
    assert.equal(
      publishCalls,
      1,
      "completing the challenger must call the real publishCrossPreferences exactly once total",
    );
    assert.deepEqual(
      resolvedRoles,
      ["lead", "challenger", "lead", "challenger"],
      "both Settings Cross intents resolve when staged and again immediately before publication",
    );
    assert.equal(config.mainModel, sessionRoute.requestedModelId, "Cross Settings must never touch the main model");
    assert.deepEqual(
      (config.providerSetup as ProviderSetupStateV3).cross.preferredLead,
      leadRoute,
      "the live in-memory config stays in sync via publishCrossPreferences, not the general Settings config CAS",
    );

    // The exact same runtime bridge Cross's own preflight reads from
    // (context.providerRuntime.readCrossPreferences) now returns the pair
    // Settings just published — proving the /cross flow picks up the new
    // default without any Cross-side code change.
    assert.deepEqual(runtime.readCrossPreferences(), { lead: leadRoute, challenger: challengerRoute });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production Settings rejects stale first and second Cross intents before preference or config mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-cross-stale-intents-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    await saveConfig(config, configPath);
    const active = {
      version: 1, backendId: "openrouter", accountFingerprint: "acct-active",
      billingRealm: "openrouter-payg", requestedModelId: config.mainModel,
      canonicalModelId: config.mainModel, resolutionState: "resolved",
    } as const satisfies RouteIdentityV1;
    config.providerSetup = {
      schemaVersion: 3, revision: 4, lifecycle: "configured",
      connections: [{ id: "active-connection", backendId: "openrouter", enabled: true, maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:65656565-6565-4565-8565-656565656565" },
        accountFingerprint: active.accountFingerprint, accountFingerprintState: "verified",
        billingRealm: "openrouter-payg", lastHealth: { credential: "valid", connectivity: "connected",
          spend: "available", runtime: "ready", observedAt: 1, generation: 1 } }],
      defaultRoute: active, cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    await saveConfig(config, configPath);
    const routes = {
      lead: { ...active, requestedModelId: "vendor/lead", canonicalModelId: "vendor/lead" },
      challenger: { ...active, accountFingerprint: "acct-review", requestedModelId: "vendor/review", canonicalModelId: "vendor/review" },
    } satisfies Record<"lead" | "challenger", RouteIdentityV1>;
    const session = SessionStore.create(workspace, appHome, "stale Cross Settings");
    session.setPreferences(active.requestedModelId, { mode: "auto" }, active);
    await session.save();
    const rules = await RuleStore.load(appHome);
    let staleRole: "lead" | "challenger" = "lead";
    let resolveCounts = { lead: 0, challenger: 0 };
    let resolveOrder: string[] = [];
    let publishes = 0;
    let livePreferences: CrossPreferencesV1 = { lead: null, challenger: null };
    const effects = { provider: 0, credentials: 0, catalog: 0, prepare: 0, transition: 0, authority: 0, activation: 0 };
    const rows = (role: "lead" | "challenger") => ({
      handle: `${role}-handle`, providerId: "openrouter", connectionId: `${role}-connection`,
      accountLabel: role, canonicalModelId: routes[role].canonicalModelId!, displayName: role,
      reasoning: "supported" as const, capabilities: ["text", "tools"] as const,
      cost: { kind: "unknown" as const, label: "Kosten unbekannt" as const },
      dataPolicy: { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const }, runnable: true,
    });
    const authority = {
      view(request: { role: "lead" | "challenger" }) {
        return { revision: 1, generation: 1, candidates: [rows(request.role)] };
      },
      resolve(request: { role: "lead" | "challenger" }, selection: { handle: string; revision: number; generation: number }) {
        resolveCounts[request.role] += 1;
        resolveOrder.push(`${request.role}:${resolveCounts[request.role]}`);
        if (request.role === staleRole && resolveCounts[request.role] === 2) throw new Error("stale intent at final proof");
        return { selection, candidate: rows(request.role), route: routes[request.role], connectionId: `${request.role}-connection` };
      },
    };
    const readPreferences = () => structuredClone(livePreferences);
    const context = {
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore: rules,
      openRouter: new OpenRouterService(undefined),
      providerCommands: { async execute() { effects.provider += 1; throw new Error("unused"); } },
      providerCredentials: { async apply() { effects.credentials += 1; throw new Error("unused"); } },
      credentials: { async get() { effects.credentials += 1; return null; }, async set() { effects.credentials += 1; }, async delete() { effects.credentials += 1; return false; }, async has() { effects.credentials += 1; return false; } },
      providerRuntime: {
        routePickerAuthority: () => authority,
        terminalOwnerRoutePickerAuthority: () => authority,
        activity: () => ({ runActive: false, activationHeld: false }), currentSessionRoute: () => active,
        readCachedSettingsRoute: () => ({ backendId: "openrouter", providerLabel: "OpenRouter", requestedModelId: active.requestedModelId, canonicalModelId: active.canonicalModelId!, modelLabel: active.requestedModelId, billingRealm: "openrouter-payg" }),
        readCachedProviderStatus: () => [], readCachedSettingsModels: () => [],
        runModelCatalog: async (run: () => Promise<unknown>) => { effects.catalog += 1; return run(); },
        readModelPreferenceAuthority: () => { effects.authority += 1; throw new Error("unused"); },
        prepareSettingsModelPublication: () => { effects.prepare += 1; throw new Error("unused"); },
        transitionSessionRoute: async () => { effects.transition += 1; throw new Error("unused"); },
        ensureRunnableRoute: async () => { effects.activation += 1; throw new Error("unused"); },
        readCrossPreferences: readPreferences,
        async publishCrossPreferences(next: CrossPreferencesV1) { publishes += 1; livePreferences = structuredClone(next); },
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never;
    const bytesBefore = await readFile(configPath, "utf8");
    const sessionBefore = structuredClone(session.data);
    const durableSessionBefore = await readFile(session.path, "utf8");
    const providerRevisionBefore = (config.providerSetup as ProviderSetupStateV3).revision;
    const preferencesBefore = readPreferences();
    for (const role of ["lead", "challenger"] as const) {
      staleRole = role;
      resolveCounts = { lead: 0, challenger: 0 };
      resolveOrder = [];
      const postFailureViews: SettingsViewModel[] = [];
      const intents = [
        { kind: "select-item" as const, itemId: "cross-lead-model" }, { kind: "activate" as const },
        { kind: "select-item" as const, itemId: "cross-challenger-model" }, { kind: "activate" as const },
        { kind: "back" as const },
      ];
      const surface = {
        begin() {}, async nextIntent(view: SettingsViewModel) {
          if (resolveCounts[staleRole] === 2) postFailureViews.push(structuredClone(view));
          return intents.shift()!;
        },
        async edit(request: { itemId: string }) {
          const selectedRole = request.itemId === "cross-lead-model" ? "lead" : "challenger";
          return { kind: "value" as const, value: { kind: "model-route" as const,
            selection: { handle: `${selectedRole}-handle`, revision: 1, generation: 1 } } };
        },
        end() {}, applyAppearance() {}, async confirmAction() { return { accepted: true }; },
        async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
        addMessage() {}, showSettingsNotice() {}, restoreSettings() {},
      } as unknown as TerminalUi;
      await createSettingsSession(context, surface, false, authority as never).open();
      assert.deepEqual(resolveOrder, role === "lead"
        ? ["lead:1", "challenger:1", "lead:2"]
        : ["lead:1", "challenger:1", "lead:2", "challenger:2"]);
      assert.equal(publishes, 0, role);
      assert.equal(await readFile(configPath, "utf8"), bytesBefore, role);
      assert.equal((config.providerSetup as ProviderSetupStateV3).revision, providerRevisionBefore, role);
      assert.deepEqual(readPreferences(), preferencesBefore, role);
      assert.deepEqual(session.data, sessionBefore, role);
      assert.equal(await readFile(session.path, "utf8"), durableSessionBefore, role);
      const cleared = postFailureViews[0]!;
      const lead = cleared.allItems.find((item) => item.id === "cross-lead-model");
      const challenger = cleared.allItems.find((item) => item.id === "cross-challenger-model");
      assert.equal(lead?.displayValue, "Not set", role);
      assert.equal(challenger?.displayValue, "Not set", role);
      assert.deepEqual(effects, { provider: 0, credentials: 0, catalog: 0, prepare: 0, transition: 0, authority: 0, activation: 0 }, role);
    }
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

test("Settings setup ready refreshes once while setup cancellation stays informational without confirm refresh or success", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-setup-outcome-"));
  try {
    const runOutcome = async (outcome: "ready" | "cancelled") => {
      const workspace = join(root, outcome, "workspace");
      const appHome = join(root, outcome, ".orcode");
      const configPath = join(appHome, "config.json");
      await mkdir(workspace, { recursive: true });
      const config = structuredClone(DEFAULT_CONFIG);
      await saveConfig(config, configPath);
      const session = SessionStore.create(workspace, appHome, `settings setup ${outcome}`);
      await session.save();
      const rules = await RuleStore.load(appHome);
      const approvals = new ApprovalManager("ask", { workspace, ruleStore: rules });
      const intents: Array<
        | { kind: "select-item"; itemId: string }
        | { kind: "activate" }
        | { kind: "back" }
      > = [
        { kind: "select-item", itemId: "provider-setup" },
        { kind: "activate" },
        { kind: "back" },
      ];
      const notices: Array<{ kind: string; message: string }> = [];
      let confirms = 0;
      let executes = 0;
      let initialSnapshotReads = 0;
      let snapshotReads = 0;
      const surface = {
        begin() {},
        async nextIntent(view: { notice: { kind: string; message: string } | null }) {
          if (initialSnapshotReads === 0) initialSnapshotReads = snapshotReads;
          if (view.notice) notices.push({ ...view.notice });
          const next = intents.shift();
          if (!next) throw new Error("settings setup outcome script exhausted");
          return next;
        },
        async edit() { return { kind: "value" as const, value: true }; },
        end() {},
        applyAppearance() {},
        async confirmAction() { confirms += 1; return { accepted: true }; },
        async pickChoice() { throw new Error("provider command result must not open setup UI"); },
        async readSecret() { throw new Error("provider command result must not read a secret"); },
        async pickModel() { throw new Error("provider command result must not open a model picker"); },
        addMessage() {},
        showSettingsNotice() {},
        restoreSettings() {},
      } as unknown as TerminalUi;
      const context = {
        executionMode: "local-interactive-owner",
        workspace,
        configPath,
        config,
        approvals,
        session,
        ruleStore: rules,
        openRouter: new OpenRouterService(undefined),
        providerCommands: {
          async execute() {
            executes += 1;
            return { kind: "setup", backendId: "openrouter", outcome };
          },
        },
        providerRuntime: {
          activity: () => ({ runActive: false, activationHeld: false }),
          currentSessionRoute: () => null,
          readCachedSettingsRoute: () => null,
          readCachedProviderStatus: () => {
            snapshotReads += 1;
            return [];
          },
          readCachedSettingsModels: () => [],
          async runSettingsConfigMutation<T>(task: () => Promise<T>) { return task(); },
        },
        localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
      } as never;

      await createSettingsSession(context, surface, false).open();
      return { confirms, executes, initialSnapshotReads, notices, snapshotReads };
    };

    const ready = await runOutcome("ready");
    assert.equal(ready.executes, 1);
    assert.equal(ready.confirms, 0);
    // Both paths perform the controller's mandatory pre-action activity read.
    // Only a successful external action performs the additional authoritative refresh.
    assert.equal(ready.snapshotReads, ready.initialSnapshotReads + 2);
    assert.ok(ready.notices.some((notice) => notice.kind === "success" && notice.message === "Saved"));

    const cancelled = await runOutcome("cancelled");
    assert.equal(cancelled.executes, 1);
    assert.equal(cancelled.confirms, 0);
    assert.equal(cancelled.snapshotReads, cancelled.initialSnapshotReads + 1);
    assert.deepEqual(cancelled.notices, [{ kind: "info", message: "Cancelled" }]);
    assert.equal(cancelled.notices.some((notice) => notice.kind === "success"), false);
    assert.equal(cancelled.notices.some((notice) => /Saved|Success/i.test(notice.message)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
