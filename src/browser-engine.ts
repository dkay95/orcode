/**
 * Headless-Chrome driving code for `browser_check`/`/browser`
 * (see src/workspace.ts and src/commands.ts).
 *
 * Split out of `browser.ts` (Phase 7, E-WEIGHT-01): this is the heavy half —
 * browser discovery, process spawning, and the CDP client — loaded via
 * dynamic `import()` only when a `browser_check` call actually needs to
 * launch a browser. `browser.ts` keeps the small, always-needed exports
 * (URL validation, the startup temp-artifact sweep, `BrowserTimeoutError`)
 * so those never pull this file in.
 *
 * No new dependency: Node 22 has a global `WebSocket`, so the Chrome
 * DevTools Protocol (CDP) is reachable over a plain WebSocket connection —
 * no Playwright, no Puppeteer, no `ws` package. Every external effect
 * (which files exist, how a process is spawned, how a WebSocket/`fetch`
 * behaves) is injectable so the orchestration in `inspectUrl` can be tested
 * with fakes, never a real browser and never real network access.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserTimeoutError,
  type ConsoleMessageReport,
  type FailedRequestReport,
  type PageReport,
} from "./browser.js";
import { errorMessage, isRecord, sanitizedEnvironment } from "./utils.js";

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

export interface BrowserSearchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real `fs.access` check. Tests inject this instead of touching disk. */
  fileExists?: (path: string) => Promise<boolean>;
}

async function realFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function macCandidates(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
}

const LINUX_BINARY_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "brave-browser",
] as const;

function linuxCandidates(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of LINUX_BINARY_NAMES) {
      out.push(join(dir, name));
    }
  }
  return out;
}

const WINDOWS_SUBPATHS = [
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["Microsoft", "Edge", "Application", "msedge.exe"],
  ["Chromium", "Application", "chrome.exe"],
  ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
] as const;

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  const out: string[] = [];
  for (const root of roots) {
    for (const sub of WINDOWS_SUBPATHS) {
      out.push(join(root, ...sub));
    }
  }
  return out;
}

/** Every absolute path this platform's search actually probes, in order. */
export function browserCandidates(deps: BrowserSearchDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform === "darwin") {
    return macCandidates();
  }
  if (platform === "win32") {
    return windowsCandidates(env);
  }
  return linuxCandidates(env);
}

/** Short, human-readable summary of what was searched — used in the "nothing found" error instead of dumping every PATH×name combination. */
function describeSearch(deps: BrowserSearchDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") {
    return `under /Applications: Google Chrome, Microsoft Edge, Chromium, Brave Browser`;
  }
  if (platform === "win32") {
    return `under %ProgramFiles%, %ProgramFiles(x86)%, and %LOCALAPPDATA%: Chrome, Edge, Chromium, Brave`;
  }
  return `in PATH: ${LINUX_BINARY_NAMES.join(", ")}`;
}

/**
 * Finds a Chrome/Edge/Chromium/Brave executable. `configuredPath` (from
 * `config.browserPath`) wins unconditionally when set — checked for
 * existence so a stale config value fails with a clear message rather than a
 * confusing spawn error later. Otherwise searches the platform's usual
 * install locations; the first hit wins. Never throws for "nothing
 * installed" without saying exactly what was checked and what to do next.
 */
export async function findBrowserExecutable(
  configuredPath: string | undefined,
  deps: BrowserSearchDeps = {},
): Promise<string> {
  const fileExists = deps.fileExists ?? realFileExists;
  const trimmedConfigured = configuredPath?.trim();
  if (trimmedConfigured) {
    if (await fileExists(trimmedConfigured)) {
      return trimmedConfigured;
    }
    throw new Error(
      `Configured browser path (browserPath) does not exist: ${trimmedConfigured}. Fix the setting or clear it so orcode searches on its own.`,
    );
  }
  const candidates = browserCandidates(deps);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  const shown = candidates.slice(0, 20);
  const more = candidates.length > shown.length ? `\n  … and ${candidates.length - shown.length} more` : "";
  throw new Error(
    [
      `No browser found (checked ${describeSearch(deps)}).`,
      shown.length > 0 ? `Checked paths:\n${shown.map((path) => `  - ${path}`).join("\n")}${more}` : "",
      "Install Chrome, Edge, Chromium, or Brave, or set browserPath in the configuration to the path of an executable.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Process discipline — mirrors runProcess's process-group handling in
// workspace.ts (own process group, hard kill via the group, SIGTERM then
// SIGKILL), but for a long-running server process we talk to while it runs
// rather than a command whose output we collect until it exits.
// ---------------------------------------------------------------------------

const PROCESS_KILL_GRACE_MS = 1_500;

export interface ManagedProcess {
  readonly pid: number;
  kill(signal: NodeJS.Signals): void;
  /** Resolves once the process has actually exited (or immediately if it already has). */
  readonly exited: Promise<void>;
}

export type SpawnFn = typeof spawn;

/** Kills the whole process group `child` belongs to, falling back to just the one process if that fails (e.g. no permission, or it's already gone). */
export function killProcessGroup(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export interface StartManagedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

/**
 * Starts `executable` in its own process group. The caller is responsible
 * for calling `kill` once done (directly, or via `runWithHardTimeout`
 * below) — this function does not itself impose a timeout.
 */
export function startManagedProcess(
  executable: string,
  args: string[],
  options: StartManagedProcessOptions = {},
): ManagedProcess {
  const spawnImpl = options.spawnFn ?? spawn;
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    env: { ...sanitizedEnvironment(), ...options.env },
    stdio: "ignore",
    detached: true,
  });
  // `spawn()` reports ENOENT asynchronously. Own the error event before
  // looking at `pid`, otherwise the synchronous pid guard can throw first
  // and leave Node to emit an unhandled child-process error one tick later.
  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    child.once("error", () => resolvePromise());
  });
  if (child.pid === undefined) {
    throw new Error(`Process ${executable} could not be started.`);
  }
  const pid = child.pid;
  return {
    pid,
    kill: (signal) => killProcessGroup(child, signal),
    exited,
  };
}

/**
 * Runs `body(deadline)` and guarantees `proc`'s whole process group is dead
 * (SIGTERM, then SIGKILL after a grace period if it ignores that) by the
 * time this returns or throws — success, failure, or the hard timeout
 * itself. `deadline` is an absolute `Date.now()`-scale timestamp `body` can
 * use to budget its own sub-steps.
 *
 * Killing the OS process alone does not release a body stuck in fetch/CDP,
 * so the body receives an operation signal that fires for either the exact
 * root cancellation or this hard timeout. Browser awaits race that signal;
 * the operation tree is removed only after this process owner settles.
 */
export async function runWithHardTimeout<T>(
  proc: ManagedProcess,
  timeoutMs: number,
  body: (deadline: number, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const deadline = Date.now() + boundedTimeoutMs;
  const operation = new AbortController();
  const abortFromRoot = () => operation.abort(signalError(signal));
  if (signal?.aborted) {
    abortFromRoot();
  } else {
    signal?.addEventListener("abort", abortFromRoot, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!operation.signal.aborted) {
    if (boundedTimeoutMs === 0) {
      operation.abort(new BrowserTimeoutError(boundedTimeoutMs));
    } else {
      timer = setTimeout(() => {
        operation.abort(new BrowserTimeoutError(boundedTimeoutMs));
      }, boundedTimeoutMs);
    }
  }
  let failure: unknown;
  const bodyPromise = Promise.resolve().then(() => {
    if (operation.signal.aborted) throw signalError(operation.signal);
    return body(deadline, operation.signal);
  });
  try {
    return await awaitWithSignal(bodyPromise, operation.signal);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromRoot);
    const cleanupErrors: unknown[] = [];
    try {
      await stopManagedProcess(proc);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const bodySettled = await settlesWithin(
      bodyPromise.then(() => undefined, () => undefined),
      PROCESS_KILL_GRACE_MS + 200,
    );
    if (!bodySettled) {
      cleanupErrors.push(new Error("Browser body did not respond to abort or timeout."));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
        "Browser operation could not be fully ended.",
      );
    }
  }
}

async function stopManagedProcess(proc: ManagedProcess): Promise<void> {
  proc.kill("SIGTERM");
  if (await settlesWithin(proc.exited, PROCESS_KILL_GRACE_MS)) {
    return;
  }
  proc.kill("SIGKILL");
  if (!(await settlesWithin(proc.exited, PROCESS_KILL_GRACE_MS + 200))) {
    throw new Error("Browser process could not be confirmed ended.");
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("Browser inspection was cancelled.");
  error.name = "AbortError";
  return error;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      rejectPromise(signalError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signalError(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(signalError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Free port allocation
// ---------------------------------------------------------------------------

export async function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolvePromise(port);
        } else {
          rejectPromise(new Error("No free port found."));
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Chrome's HTTP debug endpoint (`/json/version`, `/json/new`, `/json/close`)
// ---------------------------------------------------------------------------

export type FetchFn = typeof fetch;

async function waitForDevtoolsHttp(
  port: number,
  fetchFn: FetchFn,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  let lastError = "";
  while (Date.now() < deadline) {
    if (signal.aborted) throw signalError(signal);
    try {
      const response = await awaitWithSignal(
        fetchFn(`http://127.0.0.1:${port}/json/version`, { signal }),
        signal,
      );
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      if (signal.aborted) throw signalError(signal);
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100, signal);
  }
  throw new Error(
    `Chrome DevTools endpoint on port ${port} is not responding (${lastError || "timeout"}).`,
  );
}

interface DevtoolsTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

async function openNewTab(
  port: number,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<DevtoolsTarget> {
  const response = await awaitWithSignal(
    fetchFn(`http://127.0.0.1:${port}/json/new`, { method: "PUT", signal }),
    signal,
  );
  if (!response.ok) {
    throw new Error(`New Chrome tab could not be opened (HTTP ${response.status}).`);
  }
  const data: unknown = await awaitWithSignal(response.json(), signal);
  const id = isRecord(data) && typeof data.id === "string" ? data.id : "";
  const webSocketDebuggerUrl =
    isRecord(data) && typeof data.webSocketDebuggerUrl === "string" ? data.webSocketDebuggerUrl : "";
  if (!webSocketDebuggerUrl) {
    throw new Error("Chrome did not provide a DevTools WebSocket URL for the new tab.");
  }
  return { id, webSocketDebuggerUrl };
}

async function closeTab(
  port: number,
  fetchFn: FetchFn,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  if (!id || signal.aborted) {
    return;
  }
  await awaitWithSignal(
    fetchFn(`http://127.0.0.1:${port}/json/close/${id}`, { signal }),
    signal,
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Minimal CDP client over a plain WebSocket
// ---------------------------------------------------------------------------

/** The slice of the WHATWG `WebSocket` interface this module needs — small enough for a test to fake completely. */
export interface WebSocketLike {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: never) => void): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Parses one CDP frame. Returns `null` — never throws — for anything that
 * is not valid JSON or not a JSON object; a single garbled frame must not
 * take down the rest of the inspection.
 */
export function parseCdpFrame(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * One CDP session over one WebSocket. `send` is the JSON-RPC-style
 * request/response half of the protocol; `on`/`once` subscribe to
 * unsolicited events (`Runtime.consoleAPICalled`, `Network.responseReceived`,
 * …). A frame that fails to parse (`parseCdpFrame` returns `null`) is
 * silently dropped rather than crashing the session.
 */
export class CdpClient {
  #ws: WebSocketLike;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  #opened: Promise<void>;

  constructor(url: string, wsFactory: WebSocketFactory = (target) => new WebSocket(target) as unknown as WebSocketLike) {
    this.#ws = wsFactory(url);
    this.#opened = new Promise((resolvePromise, rejectPromise) => {
      this.#ws.addEventListener("open", () => resolvePromise());
      this.#ws.addEventListener("error", () => rejectPromise(new Error("CDP WebSocket connection failed.")));
    });
    this.#ws.addEventListener("message", (event) => {
      const data = (event as unknown as { data: unknown }).data;
      const raw = typeof data === "string" ? data : String(data);
      const message = parseCdpFrame(raw);
      if (!message) {
        return;
      }
      this.#dispatch(message);
    });
    // Without this, a call still awaiting a response when the browser
    // process is killed (timeout, crash) would hang forever — nothing would
    // ever settle its promise. Rejecting every outstanding call here is what
    // lets `runWithHardTimeout`'s abandoned `body` promise actually finish
    // instead of leaking.
    const onGone = () => {
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      for (const call of pending) {
        call.reject(new Error("CDP connection closed."));
      }
    };
    this.#ws.addEventListener("close", onGone);
    this.#ws.addEventListener("error", onGone);
  }

  #dispatch(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "CDP error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      const handlers = this.#listeners.get(message.method);
      if (!handlers?.length) {
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      for (const handler of [...handlers]) {
        handler(params);
      }
    }
  }

  waitOpen(): Promise<void> {
    return this.#opened;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const list = this.#listeners.get(method) ?? [];
    list.push(handler);
    this.#listeners.set(method, list);
  }

  /** Resolves `true` once `method` fires, or `false` once `timeoutMs` elapses first — never rejects. */
  waitForEvent(method: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolvePromise(false);
        }
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      this.on(method, () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(true);
        }
      });
    });
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------
// CDP event -> report fields
// ---------------------------------------------------------------------------

const MAX_CONSOLE_MESSAGES = 200;
const MAX_PAGE_ERRORS = 100;
const MAX_FAILED_REQUESTS = 100;

function describeRemoteObject(value: unknown): string {
  if (!isRecord(value)) {
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
  if (value.unserializableValue !== undefined) {
    return String(value.unserializableValue);
  }
  if (value.value !== undefined) {
    return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  }
  if (typeof value.description === "string") {
    return value.description;
  }
  return typeof value.type === "string" ? `<${value.type}>` : "<unknown>";
}

export function consoleMessageFromParams(params: Record<string, unknown>): ConsoleMessageReport {
  const level = typeof params.type === "string" ? params.type : "log";
  const args = Array.isArray(params.args) ? params.args : [];
  const text = args.map(describeRemoteObject).join(" ").trim();
  return { level, text: text || "(empty)" };
}

export function pageErrorFromException(params: Record<string, unknown>): string {
  const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : params;
  const text = typeof details.text === "string" ? details.text : "Unbehandelte Ausnahme";
  const exception = isRecord(details.exception) ? details.exception : null;
  const description = exception ? describeRemoteObject(exception) : "";
  return description && description !== text ? `${text}: ${description}` : text;
}

export function failedRequestFromResponse(params: Record<string, unknown>): FailedRequestReport | null {
  const response = isRecord(params.response) ? params.response : null;
  const status = response && typeof response.status === "number" ? response.status : null;
  if (status === null || status < 400) {
    return null;
  }
  const url = response && typeof response.url === "string" ? response.url : "";
  return { url, status };
}

export function failedRequestFromLoadingFailed(
  params: Record<string, unknown>,
  urlById: ReadonlyMap<string, string>,
): FailedRequestReport | null {
  if (params.canceled === true) {
    return null;
  }
  const requestId = typeof params.requestId === "string" ? params.requestId : "";
  const url = urlById.get(requestId) ?? "";
  const error = typeof params.errorText === "string" ? params.errorText : "Netzwerkfehler";
  return { url, status: null, error };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface InspectUrlDeps {
  fileExists?: BrowserSearchDeps["fileExists"];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  wsFactory?: WebSocketFactory;
  fetchFn?: FetchFn;
  findPort?: () => Promise<number>;
  /** Operation-local removal seam. Production removes recursively and fail-closed. */
  removeTree?: (path: string) => Promise<void>;
}

export interface InspectUrlOptions {
  url: string;
  /** Hard limit for the whole inspection, browser startup included. */
  timeoutMs: number;
  /** Extra settle time after the load event (or after its own timeout) before capturing state. Default 500ms. */
  waitMs?: number;
  viewport?: { width: number; height: number };
  fullPage?: boolean;
  /** Default true. `/browser`'s plain-text report sets this to false — nothing will ever read the screenshot there, so it is not worth taking. */
  captureScreenshot?: boolean;
  /** Configured executable; `inspectUrl` validates it before allocating artifacts. */
  browserPath?: string;
  /** Exact root run signal. Timeout remains independently bounded by `timeoutMs`. */
  signal?: AbortSignal;
  /** Base directory for the temporary profile and screenshot file. Defaults to `os.tmpdir()`. */
  tempDir?: string;
  deps?: InspectUrlDeps;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export async function inspectUrl(options: InspectUrlOptions): Promise<PageReport> {
  if (options.signal?.aborted) throw signalError(options.signal);
  if (options.timeoutMs <= 0) throw new BrowserTimeoutError(options.timeoutMs);
  const deps = options.deps ?? {};
  const fetchFn = deps.fetchFn ?? fetch;
  const wsFactory = deps.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const waitMs = options.waitMs ?? 500;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const captureScreenshot = options.captureScreenshot ?? true;
  const tempRoot = options.tempDir ?? tmpdir();
  const deadline = Date.now() + options.timeoutMs;
  const executable = await awaitUntilDeadline(
    () => findBrowserExecutable(options.browserPath, deps),
    deadline,
    options.timeoutMs,
    options.signal,
  );
  const operationDir = await mkdtemp(join(tempRoot, "orcode-browser-operation-"));
  let failure: unknown;
  try {
    if (options.signal?.aborted) throw signalError(options.signal);
    if (remaining(deadline) === 0) throw new BrowserTimeoutError(options.timeoutMs);
    const profileDir = join(operationDir, "profile");
    const screenshotPath = join(operationDir, "screenshot.png");
    await mkdir(profileDir);
    const port = await awaitUntilDeadline(
      () => deps.findPort ? deps.findPort() : findFreePort(),
      deadline,
      options.timeoutMs,
      options.signal,
    );
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ];
    const proc = startManagedProcess(executable, args, { spawnFn: deps.spawnFn });

    return await runWithHardTimeout(proc, remaining(deadline), async (bodyDeadline, operationSignal) => {
      await waitForDevtoolsHttp(port, fetchFn, bodyDeadline, operationSignal);
      const target = await openNewTab(port, fetchFn, operationSignal);
      const session = new CdpClient(target.webSocketDebuggerUrl, wsFactory);
      try {
        await awaitWithSignal(session.waitOpen(), operationSignal);

        const consoleMessages: ConsoleMessageReport[] = [];
        const pageErrors: string[] = [];
        const failedRequests: FailedRequestReport[] = [];
        const urlById = new Map<string, string>();
        let truncated = false;

        session.on("Runtime.consoleAPICalled", (params) => {
          if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
            truncated = true;
            return;
          }
          consoleMessages.push(consoleMessageFromParams(params));
        });
        session.on("Runtime.exceptionThrown", (params) => {
          if (pageErrors.length >= MAX_PAGE_ERRORS) {
            truncated = true;
            return;
          }
          pageErrors.push(pageErrorFromException(params));
        });
        session.on("Network.requestWillBeSent", (params) => {
          const requestId = typeof params.requestId === "string" ? params.requestId : "";
          const request = isRecord(params.request) ? params.request : null;
          const url = request && typeof request.url === "string" ? request.url : "";
          if (requestId && url) {
            urlById.set(requestId, url);
          }
        });
        session.on("Network.responseReceived", (params) => {
          const entry = failedRequestFromResponse(params);
          if (!entry) {
            return;
          }
          if (failedRequests.length >= MAX_FAILED_REQUESTS) {
            truncated = true;
            return;
          }
          failedRequests.push(entry);
        });
        session.on("Network.loadingFailed", (params) => {
          const entry = failedRequestFromLoadingFailed(params, urlById);
          if (!entry) {
            return;
          }
          if (failedRequests.length >= MAX_FAILED_REQUESTS) {
            truncated = true;
            return;
          }
          failedRequests.push(entry);
        });

        await awaitWithSignal(session.send("Page.enable"), operationSignal);
        await awaitWithSignal(session.send("Network.enable"), operationSignal);
        await awaitWithSignal(session.send("Runtime.enable"), operationSignal);

        const navigationStart = Date.now();
        await awaitWithSignal(
          session.send("Page.navigate", { url: options.url }),
          operationSignal,
        );
        const loaded = await awaitWithSignal(
          session.waitForEvent("Page.loadEventFired", remaining(bodyDeadline)),
          operationSignal,
        );
        if (!loaded) {
          truncated = true;
          pageErrors.push(
            "No load event within the time limit — the report shows the state at the abort point.",
          );
        }
        if (waitMs > 0) {
          await delay(Math.min(waitMs, remaining(bodyDeadline)), operationSignal);
        }
        const loadTimeMs = Date.now() - navigationStart;

        const title = await readTitle(session, operationSignal);

        if (captureScreenshot) {
          await captureScreenshotToFile(
            session,
            screenshotPath,
            Boolean(options.fullPage),
            operationSignal,
          );
        }
        if (operationSignal.aborted) throw signalError(operationSignal);

        return {
          url: options.url,
          title,
          screenshotPath: null,
          consoleMessages,
          pageErrors,
          failedRequests,
          loadTimeMs,
          truncated,
        };
      } finally {
        session.close();
        await closeTab(port, fetchFn, target.id, operationSignal).catch(() => undefined);
      }
    }, options.signal);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      const removeTree = deps.removeTree ?? ((path: string) => rm(path, { recursive: true, force: true }));
      await removeTree(operationDir);
    } catch (cleanupError) {
      const message = `Temporary browser artifacts could not be removed: ${errorMessage(cleanupError)}`;
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupError], message);
      }
      throw new Error(message, { cause: cleanupError });
    }
  }
}

async function awaitUntilDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  configuredTimeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signalError(signal);
  const waitMs = remaining(deadline);
  if (waitMs === 0) throw new BrowserTimeoutError(configuredTimeoutMs);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => finish(() => rejectPromise(signalError(signal)));
    const timer = setTimeout(
      () => finish(() => rejectPromise(new BrowserTimeoutError(configuredTimeoutMs))),
      waitMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve().then(() => {
      if (signal?.aborted) throw signalError(signal);
      if (settled || remaining(deadline) === 0) {
        throw new BrowserTimeoutError(configuredTimeoutMs);
      }
      return operation();
    }).then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function readTitle(session: CdpClient, signal: AbortSignal): Promise<string> {
  try {
    const result = await awaitWithSignal(
      session.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      }),
      signal,
    );
    if (isRecord(result) && isRecord(result.result) && typeof result.result.value === "string") {
      return result.result.value;
    }
  } catch (error) {
    if (signal.aborted) throw signalError(signal);
    // No title is not fatal — the rest of the report still stands.
  }
  return "";
}

async function captureScreenshotToFile(
  session: CdpClient,
  path: string,
  fullPage: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) {
      const metrics = await awaitWithSignal(session.send("Page.getLayoutMetrics"), signal);
      const contentSize = isRecord(metrics) ? metrics.contentSize : null;
      if (isRecord(contentSize) && typeof contentSize.width === "number" && typeof contentSize.height === "number") {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
      }
    }
    const shot = await awaitWithSignal(session.send("Page.captureScreenshot", params), signal);
    if (!isRecord(shot) || typeof shot.data !== "string") {
      return null;
    }
    await writeFile(path, Buffer.from(shot.data, "base64"));
    if (signal.aborted) throw signalError(signal);
    return path;
  } catch (error) {
    if (signal.aborted) throw signalError(signal);
    return null;
  }
}
