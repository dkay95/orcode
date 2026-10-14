import { createHmac } from "node:crypto";
import { normalizeProviderSecret } from "./credentials.js";
import type { FetchLike } from "./reconnect.js";
import type { BalanceInfo } from "./types.js";

export const NANO_GPT_API_BASE = "https://api.nano-gpt.com" as const;
export const NANO_GPT_MAX_METADATA_BODY_BYTES = 64 * 1024;
export const NANO_GPT_MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;
export type NanoGptBillingMode = "subscription" | "payg";
export interface NanoGptModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly promptUsdPerToken: number | null;
  readonly completionUsdPerToken: number | null;
}
export interface NanoGptInspection {
  readonly models: readonly NanoGptModel[];
  readonly spend: "available" | "limit-reached" | "unknown";
  readonly balance?: BalanceInfo;
}
export interface NanoGptRequestOptions {
  signal: AbortSignal;
  deadlineAt: number;
  /** Runtime owner revalidation after policy inspection, immediately before inference. */
  assertCurrent?: () => Promise<void>;
}
export type NanoGptFailureCode = "nanogpt-auth-rejected" | "nanogpt-subscription-policy-unsafe" | "nanogpt-billing-unavailable" | "nanogpt-limit-reached" | "nanogpt-model-unavailable" | "nanogpt-offline" | "nanogpt-invalid-response" | "nanogpt-cancelled";
export interface NanoGptFailure {
  readonly code: NanoGptFailureCode;
  readonly credential: "valid" | "rejected" | "unknown";
  readonly connectivity: "connected" | "offline" | "unknown";
  readonly spend: "limit-reached" | "unknown";
  readonly retryable: boolean;
}
const MESSAGES: Record<NanoGptFailureCode, string> = {
  "nanogpt-auth-rejected": "Nano-GPT rejected the API key.",
  "nanogpt-subscription-policy-unsafe": "Nano-GPT subscription mode requires a subscription-only API key with paid-balance spending disabled in Nano-GPT key settings.",
  "nanogpt-billing-unavailable": "The explicitly selected Nano-GPT billing mode is unavailable for this key.",
  "nanogpt-limit-reached": "The Nano-GPT usage limit has been reached. No paid fallback was attempted.",
  "nanogpt-model-unavailable": "The explicitly selected Nano-GPT model is unavailable.",
  "nanogpt-offline": "Nano-GPT is currently unreachable.",
  "nanogpt-invalid-response": "Nano-GPT delivered an unsupported response or request.",
  "nanogpt-cancelled": "The Nano-GPT request was cancelled or its deadline elapsed.",
};
const ISSUED_ERRORS = new WeakSet<NanoGptRequestError>();
export class NanoGptRequestError extends Error {
  readonly failure: NanoGptFailure;
  constructor(code: NanoGptFailureCode) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : "nanogpt-invalid-response";
    super(MESSAGES[safeCode]);
    this.name = "NanoGptRequestError";
    this.failure = Object.freeze({ code: safeCode, credential: safeCode === "nanogpt-auth-rejected" ? "rejected" : safeCode === "nanogpt-offline" || safeCode === "nanogpt-invalid-response" || safeCode === "nanogpt-cancelled" ? "unknown" : "valid", connectivity: safeCode === "nanogpt-offline" ? "offline" : safeCode === "nanogpt-cancelled" || safeCode === "nanogpt-invalid-response" ? "unknown" : "connected", spend: safeCode === "nanogpt-limit-reached" ? "limit-reached" : "unknown", retryable: safeCode === "nanogpt-offline" || safeCode === "nanogpt-limit-reached" });
    Object.defineProperty(this, "failure", { writable: false, configurable: false });
  }
}
function error(code: NanoGptFailureCode): NanoGptRequestError { const result = new NanoGptRequestError(code); ISSUED_ERRORS.add(result); return result; }
export function issuedNanoGptFailure(value: unknown): NanoGptFailure | null { return value instanceof NanoGptRequestError && ISSUED_ERRORS.has(value) ? value.failure : null; }
export function describeNanoGptFailure(value: unknown): NanoGptFailure { return issuedNanoGptFailure(value) ?? new NanoGptRequestError("nanogpt-offline").failure; }
export function nanoGptBillingRealm(mode: NanoGptBillingMode): "nanogpt-subscription" | "nanogpt-payg" { assertMode(mode); return mode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg"; }
export function nanoGptAccountFingerprint(key: Uint8Array, secret: string): string {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw error("nanogpt-invalid-response");
  return `acct_nano_${createHmac("sha256", key).update("orcode:nano-gpt:account:v1\0").update(normalizeKey(secret)).digest("base64url")}`;
}
function assertMode(mode: NanoGptBillingMode): void { if (mode !== "subscription" && mode !== "payg") throw error("nanogpt-invalid-response"); }
function normalizeKey(secret: string): string { try { return normalizeProviderSecret(secret); } catch { throw error("nanogpt-invalid-response"); } }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function validNanoGptModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/u.test(value) && !value.toLowerCase().startsWith("auto-model") && !/:(online|search|fast|speed|cheap|price|latency|throughput|floor|tools|caching|cache|cached)(:|$)/iu.test(value);
}

/** Fixed-host, no-retry transport. Every generation refreshes key billing policy. */
export class NanoGptService {
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  constructor(options: { fetchImpl?: FetchLike; now?: () => number } = {}) { this.#fetch = options.fetchImpl ?? fetch; this.#now = options.now ?? Date.now; }
  async inspect(key: string, mode: NanoGptBillingMode, request: NanoGptRequestOptions): Promise<NanoGptInspection> {
    assertMode(mode);
    const spend = await this.#inspectPolicy(normalizeKey(key), mode, request);
    return Object.freeze({ models: await this.listModels(key, mode, request), spend });
  }
  async listModels(key: string, mode: NanoGptBillingMode, request: NanoGptRequestOptions): Promise<readonly NanoGptModel[]> {
    assertMode(mode);
    // Authenticated canonical catalogs can be subscription-filtered by account preference.
    // A public canonical PAYG catalog prevents falsely hiding explicitly selectable paid models.
    const path = mode === "subscription" ? "/api/subscription/v1/models?detailed=true" : "/api/v1/models?detailed=true";
    const payload = await this.#json(path, mode === "subscription" ? normalizeKey(key) : null, request);
    if (!record(payload) || !Array.isArray(payload.data) || payload.data.length > 4096) throw error("nanogpt-invalid-response");
    const models = new Map<string, NanoGptModel>();
    for (const item of payload.data) {
      if (!record(item) || !validNanoGptModelId(item.id)) continue;
      const capabilities = record(item.capabilities) ? item.capabilities : {};
      const pricing = record(item.pricing) && item.pricing.unit === "per_million_tokens" && item.pricing.currency === "USD" ? item.pricing : {};
      const price = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1_000_000 : null;
      models.set(item.id, Object.freeze({ id: item.id, name: typeof item.name === "string" && item.name.length <= 256 && !/[\0-\x1f\x7f]/u.test(item.name) ? item.name : item.id, contextLength: typeof item.context_length === "number" && Number.isSafeInteger(item.context_length) && item.context_length > 0 ? item.context_length : 0, reasoning: capabilities.reasoning === true, tools: capabilities.tool_calling === true, promptUsdPerToken: price(pricing.prompt), completionUsdPerToken: price(pricing.completion) }));
    }
    return Object.freeze([...models.values()]);
  }
  async requestResponses(key: string, mode: NanoGptBillingMode, body: Readonly<Record<string, unknown>>, request: NanoGptRequestOptions): Promise<Response> {
    assertMode(mode);
    if (!record(body) || !validNanoGptModelId(body.model) || !(typeof body.input === "string" || Array.isArray(body.input))) throw error("nanogpt-invalid-response");
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool: unknown) => !record(tool) || tool.type !== "function"))) throw error("nanogpt-invalid-response");
    const safe: Record<string, unknown> = {};
    for (const field of ["model", "input", "instructions", "max_output_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stream", "reasoning", "text", "seed"]) { if (Object.hasOwn(body, field)) safe[field] = body[field]; }
    safe.store = false; safe.retention_days = 0;
    if (mode === "payg") safe.billing_mode = "paygo";
    key = normalizeKey(key);
    await this.#inspectPolicy(key, mode, request);
    try { await request.assertCurrent?.(); }
    catch { throw error(request.signal.aborted ? "nanogpt-cancelled" : "nanogpt-invalid-response"); }
    return this.#response("/api/v1/responses", key, request, safe, mode);
  }
  async #inspectPolicy(key: string, mode: NanoGptBillingMode, request: NanoGptRequestOptions): Promise<"available" | "unknown"> {
    const payload = await this.#json("/api/subscription/v1/usage", key, request);
    if (!record(payload) || typeof payload.active !== "boolean" || !["active", "grace", "inactive"].includes(String(payload.state)) || !record(payload.routing)) throw error("nanogpt-invalid-response");
    const routing = payload.routing;
    if (!["subscription", "paygo", "unavailable"].includes(String(routing.recommendedMode)) || ![true, false, null].includes(routing.subscriptionQuotaAvailable as boolean | null) || typeof routing.paidSpendPolicyAllowsBalance !== "boolean") throw error("nanogpt-invalid-response");
    if (mode === "subscription") {
      if (routing.paidSpendPolicyAllowsBalance !== false) throw error("nanogpt-subscription-policy-unsafe");
      if (!payload.active || payload.state === "inactive") throw error("nanogpt-billing-unavailable");
      if (routing.subscriptionQuotaAvailable === false) throw error("nanogpt-limit-reached");
      if (routing.recommendedMode !== "subscription") throw error("nanogpt-billing-unavailable");
      return routing.subscriptionQuotaAvailable === true ? "available" : "unknown";
    }
    if (routing.paidSpendPolicyAllowsBalance !== true || routing.recommendedMode === "unavailable") throw error("nanogpt-billing-unavailable");
    // Policy permits PAYG; it does not prove balance or consumed spend caps.
    return "unknown";
  }
  async #json(path: string, key: string | null, request: NanoGptRequestOptions): Promise<unknown> {
    const response = await this.#response(path, key, request);
    const reader = response.body?.getReader();
    if (!reader) throw error("nanogpt-invalid-response");
    let bytes = 0;
    const maximumBytes = path.includes("/models?") ? NANO_GPT_MAX_CATALOG_BODY_BYTES : NANO_GPT_MAX_METADATA_BODY_BYTES;
    const chunks: Uint8Array[] = [];
    try {
      while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > maximumBytes) { void reader.cancel().catch(() => {}); throw error("nanogpt-invalid-response"); } chunks.push(item.value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (failure) { throw error(issuedNanoGptFailure(failure)?.code ?? "nanogpt-invalid-response"); }
    finally { reader.releaseLock(); }
  }
  async #response(path: string, key: string | null, request: NanoGptRequestOptions, body?: Record<string, unknown>, mode?: NanoGptBillingMode): Promise<Response> {
    let now: number;
    try { now = this.#now(); } catch { throw error("nanogpt-offline"); }
    if (request.signal.aborted || !Number.isFinite(now) || !Number.isFinite(request.deadlineAt) || request.deadlineAt <= now) throw error("nanogpt-cancelled");
    const controller = new AbortController();
    let rejectCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const abort = () => { controller.abort(); rejectCancelled(error("nanogpt-cancelled")); };
    const timer = setTimeout(abort, Math.min(request.deadlineAt - now, 0x7fff_ffff));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); };
    // A rejection after fetch returns must remain handled even before the consumer reads.
    void cancelled.catch(() => {});
    try {
      const headers: Record<string, string> = { Accept: body ? "text/event-stream, application/json" : "application/json" };
      if (key !== null) headers.Authorization = `Bearer ${key}`;
      if (body) headers["Content-Type"] = "application/json";
      if (mode === "payg") headers["X-Billing-Mode"] = "paygo";
      const init: RequestInit = { method: body ? "POST" : "GET", headers, redirect: "error", signal: controller.signal };
      if (body) init.body = JSON.stringify(body);
      const response = await Promise.race([Promise.resolve().then(() => this.#fetch(`${NANO_GPT_API_BASE}${path}`, init)), cancelled]);
      const assertCurrent = () => {
        let observed: number;
        try { observed = this.#now(); } catch { throw error("nanogpt-offline"); }
        if (request.signal.aborted || !Number.isFinite(observed) || observed >= request.deadlineAt) {
          controller.abort();
          throw error("nanogpt-cancelled");
        }
      };
      try { assertCurrent(); } catch (failure) { void response.body?.cancel().catch(() => {}); throw failure; }
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw error(response.status === 401 || response.status === 403 ? "nanogpt-auth-rejected" : response.status === 402 || response.status === 429 ? "nanogpt-limit-reached" : response.status === 404 ? "nanogpt-model-unavailable" : response.status >= 500 ? "nanogpt-offline" : "nanogpt-invalid-response");
      }
      const reader = response.body?.getReader();
      if (!reader) { cleanup(); return new Response(null, { status: response.status, headers: response.headers }); }
      const stream = new ReadableStream<Uint8Array>({
        async pull(target) {
          try { assertCurrent(); const next = await Promise.race([reader.read(), cancelled]); assertCurrent(); if (next.done) { cleanup(); target.close(); } else target.enqueue(next.value); }
          catch (failure) { cleanup(); void reader.cancel().catch(() => {}); target.error(error(issuedNanoGptFailure(failure)?.code ?? "nanogpt-offline")); }
        },
        cancel() { cleanup(); controller.abort(); void reader.cancel().catch(() => {}); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch (failure) { cleanup(); throw error(issuedNanoGptFailure(failure)?.code ?? (request.signal.aborted ? "nanogpt-cancelled" : "nanogpt-offline")); }
  }
}
