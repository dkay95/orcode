import { randomBytes } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureSecureDirectory, SECURE_FILE_MODE } from "./config.js";
import type { AgentRunEvent } from "./types.js";
import { hasCode } from "./utils.js";

export const DEFAULT_KEEP_RUNS = 50;

export function runsDir(appHome: string, chatId: string): string {
  return join(appHome, "runs", chatId);
}

export function runLogPath(appHome: string, chatId: string, runId: string): string {
  return join(runsDir(appHome, chatId), `${runId}.ndjson`);
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
    const line = `${JSON.stringify(event)}\n`;
    this.#chain = this.#chain.then(() => this.#handle.appendFile(line));
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#chain;
    try {
      await this.#handle.sync();
    } finally {
      await this.#handle.close();
    }
  }

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
        yield JSON.parse(trimmed) as AgentRunEvent;
      }
    } finally {
      lines.close();
      stream.close();
    }
  }

  /** Deletes every run log for `chatId` except the `keep` most recent. */
  static async prune(
    appHome: string,
    chatId: string,
    keep = DEFAULT_KEEP_RUNS,
  ): Promise<void> {
    const dir = runsDir(appHome, chatId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const runs = entries.filter((name) => name.endsWith(".ndjson")).sort();
    const stale = runs.slice(0, Math.max(0, runs.length - keep));
    await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
  }
}

// Default app home re-exported for convenience; callers should still prefer
// passing an explicit `appHome` so tests never touch the real `~/.orcode`.
export { APP_HOME as DEFAULT_APP_HOME };
