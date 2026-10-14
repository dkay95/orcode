import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_DESCRIPTOR,
  BackendRegistry,
  type BackendAdapter,
  type RouteIdentityV1,
} from "../src/backends.js";
import { DESKTOP_DISABLED_COPY } from "../src/desktop-german-copy.js";
import {
  projectCodexProviderCapability,
} from "../src/desktop-capabilities.js";
import type {
  DesktopCapabilitySnapshot,
  DesktopDataPolicyKnowledge,
  DesktopRouteCandidate,
} from "../src/desktop-contracts.js";
import { DesktopOnboardingController } from "../src/desktop-onboarding.js";
import {
  CodexProfileRouteRuntime,
  type CodexAccountModelClient,
} from "../src/model-runtime.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ProviderStateStore,
  type ProviderConnectionStateV3,
  type ProviderSetupStateV3,
} from "../src/provider-state.js";
import { SetupOrchestrator } from "../src/setup.js";

const HOME_A = "codex-11111111111111111111111111111111";
const HOME_B = "codex-22222222222222222222222222222222";

test("projects the complete Codex capability with canonical setup methods and mapped German copy", () => {
  const unavailable = DESKTOP_DISABLED_COPY["codex-profile-isolation-unproven"];
  const setupUnavailable = DESKTOP_DISABLED_COPY["setup-method-unavailable"];
  const route: DesktopRouteCandidate = {
    handle: "opaque-a",
    providerId: "codex",
    connectionId: "codex-a",
    accountLabel: "Persoenliches ChatGPT",
    canonicalModelId: "gpt-5.6-codex",
    displayName: "GPT-5.6 Codex",
    reasoning: "supported",
    capabilities: ["text", "image-input", "tools", "reasoning"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: {
      kind: "unknown",
      label: "Datenrichtlinie unbekannt",
    } satisfies DesktopDataPolicyKnowledge,
    runnable: true,
  };

  assert.deepEqual(projectCodexProviderCapability({
    connectionId: "codex-a",
    accountLabel: "Persoenliches ChatGPT",
    state: "ready",
    routes: [route],
    multiProfile: { enabled: false, disabled: unavailable },
    repair: setupUnavailable,
  }), {
    providerId: "codex",
    providerLabel: "ChatGPT / Codex",
    connectionId: "codex-a",
    accountLabel: "Persoenliches ChatGPT",
    state: "ready",
    setupMethods: ["codex-browser-login", "codex-device-login"],
    multiProfile: { enabled: false, disabled: unavailable },
    routes: [route],
    repair: setupUnavailable,
  });
});

test("requires explicit profile and model confirmation instead of treating highlight as consent", async () => {
  let snapshot = codexSnapshot([]);
  const activated: string[] = [];
  const controller = new DesktopOnboardingController({
    authority: {
      snapshot: () => structuredClone(snapshot),
      async refreshAccount(selection) {
        assert.equal(selection.connectionId, "codex-a");
        snapshot = codexSnapshot([publicRoute("opaque-a")]);
        return structuredClone(snapshot);
      },
      async cancelActivation() { return "none"; },
      async activate(selection) {
        activated.push(selection.routeHandle);
        snapshot = {
          ...codexSnapshot([publicRoute("opaque-after")]),
          revision: 2,
          generation: 2,
          routeRunnable: true,
          activeRoute: {
            routeHandle: "opaque-after",
            providerLabel: "ChatGPT / Codex",
            modelLabel: "GPT-5.6 Codex",
            accountLabel: "Persoenliches ChatGPT",
          },
        };
        return { routeHandle: "opaque-after", revision: 2, generation: 2 };
      },
    },
  });

  await controller.dispatch({ kind: "choose-provider", providerId: "codex", revision: 1, generation: 1 });
  assert.equal(controller.snapshot().step, "account");
  assert.deepEqual(controller.snapshot().candidates, []);
  assert.deepEqual(activated, []);

  await controller.dispatch({ kind: "choose-account", connectionId: "codex-a", revision: 1, generation: 1 });
  assert.equal(controller.snapshot().step, "model");
  assert.deepEqual(controller.snapshot().candidates.map((candidate) => candidate.handle), ["opaque-a"]);
  assert.deepEqual(activated, []);

  const result = await controller.dispatch({ kind: "choose-model", routeHandle: "opaque-a", revision: 1, generation: 1 });
  assert.deepEqual(result, { kind: "ready", routeHandle: "opaque-after", routeRunnable: true });
  assert.deepEqual(activated, ["opaque-a"]);
});

test("lists models only for the explicitly selected current-generation Codex profile", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-profile-route-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const stateStore = new ProviderStateStore(codexState([codexConnection("codex-a", HOME_A, "acct_a"), codexConnection("codex-b", HOME_B, "acct_b")]));
  const started: string[] = [];
  const clients = new Map<string, FakeCodexClient>();
  const runtime = new CodexProfileRouteRuntime({
    appHome,
    stateStore,
    createClient: async ({ connection }) => {
      started.push(connection.id);
      const client = new FakeCodexClient(connection.id);
      clients.set(connection.id, client);
      return client;
    },
  });

  const models = await runtime.listModelsForProfile({
    connectionId: "codex-a",
    stateRevision: 1,
    generation: 4,
    signal: new AbortController().signal,
  });
  assert.deepEqual(started, ["codex-a"]);
  assert.deepEqual(models.map((model) => [model.requestedModelId, model.canonicalModelId]), [
    ["gpt-5.6-codex", "gpt-5.6-codex"],
  ]);
  assert.deepEqual(runtime.currentCatalog({ connectionId: "codex-b", stateRevision: 1, generation: 4 }), []);

  const selection = runtime.prepareRouteSelection({
    connectionId: "codex-a",
    requestedModelId: "gpt-5.6-codex",
    canonicalModelId: "gpt-5.6-codex",
    stateRevision: 1,
    generation: 4,
  });
  assert.equal(selection.route.accountFingerprint, "acct_a");
  runtime.observeStateEpoch(1, 5);
  assert.throws(() => selection.assertCurrent(), /stale|generation/i);
  assert.deepEqual(runtime.currentCatalog({ connectionId: "codex-a", stateRevision: 1, generation: 5 }), []);
  assert.equal(clients.get("codex-a")?.taskBytes, 0);
});

test("official 0.159 model metadata preserves manual catalog selection without publishing runtime extras", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), 'orcode-codex-catalog-'));
  t.after(() => rm(appHome, {recursive:true, force:true}));
  const stateStore = new ProviderStateStore(codexState([codexConnection('codex-a', HOME_A, 'acct_a')]));
  const runtime = new CodexProfileRouteRuntime({appHome, stateStore,
    createClient:async () => new FakeCodexClient('codex-a', {
      modelSpecialty:null, multiAgentVersion:'v2', availableAccessPrograms:{cyber:['standard']},
    }),
  });
  const models = await runtime.listModelsForProfile({connectionId:'codex-a', stateRevision:1,
    generation:4, signal:new AbortController().signal});
  assert.equal(models.length, 1);
  assert.equal(models[0].canonicalModelId, 'gpt-5.6-codex');
  assert.equal(stateStore.read().defaultRoute, null, 'catalog discovery is not model selection');
  assert.doesNotMatch(JSON.stringify(models), /availableAccessPrograms|multiAgentVersion|modelSpecialty/);
});

test("malformed new model metadata still fails closed", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), 'orcode-codex-invalid-catalog-'));
  t.after(() => rm(appHome, {recursive:true, force:true}));
  for (const extras of [{multiAgentVersion:'unexpected'}, {modelSpecialty:42},
    {availableAccessPrograms:{cyber:['unapproved']}}, {availableAccessPrograms:{cyber:[], token:'private'}}]) {
    const stateStore = new ProviderStateStore(codexState([codexConnection('codex-a', HOME_A, 'acct_a')]));
    const runtime = new CodexProfileRouteRuntime({appHome, stateStore,
      createClient:async () => new FakeCodexClient('codex-a', extras),
    });
    await assert.rejects(runtime.listModelsForProfile({connectionId:'codex-a', stateRevision:1,
      generation:4, signal:new AbortController().signal}), /model response/i);
    assert.equal(stateStore.read().defaultRoute, null);
  }
});

test("atomically activates a provider-runtime Codex route without any keychain reservation", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-route-activation-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const initial = codexState([codexConnection("codex-a", HOME_A, "acct_a")]);
  let durable = structuredClone(initial);
  const stateStore = new ProviderStateStore(initial, {
    async persist(request) {
      request.assertCurrent();
      const next = request.build(structuredClone(durable));
      durable = structuredClone(next);
      request.adopt(next);
      return structuredClone(next);
    },
  });
  const keychainCalls: string[] = [];
  const credentials = new Proxy({ location: "test-keychain" }, {
    get(target, property, receiver) {
      if (property === "location") return Reflect.get(target, property, receiver);
      return (..._args: unknown[]) => {
        keychainCalls.push(String(property));
        throw new Error("Codex route activation must not touch the keychain");
      };
    },
  });
  const coordinator = new ProviderActivationCoordinator({
    appHome,
    configPath: join(appHome, "config.json"),
    privateStore: new PrivateStore({ root: appHome }),
    credentials: credentials as never,
    adapterResolver: () => { throw new Error("Codex route activation must not resolve a candidate adapter"); },
    stateStore,
    runtimeGuard: {
      async acquire() {
        return { async assertHeld() {}, assertHeldSynchronously() {}, async release() {} };
      },
    },
    now: () => 1_000,
    createUuid: () => "20000000-0000-4000-8000-000000000001",
  });
  const registry = new BackendRegistry([{
    descriptor: CODEX_DESCRIPTOR,
    adapter: inertCodexAdapter(),
  }]);
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator: coordinator });
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "codex",
    accountFingerprint: "acct_a",
    billingRealm: "chatgpt-subscription-provider-managed-overage",
    requestedModelId: "gpt-5.6-codex",
    canonicalModelId: "gpt-5.6-codex",
    resolutionState: "resolved",
  };
  let selectionCurrent = true;
  let bound: { stateRevision: number; generation: number } | null = null;
  const selection = {
    connectionId: "codex-a",
    route,
    assertCurrent() {
      if (!selectionCurrent) throw new Error("stale selection");
    },
    bind(input: { stateRevision: number; generation: number }) {
      bound = input;
    },
  };

  const result = await orchestrator.activateCodexRoute({
    backendId: "codex",
    expectedRevision: 1,
    selection,
    startupGeneration: 1,
    requireFreshDesktopGeneration: true,
    signal: new AbortController().signal,
    deadlineAt: 2_000,
  });
  selectionCurrent = false;

  assert.equal(result.persisted, true);
  assert.deepEqual(result.route, route);
  assert.deepEqual(durable.defaultRoute, route);
  assert.deepEqual(bound, { stateRevision: 2, generation: 1 });
  assert.deepEqual(orchestrator.ensureRunnableRoute(route), route);
  assert.deepEqual(keychainCalls, []);
});

function codexSnapshot(routes: readonly DesktopRouteCandidate[]): DesktopCapabilitySnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    generation: 1,
    routeRunnable: false,
    activeRoute: null,
    providers: [{
      providerId: "codex",
      providerLabel: "ChatGPT / Codex",
      connectionId: "codex-a",
      accountLabel: "Persoenliches ChatGPT",
      state: "ready",
      setupMethods: ["codex-browser-login", "codex-device-login"],
      multiProfile: { enabled: false, disabled: DESKTOP_DISABLED_COPY["codex-profile-isolation-unproven"] },
      routes: [...routes],
      repair: DESKTOP_DISABLED_COPY["setup-method-unavailable"],
    }],
    undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  };
}

function publicRoute(handle: string): DesktopRouteCandidate {
  return {
    handle,
    providerId: "codex",
    connectionId: "codex-a",
    accountLabel: "Persoenliches ChatGPT",
    canonicalModelId: "gpt-5.6-codex",
    displayName: "GPT-5.6 Codex",
    reasoning: "supported",
    capabilities: ["text", "image-input", "tools", "reasoning"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    runnable: true,
  };
}

function codexState(connections: ProviderConnectionStateV3[]): ProviderSetupStateV3 {
  return {
    schemaVersion: 3,
    revision: 1,
    lifecycle: "configured",
    connections,
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function codexConnection(id: string, homeId: string, accountFingerprint: string): ProviderConnectionStateV3 {
  return {
    id,
    backendId: "codex",
    enabled: true,
    maturity: "preview",
    credentialBinding: { kind: "provider-runtime", homeId: homeId as never },
    accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "chatgpt-subscription-provider-managed-overage",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "available",
      runtime: "ready",
      observedAt: 1,
      generation: 4,
    },
  };
}

function inertCodexAdapter(): BackendAdapter {
  return {
    backendId: "codex",
    async inspect() { throw new Error("not used"); },
    async connect() { throw new Error("not used"); },
    async listModels() { return []; },
    async activate() { throw new Error("not used"); },
    async reconnect() { throw new Error("not used"); },
    async logout() {},
    async discardCandidate() {},
  };
}

class FakeCodexClient implements CodexAccountModelClient {
  readonly taskBytes = 0;
  readonly #listeners = new Set<(params: unknown) => void>();

  constructor(readonly connectionId: string, readonly modelExtras: Record<string, unknown> = {}) {}

  onNotification(_method: "account/updated", listener: (params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    for (const listener of this.#listeners) listener({ authMode: "chatgpt", planType: "pro" });
  }

  async request<T>(method: string): Promise<T> {
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "private@example.invalid", planType: "pro" },
        requiresOpenaiAuth: true,
      } as T;
    }
    if (method === "model/list") {
      return {
        data: [{
          id: "gpt-5.6-codex",
          model: "gpt-5.6-codex",
          displayName: "GPT-5.6 Codex",
          description: "Codex",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
          inputModalities: ["text", "image"],
          ...this.modelExtras,
        }],
        nextCursor: null,
      } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async drain(): Promise<"closed"> { return "closed"; }
}
