/**
 * The one list primitive (Phase F1, `2026-08-27-orcode-v3-interaction-fabric.md`).
 *
 * Every pick-one-of-N surface in orcode — the fullscreen model/choice
 * pickers, the slash command menu, the plain (non-fullscreen) `select`/
 * `search` prompts — shares exactly one data model (`ListEntry`), one
 * fuzzy-filter/scoring function, one set of navigation/multi-select
 * primitives, one key-intent classifier and one render path
 * (`buildListLines` here + `renderLines` in `compose.ts` flattens it to
 * plain ANSI for the non-fullscreen surface). Call-site-specific behavior
 * (tree drill-down, settings-editor resolution, disabled-entry rejection
 * wording, …) stays local to each site — this module only owns the parts
 * that are actually identical everywhere.
 *
 * Picker anatomy: since V4-A the surrounding zones are the shared ones —
 * zone 1 is the title bar and zone 3 the action bar (`ui/zones.ts`), the
 * same two lines every other adopted screen wears. This module owns what is
 * between them: the marker rows with their emphasis levels, the filter line,
 * the overflow counter and the empty state.
 */

import { clampListIndex, listWindow } from "../utils.js";
import { composeLine, displayWidth, type Segment } from "./compose.js";
import { span, spansWidth, type Line, type Span } from "./spans.js";
import type { Theme } from "./theme.js";
import { emphasize } from "./zones.js";

/** One row of the expansion area (Bauplan 2.5) — the one entry shape every picker renders. */
export interface ListEntry {
  readonly name: string;
  readonly description?: string;
  /**
   * FIX-14 fix round 1 (review M1, controller ruling): the description as
   * INDIVISIBLE parts. A part is rendered WHOLE or not at all — never
   * ellipsized into a fragment — and parts are shed from the end until the
   * row fits.
   *
   * It exists because a fragment of some copy is merely unhelpful, while a
   * fragment of a MONEY figure is misleading: the Cross gate's Start row
   * read `est. from $0…` at 40 columns, which a reader can take for "from
   * $0" — free — when the real floor was $0.068. A consent point may show
   * its figure completely or not at all; it may not show a piece of one.
   * That is the same rule the status line's cancel hint already follows,
   * where honesty outranks width.
   *
   * Every other picker leaves this unset and keeps `description`'s existing
   * ellipsizing behaviour exactly: detail cut mid-word costs the reader
   * nothing but detail. `description` should still be set alongside (the
   * joined full text) for callers that are not this renderer.
   *
   * The rule is deliberately UNCONDITIONAL — no part is ever ellipsized,
   * not even the first. A rule that made an exception for "prose" would
   * have to know which part carries the figure, and would break silently
   * the day a caller reorders its parts. The cost is that a row too narrow
   * for even the first part shows no description at all rather than a cut
   * one; at a consent point, showing less is the safe direction.
   */
  readonly descriptionParts?: readonly string[];
  readonly current?: string | boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /**
   * A non-selectable divider row introducing a section (optional sections,
   * `withListSections`). Navigation skips it; it never counts toward the
   * footer's match total.
   */
  readonly sectionHeading?: boolean;
}

/** One named group of entries — optional; no F1 site uses this yet (workspace-mobility Phase F1b is the first consumer), but the shape ships now so the core is presentation-complete for it. */
export interface ListSection {
  readonly heading: string;
  readonly entries: readonly ListEntry[];
}

export interface ListView {
  entries: readonly ListEntry[];
  selectedIndex: number;
  heading?: string;
  breadcrumb?: string;
  /**
   * V4-B: `Current: qwen3.8-max` — what the setting being edited says right
   * now, rendered as one chrome line between the title bar and the rows (the
   * mockup's edit state: "Aktuell: qwen3.8-max"). Only the settings-driven
   * editors set it.
   *
   * It is not a duplicate of the `· active` tag on the current row: that tag
   * is only readable while its row is inside the window, and a model picker
   * opened on a 300-row catalog usually has it off screen. `dashboard-frame`
   * counts it as chrome, so it costs a row from the SAME budget the rows are
   * drawn from and `Frame.listRows` shifts with it — no second geometry.
   */
  currentValue?: string;
  /**
   * A pre-built trailing line appended after the rendered rows — since V4-A
   * the command palette's ACTION BAR (`ui/zones.ts`'s `actionBarLine`, fed
   * from the keymap). Built by the caller, which is the one that knows the
   * theme and the call-site-specific verbs; this module only splices the
   * result in.
   */
  footer?: Line;
  /**
   * Replaces rows AND `footer` entirely with one line — the V3 "never a
   * dead end" empty-result state (`buildListEmptyLine`).
   */
  emptyLine?: Line;
}

/** True when a row can never be the resolved selection (matches every current call site's honesty gate: coming-soon, offline, etc.). */
export function isListEntryDisabled(entry: Pick<ListEntry, "disabled" | "disabledReason" | "sectionHeading">): boolean {
  return entry.disabled === true || Boolean(entry.disabledReason) || entry.sectionHeading === true;
}

/** Flattens named sections into one entries array, each section introduced by a non-selectable heading row. Empty sections are dropped entirely rather than rendering a heading with nothing under it. */
export function withListSections(sections: readonly ListSection[]): ListEntry[] {
  const out: ListEntry[] = [];
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    out.push({ name: section.heading, sectionHeading: true });
    out.push(...section.entries);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filtering — the one fuzzy-scoring function (absorbs tui.ts's former
// `choiceSearchScore`, byte-for-byte behavior-compatible: exact match beats
// prefix match beats substring match; anything else is dropped).
// ---------------------------------------------------------------------------

/**
 * `-1` means "does not match" (drop it); otherwise higher is a better match.
 * `haystack` is whatever extra searchable text the caller wants folded in
 * (e.g. a choice's internal value/id, or a route's raw model id) beyond
 * `name`/`description` — it also counts for the exact/prefix tiers, not
 * just the substring one, matching every current picker's "typing the
 * internal id also finds it" behavior.
 */
export function scoreListEntry(
  entry: Pick<ListEntry, "name" | "description">,
  query: string,
  haystack = "",
): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = (entry.description ?? "").toLowerCase();
  const token = haystack.toLowerCase();
  if (name === q || token === q) return 10_000;
  if (name.startsWith(q) || (token && token.startsWith(q))) return 5_000;
  return `${name} ${description} ${token}`.includes(q) ? 1_000 : -1;
}

/**
 * Filters and ranks `items` by `scoreListEntry`, stable on ties (original
 * order). An empty query returns `items` unchanged — no scoring, no
 * reordering — matching every current picker's "typing nothing shows
 * everything, in catalog order" behavior.
 */
export function filterListEntries<T>(
  items: readonly T[],
  query: string,
  toEntry: (item: T) => Pick<ListEntry, "name" | "description"> & { readonly haystack?: string },
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  return items
    .map((item, index) => {
      const entry = toEntry(item);
      return { item, index, score: scoreListEntry(entry, trimmed, entry.haystack ?? "") };
    })
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// Navigation — shared by the fullscreen model/choice pickers AND the command
// menu's up/down/page stepping (tui.ts `#handleSelectKey` / `#handleCommandMenuKey`).
// ---------------------------------------------------------------------------

/** ↑↓ / PgUp/PgDn step size, matching every current picker (`8` rows per page). */
export const LIST_PAGE_STEP = 8;

/**
 * G3 fix round 1 (m3): the clamp and the window moved to `utils.ts` — the
 * import-free module — so the desktop window's palette follows its selection
 * with the same computation instead of rendering a fixed prefix.
 */
const clampIndex = clampListIndex;

/** Clamped index stepping — the one place every picker/menu computes its next selected row. */
export function stepListIndex(index: number, length: number, delta: number): number {
  return clampIndex(index + delta, length);
}

/**
 * Sections-aware stepping: like `stepListIndex`, but never lands on a
 * `sectionHeading` row — it keeps walking in the step's direction until it
 * clears one (or hits the end, where it stays on the nearest selectable row).
 */
export function stepSelectableListIndex(
  entries: readonly ListEntry[],
  index: number,
  delta: number,
): number {
  if (entries.length === 0) return 0;
  const step = delta === 0 ? 0 : delta > 0 ? 1 : -1;
  let next = clampIndex(index + delta, entries.length);
  let guard = entries.length;
  while (entries[next]?.sectionHeading && guard > 0) {
    const advanced = next + step;
    if (advanced < 0 || advanced >= entries.length) break;
    next = advanced;
    guard -= 1;
  }
  return entries[next]?.sectionHeading ? clampIndex(index, entries.length) : next;
}

// ---------------------------------------------------------------------------
// Multi-select — Space toggles, capped at 5 (every current multi-select
// picker: Settings' panel-models editor).
// ---------------------------------------------------------------------------

export const LIST_MULTI_SELECT_CAP = 5;

export interface MultiSelectResult {
  readonly selected: Set<string>;
  /** True when the toggle was rejected because the cap was already reached (the set is returned unchanged). */
  readonly rejected: boolean;
}

/** Toggles `id` in `selected`, capped at `cap`. Never mutates the input set. */
export function toggleListMultiSelect(
  selected: ReadonlySet<string>,
  id: string,
  cap = LIST_MULTI_SELECT_CAP,
): MultiSelectResult {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
    return { selected: next, rejected: false };
  }
  if (next.size >= cap) return { selected: next, rejected: true };
  next.add(id);
  return { selected: next, rejected: false };
}

// ---------------------------------------------------------------------------
// Key protocol — a pure classifier from a raw keypress to what it means for
// a list. State transitions stay with the caller (a command-menu "escape"
// steps back one browsed path level before it closes; a plain picker
// "escape" always cancels outright) — only the classification is shared.
// ---------------------------------------------------------------------------

export interface ListKeyInput {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export type ListKeyIntent =
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "enter"
  | "escape"
  | "toggle"
  | "tab"
  | "backspace"
  | "none";

/** Classifies a raw keypress. Never looks at typed characters — text editing is the caller's own (already-shared) text-field concern. */
export function interpretListKey(key: ListKeyInput): ListKeyIntent {
  switch (key.name) {
    case "up": return "up";
    case "down": return "down";
    case "pageup": return "pageUp";
    case "pagedown": return "pageDown";
    case "return": return "enter";
    case "escape": return "escape";
    case "space": return "toggle";
    case "tab": return "tab";
    case "backspace": return "backspace";
    default: return "none";
  }
}

// ---------------------------------------------------------------------------
// Render — fullscreen frame lines. Moved verbatim from `dashboard-frame.ts`
// (re-exported there for the handful of existing imports) so pickers AND the
// command menu share one render implementation, grep-provably.
// ---------------------------------------------------------------------------

/**
 * Which slice of `entries` a list of `limit` rows actually shows, and how
 * many rows that is.
 *
 * Fix round 1 (review MAJOR 1), the one-mechanism fix for the class the V4-A
 * report flagged and mis-scoped. `buildListLines` used to compute this inline
 * while `tui.ts`'s `#selectMouseRow` re-derived the SAME geometry from a
 * hand-copied `height >= 20 ? 6 : 4` — a second copy of a budget that is not
 * even the whole formula, because the frame subtracts the list's own chrome
 * (title bar, validation, action bar) from it. V4-A's title bar took one of
 * those rows, the copy did not know, and every click on the fullscreen model
 * picker became a silent no-op (or, with substring model ids, resolved the
 * wrong row).
 *
 * The window is computed HERE, once. `dashboard-frame.ts` reports the result
 * on the frame it returns, so the pointer maps against the geometry the
 * renderer actually used — no formula to keep in sync, and any future zone
 * added above or below the rows shifts both at once.
 */
export { listWindow, type ListWindow } from "../utils.js";

/**
 * The universal counter's TEXT — `4 of 6 · ▾` (V4-A, mockup "Überall-Zähler").
 * `null` whenever the list is wholly on screen: a counter beside a list that
 * hides nothing tells the reader something they can already see (FIX-14
 * ticket 10), and the counter's whole job is FIX-5 ruling 1's "nothing may
 * silently not-exist".
 *
 * `rank` is the cursor's position among the `total` rows the list currently
 * holds, in every state (fix round 1's controller ruling) — one meaning, one
 * look, never re-pointed by a keystroke.
 *
 * Exported so V4-B's Settings rows count themselves with the SAME string this
 * renderer builds, rather than a second `${a} of ${b}` that could drift in
 * word order, separator or marker. The marker pair is `disclosureUp`/
 * `disclosureDown` and never `scrollUp`/`scrollDown`: those are the name of a
 * key on the action bar, and one look may carry only one meaning.
 */
export function listCounterText(
  theme: Theme,
  rank: number,
  total: number,
  hidden: { readonly above: boolean; readonly below: boolean },
): string | null {
  const disclosure = `${hidden.above ? theme.glyph("disclosureUp") : ""}`
    + `${hidden.below ? theme.glyph("disclosureDown") : ""}`;
  if (disclosure.length === 0) return null;
  return `${rank} of ${total}${theme.glyph("separator")}${disclosure}`;
}

/**
 * The expansion area (Bauplan 2.5): the description column lines up with the
 * longest *visible* name, never with a fixed pad width.
 */
export function buildListLines(
  list: ListView,
  width: number,
  limit: number,
  theme: Theme,
): Line[] {
  const entries = list.entries;
  if (entries.length === 0 || limit <= 0) return [];
  const selected = clampIndex(list.selectedIndex, entries.length);
  const { start, rows } = listWindow(entries.length, list.selectedIndex, limit);
  const visible = entries.slice(start, start + rows);
  // Section headings are excluded: since FIX-5 ruling 2 they render as a rule
  // (`─ <Group>`) rather than a padded name, so they no longer occupy the name
  // column and must not stretch it for the rows that do.
  const nameWidth = visible.reduce(
    (widest, entry) => (entry.sectionHeading ? widest : Math.max(widest, displayWidth(entry.name))),
    0,
  );
  // A section heading never counts toward the corner "n of total" label
  // either (same contract as the footer's match total, `ListEntry.sectionHeading`
  // above) — `selectableRank` is the selected row's 1-based position among
  // selectable rows only, not its raw array index.
  const selectableTotal = entries.reduce((count, item) => count + (item.sectionHeading ? 0 : 1), 0);
  const selectableRank = entries
    .slice(0, selected + 1)
    .reduce((count, item) => count + (item.sectionHeading ? 0 : 1), 0);
  // FIX-5 ruling 1 ("nothing may silently not-exist"): whenever the window is
  // a strict subset of `entries`, the last visible row states BOTH facts —
  // which direction the hidden rows lie in (the theme's own scroll glyphs,
  // the same pair the footer's "↑↓ select" hint uses) and where the cursor
  // sits among the total (`<rank> of <total>`, this module's existing corner
  // label).
  //
  // FIX-14 ticket 10 (FIX-9's parked finding: the "1 of 2" pager on two-row
  // lists). The corner is now drawn EXACTLY when the window is a strict
  // subset — that is, exactly when it has something to disclose. A list that
  // is wholly on screen gets none: "1 of 2" beside two visible rows tells a
  // reader nothing they cannot see, and a pager on an unpaged list is the
  // kind of chrome the audit's "nothing that says nothing" rule is about.
  // Nothing is hidden by this: FIX-5 ruling 1's case is precisely the
  // overflow case, and it is untouched.
  //
  // `ListView.hideInlineTotal` is deleted with the same change. It existed so
  // a caller carrying its own count in `footer` did not print the number
  // twice — which is the no-overflow case, now suppressed for everyone — and
  // it was explicitly forbidden from applying in the overflow case, which is
  // now unconditional. Both of its branches became the default, so the flag
  // had no remaining behaviour to carry.
  const hiddenAbove = start > 0;
  const hiddenBelow = start + rows < entries.length;
  // V4-A (universal counter, mockup: "Überall-Zähler — jede Liste zeigt
  // `N von M · ▾`, sobald etwas außerhalb liegt"). Two deliberate changes to
  // the FIX-5 corner, neither of them to what it MEANS:
  //
  // 1. Word order. The number leads and the direction marker trails, so a
  //    reader parses "how much is there" before "which way the rest lies" —
  //    the mockup's own order, and the same order the palette footer used to
  //    print its count in, which is what makes the two foldable into one.
  // 2. The marker is the `disclosure` glyph pair, not `scrollUp`/`scrollDown`.
  //    Those are the ARROW KEYS now (the action bar prints them as `↑↓
  //    select`), and one look may carry only one meaning (`ui/zones.ts`).
  //
  // Fix round 1, controller ruling on the counter: `N` is the CURSOR'S RANK
  // among the `M` rows the list currently holds — in EVERY state. Browsing
  // ranks among all rows; filtering ranks among the matches, because the
  // matches ARE the rows the list holds once a query is on. One meaning,
  // never re-pointed by a keystroke: "you are at row N of M candidates".
  // The short-lived `ListView.counter` override (which let the palette say
  // `<matches> of <all commands>` — a second meaning under the same look) is
  // deleted with this ruling.
  //
  // FIX-5 ruling 1 ("nothing may silently not-exist") and FIX-14 ticket 10
  // (nothing on a wholly-visible list) are therefore both exactly as they
  // were before this lane: the corner is drawn precisely on overflow.
  const corner = listCounterText(theme, selectableRank, selectableTotal, {
    above: hiddenAbove,
    below: hiddenBelow,
  }) ?? "";
  const showCorner = corner.length > 0;
  return visible.map((entry, index) => {
    // A heading is never selectable (`stepSelectableListIndex` walks past
    // one), so it never wears the selection bar even if a caller's stored
    // index happens to point at it.
    const active = start + index === selected && !entry.sectionHeading;
    // V4-A (five emphasis levels, `ui/zones.ts`), superseding D1 ruling 1's
    // inverse selection bar on THIS renderer. The appearance pin changes; the
    // behaviour does not.
    //
    // D1 translated the V3 mockup's amber selection background onto the
    // `inverse` role because backgrounds are forbidden. V4 spends `inverse`
    // on the title bar instead — "die einzige laute Zeile des Screens", the
    // landmark that answers "where am I", capped at one line per screen. A
    // picker that ALSO paints its selected row inverse has two loudest lines
    // and the landmark stops working, so the selection moves to level 2
    // (accent + bold), which is what the approved V4 frames draw: `❯ Main
    // model  qwen3.8-max  antwortet dir`, one marker, no bar.
    //
    // Nothing is lost at colour level 0: the inverse bar was already
    // invisible there (theme.ts's `base()` collapses every role), so
    // selection read from the `❯` marker alone before this change and reads
    // from it identically after. The hub keeps its own bar
    // (`workbench.ts`'s `actionLine` → `fillSelectionBar`): it carries no
    // title bar, so there the selection IS the screen's one loud line.
    //
    // The per-cell levels are the mockup's row mapping, and they now apply on
    // the active row too instead of being suppressed by the bar: name →
    // level 3 (bold), value → level 3b (accent), description → level 4
    // (muted), and on the selected row the name rises to level 2.
    const nameSpan = (text: string): Span =>
      active ? emphasize("2", text) : emphasize("3", text);
    // FIX-5 ruling 2: a section heading is a RULE, not a row. It borrows the
    // command palette's own enclosure language (D1 ruling 4's `─ Commands ›
    // …` top rule, `dashboard-frame.ts`): the theme's `divider` glyph in the
    // marker column where a selectable row would show `❯`/two spaces, then
    // the heading text — never padded into the name column, never a
    // `current`/`disabledReason` suffix. That leading glyph is what makes it
    // read as non-selectable at colour level 0 too, where every role
    // collapses to plain text and muted-vs-text tells you nothing. V4 raises
    // the text itself from muted (level 4, "an explanation") to level 2
    // ("the emphasised thing here") — the mockup's amber-and-bold `─
    // Cross-Paar`; it shares that look with the active selection and is told
    // apart by shape, exactly as the two are on the mockup's own frames.
    const spans: Span[] = entry.sectionHeading
      ? [
          emphasize("5", `${theme.glyph("divider")} `),
          emphasize("2", entry.name),
        ]
      : [
          active ? emphasize("2", `${theme.glyph("marker")} `) : emphasize("3", "  "),
          nameSpan(entry.name.padEnd(nameWidth)),
        ];
    // FIX-14 ticket 19 (FIX-15's knowingly-paid floor). The row's own
    // compact form: marker + name, unpadded, plus the two suffixes that
    // carry MEANING rather than detail — `current` ("this is the live one")
    // and `disabledReason` ("this one cannot be chosen"). Only the
    // description is given up.
    //
    // FIX-15 accepted the loss this repairs: the root command list pads its
    // name column to the widest visible label, and "Approvals & Costs" is 17
    // columns where "Accounts" was 8, so below roughly 60 columns
    // `composeLine`'s "never shorten, leave out" rule (R3) left out the
    // right-aligned corner — the lower-priority segment. That corner is the
    // overflow disclosure (FIX-5 ruling 1): the one thing on the row that
    // says other rows exist off screen. Losing a row's description at 40
    // columns costs detail; losing the corner costs the fact that there is
    // more. `composeLine` tries `compact` before it drops anything, so
    // supplying one here is exactly the "width-aware shrink" that keeps
    // both.
    const compact: Span[] = entry.sectionHeading
      ? []
      : [
          active ? emphasize("2", `${theme.glyph("marker")} `) : emphasize("3", "  "),
          nameSpan(entry.name),
        ];
    if (!entry.sectionHeading) {
      // FIX-14 fix round 1 (review M1): whole-part shedding. The budget is
      // what the row has left after the marker/name column and, on the row
      // that carries it, the overflow corner — the two things that outrank
      // a description. Parts are taken from the front while they fit whole;
      // the first that does not ends the description, and every later one
      // goes with it. A part is never cut, so a partial figure cannot
      // reach the screen. `composeLine` still owns the final fit (the NAME
      // may ellipsize if even it does not fit) — this only decides which
      // description parts are offered to it.
      const parts = entry.descriptionParts;
      if (parts && parts.length > 0) {
        const cornerCost = index === visible.length - 1 && showCorner
          ? displayWidth(corner) + 1
          : 0;
        let remaining = width - spansWidth(spans) - cornerCost;
        const shown: string[] = [];
        for (const part of parts) {
          const cost = displayWidth(part) + (shown.length === 0 ? 2 : displayWidth(theme.glyph("separator")));
          if (cost > remaining) break;
          remaining -= cost;
          shown.push(part);
        }
        if (shown.length > 0) {
          spans.push(
            emphasize("4", "  "),
            emphasize("4", shown.join(theme.glyph("separator"))),
          );
        }
      } else if (entry.description) {
        spans.push(emphasize("4", "  "), emphasize("4", entry.description));
      }
      if (entry.current) {
        // V4-A level 3b: `current` states a VALUE ("this is the live one",
        // and for a settings row the live one's name), and the mockup puts
        // every value and number on the one accent hue so a reader can tell
        // values from descriptions at a glance. It used to render `ok`
        // (green) — the honesty layer's success colour, spent here on
        // something that is not an outcome. Warnings are unaffected:
        // `disabledReason` below keeps warn AND its words.
        const text = `${theme.glyph("separator")}${typeof entry.current === "string" ? entry.current : "active"}`;
        spans.push(emphasize("3b", text));
        compact.push(emphasize("3b", text));
      }
      if (entry.disabledReason) {
        const text = `${theme.glyph("separator")}${entry.disabledReason}`;
        spans.push(span(text, "warn"));
        compact.push(span(text, "warn"));
      }
    }
    // The compact form is offered ONLY on the row that also carries the
    // corner. With a single segment there is nothing to make room FOR, and
    // `composeLine` prefers a compact form over ellipsizing — which would
    // drop an information-dense row's whole description the moment it ran
    // one column long, instead of cutting it. A heading row likewise has no
    // description to give up.
    const carriesCorner = index === visible.length - 1 && showCorner;
    const segments: Segment[] = [
      {
        spans,
        ...(carriesCorner && !entry.sectionHeading ? { compact } : {}),
        align: "left",
        priority: 100,
      },
    ];
    if (carriesCorner) {
      // V4-A level 5: the counter is structure — "fast unsichtbar" — not an
      // explanation. It was muted (level 4, the description's own look);
      // one look, one meaning.
      segments.push({
        spans: [emphasize("5", corner)],
        align: "right",
        priority: 40,
      });
    }
    // V4-A: no `fillSelectionBar` here any more — see the level-2 note on
    // `nameSpan` above. The bar helper stays exported for the hub, which is
    // the one surface that still owns the screen's single inverse line.
    return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
  });
}

/**
 * Extends a selected row's already-fit line into a real full-width bar
 * (ruling 1's "including the marker column and trailing padding to the
 * list's usable width"). `composeLine`'s own left/right gap filler is
 * always plain role `text` (theme.ts's iron rule — `text` never carries a
 * foreground code, let alone `inverse`), so it would otherwise show as a
 * gap in the middle of the bar whenever the row also carries the
 * right-aligned "n of total" label; recoloring it closes that gap.
 * `composeLine` also only pads BETWEEN a left and a right segment — it
 * never stretches a lone left segment out to the caller's full `width` —
 * so every other selected row (anything but the last, uncounted one) still
 * needs its own trailing pad to reach the bar's right edge.
 *
 * Exported (D8b, the align-the-hub-onto-list-core pass): the hub's own
 * selected-row bar (`workbench.ts`'s `actionLine`) used to hand-copy this
 * exact mechanic rather than import it — the one-list-mechanism constraint
 * D8 wrote up exists precisely to prevent that drift (its own width bug was
 * the first symptom). `workbench.ts` never adopts `ListView`/`buildListLines`
 * wholesale (its row shape — marker/label/hint, no description or "n of
 * total" column — does not fit that pipeline), but the bar-fill step itself
 * is call-site-agnostic: any already-fit `Line` painted uniformly for its
 * active row can go through it unchanged. This function is always called
 * unconditionally, at every colour level including 0 — the caller must NOT
 * skip it at level 0 "to avoid a bar nobody can see": `theme.ts`'s
 * `paintSpan` already collapses `inverse` (and every other role) to
 * plain text at level 0, so the padding bytes are real but invisible on a
 * real terminal, exactly like `buildListLines`'s own active rows above.
 */
export function fillSelectionBar(line: Line, width: number): Line {
  const spans = line.spans.map((item) =>
    item.role === "text" && /^ *$/.test(item.text) ? { ...item, role: "inverse" as const } : item,
  );
  const used = spansWidth(spans);
  if (used < width) spans.push(span(" ".repeat(width - used), "inverse"));
  return { spans };
}

// ---------------------------------------------------------------------------
// List anatomy — the filter line and the empty state.
//
// V4-A deleted the two builders that used to live here beside them.
// `buildListHeaderLine` (`❯─● <Title> · <context>`) is now zone 1, the title
// bar (`ui/zones.ts`'s `titleBarLine`) — the same fact, said the way every
// other screen says it. `buildListFooterLine` is now zone 3, the action bar
// (`ui/zones.ts`'s `actionBarLine`, fed by `keymap.ts`'s `listActionChips`),
// and its four reshaping options went with it: `countLabel`/`hideCount`
// became the one overflow counter above (whose `N` is the cursor's rank in
// every state — fix round 1's ruling), `leadingDivider` became
// `ActionBarOptions.leadingDivider`, and `tabFirst` became nothing at all —
// chip order is the mockup's, everywhere.
// ---------------------------------------------------------------------------

/** `❯ <query>▊` — the filter line; `mask` doubles as the block cursor glyph. */
export function buildListFilterLine(theme: Theme, query: string): Line {
  return {
    spans: [
      span(`${theme.glyph("marker")} `, "muted"),
      span(query, "text"),
      span(theme.glyph("mask"), "muted"),
    ],
  };
}

/**
 * Replaces the whole list body — chrome, rows, and footer alike — with one
 * line: the V3 "never a dead end" empty-result recovery message (the
 * command palette's `✗ No command matches "…" …`, ruling 5). The caller
 * composes `message` (its own copy, its own verbs); this only marks it with
 * the theme's danger glyph.
 */
export function buildListEmptyLine(theme: Theme, message: string): Line {
  return {
    spans: [
      span(`${theme.glyph("failed")} `, "danger"),
      span(message, "muted"),
    ],
  };
}
