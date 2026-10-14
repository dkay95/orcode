import { spawn } from "node:child_process";
import {isolatedLaunch,isLocalWorkRoot,assertLocalWorkEffect} from './local-process-isolation.js';
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ApprovalManager, ApprovalRequest } from "./approval.js";
import { APP_HOME } from "./config.js";
import { PrivateStore } from "./private-store.js";
import {
  CHAT_ARTIFACT_REGISTRY,
  parseCheckpointEntries,
  pruneExactArtifacts,
  pruneMigrationBackups,
  type ExactArtifactRetentionOptions,
  type MigrationBackupRetentionOptions,
  type RetentionReport,
  type StoredChangeEntry,
} from "./storage.js";
import type { DiffLine, DiffLineType, TextDiff } from "./diff-parse.js";
import { oneLine } from "./tool-metadata.js";
import { loadIgnore } from "./ignore.js";
import {
  BrowserTimeoutError,
  browserApprovalSubject,
  isLocalHttpHost,
  validateBrowserUrl,
  type PageReport,
} from "./browser.js";
/**
 * The CDP/process-spawning half of browser support (`browser-engine.ts`) is
 * heavy and feature-scoped: nothing outside a real `browser_check` call
 * needs it. This type-only import resolves its shape for `execute`'s
 * dynamic `import()` below without creating a static (eager) edge to it —
 * `typeof import(...)` is erased at compile time (Phase 7, E-WEIGHT-01).
 */
type BrowserEngineModule = typeof import("./browser-engine.js");
import {
  assertSafeGlobPattern,
  classifyPath,
  evaluateGitReadCapability,
  type GitReadCapabilityPolicy,
  type GitReadOperation,
} from "./policy.js";
import { ReadRegistry, sha256Hex } from "./read-registry.js";
import {
  canonicalWorkspaceRelativeCwd,
  processApprovalSubject,
  shellApprovalSubject,
  type RuleStore,
} from "./rules.js";
import { findSshHost, loadSshHosts, type SshHost } from "./ssh-config.js";
import {
  execSshCommand,
  sshApprovalSubject,
  type RunSsh,
  type SshSession,
} from "./ssh.js";
import { redactText } from "./redaction.js";
import type {
  ProcessCallbacks,
  ProcessCompletion,
  ProcessOperation,
  ToolRisk,
} from "./types.js";
import {
  ellipsize,
  errorMessage,
  hasCode,
  isRecord,
  lookupTable,
  sanitizedEnvironment,
  truncate,
} from "./utils.js";

const MAX_FILE_BYTES = 1_500_000;
const MAX_TOOL_OUTPUT = 80_000;
const MAX_GLOB_DEPTH = 12;
const MAX_GLOB_RESULTS = 5_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_FILE_BYTES = 2_000_000;
const MAX_SEARCH_LINE_CHARS = 500;
const PROCESS_KILL_GRACE_MS = 1_500;
const DIFF_PREVIEW_CHANGED_LINES = 60;
const DIFF_CONTEXT_LINES = 3;
const DIFF_LCS_BUDGET = 2_000_000;
const MAX_GIT_CONFIG_BYTES = 1_000_000;
const MAX_GIT_METADATA_ENTRIES = 250_000;

/** Directories that never contain search hits worth showing. */
const SEARCH_IGNORES = ["**/.git/**", "**/node_modules/**"] as const;

/** Exported so a fresh process (resume after a crash) can validate and load a persisted run's entries without duplicating this shape. */
export interface ChangeEntry extends StoredChangeEntry {
  /**
   * A guarded publisher may remove an existing text file. `StoredChangeEntry`
   * predates deletions and keeps `after` as a string, so the exact checkpoint
   * carries this additive marker and stores `after: ""`. Older readers retain
   * the field, while this journal can distinguish a deleted file from a file
   * whose new contents are the empty string.
   */
  afterMissing?: true;
  /** Durable recovery location used only while an atomic publication is in flight. */
  rollbackPath?: string;
  /** Exact permission bits of an existing pre-image, including deleted files. */
  beforeMode?: number;
  /** Exact allowlisted macOS extended attributes of an existing pre-image. */
  beforeXattrs?: Readonly<Record<string, string>>;
}

export interface ChangeJournalOptions {
  /** Root the checkpoint files live under. Defaults to `~/.orcode`. */
  appHome?: string;
  /** Chat this journal belongs to. Checkpoints are namespaced per chat. */
  chatId?: string;
}

/** Where one run's checkpoint entries live. Shared so a fresh process can find the same file `ChangeJournal` itself would write to. */
export function checkpointRunPath(appHome: string, chatId: string, runId: string): string {
  return CHAT_ARTIFACT_REGISTRY.resolve("checkpoint", {
    appHome,
    chatId,
    artifactId: runId,
  });
}

export interface UndoRunOutcome {
  /** Workspace-relative paths that were restored (or would be, in dry-run). */
  restored: string[];
  /** Files whose content no longer matched what the run wrote — left alone. */
  skipped: Array<{ path: string; reason: string }>;
}

const AUTHENTIC_CHANGE_JOURNALS = new WeakSet<object>();

/**
 * Records every write the coding tools make so a whole run can be undone as
 * one unit, and persists each run's entries to
 * `~/.orcode/checkpoints/<chat-id>/<run-id>.json` (0600) so a checkpoint
 * survives a crash between the write and an eventual `/undo`.
 */
export class ChangeJournal {
  #entries: ChangeEntry[] = [];
  readonly #appHome: string;
  readonly #chatId: string;
  readonly #privateStore: PrivateStore;

  constructor(options: ChangeJournalOptions = {}) {
    this.#appHome = options.appHome ?? APP_HOME;
    this.#chatId = options.chatId ?? "default";
    this.#privateStore = new PrivateStore({ root: this.#appHome });
    AUTHENTIC_CHANGE_JOURNALS.add(this);
  }

  async record(entry: ChangeEntry): Promise<void> {
    await this.recordBatch([entry]);
  }

  /**
   * Adds one already-committed group with a single atomic checkpoint write.
   * This is the journal half of the Codex staging publication boundary: a
   * multi-file patch must never be represented as several independently
   * persisted partial approvals.
   */
  async recordBatch(entries: readonly ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const runId = entries[0]?.runId;
    if (!runId || entries.some((entry) => entry.runId !== runId)) {
      throw new Error("A change-journal batch must belong to one run.");
    }
    const previousLength = this.#entries.length;
    this.#entries.push(...entries.map((entry) => ({ ...entry })));
    try {
      await this.#persistRun(runId);
    } catch (error) {
      this.#entries.splice(previousLength);
      throw error;
    }
  }

  /** Removes only the exact most-recent batch when a guarded commit rolls back. */
  async rollbackBatch(entries: readonly ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const runId = entries[0]?.runId;
    const tail = this.#entries.slice(-entries.length);
    if (!runId || entries.some((entry) => entry.runId !== runId)
      || tail.length !== entries.length
      || tail.some((entry, index) => !sameChangeEntry(entry, entries[index]!))) {
      throw new Error("The change-journal rollback batch is not the current exact batch.");
    }
    this.#entries.splice(this.#entries.length - entries.length, entries.length);
    if (this.#entries.some((entry) => entry.runId === runId)) {
      await this.#persistRun(runId);
    } else {
      await unlink(this.#runFile(runId)).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Exact app-home root used to bind Codex staging and its durable journal. */
  get appHomeRoot(): string {
    return resolve(this.#appHome);
  }

  /** True only when this exact root run recorded at least one workspace mutation. */
  hasMutations(runId: string): boolean {
    return this.#entries.some((entry) => entry.runId === runId);
  }

  #runFile(runId: string): string {
    return checkpointRunPath(this.#appHome, this.#chatId, runId);
  }

  async #persistRun(runId: string): Promise<void> {
    const entries = this.#entries.filter((entry) => entry.runId === runId);
    await this.#privateStore.writeTextAtomic(this.#runFile(runId), JSON.stringify(entries));
  }

  /**
   * Loads one run's persisted checkpoint entries from disk into memory, so
   * `undoLastRun`/`undoLast` can act on a run recorded by a *previous*
   * process (e.g. one that crashed) instead of only entries this instance
   * itself recorded. Meant to be called on a freshly constructed, still
   * empty journal, right before `undoLastRun` — that is what makes the
   * hydrated run the one `undoLastRun` picks via `#entries.at(-1)`.
   *
   * Returns the entries that were loaded; empty when the checkpoint file is
   * missing, unreadable, or does not parse into a plausible entry list —
   * never throws on any of that, since a resume flow reading crash evidence
   * must not itself crash on it.
   */
  async hydrateRun(runId: string): Promise<ChangeEntry[]> {
    let raw: string;
    try {
      raw = await this.#privateStore.readText(this.#runFile(runId));
    } catch {
      return [];
    }
    let valid: ChangeEntry[];
    try {
      valid = parseCheckpointEntries(raw, runId);
    } catch {
      return [];
    }
    if (valid.length === 0) {
      return [];
    }
    const known = new Set(
      this.#entries.map((entry) => `${entry.runId}|${entry.path}|${entry.createdAt}`),
    );
    for (const entry of valid) {
      const key = `${entry.runId}|${entry.path}|${entry.createdAt}`;
      if (!known.has(key)) {
        this.#entries.push(entry);
        known.add(key);
      }
    }
    return valid;
  }

  /**
   * Undoes the last agent run as one unit, in reverse write order. A file
   * whose current content no longer matches what the run wrote is left
   * untouched and reported as skipped — a checkpoint restore never
   * overwrites an unrelated, newer change.
   */
  async undoLastRun(
    guard: WorkspaceGuard,
    approvals: ApprovalManager,
    options: { dryRun?: boolean } = {},
  ): Promise<UndoRunOutcome> {
    const last = this.#entries.at(-1);
    if (!last) {
      return { restored: [], skipped: [] };
    }
    const runId = last.runId;
    const runEntries = this.#entries.filter((entry) => entry.runId === runId);
    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (let index = runEntries.length - 1; index >= 0; index -= 1) {
      const entry = runEntries[index]!;
      const display = guard.display(entry.path);
      const current = await readOptional(entry.path);
      const rollbackPath = safeRollbackPath(entry);
      const rollbackContent = rollbackPath === null ? null : await readOptional(rollbackPath);
      const recoverableMovedPreImage = current === null && entry.before !== null
        && rollbackContent === entry.before;
      const alreadyAtPreImage = current === entry.before && rollbackContent === null;
      const matchesPublishedState = entry.afterMissing === true
        ? current === null
        : current === entry.after;
      if (!matchesPublishedState && !recoverableMovedPreImage && !alreadyAtPreImage) {
        skipped.push({ path: display, reason: "was changed externally after the run" });
        continue;
      }
      if (!options.dryRun) {
        if (!alreadyAtPreImage) {
          await approvals.authorize(
            writeApprovalRequest("undo", display, {
              summary: `Undo the run's change to ${display}`,
              details:
                entry.before === null
                  ? "The newly created file will be deleted."
                  : "The previous file content will be restored.",
            }),
          );
          if (recoverableMovedPreImage && rollbackPath !== null) {
            await guard.resolvePath(rollbackPath);
            await rename(rollbackPath, entry.path);
          } else if (entry.before === null) {
            await unlink(entry.path);
          } else {
            await atomicWrite(entry.path, entry.before, entry.beforeMode, entry.beforeXattrs);
          }
        }
        if (rollbackPath !== null) {
          await unlink(rollbackPath).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
          });
        }
      }
      restored.push(display);
    }

    if (!options.dryRun) {
      this.#entries = this.#entries.filter((entry) => entry.runId !== runId);
      await unlink(this.#runFile(runId)).catch(() => undefined);
    }
    return { restored, skipped };
  }

  /** Backward-compatible string summary for the `/undo` command. */
  async undoLast(
    guard: WorkspaceGuard,
    approvals: ApprovalManager,
    options: { dryRun?: boolean } = {},
  ): Promise<string> {
    const outcome = await this.undoLastRun(guard, approvals, options);
    return formatUndoSummary(outcome, options.dryRun ?? false);
  }
}

// Capture the concrete implementations before consumers can subclass or
// monkey-patch the public prototype. Private-field access then authenticates
// the exact journal instance at invocation time.
const AUTHENTIC_RECORD_CHANGE_BATCH = ChangeJournal.prototype.recordBatch;
const AUTHENTIC_ROLLBACK_CHANGE_BATCH = ChangeJournal.prototype.rollbackBatch;

function sameChangeEntry(left: ChangeEntry, right: ChangeEntry): boolean {
  return left.path === right.path && left.before === right.before && left.after === right.after
    && left.afterMissing === right.afterMissing && left.rollbackPath === right.rollbackPath
    && left.beforeMode === right.beforeMode
    && JSON.stringify(left.beforeXattrs) === JSON.stringify(right.beforeXattrs)
    && left.createdAt === right.createdAt
    && left.runId === right.runId;
}

function safeRollbackPath(entry: ChangeEntry): string | null {
  if (entry.rollbackPath === undefined) return null;
  const candidate = resolve(entry.rollbackPath);
  if (dirname(candidate) !== dirname(resolve(entry.path))
    || !/^\.orcode-[0-9a-f-]{36}\.rollback$/.test(basename(candidate))) {
    return null;
  }
  return candidate;
}

function formatUndoSummary(outcome: UndoRunOutcome, dryRun: boolean): string {
  if (outcome.restored.length === 0 && outcome.skipped.length === 0) {
    return "No orcode change to undo.";
  }
  const lines: string[] = [];
  const verb = dryRun ? "would be restored" : "restored";
  if (outcome.restored.length > 0) {
    lines.push(`${outcome.restored.length} file(s) ${verb}: ${outcome.restored.join(", ")}`);
  }
  if (outcome.skipped.length > 0) {
    lines.push(
      `${outcome.skipped.length} file(s) skipped (changed externally): ${outcome.skipped
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Startup cleanup for checkpoint files: removes anything older than
 * `maxAgeDays` and, per chat, the oldest files beyond `maxBytesPerChat`.
 */
export async function pruneCheckpoints(
  appHome: string = APP_HOME,
  options: ExactArtifactRetentionOptions & { backups?: MigrationBackupRetentionOptions } = {},
): Promise<{ exact: RetentionReport; backups: RetentionReport }> {
  const exact = await pruneExactArtifacts(appHome, options);
  const backups = await pruneMigrationBackups(appHome, options.backups ?? {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return { exact, backups };
}

export const HOME_WORKSPACE_WARNING =
  "Warning: the workspace is your entire home directory — the agent can read everything under it. Start orcode in the project folder or with -C <path>.";

/**
 * Warns when a workspace root is the user's home directory — checked at
 * startup and again after every workspace re-root (Phase F1b: a foreign
 * `/chats` pick or `/folder open|new` can land here just as easily as `-C`
 * can). `home` is injectable for tests.
 */
export function homeWorkspaceWarning(
  workspace: string,
  home: string = homedir(),
): string | null {
  return resolve(workspace) === resolve(home) ? HOME_WORKSPACE_WARNING : null;
}

export class WorkspaceGuard {
  private constructor(
    public readonly root: string,
    private readonly realRoot: string,
    private readonly realRootIdentity: Readonly<{ dev: bigint; ino: bigint }>,
  ) {}

  static async create(root: string): Promise<WorkspaceGuard> {
    const absolute = resolve(root);
    const info = await stat(absolute);
    if (!info.isDirectory()) {
      throw new Error(`Workspace directory is not a folder: ${absolute}`);
    }
    const canonical = await realpath(absolute);
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
      throw new Error(`Workspace directory is not a real folder: ${canonical}`);
    }
    return new WorkspaceGuard(absolute, canonical, {
      dev: canonicalInfo.dev,
      ino: canonicalInfo.ino,
    });
  }

  /** The canonical, identity-bound root used by isolated execution code. */
  get canonicalRoot(): string {
    return this.realRoot;
  }

  /** Revalidates that the verified workspace root was not replaced. */
  async assertCurrent(): Promise<void> {
    const info = await lstat(this.realRoot, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()
      || info.dev !== this.realRootIdentity.dev || info.ino !== this.realRootIdentity.ino) {
      throw new Error("The verified workspace root changed.");
    }
  }

  /**
   * Resolves a relative path against the canonical root. Unlike `resolvePath`,
   * this never follows a mutable lexical root symlink and is intended for the
   * final guarded publication boundary.
   */
  async resolveCanonicalPath(input: string): Promise<string> {
    if (typeof input !== "string" || input.length === 0 || input.includes("\0") || isAbsolute(input)) {
      throw new Error("Workspace publication paths must be non-empty and relative.");
    }
    const candidate = resolve(this.realRoot, input);
    const rel = relative(this.realRoot, candidate);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Path is outside the workspace directory: ${input}`);
    }
    await this.assertCurrent();
    return candidate;
  }

  /** Publishes only a one-shot authority minted by an exact approved staging scan. */
  async publishCodexApprovedEffects(
    authority: object,
    journal: ChangeJournal,
    runId: string,
  ): Promise<PublishGuardedWorkspaceFilesResult> {
    const { consumeCodexWorkspacePublicationAuthority } = await import("./codex-staging-workspace.js");
    const effects = consumeCodexWorkspacePublicationAuthority(authority, this);
    return publishGuardedWorkspaceFiles({ guard: this, journal, runId, effects });
  }

  async publishLocalCandidateEffects(authority:object,journal:ChangeJournal,runId:string):Promise<PublishGuardedWorkspaceFilesResult> {
    const {consumeLocalPublication}=await import('./local-project-run.js');
    const authorityState=consumeLocalPublication(authority,this);
    return publishGuardedWorkspaceFiles({guard:this,journal,runId,...authorityState});
  }

  async resolvePath(input = "."): Promise<string> {
    const candidate = resolve(this.root, input);
    this.assertLexical(candidate);
    await this.assertReal(candidate);
    return candidate;
  }

  display(input: string): string {
    const rel = relative(this.root, input);
    return rel || ".";
  }

  private assertLexical(candidate: string): void {
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) {
      throw new Error(`Path is outside the workspace directory: ${candidate}`);
    }
  }

  private async assertReal(candidate: string): Promise<void> {
    let existing = candidate;
    while (true) {
      try {
        const resolved = await realpath(existing);
        if (resolved !== this.realRoot && !resolved.startsWith(`${this.realRoot}${sep}`)) {
          throw new Error(`Symlink leaves the workspace directory: ${candidate}`);
        }
        return;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
        const parent = dirname(existing);
        if (parent === existing) {
          throw new Error(`Path could not be safely resolved: ${candidate}`);
        }
        existing = parent;
      }
    }
  }
}

export interface GuardedWorkspaceFileEffect {
  /** Normalized workspace-relative path; absolute and traversal paths fail. */
  readonly path: string;
  /** Exact verified real-workspace pre-image. */
  readonly before: Uint8Array | null;
  /** Exact approved post-image, or null for a deletion. */
  readonly after: Uint8Array | null;
  /** Optional pre-image mode pin (permission bits only). */
  readonly beforeMode?: number;
  /** Owner-only mode used only when the effect creates a new file. */
  readonly createdMode?: number;
}

export interface PublishGuardedWorkspaceFilesInput {
  readonly assertEffectCurrent?:()=>void;
  readonly guard: WorkspaceGuard;
  readonly journal: ChangeJournal;
  readonly runId: string;
  readonly effects: readonly GuardedWorkspaceFileEffect[];
  readonly now?: () => Date;
}

export interface PublishGuardedWorkspaceFilesResult {
  readonly publishedPaths: readonly string[];
}

interface BoundWorkspaceFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly xattrs: Readonly<Record<string, string>>;
}

interface BoundWorkspaceDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}

interface PreparedWorkspaceEffect {
  readonly path: string;
  readonly target: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly beforeMode: number | null;
  readonly beforeXattrs: Readonly<Record<string, string>>;
  readonly createdMode: number;
  readonly rollbackPath: string | null;
  readonly parentChain: readonly BoundWorkspaceDirectory[];
}

interface AppliedWorkspaceEffect extends PreparedWorkspaceEffect {
  readonly backupPath: string | null;
}

/**
 * Publishes a complete, already-approved set of exact text-file effects.
 *
 * The function revalidates every pre-image before the first mutation, binds
 * every target through `WorkspaceGuard`, stages rollback names on the same
 * filesystem, and persists one journal batch. Any conflict or intermediate
 * failure restores the pre-images before returning an error.
 */
async function publishGuardedWorkspaceFiles(
  input: PublishGuardedWorkspaceFilesInput,
): Promise<PublishGuardedWorkspaceFilesResult> {
  if (!(input.guard instanceof WorkspaceGuard)) {
    throw new Error("A verified workspace guard is required for publication.");
  }
  if (!(input.journal instanceof ChangeJournal) || !AUTHENTIC_CHANGE_JOURNALS.has(input.journal)) {
    throw new Error("A change journal is required for publication.");
  }
  if (typeof input.runId !== "string" || input.runId.length === 0
    || input.runId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.runId)) {
    throw new Error("The workspace publication run id is invalid.");
  }
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw new Error("Workspace publication requires at least one exact effect.");
  }

  await input.guard.assertCurrent();
  const rootInfo = await lstat(input.guard.canonicalRoot, { bigint: true });
  const seen = new Set<string>();
  const prepared: PreparedWorkspaceEffect[] = [];
  for (const effect of input.effects) {
    if (!effect || typeof effect !== "object" || typeof effect.path !== "string") {
      throw new Error("Workspace publication effect is invalid.");
    }
    const target = await input.guard.resolveCanonicalPath(effect.path);
    const normalized = relative(input.guard.canonicalRoot, target).split(sep).join("/");
    if (seen.has(normalized)) throw new Error(`Duplicate workspace effect: ${normalized}`);
    seen.add(normalized);
    const before = effect.before === null ? null : Buffer.from(effect.before);
    const after = effect.after === null ? null : Buffer.from(effect.after);
    if (before === null && after === null) {
      throw new Error(`Workspace effect has no state transition: ${normalized}`);
    }
    const current = await readBoundWorkspaceFile(target, input.guard.canonicalRoot, rootInfo.dev);
    const parentChain = await bindWorkspaceDirectoryChain(
      dirname(target),
      input.guard.canonicalRoot,
      rootInfo.dev,
      true,
    );
    if ((current === null) !== (before === null)
      || (current !== null && before !== null && !current.bytes.equals(before))) {
      throw new Error(`Workspace pre-image conflict: ${normalized}`);
    }
    if (current !== null && effect.beforeMode !== undefined
      && current.mode !== (effect.beforeMode & 0o777)) {
      throw new Error(`Workspace pre-image metadata conflict: ${normalized}`);
    }
    const createdMode = normalizeOwnerOnlyFileMode(effect.createdMode ?? 0o600);
    // Journal and undo are exact UTF-8 text boundaries. Binary or malformed
    // text is rejected rather than published without recoverable evidence.
    if (before !== null) decodeExactUtf8(before, normalized);
    if (after !== null) decodeExactUtf8(after, normalized);
    prepared.push({
      path: normalized,
      target,
      before,
      after,
      beforeMode: current?.mode ?? null,
      beforeXattrs: current?.xattrs ?? Object.freeze({}),
      createdMode,
      rollbackPath: before === null
        ? null
        : join(dirname(target), `.orcode-${randomUUID()}.rollback`),
      parentChain,
    });
  }

  for (const effect of prepared) {
    if (effect.rollbackPath !== null
      && await readBoundWorkspaceFile(effect.rollbackPath, input.guard.canonicalRoot, rootInfo.dev) !== null) {
      throw new Error(`Workspace rollback location already exists: ${effect.path}`);
    }
  }

  const createdDirectories: string[] = [];
  const applied: AppliedWorkspaceEffect[] = [];
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const entries: ChangeEntry[] = prepared.map((effect) => ({
    path: effect.target,
    before: effect.before === null ? null : decodeExactUtf8(effect.before, effect.path),
    after: effect.after === null ? "" : decodeExactUtf8(effect.after, effect.path),
    ...(effect.after === null ? { afterMissing: true as const } : {}),
    ...(effect.rollbackPath === null ? {} : { rollbackPath: effect.rollbackPath }),
    ...(effect.beforeMode === null ? {} : { beforeMode: effect.beforeMode }),
    ...(Object.keys(effect.beforeXattrs).length === 0 ? {} : { beforeXattrs: effect.beforeXattrs }),
    createdAt,
    runId: input.runId,
  }));
  await AUTHENTIC_RECORD_CHANGE_BATCH.call(input.journal, entries);
  let journalRecorded = true;
  try {
    // Revalidate the whole set immediately before its first mutation.
    for (const effect of prepared) {
      await assertSameBoundWorkspaceDirectoryChain(effect.parentChain);
      const current = await readBoundWorkspaceFile(effect.target, input.guard.canonicalRoot, rootInfo.dev);
      if ((current === null) !== (effect.before === null)
        || (current !== null && effect.before !== null && !current.bytes.equals(effect.before))
        || (current !== null && effect.beforeMode !== null && current.mode !== effect.beforeMode)
        || (current !== null && !sameExtendedAttributes(current.xattrs, effect.beforeXattrs))) {
        throw new Error(`Workspace pre-image conflict: ${effect.path}`);
      }
    }

    for (const effect of prepared) {
      input.assertEffectCurrent?.();
      await input.guard.assertCurrent();
      await assertSameBoundWorkspaceDirectoryChain(effect.parentChain);
      await ensureBoundWorkspaceParents(
        dirname(effect.target),
        input.guard.canonicalRoot,
        rootInfo.dev,
        createdDirectories,
      );
      await assertSameBoundWorkspaceDirectoryChain(effect.parentChain);
      const current = await readBoundWorkspaceFile(effect.target, input.guard.canonicalRoot, rootInfo.dev);
      if ((current === null) !== (effect.before === null)
        || (current !== null && effect.before !== null && !current.bytes.equals(effect.before))
        || (current !== null && effect.beforeMode !== null && current.mode !== effect.beforeMode)
        || (current !== null && !sameExtendedAttributes(current.xattrs, effect.beforeXattrs))) {
        throw new Error(`Workspace pre-image conflict: ${effect.path}`);
      }

      const backupPath = effect.rollbackPath;
      input.assertEffectCurrent?.();
      if (effect.before !== null) {
        if (backupPath === null) throw new Error(`Workspace rollback path is missing: ${effect.path}`);
        await rename(effect.target, backupPath);
        applied.push({ ...effect, backupPath });
        const backup = await readBoundWorkspaceFile(backupPath, input.guard.canonicalRoot, rootInfo.dev);
        if (!backup || !backup.bytes.equals(effect.before) || backup.mode !== effect.beforeMode
          || !sameExtendedAttributes(backup.xattrs, effect.beforeXattrs)) {
          throw new Error(`Workspace pre-image changed during publication: ${effect.path}`);
        }
      } else {
        applied.push({ ...effect, backupPath });
      }

      if (effect.after !== null) {
        input.assertEffectCurrent?.();
        const mode = effect.beforeMode ?? effect.createdMode;
        await writeExclusiveWorkspaceFile(effect.target, effect.after, mode, effect.beforeXattrs);
        const published = await readBoundWorkspaceFile(
          effect.target,
          input.guard.canonicalRoot,
          rootInfo.dev,
        );
        // macOS may attach its own provenance to a brand-new file. Unknown
        // attributes already fail in readBoundWorkspaceFile; existing-file
        // metadata must still be restored exactly.
        const attributesMatch=published && (effect.before===null
          ? Object.keys(published.xattrs).every(name=>name==='com.apple.provenance')
          : sameExtendedAttributes(published.xattrs,effect.beforeXattrs));
        if (!published || !published.bytes.equals(effect.after) || published.mode !== mode
          || !attributesMatch) {
          const reason=!published?'missing':!published.bytes.equals(effect.after)?'content':published.mode!==mode?'permissions':'metadata';
          throw new Error(`Workspace post-image verification failed (${reason}): ${effect.path}`);
        }
      }
    }

    for (const effect of applied) {
      if (effect.backupPath !== null) await unlink(effect.backupPath);
    }
  } catch (error) {
    let rollbackError: unknown = null;
    try {
      await rollbackAppliedWorkspaceEffects(applied, input.guard, rootInfo.dev, createdDirectories);
    } catch (failure) {
      rollbackError = failure;
    }
    if (journalRecorded && rollbackError === null) {
      try {
        await AUTHENTIC_ROLLBACK_CHANGE_BATCH.call(input.journal, entries);
        journalRecorded = false;
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (rollbackError !== null) {
      throw new AggregateError(
        [error, rollbackError],
        "Workspace publication failed and its durable rollback did not fully settle.",
      );
    }
    throw error;
  }

  return Object.freeze({ publishedPaths: Object.freeze(prepared.map((effect) => effect.path)) });
}

async function readBoundWorkspaceFile(
  path: string,
  root: string,
  rootDevice: bigint,
): Promise<BoundWorkspaceFile | null> {
  await assertBoundWorkspaceDirectoryChain(dirname(path), root, rootDevice, true);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.dev !== rootDevice || before.nlink !== 1n) {
    throw new Error(`Workspace publication rejects links, mounts, and non-files: ${path}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameBoundFileIdentity(before, opened)) {
      throw new Error(`Workspace file changed while it was being bound: ${path}`);
    }
    const bytes = await handle.readFile();
    const xattrs = await readWorkspaceExtendedAttributes(path);
    const after = await handle.stat({ bigint: true });
    if (!sameBoundFileIdentity(opened, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error(`Workspace file changed while it was being read: ${path}`);
    }
    return {
      bytes,
      mode: Number(after.mode & 0o777n),
      dev: after.dev,
      ino: after.ino,
      xattrs,
    };
  } finally {
    await handle.close();
  }
}

async function readWorkspaceExtendedAttributes(
  path: string,
): Promise<Readonly<Record<string, string>>> {
  if (process.platform !== "darwin") return Object.freeze({});
  const names = (await runXattr([path])).trim().split("\n").filter(Boolean).sort();
  const values: Record<string, string> = {};
  for (const name of names) {
    if (name !== "com.apple.provenance") {
      throw new Error(`Workspace publication refuses unsupported extended attribute ${name}: ${path}`);
    }
    values[name] = (await runXattr(["-px", name, path])).replace(/\s/g, "").toLowerCase();
  }
  return Object.freeze(values);
}

function runXattr(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn("/usr/bin/xattr", [...args], {
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOutput(new Error("Workspace extended-attribute inspection timed out."));
    }, 2_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > 64 * 1_024) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOutput(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded || code !== 0) {
        rejectOutput(new Error(
          `Workspace extended-attribute inspection failed${stderr ? `: ${truncate(stderr, 400)}` : "."}`,
        ));
      } else {
        resolveOutput(stdout);
      }
    });
  });
}

async function writeWorkspaceExtendedAttributes(
  path: string,
  xattrs: Readonly<Record<string, string>>,
): Promise<void> {
  if (process.platform !== "darwin") {
    if (Object.keys(xattrs).length !== 0) {
      throw new Error("Workspace extended attributes cannot be restored on this platform.");
    }
    return;
  }
  for (const name of Object.keys(xattrs).sort()) {
    if (name !== "com.apple.provenance" || !/^[0-9a-f]*$/.test(xattrs[name] ?? "")) {
      throw new Error("Workspace extended-attribute restoration claim is invalid.");
    }
    await runXattr(["-wx", name, xattrs[name]!, path]);
  }
}

function sameExtendedAttributes(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return leftNames.length === rightNames.length
    && leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name]);
}

function sameBoundFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.nlink === 1n && right.nlink === 1n;
}

async function assertBoundWorkspaceDirectoryChain(
  directory: string,
  root: string,
  rootDevice: bigint,
  allowMissingTail: boolean,
): Promise<void> {
  await bindWorkspaceDirectoryChain(directory, root, rootDevice, allowMissingTail);
}

async function bindWorkspaceDirectoryChain(
  directory: string,
  root: string,
  rootDevice: bigint,
  allowMissingTail: boolean,
): Promise<readonly BoundWorkspaceDirectory[]> {
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Workspace directory escapes its verified root: ${directory}`);
  }
  let current = root;
  const bound: BoundWorkspaceDirectory[] = [];
  const rootInfo = await lstat(root, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.dev !== rootDevice) {
    throw new Error(`Workspace publication rejects a replaced root directory: ${root}`);
  }
  bound.push({ path: root, dev: rootInfo.dev, ino: rootInfo.ino, uid: rootInfo.uid });
  const components = rel === "" ? [] : rel.split(sep);
  for (const component of components) {
    current = join(current, component);
    let info: BigIntStats;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (allowMissingTail && hasCode(error, "ENOENT")) return Object.freeze(bound);
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootDevice) {
      throw new Error(`Workspace publication rejects a linked or mounted directory: ${current}`);
    }
    bound.push({ path: current, dev: info.dev, ino: info.ino, uid: info.uid });
  }
  return Object.freeze(bound);
}

async function assertSameBoundWorkspaceDirectoryChain(
  bound: readonly BoundWorkspaceDirectory[],
): Promise<void> {
  for (const expected of bound) {
    const current = await lstat(expected.path, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== expected.dev || current.ino !== expected.ino
      || current.uid !== expected.uid) {
      throw new Error(`Workspace parent directory identity changed: ${expected.path}`);
    }
  }
}

async function ensureBoundWorkspaceParents(
  directory: string,
  root: string,
  rootDevice: bigint,
  created: string[],
): Promise<void> {
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Workspace directory escapes its verified root: ${directory}`);
  }
  let current = root;
  for (const component of rel === "" ? [] : rel.split(sep)) {
    current = join(current, component);
    try {
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootDevice) {
        throw new Error(`Workspace publication rejects a linked or mounted directory: ${current}`);
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootDevice) {
        throw new Error(`Workspace publication could not bind a new directory: ${current}`);
      }
      created.push(current);
    }
  }
}

async function writeExclusiveWorkspaceFile(
  path: string,
  bytes: Buffer,
  mode: number,
  xattrs: Readonly<Record<string, string>> = Object.freeze({}),
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await writeWorkspaceExtendedAttributes(path, xattrs);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function rollbackAppliedWorkspaceEffects(
  applied: readonly AppliedWorkspaceEffect[],
  guard: WorkspaceGuard,
  rootDevice: bigint,
  createdDirectories: readonly string[],
): Promise<void> {
  let rollbackError: unknown = null;
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const effect = applied[index]!;
    try {
      const paths = await resolveBoundRollbackPaths(effect, guard.canonicalRoot, rootDevice);
      await assertExactBoundDirectory(paths.parent, effect.parentChain.at(-1)!);
      const current=await readBoundWorkspaceFile(paths.target,guard.canonicalRoot,rootDevice);
      if(current!==null && (effect.after===null || !current.bytes.equals(effect.after)
        || current.mode!==(effect.beforeMode??effect.createdMode))) {
        throw new Error(`Workspace rollback preserves a foreign edit and its backup: ${effect.path}`);
      }
      await unlink(paths.target).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
      await assertExactBoundDirectory(paths.parent, effect.parentChain.at(-1)!);
      if (effect.backupPath !== null) {
        try {
          await assertExactBoundDirectory(paths.parent, effect.parentChain.at(-1)!);
          await rename(paths.backup!, paths.target);
          await assertExactBoundDirectory(paths.parent, effect.parentChain.at(-1)!);
        } catch (error) {
          if (!hasCode(error, "ENOENT") || effect.before === null) throw error;
          await writeExclusiveWorkspaceFile(
            paths.target,
            effect.before,
            effect.beforeMode ?? 0o600,
            effect.beforeXattrs,
          );
        }
      } else if (effect.before !== null) {
        await writeExclusiveWorkspaceFile(
          paths.target,
          effect.before,
          effect.beforeMode ?? 0o600,
          effect.beforeXattrs,
        );
      }
      if (effect.before !== null) {
        await assertExactBoundDirectory(paths.parent, effect.parentChain.at(-1)!);
        const restored = await readBoundWorkspaceFile(paths.target, guard.canonicalRoot, rootDevice);
        if (!restored || !restored.bytes.equals(effect.before)) {
          throw new Error(`Workspace rollback verification failed: ${effect.path}`);
        }
      }
    } catch (error) {
      rollbackError ??= error;
    }
  }
  await removeCreatedWorkspaceDirectories(createdDirectories);
  if (rollbackError) throw rollbackError;
}

async function resolveBoundRollbackPaths(
  effect: AppliedWorkspaceEffect,
  root: string,
  rootDevice: bigint,
): Promise<{ readonly parent: string; readonly target: string; readonly backup: string | null }> {
  const expectedParent = effect.parentChain.at(-1);
  if (!expectedParent) throw new Error(`Workspace rollback parent claim is missing: ${effect.path}`);
  let parent: string;
  try {
    await assertSameBoundWorkspaceDirectoryChain(effect.parentChain);
    parent = dirname(effect.target);
  } catch {
    parent = await locateBoundWorkspaceDirectory(root, rootDevice, expectedParent);
  }
  await assertExactBoundDirectory(parent, expectedParent);
  return {
    parent,
    target: join(parent, basename(effect.target)),
    backup: effect.backupPath === null ? null : join(parent, basename(effect.backupPath)),
  };
}

async function locateBoundWorkspaceDirectory(
  root: string,
  rootDevice: bigint,
  expected: BoundWorkspaceDirectory,
): Promise<string> {
  let visited = 0;
  const visit = async (directory: string): Promise<string | null> => {
    visited += 1;
    if (visited > 100_000) throw new Error("Workspace rollback directory search exceeded its bound.");
    const info = await lstat(directory, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== rootDevice) return null;
    if (info.dev === expected.dev && info.ino === expected.ino && info.uid === expected.uid) return directory;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const found = await visit(join(directory, child.name));
      if (found !== null) return found;
    }
    return null;
  };
  const found = await visit(root);
  if (found === null) throw new Error("Workspace rollback parent identity is no longer reachable.");
  return found;
}

async function assertExactBoundDirectory(path: string, expected: BoundWorkspaceDirectory): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev
    || current.ino !== expected.ino || current.uid !== expected.uid) {
    throw new Error("Workspace rollback parent identity changed.");
  }
}

async function removeCreatedWorkspaceDirectories(directories: readonly string[]): Promise<void> {
  for (let index = directories.length - 1; index >= 0; index -= 1) {
    await rmdir(directories[index]!).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error;
    });
  }
}

function normalizeOwnerOnlyFileMode(mode: number): number {
  if (!Number.isSafeInteger(mode)) throw new Error("Workspace file mode is invalid.");
  const normalized = mode & 0o700;
  if ((mode & 0o077) !== 0 || (normalized & 0o600) !== 0o600) {
    throw new Error("A newly published file must use an owner-only mode.");
  }
  return normalized;
}

function decodeExactUtf8(bytes: Buffer, path: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Workspace effect is not exact UTF-8 text: ${path}`);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`Workspace effect is not exact UTF-8 text: ${path}`);
  }
  return text;
}

/** Why a workspace re-root refused to proceed — always an honest, non-fatal notice, never a partial switch. */
export type WorkspaceReRootReason = "run-active" | "not-found" | "not-a-directory" | "permission-denied";

export interface WorkspaceReRootResult {
  readonly ok: boolean;
  /** Present when `ok` — the resolved absolute path the runtime is now rooted at. */
  readonly workspace?: string;
  /** `HOME_WORKSPACE_WARNING` when the new root is the user's entire home directory, else `null`. Only meaningful when `ok`. */
  readonly homeWarning?: string | null;
  readonly reason?: WorkspaceReRootReason;
  /** Always set — the honest, user-facing line for either outcome. */
  readonly message: string;
}

/**
 * The mutable workspace state one re-root moves — bound differently by each
 * caller (the full interactive runtime also nulls its cached agent so the
 * next run rebuilds against the new guard; a lightweight test context that
 * never wired an agent simply has nothing extra to invalidate).
 */
export interface WorkspaceReRootHost {
  setWorkspace(workspace: string): void;
  setGuard(guard: WorkspaceGuard): void;
  approvals: ApprovalManager;
  ruleStore: RuleStore;
  /** Busy gate: a Cross run in the background blocks a switch — finish or `/cross stop` it first. */
  crossRunActive?: () => boolean;
}

/**
 * The one shared workspace re-root (Phase F1b, `orcode-v3-interaction-
 * fabric.md`): a foreign `/chats` pick and `/folder open|new` both call
 * exactly this function — never two implementations. It never carries
 * approval rules across a switch: `RuleStore` is already one appHome-wide
 * store filtered per call by workspace (`RuleStore.decide`/`.list`), so
 * "reloading" it is just repointing `ApprovalManager`'s cached workspace via
 * `setRuleStore` — the same seam `runCli` wires once at startup.
 */
export async function reRootWorkspace(
  host: WorkspaceReRootHost,
  newWorkspace: string,
): Promise<WorkspaceReRootResult> {
  if (host.crossRunActive?.()) {
    return {
      ok: false,
      reason: "run-active",
      message: "Cross is running. Finish it (or /cross stop) before switching workspaces.",
    };
  }
  const resolved = resolve(newWorkspace);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    // Fix round 1, MINOR 10: a permission failure is not "no longer
    // exists" — the folder may well still be there, just unreadable by this
    // process. Report the real reason (and never offer "remove stale
    // entry" for it — that gate only fires on "not-found"/"not-a-directory").
    if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
      return { ok: false, reason: "permission-denied", message: `Permission denied: ${resolved}` };
    }
    return { ok: false, reason: "not-found", message: `Folder no longer exists: ${resolved}` };
  }
  if (!info.isDirectory()) {
    return { ok: false, reason: "not-a-directory", message: `Not a folder: ${resolved}` };
  }
  const guard = await WorkspaceGuard.create(resolved);
  host.setWorkspace(resolved);
  host.setGuard(guard);
  // Approval rules never travel across a re-root: they were never bundled
  // with the guard to begin with, only ever looked up live by workspace.
  host.approvals.setRuleStore(host.ruleStore, resolved);
  return {
    ok: true,
    workspace: resolved,
    homeWarning: homeWorkspaceWarning(resolved),
    message: `Folder switched: ${resolved}`,
  };
}

/**
 * Marks a string that came from a web page. Page content is data the agent
 * reads, never instruction it follows — the same framing project notes get in
 * agent.ts. Keeping the marker in the value means it survives into the model
 * context even if a caller reformats the surrounding report.
 */
function untrustedLine(value: string): string {
  return `[Page content, untrusted] ${text_(value)}`;
}

function text_(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 500);
}

/**
 * FIX-3: one applied edit, described for the transcript. Everything here comes
 * from the single differ below (`diffText`) — no second diff implementation:
 * `diff` is that function's own unified text, and `added`/`removed` are its
 * whole-file counts, not the counts of whatever fits on screen.
 */
export interface FileChangeNotice {
  /** Workspace-relative display path, the same string the tool result carries. */
  path: string;
  /** `write_file` or `replace_text`. */
  tool: string;
  /** True when the file did not exist before this write. */
  created: boolean;
  added: number;
  removed: number;
  /** Unified diff text, capped by `diffText`'s changed-line budget. */
  diff: string;
  /** True when `diff` left changed lines out. */
  truncated: boolean;
}

export interface CodingToolOptions extends ProcessCallbacks {
  /** Cancels running child processes (Esc / Ctrl+C in the UI). */
  signal?: AbortSignal;
  /** Tracks reads so writes can detect external changes (K4). One per agent. */
  registry?: ReadRegistry;
  /** Groups every change this call bundle makes into one undoable run (A5). */
  runId?: string;
  /**
   * FIX-3: notified once per applied edit, right after the write is on disk
   * and journaled — the seam that lets the UI show the diff in EVERY approval
   * mode instead of only the `✓ 3 replacement(s)` result line. Observational
   * exactly like `ProcessCallbacks`: it never runs before the write, never
   * alters the tool result, and a throwing consumer cannot fail the tool.
   */
  onFileChange?: (change: FileChangeNotice) => void;
  /** `browser_check`: explicit browser binary; unset means auto-detection. */
  browserPath?: string;
  /** `browser_check`: hard limit for one inspection, browser startup included. */
  browserTimeoutSeconds?: number;
  /** `browser_check`: injected in tests so no real browser ever starts. */
  inspectUrlFn?: BrowserEngineModule["inspectUrl"];
  /**
   * `browser_check`: replaces how `browser-engine.js` itself gets loaded.
   * Defaults to a real dynamic `import()`; tests use this to prove a failed
   * load surfaces as the tool's normal error state instead of crashing —
   * `inspectUrlFn` above already bypasses the loader entirely for every
   * other browser_check test, so this is the only seam that exercises it.
   */
  loadBrowserEngineFn?: () => Promise<BrowserEngineModule>;
  /**
   * `ssh_command`'s dependencies. All optional — the tool falls back to a
   * real `~/.ssh/config` and a real `ssh` process when unset, which is what
   * every production caller wants. Tests inject `hosts`/`runSsh` instead of
   * ever touching a real config file or spawning a real `ssh`.
   */
  ssh?: SshToolOptions;
}

export interface SshToolOptions {
  /** Shared live selection owned by the CLI; read only when a tool execution begins. */
  session?: SshSession;
  /** Pre-resolved hosts; bypasses `loadSshHosts` entirely when set. */
  hosts?: readonly SshHost[];
  /** Passed to `loadSshHosts` when `hosts` is unset. */
  configPath?: string;
  /** Injectable `ssh` process runner; defaults to the real `runProcess("ssh", …)`. */
  runSsh?: RunSsh;
  appHome?: string;
  controlPersist?: string;
  connectTimeoutSeconds?: number;
}

export function createCodingTools(
  guard: WorkspaceGuard,
  approvals: ApprovalManager,
  journal: ChangeJournal,
  options: CodingToolOptions = {},
) {
  const signal = options.signal;
  const registry = options.registry ?? new ReadRegistry();
  const runId = options.runId ?? randomUUID();

  /**
   * FIX-3: announces one applied edit to the transcript. Called only after the
   * bytes are on disk and journaled, so what it describes is a fact, never a
   * proposal. A write that changed nothing announces nothing (no empty diff
   * blocks), and a failing observer is swallowed — the write already happened
   * and must not be reported as a tool error.
   */
  const announceFileChange = (
    tool_: string,
    display: string,
    before: string | null,
    after: string,
  ): void => {
    if (!options.onFileChange || before === after) return;
    const diff = diffText(before ?? "", after);
    try {
      options.onFileChange({
        path: display,
        tool: tool_,
        created: before === null,
        added: diff.added,
        removed: diff.removed,
        diff: diff.text,
        truncated: diff.truncated,
      });
    } catch {
      // Volatile UI sinks are observational and cannot fail a finished write.
    }
  };

  const readFileTool = tool({
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. Use lineStart and lineEnd for focused reads. " +
      "Line numbers are a display aid. Never include them in replace_text.oldText or write_file.content.",
    inputSchema: z.object({
      path: z.string(),
      lineStart: z.number().int().positive().optional(),
      lineEnd: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      path: z.string(),
      content: z.string(),
      totalLines: z.number(),
      truncated: z.boolean(),
      sha256: z.string(),
    }),
    execute: async ({ path, lineStart, lineEnd }) => {
      const target = await guard.resolvePath(path);
      const display = guard.display(target);
      await authorizeRead(approvals, "read_file", display);
      // One handle for stat + read: the file cannot be swapped between the
      // size check and the read.
      const handle = await open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new Error(`Not a file: ${path}`);
        }
        if (info.size > MAX_FILE_BYTES) {
          throw new Error(
            `File is too large (${info.size} bytes). Read a smaller excerpt.`,
          );
        }
        const content = await handle.readFile("utf8");
        const digest = sha256Hex(content);
        registry.note(target, {
          mtimeMs: info.mtimeMs,
          size: info.size,
          sha256: digest,
          at: Date.now(),
        });
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, lineStart ?? 1);
        const end = Math.min(lines.length, lineEnd ?? Math.min(lines.length, start + 399));
        const width = Math.max(3, String(end).length);
        const numbered = lines
          .slice(start - 1, end)
          .map((line, offset) => `${String(start + offset).padStart(width)}| ${line}`)
          .join("\n");
        return {
          path: display,
          content: truncate(numbered, MAX_TOOL_OUTPUT),
          totalLines: lines.length,
          truncated: end < lines.length || numbered.length > MAX_TOOL_OUTPUT,
          sha256: digest,
        };
      } finally {
        await handle.close();
      }
    },
  });

  const listFilesTool = tool({
    name: "list_files",
    description: "List files within the workspace using an optional glob pattern.",
    inputSchema: z.object({
      path: z.string().default("."),
      pattern: z.string().default("**/*"),
      limit: z.number().int().min(1).max(2_000).default(300),
      respectGitignore: z.boolean().default(true),
    }),
    outputSchema: z.object({
      files: z.array(z.string()),
      truncated: z.boolean(),
      ignoredCount: z.number(),
      ignoreNote: z.string(),
    }),
    execute: async ({ path, pattern, limit, respectGitignore }) => {
      assertSafeGlobPattern(pattern, "Glob pattern");
      const base = await guard.resolvePath(path);
      await approvals.authorize({
        name: "list_files",
        risk: "read",
        summary: `List files: ${guard.display(base)} · ${pattern}`,
        subject: { kind: "selected-path-glob", base: guard.display(base), pattern },
      });
      const found = await fg(pattern, {
        cwd: base,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        absolute: true,
        deep: MAX_GLOB_DEPTH,
        suppressErrors: true,
        ignore: ["**/.git/**", "**/node_modules/**"],
      });
      // Second line of defence: whatever the pattern did, nothing outside the
      // workspace is reported. The lexical filter is cheap, the guard check
      // (realpath) also catches results reached through a symlinked directory.
      const inside = found
        .filter((file) => isWithinWorkspace(guard.root, resolve(file)))
        .sort()
        .slice(0, MAX_GLOB_RESULTS);
      const displays: string[] = [];
      for (const file of inside) {
        try {
          await guard.resolvePath(resolve(file));
          displays.push(guard.display(resolve(file)));
        } catch {
          // Escapes the workspace through a symlink: not our business.
        }
      }
      const matcher = respectGitignore ? await loadIgnore(guard.root) : null;
      let ignoredCount = 0;
      const kept: string[] = [];
      for (const display of displays) {
        if (matcher?.matches(display, false)) {
          ignoredCount += 1;
          continue;
        }
        kept.push(display);
      }
      const files = kept.slice(0, limit);
      const ignoreNote =
        matcher && matcher.unsupportedCount > 0
          ? `${matcher.unsupportedCount} line(s) in .gitignore not supported (character classes)`
          : "";
      return {
        files,
        truncated: kept.length > limit || inside.length > MAX_GLOB_RESULTS,
        ignoredCount,
        ignoreNote,
      };
    },
  });

  const searchFilesTool = tool({
    name: "search_files",
    description: "Search text inside the workspace with the built-in safe workspace searcher.",
    inputSchema: z.object({
      query: z.string().min(1),
      path: z.string().default("."),
      glob: z.string().optional(),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      contextLines: z.number().int().min(0).max(10).default(0),
      limit: z.number().int().min(1).max(2_000).default(300),
    }),
    outputSchema: z.object({
      matches: z.string(),
      matchCount: z.number(),
      truncated: z.boolean(),
    }),
    execute: async ({ query, path, glob, regex, caseSensitive, contextLines, limit }) => {
      if (glob !== undefined) {
        assertSafeGlobPattern(glob, "Glob pattern");
      }
      const target = await guard.resolvePath(path);
      await approvals.authorize({
        name: "search_files",
        risk: "read",
        summary: `Search text in ${guard.display(target)}${glob ? ` · ${glob}` : ""}`,
        subject: {
          kind: "selected-path-glob",
          base: guard.display(target),
          pattern: glob ?? "**/*",
        },
      });
      const request: WorkspaceSearchOptions = {
        root: guard.root,
        directory: target,
        query,
        ...(glob === undefined ? {} : { glob }),
        regex,
        caseSensitive,
        contextLines,
        limit,
      };
      const result = await searchWorkspaceText(request);
      const matches = truncate(result.matches, MAX_TOOL_OUTPUT);
      return {
        matches,
        matchCount: result.matchCount,
        truncated: result.truncated || matches.length !== result.matches.length,
      };
    },
  });

  const writeFileTool = tool({
    name: "write_file",
    description:
      "Create or fully overwrite a UTF-8 text file inside the workspace. Prefer replace_text for focused edits.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string().max(2_000_000),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      path: z.string(),
      bytes: z.number(),
    }),
    execute: async ({ path, content }) => {
      const target = await guard.resolvePath(path);
      const display = guard.display(target);
      const before = await readOptional(target);
      if (before !== null) {
        await assertNotStale(registry, target, before, display);
      }
      await approvals.authorize(
        writeApprovalRequest("write_file", display, {
          summary: `${before === null ? "Create file" : "Overwrite file"}: ${display}`,
          details: changePreview(before, content),
        }),
      );
      await mkdir(dirname(target), { recursive: true });
      assertLocalWorkEffect(guard.canonicalRoot);signal?.throwIfAborted();
      await atomicWrite(target, content);
      registry.forget(target);
      await journal.record({
        path: target,
        before,
        after: content,
        createdAt: new Date().toISOString(),
        runId,
      });
      announceFileChange("write_file", display, before, content);
      return { ok: true, path: display, bytes: Buffer.byteLength(content) };
    },
  });

  const replaceTextTool = tool({
    name: "replace_text",
    description:
      "Replace an exact text block in an existing UTF-8 file. By default the old text must occur exactly once.",
    inputSchema: z.object({
      path: z.string(),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().default(false),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      path: z.string(),
      replacements: z.number(),
    }),
    execute: async ({ path, oldText, newText, replaceAll }) => {
      if (looksLikeNumberedLines(oldText)) {
        throw new Error(
          "oldText contains the line numbers from read_file. Remove the '<n>| ' prefix and try again.",
        );
      }
      const target = await guard.resolvePath(path);
      const display = guard.display(target);
      const before = await readFile(target, "utf8");
      await assertNotStale(registry, target, before, display);
      const occurrences = countOccurrences(before, oldText);
      if (occurrences === 0) {
        throw new Error(`The old text was not found in ${path}.`);
      }
      if (!replaceAll && occurrences !== 1) {
        throw new Error(
          `The old text occurs ${occurrences} times. Use a more unique block or replaceAll=true.`,
        );
      }
      const replacements = replaceAll ? occurrences : 1;
      const after = replaceLiteral(before, oldText, newText, replacements);
      await approvals.authorize(
        writeApprovalRequest("replace_text", display, {
          summary: `${replacements} replacement(s) in ${display}`,
          details: `- ${truncate(oldText, 1_500)}\n+ ${truncate(newText, 1_500)}`,
        }),
      );
      assertLocalWorkEffect(guard.canonicalRoot);signal?.throwIfAborted();
      await atomicWrite(target, after);
      registry.forget(target);
      await journal.record({ path: target, before, after, createdAt: new Date().toISOString(), runId });
      announceFileChange("replace_text", display, before, after);
      return {
        ok: true,
        path: display,
        replacements,
      };
    },
  });

  const runCommandTool = tool({
    name: "run_command",
    description:
      "Run a shell command in the workspace. Use for builds, tests, git status, and targeted diagnostics.",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(1_800).default(30),
    }),
    outputSchema: z.object({
      command: z.string(),
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ command, timeoutSeconds }) => {
      const executionCommand = command.replaceAll("\r\n", "\n");
      const verdict = assessCommand(executionCommand);
      if (verdict.blocked) {
        throw new Error(
          `The command was blocked by the catastrophic-guard rule (${verdict.rule}): ${verdict.reason}`,
        );
      }
      const shell = await resolveCommandShell();
      const cwd = await canonicalWorkspaceRelativeCwd(guard.root, guard.root);
      await approvals.authorize({
        name: "run_command",
        risk: "shell",
        summary: `Shell command in ${guard.root}`,
        details: executionCommand,
        subject: shellApprovalSubject({
          platform: process.platform,
          executable: shell.executable,
          mode: shell.args,
          cwd,
          command: executionCommand,
        }),
      });
      const result = await runObservedProcess(
        "run_command",
        { command: executionCommand, timeoutSeconds },
        options,
        (onChunk) => runProcess(shell.executable, [...shell.args, executionCommand], {
          cwd: guard.root,
          timeoutMs: timeoutSeconds * 1_000,
          ...(signal ? { signal } : {}),
          onChunk,
        }),
      );
      const stdout = truncate(result.stdout, MAX_TOOL_OUTPUT);
      const stderr = truncate(result.stderr, MAX_TOOL_OUTPUT);
      if (result.launchError || result.code === null) {
        throw new Error(result.launchError || "The shell process could not be started.");
      }
      return {
        command: executionCommand,
        exitCode: result.code,
        stdout,
        stderr,
        truncated:
          result.truncated ||
          stdout.length !== result.stdout.length ||
          stderr.length !== result.stderr.length,
      };
    },
  });

  const gitDiffTool = tool({
    name: "git_diff",
    description: "Show the current git diff without changing files.",
    inputSchema: z.object({
      staged: z.boolean().default(false),
    }),
    outputSchema: z.object({
      diff: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ staged }) => {
      const execution = await runHardenedGitRead(
        guard.root,
        { operation: "diff", staged },
        runProcess,
        async ({ executable, args, cwd, env }, policy) => {
          await approvals.authorize({
            name: "git_diff",
            risk: "shell",
            summary: `git diff${staged ? " --cached" : ""} in ${guard.root}`,
            details:
              "git is invoked without external diff drivers, textconv, fsmonitor, or a pager.",
            rememberable: policy.rememberable,
            subject: processApprovalSubject({
              executable,
              argv: args,
              cwd: await canonicalWorkspaceRelativeCwd(guard.root, cwd),
              forwardedEnvironment: env,
            }),
          });
        },
        {
          ...(signal ? { signal } : {}),
          processCallbacks: options,
          processName: "git_diff",
          processInput: { staged },
        },
      );
      const result = execution.result;
      if (result.code !== 0) {
        throw new Error(result.stderr || "git diff failed.");
      }
      return {
        diff: truncate(result.stdout, MAX_TOOL_OUTPUT),
        truncated: result.truncated || result.stdout.length > MAX_TOOL_OUTPUT,
      };
    },
  });

  /**
   * A target counts as local when nothing leaves this machine: loopback over
   * http(s), or a file inside the workspace. Everything else is somebody
   * else's content and needs an explicit yes.
   */
  const isLocalBrowserTarget = async (
    target: URL,
    workspaceGuard: WorkspaceGuard,
  ): Promise<boolean> => {
    if (target.protocol === "file:") {
      try {
        await workspaceGuard.resolvePath(fileURLToPath(target));
        return true;
      } catch {
        return false;
      }
    }
    return isLocalHttpHost(target.hostname);
  };

  const browserCheckTool = tool({
    name: "browser_check",
    description:
      "Load a page in a headless browser and report what actually happened: title, uncaught JavaScript " +
      "errors, console messages, failed network requests and load time. Use this to verify front-end work " +
      "instead of asking the user whether the page looks right. Local addresses (localhost, 127.0.0.1, " +
      "file:// inside the workspace) run without approval; any other address asks first.",
    inputSchema: z.object({
      url: z.string().min(1),
      waitMs: z.number().int().min(0).max(30_000).default(500),
      viewport: z
        .object({
          width: z.number().int().min(200).max(4000),
          height: z.number().int().min(200).max(4000),
        })
        .optional(),
      fullPage: z.boolean().default(false),
    }),
    outputSchema: z.object({
      url: z.string(),
      title: z.string(),
      pageErrors: z.array(z.string()),
      consoleMessages: z.array(z.string()),
      failedRequests: z.array(z.string()),
      loadTimeMs: z.number(),
      screenshotPath: z.string().nullable(),
      truncated: z.boolean(),
    }),
    execute: async ({ url, waitMs, viewport, fullPage }) => {
      if(isLocalWorkRoot(guard.canonicalRoot))throw new Error('Browser execution is not yet isolated for this working copy.');
      const target = validateBrowserUrl(url);
      const local = await isLocalBrowserTarget(target, guard);
      if (!local) {
        // Loading a third-party page pulls its content into the model context.
        // That is the user's call, not the agent's — a page can carry anything,
        // including text written to steer whoever reads it.
        await approvals.authorize({
          name: "browser_check",
          risk: "network-fetch",
          summary: `Load external page: ${target.href}`,
          details:
            "This page's content goes into the model context. It comes from a third party and is untrusted.",
          subject: browserApprovalSubject(target, "inspect"),
        });
      }
      const operation: ProcessOperation = {
        id: randomUUID(),
        name: "browser_check",
        input: { url: target.href },
      };
      const startedAt = Date.now();
      safeNotify(options.onProcessStart, operation);
      let report: PageReport;
      try {
        // The heavy engine loads here, inside the try: a broken install that
        // fails this import gets the exact same error-state reporting below
        // as any other inspection failure, never an unhandled rejection.
        // `inspectUrlFn` (every existing test) short-circuits this entirely.
        const loadBrowserEngine = options.loadBrowserEngineFn ?? (() => import("./browser-engine.js"));
        const inspect = options.inspectUrlFn ?? (await loadBrowserEngine()).inspectUrl;
        report = await inspect({
          url: target.href,
          timeoutMs: (options.browserTimeoutSeconds ?? 30) * 1000,
          waitMs,
          fullPage,
          ...(viewport ? { viewport } : {}),
          ...(options.browserPath ? { browserPath: options.browserPath } : {}),
          ...(signal ? { signal } : {}),
        });
        safeNotify(options.onProcessEnd, operation, {
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          truncated: report.truncated,
          timedOut: false,
          aborted: false,
        });
      } catch (error) {
        safeNotify(options.onProcessEnd, operation, {
          exitCode: null,
          durationMs: Date.now() - startedAt,
          truncated: false,
          timedOut: error instanceof BrowserTimeoutError,
          aborted: signal?.aborted ?? false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return {
        url: report.url,
        title: report.title,
        // Page-controlled strings. They are quoted as data, never presented as
        // instructions — same framing the project notes get in agent.ts.
        pageErrors: report.pageErrors.map((item) => untrustedLine(item)),
        consoleMessages: report.consoleMessages.map((item) =>
          untrustedLine(`${item.level}: ${item.text}`),
        ),
        failedRequests: report.failedRequests.map((item) =>
          untrustedLine(`${item.status ?? "—"} ${item.url}`),
        ),
        loadTimeMs: report.loadTimeMs,
        screenshotPath: report.screenshotPath,
        truncated: report.truncated,
      };
    },
  });

  const sshCommandTool = tool({
    name: "ssh_command",
    description:
      "Run a shell command on a remote host over SSH, using a host alias from the user's ~/.ssh/config " +
      "(see /ssh in the chat UI to list and check hosts). Omit host to use the currently active /ssh target. " +
      "Key/agent authentication only, never a password. " +
      "This tool always asks for explicit approval before it runs anything, even in auto-edit mode: unlike the " +
      "local tools, there is no workspace sandbox, no undo and no change journal on a remote machine.",
    inputSchema: z.object({
      host: z.string().trim().min(1).optional(),
      command: z.string().min(1).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(1_800).default(30),
    }),
    outputSchema: z.object({
      host: z.string(),
      command: z.string(),
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ host, command, timeoutSeconds }) => {
      if(isLocalWorkRoot(guard.canonicalRoot))throw new Error('Remote execution is outside this local run.');
      const sshOptions = options.ssh ?? {};
      const targetAlias = host ?? sshOptions.session?.active;
      if (!targetAlias) {
        throw new Error(
          "No active SSH target. Pass host explicitly or select one first with /ssh <alias>.",
        );
      }
      const hosts = sshOptions.hosts ?? (await loadSshHosts({ configPath: sshOptions.configPath }));
      const resolved = findSshHost(targetAlias, hosts);
      if (!resolved) {
        throw new Error(
          `"${targetAlias}" is not a known host from the SSH configuration (~/.ssh/config). /ssh shows the available hosts.`,
        );
      }
      const runSsh: RunSsh = sshOptions.runSsh ?? ((args, runOptions) => runProcess("ssh", args, runOptions));

      // ssh_command carries its own risk level ("remote-shell") instead of
      // reusing "shell": WorkspaceGuard, the change journal and /undo only
      // ever cover the local filesystem. A remote host has none of that — no
      // sandbox, no undo, no journal — so a typo there cannot be rolled back
      // the way a local edit or even a local shell command's side effects
      // sometimes can. approval.ts's #decide therefore always asks for
      // "remote-shell", in every mode including auto-edit, and only
      // allow-all is allowed to wave it through.
      await approvals.authorize({
        name: "ssh_command",
        risk: "remote-shell",
        subject: sshApprovalSubject(resolved.alias, command),
        summary: `SSH TARGET: ${resolved.alias.toUpperCase()} (${resolved.hostName}) — ${oneLine(command, 200)}`,
        details: `Runs NOT locally, but on ${resolved.hostName}${
          resolved.user ? ` as ${resolved.user}` : ""
        }.\n$ ${command}`,
      });

      const input = { host: resolved.alias, command, timeoutSeconds };
      const observedRunSsh: RunSsh = (args, runOptions) =>
        runObservedProcess("ssh_command", input, options, (onChunk) =>
          runSsh(args, { ...runOptions, onChunk }));
      const result = await execSshCommand(resolved.alias, hosts, command, observedRunSsh, {
        timeoutSeconds,
        ...(signal ? { signal } : {}),
        runtime: {
          ...(sshOptions.appHome ? { appHome: sshOptions.appHome } : {}),
          ...(sshOptions.controlPersist ? { controlPersist: sshOptions.controlPersist } : {}),
          ...(sshOptions.connectTimeoutSeconds
            ? { connectTimeoutSeconds: sshOptions.connectTimeoutSeconds }
            : {}),
        },
      });
      const stdout = truncate(result.stdout, MAX_TOOL_OUTPUT);
      const stderr = truncate(result.stderr, MAX_TOOL_OUTPUT);
      return {
        host: resolved.alias,
        command,
        exitCode: result.code,
        stdout,
        stderr,
        truncated:
          result.truncated ||
          stdout.length !== result.stdout.length ||
          stderr.length !== result.stderr.length,
      };
    },
  });

  return [
    readFileTool,
    listFilesTool,
    searchFilesTool,
    writeFileTool,
    replaceTextTool,
    runCommandTool,
    gitDiffTool,
    browserCheckTool,
    sshCommandTool,
  ] as const;
}

// ---------------------------------------------------------------------------
// Tool metadata (for UI layers that must not hardcode tool names)
// ---------------------------------------------------------------------------

/**
 * G3: the presentation half moved to `tool-metadata.ts` (import-free but for
 * `utils.ts`) so the desktop window names a tool the way the terminal names
 * it. Re-exported here so every existing importer of `workspace.js` is
 * unchanged, and there is still exactly one table.
 */
export {
  oneLine,
  TOOL_METADATA,
  toolMetadata,
  type SummarizeBodyOptions,
  type ToolMetadata,
} from "./tool-metadata.js";

// ---------------------------------------------------------------------------
// Approval helpers
// ---------------------------------------------------------------------------

/**
 * Build the approval request for a workspace write.
 *
 * Every write must go through here — the tools *and* the command layer.
 * `.git/hooks/**` throws instead of asking; the other protected paths force an
 * explicit yes regardless of the approval mode.
 */
export function writeApprovalRequest(
  name: string,
  displayPath: string,
  parts: { summary: string; details?: string },
): ApprovalRequest {
  const decision = classifyPath(displayPath, "write");
  if (decision.verdict === "deny") {
    throw new Error(`${displayPath} is locked: ${decision.reason}`);
  }
  const details = [
    decision.verdict === "approve" ? decision.reason : "",
    parts.details ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    name,
    risk: "edit",
    summary: parts.summary,
    subject: { kind: "selected-path", path: displayPath },
    ...(details ? { details } : {}),
    ...(decision.verdict === "approve"
      ? { alwaysAsk: true, policyRule: decision.rule }
      : {}),
  };
}

async function authorizeRead(
  approvals: ApprovalManager,
  name: string,
  displayPath: string,
): Promise<void> {
  const decision = classifyPath(displayPath, "read");
  if (decision.verdict === "deny") {
    throw new Error(`${displayPath} is locked: ${decision.reason}`);
  }
  await approvals.authorize({
    name,
    risk: decision.verdict === "approve" ? "secret-read" : "read",
    summary:
      decision.verdict === "approve"
        ? `Read confidential file: ${displayPath}`
        : `Read file: ${displayPath}`,
    subject: { kind: "selected-path", path: displayPath },
    ...(decision.verdict === "approve"
      ? { details: decision.reason, policyRule: decision.rule }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitNullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Global options shared by every automatic read. Each launcher Git can
 * neutralize is overridden at the highest config priority. Filters are the
 * exception: their driver names are arbitrary, so local filter/include
 * configuration is rejected before Git starts instead of guessing names.
 */
function gitHardeningArgs(platform: NodeJS.Platform = process.platform): string[] {
  const nullDevice = gitNullDevice(platform);
  return [
    "--no-pager",
    "--git-dir=.git",
    "--work-tree=.",
    "-c", "diff.external=",
    "-c", "core.pager=",
    "-c", "pager.diff=false",
    "-c", "pager.status=false",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    "-c", "core.askPass=",
    "-c", "core.editor=",
    "-c", "sequence.editor=",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", "color.ui=false",
    "-c", "protocol.allow=never",
    "-c", "submodule.recurse=false",
  ];
}

function gitSafeEnvironment(
  canonicalRoot: string,
  sourceEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const nullDevice = gitNullDevice(platform);
  const environment: NodeJS.ProcessEnv = {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: canonicalRoot,
    GIT_COMMON_DIR: join(canonicalRoot, ".git"),
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_EXTERNAL_DIFF: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  if (platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"] as const) {
      const value = environmentVariable(sourceEnvironment, name, platform);
      if (value !== undefined) environment[name] = value;
    }
  }
  return environment;
}

export function gitDiffArgs(staged: boolean): string[] {
  const args = [
    ...gitHardeningArgs(),
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
  ];
  if (staged) {
    args.push("--cached");
  }
  args.push("--");
  return args;
}

export function gitStatusArgs(): string[] {
  return [
    ...gitHardeningArgs(),
    "status",
    "--porcelain=v1",
    "--branch",
    "--untracked-files=normal",
    "--ignore-submodules=all",
  ];
}

export type RunProcess = (
  executable: string,
  args: string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface HardenedGitInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HardenedGitReadResult {
  policy: GitReadCapabilityPolicy;
  invocation: HardenedGitInvocation;
  result: ProcessResult;
}

export type HardenedGitReadRequest =
  | { operation: "diff"; staged: boolean }
  | { operation: "status" };

export type HardenedGitRuntime = Pick<RunProcessOptions, "signal" | "onChunk"> & {
  /** Injectable source for filtering; production uses the current process environment. */
  environment?: NodeJS.ProcessEnv;
  processCallbacks?: ProcessCallbacks;
  processName?: string;
  processInput?: Record<string, unknown>;
};

function environmentVariable(
  environment: NodeJS.ProcessEnv,
  name: "PATH" | "PATHEXT" | "SystemRoot" | "WINDIR",
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  return Object.entries(environment).find(
    ([candidate, value]) => candidate.toLowerCase() === name.toLowerCase() && value !== undefined,
  )?.[1];
}

function executableCandidates(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
): string[] {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return [resolve(cwd, executable)];
  }
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const directories = (environmentVariable(environment, "PATH", platform) ?? "")
    .split(pathDelimiter)
    .filter(Boolean);
  const extensions = platform === "win32" && !/\.[^\\/.]+$/.test(executable)
    ? (environmentVariable(environment, "PATHEXT", platform) ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return directories.flatMap((directory) =>
    extensions.map((extension) =>
      resolve(cwd, directory, platform === "win32" ? `${executable}${extension}` : executable),
    ),
  );
}

export async function resolveExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): Promise<string> {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    const candidate = resolve(cwd, executable);
    await access(candidate, fsConstants.X_OK);
    return realpath(candidate);
  }
  for (const candidate of executableCandidates(executable, environment, platform, cwd)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Executable not found in PATH: ${executable}`);
}

function pathIsWithinRoot(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

interface GitPathIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface GitExecutableIdentity extends GitPathIdentity {
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface GitMetadataIdentity extends GitExecutableIdentity {
  kind: "file" | "directory";
}

interface GitRepositoryIdentity {
  root: GitPathIdentity;
  metadata: GitMetadataIdentity[];
  config: GitConfigIdentity | null;
}

interface GitConfigIdentity {
  file: GitMetadataIdentity;
  sha256: string;
}

function sameGitPathIdentity(
  left: GitPathIdentity | null,
  right: GitPathIdentity | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

function sameGitExecutableIdentity(
  left: GitExecutableIdentity,
  right: GitExecutableIdentity,
): boolean {
  return sameGitPathIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function gitDirectoryIdentity(path: string): Promise<GitPathIdentity> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Workspace directory was swapped: ${path}`);
  }
  return { path, dev: info.dev, ino: info.ino };
}

async function assertSameGitDirectoryIdentity(expected: GitPathIdentity): Promise<void> {
  let current: GitPathIdentity;
  try {
    current = await gitDirectoryIdentity(expected.path);
  } catch {
    throw new Error(`Workspace directory was swapped before git started: ${expected.path}`);
  }
  if (!sameGitPathIdentity(expected, current)) {
    throw new Error(`Workspace directory was swapped before git started: ${expected.path}`);
  }
}

async function executableIdentity(candidate: string): Promise<GitExecutableIdentity | null> {
  try {
    await access(candidate, fsConstants.X_OK);
    const canonical = await realpath(candidate);
    const info = await lstat(canonical, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return {
      path: canonical,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mode: info.mode,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  } catch {
    return null;
  }
}

async function assertSameGitExecutableIdentity(expected: GitExecutableIdentity): Promise<void> {
  const current = await executableIdentity(expected.path);
  if (current === null || !sameGitExecutableIdentity(expected, current)) {
    throw new Error("The approved git executable was swapped before it started.");
  }
}

async function resolveTrustedGitExecutable(
  canonicalRoot: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  workspaceNames: readonly string[] = [canonicalRoot],
): Promise<GitExecutableIdentity> {
  for (const candidate of executableCandidates("git", environment, platform, process.cwd())) {
    // Check the name supplied by PATH before realpath. Otherwise a symlink
    // owned by the repository can point at an outside fake executable and
    // acquire a superficially trusted canonical path.
    if (workspaceNames.some((workspaceName) => pathIsWithinRoot(workspaceName, candidate))) {
      continue;
    }
    if (await gitCandidateTraversalTouchesWorkspace(candidate, canonicalRoot)) {
      continue;
    }
    const identity = await executableIdentity(candidate);
    if (identity !== null && !pathIsWithinRoot(canonicalRoot, identity.path)) return identity;
  }
  throw new Error("No trusted git executable found outside the workspace.");
}

async function gitCandidateTraversalTouchesWorkspace(
  candidate: string,
  canonicalRoot: string,
): Promise<boolean> {
  const componentsFor = (absolutePath: string): { root: string; parts: string[] } => {
    const root = parse(absolutePath).root;
    return {
      root,
      parts: absolutePath.slice(root.length).split(sep).filter(Boolean),
    };
  };
  let { root: resolvedRoot, parts: pending } = componentsFor(resolve(candidate));
  let prefix = resolvedRoot;
  let symlinkHops = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    if (component === undefined) break;
    if (component === ".") continue;
    if (component === "..") {
      prefix = dirname(prefix);
      if (pathIsWithinRoot(canonicalRoot, prefix)) return true;
      continue;
    }
    prefix = join(prefix, component);
    if (pathIsWithinRoot(canonicalRoot, prefix)) return true;
    let before: BigIntStats;
    try {
      before = await lstat(prefix, { bigint: true });
    } catch {
      // A candidate whose complete prefix chain cannot be inspected is not a
      // trustworthy automatic launcher. The caller will try the next PATH
      // candidate instead of guessing through an unresolved alias.
      return true;
    }
    if (!before.isSymbolicLink()) continue;
    symlinkHops += 1;
    if (symlinkHops > 64) return true;
    try {
      const linkTarget = await readlink(prefix);
      // Preserve dot components exactly. Resolving the whole target here would
      // collapse `..` before an intermediate symlink is followed, which is not
      // how the kernel walks the eventual executable path.
      const target = isAbsolute(linkTarget)
        ? linkTarget
        : `${dirname(prefix)}${sep}${linkTarget}`;
      const after = await lstat(prefix, { bigint: true });
      if (!after.isSymbolicLink() || !sameStableGitFile(before, after)) return true;
      const targetComponents = componentsFor(target);
      resolvedRoot = targetComponents.root;
      prefix = resolvedRoot;
      pending = [...targetComponents.parts, ...pending];
    } catch {
      return true;
    }
  }
  return false;
}

function gitMetadataIdentity(
  path: string,
  info: BigIntStats,
): GitMetadataIdentity {
  return {
    path,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    kind: info.isDirectory() ? "directory" : "file",
  };
}

function sameGitMetadataIdentity(
  left: GitMetadataIdentity,
  right: GitMetadataIdentity,
): boolean {
  return left.kind === right.kind && sameGitExecutableIdentity(left, right);
}

function sameGitRepositoryIdentity(
  left: GitRepositoryIdentity | null,
  right: GitRepositoryIdentity | null,
): boolean {
  if (left === null) return right === null;
  if (right === null || !sameGitPathIdentity(left.root, right.root)) return false;
  if (
    left.config === null
      ? right.config !== null
      : right.config === null
        || left.config.sha256 !== right.config.sha256
        || !sameGitMetadataIdentity(left.config.file, right.config.file)
  ) {
    return false;
  }
  if (left.metadata.length !== right.metadata.length) return false;
  return left.metadata.every((entry, index) => {
    const candidate = right.metadata[index];
    return candidate !== undefined && sameGitMetadataIdentity(entry, candidate);
  });
}

async function snapshotGitMetadataEntry(
  path: string,
  canonicalGitDirectory: string,
  identities: GitMetadataIdentity[],
  counter: { value: number },
  optional = false,
): Promise<void> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (optional && hasCode(error, "ENOENT")) return;
    throw error;
  }
  counter.value += 1;
  if (counter.value > MAX_GIT_METADATA_ENTRIES) {
    throw new Error("Too much git metadata for a safe automatic read.");
  }
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
    throw new Error(`Git metadata is not safely bound: ${path}`);
  }
  const canonical = await realpath(path);
  if (!pathIsWithinRoot(canonicalGitDirectory, canonical)) {
    throw new Error(`Git metadata is outside the workspace: ${path}`);
  }
  const relativeMetadataPath = relative(canonicalGitDirectory, canonical)
    .split(sep)
    .join("/");
  if (
    relativeMetadataPath === "objects/info/alternates" ||
    relativeMetadataPath === "objects/info/http-alternates"
  ) {
    throw new Error("External git object alternates are not safe for automatic reads.");
  }

  if (before.isDirectory()) {
    const children = await readdir(path);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await snapshotGitMetadataEntry(
        join(path, child),
        canonicalGitDirectory,
        identities,
        counter,
      );
    }
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameStableGitFile(before, after)
    ) {
      throw new Error(`Git metadata was swapped during the safety check: ${path}`);
    }
    identities.push(gitMetadataIdentity(canonical, after));
    return;
  }

  const after = await lstat(path, { bigint: true });
  if (after.isSymbolicLink() || !after.isFile() || !sameStableGitFile(before, after)) {
    throw new Error(`Git metadata was swapped during the safety check: ${path}`);
  }
  identities.push(gitMetadataIdentity(canonical, after));
}

async function snapshotAutomaticGitMetadata(
  canonicalGitDirectory: string,
): Promise<GitMetadataIdentity[]> {
  const identities: GitMetadataIdentity[] = [];
  const counter = { value: 0 };
  await snapshotGitMetadataEntry(
    join(canonicalGitDirectory, "HEAD"),
    canonicalGitDirectory,
    identities,
    counter,
  );
  await snapshotGitMetadataEntry(
    join(canonicalGitDirectory, "objects"),
    canonicalGitDirectory,
    identities,
    counter,
  );
  await snapshotGitMetadataEntry(
    join(canonicalGitDirectory, "refs"),
    canonicalGitDirectory,
    identities,
    counter,
  );
  for (const optionalName of ["index", "packed-refs", "shallow", "info"] as const) {
    await snapshotGitMetadataEntry(
      join(canonicalGitDirectory, optionalName),
      canonicalGitDirectory,
      identities,
      counter,
      true,
    );
  }
  return identities.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function sameStableGitFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

interface StableGitConfig {
  content: string;
  identity: GitConfigIdentity;
}

async function readStableGitConfig(configPath: string): Promise<StableGitConfig | null> {
  let namedBefore;
  try {
    namedBefore = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.size > BigInt(MAX_GIT_CONFIG_BYTES)) {
    throw new Error("Local git configuration is not safe for automatic reads.");
  }

  const handle = await open(
    configPath,
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || !sameStableGitFile(namedBefore, openedBefore)) {
      throw new Error("Local git configuration was swapped during the safety check.");
    }
    const config = await handle.readFile("utf8");
    const [openedAfter, namedAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(configPath, { bigint: true }),
    ]);
    if (
      namedAfter.isSymbolicLink()
      || !namedAfter.isFile()
      || !sameStableGitFile(openedBefore, openedAfter)
      || !sameStableGitFile(openedAfter, namedAfter)
    ) {
      throw new Error("Local git configuration was swapped during the safety check.");
    }
    return {
      content: config,
      identity: {
        file: gitMetadataIdentity(configPath, namedAfter),
        sha256: sha256Hex(config),
      },
    };
  } finally {
    await handle.close();
  }
}

function assertSafeAutomaticGitConfig(config: string): void {
  if (config.includes("\0")) {
    throw new Error("Local git configuration is not safe for automatic reads.");
  }
  let currentSection = "";
  const declaresWorktreeConfig = (value: string) =>
    /^\s*worktreeconfig(?:\s*=|\s*(?:[#;].*)?$)/i.test(value);
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*([a-z][a-z0-9-]*)[^\]]*\](.*)$/i.exec(line);
    if (section !== null) {
      currentSection = section[1]?.toLowerCase() ?? "";
      if (currentSection === "filter") {
        throw new Error("Local git filter configuration is not safe for automatic reads.");
      }
      if (currentSection === "include" || currentSection === "includeif") {
        throw new Error("Local git include configuration is not safe for automatic reads.");
      }
      if (currentSection === "extensions" && declaresWorktreeConfig(section[2] ?? "")) {
        throw new Error("Local git worktree configuration is not safe for automatic reads.");
      }
      continue;
    }
    if (
      currentSection === "extensions"
      && declaresWorktreeConfig(line)
    ) {
      throw new Error("Local git worktree configuration is not safe for automatic reads.");
    }
  }
}

async function assertNoGitCommonDirectory(gitDirectory: string): Promise<void> {
  try {
    await lstat(join(gitDirectory, "commondir"));
    throw new Error("External shared git metadata is not safe for automatic reads.");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function assertSafeAutomaticGitRepository(canonicalRoot: string): Promise<GitRepositoryIdentity | null> {
  const gitDirectory = join(canonicalRoot, ".git");
  let gitDirectoryInfo;
  try {
    gitDirectoryInfo = await lstat(gitDirectory, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (gitDirectoryInfo.isSymbolicLink() || !gitDirectoryInfo.isDirectory()) {
    throw new Error("Git metadata outside the canonical workspace is not safe.");
  }
  const canonicalGitDirectory = await realpath(gitDirectory);
  if (!pathIsWithinRoot(canonicalRoot, canonicalGitDirectory)) {
    throw new Error("Git metadata outside the canonical workspace is not safe.");
  }
  const gitIdentity: GitPathIdentity = {
    path: canonicalGitDirectory,
    dev: gitDirectoryInfo.dev,
    ino: gitDirectoryInfo.ino,
  };

  await assertNoGitCommonDirectory(gitDirectory);
  const metadata = await snapshotAutomaticGitMetadata(canonicalGitDirectory);
  const gitDirectoryAfter = await lstat(gitDirectory, { bigint: true });
  if (
    gitDirectoryAfter.isSymbolicLink()
    || !gitDirectoryAfter.isDirectory()
    || gitDirectoryAfter.dev !== gitIdentity.dev
    || gitDirectoryAfter.ino !== gitIdentity.ino
  ) {
    throw new Error("Git repository was swapped during the safety check.");
  }

  // GIT_COMMON_DIR is pinned to this canonical .git directory in the child
  // environment. Keep the explicit absence check after the long metadata walk
  // as the last repository-layout check as well, so the fake/test runner and
  // the real Git path share the same fail-closed contract.
  await assertNoGitCommonDirectory(gitDirectory);

  // `config.worktree` is only consulted when `extensions.worktreeConfig` is
  // enabled in the primary config. Reject both surfaces instead of reading two
  // mutable files sequentially and leaving a race window between them.
  try {
    await lstat(join(gitDirectory, "config.worktree"));
    throw new Error("Local git worktree configuration is not safe for automatic reads.");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const config = await readStableGitConfig(join(gitDirectory, "config"));
  if (config !== null) assertSafeAutomaticGitConfig(config.content);
  return {
    root: gitIdentity,
    metadata,
    config: config?.identity ?? null,
  };
}

export async function runHardenedGitRead(
  root: string,
  request: HardenedGitReadRequest,
  runner: RunProcess = runProcess,
  beforeRun?: (invocation: HardenedGitInvocation, policy: GitReadCapabilityPolicy) => Promise<void>,
  runtime: HardenedGitRuntime = {},
): Promise<HardenedGitReadResult> {
  const operation: GitReadOperation = request.operation;
  const policy = evaluateGitReadCapability(operation);
  const sourceEnvironment = runtime.environment ?? process.env;
  const lexicalRoot = resolve(root);
  const canonicalRoot = await realpath(root);
  const rootIdentity = await gitDirectoryIdentity(canonicalRoot);
  const executableIdentity = await resolveTrustedGitExecutable(
    canonicalRoot,
    sourceEnvironment,
    process.platform,
    [lexicalRoot, canonicalRoot],
  );
  const repositoryIdentity = await assertSafeAutomaticGitRepository(canonicalRoot);
  const effectiveEnvironment = gitSafeEnvironment(canonicalRoot, sourceEnvironment);
  const {
    environment: _environment,
    processCallbacks,
    processName,
    processInput,
    ...processRuntime
  } = runtime;
  const invocation: HardenedGitInvocation = {
    executable: executableIdentity.path,
    args: request.operation === "diff" ? gitDiffArgs(request.staged) : gitStatusArgs(),
    cwd: canonicalRoot,
    env: effectiveEnvironment,
  };
  await beforeRun?.(invocation, policy);
  const execute = async (onChunk: RunProcessOptions["onChunk"]) => {
    // With process observers, runObservedProcess emits the visible start event
    // before invoking this closure. Keep the final identity checks here so an
    // observational callback cannot open an unchecked mutation window before
    // the actual spawn. The repository snapshot is deliberately last and the
    // runner is invoked immediately after it, without another callback.
    await assertSameGitDirectoryIdentity(rootIdentity);
    await assertSameGitExecutableIdentity(executableIdentity);
    const currentRepositoryIdentity = await assertSafeAutomaticGitRepository(canonicalRoot);
    if (!sameGitRepositoryIdentity(repositoryIdentity, currentRepositoryIdentity)) {
      throw new Error("Git repository was swapped before it started.");
    }
    return runner(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      timeoutMs: request.operation === "diff" ? 20_000 : 3_000,
      env: invocation.env,
      ...processRuntime,
      ...(onChunk ? { onChunk } : {}),
    });
  };
  const result = processCallbacks
    ? await runObservedProcess(
        processName ?? policy.id,
        processInput ?? { operation: request.operation },
        processCallbacks,
        (observedChunk) => execute((stream, text) => {
          safeNotify(processRuntime.onChunk, stream, text);
          observedChunk(stream, text);
        }),
      )
    : await execute(processRuntime.onChunk);
  return { policy, invocation, result };
}

export async function getGitDiff(
  root: string,
  runner: RunProcess = runProcess,
  processCallbacks?: ProcessCallbacks,
): Promise<string> {
  const { result } = await runHardenedGitRead(
    root,
    { operation: "diff", staged: false },
    runner,
    undefined,
    processCallbacks
      ? { processCallbacks, processName: "git_diff", processInput: { staged: false } }
      : {},
  );
  if (result.code !== 0) {
    return result.stderr || "No git repository, or git diff failed.";
  }
  return result.stdout || "No uncommitted changes.";
}

export async function getGitStatus(root: string, runner: RunProcess = runProcess): Promise<ProcessResult> {
  return (await runHardenedGitRead(root, { operation: "status" }, runner)).result;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function atomicWrite(
  path: string,
  content: string,
  restoredMode?: number,
  restoredXattrs: Readonly<Record<string, string>> = Object.freeze({}),
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  // New files are private by default; existing files keep their permissions.
  let mode = restoredMode === undefined ? 0o600 : restoredMode & 0o777;
  let existed = false;
  try {
    if (restoredMode === undefined) mode = (await lstat(path)).mode & 0o777;
    else await lstat(path);
    existed = true;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  const temporary = resolve(parent, `.${basename(path)}.${randomUUID()}.orcode.tmp`);
  try {
    // "wx" = O_CREAT | O_EXCL: never write through an existing file or symlink.
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, path);
    await writeWorkspaceExtendedAttributes(path, restoredXattrs);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (existed || restoredMode !== undefined) {
    await chmod(path, mode);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/** Matches every line `read_file`'s `<n>| ` numbering produces. */
const NUMBERED_LINE = /^\s*\d+\|\s/;

function looksLikeNumberedLines(value: string): boolean {
  const lines = value.split(/\r?\n/);
  return lines.length > 0 && lines.every((line) => NUMBERED_LINE.test(line));
}

/**
 * Throws the K4 "stale" error when `target` was noted in `registry` (i.e. the
 * agent read it before) but its content on disk no longer matches what was
 * noted. A path the registry has never seen ("unknown") is never blocked —
 * that is what lets `write_file` create files freely.
 */
async function assertNotStale(
  registry: ReadRegistry,
  target: string,
  currentContent: string,
  display: string,
): Promise<void> {
  const info = await stat(target);
  const freshness = registry.check(target, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    sha256: sha256Hex(currentContent),
  });
  if (freshness === "stale") {
    throw new Error(
      `${display} was changed externally after you last read it. Re-read the affected lines before writing.`,
    );
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

/**
 * Literal replacement.
 *
 * `String.prototype.replace` interprets `$&`, `` $` ``, `$'` and `$1` in the
 * replacement, which silently writes something other than what the approval
 * preview showed. Both the single and the replace-all path go through here.
 */
export function replaceLiteral(
  content: string,
  oldText: string,
  newText: string,
  maximum: number,
): string {
  if (maximum <= 0 || oldText.length === 0) {
    return content;
  }
  let result = "";
  let offset = 0;
  let done = 0;
  while (done < maximum) {
    const index = content.indexOf(oldText, offset);
    if (index < 0) {
      break;
    }
    result += content.slice(offset, index) + newText;
    offset = index + oldText.length;
    done += 1;
  }
  return result + content.slice(offset);
}

// ---------------------------------------------------------------------------
// Line diff (approval preview + UI rendering)
// ---------------------------------------------------------------------------

/**
 * The diff VOCABULARY moved to `diff-parse.ts` (G3), which has no imports at
 * all, so the desktop window can reach the same reader the terminal uses
 * instead of prefix-matching `+`/`-` itself. One definition, re-exported here
 * so every existing importer of `workspace.js` is untouched.
 */
export type { DiffLine, DiffLineType, TextDiff } from "./diff-parse.js";

export function diffText(
  before: string,
  after: string,
  options: { maxChangedLines?: number; context?: number } = {},
): TextDiff {
  const maxChangedLines = options.maxChangedLines ?? DIFF_PREVIEW_CHANGED_LINES;
  const context = options.context ?? DIFF_CONTEXT_LINES;
  const all = computeDiffLines(splitDiffLines(before), splitDiffLines(after));
  const added = all.filter((line) => line.type === "add").length;
  const removed = all.filter((line) => line.type === "del").length;
  const totalChanges = added + removed;

  const changedIndices: number[] = [];
  for (let index = 0; index < all.length; index += 1) {
    if (all[index]!.type !== "ctx") {
      changedIndices.push(index);
    }
  }
  const allowed = changedIndices.slice(0, maxChangedLines);
  const keep = new Set<number>();
  for (const index of allowed) {
    for (let offset = -context; offset <= context; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < all.length) {
        keep.add(candidate);
      }
    }
  }
  const kept = [...keep].sort((left, right) => left - right);
  const lines = kept.map((index) => all[index]!);
  const shownChanges = lines.filter((line) => line.type !== "ctx").length;
  const omittedChanges = totalChanges - shownChanges;

  return {
    lines,
    added,
    removed,
    shownChanges,
    omittedChanges,
    truncated: omittedChanges > 0,
    text: formatUnifiedDiff(all, kept, omittedChanges),
  };
}

/**
 * Splits content into diff lines the way every diff tool does: a trailing
 * newline TERMINATES the last line instead of starting an empty one, and
 * empty content is zero lines rather than one empty line.
 *
 * `"".split(/\n/)` yields `[""]`, which made a brand-new two-line file report
 * `+2 -1` — a removal of a line that never existed. Harmless while nothing
 * rendered those counts; FIX-3 puts them on screen, so the lie had to go at
 * the source (one differ, one fix) rather than at one call site.
 */
function splitDiffLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r?\n$/, "").split(/\r?\n/);
}

export function formatUnifiedDiff(
  all: DiffLine[],
  kept: number[],
  omittedChanges: number,
): string {
  if (kept.length === 0) {
    return "No line change.";
  }
  const out: string[] = ["--- before", "+++ after"];
  let index = 0;
  while (index < kept.length) {
    let end = index;
    while (end + 1 < kept.length && kept[end + 1] === kept[end]! + 1) {
      end += 1;
    }
    const hunk = kept.slice(index, end + 1).map((position) => all[position]!);
    const oldStart = hunk.find((line) => line.oldLine !== null)?.oldLine ?? 0;
    const newStart = hunk.find((line) => line.newLine !== null)?.newLine ?? 0;
    const oldCount = hunk.filter((line) => line.oldLine !== null).length;
    const newCount = hunk.filter((line) => line.newLine !== null).length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of hunk) {
      const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      out.push(`${marker}${oneLineLimited(line.text)}`);
    }
    index = end + 1;
  }
  if (omittedChanges > 0) {
    out.push(`… ${omittedChanges} more changed line(s) not shown.`);
  }
  return out.join("\n");
}

// FIX-14 ticket 7: `ellipsize` (utils.ts). This used to append the marker
// OUTSIDE the slice, so a cut search line rendered MAX_SEARCH_LINE_CHARS + 1
// characters — one more than the constant it is named after promises.
function oneLineLimited(value: string): string {
  return ellipsize(value, MAX_SEARCH_LINE_CHARS);
}

function computeDiffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);

  const result: DiffLine[] = [];
  for (let index = 0; index < start; index += 1) {
    result.push({ type: "ctx", text: before[index]!, oldLine: index + 1, newLine: index + 1 });
  }
  const middle =
    middleBefore.length * middleAfter.length <= DIFF_LCS_BUDGET
      ? lcsOperations(middleBefore, middleAfter)
      : coarseOperations(middleBefore, middleAfter);
  let oldLine = start + 1;
  let newLine = start + 1;
  for (const operation of middle) {
    if (operation.type === "ctx") {
      result.push({ type: "ctx", text: operation.text, oldLine: oldLine++, newLine: newLine++ });
    } else if (operation.type === "del") {
      result.push({ type: "del", text: operation.text, oldLine: oldLine++, newLine: null });
    } else {
      result.push({ type: "add", text: operation.text, oldLine: null, newLine: newLine++ });
    }
  }
  for (let index = endBefore; index < before.length; index += 1) {
    result.push({ type: "ctx", text: before[index]!, oldLine: oldLine++, newLine: newLine++ });
  }
  return result;
}

interface DiffOperation {
  type: DiffLineType;
  text: string;
}

/** Classic LCS diff. Only ever called on the differing middle section. */
function lcsOperations(before: string[], after: string[]): DiffOperation[] {
  const rows = before.length;
  const columns = after.length;
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        before[row] === after[column]
          ? table[(row + 1) * width + column + 1]! + 1
          : Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
    }
  }
  const operations: DiffOperation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      operations.push({ type: "ctx", text: before[row]! });
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
      operations.push({ type: "del", text: before[row]! });
      row += 1;
    } else {
      operations.push({ type: "add", text: after[column]! });
      column += 1;
    }
  }
  while (row < rows) {
    operations.push({ type: "del", text: before[row]! });
    row += 1;
  }
  while (column < columns) {
    operations.push({ type: "add", text: after[column]! });
    column += 1;
  }
  return operations;
}

/** Fallback for pathologically large changes: whole block out, whole block in. */
function coarseOperations(before: string[], after: string[]): DiffOperation[] {
  return [
    ...before.map((line): DiffOperation => ({ type: "del", text: line })),
    ...after.map((line): DiffOperation => ({ type: "add", text: line })),
  ];
}

export function changePreview(before: string | null, after: string): string {
  if (before === null) {
    return `New file, ${Buffer.byteLength(after)} bytes\n${truncate(after, 3_000)}`;
  }
  if (before === after) {
    return "Content unchanged.";
  }
  const diff = diffText(before, after);
  // Same line rule as the diff printed right below this header, or the two
  // halves of one preview would count the same file differently.
  const header = `${splitDiffLines(before).length} → ${splitDiffLines(after).length} lines, ${Buffer.byteLength(
    before,
  )} → ${Buffer.byteLength(after)} bytes, +${diff.added}/-${diff.removed}`;
  return `${header}\n${diff.text}`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Shell used for `run_command`.
 *
 * Never a login shell: `zsh -lc` sources `.zshenv`/`.zprofile`, which puts the
 * very secrets `sanitizedEnvironment()` just removed back into the child and
 * can `cd` away from the workspace. `ORCODE_SHELL` overrides the default
 * (`ROUTERCODE_SHELL` still works too, for anyone with it already set).
 */
export async function resolveCommandShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  resolveExecutable: typeof resolveExecutablePath = resolveExecutablePath,
): Promise<{ executable: string; args: string[] }> {
  const configured = (environment.ORCODE_SHELL ?? environment.ROUTERCODE_SHELL)?.trim();
  // Windows hat kein /bin/sh: dort ist PowerShell (immer vorinstalliert) der
  // Default. Ein konfigurierter Shell-Pfad gewinnt auf jeder Plattform.
  const requestedExecutable =
    configured && configured.length > 0
      ? configured
      : platform === "win32"
        ? "powershell.exe"
        : "/bin/sh";
  const executable = await resolveExecutable(requestedExecutable, environment, platform);
  const name = executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "cmd" || name === "cmd.exe") {
    return { executable, args: ["/d", "/s", "/c"] };
  }
  if (name.includes("pwsh") || name.includes("powershell")) {
    // Kein Profil (könnte das Arbeitsverzeichnis oder die Umgebung ändern)
    // und nicht-interaktiv — PowerShell versteht -c nicht zuverlässig.
    return { executable, args: ["-NoProfile", "-NonInteractive", "-Command"] };
  }
  if (name.includes("zsh")) {
    return { executable, args: ["--no-rcs", "-c"] };
  }
  if (name.includes("bash")) {
    return { executable, args: ["--noprofile", "--norc", "-c"] };
  }
  return { executable, args: ["-c"] };
}

export const CATASTROPHIC_GUARD_NOTICE =
  "The catastrophic-guard rule is only a speed bump against obvious total-loss disasters, not a security boundary: variables, aliases, scripts, base64, or a second shell call bypass it. Rely on the approval mode, not this list.";

/** Honest wording for the UI; the guard is a speed bump, not a boundary. */
export function catastrophicGuardNotice(): string {
  return CATASTROPHIC_GUARD_NOTICE;
}

export interface CommandVerdict {
  blocked: boolean;
  rule?: string;
  reason?: string;
}

const TOP_LEVEL_DIRECTORIES = new Set([
  "/applications",
  "/bin",
  "/boot",
  "/cores",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/library",
  "/network",
  "/nix",
  "/opt",
  "/private",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/system",
  "/usr",
  "/users",
  "/var",
  "/volumes",
]);

const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "time",
  "xargs",
]);

/**
 * Best-effort detector for commands that destroy the machine rather than the
 * project. It parses the command instead of matching one fixed spelling, so
 * flag order, long options, `/*`, `$HOME` and simple variable assignments are
 * covered — but see CATASTROPHIC_GUARD_NOTICE: this is a speed bump.
 */
export function assessCommand(command: string): CommandVerdict {
  const expanded = expandSimpleAssignments(command);
  if (expanded.replace(/\s+/g, "").includes(":(){:|:&};:")) {
    return {
      blocked: true,
      rule: "fork-bomb",
      reason: "The command contains a fork bomb.",
    };
  }
  for (const segment of commandSegments(expanded)) {
    const verdict = assessSegment(segment);
    if (verdict) {
      return { blocked: true, ...verdict };
    }
  }
  return { blocked: false };
}

export function isCatastrophic(command: string): boolean {
  return assessCommand(command).blocked;
}

function assessSegment(tokens: string[]): { rule: string; reason: string } | null {
  if (tokens.length === 0) {
    return null;
  }
  const names = new Set(
    tokens
      .filter((token) => !token.startsWith("-") && !isAssignment(token))
      .map((token) => baseCommandName(token)),
  );
  const flags = tokens.filter((token) => token.startsWith("-"));
  const operands = tokens.filter(
    (token) => !token.startsWith("-") && !isAssignment(token) && !COMMAND_WRAPPERS.has(token),
  );
  const hasRootTarget = operands.some((operand) => isRootLike(operand));
  const recursive = flags.some(
    (flag) =>
      flag === "--recursive" ||
      flag === "-R" ||
      (/^-[A-Za-z]*$/.test(flag) && /[rR]/.test(flag.slice(1))),
  );

  if (names.has("rm") && recursive && hasRootTarget) {
    return {
      rule: "rm-root",
      reason: "recursive deletion of a system or home directory.",
    };
  }
  if (
    names.has("find") &&
    hasRootTarget &&
    (flags.includes("-delete") || (flags.includes("-exec") && names.has("rm")))
  ) {
    return {
      rule: "find-delete-root",
      reason: "find deletes recursively under a system or home directory.",
    };
  }
  if (
    (names.has("chmod") || names.has("chown") || names.has("chgrp")) &&
    recursive &&
    hasRootTarget
  ) {
    return {
      rule: "chmod-root",
      reason: "recursive permission change on a system or home directory.",
    };
  }
  if (names.has("dd") && tokens.some((token) => /^of=\/dev\//i.test(token))) {
    return { rule: "dd-device", reason: "dd writes directly to a device." };
  }
  if ([...names].some((name) => /^mkfs(\.|$)/.test(name))) {
    return { rule: "mkfs", reason: "Formatting a filesystem." };
  }
  if (
    names.has("diskutil") &&
    tokens.some((token) =>
      ["erase", "erasedisk", "erasevolume", "partition", "partitiondisk", "reformat", "zerodisk"].includes(
        token.toLowerCase(),
      ),
    )
  ) {
    return { rule: "diskutil", reason: "diskutil erases or partitions a disk." };
  }
  if (names.has("shutdown") || names.has("reboot") || names.has("halt") || names.has("poweroff")) {
    return { rule: "power", reason: "Shutting down or restarting the machine." };
  }
  if (names.has("mv") && hasRootTarget && operands.includes("/dev/null")) {
    return { rule: "mv-devnull", reason: "Moving a system directory to /dev/null." };
  }
  return null;
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function baseCommandName(token: string): string {
  const withoutPath = token.includes("/") ? (token.split("/").at(-1) ?? token) : token;
  return withoutPath.toLowerCase();
}

function isRootLike(raw: string): boolean {
  let value = raw.trim();
  if (value.length === 0) {
    return false;
  }
  value = value.replace(/\/+/g, "/").replace(/\/\.$/, "/");
  if (value.length > 1) {
    value = value.replace(/\/$/, "");
  }
  const lower = value.toLowerCase();
  if (lower === "/" || lower === "/*" || lower === "/*/*") {
    return true;
  }
  if (/^~\/?\*?$/.test(lower)) {
    return true;
  }
  if (/^\$\{?home\}?\/?\*?$/.test(lower)) {
    return true;
  }
  if (TOP_LEVEL_DIRECTORIES.has(lower)) {
    return true;
  }
  if (/^\/(users|home)\/[^/]+(\/\*)?$/.test(lower)) {
    return true;
  }
  return false;
}

/** Resolves `x=/; rm -rf $x` style indirection before the command is judged. */
function expandSimpleAssignments(command: string): string {
  const values = new Map<string, string>();
  const assignment =
    /(?:^|[\n;&|(]\s*)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g;
  let match = assignment.exec(command);
  while (match) {
    values.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? "");
    match = assignment.exec(command);
  }
  if (values.size === 0) {
    return command;
  }
  return command.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const value = values.get(name);
      return value === undefined ? whole : value;
    },
  );
}

/** Splits a command line into segments of unquoted tokens. */
function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  const pushToken = () => {
    if (started) {
      current.push(token);
      token = "";
      started = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        token += next;
        started = true;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      pushToken();
      continue;
    }
    if ("\n;|&()`".includes(character)) {
      pushSegment();
      continue;
    }
    token += character;
    started = true;
  }
  pushSegment();
  return segments;
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export interface RunProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Complete effective child environment; defaults to the sanitized process environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Fired for every chunk actually kept in `stdout`/`stderr` (K3 live shell).
   * Called after `appendBounded`, with the text that was really adopted —
   * never more than what made it into the bounded buffer.
   */
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ProcessResult {
  /** Null means the executable never produced an ordinary process exit. */
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Present when the child ended by signal instead of an ordinary exit. */
  signal?: NodeJS.Signals | null;
  /** Present when the executable could not be launched at all. */
  launchError?: string;
}

function safeNotify<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  try {
    callback?.(...args);
  } catch {
    // A display/log sink is observational and must never change execution.
  }
}

/** Runs one already-authorized child exactly once and emits one bounded lifecycle. */
export async function runObservedProcess(
  name: string,
  input: Record<string, unknown>,
  callbacks: ProcessCallbacks,
  execute: (onChunk: NonNullable<RunProcessOptions["onChunk"]>) => Promise<ProcessResult>,
): Promise<ProcessResult> {
  const operation: ProcessOperation = { id: randomUUID(), name, input };
  const startedAt = Date.now();
  let terminal = false;
  safeNotify(callbacks.onProcessStart, operation);
  const onChunk: NonNullable<RunProcessOptions["onChunk"]> = (stream, text) => {
    if (terminal || text.length === 0) return;
    safeNotify(callbacks.onProcessChunk, operation, stream, text);
  };
  const finish = (completion: ProcessCompletion): void => {
    if (terminal) return;
    terminal = true;
    safeNotify(callbacks.onProcessEnd, operation, completion);
  };
  try {
    const result = await execute(onChunk);
    const stdout = boundedProcessCompletionText(result.stdout);
    const stderr = boundedProcessCompletionText(result.stderr);
    const signal = result.signal ?? null;
    finish({
      exitCode: signal || result.launchError ? null : result.code,
      ...(signal ? { signal } : {}),
      durationMs: Date.now() - startedAt,
      truncated:
        result.truncated ||
        stdout.length !== result.stdout.length ||
        stderr.length !== result.stderr.length,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout,
      stderr,
      ...(result.launchError ? { error: result.launchError } : {}),
    });
    return result;
  } catch (error) {
    finish({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      truncated: false,
      timedOut: false,
      aborted: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function boundedProcessCompletionText(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT) return value;
  const suffix = "\n… truncated …";
  return `${value.slice(0, MAX_TOOL_OUTPUT - suffix.length)}${suffix}`;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const launch=await isolatedLaunch(options.cwd,executable,args);
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    if (options.signal?.aborted) {
      resolvePromise({
        code: 130,
        stdout,
        stderr: "Cancelled before the process started.",
        truncated,
        timedOut: false,
        aborted: true,
        signal: null,
      });
      return;
    }

    const child = spawn(launch.executable, launch.args, {
      cwd: options.cwd,
      env: options.env ?? sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout can take the whole tree down instead
      // of only the shell that spawned it.
      detached: true,
    });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: ProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const killGroup = (signalName: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // The process is already gone.
        }
      }
    };
    const stop = (reason: "timeout" | "abort") => {
      if (settled) {
        return;
      }
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), PROCESS_KILL_GRACE_MS).unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const note =
        reason === "timeout"
          ? `Time limit of ${options.timeoutMs / 1_000}s reached, process group terminated.`
          : "Cancelled, process group terminated.";
      // Resolve now: waiting for "close" would wait for the very children the
      // timeout is supposed to get rid of.
      finish({
        code: reason === "timeout" ? 124 : 130,
        stdout,
        stderr: `${stderr}\n${note}`.trim(),
        truncated,
        timedOut: reason === "timeout",
        aborted: reason === "abort",
        signal: null,
      });
    };
    const onAbort = () => stop("abort");
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      const next = appendBounded(stdout, chunk, MAX_TOOL_OUTPUT * 3);
      stdout = next.value;
      truncated ||= next.truncated;
      if (next.adopted.length > 0) {
        safeNotify(options.onChunk, "stdout", next.adopted);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (settled) return;
      const next = appendBounded(stderr, chunk, MAX_TOOL_OUTPUT * 3);
      stderr = next.value;
      truncated ||= next.truncated;
      if (next.adopted.length > 0) {
        safeNotify(options.onChunk, "stderr", next.adopted);
      }
    });
    child.on("error", (error) => {
      finish({
        code: null,
        stdout,
        stderr,
        truncated,
        timedOut: false,
        aborted: false,
        signal: null,
        launchError: compactProcessLaunchError(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({
        code: code ?? 1,
        stdout,
        stderr,
        truncated,
        timedOut: false,
        aborted: false,
        signal,
      });
    });
  });
}

function compactProcessLaunchError(error: unknown): string {
  return truncate(redactText(errorMessage(error)), 1_000);
}

function appendBounded(
  current: string,
  chunk: string,
  maximum: number,
): { value: string; truncated: boolean; adopted: string } {
  if (current.length >= maximum) {
    return { value: current, truncated: true, adopted: "" };
  }
  const available = maximum - current.length;
  if (chunk.length <= available) {
    return { value: current + chunk, truncated: false, adopted: chunk };
  }
  const adopted = chunk.slice(0, available);
  return {
    value: current + adopted,
    truncated: true,
    adopted,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface WorkspaceSearchOptions {
  /** Workspace root, used for the displayed paths. */
  root: string;
  /** Absolute directory to search in. */
  directory: string;
  query: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  limit?: number;
}

export interface WorkspaceSearchResult {
  matches: string;
  matchCount: number;
  filesWithMatches: number;
  truncated: boolean;
}

/**
 * Built-in searcher. Keeping one implementation here makes policy, matching,
 * output, and limits identical on every machine.
 */
export async function searchWorkspaceText(
  options: WorkspaceSearchOptions,
): Promise<WorkspaceSearchResult> {
  const limit = options.limit ?? 300;
  const contextLines = options.contextLines ?? 0;
  const pattern = options.glob ?? "**/*";
  assertSafeGlobPattern(pattern, "Glob pattern");
  const matcher = buildMatcher(options.query, options.regex ?? false, options.caseSensitive ?? false);

  const candidates = await fg(pattern, {
    cwd: options.directory,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    absolute: true,
    deep: MAX_GLOB_DEPTH,
    suppressErrors: true,
    ignore: [...SEARCH_IGNORES],
  });
  const ignoreMatcher = await loadIgnore(options.root);
  const files = candidates
    .filter((file) => isWithinWorkspace(options.root, resolve(file)))
    .filter((file) => !hasReservedSearchSegment(options.root, file))
    // Secrets are not searched: the hit line would be the leak.
    .filter((file) => classifyPath(relative(options.root, file), "read").verdict === "allow")
    .filter((file) => !ignoreMatcher.matches(relative(options.root, file), false))
    .sort()
    .slice(0, MAX_SEARCH_FILES);

  const realRoot = await realpath(options.root).catch(() => options.root);
  const output: string[] = [];
  let matchCount = 0;
  let filesWithMatches = 0;
  let truncated = candidates.length > MAX_SEARCH_FILES;
  let size = 0;

  for (const file of files) {
    if (matchCount >= limit || size > MAX_TOOL_OUTPUT * 2) {
      truncated = true;
      break;
    }
    if (!(await resolvesInside(file, realRoot))) {
      continue;
    }
    let content: Buffer;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      content = await readFile(file);
    } catch {
      continue;
    }
    if (isBinary(content)) {
      continue;
    }
    const display = relative(options.root, file) || basename(file);
    const lines = content.toString("utf8").split(/\r?\n/);
    const hits: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (matcher(lines[index]!)) {
        hits.push(index);
      }
    }
    if (hits.length === 0) {
      continue;
    }
    filesWithMatches += 1;
    const rendered = renderHits(display, lines, hits, contextLines, limit - matchCount);
    matchCount += rendered.shown;
    if (rendered.shown < hits.length) {
      truncated = true;
    }
    for (const line of rendered.lines) {
      output.push(line);
      size += line.length + 1;
    }
  }

  return {
    matches: output.join("\n"),
    matchCount,
    filesWithMatches,
    truncated,
  };
}

/** Search never descends into reserved trees, even when the search is scoped there. */
function hasReservedSearchSegment(root: string, file: string): boolean {
  const segments = relative(root, resolve(file)).split(/[\\/]+/);
  return segments.some((segment) => {
    const lowered = segment.toLowerCase();
    return lowered === ".git" || lowered === "node_modules";
  });
}

function buildMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): (line: string) => boolean {
  if (regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(query, caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(
        `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return (line) => expression.test(line);
  }
  if (caseSensitive) {
    return (line) => line.includes(query);
  }
  const needle = query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

function renderHits(
  display: string,
  lines: string[],
  hits: number[],
  contextLines: number,
  budget: number,
): { lines: string[]; shown: number } {
  const shownHits = hits.slice(0, Math.max(0, budget));
  const keep = new Set<number>();
  for (const hit of shownHits) {
    for (let offset = -contextLines; offset <= contextLines; offset += 1) {
      const candidate = hit + offset;
      if (candidate >= 0 && candidate < lines.length) {
        keep.add(candidate);
      }
    }
  }
  const hitSet = new Set(shownHits);
  const ordered = [...keep].sort((left, right) => left - right);
  const out: string[] = [];
  let previous: number | null = null;
  for (const index of ordered) {
    if (previous !== null && index > previous + 1) {
      out.push("--");
    }
    const separator = hitSet.has(index) ? ":" : "-";
    out.push(`${display}${separator}${index + 1}${separator}${oneLineLimited(lines[index]!)}`);
    previous = index;
  }
  return { lines: out, shown: shownHits.length };
}

/** A symlink inside the workspace must not be a window to the outside. */
async function resolvesInside(file: string, realRoot: string): Promise<boolean> {
  try {
    const real = await realpath(file);
    return real === realRoot || real.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

function isBinary(content: Buffer): boolean {
  const head = content.subarray(0, 8_000);
  return head.includes(0);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function isWithinWorkspace(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    return false;
  }
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// `sanitizedEnvironment` now lives in utils.ts (browser.ts needs it too, and
// importing it from here would create a workspace.ts <-> browser.ts cycle);
// re-exported so every existing import of it from workspace.ts keeps working.
export { sanitizedEnvironment };
