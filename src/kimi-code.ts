import { createHmac } from "node:crypto";
import { normalizeProviderSecret } from "./credentials.js";

export const KIMI_CODE_API_BASE = "https://api.kimi.com/coding/v1" as const;
export const KIMI_CODE_MODELS_ENDPOINT = `${KIMI_CODE_API_BASE}/models` as const;
export const KIMI_CODE_USER_AGENT = "orcode/0.4.1" as const;
export const KIMI_CODE_MAX_METADATA_BODY_BYTES = 64 * 1024;
const KIMI_CODE_MAX_CATALOG_ITEMS = 64;

export type KimiCodeModelId =
  | "k3"
  | "k3-256k"
  | "kimi-for-coding"
  | "kimi-for-coding-highspeed";

export interface KimiCodeModelDefinition {
  readonly id: KimiCodeModelId;
  readonly displayName: string;
  readonly advertisedMaxContext: number;
  readonly effectiveContextDefault: number;
  readonly reasoningEfforts: readonly ["low", "high", "max"] | null;
  readonly thinkingRequired: true;
}

const K3_REASONING_EFFORTS = Object.freeze(["low", "high", "max"] as const);

export const KIMI_CODE_MODELS: readonly KimiCodeModelDefinition[] = Object.freeze([
  Object.freeze({
    id: "k3",
    displayName: "Kimi K3",
    advertisedMaxContext: 1_048_576,
    effectiveContextDefault: 262_144,
    reasoningEfforts: K3_REASONING_EFFORTS,
    thinkingRequired: true,
  }),
  Object.freeze({
    id: "k3-256k",
    displayName: "Kimi K3 256K",
    advertisedMaxContext: 262_144,
    effectiveContextDefault: 262_144,
    reasoningEfforts: K3_REASONING_EFFORTS,
    thinkingRequired: true,
  }),
  Object.freeze({
    id: "kimi-for-coding",
    displayName: "Kimi K2.7 Code",
    advertisedMaxContext: 262_144,
    effectiveContextDefault: 262_144,
    reasoningEfforts: null,
    thinkingRequired: true,
  }),
  Object.freeze({
    id: "kimi-for-coding-highspeed",
    displayName: "Kimi K2.7 Code HighSpeed",
    advertisedMaxContext: 262_144,
    effectiveContextDefault: 262_144,
    reasoningEfforts: null,
    thinkingRequired: true,
  }),
]);

const KIMI_MODEL_BY_ID = new Map(
  KIMI_CODE_MODELS.map((model) => [model.id, model] as const),
);

export type KimiCodeFailureCode =
  | "kimi-code-auth-rejected"
  | "kimi-code-model-unavailable"
  | "kimi-code-membership-unavailable"
  | "kimi-code-access-terminated"
  | "kimi-code-limit-reached"
  | "kimi-code-overloaded"
  | "kimi-code-offline"
  | "kimi-code-invalid-response"
  | "kimi-code-cancelled";

export interface KimiCodeFailure {
  readonly code: KimiCodeFailureCode;
  readonly retryable: boolean;
  readonly credential: "valid" | "rejected" | "unknown";
  readonly connectivity: "connected" | "offline" | "unknown";
  readonly spend: "limit-reached" | "unknown";
  readonly unavailableModelId?: KimiCodeModelId;
}

const INVALID_RESPONSE_FAILURE = Object.freeze({
  code: "kimi-code-invalid-response" as const,
  retryable: false,
  credential: "unknown" as const,
  connectivity: "unknown" as const,
  spend: "unknown" as const,
});

const OFFLINE_FAILURE = Object.freeze({
  code: "kimi-code-offline" as const,
  retryable: true,
  credential: "unknown" as const,
  connectivity: "offline" as const,
  spend: "unknown" as const,
});

const CANCELLED_FAILURE = Object.freeze({
  code: "kimi-code-cancelled" as const,
  retryable: false,
  credential: "unknown" as const,
  connectivity: "unknown" as const,
  spend: "unknown" as const,
});

const FAILURE_MESSAGES: Readonly<Record<KimiCodeFailureCode, string>> = Object.freeze({
  "kimi-code-auth-rejected": "Kimi Code hat den Mitgliedschaftsschlüssel abgelehnt.",
  "kimi-code-model-unavailable": "Dieses Kimi-Code-Modell ist für die Mitgliedschaft nicht verfügbar.",
  "kimi-code-membership-unavailable": "Kimi Code kann die Mitgliedschaft derzeit nicht bestätigen.",
  "kimi-code-access-terminated": "Der Kimi-Code-Zugang wurde beendet.",
  "kimi-code-limit-reached": "Das Kimi-Code-Nutzungslimit ist erreicht.",
  "kimi-code-overloaded": "Kimi Code ist derzeit ausgelastet.",
  "kimi-code-offline": "Kimi Code ist derzeit nicht erreichbar.",
  "kimi-code-invalid-response": "Kimi Code hat eine nicht unterstützte Antwort geliefert.",
  "kimi-code-cancelled": "Die Kimi-Code-Anfrage wurde abgebrochen.",
});

export class KimiCodeRequestError extends Error {
  readonly failure: KimiCodeFailure;

  constructor(failure: KimiCodeFailure) {
    const safeFailure = normalizeKimiCodeFailure(failure) ?? INVALID_RESPONSE_FAILURE;
    super(FAILURE_MESSAGES[safeFailure.code]);
    this.name = "KimiCodeRequestError";
    this.failure = safeFailure;
    Object.defineProperty(this, "failure", {
      value: safeFailure,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
}

const ISSUED_KIMI_CODE_ERRORS = new WeakSet<KimiCodeRequestError>();

function requestError(failure: KimiCodeFailure): KimiCodeRequestError {
  const error = new KimiCodeRequestError(failure);
  ISSUED_KIMI_CODE_ERRORS.add(error);
  return error;
}

/** Internal cross-module boundary: dependency-created lookalikes are untrusted. */
export function issuedKimiCodeFailure(error: unknown): KimiCodeFailure | null {
  return error instanceof KimiCodeRequestError && ISSUED_KIMI_CODE_ERRORS.has(error)
    ? error.failure
    : null;
}

export function describeKimiCodeFailure(error: unknown): KimiCodeFailure {
  if (error instanceof KimiCodeRequestError) return error.failure;
  if (error instanceof Error && (
    error.name === "AbortError"
    || error.name === "RequestAbortedError"
  )) {
    return CANCELLED_FAILURE;
  }
  return OFFLINE_FAILURE;
}

function normalizeKimiCodeFailure(value: unknown): KimiCodeFailure | null {
  if (!isRecord(value)) return null;
  const hasUnavailableModel = Object.prototype.hasOwnProperty.call(
    value,
    "unavailableModelId",
  );
  if (!hasExactKeys(
    value,
    hasUnavailableModel
      ? ["code", "retryable", "credential", "connectivity", "spend", "unavailableModelId"]
      : ["code", "retryable", "credential", "connectivity", "spend"],
  )) return null;
  const unavailableModelId = hasUnavailableModel
    && typeof value.unavailableModelId === "string"
    && KIMI_MODEL_BY_ID.has(value.unavailableModelId as KimiCodeModelId)
    ? value.unavailableModelId as KimiCodeModelId
    : null;
  if (hasUnavailableModel && unavailableModelId === null) return null;

  const exact = (
    retryable: boolean,
    credential: KimiCodeFailure["credential"],
    connectivity: KimiCodeFailure["connectivity"],
    spend: KimiCodeFailure["spend"],
    allowUnavailableModel = false,
  ): boolean => value.retryable === retryable
    && value.credential === credential
    && value.connectivity === connectivity
    && value.spend === spend
    && (allowUnavailableModel || !hasUnavailableModel);

  switch (value.code) {
    case "kimi-code-auth-rejected":
      if (!exact(false, "rejected", "connected", "unknown")) return null;
      break;
    case "kimi-code-model-unavailable":
      if (!exact(false, "valid", "connected", "unknown", true)) return null;
      break;
    case "kimi-code-membership-unavailable":
      if (!exact(true, "valid", "connected", "unknown")) return null;
      break;
    case "kimi-code-access-terminated":
      if (!exact(false, "valid", "connected", "unknown")) return null;
      break;
    case "kimi-code-limit-reached":
      if (!exact(true, "valid", "connected", "limit-reached")) return null;
      break;
    case "kimi-code-overloaded":
      if (!exact(true, "valid", "connected", "unknown")) return null;
      break;
    case "kimi-code-offline":
      if (!exact(true, "unknown", "offline", "unknown")) return null;
      break;
    case "kimi-code-invalid-response":
      if (!exact(false, "unknown", "unknown", "unknown")) return null;
      break;
    case "kimi-code-cancelled":
      if (!exact(false, "unknown", "unknown", "unknown")) return null;
      break;
    default:
      return null;
  }
  return Object.freeze({
    code: value.code,
    retryable: value.retryable,
    credential: value.credential,
    connectivity: value.connectivity,
    spend: value.spend,
    ...(unavailableModelId === null ? {} : { unavailableModelId }),
  }) as KimiCodeFailure;
}

export function kimiCodeAccountFingerprint(
  localIdentityKey: Uint8Array,
  normalizedKey: string,
): string {
  if (
    localIdentityKey.byteLength !== 32
    || normalizedKey.length === 0
    || normalizedKey !== normalizeProviderSecret(normalizedKey)
  ) {
    throw new Error("Kimi Code account identity cannot be fingerprinted safely.");
  }
  const digest = createHmac("sha256", localIdentityKey)
    .update("orcode-kimi-code-credential/v1\0", "utf8")
    .update(normalizedKey, "utf8")
    .digest("base64url");
  return `acct_kimi_${digest}`;
}

export type KimiCodeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface KimiCodeServiceOptions {
  fetchImpl?: KimiCodeFetch;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

export interface KimiCodeMetadataRequest {
  signal: AbortSignal;
  deadlineAt: number;
}

const DEADLINE_ABORT = Object.freeze({ code: "kimi-code-internal-deadline" });

export class KimiCodeService {
  readonly #fetchImpl: KimiCodeFetch;
  readonly #now: () => number;
  readonly #scheduleTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly #cancelTimeout: (handle: unknown) => void;

  constructor(options: KimiCodeServiceOptions = {}) {
    this.#fetchImpl = options.fetchImpl
      ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#scheduleTimeout = options.scheduleTimeout
      ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#cancelTimeout = options.cancelTimeout
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async inspectModels(
    rawKey: string,
    request: KimiCodeMetadataRequest,
  ): Promise<readonly KimiCodeModelDefinition[]> {
    let key: string;
    try {
      key = normalizeProviderSecret(rawKey);
      assertNotKnownOpenRouterKey(key);
    } catch {
      throw requestError(INVALID_RESPONSE_FAILURE);
    }
    if (request.signal.aborted) {
      throw requestError(CANCELLED_FAILURE);
    }
    const now = this.#readNow();
    if (
      !Number.isFinite(request.deadlineAt)
      || request.deadlineAt <= now
    ) {
      throw requestError(OFFLINE_FAILURE);
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", relayAbort, { once: true });
    if (request.signal.aborted) relayAbort();
    let timer: unknown;
    try {
      timer = this.#scheduleTimeout(
        () => controller.abort(DEADLINE_ABORT),
        request.deadlineAt - now,
      );
    } catch {
      request.signal.removeEventListener("abort", relayAbort);
      key = "";
      throw requestError(OFFLINE_FAILURE);
    }

    try {
      let response: Response;
      try {
        response = await abortable(
          Promise.resolve().then(() => this.#fetchImpl(KIMI_CODE_MODELS_ENDPOINT, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${key}`,
              "User-Agent": KIMI_CODE_USER_AGENT,
              Accept: "application/json",
            },
            redirect: "error",
            signal: controller.signal,
          })),
          controller.signal,
        );
      } catch {
        if (request.signal.aborted) throw requestError(CANCELLED_FAILURE);
        throw requestError(OFFLINE_FAILURE);
      }
      this.#assertRequestCurrent(request, controller.signal);

      if (response.status === 408 || response.status >= 500) {
        await consumeBoundedResponseBody(response, controller.signal);
        this.#assertRequestCurrent(request, controller.signal);
        throw requestError(OFFLINE_FAILURE);
      }
      if (response.status !== 200) {
        const body = await readBoundedJson(response, controller.signal);
        this.#assertRequestCurrent(request, controller.signal);
        const failure = classifyHttpFailure(response.status, body);
        throw requestError(failure);
      }
      const body = await readBoundedJson(response, controller.signal);
      const models = parseCatalog(body);
      this.#assertRequestCurrent(request, controller.signal);
      return models;
    } catch (error) {
      if (request.signal.aborted) {
        throw requestError(CANCELLED_FAILURE);
      }
      if (controller.signal.reason === DEADLINE_ABORT) {
        throw requestError(OFFLINE_FAILURE);
      }
      try {
        if (request.deadlineAt <= this.#readNow()) throw requestError(OFFLINE_FAILURE);
      } catch (deadlineError) {
        if (
          deadlineError instanceof KimiCodeRequestError
          && ISSUED_KIMI_CODE_ERRORS.has(deadlineError)
        ) throw deadlineError;
        throw requestError(OFFLINE_FAILURE);
      }
      if (error instanceof KimiCodeRequestError && ISSUED_KIMI_CODE_ERRORS.has(error)) {
        throw requestError(error.failure);
      }
      throw requestError(OFFLINE_FAILURE);
    } finally {
      try {
        this.#cancelTimeout(timer);
      } catch {
        // Timer teardown is a private dependency seam and cannot replace the
        // already-classified provider outcome or expose dependency details.
      }
      request.signal.removeEventListener("abort", relayAbort);
      key = "";
    }
  }

  #assertRequestCurrent(
    request: KimiCodeMetadataRequest,
    operationSignal: AbortSignal,
  ): void {
    if (request.signal.aborted) {
      throw requestError(CANCELLED_FAILURE);
    }
    if (operationSignal.reason === DEADLINE_ABORT || request.deadlineAt <= this.#readNow()) {
      throw requestError(OFFLINE_FAILURE);
    }
    if (operationSignal.aborted) {
      throw requestError(OFFLINE_FAILURE);
    }
  }

  #readNow(): number {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw requestError(OFFLINE_FAILURE);
    }
    if (!Number.isFinite(now)) throw requestError(OFFLINE_FAILURE);
    return now;
  }
}

function assertNotKnownOpenRouterKey(key: string): void {
  if (/^sk-or(?:-v1)?-/u.test(key)) {
    throw new Error("Provider credential belongs to another backend.");
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!isStrictJsonContentType(response.headers.get("content-type"))) {
    await discardResponse(response, signal);
    throw requestError(INVALID_RESPONSE_FAILURE);
  }
  if (hasInvalidDeclaredBodySize(response)) {
    await discardResponse(response, signal);
    throw requestError(INVALID_RESPONSE_FAILURE);
  }
  if (!response.body) throw requestError(INVALID_RESPONSE_FAILURE);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > KIMI_CODE_MAX_METADATA_BODY_BYTES) {
        throw requestError(INVALID_RESPONSE_FAILURE);
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    throw requestError(INVALID_RESPONSE_FAILURE);
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw requestError(INVALID_RESPONSE_FAILURE);
  }
}

async function consumeBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  if (hasInvalidDeclaredBodySize(response)) {
    await discardResponse(response, signal);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > KIMI_CODE_MAX_METADATA_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      decoder.decode(result.value, { stream: true });
    }
    decoder.decode();
  } catch {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
  } finally {
    reader.releaseLock();
  }
}

function hasInvalidDeclaredBodySize(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return false;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || contentLength.length > 10) {
    return true;
  }
  const declaredBytes = Number(contentLength);
  return !Number.isSafeInteger(declaredBytes)
    || declaredBytes > KIMI_CODE_MAX_METADATA_BODY_BYTES;
}

function isStrictJsonContentType(value: string | null): boolean {
  return value !== null
    && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value);
}

async function discardResponse(response: Response, signal: AbortSignal): Promise<void> {
  try {
    await abortable(
      Promise.resolve().then(() => response.body?.cancel()),
      signal,
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    // Provider diagnostics are deliberately discarded without surfacing them.
  }
}

function parseCatalog(value: unknown): readonly KimiCodeModelDefinition[] {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["data", "object"])
    || value.object !== "list"
    || !Array.isArray(value.data)
    || value.data.length > KIMI_CODE_MAX_CATALOG_ITEMS
  ) {
    throw requestError(INVALID_RESPONSE_FAILURE);
  }
  const seen = new Set<string>();
  const selected: KimiCodeModelDefinition[] = [];
  for (const entry of value.data) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["created", "id", "object", "owned_by"])
      || typeof entry.id !== "string"
      || entry.id.length === 0
      || entry.id.length > 128
      || /\s|[\0-\x1f\x7f]/u.test(entry.id)
      || entry.object !== "model"
      || !Number.isSafeInteger(entry.created)
      || Number(entry.created) < 0
      || typeof entry.owned_by !== "string"
      || entry.owned_by.length === 0
      || entry.owned_by.length > 128
    ) {
      throw requestError(INVALID_RESPONSE_FAILURE);
    }
    if (seen.has(entry.id)) {
      throw requestError(INVALID_RESPONSE_FAILURE);
    }
    seen.add(entry.id);
    const model = KIMI_MODEL_BY_ID.get(entry.id as KimiCodeModelId);
    if (model) selected.push(model);
  }
  return Object.freeze(selected);
}

interface StructuredProviderError {
  message: string;
}

function parseStructuredProviderError(value: unknown): StructuredProviderError | null {
  if (!isRecord(value) || !hasExactKeys(value, ["error"]) || !isRecord(value.error)) {
    return null;
  }
  const error = value.error;
  if (
    !hasExactKeys(error, ["code", "message", "param", "type"])
    || typeof error.message !== "string"
    || error.message.length === 0
    || error.message.length > 2_048
    || error.code !== null
    || error.type !== null
    || error.param !== null
  ) {
    return null;
  }
  return { message: error.message };
}

function classifyHttpFailure(status: number, value: unknown): KimiCodeFailure {
  const structured = parseStructuredProviderError(value);
  if (!structured) return INVALID_RESPONSE_FAILURE;
  const message = structured.message;

  if (status === 401) {
    if (
      message === "The API Key appears to be invalid or may have expired. Please verify your credentials and try again."
      || message === "Invalid Authentication"
    ) {
      return Object.freeze({
        code: "kimi-code-auth-rejected",
        retryable: false,
        credential: "rejected",
        connectivity: "connected",
        spend: "unknown",
      });
    }
    if (
      message === "Your current plan supports only kimi-k3 up to 256K context. 1M context is available on higher-tier plans. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error"
    ) {
      return Object.freeze({
        code: "kimi-code-model-unavailable",
        retryable: false,
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
      });
    }
    const unavailableModelId = entitlementModelId(message);
    if (unavailableModelId) {
      return Object.freeze({
        code: "kimi-code-model-unavailable",
        retryable: false,
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
        unavailableModelId,
      });
    }
    return INVALID_RESPONSE_FAILURE;
  }

  if (
    status === 402
    && message === "We're unable to verify your membership benefits at this time. Please ensure your membership is active."
  ) {
    return Object.freeze({
      code: "kimi-code-membership-unavailable",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    });
  }

  if (status === 403 && message === "Access terminated.") {
    return Object.freeze({
      code: "kimi-code-access-terminated",
      retryable: false,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    });
  }

  if (
    status === 403
    && message === "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
  ) {
    return limitReachedFailure(true);
  }

  if (status === 429) {
    if (
      message === "The engine is currently overloaded, please try again later"
      || message === "We're receiving too many requests at the moment. Please wait a moment and try again."
    ) {
      return Object.freeze({
        code: "kimi-code-overloaded",
        retryable: true,
        credential: "valid",
        connectivity: "connected",
        spend: "unknown",
      });
    }
    if (
      message === "You've reached your usage limit for this period. Your quota will be refreshed in the next period."
      || message === "You've reached kimi monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
    ) {
      return limitReachedFailure(true);
    }
  }

  return INVALID_RESPONSE_FAILURE;
}

function limitReachedFailure(retryable: boolean): KimiCodeFailure {
  return Object.freeze({
    code: "kimi-code-limit-reached",
    retryable,
    credential: "valid",
    connectivity: "connected",
    spend: "limit-reached",
  });
}

function entitlementModelId(message: string): KimiCodeModelId | null {
  const exact = new Map<string, KimiCodeModelId>([
    [
      "Your current subscription does not have access to k3. Upgrade to an Moderato plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error",
      "k3",
    ],
    [
      "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to an Allegretto plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_highspeed_error",
      "kimi-for-coding-highspeed",
    ],
  ]);
  return exact.get(message) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
