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
  type CostLedger,
  type ReasoningSetting,
  type SessionData,
} from "./types.js";
import { formatUsd, hasCode, isRecord } from "./utils.js";

const MAX_TURNS = 80;
const MAX_CHECKPOINTS = 50;
const MAX_TOOL_CALLS = 200;
const SPEND_HISTORY_DAYS = 90;
const DEFAULT_TITLE = "Neuer Chat";

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
}

export interface SaveOutcome {
  /** A concurrent instance had written to the file; both states were merged. */
  merged: boolean;
  /** Set when an unreadable foreign file was moved aside instead of destroyed. */
  conflictBackupPath: string | null;
  revision: number;
}

export class SessionStore {
  #data: PersistedSessionData;
  /** Last state known to be on disk; the base of the three-way merge. */
  #base: PersistedSessionData;
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
  ): Promise<SessionStore> {
    // The one explicit place where a v1 file is imported; list()/search() stay
    // read only (B15).
    await migrateLegacySession(workspace, appHome);
    const chats = await SessionStore.list(workspace, appHome);
    if (chats[0]) {
      return SessionStore.openById(workspace, chats[0].id, appHome);
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
  ): Promise<SessionStore> {
    assertChatId(id);
    const path = chatPath(appHome, workspace, id);
    try {
      const parsed = normalizeSession(
        JSON.parse(await readFile(path, "utf8")),
        workspace,
        id,
      );
      if (parsed) {
        return new SessionStore(appHome, path, parsed);
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
  ): Promise<void> {
    assertChatId(id);
    const path = chatPath(appHome, workspace, id);
    try {
      await unlink(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new Error(`Chat nicht gefunden: ${id}`);
      }
      throw error;
    }
    try {
      await unlink(chatLockPath(path));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }

  /** Read only: listing chats never writes to disk (B15). */
  static async list(
    workspace: string,
    appHome = APP_HOME,
  ): Promise<ChatSummary[]> {
    const sessions = await loadAllSessions(workspace, appHome);
    return sessions.map(toSummary);
  }

  /** Read only: searching never writes to disk (B15). */
  static async search(
    workspace: string,
    query: string,
    appHome = APP_HOME,
  ): Promise<ChatSearchHit[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    const sessions = await loadAllSessions(workspace, appHome);
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
      content: redactSensitive(content),
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

  setPreferences(model: string, reasoning: ReasoningSetting): void {
    this.#data.model = model.trim();
    this.#data.reasoning = structuredClone(reasoning);
    this.#data.updatedAt = new Date().toISOString();
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
    fork.#data.reasoning = this.#data.reasoning
      ? structuredClone(this.#data.reasoning)
      : undefined;
    await fork.save();
    return fork;
  }

  setSummary(summary: string): void {
    this.#data.summary = redactSensitive(summary);
    this.#data.updatedAt = new Date().toISOString();
  }

  compactTurns(keepRecent = 4): void {
    const keep = Math.max(0, Math.floor(keepRecent));
    this.#data.turns = keep === 0 ? [] : this.#data.turns.slice(-keep);
    this.#data.updatedAt = new Date().toISOString();
  }

  addCost(kind: "main" | "compressor" | "voice", amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) {
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
    const { id, title, workspace, model, reasoning, createdAt } = this.#data;
    this.#data = {
      ...emptySession(workspace, id, title),
      model,
      reasoning,
      createdAt,
      revision: this.#data.revision,
      dailySpendUsd: { ...this.#data.dailySpendUsd },
    };
  }

  recentTurns(count = 8): ChatTurn[] {
    return this.#data.turns.slice(-count);
  }

  transcript(): string {
    return this.#data.turns
      .map((turn) => `${turn.role === "user" ? "USER" : "ASSISTANT"}:\n${turn.content}`)
      .join("\n\n");
  }

  recordToolCall(name: string, summary = ""): SessionToolCall {
    const call: SessionToolCall = {
      name: name.trim().slice(0, 80) || "unbekannt",
      summary: redactSensitive(summary).replace(/\s+/g, " ").trim().slice(0, 300),
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
        if (fingerprint(foreign.data) !== fingerprint(this.#base)) {
          this.#data = mergeSessions(this.#base, this.#data, foreign.data);
          merged = true;
        }
      } else if (foreign.kind === "unreadable") {
        // Never overwrite a file we could not understand. Keep it next to the
        // chat so the user can look at it instead of losing it silently.
        conflictBackupPath = `${this.path}.konflikt-${conflictStamp()}.json`;
        await rename(this.path, conflictBackupPath);
      }

      this.#data.revision = Math.max(this.#data.revision, foreign.revision) + 1;
      await writeFileAtomicSecure(
        this.path,
        `${JSON.stringify(this.#data, null, 2)}\n`,
      );
      this.#base = structuredClone(this.#data);
      return { merged, conflictBackupPath, revision: this.#data.revision };
    } finally {
      await release();
    }
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
  for (const session of sessions) {
    dayUsd += session.dailySpendUsd[day] ?? 0;
    totalUsd += session.costs.totalUsd;
  }
  return {
    day,
    dayUsd: roundUsd(dayUsd),
    totalUsd: roundUsd(totalUsd),
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
  lines.push(
    `- Kosten: gesamt ${formatUsd(data.costs.totalUsd)} (Hauptmodell ${formatUsd(data.costs.mainUsd)}, Kompressor ${formatUsd(data.costs.compressorUsd)}, Transkription ${formatUsd(data.costs.voiceUsd)})`,
  );
  lines.push("");

  if (data.summary.trim()) {
    lines.push("## Zusammenfassung", "", redactSensitive(data.summary.trim()), "");
  }

  if (checkpoints.length) {
    lines.push("## Checkpoints", "");
    for (const checkpoint of checkpoints) {
      lines.push(
        `- **${checkpoint.label}** — nach Nachricht ${checkpoint.turnIndex}, ${formatTimestamp(checkpoint.createdAt)}, ${formatUsd(checkpoint.costUsd)}`,
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

  return `${lines.join("\n").trimEnd()}\n`;
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
    summary:
      typeof raw.summary === "string" ? redactSensitive(raw.summary) : "",
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
): PersistedSessionData | null {
  if (!isRecord(value) || value.version !== 2) {
    return null;
  }
  if (value.workspace !== workspace || value.id !== id) {
    return null;
  }
  const turns = normalizeTurns(value.turns);
  const updatedAt = validDate(value.updatedAt) ?? new Date().toISOString();
  const createdAt = validDate(value.createdAt) ?? turns[0]?.createdAt ?? updatedAt;
  return {
    version: 2,
    id,
    title: normalizeTitle(value.title),
    workspace,
    summary:
      typeof value.summary === "string" ? redactSensitive(value.summary) : "",
    turns,
    costs: normalizeCosts(value.costs),
    revision: nonNegativeInteger(value.revision),
    checkpoints: normalizeCheckpoints(value.checkpoints),
    toolCalls: normalizeToolCalls(value.toolCalls),
    dailySpendUsd: normalizeSpend(value.dailySpendUsd),
    ...(typeof value.model === "string" && value.model.trim()
      ? { model: value.model.trim() }
      : {}),
    ...(isReasoningSetting(value.reasoning)
      ? { reasoning: structuredClone(value.reasoning) }
      : {}),
    createdAt,
    updatedAt,
  };
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
      content: redactSensitive(String(turn.content)),
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
      summary: redactSensitive(
        typeof candidate.summary === "string" ? candidate.summary : "",
      ).slice(0, 300),
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
  };
}

function toSummary(data: PersistedSessionData): ChatSummary {
  return {
    id: data.id,
    title: data.title,
    workspace: data.workspace,
    turnCount: data.turns.length,
    costUsd: data.costs.totalUsd,
    model: data.model,
    reasoning: data.reasoning,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function chatDirectory(appHome: string, workspace: string): string {
  return join(appHome, "chats", workspaceHash(workspace));
}

function chatPath(appHome: string, workspace: string, id: string): string {
  return join(chatDirectory(appHome, workspace), `${id}.json`);
}

function workspaceHash(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
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
  const clean = redactSensitive(value).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 80) : DEFAULT_TITLE;
}

function normalizeCheckpointLabel(value: string, turnIndex: number): string {
  const clean = redactSensitive(value).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 60) : `Checkpoint bei Nachricht ${turnIndex}`;
}

function titleFromPrompt(prompt: string): string {
  const clean = redactSensitive(prompt)
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
  | { kind: "unreadable"; revision: number }
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
  return { kind: "unreadable", revision: 0 };
}

/** Cheap change detector; covers files written by builds without `revision`. */
function fingerprint(data: PersistedSessionData): string {
  return [
    data.revision,
    data.turns.length,
    data.costs.totalUsd,
    data.updatedAt,
    data.checkpoints.length,
    data.toolCalls.length,
    data.title,
    data.summary.length,
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
      (call) => `${call.at}|${call.name}|${call.turnIndex}|${call.summary}`,
      (call) => Date.parse(call.at),
      MAX_TOOL_CALLS,
    ),
    dailySpendUsd: mergeSpend(
      base.dailySpendUsd,
      mine.dailySpendUsd,
      theirs.dailySpendUsd,
    ),
    ...(pickField(base.model, mine.model, theirs.model) !== undefined
      ? { model: pickField(base.model, mine.model, theirs.model) }
      : {}),
    ...(pickField(base.reasoning, mine.reasoning, theirs.reasoning) !== undefined
      ? { reasoning: pickField(base.reasoning, mine.reasoning, theirs.reasoning) }
      : {}),
    createdAt: earlier(mine.createdAt, theirs.createdAt),
    updatedAt: later(mine.updatedAt, theirs.updatedAt),
  };
}

function pickField<T>(base: T, mine: T, theirs: T): T {
  return JSON.stringify(mine) === JSON.stringify(base) ? theirs : mine;
}

function turnKey(turn: ChatTurn): string {
  return `${turn.createdAt} ${turn.role} ${turn.content}`;
}

function mergeTurns(
  base: readonly ChatTurn[],
  mine: readonly ChatTurn[],
  theirs: readonly ChatTurn[],
): ChatTurn[] {
  const baseCount = countKeys(base, turnKey);
  const mineCount = countKeys(mine, turnKey);
  const seen = new Map<string, number>();
  const extras: ChatTurn[] = [];
  for (const turn of theirs) {
    const key = turnKey(turn);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    const known = Math.max(baseCount.get(key) ?? 0, mineCount.get(key) ?? 0);
    if (index > known) {
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
  return { mainUsd, compressorUsd, voiceUsd, totalUsd: roundUsd(mainUsd + compressorUsd + voiceUsd) };
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
  const mineKeys = new Set(mine.map(key));
  const baseKeys = new Set(base.map(key));
  const extras = theirs.filter(
    (item) => !mineKeys.has(key(item)) && !baseKeys.has(key(item)),
  );
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

/* ------------------------------------------------------------------ *
 * Redaction (N4)
 * ------------------------------------------------------------------ */

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Ordered from most specific to most generic. Every rule requires enough
 * entropy/length that ordinary prose ("Bearer token", "sk-test", "AKIA")
 * survives untouched.
 */
const REDACTION_RULES: RedactionRule[] = [
  {
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\bsk-or-v1-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_OPENROUTER_KEY]",
  },
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replacement: "[REDACTED_AWS_KEY_ID]",
  },
  {
    pattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
    replacement: "$1[REDACTED_AWS_SECRET]",
  },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_GOOGLE_KEY]",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    // Only tokens that actually look like tokens: 20+ chars including a digit.
    pattern:
      /\bBearer[ \t]+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}(?![A-Za-z0-9._~+/=-])/g,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9._-])/g,
    replacement: "[REDACTED_JWT]",
  },
];

export function redactSensitive(value: string): string {
  let result = value;
  for (const rule of REDACTION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}
