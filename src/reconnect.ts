/**
 * Single source of truth for orcode's reconnect behaviour.
 *
 * The OpenRouter SDK (model streams) and the plain REST calls in
 * `openrouter.ts` both derive their timing from `RETRY_POLICY` and report
 * progress through the same `ConnectionEvent` stream, so the UI never has to
 * merge two different retry notions.
 */

export const RETRY_POLICY = {
  /** Attempts for one logical REST request: one initial call plus two retries. */
  maxAttempts: 3,
  initialDelayMs: 500,
  backoffExponent: 2,
  maxDelayMs: 5_000,
  /** Server supplied Retry-After values are honoured, but never beyond this. */
  retryAfterCapMs: 5_000,
  /** Share of the computed backoff spent as +/- jitter. */
  jitterRatio: 0.25,
  /** Wall clock budget the SDK retry loop may spend on a single request. */
  maxElapsedTimeMs: 30_000,
  /** Per attempt network timeout for REST calls. */
  requestTimeoutMs: 15_000,
} as const;

/** Only these methods are replayed; everything else runs exactly once. */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

export const SDK_RETRY_CODES = ["408", "429", "5XX"] as const;

export const SDK_RECONNECT_POLICY = {
  strategy: "backoff",
  backoff: {
    initialInterval: RETRY_POLICY.initialDelayMs,
    maxInterval: RETRY_POLICY.maxDelayMs,
    exponent: RETRY_POLICY.backoffExponent,
    maxElapsedTime: RETRY_POLICY.maxElapsedTimeMs,
  },
  retryConnectionErrors: true,
} as const;

export const NETWORK_REASON = "Verbindung unterbrochen oder Zeitüberschreitung";

/** Which logical part of the app produced a request. */
export type ConnectionScope = "main" | "compressor" | "voice" | "rest";

export type ConnectionEventPhase =
  | "retry-scheduled"
  | "retrying"
  | "restored";

export interface ConnectionEvent {
  phase: ConnectionEventPhase;
  operation: string;
  attempt: number;
  scope?: ConnectionScope;
  status?: number;
  reason?: string;
  delayMs?: number;
}

export type ConnectionEventListener = (event: ConnectionEvent) => void;

/**
 * One logical request. Structurally compatible with the SDK hook context,
 * which is created once per operation and reused across its retry attempts —
 * the object identity is therefore what separates a retry from a new request.
 */
export interface ConnectionRequestContext {
  readonly operationID: string;
}

interface RequestState {
  attempt: number;
  lastStatus?: number;
  lastReason?: string;
}

export interface RetryClock {
  /** Jitter source; injectable so tests stay deterministic. */
  random?: () => number;
  /** Abortable delay; injectable so tests do not wait for real timers. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ReconnectFetchOptions {
  operation: string;
  monitor: SdkReconnectMonitor;
  signal?: AbortSignal;
  timeoutMs?: number;
  clock?: RetryClock;
  fetchImpl?: FetchLike;
}

/**
 * Tracks reconnect attempts per logical request.
 *
 * Every request gets its own state keyed by context identity, so a finished
 * request — successful or finally failed — can never inflate the counter of
 * the next one, and compressor and main run stay apart even when they share
 * the same operation id.
 */
export class SdkReconnectMonitor {
  readonly #emit: ConnectionEventListener;
  readonly #scope: ConnectionScope | undefined;
  readonly #states = new WeakMap<ConnectionRequestContext, RequestState>();

  constructor(
    emit: ConnectionEventListener,
    options: { scope?: ConnectionScope } = {},
  ) {
    this.#emit = emit;
    this.#scope = options.scope;
  }

  get scope(): ConnectionScope | undefined {
    return this.#scope;
  }

  beforeRequest(context: ConnectionRequestContext): void {
    const state = this.#states.get(context);
    if (!state) {
      this.#states.set(context, { attempt: 1 });
      return;
    }
    state.attempt += 1;
    this.#emit({
      phase: "retrying",
      operation: context.operationID,
      attempt: state.attempt,
      scope: this.#scope,
      status: state.lastStatus,
      reason: state.lastReason ?? NETWORK_REASON,
    });
  }

  afterError(
    context: ConnectionRequestContext,
    response: Response | null,
    options: {
      willRetry?: boolean;
      reason?: string;
      delayMs?: number;
    } = {},
  ): void {
    const state = this.#state(context);
    state.lastStatus = response?.status;
    state.lastReason =
      options.reason ??
      (response ? `OpenRouter HTTP ${response.status}` : NETWORK_REASON);
    const willRetry =
      options.willRetry ??
      (response ? isTransientStatus(response.status) : false);
    if (!willRetry) {
      this.#states.delete(context);
      return;
    }
    this.#emit({
      phase: "retry-scheduled",
      operation: context.operationID,
      attempt: state.attempt,
      scope: this.#scope,
      status: response?.status,
      reason: state.lastReason,
      delayMs: options.delayMs,
    });
  }

  afterSuccess(context: ConnectionRequestContext): void {
    const state = this.#states.get(context);
    this.#states.delete(context);
    if (!state || state.attempt <= 1) {
      return;
    }
    this.#emit({
      phase: "restored",
      operation: context.operationID,
      attempt: state.attempt,
      scope: this.#scope,
      status: state.lastStatus,
    });
  }

  /** Current attempt of a request; 0 once the request is settled. */
  attemptOf(context: ConnectionRequestContext): number {
    return this.#states.get(context)?.attempt ?? 0;
  }

  #state(context: ConnectionRequestContext): RequestState {
    const existing = this.#states.get(context);
    if (existing) {
      return existing;
    }
    const created: RequestState = { attempt: 1 };
    this.#states.set(context, created);
    return created;
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Backoff for the given attempt (1 = first retry wait). A server supplied
 * Retry-After wins but is capped; the exponential fallback carries jitter from
 * an injectable random source.
 */
export function backoffDelayMs(
  attempt: number,
  options: { retryAfterMs?: number; random?: () => number } = {},
): number {
  if (options.retryAfterMs !== undefined && options.retryAfterMs >= 0) {
    return Math.min(options.retryAfterMs, RETRY_POLICY.retryAfterCapMs);
  }
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    RETRY_POLICY.initialDelayMs * RETRY_POLICY.backoffExponent ** exponent,
    RETRY_POLICY.maxDelayMs,
  );
  const random = options.random ?? Math.random;
  const factor = 1 - RETRY_POLICY.jitterRatio + 2 * RETRY_POLICY.jitterRatio * random();
  return Math.min(Math.round(base * factor), RETRY_POLICY.maxDelayMs);
}

export function retryAfterMs(response?: Response | null): number | undefined {
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

/**
 * The one retry loop for REST calls: at most `RETRY_POLICY.maxAttempts`
 * attempts, only for idempotent methods, Retry-After honoured but capped, and
 * every abort signal propagated into the waiting phase.
 */
export async function fetchWithReconnect(
  url: string,
  init: RequestInit,
  options: ReconnectFetchOptions,
): Promise<Response> {
  const {
    operation,
    monitor,
    signal,
    timeoutMs = RETRY_POLICY.requestTimeoutMs,
    clock = {},
  } = options;
  const call: FetchLike =
    options.fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
  const sleep = clock.sleep ?? delayWithAbort;
  const random = clock.random ?? Math.random;
  const method = (init.method ?? "GET").toUpperCase();
  const maxAttempts = IDEMPOTENT_METHODS.has(method)
    ? RETRY_POLICY.maxAttempts
    : 1;
  const context: ConnectionRequestContext = { operationID: operation };

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    monitor.beforeRequest(context);

    let response: Response | null = null;
    let failure: unknown;
    try {
      response = await call(url, {
        ...init,
        signal: attemptSignal(signal, timeoutMs),
      });
    } catch (error) {
      throwIfAborted(signal);
      failure = error;
    }

    if (response && !isTransientStatus(response.status)) {
      if (response.ok) {
        monitor.afterSuccess(context);
      } else {
        monitor.afterError(context, response, { willRetry: false });
      }
      return response;
    }

    const canRetry = attempt < maxAttempts;
    const delayMs = canRetry
      ? backoffDelayMs(attempt, {
          retryAfterMs: retryAfterMs(response),
          random,
        })
      : undefined;
    monitor.afterError(context, response, {
      willRetry: canRetry,
      reason: response ? undefined : NETWORK_REASON,
      delayMs,
    });

    if (!canRetry) {
      if (response) {
        return response;
      }
      throw failure ?? new Error(NETWORK_REASON);
    }

    await sleep(delayMs ?? 0, signal);
  }
}

export function formatConnectionEvent(event: ConnectionEvent): string {
  const target = operationLabel(event.operation, event.scope);
  if (event.phase === "retry-scheduled") {
    const wait = event.delayMs
      ? `neuer Versuch in ${formatSeconds(event.delayMs)}`
      : "Reconnect wird vorbereitet";
    return `${event.reason ?? "Verbindung unterbrochen"} · ${target} · ${wait}`;
  }
  if (event.phase === "retrying") {
    return `Reconnect-Versuch ${event.attempt} · ${target}`;
  }
  const attempts = event.attempt === 1 ? "1 Versuch" : `${event.attempt} Versuche`;
  return `Verbindung wiederhergestellt · ${target} · ${attempts}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new Error("Der aktuelle Lauf wurde abgebrochen.");
}

function attemptSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

async function delayWithAbort(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function operationLabel(
  operation: string,
  scope?: ConnectionScope,
): string {
  const base = baseOperationLabel(operation);
  if (scope === "compressor") {
    return `${base} · Kompressor`;
  }
  if (scope === "main") {
    return `${base} · Hauptlauf`;
  }
  if (scope === "voice") {
    return `${base} · Transkription`;
  }
  return base;
}

function baseOperationLabel(operation: string): string {
  if (operation === "createResponses") {
    return "Modellstream";
  }
  if (operation === "models") {
    return "Modellliste";
  }
  if (operation === "key") {
    return "Key-Prüfung";
  }
  if (operation === "credits") {
    return "Guthabenprüfung";
  }
  return operation || "OpenRouter";
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  const rendered = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
  return `${rendered.replace(".", ",")} s`;
}
