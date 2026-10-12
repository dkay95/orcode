import type { NativeSidecarChannel } from "./native-sidecar-channel.js";
import { createKimiRequestId, type CodexNativeActionRequest } from "./native-sidecar-channel.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann" as const;
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access" as const;
export const CODEX_OAUTH_ORIGINATOR = "codex_cli_rs" as const;

type LoginType = "chatgpt" | "chatgptDeviceCode";

interface AppServer {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

interface NativeShellOptions {
  readonly appServer: AppServer;
  readonly channel: NativeSidecarChannel;
  readonly childGeneration: number;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly nativePresentationTimeoutMs?: number;
}

export class CodexNativeShellActions {
  readonly #appServer: AppServer;
  readonly #channel: NativeSidecarChannel;
  readonly #now: () => number;
  readonly #requestId: () => string;
  readonly #timeoutMs: number;
  #childGeneration: number;
  #generationAbort = new AbortController();
  #loginPending = false;

  constructor(options: NativeShellOptions) {
    this.#appServer = options.appServer;
    this.#channel = options.channel;
    this.#childGeneration = generation(options.childGeneration);
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? createKimiRequestId;
    this.#timeoutMs = options.nativePresentationTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 300_000) {
      throw new TypeError("Native login presentation timeout is invalid.");
    }
  }

  setChildGeneration(value: number): void {
    const next = generation(value);
    if (next === this.#childGeneration) return;
    this.#generationAbort.abort(new Error("Codex child generation changed."));
    this.#generationAbort = new AbortController();
    this.#childGeneration = next;
  }

  async beginLogin(request: Readonly<{ type: LoginType }>, signal?: AbortSignal): Promise<Readonly<{ loginId: string; type: LoginType }>> {
    if (this.#loginPending) throw new Error("A Codex login presentation is already pending.");
    this.#loginPending = true;
    const childGeneration = this.#childGeneration;
    const generationSignal = this.#generationAbort.signal;
    let loginId: string | null = null;
    let nativeFence: Readonly<{
      requestId: string;
      childGeneration: number;
      deadlineAt: number;
    }> | null = null;
    let prepareSettled = false;
    let cancelled = false;
    const cancel = async () => {
      if (cancelled || loginId === null) return;
      cancelled = true;
      await this.#cancelLoginBounded(loginId);
    };
    try {
      if (request.type !== "chatgpt" && request.type !== "chatgptDeviceCode") {
        throw new TypeError("Codex login type is invalid.");
      }
      const response = await this.#appServer.request<unknown>("account/login/start", { type: request.type }, signal);
      loginId = loginIdFrom(response);
      this.#assertCurrent(childGeneration, signal);
      const requestId = this.#requestId();
      const deadlineAt = this.#now() + this.#timeoutMs;
      nativeFence = Object.freeze({ requestId, childGeneration, deadlineAt });
      const native = loginAction(response, request.type, {
        requestId, childGeneration, loginId, deadlineAt,
      });
      const resultAbort = new AbortController();
      const resultPromise = this.#channel.waitForCodexControl(requestId, resultAbort.signal);
      // Registration deliberately precedes the private write. If validation
      // after that write fails, the abort below may reject before this branch
      // reaches its await; attach a handler now so that rejection stays owned.
      void resultPromise.catch(() => undefined);
      try {
        // Rust treats this first record only as PREPARE. A complete descriptor
        // write therefore remains inert until this promise settles and the
        // caller/generation/deadline fences pass immediately before COMMIT.
        const write = this.#channel.writeCodexAction(native);
        void write.catch(() => undefined);
        await this.#awaitPrivateWrite(write, deadlineAt, signal, generationSignal);
        prepareSettled = true;
        this.#assertCurrent(childGeneration, signal, deadlineAt);
        const commit = this.#channel.writeCodexAction(Object.freeze({
          kind: "codex-native-action-commit",
          requestId,
          childGeneration,
          deadlineAt,
        }));
        void commit.catch(() => undefined);
        await this.#awaitPrivateWrite(commit, deadlineAt, signal, generationSignal);
        this.#assertCurrent(childGeneration, signal, deadlineAt);
        const result = await this.#awaitNativeResult(resultPromise, deadlineAt, signal);
        this.#assertCurrent(childGeneration, signal, deadlineAt);
        if (result === null || result.kind !== "codex-native-action-result"
          || result.requestId !== requestId || result.childGeneration !== childGeneration
          || result.status !== "presented") {
          throw new Error("Native login presentation failed.");
        }
      } finally {
        resultAbort.abort(new Error("Native login presentation is no longer pending."));
      }
      return Object.freeze({ loginId, type: request.type });
    } catch (error) {
      if (nativeFence !== null) {
        if (prepareSettled) await this.#revokeNativeBounded(nativeFence);
        else this.#channel.close();
      }
      await cancel();
      const failure = error instanceof Error ? error : new Error("Native login presentation failed.");
      if (/native login presentation|Codex login (?:URL|code|response)/i.test(failure.message)) throw failure;
      throw new Error("Native login presentation failed.", { cause: failure });
    } finally {
      this.#loginPending = false;
    }
  }

  async cancelLogin(loginId: string, signal?: AbortSignal): Promise<void> {
    if (!safeText(loginId)) throw new TypeError("Codex login ID is invalid.");
    await this.#appServer.request("account/login/cancel", { loginId }, signal);
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.#appServer.request("account/logout", {}, signal);
  }

  async readAccount(signal?: AbortSignal): Promise<Readonly<{
    accountType: "chatgpt" | "other" | null;
    planType: string | null;
    requiresOpenaiAuth: boolean;
  }>> {
    const value = await this.#appServer.request<unknown>("account/read", { refreshToken: false }, signal);
    if (!isPlainObject(value) || typeof value.requiresOpenaiAuth !== "boolean") {
      throw new Error("Codex account response is invalid.");
    }
    if (value.account === null) {
      return Object.freeze({ accountType: null, planType: null, requiresOpenaiAuth: value.requiresOpenaiAuth });
    }
    if (!isPlainObject(value.account) || typeof value.account.type !== "string") {
      throw new Error("Codex account response is invalid.");
    }
    const planType = safeText(value.account.planType) ? value.account.planType : null;
    return Object.freeze({
      accountType: value.account.type === "chatgpt" ? "chatgpt" : "other",
      planType,
      requiresOpenaiAuth: value.requiresOpenaiAuth,
    });
  }

  async readRateLimits(signal?: AbortSignal): Promise<unknown> {
    return this.#appServer.request("account/rateLimits/read", {}, signal);
  }

  async listModels(signal?: AbortSignal): Promise<unknown> {
    return this.#appServer.request("model/list", {}, signal);
  }

  async #awaitNativeResult(
    result: Promise<Awaited<ReturnType<NativeSidecarChannel["readCodexControl"]>>>,
    deadlineAt: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw signal.reason;
    const remaining = Math.max(0, Math.min(this.#timeoutMs, deadlineAt - this.#now()));
    let timer: NodeJS.Timeout | undefined;
    let detach = () => {};
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native login presentation timed out.")), remaining);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
      });
      return await Promise.race([result, timeout, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      detach();
    }
  }

  async #awaitPrivateWrite(
    write: Promise<void>,
    deadlineAt: number,
    signal: AbortSignal | undefined,
    generationSignal: AbortSignal,
  ): Promise<void> {
    const remaining = Math.max(0, Math.min(this.#timeoutMs, deadlineAt - this.#now()));
    let timer: NodeJS.Timeout | undefined;
    const detach: Array<() => void> = [];
    const interrupted = (source: AbortSignal) => new Promise<never>((_resolve, reject) => {
      if (source.aborted) {
        reject(source.reason instanceof Error ? source.reason : new Error("Aborted"));
        return;
      }
      const onAbort = () => reject(source.reason instanceof Error ? source.reason : new Error("Aborted"));
      source.addEventListener("abort", onAbort, { once: true });
      detach.push(() => source.removeEventListener("abort", onAbort));
    });
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native login presentation timed out.")), remaining);
      });
      const boundaries: Promise<unknown>[] = [write, timeout, interrupted(generationSignal)];
      if (signal) boundaries.push(interrupted(signal));
      await Promise.race(boundaries);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of detach) remove();
    }
  }

  #assertCurrent(childGeneration: number, signal?: AbortSignal, deadlineAt?: number): void {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    }
    if (this.#childGeneration !== childGeneration
      || (deadlineAt !== undefined && this.#now() >= deadlineAt)) {
      throw new Error("Native login presentation failed.");
    }
  }

  async #cancelLoginBounded(loginId: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = Math.min(this.#timeoutMs, 1_000);
    let timer: NodeJS.Timeout | undefined;
    const request = this.cancelLogin(loginId, controller.signal).catch(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Codex login cancellation timed out."));
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([request, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort(new Error("Codex login cancellation settled."));
    }
  }

  async #revokeNativeBounded(fence: Readonly<{
    requestId: string;
    childGeneration: number;
    deadlineAt: number;
  }>): Promise<void> {
    if (!this.#channel.isOpen) return;
    const write = this.#channel.writeCodexAction(Object.freeze({
      kind: "codex-native-action-revoke",
      ...fence,
    })).then(() => true, () => false);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.min(this.#timeoutMs, 100));
    });
    try {
      if (!await Promise.race([write, timeout])) this.#channel.close();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function loginAction(
  response: unknown,
  type: LoginType,
  fence: Readonly<{ requestId: string; childGeneration: number; loginId: string; deadlineAt: number }>,
): CodexNativeActionRequest {
  if (!isPlainObject(response) || response.type !== type) throw new Error("Codex login response is invalid.");
  if (type === "chatgpt") {
    if (typeof response.authUrl !== "string") throw new Error("Codex login URL is invalid.");
    validateBrowserLoginUrl(response.authUrl);
    return Object.freeze({ kind: "codex-browser-login-prepare", ...fence, authUrl: response.authUrl });
  }
  if (typeof response.verificationUrl !== "string" || typeof response.userCode !== "string") {
    throw new Error("Codex login code is invalid.");
  }
  validateDeviceLogin(response.verificationUrl, response.userCode);
  return Object.freeze({
    kind: "codex-device-login-prepare", ...fence,
    verificationUrl: response.verificationUrl,
    userCode: response.userCode,
  });
}

function loginIdFrom(value: unknown): string {
  if (!isPlainObject(value) || !safeText(value.loginId)) throw new Error("Codex login response is invalid.");
  return value.loginId;
}

export function validateBrowserLoginUrl(source: string): void {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Codex login URL is invalid."); }
  if (!source.startsWith("https://auth.openai.com/oauth/authorize?")
    || source !== url.href || source.includes("#")
    || url.protocol !== "https:" || url.hostname !== "auth.openai.com"
    || url.pathname !== "/oauth/authorize" || url.username !== "" || url.password !== ""
    || url.port !== "" || url.hash !== "") throw new Error("Codex login URL is invalid.");
  const rawQuery = source.slice("https://auth.openai.com/oauth/authorize?".length);
  if (rawQuery.length === 0 || rawQuery.split("&").some((pair) => pair.length === 0)) {
    throw new Error("Codex login URL is invalid.");
  }
  const required = new Map<string, string | RegExp>([
    ["response_type", "code"], ["client_id", CODEX_OAUTH_CLIENT_ID],
    ["scope", CODEX_OAUTH_SCOPE], ["code_challenge", /^[A-Za-z0-9_-]{43,128}$/],
    ["code_challenge_method", "S256"], ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"], ["state", /^[A-Za-z0-9_-]{32,128}$/],
    ["originator", CODEX_OAUTH_ORIGINATOR],
  ]);
  const allowed = new Set([...required.keys(), "redirect_uri", "allowed_workspace_id"]);
  const counts = new Map<string, number>();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key)) throw new Error("Codex login URL is invalid.");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, expected] of required) {
    if (counts.get(key) !== 1) throw new Error("Codex login URL is invalid.");
    const actual = url.searchParams.get(key)!;
    if (typeof expected === "string" ? actual !== expected : !expected.test(actual)) {
      throw new Error("Codex login URL is invalid.");
    }
  }
  if (counts.get("redirect_uri") !== 1 || (counts.get("allowed_workspace_id") ?? 0) > 1) {
    throw new Error("Codex login URL is invalid.");
  }
  const redirectSource = url.searchParams.get("redirect_uri")!;
  if (redirectSource.includes("%")) throw new Error("Codex login URL is invalid.");
  let redirect: URL;
  try { redirect = new URL(redirectSource); } catch { throw new Error("Codex login URL is invalid."); }
  const port = Number(redirect.port);
  if (redirectSource !== redirect.href
    || redirectSource !== `http://localhost:${String(port)}/auth/callback`
    || redirect.protocol !== "http:" || redirect.hostname !== "localhost"
    || redirect.username !== "" || redirect.password !== "" || redirect.pathname !== "/auth/callback"
    || redirect.search !== "" || redirect.hash !== "" || !Number.isInteger(port)
    || port < 1024 || port > 65535) throw new Error("Codex login URL is invalid.");
  const workspace = url.searchParams.get("allowed_workspace_id");
  if (workspace !== null && !safeText(workspace)) throw new Error("Codex login URL is invalid.");
}

export function validateDeviceLogin(verificationUrl: string, userCode: string): void {
  let url: URL;
  try { url = new URL(verificationUrl); } catch { throw new Error("Codex login URL is invalid."); }
  if (verificationUrl !== "https://auth.openai.com/codex/device"
    || verificationUrl !== url.href
    || url.protocol !== "https:" || url.hostname !== "auth.openai.com"
    || url.pathname !== "/codex/device" || url.username !== "" || url.password !== ""
    || url.port !== "" || url.search !== "" || url.hash !== ""
    || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) {
    throw new Error("Codex login code is invalid.");
  }
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Codex child generation is invalid.");
  return value;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
