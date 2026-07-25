/**
 * Sends a recorded audio file to a model as `input_audio` content and
 * returns the transcription (`/whisper`, `/voice`). Deliberately as narrow
 * as `compressor.ts`: one model call, no tools, cost tracked the same way.
 */

import { readFile } from "node:fs/promises";
import type { NewUserMessageItem, OpenRouter } from "@openrouter/agent";
import { modelCapabilities } from "./openrouter.js";
import { SDK_RETRY_CODES } from "./reconnect.js";
import type { ModelInfo } from "./types.js";
import type { RecordedAudio } from "./voice.js";
import { errorMessage } from "./utils.js";

/** Output cap of a single transcription call — a few minutes of speech easily fits. */
export const TRANSCRIBE_MAX_OUTPUT_TOKENS = 2_000;

/**
 * Fixed instruction: transcribe only, never answer, never translate, never
 * add anything the model was not asked for. Kept in English — instructions
 * to the model are English throughout this codebase; only user-facing text
 * is German.
 */
export const TRANSCRIBE_INSTRUCTIONS =
  "You transcribe spoken audio into written text, nothing else. " +
  "Output only the verbatim transcription of what was said, in the language it was spoken in. " +
  "Do not translate it, do not answer it, do not comment on it, and do not add any text, punctuation " +
  "convention, or formatting that was not part of the spoken audio. If the audio is silent or " +
  "unintelligible, output nothing.";

export interface TranscriptionResult {
  text: string;
  costUsd: number;
  model: string;
}

/** The subset of `OpenRouterService` this module actually needs — kept narrow so tests can pass a tiny fake. */
export interface ModelLookup {
  findModel(modelId: string, signal?: AbortSignal): Promise<ModelInfo | null>;
  listModels(search?: string, toolsOnly?: boolean, signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface TranscribeAudioOptions {
  client: OpenRouter;
  openRouter: ModelLookup;
  /** The configured transcription model id (`config.transcriptionModel`). */
  modelId: string;
  audio: RecordedAudio;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to reading `audio.path` from disk. */
  readAudioFile?: (path: string) => Promise<Buffer>;
}

/**
 * Validates that `modelId` exists and can accept audio input, then sends the
 * recording and returns the plain transcription text. Rejects with a clear
 * German message for every failure mode: unknown model, no audio capability,
 * or a failed model call.
 */
export async function transcribeAudio(options: TranscribeAudioOptions): Promise<TranscriptionResult> {
  const modelId = options.modelId.trim();
  if (!modelId) {
    throw new Error(
      "Kein Transkriptionsmodell konfiguriert. Setze `transcriptionModel` in der Konfiguration.",
    );
  }

  let model: ModelInfo | null;
  try {
    model = await options.openRouter.findModel(modelId, options.signal);
  } catch (error) {
    throw new Error(`Transkriptionsmodell "${modelId}" konnte nicht geprüft werden: ${errorMessage(error)}`);
  }
  if (!model) {
    throw new Error(
      `Transkriptionsmodell "${modelId}" wurde bei OpenRouter nicht gefunden. Prüfe die Modell-ID in der Konfiguration.`,
    );
  }
  if (!modelCapabilities(model).audioInput) {
    const suggestion = await suggestAudioModel(options.openRouter, options.signal);
    throw new Error(
      `Transkriptionsmodell "${modelId}" unterstützt laut OpenRouter keine Audio-Eingabe. ` +
        `Wähle ein Modell mit Audio-Fähigkeit.${suggestion ? ` Vorschlag: ${suggestion}.` : ""}`,
    );
  }

  const read = options.readAudioFile ?? ((path: string) => readFile(path));
  let bytes: Buffer;
  try {
    bytes = await read(options.audio.path);
  } catch (error) {
    throw new Error(`Aufnahmedatei konnte nicht gelesen werden: ${errorMessage(error)}`);
  }
  const base64 = bytes.toString("base64");

  const audioItem: NewUserMessageItem = {
    role: "user",
    content: [
      {
        type: "input_audio",
        inputAudio: { data: base64, format: options.audio.format },
      },
    ],
  };

  let observedCost = 0;
  const call = options.client.callModel(
    {
      model: modelId,
      instructions: TRANSCRIBE_INSTRUCTIONS,
      input: [audioItem],
      maxOutputTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS,
      hooks: {
        PostModelCall: [
          {
            handler: ({ usage }: { usage?: { cost?: number } }) => {
              observedCost += usage?.cost ?? 0;
            },
          },
        ],
      },
    },
    {
      ...(options.signal ? { signal: options.signal } : {}),
      retryCodes: [...SDK_RETRY_CODES],
    },
  );

  let text: string;
  try {
    text = (await call.getText()).trim();
  } catch (error) {
    throw new Error(`Transkription fehlgeschlagen: ${errorMessage(error)}`);
  }
  let costUsd = observedCost;
  try {
    const response = await call.getResponse();
    costUsd = observedCost || response.usage?.cost || 0;
  } catch {
    // Cost is best-effort; the transcription text itself already succeeded.
  }
  return { text, costUsd, model: modelId };
}

/** Cheapest, non-variable-priced audio-input-capable model — used only to enrich the "wrong model" error message. */
export function selectDefaultTranscriptionModel(models: readonly ModelInfo[]): ModelInfo | null {
  const candidates = models.filter((model) => {
    const capabilities = modelCapabilities(model);
    return capabilities.audioInput && !capabilities.variablePricing;
  });
  candidates.sort(
    (left, right) =>
      modelCapabilities(left).promptPricePerMillion - modelCapabilities(right).promptPricePerMillion,
  );
  return candidates[0] ?? null;
}

async function suggestAudioModel(openRouter: ModelLookup, signal?: AbortSignal): Promise<string | null> {
  try {
    const models = await openRouter.listModels("", false, signal);
    return selectDefaultTranscriptionModel(models)?.id ?? null;
  } catch {
    return null;
  }
}
