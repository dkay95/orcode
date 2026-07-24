import type {
  ModelInfo,
  ReasoningEffort,
  ReasoningSetting,
  RouterCodeConfig,
} from "./types.js";
import { REASONING_EFFORTS } from "./types.js";

export interface ReasoningRequest {
  enabled?: boolean;
  effort?: ReasoningEffort;
  maxTokens?: number;
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
  config: RouterCodeConfig,
  modelId = config.mainModel,
): ReasoningSetting {
  return config.reasoningByModel[modelId] ?? DEFAULT_REASONING_SETTING;
}

export function setReasoningSetting(
  config: RouterCodeConfig,
  setting: ReasoningSetting,
  modelId = config.mainModel,
): void {
  config.reasoningByModel[modelId] = { ...setting };
}

export function buildReasoningRequest(
  setting: ReasoningSetting,
): ReasoningRequest | undefined {
  if (setting.mode === "auto") {
    return undefined;
  }
  if (setting.mode === "budget") {
    return {
      enabled: true,
      maxTokens: setting.maxTokens,
    };
  }
  return setting.effort === "none"
    ? { enabled: false, effort: "none" }
    : { enabled: true, effort: setting.effort };
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
  if (setting.mode === "auto" || !model) {
    return;
  }
  const dynamic = model.id.startsWith("openrouter/");
  if (!dynamic && !model.reasoning && !model.supportedParameters.includes("reasoning")) {
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

function supportedEfforts(model: ModelInfo | null): ReasoningEffort[] {
  if (!model) {
    return [...REASONING_EFFORTS];
  }
  if (model.reasoning?.supportedEfforts) {
    return REASONING_EFFORTS.filter((effort) =>
      model.reasoning!.supportedEfforts!.includes(effort),
    );
  }
  if (
    model.id.startsWith("openrouter/") ||
    model.reasoning ||
    model.supportedParameters.includes("reasoning")
  ) {
    return REASONING_EFFORTS.filter(
      (effort) => effort !== "none" || !model.reasoning?.mandatory,
    );
  }
  return [];
}

function supportsBudget(model: ModelInfo | null): boolean {
  return !model || model.id.startsWith("openrouter/") ||
    Boolean(model.reasoning?.supportsMaxTokens);
}

function autoDescription(model: ModelInfo | null): string {
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
