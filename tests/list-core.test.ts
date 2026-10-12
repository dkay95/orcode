import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListFilterLine,
  buildListLines,
  filterListEntries,
  interpretListKey,
  isListEntryDisabled,
  LIST_MULTI_SELECT_CAP,
  LIST_PAGE_STEP,
  scoreListEntry,
  stepListIndex,
  stepSelectableListIndex,
  toggleListMultiSelect,
  withListSections,
  type ListEntry,
} from "../src/ui/list-core.js";
import { displayWidth, renderLines } from "../src/ui/compose.js";
import { createTheme } from "../src/ui/theme.js";
import { formatModelRouteDetail } from "../src/utils.js";

function plain(line: { spans: readonly { text: string }[] }): string {
  return line.spans.map((part) => part.text).join("");
}

function entry(name: string, extra: Partial<ListEntry> = {}): ListEntry {
  return { name, ...extra };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("scoreListEntry: exact name match beats prefix beats substring, non-match is -1", () => {
  const item = { name: "OpenRouter", description: "API key · Pay as you go" };
  assert.equal(scoreListEntry(item, "openrouter"), 10_000);
  assert.equal(scoreListEntry(item, "open"), 5_000);
  assert.equal(scoreListEntry(item, "pay as you go"), 1_000);
  assert.equal(scoreListEntry(item, "zzz-nope"), -1);
});

test("scoreListEntry: an empty query scores everything 0 (unfiltered, unranked)", () => {
  assert.equal(scoreListEntry({ name: "anything" }, ""), 0);
});

test("scoreListEntry: haystack folds in extra searchable text (e.g. a raw model id) at the substring tier", () => {
  const item = { name: "Claude Sonnet", description: "" };
  assert.equal(scoreListEntry(item, "sonnet-v2", "anthropic/claude-sonnet-v2-full"), 1_000);
  assert.equal(scoreListEntry(item, "sonnet-v2"), -1);
});

test("scoreListEntry: haystack also counts for the exact and prefix tiers, not just the substring one (e.g. a choice's internal value)", () => {
  const item = { name: "Automatic", description: "Model default" };
  assert.equal(scoreListEntry(item, "auto", "auto"), 10_000);
  assert.equal(scoreListEntry(item, "aut", "auto"), 5_000);
  // The name itself is unrelated to the query — only the haystack matches —
  // proving the tier comes from the haystack, not a name coincidence.
  assert.equal(scoreListEntry({ name: "Membership key" }, "membership-key", "membership-key"), 10_000);
});

test("filterListEntries: empty query returns items unchanged, in original order", () => {
  const items = ["b-item", "a-item", "c-item"];
  const result = filterListEntries(items, "", (value) => ({ name: value }));
  assert.deepEqual(result, items);
});

test("filterListEntries: ranks by score, ties broken by original order (stable)", () => {
  const items = ["zzz-exact", "exact", "exact-b"];
  const result = filterListEntries(items, "exact", (value) => ({ name: value }));
  // "exact" (10_000) first, then the two prefix/substring matches in
  // original relative order ("exact-b" is a prefix match at 5_000,
  // "zzz-exact" is a substring match at 1_000).
  assert.deepEqual(result, ["exact", "exact-b", "zzz-exact"]);
});

test("filterListEntries: drops non-matching items entirely", () => {
  const items = ["alpha", "beta", "gamma"];
  const result = filterListEntries(items, "beta", (value) => ({ name: value }));
  assert.deepEqual(result, ["beta"]);
});

test("filterListEntries: an empty item list stays empty regardless of query", () => {
  assert.deepEqual(filterListEntries([], "anything", (value: string) => ({ name: value })), []);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test("stepListIndex: clamps at both ends and never goes negative", () => {
  assert.equal(stepListIndex(0, 5, -1), 0);
  assert.equal(stepListIndex(4, 5, 1), 4);
  assert.equal(stepListIndex(2, 5, 1), 3);
  assert.equal(stepListIndex(2, 5, -1), 1);
});

test("stepListIndex: an empty list always resolves to index 0", () => {
  assert.equal(stepListIndex(0, 0, 1), 0);
  assert.equal(stepListIndex(0, 0, -LIST_PAGE_STEP), 0);
});

test("stepListIndex: PgUp/PgDn step by the shared page size", () => {
  assert.equal(stepListIndex(0, 100, LIST_PAGE_STEP), LIST_PAGE_STEP);
  assert.equal(stepListIndex(10, 100, -LIST_PAGE_STEP), 2);
});

test("stepSelectableListIndex: skips a section heading row in the step direction", () => {
  const entries = [
    entry("Alpha"),
    entry("Group B", { sectionHeading: true }),
    entry("Beta"),
  ];
  assert.equal(stepSelectableListIndex(entries, 0, 1), 2);
  assert.equal(stepSelectableListIndex(entries, 2, -1), 0);
});

test("stepSelectableListIndex: staying at the boundary when the only remaining rows are headings returns the nearest selectable index", () => {
  const entries = [entry("Alpha"), entry("Trailing heading", { sectionHeading: true })];
  assert.equal(stepSelectableListIndex(entries, 0, 1), 0);
});

test("stepSelectableListIndex: an empty list resolves to 0", () => {
  assert.equal(stepSelectableListIndex([], 0, 1), 0);
});

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

test("toggleListMultiSelect: adds up to the cap, then rejects without mutating the set", () => {
  let selected = new Set<string>();
  for (let index = 0; index < LIST_MULTI_SELECT_CAP; index += 1) {
    const result = toggleListMultiSelect(selected, `id-${index}`);
    assert.equal(result.rejected, false);
    selected = result.selected;
  }
  assert.equal(selected.size, LIST_MULTI_SELECT_CAP);
  const blocked = toggleListMultiSelect(selected, "one-too-many");
  assert.equal(blocked.rejected, true);
  assert.equal(blocked.selected.size, LIST_MULTI_SELECT_CAP);
  assert.equal(blocked.selected.has("one-too-many"), false);
});

test("toggleListMultiSelect: toggling an already-selected id removes it, even at the cap", () => {
  const selected = new Set(["a", "b", "c", "d", "e"]);
  const result = toggleListMultiSelect(selected, "c");
  assert.equal(result.rejected, false);
  assert.deepEqual([...result.selected].sort(), ["a", "b", "d", "e"]);
});

test("toggleListMultiSelect: never mutates the input set", () => {
  const selected = new Set(["a"]);
  toggleListMultiSelect(selected, "b");
  assert.deepEqual([...selected], ["a"]);
});

// ---------------------------------------------------------------------------
// Key protocol
// ---------------------------------------------------------------------------

test("interpretListKey: classifies every bound key name", () => {
  assert.equal(interpretListKey({ name: "up" }), "up");
  assert.equal(interpretListKey({ name: "down" }), "down");
  assert.equal(interpretListKey({ name: "pageup" }), "pageUp");
  assert.equal(interpretListKey({ name: "pagedown" }), "pageDown");
  assert.equal(interpretListKey({ name: "return" }), "enter");
  assert.equal(interpretListKey({ name: "escape" }), "escape");
  assert.equal(interpretListKey({ name: "space" }), "toggle");
  assert.equal(interpretListKey({ name: "tab" }), "tab");
  assert.equal(interpretListKey({ name: "backspace" }), "backspace");
});

test("interpretListKey: anything else (a printable character, an unbound name) is 'none' — text editing is the caller's own concern", () => {
  assert.equal(interpretListKey({ name: "a" }), "none");
  assert.equal(interpretListKey({}), "none");
  assert.equal(interpretListKey({ name: "left" }), "none");
});

// ---------------------------------------------------------------------------
// Disabled entries
// ---------------------------------------------------------------------------

test("isListEntryDisabled: true for an explicit flag, a reason, or a section heading; false otherwise", () => {
  assert.equal(isListEntryDisabled(entry("a")), false);
  assert.equal(isListEntryDisabled(entry("a", { disabled: true })), true);
  assert.equal(isListEntryDisabled(entry("a", { disabledReason: "Coming soon" })), true);
  assert.equal(isListEntryDisabled(entry("a", { sectionHeading: true })), true);
});

test("withListSections: introduces a non-selectable heading row per non-empty section, drops empty sections", () => {
  const entries = withListSections([
    { heading: "This folder", entries: [entry("chat-a")] },
    { heading: "Empty", entries: [] },
    { heading: "Other folders", entries: [entry("chat-b"), entry("chat-c")] },
  ]);
  assert.deepEqual(entries.map((row) => [row.name, Boolean(row.sectionHeading)]), [
    ["This folder", true],
    ["chat-a", false],
    ["Other folders", true],
    ["chat-b", false],
    ["chat-c", false],
  ]);
});

// ---------------------------------------------------------------------------
// Render — fullscreen lines
// ---------------------------------------------------------------------------

const theme = createTheme({ level: 0 });

test("buildListLines: an empty entry list renders nothing", () => {
  assert.deepEqual(buildListLines({ entries: [], selectedIndex: 0 }, 80, 6, theme), []);
});

test("buildListLines: a non-positive limit renders nothing even with entries", () => {
  const list = { entries: [entry("a")], selectedIndex: 0 };
  assert.deepEqual(buildListLines(list, 80, 0, theme), []);
});

test("buildListLines: marks the selected row, and draws no corner label while the whole list is on screen", () => {
  const list = { entries: [entry("alpha"), entry("beta"), entry("gamma")], selectedIndex: 1 };
  const lines = buildListLines(list, 80, 6, theme).map(plain);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^❯ beta/);
  assert.match(lines[0]!, /^ {2}alpha/);
  // FIX-14 ticket 10 (FIX-9's parked "1 of 2 pager" finding): three rows are
  // on screen and three rows exist, so "2 of 3" told the reader nothing they
  // could not see. The corner is drawn exactly when it has something to
  // disclose — see the overflow section below, which is unchanged.
  assert.ok(lines.every((line) => !/\d+ of \d+$/.test(line)), lines.join("\n"));
});

test("buildListLines: renders description, current, and disabledReason suffixes", () => {
  const list = {
    entries: [entry("model-a", { description: "Fast", current: true, disabledReason: "Offline" })],
    selectedIndex: 0,
  };
  const [line] = buildListLines(list, 80, 6, theme);
  const text = plain(line!);
  assert.match(text, /Fast/);
  assert.match(text, /active/);
  assert.match(text, /Offline/);
});

// ---------------------------------------------------------------------------
// V4-A emphasis levels (`ui/zones.ts`), superseding D1 ruling 1's inverse
// selection bar on this renderer.
//
// D1 painted the selected row as one uniform `inverse` bar. V4 spends
// `inverse` on the title bar instead — the screen's ONE loud line, the
// landmark that answers "where am I" — so a picker may not also paint a row
// with it. The selection moves to level 2 (accent + bold), which is what the
// approved V4 frames draw: one `❯` marker, no bar. The hub keeps its own bar
// (`workbench.ts`), because it carries no title bar and its selection IS its
// one loud line; `fillSelectionBar` therefore stays exported and tested
// there. Behaviour — which row is selected, what the keys do — is untouched.
// ---------------------------------------------------------------------------

test("buildListLines: the selected row is level 2 (accent+bold), never the title bar's inverse", () => {
  const colored = createTheme({ level: 3 });
  const list = {
    entries: [entry("model-a", { description: "Fast", current: true, disabledReason: "Offline" })],
    selectedIndex: 0,
  };
  const [line] = buildListLines(list, 80, 6, colored);
  assert.equal(
    line!.spans.some((part) => part.role === "inverse"),
    false,
    `a list row may never wear inverse — that is the title bar's, once per screen: ${plain(line!)}`,
  );
  const marker = line!.spans[0]!;
  assert.equal(marker.role, "accent");
  assert.equal(marker.bold, true);
  const nameSpan = line!.spans.find((part) => part.text.includes("model-a"))!;
  assert.equal(nameSpan.role, "accent");
  assert.equal(nameSpan.bold, true);
});

test("buildListLines: the row's per-cell levels are name/value/description — 3, 3b, 4 — selected or not", () => {
  const colored = createTheme({ level: 3 });
  const list = {
    entries: [
      entry("model-a", { description: "Fast", current: true, disabledReason: "Offline" }),
      entry("model-b"),
    ],
    selectedIndex: 1,
  };
  const [line] = buildListLines(list, 80, 6, colored);
  // marker gap, name (3: text+bold), description gap + text (4: muted),
  // current value (3b: accent — a VALUE, not the honesty layer's `ok`),
  // disabledReason (warn: warnings keep warn + words, at every level).
  assert.deepEqual(
    line!.spans.map((part) => part.role),
    ["text", "text", "muted", "muted", "accent", "warn"],
  );
  const nameSpan = line!.spans[1]!;
  assert.equal(nameSpan.bold, true, "level 3: a name is bold");
  const valueSpan = line!.spans.find((part) => part.text.includes("active"))!;
  assert.equal(valueSpan.bold, undefined, "level 3b: a value is accent, NOT bold — that is level 2");
});

/**
 * Fix round 1 (review MINOR 4): level 3b is the one level whose colour a
 * NO_COLOR reader cannot see, so the pin is that its meaning does not depend
 * on that colour. A value is always the `·`-suffixed tail of its row — form
 * and position, never hue — in both glyph modes and at colour level 0.
 *
 * The mockup's aligned value COLUMN is a stronger form still; it belongs to
 * the settings rows, which V4-B builds. Nothing on a V4-A surface signals by
 * colour alone.
 */
test("buildListLines: a level-3b value reads from form at colour level 0 — always the separator-suffixed tail", () => {
  for (const mode of [createTheme({ level: 0 }), createTheme({ level: 0, ascii: true })]) {
    const esc = String.fromCharCode(27);
    const list = {
      entries: [entry("model-a", { description: "Fast", current: "claude-sonnet-5" })],
      selectedIndex: 0,
    };
    const rendered = renderLines(buildListLines(list, 80, 6, mode), mode);
    assert.equal(rendered.join("").includes(esc), false, "no ANSI codes at level 0");
    assert.ok(
      rendered[0]!.endsWith(`${mode.glyph("separator")}claude-sonnet-5`),
      `ascii=${mode.ascii}: ${JSON.stringify(rendered[0])}`,
    );
  }
});

test("buildListLines: no row is padded out to the full width any more — the bar is gone, the marker carries the selection", () => {
  const colored = createTheme({ level: 3 });
  const list = { entries: [entry("alpha"), entry("beta"), entry("gamma")], selectedIndex: 0 };
  const lines = buildListLines(list, 40, 6, colored);
  assert.ok(displayWidth(plain(lines[0]!)) < 40, plain(lines[0]!));
  assert.ok(displayWidth(plain(lines[1]!)) < 40, plain(lines[1]!));
  assert.match(plain(lines[0]!), /^❯ alpha/);
});

test("buildListLines: at level 0 (NO_COLOR) selection reads from the marker glyph alone — unchanged by the level rework", () => {
  const esc = String.fromCharCode(27);
  const noColor = createTheme({ level: 0 });
  const list = { entries: [entry("alpha"), entry("beta")], selectedIndex: 0 };
  const rendered = renderLines(buildListLines(list, 40, 6, noColor), noColor);
  assert.equal(rendered.join("\n").includes(esc), false, "no ANSI codes at level 0");
  assert.match(rendered[0]!, /^❯ alpha/);
  assert.match(rendered[1]!, /^ {2}beta/);
});

test("buildListLines: ASCII theme renders the selection with the ASCII marker, never the unicode one", () => {
  const ascii = createTheme({ level: 3, ascii: true });
  const list = { entries: [entry("alpha"), entry("beta")], selectedIndex: 0 };
  const rendered = renderLines(buildListLines(list, 40, 6, ascii), ascii);
  assert.equal(rendered[0]!.includes("> "), true, rendered[0]);
  assert.equal(rendered[0]!.includes("❯"), false, "ASCII theme must never leak the unicode marker");
});

test("buildListLines: a wide selected row still fits — the fitter ellipsizes rather than overflowing", () => {
  const colored = createTheme({ level: 3 });
  const list = {
    entries: [entry("gamma", { description: "Third, selected and last, quite a long description" })],
    selectedIndex: 0,
  };
  const [line] = buildListLines(list, 30, 6, colored);
  assert.equal(displayWidth(plain(line!)), 30);
  assert.ok(plain(line!).endsWith(colored.glyph("ellipsis")));
  assert.equal(line!.spans.some((part) => part.role === "inverse"), false);
});

test("buildListLines: caps visible rows at `limit` and windows around the selection", () => {
  const entries = Array.from({ length: 20 }, (_, index) => entry(`item-${index}`));
  const lines = buildListLines({ entries, selectedIndex: 15 }, 80, 6, theme).map(plain);
  assert.equal(lines.length, 6);
  assert.ok(lines.some((line) => line.includes("item-15")));
});

test("buildListLines: the corner 'n of total' label never counts section headings (fix round 1, MINOR 8)", () => {
  const entries = withListSections([
    { heading: "Current folder", entries: [entry("Local chat")] },
    { heading: "Other folders", entries: [entry("Foreign chat")] },
  ]);
  // Selecting "Foreign chat" (array index 3: heading, entry, heading, entry)
  // must read "2 of 2" — its rank among the two *selectable* rows — never
  // "4 of 4", which would count both non-selectable heading rows too.
  const selectedIndex = entries.findIndex((candidate) => candidate.name === "Foreign chat");
  // FIX-14 ticket 10: the corner only renders on overflow, so the budget is
  // one row short of the four this list needs. What is being pinned — the
  // rank/total counting selectable rows only — is unchanged.
  const lines = buildListLines({ entries, selectedIndex }, 80, 3, theme).map(plain);
  // V4-A: the count leads and the disclosure marker trails it, so the anchor
  // moved off `$` — the numbers being pinned are unchanged.
  assert.ok(lines.some((line) => /2 of 2 · [▴▾]/.test(line)), lines.join("\n"));
  assert.ok(!lines.some((line) => /4 of 4/.test(line)), lines.join("\n"));
});

// ---------------------------------------------------------------------------
// Overflow disclosure (FIX-5 ruling 1) — a window that hides rows must say
// so, in every state and for every caller. The command palette's browse
// states were the reported symptom: six groups, a four-row budget, a footer
// with `hideCount`, and (then) a `hideInlineTotal` list — the two invisible
// groups had no representation anywhere on screen.
// ---------------------------------------------------------------------------

test("buildListLines: a window that hides rows below shows the scrollDown glyph with the 'n of total' count", () => {
  const entries = Array.from({ length: 6 }, (_, index) => entry(`group-${index}`));
  const lines = buildListLines({ entries, selectedIndex: 0 }, 80, 4, theme).map(plain);
  assert.equal(lines.length, 4);
  assert.ok(lines.at(-1)!.endsWith(`1 of 6${theme.glyph("separator")}${theme.glyph("disclosureDown")}`), lines.join("\n"));
  assert.equal(lines.at(-1)!.includes(theme.glyph("scrollUp")), false, "nothing is hidden above the first row");
});

test("buildListLines: a window that hides rows above shows the scrollUp glyph; a window hiding both directions shows both", () => {
  const entries = Array.from({ length: 6 }, (_, index) => entry(`group-${index}`));
  const bottom = buildListLines({ entries, selectedIndex: 5 }, 80, 4, theme).map(plain);
  assert.ok(bottom.at(-1)!.endsWith(`6 of 6${theme.glyph("separator")}${theme.glyph("disclosureUp")}`), bottom.join("\n"));
  const middle = buildListLines({ entries, selectedIndex: 3 }, 80, 4, theme).map(plain);
  assert.ok(
    middle.at(-1)!.endsWith(`4 of 6${theme.glyph("separator")}${theme.glyph("disclosureUp")}${theme.glyph("disclosureDown")}`),
    middle.join("\n"),
  );
});

test("buildListLines: the corner is drawn exactly on overflow — FIX-14 ticket 10 replaced `hideInlineTotal` with that one rule", () => {
  const entries = Array.from({ length: 6 }, (_, index) => entry(`group-${index}`));
  // The exact palette shape: a caller that carries its own footer count. With
  // rows off-screen the disclosure is not a duplicate of anything — the
  // palette's browse footer prints no count at all — so it renders.
  const clipped = buildListLines({ entries, selectedIndex: 0 }, 80, 4, theme).map(plain);
  assert.ok(clipped.at(-1)!.endsWith(`1 of 6${theme.glyph("separator")}${theme.glyph("disclosureDown")}`), clipped.join("\n"));
  // Same list, a budget that fits it: nothing is hidden, so nothing is said.
  // This is the case `hideInlineTotal` used to be needed for, and the case
  // FIX-9's "1 of 2 pager" finding was about — one rule now covers both.
  const whole = buildListLines({ entries, selectedIndex: 0 }, 80, 6, theme).map(plain);
  assert.equal(whole.length, 6);
  assert.equal(whole.some((line) => /\d+ of \d+$/.test(line)), false, whole.join("\n"));
  assert.equal(whole.some((line) => line.includes(theme.glyph("disclosureDown"))), false, whole.join("\n"));
});

/**
 * Fix round 1, the controller's ruling on what `N` means: the CURSOR'S RANK
 * among the `M` rows the list currently holds — in every state. Browsing
 * ranks among all rows; filtering ranks among the matches, because once a
 * query is on, the matches ARE the rows the list holds. One meaning, never
 * re-pointed by a keystroke.
 *
 * The two frames below are the same list before and after a filter narrows
 * it, so the invariant is visible as a pair rather than asserted twice.
 */
test("counter invariant, browsing: N is the cursor's rank among the M rows on offer", () => {
  const entries = Array.from({ length: 9 }, (_, index) => entry(`item-${index}`));
  const first = buildListLines({ entries, selectedIndex: 0 }, 80, 4, theme).map(plain);
  assert.ok(first.at(-1)!.endsWith(`1 of 9${theme.glyph("separator")}${theme.glyph("disclosureDown")}`), first.join("\n"));
  const later = buildListLines({ entries, selectedIndex: 5 }, 80, 4, theme).map(plain);
  assert.ok(
    later.at(-1)!.endsWith(`6 of 9${theme.glyph("separator")}${theme.glyph("disclosureUp")}${theme.glyph("disclosureDown")}`),
    later.join("\n"),
  );
});

test("counter invariant, filtering: N is STILL the cursor's rank — the matches are the rows on offer", () => {
  // The same nine rows, narrowed to five by a caller's own filter. `M` is the
  // five that remain, not the nine that existed, and `N` is still where the
  // cursor sits — so typing a letter never re-points what the fraction means.
  const all = Array.from({ length: 9 }, (_, index) => entry(`item-${index}`));
  const matches = filterListEntries(all, "item-1", (item) => ({ name: item.name }))
    .concat(filterListEntries(all, "item-2", (item) => ({ name: item.name })))
    .concat(filterListEntries(all, "item-3", (item) => ({ name: item.name })))
    .concat(filterListEntries(all, "item-4", (item) => ({ name: item.name })))
    .concat(filterListEntries(all, "item-5", (item) => ({ name: item.name })));
  assert.equal(matches.length, 5);
  const lines = buildListLines({ entries: matches, selectedIndex: 2 }, 80, 4, theme).map(plain);
  assert.ok(
    lines.at(-1)!.endsWith(`3 of 5${theme.glyph("separator")}${theme.glyph("disclosureDown")}`),
    lines.join("\n"),
  );
});

test("counter invariant: a wholly visible list says nothing at all, filtered or not (FIX-14 ticket 10)", () => {
  const entries = Array.from({ length: 3 }, (_, index) => entry(`match-${index}`));
  const whole = buildListLines({ entries, selectedIndex: 0 }, 80, 6, theme).map(plain);
  assert.equal(whole.some((line) => /\d+ of \d+/.test(line)), false, whole.join("\n"));
});

test("buildListLines: the overflow disclosure counts selectable rows only — section headings never inflate it", () => {
  const entries = withListSections([
    { heading: "Current folder", entries: [entry("a"), entry("b")] },
    { heading: "Other folders", entries: [entry("c"), entry("d")] },
  ]);
  assert.equal(entries.length, 6);
  const lines = buildListLines({ entries, selectedIndex: 1 }, 80, 4, theme).map(plain);
  assert.ok(lines.at(-1)!.endsWith(`1 of 4${theme.glyph("separator")}${theme.glyph("disclosureDown")}`), lines.join("\n"));
});

test("buildListLines: the overflow disclosure survives the ASCII glyph set (^ / v), never leaking the unicode arrows", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  const entries = Array.from({ length: 6 }, (_, index) => entry(`group-${index}`));
  const lines = buildListLines({ entries, selectedIndex: 3 }, 80, 4, ascii).map(plain);
  assert.ok(lines.at(-1)!.endsWith("4 of 6 - ^v"), lines.join("\n"));
  // eslint-disable-next-line no-control-regex
  assert.match(lines.at(-1)!, /^[\x20-\x7e]*$/);
});

// ---------------------------------------------------------------------------
// Section headings (FIX-5 ruling 2) — a heading is a rule, not a row. It
// carried the identical shape as a selectable row before this ruling, which
// made `/chats`' "Current folder"/"Other folders" read as two pickable chats.
// ---------------------------------------------------------------------------

test("buildListLines: a section heading renders as the muted `─ <Group>` rule, never a selectable row", () => {
  const entries = withListSections([
    { heading: "Current folder", entries: [entry("Local chat", { description: "1 message" })] },
  ]);
  const lines = buildListLines({ entries, selectedIndex: 1 }, 80, 6, theme).map(plain);
  assert.equal(lines[0]!.startsWith(`${theme.glyph("divider")} Current folder`), true, lines.join("\n"));
  // No marker column, no name padding, no `❯` — the three things that make a
  // row look pickable.
  assert.equal(lines[0]!.startsWith("  "), false);
  assert.equal(lines[0]!.includes(theme.glyph("marker")), false);
  assert.match(lines[1]!, /^❯ Local chat/);
});

test("buildListLines: the heading's non-selectable look survives colour level 0 — the leading glyph carries it, not the role", () => {
  const esc = String.fromCharCode(27);
  const noColor = createTheme({ level: 0 });
  const entries = withListSections([
    { heading: "Other folders", entries: [entry("Foreign chat")] },
  ]);
  const rendered = renderLines(buildListLines({ entries, selectedIndex: 1 }, 60, 6, noColor), noColor);
  assert.equal(rendered.join("\n").includes(esc), false, "no ANSI codes at level 0");
  assert.match(rendered[0]!, /^─ Other folders/);
  assert.match(rendered[1]!, /^❯ Foreign chat/);
});

test("buildListLines: a heading is level 5 + level 2 at full colour and never wears the selection", () => {
  const colored = createTheme({ level: 3 });
  const entries = withListSections([
    { heading: "Current folder", entries: [entry("Local chat")] },
  ]);
  // Even if a caller's stored index points straight at the heading (a stale
  // index, a caller that never adopted `stepSelectableListIndex`), it must
  // not render as the selection.
  const [heading] = buildListLines({ entries, selectedIndex: 0 }, 60, 6, colored);
  // V4-A: the rule glyph stays level 5 (structure); the heading TEXT rises
  // from muted (level 4, "an explanation") to level 2 — the mockup's amber,
  // bold `─ Cross-Paar`. Shape still tells it apart from an active row.
  assert.deepEqual(heading!.spans.slice(0, 2).map((part) => part.role), ["structure", "accent"]);
  assert.equal(heading!.spans[1]!.bold, true);
  assert.equal(heading!.spans.some((part) => part.role === "inverse"), false, plain(heading!));
  assert.equal(plain(heading!).includes(colored.glyph("marker")), false);
});

/**
 * Phase F3 (information-dense pickers), ruling 5: at the 40-col floor the
 * longest row (a real /model row shape, `formatModelRouteDetail`) must
 * ellipsize via the theme's own ellipsis glyph, never overflow the width —
 * the mechanism (`composeLine`, unchanged by F3) already does this; this
 * pins it at exactly the floor width the richer rows now make reachable.
 * Both theme glyph modes are checked so the ellipsis is provably one cell
 * in both — the F6 width-parity ruling replaced the ASCII fallback's old
 * three-char `...` with a single `.` for exactly this reason (the
 * "single-cell width rule").
 */
test("buildListLines: an information-dense /model row ellipsizes at the 40-col floor via the theme glyph, never overflowing", () => {
  const description = formatModelRouteDetail({
    providerLabel: "Anthropic",
    price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
    contextLength: 200_000,
  });
  assert.equal(description, "Anthropic · $3/M in · $15/M out · 200K");
  // FIX-14 ticket 10: a single-row list is wholly on screen, so no corner
  // label is drawn and the row owns the full width — which is what this test
  // measures. `hideInlineTotal: true` used to say the same thing explicitly.
  const list = {
    entries: [entry("claude-sonnet-4-6", { description })],
    selectedIndex: 0,
  };

  for (const theme of [createTheme({ level: 0 }), createTheme({ level: 0, ascii: true })]) {
    const [line] = buildListLines(list, 40, 6, theme);
    const text = plain(line!);
    assert.equal(displayWidth(text), 40, `theme ascii=${theme.ascii}: ${JSON.stringify(text)}`);
    assert.ok(text.endsWith(theme.glyph("ellipsis")), `theme ascii=${theme.ascii}: ${JSON.stringify(text)}`);
    // The unicode ellipsis is exactly one cell, and so is its ASCII pair
    // (F6 width-parity ruling: ascii ellipsis is "." not "...") — cutting to
    // fit never needs to drop more than one extra character to make room
    // for it in either glyph mode.
    assert.equal(displayWidth(theme.glyph("ellipsis")), 1);
  }
});

// ---------------------------------------------------------------------------
// List anatomy — the filter line and the empty state.
//
// V4-A deleted `buildListHeaderLine` and `buildListFooterLine` along with
// their tests: those two lines are now zone 1 and zone 3, pinned in
// `tests/ui-zones.test.ts` (the primitives) and in the frame pins
// (`tests/ui-zone-anatomy.test.ts`).
// ---------------------------------------------------------------------------

test("buildListFilterLine: renders the marker, the typed query, and a trailing cursor glyph", () => {
  assert.equal(plain(buildListFilterLine(theme, "sonnet")), "❯ sonnet•");
  assert.equal(plain(buildListFilterLine(theme, "")), "❯ •");
});

/**
 * FIX-14 ticket 19 (FIX-15's knowingly-paid floor, repaid). Below roughly 60
 * columns a padded name column pushed the right-aligned corner out, and
 * `composeLine`'s "never shorten, leave out" rule dropped it — taking the
 * OVERFLOW DISCLOSURE with it, which is the one thing on the row saying
 * other rows exist off screen.
 */
test("buildListLines: at a narrow width the overflow corner survives by shrinking the row, not by dropping the corner", () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    entry(`a-very-long-row-name-${index}`, { description: "and an information-dense description too" }));
  const lines = buildListLines({ entries, selectedIndex: 0 }, 44, 4, theme).map(plain);

  const last = lines.at(-1)!;
  assert.ok(last.endsWith(`1 of 8${theme.glyph("separator")}${theme.glyph("disclosureDown")}`), lines.join("\n"));
  // The row shed its description to make the room — it did not shed the
  // fact that four more rows exist.
  assert.ok(!last.includes("information-dense"), last);
  assert.ok(last.includes("a-very-long-row-name"), last);
  for (const line of lines) assert.ok(displayWidth(line) <= 44, JSON.stringify(line));
});

test("buildListLines: a row with no corner to make room for ellipsizes its description rather than dropping it", () => {
  // The other half of the same rule. A single-row list draws no corner
  // (ticket 10), so there is nothing to make room FOR, and giving up the
  // whole description the moment the row runs one column long would be a
  // worse trade than cutting it.
  const list = {
    entries: [entry("model-x", { description: "Anthropic · $3/M in · $15/M out · 200K" })],
    selectedIndex: 0,
  };
  const [line] = buildListLines(list, 40, 6, theme);
  const text = plain(line!);
  assert.ok(text.includes("Anthropic"), text);
  assert.ok(text.endsWith(theme.glyph("ellipsis")), text);
});

/**
 * FIX-14 fix round 1 (review M1, controller ruling). A fragment of prose is
 * merely unhelpful; a fragment of a MONEY figure is misleading — the Cross
 * gate's Start row read `est. from $0…` at 40 columns for a real floor of
 * $0.068, which a reader can take for "from $0". `descriptionParts` renders
 * each part whole or sheds it whole.
 */
test("buildListLines: descriptionParts are rendered whole or shed whole — never cut", () => {
  const parts = ["4-6 model calls", "est. from $0.068-$0.102", "later rounds also carry what the run writes"];
  const render = (width: number): string => plain(
    buildListLines(
      { entries: [entry("Start", { description: parts.join(" · "), descriptionParts: parts })], selectedIndex: 0 },
      width,
      6,
      theme,
    )[0]!,
  );

  for (const width of [30, 40, 50, 60, 70, 80, 100, 140]) {
    const text = render(width);
    assert.ok(displayWidth(text) <= width, `${width}: ${JSON.stringify(text)}`);
    // Whatever survives is a whole part. Nothing may appear in cut form —
    // which for the money part is the entire point.
    for (const part of parts) {
      const head = part.slice(0, 6);
      if (!text.includes(head)) continue;
      assert.ok(text.includes(part), `${width} rendered a fragment of ${JSON.stringify(part)}: ${JSON.stringify(text)}`);
    }
    // And the figure can never appear stripped of the marker that qualifies it.
    if (/\$\d/.test(text)) {
      assert.ok(text.includes("est. from $0.068-$0.102"), `${width}: ${JSON.stringify(text)}`);
    }
  }

  // Shed from the END: the money part outlives the disclosure clause.
  assert.ok(render(60).includes("est. from $0.068-$0.102"), render(60));
  assert.ok(!render(60).includes("later rounds"), render(60));
  // And at the width where even the figure cannot fit, marker and numbers
  // go together — no `est. from $0…`.
  assert.ok(render(40).includes("4-6 model calls"), render(40));
  assert.doesNotMatch(render(40), /est\. from|\$/, render(40));
});

test("buildListLines: an entry without descriptionParts keeps the existing ellipsizing behaviour", () => {
  const description = "Anthropic · $3/M in · $15/M out · 200K";
  const [line] = buildListLines(
    { entries: [entry("model-x", { description })], selectedIndex: 0 },
    40,
    6,
    theme,
  );
  const text = plain(line!);
  assert.ok(text.includes("Anthropic"), text);
  assert.ok(text.endsWith(theme.glyph("ellipsis")), text);
});
