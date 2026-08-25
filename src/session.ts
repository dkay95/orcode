import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  APP_HOME,
  ensureSecureDirectory,
  SECURE_FILE_MODE,
  writeFileAtomicSecure,
} from "./config.js";
import {
  REASONING_EFFORTS,
  type ChatSummary,
  type ChatTurn,
  type CostKnowledge,
  type CostLedger,
  type ReasoningSetting,
  type SessionData,
} from "./types.js";
import { redactText, redactValue } from "./redaction.js";
import { PrivateStore } from "./private-store.js";
import {
  CHAT_ARTIFACT_REGISTRY,
  deleteChatOwnedArtifacts,
  type ChatDeletionReport,
  workspaceStorageHash,
} from "./storage.js";
import { formatUsd, hasCode, isRecord } from "./utils.js";
import type { RouteIdentityV1 } from "./backends.js";
import {
  isProviderStateIssue,
  mapLegacyOpenRouterModel,
  validateRouteIdentityV1,
  type ProviderConnectionStateV1,
  type ProviderSetupState,
} from "./provider-state.js";

const MAX_TURNS = 80;
const MAX_CHECKPOINTS = 50;
const MAX_TOOL_CALLS = 200;
const SPEND_HISTORY_DAYS = 90;
const DEFAULT_TITLE = "Neuer Chat";
/** Fixed copy: never echoes route fields, so no fingerprint or model reaches an error. */
const ROUTE_INVALID_MESSAGE = "Chat-Route ist unvollständig oder unbekannt.";
const ROUTE_MODEL_MISMATCH_MESSAGE = "Chat-Route passt nicht zum gewählten Modell.";

/** A lock older than this belongs to a process that died mid-write. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 40;
const LOCK_WAIT_MS = 5_000;
const LOCK_MAX_ATTEMPTS = 400;

/** Marks a v1 session file as migrated so it is never imported twice (B15). */
export const LEGACY_MIGRATED_SUFFIX = ".migrated";

export interface SessionCheckpoint {
  id: string;
  label: string;
  /** Number of turns that existed when the checkpoint was taken. */
  turnIndex: number;
  costUsd: number;
  /** Missing in legacy checkpoints means known. */
  costKnowledge?: CostKnowledge;
  createdAt: string;
}

export interface SessionToolCall {
  name: string;
  summary: string;
  /** Turn count at the time of the call, used to interleave the export. */
  turnIndex: number;
  at: string;
}

/**
 * Everything orcode persists. `SessionData` (types.ts) stays the shared
 * contract; the extra fields are additive and optional when reading old files.
 */
export interface PersistedSessionData extends SessionData {
  /** Bumped on every successful write; the basis of the conflict guard (B14). */
  revision: number;
  checkpoints: SessionCheckpoint[];
  toolCalls: SessionToolCall[];
  /** local day (YYYY-MM-DD) -> USD spent on that day in this chat. */
  dailySpendUsd: Record<string, number>;
  /** Explicit tombstone: this model was deliberately detached from its route. */
  routeCleared?: true;
}

export interface SaveOutcome {
  /** A concurrent instance had written to the file; both states were merged. */
  merged: boolean;
  /** Set when an unreadable foreign file was moved aside instead of destroyed. */
  conflictBackupPath: string | null;
  revision: number;
}

export interface SessionRunSnapshot {
  data: PersistedSessionData;
}

/**
 * Returns the one still-legacy OpenRouter connection that may project model
 * preferences from historical chats. Once activation moves the connection to
 * a versioned slot, old chats must no longer infer a route from it.
 */
export function migratedOpenRouterSessionConnection(
  providerSetup: ProviderSetupState,
): ProviderConnectionStateV1 | undefined {
  if (isProviderStateIssue(providerSetup)) {
    return undefined;
  }
  const matches = providerSetup.connections.filter(
    isActiveMigratedOpenRouterConnection,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export class SessionStore {
  #data: PersistedSessionData;
  /** Last state known to be on disk; the base of the three-way merge. */
  #base: PersistedSessionData;
  /** A legacy route derived at read time but not yet owned by the chat file. */
  #pendingLegacyRouteProjection = false;
  readonly appHome: string;
  readonly path: string;

  constructor(appHome: string, path: string, data: SessionData) {
    this.appHome = appHome;
    this.path = path;
    this.#data = withPersistenceFields(data);
    this.#base = structuredClone(this.#data);
  }

  static async open(
    workspace: string,
    appHome = APP_HOME,
    providerConnection?: ProviderConnectionStateV1,
  ): Promise<SessionStore> {
    // The one explicit place where a v1 file is imported; list()/search() stay
    // read only (B15).
    await migrateLegacySession(workspace, appHome);
    const chats = await SessionStore.list(workspace, appHome, providerConnection);
    if (chats[0]) {
      return SessionStore.openById(workspace, chats[0].id, appHome, providerConnection);
    }
    return SessionStore.create(workspace, appHome);
  }

  static create(
    workspace: string,
    appHome = APP_HOME,
    title = DEFAULT_TITLE,
  ): SessionStore {
    const id = randomUUID();
    const path = chatPath(appHome, workspace, id);
    return new SessionStore(
      appHome,
      path,
      emptySession(workspace, id, normalizeTitle(title)),
    );
  }

  static async openById(
    workspace: string,
    id: string,
    appHome = APP_HOME,
    providerConnection?: ProviderConnectionStateV1,
  ): Promise<SessionStore> {
    assertChatId(id);
    const path = chatPath(appHome, workspace, id);
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const parsed = normalizeSession(
        raw,
        workspace,
        id,
        providerConnection,
      );
      if (parsed) {
        const store = new SessionStore(appHome, path, parsed);
        if (
          validateRouteIdentityV1(raw?.route) === null
          && parsed.route?.resolutionState === "legacy-unverified"
        ) {
          store.#pendingLegacyRouteProjection = true;
          delete store.#base.route;
        }
        return store;
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new Error(`Chat nicht gefunden: ${id}`);
      }
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
    throw new Error(`Chat-Datei ist ungültig: ${id}`);
  }

  /**
   * Deletes a chat file for good (plus a stale lock, if one is around).
   * There is no trash — the UI layer asks for confirmation before calling.
   */
  static async remove(
    workspace: string,
    id: string,
    appHome = APP_HOME,
  ): Promise<ChatDeletionReport> {
    assertChatId(id);
    return deleteChatOwnedArtifacts(appHome, workspace, id);
  }

  /** Read only: listing chats never writes to disk (B15). */
  static async list(
    workspace: string,
    appHome = APP_HOME,
    providerConnection?: ProviderConnectionStateV1,
  ): Promise<ChatSummary[]> {
    const sessions = await loadAllSessions(workspace, appHome, providerConnection);
    return sessions.map(toSummary);
  }

  /** Read only: searching never writes to disk (B15). */
  static async search(
    workspace: string,
    query: string,
    appHome = APP_HOME,
    providerConnection?: ProviderConnectionStateV1,
  ): Promise<ChatSearchHit[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    const sessions = await loadAllSessions(workspace, appHome, providerConnection);
    const hits: ChatSearchHit[] = [];
    for (const data of sessions) {
      const titleMatch = data.title.toLowerCase().includes(normalized);
      const turn = data.turns.find((candidate) =>
        candidate.content.toLowerCase().includes(normalized),
      );
      if (!titleMatch && !turn) {
        continue;
      }
      hits.push({
        chat: toSummary(data),
        titleMatch,
        snippet: turn ? buildSnippet(turn.content, normalized) : "",
      });
    }
    return hits.sort((left, right) => {
      if (left.titleMatch !== right.titleMatch) {
        return left.titleMatch ? -1 : 1;
      }
      return Date.parse(right.chat.updatedAt) - Date.parse(left.chat.updatedAt);
    });
  }

  get data(): Readonly<PersistedSessionData> {
    return this.#data;
  }

  addTurn(role: ChatTurn["role"], content: string): void {
    this.#data.turns.push({
      role,
      content,
      createdAt: new Date().toISOString(),
    });
    if (role === "user" && this.#data.title === DEFAULT_TITLE) {
      this.#data.title = titleFromPrompt(content);
    }
    if (this.#data.turns.length > MAX_TURNS) {
      this.#data.turns = this.#data.turns.slice(-MAX_TURNS);
    }
    this.#data.updatedAt = new Date().toISOString();
  }

  rename(title: string): void {
    this.#data.title = normalizeTitle(title);
    this.#data.updatedAt = new Date().toISOString();
  }

  /**
   * Persists the model preference together with the exact route that owns it.
   * A route is stored complete or not at all: an incomplete, future, or
   * foreign-shaped route and a model that does not belong to the route are
   * rejected with fixed copy, so the chat never carries a cross-bound identity.
   */
  setPreferences(model: string, reasoning: ReasoningSetting, route?: RouteIdentityV1): void {
    const trimmedModel = model.trim();
    if (route !== undefined) {
      const persistable = persistableSessionRoute(route);
      if (persistable === null) {
        throw new Error(ROUTE_INVALID_MESSAGE);
      }
      if (!routeOwnsModel(persistable, trimmedModel)) {
        throw new Error(ROUTE_MODEL_MISMATCH_MESSAGE);
      }
      this.#data.route = persistable;
      delete this.#data.routeCleared;
      this.#pendingLegacyRouteProjection = false;
    } else if (this.#data.route === undefined || !routeOwnsModel(this.#data.route, trimmedModel)) {
      // A route-less update keeps the exact current route as long as it owns
      // the model (requested or canonical id); it never synthesizes one.
      const detachedOwnedRoute = this.#data.route !== undefined;
      delete this.#data.route;
      if (detachedOwnedRoute) this.#data.routeCleared = true;
      this.#pendingLegacyRouteProjection = false;
    }
    this.#data.model = trimmedModel;
    this.#data.reasoning = structuredClone(reasoning);
    this.#data.updatedAt = new Date().toISOString();
  }

  /** Atomically clears only the exact resolved durable route named by a provider lifecycle action. */
  async clearRouteIfExact(expectedRoute: RouteIdentityV1): Promise<boolean> {
    const expected = persistableSessionRoute(expectedRoute);
    if (!expected || !sameExactResolvedRoute(this.#data.route, expected)) return false;
    return enqueueWrite(this.path, () => this.#clearRouteIfExactNow(expected));
  }

  async #clearRouteIfExactNow(expected: RouteIdentityV1): Promise<boolean> {
    if (!sameExactResolvedRoute(this.#data.route, expected)) return false;
    await ensureSecureDirectory(this.appHome);
    await ensureSecureDirectory(dirname(this.path));
    const release = await acquireChatLock(this.path);
    try {
      if (!sameExactResolvedRoute(this.#data.route, expected)) return false;
      const foreign = await readForeign(
        this.path,
        this.#data.workspace,
        this.#data.id,
      );
      if (!sameExactResolvedRoute(this.#data.route, expected)) return false;
      if (foreign.kind === "unreadable") return false;
      if (foreign.kind === "missing") {
        markRouteCleared(this.#data);
        this.#pendingLegacyRouteProjection = false;
        return true;
      }
      if (!sameExactResolvedRoute(foreign.data.route, expected)) {
        const reconciled = sameValue(foreign.data, this.#base)
          ? structuredClone(this.#data)
          : mergeSessions(this.#base, this.#data, foreign.data);
        adoptSessionIdentity(reconciled, foreign.data);
        reconciled.revision = Math.max(reconciled.revision, foreign.revision);
        this.#data = reconciled;
        this.#base = structuredClone(foreign.data);
        this.#pendingLegacyRouteProjection = false;
        return false;
      }

      const next = sameValue(foreign.data, this.#base)
        ? structuredClone(this.#data)
        : mergeSessions(this.#base, this.#data, foreign.data);
      markRouteCleared(next);
      next.revision = Math.max(next.revision, foreign.revision) + 1;
      await writeFileAtomicSecure(
        this.path,
        `${JSON.stringify(redactValue(next), null, 2)}\n`,
      );
      this.#data = next;
      this.#base = structuredClone(next);
      this.#pendingLegacyRouteProjection = false;
      return true;
    } finally {
      await release();
    }
  }

  /** Rebinds only a route that was projected lazily and is still unpersisted. */
  rebindPendingLegacyRoute(providerConnection?: ProviderConnectionStateV1): void {
    if (!this.#pendingLegacyRouteProjection) return;
    if (
      this.#data.model
      && isActiveMigratedOpenRouterConnection(providerConnection)
    ) {
      this.#data.route = mapLegacyOpenRouterModel(this.#data.model, providerConnection);
      return;
    }
    delete this.#data.route;
    this.#pendingLegacyRouteProjection = false;
  }

  async fork(title = `${this.#data.title} (Fork)`): Promise<SessionStore> {
    const fork = SessionStore.create(
      this.#data.workspace,
      this.appHome,
      title,
    );
    fork.#data.summary = this.#data.summary;
    fork.#data.turns = this.#data.turns.map((turn) => ({ ...turn }));
    fork.#data.checkpoints = this.#data.checkpoints.map((checkpoint) => ({
      ...checkpoint,
    }));
    fork.#data.model = this.#data.model;
    fork.#data.route = this.#data.route ? structuredClone(this.#data.route) : undefined;
    fork.#data.routeCleared = this.#data.routeCleared;
    fork.#data.reasoning = this.#data.reasoning
      ? structuredClone(this.#data.reasoning)
      : undefined;
    await fork.save();
    return fork;
  }

  setSummary(summary: string): void {
    this.#data.summary = summary;
    this.#data.updatedAt = new Date().toISOString();
  }

  compactTurns(keepRecent = 4): void {
    const keep = Math.max(0, Math.floor(keepRecent));
    this.#data.turns = keep === 0 ? [] : this.#data.turns.slice(-keep);
    this.#data.updatedAt = new Date().toISOString();
  }

  addCost(
    kind: "main" | "compressor" | "voice",
    amount: number,
    knowledge: CostKnowledge = "known",
  ): void {
    if (knowledge === "unknown") {
      this.#data.costs.costKnowledge = "unknown";
      this.#data.updatedAt = new Date().toISOString();
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    if (kind === "main") {
      this.#data.costs.mainUsd += amount;
    } else if (kind === "compressor") {
      this.#data.costs.compressorUsd += amount;
    } else {
      this.#data.costs.voiceUsd += amount;
    }
    this.#data.costs.totalUsd =
      this.#data.costs.mainUsd + this.#data.costs.compressorUsd + this.#data.costs.voiceUsd;
    const day = dayKey();
    this.#data.dailySpendUsd[day] = (this.#data.dailySpendUsd[day] ?? 0) + amount;
    this.#data.dailySpendUsd = pruneSpend(this.#data.dailySpendUsd);
    this.#data.updatedAt = new Date().toISOString();
  }

  /**
   * Resets the visible chat. `dailySpendUsd` survives on purpose: budget
   * accounting must not be resettable with /clear.
   */
  clear(): void {
    const { id, title, workspace, model, route, routeCleared, reasoning, createdAt } = this.#data;
    const costKnowledge = knowledgeOf(this.#data.costs);
    this.#data = {
      ...emptySession(workspace, id, title),
      model,
      route,
      routeCleared,
      reasoning,
      createdAt,
      revision: this.#data.revision,
      dailySpendUsd: { ...this.#data.dailySpendUsd },
    };
    this.#data.costs.costKnowledge = costKnowledge;
  }

  recentTurns(count = 8): ChatTurn[] {
    return this.#data.turns.slice(-count);
  }

  transcript(): string {
    return redactText(this.#data.turns
      .map((turn) => `${turn.role === "user" ? "USER" : "ASSISTANT"}:\n${turn.content}`)
      .join("\n\n"));
  }

  snapshotRunState(): SessionRunSnapshot {
    return { data: structuredClone(this.#data) };
  }

  /** Restores staged chat data while retaining provider charges incurred after the snapshot. */
  restoreRunState(snapshot: SessionRunSnapshot): void {
    const current = this.#data;
    const restored = structuredClone(snapshot.data);
    const mainDelta = Math.max(0, current.costs.mainUsd - restored.costs.mainUsd);
    const compressorDelta = Math.max(
      0,
      current.costs.compressorUsd - restored.costs.compressorUsd,
    );
    const voiceDelta = Math.max(0, current.costs.voiceUsd - restored.costs.voiceUsd);
    restored.costs.mainUsd += mainDelta;
    restored.costs.compressorUsd += compressorDelta;
    restored.costs.voiceUsd += voiceDelta;
    restored.costs.totalUsd =
      restored.costs.mainUsd + restored.costs.compressorUsd + restored.costs.voiceUsd;
    restored.costs.costKnowledge = knowledgeOf(current.costs) === "unknown"
      || knowledgeOf(restored.costs) === "unknown"
      ? "unknown"
      : "known";
    const days = new Set([
      ...Object.keys(restored.dailySpendUsd),
      ...Object.keys(current.dailySpendUsd),
    ]);
    for (const day of days) {
      const delta = Math.max(
        0,
        (current.dailySpendUsd[day] ?? 0) -
          (snapshot.data.dailySpendUsd[day] ?? 0),
      );
      if (delta > 0) {
        restored.dailySpendUsd[day] =
          (restored.dailySpendUsd[day] ?? 0) + delta;
      }
    }
    restored.dailySpendUsd = pruneSpend(restored.dailySpendUsd);
    this.#data = restored;
  }

  recordToolCall(name: string, summary = ""): SessionToolCall {
    const call: SessionToolCall = {
      name: name.trim().slice(0, 80) || "unbekannt",
      summary: summary.replace(/\s+/g, " ").trim().slice(0, 300),
      turnIndex: this.#data.turns.length,
      at: new Date().toISOString(),
    };
    this.#data.toolCalls.push(call);
    if (this.#data.toolCalls.length > MAX_TOOL_CALLS) {
      this.#data.toolCalls = this.#data.toolCalls.slice(-MAX_TOOL_CALLS);
    }
    return call;
  }

  createCheckpoint(label = ""): SessionCheckpoint {
    const checkpoint: SessionCheckpoint = {
      id: randomUUID(),
      label: normalizeCheckpointLabel(label, this.#data.turns.length),
      turnIndex: this.#data.turns.length,
      costUsd: this.#data.costs.totalUsd,
      costKnowledge: knowledgeOf(this.#data.costs),
      createdAt: new Date().toISOString(),
    };
    this.#data.checkpoints.push(checkpoint);
    if (this.#data.checkpoints.length > MAX_CHECKPOINTS) {
      this.#data.checkpoints = this.#data.checkpoints.slice(-MAX_CHECKPOINTS);
    }
    this.#data.updatedAt = new Date().toISOString();
    return checkpoint;
  }

  listCheckpoints(): SessionCheckpoint[] {
    return this.#data.checkpoints.map((checkpoint) => ({ ...checkpoint }));
  }

  findCheckpoint(reference: string): SessionCheckpoint | null {
    const needle = reference.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const byId = this.#data.checkpoints.find(
      (checkpoint) => checkpoint.id.toLowerCase() === needle,
    );
    const byLabel = this.#data.checkpoints.find(
      (checkpoint) => checkpoint.label.toLowerCase() === needle,
    );
    const byPrefix = this.#data.checkpoints.find((checkpoint) =>
      checkpoint.id.toLowerCase().startsWith(needle),
    );
    const found = byId ?? byLabel ?? byPrefix;
    return found ? { ...found } : null;
  }

  /**
   * Rewinds the transcript to a checkpoint. Costs stay where they are: the
   * money was spent and the budget must keep seeing it.
   */
  restoreCheckpoint(reference: string): SessionCheckpoint {
    const checkpoint = this.findCheckpoint(reference);
    if (!checkpoint) {
      throw new Error(`Checkpoint nicht gefunden: ${reference}`);
    }
    this.#data.turns = this.#data.turns.slice(0, checkpoint.turnIndex);
    // Turn index alone is ambiguous at the checkpoint's own index, timestamps
    // alone are ambiguous within one millisecond — a call has to satisfy both.
    this.#data.toolCalls = this.#data.toolCalls.filter(
      (call) =>
        call.turnIndex <= checkpoint.turnIndex &&
        Date.parse(call.at) <= Date.parse(checkpoint.createdAt),
    );
    this.#data.checkpoints = this.#data.checkpoints.filter(
      (candidate) =>
        Date.parse(candidate.createdAt) <= Date.parse(checkpoint.createdAt),
    );
    this.#data.updatedAt = new Date().toISOString();
    return checkpoint;
  }

  exportMarkdown(): string {
    return exportSessionMarkdown(this.#data);
  }

  /**
   * Writes the chat without ever losing a concurrently written turn (B14):
   * an advisory lock keeps two instances apart, and a three-way merge against
   * the file on disk catches everything the lock cannot (stolen lock, crash,
   * network filesystem).
   */
  async save(): Promise<SaveOutcome> {
    return enqueueWrite(this.path, () => this.#writeNow());
  }

  async #writeNow(): Promise<SaveOutcome> {
    await ensureSecureDirectory(this.appHome);
    await ensureSecureDirectory(dirname(this.path));
    const release = await acquireChatLock(this.path);
    try {
      const foreign = await readForeign(
        this.path,
        this.#data.workspace,
        this.#data.id,
      );
      let merged = false;
      let conflictBackupPath: string | null = null;

      if (foreign.kind === "data") {
        if (
          this.#pendingLegacyRouteProjection
          && foreign.data.route !== undefined
          && this.#hasOnlyPendingLegacyRouteProjection()
        ) {
          // A real route published by another window is authoritative over a
          // read-time projection and requires no duplicate write.
          this.#data = structuredClone(foreign.data);
          this.#base = structuredClone(foreign.data);
          this.#pendingLegacyRouteProjection = false;
          return {
            merged: false,
            conflictBackupPath: null,
            revision: foreign.revision,
          };
        }
        if (this.#pendingLegacyRouteProjection && foreign.data.route !== undefined) {
          this.#data.route = structuredClone(foreign.data.route);
          this.#pendingLegacyRouteProjection = false;
        }
        if (
          sameValue(this.#data, this.#base)
          && !this.#pendingLegacyRouteProjection
        ) {
          // A stale but locally unchanged window has nothing to contribute.
          // Adopt the locked readback exactly instead of merging it into a new
          // revision and churning an otherwise stable file.
          this.#data = structuredClone(foreign.data);
          this.#base = structuredClone(foreign.data);
          return {
            merged: false,
            conflictBackupPath: null,
            revision: foreign.revision,
          };
        }
        if (fingerprint(foreign.data) !== fingerprint(this.#base)) {
          this.#data = mergeSessions(this.#base, this.#data, foreign.data);
          merged = true;
        }
      } else if (foreign.kind === "unreadable") {
        // Never overwrite a file we could not understand. Keep it next to the
        // chat so the user can look at it instead of losing it silently.
        conflictBackupPath = CHAT_ARTIFACT_REGISTRY.resolve("chat-conflict", {
          appHome: this.appHome,
          workspace: this.#data.workspace,
          chatId: this.#data.id,
          chatFilePath: this.path,
          conflictId: conflictStamp(),
        });
        await new PrivateStore({ root: this.appHome }).writeTextAtomic(
          conflictBackupPath,
          foreign.raw,
        );
      }

      this.#data.revision = Math.max(this.#data.revision, foreign.revision) + 1;
      const persisted = redactValue(this.#data);
      await writeFileAtomicSecure(
        this.path,
        `${JSON.stringify(persisted, null, 2)}\n`,
      );
      this.#base = structuredClone(this.#data);
      this.#pendingLegacyRouteProjection = false;
      return { merged, conflictBackupPath, revision: this.#data.revision };
    } finally {
      await release();
    }
  }

  #hasOnlyPendingLegacyRouteProjection(): boolean {
    if (!this.#pendingLegacyRouteProjection) return false;
    const withoutProjection = structuredClone(this.#data);
    delete withoutProjection.route;
    return sameValue(withoutProjection, this.#base);
  }
}

export interface ChatSearchHit {
  chat: ChatSummary;
  titleMatch: boolean;
  snippet: string;
}

export interface ChatMatch {
  chat: ChatSummary;
  score: number;
}

const SCORE_EXACT_ID = 100;
const SCORE_EXACT_TITLE = 90;
const SCORE_ID_PREFIX = 70;
const SCORE_TITLE_PREFIX = 60;
const SCORE_TITLE_CONTAINS = 40;

export function rankChatMatches(
  chats: ChatSummary[],
  query: string,
): ChatMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const matches: ChatMatch[] = [];
  for (const chat of chats) {
    const id = chat.id.toLowerCase();
    const title = chat.title.toLowerCase();
    let score = 0;
    if (id === normalized) {
      score = SCORE_EXACT_ID;
    } else if (title === normalized) {
      score = SCORE_EXACT_TITLE;
    } else if (id.startsWith(normalized)) {
      score = SCORE_ID_PREFIX;
    } else if (title.startsWith(normalized)) {
      score = SCORE_TITLE_PREFIX;
    } else if (title.includes(normalized)) {
      score = SCORE_TITLE_CONTAINS;
    }
    if (score > 0) {
      matches.push({ chat, score });
    }
  }
  return matches.sort(
    (left, right) =>
      right.score - left.score ||
      Date.parse(right.chat.updatedAt) - Date.parse(left.chat.updatedAt),
  );
}

export interface WorkspaceSpend {
  /** local day, YYYY-MM-DD */
  day: string;
  dayUsd: number;
  totalUsd: number;
  costKnowledge: CostKnowledge;
  chatCount: number;
}

/**
 * "How much did this workspace spend today?" — read only, so it is safe to call
 * before every run. Enforcement lives in the agent layer.
 */
export async function workspaceSpend(
  workspace: string,
  appHome = APP_HOME,
  day = dayKey(),
): Promise<WorkspaceSpend> {
  const sessions = await loadAllSessions(workspace, appHome);
  let dayUsd = 0;
  let totalUsd = 0;
  let costKnowledge: CostKnowledge = "known";
  for (const session of sessions) {
    dayUsd += session.dailySpendUsd[day] ?? 0;
    totalUsd += session.costs.totalUsd;
    if (knowledgeOf(session.costs) === "unknown") costKnowledge = "unknown";
  }
  return {
    day,
    dayUsd: roundUsd(dayUsd),
    totalUsd: roundUsd(totalUsd),
    costKnowledge,
    chatCount: sessions.length,
  };
}

export type SessionExportInput = SessionData &
  Partial<Omit<PersistedSessionData, keyof SessionData>>;

/** Renders a chat as readable Markdown (used by a later `/export` command). */
export function exportSessionMarkdown(data: SessionExportInput): string {
  const checkpoints = data.checkpoints ?? [];
  const toolCalls = data.toolCalls ?? [];
  const lines: string[] = [];

  lines.push(`# ${data.title}`, "");
  lines.push("## Metadaten", "");
  lines.push(`- Chat-ID: \`${data.id}\``);
  lines.push(`- Workspace: \`${data.workspace}\``);
  lines.push(`- Modell: ${data.model ?? "nicht festgelegt"}`);
  lines.push(`- Reasoning: ${describeReasoning(data.reasoning)}`);
  lines.push(`- Erstellt: ${formatTimestamp(data.createdAt)}`);
  lines.push(`- Aktualisiert: ${formatTimestamp(data.updatedAt)}`);
  lines.push(`- Nachrichten: ${data.turns.length}`);
  if (knowledgeOf(data.costs) === "unknown") {
    lines.push(`- Kosten: ${formatUnknownCost(data.costs.totalUsd)}`);
  } else {
    lines.push(
      `- Kosten: gesamt ${formatUsd(data.costs.totalUsd)} (Hauptmodell ${formatUsd(data.costs.mainUsd)}, Kompressor ${formatUsd(data.costs.compressorUsd)}, Transkription ${formatUsd(data.costs.voiceUsd)})`,
    );
  }
  lines.push("");

  if (data.summary.trim()) {
    lines.push("## Zusammenfassung", "", redactSensitive(data.summary.trim()), "");
  }

  if (checkpoints.length) {
    lines.push("## Checkpoints", "");
    for (const checkpoint of checkpoints) {
      lines.push(
        `- **${checkpoint.label}** — nach Nachricht ${checkpoint.turnIndex}, ${formatTimestamp(checkpoint.createdAt)}, ${knowledgeOf(checkpoint) === "unknown" ? formatUnknownCost(checkpoint.costUsd) : formatUsd(checkpoint.costUsd)}`,
      );
    }
    lines.push("");
  }

  lines.push("## Verlauf", "");
  if (!data.turns.length) {
    lines.push("_Keine Nachrichten._", "");
  }
  data.turns.forEach((turn, index) => {
    appendToolCalls(lines, toolCalls, index);
    lines.push(
      `### ${index + 1}. ${turn.role === "user" ? "Du" : "Assistent"} — ${formatTimestamp(turn.createdAt)}`,
      "",
      redactSensitive(turn.content).trim() || "_leer_",
      "",
    );
  });
  appendToolCalls(
    lines,
    toolCalls.filter((call) => call.turnIndex >= data.turns.length),
    data.turns.length,
    true,
  );

  return redactText(`${lines.join("\n").trimEnd()}\n`);
}

function appendToolCalls(
  lines: string[],
  toolCalls: readonly SessionToolCall[],
  turnIndex: number,
  trailing = false,
): void {
  const relevant = trailing
    ? [...toolCalls]
    : toolCalls.filter((call) => call.turnIndex === turnIndex);
  if (!relevant.length) {
    return;
  }
  lines.push("#### Werkzeugaufrufe", "");
  for (const call of relevant) {
    lines.push(
      `- \`${call.name}\`${call.summary ? ` — ${call.summary}` : ""} (${formatTimestamp(call.at)})`,
    );
  }
  lines.push("");
}

/**
 * Imports a v1 session file exactly once and marks the source afterwards, so a
 * chat the user deleted stays deleted (B15).
 */
export async function migrateLegacySession(
  workspace: string,
  appHome = APP_HOME,
): Promise<SessionStore | null> {
  const workspaceId = workspaceHash(workspace);
  const path = join(appHome, "sessions", `${workspaceId}.json`);
  const marker = `${path}${LEGACY_MIGRATED_SUFFIX}`;
  if (await exists(marker)) {
    return null;
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    raw = parsed;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }

  if (
    raw.version !== 1 ||
    raw.workspace !== workspace ||
    !Array.isArray(raw.turns)
  ) {
    return null;
  }

  const id = `legacy-${workspaceId}`;
  const target = chatPath(appHome, workspace, id);
  if (await exists(target)) {
    // Already imported by an older build: only the marker is missing.
    await markLegacyMigrated(path, marker);
    return null;
  }

  const turns = normalizeTurns(raw.turns);
  const updatedAt = validDate(raw.updatedAt) ?? new Date().toISOString();
  const createdAt = turns[0]?.createdAt ?? updatedAt;
  const data: PersistedSessionData = {
    ...emptySession(workspace, id, titleFromTurns(turns)),
    summary: typeof raw.summary === "string" ? raw.summary : "",
    turns,
    costs: normalizeCosts(raw.costs),
    createdAt,
    updatedAt,
  };
  const migrated = new SessionStore(appHome, target, data);
  await migrated.save();
  await markLegacyMigrated(path, marker);
  return migrated;
}

async function markLegacyMigrated(path: string, marker: string): Promise<void> {
  try {
    // Renaming keeps the original content around under the marker name.
    await rename(path, marker);
    return;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
  }
  try {
    await writeFile(
      marker,
      `Migriert am ${new Date().toISOString()}. Diese Datei verhindert einen erneuten Import.\n`,
      { encoding: "utf8", mode: SECURE_FILE_MODE, flag: "wx" },
    );
  } catch {
    // Best effort: without a marker the import would repeat, but nothing is lost.
  }
}

async function loadAllSessions(
  workspace: string,
  appHome: string,
  providerConnection?: ProviderConnectionStateV1,
): Promise<PersistedSessionData[]> {
  const directory = chatDirectory(appHome, workspace);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      files = [];
    } else {
      throw error;
    }
  }

  const sessions: PersistedSessionData[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const id = file.slice(0, -5);
    try {
      assertChatId(id);
      const parsed = normalizeSession(
        JSON.parse(await readFile(join(directory, file), "utf8")),
        workspace,
        id,
        providerConnection,
      );
      if (parsed) {
        sessions.push(parsed);
      }
    } catch {
      // A damaged chat must not make every other chat inaccessible.
    }
  }
  return sessions.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

function buildSnippet(
  content: string,
  normalizedQuery: string,
  radius = 60,
): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  const index = collapsed.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) {
    return "";
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(
    collapsed.length,
    index + normalizedQuery.length + radius,
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}

function emptySession(
  workspace: string,
  id: string,
  title: string,
): PersistedSessionData {
  const now = new Date().toISOString();
  return {
    version: 2,
    id,
    title,
    workspace,
    summary: "",
    turns: [],
    costs: {
      mainUsd: 0,
      compressorUsd: 0,
      voiceUsd: 0,
      totalUsd: 0,
      costKnowledge: "known",
    },
    revision: 0,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: now,
    updatedAt: now,
  };
}

function withPersistenceFields(data: SessionData): PersistedSessionData {
  const candidate = data as Partial<PersistedSessionData> & SessionData;
  return {
    ...data,
    costs: normalizeCosts(data.costs),
    revision: nonNegativeInteger(candidate.revision),
    checkpoints: normalizeCheckpoints(candidate.checkpoints),
    toolCalls: normalizeToolCalls(candidate.toolCalls),
    dailySpendUsd: normalizeSpend(candidate.dailySpendUsd),
  };
}

function normalizeSession(
  value: unknown,
  workspace: string,
  id: string,
  providerConnection?: ProviderConnectionStateV1,
): PersistedSessionData | null {
  if (!isRecord(value) || value.version !== 2) {
    return null;
  }
  if (
    (value.workspace !== workspace && value.workspace !== redactText(workspace)) ||
    value.id !== id
  ) {
    return null;
  }
  const turns = normalizeTurns(value.turns);
  const updatedAt = validDate(value.updatedAt) ?? new Date().toISOString();
  const createdAt = validDate(value.createdAt) ?? turns[0]?.createdAt ?? updatedAt;
  const model = typeof value.model === "string" && value.model.trim()
    ? value.model.trim()
    : null;
  if (value.routeCleared !== undefined && value.routeCleared !== true) {
    return null;
  }
  const routeCleared = value.routeCleared === true;
  let route: RouteIdentityV1 | null;
  if (value.route !== undefined) {
    // A chat that carries a route key owns exactly that identity. A partial,
    // future, or foreign-shaped route — or a model the route does not own —
    // is corrupt state: fail closed rather than drop the route and let the
    // model string be re-bound to whatever backend is the current default.
    route = persistableSessionRoute(value.route);
    if (routeCleared || route === null || model === null || !routeOwnsModel(route, model)) {
      return null;
    }
  } else {
    route = !routeCleared
      && model !== null
      && isActiveMigratedOpenRouterConnection(providerConnection)
      ? mapLegacyOpenRouterModel(model, providerConnection)
      : null;
  }
  return {
    version: 2,
    id,
    title: normalizeTitle(value.title),
    workspace,
    summary: typeof value.summary === "string" ? value.summary : "",
    turns,
    costs: normalizeCosts(value.costs),
    revision: nonNegativeInteger(value.revision),
    checkpoints: normalizeCheckpoints(value.checkpoints),
    toolCalls: normalizeToolCalls(value.toolCalls),
    dailySpendUsd: normalizeSpend(value.dailySpendUsd),
    ...(model !== null
      ? { model }
      : {}),
    ...(route !== null ? { route } : {}),
    ...(routeCleared ? { routeCleared: true as const } : {}),
    ...(isReasoningSetting(value.reasoning)
      ? { reasoning: structuredClone(value.reasoning) }
      : {}),
    createdAt,
    updatedAt,
  };
}

/** The closed own-key set of `RouteIdentityV1`; nothing else may enter a chat file. */
const ROUTE_IDENTITY_V1_KEYS: ReadonlySet<string> = new Set<keyof RouteIdentityV1>([
  "version",
  "backendId",
  "accountFingerprint",
  "billingRealm",
  "requestedModelId",
  "canonicalModelId",
  "resolutionState",
]);

/**
 * A route the chat file may own. Beyond the shared shape check, the route must
 * carry exactly the known own keys (an extra future or credential-like field is
 * never persisted, reopened, or echoed), and only the migrated OpenRouter
 * connection ever produces a `legacy-unverified` route; any other backend must
 * be fully resolved or it is not a runnable identity.
 */
function persistableSessionRoute(value: unknown): RouteIdentityV1 | null {
  const route = validateRouteIdentityV1(value);
  if (route === null) {
    return null;
  }
  if (Object.keys(route).some((key) => !ROUTE_IDENTITY_V1_KEYS.has(key))) {
    return null;
  }
  if (route.backendId !== "openrouter" && route.resolutionState !== "resolved") {
    return null;
  }
  return route;
}

function routeOwnsModel(route: RouteIdentityV1, model: string): boolean {
  return model === route.requestedModelId || model === route.canonicalModelId;
}

function isActiveMigratedOpenRouterConnection(
  value: ProviderConnectionStateV1 | undefined,
): value is ProviderConnectionStateV1 {
  return value?.backendId === "openrouter"
    && value.enabled
    && value.credentialSlot === "legacy:inference";
}

function normalizeTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (turn): turn is Record<string, unknown> =>
        isRecord(turn) &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string",
    )
    .slice(-MAX_TURNS)
    .map((turn) => ({
      role: turn.role as ChatTurn["role"],
      content: String(turn.content),
      createdAt: validDate(turn.createdAt) ?? new Date().toISOString(),
    }));
}

function normalizeCheckpoints(value: unknown): SessionCheckpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SessionCheckpoint[] = [];
  for (const candidate of value.slice(-MAX_CHECKPOINTS)) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      continue;
    }
    const createdAt = validDate(candidate.createdAt);
    if (!createdAt) {
      continue;
    }
    result.push({
      id: candidate.id.slice(0, 80),
      label: normalizeCheckpointLabel(
        typeof candidate.label === "string" ? candidate.label : "",
        nonNegativeInteger(candidate.turnIndex),
      ),
      turnIndex: nonNegativeInteger(candidate.turnIndex),
      costUsd: nonNegativeNumber(candidate.costUsd),
      costKnowledge: candidate.costKnowledge === "unknown" ? "unknown" : "known",
      createdAt,
    });
  }
  return result;
}

function normalizeToolCalls(value: unknown): SessionToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SessionToolCall[] = [];
  for (const candidate of value.slice(-MAX_TOOL_CALLS)) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") {
      continue;
    }
    const at = validDate(candidate.at);
    if (!at) {
      continue;
    }
    result.push({
      name: candidate.name.slice(0, 80),
      summary: (typeof candidate.summary === "string" ? candidate.summary : "").slice(0, 300),
      turnIndex: nonNegativeInteger(candidate.turnIndex),
      at,
    });
  }
  return result;
}

function normalizeSpend(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [day, amount] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }
    const usdAmount = nonNegativeNumber(amount);
    if (usdAmount > 0) {
      result[day] = usdAmount;
    }
  }
  return pruneSpend(result);
}

function pruneSpend(value: Record<string, number>): Record<string, number> {
  const days = Object.keys(value).sort();
  if (days.length <= SPEND_HISTORY_DAYS) {
    return value;
  }
  const result: Record<string, number> = {};
  for (const day of days.slice(-SPEND_HISTORY_DAYS)) {
    result[day] = value[day] as number;
  }
  return result;
}

function normalizeCosts(value: unknown): CostLedger {
  const costs = isRecord(value) ? value : {};
  const mainUsd = nonNegativeNumber(costs.mainUsd);
  const compressorUsd = nonNegativeNumber(costs.compressorUsd);
  const voiceUsd = nonNegativeNumber(costs.voiceUsd);
  return {
    mainUsd,
    compressorUsd,
    voiceUsd,
    totalUsd: mainUsd + compressorUsd + voiceUsd,
    costKnowledge: costs.costKnowledge === "unknown" ? "unknown" : "known",
  };
}

function toSummary(data: PersistedSessionData): ChatSummary {
  return {
    id: data.id,
    title: data.title,
    workspace: data.workspace,
    turnCount: data.turns.length,
    costUsd: data.costs.totalUsd,
    costKnowledge: knowledgeOf(data.costs),
    model: data.model,
    route: data.route ? structuredClone(data.route) : undefined,
    reasoning: data.reasoning,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function chatDirectory(appHome: string, workspace: string): string {
  return join(appHome, "chats", workspaceHash(workspace));
}

function chatPath(appHome: string, workspace: string, id: string): string {
  return CHAT_ARTIFACT_REGISTRY.resolve("chat", {
    appHome,
    workspace,
    chatId: id,
  });
}

function workspaceHash(workspace: string): string {
  return workspaceStorageHash(workspace);
}

function assertChatId(id: string): void {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
    throw new Error("Ungültige Chat-ID.");
  }
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_TITLE;
  }
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 80) : DEFAULT_TITLE;
}

function normalizeCheckpointLabel(value: string, turnIndex: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 60) : `Checkpoint bei Nachricht ${turnIndex}`;
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt
    .replace(/[`*_#>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 56) : DEFAULT_TITLE;
}

function titleFromTurns(turns: ChatTurn[]): string {
  const firstUser = turns.find((turn) => turn.role === "user");
  return firstUser ? titleFromPrompt(firstUser.content) : "Bisheriger Chat";
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function knowledgeOf(value: { readonly costKnowledge?: unknown }): CostKnowledge {
  return value.costKnowledge === "unknown" ? "unknown" : "known";
}

function formatUnknownCost(knownAmount: number): string {
  return knownAmount > 0
    ? `mindestens ${formatUsd(knownAmount)}; weitere providerverwaltete Kosten sind unbekannt`
    : "providerverwaltet / unbekannt";
}

function describeReasoning(reasoning: ReasoningSetting | undefined): string {
  if (!reasoning) {
    return "nicht festgelegt";
  }
  if (reasoning.mode === "auto") {
    return "automatisch";
  }
  if (reasoning.mode === "effort") {
    return `Aufwand ${reasoning.effort}`;
  }
  return `Budget ${reasoning.maxTokens} Tokens`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isReasoningSetting(value: unknown): value is ReasoningSetting {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "auto") {
    return true;
  }
  if (value.mode === "effort") {
    return (
      typeof value.effort === "string" &&
      REASONING_EFFORTS.includes(
        value.effort as (typeof REASONING_EFFORTS)[number],
      )
    );
  }
  return (
    value.mode === "budget" &&
    Number.isInteger(value.maxTokens) &&
    Number(value.maxTokens) > 0 &&
    Number(value.maxTokens) <= 1_000_000
  );
}

/* ------------------------------------------------------------------ *
 * Concurrency: in-process queue, advisory lock, three-way merge (B14)
 * ------------------------------------------------------------------ */

const writeQueues = new Map<string, Promise<unknown>>();

/** Serialises writes to the same file inside one process. */
function enqueueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.then(task, task);
  const guarded = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(path, guarded);
  void guarded.then(() => {
    if (writeQueues.get(path) === guarded) {
      writeQueues.delete(path);
    }
  });
  return next;
}

export function chatLockPath(chatFilePath: string): string {
  return `${chatFilePath}.lock`;
}

interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

async function acquireChatLock(
  target: string,
): Promise<() => Promise<void>> {
  const lockPath = chatLockPath(target);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", SECURE_FILE_MODE);
      try {
        const info: LockInfo = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: hostname(),
        };
        await handle.writeFile(JSON.stringify(info));
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    if (await removeStaleLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      // The holder is alive but wedged. Breaking the lock is safe because the
      // write below re-reads the file and merges; waiting forever would drop
      // the turn that is currently in memory.
      await unlink(lockPath).catch(() => {});
      continue;
    }
    await delay(LOCK_POLL_MS);
  }
  throw new Error(
    `Chatdatei ist dauerhaft gesperrt: ${lockPath}. Bitte die Datei prüfen und ggf. löschen.`,
  );
}

/** Removes a lock whose owner is gone or which is older than LOCK_STALE_MS. */
async function removeStaleLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
  let info: LockInfo | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.pid === "number") {
      info = {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        host: typeof parsed.host === "string" ? parsed.host : "",
      };
    }
  } catch {
    info = null;
  }
  const age = info?.startedAt ? Date.now() - Date.parse(info.startedAt) : NaN;
  const stale =
    !info ||
    !Number.isFinite(age) ||
    age > LOCK_STALE_MS ||
    (info.host === hostname() && !isProcessAlive(info.pid));
  if (!stale) {
    return false;
  }
  await unlink(lockPath).catch(() => {});
  return true;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    // Our own writes are serialised by enqueueWrite, so a lock carrying our pid
    // is left over from a crashed run.
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type ForeignState =
  | { kind: "missing"; revision: number }
  | { kind: "unreadable"; revision: number; raw: string }
  | { kind: "data"; revision: number; data: PersistedSessionData };

async function readForeign(
  path: string,
  workspace: string,
  id: string,
): Promise<ForeignState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { kind: "missing", revision: 0 };
    }
    throw error;
  }
  try {
    const parsed = normalizeSession(JSON.parse(raw), workspace, id);
    if (parsed) {
      return { kind: "data", revision: parsed.revision, data: parsed };
    }
  } catch {
    // handled below
  }
  return { kind: "unreadable", revision: 0, raw };
}

/** Cheap change detector; covers files written by builds without `revision`. */
function fingerprint(data: PersistedSessionData): string {
  const projected = redactValue(data);
  return [
    projected.revision,
    projected.turns.length,
    projected.costs.totalUsd,
    knowledgeOf(projected.costs),
    projected.updatedAt,
    projected.checkpoints.length,
    projected.toolCalls.length,
    projected.title,
    projected.summary.length,
  ].join("|");
}

function conflictStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Three-way merge. Turns are append-only, so foreign turns are added while our
 * own deliberate removals (compaction, checkpoint restore) survive. Costs are
 * added as deltas instead of being replaced.
 */
export function mergeSessions(
  base: PersistedSessionData,
  mine: PersistedSessionData,
  theirs: PersistedSessionData,
): PersistedSessionData {
  const turns = mergeTurns(base.turns, mine.turns, theirs.turns);
  return {
    version: 2,
    id: mine.id,
    workspace: mine.workspace,
    title: pickField(base.title, mine.title, theirs.title),
    summary: pickField(base.summary, mine.summary, theirs.summary),
    turns,
    costs: mergeCosts(base.costs, mine.costs, theirs.costs),
    revision: Math.max(mine.revision, theirs.revision),
    checkpoints: mergeKeyed(
      base.checkpoints,
      mine.checkpoints,
      theirs.checkpoints,
      (checkpoint) => checkpoint.id,
      (checkpoint) => Date.parse(checkpoint.createdAt),
      MAX_CHECKPOINTS,
    ),
    toolCalls: mergeKeyed(
      base.toolCalls,
      mine.toolCalls,
      theirs.toolCalls,
      (call) =>
        `${call.at}|${redactText(call.name)}|${call.turnIndex}|${redactText(call.summary)}`,
      (call) => Date.parse(call.at),
      MAX_TOOL_CALLS,
    ),
    dailySpendUsd: mergeSpend(
      base.dailySpendUsd,
      mine.dailySpendUsd,
      theirs.dailySpendUsd,
    ),
    ...mergeSessionIdentity(base, mine, theirs),
    ...(pickField(base.reasoning, mine.reasoning, theirs.reasoning) !== undefined
      ? { reasoning: pickField(base.reasoning, mine.reasoning, theirs.reasoning) }
      : {}),
    createdAt: earlier(mine.createdAt, theirs.createdAt),
    updatedAt: later(mine.updatedAt, theirs.updatedAt),
  };
}

interface SessionIdentity {
  model?: string;
  route?: RouteIdentityV1;
  routeCleared?: true;
}

/**
 * Model and route are one identity: the route owns the model, so the merge
 * must never combine one window's model with another window's route.
 */
function sessionIdentity(data: PersistedSessionData): SessionIdentity {
  return {
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.route !== undefined ? { route: data.route } : {}),
    ...(data.routeCleared ? { routeCleared: true as const } : {}),
  };
}

/**
 * An exact-route lifecycle tombstone defeats a stale window that still owns
 * the route from its base. A genuinely different explicit route remains a
 * valid concurrent rebind and is not swallowed by clearing the old tuple.
 */
function mergeSessionIdentity(
  base: PersistedSessionData,
  mine: PersistedSessionData,
  theirs: PersistedSessionData,
): SessionIdentity {
  if (base.route !== undefined) {
    const mineRetainsBaseRoute = samePersistableSessionRoute(mine.route, base.route);
    const theirsRetainsBaseRoute = samePersistableSessionRoute(theirs.route, base.route);
    if (theirs.routeCleared && mineRetainsBaseRoute) return sessionIdentity(theirs);
    if (mine.routeCleared && theirsRetainsBaseRoute) return sessionIdentity(mine);
    if (mine.routeCleared && theirs.route !== undefined && !theirsRetainsBaseRoute) {
      return sessionIdentity(theirs);
    }
    if (theirs.routeCleared && mine.route !== undefined && !mineRetainsBaseRoute) {
      return sessionIdentity(mine);
    }
  }
  return pickField(sessionIdentity(base), sessionIdentity(mine), sessionIdentity(theirs));
}

/** Replaces the complete provider/model identity without mixing either side. */
function adoptSessionIdentity(
  target: PersistedSessionData,
  authoritative: PersistedSessionData,
): void {
  delete target.model;
  delete target.route;
  delete target.routeCleared;
  if (authoritative.model !== undefined) target.model = authoritative.model;
  if (authoritative.route !== undefined) {
    target.route = structuredClone(authoritative.route);
  }
  if (authoritative.routeCleared) target.routeCleared = true;
}

/** Preserves the user's model label while durably blocking legacy/default rebinding. */
function markRouteCleared(data: PersistedSessionData): void {
  delete data.route;
  data.routeCleared = true;
}

function pickField<T>(base: T, mine: T, theirs: T): T {
  if (!sameValue(mine, base)) {
    return mine;
  }
  return sameRedactedProjection(theirs, base) ? mine : theirs;
}

function sameExactResolvedRoute(
  candidate: unknown,
  expected: RouteIdentityV1,
): boolean {
  const current = persistableSessionRoute(candidate);
  const exact = persistableSessionRoute(expected);
  return current?.resolutionState === "resolved"
    && current.canonicalModelId !== null
    && exact?.resolutionState === "resolved"
    && exact.canonicalModelId !== null
    && samePersistableSessionRoute(current, exact);
}

/** Closed, insertion-order-independent equality for the seven route fields. */
function samePersistableSessionRoute(left: unknown, right: unknown): boolean {
  const current = persistableSessionRoute(left);
  const expected = persistableSessionRoute(right);
  return current !== null
    && expected !== null
    && current.version === expected.version
    && current.backendId === expected.backendId
    && current.accountFingerprint === expected.accountFingerprint
    && current.billingRealm === expected.billingRealm
    && current.requestedModelId === expected.requestedModelId
    && current.canonicalModelId === expected.canonicalModelId
    && current.resolutionState === expected.resolutionState;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRedactedProjection(left: unknown, right: unknown): boolean {
  return JSON.stringify(redactValue(left)) === JSON.stringify(redactValue(right));
}

function turnKey(turn: ChatTurn): string {
  return JSON.stringify([
    turn.createdAt,
    turn.role,
    redactText(turn.content),
  ]);
}

function mergeTurns(
  base: readonly ChatTurn[],
  mine: readonly ChatTurn[],
  theirs: readonly ChatTurn[],
): ChatTurn[] {
  const baseCount = countKeys(base, turnKey);
  const seen = new Map<string, number>();
  const extras: ChatTurn[] = [];
  for (const turn of theirs) {
    const key = turnKey(turn);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    if (index > (baseCount.get(key) ?? 0)) {
      extras.push({ ...turn });
    }
  }
  return [...mine.map((turn) => ({ ...turn })), ...extras]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-MAX_TURNS);
}

function countKeys<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function mergeCosts(
  base: CostLedger,
  mine: CostLedger,
  theirs: CostLedger,
): CostLedger {
  const mainUsd = Math.max(0, roundUsd(theirs.mainUsd + (mine.mainUsd - base.mainUsd)));
  const compressorUsd = Math.max(
    0,
    roundUsd(theirs.compressorUsd + (mine.compressorUsd - base.compressorUsd)),
  );
  const voiceUsd = Math.max(0, roundUsd(theirs.voiceUsd + (mine.voiceUsd - base.voiceUsd)));
  const costKnowledge = knowledgeOf(base) === "unknown"
    || knowledgeOf(mine) === "unknown"
    || knowledgeOf(theirs) === "unknown"
    ? "unknown"
    : "known";
  return {
    mainUsd,
    compressorUsd,
    voiceUsd,
    totalUsd: roundUsd(mainUsd + compressorUsd + voiceUsd),
    costKnowledge,
  };
}

function mergeSpend(
  base: Record<string, number>,
  mine: Record<string, number>,
  theirs: Record<string, number>,
): Record<string, number> {
  const days = new Set([
    ...Object.keys(base),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ]);
  const result: Record<string, number> = {};
  for (const day of days) {
    const value = roundUsd(
      (theirs[day] ?? 0) + ((mine[day] ?? 0) - (base[day] ?? 0)),
    );
    if (value > 0) {
      result[day] = value;
    }
  }
  return pruneSpend(result);
}

function mergeKeyed<T>(
  base: readonly T[],
  mine: readonly T[],
  theirs: readonly T[],
  key: (item: T) => string,
  order: (item: T) => number,
  limit: number,
): T[] {
  const baseCount = countKeys(base, key);
  const seen = new Map<string, number>();
  const extras = theirs.filter((item) => {
    const value = key(item);
    const index = (seen.get(value) ?? 0) + 1;
    seen.set(value, index);
    return index > (baseCount.get(value) ?? 0);
  });
  return [...mine, ...extras]
    .map((item) => ({ ...item }))
    .sort((left, right) => order(left) - order(right))
    .slice(-limit);
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return !hasCode(error, "ENOENT");
  }
}

export function redactSensitive(value: string): string {
  return redactText(value);
}

/** Stable identity of the exact redacted summary and transcript covered by SDK state. */
export function conversationHistoryDigest(
  data: Pick<SessionData, "summary" | "turns">,
): string {
  const canonical = {
    summary: redactText(data.summary),
    turns: data.turns.map((turn) => ({
      role: turn.role,
      content: redactText(turn.content),
      createdAt: turn.createdAt,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
