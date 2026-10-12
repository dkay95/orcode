/**
 * V4-C, lane item 3: the CROSS-SURFACE sweep.
 *
 * `tests/ui-zone-anatomy.test.ts` and `tests/ui-zone-anatomy-settings.test.ts`
 * pin two surfaces in detail — their tab ladders, their shed orders, their
 * honesty rows. This file deliberately pins NOTHING surface-specific. It
 * renders EVERY zoned surface (`tests/fixtures/zoned-surfaces.ts`) at the
 * three sizes in the three rendering modes and asserts only the four things
 * that are true of the anatomy ITSELF:
 *
 *   1. the frame is repaint-safe — no row wider than the terminal, and a
 *      fixed-rectangle surface fills exactly its height;
 *   2. zone 1 is there, is the screen's ONE loud line, and comes before any
 *      content;
 *   3. zone 3 is there whole, or shed whole — never half a chip, and never
 *      without the way out;
 *   4. the universal counter appears exactly when something is off screen,
 *      and never when nothing is.
 *
 * That is the cheap, one-place tripwire for a FUTURE surface drifting from
 * the system: the register is the thing a new adopter has to join
 * (`tests/ui-zone-levels-tripwire.test.ts` fails if it does not), and joining
 * it buys these four checks at three sizes in three modes for free.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  INVERSE_OPEN,
  ZONED_SURFACES,
  ZONE_FITTING,
  ZONE_MODES,
  ZONE_OVERFLOWING,
  ZONE_SIZES,
  rowWidth,
  type ZonedRender,
  type ZonedSurfaceSpec,
  type ZoneSize,
} from "./fixtures/zoned-surfaces.js";
import type { Theme } from "../src/ui/theme.js";

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A key chip, as the action bar prints it: the key, then one space, then a
 * lowercase effect word. At colour level 0 the key wears square brackets —
 * the shape standing in for an emphasis the terminal cannot show.
 *
 * `Esc` specifically, because it is the one chip `actionBarLine` may never
 * shed: a bar without it is a screen with no visible way out.
 */
const ESC_CHIP = /(?:^|\s)\[?Esc\]? [a-z][a-z/]*/;
/** Any chip at all — used only to prove a MISSING bar went whole. */
const SELECT_CHIP = /(?:^|\s)\[?(?:\S{1,6})\]? select(?:\s|$)/;
const COUNTER = /\d+ of \d+/;

function counterForm(theme: Theme): RegExp {
  const sep = escape(theme.glyph("separator"));
  const up = escape(theme.glyph("disclosureUp"));
  const down = escape(theme.glyph("disclosureDown"));
  return new RegExp(`\\d+ of \\d+${sep}(?:${up}|${down}|${up}${down})$`);
}

async function render(
  surface: ZonedSurfaceSpec,
  size: ZoneSize,
  theme: Theme,
  entries: number,
): Promise<ZonedRender> {
  return await surface.render(size, theme, entries);
}

for (const surface of ZONED_SURFACES) {
  for (const size of ZONE_SIZES) {
    for (const mode of ZONE_MODES) {
      const label = `${surface.id} @${size.width}x${size.height} ${mode.label}`;
      const theme = mode.theme;

      test(`${label}: every row fits the terminal, and a fixed frame fills it exactly`, async () => {
        for (const entries of [ZONE_OVERFLOWING, ZONE_FITTING]) {
          const { painted } = await render(surface, size, theme, entries);
          if (surface.fillsHeight) {
            assert.equal(
              painted.length,
              size.height,
              `${label}: a repainted frame must be exactly ${size.height} rows, not ${painted.length}`,
            );
          }
          if (!surface.bounded) continue;
          painted.forEach((row, index) => {
            assert.ok(
              rowWidth(row) <= size.width,
              `${label}: row ${index} is ${rowWidth(row)} cells wide at width ${size.width} `
                + `— it would soft-wrap and shift every row below it`,
            );
          });
        }
      });

      test(`${label}: zone 1 is present, is the ONE loud line, and comes before any content`, async () => {
        const { painted, plain } = await render(surface, size, theme, ZONE_OVERFLOWING);
        const crumb = surface.crumb(theme);
        const crumbRows = plain
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.includes(crumb));
        assert.equal(
          crumbRows.length,
          1,
          `${label}: the crumb ${JSON.stringify(crumb)} must be on exactly one row, not ${crumbRows.length}`,
        );
        const titleRow = crumbRows[0]!;
        // Nothing the reader can act on may sit above the landmark that says
        // where they are.
        const contentAt = plain.findIndex((row) => row.includes(surface.contentProbe(theme)));
        assert.ok(contentAt >= 0, `${label}: the fixture must render content at all`);
        assert.ok(
          titleRow.index < contentAt,
          `${label}: the title bar (row ${titleRow.index}) must come before the first content row (${contentAt})`,
        );
        const loud = painted
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.includes(INVERSE_OPEN));
        if (theme.level === 0) {
          // Shape, not colour: nothing signals with a role here at all, and
          // the bar degrades to the divider rule it replaced.
          assert.equal(loud.length, 0, `${label}: colour level 0 must emit no inverse run`);
          assert.match(
            plain[titleRow.index]!,
            new RegExp(`^${escape(theme.glyph("divider"))} `),
            `${label}: the degraded bar must be the divider rule`,
          );
        } else {
          assert.equal(loud.length, 1, `${label}: exactly one loud line per screen`);
          assert.equal(loud[0]!.index, titleRow.index, `${label}: and it is the title bar`);
          assert.ok(
            painted[titleRow.index]!.includes(`${INVERSE_OPEN} ${crumb}`),
            `${label}: the crumb must be painted INSIDE the inverse run, not beside it`,
          );
        }
      });

      if (surface.actionBar !== "none") {
        test(`${label}: zone 3 is whole or shed whole, and the way out never goes first`, async () => {
          const { plain } = await render(surface, size, theme, ZONE_OVERFLOWING);
          const bars = plain.filter((row) => ESC_CHIP.test(row));
          assert.ok(bars.length <= 1, `${label}: ${bars.length} rows claim to be the action bar`);
          if (bars.length === 0) {
            // Only the dashboard frame's HELP row may vanish, and only as a
            // whole: it is shed before the header and before the status line
            // to protect MIN_STREAM, a pre-V4 budget rule. A bar that lost
            // only its tail would leave a reader with keys but no way out.
            assert.equal(
              surface.actionBar,
              "help-row",
              `${label}: this surface's bar is its own row and may never be shed`,
            );
            assert.equal(
              plain.some((row) => SELECT_CHIP.test(row)),
              false,
              `${label}: the frame shed the help row wholesale, not half of it`,
            );
            return;
          }
          const bar = bars[0]!;
          // A chip is whole or absent: the bar sheds chips, `fitFrameLine`
          // never cuts one.
          assert.doesNotMatch(
            bar,
            new RegExp(`${escape(theme.glyph("ellipsis"))}\\s*$`),
            `${label}: the bar was ellipsized instead of shedding a whole chip: ${JSON.stringify(bar)}`,
          );
        });
      }

      if (surface.counter) {
        test(`${label}: the counter appears exactly when something is off screen`, async () => {
          const overflowing = await render(surface, size, theme, ZONE_OVERFLOWING);
          const counters = overflowing.plain.filter((row) => COUNTER.test(row));
          assert.equal(
            counters.length,
            1,
            `${label}: an overflowing list must disclose itself on exactly one counter`,
          );
          assert.match(counters[0]!, counterForm(theme), label);

          const fitting = await render(surface, size, theme, ZONE_FITTING);
          assert.equal(
            fitting.plain.filter((row) => COUNTER.test(row)).length,
            0,
            `${label}: a list that hides nothing must not count itself — `
              + "a pager on an unpaged list says nothing",
          );
        });
      }
    }
  }
}
