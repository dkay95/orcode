/**
 * V4-B zone anatomy on the Settings surface — the sibling of
 * `tests/ui-zone-anatomy.test.ts`, in the same style and at the same three
 * sizes in the same three modes.
 *
 * `settings-tui.test.ts` pins what the surface SAYS (its snapshots, its
 * copy, its intents). These pin what its ANATOMY must be, at every size and
 * in every rendering mode, so a future change cannot quietly lose one of the
 * rules the redesign rests on:
 *
 *   1. repaint safety — exactly `height` rows, no row wider than `width`;
 *   2. zone 1 is present and is the screen's ONE loud line, degrading to the
 *      divider rule wherever colour cannot speak;
 *   3. the tab bar carries EVERY category at every width, and marks the live
 *      one by shape rather than hue — and never by the `❯` a cursor owns;
 *   4. zone 2's rows are `Name  value  explanation` at levels 3 / 3b / 4,
 *      with `─ <Section>` headings at level 2;
 *   5. overflow is disclosed on exactly ONE counter, in `N of M · ▾` form;
 *   6. zone 3's keys are real and whole, and `Esc` is never what disappears;
 *   7. a locked row keeps warn AND the word `Locked`, in every mode;
 *   8. the declared shed order holds down to the 40×8 floor;
 *   9. ASCII glyph mode stays byte-pure ASCII.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_READ_ONLY_REASONS } from "../src/settings-controller.js";
import type { SettingsViewModel } from "../src/settings-controller.js";
import type { SettingsCategory, SettingsItem } from "../src/settings-registry.js";
import { buildSettingsFrame } from "../src/ui/settings-frame.js";
import { lineWidth, plainText, type Line } from "../src/ui/spans.js";
import { createTheme, type Theme } from "../src/ui/theme.js";

/** The plan's three sizes: the supported floor, the owner's PTY, a roomy terminal. */
const SIZES = [
  { width: 40, height: 12 },
  { width: 80, height: 24 },
  { width: 100, height: 28 },
] as const;

/**
 * The three rendering modes. `ascii` deliberately keeps full colour: glyph
 * mode and colour level are independent axes, and the ASCII pin is about the
 * bytes, not the SGR.
 */
const MODES = [
  { label: "color", theme: createTheme({ level: 3 }) },
  { label: "NO_COLOR", theme: createTheme({ level: 0 }) },
  { label: "ASCII", theme: createTheme({ level: 3, ascii: true }) },
] as const;

const CATEGORIES: readonly SettingsCategory[] = [
  { id: "models", label: "Models", description: "" },
  { id: "accounts", label: "Accounts", description: "" },
  { id: "approvals-costs", label: "Approvals & Costs", description: "" },
  { id: "tools", label: "Tools", description: "" },
  { id: "appearance", label: "Appearance", description: "" },
];

const SECTIONS = ["Main model", "Summarizing", "Cross pair", "Architect"] as const;

/**
 * Twenty rows in four sections — twenty-four body lines, so the list
 * genuinely overflows even the roomiest of the three sizes and the counter
 * has something to disclose everywhere.
 */
function rows(): SettingsItem[] {
  return SECTIONS.flatMap((section, group) =>
    Array.from({ length: 5 }, (_, index): SettingsItem => ({
      id: `setting-${group}-${index}` as SettingsItem["id"],
      categoryId: "models",
      label: `Setting ${group}.${index}`,
      description: `what setting ${group}.${index} does`,
      aliases: [],
      displayValue: `value-${group}-${index}`,
      editor: { kind: "readonly" },
      affectsActiveRun: false,
      section,
      // One locked row, so the honesty layer is on screen at the top of every
      // window regardless of size.
      ...(group === 0 && index === 1 ? { disabledReason: "Run active" } : {}),
    })),
  );
}

function view(overrides: Partial<SettingsViewModel> = {}): SettingsViewModel {
  const items = rows();
  return {
    categories: CATEGORIES,
    items,
    allItems: items,
    selectedCategoryId: "models",
    selectedItemId: items[0]!.id,
    search: { active: false, query: "" },
    readOnlyReason: null,
    runActive: false,
    notice: null,
    ...overrides,
  } as SettingsViewModel;
}

function frame(
  size: { width: number; height: number },
  theme: Theme,
  overrides: Partial<SettingsViewModel> = {},
): Line[] {
  return buildSettingsFrame({
    width: size.width,
    height: size.height,
    theme,
    view: view(overrides),
  }).frame.lines;
}

function assertRepaintSafe(lines: readonly Line[], size: { width: number; height: number }, label: string): void {
  assert.equal(
    lines.length,
    size.height,
    `${label}: the frame must fill exactly ${size.height} rows, not ${lines.length}`,
  );
  lines.forEach((item, index) => {
    assert.ok(
      lineWidth(item) <= size.width,
      `${label}: row ${index} is ${lineWidth(item)} cells wide at width ${size.width} `
        + `— it would soft-wrap and shift every row below it: ${JSON.stringify(plainText(item))}`,
    );
  });
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const size of SIZES) {
  const at = `${size.width}x${size.height}`;
  for (const mode of MODES) {
    const label = `settings @${at} ${mode.label}`;
    const theme = mode.theme;

    test(`${label}: the zoned frame stays repaint-safe`, () => {
      assertRepaintSafe(frame(size, theme), size, label);
    });

    test(`${label}: zone 1 is present, and is the screen's ONE loud line`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      const titleRow = lines.find((line) => plainText(line).includes("Settings"));
      assert.ok(titleRow, `${label}: no title bar`);
      assert.equal(lines.indexOf(titleRow!), 0, `${label}: the bar is the frame's first line`);
      assert.match(
        plainText(titleRow!),
        new RegExp(`Settings${escape(theme.glyph("chevron"))}Models`),
        label,
      );
      const inverse = lines.filter((line) => line.spans.some((part) => part.role === "inverse"));
      if (theme.level === 0) {
        // Shape, not colour: the bar degrades to the divider rule, and no
        // role is doing any signalling at all at this level.
        assert.equal(inverse.length, 0, label);
        assert.match(plainText(titleRow!), new RegExp(`^${escape(theme.glyph("divider"))} `), label);
      } else {
        assert.equal(inverse.length, 1, `${label}: exactly one loud line per screen`);
        assert.equal(inverse[0], titleRow, `${label}: and it is the title bar`);
        assert.equal(lineWidth(titleRow!), size.width - 1, `${label}: the bar fills its line`);
      }
    });

    test(`${label}: the tab bar carries every category, live one marked by shape`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      const tabs = plainText(lines[1]!);
      const live = theme.glyph("bullet");
      const idle = theme.glyph("bulletOff");
      // Every category is present at every width — the LABEL may shrink to
      // nothing, the tab never does. A category the reader cannot see is a
      // category they cannot know to press for.
      CATEGORIES.forEach((_, index) => {
        assert.match(
          tabs,
          new RegExp(`${escape(index === 0 ? live : idle)}${index + 1}`),
          `${label}: category ${index + 1} missing from ${JSON.stringify(tabs)}`,
        );
      });
      // The live one reads from its filled bullet at EVERY colour level —
      // bold does not survive level 0, so hue may never be the only signal.
      assert.match(tabs, new RegExp(`^${escape(live)}1`), label);
      // And it is never the `❯` a cursor owns: deleting the second cursor is
      // the point of the tab bar.
      assert.doesNotMatch(tabs, new RegExp(escape(theme.glyph("marker"))), label);
    });

    test(`${label}: zone 2 rows carry name, value and explanation at their own levels`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      const selected = lines.find((line) => plainText(line).startsWith(`${theme.glyph("marker")} `));
      assert.ok(selected, `${label}: the selected row must wear the marker`);
      // Level 2 behind the marker — accent + bold, and no inverse bar (that
      // is the title bar's, and there is only one).
      assert.equal(selected!.spans[0]!.role, "accent", label);
      assert.equal(selected!.spans[0]!.bold, true, label);
      assert.equal(selected!.spans.some(({ role }) => role === "inverse"), false, label);
      // The value is level 3b and the explanation level 4 — one look per
      // meaning, so the two are told apart by role as well as by position.
      const value = selected!.spans.find(({ text }) => text.includes("value-0-0"));
      assert.ok(value, `${label}: the row must state its value`);
      assert.equal(value!.role, "accent", label);
      assert.equal(value!.bold, undefined, label);
      if (size.width >= 80) {
        const explanation = selected!.spans.find(({ text }) => text.includes("what setting 0.0 does"));
        assert.ok(explanation, `${label}: the row must state its explanation`);
        assert.equal(explanation!.role, "muted", label);
      }
      // A section heading is a RULE, not a padded name (FIX-5 ruling 2's
      // shape, shared with `buildListLines`), and its text is level 2.
      const heading = lines.find((line) => plainText(line) === `${theme.glyph("divider")} Main model`);
      assert.ok(heading, `${label}: the first section must introduce itself`);
      assert.equal(heading!.spans[0]!.role, "structure", label);
      assert.equal(heading!.spans[1]!.role, "accent", label);
      assert.equal(heading!.spans[1]!.bold, true, label);
    });

    test(`${label}: overflow is disclosed on the one counter, as "N of M · ▾"`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      const counters = lines.filter((line) => /\d+ of \d+/.test(plainText(line)));
      assert.equal(counters.length, 1, `${label}: exactly one line may count this list`);
      const sep = escape(theme.glyph("separator"));
      const up = escape(theme.glyph("disclosureUp"));
      const down = escape(theme.glyph("disclosureDown"));
      assert.match(
        plainText(counters[0]!),
        new RegExp(`1 of 20${sep}(${up}|${down}|${up}${down})$`),
        label,
      );
    });

    test(`${label}: zone 3 is present, with keys the surface really binds`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      const bar = plainText(lines.at(-1)!);
      // The way OUT is on the bar in every mode and at every size — the one
      // chip that may never be shed. Brackets stand in for the emphasis
      // wherever colour cannot carry it.
      assert.match(bar, theme.level === 0 ? /\[Esc\] back$/ : /(^| )Esc back$/, label);
      // A chip is whole or absent — never a cut key or a cut word.
      assert.doesNotMatch(bar, new RegExp(`${escape(theme.glyph("ellipsis"))}$`), label);
      const arrows = `${theme.glyph("scrollLeft")}${theme.glyph("scrollRight")}`;
      if (size.width >= 80) {
        // 79 cells hold every chip the surface binds.
        assert.ok(bar.includes(arrows), `${label}: ${JSON.stringify(bar)}`);
        assert.ok(bar.includes("category"), `${label}: ${JSON.stringify(bar)}`);
      } else {
        // At the 40-column floor whole chips go, lowest priority first: the
        // two arrow hints (both discoverable by pressing an arrow) before
        // `/ search`, and long before the way out.
        assert.ok(bar.includes("change"), `${label}: ${JSON.stringify(bar)}`);
        assert.equal(bar.includes(arrows), false, `${label}: ${JSON.stringify(bar)}`);
      }
    });

    test(`${label}: a locked row keeps its warn role AND the word Locked`, () => {
      const lines = frame(size, theme);
      const locked = lines.find((line) => plainText(line).includes("Locked"));
      assert.ok(locked, `${label}: the honesty layer must survive the redesign visibly`);
      assert.ok(
        locked!.spans.some(({ role, text }) => role === "warn" && text.includes("Locked")),
        `${label}: the reason must keep the warn role, not just the word`,
      );
      // At colour level 0 the role says nothing, so the WORD has to carry it
      // — which is exactly why the row spells `Locked` and does not rely on
      // hue alone.
      assert.match(plainText(locked!), /Locked/u, label);
    });

    test(`${label}: the declared shed order holds — title, tabs, rows, bar`, () => {
      const lines = frame(size, theme);
      assertRepaintSafe(lines, size, label);
      // 1. the title bar is never shed;
      assert.match(plainText(lines[0]!), /Settings/u, label);
      // 2. every category is still on the tab bar (asserted above);
      // 4. at least two SETTING rows survive (a heading is not a row a
      //    reader can act on);
      const settingRows = lines.filter((line) => /^(?:. )?Setting \d\.\d/.test(plainText(line)));
      assert.ok(
        settingRows.length >= 2,
        `${label}: only ${settingRows.length} setting rows survived`,
      );
      // 5. the action bar is the last zone, and it sheds chips, not itself.
      assert.match(plainText(lines.at(-1)!), /back$/u, label);
    });

    if (theme.ascii) {
      test(`${label}: every zone stays byte-pure ASCII`, () => {
        for (const line of frame(size, theme)) {
          const text = plainText(line);
          // eslint-disable-next-line no-control-regex
          assert.equal(/^[\x00-\x7f]*$/.test(text), true, `${label}: ${JSON.stringify(text)}`);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Review fix round — F1 (monotonic disclosure) and F2 (the summary is not a
// tab).
// ---------------------------------------------------------------------------

/** How much the state summary is disclosing: none < compact < full. */
function statusRank(tabLine: string): 0 | 1 | 2 {
  if (/Read-only|Run active/.test(tabLine)) return 2;
  if (/Locked|Running/.test(tabLine)) return 1;
  return 0;
}

/** How much the tab bar is disclosing: the number of category LABELS shown. */
function labelCount(tabLine: string): number {
  return CATEGORIES.filter(({ label }) => tabLine.includes(label)).length;
}

const STATE_OVERRIDES = [
  { label: "run active", overrides: { runActive: true } },
  { label: "read-only", overrides: { readOnlyReason: SETTINGS_READ_ONLY_REASONS.foreignConfig } },
  { label: "idle", overrides: {} },
] as const;

for (const state of STATE_OVERRIDES) {
  for (const mode of MODES) {
    /**
     * F1 (controller ruling). Disclosure on the tab row may only ever DEGRADE
     * with width. It used to un-degrade: `Run active` showed at 40 columns,
     * vanished from 70 to 80 — the owner's own PTY — because the tab ladder
     * jumped to full labels (69 cells) and left nothing, and came back at 82.
     * Wider terminal, less state, which is the class of riddle V4 exists to
     * kill.
     *
     * Swept per column rather than at sample widths, because the failure was
     * a BAND: any pin that happened to sample 40 and 100 would have passed
     * over it. Both channels are asserted, so the fix cannot be bought by
     * making the tab bar non-monotone instead.
     */
    test(`settings tab row (${state.label}, ${mode.label}): disclosure never un-degrades from 40 to 110`, () => {
      let previousStatus = 0;
      let previousLabels = 0;
      let previousWidth = 0;
      for (let width = 40; width <= 110; width += 1) {
        const lines = frame({ width, height: 20 }, mode.theme, state.overrides);
        assertRepaintSafe(lines, { width, height: 20 }, `${state.label} @${width}`);
        const tabLine = plainText(lines[1]!);
        const status = statusRank(tabLine);
        const labels = labelCount(tabLine);
        assert.ok(
          status >= previousStatus,
          `${state.label} @${width}: the summary degraded from ${previousStatus} to ${status} `
            + `as the terminal got WIDER (was ${previousWidth} cells): ${JSON.stringify(tabLine)}`,
        );
        assert.ok(
          labels >= previousLabels,
          `${state.label} @${width}: the tab bar dropped from ${previousLabels} labels to ${labels} `
            + `as the terminal got WIDER: ${JSON.stringify(tabLine)}`,
        );
        previousStatus = status;
        previousLabels = labels;
        previousWidth = width;
      }
    });

    /**
     * F2. At exact-fit widths the summary sat ONE space from the last tab,
     * tighter than the two-space inter-tab gap — so at colour level 0, where
     * no hue separates them, `○5 Appearance Read-only` read as a sixth
     * category. The gap is now at least the inter-tab gap at every width.
     */
    test(`settings tab row (${state.label}, ${mode.label}): the summary is never a sixth tab`, () => {
      for (let width = 40; width <= 110; width += 1) {
        const tabLine = plainText(frame({ width, height: 20 }, mode.theme, state.overrides)[1]!);
        if (statusRank(tabLine) === 0) continue;
        const summary = /(Read-only|Run active|Locked|Running)$/.exec(tabLine.trimEnd());
        assert.ok(summary, `${state.label} @${width}: ${JSON.stringify(tabLine)}`);
        const gap = /( +)(?:Read-only|Run active|Locked|Running)$/.exec(tabLine.trimEnd());
        assert.ok(
          gap && gap[1]!.length >= 2,
          `${state.label} @${width}: the summary must stand at least two cells clear of the `
            + `last tab, or it reads as one: ${JSON.stringify(tabLine)}`,
        );
      }
    });
  }
}

/**
 * The controller's named widths, stated as a table so the band is readable at
 * a glance rather than only implied by the sweep above. Five categories never
 * need the compact rung (see the next pin for the rung that does fire), so the
 * summary is FULL at every supported width — the strongest possible form of
 * "never un-degrades".
 */
test("the named widths 40/60/70/75/80/100 all disclose the state in full", () => {
  for (const width of [40, 60, 70, 75, 80, 100]) {
    const tabLine = plainText(frame({ width, height: 20 }, MODES[1]!.theme, { runActive: true })[1]!);
    assert.equal(statusRank(tabLine), 2, `@${width}: ${JSON.stringify(tabLine)}`);
    assert.match(tabLine, /Run active$/u, `@${width}`);
    // And every category is still there, at every one of those widths.
    CATEGORIES.forEach((_, index) => {
      assert.match(tabLine, new RegExp(`[●○]${index + 1}`), `@${width}: category ${index + 1}`);
    });
  }
});

/**
 * The ladder's lower rungs are real, not decoration. With enough categories
 * the ordinals floor squeezes the summary, and it degrades in the declared
 * order — full, then compact, then (only once even the compact form cannot
 * stand two cells clear of the floor) absent. The tab bar is never the thing
 * that gives way once it is at its floor: every category survives all three.
 */
test("the summary degrades full → compact → absent, and never at a category's expense", () => {
  const denseCategories = (count: number): SettingsCategory[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `category-${index}` as SettingsCategory["id"],
      label: `Category ${index}`,
      description: "",
    }));
  const tabLine = (count: number): string => {
    const categories = denseCategories(count);
    return plainText(buildSettingsFrame({
      width: 40,
      height: 20,
      theme: createTheme({ level: 0 }),
      view: view({
        categories,
        selectedCategoryId: categories[0]!.id,
        runActive: true,
      }),
    }).frame.lines[1]!);
  };
  assert.match(tabLine(5), /Run active$/u);
  assert.match(tabLine(10), /Running$/u);
  const dropped = tabLine(11);
  assert.equal(statusRank(dropped), 0, dropped);
  // Even at the rung where the summary is gone, every category is present —
  // and the fact it carried is still on every row the state affects.
  for (let index = 0; index < 11; index += 1) {
    assert.match(dropped, new RegExp(`[●○]${index + 1}(?![0-9])`), `${index + 1} in ${dropped}`);
  }
});

/**
 * F3. The counter's cells are reserved on EVERY row that can carry it,
 * including a section heading. With today's longest heading this could not
 * actually collide above the floor, so it was latent — pinned here against a
 * heading long enough to have collided, swept over the heights that put a
 * heading last in the window.
 */
test("a section heading carrying the counter keeps it, however long the heading", () => {
  const long = "Costs, budgets and spending limits";
  const items: SettingsItem[] = Array.from({ length: 12 }, (_, index) => ({
    id: `setting-${index}` as SettingsItem["id"],
    categoryId: "models",
    label: `Setting ${index}`,
    description: `what setting ${index} does`,
    aliases: [],
    displayValue: `value-${index}`,
    editor: { kind: "readonly" },
    affectsActiveRun: false,
    // One item per section, so headings and rows alternate and some height
    // is bound to leave a heading last in the window.
    section: `${long} ${index}`,
  }));
  let headingCarriedIt = 0;
  for (let height = 9; height <= 24; height += 1) {
    const lines = buildSettingsFrame({
      width: 40,
      height,
      theme: createTheme({ level: 0 }),
      view: view({ items, allItems: items, selectedItemId: items[0]!.id }),
    }).frame.lines;
    assertRepaintSafe(lines, { width: 40, height }, `heading counter @40x${height}`);
    const counters = lines.filter((line) => /\d+ of \d+/.test(plainText(line)));
    assert.equal(counters.length, 1, `@40x${height}: the overflow must be disclosed exactly once`);
    if (plainText(counters[0]!).startsWith(`${createTheme({ level: 0 }).glyph("divider")} `)) {
      headingCarriedIt += 1;
    }
  }
  assert.ok(
    headingCarriedIt > 0,
    "the sweep must actually exercise a heading as the last visible row",
  );
});

/**
 * F4, refuted with evidence rather than changed. At colour level 0 the title
 * bar (`- Settings > Models`) and a section heading (`- Main model`) share the
 * `- <text>` shape, which the reviewer accepted as the mockup's own
 * degradation. Two things keep them apart mechanically, and both are pinned
 * so the refutation cannot rot: the bar is ALWAYS the frame's first line, and
 * it is the only line on the screen that carries a chevron.
 */
for (const mode of MODES) {
  test(`settings @80x24 ${mode.label}: only the title bar carries a crumb chevron`, () => {
    const lines = frame({ width: 80, height: 24 }, mode.theme);
    const chevron = mode.theme.glyph("chevron");
    const carrying = lines.filter((line) => plainText(line).includes(chevron));
    assert.equal(carrying.length, 1, `chevron appears on ${carrying.length} lines`);
    assert.equal(carrying[0], lines[0], "and it is the frame's first line");
    // A section heading shares the leading rule but never the chevron.
    const heading = lines.find((line) => plainText(line) === `${mode.theme.glyph("divider")} Main model`);
    assert.ok(heading, "the fixture must render a section heading");
    assert.doesNotMatch(plainText(heading!), new RegExp(escape(chevron)));
  });
}

/**
 * The floor, spelled out: 40×8 is the smallest supported terminal
 * (`MIN_WIDTH`/`MIN_HEIGHT`), and the shed order exists so that it is still a
 * usable surface rather than a stub. Rule 3 — the enclosing rule sheds before
 * the second setting row does — only ever fires here.
 */
for (const mode of MODES) {
  test(`settings @40x8 ${mode.label}: the floor keeps title, every tab, two rows and the bar`, () => {
    const size = { width: 40, height: 8 } as const;
    const lines = frame(size, mode.theme);
    assertRepaintSafe(lines, size, `floor ${mode.label}`);
    assert.match(plainText(lines[0]!), /Settings/u);
    const tabs = plainText(lines[1]!);
    CATEGORIES.forEach((_, index) => {
      assert.match(tabs, new RegExp(`${index + 1}`), `category ${index + 1} at the floor`);
    });
    // The rule is the one thing that sheds, and only because it would cost
    // the second setting row.
    assert.equal(
      lines.some((line) => /^[-─]+$/u.test(plainText(line).trim()) && lines.indexOf(line) === 2),
      false,
      "the enclosing rule sheds before the second setting row does",
    );
    const settingRows = lines.filter((line) => /^(?:. )?Setting \d\.\d/.test(plainText(line)));
    assert.ok(settingRows.length >= 2, `only ${settingRows.length} setting rows at the floor`);
    assert.match(plainText(lines.at(-1)!), /back$/u);
  });
}
