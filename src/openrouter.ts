import { OpenRouter } from "@openrouter/agent";
import {
  REASONING_EFFORTS,
  type BalanceInfo,
  type CreditInfo,
  type KeyInfo,
  type ModelInfo,
  type ReasoningEffort,
} from "./types.js";
import {
  SDK_RECONNECT_POLICY,
  SdkReconnectMonitor,
  isTransientStatus,
  type ConnectionEvent,
  type ConnectionEventListener,
} from "./reconnect.js";

const API_BASE = "https://openrouter.ai/api/v1";
const APP_TITLE = "RouterCode";

export type KeyOrigin = "none" | "environment" | "keychain" | "interactive";

export class OpenRouterService {
  #apiKey: string | null;
  #managementKey: string | null;
  #keyOrigin: KeyOrigin;
  #managementKeyOrigin: KeyOrigin;
  readonly #connectionListeners = new Set<ConnectionEventListener>();

  constructor(
    apiKey?: string,
    managementKey?: string,
    origins: {
      inference?: KeyOrigin;
      management?: KeyOrigin;
    } = {},
  ) {
    this.#apiKey = normalizeKey(apiKey);
    this.#managementKey = normalizeKey(managementKey);
    this.#keyOrigin = this.#apiKey
      ? (origins.inference ?? "environment")
      : "none";
    this.#managementKeyOrigin = this.#managementKey
      ? (origins.management ?? "environment")
      : "none";
  }

  get hasKey(): boolean {
    return Boolean(this.#apiKey);
  }

  get hasManagementKey(): boolean {
    return Boolean(this.#managementKey);
  }

  get keyOrigin(): KeyOrigin {
    return this.#keyOrigin;
  }

  get managementKeyOrigin(): KeyOrigin {
    return this.#managementKeyOrigin;
  }

  setKey(apiKey: string, origin: KeyOrigin = "interactive"): void {
    const normalized = normalizeKey(apiKey);
    if (!normalized || normalized.length < 20 || /\s/.test(normalized)) {
      throw new Error("Der OpenRouter API-Key sieht ungültig aus.");
    }
    this.#apiKey = normalized;
    this.#keyOrigin = origin;
  }

  forgetKey(): void {
    this.#apiKey = null;
    this.#keyOrigin = "none";
  }

  setManagementKey(
    apiKey: string,
    origin: KeyOrigin = "interactive",
  ): void {
    const normalized = normalizeKey(apiKey);
    if (!normalized || normalized.length < 20 || /\s/.test(normalized)) {
      throw new Error("Der OpenRouter Management-Key sieht ungültig aus.");
    }
    this.#managementKey = normalized;
    this.#managementKeyOrigin = origin;
  }

  forgetManagementKey(): void {
    this.#managementKey = null;
    this.#managementKeyOrigin = "none";
  }

  client(): OpenRouter {
    const monitor = new SdkReconnectMonitor((event) => {
      this.#emitConnectionEvent(event);
    });
    return new OpenRouter({
      apiKey: this.requireKey(),
      appTitle: APP_TITLE,
      appCategories: "cli-agent,coding-agent",
      retryConfig: SDK_RECONNECT_POLICY,
      timeoutMs: 45_000,
      hooks: [
        {
          beforeRequest: (context, request) => {
            monitor.beforeRequest(context.operationID);
            return request;
          },
        },
        {
          afterError: (context, response, error) => {
            monitor.afterError(context.operationID, response);
            return { response, error };
          },
        },
        {
          afterSuccess: (context, response) => {
            monitor.afterSuccess(context.operationID);
            return response;
          },
        },
      ],
    });
  }

  onConnectionEvent(listener: ConnectionEventListener): () => void {
    this.#connectionListeners.add(listener);
    return () => {
      this.#connectionListeners.delete(listener);
    };
  }

  async reconnect(signal?: AbortSignal): Promise<BalanceInfo> {
    return this.checkBalance(signal);
  }

  async checkBalance(signal?: AbortSignal): Promise<BalanceInfo> {
    const key = await this.getCurrentKey(signal);
    try {
      const credits = await this.getCredits(
        this.#managementKey ?? this.requireKey(),
        signal,
      );
      return {
        key,
        credits,
      };
    } catch (error) {
      if (
        error instanceof OpenRouterHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        return {
          key,
          creditsUnavailableReason: this.#managementKey
            ? `Der gesetzte Management-Key wurde für /credits abgelehnt; das Limit des Inference-Keys wurde trotzdem geprüft.`
            : "Der /credits-Endpunkt benötigt einen Management-Key; das Limit des aktuellen Inference-Keys wurde geprüft.",
        };
      }
      throw error;
    }
  }

  async validateManagementKey(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<CreditInfo> {
    const normalized = normalizeKey(apiKey);
    if (!normalized || normalized.length < 20 || /\s/.test(normalized)) {
      throw new Error("Der OpenRouter Management-Key sieht ungültig aus.");
    }
    return this.getCredits(normalized, signal);
  }

  async getCredits(
    bearerKey: string,
    signal?: AbortSignal,
  ): Promise<CreditInfo> {
    const payload = await this.request("/credits", bearerKey, signal);
    const data = requireRecord(payload.data, "Ungültige Guthaben-Antwort");
    const totalCredits = numberOf(data.total_credits);
    const totalUsage = numberOf(data.total_usage);
    return {
      totalCredits,
      totalUsage,
      remaining: Math.max(0, totalCredits - totalUsage),
    };
  }

  async getCurrentKey(signal?: AbortSignal): Promise<KeyInfo> {
    const payload = await this.request("/key", this.requireKey(), signal);
    const data = requireRecord(payload.data, "Ungültige Key-Antwort");
    return {
      label: stringOf(data.label),
      isFreeTier: booleanOf(data.is_free_tier),
      isManagementKey: booleanOf(data.is_management_key),
      limit: nullableNumberOf(data.limit),
      limitRemaining: nullableNumberOf(data.limit_remaining),
      usage: numberOf(data.usage),
      usageDaily: numberOf(data.usage_daily),
      usageWeekly: numberOf(data.usage_weekly),
      usageMonthly: numberOf(data.usage_monthly),
      expiresAt: nullableStringOf(data.expires_at),
    };
  }

  async listModels(
    search = "",
    toolsOnly = true,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    const response = await this.#fetchWithReconnect(`${API_BASE}/models`, {
      headers: {
        "X-OpenRouter-Title": APP_TITLE,
      },
    }, "models", signal);
    if (!response.ok) {
      throw new Error(`Modellliste konnte nicht geladen werden (HTTP ${response.status}).`);
    }
    const payload = requireRecord(await response.json(), "Ungültige Modell-Antwort");
    const data = Array.isArray(payload.data) ? payload.data : [];
    const needle = search.trim().toLowerCase();

    return data
      .map(parseModel)
      .filter((model): model is ModelInfo => Boolean(model))
      .filter((model) => !toolsOnly || model.supportedParameters.includes("tools"))
      .filter((model) => !needle || `${model.id} ${model.name}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftPrice = sortablePrice(left.promptPrice, left.completionPrice);
        const rightPrice = sortablePrice(right.promptPrice, right.completionPrice);
        return leftPrice - rightPrice || left.id.localeCompare(right.id);
      });
  }

  requireKey(): string {
    if (!this.#apiKey) {
      throw new Error("Kein OpenRouter API-Key gesetzt. Verwende /key set.");
    }
    return this.#apiKey;
  }

  safeMessage(error: unknown): string {
    return safeError(safeError(error, this.#apiKey), this.#managementKey);
  }

  async #rawRequest(
    path: string,
    bearerKey: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.#fetchWithReconnect(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${bearerKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": APP_TITLE,
      },
    }, operationFromPath(path), signal);
  }

  async #fetchWithReconnect(
    url: string,
    init: RequestInit,
    operation: string,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const maximumAttempts = 3;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (attempt > 1) {
        this.#emitConnectionEvent({
          phase: "retrying",
          operation,
          attempt,
          status: lastStatus,
          reason: lastStatus
            ? `OpenRouter HTTP ${lastStatus}`
            : "Verbindung unterbrochen oder Zeitüberschreitung",
        });
      }

      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: requestSignal(externalSignal),
        });
      } catch (error) {
        if (externalSignal?.aborted) {
          throw abortReason(externalSignal);
        }
        if (attempt >= maximumAttempts) {
          throw error;
        }
        this.#emitConnectionEvent({
          phase: "retry-scheduled",
          operation,
          attempt,
          reason: "Verbindung unterbrochen oder Zeitüberschreitung",
        });
        await reconnectDelay(attempt, undefined, externalSignal);
        continue;
      }

      lastStatus = response.status;
      if (
        !isTransientStatus(response.status) ||
        attempt >= maximumAttempts
      ) {
        if (attempt > 1 && response.ok) {
          this.#emitConnectionEvent({
            phase: "restored",
            operation,
            attempt,
            status: lastStatus,
          });
        }
        return response;
      }

      this.#emitConnectionEvent({
        phase: "retry-scheduled",
        operation,
        attempt,
        status: response.status,
        reason: `OpenRouter HTTP ${response.status}`,
      });
      await reconnectDelay(attempt, response, externalSignal);
    }

    throw new Error("OpenRouter-Reconnect wurde unerwartet beendet.");
  }

  #emitConnectionEvent(event: ConnectionEvent): void {
    for (const listener of this.#connectionListeners) {
      listener(event);
    }
  }

  async request(
    path: string,
    bearerKey = this.requireKey(),
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#rawRequest(path, bearerKey, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      throw new Error(`OpenRouter ist nicht erreichbar: ${safeError(error, bearerKey)}`);
    }

    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      const nested = isRecord(record.error) ? record.error : {};
      const detail = stringOf(nested.message) || stringOf(record.message) || `HTTP ${response.status}`;
      throw new OpenRouterHttpError(response.status, redact(detail, bearerKey));
    }
    return requireRecord(payload, "OpenRouter lieferte keine gültige JSON-Antwort.");
  }
}

function requestSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

async function reconnectDelay(
  attempt: number,
  response?: Response,
  signal?: AbortSignal,
): Promise<void> {
  const retryAfter = retryAfterMs(response);
  const delayMs = Math.min(
    retryAfter ?? 250 * 2 ** Math.max(0, attempt - 1),
    5_000,
  );
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal ? abortReason(signal) : new Error("Reconnect abgebrochen."));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryAfterMs(response?: Response): number | undefined {
  if (!response) {
    return undefined;
  }
  const rawMilliseconds = response.headers.get("retry-after-ms");
  if (rawMilliseconds !== null) {
    const milliseconds = Number(rawMilliseconds);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return milliseconds;
    }
  }
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function operationFromPath(path: string): string {
  return path.replace(/^\/+/, "") || "OpenRouter";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Der aktuelle Lauf wurde abgebrochen.");
}

export class OpenRouterHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`OpenRouter HTTP ${status}: ${message}`);
  }
}

function parseModel(value: unknown): ModelInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const pricing = isRecord(value.pricing) ? value.pricing : {};
  const architecture = isRecord(value.architecture) ? value.architecture : {};
  const topProvider = isRecord(value.top_provider) ? value.top_provider : {};
  const reasoning = isRecord(value.reasoning) ? value.reasoning : null;
  const benchmarks = isRecord(value.benchmarks) ? value.benchmarks : {};
  const artificialAnalysis = isRecord(benchmarks.artificial_analysis)
    ? benchmarks.artificial_analysis
    : {};
  return {
    id: value.id,
    canonicalSlug: stringOf(value.canonical_slug),
    name: typeof value.name === "string" ? value.name : value.id,
    description: stringOf(value.description) ?? "",
    createdAt: optionalNumberOf(value.created),
    contextLength: numberOf(value.context_length),
    maxCompletionTokens: nullableNumberOf(topProvider.max_completion_tokens),
    promptPrice: numberOf(pricing.prompt),
    completionPrice: numberOf(pricing.completion),
    supportedParameters: Array.isArray(value.supported_parameters)
      ? value.supported_parameters.filter((item): item is string => typeof item === "string")
      : [],
    modality: stringOf(architecture.modality),
    inputModalities: stringArrayOf(architecture.input_modalities),
    outputModalities: stringArrayOf(architecture.output_modalities),
    tokenizer: stringOf(architecture.tokenizer),
    isModerated: booleanOf(topProvider.is_moderated),
    reasoning: reasoning
      ? {
          defaultEffort: reasoningEffortOf(reasoning.default_effort),
          defaultEnabled: booleanOf(reasoning.default_enabled),
          mandatory: Boolean(reasoning.mandatory),
          supportedEfforts: Array.isArray(reasoning.supported_efforts)
            ? reasoning.supported_efforts
                .map(reasoningEffortOf)
                .filter((effort): effort is ReasoningEffort => Boolean(effort))
            : null,
          supportsMaxTokens: Boolean(reasoning.supports_max_tokens),
        }
      : undefined,
    intelligenceIndex: optionalNumberOf(artificialAnalysis.intelligence_index),
    codingIndex: optionalNumberOf(artificialAnalysis.coding_index),
    agenticIndex: optionalNumberOf(artificialAnalysis.agentic_index),
  };
}

function normalizeKey(value?: string): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function reasoningEffortOf(value: unknown): ReasoningEffort | null {
  return typeof value === "string" &&
    REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : null;
}

function redact(value: string, secret: string | null): string {
  if (!secret) {
    return value;
  }
  return value.split(secret).join("[REDACTED]");
}

function safeError(error: unknown, secret: string | null): string {
  return redact(error instanceof Error ? error.message : String(error), secret);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableStringOf(value: unknown): string | null | undefined {
  return value === null ? null : stringOf(value);
}

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumberOf(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

function optionalNumberOf(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = numberOf(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sortablePrice(prompt: number, completion: number): number {
  return prompt < 0 || completion < 0
    ? Number.POSITIVE_INFINITY
    : prompt + completion;
}
