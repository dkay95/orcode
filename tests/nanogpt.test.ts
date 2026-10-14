import assert from "node:assert/strict";
import test from "node:test";
import { NanoGptService, NanoGptRequestError, nanoGptAccountFingerprint } from "../src/nanogpt.js";

const KEY = "fixture-nanogpt-key";
const request = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
const usage = (overrides = {}) => ({ active: true, state: "active", limits: {}, dailyInputTokens: null, weeklyInputTokens: null, dailyImages: null, period: { currentPeriodEnd: null }, routing: { recommendedMode: "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: false }, ...overrides });
const model = { id: "vendor/model", name: "Fixture", context_length: 128000, capabilities: { tool_calling: true, reasoning: false }, pricing: { prompt: 2, completion: 8, currency: "USD", unit: "per_million_tokens" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("subscription inspection authenticates before reading the subscription-only catalog", async () => {
  const calls: string[] = [];
  const service = new NanoGptService({ fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${KEY}`);
    return json(calls.length === 1 ? usage() : { data: [model, { id: "vendor/unknown" }, { id: "auto-model" }] });
  } });
  const result = await service.inspect(KEY, "subscription", request());
  assert.deepEqual(calls, ["https://api.nano-gpt.com/api/subscription/v1/usage", "https://api.nano-gpt.com/api/subscription/v1/models?detailed=true"]);
  assert.equal(result.spend, "available");
  assert.deepEqual(result.models[0], { id: "vendor/model", name: "Fixture", contextLength: 128000, tools: true, reasoning: false, promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000008 });
  assert.equal(result.models.length, 2);
  assert.equal(result.models[1]?.tools, false);
  assert.equal(result.models[1]?.promptUsdPerToken, null);
});

test("an invalid key cannot authenticate through a public model catalog", async () => {
  let calls = 0;
  const service = new NanoGptService({ fetchImpl: async () => { calls++; return json({ error: KEY }, 401); } });
  await assert.rejects(service.inspect(KEY, "payg", request()), (error: unknown) => error instanceof NanoGptRequestError && error.failure.code === "nanogpt-auth-rejected" && !JSON.stringify(error).includes(KEY));
  assert.equal(calls, 1);
});

test("subscription mode refuses a paid-capable key before catalog or generation", async () => {
  let calls = 0;
  const service = new NanoGptService({ fetchImpl: async () => { calls++; return json(usage({ routing: { recommendedMode: "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: true } })); } });
  await assert.rejects(service.inspect(KEY, "subscription", request()), /subscription-only/i);
  assert.equal(calls, 1);
});

test("PAYG uses a full public catalog and forces PAYGO without retaining Responses state", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = new NanoGptService({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/usage")) return json(usage({ routing: { recommendedMode: "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: true } }));
    if (url.includes("/models")) { assert.equal(new Headers(init.headers).has("authorization"), false); return json({ data: [model] }); }
    return new Response("data: fixture\n\n");
  } });
  const result = await service.inspect(KEY, "payg", request());
  assert.equal(result.spend, "unknown");
  const response = await service.requestResponses(KEY, "payg", { model: "vendor/model", input: "Hello", stream: true, store: true, retentionDays: 9, previous_response_id: "private", provider: { order: ["paid"] }, advisor: { model: "other" }, tools: [{ type: "function", name: "test", parameters: {} }] }, request());
  assert.equal(await response.text(), "data: fixture\n\n");
  const post = calls.at(-1)!;
  assert.equal(post.url, "https://api.nano-gpt.com/api/v1/responses");
  assert.equal(new Headers(post.init.headers).get("X-Billing-Mode"), "paygo");
  assert.deepEqual(JSON.parse(String(post.init.body)), { model: "vendor/model", input: "Hello", stream: true, tools: [{ type: "function", name: "test", parameters: {} }], store: false, retention_days: 0, billing_mode: "paygo" });
});

test("subscription generation refreshes policy and never retries exhausted quota as paid", async () => {
  let calls = 0;
  const service = new NanoGptService({ fetchImpl: async () => { calls++; return json(usage({ routing: { recommendedMode: "unavailable", subscriptionQuotaAvailable: false, paidSpendPolicyAllowsBalance: false } })); } });
  await assert.rejects(service.requestResponses(KEY, "subscription", { model: "vendor/model", input: "hello" }, request()), (error: unknown) => error instanceof NanoGptRequestError && error.failure.code === "nanogpt-limit-reached");
  assert.equal(calls, 1);
});

test("temporarily unknown subscription quota stays unknown and never permits paid spending", async () => {
  const calls: RequestInit[] = [];
  const service = new NanoGptService({ fetchImpl: async (url, init) => {
    calls.push(init);
    if (url.endsWith("/usage")) return json(usage({ routing: {
      recommendedMode: "subscription", subscriptionQuotaAvailable: null, paidSpendPolicyAllowsBalance: false,
    } }));
    if (url.includes("/models")) return json({ data: [model] });
    return new Response("data: fixture\n\n");
  } });
  assert.equal((await service.inspect(KEY, "subscription", request())).spend, "unknown");
  await (await service.requestResponses(KEY, "subscription", { model: "vendor/model", input: "x" }, request())).text();
  const post = calls.at(-1)!;
  assert.equal(new Headers(post.headers).has("X-Billing-Mode"), false);
  assert.equal(JSON.parse(String(post.body)).billing_mode, undefined);
});

test("automatic model selectors and hosted paid tools are rejected before network", async () => {
  let calls = 0;
  const service = new NanoGptService({ fetchImpl: async () => { calls++; return json(usage()); } });
  for (const body of [{ model: "auto-model-best", input: "x" }, { model: "vendor/model:online", input: "x" }, { model: "vendor/model", input: "x", tools: [{ type: "web_search" }] }]) {
    await assert.rejects(service.requestResponses(KEY, "subscription", body, request()), NanoGptRequestError);
  }
  assert.equal(calls, 0);
});

test("untrusted transport errors and oversized metadata are safely bounded", async () => {
  const service = new NanoGptService({ fetchImpl: async () => { throw new Error(`private ${KEY}`); } });
  await assert.rejects(service.inspect(KEY, "payg", request()), (error: unknown) => error instanceof NanoGptRequestError && !`${error.stack}${JSON.stringify(error)}`.includes(KEY));
  const large = new NanoGptService({ fetchImpl: async () => new Response("x".repeat(600_000)) });
  await assert.rejects(large.inspect(KEY, "subscription", request()), NanoGptRequestError);
});

test("absolute deadlines bound fetch implementations that ignore cancellation", async () => {
  const service = new NanoGptService({ fetchImpl: async () => new Promise<Response>(() => {}) });
  await assert.rejects(service.inspect(KEY, "payg", { signal: new AbortController().signal, deadlineAt: Date.now() + 25 }), NanoGptRequestError);
});

test("Nano account identity is normalized HMAC and domain-separated from raw secrets", () => {
  const key = new Uint8Array(32).fill(4);
  assert.match(nanoGptAccountFingerprint(key, KEY), /^acct_nano_[A-Za-z0-9_-]{43}$/);
  assert.equal(nanoGptAccountFingerprint(key, `  ${KEY}\n`), nanoGptAccountFingerprint(key, KEY));
  assert.notEqual(nanoGptAccountFingerprint(new Uint8Array(32).fill(5), KEY), nanoGptAccountFingerprint(key, KEY));
});

test("subscription generation remains stateless and sends no unsupported subscription override", async () => {
  let posted: RequestInit | undefined;
  const service = new NanoGptService({ fetchImpl: async (url, init) => {
    if (url.endsWith("usage")) return json(usage());
    posted = init;
    return new Response("data: fixture\n\n");
  } });
  await (await service.requestResponses(KEY, "subscription", { model: "vendor/model", input: "x", billing_mode: "paygo", billingMode: "paygo", provider: {}, conversation: { id: "state" }, background: true, store: true }, request())).text();
  assert.deepEqual(JSON.parse(String(posted?.body)), { model: "vendor/model", input: "x", store: false, retention_days: 0 });
  assert.equal(new Headers(posted?.headers).has("X-Billing-Mode"), false);
});

test("metadata body consumption obeys the same absolute deadline", async () => {
  const service = new NanoGptService({ fetchImpl: async () => new Response(new ReadableStream({ pull: async () => new Promise<void>(() => {}) })) });
  await assert.rejects(service.inspect(KEY, "subscription", { signal: new AbortController().signal, deadlineAt: Date.now() + 25 }), NanoGptRequestError);
});

test("generation stream body consumption obeys cancellation after headers", async () => {
  const controller = new AbortController();
  const service = new NanoGptService({ fetchImpl: async (url) => url.endsWith("usage") ? json(usage()) : new Response(new ReadableStream({ pull: async () => new Promise<void>(() => {}) })) });
  const response = await service.requestResponses(KEY, "subscription", { model: "vendor/model", input: "x" }, { signal: controller.signal, deadlineAt: Date.now() + 1000 });
  controller.abort();
  await assert.rejects(response.text(), NanoGptRequestError);
});

test("generation headers arriving after the absolute deadline are not published", async () => {
  let now = 10;
  const service = new NanoGptService({ now: () => now, fetchImpl: async (url) => {
    if (url.endsWith("usage")) return json(usage());
    now = 101;
    return new Response("late generation");
  } });
  await assert.rejects(service.requestResponses(KEY, "subscription", { model: "vendor/model", input: "x" }, { signal: new AbortController().signal, deadlineAt: 100 }), NanoGptRequestError);
});

test("full detailed catalogs above 512KiB remain usable without relaxing usage metadata limits", async () => {
  const service = new NanoGptService({ fetchImpl: async (url) => json(url.endsWith("usage") ? usage() : { data: Array.from({ length: 652 }, (_, index) => ({ ...model, id: `vendor/model-${index}`, description: "x".repeat(1024) })) }) });
  const result = await service.inspect(KEY, "subscription", request());
  assert.equal(result.models.length, 652);
  assert.equal(result.models[651]?.promptUsdPerToken, 0.000002);
});

test("catalog parsing still rejects multi-megabyte unbounded provider data", async () => {
  const service = new NanoGptService({ fetchImpl: async () => json({ data: [{ ...model, description: "x".repeat(5 * 1024 * 1024) }] }) });
  await assert.rejects(service.listModels(KEY, "payg", request()), NanoGptRequestError);
});
