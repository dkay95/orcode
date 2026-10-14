import assert from "node:assert/strict";
import test from "node:test";
import { NanoGptBackendAdapter } from "../src/nanogpt-backend.js";
import { NanoGptService, nanoGptAccountFingerprint } from "../src/nanogpt.js";
import type { ProviderCredentialAuthorityLike, ProviderCredentialUseContext } from "../src/provider-authority.js";

const KEY = "fixture-nanogpt-backend-key";
const LOCAL_KEY = new Uint8Array(32).fill(19);
const fingerprint = nanoGptAccountFingerprint(LOCAL_KEY, KEY);
const signal = () => new AbortController().signal;
const req = (generation = 1) => ({ connectionId: "nano-connection", generation, signal: signal(), deadlineAt: 50_000, environmentEligibility: "forbidden" as const });
const candidate = (mode: "subscription" | "payg" = "subscription", generation = 1) => ({ ...req(generation), candidate: { apiKey: ` ${KEY}\n`, billingMode: mode } });
function context(mode: "subscription" | "payg" = "subscription"): ProviderCredentialUseContext {
  return { source: "saved", candidatePermit: { version: 1 }, async publishIfCurrent(publish) { publish(); }, binding: { version: 2, stateRevision: 1, connectionId: "nano-connection", backendId: "nano-gpt", enabled: true, credentialPointer: { kind: "versioned", slot: { version: 1, kind: "nano-gpt", id: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" } }, accountFingerprint: fingerprint, billingRealm: mode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg", isDefault: true } };
}
function service(calls: string[], paid = false): NanoGptService {
  return new NanoGptService({ now: () => 10_000, fetchImpl: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(url.endsWith("usage") ? { active: true, state: "active", routing: { recommendedMode: "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: paid } } : { data: [{ id: "vendor/tools", context_length: 100000, capabilities: { tool_calling: true, reasoning: false } }, { id: "vendor/text", capabilities: {} }] }));
  } });
}
function adapter(calls: string[], authority?: ProviderCredentialAuthorityLike, paid = false) {
  return new NanoGptBackendAdapter({ service: service(calls, paid), credentials: { async getOrCreateAccountHmacKey() { return LOCAL_KEY; } }, credentialAuthority: authority ?? { async withCredential(_request, use) { return { kind: "available", value: await use(KEY, context()) }; } }, now: () => 10_000, createCandidateId: () => "nano-candidate", createConnectionId: () => "nano-connection" });
}

test("Nano activation requires explicit billing and a catalog-validated exact model", async () => {
  const calls: string[] = [];
  const backend = adapter(calls);
  const connected = await backend.connect(candidate());
  assert.equal(connected.billingRealm, "nanogpt-subscription");
  assert.equal(connected.accountFingerprint, fingerprint);
  assert.equal(JSON.stringify(connected).includes(KEY), false);
  const models = await backend.listModels({ candidateId: connected.candidateId, signal: signal() });
  assert.equal(models[0]?.capabilities.tools, true);
  assert.equal(models[1]?.capabilities.tools, false);
  await assert.rejects(backend.activate({ candidateId: connected.candidateId, model: { ...models[0]!, canonicalModelId: "vendor/paid-other" }, signal: signal() }));
  const active = await backend.activate({ candidateId: connected.candidateId, model: models[0]!, signal: signal() });
  assert.equal(active.route.requestedModelId, "vendor/tools");
  assert.equal(active.route.billingRealm, "nanogpt-subscription");
  assert.equal(calls.length, 2);
});

test("untyped key candidates and omitted billing choices cannot connect", async () => {
  const calls: string[] = [];
  const backend = adapter(calls);
  for (const value of [KEY, { apiKey: KEY }, { apiKey: KEY, billingMode: "auto" }]) await assert.rejects(backend.connect({ ...req(), candidate: value }));
  assert.equal(calls.length, 0);
});

test("saved Nano inspection derives billing mode from the exact owner-only binding", async () => {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const backend = adapter(calls, { async withCredential(request, use) { requests.push(request); return { kind: "available", value: await use(KEY, context("payg")) }; } }, true);
  const inspected = await backend.inspect(req());
  assert.equal(inspected.billingRealm, "nanogpt-payg");
  assert.equal(inspected.routeEligible, true);
  assert.equal(inspected.health.spend, "unknown");
  assert.equal((requests[0] as Record<string, unknown>).environmentEligibility, "forbidden");
  assert.equal((requests[0] as Record<string, unknown>).backendId, "nano-gpt");
  assert.equal(calls[1], "https://api.nano-gpt.com/api/v1/models?detailed=true");
});

test("environment keys and crossed billing bindings cannot publish model metadata", async () => {
  const calls: string[] = [];
  const crossed = context(); crossed.source = "environment";
  const backend = adapter(calls, { async withCredential(_request, use) { return { kind: "available", value: await use(KEY, crossed) }; } });
  assert.equal((await backend.inspect(req())).routeEligible, false);
  assert.equal(calls.length, 0);
  await assert.rejects(backend.listModels({ connectionId: "nano-connection", signal: signal() }));
});

test("newer generations invalidate candidate activation without a paid fallback", async () => {
  const backend = adapter([]);
  const connected = await backend.connect(candidate());
  const models = await backend.listModels({ candidateId: connected.candidateId, signal: signal() });
  await backend.inspect(req(2));
  await assert.rejects(backend.activate({ candidateId: connected.candidateId, model: models[0]!, signal: signal() }));
});

test("authority lease loss after network cannot publish a candidate", async () => {
  const backend = adapter([]);
  let checks = 0;
  await assert.rejects(backend.connectUnderAuthorityLease(candidate(), { async assertHeld() { if (++checks > 1) throw new Error(KEY); } }), (error: unknown) => error instanceof Error && !`${error.stack}${JSON.stringify(error)}`.includes(KEY));
  await assert.rejects(backend.listModels({ candidateId: "nano-candidate", signal: signal() }));
});

test("a stale credential fingerprint cannot publish an inspected catalog", async () => {
  const wrong = context(); wrong.binding.accountFingerprint = "acct_nano_wrong";
  const backend = adapter([], { async withCredential(_request, use) { return { kind: "available", value: await use(KEY, wrong) }; } });
  assert.equal((await backend.inspect(req())).routeEligible, false);
  await assert.rejects(backend.listModels({ connectionId: "nano-connection", signal: signal() }));
});

test("same-generation delayed inspection cannot replace a newer published result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const backend = adapter([], { async withCredential(_request, use) { if (++attempts === 1) await gate; return { kind: "available", value: await use(KEY, context()) }; } });
  const first = backend.inspect(req());
  const second = await backend.inspect(req());
  release();
  assert.equal(second.routeEligible, true);
  assert.equal((await first).routeEligible, false);
  assert.equal((await backend.listModels({ connectionId: "nano-connection", signal: signal() })).length, 2);
});

test("forget-pending credentials never perform metadata network access", async () => {
  const calls: string[] = [];
  const backend = adapter(calls, { async withCredential() { return { kind: "forget-pending" }; } });
  assert.equal((await backend.inspect(req())).routeEligible, false);
  assert.equal(calls.length, 0);
});

test("timed-out authority publication cannot publish metadata after inspection returned", async () => {
  let latePublish: (() => void) | undefined;
  const backend = adapter([], { async withCredential(_request, use) {
    const delayed = context();
    delayed.publishIfCurrent = async (publish) => { latePublish = publish; await new Promise<void>(() => {}); };
    return { kind: "available", value: await use(KEY, delayed) };
  } });
  const result = await backend.inspect({ ...req(), deadlineAt: 10_025 });
  assert.equal(result.routeEligible, false);
  assert.ok(latePublish);
  latePublish();
  await assert.rejects(backend.listModels({ connectionId: "nano-connection", signal: signal() }));
});
