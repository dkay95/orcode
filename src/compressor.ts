import type { OpenRouter } from "@openrouter/agent";
import type { CostKnowledge, OrcodeConfig } from "./types.js";
import { chatTurnTranscriptText, SessionStore } from "./session.js";
import { SDK_RETRY_CODES } from "./reconnect.js";
import { errorMessage, estimateTokensFromChars, formatUsd } from "./utils.js";
import {
  getReasoningSetting,
  planReasoningRequest,
  type ReasoningModelInfo,
} from "./reasoning.js";

/** Output cap of a single compressor call; also the basis of the cost estimate. */
export const COMPRESSOR_MAX_OUTPUT_TOKENS = 2_000;
/** Allowance for the compressor's own system instructions. */
const INSTRUCTION_TOKEN_ALLOWANCE = 200;
/** A handoff has to save at least this share of the context to be worth using. */
export const MIN_COMPRESSION_SAVING = 0.15;

export type CompressionSkipReason =
  | "disabled"
  | "below-threshold"
  | "cost-unknown"
  | "estimated-cost-limit"
  | "empty-handoff"
  | "insufficient-saving"
  | "failed";

export interface CompressorPrice {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

export type CompressorPriceLookup = (
  model: string,
  signal?: AbortSignal,
) => Promise<CompressorPrice | null>;

export interface CompressionResult {
  used: boolean;
  handoff: string;
  costUsd: number;
  costKnowledge: CostKnowledge;
  originalChars: number;
  compressedChars: number;
  /** Never negative: a handoff that grows the context is discarded instead. */
  savedPercent: number;
  skipReason?: CompressionSkipReason;
  /** Upfront estimate in USD, or null when no price for the model was available. */
  estimatedCostUsd: number | null;
  /** True when `compressorMaxCostUsd` could actually be enforced before the call. */
  limitEnforcedUpfront: boolean;
  /** Non-fatal, user-facing hints in German. */
  warnings: string[];
}

export interface CompressContextOptions {
  /** May be omitted only when unknown pricing makes the call ineligible. */
  client?: OpenRouter;
  config: OrcodeConfig;
  session: SessionStore;
  signal?: AbortSignal;
  /** Optional price source; without it the cost limit can only be checked afterwards. */
  lookupPrice?: CompressorPriceLookup;
  /** Unknown provider pricing forbids a call whose USD cap cannot be enforced. */
  costKnowledge?: CostKnowledge;
  /**
   * The compressor model's own reasoning-relevant capabilities, so its
   * `reasoningByModel[config.compressorModel]` setting degrades exactly like
   * the main model's does. Omitted or null skips capability-aware mapping
   * (same as an unresolved main model) but still forwards an explicit
   * setting when one is stored.
   */
  modelInfo?: ReasoningModelInfo | null;
  /**
   * Forces compression past the char-threshold check (K7f: the measured
   * `inputTokens` of the previous run exceeded `contextBudgetRatio ×
   * contextLength`). Has no effect when `compressionMode` is `"off"` — an
   * explicit opt-out is not overridden by the budget cut.
   */
  force?: boolean;
  /**
   * `/compact` (FIX-2): the user explicitly asked for one compression pass,
   * now. This replaces ONLY the eligibility decision below — `compressionMode`
   * and `compressionThresholdChars` are the policy for the *automatic* path,
   * and `/compress` stays the one place that policy is set, so an explicit
   * opt-out of automatic compression is not an opt-out of asking for one by
   * hand. Every other gate applies unchanged: unknown provider cost, the
   * upfront USD limit, the empty handoff, and the pin-aware minimum saving.
   * An explicit request buys a compressor call, never a different compressor.
   */
  manual?: boolean;
}

/**
 * Build the handoff context for a run.
 *
 * This function is deliberately pure with respect to the session: it reads the
 * transcript but never writes summary, turns, costs, or the session file. The
 * caller decides when (and whether) to apply the result, so an aborted or
 * failed run cannot destroy the history.
 */
export async function compressContext(
  options: CompressContextOptions,
): Promise<CompressionResult> {
  const { client, config, session, signal, lookupPrice, force, manual, modelInfo } = options;
  const costKnowledge = options.costKnowledge ?? "known";
  const rawContext = uncompressedContext(session);
  const warnings: string[] = [];

  const shouldCompress =
    Boolean(manual) ||
    config.compressionMode === "always" ||
    (config.compressionMode === "auto" &&
      (rawContext.length >= config.compressionThresholdChars || Boolean(force)));
  if (!shouldCompress) {
    return unusedResult({
      rawContext,
      reason: config.compressionMode === "off" ? "disabled" : "below-threshold",
      costUsd: 0,
      costKnowledge,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings,
    });
  }

  if (costKnowledge === "unknown") {
    warnings.push(
      "Compression skipped: the cost of this provider-managed model is unknown; the USD limit cannot be reliably enforced.",
    );
    return unusedResult({
      rawContext,
      reason: "cost-unknown",
      costUsd: 0,
      costKnowledge,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings,
    });
  }
  if (!client) {
    throw new Error("Compressor client is required when costs are known.");
  }

  const price = await resolvePrice(lookupPrice, config.compressorModel, signal);
  const estimatedCostUsd = price
    ? estimateCostUsd(rawContext.length, price)
    : null;
  if (estimatedCostUsd !== null && estimatedCostUsd > config.compressorMaxCostUsd) {
    warnings.push(
      `Compression skipped: estimated cost ${formatUsd(estimatedCostUsd)} exceeds the compressor limit ${formatUsd(config.compressorMaxCostUsd)}. The raw context is used.`,
    );
    return unusedResult({
      rawContext,
      reason: "estimated-cost-limit",
      costUsd: 0,
      costKnowledge,
      estimatedCostUsd,
      limitEnforcedUpfront: true,
      warnings,
    });
  }
  if (estimatedCostUsd === null) {
    warnings.push(
      `Compressor limit ${formatUsd(config.compressorMaxCostUsd)} could not be checked upfront: no price is available for ${config.compressorModel}. The actual cost is only checked after the call.`,
    );
  }

  // The compressor role reads its OWN entry — never the main model's — so it
  // stays silent (no reasoning field, today's behavior) until someone
  // explicitly sets "Thinking · compressor" in Settings for this model id.
  const reasoningPlan = planReasoningRequest(
    getReasoningSetting(config, config.compressorModel),
    modelInfo ?? null,
  );
  if (reasoningPlan.degraded && reasoningPlan.note) {
    warnings.push(reasoningPlan.note);
  }

  let observedCost = 0;
  let handoff: string;
  let response: Awaited<ReturnType<ReturnType<typeof client.callModel>["getResponse"]>>;
  try {
    const result = client.callModel({
      model: config.compressorModel,
      instructions: [
        "You are orcode's context compressor.",
        "Create a dense handoff for a stronger coding model.",
        "Preserve exact user intent, current task, decisions, constraints, file paths, APIs, commands, errors, test results, and unfinished work.",
        "Remove repetition, pleasantries, and obsolete speculation.",
        "Never invent facts. Clearly mark uncertainty.",
        "Return only the handoff, organized as compact plain text.",
      ].join(" "),
      input: rawContext,
      maxOutputTokens: COMPRESSOR_MAX_OUTPUT_TOKENS,
      ...(reasoningPlan.request ? { reasoning: reasoningPlan.request } : {}),
      hooks: {
        PostModelCall: [
          {
            handler: ({ usage }) => {
              observedCost += usage?.cost ?? 0;
            },
          },
        ],
      },
    }, {
      ...(signal ? { signal } : {}),
      retryCodes: [...SDK_RETRY_CODES],
    });
    handoff = (await result.getText()).trim();
    response = await result.getResponse();
  } catch (error) {
    warnings.push(
      `Compressor failed; uncompressed context is used: ${errorMessage(error)}`,
    );
    return unusedResult({
      rawContext,
      reason: "failed",
      costUsd: observedCost,
      costKnowledge,
      estimatedCostUsd,
      limitEnforcedUpfront: estimatedCostUsd !== null,
      warnings,
    });
  }
  const costUsd = observedCost || response.usage?.cost || 0;
  if (costUsd > config.compressorMaxCostUsd) {
    warnings.push(
      `The compressor blew past its limit: ${formatUsd(costUsd)} instead of at most ${formatUsd(config.compressorMaxCostUsd)}. The cost has already been incurred.`,
    );
  }

  if (!handoff) {
    return unusedResult({
      rawContext,
      reason: "empty-handoff",
      costUsd,
      costKnowledge,
      estimatedCostUsd,
      limitEnforcedUpfront: estimatedCostUsd !== null,
      warnings,
    });
  }

  // Phase 13 pin gate: a pinned turn is never compressed away — it survives
  // verbatim in `turns` past `SessionStore.compactTurns` regardless of what
  // this handoff says — so its chars can never count as "saved". Adding
  // them to the compressed side (never the pure `handoff.length` a duplicate
  // second estimator would use) is the ONE adoption-gate change this phase
  // makes; the LLM call, its prompt, and the threshold itself are untouched.
  const pinnedChars = pinnedTranscriptChars(session);
  const compressedChars = handoff.length + pinnedChars;
  const savedRatio = rawContext.length
    ? 1 - compressedChars / rawContext.length
    : 0;
  if (savedRatio < MIN_COMPRESSION_SAVING) {
    const pinnedCount = session.data.pinnedTurns?.length ?? 0;
    // Ruling 4: name pinning as the cause once it actually contributed to
    // the shortfall — the compressor still only ever reports; it never
    // drops a pin to force the target (compressContext never touches
    // `session` on any path, success or failure).
    const pinnedNote = pinnedCount > 0
      ? ` Compression target not met — ${pinnedCount} pinned turn${pinnedCount === 1 ? "" : "s"} held.`
      : "";
    warnings.push(
      `Compression discarded: only ${Math.round(Math.max(0, savedRatio) * 100)}% smaller, ${Math.round(MIN_COMPRESSION_SAVING * 100)}% needed.${pinnedNote} The raw context is used.`,
    );
    return unusedResult({
      rawContext,
      reason: "insufficient-saving",
      costUsd,
      costKnowledge,
      estimatedCostUsd,
      limitEnforcedUpfront: estimatedCostUsd !== null,
      warnings,
    });
  }

  return {
    used: true,
    handoff,
    costUsd,
    costKnowledge,
    originalChars: rawContext.length,
    compressedChars,
    savedPercent: Math.round(savedRatio * 100),
    estimatedCostUsd,
    limitEnforcedUpfront: estimatedCostUsd !== null,
    warnings,
  };
}

/**
 * Sum of `chatTurnTranscriptText(turn).length` for every currently pinned
 * turn (Phase 13) — the exact per-turn measurement `SessionStore.transcript`
 * itself uses, so this never drifts from what `rawContext` actually charges
 * for that turn. `0` when nothing is pinned, so every existing (unpinned)
 * caller of `compressContext` sees byte-identical behavior to before this
 * phase.
 */
function pinnedTranscriptChars(session: SessionStore): number {
  const pinned = session.data.pinnedTurns;
  if (!pinned?.length) {
    return 0;
  }
  const ids = new Set(pinned);
  let chars = 0;
  for (const turn of session.data.turns) {
    if (turn.id !== undefined && ids.has(turn.id)) {
      chars += chatTurnTranscriptText(turn).length;
    }
  }
  return chars;
}

/**
 * Phase 12 (per-prompt cost forecast): an approximate "context so far" char
 * count, cheap enough to recompute on every keystroke while composing.
 * Deliberately NOT `uncompressedContext` below: that goes through
 * `SessionStore.transcript()`'s redaction pass — real regex work meant for
 * the once-per-dispatch compression check, not a per-render hot path (the
 * status line recomputes the forecast on every draft change, per Controller
 * ruling 2). This sums the exact same per-turn measurement
 * (`chatTurnTranscriptText`) `pinnedTranscriptChars` above already uses,
 * just over every turn instead of only the pinned ones, and without ever
 * joining or redacting the pieces — a forecast only needs an approximate
 * size, never the redacted text itself.
 */
export function contextCharsForForecast(session: SessionStore): number {
  let chars = session.data.summary.length;
  for (const turn of session.data.turns) {
    chars += chatTurnTranscriptText(turn).length;
  }
  return chars;
}

export function uncompressedContext(
  session: SessionStore,
): string {
  const sections: string[] = [];
  if (session.data.summary) {
    sections.push(`PREVIOUS COMPRESSED HANDOFF:\n${session.data.summary}`);
  }
  const transcript = session.transcript();
  if (transcript) {
    sections.push(`CONVERSATION TRANSCRIPT:\n${transcript}`);
  }
  return sections.join("\n\n");
}

/** Result for a context that is handed over uncompressed. */
export function rawCompressionResult(
  rawContext: string,
  reason?: CompressionSkipReason,
  warnings: string[] = [],
  costKnowledge: CostKnowledge = "known",
): CompressionResult {
  return unusedResult({
    rawContext,
    ...(reason ? { reason } : {}),
    costUsd: 0,
    costKnowledge,
    estimatedCostUsd: null,
    limitEnforcedUpfront: false,
    warnings,
  });
}

function unusedResult(options: {
  rawContext: string;
  reason?: CompressionSkipReason;
  costUsd: number;
  costKnowledge: CostKnowledge;
  estimatedCostUsd: number | null;
  limitEnforcedUpfront: boolean;
  warnings: string[];
}): CompressionResult {
  return {
    used: false,
    handoff: options.rawContext,
    costUsd: options.costUsd,
    costKnowledge: options.costKnowledge,
    originalChars: options.rawContext.length,
    compressedChars: options.rawContext.length,
    savedPercent: 0,
    ...(options.reason ? { skipReason: options.reason } : {}),
    estimatedCostUsd: options.estimatedCostUsd,
    limitEnforcedUpfront: options.limitEnforcedUpfront,
    warnings: options.warnings,
  };
}

async function resolvePrice(
  lookupPrice: CompressorPriceLookup | undefined,
  model: string,
  signal?: AbortSignal,
): Promise<CompressorPrice | null> {
  if (!lookupPrice) {
    return null;
  }
  const price = await lookupPrice(model, signal);
  if (
    !price ||
    !Number.isFinite(price.promptUsdPerToken) ||
    !Number.isFinite(price.completionUsdPerToken) ||
    price.promptUsdPerToken < 0 ||
    price.completionUsdPerToken < 0
  ) {
    return null;
  }
  return price;
}

export function estimateCostUsd(
  contextChars: number,
  price: CompressorPrice,
): number {
  const inputTokens =
    estimateTokensFromChars(contextChars) + INSTRUCTION_TOKEN_ALLOWANCE;
  return (
    inputTokens * price.promptUsdPerToken +
    COMPRESSOR_MAX_OUTPUT_TOKENS * price.completionUsdPerToken
  );
}
