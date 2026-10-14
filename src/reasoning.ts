import type {
  ModelInfo,
  ReasoningEffort,
  ReasoningSetting,
  OrcodeConfig,
} from "./types.js";
import { REASONING_EFFORTS } from "./types.js";

/**
 * Mirrors the reasoning config of the OpenRouter Responses API as exposed by
 * `@openrouter/agent` (`enabled`, `effort`, `maxTokens`; `context`, `mode` and
 * `summary` are unused here). The chat-completions-only `exclude` flag has no
 * counterpart in that config and is therefore not sent.
 */
export interface ReasoningRequest {
  enabled?: boolean;
  effort?: ReasoningEffort;
  maxTokens?: number;
}

export interface ReasoningPlan {
  /** Undefined means: send no reasoning field at all. */
  request?: ReasoningRequest;
  /** True when the setting could not be sent as chosen. */
  degraded: boolean;
  /** Plain-English explanation of the degradation, if any. */
  note?: string;
}

export interface ReasoningChoice {
  value: string;
  label: string;
  description: string;
  setting: ReasoningSetting;
}

/**
 * The reasoning mapper only needs this capability-shaped subset. Keeping the
 * input structural lets the provider-neutral runtime describe Kimi without
 * inventing OpenRouter catalogue fields or prices.
 */
export interface ReasoningModelInfo {
  readonly id: string;
  readonly maxCompletionTokens?: number | null;
  readonly reasoning?: ModelInfo["reasoning"];
  readonly supportedParameters?: readonly string[];
}

export const DEFAULT_REASONING_SETTING: ReasoningSetting = {
  mode: "auto",
};

export function getReasoningSetting(
  config: OrcodeConfig,
  modelId = config.mainModel,
): ReasoningSetting {
  return config.reasoningByModel[modelId] ?? DEFAULT_REASONING_SETTING;
}

export function setReasoningSetting(
  config: OrcodeConfig,
  setting: ReasoningSetting,
  modelId = config.mainModel,
): void {
  config.reasoningByModel[modelId] = { ...setting };
}

export function buildReasoningRequest(
  setting: ReasoningSetting,
  model: ReasoningModelInfo | null = null,
): ReasoningRequest | undefined {
  return planReasoningRequest(setting, model).request;
}

/**
 * Maps a stored setting onto the request the model actually accepts.
 * Models without reasoning support get no reasoning field, a token budget on a
 * model that only knows effort levels becomes the closest effort level, an
 * unsupported effort becomes the closest supported one, and "off" is ignored
 * where the model requires reasoning.
 */
export function planReasoningRequest(
  setting: ReasoningSetting,
  model: ReasoningModelInfo | null = null,
): ReasoningPlan {
  if (setting.mode === "auto") {
    return { degraded: false };
  }
  if (model && !supportsReasoning(model)) {
    return {
      degraded: true,
      note: `${model.id} reports no reasoning support; the setting is not sent.`,
    };
  }

  if (setting.mode === "budget") {
    const maxTokens = clampBudget(setting.maxTokens, model);
    if (model && !supportsBudget(model)) {
      const effort = nearestSupportedEffort(budgetAsEffort(maxTokens), model);
      return {
        request: { enabled: true, effort },
        degraded: true,
        note: `${model.id} does not know a reasoning token budget; sending level ${effort} instead.`,
      };
    }
    if (maxTokens !== setting.maxTokens) {
      return {
        request: { enabled: true, maxTokens },
        degraded: true,
        note: `The reasoning budget was capped at ${maxTokens} tokens (model maximum).`,
      };
    }
    return { request: { enabled: true, maxTokens }, degraded: false };
  }

  if (setting.effort === "none") {
    if (model?.reasoning?.mandatory) {
      const effort = nearestSupportedEffort("minimal", model);
      return {
        request: { enabled: true, effort },
        degraded: true,
        note: `${model.id} requires reasoning; sending the lowest possible level ${effort}.`,
      };
    }
    return { request: { enabled: false, effort: "none" }, degraded: false };
  }

  const effort = nearestSupportedEffort(setting.effort, model);
  if (effort !== setting.effort) {
    return {
      request: { enabled: true, effort },
      degraded: true,
      note: `${model?.id ?? "The model"} does not support ${setting.effort}; sending ${effort} instead.`,
    };
  }
  return { request: { enabled: true, effort }, degraded: false };
}

/**
 * Applies backend policy before the generic OpenRouter capability fallback.
 * Kimi's membership API has no supported off or token-budget wire shape.
 */
export function planRuntimeReasoningRequest(
  setting: ReasoningSetting,
  model: ReasoningModelInfo | null,
  backendId: "openrouter" | "kimi-code" | "nano-gpt",
): ReasoningPlan {
  if (backendId === "openrouter") return planReasoningRequest(setting, model);
  if (backendId === "nano-gpt") {
    return setting.mode === "auto" ? { degraded: false } : {
      degraded: true,
      note: "Nano-GPT uses the selected model's default reasoning; the stored override is not sent.",
    };
  }
  if (setting.mode === "budget") {
    throw new Error("Kimi Code does not support a reasoning token budget.");
  }
  if (setting.mode === "effort" && setting.effort === "none") {
    throw new Error("Kimi Code requires reasoning and cannot be turned off.");
  }
  if (setting.mode === "auto") return { degraded: false };

  if (model?.reasoning?.supportedEfforts === null) {
    return {
      request: { enabled: true },
      degraded: true,
      note: `${model.id} uses a fixed thinking mode; the stored level ${setting.effort} is not sent.`,
    };
  }
  if (setting.effort === "minimal") {
    return {
      request: { enabled: true, effort: "low" },
      degraded: true,
      note: `${model?.id ?? "Kimi Code"} does not support minimal; sending low instead.`,
    };
  }
  return { request: { enabled: true, effort: setting.effort }, degraded: false };
}

export function reasoningLabel(setting: ReasoningSetting): string {
  if (setting.mode === "auto") {
    return "auto";
  }
  if (setting.mode === "budget") {
    return compactTokens(setting.maxTokens);
  }
  return setting.effort === "xhigh" ? "ultra (xhigh)" : setting.effort;
}

export function reasoningChoices(
  model: ReasoningModelInfo | null,
  current: ReasoningSetting,
): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [
    {
      value: "auto",
      label: "Automatic",
      description: autoDescription(model),
      setting: { mode: "auto" },
    },
  ];
  const efforts = supportedEfforts(model);
  for (const effort of efforts) {
    choices.push({
      value: `effort:${effort}`,
      label: effortLabel(effort),
      description: effortDescription(effort, model),
      setting: { mode: "effort", effort },
    });
  }
  if (supportsBudget(model)) {
    const budgets = [2_000, 4_000, 8_000, 16_000, 32_000];
    if (current.mode === "budget" && !budgets.includes(current.maxTokens)) {
      budgets.push(current.maxTokens);
      budgets.sort((left, right) => left - right);
    }
    for (const maxTokens of budgets) {
      choices.push({
        value: `budget:${maxTokens}`,
        label: `Budget ${compactTokens(maxTokens)}`,
        description: "Maximum reasoning tokens; count as billable output tokens",
        setting: { mode: "budget", maxTokens },
      });
    }
  }
  return choices;
}

export function reasoningChoiceValue(setting: ReasoningSetting): string {
  if (setting.mode === "auto") return "auto";
  if (setting.mode === "budget") return `budget:${setting.maxTokens}`;
  return `effort:${setting.effort}`;
}

export function validateReasoningSetting(
  setting: ReasoningSetting,
  model: ReasoningModelInfo | null,
): void {
  if (setting.mode === "budget" && !(setting.maxTokens >= 1)) {
    throw new Error("The reasoning budget must be at least 1 token.");
  }
  if (setting.mode === "auto" || !model) {
    return;
  }
  const dynamic = model.id.startsWith("openrouter/");
  if (!supportsReasoning(model)) {
    throw new Error(`${model.id} reports no reasoning support.`);
  }
  if (setting.mode === "budget") {
    if (
      !dynamic &&
      model.reasoning &&
      !model.reasoning.supportsMaxTokens
    ) {
      throw new Error(
        `${model.id} does not report a direct reasoning token budget. Use an effort level.`,
      );
    }
    return;
  }
  if (setting.effort === "none" && model.reasoning?.mandatory) {
    throw new Error(`${model.id} requires reasoning and cannot be set to off.`);
  }
  const supported = model.reasoning?.supportedEfforts;
  if (supported && !supported.includes(setting.effort)) {
    throw new Error(
      `${model.id} does not support ${setting.effort}. Allowed: ${supported.join(", ")}.`,
    );
  }
}

export function supportsReasoning(model: ReasoningModelInfo | null): boolean {
  if (!model) {
    return true;
  }
  return (
    model.id.startsWith("openrouter/") ||
    Boolean(model.reasoning) ||
    Boolean(model.supportedParameters?.includes("reasoning"))
  );
}

function supportedEfforts(model: ReasoningModelInfo | null): ReasoningEffort[] {
  if (!model) {
    return [...REASONING_EFFORTS];
  }
  if (model.reasoning?.supportedEfforts) {
    return REASONING_EFFORTS.filter((effort) =>
      model.reasoning!.supportedEfforts!.includes(effort),
    );
  }
  if (supportsReasoning(model)) {
    return REASONING_EFFORTS.filter(
      (effort) => effort !== "none" || !model.reasoning?.mandatory,
    );
  }
  return [];
}

function nearestSupportedEffort(
  effort: ReasoningEffort,
  model: ReasoningModelInfo | null,
): ReasoningEffort {
  const supported = model?.reasoning?.supportedEfforts;
  if (!supported || supported.length === 0 || supported.includes(effort)) {
    return effort;
  }
  const usable = supported.filter((candidate) => candidate !== "none");
  const known = usable.length ? usable : supported;
  const wanted = REASONING_EFFORTS.indexOf(effort);
  // Ordered ascending, so ties resolve towards the cheaper level: a degraded
  // setting never costs more than the one the user picked.
  const pool = REASONING_EFFORTS.filter((candidate) => known.includes(candidate));
  return pool.reduce((best, candidate) =>
    Math.abs(REASONING_EFFORTS.indexOf(candidate) - wanted) <
    Math.abs(REASONING_EFFORTS.indexOf(best) - wanted)
      ? candidate
      : best,
  );
}

function budgetAsEffort(maxTokens: number): ReasoningEffort {
  if (maxTokens <= 2_000) return "low";
  if (maxTokens <= 8_000) return "medium";
  return "high";
}

function clampBudget(maxTokens: number, model: ReasoningModelInfo | null): number {
  const limit = model?.maxCompletionTokens;
  const bounded = Math.max(1, Math.round(maxTokens));
  return typeof limit === "number" && limit > 0
    ? Math.min(bounded, limit)
    : bounded;
}

function supportsBudget(model: ReasoningModelInfo | null): boolean {
  return !model || model.id.startsWith("openrouter/") ||
    Boolean(model.reasoning?.supportsMaxTokens);
}

function autoDescription(model: ReasoningModelInfo | null): string {
  if (model && !supportsReasoning(model)) {
    return "Model reports no reasoning; no setting is sent";
  }
  const defaultEffort = model?.reasoning?.defaultEffort;
  if (defaultEffort) {
    return `Use the model default: ${effortLabel(defaultEffort)}`;
  }
  return "Send no reasoning setting; the model decides";
}

function effortLabel(effort: ReasoningEffort): string {
  if (effort === "none") return "Off";
  if (effort === "xhigh") return "Ultra (xhigh)";
  if (effort === "max") return "Maximum";
  return effort[0]!.toUpperCase() + effort.slice(1);
}

function effortDescription(
  effort: ReasoningEffort,
  model: ReasoningModelInfo | null,
): string {
  if (effort === "none") {
    return "Turn off reasoning and reduce cost";
  }
  const suffix = model?.reasoning?.defaultEffort === effort
    ? " · model default"
    : "";
  return `Reasoning effort ${effort}; more effort can increase output and cost${suffix}`;
}

function compactTokens(value: number): string {
  return value >= 1_000
    ? `${Number((value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1))}K`
    : String(value);
}
