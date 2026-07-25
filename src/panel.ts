/**
 * Model panel: ask several models the same question in parallel and compare
 * the answers.
 *
 * orcode runs through OpenRouter, which means it can reach models from every
 * provider behind one key — the one advantage a single-vendor tool cannot
 * copy. When a model is stuck circling the same wrong answer, more thinking
 * from the *same* model rarely helps; a different model often does.
 *
 * Deliberately narrow, by design, not by omission:
 * - No tools. The panel answers a question; it runs nothing and changes no
 *   files. Several models writing to the same workspace at the same time
 *   would not be something anyone could reason about or undo.
 * - No UI and no terminal here — this module is pure orchestration plus one
 *   injected side effect (`PanelCall`). `src/ui/panel-view.ts` renders the
 *   result; `createPanelCall` in `src/openrouter.ts` is the real network
 *   wiring; `/panel` in `src/commands.ts` is the entry point.
 */

import { abortError, throwIfAborted } from "./reconnect.js";
import { errorMessage, formatUsd } from "./utils.js";

export const PANEL_MIN_MODELS = 2;
export const PANEL_MAX_MODELS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelCallInput {
  model: string;
  question: string;
  /** Optional context, e.g. file content, sent ahead of the question. */
  context?: string;
  signal?: AbortSignal;
}

export interface PanelCallResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Injection point for the actual OpenRouter call. Tests supply a fake; the
 * real implementation is `createPanelCall` in `openrouter.ts`. Keeping this a
 * plain function type (not a class, not a service) is what makes `askPanel`
 * testable without a network and without touching `~/.orcode`.
 */
export type PanelCall = (input: PanelCallInput) => Promise<PanelCallResult>;

export interface PanelAnswer {
  model: string;
  /** Empty when `error` is set. */
  text: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** German, user facing. `null` on success. */
  error: string | null;
}

export interface PanelResult {
  question: string;
  context?: string;
  /**
   * One entry per requested model, in the requested order. A model is never
   * dropped from this list — a failure just carries `error` instead of text,
   * so "3 models asked" always means 3 entries back, not "however many
   * happened to succeed".
   */
  answers: PanelAnswer[];
  /** Real, post-call sum — never an estimate. */
  totalCostUsd: number;
  /**
   * Wall-clock time for the whole panel call. Since every model runs in
   * parallel this tracks the slowest model, not the sum of all of them.
   */
  durationMs: number;
}

export interface AskPanelOptions {
  question: string;
  /** Optional context, e.g. file content, prepended for every model. */
  context?: string;
  /** 2 to 5 model ids. */
  models: string[];
  callModel: PanelCall;
  signal?: AbortSignal;
  /** Total budget in USD for this panel call. */
  maxCostUsd?: number;
  /**
   * Per-model upfront cost estimate, used only for the `maxCostUsd` guard
   * below — the reported `totalCostUsd` in the result is always the real,
   * post-call sum, never this estimate. Returning `null` for a model means
   * "price unknown"; unknown models are left out of the estimated total
   * rather than counted as free, so a missing price can never look like a
   * green light. Without both `maxCostUsd` and this function no upfront
   * check happens — callers that care about the guard must supply both, see
   * `estimatePanelCost` for a ready-made estimator.
   */
  estimateCostUsd?: (model: string) => number | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PanelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelValidationError";
  }
}

export class PanelBudgetExceededError extends Error {
  readonly estimatedCostUsd: number;
  readonly maxCostUsd: number;
  readonly modelCount: number;

  constructor(estimatedCostUsd: number, maxCostUsd: number, modelCount: number) {
    super(
      `Geschätzte Panel-Kosten für ${modelCount} Modelle: ${formatUsd(estimatedCostUsd)} · Limit: ${formatUsd(maxCostUsd)}. Panel wird nicht gestartet.`,
    );
    this.name = "PanelBudgetExceededError";
    this.estimatedCostUsd = estimatedCostUsd;
    this.maxCostUsd = maxCostUsd;
    this.modelCount = modelCount;
  }
}

// ---------------------------------------------------------------------------
// Cost estimate (shared by the upfront guard and the command-layer preview)
// ---------------------------------------------------------------------------

export interface PanelCostEstimate {
  /** Sum of every known per-model estimate; unknown models contribute 0. */
  totalUsd: number;
  perModelUsd: Array<{ model: string; usd: number | null }>;
  /** How many models had no price available. */
  unknownCount: number;
}

/**
 * Sums the per-model estimate for a candidate model list. Used both by
 * `askPanel`'s upfront budget guard and by the `/panel` command to show "n
 * models cost n times" before the user confirms a run — the same numbers,
 * not two independently maintained estimates.
 */
export function estimatePanelCost(
  models: readonly string[],
  estimateCostUsd: (model: string) => number | null,
): PanelCostEstimate {
  let totalUsd = 0;
  let unknownCount = 0;
  const perModelUsd = models.map((model) => {
    const raw = estimateCostUsd(model);
    if (raw === null || !Number.isFinite(raw)) {
      unknownCount += 1;
      return { model, usd: null };
    }
    const bounded = Math.max(0, raw);
    totalUsd += bounded;
    return { model, usd: bounded };
  });
  return { totalUsd, perModelUsd, unknownCount };
}

// ---------------------------------------------------------------------------
// askPanel
// ---------------------------------------------------------------------------

function validateModelCount(models: readonly string[]): void {
  if (models.length < PANEL_MIN_MODELS || models.length > PANEL_MAX_MODELS) {
    throw new PanelValidationError(
      `Panel braucht zwischen ${PANEL_MIN_MODELS} und ${PANEL_MAX_MODELS} Modellen, erhalten: ${models.length}.`,
    );
  }
}

/**
 * Races `promise` against `signal`. Forwarding the signal into `callModel` is
 * the cooperative path (a real network call can abort its own fetch); this is
 * the non-cooperative backstop, so a fake or a call that ignores its signal
 * still lets an abort end the wait immediately instead of after however long
 * that call was going to take.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runOneModel(
  model: string,
  question: string,
  context: string | undefined,
  callModel: PanelCall,
  signal: AbortSignal | undefined,
): Promise<PanelAnswer> {
  const start = Date.now();
  try {
    const result = await raceAbort(
      callModel({ model, question, context, signal }),
      signal,
    );
    return {
      model,
      text: result.text,
      costUsd: Math.max(0, result.costUsd || 0),
      durationMs: Date.now() - start,
      inputTokens: Math.max(0, result.inputTokens || 0),
      outputTokens: Math.max(0, result.outputTokens || 0),
      error: null,
    };
  } catch (error) {
    // A failing or slow model must never take the others down with it — its
    // place in the result carries the error instead of rejecting the panel.
    return {
      model,
      text: "",
      costUsd: 0,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      error: errorMessage(error),
    };
  }
}

/**
 * Asks every model in `options.models` the same question, in parallel, and
 * reports back one `PanelAnswer` per model — success or failure, never
 * dropped. See the module doc for what this deliberately does not do (tools,
 * files, terminal).
 */
export async function askPanel(options: AskPanelOptions): Promise<PanelResult> {
  const { question, context, models, callModel, signal, maxCostUsd, estimateCostUsd } =
    options;
  if (!question.trim()) {
    throw new PanelValidationError("Panel braucht eine Frage.");
  }
  validateModelCount(models);
  throwIfAborted(signal);

  if (maxCostUsd !== undefined && estimateCostUsd) {
    const estimate = estimatePanelCost(models, estimateCostUsd);
    if (estimate.totalUsd > maxCostUsd) {
      throw new PanelBudgetExceededError(estimate.totalUsd, maxCostUsd, models.length);
    }
  }

  const start = Date.now();
  const answers = await Promise.all(
    models.map((model) => runOneModel(model, question, context, callModel, signal)),
  );
  return {
    question,
    ...(context !== undefined ? { context } : {}),
    answers,
    totalCostUsd: answers.reduce((sum, answer) => sum + answer.costUsd, 0),
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// synthesize — optional judge round
// ---------------------------------------------------------------------------

export interface SynthesizeOptions {
  question: string;
  answers: readonly PanelAnswer[];
  judgeModel: string;
  callModel: PanelCall;
  signal?: AbortSignal;
}

export interface PanelJudgment {
  judgeModel: string;
  /** Empty when `error` is set. */
  text: string;
  costUsd: number;
  durationMs: number;
  /** German, user facing. `null` on success. */
  error: string | null;
}

/**
 * Builds the judge's prompt. Exported so tests (and callers who want to
 * inspect or log exactly what the judge saw) do not have to reimplement it.
 * The exact wording is not contractual — the structure is: every answer
 * appears labelled by its own model id, never blended into one voice, so the
 * judge (and later, the reader of `PanelJudgment`) can always tell who said
 * what.
 */
export function buildJudgePrompt(
  question: string,
  answers: readonly PanelAnswer[],
): string {
  const sections = answers.map(
    (answer, index) => `ANSWER ${index + 1} (model: ${answer.model}):\n${answer.text.trim()}`,
  );
  return [
    "Several independent models were asked the same question, each without seeing the others' answers.",
    `QUESTION:\n${question}`,
    ...sections,
    "Compare the answers: where they agree, where they meaningfully disagree, and which you would trust most and why. End with one clear, reasoned recommendation. Do not simply restate every answer in turn.",
  ].join("\n\n");
}

/**
 * Optional second round: one more model call that compares the panel's
 * answers and gives a reasoned recommendation. Never implied by `askPanel`
 * itself — a second opinion of a second opinion is not automatically an
 * improvement, and it is not free, so the caller (the `/panel judge`
 * setting) decides explicitly.
 */
export async function synthesize(options: SynthesizeOptions): Promise<PanelJudgment> {
  const { question, answers, judgeModel, callModel, signal } = options;
  const usable = answers.filter(
    (answer) => answer.error === null && answer.text.trim().length > 0,
  );
  if (usable.length < 2) {
    throw new PanelValidationError(
      "Für eine Auswertung werden mindestens zwei erfolgreiche Panel-Antworten benötigt.",
    );
  }
  throwIfAborted(signal);

  const start = Date.now();
  try {
    const result = await raceAbort(
      callModel({ model: judgeModel, question: buildJudgePrompt(question, usable), signal }),
      signal,
    );
    return {
      judgeModel,
      text: result.text,
      costUsd: Math.max(0, result.costUsd || 0),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (error) {
    return {
      judgeModel,
      text: "",
      costUsd: 0,
      durationMs: Date.now() - start,
      error: errorMessage(error),
    };
  }
}
