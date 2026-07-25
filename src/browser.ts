/**
 * Headless-browser inspection for `browser_check`/`/browser` (see
 * src/workspace.ts and src/commands.ts).
 *
 * No new dependency: Node 22 has a global `WebSocket`, so the Chrome
 * DevTools Protocol (CDP) is reachable over a plain WebSocket connection —
 * no Playwright, no Puppeteer, no `ws` package. Every external effect
 * (which files exist, how a process is spawned, how a WebSocket/`fetch`
 * behaves) is injectable so the orchestration in `inspectUrl` can be tested
 * with fakes, never a real browser and never real network access.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isRecord, sanitizedEnvironment } from "./utils.js";

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface ConsoleMessageReport {
  level: string;
  text: string;
}

export interface FailedRequestReport {
  url: string;
  status: number | null;
  error?: string;
}

export interface PageReport {
  url: string;
  title: string;
  /** Absolute path to a temporary PNG, or `null` when no screenshot was taken. Caller owns cleanup — see `deleteScreenshot`. */
  screenshotPath: string | null;
  consoleMessages: ConsoleMessageReport[];
  pageErrors: string[];
  failedRequests: FailedRequestReport[];
  loadTimeMs: number;
  /** True when any collected list hit its internal cap (see `MAX_*` below) or the load event never fired within the time budget. */
  truncated: boolean;
}

/** Deletes a screenshot file produced by `inspectUrl`. Never throws — a missing or already-deleted file is not an error here. */
export async function deleteScreenshot(path: string | null): Promise<void> {
  if (!path) {
    return;
  }
  await unlink(path).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// URL classification (localhost/file:// vs. everything else)
// ---------------------------------------------------------------------------

export const BROWSER_ALLOWED_PROTOCOLS = ["http:", "https:", "file:"] as const;

/**
 * Parses and validates a URL for `browser_check`/`/browser`. Only
 * http/https/file — anything else (`javascript:`, `chrome:`, `data:`, …)
 * is rejected outright, not routed through the approval system, since no
 * approval makes those safe to load headlessly.
 */
export function validateBrowserUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Keine URL angegeben.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Ungültige URL: ${trimmed}`);
  }
  if (!BROWSER_ALLOWED_PROTOCOLS.includes(parsed.protocol as (typeof BROWSER_ALLOWED_PROTOCOLS)[number])) {
    throw new Error(
      `Nicht unterstütztes URL-Schema „${parsed.protocol}“. Erlaubt sind http:, https: und file:.`,
    );
  }
  return parsed;
}

/** `localhost`, `127.0.0.1`, `::1` (with or without brackets) and any `*.localhost` subdomain. */
export function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

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
    return `unter /Applications: Google Chrome, Microsoft Edge, Chromium, Brave Browser`;
  }
  if (platform === "win32") {
    return `unter %ProgramFiles%, %ProgramFiles(x86)% und %LOCALAPPDATA%: Chrome, Edge, Chromium, Brave`;
  }
  return `im PATH: ${LINUX_BINARY_NAMES.join(", ")}`;
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
      `Konfigurierter Browser-Pfad (browserPath) existiert nicht: ${trimmedConfigured}. Korrigiere die Einstellung oder leere sie, damit orcode selbst sucht.`,
    );
  }
  const candidates = browserCandidates(deps);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  const shown = candidates.slice(0, 20);
  const more = candidates.length > shown.length ? `\n  … und ${candidates.length - shown.length} weitere` : "";
  throw new Error(
    [
      `Kein Browser gefunden (geprüft ${describeSearch(deps)}).`,
      shown.length > 0 ? `Geprüfte Pfade:\n${shown.map((path) => `  - ${path}`).join("\n")}${more}` : "",
      "Installiere Chrome, Edge, Chromium oder Brave, oder setze browserPath in der Konfiguration auf den Pfad einer ausführbaren Datei.",
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
  if (child.pid === undefined) {
    throw new Error(`Prozess ${executable} konnte nicht gestartet werden.`);
  }
  const pid = child.pid;
  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
    child.once("error", () => resolvePromise());
  });
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
 * Killing the OS process alone does not make a `body` that is stuck awaiting
 * a promise (e.g. a CDP call whose response never arrives) return — so this
 * races `body` itself against the timeout, not just the process. `body`'s
 * promise is allowed to keep running in the background after the race is
 * decided (`CdpClient` rejects its own pending calls once the socket closes,
 * so it settles eventually); `Promise.race` already attaches a rejection
 * handler to it, so a late rejection there never surfaces as an unhandled
 * rejection.
 */
export async function runWithHardTimeout<T>(
  proc: ManagedProcess,
  timeoutMs: number,
  body: (deadline: number) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Zeitlimit von ${(timeoutMs / 1_000).toFixed(0)}s erreicht.`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([body(deadline), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), PROCESS_KILL_GRACE_MS);
    killer.unref();
    await Promise.race([proc.exited, delay(PROCESS_KILL_GRACE_MS + 200)]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
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
          rejectPromise(new Error("Kein freier Port gefunden."));
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Chrome's HTTP debug endpoint (`/json/version`, `/json/new`, `/json/close`)
// ---------------------------------------------------------------------------

export type FetchFn = typeof fetch;

async function waitForDevtoolsHttp(port: number, fetchFn: FetchFn, deadline: number): Promise<void> {
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetchFn(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `Chrome-DevTools-Endpunkt auf Port ${port} antwortet nicht (${lastError || "Zeitlimit"}).`,
  );
}

interface DevtoolsTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

async function openNewTab(port: number, fetchFn: FetchFn): Promise<DevtoolsTarget> {
  const response = await fetchFn(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Neuer Chrome-Tab konnte nicht geöffnet werden (HTTP ${response.status}).`);
  }
  const data: unknown = await response.json();
  const id = isRecord(data) && typeof data.id === "string" ? data.id : "";
  const webSocketDebuggerUrl =
    isRecord(data) && typeof data.webSocketDebuggerUrl === "string" ? data.webSocketDebuggerUrl : "";
  if (!webSocketDebuggerUrl) {
    throw new Error("Chrome hat keine DevTools-WebSocket-URL für den neuen Tab geliefert.");
  }
  return { id, webSocketDebuggerUrl };
}

async function closeTab(port: number, fetchFn: FetchFn, id: string): Promise<void> {
  if (!id) {
    return;
  }
  await fetchFn(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => undefined);
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
      this.#ws.addEventListener("error", () => rejectPromise(new Error("CDP-WebSocket-Verbindung fehlgeschlagen.")));
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
        call.reject(new Error("CDP-Verbindung geschlossen."));
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
        pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "CDP-Fehler"));
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
  return typeof value.type === "string" ? `<${value.type}>` : "<unbekannt>";
}

export function consoleMessageFromParams(params: Record<string, unknown>): ConsoleMessageReport {
  const level = typeof params.type === "string" ? params.type : "log";
  const args = Array.isArray(params.args) ? params.args : [];
  const text = args.map(describeRemoteObject).join(" ").trim();
  return { level, text: text || "(leer)" };
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
  /** Pre-resolved executable; when unset, `findBrowserExecutable` searches. */
  browserPath?: string;
  /** Base directory for the temporary profile and screenshot file. Defaults to `os.tmpdir()`. */
  tempDir?: string;
  deps?: InspectUrlDeps;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export async function inspectUrl(options: InspectUrlOptions): Promise<PageReport> {
  const deps = options.deps ?? {};
  const fetchFn = deps.fetchFn ?? fetch;
  const wsFactory = deps.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const waitMs = options.waitMs ?? 500;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const captureScreenshot = options.captureScreenshot ?? true;
  const tempRoot = options.tempDir ?? tmpdir();

  const executable =
    options.browserPath ?? (await findBrowserExecutable(undefined, deps));
  const profileDir = await mkdtemp(join(tempRoot, "orcode-browser-profile-"));
  const port = deps.findPort ? await deps.findPort() : await findFreePort();

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

  try {
    return await runWithHardTimeout(proc, options.timeoutMs, async (deadline) => {
      await waitForDevtoolsHttp(port, fetchFn, deadline);
      const target = await openNewTab(port, fetchFn);
      const session = new CdpClient(target.webSocketDebuggerUrl, wsFactory);
      try {
        await session.waitOpen();

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

        await session.send("Page.enable");
        await session.send("Network.enable");
        await session.send("Runtime.enable");

        const navigationStart = Date.now();
        await session.send("Page.navigate", { url: options.url });
        const loaded = await session.waitForEvent("Page.loadEventFired", remaining(deadline));
        if (!loaded) {
          truncated = true;
          pageErrors.push(
            "Kein load-Ereignis innerhalb des Zeitlimits — der Bericht zeigt den Zustand zum Abbruchzeitpunkt.",
          );
        }
        if (waitMs > 0) {
          await delay(Math.min(waitMs, remaining(deadline)));
        }
        const loadTimeMs = Date.now() - navigationStart;

        const title = await readTitle(session);

        let screenshotPath: string | null = null;
        if (captureScreenshot) {
          screenshotPath = await captureScreenshotToFile(session, tempRoot, Boolean(options.fullPage));
        }

        return {
          url: options.url,
          title,
          screenshotPath,
          consoleMessages,
          pageErrors,
          failedRequests,
          loadTimeMs,
          truncated,
        };
      } finally {
        await closeTab(port, fetchFn, target.id).catch(() => undefined);
        session.close();
      }
    });
  } finally {
    // `runWithHardTimeout` already guarantees the process group is dead
    // (and `proc.exited` settled) by the time it returns or throws, on
    // every path including its own timeout — nothing left to kill here.
    // Best-effort cleanup: a leftover temp profile dir is not worth failing
    // the whole inspection over.
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function readTitle(session: CdpClient): Promise<string> {
  try {
    const result = await session.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    if (isRecord(result) && isRecord(result.result) && typeof result.result.value === "string") {
      return result.result.value;
    }
  } catch {
    // No title is not fatal — the rest of the report still stands.
  }
  return "";
}

async function captureScreenshotToFile(
  session: CdpClient,
  tempRoot: string,
  fullPage: boolean,
): Promise<string | null> {
  try {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) {
      const metrics = await session.send("Page.getLayoutMetrics");
      const contentSize = isRecord(metrics) ? metrics.contentSize : null;
      if (isRecord(contentSize) && typeof contentSize.width === "number" && typeof contentSize.height === "number") {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
      }
    }
    const shot = await session.send("Page.captureScreenshot", params);
    if (!isRecord(shot) || typeof shot.data !== "string") {
      return null;
    }
    const path = join(tempRoot, `orcode-browser-screenshot-${randomUUID()}.png`);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    return path;
  } catch {
    return null;
  }
}
