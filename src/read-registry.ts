import { createHash } from "node:crypto";

/**
 * What the agent knew about a file the last time it read it.
 *
 * `mtimeMs` and `size` are cheap to compare on every write; `sha256` is the
 * authoritative check for the rare case where a file is rewritten with an
 * identical size inside the same millisecond.
 */
export interface ReadRecord {
  mtimeMs: number;
  size: number;
  sha256: string;
  at: number;
}

export type ReadFreshness = "unknown" | "fresh" | "stale";

/**
 * Tracks what an agent has read, so a write can detect whether the file
 * changed underneath it since then.
 *
 * One instance per agent (not per run): the whole point is to catch changes
 * that happened between turns, not just within one.
 */
export class ReadRegistry {
  #records = new Map<string, ReadRecord>();

  note(absPath: string, record: ReadRecord): void {
    this.#records.set(absPath, record);
  }

  /**
   * `"unknown"` when the path was never noted (a brand new file, or one the
   * agent never read) — callers must not block a write on that, only on an
   * actual mismatch (`"stale"`).
   */
  check(
    absPath: string,
    current: { mtimeMs: number; size: number; sha256: string },
  ): ReadFreshness {
    const record = this.#records.get(absPath);
    if (!record) {
      return "unknown";
    }
    if (
      record.mtimeMs === current.mtimeMs &&
      record.size === current.size &&
      record.sha256 === current.sha256
    ) {
      return "fresh";
    }
    return "stale";
  }

  /** Call after every write the agent itself performs on `absPath`. */
  forget(absPath: string): void {
    this.#records.delete(absPath);
  }
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
