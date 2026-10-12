/**
 * V4-A zone primitives (`src/ui/zones.ts`).
 *
 * These pin the two zones and the level vocabulary on their own, away from
 * any frame: the shapes each zone takes at full colour, at colour level 0
 * (NO_COLOR, a pipe, a dumb terminal) and in ASCII glyph mode, plus the one
 * rule the whole V4 hierarchy rests on — one look per meaning, one meaning
 * per look. `tests/ui-zone-anatomy.test.ts` proves the same zones inside real
 * frames at real sizes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ROLES, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import {
  EMPHASIS,
  actionBarLine,
  crumbText,
  emphasize,
  titleBarLine,
  type EmphasisLevel,
} from "../src/ui/zones.js";

const COLOR = createTheme({ level: 3 });
const NO_COLOR = createTheme({ level: 0 });
const ASCII = createTheme({ level: 3, ascii: true });

// ---------------------------------------------------------------------------
// Zone 1 — the title bar.
// ---------------------------------------------------------------------------

test("zone 1: at full colour the bar is ONE inverse span, padded to the given width", () => {
  const line = titleBarLine(COLOR, ["Commands", "Models"], { width: 40 });
  assert.deepEqual(line.spans.map((part) => part.role), ["inverse"]);
  assert.equal(plainText(line), ` Commands › Models ${" ".repeat(40 - 19)}`);
  assert.equal(plainText(line).length, 40);
});

test("zone 1: with no width (a printed view) the bar hugs its own text, still one inverse span", () => {
  const line = titleBarLine(COLOR, ["Chat", "Context"]);
  assert.deepEqual(line.spans.map((part) => part.role), ["inverse"]);
  assert.equal(plainText(line), " Chat › Context ");
});

test("zone 1: at colour level 0 the bar degrades to the divider rule — shape carries it, never colour", () => {
  const line = titleBarLine(NO_COLOR, ["Commands", "Models"], { width: 40 });
  assert.equal(plainText(line), "─ Commands › Models");
  assert.equal(line.spans.some((part) => part.role === "inverse"), false);
  // The pre-V4 palette rule, byte for byte — which is why every NO_COLOR pin
  // of that rule still holds after the adoption.
  assert.deepEqual(line.spans.map((part) => part.role), ["structure", "muted"]);
});

test("zone 1: ASCII glyph mode never leaks the unicode chevron or rule", () => {
  const line = plainText(titleBarLine(ASCII, ["Commands", "Models"], { width: 40 }));
  assert.match(line, /^ Commands > Models/);
  // eslint-disable-next-line no-control-regex
  assert.equal(/^[\x20-\x7e]+$/.test(line), true, line);
});

test("zone 1: a caller's already-joined crumb string passes through untouched", () => {
  // The command palette owns its own crumb logic (`projectCommandMenu`);
  // V4 upgrades the RENDERING, it never builds a second crumb.
  assert.equal(crumbText(COLOR, "Commands › Models › cross"), "Commands › Models › cross");
  assert.equal(plainText(titleBarLine(NO_COLOR, "Commands › Models › cross")), "─ Commands › Models › cross");
});

test("zone 1: the bar cuts itself at a width narrower than its own crumb", () => {
  // Superseded V4-A pin (justified): the old rationale — "a wider crumb is
  // handed on to fitFrameLine" — was proven false by V4-C for the plain
  // picker, which has no frame-level fitter and smeared its repaint on a
  // user-controlled title. The primitive owns its one-line contract now.
  const line = titleBarLine(COLOR, ["Settings", "Models", "Main model"], { width: 10 });
  assert.ok(plainText(line).length <= 10, plainText(line));
  assert.ok(plainText(line).includes(COLOR.glyph("ellipsis")), "the cut is disclosed");
});

// ---------------------------------------------------------------------------
// Zone 3 — the action bar.
// ---------------------------------------------------------------------------

const CHIPS = [
  { key: "↑↓", effect: "select" },
  { key: "Enter", effect: "run" },
  { key: "Esc", effect: "back" },
];

test("zone 3: at full colour the key is level 3 and the effect level 4, chips two spaces apart", () => {
  const line = actionBarLine(COLOR, CHIPS);
  assert.equal(plainText(line), "↑↓ select  Enter run  Esc back");
  const key = line.spans[0]!;
  assert.equal(key.role, EMPHASIS["3"].role);
  assert.equal(key.bold, true);
  const effect = line.spans[1]!;
  assert.equal(effect.role, EMPHASIS["4"].role);
  assert.equal(effect.bold, undefined);
});

test("zone 3: at colour level 0 the key grows square brackets — the shape the colour would have carried", () => {
  assert.equal(plainText(actionBarLine(NO_COLOR, CHIPS)), "[↑↓] select  [Enter] run  [Esc] back");
});

test("zone 3: the optional leading divider closes the palette's block from below", () => {
  const line = actionBarLine(COLOR, CHIPS, { leadingDivider: true });
  assert.equal(plainText(line), "─ ↑↓ select  Enter run  Esc back");
  assert.equal(line.spans[0]!.role, EMPHASIS["5"].role);
});

test("zone 3: the chip gap is never `structure` — that role marks the frame's real divider", () => {
  // `tui.ts`'s `#selectMouseRow` finds the divider by looking for the LAST
  // line carrying a structure span. An action bar rendered below the composer
  // would otherwise impersonate it and break click-to-pick outright.
  const line = actionBarLine(COLOR, CHIPS);
  assert.equal(line.spans.some((part) => part.role === "structure"), false);
});

test("zone 3: ASCII glyph mode carries only ASCII (the arrows are expanded by the keymap, not here)", () => {
  const line = plainText(actionBarLine(ASCII, [{ key: "^v", effect: "select" }], { leadingDivider: true }));
  // eslint-disable-next-line no-control-regex
  assert.equal(/^[\x20-\x7e]+$/.test(line), true, line);
});

test("zone 3: an empty chip list renders an empty line, so the frame can drop the row", () => {
  assert.deepEqual(actionBarLine(COLOR, []).spans, []);
});

/**
 * FIX-11 addendum ruling A's rule, applied to the bar: a hint may get
 * shorter, but the key is never what disappears. The pre-V4 `·`-joined footer
 * was one long string, so at 40 columns the frame's width contract cut it
 * mid-chip and the way out went with the tail.
 */
test("zone 3: a narrow bar sheds WHOLE chips, lowest priority first — never half a chip, never the way out", () => {
  const chips = [
    { key: "Typing", effect: "filters", priority: 50 },
    { key: "↑↓", effect: "select", priority: 60 },
    { key: "Enter", effect: "insert", priority: 90 },
    { key: "Tab", effect: "complete", priority: 70 },
    { key: "Esc", effect: "close", priority: 100 },
  ];
  const full = "Typing filters  ↑↓ select  Enter insert  Tab complete  Esc close";
  assert.equal(plainText(actionBarLine(COLOR, chips, { width: 200 })), full);
  // Shed one: the filter hint (lowest priority) goes, display order holds.
  assert.equal(
    plainText(actionBarLine(COLOR, chips, { width: full.length - 1 })),
    "↑↓ select  Enter insert  Tab complete  Esc close",
  );
  // Shed to the bone: the way out is the last chip standing.
  assert.equal(plainText(actionBarLine(COLOR, chips, { width: 4 })), "Esc close");
  // The leading divider counts against the budget, so the palette's own bar
  // sheds one chip earlier than a bar without one.
  assert.equal(
    plainText(actionBarLine(COLOR, chips, { width: full.length, leadingDivider: true })),
    "─ ↑↓ select  Enter insert  Tab complete  Esc close",
  );
  // Level 0's brackets are two extra cells per chip, and the budget knows it.
  assert.equal(
    plainText(actionBarLine(NO_COLOR, chips, { width: full.length })),
    "[↑↓] select  [Enter] insert  [Tab] complete  [Esc] close",
  );
});

// ---------------------------------------------------------------------------
// The five levels — "one look per meaning, one meaning per look".
// ---------------------------------------------------------------------------

test("the level table maps onto existing theme roles only — no new colour token was invented", () => {
  assert.deepEqual(
    (["1", "2", "3", "3b", "4", "5"] as EmphasisLevel[]).map((level) => EMPHASIS[level].role),
    ["inverse", "accent", "text", "accent", "muted", "structure"],
  );
  for (const level of Object.keys(EMPHASIS) as EmphasisLevel[]) {
    assert.ok(ROLES.includes(EMPHASIS[level].role), `level ${level} names a role the theme does not have`);
  }
});

test("no two levels share a look — the rule is enforceable, not just written down", () => {
  const looks = new Set(
    (Object.keys(EMPHASIS) as EmphasisLevel[]).map((level) => `${EMPHASIS[level].role}|${EMPHASIS[level].bold}`),
  );
  assert.equal(looks.size, Object.keys(EMPHASIS).length, "two levels resolve to the same role+weight");
});

test("levels 2 and 3b are the ONE accent hue told apart by weight, exactly as the mockup draws them", () => {
  assert.equal(EMPHASIS["2"].role, EMPHASIS["3b"].role);
  assert.equal(EMPHASIS["2"].bold, true);
  assert.equal(EMPHASIS["3b"].bold, false);
});

test("emphasize() is the one place a level turns into a role, and it sets bold only where the level does", () => {
  assert.deepEqual(emphasize("3", "Main model"), { text: "Main model", role: "text", bold: true });
  assert.deepEqual(emphasize("3b", "qwen3.8-max"), { text: "qwen3.8-max", role: "accent" });
  assert.deepEqual(emphasize("4", "answers you"), { text: "answers you", role: "muted" });
  assert.deepEqual(emphasize("5", "─"), { text: "─", role: "structure" });
});

test("the honesty roles stay outside the level vocabulary — a warning keeps warn plus its words", () => {
  const levelled = new Set(Object.values(EMPHASIS).map((spec) => spec.role));
  for (const role of ["ok", "warn", "danger", "add", "del"]) {
    assert.equal(levelled.has(role as never), false, `${role} must not be spendable as an emphasis level`);
  }
});

// ---------------------------------------------------------------------------
// V4-C defect fix: the title bar fits ITSELF to its width — a crumb the bar
// cannot hold (user-controlled, e.g. `Multiple chats match "<query>"`) used
// to pad-but-never-cut, soft-wrapping the one line the zone contract
// promises and smearing every cursor-up repaint below it (the plain picker
// has no frame-level fitter to catch it).
// ---------------------------------------------------------------------------

test("zone 1: an over-wide crumb is ellipsized to the width — one line, never a wrap", () => {
  const crumb = `Multiple chats match "${"x".repeat(90)}"`;
  const line = titleBarLine(COLOR, crumb, { width: 79 });
  const text = plainText(line);
  assert.ok(text.length <= 79, `the bar must hold its one-line contract: ${text.length} cells`);
  assert.ok(text.includes(COLOR.glyph("ellipsis")), "the cut is disclosed, never silent");
  assert.deepEqual([...new Set(line.spans.map((part) => part.role))], ["inverse"]);
});

test("zone 1: the over-wide crumb is cut at colour level 0 too, in the divider-rule form", () => {
  const line = titleBarLine(NO_COLOR, `Multiple chats match "${"x".repeat(90)}"`, { width: 79 });
  assert.ok(plainText(line).length <= 79, plainText(line));
});

test("zone 1: an exactly-fitting crumb keeps the original single padded span", () => {
  const line = titleBarLine(COLOR, ["Commands", "Models"], { width: 40 });
  assert.equal(line.spans.length, 1);
  assert.equal(plainText(line).length, 40);
});
