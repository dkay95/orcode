/**
 * D6 (the cost thread): the always-on bottom status line's shared
 * balance/day segment (`src/ui/dashboard-frame.ts`'s `statusInfo`, painted
 * by `src/ui/render-frame.ts`'s `statusSegments`). Ordinarily this segment
 * is just the day-spend figure (`$Y today`, muted) — below the configured
 * low-balance threshold it gains an explicit `balance low` marker and
 * switches to the warn role. Mirrors tests/ui-cross-armed-status.test.ts's
 * approach to the same idle identity chrome.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { plainText, type Span } from "../src/ui/spans.js";
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
function statusSpans(frame: ReturnType<typeof buildDashboardFrame>): readonly Span[] {
  return frame.lines[frame.lines.length - 2]!.spans;
}

function statusLine(frame: ReturnType<typeof buildDashboardFrame>): string {
  return plainText(frame.lines[frame.lines.length - 2]!);
}

function frame(state: DashboardState, level: 0 | 3 = 0) {
  return buildDashboardFrame({
    width: 100,
    height: 24,
    theme: createTheme({ level }),
    state,
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "",
  });
}

test("with no cached balance, the day-spend segment renders exactly as it always did — untouched", () => {
  const line = statusLine(frame(baseState({ dayUsd: 0.42 })));
  assert.match(line, /\$0\.420 today/);
  assert.doesNotMatch(line, /\blow\b/);
});

test("below the configured threshold, the segment gains an explicit 'balance low' marker ahead of the day spend", () => {
  const line = statusLine(frame(baseState({
    dayUsd: 0.42,
    balanceRemainingUsd: 1,
    lowBalanceThresholdUsd: 2,
  })));
  assert.match(line, /balance low · \$0\.420 today/);
});

test("below the threshold with no day spend known, the segment shows 'balance low' alone — never a fabricated $0 figure", () => {
  const line = statusLine(frame(baseState({
    balanceRemainingUsd: 1,
    lowBalanceThresholdUsd: 2,
  })));
  assert.match(line, /balance low/);
  assert.doesNotMatch(line, /today/);
});

test("at or above the threshold, the segment stays the plain day-spend figure — no marker", () => {
  const line = statusLine(frame(baseState({
    dayUsd: 0.42,
    balanceRemainingUsd: 2,
    lowBalanceThresholdUsd: 2,
  })));
  assert.match(line, /\$0\.420 today/);
  assert.doesNotMatch(line, /\blow\b/);
});

test("a 0 threshold disables the warn entirely, however small the remaining balance is", () => {
  const line = statusLine(frame(baseState({
    dayUsd: 0.42,
    balanceRemainingUsd: 0.01,
    lowBalanceThresholdUsd: 0,
  })));
  assert.match(line, /\$0\.420 today/);
  assert.doesNotMatch(line, /\blow\b/);
});

test("an unset lowBalanceThresholdUsd behaves like 0 (disabled) — a caller that never threads config through never fabricates a warn", () => {
  const line = statusLine(frame(baseState({ dayUsd: 0.42, balanceRemainingUsd: 0.01 })));
  assert.doesNotMatch(line, /\blow\b/);
});

test("the low-balance segment actually paints the warn role at a real colour level, not just the wording", () => {
  const spans = statusSpans(frame(baseState({
    dayUsd: 0.42,
    balanceRemainingUsd: 1,
    lowBalanceThresholdUsd: 2,
  }), 3));
  const balanceSpan = spans.find((span) => span.text.includes("balance low"));
  assert.ok(balanceSpan, "the balance-low segment must render as its own span");
  assert.equal(balanceSpan?.role, "warn");
});

test("NO_COLOR parity: at colour level 0, the same 'balance low' wording still carries the warning on its own — nothing is lost", () => {
  const spans = statusSpans(frame(baseState({
    dayUsd: 0.42,
    balanceRemainingUsd: 1,
    lowBalanceThresholdUsd: 2,
  }), 0));
  const balanceSpan = spans.find((span) => span.text.includes("balance low"));
  assert.ok(balanceSpan, "the wording itself must be present regardless of colour level");
});
