/**
 * Phase 10 honesty guard (src/ui/render-frame.ts, src/ui/dashboard-frame.ts):
 * while persistent Cross mode is armed for a chat, the per-message
 * multi-call cost must never be invisible — the always-on bottom status
 * line's `cross:<leadShort>+<challengerShort>` segment is the one mechanism
 * that discloses it between (and before) runs, since arming intentionally
 * skips a confirmation on every message. Mirrors tests/ui-ssh-header.test.ts's
 * approach to the same idle identity chrome.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

function baseState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    workspace: "/home/user/projekt/routercode",
    model: "sonnet-4.5",
    approval: "ask",
    reasoning: "auto",
    maxCost: "$5.00",
    maxSteps: 40,
    ...overrides,
  };
}

/** The idle identity status line always sits right above the input row. */
function statusLine(lines: ReturnType<typeof buildDashboardFrame>["lines"]): string {
  return plainText(lines[lines.length - 2]!);
}

test("a disarmed chat's status line shows no cross segment", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  assert.doesNotMatch(statusLine(frame.lines), /cross:/);
});

test("an armed chat's status line shows cross:<leadShort>+<challengerShort>, using the short-model-label helper", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      crossArmed: { lead: "anthropic/claude-sonnet-5", challenger: "openai/gpt-6" },
    }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  // shortModelName strips the vendor prefix, exactly like the status line's
  // own `model` segment already does for the main model.
  assert.match(statusLine(frame.lines), /cross:claude-sonnet-5\+gpt-6/);
});

// Owner ruling (fix round 1): "waiting-to-spend must be visible like
// armed-to-spend" — a pending one-shot gets its own `cross:once:` segment,
// distinct from persistent armed mode's plain `cross:`.
test("a pending one-shot's status line shows cross:once:<leadShort>+<challengerShort>, distinct from persistent armed mode", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      crossArmed: { lead: "anthropic/claude-sonnet-5", challenger: "openai/gpt-6", oneShot: true },
    }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.match(line, /cross:once:claude-sonnet-5\+gpt-6/);
  assert.doesNotMatch(line, /cross:claude-sonnet-5\+gpt-6/, "must not also match the plain (non-once) segment form");
});

test("disarming (crossArmed absent again) removes the segment from an otherwise identical frame", () => {
  const theme = createTheme({ level: 0 });
  const armed = statusLine(buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({ crossArmed: { lead: "vendor/lead", challenger: "vendor/challenger" } }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  }).lines);
  const disarmed = statusLine(buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  }).lines);

  assert.match(armed, /cross:lead\+challenger/);
  assert.doesNotMatch(disarmed, /cross:/);
});

test("ASCII theme: the cross segment uses the ascii separator, never the unicode dot (NO_COLOR/ascii parity)", () => {
  const asciiFrame = buildFrame({
    width: 100,
    height: 24,
    theme: createTheme({ level: 0, ascii: true }),
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode" },
    status: {
      phase: "ask",
      role: "muted",
      model: "sonnet-4.5",
      crossArmed: "cross:lead+challenger",
    },
  });
  const unicodeFrame = buildFrame({
    width: 100,
    height: 24,
    theme: createTheme({ level: 0, ascii: false }),
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode" },
    status: {
      phase: "ask",
      role: "muted",
      model: "sonnet-4.5",
      crossArmed: "cross:lead+challenger",
    },
  });

  const asciiLine = plainText(asciiFrame.lines[asciiFrame.lines.length - 2]!);
  const unicodeLine = plainText(unicodeFrame.lines[unicodeFrame.lines.length - 2]!);
  assert.match(asciiLine, / - cross:lead\+challenger/);
  assert.doesNotMatch(asciiLine, /·/);
  assert.match(unicodeLine, / · cross:lead\+challenger/);
});

test("the cross segment outranks branch and ssh — it is among the last identity segments dropped at a narrow width", () => {
  const theme = createTheme({ level: 0 });
  const wide = buildFrame({
    width: 110,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode-with-a-fairly-long-name" },
    status: {
      phase: "auto-edit",
      role: "muted",
      model: "some/very-long-model-id-that-eats-space",
      branch: "main",
      sshHost: "produktionsserver",
      crossArmed: "cross:lead-model+challenger-model",
    },
  });
  assert.match(plainText(wide.lines[wide.lines.length - 2]!), /cross:lead-model\+challenger-model/);

  const narrow = buildFrame({
    width: 45,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode-with-a-fairly-long-name" },
    status: {
      phase: "auto-edit",
      role: "muted",
      model: "some/very-long-model-id-that-eats-space",
      branch: "main",
      sshHost: "produktionsserver",
      crossArmed: "cross:lead-model+challenger-model",
    },
  });
  const status = plainText(narrow.lines[narrow.lines.length - 2]!);
  assert.doesNotMatch(status, /ssh:|main\b/, "branch and ssh must be among the first things dropped");
  assert.match(status, /auto-edit/, "the approval mode must still be showing");
});

test("the header carries only the workspace path — the cross segment never duplicates onto it", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({ crossArmed: { lead: "vendor/lead", challenger: "vendor/challenger" } }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const header = plainText(frame.lines[0]!);
  assert.doesNotMatch(header, /cross:/);
});
