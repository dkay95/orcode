import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CliUsageError,
  commandRequiresRunnableRoute,
  createDefaultProviderRuntime,
  createCliPlainSetupSurface,
  createOpenRouterServiceForStartup,
  executeProviderModelAction,
  homeWorkspaceWarning,
  initializeDashboardKey,
  initializeStartupStorage,
  parseArgs,
  pickDashboardChat,
  readPackageVersion,
  renderCliBanner,
  renderCliHelp,
  resolveCliCommandName,
  runOutcomeExitCode,
} from "../src/cli.js";
import * as cliModule from "../src/cli.js";
import { createPlainSetupSurface } from "../src/setup-ui.js";
import type { SetupSurface } from "../src/setup-ui.js";
import {
  BackendRegistry,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
} from "../src/backends.js";
import { COMMAND_CATALOG } from "../src/command-catalog.js";
import {
  handleSlashCommand,
  shouldReplaceCredential,
  type CommandContext,
} from "../src/commands.js";
import { DEFAULT_CONFIG, migrateAppHome, saveConfig } from "../src/config.js";
import { createPanelCall, OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import { askPanel } from "../src/panel.js";
import * as panelModule from "../src/panel.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { ProviderCredentialAuthority } from "../src/provider-authority.js";
import { openRouterAccountFingerprint } from "../src/openrouter-backend.js";
import { CredentialStore } from "../src/credentials.js";
import type { CredentialSlotRef, CredentialStoreLike } from "../src/credentials.js";
import {
  adoptDurablyCommittedProviderState,
  migrateLegacyOpenRouterState,
  ProviderStateStore,
  readProviderStateCommitAdoption,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV1,
  type ProviderStateCommitRequest,
} from "../src/provider-state.js";
import { PrivateStore } from "../src/private-store.js";
import { SessionStore } from "../src/session.js";
import { SetupOrchestrator } from "../src/setup.js";
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

test("runCli future and corrupt provider startup stops before runtime setup network or every credential seam", async (t) => {
  const originalFetch = globalThis.fetch;
  const originals = {
    get: CredentialStore.prototype.get,
    set: CredentialStore.prototype.set,
    delete: CredentialStore.prototype.delete,
    has: CredentialStore.prototype.has,
    reserveSlot: CredentialStore.prototype.reserveSlot,
    writeSlot: CredentialStore.prototype.writeSlot,
    readSlot: CredentialStore.prototype.readSlot,
    deleteSlot: CredentialStore.prototype.deleteSlot,
    getOrCreateAccountHmacKey: CredentialStore.prototype.getOrCreateAccountHmacKey,
  };
  const credentialCalls: string[] = [];
  let networkCalls = 0;
  const fakeLegacyIds = {
    inference: "task-ten-fake-inference-store-id",
    management: "task-ten-fake-management-store-id",
  } as const;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("task-ten-network-tripwire");
  }) as typeof fetch;
  CredentialStore.prototype.get = async function(kind) {
    credentialCalls.push(`get:${fakeLegacyIds[kind]}`);
    return null;
  };
  CredentialStore.prototype.set = async function(kind) {
    credentialCalls.push(`set:${fakeLegacyIds[kind]}`);
  };
  CredentialStore.prototype.delete = async function(kind) {
    credentialCalls.push(`delete:${fakeLegacyIds[kind]}`);
    return false;
  };
  CredentialStore.prototype.has = async function(kind) {
    credentialCalls.push(`has:${fakeLegacyIds[kind]}`);
    return false;
  };
  CredentialStore.prototype.reserveSlot = function(kind) {
    credentialCalls.push(`reserve:${kind}`);
    return Object.freeze({
      version: 1,
      kind,
      id: `v1:${kind}:10000000-0000-4000-8000-000000000010`,
    });
  };
  CredentialStore.prototype.writeSlot = async function(slot) {
    credentialCalls.push(`write:${slot.id}`);
  };
  CredentialStore.prototype.readSlot = async function(slot) {
    credentialCalls.push(`read:${slot.id}`);
    return null;
  };
  CredentialStore.prototype.deleteSlot = async function(slot) {
    credentialCalls.push(`delete-slot:${slot.id}`);
    return false;
  };
  CredentialStore.prototype.getOrCreateAccountHmacKey = async function() {
    credentialCalls.push("hmac");
    return new Uint8Array(32).fill(10);
  };

  try {
    for (const fixture of [
      {
        name: "future",
        error: "Error: Config-Migration abgelehnt: providerSetup oder schemaVersion hat die zukünftige Version 99.",
        providerSetup: { schemaVersion: 99, opaque: "task-ten-private-future-marker" },
      },
      {
        name: "corrupt",
        error: "Error: Config-Migration abgelehnt: Die Konfiguration ist beschädigt oder nicht eindeutig lesbar.",
        providerSetup: { schemaVersion: 1, connections: "invalid" },
      },
    ] as const) {
      await t.test(fixture.name, async (subtest) => {
        const root = await mkdtemp(join(tmpdir(), `orcode-cli-provider-${fixture.name}-`));
        subtest.after(() => rm(root, { recursive: true, force: true }));
        const appHome = join(root, ".orcode");
        const legacyHome = join(root, ".routercode");
        const path = join(appHome, "config.json");
        await mkdir(appHome, { recursive: true });
        await writeFile(path, `${JSON.stringify({
          schemaVersion: 1,
          mainModel: "synthetic/task-ten-safe-model",
          providerSetup: fixture.providerSetup,
        })}\n`);
        const bootstrapCalls: string[] = [];
        const error = await invokeRunCli(["--plain"], {
          initializeStorage: () => initializeStartupStorage(
            { workspace: root, newChat: false },
            {
              migrateAppHome: () => migrateAppHome(appHome, legacyHome),
              pruneRunLogs: async () => undefined,
              pruneCheckpoints: async () => undefined,
              pruneBrowserTempArtifacts: async () => undefined,
            },
          ),
          createProviderRuntime: async () => {
            bootstrapCalls.push("provider-runtime");
            throw new Error("task-ten-provider-runtime-tripwire");
          },
          createAgent: async () => {
            bootstrapCalls.push("agent");
            throw new Error("task-ten-agent-tripwire");
          },
          runPlain: async () => {
            bootstrapCalls.push("plain");
          },
          runDashboard: async () => {
            bootstrapCalls.push("dashboard");
          },
          stdout: { write: () => true },
          stderr: { write: () => true },
          environment: {},
        }).then(
          () => null,
          (reason: unknown) => reason,
        );
        assert.ok(error instanceof Error);
        assert.equal(String(error), fixture.error);
        assert.doesNotMatch(String(error), /task-ten-private-future-marker|tripwire/i);
        assert.deepEqual(bootstrapCalls, []);
        assert.deepEqual(credentialCalls, []);
        assert.equal(networkCalls, 0);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    CredentialStore.prototype.get = originals.get;
    CredentialStore.prototype.set = originals.set;
    CredentialStore.prototype.delete = originals.delete;
    CredentialStore.prototype.has = originals.has;
    CredentialStore.prototype.reserveSlot = originals.reserveSlot;
    CredentialStore.prototype.writeSlot = originals.writeSlot;
    CredentialStore.prototype.readSlot = originals.readSlot;
    CredentialStore.prototype.deleteSlot = originals.deleteSlot;
    CredentialStore.prototype.getOrCreateAccountHmacKey = originals.getOrCreateAccountHmacKey;
  }
});

test("startup verification rebinds current and later historical sessions before any save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-startup-identity-rebind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appHome = join(root, ".orcode");
  const workspace = join(root, "workspace");
  const configPath = join(appHome, "config.json");
  const modelId = "synthetic/startup-identity-model";
  const connectionId = "startup-identity-legacy-connection";
  const initialProviderState = migrateLegacyOpenRouterState(
    { ...structuredClone(DEFAULT_CONFIG), mainModel: modelId },
    { connectionId },
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = modelId;
  config.providerSetup = initialProviderState;
  await saveConfig(config, configPath);

  const currentSeed = SessionStore.create(workspace, appHome, "Current identity chat");
  currentSeed.setPreferences(modelId, { mode: "auto" });
  await currentSeed.save();
  const laterSeed = SessionStore.create(workspace, appHome, "Later identity chat");
  laterSeed.setPreferences(modelId, { mode: "auto" });
  await laterSeed.save();
  const currentBytes = await readFile(currentSeed.path, "utf8");
  const laterBytes = await readFile(laterSeed.path, "utf8");
  const current = await SessionStore.openById(
    workspace,
    currentSeed.data.id,
    appHome,
    initialProviderState.connections[0],
  );
  assert.equal(
    current.data.route?.accountFingerprint,
    `acct_legacy_${connectionId}`,
  );

  const secret = `${["sk", "or", "v1"].join("-")}-${"i".repeat(48)}`;
  const creatorId = ["startup", "identity", "creator", "opaque"].join("-");
  const hmacKey = new Uint8Array(32).fill(21);
  const verifiedFingerprint = openRouterAccountFingerprint(hmacKey, creatorId);
  const originalFetch = globalThis.fetch;
  const credentialOriginals = {
    get: CredentialStore.prototype.get,
    set: CredentialStore.prototype.set,
    delete: CredentialStore.prototype.delete,
    has: CredentialStore.prototype.has,
    reserveSlot: CredentialStore.prototype.reserveSlot,
    writeSlot: CredentialStore.prototype.writeSlot,
    readSlot: CredentialStore.prototype.readSlot,
    deleteSlot: CredentialStore.prototype.deleteSlot,
    getOrCreateAccountHmacKey: CredentialStore.prototype.getOrCreateAccountHmacKey,
  };
  const credentialEffects: string[] = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    CredentialStore.prototype.get = credentialOriginals.get;
    CredentialStore.prototype.set = credentialOriginals.set;
    CredentialStore.prototype.delete = credentialOriginals.delete;
    CredentialStore.prototype.has = credentialOriginals.has;
    CredentialStore.prototype.reserveSlot = credentialOriginals.reserveSlot;
    CredentialStore.prototype.writeSlot = credentialOriginals.writeSlot;
    CredentialStore.prototype.readSlot = credentialOriginals.readSlot;
    CredentialStore.prototype.deleteSlot = credentialOriginals.deleteSlot;
    CredentialStore.prototype.getOrCreateAccountHmacKey = credentialOriginals.getOrCreateAccountHmacKey;
  });
  CredentialStore.prototype.get = async function(kind) {
    credentialEffects.push(`get:${kind}`);
    return kind === "inference" ? secret : null;
  };
  CredentialStore.prototype.set = async function(kind) {
    credentialEffects.push(`unexpected-set:${kind}`);
    throw new Error("credential write is outside startup verification");
  };
  CredentialStore.prototype.delete = async function(kind) {
    credentialEffects.push(`unexpected-delete:${kind}`);
    throw new Error("credential delete is outside startup verification");
  };
  CredentialStore.prototype.has = async function(kind) {
    credentialEffects.push(`has:${kind}`);
    return kind === "inference";
  };
  CredentialStore.prototype.reserveSlot = function(kind) {
    credentialEffects.push(`unexpected-reserve:${kind}`);
    throw new Error("credential reserve is outside startup verification");
  };
  CredentialStore.prototype.writeSlot = async function(slot) {
    credentialEffects.push(`unexpected-write-slot:${slot.kind}`);
    throw new Error("credential slot write is outside startup verification");
  };
  CredentialStore.prototype.readSlot = async function(slot) {
    credentialEffects.push(`read-slot:${slot.kind}`);
    return null;
  };
  CredentialStore.prototype.deleteSlot = async function(slot) {
    credentialEffects.push(`unexpected-delete-slot:${slot.kind}`);
    throw new Error("credential slot delete is outside startup verification");
  };
  CredentialStore.prototype.getOrCreateAccountHmacKey = async function() {
    credentialEffects.push("hmac");
    return new Uint8Array(hmacKey);
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/key")) {
      return new Response(JSON.stringify({
        data: {
          label: "identity fixture",
          creator_user_id: creatorId,
          is_free_tier: false,
          is_management_key: false,
          limit: null,
          limit_remaining: null,
          usage: 0,
          usage_daily: 0,
          usage_weekly: 0,
          usage_monthly: 0,
          expires_at: null,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: modelId,
          canonical_slug: modelId,
          name: "Startup identity model",
          context_length: 16_384,
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["tools"],
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected startup identity endpoint");
  }) as typeof globalThis.fetch;

  const startup = {
    appHome,
    configPath,
    migrationWarning: null,
    retentionWarnings: [],
    config,
    ruleStore: {} as never,
    session: current,
  };
  const runtime = await createDefaultProviderRuntime({
    startup,
    environment: {},
    requestedModel: modelId,
  });
  const inspected = await runtime.inspectStartup();
  assert.equal(inspected.defaultRoute?.accountFingerprint, verifiedFingerprint);
  assert.equal(
    (startup.config.providerSetup as ProviderSetupStateV1).connections[0]?.accountFingerprint,
    verifiedFingerprint,
  );
  assert.equal(startup.session.data.route?.accountFingerprint, verifiedFingerprint);
  assert.equal(await readFile(currentSeed.path, "utf8"), currentBytes);

  const resolved = await runtime.resolveLegacyDefaultRoute();
  assert.equal(resolved.defaultRoute?.resolutionState, "resolved");
  assert.deepEqual(
    (startup.config.providerSetup as ProviderSetupStateV1).defaultRoute,
    resolved.defaultRoute,
  );
  assert.equal(startup.session.data.route?.accountFingerprint, verifiedFingerprint);
  assert.equal(await readFile(currentSeed.path, "utf8"), currentBytes);
  const routeAuthority = runtime as typeof runtime & {
    migratedSessionConnection?(): ProviderConnectionStateV1 | undefined;
  };
  assert.equal(typeof routeAuthority.migratedSessionConnection, "function");
  const authoritativeConnection = routeAuthority.migratedSessionConnection?.();
  assert.equal(authoritativeConnection?.accountFingerprint, verifiedFingerprint);
  assert.equal(authoritativeConnection?.accountFingerprintState, "verified");
  const later = await SessionStore.openById(
    workspace,
    laterSeed.data.id,
    appHome,
    authoritativeConnection,
  );
  assert.equal(later.data.route?.accountFingerprint, verifiedFingerprint);
  assert.equal(await readFile(laterSeed.path, "utf8"), laterBytes);
  assert.equal(
    credentialEffects.some((effect) => effect.startsWith("unexpected-")),
    false,
  );
});

test("dashboard picker opens a second historical chat through the migrated connection and persists its route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-dashboard-migrated-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspace, appHome, "Current chat");
  current.addTurn("user", "current turn");
  await current.save();
  const historical = SessionStore.create(workspace, appHome, "Second historical chat");
  historical.setPreferences("synthetic/dashboard-historical-model", { mode: "auto" });
  historical.addTurn("user", "historical turn");
  await historical.save();
  assert.equal(historical.data.route, undefined);

  const config = structuredClone(DEFAULT_CONFIG);
  const authoritativeConnection: ProviderConnectionStateV1 = {
    id: "dashboard-migrated-openrouter",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_or_dashboard_migrated_verified",
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 10,
      generation: 4,
    },
  };
  config.providerSetup = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "migrated",
    connections: [{
      id: "dashboard-migrated-openrouter",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: "acct_legacy_dashboard-migrated-openrouter",
      accountFingerprintState: "provisional",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const transitioned: string[] = [];
  const agentSessions: string[] = [];
  const localSessions: string[] = [];
  const runtimeContext = {
    workspace,
    configPath: join(appHome, "config.json"),
    config,
    session: current,
    agent: {
      setSession(next: SessionStore) {
        agentSessions.push(next.data.id);
      },
    },
    localRuntime: {
      setSession(next: SessionStore) {
        localSessions.push(next.data.id);
      },
    },
    providerRuntime: {
      migratedSessionConnection() {
        return structuredClone(authoritativeConnection);
      },
      async transitionModel(modelId: string) {
        transitioned.push(modelId);
      },
    },
    providerRouteSurface: "fullscreen",
  };
  const loadedTurns: string[][] = [];
  const statuses: string[] = [];
  const ui = {
    async pickChoice(
      _title: string,
      items: ReadonlyArray<{ value: string; label: string }>,
    ) {
      const picked = items.find((item) => item.value === historical.data.id);
      assert.ok(picked, "second historical chat must be offered by the dashboard picker");
      return picked;
    },
    addMessage() {},
    loadTurns(turns: ReadonlyArray<{ content: string }>) {
      loadedTurns.push(turns.map((turn) => turn.content));
    },
    setStatus(message: string) {
      statuses.push(message);
    },
  };

  const switched = await pickDashboardChat(
    ui as never,
    runtimeContext as never,
    false,
  );

  assert.equal(switched, true);
  assert.equal(runtimeContext.session.data.id, historical.data.id);
  assert.deepEqual(transitioned, ["synthetic/dashboard-historical-model"]);
  assert.deepEqual(agentSessions, [historical.data.id]);
  assert.deepEqual(localSessions, [historical.data.id]);
  assert.deepEqual(loadedTurns, [["historical turn"]]);
  assert.equal(statuses.at(-1), "Chat geöffnet: Second historical chat");
  assert.deepEqual(runtimeContext.session.data.route, {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_or_dashboard_migrated_verified",
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/dashboard-historical-model",
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  });
  const persisted = await SessionStore.openById(
    workspace,
    historical.data.id,
    appHome,
  );
  assert.deepEqual(persisted.data.route, runtimeContext.session.data.route);
  assert.equal(config.providerSetup.cross.enabled, false);
});

test("dashboard proves a foreign historical route before current chat, config, or agent mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-dashboard-foreign-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const currentRoute = {
    ...bootstrapRoute("vendor/current"),
    accountFingerprint: "acct_current_dashboard_111111",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/foreign"),
    accountFingerprint: "acct_foreign_dashboard_222222",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const current = SessionStore.create(workspace, appHome, "Current exact chat");
  current.setPreferences(currentRoute.requestedModelId, { mode: "auto" }, currentRoute);
  current.addTurn("user", "current exact turn");
  await current.save();
  const currentBytes = await readFile(current.path, "utf8");
  const historical = SessionStore.create(workspace, appHome, "Foreign exact chat");
  historical.setPreferences(foreignRoute.requestedModelId, { mode: "auto" }, foreignRoute);
  historical.addTurn("user", "foreign exact turn");
  await historical.save();

  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = currentRoute.requestedModelId;
  const configBefore = structuredClone(config);
  const routeSelections: Array<Record<string, unknown>> = [];
  const agentSessions: string[] = [];
  const localSessions: string[] = [];
  const runtimeContext = {
    workspace,
    configPath: join(appHome, "config.json"),
    config,
    session: current,
    agent: { setSession(next: SessionStore) { agentSessions.push(next.data.id); } },
    localRuntime: { setSession(next: SessionStore) { localSessions.push(next.data.id); } },
    providerRuntime: {
      migratedSessionConnection() { return undefined; },
      currentSessionRoute() { return structuredClone(currentRoute); },
      async selectSessionRoute(route: Record<string, unknown>) {
        routeSelections.push(structuredClone(route));
        throw Object.assign(new Error("foreign route requires setup"), {
          code: "provider-setup-required",
        });
      },
      async transitionModel() {
        throw new Error("foreign route must not transition on the current account");
      },
    },
    providerRouteSurface: "fullscreen",
  };
  const ui = {
    async pickChoice() {
      return { value: historical.data.id, label: historical.data.title };
    },
    addMessage() {},
    loadTurns() { throw new Error("failed route proof must not load foreign turns"); },
    setStatus() { throw new Error("failed route proof must not publish a switched status"); },
  };

  await assert.rejects(
    pickDashboardChat(ui as never, runtimeContext as never, false),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "provider-setup-required"
    ),
  );

  assert.deepEqual(routeSelections, [foreignRoute]);
  assert.equal(runtimeContext.session, current);
  assert.deepEqual(runtimeContext.config, configBefore);
  assert.deepEqual(agentSessions, []);
  assert.deepEqual(localSessions, []);
  assert.equal(await readFile(current.path, "utf8"), currentBytes);
});

test("failed post-bind previous-session save cannot leave a runnable foreign binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-post-bind-save-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const routeA = {
    ...bootstrapRoute("vendor/post-bind-a"),
    accountFingerprint: "acct_post_bind_a_111111",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/post-bind-b"),
    accountFingerprint: "acct_post_bind_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV1["defaultRoute"]>,
    slot: string,
  ): ProviderConnectionStateV1 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: slot,
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  });
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [
      connection("post-bind-a", routeA, "legacy:inference"),
      connection(
        "post-bind-b",
        routeB,
        "v1:inference:67676767-6767-4767-8767-676767676767",
      ),
    ],
    defaultRoute: routeA,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const current = SessionStore.create(workspace, appHome, "Post-bind current A");
  current.setPreferences(routeA.requestedModelId, { mode: "auto" }, routeA);
  current.addTurn("user", "current A turn");
  await current.save();
  const historical = SessionStore.create(workspace, appHome, "Post-bind foreign B");
  historical.setPreferences(routeB.requestedModelId, { mode: "auto" }, routeB);
  historical.addTurn("user", "foreign B turn");
  await historical.save();
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      runWithReadyRoute<T>(run: (route: Record<string, unknown>) => Promise<T>, surface: "fullscreen"): Promise<T>;
      adoptSession(session: SessionStore): void;
      migratedSessionConnection(): undefined;
      currentSessionRoute(): Record<string, unknown>;
      selectSessionRoute(route: Record<string, unknown>, surface: "fullscreen"): Promise<Record<string, unknown>>;
      transitionModel(): Promise<void>;
    };
  }).DefaultProviderRuntime;
  const stateStore = new ProviderStateStore(initial);
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = routeA.requestedModelId;
  config.providerSetup = structuredClone(initial);
  const events: string[] = [];
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
      adapter() {
        return {
          async listModels(request: { connectionId?: string }) {
            events.push(`models:${request.connectionId}`);
            return [{
              backendId: "openrouter",
              requestedModelId: routeB.requestedModelId,
              canonicalModelId: routeB.canonicalModelId,
              displayName: "Post-bind foreign B",
              capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
            }];
          },
          async bindRuntime(request: { connectionId: string }) {
            events.push(`bind:${request.connectionId}`);
          },
        };
      },
    },
    stateStore,
    {
      async reconnect(_backendId: string, options: { connectionId?: string }) {
        events.push(`reconnect:${options.connectionId}`);
        return {
          mode: "route-choice-required",
          generation: 71,
          defaultRoute: routeA,
          readyRoutes: [routeA, routeB],
          warnings: [],
          crossEnabled: false,
        };
      },
      ensureRunnableRoute(route: Record<string, unknown>) {
        events.push(`prove:${String(route.accountFingerprint)}`);
        return route;
      },
    },
    {},
    {
      async acquire() { return { assertHeld() {}, release() {} }; },
      beginRun() { return () => undefined; },
    },
    {},
    "saved-secret",
    null,
    routeA.requestedModelId,
    config,
    current,
  );
  runtime.adoptCredentialActivation(routeA as unknown as Record<string, unknown>, true, "saved-secret");
  const saveFailure = new Error("fixed previous-session save failure");
  current.save = async () => { throw saveFailure; };
  const agentSessions: string[] = [];
  const localSessions: string[] = [];
  const context = {
    workspace,
    configPath: join(appHome, "config.json"),
    config,
    session: current,
    agent: { setSession(next: SessionStore) { agentSessions.push(next.data.id); } },
    localRuntime: { setSession(next: SessionStore) { localSessions.push(next.data.id); } },
    providerRuntime: runtime,
    providerRouteSurface: "fullscreen",
  };
  const ui = {
    async pickChoice() { return { value: historical.data.id, label: historical.data.title }; },
    addMessage() {},
    loadTurns() { throw new Error("failed handoff must not load foreign turns"); },
    setStatus() { throw new Error("failed handoff must not publish foreign status"); },
  };

  await assert.rejects(
    pickDashboardChat(ui as never, context as never, false),
    (error: unknown) => error === saveFailure,
  );

  let dispatchedRoute: Record<string, unknown> | null = null;
  let foreignModelBytes = 0;
  const runError = await runtime.runWithReadyRoute(async (route) => {
    dispatchedRoute = structuredClone(route);
    if (route.accountFingerprint === routeB.accountFingerprint) foreignModelBytes += 1;
  }, "fullscreen").then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(foreignModelBytes, 0);
  if (runError === null) {
    assert.deepEqual(dispatchedRoute, routeA);
  } else {
    assert.ok(
      runError instanceof Error
      && (runError as Error & { code?: unknown }).code === "provider-setup-required",
    );
    assert.equal(dispatchedRoute, null);
  }
  assert.equal(context.session, current);
  assert.equal(config.mainModel, routeA.requestedModelId);
  assert.deepEqual(current.data.route, routeA);
  assert.deepEqual(agentSessions, []);
  assert.deepEqual(localSessions, []);
  assert.deepEqual(events, [
    "reconnect:post-bind-b",
    `prove:${routeB.accountFingerprint}`,
    "models:post-bind-b",
    "bind:post-bind-b",
  ]);
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

test("runCli synchronizes the exact startup route into the current session before agent creation", async () => {
  const route = {
    ...bootstrapRoute("vendor/startup-exact"),
    accountFingerprint: "acct_startup_exact_333333",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const storage = bootstrapStorage();
  const preferences: unknown[][] = [];
  (storage as unknown as {
    session: { setPreferences(...args: unknown[]): void };
  }).session.setPreferences = ((...args: unknown[]) => {
    preferences.push(args);
  });
  let sessionRouteAtAgentCreation: unknown;

  const exitCode = await invokeRunCli(["--plain"], {
    initializeStorage: async () => storage,
    createProviderRuntime: async () => bootstrapRuntime({
      route: route as unknown as Record<string, unknown>,
    }),
    createAgent: async () => {
      sessionRouteAtAgentCreation = preferences.at(-1)?.[2];
      return {} as never;
    },
    runPlain: async () => undefined,
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(sessionRouteAtAgentCreation, route);
  assert.deepEqual(preferences.at(-1), [route.requestedModelId, { mode: "auto" }, route]);
});

test("late agent creation after /chat open uses selected exact session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-late-agent-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  await mkdir(workspace, { recursive: true });
  const routeA = {
    ...bootstrapRoute("vendor/startup-chat-a"),
    accountFingerprint: "acct_late_agent_a_111111",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/selected-chat-b"),
    accountFingerprint: "acct_late_agent_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const sessionA = SessionStore.create(workspace, appHome, "Startup chat A");
  sessionA.setPreferences(routeA.requestedModelId, { mode: "auto" }, routeA);
  sessionA.addTurn("user", "A remains here");
  await sessionA.save();
  const sessionB = SessionStore.create(workspace, appHome, "Selected chat B");
  sessionB.setPreferences(routeB.requestedModelId, { mode: "auto" }, routeB);
  await sessionB.save();
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = routeA.requestedModelId;
  let setupCalls = 0;
  let selectedRoute: typeof routeB | null = null;
  let selectedOwner: SessionStore = sessionA;
  let ready = false;
  const runtime = {
    openRouter: new OpenRouterService(undefined),
    credentials: {} as CredentialStore,
    preparedRoles: null,
    providerCredentials: { async apply() { return { kind: "unchanged", credentialKind: "inference" }; } },
    migratedSessionConnection() { return undefined; },
    async inspectStartup() {
      return {
        mode: "setup-required",
        generation: 1,
        defaultRoute: null,
        readyRoutes: [],
        warnings: [],
        crossEnabled: false,
      };
    },
    async resolveLegacyDefaultRoute() { throw new Error("legacy resolution must not run"); },
    async runSetup() {
      setupCalls += 1;
      if (setupCalls === 1) return { kind: "cancelled", mode: "setup-required" };
      ready = true;
      return { kind: "ready" };
    },
    ensureRunnableRoute() {
      if (!ready || !selectedRoute) {
        throw Object.assign(new Error("setup required"), { code: "provider-setup-required" });
      }
      return structuredClone(selectedRoute);
    },
    currentSessionRoute() {
      return this.ensureRunnableRoute();
    },
    async selectSessionRoute(route: typeof routeB) {
      selectedRoute = structuredClone(route);
      return structuredClone(route);
    },
    adoptSession(next: SessionStore) {
      selectedOwner = next;
    },
    async transitionModel() {},
    async execute() { throw new Error("provider command must not run"); },
    async runWithReadyRoute<T>(run: (route: typeof routeB) => Promise<T>) {
      return run(this.ensureRunnableRoute());
    },
  };
  const createdFor: string[] = [];
  const promptOwners: Array<{ sessionId: string; prompt: string }> = [];
  let agentSession: SessionStore | null = null;

  const exitCode = await invokeRunCli(["--plain", "--cwd", workspace], {
    initializeStorage: async () => ({
      appHome,
      configPath: join(appHome, "config.json"),
      migrationWarning: null,
      retentionWarnings: [],
      config,
      ruleStore: {} as never,
      session: sessionA,
    }),
    createProviderRuntime: async () => runtime,
    createAgent: async (input: { session: SessionStore }) => {
      createdFor.push(input.session.data.id);
      agentSession = input.session;
      return {
        setSession(next: SessionStore) { agentSession = next; },
        async run(prompt: string) {
          promptOwners.push({ sessionId: agentSession!.data.id, prompt });
          agentSession!.addTurn("user", prompt);
          return {};
        },
      } as never;
    },
    runPlain: async (input: Record<string, unknown>) => {
      const context = input as unknown as Omit<CommandContext<null>, "agent"> & {
        agent: { run(prompt: string): Promise<unknown> } | null;
        ensureAgentForPrompt(): Promise<{ run(prompt: string): Promise<unknown> }>;
      };
      await handleSlashCommand(`/chat open ${sessionB.data.id}`, context as never);
      context.agent = await context.ensureAgentForPrompt();
      await context.agent.run("first prompt for B");
    },
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.equal(setupCalls, 2);
  assert.equal(selectedOwner.data.id, sessionB.data.id);
  assert.deepEqual(createdFor, [sessionB.data.id]);
  assert.equal(sessionA.data.model, routeA.requestedModelId);
  assert.deepEqual(sessionA.data.route, routeA);
  assert.deepEqual(sessionA.data.turns.map((turn) => turn.content), ["A remains here"]);
  assert.equal(sessionB.data.model, routeB.requestedModelId);
  assert.deepEqual(sessionB.data.route, routeB);
  assert.deepEqual(promptOwners, [{
    sessionId: sessionB.data.id,
    prompt: "first prompt for B",
  }]);
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

test("provider account commands stay model-independent and use the catalog's sole provider handler", () => {
  for (const action of ["setup", "connect", "enable", "disable", "disconnect", "reconnect", "status", "models", "logout"]) {
    assert.equal(resolveCliCommandName(`/provider ${action} openrouter`), "provider");
    assert.equal(commandRequiresRunnableRoute("provider", [action, "openrouter"], "dashboard"), false);
  }
  assert.equal(resolveCliCommandName("/pro openrouter"), "pro");
});

test("the real provider runtime command port fences active runs and keeps Coming-soon effect-free", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime?: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      runWithReadyRoute<T>(run: (route: Record<string, unknown>) => Promise<T>): Promise<T>;
      ensureRunnableRoute(): Record<string, unknown>;
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
    };
  }).DefaultProviderRuntime;
  assert.equal(typeof Runtime, "function", "the shared runtime command boundary must be directly testable");

  let forbiddenEffects = 0;
  const comingSoonRuntime = new Runtime!(
    {},
    {},
    {
      descriptor(id: string) {
        assert.equal(id, "anthropic");
        return { id, displayName: "Anthropic / Claude-Abo", maturity: "coming-soon" };
      },
    },
    new Proxy({}, { get() { forbiddenEffects += 1; throw new Error("state read forbidden"); } }),
    new Proxy({}, { get() { forbiddenEffects += 1; throw new Error("orchestrator forbidden"); } }),
    new Proxy({}, { get() { forbiddenEffects += 1; throw new Error("coordinator forbidden"); } }),
    new Proxy({}, { get() { forbiddenEffects += 1; throw new Error("run guard forbidden"); } }),
    new Proxy({}, { get() { forbiddenEffects += 1; throw new Error("credential port forbidden"); } }),
    null,
    null,
    "openrouter/auto",
    structuredClone(DEFAULT_CONFIG),
  );
  const comingSoon = await comingSoonRuntime.execute(
    { kind: "connect", backendId: "anthropic" },
    "plain",
  );
  assert.equal(comingSoon.kind, "provider-coming-soon");
  assert.equal(forbiddenEffects, 0);

  const route = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_local_fixture_123456",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/model",
    canonicalModelId: "vendor/model",
    resolutionState: "resolved",
  } as const;
  const slot = "v1:inference:11111111-1111-4111-8111-111111111111";
  const stateStore = new ProviderStateStore({
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "connection-1",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slot,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "available",
        runtime: "not-applicable",
        observedAt: 1,
        generation: 1,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  let activeRuns = 0;
  const runtimeGuard = {
    beginRun() {
      activeRuns += 1;
      return () => { activeRuns -= 1; };
    },
  };
  const activationCoordinator = {
    async runExclusive(_request: unknown, operation: (lease: { assertHeld(): Promise<void> }) => Promise<unknown>) {
      if (activeRuns > 0) throw Object.assign(new Error("busy"), { code: "provider-runtime-not-idle" });
      return operation({
        async assertHeld() {
          if (activeRuns > 0) throw new Error("lost provider fence");
        },
      });
    },
  };
  let releaseRun!: () => void;
  const config = structuredClone(DEFAULT_CONFIG);
  const runtime = new Runtime!(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() {
        return [{
          id: "openrouter",
          displayName: "OpenRouter",
          maturity: "stable",
          connectable: true,
        }];
      },
    },
    stateStore,
    { ensureRunnableRoute: () => route },
    activationCoordinator,
    runtimeGuard,
    { async apply() { throw new Error("disable must not delete credentials"); } },
    "secret-in-memory",
    null,
    route.requestedModelId,
    config,
  );
  const disablePrompt = await runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  const active = runtime.runWithReadyRoute(async () => new Promise<void>((resolve) => {
    releaseRun = resolve;
  }));
  await assert.rejects(
    runtime.execute({
      kind: "disable",
      backendId: "openrouter",
      confirmationToken: disablePrompt.confirmationToken,
    }, "plain"),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "provider-runtime-not-idle"),
  );
  assert.equal(stateStore.read().connections[0]?.enabled, true);
  assert.equal(stateStore.read().defaultRoute?.canonicalModelId, route.canonicalModelId);

  releaseRun();
  await active;
  const disabled = await runtime.execute(
    {
      kind: "disable",
      backendId: "openrouter",
      confirmationToken: disablePrompt.confirmationToken,
    },
    "plain",
  );
  assert.equal(disabled.kind, "changed");
  assert.equal(stateStore.read().connections[0]?.enabled, false);
  assert.equal(stateStore.read().connections[0]?.credentialSlot, slot);
  assert.equal(stateStore.read().defaultRoute, null);
  assert.equal(stateStore.read().cross.enabled, false);

  const processState = new ProviderStateStore(structuredClone(DEFAULT_CONFIG.providerSetup));
  const processRuntime = new Runtime!(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() {
        return [{
          id: "openrouter",
          displayName: "OpenRouter",
          maturity: "stable",
          connectable: true,
        }];
      },
    },
    processState,
    { ensureRunnableRoute() { throw Object.assign(new Error("setup"), { code: "provider-setup-required" }); } },
    activationCoordinator,
    runtimeGuard,
    { async apply() { throw new Error("process-only disable must not delete credentials"); } },
    null,
    "process-secret",
    route.requestedModelId,
    structuredClone(DEFAULT_CONFIG),
  );
  processRuntime.adoptCredentialActivation(route, false, "process-secret");
  const processStatus = await processRuntime.execute({ kind: "status" }, "plain");
  assert.equal(processStatus.kind, "status");
  const processProvider = (processStatus.providers as Array<Record<string, unknown>>)[0];
  assert.equal(processProvider?.configuration, "enabled");
  assert.equal(processProvider?.headline, "ready");
  assert.equal(processProvider?.isDefault, true);
  assert.equal(processProvider?.accountFingerprintSuffix, "…123456");
  assert.notEqual(processProvider?.accountFingerprintSuffix, route.accountFingerprint);
  const processDisablePrompt = await processRuntime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  const processDisabled = await processRuntime.execute(
    {
      kind: "disable",
      backendId: "openrouter",
      confirmationToken: processDisablePrompt.confirmationToken,
    },
    "plain",
  );
  assert.equal(processDisabled.kind, "changed");
  assert.throws(
    () => processRuntime.ensureRunnableRoute(),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "provider-setup-required"),
  );

  let legacyCredentialEffects = 0;
  const legacyState = new ProviderStateStore({
    ...stateStore.read(),
    revision: 0,
    connections: [{
      ...stateStore.read().connections[0]!,
      enabled: true,
      credentialSlot: "legacy:inference",
    }],
    defaultRoute: route,
  });
  const legacyRuntime = new Runtime!(
    { forgetKey() {} },
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    legacyState,
    { ensureRunnableRoute: () => route },
    activationCoordinator,
    runtimeGuard,
    { async apply() { legacyCredentialEffects += 1; throw new Error("legacy slot deletion forbidden"); } },
    "legacy-secret",
    null,
    route.requestedModelId,
    structuredClone(DEFAULT_CONFIG),
  );
  const legacyLogoutPrompt = await legacyRuntime.execute(
    { kind: "logout", backendId: "openrouter" },
    "plain",
  );
  const legacyLogout = await legacyRuntime.execute(
    {
      kind: "logout",
      backendId: "openrouter",
      confirmationToken: legacyLogoutPrompt.confirmationToken,
    },
    "plain",
  );
  assert.equal(legacyLogout.kind, "changed");
  assert.equal(legacyCredentialEffects, 0);
  assert.equal(legacyState.read().connections[0]?.credentialSlot, "legacy:inference");
  assert.equal(legacyState.read().connections[0]?.enabled, false);
  assert.equal(legacyState.read().defaultRoute, null);
});

function providerCommandReviewFixture(options: {
  state?: ProviderSetupStateV1;
  route?: NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  session?: SessionStore;
} = {}) {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      ensureRunnableRoute(): Record<string, unknown>;
    };
  }).DefaultProviderRuntime;
  const route = options.route ?? {
    ...bootstrapRoute("vendor/review"),
    accountFingerprint: "acct_review_fixture_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const slot = "v1:inference:11111111-1111-4111-8111-111111111119";
  const initial = options.state ?? {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "review-connection-1",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: slot,
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  } satisfies ProviderSetupStateV1;
  let stateEffects = 0;
  let credentialEffects = 0;
  let runtimeEffects = 0;
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      stateEffects += 1;
      const current = stateStore.read();
      request.assertCurrent();
      const next = request.build(current);
      request.adopt(next);
      return next;
    },
  });
  const runtimeGuard = providerRuntimeGuardFixture();
  const coordinator = providerCoordinatorMutationFixture(runtimeGuard);
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new Runtime(
    { forgetKey() { runtimeEffects += 1; } },
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() {
        return [{
          id: "openrouter",
          displayName: "OpenRouter",
          maturity: "stable",
          connectable: true,
        }];
      },
    },
    stateStore,
    { ensureRunnableRoute: () => route },
    coordinator,
    { beginRun() { return () => undefined; } },
    {
      async apply(intent: { authorize?: () => boolean; onForgotten?: () => void }) {
        if (intent.authorize && !intent.authorize()) return { kind: "unchanged" };
        credentialEffects += 1;
        intent.onForgotten?.();
        return { kind: "forgotten" };
      },
    },
    "saved-secret",
    null,
    route.requestedModelId,
    config,
    options.session,
  );
  return {
    runtime,
    stateStore,
    config,
    route,
    slot,
    effects: () => ({ stateEffects, credentialEffects, runtimeEffects }),
  };
}

test("credential activation and key replacement synchronize the current session to the exact returned route", () => {
  const session = SessionStore.create("/synthetic/provider-route-sync", "/synthetic/.orcode");
  const oldRoute = {
    ...bootstrapRoute("vendor/old-account"),
    accountFingerprint: "acct_old_session_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  session.setPreferences(oldRoute.requestedModelId, { mode: "auto" }, oldRoute);
  const nextRoute = {
    ...bootstrapRoute("vendor/new-account"),
    accountFingerprint: "acct_new_session_222222",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const fixture = providerCommandReviewFixture({ route: nextRoute, session });

  fixture.runtime.adoptCredentialActivation(
    nextRoute as unknown as Record<string, unknown>,
    true,
    "replacement-secret",
  );

  assert.equal(session.data.model, nextRoute.requestedModelId);
  assert.deepEqual(session.data.route, nextRoute);
  assert.equal(fixture.config.mainModel, nextRoute.requestedModelId);
});

test("prepublication Cross abort cannot publish the activated route into session runtime", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(
        surface: SetupSurface,
        attempt: {
          generation: number;
          deadlineAt: number;
          signal: AbortSignal;
          remainingMs(): number;
          assertCurrent(): void;
        },
      ): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV1["defaultRoute"]>;
      readonly preparedRoles: unknown;
    };
  }).DefaultProviderRuntime;
  const main: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/cross-abort-main",
    canonicalModelId: "vendor/cross-abort-main",
    displayName: "Cross abort main",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const challenger: BackendModelDescriptor = {
    ...main,
    requestedModelId: "vendor/cross-abort-challenger",
    canonicalModelId: "vendor/cross-abort-challenger",
    displayName: "Cross abort challenger",
  };
  const route = {
    ...bootstrapRoute(main.requestedModelId),
    accountFingerprint: "acct_cross_abort_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const connection: ProviderConnectionStateV1 = {
    id: "cross-abort-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "v1:inference:15151515-1515-4151-8151-151515151515",
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  let durable = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV1;
  let publicationEntered!: () => void;
  const reachedPublication = new Promise<void>((resolve) => {
    publicationEntered = resolve;
  });
  let releasePublication!: () => void;
  const publicationRelease = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  const stateStore = new ProviderStateStore(durable, {
    persist: async (request) => {
      publicationEntered();
      await publicationRelease;
      request.assertCurrent();
      const next = request.build(durable);
      request.assertCurrent();
      durable = structuredClone(next);
      adoptDurablyCommittedProviderState(request, next);
      return structuredClone(next);
    },
  });
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async discardCandidate() {},
    async connect() {
      return {
        candidateId: "cross-abort-candidate",
        backendId: "openrouter",
        connectionId: connection.id,
        accountFingerprint: route.accountFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "ready",
          observedAt: 1,
          generation: 41,
        },
      };
    },
    async listModels() { return [main, challenger]; },
    async activate() { throw new Error("unused"); },
  };
  const descriptor: BackendDescriptor = {
    id: "openrouter",
    displayName: "OpenRouter",
    maturity: "stable",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "api-payg",
    capabilities: { models: true, tools: true, reasoning: true },
  };
  const registry = new BackendRegistry([{ descriptor, adapter }]);
  const orchestrator = {
    async cancelSetup() { return {}; },
    async activateCandidate() {
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [connection],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }, previous.revision);
      durable = structuredClone(state);
      return { persisted: true, warnings: [], state, route };
    },
    ensureRunnableRoute() {
      throw new Error("no published runtime route");
    },
  };
  let hubCalls = 0;
  let modelCalls = 0;
  const notices: string[] = [];
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : "cross-prepare";
    },
    async readSecret() { return "sk-or-v1-cross-abort-test"; },
    async chooseModel() {
      modelCalls += 1;
      return modelCalls === 1 ? main.canonicalModelId : challenger.canonicalModelId;
    },
    async confirm() { return true; },
    present(event) {
      if (event.type === "notice") notices.push(event.message);
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "vendor/original-route";
  const session = SessionStore.create("/synthetic/cross-abort-runtime", "/synthetic/.orcode");
  const runtime = new Runtime(
    {},
    {},
    registry,
    stateStore,
    orchestrator,
    {},
    { beginRun() { return () => undefined; } },
    {},
    null,
    null,
    main.requestedModelId,
    config,
    session,
  );
  const controller = new AbortController();
  const pending = runtime.runSetup(surface, {
    generation: 41,
    deadlineAt: Date.now() + 5_000,
    signal: controller.signal,
    remainingMs: () => 5_000,
    assertCurrent() {},
  });
  await reachedPublication;
  const activated = structuredClone(durable);
  const noticesAtPublication = notices.length;

  controller.abort(new DOMException("Cross role publication cancelled", "AbortError"));
  releasePublication();
  const result = await pending;

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(durable, activated);
  assert.deepEqual(stateStore.read(), activated);
  assert.equal(session.data.route, undefined);
  assert.equal(session.data.model, undefined);
  assert.equal(config.mainModel, "vendor/original-route");
  assert.equal(runtime.preparedRoles, null);
  assert.equal(notices.length, noticesAtPublication);
  assert.throws(() => runtime.ensureRunnableRoute(), /no published runtime route/);
});

test("setup postpublication abort waits for exact activation terminal reconciliation without cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-setup-postpublication-"));
  const configPath = join(root, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV1;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(initial);
  const secret = `${STARTUP_KEY_PREFIX}${"t".repeat(48)}`;
  const accountFingerprint = "acct_setup_postpublication_111111";
  const model: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/setup-postpublication",
    canonicalModelId: "vendor/setup-postpublication",
    displayName: "Setup postpublication",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const route = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint,
    billingRealm: "openrouter-payg" as const,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  const slots = new Map<string, string>();
  let reservation = 1;
  const credentials = {
    reserveSlot(kind: "inference" | "management") {
      const id = `v1:${kind}:81818181-8181-4181-8181-${String(reservation++).padStart(12, "0")}`;
      return Object.freeze({ version: 1 as const, kind, id });
    },
    async writeSlot(slot: CredentialSlotRef, value: string) { slots.set(slot.id, value); },
    async readSlot(slot: CredentialSlotRef) { return slots.get(slot.id) ?? null; },
    async deleteSlot(slot: CredentialSlotRef) { return slots.delete(slot.id); },
  };
  let runtimeRoute: typeof route | null = null;
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async connect(request) {
      assert.equal(request.candidate, secret);
      return {
        candidateId: "candidate-setup-postpublication",
        backendId: "openrouter",
        connectionId: "connection-setup-postpublication",
        accountFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "ready",
          observedAt: 1,
          generation: request.generation,
        },
      };
    },
    async listModels() { return [model]; },
    async activate(request) {
      runtimeRoute = structuredClone(route);
      return {
        candidateId: request.candidateId,
        backendId: "openrouter",
        connectionId: "connection-setup-postpublication",
        accountFingerprint,
        billingRealm: "openrouter-payg",
        route: structuredClone(route),
      };
    },
    async discardCandidate() {},
  };
  const descriptor: BackendDescriptor = {
    id: "openrouter",
    displayName: "OpenRouter",
    maturity: "stable",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "api-payg",
    capabilities: { models: true, tools: true, reasoning: true },
  };
  const registry = new BackendRegistry([{ descriptor, adapter }]);
  const runtimeGuard = providerRuntimeGuardFixture();
  let reachedReadback!: () => void;
  const readbackReached = new Promise<void>((resolve) => { reachedReadback = resolve; });
  let releaseReadback!: () => void;
  const readbackRelease = new Promise<void>((resolve) => { releaseReadback = resolve; });
  let uuid = 1;
  const coordinator = new ProviderActivationCoordinator({
    appHome: root,
    configPath,
    privateStore: new PrivateStore({ root }),
    credentials: credentials as never,
    adapter,
    stateStore,
    runtimeGuard,
    createUuid: () => `82828282-8282-4282-8282-${String(uuid++).padStart(12, "0")}`,
    onBoundary: async (boundary) => {
      if (boundary !== "config-readback") return;
      reachedReadback();
      await readbackRelease;
    },
  });
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: coordinator,
  });
  let cancelCalls = 0;
  const originalCancel = orchestrator.cancelSetup.bind(orchestrator);
  orchestrator.cancelSetup = async (request) => {
    cancelCalls += 1;
    return originalCancel(request);
  };
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(surface: SetupSurface, attempt: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const session = SessionStore.create("/synthetic/setup-postpublication", "/synthetic/.orcode");
  const runtime = new Runtime(
    new OpenRouterService(undefined),
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    runtimeGuard,
    { async apply() { throw new Error("unused"); } },
    null,
    null,
    model.requestedModelId,
    config,
    session,
  );
  const presentations: unknown[] = [];
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : "cross-later";
    },
    async readSecret() { return secret; },
    async chooseModel() { return model.canonicalModelId; },
    async confirm() { return true; },
    present(event) { presentations.push(structuredClone(event)); },
  };
  const controller = new AbortController();
  const reason = new DOMException("fixed setup postpublication abort", "AbortError");
  const pending = runtime.runSetup(surface, {
    generation: 41,
    deadlineAt: Date.now() + 5_000,
    signal: controller.signal,
    remainingMs: () => 5_000,
    assertCurrent() {
      if (controller.signal.aborted) throw reason;
    },
  });
  await readbackReached;
  const presentationsAtAbort = presentations.length;

  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stillPending = Symbol("still-pending");
  const early = await Promise.race([
    pending,
    new Promise<typeof stillPending>((resolve) => setImmediate(() => resolve(stillPending))),
  ]);
  const cancelCallsBeforeRelease = cancelCalls;
  releaseReadback();
  const result = await pending;
  const disk = (JSON.parse(await readFile(configPath, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;
  const memory = stateStore.read();
  const active = memory.connections.find((connection) => connection.enabled);

  assert.equal(early, stillPending);
  assert.equal(cancelCallsBeforeRelease, 0);
  assert.deepEqual(result, { kind: "ready" });
  assert.equal(cancelCalls, 0);
  assert.deepEqual(disk, memory);
  assert.deepEqual(memory.defaultRoute, route);
  assert.deepEqual(runtimeRoute, route);
  assert.deepEqual(session.data.route, route);
  assert.equal(session.data.model, model.requestedModelId);
  assert.equal(config.mainModel, model.requestedModelId);
  assert.equal(active?.credentialSlot === undefined ? null : slots.get(active.credentialSlot), secret);
  assert.equal(presentations.length - presentationsAtAbort, 0);
});

test("process-only setup postpublication abort reconciles the exact runtime route without cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-setup-process-postpublication-"));
  const configPath = join(root, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV1;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(initial);
  const secret = `${STARTUP_KEY_PREFIX}${"y".repeat(48)}`;
  const accountFingerprint = "acct_setup_process_postpublication_222222";
  const model: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/setup-process-postpublication",
    canonicalModelId: "vendor/setup-process-postpublication",
    displayName: "Setup process postpublication",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const route = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint,
    billingRealm: "openrouter-payg" as const,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  const slots = new Map<string, string>();
  const credentials = {
    reserveSlot(kind: "inference" | "management") {
      return Object.freeze({
        version: 1 as const,
        kind,
        id: `v1:${kind}:83838383-8383-4383-8383-838383838383`,
      });
    },
    async writeSlot(slot: CredentialSlotRef, value: string) { slots.set(slot.id, value); },
    async readSlot(slot: CredentialSlotRef) { return slots.get(slot.id) ?? null; },
    async deleteSlot(slot: CredentialSlotRef) { return slots.delete(slot.id); },
  };
  let runtimeRoute: typeof route | null = null;
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async connect(request) {
      assert.equal(request.candidate, secret);
      return {
        candidateId: "candidate-setup-process-postpublication",
        backendId: "openrouter",
        connectionId: "connection-setup-process-postpublication",
        accountFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "ready",
          observedAt: 1,
          generation: request.generation,
        },
      };
    },
    async listModels() { return [model]; },
    async activate(request) {
      runtimeRoute = structuredClone(route);
      return {
        candidateId: request.candidateId,
        backendId: "openrouter",
        connectionId: "connection-setup-process-postpublication",
        accountFingerprint,
        billingRealm: "openrouter-payg",
        route: structuredClone(route),
      };
    },
    async discardCandidate() {},
  };
  const descriptor: BackendDescriptor = {
    id: "openrouter",
    displayName: "OpenRouter",
    maturity: "stable",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "api-payg",
    capabilities: { models: true, tools: true, reasoning: true },
  };
  const registry = new BackendRegistry([{ descriptor, adapter }]);
  const runtimeGuard = providerRuntimeGuardFixture();
  let reachedRuntimeActivation!: () => void;
  const runtimeActivationReached = new Promise<void>((resolve) => {
    reachedRuntimeActivation = resolve;
  });
  let releaseRuntimeActivation!: () => void;
  const runtimeActivationRelease = new Promise<void>((resolve) => {
    releaseRuntimeActivation = resolve;
  });
  let coordinator!: ProviderActivationCoordinator;
  const credentialAuthority = new ProviderCredentialAuthority({
    stateStore,
    credentials: credentials as never,
    environment: { OPENROUTER_API_KEY: secret },
    coordinator: () => coordinator,
  });
  let uuid = 1;
  coordinator = new ProviderActivationCoordinator({
    appHome: root,
    configPath,
    privateStore: new PrivateStore({ root }),
    credentials: credentials as never,
    adapter,
    stateStore,
    runtimeGuard,
    candidateAuthority: credentialAuthority,
    createUuid: () => `84848484-8484-4484-8484-${String(uuid++).padStart(12, "0")}`,
    onBoundary: async (boundary) => {
      if (boundary !== "runtime-activated") return;
      reachedRuntimeActivation();
      await runtimeActivationRelease;
    },
  });
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: coordinator,
  });
  let cancelCalls = 0;
  const originalCancel = orchestrator.cancelSetup.bind(orchestrator);
  orchestrator.cancelSetup = async (request) => {
    cancelCalls += 1;
    return originalCancel(request);
  };
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(surface: SetupSurface, attempt: Record<string, unknown>): Promise<Record<string, unknown>>;
      currentSessionRoute(): typeof route;
    };
  }).DefaultProviderRuntime;
  const session = SessionStore.create(
    "/synthetic/setup-process-postpublication",
    "/synthetic/.orcode",
  );
  const runtime = new Runtime(
    new OpenRouterService(undefined),
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    runtimeGuard,
    { async apply() { throw new Error("unused"); } },
    null,
    secret,
    model.requestedModelId,
    config,
    session,
    {
      credentialAuthority,
      adapter: adapter as never,
      async recover() {},
    },
  );
  const surface: SetupSurface = {
    async chooseHub() { return "cross-later"; },
    async readSecret() { throw new Error("environment setup must not prompt for a secret"); },
    async chooseModel() { return model.canonicalModelId; },
    async confirm() { throw new Error("process-only setup must not ask for persistence"); },
    present() {},
  };
  const controller = new AbortController();
  const reason = new DOMException("fixed process-only setup postpublication abort", "AbortError");
  const pending = runtime.runSetup(surface, {
    generation: 51,
    deadlineAt: Date.now() + 5_000,
    signal: controller.signal,
    remainingMs: () => 5_000,
    assertCurrent() {
      if (controller.signal.aborted) throw reason;
    },
  });
  await runtimeActivationReached;

  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stillPending = Symbol("still-pending");
  const early = await Promise.race([
    pending,
    new Promise<typeof stillPending>((resolve) => setImmediate(() => resolve(stillPending))),
  ]);
  const cancelCallsBeforeRelease = cancelCalls;
  releaseRuntimeActivation();
  const result = await pending;
  const disk = (JSON.parse(await readFile(configPath, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;

  assert.equal(early, stillPending);
  assert.equal(cancelCallsBeforeRelease, 0);
  assert.deepEqual(result, { kind: "ready" });
  assert.equal(cancelCalls, 0);
  assert.deepEqual(disk, initial);
  assert.deepEqual(stateStore.read(), initial);
  assert.deepEqual(config.providerSetup, initial);
  assert.deepEqual(runtimeRoute, route);
  assert.deepEqual(session.data.route, route);
  assert.equal(session.data.model, model.requestedModelId);
  assert.equal(config.mainModel, model.requestedModelId);
  assert.deepEqual(runtime.currentSessionRoute(), route);
  assert.equal(slots.size, 0);
});

test("late Cross completion after newer activation cannot republish the old route or session owner", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(surface: SetupSurface): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV1["defaultRoute"]>;
      adoptCredentialActivation(
        route: NonNullable<ProviderSetupStateV1["defaultRoute"]>,
        persisted: boolean,
        secret: string,
      ): void;
    };
  }).DefaultProviderRuntime;
  const main: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/cross-a",
    canonicalModelId: "vendor/cross-a",
    displayName: "Cross A",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const challenger: BackendModelDescriptor = {
    ...main,
    requestedModelId: "vendor/cross-a-challenger",
    canonicalModelId: "vendor/cross-a-challenger",
    displayName: "Cross A challenger",
  };
  const descriptor: BackendDescriptor = {
    id: "openrouter",
    displayName: "OpenRouter",
    maturity: "stable",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "api-payg",
    capabilities: { models: true, tools: true, reasoning: true },
  };
  const routeA = {
    ...bootstrapRoute(main.requestedModelId),
    accountFingerprint: "acct_cross_old_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/cross-b"),
    accountFingerprint: "acct_cross_new_222222",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const connection = (
    id: string,
    accountFingerprint: string,
    credentialSlot: string,
  ): ProviderConnectionStateV1 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot,
    accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  });
  const connectionA = connection(
    "cross-connection-a",
    routeA.accountFingerprint,
    "v1:inference:13131313-1313-4131-8131-131313131313",
  );
  const connectionB = connection(
    "cross-connection-b",
    routeB.accountFingerprint,
    "v1:inference:14141414-1414-4141-8141-141414141414",
  );
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async discardCandidate() {},
    async connect() {
      return {
        candidateId: "cross-candidate-a",
        backendId: "openrouter",
        connectionId: connectionA.id,
        accountFingerprint: routeA.accountFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "ready",
          observedAt: 1,
          generation: 1,
        },
      };
    },
    async listModels() { return [main, challenger]; },
    async activate() { throw new Error("unused"); },
  };
  const registry = new BackendRegistry([{ descriptor, adapter }]);
  const stateStore = new ProviderStateStore(structuredClone(DEFAULT_CONFIG.providerSetup));
  let runtimeAccount: string | null = null;
  const orchestrator = {
    async cancelSetup() { return {}; },
    async activateCandidate() {
      const before = stateStore.read();
      const state = stateStore.replace({
        ...before,
        lifecycle: "configured",
        connections: [connectionA],
        defaultRoute: routeA,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }, before.revision);
      runtimeAccount = routeA.accountFingerprint;
      return { persisted: true, warnings: [], state, route: routeA };
    },
    ensureRunnableRoute(route: NonNullable<ProviderSetupStateV1["defaultRoute"]>) {
      return structuredClone(route);
    },
  };
  let resolveCross!: (value: string | null) => void;
  let crossStarted!: () => void;
  const reachedCross = new Promise<void>((resolve) => { crossStarted = resolve; });
  let hubCalls = 0;
  let modelCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      if (hubCalls === 1) return "openrouter";
      crossStarted();
      return new Promise<string | null>((resolve) => { resolveCross = resolve; });
    },
    async readSecret() { return "sk-or-v1-cross-test"; },
    async chooseModel() {
      modelCalls += 1;
      return modelCalls === 1 ? main.canonicalModelId : challenger.canonicalModelId;
    },
    async confirm() { return true; },
    present() {},
  };
  const config = structuredClone(DEFAULT_CONFIG);
  const session = SessionStore.create("/synthetic/cross-generation", "/synthetic/.orcode");
  const runtime = new Runtime(
    {},
    {},
    registry,
    stateStore,
    orchestrator,
    {},
    { beginRun() { return () => undefined; } },
    {},
    null,
    null,
    main.requestedModelId,
    config,
    session,
  );

  const pending = runtime.runSetup(surface);
  await reachedCross;
  const activatedA = stateStore.read();
  stateStore.replace({
    ...activatedA,
    connections: [connectionA, connectionB],
    defaultRoute: routeB,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  }, activatedA.revision);
  runtimeAccount = routeB.accountFingerprint;
  runtime.adoptCredentialActivation(routeB, true, "newer-process-secret");
  resolveCross("cross-prepare");
  const result = await pending;

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(stateStore.read().defaultRoute?.accountFingerprint, routeB.accountFingerprint);
  assert.equal(stateStore.read().cross.preferredLead, null);
  assert.equal(runtime.ensureRunnableRoute().accountFingerprint, routeB.accountFingerprint);
  assert.equal(session.data.route?.accountFingerprint, routeB.accountFingerprint);
  assert.equal(runtimeAccount, routeB.accountFingerprint);
});

test("reconnect synchronizes the current session to the exact rebound route", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const route = {
    ...bootstrapRoute("vendor/reconnect-exact"),
    accountFingerprint: "acct_reconnect_exact_333333",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const state: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "reconnect-exact-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  const session = SessionStore.create("/synthetic/reconnect-route-sync", "/synthetic/.orcode");
  const staleRoute = {
    ...route,
    requestedModelId: "vendor/stale-session",
    canonicalModelId: "vendor/stale-session",
  };
  session.setPreferences(staleRoute.requestedModelId, { mode: "auto" });
  const bindingCalls: unknown[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(state);
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
      adapter() {
        return {
          async bindRuntime(request: unknown) { bindingCalls.push(structuredClone(request)); },
        };
      },
    },
    stateStore,
    {
      async reconnect() {
        return {
          mode: "ready",
          generation: 31,
          defaultRoute: route,
          readyRoutes: [route],
          warnings: [],
          crossEnabled: false,
        };
      },
      ensureRunnableRoute() { return route; },
    },
    {},
    {
      async acquire() {
        return {
          assertHeld() {},
          release() {},
        };
      },
      beginRun() { return () => undefined; },
    },
    {},
    "saved-secret",
    null,
    route.requestedModelId,
    config,
    session,
  );

  const result = await runtime.execute({ kind: "reconnect", backendId: "openrouter" }, "plain");

  assert.equal(result.kind, "reconnected");
  assert.equal(bindingCalls.length, 1);
  assert.equal(session.data.model, route.requestedModelId);
  assert.deepEqual(session.data.route, route);
  assert.equal(config.mainModel, route.requestedModelId);
});

test("reconnect repairs persisted foreign route when runtime projection is empty", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): Record<string, unknown>;
    };
  }).DefaultProviderRuntime;
  const routeA = {
    ...bootstrapRoute("vendor/reconnect-default-a"),
    accountFingerprint: "acct_reconnect_default_a_111111",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/reconnect-persisted-b"),
    accountFingerprint: "acct_reconnect_persisted_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV1["defaultRoute"]>,
    slot: string,
  ): ProviderConnectionStateV1 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: slot,
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  });
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [
      connection("reconnect-default-a", routeA, "legacy:inference"),
      connection(
        "reconnect-persisted-b",
        routeB,
        "v1:inference:78787878-7878-4787-8787-787878787878",
      ),
    ],
    defaultRoute: routeA,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(initial);
  const session = SessionStore.create("/synthetic/reconnect-persisted-foreign", "/synthetic/.orcode");
  session.setPreferences(routeB.requestedModelId, { mode: "auto" }, routeB);
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = routeA.requestedModelId;
  config.providerSetup = structuredClone(initial);
  const events: string[] = [];
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
      adapter() {
        return {
          async listModels(request: { connectionId?: string }) {
            events.push(`models:${request.connectionId}`);
            return [{
              backendId: "openrouter",
              requestedModelId: routeB.requestedModelId,
              canonicalModelId: routeB.canonicalModelId,
              displayName: "Reconnect persisted B",
              capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
            }];
          },
          async bindRuntime(request: { connectionId: string }) {
            events.push(`bind:${request.connectionId}`);
          },
        };
      },
    },
    stateStore,
    {
      async reconnect(_backendId: string, options: { connectionId?: string }) {
        events.push(`reconnect:${options.connectionId}`);
        return {
          mode: "route-choice-required",
          generation: 81,
          defaultRoute: routeA,
          readyRoutes: [routeA, routeB],
          warnings: [],
          crossEnabled: false,
        };
      },
      ensureRunnableRoute(route: Record<string, unknown>) {
        events.push(`prove:${String(route.accountFingerprint)}`);
        return route;
      },
    },
    {},
    {
      async acquire() { return { assertHeld() {}, release() {} }; },
      beginRun() { return () => undefined; },
    },
    {},
    "saved-secret",
    null,
    routeA.requestedModelId,
    config,
    session,
  );

  const result = await runtime.execute(
    { kind: "reconnect", backendId: "openrouter" },
    "plain",
  );

  assert.equal(result.kind, "reconnected");
  assert.deepEqual(events, [
    "reconnect:reconnect-persisted-b",
    `prove:${routeB.accountFingerprint}`,
    "models:reconnect-persisted-b",
    "bind:reconnect-persisted-b",
  ]);
  assert.deepEqual(runtime.ensureRunnableRoute(), routeB);
  assert.deepEqual(session.data.route, routeB);
  assert.equal(config.mainModel, routeB.requestedModelId);
});

test("historical route selection proves catalogs and binds the exact foreign connection before session adoption", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      selectSessionRoute(route: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): Record<string, unknown>;
      adoptSession(session: SessionStore): void;
    };
  }).DefaultProviderRuntime;
  const currentRoute = {
    ...bootstrapRoute("vendor/current-exact"),
    accountFingerprint: "acct_selection_current_111111",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/foreign-exact"),
    accountFingerprint: "acct_selection_foreign_222222",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV1["defaultRoute"]>,
    slot: string,
  ) => ({
    id,
    backendId: "openrouter" as const,
    enabled: true,
    maturity: "stable" as const,
    credentialSlot: slot,
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: "openrouter-payg" as const,
    lastHealth: null,
  });
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [
      connection("selection-current", currentRoute, "legacy:inference"),
      connection(
        "selection-foreign",
        foreignRoute,
        "v1:inference:34343434-3434-4343-8343-343434343434",
      ),
    ],
    defaultRoute: currentRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const events: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = currentRoute.requestedModelId;
  config.providerSetup = structuredClone(initial);
  const originalSession = SessionStore.create("/synthetic/route-selection", "/synthetic/.orcode");
  originalSession.setPreferences(currentRoute.requestedModelId, { mode: "auto" }, currentRoute);
  const targetSession = SessionStore.create("/synthetic/route-selection", "/synthetic/.orcode");
  targetSession.setPreferences(foreignRoute.requestedModelId, { mode: "auto" }, foreignRoute);
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
      adapter() {
        return {
          async listModels(request: { connectionId?: string }) {
            events.push(`models:${request.connectionId}`);
            return [{
              backendId: "openrouter",
              requestedModelId: foreignRoute.requestedModelId,
              canonicalModelId: foreignRoute.canonicalModelId,
              displayName: "Foreign exact",
              capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
            }];
          },
          async bindRuntime(request: { connectionId: string; generation: number }) {
            events.push(`bind:${request.connectionId}:${request.generation}`);
          },
        };
      },
    },
    new ProviderStateStore(initial),
    {
      async reconnect(_backendId: string, options: { connectionId?: string }) {
        events.push(`reconnect:${options.connectionId}`);
        return {
          mode: "route-choice-required",
          generation: 44,
          defaultRoute: currentRoute,
          readyRoutes: [foreignRoute],
          warnings: [],
          crossEnabled: false,
        };
      },
      ensureRunnableRoute(route: Record<string, unknown>) {
        events.push(`prove:${String(route.accountFingerprint)}`);
        return route;
      },
    },
    {},
    {
      async acquire() {
        return { assertHeld() {}, release() {} };
      },
      beginRun() { return () => undefined; },
    },
    {},
    "saved-secret",
    null,
    currentRoute.requestedModelId,
    config,
    originalSession,
  );

  const selected = await runtime.selectSessionRoute(
    foreignRoute as unknown as Record<string, unknown>,
    "plain",
  );

  assert.deepEqual(selected, foreignRoute);
  assert.throws(
    () => runtime.ensureRunnableRoute(),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "provider-setup-required"
    ),
  );
  assert.deepEqual(originalSession.data.route, currentRoute);
  assert.equal(config.mainModel, currentRoute.requestedModelId);
  runtime.adoptSession(targetSession);
  assert.deepEqual(runtime.ensureRunnableRoute(), foreignRoute);
  assert.deepEqual(targetSession.data.route, foreignRoute);
  assert.deepEqual(events, [
    "reconnect:selection-foreign",
    `prove:${foreignRoute.accountFingerprint}`,
    "models:selection-foreign",
    "bind:selection-foreign:44",
  ]);
});

test("failed startup proof for a foreign current session cannot fall back to the runnable default account", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      inspectStartup(): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): Record<string, unknown>;
    };
  }).DefaultProviderRuntime;
  const currentRoute = {
    ...bootstrapRoute("vendor/startup-current"),
    accountFingerprint: "acct_startup_current_555555",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/startup-foreign"),
    accountFingerprint: "acct_startup_foreign_666666",
  } as unknown as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [
      {
        id: "startup-current-connection",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialSlot: "legacy:inference",
        accountFingerprint: currentRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      },
      {
        id: "startup-foreign-connection",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialSlot: "v1:inference:56565656-5656-4565-8565-565656565656",
        accountFingerprint: foreignRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      },
    ],
    defaultRoute: currentRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const session = SessionStore.create("/synthetic/startup-foreign", "/synthetic/.orcode");
  session.setPreferences(foreignRoute.requestedModelId, { mode: "auto" }, foreignRoute);
  const stateStore = new ProviderStateStore(initial);
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const orchestrator = {
    nextStartupGeneration() { return 1; },
    async inspectStartup() {
      return {
        mode: "ready",
        generation: 1,
        defaultRoute: currentRoute,
        readyRoutes: [currentRoute, foreignRoute],
        warnings: [],
        crossEnabled: false,
      };
    },
    ensureRunnableRoute(requested?: Record<string, unknown>) {
      return requested ?? currentRoute;
    },
  };
  const runtime = new Runtime(
    {},
    {},
    { entries() { return []; } },
    stateStore,
    orchestrator,
    {},
    { beginRun() { return () => undefined; } },
    {},
    "saved-secret",
    null,
    currentRoute.requestedModelId,
    config,
    session,
    {
      credentialAuthority: {},
      adapter: {
        async listModels() { return []; },
        async bindRuntime() { throw new Error("model proof must fail before bind"); },
      },
      async recover() {},
    },
  );

  const inspected = await runtime.inspectStartup();

  assert.equal(inspected.mode, "setup-required");
  assert.throws(
    () => runtime.ensureRunnableRoute(),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error
      && error.code === "provider-setup-required"
    ),
  );
  assert.deepEqual(session.data.route, foreignRoute);
  assert.equal(config.mainModel, DEFAULT_CONFIG.mainModel);
});

test("provider confirmation tokens bind every destructive intent to the exact fenced provider identity", async () => {
  for (const operation of ["disable", "disconnect", "logout"] as const) {
    const fixture = providerCommandReviewFixture();
    const requested = await fixture.runtime.execute(
      { kind: operation, backendId: "openrouter" },
      "plain",
    );
    assert.equal(requested.kind, "confirmation-required");
    const token = requested.confirmationToken;
    assert.equal(typeof token, "string");
    if (typeof token !== "string") throw new Error("confirmation token missing");
    assert.ok(token.length >= 16);
    assert.doesNotMatch(token, /review|connection|inference|acct|vendor|111111/i);

    const replacementRoute = {
      ...fixture.route,
      accountFingerprint: "acct_replacement_fixture_222222",
      requestedModelId: "vendor/replacement",
      canonicalModelId: "vendor/replacement",
    };
    fixture.stateStore.replace({
      ...fixture.stateStore.read(),
      connections: [{
        ...fixture.stateStore.read().connections[0]!,
        id: "replacement-connection",
        credentialSlot: "v1:inference:22222222-2222-4222-8222-222222222222",
        accountFingerprint: replacementRoute.accountFingerprint,
      }],
      defaultRoute: replacementRoute,
    }, 0);
    const beforeAccept = fixture.stateStore.read();
    const stale = await fixture.runtime.execute(
      { kind: operation, backendId: "openrouter", confirmationToken: token },
      "plain",
    );
    assert.equal(stale.kind, "confirmation-required");
    assert.equal(typeof stale.confirmationToken, "string");
    assert.notEqual(stale.confirmationToken, token);
    assert.deepEqual(fixture.stateStore.read(), beforeAccept);
    assert.deepEqual(fixture.effects(), {
      stateEffects: 0,
      credentialEffects: 0,
      runtimeEffects: 0,
    });
  }

  const replayFixture = providerCommandReviewFixture();
  const replayPrompt = await replayFixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  assert.equal(replayPrompt.kind, "confirmation-required");
  const replayToken = replayPrompt.confirmationToken;
  const changed = await replayFixture.runtime.execute(
    { kind: "disable", backendId: "openrouter", confirmationToken: replayToken },
    "plain",
  );
  assert.equal(changed.kind, "changed");
  const effectsAfterChange = replayFixture.effects();
  const replayed = await replayFixture.runtime.execute(
    { kind: "disable", backendId: "openrouter", confirmationToken: replayToken },
    "plain",
  );
  assert.equal(replayed.kind, "confirmation-required");
  assert.notEqual(replayed.confirmationToken, replayToken);
  assert.deepEqual(replayFixture.effects(), effectsAfterChange);

  const crossOperationFixture = providerCommandReviewFixture();
  const crossPrompt = await crossOperationFixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  const crossOperation = await crossOperationFixture.runtime.execute(
    {
      kind: "disconnect",
      backendId: "openrouter",
      confirmationToken: crossPrompt.confirmationToken,
    },
    "plain",
  );
  assert.equal(crossOperation.kind, "confirmation-required");
  assert.deepEqual(crossOperationFixture.effects(), {
    stateEffects: 0,
    credentialEffects: 0,
    runtimeEffects: 0,
  });

  const processFixture = providerCommandReviewFixture({
    state: structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV1,
  });
  processFixture.runtime.adoptCredentialActivation(
    processFixture.route as unknown as Record<string, unknown>,
    false,
    "process-secret",
  );
  const processPrompt = await processFixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  processFixture.runtime.adoptCredentialActivation(
    processFixture.route as unknown as Record<string, unknown>,
    false,
    "replacement-process-secret",
  );
  const staleProcess = await processFixture.runtime.execute(
    {
      kind: "disable",
      backendId: "openrouter",
      confirmationToken: processPrompt.confirmationToken,
    },
    "plain",
  );
  assert.equal(staleProcess.kind, "confirmation-required");
  assert.deepEqual(processFixture.runtime.ensureRunnableRoute(), processFixture.route);
  assert.deepEqual(processFixture.effects(), {
    stateEffects: 0,
    credentialEffects: 0,
    runtimeEffects: 0,
  });
});

test("logout forgets a disabled versioned connection through the restart-safe journal without touching preserved slots", async () => {
  const fixture = await providerForgetActivationFixture();
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const registry = {
    descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
    entries() { return []; },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = fixture.stateStore.read();
  const runtime = new Runtime(
    fixture.openRouter,
    fixture.credentials,
    registry,
    fixture.stateStore,
    { ensureRunnableRoute: () => fixture.route },
    fixture.coordinator,
    { beginRun() { return () => undefined; } },
    fixture.controller,
    fixture.oldSecret,
    null,
    fixture.route.requestedModelId,
    config,
  );

  const disablePrompt = await runtime.execute({ kind: "disable", backendId: "openrouter" }, "plain");
  const disabled = await runtime.execute({
    kind: "disable",
    backendId: "openrouter",
    confirmationToken: disablePrompt.confirmationToken,
  }, "plain");
  assert.equal(disabled.kind, "changed");
  assert.equal(fixture.stateStore.read().connections[0]?.enabled, false);

  const logoutPrompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  await assert.rejects(
    runtime.execute({
      kind: "logout",
      backendId: "openrouter",
      confirmationToken: logoutPrompt.confirmationToken,
    }, "plain"),
    /cleanup is pending/i,
  );
  assert.deepEqual(await fixture.journal.readPending(), {
    phase: "prepared",
    target: {
      kind: "versioned",
      slot: { version: 1, kind: "inference", id: fixture.oldSlotId },
    },
  });
  assert.equal(fixture.slots.has(fixture.oldSlotId), true);

  fixture.allowOldSlotDelete();
  const durable = (JSON.parse(await readFile(fixture.configPath, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;
  const restartedStore = new ProviderStateStore(durable, {
    persist: (request) => fixture.api.persistProviderSetupState(fixture.configPath, request),
  });
  const restartedGuard = providerRuntimeGuardFixture();
  const restartedCoordinator = new ProviderActivationCoordinator({
    appHome: fixture.root,
    configPath: fixture.configPath,
    privateStore: new PrivateStore({ root: fixture.root }),
    credentials: fixture.credentials as never,
    adapter: fixture.adapter as never,
    stateStore: restartedStore,
    runtimeGuard: restartedGuard,
  });
  const restartedJournal = new fixture.api.ProviderCredentialForgetJournal({
    appHome: fixture.root,
    privateStore: new PrivateStore({ root: fixture.root }),
  });
  const restartedOpenRouter = new OpenRouterService(fixture.oldSecret);
  const restartedController = fixture.api.createProviderCredentialController({
    stateStore: restartedStore,
    openRouter: restartedOpenRouter,
    credentials: fixture.credentials,
    activationCoordinator: restartedCoordinator,
    forgetJournal: restartedJournal,
  });
  const restartedConfig = structuredClone(DEFAULT_CONFIG);
  restartedConfig.providerSetup = restartedStore.read();
  const restartedRuntime = new Runtime(
    restartedOpenRouter,
    fixture.credentials,
    registry,
    restartedStore,
    { ensureRunnableRoute() { throw new Error("disabled route is not runnable"); } },
    restartedCoordinator,
    { beginRun() { return () => undefined; } },
    restartedController,
    fixture.oldSecret,
    null,
    fixture.route.requestedModelId,
    restartedConfig,
  );
  const retryPrompt = await restartedRuntime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const loggedOut = await restartedRuntime.execute({
    kind: "logout",
    backendId: "openrouter",
    confirmationToken: retryPrompt.confirmationToken,
  }, "plain");
  assert.equal(loggedOut.kind, "changed");
  assert.equal(loggedOut.defaultCleared, false);
  assert.equal(fixture.slots.has(fixture.oldSlotId), false);
  assert.deepEqual(restartedStore.read().connections, []);
  assert.equal(await restartedJournal.readPending(), null);
  assert.equal(restartedOpenRouter.hasKey, false);
});

test("provider status treats disabled health as historical and prefers the active process route", async () => {
  const route = {
    ...bootstrapRoute("vendor/status"),
    accountFingerprint: "acct_status_old_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const staleState: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: "disabled-status-connection",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialSlot: "v1:inference:33333333-3333-4333-8333-333333333333",
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "available",
        runtime: "ready",
        observedAt: 1,
        generation: 1,
      },
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const disabledFixture = providerCommandReviewFixture({ state: staleState, route });
  const disabledStatus = await disabledFixture.runtime.execute({ kind: "status" }, "plain");
  const disabledProvider = (disabledStatus.providers as Array<Record<string, unknown>>)[0];
  assert.equal(disabledProvider?.configuration, "disabled");
  assert.equal(disabledProvider?.headline, null);
  assert.equal(disabledProvider?.health, null);
  assert.equal(disabledProvider?.accountFingerprintSuffix, null);
  assert.equal(disabledProvider?.isDefault, false);

  const processRoute = {
    ...route,
    accountFingerprint: "acct_status_process_222222",
    requestedModelId: "vendor/process-status",
    canonicalModelId: "vendor/process-status",
  };
  const processFixture = providerCommandReviewFixture({ state: staleState, route: processRoute });
  processFixture.runtime.adoptCredentialActivation(processRoute, false, "process-secret");
  const processStatus = await processFixture.runtime.execute({ kind: "status" }, "plain");
  const processProvider = (processStatus.providers as Array<Record<string, unknown>>)[0];
  assert.equal(processProvider?.configuration, "enabled");
  assert.equal(processProvider?.headline, "ready");
  assert.deepEqual(processProvider?.health, {
    credential: "valid",
    connectivity: "connected",
    spend: "unknown",
    runtime: "not-applicable",
  });
  assert.equal(processProvider?.accountFingerprintSuffix, "…222222");
  assert.equal(processProvider?.isDefault, true);
});

for (const operation of ["disable", "disconnect"] as const) {
  test(`provider ${operation} rejects same-revision authoritative identity replacement before mutation`, async () => {
    const route = {
      ...bootstrapRoute(`vendor/${operation}`),
      accountFingerprint: `acct_${operation}_approved_111111`,
    } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
    const approved: ProviderSetupStateV1 = {
      schemaVersion: 1,
      revision: 0,
      lifecycle: "configured",
      connections: [{
        id: `${operation}-connection`,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialSlot: "v1:inference:44444444-4444-4444-8444-444444444444",
        accountFingerprint: route.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      }],
      defaultRoute: route,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    const replacementRoute = {
      ...route,
      accountFingerprint: `acct_${operation}_replacement_222222`,
      requestedModelId: `vendor/${operation}-replacement`,
      canonicalModelId: `vendor/${operation}-replacement`,
    };
    const replacement: ProviderSetupStateV1 = {
      ...structuredClone(approved),
      connections: [{
        ...approved.connections[0]!,
        credentialSlot: "v1:inference:55555555-5555-4555-8555-555555555555",
        accountFingerprint: replacementRoute.accountFingerprint,
      }],
      defaultRoute: replacementRoute,
    };
    const root = await mkdtemp(join(tmpdir(), `orcode-provider-${operation}-authority-`));
    const configPath = join(root, "config.json");
    const diskConfig = structuredClone(DEFAULT_CONFIG);
    diskConfig.providerSetup = structuredClone(replacement);
    await saveConfig(diskConfig, configPath);
    const stateStore = new ProviderStateStore(approved, {
      persist: (request) => cliModule.persistProviderSetupState(configPath, request),
    });
    const Runtime = (cliModule as unknown as {
      DefaultProviderRuntime: new (...args: unknown[]) => {
        execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      };
    }).DefaultProviderRuntime;
    const config = structuredClone(DEFAULT_CONFIG);
    config.providerSetup = structuredClone(approved);
    const runtime = new Runtime(
      { forgetKey() { throw new Error("runtime forget forbidden"); } },
      {},
      {
        descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
        entries() { return []; },
      },
      stateStore,
      { ensureRunnableRoute: () => route },
      providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
      { beginRun() { return () => undefined; } },
      { async apply() { throw new Error("credential effect forbidden"); } },
      "approved-secret",
      null,
      route.requestedModelId,
      config,
    );

    const prompt = await runtime.execute({ kind: operation, backendId: "openrouter" }, "plain");
    const result = await runtime.execute({
      kind: operation,
      backendId: "openrouter",
      confirmationToken: prompt.confirmationToken,
    }, "plain");

    assert.equal(result.kind, "confirmation-required");
    assert.notEqual(result.confirmationToken, prompt.confirmationToken);
    const readback = (JSON.parse(await readFile(configPath, "utf8")) as {
      providerSetup: ProviderSetupStateV1;
    }).providerSetup;
    assert.deepEqual(readback, replacement);
    assert.equal(config.providerSetup.connections[0]?.enabled, true);
  });
}

test("legacy logout rechecks the retained confirmation inside authoritative commit for same-revision replacements", async (t) => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const approvedRoute = {
    ...bootstrapRoute("vendor/legacy-approved"),
    accountFingerprint: "acct_legacy_approved_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const approved: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-authoritative-target",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: approvedRoute.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: approvedRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const replacements: Array<{ name: string; state: ProviderSetupStateV1 }> = [
    {
      name: "fingerprint",
      state: {
        ...structuredClone(approved),
        connections: [{
          ...approved.connections[0]!,
          accountFingerprint: "acct_legacy_replacement_222222",
        }],
        defaultRoute: {
          ...approvedRoute,
          accountFingerprint: "acct_legacy_replacement_222222",
        },
      },
    },
    {
      name: "credential slot",
      state: {
        ...structuredClone(approved),
        connections: [{
          ...approved.connections[0]!,
          credentialSlot: "v1:inference:12121212-1212-4121-8121-121212121212",
        }],
      },
    },
    {
      name: "default route",
      state: {
        ...structuredClone(approved),
        defaultRoute: {
          ...approvedRoute,
          requestedModelId: "vendor/legacy-replacement",
          canonicalModelId: "vendor/legacy-replacement",
        },
      },
    },
    {
      name: "backend and billing realm",
      state: {
        ...structuredClone(approved),
        connections: [{
          ...approved.connections[0]!,
          backendId: "codex",
          maturity: "preview",
          accountFingerprint: "acct_codex_replacement_333333",
          billingRealm: "chatgpt-account-provider-managed-limits",
        }],
        defaultRoute: {
          ...approvedRoute,
          backendId: "codex",
          accountFingerprint: "acct_codex_replacement_333333",
          billingRealm: "chatgpt-account-provider-managed-limits",
        },
      },
    },
  ];

  for (const replacement of replacements) {
    await t.test(replacement.name, async () => {
      let durable = structuredClone(replacement.state);
      let buildCalls = 0;
      let adoptCalls = 0;
      let runtimeForgets = 0;
      const stateStore = new ProviderStateStore(approved, {
        persist: async (request) => {
          request.assertCurrent();
          buildCalls += 1;
          const next = request.build(structuredClone(durable));
          durable = structuredClone(next);
          request.adopt(next);
          adoptCalls += 1;
          return structuredClone(next);
        },
      });
      const config = structuredClone(DEFAULT_CONFIG);
      config.providerSetup = structuredClone(approved);
      const runtime = new Runtime(
        { forgetKey() { runtimeForgets += 1; } },
        {},
        {
          descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
          entries() { return []; },
        },
        stateStore,
        { ensureRunnableRoute: () => approvedRoute },
        providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
        { beginRun() { return () => undefined; } },
        { async apply() { throw new Error("legacy logout must not call versioned credential cleanup"); } },
        "legacy-secret",
        null,
        approvedRoute.requestedModelId,
        config,
      );

      const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
      const result = await runtime.execute({
        kind: "logout",
        backendId: "openrouter",
        confirmationToken: prompt.confirmationToken,
      }, "plain");

      assert.equal(result.kind, "confirmation-required");
      assert.notEqual(result.confirmationToken, prompt.confirmationToken);
      assert.equal(buildCalls, 1);
      assert.equal(adoptCalls, 0);
      assert.equal(runtimeForgets, 0);
      assert.deepEqual(durable, replacement.state);
      assert.deepEqual(stateStore.read(), approved);
      assert.deepEqual(config.providerSetup, approved);
    });
  }
});

test("disabled legacy logout forgets runtime only after exact durable commit readback", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "disabled-legacy-readback",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: "acct_disabled_legacy_444444",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const effects: string[] = [];
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      request.assertCurrent();
      effects.push("build");
      const next = request.build(stateStore.read());
      effects.push("adopt");
      request.adopt(next);
      effects.push("readback");
      return structuredClone(next);
    },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new Runtime(
    { forgetKey() { effects.push("runtime-forget"); } },
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    stateStore,
    { ensureRunnableRoute() { throw new Error("disabled legacy route is not runnable"); } },
    providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
    { beginRun() { return () => undefined; } },
    { async apply() { throw new Error("legacy logout must not call versioned cleanup"); } },
    "legacy-secret",
    null,
    "vendor/disabled-legacy",
    config,
  );

  const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const result = await runtime.execute({
    kind: "logout",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.deepEqual(effects, ["build", "adopt", "readback", "runtime-forget"]);
  assert.equal(stateStore.read().connections[0]?.enabled, false);
  assert.equal(stateStore.read().revision, 1);
});

test("legacy logout recovers when persistence rejects after adoptPublished", async () => {
  const api = cliModule as typeof cliModule & {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV1["defaultRoute"]>;
    };
    persistProviderSetupState(
      path: string,
      request: ProviderStateCommitRequest,
    ): Promise<ProviderSetupStateV1>;
  };
  const route = {
    ...bootstrapRoute("vendor/legacy-lock-release"),
    accountFingerprint: "acct_legacy_lock_release_666666",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-lock-release-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const directory = await mkdtemp(join(tmpdir(), "orcode-legacy-lock-release-"));
  const configPath = join(directory, "config.json");
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(initial, {
    persist: (request) => api.persistProviderSetupState(configPath, request),
  });
  const runtimeGuard = providerRuntimeGuardFixture();
  const coordinatorDelegate = providerCoordinatorMutationFixture(runtimeGuard);
  let coordinatorAcquisitions = 0;
  const coordinator = {
    ...coordinatorDelegate,
    async runExclusive<T>(
      request: { signal: AbortSignal },
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      coordinatorAcquisitions += 1;
      return coordinatorDelegate.runExclusive(request, operation);
    },
  };
  const secret = `${STARTUP_KEY_PREFIX}${"l".repeat(48)}`;
  const openRouter = new OpenRouterService(secret);
  const session = SessionStore.create(
    "/synthetic/legacy-lock-release",
    "/synthetic/.orcode",
  );
  session.setPreferences(route.requestedModelId, { mode: "auto" }, route);
  const runtime = new api.DefaultProviderRuntime(
    openRouter,
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    stateStore,
    { ensureRunnableRoute: () => route },
    coordinator,
    runtimeGuard,
    { async apply() { throw new Error("legacy logout must not call versioned cleanup"); } },
    secret,
    null,
    route.requestedModelId,
    config,
    session,
  );
  const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const originalRelease = PrivateStore.prototype.releaseDirectoryClaim;
  let injectedReleaseFailure = false;
  let result: Record<string, unknown>;
  PrivateStore.prototype.releaseDirectoryClaim = async function(claim, expectedOwner) {
    await originalRelease.call(this, claim, expectedOwner);
    if (!injectedReleaseFailure && expectedOwner !== null) {
      injectedReleaseFailure = true;
      throw new Error("fixed config writer release failure after exact adoption");
    }
  };
  try {
    result = await runtime.execute({
      kind: "logout",
      backendId: "openrouter",
      confirmationToken: prompt.confirmationToken,
    }, "plain");
  } finally {
    PrivateStore.prototype.releaseDirectoryClaim = originalRelease;
  }

  const durable = (JSON.parse(await readFile(configPath, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;
  assert.equal(injectedReleaseFailure, true);
  assert.deepEqual(result, {
    kind: "changed",
    operation: "logout",
    backendId: "openrouter",
    setupRequired: true,
    defaultCleared: true,
  });
  assert.equal(coordinatorAcquisitions, 2);
  assert.equal(durable.revision, 1);
  assert.equal(durable.connections[0]?.enabled, false);
  assert.equal(durable.defaultRoute, null);
  assert.deepEqual(stateStore.read(), durable);
  assert.deepEqual(config.providerSetup, durable);
  assert.deepEqual(session.data.route, route);
  assert.equal(openRouter.hasKey, false);
  assert.throws(() => runtime.ensureRunnableRoute(), /setup|required|route/i);
});

test("legacy logout completes or recovers the exact disabled tuple after first post-commit lease loss", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const route = {
    ...bootstrapRoute("vendor/legacy-post-commit"),
    accountFingerprint: "acct_legacy_post_commit_555555",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-post-commit-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
      accountFingerprint: route.accountFingerprint,
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
      const next = request.build(structuredClone(durable));
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  let coordinatorAcquisitions = 0;
  const coordinator = {
    async runExclusive<T>(
      _request: unknown,
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      coordinatorAcquisitions += 1;
      const acquisition = coordinatorAcquisitions;
      return operation({
        async assertHeld() {
          if (acquisition === 1 && stateStore.read().revision === 1) {
            throw new Error("fixed first post-commit legacy lease loss");
          }
        },
      });
    },
  };
  let runtimeForgets = 0;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new Runtime(
    { forgetKey() { runtimeForgets += 1; } },
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    stateStore,
    { ensureRunnableRoute: () => route },
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { throw new Error("legacy logout must not call versioned cleanup"); } },
    "legacy-secret",
    null,
    route.requestedModelId,
    config,
  );

  const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const result = await runtime.execute({
    kind: "logout",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.equal(coordinatorAcquisitions, 2);
  assert.equal(durable.revision, 1);
  assert.equal(durable.connections[0]?.enabled, false);
  assert.deepEqual(stateStore.read(), durable);
  assert.deepEqual(config.providerSetup, durable);
  assert.equal(runtimeForgets, 1);
});

for (const phase of ["prepared", "credential-deleted", "shared-reference"] as const) {
  test(`logout rejects same-revision authoritative target replacement in ${phase} phase`, async () => {
    const api = cliModule as typeof cliModule & {
      DefaultProviderRuntime: new (...args: unknown[]) => {
        execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      };
      ProviderCredentialForgetJournal: new (input: {
        appHome: string;
        privateStore: PrivateStore;
      }) => {
        begin(input: Record<string, unknown>): Promise<unknown>;
        markDeleted(transaction: unknown): Promise<void>;
        readPending(): Promise<unknown>;
      };
      createProviderCredentialController(input: Record<string, unknown>): {
        apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
    };
    const root = await mkdtemp(join(tmpdir(), `orcode-provider-authoritative-${phase}-`));
    const targetId = `target-${phase}`;
    const survivorId = `survivor-${phase}`;
    const approvedSlot = "v1:inference:66666666-6666-4666-8666-666666666666";
    const replacementSlot = "v1:inference:77777777-7777-4777-8777-777777777777";
    const approvedRoute = {
      ...bootstrapRoute(`vendor/${phase}`),
      accountFingerprint: `acct_${phase}_approved_333333`,
    } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
    const survivor = {
      id: survivorId,
      backendId: "openrouter" as const,
      enabled: true,
      maturity: "stable" as const,
      credentialSlot: approvedSlot,
      accountFingerprint: approvedRoute.accountFingerprint,
      accountFingerprintState: "verified" as const,
      billingRealm: "openrouter-payg" as const,
      lastHealth: null,
    };
    const approved: ProviderSetupStateV1 = {
      schemaVersion: 1,
      revision: 0,
      lifecycle: "configured",
      connections: [{ ...survivor, id: targetId }, ...(phase === "shared-reference" ? [survivor] : [])],
      defaultRoute: phase === "credential-deleted" ? null : approvedRoute,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
    const replacementRoute = {
      ...approvedRoute,
      accountFingerprint: `acct_${phase}_replacement_444444`,
      requestedModelId: `vendor/${phase}-replacement`,
      canonicalModelId: `vendor/${phase}-replacement`,
    };
    const replacement: ProviderSetupStateV1 = {
      ...structuredClone(approved),
      connections: approved.connections.map((connection) =>
        connection.id === targetId
          ? {
              ...connection,
              credentialSlot: replacementSlot,
              accountFingerprint: replacementRoute.accountFingerprint,
            }
          : connection
      ),
      defaultRoute: phase === "credential-deleted"
        ? null
        : phase === "shared-reference"
          ? approvedRoute
          : replacementRoute,
    };
    let durable = structuredClone(replacement);
    const stateStore = new ProviderStateStore(approved, {
      persist: async (request) => {
        request.assertCurrent();
        const next = request.build(structuredClone(durable));
        durable = structuredClone(next);
        request.adopt(next);
        return structuredClone(next);
      },
    });
    const journal = new api.ProviderCredentialForgetJournal({
      appHome: root,
      privateStore: new PrivateStore({ root }),
    });
    const transaction = await journal.begin({
      connectionId: targetId,
      target: {
        kind: "versioned",
        slot: { version: 1, kind: "inference", id: approvedSlot },
      },
    });
    if (phase === "credential-deleted") await journal.markDeleted(transaction);
    let deletes = 0;
    const secret = `${STARTUP_KEY_PREFIX}${"a".repeat(48)}`;
    const openRouter = new OpenRouterService(secret);
    const coordinator = providerCoordinatorMutationFixture(providerRuntimeGuardFixture());
    const controller = api.createProviderCredentialController({
      stateStore,
      openRouter,
      credentials: {
        async deleteSlot() { deletes += 1; return true; },
      },
      activationCoordinator: coordinator,
      forgetJournal: journal,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.providerSetup = structuredClone(approved);
    const runtime = new api.DefaultProviderRuntime(
      openRouter,
      {},
      {
        descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
        entries() { return []; },
      },
      stateStore,
      { ensureRunnableRoute: () => approvedRoute },
      coordinator,
      { beginRun() { return () => undefined; } },
      controller,
      secret,
      null,
      approvedRoute.requestedModelId,
      config,
    );

    const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
    const result = await runtime.execute({
      kind: "logout",
      backendId: "openrouter",
      confirmationToken: prompt.confirmationToken,
    }, "plain");

    assert.equal(result.kind, "confirmation-required");
    assert.notEqual(result.confirmationToken, prompt.confirmationToken);
    assert.deepEqual(durable, replacement);
    assert.equal(deletes, 0);
    assert.equal(openRouter.hasKey, true);
    assert.notEqual(await journal.readPending(), null);
  });
}

test("duplicate shared-slot logout fails closed without choosing the first connection", async () => {
  const api = cliModule as typeof cliModule & {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      ensureRunnableRoute(): Record<string, unknown>;
    };
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => unknown;
    createProviderCredentialController(input: Record<string, unknown>): {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-shared-live-"));
  const slot = "v1:inference:88888888-8888-4888-8888-888888888888";
  const route = {
    ...bootstrapRoute("vendor/shared-live"),
    accountFingerprint: "acct_shared_live_555555",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const health = {
    credential: "valid" as const,
    connectivity: "connected" as const,
    spend: "available" as const,
    runtime: "ready" as const,
    observedAt: 1,
    generation: 7,
  };
  const connection = {
    backendId: "openrouter" as const,
    enabled: true,
    maturity: "stable" as const,
    credentialSlot: slot,
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: "openrouter-payg" as const,
    lastHealth: health,
  };
  const initial: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [
      { ...connection, id: "shared-selected" },
      { ...connection, id: "shared-survivor" },
    ],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let durable = structuredClone(initial);
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      request.assertCurrent();
      const next = request.build(structuredClone(durable));
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const slots = new Map([[slot, `${STARTUP_KEY_PREFIX}${"s".repeat(48)}`]]);
  let deletes = 0;
  const openRouter = new OpenRouterService(slots.get(slot)!);
  const coordinator = providerCoordinatorMutationFixture(providerRuntimeGuardFixture());
  const journal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials: {
      async deleteSlot(reference: CredentialSlotRef) {
        deletes += 1;
        return slots.delete(reference.id);
      },
    },
    activationCoordinator: coordinator,
    forgetJournal: journal,
  });
  const registry = {
    descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
    entries() {
      return [{ id: "openrouter", displayName: "OpenRouter", maturity: "stable", connectable: true }];
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new api.DefaultProviderRuntime(
    openRouter,
    {},
    registry,
    stateStore,
    { ensureRunnableRoute() { throw new Error("session proof was discarded"); } },
    coordinator,
    { beginRun() { return () => undefined; } },
    controller,
    slots.get(slot),
    null,
    route.requestedModelId,
    config,
  );
  runtime.adoptCredentialActivation(route as unknown as Record<string, unknown>, true, slots.get(slot)!);

  const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const result = await runtime.execute({
    kind: "logout",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "confirmation-required");
  assert.notEqual(result.confirmationToken, prompt.confirmationToken);
  assert.equal(deletes, 0);
  assert.equal(openRouter.hasKey, true);
  assert.throws(() => runtime.ensureRunnableRoute(), /session proof was discarded/);
  const status = await runtime.execute({ kind: "status" }, "plain");
  const provider = (status.providers as Array<Record<string, unknown>>)[0];
  assert.equal(provider?.configuration, "disabled");
  assert.equal(provider?.headline, null);
  assert.equal(provider?.isDefault, false);
  assert.equal(provider?.accountFingerprintSuffix, null);
  assert.deepEqual(durable, initial);
  assert.equal(slots.has(slot), true);

  const restartedStore = new ProviderStateStore(durable);
  assert.equal(restartedStore.read().defaultRoute?.canonicalModelId, route.canonicalModelId);
  assert.deepEqual(restartedStore.read().connections.map((candidate) => candidate.id), [
    "shared-selected",
    "shared-survivor",
  ]);
});

test("disabled targeted logout validates authoritative identity before delete or journal phase transition", async () => {
  const api = cliModule as typeof cliModule & {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
      readPending(): Promise<{ phase: string } | null>;
    };
    createProviderCredentialController(input: Record<string, unknown>): {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-disabled-predelete-authority-"));
  const connectionId = "disabled-predelete-target";
  const approvedSlot = "v1:inference:99999999-9999-4999-8999-999999999999";
  const replacementSlot = "v1:inference:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const approved: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialSlot: approvedSlot,
      accountFingerprint: "acct_disabled_approved_111111",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const replacement: ProviderSetupStateV1 = {
    ...structuredClone(approved),
    connections: [{
      ...approved.connections[0]!,
      credentialSlot: replacementSlot,
      accountFingerprint: "acct_disabled_replacement_222222",
    }],
  };
  let durable = structuredClone(replacement);
  let adopts = 0;
  const stateStore = new ProviderStateStore(approved, {
    persist: async (request) => {
      request.assertCurrent();
      const next = request.build(structuredClone(durable));
      durable = structuredClone(next);
      request.adopt(next);
      adopts += 1;
      return structuredClone(next);
    },
  });
  const realJournal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  let markedDeleted = 0;
  const journal = {
    begin: (input: Parameters<typeof realJournal.begin>[0]) => realJournal.begin(input),
    async markDeleted(transaction: Parameters<typeof realJournal.markDeleted>[0]) {
      markedDeleted += 1;
      await realJournal.markDeleted(transaction);
    },
    complete: (transaction: Parameters<typeof realJournal.complete>[0]) =>
      realJournal.complete(transaction),
  };
  let deletes = 0;
  const secret = `${STARTUP_KEY_PREFIX}${"d".repeat(48)}`;
  const openRouter = new OpenRouterService(secret);
  const coordinator = providerCoordinatorMutationFixture(providerRuntimeGuardFixture());
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials: {
      async deleteSlot() {
        deletes += 1;
        return true;
      },
    },
    activationCoordinator: coordinator,
    forgetJournal: journal,
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(approved);
  const runtime = new api.DefaultProviderRuntime(
    openRouter,
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    stateStore,
    { ensureRunnableRoute() { throw new Error("no active route"); } },
    coordinator,
    { beginRun() { return () => undefined; } },
    controller,
    secret,
    null,
    "openrouter/auto",
    config,
  );

  const prompt = await runtime.execute({ kind: "logout", backendId: "openrouter" }, "plain");
  const result = await runtime.execute({
    kind: "logout",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "confirmation-required");
  assert.notEqual(result.confirmationToken, prompt.confirmationToken);
  assert.deepEqual(durable, replacement);
  assert.equal(deletes, 0);
  assert.equal(markedDeleted, 0);
  assert.equal(adopts, 0);
  assert.equal(openRouter.hasKey, true);
  assert.equal((await realJournal.readPending())?.phase, "prepared");
});

test("global key forget refuses shared provider references without partial mutation or false output", async (t) => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => { readPending(): Promise<unknown> };
    createProviderCredentialController(input: Record<string, unknown>): {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  const sharedSlot = "v1:inference:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const legacyRoute = {
    ...bootstrapRoute("vendor/legacy-shared"),
    accountFingerprint: "acct_legacy_shared_444444",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const versionedRoute = {
    ...bootstrapRoute("vendor/versioned-shared"),
    accountFingerprint: "acct_versioned_shared_333333",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const fixtures: Array<{ name: string; connections: ProviderSetupStateV1["connections"]; route: NonNullable<ProviderSetupStateV1["defaultRoute"]> }> = [
    {
      name: "shared v1 references",
      route: versionedRoute,
      connections: ["shared-v1-selected", "shared-v1-survivor"].map((id) => ({
        id,
        backendId: "openrouter" as const,
        enabled: true,
        maturity: "stable" as const,
        credentialSlot: sharedSlot,
        accountFingerprint: versionedRoute.accountFingerprint,
        accountFingerprintState: "verified" as const,
        billingRealm: "openrouter-payg" as const,
        lastHealth: null,
      })),
    },
    {
      name: "legacy and versioned shared mix",
      route: legacyRoute,
      connections: [
        {
          id: "legacy-selected",
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialSlot: "legacy:inference",
          accountFingerprint: legacyRoute.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: null,
        },
        {
          id: "legacy-survivor",
          backendId: "openrouter",
          enabled: false,
          maturity: "stable",
          credentialSlot: "legacy:inference",
          accountFingerprint: legacyRoute.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: null,
        },
        {
          id: "versioned-survivor",
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialSlot: sharedSlot,
          accountFingerprint: versionedRoute.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: null,
        },
      ],
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "orcode-global-key-forget-shared-"));
      const initial: ProviderSetupStateV1 = {
        schemaVersion: 1,
        revision: 0,
        lifecycle: "configured",
        connections: structuredClone(fixture.connections),
        defaultRoute: structuredClone(fixture.route),
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      };
      let durable = structuredClone(initial);
      const stateStore = new ProviderStateStore(initial, {
        persist: async (request) => {
          request.assertCurrent();
          const next = request.build(structuredClone(durable));
          durable = structuredClone(next);
          request.adopt(next);
          return structuredClone(next);
        },
      });
      const realJournal = new api.ProviderCredentialForgetJournal({
        appHome: root,
        privateStore: new PrivateStore({ root }),
      });
      let journalBegins = 0;
      const journal = {
        async begin(input: Parameters<typeof realJournal.begin>[0]) {
          journalBegins += 1;
          return realJournal.begin(input);
        },
        markDeleted: (transaction: Parameters<typeof realJournal.markDeleted>[0]) =>
          realJournal.markDeleted(transaction),
        complete: (transaction: Parameters<typeof realJournal.complete>[0]) =>
          realJournal.complete(transaction),
      };
      const secret = `${STARTUP_KEY_PREFIX}${"g".repeat(48)}`;
      const openRouter = new OpenRouterService(secret);
      const slots = new Map([[sharedSlot, secret]]);
      let versionedDeletes = 0;
      let legacyDeletes = 0;
      const credentials = {
        location: "Test-Speicher",
        async delete() {
          legacyDeletes += 1;
          return true;
        },
        async deleteSlot(slot: CredentialSlotRef) {
          versionedDeletes += 1;
          return slots.delete(slot.id);
        },
      };
      const coordinator = providerCoordinatorMutationFixture(providerRuntimeGuardFixture());
      const controller = api.createProviderCredentialController({
        stateStore,
        openRouter,
        credentials,
        activationCoordinator: coordinator,
        forgetJournal: journal,
      });
      const output: string[] = [];
      const prompts: string[] = [];
      const context = {
        openRouter,
        credentials,
        providerCredentials: controller,
        confirmCredentialForget: async (_kind: string, message: string) => {
          prompts.push(message);
          return true;
        },
        out: {
          text(value: string) { output.push(value); },
          error(value: string, hint?: string) { output.push(hint ? `${value}\n${hint}` : value); },
        },
      } as unknown as CommandContext;

      await handleSlashCommand("/key forget", context);

      assert.deepEqual(durable, initial);
      assert.deepEqual(new ProviderStateStore(durable).read(), initial);
      assert.equal(versionedDeletes, 0);
      assert.equal(legacyDeletes, 0);
      assert.equal(slots.has(sharedSlot), true);
      assert.equal(openRouter.hasKey, true);
      assert.equal(journalBegins, 0);
      assert.deepEqual(await realJournal.readPending(), null);
      assert.deepEqual(prompts, [
        "API-Key aus Test-Speicher und Prozessspeicher entfernen? Bei mehreren Provider-Verbindungen bleibt er unverändert.",
      ]);
      assert.deepEqual(output, [
        "API-Key unverändert: Mehrere OpenRouter-Verbindungen sind eingerichtet. Entferne sie einzeln mit /provider logout.",
      ]);
    });
  }
});

test("global key forget refuses authoritative shared Legacy references when in-memory state is empty", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
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
  const root = await mkdtemp(join(tmpdir(), "orcode-global-key-forget-authoritative-shared-"));
  const configPath = join(root, "config.json");
  const stale: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const authoritative: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: ["durable-legacy-one", "durable-legacy-two"].map((id, index) => ({
      id,
      backendId: "openrouter" as const,
      enabled: false,
      maturity: "stable" as const,
      credentialSlot: "legacy:inference",
      accountFingerprint: `acct_durable_legacy_${index}_111111`,
      accountFingerprintState: "verified" as const,
      billingRealm: "openrouter-payg" as const,
      lastHealth: null,
    })),
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(authoritative);
  await saveConfig(config, configPath);
  const beforeBytes = await readFile(configPath, "utf8");
  let durableBoundaryCalls = 0;
  const stateStore = new ProviderStateStore(stale, {
    persist: async (request) => {
      durableBoundaryCalls += 1;
      return api.persistProviderSetupState(configPath, request);
    },
  });
  const realJournal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const journalEffects = { begin: 0, markDeleted: 0, complete: 0 };
  const journal = {
    async begin(input: Parameters<typeof realJournal.begin>[0]) {
      journalEffects.begin += 1;
      return realJournal.begin(input);
    },
    async markDeleted(transaction: Parameters<typeof realJournal.markDeleted>[0]) {
      journalEffects.markDeleted += 1;
      await realJournal.markDeleted(transaction);
    },
    async complete(transaction: Parameters<typeof realJournal.complete>[0]) {
      journalEffects.complete += 1;
      await realJournal.complete(transaction);
    },
  };
  const secret = `${STARTUP_KEY_PREFIX}${"h".repeat(48)}`;
  const openRouter = new OpenRouterService(secret);
  const credentialEffects = { legacyDelete: 0, versionedDelete: 0 };
  const credentials = {
    location: "Test-Speicher",
    async delete() {
      credentialEffects.legacyDelete += 1;
      return true;
    },
    async deleteSlot() {
      credentialEffects.versionedDelete += 1;
      return true;
    },
  };
  let published = 0;
  let forgotten = 0;
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials,
    activationCoordinator: providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
    forgetJournal: journal,
    onInferenceStatePublished() { published += 1; },
    onInferenceForgotten() { forgotten += 1; },
  });
  const output: string[] = [];
  const prompts: string[] = [];
  const context = {
    openRouter,
    credentials,
    providerCredentials: controller,
    confirmCredentialForget: async (_kind: string, message: string) => {
      prompts.push(message);
      return true;
    },
    out: {
      text(value: string) { output.push(value); },
      error(value: string, hint?: string) { output.push(hint ? `${value}\n${hint}` : value); },
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/key forget", context);

  assert.equal(durableBoundaryCalls, 1);
  assert.deepEqual(journalEffects, { begin: 0, markDeleted: 0, complete: 0 });
  assert.deepEqual(credentialEffects, { legacyDelete: 0, versionedDelete: 0 });
  assert.equal(published, 0);
  assert.equal(forgotten, 0);
  assert.equal(openRouter.hasKey, true);
  assert.deepEqual(stateStore.read(), stale);
  assert.equal(await readFile(configPath, "utf8"), beforeBytes);
  const restarted = new ProviderStateStore(
    (JSON.parse(beforeBytes) as { providerSetup: ProviderSetupStateV1 }).providerSetup,
  );
  assert.deepEqual(restarted.read(), authoritative);
  assert.deepEqual(await realJournal.readPending(), null);
  assert.deepEqual(prompts, [
    "API-Key aus Test-Speicher und Prozessspeicher entfernen? Bei mehreren Provider-Verbindungen bleibt er unverändert.",
  ]);
  assert.deepEqual(output, [
    "API-Key unverändert: Mehrere OpenRouter-Verbindungen sind eingerichtet. Entferne sie einzeln mit /provider logout.",
  ]);
  assert.doesNotMatch(output.join("\n"), new RegExp(secret));
});

test("global key forget removes the sole authoritative disabled v1 connection when in-memory state is empty", async () => {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
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
  const root = await mkdtemp(join(tmpdir(), "orcode-global-key-forget-authoritative-disabled-"));
  const configPath = join(root, "config.json");
  const stale: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const slot = "v1:inference:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const authoritative: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "durable-disabled-v1",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialSlot: slot,
      accountFingerprint: "acct_durable_disabled_222222",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(authoritative);
  await saveConfig(config, configPath);
  let durableBoundaryCalls = 0;
  const stateStore = new ProviderStateStore(stale, {
    persist: async (request) => {
      durableBoundaryCalls += 1;
      return api.persistProviderSetupState(configPath, request);
    },
  });
  const realJournal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore: new PrivateStore({ root }),
  });
  const journalEffects = { begin: 0, markDeleted: 0, complete: 0 };
  const journal = {
    async begin(input: Parameters<typeof realJournal.begin>[0]) {
      journalEffects.begin += 1;
      return realJournal.begin(input);
    },
    async markDeleted(transaction: Parameters<typeof realJournal.markDeleted>[0]) {
      journalEffects.markDeleted += 1;
      await realJournal.markDeleted(transaction);
    },
    async complete(transaction: Parameters<typeof realJournal.complete>[0]) {
      journalEffects.complete += 1;
      await realJournal.complete(transaction);
    },
  };
  const secret = `${STARTUP_KEY_PREFIX}${"u".repeat(48)}`;
  const slots = new Map([[slot, secret]]);
  const openRouter = new OpenRouterService(secret);
  const credentialEffects = { legacyDelete: 0, versionedDelete: 0 };
  const credentials = {
    location: "Test-Speicher",
    async delete() {
      credentialEffects.legacyDelete += 1;
      return true;
    },
    async deleteSlot(reference: CredentialSlotRef) {
      credentialEffects.versionedDelete += 1;
      return slots.delete(reference.id);
    },
  };
  const published: ProviderSetupStateV1[] = [];
  let forgotten = 0;
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials,
    activationCoordinator: providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
    forgetJournal: journal,
    onInferenceStatePublished(state: ProviderSetupStateV1) {
      published.push(structuredClone(state));
    },
    onInferenceForgotten() { forgotten += 1; },
  });
  const output: string[] = [];
  const context = {
    openRouter,
    credentials,
    providerCredentials: controller,
    confirmCredentialForget: async () => true,
    out: {
      text(value: string) { output.push(value); },
      error(value: string, hint?: string) { output.push(hint ? `${value}\n${hint}` : value); },
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/key forget", context);

  assert.ok(durableBoundaryCalls >= 1);
  assert.deepEqual(journalEffects, { begin: 1, markDeleted: 1, complete: 1 });
  assert.deepEqual(credentialEffects, { legacyDelete: 0, versionedDelete: 1 });
  assert.equal(slots.has(slot), false);
  assert.equal(openRouter.hasKey, false);
  assert.equal(forgotten, 1);
  assert.deepEqual(published.map((state) => state.revision), [1, 2]);
  assert.equal(published.every((state) => state.defaultRoute === null), true);
  const durable = (JSON.parse(await readFile(configPath, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;
  assert.deepEqual(stateStore.read(), durable);
  assert.equal(durable.revision, 2);
  assert.deepEqual(durable.connections, []);
  assert.equal(durable.defaultRoute, null);
  assert.deepEqual(new ProviderStateStore(durable).read(), durable);
  assert.deepEqual(await realJournal.readPending(), null);
  assert.deepEqual(output, ["API-Key aus Prozessspeicher und Test-Speicher entfernt."]);
  assert.doesNotMatch(output.join("\n"), /shared-reference|Mehrere OpenRouter-Verbindungen/i);
  assert.doesNotMatch(output.join("\n"), new RegExp(secret));
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
    openRouter,
    allowOldSlotDelete() { failOldSlotDelete = false; },
  };
}

async function managementMutationLeaseFixture() {
  const api = cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
    };
    createProviderCredentialController(input: Record<string, unknown>): {
      apply(intent: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-management-effect-fence-"));
  const configPath = join(root, "config.json");
  const state: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(state);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(state);
  const privateStore = new PrivateStore({ root });
  const runtimeGuardA = providerRuntimeGuardFixture();
  let now = 100;
  let uuid = 200;
  const createUuid = () =>
    `70000000-0000-4000-8000-${String(uuid++).padStart(12, "0")}`;
  const coordinatorOptions = (runtimeGuard: ReturnType<typeof providerRuntimeGuardFixture>) => ({
    appHome: root,
    configPath,
    privateStore,
    credentials: {} as never,
    adapter: {} as never,
    stateStore,
    runtimeGuard,
    now: () => now,
    createUuid,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  const coordinatorA = new ProviderActivationCoordinator({
    ...coordinatorOptions(runtimeGuardA),
    leaseDurationMs: 10,
  });
  const coordinatorB = new ProviderActivationCoordinator({
    ...coordinatorOptions(providerRuntimeGuardFixture()),
    leaseDurationMs: 100,
  });
  const forgetJournal = new api.ProviderCredentialForgetJournal({
    appHome: root,
    privateStore,
  });
  return {
    api,
    coordinatorA,
    async prepareCompetingForget() {
      now = 1_000;
      await coordinatorB.recoverAndRun(
        { signal: new AbortController().signal, inspectCommitted: false },
        async (lease) => {
          await lease.assertHeld();
          return forgetJournal.begin({
            connectionId: null,
            target: { kind: "legacy" },
          });
        },
      );
    },
  };
}

test("management validation loss fences keychain set and runtime activation before either effect", async () => {
  const fixture = await managementMutationLeaseFixture();
  let resumeValidation!: () => void;
  let validationReached!: () => void;
  const validationPaused = new Promise<void>((resolve) => { validationReached = resolve; });
  const validationResume = new Promise<void>((resolve) => { resumeValidation = resolve; });
  const mutations: string[] = [];
  const controller = fixture.api.createProviderCredentialController({
    stateStore: new ProviderStateStore({
      schemaVersion: 1,
      revision: 0,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    }),
    openRouter: {
      async validateManagementKey() {
        validationReached();
        await validationResume;
        return { totalCredits: 10, totalUsage: 1 };
      },
      activateValidatedManagementKey() { mutations.push("runtime:activate"); },
    },
    credentials: {
      async set() { mutations.push("keychain:set"); },
      async deleteSlot() { return false; },
    },
    activationCoordinator: fixture.coordinatorA,
  });
  const applying = controller.apply({
    kind: "replace",
    credentialKind: "management",
    candidate: `${STARTUP_KEY_PREFIX}${"m".repeat(48)}`,
  });
  await validationPaused;
  await fixture.prepareCompetingForget();
  resumeValidation();

  await assert.rejects(applying, /fence|lease|recovery|activation/i);
  assert.deepEqual(mutations, []);
});

test("management forget loss fences keychain and runtime deletion before either effect", async () => {
  const fixture = await managementMutationLeaseFixture();
  let resumeOperation!: () => void;
  let operationReached!: () => void;
  const operationPaused = new Promise<void>((resolve) => { operationReached = resolve; });
  const operationResume = new Promise<void>((resolve) => { resumeOperation = resolve; });
  const wrappedCoordinator = {
    activate: fixture.coordinatorA.activate.bind(fixture.coordinatorA),
    recoverAndRun: fixture.coordinatorA.recoverAndRun.bind(fixture.coordinatorA),
    runExclusive: <T>(
      request: Parameters<ProviderActivationCoordinator["runExclusive"]>[0],
      operation: (lease: Parameters<Parameters<ProviderActivationCoordinator["runExclusive"]>[1]>[0]) => Promise<T>,
    ) => fixture.coordinatorA.runExclusive(request, async (lease) => {
      operationReached();
      await operationResume;
      return operation(lease);
    }),
  };
  const mutations: string[] = [];
  const controller = fixture.api.createProviderCredentialController({
    stateStore: new ProviderStateStore({
      schemaVersion: 1,
      revision: 0,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    }),
    openRouter: {
      forgetManagementKey() { mutations.push("runtime:forget"); },
    },
    credentials: {
      async delete() { mutations.push("keychain:delete"); return true; },
      async deleteSlot() { return false; },
    },
    activationCoordinator: wrappedCoordinator,
  });
  const applying = controller.apply({ kind: "forget", credentialKind: "management" });
  await operationPaused;
  await fixture.prepareCompetingForget();
  resumeOperation();

  await assert.rejects(applying, /fence|lease|recovery|activation/i);
  assert.deepEqual(mutations, []);
});

test("management process-only approval loss fences runtime activation after failed persistence", async () => {
  const fixture = await managementMutationLeaseFixture();
  let resumeApproval!: () => void;
  let approvalReached!: () => void;
  const approvalPaused = new Promise<void>((resolve) => { approvalReached = resolve; });
  const approvalResume = new Promise<void>((resolve) => { resumeApproval = resolve; });
  const mutations: string[] = [];
  let setAttempts = 0;
  const controller = fixture.api.createProviderCredentialController({
    stateStore: new ProviderStateStore({
      schemaVersion: 1,
      revision: 0,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    }),
    openRouter: {
      async validateManagementKey() { return { totalCredits: 10, totalUsage: 1 }; },
      activateValidatedManagementKey() { mutations.push("runtime:activate"); },
    },
    credentials: {
      async set() {
        setAttempts += 1;
        throw new Error("synthetic management persistence unavailable");
      },
      async deleteSlot() { return false; },
    },
    activationCoordinator: fixture.coordinatorA,
  });
  const applying = controller.apply({
    kind: "replace",
    credentialKind: "management",
    candidate: `${STARTUP_KEY_PREFIX}${"p".repeat(48)}`,
    allowProcessOnly: async () => {
      approvalReached();
      await approvalResume;
      return true;
    },
  });
  await approvalPaused;
  await fixture.prepareCompetingForget();
  resumeApproval();

  await assert.rejects(applying, /fence|lease|recovery|activation/i);
  assert.equal(setAttempts, 1);
  assert.deepEqual(mutations, []);
});

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
  const publicationEvents: string[] = [];

  const committed = await persist!(path, {
    expectedRevision: 0,
    assertCurrent() {
      publicationEvents.push("assert-current");
    },
    build(current) {
      publicationEvents.push("build");
      assert.deepEqual(current, before);
      return after;
    },
    adopt(value) {
      publicationEvents.push("adopt-unpublished");
      adopted = value;
    },
  });

  const expectedRaw = raw.replace(beforeBytes, JSON.stringify(after));
  assert.equal(await readFile(path, "utf8"), expectedRaw);
  assert.deepEqual(committed, after);
  assert.deepEqual(adopted, after);
  assert.deepEqual(publicationEvents, [
    "assert-current",
    "build",
    "assert-current",
    "assert-current",
    "assert-current",
    "assert-current",
    "adopt-unpublished",
  ]);
});

async function realProviderCrossWriterFenceFixture() {
  const api = cliModule as typeof cliModule & {
    persistProviderSetupState(
      path: string,
      request: ProviderStateCommitRequest,
    ): Promise<ProviderSetupStateV1>;
  };
  const directory = await mkdtemp(join(tmpdir(), "orcode-cross-writer-fence-"));
  const configPath = join(directory, "config.json");
  const route = {
    ...bootstrapRoute("vendor/cross-writer-a"),
    accountFingerprint: "acct_cross_writer_111111",
  } as NonNullable<ProviderSetupStateV1["defaultRoute"]>;
  const challenger = {
    ...route,
    requestedModelId: "vendor/cross-writer-challenger",
    canonicalModelId: "vendor/cross-writer-challenger",
  };
  const replacementRoute = {
    ...route,
    requestedModelId: "vendor/cross-writer-b",
    canonicalModelId: "vendor/cross-writer-b",
  };
  const activated: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 1,
    lifecycle: "configured",
    connections: [{
      id: "cross-writer-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:91919191-9191-4191-8191-919191919191",
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(activated);
  await saveConfig(config, configPath);
  const stateStore = new ProviderStateStore(activated, {
    persist: (request) => api.persistProviderSetupState(configPath, request),
  });
  const commitCross = (assertCurrent: () => void) => stateStore.commit(
    activated.revision,
    (current) => ({
      ...current,
      cross: {
        enabled: false,
        preferredLead: route,
        preferredChallenger: challenger,
      },
    }),
    assertCurrent,
  );
  const readDurable = async (): Promise<ProviderSetupStateV1> => (
    JSON.parse(await readFile(configPath, "utf8")) as {
      providerSetup: ProviderSetupStateV1;
    }
  ).providerSetup;
  return {
    activated,
    commitCross,
    readDurable,
    replacementRoute,
    stateStore,
  };
}

test("real provider writer abort microtask at the last async fence cannot publish stale Cross roles", async () => {
  const fixture = await realProviderCrossWriterFenceFixture();
  const controller = new AbortController();
  const reason = new DOMException("fixed queued provider abort", "AbortError");
  let assertions = 0;

  await assert.rejects(
    fixture.commitCross(() => {
      assertions += 1;
      if (assertions === 4) queueMicrotask(() => controller.abort(reason));
      if (controller.signal.aborted) throw reason;
    }),
    /Provider state publication failed/,
  );

  assert.equal(assertions, 5);
  assert.deepEqual(await fixture.readDurable(), fixture.activated);
  assert.deepEqual(fixture.stateStore.read(), fixture.activated);
});

test("real provider writer supersession microtask at the last async fence cannot publish stale Cross roles", async () => {
  const fixture = await realProviderCrossWriterFenceFixture();
  const replacement = {
    ...fixture.activated,
    defaultRoute: fixture.replacementRoute,
  };
  const expectedReplacement = { ...replacement, revision: 2 };
  let assertions = 0;

  await assert.rejects(
    fixture.commitCross(() => {
      assertions += 1;
      if (assertions === 4) {
        queueMicrotask(() => {
          fixture.stateStore.replace(replacement, fixture.activated.revision);
        });
      }
      if (
        JSON.stringify(fixture.stateStore.read())
        !== JSON.stringify(fixture.activated)
      ) {
        throw new Error("fixed Cross activation superseded");
      }
    }),
    /Provider state publication failed/,
  );

  assert.equal(assertions, 5);
  assert.deepEqual(await fixture.readDurable(), fixture.activated);
  assert.deepEqual(fixture.stateStore.read(), expectedReplacement);
});

test("post-readback cancellation adopts the exact committed provider state without a half tuple", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-state-post-readback-"));
  const path = join(directory, "config.json");
  const before = new ProviderStateStore(DEFAULT_CONFIG.providerSetup).read();
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(before);
  await saveConfig(config, path);
  let postReadbackCancellations = 0;
  const store = new ProviderStateStore(before, {
    persist: (request) => cliModule.persistProviderSetupState(path, request),
  });

  const outcome = await store.commit(
    before.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
    () => {
      const durable = (JSON.parse(readFileSync(path, "utf8")) as {
        providerSetup: ProviderSetupStateV1;
      }).providerSetup;
      if (durable.revision === before.revision + 1) {
        postReadbackCancellations += 1;
        const expired = new Error("fixed post-readback provider deadline");
        expired.name = "TimeoutError";
        throw expired;
      }
    },
  ).then(
    (state) => ({ kind: "ready" as const, state }),
    (error: unknown) => ({
      kind: "committed" as const,
      state: readProviderStateCommitAdoption(error),
    }),
  );

  const durable = (JSON.parse(await readFile(path, "utf8")) as {
    providerSetup: ProviderSetupStateV1;
  }).providerSetup;
  assert.equal(postReadbackCancellations, 1);
  assert.equal(outcome.kind, "committed");
  assert.ok(outcome.state, "an exact committed outcome must survive late cancellation");
  assert.deepEqual(outcome.state, durable);
  assert.deepEqual(store.read(), durable);
  assert.equal(durable.lifecycle, "cancelled");
  assert.equal(durable.revision, before.revision + 1);
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
  const activate = async (request: {
    expectedRevision: number;
    candidate: string;
    targetConnectionId?: string;
    generation: number;
  }) => {
    assert.equal(request.expectedRevision, 0);
    assert.equal(request.candidate, newKey);
    assert.equal(request.targetConnectionId, connectionId);
    assert.equal(request.generation, 0);
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
        deadlineAt: Number.MAX_SAFE_INTEGER,
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
