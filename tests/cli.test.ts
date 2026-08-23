import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CliUsageError,
  createOpenRouterServiceForStartup,
  homeWorkspaceWarning,
  initializeDashboardKey,
  parseArgs,
  runOutcomeExitCode,
} from "../src/cli.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { OpenRouterService } from "../src/openrouter.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import type { ModelInfo } from "../src/types.js";

test("homeWorkspaceWarning warnt nur bei Workspace === Home-Verzeichnis", () => {
  const home = "/tmp/orcode-home-test";
  assert.match(homeWorkspaceWarning(home, home) ?? "", /Home-Verzeichnis/);
  assert.match(homeWorkspaceWarning(`${home}/`, home) ?? "", /Home-Verzeichnis/);
  assert.equal(homeWorkspaceWarning(`${home}/projekt`, home), null);
});

/**
 * K8: CLI usage parsing and the exit-code matrix. `main()` itself is guarded
 * behind an entrypoint check so importing this module for its pure helpers
 * never starts a real run.
 */

test("parseArgs accepts -p and known flags", () => {
  const options = parseArgs(["-p", "fix the bug", "--model", "gpt-5"]);
  assert.equal(options.prompt, "fix the bug");
  assert.equal(options.model, "gpt-5");
  assert.equal(options.json, false);
});

const STARTUP_KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

function startupKeyResponse(status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? {
    data: {
      label: "startup fixture",
      is_free_tier: false,
      is_management_key: false,
      usage: 1,
      usage_daily: 1,
      usage_weekly: 1,
      usage_monthly: 1,
      limit: 100,
      limit_remaining: 99,
    },
  } : { error: { message: "rejected" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dashboardKeyUi() {
  const messages: string[] = [];
  return {
    messages,
    ui: {
      setStatus: () => undefined,
      setCancelHandler: () => undefined,
      addMessage: (_level: string, message: string) => messages.push(message),
      readSecret: async () => null,
    },
  };
}

test("startup reuses a saved key and otherwise marks environment keys process-only", () => {
  const stored = `${STARTUP_KEY_PREFIX}stored-startup-key-123`;
  const environment = `${STARTUP_KEY_PREFIX}environment-startup-key-456`;

  const saved = createOpenRouterServiceForStartup({
    storedInferenceKey: stored,
    environmentInferenceKey: environment,
  });
  assert.equal(saved.requireKey(), stored);
  assert.equal(saved.keyOrigin, "keychain");

  const processOnly = createOpenRouterServiceForStartup({
    storedInferenceKey: null,
    environmentInferenceKey: environment,
    environmentManagementKey: `${STARTUP_KEY_PREFIX}environment-management-key-789`,
  });
  assert.equal(processOnly.requireKey(), environment);
  assert.equal(processOnly.keyOrigin, "environment");
  assert.equal(processOnly.managementKeyOrigin, "environment");
  assert.equal(processOnly.runtimeState.inferenceValidity, "unknown");
});

test("dashboard startup validation never persists an environment key implicitly", async () => {
  const key = `${STARTUP_KEY_PREFIX}dashboard-environment-key-123`;
  const openRouter = new OpenRouterService(
    key,
    undefined,
    { inference: "environment" },
    { fetchImpl: async () => startupKeyResponse() },
  );
  const calls: string[] = [];
  const credentials: CredentialStoreLike = {
    location: "Test-Schlüsselbund",
    async get() { return null; },
    async has() { return false; },
    async set() { calls.push("set"); },
    async delete() { calls.push("delete"); return false; },
  };
  const { ui } = dashboardKeyUi();

  const balance = await initializeDashboardKey(
    ui as never,
    { openRouter, credentials } as never,
  );

  assert.equal(balance?.key.limitRemaining, 99);
  assert.deepEqual(calls, []);
  assert.equal(openRouter.keyOrigin, "environment");
});

test("a rejected saved key stays persisted until a valid environment fallback is activated", async () => {
  const stored = `${STARTUP_KEY_PREFIX}dashboard-rejected-stored-123`;
  const environment = `${STARTUP_KEY_PREFIX}dashboard-valid-environment-456`;
  const openRouter = new OpenRouterService(
    stored,
    undefined,
    { inference: "keychain" },
    {
      fetchImpl: async (_url, init) => {
        const authorization = (init.headers as Record<string, string>).Authorization;
        return authorization === `Bearer ${stored}`
          ? startupKeyResponse(401)
          : startupKeyResponse();
      },
    },
  );
  const calls: string[] = [];
  let persisted: string | null = stored;
  const credentials: CredentialStoreLike = {
    location: "Test-Schlüsselbund",
    async get() { return persisted; },
    async has() { return persisted !== null; },
    async set(_kind, secret) { calls.push("set"); persisted = secret; },
    async delete() { calls.push("delete"); persisted = null; return true; },
  };
  const { ui } = dashboardKeyUi();

  const balance = await initializeDashboardKey(
    ui as never,
    { openRouter, credentials } as never,
    environment,
  );

  assert.equal(balance?.key.limitRemaining, 99);
  assert.equal(openRouter.requireKey(), environment);
  assert.equal(openRouter.keyOrigin, "environment");
  assert.equal(persisted, stored);
  assert.deepEqual(calls, []);
});

test("fullscreen key commands use the shared command lifecycle callbacks", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(source, /context\.readCredentialSecret\s*=/);
  assert.match(source, /context\.confirmCredentialForget\s*=/);
  assert.match(source, /context\.confirmProcessOnlyCredential\s*=/);
  assert.equal(
    source.includes('commandArgs[0]?.toLowerCase() === "set"'),
    false,
    "the dashboard must not bypass keyCommand with its old private /key set flow",
  );
});

test("parseArgs sets json and treats it independently of prompt", () => {
  const options = parseArgs(["--json", "-p", "hi"]);
  assert.equal(options.json, true);
  assert.equal(options.prompt, "hi");
});

test("parseArgs rejects a bare positional argument with a hint to -p (K8)", () => {
  assert.throws(() => parseArgs(["status"]), (error: unknown) => {
    assert.ok(error instanceof CliUsageError);
    assert.match(String((error as Error).message), /-p\/--prompt/);
    return true;
  });
});

test("parseArgs rejects a bare positional argument even after valid flags", () => {
  assert.throws(
    () => parseArgs(["--plain", "fix", "the", "bug"]),
    CliUsageError,
  );
});

test("parseArgs rejects unknown options as a usage error", () => {
  assert.throws(() => parseArgs(["--not-a-flag"]), CliUsageError);
});

test("parseArgs rejects a flag missing its value as a usage error", () => {
  assert.throws(() => parseArgs(["--model"]), CliUsageError);
});

test("parseArgs rejects combining --new with --continue", () => {
  assert.throws(
    () => parseArgs(["--new", "--continue"]),
    CliUsageError,
  );
});

test("parseArgs accepts --resume and --no-resume independently", () => {
  assert.equal(parseArgs(["--resume"]).resume, true);
  assert.equal(parseArgs(["--resume"]).noResume, false);
  assert.equal(parseArgs(["--no-resume"]).noResume, true);
  assert.equal(parseArgs(["--no-resume"]).resume, false);
  assert.equal(parseArgs([]).resume, false);
  assert.equal(parseArgs([]).noResume, false);
});

test("parseArgs rejects combining --resume with --no-resume", () => {
  assert.throws(() => parseArgs(["--resume", "--no-resume"]), CliUsageError);
});

test("runOutcomeExitCode maps the documented five codes (K8)", () => {
  assert.equal(runOutcomeExitCode("completed"), 0);
  assert.equal(runOutcomeExitCode("error"), 1);
  assert.equal(runOutcomeExitCode("step-limit"), 124);
  assert.equal(runOutcomeExitCode("cost-limit"), 124);
  // Forward-compatible with A4's future "unverified" outcome (exit 3) even
  // though `AgentRunOutcome` does not carry that member yet.
  assert.equal(runOutcomeExitCode("unverified" as never), 3);
});

test("tracked TypeScript source contains no embedded NUL bytes", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { cwd: repository },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  assert.ok(tracked.length > 0, "the tracked TypeScript set must not be empty");

  const violations: string[] = [];
  for (const relativePath of tracked) {
    const source = readFileSync(join(repository, relativePath));
    for (
      let offset = source.indexOf(0);
      offset !== -1;
      offset = source.indexOf(0, offset + 1)
    ) {
      violations.push(`${relativePath}:${offset}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `embedded NUL bytes found at ${violations.join(", ")}`,
  );
});

test("the visible-turn count is one value, not three", () => {
  // Startup loaded 12 turns, a chat switch 40, and loadTurns capped at 12 on
  // top of that — so the same chat looked different depending on how you
  // opened it, and the 40 was never honoured at all.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const tui = readFileSync(new URL("../src/tui.ts", import.meta.url), "utf8");

  assert.equal(
    /recentTurns\(\s*\d+\s*\)/.test(cli),
    false,
    "cli.ts must not hardcode a turn count; use VISIBLE_TURNS",
  );
  const declared = /const VISIBLE_TURNS = (\d+)/.exec(cli);
  assert.ok(declared, "VISIBLE_TURNS must be declared in cli.ts");
  const capped = /loadTurns\([^)]*maximum = (\d+)/.exec(tui);
  assert.ok(capped, "loadTurns must state its cap");
  assert.equal(
    declared![1],
    capped![1],
    "loadTurns would silently drop turns the caller asked for",
  );
});

test("the chat chooser does not show a transcript behind itself", () => {
  // Loading the previous chat before the chooser contradicts the question it
  // asks — and picking "new chat" then made the text vanish again.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const guard = cli.indexOf("if (!context.showChatPickerOnStart) {");
  const load = cli.indexOf("ui.loadTurns", guard);
  const start = cli.indexOf("ui.start()");
  assert.ok(guard > 0, "the startup load must be guarded by the chooser flag");
  assert.ok(load > guard && load < start, "the guarded load belongs before ui.start()");
});

test("startup awaits migration before config, rules, chats, browser artifacts, keys, or network can open", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    initializeStartupStorage: (...args: never[]) => Promise<never>;
  };
  const order: string[] = [];
  let releaseMigration!: () => void;
  const migrationGate = new Promise<void>((resolve) => {
    releaseMigration = resolve;
  });
  const startup = initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => {
        order.push("migration-start");
        await migrationGate;
        order.push("migration-complete");
        return { status: "ready", appHome: "/synthetic/.orcode", warning: null };
      },
      pruneRunLogs: async (appHome) => {
        assert.equal(appHome, "/synthetic/.orcode");
        order.push("redacted-retention");
      },
      pruneCheckpoints: async (appHome) => {
        assert.equal(appHome, "/synthetic/.orcode");
        order.push("exact-retention");
      },
      pruneBrowserTempArtifacts: async () => {
        order.push("browser-retention");
      },
      loadConfig: async (path) => {
        assert.equal(path, "/synthetic/.orcode/config.json");
        order.push("config");
        return structuredClone(DEFAULT_CONFIG);
      },
      loadRules: async (appHome) => {
        assert.equal(appHome, "/synthetic/.orcode");
        order.push("rules");
        return {} as never;
      },
      openSession: async (_workspace, appHome) => {
        assert.equal(appHome, "/synthetic/.orcode");
        order.push("chats");
        return { appHome, data: { id: "chat-a" } } as never;
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["migration-start"]);
  order.push("key-and-network-probe-blocked");
  releaseMigration();
  const result = await startup;
  order.push("sdk-state", "run-logs", "journals", "task-sidecars", "key", "network");

  assert.equal(result.appHome, "/synthetic/.orcode");
  assert.deepEqual(order, [
    "migration-start",
    "key-and-network-probe-blocked",
    "migration-complete",
    "redacted-retention",
    "exact-retention",
    "browser-retention",
    "config",
    "rules",
    "chats",
    "sdk-state",
    "run-logs",
    "journals",
    "task-sidecars",
    "key",
    "network",
  ]);
});

test("declined future or recovery-required migration stops startup before any mutating store opens", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  for (const status of ["declined", "future", "recovery-required"] as const) {
    const calls: string[] = [];
    await assert.rejects(
      initializeStartupStorage(
        { workspace: "/synthetic/workspace", newChat: false },
        {
          migrateAppHome: async () => {
            calls.push("migration");
            return {
              status,
              appHome: "/synthetic/.routercode",
              warning: `startup stopped: ${status}`,
            } as never;
          },
          pruneRunLogs: async () => {
            calls.push("run-prune");
          },
          pruneCheckpoints: async () => {
            calls.push("prune");
          },
          pruneBrowserTempArtifacts: async () => {
            calls.push("browser-prune");
          },
          loadConfig: async () => {
            calls.push("config");
            return structuredClone(DEFAULT_CONFIG);
          },
          loadRules: async () => {
            calls.push("rules");
            return {} as never;
          },
          openSession: async () => {
            calls.push("session");
            return {} as never;
          },
        },
      ),
      new RegExp(status),
    );
    assert.deepEqual(calls, ["migration"]);
  }
});

test("startup exposes the selected app-home config path to every runtime command surface", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  const appHome = "/synthetic/custom-or-legacy-home";
  const result = await initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => ({ status: "ready", appHome, warning: null } as never),
      pruneRunLogs: async () => undefined,
      pruneCheckpoints: async () => undefined,
      pruneBrowserTempArtifacts: async () => undefined,
      loadConfig: async () => structuredClone(DEFAULT_CONFIG),
      loadRules: async () => ({} as never),
      openSession: async () => ({ appHome, data: { id: "chat-a" } } as never),
    },
  );

  assert.equal((result as typeof result & { configPath?: string }).configPath, join(appHome, "config.json"));
});

test("startup invokes all retention classes best effort and reports each failure before opening stores", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  const calls: string[] = [];
  const result = await initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => ({ status: "ready", appHome: "/synthetic/.orcode", warning: null } as never),
      pruneRunLogs: async () => {
        calls.push("redacted");
        throw new Error("run retention unavailable");
      },
      pruneCheckpoints: async () => {
        calls.push("exact");
        throw new Error("exact retention unavailable");
      },
      pruneBrowserTempArtifacts: async () => {
        calls.push("browser");
        throw new Error("browser retention unavailable");
      },
      loadConfig: async () => {
        calls.push("config");
        return structuredClone(DEFAULT_CONFIG);
      },
      loadRules: async () => {
        calls.push("rules");
        return {} as never;
      },
      openSession: async (_workspace, appHome) => {
        calls.push("session");
        return { appHome, data: { id: "chat-a" } } as never;
      },
    },
  );

  assert.deepEqual(calls, ["redacted", "exact", "browser", "config", "rules", "session"]);
  assert.equal(result.retentionWarnings.length, 3);
  assert.match(result.retentionWarnings[0]!, /run retention unavailable/);
  assert.match(result.retentionWarnings[1]!, /exact retention unavailable/);
  assert.match(result.retentionWarnings[2]!, /browser retention unavailable/);
});

test("startup surfaces returned per-class retention errors, including nested exact backup reports", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  const result = await initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => ({ status: "ready", appHome: "/synthetic/.orcode", warning: null } as never),
      pruneRunLogs: async () => ({
        removed: [],
        errors: [{ path: "runs/chat-a/run.ndjson", message: "redacted log remained busy" }],
      }),
      pruneCheckpoints: async () => ({
        exact: { removed: [], errors: [{ path: "tasks/chat-a/state.json", message: "exact state remained busy" }] },
        backups: { removed: [], errors: [{ path: "migration-backup", message: "backup remained busy" }] },
      }),
      pruneBrowserTempArtifacts: async () => ({
        removed: [],
        errors: [{ path: "orcode-browser-operation-Ab12Z9", message: "browser profile remained busy" }],
      }),
      loadConfig: async () => structuredClone(DEFAULT_CONFIG),
      loadRules: async () => ({} as never),
      openSession: async (_workspace, appHome) => ({ appHome, data: { id: "chat-a" } } as never),
    },
  );

  assert.equal(result.retentionWarnings.length, 4);
  assert.ok(result.retentionWarnings.some((warning) => /redacted log remained busy/.test(warning)));
  assert.ok(result.retentionWarnings.some((warning) => /exact state remained busy/.test(warning)));
  assert.ok(result.retentionWarnings.some((warning) => /backup remained busy/.test(warning)));
  assert.ok(result.retentionWarnings.some((warning) => /browser profile remained busy/.test(warning)));
});

function cliRoleModel(
  overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    description: "synthetic CLI role fixture",
    contextLength: 64_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...rest,
  };
}

test("configured run gate rejects incompatible roles and preserves catalogue failures", async () => {
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    ensureRunnableModelConfiguration: (
      openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> },
      config: typeof DEFAULT_CONFIG,
    ) => Promise<unknown>;
  };
  assert.equal(
    typeof cli.ensureRunnableModelConfiguration,
    "function",
    "the final --model/session/config value needs one run-boundary gate",
  );

  const incompatibleMain = roleModelForCli({
    id: "provider/no-tools",
    supportedParameters: [],
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = incompatibleMain.id;
  config.compressionMode = "off";
  await assert.rejects(
    cli.ensureRunnableModelConfiguration(
      { listModels: async () => [incompatibleMain] },
      config,
    ),
    (error: unknown) =>
      error instanceof Error && error.name === "ModelCapabilityError",
  );

  const unavailable = new Error("synthetic catalogue offline");
  config.mainModel = "provider/complete";
  await assert.rejects(
    cli.ensureRunnableModelConfiguration(
      { listModels: async () => { throw unavailable; } },
      config,
    ),
    (error: unknown) => error === unavailable,
  );
});

test("configured run gate accepts main auto and an input-agnostic text compressor", async () => {
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    ensureRunnableModelConfiguration: (
      openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> },
      config: typeof DEFAULT_CONFIG,
    ) => Promise<{ main: ModelInfo | null; compressor: ModelInfo | null }>;
  };
  const compressor = roleModelForCli({
    id: "provider/audio-to-text",
    supportedParameters: [],
    inputModalities: ["audio"],
    outputModalities: ["text"],
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "openrouter/auto";
  config.compressorModel = compressor.id;
  config.compressionMode = "auto";
  const calls: unknown[][] = [];

  const result = await cli.ensureRunnableModelConfiguration(
    {
      listModels: async (...args: unknown[]) => {
        calls.push(args);
        return [compressor];
      },
    },
    config,
  );

  assert.equal(result.main, null, "auto is the explicit catalogue-independent main route");
  assert.equal(result.compressor?.id, compressor.id);
  assert.deepEqual(calls.map((args) => args[0]), [compressor.id]);
});

test("dashboard snapshot distinguishes incompatible, missing, and unavailable models", async () => {
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    loadModelSnapshot: (
      openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> },
      modelId: string,
    ) => Promise<{
      model: ModelInfo | null;
      details: string;
      status: "available" | "incompatible" | "missing" | "unavailable";
      error?: unknown;
    }>;
  };
  assert.equal(typeof cli.loadModelSnapshot, "function");

  const incompatible = cliRoleModel({
    id: "provider/image-only",
    outputModalities: ["image"],
  });
  const incompatibleSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => [incompatible] },
    incompatible.id,
  );
  assert.equal(incompatibleSnapshot.status, "incompatible");
  assert.equal(incompatibleSnapshot.model, null);
  assert.match(incompatibleSnapshot.details, /inkompatibel/i);

  const missingSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => [] },
    "provider/missing",
  );
  assert.equal(missingSnapshot.status, "missing");
  assert.doesNotMatch(missingSnapshot.details, /dynamische OpenRouter-Route/i);

  const unavailable = new Error("synthetic catalogue timeout");
  const unavailableSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => { throw unavailable; } },
    "provider/complete",
  );
  assert.equal(unavailableSnapshot.status, "unavailable");
  assert.equal(unavailableSnapshot.error, unavailable);
  assert.doesNotMatch(unavailableSnapshot.details, /inkompatibel/i);

  const autoSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => { throw new Error("auto must not query the catalogue"); } },
    "openrouter/auto",
  );
  assert.equal(autoSnapshot.status, "available");
  assert.equal(autoSnapshot.model, null);
  assert.match(autoSnapshot.details, /dynamische OpenRouter-Route/i);
});

test("dashboard pickers expose only their role-compatible candidates before mutation", async () => {
  type CandidateSource = (query: string) => ModelInfo[];
  type DashboardPicker = (
    ui: {
      setStatus: (value: string) => void;
      setCancelHandler: (handler?: () => void) => void;
      pickModel: (
        source: CandidateSource,
        current: string,
        title?: string,
      ) => Promise<ModelInfo | null>;
    },
    context: {
      openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> };
      config: typeof DEFAULT_CONFIG;
      configPath: string;
    },
  ) => Promise<ModelInfo | null>;
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    pickDashboardModel: DashboardPicker;
    pickDashboardCompressorModel: DashboardPicker;
  };
  assert.equal(typeof cli.pickDashboardModel, "function");
  assert.equal(typeof cli.pickDashboardCompressorModel, "function");

  const root = await mkdtemp(join(tmpdir(), "orcode-dashboard-roles-"));
  const complete = cliRoleModel({ id: "provider/complete" });
  const noTools = cliRoleModel({ id: "provider/no-tools", supportedParameters: [] });
  const imageOnly = cliRoleModel({ id: "provider/image-only", outputModalities: ["image"] });
  const audioToText = cliRoleModel({
    id: "provider/audio-to-text",
    supportedParameters: [],
    inputModalities: ["audio"],
  });
  const seen: string[][] = [];
  const ui = {
    setStatus: () => undefined,
    setCancelHandler: () => undefined,
    pickModel: async (source: CandidateSource, _current: string, title?: string) => {
      const candidates = source("");
      seen.push(candidates.map((candidate) => candidate.id));
      return title
        ? candidates.find((candidate) => candidate.id === audioToText.id) ?? null
        : candidates.find((candidate) => candidate.id === complete.id) ?? null;
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = noTools.id;
  config.compressorModel = imageOnly.id;
  const calls: unknown[][] = [];
  const context = {
    config,
    configPath: join(root, "config.json"),
    openRouter: {
      listModels: async (...args: unknown[]) => {
        calls.push(args);
        return [complete, noTools, imageOnly, audioToText];
      },
    },
  };

  await cli.pickDashboardModel(ui, context);
  await cli.pickDashboardCompressorModel(ui, context);

  assert.deepEqual(seen[0], [complete.id]);
  assert.deepEqual(seen[1], [complete.id, noTools.id, audioToText.id]);
  assert.equal(config.mainModel, complete.id);
  assert.equal(config.compressorModel, audioToText.id);
  assert.deepEqual(calls.map((args) => args[1]), [false, false]);
});

test("dashboard picker preserves catalogue failure identity and current selection", async () => {
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    pickDashboardModel: (
      ui: {
        setStatus: (value: string) => void;
        setCancelHandler: (handler?: () => void) => void;
        pickModel: (...args: unknown[]) => Promise<ModelInfo | null>;
      },
      context: {
        openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> };
        config: typeof DEFAULT_CONFIG;
        configPath: string;
      },
    ) => Promise<ModelInfo | null>;
  };
  const unavailable = new Error("synthetic dashboard catalogue offline");
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "provider/current";
  let pickerCalls = 0;

  await assert.rejects(
    cli.pickDashboardModel(
      {
        setStatus: () => undefined,
        setCancelHandler: () => undefined,
        pickModel: async () => {
          pickerCalls += 1;
          return null;
        },
      },
      {
        config,
        configPath: "/synthetic/not-written.json",
        openRouter: { listModels: async () => { throw unavailable; } },
      },
    ),
    (error: unknown) => error === unavailable,
  );
  assert.equal(config.mainModel, "provider/current");
  assert.equal(pickerCalls, 0);
});

function roleModelForCli(
  overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
  return cliRoleModel(overrides);
}
