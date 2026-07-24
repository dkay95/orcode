import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_HOME } from "./config.js";
import {
  REASONING_EFFORTS,
  type ChatSummary,
  type ChatTurn,
  type CostLedger,
  type ReasoningSetting,
  type SessionData,
} from "./types.js";
import { hasCode, isRecord } from "./utils.js";

const MAX_TURNS = 80;
const DEFAULT_TITLE = "Neuer Chat";

export class SessionStore {
  #data: SessionData;
  readonly appHome: string;
  readonly path: string;

  constructor(appHome: string, path: string, data: SessionData) {
    this.appHome = appHome;
    this.path = path;
    this.#data = data;
  }

  static async open(
    workspace: string,
    appHome = APP_HOME,
  ): Promise<SessionStore> {
    const chats = await SessionStore.list(workspace, appHome);
    if (chats[0]) {
      return SessionStore.openById(workspace, chats[0].id, appHome);
    }

    const migrated = await migrateLegacySession(workspace, appHome);
    if (migrated) {
      return migrated;
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

  static async list(
    workspace: string,
    appHome = APP_HOME,
  ): Promise<ChatSummary[]> {
    const sessions = await loadAllSessions(workspace, appHome);
    return sessions.map(toSummary);
  }

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

  get data(): Readonly<SessionData> {
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
    fork.#data.model = this.#data.model;
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

  addCost(kind: "main" | "compressor", amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) {
      return;
    }
    if (kind === "main") {
      this.#data.costs.mainUsd += amount;
    } else {
      this.#data.costs.compressorUsd += amount;
    }
    this.#data.costs.totalUsd = this.#data.costs.mainUsd + this.#data.costs.compressorUsd;
    this.#data.updatedAt = new Date().toISOString();
  }

  clear(): void {
    const { id, title, workspace, model, reasoning, createdAt } = this.#data;
    this.#data = {
      ...emptySession(workspace, id, title),
      model,
      reasoning,
      createdAt,
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

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
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

async function loadAllSessions(
  workspace: string,
  appHome: string,
): Promise<SessionData[]> {
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

  const sessions: SessionData[] = [];
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
  const legacyId = `legacy-${workspaceHash(workspace)}`;
  if (!sessions.some((chat) => chat.id === legacyId)) {
    const migrated = await migrateLegacySession(workspace, appHome);
    if (migrated) {
      sessions.push(migrated.data);
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
): SessionData {
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
      totalUsd: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function migrateLegacySession(
  workspace: string,
  appHome: string,
): Promise<SessionStore | null> {
  const workspaceId = workspaceHash(workspace);
  const path = join(appHome, "sessions", `${workspaceId}.json`);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (
      raw.version !== 1 ||
      raw.workspace !== workspace ||
      !Array.isArray(raw.turns)
    ) {
      return null;
    }
    const id = `legacy-${workspaceId}`;
    const turns = normalizeTurns(raw.turns);
    const updatedAt = validDate(raw.updatedAt) ?? new Date().toISOString();
    const createdAt = turns[0]?.createdAt ?? updatedAt;
    const data: SessionData = {
      version: 2,
      id,
      title: titleFromTurns(turns),
      workspace,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      turns,
      costs: normalizeCosts(raw.costs),
      createdAt,
      updatedAt,
    };
    const migrated = new SessionStore(
      appHome,
      chatPath(appHome, workspace, id),
      data,
    );
    await migrated.save();
    return migrated;
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function normalizeSession(
  value: unknown,
  workspace: string,
  id: string,
): SessionData | null {
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
    summary: typeof value.summary === "string" ? value.summary : "",
    turns,
    costs: normalizeCosts(value.costs),
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

function normalizeCosts(value: unknown): CostLedger {
  const costs = isRecord(value) ? value : {};
  const mainUsd = nonNegativeNumber(costs.mainUsd);
  const compressorUsd = nonNegativeNumber(costs.compressorUsd);
  return {
    mainUsd,
    compressorUsd,
    totalUsd: mainUsd + compressorUsd,
  };
}

function toSummary(data: SessionData): ChatSummary {
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

export function redactSensitive(value: string): string {
  return value
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]");
}
