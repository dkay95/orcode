import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReasoningRequest,
  getReasoningSetting,
  planReasoningRequest,
  reasoningChoices,
  reasoningLabel,
  setReasoningSetting,
  supportsReasoning,
  validateReasoningSetting,
} from "../src/reasoning.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ModelInfo } from "../src/types.js";

const model: ModelInfo = {
  id: "anthropic/example",
  name: "Example",
  description: "",
  contextLength: 200_000,
  promptPrice: 0.000003,
  completionPrice: 0.000015,
  supportedParameters: ["tools", "reasoning"],
  inputModalities: ["text"],
  outputModalities: ["text"],
  reasoning: {
    defaultEffort: "high",
    defaultEnabled: true,
    mandatory: false,
    supportedEfforts: ["low", "high", "xhigh"],
    supportsMaxTokens: true,
  },
};

test("reasoning request omits auto and maps effort or budget", () => {
  assert.equal(buildReasoningRequest({ mode: "auto" }), undefined);
  assert.deepEqual(
    buildReasoningRequest({ mode: "effort", effort: "high" }),
    { enabled: true, effort: "high" },
  );
  assert.deepEqual(
    buildReasoningRequest({ mode: "effort", effort: "none" }),
    { enabled: false, effort: "none" },
  );
  assert.deepEqual(
    buildReasoningRequest({ mode: "budget", maxTokens: 8_000 }),
    { enabled: true, maxTokens: 8_000 },
  );
});

test("reasoning choices follow model metadata and explain xhigh as ultra", () => {
  const choices = reasoningChoices(model, { mode: "effort", effort: "high" });
  assert.deepEqual(
    choices
      .filter((choice) => choice.value.startsWith("effort:"))
      .map((choice) => choice.value),
    ["effort:low", "effort:high", "effort:xhigh"],
  );
  assert.match(
    choices.find((choice) => choice.value === "effort:xhigh")?.label ?? "",
    /Ultra.*xhigh/,
  );
  assert.ok(choices.some((choice) => choice.value === "budget:8000"));
  assert.equal(reasoningLabel({ mode: "budget", maxTokens: 8_000 }), "8K");
});

test("reasoning settings persist independently per model", () => {
  const config = { ...DEFAULT_CONFIG, reasoningByModel: {} };
  setReasoningSetting(config, { mode: "effort", effort: "high" }, model.id);
  setReasoningSetting(
    config,
    { mode: "budget", maxTokens: 4_000 },
    "openrouter/auto",
  );
  assert.deepEqual(getReasoningSetting(config, model.id), {
    mode: "effort",
    effort: "high",
  });
  assert.deepEqual(getReasoningSetting(config, "openrouter/auto"), {
    mode: "budget",
    maxTokens: 4_000,
  });
});

const plainModel: ModelInfo = {
  id: "vendor/plain",
  name: "Plain",
  description: "",
  contextLength: 32_000,
  promptPrice: 0.000001,
  completionPrice: 0.000002,
  supportedParameters: ["tools"],
  inputModalities: ["text"],
  outputModalities: ["text"],
};

test("Modelle ohne Reasoning bekommen keinen Reasoning-Parameter", () => {
  assert.equal(supportsReasoning(plainModel), false);
  assert.equal(
    buildReasoningRequest({ mode: "effort", effort: "high" }, plainModel),
    undefined,
  );
  const plan = planReasoningRequest(
    { mode: "budget", maxTokens: 8_000 },
    plainModel,
  );
  assert.equal(plan.request, undefined);
  assert.equal(plan.degraded, true);
  assert.match(plan.note ?? "", /keine Reasoning-Unterstützung/);

  const choices = reasoningChoices(plainModel, { mode: "auto" });
  assert.deepEqual(choices.map((choice) => choice.value), ["auto"]);
  assert.match(choices[0]!.description, /kein Reasoning/);
});

test("nicht unterstützte Effort-Stufe wird auf die nächstliegende abgebildet", () => {
  // low und high sind gleich weit von medium entfernt; die günstigere gewinnt.
  const plan = planReasoningRequest({ mode: "effort", effort: "medium" }, model);
  assert.deepEqual(plan.request, { enabled: true, effort: "low" });
  assert.equal(plan.degraded, true);
  assert.match(plan.note ?? "", /unterstützt medium nicht/);

  const upward = planReasoningRequest(
    { mode: "effort", effort: "minimal" },
    { ...model, reasoning: { ...model.reasoning!, supportedEfforts: ["high", "xhigh"] } },
  );
  assert.deepEqual(upward.request, { enabled: true, effort: "high" });
});

test("Token-Budget wird zur Effort-Stufe, wenn das Modell kein Budget kennt", () => {
  const effortOnly: ModelInfo = {
    ...model,
    reasoning: { ...model.reasoning!, supportsMaxTokens: false },
  };
  const plan = planReasoningRequest({ mode: "budget", maxTokens: 16_000 }, effortOnly);
  assert.deepEqual(plan.request, { enabled: true, effort: "high" });
  assert.equal(plan.degraded, true);
  assert.match(plan.note ?? "", /kein Reasoning-Token-Budget/);
});

test("Budget wird auf das Ausgabemaximum des Modells begrenzt", () => {
  const limited: ModelInfo = { ...model, maxCompletionTokens: 4_000 };
  const plan = planReasoningRequest({ mode: "budget", maxTokens: 32_000 }, limited);
  assert.deepEqual(plan.request, { enabled: true, maxTokens: 4_000 });
  assert.equal(plan.degraded, true);
});

test("Reasoning-Pflichtmodelle lassen sich nicht abschalten", () => {
  const mandatory: ModelInfo = {
    ...model,
    reasoning: {
      ...model.reasoning!,
      mandatory: true,
      supportedEfforts: ["low", "high"],
    },
  };
  const plan = planReasoningRequest({ mode: "effort", effort: "none" }, mandatory);
  assert.deepEqual(plan.request, { enabled: true, effort: "low" });
  assert.equal(plan.degraded, true);
  assert.deepEqual(
    planReasoningRequest({ mode: "effort", effort: "none" }, model).request,
    { enabled: false, effort: "none" },
  );
});

test("ohne Modellwissen bleibt das Mapping unverändert", () => {
  assert.deepEqual(
    buildReasoningRequest({ mode: "effort", effort: "medium" }),
    { enabled: true, effort: "medium" },
  );
  assert.deepEqual(
    buildReasoningRequest({ mode: "budget", maxTokens: 8_000 }),
    { enabled: true, maxTokens: 8_000 },
  );
});

test("unsinnige Budgets werden abgelehnt", () => {
  assert.throws(
    () => validateReasoningSetting({ mode: "budget", maxTokens: 0 }, null),
    /mindestens 1 Token/,
  );
});

test("unsupported effort and mandatory off are rejected", () => {
  assert.throws(
    () =>
      validateReasoningSetting(
        { mode: "effort", effort: "medium" },
        model,
      ),
    /unterstützt medium nicht/,
  );
  assert.throws(
    () =>
      validateReasoningSetting(
        { mode: "effort", effort: "none" },
        {
          ...model,
          reasoning: {
            ...model.reasoning!,
            mandatory: true,
            supportedEfforts: null,
          },
        },
      ),
    /erfordert Reasoning/,
  );
});
