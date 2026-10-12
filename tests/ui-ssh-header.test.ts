/**
 * The SSH-target chrome (src/ui/render-frame.ts, src/ui/dashboard-frame.ts):
 * it must show up whenever a target is active, as the Terminal-Look spec's
 * muted, lowercase `ssh:<host>` segment (principles 5/9 — "one muted status
 * line ... role muted, never coloured"). Controller decision B (composition
 * phase) moved this segment — along with approval mode, model and branch —
 * off the top header and onto the always-on bottom status line, so this
 * suite now targets the status line instead of the header it used to live
 * in (Fix round 1, Critical 3's header priority scheme is retired along
 * with the header segment itself).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const theme = createTheme({ level: 0 });

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

test("no active SSH target: the status line shows no ssh segment", () => {
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
  assert.doesNotMatch(statusLine(frame.lines), /ssh:/);
});

test("an active SSH target shows up in the status line as ssh:<host>, exactly as typed, once /ssh <alias> is set", () => {
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({ sshHost: "vps" }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  assert.match(statusLine(frame.lines), /ssh:vps/);
});

test("the header carries only the workspace path now — no approval, model, branch, or ssh duplicated there", () => {
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({ sshHost: "vps" }),
    // D8d: a real transcript, not an empty one. This test's own concern —
    // the header carries only the workspace path, nothing else duplicated —
    // is about the ORDINARY header, which D8d leaves untouched; an empty
    // `blocks: []` here would instead hit the pure-hub state, where D8d's
    // own header-suppression rule now legitimately omits the workspace path
    // (absorbed into the hub's own brand-block context line, so there is
    // nothing left to duplicate) — a different, deliberate behavior this
    // test was never meant to exercise.
    blocks: [{ id: "user-1", kind: "user", text: "hi", attachmentCount: 0, at: 0 }],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const header = plainText(frame.lines[0]!);
  assert.match(header, /routercode/);
  assert.doesNotMatch(header, /ssh:|ask|sonnet-4\.5/);
});

test("the ssh segment is an ordinary status detail — it drops before approval mode, model, and cost at a narrow width, never outranking them", () => {
  // Priority 75 (render-frame.ts's statusSegments) sits below the phase/
  // approval-mode segment (100), cost (96), and model (95) — the same
  // "protect identity first" ordering the header used to apply, now on the
  // status line. Empirically probed: width 110 still shows it, width 45
  // does not, while approval/model/cost remain.
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
      sshHost: "produktionsserver",
      costToday: "$1.23 today",
    },
  });
  assert.match(plainText(wide.lines[wide.lines.length - 2]!), /ssh:produktionsserver/);

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
      sshHost: "produktionsserver",
      costToday: "$1.23 today",
    },
  });
  const status = plainText(narrow.lines[narrow.lines.length - 2]!);
  assert.doesNotMatch(status, /ssh:/, "the ssh segment must be among the first things dropped now");
  assert.match(status, /auto-edit/, "the approval mode must still be showing");
});

test("buildFrame keeps every line within the requested width even with the ssh segment present", () => {
  const frame = buildFrame({
    width: 50,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode" },
    status: {
      phase: "ask",
      role: "muted",
      model: "sonnet-4.5",
      sshHost: "vps",
      costToday: "$0.31 today",
    },
  });
  for (const line of frame.lines) {
    assert.ok(lineWidth(line) <= 50, `Zeile zu breit: ${plainText(line)}`);
  }
});

test("the compact Route Core mark is right-aligned in the header and drops before the workspace at a narrow width", () => {
  const wide = buildFrame({
    width: 100,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/project", brandMark: ">-*" },
  });
  assert.match(plainText(wide.lines[0]!), />-\*\s*$/);

  const narrow = buildFrame({
    width: 12,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/project", brandMark: ">-*" },
  });
  const header = plainText(narrow.lines[0]!);
  assert.doesNotMatch(header, />-\*/);
});
