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
