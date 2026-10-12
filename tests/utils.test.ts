import assert from "node:assert/strict";
import test from "node:test";
import {
  compactNumber,
  contextLengthLabel,
  ellipsize,
  errorMessage,
  formatCatalogPricePerMillion,
  formatChatRow,
  formatCostForecastBand,
  formatMessageCount,
  formatModelRouteDetail,
  formatUsd,
  hasCode,
  isLowBalance,
  isRecord,
  MAX_RETAINED_TURNS,
  relativeAge,
  truncate,
} from "../src/utils.js";

// ---------------------------------------------------------------------------
// FIX-10 H4 (retention honesty): formatMessageCount — the one message-count
// formatter, rendering the "80+" cap marker at the retention cap.
// ---------------------------------------------------------------------------

test("H4: formatMessageCount pluralizes below the cap and never shows a cap marker there", () => {
  assert.equal(formatMessageCount(0), "0 messages");
  assert.equal(formatMessageCount(1), "1 message");
  assert.equal(formatMessageCount(2), "2 messages");
  assert.equal(formatMessageCount(MAX_RETAINED_TURNS - 1), `${MAX_RETAINED_TURNS - 1} messages`);
});

test("H4: at the retention cap the count renders as the honest '80+ messages' marker — retained-of-possibly-more, never a silently saturated bare number", () => {
  assert.equal(MAX_RETAINED_TURNS, 80);
  assert.equal(formatMessageCount(MAX_RETAINED_TURNS), "80+ messages");
});

test("H4: formatChatRow renders the cap marker through the same one formatter", () => {
  const { description } = formatChatRow(
    { title: "Long chat", turnCount: MAX_RETAINED_TURNS, costUsd: 0.5, model: "a/model" },
    Date.now(),
    undefined,
    // FIX-21: the separator is the caller's theme glyph now — required.
    " · ",
  );
  assert.match(description, /^80\+ messages · /);
});

test("isRecord akzeptiert nur echte Objekte", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(undefined), false);
});

test("hasCode erkennt Fehlercodes an Objekten", () => {
  assert.equal(hasCode({ code: "ENOENT" }, "ENOENT"), true);
  assert.equal(hasCode({ code: "EPERM" }, "ENOENT"), false);
  assert.equal(hasCode(new Error("x"), "ENOENT"), false);
  assert.equal(hasCode(null, "ENOENT"), false);
  assert.equal(hasCode("ENOENT", "ENOENT"), false);
});

test("errorMessage extrahiert Nachrichten aus beliebigen Werten", () => {
  assert.equal(errorMessage(new Error("kaputt")), "kaputt");
  assert.equal(errorMessage("text"), "text");
  assert.equal(errorMessage(42), "42");
});

test("truncate lässt kurze Texte unverändert", () => {
  assert.equal(truncate("kurz", 10), "kurz");
  assert.equal(truncate("genau zehn!", 11), "genau zehn!");
  assert.equal(truncate("", 0), "");
});

test("truncate kürzt lange Texte mit Hinweiszeile", () => {
  const long = "x".repeat(100);
  assert.equal(truncate(long, 10), `${"x".repeat(10)}\n… truncated …`);
  assert.equal(truncate("abc", 0), "\n… truncated …");
});

test("formatUsd formatiert Beträge mit adaptiver Genauigkeit", () => {
  assert.equal(formatUsd(1.23456), "$1.235");
  assert.equal(formatUsd(0.001), "$0.00100");
  // FIX-14 fix round 1 (review L1): zero is its own case, not a precision —
  // see the invariant test below.
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.01), "$0.010");
  assert.equal(formatUsd(-0.5), "$-0.500");
  assert.equal(formatUsd(-0.001), "$-0.00100");
});

// ---------------------------------------------------------------------------
// Phase 12 (per-prompt cost forecast): formatCostForecastBand — the one
// pure formatter for the status line's muted `~$min-max` estimate.
// ---------------------------------------------------------------------------

test("formatCostForecastBand renders the plan's own mockup shape: a shared '$', two decimals, ascii hyphen", () => {
  assert.equal(formatCostForecastBand(0.04, 0.09), "~$0.04-0.09");
});

test("formatCostForecastBand collapses an equal band to a single value, no dash", () => {
  assert.equal(formatCostForecastBand(0.12, 0.12), "~$0.12");
});

test("formatCostForecastBand never rounds a genuinely non-zero bound down to $0.00 — it says <$0.01 instead", () => {
  assert.equal(formatCostForecastBand(0.001, 0.002), "~<$0.01");
  assert.equal(formatCostForecastBand(0.0001, 0.0002), "~<$0.01");
});

test("formatCostForecastBand: a mixed band (one bound under a cent, one over) spells out both $ signs unambiguously", () => {
  assert.equal(formatCostForecastBand(0.001, 0.02), "~<$0.01-$0.02");
});

test("formatCostForecastBand: an exact zero bound stays $0.00 — that is honest, not a rounding-down", () => {
  assert.equal(formatCostForecastBand(0, 0), "~$0.00");
  assert.equal(formatCostForecastBand(0, 0.09), "~$0.00-0.09");
});

test("formatCostForecastBand tolerates a reversed (max < min) pair defensively without throwing or going negative-looking", () => {
  assert.equal(formatCostForecastBand(0.09, 0.04), "~$0.09");
});

test("isLowBalance (D6): below threshold is low, at/above is not, an unknown balance is never low, and 0 disables the warn at any balance", () => {
  assert.equal(isLowBalance(1, 2), true, "below threshold");
  assert.equal(isLowBalance(2, 2), false, "exactly at threshold is not low");
  assert.equal(isLowBalance(3, 2), false, "above threshold");
  assert.equal(isLowBalance(undefined, 2), false, "no cached balance is never low");
  assert.equal(isLowBalance(0, 2), true, "a real zero balance is low, same as any other real figure under threshold");
  assert.equal(isLowBalance(-5, 0), false, "0 disables the warn even at a negative balance");
  assert.equal(isLowBalance(0, 0), false, "0 disables the warn even at a zero balance");
});

test("relativeAge renders coarse, growing units (V3 Continue quick action)", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeAge(now, now), "just now");
  assert.equal(relativeAge(now, now - 30_000), "just now");
  assert.equal(relativeAge(now, now - 60_000), "1m ago");
  assert.equal(relativeAge(now, now - 2 * 60 * 60_000), "2h ago");
  assert.equal(relativeAge(now, now - 25 * 60 * 60_000), "1d ago");
  assert.equal(relativeAge(now, now + 60_000), "just now", "the future clamps to now, never negative");
});

test("compactNumber humanizes token counts the way the /model row's ctx segment shows them", () => {
  assert.equal(compactNumber(200_000), "200K");
  assert.equal(compactNumber(128_000), "128K");
  assert.equal(compactNumber(64_000), "64K");
  assert.equal(compactNumber(1_000_000), "1M");
  assert.equal(compactNumber(999), "999");
});

// F6 formatter consolidation (parked from F3 review): compactNumber's
// decimal Intl notation renders a power-of-2 context window with a
// misleading fractional digit ("131072" -> "131.1K") instead of the
// conventional binary label every model card actually shows ("128K").
// contextLengthLabel is the ctx-specific helper that fixes this without
// touching compactNumber's own global (decimal) semantics.
test("contextLengthLabel renders conventional binary-K/M labels for power-of-2 sizes, no misleading decimals", () => {
  assert.equal(contextLengthLabel(8_192), "8K");
  assert.equal(contextLengthLabel(32_768), "32K");
  assert.equal(contextLengthLabel(65_536), "64K");
  assert.equal(contextLengthLabel(131_072), "128K");
  assert.equal(contextLengthLabel(1_048_576), "1M");
});

test("contextLengthLabel falls through to compactNumber's plain compact form for round decimal sizes", () => {
  assert.equal(contextLengthLabel(200_000), "200K");
  assert.equal(contextLengthLabel(1_000_000), "1M");
  assert.equal(contextLengthLabel(999), "999");
});

test("contextLengthLabel never invents a fractional binary label for a non-power-of-2 size", () => {
  // 100_000 is not a power of 2 (nor is 12_345) — both fall through to
  // compactNumber's own decimal rounding, exactly like compactNumber itself.
  assert.equal(contextLengthLabel(100_000), compactNumber(100_000));
  assert.equal(contextLengthLabel(12_345), compactNumber(12_345));
});

test("formatCatalogPricePerMillion trims to the real value's decimals, never inflating or rounding to zero", () => {
  assert.equal(formatCatalogPricePerMillion(0.000003), "$3/M");
  assert.equal(formatCatalogPricePerMillion(0.000015), "$15/M");
  assert.equal(formatCatalogPricePerMillion(0.00000007), "$0.07/M");
  assert.equal(formatCatalogPricePerMillion(0.00000028), "$0.28/M");
  assert.equal(formatCatalogPricePerMillion(0), "$0/M", "a genuinely zero-listed price is honest, not omitted");
  assert.equal(
    formatCatalogPricePerMillion(0.00000000001),
    "$0.00001/M",
    "a real sub-cent price never silently rounds down to $0/M",
  );
});

test("formatModelRouteDetail composes <provider> · <price> · <ctx> for a known-price route", () => {
  assert.equal(
    formatModelRouteDetail({
      providerLabel: "Anthropic",
      price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
      contextLength: 200_000,
    }),
    "Anthropic · $3/M in · $15/M out · 200K",
  );
});

test("formatModelRouteDetail's ctx segment uses contextLengthLabel, not compactNumber's misleading decimal", () => {
  assert.equal(
    formatModelRouteDetail({
      providerLabel: "Anthropic",
      price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
      contextLength: 131_072,
    }),
    "Anthropic · $3/M in · $15/M out · 128K",
  );
});

test("formatModelRouteDetail shows 'subscription' for a provider-managed route, never a fabricated price", () => {
  assert.equal(
    formatModelRouteDetail({
      providerLabel: "Kimi Code",
      price: { kind: "subscription" },
      contextLength: 256_000,
    }),
    "Kimi Code · subscription · 256K",
  );
});

test("formatModelRouteDetail omits the ctx segment for an unknown (zero/non-finite) context length", () => {
  assert.equal(
    formatModelRouteDetail({
      providerLabel: "OpenRouter",
      price: { kind: "known", promptUsdPerToken: 0, completionUsdPerToken: 0 },
      contextLength: 0,
    }),
    "OpenRouter · $0/M in · $0/M out",
  );
  assert.equal(
    formatModelRouteDetail({
      providerLabel: "OpenRouter",
      price: { kind: "subscription" },
      contextLength: Number.NaN,
    }),
    "OpenRouter · subscription",
  );
});

/**
 * FIX-14 ticket 7 (one single-line truncator). Three copies of one rule
 * disagreed about whether the marker counts toward the budget, and two of
 * them broke their own promise by appending it outside the slice.
 */
test("ellipsize keeps the marker INSIDE the caller's budget, and never invents one", () => {
  assert.equal(ellipsize("short", 10), "short");
  assert.equal(ellipsize("exactly-10", 10), "exactly-10", "a value at the budget is not a cut");
  assert.equal(ellipsize("0123456789x", 10), "012345678…");
  assert.equal(ellipsize("0123456789x", 10).length, 10, "at most N means at most N");
  // FIX-14 fix round 1 (review L3): the promise holds at EVERY budget, the
  // degenerate ones included — a budget of 0 used to return the bare marker,
  // one character past it.
  assert.equal(ellipsize("abc", 1), "…");
  assert.equal(ellipsize("abc", 0), "");
  assert.equal(ellipsize("abc", -1), "");
  assert.equal(ellipsize("", 0), "");
  for (const maximum of [0, 1, 2, 3, 4, 5, 10]) {
    assert.ok(
      ellipsize("a much longer value than the budget", maximum).length <= maximum,
      `budget ${maximum}`,
    );
  }
});

/**
 * FIX-14 fix round 1 (review L1, controller ruling). Zero is the additive
 * identity, not a very small charge — so `$0.00` is reserved for it alone.
 */
test("formatUsd: $0.00 can only ever mean exactly zero — a real nonzero charge never rounds to it", () => {
  assert.equal(formatUsd(0), "$0.00");
  // The whole point of the five-decimal branch: every nonzero amount below a
  // cent keeps enough digits to stay visibly nonzero, so nothing can quietly
  // arrive at the string above.
  for (const value of [0.00001, 0.000005, 0.0001, 0.001, 0.009999, -0.00001]) {
    assert.notEqual(formatUsd(value), "$0.00", String(value));
    assert.notEqual(Number(formatUsd(value).replace("$", "")), 0, String(value));
  }
  // Zero is a case, not a precision: everything else is unchanged.
  assert.equal(formatUsd(0.00001), "$0.00001");
  assert.equal(formatUsd(0.5), "$0.500");
  assert.equal(formatUsd(14.76), "$14.760");
  // The same reading `forecastBound` already applies one function down.
  assert.equal(formatCostForecastBand(0, 0), "~$0.00");
});
