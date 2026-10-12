/**
 * Audit FIX-11, defects 2 and 3 — the bottom status line's two rendered
 * lies (structural audit 2026-08-28, both frame-verified).
 *
 * Defect 2: `render-frame.ts`'s `statusSegments` ranked the run's
 * cancel/escape hint BELOW the decorative "last event Xs ago" readout, so a
 * narrow terminal dropped the only rendered way out of a live run and kept
 * the telemetry. Pinned here through `buildDashboardFrame` (the real
 * `statusInfo` gating, so the interjection hint is the genuine one) at the
 * audit's own 80 columns and at a width where the two segments actually
 * compete.
 *
 * Defect 3: the permanent identity line rendered `ask  · gpt-5.4  · main  ·
 * $1.23 today` — its segments prepend their own `· ` separator while the
 * fitter added its default two-space gap in front of it, contradicting
 * `render-frame.ts`'s own documented single-space form. Nothing pinned the
 * spacing, which is how it survived; the exact strings below now do.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const NOW = 1_700_000_000_000;

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

/** The status line is always the row directly above the input row. */
function statusLine(frame: ReturnType<typeof buildDashboardFrame>): string {
  return plainText(frame.lines[frame.lines.length - 2]!);
}

/** A live, interjectable run — the exact state the audit's frame captured. */
function runFrame(width: number, ascii = false) {
  return buildDashboardFrame({
    width,
    height: 24,
    theme: createTheme({ level: 0, ascii }),
    state: baseState(),
    blocks: [],
    mode: "busy",
    input: "",
    cursor: 0,
    status: "",
    interjectable: true,
    now: NOW,
    run: {
      phase: "Model working",
      startedAt: NOW - 12_000,
      lastEventAt: NOW - 1_000,
      step: 3,
      maxSteps: 40,
      costUsd: 0.0123,
      running: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Defect 3 — the permanent identity line's exact spacing.
// ---------------------------------------------------------------------------

function identityLine(width: number, ascii = false): string {
  const frame = buildFrame({
    width,
    height: 24,
    theme: createTheme({ level: 0, ascii }),
    blocks: [],
    inputText: "",
    inputCursor: 0,
    header: { workspace: "/home/user/projekt/routercode" },
    status: {
      phase: "ask",
      role: "muted",
      model: "gpt-5.4",
      branch: "main",
      costToday: "$1.23 today",
    },
  });
  return plainText(frame.lines[frame.lines.length - 2]!);
}

test("the permanent status line joins its segments with single spaces — the documented `ask · gpt-5.4 · main · $1.23 today` form, exactly", () => {
  assert.equal(identityLine(100), "ask · gpt-5.4 · main · $1.23 today");
});

test("the same single-space join holds in ASCII mode, where the separator is the theme's own '-'", () => {
  assert.equal(identityLine(100, true), "ask - gpt-5.4 - main - $1.23 today");
});

test("the end-to-end idle dashboard renders that identity line with no double spaces anywhere", () => {
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme: createTheme({ level: 0 }),
    state: baseState({ dayUsd: 1.23, projectStatus: "routercode · Git main" }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame);
  assert.match(line, /^ask · /);
  assert.doesNotMatch(line, / {2}/, `the identity line must never contain a double space: ${JSON.stringify(line)}`);
});

test("a run's status line keeps its unchanged two-space grouping — only the separator-carrying identity segments changed", () => {
  assert.match(statusLine(runFrame(120)), /Model working {2}00:12 {2}Step 3\/40/);
});

// ---------------------------------------------------------------------------
// Defect 2 — the cancel/escape hint outranks the last-event telemetry.
// ---------------------------------------------------------------------------

test("the escape hint outranks the running cost and the step counter — at the width where only one of them fits, the hint is what stays", () => {
  const line = statusLine(runFrame(50));
  assert.match(line, /Esc cancels/, "the only rendered way out of the run must survive");
  assert.doesNotMatch(line, /last event/, "the decorative age readout goes first");
  assert.doesNotMatch(line, /\$0\.0123/, "the running cost goes before the escape hint does");
  assert.doesNotMatch(line, /Step 3\/40/, "so does the step counter");
});

test("even at the 40-column floor the escape hint is still there, with both keys", () => {
  const line = statusLine(runFrame(42));
  assert.equal(line, "Model working  Enter queues · Esc cancels");
});

// FIX-11 addendum, controller ruling A: the escape hint is the run's ONLY
// way out, so it outranks every decorative segment at EVERY width, and where
// even that is not enough it shortens (`cancelHintCompact`) instead of
// vanishing. This is the audit's own 80-column frame, pinned whole.
test("at 80 columns with an interjection live, the escape hint renders — shortened, never dropped, and never without its keys", () => {
  const line = statusLine(runFrame(80));
  // The audit's frame at this width read `… Step 3/40  $0.0123  last event
  // 1s ago` — no way out at all. It now ends with one.
  //
  // FIX-14 ticket 3: the cost segment is `formatUsd` now (3 decimals above a
  // cent) rather than this frame's own inline `.toFixed(4)`, so the pinned
  // width shifts by one column. The point of the pin — the escape hint
  // survives at 80 columns, with both keys — is unchanged.
  assert.equal(line, "Model working  00:12  Step 3/40              $0.012  Enter queues · Esc cancels");
  assert.ok(line.length <= 80, `the status line must never exceed the frame width: ${JSON.stringify(line)}`);
});

test("the compact escape hint still names both keys and what each one does", () => {
  for (const width of [50, 60, 70, 80, 100]) {
    const line = statusLine(runFrame(width));
    assert.match(line, /\bEnter\b/, `Enter must survive at ${width} columns: ${JSON.stringify(line)}`);
    assert.match(line, /\bEsc\b/, `Esc must survive at ${width} columns: ${JSON.stringify(line)}`);
    assert.match(line, /cancels/, `the cancelling action must survive at ${width} columns: ${JSON.stringify(line)}`);
    assert.ok(line.length <= width, `status line exceeds ${width}: ${JSON.stringify(line)}`);
  }
});

test("the ASCII escape hint keeps both keys too, with the theme's own separator", () => {
  assert.match(statusLine(runFrame(80, true)), /Enter queues - Esc cancels/);
});

test("the full-length hint comes back once the width genuinely fits it, alongside the telemetry", () => {
  const line = statusLine(runFrame(130));
  assert.match(line, /last event 1s ago/);
  assert.match(line, /Type an interjection … \(Enter queues it · Esc cancels the run\)/);
});

test("the direct priority ordering: a short cancel hint outlives the age readout at the width where only one fits", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildFrame({
    width: 60,
    height: 24,
    theme,
    blocks: [],
    inputText: "",
    inputCursor: 0,
    status: {
      phase: "Model working",
      elapsedMs: 12_000,
      step: "Step 3/40",
      lastEventAgeMs: 1_000,
      cancelHint: "Ctrl+C cancels",
    },
  });
  const line = plainText(frame.lines[frame.lines.length - 2]!);
  assert.match(line, /Ctrl\+C cancels/);
  assert.doesNotMatch(line, /last event/);
});
