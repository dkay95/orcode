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
  RETRY_POLICY,
  SDK_RECONNECT_POLICY,
  SdkReconnectMonitor,
  abortError,
  fetchWithReconnect,
  retryAfterMs,
  type ConnectionEvent,
  type ConnectionEventListener,
  type ConnectionScope,
  type FetchLike,
  type RetryClock,
} from "./reconnect.js";
import { errorMessage, isRecord } from "./utils.js";

const API_BASE = "https://openrouter.ai/api/v1";
const APP_TITLE = "orcode";
const MODEL_CACHE_TTL_MS = 5 * 60_000;

export type KeyOrigin = "none" | "environment" | "keychain" | "interactive";

/** Injection points for tests and for future runtime tuning. */
export interface OpenRouterRuntime {
  clock?: RetryClock;
  fetchImpl?: FetchLike;
  now?: () => number;
  modelCacheTtlMs?: number;
}

// --------------------------------------------------------------------------
// Error translation
// --------------------------------------------------------------------------

export type FailureKind =
  | "auth"
  | "credits"
  | "permission"
  | "not-found"
  | "invalid-request"
  | "rate-limit"
  | "provider"
  | "timeout"
  | "network"
  | "cancelled"
  | "unknown";

export interface OpenRouterFailure {
  kind: FailureKind;
  status?: number;
  retryAfterMs?: number;
  /** What happened, in plain German. */
  message: string;
  /** What the user can do about it, in plain German. */
  action: string;
  /** Original technical text, with every known key redacted. */
  detail: string;
}

/** Base class for failures that already carry a translated description. */
export class OpenRouterRequestError extends Error {
  readonly failure: OpenRouterFailure;

  constructor(failure: OpenRouterFailure) {
    super(formatFailure(failure));
    this.name = "OpenRouterRequestError";
    this.failure = failure;
  }
}

export class OpenRouterHttpError extends OpenRouterRequestError {
  readonly status: number;
  /** Raw server text without the translation. */
  readonly detail: string;

  constructor(
    status: number,
    detail: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(
      failureFromStatus(
        status,
        `OpenRouter HTTP ${status}: ${detail}`,
        options.retryAfterMs,
      ),
    );
    this.name = "OpenRouterHttpError";
    this.status = status;
    this.detail = detail;
  }

  get retryAfterMs(): number | undefined {
    return this.failure.retryAfterMs;
  }
}

export function describeOpenRouterFailure(
  error: unknown,
  secrets: readonly (string | null | undefined)[] = [],
): OpenRouterFailure {
  if (error instanceof OpenRouterRequestError) {
    return {
      ...error.failure,
      detail: redactAll(error.failure.detail, secrets),
    };
  }
  const detail = redactAll(errorMessage(error), secrets);
  const status = statusOf(error);
  if (status !== undefined) {
    return failureFromStatus(status, detail, retryAfterOf(error));
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "RequestAbortedError") {
    return {
      kind: "cancelled",
      message: detail,
      action: "",
      detail,
    };
  }
  const code = errorCodeOf(error);
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return {
      kind: "timeout",
      message: "OpenRouter hat nicht rechtzeitig geantwortet (Zeitüberschreitung).",
      action:
        "Prüfe die Verbindung und versuche es erneut; bei großen Anfragen hilft ein kleinerer Kontext oder ein anderes Modell.",
      detail,
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      kind: "network",
      message: "openrouter.ai konnte nicht aufgelöst werden (DNS-Fehler).",
      action:
        "Prüfe Internetverbindung, VPN und DNS-Einstellungen und versuche es danach erneut.",
      detail,
    };
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    /fetch failed|network|socket/i.test(detail)
  ) {
    return {
      kind: "network",
      message: "Die Verbindung zu OpenRouter ist fehlgeschlagen.",
      action:
        "Prüfe Internetverbindung, Proxy und Firewall und versuche es danach erneut.",
      detail,
    };
  }
  if (code?.startsWith("CERT_") || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return {
      kind: "network",
      message: "Die TLS-Verbindung zu OpenRouter wurde nicht akzeptiert.",
      action:
        "Prüfe Systemzeit, Zertifikatsspeicher und einen eventuellen TLS-Proxy.",
      detail,
    };
  }
  return {
    kind: "unknown",
    message: detail,
    action: "",
    detail,
  };
}

export function formatFailure(failure: OpenRouterFailure): string {
  if (failure.kind === "unknown" || failure.kind === "cancelled") {
    return failure.detail || failure.message;
  }
  const head = failure.action
    ? `${failure.message} ${failure.action}`
    : failure.message;
  if (!failure.detail || failure.detail === failure.message) {
    return head;
  }
  return `${head} · Details: ${failure.detail}`;
}

function failureFromStatus(
  status: number,
  detail: string,
  waitMs?: number,
): OpenRouterFailure {
  if (status === 401) {
    return {
      kind: "auth",
      status,
      message: "OpenRouter hat den API-Key abgelehnt (ungültig oder widerrufen).",
      action:
        "Lege auf openrouter.ai/keys einen gültigen Key an und hinterlege ihn mit /key set.",
      detail,
    };
  }
  if (status === 402) {
    return {
      kind: "credits",
      status,
      message: "Das OpenRouter-Konto hat für diese Anfrage zu wenig Guthaben.",
      action:
        "Lade auf openrouter.ai/credits Guthaben nach oder wechsle mit /model auf ein günstigeres Modell.",
      detail,
    };
  }
  if (status === 403) {
    return {
      kind: "permission",
      status,
      message:
        "OpenRouter hat den Zugriff verweigert (fehlende Berechtigung oder Moderation).",
      action:
        "Prüfe die Rechte des Keys; Kontodaten wie /credits benötigen einen Management-Key (/key management set).",
      detail,
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      status,
      message: "OpenRouter kennt dieses Modell oder diesen Endpunkt nicht.",
      action: "Prüfe die Modell-ID mit /model; abgeschaltete Modelle müssen ersetzt werden.",
      detail,
    };
  }
  if (status === 408 || status === 504) {
    return {
      kind: "timeout",
      status,
      message: "OpenRouter hat nicht rechtzeitig geantwortet (Zeitüberschreitung).",
      action:
        "Versuche es erneut; hält es an, hilft ein kleinerer Kontext oder ein anderes Modell.",
      detail,
    };
  }
  if (status === 429) {
    const wait = waitMs !== undefined ? Math.ceil(waitMs / 1_000) : undefined;
    return {
      kind: "rate-limit",
      status,
      retryAfterMs: waitMs,
      message: "OpenRouter drosselt die Anfragen (Rate-Limit erreicht).",
      action: wait
        ? `Warte etwa ${wait} Sekunde${wait === 1 ? "" : "n"} und versuche es erneut; orcode wiederholt idempotente Anfragen automatisch.`
        : "Warte einen Moment und versuche es erneut; ein anderes Modell oder ein bezahlter Tarif entlastet zusätzlich.",
      detail,
    };
  }
  if (status >= 500) {
    return {
      kind: "provider",
      status,
      message: `Der Anbieter hinter OpenRouter meldet eine Störung (HTTP ${status}).`,
      action:
        "Kurz warten und erneut versuchen; bei anhaltender Störung mit /model einen anderen Anbieter wählen.",
      detail,
    };
  }
  if (status >= 400) {
    return {
      kind: "invalid-request",
      status,
      message: `OpenRouter hat die Anfrage abgelehnt (HTTP ${status}).`,
      action:
        "Prüfe Modell-ID, Reasoning-Einstellung (/think) und Anhänge; die Details unten nennen das beanstandete Feld.",
      detail,
    };
  }
  return {
    kind: "unknown",
    status,
    message: detail,
    action: "",
    detail,
  };
}

function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  for (const key of ["status", "statusCode", "httpStatus"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && value >= 100 && value < 600) {
      return value;
    }
  }
  const response = (error as { response?: unknown }).response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }
  const match = /\bHTTP (\d{3})\b/.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

function retryAfterOf(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const direct = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const response = (error as { response?: unknown }).response;
  return response instanceof Response ? retryAfterMs(response) : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Key capabilities
// --------------------------------------------------------------------------

export type CreditsSource =
  | "management-key"
  | "inference-key"
  | "unknown"
  | "none";

export interface KeyCapabilities {
  /** The key can run models. */
  inference: boolean;
  /** Account credits (/credits) are readable. */
  accountCredits: boolean;
  creditsSource: CreditsSource;
  managementKeySet: boolean;
  inferenceKeyIsManagement?: boolean;
  /** One German sentence stating which key can do what. */
  summary: string;
}

/**
 * `BalanceInfo` plus the structured key capabilities. Optional so that plain
 * `BalanceInfo` values from other modules stay assignable; every value this
 * service returns has it set.
 */
export interface BalanceReport extends BalanceInfo {
  capabilities?: KeyCapabilities;
}

export interface ReconnectReport extends BalanceReport {
  steps: string[];
  message: string;
  clientRebuilt: boolean;
  modelCacheCleared: boolean;
}

export function describeKeyCapabilities(
  key: KeyInfo,
  managementKeySet: boolean,
): KeyCapabilities {
  if (managementKeySet) {
    return {
      inference: true,
      accountCredits: true,
      creditsSource: "management-key",
      managementKeySet,
      inferenceKeyIsManagement: key.isManagementKey,
      summary:
        "Der Management-Key liest das Kontoguthaben, der Inference-Key führt die Modellläufe aus.",
    };
  }
  if (key.isManagementKey === true) {
    return {
      inference: true,
      accountCredits: true,
      creditsSource: "inference-key",
      managementKeySet,
      inferenceKeyIsManagement: true,
      summary:
        "Der gesetzte Key ist zugleich Management-Key: Modellläufe und Kontoguthaben sind damit abgedeckt.",
    };
  }
  if (key.isManagementKey === false) {
    return {
      inference: true,
      accountCredits: false,
      creditsSource: "none",
      managementKeySet,
      inferenceKeyIsManagement: false,
      summary:
        "Der gesetzte Key ist ein reiner Inference-Key: Modellläufe ja, Kontoguthaben nein. Hinterlege mit /key management set einen Management-Key, um das Guthaben zu sehen.",
    };
  }
  return {
    inference: true,
    accountCredits: true,
    creditsSource: "unknown",
    managementKeySet,
    inferenceKeyIsManagement: undefined,
    summary:
      "OpenRouter meldet für diesen Key nicht, ob er Kontodaten lesen darf; die Guthabenabfrage wird versucht.",
  };
}

// --------------------------------------------------------------------------
// Model metadata, search and filtering
// --------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  reasoningMandatory: boolean;
  reasoningBudget: boolean;
  structuredOutputs: boolean;
  imageInput: boolean;
  imageOutput: boolean;
  audioInput: boolean;
  /** Prompt and completion are both free. */
  free: boolean;
  /** Pricing is routed dynamically and therefore unknown up front. */
  variablePricing: boolean;
  contextLength: number;
  maxCompletionTokens: number | null;
  promptPricePerMillion: number;
  completionPricePerMillion: number;
}

export type ModelSort =
  | "price"
  | "context"
  | "name"
  | "newest"
  | "intelligence"
  | "coding"
  | "agentic";

export interface ModelQuery {
  search?: string;
  /** Search description, modality and parameters too, matching every word. */
  deepSearch?: boolean;
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
  imageInput?: boolean;
  imageOutput?: boolean;
  freeOnly?: boolean;
  minContextLength?: number;
  maxPromptPricePerMillion?: number;
  maxCompletionPricePerMillion?: number;
  requiredParameters?: readonly string[];
  sort?: ModelSort;
  limit?: number;
}

export function modelCapabilities(model: ModelInfo): ModelCapabilities {
  const parameters = model.supportedParameters;
  const dynamic = model.id.startsWith("openrouter/");
  const variablePricing = model.promptPrice < 0 || model.completionPrice < 0;
  return {
    tools: parameters.includes("tools"),
    reasoning:
      dynamic || Boolean(model.reasoning) || parameters.includes("reasoning"),
    reasoningMandatory: Boolean(model.reasoning?.mandatory),
    reasoningBudget: dynamic || Boolean(model.reasoning?.supportsMaxTokens),
    structuredOutputs:
      parameters.includes("structured_outputs") ||
      parameters.includes("response_format"),
    imageInput: model.inputModalities.includes("image"),
    imageOutput: model.outputModalities.includes("image"),
    audioInput: model.inputModalities.includes("audio"),
    free: !variablePricing && model.promptPrice === 0 && model.completionPrice === 0,
    variablePricing,
    contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens ?? null,
    promptPricePerMillion: perMillion(model.promptPrice),
    completionPricePerMillion: perMillion(model.completionPrice),
  };
}

export function filterModels(
  models: readonly ModelInfo[],
  query: ModelQuery = {},
): ModelInfo[] {
  const needle = (query.search ?? "").trim().toLowerCase();
  const terms = needle ? needle.split(/\s+/) : [];
  const selected = models.filter((model) => {
    const capabilities = modelCapabilities(model);
    if (query.toolsOnly && !capabilities.tools) return false;
    if (query.reasoningOnly && !capabilities.reasoning) return false;
    if (query.imageInput && !capabilities.imageInput) return false;
    if (query.imageOutput && !capabilities.imageOutput) return false;
    if (query.freeOnly && !capabilities.free) return false;
    if (
      query.minContextLength !== undefined &&
      model.contextLength < query.minContextLength
    ) {
      return false;
    }
    if (
      !withinPrice(capabilities.promptPricePerMillion, capabilities.variablePricing, query.maxPromptPricePerMillion) ||
      !withinPrice(capabilities.completionPricePerMillion, capabilities.variablePricing, query.maxCompletionPricePerMillion)
    ) {
      return false;
    }
    if (
      query.requiredParameters?.some(
        (parameter) => !model.supportedParameters.includes(parameter),
      )
    ) {
      return false;
    }
    if (!needle) {
      return true;
    }
    if (query.deepSearch) {
      const haystack = [
        model.id,
        model.name,
        model.description,
        model.modality ?? "",
        ...model.supportedParameters,
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }
    return `${model.id} ${model.name}`.toLowerCase().includes(needle);
  });
  const sorted = sortModels(selected, query.sort ?? "price");
  return query.limit === undefined ? sorted : sorted.slice(0, query.limit);
}

function sortModels(models: ModelInfo[], sort: ModelSort): ModelInfo[] {
  const byId = (left: ModelInfo, right: ModelInfo) =>
    left.id.localeCompare(right.id);
  const descending = (
    left: number | undefined,
    right: number | undefined,
  ): number => (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY);
  return [...models].sort((left, right) => {
    switch (sort) {
      case "context":
        return right.contextLength - left.contextLength || byId(left, right);
      case "name":
        return left.name.localeCompare(right.name) || byId(left, right);
      case "newest":
        return descending(left.createdAt, right.createdAt) || byId(left, right);
      case "intelligence":
        return (
          descending(left.intelligenceIndex, right.intelligenceIndex) ||
          byId(left, right)
        );
      case "coding":
        return (
          descending(left.codingIndex, right.codingIndex) || byId(left, right)
        );
      case "agentic":
        return (
          descending(left.agenticIndex, right.agenticIndex) || byId(left, right)
        );
      default:
        return (
          sortablePrice(left.promptPrice, left.completionPrice) -
            sortablePrice(right.promptPrice, right.completionPrice) ||
          byId(left, right)
        );
    }
  });
}

function withinPrice(
  pricePerMillion: number,
  variablePricing: boolean,
  maximum?: number,
): boolean {
  if (maximum === undefined) {
    return true;
  }
  return !variablePricing && pricePerMillion <= maximum;
}

function perMillion(perToken: number): number {
  return perToken < 0 ? perToken : perToken * 1_000_000;
}

// --------------------------------------------------------------------------
// Service
// --------------------------------------------------------------------------

export class OpenRouterService {
  #apiKey: string | null;
  #managementKey: string | null;
  #keyOrigin: KeyOrigin;
  #managementKeyOrigin: KeyOrigin;
  readonly #connectionListeners = new Set<ConnectionEventListener>();
  readonly #runtime: OpenRouterRuntime;
  readonly #restMonitor: SdkReconnectMonitor;
  readonly #clients = new Map<string, OpenRouter>();
  #modelCache: { models: ModelInfo[]; fetchedAt: number } | null = null;

  constructor(
    apiKey?: string,
    managementKey?: string,
    origins: {
      inference?: KeyOrigin;
      management?: KeyOrigin;
    } = {},
    runtime: OpenRouterRuntime = {},
  ) {
    this.#apiKey = normalizeKey(apiKey);
    this.#managementKey = normalizeKey(managementKey);
    this.#keyOrigin = this.#apiKey
      ? (origins.inference ?? "environment")
      : "none";
    this.#managementKeyOrigin = this.#managementKey
      ? (origins.management ?? "environment")
      : "none";
    this.#runtime = runtime;
    this.#restMonitor = new SdkReconnectMonitor(
      (event) => this.#emitConnectionEvent(event),
      { scope: "rest" },
    );
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
    this.dropClients();
  }

  forgetKey(): void {
    this.#apiKey = null;
    this.#keyOrigin = "none";
    this.dropClients();
  }

  setManagementKey(apiKey: string, origin: KeyOrigin = "interactive"): void {
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

  /**
   * SDK client for one logical scope. Clients are cached per scope so that the
   * compressor and the main run keep separate reconnect contexts and a fresh
   * client is only built when the key changes or /reconnect asks for it.
   */
  client(options: { scope?: ConnectionScope } = {}): OpenRouter {
    const scope = options.scope;
    const cacheKey = scope ?? "default";
    const cached = this.#clients.get(cacheKey);
    if (cached) {
      return cached;
    }
    const monitor = new SdkReconnectMonitor(
      (event) => this.#emitConnectionEvent(event),
      scope ? { scope } : {},
    );
    const client = new OpenRouter({
      apiKey: this.requireKey(),
      appTitle: APP_TITLE,
      appCategories: "cli-agent,coding-agent",
      retryConfig: SDK_RECONNECT_POLICY,
      timeoutMs: 45_000,
      hooks: [
        {
          beforeRequest: (context, request) => {
            monitor.beforeRequest(context);
            return request;
          },
        },
        {
          afterError: (context, response, error) => {
            monitor.afterError(context, response);
            return { response, error };
          },
        },
        {
          afterSuccess: (context, response) => {
            monitor.afterSuccess(context);
            return response;
          },
        },
      ],
    });
    this.#clients.set(cacheKey, client);
    return client;
  }

  /** Discards every cached SDK client; the next client() builds a fresh one. */
  dropClients(): void {
    this.#clients.clear();
  }

  onConnectionEvent(listener: ConnectionEventListener): () => void {
    this.#connectionListeners.add(listener);
    return () => {
      this.#connectionListeners.delete(listener);
    };
  }

  /**
   * Real reconnect: throw the SDK clients away, rebuild them, re-check the key
   * and drop the cached model list.
   */
  async reconnect(signal?: AbortSignal): Promise<ReconnectReport> {
    const hadClients = this.#clients.size > 0;
    const cachedModels = this.#modelCache?.models.length ?? 0;
    this.dropClients();
    this.invalidateModelCache();

    const balance = await this.checkBalance(signal);
    this.client();

    const steps = [
      hadClients
        ? "Bestehende OpenRouter-Verbindung verworfen und neu aufgebaut."
        : "OpenRouter-Verbindung neu aufgebaut.",
      `Key erneut geprüft: ${balance.key.label ?? "ohne Label"} · ${
        balance.capabilities?.summary ?? "Fähigkeiten unbekannt."
      }`,
      cachedModels
        ? `Modell-Cache geleert (${cachedModels} Einträge).`
        : "Modell-Cache war leer und bleibt leer.",
    ];
    return {
      ...balance,
      steps,
      message: steps.join(" "),
      clientRebuilt: true,
      modelCacheCleared: true,
    };
  }

  async checkBalance(signal?: AbortSignal): Promise<BalanceReport> {
    const key = await this.getCurrentKey(signal);
    const capabilities = describeKeyCapabilities(key, this.hasManagementKey);
    if (!capabilities.accountCredits) {
      return {
        key,
        capabilities,
        creditsUnavailableReason: capabilities.summary,
      };
    }
    const bearer =
      capabilities.creditsSource === "management-key"
        ? (this.#managementKey ?? this.requireKey())
        : this.requireKey();
    try {
      const credits = await this.getCredits(bearer, signal);
      return { key, credits, capabilities };
    } catch (error) {
      if (
        error instanceof OpenRouterHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        const reason = this.#managementKey
          ? "Der gesetzte Management-Key wurde für /credits abgelehnt; das Limit des Inference-Keys wurde trotzdem geprüft."
          : "Der /credits-Endpunkt benötigt einen Management-Key; das Limit des aktuellen Inference-Keys wurde geprüft.";
        return {
          key,
          capabilities: {
            ...capabilities,
            accountCredits: false,
            creditsSource: "none",
            summary: reason,
          },
          creditsUnavailableReason: reason,
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

  /** Full model catalogue, cached for `modelCacheTtlMs`. */
  async loadModels(
    options: { signal?: AbortSignal; refresh?: boolean } = {},
  ): Promise<ModelInfo[]> {
    const cached = this.#modelCache;
    if (
      !options.refresh &&
      cached &&
      this.#now() - cached.fetchedAt < this.#modelCacheTtlMs()
    ) {
      return [...cached.models];
    }
    const response = await this.#send(
      `${API_BASE}/models`,
      { headers: { "X-OpenRouter-Title": APP_TITLE } },
      "models",
      options.signal,
    );
    const text = await response.text();
    if (!response.ok) {
      throw new OpenRouterHttpError(
        response.status,
        `Modellliste konnte nicht geladen werden: ${truncateDetail(text)}`,
        { retryAfterMs: retryAfterMs(response) },
      );
    }
    const payload = requireRecord(parseJson(text), "Ungültige Modell-Antwort");
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models = data
      .map(parseModel)
      .filter((model): model is ModelInfo => Boolean(model));
    this.#modelCache = { models, fetchedAt: this.#now() };
    return [...models];
  }

  /** Filtered view on the cached catalogue. */
  async searchModels(
    query: ModelQuery = {},
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    return filterModels(await this.loadModels({ signal }), query);
  }

  async listModels(
    search = "",
    toolsOnly = true,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    return this.searchModels({ search, toolsOnly, sort: "price" }, signal);
  }

  async findModel(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null> {
    const wanted = modelId.trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    const models = await this.loadModels({ signal });
    return (
      models.find(
        (model) =>
          model.id.toLowerCase() === wanted ||
          model.canonicalSlug?.toLowerCase() === wanted,
      ) ?? null
    );
  }

  invalidateModelCache(): void {
    this.#modelCache = null;
  }

  /** Age of the cached catalogue in milliseconds, or null when empty. */
  modelCacheAgeMs(): number | null {
    return this.#modelCache ? this.#now() - this.#modelCache.fetchedAt : null;
  }

  requireKey(): string {
    if (!this.#apiKey) {
      throw new Error("Kein OpenRouter API-Key gesetzt. Verwende /key set.");
    }
    return this.#apiKey;
  }

  /** Structured, German translation of an OpenRouter or network failure. */
  explain(error: unknown): OpenRouterFailure {
    return describeOpenRouterFailure(error, [this.#apiKey, this.#managementKey]);
  }

  safeMessage(error: unknown): string {
    return formatFailure(this.explain(error));
  }

  async request(
    path: string,
    bearerKey = this.requireKey(),
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.#send(
      `${API_BASE}${path}`,
      {
        headers: {
          Authorization: `Bearer ${bearerKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": APP_TITLE,
        },
      },
      operationFromPath(path),
      signal,
    );

    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      const nested = isRecord(record.error) ? record.error : {};
      const detail =
        stringOf(nested.message) ||
        stringOf(record.message) ||
        truncateDetail(text) ||
        `HTTP ${response.status}`;
      throw new OpenRouterHttpError(response.status, redact(detail, bearerKey), {
        retryAfterMs: retryAfterMs(response),
      });
    }
    return requireRecord(payload, "OpenRouter lieferte keine gültige JSON-Antwort.");
  }

  async #send(
    url: string,
    init: RequestInit,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchWithReconnect(url, init, {
        operation,
        monitor: this.#restMonitor,
        signal,
        timeoutMs: RETRY_POLICY.requestTimeoutMs,
        clock: this.#runtime.clock,
        fetchImpl: this.#runtime.fetchImpl,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      const failure = this.explain(error);
      if (failure.kind === "cancelled") {
        throw error;
      }
      throw new OpenRouterRequestError(failure);
    }
  }

  #emitConnectionEvent(event: ConnectionEvent): void {
    for (const listener of this.#connectionListeners) {
      listener(event);
    }
  }

  #now(): number {
    return this.#runtime.now?.() ?? Date.now();
  }

  #modelCacheTtlMs(): number {
    return this.#runtime.modelCacheTtlMs ?? MODEL_CACHE_TTL_MS;
  }
}

// --------------------------------------------------------------------------
// A3 — Ausfallsicherheit: request fragments and provider-switch notices.
//
// BENÖTIGT IN src/agent.ts: the `callModel`/request-building call site must
// spread `modelsField(this.config.mainModel, this.config.fallbackModels)`
// into the `models` request field (instead of a bare `model: mainModel`),
// and `providerField(this.config.provider)` into the request's `provider`
// field. Neither is wired in from here — agent.ts owns the actual SDK call.
// --------------------------------------------------------------------------

/**
 * `models` request field: primary model first, then the fallback chain in
 * the configured order, de-duplicated so the same slug never appears twice.
 */
export function modelsField(
  mainModel: string,
  fallbackModels: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of [mainModel, ...fallbackModels]) {
    const trimmed = model.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/** OpenRouter `provider` preferences field, straight passthrough. */
export interface ProviderRequestField {
  sort?: string;
  dataCollection?: string;
  only?: string[];
  ignore?: string[];
}

export function providerField(config: {
  sort?: string;
  dataCollection?: string;
  only?: string[];
  ignore?: string[];
}): ProviderRequestField {
  const field: ProviderRequestField = {};
  if (config.sort) {
    field.sort = config.sort;
  }
  if (config.dataCollection) {
    field.dataCollection = config.dataCollection;
  }
  if (config.only && config.only.length > 0) {
    field.only = [...config.only];
  }
  if (config.ignore && config.ignore.length > 0) {
    field.ignore = [...config.ignore];
  }
  return field;
}

/**
 * Pure payload for an `AgentRunEvent` of `type: "notice"` (see `types.ts`),
 * reporting that the provider actually serving the request differs from the
 * one that served the previous response. `null` when there was no switch or
 * either name is unknown.
 *
 * BENÖTIGT IN src/agent.ts: after a model response returns, compare the
 * provider name OpenRouter reports (e.g. `response.provider` /
 * `generation.providerName` from the SDK) against the provider of the
 * previous response in the same run, and — if `providerSwitchNotice`
 * returns non-null — emit it as `{ type: "notice", ...notice, timestamp }`.
 */
export interface ProviderSwitchNotice {
  level: "info";
  code: "provider-switch";
  message: string;
}

export function providerSwitchNotice(
  previousProvider: string | null | undefined,
  currentProvider: string | null | undefined,
): ProviderSwitchNotice | null {
  const previous = previousProvider?.trim() || null;
  const current = currentProvider?.trim() || null;
  if (!previous || !current || previous === current) {
    return null;
  }
  return {
    level: "info",
    code: "provider-switch",
    message: `Anbieter gewechselt: ${previous} → ${current}.`,
  };
}

// --------------------------------------------------------------------------
// A2 — Websuche: prompt-signal detection and the request fragment.
//
// BENÖTIGT IN src/agent.ts: the request-building call site must compute
// `shouldEnableWebSearch(this.config.web, prompt)` and, when true, add
// `webSearchPlugin(this.config.webMaxResults ?? 5)` to the request's
// `plugins` array (exact shape verified against
// `node_modules/@openrouter/agent/node_modules/@openrouter/sdk/esm/models/websearchplugin.d.ts`).
// --------------------------------------------------------------------------

const URL_PATTERN = /\bhttps?:\/\/[^\s)]+/i;
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+)*(?:[-.][a-z0-9]+)*\b/i;
const ERROR_QUOTE_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_.]*(?:Error|Exception)|error TS\d+|E[A-Z]{2,}|HTTP \d{3})\b/;

/**
 * Pure prompt heuristic for `web: "auto"`: on as soon as the prompt contains
 * a URL, a version number, or something that looks like a quoted error
 * (exception class name, `error TS1234`, an `E`-style error code, or an HTTP
 * status mention).
 */
export function detectsWebSearchNeed(prompt: string): boolean {
  return (
    URL_PATTERN.test(prompt) ||
    VERSION_PATTERN.test(prompt) ||
    ERROR_QUOTE_PATTERN.test(prompt)
  );
}

export function shouldEnableWebSearch(
  mode: "on" | "off" | "auto",
  prompt: string,
): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "on") {
    return true;
  }
  return detectsWebSearchNeed(prompt);
}

/** `plugins` request fragment for the `web` OpenRouter plugin. */
export interface WebSearchPluginField {
  id: "web";
  maxResults: number;
}

export function webSearchPlugin(maxResults = 5): WebSearchPluginField {
  return { id: "web", maxResults };
}

function operationFromPath(path: string): string {
  return path.replace(/^\/+/, "") || "OpenRouter";
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function truncateDetail(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
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

function redactAll(
  value: string,
  secrets: readonly (string | null | undefined)[],
): string {
  return secrets.reduce<string>(
    (current, secret) => redact(current, secret ?? null),
    value,
  );
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
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
