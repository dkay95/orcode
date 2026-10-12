/**
 * Phase 12 (per-prompt cost forecast): the pure computation module
 * (`src/cost-forecast.ts`) — price classification honesty, the
 * chars/output-token-band math, the rolling-average fallback boundary, and
 * the final text a status line would show. `estimateTokensFromChars`
 * (`compressor.ts`) is reused directly rather than re-derived here — these
 * tests pin `cost-forecast.ts`'s OWN math against it, never a duplicate
 * ratio.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokensFromChars } from "../src/utils.js";
import {
  classifyCostForecastPrice,
  computePromptCostForecast,
  estimateOutputTokenBand,
  formatPromptCostForecast,
  FALLBACK_OUTPUT_TOKEN_BAND,
  ROLLING_AVERAGE_MIN_SAMPLES,
  type CostForecastPrice,
} from "../src/cost-forecast.js";
import { formatCostForecastBand } from "../src/utils.js";

// ---------------------------------------------------------------------------
// classifyCostForecastPrice — Controller ruling 5's three honest states.
// ---------------------------------------------------------------------------

test("a kimi-code route is always provider-managed, regardless of its cached price numbers", () => {
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "kimi-code", promptPrice: -1, completionPrice: -1 }),
    { kind: "provider-managed" },
  );
  // Even if a Kimi ModelInfo somehow carried real-looking numbers, the
  // backend alone decides — Kimi never becomes a priced route.
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "kimi-code", promptPrice: 0.000003, completionPrice: 0.000015 }),
    { kind: "provider-managed" },
  );
});

test("any non-openrouter backend (future providers included) is treated as provider-managed, never as free", () => {
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "anthropic", promptPrice: undefined, completionPrice: undefined }),
    { kind: "provider-managed" },
  );
});

test("an openrouter route with the -1 'not yet cataloged' sentinel is unpriced, not provider-managed", () => {
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "openrouter", promptPrice: -1, completionPrice: -1 }),
    { kind: "unpriced" },
  );
});

test("an openrouter route with missing or non-finite prices is unpriced", () => {
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "openrouter", promptPrice: undefined, completionPrice: 0.000015 }),
    { kind: "unpriced" },
  );
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "openrouter", promptPrice: Number.NaN, completionPrice: 0.000015 }),
    { kind: "unpriced" },
  );
});

test("an openrouter route with real non-negative prices is priced", () => {
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "openrouter", promptPrice: 0.000003, completionPrice: 0.000015 }),
    { kind: "priced", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
  );
  // A genuinely free model (0/0) is still "priced" — zero is a real,
  // known price, not the -1 unknown sentinel.
  assert.deepEqual(
    classifyCostForecastPrice({ backendId: "openrouter", promptPrice: 0, completionPrice: 0 }),
    { kind: "priced", promptUsdPerToken: 0, completionUsdPerToken: 0 },
  );
});

// ---------------------------------------------------------------------------
// estimateOutputTokenBand — rolling average + the fixed fallback's boundary.
// ---------------------------------------------------------------------------

test("estimateOutputTokenBand: below the minimum sample count, the fixed fallback band is returned untouched", () => {
  assert.deepEqual(estimateOutputTokenBand([]), FALLBACK_OUTPUT_TOKEN_BAND);
  assert.deepEqual(
    estimateOutputTokenBand(new Array(ROLLING_AVERAGE_MIN_SAMPLES - 1).fill(4_000)),
    FALLBACK_OUTPUT_TOKEN_BAND,
  );
});

test("estimateOutputTokenBand: exactly the minimum sample count already switches to the rolling average", () => {
  const samples = new Array(ROLLING_AVERAGE_MIN_SAMPLES).fill(4_000); // 1000 tokens/turn at 4 chars/token
  const band = estimateOutputTokenBand(samples);
  assert.notDeepEqual(band, FALLBACK_OUTPUT_TOKEN_BAND);
  const averageTokens = estimateTokensFromChars(4_000);
  assert.equal(band.min, Math.round(averageTokens * 0.6));
  assert.equal(band.max, Math.round(averageTokens * 1.4));
});

test("estimateOutputTokenBand: averages mixed sample sizes rather than using only the last one", () => {
  const band = estimateOutputTokenBand([400, 4_000, 400, 4_000]); // average 2200 chars
  const averageTokens = estimateTokensFromChars(2_200);
  assert.equal(band.min, Math.round(averageTokens * 0.6));
  assert.equal(band.max, Math.round(averageTokens * 1.4));
});

test("estimateOutputTokenBand: never produces a bound below 1 token even for tiny samples", () => {
  const band = estimateOutputTokenBand([1, 1]);
  assert.ok(band.min >= 1);
  assert.ok(band.max >= band.min);
});

// ---------------------------------------------------------------------------
// computePromptCostForecast / formatPromptCostForecast — the honesty gates.
// ---------------------------------------------------------------------------

test("provider-managed price always yields 'unknown', never a number and never silently absent", () => {
  const forecast = computePromptCostForecast({
    promptChars: 4_000,
    price: { kind: "provider-managed" },
    outputTokenBand: { min: 300, max: 1_500 },
  });
  assert.deepEqual(forecast, { kind: "unknown" });
  assert.equal(formatPromptCostForecast(forecast), "cost unknown");
});

test("unpriced catalog data yields no segment at all — silence, not a guess", () => {
  const forecast = computePromptCostForecast({
    promptChars: 4_000,
    price: { kind: "unpriced" },
    outputTokenBand: { min: 300, max: 1_500 },
  });
  assert.deepEqual(forecast, { kind: "none" });
  assert.equal(formatPromptCostForecast(forecast), undefined);
});

test("a priced route computes a band: shared input cost, output side spread by the token band", () => {
  const price: CostForecastPrice = { kind: "priced", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 };
  const promptChars = 4_000; // 1000 tokens at the shared 4 chars/token ratio
  const outputTokenBand = { min: 300, max: 1_500 };
  const forecast = computePromptCostForecast({ promptChars, price, outputTokenBand });
  assert.equal(forecast.kind, "band");
  const inputTokens = estimateTokensFromChars(promptChars);
  const inputCostUsd = inputTokens * price.promptUsdPerToken;
  if (forecast.kind === "band") {
    assert.ok(Math.abs(forecast.minUsd - (inputCostUsd + 300 * price.completionUsdPerToken)) < 1e-12);
    assert.ok(Math.abs(forecast.maxUsd - (inputCostUsd + 1_500 * price.completionUsdPerToken)) < 1e-12);
  }
  assert.equal(formatPromptCostForecast(forecast), formatCostForecastBand(forecast.kind === "band" ? forecast.minUsd : 0, forecast.kind === "band" ? forecast.maxUsd : 0));
});

test("a priced route's band presence and format match a realistic prompt (e.g. sonnet-class pricing)", () => {
  const price: CostForecastPrice = { kind: "priced", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 };
  const forecast = computePromptCostForecast({
    promptChars: 8_000,
    price,
    outputTokenBand: { min: 300, max: 1_500 },
  });
  const text = formatPromptCostForecast(forecast);
  assert.ok(text !== undefined);
  assert.match(text!, /^~\$\d/);
});
