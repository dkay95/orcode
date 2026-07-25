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
  /** German explanation of the degradation, if any. */
  note?: string;
}

export interface ReasoningChoice {
  value: string;
  label: string;
  description: string;
  setting: ReasoningSetting;
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
  model: ModelInfo | null = null,
): ReasoningRequest | undefined {
  return planReasoningRequest(setting, model).request;
}

/**
 * Maps a stored setting onto the request the model actually accepts.
 * Models without reasoning support get no reasoning field, a token budget on a
 * model that only knows effort levels becomes the closest effort level, an
 * unsupported effort becomes the closest supported one, and "aus" is ignored
 * where the model requires reasoning.
 */
export function planReasoningRequest(
  setting: ReasoningSetting,
  model: ModelInfo | null = null,
): ReasoningPlan {
  if (setting.mode === "auto") {
    return { degraded: false };
  }
  if (model && !supportsReasoning(model)) {
    return {
      degraded: true,
      note: `${model.id} meldet keine Reasoning-Unterstützung; die Einstellung wird nicht gesendet.`,
    };
  }

  if (setting.mode === "budget") {
    const maxTokens = clampBudget(setting.maxTokens, model);
    if (model && !supportsBudget(model)) {
      const effort = nearestSupportedEffort(budgetAsEffort(maxTokens), model);
      return {
        request: { enabled: true, effort },
        degraded: true,
        note: `${model.id} kennt kein Reasoning-Token-Budget; gesendet wird die Stufe ${effort}.`,
      };
    }
    if (maxTokens !== setting.maxTokens) {
      return {
        request: { enabled: true, maxTokens },
        degraded: true,
        note: `Das Reasoning-Budget wurde auf ${maxTokens} Tokens begrenzt (Modellmaximum).`,
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
        note: `${model.id} erfordert Reasoning; gesendet wird die niedrigste mögliche Stufe ${effort}.`,
      };
    }
    return { request: { enabled: false, effort: "none" }, degraded: false };
  }

  const effort = nearestSupportedEffort(setting.effort, model);
  if (effort !== setting.effort) {
    return {
      request: { enabled: true, effort },
      degraded: true,
      note: `${model?.id ?? "Das Modell"} unterstützt ${setting.effort} nicht; gesendet wird ${effort}.`,
    };
  }
  return { request: { enabled: true, effort }, degraded: false };
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
  model: ModelInfo | null,
  current: ReasoningSetting,
): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [
    {
      value: "auto",
      label: "Automatisch",
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
        description: "Maximale Reasoning-Tokens; zählen als kostenpflichtige Output-Tokens",
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
  model: ModelInfo | null,
): void {
  if (setting.mode === "budget" && !(setting.maxTokens >= 1)) {
    throw new Error("Das Reasoning-Budget muss mindestens 1 Token betragen.");
  }
  if (setting.mode === "auto" || !model) {
    return;
  }
  const dynamic = model.id.startsWith("openrouter/");
  if (!supportsReasoning(model)) {
    throw new Error(`${model.id} meldet keine Reasoning-Unterstützung.`);
  }
  if (setting.mode === "budget") {
    if (
      !dynamic &&
      model.reasoning &&
      !model.reasoning.supportsMaxTokens
    ) {
      throw new Error(
        `${model.id} meldet kein direktes Reasoning-Token-Budget. Verwende eine Effort-Stufe.`,
      );
    }
    return;
  }
  if (setting.effort === "none" && model.reasoning?.mandatory) {
    throw new Error(`${model.id} erfordert Reasoning und kann nicht auf off gesetzt werden.`);
  }
  const supported = model.reasoning?.supportedEfforts;
  if (supported && !supported.includes(setting.effort)) {
    throw new Error(
      `${model.id} unterstützt ${setting.effort} nicht. Erlaubt: ${supported.join(", ")}.`,
    );
  }
}

export function supportsReasoning(model: ModelInfo | null): boolean {
  if (!model) {
    return true;
  }
  return (
    model.id.startsWith("openrouter/") ||
    Boolean(model.reasoning) ||
    model.supportedParameters.includes("reasoning")
  );
}

function supportedEfforts(model: ModelInfo | null): ReasoningEffort[] {
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
  model: ModelInfo | null,
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

function clampBudget(maxTokens: number, model: ModelInfo | null): number {
  const limit = model?.maxCompletionTokens;
  const bounded = Math.max(1, Math.round(maxTokens));
  return typeof limit === "number" && limit > 0
    ? Math.min(bounded, limit)
    : bounded;
}

function supportsBudget(model: ModelInfo | null): boolean {
  return !model || model.id.startsWith("openrouter/") ||
    Boolean(model.reasoning?.supportsMaxTokens);
}

function autoDescription(model: ModelInfo | null): string {
  if (model && !supportsReasoning(model)) {
    return "Modell meldet kein Reasoning; es wird keine Vorgabe gesendet";
  }
  const defaultEffort = model?.reasoning?.defaultEffort;
  if (defaultEffort) {
    return `Modellvorgabe verwenden: ${effortLabel(defaultEffort)}`;
  }
  return "Keine Reasoning-Vorgabe senden; das Modell entscheidet";
}

function effortLabel(effort: ReasoningEffort): string {
  if (effort === "none") return "Aus";
  if (effort === "xhigh") return "Ultra (xhigh)";
  if (effort === "max") return "Maximum";
  return effort[0]!.toUpperCase() + effort.slice(1);
}

function effortDescription(
  effort: ReasoningEffort,
  model: ModelInfo | null,
): string {
  if (effort === "none") {
    return "Reasoning deaktivieren und Kosten reduzieren";
  }
  const suffix = model?.reasoning?.defaultEffort === effort
    ? " · Modellvorgabe"
    : "";
  return `Reasoning-Aufwand ${effort}; mehr Aufwand kann Ausgabe und Kosten erhöhen${suffix}`;
}

function compactTokens(value: number): string {
  return value >= 1_000
    ? `${Number((value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1))}K`
    : String(value);
}
