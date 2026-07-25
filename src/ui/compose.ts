/**
 * Width measurement, span-wise fitting, the priority fitter and the single
 * place that turns lines into ANSI (Bauplan 2.4, rules R2 and R3).
 */

import type { Line, Span } from "./spans.js";
import { paintSpan, type Theme } from "./theme.js";

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    // emoji skin tone modifiers attach to the preceding base
    (code >= 0x1f3fb && code <= 0x1f3ff)
  );
}

function isWide(code: number): boolean {
  if (code >= 0x1f1e6 && code <= 0x1f1ff) {
    // regional indicators: a flag pair renders in two cells, one each
    return false;
  }
  if (code >= 0x1f300 && code <= 0x1faff) return true;
  if (code === 0x1f004 || code === 0x1f0cf) return true;
  if (code >= 0x1f200 && code <= 0x1f2ff) return true;
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  );
}

interface Cluster {
  text: string;
  width: number;
}

/**
 * Splits into rendering clusters: a base character plus everything that binds
 * to it (combining marks, variation selectors, skin tones, ZWJ partners).
 */
function clusters(value: string): Cluster[] {
  const out: Cluster[] = [];
  let joinNext = false;
  const attach = (character: string): void => {
    const last = out[out.length - 1];
    if (last) last.text += character;
    else out.push({ text: character, width: 0 });
  };
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (ZERO_WIDTH.has(code)) {
      attach(character);
      joinNext = code === 0x200d;
      continue;
    }
    if (joinNext || isCombining(code)) {
      joinNext = false;
      attach(character);
      continue;
    }
    out.push({ text: character, width: isWide(code) ? 2 : 1 });
  }
  return out;
}

/**
 * Terminal cells a string occupies. Handles CJK, combining marks, variation
 * selectors, skin tone modifiers, regional indicators and ZWJ sequences —
 * everything joined by U+200D counts once.
 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const cluster of clusters(value)) {
    width += cluster.width;
  }
  return width;
}

/** Cuts a string to at most `width` cells, never splitting a cluster apart. */
function cutText(value: string, width: number): { text: string; used: number } {
  if (width <= 0) return { text: "", used: 0 };
  let used = 0;
  let text = "";
  for (const cluster of clusters(value)) {
    if (used + cluster.width > width) break;
    text += cluster.text;
    used += cluster.width;
  }
  return { text, used };
}

export function spansWidth(spans: readonly Span[]): number {
  let total = 0;
  for (const item of spans) {
    total += displayWidth(item.text);
  }
  return total;
}

/**
 * Hard-cuts spans to `width`, appending the ellipsis glyph. ANSI-free: works
 * on the span model, never on rendered strings.
 */
export function fitSpans(
  spans: readonly Span[],
  width: number,
  ellipsis = "…",
): Span[] {
  if (width <= 0) return [];
  const total = spansWidth(spans);
  if (total <= width) return spans.map((item) => ({ ...item }));

  const markWidth = displayWidth(ellipsis);
  if (width <= markWidth) {
    const cut = cutText(ellipsis, width);
    return cut.text ? [{ text: cut.text, role: "muted" as const }] : [];
  }

  const budget = width - markWidth;
  const out: Span[] = [];
  let used = 0;
  let lastRole: Span["role"] = "muted";
  for (const item of spans) {
    if (used >= budget) break;
    const itemWidth = displayWidth(item.text);
    lastRole = item.role;
    if (used + itemWidth <= budget) {
      out.push({ ...item });
      used += itemWidth;
      continue;
    }
    const cut = cutText(item.text, budget - used);
    if (cut.text) {
      out.push({ ...item, text: cut.text });
      used += cut.used;
    }
    break;
  }
  out.push({ text: ellipsis, role: lastRole });
  return out;
}

export interface Segment {
  spans: Span[];
  /** Shorter but still complete form. */
  compact?: Span[];
  align: "left" | "right";
  /** Higher survives longer. */
  priority: number;
}

export interface ComposeOptions {
  /** Filler between two neighbouring segments of the same side. */
  gap?: string;
  ellipsis?: string;
}

interface Chosen {
  spans: Span[];
  align: "left" | "right";
}

function assemble(chosen: Chosen[], width: number, gap: string): Line | null {
  const left = chosen.filter((item) => item.align === "left");
  const right = chosen.filter((item) => item.align === "right");
  const gapWidth = displayWidth(gap);
  const leftWidth =
    left.reduce((sum, item) => sum + spansWidth(item.spans), 0) +
    Math.max(0, left.length - 1) * gapWidth;
  const rightWidth =
    right.reduce((sum, item) => sum + spansWidth(item.spans), 0) +
    Math.max(0, right.length - 1) * gapWidth;
  const between = left.length > 0 && right.length > 0 ? 1 : 0;
  if (leftWidth + rightWidth + between > width) return null;

  const spans: Span[] = [];
  left.forEach((item, index) => {
    if (index > 0) spans.push({ text: gap, role: "text" });
    spans.push(...item.spans);
  });
  if (right.length > 0) {
    const pad = width - leftWidth - rightWidth;
    if (pad > 0) spans.push({ text: " ".repeat(pad), role: "text" });
    right.forEach((item, index) => {
      if (index > 0) spans.push({ text: gap, role: "text" });
      spans.push(...item.spans);
    });
  }
  return { spans };
}

/**
 * Priority fitter (R3): never shorten, leave out. In order —
 * (1) everything in full form, (2) ascending priority replaced by `compact`,
 * (3) ascending priority dropped entirely, (4) only a single remaining
 * segment may be cut with an ellipsis.
 */
export function composeLine(
  segments: readonly Segment[],
  width: number,
  options: ComposeOptions = {},
): Line {
  const gap = options.gap ?? "  ";
  const ellipsis = options.ellipsis ?? "…";
  if (width <= 0) return { spans: [] };

  const order = segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) =>
      a.segment.priority === b.segment.priority
        ? a.index - b.index
        : a.segment.priority - b.segment.priority,
    );

  const live = segments.map((segment) => ({
    segment,
    spans: segment.spans,
    dropped: false,
  }));

  const build = (): Line | null =>
    assemble(
      live
        .filter((item) => !item.dropped)
        .map((item) => ({ spans: item.spans, align: item.segment.align })),
      width,
      gap,
    );

  let result = build();
  if (result) return result;

  for (const { index } of order) {
    const entry = live[index]!;
    if (entry.segment.compact) {
      entry.spans = entry.segment.compact;
      result = build();
      if (result) return result;
    }
  }

  let remaining = live.filter((item) => !item.dropped).length;
  for (const { index } of order) {
    if (remaining <= 1) break;
    live[index]!.dropped = true;
    remaining -= 1;
    result = build();
    if (result) return result;
  }

  const last = live.find((item) => !item.dropped);
  if (!last) return { spans: [] };
  return { spans: fitSpans(last.spans, width, ellipsis) };
}

/** The single place in the project that produces ANSI. Last stop before stdout. */
export function renderLines(lines: readonly Line[], theme: Theme): string[] {
  return lines.map((item) => {
    let out = "";
    for (const part of item.spans) {
      out += paintSpan(theme, part);
    }
    return out;
  });
}

/** Greedy word wrap that keeps roles intact. */
export function wrapSpans(spans: readonly Span[], width: number): Line[] {
  if (width <= 0) return [{ spans: [] }];
  const lines: Line[] = [];
  let current: Span[] = [];
  let used = 0;

  const flush = (): void => {
    lines.push({ spans: current });
    current = [];
    used = 0;
  };

  for (const item of spans) {
    const pieces = item.text.split(/(\s+)/).filter((piece) => piece.length > 0);
    for (const piece of pieces) {
      const pieceWidth = displayWidth(piece);
      const blank = /^\s+$/.test(piece);
      if (blank) {
        if (used > 0 && used + pieceWidth <= width) {
          current.push({ ...item, text: piece });
          used += pieceWidth;
        }
        continue;
      }
      if (used + pieceWidth <= width) {
        current.push({ ...item, text: piece });
        used += pieceWidth;
        continue;
      }
      if (used > 0) flush();
      if (pieceWidth <= width) {
        current.push({ ...item, text: piece });
        used = pieceWidth;
        continue;
      }
      let rest = piece;
      while (rest.length > 0) {
        const cut = cutText(rest, width);
        if (!cut.text) break;
        current.push({ ...item, text: cut.text });
        used = cut.used;
        rest = rest.slice(cut.text.length);
        if (rest.length > 0) flush();
      }
    }
  }
  if (current.length > 0 || lines.length === 0) flush();
  return lines;
}
