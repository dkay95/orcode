import assert from "node:assert/strict";
import test from "node:test";

import {
  digestFinalKimiProviderRequest,
  parseFinalKimiProviderRequestJson,
  parseStrictJsonValue,
  type FinalKimiProviderRequestV1,
} from "../src/kimi-provider-request-digest.js";

function finalRequest(): FinalKimiProviderRequestV1 {
  return {
    version: 1,
    url: "https://api.kimi.com/coding/v1/chat/completions",
    method: "POST",
    model: "k3",
    headers: [
      ["accept", "text/event-stream, application/json"],
      ["content-type", "application/json"],
    ],
    credentialHeaders: ["authorization"],
    messages: [
      {
        role: "system",
        content: "system",
        reasoningContent: null,
        toolCalls: [],
        toolCallId: null,
      },
      {
        role: "assistant",
        content: null,
        reasoningContent: "reasoning",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
        toolCallId: null,
      },
      {
        role: "tool",
        content: "contents",
        reasoningContent: null,
        toolCalls: [],
        toolCallId: "call-1",
      },
      {
        role: "user",
        content: "continue",
        reasoningContent: null,
        toolCalls: [],
        toolCallId: null,
      },
    ],
    tools: [{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: {
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      strict: null,
    }],
    options: {
      maxCompletionTokens: 1024,
      promptCacheKey: "cache-1",
      reasoningEffort: "high",
      stream: true,
      thinking: null,
      toolChoice: null,
    },
  };
}

function cloneRequest(): FinalKimiProviderRequestV1 {
  return structuredClone(finalRequest());
}

test("canonical digest changes for every final provider-request field", () => {
  const base = finalRequest();
  const digest = digestFinalKimiProviderRequest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const mutations: Array<[string, (request: FinalKimiProviderRequestV1) => void]> = [
    ["version", (request) => { (request as { version: number }).version = 2; }],
    ["url", (request) => { (request as { url: string }).url = "https://invalid.example/provider"; }],
    ["method", (request) => { (request as { method: string }).method = "GET"; }],
    ["model", (request) => { (request as { model: string }).model = "k3-256k"; }],
    ["headers.name", (request) => { (request.headers[1] as [string, string])[0] = "user-agent"; }],
    ["headers.value", (request) => { (request.headers[0] as [string, string])[1] = "application/json"; }],
    ["credentialHeaders", (request) => { (request.credentialHeaders as string[])[0] = "x-api-key"; }],
    ["messages.role", (request) => { (request.messages[3] as { role: string }).role = "system"; }],
    ["messages.content", (request) => { (request.messages[3] as { content: string }).content = "changed"; }],
    ["messages.reasoningContent", (request) => {
      (request.messages[1] as { reasoningContent: string }).reasoningContent = "changed";
    }],
    ["messages.toolCalls.id", (request) => { (request.messages[1]!.toolCalls[0] as { id: string }).id = "call-2"; }],
    ["messages.toolCalls.name", (request) => { (request.messages[1]!.toolCalls[0] as { name: string }).name = "write_file"; }],
    ["messages.toolCalls.arguments", (request) => {
      (request.messages[1]!.toolCalls[0] as { arguments: string }).arguments = "{}";
    }],
    ["messages.toolCallId", (request) => { (request.messages[2] as { toolCallId: string }).toolCallId = "call-2"; }],
    ["tools.name", (request) => { (request.tools[0] as { name: string }).name = "write_file"; }],
    ["tools.description", (request) => { (request.tools[0] as { description: string }).description = "Changed"; }],
    ["tools.parameters", (request) => {
      (request.tools[0]!.parameters as { required: string[] }).required[0] = "other";
    }],
    ["options.maxCompletionTokens", (request) => {
      (request.options as { maxCompletionTokens: number }).maxCompletionTokens = 2048;
    }],
    ["options.promptCacheKey", (request) => {
      (request.options as { promptCacheKey: string }).promptCacheKey = "cache-2";
    }],
    ["options.reasoningEffort", (request) => {
      (request.options as { reasoningEffort: string }).reasoningEffort = "max";
    }],
    ["options.stream", (request) => { (request.options as { stream: boolean }).stream = false; }],
    ["options.thinking", (request) => { (request.options as { thinking: string | null }).thinking = "enabled:all"; }],
    ["options.toolChoice", (request) => { (request.options as { toolChoice: string | null }).toolChoice = "none"; }],
  ];
  for (const [path, mutate] of mutations) {
    const changed = cloneRequest();
    mutate(changed);
    if (path === "version"
      || path === "url"
      || path === "method"
      || path === "credentialHeaders"
      || path === "messages.toolCalls.id"
      || path === "messages.toolCallId") {
      assert.throws(() => digestFinalKimiProviderRequest(changed), { name: "TypeError" }, path);
    } else {
      assert.notEqual(digestFinalKimiProviderRequest(changed), digest, path);
    }
  }
});

test("digest validation rejects non-canonical and secret-bearing request shapes", () => {
  const cases: Array<[string, (request: FinalKimiProviderRequestV1) => void]> = [
    ["unknown field", (request) => { (request as unknown as Record<string, unknown>).extra = true; }],
    ["mixed-case header", (request) => { (request.headers[0] as [string, string])[0] = "Accept"; }],
    ["duplicate header", (request) => {
      (request.headers as [string, string][]).push(["accept", "other"]);
    }],
    ["credential value", (request) => {
      (request.headers as [string, string][]).push(["authorization", "Bearer secret"]);
    }],
    ["duplicate tool", (request) => { (request.tools as unknown[]).push(structuredClone(request.tools[0])); }],
    ["duplicate tool call", (request) => {
      (request.messages[1]!.toolCalls as unknown[]).push(structuredClone(request.messages[1]!.toolCalls[0]));
    }],
    ["float", (request) => {
      (request.options as unknown as Record<string, unknown>).maxCompletionTokens = 1.5;
    }],
    ["undefined", (request) => {
      (request.options as unknown as Record<string, unknown>).thinking = undefined;
    }],
    ["accessor", (request) => {
      Object.defineProperty(request.options, "thinking", { enumerable: true, get: () => null });
    }],
    ["prototype", (request) => { Object.setPrototypeOf(request.options, { inherited: true }); }],
  ];
  for (const [name, mutate] of cases) {
    const request = cloneRequest();
    mutate(request);
    assert.throws(() => digestFinalKimiProviderRequest(request), { name: "TypeError" }, name);
  }
  assert.throws(
    () => parseFinalKimiProviderRequestJson('{"version":1,"version":1}'),
    /duplicate/i,
  );
});

test("canonical digest includes nested own __proto__ fields", () => {
  const base = finalRequest();
  const changed = cloneRequest();
  Object.defineProperty(changed.tools[0]!.parameters, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { poisoned: true },
    writable: true,
  });

  assert.notEqual(
    digestFinalKimiProviderRequest(changed),
    digestFinalKimiProviderRequest(base),
  );
});

test("final request accepts only public bridge headers and the authorization credential name", () => {
  const cases: Array<[string, (request: FinalKimiProviderRequestV1) => void]> = [
    ["value-bearing authorization", (request) => {
      (request as unknown as { headers: [string, string][] }).headers = [["authorization", "Bearer secret"]];
      (request as unknown as { credentialHeaders: string[] }).credentialHeaders = [];
    }],
    ["missing authorization name", (request) => {
      (request as unknown as { credentialHeaders: string[] }).credentialHeaders = [];
    }],
    ["wrong credential name", (request) => {
      (request as unknown as { credentialHeaders: string[] }).credentialHeaders = ["x-api-key"];
    }],
    ["unknown public header", (request) => {
      (request as unknown as { headers: [string, string][] }).headers = [["x-public", "value"]];
    }],
  ];

  for (const [name, mutate] of cases) {
    const request = cloneRequest();
    mutate(request);
    assert.throws(() => digestFinalKimiProviderRequest(request), { name: "TypeError" }, name);
  }
});

test("tool results consume one earlier declared call ID exactly once", () => {
  const duplicate = cloneRequest();
  (duplicate.messages as unknown as FinalKimiProviderRequestV1["messages"][number][]).push(
    structuredClone(duplicate.messages[2]!),
  );

  const missing = cloneRequest();
  (missing.messages[2] as { toolCallId: string }).toolCallId = "call-missing";

  const outOfOrder = cloneRequest();
  (outOfOrder as unknown as { messages: FinalKimiProviderRequestV1["messages"][number][] }).messages = [
    outOfOrder.messages[0]!,
    outOfOrder.messages[2]!,
    outOfOrder.messages[1]!,
    outOfOrder.messages[3]!,
  ];

  for (const [name, request] of [
    ["duplicate", duplicate],
    ["missing", missing],
    ["out-of-order", outOfOrder],
  ] as const) {
    assert.throws(() => digestFinalKimiProviderRequest(request), { name: "TypeError" }, name);
  }
});

test("strict JSON ingress rejects non-integer lexemes and nested duplicate keys", () => {
  for (const source of ["1.0", "1e0", "-0", '{"outer":{"key":1,"key":2}}']) {
    assert.throws(() => parseStrictJsonValue(source), SyntaxError, source);
  }
});
