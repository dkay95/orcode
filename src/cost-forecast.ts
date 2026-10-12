/**
 * Phase 12 (per-prompt cost forecast, follow-up to the owner-terminal
 * redesign plan): before a normal run is even dispatched, a cheap upfront
 * estimate — prompt+context chars × the active route's cached catalog
 * pricing, plus an output allowance derived from the chat's own recent
 * assistant-turn sizes. Muted, display-only status-line chrome; it never
 * gates a run and never touches budget enforcement (grep-provable: nothing
 * here reads `maxCostUsd`/`maxSteps`/approvals, nothing here is called from
 * the dispatch path — only from the status-line seam,
 * `src/ui/dashboard-frame.ts`'s `statusInfo`).
 *
 * Reuse, never duplicate: the chars→tokens conversion is
 * `estimateTokensFromChars` from `utils.ts` — the one shared estimator
 * in orcode (see that function's own doc comment). This module adds no
 * second one; it only turns that token count, a per-token price, and an
 * output-token band into a USD range.
 *
 * Honesty (binding, per the plan):
 *   - a provider-managed route (Kimi, and anything else that isn't metered
 *     OpenRouter credit) always shows "cost unknown" — never a number,
 *     never silently absent (which would read as "free");
 *   - an OpenRouter route the cached catalog has no real price for shows
 *     NO segment at all — silence over a guess;
 *   - a priced route shows the `~$min-max` band (`formatCostForecastBand`,
 *     `utils.ts`).
 */

import { estimateTokensFromChars } from "./utils.js";
import { formatCostForecastBand } from "./utils.js";

/**
 * Fallback output-token band used until the chat has at least
 * `ROLLING_AVERAGE_MIN_SAMPLES` assistant turns to average — a first
 * message in a fresh chat still gets an honest (if wider) forecast rather
 * than none at all. Deliberately wide: 300 tokens covers a short answer,
 * 1500 covers a substantial one; real chats narrow this fast once
 * `estimateOutputTokenBand` has real samples to work from.
 */
export const FALLBACK_OUTPUT_TOKEN_BAND = Object.freeze({ min: 300, max: 1_500 });

/** Below this many recent assistant turns, the rolling average is not trusted — the fixed fallback band is used instead. */
export const ROLLING_AVERAGE_MIN_SAMPLES = 2;

/**
 * Band half-width around the rolling average, as a fraction of it (±40%).
 * A fixed spread rather than a real variance computation — turn-to-turn
 * output length varies enough that a single point estimate would overstate
 * precision, but the forecast is muted status-line chrome, not a billing
 * statement; a full standard-deviation pass over the chat's turns would add
 * complexity this segment's honesty requirement does not call for.
 */
export const OUTPUT_BAND_SPREAD = 0.4;

export interface OutputTokenBand {
  readonly min: number;
  readonly max: number;
}

/**
 * The output side of the forecast: a `{min, max}` token band. Below
 * `ROLLING_AVERAGE_MIN_SAMPLES` char-length samples (typically the chat's
 * recent assistant turns, caller's choice of window), returns the fixed
 * `FALLBACK_OUTPUT_TOKEN_BAND` untouched. From `ROLLING_AVERAGE_MIN_SAMPLES`
 * samples onward, averages their char lengths, converts via the one shared
 * `estimateTokensFromChars`, and spreads ±`OUTPUT_BAND_SPREAD` around that
 * average — never below 1 token on either bound.
 */
export function estimateOutputTokenBand(
  recentAssistantChars: readonly number[],
): OutputTokenBand {
  if (recentAssistantChars.length < ROLLING_AVERAGE_MIN_SAMPLES) {
    return FALLBACK_OUTPUT_TOKEN_BAND;
  }
  const averageChars =
    recentAssistantChars.reduce((sum, chars) => sum + Math.max(0, chars), 0)
    / recentAssistantChars.length;
  const averageTokens = estimateTokensFromChars(averageChars);
  const min = Math.max(1, Math.round(averageTokens * (1 - OUTPUT_BAND_SPREAD)));
  const max = Math.max(min, Math.round(averageTokens * (1 + OUTPUT_BAND_SPREAD)));
  return { min, max };
}

/**
 * The three honest states of "what do we know about this route's price"
 * (Controller ruling 5). Distinct from `RuntimeModelPrice`
 * (`model-runtime.ts`) and from `formatModelRouteDetail`'s
 * `"known"/"subscription"` pair (`utils.ts`) — both of those collapse
 * "provider-managed" and "genuinely unpriced" into one label, which is
 * exactly right for a route picker row ("subscription" reads fine for
 * either) but wrong here: this forecast must tell the two apart, since one
 * renders "cost unknown" and the other renders nothing at all.
 */
export type CostForecastPrice =
  | { readonly kind: "provider-managed" }
  | { readonly kind: "unpriced" }
  | {
      readonly kind: "priced";
      readonly promptUsdPerToken: number;
      readonly completionUsdPerToken: number;
    };

/**
 * Classifies a route's cached catalog price for the forecast. `backendId`
 * decides provider-managed (anything other than `"openrouter"` — Kimi
 * today, honestly extended to any future non-metered backend) regardless of
 * what the cached `ModelInfo` prices say, because both Kimi's own
 * placeholder pricing and a not-yet-cataloged OpenRouter route share the
 * same `-1` sentinel (`kimiDashboardModelInfo`/`cachedModelInfoFromRoute`,
 * `cli.ts`) — the backend is the only reliable signal between them.
 */
export function classifyCostForecastPrice(input: {
  readonly backendId: string;
  readonly promptPrice: number | undefined;
  readonly completionPrice: number | undefined;
}): CostForecastPrice {
  if (input.backendId !== "openrouter") {
    return { kind: "provider-managed" };
  }
  const { promptPrice, completionPrice } = input;
  if (
    promptPrice === undefined ||
    completionPrice === undefined ||
    !Number.isFinite(promptPrice) ||
    !Number.isFinite(completionPrice) ||
    promptPrice < 0 ||
    completionPrice < 0
  ) {
    return { kind: "unpriced" };
  }
  return { kind: "priced", promptUsdPerToken: promptPrice, completionUsdPerToken: completionPrice };
}

/** The forecast's own three display states — mirrors `CostForecastPrice`, but "priced" resolves all the way to a USD band. */
export type PromptCostForecast =
  | { readonly kind: "unknown" }
  | { readonly kind: "none" }
  | { readonly kind: "band"; readonly minUsd: number; readonly maxUsd: number };

/**
 * The upfront estimate itself: `promptChars` (draft + context, chars) at
 * the shared chars→tokens ratio, priced at `price`'s per-token rates, plus
 * `outputTokenBand`'s min/max applied to the completion rate — the point
 * input-side cost is common to both bounds, only the output side spreads
 * (Controller ruling 3: "the band bounds produce the $ range together with
 * the input-side point estimate").
 */
export function computePromptCostForecast(input: {
  readonly promptChars: number;
  readonly price: CostForecastPrice;
  readonly outputTokenBand: OutputTokenBand;
}): PromptCostForecast {
  if (input.price.kind === "provider-managed") {
    return { kind: "unknown" };
  }
  if (input.price.kind === "unpriced") {
    return { kind: "none" };
  }
  const inputTokens = estimateTokensFromChars(input.promptChars);
  const inputCostUsd = inputTokens * input.price.promptUsdPerToken;
  return {
    kind: "band",
    minUsd: inputCostUsd + input.outputTokenBand.min * input.price.completionUsdPerToken,
    maxUsd: inputCostUsd + input.outputTokenBand.max * input.price.completionUsdPerToken,
  };
}

/**
 * The exact text the status line shows, or `undefined` for "no segment at
 * all" (Controller ruling 5: silence over a guess). "cost unknown" is
 * deliberately lowercase, unprefixed by `~` — matching
 * `formatCrossGateConsequence`'s own "cost unknown" wording (`cross-gate.ts`)
 * rather than inventing a second phrasing for the same fact.
 */
export function formatPromptCostForecast(forecast: PromptCostForecast): string | undefined {
  if (forecast.kind === "none") return undefined;
  if (forecast.kind === "unknown") return "cost unknown";
  return formatCostForecastBand(forecast.minUsd, forecast.maxUsd);
}
