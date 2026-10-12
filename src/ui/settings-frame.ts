import type {
  SettingsViewModel,
} from "../settings-controller.js";
import type { SettingsItem } from "../settings-registry.js";
import {
  settingsCrumbParts,
  settingsDisplayRows,
  type SettingsDisplayRow,
} from "../settings-rows.js";
import { composeLine, displayWidth, fitSpans, type Segment } from "./compose.js";
import { buildListFilterLine, listCounterText, listWindow } from "./list-core.js";
import { listActionChips } from "./keymap.js";
import { MIN_HEIGHT, MIN_WIDTH, type Frame } from "./render-frame.js";
import {
  line,
  span,
  spansWidth,
  type Line,
  type Role,
  type Span,
} from "./spans.js";
import type { GlyphName, Theme } from "./theme.js";
import { actionBarLine, crumbText, emphasize, titleBarLine } from "./zones.js";

/**
 * The Settings surface, in V4's three zones (owner-approved mockup "Der
 * Härtefall: Settings vorher/nachher", plan lane V4-B).
 *
 * The mockup's own verdict on what stood here before: "Zwei identische
 * ❯-Cursor, Titel in Textfarbe, Werte in Textfarbe, zwei Drittel Leere —
 * nichts führt." Four things changed together, because each one alone would
 * have made the screen worse:
 *
 *   1. Zone 1 — the title bar (`ui/zones.ts`), carrying ` Settings › Models `.
 *      The screen's ONE loud line, which is why the item pane's own inverse
 *      selection bar had to go in the same breath (V4-A's concern 4): a
 *      screen with two loudest lines has no landmark. The selected row is
 *      level 2 (accent+bold) behind the `❯` mark — exactly what
 *      `list-core.ts`'s pickers do since V4-A.
 *   2. The categories are a TAB BAR, so the second `❯` cursor — the one that
 *      made the arrows ambiguous — is gone rather than merely re-coloured.
 *      The active tab is marked by the theme's live/not-live bullet pair
 *      (`●`/`○`), never by the `❯` a cursor owns.
 *   3. Zone 2 — one dense row per setting, `Name  value  explanation`, at the
 *      mockup's levels (3 / 3b / 4), with `─ <Section>` headings at level 2
 *      where the registry says a category has real groups.
 *   4. Zone 3 — the action bar, chips out of the one keymap table
 *      (`←→ category  ↑↓ row  Enter change  / search  Esc back`). It replaced
 *      `footerLine`, the last of the hand-fitted key lines (the V4-A footer
 *      census's item 6).
 *
 * Iron rules honoured: no background colours (the bar is the `inverse` ROLE),
 * no `chalk` outside `theme.ts`, and at colour level 0 SHAPE carries
 * everything — the bar becomes a rule, the chips grow brackets, the active
 * tab keeps its filled bullet, and a locked row keeps the WORD `Locked`
 * beside its warn role.
 */

export interface SettingsFrameInput {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly view: SettingsViewModel;
}

export interface SettingsFrameResult {
  readonly frame: Frame;
}

/**
 * The one thing orcode 0.7's keyboard-only Settings surface (`tui.ts`'s
 * `#syncMouseReporting` never enables SGR mouse reporting here, so no click
 * can ever reach a settings row) still needs a screen position for:
 * `Frame.cursor`, placed on whichever row is currently selected. V4-B leaves
 * one candidate where F6 had two — the category pane died with the tab bar,
 * so there is no second cursor to prefer between. Rows and columns are
 * one-based.
 */
interface CursorCandidate {
  readonly row: number;
  readonly columnStart: number;
}

/**
 * The row budget's shed order, stated once so the narrow-terminal behaviour
 * is a rule rather than an accident (pinned in `settings-tui.test.ts` and
 * `ui-zone-anatomy-settings.test.ts`):
 *
 *   1. The TITLE BAR is never shed. It is the only line that says where the
 *      reader is, and at the 40×8 floor it is the only line that names the
 *      open category at all.
 *   2. The TAB BAR is never dropped — it only gets more compact
 *      (`TAB_TIERS`), and every category is present in every tier. A dropped
 *      category is a category the reader cannot know exists.
 *   3. The enclosing RULE under the tab bar sheds first, and only if keeping
 *      it would cost the surface its second setting row.
 *   4. At least `MIN_SETTING_ROWS` setting rows survive; whatever does not
 *      fit is disclosed by the counter, never silently absent.
 *   5. The ACTION BAR is the last zone to shed, and it sheds whole CHIPS
 *      (lowest priority first, `Esc` last of all) rather than the line —
 *      below it there is only the notice line, the surface's status.
 */
const MIN_SETTING_ROWS = 2;

/**
 * The narrowest description column the aligned form is worth keeping for. A
 * column below this shows a syllable and an ellipsis, which is not a
 * description — at that point the rows close their padding up and spend the
 * cells on words instead (`aligned`, `renderBody`).
 */
const DESCRIPTION_FLOOR = 12;

/**
 * Cells between the last tab and the state summary (review fix round, F2).
 *
 * It matches the inter-tab gap exactly, and that is the point: anything
 * closer reads as one more tab. At colour level 0 no hue separates the two, so
 * `○5 Appearance Read-only` with a single space genuinely looked like a sixth
 * category named "Appearance Read-only".
 */
const STATUS_GAP = 2;

/** Removes terminal controls while preserving printable Unicode clusters such as ZWJ emoji. */
function safeText(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
}

function safeGlyph(theme: Theme, name: GlyphName, fallback: string): string {
  const value = safeText(theme.glyph(name));
  return displayWidth(value) > 0 ? value : fallback;
}

function dimensions(input: SettingsFrameInput): {
  width: number;
  height: number;
  usableWidth: number;
} {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  const height = Number.isFinite(input.height) ? Math.max(0, Math.floor(input.height)) : 0;
  return { width, height, usableWidth: Math.max(0, width - 1) };
}

function fittedLine(spans: readonly Span[], width: number, ellipsis: string): Line {
  return line(...fitSpans(spans, width, ellipsis));
}

function dividerLine(theme: Theme, width: number, ellipsis: string): Line {
  const divider = safeGlyph(theme, "divider", "-");
  const cellWidth = Math.max(1, displayWidth(divider));
  const repeated = divider.repeat(Math.ceil(width / cellWidth));
  return fittedLine([emphasize("5", repeated)], width, ellipsis);
}

function resizeMessage(theme: Theme): string {
  return `Enlarge window${theme.glyph("separator")}at least ${MIN_WIDTH}${theme.glyph("multiply")}${MIN_HEIGHT}`;
}

function categoryLabelFor(
  view: SettingsViewModel,
  categoryId: SettingsItem["categoryId"],
): string | null {
  const category = view.categories.find((candidate) => candidate.id === categoryId);
  return category ? safeText(category.label) : null;
}

function selectedCategoryLabel(view: SettingsViewModel): string {
  return categoryLabelFor(view, view.selectedCategoryId) ?? "Settings";
}

// ---------------------------------------------------------------------------
// Zone 1 — the title bar.
// ---------------------------------------------------------------------------

/**
 * ` Settings › Models `, or ` Settings › Search ` while the query owns the
 * keyboard — the crumb grows one step deeper the moment the reader opens an
 * editor (`tui.ts` hands the picker `Settings › Models › Main model`), which
 * is the mockup's "Beim Editieren wächst die Brotkrume mit".
 *
 * The compact brand mark that used to sit on this line is deliberately gone.
 * It is the HEADER mark (`appearance.showHeaderMark`), the chat header's own
 * decoration, and repeating a wordmark on a screen whose one loud line exists
 * to answer "where am I" spends the landmark on something that says nothing.
 */
function settingsCrumb(view: SettingsViewModel): string[] {
  // G3: the composition moved to `settings-rows.ts` (import-free) so the
  // desktop window grows the same crumb rather than a lookalike. The
  // sanitization stays here, where the terminal renders.
  return settingsCrumbParts(view).map((part) => safeText(part));
}

/**
 * `Read-only` / `Run active` — the surface-wide honesty state, right-aligned
 * beside the tab bar, widest honest form first.
 *
 * Deliberately NOT inside the title bar: `inverse` collapses every other
 * role, so a warning painted into the loud line would lose its warn colour and
 * keep only its word. The honesty layer stays where it can speak.
 *
 * The compact forms are the shortest spellings that keep the two states APART
 * and keep them true — `Locked` for a config that cannot be written at all,
 * `Running` for a run that locks the rows it affects. Neither invents a claim
 * the full form does not make, and the row-level `Locked · <reason>` text is
 * one glance away for the reason either way.
 */
interface StatusForms {
  readonly role: Role;
  /** Widest first. The last entry is the narrowest form that may still show. */
  readonly forms: readonly string[];
}

function statusForms(input: SettingsFrameInput): StatusForms | null {
  if (input.view.readOnlyReason !== null) {
    return { role: "warn", forms: ["Read-only", "Locked"] };
  }
  if (input.view.runActive) return { role: "active", forms: ["Run active", "Running"] };
  return null;
}

// ---------------------------------------------------------------------------
// The tab bar — the mockup's "Kategorien als Tab-Leiste (aktive fett, Rest
// gedimmt) statt zweiter Cursor-Spalte".
// ---------------------------------------------------------------------------

/**
 * How a tab is spelled, widest form first. The bar renders the WIDEST tier
 * that fits; every tier carries EVERY category, so no width ever drops one
 * silently — a category the reader cannot see is a category they cannot know
 * to press for.
 *
 * What shrinks is the LABEL, and it can shrink to nothing because the title
 * bar directly above always names the open category in full: at the narrowest
 * tier the bar still says how many categories there are, which one is live,
 * and — via the ordinal — the exact key that jumps to each.
 *
 * `composeLine`'s own `compact` tier is not used here on purpose: it offers
 * exactly one alternative form and then DROPS or ellipsizes the segment, and
 * both of those outcomes are the lie this ladder exists to prevent.
 */
const TAB_TIERS = ["labels", "active-label", "ordinals"] as const;
type TabTier = (typeof TAB_TIERS)[number];

function tabSpans(input: SettingsFrameInput, tier: TabTier): Span[] {
  const theme = input.theme;
  // FIX-14 ticket 8's live/not-live pair, and NOT the `❯` marker: `❯` means
  // "the cursor is here", and the second `❯` cursor is precisely what this
  // bar was built to delete. `●`/`○` are width-matched in both charsets, so
  // the ladder's arithmetic is glyph-mode independent, and the filled bullet
  // is what carries the active tab at colour level 0 where bold is gone.
  const live = safeGlyph(theme, "bullet", "*");
  const idle = safeGlyph(theme, "bulletOff", "o");
  const spans: Span[] = [];
  input.view.categories.forEach((category, index) => {
    const active = category.id === input.view.selectedCategoryId
      && !input.view.search.active;
    const label = tier === "ordinals" || (tier === "active-label" && !active)
      ? ""
      : ` ${safeText(category.label)}`;
    if (index > 0) spans.push(span(tier === "ordinals" ? " " : "  ", "text"));
    spans.push(emphasize(active ? "2" : "4", `${active ? live : idle}${index + 1}${label}`));
  });
  return spans;
}

/**
 * The tab bar, or — while the search owns the keyboard — the filter line the
 * reader is actually typing into (`buildListFilterLine`, the palette's own).
 * A search reaches every category at once, so no tab is live and a bar of
 * five inactive tabs would only ask which one the arrows drive; the answer,
 * while searching, is "neither: they walk the query" (F6 ruling 1).
 */
function contextLine(
  input: SettingsFrameInput,
  usableWidth: number,
  ellipsis: string,
): Line {
  // Review fix round, F1 (controller ruling): DISCLOSURE ON THIS LINE MAY ONLY
  // EVER DEGRADE WITH WIDTH. It used to pick the widest tab tier against the
  // whole line and offer the status the remainder as a lower-priority
  // segment, which produced the exact riddle V4 exists to kill: `Run active`
  // showed at 40 columns, vanished from 70 to 80 (full labels are 69 cells,
  // leaving nothing), and came back at 82. Wider terminal, less state.
  //
  // A compact status form alone cannot fix that — the hole is created by the
  // TAB ladder's jump, so at 70 the bar would still eat the whole line. The
  // order of yielding is therefore declared instead:
  //
  //   the status reserves its space FIRST, at the widest form the tab bar's
  //   own floor still allows; the tabs take what is left.
  //
  // That ranks a WARNING above a navigation convenience, which is the iron
  // rule's own order — and the convenience given up is bounded: a compacted
  // tab keeps its bullet and its ordinal (the key that selects it), and the
  // title bar directly above names the open category in full. No category is
  // ever dropped, at any width, in any state.
  //
  // Both channels are monotone by construction: the status room grows with
  // the line, and so does the tab budget. Pinned as a per-width sweep.
  const status = statusForms(input);
  const floor = spansWidth(tabSpans(input, "ordinals"));
  // F2: the gap before the summary is TWO cells, never one. At exact-fit
  // widths a single space made `○5 Appearance Read-only` read as a sixth
  // category at colour level 0, where no hue separates them — the inter-tab
  // gap is two, so anything closer is a tab.
  const statusText = status?.forms.find(
    (form) => floor + STATUS_GAP + displayWidth(form) <= usableWidth,
  );
  const statusWidth = statusText === undefined ? 0 : displayWidth(statusText) + STATUS_GAP;
  const room = Math.max(1, usableWidth - statusWidth);
  const content: Span[] = input.view.search.active
    ? buildListFilterLine(input.theme, safeText(input.view.search.query)).spans
    : tabSpans(input, TAB_TIERS.find(
      (tier) => spansWidth(tabSpans(input, tier)) <= room,
    ) ?? "ordinals");
  return composeLine(
    [
      { spans: fitSpans(content, room, ellipsis), align: "left", priority: 100 },
      ...(statusText === undefined || status === null
        ? []
        : [{
          spans: [span(statusText, status.role)],
          align: "right" as const,
          priority: 90,
        }]),
    ],
    usableWidth,
    { ellipsis },
  );
}

// ---------------------------------------------------------------------------
// Zone 2 — the dense rows.
// ---------------------------------------------------------------------------

/** A rendered line of the body: a section heading, or one setting. */
type DisplayRow = SettingsDisplayRow<SettingsItem>;

/**
 * The body's rows in render order, with a `─ <Section>` heading wherever the
 * registry's section changes (V4-B, `SettingsItem.section`).
 *
 * Headings are suppressed while searching: the results span all five
 * categories, so a category's own grouping says nothing about a list that is
 * not that category — each result row names its category in the explanation
 * column instead, exactly as it did before V4.
 *
 * G3: the RULE moved to `settings-rows.ts` (import-free) so the desktop
 * window groups identically; the sanitization stays here.
 */
function displayRows(view: SettingsViewModel): DisplayRow[] {
  return settingsDisplayRows(view.items, view.search.active).map((row) =>
    row.kind === "heading" ? { kind: "heading", heading: safeText(row.heading) } : row);
}

/** The explanation column: a locked row states its reason instead, in warn AND in words. */
function explanationSpans(input: SettingsFrameInput, item: SettingsItem): Span[] {
  const sep = input.theme.glyph("separator");
  if (item.disabledReason) {
    // The honesty layer sits ON TOP of the level system, never inside it: the
    // reason keeps the `warn` role and keeps the word `Locked`, so at colour
    // level 0 — where every role collapses — the row still says it cannot be
    // changed and why.
    return [span(`Locked${sep}${safeText(item.disabledReason)}`, "warn")];
  }
  const categoryLabel = input.view.search.active
    ? categoryLabelFor(input.view, item.categoryId)
    : null;
  const description = safeText(item.description);
  return [emphasize("4", categoryLabel ? `${categoryLabel}${sep}${description}` : description)];
}

interface RenderedBody {
  readonly lines: readonly Line[];
  readonly cursor: CursorCandidate | null;
}

function renderBody(
  input: SettingsFrameInput,
  rows: readonly DisplayRow[],
  capacity: number,
  usableWidth: number,
  ellipsis: string,
): RenderedBody {
  const theme = input.theme;
  const marker = safeGlyph(theme, "marker", ">");
  if (input.view.items.length === 0) {
    // D5 invitation grammar, unchanged: the settings search's own no-match
    // state names the failed query and the way back to everything.
    const query = input.view.search.active ? input.view.search.query : "";
    const message = query
      ? `No matches for "${query}"${theme.glyph("separator")}clear the search to see every setting.`
      : "No matches";
    return {
      lines: capacity > 0 ? [fittedLine([emphasize("4", message)], usableWidth, ellipsis)] : [],
      cursor: null,
    };
  }
  const selectedRow = rows.findIndex(
    (row) => row.kind === "item" && row.item.id === input.view.selectedItemId,
  );
  const { start, rows: visibleCount } = listWindow(rows.length, Math.max(0, selectedRow), capacity);
  const visible = rows.slice(start, start + visibleCount);

  // The mockup's aligned columns: the value column starts after the widest
  // VISIBLE name, never after a fixed pad — the same rule `buildListLines`
  // uses for its description column, so the two surfaces line up their rows
  // by one shared idea. A heading is a rule, not a row, so it stretches
  // neither column.
  const items = visible.flatMap((row) => (row.kind === "item" ? [row.item] : []));
  const nameWidth = items.reduce(
    (widest, item) => Math.max(widest, displayWidth(safeText(item.label))),
    0,
  );
  const valueWidth = items.reduce(
    (widest, item) => Math.max(widest, displayWidth(safeText(item.displayValue))),
    0,
  );
  // Whether the columns are aligned is decided ONCE for the whole body, never
  // per row: a list where some rows are padded and their neighbours are not
  // is worse than either form, because the eye reads the ragged edge as
  // meaning. Alignment is kept while it leaves a description column worth
  // having; below that the rows close up and spend the cells on words
  // instead. Both forms keep the same order and the same levels, so nothing
  // but the whitespace changes.
  const aligned = 2 + nameWidth + 2 + valueWidth + 2 + DESCRIPTION_FLOOR <= usableWidth;

  // The counter (V4-A's universal `N of M · ▾`, built by the ONE function
  // that builds the palette's and every picker's). `N` is the cursor's rank
  // among the settings the list holds — headings never count, exactly as
  // they never count in `buildListLines`.
  const total = input.view.items.length;
  const rank = input.view.items.findIndex(({ id }) => id === input.view.selectedItemId) + 1;
  const counter = listCounterText(theme, Math.max(1, rank), total, {
    above: start > 0,
    below: start + visibleCount < rows.length,
  });

  let cursor: CursorCandidate | null = null;
  const lines = visible.map((row, index) => {
    const carriesCounter = counter !== null && index === visible.length - 1;
    // The counter's cells are RESERVED on every kind of row, not competed
    // for. `composeLine` drops the lowest-priority segment when a line does
    // not fit, and the counter would always be that segment — yet it is the
    // one thing on the row that says OTHER ROWS EXIST (FIX-5 ruling 1:
    // "nothing may silently not-exist"). A cut description costs detail; a
    // dropped counter costs the knowledge that there is anywhere to scroll
    // to. Only the LAST visible row ever carries it, so at most one row per
    // screen pays.
    const budget = Math.max(1, usableWidth - (carriesCounter ? displayWidth(counter!) + 1 : 0));
    const trailer: Segment[] = carriesCounter
      ? [{ spans: [emphasize("5", counter!)], align: "right", priority: 40 }]
      : [];
    if (row.kind === "heading") {
      // FIX-5 ruling 2's shape, shared with `buildListLines`: a heading is a
      // RULE in the marker column, never a padded name — that leading glyph
      // is what tells it from a selectable row at colour level 0, where
      // level 2 and level 3 look identical.
      //
      // Review fix round, F3: the heading pre-fits to the same reserved
      // budget an item row does. With today's longest heading ("Costs &
      // budgets") the counter could not actually be squeezed out above the
      // 40-column floor, so this was latent — but "reserved, not competed
      // for" has to be true of every row that can carry the counter, or the
      // next long heading quietly makes it false again.
      return composeLine(
        [
          {
            spans: fitSpans(
              [emphasize("5", `${theme.glyph("divider")} `), emphasize("2", row.heading)],
              budget,
              ellipsis,
            ),
            align: "left",
            priority: 100,
          },
          ...trailer,
        ],
        usableWidth,
        { ellipsis },
      );
    }
    const item = row.item;
    const active = item.id === input.view.selectedItemId;
    const name = safeText(item.label);
    const value = safeText(item.displayValue);
    const level = active ? "2" : "3";
    const marked: Span = active ? emphasize("2", `${marker} `) : emphasize("3", "  ");
    const explanation = explanationSpans(input, item);
    // `Name  value  explanation` — the mockup's row, in the mockup's levels.
    // The value column starts at the same cell on every visible row (the
    // aligned column V4-A's minor 4 deferred to this lane), so a reader
    // separates values from prose by POSITION as well as by hue — which is
    // what makes the row legible at colour level 0.
    const spans: Span[] = [
      marked,
      emphasize(level, aligned ? name.padEnd(nameWidth) : name),
      emphasize("3b", `  ${aligned ? value.padEnd(valueWidth) : value}`),
      span("  ", "text"),
      ...explanation,
    ];
    const composed = composeLine(
      [
        { spans: fitSpans(spans, budget, ellipsis), align: "left", priority: 100 },
        ...trailer,
      ],
      usableWidth,
      { ellipsis },
    );
    if (active && spansWidth(composed.spans) > 0) {
      cursor = { row: index, columnStart: 1 };
    }
    return composed;
  });
  return { lines, cursor };
}

// ---------------------------------------------------------------------------
// Zone 3 — the action bar, and the surface's own notice.
// ---------------------------------------------------------------------------

/**
 * `←→ category  ↑↓ row  Enter change  / search  Esc back` — every key looked
 * up in the keymap table, every word the table's own (`listActionChips`).
 * This replaced `footerLine`, the last hand-fitted key line in the product
 * (V4-A's footer census item 6): a `composeLine` of seven muted `hint`
 * segments with their own private `FOOTER_PRIORITY` table, which could — and
 * for a whole release did — advertise a key that no longer existed.
 *
 * While the search owns the keyboard, `←→` walk the query and `/` types a
 * slash into it, so neither chip is offered: a bar that names a key which
 * does something else right now is the exact failure the table was built to
 * end.
 */
function actionBar(input: SettingsFrameInput, usableWidth: number): Line {
  const searching = input.view.search.active;
  return actionBarLine(
    input.theme,
    listActionChips(input.theme, "Settings", {
      ...(searching || input.view.categories.length < 2 ? {} : { horizontal: true as const }),
      ...(searching ? {} : { search: true as const }),
    }),
    { width: usableWidth },
  );
}

function noticeLine(
  input: SettingsFrameInput,
  width: number,
  ellipsis: string,
): Line {
  const notice = input.view.notice;
  if (!notice) return line();
  const [glyphName, fallback, role]: [GlyphName | null, string, Role] =
    notice.kind === "success"
      ? ["ok", "+", "ok"]
      : notice.kind === "error"
        ? ["failed", "x", "danger"]
        : notice.kind === "busy"
          ? ["toolHead", "*", "active"]
          : [null, "i", "text"];
  const glyph = glyphName ? safeGlyph(input.theme, glyphName, fallback) : fallback;
  return fittedLine(
    [span(`${glyph} `, role), span(safeText(notice.message), role)],
    width,
    ellipsis,
  );
}

function tinyFrame(input: SettingsFrameInput, usableWidth: number): SettingsFrameResult {
  const ellipsis = safeGlyph(input.theme, "ellipsis", ".");
  return {
    frame: {
      lines: [fittedLine([span(resizeMessage(input.theme), "warn")], usableWidth, ellipsis)],
      chatHeight: 0,
      cursor: { row: 1, col: 1 },
    },
  };
}

export function buildSettingsFrame(input: SettingsFrameInput): SettingsFrameResult {
  const { width, height, usableWidth } = dimensions(input);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return tinyFrame(input, usableWidth);
  }

  const ellipsis = safeGlyph(input.theme, "ellipsis", ".");
  const lines: Line[] = [];
  lines.push(titleBarLine(input.theme, crumbText(input.theme, settingsCrumb(input.view)), {
    width: usableWidth,
  }));
  lines.push(contextLine(input, usableWidth, ellipsis));

  // The content area: everything above the notice line, the enclosing rule
  // and the action bar. Same three-line tail the surface has always had —
  // only the blank spacer became the mockup's closing rule.
  const contentLimit = Math.max(0, height - 3);
  const rows = displayRows(input.view);
  // Shed rule 3: the rule under the tab bar goes before the second SETTING
  // row does — counted in settings, not in body lines, because a section
  // heading occupies a line without being a row a reader can act on. Above
  // the 40×8 floor the rule always survives; this is the exception that
  // keeps a tiny terminal usable rather than the common path.
  const selectedRow = rows.findIndex(
    (row) => row.kind === "item" && row.item.id === input.view.selectedItemId,
  );
  const settingsIn = (capacity: number): number => {
    const window = listWindow(rows.length, Math.max(0, selectedRow), capacity);
    return rows
      .slice(window.start, window.start + window.rows)
      .filter((row) => row.kind === "item").length;
  };
  const bodyCapacity = contentLimit - lines.length;
  const withRule = settingsIn(bodyCapacity - 1) >= MIN_SETTING_ROWS
    // A short list does not buy a row by giving up the rule, so it keeps it:
    // the rule sheds to make room for settings, never as a reflex.
    || settingsIn(bodyCapacity - 1) === settingsIn(bodyCapacity);
  if (withRule) lines.push(dividerLine(input.theme, usableWidth, ellipsis));
  const bodyRow = lines.length;
  const body = renderBody(
    input,
    rows,
    Math.max(0, contentLimit - lines.length),
    usableWidth,
    ellipsis,
  );
  lines.push(...body.lines);

  if (lines.length > contentLimit) lines.splice(contentLimit);
  while (lines.length < contentLimit) lines.push(line());
  lines.push(noticeLine(input, usableWidth, ellipsis));
  lines.push(dividerLine(input.theme, usableWidth, ellipsis));
  lines.push(actionBar(input, usableWidth));

  const cursorRow = body.cursor ? bodyRow + body.cursor.row + 1 : 0;
  return {
    frame: {
      lines,
      chatHeight: contentLimit,
      cursor: body.cursor && cursorRow <= contentLimit
        ? { row: cursorRow, col: body.cursor.columnStart }
        : { row: height, col: 1 },
    },
  };
}
