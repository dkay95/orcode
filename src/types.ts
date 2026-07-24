export const APPROVAL_MODES = ["read-only", "ask", "auto-edit", "allow-all"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const COMPRESSION_MODES = ["off", "auto", "always"] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ReasoningSetting =
  | { mode: "auto" }
  | { mode: "effort"; effort: ReasoningEffort }
  | { mode: "budget"; maxTokens: number };

export interface RouterCodeConfig {
  mainModel: string;
  compressorModel: string;
  compressionMode: CompressionMode;
  compressionThresholdChars: number;
  approvalMode: ApprovalMode;
  maxSteps: number;
  maxCostUsd: number;
  compressorMaxCostUsd: number;
  reasoningByModel: Record<string, ReasoningSetting>;
}

export interface KeyInfo {
  label?: string;
  isFreeTier?: boolean;
  isManagementKey?: boolean;
  limit?: number | null;
  limitRemaining?: number | null;
  usage?: number;
  usageDaily?: number;
  usageWeekly?: number;
  usageMonthly?: number;
  expiresAt?: string | null;
}

export interface CreditInfo {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export interface BalanceInfo {
  key: KeyInfo;
  credits?: CreditInfo;
  creditsUnavailableReason?: string;
}

export interface ModelInfo {
  id: string;
  canonicalSlug?: string;
  name: string;
  description: string;
  createdAt?: number;
  contextLength: number;
  maxCompletionTokens?: number | null;
  promptPrice: number;
  completionPrice: number;
  supportedParameters: string[];
  modality?: string;
  inputModalities: string[];
  outputModalities: string[];
  tokenizer?: string;
  isModerated?: boolean;
  reasoning?: {
    defaultEffort?: ReasoningEffort | null;
    defaultEnabled?: boolean;
    mandatory: boolean;
    supportedEfforts: ReasoningEffort[] | null;
    supportsMaxTokens: boolean;
  };
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
}

export interface CostLedger {
  mainUsd: number;
  compressorUsd: number;
  totalUsd: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface SessionData {
  version: 2;
  id: string;
  title: string;
  workspace: string;
  summary: string;
  turns: ChatTurn[];
  costs: CostLedger;
  model?: string;
  reasoning?: ReasoningSetting;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  workspace: string;
  turnCount: number;
  costUsd: number;
  model?: string;
  reasoning?: ReasoningSetting;
  createdAt: string;
  updatedAt: string;
}

export type ToolRisk = "read" | "edit" | "shell";

export interface ToolCallPreview {
  name: string;
  risk: ToolRisk;
  summary: string;
  details?: string;
}

export type AgentRunEvent =
  | {
      type: "run-start";
      model: string;
      maxSteps: number;
      timestamp: number;
    }
  | {
      type: "model-start";
      model: string;
      step: number;
      timestamp: number;
    }
  | {
      type: "model-end";
      model: string;
      step: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      costUsd: number;
      timestamp: number;
    }
  | {
      type: "reasoning";
      model: string;
      step: number;
      delta: string;
      timestamp: number;
    }
  | {
      type: "tool-start";
      id: string;
      number: number;
      name: string;
      input: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "tool-end";
      id: string;
      number: number;
      name: string;
      input: Record<string, unknown>;
      output: unknown;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: "tool-error";
      id: string;
      number: number;
      name: string;
      input: Record<string, unknown>;
      error: string;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: "run-end";
      outcome: "complete" | "error" | "cancelled";
      durationMs: number;
      toolCount: number;
      timestamp: number;
    };
