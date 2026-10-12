/**
 * Diffs, drawn from the engine's own reader.
 *
 * This window used to split a diff on `\n` and colour a line by whether it
 * started with `+` or `-`. That is a SECOND parser, and FIX-3's whole point
 * is that there is one: `parseUnifiedDiff` + `splitHunks` (`src/diff-parse.ts`,
 * import-free precisely so both surfaces can reach it) are what `/diff`, the
 * applied-edit block and the approval preview all read with. The terminal
 * renders those hunks with a `│` gutter and a line number
 * (`src/ui/diff-view.ts::renderHunks`); this renders the same hunks with the
 * same gutter, the same numbers, the same three-hunk cap — in HTML.
 *
 * Nothing here decides what changed. It only draws what the reader returned.
 */

import {
  MAX_DIFF_HUNKS,
  diffLineNumber,
  looksLikeUnifiedDiff,
  parseUnifiedDiff,
  splitHunks,
  type DiffHunkView,
} from "@core/diff-parse";

import { el } from "./dom.js";

export { looksLikeUnifiedDiff, MAX_DIFF_HUNKS };

export interface DiffView {
  readonly hunks: readonly DiffHunkView[];
  /** Hunks the cap left out — said out loud, never silently dropped. */
  readonly hiddenHunks: number;
  /** Lines the differ's own budget left out, as the event reported it. */
  readonly truncated: boolean;
  /** The whole file's counts, which the parser cannot know on its own. */
  readonly added: number;
  readonly removed: number;
}

/**
 * A unified diff, reduced exactly the way `RunViewModel.pushDiff` reduces it:
 * the hunks come from the shared reader, the `+N/-M` counts come from the
 * EVENT (the parser can only count what survived the differ's changed-line
 * budget, while the event carries the file's real totals), and the cap is
 * stated rather than applied silently.
 */
export function readDiff(
  text: string,
  counts: { added: number; removed: number; truncated: boolean },
  maxHunks: number = MAX_DIFF_HUNKS,
): DiffView {
  const parsed = parseUnifiedDiff(text);
  const hunks = splitHunks(parsed.lines);
  return {
    hunks: hunks.slice(0, maxHunks),
    hiddenHunks: Math.max(0, hunks.length - maxHunks),
    truncated: counts.truncated,
    added: counts.added,
    removed: counts.removed,
  };
}

/**
 * The same diff a tool approval is about, read out of the preview's own
 * details text.
 *
 * `changePreview` (`workspace.ts`) builds that text — a size header, then
 * `diffText(...).text`, a real unified diff — and hands it to
 * `writeApprovalRequest`, which is what fills `ToolCallPreview.details`. So
 * the approval ask has always carried the diff; this window simply never
 * read it. Returns `null` when the details are prose rather than a diff (a
 * shell command, a `replace_text` old/new pair), and the caller shows the
 * text as it is.
 */
export function readApprovalDiff(details: string | undefined): DiffView | null {
  if (!details || !looksLikeUnifiedDiff(details)) return null;
  const parsed = parseUnifiedDiff(details);
  const hunks = splitHunks(parsed.lines);
  if (hunks.length === 0) return null;
  return {
    hunks: hunks.slice(0, MAX_DIFF_HUNKS),
    hiddenHunks: Math.max(0, hunks.length - MAX_DIFF_HUNKS),
    // The preview's own text says what it left out (`… N more changed
    // line(s) not shown.`, `formatUnifiedDiff`), so nothing is claimed here.
    truncated: false,
    added: parsed.added,
    removed: parsed.removed,
  };
}

/** The line above the hunks, in the details column's own grammar. */
export function headerOf(details: string): string {
  const [first = ""] = details.split("\n");
  return first.startsWith("@@") || first.startsWith("--- ") ? "" : first;
}

/**
 * The gutter rendering: `│ <line> <sign> <text>`, one row per diff line, the
 * numbers right-aligned across the whole view exactly as `renderHunks`
 * computes one shared `numberWidth`.
 */
export function renderDiffView(view: DiffView): HTMLElement {
  const node = el("div", { class: "diff" });
  let numberWidth = 1;
  for (const hunk of view.hunks) {
    for (const line of hunk.lines) {
      const value = diffLineNumber(line);
      if (value !== null) numberWidth = Math.max(numberWidth, String(value).length);
    }
  }
  view.hunks.forEach((hunk, index) => {
    if (index > 0) node.append(el("div", { class: "diff-gap", text: "⋮" }));
    for (const line of hunk.lines) {
      const value = diffLineNumber(line);
      const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
      node.append(
        el("div", { class: `diff-line ${line.type}` }, [
          el("span", { class: "diff-edge", text: "│" }),
          el("span", {
            class: "diff-number",
            text: (value === null ? "" : String(value)).padStart(numberWidth),
          }),
          el("span", { class: "diff-sign", text: sign }),
          // Tabs render as two spaces, the same substitution `renderHunks`
          // makes, so a diff lines up identically on both surfaces.
          el("span", { class: "diff-text", text: line.text.replace(/\t/g, "  ") }),
        ]),
      );
    }
  });
  const notes: string[] = [];
  if (view.hiddenHunks > 0) {
    notes.push(`${view.hiddenHunks} more hunk(s) not shown`);
  }
  if (view.truncated) notes.push("more changed lines not shown");
  if (notes.length) node.append(el("div", { class: "diff-note", text: notes.join(" · ") }));
  return node;
}
