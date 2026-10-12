import { timingSafeEqual } from "node:crypto";

import type { RouteIdentityV1 } from "./backends.js";
import type { CrossProviderStage } from "./collaboration.js";
import {
  KimiDesktopPermitRequiredError,
  type KimiCrossStageRequestAuthority,
} from "./kimi-desktop-permit.js";
import {
  isDesktopKimiRuntimeCapability,
  visitKimiExecutionOrigin,
  type DesktopKimiRuntimeCapability,
  type KimiExecutionOrigin,
  type LocalInteractiveOwnerAuthority,
} from "./kimi-execution-origin.js";
import { createKimiRequestId } from "./native-sidecar-channel.js";
import {
  digestFinalKimiProviderRequest,
  parseStrictJsonValue,
  type CanonicalKimiJsonValue,
  type FinalKimiProviderRequestV1,
  type KimiProviderMessageV1,
} from "./kimi-provider-request-digest.js";
import {
  KIMI_CODE_USER_AGENT,
  KimiCodeRequestError,
  classifyKimiCodeHttpFailure,
  type KimiCodeFailure,
  type KimiCodeModelId,
} from "./kimi-code.js";
import type {
  ProviderCredentialAccessResult,
  ProviderCredentialAuthorityLike,
  ProviderCredentialUseContext,
} from "./provider-authority.js";

export const KIMI_CHAT_COMPLETIONS_URL = "https://api.kimi.com/coding/v1/chat/completions" as const;
export const KIMI_RESPONSES_SDK_SENTINEL = "orcode-public-sdk-protocol-sentinel" as const;

const SANITIZED_ERROR_MESSAGE = "Kimi Responses bridge rejected the request.";
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_LINE_BYTES = 64 * 1024;
const MAX_REQUEST_BODY_BYTES = 1_048_576;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface KimiBridgeBindingProof {
  readonly version: 1;
  readonly stateRevision: number;
  readonly generation: number;
  readonly connectionId: string;
  readonly backendId: "kimi-code";
  readonly accountFingerprint: string;
  readonly billingRealm: "kimi-code-membership-provider-managed-overage";
  readonly canonicalModelId: KimiCodeModelId;
}

interface DirectFetcherOptions {
  readonly fetch: FetchLike;
  readonly url: typeof KIMI_CHAT_COMPLETIONS_URL;
  readonly now: () => number;
  readonly route?: never;
  readonly binding?: never;
  readonly credentialAuthority?: never;
  readonly createRequestDeadlineAt?: never;
}

interface AuthorityFetcherOptions {
  readonly fetch: FetchLike;
  readonly url: typeof KIMI_CHAT_COMPLETIONS_URL;
  readonly now: () => number;
  readonly route: RouteIdentityV1;
  readonly binding: KimiBridgeBindingProof;
  readonly credentialAuthority: ProviderCredentialAuthorityLike;
  /** Required per-request policy seam; deliberately has no default. */
  readonly createRequestDeadlineAt: () => number;
  readonly executionOrigin?: KimiExecutionOrigin;
  readonly desktopKimiCapability?: DesktopKimiRuntimeCapability;
  readonly createDesktopTurnContext?: () => KimiDesktopTurnContext;
  readonly createDesktopCrossContext?: () => KimiDesktopCrossContext | null;
}

export interface KimiDesktopTurnContext {
  readonly sessionId: string;
  readonly childPid: number;
  readonly runId: string;
  readonly scope: Readonly<{
    signal: AbortSignal;
    assertCurrent(): void;
  }>;
}

export interface KimiDesktopCrossContext {
  readonly crossRunId: string;
  readonly stage: CrossProviderStage;
  readonly route: RouteIdentityV1;
  readonly scope: KimiCrossStageRequestAuthority;
}

export type KimiResponsesFetcherOptions = DirectFetcherOptions | AuthorityFetcherOptions;

interface JsonObject {
  readonly [key: string]: unknown;
}

interface ResponsesTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: null;
}

interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface ChatMessage {
  readonly role: "user" | "system" | "assistant" | "tool";
  readonly content: string | null;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
}

interface ParsedReasoning {
  readonly enabled: true;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

interface ParsedResponsesRequest {
  readonly model: KimiCodeModelId;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ResponsesTool[];
  readonly toolsPresent: boolean;
  readonly instructions: string | null;
  readonly reasoning: ParsedReasoning | null;
  readonly maxOutputTokens: number | null;
  readonly promptCacheKey: string | null;
  readonly toolChoice: "none" | null;
}

interface ParsedUsage {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

interface CompletedProviderResult {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: readonly {
    readonly index: number;
    readonly call: ChatToolCall;
    readonly argumentDeltas: readonly string[];
  }[];
  readonly finishReason: FinishReason;
  readonly usage: ParsedUsage | null;
}

interface LinkedAbort {
  readonly signal: AbortSignal;
  readonly abortSource: "caller" | "deadline" | null;
  checkDeadline(): void;
  finish(): void;
}

type SecretlessTransportResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "http-failure"; readonly failure: KimiCodeFailure }
  | { readonly kind: "offline" }
  | { readonly kind: "invalid-response" }
  | { readonly kind: "transport-error"; readonly cancelled: boolean }
  | { readonly kind: "stale-binding" };

class KimiBridgeError extends Error {
  constructor() {
    super(SANITIZED_ERROR_MESSAGE);
    this.name = "KimiBridgeError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function isJsonRecordText(value: string): boolean {
  try {
    return isObject(JSON.parse(value));
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function bridgeError(): KimiBridgeError {
  return new KimiBridgeError();
}

function exactDigest(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function invalidFailure(): KimiCodeFailure {
  return Object.freeze({
    code: "kimi-code-invalid-response",
    retryable: false,
    credential: "unknown",
    connectivity: "unknown",
    spend: "unknown",
  });
}

function offlineFailure(cancelled: boolean): KimiCodeFailure {
  return cancelled
    ? Object.freeze({
        code: "kimi-code-cancelled",
        retryable: false,
        credential: "unknown",
        connectivity: "unknown",
        spend: "unknown",
      })
    : Object.freeze({
        code: "kimi-code-offline",
        retryable: true,
        credential: "unknown",
        connectivity: "offline",
        spend: "unknown",
      });
}

function sanitizedErrorResponse(): Response {
  return Response.json({
    error: {
      message: SANITIZED_ERROR_MESSAGE,
      type: "invalid_request_error",
    },
  }, { status: 400 });
}

function inputContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  let text = "";
  for (const part of value) {
    if (!isObject(part)
      || !hasExactKeys(part, ["text", "type"])
      || part.type !== "input_text"
      || typeof part.text !== "string") return null;
    text += part.text;
  }
  return text;
}

function outputContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let text = "";
  for (const part of value) {
    if (!isObject(part)
      || !hasExactKeys(part, ["text", "type"])
      || part.type !== "output_text"
      || typeof part.text !== "string") return null;
    text += part.text;
  }
  return text;
}

function reasoningContent(item: JsonObject): string | null {
  if (!Array.isArray(item.content) || !Array.isArray(item.summary)) return null;
  let contentText = "";
  for (const part of item.content) {
    if (!isObject(part)
      || !hasExactKeys(part, ["text", "type"])
      || part.type !== "reasoning_text"
      || typeof part.text !== "string") return null;
    contentText += part.text;
  }
  let summaryText = "";
  for (const part of item.summary) {
    if (!isObject(part)
      || !hasExactKeys(part, ["text", "type"])
      || part.type !== "summary_text"
      || typeof part.text !== "string") return null;
    summaryText += part.text;
  }
  if (contentText.length > 0) return contentText;
  return summaryText.length > 0 ? summaryText : null;
}

function parseTools(value: unknown, present: boolean): readonly ResponsesTool[] | null {
  if (!present) return [];
  if (!Array.isArray(value)) return null;
  const tools: ResponsesTool[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (!isObject(raw)
      || !hasExactKeys(raw, ["description", "name", "parameters", "strict", "type"])
      || raw.type !== "function"
      || typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 128
      || names.has(raw.name)
      || !isObject(raw.parameters)
      || typeof raw.description !== "string" || raw.description.length > 4_096
      || raw.strict !== null) return null;
    names.add(raw.name);
    tools.push({
      type: "function",
      name: raw.name,
      description: raw.description,
      parameters: raw.parameters,
      strict: null,
    });
  }
  return tools;
}

function parseInput(value: unknown, instructions: string | null): readonly ChatMessage[] | null {
  const messages: ChatMessage[] = [];
  if (instructions !== null) messages.push({ role: "system", content: instructions });
  if (typeof value === "string") {
    messages.push({ role: "user", content: value });
    return messages;
  }
  if (!Array.isArray(value)) return null;

  let reasoning = "";
  let visibleText = "";
  const calls: ChatToolCall[] = [];
  const globalCallIds = new Set<string>();
  const outstanding: { current: Map<string, boolean> | null } = { current: null };

  const flushAssistant = (): boolean => {
    if (reasoning.length === 0 && visibleText.length === 0 && calls.length === 0) return true;
    if (outstanding.current && [...outstanding.current.values()].some((paired) => !paired)) return false;
    if (calls.length > 0 && reasoning.length === 0) return false;
    const message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: readonly ChatToolCall[];
    } = { role: "assistant", content: visibleText.length > 0 ? visibleText : null };
    if (reasoning.length > 0) message.reasoning_content = reasoning;
    if (calls.length > 0) message.tool_calls = calls.slice();
    messages.push(message);
    outstanding.current = new Map(calls.map((call) => [call.id, false] as const));
    reasoning = "";
    visibleText = "";
    calls.length = 0;
    return true;
  };

  for (const raw of value) {
    if (!isObject(raw)) return null;
    if (raw.type === "reasoning") {
      if (outstanding.current && [...outstanding.current.values()].some((paired) => !paired)) return null;
      if (!hasExactKeys(raw, ["content", "id", "status", "summary", "type"])
        || typeof raw.id !== "string" || raw.status !== "completed") return null;
      const content = reasoningContent(raw);
      if (content === null) return null;
      reasoning += content;
      continue;
    }
    if (raw.type === "message") {
      if (outstanding.current && [...outstanding.current.values()].some((paired) => !paired)) return null;
      if (!hasExactKeys(raw, ["content", "id", "role", "status", "type"])
        || raw.role !== "assistant"
        || typeof raw.id !== "string"
        || raw.status !== "completed") return null;
      const content = outputContent(raw.content);
      if (content === null) return null;
      visibleText += content;
      continue;
    }
    if (raw.type === "function_call") {
      if (outstanding.current && [...outstanding.current.values()].some((paired) => !paired)) return null;
      if (!hasExactKeys(raw, ["arguments", "call_id", "id", "name", "status", "type"])
        || typeof raw.call_id !== "string" || raw.call_id.length === 0 || globalCallIds.has(raw.call_id)
        || typeof raw.id !== "string"
        || typeof raw.name !== "string" || raw.name.length === 0
        || typeof raw.arguments !== "string"
        || raw.status !== "completed") return null;
      globalCallIds.add(raw.call_id);
      calls.push({
        id: raw.call_id,
        type: "function",
        function: { name: raw.name, arguments: raw.arguments },
      });
      continue;
    }
    if (raw.type === "function_call_output") {
      if (!hasExactKeys(raw, ["call_id", "id", "output", "type"])
        || typeof raw.call_id !== "string"
        || typeof raw.id !== "string"
        || typeof raw.output !== "string") return null;
      if (!flushAssistant()
        || !outstanding.current?.has(raw.call_id)
        || outstanding.current.get(raw.call_id)) return null;
      messages.push({ role: "tool", tool_call_id: raw.call_id, content: raw.output });
      outstanding.current.set(raw.call_id, true);
      continue;
    }
    if (raw.type === undefined && (raw.role === "user" || raw.role === "system" || raw.role === "developer")) {
      if (!flushAssistant()
        || (outstanding.current && [...outstanding.current.values()].some((paired) => !paired))
        || !hasExactKeys(raw, ["content", "role"])) return null;
      const content = inputContent(raw.content);
      if (content === null) return null;
      messages.push({ role: raw.role === "developer" ? "system" : raw.role, content });
      outstanding.current = null;
      continue;
    }
    return null;
  }
  if (!flushAssistant()) return null;
  if (outstanding.current && [...outstanding.current.values()].some((paired) => !paired)) return null;
  return messages;
}

function parseReasoning(value: unknown, present: boolean, model: KimiCodeModelId): ParsedReasoning | null | false {
  if (!present || value === null || value === undefined) return null;
  if (!isObject(value) || !hasOnlyKeys(value, ["enabled", "effort", "max_tokens"])) return false;
  if (value.enabled !== true || Object.hasOwn(value, "max_tokens")) return false;
  if (model === "kimi-for-coding" || model === "kimi-for-coding-highspeed") {
    return hasExactKeys(value, ["enabled"]) ? { enabled: true } : false;
  }
  if (Object.hasOwn(value, "effort")) {
    if (value.effort !== "low"
      && value.effort !== "medium"
      && value.effort !== "high"
      && value.effort !== "xhigh"
      && value.effort !== "max") return false;
    return { enabled: true, effort: value.effort };
  }
  return hasExactKeys(value, ["enabled"]) ? { enabled: true } : false;
}

function parseResponsesRequest(value: unknown): ParsedResponsesRequest | null {
  const allowed = [
    "input", "instructions", "max_output_tokens", "model", "prompt_cache_key", "reasoning",
    "service_tier", "store", "stream", "tool_choice", "tools",
  ] as const;
  if (!isObject(value)
    || !hasOnlyKeys(value, allowed)
    || !Object.hasOwn(value, "input")
    || !Object.hasOwn(value, "model")
    || !Object.hasOwn(value, "service_tier")
    || !Object.hasOwn(value, "store")
    || !Object.hasOwn(value, "stream")
    || (value.model !== "k3"
      && value.model !== "k3-256k"
      && value.model !== "kimi-for-coding"
      && value.model !== "kimi-for-coding-highspeed")
    || value.service_tier !== "auto"
    || value.store !== false
    || value.stream !== true) return null;

  const instructions = Object.hasOwn(value, "instructions")
    ? typeof value.instructions === "string" && value.instructions.length <= 128 * 1024
      ? value.instructions
      : null
    : null;
  if (Object.hasOwn(value, "instructions")
    && (typeof value.instructions !== "string" || instructions === null)) return null;
  const toolsPresent = Object.hasOwn(value, "tools");
  const tools = parseTools(value.tools, toolsPresent);
  if (tools === null) return null;
  const messages = parseInput(value.input, instructions);
  if (messages === null) return null;
  const reasoning = parseReasoning(value.reasoning, Object.hasOwn(value, "reasoning"), value.model);
  if (reasoning === false) return null;
  const maxOutputTokens = Object.hasOwn(value, "max_output_tokens")
    ? Number.isSafeInteger(value.max_output_tokens) && Number(value.max_output_tokens) > 0
      ? Number(value.max_output_tokens)
      : null
    : null;
  if (Object.hasOwn(value, "max_output_tokens") && maxOutputTokens === null) return null;
  const promptCacheKey = Object.hasOwn(value, "prompt_cache_key")
    ? typeof value.prompt_cache_key === "string"
      && value.prompt_cache_key.length > 0
      && value.prompt_cache_key.length <= 256
      ? value.prompt_cache_key
      : null
    : null;
  if (Object.hasOwn(value, "prompt_cache_key") && promptCacheKey === null) return null;
  const toolChoice = Object.hasOwn(value, "tool_choice")
    ? value.tool_choice === "none" ? "none" : null
    : null;
  if (Object.hasOwn(value, "tool_choice") && toolChoice === null) return null;
  if (toolChoice === "none" && !toolsPresent) return null;
  return {
    model: value.model,
    messages,
    tools,
    toolsPresent,
    instructions,
    reasoning,
    maxOutputTokens,
    promptCacheKey,
    toolChoice,
  };
}

function mappedK3Effort(reasoning: ParsedReasoning | null): "low" | "high" | "max" {
  switch (reasoning?.effort) {
    case "low": return "low";
    case "xhigh":
    case "max": return "max";
    case "medium":
    case "high":
    case undefined: return "high";
  }
}

function immutableFinalRequest(request: ParsedResponsesRequest): FinalKimiProviderRequestV1 {
  const messages: KimiProviderMessageV1[] = request.messages.map((message) => Object.freeze({
    role: message.role,
    content: message.content,
    reasoningContent: message.reasoning_content ?? null,
    toolCalls: Object.freeze((message.tool_calls ?? []).map((call) => Object.freeze({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }))),
    toolCallId: message.tool_call_id ?? null,
  }));
  const tools = request.tools.map((tool) => Object.freeze({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as CanonicalKimiJsonValue,
    strict: null,
  }));
  for (const tool of tools) deepFreezeProviderValue(tool.parameters);
  return Object.freeze({
    version: 1 as const,
    url: KIMI_CHAT_COMPLETIONS_URL,
    method: "POST" as const,
    model: request.model,
    headers: Object.freeze([
      Object.freeze(["accept", "text/event-stream, application/json"] as const),
      Object.freeze(["content-type", "application/json"] as const),
      Object.freeze(["user-agent", KIMI_CODE_USER_AGENT] as const),
    ]),
    credentialHeaders: Object.freeze(["authorization"]),
    messages: Object.freeze(messages),
    tools: Object.freeze(tools),
    options: Object.freeze({
      maxCompletionTokens: request.maxOutputTokens,
      promptCacheKey: request.promptCacheKey,
      reasoningEffort: request.model === "k3" || request.model === "k3-256k"
        ? mappedK3Effort(request.reasoning)
        : null,
      stream: true,
      thinking: request.model === "k3" || request.model === "k3-256k" ? null : "enabled:all",
      toolChoice: request.toolChoice,
    }),
  });
}

function deepFreezeProviderValue(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreezeProviderValue(entry, seen);
  Object.freeze(value);
}

function chatBodyFromFinalRequest(request: FinalKimiProviderRequestV1): object {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => {
      const result: Record<string, unknown> = { role: message.role, content: message.content };
      if (message.reasoningContent !== null) result.reasoning_content = message.reasoningContent;
      if (message.toolCalls.length > 0) {
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      if (message.toolCallId !== null) result.tool_call_id = message.toolCallId;
      return result;
    }),
    stream: request.options.stream,
  };
  if (request.options.reasoningEffort !== null) body.reasoning_effort = request.options.reasoningEffort;
  if (request.options.thinking !== null) body.thinking = { type: "enabled", keep: "all" };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.options.toolChoice !== null) body.tool_choice = request.options.toolChoice;
  if (request.options.maxCompletionTokens !== null) {
    body.max_completion_tokens = request.options.maxCompletionTokens;
  }
  if (request.options.promptCacheKey !== null) body.prompt_cache_key = request.options.promptCacheKey;
  return body;
}

function responseTool(tool: ResponsesTool): object {
  return {
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    strict: tool.strict,
    type: "function",
  };
}

function responseUsage(usage: ParsedUsage | null): object | null {
  if (usage === null) return null;
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

function responseShell(
  request: ParsedResponsesRequest,
  result: Pick<CompletedProviderResult, "id" | "model">,
  createdAt: number,
  completedAt: number | null,
  status: "in_progress" | "completed" | "incomplete",
  output: readonly object[],
  outputText: string,
  usage: ParsedUsage | null,
  incompleteReason: "max_output_tokens" | "content_filter" | null,
): object {
  return {
    background: null,
    completed_at: status === "in_progress" ? null : completedAt,
    created_at: createdAt,
    error: null,
    frequency_penalty: null,
    id: `resp_${result.id}`,
    incomplete_details: incompleteReason === null ? null : { reason: incompleteReason },
    instructions: request.instructions,
    max_output_tokens: request.maxOutputTokens,
    max_tool_calls: null,
    metadata: null,
    model: request.model,
    object: "response",
    output,
    output_text: outputText,
    parallel_tool_calls: false,
    presence_penalty: null,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: request.promptCacheKey,
    prompt_cache_options: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: null,
    status,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: request.toolChoice ?? "auto",
    tools: request.tools.map(responseTool),
    top_logprobs: null,
    top_p: null,
    truncation: null,
    usage: status === "in_progress" ? null : responseUsage(usage),
    user: null,
  };
}

function terminalStatus(finishReason: FinishReason): {
  status: "completed" | "incomplete";
  eventType: "response.completed" | "response.incomplete";
  incompleteReason: "max_output_tokens" | "content_filter" | null;
} {
  if (finishReason === "length") {
    return { status: "incomplete", eventType: "response.incomplete", incompleteReason: "max_output_tokens" };
  }
  if (finishReason === "content_filter") {
    return { status: "incomplete", eventType: "response.incomplete", incompleteReason: "content_filter" };
  }
  return { status: "completed", eventType: "response.completed", incompleteReason: null };
}

function outputItems(result: CompletedProviderResult): object[] {
  const output: object[] = [];
  if (result.reasoning.length > 0) {
    output.push({
      id: `resp_${result.id}_reasoning`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: result.reasoning }],
      content: [{ type: "reasoning_text", text: result.reasoning }],
    });
  }
  if (result.text.length > 0) {
    output.push({
      id: `resp_${result.id}_message`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  }
  for (const tool of result.toolCalls) {
    output.push({
      id: `resp_${result.id}_function_${tool.index}`,
      type: "function_call",
      status: "completed",
      call_id: tool.call.id,
      name: tool.call.function.name,
      arguments: tool.call.function.arguments,
    });
  }
  return output;
}

function nonStreamResponse(request: ParsedResponsesRequest, result: CompletedProviderResult, now: number): Response {
  const createdAt = Math.floor(now / 1_000);
  const terminal = terminalStatus(result.finishReason);
  return Response.json(responseShell(
    request,
    result,
    createdAt,
    createdAt,
    terminal.status,
    outputItems(result),
    result.text,
    result.usage,
    terminal.incompleteReason,
  ));
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseUsage(value: unknown): ParsedUsage | null | false {
  if (value === null || value === undefined) return null;
  if (!isObject(value)
    || !hasOnlyKeys(value, [
      "completion_tokens", "completion_tokens_details", "prompt_tokens", "prompt_tokens_details", "total_tokens",
    ])) return false;
  const inputTokens = safeInteger(value.prompt_tokens);
  const outputTokens = safeInteger(value.completion_tokens);
  const totalTokens = safeInteger(value.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null
    || totalTokens !== inputTokens + outputTokens) return false;
  let cachedTokens = 0;
  if (value.prompt_tokens_details !== undefined && value.prompt_tokens_details !== null) {
    if (!isObject(value.prompt_tokens_details)
      || !hasExactKeys(value.prompt_tokens_details, ["cached_tokens"])) return false;
    const parsed = safeInteger(value.prompt_tokens_details.cached_tokens);
    if (parsed === null || parsed > inputTokens) return false;
    cachedTokens = parsed;
  }
  let reasoningTokens = 0;
  if (value.completion_tokens_details !== undefined && value.completion_tokens_details !== null) {
    if (!isObject(value.completion_tokens_details)
      || !hasExactKeys(value.completion_tokens_details, ["reasoning_tokens"])) return false;
    const parsed = safeInteger(value.completion_tokens_details.reasoning_tokens);
    if (parsed === null || parsed > outputTokens) return false;
    reasoningTokens = parsed;
  }
  return { inputTokens, cachedTokens, outputTokens, reasoningTokens, totalTokens };
}

function parseFinishReason(value: unknown): FinishReason | null | false {
  if (value === null) return null;
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") return value;
  return false;
}

function parseNonStreamChat(value: unknown, request: ParsedResponsesRequest): CompletedProviderResult | null {
  if (!isObject(value)
    || !hasExactKeys(value, ["choices", "created", "id", "model", "object", "system_fingerprint", "usage"])
    || value.object !== "chat.completion"
    || typeof value.id !== "string" || value.id.length === 0
    || value.model !== request.model
    || safeInteger(value.created) === null
    || value.system_fingerprint !== null
    || !Array.isArray(value.choices) || value.choices.length !== 1) return null;
  const choice = value.choices[0];
  if (!isObject(choice)
    || !hasExactKeys(choice, ["finish_reason", "index", "logprobs", "message"])
    || choice.index !== 0 || choice.logprobs !== null
    || !isObject(choice.message)
    || !hasExactKeys(choice.message, ["content", "reasoning_content", "role", "tool_calls"])
    || choice.message.role !== "assistant"
    || (choice.message.content !== null && typeof choice.message.content !== "string")
    || (choice.message.reasoning_content !== null && typeof choice.message.reasoning_content !== "string")
    || (choice.message.tool_calls !== null && !Array.isArray(choice.message.tool_calls))) return null;
  const finishReason = parseFinishReason(choice.finish_reason);
  const usage = parseUsage(value.usage);
  if (finishReason === null || finishReason === false || usage === false) return null;
  const tools = parseCompleteToolCalls(choice.message.tool_calls);
  if (tools === null) return null;
  const reasoning = typeof choice.message.reasoning_content === "string" ? choice.message.reasoning_content : "";
  if (tools.length > 0 && reasoning.length === 0) return null;
  if (tools.length > 0) {
    if (request.toolChoice === "none" || request.tools.length === 0) return null;
    const allowedNames = new Set(request.tools.map((tool) => tool.name));
    if (tools.some((tool) => !allowedNames.has(tool.call.function.name))) return null;
  }
  if ((finishReason === "tool_calls") !== (tools.length > 0)) return null;
  return {
    id: value.id,
    model: request.model,
    created: Number(value.created),
    reasoning,
    text: typeof choice.message.content === "string" ? choice.message.content : "",
    toolCalls: tools,
    finishReason,
    usage,
  };
}

function parseCompleteToolCalls(value: unknown): CompletedProviderResult["toolCalls"] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: Array<CompletedProviderResult["toolCalls"][number]> = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isObject(raw)
      || !hasExactKeys(raw, ["function", "id", "type"])
      || typeof raw.id !== "string" || raw.id.length === 0 || ids.has(raw.id)
      || raw.type !== "function"
      || !isObject(raw.function)
      || !hasExactKeys(raw.function, ["arguments", "name"])
      || typeof raw.function.name !== "string" || raw.function.name.length === 0
      || typeof raw.function.arguments !== "string"
      || !isJsonRecordText(raw.function.arguments)) return null;
    ids.add(raw.id);
    result.push({
      index,
      call: {
        id: raw.id,
        type: "function",
        function: { name: raw.function.name, arguments: raw.function.arguments },
      },
      argumentDeltas: [raw.function.arguments],
    });
  }
  return result;
}

function eventData(event: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function doneData(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

interface ToolAccumulator {
  readonly index: number;
  id: string;
  name: string;
  readonly argumentDeltas: string[];
}

interface StreamToolDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

function parseStreamToolDeltas(value: unknown): readonly StreamToolDelta[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const deltas: StreamToolDelta[] = [];
  for (const raw of value) {
    if (!isObject(raw)
      || !hasOnlyKeys(raw, ["function", "id", "index", "type"])
      || safeInteger(raw.index) === null
      || !isObject(raw.function)
      || !hasOnlyKeys(raw.function, ["arguments", "name"])
      || Object.keys(raw.function).length === 0
      || (Object.hasOwn(raw, "id") && (typeof raw.id !== "string" || raw.id.length === 0))
      || (Object.hasOwn(raw, "type") && raw.type !== "function")
      || (Object.hasOwn(raw.function, "name") && typeof raw.function.name !== "string")
      || (Object.hasOwn(raw.function, "arguments") && typeof raw.function.arguments !== "string")) return null;
    deltas.push({
      index: Number(raw.index),
      ...(Object.hasOwn(raw, "id") ? { id: raw.id as string } : {}),
      ...(Object.hasOwn(raw.function, "name") ? { name: raw.function.name as string } : {}),
      ...(Object.hasOwn(raw.function, "arguments") ? { arguments: raw.function.arguments as string } : {}),
    });
  }
  return deltas;
}

function projectToolDeltas(
  current: ReadonlyMap<number, ToolAccumulator>,
  deltas: readonly StreamToolDelta[],
): Map<number, ToolAccumulator> | null {
  const projected = new Map<number, ToolAccumulator>();
  for (const [index, tool] of current) {
    projected.set(index, {
      index: tool.index,
      id: tool.id,
      name: tool.name,
      argumentDeltas: [...tool.argumentDeltas],
    });
  }
  for (const delta of deltas) {
    let tool = projected.get(delta.index);
    if (!tool) {
      tool = { index: delta.index, id: "", name: "", argumentDeltas: [] };
      projected.set(delta.index, tool);
    }
    if (delta.id !== undefined) {
      if (tool.id && tool.id !== delta.id) return null;
      tool.id = delta.id;
    }
    if (delta.name !== undefined) tool.name += delta.name;
    if (delta.arguments !== undefined) tool.argumentDeltas.push(delta.arguments);
  }
  return projected;
}

class StreamTranslator {
  readonly #request: ParsedResponsesRequest;
  readonly #controller: ReadableStreamDefaultController<Uint8Array>;
  readonly #now: () => number;
  #identity: { id: string; model: string; object: string; created: number } | null = null;
  #responseCreatedAt: number | null = null;
  #reasoning = "";
  #text = "";
  readonly #tools = new Map<number, ToolAccumulator>();
  #finishReason: FinishReason | null = null;
  #usage: ParsedUsage | null = null;
  #usageSeen = false;
  #doneSeen = false;
  #choiceSeen = false;
  #sequence = 0;
  #nextOutputIndex = 0;
  #reasoningIndex: number | null = null;
  #textIndex: number | null = null;
  readonly #toolIndexes = new Map<number, number>();

  constructor(
    request: ParsedResponsesRequest,
    controller: ReadableStreamDefaultController<Uint8Array>,
    now: () => number,
  ) {
    this.#request = request;
    this.#controller = controller;
    this.#now = now;
  }

  acceptDone(): void {
    if (this.#doneSeen || this.#finishReason === null) throw bridgeError();
    this.#doneSeen = true;
  }

  acceptData(raw: unknown): void {
    if (this.#doneSeen || !isObject(raw)
      || !hasExactKeys(raw, ["choices", "created", "id", "model", "object", "system_fingerprint", "usage"])
      || typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 256
      || raw.model !== this.#request.model
      || raw.object !== "chat.completion.chunk"
      || safeInteger(raw.created) === null
      || raw.system_fingerprint !== null
      || !Array.isArray(raw.choices)) throw bridgeError();
    if (this.#identity !== null && (raw.id !== this.#identity.id
      || raw.model !== this.#identity.model
      || raw.object !== this.#identity.object
      || raw.created !== this.#identity.created)) throw bridgeError();

    const usage = parseUsage(raw.usage);
    if (usage === false) throw bridgeError();
    if (usage !== null && this.#usageSeen) throw bridgeError();
    if (raw.choices.length === 0) {
      if (usage === null || this.#finishReason === null) throw bridgeError();
      this.#usage = usage;
      this.#usageSeen = true;
      return;
    }
    if (raw.choices.length !== 1 || this.#finishReason !== null) throw bridgeError();
    const choice = raw.choices[0];
    if (!isObject(choice)
      || !hasExactKeys(choice, ["delta", "finish_reason", "index", "logprobs"])
      || choice.index !== 0 || choice.logprobs !== null
      || !isObject(choice.delta)
      || !hasOnlyKeys(choice.delta, ["content", "reasoning_content", "role", "tool_calls"])) throw bridgeError();
    const delta = choice.delta;
    const rolePresent = Object.hasOwn(delta, "role");
    if ((!this.#choiceSeen && (!rolePresent || delta.role !== "assistant"))
      || (rolePresent && delta.role !== "assistant")) throw bridgeError();
    let reasoningDelta = "";
    if (Object.hasOwn(delta, "reasoning_content")) {
      if (delta.reasoning_content !== null && typeof delta.reasoning_content !== "string") throw bridgeError();
      if (typeof delta.reasoning_content === "string") reasoningDelta = delta.reasoning_content;
    }
    let textDelta = "";
    if (Object.hasOwn(delta, "content")) {
      if (delta.content !== null && typeof delta.content !== "string") throw bridgeError();
      if (typeof delta.content === "string") textDelta = delta.content;
    }
    let toolDeltas: readonly StreamToolDelta[] | null = null;
    let projectedTools: Map<number, ToolAccumulator> | null = null;
    if (Object.hasOwn(delta, "tool_calls")) {
      if (this.#request.toolChoice === "none" || this.#request.tools.length === 0) throw bridgeError();
      toolDeltas = parseStreamToolDeltas(delta.tool_calls);
      if (toolDeltas === null) throw bridgeError();
      projectedTools = projectToolDeltas(this.#tools, toolDeltas);
      if (projectedTools === null) throw bridgeError();
      const boundIds = new Set<string>();
      const allowedNames = this.#request.tools.map((tool) => tool.name);
      for (const tool of projectedTools.values()) {
        if (tool.id.length > 0 && boundIds.has(tool.id)) throw bridgeError();
        if (tool.id.length > 0) boundIds.add(tool.id);
        if (tool.name.length > 0 && !allowedNames.some((name) => name.startsWith(tool.name))) throw bridgeError();
      }
    }
    const finish = parseFinishReason(choice.finish_reason);
    if (finish === false) throw bridgeError();
    if (finish !== null) {
      const toolCount = projectedTools?.size ?? this.#tools.size;
      if ((finish === "tool_calls") !== (toolCount > 0)) throw bridgeError();
      if (toolCount > 0 && this.#reasoning.length + reasoningDelta.length === 0) throw bridgeError();
      if (toolCount > 0) {
        const allowedNames = new Set(this.#request.tools.map((tool) => tool.name));
        const ids = new Set<string>();
        for (const tool of (projectedTools ?? this.#tools).values()) {
          if (tool.id.length === 0
            || tool.name.length === 0
            || ids.has(tool.id)
            || !allowedNames.has(tool.name)
            || !isJsonRecordText(tool.argumentDeltas.join(""))) {
            throw bridgeError();
          }
          ids.add(tool.id);
        }
      }
    }

    if (this.#identity === null) {
      const responseCreatedAt = Math.floor(this.#now() / 1_000);
      if (!Number.isSafeInteger(responseCreatedAt) || responseCreatedAt < 0) throw bridgeError();
      const identity = {
        id: raw.id,
        model: this.#request.model,
        object: "chat.completion.chunk",
        created: Number(raw.created),
      };
      this.#identity = identity;
      this.#responseCreatedAt = responseCreatedAt;
      this.#emit({
        type: "response.created",
        response: responseShell(
          this.#request,
          identity,
          responseCreatedAt,
          null,
          "in_progress",
          [],
          "",
          null,
          null,
        ),
      });
    }
    if (usage !== null) {
      this.#usage = usage;
      this.#usageSeen = true;
    }
    if (reasoningDelta.length > 0) this.#acceptReasoning(reasoningDelta);
    if (textDelta.length > 0) this.#acceptText(textDelta);
    if (toolDeltas !== null && projectedTools !== null) this.#commitToolDeltas(projectedTools);
    this.#choiceSeen = true;
    if (finish !== null) this.#finishReason = finish;
  }

  finishAtEof(): void {
    if (!this.#doneSeen || this.#finishReason === null || this.#identity === null) throw bridgeError();
    const ids = new Set<string>();
    const allowedNames = new Set(this.#request.tools.map((tool) => tool.name));
    const orderedTools = [...this.#tools.values()].sort((left, right) => left.index - right.index);
    for (const tool of orderedTools) {
      if (tool.id.length === 0 || tool.name.length === 0 || ids.has(tool.id) || !allowedNames.has(tool.name)) {
        throw bridgeError();
      }
      if (!isJsonRecordText(tool.argumentDeltas.join(""))) throw bridgeError();
      ids.add(tool.id);
    }
    const completedAt = Math.floor(this.#now() / 1_000);
    if (!Number.isSafeInteger(completedAt) || completedAt < this.#responseCreatedAt!) throw bridgeError();
    const outputByIndex = new Map<number, object>();
    if (this.#reasoningIndex !== null) {
      const id = `resp_${this.#identity.id}_reasoning`;
      this.#emit({
        type: "response.reasoning_text.done",
        item_id: id,
        output_index: this.#reasoningIndex,
        content_index: 0,
        text: this.#reasoning,
      });
      this.#emit({
        type: "response.content_part.done",
        item_id: id,
        output_index: this.#reasoningIndex,
        content_index: 0,
        part: { type: "reasoning_text", text: this.#reasoning },
      });
      const item = {
        id,
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: this.#reasoning }],
        content: [{ type: "reasoning_text", text: this.#reasoning }],
      };
      outputByIndex.set(this.#reasoningIndex, item);
      this.#emit({ type: "response.output_item.done", output_index: this.#reasoningIndex, item });
    }
    if (this.#textIndex !== null) {
      const id = `resp_${this.#identity.id}_message`;
      this.#emit({
        type: "response.output_text.done",
        item_id: id,
        output_index: this.#textIndex,
        content_index: 0,
        text: this.#text,
        logprobs: [],
      });
      this.#emit({
        type: "response.content_part.done",
        item_id: id,
        output_index: this.#textIndex,
        content_index: 0,
        part: { type: "output_text", text: this.#text, annotations: [] },
      });
      const item = {
        id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.#text, annotations: [] }],
      };
      outputByIndex.set(this.#textIndex, item);
      this.#emit({ type: "response.output_item.done", output_index: this.#textIndex, item });
    }
    for (const tool of orderedTools) {
      const outputIndex = this.#toolOutputIndex(tool.index);
      const id = `resp_${this.#identity.id}_function_${tool.index}`;
      this.#emit({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          id,
          type: "function_call",
          status: "in_progress",
          call_id: tool.id,
          name: tool.name,
          arguments: "",
        },
      });
      for (const delta of tool.argumentDeltas) {
        this.#emit({
          type: "response.function_call_arguments.delta",
          item_id: id,
          output_index: outputIndex,
          delta,
        });
      }
      const argumentsText = tool.argumentDeltas.join("");
      this.#emit({
        type: "response.function_call_arguments.done",
        item_id: id,
        output_index: outputIndex,
        name: tool.name,
        arguments: argumentsText,
      });
      const item = {
        id,
        type: "function_call",
        status: "completed",
        call_id: tool.id,
        name: tool.name,
        arguments: argumentsText,
      };
      outputByIndex.set(outputIndex, item);
      this.#emit({ type: "response.output_item.done", output_index: outputIndex, item });
    }
    const output = [...outputByIndex.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
    const terminal = terminalStatus(this.#finishReason);
    this.#emit({
      type: terminal.eventType,
      response: responseShell(
        this.#request,
        this.#identity,
        this.#responseCreatedAt!,
        completedAt,
        terminal.status,
        output,
        this.#text,
        this.#usage,
        terminal.incompleteReason,
      ),
    });
    this.#controller.enqueue(doneData());
  }

  #acceptReasoning(delta: string): void {
    if (this.#reasoningIndex === null) {
      this.#reasoningIndex = this.#nextOutputIndex++;
      const id = `resp_${this.#identity!.id}_reasoning`;
      this.#emit({
        type: "response.output_item.added",
        output_index: this.#reasoningIndex,
        item: { id, type: "reasoning", status: "in_progress", summary: [], content: [] },
      });
      this.#emit({
        type: "response.content_part.added",
        item_id: id,
        output_index: this.#reasoningIndex,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      });
    }
    this.#reasoning += delta;
    this.#emit({
      type: "response.reasoning_text.delta",
      item_id: `resp_${this.#identity!.id}_reasoning`,
      output_index: this.#reasoningIndex,
      content_index: 0,
      delta,
    });
  }

  #acceptText(delta: string): void {
    if (this.#textIndex === null) {
      this.#textIndex = this.#nextOutputIndex++;
      const id = `resp_${this.#identity!.id}_message`;
      this.#emit({
        type: "response.output_item.added",
        output_index: this.#textIndex,
        item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
      });
      this.#emit({
        type: "response.content_part.added",
        item_id: id,
        output_index: this.#textIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.#text += delta;
    this.#emit({
      type: "response.output_text.delta",
      item_id: `resp_${this.#identity!.id}_message`,
      output_index: this.#textIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  #commitToolDeltas(projected: ReadonlyMap<number, ToolAccumulator>): void {
    this.#tools.clear();
    for (const [index, tool] of projected) this.#tools.set(index, tool);
  }

  #toolOutputIndex(providerIndex: number): number {
    const existing = this.#toolIndexes.get(providerIndex);
    if (existing !== undefined) return existing;
    const outputIndex = this.#nextOutputIndex++;
    this.#toolIndexes.set(providerIndex, outputIndex);
    return outputIndex;
  }

  #emit(event: Record<string, unknown>): void {
    event.sequence_number = this.#sequence++;
    this.#controller.enqueue(eventData(event));
  }
}

function streamingResponse(
  request: ParsedResponsesRequest,
  upstream: Response,
  now: () => number,
  linked: LinkedAbort | null,
): Response {
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let finished = false;
  let upstreamCancelStarted = false;
  const cancelUpstream = (): void => {
    if (upstreamCancelStarted || upstreamReader === null) return;
    upstreamCancelStarted = true;
    void upstreamReader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          if (!upstream.body) throw bridgeError();
          upstreamReader = upstream.body.getReader();
          const translator = new StreamTranslator(request, controller, now);
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let buffered = "";
          let totalBytes = 0;
          let lineBytes = 0;
          for (;;) {
            const next = await readProviderChunk(upstreamReader, linked?.signal);
            if (next.done) break;
            if (cancelled) return;
            totalBytes += next.value.byteLength;
            if (totalBytes > MAX_PROVIDER_BODY_BYTES) throw bridgeError();
            for (const byte of next.value) {
              if (byte === 0x0a) {
                lineBytes = 0;
              } else {
                lineBytes += 1;
                if (lineBytes > MAX_SSE_LINE_BYTES) throw bridgeError();
              }
            }
            buffered += decoder.decode(next.value, { stream: true });
            for (;;) {
              const boundary = nextSseBoundary(buffered);
              if (boundary === null) break;
              const block = buffered.slice(0, boundary.index);
              buffered = buffered.slice(boundary.index + boundary.length);
              acceptSseBlock(block, translator);
            }
          }
          buffered += decoder.decode();
          if (buffered.trim().length > 0) throw bridgeError();
          translator.finishAtEof();
          if (!cancelled) controller.close();
          finished = true;
        } catch {
          if (!cancelled) {
            controller.error(linked?.abortSource !== null && linked?.abortSource !== undefined
              ? new KimiCodeRequestError(offlineFailure(linked.abortSource === "caller"))
              : bridgeError());
          }
        } finally {
          if (!finished) cancelUpstream();
          linked?.finish();
        }
      })();
    },
    cancel() {
      cancelled = true;
      cancelUpstream();
      linked?.finish();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readProviderChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    void reader.cancel().catch(() => {});
    throw bridgeError();
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => {});
      reject(bridgeError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, () => reject(bridgeError())).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function nextSseBoundary(value: string): { index: number; length: number } | null {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function acceptSseBlock(block: string, translator: StreamTranslator): void {
  if (block.trim().length === 0) return;
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) throw bridgeError();
    data.push(line.slice(5).trimStart());
  }
  const value = data.join("\n");
  if (value === "[DONE]") {
    translator.acceptDone();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw bridgeError();
  }
  translator.acceptData(parsed);
}

function parseContentLength(response: Response): number | null | false {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : false;
}

async function readBoundedBytes(response: Response, cap: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readProviderChunk(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > cap) throw bridgeError();
      chunks.push(next.value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    throw bridgeError();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readBoundedRequestJson(request: Request): Promise<unknown> {
  if (!request.body) throw bridgeError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const next = await readProviderChunk(reader, request.signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) throw bridgeError();
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return parseStrictJsonValue(text);
  } catch {
    void reader.cancel().catch(() => {});
    throw bridgeError();
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw bridgeError();
  }
}

function exactBindingMatches(context: ProviderCredentialUseContext, proof: KimiBridgeBindingProof): boolean {
  const binding = context.binding;
  return binding.version === 2
    && binding.stateRevision === proof.stateRevision
    && binding.connectionId === proof.connectionId
    && binding.backendId === proof.backendId
    && binding.enabled
    && binding.accountFingerprint === proof.accountFingerprint
    && binding.billingRealm === proof.billingRealm;
}

function linkedAbort(parent: AbortSignal, deadlineAt: number, now: () => number): LinkedAbort {
  const maximumTimerDelay = 2_147_483_647;
  const controller = new AbortController();
  let closed = false;
  let abortSource: "caller" | "deadline" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (source: "caller" | "deadline"): void => {
    if (!controller.signal.aborted) {
      abortSource = source;
      controller.abort();
    }
  };
  const onParentAbort = (): void => abort("caller");
  parent.addEventListener("abort", onParentAbort, { once: true });
  if (parent.aborted) abort("caller");
  let remaining = deadlineAt - now();
  const armDeadline = (): void => {
    const delay = Math.min(maximumTimerDelay, remaining);
    timer = setTimeout(() => {
      const clockRemaining = deadlineAt - now();
      if (!Number.isFinite(clockRemaining) || clockRemaining <= 0) {
        abort("deadline");
        return;
      }
      remaining = Math.min(remaining - delay, clockRemaining);
      if (remaining <= 0) abort("deadline");
      else armDeadline();
    }, delay);
  };
  if (!Number.isFinite(remaining) || remaining <= 0) abort("deadline");
  else if (!controller.signal.aborted) armDeadline();
  return {
    signal: controller.signal,
    get abortSource() {
      return abortSource;
    },
    checkDeadline() {
      if (abortSource !== null) return;
      const clockRemaining = deadlineAt - now();
      if (!Number.isFinite(clockRemaining) || clockRemaining <= 0) abort("deadline");
      else if (clockRemaining < remaining) {
        remaining = clockRemaining;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (!closed && !controller.signal.aborted) armDeadline();
      }
    },
    finish() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function exactRouteIdentity(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

async function authorizedProviderFetch(
  options: AuthorityFetcherOptions,
  finalRequest: FinalKimiProviderRequestV1,
  permittedDigest: string,
  effectSignal: AbortSignal,
  assertCurrent: () => void | Promise<void>,
): Promise<{ result: SecretlessTransportResult; linked: LinkedAbort }> {
  const deadlineAt = options.createRequestDeadlineAt();
  const now = options.now();
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now) || Number(deadlineAt) <= now) {
    throw new KimiCodeRequestError(invalidFailure());
  }
  const linked = linkedAbort(effectSignal, Number(deadlineAt), options.now);
  const chatBody = chatBodyFromFinalRequest(finalRequest);
  let access: ProviderCredentialAccessResult<SecretlessTransportResult>;
  try {
    if (!exactDigest(permittedDigest, digestFinalKimiProviderRequest(finalRequest))) {
      throw new KimiDesktopPermitRequiredError();
    }
    await assertCurrent();
    access = await options.credentialAuthority.withCredential({
      backendId: "kimi-code",
      connectionId: options.binding.connectionId,
      purpose: "runtime-bind",
      environmentEligibility: "forbidden",
      deadlineAt: Number(deadlineAt),
      signal: linked.signal,
    }, async (secret, context): Promise<SecretlessTransportResult> => {
      if (!exactBindingMatches(context, options.binding)) return { kind: "stale-binding" };
      try {
        const response = await options.fetch(new Request(options.url, {
          method: "POST",
          headers: {
            accept: "text/event-stream, application/json",
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            "user-agent": KIMI_CODE_USER_AGENT,
          },
          body: JSON.stringify(chatBody),
          redirect: "error",
          signal: linked.signal,
        }));
        if (linked.abortSource !== null) {
          void response.body?.cancel().catch(() => {});
          return { kind: "transport-error", cancelled: linked.abortSource === "caller" };
        }
        if (response.status === 408 || response.status >= 500) {
          void response.body?.cancel().catch(() => {});
          return { kind: "offline" };
        }
        const declared = parseContentLength(response);
        if (declared === false || (declared !== null && declared > MAX_PROVIDER_BODY_BYTES)) {
          void response.body?.cancel().catch(() => {});
          return { kind: "invalid-response" };
        }
        if (response.status < 200 || response.status >= 300) {
          let value: unknown = null;
          try {
            value = decodeJson(await readBoundedBytes(response, MAX_PROVIDER_ERROR_BODY_BYTES, linked.signal));
          } catch {
            if (linked.abortSource !== null) {
              return { kind: "transport-error", cancelled: linked.abortSource === "caller" };
            }
            return { kind: "invalid-response" };
          }
          return { kind: "http-failure", failure: classifyKimiCodeHttpFailure(response.status, value) };
        }
        const safeHeaders = new Headers();
        const contentType = response.headers.get("content-type");
        const contentLength = response.headers.get("content-length");
        if (contentType !== null) safeHeaders.set("content-type", contentType);
        if (contentLength !== null) safeHeaders.set("content-length", contentLength);
        return {
          kind: "response",
          response: new Response(response.body, { status: response.status, headers: safeHeaders }),
        };
      } catch {
        return { kind: "transport-error", cancelled: linked.abortSource === "caller" };
      }
    });
  } catch {
    return { result: { kind: "transport-error", cancelled: linked.abortSource === "caller" }, linked };
  }
  linked.checkDeadline();
  if (linked.abortSource !== null) {
    if (access.kind === "available" && access.value.kind === "response") {
      void access.value.response.body?.cancel().catch(() => {});
    }
    return { result: { kind: "transport-error", cancelled: linked.abortSource === "caller" }, linked };
  }
  if (access.kind !== "available") return { result: { kind: "stale-binding" }, linked };
  return { result: access.value, linked };
}

async function authorityFetch(
  options: AuthorityFetcherOptions,
  sdkRequest: Request,
  finalRequest: FinalKimiProviderRequestV1,
): Promise<{ result: SecretlessTransportResult; linked: LinkedAbort }> {
  const permittedDigest = digestFinalKimiProviderRequest(finalRequest);
  const terminalAuthority: { current: LocalInteractiveOwnerAuthority | null } = { current: null };
  const desktopScope: { current: KimiDesktopTurnContext["scope"] | null } = { current: null };
  const crossContext: { current: KimiDesktopCrossContext | null } = { current: null };
  let effectSignal = sdkRequest.signal;
  if (options.executionOrigin !== undefined) {
    await visitKimiExecutionOrigin(options.executionOrigin, {
      terminal: async (ownerAuthority) => {
        if (options.createDesktopTurnContext !== undefined
          || options.createDesktopCrossContext !== undefined
          || options.desktopKimiCapability !== undefined) {
          throw bridgeError();
        }
        await ownerAuthority.assertCurrent();
        terminalAuthority.current = ownerAuthority;
      },
      desktop: async (permitReader) => {
        const capability = options.desktopKimiCapability;
        if (!isDesktopKimiRuntimeCapability(capability)
          || capability.permitReader !== permitReader) {
          throw new KimiDesktopPermitRequiredError();
        }
        const possibleCross = options.createDesktopCrossContext?.() ?? null;
        if (possibleCross !== null) {
          if (!isObject(possibleCross)
            || !hasExactKeys(possibleCross, ["crossRunId", "stage", "route", "scope"])
            || typeof possibleCross.crossRunId !== "string" || possibleCross.crossRunId.length === 0
            || !["lead-analysis", "challenger-analysis", "lead-implementation", "challenger-review", "lead-repair", "challenger-repair-review"].includes(possibleCross.stage as string)
            || !isObject(possibleCross.route)
            || !hasExactKeys(possibleCross.route, [
              "version",
              "backendId",
              "accountFingerprint",
              "billingRealm",
              "requestedModelId",
              "canonicalModelId",
              "resolutionState",
            ])
            || !exactRouteIdentity(possibleCross.route as unknown as RouteIdentityV1, options.route)
            || !isObject(possibleCross.scope)
            || !hasExactKeys(possibleCross.scope, ["signal", "assertCurrent", "consumeRequest"])
            || typeof possibleCross.scope.assertCurrent !== "function"
            || typeof possibleCross.scope.consumeRequest !== "function"
            || typeof possibleCross.scope.signal !== "object" || possibleCross.scope.signal === null
            || typeof possibleCross.scope.signal.addEventListener !== "function") {
            throw new KimiDesktopPermitRequiredError();
          }
          possibleCross.scope.assertCurrent();
          crossContext.current = possibleCross;
          effectSignal = AbortSignal.any([sdkRequest.signal, possibleCross.scope.signal]);
          return;
        }

        const createContext = options.createDesktopTurnContext;
        if (typeof createContext !== "function") throw new KimiDesktopPermitRequiredError();
        const context = createContext();
        if (!isObject(context)
          || !hasExactKeys(context, ["sessionId", "childPid", "runId", "scope"])
          || typeof context.sessionId !== "string" || context.sessionId.length === 0
          || !Number.isSafeInteger(context.childPid) || Number(context.childPid) <= 0
          || Number(context.childPid) !== capability.childPid
          || typeof context.runId !== "string" || context.runId.length === 0
          || !isObject(context.scope)
          || !hasExactKeys(context.scope, ["assertCurrent", "signal"])
          || typeof context.scope.assertCurrent !== "function"
          || typeof context.scope.signal !== "object" || context.scope.signal === null
          || typeof context.scope.signal.aborted !== "boolean"
          || typeof context.scope.signal.addEventListener !== "function") {
          throw new KimiDesktopPermitRequiredError();
        }
        context.scope.assertCurrent();
        desktopScope.current = context.scope;
        const nativeNow = capability.now();
        const nativeDeadlineAt = nativeNow + 60_000;
        if (!Number.isFinite(nativeNow)
          || !Number.isSafeInteger(nativeDeadlineAt)
          || nativeDeadlineAt <= nativeNow) {
          throw new KimiDesktopPermitRequiredError();
        }
        effectSignal = AbortSignal.any([sdkRequest.signal, context.scope.signal]);
        await permitReader.issueTurn({
          requestId: createKimiRequestId(),
          sessionId: context.sessionId,
          childPid: Number(context.childPid),
          runId: context.runId,
          route: options.route,
          requestDigest: permittedDigest,
          revision: options.binding.stateRevision,
          generation: capability.generation,
          deadlineAt: nativeDeadlineAt,
        }, {
          signal: effectSignal,
          onActionWritten: capability.emitRequirement,
        });
        context.scope.assertCurrent();
      },
    });
  } else if (options.createDesktopTurnContext !== undefined
    || options.createDesktopCrossContext !== undefined
    || options.desktopKimiCapability !== undefined) {
    throw new KimiDesktopPermitRequiredError();
  }

  const activeCross = crossContext.current;
  if (activeCross !== null) {
    return activeCross.scope.consumeRequest({
      requestId: createKimiRequestId(),
      crossRunId: activeCross.crossRunId,
      stage: activeCross.stage,
      route: activeCross.route,
      request: finalRequest,
      requestDigest: permittedDigest,
    }, async (immutableRequest) => authorizedProviderFetch(
      options,
      immutableRequest,
      permittedDigest,
      effectSignal,
      () => activeCross.scope.assertCurrent(),
    ));
  }
  return authorizedProviderFetch(options, finalRequest, permittedDigest, effectSignal, async () => {
    if (desktopScope.current) desktopScope.current.assertCurrent();
    if (terminalAuthority.current) await terminalAuthority.current.assertCurrent();
  });
}

async function directFetch(
  options: DirectFetcherOptions,
  sdkRequest: Request,
  chatBody: object,
): Promise<Response> {
  try {
    return await options.fetch(new Request(options.url, {
      method: "POST",
      headers: {
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(chatBody),
      redirect: "error",
      signal: sdkRequest.signal,
    }));
  } catch {
    if (sdkRequest.signal.aborted) throw sdkRequest.signal.reason;
    throw bridgeError();
  }
}

function authorityMode(options: KimiResponsesFetcherOptions): options is AuthorityFetcherOptions {
  return "credentialAuthority" in options;
}

async function translateProviderResponse(
  request: ParsedResponsesRequest,
  response: Response,
  now: () => number,
  linked: LinkedAbort | null,
): Promise<Response> {
  if (linked?.abortSource !== null && linked?.abortSource !== undefined) {
    void response.body?.cancel().catch(() => {});
    linked.finish();
    throw new KimiCodeRequestError(offlineFailure(linked.abortSource === "caller"));
  }
  if (response.status === 408 || response.status >= 500) {
    void response.body?.cancel().catch(() => {});
    linked?.finish();
    throw new KimiCodeRequestError(offlineFailure(false));
  }
  const declared = parseContentLength(response);
  if (declared === false || (declared !== null && declared > MAX_PROVIDER_BODY_BYTES)) {
    void response.body?.cancel().catch(() => {});
    linked?.finish();
    return sanitizedErrorResponse();
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.status < 200 || response.status >= 300) {
    try {
      const raw = decodeJson(await readBoundedBytes(response, MAX_PROVIDER_ERROR_BODY_BYTES, linked?.signal));
      throw new KimiCodeRequestError(classifyKimiCodeHttpFailure(response.status, raw));
    } finally {
      linked?.finish();
    }
  }
  if (contentType === "text/event-stream") return streamingResponse(request, response, now, linked);
  if (contentType === "application/json") {
    try {
      const raw = decodeJson(await readBoundedBytes(response, MAX_PROVIDER_BODY_BYTES, linked?.signal));
      const result = parseNonStreamChat(raw, request);
      if (result === null) return sanitizedErrorResponse();
      return nonStreamResponse(request, result, now());
    } catch (error) {
      if (linked?.abortSource !== null && linked?.abortSource !== undefined) {
        throw new KimiCodeRequestError(offlineFailure(linked.abortSource === "caller"));
      }
      throw error;
    } finally {
      linked?.finish();
    }
  }
  void response.body?.cancel().catch(() => {});
  linked?.finish();
  return sanitizedErrorResponse();
}

export function createKimiResponsesFetcher(options: KimiResponsesFetcherOptions): FetchLike {
  if (options.url !== KIMI_CHAT_COMPLETIONS_URL) throw bridgeError();
  if (authorityMode(options)) {
    if (options.executionOrigin?.kind === "desktop-native"
      && typeof options.createDesktopTurnContext !== "function") throw bridgeError();
    if (options.executionOrigin?.kind === "terminal-local"
      && (options.createDesktopTurnContext !== undefined
        || options.createDesktopCrossContext !== undefined)) throw bridgeError();
    if (options.executionOrigin === undefined
      && (options.createDesktopTurnContext !== undefined
        || options.createDesktopCrossContext !== undefined)) throw bridgeError();
  }
  const immutableRoute = authorityMode(options) ? Object.freeze({
    version: options.route.version,
    backendId: options.route.backendId,
    accountFingerprint: options.route.accountFingerprint,
    billingRealm: options.route.billingRealm,
    requestedModelId: options.route.requestedModelId,
    canonicalModelId: options.route.canonicalModelId,
    resolutionState: options.route.resolutionState,
  }) : null;
  const immutableBinding = authorityMode(options) ? Object.freeze({
    version: options.binding.version,
    stateRevision: options.binding.stateRevision,
    generation: options.binding.generation,
    connectionId: options.binding.connectionId,
    backendId: options.binding.backendId,
    accountFingerprint: options.binding.accountFingerprint,
    billingRealm: options.binding.billingRealm,
    canonicalModelId: options.binding.canonicalModelId,
  }) : null;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sdkRequest = new Request(input, init);
    const sdkUrl = new URL(sdkRequest.url);
    if (sdkRequest.method !== "POST" || sdkUrl.pathname !== "/responses" || sdkUrl.search.length > 0) {
      return sanitizedErrorResponse();
    }
    const declared = sdkRequest.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_REQUEST_BODY_BYTES)) {
      void sdkRequest.body?.cancel().catch(() => {});
      return sanitizedErrorResponse();
    }
    let rawBody: unknown;
    try {
      rawBody = await readBoundedRequestJson(sdkRequest);
    } catch {
      return sanitizedErrorResponse();
    }
    const request = parseResponsesRequest(rawBody);
    if (request === null) return sanitizedErrorResponse();
    if (immutableRoute !== null && immutableBinding !== null) {
      if (immutableRoute.backendId !== "kimi-code"
        || immutableRoute.canonicalModelId !== immutableBinding.canonicalModelId
        || request.model !== immutableBinding.canonicalModelId) {
        throw new KimiCodeRequestError(invalidFailure());
      }
    }
    const finalRequest = immutableFinalRequest(request);
    const chatBody = chatBodyFromFinalRequest(finalRequest);
    if (!authorityMode(options)) {
      const response = await directFetch(options, sdkRequest, chatBody);
      return translateProviderResponse(request, response, options.now, null);
    }
    const boundOptions: AuthorityFetcherOptions = {
      fetch: options.fetch,
      url: options.url,
      now: options.now,
      route: immutableRoute!,
      binding: immutableBinding!,
      credentialAuthority: options.credentialAuthority,
      createRequestDeadlineAt: options.createRequestDeadlineAt,
      ...(options.executionOrigin === undefined ? {} : { executionOrigin: options.executionOrigin }),
      ...(options.desktopKimiCapability === undefined
        ? {}
        : { desktopKimiCapability: options.desktopKimiCapability }),
      ...(options.createDesktopTurnContext === undefined
        ? {}
        : { createDesktopTurnContext: options.createDesktopTurnContext }),
      ...(options.createDesktopCrossContext === undefined
        ? {}
        : { createDesktopCrossContext: options.createDesktopCrossContext }),
    };
    let outcome: Awaited<ReturnType<typeof authorityFetch>>;
    try {
      outcome = await authorityFetch(boundOptions, sdkRequest, finalRequest);
    } catch (error) {
      if (error instanceof KimiDesktopPermitRequiredError) throw error;
      throw error instanceof KimiCodeRequestError ? error : new KimiCodeRequestError(invalidFailure());
    }
    const { result, linked } = outcome;
    if (result.kind === "response") return translateProviderResponse(request, result.response, options.now, linked);
    linked.finish();
    if (result.kind === "http-failure") throw new KimiCodeRequestError(result.failure);
    if (result.kind === "offline") throw new KimiCodeRequestError(offlineFailure(false));
    if (result.kind === "transport-error") throw new KimiCodeRequestError(offlineFailure(result.cancelled));
    throw new KimiCodeRequestError(invalidFailure());
  };
}
