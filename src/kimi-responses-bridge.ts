export const KIMI_CHAT_COMPLETIONS_URL = "https://api.kimi.com/coding/v1/chat/completions" as const;
export const KIMI_RESPONSES_SDK_SENTINEL = "orcode-public-sdk-protocol-sentinel" as const;

const SANITIZED_ERROR_MESSAGE = "Kimi Responses bridge rejected the request.";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface KimiResponsesFetcherOptions {
  readonly fetch: FetchLike;
  readonly url: typeof KIMI_CHAT_COMPLETIONS_URL;
  readonly now: () => number;
}

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
  readonly role: "user" | "system" | "developer" | "assistant" | "tool";
  readonly content: string | null;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
}

interface ParsedResponsesRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ResponsesTool[];
}

interface ChatStreamResult {
  readonly id: string;
  readonly model: string;
  readonly reasoningDeltas: readonly string[];
  readonly textDeltas: readonly string[];
  readonly toolCall: ChatToolCall | null;
  readonly toolArgumentDeltas: readonly string[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
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
      || typeof part.text !== "string") {
      return null;
    }
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
      || typeof part.text !== "string") {
      return null;
    }
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

function parseTools(value: unknown): readonly ResponsesTool[] | null {
  if (!Array.isArray(value)) return null;
  const tools: ResponsesTool[] = [];
  for (const raw of value) {
    if (!isObject(raw)
      || !hasExactKeys(raw, ["description", "name", "parameters", "strict", "type"])
      || raw.type !== "function"
      || typeof raw.name !== "string"
      || !isObject(raw.parameters)
      || typeof raw.description !== "string"
      || raw.strict !== null) {
      return null;
    }
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

function parseInput(value: unknown): readonly ChatMessage[] | null {
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (!Array.isArray(value)) return null;

  const messages: ChatMessage[] = [];
  let assistantReasoning = "";
  const assistantToolCalls: ChatToolCall[] = [];

  const flushAssistant = (): void => {
    if (assistantReasoning.length === 0 && assistantToolCalls.length === 0) return;
    if (assistantReasoning.length > 0 && assistantToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        reasoning_content: assistantReasoning,
        tool_calls: assistantToolCalls.slice(),
      });
    } else if (assistantReasoning.length > 0) {
      messages.push({ role: "assistant", content: null, reasoning_content: assistantReasoning });
    } else {
      messages.push({ role: "assistant", content: null, tool_calls: assistantToolCalls.slice() });
    }
    assistantReasoning = "";
    assistantToolCalls.length = 0;
  };

  for (const raw of value) {
    if (!isObject(raw)) return null;
    if (raw.type === "reasoning") {
      if (!hasExactKeys(raw, ["content", "id", "status", "summary", "type"])
        || typeof raw.id !== "string"
        || raw.status !== "completed") return null;
      const content = reasoningContent(raw);
      if (content === null) return null;
      assistantReasoning += content;
      continue;
    }
    if (raw.type === "function_call") {
      if (!hasExactKeys(raw, ["arguments", "call_id", "id", "name", "status", "type"])
        || typeof raw.call_id !== "string"
        || typeof raw.id !== "string"
        || typeof raw.name !== "string"
        || typeof raw.arguments !== "string"
        || raw.status !== "completed") {
        return null;
      }
      assistantToolCalls.push({
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
      flushAssistant();
      messages.push({ role: "tool", tool_call_id: raw.call_id, content: raw.output });
      continue;
    }
    if (raw.type === "message") {
      if (!hasExactKeys(raw, ["content", "id", "role", "status", "type"])
        || raw.role !== "assistant"
        || typeof raw.id !== "string"
        || raw.status !== "completed") return null;
      const content = outputContent(raw.content);
      if (content === null) return null;
      flushAssistant();
      messages.push({ role: "assistant", content });
      continue;
    }
    if (raw.type === undefined && (raw.role === "user" || raw.role === "system" || raw.role === "developer")) {
      if (!hasExactKeys(raw, ["content", "role"])) return null;
      const content = inputContent(raw.content);
      if (content === null) return null;
      flushAssistant();
      messages.push({ role: raw.role, content });
      continue;
    }
    return null;
  }
  flushAssistant();
  return messages;
}

function parseResponsesRequest(value: unknown): ParsedResponsesRequest | null {
  if (!isObject(value)
    || !hasExactKeys(value, ["input", "model", "service_tier", "store", "stream", "tools"])
    || typeof value.model !== "string"
    || value.model.length === 0
    || value.service_tier !== "auto"
    || value.store !== false
    || value.stream !== true) {
    return null;
  }
  const messages = parseInput(value.input);
  const tools = parseTools(value.tools);
  if (messages === null || tools === null) return null;
  return { model: value.model, messages, tools };
}

function toChatTool(tool: ResponsesTool): object {
  const functionDefinition: Record<string, unknown> = {
    name: tool.name,
    parameters: tool.parameters,
    description: tool.description,
  };
  return { type: "function", function: functionDefinition };
}

function buildChatBody(request: ParsedResponsesRequest): object {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  };
  if (request.tools.length > 0) body.tools = request.tools.map(toChatTool);
  return body;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseChatStream(text: string, fallbackModel: string): ChatStreamResult | null {
  let id = "";
  let model = fallbackModel;
  const reasoningDeltas: string[] = [];
  const textDeltas: string[] = [];
  const toolArgumentDeltas: string[] = [];
  let toolId = "";
  let toolName = "";
  let usage: JsonObject | null = null;

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
    if (!isObject(raw) || !Array.isArray(raw.choices)) return null;
    if (typeof raw.id === "string") id = raw.id;
    if (typeof raw.model === "string") model = raw.model;
    if (isObject(raw.usage)) usage = raw.usage;
    for (const choice of raw.choices) {
      if (!isObject(choice) || !isObject(choice.delta)) return null;
      const delta = choice.delta;
      if (typeof delta.reasoning_content === "string") reasoningDeltas.push(delta.reasoning_content);
      if (typeof delta.content === "string") textDeltas.push(delta.content);
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 1) return null;
        const call = delta.tool_calls[0];
        if (!isObject(call) || !isObject(call.function)) return null;
        if (typeof call.id === "string") toolId = call.id;
        if (typeof call.function.name === "string") toolName = call.function.name;
        if (typeof call.function.arguments === "string") toolArgumentDeltas.push(call.function.arguments);
      }
    }
  }

  const toolCall = toolId.length > 0 && toolName.length > 0
    ? {
      id: toolId,
      type: "function" as const,
      function: { name: toolName, arguments: toolArgumentDeltas.join("") },
    }
    : null;
  const promptDetails = usage !== null && isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const completionDetails = usage !== null && isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : null;
  return {
    id: id.length > 0 ? id : "chatcmpl-kimi-bridge",
    model,
    reasoningDeltas,
    textDeltas,
    toolCall,
    toolArgumentDeltas,
    usage: {
      inputTokens: integer(usage?.prompt_tokens),
      cachedTokens: integer(promptDetails?.cached_tokens),
      outputTokens: integer(usage?.completion_tokens),
      reasoningTokens: integer(completionDetails?.reasoning_tokens),
      totalTokens: integer(usage?.total_tokens),
    },
  };
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

function responseUsage(result: ChatStreamResult): object {
  return {
    input_tokens: result.usage.inputTokens,
    input_tokens_details: { cached_tokens: result.usage.cachedTokens },
    output_tokens: result.usage.outputTokens,
    output_tokens_details: { reasoning_tokens: result.usage.reasoningTokens },
    total_tokens: result.usage.totalTokens,
  };
}

function completedResponse(
  request: ParsedResponsesRequest,
  result: ChatStreamResult,
  createdAt: number,
  output: readonly object[],
  outputText: string,
): object {
  return {
    background: null,
    completed_at: createdAt,
    created_at: createdAt,
    error: null,
    frequency_penalty: null,
    id: `resp_${result.id}`,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
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
    prompt_cache_key: null,
    prompt_cache_options: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: null,
    status: "completed",
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: request.tools.map(responseTool),
    top_logprobs: null,
    top_p: null,
    truncation: null,
    usage: responseUsage(result),
    user: null,
  };
}

function eventStream(request: ParsedResponsesRequest, result: ChatStreamResult, now: number): Response {
  const createdAt = Math.floor(now / 1_000);
  const responseId = `resp_${result.id}`;
  const output: object[] = [];
  const events: object[] = [];
  let sequence = 0;
  const emit = (event: Record<string, unknown>): void => {
    event.sequence_number = sequence;
    sequence += 1;
    events.push(event);
  };

  emit({
    type: "response.created",
    response: completedResponse(request, result, createdAt, [], ""),
  });

  if (result.reasoningDeltas.length > 0) {
    const id = `${responseId}_reasoning`;
    const text = result.reasoningDeltas.join("");
    emit({
      type: "response.output_item.added",
      output_index: output.length,
      item: { id, type: "reasoning", status: "in_progress", summary: [], content: [] },
    });
    emit({
      type: "response.content_part.added",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    });
    for (const delta of result.reasoningDeltas) {
      emit({
        type: "response.reasoning_text.delta",
        item_id: id,
        output_index: output.length,
        content_index: 0,
        delta,
      });
    }
    emit({
      type: "response.reasoning_text.done",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      text,
    });
    emit({
      type: "response.content_part.done",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      part: { type: "reasoning_text", text },
    });
    const item = {
      id,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text }],
      content: [{ type: "reasoning_text", text }],
    };
    output.push(item);
    emit({ type: "response.output_item.done", output_index: output.length - 1, item });
  }

  if (result.textDeltas.length > 0) {
    const id = `${responseId}_message`;
    const text = result.textDeltas.join("");
    emit({
      type: "response.output_item.added",
      output_index: output.length,
      item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    emit({
      type: "response.content_part.added",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const delta of result.textDeltas) {
      emit({
        type: "response.output_text.delta",
        item_id: id,
        output_index: output.length,
        content_index: 0,
        delta,
        logprobs: [],
      });
    }
    emit({
      type: "response.output_text.done",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      text,
      logprobs: [],
    });
    emit({
      type: "response.content_part.done",
      item_id: id,
      output_index: output.length,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    const item = {
      id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    output.push(item);
    emit({ type: "response.output_item.done", output_index: output.length - 1, item });
  }

  if (result.toolCall !== null) {
    const id = `${responseId}_function`;
    emit({
      type: "response.output_item.added",
      output_index: output.length,
      item: {
        id,
        type: "function_call",
        status: "in_progress",
        call_id: result.toolCall.id,
        name: result.toolCall.function.name,
        arguments: "",
      },
    });
    for (const delta of result.toolArgumentDeltas) {
      emit({
        type: "response.function_call_arguments.delta",
        item_id: id,
        output_index: output.length,
        delta,
      });
    }
    emit({
      type: "response.function_call_arguments.done",
      item_id: id,
      output_index: output.length,
      name: result.toolCall.function.name,
      arguments: result.toolCall.function.arguments,
    });
    const item = {
      id,
      type: "function_call",
      status: "completed",
      call_id: result.toolCall.id,
      name: result.toolCall.function.name,
      arguments: result.toolCall.function.arguments,
    };
    output.push(item);
    emit({ type: "response.output_item.done", output_index: output.length - 1, item });
  }

  emit({
    type: "response.completed",
    response: completedResponse(request, result, createdAt, output, result.textDeltas.join("")),
  });
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function createKimiResponsesFetcher(options: KimiResponsesFetcherOptions): FetchLike {
  if (options.url !== KIMI_CHAT_COMPLETIONS_URL) throw new Error(SANITIZED_ERROR_MESSAGE);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sdkRequest = new Request(input, init);
    const sdkUrl = new URL(sdkRequest.url);
    if (sdkRequest.method !== "POST" || sdkUrl.pathname !== "/responses" || sdkUrl.search.length > 0) {
      return sanitizedErrorResponse();
    }

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(await sdkRequest.text());
    } catch {
      return sanitizedErrorResponse();
    }
    const request = parseResponsesRequest(rawBody);
    if (request === null) return sanitizedErrorResponse();

    const upstreamResponse = await options.fetch(new Request(options.url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildChatBody(request)),
      signal: sdkRequest.signal,
    }));
    if (upstreamResponse.status !== 200
      || !upstreamResponse.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      return sanitizedErrorResponse();
    }
    const result = parseChatStream(await upstreamResponse.text(), request.model);
    if (result === null) return sanitizedErrorResponse();
    return eventStream(request, result, options.now());
  };
}
