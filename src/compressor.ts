import type { OpenRouter } from "@openrouter/agent";
import type { OrcodeConfig } from "./types.js";
import { SessionStore } from "./session.js";
import { SDK_RETRY_CODES } from "./reconnect.js";
import { formatUsd } from "./utils.js";

/** Output cap of a single compressor call; also the basis of the cost estimate. */
export const COMPRESSOR_MAX_OUTPUT_TOKENS = 2_000;
/** Rough tokens-per-character ratio used for the upfront cost estimate. */
const CHARS_PER_TOKEN = 4;
/** Allowance for the compressor's own system instructions. */
const INSTRUCTION_TOKEN_ALLOWANCE = 200;
/** A handoff has to save at least this share of the context to be worth using. */
export const MIN_COMPRESSION_SAVING = 0.15;

export type CompressionSkipReason =
  | "disabled"
  | "below-threshold"
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
  client: OpenRouter;
  config: OrcodeConfig;
  session: SessionStore;
  currentPrompt: string;
  signal?: AbortSignal;
  /** Optional price source; without it the cost limit can only be checked afterwards. */
  lookupPrice?: CompressorPriceLookup;
  /**
   * Forces compression past the char-threshold check (K7f: the measured
   * `inputTokens` of the previous run exceeded `contextBudgetRatio ×
   * contextLength`). Has no effect when `compressionMode` is `"off"` — an
   * explicit opt-out is not overridden by the budget cut.
   */
  force?: boolean;
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
  const { client, config, session, currentPrompt, signal, lookupPrice, force } = options;
  const rawContext = uncompressedContext(session, currentPrompt);
  const warnings: string[] = [];

  const shouldCompress =
    config.compressionMode === "always" ||
    (config.compressionMode === "auto" &&
      (rawContext.length >= config.compressionThresholdChars || Boolean(force)));
  if (!shouldCompress) {
    return unusedResult({
      rawContext,
      reason: config.compressionMode === "off" ? "disabled" : "below-threshold",
      costUsd: 0,
      estimatedCostUsd: null,
      limitEnforcedUpfront: false,
      warnings,
    });
  }

  const price = await resolvePrice(lookupPrice, config.compressorModel, signal);
  const estimatedCostUsd = price
    ? estimateCostUsd(rawContext.length, price)
    : null;
  if (estimatedCostUsd !== null && estimatedCostUsd > config.compressorMaxCostUsd) {
    warnings.push(
      `Kompression übersprungen: geschätzte Kosten ${formatUsd(estimatedCostUsd)} überschreiten das Kompressorlimit ${formatUsd(config.compressorMaxCostUsd)}. Der Rohkontext wird verwendet.`,
    );
    return unusedResult({
      rawContext,
      reason: "estimated-cost-limit",
      costUsd: 0,
      estimatedCostUsd,
      limitEnforcedUpfront: true,
      warnings,
    });
  }
  if (estimatedCostUsd === null) {
    warnings.push(
      `Kompressorlimit ${formatUsd(config.compressorMaxCostUsd)} konnte vorab nicht geprüft werden: für ${config.compressorModel} liegt kein Preis vor. Die tatsächlichen Kosten werden erst nach dem Aufruf kontrolliert.`,
    );
  }

  let observedCost = 0;
  const result = client.callModel(
    {
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
      hooks: {
        PostModelCall: [
          {
            handler: ({ usage }) => {
              observedCost += usage?.cost ?? 0;
            },
          },
        ],
      },
    },
    {
      ...(signal ? { signal } : {}),
      retryCodes: [...SDK_RETRY_CODES],
    },
  );
  const handoff = (await result.getText()).trim();
  const response = await result.getResponse();
  const costUsd = observedCost || response.usage?.cost || 0;
  if (costUsd > config.compressorMaxCostUsd) {
    warnings.push(
      `Der Kompressor hat das Limit gerissen: ${formatUsd(costUsd)} statt höchstens ${formatUsd(config.compressorMaxCostUsd)}. Die Kosten sind bereits angefallen.`,
    );
  }

  if (!handoff) {
    return unusedResult({
      rawContext,
      reason: "empty-handoff",
      costUsd,
      estimatedCostUsd,
      limitEnforcedUpfront: estimatedCostUsd !== null,
      warnings,
    });
  }

  const savedRatio = rawContext.length
    ? 1 - handoff.length / rawContext.length
    : 0;
  if (savedRatio < MIN_COMPRESSION_SAVING) {
    warnings.push(
      `Kompression verworfen: nur ${Math.round(Math.max(0, savedRatio) * 100)} % kleiner, nötig sind ${Math.round(MIN_COMPRESSION_SAVING * 100)} %. Der Rohkontext wird verwendet.`,
    );
    return unusedResult({
      rawContext,
      reason: "insufficient-saving",
      costUsd,
      estimatedCostUsd,
      limitEnforcedUpfront: estimatedCostUsd !== null,
      warnings,
    });
  }

  return {
    used: true,
    handoff,
    costUsd,
    originalChars: rawContext.length,
    compressedChars: handoff.length,
    savedPercent: Math.round(savedRatio * 100),
    estimatedCostUsd,
    limitEnforcedUpfront: estimatedCostUsd !== null,
    warnings,
  };
}

export function uncompressedContext(
  session: SessionStore,
  currentPrompt: string,
): string {
  const sections: string[] = [];
  if (session.data.summary) {
    sections.push(`PREVIOUS COMPRESSED HANDOFF:\n${session.data.summary}`);
  }
  const transcript = session.transcript();
  if (transcript) {
    sections.push(`CONVERSATION TRANSCRIPT:\n${transcript}`);
  }
  sections.push(`CURRENT USER REQUEST:\n${currentPrompt}`);
  return sections.join("\n\n");
}

/** Result for a context that is handed over uncompressed. */
export function rawCompressionResult(
  rawContext: string,
  reason?: CompressionSkipReason,
  warnings: string[] = [],
): CompressionResult {
  return unusedResult({
    rawContext,
    ...(reason ? { reason } : {}),
    costUsd: 0,
    estimatedCostUsd: null,
    limitEnforcedUpfront: false,
    warnings,
  });
}

function unusedResult(options: {
  rawContext: string;
  reason?: CompressionSkipReason;
  costUsd: number;
  estimatedCostUsd: number | null;
  limitEnforcedUpfront: boolean;
  warnings: string[];
}): CompressionResult {
  return {
    used: false,
    handoff: options.rawContext,
    costUsd: options.costUsd,
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
    Math.ceil(Math.max(0, contextChars) / CHARS_PER_TOKEN) +
    INSTRUCTION_TOKEN_ALLOWANCE;
  return (
    inputTokens * price.promptUsdPerToken +
    COMPRESSOR_MAX_OUTPUT_TOKENS * price.completionUsdPerToken
  );
}
