import assert from "node:assert/strict";
import test from "node:test";
import { modelIdentityInstructions } from "../src/agent.js";
import {
  formatPricePerMillion,
  isTextGenerationModel,
  modelChoiceDescription,
  rankModels,
} from "../src/commands.js";
import {
  isCompressorModelCandidate,
  isMainModelCandidate,
} from "../src/openrouter.js";
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
  assert.equal(formatPricePerMillion(-1), "variable");
  assert.equal(formatPricePerMillion(0), "free");
  // F6 formatter consolidation: the $X/M math now delegates to
  // formatCatalogPricePerMillion (utils.ts) — trimmed decimals ("$3/M"),
  // not a fixed three-decimal "$3.000/M" implying false precision.
  assert.equal(formatPricePerMillion(0.000003), "$3/M");
});

// Phase F3 (information-dense pickers): the row shape is now the same
// `<provider> · $in/M in · $out/M out · <ctx>` binding shape every /model
// picker composes (`formatModelRouteDetail`, `utils.ts`) — updated from the
// old free-text "Input $X/M · Context N · Tools, Reasoning, Images" pin,
// which predates the binding mockup and no longer matches it.
test("picker description composes provider, price, and context — the binding /model row shape", () => {
  assert.equal(modelChoiceDescription(models[1]), "moonshotai · $3/M in · $15/M out · 1M");
});

test("picker description shows subscription, never a fabricated price, for a dynamic/-1-priced route", () => {
  assert.equal(modelChoiceDescription(models[0]), "openrouter · subscription · 1M");
});

test("picker description shows a genuinely zero-listed price honestly, not a placeholder", () => {
  assert.equal(modelChoiceDescription(models[2]), "google · $0/M in · $0/M out · 1M");
});

test("picker description omits the context segment when contextLength is unknown (0)", () => {
  assert.equal(
    modelChoiceDescription(model({ id: "vendor/no-ctx", name: "No context", contextLength: 0 })),
    "vendor · $0/M in · $0/M out",
  );
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

test("main role requires text input, text output, and tools and fails closed", () => {
  const cases = [
    {
      name: "complete main model",
      candidate: model({ id: "provider/complete", name: "Complete" }),
      accepted: true,
    },
    {
      name: "no text input",
      candidate: model({
        id: "provider/image-input",
        name: "Image input",
        inputModalities: ["image"],
      }),
      accepted: false,
    },
    {
      name: "no text output",
      candidate: model({
        id: "provider/image-output",
        name: "Image output",
        outputModalities: ["image"],
      }),
      accepted: false,
    },
    {
      name: "no tools",
      candidate: model({
        id: "provider/no-tools",
        name: "No tools",
        supportedParameters: ["reasoning"],
      }),
      accepted: false,
    },
    {
      name: "missing catalogue capabilities",
      candidate: model({
        id: "provider/missing-capabilities",
        name: "Missing capabilities",
        supportedParameters: [],
        inputModalities: [],
        outputModalities: [],
      }),
      accepted: false,
    },
  ] as const;

  for (const entry of cases) {
    assert.equal(
      isMainModelCandidate(entry.candidate),
      entry.accepted,
      entry.name,
    );
  }
});

test("openrouter auto is the exact main-only capability exception", () => {
  const missingCapabilities: Pick<
    ModelInfo,
    "supportedParameters" | "inputModalities" | "outputModalities"
  > = {
    supportedParameters: [],
    inputModalities: [],
    outputModalities: [],
  };
  const auto = model({
    id: "openrouter/auto",
    name: "OpenRouter Auto",
    ...missingCapabilities,
  });
  const anotherDynamicRoute = model({
    id: "openrouter/other",
    name: "Other dynamic route",
    ...missingCapabilities,
  });

  assert.equal(isMainModelCandidate(auto), true);
  assert.equal(isCompressorModelCandidate(auto), false);
  assert.equal(isMainModelCandidate(anotherDynamicRoute), false);
});

test("compressor role requires text output but accepts any input modalities", () => {
  const cases = [
    {
      name: "text input",
      candidate: model({ id: "provider/text", name: "Text" }),
      accepted: true,
    },
    {
      name: "image input without text",
      candidate: model({
        id: "provider/image-to-text",
        name: "Image to text",
        inputModalities: ["image"],
        supportedParameters: [],
      }),
      accepted: true,
    },
    {
      name: "audio input without text",
      candidate: model({
        id: "provider/audio-to-text",
        name: "Audio to text",
        inputModalities: ["audio"],
        supportedParameters: [],
      }),
      accepted: true,
    },
    {
      name: "no declared input",
      candidate: model({
        id: "provider/no-input-to-text",
        name: "No input metadata",
        inputModalities: [],
        supportedParameters: [],
      }),
      accepted: true,
    },
    {
      name: "image output only",
      candidate: model({
        id: "provider/image-only",
        name: "Image only",
        outputModalities: ["image"],
      }),
      accepted: false,
    },
    {
      name: "missing output metadata",
      candidate: model({
        id: "provider/missing-output",
        name: "Missing output",
        outputModalities: [],
      }),
      accepted: false,
    },
  ] as const;

  for (const entry of cases) {
    assert.equal(
      isCompressorModelCandidate(entry.candidate),
      entry.accepted,
      entry.name,
    );
  }
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
