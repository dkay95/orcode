import type { RouteIdentityV1 } from "./backends.js";
import { OpenRouter } from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk";
import type { ModelRuntime, RuntimeModelInfo } from "./model-runtime.js";
import { NanoGptRequestError, describeNanoGptFailure, issuedNanoGptFailure, validNanoGptModelId, type NanoGptBillingMode, type NanoGptFailureCode, type NanoGptModel, type NanoGptRequestOptions, type NanoGptService } from "./nanogpt.js";
import type { ProviderCredentialAuthorityLike, ProviderCredentialUseContext } from "./provider-authority.js";

export interface NanoGptRuntimeBindingProof {
  readonly version: 1;
  readonly stateRevision: number;
  readonly generation: number;
  readonly connectionId: string;
  readonly backendId: "nano-gpt";
  readonly accountFingerprint: string;
  readonly billingRealm: "nanogpt-subscription" | "nanogpt-payg";
  readonly canonicalModelId: string;
}

export interface NanoGptModelRuntimeOptions {
  readonly route: RouteIdentityV1;
  readonly binding: NanoGptRuntimeBindingProof;
  readonly credentialAuthority: ProviderCredentialAuthorityLike;
  readonly service: NanoGptService;
  readonly now: () => number;
  readonly createRequestDeadlineAt: () => number;
}

const SDK_ORIGIN = "https://orcode-nanogpt-sdk.invalid";
const RESPONSE_FIELDS = ["model", "input", "instructions", "max_output_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stream", "reasoning", "text", "seed"] as const;
const RUNTIME_ERRORS = new WeakMap<object, NanoGptFailureCode>();

function requestError(code: NanoGptFailureCode): NanoGptRequestError {
  const failure = new NanoGptRequestError(code);
  RUNTIME_ERRORS.set(failure, failure.failure.code);
  return failure;
}

function safeFailureMessage(failure: unknown): string {
  // The SDK wraps fetch failures with Error.cause. Follow only issued safe errors,
  // never arbitrary messages, decorated lookalikes or provider response bodies.
  let current = failure;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const code = RUNTIME_ERRORS.get(current) ?? issuedNanoGptFailure(current)?.code;
    if (code) return new NanoGptRequestError(code).message;
    try { current = current.cause; } catch { break; }
  }
  return new NanoGptRequestError("nanogpt-offline").message;
}

function sameRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.version === right.version && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function matchesAuthority(context: ProviderCredentialUseContext, proof: NanoGptRuntimeBindingProof): boolean {
  const current = context.binding;
  return context.source === "saved" && current.version === 2 && current.enabled
    && current.stateRevision === proof.stateRevision && current.connectionId === proof.connectionId
    && current.backendId === proof.backendId && current.accountFingerprint === proof.accountFingerprint
    && current.billingRealm === proof.billingRealm && current.credentialPointer.kind === "versioned"
    && current.credentialPointer.slot.version === 1 && current.credentialPointer.slot.kind === "nano-gpt";
}

function modelInfo(model: NanoGptModel): RuntimeModelInfo {
  return {
    id: model.id, name: model.name, contextLength: model.contextLength,
    // A capability bit does not establish mandatory reasoning, effort levels or defaults.
    reasoning: undefined,
    price: model.promptUsdPerToken !== null && model.completionUsdPerToken !== null
      ? { kind: "known", promptUsdPerToken: model.promptUsdPerToken, completionUsdPerToken: model.completionUsdPerToken }
      : { kind: "unknown" },
  };
}

/** Native Responses transport; the SDK sentinel never carries a provider credential. */
export function createNanoGptModelRuntime(options: NanoGptModelRuntimeOptions): ModelRuntime {
  const route = Object.freeze({ ...options.route });
  const binding = Object.freeze({ ...options.binding });
  const mode: NanoGptBillingMode = binding.billingRealm === "nanogpt-subscription" ? "subscription" : "payg";
  if (binding.version !== 1 || !Number.isSafeInteger(binding.stateRevision) || binding.stateRevision < 0
    || !Number.isSafeInteger(binding.generation) || binding.generation < 0
    || typeof binding.connectionId !== "string" || binding.connectionId.length === 0
    || binding.backendId !== "nano-gpt" || typeof binding.accountFingerprint !== "string" || binding.accountFingerprint.length === 0
    || !["nanogpt-subscription", "nanogpt-payg"].includes(binding.billingRealm)
    || !validNanoGptModelId(binding.canonicalModelId) || !validNanoGptModelId(route.requestedModelId)
    || route.version !== 1 || route.backendId !== binding.backendId || route.accountFingerprint !== binding.accountFingerprint
    || route.billingRealm !== binding.billingRealm || route.canonicalModelId !== binding.canonicalModelId
    || route.requestedModelId !== binding.canonicalModelId || route.resolutionState !== "resolved") {
    throw new Error("Nano-GPT runtime route binding or explicit model is invalid.");
  }
  const clients = new Map<"main" | "compressor", OpenRouter>();
  const assertRoute = (candidate: RouteIdentityV1): void => {
    if (!sameRoute(route, candidate)) { clients.clear(); throw new Error("Nano-GPT runtime route binding changed."); }
  };

  async function authorized<T>(signal: AbortSignal | undefined, operation: (secret: string, request: NanoGptRequestOptions) => Promise<T>): Promise<T> {
    const deadlineAt = options.createRequestDeadlineAt();
    const controller = new AbortController();
    const cancelled = () => requestError("nanogpt-cancelled");
    const assertCurrent = () => {
      const now = options.now();
      if (controller.signal.aborted || signal?.aborted || !Number.isFinite(now) || !Number.isFinite(deadlineAt) || deadlineAt <= now) {
        controller.abort();
        throw cancelled();
      }
    };
    let rejectCancellation!: (failure: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    void cancellation.catch(() => {});
    const abort = () => { controller.abort(); rejectCancellation(cancelled()); };
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streaming = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    try {
      assertCurrent();
      timer = setTimeout(abort, Math.min(deadlineAt - options.now(), 2_147_483_647));
      const access = await Promise.race([options.credentialAuthority.withCredential({ backendId: "nano-gpt", connectionId: binding.connectionId, purpose: "runtime-bind", environmentEligibility: "forbidden", deadlineAt, signal: controller.signal }, async (secret, context) => {
        assertCurrent();
        if (!matchesAuthority(context, binding)) throw new Error("Nano-GPT runtime credential binding changed.");
        let current = false;
        await context.publishIfCurrent(() => { assertCurrent(); current = true; });
        if (!current) throw new Error("Nano-GPT runtime credential binding is stale.");
        let value: T | undefined;
        try {
          value = await operation(secret, { signal: controller.signal, deadlineAt, assertCurrent: async () => {
            assertCurrent();
            let stillCurrent = false;
            await context.publishIfCurrent(() => { assertCurrent(); stillCurrent = true; });
            if (!stillCurrent) throw new Error("Nano-GPT runtime credential binding is stale.");
          } });
          assertCurrent();
          current = false;
          await context.publishIfCurrent(() => { assertCurrent(); current = true; });
          if (!current) throw new Error("Nano-GPT runtime credential binding is stale.");
          return { ok: true as const, value };
        } catch (failure) {
          if (value instanceof Response) void value.body?.cancel().catch(() => {});
          return { ok: false as const, failure: describeNanoGptFailure(failure) };
        }
      }), cancellation]);
      assertCurrent();
      if (access.kind !== "available") throw new Error("Nano-GPT runtime credential authority is unavailable or stale.");
      if (!access.value.ok) throw requestError(access.value.failure.code);
      const value = access.value.value;
      if (value instanceof Response && value.body) {
        const reader = value.body.getReader();
        streaming = true;
        const body = new ReadableStream<Uint8Array>({
          async pull(target) {
            try {
              assertCurrent();
              const next = await Promise.race([reader.read(), cancellation]);
              assertCurrent();
              if (next.done) { cleanup(); target.close(); }
              else target.enqueue(next.value);
            } catch (failure) {
              const wasCancelled = controller.signal.aborted;
              cleanup();
              controller.abort();
              void reader.cancel().catch(() => {});
              target.error(wasCancelled ? cancelled() : requestError(describeNanoGptFailure(failure).code));
            }
          },
          cancel() { cleanup(); controller.abort(); void reader.cancel().catch(() => {}); },
        }, { highWaterMark: 0 });
        return new Response(body, { status: value.status, headers: value.headers }) as T;
      }
      return value;
    } finally {
      if (!streaming) cleanup();
    }
  }

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== SDK_ORIGIN || url.pathname !== "/responses" || url.search || request.method !== "POST") throw requestError("nanogpt-invalid-response");
    let body: unknown;
    try { body = JSON.parse(await request.text()) as unknown; } catch { throw requestError("nanogpt-invalid-response"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw requestError("nanogpt-invalid-response");
    const raw = body as Record<string, unknown>;
    if (raw.model !== binding.canonicalModelId || raw.models !== undefined
      || (raw.previous_response_id !== undefined && raw.previous_response_id !== null)
      || raw.conversation !== undefined) throw requestError("nanogpt-invalid-response");
    const safe: Record<string, unknown> = {};
    for (const field of RESPONSE_FIELDS) if (Object.hasOwn(raw, field)) safe[field] = raw[field];
    return authorized(request.signal, (secret, policy) => options.service.requestResponses(secret, mode, safe, policy));
  };
  return Object.freeze({
    backendId: "nano-gpt" as const,
    createClient(request: Parameters<ModelRuntime["createClient"]>[0]) {
      assertRoute(request.route);
      const cached = clients.get(request.scope);
      if (cached) return cached;
      const client = new OpenRouter({ apiKey: "orcode-nanogpt-sdk-sentinel-not-a-key", serverURL: SDK_ORIGIN, httpClient: new HTTPClient({ fetcher }), retryConfig: { strategy: "none" } });
      clients.set(request.scope, client);
      return client;
    },
    async inspectSpend(signal?: AbortSignal) {
      const inspection = await authorized(signal, (secret, request) => options.service.inspect(secret, mode, request));
      return inspection.balance ? { kind: "known" as const, balance: inspection.balance } : { kind: "unknown" as const };
    },
    async listModels(search: string, signal?: AbortSignal) {
      const models = await authorized(signal, (secret, request) => options.service.listModels(secret, mode, request));
      const wanted = search.trim().toLowerCase();
      const exact = models.find((model) => model.id.toLowerCase() === wanted);
      return (exact ? [exact] : models.filter((model) => !wanted || `${model.id} ${model.name}`.toLowerCase().includes(wanted))).map(modelInfo);
    },
    dispatchFields(request: Parameters<ModelRuntime["dispatchFields"]>[0]) {
      assertRoute(request.route);
      return { backendId: "nano-gpt" as const, model: binding.canonicalModelId };
    },
    onConnectionEvent() { return () => {}; },
    safeMessage: safeFailureMessage,
  });
}
