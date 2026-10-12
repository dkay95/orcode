import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import type { pickFromListPlain } from "../src/ui/list-plain.js";
import { TerminalUi, type DashboardState } from "../src/tui.js";
import {
  CliUsageError,
  applyDashboardCommandOutput,
  commandRequiresRunnableRoute,
  createModelPreferenceRouteAuthority,
  createDefaultProviderRuntime,
  createCliPlainSetupSurface,
  createPlainCrossModelPicker,
  createSettingsRuntimeSnapshotPort,
  readSettingsCrossRoleRoute,
  createOpenRouterServiceForStartup,
  executeProviderModelAction,
  formatChatCost,
  formatRunCost,
  homeWorkspaceWarning,
  initializeDashboardKey,
  initializeStartupStorage,
  parseArgs,
  pickDashboardChat,
  readPackageVersion,
  refreshChromeAfterWorkspaceSwitch,
  refreshDashboardBalance,
  refreshDashboardRecentChats,
  renderCliBanner,
  renderCliHelp,
  resolveCliCommandName,
  runOutcomeExitCode,
  SessionProviderRuntimeGuard,
  DefaultProviderRuntime,
  persistProviderSetupState,
  createRepeatCollapsingPrinter,
  crossResultNoticeText,
  publishCrossResultToSession,
  runPlainLoop,
} from "../src/cli.js";
import {
  readModelRuntimeIdentity,
  type AgentRunResult,
} from "../src/agent.js";
import * as cliModule from "../src/cli.js";
import { createPlainSetupSurface, createSettingsSetupSurface } from "../src/setup-surface/index.js";
import type { SetupSurface } from "../src/setup-surface/index.js";
import {
  BackendRegistry,
  ProviderSetupRequiredError,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type RouteIdentityV1,
} from "../src/backends.js";
import { COMMAND_CATALOG } from "../src/command-catalog.js";
import { createTheme } from "../src/ui/theme.js";
import { parseCodexHomeId } from "../src/codex-profile.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";
import type { CrossPreferencesV1 } from "../src/collaboration.js";
import {
  handleSlashCommand,
  PROVIDER_BACKEND_ACTIONS,
  providerBackendActions,
  shouldReplaceCredential,
  STALE_CHAT_DELETE_TITLE,
  type CommandContext,
} from "../src/commands.js";
import {
  DEFAULT_CONFIG,
  consumeConfigWarning,
  loadConfigDetailed,
  migrateAppHome,
  readConfigEditSnapshot,
  saveConfig,
} from "../src/config.js";
import { createPanelCall, OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import { askPanel } from "../src/panel.js";
import * as panelModule from "../src/panel.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { ProviderCredentialAuthority } from "../src/provider-authority.js";
import { openRouterAccountFingerprint, OPENROUTER_DESCRIPTOR } from "../src/openrouter-backend.js";
import { KIMI_CODE_DESCRIPTOR } from "../src/kimi-code-backend.js";
import { KimiDesktopPermitReader } from "../src/kimi-desktop-permit.js";
import { NativeSidecarChannel, decodePrivateActionFrame, encodeControlFrame, type NativeSidecarTransport } from "../src/native-sidecar-channel.js";
import { createDesktopKimiRuntimeCapability, isDesktopKimiRuntimeCapability } from "../src/kimi-execution-origin.js";
import { CredentialStore } from "../src/credentials.js";
import type { CredentialSlotRef, CredentialStoreLike } from "../src/credentials.js";
import {
  migrateLegacyOpenRouterState,
  ProviderStateStore,
  readProviderStateCommitAdoption,
  requireKeychainCredentialPointer,
  type ProviderConnectionStateV3,
  type ProviderSetupStateV3,
  type ProviderStateCommitRequest,
} from "../src/provider-state.js";
import { PrivateStore } from "../src/private-store.js";
import { ApprovalManager } from "../src/approval.js";
import { RuleStore } from "../src/rules.js";
import { createSshSession } from "../src/ssh.js";
import { ChangeJournal, WorkspaceGuard, reRootWorkspace as reRootWorkspaceCore } from "../src/workspace.js";
import { createRunId, RunLog } from "../src/runlog.js";
import {
  listChatsAcrossWorkspaces,
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  SessionStore,
  type CrossWorkspaceChat,
} from "../src/session.js";
import { SetupOrchestrator } from "../src/setup.js";
import type { ChatSummary, ModelInfo } from "../src/types.js";
import {
  ModelPreferenceCrashError,
  ModelPreferenceRecoveryRequiredError,
  recoverModelPreferenceTransactions,
  runModelPreferenceTransaction,
  type ModelPreferenceFailpoint,
} from "../src/model-preference-transaction.js";

test("Provider-Backend-Matrix ist die unveränderliche Authority für Parser und Projektion", () => {
  assert.deepEqual(providerBackendActions("openrouter"), [
    "connect", "enable", "disable", "disconnect", "reconnect", "models", "logout",
  ]);
  assert.deepEqual(providerBackendActions("kimi-code"), [
    "connect", "enable", "disable", "reconnect", "models", "logout",
  ]);
  assert.deepEqual(providerBackendActions("anthropic"), [
    "connect", "enable", "disable", "disconnect", "reconnect", "models", "logout",
  ]);
  assert.equal(PROVIDER_BACKEND_ACTIONS["kimi-code"].has("disconnect"), false);
  assert.equal(Object.isFrozen(PROVIDER_BACKEND_ACTIONS), true);
  assert.equal(
    "add" in (PROVIDER_BACKEND_ACTIONS.openrouter as unknown as object),
    false,
    "die exportierte ReadonlySet-Ansicht darf kein mutierendes Set-API leaken",
  );
  assert.equal(Object.isFrozen(providerBackendActions("openrouter")), true);
});

test("Provider runtime activity liest nur Counter und erwirbt selbst keinen Lease", async () => {
  const guard = new SessionProviderRuntimeGuard();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });

  const lease = await guard.acquire(new AbortController().signal);
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: true });
  lease.release();
  const endRun = guard.beginRun();
  assert.deepEqual(guard.activity(), { runActive: true, activationHeld: false });
  endRun();
  assert.deepEqual(guard.activity(), { runActive: false, activationHeld: false });
});

test("cached Settings snapshot mappt ausschließlich secretless Felder und führt keine Provider-Aktion aus", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  // The canary only bites on a value that is actually there: every field
  // whose DEFAULT is `null` is invisible to it until something plants a
  // non-null, identity-bearing value. `architectExecutor` is exactly such a
  // field (config.ts), and `RouteIdentityV1` carries `accountFingerprint`.
  const fingerprintRoute = (accountFingerprint: string): RouteIdentityV1 => ({
    version: 1,
    backendId: "kimi-code",
    accountFingerprint,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  });
  config.architectExecutor = fingerprintRoute("SECRET_ARCHITECT_FINGERPRINT_CANARY");
  // F1b: the same shape, arriving from the RUNTIME instead of the config.
  // `CrossPreferencesV1` (collaboration.ts) is two whole `RouteIdentityV1`s,
  // and the pair used to be placed into the snapshot verbatim — so both roles'
  // `accountFingerprint` sat in every read the moment a pair was configured.
  // Both roles default to `null`, which is why the canary never saw it.
  const crossPreferences: { lead: RouteIdentityV1 | null; challenger: RouteIdentityV1 | null } = {
    lead: fingerprintRoute("SECRET_CROSS_LEAD_FINGERPRINT_CANARY"),
    challenger: {
      ...fingerprintRoute("SECRET_CROSS_CHALLENGER_FINGERPRINT_CANARY"),
      requestedModelId: "k2",
      canonicalModelId: "k2",
    },
  };
  const route = {
    backendId: "kimi-code" as const,
    providerLabel: "Kimi Code",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    modelLabel: "Kimi K3",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
  };
  let commandExecutions = 0;
  let credentialReads = 0;
  let networkCalls = 0;
  const port = createSettingsRuntimeSnapshotPort({
    config,
    runtime: {
      activity: () => ({ runActive: false, activationHeld: false }),
      readCachedSettingsRoute: () => route,
      readCachedProviderStatus: () => [{
        backendId: "kimi-code",
        displayName: "Kimi Code",
        availability: "connectable",
        configuration: "enabled",
        maturity: "preview",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        accountFingerprintSuffix: "SECRET_FINGERPRINT_CANARY",
        headline: "ready",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
        },
        isDefault: true,
        selectedModel: {
          requestedModelId: "k3",
          canonicalModelId: "k3",
          displayName: "Kimi K3",
        },
      }, {
        backendId: "anthropic",
        displayName: "Anthropic",
        availability: "coming-soon",
        configuration: "disabled",
        maturity: "coming-soon",
        billingRealm: "none",
        accountFingerprintSuffix: null,
        headline: null,
        health: null,
        isDefault: false,
        selectedModel: null,
      }],
      execute: () => {
        commandExecutions += 1;
        throw new Error("not reachable");
      },
      readCredential: () => {
        credentialReads += 1;
        throw new Error("not reachable");
      },
      fetch: () => {
        networkCalls += 1;
        throw new Error("not reachable");
      },
      readCachedSettingsModels: () => [{
        id: "k3",
        canonicalSlug: "k3",
        name: "Kimi K3",
        description: "safe cached model",
        contextLength: 262_144,
        promptPrice: -1,
        completionPrice: -1,
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "SECRET_MODEL_SLOT_CANARY" },
        nested: { requestId: "SECRET_MODEL_REQUEST_CANARY" },
      } as ModelInfo],
      readCachedCrossPreferences: () => ({
        preferences: crossPreferences,
        available: true,
      }),
    },
    session: {
      data: {
        costs: { mainUsd: 1, compressorUsd: 0.25, voiceUsd: 0, totalUsd: 1.25, costKnowledge: "unknown" },
        dailySpendUsd: { "2026-08-25": 0.75 },
      },
    },
    ruleStore: {
      list: () => [{ id: "rule-safe", decision: "allow" as const, secret: "RULE_SECRET_CANARY" }],
    },
    workspace: "/owner/workspace",
    readCachedWorkspaceTotalUsd: () => 2.5,
    now: () => new Date("2026-08-25T12:00:00.000Z"),
  });

  const snapshot = port.readCached();
  assert.equal(commandExecutions, 0);
  assert.equal(credentialReads, 0);
  assert.equal(networkCalls, 0);
  assert.equal(snapshot.providers[0]?.allowedActions.includes("disconnect"), false);
  assert.deepEqual(snapshot.providers[1]?.allowedActions, []);
  assert.deepEqual(snapshot.costs, {
    costKnowledge: "unknown",
    sessionUsd: 1.25,
    dayUsd: 0.75,
    totalUsd: 2.5,
  });
  assert.deepEqual(snapshot.approvalRules, [{ id: "rule-safe", decision: "allow" }]);
  assert.equal(snapshot.cachedModels[0]?.id, "k3");
  // The executor route is reduced to the one field the Settings row renders
  // (settings-registry's `architectExecutorDisplay`), exactly like
  // `SettingsProviderProjection.selectedModel` — not merely fingerprint-free.
  assert.deepEqual(snapshot.config.architectExecutor, { requestedModelId: "k3" });
  // F1b: both Cross roles are reduced to the one field the rows render
  // (settings-registry's `crossRoleDisplay`) — reduction, not just absence.
  assert.deepEqual(snapshot.cross, {
    preferences: {
      lead: { requestedModelId: "k3" },
      challenger: { requestedModelId: "k2" },
    },
    available: true,
  });
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  assert.deepEqual(
    collectObjectKeys(snapshot).filter((key) =>
      /^(providerSetup|credentialSlot|credentialBinding|pointer|homeId|codexHome|accountFingerprint|accountFingerprintSuffix|apiKey|secret|requestId)$/i.test(key)),
    [],
  );
  assert.equal(Object.isFrozen(snapshot), true);

  const assertNoIdentity = (planted: unknown, label: string): void => {
    assert.equal(JSON.stringify(planted).includes("SECRET"), false, label);
    assert.deepEqual(
      collectObjectKeys(planted).filter((key) =>
        /^(providerSetup|credentialSlot|credentialBinding|pointer|homeId|codexHome|accountFingerprint|accountFingerprintSuffix|apiKey|secret|requestId)$/i.test(key)),
      [],
      label,
    );
  };

  // Closes the default-null blind spot for every FUTURE field too: the port
  // re-projects `input.config` on each read, so planting a fingerprint-bearing
  // route in each null-defaulting field in turn asks the same question of the
  // whole projection rather than of one hand-picked field.
  const nullDefaultFields = Object.entries(DEFAULT_CONFIG)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  assert.ok(nullDefaultFields.includes("architectExecutor"));
  const mutableConfig = config as unknown as Record<string, unknown>;
  for (const field of nullDefaultFields) {
    const original = mutableConfig[field];
    mutableConfig[field] = fingerprintRoute(`SECRET_${field}_FINGERPRINT_CANARY`);
    assertNoIdentity(port.readCached(), field);
    mutableConfig[field] = original;
  }

  // F1b: the identical walk over the runtime-sourced pair, whose two roles are
  // null-defaulting in the very same way — a half-set pair (one role staged,
  // the counterpart still unset) is a state Settings reaches on the way to
  // every configured pair, so it is walked here rather than assumed safe.
  const crossRoles = Object.entries(crossPreferences).map(([role]) => role);
  assert.deepEqual(crossRoles, ["lead", "challenger"]);
  const mutableCross = crossPreferences as unknown as Record<string, unknown>;
  for (const role of crossRoles) {
    const original = { ...crossPreferences };
    crossPreferences.lead = null;
    crossPreferences.challenger = null;
    mutableCross[role] = fingerprintRoute(`SECRET_CROSS_${role}_ALONE_FINGERPRINT_CANARY`);
    assertNoIdentity(port.readCached(), role);
    Object.assign(crossPreferences, original);
  }
});

test("cached Settings model projection prefers the exact provider-aware authority over a mixed backend cache", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "k3";
  const kimiModel: ModelInfo = {
    id: "k3",
    canonicalSlug: "k3",
    name: "Kimi K3",
    description: "Kimi membership model",
    contextLength: 262_144,
    promptPrice: -1,
    completionPrice: -1,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
  const wrongBackendModel: ModelInfo = {
    id: "openai/gpt-cross-backend",
    canonicalSlug: "openai/gpt-cross-backend-canonical",
    name: "Wrong OpenRouter cache entry",
    description: "must never enter a Kimi Settings route",
    contextLength: 128_000,
    promptPrice: 1,
    completionPrice: 2,
    supportedParameters: ["tools"],
    inputModalities: ["text", "audio"],
    outputModalities: ["text"],
  };
  let exactReads = 0;
  const port = createSettingsRuntimeSnapshotPort({
    config,
    runtime: {
      activity: () => ({ runActive: false, activationHeld: false }),
      readCachedSettingsRoute: () => ({
        backendId: "kimi-code",
        providerLabel: "Kimi Code",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        modelLabel: "Kimi K3",
        billingRealm: "kimi-code-membership-provider-managed-overage",
      }),
      readCachedProviderStatus: () => [],
      readCachedSettingsModels: () => {
        exactReads += 1;
        return [kimiModel];
      },
      readCachedModels: () => [kimiModel, wrongBackendModel],
    },
    session: {
      data: {
        costs: { totalUsd: 0, costKnowledge: "unknown" },
        dailySpendUsd: {},
      },
    },
    ruleStore: { list: () => [] },
    workspace: "/synthetic/provider-aware-settings",
  });

  const snapshot = port.readCached();
  assert.equal(exactReads, 1);
  assert.deepEqual(snapshot.cachedModels.map((model) => model.id), ["k3"]);
  assert.equal(
    snapshot.cachedModels.some((model) => model.id === wrongBackendModel.id),
    false,
    "a Kimi route must not expose an OpenRouter model for any Settings editor",
  );
});

test("cached Settings model projection fails closed when its exact provider-owned authority is absent", () => {
  let unsafeFallbackReads = 0;
  const port = createSettingsRuntimeSnapshotPort({
    config: structuredClone(DEFAULT_CONFIG),
    runtime: {
      activity: () => ({ runActive: false, activationHeld: false }),
      readCachedSettingsRoute: () => ({
        backendId: "kimi-code",
        providerLabel: "Kimi Code",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        modelLabel: "Kimi K3",
        billingRealm: "kimi-code-membership-provider-managed-overage",
      }),
      readCachedProviderStatus: () => [],
      readCachedModels: () => {
        unsafeFallbackReads += 1;
        return [{
          id: "openrouter/cross-account",
          name: "Unsafe cross-account cache",
          description: "must never be grafted into Settings",
          contextLength: 1,
          promptPrice: 0,
          completionPrice: 0,
          supportedParameters: [],
          inputModalities: ["text"],
          outputModalities: ["text"],
        }];
      },
    },
    session: { data: { costs: { totalUsd: 0 }, dailySpendUsd: {} } },
    ruleStore: { list: () => [] },
    workspace: "/synthetic/fail-closed-settings",
  });

  assert.deepEqual(port.readCached().cachedModels, []);
  assert.equal(unsafeFallbackReads, 0);
});

test("default runtime exposes and populates a synchronous secretless model cache without provider effects", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      readCachedModels(): readonly ModelInfo[];
      runModelCatalog<T>(run: () => Promise<T>): Promise<T>;
      runWithReadyRoute<T>(run: (route: RouteIdentityV1) => Promise<T>): Promise<T>;
    };
  }).DefaultProviderRuntime;
  let forbiddenEffects = 0;
  const forbidden = new Proxy({}, {
    get() {
      forbiddenEffects += 1;
      throw new Error("cached model reads must not touch provider effects");
    },
  });
  const runtime = new Runtime(
    forbidden,
    forbidden,
    forbidden,
    new ProviderStateStore(structuredClone(DEFAULT_CONFIG.providerSetup)),
    forbidden,
    forbidden,
    new SessionProviderRuntimeGuard(),
    forbidden,
    null,
    null,
    "openrouter/auto",
    structuredClone(DEFAULT_CONFIG),
  );

  const models = runtime.readCachedModels();
  assert.deepEqual(models.map((model) => model.id), [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ]);
  assert.equal(forbiddenEffects, 0);
  assert.equal(Object.isFrozen(models), true);
  assert.deepEqual(
    collectObjectKeys(models).filter((key) =>
      /^(providerSetup|credentialSlot|credentialBinding|pointer|homeId|codexHome|accountFingerprint|accountFingerprintSuffix|apiKey|secret|requestId)$/i.test(key)),
    [],
  );

  runtime.runWithReadyRoute = async (run) => run({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_cache_test_only",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/cached",
    canonicalModelId: "vendor/cached-canonical",
    resolutionState: "resolved",
  });
  await runtime.runModelCatalog(async () => [{
    id: "vendor/cached",
    canonicalSlug: "vendor/cached-canonical",
    name: "Cached OpenRouter Model",
    description: "safe",
    contextLength: 128_000,
    promptPrice: 0.1,
    completionPrice: 0.2,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    requestId: "SECRET_CATALOG_REQUEST_CANARY",
  } as ModelInfo]);
  const populated = runtime.readCachedModels();
  assert.equal(populated.some((model) => model.id === "vendor/cached"), true);
  assert.equal(JSON.stringify(populated).includes("SECRET"), false);
  assert.equal(forbiddenEffects, 0);
});

test("default runtime Settings cache is bound to the exact active backend and rejects cross-backend grafts", () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      readCachedSettingsModels?: () => readonly ModelInfo[];
    };
  }).DefaultProviderRuntime;
  const openRouterModel: ModelInfo = {
    id: "openai/provider-aware-main",
    canonicalSlug: "openai/provider-aware-main-canonical",
    name: "Provider-aware OpenRouter main",
    description: "synthetic cached model",
    contextLength: 128_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
  const kimiRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_provider_aware_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  };
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: "provider-aware-kimi",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:73737373-7373-4373-8373-737373737373" },
      accountFingerprint: kimiRoute.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: kimiRoute.billingRealm,
      lastHealth: null,
    }],
    defaultRoute: kimiRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = kimiRoute.requestedModelId;
  config.providerSetup = structuredClone(state);
  const runtime = new Runtime(
    { readCachedModels: () => [openRouterModel] },
    {},
    {},
    new ProviderStateStore(state),
    { ensureRunnableRoute: () => structuredClone(kimiRoute) },
    {},
    new SessionProviderRuntimeGuard(),
    {},
    null,
    null,
    kimiRoute.requestedModelId,
    config,
  );

  assert.equal(typeof runtime.readCachedSettingsModels, "function");
  const models = runtime.readCachedSettingsModels!();
  assert.equal(models.some((model) => model.id === openRouterModel.id), false);
  assert.deepEqual(models.map((model) => model.id), [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ]);
});

test("production Settings resolver uses the exact registry adapter catalogue for every enabled model family", async () => {
  const createResolver = (cliModule as unknown as {
    createSettingsEditorResolver?: (context: unknown) => {
      searchModels(request: Record<string, unknown>, query: string): readonly ModelInfo[];
    };
  }).createSettingsEditorResolver;
  assert.equal(typeof createResolver, "function");

  const descriptors: BackendModelDescriptor[] = [{
    backendId: "openrouter",
    requestedModelId: "openai/exact-main",
    canonicalModelId: "openai/exact-main-canonical",
    displayName: "Exact main",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  }, {
    backendId: "openrouter",
    requestedModelId: "vendor/exact-compressor",
    canonicalModelId: "vendor/exact-compressor",
    displayName: "Exact compressor",
    capabilities: { textInput: false, textOutput: true, tools: false, reasoning: false },
  }, {
    backendId: "openrouter",
    requestedModelId: "vendor/exact-audio",
    canonicalModelId: "vendor/exact-audio",
    displayName: "Exact audio",
    capabilities: { textInput: false, textOutput: true, tools: false, reasoning: false },
  }];
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
  const adapter: BackendAdapter = {
    backendId: "openrouter" as const,
    async inspect() { throw new Error("unused registry inspection"); },
    async connect() { throw new Error("unused registry connection"); },
    async listModels() { return descriptors; },
    async activate() { throw new Error("unused registry activation"); },
    async reconnect() { throw new Error("unused registry reconnect"); },
    async logout() {},
    async discardCandidate() {},
  };
  const registry = new BackendRegistry([{ descriptor, adapter }]);
  const listed = await registry.adapter("openrouter").listModels({
    connectionId: "exact-owner-connection",
    signal: new AbortController().signal,
  });
  const exactModels: ModelInfo[] = listed.map((entry) => ({
    id: entry.requestedModelId,
    canonicalSlug: entry.canonicalModelId,
    name: entry.displayName,
    description: "real registry adapter fixture",
    contextLength: 128_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: [
      ...(entry.capabilities.tools ? ["tools"] : []),
      ...(entry.capabilities.reasoning ? ["reasoning"] : []),
    ],
    inputModalities: [
      ...(entry.capabilities.textInput ? ["text"] : []),
      ...(entry.requestedModelId.endsWith("audio") ? ["audio"] : []),
    ],
    outputModalities: entry.capabilities.textOutput ? ["text"] : [],
  }));
  const wrongKimiGraft: ModelInfo = {
    id: "k3",
    canonicalSlug: "k3",
    name: "Wrong Kimi cache on OpenRouter",
    description: "cross-backend negative fixture",
    contextLength: 262_144,
    promptPrice: -1,
    completionPrice: -1,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "openai/exact-main";
  const routeProjection = {
    backendId: "openrouter" as const,
    providerLabel: "OpenRouter",
    requestedModelId: "openai/exact-main",
    canonicalModelId: "openai/exact-main-canonical",
    modelLabel: "Exact main",
    billingRealm: "openrouter-payg" as const,
  };
  const resolver = createResolver!({
    config,
    providerRuntime: {
      readCachedSettingsRoute: () => routeProjection,
      readCachedSettingsModels: () => exactModels,
      readCachedModels: () => [...exactModels, wrongKimiGraft],
    },
    openRouter: { readCachedModels: () => [wrongKimiGraft] },
  });
  const search = (filter: "main" | "compressor" | "panel" | "audio-input") =>
    resolver.searchModels({ editor: { kind: "model", filter } }, "").map((model) => model.id);

  assert.ok(search("main").includes("openai/exact-main"));
  assert.ok(search("compressor").includes("vendor/exact-compressor"));
  assert.ok(search("panel").includes("openai/exact-main"));
  assert.ok(search("audio-input").includes("vendor/exact-audio"));
  assert.equal(search("main").includes("k3"), false, "wrong backend IDs must not be grafted onto OpenRouter");

  const kimiResolver = createResolver!({
    config: { ...config, mainModel: "k3" },
    providerRuntime: {
      readCachedSettingsRoute: () => ({
        ...routeProjection,
        backendId: "kimi-code" as const,
        providerLabel: "Kimi Code",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        modelLabel: "Kimi K3",
        billingRealm: "kimi-code-membership-provider-managed-overage" as const,
      }),
      readCachedSettingsModels: () => [wrongKimiGraft],
      readCachedModels: () => [wrongKimiGraft, ...exactModels],
    },
    openRouter: { readCachedModels: () => exactModels },
  });
  const kimiSearch = (filter: "main" | "compressor" | "panel" | "audio-input") =>
    kimiResolver.searchModels({ editor: { kind: "model", filter } }, "").map((model) => model.id);
  assert.deepEqual(kimiSearch("main"), ["k3"]);
  assert.deepEqual(kimiSearch("compressor"), []);
  assert.deepEqual(kimiSearch("panel"), []);
  assert.deepEqual(kimiSearch("audio-input"), []);
});

test("Settings-Setup-Surface nutzt Picker und Notices ohne Chat- oder Config-Mutation", async () => {
  const chatMessages: string[] = [];
  const notices: string[] = [];
  let restores = 0;
  const config = structuredClone(DEFAULT_CONFIG);
  const before = structuredClone(config);
  const settingsUi = {
    pickChoice: async () => null,
    readSecret: async () => "SECRET_INPUT_CANARY",
    pickModel: async () => null,
    confirmAction: async () => ({ accepted: false }),
    addMessage: (_role: string, message: string) => chatMessages.push(message),
    showSettingsNotice: (message: string) => notices.push(message),
    restoreSettings: () => {
      restores += 1;
    },
  };
  const surface = createSettingsSetupSurface(settingsUi);

  assert.equal(await surface.chooseHub([{
    id: "openrouter",
    label: "OpenRouter",
    description: "Provider",
    disabled: false,
    current: true,
    generation: 1,
  }]), null);
  surface.present({ version: 1, type: "notice", message: "Abgebrochen" });

  assert.deepEqual(config, before);
  assert.deepEqual(chatMessages, []);
  assert.deepEqual(notices, ["Abgebrochen"]);
  assert.equal(notices.join(" ").includes("SECRET_INPUT_CANARY"), false);
  assert.ok(restores >= 1);
});

// F7 fix round 1, Critical C1: readSecret on the Settings surface must push
// the pending pre-secret notice into the chat transcript - the one channel
// that survives the nested secret prompt's own surface switch - BEFORE
// opening the secret input itself. The frame-level proof that this content
// actually survives on screen, and that the secret itself never leaks, is
// in tests/tui.test.ts ("setup TUI surface shows a pending pre-secret
// notice..."), which exercises the identical addMessage mechanism through
// createTuiSetupSurface against a real TerminalUi; this test pins the
// equivalent wiring order for createSettingsSetupSurface at the mock level.
test("Settings-Setup-Surface's readSecret pushes the pending pre-secret notice into chat before opening the secret input", async () => {
  const calls: string[] = [];
  const settingsUi = {
    pickChoice: async () => null,
    readSecret: async (label: string) => {
      calls.push(`secret:${label}`);
      return "SECRET_INPUT_CANARY";
    },
    pickModel: async () => null,
    confirmAction: async () => ({ accepted: false }),
    addMessage: (_role: string, message: string) => calls.push(`chat:${message}`),
    showSettingsNotice: (message: string) => calls.push(`status:${message}`),
    restoreSettings: () => calls.push("restore"),
  };
  const surface = createSettingsSetupSurface(settingsUi);
  const consequence = "An existing Kimi Code membership key is connected (account …abc123). "
    + "Submitting a new key replaces it; press Esc to keep the current one and cancel.";

  surface.present({ version: 1, type: "notice", message: consequence });
  const secret = await surface.readSecret({ backendId: "kimi-code", message: "Kimi Code membership key" });

  assert.equal(secret, "SECRET_INPUT_CANARY");
  const chatIndex = calls.findIndex((entry) => entry.startsWith("chat:"));
  const secretIndex = calls.findIndex((entry) => entry.startsWith("secret:"));
  assert.ok(chatIndex >= 0, "the pending notice must reach the chat transcript");
  assert.ok(chatIndex >= 0 && secretIndex >= 0 && chatIndex < secretIndex, "the notice must be pushed before the secret prompt opens");
  assert.match(calls[chatIndex]!, /Kimi Code membership key[\s\S]*An existing Kimi Code membership key is connected/);
  assert.equal(calls.some((entry) => entry.includes("SECRET_INPUT_CANARY")), false, "the secret itself must never reach chat");
});

test("Settings-Setup-Surface stellt Settings auch nach synchronen UI-Fehlern wieder her", async () => {
  let restores = 0;
  const surface = createSettingsSetupSurface({
    pickChoice() {
      throw new Error("sync-picker-failure");
    },
    async readSecret() {
      return null;
    },
    async pickModel() {
      return null;
    },
    async confirmAction() {
      return { accepted: false };
    },
    showSettingsNotice() {
      throw new Error("sync-notice-failure");
    },
    restoreSettings() {
      restores += 1;
    },
    addMessage() {},
  });

  await assert.rejects(surface.chooseHub([]), /sync-picker-failure/);
  assert.equal(restores, 1);
  assert.throws(
    () => surface.present({ version: 1, type: "notice", message: "Status" }),
    /sync-notice-failure/,
  );
  assert.equal(restores, 2);
});

test("Settings main-model canonical transition uses shared auth recovery and returns to the keyboard-only Settings surface", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: RouteIdentityV1, persisted: boolean, secret: string): void;
      transitionSessionRoute(
        route: RouteIdentityV1,
        publication: unknown,
        surface: SetupSurface,
      ): Promise<RouteIdentityV1>;
      runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const oldRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_settings_auth_owner",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/old",
    canonicalModelId: "vendor/old-canonical",
    resolutionState: "resolved",
  };
  const connection: ProviderConnectionStateV3 = {
    id: "settings-auth-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:71717171-7171-4171-8171-717171717171" },
    accountFingerprint: oldRoute.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 5,
    lifecycle: "configured",
    connections: [connection],
    defaultRoute: oldRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = oldRoute.requestedModelId;
  config.providerSetup = stateStore.read();
  const secret = "synthetic-settings-auth-secret";
  const openRouter = new OpenRouterService(secret);
  const authFailure = Object.assign(new Error("synthetic Settings authentication rejection"), {
    code: "provider-authentication-rejected" as const,
  });
  const recoveryEvents: string[] = [];
  const orchestrator = {
    ensureRunnableRoute: () => structuredClone(oldRoute),
    async activateCandidate() {
      recoveryEvents.push("activation-auth-rejected");
      throw authFailure;
    },
    async reconnect(backendId: string) {
      recoveryEvents.push(`reconnect:${backendId}`);
      return { mode: "setup-required" };
    },
  };
  const credentialAuthority = {
    async withCredential<T>(
      _request: unknown,
      use: (candidate: string, context: Record<string, unknown>) => Promise<T>,
    ) {
      const value = await use(secret, {
        binding: {
          stateRevision: state.revision,
          connectionId: connection.id,
          accountFingerprint: connection.accountFingerprint,
          billingRealm: connection.billingRealm,
        },
        candidatePermit: Object.freeze({ version: 1 }),
      });
      return { kind: "available" as const, value };
    },
  };
  const runtime = new Runtime(
    openRouter,
    {},
    {
      descriptor() { return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" }; },
      entries() { return []; },
    },
    stateStore,
    orchestrator,
    {},
    new SessionProviderRuntimeGuard(),
    {},
    secret,
    null,
    oldRoute.requestedModelId,
    config,
    undefined,
    { credentialAuthority, adapter: {}, async recover() {} },
    "local-interactive-owner",
  );
  runtime.adoptCredentialActivation(oldRoute, true, secret);

  const chatMessages: string[] = [];
  const settingsNotices: string[] = [];
  let settingsRestores = 0;
  const settingsUi = {
    async pickChoice() { return null; },
    async readSecret() { return null; },
    async pickModel() { return null; },
    async confirmAction() { return { accepted: false }; },
    addMessage(_role: string, message: string) { chatMessages.push(message); },
    showSettingsNotice(message: string) { settingsNotices.push(message); },
    restoreSettings() { settingsRestores += 1; },
  };
  const settingsSurface = createSettingsSetupSurface(settingsUi);
  const setupSurfaces: Array<SetupSurface | "plain" | "fullscreen"> = [];
  runtime.runSetup = async (surface) => {
    setupSurfaces.push(surface);
    if (typeof surface !== "string") {
      surface.present({ version: 1, type: "notice", message: "Settings auth recovery" });
    }
    return { kind: "cancelled", mode: "setup-required" };
  };

  await assert.rejects(
    runtime.transitionSessionRoute(
      {
        ...oldRoute,
        requestedModelId: "vendor/new",
        canonicalModelId: "vendor/new-canonical",
      },
      {} as never,
      settingsSurface,
    ),
    (error: unknown) => error === authFailure,
  );

  assert.deepEqual(recoveryEvents, [
    "activation-auth-rejected",
    "reconnect:openrouter",
  ]);
  assert.deepEqual(setupSurfaces, [settingsSurface]);
  assert.deepEqual(chatMessages, []);
  assert.deepEqual(settingsNotices, ["Settings auth recovery"]);
  assert.equal(settingsRestores, 1);
});

test("fresh production runtime recovery converges representative model-preference crashes to one OLD or FINAL tuple", async (t) => {
  for (const [failpoint, expectedModel] of [
    ["before-provider-preparation", "vendor/restart-old"],
    ["after-provider-commit", "vendor/restart-final"],
  ] as const satisfies ReadonlyArray<readonly [ModelPreferenceFailpoint, string]>) {
    await t.test(failpoint, async () => {
      const root = await mkdtemp(join(tmpdir(), "orcode-real-runtime-recovery-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const appHome = join(root, ".orcode");
      const workspace = join(root, "workspace");
      const configPath = join(appHome, "config.json");
      await mkdir(workspace, { recursive: true });

      const oldModel = "vendor/restart-old";
      const finalModel = "vendor/restart-final";
      const accountFingerprint = "acct_restart_runtime_owner";
      const connectionId = "restart-runtime-connection";
      const oldSlotId = "v1:inference:92929292-9292-4292-8292-929292929292";
      const secret = "synthetic-restart-runtime-provider-secret";
      const routeFor = (model: string): RouteIdentityV1 => ({
        version: 1,
        backendId: "openrouter",
        accountFingerprint,
        billingRealm: "openrouter-payg",
        requestedModelId: model,
        canonicalModelId: model,
        resolutionState: "resolved",
      });
      const oldRoute = routeFor(oldModel);
      const finalRoute = routeFor(finalModel);
      const models: readonly BackendModelDescriptor[] = [oldModel, finalModel].map((model) => ({
        backendId: "openrouter",
        requestedModelId: model,
        canonicalModelId: model,
        displayName: model,
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
      }));
      const healthy = (generation: number) => ({
        credential: "valid" as const,
        connectivity: "connected" as const,
        spend: "available" as const,
        runtime: "ready" as const,
        observedAt: 1,
        generation,
      });
      const initialState: ProviderSetupStateV3 = {
        schemaVersion: 3,
        revision: 4,
        lifecycle: "configured",
        connections: [{
          id: connectionId,
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialBinding: { kind: "orcode-keychain" as const, pointer: oldSlotId },
          accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: healthy(1),
        }],
        defaultRoute: oldRoute,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      };
      const initialConfig = structuredClone(DEFAULT_CONFIG);
      initialConfig.mainModel = oldModel;
      initialConfig.providerSetup = structuredClone(initialState);
      await saveConfig(initialConfig, configPath);
      const initialSession = SessionStore.create(workspace, appHome, "Real restart runtime");
      initialSession.setPreferences(oldModel, { mode: "auto" }, oldRoute);
      await initialSession.save();

      const slots = new Map<string, string>([[oldSlotId, secret]]);
      let slotSequence = 1;
      const credentials = {
        location: "synthetic-versioned-store",
        async get() { return null; },
        async set() {},
        async delete() { return false; },
        async has() { return false; },
        reserveSlot(kind: CredentialSlotRef["kind"]) {
          const id = `v1:${kind}:93939393-9393-4393-8393-${String(slotSequence++).padStart(12, "0")}`;
          return Object.freeze({ version: 1 as const, kind, id });
        },
        async writeSlot(slot: CredentialSlotRef, value: string) { slots.set(slot.id, value); },
        async readSlot(slot: CredentialSlotRef) { return slots.get(slot.id) ?? null; },
        async deleteSlot(slot: CredentialSlotRef) { return slots.delete(slot.id); },
        async getOrCreateAccountHmacKey() { return new Uint8Array(32).fill(9); },
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
      let candidateSequence = 1;
      const makeAdapter = (): BackendAdapter => ({
        backendId: "openrouter",
        async inspect(request) {
          return {
            backendId: "openrouter",
            connectionId: request.connectionId,
            health: healthy(request.generation),
            headline: "ready",
            accountFingerprint,
            billingRealm: "openrouter-payg",
            routeEligible: true,
            retryable: false,
            explanationCode: "restart-runtime-ready",
          };
        },
        async reconnect(request) { return this.inspect(request); },
        async bindRuntime() {},
        async logout() {},
        async connect(request) {
          assert.equal(request.candidate, secret);
          return {
            candidateId: `restart-candidate-${candidateSequence++}`,
            backendId: "openrouter",
            connectionId,
            accountFingerprint,
            billingRealm: "openrouter-payg",
            health: healthy(request.generation),
          };
        },
        async listModels() { return models; },
        async activate(request) {
          return {
            candidateId: request.candidateId,
            backendId: "openrouter",
            connectionId,
            accountFingerprint,
            billingRealm: "openrouter-payg",
            route: routeFor(request.model.requestedModelId),
          };
        },
        async discardCandidate() {},
      });

      let uuidSequence = 1;
      const reconstruct = async (recover: boolean) => {
        const loaded = await loadConfigDetailed(configPath);
        const session = await SessionStore.openById(workspace, initialSession.data.id, appHome);
        const state = loaded.config.providerSetup as ProviderSetupStateV3;
        const stateStore = new ProviderStateStore(state, {
          persist: (request) => persistProviderSetupState(configPath, request),
        });
        const adapter = makeAdapter();
        const registry = new BackendRegistry([{ descriptor, adapter }]);
        const runtimeGuard = new SessionProviderRuntimeGuard();
        let coordinator!: ProviderActivationCoordinator;
        const credentialAuthority = new ProviderCredentialAuthority({
          stateStore,
          credentials,
          environment: {},
          coordinator: () => coordinator,
        });
        coordinator = new ProviderActivationCoordinator({
          appHome,
          configPath,
          privateStore: new PrivateStore({ root: appHome }),
          credentials,
          adapterResolver: () => adapter,
          stateStore,
          runtimeGuard,
          candidateAuthority: credentialAuthority,
          createUuid: () => `94949494-9494-4494-8494-${String(uuidSequence++).padStart(12, "0")}`,
        });
        const orchestrator = new SetupOrchestrator({
          registry,
          stateStore,
          activationCoordinator: coordinator,
        });
        let runtime!: DefaultProviderRuntime;
        runtime = new DefaultProviderRuntime(
          new OpenRouterService(secret),
          credentials as never,
          registry,
          stateStore,
          orchestrator,
          coordinator,
          runtimeGuard,
          { async apply() { throw new Error("unused credential intent"); } },
          null,
          null,
          loaded.config.mainModel,
          loaded.config,
          session,
          {
            credentialAuthority,
            adapter: adapter as never,
            forgetJournal: {} as never,
            async recover(context) {
              if (!recover) return;
              await coordinator.recoverAndRun({
                signal: context.signal,
                inspectCommitted: true,
                allowedBackendIds: ["openrouter"],
              }, async (lease) => {
                await recoverModelPreferenceTransactions({
                  appHome,
                  allowedBackendIds: ["openrouter"],
                  routeAuthority: {
                    assertHeld: () => lease.assertHeld(),
                    async read() { return runtime.readModelPreferenceAuthority(); },
                  },
                });
              });
            },
          },
          "local-interactive-owner",
        );
        return { runtime, coordinator, stateStore, session, config: loaded.config };
      };

      const owner = await reconstruct(false);
      const startup = await owner.runtime.inspectStartup();
      assert.equal(startup.mode, "ready");
      assert.deepEqual(owner.runtime.currentSessionRoute(), oldRoute);
      const expectedConfig = await readConfigEditSnapshot(configPath);
      const expectedSession = await readSessionEditSnapshot(owner.session.path);
      const nextSession = prepareSessionPreferenceEdit(expectedSession, {
        requestedModelId: finalModel,
        reasoning: { mode: "auto" },
        route: finalRoute,
      });
      const runtimePublication = owner.runtime.prepareSettingsModelPublication(finalRoute);

      await assert.rejects(runModelPreferenceTransaction({
        appHome,
        configPath,
        sessionPath: owner.session.path,
        expectedConfig,
        nextConfig: (nextProviderState) => ({
          ...structuredClone(expectedConfig.config),
          mainModel: finalModel,
          providerSetup: structuredClone(nextProviderState),
        }),
        expectedSession,
        nextSession,
        beforeRoute: oldRoute,
        afterRoute: finalRoute,
        routeAuthority: createModelPreferenceRouteAuthority({
          runtime: owner.runtime,
        }),
        publish() { runtimePublication.publish(); },
        failpoint,
      }), failpoint === "before-provider-preparation"
        ? ModelPreferenceCrashError
        : ModelPreferenceRecoveryRequiredError);

      const recovering = await reconstruct(true);
      await recovering.runtime.inspectStartup();
      const recovered = await reconstruct(false);
      const recoveredStartup = await recovered.runtime.inspectStartup();
      assert.equal(recoveredStartup.mode, "ready");
      const diskConfig = await loadConfigDetailed(configPath);
      const diskSession = await SessionStore.openById(workspace, initialSession.data.id, appHome);
      const expectedRoute = routeFor(expectedModel);
      const authority = recovered.runtime.readModelPreferenceAuthority();
      assert.equal(diskConfig.config.mainModel, expectedModel);
      assert.deepEqual((diskConfig.config.providerSetup as ProviderSetupStateV3).defaultRoute, expectedRoute);
      assert.equal(diskSession.data.model, expectedModel);
      assert.deepEqual(diskSession.data.route, expectedRoute);
      assert.deepEqual(authority.route, expectedRoute);
      assert.deepEqual(recovered.stateStore.read().defaultRoute, expectedRoute);
      assert.deepEqual(recovered.runtime.currentSessionRoute(), expectedRoute);
    });
  }
});

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectObjectKeys(nested)]);
}

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
    startDeferredRetention: () => undefined,
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
  assert.match(homeWorkspaceWarning(home, home) ?? "", /home directory/);
  assert.match(homeWorkspaceWarning(`${home}/`, home) ?? "", /home directory/);
  assert.equal(homeWorkspaceWarning(`${home}/projekt`, home), null);
});

test("plain interactive banner consumes the canonical Route Core renderer", () => {
  const banner = renderCliBanner("/tmp/workspace", "provider/model", "0.7.0", {
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "ascii",
  }, { ORCODE_ASCII: "1" });
  assert.match(banner, /---------\*/);
  assert.match(banner, /ORCODE/);
  assert.doesNotMatch(banner, /\u001b/);
});

test("runDashboard is the production lifecycle adapter injectable into runCli", () => {
  const productionDashboard = (cliModule as typeof cliModule & {
    runDashboard?: unknown;
  }).runDashboard;
  assert.equal(
    typeof productionDashboard,
    "function",
    "the PTY must inject the real dashboard lifecycle, not a TerminalUi-only substitute",
  );
});

test("active Cross quit cleanup stops and drains the background run before loop shutdown", async () => {
  const stopAndDrain = (cliModule as typeof cliModule & {
    stopAndDrainCrossRun?: (
      cross: { stop(): Promise<unknown> } | undefined,
      active: Promise<unknown> | null,
    ) => Promise<void>;
  }).stopAndDrainCrossRun;
  assert.equal(typeof stopAndDrain, "function");
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; })
    .then(() => { events.push("drained"); });

  await stopAndDrain!(
    {
      async stop() {
        events.push("stop");
        release();
        return {};
      },
    },
    gate,
  );
  assert.deepEqual(events, ["stop", "drained"]);
});

test("dashboard command completion keeps the active Cross stop hint instead of showing Ready", () => {
  const status = (cliModule as typeof cliModule & {
    dashboardCommandStatus?: (crossActive: boolean) => string;
  }).dashboardCommandStatus;
  assert.equal(typeof status, "function");
  assert.equal(status!(true), "Cross running · /cross stop to cancel");
  assert.equal(status!(false), "Ready");
});

// D8e: `/new` (and any chat-switch landing on an empty chat) must not
// publish its confirmation as a transcript block — doing so flips `isHub`
// (`ui/dashboard-frame.ts`) false for a chat with zero turns, replacing the
// clean hub with the old bare transcript layout. `applyDashboardCommandOutput`
// is the extracted decision the real dashboard loop (`runDashboard`, cli.ts)
// makes right after every command's captured output — tested directly here
// exactly like `pickDashboardChat`/`dashboardCommandStatus` above, since
// driving the whole loop end to end is not practical in a unit test.
test("D8e: a chat-switch landing on an empty chat sends its confirmation through the status channel, not a transcript block", () => {
  const messages: Array<{ role: string; content: string; meta?: string }> = [];
  const statuses: string[] = [];
  const ui = {
    addMessage: (role: string, content: string, meta?: string) => {
      messages.push({ role, content, meta });
    },
    setStatus: (status: string) => { statuses.push(status); },
  };

  const shown = applyDashboardCommandOutput(
    ui as never,
    { output: "New chat started.", level: "info" },
    "/new",
    true,
  );

  assert.equal(shown, true);
  assert.deepEqual(messages, []);
  assert.deepEqual(statuses, ["New chat started."]);
});

test("D8e: a /chats pick into a chat WITH content still renders as an ordinary transcript block", () => {
  const messages: Array<{ role: string; content: string; meta?: string }> = [];
  const statuses: string[] = [];
  const ui = {
    addMessage: (role: string, content: string, meta?: string) => {
      messages.push({ role, content, meta });
    },
    setStatus: (status: string) => { statuses.push(status); },
  };

  const shown = applyDashboardCommandOutput(
    ui as never,
    { output: "Chat: Old chat · 3 messages", level: "info" },
    "/chat",
    false,
  );

  assert.equal(shown, false);
  assert.deepEqual(statuses, []);
  assert.deepEqual(messages, [
    { role: "system", content: "Chat: Old chat · 3 messages", meta: "/chat" },
  ]);
});

test("D8e: an error still becomes a transcript block even when the command happened to land on an empty chat", () => {
  const messages: Array<{ role: string; content: string; meta?: string }> = [];
  const statuses: string[] = [];
  const ui = {
    addMessage: (role: string, content: string, meta?: string) => {
      messages.push({ role, content, meta });
    },
    setStatus: (status: string) => { statuses.push(status); },
  };

  const shown = applyDashboardCommandOutput(
    ui as never,
    { output: "Folder does not exist: /nope", level: "error" },
    "/folder",
    true,
  );

  assert.equal(shown, false);
  assert.deepEqual(statuses, []);
  assert.deepEqual(messages, [
    { role: "error", content: "Folder does not exist: /nope", meta: "/folder" },
  ]);
});

// Phase F3 (information-dense pickers), ruling 2: the merged row shape is
// `<n> messages · $<cost> · <model short> · <relative time>`, then F1b's
// foreign-folder suffix appended last, unchanged. Updated from the old
// "3 message(s) · $0.500 · just now · chat-123" pin (no model, an
// always-plural "message(s)", and an 8-char id suffix the binding shape
// drops) — the two prior tests this replaces predate the binding mockup.
test("the chat picker's description line composes the binding merged /chats row shape", () => {
  const chatChoice = (cliModule as typeof cliModule & {
    chatChoice?: (
      chat: ChatSummary,
      theme: ReturnType<typeof createTheme>,
      folder?: string,
    ) => { value: string; label: string; description: string };
  }).chatChoice;
  assert.equal(typeof chatChoice, "function");

  const chat: ChatSummary = {
    id: "chat-1234567890abcdef",
    title: "Refactor the parser",
    workspace: "/workspace/routercode",
    turnCount: 3,
    costUsd: 0.5,
    model: "anthropic/claude-sonnet-5",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // FIX-21 finding 5: the row's separators come from the theme now, so the
  // picker no longer hardcodes a `·` that ASCII glyph mode could not touch.
  const choice = chatChoice!(chat, createTheme({ level: 0 }));
  assert.equal(choice.value, "chat-1234567890abcdef");
  assert.equal(choice.label, "Refactor the parser");
  // "model short" (`shortModelName`) drops the vendor prefix, matching the
  // status line; cost reuses `formatChatCost`'s exact rounding.
  assert.equal(choice.description, "3 messages · $0.500 · claude-sonnet-5 · just now");
  assert.doesNotMatch(choice.description, /Nachrichten/);
});

test("the chat picker's description line singularizes one message and appends a foreign folder last", () => {
  const chatChoice = (cliModule as typeof cliModule & {
    chatChoice?: (
      chat: ChatSummary,
      theme: ReturnType<typeof createTheme>,
      folder?: string,
    ) => { value: string; label: string; description: string };
  }).chatChoice;
  const chat: ChatSummary = {
    id: "chat-solo",
    title: "Solo chat",
    workspace: "/workspace/other",
    turnCount: 1,
    costUsd: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const choice = chatChoice!(chat, createTheme({ level: 0 }), "~/projects/other");
  // No `model` on the chat: the model segment is omitted outright, never a
  // fabricated placeholder — same honesty discipline as the price segment.
  assert.equal(choice.description, "1 message · $0.500 · just now · ~/projects/other");

  // FIX-21 finding 5: the same row in ASCII glyph mode carries the ASCII
  // separator throughout — no raw `·` survives.
  const asciiChoice = chatChoice!(
    chat,
    createTheme({ level: 0, ascii: true }),
    "~/projects/other",
  );
  assert.equal(asciiChoice.description, "1 message - $0.500 - just now - ~/projects/other");
  assert.doesNotMatch(asciiChoice.description, /[^\x00-\x7f]/u, asciiChoice.description);
});

// Fix round 1, IMPORTANT 1a: the plain loop has no persistent status line
// (unlike the dashboard's status segment/welcome box) — a chat loaded
// already armed must say so once, at startup, or the honesty guard has a
// silent gap on this surface.
test("plain loop: prints a one-line armed notice at startup when the loaded chat is persistently armed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-startup-armed-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const mainRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_startup_armed",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const armedLead = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_startup_lead",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/lead",
    canonicalModelId: "vendor/lead",
    resolutionState: "resolved" as const,
  };
  const armedChallenger = { ...armedLead, requestedModelId: "vendor/challenger", canonicalModelId: "vendor/challenger" };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(mainRoute.requestedModelId, { mode: "auto" }, mainRoute);
  session.armCrossMode({ lead: armedLead, challenger: armedChallenger });
  await session.save();

  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: armedLead, challenger: armedChallenger }),
    listSelectableModelRoutes: async () => [],
    modelRuntime() { throw new Error("must not be reached — no message is ever sent in this test"); },
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
  };
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error) },
      session,
      agent: { async run() { throw new Error("must not run — no message is ever sent"); } },
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: () => {}, error: () => {} },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => ({ async run() { throw new Error("must not run"); } }) as never,
      readPlainInput: async () => "/quit",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.deepEqual(logs[0], ["Type a task or /help. Ctrl+C exits.\n"]);
    assert.ok(
      logs.some((entry) =>
        typeof entry[0] === "string"
        && /Cross mode: armed for this chat \(lead\+challenger\) · \/cross off to stop/.test(entry[0])),
      logs.map((entry) => entry.join(" ")).join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain loop: prints no armed notice at startup when the loaded chat is disarmed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-startup-disarmed-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const mainRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_startup_disarmed",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(mainRoute.requestedModelId, { mode: "auto" }, mainRoute);
  await session.save();

  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: null, challenger: null }),
    listSelectableModelRoutes: async () => [],
    modelRuntime() { throw new Error("must not be reached — no message is ever sent in this test"); },
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
  };
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error) },
      session,
      agent: { async run() { throw new Error("must not run — no message is ever sent"); } },
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: () => {}, error: () => {} },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => ({ async run() { throw new Error("must not run"); } }) as never,
      readPlainInput: async () => "/quit",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.deepEqual(logs[0], ["Type a task or /help. Ctrl+C exits.\n"]);
    // Exactly two lines total: the opening banner and the "/quit" exit
    // banner ("See you soon.") — no armed-state line squeezed between them.
    assert.deepEqual(logs.map((entry) => entry[0]), ["Type a task or /help. Ctrl+C exits.\n", "See you soon."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain runtime installs visible Cross status without turning the next ordinary prompt into two model runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-plain-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const route = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_kimi_cross_plain",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const challenger = { ...route, requestedModelId: "k3-thinking", canonicalModelId: "k3-thinking" };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = route.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(route.requestedModelId, { mode: "auto" }, route);
  const outputs: string[] = [];
  const inputs = ["/cross status", "ordinary prompt", "/quit"];
  let mainRuns = 0;
  const agentResult: AgentRunResult = {
    text: "ordinary answer",
    suggestions: [],
    outcome: "completed",
    costUsd: 0,
    mainCostUsd: 0,
    compressorCostUsd: 0,
    costKnowledge: "unknown",
    compression: {
      used: false,
      handoff: "",
      costUsd: 0,
      costKnowledge: "unknown",
      originalChars: 0,
      compressedChars: 0,
      savedPercent: 0,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings: [],
    },
    selectedModel: route.requestedModelId,
    resolvedModel: route.canonicalModelId,
    notices: [],
    partial: false,
    modelSteps: 1,
  };
  const mainAgent = {
    async run(prompt: string) {
      mainRuns += 1;
      assert.equal(prompt, "ordinary prompt");
      return agentResult;
    },
  };
  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: route, challenger }),
    listSelectableModelRoutes: async () => [],
    modelRuntime() { throw new Error("Cross status must not construct role runtimes"); },
    async runWithReadyRoute(run: (exact: typeof route) => Promise<unknown>) { return run(route); },
    currentSessionRoute: () => route,
  };
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error) },
      session,
      agent: mainAgent,
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: (value: string) => outputs.push(value), error: (value: string) => outputs.push(value) },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => mainAgent as never,
      readPlainInput: async () => inputs.shift() ?? "/quit",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.equal(mainRuns, 1);
    // D2: the reshaped `crossSnapshotText` — `Cross · <state glyph> <phase>
    // · Verification <verification>` — replaces the old bare "Cross:
    // Ready" colon format.
    assert.ok(outputs.some((value) => /Cross · ~ Ready · Verification not run/.test(value)), outputs.join("\n"));
    // F5 pin (V3 audit principle 3): the plain loop's opening line used to be
    // a bare `chalk.dim(...)` call; it now goes through `cliTheme`'s `muted`
    // role. At this test process's level (no FORCE_COLOR/NO_COLOR set, no
    // TTY — see `tests/ui-theme.test.ts`'s subprocess-based parity test for
    // why level can't be flipped reliably in-process), `muted` is identity,
    // so the exact same plain text must still be the very first console
    // line — content identical, nothing corrupted by the styling migration.
    assert.deepEqual(logs[0], ["Type a task or /help. Ctrl+C exits.\n"]);
    // /quit runs the loop to its real end, past the exit banner — pin the
    // English wording here so a future stray German string (as happened
    // before) fails a test instead of only reviewer eyes.
    assert.deepEqual(logs.at(-1), ["See you soon."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 10 — persistent Cross mode per chat: the plain loop's armed-dispatch
// seam, and /cross off returning it to single-model.
// ---------------------------------------------------------------------------

test("plain loop: an armed chat routes a plain message to Cross instead of the single-model agent, using the exact armed pair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-armed-plain-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const mainRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_armed_plain",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/main",
    canonicalModelId: "vendor/main",
    resolutionState: "resolved" as const,
  };
  const armedLead = { ...mainRoute, requestedModelId: "vendor/armed-lead", canonicalModelId: "vendor/armed-lead" };
  const armedChallenger = { ...mainRoute, requestedModelId: "vendor/armed-challenger", canonicalModelId: "vendor/armed-challenger" };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(mainRoute.requestedModelId, { mode: "auto" }, mainRoute);
  session.armCrossMode({ lead: armedLead, challenger: armedChallenger });
  await session.save();

  const outputs: string[] = [];
  let mainRuns = 0;
  const mainAgent = {
    async run() {
      mainRuns += 1;
      throw new Error("the single-model agent must never run while this chat is armed");
    },
  };
  const modelRuntimeCalls: string[] = [];
  const providerRuntime = {
    preparedRoles: null,
    // Deliberately NOT the armed pair — proves start()'s pair override wins
    // over whatever the global Cross preferences currently hold.
    readCrossPreferences: () => ({ lead: null, challenger: null }),
    listSelectableModelRoutes: async () => [],
    // No fake model runtime binding is registered for either armed route —
    // Cross's own worker fails with its real, existing "binding is missing"
    // error. This proves the dispatch reached Cross's real runtime entry
    // with the armed routes, without needing a full fake model backend.
    modelRuntime(route: { requestedModelId: string }) {
      modelRuntimeCalls.push(route.requestedModelId);
      return undefined as never;
    },
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
  };
  // The armed dispatch fires the Cross run fire-and-forget (`launchCrossRun`,
  // matching a manually started run today) — `/quit` must not race ahead of
  // it settling, or `stopAndDrainCrossRun` cancels the run instead of
  // letting the real terminal result surface. The coordinator (untouched by
  // Phase 10) catches a worker failure gracefully rather than rejecting —
  // it reaches a "blocked"/"Role run failed" CrossRunSnapshot instead of
  // throwing — so this polls for that snapshot text instead of a fixed
  // sleep.
  let prompted = 0;
  const readPlainInput = async (): Promise<string> => {
    prompted += 1;
    if (prompted === 1) return "armed plain prompt";
    const deadline = Date.now() + 2_000;
    while (
      !outputs.some((value) => /Role run failed/.test(value))
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return "/quit";
  };
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error instanceof Error ? error.message : error) },
      session,
      agent: mainAgent,
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: (value: string) => outputs.push(value), error: (value: string) => outputs.push(value) },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => mainAgent as never,
      readPlainInput,
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.equal(mainRuns, 0, "the single-model agent must never run for a plain message while armed");
    assert.ok(
      modelRuntimeCalls.includes("vendor/armed-lead") || modelRuntimeCalls.includes("vendor/armed-challenger"),
      "Cross's real worker must be reached with the armed pair's routes, not the global Cross preferences",
    );
    // FIX-20, finding 1: the blocked frame names the failing role and the
    // humanized cause; the blind "Role run failed" it used to print here is
    // exactly what the owner could not act on.
    assert.ok(
      outputs.some((value) => /Blocked/.test(value) && /coding model: /.test(value)),
      outputs.join("\n"),
    );
    assert.ok(
      !outputs.some((value) => /Role run failed/.test(value)),
      outputs.join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Owner's final ruling (fix round 1): Start on a genuinely empty chat arms a
// PENDING one-shot rather than refusing or firing a doomed empty-task run.
// This proves the OTHER half of that design — the armed-dispatch seam's own
// one-shot lifecycle: the first message reaches Cross with the armed pair,
// and once that run settles the `oneShot` marker clears automatically
// (SessionStore.clearCrossModeOneShotIfPending via withOneShotClearing), so
// the very next message reverts to the single-model agent with no /cross
// off needed.
test("plain loop: a pending one-shot runs once through Cross, then the marker clears and the next message is single-model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-oneshot-plain-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  // Kimi Code for the main route (like the reference "plain runtime installs
  // visible Cross status ..." test) — the second message's single-model
  // fallback must not need a fake ensureRunnableModelConfiguration/
  // OpenRouter catalog. The armed one-shot pair below stays OpenRouter,
  // entirely independent of the main route's own backend.
  const mainRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_oneshot_plain",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const armedLead = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_oneshot_lead",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/oneshot-lead",
    canonicalModelId: "vendor/oneshot-lead",
    resolutionState: "resolved" as const,
  };
  const armedChallenger = { ...armedLead, requestedModelId: "vendor/oneshot-challenger", canonicalModelId: "vendor/oneshot-challenger" };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(mainRoute.requestedModelId, { mode: "auto" }, mainRoute);
  // Simulates exactly what the gate's own armPendingOneShot leaves behind:
  // an empty chat, Start chosen with nothing typed and no history yet.
  session.armCrossMode({ lead: armedLead, challenger: armedChallenger, oneShot: true });
  await session.save();

  const outputs: string[] = [];
  let mainRuns = 0;
  let lastMainPrompt: string | null = null;
  const agentResult: AgentRunResult = {
    text: "single-model answer",
    suggestions: [],
    outcome: "completed",
    costUsd: 0,
    mainCostUsd: 0,
    compressorCostUsd: 0,
    costKnowledge: "unknown",
    compression: {
      used: false,
      handoff: "",
      costUsd: 0,
      costKnowledge: "unknown",
      originalChars: 0,
      compressedChars: 0,
      savedPercent: 0,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings: [],
    },
    selectedModel: mainRoute.requestedModelId,
    resolvedModel: mainRoute.canonicalModelId,
    notices: [],
    partial: false,
    modelSteps: 1,
  };
  const mainAgent = {
    async run(prompt: string) {
      mainRuns += 1;
      lastMainPrompt = prompt;
      return agentResult;
    },
  };
  const modelRuntimeCalls: string[] = [];
  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: null, challenger: null }),
    listSelectableModelRoutes: async () => [],
    // No fake model runtime binding is registered — Cross's own worker
    // fails cleanly (the coordinator's own graceful "blocked"/"Role run
    // failed" terminal result, untouched by this phase), proving the first
    // message really reached Cross's real entry with the one-shot pair.
    modelRuntime(route: { requestedModelId: string }) {
      modelRuntimeCalls.push(route.requestedModelId);
      return undefined as never;
    },
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
  };
  let prompted = 0;
  let secondMessageAttempts = 0;
  const readPlainInput = async (): Promise<string> => {
    prompted += 1;
    if (prompted === 1) return "first message";
    if (mainRuns === 0) {
      // Keep resubmitting "second message" until it actually reaches the
      // single-model agent. The one-shot marker clears synchronously inside
      // `withOneShotClearing`'s `.finally` callback, strictly BEFORE that
      // callback's own `await session.save()` (and, after it, `activeCrossRun`
      // being released) complete — polling on `session.data.crossMode` alone
      // races that trailing cleanup. A bounded resubmit loop is robust to
      // the exact gap instead of guessing a fixed extra delay; each rejected
      // attempt (still "Cross is already running") just costs one harmless
      // retry.
      secondMessageAttempts += 1;
      assert.ok(secondMessageAttempts <= 400, "the one-shot run/cleanup never appears to have settled");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "second message";
    }
    return "/quit";
  };
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error instanceof Error ? error.message : error) },
      session,
      agent: mainAgent,
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: (value: string) => outputs.push(value), error: (value: string) => outputs.push(value) },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => mainAgent as never,
      readPlainInput,
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.ok(
      modelRuntimeCalls.includes("vendor/oneshot-lead") || modelRuntimeCalls.includes("vendor/oneshot-challenger"),
      "the first message must reach Cross's real worker with the armed one-shot pair",
    );
    assert.equal(mainRuns, 1, "the single-model agent must run exactly once — for the SECOND message only");
    assert.equal(lastMainPrompt, "second message");
    assert.equal(session.data.crossMode, undefined, "the one-shot marker must be fully cleared once its run is done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain loop: /cross off disarms immediately and the very next prompt runs single-model again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-off-plain-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  // Kimi Code, like the pre-existing "plain runtime installs visible Cross
  // status ..." test above — this test's single-model fallback path must
  // not need a fake ensureRunnableModelConfiguration/OpenRouter catalog,
  // and /cross off's own behavior does not depend on which backend is
  // active anyway.
  const mainRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_cross_off_plain",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const armedLead = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_armed_lead",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/armed-lead",
    canonicalModelId: "vendor/armed-lead",
    resolutionState: "resolved" as const,
  };
  const armedChallenger = { ...armedLead, requestedModelId: "vendor/armed-challenger", canonicalModelId: "vendor/armed-challenger" };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const session = SessionStore.create(workspace, appHome);
  session.setPreferences(mainRoute.requestedModelId, { mode: "auto" }, mainRoute);
  session.armCrossMode({ lead: armedLead, challenger: armedChallenger });
  await session.save();

  const outputs: string[] = [];
  const inputs = ["/cross off", "back to normal", "/quit"];
  let mainRuns = 0;
  const agentResult: AgentRunResult = {
    text: "single-model answer",
    suggestions: [],
    outcome: "completed",
    costUsd: 0,
    mainCostUsd: 0,
    compressorCostUsd: 0,
    costKnowledge: "unknown",
    compression: {
      used: false,
      handoff: "",
      costUsd: 0,
      costKnowledge: "unknown",
      originalChars: 0,
      compressedChars: 0,
      savedPercent: 0,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings: [],
    },
    selectedModel: mainRoute.requestedModelId,
    resolvedModel: mainRoute.canonicalModelId,
    notices: [],
    partial: false,
    modelSteps: 1,
  };
  const mainAgent = {
    async run(prompt: string) {
      mainRuns += 1;
      assert.equal(prompt, "back to normal");
      return agentResult;
    },
  };
  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: armedLead, challenger: armedChallenger }),
    listSelectableModelRoutes: async () => [],
    modelRuntime() { throw new Error("Cross must not run at all after /cross off"); },
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
  };
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error instanceof Error ? error.message : error) },
      session,
      agent: mainAgent,
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: (value: string) => outputs.push(value), error: (value: string) => outputs.push(value) },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => mainAgent as never,
      readPlainInput: async () => inputs.shift() ?? "/quit",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    assert.equal(mainRuns, 1, "the single-model agent must run exactly once, for the message sent after /cross off");
    assert.ok(outputs.some((value) => value === "Cross mode off — next message runs single-model."), outputs.join("\n"));
    assert.equal(session.data.crossMode, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain Cross model choice reuses the searchable /model picker semantics for large catalogs and cancel", async () => {
  const routes: SelectableModelRoute[] = Array.from({ length: 100 }, (_, index) => {
    const requestedModelId = index === 99 ? "vendor/needle" : `vendor/model-${index}`;
    return {
      route: {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: `acct-${index}`,
        billingRealm: "openrouter-payg",
        requestedModelId,
        canonicalModelId: requestedModelId,
        resolutionState: "resolved",
      },
      providerLabel: "OpenRouter",
      model: {
        id: requestedModelId,
        name: requestedModelId,
        contextLength: 128_000,
        reasoning: undefined,
        price: { kind: "unknown" },
      },
      supportsTools: true,
      supportsReasoning: true,
      selected: index === 7,
    };
  });
  let promptTitle = "";
  const fakePick = (async (config: {
    title: string;
    choices(query: string): Promise<Array<{ value: SelectableModelRoute }>> | Array<{ value: SelectableModelRoute }>;
  }) => {
    promptTitle = config.title;
    const matches = await config.choices("needle");
    assert.deepEqual(matches.map((entry) => entry.value.route.requestedModelId), ["vendor/needle"]);
    return matches[0]!.value;
  }) as unknown as typeof pickFromListPlain;
  const picker = createPlainCrossModelPicker(
    { listSelectableModelRoutes: async () => routes },
    fakePick,
  );
  const selected = await picker.pickModelRoute({
    title: "Cross · Lead",
    role: "lead",
    current: routes[7]!.route,
    preserveDraft: true,
  });
  assert.equal(selected?.route.requestedModelId, "vendor/needle");
  // FIX-14 ticket 9: the request's own title reaches the screen. This used to
  // assert the hardcoded "Search models" the plain fallback put on every
  // route pick, whatever the caller had asked for.
  assert.equal(promptTitle, "Cross · Lead");

  // Escape/Ctrl+C: the list-core plain picker resolves `null` directly —
  // no throw, no `isPromptExit`-shaped error to catch.
  const cancelPick = (async () => null) as typeof pickFromListPlain;
  const cancelled = await createPlainCrossModelPicker(
    { listSelectableModelRoutes: async () => routes },
    cancelPick,
  ).pickModelRoute({ title: "Cross · Challenger", role: "challenger", current: null, preserveDraft: true });
  assert.equal(cancelled, null);
});

// F1b: Settings' snapshot carries the Cross pair as model ids, so the identity
// the picker's `sameCanonicalModelRoute` exclusion needs is read back here, on
// the runtime side. The staged pair has to win: a lead picked in this Settings
// visit is not publishable yet (a half pair never reaches
// `publishCrossPreferences`), and the challenger's picker must still exclude it.
test("the Settings Cross exclude is resolved runtime-side, staged pair first, published pair otherwise", () => {
  const routeFor = (model: string, account: string): RouteIdentityV1 => ({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: account,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
  const published: CrossPreferencesV1 = {
    lead: routeFor("vendor/published-lead", "acct-published"),
    challenger: null,
  };
  const staged: CrossPreferencesV1 = {
    lead: routeFor("vendor/staged-lead", "acct-staged"),
    challenger: null,
  };
  const context: {
    settingsCrossPreferences?: () => CrossPreferencesV1;
    providerRuntime: { readCrossPreferences?: () => CrossPreferencesV1 };
  } = { providerRuntime: { readCrossPreferences: () => published } };

  // No Settings visit open: the published pair is the whole truth.
  assert.deepEqual(readSettingsCrossRoleRoute(context, "lead"), published.lead);
  assert.equal(readSettingsCrossRoleRoute(context, "challenger"), null);

  // A visit in progress answers with what that visit is working on.
  context.settingsCrossPreferences = () => staged;
  assert.deepEqual(readSettingsCrossRoleRoute(context, "lead"), staged.lead);
  assert.equal(readSettingsCrossRoleRoute(context, "challenger"), null);

  // A runtime with no Cross bridge at all excludes nothing rather than throwing.
  assert.equal(readSettingsCrossRoleRoute({ providerRuntime: {} }, "lead"), null);
});

test("Cross publication appends one unified assistant turn in the tool-style ●/⎿ shape, and nothing on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-publish-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = SessionStore.create(workspace, join(root, "home"));
  const theme = createTheme({ level: 0, ascii: false });
  const routeFor = (model: string): RouteIdentityV1 => ({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_cross_publish",
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
  const pair = { lead: routeFor("openrouter/lead-model"), challenger: routeFor("openrouter/challenger-model") };
  try {
    const snapshot = {
      sequence: 9,
      updatedAt: 1_700_000_000_000,
      phase: "completed",
      reason: null,
      repairCount: 0,
      verification: "passed",
      contextSha256: "a".repeat(64),
      failure: null,
    } as const;
    const published = await publishCrossResultToSession(session, {
      phase: "completed",
      reason: null,
      failure: null,
      repairCount: 0,
      verification: "passed",
      contextSha256: snapshot.contextSha256,
      text: "unified safe result",
      costKnowledge: "known",
      costUsd: 0.5,
      mainCostUsd: 0.4,
      compressorCostUsd: 0.1,
      snapshot,
    }, "bounded task", pair, theme);
    assert.equal(published?.kind, "turn");
    assert.deepEqual(session.data.turns.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "bounded task" },
      {
        role: "assistant",
        content: "unified safe result\n\n"
          + "● Cross(lead-model + challenger-model)\n"
          + "⎿ ✓ Completed · Verification passed · $0.500",
      },
    ]);
    // The old bare `Cross · X · Y` micro-format never appears anywhere —
    // the whole point of the reshape (controller ruling 1).
    assert.doesNotMatch(session.data.turns.at(-1)!.content, /Cross · Completed · Verification passed$/);
    assert.deepEqual(session.data.costs, {
      mainUsd: 0.4,
      compressorUsd: 0.1,
      voiceUsd: 0,
      totalUsd: 0.5,
      costKnowledge: "known",
    });

    // Testrun finding (owner live test 2026-08-28): a terminal, non-cancelled
    // result with NO produced content (typically blocked) must never become
    // a fabricated chat turn — only a notice, the run log, and the cost
    // ledger (booked unconditionally, exactly as before) carry the record.
    const blocked = await publishCrossResultToSession(session, {
      phase: "blocked",
      reason: "context-limit",
      failure: null,
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      text: "",
      costKnowledge: "known",
      costUsd: 0.1,
      mainCostUsd: 0.1,
      compressorCostUsd: 0,
      snapshot: { ...snapshot, sequence: 10, phase: "blocked", reason: "context-limit", verification: "not-run", contextSha256: null, failure: null },
    }, "must not publish a turn", pair, theme);
    assert.equal(blocked?.kind, "notice");
    assert.equal(session.data.turns.length, 2, "no turn was added for the no-content blocked result");
    assert.ok(Math.abs(session.data.costs.mainUsd - 0.5) < 1e-9, "the cost is still booked even without a turn");
    assert.ok(Math.abs(session.data.costs.totalUsd - 0.6) < 1e-9);

    await publishCrossResultToSession(session, {
      phase: "cancelled",
      reason: "cancelled",
      failure: null,
      repairCount: 0,
      verification: "cancelled",
      contextSha256: null,
      text: "",
      costKnowledge: "unknown",
      costUsd: 0.2,
      mainCostUsd: 0.2,
      compressorCostUsd: 0,
      snapshot: { ...snapshot, sequence: 11, phase: "cancelled", reason: "cancelled", verification: "cancelled", contextSha256: null, failure: null },
    }, "must not publish", pair, theme);
    assert.equal(session.data.turns.length, 2);
    assert.ok(Math.abs(session.data.costs.mainUsd - 0.7) < 1e-9);
    assert.ok(Math.abs(session.data.costs.totalUsd - 0.8) < 1e-9);
    assert.equal(session.data.costs.costKnowledge, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * FIX-20, finding 1: a blocked Cross frame must name the failing ROLE and
 * the underlying error. The owner's report was four stacked
 * `⎿ ✗ Blocked · Verification not run · Role run failed · $0.00` lines —
 * every one of them true, none of them actionable.
 */
test("a blocked Cross result names the failing role and the humanized cause instead of 'Role run failed'", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-failure-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = SessionStore.create(workspace, join(root, "home"));
  const theme = createTheme({ level: 0, ascii: false });
  const routeFor = (model: string): RouteIdentityV1 => ({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_publish",
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
  const pair = {
    lead: routeFor("openrouter/lead-model"),
    challenger: routeFor("openrouter/challenger-model"),
  };
  const snapshot = {
    sequence: 3,
    updatedAt: 1_700_000_000_000,
    phase: "blocked",
    reason: "worker-failed",
    repairCount: 0,
    verification: "not-run",
    contextSha256: null,
    failure: { role: "lead", message: "OpenRouter rejected the key. Check it with /key status." },
  } as const;
  try {
    const published = await publishCrossResultToSession(session, {
      phase: "blocked",
      reason: "worker-failed",
      failure: snapshot.failure,
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      text: "",
      costKnowledge: "known",
      costUsd: 0,
      mainCostUsd: 0,
      compressorCostUsd: 0,
      snapshot,
    }, "task", pair, theme);
    assert.equal(published?.kind, "notice");
    // The whole point: the generic label is gone, replaced by the concrete
    // role plus the humanized cause — same D2 grammar, one useful fact more.
    const line = crossResultNoticeText(theme, published.pair, published.result);
    assert.match(line, /coding model: OpenRouter rejected the key\. Check it with \/key status\./);
    assert.doesNotMatch(line, /Role run failed/, "the blind generic must not survive alongside the cause");
    assert.match(
      line,
      /\n⎿ ✗ Blocked · Verification not run · /,
      "the D2 fact order is unchanged",
    );
    // P15 fix round 1 (L4): both surfaces compose a notice from THIS one
    // function — the dashboard verbatim (its notice block draws its own
    // glyph), the plain loop prefixed with the tool head. A notice carries no
    // reasoning, so it has exactly one detail line on either surface; P15's
    // reasoning details belong to the persisted-turn block, never here.
    assert.equal(
      line.split("\n").filter((row) => row.startsWith("⎿")).length,
      1,
      "a notice has exactly one detail line — no reasoning rides a no-content result",
    );
    assert.doesNotMatch(line, /Reasoning ·/);
    assert.ok(!line.startsWith(theme.glyph("toolHead")), "the head glyph is the surface's to add, not this composer's");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * FIX-20, finding 1: a reason with no caught error still gets its concrete
 * next step, and only where one honestly exists.
 */
test("a pair-configuration block carries the one command that fixes it; a cause-carrying block does not invent one", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cross-nextstep-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const theme = createTheme({ level: 0, ascii: false });
  try {
    const session = SessionStore.create(workspace, join(root, "home"));
    const snapshot = {
      sequence: 1,
      updatedAt: 1_700_000_000_000,
      phase: "blocked",
      reason: "missing-routes",
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      failure: null,
    } as const;
    const published = await publishCrossResultToSession(session, {
      phase: "blocked",
      reason: "missing-routes",
      failure: null,
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      text: "",
      costKnowledge: "known",
      costUsd: 0,
      mainCostUsd: 0,
      compressorCostUsd: 0,
      snapshot,
    }, "task", { lead: null, challenger: null }, theme);
    assert.equal(published?.kind, "notice");
    assert.match(
      crossResultNoticeText(theme, published.pair, published.result),
      /Models missing — \/cross to set the pair/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D3 plain-surface variant: consecutive identical lines collapse to a growing '(repeated x N)' increment, resetting on a different line", () => {
  const theme = createTheme({ level: 0, ascii: false });
  const written: string[] = [];
  const print = createRepeatCollapsingPrinter(theme, (line) => written.push(line));

  print("Cross · ✗ Blocked · Verification not run · Task or context invalid");
  print("Cross · ✗ Blocked · Verification not run · Task or context invalid");
  print("Cross · ✗ Blocked · Verification not run · Task or context invalid");
  print("Cross mode: off for this chat.");
  print("Cross · ✗ Blocked · Verification not run · Task or context invalid");
  print("Cross · ✗ Blocked · Verification not run · Task or context invalid");

  assert.deepEqual(written, [
    "Cross · ✗ Blocked · Verification not run · Task or context invalid",
    "  (repeated × 2)",
    "  (repeated × 3)",
    "Cross mode: off for this chat.",
    "Cross · ✗ Blocked · Verification not run · Task or context invalid",
    "  (repeated × 2)",
  ]);
});

test("D3 plain-surface variant: the multiply glyph asciifies to x in ASCII mode", () => {
  const theme = createTheme({ level: 0, ascii: true });
  const written: string[] = [];
  const print = createRepeatCollapsingPrinter(theme, (line) => written.push(line));
  print("same line");
  print("same line");
  assert.equal(written[1], "  (repeated x 2)");
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
    assert.match(stdout.join(""), flag === "--help" ? /Usage|Verwendung|Optionen/i : /orcode 0\.7\.0/);
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
        error: "Error: Config migration rejected: providerSetup or schemaVersion has the future version 99.",
        providerSetup: { schemaVersion: 99, opaque: "task-ten-private-future-marker" },
      },
      {
        name: "corrupt",
        error: "Error: Config migration rejected: the configuration is corrupted or not uniquely readable.",
        providerSetup: { schemaVersion: 3, connections: "invalid" },
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
    startDeferredRetention: () => undefined,
  };
  const runtime = await createDefaultProviderRuntime({
    startup,
    environment: {},
    requestedModel: modelId,
    executionMode: "local-interactive-owner",
  });
  const inspected = await runtime.inspectStartup();
  assert.equal(inspected.defaultRoute?.accountFingerprint, verifiedFingerprint);
  assert.equal(
    (startup.config.providerSetup as ProviderSetupStateV3).connections[0]?.accountFingerprint,
    verifiedFingerprint,
  );
  assert.equal(startup.session.data.route?.accountFingerprint, verifiedFingerprint);
  assert.equal(await readFile(currentSeed.path, "utf8"), currentBytes);

  const resolved = await runtime.resolveLegacyDefaultRoute();
  assert.equal(resolved.defaultRoute?.resolutionState, "resolved");
  assert.deepEqual(
    (startup.config.providerSetup as ProviderSetupStateV3).defaultRoute,
    resolved.defaultRoute,
  );
  assert.equal(startup.session.data.route?.accountFingerprint, verifiedFingerprint);
  assert.equal(await readFile(currentSeed.path, "utf8"), currentBytes);
  const routeAuthority = runtime as typeof runtime & {
    migratedSessionConnection?(): ProviderConnectionStateV3 | undefined;
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
  const authoritativeConnection: ProviderConnectionStateV3 = {
    id: "dashboard-migrated-openrouter",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
    schemaVersion: 3,
    revision: 0,
    lifecycle: "migrated",
    connections: [{
      id: "dashboard-migrated-openrouter",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
  assert.equal(statuses.at(-1), "Chat opened: Second historical chat");
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

interface ForeignChatFixture {
  root: string;
  workspaceA: string;
  workspaceB: string;
  appHome: string;
  current: SessionStore;
  foreign: SessionStore;
  runtimeContext: Record<string, unknown> & {
    workspace: string;
    session: SessionStore;
    localRuntime: { guard: WorkspaceGuard; setSession(): void };
  };
}

/**
 * Two real workspaces sharing one app-home (Phase F1b): `current` lives in
 * `workspaceA`, `foreign` in `workspaceB`. `runtimeContext.reRootWorkspace`
 * delegates to the real `reRootWorkspace` core (`workspace.ts`) — the exact
 * function `runCli` itself wires — so these tests exercise the real
 * mechanics, not a hand-rolled stand-in.
 */
async function foreignChatFixture(
  t: { after(fn: () => void): void },
  prefix: string,
): Promise<ForeignChatFixture> {
  const root = await mkdtemp(join(tmpdir(), `orcode-${prefix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspaceA, appHome, "Current chat");
  current.addTurn("user", "current turn");
  await current.save();
  const foreign = SessionStore.create(workspaceB, appHome, "Foreign chat");
  foreign.addTurn("user", "foreign turn");
  await foreign.save();
  const ruleStore = await RuleStore.load(appHome);
  const approvals = new ApprovalManager("ask");
  approvals.setRuleStore(ruleStore, workspaceA);
  const runtimeContext: ForeignChatFixture["runtimeContext"] = {
    workspace: workspaceA,
    configPath: join(appHome, "config.json"),
    config: structuredClone(DEFAULT_CONFIG),
    session: current,
    agent: { setSession() {} },
    localRuntime: {
      guard: await WorkspaceGuard.create(workspaceA),
      setSession() {},
    },
    approvals,
    ruleStore,
    crossRunActive: () => false,
    async reRootWorkspace(newWorkspace: string) {
      return reRootWorkspaceCore(
        {
          setWorkspace: (value) => { runtimeContext.workspace = value; },
          setGuard: (value) => { runtimeContext.localRuntime.guard = value; },
          approvals: runtimeContext.approvals as ApprovalManager,
          ruleStore: runtimeContext.ruleStore as RuleStore,
          crossRunActive: runtimeContext.crossRunActive as () => boolean,
        },
        newWorkspace,
      );
    },
    providerRuntime: {
      migratedSessionConnection() { return undefined; },
      async transitionModel() {},
    },
    providerRouteSurface: "fullscreen",
  };
  return { root, workspaceA, workspaceB, appHome, current, foreign, runtimeContext };
}

function foreignPickerUi(
  targetId: string,
  messages: Array<{ level: string; text: string }>,
  confirmAccepted = false,
  /** FIX-20: records every confirm the pick raises, so its copy and class can be asserted. */
  confirms: Array<{ title: string; details: string; danger: boolean | undefined }> = [],
  /** FIX-20, finding 9: records the transient notice the pick ends with. */
  statuses: string[] = [],
) {
  return {
    async pickChoice(_title: string, items: ReadonlyArray<{ value: string; label: string }>) {
      const picked = items.find((item) => item.value === targetId);
      assert.ok(picked, "the foreign chat must be offered under Other folders");
      return picked;
    },
    addMessage(level: string, text: string) { messages.push({ level, text }); },
    loadTurns() {},
    setStatus(value: string) { statuses.push(value); },
    async confirmAction(
      title: string,
      details: string,
      options?: { danger?: boolean },
    ) {
      confirms.push({ title, details, danger: options?.danger });
      return { accepted: confirmAccepted };
    },
  };
}

/**
 * D8c/FIX-20 finding 7, pinned at the OTHER site that abandons a chat: the
 * hub's "Recent" row (and every `/chats` pick — same helper). The exit-time
 * saves in both interactive loops have always honoured `isUntouched`;
 * `saveDashboardSessionPreferences` (cli.ts) is the one the pick runs, and
 * it writes the chat being LEFT. A bare launch always leaves an untouched
 * fresh session current (D8c), so without that guard the very first Recent
 * pick of a session turned it into a permanent "New Chat" file — a ghost
 * that then showed up as its own Recent row on the next launch.
 *
 * Both halves matter and only the pair proves the fix is a guard on
 * EMPTINESS rather than on switching: an untouched chat is not written, and
 * a chat with real content still is — leaving one must never lose it.
 */
test("the Recent-row pick leaves an untouched chat unwritten, and still persists one that has content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-recent-pick-ghost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  await mkdir(workspace, { recursive: true });
  const prior = SessionStore.create(workspace, appHome, "River Facts");
  prior.addTurn("user", "Which river is the longest in Europe?");
  await prior.save();
  // Exactly what a bare launch leaves current: created, never touched,
  // never saved — `SessionStore.create` is lazy by construction.
  const fresh = SessionStore.create(workspace, appHome);
  assert.equal(fresh.isUntouched, true);

  const statuses: string[] = [];
  const context = {
    workspace,
    configPath: join(appHome, "config.json"),
    config: structuredClone(DEFAULT_CONFIG),
    session: fresh as SessionStore,
    agent: { setSession() {} },
    localRuntime: { setSession() {} },
    providerRuntime: {
      migratedSessionConnection() { return undefined; },
      async transitionModel() {},
    },
    providerRouteSurface: "fullscreen",
  };
  const pickerUi = (targetId: string) => ({
    async pickChoice(_title: string, items: ReadonlyArray<{ value: string }>) {
      const picked = items.find((item) => item.value === targetId);
      assert.ok(picked, `the picker must offer ${targetId}`);
      return picked;
    },
    addMessage() {},
    loadTurns() {},
    setStatus(value: string) { statuses.push(value); },
  });

  assert.equal(
    await pickDashboardChat(pickerUi(prior.data.id) as never, context as never, false),
    true,
  );
  assert.equal(context.session.data.id, prior.data.id, "the pick must open the chosen chat");
  assert.equal(statuses.at(-1), "Chat opened: River Facts");
  // `SessionStore.list` is deliberately NOT ghost-filtered (that filter
  // lives in `listChatsAcrossWorkspaces`, a display guard), so this is a
  // real statement about the files on disk.
  assert.deepEqual(
    (await SessionStore.list(workspace, appHome)).map((chat) => chat.id),
    [prior.data.id],
    "the untouched chat the pick walked away from must not become a file",
  );

  // Now the open chat gains content and is abandoned in turn: it has
  // something worth keeping, so the same code path must write it.
  const second = SessionStore.create(workspace, appHome, "Second chat");
  second.addTurn("user", "second turn");
  await second.save();
  context.session.addTurn("assistant", "The Volga.");
  assert.equal(context.session.isUntouched, false);
  assert.equal(
    await pickDashboardChat(pickerUi(second.data.id) as never, context as never, false),
    true,
  );
  const reloaded = await SessionStore.openById(workspace, prior.data.id, appHome);
  assert.deepEqual(
    reloaded.data.turns.map((turn) => turn.content),
    ["Which river is the longest in Europe?", "The Volga."],
    "a chat with real content must be written when the pick leaves it — the guard is about emptiness, never about switching",
  );
});

// ---------------------------------------------------------------------------
// Fix round 1, IMPORTANT 3 (fullscreen bonus): the plain composed test above
// is the hard requirement; this is the cheap fullscreen variant the same
// TTY-shaped harness already used in tui.test.ts's real-TTY smoke enables —
// a real TerminalUi, real raw-mode keypresses, driving pickDashboardChat
// (not a mocked `ui`) through an actual foreign-pick re-root.
// ---------------------------------------------------------------------------

class FakeDashboardInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeDashboardOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 28;
  output = "";
  write(value: string | Uint8Array): boolean {
    this.output += value.toString();
    return true;
  }
}

/** Polls until `stdout.output` contains `marker`, or throws after `timeoutMs`. */
async function waitForDashboardOutput(stdout: FakeDashboardOutput, marker: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stdout.output.includes(marker)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for dashboard output to contain: ${marker}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pressDashboardKey(stdin: FakeDashboardInput, name: string, character = ""): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false });
}

test("composed end-to-end (fullscreen bonus): a real TerminalUi drives pickDashboardChat into a foreign chat's folder", async (t) => {
  const { workspaceA, workspaceB, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-composed-e2e");
  const stdin = new FakeDashboardInput();
  const stdout = new FakeDashboardOutput();
  const dashboardState: DashboardState = {
    workspace: workspaceA,
    model: "openrouter/auto",
    approval: "ask",
    reasoning: "auto",
    maxCost: "$1.000",
    maxSteps: 12,
  };
  const ui = new TerminalUi(
    () => dashboardState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );
  ui.start();
  t.after(() => ui.stop());

  const picked = pickDashboardChat(ui, runtimeContext as never, false);
  // Real disk I/O (listChatsAcrossWorkspaces) happens before the picker even
  // opens — wait for its actual title, not a fixed number of ticks.
  await waitForDashboardOutput(stdout, "Foreign chat");
  pressDashboardKey(stdin, "down");
  pressDashboardKey(stdin, "return");

  assert.equal(await picked, true);
  assert.equal(runtimeContext.workspace, workspaceB, "the policy root must move to the foreign folder");
  assert.equal((runtimeContext.localRuntime as { guard: { root: string } }).guard.root, workspaceB);
  assert.equal((runtimeContext.session as SessionStore).data.id, foreign.data.id);
});

test("foreign-pick re-roots (Phase F1b): picking another folder's chat moves the policy root and reloads approval rules", async (t) => {
  const { workspaceA, workspaceB, appHome, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-foreign-pick");

  // A confirmed subject-specific approval in workspace A: some tool remains
  // silently allowed there until the runtime moves away from it.
  const subject = { kind: "selected-path" as const, path: join(workspaceA, "secret.txt") };
  await (runtimeContext.ruleStore as RuleStore).remember({
    workspace: workspaceA,
    tool: "write_file",
    subject,
    decision: "allow",
  });
  let prompted = 0;
  (runtimeContext.approvals as ApprovalManager).setPromptHandler(async () => {
    prompted += 1;
    return { accepted: false };
  });
  await assert.doesNotReject((runtimeContext.approvals as ApprovalManager).authorize({
    name: "write_file",
    risk: "edit",
    summary: "write secret.txt",
    subject,
    rememberable: true,
  }));
  assert.equal(prompted, 0, "the workspace A rule must still allow silently before any switch");

  const messages: Array<{ level: string; text: string }> = [];
  const ui = foreignPickerUi(foreign.data.id, messages);

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(switched, true);
  assert.equal(runtimeContext.workspace, workspaceB, "the policy root (context.workspace) must move to the foreign folder");
  assert.equal(runtimeContext.localRuntime.guard.root, workspaceB, "the WorkspaceGuard must be re-created against the foreign folder");
  assert.equal((runtimeContext.session as SessionStore).data.id, foreign.data.id);

  // Boundaries: approval rules never travel across a re-root — the exact
  // same subject/tool must now ask again under workspace B.
  await assert.rejects((runtimeContext.approvals as ApprovalManager).authorize({
    name: "write_file",
    risk: "edit",
    summary: "write secret.txt",
    subject,
    rememberable: true,
  }));
  assert.equal(prompted, 1, "the rule must not apply once the runtime is rooted in a different workspace");
});

// D8 (neutral start hub): a "Recent" row's activation is Controller ruling
// 3's binding requirement — "route the activation through the same helper
// pickDashboardChat uses for a preset chat" — so this proves the
// `presetChatId` path itself: it opens the target chat with NO picker
// prompt at all (the stub's `pickChoice` throws if the dashboard loop ever
// calls it), yet still runs the exact same re-root `reRootWorkspace`
// machinery the interactive foreign pick above does. This is the same
// mechanism the pre-D8 "Continue" quick action already used for its one
// slot; D8 only changes how many rows can supply a `presetChatId` (up to 4,
// not 1) — `pickDashboardChat` itself is untouched (scope guard ruling 7).
test("pickDashboardChat with a presetChatId opens that chat directly and re-roots — no picker prompt shown (the Recent-row/Continue activation path)", async (t) => {
  const { workspaceB, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-preset-pick");
  const messages: Array<{ level: string; text: string }> = [];
  const ui = {
    pickChoice() {
      throw new Error("a presetChatId must skip the picker prompt entirely — pickChoice must never be called");
    },
    addMessage(level: string, text: string) { messages.push({ level, text }); },
    loadTurns() {},
    setStatus() {},
    async confirmAction() { return { accepted: false }; },
  };

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false, foreign.data.id);

  assert.equal(switched, true);
  assert.equal(runtimeContext.workspace, workspaceB, "a foreign preset pick must re-root exactly like a foreign /chats pick");
  assert.equal(runtimeContext.localRuntime.guard.root, workspaceB, "the WorkspaceGuard must be re-created against the foreign folder");
  assert.equal((runtimeContext.session as SessionStore).data.id, foreign.data.id);
});

test("foreign-pick honestly refuses when the target folder no longer exists, and offers to remove the stale entry", async (t) => {
  const { workspaceA, workspaceB, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-stale-folder");
  await rm(workspaceB, { recursive: true, force: true });

  const messages: Array<{ level: string; text: string }> = [];
  const ui = foreignPickerUi(foreign.data.id, messages, true);

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(switched, false, "a stale folder must never switch");
  assert.equal(runtimeContext.workspace, workspaceA, "workspace state must be untouched on refusal");
  assert.ok(messages.some((m) => m.level === "error" && /no longer exists/.test(m.text)));
  assert.ok(messages.some((m) => /Stale entry removed/.test(m.text)), "accepting the offer removes the orphaned chat");
  await assert.rejects(
    SessionStore.openById(workspaceB, foreign.data.id, runtimeContext.session.appHome),
    /not found/,
  );
});

/**
 * FIX-20, finding 10: the confirm that deletes a chat's file must say so.
 * "Remove stale entry?" over "<title> belongs to a folder that no longer
 * exists" describes bookkeeping — the entry IS the chat, and accepting
 * destroys the conversation permanently.
 *
 * Approval details are fitted per line with an ellipsis, so a single long
 * sentence loses its tail first — which is exactly where the consequence
 * used to sit. The two lines carrying the reason are therefore short enough
 * to survive intact at the supported 40-column floor.
 */
test("the stale-entry confirm is danger class and names the permanent deletion width-safely", async (t) => {
  const { workspaceB, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-stale-copy");
  await rm(workspaceB, { recursive: true, force: true });

  const messages: Array<{ level: string; text: string }> = [];
  const confirms: Array<{ title: string; details: string; danger: boolean | undefined }> = [];
  const ui = foreignPickerUi(foreign.data.id, messages, false, confirms);

  await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(confirms.length, 1);
  const [confirm] = confirms;
  assert.equal(confirm!.danger, true, "deleting a chat's file is the D4 danger class");
  assert.equal(confirm!.title, STALE_CHAT_DELETE_TITLE);
  assert.doesNotMatch(confirm!.title, /stale entry/i, "the softening bookkeeping wording is gone");
  assert.match(confirm!.details, /Deletes this chat's file permanently\./);
  assert.match(confirm!.details, /The conversation cannot be recovered\./);
  assert.match(confirm!.details, /no longer exists/, "the reason itself still stands");

  // The two reason lines must fit inside the narrowest supported frame, so
  // neither can ever be cut mid-explanation. `render-block.ts`'s `body`
  // prefixes each detail line with a two-cell edge, inside a 39-cell body.
  const reasonLines = confirm!.details.split("\n").filter((line) => /^(Deletes|The conversation|Its folder)/.test(line));
  assert.equal(reasonLines.length, 3);
  for (const line of reasonLines) {
    assert.ok(line.length + 2 <= 39, `"${line}" must survive a 40-column frame intact (${line.length + 2} cells)`);
  }
});

test("foreign-pick declining the stale-entry offer leaves the chat exactly as it was", async (t) => {
  const { workspaceB, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-stale-decline");
  await rm(workspaceB, { recursive: true, force: true });

  const messages: Array<{ level: string; text: string }> = [];
  const ui = foreignPickerUi(foreign.data.id, messages, false);

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(switched, false);
  assert.ok(!messages.some((m) => /Stale entry removed/.test(m.text)));
  await assert.doesNotReject(
    SessionStore.openById(workspaceB, foreign.data.id, runtimeContext.session.appHome),
  );
});

test("foreign-pick refuses while a Cross run is active — the boundary applies to the dashboard picker too", async (t) => {
  const { workspaceA, foreign, runtimeContext } = await foreignChatFixture(t, "dashboard-run-active");
  runtimeContext.crossRunActive = () => true;

  const messages: Array<{ level: string; text: string }> = [];
  const ui = foreignPickerUi(foreign.data.id, messages);

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(switched, false);
  assert.equal(runtimeContext.workspace, workspaceA);
  assert.ok(messages.some((m) => m.level === "error" && /Cross is running/.test(m.text)));
});

/** A chat file recorded under the wrong hash directory — Controller ruling 5's corruption/tamper signal. */
async function writeUnverifiedChat(appHome: string, id: string, title: string): Promise<void> {
  const foreignHashDir = join(appHome, "chats", "0123456789abcdef");
  await mkdir(foreignHashDir, { recursive: true });
  await writeFile(
    join(foreignHashDir, `${id}.json`),
    JSON.stringify({
      version: 2,
      id,
      title,
      workspace: "/some/other/path/entirely",
      summary: "",
      turns: [],
      costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
      revision: 0,
      checkpoints: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
}

test("Fix round 1, MINOR 7 (dashboard): an unverified chat's row reads 'unknown folder', and picking it never re-roots", async (t) => {
  const { appHome, runtimeContext } = await foreignChatFixture(t, "dashboard-unverified");
  await writeUnverifiedChat(appHome, "chat-corrupt-0000001", "Corrupt chat");

  const messages: Array<{ level: string; text: string }> = [];
  const ui = {
    async pickChoice(_title: string, items: ReadonlyArray<{ value: string; label: string; description: string }>) {
      const picked = items.find((item) => item.value === "chat-corrupt-0000001");
      assert.ok(picked, "the unverified chat must still be offered, honestly");
      assert.match(picked!.description, /unknown folder/);
      return picked;
    },
    addMessage(level: string, text: string) { messages.push({ level, text }); },
    loadTurns() {},
    setStatus() {},
    async confirmAction() { return { accepted: true }; },
  };

  const switched = await pickDashboardChat(ui as never, runtimeContext as never, false);

  assert.equal(switched, false, "an unverified chat can never re-root — there is no folder to trust");
  assert.ok(messages.some((m) => m.level === "system" && /has no folder orcode can trust/.test(m.text)));
});

test("K11 (FIX-5 ruling 5): the /chats picker's new-chat row marks itself with the theme's single-cell plus glyph, never the fullwidth ＋", async (t) => {
  const { runtimeContext } = await foreignChatFixture(t, "dashboard-new-chat-glyph");
  let captured: ReadonlyArray<{ value: string; label: string }> = [];
  const ui = {
    async pickChoice(_title: string, items: ReadonlyArray<{ value: string; label: string }>) {
      captured = items;
      return null;
    },
    addMessage() {},
    loadTurns() {},
    setStatus() {},
    async confirmAction() { return { accepted: false }; },
  };

  assert.equal(await pickDashboardChat(ui as never, runtimeContext as never, false), false);

  const newChat = captured.find((item) => item.value === "__new__");
  assert.ok(newChat, "the picker always offers a new chat");
  // The literal used to be U+FF0B FULLWIDTH PLUS SIGN: two display cells,
  // no ASCII fallback, absent from any glyph inventory. Both charsets of the
  // `plus` glyph are the one-cell ASCII `+`, so this holds whichever mode the
  // ambient environment resolves to.
  assert.equal(newChat!.label, "+ New Chat");
  assert.equal(
    captured.some((item) => item.label.includes("＋")),
    false,
    "no picker row may carry a raw fullwidth glyph",
  );
});

test("refreshChromeAfterWorkspaceSwitch recomputes the status line's project status for the new workspace and refreshes day-spend (Fix round 1, IMPORTANT 2)", async () => {
  // Unit-level proof for the shared refresh both the bare `/chat` branch and
  // the "Continue" quick action call after a foreign pick — extracted
  // specifically so this is assertable without driving runDashboard's own
  // interactive loop (there is no existing harness for that at all).
  const inspected: string[] = [];
  let daySpendCalls = 0;
  const nextProjectStatus = await refreshChromeAfterWorkspaceSwitch("/foreign/workspace", {
    inspectWorkspace: async (workspace) => {
      inspected.push(workspace);
      return `robopet-foreign · Git main · clean`;
    },
    refreshDaySpend: () => { daySpendCalls += 1; },
  });

  assert.deepEqual(inspected, ["/foreign/workspace"], "the status line must inspect the NEW workspace, not the old one");
  assert.equal(nextProjectStatus, "robopet-foreign · Git main · clean");
  assert.equal(daySpendCalls, 1, "the workspace-scoped 'spent today' must also refresh");
});

test("dashboard picker keeps an explicitly cleared chat unbound from the current route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-dashboard-cleared-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const currentRoute = {
    ...bootstrapRoute("openrouter/auto"),
    accountFingerprint: "acct_dashboard_current_cleared_111111",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const kimiRoute = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_dashboard_kimi_cleared_222222",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const current = SessionStore.create(workspace, appHome, "Dashboard current");
  current.setPreferences(currentRoute.requestedModelId, { mode: "auto" }, currentRoute);
  await current.save();
  const historical = SessionStore.create(workspace, appHome, "Dashboard cleared Kimi");
  historical.setPreferences("k3", { mode: "auto" }, kimiRoute);
  historical.addTurn("user", "cleared historical turn");
  await historical.save();
  assert.equal(await historical.clearRouteIfExact(kimiRoute), true);

  const transitions: string[] = [];
  const adopted: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = currentRoute.requestedModelId;
  const runtimeContext = {
    workspace,
    configPath: join(appHome, "config.json"),
    config,
    session: current,
    agent: { setSession() {} },
    localRuntime: { setSession() {} },
    providerRuntime: {
      migratedSessionConnection() { return undefined; },
      currentSessionRoute() { return structuredClone(currentRoute); },
      async transitionModel(modelId: string) { transitions.push(modelId); },
      adoptSession(next: SessionStore) { adopted.push(next.data.id); },
    },
    providerRouteSurface: "fullscreen",
  };
  const ui = {
    async pickChoice() {
      return { value: historical.data.id, label: historical.data.title };
    },
    addMessage() {},
    loadTurns() {},
    setStatus() {},
  };

  assert.equal(await pickDashboardChat(ui as never, runtimeContext as never, false), true);
  assert.deepEqual(transitions, []);
  assert.deepEqual(adopted, [historical.data.id]);
  assert.equal(runtimeContext.session.data.model, "k3");
  assert.equal(runtimeContext.session.data.route, undefined);
  assert.equal(runtimeContext.session.data.routeCleared, true);
  const reopened = await SessionStore.openById(workspace, historical.data.id, appHome);
  assert.equal(reopened.data.model, "k3");
  assert.equal(reopened.data.route, undefined);
  assert.equal(reopened.data.routeCleared, true);
});

test("dashboard proves a foreign historical route before current chat, config, or agent mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-dashboard-foreign-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const currentRoute = {
    ...bootstrapRoute("vendor/current"),
    accountFingerprint: "acct_current_dashboard_111111",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/foreign"),
    accountFingerprint: "acct_foreign_dashboard_222222",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/post-bind-b"),
    accountFingerprint: "acct_post_bind_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV3["defaultRoute"]>,
    slot: string,
  ): ProviderConnectionStateV3 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  });
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
    runPlain: async (input: {
      providerRuntime: unknown;
      agent: unknown;
      ensureAgentForPrompt(): Promise<unknown>;
    }) => {
      calls.push("plain");
      assert.equal(input.providerRuntime, runtime);
      assert.equal(input.agent, null);
      assert.ok(await input.ensureAgentForPrompt());
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
    "plain",
    "provider:ensure",
    "agent:create",
  ]);
});

// FIX-17 (finding 1a): the honest gate's one extracted decision — tested
// directly like applyDashboardCommandOutput, since driving the whole
// dashboard loop is not practical in a unit test. The dashboard prompt path
// asks this before starting a run; `false` is what makes it open the setup
// surface solicited-by-the-attempt.
test("FIX-17: dashboardRouteIsRunnable folds only the setup-required refusal to false", () => {
  const gate = (cliModule as typeof cliModule & {
    dashboardRouteIsRunnable?: (runtime: { ensureRunnableRoute(): unknown }) => boolean;
  }).dashboardRouteIsRunnable;
  assert.equal(typeof gate, "function", "the gate decision must be exported for direct testing");

  assert.equal(gate!({ ensureRunnableRoute: () => bootstrapRoute() }), true);
  assert.equal(
    gate!({ ensureRunnableRoute: () => { throw new ProviderSetupRequiredError(); } }),
    false,
  );
  const coded = new Error("Provider setup is required") as Error & { code: string };
  coded.code = "provider-setup-required";
  assert.equal(gate!({ ensureRunnableRoute: () => { throw coded; } }), false);
  // Every OTHER failure still surfaces — the gate must never eat a real
  // error and silently open setup over it.
  assert.throws(
    () => gate!({ ensureRunnableRoute: () => { throw new Error("disk on fire"); } }),
    /disk on fire/,
  );
});

// FIX-17 (finding 3): the pre-alt-screen stderr warnings are re-surfaced
// inside the dashboard once each, deduplicated, through the ordinary
// transcript-notice channel.
test("FIX-17: surfaceStartupWarnings posts each distinct warning once, in first-seen order", () => {
  const surface = (cliModule as typeof cliModule & {
    surfaceStartupWarnings?: (
      ui: { addMessage(role: string, content: string, meta?: string): void },
      warnings: readonly string[] | undefined,
    ) => void;
  }).surfaceStartupWarnings;
  assert.equal(typeof surface, "function", "the warning-surfacing rule must be exported for direct testing");

  const messages: Array<{ role: string; content: string; meta?: string }> = [];
  const ui = {
    addMessage(role: string, content: string, meta?: string) {
      messages.push({ role, content, meta });
    },
  };
  surface!(ui, [
    "Migrated app home from ~/.routercode",
    "Retention pruned 3 old run logs",
    "Migrated app home from ~/.routercode",
  ]);
  assert.deepEqual(messages, [
    { role: "system", content: "Migrated app home from ~/.routercode", meta: "Startup" },
    { role: "system", content: "Retention pruned 3 old run logs", meta: "Startup" },
  ]);

  messages.length = 0;
  surface!(ui, undefined);
  surface!(ui, []);
  assert.deepEqual(messages, [], "no warnings means no notices at all");
});

test("FIX-17: a TUI launch threads the collected startup warnings into runDashboard, stderr copies intact", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    // Order-independence: a previous test's real config load may have left
    // a pending module-global warning; drain it so this test only sees its
    // own two.
    consumeConfigWarning();
    const stderrLines: string[] = [];
    const captured: { startupWarnings?: readonly string[]; setupRequired?: boolean } = {};
    const storage = {
      ...bootstrapStorage(),
      migrationWarning: "Migrated app home from ~/.routercode",
      retentionWarnings: ["Retention pruned 3 old run logs"],
    };
    const exitCode = await invokeRunCli([], {
      initializeStorage: async () => storage,
      createProviderRuntime: async () => bootstrapRuntime(),
      createAgent: async () => { throw new Error("a bare TUI launch must not create an agent"); },
      runPlain: async () => { throw new Error("a TTY launch must reach the dashboard, not the plain loop"); },
      runDashboard: async (input: { startupWarnings?: readonly string[]; setupRequired?: boolean }) => {
        captured.startupWarnings = input.startupWarnings;
        captured.setupRequired = input.setupRequired;
      },
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderrLines.push(value); return true; } },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(captured.startupWarnings, [
      "Migrated app home from ~/.routercode",
      "Retention pruned 3 old run logs",
    ]);
    // FIX-16 at merge: `setupRequired` is now the deferred probe thunk —
    // the dashboard resolves it after its first frame; here it resolves to
    // the same `false` the old boolean carried.
    assert.equal(typeof captured.setupRequired, "function");
    assert.equal(
      await (captured.setupRequired as unknown as () => Promise<boolean>)(),
      false,
      "the deferred probe must still answer 'no setup needed' for a configured home",
    );
    // The stderr copies stay exactly as before — plain/scripted runs and
    // scrollback-preserving terminals still get them.
    assert.deepEqual(stderrLines, [
      "Migrated app home from ~/.routercode\n",
      "Retention pruned 3 old run logs\n",
    ]);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
});

test("runCli derives the exact execution mode before provider construction and startup inspection", async (t) => {
  const deniedLaunchModes = [
    "scheduled",
    "relay",
    "multi-user",
    "collaborator",
    "shared-service",
    "unenrolled-device",
  ] as const;
  const cases: ReadonlyArray<{
    name: string;
    argv: readonly string[];
    stdinTty: boolean;
    stdoutTty: boolean;
    launcherMode?: string;
    expected: string;
  }> = [
    { name: "local owner", argv: ["--plain"], stdinTty: true, stdoutTty: true, expected: "local-interactive-owner" },
    { name: "json wins over prompt", argv: ["--json", "-p", "hello"], stdinTty: true, stdoutTty: true, expected: "json" },
    { name: "piped", argv: ["--plain"], stdinTty: false, stdoutTty: false, expected: "piped" },
    { name: "batch", argv: ["-p", "hello"], stdinTty: true, stdoutTty: true, expected: "batch" },
    ...deniedLaunchModes.map((mode) => ({
      name: mode,
      argv: ["--plain"] as readonly string[],
      stdinTty: true,
      stdoutTty: true,
      launcherMode: mode,
      expected: mode,
    })),
    {
      name: "launcher cannot upgrade batch",
      argv: ["-p", "hello"],
      stdinTty: true,
      stdoutTty: true,
      launcherMode: "local-interactive-owner",
      expected: "batch",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: entry.stdinTty });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: entry.stdoutTty });
      const observed: string[] = [];
      try {
        const runtime = bootstrapRuntime({
          mode: "setup-required",
          route: null,
          setup: { kind: "cancelled", mode: "setup-required" },
        });
        const inspect = runtime.inspectStartup.bind(runtime);
        runtime.inspectStartup = async () => {
          observed.push(`inspect:${observed[0] ?? "missing"}`);
          return inspect();
        };
        await invokeRunCli(entry.argv, {
          initializeStorage: async () => bootstrapStorage(),
          createProviderRuntime: async (input: { executionMode?: string }) => {
            observed.push(input.executionMode ?? "missing");
            return runtime;
          },
          createAgent: async () => { throw new Error("setup-required mode must not create agent"); },
          runPlain: async () => undefined,
          runDashboard: async () => undefined,
          stdout: { write: () => true },
          stderr: { write: () => true },
          ...(entry.launcherMode ? { executionMode: entry.launcherMode } : {}),
        });
      } finally {
        if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
        if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
      assert.deepEqual(observed.slice(0, 2), [entry.expected, `inspect:${entry.expected}`]);
    });
  }
});

test("every non-owner runtime denies an exact Kimi default before provider fetch", async () => {
  const denied = [
    "json",
    "piped",
    "scheduled",
    "batch",
    "relay",
    "multi-user",
    "collaborator",
    "shared-service",
    "unenrolled-device",
  ] as const;
  const route = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_kimi_policy_fixture",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("policy test must not fetch");
  };
  try {
    for (const executionMode of denied) {
      const startup = bootstrapStorage();
      startup.config.mainModel = "k3";
      startup.config.providerSetup = {
        schemaVersion: 3,
        revision: 7,
        lifecycle: "configured",
        connections: [{
          id: `kimi-policy-${executionMode}`,
          backendId: "kimi-code",
          enabled: true,
          maturity: "preview",
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" },
          accountFingerprint: route.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: route.billingRealm,
          lastHealth: {
            credential: "valid",
            connectivity: "connected",
            spend: "unknown",
            runtime: "not-applicable",
            observedAt: 1,
            generation: 3,
          },
        }],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      };
      const runtime = await createDefaultProviderRuntime({
        startup,
        environment: {},
        requestedModel: "k3",
        executionMode,
      });
      await assert.rejects(runtime.inspectStartup(), (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: unknown }).code === "kimi-code-owner-interactive-required"
        && error.message === "Kimi Code subscription is only available in a local, interactive owner session."
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("CLI public input cannot mint a desktop Kimi capability, while the private launcher seam preserves identity", async (t) => {
  const privateCapability = Object.freeze({ marker: "private-desktop-capability" }) as never;
  const cases: readonly { name: string; injected: unknown | undefined }[] = [
    { name: "public input", injected: undefined },
    { name: "private launcher", injected: privateCapability },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let observed: unknown = Symbol("unobserved");
      const runtime = bootstrapRuntime({
        mode: "setup-required",
        route: null,
        setup: { kind: "cancelled", mode: "setup-required" },
      });
      await invokeRunCli(["--plain"], {
        initializeStorage: async () => bootstrapStorage(),
        createProviderRuntime: async (input: { desktopKimiCapability?: unknown }) => {
          observed = Object.hasOwn(input, "desktopKimiCapability")
            ? input.desktopKimiCapability
            : undefined;
          return runtime;
        },
        createAgent: async () => { throw new Error("setup-required mode must not create agent"); },
        runPlain: async () => undefined,
        runDashboard: async () => undefined,
        stdout: { write: () => true },
        stderr: { write: () => true },
        ...(entry.injected === undefined ? {} : { desktopKimiCapability: entry.injected as never }),
      });
      assert.equal(observed, entry.injected);
    });
  }
});

test("owner runtime composes only the exact healthy Kimi route into a secretless model runtime", async () => {
  const route = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_kimi_runtime_composition",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3-256k",
    canonicalModelId: "k3-256k",
    resolutionState: "resolved" as const,
  };
  const startup = bootstrapStorage();
  startup.config.mainModel = route.requestedModelId;
  startup.config.providerSetup = {
    schemaVersion: 3,
    revision: 11,
    lifecycle: "configured",
    connections: [{
      id: "kimi-runtime-composition",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: route.billingRealm,
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
        runtime: "not-applicable",
        observedAt: 1,
        generation: 19,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const runtime = await createDefaultProviderRuntime({
    startup,
    environment: {},
    requestedModel: route.requestedModelId,
    executionMode: "local-interactive-owner",
  });
  const modelRuntime = runtime.modelRuntime(route);
  assert.equal(modelRuntime.backendId, "kimi-code");
  const runtimeIdentity = readModelRuntimeIdentity(modelRuntime);
  assert.deepEqual(runtimeIdentity, {
    version: 1,
    stateRevision: 11,
    generation: 19,
    connectionId: "kimi-runtime-composition",
    backendId: "kimi-code",
    route,
  });
  assert.equal(Object.isFrozen(runtimeIdentity), true);
  assert.equal(Object.isFrozen(runtimeIdentity?.route), true);
  assert.equal(
    runtime.modelRuntime(route),
    modelRuntime,
    "the same exact authority binding must retain its secretless runtime and conversation cache",
  );
  assert.deepEqual(modelRuntime.dispatchFields({ route, allowWeb: false }), {
    backendId: "kimi-code",
    model: "k3-256k",
  });
  assert.throws(() => runtime.modelRuntime({
    ...route,
    accountFingerprint: "acct_kimi_runtime_foreign",
  }), /setup|binding|route/i);
  assert.throws(() => runtime.modelRuntime({
    ...route,
    requestedModelId: "foreign/k3-alias",
  }), /setup|binding|route/i);

  for (const runtimeHealth of [null, "missing", "incompatible", "policy-unavailable", "ready"] as const) {
    const unhealthyStartup = bootstrapStorage();
    unhealthyStartup.config.mainModel = route.requestedModelId;
    unhealthyStartup.config.providerSetup = structuredClone(startup.config.providerSetup);
    const connection = (unhealthyStartup.config.providerSetup as ProviderSetupStateV3).connections[0]!;
    connection.lastHealth = runtimeHealth === null
      ? null
      : { ...connection.lastHealth!, runtime: runtimeHealth };
    const unhealthy = await createDefaultProviderRuntime({
      startup: unhealthyStartup,
      environment: {},
      requestedModel: route.requestedModelId,
      executionMode: "local-interactive-owner",
    });
    assert.throws(
      () => unhealthy.modelRuntime(route),
      /setup|required/i,
      `Kimi runtime health ${runtimeHealth ?? "null"} must fail closed`,
    );
  }
});

test("default runtime projects Codex honestly without starting or preselecting a profile", async () => {
  const startup = bootstrapStorage();
  const runtime = await createDefaultProviderRuntime({
    startup,
    environment: {},
    executionMode: "local-interactive-owner",
  });

  const snapshot = runtime.desktopOnboardingAuthority!().snapshot();
  const codex = snapshot.providers.find((provider) => provider.providerId === "codex");
  assert.ok(codex);
  assert.equal(codex.connectionId, null);
  assert.equal(codex.state, "disabled");
  assert.deepEqual(codex.setupMethods, ["codex-browser-login", "codex-device-login"]);
  assert.equal(codex.disabled?.code, "native-local-action-unavailable");
  assert.match(codex.disabled?.label ?? "", /Entwicklungs-App/);
  assert.equal(codex.disabled?.recoveryLabel, "Signierte Desktop-App verwenden");
  assert.equal(codex.repair, undefined, "The same blocked-state instructions must not be repeated twice.");
  assert.deepEqual(codex.routes, []);
  assert.equal(snapshot.routeRunnable, false);
});

test("a forged structural desktop capability cannot enable the non-owner Kimi runtime construction path", async () => {
  const route = {
    version: 1 as const,
    backendId: "kimi-code" as const,
    accountFingerprint: "acct_kimi_desktop_runtime_composition",
    billingRealm: "kimi-code-membership-provider-managed-overage" as const,
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved" as const,
  };
  const startup = bootstrapStorage();
  startup.config.mainModel = route.requestedModelId;
  startup.config.providerSetup = {
    schemaVersion: 3,
    revision: 12,
    lifecycle: "configured",
    connections: [{
      id: "kimi-desktop-runtime-composition",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: route.billingRealm,
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
        runtime: "not-applicable",
        observedAt: 1,
        generation: 20,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let privateWrites = 0;
  const executableRoot = await mkdtemp(join(tmpdir(), "orcode-cli-attested-"));
  const executablePath = join(executableRoot, "orcode-gui");
  const executableBytes = Buffer.from("attested-cli-fixture");
  await writeFile(executablePath, executableBytes, { mode: 0o700 });
  const executableStat = await stat(executablePath);
  let startupControl: Uint8Array | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      privateWrites += 1;
      const request = decodePrivateActionFrame(frame);
      if (request.kind === "packaged-startup") startupControl = encodeControlFrame({ ...request, kind: "packaged-attestation", generation: 55, executablePath, executableDevice: executableStat.dev, executableInode: executableStat.ino, executableSize: executableStat.size, policySha256: "a".repeat(64), executableSha256: createHash("sha256").update(executableBytes).digest("hex") });
    },
    async readControl() {
      if (startupControl === null) return new Promise<Uint8Array | null>(() => {});
      const value = startupControl;
      startupControl = null;
      return value;
    },
    close() {},
  };
  const permitReader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  const capability = {
    kind: "desktop-kimi-runtime-capability" as const,
    permitReader,
    childPid: 4242,
    generation: 55,
    now: () => 1_775_000_000_000,
    emitRequirement() {},
  };

  await assert.rejects(createDefaultProviderRuntime({
    startup,
    environment: {},
    requestedModel: route.requestedModelId,
    executionMode: "piped",
    desktopKimiCapability: capability,
  }), /setup|required/i);
  assert.equal(privateWrites, 0, "forged runtime construction must not issue a native action");

  const attestation = await permitReader.consumePackagedStartup();
  const nominal = createDesktopKimiRuntimeCapability(attestation, { permitReader, childPid: process.pid, generation: 55, now: () => 1_775_000_000_000, emitRequirement() {} });
  const runtime = await createDefaultProviderRuntime({ startup, environment: {}, requestedModel: route.requestedModelId, executionMode: "piped", desktopKimiCapability: nominal });
  assert.equal(runtime.modelRuntime(route).backendId, "kimi-code");
  assert.equal(privateWrites, 1, "only the private startup handshake is written during construction");
  permitReader.close("end");
  assert.equal(isDesktopKimiRuntimeCapability(nominal), false);
});

test("Kimi policy is route-owned and never inferred from an OpenRouter model string", () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      ensureRunnableRoute(): Record<string, unknown>;
    };
  }).DefaultProviderRuntime;
  const route = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_openrouter_named_k3",
    billingRealm: "openrouter-payg",
    requestedModelId: "k3",
    canonicalModelId: "openrouter/k3",
    resolutionState: "resolved",
  } as const;
  const stateStore = new ProviderStateStore({
    schemaVersion: 3,
    revision: 4,
    lifecycle: "configured",
    connections: [{
      id: "openrouter-k3-name",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:11111111-1111-4111-8111-111111111111" },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "k3";
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() {
        return { id: "kimi-code", displayName: "Kimi Code Abo", maturity: "preview" };
      },
    },
    stateStore,
    { ensureRunnableRoute: (candidate: unknown) => candidate },
    {},
    {},
    {},
    null,
    null,
    "k3",
    config,
    undefined,
    undefined,
    "batch",
  );
  runtime.adoptCredentialActivation(route, true, "");
  assert.deepEqual(runtime.ensureRunnableRoute(), route);
});

test("modelRuntime rejects non-owner Kimi before provider state or authority work", () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      modelRuntime(route: Record<string, unknown>): unknown;
    };
  }).DefaultProviderRuntime;
  let stateReads = 0;
  const runtime = new Runtime(
    {},
    {},
    {},
    { read() { stateReads += 1; throw new Error("state must remain unread"); } },
    {},
    {},
    {},
    {},
    null,
    null,
    "k3",
    structuredClone(DEFAULT_CONFIG),
    undefined,
    undefined,
    "batch",
  );
  for (const candidate of [{
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "acct_kimi_policy_first",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    }, {
      backendId: "kimi-code",
      malformed: true,
    }]) {
    assert.throws(
      () => runtime.modelRuntime(candidate),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: string }).code === "kimi-code-owner-interactive-required",
    );
  }
  assert.equal(stateReads, 0);
});

test("mixed-provider status follows the persisted Kimi session route instead of the OpenRouter default", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const openRouterRoute = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_status_openrouter",
    billingRealm: "openrouter-payg",
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    resolutionState: "resolved",
  } as const;
  const kimiRoute = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_status_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3-256k",
    canonicalModelId: "k3-256k",
    resolutionState: "resolved",
  } as const;
  const stateStore = new ProviderStateStore({
    schemaVersion: 3,
    revision: 8,
    lifecycle: "configured",
    connections: [
      {
        id: "status-openrouter",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:22222222-2222-4222-8222-222222222222" },
        accountFingerprint: openRouterRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: null,
      },
      {
        id: "status-kimi",
        backendId: "kimi-code",
        enabled: true,
        maturity: "preview",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:33333333-3333-4333-8333-333333333333" },
        accountFingerprint: kimiRoute.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        lastHealth: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
          observedAt: 1,
          generation: 12,
        },
      },
    ],
    defaultRoute: openRouterRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    {},
    {},
    {
      entries: () => [
        { id: "openrouter", displayName: "OpenRouter", maturity: "stable", connectable: true },
        { id: "kimi-code", displayName: "Kimi Code Abo", maturity: "preview", connectable: true },
        { id: "anthropic", displayName: "Anthropic", maturity: "coming-soon", connectable: false },
      ],
    },
    stateStore,
    {},
    {},
    {},
    {},
    null,
    null,
    kimiRoute.requestedModelId,
    config,
  );
  runtime.adoptCredentialActivation(kimiRoute, true, "");
  const status = await runtime.execute({ kind: "status" }, "plain") as {
    providers: Array<Record<string, unknown>>;
  };
  const kimi = status.providers.find((entry) => entry.backendId === "kimi-code");
  assert.equal(kimi?.configuration, "enabled");
  assert.deepEqual(kimi?.selectedModel, {
    requestedModelId: "k3-256k",
    canonicalModelId: "k3-256k",
    displayName: "Kimi K3 256K",
  });
  assert.equal(kimi?.accountFingerprintSuffix, null);
});

test("Kimi models inspection keeps the exact persisted health generation", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const route = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_models_generation",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  } as const;
  const stateStore = new ProviderStateStore({
    schemaVersion: 3,
    revision: 9,
    lifecycle: "configured",
    connections: [{
      id: "models-generation",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:44444444-4444-4444-8444-444444444444" },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
        runtime: "not-applicable",
        observedAt: 1,
        generation: 27,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  const generations: number[] = [];
  const kimiAdapter = {
    async inspect(request: { generation: number }) {
      generations.push(request.generation);
      return {
        routeEligible: true,
        accountFingerprint: route.accountFingerprint,
        billingRealm: route.billingRealm,
      };
    },
    async listModels() {
      return [{
        backendId: "kimi-code",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        displayName: "Kimi K3",
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
      }];
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    {},
    {},
    {
      descriptor() {
        return { id: "kimi-code", displayName: "Kimi Code Abo", maturity: "preview" };
      },
    },
    stateStore,
    {},
    {},
    { async acquire() { return { async assertHeld() {}, release() {} }; } },
    {},
    null,
    null,
    "k3",
    config,
    undefined,
    { credentialAuthority: {}, adapter: {}, kimiAdapter },
  );
  runtime.adoptCredentialActivation(route, true, "");
  const result = await runtime.execute({ kind: "models", backendId: "kimi-code" }, "plain");
  assert.equal(result.kind, "models");
  assert.deepEqual(generations, [27]);
  assert.equal(stateStore.read().connections[0]?.lastHealth?.generation, 27);
});

const KIMI_LIFECYCLE_ROUTE = {
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "acct_kimi_lifecycle",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "k3",
  canonicalModelId: "k3",
  resolutionState: "resolved",
} as const;

const OPENROUTER_LIFECYCLE_ROUTE = {
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "acct_openrouter_lifecycle",
  billingRealm: "openrouter-payg",
  requestedModelId: "openrouter/auto",
  canonicalModelId: "openrouter/auto",
  resolutionState: "resolved",
} as const;

const LEGACY_OPENROUTER_LIFECYCLE_CONNECTION: ProviderConnectionStateV3 = {
  id: "legacy-openrouter-lifecycle-connection",
  backendId: "openrouter",
  enabled: true,
  maturity: "stable",
  credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
  accountFingerprint: "acct_legacy_openrouter_lifecycle",
  accountFingerprintState: "provisional",
  billingRealm: "openrouter-payg",
  lastHealth: null,
};

function kimiLifecycleState(options: {
  kimiEnabled?: boolean;
  includeOpenRouter?: boolean;
  openRouterEnabled?: boolean;
  defaultBackend?: "kimi-code" | "openrouter";
} = {}): ProviderSetupStateV3 {
  const openRouterRoute = OPENROUTER_LIFECYCLE_ROUTE;
  const connections: ProviderConnectionStateV3[] = [{
    id: "kimi-lifecycle-connection",
    backendId: "kimi-code",
    enabled: options.kimiEnabled ?? true,
    maturity: "preview",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:77777777-7777-4777-8777-777777777777" },
    accountFingerprint: KIMI_LIFECYCLE_ROUTE.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: KIMI_LIFECYCLE_ROUTE.billingRealm,
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 1,
      generation: 17,
    },
  }];
  if (options.includeOpenRouter) {
    connections.push({
      id: "openrouter-lifecycle-connection",
      backendId: "openrouter",
      enabled: options.openRouterEnabled ?? true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:88888888-8888-4888-8888-888888888888" },
      accountFingerprint: openRouterRoute.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: {
        credential: "valid",
        connectivity: "connected",
        spend: "available",
        runtime: "ready",
        observedAt: 1,
        generation: 18,
      },
    });
  }
  const defaultBackend = options.defaultBackend ?? "kimi-code";
  return {
    schemaVersion: 3,
    revision: 9,
    lifecycle: "configured",
    connections,
    defaultRoute: defaultBackend === "openrouter" ? openRouterRoute : KIMI_LIFECYCLE_ROUTE,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function kimiLifecycleRuntimeFixture(options: {
  state?: ProviderSetupStateV3;
  session?: SessionStore;
  requestedModel?: string;
  persist?: (request: ProviderStateCommitRequest) => Promise<ProviderSetupStateV3>;
  reconnect?: (backendId: string, input: { connectionId?: string }) => Promise<Record<string, unknown>>;
  loseLeaseAfterCommit?: boolean;
  credentials?: unknown;
  forgetJournal?: unknown;
} = {}) {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): Record<string, unknown>;
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
      adoptSession(session: SessionStore): void;
      transitionModel(modelId: string, canonicalModelId?: string, surface?: "plain"): Promise<void>;
      runSetup: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const initial = options.state ?? kimiLifecycleState();
  const stateStore = new ProviderStateStore(initial, options.persist ? { persist: options.persist } : undefined);
  const calls: string[] = [];
  const openRouterModels: BackendModelDescriptor[] = [{
    backendId: "openrouter",
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    displayName: "OpenRouter Auto",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  }];
  const kimiModels: BackendModelDescriptor[] = [{
    backendId: "kimi-code",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    displayName: "Kimi K3",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  }, {
    backendId: "kimi-code",
    requestedModelId: "k3-256k",
    canonicalModelId: "k3-256k",
    displayName: "Kimi K3 256K",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  }];
  const openRouterAdapter = {
    backendId: "openrouter",
    async inspectUnderAuthorityLease(request: { connectionId: string; generation: number }) {
      calls.push(`openrouter:inspect:${request.connectionId}:${request.generation}`);
      return {
        routeEligible: true,
        accountFingerprint: "acct_openrouter_lifecycle",
        billingRealm: "openrouter-payg",
        health: initial.connections.find((entry) => entry.backendId === "openrouter")?.lastHealth,
      };
    },
    async listModels(request: { connectionId?: string }) {
      calls.push(`openrouter:models:${request.connectionId ?? "none"}`);
      return openRouterModels;
    },
    async bindRuntimeUnderAuthorityLease(request: { connectionId: string }) {
      calls.push(`openrouter:bind:${request.connectionId}`);
    },
    async bindRuntime(request: { connectionId: string }) {
      calls.push(`openrouter:bind:${request.connectionId}`);
    },
  };
  const kimiAdapter = {
    backendId: "kimi-code",
    async inspectUnderAuthorityLease(request: { connectionId: string; generation: number }) {
      calls.push(`kimi:inspect-authority:${request.connectionId}:${request.generation}`);
      return {
        routeEligible: true,
        accountFingerprint: KIMI_LIFECYCLE_ROUTE.accountFingerprint,
        billingRealm: KIMI_LIFECYCLE_ROUTE.billingRealm,
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
          observedAt: 2,
          generation: request.generation,
        },
      };
    },
    async inspect(request: { connectionId: string; generation: number }) {
      calls.push(`kimi:inspect:${request.connectionId}:${request.generation}`);
      return {
        routeEligible: true,
        accountFingerprint: KIMI_LIFECYCLE_ROUTE.accountFingerprint,
        billingRealm: KIMI_LIFECYCLE_ROUTE.billingRealm,
        health: initial.connections.find((entry) => entry.backendId === "kimi-code")?.lastHealth,
      };
    },
    async listModels(request: { connectionId?: string }) {
      calls.push(`kimi:models:${request.connectionId ?? "none"}`);
      return kimiModels;
    },
    async logout() { calls.push("kimi:logout"); },
  };
  const runtimeGuard = providerRuntimeGuardFixture();
  const coordinatorBase = providerCoordinatorMutationFixture(runtimeGuard);
  const coordinator = {
    ...coordinatorBase,
    ...(options.loseLeaseAfterCommit
      ? {
          async runExclusive<T>(
            _request: { signal: AbortSignal },
            operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
          ): Promise<T> {
            return operation({
              async assertHeld() {
                if (stateStore.read().revision > initial.revision) {
                  throw new Error("fixed post-commit provider lease loss");
                }
              },
            });
          },
        }
      : {}),
    async readAuthority<T>(
      _request: { signal: AbortSignal },
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      calls.push("authority:read");
      return operation({ async assertHeld() {} });
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = options.requestedModel ?? initial.defaultRoute?.requestedModelId ?? "k3";
  config.providerSetup = stateStore.read();
  const registry = {
    descriptor(id: string) {
      return id === "kimi-code"
        ? { id, displayName: "Kimi Code Abo", maturity: "preview", connectable: true }
        : id === "openrouter"
          ? { id, displayName: "OpenRouter", maturity: "stable", connectable: true }
          : { id: "anthropic", displayName: "Anthropic", maturity: "coming-soon", connectable: false };
    },
    entries() {
      return [this.descriptor("openrouter"), this.descriptor("kimi-code"), this.descriptor("anthropic")];
    },
    adapter(id: string) { return id === "kimi-code" ? kimiAdapter : openRouterAdapter; },
  };
  const orchestrator = {
    async reconnect(backendId: string, input: { connectionId?: string }) {
      calls.push(`reconnect:${backendId}:${input.connectionId ?? "none"}`);
      return options.reconnect
        ? options.reconnect(backendId, input)
        : {
            mode: "ready",
            generation: stateStore.read().connections.find((entry) => entry.backendId === backendId)?.lastHealth?.generation ?? 0,
            defaultRoute: stateStore.read().defaultRoute,
            readyRoutes: stateStore.read().defaultRoute ? [stateStore.read().defaultRoute] : [],
            warnings: [],
            crossEnabled: false,
          };
    },
    ensureRunnableRoute(requested?: Record<string, unknown>) {
      const route = requested ?? stateStore.read().defaultRoute;
      if (!route) throw new Error("provider-setup-required");
      return structuredClone(route);
    },
    nextStartupGeneration() { return 1; },
  };
  const runtime = new Runtime(
    { async listModels() { calls.push("openrouter:legacy-models"); return []; } },
    options.credentials ?? {},
    registry,
    stateStore,
    orchestrator,
    coordinator,
    { ...runtimeGuard, beginRun() { throw new Error("nested runtime run guard"); } },
    {},
    null,
    null,
    options.requestedModel ?? config.mainModel,
    config,
    options.session,
    {
      credentialAuthority: {},
      adapter: openRouterAdapter,
      kimiAdapter,
      forgetJournal: options.forgetJournal ?? {},
      async recover() {},
    },
    "local-interactive-owner",
  );
  return { runtime, stateStore, config, calls, openRouterAdapter, kimiAdapter };
}

test("slash provider connect kimi-code reaches the runtime's backend-targeted setup", async () => {
  const fixture = kimiLifecycleRuntimeFixture();
  const setupCalls: unknown[][] = [];
  fixture.runtime.runSetup = async (...args: unknown[]) => {
    setupCalls.push(args);
    return { kind: "ready" };
  };
  const output: string[] = [];
  const context = {
    config: fixture.config,
    providerCommands: fixture.runtime,
    out: {
      text(value: string) { output.push(value); },
      error(value: string) { output.push(value); },
    },
  } as unknown as CommandContext;

  await handleSlashCommand("/provider connect kimi-code", context);

  assert.deepEqual(setupCalls, [["plain", undefined, "kimi-code"]]);
  assert.deepEqual(output, ["Kimi Code · Provider setup: ready"]);
});

test("Kimi enable is idempotent for an already enabled exact route and never re-enters setup", async () => {
  const fixture = kimiLifecycleRuntimeFixture();
  let setupCalls = 0;
  fixture.runtime.runSetup = async () => {
    setupCalls += 1;
    return { kind: "cancelled", mode: "setup-required" };
  };

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "kimi-code" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "kimi-code", outcome: "ready" });
  assert.equal(setupCalls, 0);
  assert.deepEqual(fixture.runtime.ensureRunnableRoute(), KIMI_LIFECYCLE_ROUTE);
  assert.deepEqual(fixture.calls, []);
});

test("enabled retained Kimi adopts its exact route from an OpenRouter current route without replacement setup", async () => {
  const initial = kimiLifecycleState({
    includeOpenRouter: true,
    openRouterEnabled: true,
    defaultBackend: "openrouter",
  });
  const fixture = kimiLifecycleRuntimeFixture({
    state: initial,
    requestedModel: "openrouter/auto",
  });
  let setupCalls = 0;
  fixture.runtime.runSetup = async () => {
    setupCalls += 1;
    return { kind: "cancelled", mode: "setup-required" };
  };

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "kimi-code" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "kimi-code", outcome: "ready" });
  assert.equal(setupCalls, 0);
  assert.equal(fixture.stateStore.read().revision, initial.revision);
  assert.deepEqual(fixture.stateStore.read(), initial);
  assert.deepEqual(fixture.runtime.ensureRunnableRoute(), KIMI_LIFECYCLE_ROUTE);
  assert.deepEqual(fixture.calls, [
    "kimi:inspect-authority:kimi-lifecycle-connection:18",
    "kimi:models:kimi-lifecycle-connection",
  ]);
});

test("enabled retained OpenRouter adopts its exact route from a Kimi current route without replacement setup", async () => {
  const initial = kimiLifecycleState({
    includeOpenRouter: true,
    openRouterEnabled: true,
    defaultBackend: "kimi-code",
  });
  const fixture = kimiLifecycleRuntimeFixture({ state: initial, requestedModel: "k3" });
  let setupCalls = 0;
  fixture.runtime.runSetup = async () => {
    setupCalls += 1;
    return { kind: "cancelled", mode: "setup-required" };
  };

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "openrouter" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "openrouter", outcome: "ready" });
  assert.equal(setupCalls, 0);
  assert.equal(fixture.stateStore.read().revision, initial.revision);
  assert.deepEqual(fixture.stateStore.read(), initial);
  assert.equal(fixture.runtime.ensureRunnableRoute().backendId, "openrouter");
  assert.equal(fixture.runtime.ensureRunnableRoute().requestedModelId, "openrouter/auto");
  assert.deepEqual(fixture.calls, [
    "openrouter:inspect:openrouter-lifecycle-connection:19",
    "openrouter:models:openrouter-lifecycle-connection",
    "openrouter:bind:openrouter-lifecycle-connection",
  ]);
});

test("Kimi enable adopts an exact durably published tuple when persistence reports failure after publication", async () => {
  const initial = kimiLifecycleState({ kimiEnabled: false });
  initial.defaultRoute = null;
  let durable = structuredClone(initial);
  const fixture = kimiLifecycleRuntimeFixture({
    state: initial,
    persist: async (request) => {
      const next = request.build(structuredClone(durable));
      durable = structuredClone(next);
      request.adopt(next);
      throw new Error("fixed publish-then-throw boundary");
    },
  });

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "kimi-code" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "kimi-code", outcome: "ready" });
  assert.deepEqual(fixture.stateStore.read(), durable);
  assert.deepEqual(fixture.config.providerSetup, durable);
  assert.equal(durable.connections[0]?.enabled, true);
  assert.deepEqual(fixture.runtime.ensureRunnableRoute(), KIMI_LIFECYCLE_ROUTE);
  assert.equal(durable.cross.enabled, false);
});

test("Kimi enable adopts the exact committed tuple after a post-commit provider lease loss", async () => {
  const initial = kimiLifecycleState({ kimiEnabled: false });
  initial.defaultRoute = null;
  const fixture = kimiLifecycleRuntimeFixture({ state: initial, loseLeaseAfterCommit: true });

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "kimi-code" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "kimi-code", outcome: "ready" });
  assert.equal(fixture.stateStore.read().revision, initial.revision + 1);
  assert.equal(fixture.stateStore.read().connections[0]?.enabled, true);
  assert.deepEqual(fixture.runtime.ensureRunnableRoute(), KIMI_LIFECYCLE_ROUTE);
  assert.deepEqual(fixture.config.providerSetup, fixture.stateStore.read());
});

for (const boundary of ["publish-then-throw", "post-commit-lease-loss"] as const) {
  test(`Kimi model change adopts the one exact committed tuple after ${boundary}`, async () => {
    const initial = kimiLifecycleState();
    let durable = structuredClone(initial);
    const fixture = kimiLifecycleRuntimeFixture({
      state: initial,
      ...(boundary === "publish-then-throw"
        ? {
            persist: async (request: ProviderStateCommitRequest) => {
              const next = request.build(structuredClone(durable));
              durable = structuredClone(next);
              request.adopt(next);
              throw new Error("fixed model publish-then-throw boundary");
            },
          }
        : { loseLeaseAfterCommit: true }),
    });

    await fixture.runtime.transitionModel("k3-256k", "k3-256k", "plain");

    if (boundary === "post-commit-lease-loss") durable = fixture.stateStore.read();
    assert.equal(durable.revision, initial.revision + 1);
    assert.equal(durable.defaultRoute?.requestedModelId, "k3-256k");
    assert.equal(durable.defaultRoute?.canonicalModelId, "k3-256k");
    assert.equal(durable.cross.enabled, false);
    assert.deepEqual(fixture.stateStore.read(), durable);
    assert.deepEqual(fixture.config.providerSetup, durable);
    assert.deepEqual(fixture.runtime.ensureRunnableRoute(), durable.defaultRoute);
  });
}

test("mixed-provider OpenRouter enable chooses an OpenRouter route instead of the current Kimi model", async () => {
  const fixture = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({ includeOpenRouter: true, openRouterEnabled: false }),
    requestedModel: "k3",
  });

  const result = await fixture.runtime.execute({ kind: "enable", backendId: "openrouter" }, "plain");

  assert.deepEqual(result, { kind: "setup", backendId: "openrouter", outcome: "ready" });
  assert.equal(fixture.stateStore.read().connections.find((entry) => entry.backendId === "openrouter")?.enabled, true);
  assert.equal(fixture.stateStore.read().defaultRoute?.backendId, "openrouter");
  assert.equal(fixture.stateStore.read().defaultRoute?.requestedModelId, "openrouter/auto");
  assert.equal(fixture.calls.some((call) => call.startsWith("kimi:")), false);
});

test("explicit OpenRouter models inspect the exact OpenRouter connection while the chat route is Kimi", async () => {
  const fixture = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({ includeOpenRouter: true, openRouterEnabled: true }),
  });

  const result = await fixture.runtime.execute({ kind: "models", backendId: "openrouter" }, "plain");

  assert.equal(result.kind, "models");
  assert.deepEqual(result.models, [{
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    displayName: "OpenRouter Auto",
  }]);
  assert.deepEqual(fixture.calls, [
    "authority:read",
    "openrouter:inspect:openrouter-lifecycle-connection:18",
    "openrouter:models:openrouter-lifecycle-connection",
  ]);
});

test("reconnecting Kimi leaves an unrelated exact OpenRouter chat route bound", async () => {
  const state = kimiLifecycleState({
    includeOpenRouter: true,
    openRouterEnabled: true,
    defaultBackend: "openrouter",
  });
  const openRouterRoute = state.defaultRoute!;
  const session = SessionStore.create("/synthetic/mixed-reconnect", "/synthetic/.orcode");
  session.setPreferences(openRouterRoute.requestedModelId, { mode: "auto" }, openRouterRoute);
  const fixture = kimiLifecycleRuntimeFixture({ state, session, requestedModel: openRouterRoute.requestedModelId });
  fixture.runtime.adoptCredentialActivation(openRouterRoute as unknown as Record<string, unknown>, true, "");

  const result = await fixture.runtime.execute({ kind: "reconnect", backendId: "kimi-code" }, "plain");

  assert.equal(result.kind, "reconnected");
  assert.deepEqual(fixture.runtime.ensureRunnableRoute(), openRouterRoute);
  assert.deepEqual(session.data.route, openRouterRoute);
  assert.equal(fixture.config.mainModel, openRouterRoute.requestedModelId);
  assert.deepEqual(fixture.calls, ["reconnect:kimi-code:kimi-lifecycle-connection"]);
});

test("Kimi disable clears and durably saves only the matching persisted session route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-disable-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspace, appHome, "Kimi disable");
  session.setPreferences("k3", { mode: "effort", effort: "high" }, KIMI_LIFECYCLE_ROUTE);
  session.addTurn("user", "bleibt erhalten");
  session.addCost("main", 0.5, "unknown");
  await session.save();
  const before = structuredClone(session.data);
  const fixture = kimiLifecycleRuntimeFixture({ session });

  const prompt = await fixture.runtime.execute({ kind: "disable", backendId: "kimi-code" }, "plain");
  const result = await fixture.runtime.execute({
    kind: "disable",
    backendId: "kimi-code",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.equal(session.data.route, undefined);
  assert.equal(session.data.routeCleared, true);
  const { routeCleared: _routeCleared, ...clearedWithoutTombstone } = session.data;
  assert.deepEqual({ ...clearedWithoutTombstone, route: before.route, revision: before.revision }, before);
  const reopened = await SessionStore.openById(
    workspace,
    session.data.id,
    appHome,
    LEGACY_OPENROUTER_LIFECYCLE_CONNECTION,
  );
  assert.equal(reopened.data.route, undefined);
  assert.equal(reopened.data.routeCleared, true);
  assert.equal(reopened.data.model, "k3");
  assert.deepEqual(reopened.data.reasoning, before.reasoning);
  assert.deepEqual(reopened.data.turns, before.turns);
  assert.equal(reopened.data.costs.costKnowledge, "unknown");
  const restartedRuntime = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({
      kimiEnabled: false,
      includeOpenRouter: true,
      defaultBackend: "openrouter",
    }),
    session: reopened,
  });
  assert.throws(
    () => restartedRuntime.runtime.ensureRunnableRoute(),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === "provider-setup-required",
  );
});

test("Kimi disable preserves a concurrently persisted OpenRouter session route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-disable-route-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const seed = SessionStore.create(workspace, appHome, "Disable route race");
  seed.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  await seed.save();
  const lifecycleOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  const concurrentOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  concurrentOwner.setPreferences("openrouter/auto", { mode: "auto" }, OPENROUTER_LIFECYCLE_ROUTE);
  await concurrentOwner.save();
  const fixture = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({ includeOpenRouter: true }),
    session: lifecycleOwner,
  });

  const prompt = await fixture.runtime.execute({ kind: "disable", backendId: "kimi-code" }, "plain");
  const result = await fixture.runtime.execute({
    kind: "disable",
    backendId: "kimi-code",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.deepEqual(lifecycleOwner.data.route, OPENROUTER_LIFECYCLE_ROUTE);
  assert.deepEqual(
    (await SessionStore.openById(workspace, seed.data.id, appHome)).data.route,
    OPENROUTER_LIFECYCLE_ROUTE,
  );
});

test("session adoption keeps an explicitly cleared chat unbound from the current OpenRouter default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-cleared-session-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const current = SessionStore.create(workspace, appHome, "Current OpenRouter");
  current.setPreferences("openrouter/auto", { mode: "auto" }, OPENROUTER_LIFECYCLE_ROUTE);
  await current.save();
  const cleared = SessionStore.create(workspace, appHome, "Cleared Kimi");
  cleared.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  await cleared.save();
  assert.equal(await cleared.clearRouteIfExact(KIMI_LIFECYCLE_ROUTE), true);

  const fixture = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({ includeOpenRouter: true, defaultBackend: "openrouter" }),
    session: current,
  });
  fixture.runtime.adoptCredentialActivation(OPENROUTER_LIFECYCLE_ROUTE, true, "");
  fixture.runtime.adoptSession(cleared);

  assert.equal(cleared.data.model, "k3");
  assert.equal(cleared.data.route, undefined);
  assert.equal(cleared.data.routeCleared, true);
  assert.throws(
    () => fixture.runtime.ensureRunnableRoute(),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === "provider-setup-required",
  );
});

test("Kimi logout without any retained connection is idempotent and creates no confirmation", async () => {
  const empty: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const fixture = kimiLifecycleRuntimeFixture({ state: empty });

  const result = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");

  assert.deepEqual(result, {
    kind: "unchanged",
    backendId: "kimi-code",
    reason: "already logged out",
  });
  assert.deepEqual(fixture.calls, []);
});

test("Kimi logout becomes idempotent when the exact connection disappears after confirmation", async () => {
  const fixture = kimiLifecycleRuntimeFixture();
  const prompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  const current = fixture.stateStore.read();
  fixture.stateStore.replace({
    ...current,
    connections: [],
    defaultRoute: null,
  }, current.revision);

  const result = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.deepEqual(result, {
    kind: "unchanged",
    backendId: "kimi-code",
    reason: "already logged out",
  });
  assert.deepEqual(fixture.calls, []);
});

test("Kimi logout deletes only its exact slot and durably clears the matching session route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-logout-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspace, appHome, "Kimi logout");
  session.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  session.addTurn("user", "history survives logout");
  await session.save();
  const deletedSlots: string[] = [];
  const credentials = {
    async deleteSlot(slot: CredentialSlotRef) {
      deletedSlots.push(slot.id);
      return true;
    },
  };
  const Journal = (cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
      readPending(): Promise<unknown>;
    };
  }).ProviderCredentialForgetJournal;
  const forgetJournal = new Journal({ appHome, privateStore: new PrivateStore({ root: appHome }) });
  const fixture = kimiLifecycleRuntimeFixture({
    session,
    credentials,
    forgetJournal,
  });

  const prompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  const result = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.deepEqual(deletedSlots, ["v1:kimi-code:77777777-7777-4777-8777-777777777777"]);
  assert.deepEqual(fixture.stateStore.read().connections, []);
  assert.equal(fixture.stateStore.read().defaultRoute, null);
  assert.equal(fixture.stateStore.read().cross.enabled, false);
  assert.equal(session.data.route, undefined);
  assert.equal(session.data.routeCleared, true);
  const reopened = await SessionStore.openById(
    workspace,
    session.data.id,
    appHome,
    LEGACY_OPENROUTER_LIFECYCLE_CONNECTION,
  );
  assert.equal(reopened.data.route, undefined);
  assert.equal(reopened.data.routeCleared, true);
  assert.deepEqual(reopened.data.turns, session.data.turns);
  const restartedRuntime = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({
      includeOpenRouter: true,
      defaultBackend: "openrouter",
    }),
    session: reopened,
  });
  assert.throws(
    () => restartedRuntime.runtime.ensureRunnableRoute(),
    (error: unknown) => error instanceof Error
      && (error as Error & { code?: string }).code === "provider-setup-required",
  );
  assert.equal(await forgetJournal.readPending(), null);
  assert.equal(fixture.calls.includes("kimi:logout"), true);
});

test("FIX-10 F2: Kimi logout removes ambiguous multi-connections one at a time instead of answering 'already logged out'", async (t) => {
  // The exact state the setup hub's ambiguity notice prints its remedy for:
  // TWO kimi connections, and a NON-kimi desired/default route (an
  // OpenRouter user adding Kimi — no selector resolves a kimi binding).
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-logout-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appHome = join(root, ".orcode");
  const base = kimiLifecycleState({ includeOpenRouter: true, defaultBackend: "openrouter" });
  const kimiConnection = base.connections.find((entry) => entry.backendId === "kimi-code")!;
  const twoKimi: ProviderSetupStateV3 = {
    ...base,
    connections: [
      ...base.connections,
      {
        ...kimiConnection,
        id: "kimi-lifecycle-connection-second",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:99999999-9999-4999-8999-999999999999" },
        accountFingerprint: "acct_kimi_second_ambiguous",
      },
    ],
  };
  const deletedSlots: string[] = [];
  const credentials = {
    async deleteSlot(slot: CredentialSlotRef) {
      deletedSlots.push(slot.id);
      return true;
    },
  };
  const Journal = (cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      begin(input: Record<string, unknown>): Promise<unknown>;
      markDeleted(transaction: unknown): Promise<void>;
      complete(transaction: unknown): Promise<void>;
      readPending(): Promise<unknown>;
    };
  }).ProviderCredentialForgetJournal;
  const forgetJournal = new Journal({ appHome, privateStore: new PrivateStore({ root: appHome }) });
  const fixture = kimiLifecycleRuntimeFixture({ state: twoKimi, credentials, forgetJournal });
  const kimiCount = (): number => fixture.stateStore.read().connections
    .filter((entry) => entry.backendId === "kimi-code").length;
  assert.equal(kimiCount(), 2);

  // First logout: must offer a real confirmation (the old code returned
  // {kind:"unchanged", reason:"already logged out"} while both remained).
  const firstPrompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  assert.equal(firstPrompt.kind, "confirmation-required");
  const firstResult = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: firstPrompt.confirmationToken,
  }, "plain");
  assert.equal(firstResult.kind, "changed");
  // Deterministic: the FIRST stored kimi connection went; one remains, so
  // the setup hub's `> 1` ambiguity gate is already cleared.
  assert.equal(kimiCount(), 1);
  assert.deepEqual(deletedSlots, ["v1:kimi-code:77777777-7777-4777-8777-777777777777"]);

  // Second logout removes the survivor through the now-unambiguous path.
  const secondPrompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  assert.equal(secondPrompt.kind, "confirmation-required");
  const secondResult = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: secondPrompt.confirmationToken,
  }, "plain");
  assert.equal(secondResult.kind, "changed");
  assert.equal(kimiCount(), 0);

  // Only NOW is "already logged out" true.
  const third = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  assert.deepEqual(third, { kind: "unchanged", backendId: "kimi-code", reason: "already logged out" });
  // The OpenRouter connection and default route were never touched.
  assert.equal(fixture.stateStore.read().connections.some((entry) => entry.backendId === "openrouter"), true);
  assert.equal(fixture.stateStore.read().defaultRoute?.backendId, "openrouter");
});

test("Kimi logout leaves provider cleanup retryable when durable session route clearing rejects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-logout-route-clear-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspace, appHome, "Kimi logout retry");
  session.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  session.addTurn("user", "history survives a failed logout attempt");
  await session.save();
  const initialState = kimiLifecycleState();
  const deletedSlots: string[] = [];
  const credentials = {
    async deleteSlot(slot: CredentialSlotRef) {
      deletedSlots.push(slot.id);
      return true;
    },
  };
  const Journal = (cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => {
      readPending(): Promise<unknown>;
    };
  }).ProviderCredentialForgetJournal;
  const forgetJournal = new Journal({ appHome, privateStore: new PrivateStore({ root: appHome }) });
  const fixture = kimiLifecycleRuntimeFixture({
    state: initialState,
    session,
    credentials,
    forgetJournal,
  });
  const clearRouteIfExact = session.clearRouteIfExact.bind(session);
  let rejectClear = true;
  session.clearRouteIfExact = async (route) => {
    if (rejectClear) throw new Error("fixed durable session clear rejection");
    return clearRouteIfExact(route);
  };

  const firstPrompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  await assert.rejects(
    fixture.runtime.execute({
      kind: "logout",
      backendId: "kimi-code",
      confirmationToken: firstPrompt.confirmationToken,
    }, "plain"),
    /Provider credential cleanup is pending and will resume on restart/,
  );
  assert.deepEqual(fixture.stateStore.read(), initialState);
  assert.deepEqual(deletedSlots, []);
  assert.deepEqual(await forgetJournal.readPending(), null);
  assert.deepEqual(session.data.route, KIMI_LIFECYCLE_ROUTE);

  rejectClear = false;
  const retryPrompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  const retry = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: retryPrompt.confirmationToken,
  }, "plain");
  assert.equal(retry.kind, "changed");
  assert.deepEqual(fixture.stateStore.read().connections, []);
  assert.deepEqual(deletedSlots, ["v1:kimi-code:77777777-7777-4777-8777-777777777777"]);
  assert.equal(session.data.route, undefined);
  assert.deepEqual(await forgetJournal.readPending(), null);
});

test("Kimi logout preserves a concurrently persisted OpenRouter session route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-logout-route-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const seed = SessionStore.create(workspace, appHome, "Logout route race");
  seed.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  await seed.save();
  const lifecycleOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  const concurrentOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  concurrentOwner.setPreferences("openrouter/auto", { mode: "auto" }, OPENROUTER_LIFECYCLE_ROUTE);
  await concurrentOwner.save();
  const credentials = { async deleteSlot() { return true; } };
  const Journal = (cliModule as typeof cliModule & {
    ProviderCredentialForgetJournal: new (input: {
      appHome: string;
      privateStore: PrivateStore;
    }) => unknown;
  }).ProviderCredentialForgetJournal;
  const fixture = kimiLifecycleRuntimeFixture({
    state: kimiLifecycleState({ includeOpenRouter: true }),
    session: lifecycleOwner,
    credentials,
    forgetJournal: new Journal({ appHome, privateStore: new PrivateStore({ root: appHome }) }),
  });

  const prompt = await fixture.runtime.execute({ kind: "logout", backendId: "kimi-code" }, "plain");
  const result = await fixture.runtime.execute({
    kind: "logout",
    backendId: "kimi-code",
    confirmationToken: prompt.confirmationToken,
  }, "plain");

  assert.equal(result.kind, "changed");
  assert.deepEqual(lifecycleOwner.data.route, OPENROUTER_LIFECYCLE_ROUTE);
  assert.deepEqual(
    (await SessionStore.openById(workspace, seed.data.id, appHome)).data.route,
    OPENROUTER_LIFECYCLE_ROUTE,
  );
});

test("noninteractive agent creation and run stay inside the complete ready-route guard", async () => {
  const events: string[] = [];
  const route = bootstrapRoute("vendor/guarded-main");
  const runtime = bootstrapRuntime({ route, events }) as BootstrapRuntimeDouble & Record<string, unknown>;
  runtime.modelRuntime = () => {
    events.push("runtime:bind");
    return { backendId: "openrouter" };
  };
  runtime.runWithReadyRoute = async (run: (candidate: Record<string, unknown>) => Promise<number>) => {
    events.push("guard:begin");
    const result = await run(route);
    events.push("guard:end");
    return result;
  };
  runtime.currentSessionRoute = () => route;
  runtime.providerCredentials = { async apply() { return { kind: "unchanged" }; } };
  runtime.execute = async () => ({ kind: "unchanged" });
  runtime.adoptSession = () => undefined;
  runtime.migratedSessionConnection = () => undefined;
  const exitCode = await invokeRunCli(["--json", "-p", "guarded"], {
    initializeStorage: async () => bootstrapStorage(),
    createProviderRuntime: async () => runtime,
    createAgent: async () => {
      events.push("agent:create");
      return {
        async run() {
          events.push("agent:run");
          return { outcome: "completed" };
        },
      } as never;
    },
    runPlain: async () => undefined,
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });
  assert.equal(exitCode, 0);
  assert.ok(events.indexOf("guard:begin") < events.indexOf("agent:create"));
  assert.ok(events.indexOf("agent:create") < events.indexOf("agent:run"));
  assert.ok(events.indexOf("agent:run") < events.indexOf("guard:end"));
});

test("dashboard Kimi model helpers never touch OpenRouter and classify unsupported shortcuts", async (t) => {
  const api = cliModule as unknown as {
    loadProviderModelSnapshot(context: Record<string, unknown>, modelId: string): Promise<{
      model: ModelInfo | null;
      details: string;
    }>;
    dashboardKimiUnsupportedMessage(
      route: Record<string, unknown>,
      command: string,
      args: readonly string[],
    ): string | null;
    pickDashboardModel(ui: Record<string, unknown>, context: Record<string, unknown>): Promise<ModelInfo | null>;
  };
  assert.equal(typeof api.loadProviderModelSnapshot, "function");
  assert.equal(typeof api.dashboardKimiUnsupportedMessage, "function");
  const route = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_dashboard_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  } as const;
  let openRouterCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-dashboard-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const openRouter = {
    async listModels() { openRouterCalls += 1; throw new Error("OpenRouter forbidden"); },
  };
  const transitions: string[] = [];
  const context = {
    openRouter,
    config: { ...structuredClone(DEFAULT_CONFIG), mainModel: "k3" },
    configPath: join(root, "config.json"),
    providerRuntime: {
      currentSessionRoute: () => route,
      async transitionModel(id: string) { transitions.push(id); },
    },
    providerCommands: {
      async execute() {
        return {
          kind: "models",
          backendId: "kimi-code",
          models: [
            { requestedModelId: "k3", canonicalModelId: "k3", displayName: "Kimi K3" },
            { requestedModelId: "k3-256k", canonicalModelId: "k3-256k", displayName: "Kimi K3 256K" },
          ],
        };
      },
    },
  };
  const snapshot = await api.loadProviderModelSnapshot(context, "k3");
  assert.equal(snapshot.model?.id, "k3");
  assert.match(snapshot.details, /provider-managed|unknown/i);
  const selected = await api.pickDashboardModel({
    setStatus() {},
    setCancelHandler() {},
    async pickModel() { return snapshot.model ? { ...snapshot.model, id: "k3-256k", canonicalSlug: "k3-256k" } : null; },
  }, context);
  assert.equal(selected?.id, "k3-256k");
  assert.deepEqual(transitions, ["k3-256k"]);
  assert.equal(openRouterCalls, 0);
  assert.match(api.dashboardKimiUnsupportedMessage(route, "image", []) ?? "", /Images.*not.*available/i);
  assert.match(api.dashboardKimiUnsupportedMessage(route, "whisper", []) ?? "", /Voice.*not.*available/i);
  assert.match(api.dashboardKimiUnsupportedMessage(route, "compress", ["model"]) ?? "", /Summarizer.*not.*available/i);
  assert.equal(api.dashboardKimiUnsupportedMessage(route, "model", []), null);
});

test("runCli synchronizes the exact startup route into the current session before agent creation", async () => {
  const route = {
    ...bootstrapRoute("vendor/startup-exact"),
    accountFingerprint: "acct_startup_exact_333333",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
    runPlain: async (input: { ensureAgentForPrompt(): Promise<unknown> }) => {
      await input.ensureAgentForPrompt();
    },
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
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/selected-chat-b"),
    accountFingerprint: "acct_late_agent_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
      startDeferredRetention: () => undefined,
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
    runPlain: async (input: { agent: unknown; ensureAgentForPrompt(): Promise<unknown> }) => {
      plainAgent = input.agent;
      calls.push("plain");
      await assert.rejects(
        input.ensureAgentForPrompt(),
        (error: unknown) => Boolean(
          error && typeof error === "object" && "code" in error
          && error.code === "provider-setup-required"
        ),
      );
    },
    runDashboard: async () => undefined,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 0);
  assert.equal(plainAgent, null);
  assert.deepEqual(calls, [
    "provider:inspect",
    "plain",
    "provider:ensure",
    "provider:setup:plain",
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
    runPlain: async (input: { ensureAgentForPrompt(): Promise<unknown> }) => {
      await input.ensureAgentForPrompt();
      calls.push("plain");
    },
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
  // `/models` owns its provider runtime guard internally. Wrapping it in the
  // generic model-action guard would recursively acquire the same lease.
  assert.equal(commandRequiresRunnableRoute("models", ["coder"]), false);
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

test("authentication recovery cannot invalidate a route while another full model run is active", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      adoptCredentialActivation(route: RouteIdentityV1, persisted: boolean, secret: string): void;
      currentSessionRoute(): RouteIdentityV1;
      runWithReadyRoute<T>(run: (route: RouteIdentityV1) => Promise<T>): Promise<T>;
    };
  }).DefaultProviderRuntime;
  const route = bootstrapRoute("vendor/concurrent-auth-recovery") as unknown as RouteIdentityV1;
  const stateStore = new ProviderStateStore({
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "concurrent-auth-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:76767676-7676-4767-8767-767676767676" },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  });
  let activeRuns = 0;
  let activationHeld = false;
  const runtimeGuard = {
    async acquire(signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      if (activationHeld || activeRuns > 0) {
        throw Object.assign(new Error("provider runtime busy"), {
          code: "provider-runtime-not-idle",
        });
      }
      activationHeld = true;
      let held = true;
      const assertHeld = () => {
        if (!held || !activationHeld || activeRuns > 0) throw new Error("provider runtime lease lost");
      };
      return {
        assertHeld,
        release() {
          if (!held) return;
          held = false;
          activationHeld = false;
        },
      };
    },
    beginRun() {
      if (activationHeld) throw new Error("provider runtime activation held");
      activeRuns += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activeRuns -= 1;
      };
    },
  };
  let reconnects = 0;
  const runtime = new Runtime(
    { runtimeState: { inferenceValidity: "valid" } },
    {},
    {},
    stateStore,
    {
      async reconnect() { reconnects += 1; },
      ensureRunnableRoute() { return route; },
    },
    {},
    runtimeGuard,
    {},
    "saved-secret",
    null,
    route.requestedModelId,
    structuredClone(DEFAULT_CONFIG),
  );
  runtime.adoptCredentialActivation(route, true, "saved-secret");

  let releaseSecondRun!: () => void;
  let announceSecondRun!: () => void;
  const secondRunEntered = new Promise<void>((resolve) => { announceSecondRun = resolve; });
  const secondRun = runtime.runWithReadyRoute(async () => {
    announceSecondRun();
    await new Promise<void>((resolve) => { releaseSecondRun = resolve; });
  });
  await secondRunEntered;

  const rejected = Object.assign(new Error("fixed authentication rejection"), {
    code: "provider-authentication-rejected",
  });
  await assert.rejects(
    runtime.runWithReadyRoute(async () => { throw rejected; }),
    (error: unknown) => error === rejected,
  );
  assert.equal(reconnects, 0, "busy recovery must not inspect or reconnect");
  assert.deepEqual(runtime.currentSessionRoute(), route, "busy recovery must not clear the route");

  releaseSecondRun();
  await secondRun;
  await assert.rejects(
    runtime.runWithReadyRoute(async () => { throw rejected; }),
    (error: unknown) => error === rejected,
  );
  assert.equal(reconnects, 1, "idle recovery may reconnect under exclusive ownership");
  assert.deepEqual(runtime.currentSessionRoute(), route);
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
      addMessage: (_level, text) => calls.push(`voice:message:${text.includes("Transcription failed")}`),
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

test("voice transcription reports a failed transcribe.js load as its normal error state, not a crash", async () => {
  // Phase 7 (E-WEIGHT-01): transcribe.js now loads via dynamic import() only
  // once transcription is actually requested. `loadTranscribe` replaces
  // that import for the test; the sibling test above always supplies a
  // `transcribe` fake, which bypasses this loader entirely, so this is the
  // only test that exercises it failing.
  const transcribeAndInsert = (cliModule as typeof cliModule & {
    transcribeAndInsert?: (
      ui: {
        setStatus(value: string): void;
        addMessage(level: string, text: string, label?: string): void;
        insertInputText(text: string): void;
      },
      context: Record<string, unknown>,
      audio: { path: string; format: "wav"; sizeBytes: number; durationMs: number; quiet: boolean },
      dependencies: { loadTranscribe(): Promise<never> },
    ) => Promise<void>;
  }).transcribeAndInsert;
  assert.equal(typeof transcribeAndInsert, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-voice-load-failure-"));
  const audioPath = join(directory, "voice.wav");
  await writeFile(audioPath, "synthetic audio");
  const calls: string[] = [];
  const providerRuntime = {
    async runWithReadyRoute<T>(run: () => Promise<T>) {
      return run();
    },
  };

  await transcribeAndInsert!(
    {
      setStatus: () => calls.push("voice:status"),
      addMessage: (_level, text) => calls.push(`voice:message:${text.includes("Transcription failed")}`),
      insertInputText: () => calls.push("voice:insert"),
    },
    {
      providerRuntime,
      openRouter: { safeMessage: () => "fixed-safe-load-error" },
      config: { transcriptionModel: "vendor/audio" },
      session: { addCost: () => undefined, save: async () => undefined },
    },
    { path: audioPath, format: "wav", sizeBytes: 15, durationMs: 100, quiet: false },
    { loadTranscribe: async () => { throw new Error("simulated broken install: transcribe.js could not be loaded"); } },
  );

  // No throw out of transcribeAndInsert itself, and exactly the same
  // user-visible failure message a rejected model call would produce —
  // never a raw stack trace or an unhandled rejection.
  assert.deepEqual(calls, ["voice:status", "voice:message:true"]);
});

test("a failed voice.js cleanup load never masks a successful transcription, and never crashes", async () => {
  // Fix round (review of task-7-report.md): the finally-block cleanup load
  // was the one lazy seam left unguarded. deleteRecordedAudio itself is
  // already a silent best-effort catch (voice.ts: `rm(...).catch(() => {})`)
  // — this proves a failed *load* of that cleanup gets the identical
  // silent-swallow treatment, never surfacing as an error and never masking
  // (or following) the real, already-successful transcription outcome.
  const transcribeAndInsert = (cliModule as typeof cliModule & {
    transcribeAndInsert?: (
      ui: {
        setStatus(value: string): void;
        addMessage(level: string, text: string, label?: string): void;
        insertInputText(text: string): void;
      },
      context: Record<string, unknown>,
      audio: { path: string; format: "wav"; sizeBytes: number; durationMs: number; quiet: boolean },
      dependencies: {
        transcribe(): Promise<{ text: string; costUsd: number; model: string }>;
        loadVoiceForCleanup(): Promise<never>;
      },
    ) => Promise<void>;
  }).transcribeAndInsert;
  assert.equal(typeof transcribeAndInsert, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-voice-cleanup-load-failure-"));
  const audioPath = join(directory, "voice.wav");
  await writeFile(audioPath, "synthetic audio");
  const calls: string[] = [];
  const providerRuntime = {
    async runWithReadyRoute<T>(run: () => Promise<T>) {
      return run();
    },
  };

  try {
    await transcribeAndInsert!(
      {
        setStatus: () => calls.push("voice:status"),
        addMessage: (_level, text) => calls.push(`voice:message:${text}`),
        insertInputText: (text) => calls.push(`voice:insert:${text}`),
      },
      {
        providerRuntime,
        openRouter: { safeMessage: () => "unused" },
        config: { transcriptionModel: "vendor/audio" },
        session: { addCost: () => calls.push("voice:cost"), save: async () => calls.push("voice:save") },
      },
      { path: audioPath, format: "wav", sizeBytes: 15, durationMs: 100, quiet: false },
      {
        transcribe: async () => ({ text: "hallo welt", costUsd: 0.01, model: "vendor/audio" }),
        loadVoiceForCleanup: async () => {
          throw new Error("simulated broken install: voice.js could not be loaded for cleanup");
        },
      },
    );
  } finally {
    // The mocked cleanup loader never ran the real deleteRecordedAudio, so
    // (unlike the sibling tests above) this temp directory is not
    // self-cleaning — remove it explicitly.
    await rm(directory, { recursive: true, force: true });
  }

  // The successful transcription's own effects land exactly as they would
  // with a working cleanup path — insert, success message, cost booked —
  // and nothing past that (no error message, no second notice) leaks in
  // from the failed cleanup load.
  assert.deepEqual(calls, [
    "voice:status",
    "voice:insert:hallo welt",
    "voice:message:Recognized: \"hallo welt\" — now in the input line.",
    "voice:cost",
    "voice:save",
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

test("the dashboard's first frame is never behind the startup provider inspection", async () => {
  // FIX-16/3: `inspectStartup` reaches the network (a live GET /key measured
  // 531ms, its own timeouts allow 5-8s). The frame must be up while that is
  // still in flight, and until it lands the dashboard must be handed a
  // pending answer rather than a value that would claim a checked state.
  const calls: string[] = [];
  const route = bootstrapRoute();
  let releaseInspection!: () => void;
  const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const runtime = {
    ...bootstrapRuntime({ events: calls }),
    async inspectStartup() {
      calls.push("provider:inspect:start");
      await inspectionGate;
      calls.push("provider:inspect:settled");
      return {
        mode: "ready",
        generation: 1,
        defaultRoute: route,
        readyRoutes: [route],
        warnings: [],
        crossEnabled: false,
      };
    },
  };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    const exitCode = await invokeRunCli([], {
      initializeStorage: async () => bootstrapStorage(),
      createProviderRuntime: async () => runtime,
      createAgent: async () => { calls.push("agent:create"); return {} as never; },
      runPlain: async () => { throw new Error("the dashboard path was expected"); },
      runDashboard: async (input: { setupRequired: boolean | (() => Promise<boolean>) }) => {
        // Stands in for the real `ui.start()`: the frame exists from here on.
        calls.push("frame");
        assert.equal(
          typeof input.setupRequired,
          "function",
          "an unchecked provider must reach the frame as a pending answer, never as a boolean",
        );
        releaseInspection();
        const setupRequired = await (input.setupRequired as () => Promise<boolean>)();
        calls.push(`setup-required:${setupRequired}`);
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    assert.equal(exitCode, 0);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
  assert.deepEqual(calls, [
    "provider:inspect:start",
    "frame",
    "provider:inspect:settled",
    "setup-required:false",
  ]);
});

test("a startup inspection that fails behind the frame surfaces at the dashboard, not at launch", async () => {
  const calls: string[] = [];
  const runtime = {
    ...bootstrapRuntime({ events: calls }),
    async inspectStartup(): Promise<Record<string, unknown>> {
      calls.push("provider:inspect");
      throw new Error("provider unreachable");
    },
  };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    const exitCode = await invokeRunCli([], {
      initializeStorage: async () => bootstrapStorage(),
      createProviderRuntime: async () => runtime,
      createAgent: async () => ({} as never),
      runPlain: async () => { throw new Error("the dashboard path was expected"); },
      runDashboard: async (input: { setupRequired: boolean | (() => Promise<boolean>) }) => {
        calls.push("frame");
        await assert.rejects(
          (input.setupRequired as () => Promise<boolean>)(),
          /provider unreachable/,
          "the failure reaches whoever asks, it never becomes an unhandled rejection",
        );
        calls.push("handled");
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    assert.equal(exitCode, 0);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
  assert.deepEqual(calls, ["provider:inspect", "frame", "handled"]);
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
  // FIX-18 (F8): the human line carries no raw token code — the audit's
  // "blocked path prints raw token codes" finding. `--json` keeps the typed
  // code (the test below pins that).
  assert.match(stderr[0] ?? "", /No provider is set up — run \/provider setup in an interactive session\./);
  assert.doesNotMatch(stderr[0] ?? "", /provider-setup-required/);
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
    "provider:ensure",
    "agent:create",
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
  assert.equal(await surface.chooseHub([hubEntry("cross-prepare"), hubEntry("cross-later")]), null);
  assert.equal(await surface.readSecret({ backendId: "openrouter", message: "forbidden" }), null);
  assert.equal(await surface.confirm({ id: "forbidden", message: "forbidden", defaultValue: true }), false);
});

test("the zero-touch environment fast path can actually resolve the shipped default model", async () => {
  // FIX-13: this path was dead for every fresh install. It asks for an exact
  // match on `config.mainModel`, which defaults to `openrouter/auto`, and then
  // applied a literal textInput/textOutput/tools check — but OpenRouter's
  // catalog entry for the automatic router declares none of the three, so the
  // filter could never return it and setup fell back to prompting.
  const createSurface = (cliModule as typeof cliModule & {
    createAutomaticEnvironmentSetupSurface?: (model: string) => {
      chooseModel(request: { models: Array<Record<string, unknown>> }): Promise<string | null>;
    };
  }).createAutomaticEnvironmentSetupSurface;
  assert.equal(typeof createSurface, "function");
  const automatic = {
    backendId: "openrouter" as const,
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    displayName: "Auto",
    capabilities: { textInput: false, textOutput: false, tools: false, reasoning: false },
  };
  const capable = {
    backendId: "openrouter" as const,
    requestedModelId: "vendor/exact",
    canonicalModelId: "vendor/exact-canonical",
    displayName: "Exact",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };

  assert.equal(DEFAULT_CONFIG.mainModel, automatic.requestedModelId, "the shipped default is the automatic route");
  const surface = createSurface!(DEFAULT_CONFIG.mainModel);
  assert.equal(
    await surface.chooseModel({ backendId: "openrouter", models: [capable, automatic] }),
    automatic.canonicalModelId,
  );

  // The exception is the automatic route alone — a model that genuinely
  // cannot do the main role is still refused, silently and without a prompt.
  const incapable = { ...automatic, requestedModelId: "vendor/no-text", canonicalModelId: "vendor/no-text" };
  assert.equal(
    await createSurface!("vendor/no-text").chooseModel({ backendId: "openrouter", models: [incapable] }),
    null,
  );
});

test("banner, help, and version derive from the same package metadata", () => {
  const version = readPackageVersion();
  assert.equal(version, "0.7.0");
  assert.match(renderCliBanner("/tmp/workspace", "provider/model"), new RegExp(`orcode ${version}`));
  assert.match(renderCliHelp(), new RegExp(`orcode ${version}`));
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /orcode 0\.3/);
});

test("CLI help states only the implemented Windows and override shell contract", () => {
  const help = renderCliHelp();
  assert.match(help, /Windows.*powershell\.exe.*-NoProfile.*-NonInteractive.*-Command/is);
  assert.match(help, /ORCODE_SHELL/);
  assert.match(help, /ROUTERCODE_SHELL.*compatibilit/i);
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
        return { id, displayName: "Anthropic / Claude subscription", maturity: "coming-soon" };
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
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "connection-1",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
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
  assert.equal(requireKeychainCredentialPointer(stateStore.read().connections[0]!), slot);
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
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
  assert.equal(
    requireKeychainCredentialPointer(legacyState.read().connections[0]!),
    "legacy:inference",
  );
  assert.equal(legacyState.read().connections[0]?.enabled, false);
  assert.equal(legacyState.read().defaultRoute, null);
});

function providerCommandReviewFixture(options: {
  state?: ProviderSetupStateV3;
  route?: NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const slot = "v1:inference:11111111-1111-4111-8111-111111111119";
  const initial = options.state ?? {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "review-connection-1",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  } satisfies ProviderSetupStateV3;
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  session.setPreferences(oldRoute.requestedModelId, { mode: "auto" }, oldRoute);
  const nextRoute = {
    ...bootstrapRoute("vendor/new-account"),
    accountFingerprint: "acct_new_session_222222",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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

function setupDeadlineRuntimeFixture(options: {
  saved?: boolean;
  candidateAuthority?: boolean;
} = {}) {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(
        surface: SetupSurface,
        attempt?: {
          generation: number;
          deadlineAt: number;
          signal: AbortSignal;
          remainingMs(): number;
          assertCurrent(): void;
        },
      ): Promise<Record<string, unknown>>;
    };
  }).DefaultProviderRuntime;
  const model: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/deadline-main",
    canonicalModelId: "vendor/deadline-main",
    displayName: "Deadline main",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const route = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_deadline_fixture_111111",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  const connection: ProviderConnectionStateV3 = {
    id: "deadline-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:91919191-9191-4191-8191-919191919191" },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const initial: ProviderSetupStateV3 = options.saved
    ? {
        schemaVersion: 3,
        revision: 0,
        lifecycle: "configured",
        connections: [connection],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }
    : structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const stateStore = new ProviderStateStore(initial);
  const deadlines = {
    preflight: [] as number[],
    candidateAuthority: [] as number[],
    credentialAuthority: [] as number[],
    connect: [] as number[],
    activation: [] as number[],
  };
  const contactObservedAt = {
    preflight: [] as number[],
    candidateAuthority: [] as number[],
    credentialAuthority: [] as number[],
  };
  const providerEffects: string[] = [];
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async discardCandidate() { providerEffects.push("discard"); },
    async connect(request) {
      providerEffects.push("connect");
      deadlines.connect.push(request.deadlineAt);
      return {
        candidateId: "deadline-candidate",
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
          generation: request.generation,
        },
      };
    },
    async listModels() {
      providerEffects.push("models");
      return [model];
    },
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
  const activationCoordinator = {
    async activate(request: { deadlineAt: number; persistence: "persisted" | "process-only" }) {
      providerEffects.push("activate");
      deadlines.activation.push(request.deadlineAt);
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [connection],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }, previous.revision);
      return {
        persisted: request.persistence === "persisted",
        warnings: [],
        state,
        route,
      };
    },
  };
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: activationCoordinator as never,
  });
  const candidatePermit = Object.freeze({ version: 1 as const });
  const credentialAuthority: Record<string, unknown> = {
    async preflightCandidate(request: { deadlineAt: number }) {
      providerEffects.push("preflight");
      contactObservedAt.preflight.push(Date.now());
      deadlines.preflight.push(request.deadlineAt);
      return { kind: "ready" as const };
    },
    async withCredential<T>(
      request: { deadlineAt: number },
      use: (secret: string, context: Record<string, unknown>) => Promise<T>,
    ) {
      providerEffects.push("credential-authority");
      contactObservedAt.credentialAuthority.push(Date.now());
      deadlines.credentialAuthority.push(request.deadlineAt);
      const value = await use("sk-or-v1-saved-deadline-key", {
        source: "saved",
        binding: {
          connectionId: connection.id,
          stateRevision: stateStore.read().revision,
        },
        candidatePermit,
        async publishIfCurrent(publish: () => void) { publish(); },
      });
      return { kind: "available" as const, value };
    },
  };
  if (options.candidateAuthority) {
    credentialAuthority.withCandidateAuthority = async <T>(
      request: { deadlineAt: number },
      use: (lease: { assertHeld(): Promise<void>; assertCurrent(): Promise<void> }) => Promise<T>,
    ) => {
      providerEffects.push("candidate-authority");
      contactObservedAt.candidateAuthority.push(Date.now());
      deadlines.candidateAuthority.push(request.deadlineAt);
      const lease = {
        async assertHeld() {},
        async assertCurrent() {},
      };
      return { kind: "ready" as const, value: await use(lease) };
    };
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new Runtime(
    new OpenRouterService(undefined),
    {} as CredentialStore,
    registry,
    stateStore,
    orchestrator,
    activationCoordinator,
    { beginRun() { return () => undefined; } },
    {},
    options.saved ? "sk-or-v1-saved-deadline-key" : null,
    null,
    model.requestedModelId,
    config,
    undefined,
    {
      credentialAuthority,
      adapter,
      async recover() {},
    },
  );
  return { runtime, model, deadlines, contactObservedAt, providerEffects };
}

type DesktopSetupDeferredStage =
  | "secret"
  | "credential"
  | "preflight"
  | "connect"
  | "catalog"
  | "outer";

function deferredValue<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function sameDesktopSetupRoute(left: RouteIdentityV1 | null, right: RouteIdentityV1): boolean {
  return left !== null
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function desktopSetupAbortRuntimeFixture(options: {
  initialRoute?: boolean;
  deferredStage?: DesktopSetupDeferredStage;
  outerFailure?: boolean;
  firstCredentialRejected?: boolean;
} = {}) {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      readonly preparedRoles: unknown;
      runDesktopOpenRouterSetup(surface: SetupSurface, signal: AbortSignal): Promise<Record<string, unknown>>;
      desktopOnboardingAuthority(): {
        snapshot(): {
          revision: number;
          generation: number;
          activeRoute: { routeHandle: string } | null;
        };
      };
      reconcileDesktopOpenRouterSetupCommit(settlement: unknown): {
        routeHandle: string;
        revision: number;
        generation: number;
      } | null;
      adoptCredentialActivation(route: RouteIdentityV1, persisted: boolean, secret: string): void;
    };
  }).DefaultProviderRuntime;
  const accountFingerprint = "acct_desktop_abort_owner_111111";
  const competitorFingerprint = "acct_desktop_abort_competitor_222222";
  const modelB: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: "vendor/desktop-b",
    canonicalModelId: "vendor/desktop-b",
    displayName: "Desktop B",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
  const route = (modelId: string, fingerprint = accountFingerprint): RouteIdentityV1 => ({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: fingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: modelId,
    canonicalModelId: modelId,
    resolutionState: "resolved",
  });
  const routeA = route("vendor/desktop-a");
  const routeB = route(modelB.requestedModelId);
  const routeC = route("vendor/desktop-c", competitorFingerprint);
  const connection = (
    id: string,
    fingerprint: string,
    credentialPointer: string,
  ): ProviderConnectionStateV3 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: credentialPointer },
    accountFingerprint: fingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "available",
      runtime: "ready",
      observedAt: 1,
      generation: 11,
    },
  });
  const connectionA = connection(
    "desktop-abort-owner",
    accountFingerprint,
    "v1:inference:11111111-aaaa-4111-8111-111111111111",
  );
  const connectionC = connection(
    "desktop-abort-competitor",
    competitorFingerprint,
    "v1:inference:22222222-bbbb-4222-8222-222222222222",
  );
  const initial: ProviderSetupStateV3 = options.initialRoute
    ? {
        schemaVersion: 3,
        revision: 0,
        lifecycle: "configured",
        connections: [connectionA, connectionC],
        defaultRoute: routeA,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }
    : structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const stateStore = new ProviderStateStore(initial);
  let providerGeneration = 11;
  let activationCalls = 0;
  let cancelCalls = 0;
  let connectCalls = 0;
  let catalogCalls = 0;
  let discardCalls = 0;
  let publicHubCalls = 0;
  let kimiEffects = 0;
  let credentialAbortListeners = 0;
  let rejectedOnce = false;
  let deferredSignal: AbortSignal | null = null;
  const stageReached = deferredValue<void>();
  const stageRelease = deferredValue<void>();
  const stageReleaseObserved = deferredValue<void>();
  const enterDeferredStage = async (stage: DesktopSetupDeferredStage, signal?: AbortSignal) => {
    if (options.deferredStage !== stage) return;
    deferredSignal = signal ?? null;
    stageReached.resolve();
    await stageRelease.promise;
    stageReleaseObserved.resolve();
  };
  const enterAbortRacedCredentialStage = (signal: AbortSignal): Promise<void> => {
    if (options.deferredStage !== "credential") return Promise.resolve();
    deferredSignal = signal;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        credentialAbortListeners -= 1;
        settle();
      };
      const onAbort = () => finish(() => reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Desktop credential access was aborted.", "AbortError"),
      ));
      credentialAbortListeners += 1;
      signal.addEventListener("abort", onAbort, { once: true });
      stageRelease.promise.then(
        () => {
          stageReleaseObserved.resolve();
          finish(resolve);
        },
        (error: unknown) => {
          stageReleaseObserved.resolve();
          finish(() => reject(error));
        },
      );
      stageReached.resolve();
      if (signal.aborted) onAbort();
    });
  };
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused"); },
    async reconnect() { throw new Error("unused"); },
    async logout() {},
    async discardCandidate() { discardCalls += 1; },
    async connect(request) {
      connectCalls += 1;
      await enterDeferredStage("connect", request.signal);
      const rejected = options.firstCredentialRejected === true && !rejectedOnce;
      rejectedOnce = true;
      return {
        candidateId: `desktop-abort-candidate-${connectCalls}`,
        backendId: "openrouter",
        connectionId: connectionA.id,
        accountFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: rejected ? "rejected" as const : "valid" as const,
          connectivity: "connected" as const,
          spend: "available" as const,
          runtime: "ready" as const,
          observedAt: 1,
          generation: request.generation,
        },
      };
    },
    async listModels(request) {
      catalogCalls += 1;
      await enterDeferredStage("catalog", request.signal);
      return [modelB];
    },
    async activate() { throw new Error("unused"); },
  };
  const kimiAdapter: BackendAdapter = {
    backendId: "kimi-code",
    async inspect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async reconnect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async logout() { kimiEffects += 1; },
    async connect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async listModels() { kimiEffects += 1; return []; },
    async activate() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async discardCandidate() { kimiEffects += 1; },
  };
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: kimiAdapter },
  ]);
  const orchestrator = {
    currentGeneration: () => providerGeneration,
    nextStartupGeneration: () => providerGeneration + 1,
    async activateCandidate() {
      activationCalls += 1;
      const before = stateStore.read();
      const state = stateStore.replace({
        ...before,
        lifecycle: "configured",
        connections: [connectionA, connectionC],
        defaultRoute: routeB,
      }, before.revision);
      providerGeneration += 1;
      return { persisted: true, route: structuredClone(routeB), state, warnings: [] };
    },
    async cancelSetup(request: { expectedRevision?: number }) {
      cancelCalls += 1;
      const before = stateStore.read();
      if (request.expectedRevision === before.revision) {
        stateStore.replace({ ...before, lifecycle: "cancelled" }, before.revision);
      }
      return { mode: "setup-required", generation: providerGeneration };
    },
    ensureRunnableRoute(requested?: RouteIdentityV1) {
      const state = stateStore.read();
      const current = requested ?? state.defaultRoute;
      if (!current || !sameDesktopSetupRoute(state.defaultRoute, current)) {
        throw new ProviderSetupRequiredError();
      }
      const owners = state.connections.filter((candidate) => candidate.enabled
        && candidate.backendId === current.backendId
        && candidate.accountFingerprint === current.accountFingerprint
        && candidate.billingRealm === current.billingRealm);
      if (owners.length !== 1) throw new ProviderSetupRequiredError();
      return structuredClone(current);
    },
  };
  const credentialAuthority = {
    async preflightCandidate(request: { signal: AbortSignal }) {
      await enterDeferredStage("preflight", request.signal);
      if (request.signal.aborted) throw request.signal.reason;
      return { kind: "ready" as const };
    },
    async withCredential<T>(
      request: { signal: AbortSignal; connectionId: string },
      use: (secret: string, context: Record<string, unknown>) => Promise<T>,
    ) {
      await enterAbortRacedCredentialStage(request.signal);
      const value = await use("synthetic-retained-openrouter-secret", {
        source: "saved",
        binding: {
          connectionId: request.connectionId,
          stateRevision: stateStore.read().revision,
        },
        candidatePermit: { version: 1 },
        async publishIfCurrent(publish: () => void) { publish(); },
      });
      if (options.deferredStage === "outer") {
        await enterDeferredStage("outer", request.signal);
        if (options.outerFailure) {
          throw request.signal.reason instanceof Error
            ? request.signal.reason
            : new DOMException("Desktop setup was aborted.", "AbortError");
        }
      }
      return { kind: "available" as const, value };
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  config.mainModel = options.initialRoute ? routeA.requestedModelId : DEFAULT_CONFIG.mainModel;
  const session = SessionStore.create("/synthetic/desktop-setup-abort", "/synthetic/.orcode");
  if (options.initialRoute) session.setPreferences(routeA.requestedModelId, { mode: "auto" }, routeA);
  const runtime = new Runtime(
    new OpenRouterService(undefined),
    {} as CredentialStore,
    registry,
    stateStore,
    orchestrator,
    {},
    { beginRun() { return () => undefined; } },
    {},
    null,
    null,
    modelB.requestedModelId,
    config,
    session,
    {
      credentialAuthority,
      adapter,
      forgetJournal: {},
      async recover() {},
    },
  );
  const presentations: Array<{ type?: string; message?: string }> = [];
  let secretCalls = 0;
  const surface = (secretAnswers: readonly (string | null)[] = ["synthetic-openrouter-secret"]): SetupSurface => ({
    async chooseHub() {
      publicHubCalls += 1;
      return "kimi-code";
    },
    async readSecret() {
      secretCalls += 1;
      await enterDeferredStage("secret");
      return secretAnswers[Math.min(secretCalls - 1, secretAnswers.length - 1)] ?? null;
    },
    async chooseModel() { return modelB.canonicalModelId; },
    async confirm() { return true; },
    present(event) { presentations.push(structuredClone(event)); },
  });
  return {
    runtime,
    stateStore,
    config,
    session,
    surface,
    routeA,
    routeB,
    routeC,
    waitForDeferredStage: () => stageReached.promise,
    releaseDeferredStage: () => stageRelease.resolve(),
    waitForDeferredReleaseObserved: () => stageReleaseObserved.promise,
    get deferredSignal() { return deferredSignal; },
    get credentialAbortListeners() { return credentialAbortListeners; },
    get activationCalls() { return activationCalls; },
    get cancelCalls() { return cancelCalls; },
    get connectCalls() { return connectCalls; },
    get catalogCalls() { return catalogCalls; },
    get discardCalls() { return discardCalls; },
    get publicHubCalls() { return publicHubCalls; },
    get kimiEffects() { return kimiEffects; },
    get presentations() { return presentations; },
    publishCompetitor() {
      const before = stateStore.read();
      stateStore.replace({
        ...before,
        lifecycle: "configured",
        connections: [connectionA, connectionC],
        defaultRoute: routeC,
      }, before.revision);
      providerGeneration += 1;
      runtime.adoptCredentialActivation(routeC, true, "synthetic-competitor-secret");
    },
    publishProcessCompetitor() {
      runtime.adoptCredentialActivation(routeC, true, "synthetic-process-competitor-secret");
    },
    advanceProviderGeneration() { providerGeneration += 1; },
    advanceProviderRevision() {
      const before = stateStore.read();
      stateStore.replace({ ...before }, before.revision);
    },
  };
}

async function assertSettlesByNextTurn<T>(pending: Promise<T>): Promise<T> {
  const notSettled = Symbol("not-settled");
  const outcome = await Promise.race([
    pending,
    new Promise<typeof notSettled>((resolve) => setImmediate(() => resolve(notSettled))),
  ]);
  assert.notEqual(outcome, notSettled, "the aborted Desktop setup must settle without its late dependency");
  return outcome as T;
}

function instrumentAbortListeners(signal: AbortSignal) {
  const target = signal as AbortSignal & {
    addEventListener: AbortSignal["addEventListener"];
    removeEventListener: AbortSignal["removeEventListener"];
  };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const listeners = new Set<EventListenerOrEventListenerObject>();
  target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) => {
    if (type === "abort" && listener) listeners.add(listener);
    add(type, listener as EventListenerOrEventListenerObject, options);
  }) as AbortSignal["addEventListener"];
  target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
    if (type === "abort" && listener) listeners.delete(listener);
    remove(type, listener as EventListenerOrEventListenerObject, options);
  }) as AbortSignal["removeEventListener"];
  return {
    count: () => listeners.size,
    restore() {
      target.addEventListener = add as AbortSignal["addEventListener"];
      target.removeEventListener = remove as AbortSignal["removeEventListener"];
    },
  };
}

test("Desktop setup adopts exact B when its durable activation wins before caller abort", async () => {
  for (const outerFailure of [false, true]) {
    const fixture = desktopSetupAbortRuntimeFixture({
      initialRoute: true,
      deferredStage: "outer",
      outerFailure,
    });
    const controller = new AbortController();
    const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface(), controller.signal);

    await fixture.waitForDeferredStage();
    controller.abort(new DOMException("window closed after commit", "AbortError"));
    fixture.releaseDeferredStage();
    const result = await pending;
    const snapshot = fixture.runtime.desktopOnboardingAuthority().snapshot();

    assert.deepEqual(result, { kind: "ready" }, `outerFailure=${outerFailure}`);
    assert.deepEqual(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(result), {
      routeHandle: snapshot.activeRoute?.routeHandle,
      revision: snapshot.revision,
      generation: snapshot.generation,
    }, `outerFailure=${outerFailure}`);
    assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(result), null, `outerFailure=${outerFailure}`);
    assert.deepEqual(fixture.stateStore.read().defaultRoute, fixture.routeB);
    assert.deepEqual(fixture.session.data.route, fixture.routeB);
    assert.equal(fixture.config.mainModel, fixture.routeB.requestedModelId);
    assert.equal(fixture.activationCalls, 1);
    assert.equal(fixture.publicHubCalls, 0);
  }
});

test("Desktop setup settlement proof is exact public-only and consumed once", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({ initialRoute: true });
  const result = await fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface(),
    new AbortController().signal,
  );
  const snapshotBeforeReconcile = fixture.runtime.desktopOnboardingAuthority().snapshot();

  assert.deepEqual(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(result), {
    routeHandle: snapshotBeforeReconcile.activeRoute?.routeHandle,
    revision: snapshotBeforeReconcile.revision,
    generation: snapshotBeforeReconcile.generation,
  });
  assert.deepEqual(
    fixture.runtime.desktopOnboardingAuthority().snapshot(),
    snapshotBeforeReconcile,
    "reconciling an already-published success must not publish the route twice",
  );
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(result), null);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit("foreign primitive settlement"), null);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(null), null);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(undefined), null);
});

test("Desktop setup proof rejects a later exact competitor without restoring its old route", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({ initialRoute: true });
  const settlement = await fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface(),
    new AbortController().signal,
  );

  fixture.publishCompetitor();

  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement), null);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement), null);
  assert.deepEqual(fixture.session.data.route, fixture.routeC);
  assert.equal(fixture.config.mainModel, fixture.routeC.requestedModelId);
});

test("Desktop setup proof rejects same-epoch foreign process-route ownership", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({
    initialRoute: true,
    deferredStage: "outer",
    outerFailure: true,
  });
  const pending = fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface(),
    new AbortController().signal,
  );

  await fixture.waitForDeferredStage();
  const stateAtCommit = fixture.stateStore.read();
  const providerEpochAtCommit = fixture.runtime.desktopOnboardingAuthority().snapshot();
  fixture.publishProcessCompetitor();
  const preparedRolesAfterDrift = fixture.runtime.preparedRoles;
  fixture.releaseDeferredStage();
  const settlement = await pending.then(
    () => assert.fail("the synthetic outer boundary must throw"),
    (error: unknown) => error,
  );

  assert.deepEqual(fixture.stateStore.read(), stateAtCommit);
  assert.equal(
    fixture.runtime.desktopOnboardingAuthority().snapshot().revision,
    providerEpochAtCommit.revision,
  );
  assert.equal(
    fixture.runtime.desktopOnboardingAuthority().snapshot().generation,
    providerEpochAtCommit.generation,
  );
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement), null);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement), null);
  assert.deepEqual(fixture.session.data.route, fixture.routeC);
  assert.equal(fixture.config.mainModel, fixture.routeC.requestedModelId);
  assert.deepEqual(fixture.runtime.preparedRoles, preparedRolesAfterDrift);
});

test("Desktop setup throw proof publishes the exact committed route before reporting ready", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({
    initialRoute: true,
    deferredStage: "outer",
    outerFailure: true,
  });
  const pending = fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface(),
    new AbortController().signal,
  );

  await fixture.waitForDeferredStage();
  fixture.releaseDeferredStage();
  const settlement = await pending.then(
    () => assert.fail("the synthetic outer boundary must throw"),
    (error: unknown) => error,
  );

  assert.deepEqual(fixture.session.data.route, fixture.routeA);
  assert.equal(fixture.config.mainModel, fixture.routeA.requestedModelId);
  const proof = fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement);
  const snapshot = fixture.runtime.desktopOnboardingAuthority().snapshot();
  assert.deepEqual(proof, {
    routeHandle: snapshot.activeRoute?.routeHandle,
    revision: snapshot.revision,
    generation: snapshot.generation,
  });
  assert.deepEqual(fixture.session.data.route, fixture.routeB);
  assert.equal(fixture.config.mainModel, fixture.routeB.requestedModelId);
  assert.equal(fixture.runtime.reconcileDesktopOpenRouterSetupCommit(settlement), null);
});

test("Desktop credential abort settles before its late answer and removes every abort listener", async (t) => {
  const fixture = desktopSetupAbortRuntimeFixture({
    initialRoute: true,
    deferredStage: "credential",
  });
  const controller = new AbortController();
  const callerListeners = instrumentAbortListeners(controller.signal);
  t.after(() => callerListeners.restore());
  const stateBefore = fixture.stateStore.read();
  const sessionBefore = structuredClone(fixture.session.data);
  const configBefore = structuredClone(fixture.config);
  const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface(), controller.signal);
  const observed = pending.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await fixture.waitForDeferredStage();
  assert.equal(fixture.credentialAbortListeners, 1);
  controller.abort(new DOMException("window closed before commit", "AbortError"));
  const outcome = await assertSettlesByNextTurn(observed);

  assert.equal(outcome.kind, "rejected");
  assert.match(String(outcome.kind === "rejected" ? outcome.error : ""), /abort|closed/i);
  assert.equal(fixture.credentialAbortListeners, 0);
  assert.equal(callerListeners.count(), 0);
  assert.deepEqual(fixture.stateStore.read().defaultRoute, fixture.routeA);
  assert.deepEqual(fixture.session.data.route, fixture.routeA);
  assert.deepEqual(fixture.stateStore.read(), stateBefore);
  assert.deepEqual(fixture.session.data, sessionBefore);
  assert.deepEqual(fixture.config, configBefore);
  assert.equal(fixture.activationCalls, 0);
  assert.equal(fixture.publicHubCalls, 0);
  const presentationsAtSettlement = structuredClone(fixture.presentations);

  fixture.releaseDeferredStage();
  await fixture.waitForDeferredReleaseObserved();
  assert.deepEqual(fixture.stateStore.read(), stateBefore);
  assert.deepEqual(fixture.session.data, sessionBefore);
  assert.deepEqual(fixture.config, configBefore);
  assert.deepEqual(fixture.presentations, presentationsAtSettlement);
});

test("Desktop setup cannot claim a competing route publication after its own commit", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({
    initialRoute: true,
    deferredStage: "outer",
    outerFailure: true,
  });
  const controller = new AbortController();
  const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface(), controller.signal);

  await fixture.waitForDeferredStage();
  fixture.publishCompetitor();
  controller.abort(new DOMException("window closed after competing commit", "AbortError"));
  fixture.releaseDeferredStage();

  await assert.rejects(pending, /abort|closed/i);
  assert.deepEqual(fixture.stateStore.read().defaultRoute, fixture.routeC);
  assert.deepEqual(fixture.session.data.route, fixture.routeC);
  assert.equal(fixture.config.mainModel, fixture.routeC.requestedModelId);
});

test("Desktop setup rejects stale commit revision or provider generation even when route B still matches", async () => {
  for (const interference of ["provider-revision", "provider-generation"] as const) {
    const fixture = desktopSetupAbortRuntimeFixture({
      initialRoute: true,
      deferredStage: "outer",
      outerFailure: true,
    });
    const controller = new AbortController();
    const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface(), controller.signal);

    await fixture.waitForDeferredStage();
    if (interference === "provider-revision") fixture.advanceProviderRevision();
    else fixture.advanceProviderGeneration();
    controller.abort(new DOMException(`window closed after ${interference}`, "AbortError"));
    fixture.releaseDeferredStage();

    await assert.rejects(pending, /abort|closed/i, interference);
    assert.deepEqual(fixture.stateStore.read().defaultRoute, fixture.routeB, interference);
    assert.deepEqual(fixture.session.data.route, fixture.routeA, interference);
    assert.equal(fixture.config.mainModel, fixture.routeA.requestedModelId, interference);
  }
});

test("Desktop setup aborts secret, preflight, connect, and catalog waits without late mutation", async () => {
  for (const stage of ["secret", "preflight", "connect", "catalog"] as const) {
    const fixture = desktopSetupAbortRuntimeFixture({ deferredStage: stage });
    const controller = new AbortController();
    const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface(), controller.signal);

    await fixture.waitForDeferredStage();
    controller.abort(new DOMException(`window closed during ${stage}`, "AbortError"));
    const result = await assertSettlesByNextTurn(pending);
    const stateAtSettlement = fixture.stateStore.read();
    const sessionAtSettlement = structuredClone(fixture.session.data);
    fixture.releaseDeferredStage();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" }, stage);
    assert.deepEqual(fixture.stateStore.read(), stateAtSettlement, stage);
    assert.deepEqual(fixture.session.data, sessionAtSettlement, stage);
    assert.equal(fixture.session.data.route, undefined, stage);
    assert.equal(fixture.activationCalls, 0, stage);
    assert.equal(fixture.publicHubCalls, 0, stage);
    if (stage !== "secret") assert.equal(fixture.deferredSignal?.aborted, true, stage);
  }
});

test("Desktop OpenRouter retry and Secret-Back never consult a malicious public Kimi chooser", async () => {
  const fixture = desktopSetupAbortRuntimeFixture({ firstCredentialRejected: true });
  const controller = new AbortController();

  const result = await fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface(["synthetic-rejected-secret", null]),
    controller.signal,
  );

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.equal(fixture.connectCalls, 1);
  assert.equal(fixture.catalogCalls, 0);
  assert.equal(fixture.publicHubCalls, 0);
  assert.equal(fixture.kimiEffects, 0);
  assert.equal(
    fixture.presentations.some((event) => event.type === "notice" && /could not validate/i.test(event.message ?? "")),
    true,
  );
  assert.equal(
    fixture.presentations.some((event) => event.type === "notice" && /Setup cancelled/i.test(event.message ?? "")),
    true,
  );
});

test("repeated Desktop setup success and cancellation remove caller listeners", async () => {
  for (const outcome of ["success", "cancel", "success", "cancel"] as const) {
    const fixture = desktopSetupAbortRuntimeFixture();
    const controller = new AbortController();
    const listeners = instrumentAbortListeners(controller.signal);
    try {
      const result = await fixture.runtime.runDesktopOpenRouterSetup(
        fixture.surface(outcome === "success" ? ["synthetic-success-secret"] : [null]),
        controller.signal,
      );
      assert.equal(result.kind, outcome === "success" ? "ready" : "cancelled", outcome);
      assert.equal(listeners.count(), 0, outcome);
    } finally {
      listeners.restore();
    }
  }
});

test("manual setup starts one provider deadline only after secret input and reuses it", async () => {
  const fixture = setupDeadlineRuntimeFixture();
  let releaseHub!: (selection: string) => void;
  let hubReached!: () => void;
  const reachedHub = new Promise<void>((resolve) => { hubReached = resolve; });
  const hubSelection = new Promise<string>((resolve) => { releaseHub = resolve; });
  let releaseSecret!: (secret: string) => void;
  let secretReached!: () => void;
  const reachedSecret = new Promise<void>((resolve) => { secretReached = resolve; });
  const secret = new Promise<string>((resolve) => { releaseSecret = resolve; });
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      if (hubCalls > 1) return "cross-later";
      hubReached();
      return hubSelection;
    },
    async readSecret() {
      secretReached();
      return secret;
    },
    async chooseModel() { return fixture.model.canonicalModelId; },
    async confirm() { return true; },
    present() {},
  };

  const pending = fixture.runtime.runSetup(surface);
  await reachedHub;
  const effectsBeforeHubSelection = [...fixture.providerEffects];
  releaseHub("openrouter");
  await reachedSecret;
  const effectsBeforeSecret = [...fixture.providerEffects];
  releaseSecret("sk-or-v1-manual-deadline-key");
  let testTimer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    pending,
    new Promise<Record<string, unknown>>((resolve) => {
      testTimer = setTimeout(() => resolve({
        kind: "test-timeout",
        effects: [...fixture.providerEffects],
      }), 500);
    }),
  ]);
  if (testTimer !== undefined) clearTimeout(testTimer);

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(effectsBeforeHubSelection, []);
  assert.deepEqual(effectsBeforeSecret, []);
  assert.equal(fixture.deadlines.preflight.length, 1);
  const deadlineAt = fixture.deadlines.preflight[0]!;
  const providerContactObservedAt = fixture.contactObservedAt.preflight[0]!;
  assert.ok(Number.isFinite(deadlineAt));
  assert.ok(deadlineAt > providerContactObservedAt);
  assert.ok(deadlineAt - providerContactObservedAt <= 15_000);
  assert.ok(deadlineAt - providerContactObservedAt >= 14_000);
  assert.deepEqual(fixture.deadlines.connect, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.activation, [deadlineAt]);
});

test("manual setup keeps delayed hub and secret input outside the old eight-second timer", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: 1_000_000,
  });
  const fixture = setupDeadlineRuntimeFixture();
  let releaseHub!: (selection: string) => void;
  let hubReached!: () => void;
  const reachedHub = new Promise<void>((resolve) => { hubReached = resolve; });
  const hubSelection = new Promise<string>((resolve) => { releaseHub = resolve; });
  let releaseSecret!: (secret: string) => void;
  let secretReached!: () => void;
  const reachedSecret = new Promise<void>((resolve) => { secretReached = resolve; });
  const secret = new Promise<string>((resolve) => { releaseSecret = resolve; });
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      if (hubCalls > 1) return "cross-later";
      hubReached();
      return hubSelection;
    },
    async readSecret() {
      secretReached();
      return secret;
    },
    async chooseModel() { return fixture.model.canonicalModelId; },
    async confirm() { return true; },
    present() {},
  };

  const pending = fixture.runtime.runSetup(surface);
  await reachedHub;
  t.mock.timers.tick(4_001);
  assert.deepEqual(fixture.providerEffects, []);
  releaseHub("openrouter");
  await reachedSecret;
  t.mock.timers.tick(4_001);
  assert.deepEqual(fixture.providerEffects, []);
  releaseSecret("sk-or-v1-delayed-manual-key");
  const result = await pending;

  assert.deepEqual(result, { kind: "ready" });
  const deadlineAt = fixture.deadlines.preflight[0];
  assert.equal(deadlineAt, 1_023_002);
  assert.deepEqual(fixture.deadlines.connect, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.activation, [deadlineAt]);
});

test("manual candidate authority reuses the exact lazily resolved deadline", async () => {
  const fixture = setupDeadlineRuntimeFixture({ candidateAuthority: true });
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : "cross-later";
    },
    async readSecret() { return "sk-or-v1-candidate-authority-deadline"; },
    async chooseModel() { return fixture.model.canonicalModelId; },
    async confirm() { return true; },
    present() {},
  };

  const result = await fixture.runtime.runSetup(surface);

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(fixture.deadlines.preflight, []);
  assert.equal(fixture.deadlines.candidateAuthority.length, 1);
  const deadlineAt = fixture.deadlines.candidateAuthority[0]!;
  const contactObservedAt = fixture.contactObservedAt.candidateAuthority[0]!;
  assert.ok(Number.isFinite(deadlineAt));
  assert.ok(deadlineAt > contactObservedAt);
  assert.ok(deadlineAt - contactObservedAt <= 15_000);
  assert.deepEqual(fixture.deadlines.connect, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.activation, [deadlineAt]);
});

test("manual saved credential authority shares one deadline with candidate contact and activation", async () => {
  const fixture = setupDeadlineRuntimeFixture({ saved: true, candidateAuthority: true });
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : "cross-later";
    },
    async readSecret() { throw new Error("saved setup must not prompt for a secret"); },
    async chooseModel() { return fixture.model.canonicalModelId; },
    async confirm() { throw new Error("saved setup must not ask to persist again"); },
    present() {},
  };

  const result = await fixture.runtime.runSetup(surface);

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(fixture.deadlines.credentialAuthority.length, 1);
  const deadlineAt = fixture.deadlines.credentialAuthority[0]!;
  assert.deepEqual(fixture.deadlines.preflight, []);
  assert.deepEqual(fixture.deadlines.candidateAuthority, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.connect, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.activation, [deadlineAt]);
});

test("startup setup preserves its supplied absolute deadline byte-identically", async () => {
  const fixture = setupDeadlineRuntimeFixture();
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : "cross-later";
    },
    async readSecret() { return "sk-or-v1-startup-deadline"; },
    async chooseModel() { return fixture.model.canonicalModelId; },
    async confirm() { return true; },
    present() {},
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + 10_000;

  const result = await fixture.runtime.runSetup(surface, {
    generation: 71,
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => deadlineAt - Date.now(),
    assertCurrent() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
  });

  assert.deepEqual(result, { kind: "ready" });
  assert.ok(fixture.deadlines.preflight.length >= 1);
  assert.equal(fixture.deadlines.preflight.every((value) => value === deadlineAt), true);
  assert.deepEqual(fixture.deadlines.connect, [deadlineAt]);
  assert.deepEqual(fixture.deadlines.activation, [deadlineAt]);
});

test("successful account setup settles ready without entering or publishing Cross preparation", async () => {
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
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
  const route = {
    ...bootstrapRoute(main.requestedModelId),
    accountFingerprint: "acct_cross_abort_111111",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const connection: ProviderConnectionStateV3 = {
    id: "cross-abort-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:15151515-1515-4151-8151-151515151515" },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  let durable = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  let crossPublicationCalls = 0;
  const stateStore = new ProviderStateStore(durable, {
    persist: async () => {
      crossPublicationCalls += 1;
      throw new Error("Account setup must not publish Cross preparation.");
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
    async listModels() { return [main]; },
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
      assert.equal(hubCalls, 0, "account setup must not request a second Cross choice");
      hubCalls += 1;
      return "openrouter";
    },
    async readSecret() { return "sk-or-v1-cross-abort-test"; },
    async chooseModel() {
      assert.equal(modelCalls, 0, "account setup must not request a Cross challenger");
      modelCalls += 1;
      return main.canonicalModelId;
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
  const result = await pending;

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(hubCalls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(crossPublicationCalls, 0);
  assert.deepEqual(stateStore.read(), durable);
  assert.deepEqual(stateStore.read().cross, {
    enabled: false,
    preferredLead: null,
    preferredChallenger: null,
  });
  assert.deepEqual(session.data.route, route);
  assert.equal(session.data.model, main.requestedModelId);
  assert.equal(config.mainModel, main.requestedModelId);
  assert.equal(runtime.preparedRoles, null);
  assert.equal(notices.some((message) => /Cross|challenger|prepared role/i.test(message)), false);
  assert.deepEqual(runtime.ensureRunnableRoute(), route);
});

test("setup postpublication abort waits for exact activation terminal reconciliation without cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-setup-postpublication-"));
  const configPath = join(root, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
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
    adapterResolver: () => adapter,
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
    providerSetup: ProviderSetupStateV3;
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
  assert.equal(active === undefined ? null : slots.get(requireKeychainCredentialPointer(active)), secret);
  assert.equal(presentations.length - presentationsAtAbort, 0);
});

async function desktopProcessOnlySetupFixture(options: {
  holdRuntimeActivation?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "orcode-setup-process-postpublication-"));
  const configPath = join(root, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
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
  let kimiEffects = 0;
  const kimiAdapter: BackendAdapter = {
    backendId: "kimi-code",
    async inspect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async reconnect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async logout() { kimiEffects += 1; },
    async connect() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async listModels() { kimiEffects += 1; return []; },
    async activate() { kimiEffects += 1; throw new Error("Kimi must remain unreachable"); },
    async discardCandidate() { kimiEffects += 1; },
  };
  const registry = new BackendRegistry([
    { descriptor, adapter },
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: kimiAdapter },
  ]);
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
    adapterResolver: () => adapter,
    stateStore,
    runtimeGuard,
    candidateAuthority: credentialAuthority,
    createUuid: () => `84848484-8484-4484-8484-${String(uuid++).padStart(12, "0")}`,
    onBoundary: async (boundary) => {
      if (boundary !== "runtime-activated") return;
      reachedRuntimeActivation();
      if (options.holdRuntimeActivation) await runtimeActivationRelease;
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
      runDesktopOpenRouterSetup(surface: SetupSurface, signal: AbortSignal): Promise<Record<string, unknown>>;
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
  let publicHubCalls = 0;
  let secretCalls = 0;
  let confirmCalls = 0;
  let modelCalls = 0;
  const presentations: unknown[] = [];
  const surface: SetupSurface = {
    async chooseHub() { publicHubCalls += 1; return "kimi-code"; },
    async readSecret() {
      secretCalls += 1;
      throw new Error("environment setup must not prompt for a secret");
    },
    async chooseModel() { modelCalls += 1; return model.canonicalModelId; },
    async confirm() {
      confirmCalls += 1;
      throw new Error("process-only setup must not ask for persistence");
    },
    present(event) { presentations.push(structuredClone(event)); },
  };
  return {
    root,
    runtime,
    surface,
    session,
    stateStore,
    config,
    initial,
    model,
    route,
    slots,
    presentations,
    runtimeActivationReached,
    releaseRuntimeActivation,
    async readDiskConfig() {
      return JSON.parse(await readFile(configPath, "utf8")) as typeof config;
    },
    get runtimeRoute() { return runtimeRoute; },
    get cancelCalls() { return cancelCalls; },
    get publicHubCalls() { return publicHubCalls; },
    get secretCalls() { return secretCalls; },
    get confirmCalls() { return confirmCalls; },
    get modelCalls() { return modelCalls; },
    get kimiEffects() { return kimiEffects; },
  };
}

test("Desktop process-only environment success adopts only the exact runtime route", async (t) => {
  const fixture = await desktopProcessOnlySetupFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const diskBefore = await fixture.readDiskConfig();
  const controller = new AbortController();

  const result = await fixture.runtime.runDesktopOpenRouterSetup(
    fixture.surface,
    controller.signal,
  );

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(fixture.runtimeRoute, fixture.route);
  assert.deepEqual(fixture.runtime.currentSessionRoute(), fixture.route);
  assert.deepEqual(fixture.session.data.route, fixture.route);
  assert.equal(fixture.session.data.model, fixture.model.requestedModelId);
  assert.equal(fixture.config.mainModel, fixture.model.requestedModelId);
  assert.deepEqual(fixture.stateStore.read(), fixture.initial);
  assert.deepEqual(fixture.config.providerSetup, fixture.initial);
  assert.deepEqual(await fixture.readDiskConfig(), diskBefore);
  assert.equal(fixture.slots.size, 0);
  assert.equal(fixture.publicHubCalls, 0);
  assert.equal(fixture.secretCalls, 0);
  assert.equal(fixture.confirmCalls, 0);
  assert.equal(fixture.modelCalls, 1);
  assert.equal(fixture.kimiEffects, 0);
});

test("Desktop process-only abort after runtime activation rejects without late publication", async (t) => {
  const fixture = await desktopProcessOnlySetupFixture({ holdRuntimeActivation: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const diskBefore = await fixture.readDiskConfig();
  const stateBefore = fixture.stateStore.read();
  const sessionBefore = structuredClone(fixture.session.data);
  const mainModelBefore = fixture.config.mainModel;
  const controller = new AbortController();
  const reason = new DOMException("desktop closed after process runtime activation", "AbortError");
  const pending = fixture.runtime.runDesktopOpenRouterSetup(fixture.surface, controller.signal);
  const observed = pending.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await fixture.runtimeActivationReached;
  assert.deepEqual(fixture.runtimeRoute, fixture.route);
  assert.equal(fixture.session.data.route, undefined);
  const presentationsAtAbort = fixture.presentations.length;
  controller.abort(reason);
  const stillPending = Symbol("still-pending");
  const early = await Promise.race([
    observed,
    new Promise<typeof stillPending>((resolve) => setImmediate(() => resolve(stillPending))),
  ]);
  assert.equal(early, stillPending, "the terminal activation wrapper must drain before rejection");
  assert.equal(fixture.cancelCalls, 0);

  fixture.releaseRuntimeActivation();
  const outcome = await observed;

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" ? outcome.error : null, reason);
  assert.deepEqual(fixture.runtimeRoute, fixture.route);
  assert.throws(() => fixture.runtime.currentSessionRoute(), ProviderSetupRequiredError);
  assert.deepEqual(fixture.session.data, sessionBefore);
  assert.equal(fixture.config.mainModel, mainModelBefore);
  assert.deepEqual(fixture.stateStore.read(), stateBefore);
  assert.deepEqual(fixture.config.providerSetup, fixture.initial);
  assert.deepEqual(await fixture.readDiskConfig(), diskBefore);
  assert.equal(fixture.slots.size, 0);
  assert.equal(fixture.presentations.length, presentationsAtAbort);
  assert.equal(fixture.cancelCalls, 0);
  assert.equal(fixture.publicHubCalls, 0);
  assert.equal(fixture.secretCalls, 0);
  assert.equal(fixture.confirmCalls, 0);
  assert.equal(fixture.kimiEffects, 0);
});

test("process-only startup postpublication abort retains the exact runtime route", async (t) => {
  const fixture = await desktopProcessOnlySetupFixture({ holdRuntimeActivation: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new DOMException("fixed process-only setup postpublication abort", "AbortError");
  const pending = fixture.runtime.runSetup(fixture.surface, {
    generation: 51,
    deadlineAt: Date.now() + 5_000,
    signal: controller.signal,
    remainingMs: () => 5_000,
    assertCurrent() {
      if (controller.signal.aborted) throw reason;
    },
  });
  await fixture.runtimeActivationReached;

  controller.abort(reason);
  const stillPending = Symbol("still-pending");
  const early = await Promise.race([
    pending,
    new Promise<typeof stillPending>((resolve) => setImmediate(() => resolve(stillPending))),
  ]);
  assert.equal(early, stillPending);
  assert.equal(fixture.cancelCalls, 0);
  fixture.releaseRuntimeActivation();
  const result = await pending;

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(fixture.cancelCalls, 0);
  assert.deepEqual(fixture.stateStore.read(), fixture.initial);
  assert.deepEqual(fixture.config.providerSetup, fixture.initial);
  assert.deepEqual(fixture.runtimeRoute, fixture.route);
  assert.deepEqual(fixture.session.data.route, fixture.route);
  assert.equal(fixture.session.data.model, fixture.model.requestedModelId);
  assert.equal(fixture.config.mainModel, fixture.model.requestedModelId);
  assert.deepEqual(fixture.runtime.currentSessionRoute(), fixture.route);
  assert.equal(fixture.slots.size, 0);
});

test("newer activation remains owner after account setup settles without a Cross continuation", async () => {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      runSetup(surface: SetupSurface): Promise<Record<string, unknown>>;
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV3["defaultRoute"]>;
      adoptCredentialActivation(
        route: NonNullable<ProviderSetupStateV3["defaultRoute"]>,
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/cross-b"),
    accountFingerprint: "acct_cross_new_222222",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const connection = (
    id: string,
    accountFingerprint: string,
    credentialPointer: string,
  ): ProviderConnectionStateV3 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: credentialPointer },
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
    async listModels() { return [main]; },
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
    ensureRunnableRoute(route: NonNullable<ProviderSetupStateV3["defaultRoute"]>) {
      return structuredClone(route);
    },
  };
  let hubCalls = 0;
  let modelCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      assert.equal(hubCalls, 0, "account setup must not start a Cross continuation");
      hubCalls += 1;
      return "openrouter";
    },
    async readSecret() { return "sk-or-v1-cross-test"; },
    async chooseModel() {
      assert.equal(modelCalls, 0, "account setup must not request a Cross challenger");
      modelCalls += 1;
      return main.canonicalModelId;
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

  const result = await runtime.runSetup(surface);
  const activatedA = stateStore.read();
  stateStore.replace({
    ...activatedA,
    connections: [connectionA, connectionB],
    defaultRoute: routeB,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  }, activatedA.revision);
  runtimeAccount = routeB.accountFingerprint;
  runtime.adoptCredentialActivation(routeB, true, "newer-process-secret");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(hubCalls, 1);
  assert.equal(modelCalls, 1);
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "reconnect-exact-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
    // The reconnect path invalidates the model cache (FIX-15 F2b) — the
    // openRouter stub must carry the method production always has.
    { invalidateModelCache() {} },
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
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const routeB = {
    ...bootstrapRoute("vendor/reconnect-persisted-b"),
    accountFingerprint: "acct_reconnect_persisted_b_222222",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV3["defaultRoute"]>,
    slot: string,
  ): ProviderConnectionStateV3 => ({
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  });
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
    // The reconnect path invalidates the model cache (FIX-15 F2b) — the
    // openRouter stub must carry the method production always has.
    { invalidateModelCache() {} },
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
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/foreign-exact"),
    accountFingerprint: "acct_selection_foreign_222222",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const connection = (
    id: string,
    route: NonNullable<ProviderSetupStateV3["defaultRoute"]>,
    slot: string,
  ) => ({
    id,
    backendId: "openrouter" as const,
    enabled: true,
    maturity: "stable" as const,
    credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: "openrouter-payg" as const,
    lastHealth: null,
  });
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const foreignRoute = {
    ...bootstrapRoute("vendor/startup-foreign"),
    accountFingerprint: "acct_startup_foreign_666666",
  } as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [
      {
        id: "startup-current-connection",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:56565656-5656-4565-8565-565656565656" },
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

test("startup keeps a cleared session setup-required before automatic environment activation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-cleared-startup-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const session = SessionStore.create(workspace, appHome, "Cleared startup Kimi");
  session.setPreferences("k3", { mode: "auto" }, KIMI_LIFECYCLE_ROUTE);
  await session.save();
  assert.equal(await session.clearRouteIfExact(KIMI_LIFECYCLE_ROUTE), true);
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const calls: string[] = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => {
      inspectStartup(): Promise<Record<string, unknown>>;
      runSetup: (...args: unknown[]) => Promise<Record<string, unknown>>;
      adoptCredentialActivation(route: Record<string, unknown>, persisted: boolean, secret: string): void;
    };
  }).DefaultProviderRuntime;
  const runtime = new Runtime(
    {},
    {},
    { entries() { calls.push("registry"); return []; } },
    new ProviderStateStore(initial),
    {
      nextStartupGeneration() { return 1; },
      async inspectStartup() {
        calls.push("inspect");
        return {
          mode: "setup-required",
          generation: 1,
          defaultRoute: null,
          readyRoutes: [],
          warnings: [],
          crossEnabled: false,
        };
      },
      ensureRunnableRoute() {
        calls.push("ensure");
        return structuredClone(OPENROUTER_LIFECYCLE_ROUTE);
      },
    },
    {},
    { beginRun() { return () => undefined; } },
    {},
    null,
    "synthetic-environment-secret",
    "openrouter/auto",
    config,
    session,
    {
      credentialAuthority: {},
      adapter: {},
      forgetJournal: {},
      async recover() { calls.push("recover"); },
    },
  );
  runtime.runSetup = async () => {
    calls.push("automatic-setup");
    runtime.adoptCredentialActivation(OPENROUTER_LIFECYCLE_ROUTE, false, "synthetic-environment-secret");
    return { kind: "ready" };
  };

  const result = await runtime.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.deepEqual(calls, ["recover"]);
  assert.equal(session.data.model, "k3");
  assert.equal(session.data.route, undefined);
  assert.equal(session.data.routeCleared, true);
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
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:22222222-2222-4222-8222-222222222222" },
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
    state: structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3,
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
    providerSetup: ProviderSetupStateV3;
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
    adapterResolver: () => fixture.adapter as never,
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const staleState: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: "disabled-status-connection",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:33333333-3333-4333-8333-333333333333" },
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

  // FIX-10 fix round 1 (F1): with NO stored connection at all the status
  // must say "not-connected" — never the stored-state claim "disabled".
  const neverConnectedFixture = providerCommandReviewFixture({
    state: { ...structuredClone(staleState), connections: [], defaultRoute: null },
    route,
  });
  const neverConnectedStatus = await neverConnectedFixture.runtime.execute({ kind: "status" }, "plain");
  const neverConnectedProvider = (neverConnectedStatus.providers as Array<Record<string, unknown>>)[0];
  assert.equal(neverConnectedProvider?.configuration, "not-connected");

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
    } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
    const approved: ProviderSetupStateV3 = {
      schemaVersion: 3,
      revision: 0,
      lifecycle: "configured",
      connections: [{
        id: `${operation}-connection`,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:44444444-4444-4444-8444-444444444444" },
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
    const replacement: ProviderSetupStateV3 = {
      ...structuredClone(approved),
      connections: [{
        ...approved.connections[0]!,
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:55555555-5555-4555-8555-555555555555" },
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
      providerSetup: ProviderSetupStateV3;
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const approved: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-authoritative-target",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
      accountFingerprint: approvedRoute.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: approvedRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const replacements: Array<{ name: string; state: ProviderSetupStateV3 }> = [
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
      name: "credential binding",
      state: {
        ...structuredClone(approved),
        connections: [{
          ...approved.connections[0]!,
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:12121212-1212-4121-8121-121212121212" },
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
          credentialBinding: {
            kind: "provider-runtime",
            homeId: parseCodexHomeId("codex-33333333333333333333333333333333"),
          },
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
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "disabled-legacy-readback",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
      ensureRunnableRoute(): NonNullable<ProviderSetupStateV3["defaultRoute"]>;
    };
    persistProviderSetupState(
      path: string,
      request: ProviderStateCommitRequest,
    ): Promise<ProviderSetupStateV3>;
  };
  const route = {
    ...bootstrapRoute("vendor/legacy-lock-release"),
    accountFingerprint: "acct_legacy_lock_release_666666",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-lock-release-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
    providerSetup: ProviderSetupStateV3;
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "legacy-post-commit-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
    } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
    const survivor = {
      id: survivorId,
      backendId: "openrouter" as const,
      enabled: true,
      maturity: "stable" as const,
      credentialBinding: { kind: "orcode-keychain" as const, pointer: approvedSlot },
      accountFingerprint: approvedRoute.accountFingerprint,
      accountFingerprintState: "verified" as const,
      billingRealm: "openrouter-payg" as const,
      lastHealth: null,
    };
    const approved: ProviderSetupStateV3 = {
      schemaVersion: 3,
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
    const replacement: ProviderSetupStateV3 = {
      ...structuredClone(approved),
      connections: approved.connections.map((connection) =>
        connection.id === targetId
          ? {
              ...connection,
              credentialBinding: { kind: "orcode-keychain" as const, pointer: replacementSlot },
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
    credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
    accountFingerprint: route.accountFingerprint,
    accountFingerprintState: "verified" as const,
    billingRealm: "openrouter-payg" as const,
    lastHealth: health,
  };
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
  // FIX-10 fix round 1 (F1): two ENABLED connections whose binding is
  // ambiguous must not be claimed "disabled" — the stored state is enabled;
  // only the binding-dependent facts (headline/default/fingerprint) hide.
  assert.equal(provider?.configuration, "enabled");
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
  const approved: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: approvedSlot },
      accountFingerprint: "acct_disabled_approved_111111",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const replacement: ProviderSetupStateV3 = {
    ...structuredClone(approved),
    connections: [{
      ...approved.connections[0]!,
      credentialBinding: { kind: "orcode-keychain" as const, pointer: replacementSlot },
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const versionedRoute = {
    ...bootstrapRoute("vendor/versioned-shared"),
    accountFingerprint: "acct_versioned_shared_333333",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const fixtures: Array<{ name: string; connections: ProviderSetupStateV3["connections"]; route: NonNullable<ProviderSetupStateV3["defaultRoute"]> }> = [
    {
      name: "shared v1 references",
      route: versionedRoute,
      connections: ["shared-v1-selected", "shared-v1-survivor"].map((id) => ({
        id,
        backendId: "openrouter" as const,
        enabled: true,
        maturity: "stable" as const,
        credentialBinding: { kind: "orcode-keychain" as const, pointer: sharedSlot },
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
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
          credentialBinding: { kind: "orcode-keychain" as const, pointer: sharedSlot },
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
      const initial: ProviderSetupStateV3 = {
        schemaVersion: 3,
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
        confirm: async (request: { title: string; consequence?: string }) => {
          prompts.push(request.consequence ?? request.title);
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
      // FIX-14 ticket 6: one question for both surfaces — the short title
      // plus this consequence, instead of plain mode's one long sentence.
      assert.deepEqual(prompts, [
        "It will be removed from Test-Speicher and from process memory. "
        + "It stays unchanged if multiple provider connections exist.",
      ]);
      assert.deepEqual(output, [
        "API key unchanged: multiple OpenRouter connections are set up. Remove them individually with /provider logout.",
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
    ): Promise<ProviderSetupStateV3>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-global-key-forget-authoritative-shared-"));
  const configPath = join(root, "config.json");
  const stale: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const authoritative: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: ["durable-legacy-one", "durable-legacy-two"].map((id, index) => ({
      id,
      backendId: "openrouter" as const,
      enabled: false,
      maturity: "stable" as const,
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "legacy:inference" },
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
    confirm: async (request: { title: string; consequence?: string }) => {
      prompts.push(request.consequence ?? request.title);
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
    (JSON.parse(beforeBytes) as { providerSetup: ProviderSetupStateV3 }).providerSetup,
  );
  assert.deepEqual(restarted.read(), authoritative);
  assert.deepEqual(await realJournal.readPending(), null);
  assert.deepEqual(prompts, [
    "It will be removed from Test-Speicher and from process memory. "
    + "It stays unchanged if multiple provider connections exist.",
  ]);
  assert.deepEqual(output, [
    "API key unchanged: multiple OpenRouter connections are set up. Remove them individually with /provider logout.",
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
    ): Promise<ProviderSetupStateV3>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-global-key-forget-authoritative-disabled-"));
  const configPath = join(root, "config.json");
  const stale: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const slot = "v1:inference:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const authoritative: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "durable-disabled-v1",
      backendId: "openrouter",
      enabled: false,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
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
  const published: ProviderSetupStateV3[] = [];
  let forgotten = 0;
  const controller = api.createProviderCredentialController({
    stateStore,
    openRouter,
    credentials,
    activationCoordinator: providerCoordinatorMutationFixture(providerRuntimeGuardFixture()),
    forgetJournal: journal,
    onInferenceStatePublished(state: ProviderSetupStateV3) {
      published.push(structuredClone(state));
    },
    onInferenceForgotten() { forgotten += 1; },
  });
  const output: string[] = [];
  const context = {
    openRouter,
    credentials,
    providerCredentials: controller,
    confirm: async () => true,
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
    providerSetup: ProviderSetupStateV3;
  }).providerSetup;
  assert.deepEqual(stateStore.read(), durable);
  assert.equal(durable.revision, 2);
  assert.deepEqual(durable.connections, []);
  assert.equal(durable.defaultRoute, null);
  assert.deepEqual(new ProviderStateStore(durable).read(), durable);
  assert.deepEqual(await realJournal.readPending(), null);
  assert.deepEqual(output, ["API key removed from process memory and Test-Speicher."]);
  assert.doesNotMatch(output.join("\n"), /shared-reference|multiple OpenRouter connections/i);
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
    ): Promise<ProviderSetupStateV3>;
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-forget-serialization-"));
  const configPath = join(root, "config.json");
  const connectionId = "00000000-0000-4000-8000-000000000081";
  const oldSlotId = "v1:inference:00000000-0000-4000-8000-000000000082";
  const route = {
    ...bootstrapRoute("vendor/main"),
    accountFingerprint: "acct_forget_serialization",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: oldSlotId },
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
    adapterResolver: () => adapter as never,
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
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
    adapterResolver: () => ({} as never),
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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

// Fix round 1, MINOR 3: latent hardening — no danger setup-surface confirm
// site exists yet, but the plain adapter's danger path must already print
// its consequence before the prompt (mirroring confirmPlain's own danger
// path) so a future site can't silently ship without it.
test("plain setup surface prints a danger consequence before the prompt and forces default: false", async () => {
  const confirmCalls: Array<{ message: string; default: boolean }> = [];
  const surface = createPlainSetupSurface({
    async select() { return null; },
    async password() { return ""; },
    async confirm(request: { message: string; default: boolean }) {
      confirmCalls.push(request);
      return true;
    },
  } as never);

  const stdout = process.stdout;
  const originalWrite = stdout.write;
  const writes: string[] = [];
  (stdout as unknown as { write(value: string): boolean }).write = (value: string) => {
    writes.push(value);
    return true;
  };
  let accepted: boolean;
  try {
    accepted = await surface.confirm({
      id: "danger-example",
      message: "Really do the destructive thing?",
      // The caller's own default is irrelevant once danger overrides it.
      defaultValue: true,
      danger: true,
      consequence: "This cannot be undone.",
    });
  } finally {
    (stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  }

  assert.equal(accepted, true);
  assert.deepEqual(writes, ["This cannot be undone.\n"]);
  assert.deepEqual(confirmCalls, [{ message: "Really do the destructive thing?", default: false }]);
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

test("plain setup retires a stale error before the next account prompt", async () => {
  const promptMessages: string[] = [];
  const offered: Array<readonly { name: string; value: string; description?: string }[]> = [];
  const surface = createPlainSetupSurface({
    select: async (request: {
      message: string;
      choices: readonly { name: string; value: string; description?: string }[];
    }) => {
      promptMessages.push(request.message);
      offered.push(request.choices);
      return "openrouter";
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
    { id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: true, generation: 9 },
  ]), "openrouter");

  // FIX-12: the prompt carries the question and nothing else. The provider
  // list is the picker's own rows below it — restating it above them as a
  // single `·`-joined line was how a fresh owner's very first screen came
  // to open on 240 unbroken characters. The generation contract this test
  // exists for is unchanged: a notice from an older round is retired.
  // FIX-11 at merge: one name for one screen — the plain picker titles
  // itself "Provider setup" exactly like the two fullscreen surfaces.
  assert.equal(promptMessages[0], "Provider setup");
  assert.doesNotMatch(promptMessages[0] ?? "", /Alter Setup-Fehler/);
  // The plain picker has no current-row mechanism of its own, so the label
  // suffix IS the marking there — in the picker's one vocabulary (`active`,
  // matching list-core's marking word), not a second word for the same fact.
  assert.deepEqual(offered[0], [
    { name: "OpenRouter · active", value: "openrouter", description: "Connect provider" },
  ]);
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
  }), /invalid|control|whitespace/i);
  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: valid,
    environmentInferenceKey: null,
    storedManagementKey: invalid,
    environmentManagementKey: valid,
  }), /invalid|control|whitespace/i);
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
  }), /stored|keyring|invalid/i);
  assert.throws(() => createOpenRouterServiceForStartup({
    storedInferenceKey: null,
    environmentInferenceKey: valid,
    storedManagementKey: management as never,
    environmentManagementKey: valid,
  }), /stored|keyring|invalid/i);
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
  const state = (revision: number, slot: string, account: string): ProviderSetupStateV3 => ({
    schemaVersion: 3,
    revision,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000099",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slot },
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

test("first-run cancellation initializes an absent config with the exact committed provider state", async () => {
  const persist = (cliModule as typeof cliModule & {
    persistProviderSetupState?: (
      path: string,
      request: ProviderStateCommitRequest,
    ) => Promise<ProviderSetupStateV3>;
  }).persistProviderSetupState;
  assert.equal(typeof persist, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-first-cancel-"));
  const path = join(directory, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const stateStore = new ProviderStateStore(initial, {
    persist: (request) => persist!(path, request),
  });

  const committed = await stateStore.commit(initial.revision, (current) => ({
    ...current,
    lifecycle: "cancelled",
  }));
  const disk = JSON.parse(await readFile(path, "utf8")) as typeof DEFAULT_CONFIG;
  const expected = structuredClone(DEFAULT_CONFIG);
  expected.providerSetup = structuredClone(committed);

  assert.equal(committed.revision, initial.revision + 1);
  assert.equal(committed.lifecycle, "cancelled");
  assert.deepEqual(stateStore.read(), committed);
  assert.deepEqual(disk, expected);
});

test("first-run absent provider commit cannot adopt a byte-identical config created at the final publication fence", async () => {
  const persist = (cliModule as typeof cliModule & {
    persistProviderSetupState?: (
      path: string,
      request: ProviderStateCommitRequest,
    ) => Promise<ProviderSetupStateV3>;
  }).persistProviderSetupState;
  assert.equal(typeof persist, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-first-race-"));
  const path = join(directory, "config.json");
  const referencePath = join(directory, "reference.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const candidate = { ...initial, revision: 1, lifecycle: "cancelled" as const };
  await persist!(referencePath, {
    expectedRevision: initial.revision,
    assertCurrent() {},
    build: () => candidate,
    adopt() {},
  });
  const foreignRaw = await readFile(referencePath, "utf8");
  let assertions = 0;
  let adopted = false;

  await assert.rejects(
    persist!(path, {
      expectedRevision: initial.revision,
      assertCurrent() {
        assertions += 1;
        if (assertions === 4) {
          writeFileSync(path, foreignRaw, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
        }
      },
      build(current) {
        assert.deepEqual(current, initial);
        return candidate;
      },
      adopt() {
        adopted = true;
      },
    }),
    /Provider state publication failed/,
  );

  assert.equal(assertions, 4);
  assert.equal(await readFile(path, "utf8"), foreignRaw);
  assert.equal(adopted, false);
});

test("first-run absent provider commit cannot adopt a byte-identical config created by a final-fence abort", async () => {
  const persist = (cliModule as typeof cliModule & {
    persistProviderSetupState?: (
      path: string,
      request: ProviderStateCommitRequest,
    ) => Promise<ProviderSetupStateV3>;
  }).persistProviderSetupState;
  assert.equal(typeof persist, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-first-abort-"));
  const path = join(directory, "config.json");
  const referencePath = join(directory, "reference.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const candidate = { ...initial, revision: 1, lifecycle: "cancelled" as const };
  await persist!(referencePath, {
    expectedRevision: initial.revision,
    assertCurrent() {},
    build: () => candidate,
    adopt() {},
  });
  const foreignRaw = await readFile(referencePath, "utf8");
  const reason = new DOMException("fixed first-run publication abort", "AbortError");
  let assertions = 0;
  let adopted = false;

  await assert.rejects(
    persist!(path, {
      expectedRevision: initial.revision,
      assertCurrent() {
        assertions += 1;
        if (assertions === 4) {
          writeFileSync(path, foreignRaw, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          throw reason;
        }
      },
      build(current) {
        assert.deepEqual(current, initial);
        return candidate;
      },
      adopt() {
        adopted = true;
      },
    }),
    /Provider state publication failed/,
  );

  assert.equal(assertions, 4);
  assert.equal(await readFile(path, "utf8"), foreignRaw);
  assert.equal(adopted, false);
});

test("existing provider commit cannot adopt byte-identical foreign bytes after a rejected rename fence", async () => {
  const persist = (cliModule as typeof cliModule & {
    persistProviderSetupState?: (
      path: string,
      request: ProviderStateCommitRequest,
    ) => Promise<ProviderSetupStateV3>;
  }).persistProviderSetupState;
  assert.equal(typeof persist, "function");

  const directory = await mkdtemp(join(tmpdir(), "orcode-provider-existing-race-"));
  const path = join(directory, "config.json");
  const referencePath = join(directory, "reference.json");
  const initial = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const candidate = { ...initial, revision: 1, lifecycle: "cancelled" as const };
  const initialRaw = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  await writeFile(path, initialRaw, { encoding: "utf8", mode: 0o600 });
  await writeFile(referencePath, initialRaw, { encoding: "utf8", mode: 0o600 });
  await persist!(referencePath, {
    expectedRevision: initial.revision,
    assertCurrent() {},
    build: () => candidate,
    adopt() {},
  });
  const foreignRaw = await readFile(referencePath, "utf8");
  const reason = new Error("fixed byte-identical foreign replace");
  let assertions = 0;
  let adopted = false;

  await assert.rejects(
    persist!(path, {
      expectedRevision: initial.revision,
      assertCurrent() {
        assertions += 1;
        if (assertions === 4) {
          writeFileSync(path, foreignRaw, { encoding: "utf8" });
          throw reason;
        }
      },
      build(current) {
        assert.deepEqual(current, initial);
        return candidate;
      },
      adopt() {
        adopted = true;
      },
    }),
    /Provider state publication failed/,
  );

  assert.equal(assertions, 4);
  assert.equal(await readFile(path, "utf8"), foreignRaw);
  assert.equal(adopted, false);
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
    ): Promise<ProviderSetupStateV3>;
  };
  const directory = await mkdtemp(join(tmpdir(), "orcode-cross-writer-fence-"));
  const configPath = join(directory, "config.json");
  const route = {
    ...bootstrapRoute("vendor/cross-writer-a"),
    accountFingerprint: "acct_cross_writer_111111",
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
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
  const activated: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 1,
    lifecycle: "configured",
    connections: [{
      id: "cross-writer-connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:91919191-9191-4191-8191-919191919191" },
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
  const readDurable = async (): Promise<ProviderSetupStateV3> => (
    JSON.parse(await readFile(configPath, "utf8")) as {
      providerSetup: ProviderSetupStateV3;
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
        providerSetup: ProviderSetupStateV3;
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
    providerSetup: ProviderSetupStateV3;
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
  const route = bootstrapRoute("vendor/main") as unknown as ProviderSetupStateV3["defaultRoute"];
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: oldSlot },
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
    const next: ProviderSetupStateV3 = {
      ...structuredClone(initial),
      revision: 1,
      connections: [{ ...initial.connections[0]!, credentialBinding: { kind: "orcode-keychain" as const, pointer: newSlot } }],
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
  assert.equal(requireKeychainCredentialPointer(durable.connections[0]!), newSlot);
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
  const route = bootstrapRoute("vendor/process-only") as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
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
        const next: ProviderSetupStateV3 = {
          schemaVersion: 3,
          revision: 1,
          lifecycle: "configured",
          connections: [{
            id: connectionId,
            backendId: "openrouter",
            enabled: true,
            maturity: "stable",
            credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000059",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
  assert.equal(requireKeychainCredentialPointer(durable.connections[0]!), slotId);

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
    ) => Promise<ProviderSetupStateV3>;
  };
  assert.equal(typeof api.ProviderCredentialForgetJournal, "function");
  assert.equal(typeof api.createProviderCredentialController, "function");
  const root = await mkdtemp(join(tmpdir(), "orcode-forget-journal-pre-delete-"));
  const configPath = join(root, "config.json");
  const slotId = "v1:inference:00000000-0000-4000-8000-000000000061";
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000069",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
    onInferenceStatePublished(state: ProviderSetupStateV3) {
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
    (JSON.parse(await readFile(configPath, "utf8")) as { providerSetup: ProviderSetupStateV3 })
      .providerSetup.defaultRoute,
    null,
  );
  await saveConfig(config, configPath);

  const saved = JSON.parse(await readFile(configPath, "utf8")) as { providerSetup: ProviderSetupStateV3 };
  assert.equal(saved.providerSetup.defaultRoute, null);
  assert.equal(requireKeychainCredentialPointer(saved.providerSetup.connections[0]!), slotId);
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
  const route = bootstrapRoute("vendor/main") as unknown as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const initial: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 0,
    lifecycle: "configured",
    connections: [{
      id: "00000000-0000-4000-8000-000000000079",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
      adapterResolver: () => fixture.adapter as never,
      stateStore: independentStore,
      runtimeGuard: providerRuntimeGuardFixture(),
    });

    await assert.rejects(
      independentCoordinator.activate({
        backendId: "openrouter",
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 4,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: newSlotId },
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
  } as NonNullable<ProviderSetupStateV3["defaultRoute"]>;
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 7,
    lifecycle: "configured",
    connections: [
      {
        id: retiringConnectionId,
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
        credentialBinding: { kind: "orcode-keychain" as const, pointer: slotId },
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
  assert.match(messages.join("\n"), /validated.*stored/i);
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
  assert.match(messages.join("\n"), /invalid|control|whitespace/i);
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
  assert.match(source, /context\.withCredentialSecret\s*=/);
  // FIX-14 ticket 6: one confirmation wiring, not seven per-question
  // adapters. The dashboard must still wire it — a missing seam would send
  // every command's confirmation to Inquirer inside a raw-mode TUI.
  assert.match(source, /context\.confirm\s*=/);
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

test("parseArgs accepts --recover and --no-recover independently", () => {
  assert.equal(parseArgs(["--recover"]).recover, true);
  assert.equal(parseArgs(["--recover"]).noRecover, false);
  assert.equal(parseArgs(["--no-recover"]).noRecover, true);
  assert.equal(parseArgs(["--no-recover"]).recover, false);
  assert.equal(parseArgs([]).recover, false);
  assert.equal(parseArgs([]).noRecover, false);
});

test("parseArgs rejects combining --recover with --no-recover", () => {
  assert.throws(() => parseArgs(["--recover", "--no-recover"]), CliUsageError);
});

// FIX-2 (audit 2026-08-28): `--resume` used to apply an interrupted run's
// context. Peer parity says "resume" means "continue the most recent
// conversation", so it is now an alias of `--continue` — the SAME field, not
// a parallel one — and interrupted-run triage moved to `--recover`.
test("parseArgs treats --resume as an exact alias of --continue", () => {
  assert.deepEqual(parseArgs(["--resume"]), parseArgs(["--continue"]));
  assert.equal(parseArgs(["--resume"]).continueChat, true);
  assert.equal(parseArgs(["--resume"]).recover, false);
  assert.equal(parseArgs(["--resume"]).noRecover, false);
  assert.equal(parseArgs(["--continue"]).continueChat, true);
});

test("parseArgs rejects --resume alongside the other chat modes, exactly like --continue", () => {
  assert.throws(() => parseArgs(["--resume", "--new"]), CliUsageError);
  assert.throws(() => parseArgs(["--resume", "--chat", "c1"]), CliUsageError);
  // Being the same flag, `--resume --continue` is a repetition, not a clash.
  assert.equal(parseArgs(["--resume", "--continue"]).continueChat, true);
});

test("parseArgs no longer knows the retired interrupted-run spellings", () => {
  assert.throws(() => parseArgs(["--no-resume"]), CliUsageError);
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

test("CLI run-cost formatting never presents unknown Kimi membership spend as free", () => {
  const result = {
    costKnowledge: "unknown",
    costUsd: 0,
    mainCostUsd: 0,
    compressorCostUsd: 0,
  } as AgentRunResult;
  const formatted = formatRunCost(result, " · ");
  assert.match(formatted, /provider-managed|unknown/i);
  assert.doesNotMatch(formatted, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("CLI chat-list cost formatting preserves unknown provider-managed session spend", () => {
  const formatted = formatChatCost({
    costUsd: 0,
    costKnowledge: "unknown",
  }, " · ");
  assert.match(formatted, /provider-managed|unknown/i);
  assert.doesNotMatch(formatted, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("refreshDashboardBalance populates the Balance row's data from a stubbed credits source", async () => {
  let onBalanceCalls = 0;
  const balanceInfo = {
    key: {},
    credits: { totalCredits: 100, totalUsage: 58.83, remaining: 41.17 },
  };
  refreshDashboardBalance({
    readCachedSettingsRoute: () => null,
    checkBalance: async () => balanceInfo as never,
    onBalance: (result) => {
      onBalanceCalls += 1;
      assert.equal(result, balanceInfo);
    },
  });
  // Fire-and-forget: `refreshDashboardBalance` returns before the promise
  // settles — the row's absence at this exact instant is expected, the
  // point under test is that the async refresh lands afterward.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(onBalanceCalls, 1, "onBalance must fire once the stubbed fetch resolves");
});

test("refreshDashboardBalance leaves the Balance row absent when the credits fetch fails", async () => {
  let onBalanceCalls = 0;
  refreshDashboardBalance({
    readCachedSettingsRoute: () => null,
    checkBalance: async () => { throw new Error("network unavailable"); },
    onBalance: () => { onBalanceCalls += 1; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(onBalanceCalls, 0, "a failed fetch must never populate the row — never fabricate, never crash");
});

test("refreshDashboardBalance skips the network call entirely on a provider-managed (Kimi) route", async () => {
  let checkBalanceCalls = 0;
  let onBalanceCalls = 0;
  refreshDashboardBalance({
    readCachedSettingsRoute: () => ({ backendId: "kimi-code" } as never),
    checkBalance: async () => {
      checkBalanceCalls += 1;
      return { key: {} } as never;
    },
    onBalance: () => { onBalanceCalls += 1; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(checkBalanceCalls, 0, "a provider-managed route must never fire the OpenRouter credits fetch");
  assert.equal(onBalanceCalls, 0);
});

// ---------------------------------------------------------------------------
// D8 (neutral start hub): `refreshDashboardRecentChats` is the pure
// extraction that generalizes the pre-D8 single-slot "Continue" source
// (`refreshRecentChat`) to the hub's top-4 "Recent" section — same
// fire-and-forget, never-fabricate shape as `refreshDashboardBalance` above.
// ---------------------------------------------------------------------------

function crossWorkspaceChat(overrides: Record<string, unknown> = {}): CrossWorkspaceChat {
  return {
    id: "chat-x",
    title: "Untitled",
    workspace: "/workspace/a",
    turnCount: 1,
    costUsd: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    workspaceVerified: true,
    ...overrides,
  } as CrossWorkspaceChat;
}

test("refreshDashboardRecentChats returns the top 4 chats across every workspace, most-recent first, current chat excluded", async () => {
  const chats = [
    crossWorkspaceChat({ id: "current", title: "Current chat", updatedAt: new Date(6_000).toISOString() }),
    crossWorkspaceChat({ id: "c1", title: "Newest", updatedAt: new Date(5_000).toISOString() }),
    crossWorkspaceChat({ id: "c2", title: "Second", workspace: "/workspace/b", updatedAt: new Date(4_000).toISOString() }),
    crossWorkspaceChat({ id: "c3", title: "Third", updatedAt: new Date(3_000).toISOString() }),
    crossWorkspaceChat({ id: "c4", title: "Fourth", updatedAt: new Date(2_000).toISOString() }),
    crossWorkspaceChat({ id: "c5", title: "Fifth (past the cap)", updatedAt: new Date(1_000).toISOString() }),
  ];
  let received: unknown = null;
  refreshDashboardRecentChats({
    listChats: async () => chats,
    currentChatId: "current",
    onRecentChats: (recent) => { received = recent; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    (received as { id: string }[]).map((chat) => chat.id),
    ["c1", "c2", "c3", "c4"],
    "top 4, most-recent first, spanning every workspace — the current chat and the 5th-oldest never appear",
  );
});

test("refreshDashboardRecentChats excludes a chat with no trustworthy folder (Continue precedent, ruling 3) but keeps the rest", async () => {
  const chats = [
    crossWorkspaceChat({ id: "c1", title: "Verified", updatedAt: new Date(2_000).toISOString() }),
    crossWorkspaceChat({ id: "c2", title: "Unverified", workspaceVerified: false, updatedAt: new Date(1_000).toISOString() }),
  ];
  let received: unknown = null;
  refreshDashboardRecentChats({
    listChats: async () => chats,
    currentChatId: "someone-else",
    onRecentChats: (recent) => { received = recent; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual((received as { id: string }[]).map((chat) => chat.id), ["c1"]);
});

test("refreshDashboardRecentChats carries the same chat-summary fields the /chats picker renders, including model", async () => {
  const chats = [
    crossWorkspaceChat({
      id: "c1",
      title: "Kimi session",
      turnCount: 5,
      costUsd: 0.5,
      costKnowledge: "unknown",
      model: "vendor/model-x",
      workspace: "/workspace/foreign",
      updatedAt: new Date(1_000).toISOString(),
    }),
  ];
  let received: unknown = null;
  refreshDashboardRecentChats({
    listChats: async () => chats,
    currentChatId: "someone-else",
    onRecentChats: (recent) => { received = recent; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(received, [{
    id: "c1",
    title: "Kimi session",
    turnCount: 5,
    costUsd: 0.5,
    costKnowledge: "unknown",
    model: "vendor/model-x",
    updatedAt: Date.parse(new Date(1_000).toISOString()),
    workspace: "/workspace/foreign",
  }]);
});

test("refreshDashboardRecentChats resolves to an empty list, not a crash, when nothing is eligible", async () => {
  let calls = 0;
  let received: unknown = "unset";
  refreshDashboardRecentChats({
    listChats: async () => [],
    currentChatId: "someone-else",
    onRecentChats: (recent) => { calls += 1; received = recent; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(received, []);
});

test("refreshDashboardRecentChats never calls onRecentChats when the listing fails — best-effort, never fabricate, never crash", async () => {
  let calls = 0;
  refreshDashboardRecentChats({
    listChats: async () => { throw new Error("disk unavailable"); },
    currentChatId: "someone-else",
    onRecentChats: () => { calls += 1; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0, "a failed listing must never populate the Recent section — the hub simply keeps showing what it had");
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
  // G1b: the constant moved to `chat-session.ts` with the chat-open
  // machinery, so both surfaces import one value instead of two files
  // declaring their own. The rule this pin enforces is unchanged.
  const chatSession = readFileSync(
    new URL("../src/chat-session.ts", import.meta.url),
    "utf8",
  );

  for (const [name, source] of [["cli.ts", cli], ["chat-session.ts", chatSession]] as const) {
    assert.equal(
      /recentTurns\(\s*\d+\s*\)/.test(source),
      false,
      `${name} must not hardcode a turn count; use VISIBLE_TURNS`,
    );
  }
  assert.equal(
    /const VISIBLE_TURNS = \d+/.test(cli),
    false,
    "cli.ts must import VISIBLE_TURNS, never redeclare it",
  );
  const declared = /const VISIBLE_TURNS = (\d+)/.exec(chatSession);
  assert.ok(declared, "VISIBLE_TURNS must be declared in chat-session.ts");
  const capped = /loadTurns\([^)]*maximum = (\d+)/.exec(tui);
  assert.ok(capped, "loadTurns must state its cap");
  assert.equal(
    declared![1],
    capped![1],
    "loadTurns would silently drop turns the caller asked for",
  );
});

/**
 * V3 audit principle 4 sweep guard (F4): a source-level structural check
 * that the raw `field=value` health chains, the internal
 * generation/retry-round counters, the German defensive throw, and the
 * old "Approval subject (exact):" wording never creep back into
 * user-facing copy. Grep stems, not the audit's literal exemplars — the
 * whole point of the ruling was "every occurrence", not just the ones the
 * audit happened to name.
 */
test("no raw provider-health enums, internal counters, or the German throw survive in user-facing source (V3 audit principle 4 sweep guard)", () => {
  const commands = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8");
  const setupSurface = readFileSync(new URL("../src/setup-surface/index.ts", import.meta.url), "utf8");
  const tui = readFileSync(new URL("../src/tui.ts", import.meta.url), "utf8");
  const approval = readFileSync(new URL("../src/approval.ts", import.meta.url), "utf8");
  const storage = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8");

  for (const stem of ["credential=", "connectivity=", "spend=", "runtime="]) {
    assert.equal(commands.includes(stem), false, `commands.ts must not print raw "${stem}"`);
  }
  // `Generation ${n}` (commands.ts's /provider reconnect result) and
  // `Current r${n}` (setup-surface's provider-picker label) were the
  // audit's two named counters; both internal `generation` fields may
  // still exist as plain data (retry-round bookkeeping), just never
  // interpolated into a displayed string like this again.
  assert.doesNotMatch(commands, /Generation \$\{/);
  assert.doesNotMatch(setupSurface, /Current r\$\{/);
  assert.doesNotMatch(tui, /Approval subject \(exact\)/);
  assert.doesNotMatch(approval, /Approval subject \(exact\)/);
  assert.doesNotMatch(storage, /Unbekannter/);
});

test("startup no longer gates the transcript behind an auto-opening chooser", () => {
  // Controller decision A (composition phase): the welcome box + workbench
  // greets the owner now, unconditionally — the startup chat picker never
  // opens itself any more, so the transcript always loads straight away.
  // `showChatPickerOnStart` and its startup `pickDashboardChat` call are
  // gone entirely; `/chats` (an existing `/chat` alias) and the workbench's
  // "Continue" shortcut are the only remaining ways to reach the picker.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.equal(cli.includes("showChatPickerOnStart"), false);
  const load = cli.indexOf("ui.loadTurns(context.session.recentTurns(VISIBLE_TURNS));");
  const start = cli.indexOf("ui.start()");
  assert.ok(load > 0, "startup must still load the transcript");
  assert.ok(load < start, "the transcript loads before ui.start(), unconditionally");
});

// ---------------------------------------------------------------------------
// D8c (owner live-test gap after D8): a bare launch used to silently
// auto-open the workspace's most recently used chat — the transcript then
// loaded non-empty, so the neutral start hub (Controller ruling 1/6, D8)
// never actually appeared despite existing. Controller ruling 1/2 makes a
// fresh, unsaved chat (`SessionStore.create`, the exact call `/new` already
// uses) the default; `--continue` is the one explicit opt-in to the old
// default. See `initializeStartupStorage`'s `openSession` in cli.ts.
// ---------------------------------------------------------------------------

test("a bare launch opens a fresh, empty chat even when the workspace already has a populated one — the hub, never the old transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-fresh-default-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  try {
    const existing = SessionStore.create(workspace, appHome, "Existing chat");
    existing.addTurn("user", "earlier work");
    existing.addTurn("assistant", "earlier reply");
    await existing.save();

    const startup = await initializeStartupStorage(
      { workspace, newChat: false },
      { migrateAppHome: () => migrateAppHome(appHome, join(root, "legacy")) },
    );

    assert.notEqual(startup.session.data.id, existing.data.id);
    assert.equal(startup.session.data.turns.length, 0);
    assert.equal(startup.session.data.title, "New Chat");

    // The existing chat is untouched and still reachable — Recent rows/
    // `/chats` (Controller ruling 1: "the previous conversations remain
    // reachable exactly as D8 designed") still find it.
    const chats = await SessionStore.list(workspace, appHome);
    assert.deepEqual(chats.map((chat) => chat.id), [existing.data.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--continue opts back into the previous default: it opens the workspace's most recently used chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-continue-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  try {
    const existing = SessionStore.create(workspace, appHome, "Existing chat");
    existing.addTurn("user", "earlier work");
    await existing.save();

    const startup = await initializeStartupStorage(
      { workspace, newChat: false, continueChat: true },
      { migrateAppHome: () => migrateAppHome(appHome, join(root, "legacy")) },
    );

    assert.equal(startup.session.data.id, existing.data.id);
    assert.equal(startup.session.data.turns.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--new is unchanged: it still opens a fresh chat, the same branch a bare launch now also takes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-new-unchanged-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  try {
    const existing = SessionStore.create(workspace, appHome, "Existing chat");
    existing.addTurn("user", "earlier work");
    await existing.save();

    const startup = await initializeStartupStorage(
      { workspace, newChat: true },
      { migrateAppHome: () => migrateAppHome(appHome, join(root, "legacy")) },
    );

    assert.notEqual(startup.session.data.id, existing.data.id);
    assert.equal(startup.session.data.turns.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--chat <id> is unchanged: it opens that exact chat regardless of continueChat/newChat", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-chat-id-unchanged-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  try {
    const target = SessionStore.create(workspace, appHome, "Target chat");
    target.addTurn("user", "hi");
    await target.save();
    const other = SessionStore.create(workspace, appHome, "Other, more recent chat");
    await other.save();

    const startup = await initializeStartupStorage(
      { workspace, newChat: false, chatId: target.data.id },
      { migrateAppHome: () => migrateAppHome(appHome, join(root, "legacy")) },
    );

    assert.equal(startup.session.data.id, target.data.id);
    assert.equal(startup.session.data.turns.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain loop: a bare launch-and-quit on the fresh hub session leaves no chat file on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-no-ghost-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const session = SessionStore.create(workspace, appHome);
  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: null, challenger: null }),
    listSelectableModelRoutes: async () => [],
    migratedSessionConnection: () => undefined,
    async runWithReadyRoute() { throw new Error("must not run — no message is ever sent"); },
    currentSessionRoute: () => { throw new Error("must not run — no message is ever sent"); },
  };
  try {
    await runPlainLoop({
      executionMode: "local-interactive-owner",
      workspace,
      configPath: join(root, "config.json"),
      config,
      approvals: new ApprovalManager("read-only"),
      openRouter: { safeMessage: (error: unknown) => String(error) },
      session,
      agent: null,
      localRuntime: {
        guard: await WorkspaceGuard.create(workspace),
        journal: new ChangeJournal({ appHome, chatId: session.data.id }),
        setSession() {},
        resetConversationMemory() {},
      },
      providerCredentials: {} as never,
      providerCommands: providerRuntime as never,
      providerRoutes: providerRuntime as never,
      providerRouteSurface: "plain",
      providerRuntime: providerRuntime as never,
      credentials: {} as never,
      out: { text: () => {}, error: () => {} },
      ruleStore: {} as never,
      sshSession: createSshSession(),
      ensureAgentForPrompt: async () => { throw new Error("must not run"); },
      readPlainInput: async () => "/quit",
      stdinIsTty: true,
      stdoutIsTty: true,
    } as never, { recover: false, noRecover: true });

    const chats = await SessionStore.list(workspace, appHome);
    assert.deepEqual(chats, [], "a mere launch-and-quit must leave zero chat files (no ghost 'New Chat')");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain loop: the interrupted-run check watches the workspace's most recently used chat, and --recover opens it (not the fresh hub session it left as current)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-d8c-resume-workspace-scoped-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "home");
  await mkdir(workspace, { recursive: true });

  // The chat a crashed run belongs to — this is the chat startup used to
  // silently auto-open before D8c; it is the workspace's most recently used
  // chat, not the fresh session the current default now opens.
  const crashedChat = SessionStore.create(workspace, appHome, "Crashed chat");
  crashedChat.addTurn("user", "do the thing");
  await crashedChat.save();
  const runId = createRunId();
  const log = await RunLog.open(appHome, crashedChat.data.id, runId);
  log.write({
    type: "run-start",
    model: "vendor/main",
    maxSteps: 4,
    prompt: "do the thing",
    timestamp: Date.now(),
  });
  await log.close();

  // D8c: a bare launch now opens a fresh session instead (Controller ruling
  // 1/2) — this is what `context.session` is at the moment the check runs.
  const freshSession = SessionStore.create(workspace, appHome);

  const mainRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_resume_workspace_scoped",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "vendor/main",
    canonicalModelId: "vendor/main",
    resolutionState: "resolved" as const,
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = mainRoute.requestedModelId;
  const providerRuntime = {
    preparedRoles: null,
    readCrossPreferences: () => ({ lead: null, challenger: null }),
    listSelectableModelRoutes: async () => [],
    migratedSessionConnection: () => undefined,
    async runWithReadyRoute(run: (exact: typeof mainRoute) => Promise<unknown>) { return run(mainRoute); },
    currentSessionRoute: () => mainRoute,
    adoptSession() {},
  };
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });

  const context = {
    executionMode: "local-interactive-owner",
    workspace,
    configPath: join(root, "config.json"),
    config,
    approvals: new ApprovalManager("read-only"),
    openRouter: { safeMessage: (error: unknown) => String(error) },
    session: freshSession,
    agent: null,
    localRuntime: {
      guard: await WorkspaceGuard.create(workspace),
      journal: new ChangeJournal({ appHome, chatId: freshSession.data.id }),
      setSession() {},
      resetConversationMemory() {},
    },
    providerCredentials: {} as never,
    providerCommands: providerRuntime as never,
    providerRoutes: providerRuntime as never,
    providerRouteSurface: "plain",
    providerRuntime: providerRuntime as never,
    credentials: {} as never,
    out: { text: () => {}, error: () => {} },
    ruleStore: {} as never,
    sshSession: createSshSession(),
    ensureAgentForPrompt: async () => { throw new Error("must not run — no message is ever sent"); },
    readPlainInput: async () => "/quit",
    stdinIsTty: true,
    stdoutIsTty: true,
  };
  try {
    await runPlainLoop(context as never, { recover: true, noRecover: false });

    assert.ok(
      logs.some((entry) => typeof entry[0] === "string" && /previous run did not end cleanly/.test(entry[0])),
      "the honest crash notice must still appear even though the crashed chat was never auto-opened as current",
    );
    // Explicit "Continue" (via --recover) is the one thing allowed to open
    // the affected chat — and it must have: `context.session` no longer
    // points at the untouched fresh hub session.
    assert.equal((context as unknown as { session: SessionStore }).session.data.id, crashedChat.data.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup awaits migration before config, rules, chats, keys, or network can open", async () => {
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
    "exact-retention",
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

test("the unbounded retention classes never run before startup returns and only start when the caller asks", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  const order: string[] = [];
  const result = await initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => ({ status: "ready", appHome: "/synthetic/.orcode", warning: null } as never),
      pruneRunLogs: async () => {
        order.push("redacted-retention");
        return { removed: [], errors: [{ path: "runs/chat-a/run.ndjson", message: "log still open" }] };
      },
      pruneCheckpoints: async () => {
        order.push("exact-retention");
      },
      pruneBrowserTempArtifacts: async () => {
        order.push("browser-retention");
        return { removed: [], errors: [{ path: "/tmp/orcode-browser-operation-Ab12Z9", message: "still busy" }] };
      },
      loadConfig: async () => {
        order.push("config");
        return structuredClone(DEFAULT_CONFIG);
      },
      loadRules: async () => {
        order.push("rules");
        return {} as never;
      },
      openSession: async (_workspace, appHome) => {
        order.push("chats");
        return { appHome, data: { id: "chat-a" } } as never;
      },
    },
  );

  // The launch path is complete and neither unbounded sweep was touched.
  assert.deepEqual(order, ["exact-retention", "config", "rules", "chats"]);
  assert.deepEqual(result.retentionWarnings, []);

  const deferred: string[] = [];
  result.startDeferredRetention((warning) => deferred.push(warning));
  // Fire-and-forget: still nothing awaited by the caller.
  assert.equal(deferred.length, 0);
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(order.slice(0, 4), ["exact-retention", "config", "rules", "chats"]);
  assert.deepEqual(
    order.slice(4).sort(),
    ["browser-retention", "redacted-retention"],
  );
  assert.equal(deferred.length, 2);
  assert.ok(deferred.some((warning) => /Retention \(redacted\).*log still open/.test(warning)));
  assert.ok(deferred.some((warning) => /Retention \(browser\).*still busy/.test(warning)));

  // Idempotent: a second surface asking never re-runs either sweep.
  result.startDeferredRetention((warning) => deferred.push(warning));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.filter((entry) => entry === "browser-retention").length, 1);
  assert.equal(order.filter((entry) => entry === "redacted-retention").length, 1);
  assert.equal(deferred.length, 2);
});

test("a deferred sweep that throws is swallowed into the deferred sink, never the launch path", async () => {
  const { initializeStartupStorage } = await import("../src/cli.js");
  const result = await initializeStartupStorage(
    { workspace: "/synthetic/workspace", newChat: false },
    {
      migrateAppHome: async () => ({ status: "ready", appHome: "/synthetic/.orcode", warning: null } as never),
      pruneRunLogs: async () => {
        throw new Error("run retention unavailable");
      },
      pruneCheckpoints: async () => undefined,
      pruneBrowserTempArtifacts: async () => {
        throw new Error("browser retention unavailable");
      },
      loadConfig: async () => structuredClone(DEFAULT_CONFIG),
      loadRules: async () => ({} as never),
      openSession: async (_workspace, appHome) => ({ appHome, data: { id: "chat-a" } } as never),
    },
  );
  assert.deepEqual(result.retentionWarnings, []);
  const deferred: string[] = [];
  result.startDeferredRetention((warning) => deferred.push(warning));
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(deferred.length, 2);
  assert.ok(deferred.some((warning) => /Retention \(redacted\).*run retention unavailable/.test(warning)));
  assert.ok(deferred.some((warning) => /Retention \(browser\).*browser retention unavailable/.test(warning)));
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

  assert.deepEqual(calls, ["exact", "config", "rules", "session"]);
  assert.equal(result.retentionWarnings.length, 1);
  assert.match(result.retentionWarnings[0]!, /exact retention unavailable/);

  const deferred: string[] = [];
  result.startDeferredRetention((warning) => deferred.push(warning));
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls.slice(0, 4), ["exact", "config", "rules", "session"]);
  assert.deepEqual(calls.slice(4).sort(), ["browser", "redacted"]);
  assert.equal(deferred.length, 2);
  assert.ok(deferred.some((warning) => /run retention unavailable/.test(warning)));
  assert.ok(deferred.some((warning) => /browser retention unavailable/.test(warning)));
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

  assert.equal(result.retentionWarnings.length, 2);
  assert.ok(result.retentionWarnings.some((warning) => /exact state remained busy/.test(warning)));
  assert.ok(result.retentionWarnings.some((warning) => /backup remained busy/.test(warning)));

  // The deferred classes report the exact same shape, just through the sink.
  const deferred: string[] = [];
  result.startDeferredRetention((warning) => deferred.push(warning));
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(deferred.length, 2);
  assert.ok(deferred.some((warning) => /redacted log remained busy/.test(warning)));
  assert.ok(deferred.some((warning) => /browser profile remained busy/.test(warning)));
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
  assert.match(incompatibleSnapshot.details, /incompatible/i);

  const missingSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => [] },
    "provider/missing",
  );
  assert.equal(missingSnapshot.status, "missing");
  assert.doesNotMatch(missingSnapshot.details, /dynamic OpenRouter route/i);

  const unavailable = new Error("synthetic catalogue timeout");
  const unavailableSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => { throw unavailable; } },
    "provider/complete",
  );
  assert.equal(unavailableSnapshot.status, "unavailable");
  assert.equal(unavailableSnapshot.error, unavailable);
  assert.doesNotMatch(unavailableSnapshot.details, /incompatible/i);

  const autoSnapshot = await cli.loadModelSnapshot(
    { listModels: async () => { throw new Error("auto must not query the catalogue"); } },
    "openrouter/auto",
  );
  assert.equal(autoSnapshot.status, "available");
  assert.equal(autoSnapshot.model, null);
  assert.match(autoSnapshot.details, /dynamic OpenRouter route/i);
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
