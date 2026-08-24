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
    body: JSON.stringify({ model: MODEL, input: "hello", stream: true }),
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
      body: JSON.stringify({ model: MODEL, input: "hello", stream: true }),
    }),
    new Request(`${SDK_SERVER_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    new Request(`${SDK_SERVER_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: [{ type: "unknown" }], stream: true }),
    }),
  ];

  for (const request of cases) {
    const response = await fetcher(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), SANITIZED_ERROR);
  }
  assert.equal(upstreamCalls, 0);
});

test("the factory accepts only the reviewed Kimi Code Chat Completions URL", () => {
  assert.throws(() => createKimiResponsesFetcher({
    fetch: async () => new Response(),
    url: "https://api.moonshot.ai/v1/chat/completions" as typeof KIMI_CHAT_COMPLETIONS_URL,
    now: () => FIXED_NOW_MS,
  }), { message: "Kimi Responses bridge rejected the request." });
});
