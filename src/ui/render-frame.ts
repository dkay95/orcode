/**
 * Frame assembly (Bauplan 2.4): head, bottom-anchored stream, expansion,
 * the one divider, status, input block, help line.
 *
 * Chrome at rest is three lines. Accessories never win over the stream: the
 * expansion goes first, then the help line, then the head.
 */

import type { ChatBlock, Viewport } from "./blocks.js";
import { composeLine, displayWidth, type Segment } from "./compose.js";
import { renderBlock } from "./render-block.js";
import { span, type Line, type Span } from "./spans.js";
import { spinnerFrame, type Theme } from "./theme.js";

export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
export const MIN_STREAM = 5;
export const MAX_CONTENT_WIDTH = 100;
export const MAX_INPUT_LINES = 6;

export interface HeaderInfo {
  workspace?: string;
  git?: string;
  model?: string;
  approvalMode?: string;
  contextPercent?: number;
  costUsd?: number;
  balance?: string;
  /** Active `/ssh` target alias, if any — the most dangerous state the header can show, see `headerSegments`. */
  sshHost?: string;
}

export interface StatusInfo {
  phase: string;
  spinning?: boolean;
  elapsedMs?: number;
  step?: string;
  cost?: string;
  lastEventAgeMs?: number;
  cancelHint?: string;
  role?: Span["role"];
}

export interface FrameInput {
  width: number;
  height: number;
  theme: Theme;
  blocks: readonly ChatBlock[];
  /** Raw input buffer; may contain `\n` from Shift+Enter. */
  inputText: string;
  /** Code-point cursor index into `inputText`. */
  inputCursor: number;
  /**
   * Fixed prefix shown on every visible input row, ahead of the gutter — the
   * one hint (e.g. the secret's name) that must never scroll out of view
   * (Bauplan A6).
   */
  inputLabel?: string;
  viewport?: Viewport;
  header?: HeaderInfo;
  status?: StatusInfo;
  expansion?: Line[];
  help?: string;
  /** Lines that arrived while the user was scrolled back (R9). */
  newLinesBelow?: number;
  tick?: number;
  now?: number;
}

export interface Frame {
  lines: Line[];
  chatHeight: number;
  maxScrollOffset: number;
  cursor: { row: number; col: number };
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function headerSegments(theme: Theme, info: HeaderInfo): Segment[] {
  const segments: Segment[] = [];
  const separator = theme.glyph("separator");
  if (info.workspace) {
    const compact = info.workspace.split("/").filter(Boolean).at(-1) ?? info.workspace;
    segments.push({
      spans: [span(info.workspace, "muted")],
      compact: [span(compact, "muted")],
      align: "left",
      priority: 60,
    });
  }
  if (info.git) {
    segments.push({ spans: [span(info.git, "muted")], align: "left", priority: 70 });
  }
  if (info.model) {
    segments.push({ spans: [span(info.model, "text")], align: "left", priority: 100 });
  }
  if (info.approvalMode) {
    // R6: the approval mode is the one piece of chrome that never leaves.
    segments.push({
      spans: [span(`${separator.trim()} ${info.approvalMode}`, "warn")],
      compact: [span(info.approvalMode, "warn")],
      align: "left",
      priority: 95,
    });
  }
  if (info.sshHost) {
    // An active SSH target outranks even the approval mode: it is the one
    // piece of state that means "the next command may not run on this
    // machine at all" — priority 110 keeps it on screen longest of anything
    // in the header, dropped only after every other segment is already gone.
    const label = `SSH: ${info.sshHost.toUpperCase()}`;
    segments.push({
      spans: [span(label, "danger", { bold: true })],
      compact: [span(label, "danger", { bold: true })],
      align: "left",
      priority: 110,
    });
  }
  if (info.contextPercent !== undefined) {
    // A7: from 80% the fill level warns — a colour role, backed by the digits
    // themselves so NO_COLOR loses no information (R4).
    const role = info.contextPercent >= 80 ? "warn" : "muted";
    segments.push({
      spans: [span(`Kontext ${Math.round(info.contextPercent)}%`, role)],
      compact: [span(`${Math.round(info.contextPercent)}%`, role)],
      align: "left",
      priority: 80,
    });
  }
  if (info.costUsd !== undefined) {
    segments.push({
      spans: [span(`$${info.costUsd.toFixed(2)}`, "muted")],
      align: "right",
      priority: 90,
    });
  }
  if (info.balance) {
    segments.push({
      spans: [span(info.balance, "muted")],
      align: "right",
      priority: 50,
    });
  }
  return segments;
}

function statusSegments(theme: Theme, info: StatusInfo, tick: number): Segment[] {
  const role = info.role ?? "text";
  const glyph = info.spinning
    ? `${spinnerFrame(theme, tick)} `
    : `${theme.glyph("warn")} `;
  const segments: Segment[] = [
    {
      spans: [
        span(info.spinning ? glyph : "", "active"),
        span(info.phase, role),
      ],
      align: "left",
      priority: 100,
    },
  ];
  if (info.elapsedMs !== undefined) {
    segments.push({
      spans: [span(clock(info.elapsedMs), "muted")],
      align: "left",
      priority: 90,
    });
  }
  if (info.step) {
    segments.push({ spans: [span(info.step, "muted")], align: "left", priority: 80 });
  }
  if (info.cost) {
    segments.push({ spans: [span(info.cost, "muted")], align: "right", priority: 70 });
  }
  if (info.lastEventAgeMs !== undefined) {
    segments.push({
      spans: [span(`zuletzt vor ${Math.round(info.lastEventAgeMs / 1000)}s`, "muted")],
      align: "right",
      priority: 60,
    });
  }
  if (info.cancelHint) {
    segments.push({
      spans: [span(info.cancelHint, "muted")],
      align: "right",
      priority: 50,
    });
  }
  return segments;
}

interface StreamEntry {
  blockId: string;
  lines: Line[];
}

function buildStream(input: FrameInput, width: number): StreamEntry[] {
  const entries: StreamEntry[] = [];
  const last = input.blocks[input.blocks.length - 1];
  input.blocks.forEach((block, index) => {
    if (index > 0) entries.push({ blockId: block.id, lines: [{ spans: [] }] });
    entries.push({
      blockId: block.id,
      lines: renderBlock(block, width, input.theme, {
        tick: input.tick ?? 0,
        last: last?.id === block.id,
        now: input.now ?? Date.now(),
      }),
    });
  });
  return entries;
}

function clampNumber(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

interface InputRow {
  /** Visible text of this wrapped row. */
  text: string;
  /** Code-point offset into the raw buffer where this row starts. */
  start: number;
}

/**
 * Real soft wrap (Bauplan A6): every logical (`\n`-separated) line is cut
 * into rows of at most `capacity` code points. An empty logical line still
 * produces one empty row so the cursor has somewhere to land on a blank
 * line.
 */
function wrapInputText(text: string, capacity: number): InputRow[] {
  const rows: InputRow[] = [];
  let offset = 0;
  const logicalLines = text.split("\n");
  logicalLines.forEach((line, index) => {
    const chars = Array.from(line);
    if (chars.length === 0) {
      rows.push({ text: "", start: offset });
    } else {
      for (let cut = 0; cut < chars.length; cut += capacity) {
        rows.push({ text: chars.slice(cut, cut + capacity).join(""), start: offset + cut });
      }
    }
    offset += chars.length + (index < logicalLines.length - 1 ? 1 : 0);
  });
  return rows;
}

/** The row whose span `[start, start+length]` contains `cursor`. */
function inputRowForCursor(rows: readonly InputRow[], cursor: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (cursor >= rows[index]!.start) return index;
  }
  return 0;
}

function tooSmall(width: number): Frame {
  const message = span(
    `Terminal zu klein (mindestens ${MIN_WIDTH}×${MIN_HEIGHT} Zeichen)`,
    "danger",
  );
  return {
    lines: [composeLine([{ spans: [message], align: "left", priority: 100 }], Math.max(1, width))],
    chatHeight: 0,
    maxScrollOffset: 0,
    cursor: { row: 1, col: 1 },
  };
}

export function buildFrame(input: FrameInput): Frame {
  const { theme, width, height } = input;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return tooSmall(width);
  }

  const usableWidth = Math.max(1, width - 1);
  const bodyWidth = Math.min(MAX_CONTENT_WIDTH, usableWidth);

  // A6: the label (if any, e.g. the secret's name) and the gutter are a fixed
  // prefix on every visible row — only the text after it scrolls.
  const inputGutter = `${theme.glyph("userGutter")} `;
  const inputLabel = input.inputLabel ? `${input.inputLabel} ` : "";
  const inputPrefix = `${inputLabel}${inputGutter}`;
  const inputPrefixWidth = displayWidth(inputPrefix);
  const inputWrapWidth = Math.max(4, usableWidth - inputPrefixWidth);
  const inputRows = wrapInputText(input.inputText, inputWrapWidth);
  const inputTotalRows = Math.max(1, inputRows.length);
  const inputHeight = Math.min(MAX_INPUT_LINES, inputTotalRows);
  const expansionLimit = height >= 20 ? 6 : 4;
  let expansion = (input.expansion ?? []).slice(0, expansionLimit);
  let help = input.help && input.help.length > 0 ? input.help : undefined;
  let showHeader = height >= 12;
  const statusHeight = input.status ? 1 : 0;

  const chrome = (): number =>
    (showHeader ? 1 : 0) + expansion.length + 1 + statusHeight + inputHeight + (help ? 1 : 0);

  let chatHeight = height - chrome();
  if (chatHeight < MIN_STREAM && expansion.length > 0) {
    expansion = [];
    chatHeight = height - chrome();
  }
  if (chatHeight < MIN_STREAM && help) {
    help = undefined;
    chatHeight = height - chrome();
  }
  if (chatHeight < MIN_STREAM && showHeader) {
    showHeader = false;
    chatHeight = height - chrome();
  }
  chatHeight = Math.max(1, chatHeight);

  const entries = buildStream(input, bodyWidth);
  const flat: Array<{ blockId: string; line: Line }> = [];
  const firstLineOf = new Map<string, number>();
  for (const entry of entries) {
    for (const item of entry.lines) {
      if (!firstLineOf.has(entry.blockId)) firstLineOf.set(entry.blockId, flat.length);
      flat.push({ blockId: entry.blockId, line: item });
    }
  }

  const viewport = input.viewport ?? { anchor: "tail" as const };
  const maxScrollOffset = Math.max(0, flat.length - chatHeight);
  let top = maxScrollOffset;
  if (viewport.anchor !== "tail") {
    const start = firstLineOf.get(viewport.anchor.blockId);
    if (start !== undefined) {
      top = Math.min(maxScrollOffset, Math.max(0, start + viewport.anchor.lineOffset));
    }
  }

  const scrolled = top < maxScrollOffset;
  const streamLines: Line[] = [];
  let capacity = chatHeight;
  if (scrolled && chatHeight > 1) {
    const above = top;
    streamLines.push(
      composeLine(
        [
          {
            spans: [
              span(`${theme.glyph("scrollUp")} `, "muted"),
              span(
                [
                  `${above} Zeilen darüber`,
                  `Zeile ${top + 1} von ${flat.length}`,
                  "End springt ans Ende",
                ].join(theme.glyph("separator")),
                "muted",
              ),
            ],
            align: "left",
            priority: 100,
          },
        ],
        usableWidth,
      ),
    );
    capacity -= 1;
  }

  const window = flat.slice(top, top + capacity).map((item) => item.line);
  // R8: content is anchored at the bottom; empty space grows at the top.
  const padding = Math.max(0, capacity - window.length);
  for (let index = 0; index < padding; index += 1) {
    streamLines.push({ spans: [] });
  }
  streamLines.push(...window);

  const lines: Line[] = [];
  if (showHeader) {
    lines.push(composeLine(headerSegments(theme, input.header ?? {}), usableWidth));
  }
  lines.push(...streamLines);
  lines.push(...expansion);

  const dividerText = theme.glyph("divider").repeat(usableWidth);
  if (scrolled && (input.newLinesBelow ?? 0) > 0) {
    const note = ` ${theme.glyph("scrollUp") === "^" ? "v" : "↓"} ${input.newLinesBelow} neue Zeilen `;
    const keep = Math.max(0, usableWidth - note.length);
    lines.push({
      spans: [
        span(theme.glyph("divider").repeat(Math.max(0, keep)), "structure"),
        span(note, "warn"),
      ],
    });
  } else {
    lines.push({ spans: [span(dividerText, "structure")] });
  }

  if (input.status) {
    lines.push(composeLine(statusSegments(theme, input.status, input.tick ?? 0), usableWidth));
  }

  const inputCursorRow = inputRowForCursor(inputRows, input.inputCursor);
  // The window follows the cursor: typing at the tail keeps it bottom
  // anchored, but scrolling or editing further up keeps that row visible too.
  const inputWindowStart = clampNumber(
    inputCursorRow - inputHeight + 1,
    0,
    Math.max(0, inputTotalRows - inputHeight),
  );
  const inputWindowTop = Math.min(inputWindowStart, inputCursorRow);
  const visibleInput = inputRows.slice(inputWindowTop, inputWindowTop + inputHeight);
  const inputStart = lines.length;
  const showInputScrollHint = inputTotalRows > inputHeight;
  visibleInput.forEach((row, index) => {
    const spans: Span[] = [span(inputPrefix, "accent"), span(row.text, "text")];
    if (index === visibleInput.length - 1 && showInputScrollHint) {
      lines.push(
        composeLine(
          [
            { spans, align: "left", priority: 100 },
            {
              spans: [span(`${visibleInput.length}/${inputTotalRows}`, "muted")],
              align: "right",
              priority: 40,
            },
          ],
          usableWidth,
        ),
      );
      return;
    }
    lines.push({ spans });
  });

  if (help) {
    lines.push({
      spans: [span("  ", "text"), span(help, "muted")],
    });
  }

  const cursorRowInWindow = inputCursorRow - inputWindowTop;
  const clampedRow = clampNumber(cursorRowInWindow, 0, visibleInput.length - 1);
  const cursorColumn = input.inputCursor - (inputRows[inputCursorRow]?.start ?? 0);
  const row = inputStart + clampedRow + 1;
  const col = inputPrefixWidth + cursorColumn + 1;

  return {
    lines,
    chatHeight,
    maxScrollOffset,
    cursor: { row, col },
  };
}
