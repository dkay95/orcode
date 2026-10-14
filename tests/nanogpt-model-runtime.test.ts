import assert from "node:assert/strict";
import test from "node:test";
import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { RouteIdentityV1 } from "../src/backends.js";
import { createNanoGptModelRuntime, type NanoGptRuntimeBindingProof } from "../src/nanogpt-model-runtime.js";
import { NanoGptService } from "../src/nanogpt.js";
import type { ProviderCredentialAuthorityLike, ProviderCredentialUseContext } from "../src/provider-authority.js";

const ROUTE: RouteIdentityV1 = Object.freeze({ version: 1, backendId: "nano-gpt", accountFingerprint: "acct_nano_runtime_fixture", billingRealm: "nanogpt-subscription", requestedModelId: "vendor/exact-model", canonicalModelId: "vendor/exact-model", resolutionState: "resolved" });
const PROOF: NanoGptRuntimeBindingProof = Object.freeze({ version: 1, stateRevision: 7, generation: 3, connectionId: "nano-runtime", backendId: "nano-gpt", accountFingerprint: ROUTE.accountFingerprint, billingRealm: "nanogpt-subscription", canonicalModelId: "vendor/exact-model" });
const NOW = 1_800_000_000_000;

function context(proof = PROOF): ProviderCredentialUseContext {
  return { source: "saved", binding: { version: 2, stateRevision: proof.stateRevision, connectionId: proof.connectionId, backendId: "nano-gpt", enabled: true, credentialPointer: { kind: "versioned", slot: { version: 1, kind: "nano-gpt", id: "v1:nano-gpt:11111111-1111-4111-8111-111111111111" } }, accountFingerprint: proof.accountFingerprint, billingRealm: proof.billingRealm, isDefault: true }, candidatePermit: { version: 1 }, publishIfCurrent: async (publish) => publish() };
}

function nativeResponse(text: string, functionCall = false): Response {
  const item = functionCall
    ? { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_value", arguments: "{}", status: "completed" }
    : { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
  const shell = { background: null, completed_at: 1800000001, created_at: 1800000000, error: null, frequency_penalty: null, id: "resp_native", incomplete_details: null, instructions: null, max_output_tokens: null, max_tool_calls: null, metadata: null, model: "vendor/exact-model", object: "response", output: [item], output_text: text, parallel_tool_calls: false, presence_penalty: null, previous_response_id: null, prompt: null, prompt_cache_key: null, prompt_cache_options: null, reasoning: null, safety_identifier: null, service_tier: null, status: "completed", store: false, temperature: null, text: { format: { type: "text" } }, tool_choice: "auto", tools: [], top_logprobs: null, top_p: null, truncation: null, usage: { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 6 }, user: null };
  const events = [
    { type: "response.created", response: { ...shell, status: "in_progress", completed_at: null, output: [], output_text: "", usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(functionCall ? { arguments: "" } : { content: [] }) } },
    ...(functionCall ? [
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{}" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", name: "read_value", arguments: "{}" },
    ] : [
      { type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text, logprobs: [] },
      { type: "response.output_text.done", output_index: 0, item_id: "msg_1", content_index: 0, text, logprobs: [] },
      { type: "response.content_part.done", output_index: 0, item_id: "msg_1", content_index: 0, part: item.content?.[0] },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: shell },
  ];
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function fixture(options: { mode?: "subscription" | "payg"; policy?: boolean; authorityContext?: ProviderCredentialUseContext; response?: (index: number) => Response; now?: () => number; deadline?: () => number; authority?: ProviderCredentialAuthorityLike } = {}) {
  const payg = options.mode === "payg";
  const route = { ...ROUTE, billingRealm: payg ? "nanogpt-payg" as const : "nanogpt-subscription" as const };
  const proof = { ...PROOF, billingRealm: route.billingRealm };
  const requests: Request[] = [];
  let openAuthority = 0;
  let acquisitions = 0;
  let posts = 0;
  const authority: ProviderCredentialAuthorityLike = options.authority ?? { async withCredential(request, use) {
    acquisitions++;
    assert.equal(request.backendId, "nano-gpt");
    assert.equal(request.connectionId, "nano-runtime");
    assert.equal(request.environmentEligibility, "forbidden");
    assert.equal(request.purpose, "runtime-bind");
    openAuthority++;
    try { return { kind: "available", value: await use("nano-fixture-not-a-real-key", options.authorityContext ?? context(proof)) }; }
    finally { openAuthority--; }
  } };
  const service = new NanoGptService({ now: options.now ?? (() => NOW), fetchImpl: async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith("/usage")) return Response.json({ active: true, state: "active", routing: { recommendedMode: payg ? "paygo" : "subscription", subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: options.policy ?? payg } });
    if (request.url.includes("/models")) return Response.json({ data: [{ id: "vendor/exact-model", name: "Exact model", context_length: 32768, capabilities: { reasoning: true, tool_calling: true } }] });
    assert.equal(request.url, "https://api.nano-gpt.com/api/v1/responses");
    assert.equal(request.method, "POST");
    posts++;
    return options.response?.(posts) ?? nativeResponse("Hallo Nano");
  } });
  const runtime = createNanoGptModelRuntime({ route, binding: proof, credentialAuthority: authority, service, now: options.now ?? (() => NOW), createRequestDeadlineAt: options.deadline ?? (() => NOW + 45000) });
  return { runtime, route, requests, openAuthority: () => openAuthority, acquisitions: () => acquisitions };
}

// Break caught: dispatch or transport falls back to OpenRouter, or loses native SDK text events.
test("Nano-GPT uses the real SDK native Responses stream and a single exact model", async () => {
  const f = fixture();
  assert.deepEqual(f.runtime.dispatchFields({ route: f.route, allowWeb: true }), { backendId: "nano-gpt", model: "vendor/exact-model" });
  const text = await f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hallo", tools: [] }).getText();
  assert.equal(text, "Hallo Nano");
  assert.equal(f.acquisitions(), 1);
  assert.equal(f.openAuthority(), 0);
  assert.equal(f.requests.length, 2);
  const body = await f.requests[1]!.json();
  assert.equal(body.model, "vendor/exact-model");
  assert.equal(body.store, false);
  assert.equal(body.retention_days, 0);
  assert.equal(body.billing_mode, undefined);
  assert.equal(body.provider, undefined);
  assert.equal(body.plugins, undefined);
  assert.equal(f.requests[1]!.headers.get("authorization"), "Bearer nano-fixture-not-a-real-key");
});

// Break caught: a tool runs inside credential authority or a follow-up skips billing policy refresh.
test("native SDK function tools reacquire authority and billing policy before each follow-up", async () => {
  const f = fixture({ response: (index) => nativeResponse(index === 1 ? "" : "42", index === 1) });
  let executions = 0;
  const readValue = tool({ name: "read_value", description: "Read value", inputSchema: z.object({}), execute: async () => { assert.equal(f.openAuthority(), 0); executions++; return { value: 42 }; } });
  const text = await f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Use tool", tools: [readValue] }).getText();
  assert.equal(text, "42");
  assert.equal(executions, 1);
  assert.equal(f.acquisitions(), 2);
  assert.deepEqual(f.requests.map((request) => request.method), ["GET", "POST", "GET", "POST"]);
  const followUp = await f.requests[3]!.json();
  assert.ok(followUp.input.some((item: { type: string; call_id?: string; output?: string }) => item.type === "function_call_output" && item.call_id === "call_1" && item.output?.includes("42")));
});

// Break caught: subscription keys silently spend paid balance; payg fails to force billing mode.
test("subscription unsafe paid policy prevents all POSTs while explicit PAYG forces paygo", async () => {
  const unsafe = fixture({ policy: true });
  await assert.rejects(unsafe.runtime.createClient({ route: unsafe.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
  assert.equal(unsafe.requests.filter((request) => request.method === "POST").length, 0);
  const payg = fixture({ mode: "payg" });
  assert.equal(await payg.runtime.createClient({ route: payg.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText(), "Hallo Nano");
  assert.equal((await payg.requests[1]!.json()).billing_mode, "paygo");
  assert.equal(payg.requests[1]!.headers.get("x-billing-mode"), "paygo");
});

// Break caught: stale ownership, disabled keys, foreign realms or wrong slots reach the network.
test("current exact saved credential binding is required before any service request", async () => {
  for (const override of [{ stateRevision: 8 }, { backendId: "kimi-code" as const }, { connectionId: "foreign" }, { accountFingerprint: "foreign" }, { billingRealm: "nanogpt-payg" as const }, { enabled: false }, { credentialPointer: { kind: "legacy" as const, id: "legacy:inference" as const } }]) {
    const stale = context(); stale.binding = { ...stale.binding, ...override };
    const f = fixture({ authorityContext: stale });
    await assert.rejects(f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
    assert.equal(f.requests.length, 0);
  }
});

// Break caught: runtime advertises guessed reasoning levels, zero prices or an unverified account balance.
test("metadata preserves unknown reasoning efforts, prices and spend", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.inspectSpend(), { kind: "unknown" });
  const models = await f.runtime.listModels("vendor/exact-model");
  assert.deepEqual(models, [{ id: "vendor/exact-model", name: "Exact model", contextLength: 32768, reasoning: undefined, price: { kind: "unknown" } }]);
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 0);
});

// Break caught: changed runtime route, invalid manual model or elapsed deadline can dispatch.
test("invalid manual model bindings, route changes and elapsed deadlines fail closed", async () => {
  const f = fixture();
  assert.throws(() => f.runtime.createClient({ route: { ...f.route, requestedModelId: "other" }, scope: "main" }), /route|binding/i);
  assert.throws(() => createNanoGptModelRuntime({ route: { ...ROUTE, canonicalModelId: "auto-model-fast" }, binding: { ...PROOF, canonicalModelId: "auto-model-fast" }, credentialAuthority: { withCredential: async () => ({ kind: "absent" }) }, service: new NanoGptService(), now: () => NOW, createRequestDeadlineAt: () => NOW + 45000 }), /binding|model/i);
  const elapsed = fixture({ deadline: () => NOW });
  await assert.rejects(elapsed.runtime.createClient({ route: elapsed.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
  assert.equal(elapsed.requests.length, 0);
});

// Break caught: the runtime disconnects the caller's abort signal when response headers arrive.
test("caller cancellation remains attached while the native response body is streaming", async () => {
  const caller = new AbortController();
  let signalStreaming!: () => void;
  const streaming = new Promise<void>((resolve) => { signalStreaming = resolve; });
  const f = fixture({ deadline: () => NOW + 200, response: () => new Response(new ReadableStream<Uint8Array>({ pull() { signalStreaming(); return new Promise<void>(() => {}); } }), { headers: { "content-type": "text/event-stream" } }) });
  const result = f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Wait", tools: [] }, { signal: caller.signal }).getText();
  const settled = result.then(() => "resolved", () => "rejected");
  await streaming;
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  caller.abort();
  assert.equal(await Promise.race([settled, new Promise<string>((resolve) => setTimeout(() => resolve("not-cancelled"), 40))]), "rejected");
  assert.equal(f.requests[1]!.signal.aborted, true);
});

// Break caught: response metadata is exposed after its owning authority becomes stale in flight.
test("authority is rechecked after receiving response headers before exposing native events", async () => {
  let publications = 0;
  const stale = context();
  stale.publishIfCurrent = async (publish) => { if (++publications > 2) throw new Error("stale"); publish(); };
  const f = fixture({ authorityContext: stale });
  await assert.rejects(f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
  assert.equal(publications, 3);
});

// Break caught: a key/binding switch during billing-policy GET still causes a paid inference POST.
test("authority becoming stale during the billing-policy GET prevents the generation POST", async () => {
  const current = context();
  const f = fixture({ authorityContext: current });
  current.publishIfCurrent = async (publish) => { if (f.requests.length > 0) throw new Error("binding changed during policy request"); publish(); };
  await assert.rejects(f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.method, "GET");
});

// Break caught: SDK/OpenRouter vendor fields leak through, or callers override model/provider endpoint.
test("vendor routing and retention extras never reach Nano while foreign models and SDK hosts are blocked", async () => {
  const f = fixture();
  const client = f.runtime.createClient({ route: f.route, scope: "main" });
  await client.callModel({ model: "vendor/exact-model", input: "Hi", tools: [], provider: { only: ["foreign-provider"], allowFallbacks: true }, plugins: [{ id: "web" }], store: false, metadata: { private: "metadata" } }).getText();
  const body = await f.requests[1]!.json();
  assert.equal(body.provider, undefined);
  assert.equal(body.plugins, undefined);
  assert.equal(body.metadata, undefined);
  assert.equal(body.store, false);
  assert.equal(body.retention_days, 0);
  await assert.rejects(client.callModel({ model: "vendor/other-model", input: "Hi", tools: [] }).getText());
  await assert.rejects(client.callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }, { serverURL: "https://openrouter.ai/api/v1" }).getText());
  assert.equal(f.requests.length, 2);
});

// Break caught: runtime failure projection loses an authentication rejection or leaks raw SDK errors.
test("trusted generation failures keep safe provider messages and never retry or fallback", async () => {
  const f = fixture({ response: () => new Response("upstream-secret-error", { status: 401 }) });
  let observed: unknown;
  try { await f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText(); }
  catch (failure) { observed = failure; }
  assert.ok(observed);
  assert.equal(f.runtime.safeMessage(observed), "Nano-GPT rejected the API key.");
  assert.equal(f.runtime.safeMessage(new Error("raw nano-fixture-not-a-real-key")), "Nano-GPT is currently unreachable.");
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
});

// Break caught: runtime leaves an uncooperative authority callback beyond its explicit deadline.
test("runtime deadline bounds an authority that never returns", async () => {
  const now = Date.now;
  const f = fixture({ now, deadline: () => Date.now() + 20, authority: { withCredential: async () => new Promise(() => {}) } });
  const call = f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText();
  assert.equal(await Promise.race([call.then(() => "resolved", () => "rejected"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200))]), "rejected");
  assert.equal(f.requests.length, 0);
});

// Break caught: an upstream stream outage is mislabeled as a user cancellation or leaks raw errors.
test("native streaming outages remain safe offline failures", async () => {
  const f = fixture({ response: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("raw upstream secret")); } }), { headers: { "content-type": "text/event-stream" } }) });
  let observed: unknown;
  try { await f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText(); } catch (failure) { observed = failure; }
  assert.ok(observed);
  assert.equal(f.runtime.safeMessage(observed), "Nano-GPT is currently unreachable.");
});

// Break caught: late authority delivery detects expiry but leaves the already-open provider request alive.
test("deadline crossing during late authority delivery aborts the provider body", async () => {
  let tick = NOW;
  const f = fixture({ now: () => tick, deadline: () => NOW + 100, authority: { async withCredential(_request, use) {
    const value = await use("nano-fixture-not-a-real-key", context());
    tick = NOW + 101;
    return { kind: "available", value };
  } } });
  await assert.rejects(f.runtime.createClient({ route: f.route, scope: "main" }).callModel({ model: "vendor/exact-model", input: "Hi", tools: [] }).getText());
  assert.equal(f.requests[1]!.signal.aborted, true);
});
