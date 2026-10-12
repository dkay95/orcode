/**
 * Block → lines (Bauplan K2/2.5). Pure: no terminal, no time source of its
 * own, therefore testable without a TTY.
 *
 * Line positions are deterministic: a running tool block is always exactly
 * `1 + RUNNING_TAIL_LINES` lines high, a finished one collapses to its head
 * (plus a foot when there is something to do). Nothing jumps.
 */

import { formatUsd, lookupTable } from "../utils.js";
import { toolMetadata } from "../workspace.js";
import {
  REASONING_MAX_LINES,
  RUNNING_TAIL_LINES,
  type ChatBlock,
} from "./blocks.js";
import { composeLine, displayWidth, fitSpans, wrapSpans, type Segment } from "./compose.js";
import { renderHunks } from "./diff-view.js";
import { markdownToLines } from "./markdown.js";
import { renderPanel } from "./panel-view.js";
import { span, type Line, type Span } from "./spans.js";
import { spinnerFrame, type Theme } from "./theme.js";

/**
 * How much of a pending change an approval shows inline. The question and its
 * key hints must never leave the viewport — a decision the user cannot see is
 * a decision they cannot make.
 */
export const APPROVAL_DETAIL_LINES = 10;

export interface RenderBlockOptions {
  /** Spinner tick; exactly one block may spin (R7). */
  tick?: number;
  /** True for the newest block — only then are key offers active. */
  last?: boolean;
  /** Reference time for running durations. */
  now?: number;
}

/**
 * FIX-14 (consolidation wave, ticket 2): the ONE elapsed `mm:ss` clock.
 *
 * There used to be three verbatim copies of this arithmetic — this one, an
 * identical one in `render-frame.ts` (the status line's run timer), and a
 * third in `dashboard-frame.ts` that the wave already replaced with the
 * honest `waitingPhase` seconds reading. Three copies of one rounding rule
 * is exactly the structural defect the audit names: a fix to one (say,
 * rolling past 59:59 into hours) silently leaves the others behind.
 *
 * Exported rather than duplicated: `render-frame.ts` already imports
 * `renderBlock` from this module, so the dependency direction is unchanged.
 * Minutes are NOT clamped at 99 — a run really can pass an hour, and a
 * truncated reading would be a lie about elapsed time.
 */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return elapsedClock(ms);
}

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function head(
  theme: Theme,
  width: number,
  glyph: Span,
  content: Span[],
  right?: Span[],
): Line {
  const segments: Segment[] = [
    { spans: [glyph, span(" ", "text"), ...content], align: "left", priority: 100 },
  ];
  if (right && right.length > 0) {
    segments.push({ spans: right, align: "right", priority: 50 });
  }
  return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
}

function body(theme: Theme, width: number, text: string, role: Span["role"] = "text"): Line {
  const edge = span(`${theme.glyph("blockEdge")} `, "structure");
  return {
    spans: fitSpans([edge, span(text, role)], width, theme.glyph("ellipsis")),
  };
}

function foot(theme: Theme, width: number, text: string): Line {
  const mark = span(`${theme.glyph("blockFoot")} `, "structure");
  return {
    spans: fitSpans([mark, span(text, "muted")], width, theme.glyph("ellipsis")),
  };
}

function stateGlyph(
  block: Extract<ChatBlock, { kind: "tool" }>,
  theme: Theme,
  tick: number,
): Span {
  switch (block.state) {
    case "running":
      return span(spinnerFrame(theme, tick), "active");
    case "ok":
      return span(theme.glyph("ok"), "ok");
    case "failed":
      return span(theme.glyph("failed"), "danger");
    case "cancelled":
      return span(theme.glyph("warn"), "warn");
    case "unverified":
    default: {
      const risk = toolMetadata(block.tool).risk;
      return risk === "read" || risk === "secret-read"
        ? span(theme.glyph("toolHead"), "muted")
        : span(theme.glyph("unverified"), "warn");
    }
  }
}

function toolRight(
  block: Extract<ChatBlock, { kind: "tool" }>,
  theme: Theme,
  now: number,
): Span[] {
  if (block.state === "running") {
    return [span(elapsedClock(now - block.at), "muted")];
  }
  const parts: string[] = [];
  if (block.exitCode !== undefined && block.exitCode !== 0) {
    parts.push(`exit ${block.exitCode}`);
  }
  if (block.durationMs !== undefined) parts.push(duration(block.durationMs));
  if (parts.length === 0) return [];
  return [span(parts.join(theme.glyph("separator")), "muted")];
}

/**
 * `<Tool>` names for the `● <Tool>(<argument>)` head (Terminal-Look spec
 * principle 2 / controller decision C). Falls back to the tool's uppercase
 * badge (`toolMetadata().label`) title-cased for anything not listed —
 * every real tool has an entry, this only guards an unknown/future one.
 */
// FIX-14 ticket 17: `lookupTable`, like `TOOL_METADATA` (workspace.ts) —
// same literal-lookup shape, same untrusted key. `tool` below is the model's
// own tool name, so a frozen object literal would resolve `constructor` to a
// FUNCTION and `??` would never reach the fallback.
const TOOL_DISPLAY_NAMES: Readonly<Record<string, string | undefined>> = lookupTable<string>({
  read_file: "Read",
  list_files: "List",
  search_files: "Search",
  write_file: "Write",
  replace_text: "Edit",
  run_command: "Shell",
  browser_check: "Browser",
  git_diff: "Git diff",
  verify: "Verify",
});

function toolDisplayName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool] ?? toolMetadata(tool).label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/** The word an outcome result line falls back to when there is no tail output to lead with. */
function outcomeFallback(state: Extract<ChatBlock, { kind: "tool" }>["state"]): string {
  switch (state) {
    case "ok":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "unverified":
    default:
      return "unverified";
  }
}

/**
 * The first result line under a finished tool call: `⎿ <outcome> <text>`.
 * The outcome glyph (from `stateGlyph`) carries success/failure/etc even
 * without colour (Bauplan R4/decision C) — the constant `●` head no longer
 * does, now that outcome lives here instead.
 */
function resultLine(
  theme: Theme,
  width: number,
  outcome: Span,
  text: string,
  role: Span["role"],
): Line {
  const mark = span(`${theme.glyph("blockFoot")} `, "structure");
  return { spans: fitSpans([mark, outcome, span(" ", "text"), span(text, role)], width, theme.glyph("ellipsis")) };
}

export function renderBlock(
  block: ChatBlock,
  width: number,
  theme: Theme,
  options: RenderBlockOptions = {},
): Line[] {
  const tick = options.tick ?? 0;
  const now = options.now ?? block.at;
  const usable = Math.max(4, width);

  switch (block.kind) {
    case "user": {
      // Phase 3b, Part B: an interjection keeps the ordinary user gutter but
      // adds the `interject` glyph right after it — `> ↪ <text>` — plus an
      // acceptance footer; both single-cell in every charset (1a invariant).
      const gutterText = block.interjected
        ? `${theme.glyph("userGutter")} ${theme.glyph("interject")} `
        : `${theme.glyph("userGutter")} `;
      const gutter = span(gutterText, "accent", { bold: true });
      const inner = Math.max(1, usable - displayWidth(gutterText));
      const lines = wrapSpans([span(block.text, "text")], inner).map((item) => ({
        spans: [{ ...gutter }, ...item.spans],
      }));
      if (block.attachmentCount > 0) {
        lines.push({
          spans: [
            { ...gutter },
            span(`${block.attachmentCount} attachment${block.attachmentCount === 1 ? "" : "s"}`, "muted"),
          ],
        });
      }
      if (block.interjected) {
        lines.push(foot(
          theme,
          usable,
          `Interjection accepted ${theme.glyph("emdash")} feeds into the next step`,
        ));
      }
      return lines;
    }

    case "assistant": {
      const inner = Math.max(1, usable - 2);
      const lines = markdownToLines(block.text, inner, theme).map((item) => ({
        spans: [span(theme.glyph("assistantGutter"), "accent"), ...item.spans],
      }));
      if (block.costUsd !== undefined) {
        lines.push(
          composeLine(
            [
              {
                // FIX-14 ticket 3: the one exact-USD formatter, not a fourth inline rule.
                spans: [span(formatUsd(block.costUsd), "muted")],
                align: "right",
                priority: 10,
              },
            ],
            usable,
          ),
        );
      }
      return lines;
    }

    case "reasoning": {
      const glyph = block.live
        ? span(spinnerFrame(theme, tick), "active")
        : span(theme.glyph("toolHead"), "muted");
      // Phase 3b, Part C: live thinking renders the spec's born-new English
      // steering line — elapsed seconds, the Ctrl+O expand hint (mirroring
      // `expanded` the same way the finished line below always has), and the
      // esc-ends-thinking hint (only meaningful while something is left to
      // end). The finished line has since moved off its original German
      // wording onto the same English glossary — thought/tokens plus the
      // file's established Ctrl+O expand/collapse pair (see the truncated
      // foot below) — with only the keybinding hint's move from Ctrl+T to
      // Ctrl+O predating that pass.
      const info = block.live
        ? `Thinking ${theme.glyph("ellipsis")} (${Math.max(0, Math.floor((now - block.at) / 1000))}s${theme.glyph("separator")}Ctrl+O ${
            block.expanded ? "hide" : "show"
          } thinking${theme.glyph("separator")}Esc end thinking)`
        : [
            "thought",
            `${block.estimated && block.tokens > 0 ? "~" : ""}${block.tokens} tokens`,
            block.expanded ? "Ctrl+O collapse" : "Ctrl+O expand",
          ].join(theme.glyph("separator"));
      const lines: Line[] = [head(theme, usable, glyph, [span(info, "muted")])];
      const text = block.text.replace(/\s+/g, " ").trim();
      const inner = Math.max(1, usable - 2);
      if (block.expanded) {
        const wrapped = wrapSpans([span(text, "muted")], inner).slice(
          -REASONING_MAX_LINES,
        );
        for (const item of wrapped) {
          lines.push({
            spans: [span(`${theme.glyph("blockEdge")} `, "structure"), ...item.spans],
          });
        }
      } else if (text.length > 0) {
        lines.push(body(theme, usable, text, "muted"));
      }
      if (block.truncated && !block.expanded) {
        lines.push(foot(theme, usable, `truncated${theme.glyph("separator")}Ctrl+O expand`));
      }
      return lines;
    }

    case "tool": {
      // Controller decision C: the head bullet is constant — accent while
      // running keeps today's spinner, everything else is the plain toolHead
      // glyph. Outcome (success/failure/…) moves to the first result line
      // instead, via `stateGlyph`, unchanged in what it computes.
      const isSsh = block.tool === "ssh_command";
      const argument = block.input || block.title;
      const headGlyph = block.state === "running"
        ? span(spinnerFrame(theme, tick), "active")
        : span(theme.glyph("toolHead"), "accent");
      // `ssh_command`'s own `summarizeInput` already produces the complete
      // `SSH <host>(<command>)` text (spec principle 9) — wrapping it again
      // in a second `Tool(...)` shell would double up the parentheses.
      const labelSpans: Span[] = isSsh
        ? [span(argument, "text")]
        : [
            span(`${toolDisplayName(block.tool)}(`, "text"),
            span(argument, "muted"),
            span(")", "text"),
          ];
      const lines: Line[] = [
        head(theme, usable, headGlyph, labelSpans, toolRight(block, theme, now)),
      ];

      if (block.state === "running") {
        // Fixed height: the block must not grow, or everything below moves.
        const tail = block.tail.slice(-RUNNING_TAIL_LINES);
        for (let index = 0; index < RUNNING_TAIL_LINES; index += 1) {
          const text = tail[index - (RUNNING_TAIL_LINES - tail.length)] ?? "";
          lines.push(body(theme, usable, text, "muted"));
        }
        return lines;
      }

      // Finished: always exactly one outcome-carrying result line — even a
      // collapsed success gets `⎿ ✓ …`, or NO_COLOR loses the one signal
      // decision C promises it keeps. Further lines (failed/expanded) stay
      // plain `body()` continuation lines under `blockEdge`.
      const outcome = stateGlyph(block, theme, tick);
      const bodyRole = block.state === "failed" ? "text" : "muted";
      const showFullTail = block.state === "failed" || block.expanded;
      const limit = block.expanded ? REASONING_MAX_LINES : RUNNING_TAIL_LINES;
      const tailLines = showFullTail ? block.tail.slice(0, limit) : block.tail.slice(0, 1);
      if (tailLines.length > 0) {
        lines.push(resultLine(theme, usable, outcome, tailLines[0]!, bodyRole));
        for (const text of tailLines.slice(1)) {
          lines.push(body(theme, usable, text, bodyRole));
        }
      } else {
        lines.push(resultLine(theme, usable, outcome, outcomeFallback(block.state), "muted"));
      }
      if (showFullTail) {
        const shown = Math.min(block.tail.length, limit);
        if (block.totalLines > shown) {
          lines.push(
            foot(
              theme,
              usable,
              // Keyboard-audit addendum to FIX-3: this used to advertise a
              // bare `o`, which no dispatch ever bound — pressing it simply
              // typed an "o" into the composer. The real key is Ctrl+O (the
              // same one the reasoning block names, and — as of this fix —
              // the same one that reaches a tool block at the end of the
              // transcript, which is exactly when this hint renders).
              `${block.totalLines - shown} more lines${
                options.last
                  // FIX-14 ticket 1: `Ctrl+O`, the keymap table's own
                  // spelling — this hint used to lowercase the very key
                  // the reasoning block two screens up spells `Ctrl+O`.
                  ? `${theme.glyph("separator")}${block.expanded ? "Ctrl+O collapse" : "Ctrl+O expand"}`
                  : ""
              }`,
            ),
          );
        }
      }
      return lines;
    }

    case "diff": {
      const right = [
        span(`+${block.added}`, "add"),
        span(" ", "text"),
        span(`-${block.removed}`, "del"),
      ];
      const lines: Line[] = [
        head(
          theme,
          usable,
          span(theme.glyph("diffHead"), "accent"),
          [span(block.path, "text")],
          right,
        ),
        ...renderHunks(block.hunks, usable, theme),
      ];
      const notes: string[] = [];
      if (block.hiddenHunks > 0) notes.push(`${block.hiddenHunks} more hunks`);
      if (block.truncated) notes.push("truncated");
      // Size honesty (FIX-3): whenever something was left out, name the one
      // surface that shows more — `/diff`, a real command. No "shows
      // everything" promise: `/diff` is `git diff`, which says nothing about
      // a file git does not track yet.
      if (block.hiddenHunks > 0 || block.truncated) notes.push("/diff");
      if (block.state === "ok" || block.state === "unverified") notes.push("applied");
      // FIX-3 keyboard truth: the hint used to read `u undo`, but `u` is a
      // letter — every dispatch state that could reach it is a state where
      // the composer is taking text, so no non-conflicting binding exists
      // (Ctrl+U is readline's kill-to-start and stays that). The block names
      // the real, reachable mechanism instead; `/undo` reverts the whole run
      // this edit belongs to, with its own confirmation.
      if (block.undoable && options.last) notes.push("/undo reverts the run");
      if (notes.length > 0) {
        lines.push(foot(theme, usable, notes.join(theme.glyph("separator"))));
      }
      return lines;
    }

    case "approval": {
      // Audit FIX-1 (2026-08-28), CRITICAL: this head is the single most
      // safety-critical line of the product and must speak the same English
      // as the rest of the approval copy family ("Applies only to:",
      // "always allow this exact subject", …) — it shipped as the German
      // "Freigabe" long after the D4 sweep took `j` (ja) out of the keys.
      const lines: Line[] = [
        head(theme, usable, span(theme.glyph("warn"), "warn"), [
          span(`Approval${theme.glyph("separator")}${block.summary}`, "warn"),
        ]),
      ];
      if (block.diff && block.diff.length > 0) {
        lines.push(...renderHunks(block.diff, usable, theme));
      } else {
        // An approval must stay readable at a glance. Writing a 600-line file
        // used to render 600 lines here, pushing the actual question — and the
        // key hints below it — out of the viewport, so the run looked frozen
        // while it was really waiting for an answer nobody could see.
        //
        // Audit FIX-1 (2026-08-28): `expanded` (Ctrl+O/Ctrl+T inside confirm
        // mode) shows every detail line — the "Ctrl+O shows all" hint below
        // used to be false 100% of the time it rendered, forcing the owner
        // to approve a large write blind. While expanded the hint flips to
        // the file's established collapse wording.
        const visible = block.expanded
          ? block.details
          : block.details.slice(0, APPROVAL_DETAIL_LINES);
        for (const detail of visible) {
          lines.push(body(theme, usable, detail, "text"));
        }
        const hidden = block.details.length - APPROVAL_DETAIL_LINES;
        if (hidden > 0 && !block.expanded) {
          lines.push(
            body(
              theme,
              usable,
              `${theme.glyph("ellipsis")} ${hidden} more lines${theme.glyph("separator")}Ctrl+O shows all`,
              "muted",
            ),
          );
        } else if (hidden > 0) {
          // FIX-14 ticket 1: `Ctrl+O`, matching the `Ctrl+O shows all`
          // hint in the branch directly above it.
          lines.push(body(theme, usable, "Ctrl+O collapse", "muted"));
        }
      }
      if (block.rememberHint) {
        lines.push(foot(theme, usable, block.rememberHint));
      }
      return lines;
    }

    case "notice": {
      const glyph =
        block.level === "error"
          ? span(theme.glyph("failed"), "danger")
          : block.level === "warn"
            ? span(theme.glyph("warn"), "warn")
            : span(theme.glyph("toolHead"), "muted");
      const role = block.level === "error" ? "danger" : block.level === "warn" ? "warn" : "text";
      // D3 (owner design batch): a collapsed repeat streak gets one muted
      // counter appended to the title instead of a second identical block —
      // the block itself already re-renders every time the count changes,
      // so this needs no animation of its own.
      const titleSpans: Span[] = [span(block.title, role)];
      if (block.repeatCount && block.repeatCount > 1) {
        titleSpans.push(span(` ${theme.glyph("multiply")} ${block.repeatCount}`, "muted"));
      }
      const lines: Line[] = [
        head(theme, usable, glyph, titleSpans, [
          span(stamp(block.at), "muted"),
        ]),
      ];
      const inner = Math.max(1, usable - 2);
      if (block.cause.length > 0) {
        const edge = span(`${theme.glyph("blockEdge")} `, "structure");
        for (const wrapped of markdownToLines(block.cause.join("\n"), inner, theme)) {
          lines.push({ spans: [{ ...edge }, ...wrapped.spans] });
        }
      }
      return lines;
    }

    case "panel":
      return renderPanel(block.result, usable, theme, {
        expandedIndex: block.expandedIndex,
        judgment: block.judgment,
      });

    default:
      return [];
  }
}
