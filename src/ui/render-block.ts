/**
 * Block → lines (Bauplan K2/2.5). Pure: no terminal, no time source of its
 * own, therefore testable without a TTY.
 *
 * Line positions are deterministic: a running tool block is always exactly
 * `1 + RUNNING_TAIL_LINES` lines high, a finished one collapses to its head
 * (plus a foot when there is something to do). Nothing jumps.
 */

import { toolMetadata } from "../workspace.js";
import {
  REASONING_MAX_LINES,
  RUNNING_TAIL_LINES,
  type ChatBlock,
} from "./blocks.js";
import { composeLine, fitSpans, wrapSpans, type Segment } from "./compose.js";
import { renderHunks } from "./diff-view.js";
import { markdownToLines } from "./markdown.js";
import { span, type Line, type Span } from "./spans.js";
import { spinnerFrame, type Theme } from "./theme.js";

export interface RenderBlockOptions {
  /** Spinner tick; exactly one block may spin (R7). */
  tick?: number;
  /** True for the newest block — only then are key offers active. */
  last?: boolean;
  /** Reference time for running durations. */
  now?: number;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return clock(ms);
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
    return [span(clock(now - block.at), "muted")];
  }
  const parts: string[] = [];
  if (block.exitCode !== undefined && block.exitCode !== 0) {
    parts.push(`exit ${block.exitCode}`);
  }
  if (block.durationMs !== undefined) parts.push(duration(block.durationMs));
  if (parts.length === 0) return [];
  return [span(parts.join(theme.glyph("separator")), "muted")];
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
      const gutter = span(`${theme.glyph("userGutter")} `, "accent");
      const inner = Math.max(1, usable - 2);
      const lines = wrapSpans([span(block.text, "text")], inner).map((item) => ({
        spans: [{ ...gutter }, ...item.spans],
      }));
      if (block.attachmentCount > 0) {
        lines.push({
          spans: [
            { ...gutter },
            span(`${block.attachmentCount} Anhang/Anhänge`, "muted"),
          ],
        });
      }
      return lines;
    }

    case "assistant": {
      const inner = Math.max(1, usable - 2);
      const lines = markdownToLines(block.text, inner, theme).map((item) => ({
        spans: [span("  ", "text"), ...item.spans],
      }));
      if (block.costUsd !== undefined) {
        lines.push(
          composeLine(
            [
              {
                spans: [span(`$${block.costUsd.toFixed(4)}`, "muted")],
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
      const info = [
        "denkt",
        `${block.tokens} Tokens`,
        block.expanded ? "Ctrl+T einklappen" : "Ctrl+T aufklappen",
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
        lines.push(foot(theme, usable, "gekürzt · Ctrl+T aufklappen"));
      }
      return lines;
    }

    case "tool": {
      const glyph = stateGlyph(block, theme, tick);
      const label =
        block.state === "cancelled"
          ? `${block.title} abgebrochen${block.input ? `: ${block.input}` : ""}`
          : block.input || block.title;
      const lines: Line[] = [
        head(theme, usable, glyph, [span(label, "text")], toolRight(block, theme, now)),
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

      const showTail = block.state === "failed" || block.expanded;
      if (showTail) {
        const limit = block.expanded ? REASONING_MAX_LINES : RUNNING_TAIL_LINES;
        for (const text of block.tail.slice(0, limit)) {
          lines.push(
            body(theme, usable, text, block.state === "failed" ? "text" : "muted"),
          );
        }
        const shown = Math.min(block.tail.length, limit);
        if (block.totalLines > shown) {
          lines.push(
            foot(
              theme,
              usable,
              `${block.totalLines - shown} weitere Zeilen${
                options.last ? `${theme.glyph("separator")}o öffnen` : ""
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
      if (block.hiddenHunks > 0) notes.push(`${block.hiddenHunks} weitere Hunks`);
      if (block.state === "ok" || block.state === "unverified") notes.push("übernommen");
      if (block.undoable && options.last) notes.push("u rückgängig");
      if (notes.length > 0) {
        lines.push(foot(theme, usable, notes.join(theme.glyph("separator"))));
      }
      return lines;
    }

    case "approval": {
      const lines: Line[] = [
        head(theme, usable, span(theme.glyph("warn"), "warn"), [
          span(`Freigabe${theme.glyph("separator")}${block.summary}`, "warn"),
        ]),
      ];
      if (block.diff && block.diff.length > 0) {
        lines.push(...renderHunks(block.diff, usable, theme));
      } else {
        for (const detail of block.details) {
          lines.push(body(theme, usable, detail, "text"));
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
      const lines: Line[] = [
        head(theme, usable, glyph, [span(block.title, role)], [
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
      if (block.actions.length > 0 && options.last !== false) {
        const text = block.actions
          .map((action) => `${action.key} ${action.label}`)
          .join(theme.glyph("separator"));
        lines.push(foot(theme, usable, text));
      }
      return lines;
    }

    default:
      return [];
  }
}

/** Height of a block without building it — used for scroll maths. */
export function blockHeight(
  block: ChatBlock,
  width: number,
  theme: Theme,
  options: RenderBlockOptions = {},
): number {
  return renderBlock(block, width, theme, options).length;
}
