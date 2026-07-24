import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { ApprovalManager } from "./approval.js";

const MAX_FILE_BYTES = 1_500_000;
const MAX_TOOL_OUTPUT = 80_000;

interface ChangeEntry {
  path: string;
  before: string | null;
  after: string;
  createdAt: string;
}

export class ChangeJournal {
  #entries: ChangeEntry[] = [];

  record(entry: ChangeEntry): void {
    this.#entries.push(entry);
  }

  get size(): number {
    return this.#entries.length;
  }

  async undoLast(guard: WorkspaceGuard, approvals: ApprovalManager): Promise<string> {
    const entry = this.#entries.at(-1);
    if (!entry) {
      return "Keine RouterCode-Änderung zum Rückgängigmachen vorhanden.";
    }
    await approvals.authorize({
      name: "undo",
      risk: "edit",
      summary: `Letzte Änderung an ${guard.display(entry.path)} rückgängig machen`,
      details: entry.before === null ? "Die neu angelegte Datei wird gelöscht." : "Der vorherige Dateiinhalt wird wiederhergestellt.",
    });
    if (entry.before === null) {
      await unlink(entry.path);
    } else {
      await atomicWrite(entry.path, entry.before);
    }
    this.#entries.pop();
    return `Rückgängig gemacht: ${guard.display(entry.path)}`;
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

export function createCodingTools(
  guard: WorkspaceGuard,
  approvals: ApprovalManager,
  journal: ChangeJournal,
) {
  const readFileTool = tool({
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. Use lineStart and lineEnd for focused reads.",
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
    }),
    execute: async ({ path, lineStart, lineEnd }) => {
      const target = await guard.resolvePath(path);
      const info = await stat(target);
      if (!info.isFile()) {
        throw new Error(`Keine Datei: ${path}`);
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`Datei ist zu groß (${info.size} Bytes). Lies einen kleineren Ausschnitt.`);
      }
      const content = await readFile(target, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, lineStart ?? 1);
      const end = Math.min(lines.length, lineEnd ?? Math.min(lines.length, start + 399));
      const selected = lines.slice(start - 1, end).join("\n");
      return {
        path: guard.display(target),
        content: truncate(selected, MAX_TOOL_OUTPUT),
        totalLines: lines.length,
        truncated: end < lines.length || selected.length > MAX_TOOL_OUTPUT,
      };
    },
  });

  const listFilesTool = tool({
    name: "list_files",
    description: "List files within the workspace using an optional glob pattern.",
    inputSchema: z.object({
      path: z.string().default("."),
      pattern: z.string().default("**/*"),
      limit: z.number().int().min(1).max(2_000).default(300),
    }),
    outputSchema: z.object({
      files: z.array(z.string()),
      truncated: z.boolean(),
    }),
    execute: async ({ path, pattern, limit }) => {
      const base = await guard.resolvePath(path);
      const files = await fg(pattern, {
        cwd: base,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**"],
      });
      files.sort();
      return {
        files: files.slice(0, limit).map((file) => guard.display(resolve(base, file))),
        truncated: files.length > limit,
      };
    },
  });

  const searchFilesTool = tool({
    name: "search_files",
    description: "Search text with ripgrep inside the workspace.",
    inputSchema: z.object({
      query: z.string().min(1),
      path: z.string().default("."),
      glob: z.string().optional(),
      limit: z.number().int().min(1).max(2_000).default(300),
    }),
    outputSchema: z.object({
      matches: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ query, path, glob, limit }) => {
      const target = await guard.resolvePath(path);
      const args = ["-n", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**"];
      if (glob) {
        args.push("--glob", glob);
      }
      args.push("--max-count", String(limit), "--", query, target);
      const result = await runProcess("rg", args, guard.root, 30_000);
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(result.stderr || `rg endete mit Code ${result.code}`);
      }
      const matches = truncate(result.stdout, MAX_TOOL_OUTPUT);
      return {
        matches,
        truncated: result.truncated || result.stdout.length > MAX_TOOL_OUTPUT,
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
      const before = await readOptional(target);
      await approvals.authorize({
        name: "write_file",
        risk: "edit",
        summary: `${before === null ? "Datei anlegen" : "Datei überschreiben"}: ${guard.display(target)}`,
        details: changePreview(before, content),
      });
      await mkdir(dirname(target), { recursive: true });
      await atomicWrite(target, content);
      journal.record({ path: target, before, after: content, createdAt: new Date().toISOString() });
      return { ok: true, path: guard.display(target), bytes: Buffer.byteLength(content) };
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
      const target = await guard.resolvePath(path);
      const before = await readFile(target, "utf8");
      const occurrences = countOccurrences(before, oldText);
      if (occurrences === 0) {
        throw new Error(`Der alte Text wurde in ${path} nicht gefunden.`);
      }
      if (!replaceAll && occurrences !== 1) {
        throw new Error(
          `Der alte Text kommt ${occurrences}-mal vor. Nutze einen eindeutigeren Block oder replaceAll=true.`,
        );
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      await approvals.authorize({
        name: "replace_text",
        risk: "edit",
        summary: `${replaceAll ? occurrences : 1} Ersetzung(en) in ${guard.display(target)}`,
        details: `- ${truncate(oldText, 1_500)}\n+ ${truncate(newText, 1_500)}`,
      });
      await atomicWrite(target, after);
      journal.record({ path: target, before, after, createdAt: new Date().toISOString() });
      return {
        ok: true,
        path: guard.display(target),
        replacements: replaceAll ? occurrences : 1,
      };
    },
  });

  const runCommandTool = tool({
    name: "run_command",
    description:
      "Run a shell command in the workspace. Use for builds, tests, git status, and targeted diagnostics.",
    inputSchema: z.object({
      command: z.string().min(1).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    outputSchema: z.object({
      command: z.string(),
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ command, timeoutSeconds }) => {
      if (isCatastrophic(command)) {
        throw new Error("Der Befehl wurde durch die unveränderliche Katastrophenschutz-Regel blockiert.");
      }
      await approvals.authorize({
        name: "run_command",
        risk: "shell",
        summary: `Shell-Befehl in ${guard.root}`,
        details: command,
      });
      const result = await runProcess("/bin/zsh", ["-lc", command], guard.root, timeoutSeconds * 1_000);
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
      const args = ["diff"];
      if (staged) {
        args.push("--cached");
      }
      args.push("--");
      const result = await runProcess("git", args, guard.root, 20_000);
      if (result.code !== 0) {
        throw new Error(result.stderr || "git diff ist fehlgeschlagen.");
      }
      return {
        diff: truncate(result.stdout, MAX_TOOL_OUTPUT),
        truncated: result.truncated || result.stdout.length > MAX_TOOL_OUTPUT,
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
  ] as const;
}

export async function getGitDiff(root: string): Promise<string> {
  const result = await runProcess("git", ["diff", "--"], root, 20_000);
  if (result.code !== 0) {
    return result.stderr || "Kein Git-Repository oder git diff ist fehlgeschlagen.";
  }
  return result.stdout || "Keine uncommitteten Änderungen.";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  let mode = 0o644;
  try {
    mode = (await lstat(path)).mode & 0o777;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  const temporary = resolve(parent, `.${basename(path)}.${process.pid}.routercode.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, path);
  await chmod(path, mode);
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

function changePreview(before: string | null, after: string): string {
  if (before === null) {
    return `Neue Datei, ${Buffer.byteLength(after)} Bytes\n${truncate(after, 3_000)}`;
  }
  const beforeLines = before.split(/\r?\n/).length;
  const afterLines = after.split(/\r?\n/).length;
  return `${beforeLines} → ${afterLines} Zeilen, ${Buffer.byteLength(before)} → ${Buffer.byteLength(after)} Bytes`;
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

function isCatastrophic(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|\$home)(\s|$)/,
    /\bdiskutil\s+(erase|partition)/,
    /\bmkfs(\.|\s)/,
    /\bdd\s+.*\bof=\/dev\//,
    /\bshutdown\b/,
    /\breboot\b/,
  ].some((pattern) => pattern.test(normalized));
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk, MAX_TOOL_OUTPUT * 3);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk, MAX_TOOL_OUTPUT * 3);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\nZeitlimit von ${timeoutMs / 1_000}s erreicht.`.trim() : stderr,
        truncated,
      });
    });
  });
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… gekürzt …`;
}

function appendBounded(
  current: string,
  chunk: string,
  maximum: number,
): { value: string; truncated: boolean } {
  if (current.length >= maximum) {
    return { value: current, truncated: true };
  }
  const available = maximum - current.length;
  if (chunk.length <= available) {
    return { value: current + chunk, truncated: false };
  }
  return {
    value: current + chunk.slice(0, available),
    truncated: true,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isWithinWorkspace(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    return false;
  }
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (/(key|token|secret|password|credential|authorization|cookie)/i.test(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}
