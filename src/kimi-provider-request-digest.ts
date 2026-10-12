import { createHash } from "node:crypto";

export const FINAL_KIMI_PROVIDER_URL = "https://api.kimi.com/coding/v1/chat/completions" as const;

const KIMI_MODELS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const PUBLIC_HEADER_NAMES = new Set(["accept", "content-type", "user-agent"]);
const MAX_CANONICAL_STRING_CHARS = 128 * 1024;

declare const kimiProviderRequestDigestBrand: unique symbol;
export type KimiProviderRequestDigest = string & {
  readonly [kimiProviderRequestDigestBrand]: true;
};

export type CanonicalKimiJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalKimiJsonValue[]
  | { readonly [key: string]: CanonicalKimiJsonValue };

export interface KimiProviderToolCallV1 {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface KimiProviderMessageV1 {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly toolCalls: readonly KimiProviderToolCallV1[];
  readonly toolCallId: string | null;
}

export interface KimiProviderToolDefinitionV1 {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: CanonicalKimiJsonValue;
  readonly strict: null;
}

export interface KimiProviderOptionsV1 {
  readonly maxCompletionTokens: number | null;
  readonly promptCacheKey: string | null;
  readonly reasoningEffort: string | null;
  readonly stream: boolean;
  readonly thinking: string | null;
  readonly toolChoice: string | null;
}

export interface KimiProviderRequestEnvelopeV1 {
  readonly version: 1;
  readonly url: typeof FINAL_KIMI_PROVIDER_URL;
  readonly method: "POST";
  readonly model: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly credentialHeaders: readonly string[];
  readonly messages: readonly KimiProviderMessageV1[];
  readonly tools: readonly KimiProviderToolDefinitionV1[];
  readonly options: KimiProviderOptionsV1;
}

export type FinalKimiProviderRequestV1 = KimiProviderRequestEnvelopeV1;

function invalid(): never {
  throw new TypeError("Invalid final Kimi provider request.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function assertDataProperties(value: object): void {
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  assertDataProperties(value);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) invalid();
}

function assertString(value: unknown, allowEmpty = false): asserts value is string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > MAX_CANONICAL_STRING_CHARS) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
}

function assertCanonicalJson(value: unknown, seen: Set<object>): asserts value is CanonicalKimiJsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertString(value, true);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid();
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
      assertDataProperties(value);
      if (Object.keys(value).length !== value.length) invalid();
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) invalid();
        assertCanonicalJson(value[index], seen);
      }
      return;
    }
    if (!isPlainObject(value)) invalid();
    assertDataProperties(value);
    for (const entry of Object.values(value)) assertCanonicalJson(entry, seen);
  } finally {
    seen.delete(value);
  }
}

function assertHeaderPairs(headers: unknown): asserts headers is readonly (readonly [string, string])[] {
  if (!Array.isArray(headers) || Object.getPrototypeOf(headers) !== Array.prototype) invalid();
  assertDataProperties(headers);
  if (Object.keys(headers).length !== headers.length) invalid();
  const seen = new Set<string>();
  let previous = "";
  for (const pair of headers) {
    if (!Array.isArray(pair)
      || Object.getPrototypeOf(pair) !== Array.prototype
      || pair.length !== 2
      || Object.keys(pair).length !== 2) invalid();
    assertDataProperties(pair);
    const [name, value] = pair;
    assertString(name);
    assertString(value, true);
    if (!HEADER_NAME.test(name)
      || name !== name.toLowerCase()
      || !PUBLIC_HEADER_NAMES.has(name)
      || /[\r\n]/.test(value)) invalid();
    const folded = name.toLowerCase();
    if (seen.has(folded) || folded <= previous) invalid();
    seen.add(folded);
    previous = folded;
  }
}

function assertCredentialHeaders(headers: unknown, publicHeaders: readonly (readonly [string, string])[]): asserts headers is readonly string[] {
  if (!Array.isArray(headers) || Object.getPrototypeOf(headers) !== Array.prototype) invalid();
  assertDataProperties(headers);
  if (Object.keys(headers).length !== headers.length
    || headers.length !== 1
    || headers[0] !== "authorization") invalid();
  const publicNames = new Set(publicHeaders.map(([name]) => name));
  const seen = new Set<string>();
  let previous = "";
  for (const name of headers) {
    assertString(name);
    if (!HEADER_NAME.test(name) || name !== name.toLowerCase()) invalid();
    if (seen.has(name) || publicNames.has(name) || name <= previous) invalid();
    seen.add(name);
    previous = name;
  }
}

function assertMessages(messages: unknown): asserts messages is readonly KimiProviderMessageV1[] {
  if (!Array.isArray(messages) || Object.getPrototypeOf(messages) !== Array.prototype) invalid();
  assertDataProperties(messages);
  if (Object.keys(messages).length !== messages.length || messages.length === 0) invalid();
  const callIds = new Set<string>();
  const consumedCallIds = new Set<string>();
  for (const message of messages) {
    if (!isPlainObject(message)) invalid();
    assertExactKeys(message, ["role", "content", "reasoningContent", "toolCalls", "toolCallId"]);
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") invalid();
    if (message.content !== null) assertString(message.content, true);
    if (message.reasoningContent !== null) assertString(message.reasoningContent, true);
    if (message.toolCallId !== null) assertString(message.toolCallId);
    if (!Array.isArray(message.toolCalls)
      || Object.getPrototypeOf(message.toolCalls) !== Array.prototype
      || Object.keys(message.toolCalls).length !== message.toolCalls.length) invalid();
    assertDataProperties(message.toolCalls);
    for (const call of message.toolCalls) {
      if (!isPlainObject(call)) invalid();
      assertExactKeys(call, ["id", "name", "arguments"]);
      assertString(call.id);
      assertString(call.name);
      assertString(call.arguments, true);
      if (callIds.has(call.id)) invalid();
      callIds.add(call.id);
    }
    if (message.role === "tool") {
      if (message.toolCallId === null || message.toolCalls.length !== 0 || message.reasoningContent !== null) invalid();
      if (!callIds.has(message.toolCallId) || consumedCallIds.has(message.toolCallId)) invalid();
      consumedCallIds.add(message.toolCallId);
    } else if (message.toolCallId !== null) invalid();
    if (message.role !== "assistant" && (message.toolCalls.length !== 0 || message.reasoningContent !== null)) invalid();
  }
}

function assertTools(tools: unknown): asserts tools is readonly KimiProviderToolDefinitionV1[] {
  if (!Array.isArray(tools) || Object.getPrototypeOf(tools) !== Array.prototype) invalid();
  assertDataProperties(tools);
  if (Object.keys(tools).length !== tools.length) invalid();
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isPlainObject(tool)) invalid();
    assertExactKeys(tool, ["type", "name", "description", "parameters", "strict"]);
    if (tool.type !== "function" || tool.strict !== null) invalid();
    assertString(tool.name);
    assertString(tool.description, true);
    if (names.has(tool.name)) invalid();
    names.add(tool.name);
    assertCanonicalJson(tool.parameters, new Set());
  }
}

function assertOptions(options: unknown): asserts options is KimiProviderOptionsV1 {
  if (!isPlainObject(options)) invalid();
  assertExactKeys(options, [
    "maxCompletionTokens",
    "promptCacheKey",
    "reasoningEffort",
    "stream",
    "thinking",
    "toolChoice",
  ]);
  if (options.maxCompletionTokens !== null
    && (!Number.isSafeInteger(options.maxCompletionTokens) || Number(options.maxCompletionTokens) <= 0)) invalid();
  for (const key of ["promptCacheKey", "reasoningEffort", "thinking", "toolChoice"] as const) {
    if (options[key] !== null) assertString(options[key]);
  }
  if (typeof options.stream !== "boolean") invalid();
}

function assertFinalRequest(value: unknown): asserts value is FinalKimiProviderRequestV1 {
  if (!isPlainObject(value)) invalid();
  assertExactKeys(value, [
    "version",
    "url",
    "method",
    "model",
    "headers",
    "credentialHeaders",
    "messages",
    "tools",
    "options",
  ]);
  if (value.version !== 1
    || value.url !== FINAL_KIMI_PROVIDER_URL
    || value.method !== "POST"
    || typeof value.model !== "string"
    || !KIMI_MODELS.has(value.model)) invalid();
  assertHeaderPairs(value.headers);
  assertCredentialHeaders(value.credentialHeaders, value.headers);
  assertMessages(value.messages);
  assertTools(value.tools);
  assertOptions(value.options);
}

function canonicalize(value: CanonicalKimiJsonValue): CanonicalKimiJsonValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly [key: string]: CanonicalKimiJsonValue };
    const sorted = Object.create(null) as Record<string, CanonicalKimiJsonValue>;
    for (const key of Object.keys(record).sort()) {
      Object.defineProperty(sorted, key, {
        configurable: true,
        enumerable: true,
        value: canonicalize(record[key]!),
        writable: true,
      });
    }
    return sorted;
  }
  return value;
}

function canonicalBytes(request: FinalKimiProviderRequestV1): Uint8Array {
  assertFinalRequest(request);
  assertCanonicalJson(request, new Set());
  return new TextEncoder().encode(JSON.stringify(canonicalize(request)));
}

export function digestFinalKimiProviderRequest(
  request: FinalKimiProviderRequestV1,
): KimiProviderRequestDigest {
  const digest = createHash("sha256").update(canonicalBytes(request)).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(digest)) invalid();
  return digest as KimiProviderRequestDigest;
}

class StrictJsonParser {
  #index = 0;
  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.#value();
    this.#space();
    if (this.#index !== this.source.length) this.#syntax();
    return value;
  }

  #syntax(): never {
    throw new SyntaxError("Invalid strict JSON.");
  }

  #space(): void {
    while (/[\u0009\u000a\u000d\u0020]/.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #value(): unknown {
    this.#space();
    const char = this.source[this.#index];
    if (char === "{") return this.#object();
    if (char === "[") return this.#array();
    if (char === '"') return this.#string();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.source.startsWith(literal, this.#index)) {
        this.#index += literal.length;
        return value;
      }
    }
    const match = /-?(?:0|[1-9][0-9]*)/y;
    match.lastIndex = this.#index;
    const number = match.exec(this.source)?.[0];
    if (number !== undefined) {
      if (number === "-0") this.#syntax();
      this.#index += number.length;
      const value = Number(number);
      if (!Number.isSafeInteger(value)) this.#syntax();
      return value;
    }
    return this.#syntax();
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.source.length) {
      const code = this.source.charCodeAt(this.#index);
      if (!escaped && code === 0x22) {
        this.#index += 1;
        try {
          const value = JSON.parse(this.source.slice(start, this.#index)) as unknown;
          if (typeof value !== "string" || value.length > MAX_CANONICAL_STRING_CHARS) this.#syntax();
          assertString(value, true);
          return value;
        } catch {
          return this.#syntax();
        }
      }
      if (!escaped && code < 0x20) this.#syntax();
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.#index += 1;
    }
    return this.#syntax();
  }

  #object(): Record<string, unknown> {
    this.#index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.#space();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      this.#space();
      if (this.source[this.#index] !== '"') this.#syntax();
      const key = this.#string();
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON object key.");
      keys.add(key);
      this.#space();
      if (this.source[this.#index] !== ":") this.#syntax();
      this.#index += 1;
      Object.defineProperty(result, key, {
        value: this.#value(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.#space();
      const delimiter = this.source[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return result;
      }
      if (delimiter !== ",") this.#syntax();
      this.#index += 1;
    }
  }

  #array(): unknown[] {
    this.#index += 1;
    const result: unknown[] = [];
    this.#space();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.#value());
      this.#space();
      const delimiter = this.source[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return result;
      }
      if (delimiter !== ",") this.#syntax();
      this.#index += 1;
    }
  }
}

export function parseStrictJsonValue(source: string): unknown {
  if (typeof source !== "string" || source.length > MAX_CANONICAL_STRING_CHARS * 8) {
    throw new SyntaxError("Invalid strict JSON.");
  }
  return new StrictJsonParser(source).parse();
}

export function parseFinalKimiProviderRequestJson(source: string): FinalKimiProviderRequestV1 {
  const value = parseStrictJsonValue(source);
  assertFinalRequest(value);
  assertCanonicalJson(value, new Set());
  return value;
}
