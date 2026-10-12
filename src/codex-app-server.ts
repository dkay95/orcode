import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { CODEX_APP_SERVER_RUNTIME_POLICY } from "./backends.js";
import { assertCodexHomePolicy, type CodexProfileRuntime } from "./codex-profile.js";
import { CODEX_PASSIVE_NOTIFICATION_METHODS, validCodexPassiveNotification } from "./codex-passive-notifications.js";

const FIXED_CODEX_CANDIDATES = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] as const;
const WRAPPER_SUFFIX = "/node_modules/@openai/codex/bin/codex.js";
const PLATFORM_PACKAGE_RELATIVE = "node_modules/@openai/codex-darwin-arm64";
const PAYLOAD_RELATIVE = "vendor/aarch64-apple-darwin/bin/codex";
const MAX_PROVENANCE_FILE_BYTES = 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const PROCESS_EXIT_GRACE_MS = 1_000;
const PROCESS_DRAIN_BOUND_MS = (PROCESS_EXIT_GRACE_MS * 3) + 250;
const CODEX_NOTIFICATION_METHODS = new Set([
  "account/updated", "account/login/completed", "thread/started", "turn/started", "item/agentMessage/delta",
  "item/started", "item/fileChange/patchUpdated", "item/completed", "turn/completed", "error",
  ...CODEX_PASSIVE_NOTIFICATION_METHODS,
]);

export const CODEX_APP_SERVER_ARGV = Object.freeze([
  "app-server",
  "--stdio",
  "--disable",
  "plugins",
  "--disable",
  "apps",
] as const);

interface PathIdentity {
  readonly lexicalPath: string;
  readonly realpath: string;
  readonly kind: "file" | "symlink";
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface ProvenanceFileIdentity {
  readonly realpath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly sha256: string;
}

interface CodexExecutableProvenance {
  readonly selected: PathIdentity;
  readonly payload: ProvenanceFileIdentity;
  readonly wrapper: ProvenanceFileIdentity | null;
  readonly packageMetadata: ProvenanceFileIdentity | null;
  readonly platformPackageMetadata: ProvenanceFileIdentity | null;
}

export interface CodexExecutableIdentity {
  readonly selectedPath: string;
  readonly selectedRealpath: string;
  readonly payloadRealpath: string;
  readonly packageRootRealpath: string | null;
  readonly packageMetadataSha256: string | null;
  readonly platformPackageMetadataSha256: string | null;
  readonly wrapperSha256: string | null;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly sha256: string;
  readonly machO: true;
  readonly teamIdentifier: "2DC432GLL2";
  readonly version: "codex-cli 0.142.5";
  readonly provenance: CodexExecutableProvenance;
}

export interface CodexAppServerLaunchPlan {
  readonly profile: CodexProfileRuntime;
  readonly executable: CodexExecutableIdentity;
  readonly argv: typeof CODEX_APP_SERVER_ARGV;
  readonly env: Readonly<Record<string, string>>;
}

/** Internal JSONL seam. Product callers always use the default process transport. */
export interface CodexAppServerTransport {
  writeLine(line: string): Promise<void>;
  readLine(signal?: AbortSignal): Promise<string | null>;
  close(): void;
  drain(): Promise<"closed" | "killed">;
}

/** @internal Constructor injection exists for the fake protocol harness only. */
export type CodexAppServerTransportFactory = (
  launch: CodexAppServerLaunchPlan,
  signal?: AbortSignal,
) => Promise<CodexAppServerTransport>;

type RequestId = number;
export type CodexAppServerRequestId = string | number;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}

export type CodexAppServerNotificationListener = (params: unknown) => void | Promise<void>;
export type CodexAppServerTerminalListener = (error: Error) => void | Promise<void>;
export type CodexAppServerRequestListener = (request: Readonly<{
  id: CodexAppServerRequestId;
  method: string;
  params: unknown;
}>) => void | Promise<void>;


export async function resolveOfficialCodexPayload(
  explicitlyConfiguredPath?: string,
): Promise<CodexExecutableIdentity> {
  requireSupportedHost();
  if (explicitlyConfiguredPath !== undefined) {
    if (!isAbsolute(explicitlyConfiguredPath)) {
      throw trustFailure("an explicitly configured executable path must be absolute");
    }
    return resolveCandidate(resolve(explicitlyConfiguredPath), true);
  }

  const failures: Error[] = [];
  for (const candidate of FIXED_CODEX_CANDIDATES) {
    try {
      return await resolveCandidate(candidate, false);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) failures.push(asError(error));
    }
  }
  const detail = failures[0]?.message.replace(/^Trusted signed Codex payload rejected:\s*/i, "")
    ?? "no fixed trusted executable candidate exists";
  throw trustFailure(detail);
}

export async function createCodexAppServerLaunchPlan(
  profile: CodexProfileRuntime,
  executable: CodexExecutableIdentity,
): Promise<CodexAppServerLaunchPlan> {
  await assertCodexHomePolicy(profile.codexHome);
  const env = Object.freeze({
    CODEX_HOME: profile.codexHome,
    HOME: profile.codexHome,
  });
  return Object.freeze({
    profile: Object.freeze({ binding: profile.binding, codexHome: profile.codexHome }),
    executable,
    argv: CODEX_APP_SERVER_ARGV,
    env,
  });
}

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export class CodexAppServerClient {
  readonly #launch: CodexAppServerLaunchPlan;
  readonly #transportFactory: CodexAppServerTransportFactory;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Map<string, Set<CodexAppServerNotificationListener>>();
  readonly #terminalListeners = new Set<CodexAppServerTerminalListener>();
  #requestListener: CodexAppServerRequestListener | null = null;
  readonly #serverRequestStates = new Map<CodexAppServerRequestId, "pending" | "responding" | "responded">();
  readonly #queuedServerRequests: Array<Readonly<{
    id: CodexAppServerRequestId;
    method: string;
    params: unknown;
  }>> = [];
  #requestDeliveryRunning = false;
  #state: "new" | "starting" | "ready" | "closed" = "new";
  #transport: CodexAppServerTransport | null = null;
  #pump: Promise<void> | null = null;
  readonly #pumpAbort = new AbortController();
  #writeTail: Promise<void> = Promise.resolve();
  #nextRequestId = 0;
  #terminalError: Error | null = null;
  #terminalNotified = false;
  #drainPromise: Promise<"closed" | "killed"> | null = null;

  constructor(
    launch: CodexAppServerLaunchPlan,
    transportFactory: CodexAppServerTransportFactory = spawnCodexAppServerTransport,
  ) {
    this.#launch = launch;
    this.#transportFactory = transportFactory;
  }

  /** Closed/drained clients must never be reused for a new profile operation. */
  get isReady(): boolean {
    return this.#state === "ready";
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#state !== "new") {
      throw new Error(this.#state === "ready" ? "Codex App Server is already initialized." : "Codex App Server cannot be started twice.");
    }
    throwIfAborted(signal);
    this.#state = "starting";
    try {
      validateLaunchPlan(this.#launch);
      await assertCodexHomePolicy(this.#launch.profile.codexHome);
      await revalidateExecutableIdentity(this.#launch.executable);
      await assertCodexHomePolicy(this.#launch.profile.codexHome);
      await revalidateExecutableIdentity(this.#launch.executable);
      throwIfAborted(signal);
      this.#transport = await this.#transportFactory(this.#launch, signal);
      throwIfAborted(signal);
      this.#pump = this.#readPump();
      const response = await this.#requestInternal("initialize", {
        clientInfo: { name: "orcode", title: "Orcode", version: "0.7.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, signal);
      validateInitializeResponse(response, this.#launch.profile.codexHome);
      await this.#write({ method: "initialized", params: {} });
      this.#state = "ready";
    } catch (error) {
      const failure = asError(error);
      this.#failClosed(failure);
      await this.#drainTransport();
      throw failure;
    }
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    this.#requireReady();
    validatePublicMethod(method);
    return this.#requestInternal(method, params, signal) as Promise<T>;
  }

  /** Executes the authority check in the serialized write queue immediately before stdin. */
  async requestGuarded<T>(
    method: string,
    params: unknown,
    guard: () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#requireReady();
    validatePublicMethod(method);
    if (typeof guard !== "function") throw new Error("Invalid Codex App Server write guard.");
    return this.#requestInternal(method, params, signal, guard) as Promise<T>;
  }

  notify(method: string, params: unknown = {}): void {
    this.#requireReady();
    validatePublicMethod(method);
    void this.#write({ method, params }).catch((error) => this.#failClosed(asError(error)));
  }

  onNotification(
    method: string,
    listener: CodexAppServerNotificationListener,
  ): () => void {
    if (!CODEX_NOTIFICATION_METHODS.has(method) || typeof listener !== "function") {
      throw new Error("Invalid Codex App Server notification listener.");
    }
    const listeners = this.#notificationListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#notificationListeners.delete(method);
    };
  }

  onServerRequest(listener: CodexAppServerRequestListener): () => void {
    this.#requireReady();
    if (typeof listener !== "function") throw new Error("Invalid Codex App Server request listener.");
    if (this.#requestListener !== null) throw new Error("Codex App Server request listener is already attached.");
    this.#requestListener = listener;
    this.#scheduleServerRequestDelivery();
    return () => {
      if (this.#requestListener === listener) this.#requestListener = null;
    };
  }

  onTerminal(listener: CodexAppServerTerminalListener): () => void {
    this.#requireReady();
    if (typeof listener !== "function") throw new Error("Invalid Codex App Server terminal listener.");
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  async respondToServerRequest(
    id: CodexAppServerRequestId,
    result: unknown,
    guard?: () => void,
  ): Promise<void> {
    this.#requireReady();
    if (guard !== undefined && typeof guard !== "function") {
      throw new Error("Invalid Codex App Server response write guard.");
    }
    if (!isServerRequestId(id) || this.#serverRequestStates.get(id) !== "pending") {
      const failure = new Error("Codex App Server request id is unknown, already responding, or already responded.");
      this.#failClosed(failure);
      throw failure;
    }
    this.#serverRequestStates.set(id, "responding");
    try {
      await this.#write({ id, result }, guard);
      this.#serverRequestStates.set(id, "responded");
    } catch (error) {
      const failure = asError(error);
      this.#failClosed(failure);
      throw failure;
    }
  }


  drain(): Promise<"closed" | "killed"> {
    this.#state = "closed";
    return this.#drainTransport();
  }

  async #requestInternal(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    guard?: () => void,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        const failure = abortError(signal);
        this.#pending.delete(id);
        this.#failClosed(failure);
        rejectPromise(failure);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      });
    });
    void response.catch(() => undefined);
    try {
      await this.#write({ method, id, params }, guard);
    } catch (error) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.detachAbort();
      const failure = asError(error);
      pending?.reject(failure);
      this.#failClosed(failure);
    }
    return response;
  }

  #write(frame: unknown, guard?: () => void): Promise<void> {
    if (this.#transport === null) return Promise.reject(new Error("Codex App Server transport is not initialized."));
    let line: string;
    try {
      line = JSON.stringify(frame);
    } catch {
      return Promise.reject(new Error("Codex App Server request is not JSON serializable."));
    }
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      return Promise.reject(new Error("Codex App Server request exceeds the protocol limit."));
    }
    const operation = this.#writeTail.then(() => {
      guard?.();
      return this.#transport!.writeLine(line);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  async #readPump(): Promise<void> {
    try {
      for (;;) {
        const line = await this.#transport!.readLine(this.#pumpAbort.signal);
        if (line === null) throw new Error("Codex App Server closed before the protocol was drained.");
        if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
          throw protocolFailure("malformed JSON-RPC line exceeds the size limit");
        }
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          throw protocolFailure("malformed JSON-RPC received");
        }
        await this.#dispatchFrame(frame);
      }
    } catch (error) {
      if (this.#state !== "closed") this.#failClosed(asError(error));
    }
  }

  async #dispatchFrame(frame: unknown): Promise<void> {
    if (!isPlainRecord(frame)) throw protocolFailure("unknown JSON-RPC form received");
    const keys = Object.keys(frame).sort();
    if (!Object.hasOwn(frame, "id")) {
      if (!sameStrings(keys, ["method", "params"])
        || typeof frame.method !== "string" || !CODEX_NOTIFICATION_METHODS.has(frame.method)) {
        throw protocolFailure("unknown JSON-RPC notification or request received");
      }
      if (frame.method === "account/login/completed" && !isLoginCompletedNotification(frame.params)) {
        throw protocolFailure("invalid login completion notification");
      }
      if ((CODEX_PASSIVE_NOTIFICATION_METHODS as readonly string[]).includes(frame.method)
        && !validCodexPassiveNotification(frame.method, frame.params)) {
        throw protocolFailure("invalid passive notification");
      }
      for (const listener of this.#notificationListeners.get(frame.method) ?? []) {
        try {
          await listener(frame.params);
        } catch (error) {
          throw protocolFailure(`notification listener rejected ${frame.method}: ${asError(error).message}`);
        }
      }
      return;
    }
    if (Object.hasOwn(frame, "method")) {
      const id = frame.id;
      if (!sameStrings(keys, ["id", "method", "params"]) || typeof frame.method !== "string"
        || frame.method.length === 0 || !isServerRequestId(id)
        || this.#serverRequestStates.has(id)) {
        throw protocolFailure("unknown JSON-RPC server request or duplicate id");
      }
      this.#serverRequestStates.set(id, "pending");
      const request = Object.freeze({ id, method: frame.method, params: frame.params });
      if (this.#queuedServerRequests.length >= 32) throw protocolFailure("too many unclaimed JSON-RPC server requests");
      this.#queuedServerRequests.push(request);
      this.#scheduleServerRequestDelivery();
      return;
    }
    const id = frame.id;
    if (!Number.isSafeInteger(id) || typeof id !== "number") {
      throw protocolFailure("malformed JSON-RPC response id");
    }
    const pending = this.#pending.get(id);
    if (!pending) throw protocolFailure("unknown JSON-RPC response id");

    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (hasResult === hasError) throw protocolFailure("malformed JSON-RPC response result");
    const expectedKeys = hasResult ? ["id", "result"] : ["error", "id"];
    if (!sameStrings(keys, expectedKeys)) throw protocolFailure("unknown JSON-RPC response field");

    this.#pending.delete(id);
    pending.detachAbort();
    if (hasResult) {
      pending.resolve(frame.result);
      return;
    }
    if (!isPlainRecord(frame.error)
      || !Number.isSafeInteger(frame.error.code)
      || typeof frame.error.message !== "string"
      || !sameStrings(Object.keys(frame.error).sort(), Object.hasOwn(frame.error, "data")
        ? ["code", "data", "message"]
        : ["code", "message"])) {
      pending.reject(protocolFailure("malformed JSON-RPC error response"));
      this.#failClosed(protocolFailure("malformed JSON-RPC error response"));
      return;
    }
    pending.reject(new CodexAppServerRpcError(frame.error.code as number, frame.error.message, frame.error.data));
  }

  #requireReady(): void {
    if (this.#state !== "ready") {
      if (this.#terminalError) throw this.#terminalError;
      throw new Error("Codex App Server is not initialized.");
    }
  }

  #failClosed(error: Error): void {
    if (this.#terminalError === null) this.#terminalError = error;
    this.#state = "closed";
    this.#requestListener = null;
    if (!this.#terminalNotified) {
      this.#terminalNotified = true;
      for (const listener of this.#terminalListeners) {
        Promise.resolve().then(() => listener(this.#terminalError!)).catch(() => undefined);
      }
    }
    this.#rejectPending(this.#terminalError);
    this.#transport?.close();
    if (this.#transport !== null) {
      void this.#drainTransport(false).catch(() => undefined);
    }
  }

  #scheduleServerRequestDelivery(): void {
    if (this.#requestDeliveryRunning || this.#requestListener === null
      || this.#queuedServerRequests.length === 0 || this.#state !== "ready") return;
    this.#requestDeliveryRunning = true;
    queueMicrotask(() => { void this.#deliverServerRequests(); });
  }

  async #deliverServerRequests(): Promise<void> {
    try {
      while (this.#state === "ready" && this.#requestListener !== null
        && this.#queuedServerRequests.length > 0) {
        const request = this.#queuedServerRequests.shift()!;
        await this.#requestListener(request);
      }
    } catch (error) {
      this.#failClosed(protocolFailure(`server request listener rejected: ${asError(error).message}`));
    } finally {
      this.#requestDeliveryRunning = false;
      this.#scheduleServerRequestDelivery();
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.detachAbort();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #drainTransport(flushAcceptedWrites = true): Promise<"closed" | "killed"> {
    if (this.#drainPromise) return this.#drainPromise;
    if (this.#transport === null) return Promise.resolve("closed");
    this.#drainPromise = (async () => {
      if (flushAcceptedWrites) {
        await settleWithin(this.#writeTail.catch(() => undefined), PROCESS_EXIT_GRACE_MS);
      }
      this.#transport!.close();
      let result: "closed" | "killed" | null = null;
      let drainFailure: Error | null = null;
      try {
        result = await settleWithin(this.#transport!.drain(), PROCESS_DRAIN_BOUND_MS);
        if (result === null) throw new Error("Codex App Server exceeded the process shutdown bound.");
      } catch (error) {
        drainFailure = asError(error);
      }
      this.#pumpAbort.abort(new Error("Codex App Server read pump stopped during drain."));
      await this.#pump?.catch(() => undefined);
      this.#rejectPending(this.#terminalError ?? new Error("Codex App Server is closed."));
      let policyFailure: Error | null = null;
      try {
        await assertCodexHomePolicy(this.#launch.profile.codexHome);
      } catch (error) {
        policyFailure = asError(error);
      }
      if (drainFailure !== null) throw drainFailure;
      if (policyFailure !== null) throw policyFailure;
      return result!;
    })();
    return this.#drainPromise;
  }
}


async function resolveCandidate(selectedPath: string, explicit: boolean): Promise<CodexExecutableIdentity> {
  const selected = await inspectSelectedPath(selectedPath, explicit);
  const selectedRealpath = selected.realpath;
  if (selectedRealpath.endsWith(WRAPPER_SUFFIX)) {
    return resolveWrapper(selectedPath, selected);
  }
  if (selected.kind !== "file" || selected.lexicalPath !== selected.realpath) {
    throw trustFailure("a direct candidate must itself be a regular Mach-O file");
  }
  const payload = await inspectProvenanceFile(selectedRealpath, "Codex native payload");
  const verified = await verifyNativePayload(payload);
  return freezeExecutableIdentity({
    selectedPath,
    selectedRealpath,
    payload,
    packageRootRealpath: null,
    packageMetadata: null,
    platformPackageMetadata: null,
    wrapper: null,
    selected,
    teamIdentifier: verified.teamIdentifier,
    version: verified.version,
  });
}

async function resolveWrapper(selectedPath: string, selected: PathIdentity): Promise<CodexExecutableIdentity> {
  const wrapperRealpath = selected.realpath;
  const packageRoot = dirname(dirname(wrapperRealpath));
  if (`${packageRoot}/bin/codex.js` !== wrapperRealpath
    || await realpath(packageRoot) !== packageRoot
    || !packageRoot.endsWith("/node_modules/@openai/codex")) {
    throw trustFailure("the npm wrapper is outside the canonical @openai/codex package root");
  }

  const wrapper = await inspectProvenanceFile(wrapperRealpath, "Codex npm wrapper");
  const packageMetadataPath = join(packageRoot, "package.json");
  const packageMetadata = await inspectProvenanceFile(packageMetadataPath, "Codex package metadata", MAX_PROVENANCE_FILE_BYTES);
  const packageDocument = await readPinnedJson(packageMetadataPath, packageMetadata, "Codex package metadata");
  requireMainPackage(packageDocument);

  const platformPackageRoot = join(packageRoot, PLATFORM_PACKAGE_RELATIVE);
  if (await realpath(platformPackageRoot) !== platformPackageRoot) {
    throw trustFailure("the native platform package is not canonical");
  }
  const platformPackageMetadataPath = join(platformPackageRoot, "package.json");
  const platformPackageMetadata = await inspectProvenanceFile(
    platformPackageMetadataPath,
    "Codex platform package metadata",
    MAX_PROVENANCE_FILE_BYTES,
  );
  const platformDocument = await readPinnedJson(
    platformPackageMetadataPath,
    platformPackageMetadata,
    "Codex platform package metadata",
  );
  requirePlatformPackage(platformDocument);

  const payloadPath = join(platformPackageRoot, PAYLOAD_RELATIVE);
  if (await realpath(payloadPath) !== payloadPath) {
    throw trustFailure("the native payload is not canonical within its platform package");
  }
  const payload = await inspectProvenanceFile(payloadPath, "Codex native payload");
  const verified = await verifyNativePayload(payload);
  return freezeExecutableIdentity({
    selectedPath,
    selectedRealpath: wrapperRealpath,
    payload,
    packageRootRealpath: packageRoot,
    packageMetadata,
    platformPackageMetadata,
    wrapper,
    selected,
    teamIdentifier: verified.teamIdentifier,
    version: verified.version,
  });
}

async function inspectSelectedPath(path: string, explicit: boolean): Promise<PathIdentity> {
  const lexicalPath = resolve(path);
  const before = await lstat(lexicalPath, { bigint: true });
  const kind = before.isSymbolicLink() ? "symlink" : before.isFile() ? "file" : null;
  if (kind === null) throw trustFailure("the selected candidate is not a file");
  if (kind === "symlink" && (explicit && !FIXED_CODEX_CANDIDATES.includes(lexicalPath as never))) {
    throw trustFailure("an explicitly configured direct candidate must not be a symlink");
  }
  requireSafeOwner(before, "selected Codex candidate");
  if (kind === "file") requireSafeModeAndLinks(before, "selected Codex candidate");
  const canonical = await realpath(lexicalPath);
  const after = await lstat(lexicalPath, { bigint: true });
  requireSameStat(before, after, "selected Codex candidate changed during canonicalization");
  return Object.freeze({
    lexicalPath,
    realpath: canonical,
    kind,
    device: before.dev,
    inode: before.ino,
    uid: before.uid,
    mode: before.mode,
    nlink: before.nlink,
    size: before.size,
    mtimeNs: before.mtimeNs,
  });
}

async function inspectProvenanceFile(
  path: string,
  label: string,
  maximumBytes?: number,
): Promise<ProvenanceFileIdentity> {
  const canonical = await realpath(path);
  if (canonical !== path) throw trustFailure(`${label} must not traverse a symlink`);
  const before = await lstat(path, { bigint: true });
  requireRegularSafeFile(before, label);
  if (maximumBytes !== undefined && before.size > BigInt(maximumBytes)) {
    throw trustFailure(`${label} exceeds the maximum size`);
  }
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    requireRegularSafeFile(opened, label);
    requireSameStat(before, opened, `${label} changed while opening`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    const afterRead = await handle.stat({ bigint: true });
    requireSameStat(opened, afterRead, `${label} changed while hashing`);
    const afterPath = await lstat(path, { bigint: true });
    requireSameStat(opened, afterPath, `${label} path changed while hashing`);
    return Object.freeze({
      realpath: canonical,
      device: opened.dev,
      inode: opened.ino,
      uid: opened.uid,
      mode: opened.mode,
      nlink: opened.nlink,
      size: opened.size,
      mtimeNs: opened.mtimeNs,
      sha256: hash.digest("hex"),
    });
  } catch (error) {
    if (error instanceof Error && /^Trusted signed Codex payload rejected:/i.test(error.message)) throw error;
    throw trustFailure(`${label} could not be bound to one stable file identity`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readPinnedJson(
  path: string,
  expected: ProvenanceFileIdentity,
  label: string,
): Promise<Record<string, unknown>> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    requireIdentity(expected, fileIdentityFromStat(path, before, expected.sha256), `${label} changed before parsing`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    requireSameStat(before, after, `${label} changed while parsing`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected.sha256) throw trustFailure(`${label} changed while parsing`);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isPlainRecord(parsed)) throw trustFailure(`${label} is not a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /^Trusted signed Codex payload rejected:/i.test(error.message)) throw error;
    throw trustFailure(`${label} is not valid pinned JSON`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function requireMainPackage(document: Record<string, unknown>): void {
  if (document.name !== "@openai/codex" || document.version !== CODEX_APP_SERVER_RUNTIME_POLICY.cliVersion) {
    throw trustFailure("Codex package version does not match 0.142.5");
  }
  if (!isPlainRecord(document.bin) || document.bin.codex !== "bin/codex.js") {
    throw trustFailure("Codex package wrapper metadata is not official");
  }
  if (!isPlainRecord(document.optionalDependencies)
    || document.optionalDependencies["@openai/codex-darwin-arm64"] !== "npm:@openai/codex@0.142.5-darwin-arm64") {
    throw trustFailure("Codex package platform provenance does not match 0.142.5");
  }
}

function requirePlatformPackage(document: Record<string, unknown>): void {
  if (document.name !== "@openai/codex" || document.version !== "0.142.5-darwin-arm64") {
    throw trustFailure("Codex platform package version does not match 0.142.5-darwin-arm64");
  }
  if (!Array.isArray(document.os) || document.os.length !== 1 || document.os[0] !== "darwin"
    || !Array.isArray(document.cpu) || document.cpu.length !== 1 || document.cpu[0] !== "arm64") {
    throw trustFailure("Codex platform package target is not darwin-arm64");
  }
}

async function verifyNativePayload(
  payload: ProvenanceFileIdentity,
): Promise<{ readonly teamIdentifier: "2DC432GLL2"; readonly version: "codex-cli 0.142.5" }> {
  const handle = await open(payload.realpath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength || !isArm64MachO(header)) {
      throw trustFailure("Codex native payload is not an arm64 Mach-O executable");
    }
    const after = await handle.stat({ bigint: true });
    requireIdentity(payload, fileIdentityFromStat(payload.realpath, after, payload.sha256), "Codex payload changed during Mach-O validation");
  } finally {
    await handle.close().catch(() => undefined);
  }

  await runClosed("/usr/bin/codesign", ["--verify", "--strict", payload.realpath], "Codex payload signature verification failed");
  const signature = await runClosed(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", payload.realpath],
    "Codex payload signer inspection failed",
  );
  const team = /^TeamIdentifier=(.+)$/m.exec(`${signature.stdout}\n${signature.stderr}`)?.[1]?.trim();
  if (team !== CODEX_APP_SERVER_RUNTIME_POLICY.teamIdentifier) {
    throw trustFailure("Codex payload TeamIdentifier is not the OpenAI team 2DC432GLL2");
  }
  const version = await runClosed(payload.realpath, ["--version"], "Codex payload version inspection failed");
  if (version.stdout.trim() !== CODEX_APP_SERVER_RUNTIME_POLICY.versionOutput || version.stderr.trim() !== "") {
    throw trustFailure("Codex payload version is not codex-cli 0.142.5");
  }
  const after = await inspectProvenanceFile(payload.realpath, "Codex native payload");
  requireIdentity(payload, after, "Codex payload changed during signature or version validation");
  return {
    teamIdentifier: CODEX_APP_SERVER_RUNTIME_POLICY.teamIdentifier,
    version: CODEX_APP_SERVER_RUNTIME_POLICY.versionOutput,
  };
}

function freezeExecutableIdentity(input: {
  readonly selectedPath: string;
  readonly selectedRealpath: string;
  readonly payload: ProvenanceFileIdentity;
  readonly packageRootRealpath: string | null;
  readonly packageMetadata: ProvenanceFileIdentity | null;
  readonly platformPackageMetadata: ProvenanceFileIdentity | null;
  readonly wrapper: ProvenanceFileIdentity | null;
  readonly selected: PathIdentity;
  readonly teamIdentifier: "2DC432GLL2";
  readonly version: "codex-cli 0.142.5";
}): CodexExecutableIdentity {
  return Object.freeze({
    selectedPath: input.selectedPath,
    selectedRealpath: input.selectedRealpath,
    payloadRealpath: input.payload.realpath,
    packageRootRealpath: input.packageRootRealpath,
    packageMetadataSha256: input.packageMetadata?.sha256 ?? null,
    platformPackageMetadataSha256: input.platformPackageMetadata?.sha256 ?? null,
    wrapperSha256: input.wrapper?.sha256 ?? null,
    device: input.payload.device,
    inode: input.payload.inode,
    size: input.payload.size,
    mtimeNs: input.payload.mtimeNs,
    sha256: input.payload.sha256,
    machO: true,
    teamIdentifier: input.teamIdentifier,
    version: input.version,
    provenance: Object.freeze({
      selected: input.selected,
      payload: input.payload,
      wrapper: input.wrapper,
      packageMetadata: input.packageMetadata,
      platformPackageMetadata: input.platformPackageMetadata,
    }),
  });
}

async function revalidateExecutableIdentity(expected: CodexExecutableIdentity): Promise<void> {
  let current: CodexExecutableIdentity;
  try {
    current = await resolveOfficialCodexPayload(expected.selectedPath);
  } catch (error) {
    throw trustFailure(`executable provenance changed before spawn: ${safeTrustDetail(error)}`);
  }
  if (!sameExecutableIdentity(expected, current)) {
    throw trustFailure("executable provenance changed before spawn");
  }
}

function sameExecutableIdentity(left: CodexExecutableIdentity, right: CodexExecutableIdentity): boolean {
  return left.selectedPath === right.selectedPath
    && left.selectedRealpath === right.selectedRealpath
    && left.payloadRealpath === right.payloadRealpath
    && left.packageRootRealpath === right.packageRootRealpath
    && left.packageMetadataSha256 === right.packageMetadataSha256
    && left.platformPackageMetadataSha256 === right.platformPackageMetadataSha256
    && left.wrapperSha256 === right.wrapperSha256
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.sha256 === right.sha256
    && left.teamIdentifier === right.teamIdentifier
    && left.version === right.version
    && samePathIdentity(left.provenance.selected, right.provenance.selected)
    && sameOptionalFileIdentity(left.provenance.payload, right.provenance.payload)
    && sameOptionalFileIdentity(left.provenance.wrapper, right.provenance.wrapper)
    && sameOptionalFileIdentity(left.provenance.packageMetadata, right.provenance.packageMetadata)
    && sameOptionalFileIdentity(left.provenance.platformPackageMetadata, right.provenance.platformPackageMetadata);
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.lexicalPath === right.lexicalPath
    && left.realpath === right.realpath
    && left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameOptionalFileIdentity(
  left: ProvenanceFileIdentity | null,
  right: ProvenanceFileIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  try {
    requireIdentity(left, right, "identity mismatch");
    return true;
  } catch {
    return false;
  }
}

async function spawnCodexAppServerTransport(
  launch: CodexAppServerLaunchPlan,
  signal?: AbortSignal,
): Promise<CodexAppServerTransport> {
  throwIfAborted(signal);
  const child = spawn(launch.executable.payloadRealpath, [...launch.argv], {
    cwd: launch.profile.codexHome,
    env: { ...launch.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const onError = () => {
      cleanup();
      rejectPromise(new Error("Trusted Codex App Server process could not start."));
    };
    const onAbort = () => {
      cleanup();
      child.kill("SIGTERM");
      rejectPromise(abortError(signal));
    };
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return new ChildJsonLineTransport(child);
}

class ChildJsonLineTransport implements CodexAppServerTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #queue: Array<string | null | Error> = [];
  readonly #waiters: Array<{ resolve: (value: string | null) => void; reject: (error: Error) => void }> = [];
  #buffer = "";
  #closed = false;
  #writeTail: Promise<void> = Promise.resolve();
  readonly #writeAbort = new AbortController();
  #exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#acceptChunk(chunk));
    child.stdout.once("end", () => {
      if (this.#buffer.length > 0) this.#enqueue(protocolFailure("malformed JSON-RPC trailing line"));
      this.#enqueue(null);
    });
    child.once("error", () => {
      const failure = new Error("Codex App Server process failed.");
      this.#abortWrites(failure);
      this.#enqueue(failure);
    });
    child.once("exit", () => this.#abortWrites(new Error("Codex App Server process exited.")));
    this.#exitPromise = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise((resolvePromise) => {
          child.once("exit", (code, signal) => resolvePromise({ code, signal }));
        });
  }

  writeLine(line: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server transport is closed."));
    const copy = `${line}\n`;
    const operation = this.#writeTail.then(async () => {
      if (this.#closed) throw new Error("Codex App Server transport is closed.");
      if (!this.#child.stdin.write(copy, "utf8")) {
        await onceEvent(this.#child.stdin, "drain", this.#writeAbort.signal);
      }
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  readLine(signal?: AbortSignal): Promise<string | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued instanceof Error ? Promise.reject(queued) : Promise.resolve(queued);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      let registered: { resolve: (value: string | null) => void; reject: (error: Error) => void } | null = null;
      const onAbort = () => {
        const index = registered === null ? -1 : this.#waiters.indexOf(registered);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectPromise(abortError(signal));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const wrapped = {
        resolve: (value: string | null) => {
          signal?.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", onAbort);
          rejectPromise(error);
        },
      };
      registered = wrapped;
      this.#waiters.push(wrapped);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortWrites(new Error("Codex App Server transport is closed."));
    this.#child.stdin.end();
  }

  async drain(): Promise<"closed" | "killed"> {
    this.close();
    let exited = await settleWithin(this.#exitPromise, PROCESS_EXIT_GRACE_MS);
    if (exited) return exited.signal === null ? "closed" : "killed";
    this.#child.kill("SIGTERM");
    exited = await settleWithin(this.#exitPromise, PROCESS_EXIT_GRACE_MS);
    if (exited) return "killed";
    this.#child.kill("SIGKILL");
    exited = await settleWithin(this.#exitPromise, PROCESS_EXIT_GRACE_MS);
    if (!exited) throw new Error("Codex App Server process did not exit after SIGKILL.");
    return "killed";
  }

  #acceptChunk(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES && !this.#buffer.includes("\n")) {
      this.#enqueue(protocolFailure("malformed JSON-RPC line exceeds the size limit"));
      this.close();
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#enqueue(line);
    }
  }

  #abortWrites(reason: Error): void {
    if (!this.#writeAbort.signal.aborted) this.#writeAbort.abort(reason);
  }

  #enqueue(value: string | null | Error): void {
    const waiter = this.#waiters.shift();
    if (!waiter) {
      this.#queue.push(value);
      return;
    }
    if (value instanceof Error) waiter.reject(value);
    else waiter.resolve(value);
  }
}

function validateLaunchPlan(launch: CodexAppServerLaunchPlan): void {
  if (!Array.isArray(launch.argv) || !sameStrings(launch.argv, CODEX_APP_SERVER_ARGV)) {
    throw new Error("Codex App Server launch plan has unsafe argv.");
  }
  if (!isPlainRecord(launch.env)
    || !sameStrings(Object.keys(launch.env).sort(), ["CODEX_HOME", "HOME"])
    || launch.env.CODEX_HOME !== launch.profile.codexHome
    || launch.env.HOME !== launch.profile.codexHome) {
    throw new Error("Codex App Server launch plan has an unsafe environment.");
  }
}

function validateInitializeResponse(result: unknown, codexHome: string): void {
  if (!isPlainRecord(result)
    || !sameStrings(Object.keys(result).sort(), ["codexHome", "platformFamily", "platformOs", "userAgent"])) {
    throw protocolFailure("unsupported initialize protocol shape or unknown field");
  }
  if (result.codexHome !== codexHome) throw protocolFailure("initialize response does not bind the expected CODEX_HOME profile");
  if (result.platformFamily !== "unix" || result.platformOs !== "macos") {
    throw protocolFailure("unsupported Codex App Server platform protocol");
  }
  if (typeof result.userAgent !== "string"
    || !/codex/i.test(result.userAgent)
    || !/(?:^|[^0-9])0\.142\.5(?:[^0-9]|$)/.test(result.userAgent)) {
    throw protocolFailure("unsupported Codex App Server protocol for required 0.142.5 runtime");
  }
}

function validatePublicMethod(method: string): void {
  if (method.length === 0 || method.length > 128 || /[\0\r\n]/.test(method)
    || method === "initialize" || method === "initialized") {
    throw new Error("Invalid Codex App Server method.");
  }
}

function requireSupportedHost(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw trustFailure("only the pinned darwin-arm64 runtime is supported");
  }
}

function requireRegularSafeFile(metadata: BigIntStats, label: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw trustFailure(`${label} is not a regular file`);
  requireSafeOwner(metadata, label);
  requireSafeModeAndLinks(metadata, label);
}

function requireSafeOwner(metadata: BigIntStats, label: string): void {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (metadata.uid !== 0n && metadata.uid !== currentUid) {
    throw trustFailure(`${label} is not owned by root or the current user`);
  }
}

function requireSafeModeAndLinks(metadata: BigIntStats, label: string): void {
  if ((metadata.mode & 0o022n) !== 0n) throw trustFailure(`${label} is group- or world-writable`);
  if (metadata.nlink !== 1n) throw trustFailure(`${label} must have exactly one filesystem link`);
}

function requireSameStat(left: BigIntStats, right: BigIntStats, detail: string): void {
  if (!right.isFile() && !right.isSymbolicLink()) throw trustFailure(detail);
  if (left.dev !== right.dev
    || left.ino !== right.ino
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.isFile() !== right.isFile()
    || left.isSymbolicLink() !== right.isSymbolicLink()) {
    throw trustFailure(detail);
  }
}

function requireIdentity(
  expected: ProvenanceFileIdentity,
  actual: ProvenanceFileIdentity,
  detail: string,
): void {
  if (expected.realpath !== actual.realpath
    || expected.device !== actual.device
    || expected.inode !== actual.inode
    || expected.uid !== actual.uid
    || expected.mode !== actual.mode
    || expected.nlink !== actual.nlink
    || expected.size !== actual.size
    || expected.mtimeNs !== actual.mtimeNs
    || expected.sha256 !== actual.sha256) {
    throw trustFailure(detail);
  }
}

function fileIdentityFromStat(
  path: string,
  metadata: BigIntStats,
  sha256: string,
): ProvenanceFileIdentity {
  return {
    realpath: path,
    device: metadata.dev,
    inode: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    sha256,
  };
}

function isArm64MachO(header: Buffer): boolean {
  return header[0] === 0xcf
    && header[1] === 0xfa
    && header[2] === 0xed
    && header[3] === 0xfe
    && header.readUInt32LE(4) === 0x0100000c;
}

function runClosed(
  executable: string,
  args: readonly string[],
  failureDetail: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      env: {},
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) rejectPromise(trustFailure(failureDetail));
      else resolvePromise({ stdout, stderr });
    });
  });
}

function protocolFailure(detail: string): Error {
  return new Error(`Codex App Server protocol failure: ${detail}.`);
}

function trustFailure(detail: string): Error {
  return new Error(`Trusted signed Codex payload rejected: ${detail}.`);
}

function safeTrustDetail(error: unknown): string {
  const message = asError(error).message;
  return message.replace(/^Trusted signed Codex payload rejected:\s*/i, "").replace(/[\r\n]/g, " ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLoginCompletedNotification(value: unknown): boolean {
  return isPlainRecord(value)
    && Object.hasOwn(value, "success") && Object.keys(value).every((key) => ["error", "loginId", "success"].includes(key))
    && (value.loginId == null || typeof value.loginId === "string"
      && value.loginId.length > 0 && value.loginId.length <= 256 && !/[\0\r\n]/.test(value.loginId))
    && typeof value.success === "boolean"
    && (value.error == null || typeof value.error === "string" && value.error.length <= 16_384)
    && (!value.success || value.error == null);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isServerRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string"
    || typeof value === "number" && Number.isSafeInteger(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("The Codex App Server operation was aborted."), { name: "AbortError" });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Codex App Server operation failed.");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function onceEvent(emitter: NodeJS.EventEmitter, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onEvent = () => {
      cleanup();
      resolvePromise();
    };
    const onError = () => {
      cleanup();
      rejectPromise(new Error("Codex App Server stream failed."));
    };
    const onAbort = () => {
      cleanup();
      rejectPromise(abortError(signal));
    };
    const cleanup = () => {
      emitter.removeListener(event, onEvent);
      emitter.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    emitter.once(event, onEvent);
    emitter.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), timeoutMs);
      timer.unref();
    }),
  ]);
}
