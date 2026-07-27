import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ApprovalManager, ApprovalRequest } from "./approval.js";
import { APP_HOME, writeFileAtomicSecure } from "./config.js";
import { loadIgnore } from "./ignore.js";
import {
  inspectUrl,
  isLocalHttpHost,
  validateBrowserUrl,
} from "./browser.js";
import { assertSafeGlobPattern, classifyPath } from "./policy.js";
import { ReadRegistry, sha256Hex } from "./read-registry.js";
import { findSshHost, loadSshHosts, type SshHost } from "./ssh-config.js";
import { execSshCommand, type RunSsh } from "./ssh.js";
import type { ToolRisk } from "./types.js";
import { hasCode, isRecord, sanitizedEnvironment, truncate } from "./utils.js";

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

/** Directories that never contain search hits worth showing. */
const SEARCH_IGNORES = ["**/.git/**", "**/node_modules/**"] as const;

/** Exported so a fresh process (resume after a crash) can validate and load a persisted run's entries without duplicating this shape. */
export interface ChangeEntry {
  path: string;
  before: string | null;
  after: string;
  createdAt: string;
  /** Groups every entry made by one agent run, for run-level undo (A5). */
  runId: string;
}

export interface ChangeJournalOptions {
  /** Root the checkpoint files live under. Defaults to `~/.orcode`. */
  appHome?: string;
  /** Chat this journal belongs to. Checkpoints are namespaced per chat. */
  chatId?: string;
}

/** Where one run's checkpoint entries live. Shared so a fresh process can find the same file `ChangeJournal` itself would write to. */
export function checkpointRunPath(appHome: string, chatId: string, runId: string): string {
  return join(appHome, "checkpoints", chatId, `${runId}.json`);
}

function isChangeEntry(value: unknown): value is ChangeEntry {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.before === null || typeof value.before === "string") &&
    typeof value.after === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.runId === "string"
  );
}

export interface UndoRunOutcome {
  /** Workspace-relative paths that were restored (or would be, in dry-run). */
  restored: string[];
  /** Files whose content no longer matched what the run wrote — left alone. */
  skipped: Array<{ path: string; reason: string }>;
}

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

  constructor(options: ChangeJournalOptions = {}) {
    this.#appHome = options.appHome ?? APP_HOME;
    this.#chatId = options.chatId ?? "default";
  }

  async record(entry: ChangeEntry): Promise<void> {
    this.#entries.push(entry);
    await this.#persistRun(entry.runId);
  }

  get size(): number {
    return this.#entries.length;
  }

  #runFile(runId: string): string {
    return checkpointRunPath(this.#appHome, this.#chatId, runId);
  }

  async #persistRun(runId: string): Promise<void> {
    const entries = this.#entries.filter((entry) => entry.runId === runId);
    await writeFileAtomicSecure(this.#runFile(runId), JSON.stringify(entries));
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
      raw = await readFile(this.#runFile(runId), "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const valid = parsed.filter(isChangeEntry).filter((entry) => entry.runId === runId);
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
      if (current !== entry.after) {
        skipped.push({ path: display, reason: "wurde nach dem Lauf extern geändert" });
        continue;
      }
      if (!options.dryRun) {
        await approvals.authorize(
          writeApprovalRequest("undo", display, {
            summary: `Lauf-Änderung an ${display} rückgängig machen`,
            details:
              entry.before === null
                ? "Die neu angelegte Datei wird gelöscht."
                : "Der vorherige Dateiinhalt wird wiederhergestellt.",
          }),
        );
        if (entry.before === null) {
          await unlink(entry.path);
        } else {
          await atomicWrite(entry.path, entry.before);
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

function formatUndoSummary(outcome: UndoRunOutcome, dryRun: boolean): string {
  if (outcome.restored.length === 0 && outcome.skipped.length === 0) {
    return "Keine orcode-Änderung zum Rückgängigmachen vorhanden.";
  }
  const lines: string[] = [];
  const verb = dryRun ? "würden wiederhergestellt" : "wiederhergestellt";
  if (outcome.restored.length > 0) {
    lines.push(`${outcome.restored.length} Datei(en) ${verb}: ${outcome.restored.join(", ")}`);
  }
  if (outcome.skipped.length > 0) {
    lines.push(
      `${outcome.skipped.length} Datei(en) übersprungen (extern geändert): ${outcome.skipped
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
  options: { maxAgeDays?: number; maxBytesPerChat?: number } = {},
): Promise<void> {
  const maxAgeMs = (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1_000;
  const maxBytes = options.maxBytesPerChat ?? 100 * 1_024 * 1_024;
  const root = join(appHome, "checkpoints");
  let chatIds: string[];
  try {
    chatIds = await readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const chatId of chatIds) {
    const dir = join(root, chatId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const infos: Array<{ file: string; mtimeMs: number; size: number }> = [];
    for (const file of files) {
      const full = join(dir, file);
      try {
        const info = await stat(full);
        infos.push({ file: full, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Gone already: nothing to prune.
      }
    }
    for (const info of infos) {
      if (now - info.mtimeMs > maxAgeMs) {
        await unlink(info.file).catch(() => undefined);
      }
    }
    const remaining = infos
      .filter((info) => now - info.mtimeMs <= maxAgeMs)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = remaining.reduce((sum, info) => sum + info.size, 0);
    for (const info of remaining) {
      if (total <= maxBytes) {
        break;
      }
      await unlink(info.file).catch(() => undefined);
      total -= info.size;
    }
  }
}

export class WorkspaceGuard {
  private constructor(
    public readonly root: string,
    private readonly realRoot: string,
  ) {}

  static async create(root: string): Promise<WorkspaceGuard> {
    const absolute = resolve(root);
    const info = await stat(absolute);
    if (!info.isDirectory()) {
      throw new Error(`Arbeitsverzeichnis ist kein Ordner: ${absolute}`);
    }
    return new WorkspaceGuard(absolute, await realpath(absolute));
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
      throw new Error(`Pfad liegt außerhalb des Arbeitsverzeichnisses: ${candidate}`);
    }
  }

  private async assertReal(candidate: string): Promise<void> {
    let existing = candidate;
    while (true) {
      try {
        const resolved = await realpath(existing);
        if (resolved !== this.realRoot && !resolved.startsWith(`${this.realRoot}${sep}`)) {
          throw new Error(`Symlink verlässt das Arbeitsverzeichnis: ${candidate}`);
        }
        return;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
        const parent = dirname(existing);
        if (parent === existing) {
          throw new Error(`Pfad konnte nicht abgesichert werden: ${candidate}`);
        }
        existing = parent;
      }
    }
  }
}

/**
 * Marks a string that came from a web page. Page content is data the agent
 * reads, never instruction it follows — the same framing project notes get in
 * agent.ts. Keeping the marker in the value means it survives into the model
 * context even if a caller reformats the surrounding report.
 */
function untrustedLine(value: string): string {
  return `[Seiteninhalt, nicht vertrauenswürdig] ${text_(value)}`;
}

function text_(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 500);
}

export interface CodingToolOptions {
  /** Cancels running child processes (Esc / Ctrl+C in the UI). */
  signal?: AbortSignal;
  /** Tracks reads so writes can detect external changes (K4). One per agent. */
  registry?: ReadRegistry;
  /** Groups every change this call bundle makes into one undoable run (A5). */
  runId?: string;
  /** Fired once, right before a child process starts (K3, live shell). */
  onProcessStart?: (handle: object, tool: string, input: Record<string, unknown>) => void;
  /** Fired for every chunk of stdout/stderr a running process produces (K3). */
  onProcessChunk?: (handle: object, stream: "stdout" | "stderr", text: string) => void;
  /** `browser_check`: explicit browser binary; unset means auto-detection. */
  browserPath?: string;
  /** `browser_check`: hard limit for one inspection, browser startup included. */
  browserTimeoutSeconds?: number;
  /** `browser_check`: injected in tests so no real browser ever starts. */
  inspectUrlFn?: typeof inspectUrl;
  /**
   * `ssh_command`'s dependencies. All optional — the tool falls back to a
   * real `~/.ssh/config` and a real `ssh` process when unset, which is what
   * every production caller wants. Tests inject `hosts`/`runSsh` instead of
   * ever touching a real config file or spawning a real `ssh`.
   */
  ssh?: SshToolOptions;
}

export interface SshToolOptions {
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
          throw new Error(`Keine Datei: ${path}`);
        }
        if (info.size > MAX_FILE_BYTES) {
          throw new Error(
            `Datei ist zu groß (${info.size} Bytes). Lies einen kleineren Ausschnitt.`,
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
      assertSafeGlobPattern(pattern, "Glob-Muster");
      const base = await guard.resolvePath(path);
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
          ? `${matcher.unsupportedCount} Zeilen in .gitignore nicht unterstützt (Zeichenklassen)`
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
    description:
      "Search text inside the workspace. Uses ripgrep when available and a built-in searcher otherwise.",
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
        assertSafeGlobPattern(glob, "Glob-Muster");
      }
      const target = await guard.resolvePath(path);
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
      const result = (await ripgrepSearch(request, signal)) ?? (await searchWorkspaceText(request));
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
          summary: `${before === null ? "Datei anlegen" : "Datei überschreiben"}: ${display}`,
          details: changePreview(before, content),
        }),
      );
      await mkdir(dirname(target), { recursive: true });
      await atomicWrite(target, content);
      registry.forget(target);
      await journal.record({
        path: target,
        before,
        after: content,
        createdAt: new Date().toISOString(),
        runId,
      });
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
          "oldText enthält die Zeilennummern aus read_file. Entferne das Präfix '<n>| ' und versuche es erneut.",
        );
      }
      const target = await guard.resolvePath(path);
      const display = guard.display(target);
      const before = await readFile(target, "utf8");
      await assertNotStale(registry, target, before, display);
      const occurrences = countOccurrences(before, oldText);
      if (occurrences === 0) {
        throw new Error(`Der alte Text wurde in ${path} nicht gefunden.`);
      }
      if (!replaceAll && occurrences !== 1) {
        throw new Error(
          `Der alte Text kommt ${occurrences}-mal vor. Nutze einen eindeutigeren Block oder replaceAll=true.`,
        );
      }
      const replacements = replaceAll ? occurrences : 1;
      const after = replaceLiteral(before, oldText, newText, replacements);
      await approvals.authorize(
        writeApprovalRequest("replace_text", display, {
          summary: `${replacements} Ersetzung(en) in ${display}`,
          details: `- ${truncate(oldText, 1_500)}\n+ ${truncate(newText, 1_500)}`,
        }),
      );
      await atomicWrite(target, after);
      registry.forget(target);
      await journal.record({ path: target, before, after, createdAt: new Date().toISOString(), runId });
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
      const verdict = assessCommand(command);
      if (verdict.blocked) {
        throw new Error(
          `Der Befehl wurde durch die Katastrophenschutz-Regel blockiert (${verdict.rule}): ${verdict.reason}`,
        );
      }
      await approvals.authorize({
        name: "run_command",
        risk: "shell",
        summary: `Shell-Befehl in ${guard.root}`,
        details: command,
      });
      const shell = resolveCommandShell();
      const handle: object = {};
      options.onProcessStart?.(handle, "run_command", { command, timeoutSeconds });
      const result = await runProcess(shell.executable, [...shell.args, command], {
        cwd: guard.root,
        timeoutMs: timeoutSeconds * 1_000,
        ...(signal ? { signal } : {}),
        onChunk: (stream, text) => options.onProcessChunk?.(handle, stream, text),
      });
      const stdout = truncate(result.stdout, MAX_TOOL_OUTPUT);
      const stderr = truncate(result.stderr, MAX_TOOL_OUTPUT);
      return {
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
      // git executes repository-controlled code (diff drivers, textconv,
      // fsmonitor, pager). Even with all of that switched off below it stays a
      // process launch, so it is priced as one.
      await approvals.authorize({
        name: "git_diff",
        risk: "shell",
        summary: `git diff${staged ? " --cached" : ""} in ${guard.root}`,
        details:
          "git wird ohne externe Diff-Treiber, ohne textconv, ohne fsmonitor und ohne Pager aufgerufen.",
      });
      const handle: object = {};
      options.onProcessStart?.(handle, "git_diff", { staged });
      const result = await runProcess("git", gitDiffArgs(staged), {
        cwd: guard.root,
        timeoutMs: 20_000,
        env: GIT_SAFE_ENVIRONMENT,
        ...(signal ? { signal } : {}),
        onChunk: (stream, text) => options.onProcessChunk?.(handle, stream, text),
      });
      if (result.code !== 0) {
        throw new Error(result.stderr || "git diff ist fehlgeschlagen.");
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
      const target = validateBrowserUrl(url);
      const local = await isLocalBrowserTarget(target, guard);
      if (!local) {
        // Loading a third-party page pulls its content into the model context.
        // That is the user's call, not the agent's — a page can carry anything,
        // including text written to steer whoever reads it.
        await approvals.authorize({
          name: "browser_check",
          risk: "network-fetch",
          summary: `Fremde Seite laden: ${target.href}`,
          details:
            "Der Inhalt dieser Seite geht in den Modellkontext. Er stammt von Dritten und ist nicht vertrauenswürdig.",
        });
      }
      const handle: object = {};
      options.onProcessStart?.(handle, "browser_check", { url: target.href });
      const inspect = options.inspectUrlFn ?? inspectUrl;
      const report = await inspect({
        url: target.href,
        timeoutMs: (options.browserTimeoutSeconds ?? 30) * 1000,
        waitMs,
        fullPage,
        ...(viewport ? { viewport } : {}),
        ...(options.browserPath ? { browserPath: options.browserPath } : {}),
      });
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
      "(see /ssh in the chat UI to list and check hosts). Key/agent authentication only, never a password. " +
      "This tool always asks for explicit approval before it runs anything, even in auto-edit mode: unlike the " +
      "local tools, there is no workspace sandbox, no undo and no change journal on a remote machine.",
    inputSchema: z.object({
      host: z.string().min(1),
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
      const sshOptions = options.ssh ?? {};
      const hosts = sshOptions.hosts ?? (await loadSshHosts({ configPath: sshOptions.configPath }));
      const resolved = findSshHost(host, hosts);
      if (!resolved) {
        throw new Error(
          `„${host}“ ist kein bekannter Host aus der SSH-Konfiguration (~/.ssh/config). /ssh zeigt die verfügbaren Hosts.`,
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
        host,
        command,
        summary: `SSH-ZIEL: ${host.toUpperCase()} (${resolved.hostName}) — ${oneLine(command, 200)}`,
        details: `Läuft NICHT lokal, sondern auf ${resolved.hostName}${
          resolved.user ? ` als ${resolved.user}` : ""
        }.\n$ ${command}`,
      });

      const handle: object = {};
      options.onProcessStart?.(handle, "ssh_command", { host, command, timeoutSeconds });
      const result = await execSshCommand(host, hosts, command, runSsh, {
        timeoutSeconds,
        ...(signal ? { signal } : {}),
        onChunk: (stream, text) => options.onProcessChunk?.(handle, stream, text),
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
        host,
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

export interface SummarizeBodyOptions {
  /** How many preview lines to keep. Defaults to 3 (K2's collapsed card). */
  maxLines?: number;
}

export interface ToolMetadata {
  /** Tool name as the model sees it. */
  readonly name: string;
  /** Short uppercase badge, e.g. "SHELL". */
  readonly label: string;
  /** German display name for lists and headings. */
  readonly title: string;
  /** Risk level the tool authorizes with. */
  readonly risk: ToolRisk;
  /** One-line German summary of the call arguments. */
  readonly summarizeInput: (input: Record<string, unknown>) => string;
  /** One-line German summary of the tool result. */
  readonly summarizeOutput: (output: unknown) => string;
  /**
   * Preview lines for a collapsed tool card body. On failure (an `exitCode`
   * field that is not 0), lines matching the error pattern from the design
   * doc are preferred, taken from the start; otherwise the last lines.
   */
  readonly summarizeBody: (output: unknown, opts?: SummarizeBodyOptions) => string[];
  /** Full, unabridged text representation of the output (for the pager). */
  readonly fullText: (output: unknown) => string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oneLine(value: string, maximum: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1)}…`;
}

function nonEmptyLines(value: string): number {
  return value.split("\n").filter((line) => line.trim().length > 0).length;
}

/** From the design doc (section 2.5): lines a failed run's preview prefers. */
const ERROR_LINE_PATTERN = /(^|\s)(error|ERROR|FAIL|✗|panic|Traceback|error TS\d+)/;

function nonEmptyLineList(value: string): string[] {
  return value.split("\n").filter((line) => line.length > 0);
}

/**
 * Shared preview logic: on failure, the first lines that look like an error
 * win; otherwise the tail. Falls back to the tail if nothing matches, so a
 * failing tool with no recognisable error text still shows something.
 */
function bodyFromText(
  value: string,
  exitCode: number | null,
  opts: SummarizeBodyOptions,
): string[] {
  const maxLines = opts.maxLines ?? 3;
  const lines = nonEmptyLineList(value);
  if (lines.length === 0) {
    return [];
  }
  if (exitCode !== null && exitCode !== 0) {
    const matches = lines.filter((line) => ERROR_LINE_PATTERN.test(line));
    return (matches.length > 0 ? matches : lines).slice(0, maxLines);
  }
  return lines.slice(-maxLines);
}

function metadataEntry(
  name: string,
  label: string,
  title: string,
  risk: ToolRisk,
  summarizeInput: (input: Record<string, unknown>) => string,
  summarizeOutput: (output: Record<string, unknown>) => string,
  summarizeBody: (output: Record<string, unknown>, opts: SummarizeBodyOptions) => string[],
  fullText: (output: Record<string, unknown>) => string,
): ToolMetadata {
  return {
    name,
    label,
    title,
    risk,
    summarizeInput,
    summarizeOutput: (output: unknown) => {
      const data = record(output);
      return data ? summarizeOutput(data) : "Ergebnis empfangen";
    },
    summarizeBody: (output: unknown, opts: SummarizeBodyOptions = {}) => {
      const data = record(output);
      return data ? summarizeBody(data, opts) : [];
    },
    fullText: (output: unknown) => {
      const data = record(output);
      return data ? fullText(data) : "";
    },
  };
}

/**
 * Single source of truth for how a tool call is displayed.
 *
 * Shape: `Record<toolName, ToolMetadata>`. Consumers look a tool up by name
 * (`toolMetadata(name)` falls back to a generic entry) and use `label`/`title`
 * for headers, `risk` for colouring, and the two `summarize*` functions
 * instead of reaching into the output object themselves.
 */
/** Flattens a browser report into the text the UI and the pager show. */
function browserReportText(output: Record<string, unknown>): string {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((item) => String(item)) : [];
  const lines: string[] = [`${output.title ?? ""} — ${output.url ?? ""}`];
  const errors = list(output.pageErrors);
  const failed = list(output.failedRequests);
  const console_ = list(output.consoleMessages);
  if (errors.length > 0) lines.push("", "JS-Fehler:", ...errors);
  if (failed.length > 0) lines.push("", "Fehlgeschlagene Anfragen:", ...failed);
  if (console_.length > 0) lines.push("", "Konsole:", ...console_);
  if (errors.length === 0 && failed.length === 0) {
    lines.push("", "Keine JS-Fehler, keine fehlgeschlagenen Anfragen.");
  }
  return lines.join("\n");
}

export const TOOL_METADATA: Readonly<Record<string, ToolMetadata>> = Object.freeze({
  read_file: metadataEntry(
    "read_file",
    "READ",
    "Datei lesen",
    "read",
    (input) => {
      const range =
        input.lineStart !== undefined || input.lineEnd !== undefined
          ? ` · Zeilen ${text(input.lineStart) || "1"}–${text(input.lineEnd) || "…"}`
          : "";
      return `${text(input.path) || "Datei"}${range}`;
    },
    (output) =>
      `${count(output.totalLines) ?? "?"} Zeilen${output.truncated ? " · Ausschnitt" : ""}`,
    (output, opts) => bodyFromText(text(output.content), null, opts),
    (output) => text(output.content),
  ),
  list_files: metadataEntry(
    "list_files",
    "LIST",
    "Dateien auflisten",
    "read",
    (input) => `${text(input.path) || "."} · ${text(input.pattern) || "**/*"}`,
    (output) =>
      `${Array.isArray(output.files) ? output.files.length : 0} Dateien${
        output.truncated ? " · Liste gekürzt" : ""
      }`,
    (output, opts) =>
      bodyFromText(Array.isArray(output.files) ? output.files.join("\n") : "", null, opts),
    (output) => (Array.isArray(output.files) ? output.files.join("\n") : ""),
  ),
  search_files: metadataEntry(
    "search_files",
    "SEARCH",
    "Text suchen",
    "read",
    (input) => `„${oneLine(text(input.query), 160)}“ in ${text(input.path) || "."}`,
    (output) =>
      `${count(output.matchCount) ?? nonEmptyLines(text(output.matches))} Trefferzeilen${
        output.truncated ? " · Ausgabe gekürzt" : ""
      }`,
    (output, opts) => bodyFromText(text(output.matches), null, opts),
    (output) => text(output.matches),
  ),
  write_file: metadataEntry(
    "write_file",
    "WRITE",
    "Datei schreiben",
    "edit",
    (input) => text(input.path) || "Datei",
    (output) => `${count(output.bytes) ?? "?"} Bytes geschrieben`,
    (output) => [`${text(output.path) || "Datei"}: ${count(output.bytes) ?? "?"} Bytes geschrieben`],
    (output) => `${text(output.path) || "Datei"}: ${count(output.bytes) ?? "?"} Bytes geschrieben`,
  ),
  replace_text: metadataEntry(
    "replace_text",
    "EDIT",
    "Text ersetzen",
    "edit",
    (input) => text(input.path) || "Datei",
    (output) => `${count(output.replacements) ?? "?"} Ersetzung(en)`,
    (output) => [
      `${text(output.path) || "Datei"}: ${count(output.replacements) ?? "?"} Ersetzung(en)`,
    ],
    (output) =>
      `${text(output.path) || "Datei"}: ${count(output.replacements) ?? "?"} Ersetzung(en)`,
  ),
  run_command: metadataEntry(
    "run_command",
    "SHELL",
    "Shell-Befehl",
    "shell",
    (input) => oneLine(text(input.command) || "Shell-Befehl", 300),
    (output) => {
      const last = text(output.stdout) || text(output.stderr);
      const lastLine = last
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .at(-1);
      return [
        `Exit ${count(output.exitCode) ?? "?"}`,
        lastLine ? oneLine(lastLine, 240) : "",
        output.truncated ? "Ausgabe gekürzt" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    (output, opts) =>
      bodyFromText(
        [text(output.stdout), text(output.stderr)].filter(Boolean).join("\n"),
        count(output.exitCode),
        opts,
      ),
    (output) =>
      [`$ ${text(output.command)}`, text(output.stdout), text(output.stderr)]
        .filter(Boolean)
        .join("\n"),
  ),
  browser_check: metadataEntry(
    "browser_check",
    "BROWSER",
    "Seitenprüfung",
    "network-fetch",
    (input) => String(input.url ?? ""),
    (output) => {
      const errors = Array.isArray(output.pageErrors) ? output.pageErrors.length : 0;
      const failed = Array.isArray(output.failedRequests) ? output.failedRequests.length : 0;
      const parts = [`${output.loadTimeMs ?? 0}ms`];
      if (errors > 0) parts.push(`${errors} JS-Fehler`);
      if (failed > 0) parts.push(`${failed} fehlgeschlagene Anfragen`);
      if (errors === 0 && failed === 0) parts.push("ohne Fehler");
      return parts.join(" · ");
    },
    (output, opts) => bodyFromText(browserReportText(output), null, opts),
    (output) => browserReportText(output),
  ),
  git_diff: metadataEntry(
    "git_diff",
    "GIT DIFF",
    "Git-Diff",
    "shell",
    (input) => (input.staged ? "gestagte Änderungen" : "Arbeitsbaum"),
    (output) =>
      `${nonEmptyLines(text(output.diff))} Diff-Zeilen${
        output.truncated ? " · Ausgabe gekürzt" : ""
      }`,
    (output, opts) => bodyFromText(text(output.diff), null, opts),
    (output) => text(output.diff),
  ),
  ssh_command: metadataEntry(
    "ssh_command",
    "SSH",
    "SSH-Befehl",
    "remote-shell",
    (input) =>
      `${text(input.host) || "Host"}: ${oneLine(text(input.command) || "Befehl", 260)}`,
    (output) => {
      const last = text(output.stdout) || text(output.stderr);
      const lastLine = last
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .at(-1);
      return [
        `${text(output.host) || "Host"} · Exit ${count(output.exitCode) ?? "?"}`,
        lastLine ? oneLine(lastLine, 240) : "",
        output.truncated ? "Ausgabe gekürzt" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    (output, opts) =>
      bodyFromText(
        [text(output.stdout), text(output.stderr)].filter(Boolean).join("\n"),
        count(output.exitCode),
        opts,
      ),
    (output) =>
      [`$ ssh ${text(output.host)} ${text(output.command)}`, text(output.stdout), text(output.stderr)]
        .filter(Boolean)
        .join("\n"),
  ),
});

export function toolMetadata(name: string): ToolMetadata {
  const known = TOOL_METADATA[name];
  if (known) {
    return known;
  }
  return metadataEntry(
    name,
    name.replaceAll("_", " ").toUpperCase(),
    name,
    "read",
    (input) => oneLine(safeJson(input) || name, 300),
    () => "Ergebnis empfangen",
    (output, opts) => bodyFromText(safeJson(output), null, opts),
    (output) => safeJson(output),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

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
    throw new Error(`${displayPath} ist gesperrt: ${decision.reason}`);
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
  if (decision.verdict === "allow") {
    return;
  }
  if (decision.verdict === "deny") {
    throw new Error(`${displayPath} ist gesperrt: ${decision.reason}`);
  }
  await approvals.authorize({
    name,
    risk: "secret-read",
    summary: `Vertrauliche Datei lesen: ${displayPath}`,
    details: decision.reason,
    policyRule: decision.rule,
  });
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * Config keys that turn `git diff` into an arbitrary program launcher. They are
 * overridden on the command line (`-c` wins over every config file) *and* in
 * the environment, because a repository can ship its own `.git/config`.
 */
const GIT_HARDENING = [
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.fsmonitor=false",
] as const;

const GIT_SAFE_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_EXTERNAL_DIFF: "",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

export function gitDiffArgs(staged: boolean): string[] {
  const args = [...GIT_HARDENING, "diff", "--no-ext-diff", "--no-textconv"];
  if (staged) {
    args.push("--cached");
  }
  args.push("--");
  return args;
}

export async function getGitDiff(root: string): Promise<string> {
  const result = await runProcess("git", gitDiffArgs(false), {
    cwd: root,
    timeoutMs: 20_000,
    env: GIT_SAFE_ENVIRONMENT,
  });
  if (result.code !== 0) {
    return result.stderr || "Kein Git-Repository oder git diff ist fehlgeschlagen.";
  }
  return result.stdout || "Keine uncommitteten Änderungen.";
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  // New files are private by default; existing files keep their permissions.
  let mode = 0o600;
  let existed = false;
  try {
    mode = (await lstat(path)).mode & 0o777;
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
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (existed) {
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
      `${display} wurde nach deinem letzten Lesen extern geändert. Lies die betroffenen Zeilen erneut, bevor du schreibst.`,
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

export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the old content, null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the new content, null for removed lines. */
  newLine: number | null;
}

export interface TextDiff {
  /** Selected lines (changes plus context), ready to render. */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Changed lines contained in `lines`. */
  shownChanges: number;
  /** Changed lines that did not fit. */
  omittedChanges: number;
  truncated: boolean;
  /** Pre-formatted unified diff for consumers that just want a string. */
  text: string;
}

export function diffText(
  before: string,
  after: string,
  options: { maxChangedLines?: number; context?: number } = {},
): TextDiff {
  const maxChangedLines = options.maxChangedLines ?? DIFF_PREVIEW_CHANGED_LINES;
  const context = options.context ?? DIFF_CONTEXT_LINES;
  const all = computeDiffLines(before.split(/\r?\n/), after.split(/\r?\n/));
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

export function formatUnifiedDiff(
  all: DiffLine[],
  kept: number[],
  omittedChanges: number,
): string {
  if (kept.length === 0) {
    return "Keine Zeilenänderung.";
  }
  const out: string[] = ["--- vorher", "+++ nachher"];
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
    out.push(`… ${omittedChanges} weitere geänderte Zeile(n) nicht angezeigt.`);
  }
  return out.join("\n");
}

function oneLineLimited(value: string): string {
  return value.length <= MAX_SEARCH_LINE_CHARS
    ? value
    : `${value.slice(0, MAX_SEARCH_LINE_CHARS)}…`;
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
    return `Neue Datei, ${Buffer.byteLength(after)} Bytes\n${truncate(after, 3_000)}`;
  }
  if (before === after) {
    return "Inhalt unverändert.";
  }
  const diff = diffText(before, after);
  const header = `${before.split(/\r?\n/).length} → ${after.split(/\r?\n/).length} Zeilen, ${Buffer.byteLength(
    before,
  )} → ${Buffer.byteLength(after)} Bytes, +${diff.added}/-${diff.removed}`;
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
export function resolveCommandShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  const configured = (environment.ORCODE_SHELL ?? environment.ROUTERCODE_SHELL)?.trim();
  // Windows hat kein /bin/sh: dort ist PowerShell (immer vorinstalliert) der
  // Default. Ein konfigurierter Shell-Pfad gewinnt auf jeder Plattform.
  const executable =
    configured && configured.length > 0
      ? configured
      : platform === "win32"
        ? "powershell.exe"
        : "/bin/sh";
  const name = basename(executable).toLowerCase();
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
  "Die Katastrophenschutz-Regel ist nur eine Stolperschwelle gegen offensichtliche Totalschäden, keine Sicherheitsgrenze: Variablen, Aliase, Skripte, base64 oder ein zweiter Shell-Aufruf umgehen sie. Verlass dich auf den Freigabemodus, nicht auf diese Liste.";

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
      reason: "Der Befehl enthält eine Fork-Bombe.",
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
      reason: "rekursives Löschen eines System- oder Home-Verzeichnisses.",
    };
  }
  if (
    names.has("find") &&
    hasRootTarget &&
    (flags.includes("-delete") || (flags.includes("-exec") && names.has("rm")))
  ) {
    return {
      rule: "find-delete-root",
      reason: "find löscht rekursiv unterhalb eines System- oder Home-Verzeichnisses.",
    };
  }
  if (
    (names.has("chmod") || names.has("chown") || names.has("chgrp")) &&
    recursive &&
    hasRootTarget
  ) {
    return {
      rule: "chmod-root",
      reason: "rekursive Rechteänderung auf einem System- oder Home-Verzeichnis.",
    };
  }
  if (names.has("dd") && tokens.some((token) => /^of=\/dev\//i.test(token))) {
    return { rule: "dd-device", reason: "dd schreibt direkt auf ein Gerät." };
  }
  if ([...names].some((name) => /^mkfs(\.|$)/.test(name))) {
    return { rule: "mkfs", reason: "Formatieren eines Dateisystems." };
  }
  if (
    names.has("diskutil") &&
    tokens.some((token) =>
      ["erase", "erasedisk", "erasevolume", "partition", "partitiondisk", "reformat", "zerodisk"].includes(
        token.toLowerCase(),
      ),
    )
  ) {
    return { rule: "diskutil", reason: "diskutil löscht oder partitioniert einen Datenträger." };
  }
  if (names.has("shutdown") || names.has("reboot") || names.has("halt") || names.has("poweroff")) {
    return { rule: "power", reason: "Herunterfahren oder Neustart des Rechners." };
  }
  if (names.has("mv") && hasRootTarget && operands.includes("/dev/null")) {
    return { rule: "mv-devnull", reason: "Verschieben eines Systemverzeichnisses nach /dev/null." };
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
  /** Extra variables merged on top of the sanitized environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * Fired for every chunk actually kept in `stdout`/`stderr` (K3 live shell).
   * Called after `appendBounded`, with the text that was really adopted —
   * never more than what made it into the bounded buffer.
   */
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    if (options.signal?.aborted) {
      resolvePromise({
        code: 130,
        stdout,
        stderr: "Abgebrochen, bevor der Prozess gestartet wurde.",
        truncated,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...sanitizedEnvironment(), ...options.env },
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
          ? `Zeitlimit von ${options.timeoutMs / 1_000}s erreicht, Prozessgruppe beendet.`
          : "Abgebrochen, Prozessgruppe beendet.";
      // Resolve now: waiting for "close" would wait for the very children the
      // timeout is supposed to get rid of.
      finish({
        code: reason === "timeout" ? 124 : 130,
        stdout,
        stderr: `${stderr}\n${note}`.trim(),
        truncated,
        timedOut: reason === "timeout",
        aborted: reason === "abort",
      });
    };
    const onAbort = () => stop("abort");
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk, MAX_TOOL_OUTPUT * 3);
      stdout = next.value;
      truncated ||= next.truncated;
      if (next.adopted.length > 0) {
        options.onChunk?.("stdout", next.adopted);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk, MAX_TOOL_OUTPUT * 3);
      stderr = next.value;
      truncated ||= next.truncated;
      if (next.adopted.length > 0) {
        options.onChunk?.("stderr", next.adopted);
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(error);
    });
    child.on("close", (code) => {
      finish({
        code: code ?? 1,
        stdout,
        stderr,
        truncated,
        timedOut: false,
        aborted: false,
      });
    });
  });
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

let ripgrepMissing = false;

/** Returns null when ripgrep is unavailable, so the caller can fall back. */
async function ripgrepSearch(
  options: WorkspaceSearchOptions,
  signal?: AbortSignal,
): Promise<WorkspaceSearchResult | null> {
  if (ripgrepMissing) {
    return null;
  }
  const limit = options.limit ?? 300;
  const args = ["-n", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**"];
  if (!options.regex) {
    args.push("--fixed-strings");
  }
  if (!options.caseSensitive) {
    args.push("--ignore-case");
  }
  if (options.contextLines) {
    args.push("--context", String(options.contextLines));
  }
  if (options.glob) {
    args.push("--glob", options.glob);
  }
  args.push("--max-count", String(limit), "--", options.query, options.directory);
  let result: ProcessResult;
  try {
    result = await runProcess("rg", args, {
      cwd: options.root,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
      ripgrepMissing = true;
      return null;
    }
    throw error;
  }
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr || `rg endete mit Code ${result.code}`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const relativeLines = lines.map((line) =>
    line.startsWith(options.root) ? line.slice(options.root.length + 1) : line,
  );
  return {
    matches: relativeLines.join("\n"),
    matchCount: relativeLines.filter((line) => /:\d+:/.test(line)).length,
    filesWithMatches: new Set(relativeLines.map((line) => line.split(":")[0])).size,
    truncated: result.truncated,
  };
}

/**
 * Built-in searcher. This is the normal path: ripgrep is optional and often
 * missing, and a search tool that dies with `spawn rg ENOENT` is no tool.
 */
export async function searchWorkspaceText(
  options: WorkspaceSearchOptions,
): Promise<WorkspaceSearchResult> {
  const limit = options.limit ?? 300;
  const contextLines = options.contextLines ?? 0;
  const pattern = options.glob ?? "**/*";
  assertSafeGlobPattern(pattern, "Glob-Muster");
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
        `Ungültiger regulärer Ausdruck: ${error instanceof Error ? error.message : String(error)}`,
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
