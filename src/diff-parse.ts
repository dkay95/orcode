/**
 * The one diff READER, with no imports at all.
 *
 * There is no second differ and now no second parser either: `diffText` /
 * `formatUnifiedDiff` (`workspace.ts`) remain the only diff SOURCE, and this
 * module turns their output — or a unified diff from `git diff`, or the
 * approval preview's own `changePreview` text — into lines and hunks.
 *
 * It lives beside `utils.ts` rather than inside `ui/` for one reason: the
 * desktop window has to render the identical hunks the terminal renders, and
 * `ui/diff-view.ts` reaches into `compose`/`spans`/`theme` (terminal
 * machinery) while `workspace.ts` reaches into node. Import-free is what
 * makes one definition reachable from BOTH surfaces (`gui/vite.config.ts`'s
 * `@core` seam admits import-free modules only). `ui/diff-view.ts` re-exports
 * everything here, so every existing caller is unchanged.
 *
 * FIX-3's rule, restated: `parseUnifiedDiff` is the reader `/diff`, the
 * applied-edit block and the approval preview all use. A surface that parses
 * `+`/`-` prefixes itself is a second parser, and a second parser is a second
 * truth about what changed.
 */

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

export interface DiffHunkView {
  lines: DiffLine[];
}

/**
 * How many hunks a diff ever puts on screen — the approval preview's own
 * long-standing cap, shared with the applied-edit block (FIX-3) so both
 * halves of the same change are cut at exactly the same place, and now with
 * the window so the two surfaces cut there too.
 */
export const MAX_DIFF_HUNKS = 3;

const DEFAULT_CONTEXT_LINES = 2;

function positionOf(line: DiffLine): { old: number | null; fresh: number | null } {
  return { old: line.oldLine, fresh: line.newLine };
}

/** Groups diff lines into hunks and trims context to `contextLines`. */
export function splitHunks(
  lines: readonly DiffLine[],
  contextLines: number = DEFAULT_CONTEXT_LINES,
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

/** The line number a rendered row carries: the side that actually has one. */
export function diffLineNumber(line: DiffLine): number | null {
  if (line.type === "del") return line.oldLine;
  if (line.type === "add") return line.newLine;
  return line.newLine ?? line.oldLine;
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** True when `text` carries at least one unified-diff hunk header. */
export function looksLikeUnifiedDiff(text: string): boolean {
  return text.split("\n").some((line) => HUNK_HEADER.test(line));
}

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
