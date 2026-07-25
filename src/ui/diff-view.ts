/**
 * One rendering for every diff (Bauplan K5).
 *
 * There is no second differ: `diffText` / `formatUnifiedDiff` in
 * `workspace.ts` remain the only diff source. This module turns their output
 * — or a unified-diff text from `git diff` — into lines.
 */

import type { DiffLine, TextDiff } from "../workspace.js";
import { fitSpans } from "./compose.js";
import { span, type Line } from "./spans.js";
import type { Theme } from "./theme.js";

export interface DiffHunkView {
  lines: DiffLine[];
}

export interface DiffViewOptions {
  maxHunks?: number;
  contextLines?: number;
}

const DEFAULTS = { maxHunks: 3, contextLines: 2 } as const;

function positionOf(line: DiffLine): { old: number | null; fresh: number | null } {
  return { old: line.oldLine, fresh: line.newLine };
}

/** Groups diff lines into hunks and trims context to `contextLines`. */
export function splitHunks(
  lines: readonly DiffLine[],
  contextLines: number = DEFAULTS.contextLines,
): DiffHunkView[] {
  const hunks: DiffHunkView[] = [];
  let current: DiffLine[] = [];
  let previous: DiffLine | null = null;

  for (const item of lines) {
    if (previous) {
      const before = positionOf(previous);
      const now = positionOf(item);
      const oldGap =
        before.old !== null && now.old !== null && now.old > before.old + 1;
      const newGap =
        before.fresh !== null && now.fresh !== null && now.fresh > before.fresh + 1;
      if (oldGap || newGap) {
        hunks.push({ lines: current });
        current = [];
      }
    }
    current.push(item);
    previous = item;
  }
  if (current.length > 0) hunks.push({ lines: current });

  return hunks
    .map((hunk) => ({ lines: trimContext(hunk.lines, contextLines) }))
    .filter((hunk) => hunk.lines.length > 0);
}

function trimContext(lines: readonly DiffLine[], contextLines: number): DiffLine[] {
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.type === "ctx") continue;
    for (let offset = -contextLines; offset <= contextLines; offset += 1) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < lines.length) keep.add(candidate);
    }
  }
  if (keep.size === 0) return [];
  return [...keep].sort((a, b) => a - b).map((index) => lines[index]!);
}

function numberOf(line: DiffLine): number | null {
  if (line.type === "del") return line.oldLine;
  if (line.type === "add") return line.newLine;
  return line.newLine ?? line.oldLine;
}

/** Renders hunks with the `│` gutter. Code lines are cut hard, never wrapped. */
export function renderHunks(
  hunks: readonly DiffHunkView[],
  width: number,
  theme: Theme,
  options: DiffViewOptions = {},
): Line[] {
  const maxHunks = options.maxHunks ?? DEFAULTS.maxHunks;
  const edge = theme.glyph("blockEdge");
  const ellipsis = theme.glyph("ellipsis");
  const shown = hunks.slice(0, Math.max(0, maxHunks));

  let numberWidth = 1;
  for (const hunk of shown) {
    for (const item of hunk.lines) {
      const value = numberOf(item);
      if (value !== null) numberWidth = Math.max(numberWidth, String(value).length);
    }
  }

  const out: Line[] = [];
  shown.forEach((hunk) => {
    for (const item of hunk.lines) {
      const role = item.type === "add" ? "add" : item.type === "del" ? "del" : "muted";
      const sign =
        item.type === "add"
          ? theme.glyph("diffAdd")
          : item.type === "del"
            ? theme.glyph("diffDel")
            : " ";
      const value = numberOf(item);
      const label = (value === null ? "" : String(value)).padStart(numberWidth);
      const spans = [
        span(`${edge} `, "structure"),
        span(`${label} `, "muted"),
        span(`${sign} `, role),
        span(item.text.replace(/\t/g, "  "), role),
      ];
      out.push({ spans: fitSpans(spans, width, ellipsis) });
    }
  });
  return out;
}

export function renderDiff(
  diff: TextDiff,
  width: number,
  theme: Theme,
  options: DiffViewOptions = {},
): Line[] {
  return renderHunks(splitHunks(diff.lines, options.contextLines), width, theme, options);
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Small unified-diff parser for `git diff` and `/diff`, so that external
 * unified text goes through the very same renderer.
 */
export function parseUnifiedDiff(text: string): TextDiff {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("\\ ")
    ) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      lines.push({ type: "ctx", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (raw.length === 0) continue;
    // Anything else (for example the "… n weitere Zeilen" footer) ends the hunk.
    inHunk = false;
  }

  const added = lines.filter((item) => item.type === "add").length;
  const removed = lines.filter((item) => item.type === "del").length;
  return {
    lines,
    added,
    removed,
    shownChanges: added + removed,
    omittedChanges: 0,
    truncated: false,
    text,
  };
}
