import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReasoningRequest,
  getReasoningSetting,
  reasoningChoices,
  reasoningLabel,
  setReasoningSetting,
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
