import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPROVAL_MODES,
  COMPRESSION_MODES,
  REASONING_EFFORTS,
  type ApprovalMode,
  type CompressionMode,
  type ReasoningSetting,
  type RouterCodeConfig,
} from "./types.js";

export const APP_HOME = join(homedir(), ".routercode");
export const CONFIG_PATH = join(APP_HOME, "config.json");

export const DEFAULT_CONFIG: RouterCodeConfig = {
  mainModel: "openrouter/auto",
  compressorModel: "qwen/qwen3.5-flash-02-23",
  compressionMode: "auto",
  compressionThresholdChars: 18_000,
  approvalMode: "ask",
  maxSteps: 12,
  maxCostUsd: 1,
  compressorMaxCostUsd: 0.05,
  reasoningByModel: {},
};

export async function loadConfig(): Promise<RouterCodeConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<RouterCodeConfig>;
    return validateConfig({ ...DEFAULT_CONFIG, ...raw });
  } catch (error) {
    if (isMissing(error)) {
      return {
        ...DEFAULT_CONFIG,
        reasoningByModel: {},
      };
    }
    throw new Error(`Konfiguration konnte nicht gelesen werden: ${messageOf(error)}`);
  }
}

export async function saveConfig(config: RouterCodeConfig): Promise<void> {
  const validated = validateConfig(config);
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
}

export function validateConfig(value: RouterCodeConfig): RouterCodeConfig {
  const approvalMode = includes(APPROVAL_MODES, value.approvalMode)
    ? value.approvalMode
    : DEFAULT_CONFIG.approvalMode;
  const compressionMode = includes(COMPRESSION_MODES, value.compressionMode)
    ? value.compressionMode
    : DEFAULT_CONFIG.compressionMode;

  return {
    mainModel: nonEmpty(value.mainModel, DEFAULT_CONFIG.mainModel),
    compressorModel: nonEmpty(value.compressorModel, DEFAULT_CONFIG.compressorModel),
    compressionMode,
    compressionThresholdChars: boundedInteger(value.compressionThresholdChars, 2_000, 2_000_000, DEFAULT_CONFIG.compressionThresholdChars),
    approvalMode,
    maxSteps: boundedInteger(value.maxSteps, 1, 100, DEFAULT_CONFIG.maxSteps),
    maxCostUsd: boundedNumber(value.maxCostUsd, 0.001, 1_000, DEFAULT_CONFIG.maxCostUsd),
    compressorMaxCostUsd: boundedNumber(
      value.compressorMaxCostUsd,
      0.001,
      100,
      DEFAULT_CONFIG.compressorMaxCostUsd,
    ),
    reasoningByModel: validateReasoningByModel(value.reasoningByModel),
  };
}

export function isApprovalMode(value: string): value is ApprovalMode {
  return includes(APPROVAL_MODES, value);
}

export function isCompressionMode(value: string): value is CompressionMode {
  return includes(COMPRESSION_MODES, value);
}

function includes<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === "string" && values.includes(candidate as T);
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function validateReasoningByModel(
  value: unknown,
): Record<string, ReasoningSetting> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, ReasoningSetting> = {};
  for (const [modelId, candidate] of Object.entries(value).slice(0, 500)) {
    if (!modelId.trim() || !isRecord(candidate)) {
      continue;
    }
    if (candidate.mode === "auto") {
      result[modelId] = { mode: "auto" };
    } else if (
      candidate.mode === "effort" &&
      includes(REASONING_EFFORTS, candidate.effort)
    ) {
      result[modelId] = {
        mode: "effort",
        effort: candidate.effort,
      };
    } else if (
      candidate.mode === "budget" &&
      Number.isInteger(candidate.maxTokens) &&
      Number(candidate.maxTokens) >= 1 &&
      Number(candidate.maxTokens) <= 1_000_000
    ) {
      result[modelId] = {
        mode: "budget",
        maxTokens: Number(candidate.maxTokens),
      };
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
