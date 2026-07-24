import assert from "node:assert/strict";
import test from "node:test";
import { modelIdentityInstructions } from "../src/agent.js";
import {
  formatPricePerMillion,
  isTextGenerationModel,
  modelChoiceDescription,
  rankModels,
} from "../src/commands.js";
import type { ModelInfo } from "../src/types.js";

const models: ModelInfo[] = [
  model({
    id: "openrouter/auto",
    name: "OpenRouter Auto",
    description: "Dynamic route",
    promptPrice: -1,
    completionPrice: -1,
  }),
  model({
    id: "moonshotai/kimi-k3",
    name: "MoonshotAI: Kimi K3",
    description: "Long-horizon coding and agentic model",
    promptPrice: 0.000003,
    completionPrice: 0.000015,
    codingIndex: 76.2,
    agenticIndex: 50.1,
    inputModalities: ["text", "image"],
    reasoning: {
      defaultEffort: "high",
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ["low", "high", "max"],
      supportsMaxTokens: false,
    },
  }),
  model({
    id: "google/gemma-free",
    name: "Google Gemma Free",
    description: "Free text model",
    promptPrice: 0,
    completionPrice: 0,
  }),
];

test("single-letter model search filters and ranks by model name or id", () => {
  const ranked = rankModels(models, "K", "openrouter/auto");
  assert.deepEqual(ranked.map((entry) => entry.id), ["moonshotai/kimi-k3"]);
});

test("current model is first before the user starts typing", () => {
  const ranked = rankModels(models, "", "moonshotai/kimi-k3");
  assert.equal(ranked[0]?.id, "moonshotai/kimi-k3");
});

test("pricing labels handle dynamic and free routes", () => {
  assert.equal(formatPricePerMillion(-1), "variabel");
  assert.equal(formatPricePerMillion(0), "kostenlos");
  assert.equal(formatPricePerMillion(0.000003), "$3.000/M");
});

test("picker description includes price, context, and capabilities", () => {
  const description = modelChoiceDescription(models[1]);
  assert.match(description, /Input \$3\.000\/M/);
  assert.match(description, /Kontext/);
  assert.match(description, /Tools/);
  assert.match(description, /Reasoning/);
  assert.match(description, /Bilder/);
});

test("compressor picker accepts text generation models and rejects non-text output", () => {
  assert.equal(isTextGenerationModel(models[1]), true);
  assert.equal(
    isTextGenerationModel({
      ...models[1],
      id: "image/generator",
      outputModalities: ["image"],
    }),
    false,
  );
});

test("identity prompt names the exact selected model and rejects false branding", () => {
  const instructions = modelIdentityInstructions("moonshotai/kimi-k3").join("\n");
  assert.match(instructions, /moonshotai\/kimi-k3/);
  assert.match(instructions, /OpenRouter/);
  assert.match(instructions, /not .*OpenAI product/i);

  const auto = modelIdentityInstructions("openrouter/auto").join("\n");
  assert.match(auto, /upstream model may vary/);
  assert.match(auto, /do not guess/i);
});

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    description: "",
    contextLength: 1_048_576,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools", "reasoning", "structured_outputs"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...rest,
  };
}
