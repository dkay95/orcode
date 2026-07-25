import assert from "node:assert/strict";
import test from "node:test";
import type { OpenRouter } from "@openrouter/agent";
import {
  selectDefaultTranscriptionModel,
  transcribeAudio,
  TRANSCRIBE_INSTRUCTIONS,
  type ModelLookup,
} from "../src/transcribe.js";
import type { ModelInfo } from "../src/types.js";
import type { RecordedAudio } from "../src/voice.js";

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    description: "",
    contextLength: 32_000,
    promptPrice: 0.000_000_1,
    completionPrice: 0.000_000_3,
    supportedParameters: [],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...overrides,
  };
}

function lookup(models: ModelInfo[]): ModelLookup {
  return {
    findModel: async (modelId) => models.find((candidate) => candidate.id === modelId) ?? null,
    listModels: async () => models,
  };
}

function audio(overrides: Partial<RecordedAudio> = {}): RecordedAudio {
  return {
    path: "/tmp/does-not-matter.wav",
    format: "wav",
    sizeBytes: 4_096,
    durationMs: 2_000,
    quiet: false,
    ...overrides,
  };
}

interface CapturedCall {
  model: string;
  instructions: string;
  input: unknown;
}

function fakeClient(options: {
  text: string;
  costUsd?: number;
  onCall?: (call: CapturedCall) => void;
}): OpenRouter {
  return {
    callModel: (request: any) => {
      options.onCall?.({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
      });
      const hooks = request.hooks?.PostModelCall ?? [];
      for (const hook of hooks) {
        hook.handler({ usage: { cost: options.costUsd ?? 0 } });
      }
      return {
        getText: async () => options.text,
        getResponse: async () => ({ usage: { cost: options.costUsd ?? 0 } }),
      };
    },
  } as unknown as OpenRouter;
}

test("a model without audio input is rejected with a clear German message", async () => {
  const textOnly = model({ id: "text/only", inputModalities: ["text"] });
  const audioModel = model({ id: "audio/cheap", inputModalities: ["text", "audio"] });
  await assert.rejects(
    transcribeAudio({
      client: fakeClient({ text: "sollte nie aufgerufen werden" }),
      openRouter: lookup([textOnly, audioModel]),
      modelId: "text/only",
      audio: audio(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /keine Audio-Eingabe/);
      assert.match(error.message, /audio\/cheap/); // suggested from the model list
      return true;
    },
  );
});

test("an unknown model is rejected before any network call happens", async () => {
  let called = false;
  await assert.rejects(
    transcribeAudio({
      client: fakeClient({ text: "x", onCall: () => { called = true; } }),
      openRouter: lookup([]),
      modelId: "does/not-exist",
      audio: audio(),
    }),
    /wurde bei OpenRouter nicht gefunden/,
  );
  assert.equal(called, false);
});

test("an empty model id is rejected", async () => {
  await assert.rejects(
    transcribeAudio({
      client: fakeClient({ text: "x" }),
      openRouter: lookup([]),
      modelId: "   ",
      audio: audio(),
    }),
    /Kein Transkriptionsmodell konfiguriert/,
  );
});

test("a successful transcription sends input_audio content and returns trimmed text plus cost", async () => {
  const audioModel = model({ id: "mistralai/voxtral-small-24b-2507", inputModalities: ["text", "audio"] });
  let captured: CapturedCall | undefined;
  const result = await transcribeAudio({
    client: fakeClient({
      text: "  Hallo Welt.  ",
      costUsd: 0.000_42,
      onCall: (call) => {
        captured = call;
      },
    }),
    openRouter: lookup([audioModel]),
    modelId: audioModel.id,
    audio: audio({ format: "wav" }),
    readAudioFile: async () => Buffer.from("fake-wav-bytes"),
  });

  assert.equal(result.text, "Hallo Welt.");
  assert.equal(result.model, audioModel.id);
  assert.ok(Math.abs(result.costUsd - 0.000_42) < 1e-9);

  assert.equal(captured?.model, audioModel.id);
  assert.equal(captured?.instructions, TRANSCRIBE_INSTRUCTIONS);
  const input = captured?.input as Array<{ role: string; content: unknown[] }>;
  assert.equal(input[0]?.role, "user");
  const part = input[0]?.content[0] as { type: string; inputAudio: { data: string; format: string } };
  assert.equal(part.type, "input_audio");
  assert.equal(part.inputAudio.format, "wav");
  assert.equal(part.inputAudio.data, Buffer.from("fake-wav-bytes").toString("base64"));
});

test("a failed model call is reported as a clear German error", async () => {
  const audioModel = model({ id: "audio/cheap", inputModalities: ["text", "audio"] });
  const client = {
    callModel: () => ({
      getText: async () => {
        throw new Error("network exploded");
      },
      getResponse: async () => ({ usage: { cost: 0 } }),
    }),
  } as unknown as OpenRouter;
  await assert.rejects(
    transcribeAudio({
      client,
      openRouter: lookup([audioModel]),
      modelId: audioModel.id,
      audio: audio(),
      readAudioFile: async () => Buffer.from("x"),
    }),
    /Transkription fehlgeschlagen/,
  );
});

test("a file read failure is reported as a clear German error", async () => {
  const audioModel = model({ id: "audio/cheap", inputModalities: ["text", "audio"] });
  await assert.rejects(
    transcribeAudio({
      client: fakeClient({ text: "unreachable" }),
      openRouter: lookup([audioModel]),
      modelId: audioModel.id,
      audio: audio(),
      readAudioFile: async () => {
        throw new Error("ENOENT");
      },
    }),
    /Aufnahmedatei konnte nicht gelesen werden/,
  );
});

test("selectDefaultTranscriptionModel picks the cheapest non-variable-priced audio-capable model", () => {
  const textOnly = model({ id: "text/only", inputModalities: ["text"] });
  const variablePriced = model({
    id: "auto/router",
    inputModalities: ["text", "audio"],
    promptPrice: -1,
    completionPrice: -1,
  });
  const expensive = model({
    id: "audio/expensive",
    inputModalities: ["text", "audio"],
    promptPrice: 0.000_002,
    completionPrice: 0.000_01,
  });
  const cheap = model({
    id: "audio/cheap",
    inputModalities: ["text", "audio"],
    promptPrice: 0.000_000_1,
    completionPrice: 0.000_000_3,
  });
  const winner = selectDefaultTranscriptionModel([textOnly, variablePriced, expensive, cheap]);
  assert.equal(winner?.id, "audio/cheap");
});

test("selectDefaultTranscriptionModel returns null when nothing qualifies", () => {
  const textOnly = model({ id: "text/only", inputModalities: ["text"] });
  assert.equal(selectDefaultTranscriptionModel([textOnly]), null);
});
