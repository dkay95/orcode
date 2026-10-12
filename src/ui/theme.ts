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
  | "interject"
  | "ok"
  | "unverified"
  | "failed"
  | "warn"
  | "diffAdd"
  | "diffDel"
  | "quoteGutter"
  | "scrollUp"
  | "scrollDown"
  | "scrollLeft"
  | "scrollRight"
  | "disclosureUp"
  | "disclosureDown"
  | "bullet"
  | "bulletOff"
  | "separator"
  | "chevron"
  | "emdash"
  | "ellipsis"
  | "multiply"
  | "plus"
  | "mask"
  | "boxTopLeft"
  | "boxTopRight"
  | "boxBottomLeft"
  | "boxBottomRight"
  | "boxH"
  | "boxV";

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
  userGutter: ">",
  assistantGutter: "● ",
  toolHead: "●",
  diffHead: "±",
  blockEdge: "│",
  blockFoot: "⎿",
  divider: "─",
  marker: "❯",
  spinner: "✻✽✶✳✢·",
  interject: "↪",
  ok: "✓",
  unverified: "~",
  failed: "✗",
  warn: "⚠",
  diffAdd: "+",
  diffDel: "-",
  quoteGutter: "▏",
  scrollUp: "↑",
  scrollDown: "↓",
  // F6 (settings two-pane navigation): the horizontal pair of `scrollUp`/
  // `scrollDown`, for surfaces whose footer has to name a second, sideways
  // axis (Settings' category pane). Same one-cell width contract as the
  // vertical pair, so a footer budget measured in cells stays glyph-mode
  // independent.
  scrollLeft: "←",
  scrollRight: "→",
  // V4-A (zone anatomy, owner-approved mockup "Screen-Anatomie"): "there is
  // more of this list in that direction". The overflow disclosure used to
  // borrow `scrollUp`/`scrollDown` — the SAME glyph the action bar prints as
  // the NAME OF A KEY (`↑↓ select`). One look, two meanings, which is exactly
  // what the five-level rule ("one look per meaning, one meaning per look",
  // `ui/zones.ts`) forbids: the arrows now mean "the arrow keys" and nothing
  // else, and the triangles mean "content lies this way" and nothing else.
  // Width-matched like every other pair here (`ui-theme.test.ts`): one cell in
  // both charsets. The ASCII pair is `^`/`v`, which is what `scrollUp`/
  // `scrollDown` also asciify to — unavoidable and harmless, because in ASCII
  // glyph mode the two never share a line position (a chip's key sits at the
  // head of a chip, the disclosure at the tail of a counter).
  disclosureUp: "▴",
  disclosureDown: "▾",
  bullet: "●",
  // FIX-14 ticket 8: `bullet`'s counterpart — "one of these alternatives,
  // and this is NOT the live one". The plain `/approvals`, `/chat list` and
  // `/chat search` rows used to print a raw `○` beside a themed `●`, so in
  // ASCII glyph mode the live marker asciified and the inactive one kept
  // emitting a non-ASCII byte. Single cell in both charsets, like every
  // other pair here.
  bulletOff: "○",
  separator: " · ",
  // The command palette's group crumb (`Commands › cross`, F2) — a join
  // delimiter like `separator`, spaces baked in for direct concatenation.
  chevron: " › ",
  // The palette's no-match recovery line (F2): sets the failed-query clause
  // off from the recovery instructions that follow it.
  emdash: "—",
  ellipsis: "…",
  // D3 (owner design batch, 2026-08): the repeat counter's own operator
  // (` × N`) — also closes the F8 residue item ("× exists raw in
  // render-frame/settings-frame"): those two dimension messages
  // (`MIN_WIDTH×MIN_HEIGHT`) now route through this glyph too, instead of
  // a literal `×` that never asciified.
  multiply: "×",
  // K11 (FIX-5 ruling 5): the "create one" affordance the chat pickers put in
  // front of their rows. Both charsets carry the plain ASCII `+` on purpose —
  // the literal this glyph replaces was the FULLWIDTH `＋` (U+FF0B), which
  // `displayWidth` correctly measures as two cells while every layout around
  // it assumed one, so the row bled a column past its box. Every glyph pair
  // in this inventory is width-matched (`ui-theme.test.ts`); there is no
  // single-cell unicode plus that reads better than `+`, so the pair is
  // deliberately identical rather than decorative-and-wrong.
  plus: "+",
  mask: "•",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  boxH: "─",
  boxV: "│",
});

const ASCII_GLYPHS: Readonly<Record<GlyphName, string>> = Object.freeze({
  userGutter: ">",
  // FIX-21 (visual audit 2026-08-28, finding 3): the answer gutter used to
  // be `* `, the same mark the tool head uses — and both sit in column 0 of
  // the transcript, one under the other, so in ASCII an answer and a tool
  // call were the same shape in the same place. Colour was carrying the
  // distinction, which is exactly what the iron rule forbids. `-` is the
  // audit's own suggested pair (`>` was not available: that is the USER
  // gutter, the one thing an answer must never be confused with). The other
  // `-` glyphs never land in column 0 of a transcript row: `divider` is a
  // full-width rule, `emdash` is inline in prose, and `diffDel` sits behind
  // a `blockEdge` and a line number inside a diff body.
  assistantGutter: "- ",
  toolHead: "*",
  diffHead: "~",
  blockEdge: "|",
  // FIX-21 finding 3: the `⎿` elbow used to fall back to a BACKTICK, which
  // reads as debris — a stray quote character at the head of a result line,
  // not a piece of structure. `⎿` is geometrically a bottom-left corner,
  // and this inventory already renders bottom-left corners as a single
  // ASCII character (`boxBottomLeft`), so the fallback follows the same
  // idea: `L` is the `|_` family compressed into the one cell the
  // width-parity contract allows (`ui-theme.test.ts` — the ASCII pair must
  // occupy exactly as many cells as the unicode glyph, so `+-`/`|_`
  // themselves cannot be used). The other one-cell candidates are taken by
  // meanings that render right next to this one: `+` is `ok`/`diffAdd` (the
  // outcome glyph printed immediately after this elbow — `+ + read 12
  // lines`), and `\` is a spinner frame one line above it.
  blockFoot: "L",
  divider: "-",
  marker: ">",
  spinner: "-\\|/",
  interject: "~",
  ok: "+",
  unverified: "~",
  failed: "x",
  warn: "!",
  diffAdd: "+",
  diffDel: "-",
  quoteGutter: "|",
  scrollUp: "^",
  scrollDown: "v",
  scrollLeft: "<",
  scrollRight: ">",
  // See the unicode pair above for why these exist separately from
  // `scrollUp`/`scrollDown`.
  disclosureUp: "^",
  disclosureDown: "v",
  bullet: "*",
  // `o` against `bullet`'s `*`: the two must read apart at a glance in a
  // column of rows where only one is live, and every other single-cell
  // ASCII shape in this inventory is already spoken for.
  bulletOff: "o",
  separator: " - ",
  chevron: " > ",
  emdash: "-",
  // F6 ellipsis width contract: the unicode `…` is exactly one cell, so its
  // ASCII pair must also be one cell — a `.` reads as truncation just as
  // clearly as `...` in a monospaced, glyph-driven UI and keeps every
  // ellipsis-aware width calculation identical across glyph modes.
  ellipsis: ".",
  multiply: "x",
  plus: "+",
  mask: "*",
  boxTopLeft: "/",
  boxTopRight: "\\",
  boxBottomLeft: "\\",
  boxBottomRight: "/",
  boxH: "-",
  boxV: "|",
});

/**
 * The product has exactly ONE accent hue.
 *
 * FIX-21 (visual audit 2026-08-28, finding 2): it used to have two. `accent`
 * resolved to ansi256 172 (#d78700) on the dashboard and the command menu,
 * while `active` resolved to ansi256 214 (#ffaf00) — and `active` is what
 * the Settings surface paints its selected row, its title status and every
 * spinner with. Same meaning ("this is the emphasised thing"), two looks,
 * and the two surfaces sit one keystroke apart. Level 1 had already
 * collapsed both onto plain `yellow`, so the split was never a designed
 * distinction — only truecolor and 256-colour terminals ever saw it.
 *
 * `active` stays a separate ROLE (R1: meaning is set at span creation, and
 * "the live/selected one" is a real, separately greppable meaning) but is
 * pinned to the accent hue at every level. One accent, one look, on every
 * surface; `ui-theme.test.ts` holds that as a tripwire.
 */
const ACCENT_HEX = "#e8890c";
const ACCENT_ANSI256 = 172;

/** Truecolor value per role; `null` means "no foreground code, ever". */
const HEX: Readonly<Record<Role, string | null>> = Object.freeze({
  text: null,
  muted: "#8b949e",
  structure: "#4b5563",
  accent: ACCENT_HEX,
  active: ACCENT_HEX,
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
  accent: ACCENT_ANSI256,
  active: ACCENT_ANSI256,
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
  accent: "yellow",
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
 * The env-driven colour level — the value `createTheme()` uses whenever the
 * caller does not pass an explicit one.
 *
 * chalk is still the detector for everything it actually implements
 * (`FORCE_COLOR`, the `--color`/`--no-color` argv flags, CI, `TERM`,
 * `COLORTERM`, TTY-ness), so this is deliberately not a second sniffer. It
 * adds exactly ONE rule chalk does not have: `NO_COLOR`.
 *
 * FIX-21 (visual audit 2026-08-28, finding 1). This file's header used to
 * claim "chalk already evaluates `NO_COLOR`". It does not, and has not for
 * the whole chalk 5 line: its vendored `supports-color` reads `FORCE_COLOR`
 * and the argv flags only — `grep -c NO_COLOR
 * node_modules/chalk/source/vendor/supports-color/index.js` returns 0. On a
 * non-TTY (every in-process test, every pipe) the level is 0 for an
 * unrelated reason, which is why the defect stayed invisible; driven over a
 * real PTY with `TERM=xterm-256color` and `NO_COLOR=1`, `new Chalk().level`
 * came back as 2 and the whole UI kept emitting 256-colour SGR at a user who
 * had asked for none.
 *
 * Precedence follows Node's own (it warns "'NO_COLOR' env is ignored due to
 * 'FORCE_COLOR' env being set"): a present `FORCE_COLOR` wins outright and
 * the decision is handed back to chalk unchanged. Otherwise a `NO_COLOR`
 * that is set and non-empty forces level 0 — the no-color.org contract, and
 * the same "present but empty proves nothing" caveat `ui-theme.test.ts`
 * already documents for `FORCE_COLOR`.
 */
function detectColorLevel(env: NodeJS.ProcessEnv): ColorLevel {
  const detected = new Chalk().level as ColorLevel;
  if ("FORCE_COLOR" in env) return detected;
  const noColor = env.NO_COLOR;
  return typeof noColor === "string" && noColor.length > 0 ? 0 : detected;
}

/**
 * Builds a theme. `level` defaults to `detectColorLevel()` above — chalk's
 * own `FORCE_COLOR`/`TERM`/TTY detection plus the `NO_COLOR` rule chalk is
 * missing, so there is still exactly one sniffer in the project.
 *
 * An explicitly passed `level` is a caller-side override, not an
 * environment read: only tests and `TerminalUi`'s theme factory (`tui.ts`,
 * which re-uses the level of an already-detected theme) pass one, so every
 * production path resolves through the detection above and honours
 * `NO_COLOR`.
 */
export function createTheme(options: ThemeOptions = {}): Theme {
  const level = (options.level ?? detectColorLevel(process.env)) as ColorLevel;
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
