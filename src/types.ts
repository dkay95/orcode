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

export interface OrcodeConfig {
  mainModel: string;
  compressorModel: string;
  compressionMode: CompressionMode;
  compressionThresholdChars: number;
  approvalMode: ApprovalMode;
  maxSteps: number;
  maxCostUsd: number;
  compressorMaxCostUsd: number;
  reasoningByModel: Record<string, ReasoningSetting>;
  /** Model used by `/whisper` (`/voice`) to transcribe recorded audio. Must support `audio` input. */
  transcriptionModel: string;
  /** One-time consent: has the user confirmed that a recording is sent to OpenRouter? */
  voiceConsentGiven: boolean;
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
  voiceUsd: number;
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

/**
 * `secret-read` is a read whose *content* is the damage: the file would be sent
 * to the model (and, with an active compressor, to a second one) in plain text.
 * It is separate from `read` because plain reads never ask and secret reads
 * always do — even in read-only mode, where the call looks harmless.
 */
/**
 * `remote-shell` is a shell command on a host `WorkspaceGuard` cannot see:
 * there is no sandbox, no undo and no change journal out there, unlike a
 * local `shell`/`edit`. It therefore always asks — in every mode, including
 * `auto-edit` — and only `allow-all` waves it through; see `ApprovalManager`.
 */
export type ToolRisk = "read" | "secret-read" | "edit" | "shell" | "remote-shell";

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
      /**
       * The user's prompt for this run. Optional so older run logs (written
       * before this field existed) still deserialize; a resume flow that
       * cannot find it simply omits the "which task" line instead of
       * guessing.
       */
      prompt?: string;
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
      /**
       * Part of `inputTokens` that the provider served from its prompt cache.
       * `0` when the provider reports nothing — the run log must never guess.
       */
      cachedTokens: number;
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
      /**
       * A chunk of the final, visible answer (quick-reply markup already
       * stripped) — the same text `onText` streams to the UI, mirrored here
       * so the run log has a record of how much of the answer existed
       * before an interrupted run (crash, kill) never got to persist it
       * anywhere else.
       */
      type: "text";
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
      type: "tool-output";
      id: string;
      number: number;
      stream: "stdout" | "stderr";
      text: string;
      timestamp: number;
    }
  | {
      type: "verify";
      command: string;
      round: number;
      exitCode: number;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: "notice";
      level: "info" | "warn" | "error";
      code: string;
      message: string;
      hint?: string;
      actions?: Array<{ key: string; label: string }>;
      timestamp: number;
    }
  | {
      type: "run-end";
      /**
       * `step-limit` and `cost-limit` are successful runs that were stopped
       * early; the answer is complete, the model was not.
       */
      outcome:
        | "complete"
        | "step-limit"
        | "cost-limit"
        | "error"
        | "cancelled"
        | "unverified";
      durationMs: number;
      toolCount: number;
      timestamp: number;
    };
