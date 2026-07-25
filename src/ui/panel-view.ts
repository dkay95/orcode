/**
 * Model-panel → lines. Pure, like `render-block.ts` (its pattern for heads,
 * bodies and feet is deliberately mirrored here): no terminal, no clock of
 * its own. The caller supplies width, theme, and which single answer (if
 * any) is expanded — this module never keeps its own state.
 *
 * Rule R1 still applies: meaning comes from `role` and glyphs, never from
 * colour alone. A failed answer must read as failed at `theme.level === 0`
 * exactly as it does at level 3.
 */

import type { PanelAnswer, PanelJudgment, PanelResult } from "../panel.js";
import { composeLine, fitSpans, type Segment } from "./compose.js";
import { markdownToLines } from "./markdown.js";
import { span, type Line, type Span } from "./spans.js";
import type { Theme } from "./theme.js";

/** Cap on one expanded answer or judgment so a single huge reply cannot swallow the screen. */
export const PANEL_EXPANDED_MAX_LINES = 40;

export interface PanelViewOptions {
  /** Index into `result.answers` currently shown in full; `null`/unset collapses every answer to its one-line teaser. */
  expandedIndex?: number | null;
  /** The judge's synthesis, if `/panel judge` produced one for this result. */
  judgment?: PanelJudgment | null;
}

function durationText(ms: number): string {
  return ms < 1000 ? `${Math.max(0, ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function costText(value: number): string {
  return `$${Math.max(0, value).toFixed(value < 0.01 ? 5 : 4)}`;
}

function body(theme: Theme, width: number, text: string, role: Span["role"] = "text"): Line {
  const edge = span(`${theme.glyph("blockEdge")} `, "structure");
  return { spans: fitSpans([edge, span(text, role)], width, theme.glyph("ellipsis")) };
}

/** State glyph for one answer — distinguishes success/empty/failed by shape, not only by colour (R1). */
function answerGlyph(theme: Theme, answer: PanelAnswer): { text: string; role: Span["role"] } {
  if (answer.error) {
    return { text: theme.glyph("failed"), role: "danger" };
  }
  if (!answer.text.trim()) {
    return { text: theme.glyph("warn"), role: "warn" };
  }
  return { text: theme.glyph("ok"), role: "ok" };
}

function headLine(theme: Theme, width: number, result: PanelResult): Line {
  const question = result.question.replace(/\s+/g, " ").trim();
  const modelWord = result.answers.length === 1 ? "Modell" : "Modelle";
  const segments: Segment[] = [
    {
      spans: [
        span(theme.glyph("marker"), "accent"),
        span(" ", "text"),
        span(`Panel${theme.glyph("separator")}${question}`, "text", { bold: true }),
      ],
      align: "left",
      priority: 100,
    },
    {
      spans: [
        span(
          `${result.answers.length} ${modelWord}${theme.glyph("separator")}${costText(result.totalCostUsd)}${theme.glyph("separator")}${durationText(result.durationMs)}`,
          "muted",
        ),
      ],
      compact: [
        span(
          `${result.answers.length}${theme.glyph("separator")}${costText(result.totalCostUsd)}`,
          "muted",
        ),
      ],
      align: "right",
      priority: 10,
    },
  ];
  return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
}

function answerHeadLine(
  theme: Theme,
  width: number,
  answer: PanelAnswer,
  index: number,
  expanded: boolean,
): Line {
  const glyph = answerGlyph(theme, answer);
  const label = `${index + 1}. ${answer.model}`;
  const rightRole: Span["role"] = answer.error ? "danger" : "muted";
  const rightText = answer.error
    ? `Fehler${theme.glyph("separator")}${answer.error}`
    : `${costText(answer.costUsd)}${theme.glyph("separator")}${durationText(answer.durationMs)}${
        expanded ? `${theme.glyph("separator")}vollständig` : ""
      }`;
  const segments: Segment[] = [
    {
      spans: [span(glyph.text, glyph.role), span(" ", "text"), span(label, "text")],
      align: "left",
      priority: 100,
    },
    {
      spans: [span(rightText, rightRole)],
      compact: answer.error
        ? [span("Fehler", "danger")]
        : [span(costText(answer.costUsd), "muted")],
      align: "right",
      priority: 60,
    },
  ];
  return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
}

function judgeHeadLine(theme: Theme, width: number, judgment: PanelJudgment): Line {
  const label = `Richter${theme.glyph("separator")}${judgment.judgeModel}`;
  const right: Span[] = judgment.error
    ? [span("Fehler", "danger")]
    : [
        span(
          `${costText(judgment.costUsd)}${theme.glyph("separator")}${durationText(judgment.durationMs)}`,
          "muted",
        ),
      ];
  const segments: Segment[] = [
    {
      spans: [
        span(theme.glyph("marker"), "accent"),
        span(" ", "text"),
        span(label, "text", { bold: true }),
      ],
      align: "left",
      priority: 100,
    },
    { spans: right, align: "right", priority: 60 },
  ];
  return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
}

function expandedLines(theme: Theme, width: number, text: string): Line[] {
  const inner = Math.max(1, width - 2);
  const edge = span(`${theme.glyph("blockEdge")} `, "structure");
  return markdownToLines(text.trim(), inner, theme)
    .slice(0, PANEL_EXPANDED_MAX_LINES)
    .map((item) => ({ spans: [{ ...edge }, ...item.spans] }));
}

/**
 * The judge's synthesis, clearly separated from the model answers above it:
 * its own head line, labelled "Richter" (never a bare model name like the
 * answers get), always shown in full — it is one recommendation, not one of
 * several to browse.
 */
function judgmentLines(theme: Theme, width: number, judgment: PanelJudgment): Line[] {
  const lines: Line[] = [judgeHeadLine(theme, width, judgment)];
  if (judgment.error) {
    lines.push(body(theme, width, judgment.error, "danger"));
    return lines;
  }
  const clean = judgment.text.trim();
  if (!clean) {
    lines.push(body(theme, width, "(keine Auswertung erhalten)", "muted"));
    return lines;
  }
  lines.push(...expandedLines(theme, width, judgment.text));
  return lines;
}

/**
 * Renders a `PanelResult` (plus an optional judge round). Every model gets a
 * one-line teaser with its state glyph, cost and duration; at most one answer
 * — `options.expandedIndex` — is shown in full. A screen full of three
 * complete model answers is unusable, so this never happens by accident.
 */
export function renderPanel(
  result: PanelResult,
  width: number,
  theme: Theme,
  options: PanelViewOptions = {},
): Line[] {
  const usable = Math.max(4, width);
  const expandedIndex = options.expandedIndex ?? null;
  const lines: Line[] = [headLine(theme, usable, result)];

  result.answers.forEach((answer, index) => {
    const expanded = expandedIndex === index;
    lines.push(answerHeadLine(theme, usable, answer, index, expanded));
    if (answer.error) {
      lines.push(body(theme, usable, answer.error, "danger"));
      return;
    }
    const clean = answer.text.replace(/\s+/g, " ").trim();
    if (!clean) {
      lines.push(body(theme, usable, "(leere Antwort)", "muted"));
      return;
    }
    if (expanded) {
      lines.push(...expandedLines(theme, usable, answer.text));
    } else {
      lines.push(body(theme, usable, clean, "text"));
    }
  });

  if (options.judgment) {
    lines.push(...judgmentLines(theme, usable, options.judgment));
  }

  return lines;
}
