import { randomBytes } from "node:crypto";
import { appendFile, lstat, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureSecureDirectory, SECURE_FILE_MODE } from "./config.js";
import { ProcessEventRedactor, redactRunEvent } from "./redaction.js";
import {
  CHAT_ARTIFACT_REGISTRY,
  RUN_LOG_ENVELOPE_VERSION,
  type RetentionError,
  type RetentionReport,
} from "./storage.js";
import { PrivateStore } from "./private-store.js";
import type { AgentRunEvent } from "./types.js";
import { hasCode, isRecord } from "./utils.js";

export const DEFAULT_KEEP_RUNS = 50;
export const RUN_LOG_RETENTION_MAX_AGE_DAYS = 30;
export const RUN_LOG_RETENTION_MAX_RUNS_PER_CHAT = 100;
export const RUN_LOG_RETENTION_MAX_BYTES = 500 * 1_024 * 1_024;
/**
 * How many trailing bytes `RunLog.hasRunEnd` reads before it is willing to
 * fall back to a full scan. A terminal log's `run-end` is its last line (or
 * next-to-last, behind `appendRunEvent`'s review marker), so this is roughly
 * two orders of magnitude more than the answer ever needs — generous enough
 * that the fallback stays theoretical, small enough that retention's cost no
 * longer scales with the 500 MiB the corpus is allowed to reach.
 */
export const RUN_LOG_TAIL_PROBE_BYTES = 64 * 1_024;
export { RUN_LOG_ENVELOPE_VERSION } from "./storage.js";

export interface RunLogEnvelope {
  version: typeof RUN_LOG_ENVELOPE_VERSION;
  event: AgentRunEvent;
}

export interface RunLogRetentionOptions {
  now?: number;
  maxAgeDays?: number;
  maxRunsPerChat?: number;
  maxBytesGlobal?: number;
  activeRunIds?: ReadonlySet<string>;
  onError?: (error: RetentionError) => void;
}

export function runsDir(appHome: string, chatId: string): string {
  return join(appHome, "runs", chatId);
}

export function runLogPath(appHome: string, chatId: string, runId: string): string {
  return CHAT_ARTIFACT_REGISTRY.resolve("run-log", {
    appHome,
    chatId,
    artifactId: runId,
  });
}

/**
 * ISO timestamp (colons/dots normalized so the id stays a safe filename
 * fragment) plus six random hex characters, so ids sort chronologically as
 * plain strings and never collide within the same millisecond.
 */
export function createRunId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${iso}-${suffix}`;
}

/**
 * One NDJSON file per run under `<appHome>/runs/<chatId>/<runId>.ndjson`.
 * `write()` only buffers — nothing touches disk until the queued writes are
 * flushed, which happens continuously in the background but is only ever
 * *awaited* (with an `fsync`) at `close()`. That keeps the hot path
 * synchronous for callers while still guaranteeing the file is durable once
 * a run ends.
 */
export class RunLog {
  readonly path: string;
  #handle: FileHandle;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #redactor = new ProcessEventRedactor();

  private constructor(handle: FileHandle, path: string) {
    this.#handle = handle;
    this.path = path;
  }

  static async open(appHome: string, chatId: string, runId: string): Promise<RunLog> {
    const dir = runsDir(appHome, chatId);
    await ensureSecureDirectory(dir);
    const path = runLogPath(appHome, chatId, runId);
    const handle = await open(path, "wx", SECURE_FILE_MODE);
    try {
      await handle.chmod(SECURE_FILE_MODE);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
    return new RunLog(handle, path);
  }

  /** Buffered — queues the write and returns immediately. */
  write(event: AgentRunEvent): void {
    if (this.#closed) {
      return;
    }
    for (const safe of this.#redactor.push(event)) {
      const line = serializeRunEvent(safe, true);
      this.#chain = this.#chain.then(() => this.#handle.appendFile(line));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    for (const safe of this.#redactor.flushAll()) {
      const line = serializeRunEvent(safe, true);
      this.#chain = this.#chain.then(() => this.#handle.appendFile(line));
    }
    this.#closed = true;
    await this.#chain;
    try {
      await this.#handle.sync();
    } finally {
      await this.#handle.close();
    }
  }

  /**
   * A line that fails to parse, or parses but is not a plausible
   * `AgentRunEvent` (missing `type`), is skipped rather than raised — the
   * last line of a log a process died mid-write to is exactly this kind of
   * half-written garbage, and a resume flow reading it must not itself
   * crash on the very evidence it is trying to recover.
   */
  static async *read(
    appHome: string,
    chatId: string,
    runId: string,
  ): AsyncIterable<AgentRunEvent> {
    const path = runLogPath(appHome, chatId, runId);
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const event = readRunEvent(parsed);
        if (event) {
          yield event;
        }
      }
    } finally {
      lines.close();
      stream.close();
    }
  }

  /**
   * Appends one event to an existing run log without needing a live
   * `RunLog` instance (`open()` uses `wx` and refuses to touch a file that
   * already exists). Used to close out a run whose own process never
   * reached its `run-end` write — e.g. marking an interrupted run as
   * reviewed once the user has decided what to do with it, so it is not
   * reported as interrupted again on the next start.
   */
  static async appendRunEvent(
    appHome: string,
    chatId: string,
    runId: string,
    event: AgentRunEvent,
  ): Promise<void> {
    const path = runLogPath(appHome, chatId, runId);
    await appendFile(path, serializeRunEvent(event), {
      encoding: "utf8",
      mode: SECURE_FILE_MODE,
    });
  }

  /**
   * Whether this run's log carries a `run-end` event — the one question
   * retention asks of every log it considers (FIX-16/2).
   *
   * `run-end` is the last thing `OrcodeAgent.run()`'s `finally` writes, and
   * the only thing that can legitimately follow it is `appendRunEvent`'s
   * short review marker, so in the normal case the answer sits in the final
   * few hundred bytes. Reading only the tail is what keeps retention off
   * `RunLog.read`'s full stream-and-parse of a corpus that is allowed to
   * reach `RUN_LOG_RETENTION_MAX_BYTES` (500 MiB, measured ~125ms/MiB).
   *
   * The cheap answer is never allowed to be the wrong answer, because a
   * false "yes" would let retention delete an interrupted run's log — the
   * very evidence `findInterruptedRun` recovers from. So:
   *   - "yes" is only ever returned after actually decoding a `run-end`
   *     line, which no partial read can invent;
   *   - "no" is only returned outright when the tail covered the whole
   *     file, i.e. nothing went unread;
   *   - an ambiguous tail (no `run-end`, and bytes before the window were
   *     never looked at) falls back to the full scan this replaces.
   * A half-written trailing line — what a process killed mid-write leaves —
   * simply fails to parse and is skipped, exactly as in `read()`.
   */
  static async hasRunEnd(
    appHome: string,
    chatId: string,
    runId: string,
    options: { tailBytes?: number } = {},
  ): Promise<boolean> {
    const path = runLogPath(appHome, chatId, runId);
    const tailBytes = options.tailBytes ?? RUN_LOG_TAIL_PROBE_BYTES;
    const handle = await open(path, "r");
    let offset: number;
    let tail: string;
    try {
      const { size } = await handle.stat();
      offset = Math.max(0, size - tailBytes);
      const length = size - offset;
      if (length <= 0) return false;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      // A window that starts mid-file may start mid-character; the partial
      // first line is dropped below, which discards any broken sequence too.
      tail = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = tail.split(/\r?\n/);
    if (offset > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index]!.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (readRunEvent(parsed)?.type === "run-end") return true;
    }
    if (offset === 0) return false;
    // Ambiguous: the window held no `run-end` and it did not reach the start
    // of the file. Pay the full scan rather than guess.
    for await (const event of RunLog.read(appHome, chatId, runId)) {
      if (event.type === "run-end") return true;
    }
    return false;
  }

  /** Deletes every run log for `chatId` except the `keep` most recent. */
  static async prune(
    appHome: string,
    chatIdOrOptions: string | RunLogRetentionOptions = {},
    keep = DEFAULT_KEEP_RUNS,
  ): Promise<RetentionReport> {
    if (typeof chatIdOrOptions !== "string") {
      return pruneRunLogs(appHome, chatIdOrOptions);
    }
    const chatId = chatIdOrOptions;
    const report: RetentionReport = { removed: [], errors: [] };
    const dir = runsDir(appHome, chatId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return report;
      }
      throw error;
    }
    const runs = entries.filter((name) => name.endsWith(".ndjson")).sort();
    const stale = runs.slice(0, Math.max(0, runs.length - keep));
    const store = new PrivateStore({ root: appHome });
    for (const name of stale) {
      const path = join(dir, name);
      try {
        await store.removeTree(path);
        report.removed.push(path);
      } catch (error) {
        report.errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }
}

interface RunCandidate {
  path: string;
  chatId: string;
  runId: string;
  mtimeMs: number;
  size: number;
  active: boolean;
}

async function pruneRunLogs(
  appHome: string,
  options: RunLogRetentionOptions,
): Promise<RetentionReport> {
  const report: RetentionReport = { removed: [], errors: [] };
  const now = options.now !== undefined && Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = downward(options.maxAgeDays, RUN_LOG_RETENTION_MAX_AGE_DAYS) * 86_400_000;
  const maxRuns = downward(options.maxRunsPerChat, RUN_LOG_RETENTION_MAX_RUNS_PER_CHAT);
  const maxBytes = downward(options.maxBytesGlobal, RUN_LOG_RETENTION_MAX_BYTES);
  const candidates: RunCandidate[] = [];
  for (const artifact of await CHAT_ARTIFACT_REGISTRY.all("run-log", appHome)) {
    try {
      const info = await lstat(artifact.path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Run log is not a regular file.");
      // FIX-16/2: the tail probe, not a full stream-and-parse of every log
      // in the corpus, answers "did this run end?".
      const terminal = await RunLog.hasRunEnd(appHome, artifact.chatId, artifact.artifactId!);
      candidates.push({
        path: artifact.path,
        chatId: artifact.chatId,
        runId: artifact.artifactId!,
        mtimeMs: info.mtimeMs,
        size: info.size,
        active: options.activeRunIds?.has(artifact.artifactId!) === true || !terminal,
      });
    } catch (error) {
      addRetentionError(report, artifact.path, error, options.onError);
    }
  }
  const ordered = [...candidates].sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  const store = new PrivateStore({ root: appHome });
  const remove = async (candidate: RunCandidate): Promise<void> => {
    if (candidate.active || report.removed.includes(candidate.path)) return;
    try {
      await store.removeTree(candidate.path);
      report.removed.push(candidate.path);
    } catch (error) {
      addRetentionError(report, candidate.path, error, options.onError);
    }
  };
  for (const candidate of ordered) {
    if (now - candidate.mtimeMs > maxAgeMs) await remove(candidate);
  }
  for (const chatId of new Set(ordered.map((candidate) => candidate.chatId))) {
    const terminal = ordered.filter((candidate) =>
      candidate.chatId === chatId && !candidate.active && !report.removed.includes(candidate.path));
    for (const candidate of terminal.slice(0, Math.max(0, terminal.length - maxRuns))) await remove(candidate);
  }
  let total = ordered.filter((candidate) => !report.removed.includes(candidate.path))
    .reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of ordered) {
    if (total <= maxBytes) break;
    if (candidate.active || report.removed.includes(candidate.path)) continue;
    await remove(candidate);
    if (report.removed.includes(candidate.path)) total -= candidate.size;
  }
  return report;
}

function downward(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return ceiling;
  return Math.min(ceiling, Math.max(0, Math.floor(value)));
}

function addRetentionError(
  report: RetentionReport,
  path: string,
  error: unknown,
  onError?: (error: RetentionError) => void,
): void {
  const entry = { path, message: error instanceof Error ? error.message : String(error) };
  report.errors.push(entry);
  onError?.(entry);
}

function serializeRunEvent(event: AgentRunEvent, alreadyRedacted = false): string {
  const envelope: RunLogEnvelope = {
    version: RUN_LOG_ENVELOPE_VERSION,
    event: alreadyRedacted ? event : redactRunEvent(event),
  };
  return `${JSON.stringify(envelope)}\n`;
}

function readRunEvent(value: unknown): AgentRunEvent | null {
  // Read-only compatibility for pre-envelope logs.
  if (isRecord(value) && typeof value.type === "string") {
    return value as AgentRunEvent;
  }
  if (
    !isRecord(value) ||
    value.version !== RUN_LOG_ENVELOPE_VERSION ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string"
  ) {
    // Includes unknown future envelope versions. Isolation is per line, so a
    // newer writer cannot make older or unrelated events unreadable.
    return null;
  }
  return value.event as AgentRunEvent;
}

// Default app home re-exported for convenience; callers should still prefer
// passing an explicit `appHome` so tests never touch the real `~/.orcode`.
export { APP_HOME as DEFAULT_APP_HOME };
