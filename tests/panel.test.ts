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
      assert.match(error.message, /zwischen 2 und 5/);
      return true;
    },
  );
  await assert.rejects(
    askPanel({
      question: "Frage",
      models: ["a", "b", "c", "d", "e", "f"],
      callModel: call,
    }),
    /zwischen 2 und 5/,
  );
});

test("askPanel rejects an empty question", async () => {
  const { call } = fakePanelCall(async () => ({ text: "x", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
  await assert.rejects(
    askPanel({ question: "   ", models: ["a/one", "b/two"], callModel: call }),
    /Frage/,
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
    /mindestens zwei/,
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
    /mindestens 2/,
  );
});

test("validatePanelModelSelection rejects too many models with a clear message", () => {
  const known = ["a", "b", "c", "d", "e", "f"];
  assert.throws(() => validatePanelModelSelection(known, known), /höchstens 5/);
});

test("validatePanelModelSelection rejects an unknown model id, naming it", () => {
  assert.throws(
    () => validatePanelModelSelection(["a/one", "z/ghost"], ["a/one", "b/two"]),
    /Unbekannte.*z\/ghost/i,
  );
});

test("validatePanelModelSelection dedupes before checking the count", () => {
  assert.throws(
    () => validatePanelModelSelection(["a/one", "a/one"], ["a/one", "b/two"]),
    /mindestens 2/,
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
        "OpenRouter HTTP 429: Rate-Limit erreicht, bitte später erneut versuchen.",
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
  assert.match(plain, /Richter/);
  assert.match(plain, /gründlichsten/);
  const richterLines = lines.filter((line) => plainText(line).includes("Richter"));
  assert.equal(richterLines.length, 1, "„Richter“ darf nur auf der Kopfzeile des Richterblocks stehen");
});

test("an expanded answer is marked distinctly from its collapsed teaser", () => {
  const theme = createTheme({ level: 0 });
  const result = sampleResult();
  const collapsed = plainText(renderPanel(result, 100, theme, { expandedIndex: null })[1]!);
  const expanded = plainText(renderPanel(result, 100, theme, { expandedIndex: 0 })[1]!);
  assert.notEqual(collapsed, expanded);
  assert.match(expanded, /vollständig/);
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
    assert.ok(lines.some((line) => /keine konfiguriert/.test(line)));
    assert.ok(lines.some((line) => /Panel-Richter: aus/.test(line)));
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
      /Unbekannte.*ghost\/model/i,
    );
    assert.deepEqual(context.config.panelModels, []);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/panel models rejects a single model (too few)", async () => {
  const { context, appHome } = await panelHarness();
  try {
    await assert.rejects(handleSlashCommand("/panel models a/one", context), /mindestens 2/);
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

test("/panel judge toggles and persists the judge setting", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel judge on", context);
    assert.equal(context.config.panelJudge, true);
    assert.ok(lines.some((line) => /Panel-Richter: an/.test(line)));

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

test("/panel show without a prior run explains itself instead of throwing", async () => {
  const { context, lines, appHome } = await panelHarness();
  try {
    await handleSlashCommand("/panel show 1", context);
    assert.ok(lines.some((line) => /Noch kein Panel-Lauf/.test(line)));
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
    assert.match(joined, /vollständig/);
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

// Sanity check that the exported bounds actually match what askPanel enforces.
test("PANEL_MIN_MODELS/PANEL_MAX_MODELS are 2 and 5", () => {
  assert.equal(PANEL_MIN_MODELS, 2);
  assert.equal(PANEL_MAX_MODELS, 5);
});
