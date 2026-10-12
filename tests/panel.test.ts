/**
 * The model panel: `askPanel`/`synthesize` (src/panel.ts), the pure
 * OpenRouter-catalogue helpers that support it (src/openrouter.ts), the
 * `panelModels`/`panelJudge` config validation (src/config.ts), the `/panel`
 * slash command (src/commands.ts), and its rendering (src/ui/panel-view.ts).
 *
 * `callModel` is always injected — nothing here makes a real network call.
 * Every command test writes into a fresh `mkdtemp` directory, never the real
 * `~/.orcode`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import {
  handleSlashCommand,
  panelAutoSuggestNotice,
  type CommandContext,
  type CommandOutput,
} from "../src/commands.js";
import {
  DEFAULT_CONFIG,
  validateConfig,
  validatePanelModelSelection,
  validatePanelModels,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import {
  estimatePanelModelCostUsd,
  modelCapabilities,
  proposePanelModels,
  type OpenRouterService,
} from "../src/openrouter.js";
import {
  PANEL_MAX_MODELS,
  PANEL_MIN_MODELS,
  PanelBudgetExceededError,
  PanelValidationError,
  askPanel,
  buildJudgePrompt,
  estimatePanelCost,
  estimatePanelRun,
  synthesize,
  type PanelAnswer,
  type PanelCall,
  type PanelCallInput,
  type PanelJudgment,
  type PanelResult,
} from "../src/panel.js";
import { renderLines } from "../src/ui/compose.js";
import { renderPanel } from "../src/ui/panel-view.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { RuleStore } from "../src/rules.js";
import type { ModelInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    description: "",
    contextLength: 128_000,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...overrides,
  };
}

function successAnswer(model: string, text: string): PanelAnswer {
  return {
    model,
    text,
    costUsd: 0.001,
    durationMs: 10,
    inputTokens: 5,
    outputTokens: 5,
    error: null,
  };
}

function failedAnswer(model: string, error: string): PanelAnswer {
  return {
    model,
    text: "",
    costUsd: 0,
    durationMs: 5,
    inputTokens: 0,
    outputTokens: 0,
    error,
  };
}

function fakePanelCall(
  handler: (input: PanelCallInput) => Promise<{
    text: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>,
): { call: PanelCall; calls: PanelCallInput[] } {
  const calls: PanelCallInput[] = [];
  const call: PanelCall = async (input) => {
    calls.push(input);
    return handler(input);
  };
  return { call, calls };
}

// ---------------------------------------------------------------------------
// askPanel — parallel execution, isolation, cancellation, budget
// ---------------------------------------------------------------------------

test("askPanel runs models in parallel — total time tracks the slowest call, not the sum", async () => {
  const delays: Record<string, number> = {
    "a/one": 40,
    "b/two": 80,
    "c/three": 150,
  };
  const call: PanelCall = async ({ model, question }) => {
    await delay(delays[model] ?? 0);
    return { text: `Antwort von ${model} auf ${question}`, costUsd: 0.001, inputTokens: 10, outputTokens: 10 };
  };

  const start = Date.now();
  const result = await askPanel({
    question: "Ist das Panel wirklich parallel?",
    models: Object.keys(delays),
    callModel: call,
  });
  const elapsed = Date.now() - start;
  const sum = Object.values(delays).reduce((a, b) => a + b, 0);

  assert.equal(result.answers.length, 3);
  assert.ok(
    elapsed < sum * 0.8,
    `Panel lief ${elapsed}ms — erwartet deutlich unter der Summe der Einzeldauern (${sum}ms)`,
  );
  assert.ok(
    elapsed >= 130,
    `Panel lief nur ${elapsed}ms — schneller als das langsamste Modell (150ms)?`,
  );
  for (const [modelId, ms] of Object.entries(delays)) {
    const answer = result.answers.find((entry) => entry.model === modelId);
    assert.ok(answer, `keine Antwort für ${modelId}`);
    assert.equal(answer!.error, null);
    assert.match(answer!.text, new RegExp(modelId.replace("/", "\\/")));
    assert.ok(answer!.durationMs >= ms - 5, `${modelId}: durationMs ${answer!.durationMs} < ${ms}`);
  }
});

test("a failing model does not affect the others and appears as an error slot", async () => {
  const call: PanelCall = async ({ model }) => {
    if (model === "broken/model") {
      throw new Error("Modell antwortet mit HTTP 500.");
    }
    return { text: `ok von ${model}`, costUsd: 0.002, inputTokens: 5, outputTokens: 5 };
  };
  const result = await askPanel({
    question: "Frage",
    models: ["good/one", "broken/model", "good/two"],
    callModel: call,
  });

  assert.equal(result.answers.length, 3);
  const broken = result.answers.find((a) => a.model === "broken/model")!;
  assert.match(broken.error ?? "", /HTTP 500/);
  assert.equal(broken.text, "");
  assert.equal(broken.costUsd, 0);
  for (const okModel of ["good/one", "good/two"]) {
    const answer = result.answers.find((a) => a.model === okModel)!;
    assert.equal(answer.error, null);
    assert.match(answer.text, /^ok von/);
  }
  assert.equal(result.totalCostUsd, 0.004);
});

test("an abort signal ends the whole panel, even for a model call that ignores it", async () => {
  const controller = new AbortController();
  const call: PanelCall = async () => {
    await delay(300); // much longer than the abort delay below
    return { text: "zu spät", costUsd: 0.5, inputTokens: 0, outputTokens: 0 };
  };
  const start = Date.now();
  const resultPromise = askPanel({
    question: "Wird das abgebrochen?",
    models: ["a/one", "b/two"],
    callModel: call,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 15);
  const result = await resultPromise;
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 150, `Panel wartete ${elapsed}ms auf einen abgebrochenen Lauf`);
  assert.equal(result.answers.length, 2);
  for (const answer of result.answers) {
    assert.notEqual(answer.error, null);
    assert.equal(answer.costUsd, 0);
  }
});

test("an already-aborted signal rejects before any model is called", async () => {
  const { call, calls } = fakePanelCall(async () => ({
    text: "x",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    askPanel({
      question: "Frage",
      models: ["a/one", "b/two"],
      callModel: call,
      signal: controller.signal,
    }),
  );
  assert.equal(calls.length, 0);
});

test("the budget guard rejects before any model is called once the estimate exceeds maxCostUsd", async () => {
  const { call, calls } = fakePanelCall(async () => ({
    text: "x",
    costUsd: 0.01,
    inputTokens: 0,
    outputTokens: 0,
  }));
  await assert.rejects(
    askPanel({
      question: "Teure Frage",
      models: ["a/one", "b/two", "c/three"],
      callModel: call,
      maxCostUsd: 1,
      estimateCostUsd: () => 0.5, // 3 × 0.5 = 1.5 > 1
    }),
    (error: unknown) => {
      assert.ok(error instanceof PanelBudgetExceededError);
      assert.ok(error.estimatedCostUsd > 1);
      assert.equal(error.modelCount, 3);
      return true;
    },
  );
  assert.equal(calls.length, 0, "kein Modell darf vor der Budgetprüfung aufgerufen werden");
});

test("the budget guard treats an unknown per-model price as excluded, never as free", async () => {
  const { call, calls } = fakePanelCall(async () => ({
    text: "x",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }));
  const result = await askPanel({
    question: "Frage",
    models: ["known/model", "unknown/one", "unknown/two"],
    callModel: call,
    maxCostUsd: 1,
    estimateCostUsd: (m) => (m === "known/model" ? 0.4 : null),
  });
  assert.equal(result.answers.length, 3);
  assert.equal(calls.length, 3);
});

test("askPanel reports the real post-call cost sum, independent of the upfront estimate", async () => {
  const call: PanelCall = async ({ model }) => ({
    text: `Antwort ${model}`,
    costUsd: model === "a/one" ? 0.01 : 0.02,
    inputTokens: 10,
    outputTokens: 10,
  });
  const result = await askPanel({
    question: "Frage",
    models: ["a/one", "b/two"],
    callModel: call,
    maxCostUsd: 1,
    estimateCostUsd: () => 0.001, // deliberately far from the real per-call cost
  });
  assert.equal(result.totalCostUsd, 0.03);
});

test("askPanel rejects too few or too many models with a clear message", async () => {
  const { call } = fakePanelCall(async () => ({ text: "x", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
  await assert.rejects(
    askPanel({ question: "Frage", models: ["only/one"], callModel: call }),
    (error: unknown) => {
      assert.ok(error instanceof PanelValidationError);
      assert.match(error.message, /between 2 and 5/);
      return true;
    },
  );
  await assert.rejects(
    askPanel({
      question: "Frage",
      models: ["a", "b", "c", "d", "e", "f"],
      callModel: call,
    }),
    /between 2 and 5/,
  );
});

test("askPanel rejects an empty question", async () => {
  const { call } = fakePanelCall(async () => ({ text: "x", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
  await assert.rejects(
    askPanel({ question: "   ", models: ["a/one", "b/two"], callModel: call }),
    /question/i,
  );
});

// ---------------------------------------------------------------------------
// synthesize — optional judge round
// ---------------------------------------------------------------------------

test("synthesize needs at least two successful answers", async () => {
  const { call } = fakePanelCall(async () => ({
    text: "Empfehlung",
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 10,
  }));
  await assert.rejects(
    synthesize({
      question: "Frage",
      answers: [successAnswer("a/one", "Antwort A"), failedAnswer("b/two", "kaputt")],
      judgeModel: "judge/model",
      callModel: call,
    }),
    /at least two/,
  );
});

test("synthesize sends every successful answer to the judge, labelled by model, and drops failures", async () => {
  const { call, calls } = fakePanelCall(async () => ({
    text: "Ich empfehle Antwort A.",
    costUsd: 0.02,
    inputTokens: 40,
    outputTokens: 20,
  }));
  const answers = [
    successAnswer("a/one", "Antwort A"),
    successAnswer("b/two", "Antwort B"),
    failedAnswer("c/three", "Zeitüberschreitung"),
  ];
  const judgment = await synthesize({
    question: "Was ist besser?",
    answers,
    judgeModel: "judge/model",
    callModel: call,
  });

  assert.equal(judgment.error, null);
  assert.equal(judgment.text, "Ich empfehle Antwort A.");
  assert.equal(judgment.costUsd, 0.02);
  assert.equal(judgment.judgeModel, "judge/model");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "judge/model");
  assert.match(calls[0]!.question, /Antwort A/);
  assert.match(calls[0]!.question, /Antwort B/);
  assert.match(calls[0]!.question, /a\/one/);
  assert.match(calls[0]!.question, /b\/two/);
  assert.doesNotMatch(calls[0]!.question, /Zeitüberschreitung/);
});

test("a failing judge call reports an error on the judgment instead of throwing", async () => {
  const call: PanelCall = async () => {
    throw new Error("Richter-Modell nicht erreichbar.");
  };
  const judgment = await synthesize({
    question: "Frage",
    answers: [successAnswer("a/one", "A"), successAnswer("b/two", "B")],
    judgeModel: "judge/model",
    callModel: call,
  });
  assert.match(judgment.error ?? "", /nicht erreichbar/);
  assert.equal(judgment.text, "");
});

test("buildJudgePrompt keeps every answer labelled by its own model, never blended", () => {
  const prompt = buildJudgePrompt("Frage?", [
    successAnswer("a/one", "Antwort A"),
    successAnswer("b/two", "Antwort B"),
  ]);
  assert.match(prompt, /ANSWER 1 \(model: a\/one\)/);
  assert.match(prompt, /ANSWER 2 \(model: b\/two\)/);
  assert.match(prompt, /Frage\?/);
});

// ---------------------------------------------------------------------------
// estimatePanelCost
// ---------------------------------------------------------------------------

test("estimatePanelCost sums known estimates, clamps negatives, and reports unknowns separately", () => {
  const estimate = estimatePanelCost(["a", "b", "c"], (m) => {
    if (m === "a") return 0.1;
    if (m === "b") return -5; // clamped to 0, not negative
    return null; // unknown
  });
  assert.equal(estimate.totalUsd, 0.1);
  assert.equal(estimate.unknownCount, 1);
  assert.deepEqual(
    estimate.perModelUsd.map((entry) => entry.model),
    ["a", "b", "c"],
  );
  assert.equal(estimate.perModelUsd[1]!.usd, 0);
  assert.equal(estimate.perModelUsd[2]!.usd, null);
});

// ---------------------------------------------------------------------------
// FIX-10 H2 (money honesty): estimatePanelRun — the /panel confirm's
// estimate includes the judge round whenever panelJudge is on.
// ---------------------------------------------------------------------------

test("H2: with the judge off, estimatePanelRun is exactly estimatePanelCost — no judge entry, no extra cost", () => {
  const priceOf = (m: string): number | null => (m === "a" ? 0.1 : 0.2);
  const run = estimatePanelRun(["a", "b"], null, priceOf);
  assert.deepEqual(run, estimatePanelCost(["a", "b"], priceOf));
  assert.equal(run.judge, undefined);
});

test("H2: with the judge on, the judging call is priced by the same estimator and included in the total", () => {
  const priceOf = (m: string): number | null => {
    if (m === "a") return 0.1;
    if (m === "b") return 0.2;
    if (m === "judge/main") return 0.05;
    return null;
  };
  const run = estimatePanelRun(["a", "b"], "judge/main", priceOf);
  assert.ok(Math.abs(run.totalUsd - 0.35) < 1e-12);
  assert.equal(run.unknownCount, 0);
  assert.deepEqual(run.judge, { model: "judge/main", usd: 0.05 });
  // The panelist rows are untouched — the judge rides alongside, never
  // silently merged into the N-model list.
  assert.deepEqual(run.perModelUsd.map((entry) => entry.model), ["a", "b"]);
});

test("H2: an unpriced judge counts into unknownCount — never silently priced at \$0", () => {
  const priceOf = (m: string): number | null => (m === "judge/main" ? null : 0.1);
  const run = estimatePanelRun(["a", "b"], "judge/main", priceOf);
  assert.ok(Math.abs(run.totalUsd - 0.2) < 1e-12);
  assert.equal(run.unknownCount, 1);
  assert.deepEqual(run.judge, { model: "judge/main", usd: null });
});

test("F4: the judge is priced through its own estimator seam (larger judge input), never the panelists' prompt-length estimate", () => {
  const via: string[] = [];
  const run = estimatePanelRun(
    ["a", "b"],
    "judge/main",
    (m) => { via.push(`panelist:${m}`); return 0.1; },
    (m) => { via.push(`judge:${m}`); return 0.7; },
  );
  assert.deepEqual(run.judge, { model: "judge/main", usd: 0.7 });
  assert.ok(Math.abs(run.totalUsd - 0.9) < 1e-12);
  // The judge went through the judge seam exactly once and never through
  // the panelists' estimator; the panelists never went through the judge's.
  assert.deepEqual(via, ["panelist:a", "panelist:b", "judge:judge/main"]);
});

// ---------------------------------------------------------------------------
// openrouter.ts helpers — pure, no network
// ---------------------------------------------------------------------------

test("estimatePanelModelCostUsd is unknown (null) for dynamic pricing and scales with prompt length otherwise", () => {
  const dynamic = modelCapabilities(model({ id: "openrouter/auto", promptPrice: -1, completionPrice: -1 }));
  assert.equal(estimatePanelModelCostUsd(dynamic, 1_000), null);

  const fixed = modelCapabilities(model({ id: "a/one", promptPrice: 0.000002, completionPrice: 0.000004 }));
  const short = estimatePanelModelCostUsd(fixed, 100)!;
  const long = estimatePanelModelCostUsd(fixed, 100_000)!;
  assert.ok(short > 0);
  assert.ok(long > short);
});

test("proposePanelModels picks at most one model per provider family, ranked by intelligence, skipping free/dynamic pricing", () => {
  const models = [
    model({ id: "a/cheap", intelligenceIndex: 40 }),
    model({ id: "a/smart", intelligenceIndex: 90 }),
    model({ id: "b/only", intelligenceIndex: 70 }),
    model({ id: "c/only", intelligenceIndex: 60 }),
    model({ id: "d/free", intelligenceIndex: 99, promptPrice: 0, completionPrice: 0 }),
    model({ id: "e/dynamic", intelligenceIndex: 99, promptPrice: -1, completionPrice: -1 }),
  ];
  const proposal = proposePanelModels(models, 3);
  assert.deepEqual(
    proposal.map((m) => m.id),
    ["a/smart", "b/only", "c/only"],
  );
});

// ---------------------------------------------------------------------------
// config.ts — panelModels/panelJudge validation
// ---------------------------------------------------------------------------

test("validatePanelModelSelection rejects too few models with a clear message", () => {
  assert.throws(
    () => validatePanelModelSelection(["only/one"], ["only/one", "other/model"]),
    /at least 2/,
  );
});

test("validatePanelModelSelection rejects too many models with a clear message", () => {
  const known = ["a", "b", "c", "d", "e", "f"];
  assert.throws(() => validatePanelModelSelection(known, known), /at most 5/);
});

test("validatePanelModelSelection rejects an unknown model id, naming it", () => {
  assert.throws(
    () => validatePanelModelSelection(["a/one", "z/ghost"], ["a/one", "b/two"]),
    /Unknown.*z\/ghost/i,
  );
});

test("validatePanelModelSelection dedupes before checking the count", () => {
  assert.throws(
    () => validatePanelModelSelection(["a/one", "a/one"], ["a/one", "b/two"]),
    /at least 2/,
  );
});

test("validatePanelModelSelection accepts a valid, distinct selection case-insensitively", () => {
  const selection = validatePanelModelSelection(["A/One", "b/two"], ["a/one", "b/two"]);
  assert.deepEqual(selection, ["A/One", "b/two"]);
});

test("validatePanelModels never throws while loading a config, even on garbage", () => {
  assert.deepEqual(validatePanelModels(null), []);
  assert.deepEqual(validatePanelModels("not-an-array"), []);
  assert.deepEqual(validatePanelModels(["a", "", "a", 5, "b"]), ["a", "b"]);
  assert.equal(validatePanelModels(["a", "b", "c", "d", "e", "f", "g"]).length, PANEL_MAX_MODELS);
});

test("validateConfig round-trips panelModels and panelJudge, falling back to safe defaults on nonsense", () => {
  const good = validateConfig({
    ...DEFAULT_CONFIG,
    panelModels: ["a/one", "b/two"],
    panelJudge: true,
  });
  assert.deepEqual(good.panelModels, ["a/one", "b/two"]);
  assert.equal(good.panelJudge, true);

  const nonsense = validateConfig({
    ...DEFAULT_CONFIG,
    panelModels: "not-an-array" as never,
    panelJudge: "yes" as never,
  });
  assert.deepEqual(nonsense.panelModels, []);
  assert.equal(nonsense.panelJudge, false);
});

// ---------------------------------------------------------------------------
// ui/panel-view.ts — width and colour-independent readability
// ---------------------------------------------------------------------------

const WIDTHS = [40, 60, 80, 120] as const;

function sampleResult(): PanelResult {
  return {
    question:
      "Wie migriere ich die Tabelle ohne Downtime, wenn ein Batch-Job noch den alten Index liest?",
    answers: [
      successAnswer(
        "anthropic/claude-opus-5",
        "Erst additiv migrieren: neue Spalte parallel befüllen, den Batch-Job umstellen, dann erst die alte Spalte entfernen. ".repeat(3),
      ),
      failedAnswer(
        "openai/gpt-5.1-codex-mini",
        "OpenRouter HTTP 429: Rate limit reached, please try again later.",
      ),
      { ...successAnswer("google/gemini-3-pro", ""), text: "" },
    ],
    totalCostUsd: 0.0234,
    durationMs: 4_200,
  };
}

function sampleJudgment(): PanelJudgment {
  return {
    judgeModel: "anthropic/claude-opus-5",
    text: "Antwort 1 ist am gründlichsten und benennt den Batch-Job explizit; ich würde ihr folgen. ".repeat(2),
    costUsd: 0.004,
    durationMs: 1_800,
    error: null,
  };
}

test("renderPanel never exceeds the given width — collapsed, expanded, with or without a judgment", () => {
  const theme = createTheme({ level: 0 });
  const result = sampleResult();
  const judgment = sampleJudgment();
  for (const width of WIDTHS) {
    for (const expandedIndex of [null, 0, 1, 2] as const) {
      for (const withJudgment of [false, true]) {
        const lines = renderPanel(result, width, theme, {
          expandedIndex,
          judgment: withJudgment ? judgment : null,
        });
        for (const line of lines) {
          assert.ok(
            lineWidth(line) <= width,
            `width ${width}, expandedIndex ${expandedIndex}, judgment ${withJudgment}: „${plainText(line)}“ (${lineWidth(line)})`,
          );
        }
      }
    }
  }
});

test("at theme.level 0, every answer state is still distinguishable and no ANSI escapes leak in", () => {
  const theme = createTheme({ level: 0 });
  const result = sampleResult();
  const lines = renderPanel(result, 80, theme);
  const rendered = renderLines(lines, theme);
  for (const text of rendered) {
    assert.doesNotMatch(text, /\[/, `Stufe 0 darf keine ANSI-Codes ausgeben: ${JSON.stringify(text)}`);
  }
  const plain = lines.map(plainText).join("\n");
  const escape = (glyph: string) => glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(plain, new RegExp(escape(theme.glyph("ok")))); // successful answer
  assert.match(plain, new RegExp(escape(theme.glyph("failed")))); // failed answer
  assert.match(plain, new RegExp(escape(theme.glyph("warn")))); // empty-but-not-failed answer
});

test("a judge synthesis is clearly labelled and separated from the model answers", () => {
  const theme = createTheme({ level: 0 });
  const result = sampleResult();
  const judgment = sampleJudgment();
  const lines = renderPanel(result, 100, theme, { judgment });
  const plain = lines.map(plainText).join("\n");
  assert.match(plain, /Judge/);
  assert.match(plain, /gründlichsten/);
  const richterLines = lines.filter((line) => plainText(line).includes("Judge"));
  assert.equal(richterLines.length, 1, "\"Judge\" must appear only on the judge block's head line");
});

test("an expanded answer is marked distinctly from its collapsed teaser", () => {
  const theme = createTheme({ level: 0 });
  const result = sampleResult();
  const collapsed = plainText(renderPanel(result, 100, theme, { expandedIndex: null })[1]!);
  const expanded = plainText(renderPanel(result, 100, theme, { expandedIndex: 0 })[1]!);
  assert.notEqual(collapsed, expanded);
  assert.match(expanded, /full/);
});

// ---------------------------------------------------------------------------
// /panel slash command (src/commands.ts)
//
// The `/panel <frage>` run itself asks for confirmation via
// `@inquirer/prompts`' `confirm()` before spending anything — exactly like
// the existing `/clear` and `/allow allow-all` prompts, neither of which is
// driven end-to-end through `handleSlashCommand` in this suite either, since
// doing so needs a real (or injected-stdin) TTY. The building blocks that
// path calls — `askPanel`, `estimatePanelCost`, `proposePanelModels` — are
// covered above; here we cover every `/panel` subcommand that does not touch
// `confirm()`.
// ---------------------------------------------------------------------------

function collectOutput(): { out: CommandOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: {
      text(value: string): void {
        lines.push(value);
      },
      error(value: string, hint?: string): void {
        lines.push(hint ? `${value}\n${hint}` : value);
      },
    },
  };
}

function freshConfig(overrides: Partial<OrcodeConfigWithBudget> = {}): OrcodeConfigWithBudget {
  return {
    ...DEFAULT_CONFIG,
    reasoningByModel: {},
    budget: { ...DEFAULT_CONFIG.budget },
    fallbackModels: [...DEFAULT_CONFIG.fallbackModels],
    provider: { ...DEFAULT_CONFIG.provider },
    verify: { ...DEFAULT_CONFIG.verify, commands: [...DEFAULT_CONFIG.verify.commands] },
    panelModels: [...DEFAULT_CONFIG.panelModels],
    ...overrides,
  };
}

function sampleCatalog(): ModelInfo[] {
  return [
    model({ id: "a/one", intelligenceIndex: 80 }),
    model({ id: "b/two", intelligenceIndex: 75 }),
    model({ id: "c/three", intelligenceIndex: 70 }),
  ];
}

function fakeOpenRouter(models: ModelInfo[]): OpenRouterService {
  return {
    async loadModels() {
      return models;
    },
    async listModels() {
      return models;
    },
  } as unknown as OpenRouterService;
}

function fakeSession(): CommandContext["session"] {
  return {
    addCost() {},
    async save() {},
  } as unknown as CommandContext["session"];
}

interface Harness {
  context: CommandContext;
  lines: string[];
  appHome: string;
}

async function panelHarness(
  options: {
    models?: ModelInfo[];
    panelModels?: string[];
    panelJudge?: boolean;
    glyphMode?: OrcodeConfigWithBudget["appearance"]["glyphMode"];
  } = {},
): Promise<Harness> {
  const appHome = await mkdtemp(join(tmpdir(), "routercode-panel-cmd-"));
  const ruleStore = await RuleStore.load(appHome);
  const { out, lines } = collectOutput();
  const credentials: CredentialStoreLike = {
    location: "Test-Speicher",
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
  };
  const context: CommandContext = {
    config: freshConfig({
      panelModels: options.panelModels ?? [],
      panelJudge: options.panelJudge ?? false,
      ...(options.glyphMode
        ? { appearance: { ...DEFAULT_CONFIG.appearance, glyphMode: options.glyphMode } }
        : {}),
    }),
    approvals: new ApprovalManager("allow-all"),
    openRouter: fakeOpenRouter(options.models ?? sampleCatalog()),
    session: fakeSession(),
    agent: {} as CommandContext["agent"],
    workspace: appHome,
    credentials,
    out,
    ruleStore,
    // MUST always be set to a tmp path: /panel models persists via saveConfig,
    // and the bare default writes straight into the real ~/.orcode.
    configPath: join(appHome, "config.json"),
  };
  return { context, lines, appHome };
}

test("/panel with no arguments shows status, including the unconfigured case", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel", context);
    assert.ok(lines.some((line) => /none configured/.test(line)));
    assert.ok(lines.some((line) => /Panel judge: off/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models sets and persists a valid selection", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel models a/one,b/two", context);
    assert.deepEqual(context.config.panelModels, ["a/one", "b/two"]);
    assert.ok(lines.some((line) => /a\/one, b\/two/.test(line)));
    const saved = JSON.parse(await readFile(context.configPath!, "utf8"));
    assert.deepEqual(saved.panelModels, ["a/one", "b/two"]);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models rejects an unknown model id and does not persist anything", async () => {
  const { context, appHome } = await panelHarness();
  try {
    await assert.rejects(
      handleSlashCommand("/panel models a/one,ghost/model", context),
      /Unknown.*ghost\/model/i,
    );
    assert.deepEqual(context.config.panelModels, []);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models rejects a single model (too few)", async () => {
  const { context, appHome } = await panelHarness();
  try {
    await assert.rejects(handleSlashCommand("/panel models a/one", context), /at least 2/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models with no arguments reports the current selection instead of erroring", async () => {
  const { context, lines, appHome } = await panelHarness({ panelModels: ["a/one", "b/two"] });
  try {
    await handleSlashCommand("/panel models", context);
    assert.ok(lines.some((line) => /a\/one, b\/two/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models with no arguments and none configured names the one next action, mirroring /panel's own wording (D5 invitation grammar)", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel models", context);
    const theme = createTheme();
    assert.deepEqual(lines, [
      `No panel models configured ${theme.glyph("emdash")} /panel <question> suggests some from the catalog.`,
    ]);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel judge toggles and persists the judge setting", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel judge on", context);
    assert.equal(context.config.panelJudge, true);
    assert.ok(lines.some((line) => /Panel judge: on/.test(line)));

    await handleSlashCommand("/panel judge off", context);
    assert.equal(context.config.panelJudge, false);

    const saved = JSON.parse(await readFile(context.configPath!, "utf8"));
    assert.equal(saved.panelJudge, false);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel judge rejects anything other than on|off", async () => {
  const { context, appHome } = await panelHarness();
  try {
    await assert.rejects(handleSlashCommand("/panel judge maybe", context), /on\|off/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FIX-10 fix round 1 (F5): the /panel consent-point copy itself, via the
// the shared `confirm` seam — judge-on and judge-off, preview and confirm title.
// ---------------------------------------------------------------------------

test("F5/H2: with the judge on, /panel's preview and confirm name the judging call on config.mainModel and include it in the total", async () => {
  const { context, lines, appHome } = await panelHarness({
    panelModels: ["a/one", "b/two"],
    panelJudge: true,
  });
  context.config.mainModel = "c/three";
  const confirmTitles: string[] = [];
  context.confirm = async (request) => {
    confirmTitles.push(request.title);
    return false; // cancel — this test pins the consent-point copy only
  };
  try {
    await handleSlashCommand("/panel what is the answer", context);

    // Preview line: judge named, "≈ … total" carries the estimate (F9
    // wording), and the judge is the JUDGE-priced call — F4: its estimate
    // must exceed a bare panelist estimate for the same model.
    const preview = lines.find((line) => line.includes("2 models"));
    assert.ok(preview, lines.join("\n"));
    assert.match(preview!, /^2 models \+ 1 judging call on c\/three ≈ \$\d/);
    const judgeRow = lines.find((line) => line.includes("c/three (judge)"));
    assert.ok(judgeRow, "the judge breakdown row must render");
    assert.match(judgeRow!, /\$\d/);
    // F4: the judge row's estimate is priced at the larger judge input
    // (question + 2 × output allowance), so it must be strictly greater
    // than the panelists' own per-call estimate on identical pricing.
    const panelistRow = lines.find((line) => /^ {2}a\/one\s+\$\d/.test(line));
    assert.ok(panelistRow, lines.join("\n"));
    const usdOf = (row: string): number => Number(/\$(\d+\.\d+)/.exec(row)![1]);
    assert.ok(
      usdOf(judgeRow!) > usdOf(panelistRow!),
      `judge estimate (${judgeRow}) must exceed a panelist's (${panelistRow})`,
    );
    // Confirm title: the consent-point copy names the judge round.
    assert.equal(confirmTitles.length, 1);
    assert.match(confirmTitles[0]!, /^Query 2 models in parallel \+ 1 judging call on c\/three \(≈ \$\d/);
    // Cancel-never-success: nothing ran.
    assert.ok(lines.some((line) => /Panel cancelled/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("F5/H2: with the judge off, /panel's preview and confirm are the pre-H2 copy — no judge suffix, no judge row", async () => {
  const { context, lines, appHome } = await panelHarness({
    panelModels: ["a/one", "b/two"],
    panelJudge: false,
  });
  const confirmTitles: string[] = [];
  context.confirm = async (request) => {
    confirmTitles.push(request.title);
    return false;
  };
  try {
    await handleSlashCommand("/panel what is the answer", context);

    const preview = lines.find((line) => line.includes("2 models"));
    assert.ok(preview, lines.join("\n"));
    assert.match(preview!, /^2 models × estimated ≈ \$\d/);
    assert.ok(!lines.some((line) => line.includes("judging call")), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes("(judge)")), lines.join("\n"));
    assert.equal(confirmTitles.length, 1);
    assert.match(confirmTitles[0]!, /^Query 2 models in parallel \(≈ \$\d/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("F5/H2: an accepted judge-on run really synthesizes on config.mainModel — the model the confirm promised", async () => {
  const { context, lines, appHome } = await panelHarness({
    panelModels: ["a/one", "b/two"],
    panelJudge: true,
  });
  context.config.mainModel = "c/three";
  context.confirm = async () => true;
  const calls: Array<{ model: string; question: string }> = [];
  context.panelCall = async ({ model, question }) => {
    calls.push({ model, question });
    return { text: `answer from ${model}`, costUsd: 0.001, inputTokens: 10, outputTokens: 5 };
  };
  try {
    await handleSlashCommand("/panel what is the answer", context);

    assert.deepEqual(calls.map((call) => call.model), ["a/one", "b/two", "c/three"]);
    const judgeCall = calls.at(-1)!;
    // The judge input really is question + every panel answer — the larger
    // input F4 prices, not the bare question.
    assert.match(judgeCall.question, /answer from a\/one/);
    assert.match(judgeCall.question, /answer from b\/two/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel show without a prior run explains itself instead of throwing, naming the one next action (D5 invitation grammar)", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel show 1", context);
    const theme = createTheme();
    assert.ok(lines.some((line) => line === `No panel run yet this session ${theme.glyph("emdash")} /panel <question> starts one.`));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel show renders the requested answer once a panel has run", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "Kurze Antwort A"), successAnswer("b/two", "Kurze Antwort B")],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    await handleSlashCommand("/panel show 2", context);
    const joined = lines.join("\n");
    assert.match(joined, /b\/two/);
    assert.match(joined, /full/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel show rejects an out-of-range index with a clear message", async () => {
  const { context, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "A"), successAnswer("b/two", "B")],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    await assert.rejects(handleSlashCommand("/panel show 5", context), /1-2/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// F6 ASCII sweep: `commandTheme` (src/commands.ts) reads the plain-CLI theme
// from `context.config.appearance.glyphMode` (the F5 accessor fix — F4
// review's ascii gap, ruling 5) instead of always defaulting to Unicode.
// This drives `renderPanel`'s glyphs end-to-end through the real `/panel
// show` command path, not just a directly-constructed ascii theme, so it
// actually locks in that accessor wiring rather than `renderPanel`'s own
// glyph correctness (already covered above).
test('/panel show under glyphMode: "ascii" renders no Unicode glyphs (locks in the F5 accessor fix)', async () => {
  const { context, lines, appHome } = await panelHarness({ glyphMode: "ascii" });
  try {
    // Every string here is deliberately plain ASCII, unlike this file's usual
    // German example content (`sampleResult`/`sampleJudgment`) — the point of
    // this test is to catch a glyph-mode leak, not to flag incidental
    // non-ASCII fixture prose that was never in scope.
    context.lastPanelResult = {
      question: "Test question",
      answers: [
        successAnswer("a/one", "Short answer A"),
        failedAnswer("b/two", "boom"),
        { ...successAnswer("c/three", ""), text: "" },
      ],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    context.lastPanelJudgment = {
      judgeModel: "a/one",
      text: "Answer 1 is the most thorough.",
      costUsd: 0.004,
      durationMs: 1_800,
      error: null,
    };
    await handleSlashCommand("/panel show 1", context);
    // Strips ANSI SGR codes first so this stays meaningful regardless of
    // whether the test environment's chalk level is 0 — the assertion is
    // about glyph shapes, not about color escapes leaking through.
    const rendered = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(
      rendered,
      /[^\x09\x0a\x20-\x7e]/,
      `glyphMode: "ascii" must never leak a Unicode glyph: ${JSON.stringify(rendered)}`,
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// D5 fix round 1: `panelAskCommand`'s own auto-suggestion notice (the
// mirror of the ascii-mode pin above, for the one code path in this family
// that can't be driven end to end here — see `panelAutoSuggestNotice`'s own
// doc comment in commands.ts for why `/panel <question>` itself isn't
// exercised through `handleSlashCommand` in this suite: its unconditional
// `confirm()` call needs a real or injected-stdin TTY, exactly like `/clear`
// and `/allow allow-all` above).
test('panelAutoSuggestNotice under glyphMode: "ascii" renders no Unicode glyphs, and under unicode renders the theme emdash, never a raw literal', () => {
  const unicode = createTheme();
  assert.equal(
    panelAutoSuggestNotice(unicode, ["a/one", "b/two", "c/three"]),
    `No panel configured ${unicode.glyph("emdash")} suggestion from different providers: a/one, b/two, c/three`,
  );

  const ascii = createTheme({ ascii: true, level: 0 });
  const rendered = panelAutoSuggestNotice(ascii, ["a/one", "b/two", "c/three"]);
  assert.doesNotMatch(
    rendered,
    /[^\x09\x0a\x20-\x7e]/,
    `glyphMode: "ascii" must never leak a Unicode glyph: ${JSON.stringify(rendered)}`,
  );
  assert.equal(rendered, "No panel configured - suggestion from different providers: a/one, b/two, c/three");
});

test("/panel show renders as a block via onPanelResult instead of plain text, when the hook is set", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "Kurze Antwort A"), successAnswer("b/two", "Kurze Antwort B")],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    const calls: Array<{ result: PanelResult; judgment: PanelJudgment | null; expandedIndex: number | null }> = [];
    context.onPanelResult = (result, judgment, expandedIndex) => {
      calls.push({ result, judgment, expandedIndex });
    };
    await handleSlashCommand("/panel show 2", context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.expandedIndex, 1);
    assert.equal(calls[0]!.result, context.lastPanelResult);
    // The command's own out.text lines never carry the rendered panel text
    // once onPanelResult takes over — only the small "full answer" hint may.
    assert.ok(lines.every((line) => !/Kurze Antwort/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// /panel use <n> (src/commands.ts) — hands one answer over to the normal chat
// as context, via the same `seedNextMessage` seam cli.ts's own interrupted-run
// "Fortsetzen" choice uses for `ui.insertInputText`/the plain loop's pending
// seed.
// ---------------------------------------------------------------------------

test("/panel use without a prior run explains itself instead of throwing, naming the one next action (D5 invitation grammar)", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel use 1", context);
    const theme = createTheme();
    assert.ok(lines.some((line) => line === `No panel run yet this session ${theme.glyph("emdash")} /panel <question> starts one.`));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel use rejects an out-of-range index with a clear message", async () => {
  const { context, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "A"), successAnswer("b/two", "B")],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    await assert.rejects(handleSlashCommand("/panel use 5", context), /1-2/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel use rejects an answer that failed or came back empty", async () => {
  const { context, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [failedAnswer("a/one", "HTTP 500"), { ...successAnswer("b/two", ""), text: "" }],
      totalCostUsd: 0,
      durationMs: 500,
    };
    await assert.rejects(handleSlashCommand("/panel use 1", context), /has no usable text/);
    await assert.rejects(handleSlashCommand("/panel use 2", context), /has no usable text/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel use seeds the answer, labelled by its model, into the next message via seedNextMessage", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "Kurze Antwort A"), successAnswer("b/two", "Kurze Antwort B")],
      totalCostUsd: 0.002,
      durationMs: 500,
    };
    const seeded: string[] = [];
    context.seedNextMessage = (text) => seeded.push(text);
    await handleSlashCommand("/panel use 2", context);
    assert.equal(seeded.length, 1);
    assert.match(seeded[0]!, /^Answer from b\/two/);
    assert.match(seeded[0]!, /Kurze Antwort B/);
    // Confirms the seam was used, not a silent no-op.
    assert.ok(lines.some((line) => /will be prepended to the next message/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel use prints the labelled answer directly when seedNextMessage is unset", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    context.lastPanelResult = {
      question: "Testfrage",
      answers: [successAnswer("a/one", "Kurze Antwort A")],
      totalCostUsd: 0.001,
      durationMs: 500,
    };
    await handleSlashCommand("/panel use 1", context);
    assert.ok(lines.some((line) => /^Answer from a\/one/.test(line) && /Kurze Antwort A/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// Sanity check that the exported bounds actually match what askPanel enforces.
test("PANEL_MIN_MODELS/PANEL_MAX_MODELS are 2 and 5", () => {
  assert.equal(PANEL_MIN_MODELS, 2);
  assert.equal(PANEL_MAX_MODELS, 5);
});
