/**
 * FIX-20, finding 8 (the repaint-debris family): the frame's width contract.
 *
 * `TerminalUi.render` repaints partially by absolute row address
 * (`ESC[<row>;1H` per changed line) and trusts that frame line N occupies
 * exactly physical row N. One line wider than the terminal breaks that for
 * every row below it — the terminal soft-wraps it, the displaced row is
 * never rewritten, and the frame reads one row out of place. That is the
 * single root cause behind the owner's "status line rendered twice, the
 * separator gone" after `/new`, `/model` and `/help`, behind the hub's
 * stranded welcome-box row, and behind an empty-state line still standing
 * under async-filled Recent rows.
 *
 * These pins hold the two invariants the repaint depends on, at three
 * sizes: the frame is exactly `height` lines, and no line is wider than
 * `width`. The 80×24 case is the owner's own PTY size — reproduced here
 * with the deep worktree path whose composer placeholder is what actually
 * overflowed there.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import {
  buildDashboardFrame,
  type DashboardFrameInput,
  type DashboardState,
} from "../src/ui/dashboard-frame.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const THEME = createTheme({ level: 0 });
const HOME = "/Users/owner";
/** Long enough that the hub's "Type to start a new chat in …" placeholder overflows 80 columns. */
const DEEP_WORKSPACE = `${HOME}/projekt/routercode/.worktrees/orcode-fix20-feedback`;
/** The three sizes this pin covers: the supported floor, the owner's PTY, and a roomy terminal. */
const SIZES = [
  { width: 40, height: 8 },
  { width: 80, height: 24 },
  { width: 100, height: 30 },
] as const;

function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    workspace: DEEP_WORKSPACE,
    model: "anthropic/claude-sonnet-4.5",
    approval: "ask",
    reasoning: "auto",
    maxCost: "$5.00",
    maxSteps: 40,
    dayUsd: 1.23,
    projectStatus: "Git main",
    ...overrides,
  };
}

function frameInput(
  size: { width: number; height: number },
  overrides: Partial<DashboardFrameInput> = {},
): DashboardFrameInput {
  return {
    width: size.width,
    height: size.height,
    theme: THEME,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
    brand: {
      showLargeLogo: true,
      showHeaderMark: true,
      largeLines: routeCoreLarge("unicode"),
      compactMark: routeCoreCompact("unicode"),
      version: "0.7.0",
    },
    quickGroups: [
      { label: "/help", hint: "commands" },
      { label: "/model", hint: "switch model" },
      { label: "/chats", hint: "open a chat" },
      { label: "/settings", hint: "preferences" },
    ],
    homeDir: HOME,
    ...overrides,
  } as DashboardFrameInput;
}

function assertRepaintSafe(input: DashboardFrameInput, label: string): void {
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
}

const RECENT: NonNullable<DashboardState["recentChats"]> = [
  {
    id: "a1",
    title: "Cross failure rendering never names the failing role",
    turnCount: 12,
    costUsd: 0.1234,
    updatedAt: Date.UTC(2026, 7, 26, 9, 0, 0),
    workspace: DEEP_WORKSPACE,
  },
  {
    id: "b2",
    title: "A chat that lives in a completely different folder",
    turnCount: 3,
    costUsd: 0.004,
    updatedAt: Date.UTC(2026, 7, 25, 9, 0, 0),
    workspace: `${HOME}/projekt/some-other-checkout`,
  },
];

for (const size of SIZES) {
  const at = `${size.width}x${size.height}`;

  test(`the hub frame stays repaint-safe at ${at}`, () => {
    assertRepaintSafe(frameInput(size), `hub @${at}`);
  });

  test(`a transient status ("New chat started.") keeps the frame repaint-safe at ${at}`, () => {
    assertRepaintSafe(
      frameInput(size, { status: "New chat started.", statusFresh: true }),
      `status @${at}`,
    );
  });

  test(`async-filled Recent rows keep the hub frame repaint-safe at ${at}`, () => {
    // The empty-state line and the filled rows are two renders of the same
    // frame; both must fill the same row count, or the fill leaves the
    // empty-state line standing underneath.
    const empty = buildDashboardFrame(frameInput(size));
    assertRepaintSafe(
      frameInput(size, { state: baseState({ recentChats: RECENT }) }),
      `recent @${at}`,
    );
    const filled = buildDashboardFrame(
      frameInput(size, { state: baseState({ recentChats: RECENT }) }),
    );
    assert.equal(
      empty.lines.length,
      filled.lines.length,
      `recent @${at}: the async fill must not change the frame's row count`,
    );
  });

  test(`the help footer keeps the frame repaint-safe at ${at}`, () => {
    assertRepaintSafe(
      frameInput(size, { input: "?", cursor: 1, helpRequested: true }),
      `help @${at}`,
    );
  });
}
