/**
 * V4-C, lane item 2: THE LEVELS TRIPWIRE.
 *
 * The V4 rule the whole hierarchy rests on is one sentence — "one look per
 * meaning, one meaning per look" (`src/ui/zones.ts`). `tests/ui-zones.test.ts`
 * proves the LEVEL TABLE obeys it; the anatomy suites and
 * `tests/ui-zone-cross-surface.test.ts` prove today's rendered frames obey
 * it. None of them can stop the way the rule actually dies: somebody adds a
 * SECOND producer of a look somewhere else in `src/` — a hand-assembled key
 * chip, a second `N of M`, an inverse span outside the title bar — and every
 * existing frame pin keeps passing because the frames it pins never changed.
 *
 * This file is the structural half, in the same source-guard style
 * `tests/ui-keymap.test.ts` and `tests/cli.test.ts` already use. It reads
 * `src/` and enforces, where grep genuinely can:
 *
 *   (a) the loud look has ONE producer, and the register of zoned surfaces
 *       is COMPLETE — so a future surface adopting zones inherits the
 *       cross-surface checks by being forced to enrol;
 *   (b) the chip grammar (key in emphasis, effect muted beside it) is
 *       assembled in exactly one place, and no call site hand-writes chips;
 *   (c) the counter form `N of M` has one builder, and every other `of`
 *       between two numbers in `src/` is qualified so it can never be read
 *       as that counter.
 *
 * Deliberately NOT re-asserted here (they already have owners): which KEYS a
 * bar may name (`tests/ui-keymap.test.ts`), what each surface's anatomy looks
 * like (`tests/ui-zone-anatomy*.test.ts`), and the four shared invariants at
 * three sizes in three modes (`tests/ui-zone-cross-surface.test.ts`).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ZONED_SURFACES,
  ZONE_MODES,
  ZONE_OVERFLOWING,
  ZONE_SIZES,
} from "./fixtures/zoned-surfaces.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts` file under `src/`, as `src/…`-relative paths plus their text. */
function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(directory, entry.name);
      const shown = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(next, `${shown}/`);
      else if (entry.name.endsWith(".ts")) out.push({ path: `src/${shown}`, text: readFileSync(next, "utf8") });
    }
  };
  walk(SRC, "");
  return out;
}

const FILES = sourceFiles();

const filesMatching = (pattern: RegExp): string[] =>
  FILES.filter(({ text }) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text))
    .map(({ path }) => path);

// ---------------------------------------------------------------------------
// (a) One producer for the loud look — and a complete register.
// ---------------------------------------------------------------------------

/**
 * Level 1 is capped at ONE line per screen, which is only enforceable while
 * the `inverse` role has few enough producers to name. Each entry is a
 * deliberate, justified one; anything new must be argued for here rather
 * than added quietly.
 */
const INVERSE_PRODUCERS: Readonly<Record<string, string>> = Object.freeze({
  "src/ui/spans.ts": "declares the role and lists it in ROLES — no painting",
  "src/ui/theme.ts": "the one painter (`chalk.inverse`), and the only chalk in the project",
  "src/ui/zones.ts": "zone 1: EMPHASIS level 1, the title bar's own look",
  "src/ui/list-core.ts":
    "`fillSelectionBar` — the MECHANISM for a full-row bar. Whether a surface may "
    + "spend it is the caller's business, and the only caller left is the hub",
  "src/ui/workbench.ts":
    "the hub's selected row. The hub is the documented exception: it has NO title "
    + "bar (`ui/zones.ts`), so its bar is that screen's one loud line, not a second one",
  "src/approval.ts":
    "the `[SSH]`/`[NETWORK]` badges on an approval prompt — an inline mark, "
    + "pre-V4 and on a surface the zone adoption has not reached. Named here so it "
    + "stays a known exception rather than a precedent",
});

test("(a) the loud look has one painter and a named set of producers", () => {
  assert.deepEqual(
    filesMatching(/"inverse"/).sort(),
    Object.keys(INVERSE_PRODUCERS).sort(),
    "a new file names the `inverse` role: level 1 is capped at ONE line per screen, so "
      + "either it is a title bar (use `titleBarLine`) or it needs an entry in "
      + "INVERSE_PRODUCERS with a reason",
  );
  // And the painting itself is still in exactly one place.
  assert.deepEqual(filesMatching(/chalk\.inverse\(/), ["src/ui/theme.ts"]);
});

/**
 * The register (`tests/fixtures/zoned-surfaces.ts`) is what buys a surface
 * the cross-surface sweep. A module that renders a title bar and is NOT in
 * it is a screen nothing checks — which is precisely the hole V4-C exists to
 * close, restated so it fails loudly the day a sixth surface adopts zones.
 */
test("(a) every module that renders a title bar is in the zoned-surface register", () => {
  const registered = new Set(ZONED_SURFACES.map((surface) => surface.module));
  assert.deepEqual(
    filesMatching(/import \{[^}]*\btitleBarLine\b[^}]*\} from "[^"]*zones\.js"/).sort(),
    [...registered].sort(),
    "a module renders zone 1 but is not in ZONED_SURFACES — add it there, and it "
      + "inherits every check in tests/ui-zone-cross-surface.test.ts",
  );
});

test("(a) the only module that builds an action bar without rendering one is tui.ts", () => {
  const registered = new Set(ZONED_SURFACES.map((surface) => surface.module));
  const callers = filesMatching(/import \{[^}]*\bactionBarLine\b[^}]*\} from "[^"]*zones\.js"/);
  for (const caller of callers) {
    assert.ok(
      registered.has(caller) || caller === "src/tui.ts",
      `${caller} builds an action bar but renders no registered surface. `
        + "`tui.ts` is the one allowed case: it composes the palette's bar and hands it "
        + "to `dashboard-frame.ts`, which IS registered.",
    );
  }
});

// ---------------------------------------------------------------------------
// (b) The chip grammar has one assembler.
// ---------------------------------------------------------------------------

test("(b) the chip's span pair — key at level 3, effect at level 4 — is assembled in one place", () => {
  // The pair is what a reader SEES as a chip. Two spans, in that order, close
  // enough together to be one visual unit. Anywhere but `zones.ts` that is a
  // second chip renderer, and a second renderer is how a bar starts
  // advertising a key nothing binds.
  assert.deepEqual(
    filesMatching(/emphasize\("3",[\s\S]{0,160}?emphasize\("4",/),
    ["src/ui/zones.ts"],
  );
  assert.deepEqual(filesMatching(/export function actionBarLine\b/), ["src/ui/zones.ts"]);
  assert.deepEqual(filesMatching(/export function listActionChips\b/), ["src/ui/keymap.ts"]);
});

test("(b) an ActionChip is only ever constructed from the keymap table", () => {
  // An object literal carrying BOTH `key` and `effect` is an `ActionChip` by
  // shape, whatever it is called — and `keymap.ts`'s `chip()` builds the only
  // legitimate one, out of a row of the table.
  const shaped = /\{[^{}]*\bkey:[^{}]*\beffect:[^{}]*\}/;
  assert.deepEqual(
    filesMatching(shaped),
    ["src/ui/keymap.ts", "src/ui/zones.ts"],
    "only the keymap table may build a chip",
  );
  // `zones.ts` matches because it DECLARES the shape; a type member carries
  // `readonly`, a constructed value never does.
  const zones = FILES.find(({ path }) => path === "src/ui/zones.ts")!.text;
  for (const match of zones.match(new RegExp(shaped.source, "g")) ?? []) {
    assert.match(
      match,
      /readonly key:/,
      `src/ui/zones.ts constructs a chip instead of only declaring one: ${match}`,
    );
  }
});

test("(b) no call site hand-writes the chips it puts on a bar", () => {
  for (const { path, text } of FILES) {
    if (!/\bactionBarLine\(/.test(text) || path === "src/ui/zones.ts") continue;
    assert.match(
      text,
      /\blistActionChips\(/,
      `${path} renders an action bar without asking the keymap table for its chips`,
    );
    // An inline array is the shape a hand-written chip list takes.
    assert.doesNotMatch(
      text,
      /actionBarLine\(\s*[^,]+,\s*\[/,
      `${path} passes an inline chip array to actionBarLine — chips come from the table`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) The counter has one builder, and no lookalikes.
// ---------------------------------------------------------------------------

/** `${a} of ${b}` — the shape the universal counter takes in source. */
const OF_BETWEEN_HOLES = /\$\{[^}]*\}[^`"'\n]{0,4}of \$\{/g;

/**
 * Every OTHER place in `src/` that puts an `of` between two interpolated
 * numbers, with the word that keeps it from reading as the list counter.
 * The counter means one thing — "the cursor is at row N of M" — and a second
 * bare `N of M` anywhere would be a second meaning under the same look.
 */
const QUALIFIED_OF: Readonly<Record<string, string>> = Object.freeze({
  "src/config.ts": "spent",
  "src/approval.ts": "denials",
  "src/commands.ts": "% of",
  "src/ui/render-frame.ts": "line ",
});

test("(c) the counter has exactly one builder", () => {
  assert.deepEqual(filesMatching(/export function listCounterText\b/), ["src/ui/list-core.ts"]);
  // And the second surface that shows one imports it rather than spelling a
  // second `${a} of ${b}` that could drift in word order or separator.
  assert.match(
    FILES.find(({ path }) => path === "src/ui/settings-frame.ts")!.text,
    /import \{[^}]*\blistCounterText\b[^}]*\} from "\.\/list-core\.js"/,
  );
});

test("(c) every other `N of M` in src/ is qualified, so it can never read as the counter", () => {
  const offenders: string[] = [];
  for (const { path, text } of FILES) {
    if (path === "src/ui/list-core.ts") continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      // Comments talk ABOUT the counter constantly; only code can print one.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      if (!new RegExp(OF_BETWEEN_HOLES.source).test(line)) return;
      const qualifier = QUALIFIED_OF[path];
      if (qualifier === undefined || !line.includes(qualifier)) {
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "a bare `${a} of ${b}` outside list-core.ts is a second counter wearing the one "
      + "counter's look. Either build it with `listCounterText`, or qualify it with a "
      + `noun and record that word in QUALIFIED_OF:\n${offenders.join("\n")}`,
  );
});

/**
 * The counter's own marker is the `disclosure` pair (`▴`/`▾`), never the
 * `scroll` pair (`↑`/`↓`) — because the action bar prints the scroll pair as
 * the NAME OF A KEY (`↑↓ select`). One look, one meaning, checked on the
 * rendered rows rather than on the glyph table.
 *
 * ASCII glyph mode is skipped on purpose and not as an oversight: there the
 * two pairs are both `^`/`v` (a documented, unavoidable collision — the
 * inventory is width-matched and there is no other one-cell ASCII arrow), and
 * `theme.ts` records why it is harmless: a chip's key sits at the head of a
 * chip and a disclosure at the tail of a counter, so the two never share a
 * line position.
 */
for (const surface of ZONED_SURFACES.filter((entry) => entry.counter)) {
  for (const mode of ZONE_MODES.filter((entry) => !entry.theme.ascii)) {
    test(`(c) ${surface.id} ${mode.label}: the counter's marker is never the arrow-key glyph`, async () => {
      for (const size of ZONE_SIZES) {
        const { plain } = await surface.render(size, mode.theme, ZONE_OVERFLOWING);
        const counter = plain.find((row) => /\d+ of \d+/.test(row));
        assert.ok(counter, `${surface.id} @${size.width}x${size.height}: no counter to check`);
        const tail = counter.slice(counter.search(/\d+ of \d+/));
        assert.match(
          tail,
          new RegExp(`[${mode.theme.glyph("disclosureUp")}${mode.theme.glyph("disclosureDown")}]`),
          `${surface.id} @${size.width}x${size.height}: ${JSON.stringify(tail)}`,
        );
        assert.doesNotMatch(
          tail,
          new RegExp(`[${mode.theme.glyph("scrollUp")}${mode.theme.glyph("scrollDown")}]`),
          `${surface.id} @${size.width}x${size.height}: the counter is wearing the arrow KEYS' `
            + `look: ${JSON.stringify(tail)}`,
        );
      }
    });
  }
}
