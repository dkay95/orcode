import { maxCost } from "@openrouter/agent";
import type { OpenRouter } from "@openrouter/agent";
import type { RouterCodeConfig } from "./types.js";
import { SessionStore } from "./session.js";
import { SDK_RETRY_CODES } from "./reconnect.js";

export interface CompressionResult {
  used: boolean;
  handoff: string;
  costUsd: number;
  originalChars: number;
  compressedChars: number;
}

export async function compressContext(
  client: OpenRouter,
  config: RouterCodeConfig,
  session: SessionStore,
  currentPrompt: string,
  signal?: AbortSignal,
): Promise<CompressionResult> {
  const rawContext = uncompressedContext(session, currentPrompt);
  const shouldCompress =
    config.compressionMode === "always" ||
    (config.compressionMode === "auto" &&
      rawContext.length >= config.compressionThresholdChars);

  if (!shouldCompress || config.compressionMode === "off") {
    return {
      used: false,
      handoff: rawContext,
      costUsd: 0,
      originalChars: rawContext.length,
      compressedChars: rawContext.length,
    };
  }

  let observedCost = 0;
  const result = client.callModel(
    {
      model: config.compressorModel,
      instructions: [
        "You are RouterCode's context compressor.",
        "Create a dense handoff for a stronger coding model.",
        "Preserve exact user intent, current task, decisions, constraints, file paths, APIs, commands, errors, test results, and unfinished work.",
        "Remove repetition, pleasantries, and obsolete speculation.",
        "Never invent facts. Clearly mark uncertainty.",
        "Return only the handoff, organized as compact plain text.",
      ].join(" "),
      input: rawContext,
      maxOutputTokens: 2_000,
      stopWhen: maxCost(config.compressorMaxCostUsd),
      hooks: {
        PostModelCall: [
          {
            handler: async ({ usage }) => {
              const callCost = usage?.cost ?? 0;
              observedCost += callCost;
              session.addCost("compressor", callCost);
              await session.save();
            },
          },
        ],
      },
    },
    {
      ...(signal ? { signal } : {}),
      retryCodes: [...SDK_RETRY_CODES],
    },
  );
  const handoff = (await result.getText()).trim();
  const response = await result.getResponse();
  const costUsd = observedCost || response.usage?.cost || 0;
  if (observedCost === 0 && costUsd > 0) {
    session.addCost("compressor", costUsd);
  }

  if (!handoff) {
    return {
      used: false,
      handoff: rawContext,
      costUsd,
      originalChars: rawContext.length,
      compressedChars: rawContext.length,
    };
  }

  session.setSummary(handoff);
  session.compactTurns(4);
  await session.save();
  return {
    used: true,
    handoff,
    costUsd,
    originalChars: rawContext.length,
    compressedChars: handoff.length,
  };
}

export function uncompressedContext(
  session: SessionStore,
  currentPrompt: string,
): string {
  const sections: string[] = [];
  if (session.data.summary) {
    sections.push(`PREVIOUS COMPRESSED HANDOFF:\n${session.data.summary}`);
  }
  const transcript = session.transcript();
  if (transcript) {
    sections.push(`CONVERSATION TRANSCRIPT:\n${transcript}`);
  }
  sections.push(`CURRENT USER REQUEST:\n${currentPrompt}`);
  return sections.join("\n\n");
}
