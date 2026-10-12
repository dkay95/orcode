/**
 * One rendering for every diff (Bauplan K5).
 *
 * There is no second differ: `diffText` / `formatUnifiedDiff` in
 * `workspace.ts` remain the only diff source. This module turns their output
 * — or a unified-diff text from `git diff` — into lines.
 */

import {
  diffLineNumber,
  splitHunks,
  type DiffLine,
  type DiffHunkView,
  type TextDiff,
} from "../diff-parse.js";
import { fitSpans } from "./compose.js";
import { span, type Line } from "./spans.js";
import type { Theme } from "./theme.js";

/**
 * G3: the parser and the hunk splitter moved to `../diff-parse.js` — an
 * import-free module, which is the only kind the desktop window's `@core`
 * seam admits. Re-exported unchanged so every caller of this file keeps
 * working and there is still exactly one reader.
 */
export { parseUnifiedDiff, splitHunks, type DiffHunkView } from "../diff-parse.js";

export interface DiffViewOptions {
  maxHunks?: number;
  contextLines?: number;
}

const DEFAULTS = { maxHunks: 3, contextLines: 2 } as const;

const numberOf = diffLineNumber;

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
