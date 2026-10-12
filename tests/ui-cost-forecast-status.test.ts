/**
 * Phase 12 (per-prompt cost forecast): the status-line segment
 * (`src/ui/dashboard-frame.ts`'s `statusInfo`, painted by
 * `src/ui/render-frame.ts`'s `statusSegments`). Mirrors
 * tests/ui-cross-armed-status.test.ts's and tests/ui-status-balance.test.ts's
 * approach to the same idle identity chrome: build a `DashboardState`
 * fixture through `buildDashboardFrame` for the honesty/gating behavior,
 * and `buildFrame` directly (bypassing the gating) for the priority/width
 * ordering the plan's own "status-line width safety at 40 cols" bullet asks
 * for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import {
  computePromptCostForecast,
  formatPromptCostForecast,
  type CostForecastPrice,
} from "../src/cost-forecast.js";

const PRICED: CostForecastPrice = {
  kind: "priced",
  promptUsdPerToken: 0.000003,
  completionUsdPerToken: 0.000015,
};

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

/**
 * The idle identity status line always leads with the approval mode
 * (`baseState`'s fixed "ask"). Found by content rather than a fixed offset
 * from the end: unlike the sibling status-line test files, several tests
 * here feed a non-empty, multi-row-wrapping draft into the composer, which
 * shifts the status line further up than `lines.length - 2`.
 */
function statusLine(lines: ReturnType<typeof buildDashboardFrame>["lines"]): string {
  const found = lines.map(plainText).find((line) => /^ask\b/.test(line));
  assert.ok(found !== undefined, "no identity status line (leading with the approval mode) found in the frame");
  return found!;
}

// ---------------------------------------------------------------------------
// Presence, format and the honesty gates.
// ---------------------------------------------------------------------------

test("a priced route with a non-empty draft shows the muted ~$min-max band", () => {
  const theme = createTheme({ level: 0 });
  const draft = "x".repeat(400); // 100 tokens at the shared 4 chars/token ratio — short enough to stay on one input row
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: draft,
    cursor: draft.length,
    status: "",
  });
  const expected = formatPromptCostForecast(
    computePromptCostForecast({
      promptChars: draft.length,
      price: PRICED,
      outputTokenBand: { min: 300, max: 1_500 },
    }),
  )!;
  assert.match(expected, /^~/);
  const line = statusLine(frame.lines);
  assert.ok(line.includes(expected), `expected status line to include ${JSON.stringify(expected)}, got ${JSON.stringify(line)}`);
});

test("end to end, a comfortably-priced route renders the plan's own mockup shape (~$min-max, two decimals, shared $)", () => {
  const theme = createTheme({ level: 0 });
  const draft = "x".repeat(40); // 10 tokens — a short prompt; the output band alone already clears 1 cent
  const price: CostForecastPrice = { kind: "priced", promptUsdPerToken: 0.00001, completionUsdPerToken: 0.00005 };
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: price,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: draft,
    cursor: draft.length,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.match(line, /~\$0\.02-0\.08/);
});

test("a provider-managed route (Kimi) shows 'cost unknown', never a number and never silently absent", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: { kind: "provider-managed" },
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: "how do I fix this bug",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.match(line, /cost unknown/);
  assert.doesNotMatch(line, /\$\d/, "a provider-managed route must never show a dollar figure");
});

test("an openrouter route the catalog has no price for shows no segment at all — silence, not a guess", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: { kind: "unpriced" },
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: "how do I fix this bug",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.doesNotMatch(line, /cost unknown/);
  assert.doesNotMatch(line, /~\$|\$\d/);
});

test("no active route info at all (costForecastPrice absent) also shows no segment — same honest default", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState(),
    blocks: [],
    mode: "input",
    input: "how do I fix this bug",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.doesNotMatch(line, /cost unknown|~\$/);
});

test("an empty draft shows no forecast segment, even on a fully priced route", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
  assert.doesNotMatch(statusLine(frame.lines), /~\$/);
});

test("a whitespace-only draft counts as empty — no forecast segment", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "input",
    input: "   \n  ",
    cursor: 0,
    status: "",
  });
  assert.doesNotMatch(statusLine(frame.lines), /~\$/);
});

test("no forecast segment while a run is active, even with a non-empty queued draft", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "busy",
    input: "next task while this one runs",
    cursor: 0,
    status: "",
    run: {
      phase: "Model streaming response",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      step: 1,
      maxSteps: 40,
      costUsd: 0.01,
      running: true,
    },
  });
  // A run replaces the idle identity chrome entirely (no line leads with
  // the approval mode any more), so this checks the whole frame rather than
  // `statusLine`'s "ask"-anchored search.
  const fullText = frame.lines.map(plainText).join("\n");
  assert.doesNotMatch(fullText, /~\$|cost unknown/);
});

test("a picker's own filter text is never mistaken for the composer draft — no forecast segment while a picker is open", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 100,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
    }),
    blocks: [],
    mode: "model-picker",
    input: "claude", // the picker's own filter text, not a prompt draft
    cursor: 0,
    status: "",
  });
  assert.doesNotMatch(statusLine(frame.lines), /~\$|cost unknown/);
});

// ---------------------------------------------------------------------------
// Controller ruling 4: Cross-armed chats omit the segment entirely — a
// single-model estimate would understate a 4-6-call run, and the `cross:`
// segment already discloses the multiplier.
// ---------------------------------------------------------------------------

test("an armed Cross chat never shows the single-model forecast alongside cross:, even with a priced route", () => {
  const theme = createTheme({ level: 0 });
  const frame = buildDashboardFrame({
    width: 120,
    height: 24,
    theme,
    state: baseState({
      costForecastPrice: PRICED,
      costForecastContextChars: 0,
      costForecastOutputTokenBand: { min: 300, max: 1_500 },
      crossArmed: { lead: "anthropic/claude-sonnet-5", challenger: "openai/gpt-6" },
    }),
    blocks: [],
    mode: "input",
    input: "how do I fix this bug",
    cursor: 0,
    status: "",
  });
  const line = statusLine(frame.lines);
  assert.match(line, /cross:claude-sonnet-5\+gpt-6/);
  assert.doesNotMatch(line, /~\$|cost unknown/);
});

// ---------------------------------------------------------------------------
// Segment priority: the LEAST essential idle identity segment — drops
// before the approval mode, model, branch, ssh target, balance/day and
// Cross segments at a narrow width (plan bullet: "status-line width safety
// at 40 cols"). Built via `buildFrame` directly (same approach as
// tests/ui-cross-armed-status.test.ts's own priority test) so the gating in
// `dashboard-frame.ts`'s `statusInfo` is not itself under test here — only
// `render-frame.ts`'s priority fitter.
// ---------------------------------------------------------------------------

function statusInfoLine(width: number): string {
  const theme = createTheme({ level: 0 });
  const frame = buildFrame({
    width,
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
      branch: "main",
      sshHost: "prodserver",
      costToday: "$0.42 today",
      costForecast: "~$0.04-0.09",
    },
  });
  return plainText(frame.lines[frame.lines.length - 2]!);
}

test("at a comfortable width, every segment including the forecast fits", () => {
  const line = statusInfoLine(100);
  assert.match(line, /ask/);
  assert.match(line, /sonnet-4\.5/);
  assert.match(line, /main/);
  assert.match(line, /ssh:prodserver/);
  assert.match(line, /\$0\.42 today/);
  assert.match(line, /~\$0\.04-0.09/);
});

test("the forecast is the first identity segment dropped — it disappears while ssh, branch, model and costToday still fit", () => {
  const line = statusInfoLine(65);
  assert.doesNotMatch(line, /~\$/, "the forecast must already be gone at this width");
  assert.match(line, /ssh:prodserver/, "ssh must still be showing — it outranks the forecast");
  assert.match(line, /main\b/, "branch must still be showing — it outranks the forecast");
  assert.match(line, /sonnet-4\.5/);
  assert.match(line, /\$0\.42 today/);
});

test("at 40 columns (MIN_WIDTH), the forecast is long gone but the approval mode survives", () => {
  const line = statusInfoLine(40);
  assert.doesNotMatch(line, /~\$/);
  assert.match(line, /\bask\b/, "the approval mode is the highest-priority segment and must still show");
  assert.ok(line.length <= 40, `status line must never exceed the frame width: ${JSON.stringify(line)}`);
});
