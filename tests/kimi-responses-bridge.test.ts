import assert from "node:assert/strict";
import test from "node:test";

import { OpenRouter, tool } from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk";
import { z } from "zod";

import {
  KIMI_CHAT_COMPLETIONS_URL,
  KIMI_RESPONSES_SDK_SENTINEL,
  createKimiResponsesFetcher,
} from "../src/kimi-responses-bridge.js";

const MODEL = "kimi-for-coding";
const SDK_SERVER_URL = "https://sdk-bridge.invalid";
const FIXED_NOW_MS = 1_775_000_000_000;
const SANITIZED_ERROR = {
  error: {
    message: "Kimi Responses bridge rejected the request.",
    type: "invalid_request_error",
  },
};
const PINNED_TOOL = {
  description: "Read a city's temperature",
  name: "read_temperature",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  strict: null,
  type: "function",
} as const;

function pinnedRequest(input: unknown): Record<string, unknown> {
  return {
    input,
    model: MODEL,
    service_tier: "auto",
    store: false,
    stream: true,
    tools: [PINNED_TOOL],
  };
}

function sseResponse(events: readonly object[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatChunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null = null,
  usage: Record<string, unknown> | null = null,
): object {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_775_000_000,
    model: MODEL,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    usage,
  };
}

test("the pinned public Agent/SDK seam translates streamed reasoning, a fragmented tool call, and final text", async () => {
  const upstreamRequests: Request[] = [];
  const upstreamBodies: unknown[] = [];
  const bridgePaths: string[] = [];

  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    upstreamRequests.push(request);
    upstreamBodies.push(JSON.parse(await request.clone().text()));

    if (upstreamRequests.length === 1) {
      return sseResponse([
        chatChunk("chatcmpl-tool", { role: "assistant", content: null, reasoning_content: "Need " }),
        chatChunk("chatcmpl-tool", { reasoning_content: "weather data." }),
        chatChunk("chatcmpl-tool", {
          tool_calls: [{
            index: 0,
            id: "call_weather_1",
            type: "function",
            function: { name: "read_temperature", arguments: "{\"city\":" },
          }],
        }),
        chatChunk("chatcmpl-tool", {
          tool_calls: [{ index: 0, function: { arguments: "\"Berlin\"}" } }],
        }, "tool_calls", {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 4 },
        }),
      ]);
    }

    assert.equal(upstreamRequests.length, 2, "the real agent must make exactly one follow-up model call");
    return sseResponse([
      chatChunk("chatcmpl-final", { role: "assistant", reasoning_content: null, content: "The temperature " }),
      chatChunk("chatcmpl-final", { content: "is 18 C." }, "stop", {
        prompt_tokens: 20,
        completion_tokens: 6,
        total_tokens: 26,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }),
    ]);
  };

  const bridgeFetcher = createKimiResponsesFetcher({
    fetch: upstreamFetch,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const observingFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    bridgePaths.push(new URL(request.url).pathname);
    return bridgeFetcher(request);
  };
  const client = new OpenRouter({
    apiKey: KIMI_RESPONSES_SDK_SENTINEL,
    serverURL: SDK_SERVER_URL,
    httpClient: new HTTPClient({ fetcher: observingFetcher }),
  });
  const readTemperature = tool({
    name: "read_temperature",
    description: "Read a city's temperature",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temperatureC: 18 }),
  });

  const result = client.callModel({
    model: MODEL,
    input: "What is Berlin's temperature?",
    tools: [readTemperature] as const,
  });
  const reasoningPromise = (async () => {
    const deltas: string[] = [];
    for await (const delta of result.getReasoningStream()) deltas.push(delta);
    return deltas;
  })();
  const [text, response, reasoning, toolCalls] = await Promise.all([
    result.getText(),
    result.getResponse(),
    reasoningPromise,
    result.getToolCalls(),
  ]);

  assert.deepEqual(bridgePaths, ["/responses", "/responses"]);
  assert.equal(text, "The temperature is 18 C.");
  assert.deepEqual(reasoning, ["Need ", "weather data."]);
  assert.deepEqual(toolCalls, [{ id: "call_weather_1", name: "read_temperature", arguments: { city: "Berlin" } }]);
  assert.equal(response.model, MODEL);
  assert.equal(response.outputText, "The temperature is 18 C.");
  assert.deepEqual(response.usage, {
    inputTokens: 20,
    inputTokensDetails: { cachedTokens: 3 },
    outputTokens: 6,
    outputTokensDetails: { reasoningTokens: 0 },
    totalTokens: 26,
  });

  assert.deepEqual(upstreamBodies[0], {
    model: MODEL,
    messages: [{ role: "user", content: "What is Berlin's temperature?" }],
    stream: true,
    thinking: { type: "enabled", keep: "all" },
    tools: [{
      type: "function",
      function: {
        name: "read_temperature",
        description: "Read a city's temperature",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    }],
  });
  assert.deepEqual(upstreamBodies[1], {
    model: MODEL,
    messages: [
      { role: "user", content: "What is Berlin's temperature?" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Need weather data.",
        tool_calls: [{
          id: "call_weather_1",
          type: "function",
          function: { name: "read_temperature", arguments: "{\"city\":\"Berlin\"}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_weather_1",
        content: "{\"city\":\"Berlin\",\"temperatureC\":18}",
      },
    ],
    stream: true,
    thinking: { type: "enabled", keep: "all" },
    tools: [{
      type: "function",
      function: {
        name: "read_temperature",
        description: "Read a city's temperature",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    }],
  });

  for (const request of upstreamRequests) {
    assert.equal(request.url, KIMI_CHAT_COMPLETIONS_URL);
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.headers.has("x-api-key"), false);
    assert.equal((await request.clone().text()).includes(KIMI_RESPONSES_SDK_SENTINEL), false);
    assert.equal([...request.headers].some(([, value]) => value.includes(KIMI_RESPONSES_SDK_SENTINEL)), false);
  }
});

test("the bridge propagates request aborts to the injected upstream fetch", async () => {
  let observedSignal: AbortSignal | undefined;
  let signalReady!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const upstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    observedSignal = request.signal;
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      signalReady();
    });
  };
  const fetcher = createKimiResponsesFetcher({
    fetch: upstreamFetch,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const controller = new AbortController();
  const pending = fetcher(new Request(`${SDK_SERVER_URL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pinnedRequest("hello")),
    signal: controller.signal,
  }));

  await upstreamStarted;
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError", message: "cancelled" });
  assert.equal(observedSignal?.aborted, true);
});

test("unexpected paths and unsupported request bodies fail with one sanitized error before upstream fetch", async () => {
  let upstreamCalls = 0;
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      upstreamCalls += 1;
      throw new Error("must not run");
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const cases = [
    new Request(`${SDK_SERVER_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pinnedRequest("hello")),
    }),
    new Request(`${SDK_SERVER_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    new Request(`${SDK_SERVER_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pinnedRequest([{ type: "unknown" }])),
    }),
  ];

  for (const request of cases) {
    const response = await fetcher(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), SANITIZED_ERROR);
  }
  assert.equal(upstreamCalls, 0);
});

test("an undeclared request body is read incrementally, capped, fatally decoded, and cancelled without waiting", async () => {
  let upstreamCalls = 0;
  let requestCancelled = 0;
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      upstreamCalls += 1;
      return new Response();
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  let sentOversizedChunk = false;
  const oversized = new Request(`${SDK_SERVER_URL}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KIMI_RESPONSES_SDK_SENTINEL}`,
      "content-type": "application/json",
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentOversizedChunk) return new Promise<void>(() => {});
        sentOversizedChunk = true;
        controller.enqueue(new Uint8Array(1_048_577));
        return undefined;
      },
      cancel() {
        requestCancelled += 1;
        return new Promise<void>(() => {});
      },
    }, { highWaterMark: 0 }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const oversizedOutcome = await Promise.race([
    fetcher(oversized),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
  assert.notEqual(oversizedOutcome, "timeout");
  assert.equal((oversizedOutcome as Response).status, 400);
  assert.equal(requestCancelled, 1);

  const invalidUtf8 = new Request(`${SDK_SERVER_URL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal((await fetcher(invalidUtf8)).status, 400);
  assert.equal(upstreamCalls, 0);
});

test("the strict pinned parser rejects unknown fields and cross-role content parts before upstream fetch", async () => {
  const reasoning = {
    content: [{ text: "Need weather data.", type: "reasoning_text" }],
    id: "reasoning_1",
    status: "completed",
    summary: [{ text: "Need weather data.", type: "summary_text" }],
    type: "reasoning",
  };
  const assistant = {
    content: [{ text: "hello", type: "output_text" }],
    id: "message_1",
    role: "assistant",
    status: "completed",
    type: "message",
  };
  const functionCall = {
    arguments: "{\"city\":\"Berlin\"}",
    call_id: "call_1",
    id: "function_1",
    name: "read_temperature",
    status: "completed",
    type: "function_call",
  };
  const functionOutput = {
    call_id: "call_1",
    id: "output_1",
    output: "{\"temperatureC\":18}",
    type: "function_call_output",
  };
  const invalidBodies: readonly { readonly name: string; readonly body: Record<string, unknown> }[] = [
    { name: "unknown root key", body: { ...pinnedRequest("hello"), unexpected: true } },
    { name: "unknown user item key", body: pinnedRequest([{ role: "user", content: "hello", unexpected: true }]) },
    { name: "unknown system item key", body: pinnedRequest([{ role: "system", content: "hello", unexpected: true }]) },
    { name: "unknown developer item key", body: pinnedRequest([{ role: "developer", content: "hello", unexpected: true }]) },
    { name: "unknown assistant item key", body: pinnedRequest([{ ...assistant, unexpected: true }]) },
    { name: "unknown reasoning item key", body: pinnedRequest([{ ...reasoning, unexpected: true }]) },
    { name: "unknown function-call item key", body: pinnedRequest([{ ...functionCall, unexpected: true }]) },
    { name: "unknown function-output item key", body: pinnedRequest([{ ...functionOutput, unexpected: true }]) },
    { name: "unknown tool key", body: { ...pinnedRequest("hello"), tools: [{ ...PINNED_TOOL, unexpected: true }] } },
    {
      name: "unknown user content key",
      body: pinnedRequest([{ role: "user", content: [{ type: "input_text", text: "hello", unexpected: true }] }]),
    },
    {
      name: "unknown system content key",
      body: pinnedRequest([{ role: "system", content: [{ type: "input_text", text: "hello", unexpected: true }] }]),
    },
    {
      name: "unknown developer content key",
      body: pinnedRequest([{ role: "developer", content: [{ type: "input_text", text: "hello", unexpected: true }] }]),
    },
    {
      name: "unknown assistant content key",
      body: pinnedRequest([{ ...assistant, content: [{ type: "output_text", text: "hello", unexpected: true }] }]),
    },
    {
      name: "unknown reasoning-content key",
      body: pinnedRequest([{ ...reasoning, content: [{ type: "reasoning_text", text: "hello", unexpected: true }] }]),
    },
    {
      name: "unknown reasoning-summary key",
      body: pinnedRequest([{ ...reasoning, summary: [{ type: "summary_text", text: "hello", unexpected: true }] }]),
    },
    { name: "user output_text", body: pinnedRequest([{ role: "user", content: [{ type: "output_text", text: "hello" }] }]) },
    { name: "system output_text", body: pinnedRequest([{ role: "system", content: [{ type: "output_text", text: "hello" }] }]) },
    { name: "developer output_text", body: pinnedRequest([{ role: "developer", content: [{ type: "output_text", text: "hello" }] }]) },
    {
      name: "assistant input_text",
      body: pinnedRequest([{ ...assistant, content: [{ type: "input_text", text: "hello" }] }]),
    },
    {
      name: "user reasoning_text",
      body: pinnedRequest([{ role: "user", content: [{ type: "reasoning_text", text: "hello" }] }]),
    },
    {
      name: "assistant reasoning_text",
      body: pinnedRequest([{ ...assistant, content: [{ type: "reasoning_text", text: "hello" }] }]),
    },
    {
      name: "reasoning input_text",
      body: pinnedRequest([{ ...reasoning, content: [{ type: "input_text", text: "hello" }] }]),
    },
    {
      name: "reasoning summary output_text",
      body: pinnedRequest([{ ...reasoning, summary: [{ type: "output_text", text: "hello" }] }]),
    },
  ];

  for (const invalid of invalidBodies) {
    let upstreamCalls = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        return sseResponse([
          chatChunk("chatcmpl-invalid", { role: "assistant", content: "must not run" }, "stop", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          }),
        ]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(new Request(`${SDK_SERVER_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalid.body),
    }));

    assert.equal(response.status, 400, invalid.name);
    assert.deepEqual(await response.json(), SANITIZED_ERROR, invalid.name);
    assert.equal(upstreamCalls, 0, invalid.name);
  }
});

test("the factory accepts only the reviewed Kimi Code Chat Completions URL", () => {
  assert.throws(() => createKimiResponsesFetcher({
    fetch: async () => new Response(),
    url: "https://api.moonshot.ai/v1/chat/completions" as typeof KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  }), { message: "Kimi Responses bridge rejected the request." });
});

function literalResponsesRequest(
  model: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed",
  input: unknown,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input,
    model,
    service_tier: "auto",
    store: false,
    stream: true,
    tools: [],
    ...extras,
  };
}

function sdkRequest(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request(`${SDK_SERVER_URL}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KIMI_RESPONSES_SDK_SENTINEL}`,
      "content-type": "application/json",
      "x-openrouter-title": "must-be-stripped",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function publicAgent(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): OpenRouter {
  return new OpenRouter({
    apiKey: KIMI_RESPONSES_SDK_SENTINEL,
    serverURL: SDK_SERVER_URL,
    httpClient: new HTTPClient({ fetcher }),
  });
}

test("the pinned main and compressor request shapes have explicit Kimi translations", async () => {
  const sdkBodies: unknown[] = [];
  const upstreamBodies: unknown[] = [];
  const bridge = createKimiResponsesFetcher({
    fetch: async (input, init) => {
      upstreamBodies.push(JSON.parse(await new Request(input, init).text()));
      return sseResponse([
        { ...chatChunk("chatcmpl-shape", { role: "assistant", content: "compressed" }, "stop", {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }), model: "k3" },
      ]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const client = publicAgent(async (input, init) => {
    const request = new Request(input, init);
    sdkBodies.push(JSON.parse(await request.clone().text()));
    return bridge(request);
  });

  assert.equal(await client.callModel({
    model: "k3",
    instructions: "MAIN INSTRUCTIONS",
    input: [{ role: "developer", content: "INPUT DEVELOPER" }, { role: "user", content: "hello" }],
    promptCacheKey: "chat-cache-key",
    reasoning: { enabled: true, effort: "medium" },
    tools: [],
  }).getText(), "compressed");
  assert.equal(await client.callModel({
    model: "k3",
    instructions: "COMPRESSOR INSTRUCTIONS",
    input: "compress this",
    maxOutputTokens: 321,
  }).getText(), "compressed");

  assert.deepEqual(sdkBodies, [
    {
      input: [{ role: "developer", content: "INPUT DEVELOPER" }, { role: "user", content: "hello" }],
      instructions: "MAIN INSTRUCTIONS",
      model: "k3",
      prompt_cache_key: "chat-cache-key",
      reasoning: { effort: "medium", enabled: true },
      service_tier: "auto",
      store: false,
      stream: true,
      tools: [],
    },
    {
      input: "compress this",
      instructions: "COMPRESSOR INSTRUCTIONS",
      max_output_tokens: 321,
      model: "k3",
      service_tier: "auto",
      store: false,
      stream: true,
    },
  ]);
  assert.deepEqual(upstreamBodies, [
    {
      model: "k3",
      messages: [
        { role: "system", content: "MAIN INSTRUCTIONS" },
        { role: "system", content: "INPUT DEVELOPER" },
        { role: "user", content: "hello" },
      ],
      stream: true,
      reasoning_effort: "high",
      prompt_cache_key: "chat-cache-key",
    },
    {
      model: "k3",
      messages: [
        { role: "system", content: "COMPRESSOR INSTRUCTIONS" },
        { role: "user", content: "compress this" },
      ],
      stream: true,
      reasoning_effort: "high",
      max_completion_tokens: 321,
    },
  ]);
  for (const body of upstreamBodies as Record<string, unknown>[]) {
    assert.equal("cache_control" in body, false);
    assert.equal("session_id" in body, false);
    assert.equal("max_tokens" in body, false);
  }
});

test("OpenRouter-only cache_control/session_id roots are rejected before Kimi fetch", async () => {
  for (const extras of [
    { cache_control: { type: "ephemeral" } },
    { session_id: "chat-id" },
  ]) {
    let upstreamCalls = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        return sseResponse([]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("k3", "hello", extras)));
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  }
});

test("oversized instructions are rejected instead of being silently stripped before Kimi fetch", async () => {
  let upstreamCalls = 0;
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => {
      upstreamCalls += 1;
      return sseResponse([]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await fetcher(sdkRequest(literalResponsesRequest("k3", "hello", {
    instructions: "x".repeat(128 * 1024 + 1),
  })));
  assert.equal(response.status, 400);
  assert.equal(upstreamCalls, 0);
});

test("one assistant turn keeps reasoning, visible text, multiple tool calls, and exactly paired results in one Chat message", async () => {
  const upstreamBodies: unknown[] = [];
  const fetcher = createKimiResponsesFetcher({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push(JSON.parse(await request.text()));
      return sseResponse([{
        ...chatChunk("chatcmpl-multi", { role: "assistant", content: "done" }, "stop", {
          prompt_tokens: 20,
          completion_tokens: 2,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
        model: "k3",
      }]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const input = [
    { role: "system", content: "system" },
    { role: "developer", content: [{ type: "input_text", text: "developer" }] },
    { role: "user", content: "user" },
    {
      content: [{ text: "Need both tools.", type: "reasoning_text" }],
      id: "reasoning_multi",
      status: "completed",
      summary: [{ text: "Need both tools.", type: "summary_text" }],
      type: "reasoning",
    },
    {
      content: [{ text: "Checking both.", type: "output_text" }],
      id: "message_multi",
      role: "assistant",
      status: "completed",
      type: "message",
    },
    {
      arguments: "{\"path\":\"a\"}",
      call_id: "call_a",
      id: "function_a",
      name: "read_a",
      status: "completed",
      type: "function_call",
    },
    {
      arguments: "{\"path\":\"b\"}",
      call_id: "call_b",
      id: "function_b",
      name: "read_b",
      status: "completed",
      type: "function_call",
    },
    { call_id: "call_a", id: "output_a", output: "A", type: "function_call_output" },
    { call_id: "call_b", id: "output_b", output: "B", type: "function_call_output" },
  ];

  const response = await fetcher(sdkRequest(literalResponsesRequest("k3", input)));
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(upstreamBodies, [{
    model: "k3",
    messages: [
      { role: "system", content: "system" },
      { role: "system", content: "developer" },
      { role: "user", content: "user" },
      {
        role: "assistant",
        content: "Checking both.",
        reasoning_content: "Need both tools.",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_a", arguments: "{\"path\":\"a\"}" } },
          { id: "call_b", type: "function", function: { name: "read_b", arguments: "{\"path\":\"b\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "tool", tool_call_id: "call_b", content: "B" },
    ],
    stream: true,
    reasoning_effort: "high",
  }]);
});

test("tool-call history rejects missing reasoning and non-bijective call results before Kimi fetch", async () => {
  const reasoning = {
    content: [{ text: "Need a tool.", type: "reasoning_text" }],
    id: "reasoning_pairing",
    status: "completed",
    summary: [{ text: "Need a tool.", type: "summary_text" }],
    type: "reasoning",
  };
  const call = {
    arguments: "{}",
    call_id: "call_pairing",
    id: "function_pairing",
    name: "read_value",
    status: "completed",
    type: "function_call",
  };
  const output = {
    call_id: "call_pairing",
    id: "output_pairing",
    output: "ok",
    type: "function_call_output",
  };
  const invalidInputs = [
    [call, output],
    [reasoning, call],
    [reasoning, call, output, { ...output, id: "output_duplicate" }],
    [reasoning, call, { ...output, call_id: "call_unknown" }],
  ];
  for (const input of invalidInputs) {
    let upstreamCalls = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        return sseResponse([]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("k3", input)));
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  }
});

test("K3 maps only reviewed effort values and K2.7 omits effort while unsupported controls fail before fetch", async () => {
  const cases = [
    { model: "k3" as const, reasoning: undefined, expected: "high" },
    { model: "k3" as const, reasoning: { enabled: true, effort: "low" }, expected: "low" },
    { model: "k3" as const, reasoning: { enabled: true, effort: "medium" }, expected: "high" },
    { model: "k3-256k" as const, reasoning: { enabled: true, effort: "high" }, expected: "high" },
    { model: "k3" as const, reasoning: { enabled: true, effort: "xhigh" }, expected: "max" },
    { model: "k3" as const, reasoning: { enabled: true, effort: "max" }, expected: "max" },
    { model: "kimi-for-coding" as const, reasoning: undefined, expected: undefined },
    { model: "kimi-for-coding-highspeed" as const, reasoning: { enabled: true }, expected: undefined },
  ];
  for (const entry of cases) {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const fetcher = createKimiResponsesFetcher({
      fetch: async (input, init) => {
        captured.body = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>;
        return sseResponse([
          { ...chatChunk("chatcmpl-effort", { role: "assistant", content: "ok" }, "stop", {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          }), model: entry.model },
        ]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const extras = entry.reasoning === undefined ? {} : { reasoning: entry.reasoning };
    const response = await fetcher(sdkRequest(literalResponsesRequest(entry.model, "hello", extras)));
    assert.equal(response.status, 200, entry.model);
    await response.text();
    assert.ok(captured.body);
    const body = captured.body;
    const modelId: string = entry.model;
    if (entry.expected === undefined) {
      assert.equal("reasoning_effort" in body, false, entry.model);
      if (modelId === "k3" || modelId === "k3-256k") {
        assert.equal("thinking" in body, false, entry.model);
      } else {
        assert.deepEqual(body.thinking, { type: "enabled", keep: "all" }, entry.model);
      }
    } else {
      assert.equal(body.reasoning_effort, entry.expected, entry.model);
    }
  }

  const rejected = [
    { model: "k3" as const, reasoning: { enabled: false, effort: "none" } },
    { model: "k3" as const, reasoning: { enabled: true, max_tokens: 2_000 } },
    { model: "k3" as const, reasoning: { enabled: true, effort: "turbo" } },
    { model: "kimi-for-coding" as const, reasoning: { enabled: false, effort: "none" } },
    { model: "kimi-for-coding" as const, reasoning: { enabled: true, max_tokens: 2_000 } },
  ];
  for (const entry of rejected) {
    let upstreamCalls = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        return sseResponse([]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest(entry.model, "hello", {
      reasoning: entry.reasoning,
    })));
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  }
});

test("the pinned final tool request preserves exact tool_choice none and rejects every other shape before fetch", async () => {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  const fetcher = createKimiResponsesFetcher({
    fetch: async (input, init) => {
      captured.body = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>;
      return sseResponse([
        chatChunk("chatcmpl-tool-choice", { role: "assistant", content: "final" }, "stop", {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      ]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "finish", {
    tools: [PINNED_TOOL],
    tool_choice: "none",
  })));
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(captured.body);
  assert.equal(captured.body.tool_choice, "none");

  for (const toolChoice of ["auto", "required", { type: "function", name: "read_temperature" }, null]) {
    let upstreamCalls = 0;
    const strictFetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        return sseResponse([]);
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const rejected = await strictFetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "finish", {
      tools: [PINNED_TOOL],
      tool_choice: toolChoice,
    })));
    assert.equal(rejected.status, 400, JSON.stringify(toolChoice));
    assert.equal(upstreamCalls, 0, JSON.stringify(toolChoice));
  }
});

test("provider tool calls must match offered tools and can never contradict tool_choice none", async (t) => {
  const streamedTool = (name: string): object[] => [
    { ...chatChunk("chatcmpl-tool-contract", { role: "assistant", reasoning_content: "Need a tool." }), model: "k3" },
    { ...chatChunk("chatcmpl-tool-contract", {
      tool_calls: [{
        index: 0,
        id: "call_tool_contract",
        type: "function",
        function: { name, arguments: "{}" },
      }],
    }, "tool_calls"), model: "k3" },
  ];

  await t.test("no offered tools", async () => {
    const bridge = createKimiResponsesFetcher({
      fetch: async () => sseResponse(streamedTool("read_temperature")),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello")));
    await assert.rejects(response.text(), /Kimi/i);
  });

  await t.test("unoffered tool name", async () => {
    const bridge = createKimiResponsesFetcher({
      fetch: async () => sseResponse(streamedTool("delete_everything")),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello", { tools: [PINNED_TOOL] })));
    await assert.rejects(response.text(), /Kimi/i);
  });

  await t.test("tool_choice none in non-stream mode", async () => {
    const bridge = createKimiResponsesFetcher({
      fetch: async () => Response.json({
        id: "chatcmpl-tool-choice-contradiction",
        object: "chat.completion",
        created: 1_775_000_000,
        model: "k3",
        system_fingerprint: null,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            reasoning_content: "Need a tool.",
            content: null,
            tool_calls: [{
              id: "call_tool_choice_none",
              type: "function",
              function: { name: "read_temperature", arguments: "{}" },
            }],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        }],
        usage: null,
      }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello", {
      tools: [PINNED_TOOL],
      tool_choice: "none",
    })));
    assert.equal(response.status, 400);
  });
});

test("the first provider choice frame must establish the assistant role", async () => {
  const bridge = createKimiResponsesFetcher({
    fetch: async () => sseResponse([
      { ...chatChunk("chatcmpl-missing-first-role", { content: "must not publish" }, "stop"), model: "k3" },
    ]),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello")));
  await assert.rejects(response.text(), /Kimi/i);
});

test("a complete non-stream Chat response is consumable as one full public SDK model result", async () => {
  const bridge = createKimiResponsesFetcher({
    fetch: async () => Response.json({
      id: "chatcmpl-json",
      object: "chat.completion",
      created: 1_775_000_000,
      model: "kimi-for-coding",
      system_fingerprint: null,
      choices: [{
        index: 0,
        message: { role: "assistant", reasoning_content: "Think.", content: "Done.", tool_calls: null },
        logprobs: null,
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  let bridgeContentType = "";
  let bridgeBody = "";
  const client = publicAgent(async (input, init) => {
    const response = await bridge(input, init);
    bridgeContentType = response.headers.get("content-type") ?? "";
    bridgeBody = await response.clone().text();
    return response;
  });
  const result = client.callModel({ model: "kimi-for-coding", input: "hello", tools: [] });
  const [text, response] = await Promise.all([result.getText(), result.getResponse()]);

  assert.equal(text, "Done.");
  assert.equal(response.id, "resp_chatcmpl-json");
  assert.equal(response.status, "completed");
  assert.equal(response.outputText, "Done.");
  assert.deepEqual(response.output, [
    {
      id: "resp_chatcmpl-json_reasoning",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Think." }],
      content: [{ type: "reasoning_text", text: "Think." }],
    },
    {
      id: "resp_chatcmpl-json_message",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    },
  ]);
  assert.deepEqual(response.usage, {
    inputTokens: 3,
    inputTokensDetails: { cachedTokens: 1 },
    outputTokens: 2,
    outputTokensDetails: { reasoningTokens: 1 },
    totalTokens: 5,
  });
  assert.match(bridgeContentType, /^application\/json/);
  assert.doesNotMatch(bridgeBody, /data:|\[DONE\]/);
});

test("invalid provider tool arguments fail closed before the pinned SDK can log them", async (t) => {
  const argumentCanary = "PRIVATE_ARGUMENT_CANARY";
  const invalidArguments = `{${argumentCanary}`;
  const readTemperature = tool({
    name: "read_temperature",
    description: "Read temperature",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temperatureC: 18 }),
  });
  const assertRejectedWithoutSdkWarning = async (providerResponse: () => Response): Promise<void> => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]): void => { warnings.push(values.map(String).join(" ")); };
    try {
      const bridge = createKimiResponsesFetcher({
        fetch: async () => providerResponse(),
        url: KIMI_CHAT_COMPLETIONS_URL,
        now: () => FIXED_NOW_MS,
      });
      const result = publicAgent((input, init) => bridge(input, init)).callModel({
        model: "kimi-for-coding",
        input: "read it",
        tools: [readTemperature] as const,
      });
      await assert.rejects(
        Promise.all([result.getResponse(), result.getToolCalls()]),
        (error: unknown) => !String(error).includes(argumentCanary),
      );
      assert.equal(warnings.length, 0, `SDK warning leaked: ${warnings.join(" ")}`);
    } finally {
      console.warn = originalWarn;
    }
  };

  await t.test("stream", async () => {
    await assertRejectedWithoutSdkWarning(() => sseResponse([
      chatChunk("chatcmpl-invalid-args-stream", { role: "assistant", reasoning_content: "Need data." }),
      chatChunk("chatcmpl-invalid-args-stream", {
        tool_calls: [{
          index: 0,
          id: "call_invalid_args_stream",
          type: "function",
          function: { name: "read_temperature", arguments: invalidArguments },
        }],
      }, "tool_calls"),
    ]));
  });

  await t.test("non-stream", async () => {
    await assertRejectedWithoutSdkWarning(() => Response.json({
      id: "chatcmpl-invalid-args-json",
      object: "chat.completion",
      created: 1_775_000_000,
      model: "kimi-for-coding",
      system_fingerprint: null,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          reasoning_content: "Need data.",
          content: null,
          tool_calls: [{
            id: "call_invalid_args_json",
            type: "function",
            function: { name: "read_temperature", arguments: invalidArguments },
          }],
        },
        logprobs: null,
        finish_reason: "tool_calls",
      }],
      usage: null,
    }));
  });
});

test("streamed and non-stream provider models must equal the exact requested canonical model", async (t) => {
  await t.test("stream", async () => {
    const bridge = createKimiResponsesFetcher({
      fetch: async () => sseResponse([{
        ...chatChunk("chatcmpl-wrong-stream-model", { role: "assistant", content: "must not publish" }, "stop"),
        model: "k3-256k",
      }]),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello")));
    await assert.rejects(response.text(), /Kimi/i);
  });

  await t.test("non-stream", async () => {
    const bridge = createKimiResponsesFetcher({
      fetch: async () => Response.json({
        id: "chatcmpl-wrong-json-model",
        object: "chat.completion",
        created: 1_775_000_000,
        model: "k3-256k",
        system_fingerprint: null,
        choices: [{
          index: 0,
          message: { role: "assistant", reasoning_content: null, content: "must not publish", tool_calls: null },
          logprobs: null,
          finish_reason: "stop",
        }],
        usage: null,
      }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello")));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), SANITIZED_ERROR);
  });
});

test("one immutable created_at is reused from response.created through the terminal response", async () => {
  let nowCalls = 0;
  const bridge = createKimiResponsesFetcher({
    fetch: async () => sseResponse([
      chatChunk("chatcmpl-created-at", { role: "assistant", content: "ok" }, "stop"),
    ]),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS + nowCalls++ * 10_000,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  const events = (await response.text()).split(/\n\n/)
    .filter((block) => block.startsWith("data: {") )
    .map((block) => JSON.parse(block.slice(6)) as {
      type: string;
      response?: { created_at?: number; completed_at?: number | null };
    });
  const created = events.find((event) => event.type === "response.created");
  const terminal = events.find((event) => event.type === "response.completed");
  assert.ok(created?.response);
  assert.ok(terminal?.response);
  assert.equal(terminal.response.created_at, created.response.created_at);
  assert.equal(terminal.response.completed_at, (created.response.created_at ?? 0) + 10);
  assert.equal(nowCalls, 2, "created_at and completed_at each capture one distinct clock read");
});

test("an invalid terminal clock publishes no partial done events", async () => {
  let releaseTerminal!: () => void;
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const first = new TextEncoder().encode(`data: ${JSON.stringify(chatChunk(
    "chatcmpl-backward-clock",
    { role: "assistant", content: "partial" },
  ))}\n\n`);
  const terminal = new TextEncoder().encode([
    `data: ${JSON.stringify(chatChunk("chatcmpl-backward-clock", {}, "stop"))}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
  const bridge = createKimiResponsesFetcher({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(first);
        await terminalGate;
        controller.enqueue(terminal);
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: (() => {
      const values = [2_000, 1_000];
      return () => values.shift() ?? 1_000;
    })(),
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  const reader = response.body!.getReader();
  for (let index = 0; index < 4; index += 1) {
    const next = await reader.read();
    assert.equal(next.done, false);
  }
  let terminalPublished = "";
  const outcome = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      terminalPublished += new TextDecoder().decode(next.value);
    }
  })();
  releaseTerminal();
  await assert.rejects(outcome, /Kimi/i);
  assert.doesNotMatch(
    terminalPublished,
    /\.done|response\.completed|response\.incomplete|\[DONE\]/,
    "terminal clock validation must precede every terminal event",
  );
});

test("an invalid frame publishes none of that frame before every field is validated", async () => {
  const invalidFrame = {
    ...chatChunk("chatcmpl-atomic-frame", { role: "assistant", content: "FRAME_LEAK_CANARY" }),
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "FRAME_LEAK_CANARY" },
      logprobs: null,
      finish_reason: "future_reason",
    }],
  };
  let releaseFrame!: () => void;
  const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(invalidFrame)}\n\ndata: [DONE]\n\n`);
  const bridge = createKimiResponsesFetcher({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await frameGate;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("k3", "hello")));
  const reader = response.body!.getReader();
  let published = "";
  const readOutcome = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      published += new TextDecoder().decode(next.value);
    }
  })();
  releaseFrame();
  await assert.rejects(readOutcome, /Kimi/i);
  assert.equal(published, "", "no response.created or delta may escape an invalid first frame");
});

test("duplicate tool IDs invalidate their non-terminal frame before its text can publish", async () => {
  const duplicateFrame = chatChunk("chatcmpl-duplicate-frame", {
    role: "assistant",
    reasoning_content: "Need both tools.",
    content: "DUPLICATE_FRAME_LEAK_CANARY",
    tool_calls: [
      {
        index: 0,
        id: "call_duplicate_frame",
        type: "function",
        function: { name: "read_a", arguments: "{}" },
      },
      {
        index: 1,
        id: "call_duplicate_frame",
        type: "function",
        function: { name: "read_b", arguments: "{}" },
      },
    ],
  });
  const terminalFrame = chatChunk("chatcmpl-duplicate-frame", {}, "tool_calls");
  const bytes = new TextEncoder().encode([
    `data: ${JSON.stringify(duplicateFrame)}\n\n`,
    `data: ${JSON.stringify(terminalFrame)}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bridge = createKimiResponsesFetcher({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello", {
    tools: [
      { ...PINNED_TOOL, name: "read_a" },
      { ...PINNED_TOOL, name: "read_b" },
    ],
  })));
  const reader = response.body!.getReader();
  let published = "";
  const outcome = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      published += new TextDecoder().decode(next.value);
    }
  })();
  release();
  await assert.rejects(outcome, /Kimi/i);
  assert.equal(published, "", "duplicate call IDs must be rejected before any event from that frame");
});

test("an impossible tool-name prefix invalidates its frame before content can publish", async () => {
  const contentCanary = "IMPOSSIBLE_TOOL_NAME_FRAME_CANARY";
  const firstFrame = chatChunk("chatcmpl-impossible-tool-name", {
    role: "assistant",
    reasoning_content: "Need data.",
    content: contentCanary,
    tool_calls: [{
      index: 0,
      id: "call_impossible_tool_name",
      type: "function",
      function: { name: "evil", arguments: "{}" },
    }],
  });
  const terminalFrame = chatChunk("chatcmpl-impossible-tool-name", {}, "tool_calls");
  let publishFirst!: () => void;
  let publishTerminal!: () => void;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      publishFirst = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(firstFrame)}\n\n`));
      publishTerminal = () => {
        try {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify(terminalFrame)}\n\n`,
            "data: [DONE]\n\n",
          ].join("")));
          controller.close();
        } catch {
          // The strict bridge may already have cancelled the invalid upstream stream.
        }
      };
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const bridge = createKimiResponsesFetcher({
    fetch: async () => upstream,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello", {
    tools: [PINNED_TOOL],
  })));
  const reader = response.body!.getReader();
  let published = "";
  const outcome = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      published += new TextDecoder().decode(next.value);
    }
  })();
  const rejection = assert.rejects(outcome, /Kimi/i);

  publishFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const publishedBeforeTerminal = published;
  publishTerminal();
  await rejection;
  assert.equal(publishedBeforeTerminal, "", "an irreversibly invalid name prefix must reject the whole frame atomically");
  assert.doesNotMatch(publishedBeforeTerminal, new RegExp(contentCanary));
});

test("invalid arguments invalidate their terminal frame before its content can publish", async () => {
  const contentCanary = "INVALID_ARGUMENT_TERMINAL_FRAME_CANARY";
  const initialFrame = chatChunk("chatcmpl-invalid-terminal-args", {
    role: "assistant",
    reasoning_content: "Need data.",
  });
  const terminalFrame = chatChunk("chatcmpl-invalid-terminal-args", {
    content: contentCanary,
    tool_calls: [{
      index: 0,
      id: "call_invalid_terminal_args",
      type: "function",
      function: { name: "read_temperature", arguments: "{PRIVATE_ARGUMENT_CANARY" },
    }],
  }, "tool_calls");
  let publishInitial!: () => void;
  let publishTerminal!: () => void;
  let publishDone!: () => void;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
      publishInitial = () => controller.enqueue(encode(`data: ${JSON.stringify(initialFrame)}\n\n`));
      publishTerminal = () => controller.enqueue(encode(`data: ${JSON.stringify(terminalFrame)}\n\n`));
      publishDone = () => {
        try {
          controller.enqueue(encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // The strict bridge may already have cancelled the invalid upstream stream.
        }
      };
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const bridge = createKimiResponsesFetcher({
    fetch: async () => upstream,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await bridge(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello", {
    tools: [PINNED_TOOL],
  })));
  const reader = response.body!.getReader();
  let published = "";
  const outcome = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      published += new TextDecoder().decode(next.value);
    }
  })();
  const rejection = assert.rejects(outcome, /Kimi/i);

  publishInitial();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeTerminal = published.length;
  publishTerminal();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const terminalPublished = published.slice(beforeTerminal);
  publishDone();
  await rejection;
  assert.equal(terminalPublished, "", "argument validation must precede every event from the finish frame");
  assert.doesNotMatch(terminalPublished, new RegExp(contentCanary));
});

test("the SSE bridge publishes validated deltas incrementally before the provider stream finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = new TextEncoder().encode(`data: ${JSON.stringify(chatChunk(
    "chatcmpl-incremental",
    { role: "assistant", content: "first" },
  ))}\n\n`);
  const terminal = new TextEncoder().encode([
    `data: ${JSON.stringify(chatChunk("chatcmpl-incremental", { content: " second" }, "stop", {
      prompt_tokens: 2,
      completion_tokens: 2,
      total_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }))}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
  const upstream = new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first);
      await gate;
      controller.enqueue(terminal);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => upstream,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });

  const responseOrTimeout = await Promise.race([
    fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello"))).then((response) => ({ response })),
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
  ]);
  if ("timeout" in responseOrTimeout) release();
  assert.equal("timeout" in responseOrTimeout, false, "fetcher must return before upstream body completion");
  if (!("response" in responseOrTimeout)) return;
  const reader = responseOrTimeout.response.body!.getReader();
  const firstRead = await Promise.race([
    reader.read(),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
  assert.notEqual(firstRead, "timeout");
  if (firstRead !== "timeout") {
    const firstText = new TextDecoder().decode(firstRead.value);
    assert.match(firstText, /response\.(?:created|output_item\.added|output_text\.delta)/);
    assert.doesNotMatch(firstText, /response\.completed|\[DONE\]/);
  }
  release();
  while (!(await reader.read()).done) {
    // drain
  }
});

test("interleaved fragmented multi-tool frames stay independent through the public SDK", async () => {
  let upstreamCall = 0;
  const bridgedBodies: string[] = [];
  const bridge = createKimiResponsesFetcher({
    fetch: async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) {
        return sseResponse([
          chatChunk("chatcmpl-interleaved", { role: "assistant", reasoning_content: "Need both." }),
          chatChunk("chatcmpl-interleaved", {
            tool_calls: [
              { index: 0, id: "call_multi_a", type: "function", function: { name: "read_", arguments: "{\"path\":" } },
              { index: 1, id: "call_multi_b", type: "function", function: { name: "write_", arguments: "{\"path\":" } },
            ],
          }),
          chatChunk("chatcmpl-interleaved", {
            tool_calls: [
              { index: 1, function: { name: "b", arguments: "\"b\"}" } },
              { index: 0, function: { name: "a", arguments: "\"a\"}" } },
            ],
          }, "tool_calls", {
            prompt_tokens: 4,
            completion_tokens: 4,
            total_tokens: 8,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 1 },
          }),
        ]);
      }
      return sseResponse([
        chatChunk("chatcmpl-interleaved-final", { role: "assistant", content: "finished" }, "stop", {
          prompt_tokens: 8,
          completion_tokens: 1,
          total_tokens: 9,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      ]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const client = publicAgent(async (input, init) => {
    const response = await bridge(input, init);
    const index = bridgedBodies.length;
    bridgedBodies.push("");
    void response.clone().text().then((body) => { bridgedBodies[index] = body; });
    return response;
  });
  const readA = tool({
    name: "read_a",
    description: "read a",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => ({ path, value: "A" }),
  });
  const writeB = tool({
    name: "write_b",
    description: "write b",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => ({ path, value: "B" }),
  });
  const result = client.callModel({ model: "kimi-for-coding", input: "use both", tools: [readA, writeB] as const });
  const [text, calls] = await Promise.all([result.getText(), result.getToolCalls()]);
  assert.equal(text, "finished");
  assert.deepEqual(calls, [
    { id: "call_multi_a", name: "read_a", arguments: { path: "a" } },
    { id: "call_multi_b", name: "write_b", arguments: { path: "b" } },
  ]);
  assert.equal(upstreamCall, 2);

  while (!bridgedBodies[0]) await new Promise<void>((resolve) => setImmediate(resolve));
  const events = bridgedBodies[0]!.split(/\n\n/)
    .filter((block) => block.startsWith("data: {") && !block.includes("response.completed"))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
  const toolEvents = events.filter((event) =>
    event.type === "response.output_item.added"
      ? (event.item as { type?: string }).type === "function_call"
      : String(event.type).includes("function_call_arguments")
        || (event.type === "response.output_item.done" && (event.item as { type?: string }).type === "function_call"),
  );
  const itemIds = toolEvents
    .filter((event) => event.type === "response.output_item.added")
    .map((event) => (event.item as { id: string }).id);
  assert.equal(new Set(itemIds).size, 2);
  assert.deepEqual(toolEvents
    .filter((event) => event.type === "response.output_item.added")
    .map((event) => event.output_index), [1, 2]);
  for (const itemId of itemIds) {
    assert.deepEqual(toolEvents
      .filter((event) => event.item_id === itemId || (event.item as { id?: string } | undefined)?.id === itemId)
      .map((event) => event.type), [
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
      ]);
  }
  const completed = bridgedBodies[0]!.split(/\n\n/)
    .find((block) => block.includes('"type":"response.completed"'));
  assert.ok(completed);
  const completedEvent = JSON.parse(completed!.slice(6)) as { response: { output: Array<{ type: string; call_id?: string }> } };
  assert.deepEqual(completedEvent.response.output.map((item) => item.type === "function_call" ? item.call_id : item.type), [
    "reasoning",
    "call_multi_a",
    "call_multi_b",
  ]);
});

test("a tool fragment before later reasoning still produces SDK-valid output indexes", async () => {
  let upstreamCall = 0;
  const rawBridgeBodies: Array<Promise<string>> = [];
  const bridge = createKimiResponsesFetcher({
    fetch: async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) {
        return sseResponse([
          chatChunk("chatcmpl-tool-before-reasoning", {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_tool_before_reasoning",
              type: "function",
              function: { name: "read_", arguments: "{\"city\":" },
            }],
          }),
          chatChunk("chatcmpl-tool-before-reasoning", { reasoning_content: "Need the temperature." }),
          chatChunk("chatcmpl-tool-before-reasoning", {
            tool_calls: [{
              index: 0,
              function: { name: "temperature", arguments: "\"Berlin\"}" },
            }],
          }, "tool_calls"),
        ]);
      }
      return sseResponse([
        chatChunk("chatcmpl-tool-before-reasoning-final", {
          role: "assistant",
          content: "finished",
        }, "stop"),
      ]);
    },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const readTemperature = tool({
    name: "read_temperature",
    description: "Read temperature",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temperatureC: 18 }),
  });
  const result = publicAgent(async (input, init) => {
    const response = await bridge(input, init);
    rawBridgeBodies.push(response.clone().text());
    return response;
  }).callModel({
    model: "kimi-for-coding",
    input: "read it",
    tools: [readTemperature] as const,
  });
  const [text, calls] = await Promise.all([result.getText(), result.getToolCalls()]);
  assert.equal(text, "finished");
  assert.deepEqual(calls, [{
    id: "call_tool_before_reasoning",
    name: "read_temperature",
    arguments: { city: "Berlin" },
  }]);
  assert.equal(upstreamCall, 2);
  const firstBody = await rawBridgeBodies[0];
  const addedIndexes = firstBody!.split(/\n\n/)
    .filter((block) => block.startsWith("data: {") && block.includes('"type":"response.output_item.added"'))
    .map((block) => (JSON.parse(block.slice(6)) as { output_index: number }).output_index);
  assert.deepEqual(addedIndexes, [0, 1], "published output indexes must follow event order for the pinned SDK");
});

test("multi-tool streams reject duplicate IDs, index rebinds, and incomplete terminal identities", async () => {
  const invalid = [
    [
      chatChunk("chatcmpl-invalid-multi", { role: "assistant", reasoning_content: "Need tools." }),
      chatChunk("chatcmpl-invalid-multi", { tool_calls: [
        { index: 0, id: "call_duplicate", type: "function", function: { name: "a", arguments: "{}" } },
        { index: 1, id: "call_duplicate", type: "function", function: { name: "b", arguments: "{}" } },
      ] }, "tool_calls"),
    ],
    [
      chatChunk("chatcmpl-invalid-multi", { role: "assistant", reasoning_content: "Need tools." }),
      chatChunk("chatcmpl-invalid-multi", { tool_calls: [
        { index: 0, id: "call_original", type: "function", function: { name: "a", arguments: "{" } },
      ] }),
      chatChunk("chatcmpl-invalid-multi", { tool_calls: [
        { index: 0, id: "call_rebound", function: { arguments: "}" } },
      ] }, "tool_calls"),
    ],
    [
      chatChunk("chatcmpl-invalid-multi", { role: "assistant", reasoning_content: "Need tools." }),
      chatChunk("chatcmpl-invalid-multi", { tool_calls: [
        { index: 0, id: "call_no_name", type: "function", function: { arguments: "{}" } },
      ] }, "tool_calls"),
    ],
  ];
  const offeredTools = [
    { ...PINNED_TOOL, name: "a" },
    { ...PINNED_TOOL, name: "b" },
  ];
  for (const events of invalid) {
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => sseResponse(events),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello", {
      tools: offeredTools,
    })));
    await assert.rejects(response.text(), /Kimi/i);
  }
});

test("malformed, unknown, unterminated, duplicate-terminal, missing-ID, oversized, and invalid UTF-8 streams fail closed", async () => {
  const validTerminal = chatChunk("chatcmpl-invalid-stream", { role: "assistant", content: "ok" }, "stop", {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  const cases: readonly { name: string; bytes: Uint8Array }[] = [
    { name: "malformed JSON", bytes: new TextEncoder().encode("data: {\n\ndata: [DONE]\n\n") },
    { name: "unknown SSE event", bytes: new TextEncoder().encode("event: surprise\ndata: {}\n\ndata: [DONE]\n\n") },
    { name: "missing DONE", bytes: new TextEncoder().encode(`data: ${JSON.stringify(validTerminal)}\n\n`) },
    { name: "truncated final block", bytes: new TextEncoder().encode(`data: ${JSON.stringify(validTerminal)}`) },
    { name: "duplicate terminal", bytes: new TextEncoder().encode(`data: ${JSON.stringify(validTerminal)}\n\ndata: ${JSON.stringify(validTerminal)}\n\ndata: [DONE]\n\n`) },
    {
      name: "missing tool id",
      bytes: new TextEncoder().encode(`data: ${JSON.stringify(chatChunk("chatcmpl-invalid-stream", {
        tool_calls: [{ index: 0, type: "function", function: { name: "read", arguments: "{}" } }],
      }, "tool_calls", {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 1 },
      }))}\n\ndata: [DONE]\n\n`),
    },
    { name: "oversized line", bytes: new TextEncoder().encode(`data: ${"x".repeat(70 * 1024)}\n\n`) },
    {
      name: "oversized multibyte line",
      bytes: new TextEncoder().encode(`data: ${JSON.stringify(chatChunk(
        "chatcmpl-multibyte-line",
        { role: "assistant", content: "€".repeat(22 * 1024) },
        "stop",
        {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      ))}\n\ndata: [DONE]\n\n`),
    },
    { name: "oversized body", bytes: new TextEncoder().encode("\n".repeat(1_048_577)) },
    { name: "fatal UTF-8", bytes: Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]) },
  ];
  for (const fixture of cases) {
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fixture.bytes);
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    await assert.rejects(
      response.text(),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /chatcmpl-invalid-stream|surprise|x{32}/);
        return true;
      },
      fixture.name,
    );
  }
});

test("terminal Responses events are withheld until one finish, one DONE, and clean EOF are validated", async () => {
  const terminal = `data: ${JSON.stringify(chatChunk("chatcmpl-late-terminal", { role: "assistant", content: "ok" }, "stop", {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  }))}\n\ndata: [DONE]\n\n`;
  const lateInvalid = `${terminal}data: ${JSON.stringify(chatChunk("chatcmpl-late-terminal", { content: "late" }, "stop"))}\n\n`;
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => new Response(lateInvalid, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  const reader = response.body!.getReader();
  let published = "";
  await assert.rejects(async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      published += new TextDecoder().decode(next.value);
    }
  }, /Kimi/i);
  assert.doesNotMatch(published, /response\.completed|data: \[DONE\]/);
});

test("response.created is an in-progress shell and finish reasons map without inventing usage", async () => {
  for (const fixture of [
    { finish: "stop", terminalType: "response.completed", status: "completed", incomplete: null },
    { finish: "length", terminalType: "response.incomplete", status: "incomplete", incomplete: { reason: "max_output_tokens" } },
    { finish: "content_filter", terminalType: "response.incomplete", status: "incomplete", incomplete: { reason: "content_filter" } },
  ] as const) {
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => sseResponse([
        chatChunk("chatcmpl-finish-map", { role: "assistant", content: "partial" }, fixture.finish as never),
      ]),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    const blocks = (await response.text()).split(/\n\n/)
      .filter((block) => block.startsWith("data: {") )
      .map((block) => JSON.parse(block.slice(6)) as { type: string; response?: Record<string, unknown> });
    const created = blocks[0];
    assert.equal(created?.type, "response.created");
    assert.equal(created?.response?.status, "in_progress");
    assert.equal(created?.response?.completed_at, null);
    assert.deepEqual(created?.response?.output, []);
    assert.equal(created?.response?.usage, null);
    const terminal = blocks.at(-1);
    assert.equal(terminal?.type, fixture.terminalType);
    assert.equal(terminal?.response?.status, fixture.status);
    assert.deepEqual(terminal?.response?.incomplete_details, fixture.incomplete);
    assert.equal(terminal?.response?.usage, null);
  }

  const unknownFinish = createKimiResponsesFetcher({
    fetch: async () => sseResponse([{
      ...chatChunk("chatcmpl-finish-unknown", { role: "assistant", content: "x" }),
      choices: [{ index: 0, delta: { role: "assistant", content: "x" }, logprobs: null, finish_reason: "future_reason" }],
    }]),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const rejected = await unknownFinish(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  await assert.rejects(rejected.text(), /Kimi/i);
});

test("provider usage is optional but, when present, must be finite nonnegative and internally consistent", async () => {
  const invalidUsage = [
    { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
    { prompt_tokens: 1, completion_tokens: 1, total_tokens: 99 },
    { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
    {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  ];
  for (const usage of invalidUsage) {
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => sseResponse([
        chatChunk("chatcmpl-invalid-usage", { role: "assistant", content: "x" }, "stop", usage),
      ]),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    await assert.rejects(response.text(), /Kimi/i);
  }
});

test("stream identity, choice, role, and exact delta shape are frozen after the first frame", async () => {
  const first = chatChunk("chatcmpl-frozen", { role: "assistant", content: "a" });
  const mutations: object[] = [
    { ...chatChunk("chatcmpl-other", { content: "b" }, "stop"), model: MODEL },
    { ...chatChunk("chatcmpl-frozen", { content: "b" }, "stop"), model: "k3-256k" },
    { ...chatChunk("chatcmpl-frozen", { content: "b" }, "stop"), object: "future.chunk" },
    { ...chatChunk("chatcmpl-frozen", { content: "b" }, "stop"), created: 1_775_000_001 },
    { ...chatChunk("chatcmpl-frozen", { content: "b" }), choices: [{ index: 1, delta: { content: "b" }, logprobs: null, finish_reason: "stop" }] },
    { ...chatChunk("chatcmpl-frozen", { role: "user", content: "b" }, "stop") },
    { ...chatChunk("chatcmpl-frozen", { content: "b", unexpected: "canary" }, "stop") },
  ];
  for (const mutation of mutations) {
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => sseResponse([first, mutation]),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    await assert.rejects(response.text(), (error: unknown) => {
      assert.match(String(error), /Kimi/i);
      assert.doesNotMatch(String(error), /canary|chatcmpl-other|future\.chunk/);
      return true;
    });
  }
});

test("the fatal streaming decoder accepts a multibyte code point split across chunks", async () => {
  const source = new TextEncoder().encode([
    `data: ${JSON.stringify(chatChunk("chatcmpl-utf8", { role: "assistant", content: "Preis €" }, "stop", {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    }))}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
  const euroLead = source.indexOf(0xe2);
  assert.ok(euroLead > 0);
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(source.slice(0, euroLead + 1));
      controller.enqueue(source.slice(euroLead + 1, euroLead + 2));
      controller.enqueue(source.slice(euroLead + 2));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const bridge = createKimiResponsesFetcher({
    fetch: async () => upstream,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const client = publicAgent((input, init) => bridge(input, init));
  assert.equal(await client.callModel({ model: "kimi-for-coding", input: "hello", tools: [] }).getText(), "Preis €");
});

test("a declared oversized provider body fails before any provider bytes are published", async () => {
  let pulled = 0;
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }, { highWaterMark: 0 }), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "content-length": "1048577",
      },
    }),
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  assert.equal(response.status, 400);
  assert.equal(pulled, 0);
});

test("consumer cancellation cancels the provider body once and publishes no late terminal event", async () => {
  let cancelled = 0;
  let enqueueLate: (() => void) | null = null;
  const first = new TextEncoder().encode(`data: ${JSON.stringify(chatChunk(
    "chatcmpl-consumer-cancel",
    { role: "assistant", content: "partial" },
  ))}\n\n`);
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      enqueueLate = () => controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      setTimeout(() => {
        try {
          controller.close();
        } catch {
          // The strict bridge may already have cancelled the upstream source.
        }
      }, 75);
    },
    cancel() {
      cancelled += 1;
      enqueueLate = null;
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetcher = createKimiResponsesFetcher({
    fetch: async () => upstream,
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
  const reader = response.body!.getReader();
  const firstOutput = await reader.read();
  assert.equal(firstOutput.done, false);
  assert.doesNotMatch(new TextDecoder().decode(firstOutput.value), /response\.completed|\[DONE\]/);
  await reader.cancel("consumer stopped");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelled, 1);
  assert.equal(enqueueLate, null);
});

test("provider cancellation is initiated but never awaited on wrong-content, stream-error, and consumer-cancel paths", async (t) => {
  const never = new Promise<void>(() => {});
  const bounded = async (operation: Promise<unknown>): Promise<void> => {
    const outcome = await Promise.race([
      operation.then(() => "settled", () => "settled"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.equal(outcome, "settled");
  };

  await t.test("wrong content type", async () => {
    let cancellations = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancellations += 1;
          return never;
        },
      }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/plain" } }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    await bounded(fetcher(sdkRequest(literalResponsesRequest("k3", "hello"))));
    assert.equal(cancellations, 1);
  });

  await t.test("invalid stream", async () => {
    let cancellations = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: invalid\n\n"));
        },
        cancel() {
          cancellations += 1;
          return never;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    await bounded(response.text());
    assert.equal(cancellations, 1);
  });

  await t.test("consumer cancel", async () => {
    let cancellations = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chatChunk(
            "chatcmpl-never-cancel",
            { role: "assistant", content: "partial" },
          ))}\n\n`));
        },
        cancel() {
          cancellations += 1;
          return never;
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(literalResponsesRequest("kimi-for-coding", "hello")));
    const reader = response.body!.getReader();
    await reader.read();
    await bounded(reader.cancel());
    assert.equal(cancellations, 1);
  });
});

test("SDK auth/provider/plugin/fallback/image shapes are rejected before upstream and dependency canaries are sanitized", async () => {
  const invalid = [
    literalResponsesRequest("k3", "hello", { provider: { sort: "price" } }),
    literalResponsesRequest("k3", "hello", { plugins: [{ id: "web" }] }),
    { ...literalResponsesRequest("k3", "hello"), model: undefined, models: ["k3", "k3-256k"] },
    literalResponsesRequest("k3", [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,SECRET_IMAGE" }] }]),
  ];
  for (const body of invalid) {
    let upstreamCalls = 0;
    const fetcher = createKimiResponsesFetcher({
      fetch: async () => {
        upstreamCalls += 1;
        throw new Error("DEPENDENCY_CANARY");
      },
      url: KIMI_CHAT_COMPLETIONS_URL,
      now: () => FIXED_NOW_MS,
    });
    const response = await fetcher(sdkRequest(body));
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  }

  const fetcher = createKimiResponsesFetcher({
    fetch: async () => { throw new Error("DEPENDENCY_CANARY Authorization: Bearer RAW_SECRET request-id=RAW_ID"); },
    url: KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  });
  await assert.rejects(
    fetcher(sdkRequest(literalResponsesRequest("k3", "hello"))),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /Kimi/i);
      assert.doesNotMatch(message, /DEPENDENCY_CANARY|Authorization|RAW_SECRET|RAW_ID/);
      return true;
    },
  );
});
