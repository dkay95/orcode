import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateStore } from "../src/private-store.js";
import { DefaultProviderRuntime, ProviderCredentialForgetJournal, loadProviderModelSnapshot } from "../src/cli.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { BackendRegistry, type RouteIdentityV1 } from "../src/backends.js";
import { ProviderStateStore } from "../src/provider-state.js";
import { NanoGptBackendAdapter, NANO_GPT_DESCRIPTOR } from "../src/nanogpt-backend.js";
import { NanoGptService, nanoGptAccountFingerprint } from "../src/nanogpt.js";
import { readModelRuntimeIdentity } from "../src/agent.js";
import { OpenRouterService } from "../src/openrouter.js";
import type { ProviderCredentialAuthorityLike, ProviderCredentialUseContext } from "../src/provider-authority.js";
import type { ProviderSetupStateV3 } from "../src/provider-state.js";
import type { SetupOrchestrator } from "../src/setup.js";

const KEY = "fixture-nano-cli-key";
const HMAC = new Uint8Array(32).fill(8);
function fixture(mode: "subscription" | "payg" = "subscription", additionalModelId?: string) {
  const route: RouteIdentityV1 = { version: 1, backendId: "nano-gpt", accountFingerprint: nanoGptAccountFingerprint(HMAC, KEY), billingRealm: mode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg", requestedModelId: "vendor/tools", canonicalModelId: "vendor/tools", resolutionState: "resolved" };
  const health = { credential: "valid" as const, connectivity: "connected" as const, spend: "unknown" as const, runtime: "not-applicable" as const, observedAt: Date.now(), generation: 1 };
  const state: ProviderSetupStateV3 = { schemaVersion: 3, revision: 1, lifecycle: "configured", connections: [{ id: "nano-owner", backendId: "nano-gpt", enabled: true, maturity: "preview", credentialBinding: { kind: "orcode-keychain", pointer: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" }, accountFingerprint: route.accountFingerprint, accountFingerprintState: "verified", billingRealm: route.billingRealm, lastHealth: health }], defaultRoute: route, cross: { enabled: false, preferredLead: null, preferredChallenger: null } };
  const stateStore = new ProviderStateStore(state);
  const requests: unknown[] = [];
  const context: ProviderCredentialUseContext = { source: "saved", candidatePermit: { version: 1 }, async publishIfCurrent(publish) { publish(); }, binding: { version: 2, stateRevision: 1, connectionId: "nano-owner", backendId: "nano-gpt", enabled: true, credentialPointer: { kind: "versioned", slot: { version: 1, kind: "nano-gpt", id: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" } }, accountFingerprint: route.accountFingerprint, billingRealm: route.billingRealm as "nanogpt-subscription" | "nanogpt-payg", isDefault: true } };
  const authority: ProviderCredentialAuthorityLike = { async withCredential(request, use) { requests.push(request); return { kind: "available", value: await use(KEY, context) }; }, async withCredentialUnderLease(request, lease, use) { await lease.assertHeld(); requests.push(request); return { kind: "available", value: await use(KEY, context) }; } };
  const calls: string[] = [];
  const service = new NanoGptService({ fetchImpl: async (url) => { calls.push(url); return new Response(JSON.stringify(url.endsWith("usage") ? { active: true, state: "active", routing: { recommendedMode: "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: mode === "payg" } } : { data: [{ id: "vendor/tools", name: "Nano fixture", capabilities: { tool_calling: true } }, { id: "vendor/text", capabilities: {} }, ...(additionalModelId ? [{ id: additionalModelId, capabilities: { tool_calling: true } }] : [])] })); } });
  const adapter = new NanoGptBackendAdapter({ service, credentialAuthority: authority, credentials: { async getOrCreateAccountHmacKey() { return HMAC; } } });
  const registry = new BackendRegistry([{ descriptor: NANO_GPT_DESCRIPTOR, adapter }]);
  const lease = { async assertHeld() {}, async release() {} };
  const coordinator = { async readAuthority<T>(_request: unknown, use: (held: { assertHeld(): Promise<void> }) => Promise<T>) { return use(lease); }, async runExclusive<T>(_request: unknown, use: (held: { assertHeld(): Promise<void> }) => Promise<T>) { return use(lease); } };
  const orchestrator = { currentGeneration: () => stateStore.read().connections[0]?.lastHealth?.generation ?? 1, nextStartupGeneration: () => (stateStore.read().connections[0]?.lastHealth?.generation ?? 1) + 1, ensureRunnableRoute: () => stateStore.read().defaultRoute!, async activateCandidate(_request: Parameters<SetupOrchestrator["activateCandidate"]>[0]): Promise<Awaited<ReturnType<SetupOrchestrator["activateCandidate"]>>> { throw new Error("unused activation"); } };
  const runtime = new DefaultProviderRuntime(new OpenRouterService(undefined, undefined, {}, { fetchImpl: async () => { throw new Error("OpenRouter must not be contacted"); } }), {} as never, registry, stateStore, orchestrator as never, coordinator as never, { async acquire() { return lease; }, beginRun() { return () => {}; } } as never, { async apply() { throw new Error("unused"); } }, null, null, route.requestedModelId, structuredClone(DEFAULT_CONFIG), undefined, { credentialAuthority: authority as never, adapter: {} as never, nanoAdapter: adapter, nanoService: service, forgetJournal: {} as never, async recover() {} });
  return { runtime, route, calls, requests, stateStore, orchestrator, adapter };
}

test("CLI Nano status and settings preserve the selected billing owner", () => {
  for (const mode of ["subscription", "payg"] as const) {
    const { runtime } = fixture(mode);
    const status = runtime.readCachedProviderStatus();
    assert.equal(status[0]?.backendId, "nano-gpt");
    assert.equal(status[0]?.billingRealm, mode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg");
    assert.equal(runtime.readCachedSettingsRoute()?.backendId, "nano-gpt");
    assert.equal(runtime.readCachedSettingsProjection().providers[0]?.displayName, "Nano-GPT");
  }
});

test("CLI Nano model listing authenticates Nano and never reads OpenRouter catalog", async () => {
  const { runtime, calls } = fixture();
  const result = await runtime.execute({ kind: "models", backendId: "nano-gpt" }, "plain");
  assert.equal(result.kind, "models");
  if (result.kind !== "models") return;
  assert.equal(result.backendId, "nano-gpt");
  assert.deepEqual(result.models.map((model) => model.canonicalModelId), ["vendor/tools", "vendor/text"]);
  assert.deepEqual(calls, ["https://api.nano-gpt.com/api/subscription/v1/usage", "https://api.nano-gpt.com/api/subscription/v1/models?detailed=true"]);
});

test("CLI creates version-bound Nano runtime identity without exposing its secret", () => {
  const { runtime, route } = fixture("payg");
  const modelRuntime = runtime.modelRuntime(route);
  assert.equal(modelRuntime.backendId, "nano-gpt");
  assert.deepEqual(readModelRuntimeIdentity(modelRuntime), { version: 1, stateRevision: 1, generation: 1, connectionId: "nano-owner", backendId: "nano-gpt", route });
  assert.equal(JSON.stringify(modelRuntime).includes(KEY), false);
  assert.equal(runtime.modelRuntime(route), modelRuntime);
});

test("desktop Nano account refresh projects real manual tools catalog and billing label", async () => {
  const { runtime, calls } = fixture();
  const authority = runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const nano = before.providers.find((provider) => provider.providerId === "nano-gpt");
  assert.ok(nano);
  assert.match(nano.accountLabel ?? "", /Abo/);
  assert.deepEqual(nano.setupMethods, ["nanogpt-owner-connect"]);
  const refreshed = await authority.refreshAccount!({ providerId: "nano-gpt", connectionId: "nano-owner", revision: before.revision, generation: before.generation });
  const candidates = refreshed.providers.filter((provider) => provider.providerId === "nano-gpt").flatMap((provider) => provider.routes);
  assert.equal(candidates.find((entry) => entry.canonicalModelId === "vendor/tools")?.runnable, true);
  assert.equal(candidates.find((entry) => entry.canonicalModelId === "vendor/text")?.runnable, false);
  assert.equal(calls.length, 2);
});

test("retained Nano enable reuses the exact chosen billing owner", async () => {
  const { runtime } = fixture("payg");
  const result = await runtime.execute({ kind: "enable", backendId: "nano-gpt" }, "plain");
  assert.deepEqual(result, { kind: "setup", backendId: "nano-gpt", outcome: "ready" });
});

for (const mode of ["subscription", "payg"] as const) {
  test(`retained Nano ${mode} enable keeps its selected owner when both billing modes are stored`, async () => {
    const { runtime, route, stateStore, calls, requests } = fixture(mode);
    await stateStore.commit(1, (state) => ({ ...state, connections: [
      { ...state.connections[0]!, id: "nano-other-mode", billingRealm: mode === "subscription" ? "nanogpt-payg" : "nanogpt-subscription", credentialBinding: { kind: "orcode-keychain", pointer: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0722" } },
      ...state.connections,
    ] }));
    const noSetup = { async chooseHub() { throw new Error("An exact retained Nano owner must not ask for billing again"); }, async readSecret() { throw new Error("An exact retained Nano owner must not ask for a new secret"); }, async chooseModel() { throw new Error("An exact retained Nano owner must not choose a different model"); }, async confirm() { return false; }, present() {} };
    const result = await runtime.execute({ kind: "enable", backendId: "nano-gpt" }, noSetup);
    assert.deepEqual(result, { kind: "setup", backendId: "nano-gpt", outcome: "ready" });
    assert.deepEqual(runtime.currentSessionRoute(), route);
    assert.equal(readModelRuntimeIdentity(runtime.modelRuntime(route))?.connectionId, "nano-owner");
    assert.deepEqual(calls, []);
    assert.deepEqual(requests, []);
  });
}

test("disabled exact Nano enable publishes its inspected manual model catalog into the new desktop epoch", async () => {
  const { runtime, route, stateStore, calls } = fixture();
  await stateStore.commit(1, (state) => ({ ...state, connections: state.connections.map((connection) => ({ ...connection, enabled: false })) }));
  const noSetup = { async chooseHub() { throw new Error("Retained exact Nano route must not choose billing again"); }, async readSecret() { throw new Error("Retained exact Nano route must not replace the key"); }, async chooseModel() { throw new Error("Retained exact Nano route must not change models"); }, async confirm() { return false; }, present() {} };
  assert.deepEqual(await runtime.execute({ kind: "enable", backendId: "nano-gpt" }, noSetup), { kind: "setup", backendId: "nano-gpt", outcome: "ready" });
  const snapshot = runtime.desktopOnboardingAuthority().snapshot();
  const models = snapshot.providers.filter((provider) => provider.providerId === "nano-gpt").flatMap((provider) => provider.routes);
  assert.equal(models.find((model) => model.canonicalModelId === route.canonicalModelId)?.runnable, true);
  assert.equal(models.find((model) => model.canonicalModelId === "vendor/text")?.runnable, false);
  assert.equal(calls.length, 2);
});

test("Nano logout confirmation names Nano and cannot target the OpenRouter credential", async () => {
  const { runtime } = fixture();
  const result = await runtime.execute({ kind: "logout", backendId: "nano-gpt" }, "plain");
  assert.equal(result.kind, "confirmation-required");
  if (result.kind === "confirmation-required") {
    assert.equal(result.backendId, "nano-gpt");
    assert.match(result.message, /Nano-GPT/);
  }
});

test("Nano forget journal binds the exact Nano slot for recoverable logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orcode-nano-forget-"));
  try {
    const journal = new ProviderCredentialForgetJournal({ appHome: directory, privateStore: new PrivateStore({ root: directory }) });
    const transaction = await journal.begin({ backendId: "nano-gpt", connectionId: "nano-owner", target: { kind: "versioned", slot: { version: 1, kind: "nano-gpt", id: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" } } });
    assert.equal(transaction.manifest.version, 2);
    const resumed = await journal.resume();
    assert.ok(resumed);
    assert.equal(resumed.manifest.version === 2 && resumed.manifest.backendId, "nano-gpt");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dashboard Nano model metadata does not fetch an OpenRouter snapshot", async () => {
  const { runtime } = fixture();
  await runtime.execute({ kind: "models", backendId: "nano-gpt" }, "plain");
  const result = await loadProviderModelSnapshot({ openRouter: runtime.openRouter, providerRuntime: runtime }, "vendor/tools");
  assert.equal(result.status, "available");
  assert.equal(result.model?.name, "Nano fixture");
  assert.equal(result.model?.promptPrice, -1);
});

test("desktop Nano setup asks billing and model explicitly and reconciles only Nano proof", async () => {
  const { runtime, route, orchestrator, stateStore, adapter } = fixture();
  orchestrator.activateCandidate = async (request) => {
    assert.equal(request.backendId, "nano-gpt");
    assert.equal(request.billingMode, "subscription");
    assert.equal(request.candidate, KEY);
    assert.equal(request.persistence, "persisted");
    assert.equal(request.environmentEligibility, "forbidden");
    const candidate = await adapter.connect({ connectionId: "nano-owner", candidate: { apiKey: KEY, billingMode: "subscription" }, generation: 2, deadlineAt: request.deadlineAt ?? Date.now() + 1000, signal: request.signal });
    const models = await adapter.listModels({ candidateId: candidate.candidateId, signal: request.signal });
    await adapter.activate({ candidateId: candidate.candidateId, model: models.find((model) => model.canonicalModelId === "vendor/tools")!, signal: request.signal });
    const published = await stateStore.commit(1, (state) => ({ ...state, connections: state.connections.map((connection) => ({ ...connection, lastHealth: { ...connection.lastHealth!, generation: 2 } })), defaultRoute: route }));
    return { route, state: published, persisted: true, warnings: [] };
  };
  const asked: string[] = [];
  const result = await runtime.runDesktopNanoGptSetup({ async chooseHub(entries) { asked.push("billing"); assert.deepEqual(entries.map((entry) => entry.id), ["nano-gpt:subscription", "nano-gpt:payg"]); return "nano-gpt:subscription"; }, async readSecret(request) { asked.push("secret"); assert.equal(request.backendId, "nano-gpt"); return KEY; }, async chooseModel(request) { asked.push("model"); assert.equal(request.backendId, "nano-gpt"); return "vendor/tools"; }, async confirm() { return true; }, present() {} }, new AbortController().signal);
  assert.equal(result.kind, "ready");
  assert.deepEqual(asked, ["billing", "secret", "model"]);
  assert.ok(runtime.reconcileDesktopNanoGptSetupCommit(result));
  assert.equal(runtime.reconcileDesktopOpenRouterSetupCommit(result), null);
});

for (const catalogFailure of ["reject", "abort"] as const) {
test(`post-commit Nano catalog ${catalogFailure} preserves exact adoption and public route proof`, async () => {
  const { runtime, route, orchestrator, stateStore, adapter } = fixture("subscription", "vendor/next-tools");
  await runtime.execute({ kind: "enable", backendId: "nano-gpt" }, "plain");
  const authority = runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const catalog = await authority.refreshAccount!({ providerId: "nano-gpt", connectionId: "nano-owner", revision: before.revision, generation: before.generation });
  const next = catalog.providers.flatMap((provider) => provider.routes).find((model) => model.canonicalModelId === "vendor/next-tools")!;
  const selectedRoute = { ...route, requestedModelId: "vendor/next-tools", canonicalModelId: "vendor/next-tools" };
  orchestrator.activateCandidate = async (request) => {
    assert.equal(request.selectedCanonicalModelId, "vendor/next-tools");
    const published = await stateStore.commit(1, (state) => ({ ...state, connections: state.connections.map((connection) => ({ ...connection, lastHealth: { ...connection.lastHealth!, generation: 2 } })), defaultRoute: selectedRoute }));
    return { route: selectedRoute, state: published, persisted: true, warnings: [] };
  };
  const listModels = adapter.listModels.bind(adapter);
  const caller = new AbortController();
  adapter.listModels = async (request) => {
    if (stateStore.read().revision > 1) {
      if (catalogFailure === "abort") caller.abort(new DOMException("Owner cancelled after commit", "AbortError"));
      throw new Error("Post-commit catalog deadline elapsed");
    }
    return listModels(request);
  };
  const accepted = await authority.activate({ providerId: "nano-gpt", connectionId: "nano-owner", routeHandle: next.handle, revision: catalog.revision, generation: catalog.generation }, caller.signal);
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.generation, 2);
  assert.notEqual(accepted.routeHandle, next.handle);
  assert.equal(stateStore.read().defaultRoute?.requestedModelId, "vendor/next-tools");
  assert.equal(runtime.readCachedSettingsRoute()?.requestedModelId, "vendor/next-tools");
  assert.equal(authority.snapshot().providers.flatMap((provider) => provider.routes).find((model) => model.canonicalModelId === "vendor/next-tools")?.runnable, true);
});
}
