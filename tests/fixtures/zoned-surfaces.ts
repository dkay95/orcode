/**
 * The register of ZONED SURFACES — every screen that has adopted the V4
 * anatomy (`src/ui/zones.ts`), in one place, rendered the way a terminal
 * really receives them.
 *
 * V4-C, lane item 2(a)/3. `tests/ui-zone-anatomy.test.ts` and
 * `tests/ui-zone-anatomy-settings.test.ts` pin what each of two surfaces
 * looks like in detail. Neither can answer the question the level rule
 * actually raises — "does EVERY zoned surface still obey it?" — because
 * neither knows the other exists, and a surface adopting zones tomorrow is
 * covered by nobody. This module is that missing list:
 *
 *   - `tests/ui-zone-cross-surface.test.ts` sweeps it for the four shared
 *     invariants at three sizes in three rendering modes;
 *   - `tests/ui-zone-levels-tripwire.test.ts` sweeps it for the level rule
 *     AND checks the register is COMPLETE — a module that imports the zone
 *     primitives and is not represented here fails the tripwire, so a new
 *     surface inherits the checks by being forced to enrol.
 *
 * Everything is asserted on PAINTED ROWS (`renderLines`' own output, SGR
 * included) rather than on `Line` objects, for two reasons: it is the one
 * shape every surface here can produce — the plain picker
 * (`ui/list-plain.ts`) writes strings to a channel and has no frame to
 * inspect — and it is the same channel the real-PTY journeys (J-F/J-G,
 * `scripts/check-journeys.mjs`) assert on, so a fact proved here and a fact
 * proved on the shipped binary are proved about the same bytes.
 */

import { EventEmitter } from "node:events";
import { routeCoreCompact, routeCoreLarge } from "../../src/branding.js";
import { renderContextLines, type ContextViewSession } from "../../src/commands.js";
import type { SettingsViewModel } from "../../src/settings-controller.js";
import type { SettingsCategory, SettingsItem } from "../../src/settings-registry.js";
import { displayWidth } from "../../src/ui/compose.js";
import {
  buildDashboardFrame,
  type DashboardFrameInput,
  type DashboardState,
} from "../../src/ui/dashboard-frame.js";
import { listActionChips } from "../../src/ui/keymap.js";
import { pickFromListPlain, type PlainListChoice, type PlainListIo } from "../../src/ui/list-plain.js";
import { buildSettingsFrame } from "../../src/ui/settings-frame.js";
import { plainText, type Line } from "../../src/ui/spans.js";
import { createTheme, type Theme } from "../../src/ui/theme.js";
import { actionBarLine } from "../../src/ui/zones.js";
import { renderLines } from "../../src/ui/compose.js";

const HOME = "/Users/owner";

/** The plan's three sizes: the supported floor, the owner's PTY, a roomy terminal. */
export const ZONE_SIZES = [
  { width: 40, height: 12 },
  { width: 80, height: 24 },
  { width: 100, height: 28 },
] as const;

export type ZoneSize = (typeof ZONE_SIZES)[number];

/**
 * The three rendering modes. `ascii` deliberately keeps full colour: glyph
 * mode and colour level are independent axes, and the ASCII pin is about the
 * bytes, not the SGR.
 */
export const ZONE_MODES = [
  { label: "color", theme: createTheme({ level: 3 }) },
  { label: "NO_COLOR", theme: createTheme({ level: 0 }) },
  { label: "ASCII", theme: createTheme({ level: 3, ascii: true }) },
] as const;

/** `chalk.inverse` — zone 1's whole loudness, and the only role that opens with it. */
export const INVERSE_OPEN = "\x1b[7m";

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

/** One surface, rendered: the bytes a terminal gets, and the text under them. */
export interface ZonedRender {
  /** Painted rows, SGR included — exactly what `renderLines` hands to stdout. */
  readonly painted: readonly string[];
  /** The same rows with every SGR sequence removed. */
  readonly plain: readonly string[];
}

export interface ZonedSurfaceSpec {
  readonly id: string;
  readonly label: string;
  /**
   * The `src/` module that adopts the zone primitives for this surface. The
   * tripwire's completeness check compares this against the real import
   * graph, so a new adopter cannot ship without enrolling here.
   */
  readonly module: string;
  /** The crumb its title bar must carry, joined through the theme's own chevron. */
  crumb(theme: Theme): string;
  /**
   * Zone 3's delivery:
   * - `own` — its own row inside the surface's block; present at every size.
   * - `help-row` — the dashboard frame's help row, which the frame is allowed
   *   to shed WHOLE at the height floor to protect the transcript.
   * - `none` — a printed view that writes into the transcript and binds no
   *   keys of its own (`/context`).
   */
  readonly actionBar: "own" | "help-row" | "none";
  /** A surface with a scrolling list, and therefore with the universal counter. */
  readonly counter: boolean;
  /** Lays out against a hard terminal width (a printed view does not). */
  readonly bounded: boolean;
  /** Repaints a fixed rectangle, so the row count must equal the height exactly. */
  readonly fillsHeight: boolean;
  /** Text that can only appear on a CONTENT row — never on the title bar. */
  contentProbe(theme: Theme): string;
  render(size: ZoneSize, theme: Theme, entries: number): ZonedRender | Promise<ZonedRender>;
}

function fromLines(lines: readonly Line[], theme: Theme): ZonedRender {
  return {
    painted: renderLines(lines, theme),
    plain: lines.map((item) => plainText(item)),
  };
}

/** SGR removed; nothing else is, because nothing else is ever in a painted row. */
export function stripSgr(row: string): string {
  return row.replace(new RegExp(SGR.source, "g"), "");
}

export function rowWidth(row: string): number {
  return displayWidth(stripSgr(row));
}

// ---------------------------------------------------------------------------
// The dashboard frame's three list-shaped surfaces.
// ---------------------------------------------------------------------------

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
  size: ZoneSize,
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

/**
 * `entry-0`, `entry-1`, … — deliberately not a `/command` or a model id, so
 * a row can never be mistaken for a crumb, a chip or a counter by a
 * substring check.
 */
function entries(count: number): { name: string; description: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `entry-${index}`,
    description: `what entry ${index} does`,
  }));
}

const ENTRY_PROBE = "entry-0";

// ---------------------------------------------------------------------------
// The Settings surface.
// ---------------------------------------------------------------------------

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "models", label: "Models", description: "" },
  { id: "accounts", label: "Accounts", description: "" },
  { id: "approvals-costs", label: "Approvals & Costs", description: "" },
  { id: "tools", label: "Tools", description: "" },
  { id: "appearance", label: "Appearance", description: "" },
];

function settingsItems(count: number): SettingsItem[] {
  return Array.from({ length: count }, (_, index): SettingsItem => ({
    id: `setting-${index}` as SettingsItem["id"],
    categoryId: "models",
    label: `entry-${index}`,
    description: `what entry ${index} does`,
    aliases: [],
    displayValue: `value-${index}`,
    editor: { kind: "readonly" },
    affectsActiveRun: false,
    section: "Main model",
  }));
}

function settingsView(count: number): SettingsViewModel {
  const items = settingsItems(count);
  return {
    categories: SETTINGS_CATEGORIES,
    items,
    allItems: items,
    selectedCategoryId: "models",
    selectedItemId: items[0]!.id,
    search: { active: false, query: "" },
    readOnlyReason: null,
    runActive: false,
    notice: null,
  } as SettingsViewModel;
}

// ---------------------------------------------------------------------------
// The plain picker — driven through its own channel, because that IS its
// surface: it writes rows to a stream instead of building a frame.
// ---------------------------------------------------------------------------

class PlainOutput extends EventEmitter {
  isTTY = true;
  columns: number;
  written = "";
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write(value: string): boolean {
    this.written += value;
    return true;
  }
}

class PlainInput extends EventEmitter {
  isTTY = true;
  setRawMode(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

async function renderPlainPicker(size: ZoneSize, theme: Theme, count: number): Promise<ZonedRender> {
  const input = new PlainInput();
  const output = new PlainOutput(size.width);
  const channel = {
    input: input as unknown as PlainListIo["input"],
    output: output as unknown as PlainListIo["output"],
  };
  const choices: PlainListChoice<string>[] = entries(count).map((entry) => ({
    value: entry.name,
    name: entry.name,
    description: entry.description,
  }));
  const picked = pickFromListPlain({ title: "Choose an entry", choices }, channel, theme);
  await new Promise((resolve) => setImmediate(resolve));
  const frame = output.written;
  input.emit("keypress", "", { name: "escape", ctrl: false, meta: false });
  await picked;
  // The picker repaints by moving the cursor up and erasing (`clearFrame`),
  // then writing the whole frame again — so the last frame is everything
  // after the final erase, and the trailing newline is the write's own.
  const lastErase = frame.lastIndexOf("\x1b[0J");
  const body = lastErase < 0 ? frame : frame.slice(lastErase + "\x1b[0J".length);
  const painted = body.replace(/\n$/, "").split("\n");
  return { painted, plain: painted.map(stripSgr) };
}

// ---------------------------------------------------------------------------
// `/context` — a PRINTED view: it writes into the scrolling transcript, so it
// has no fixed height, no width of its own and no keys of its own.
// ---------------------------------------------------------------------------

function contextSession(count: number): ContextViewSession {
  return {
    summary: "",
    turns: Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `entry-${index}`,
      createdAt: "2026-08-21T09:00:00.000Z",
      id: `turn-${index}`,
    })),
    toolCalls: [],
  };
}

// ---------------------------------------------------------------------------
// The register.
// ---------------------------------------------------------------------------

export const ZONED_SURFACES: readonly ZonedSurfaceSpec[] = Object.freeze([
  {
    id: "palette",
    label: "the command palette",
    module: "src/ui/dashboard-frame.ts",
    crumb: (theme) => ["Commands", "Models"].join(theme.glyph("chevron")),
    actionBar: "own",
    counter: true,
    bounded: true,
    fillsHeight: true,
    contentProbe: () => ENTRY_PROBE,
    render: (size, theme, count) => fromLines(
      buildDashboardFrame(frameInput(size, theme, {
        input: "/co",
        cursor: 3,
        list: {
          entries: entries(count),
          selectedIndex: 0,
          breadcrumb: ["Commands", "Models"].join(theme.glyph("chevron")),
          footer: actionBarLine(
            theme,
            listActionChips(theme, "Palette", { enter: "insert", esc: "close", tab: "complete" }),
            { leadingDivider: true, width: Math.max(1, size.width - 1) },
          ),
        },
      })).lines,
      theme,
    ),
  },
  {
    id: "model-picker",
    label: "the fullscreen model picker",
    module: "src/ui/dashboard-frame.ts",
    crumb: (theme) => ["Settings", "Models", "Main model"].join(theme.glyph("chevron")),
    actionBar: "help-row",
    counter: true,
    bounded: true,
    fillsHeight: true,
    contentProbe: () => ENTRY_PROBE,
    render: (size, theme, count) => fromLines(
      buildDashboardFrame(frameInput(size, theme, {
        mode: "model-picker",
        list: {
          entries: entries(count).map((entry) => ({ ...entry, current: entry.name === ENTRY_PROBE })),
          selectedIndex: 0,
          heading: ["Settings", "Models", "Main model"].join(theme.glyph("chevron")),
        },
      })).lines,
      theme,
    ),
  },
  {
    id: "choice-picker",
    label: "the fullscreen choice picker",
    module: "src/ui/dashboard-frame.ts",
    crumb: (theme) => ["Settings", "Tools", "Verification"].join(theme.glyph("chevron")),
    actionBar: "help-row",
    counter: true,
    bounded: true,
    fillsHeight: true,
    contentProbe: () => ENTRY_PROBE,
    render: (size, theme, count) => fromLines(
      buildDashboardFrame(frameInput(size, theme, {
        mode: "choice-picker",
        list: {
          entries: entries(count),
          selectedIndex: 0,
          heading: ["Settings", "Tools", "Verification"].join(theme.glyph("chevron")),
        },
      })).lines,
      theme,
    ),
  },
  {
    /**
     * V4-B's edit state — the same picker one level deeper: the crumb has
     * GROWN by the edited row's own name, and the row's current value is
     * stated above the list (`Current: <value>`). It is registered as its own
     * surface because that extra chrome comes out of the same row budget, and
     * a budget bug here shows up as an invariant break, not as a wrong pixel.
     */
    id: "settings-editor",
    label: "a Settings editor (the grown crumb + Current: line)",
    module: "src/ui/dashboard-frame.ts",
    crumb: (theme) => ["Settings", "Models", "Main model"].join(theme.glyph("chevron")),
    actionBar: "help-row",
    counter: true,
    bounded: true,
    fillsHeight: true,
    contentProbe: () => ENTRY_PROBE,
    render: (size, theme, count) => fromLines(
      buildDashboardFrame(frameInput(size, theme, {
        mode: "choice-picker",
        list: {
          entries: entries(count),
          selectedIndex: 0,
          heading: ["Settings", "Models", "Main model"].join(theme.glyph("chevron")),
          currentValue: "value-0",
        },
      })).lines,
      theme,
    ),
  },
  {
    id: "settings",
    label: "the Settings surface",
    module: "src/ui/settings-frame.ts",
    crumb: (theme) => ["Settings", "Models"].join(theme.glyph("chevron")),
    actionBar: "own",
    counter: true,
    bounded: true,
    fillsHeight: true,
    contentProbe: () => ENTRY_PROBE,
    render: (size, theme, count) => fromLines(
      buildSettingsFrame({
        width: size.width,
        height: size.height,
        theme,
        view: settingsView(count),
      }).frame.lines,
      theme,
    ),
  },
  {
    id: "plain-picker",
    label: "the plain (non-fullscreen) picker, through its own channel",
    module: "src/ui/list-plain.ts",
    // This surface's callers own no hierarchy, so its bar carries a title and
    // an optional context joined on the separator — never a crumb chevron.
    crumb: () => "Choose an entry",
    actionBar: "own",
    counter: true,
    bounded: true,
    // It PRINTS its frame into the scrolling terminal (it repaints by moving
    // the cursor up), so its row count follows its list, never a height.
    fillsHeight: false,
    contentProbe: () => ENTRY_PROBE,
    render: renderPlainPicker,
  },
  {
    id: "context",
    label: "/context (a printed view)",
    module: "src/commands.ts",
    crumb: (theme) => ["Chat", "Context"].join(theme.glyph("chevron")),
    // A printed view binds no keys and lays out against no width: it writes
    // into the transcript, which wraps it like any other block.
    actionBar: "none",
    counter: false,
    bounded: false,
    fillsHeight: false,
    // The view lists turns as `1. You · ~N tokens` — it never quotes their
    // text — so the first turn's ROW is what stands for content here.
    contentProbe: () => "1. You",
    render: (_size, theme, count) => fromLines(renderContextLines(contextSession(count), null, theme), theme),
  },
]);

/** Rows that overflow every size in `ZONE_SIZES`, and rows that fit all of them. */
export const ZONE_OVERFLOWING = 24;
export const ZONE_FITTING = 2;
