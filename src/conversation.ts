import { open as openFile, readFile, unlink } from "node:fs/promises";
import {
  deserializeConversationState,
  serializeConversationState,
  type ConversationState,
  type StateAccessor,
} from "@openrouter/agent";
import { SECURE_FILE_MODE, writeFileAtomicSecure } from "./config.js";
import { chatLockPath } from "./session.js";
import { hasCode, isRecord } from "./utils.js";

/**
 * Persisted next to the chat file, never inside it: `mergeSessions`
 * (session.ts) builds a hardcoded object literal and would silently drop any
 * field it does not know about on every merge (K7a).
 */
export interface StateFile {
  version: 1;
  revision: number;
  chatId: string;
  /** How many turns the chat file had when this state was committed. */
  turnCount: number;
  updatedAt: string;
  /** Opaque JSON from `serializeConversationState`. Never introspected. */
  state: string;
}

const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 25;

/**
 * Durable store for the SDK's opaque `ConversationState`.
 *
 * `StateAccessor.save` (handed out by `accessor()`) writes only into an
 * in-memory buffer — the SDK calls it several times per run, and none of
 * those calls may hit disk on their own (K7b). Exactly one caller-driven
 * `commit()` after a *successful* run persists the buffer atomically;
 * `discard()` drops it. A run that never commits therefore never changes the
 * file on disk, which is what makes Ctrl+C harmless: a `tool_call` without a
 * matching `tool_result` can never end up in the persisted state.
 */
export class ConversationStore {
  readonly #chatId: string;
  readonly #statePath: string;
  #baseRevision: number;
  #committedState: ConversationState | null;
  #usable: boolean;
  #buffer: ConversationState | null = null;

  private constructor(options: {
    chatId: string;
    statePath: string;
    baseRevision: number;
    committedState: ConversationState | null;
    usable: boolean;
  }) {
    this.#chatId = options.chatId;
    this.#statePath = options.statePath;
    this.#baseRevision = options.baseRevision;
    this.#committedState = options.committedState;
    this.#usable = options.usable;
  }

  /** `appHome` is accepted for signature symmetry with the rest of the app's path helpers; the state file always lives next to the chat file it belongs to. */
  static path(appHome: string, chatFilePath: string): string {
    void appHome;
    return `${chatFilePath}.state.json`;
  }

  /**
   * Opens (or freshly initializes) the state for one chat.
   *
   * K7c: the chat file's actual turn count is read right here and compared
   * against the state file's recorded `turnCount`. If the chat was rolled
   * back or cleared since the state was committed (`turnCount` on disk is
   * higher than what the chat file now has), the state is treated as absent
   * — `hasState()` reports `false` and `accessor().load()` returns `null`.
   */
  static async open(
    appHome: string,
    chatFilePath: string,
    chatId: string,
  ): Promise<ConversationStore> {
    const statePath = ConversationStore.path(appHome, chatFilePath);
    const [stateFile, currentTurnCount] = await Promise.all([
      readStateFile(statePath),
      readChatTurnCount(chatFilePath),
    ]);
    const matchesChat = stateFile !== null && stateFile.chatId === chatId;
    const baseRevision = matchesChat ? stateFile!.revision : 0;
    let committedState: ConversationState | null = null;
    let usable = false;
    if (matchesChat && stateFile!.turnCount <= currentTurnCount) {
      try {
        committedState = deserializeConversationState(stateFile!.state);
        usable = true;
      } catch {
        committedState = null;
        usable = false;
      }
    }
    return new ConversationStore({
      chatId,
      statePath,
      baseRevision,
      committedState,
      usable,
    });
  }

  /** True when a usable, non-stale committed state exists. */
  hasState(): boolean {
    return this.#usable && this.#committedState !== null;
  }

  /**
   * Handed to `client.callModel({ state: ... })`. `save` only ever touches
   * the in-memory buffer (K7b) — see the class doc comment.
   */
  accessor(): StateAccessor {
    return {
      load: async () => (this.#usable ? this.#committedState : null),
      save: async (state) => {
        this.#buffer = state;
      },
    };
  }

  /** Drops the in-memory buffer. The committed file on disk is untouched. */
  discard(): void {
    this.#buffer = null;
  }

  /** A fresh, empty state — used after a destructive context cut (K7f) or when the transcript itself was reset/rolled back out from under this store (K7c). */
  reset(seed?: string): void {
    void seed;
    this.#buffer = null;
    this.#committedState = null;
    this.#usable = false;
  }

  /**
   * Persists the buffer, if anything was saved this run. Optimistic
   * concurrency: if another `ConversationStore` on the same file committed a
   * newer revision since this store last read it, this store's content is
   * never allowed to clobber it — it is written aside as a
   * `.konflikt-<stamp>.json` sidecar instead (K7a test 2). Nothing is ever
   * lost.
   */
  async commit(turnCount: number): Promise<void> {
    if (this.#buffer === null) {
      return;
    }
    const state = this.#buffer;
    this.#buffer = null;
    const lockPath = chatLockPath(this.#statePath);
    const release = await acquireLock(lockPath);
    try {
      const onDisk = await readStateFile(this.#statePath);
      const diskRevision = onDisk?.revision ?? 0;
      if (onDisk !== null && diskRevision > this.#baseRevision) {
        const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const conflictPath = `${this.#statePath}.konflikt-${stamp}.json`;
        const conflict: StateFile = {
          version: 1,
          revision: this.#baseRevision + 1,
          chatId: this.#chatId,
          turnCount,
          updatedAt: new Date().toISOString(),
          state: serializeConversationState(state),
        };
        await writeFileAtomicSecure(
          conflictPath,
          `${JSON.stringify(conflict, null, 2)}\n`,
        );
        this.#committedState = deserializeConversationState(onDisk.state);
        this.#usable = true;
        this.#baseRevision = diskRevision;
        return;
      }
      const newRevision = diskRevision + 1;
      const stateFile: StateFile = {
        version: 1,
        revision: newRevision,
        chatId: this.#chatId,
        turnCount,
        updatedAt: new Date().toISOString(),
        state: serializeConversationState(state),
      };
      await writeFileAtomicSecure(
        this.#statePath,
        `${JSON.stringify(stateFile, null, 2)}\n`,
      );
      this.#committedState = state;
      this.#usable = true;
      this.#baseRevision = newRevision;
    } finally {
      await release();
    }
  }
}

async function readStateFile(path: string): Promise<StateFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.revision !== "number" ||
      typeof parsed.chatId !== "string" ||
      typeof parsed.turnCount !== "number" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.state !== "string"
    ) {
      return null;
    }
    return parsed as unknown as StateFile;
  } catch {
    return null;
  }
}

/** Reads only `turns.length` from the actual chat JSON; never the state file. */
async function readChatTurnCount(chatFilePath: string): Promise<number> {
  try {
    const raw = await readFile(chatFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && Array.isArray(parsed.turns)) {
      return parsed.turns.length;
    }
  } catch {
    // A missing or unreadable chat file is treated as "zero turns", the
    // conservative direction: it makes any existing state look stale rather
    // than risk resurrecting memory the chat no longer shows.
  }
  return 0;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await openFile(lockPath, "wx", SECURE_FILE_MODE);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      // Best effort: break a wedged lock rather than block a commit forever.
      await unlink(lockPath).catch(() => {});
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}
