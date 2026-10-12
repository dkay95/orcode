/**
 * V4 screen anatomy — the zone primitives (owner-approved mockup
 * "V4 Screen-Anatomie", ratified 2026-08-29; plan section "V4:
 * Screen-Anatomie", lane V4-A).
 *
 * The owner's finding was not "the colours are wrong" but "every screen is
 * one flat plane — same colour everywhere, you never know where you are or
 * what to press". The answer is ANATOMY: every interactive screen answers
 * three questions in three fixed zones, built from nothing but terminal
 * characters and the roles `theme.ts` already has.
 *
 *   Zone 1  Where am I?      the title bar — one inverse line carrying a
 *                            breadcrumb, the screen's ONLY loud line.
 *   Zone 2  What do I see?   content with real hierarchy — the five
 *                            emphasis levels below.
 *   Zone 3  What can I do?   the action bar — key chips, key bright,
 *                            effect muted beside it.
 *   Zone 4  Status           the existing always-on identity line
 *                            (`render-frame.ts`), untouched by this module.
 *
 * This module owns zones 1 and 3 and the level vocabulary. It is a thin
 * layer over `spans.ts`/`theme.ts`, never a second rendering system: it
 * produces ordinary `Line`s that `composeLine`/`renderLines`/`fitFrameLine`
 * handle exactly like every other line in the product.
 *
 * IRON RULES honoured here:
 * - No background colours, at any level. The bar is the `inverse` ROLE,
 *   which is the sanctioned equivalent and the same mechanism D1's
 *   `fillSelectionBar` (list-core.ts) already uses.
 * - `chalk` stays in `theme.ts`; this module only names roles.
 * - At colour level 0 (NO_COLOR, a pipe, a dumb terminal) SHAPE carries
 *   everything: the bar degrades to the divider rule it replaced, the chips
 *   grow square brackets. Nothing is signalled by colour alone.
 */

import { span, type Line, type Role, type Span, type SpanAttributes } from "./spans.js";
import { displayWidth, fitSpans } from "./compose.js";
import type { Theme } from "./theme.js";

// ---------------------------------------------------------------------------
// The five emphasis levels (mockup: "Die fünf Ebenen — Hierarchie statt
// Farbsuppe").
// ---------------------------------------------------------------------------

/**
 * `3b` is deliberately not `4`: it is a SUB-level of 3 (both are the row's
 * own content, one naming a thing and one stating its value) and renumbering
 * it would silently renumber the mockup's own table.
 */
export type EmphasisLevel = "1" | "2" | "3" | "3b" | "4" | "5";

export interface EmphasisSpec {
  readonly role: Role;
  readonly bold: boolean;
  /** What this look is ALLOWED to mean. One meaning per look — see `EMPHASIS`. */
  readonly meaning: string;
}

/**
 * The rule the mockup states in one line: "one look per meaning, one meaning
 * per look". These six rows are the whole vocabulary an adopted surface may
 * use for emphasis; anything outside it (`ok`, `warn`, `danger`, `add`,
 * `del`) is the honesty layer, which is orthogonal and untouched — a warning
 * keeps its warn role AND its words on top of whatever level it sits at.
 *
 * No new colour tokens: every role here already existed, and FIX-21 already
 * collapsed the product onto ONE accent hue, so levels 2 and 3b are the same
 * hue separated by weight — exactly as the mockup draws them.
 *
 * Level 1 is capped at ONE line per screen. That cap is why V4 moves the
 * picker/palette selection from D1's inverse bar to level 2: a screen with a
 * title bar AND an inverse selection row has two "loudest" lines and the
 * landmark stops working. `list-core.ts`'s `buildListLines` says the same
 * thing at its own site; the hub, which has no title bar, keeps its bar.
 */
export const EMPHASIS: Readonly<Record<EmphasisLevel, EmphasisSpec>> = Object.freeze({
  "1": {
    role: "inverse",
    bold: false,
    meaning: "orientation: the title bar's breadcrumb — exactly one line per screen",
  },
  "2": {
    role: "accent",
    bold: true,
    meaning: "the emphasised thing here: a section heading, or the active selection",
  },
  "3": { role: "text", bold: true, meaning: "names and primary text" },
  "3b": { role: "accent", bold: false, meaning: "values and numbers" },
  "4": { role: "muted", bold: false, meaning: "explanations, descriptions, hints" },
  "5": {
    role: "structure",
    bold: false,
    meaning: "structure: rules, counters, chrome that should be nearly invisible",
  },
});

/** One span at the named level. The one place a level turns into a role. */
export function emphasize(level: EmphasisLevel, text: string): Span {
  const spec = EMPHASIS[level];
  const attrs: SpanAttributes | undefined = spec.bold ? { bold: true } : undefined;
  return span(text, spec.role, attrs);
}

// ---------------------------------------------------------------------------
// Zone 1 — the title bar.
// ---------------------------------------------------------------------------

/**
 * `Commands › Models › cross` — the crumb text, joined through the theme's
 * own `chevron` glyph so ASCII glyph mode never leaks a `›`.
 *
 * A caller that already owns a joined crumb string (the command palette:
 * `projectCommandMenu`'s `breadcrumb`, which is the source of truth for
 * palette path text) passes it straight through as a single-element path —
 * V4 upgrades that crumb's RENDERING, it does not grow a second crumb.
 */
export function crumbText(theme: Theme, crumb: string | readonly string[]): string {
  return typeof crumb === "string" ? crumb : crumb.filter(Boolean).join(theme.glyph("chevron"));
}

export interface TitleBarOptions {
  /**
   * Cells the bar should fill. Omitted where the caller genuinely has no
   * width (a printed, non-fullscreen view such as `/context`, which writes
   * into the scrolling transcript): the bar then hugs its own text and is
   * still the one inverse line of that view.
   */
  readonly width?: number;
}

/**
 * Zone 1: ONE inverse line carrying the breadcrumb — the screen's only loud
 * line, so it reads as a landmark.
 *
 * Colour level 0 degrades to the divider rule this bar replaces
 * (`─ Commands › Models`, the exact shape `dashboard-frame.ts`'s old
 * `listChrome` drew): `inverse` collapses to plain text at level 0
 * (`theme.ts`'s `base()`), so a padded bar there would be an unexplained run
 * of trailing spaces instead of a landmark. Shape carries the meaning where
 * colour cannot — the iron rule, and the same trick the chips below use.
 */
export function titleBarLine(
  theme: Theme,
  crumb: string | readonly string[],
  options: TitleBarOptions = {},
): Line {
  const text = crumbText(theme, crumb);
  const width = options.width;
  // V4-C finding: a title the bar cannot hold (a user-controlled crumb like
  // `Multiple chats match "<query>"`) used to pad-but-never-cut, so the one
  // line the zone contract promises soft-wrapped — and a wrapped line breaks
  // every cursor-up repaint below it (the FIX-19/20 debris class). The
  // primitive fits itself, so EVERY consumer holds the one-line contract —
  // including the plain picker, which has no frame-level fitter of its own.
  if (theme.level === 0) {
    const spans = [emphasize("5", `${theme.glyph("divider")} `), emphasize("4", text)];
    return {
      spans: width !== undefined && displayWidth(`${theme.glyph("divider")} ${text}`) > width
        ? fitSpans(spans, width, theme.glyph("ellipsis"))
        : spans,
    };
  }
  const bar = ` ${text} `;
  if (width === undefined || displayWidth(bar) <= width) {
    const padding = width !== undefined ? Math.max(0, width - displayWidth(bar)) : 0;
    return { spans: [emphasize("1", `${bar}${" ".repeat(padding)}`)] };
  }
  return { spans: fitSpans([emphasize("1", bar)], width, theme.glyph("ellipsis")) };
}

// ---------------------------------------------------------------------------
// Zone 3 — the action bar.
// ---------------------------------------------------------------------------

/** One key chip: the key, and what it does to THIS screen right now. */
export interface ActionChip {
  /** Already theme-expanded (`↑↓`/`^v`) — see `keymap.ts`'s `shortcutKeys`. */
  readonly key: string;
  /** One lowercase word, English, from the surface's own truth. */
  readonly effect: string;
  /**
   * Higher survives longer when the bar has to shed (see `width` below).
   * Same convention as `compose.ts`'s `Segment.priority`. Defaults to 0.
   */
  readonly priority?: number;
}

export interface ActionBarOptions {
  /**
   * Prefixes the theme's divider glyph, closing the block from below the way
   * D1 ruling 4's palette footer already did. Only the palette (whose bar
   * sits directly under its rows, inside the expansion area) sets this; a bar
   * rendered as the frame's help row sits below the composer and needs no
   * boundary of its own.
   */
  readonly leadingDivider?: boolean;
  /**
   * Cells the bar has. Given one, chips are shed WHOLE — lowest priority
   * first — until the rest fit, instead of the line being ellipsized.
   *
   * This is FIX-11 addendum ruling A's rule, applied to the bar: a hint is
   * allowed to get shorter, but the KEY is never what disappears. The old
   * `·`-joined footer was one long string, so at 40 columns the frame's
   * width contract cut it mid-chip — `─ ↑↓ select  Enter insert  Tab
   * complet…`, with the way out (`Esc close`) gone entirely, exactly when a
   * narrow terminal makes a reader most likely to need it. A whole chip is
   * dropped or kept; half a chip is never shown.
   */
  readonly width?: number;
}

/**
 * Two spaces — chips are grouped by proximity, never by a `·` chain.
 *
 * Deliberately role `text`, not level 5: a gap carries no meaning, and
 * `structure` is load-bearing elsewhere — `tui.ts`'s `#selectMouseRow` finds
 * the frame's real divider by looking for the LAST line with a structure
 * span, and an action bar rendered below the composer would otherwise
 * impersonate it and break click-to-pick.
 */
const CHIP_GAP = span("  ", "text");

/**
 * Zone 3: `↑↓ select  Enter run  Tab insert  Esc back` — the key in
 * emphasis (level 3), the effect muted beside it (level 4). "Nie wieder
 * raten, ob Enter richtig ist."
 *
 * At colour level 0 the two halves would be indistinguishable, so the key
 * grows square brackets: `[Enter] run`. Shape again, not colour.
 *
 * The chips themselves are never hand-typed at a call site — they come from
 * `keymap.ts`'s `listActionChips`, which reads the keys out of the one
 * keymap table and takes the effect words from whatever the surface already
 * computed (FIX-11's `commandMenuEnterVerb`, FIX-5's back/close split). A
 * chip that could lie is a chip that was built from a second copy of the
 * truth; there is no second copy.
 */
export function actionBarLine(
  theme: Theme,
  chips: readonly ActionChip[],
  options: ActionBarOptions = {},
): Line {
  const bracketed = theme.level === 0;
  const chipWidth = (chip: ActionChip): number =>
    displayWidth(chip.key) + (bracketed ? 2 : 0) + 1 + displayWidth(chip.effect);
  let shown = [...chips];
  if (options.width !== undefined) {
    const lead = options.leadingDivider ? displayWidth(`${theme.glyph("divider")} `) : 0;
    const total = (list: readonly ActionChip[]): number =>
      list.reduce((sum, chip) => sum + chipWidth(chip), 0)
      + Math.max(0, list.length - 1) * displayWidth(CHIP_GAP.text)
      + lead;
    while (shown.length > 1 && total(shown) > options.width) {
      // Lowest priority goes first; ties break toward the leftmost, which is
      // the mockup's least-load-bearing end (the filter hint, then the arrows
      // — both of which a reader can also discover by trying).
      let victim = 0;
      for (let index = 1; index < shown.length; index += 1) {
        if ((shown[index]!.priority ?? 0) < (shown[victim]!.priority ?? 0)) victim = index;
      }
      shown = [...shown.slice(0, victim), ...shown.slice(victim + 1)];
    }
  }
  const spans: Span[] = [];
  if (options.leadingDivider) spans.push(emphasize("5", `${theme.glyph("divider")} `));
  shown.forEach((chip, index) => {
    if (index > 0) spans.push({ ...CHIP_GAP });
    spans.push(emphasize("3", bracketed ? `[${chip.key}]` : chip.key));
    spans.push(emphasize("4", ` ${chip.effect}`));
  });
  return { spans };
}
