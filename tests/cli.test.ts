import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CliUsageError,
  commandRequiresRunnableRoute,
  createCliPlainSetupSurface,
  createOpenRouterServiceForStartup,
  executeProviderModelAction,
  homeWorkspaceWarning,
  initializeDashboardKey,
  parseArgs,
  readPackageVersion,
  renderCliBanner,
  renderCliHelp,
  resolveCliCommandName,
  runOutcomeExitCode,
} from "../src/cli.js";
import * as cliModule from "../src/cli.js";
import { createPlainSetupSurface } from "../src/setup-ui.js";
import { COMMAND_CATALOG } from "../src/command-catalog.js";
import { shouldReplaceCredential } from "../src/commands.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import { createPanelCall, OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import { askPanel } from "../src/panel.js";
import * as panelModule from "../src/panel.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { CredentialStore } from "../src/credentials.js";
import type { CredentialSlotRef, CredentialStoreLike } from "../src/credentials.js";
import {
  ProviderStateStore,
  type ProviderSetupStateV1,
  type ProviderStateCommitRequest,
} from "../src/provider-state.js";
import { PrivateStore } from "../src/private-store.js";
import type { ModelInfo } from "../src/types.js";

type BootstrapRuntimeDouble = {
  inspectStartup(): Promise<Record<string, unknown>>;
  resolveLegacyDefaultRoute(): Promise<Record<string, unknown>>;
  runSetup(transport: "plain" | "fullscreen"): Promise<Record<string, unknown>>;
  ensureRunnableRoute(): Record<string, unknown>;
  openRouter: OpenRouterService;
  credentials: CredentialStore;
  preparedRoles?: unknown;
};

function bootstrapRoute(model = "vendor/main"): Record<string, unknown> {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_bootstrap_fixture",
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  };
}

function bootstrapStorage() {
  const config = structuredClone(DEFAULT_CONFIG);
  return {
    appHome: "/synthetic/.orcode",
    configPath: "/synthetic/.orcode/config.json",
    migrationWarning: null,
    retentionWarnings: [],
    config,
    ruleStore: {} as never,
    session: {
      appHome: "/synthetic/.orcode",
      data: { id: "00000000-0000-4000-8000-000000000001", model: null, reasoning: null },
      setPreferences: () => undefined,
    } as never,
  };
}

function bootstrapRuntime(options: {
  mode?: "ready" | "ready-with-warning" | "route-choice-required" | "setup-required";
  route?: Record<string, unknown> | null;
  setup?: Record<string, unknown>;
  events?: string[];
} = {}): BootstrapRuntimeDouble {
  const events = options.events ?? [];
  const route = options.route === undefined ? bootstrapRoute() : options.route;
  const mode = options.mode ?? "ready";
  return {
    openRouter: new OpenRouterService(undefined),
    credentials: {} as CredentialStore,
    async inspectStartup() {
      events.push("provider:inspect");
      return {
        mode,
        generation: 1,
        defaultRoute: route,
        readyRoutes: route ? [route] : [],
        warnings: [],
        crossEnabled: false,
      };
    },
    async resolveLegacyDefaultRoute() {
      events.push("provider:legacy");
      return {
        mode: "ready",
        generation: 1,
        defaultRoute: route,
        readyRoutes: route ? [route] : [],
        warnings: [],
        crossEnabled: false,
      };
    },
    async runSetup(transport) {
      events.push(`provider:setup:${transport}`);
      return options.setup ?? { kind: "ready" };
    },
    ensureRunnableRoute() {
      events.push("provider:ensure");
      if (!route) {
        const error = new Error("Provider setup is required") as Error & { code: string; exitCode: number };
        error.code = "provider-setup-required";
        error.exitCode = 1;
        throw error;
      }
      return route;
    },
  };
}

async function invokeRunCli(argv: readonly string[], deps: Record<string, unknown>): Promise<number> {
  const candidate = (cliModule as typeof cliModule & {
    runCli?: (args: readonly string[], dependencies: Record<string, unknown>) => Promise<number>;
  }).runCli;
  assert.equal(typeof candidate, "function", "runCli must be exported as the injectable bootstrap boundary");
  return candidate(argv, deps);
}

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

test("runCli help and version return before every startup and model side effect", async () => {
  for (const flag of ["--help", "--version"] as const) {
    const calls: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await invokeRunCli([flag], {
      initializeStorage: async () => { calls.push("storage"); return bootstrapStorage(); },
      createProviderRuntime: async () => { calls.push("provider-runtime"); return bootstrapRuntime(); },
      createAgent: async () => { calls.push("agent"); return {} as never; },
      runPlain: async () => { calls.push("plain"); },
      runDashboard: async () => { calls.push("dashboard"); },
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, []);
    assert.equal(stderr.length, 0);
    assert.match(stdout.join(""), flag === "--help" ? /Usage|Verwendung|Optionen/i : /orcode 0\.4\.1/);
  }
});

test("runCli orders storage, activation recovery, bounded inspection, route proof, agent, and plain UI", async () => {
  const calls: string[] = [];
  const runtime = bootstrapRuntime({ events: calls });
  const exitCode = await invokeRunCli(["--plain"], {
    initializeStorage: async () => { calls.push("storage"); return bootstrapStorage(); },
    createProviderRuntime: async () => { calls.push("provider:load+recover"); return runtime; },
    createAgent: async () => { calls.push("agent:create"); return {} as never; },
    runPlain: async (input: { providerRuntime: unknown; agent: unknown }) => {
      calls.push("plain");
      assert.equal(input.providerRuntime, runtime);
      assert.ok(input.agent);
    },
    runDashboard: async () => { calls.push("dashboard"); },
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "storage",
    "provider:load+recover",
    "provider:inspect",
    "provider:ensure",
    "agent:create",
    "plain",
  ]);
});

test("runCli opens route choice for a healthy secondary and never silently replaces the degraded default", async () => {
  const calls: string[] = [];
  const runtime = bootstrapRuntime({
    mode: "route-choice-required",
    route: null,
    setup: { kind: "cancelled", mode: "setup-required" },
    events: calls,
  });
  let plainInput: { agent: unknown; providerRuntime: unknown } | null = null;
  const exitCode = await invokeRunCli(["--plain"], {
    initializeStorage: async () => bootstrapStorage(),
    createProviderRuntime: async () => runtime,
    createAgent: async () => { calls.push("agent:create"); return {} as never; },
    runPlain: async (input: { agent: unknown; providerRuntime: unknown }) => {
      plainInput = input;
      calls.push("plain");
    },
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  const capturedPlain = plainInput as unknown as { agent: unknown; providerRuntime: unknown };
  assert.equal(capturedPlain.agent, null);
  assert.equal(capturedPlain.providerRuntime, runtime);
  assert.deepEqual(calls, ["provider:inspect", "provider:setup:plain", "plain"]);
});

test("a healthy saved route cannot dispatch a different --model without an explicit route transition", async () => {
  const calls: string[] = [];
  const runtime = bootstrapRuntime({ route: bootstrapRoute("vendor/a"), events: calls });
  runtime.openRouter.listModels = async () => [roleModelForCli({ id: "vendor/b" })];
  runtime.runSetup = async (transport) => {
    calls.push(`provider:setup:${transport}`);
    return { kind: "cancelled", mode: "setup-required" };
  };
  let plainAgent: unknown = undefined;

  const exitCode = await invokeRunCli(["--plain", "--model", "vendor/b"], {
    initializeStorage: async () => {
      const storage = bootstrapStorage();
      storage.config.mainModel = "vendor/a";
      return storage;
    },
    createProviderRuntime: async () => runtime,
    createAgent: async () => {
      calls.push("agent:create");
      return {} as never;
    },
    runPlain: async (input: { agent: unknown }) => {
      plainAgent = input.agent;
      calls.push("plain");
    },
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.equal(plainAgent, null);
  assert.deepEqual(calls, [
    "provider:inspect",
    "provider:ensure",
    "provider:setup:plain",
    "plain",
  ]);
});

test("a setup-selected route becomes the authoritative main model before agent creation", async () => {
  const calls: string[] = [];
  let currentRoute: Record<string, unknown> | null = null;
  const selectedRoute = bootstrapRoute("vendor/b");
  const runtime = bootstrapRuntime({ mode: "setup-required", route: null, events: calls });
  runtime.runSetup = async (transport) => {
    calls.push(`provider:setup:${transport}`);
    currentRoute = selectedRoute;
    return { kind: "ready" };
  };
  runtime.ensureRunnableRoute = () => {
    calls.push("provider:ensure");
    if (!currentRoute) throw Object.assign(new Error("setup"), { code: "provider-setup-required" });
    return currentRoute;
  };
  let createdModel: string | null = null;

  await invokeRunCli(["--plain"], {
    initializeStorage: async () => {
      const storage = bootstrapStorage();
      storage.config.mainModel = "vendor/a";
      return storage;
    },
    createProviderRuntime: async () => runtime,
    createAgent: async (input: { config: { mainModel: string } }) => {
      createdModel = input.config.mainModel;
      calls.push("agent:create");
      return {} as never;
    },
    runPlain: async () => calls.push("plain"),
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(createdModel, "vendor/b");
  assert.deepEqual(calls, [
    "provider:inspect",
    "provider:setup:plain",
    "provider:ensure",
    "agent:create",
    "plain",
  ]);
});

test("dashboard model selection proves the new route before persisting the selected model", async () => {
  const pickDashboardModel = (cliModule as typeof cliModule & {
    pickDashboardModel?: (ui: Record<string, unknown>, context: Record<string, unknown>) => Promise<ModelInfo | null>;
  }).pickDashboardModel;
  assert.equal(typeof pickDashboardModel, "function");
  const directory = await mkdtemp(join(tmpdir(), "orcode-dashboard-route-transition-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "vendor/a";
  const model = roleModelForCli({ id: "vendor/b" });
  const transitions: string[] = [];
  const context = {
    config,
    configPath: join(directory, "config.json"),
    openRouter: {
      async listModels() { return [model]; },
    },
    providerRuntime: {
      async transitionModel(modelId: string) {
        assert.equal(config.mainModel, "vendor/a");
        transitions.push(modelId);
      },
    },
  };
  const selected = await pickDashboardModel!(
    {
      setStatus() {},
      setCancelHandler() {},
      async pickModel() { return model; },
    },
    context,
  );

  assert.equal(selected?.id, "vendor/b");
  assert.deepEqual(transitions, ["vendor/b"]);
  assert.equal(config.mainModel, "vendor/b");
  assert.equal(JSON.parse(await readFile(context.configPath, "utf8")).mainModel, "vendor/b");
});

test("dashboard model catalog authentication rejection releases the action lease and opens shared setup before picker or activation", async () => {
  const pickDashboardModel = (cliModule as typeof cliModule & {
    pickDashboardModel?: (
      ui: Record<string, unknown>,
      context: Record<string, unknown>,
      surface?: unknown,
    ) => Promise<ModelInfo | null>;
  }).pickDashboardModel;
  assert.equal(typeof pickDashboardModel, "function");
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "vendor/a";
  const configBefore = structuredClone(config);
  const calls: string[] = [];
  const rejected = new OpenRouterHttpError(401, "raw private dashboard catalog response");
  const runtime = {
    async runModelCatalog<T>(run: () => Promise<T>, surface?: unknown): Promise<T> {
      assert.equal(surface, "dashboard-setup-surface");
      return executeProviderModelAction({
        ensureRunnableRoute() {
          calls.push("route:ensure");
          return bootstrapRoute("vendor/a") as never;
        },
        beginRun() {
          calls.push("run:begin");
          return () => calls.push("run:release");
        },
        run,
        isAuthenticationFailure: (error) => error === rejected,
        async invalidateAndInspect() { calls.push("route:invalidate+inspect"); },
        async runSetup() {
          calls.push("setup:dashboard");
          return { kind: "cancelled" };
        },
        surface: "fullscreen",
      });
    },
    async transitionModel() {
      calls.push("activation");
    },
  };

  await assert.rejects(
    pickDashboardModel!(
      {
        setStatus() {},
        setCancelHandler() {},
        async pickModel() {
          calls.push("picker");
          return null;
        },
      },
      {
        config,
        configPath: "/synthetic/must-not-write.json",
        openRouter: {
          async listModels() {
            calls.push("catalog");
            throw rejected;
          },
        },
        providerRuntime: runtime,
      },
      "dashboard-setup-surface",
    ),
    (error) => error === rejected,
  );

  assert.deepEqual(calls, [
    "route:ensure",
    "run:begin",
    "catalog",
    "run:release",
    "route:invalidate+inspect",
    "setup:dashboard",
  ]);
  assert.deepEqual(config, configBefore);
});

test("plain setup cancellation keeps commands alive and the next model input reopens setup before agent creation", async () => {
  const calls: string[] = [];
  let setupCalls = 0;
  let ready = false;
  const route = bootstrapRoute();
  const runtime = bootstrapRuntime({ mode: "setup-required", route: null, events: calls });
  runtime.runSetup = async () => {
    setupCalls += 1;
    calls.push("provider:setup:plain");
    if (setupCalls === 1) return { kind: "cancelled", mode: "setup-required" };
    ready = true;
    return { kind: "ready" };
  };
  runtime.ensureRunnableRoute = () => {
    calls.push("provider:ensure");
    if (!ready) throw Object.assign(new Error("setup"), { code: "provider-setup-required", exitCode: 1 });
    return route;
  };

  const exitCode = await invokeRunCli(["--plain"], {
    initializeStorage: async () => bootstrapStorage(),
    createProviderRuntime: async () => runtime,
    createAgent: async () => { calls.push("agent:create"); return {} as never; },
    runPlain: async (input: { agent: unknown; ensureAgentForPrompt(): Promise<unknown> }) => {
      calls.push("command:/help");
      assert.equal(input.agent, null);
      assert.ok(await input.ensureAgentForPrompt());
      calls.push("prompt:queued");
    },
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "provider:inspect",
    "provider:setup:plain",
    "command:/help",
    "provider:ensure",
    "provider:setup:plain",
    "provider:ensure",
    "agent:create",
    "prompt:queued",
  ]);
});

test("model-dependent slash commands recheck the route while local command variants stay available", () => {
  assert.equal(commandRequiresRunnableRoute("model", []), true);
  assert.equal(commandRequiresRunnableRoute("models", ["coder"]), true);
  assert.equal(commandRequiresRunnableRoute("think", ["high"]), true);
  assert.equal(commandRequiresRunnableRoute("compress", ["model", "vendor/small"]), true);
  assert.equal(commandRequiresRunnableRoute("fallback", ["+vendor/backup"]), true);
  assert.equal(commandRequiresRunnableRoute("panel", ["compare", "these"]), true);
  assert.equal(commandRequiresRunnableRoute("panel", ["models", "vendor/a,vendor/b"]), true);
  assert.equal(commandRequiresRunnableRoute("whisper", [], "dashboard"), true);

  assert.equal(commandRequiresRunnableRoute("help", []), false);
  assert.equal(commandRequiresRunnableRoute("status", []), false);
  assert.equal(commandRequiresRunnableRoute("compress", ["threshold", "8000"]), false);
  assert.equal(commandRequiresRunnableRoute("fallback", ["clear"]), false);
  assert.equal(commandRequiresRunnableRoute("panel", []), false);
  assert.equal(commandRequiresRunnableRoute("panel", ["show", "1"]), false);
  assert.equal(commandRequiresRunnableRoute("panel", ["judge", "off"]), false);
  assert.equal(commandRequiresRunnableRoute("whisper", [], "plain"), false);
});

test("fullscreen model authentication failure invalidates proof and opens shared setup before later model work", async () => {
  const execute = (cliModule as typeof cliModule & {
    executeProviderModelAction?: <T>(input: {
      ensureRunnableRoute(): Record<string, unknown>;
      beginRun(): () => void;
      run(route: Record<string, unknown>): Promise<T>;
      isAuthenticationFailure(error: unknown): boolean;
      invalidateAndInspect(): Promise<void>;
      runSetup(surface: "fullscreen"): Promise<Record<string, unknown>>;
      surface: "fullscreen";
    }) => Promise<T>;
  }).executeProviderModelAction;
  assert.equal(typeof execute, "function");

  const calls: string[] = [];
  const rejected = Object.assign(new Error("synthetic secret provider body"), { status: 401 });
  await assert.rejects(
    execute!({
      ensureRunnableRoute() {
        calls.push("route:ensure");
        return bootstrapRoute("vendor/a");
      },
      beginRun() {
        calls.push("run:begin");
        return () => calls.push("run:release");
      },
      async run() {
        calls.push("model:first-byte-attempt");
        throw rejected;
      },
      isAuthenticationFailure: (error) => error === rejected,
      async invalidateAndInspect() {
        calls.push("route:invalidate+inspect");
      },
      async runSetup(surface) {
        calls.push(`setup:${surface}`);
        return { kind: "cancelled", mode: "setup-required" };
      },
      surface: "fullscreen",
    }),
    (error: unknown) => error === rejected,
  );

  assert.deepEqual(calls, [
    "route:ensure",
    "run:begin",
    "model:first-byte-attempt",
    "run:release",
    "route:invalidate+inspect",
    "setup:fullscreen",
  ]);
});

test("a real panel authentication rejection settles every call then reaches shared route invalidation and setup without raw leakage", async () => {
  const execute = (cliModule as typeof cliModule & {
    executeProviderModelAction?: <T>(input: Record<string, unknown>) => Promise<T>;
  }).executeProviderModelAction;
  const AuthenticationError = (panelModule as typeof panelModule & {
    PanelAuthenticationRejectedError?: new (...args: never[]) => Error;
  }).PanelAuthenticationRejectedError;
  assert.equal(typeof execute, "function");
  assert.equal(typeof AuthenticationError, "function");
  const calls: string[] = [];
  const rawProviderBody = "synthetic private provider response body";
  const service = {
    runtimeState: { inferenceValidity: "rejected" },
    client() {
      calls.push("panel:model-call");
      throw new OpenRouterHttpError(401, rawProviderBody);
    },
    safeMessage() {
      return "fixed-safe-auth-error";
    },
  } as unknown as OpenRouterService;

  await assert.rejects(
    execute!({
      ensureRunnableRoute() {
        calls.push("route:ensure");
        return bootstrapRoute("vendor/a");
      },
      beginRun() {
        calls.push("run:begin");
        return () => calls.push("run:release");
      },
      async run() {
        return askPanel({
          question: "same question",
          models: ["vendor/a", "vendor/b"],
          callModel: createPanelCall(service),
        });
      },
      isAuthenticationFailure(error: unknown) {
        return error instanceof AuthenticationError!;
      },
      async invalidateAndInspect() {
        calls.push("route:invalidate+inspect");
      },
      async runSetup() {
        calls.push("setup:fullscreen");
        return { kind: "cancelled" };
      },
      surface: "fullscreen",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthenticationError!);
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /synthetic private|provider response/i);
      return true;
    },
  );

  assert.deepEqual(calls, [
    "route:ensure",
    "run:begin",
    "panel:model-call",
    "panel:model-call",
    "run:release",
    "route:invalidate+inspect",
    "setup:fullscreen",
  ]);
});

test("mixed delayed panel results recover from the request-local 401 even after a later success restores global validity", async () => {
  const AuthenticationError = (panelModule as typeof panelModule & {
    PanelAuthenticationRejectedError?: new (...args: never[]) => Error & {
      partialResult?: { answers: Array<{ model: string; text: string; error: string | null }> };
    };
  }).PanelAuthenticationRejectedError;
  assert.equal(typeof AuthenticationError, "function");
  const calls: string[] = [];
  let inferenceValidity: "unknown" | "valid" | "rejected" = "unknown";
  const raw401 = "raw private panel 401 response";
  const raw500 = "raw private panel 500 response";
  const service = {
    get runtimeState() {
      return { inferenceValidity };
    },
    client() {
      return {
        callModel(request: { model: string }) {
          return {
            async getText() {
              if (request.model === "vendor/auth") {
                calls.push("panel:auth-settled");
                inferenceValidity = "rejected";
                throw new OpenRouterHttpError(401, raw401);
              }
              if (request.model === "vendor/success") {
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
                calls.push("panel:success-settled");
                inferenceValidity = "valid";
                return "successful answer";
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              calls.push("panel:ordinary-failure-settled");
              throw new OpenRouterHttpError(500, raw500);
            },
            async getResponse() {
              return { usage: { cost: 0.002, inputTokens: 3, outputTokens: 4 } };
            },
          };
        },
      };
    },
    safeMessage(error: unknown) {
      return error instanceof OpenRouterHttpError && error.status === 500
        ? "fixed safe panel provider failure"
        : "fixed safe panel authentication failure";
    },
  } as unknown as OpenRouterService;
  let caught: InstanceType<NonNullable<typeof AuthenticationError>> | null = null;

  await assert.rejects(
    executeProviderModelAction({
      ensureRunnableRoute() {
        calls.push("route:ensure");
        return bootstrapRoute("vendor/auth") as never;
      },
      beginRun() {
        calls.push("run:begin");
        return () => calls.push("run:release");
      },
      run: () => askPanel({
        question: "same question",
        models: ["vendor/auth", "vendor/success", "vendor/ordinary"],
        callModel: createPanelCall(service),
      }),
      isAuthenticationFailure: (error) => shouldReplaceCredential(error, service),
      async invalidateAndInspect() { calls.push("route:invalidate+inspect"); },
      async runSetup() {
        calls.push("setup:fullscreen");
        return { kind: "cancelled" };
      },
      surface: "fullscreen",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthenticationError!);
      caught = error;
      return true;
    },
  );

  assert.equal(inferenceValidity, "valid");
  assert.equal(calls.filter((entry) => entry === "route:invalidate+inspect").length, 1);
  assert.equal(calls.filter((entry) => entry === "setup:fullscreen").length, 1);
  assert.ok(calls.indexOf("panel:success-settled") < calls.indexOf("run:release"));
  assert.ok(calls.indexOf("panel:ordinary-failure-settled") < calls.indexOf("run:release"));
  assert.ok(calls.indexOf("run:release") < calls.indexOf("route:invalidate+inspect"));
  const answers = caught!.partialResult!.answers;
  assert.equal(answers.find((answer) => answer.model === "vendor/success")?.text, "successful answer");
  assert.equal(
    answers.find((answer) => answer.model === "vendor/ordinary")?.error,
    "fixed safe panel provider failure",
  );
  assert.doesNotMatch(JSON.stringify(caught), /raw private|panel 401|panel 500/i);
});

test("real SDK panel requests preserve a request-local 401 marker across later success, ordinary 500, and cancellation", async (t) => {
  const AuthenticationError = (panelModule as typeof panelModule & {
    PanelAuthenticationRejectedError: new (...args: never[]) => Error & {
      partialResult?: { answers: Array<{ model: string; text: string; error: string | null }> };
    };
  }).PanelAuthenticationRejectedError;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let nowOffset = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });
  Date.now = () => originalNow() + nowOffset;
  const raw401 = "raw sdk private 401 response bytes";
  const raw500 = "raw sdk private 500 response bytes";
  const requests: string[] = [];
  let cancelStartedResolve!: () => void;
  const cancelStarted = new Promise<void>((resolve) => { cancelStartedResolve = resolve; });

  const responseBody = (model: string, text: string) => ({
    completed_at: 1,
    created_at: 1,
    error: null,
    frequency_penalty: null,
    id: `response-${model}`,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    object: "response",
    output: [{
      content: [{ annotations: [], text, type: "output_text" }],
      id: `message-${model}`,
      role: "assistant",
      status: "completed",
      type: "message",
    }],
    parallel_tool_calls: false,
    presence_penalty: null,
    status: "completed",
    temperature: null,
    tool_choice: "none",
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7,
      cost: 0.002,
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.clone().text()) as { model: string };
    requests.push(body.model);
    if (body.model === "vendor/auth") {
      return new Response(JSON.stringify({ error: { code: 401, message: raw401 } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.model === "vendor/ordinary") {
      // Finish the SDK's configured 5xx retry window immediately. The real
      // response and real SDK parser still own the failure classification.
      nowOffset = 31_000;
      return new Response(JSON.stringify({ error: { code: 500, message: raw500 } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.model === "vendor/cancel") {
      cancelStartedResolve();
      return new Promise<Response>((_resolve, reject) => {
        const rejectCancelled = () => reject(
          request.signal.reason ?? new DOMException("cancelled", "AbortError"),
        );
        if (request.signal.aborted) rejectCancelled();
        else request.signal.addEventListener("abort", rejectCancelled, { once: true });
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify(responseBody(body.model, "successful real SDK answer")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const service = new OpenRouterService(`${STARTUP_KEY_PREFIX}${"s".repeat(48)}`);
  const callPanelModel = createPanelCall(service);
  const calls: string[] = [];
  const panelAction = executeProviderModelAction({
    ensureRunnableRoute() {
      calls.push("route:ensure");
      return bootstrapRoute("vendor/auth") as never;
    },
    beginRun() {
      calls.push("run:begin");
      return () => calls.push("run:release");
    },
    run: () => askPanel({
      question: "same real SDK question",
      models: ["vendor/auth", "vendor/success", "vendor/ordinary"],
      callModel: callPanelModel,
    }),
    isAuthenticationFailure: (error) => shouldReplaceCredential(error, service),
    async invalidateAndInspect() { calls.push("route:invalidate+inspect"); },
    async runSetup() {
      calls.push("setup:fullscreen");
      return { kind: "cancelled" };
    },
    surface: "fullscreen",
  });
  const cancelController = new AbortController();
  const cancelledCall = callPanelModel({
    model: "vendor/cancel",
    question: "cancel this request",
    signal: cancelController.signal,
  });
  await cancelStarted;
  cancelController.abort(new DOMException("caller cancelled", "AbortError"));

  const [panelSettled, cancellationSettled] = await Promise.allSettled([
    panelAction,
    cancelledCall,
  ]);

  assert.equal(panelSettled.status, "rejected");
  assert.ok(panelSettled.status === "rejected" && panelSettled.reason instanceof AuthenticationError);
  assert.equal(cancellationSettled.status, "rejected");
  assert.ok(
    cancellationSettled.status === "rejected"
    && !(cancellationSettled.reason instanceof AuthenticationError),
  );
  assert.equal(service.runtimeState.inferenceValidity, "valid");
  assert.equal(calls.filter((entry) => entry === "route:invalidate+inspect").length, 1);
  assert.equal(calls.filter((entry) => entry === "setup:fullscreen").length, 1);
  const partial = panelSettled.status === "rejected"
    ? (panelSettled.reason as InstanceType<typeof AuthenticationError>).partialResult
    : undefined;
  assert.equal(
    partial?.answers.find((answer) => answer.model === "vendor/success")?.text,
    "successful real SDK answer",
  );
  assert.notEqual(
    partial?.answers.find((answer) => answer.model === "vendor/ordinary")?.error,
    null,
  );
  assert.ok(requests.includes("vendor/cancel"));

  await executeProviderModelAction({
    ensureRunnableRoute: () => bootstrapRoute("vendor/later") as never,
    beginRun: () => () => undefined,
    async run() {
      calls.push("later:model-action");
      return "later-ok";
    },
    isAuthenticationFailure: () => false,
    async invalidateAndInspect() { calls.push("unexpected:recovery"); },
    async runSetup() { return { kind: "ready" }; },
  });
  assert.ok(calls.indexOf("setup:fullscreen") < calls.indexOf("later:model-action"));
  assert.doesNotMatch(
    `${JSON.stringify(partial)} ${String(panelSettled.status === "rejected" ? panelSettled.reason : "")}`,
    /raw sdk private|response bytes/i,
  );
});

test("voice transcription executes inside the shared provider action and lets 401 recovery finish first", async () => {
  const transcribeAndInsert = (cliModule as typeof cliModule & {
    transcribeAndInsert?: (
      ui: {
        setStatus(value: string): void;
        addMessage(level: string, text: string, label?: string): void;
        insertInputText(text: string): void;
      },
      context: Record<string, unknown>,
      audio: { path: string; format: "wav"; sizeBytes: number; durationMs: number; quiet: boolean },
      dependencies: { transcribe(): Promise<{ text: string; costUsd: number; model: string }> },
    ) => Promise<void>;
  }).transcribeAndInsert;
  assert.equal(typeof transcribeAndInsert, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-voice-provider-gate-"));
  const audioPath = join(directory, "voice.wav");
  await writeFile(audioPath, "synthetic audio");
  const calls: string[] = [];
  const rejected = Object.assign(new Error("synthetic provider body"), { status: 401 });
  const providerRuntime = {
    async runWithReadyRoute<T>(run: () => Promise<T>) {
      calls.push("runtime:enter");
      try {
        return await run();
      } catch (error) {
        calls.push("runtime:recover-auth");
        throw error;
      }
    },
  };

  await transcribeAndInsert!(
    {
      setStatus: () => calls.push("voice:status"),
      addMessage: (_level, text) => calls.push(`voice:message:${text.includes("Transkription fehlgeschlagen")}`),
      insertInputText: () => calls.push("voice:insert"),
    },
    {
      providerRuntime,
      openRouter: { safeMessage: () => "fixed-safe-auth-error" },
      config: { transcriptionModel: "vendor/audio" },
      session: { addCost: () => undefined, save: async () => undefined },
    },
    { path: audioPath, format: "wav", sizeBytes: 15, durationMs: 100, quiet: false },
    { transcribe: async () => { calls.push("voice:model-call"); throw rejected; } },
  );

  assert.deepEqual(calls, [
    "voice:status",
    "runtime:enter",
    "voice:model-call",
    "runtime:recover-auth",
    "voice:message:true",
  ]);
});

test("fullscreen Escape from setup enters the dashboard in setup-required without agent or run artifacts", async () => {
  const calls: string[] = [];
  const runtime = bootstrapRuntime({
    mode: "setup-required",
    route: null,
    setup: { kind: "cancelled", mode: "setup-required" },
    events: calls,
  });
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    const exitCode = await invokeRunCli([], {
      initializeStorage: async () => bootstrapStorage(),
      createProviderRuntime: async () => runtime,
      createAgent: async () => { calls.push("agent:create"); return {} as never; },
      runPlain: async () => { calls.push("plain"); },
      runDashboard: async (input: { providerRuntime: BootstrapRuntimeDouble; agent: unknown }) => {
        await input.providerRuntime.runSetup("fullscreen");
        calls.push("dashboard");
        assert.equal(input.providerRuntime, runtime);
        assert.equal(input.agent, null);
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    assert.equal(exitCode, 0);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
  assert.deepEqual(calls, ["provider:inspect", "provider:setup:fullscreen", "dashboard"]);
});

test("-p stays noninteractive on a TTY and renders one safe typed provider failure", async () => {
  const stderr: string[] = [];
  const calls: string[] = [];
  const runtime = bootstrapRuntime({ mode: "setup-required", route: null, events: calls });
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    const exitCode = await invokeRunCli(["-p", "hello"], {
      initializeStorage: async () => bootstrapStorage(),
      createProviderRuntime: async () => runtime,
      createAgent: async () => { throw new Error("agent must stay gated"); },
      runPlain: async () => { throw new Error("prompt must not be called"); },
      runDashboard: async () => { throw new Error("dashboard must not be called"); },
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
    });
    assert.equal(exitCode, 1);
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
  }
  assert.equal(stderr.length, 1);
  assert.deepEqual(calls, ["provider:inspect", "provider:ensure"]);
  assert.match(stderr[0] ?? "", /provider-setup-required.*\/provider setup/i);
  assert.doesNotMatch(stderr[0] ?? "", /sk-|credential|account|\/Users\//i);
});

test("--json emits exactly one safe provider-setup-required record and no prompt", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const runtime = bootstrapRuntime({ mode: "setup-required", route: null, events: calls });
  const exitCode = await invokeRunCli(["--json", "-p", "hello"], {
    initializeStorage: async () => bootstrapStorage(),
    createProviderRuntime: async () => runtime,
    createAgent: async () => { throw new Error("agent must stay gated"); },
    runPlain: async () => { throw new Error("prompt must not be called"); },
    runDashboard: async () => { throw new Error("dashboard must not be called"); },
    stdout: { write: (value: string) => { stdout.push(value); return true; } },
    stderr: { write: (value: string) => { stderr.push(value); return true; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 0);
  assert.deepEqual(calls, ["provider:inspect", "provider:ensure"]);
  assert.deepEqual(JSON.parse(stdout[0] ?? "{}"), {
    type: "error",
    code: "provider-setup-required",
    headline: "setup-required",
    retryable: true,
    hint: "/provider setup",
  });
});

test("a valid no-saved-key process-only route reaches a noninteractive run without prompting or persistence", async () => {
  const calls: string[] = [];
  const runtime = bootstrapRuntime({ events: calls });
  const storage = bootstrapStorage();
  const key = `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`;
  const agent = {
    async run(prompt: string) {
      calls.push(`agent:run:${prompt}`);
      return {
        text: "ok",
        suggestions: [],
        outcome: "completed",
        costUsd: 0,
        mainCostUsd: 0,
        compressorCostUsd: 0,
        compression: { compressed: false, reason: "disabled", inputCharacters: 0, outputCharacters: 0, costUsd: 0 },
        selectedModel: "vendor/main",
        resolvedModel: "vendor/main",
        notices: [],
        partial: false,
        modelSteps: 1,
      };
    },
  };
  const exitCode = await invokeRunCli(["-p", "hello"], {
    initializeStorage: async () => storage,
    createProviderRuntime: async (input: { environment: Record<string, string | undefined> }) => {
      calls.push(`runtime:env:${input.environment.OPENROUTER_API_KEY === key}`);
      return runtime;
    },
    createAgent: async () => { calls.push("agent:create"); return agent; },
    runPlain: async () => { throw new Error("interactive prompt must not run"); },
    runDashboard: async () => { throw new Error("dashboard must not run"); },
    stdout: { write: () => true },
    stderr: { write: () => true },
    environment: { OPENROUTER_API_KEY: key },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "runtime:env:true",
    "provider:inspect",
    "provider:ensure",
    "provider:ensure",
    "agent:create",
    "provider:ensure",
    "agent:run:hello",
  ]);
});

test("automatic environment setup selects only one exact compatible configured route and never prompts", async () => {
  const createSurface = (cliModule as typeof cliModule & {
    createAutomaticEnvironmentSetupSurface?: (model: string) => {
      chooseHub(entries: Array<{ id: string }>): Promise<string | null>;
      chooseModel(request: { models: Array<Record<string, unknown>> }): Promise<string | null>;
      readSecret(request: { backendId: "openrouter"; message: string }): Promise<string | null>;
      confirm(request: { id: string; message: string; defaultValue: boolean }): Promise<boolean>;
    };
  }).createAutomaticEnvironmentSetupSurface;
  assert.equal(typeof createSurface, "function");
  const surface = createSurface("vendor/exact");
  const compatible = {
    backendId: "openrouter" as const,
    requestedModelId: "vendor/exact",
    canonicalModelId: "vendor/exact-canonical",
    displayName: "Exact",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const aliasOnly = { ...compatible, requestedModelId: "vendor/alias", canonicalModelId: "vendor/exact" };

  assert.equal(await surface.chooseModel({ backendId: "openrouter", models: [compatible, aliasOnly] }), "vendor/exact-canonical");
  assert.equal(await surface.chooseModel({ backendId: "openrouter", models: [aliasOnly] }), null);
  const hubEntry = (id: string) => ({ id, label: id, description: id, disabled: false, current: false, generation: 1 });
  assert.equal(await surface.chooseHub([hubEntry("cross-prepare"), hubEntry("cross-later")]), "cross-later");
  assert.equal(await surface.readSecret({ backendId: "openrouter", message: "forbidden" }), null);
  assert.equal(await surface.confirm({ id: "forbidden", message: "forbidden", defaultValue: true }), false);
});

test("banner, help, and version derive from the same package metadata", () => {
  const version = readPackageVersion();
  assert.equal(version, "0.4.1");
  assert.match(renderCliBanner("/tmp/workspace", "provider/model"), new RegExp(`orcode ${version}`));
  assert.match(renderCliHelp(), new RegExp(`orcode ${version}`));
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /orcode 0\.3/);
});

test("CLI help states only the implemented Windows and override shell contract", () => {
  const help = renderCliHelp();
  assert.match(help, /Windows.*powershell\.exe.*-NoProfile.*-NonInteractive.*-Command/is);
  assert.match(help, /ORCODE_SHELL/);
  assert.match(help, /ROUTERCODE_SHELL.*Kompatibilit/i);
  assert.doesNotMatch(help, /Windows.*\/bin\/sh/is);
});

test("dashboard pre-dispatch uses exact catalog aliases and preserves unknown tokens", () => {
  for (const command of COMMAND_CATALOG) {
    assert.equal(resolveCliCommandName(`/${command.name}`), command.handlerId);
    for (const alias of "aliases" in command ? command.aliases : []) {
      assert.equal(resolveCliCommandName(`/${alias} fixture`), command.handlerId, alias);
    }
  }
  assert.equal(resolveCliCommandName("  /ApPrOvAl allow-all"), "allow");
  assert.equal(resolveCliCommandName("/permissions allow-all"), "allow");
  assert.equal(resolveCliCommandName("/compressor MODEL"), "compress");
  assert.equal(resolveCliCommandName('/attach "/tmp/image with spaces.png"'), "image");
  assert.equal(resolveCliCommandName("/?"), "help");
  assert.equal(resolveCliCommandName("/q"), "quit");
  assert.equal(resolveCliCommandName("/"), "");
  assert.equal(resolveCliCommandName("/att clear"), "att");
  assert.equal(resolveCliCommandName("/UNKNOWN"), "unknown");
});

const STARTUP_KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

function providerRuntimeGuardFixture() {
  let held = false;
  return {
    async acquire() {
      if (held) throw new Error("fixed provider runtime busy");
      held = true;
      let released = false;
      return {
        assertHeld() {
          if (released || !held) throw new Error("fixed provider runtime lease lost");
        },
        release() {
          if (released) return;
          released = true;
          held = false;
        },
      };
    },
  };
}

function providerCoordinatorMutationFixture(
  runtimeGuard: {
    acquire(signal?: AbortSignal): Promise<{
      assertHeld(): void | Promise<void>;
      release(): void | Promise<void>;
    }>;
  },
  activate: (...args: never[]) => Promise<unknown> = async () => {
    throw new Error("unused");
  },
) {
  const recoverAndRun = async <T>(
    request: { signal: AbortSignal },
    operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
  ) => {
    const runtimeLease = await runtimeGuard.acquire(request.signal);
    try {
      const lease = {
        assertHeld: async () => { await runtimeLease.assertHeld(); },
      };
      await lease.assertHeld();
      const value = await operation(lease);
      await lease.assertHeld();
      return { warnings: Object.freeze([]), value };
    } finally {
      await runtimeLease.release();
    }
  };
  return {
    activate,
    recoverAndRun,
    async runExclusive<T>(
      request: { signal: AbortSignal },
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
    ) {
      return (await recoverAndRun(request, operation)).value;
    },
  };
}

async function providerForgetActivationFixture() {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      readPending(): Promise<unknown>;
    };
    createProviderCredentialController(input: Record<string, unknown>): {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    persistProviderSetupState(
      path: string,
      request: ProviderStateCommitRequest,
    ): Promise<ProviderSetupStateV1>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-forget-serialization-"));
  const configPath = join(root, "config.json");
  const connectionId = "00000000-0000-4000-8000-000000000081";
  const oldSlotId = "v1:inference:00000000-0000-4000-8000-000000000082";
  const route = {
    ...bootstrapRoute("vendor/main"),
    accountFingerprint: "acct_forget_serialization",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: oldSlotId,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(initial, {
    persist: (request) => api.persistProviderSetupState(configPath, request),
  });
  const privateStore = new PrivateStore({ root });
  const journal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore,
  });
  const oldSecret = `${STARTUP_KEY_PREFIX}${"o".repeat(48)}`;
  const slots = new Map([[oldSlotId, oldSecret]]);
  let reservation = 90;
  let failOldSlotDelete = true;
  const credentialCalls: string[] = [];
  const credentials = {
    reserveSlot() {
      const id = `v1:inference:00000000-0000-4000-8000-${String(reservation++).padStart(12, "0")}`;
      credentialCalls.push(`reserve:${id}`);
      return Object.freeze({ version: 1 as const, kind: "inference" as const, id });
    },
    async writeSlot(slot: CredentialSlotRef, secret: string) {
      credentialCalls.push(`write:${slot.id}`);
      slots.set(slot.id, secret);
    },
    async readSlot(slot: CredentialSlotRef) {
      credentialCalls.push(`read:${slot.id}`);
      return slots.get(slot.id) ?? null;
    },
    async deleteSlot(slot: CredentialSlotRef) {
      credentialCalls.push(`delete:${slot.id}`);
      if (slot.id === oldSlotId && failOldSlotDelete) {
        throw new Error(`raw delete failure ${slot.id} ${root}`);
      }
      return slots.delete(slot.id);
    },
  };
  const adapterCalls: string[] = [];
  const adapter = {
    async connect() {
      adapterCalls.push("connect");
      return {
        candidateId: "candidate-forget-serialization",
        backendId: "openrouter" as const,
        connectionId,
        accountFingerprint: route.accountFingerprint,
        billingRealm: "openrouter-payg" as const,
        health: {
          credential: "valid" as const,
          connectivity: "connected" as const,
          spend: "available" as const,
          runtime: "not-applicable" as const,
          observedAt: 1,
          generation: 1,
        },
      };
    },
    async listModels() {
      adapterCalls.push("models");
      return [{
        backendId: "openrouter" as const,
        requestedModelId: route.requestedModelId,
        canonicalModelId: route.canonicalModelId!,
        displayName: "Main",
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
      }];
    },
    async activate(request: { candidateId: string; model: { requestedModelId: string; canonicalModelId: string } }) {
      adapterCalls.push("activate");
      return {
        candidateId: request.candidateId,
        backendId: "openrouter" as const,
        connectionId,
        accountFingerprint: route.accountFingerprint,
        billingRealm: "openrouter-payg" as const,
        route: {
          ...route,
          requestedModelId: request.model.requestedModelId,
          canonicalModelId: request.model.canonicalModelId,
        },
      };
    },
    async discardCandidate() {
      adapterCalls.push("discard");
    },
  };
  const runtimeGuard = providerRuntimeGuardFixture();
  const coordinator = new ProviderActivationCoordinator({
    appHome: root,
    configPath,
    privateStore,
    credentials: credentials as never,
    adapter: adapter as never,
    stateStore,
    runtimeGuard,
  });
  const openRouter = new OpenRouterService(oldSecret);
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials,
    runtimeGuard,
    activationCoordinator: coordinator,
    forgetJournal: journal,
    getInferenceRoute: () => route,
  });
  return {
    api,
    root,
    configPath,
    connectionId,
    oldSlotId,
    oldSecret,
    route,
    stateStore,
    privateStore,
    journal,
    slots,
    credentials,
    credentialCalls,
    adapter,
    adapterCalls,
    runtimeGuard,
    coordinator,
    controller,
    allowOldSlotDelete() { failOldSlotDelete = false; },
  };
}

test("plain setup surface keeps secret input masked and maps cancelled prompts to null", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const surface = createPlainSetupSurface({
    async select(request: Record<string, unknown>) { calls.push(request); return "openrouter"; },
    async password(request: Record<string, unknown>) { calls.push(request); throw new Error("cancelled"); },
    async confirm(request: Record<string, unknown>) { calls.push(request); return true; },
  } as never);

  assert.equal(await surface.chooseHub([{ id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: false, generation: 0 }]), "openrouter");
  assert.equal(await surface.readSecret({ backendId: "openrouter", message: "Key" }), null);
  assert.equal(await surface.confirm({ id: "save", message: "Save?", defaultValue: true }), true);
  assert.equal(calls[1]?.mask, "•");
});

test("CLI setup adapter never erases intervening foreign prompt output", () => {
  const foreignOutput = "Inquirer: Modell ausgewählt";
  const writes: string[] = [];
  const stderr = process.stderr;
  const originalWrite = stderr.write;
  const surface = createCliPlainSetupSurface();

  (stderr as unknown as { write(value: string): boolean }).write = (value: string) => {
    writes.push(value);
    return true;
  };
  try {
    surface.present({ version: 1, type: "notice", message: "Alter Setup-Fehler" });
    writes.push(foreignOutput);
    surface.present({
      version: 1,
      type: "provider-state",
      entries: [
        { id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: true, generation: 9 },
        { id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 9 },
      ],
    });

  } finally {
    (stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
  }

  assert.deepEqual(writes, [foreignOutput]);
  assert.doesNotMatch(writes.join(""), /\u001b\[1A|\u001b\[2K/);
});

test("plain setup status replaces the error in the next Cross prompt", async () => {
  const promptMessages: string[] = [];
  const surface = createPlainSetupSurface({
    select: async (request: { message: string }) => {
      promptMessages.push(request.message);
      return "cross-later";
    },
    password: async () => "",
    confirm: async () => false,
    setStatus: () => undefined,
  } as never);

  surface.present({ version: 1, type: "notice", message: "Alter Setup-Fehler" });
  surface.present({
    version: 1,
    type: "provider-state",
    entries: [
      { id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: true, generation: 9 },
      { id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 9 },
    ],
  });
  assert.equal(await surface.chooseHub([
    { id: "cross-later", label: "Later", description: "Keep collaboration off", disabled: false, current: true, generation: 9 },
  ]), "cross-later");

  assert.match(promptMessages[0] ?? "", /OpenRouter.*Aktuell r9/);
  assert.match(promptMessages[0] ?? "", /Anthropic.*Coming soon/);
  assert.doesNotMatch(promptMessages[0] ?? "", /Alter Setup-Fehler/);
});

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

test("saved provider credentials authoritatively shadow malformed environment values", () => {
  const valid = `${STARTUP_KEY_PREFIX}${"v".repeat(48)}`;
  const invalid = `opaque\u001b[31m${"x".repeat(30)}`;
  const service = createOpenRouterServiceForStartup({
    storedInferenceKey: valid,
    environmentInferenceKey: invalid,
    storedManagementKey: valid,
    environmentManagementKey: invalid,
  });

  assert.equal(service.requireKey(), valid);
  assert.equal(service.requireManagementKey(), valid);
  assert.equal(service.keyOrigin, "keychain");
  assert.equal(service.managementKeyOrigin, "keychain");
});

test("malformed saved credentials block valid automatic environment fallback for both roles", () => {
  const valid = `${STARTUP_KEY_PREFIX}${"v".repeat(48)}`;
  const invalid = `saved\u001b[31m${"x".repeat(30)}`;

  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: invalid,
    environmentInferenceKey: valid,
  }), /ungültig|Steuer|Leerzeichen/i);
  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: valid,
    environmentInferenceKey: null,
    storedManagementKey: invalid,
    environmentManagementKey: valid,
  }), /ungültig|Steuer|Leerzeichen/i);
});

test("stored credential read errors remain present-invalid and block valid environment fallback", async () => {
  type StoredState =
    | { kind: "absent" }
    | { kind: "present"; value: string }
    | { kind: "invalid" };
  const loadStoredCredentialForStartup = (cliModule as typeof cliModule & {
    loadStoredCredentialForStartup(
      credentials: Pick<CredentialStoreLike, "get">,
      kind: "inference" | "management",
    ): Promise<StoredState>;
  }).loadStoredCredentialForStartup;
  const unreadable: Pick<CredentialStoreLike, "get"> = {
    async get() { throw new Error("opaque backend read failure"); },
  };
  const valid = `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`;

  const inference = await loadStoredCredentialForStartup(unreadable, "inference");
  const management = await loadStoredCredentialForStartup(unreadable, "management");
  assert.deepEqual(inference, { kind: "invalid" });
  assert.deepEqual(management, { kind: "invalid" });
  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: inference as never,
    environmentInferenceKey: valid,
  }), /gespeichert|Schlüsselbund|ungültig/i);
  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: null,
    environmentInferenceKey: valid,
    storedManagementKey: management as never,
    environmentManagementKey: valid,
  }), /gespeichert|Schlüsselbund|ungültig/i);
});

test("provider runtime keeps an unreadable saved credential authoritative without constructing a secret or env route", () => {
  const select = (cliModule as typeof cliModule & {
    providerServiceStartupCredential?: (
      stored: { kind: "absent" } | { kind: "present"; value: string } | { kind: "invalid" },
      environment: string | null,
    ) => { stored: { kind: "absent" } | { kind: "present"; value: string }; environment: string | null };
  }).providerServiceStartupCredential;
  assert.equal(typeof select, "function");
  assert.deepEqual(select({ kind: "invalid" }, `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`), {
    stored: { kind: "absent" },
    environment: null,
  });
  assert.deepEqual(select({ kind: "present", value: `bad\0${"x".repeat(30)}` }, `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`), {
    stored: { kind: "absent" },
    environment: null,
  });
});

test("restart recovery derives inspection credentials only from the recovered versioned pointer", async () => {
  const recoverBinding = (cliModule as typeof cliModule & {
    recoverProviderCredentialBinding?: (input: {
      stateStore: ProviderStateStore;
      recover(): Promise<void>;
      readCredential(reference: "legacy:inference" | CredentialSlotRef): Promise<
        { kind: "absent" } | { kind: "present"; value: string } | { kind: "invalid" }
      >;
      environmentCredential: string | null;
    }) => Promise<{
      reference: "legacy:inference" | CredentialSlotRef;
      stored: { kind: "absent" } | { kind: "present"; value: string };
      environment: string | null;
    }>;
  }).recoverProviderCredentialBinding;
  assert.equal(typeof recoverBinding, "function");

  const oldSlot = "v1:inference:00000000-0000-4000-8000-000000000011";
  const newSlot = "v1:inference:00000000-0000-4000-8000-000000000022";
  const state = (revision: number, slot: string, account: string): ProviderSetupStateV1 => ({
    schemaVersion: 1,
    revision,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000099",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slot,
      accountFingerprint: account,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: account,
      billingRealm: "openrouter-payg",
      requestedModelId: "vendor/main",
      canonicalModelId: "vendor/main",
      resolutionState: "resolved",
    },
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  const store = new ProviderStateStore(state(0, oldSlot, "acct_old"));
  const reads: string[] = [];
  const environment = `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`;
  const recovered = await recoverBinding!({
    stateStore: store,
    async recover() {
      store.replace(state(1, newSlot, "acct_new"), 0);
    },
    async readCredential(reference) {
      reads.push(typeof reference === "string" ? reference : reference.id);
      return reference !== "legacy:inference" && reference.id === newSlot
        ? { kind: "present", value: `${STARTUP_KEY_PREFIX}${"n".repeat(48)}` }
        : { kind: "present", value: `${STARTUP_KEY_PREFIX}${"o".repeat(48)}` };
    },
    environmentCredential: environment,
  });

  assert.deepEqual(reads, [newSlot]);
  assert.equal(recovered.reference === "legacy:inference" ? recovered.reference : recovered.reference.id, newSlot);
  assert.equal(recovered.stored.kind, "present");
  assert.equal(recovered.environment, null);
});

test("startup durable provider commits preserve every unrelated config byte under exact revision CAS", async () => {
  const persist = (cliModule as typeof cliModule & {
    persistProviderSetupState?: (
      path: string,
      request: {
        expectedRevision: number;
        assertCurrent(): void;
        build(current: typeof DEFAULT_CONFIG.providerSetup): typeof DEFAULT_CONFIG.providerSetup;
        adopt(committed: typeof DEFAULT_CONFIG.providerSetup): void;
      },
    ) => Promise<typeof DEFAULT_CONFIG.providerSetup>;
  }).persistProviderSetupState;
  assert.equal(typeof persist, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-state-cas-"));
  const path = join(directory, "config.json");
  const before = structuredClone(DEFAULT_CONFIG.providerSetup);
  const after = { ...before, revision: 1, lifecycle: "cancelled" as const };
  const beforeBytes = JSON.stringify(before);
  const raw = `{"schemaVersion":3,"unknown":{"spacing":"  exact  "},"providerSetup":${beforeBytes},"tail":[1, 2, 3]}\n`;
  await writeFile(path, raw, { encoding: "utf8", mode: 0o600 });
  let adopted: typeof DEFAULT_CONFIG.providerSetup | null = null;

  const committed = await persist!(path, {
    expectedRevision: 0,
    assertCurrent() {},
    build(current) {
      assert.deepEqual(current, before);
      return after;
    },
    adopt(value) {
      adopted = value;
    },
  });

  const expectedRaw = raw.replace(beforeBytes, JSON.stringify(after));
  assert.equal(await readFile(path, "utf8"), expectedRaw);
  assert.deepEqual(committed, after);
  assert.deepEqual(adopted, after);
});

test("versioned inference replace and forget leave one restart-atomic provider tuple", async () => {
  const api = cliModule as typeof cliModule & {
    createProviderCredentialController?: (input: Record<string, unknown>) => {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => unknown;
  };
  const createController = api.createProviderCredentialController;
  assert.equal(typeof createController, "function");

  const oldKey = `${STARTUP_KEY_PREFIX}${"o".repeat(48)}`;
  const newKey = `${STARTUP_KEY_PREFIX}${"n".repeat(48)}`;
  const oldSlot = "v1:inference:00000000-0000-4000-8000-000000000031";
  const newSlot = "v1:inference:00000000-0000-4000-8000-000000000032";
  const connectionId = "00000000-0000-4000-8000-000000000039";
  const route = bootstrapRoute("vendor/main") as unknown as ProviderSetupStateV1["defaultRoute"];
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: oldSlot,
      accountFingerprint: route!.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let durable = structuredClone(initial);
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      request.assertCurrent();
      const next = request.build(durable);
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const slots = new Map([[oldSlot, oldKey]]);
  const openRouter = new OpenRouterService(oldKey, undefined, { inference: "keychain" });
  const runtimeEvents: string[] = [];
  const runtimeGuard = {
    async acquire() {
      runtimeEvents.push("guard:acquire");
      return {
        assertHeld() { runtimeEvents.push("guard:assert"); },
        release() { runtimeEvents.push("guard:release"); },
      };
    },
  };
  const forgetRoot = await mkdtemp(join(tmpdir(), "orcode-versioned-forget-"));
  const forgetJournal = new api.ProviderCredentialForgetJournal({
    appHome: forgetRoot,
    privateStore: new PrivateStore({ root: forgetRoot }),
  });
  const activate = async (request: { expectedRevision: number; candidate: string }) => {
    assert.equal(request.expectedRevision, 0);
    assert.equal(request.candidate, newKey);
    const next: ProviderSetupStateV1 = {
      ...structuredClone(initial),
      revision: 1,
      connections: [{ ...initial.connections[0]!, credentialSlot: newSlot }],
    };
    durable = structuredClone(next);
    stateStore.replace(next, 0);
    slots.set(newSlot, newKey);
    openRouter.setKey(newKey, "keychain");
    return { persisted: true, route, state: next, warnings: [] };
  };
  const controller = createController!({
    stateStore,
    openRouter,
    credentials: {
      location: "test-keychain",
      async deleteSlot(slot: CredentialSlotRef) {
        runtimeEvents.push(`delete:${slot.id}`);
        return slots.delete(slot.id);
      },
    },
    runtimeGuard,
    activationCoordinator: providerCoordinatorMutationFixture(
      runtimeGuard,
      activate as never,
    ),
    forgetJournal,
  });

  await controller.apply({
    kind: "replace",
    credentialKind: "inference",
    candidate: newKey,
    persistence: "persisted",
  });
  assert.equal(durable.connections[0]?.credentialSlot, newSlot);
  assert.equal(openRouter.requireKey(), newKey);

  await controller.apply({ kind: "forget", credentialKind: "inference" });
  const restarted = new ProviderStateStore(durable).read();
  assert.equal(restarted.defaultRoute, null);
  assert.deepEqual(restarted.connections, []);
  assert.equal(slots.has(newSlot), false);
  assert.equal(openRouter.hasKey, false);
  assert.equal(runtimeEvents[0], "guard:acquire");
  assert.equal(runtimeEvents.at(-1), "guard:release");
  assert.equal(
    runtimeEvents.filter((event) => event === `delete:${newSlot}`).length,
    1,
  );
});

test("saving a process-only environment route persists that exact route and versioned credential for restart", async () => {
  const createController = (cliModule as typeof cliModule & {
    createProviderCredentialController?: (input: Record<string, unknown>) => {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }).createProviderCredentialController;
  const recoverBinding = (cliModule as typeof cliModule & {
    recoverProviderCredentialBinding?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }).recoverProviderCredentialBinding;
  assert.equal(typeof createController, "function");
  assert.equal(typeof recoverBinding, "function");
  const environmentKey = `${STARTUP_KEY_PREFIX}${"p".repeat(48)}`;
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000041";
  const connectionId = "00000000-0000-4000-8000-000000000049";
  const route = bootstrapRoute("vendor/process-only") as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let durable = structuredClone(initial);
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      const next = request.build(durable);
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const slots = new Map<string, string>();
  const openRouter = new OpenRouterService(environmentKey, undefined, { inference: "environment" });
  const controller = createController!({
    stateStore,
    openRouter,
    getInferenceRoute: () => route,
    credentials: {
      async deleteSlot() { return false; },
    },
    runtimeGuard: {
      async acquire() {
        return { assertHeld() {}, release() {} };
      },
    },
    activationCoordinator: {
      async activate(request: Record<string, unknown>) {
        assert.equal(request.candidate, environmentKey);
        assert.equal(request.persistence, "persisted");
        assert.equal(request.expectedRequestedModelId, route.requestedModelId);
        assert.equal(request.selectedCanonicalModelId, route.canonicalModelId);
        const next: ProviderSetupStateV1 = {
          schemaVersion: 1,
          revision: 1,
          lifecycle: "configured",
          connections: [{
            id: connectionId,
            backendId: "openrouter",
            enabled: true,
            maturity: "stable",
            credentialSlot: slotId,
            accountFingerprint: route.accountFingerprint,
            accountFingerprintState: "verified",
            billingRealm: "openrouter-payg",
            lastHealth: null,
          }],
          defaultRoute: route,
          cross: { enabled: false, preferredLead: null, preferredChallenger: null },
        };
        slots.set(slotId, environmentKey);
        durable = structuredClone(next);
        stateStore.replace(next, 0);
        return { persisted: true, route, state: next, warnings: [] };
      },
    },
  });

  await controller.apply({ kind: "save", credentialKind: "inference" });

  const restartedStore = new ProviderStateStore(durable);
  const recovered = await recoverBinding!({
    stateStore: restartedStore,
    async recover() {},
    async readCredential(reference: "legacy:inference" | CredentialSlotRef) {
      const id = typeof reference === "string" ? reference : reference.id;
      const value = slots.get(id);
      return value ? { kind: "present", value } : { kind: "absent" };
    },
    environmentCredential: null,
  }) as { reference: "legacy:inference" | CredentialSlotRef; stored: { kind: string; value?: string } };
  assert.equal(
    recovered.reference === "legacy:inference" ? recovered.reference : recovered.reference.id,
    slotId,
  );
  assert.deepEqual(restartedStore.read().defaultRoute, route);
  assert.deepEqual(recovered.stored, { kind: "present", value: environmentKey });
});

test("forget retry retains the exact versioned pointer across a crash before slot deletion", async () => {
  const api = cliModule as typeof cliModule & {
    createProviderCredentialController?: (input: Record<string, unknown>) => {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => unknown;
  };
  const createController = api.createProviderCredentialController;
  assert.equal(typeof createController, "function");
  const key = `${STARTUP_KEY_PREFIX}${"f".repeat(48)}`;
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000051";
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000059",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slotId,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let durable = structuredClone(initial);
  const createStateStore = () => new ProviderStateStore(durable, {
    persist: async (request) => {
      const next = request.build(durable);
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const runtimeGuard = {
    async acquire() {
      return { assertHeld() {}, release() {} };
    },
  };
  const openRouter = new OpenRouterService(key, undefined, { inference: "keychain" });
  const forgetRoot = await mkdtemp(join(tmpdir(), "orcode-forget-retry-"));
  const forgetJournal = new api.ProviderCredentialForgetJournal({
    appHome: forgetRoot,
    privateStore: new PrivateStore({ root: forgetRoot }),
  });
  const first = createController!({
    stateStore: createStateStore(),
    openRouter,
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        assert.equal(slot.id, slotId);
        throw new Error("synthetic crash before delete publication");
      },
    },
    runtimeGuard,
    activationCoordinator: providerCoordinatorMutationFixture(runtimeGuard),
    forgetJournal,
  });
  await assert.rejects(
    first.apply({ kind: "forget", credentialKind: "inference" }),
    (error: unknown) => {
      assert.match(String(error), /Provider credential cleanup is pending/);
      assert.doesNotMatch(String(error), /synthetic crash|v1:inference/);
      return true;
    },
  );
  assert.equal(durable.defaultRoute, null);
  assert.equal(durable.connections[0]?.credentialSlot, slotId);

  const deleted: string[] = [];
  const second = createController!({
    stateStore: createStateStore(),
    openRouter,
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        deleted.push(slot.id);
        return true;
      },
    },
    runtimeGuard,
    activationCoordinator: providerCoordinatorMutationFixture(runtimeGuard),
    forgetJournal,
  });
  await second.apply({ kind: "forget", credentialKind: "inference" });
  assert.deepEqual(deleted, [slotId]);
  assert.equal(durable.defaultRoute, null);
  assert.deepEqual(durable.connections, []);
  assert.equal(openRouter.hasKey, false);
});

test("failed pre-delete forget journals the exact target and synchronizes the first durable publication before unrelated config save", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal?: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      readPending(): Promise<{
        phase: "prepared" | "credential-deleted";
        target: { kind: "versioned"; slot: CredentialSlotRef } | { kind: "legacy" };
      } | null>;
    };
    createProviderCredentialController?: (input: Record<string, unknown>) => {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    persistProviderSetupState?: (
      path: string,
      request: ProviderStateCommitRequest,
    ) => Promise<ProviderSetupStateV1>;
  };
  assert.equal(typeof api.ProviderCredentialForgetJournal, "function");
  assert.equal(typeof api.createProviderCredentialController, "function");
  const root = await mkdtemp(join(tmpdir(), "orcode-forget-journal-pre-delete-"));
  const configPath = join(root, "config.json");
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000061";
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000069",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slotId,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  await saveConfig(config, configPath);
  let durable = structuredClone(initial);
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      const next = await api.persistProviderSetupState!(configPath, request);
      durable = structuredClone(next);
      return structuredClone(next);
    },
  });
  const journal = new api.ProviderCredentialForgetJournal!({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const openRouter = new OpenRouterService(`${STARTUP_KEY_PREFIX}${"j".repeat(48)}`);
  const runtimeGuard = providerRuntimeGuardFixture();
  const controller = api.createProviderCredentialController!({
    stateStore,
    openRouter,
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        assert.equal(slot.id, slotId);
        throw new Error("synthetic delete unavailable");
      },
    },
    runtimeGuard,
    activationCoordinator: providerCoordinatorMutationFixture(runtimeGuard),
    forgetJournal: journal,
    onInferenceStatePublished(state: ProviderSetupStateV1) {
      config.providerSetup = structuredClone(state);
    },
  });

  await assert.rejects(
    controller.apply({ kind: "forget", credentialKind: "inference" }),
    (error: unknown) => {
      assert.match(String(error), /Provider credential cleanup is pending/);
      assert.doesNotMatch(String(error), /synthetic delete unavailable|v1:inference|orcode-forget-journal/);
      return true;
    },
  );
  assert.deepEqual(config.providerSetup, durable);
  assert.equal(
    (JSON.parse(await readFile(configPath, "utf8")) as { providerSetup: ProviderSetupStateV1 })
      .providerSetup.defaultRoute,
    null,
  );
  await saveConfig(config, configPath);

  const saved = JSON.parse(await readFile(configPath, "utf8")) as { providerSetup: ProviderSetupStateV1 };
  assert.equal(saved.providerSetup.defaultRoute, null);
  assert.equal(saved.providerSetup.connections[0]?.credentialSlot, slotId);
  assert.deepEqual(saved.providerSetup, durable);
  assert.deepEqual(await journal.readPending(), {
    phase: "prepared",
    target: {
      kind: "versioned",
      slot: { version: 1, kind: "inference", id: slotId },
    },
  });
});

test("post-delete forget recovery trusts the durable phase, completes once, and never re-deletes", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal?: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(...args: unknown[]): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
      readPending(): Promise<{
        phase: "prepared" | "credential-deleted";
        target: { kind: "versioned"; slot: CredentialSlotRef } | { kind: "legacy" };
      } | null>;
    };
    createProviderCredentialController?: (input: Record<string, unknown>) => {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    recoverProviderCredentialForget?: (input: Record<string, unknown>) => Promise<{
      cleanupPending: boolean;
    }>;
  };
  assert.equal(typeof api.ProviderCredentialForgetJournal, "function");
  assert.equal(typeof api.recoverProviderCredentialForget, "function");
  const root = await mkdtemp(join(tmpdir(), "orcode-forget-journal-post-delete-"));
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000071";
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000079",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slotId,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let durable = structuredClone(initial);
  const createStateStore = () => new ProviderStateStore(durable, {
    persist: async (request) => {
      const next = request.build(durable);
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const realJournal = new api.ProviderCredentialForgetJournal!({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const slots = new Map([[slotId, `${STARTUP_KEY_PREFIX}${"k".repeat(48)}`]]);
  const deleted: string[] = [];
  const runtimeGuard = providerRuntimeGuardFixture();
  const controller = api.createProviderCredentialController!({
    stateStore: createStateStore(),
    openRouter: new OpenRouterService(slots.get(slotId)!),
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        deleted.push(slot.id);
        return slots.delete(slot.id);
      },
    },
    runtimeGuard,
    activationCoordinator: providerCoordinatorMutationFixture(runtimeGuard),
    forgetJournal: {
      begin: (input: Parameters<typeof realJournal.begin>[0]) => realJournal.begin(input),
      async markDeleted(transaction: Parameters<typeof realJournal.markDeleted>[0]) {
        await realJournal.markDeleted(transaction);
        throw new Error("synthetic crash after credential deletion");
      },
      complete: (transaction: Parameters<typeof realJournal.complete>[0]) =>
        realJournal.complete(transaction),
    },
  });
  await assert.rejects(
    controller.apply({ kind: "forget", credentialKind: "inference" }),
    (error: unknown) => {
      assert.match(String(error), /Provider credential cleanup is pending/);
      assert.doesNotMatch(String(error), /synthetic crash|v1:inference|orcode-forget-journal/);
      return true;
    },
  );
  assert.equal(slots.has(slotId), false);
  assert.equal((await realJournal.readPending())?.phase, "credential-deleted");

  const environmentKey = `${STARTUP_KEY_PREFIX}${"e".repeat(48)}`;
  const recoveredStore = createStateStore();
  const recovered = await (cliModule as typeof cliModule & {
    recoverProviderCredentialBinding(input: Record<string, unknown>): Promise<{
      stored: { kind: string };
      environment: string | null;
    }>;
  }).recoverProviderCredentialBinding({
    stateStore: recoveredStore,
    recover: () => api.recoverProviderCredentialForget!({
      journal: realJournal,
      stateStore: recoveredStore,
      credentials: {
        async deleteSlot() {
          throw new Error("credential-deleted phase must not delete again");
        },
      },
    }),
    async readCredential(reference: "legacy:inference" | CredentialSlotRef) {
      assert.equal(reference, "legacy:inference");
      return { kind: "absent" };
    },
    environmentCredential: environmentKey,
  });
  assert.equal(recovered.environment, environmentKey);
  assert.deepEqual(deleted, [slotId]);
  assert.deepEqual(durable.connections, []);
  assert.equal(durable.defaultRoute, null);
  assert.equal(await realJournal.readPending(), null);

  const repeatedStore = createStateStore();
  const repeated = await (cliModule as typeof cliModule & {
    recoverProviderCredentialBinding(input: Record<string, unknown>): Promise<{
      stored: { kind: string };
      environment: string | null;
    }>;
  }).recoverProviderCredentialBinding({
    stateStore: repeatedStore,
    recover: () => api.recoverProviderCredentialForget!({
      journal: realJournal,
      stateStore: repeatedStore,
      credentials: {
        async deleteSlot() {
          throw new Error("completed journal must not delete again");
        },
      },
    }),
    async readCredential(reference: "legacy:inference" | CredentialSlotRef) {
      assert.equal(reference, "legacy:inference");
      return { kind: "absent" };
    },
    environmentCredential: environmentKey,
  });
  assert.equal(repeated.environment, environmentKey);
  assert.deepEqual(deleted, [slotId]);
  assert.equal(await realJournal.readPending(), null);
});

test("a failed pre-delete forget blocks same-process key save before provider candidate work without leaking its slot or journal path", async () => {
  const fixture = await providerForgetActivationFixture();

  await assert.rejects(
    fixture.controller.apply({ kind: "forget", credentialKind: "inference" }),
    /Provider credential cleanup is pending/,
  );
  assert.notEqual(await fixture.journal.readPending(), null);
  fixture.adapterCalls.length = 0;
  let blocked: unknown;

  await assert.rejects(
    fixture.controller.apply({ kind: "save", credentialKind: "inference" }),
    (error: unknown) => {
      blocked = error;
      assert.match(String(error), /cleanup|recovery|pending/i);
      return true;
    },
  );

  assert.deepEqual(fixture.adapterCalls, []);
  assert.doesNotMatch(
    String(blocked),
    new RegExp(`${fixture.oldSlotId}|${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|raw delete`, "i"),
  );
});

for (const persistence of ["persisted", "process-only"] as const) {
  test(`pending forget blocks an independent ${persistence} activation through the provider-wide coordinator`, async () => {
    const fixture = await providerForgetActivationFixture();
    await assert.rejects(
      fixture.controller.apply({ kind: "forget", credentialKind: "inference" }),
      /Provider credential cleanup is pending/,
    );
    fixture.adapterCalls.length = 0;
    const independentStore = new ProviderStateStore(fixture.stateStore.read(), {
      persist: (request) => fixture.api.persistProviderSetupState(fixture.configPath, request),
    });
    const independentCoordinator = new ProviderActivationCoordinator({
      appHome: fixture.root,
      configPath: fixture.configPath,
      privateStore: new PrivateStore({ root: fixture.root }),
      credentials: fixture.credentials as never,
      adapter: fixture.adapter as never,
      stateStore: independentStore,
      runtimeGuard: providerRuntimeGuardFixture(),
    });

    await assert.rejects(
      independentCoordinator.activate({
        expectedRevision: independentStore.read().revision,
        candidate: fixture.oldSecret,
        expectedRequestedModelId: fixture.route.requestedModelId,
        selectedCanonicalModelId: fixture.route.canonicalModelId!,
        generation: 1,
        signal: new AbortController().signal,
        persistence,
      }),
      /cleanup|recovery|pending/i,
    );

    assert.deepEqual(fixture.adapterCalls, []);
    assert.notEqual(await fixture.journal.readPending(), null);
  });
}

test("forget recovery cleans an old slot after the same connection committed a new slot and preserves the new route", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      readPending(): Promise<unknown>;
    };
    recoverProviderCredentialForget(input: Record<string, unknown>): Promise<{
      cleanupPending: boolean;
    }>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-forget-same-connection-new-slot-"));
  const privateStore = new PrivateStore({ root });
  const journal = new api.ProviderCredentialForgetJournal({ appHome: root, privateStore });
  const connectionId = "00000000-0000-4000-8000-000000000091";
  const oldSlotId = "v1:inference:00000000-0000-4000-8000-000000000092";
  const newSlotId = "v1:inference:00000000-0000-4000-8000-000000000093";
  await journal.begin({
    connectionId,
    target: {
      kind: "versioned",
      slot: { version: 1, kind: "inference", id: oldSlotId },
    },
  });
  const route = {
    ...bootstrapRoute("vendor/new"),
    accountFingerprint: "acct_same_connection_new_slot",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const state: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 4,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: newSlotId,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  const slots = new Set([oldSlotId, newSlotId]);
  const deleted: string[] = [];

  const recovered = await api.recoverProviderCredentialForget({
    journal,
    stateStore,
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        deleted.push(slot.id);
        return slots.delete(slot.id);
      },
    },
  });

  assert.deepEqual(recovered, { cleanupPending: false });
  assert.deepEqual(deleted, [oldSlotId]);
  assert.equal(slots.has(newSlotId), true);
  assert.deepEqual(stateStore.read(), state);
  assert.equal(await journal.readPending(), null);
});

test("forget recovery retains a slot referenced by another committed connection and settles idempotently across restarts", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      readPending(): Promise<unknown>;
    };
    recoverProviderCredentialForget(input: Record<string, unknown>): Promise<{
      cleanupPending: boolean;
    }>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-forget-shared-slot-reference-"));
  const journal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000101";
  const retiringConnectionId = "00000000-0000-4000-8000-000000000102";
  const survivingConnectionId = "00000000-0000-4000-8000-000000000103";
  await journal.begin({
    connectionId: retiringConnectionId,
    target: {
      kind: "versioned",
      slot: { version: 1, kind: "inference", id: slotId },
    },
  });
  const survivingRoute = {
    ...bootstrapRoute("vendor/surviving"),
    accountFingerprint: "acct_shared_slot_surviving",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const state: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 7,
    lifecycle: "configured",
    connections: [
      {
        id: retiringConnectionId,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialSlot: slotId,
        accountFingerprint: "acct_shared_slot_retiring",
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      },
      {
        id: survivingConnectionId,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialSlot: slotId,
        accountFingerprint: survivingRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      },
    ],
    defaultRoute: survivingRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  const deleted: string[] = [];
  const recover = () => api.recoverProviderCredentialForget({
    journal,
    stateStore,
    credentials: {
      async deleteSlot(slot: CredentialSlotRef) {
        deleted.push(slot.id);
        return true;
      },
    },
  });

  assert.deepEqual(await recover(), { cleanupPending: false });
  assert.deepEqual(await recover(), { cleanupPending: false });
  assert.deepEqual(deleted, []);
  assert.deepEqual(
    stateStore.read().connections.map((connection) => connection.id),
    [survivingConnectionId],
  );
  assert.deepEqual(stateStore.read().defaultRoute, survivingRoute);
  assert.equal(await journal.readPending(), null);
});

test("startup accepts outer Unicode whitespace for all saved and environment credentials", () => {
  const inference = `${STARTUP_KEY_PREFIX}${"i".repeat(48)}`;
  const management = `${STARTUP_KEY_PREFIX}${"m".repeat(48)}`;
  const wrap = (value: string): string => `\u00a0\r\n${value}\r\n\u2003`;

  const saved = createOpenRouterServiceForStartup({
    storedInferenceKey: wrap(inference),
    environmentInferenceKey: null,
    storedManagementKey: wrap(management),
    environmentManagementKey: null,
  });
  assert.equal(saved.requireKey(), inference);
  assert.equal(saved.requireManagementKey(), management);
  assert.equal(saved.keyOrigin, "keychain");
  assert.equal(saved.managementKeyOrigin, "keychain");

  const environment = createOpenRouterServiceForStartup({
    storedInferenceKey: null,
    environmentInferenceKey: wrap(inference),
    storedManagementKey: null,
    environmentManagementKey: wrap(management),
  });
  assert.equal(environment.requireKey(), inference);
  assert.equal(environment.requireManagementKey(), management);
  assert.equal(environment.keyOrigin, "environment");
  assert.equal(environment.managementKeyOrigin, "environment");
});

test("distinct selected app homes share the one canonical startup HMAC claim namespace", async () => {
  const createCredentialStoreForStartup = (cliModule as typeof cliModule & {
    createCredentialStoreForStartup(
      selectedAppHome: string,
      options: {
        globalHmacLockRoot: string;
        instantiate(lockRoot: string): CredentialStore;
      },
    ): CredentialStore;
  }).createCredentialStoreForStartup;
  const fixture = await mkdtemp(join(tmpdir(), "orcode-global-hmac-startup-"));
  const selectedA = join(fixture, "selected-a");
  const selectedB = join(fixture, "selected-b");
  const globalHmacLockRoot = join(fixture, "canonical-global");
  await Promise.all([
    mkdir(selectedA),
    mkdir(selectedB),
    mkdir(globalHmacLockRoot),
  ]);
  let persisted: string | undefined;
  let writes = 0;
  let generated = 0;
  const instantiate = (lockRoot: string): CredentialStore => new CredentialStore(
    () => ({
      async getPassword() { return persisted; },
      async setPassword(password: string) {
        writes += 1;
        if (writes === 1) await new Promise((resolve) => setTimeout(resolve, 40));
        persisted = password;
      },
      async deleteCredential() { persisted = undefined; return true; },
    }),
    undefined,
    () => new Uint8Array(32).fill(++generated),
    lockRoot,
  );
  const first = createCredentialStoreForStartup(selectedA, {
    globalHmacLockRoot,
    instantiate,
  });
  const second = createCredentialStoreForStartup(selectedB, {
    globalHmacLockRoot,
    instantiate,
  });

  const [firstKey, secondKey] = await Promise.all([
    first.getOrCreateAccountHmacKey(),
    second.getOrCreateAccountHmacKey(),
  ]);
  assert.deepEqual(firstKey, secondKey);
  assert.equal(writes, 1);
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

test("dashboard first-key setup keeps a valid unfunded key active for status and reconnect", async () => {
  const key = `${STARTUP_KEY_PREFIX}dashboard-valid-unfunded-key-123`;
  const openRouter = new OpenRouterService(undefined, undefined, {}, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: {
        label: "valid but unfunded",
        is_free_tier: false,
        is_management_key: false,
        usage: 1,
        limit: 1,
        limit_remaining: 0,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  let persisted: string | null = null;
  const credentials: CredentialStoreLike = {
    location: "Test-Schlüsselbund",
    async get() { return persisted; },
    async has() { return persisted !== null; },
    async set(_kind, secret) { persisted = secret; },
    async delete() { persisted = null; return true; },
  };
  const messages: string[] = [];
  const ui = {
    setStatus: () => undefined,
    setCancelHandler: () => undefined,
    addMessage: (_level: string, message: string) => messages.push(message),
    readSecret: async () => key,
  };

  const balance = await initializeDashboardKey(
    ui as never,
    { openRouter, credentials } as never,
  );

  assert.equal(balance?.key.limitRemaining, 0);
  assert.equal(persisted, key);
  assert.equal(openRouter.requireKey(), key);
  assert.equal(openRouter.runtimeState.inferenceValidity, "valid");
  assert.equal(openRouter.runtimeState.connectivity, "connected");
  assert.equal(openRouter.runtimeState.credit, "insufficient");
  assert.match(messages.join("\n"), /validiert.*gespeichert/i);
});

test("dashboard setup normalizes outer Unicode whitespace before network, keychain, and activation", async () => {
  const body = `${STARTUP_KEY_PREFIX}${"d".repeat(48)}`;
  const raw = `\u00a0\r\n${body}\r\n\u2003`;
  const authorizations: string[] = [];
  const openRouter = new OpenRouterService(undefined, undefined, {}, {
    fetchImpl: async (_url, init) => {
      authorizations.push((init.headers as Record<string, string>).Authorization);
      return startupKeyResponse();
    },
  });
  const persisted: string[] = [];
  const credentials: CredentialStoreLike = {
    location: "Test-Schlüsselbund",
    async get() { return null; },
    async has() { return false; },
    async set(_kind, secret) { persisted.push(secret); },
    async delete() { return false; },
  };
  const { ui } = dashboardKeyUi();
  const candidates: Array<string | null> = [raw, null];
  (ui as { readSecret(): Promise<string | null> }).readSecret = async () =>
    candidates.shift() ?? null;

  await initializeDashboardKey(
    ui as never,
    { openRouter, credentials } as never,
  );

  assert.deepEqual(authorizations, [`Bearer ${body}`]);
  assert.deepEqual(persisted, [body]);
  assert.equal(openRouter.requireKey(), body);
});

test("dashboard setup rejects invalid local bytes with zero network and keychain calls", async () => {
  const calls: string[] = [];
  const openRouter = new OpenRouterService(undefined, undefined, {}, {
    fetchImpl: async () => {
      calls.push("network");
      return startupKeyResponse();
    },
  });
  const credentials: CredentialStoreLike = {
    location: "Test-Schlüsselbund",
    async get() { calls.push("get"); return null; },
    async has() { calls.push("has"); return false; },
    async set() { calls.push("set"); },
    async delete() { calls.push("delete"); return false; },
  };
  const messages: string[] = [];
  const candidates: Array<string | null> = [`bad\0${"x".repeat(30)}`, null];
  const ui = {
    setStatus: () => undefined,
    setCancelHandler: () => undefined,
    addMessage: (_level: string, message: string) => messages.push(message),
    readSecret: async () => candidates.shift() ?? null,
  };

  const result = await initializeDashboardKey(
    ui as never,
    { openRouter, credentials } as never,
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
  assert.match(messages.join("\n"), /ungültig|Steuer|Leerzeichen/i);
});

test("a rejected saved key remains exclusive and never automatically validates the environment fallback", async () => {
  const stored = `${STARTUP_KEY_PREFIX}dashboard-rejected-stored-123`;
  const environment = `${STARTUP_KEY_PREFIX}dashboard-valid-environment-456`;
  const authorizations: string[] = [];
  const openRouter = new OpenRouterService(
    stored,
    undefined,
    { inference: "keychain" },
    {
      fetchImpl: async (_url, init) => {
        const authorization = (init.headers as Record<string, string>).Authorization;
        authorizations.push(authorization);
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

  assert.equal(balance, null);
  assert.equal(openRouter.requireKey(), stored);
  assert.equal(openRouter.keyOrigin, "keychain");
  assert.equal(persisted, stored);
  assert.deepEqual(calls, []);
  assert.deepEqual(authorizations, [`Bearer ${stored}`]);
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

test("configured run gate validates every fallback as a main route", async () => {
  const cli = await import("../src/cli.js");
  const main = cliRoleModel({ id: "provider/main" });
  const compatibleFallback = cliRoleModel({ id: "provider/fallback-good" });
  const incompatibleFallback = cliRoleModel({
    id: "provider/fallback-no-text",
    outputModalities: ["image"],
  });
  const catalogue = new Map(
    [main, compatibleFallback, incompatibleFallback].map((model) => [model.id, model]),
  );
  const calls: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = main.id;
  config.fallbackModels = [compatibleFallback.id, incompatibleFallback.id];
  config.compressionMode = "off";

  await assert.rejects(
    cli.ensureRunnableModelConfiguration(
      {
        listModels: async (search: string) => {
          calls.push(search);
          const model = catalogue.get(search);
          return model ? [model] : [];
        },
      },
      config,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ModelCapabilityError" &&
      error.message.includes(incompatibleFallback.id),
  );
  assert.deepEqual(calls, [main.id, compatibleFallback.id, incompatibleFallback.id]);
});

test("configured fallback validation preserves catalogue outage identity", async () => {
  const cli = await import("../src/cli.js");
  const main = cliRoleModel({ id: "provider/main-online" });
  const unavailable = new Error("synthetic configured fallback outage");
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = main.id;
  config.fallbackModels = ["provider/fallback-offline"];
  config.compressionMode = "off";

  await assert.rejects(
    cli.ensureRunnableModelConfiguration(
      {
        listModels: async (search: string) => {
          if (search === main.id) return [main];
          throw unavailable;
        },
      },
      config,
    ),
    (error: unknown) => error === unavailable,
  );
});

test("explicit startup model validates before config and session preference mutation", async () => {
  const cli = await import("../src/cli.js") as typeof import("../src/cli.js") & {
    applyStartupModelPreference: (
      openRouter: { listModels: (...args: unknown[]) => Promise<ModelInfo[]> },
      requestedModel: string | undefined,
      config: typeof DEFAULT_CONFIG,
      session: { setPreferences: (...args: unknown[]) => void },
    ) => Promise<void>;
  };

  const incompatible = cliRoleModel({
    id: "provider/cli-no-tools",
    supportedParameters: [],
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "provider/configured";
  const preferences: unknown[][] = [];
  const session = {
    setPreferences: (...args: unknown[]) => preferences.push(args),
  };

  await assert.rejects(
    cli.applyStartupModelPreference(
      { listModels: async () => [incompatible] },
      incompatible.id,
      config,
      session,
    ),
    (error: unknown) =>
      error instanceof Error && error.name === "ModelCapabilityError",
  );
  assert.equal(config.mainModel, "provider/configured");
  assert.deepEqual(preferences, []);

  const unavailable = new Error("synthetic explicit model catalogue outage");
  await assert.rejects(
    cli.applyStartupModelPreference(
      { listModels: async () => { throw unavailable; } },
      "provider/cli-offline",
      config,
      session,
    ),
    (error: unknown) => error === unavailable,
  );
  assert.equal(config.mainModel, "provider/configured");
  assert.deepEqual(preferences, []);
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
