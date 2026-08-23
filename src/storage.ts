import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { deserializeConversationState } from "@openrouter/agent";
import { PrivateStore } from "./private-store.js";
import {
  withConfigWriteLock,
  withConfigWriteLocks,
} from "./config-write-lock.js";
import {
  assertConfigFileSnapshot,
  readConfigFileSnapshot,
  type ConfigFileSnapshot,
} from "./config-file.js";
import {
  isProviderStateIssue,
  validateProviderSetupState,
} from "./provider-state.js";
import { redactRunEvent, redactValue } from "./redaction.js";
import { normalizePermissionRuleFile, type PermissionRule, type RuleFileV2 } from "./rules.js";
import type { AgentRunEvent } from "./types.js";

export const STORAGE_SCHEMA_VERSION = 1 as const;
export const RUN_LOG_ENVELOPE_VERSION = 1 as const;
export const DEFAULT_MIGRATION_BACKUP_BYTES = 250 * 1_024 * 1_024;
export const EXACT_RETENTION_MAX_AGE_DAYS = 14;
export const EXACT_RETENTION_MAX_TERMINAL_RUNS = 20;
export const EXACT_RETENTION_MAX_BYTES = 250 * 1_024 * 1_024;
export const MIGRATION_BACKUP_MAX_AGE_DAYS = 30;

export interface StoredConversationStateFile {
  version: 1;
  revision: number;
  chatId: string;
  turnCount: number;
  historyDigest: string;
  updatedAt: string;
  state: string;
}

export interface StoredChangeEntry {
  path: string;
  before: string | null;
  after: string;
  createdAt: string;
  runId: string;
}

export function parseConversationStateFile(
  raw: string,
  expectedChatId?: string,
): StoredConversationStateFile {
  const value = parseRecord(raw);
  if (value.version !== 1 || typeof value.revision !== "number"
    || typeof value.chatId !== "string" || typeof value.turnCount !== "number"
    || typeof value.historyDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.historyDigest)
    || typeof value.updatedAt !== "string" || typeof value.state !== "string"
    || (expectedChatId !== undefined && value.chatId !== expectedChatId)) {
    throw new Error("ungültiger ConversationStore-Zustand");
  }
  deserializeConversationState(value.state);
  return value as unknown as StoredConversationStateFile;
}

export function parseCheckpointEntries(raw: string, expectedRunId?: string): StoredChangeEntry[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((entry) => isStoredChangeEntry(entry)
    && (expectedRunId === undefined || entry.runId === expectedRunId))) {
    throw new Error("ungültiges ChangeJournal-Checkpoint");
  }
  return value as StoredChangeEntry[];
}

function isStoredChangeEntry(value: unknown): value is StoredChangeEntry {
  return isRecord(value) && typeof value.path === "string"
    && (value.before === null || typeof value.before === "string")
    && typeof value.after === "string" && typeof value.createdAt === "string"
    && typeof value.runId === "string";
}

export type ChatArtifactKind =
  | "chat"
  | "chat-conflict"
  | "conversation-state"
  | "conversation-conflict"
  | "run-log"
  | "checkpoint"
  | "lock"
  | "task-sidecar";

export interface ChatArtifactEntry {
  kind: ChatArtifactKind;
  privacy: "redacted" | "exact";
  retention: "chat" | "redacted-run-log" | "exact-recovery";
  migration: "required" | "reserved" | "never";
  deletion: "file" | "chat-tree";
}

export interface ChatArtifactLocation {
  appHome: string;
  workspace?: string;
  workspaceHash?: string;
  chatId: string;
  artifactId?: string;
  chatFilePath?: string;
  conflictId?: string;
}

export interface RegisteredArtifactFile {
  kind: ChatArtifactKind;
  path: string;
  chatId: string;
  artifactId?: string;
}

const ARTIFACTS: readonly ChatArtifactEntry[] = [
  { kind: "chat", privacy: "redacted", retention: "chat", migration: "required", deletion: "file" },
  { kind: "chat-conflict", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
  { kind: "conversation-state", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
  { kind: "conversation-conflict", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
  { kind: "run-log", privacy: "redacted", retention: "redacted-run-log", migration: "required", deletion: "chat-tree" },
  { kind: "checkpoint", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "chat-tree" },
  { kind: "lock", privacy: "exact", retention: "exact-recovery", migration: "never", deletion: "file" },
  { kind: "task-sidecar", privacy: "exact", retention: "exact-recovery", migration: "reserved", deletion: "chat-tree" },
];

export class ChatArtifactRegistry {
  readonly #entries = new Map(ARTIFACTS.map((entry) => [entry.kind, entry]));

  entries(): ChatArtifactEntry[] {
    return ARTIFACTS.map((entry) => ({ ...entry }));
  }

  get(kind: ChatArtifactKind): ChatArtifactEntry {
    const entry = this.#entries.get(kind);
    if (!entry) throw new Error(`Unbekannter Chat-Artefakttyp: ${kind}`);
    return { ...entry };
  }

  resolve(kind: ChatArtifactKind, location: ChatArtifactLocation): string {
    const chatId = safeChatId(location.chatId);
    if (!chatId) throw new Error(`Ungültige Chat-ID für Artefakt: ${location.chatId}`);
    const artifactId = safeArtifactId(location.artifactId);
    switch (kind) {
      case "chat": {
        const hash = location.workspaceHash ?? (
          location.workspace ? workspaceStorageHash(location.workspace) : null
        );
        if (!hash) throw new Error("Chat-Pfad braucht workspace oder workspaceHash.");
        if (!/^[a-f0-9]{16}$/.test(hash)) throw new Error("Ungültiger Workspace-Hash für Chat-Artefakt.");
        return join(location.appHome, "chats", hash, `${chatId}.json`);
      }
      case "chat-conflict": {
        const conflictId = safeArtifactId(location.conflictId);
        if (!conflictId) throw new Error("Chat-Konfliktartefakt braucht conflictId.");
        return `${location.chatFilePath ?? this.resolve("chat", location)}.konflikt-${conflictId}.json`;
      }
      case "conversation-state":
        return `${location.chatFilePath ?? this.resolve("chat", location)}.state.json`;
      case "conversation-conflict": {
        const conflictId = safeArtifactId(location.conflictId);
        if (!conflictId) throw new Error("Konfliktartefakt braucht conflictId.");
        return `${location.chatFilePath ?? this.resolve("chat", location)}.state.json.konflikt-${conflictId}.json`;
      }
      case "run-log":
        if (!artifactId) throw new Error("Run-Log braucht artifactId.");
        return join(location.appHome, "runs", chatId, `${artifactId}.ndjson`);
      case "checkpoint":
        if (!artifactId) throw new Error("Checkpoint braucht artifactId.");
        return join(location.appHome, "checkpoints", chatId, `${artifactId}.json`);
      case "lock": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        if (artifactId === "chat") return `${chatPath}.lock`;
        if (artifactId === "conversation-state") return `${this.resolve("conversation-state", { ...location, chatFilePath: chatPath })}.lock`;
        throw new Error("Lock-Artefakt braucht artifactId chat oder conversation-state.");
      }
      case "task-sidecar":
        if (!artifactId) throw new Error("Task-Sidecar braucht artifactId.");
        return join(location.appHome, "tasks", chatId, `${artifactId}.json`);
    }
  }

  /** Enumerate files owned by one chat. Reserved kinds claim no producer, but an existing registered file is still owned and deletable. */
  async existing(kind: ChatArtifactKind, location: Omit<ChatArtifactLocation, "artifactId">): Promise<string[]> {
    switch (kind) {
      case "chat": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        return await pathExists(chatPath) ? [chatPath] : [];
      }
      case "chat-conflict": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        return filesMatching(dirname(chatPath), (name) =>
          name.startsWith(`${basename(chatPath)}.konflikt-`) && name.endsWith(".json"));
      }
      case "conversation-state": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        const path = this.resolve("conversation-state", { ...location, chatFilePath: chatPath });
        return await pathExists(path) ? [path] : [];
      }
      case "conversation-conflict": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        return filesMatching(dirname(chatPath), (name) =>
          name.startsWith(`${basename(chatPath)}.state.json.konflikt-`) && name.endsWith(".json"));
      }
      case "run-log":
        return filesMatching(join(location.appHome, "runs", location.chatId), (name) => name.endsWith(".ndjson"));
      case "checkpoint":
        return filesMatching(join(location.appHome, "checkpoints", location.chatId), (name) => name.endsWith(".json"));
      case "task-sidecar":
        return filesMatching(join(location.appHome, "tasks", location.chatId), (name) => name.endsWith(".json"));
      case "lock": {
        const chatPath = location.chatFilePath ?? this.resolve("chat", location);
        const candidates = [`${chatPath}.lock`, `${chatPath}.state.json.lock`];
        const found: string[] = [];
        for (const path of candidates) if (await pathExists(path)) found.push(path);
        return found;
      }
    }
  }

  async all(kind: ChatArtifactKind, appHome: string): Promise<RegisteredArtifactFile[]> {
    if (kind === "run-log" || kind === "checkpoint" || kind === "task-sidecar") {
      const rootName = kind === "run-log" ? "runs" : kind === "checkpoint" ? "checkpoints" : "tasks";
      const suffix = kind === "run-log" ? ".ndjson" : ".json";
      const found: RegisteredArtifactFile[] = [];
      for (const chatDir of await directories(join(appHome, rootName))) {
        const chatId = basename(chatDir);
        if (!safeChatId(chatId)) continue;
        for (const path of await filesMatching(chatDir, (name) => name.endsWith(suffix))) {
          found.push({ kind, path, chatId, artifactId: basename(path).slice(0, -suffix.length) });
        }
      }
      return found.sort(compareArtifactFile);
    }
    const found: RegisteredArtifactFile[] = [];
    for (const workspaceDir of await directories(join(appHome, "chats"))) {
      for (const path of await filesMatching(workspaceDir, () => true)) {
        const name = basename(path);
        const chatId = chatIdFromChatArtifact(kind, name);
        if (chatId) found.push({ kind, path, chatId });
      }
    }
    return found.sort(compareArtifactFile);
  }
}

export const CHAT_ARTIFACT_REGISTRY = new ChatArtifactRegistry();

export class ChatArtifactStore {
  readonly appHome: string;
  readonly workspace: string;
  readonly chatId: string;
  readonly #privateStore: PrivateStore;

  constructor(appHome: string, workspace: string, chatId: string) {
    if (!safeChatId(chatId)) throw new Error(`Ungültige Chat-ID für Artefaktbindung: ${chatId}`);
    this.appHome = appHome;
    this.workspace = workspace;
    this.chatId = chatId;
    this.#privateStore = new PrivateStore({ root: appHome });
  }

  path(kind: ChatArtifactKind, artifactId?: string): string {
    return CHAT_ARTIFACT_REGISTRY.resolve(kind, {
      appHome: this.appHome,
      workspace: this.workspace,
      chatId: this.chatId,
      ...(artifactId ? { artifactId } : {}),
    });
  }

  async writeExact(kind: ChatArtifactKind, artifactId: string, content: string): Promise<void> {
    const entry = CHAT_ARTIFACT_REGISTRY.get(kind);
    if (entry.privacy !== "exact") throw new Error(`${kind} ist kein exaktes Chat-Artefakt.`);
    await this.#privateStore.writeTextAtomic(this.path(kind, artifactId), content);
  }
}

export interface RetentionError {
  path: string;
  message: string;
}

export interface RetentionReport {
  removed: string[];
  errors: RetentionError[];
}

/** Normalize flat or per-class retention reports without coupling callers to one report shape. */
export function collectRetentionErrors(value: unknown): RetentionError[] {
  const found: RetentionError[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.errors)) {
      for (const error of record.errors) {
        if (isRecord(error) && typeof error.path === "string" && typeof error.message === "string") {
          found.push({ path: error.path, message: error.message });
        }
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key !== "errors") visit(nested);
    }
  };
  visit(value);
  return found;
}

export interface ExactArtifactRetentionOptions {
  now?: number;
  maxAgeDays?: number;
  maxTerminalRunsPerChat?: number;
  maxBytesGlobal?: number;
  activeRunIds?: ReadonlySet<string>;
  onError?: (error: RetentionError) => void;
}

export interface MigrationBackupRetentionOptions {
  now?: number;
  maxAgeDays?: number;
  maxBytesGlobal?: number;
  activeBackupPaths?: ReadonlySet<string>;
  onError?: (error: RetentionError) => void;
}

interface RetentionCandidate extends RegisteredArtifactFile {
  mtimeMs: number;
  size: number;
}

export async function pruneExactArtifacts(
  appHome: string,
  options: ExactArtifactRetentionOptions = {},
): Promise<RetentionReport> {
  const report: RetentionReport = { removed: [], errors: [] };
  const now = finiteNow(options.now);
  const maxAgeMs = downwardInteger(options.maxAgeDays, EXACT_RETENTION_MAX_AGE_DAYS) * 86_400_000;
  const maxRuns = downwardInteger(options.maxTerminalRunsPerChat, EXACT_RETENTION_MAX_TERMINAL_RUNS);
  const maxBytes = downwardInteger(options.maxBytesGlobal, EXACT_RETENTION_MAX_BYTES);
  const runStates = await inspectRunStates(appHome, report, options.onError);
  const explicitActive = options.activeRunIds ?? new Set<string>();
  const candidates: RetentionCandidate[] = [];
  for (const entry of CHAT_ARTIFACT_REGISTRY.entries()) {
    if (entry.retention !== "exact-recovery" || entry.kind === "lock") continue;
    for (const artifact of await CHAT_ARTIFACT_REGISTRY.all(entry.kind, appHome)) {
      try {
        const info = await lstat(artifact.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("Artefakt ist keine reguläre Datei.");
        candidates.push({ ...artifact, mtimeMs: info.mtimeMs, size: info.size });
      } catch (error) {
        recordRetentionError(report, artifact.path, error, options.onError);
      }
    }
  }
  const isActive = (candidate: RetentionCandidate): boolean => Boolean(
    candidate.artifactId && (
      explicitActive.has(candidate.artifactId)
      || runStates.active.get(candidate.chatId)?.has(candidate.artifactId)
    )
  );
  const remove = async (candidate: RetentionCandidate): Promise<void> => {
    if (isActive(candidate) || report.removed.includes(candidate.path)) return;
    await removeRetentionCandidate(appHome, candidate.path, report, options.onError);
  };

  for (const candidate of sortedCandidates(candidates)) {
    if (now - candidate.mtimeMs > maxAgeMs) await remove(candidate);
  }
  for (const [chatId, terminalIds] of runStates.terminal) {
    const terminalCandidates = candidates.filter((candidate) =>
      candidate.chatId === chatId && candidate.artifactId && terminalIds.has(candidate.artifactId)
      && !report.removed.includes(candidate.path) && !isActive(candidate));
    const runs = new Map<string, RetentionCandidate[]>();
    for (const candidate of terminalCandidates) {
      const run = runs.get(candidate.artifactId!) ?? [];
      run.push(candidate);
      runs.set(candidate.artifactId!, run);
    }
    const orderedRuns = [...runs.entries()].sort((left, right) => {
      const leftTime = Math.min(...left[1].map((candidate) => candidate.mtimeMs));
      const rightTime = Math.min(...right[1].map((candidate) => candidate.mtimeMs));
      return leftTime - rightTime || left[0].localeCompare(right[0]);
    });
    for (const [, artifacts] of orderedRuns.slice(0, Math.max(0, orderedRuns.length - maxRuns))) {
      for (const artifact of artifacts) await remove(artifact);
    }
  }
  let total = candidates
    .filter((candidate) => !report.removed.includes(candidate.path))
    .reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of sortedCandidates(candidates)) {
    if (total <= maxBytes) break;
    if (isActive(candidate) || report.removed.includes(candidate.path)) continue;
    await remove(candidate);
    if (report.removed.includes(candidate.path)) total -= candidate.size;
  }
  return report;
}

export async function pruneMigrationBackups(
  appHome: string,
  options: MigrationBackupRetentionOptions = {},
): Promise<RetentionReport> {
  const report: RetentionReport = { removed: [], errors: [] };
  const root = join(appHome, "migration-backups");
  const now = finiteNow(options.now);
  const maxAgeMs = downwardInteger(options.maxAgeDays, MIGRATION_BACKUP_MAX_AGE_DAYS) * 86_400_000;
  const maxBytes = downwardInteger(options.maxBytesGlobal, DEFAULT_MIGRATION_BACKUP_BYTES);
  const active = new Set([...(options.activeBackupPaths ?? [])].map((path) => resolvePath(path)));
  const manifest = await completedOrActiveManifest(appHome);
  if (manifest && !manifest.complete) active.add(resolvePath(manifest.backupPath));
  const completedManifest = await validatedCompletedManifest(appHome);
  const candidates: Array<RetentionCandidate & { source: string }> = [];
  for (const path of await managedBackupEntries(root)) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Backup ist kein reguläres verwaltetes Objekt.");
      candidates.push({
        kind: "task-sidecar",
        path,
        chatId: "backup",
        mtimeMs: completedManifest !== null && completedManifest.completedAtMs !== null
          && resolvePath(path) === resolvePath(completedManifest.backupPath)
          ? Math.min(completedManifest.completedAtMs, now)
          : info.mtimeMs,
        size: info.isDirectory() ? await treeSize(path) : info.size,
        source: basename(path).startsWith("config-v0-") ? "config" : "legacy-home",
      });
    } catch (error) {
      recordRetentionError(report, path, error, options.onError);
    }
  }
  const removable = (candidate: RetentionCandidate): boolean => !active.has(resolvePath(candidate.path));
  for (const candidate of sortedCandidates(candidates)) {
    if (removable(candidate) && now - candidate.mtimeMs > maxAgeMs) {
      await removeRetentionCandidate(appHome, candidate.path, report, options.onError);
    }
  }
  for (const source of new Set(candidates.map((candidate) => candidate.source))) {
    const sameSource = sortedCandidates(candidates.filter((candidate) =>
      candidate.source === source && removable(candidate) && !report.removed.includes(candidate.path)));
    for (const candidate of sameSource.slice(0, -1)) {
      await removeRetentionCandidate(appHome, candidate.path, report, options.onError);
    }
  }
  let total = candidates.filter((candidate) => !report.removed.includes(candidate.path))
    .reduce((sum, candidate) => sum + candidate.size, 0);
  for (const candidate of sortedCandidates(candidates)) {
    if (total <= maxBytes) break;
    if (!removable(candidate) || report.removed.includes(candidate.path)) continue;
    await removeRetentionCandidate(appHome, candidate.path, report, options.onError);
    if (report.removed.includes(candidate.path)) total -= candidate.size;
  }
  return report;
}

export interface ChatDeletionReport extends RetentionReport {}

export async function deleteChatOwnedArtifacts(
  appHome: string,
  workspace: string,
  chatId: string,
): Promise<ChatDeletionReport> {
  const report: ChatDeletionReport = { removed: [], errors: [] };
  const store = new PrivateStore({ root: appHome });
  const local = { appHome, workspace, chatId };
  const manifest = await validatedCompletedManifest(appHome);
  const mapped = manifest
    ? Object.entries(manifest.chatIdMap).filter(([, mappedId]) => mappedId === chatId).map(([oldId]) => oldId)
    : [];
  const legacyLocations = mapped.map((oldId) => ({
    appHome: manifest!.backupPath,
    workspace,
    chatId: oldId,
  }));
  const legacyV1Sessions = manifest
    ? mapped
      .map((oldId) => mappedLegacyV1SessionPath(manifest.backupPath, oldId))
      .filter((path): path is string => path !== null)
    : [];
  const sidecars = CHAT_ARTIFACT_REGISTRY.entries().filter((entry) => entry.kind !== "chat");
  for (const entry of sidecars) {
    for (const location of [local, ...legacyLocations]) {
      let paths: string[];
      try {
        paths = await CHAT_ARTIFACT_REGISTRY.existing(entry.kind, location);
      } catch (error) {
        recordRetentionError(report, `${location.appHome}:${entry.kind}`, error);
        continue;
      }
      for (const path of paths) await removeOwnedPath(store, path, report);
    }
  }
  if (report.errors.length > 0) return report;
  for (const path of legacyV1Sessions) await removeOwnedPath(store, path, report);
  if (report.errors.length > 0) return report;
  // The canonical transcript is the retry anchor: remove it only after every
  // mapped legacy transcript has also been cleared successfully.
  for (const location of legacyLocations) {
    const paths = await CHAT_ARTIFACT_REGISTRY.existing("chat", location);
    for (const path of paths) await removeOwnedPath(store, path, report);
  }
  if (report.errors.length > 0) return report;
  if (manifest) {
    try {
      if (await treeHasNoFiles(manifest.backupPath)) {
        await removeOwnedPath(store, manifest.backupPath, report);
      }
    } catch (error) {
      recordRetentionError(report, manifest.backupPath, error);
    }
  }
  if (report.errors.length > 0) return report;
  const transcriptPaths = await CHAT_ARTIFACT_REGISTRY.existing("chat", local);
  for (const path of transcriptPaths) await removeOwnedPath(store, path, report);
  return report;
}

export function workspaceStorageHash(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}

export function migrationManifestPath(appHome: string): string {
  return join(appHome, "migrations", `app-home-v${STORAGE_SCHEMA_VERSION}.json`);
}

export type MigrationPhase =
  | "planned"
  | "staged"
  | "validated"
  | "committed"
  | "backed-up"
  | "complete";

const MIGRATION_PHASES = new Set<MigrationPhase>([
  "planned",
  "staged",
  "validated",
  "committed",
  "backed-up",
  "complete",
]);

export interface StorageMigrationManifest {
  version: typeof STORAGE_SCHEMA_VERSION;
  phase: MigrationPhase;
  sourcePath: string;
  sourceChecksum: string;
  stagingPath: string;
  backupPath: string;
  chatIdMap: Record<string, string>;
  destinationPaths: string[];
  isolated: Array<{ path: string; reason: string }>;
  complete: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface AppHomeMigrationResult {
  status: "ready" | "declined" | "future" | "recovery-required";
  appHome: string;
  warning: string | null;
}

export interface AppHomeMigrationOptions {
  privateStore?: PrivateStore;
  maxBackupBytes?: number;
  onPhase?: (phase: MigrationPhase, manifest: Readonly<StorageMigrationManifest>) => Promise<void> | void;
  normalizeConfig?: (
    value: Record<string, unknown>,
    context: { originalSchemaVersion: unknown },
  ) => Record<string, unknown>;
}

export async function migrateStorageHome(
  newHome: string,
  legacyHome: string,
  options: AppHomeMigrationOptions = {},
): Promise<AppHomeMigrationResult> {
  const newExists = await pathExists(newHome);
  const legacyExists = await pathExists(legacyHome);
  const privateStore = options.privateStore ?? new PrivateStore({ root: newHome });
  const maxBackupBytes = options.maxBackupBytes ?? DEFAULT_MIGRATION_BACKUP_BYTES;
  const manifestPath = migrationManifestPath(newHome);
  const futureManifestVersion = newExists
    ? await futureObjectVersion(manifestPath, "version", STORAGE_SCHEMA_VERSION)
    : null;
  if (futureManifestVersion !== null) {
    return {
      status: "future",
      appHome: newHome,
      warning: `Migrations-Manifest hat die zukünftige Version ${futureManifestVersion} und wurde nicht überschrieben.`,
    };
  }

  const manifestState = newExists
    ? await readManifestState(manifestPath, newHome, legacyHome)
    : { kind: "absent" } as const;
  if (manifestState.kind === "invalid") {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: `Migration braucht manuelle Wiederherstellung: ${manifestState.reason}`,
    };
  }
  const existingManifest = manifestState.kind === "valid" ? manifestState.manifest : null;
  if (existingManifest?.complete) {
    try {
      await privateStore.removeTree(existingManifest.stagingPath);
    } catch (error) {
      return {
        status: "recovery-required",
        appHome: newHome,
        warning: `Migrations-Staging konnte nicht bereinigt werden: ${errorText(error)}`,
      };
    }
    return migrationResult(newHome, existingManifest);
  }

  if (!legacyExists && !existingManifest) {
    if (!newExists) return { status: "ready", appHome: newHome, warning: null };
    return migrateCurrentConfig(
      newHome,
      privateStore,
      maxBackupBytes,
      options.normalizeConfig,
    );
  }

  if (!legacyExists && existingManifest) {
    return resumeAfterLegacyRename(existingManifest, privateStore, options.onPhase);
  }

  const activeSource = existingManifest?.sourcePath ?? legacyHome;
  const future = await futureConfigVersion(activeSource);
  if (future !== null) {
    return {
      status: "future",
      appHome: newExists ? newHome : legacyHome,
      warning: `Speichermigration abgelehnt: ${activeSource}/config.json hat die zukünftige schemaVersion ${future}.`,
    };
  }
  if (newExists) {
    const targetFuture = await futureConfigVersion(newHome);
    if (targetFuture !== null) {
      return {
        status: "future",
        appHome: newHome,
        warning: `Speichermigration abgelehnt: ${newHome}/config.json hat die zukünftige schemaVersion ${targetFuture}.`,
      };
    }
  }

  if (existingManifest && await checksumTree(activeSource) !== existingManifest.sourceChecksum) {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: "Migrationsquelle stimmt nicht mehr mit dem gespeicherten Checksum überein.",
    };
  }

  const sourceSize = await treeSize(activeSource);
  const managedBackupSize = await optionalTreeSize(join(newHome, "migration-backups"));
  const configBackupSize = await pendingConfigBackupSize(newHome, options.normalizeConfig);
  const postMigrationBackupSize = sourceSize + managedBackupSize + configBackupSize;
  if (postMigrationBackupSize > maxBackupBytes) {
    return {
      status: "declined",
      appHome: newExists ? newHome : legacyHome,
      warning: `Migration abgebrochen: Die globalen Backups wären zu groß (${postMigrationBackupSize} Byte). Bitte ${activeSource} manuell archivieren.`,
    };
  }
  if (!(await privateStore.available())) {
    return {
      status: "declined",
      appHome: newExists ? newHome : legacyHome,
      warning: "Migration abgebrochen: Die private Berechtigungsgrenze für das exakte Backup ist nicht verfügbar.",
    };
  }

  const checksum = existingManifest?.sourceChecksum ?? await checksumTree(activeSource);
  const stagingPath = existingManifest?.stagingPath ?? join(newHome, ".migration-staging", checksum);
  const backupPath = existingManifest?.backupPath ?? join(newHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  let manifest: StorageMigrationManifest = existingManifest ?? {
    version: STORAGE_SCHEMA_VERSION,
    phase: "planned",
    sourcePath: activeSource,
    sourceChecksum: checksum,
    stagingPath,
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: false,
    startedAt: new Date().toISOString(),
  };

  await privateStore.ensureDirectory(newHome);
  await persistManifest(newHome, manifest, privateStore);
  await options.onPhase?.("planned", manifest);

  try {
    manifest = await buildStaging(
      manifest,
      newHome,
      privateStore,
      options.normalizeConfig,
    );
  } catch (error) {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: `Migrations-Staging konnte nicht sicher aufgebaut werden: ${errorText(error)}`,
    };
  }
  manifest.phase = "staged";
  await persistManifest(newHome, manifest, privateStore);
  await options.onPhase?.("staged", manifest);

  await validateStaging(manifest, newHome);
  manifest.phase = "validated";
  await persistManifest(newHome, manifest, privateStore);
  await options.onPhase?.("validated", manifest);

  if (await checksumTree(manifest.sourcePath) !== manifest.sourceChecksum) {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: "Migrationsquelle wurde nach der Validierung verändert; Commit wurde nicht ausgeführt.",
    };
  }

  let publicationFailure: AppHomeMigrationResult | null;
  try {
    const sourceConfigPath = resolvePath(join(manifest.sourcePath, "config.json"));
    const destinationConfigPath = resolvePath(join(newHome, "config.json"));
    publicationFailure = await withConfigWriteLocks([
      sourceConfigPath,
      destinationConfigPath,
    ], async (ownerships) => {
      const ownershipByPath = new Map(
        ownerships.map((ownership) => [ownership.canonicalPath, ownership]),
      );
      const sourceOwnership = ownershipByPath.get(
        sourceConfigPath,
      )!;
      await sourceOwnership.assertHeld();
      for (const destination of manifest.destinationPaths) {
        const staged = join(manifest.stagingPath, relative(newHome, destination));
        const content = await readFile(staged, "utf8");
        if (basename(destination) === "config.json") {
          const ownership = ownershipByPath.get(destinationConfigPath)!;
          await ownership.assertHeld();
          const merged = await preserveCurrentProviderSetup(
            ownership.canonicalPath,
            content,
          );
          await ownership.assertHeld();
          await privateStore.writeTextAtomic(
            ownership.canonicalPath,
            merged.content,
            async () => {
              await ownership.assertHeld();
              await assertConfigFileSnapshot(
                ownership.canonicalPath,
                merged.target,
              );
              await ownership.assertHeld();
            },
          );
          await ownership.assertHeld();
        } else {
          await privateStore.writeTextAtomic(destination, content);
        }
      }
      manifest.phase = "committed";
      await persistManifest(newHome, manifest, privateStore);
      await options.onPhase?.("committed", manifest);
      await sourceOwnership.assertHeld();

      if (await checksumTree(manifest.sourcePath) !== manifest.sourceChecksum) {
        return {
          status: "recovery-required",
          appHome: newHome,
          warning: "Migrationsquelle wurde vor dem Backup-Rename verändert; Quelle bleibt erhalten.",
        };
      }
      await sourceOwnership.assertHeld();

      try {
        if (await pathExists(manifest.sourcePath)) {
          await privateStore.ensureDirectory(dirname(manifest.backupPath));
          if (await pathExists(manifest.backupPath)) {
            throw new Error(`Migration-Backup existiert bereits: ${manifest.backupPath}`);
          }
          await sourceOwnership.assertHeld();
          await privateStore.renameTree(
            manifest.sourcePath,
            manifest.backupPath,
            dirname(manifest.sourcePath),
          );
          await sourceOwnership.assertHeld();
        }
        await privateStore.protectTree(manifest.backupPath);
      } catch (error) {
        return {
          status: "recovery-required",
          appHome: newHome,
          warning: `Migrations-Backup konnte nicht sicher veröffentlicht werden: ${errorText(error)}`,
        };
      }
      return null;
    });
  } catch (error) {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: `Config-Writer-Serialisierung konnte nicht verifiziert werden: ${errorText(error)}`,
    };
  }
  if (publicationFailure) return publicationFailure;
  manifest.phase = "backed-up";
  await persistManifest(newHome, manifest, privateStore);
  await options.onPhase?.("backed-up", manifest);

  try {
    await privateStore.removeTree(manifest.stagingPath);
  } catch (error) {
    return {
      status: "recovery-required",
      appHome: newHome,
      warning: `Migrations-Staging konnte nicht sicher bereinigt werden: ${errorText(error)}`,
    };
  }
  manifest.phase = "complete";
  manifest.complete = true;
  manifest.completedAt = new Date().toISOString();
  await persistManifest(newHome, manifest, privateStore);
  await options.onPhase?.("complete", manifest);
  return migrationResult(newHome, manifest);
}

async function buildStaging(
  manifest: StorageMigrationManifest,
  newHome: string,
  store: PrivateStore,
  normalizeConfig: AppHomeMigrationOptions["normalizeConfig"],
): Promise<StorageMigrationManifest> {
  await store.removeTree(manifest.stagingPath);
  await store.ensureDirectory(manifest.stagingPath);
  manifest.destinationPaths = [];
  manifest.isolated = [];

  const chatRoot = join(manifest.sourcePath, "chats");
  for (const workspaceDir of await directories(chatRoot)) {
    for (const name of await names(workspaceDir)) {
      if (!name.endsWith(".json") || name.includes(".state.json") || name.includes(".konflikt-") || name.endsWith(".lock")) continue;
      const source = join(workspaceDir, name);
      const oldId = name.slice(0, -".json".length);
      let parsed: Record<string, unknown>;
      try {
        parsed = parseChat(await readFile(source, "utf8"), oldId);
      } catch (error) {
        manifest.isolated.push({ path: source, reason: errorText(error) });
        continue;
      }
      const newId = manifest.chatIdMap[oldId] ?? mappedChatId(manifest.sourceChecksum, oldId);
      manifest.chatIdMap[oldId] = newId;
      parsed.id = newId;
      const destination = CHAT_ARTIFACT_REGISTRY.resolve("chat", {
        appHome: newHome,
        workspaceHash: basename(workspaceDir),
        chatId: newId,
      });
      await stageText(manifest, newHome, destination, `${JSON.stringify(redactValue(parsed), null, 2)}\n`, store);
      await stageChatConflicts(manifest, newHome, source, destination, store);
      await stageConversationArtifacts(manifest, newHome, source, destination, oldId, newId, store);
    }
  }

  await stageLegacySessions(manifest, newHome, store);
  await stageRunLogs(manifest, newHome, store);
  await stageMappedTrees(manifest, newHome, "checkpoints", "checkpoint", store);
  await stageConfig(manifest, newHome, store, normalizeConfig);
  await stageRules(manifest, newHome, store);
  manifest.destinationPaths = [...new Set(manifest.destinationPaths)].sort();
  return manifest;
}

async function stageChatConflicts(
  manifest: StorageMigrationManifest,
  newHome: string,
  sourceChat: string,
  destinationChat: string,
  store: PrivateStore,
): Promise<void> {
  const directory = dirname(sourceChat);
  const prefix = `${basename(sourceChat)}.konflikt-`;
  for (const name of await names(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json") || name.endsWith(".lock")) continue;
    const conflictId = name.slice(prefix.length, -".json".length);
    const destination = CHAT_ARTIFACT_REGISTRY.resolve("chat-conflict", {
      appHome: newHome,
      chatId: "path-derived",
      chatFilePath: destinationChat,
      conflictId,
    });
    await stageText(manifest, newHome, destination, await readFile(join(directory, name), "utf8"), store);
  }
}

async function stageConversationArtifacts(
  manifest: StorageMigrationManifest,
  newHome: string,
  sourceChat: string,
  destinationChat: string,
  oldId: string,
  newId: string,
  store: PrivateStore,
): Promise<void> {
  const directory = dirname(sourceChat);
  const prefix = `${basename(sourceChat)}.state.json`;
  for (const name of await names(directory)) {
    if (name !== prefix && !name.startsWith(`${prefix}.konflikt-`)) continue;
    if (name.endsWith(".lock")) continue;
    const source = join(directory, name);
    try {
      const value = parseConversationStateFile(await readFile(source, "utf8"), oldId) as unknown as Record<string, unknown>;
      value.chatId = newId;
      const destination = name === prefix
        ? `${destinationChat}.state.json`
        : `${destinationChat}.state.json${name.slice(prefix.length)}`;
      await stageText(manifest, newHome, destination, `${JSON.stringify(value, null, 2)}\n`, store);
    } catch (error) {
      manifest.isolated.push({ path: source, reason: errorText(error) });
    }
  }
}

async function stageRunLogs(
  manifest: StorageMigrationManifest,
  newHome: string,
  store: PrivateStore,
): Promise<void> {
  const root = join(manifest.sourcePath, "runs");
  for (const oldDirectory of await directories(root)) {
    const oldId = basename(oldDirectory);
    const newId = manifest.chatIdMap[oldId];
    if (!newId) continue;
    for (const name of await names(oldDirectory)) {
      if (!name.endsWith(".ndjson") || name.endsWith(".lock")) continue;
      const source = join(oldDirectory, name);
      try {
        const lines = (await readFile(source, "utf8")).split(/\r?\n/).filter((line) => line.trim());
        if (lines.length === 0) throw new Error("leeres Run-Log");
        const rewritten = lines.map((line) => {
          const parsed: unknown = JSON.parse(line);
          const event = compatibleRunEvent(parsed);
          if (!event) throw new Error("ungültiges oder zukünftiges Run-Log-Envelope");
          return JSON.stringify({ version: RUN_LOG_ENVELOPE_VERSION, event: redactRunEvent(event) });
        }).join("\n") + "\n";
        const destination = CHAT_ARTIFACT_REGISTRY.resolve("run-log", {
          appHome: newHome,
          chatId: newId,
          artifactId: name.slice(0, -".ndjson".length),
        });
        await stageText(manifest, newHome, destination, rewritten, store);
      } catch (error) {
        manifest.isolated.push({ path: source, reason: errorText(error) });
      }
    }
  }
}

async function stageMappedTrees(
  manifest: StorageMigrationManifest,
  newHome: string,
  tree: "checkpoints" | "tasks",
  kind: "checkpoint" | "task-sidecar",
  store: PrivateStore,
): Promise<void> {
  const root = join(manifest.sourcePath, tree);
  for (const oldDirectory of await directories(root)) {
    const newId = manifest.chatIdMap[basename(oldDirectory)];
    if (!newId) continue;
    for (const name of await names(oldDirectory)) {
      if (!name.endsWith(".json") || name.endsWith(".lock")) continue;
      const source = join(oldDirectory, name);
      try {
        const content = await readFile(source, "utf8");
        if (kind === "checkpoint") {
          parseCheckpointEntries(content, name.slice(0, -".json".length));
        } else {
          JSON.parse(content);
        }
        const destination = CHAT_ARTIFACT_REGISTRY.resolve(kind, {
          appHome: newHome,
          chatId: newId,
          artifactId: name.slice(0, -".json".length),
        });
        await stageText(manifest, newHome, destination, content, store);
      } catch (error) {
        manifest.isolated.push({ path: source, reason: errorText(error) });
      }
    }
  }
}

async function stageLegacySessions(
  manifest: StorageMigrationManifest,
  newHome: string,
  store: PrivateStore,
): Promise<void> {
  const root = join(manifest.sourcePath, "sessions");
  for (const name of await names(root)) {
    if (!name.endsWith(".json") || name.endsWith(".lock")) continue;
    const source = join(root, name);
    try {
      const raw = parseRecord(await readFile(source, "utf8"));
      if (raw.version !== 1 || typeof raw.workspace !== "string" || !Array.isArray(raw.turns)) {
        throw new Error("ungültige v1-Session");
      }
      const oldId = `legacy-${name.slice(0, -5)}`;
      const newId = manifest.chatIdMap[oldId] ?? mappedChatId(manifest.sourceChecksum, oldId);
      manifest.chatIdMap[oldId] = newId;
      const now = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();
      const migrated = redactValue({
        version: 2,
        id: newId,
        title: "Bisheriger Chat",
        workspace: raw.workspace,
        summary: typeof raw.summary === "string" ? raw.summary : "",
        turns: raw.turns,
        costs: isRecord(raw.costs) ? raw.costs : { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
        revision: 1,
        checkpoints: [],
        toolCalls: [],
        dailySpendUsd: {},
        createdAt: now,
        updatedAt: now,
      });
      const destination = CHAT_ARTIFACT_REGISTRY.resolve("chat", {
        appHome: newHome,
        workspaceHash: name.slice(0, -5),
        chatId: newId,
      });
      await stageText(manifest, newHome, destination, `${JSON.stringify(migrated, null, 2)}\n`, store);
    } catch (error) {
      manifest.isolated.push({ path: source, reason: errorText(error) });
    }
  }
}

async function stageConfig(
  manifest: StorageMigrationManifest,
  newHome: string,
  store: PrivateStore,
  normalizeConfig: AppHomeMigrationOptions["normalizeConfig"],
): Promise<void> {
  const destination = join(newHome, "config.json");
  const currentExists = await pathExists(destination);
  const source = currentExists
    ? destination
    : join(manifest.sourcePath, "config.json");
  const sourceSnapshot = await readConfigFileSnapshot(source);
  if (sourceSnapshot.kind === "absent") return;
  const raw = sourceSnapshot.raw;
  const value = parseRecord(raw);
  const originalVersion = value.schemaVersion;
  value.schemaVersion = STORAGE_SCHEMA_VERSION;
  const normalized = normalizeConfig
    ? normalizeConfig(value, { originalSchemaVersion: originalVersion })
    : value;
  if (
    currentExists
    && originalVersion === STORAGE_SCHEMA_VERSION
    && JSON.stringify(normalized) === JSON.stringify(value)
  ) return;
  if (currentExists) {
    const checksum = createHash("sha256").update(raw).digest("hex");
    const backup = join(
      newHome,
      "migration-backups",
      `config-v0-${checksum.slice(0, 16)}.json`,
    );
    await stageText(manifest, newHome, backup, raw, store);
  }
  await stageText(manifest, newHome, destination, `${JSON.stringify(normalized, null, 2)}\n`, store);
}

async function stageRules(
  manifest: StorageMigrationManifest,
  newHome: string,
  store: PrivateStore,
): Promise<void> {
  const sourcePath = join(manifest.sourcePath, "permissions.json");
  const destination = join(newHome, "permissions.json");
  const current = await readRuleFile(destination);
  const incoming = await readRuleFile(sourcePath);
  if (current === null && incoming === null) return;
  const merged: PermissionRule[] = [];
  const indexes = new Map<string, number>();
  for (const rule of [...(current?.rules ?? []), ...(incoming?.rules ?? [])]) {
    const key = ruleMergeKey(rule);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(rule);
      continue;
    }
    if (rule.decision === "deny" && merged[existingIndex]!.decision !== "deny") {
      merged[existingIndex] = rule;
    }
  }
  await stageText(manifest, newHome, destination, `${JSON.stringify({ version: 2, rules: merged }, null, 2)}\n`, store);
}

async function stageText(
  manifest: StorageMigrationManifest,
  newHome: string,
  destination: string,
  content: string,
  store: PrivateStore,
): Promise<void> {
  if (!isWithin(newHome, destination)) throw new Error(`Migration-Ziel liegt außerhalb appHome: ${destination}`);
  const staged = join(manifest.stagingPath, relative(newHome, destination));
  await store.writeTextAtomic(staged, content);
  manifest.destinationPaths.push(destination);
}

async function validateStaging(manifest: StorageMigrationManifest, newHome: string): Promise<void> {
  for (const destination of manifest.destinationPaths) {
    if (!isWithin(newHome, destination)) throw new Error(`Ungültiges Migrationsziel: ${destination}`);
    const content = await readFile(join(manifest.stagingPath, relative(newHome, destination)), "utf8");
    if (destination.endsWith(".ndjson")) {
      for (const line of content.trim().split("\n")) {
        const parsed = JSON.parse(line) as { version?: unknown; event?: unknown };
        if (parsed.version !== RUN_LOG_ENVELOPE_VERSION || !compatibleRunEvent(parsed)) {
          throw new Error(`Run-Log-Validierung fehlgeschlagen: ${destination}`);
        }
      }
    } else if (!isUnreadableChatConflictPath(destination)) {
      JSON.parse(content);
    }
  }
}

function isUnreadableChatConflictPath(path: string): boolean {
  return path.includes(".json.konflikt-") && !path.includes(".state.json.konflikt-");
}

async function migrateCurrentConfig(
  appHome: string,
  store: PrivateStore,
  maxBackupBytes: number,
  normalizeConfig: AppHomeMigrationOptions["normalizeConfig"],
): Promise<AppHomeMigrationResult> {
  const path = join(appHome, "config.json");
  try {
    return await withConfigWriteLock(path, async (ownership) => migrateCurrentConfigUnderLock(
      appHome,
      ownership.canonicalPath,
      ownership.assertHeld,
      store,
      maxBackupBytes,
      normalizeConfig,
    ));
  } catch {
    return {
      status: "recovery-required",
      appHome,
      warning: "Config-Migration konnte die exakte Zielidentität nicht verifizieren.",
    };
  }
}

async function migrateCurrentConfigUnderLock(
  appHome: string,
  path: string,
  assertHeld: () => Promise<void>,
  store: PrivateStore,
  maxBackupBytes: number,
  normalizeConfig: AppHomeMigrationOptions["normalizeConfig"],
): Promise<AppHomeMigrationResult> {
  await assertHeld();
  const target = await readConfigFileSnapshot(path);
  await assertHeld();
  if (target.kind === "absent") return { status: "ready", appHome, warning: null };
  let value: Record<string, unknown>;
  const raw = target.raw;
  try {
    value = parseRecord(raw);
  } catch {
    return { status: "ready", appHome, warning: null };
  }
  const version = value.schemaVersion;
  if (typeof version === "number" && version > STORAGE_SCHEMA_VERSION) {
    return { status: "future", appHome, warning: `Konfiguration hat die zukünftige schemaVersion ${version}; sie wurde nicht überschrieben.` };
  }
  value.schemaVersion = STORAGE_SCHEMA_VERSION;
  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeConfig
      ? normalizeConfig(value, { originalSchemaVersion: version })
      : value;
  } catch (error) {
    return {
      status: "recovery-required",
      appHome,
      warning: `Config-Migration wurde vor dem Schreiben abgelehnt: ${errorText(error)}`,
    };
  }
  if (
    version === STORAGE_SCHEMA_VERSION
    && JSON.stringify(normalized) === JSON.stringify(value)
  ) return { status: "ready", appHome, warning: null };
  const checksum = createHash("sha256").update(raw).digest("hex");
  const backup = join(appHome, "migration-backups", `config-v0-${checksum.slice(0, 16)}.json`);
  const managedBackupSize = await optionalTreeSize(join(appHome, "migration-backups"));
  const postMigrationBackupSize = managedBackupSize
    + (await pathExists(backup) ? 0 : Buffer.byteLength(raw));
  if (postMigrationBackupSize > maxBackupBytes) {
    return { status: "declined", appHome, warning: "Config-Migration abgebrochen: Das erforderliche Backup ist zu groß; bitte manuell archivieren." };
  }
  if (!(await store.available())) {
    return { status: "declined", appHome, warning: "Config-Migration abgebrochen: PrivateStore ist nicht verfügbar." };
  }
  if (!(await pathExists(backup))) await store.writeTextAtomic(backup, raw);
  await assertHeld();
  await store.writeTextAtomic(
    path,
    `${JSON.stringify(normalized, null, 2)}\n`,
    async () => {
      await assertHeld();
      await assertConfigFileSnapshot(path, target);
      await assertHeld();
    },
  );
  await assertHeld();
  return { status: "ready", appHome, warning: null };
}

async function preserveCurrentProviderSetup(
  path: string,
  candidateRaw: string,
): Promise<{ content: string; target: ConfigFileSnapshot }> {
  const target = await readConfigFileSnapshot(path);
  if (target.kind === "absent") return { content: candidateRaw, target };
  const current = parseRecord(target.raw);
  if (!("providerSetup" in current)) return { content: candidateRaw, target };
  const validated = validateProviderSetupState(current.providerSetup);
  if (isProviderStateIssue(validated)) {
    throw new Error("Config migration refuses an ambiguous provider setup.");
  }
  const candidate = parseRecord(candidateRaw);
  candidate.providerSetup = current.providerSetup;
  return { content: `${JSON.stringify(candidate, null, 2)}\n`, target };
}

async function resumeAfterLegacyRename(
  manifest: StorageMigrationManifest,
  store: PrivateStore,
  onPhase: AppHomeMigrationOptions["onPhase"],
): Promise<AppHomeMigrationResult> {
  if (!(await pathExists(manifest.backupPath))) {
    return { status: "recovery-required", appHome: dirname(dirname(manifest.backupPath)), warning: "Migration ist unvollständig; Quelle und Backup fehlen." };
  }
  const appHome = dirname(dirname(manifest.backupPath));
  try {
    await store.protectTree(manifest.backupPath);
    await store.removeTree(manifest.stagingPath);
  } catch (error) {
    return {
      status: "recovery-required",
      appHome,
      warning: `Migration konnte Backup/Staging nicht sicher abschließen: ${errorText(error)}`,
    };
  }
  manifest.phase = "complete";
  manifest.complete = true;
  manifest.completedAt = new Date().toISOString();
  await persistManifest(appHome, manifest, store);
  await onPhase?.("complete", manifest);
  return migrationResult(appHome, manifest);
}

function migrationResult(appHome: string, manifest: StorageMigrationManifest): AppHomeMigrationResult {
  return {
    status: "ready",
    appHome,
    warning: manifest.isolated.length > 0
      ? `${manifest.isolated.length} beschädigte Chat-/Run-Artefakte wurden isoliert; andere Daten wurden migriert.`
      : null,
  };
}

async function persistManifest(appHome: string, manifest: StorageMigrationManifest, store: PrivateStore): Promise<void> {
  await store.writeTextAtomic(migrationManifestPath(appHome), `${JSON.stringify(manifest, null, 2)}\n`);
}

type ManifestReadState =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; manifest: StorageMigrationManifest };

async function readManifestState(
  path: string,
  newHome: string,
  legacyHome: string,
): Promise<ManifestReadState> {
  try {
    const value = parseRecord(await readFile(path, "utf8"));
    if (value.version !== STORAGE_SCHEMA_VERSION || typeof value.sourceChecksum !== "string"
      || typeof value.sourcePath !== "string" || typeof value.stagingPath !== "string"
      || typeof value.backupPath !== "string" || typeof value.phase !== "string"
      || !isRecord(value.chatIdMap) || !Array.isArray(value.destinationPaths)
      || !Array.isArray(value.isolated) || typeof value.complete !== "boolean"
      || typeof value.startedAt !== "string") {
      return { kind: "invalid", reason: "Manifest-Struktur ist ungültig." };
    }
    if (!MIGRATION_PHASES.has(value.phase as MigrationPhase)) {
      return { kind: "invalid", reason: `Manifest-Phase ${value.phase} ist ungültig.` };
    }
    if (!/^[a-f0-9]{64}$/.test(value.sourceChecksum)) {
      return { kind: "invalid", reason: "Manifest-Checksum ist ungültig." };
    }
    const expectedSource = resolvePath(legacyHome);
    const expectedStaging = resolvePath(join(newHome, ".migration-staging", value.sourceChecksum));
    const expectedBackup = resolvePath(join(newHome, "migration-backups", `routercode-${value.sourceChecksum.slice(0, 16)}`));
    if (resolvePath(value.sourcePath) !== expectedSource
      || resolvePath(value.stagingPath) !== expectedStaging
      || resolvePath(value.backupPath) !== expectedBackup) {
      return { kind: "invalid", reason: "Manifest-Pfade liegen nicht unter den erwarteten Roots." };
    }
    if (value.complete !== (value.phase === "complete")) {
      return { kind: "invalid", reason: "Manifest-Phase und Completion-Marker widersprechen sich." };
    }
    if (!value.destinationPaths.every((destination) =>
      typeof destination === "string" && isWithin(resolvePath(newHome), resolvePath(destination)))) {
      return { kind: "invalid", reason: "Manifest enthält ein Ziel außerhalb appHome." };
    }
    return { kind: "valid", manifest: value as unknown as StorageMigrationManifest };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { kind: "absent" };
    return { kind: "invalid", reason: `Manifest ist nicht lesbar: ${errorText(error)}` };
  }
}

async function readRuleFile(path: string): Promise<RuleFileV2 | null> {
  try {
    return normalizePermissionRuleFile(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return null;
  }
}

function ruleMergeKey(rule: PermissionRule): string {
  const subject = rule.match.kind === "exact-subject"
    ? `exact:${rule.match.fingerprint}`
    : `disabled:${rule.id}`;
  return `${rule.workspace}\0${rule.tool}\0${subject}`;
}

function compatibleRunEvent(value: unknown): AgentRunEvent | null {
  if (isRecord(value) && typeof value.type === "string") return value as AgentRunEvent;
  if (!isRecord(value) || value.version !== RUN_LOG_ENVELOPE_VERSION || !isRecord(value.event)
    || typeof value.event.type !== "string") return null;
  return value.event as AgentRunEvent;
}

function parseChat(raw: string, id: string): Record<string, unknown> {
  const value = parseRecord(raw);
  if (value.version !== 2 || value.id !== id || typeof value.workspace !== "string" || !Array.isArray(value.turns)) {
    throw new Error("ungültige Chat-Datei");
  }
  return value;
}

function parseRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("JSON-Wert ist kein Objekt");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function futureConfigVersion(home: string): Promise<number | null> {
  try {
    const snapshot = await readConfigFileSnapshot(join(home, "config.json"));
    if (snapshot.kind === "absent") return null;
    const value = parseRecord(snapshot.raw);
    return typeof value.schemaVersion === "number" && value.schemaVersion > STORAGE_SCHEMA_VERSION
      ? value.schemaVersion
      : null;
  } catch {
    return null;
  }
}

async function futureObjectVersion(
  path: string,
  field: string,
  current: number,
): Promise<number | null> {
  try {
    const value = parseRecord(await readFile(path, "utf8"));
    const version = value[field];
    return typeof version === "number" && version > current ? version : null;
  } catch {
    return null;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function names(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

async function filesMatching(path: string, accepts: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && accepts(entry.name))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function chatIdFromChatArtifact(kind: ChatArtifactKind, name: string): string | null {
  let match: RegExpExecArray | null = null;
  switch (kind) {
    case "chat":
      if (name.includes(".konflikt-") || name.endsWith(".state.json") || name.endsWith(".lock")) return null;
      match = /^(.+)\.json$/.exec(name);
      break;
    case "chat-conflict":
      match = /^(.+)\.json\.konflikt-.+\.json$/.exec(name);
      break;
    case "conversation-state":
      match = /^(.+)\.json\.state\.json$/.exec(name);
      break;
    case "conversation-conflict":
      match = /^(.+)\.json\.state\.json\.konflikt-.+\.json$/.exec(name);
      break;
    case "lock":
      match = /^(.+)\.json(?:\.state\.json)?\.lock$/.exec(name);
      break;
    default:
      return null;
  }
  return match && safeChatId(match[1]) ? match[1] : null;
}

function compareArtifactFile(left: RegisteredArtifactFile, right: RegisteredArtifactFile): number {
  return left.path.localeCompare(right.path);
}

function sortedCandidates<T extends RetentionCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}

function downwardInteger(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return ceiling;
  return Math.min(ceiling, Math.max(0, Math.floor(value)));
}

function finiteNow(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Date.now();
}

function recordRetentionError(
  report: RetentionReport,
  path: string,
  error: unknown,
  onError?: (error: RetentionError) => void,
): void {
  const entry = { path, message: errorText(error) };
  report.errors.push(entry);
  onError?.(entry);
}

async function removeRetentionCandidate(
  appHome: string,
  path: string,
  report: RetentionReport,
  onError?: (error: RetentionError) => void,
): Promise<void> {
  try {
    await new PrivateStore({ root: appHome }).removeTree(path);
    report.removed.push(path);
  } catch (error) {
    recordRetentionError(report, path, error, onError);
  }
}

async function removeOwnedPath(
  store: PrivateStore,
  path: string,
  report: ChatDeletionReport,
): Promise<void> {
  try {
    await store.removeTree(path);
    report.removed.push(path);
  } catch (error) {
    recordRetentionError(report, path, error);
  }
}

async function inspectRunStates(
  appHome: string,
  report: RetentionReport,
  onError?: (error: RetentionError) => void,
): Promise<{ terminal: Map<string, Set<string>>; active: Map<string, Set<string>> }> {
  const terminal = new Map<string, Set<string>>();
  const active = new Map<string, Set<string>>();
  for (const artifact of await CHAT_ARTIFACT_REGISTRY.all("run-log", appHome)) {
    const target = terminalEventExists(await readRunLogText(artifact.path, report, onError))
      ? terminal
      : active;
    const ids = target.get(artifact.chatId) ?? new Set<string>();
    if (artifact.artifactId) ids.add(artifact.artifactId);
    target.set(artifact.chatId, ids);
  }
  return { terminal, active };
}

async function readRunLogText(
  path: string,
  report: RetentionReport,
  onError?: (error: RetentionError) => void,
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    recordRetentionError(report, path, error, onError);
    return "";
  }
}

function terminalEventExists(raw: string): boolean {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      const event = compatibleRunEvent(value);
      if (event?.type === "run-end") return true;
    } catch {
      // A corrupt line does not turn an interrupted run into a terminal run.
    }
  }
  return false;
}

async function managedBackupEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith("routercode-") || entry.name.startsWith("config-v0-"))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

interface DeletionManifest {
  backupPath: string;
  chatIdMap: Record<string, string>;
  complete: boolean;
  completedAtMs: number | null;
}

function mappedLegacyV1SessionPath(backupPath: string, oldId: string): string | null {
  const match = /^legacy-([a-f0-9]{16})$/.exec(oldId);
  return match ? join(backupPath, "sessions", `${match[1]}.json`) : null;
}

async function completedOrActiveManifest(appHome: string): Promise<DeletionManifest | null> {
  try {
    const value = parseRecord(await readFile(migrationManifestPath(appHome), "utf8"));
    if (value.version !== STORAGE_SCHEMA_VERSION || typeof value.sourceChecksum !== "string"
      || !/^[a-f0-9]{64}$/.test(value.sourceChecksum) || typeof value.backupPath !== "string"
      || !isRecord(value.chatIdMap) || typeof value.complete !== "boolean") return null;
    const expectedBackup = resolvePath(join(appHome, "migration-backups", `routercode-${value.sourceChecksum.slice(0, 16)}`));
    if (resolvePath(value.backupPath) !== expectedBackup) return null;
    const chatIdMap: Record<string, string> = {};
    for (const [oldId, newId] of Object.entries(value.chatIdMap)) {
      if (!safeChatId(oldId) || typeof newId !== "string" || !safeChatId(newId)) return null;
      chatIdMap[oldId] = newId;
    }
    const parsedCompletedAt = typeof value.completedAt === "string"
      ? Date.parse(value.completedAt)
      : Number.NaN;
    return {
      backupPath: expectedBackup,
      chatIdMap,
      complete: value.complete,
      completedAtMs: Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null,
    };
  } catch {
    return null;
  }
}

async function validatedCompletedManifest(appHome: string): Promise<DeletionManifest | null> {
  try {
    const raw = parseRecord(await readFile(migrationManifestPath(appHome), "utf8"));
    if (raw.phase !== "complete") return null;
  } catch {
    return null;
  }
  const manifest = await completedOrActiveManifest(appHome);
  return manifest?.complete ? manifest : null;
}

async function treeHasNoFiles(root: string): Promise<boolean> {
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isFile()) return false;
      if (!entry.isDirectory() || !(await treeHasNoFiles(join(root, entry.name)))) return false;
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function treeSize(root: string): Promise<number> {
  let total = 0;
  for (const file of await treeFiles(root)) total += (await stat(file)).size;
  return total;
}

async function optionalTreeSize(root: string): Promise<number> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Ungültiger verwalteter Backup-Pfad: ${root}`);
    }
    return treeSize(root);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function pendingConfigBackupSize(
  appHome: string,
  normalizeConfig: AppHomeMigrationOptions["normalizeConfig"],
): Promise<number> {
  const path = join(appHome, "config.json");
  try {
    const snapshot = await readConfigFileSnapshot(path);
    if (snapshot.kind === "absent") return 0;
    const raw = snapshot.raw;
    const value = parseRecord(raw);
    const originalVersion = value.schemaVersion;
    value.schemaVersion = STORAGE_SCHEMA_VERSION;
    const normalized = normalizeConfig
      ? normalizeConfig(value, { originalSchemaVersion: originalVersion })
      : value;
    if (
      originalVersion === STORAGE_SCHEMA_VERSION
      && JSON.stringify(normalized) === JSON.stringify(value)
    ) return 0;
    const checksum = createHash("sha256").update(raw).digest("hex");
    const backup = join(appHome, "migration-backups", `config-v0-${checksum.slice(0, 16)}.json`);
    return await pathExists(backup) ? 0 : Buffer.byteLength(raw);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function checksumTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await treeFiles(root)) {
    hash.update(relative(root, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function treeFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolischer Link in Migration nicht erlaubt: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  await visit(root);
  return result.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mappedChatId(checksum: string, oldId: string): string {
  return `legacy-${createHash("sha256").update(`${checksum}\0${oldId}`).digest("hex").slice(0, 32)}`;
}

function safeArtifactId(value: string | undefined): string | null {
  return value && /^[a-zA-Z0-9._-]{1,160}$/.test(value) ? value : null;
}

function safeChatId(value: string | undefined): string | null {
  return value && value !== "." && value !== ".." && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
    ? value
    : null;
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== ".." && !value.startsWith(`..${sep}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
