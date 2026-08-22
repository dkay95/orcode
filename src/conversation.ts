import { open as openFile, readFile, unlink } from "node:fs/promises";
import {
  createInitialState,
  deserializeConversationState,
  serializeConversationState,
  type ConversationState,
  type StateAccessor,
} from "@openrouter/agent";
import { SECURE_FILE_MODE } from "./config.js";
import { PrivateStore } from "./private-store.js";
import {
  CHAT_ARTIFACT_REGISTRY,
  parseConversationStateFile,
  type StoredConversationStateFile,
} from "./storage.js";
import { chatLockPath, conversationHistoryDigest } from "./session.js";
import { hasCode, isRecord } from "./utils.js";

/**
 * Persisted next to the chat file, never inside it: `mergeSessions`
 * (session.ts) builds a hardcoded object literal and would silently drop any
 * field it does not know about on every merge (K7a).
 */
export type StateFile = StoredConversationStateFile;

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
  readonly #appHome: string;
  readonly #chatFilePath: string;
  readonly #statePath: string;
  #baseRevision: number;
  #committedState: ConversationState | null;
  #usable: boolean;
  #coveredTurnCount: number;
  #historyDigest: string | null;
  #buffer: ConversationState | null = null;
  #stagedState: ConversationState | undefined;
  readonly #privateStore: PrivateStore;

  private constructor(options: {
    chatId: string;
    appHome: string;
    chatFilePath: string;
    statePath: string;
    baseRevision: number;
    committedState: ConversationState | null;
    usable: boolean;
    coveredTurnCount: number;
    historyDigest: string | null;
    privateStore: PrivateStore;
  }) {
    this.#chatId = options.chatId;
    this.#appHome = options.appHome;
    this.#chatFilePath = options.chatFilePath;
    this.#statePath = options.statePath;
    this.#baseRevision = options.baseRevision;
    this.#committedState = options.committedState;
    this.#usable = options.usable;
    this.#coveredTurnCount = options.coveredTurnCount;
    this.#historyDigest = options.historyDigest;
    this.#privateStore = options.privateStore;
  }

  /** `appHome` is accepted for signature symmetry with the rest of the app's path helpers; the state file always lives next to the chat file it belongs to. */
  static path(appHome: string, chatFilePath: string): string {
    return CHAT_ARTIFACT_REGISTRY.resolve("conversation-state", {
      appHome,
      chatId: "path-derived",
      chatFilePath,
    });
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
    const privateStore = new PrivateStore({ root: appHome });
    const [stateFile, history] = await Promise.all([
      readStateFile(statePath, privateStore),
      readChatHistory(chatFilePath),
    ]);
    const matchesChat = stateFile !== null && stateFile.chatId === chatId;
    const baseRevision = matchesChat ? stateFile!.revision : 0;
    let committedState: ConversationState | null = null;
    let usable = false;
    if (
      matchesChat &&
      stateFile!.turnCount === history.turnCount &&
      stateFile!.historyDigest === history.digest
    ) {
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
      appHome,
      chatFilePath,
      statePath,
      baseRevision,
      committedState,
      usable,
      coveredTurnCount: usable ? stateFile!.turnCount : 0,
      historyDigest: usable ? stateFile!.historyDigest : null,
      privateStore,
    });
  }

  /** True when a usable, non-stale committed state exists. */
  hasState(): boolean {
    return this.#stagedState !== undefined
      ? true
      : this.#usable && this.#committedState !== null;
  }

  /** Exact current-history check for a store that may stay open across session mutations. */
  covers(turnCount: number, historyDigest: string): boolean {
    return (
      this.#usable &&
      this.#committedState !== null &&
      this.#coveredTurnCount === turnCount &&
      this.#historyDigest === historyDigest
    );
  }

  /**
   * Handed to `client.callModel({ state: ... })`. `save` only ever touches
   * the in-memory buffer (K7b) — see the class doc comment.
   */
  accessor(transientDeveloperMessages: readonly string[] = []): StateAccessor {
    const transient = new Set(transientDeveloperMessages.filter(Boolean));
    return {
      load: async () => {
        const state =
          this.#stagedState ?? (this.#usable ? this.#committedState : null);
        return state === null ? null : cloneConversationState(state);
      },
      save: async (state) => {
        this.#buffer = cloneConversationState(
          stripTransientDeveloperMessages(state, transient),
        );
      },
    };
  }

  /**
   * Clones the latest buffered SDK state into the transient load slot for the
   * next model phase. Nothing is committed: a later `discard()` restores the
   * prior durable state, while the next accessor save replaces the buffer.
   */
  stageContinuation(): boolean {
    if (this.#buffer === null) {
      return false;
    }
    this.#stagedState = cloneConversationState(this.#buffer);
    return true;
  }

  /** Drops the in-memory buffer. The committed file on disk is untouched. */
  discard(): void {
    this.#buffer = null;
    this.#stagedState = undefined;
  }

  /** A seed stages a fresh state for the next call; no seed permanently invalidates old memory after clear/rollback. */
  reset(seed?: string): void {
    this.#buffer = null;
    if (seed !== undefined) {
      const fresh = createInitialState();
      fresh.messages = seed
        ? [{ role: "user", content: seed }]
        : [];
      this.#stagedState = fresh;
      return;
    }
    this.#stagedState = undefined;
    this.#committedState = null;
    this.#usable = false;
    this.#coveredTurnCount = 0;
    this.#historyDigest = null;
  }

  /** Forces the next request to rebuild from complete history. */
  invalidate(): void {
    this.#buffer = null;
    this.#stagedState = undefined;
    this.#committedState = null;
    this.#usable = false;
    this.#coveredTurnCount = 0;
    this.#historyDigest = null;
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
      this.#stagedState = undefined;
      return;
    }
    const state = this.#buffer;
    const lockPath = chatLockPath(this.#statePath);
    const release = await acquireLock(lockPath);
    try {
      const history = await readChatHistory(this.#chatFilePath);
      if (history.turnCount !== turnCount) {
        throw new Error(
          `Conversation state covers ${turnCount} turns, chat contains ${history.turnCount}.`,
        );
      }
      const onDisk = await readStateFile(this.#statePath, this.#privateStore);
      const diskRevision = onDisk?.revision ?? 0;
      if (onDisk !== null && diskRevision > this.#baseRevision) {
        const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const conflictPath = CHAT_ARTIFACT_REGISTRY.resolve(
          "conversation-conflict",
          {
            appHome: this.#appHome,
            chatId: this.#chatId,
            chatFilePath: this.#chatFilePath,
            conflictId: stamp,
          },
        );
        const conflict: StateFile = {
          version: 1,
          revision: this.#baseRevision + 1,
          chatId: this.#chatId,
          turnCount,
          historyDigest: history.digest,
          updatedAt: new Date().toISOString(),
          state: serializeConversationState(state),
        };
        await this.#privateStore.writeTextAtomic(
          conflictPath,
          `${JSON.stringify(conflict, null, 2)}\n`,
        );
        if (
          onDisk.turnCount === history.turnCount &&
          onDisk.historyDigest === history.digest
        ) {
          this.#committedState = deserializeConversationState(onDisk.state);
          this.#usable = true;
          this.#coveredTurnCount = onDisk.turnCount;
          this.#historyDigest = onDisk.historyDigest;
        } else {
          this.#committedState = null;
          this.#usable = false;
        }
        this.#baseRevision = diskRevision;
        this.#buffer = null;
        this.#stagedState = undefined;
        return;
      }
      const newRevision = diskRevision + 1;
      const stateFile: StateFile = {
        version: 1,
        revision: newRevision,
        chatId: this.#chatId,
        turnCount,
        historyDigest: history.digest,
        updatedAt: new Date().toISOString(),
        state: serializeConversationState(state),
      };
      await this.#privateStore.writeTextAtomic(
        this.#statePath,
        `${JSON.stringify(stateFile, null, 2)}\n`,
      );
      this.#committedState = state;
      this.#usable = true;
      this.#coveredTurnCount = history.turnCount;
      this.#historyDigest = history.digest;
      this.#baseRevision = newRevision;
      this.#buffer = null;
      this.#stagedState = undefined;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      await release();
    }
  }
}

function stripTransientDeveloperMessages(
  state: ConversationState,
  transient: ReadonlySet<string>,
): ConversationState {
  if (!transient.size || !Array.isArray(state.messages)) {
    return state;
  }
  const messages = state.messages.filter((message) => {
    const candidate: unknown = message;
    if (!isRecord(candidate)) {
      return true;
    }
    return !(
      candidate.role === "developer" &&
      typeof candidate.content === "string" &&
      transient.has(candidate.content)
    );
  });
  return messages.length === state.messages.length ? state : { ...state, messages };
}

function cloneConversationState(state: ConversationState): ConversationState {
  return deserializeConversationState(serializeConversationState(state));
}

async function readStateFile(path: string, store: PrivateStore): Promise<StateFile | null> {
  let raw: string;
  try {
    raw = await store.readText(path);
  } catch {
    return null;
  }
  try {
    return parseConversationStateFile(raw);
  } catch {
    return null;
  }
}

/** Reads the exact redacted summary/transcript epoch from the actual chat JSON. */
async function readChatHistory(
  chatFilePath: string,
): Promise<{ turnCount: number; digest: string }> {
  try {
    const raw = await readFile(chatFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.turns)
    ) {
      const turns = parsed.turns.filter(
        (turn): turn is { role: "user" | "assistant"; content: string; createdAt: string } =>
          isRecord(turn) &&
          (turn.role === "user" || turn.role === "assistant") &&
          typeof turn.content === "string" &&
          typeof turn.createdAt === "string",
      );
      return {
        turnCount: turns.length,
        digest: conversationHistoryDigest({ summary: parsed.summary, turns }),
      };
    }
  } catch {
    // A missing or unreadable chat file is treated as "zero turns", the
    // conservative direction: it makes any existing state look stale rather
    // than risk resurrecting memory the chat no longer shows.
  }
  return {
    turnCount: 0,
    digest: conversationHistoryDigest({ summary: "", turns: [] }),
  };
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
