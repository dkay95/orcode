/**
 * V4-A zone anatomy, inside real frames (plan lane V4-A, "Frame-Pins
 * 100x28/80x24/40x12 in color/NO_COLOR/ASCII").
 *
 * `tests/ui-zones.test.ts` pins the primitives on their own. These pin what
 * an owner actually sees: for every adopted fullscreen surface, at the three
 * sizes and in the three rendering modes, the frame must
 *
 *   1. still be repaint-safe — exactly `height` rows, no row wider than
 *      `width` (the FIX-20 contract the new zones must not break; a wrapped
 *      line shifts every row below it),
 *   2. carry a title bar (zone 1) that is the screen's ONE loud line,
 *      degrading to the divider rule wherever colour cannot speak,
 *   3. carry an action bar (zone 3) whose keys are real, and
 *   4. disclose overflow on the ONE counter, in the `N of M · ▾` form.
 *
 * The style follows `tests/ui-frame-width-safety.test.ts`, which pins the
 * same two structural invariants for the hub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import {
  buildDashboardFrame,
  type DashboardFrameInput,
  type DashboardState,
} from "../src/ui/dashboard-frame.js";
import { listActionChips } from "../src/ui/keymap.js";
import { lineWidth, plainText, type Line } from "../src/ui/spans.js";
import { createTheme, type Theme } from "../src/ui/theme.js";
import { actionBarLine } from "../src/ui/zones.js";

const HOME = "/Users/owner";

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

function baseState(): DashboardState {
  return {
    workspace: `${HOME}/projekt/routercode`,
    model: "anthropic/claude-sonnet-4.5",
    approval: "ask",
    reasoning: "auto",
    maxCost: "$5.00",
    maxSteps: 40,
    dayUsd: 1.23,
    projectStatus: "Git main",
  };
}

function frameInput(
  size: { width: number; height: number },
  theme: Theme,
  overrides: Partial<DashboardFrameInput>,
): DashboardFrameInput {
  return {
    width: size.width,
    height: size.height,
    theme,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge(theme.ascii ? "ascii" : "unicode"),
      compactMark: routeCoreCompact(theme.ascii ? "ascii" : "unicode"),
      version: "0.7.0",
    },
    homeDir: HOME,
    ...overrides,
  } as DashboardFrameInput;
}

/** Twelve rows, so every size's list budget genuinely overflows. */
function rows(count = 12): { name: string; description: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `/command-${index}`,
    description: `what command ${index} does`,
  }));
}

/** The command palette, mid-search: crumb, chips, and a filtered counter. */
function paletteInput(
  size: { width: number; height: number },
  theme: Theme,
): DashboardFrameInput {
  return frameInput(size, theme, {
    input: "/co",
    cursor: 3,
    list: {
      entries: rows(),
      selectedIndex: 0,
      breadcrumb: "Commands",
      footer: actionBarLine(
        theme,
        listActionChips(theme, "Palette", { enter: "insert", esc: "close", tab: "complete" }),
        // The exact options `tui.ts` passes — the usable width, so the bar
        // sheds whole chips at 40 columns instead of being cut mid-chip.
        { leadingDivider: true, width: Math.max(1, size.width - 1) },
      ),
    },
  });
}

/** A fullscreen picker: heading-fed crumb, and the frame's own help-row chips. */
function pickerInput(
  size: { width: number; height: number },
  theme: Theme,
): DashboardFrameInput {
  return frameInput(size, theme, {
    mode: "model-picker",
    list: {
      entries: rows().map((row) => ({ ...row, current: row.name === "/command-0" })),
      selectedIndex: 1,
      // Built through the theme so the fixture itself never leaks a `›` into
      // the ASCII pin (the crumb text is the caller's own string; the frame
      // only renders it).
      heading: ["Settings", "Models", "Main model"].join(theme.glyph("chevron")),
    },
  });
}

const SURFACES = [
  { label: "palette", build: paletteInput },
  { label: "picker", build: pickerInput },
] as const;

function assertRepaintSafe(input: DashboardFrameInput, label: string): Line[] {
  const frame = buildDashboardFrame(input);
  assert.equal(
    frame.lines.length,
    input.height,
    `${label}: the frame must fill exactly ${input.height} rows, not ${frame.lines.length}`,
  );
  frame.lines.forEach((item, index) => {
    assert.ok(
      lineWidth(item) <= input.width,
      `${label}: row ${index} is ${lineWidth(item)} cells wide at width ${input.width} `
        + `— it would soft-wrap and shift every row below it: ${JSON.stringify(plainText(item))}`,
    );
  });
  return frame.lines;
}

for (const size of SIZES) {
  const at = `${size.width}x${size.height}`;
  for (const mode of MODES) {
    for (const surface of SURFACES) {
      const label = `${surface.label} @${at} ${mode.label}`;
      const theme = mode.theme;

      test(`${label}: the zoned frame stays repaint-safe`, () => {
        assertRepaintSafe(surface.build(size, theme), label);
      });

      test(`${label}: zone 1 is present, and is the screen's ONE loud line`, () => {
        const lines = assertRepaintSafe(surface.build(size, theme), label);
        const crumb = surface.label === "palette" ? "Commands" : "Main model";
        const titleRow = lines.find((line) => plainText(line).includes(crumb));
        assert.ok(titleRow, `${label}: no title bar carrying ${JSON.stringify(crumb)}`);
        const inverse = lines.filter((line) => line.spans.some((part) => part.role === "inverse"));
        if (theme.level === 0) {
          // Shape, not colour: the bar degrades to the divider rule, and no
          // role is doing any signalling at all at this level.
          assert.equal(inverse.length, 0, label);
          assert.match(plainText(titleRow!), new RegExp(`^${theme.glyph("divider")} `), label);
        } else {
          assert.equal(inverse.length, 1, `${label}: exactly one loud line per screen`);
          assert.equal(inverse[0], titleRow, `${label}: and it is the title bar`);
          assert.match(plainText(titleRow!), /^ /, label);
        }
      });

      test(`${label}: zone 3 is present, with keys the surface really binds`, () => {
        const lines = assertRepaintSafe(surface.build(size, theme), label);
        const bar = lines.find((line) => plainText(line).includes("Esc"));
        // The picker renders its bar as the frame's HELP row, and at the
        // 40x12 floor `render-frame.ts` sheds that row (before the header,
        // before the status line) to keep MIN_STREAM — a pre-V4 budget rule
        // that protects the transcript and is deliberately not re-litigated
        // here. The palette's bar lives inside the expansion block and is
        // therefore present at every supported size.
        if (!bar && surface.label === "picker" && size.height < 20) {
          assert.equal(
            lines.some((line) => plainText(line).includes("select")),
            false,
            `${label}: the frame shed the help row wholesale, not half of it`,
          );
          return;
        }
        assert.ok(bar, `${label}: no action bar`);
        const text = plainText(bar!);
        // The way OUT is on the bar in every mode and at every size — the one
        // chip that may never be shed (`ActionBarOptions.width`). Brackets
        // stand in for the emphasis wherever colour cannot carry it.
        assert.match(
          text,
          theme.level === 0 ? /\[Esc\] (close|cancel)/ : /(^| )Esc (close|cancel)/,
          label,
        );
        // A chip is whole or absent — never a cut key or a cut word.
        assert.doesNotMatch(text, new RegExp(`${theme.glyph("ellipsis").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), label);
        const arrows = `${theme.glyph("scrollUp")}${theme.glyph("scrollDown")}`;
        if (size.width >= 80) {
          // With room, every chip the surface asked for is there.
          assert.ok(text.includes(arrows), `${label}: ${JSON.stringify(text)}`);
          assert.ok(text.includes("select"), `${label}: ${JSON.stringify(text)}`);
        } else {
          // At the floor the bar sheds whole chips, lowest priority first —
          // the arrows and the filter hint (both discoverable by trying) go
          // before Enter's verb and long before the way out.
          assert.ok(text.includes("Enter"), `${label}: ${JSON.stringify(text)}`);
          assert.equal(text.includes(arrows), false, `${label}: ${JSON.stringify(text)}`);
        }
      });

      test(`${label}: zone 2's overflow is disclosed on the one counter, as "N of M · ▾"`, () => {
        const lines = assertRepaintSafe(surface.build(size, theme), label);
        const counter = lines.find((line) => /\d+ of \d+/.test(plainText(line)));
        assert.ok(counter, `${label}: an overflowing list must say so`);
        const sep = theme.glyph("separator").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const up = theme.glyph("disclosureUp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const down = theme.glyph("disclosureDown").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(plainText(counter!), new RegExp(`\\d+ of \\d+${sep}(${up}|${down}|${up}${down})$`), label);
        // One counter, not two: the palette's old footer count is gone.
        assert.equal(
          lines.filter((line) => /\d+ of \d+/.test(plainText(line))).length,
          1,
          `${label}: exactly one line may count this list`,
        );
      });

      test(`${label}: the reported row geometry matches the rows actually drawn`, () => {
        // Fix round 1 (review MINOR 5 + MAJOR 1): no pin used to render a
        // fullscreen picker whose list is LONGER than its row budget, which
        // is exactly the shape that hides an off-by-one in the window. The
        // fixtures here hold 12 rows at every size. `Frame.listRows` is what
        // the pointer maps against, so it must name the lines that really
        // carry rows — first and last included, nothing off by one.
        const input = surface.build(size, theme);
        const frame = buildDashboardFrame(input);
        const geometry = frame.listRows;
        assert.ok(geometry, `${label}: the frame must report its row geometry`);
        assert.ok(geometry!.count > 0 && geometry!.count < 12, `${label}: the list must overflow its budget`);
        for (let offset = 0; offset < geometry!.count; offset += 1) {
          const text = plainText(frame.lines[geometry!.firstLine + offset]!);
          const entry = input.list!.entries[geometry!.startIndex + offset]!;
          assert.ok(
            text.slice(2).startsWith(entry.name),
            `${label}: reported row ${offset} should read ${JSON.stringify(entry.name)}, got ${JSON.stringify(text)}`,
          );
        }
        // The line above the first row is chrome (the title bar), and the one
        // after the last is not a row either — the boundaries are exact.
        const before = plainText(frame.lines[geometry!.firstLine - 1]!);
        assert.equal(
          input.list!.entries.some((entry) => before.slice(2).startsWith(entry.name)),
          false,
          `${label}: the line above the window must not be a row: ${JSON.stringify(before)}`,
        );
      });

      if (theme.ascii) {
        test(`${label}: every zone stays byte-pure ASCII`, () => {
          const lines = assertRepaintSafe(surface.build(size, theme), label);
          for (const line of lines) {
            const text = plainText(line);
            // eslint-disable-next-line no-control-regex
            assert.equal(/^[\x00-\x7f]*$/.test(text), true, `${label}: ${JSON.stringify(text)}`);
          }
        });
      }
    }
  }
}
