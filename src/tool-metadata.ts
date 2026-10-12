/**
 * How a tool call is DISPLAYED — the presentation half of the tool layer,
 * with no imports beyond the project's two import-free helpers.
 *
 * This used to live in `workspace.ts`, which reaches into node, `fast-glob`
 * and the agent SDK — so the desktop window could not import it and printed
 * the raw tool name and a three-key argument dump instead of the badge, the
 * title and the one-line summaries the terminal shows. That was the largest
 * single-source gap G2 named, and it is closed here: `toolMetadata` decides
 * what a person is told a tool DID, which is not formatting, and one
 * definition now serves both surfaces (`gui/vite.config.ts`'s `@core` seam
 * admits a module whose only runtime dependency is `utils.ts`, which imports
 * nothing at all).
 *
 * Nothing about the data moved. `workspace.ts` re-exports every name here,
 * so every existing importer is untouched.
 */

import type { ToolRisk } from "./types.js";
import { ellipsize, lookupTable } from "./utils.js";

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

// FIX-14 ticket 7: the cut itself is `ellipsize` (utils.ts); only the
// whitespace collapse — a statement about the content, not the budget —
// stays here.
export function oneLine(value: string, maximum: number): string {
  return ellipsize(value.replace(/\s+/g, " ").trim(), maximum);
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
      return data ? summarizeOutput(data) : "Result received";
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
  if (errors.length > 0) lines.push("", "JS errors:", ...errors);
  if (failed.length > 0) lines.push("", "Failed requests:", ...failed);
  if (console_.length > 0) lines.push("", "Console:", ...console_);
  if (errors.length === 0 && failed.length === 0) {
    lines.push("", "No JS errors, no failed requests.");
  }
  return lines.join("\n");
}

/**
 * FIX-14 ticket 17: built with `lookupTable`, not a bare `Object.freeze` of
 * an object literal. Every key here is a TOOL NAME, and a tool name reaches
 * `toolMetadata` below straight from the model's own tool call — the exact
 * "keyed by text that arrives from outside" shape `lookupTable` exists for.
 * A frozen literal still inherits `Object.prototype`, so a model emitting a
 * call named `constructor` or `toString` handed `toolMetadata` a FUNCTION
 * where a `ToolMetadata` was expected, straight past the `if (known)` guard,
 * instead of falling through to the honest unknown-tool entry.
 * `lookupTable`'s null prototype closes that, and its `V | undefined` return
 * type is what makes the guard type-honest rather than decorative.
 */
export const TOOL_METADATA: Readonly<Record<string, ToolMetadata | undefined>> = lookupTable<ToolMetadata>({
  read_file: metadataEntry(
    "read_file",
    "READ",
    "Read file",
    "read",
    (input) => {
      const range =
        input.lineStart !== undefined || input.lineEnd !== undefined
          ? ` · lines ${text(input.lineStart) || "1"}–${text(input.lineEnd) || "…"}`
          : "";
      return `${text(input.path) || "File"}${range}`;
    },
    (output) =>
      `${count(output.totalLines) ?? "?"} lines${output.truncated ? " · excerpt" : ""}`,
    (output, opts) => bodyFromText(text(output.content), null, opts),
    (output) => text(output.content),
  ),
  list_files: metadataEntry(
    "list_files",
    "LIST",
    "List files",
    "read",
    (input) => `${text(input.path) || "."} · ${text(input.pattern) || "**/*"}`,
    (output) =>
      `${Array.isArray(output.files) ? output.files.length : 0} file(s)${
        output.truncated ? " · list truncated" : ""
      }`,
    (output, opts) =>
      bodyFromText(Array.isArray(output.files) ? output.files.join("\n") : "", null, opts),
    (output) => (Array.isArray(output.files) ? output.files.join("\n") : ""),
  ),
  search_files: metadataEntry(
    "search_files",
    "SEARCH",
    "Search text",
    "read",
    (input) => `"${oneLine(text(input.query), 160)}" in ${text(input.path) || "."}`,
    (output) =>
      `${count(output.matchCount) ?? nonEmptyLines(text(output.matches))} match line(s)${
        output.truncated ? " · output truncated" : ""
      }`,
    (output, opts) => bodyFromText(text(output.matches), null, opts),
    (output) => text(output.matches),
  ),
  write_file: metadataEntry(
    "write_file",
    "WRITE",
    "Write file",
    "edit",
    (input) => text(input.path) || "File",
    (output) => `${count(output.bytes) ?? "?"} bytes written`,
    (output) => [`${text(output.path) || "File"}: ${count(output.bytes) ?? "?"} bytes written`],
    (output) => `${text(output.path) || "File"}: ${count(output.bytes) ?? "?"} bytes written`,
  ),
  replace_text: metadataEntry(
    "replace_text",
    "EDIT",
    "Replace text",
    "edit",
    (input) => text(input.path) || "File",
    (output) => `${count(output.replacements) ?? "?"} replacement(s)`,
    (output) => [
      `${text(output.path) || "File"}: ${count(output.replacements) ?? "?"} replacement(s)`,
    ],
    (output) =>
      `${text(output.path) || "File"}: ${count(output.replacements) ?? "?"} replacement(s)`,
  ),
  run_command: metadataEntry(
    "run_command",
    "SHELL",
    "Shell command",
    "shell",
    (input) => oneLine(text(input.command) || "Shell command", 300),
    (output) => {
      const last = text(output.stdout) || text(output.stderr);
      const lastLine = last
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .at(-1);
      return [
        `Exit ${count(output.exitCode) ?? "?"}`,
        lastLine ? oneLine(lastLine, 240) : "",
        output.truncated ? "output truncated" : "",
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
    "Page check",
    "network-fetch",
    (input) => String(input.url ?? ""),
    (output) => {
      const errors = Array.isArray(output.pageErrors) ? output.pageErrors.length : 0;
      const failed = Array.isArray(output.failedRequests) ? output.failedRequests.length : 0;
      const parts = [`${output.loadTimeMs ?? 0}ms`];
      if (errors > 0) parts.push(`${errors} JS error(s)`);
      if (failed > 0) parts.push(`${failed} failed request(s)`);
      if (errors === 0 && failed === 0) parts.push("no errors");
      return parts.join(" · ");
    },
    (output, opts) => bodyFromText(browserReportText(output), null, opts),
    (output) => browserReportText(output),
  ),
  git_diff: metadataEntry(
    "git_diff",
    "GIT DIFF",
    "Git diff",
    "shell",
    (input) => (input.staged ? "staged changes" : "working tree"),
    (output) => {
      const exitCode = count(output.exitCode);
      if (exitCode !== null && exitCode !== 0) {
        return `Git failed (exit ${exitCode})`;
      }
      return `${nonEmptyLines(text(output.diff))} diff line(s)${
        output.truncated ? " · output truncated" : ""
      }`;
    },
    (output, opts) =>
      bodyFromText(
        [text(output.diff), text(output.stderr)].filter(Boolean).join("\n"),
        count(output.exitCode),
        opts,
      ),
    (output) => [text(output.diff), text(output.stderr)].filter(Boolean).join("\n"),
  ),
  ssh_command: metadataEntry(
    "ssh_command",
    "SSH",
    "SSH command",
    "remote-shell",
    // Phase 3b, Part D.2: `● SSH <host>(<command>)` — the toolHead glyph
    // (rendered by render-block.ts's generic tool-line head, unchanged)
    // plus this exact "SSH host(command)" text as the line's label.
    (input) =>
      `SSH ${text(input.host) || "Host"}(${oneLine(text(input.command) || "Command", 260)})`,
    (output) => {
      const last = text(output.stdout) || text(output.stderr);
      const lastLine = last
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .at(-1);
      return [
        `${text(output.host) || "Host"} · Exit ${count(output.exitCode) ?? "?"}`,
        lastLine ? oneLine(lastLine, 240) : "",
        output.truncated ? "output truncated" : "",
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
    () => "Result received",
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
