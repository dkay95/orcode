/**
 * Colour roles and glyph inventory (Bauplan 2.2 and 2.3).
 *
 * This is the ONLY module in the project that may import `chalk`. Everything
 * else asks the theme for `color(role)`, `glyph(name)` or `level`.
 *
 * Iron rules implemented here:
 * - `text` never gets a foreground code (works on light and dark terminals).
 * - no background colours, in any level.
 * - no background detection, no light/dark switch.
 */

import { Chalk } from "chalk";
import type { Role, Span, SpanAttributes } from "./spans.js";

export type ColorLevel = 0 | 1 | 2 | 3;

export type GlyphName =
  | "userGutter"
  | "assistantGutter"
  | "toolHead"
  | "diffHead"
  | "blockEdge"
  | "blockFoot"
  | "divider"
  | "marker"
  | "spinner"
  | "ok"
  | "unverified"
  | "failed"
  | "warn"
  | "diffAdd"
  | "diffDel"
  | "quoteGutter"
  | "scrollUp"
  | "separator"
  | "ellipsis"
  | "mask";

export interface Theme {
  readonly level: ColorLevel;
  readonly ascii: boolean;
  color(role: Role, attrs?: SpanAttributes): (text: string) => string;
  glyph(name: GlyphName): string;
}

export interface ThemeOptions {
  level?: ColorLevel;
  ascii?: boolean;
}

const UNICODE_GLYPHS: Readonly<Record<GlyphName, string>> = Object.freeze({
  userGutter: "▌",
  assistantGutter: "  ",
  toolHead: "▸",
  diffHead: "±",
  blockEdge: "│",
  blockFoot: "└",
  divider: "─",
  marker: "›",
  spinner: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  ok: "✓",
  unverified: "~",
  failed: "✗",
  warn: "⚠",
  diffAdd: "+",
  diffDel: "-",
  quoteGutter: "▏",
  scrollUp: "↑",
  separator: " · ",
  ellipsis: "…",
  mask: "•",
});

const ASCII_GLYPHS: Readonly<Record<GlyphName, string>> = Object.freeze({
  userGutter: ">",
  assistantGutter: "  ",
  toolHead: "*",
  diffHead: "~",
  blockEdge: "|",
  blockFoot: "`",
  divider: "-",
  marker: ">",
  spinner: "-\\|/",
  ok: "+",
  unverified: "~",
  failed: "x",
  warn: "!",
  diffAdd: "+",
  diffDel: "-",
  quoteGutter: "|",
  scrollUp: "^",
  separator: " - ",
  ellipsis: "...",
  mask: "*",
});

/** Truecolor value per role; `null` means "no foreground code, ever". */
const HEX: Readonly<Record<Role, string | null>> = Object.freeze({
  text: null,
  muted: "#8b949e",
  structure: "#4b5563",
  accent: "#6ea8fe",
  active: "#d9a441",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  add: "#3fb950",
  del: "#f85149",
  inverse: null,
});

const ANSI256: Readonly<Record<Role, number | null>> = Object.freeze({
  text: null,
  muted: 245,
  structure: 240,
  accent: 111,
  active: 179,
  ok: 114,
  warn: 178,
  danger: 203,
  add: 114,
  del: 203,
  inverse: null,
});

type BasicStyle = "dim" | "cyan" | "yellow" | "green" | "red" | null;

const BASIC: Readonly<Record<Role, BasicStyle>> = Object.freeze({
  text: null,
  muted: "dim",
  structure: "dim",
  accent: "cyan",
  active: "yellow",
  ok: "green",
  warn: "yellow",
  danger: "red",
  add: "green",
  del: "red",
  inverse: null,
});

const identity = (text: string): string => text;

/**
 * Builds a theme. `level` defaults to chalk's own detection — chalk already
 * evaluates `NO_COLOR`, `FORCE_COLOR` and `TERM`, so there is no second
 * sniffer anywhere in the project.
 */
export function createTheme(options: ThemeOptions = {}): Theme {
  const detected = new Chalk();
  const level = (options.level ?? (detected.level as ColorLevel)) as ColorLevel;
  const ascii = options.ascii ?? false;
  const glyphs = ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
  const chalk = new Chalk({ level: level === 0 ? 1 : level });
  const cache = new Map<string, (text: string) => string>();

  function base(role: Role): (text: string) => string {
    if (level === 0) return identity;
    if (role === "inverse") return (text) => chalk.inverse(text);
    if (level === 3) {
      const hex = HEX[role];
      return hex === null ? identity : (text) => chalk.hex(hex)(text);
    }
    if (level === 2) {
      const code = ANSI256[role];
      return code === null ? identity : (text) => chalk.ansi256(code)(text);
    }
    const basic = BASIC[role];
    if (basic === null) return identity;
    return (text) => chalk[basic](text);
  }

  function color(role: Role, attrs?: SpanAttributes): (text: string) => string {
    const key = `${role}|${attrs?.bold ? "b" : ""}${attrs?.underline ? "u" : ""}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const paint = base(role);
    let styled = paint;
    if (level > 0 && (attrs?.bold || attrs?.underline)) {
      styled = (text: string) => {
        let value = paint(text);
        if (attrs?.bold) value = chalk.bold(value);
        if (attrs?.underline) value = chalk.underline(value);
        return value;
      };
    }
    cache.set(key, styled);
    return styled;
  }

  return {
    level,
    ascii,
    color,
    glyph: (name: GlyphName) => glyphs[name],
  };
}

/** Current spinner frame — exactly one instance moves anywhere (R7). */
export function spinnerFrame(theme: Theme, tick: number): string {
  const frames = Array.from(theme.glyph("spinner"));
  const index = ((tick % frames.length) + frames.length) % frames.length;
  return frames[index] ?? "";
}

/** Applies a span's role and attributes. Used by `renderLines`. */
export function paintSpan(theme: Theme, item: Span): string {
  if (theme.level === 0 || item.text.length === 0) return item.text;
  return theme.color(item.role, item)(item.text);
}
