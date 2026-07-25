import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_HOME, writeFileAtomicSecure } from "./config.js";
import { errorMessage, hasCode } from "./utils.js";

/** Below this many bytes, output passes through unchanged (Bauplan A1). */
export const DISTILL_PASSTHROUGH_BYTES = 2 * 1024;
/** Above this many bytes, the compressor model is consulted (Bauplan A1). */
export const DISTILL_MODEL_BYTES = 20 * 1024;

/** Lines a coding agent needs to act on a failed run. */
const ERROR_LINE_PATTERN =
  /(^|\s)(error|ERROR|FAIL|panic|Traceback|error TS\d+|warning TS\d+)/;

const NPM_NOISE_PATTERN = /^npm (WARN|notice)\b/;

/**
 * ANSI CSI (colors, cursor moves) and OSC (window titles) escape sequences.
 * Built from character codes instead of a literal escape byte in the source,
 * so the pattern cannot be mangled by anything that treats a raw ESC/BEL
 * byte in a source file specially.
 */
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  ESCAPE_CHAR +
    "\\[[0-9;?]*[a-zA-Z]|" +
    ESCAPE_CHAR +
    "\\][^" +
    BELL_CHAR +
    "]*" +
    BELL_CHAR,
  "g",
);

const RUN_COMMAND_TAIL_LINES = 60;
const SEARCH_FILES_HITS_PER_FILE = 5;

export interface DistillToolInput {
  /** Tool name, e.g. `"run_command"`, `"search_files"`, `"read_file"`. */
  tool: string;
  /** Raw tool output as it would go to the model unmodified. */
  output: string;
  /** Present for process-shaped tools (`run_command`). */
  exitCode?: number;
}

export interface DistillResult {
  /** What actually goes to the model. */
  text: string;
  originalBytes: number;
  distilledBytes: number;
  /** False when `text` is byte-identical to the raw output. */
  distilled: boolean;
  /** True only when the >20 KB compressor-model stage actually ran (cache miss). */
  modelCalled: boolean;
  /** 0 unless the compressor model stage ran and was not served from cache. */
  costUsd: number;
}

/** Injectable so tests can spy on/replace the compressor-model call. */
export type DistillModelCall = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<{ text: string; costUsd: number }>;

export interface DistillOptions {
  /** Overrides `~/.orcode` for tests; never write to the real app home from a test. */
  appHome?: string;
  /** Required to reach the >20 KB stage; without it that stage falls back to the deterministic one. */
  callModel?: DistillModelCall;
  signal?: AbortSignal;
}

const COMPRESSOR_INSTRUCTION =
  "Extrahiere aus der folgenden Tool-Ausgabe ausschließlich, was ein Coding-Agent zum Handeln braucht: " +
  "fehlgeschlagene Testnamen, Datei:Zeile-Referenzen, Fehlertext, Exit-Code. Erfinde nichts. " +
  "Antworte als kompakten Klartext ohne Einleitung.";

/**
 * Distill a raw tool output down to what the main model actually needs, per
 * the three size tiers of Bauplan A1. `read_file` is always passed through
 * unchanged, at any size — that tool's whole purpose is exact file content.
 */
export async function distillToolOutput(
  input: DistillToolInput,
  options: DistillOptions = {},
): Promise<DistillResult> {
  const originalBytes = Buffer.byteLength(input.output, "utf8");

  if (input.tool === "read_file") {
    return passthrough(input.output, originalBytes);
  }

  if (originalBytes < DISTILL_PASSTHROUGH_BYTES) {
    return passthrough(input.output, originalBytes);
  }

  const deterministic = distillDeterministic(input);

  // Hard rule: a failed run never goes through the model. That is exactly
  // where the information that must not be smoothed away lives.
  const failed = input.exitCode !== undefined && input.exitCode !== 0;
  if (failed || originalBytes <= DISTILL_MODEL_BYTES) {
    return finish(deterministic, originalBytes, input.output);
  }

  return distillWithModel(input, deterministic, originalBytes, options);
}

function passthrough(text: string, originalBytes: number): DistillResult {
  return {
    text,
    originalBytes,
    distilledBytes: originalBytes,
    distilled: false,
    modelCalled: false,
    costUsd: 0,
  };
}

function finish(
  text: string,
  originalBytes: number,
  rawOutput: string,
): DistillResult {
  const distilledBytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    originalBytes,
    distilledBytes,
    distilled: text !== rawOutput,
    modelCalled: false,
    costUsd: 0,
  };
}

/** The 2 KB – 20 KB (and >20 KB-but-failed) stage: fully deterministic, no model call. */
export function distillDeterministic(input: DistillToolInput): string {
  const sanitized = sanitizeLines(input.output);

  if (input.tool === "run_command" && input.exitCode !== undefined) {
    return distillRunCommand(sanitized, input.exitCode);
  }
  if (input.tool === "search_files") {
    return distillSearchFiles(sanitized);
  }
  return sanitized.join("\n");
}

/** Strips ANSI, resolves `\r` progress lines, drops npm noise, folds duplicates. */
function sanitizeLines(raw: string): string[] {
  const withoutAnsi = raw.replace(ANSI_PATTERN, "");
  const lines = withoutAnsi.split("\n").map((line) => {
    // A `\r`-driven progress bar overwrites itself in place; only the last
    // segment before the final `\r` was ever actually visible.
    const parts = line.split("\r");
    return parts[parts.length - 1] ?? "";
  });
  const withoutNpmNoise = lines.filter((line) => !NPM_NOISE_PATTERN.test(line));
  return foldDuplicateLines(withoutNpmNoise);
}

/** Collapses runs of consecutive identical lines into `<line> (N×)`. */
function foldDuplicateLines(lines: string[]): string[] {
  const folded: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    let count = 1;
    while (index + count < lines.length && lines[index + count] === current) {
      count += 1;
    }
    folded.push(count > 1 ? `${current} (${count}×)` : current);
    index += count;
  }
  return folded;
}

function distillRunCommand(lines: string[], exitCode: number): string {
  const errorLines = lines.filter((line) => ERROR_LINE_PATTERN.test(line));
  const tail = lines.slice(-RUN_COMMAND_TAIL_LINES);
  const body = dedupeKeepFirst([...errorLines, ...tail]);
  return [`exit ${exitCode}`, ...body].join("\n");
}

function dedupeKeepFirst(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }
  return result;
}

/** Groups `path:line:...`-shaped hits by file, keeping the first N per file. */
function distillSearchFiles(lines: string[]): string {
  const byFile = new Map<string, string[]>();
  const order: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const file = line.split(":", 1)[0] ?? line;
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    byFile.get(file)!.push(line);
  }
  const sections: string[] = [];
  for (const file of order) {
    const hits = byFile.get(file)!;
    const shown = hits.slice(0, SEARCH_FILES_HITS_PER_FILE);
    sections.push(shown.join("\n"));
    const hidden = hits.length - shown.length;
    if (hidden > 0) {
      sections.push(`… ${hidden} weitere Treffer in ${file}`);
    }
  }
  return sections.join("\n");
}

async function distillWithModel(
  input: DistillToolInput,
  deterministicFallback: string,
  originalBytes: number,
  options: DistillOptions,
): Promise<DistillResult> {
  const { callModel, appHome = APP_HOME, signal } = options;
  if (!callModel) {
    // No model wired up: behave like the deterministic tier rather than fail.
    return finish(deterministicFallback, originalBytes, input.output);
  }

  const hash = createHash("sha256").update(input.output, "utf8").digest("hex");
  const cachePath = join(appHome, "distill", `${hash}.json`);

  const cached = await readCache(cachePath);
  if (cached) {
    return {
      text: cached.text,
      originalBytes,
      distilledBytes: Buffer.byteLength(cached.text, "utf8"),
      distilled: cached.text !== input.output,
      modelCalled: false,
      costUsd: 0,
    };
  }

  const prompt = `${COMPRESSOR_INSTRUCTION}\n\n${input.output}`;
  const response = await callModel(prompt, signal);
  const text = response.text.trim() || deterministicFallback;

  await writeCache(cachePath, { text });

  return {
    text,
    originalBytes,
    distilledBytes: Buffer.byteLength(text, "utf8"),
    distilled: text !== input.output,
    modelCalled: true,
    costUsd: response.costUsd,
  };
}

interface DistillCacheEntry {
  text: string;
}

async function readCache(path: string): Promise<DistillCacheEntry | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { text?: unknown }).text === "string"
    ) {
      return { text: (parsed as { text: string }).text };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(path: string, entry: DistillCacheEntry): Promise<void> {
  try {
    await writeFileAtomicSecure(path, JSON.stringify(entry));
  } catch (error) {
    // A cache write failure must never fail the distillation itself.
    void errorMessage(error);
  }
}
