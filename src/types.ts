import type { RouteIdentityV1 } from "./backends.js";

/**
 * FIX-14 (consolidation wave, ticket 5): the ONE notice vocabulary.
 *
 * Fresh census of the shapes orcode used to say "here is an outcome" in:
 *
 *   settings-controller.ts  `SettingsNotice`  kind: success|error|info|busy
 *   ui/blocks.ts            notice block      level: info|warn|error
 *   setup-surface/index.ts  event             `busy: boolean` + `outcome: true`
 *   commands.ts             `CommandOutput`   text() vs error()
 *   tui.ts                  `setStatus`       `busy: boolean`
 *
 * Three explicit shapes and five vocabularies, none of which agreed: the
 * settings slot could say "success" but not "warn", the transcript block
 * could say "warn" but not "success", and the setup surface encoded both a
 * severity and a settled/in-progress axis in two booleans. A reader moving
 * one keystroke between those surfaces met three different ideas of what an
 * outcome IS.
 *
 * One vocabulary, declared here because it is the only module all three
 * shapes can reach without importing each other. `busy` is a real member,
 * not a fourth boolean: "still working" is a notice state a surface renders
 * in the same slot as the settled ones (that is precisely why
 * `SettingsNotice` grew it), and keeping it out forced every consumer to
 * carry a parallel flag.
 */
export const NOTICE_KINDS = ["success", "info", "warn", "error", "busy"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The ONE notice shape (FIX-14 ticket 5). A settled or in-progress outcome, and what it says. */
export interface Notice {
  readonly kind: NoticeKind;
  readonly message: string;
}

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

/** Whether a displayed USD amount is complete or provider-managed/unknown. */
export type CostKnowledge = "known" | "unknown";

/** Whether OpenRouter may select a backup provider for the chosen model. */
export type ProviderFallbackPolicy = boolean;

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
  /** Documented stable OpenRouter account identity; never persist or log raw. */
  creatorUserId?: string | null;
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
  /** Missing in legacy sessions means known. */
  costKnowledge?: CostKnowledge;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /**
   * Phase 13: a stable identity for this turn, independent of its position
   * in `turns` (which shifts under `MAX_TURNS` truncation and compaction)
   * and independent of `(createdAt, role, content)` alone (the merge-dedupe
   * key `turnKey` already uses in session.ts, which could theoretically
   * collide within the same millisecond). `SessionData.pinnedTurns`
   * references turns by this id. Optional at the type level — like
   * `route`/`reasoning`/`crossMode` above — so existing typed fixtures and
   * call sites that build a `ChatTurn` directly (outside `SessionStore`)
   * keep compiling; `SessionStore.addTurn` always assigns one for a new
   * turn, and `normalizeTurns` (session.ts) backfills one for any turn
   * loaded without it, so every turn reachable through the store's own API
   * carries one in practice. A turn with no id simply cannot be pinned.
   */
  id?: string;
}

/**
 * The exact pair Cross was armed with for one chat (Phase 10). Shaped like
 * `CrossPreferencesV1` (collaboration.ts) but non-null in both roles — arming
 * only ever happens once the gate's own `canStart` check already required a
 * complete, distinct pair. Defined here rather than imported from
 * collaboration.ts to avoid a cycle (collaboration.ts already imports
 * `CostKnowledge` from this module).
 */
export interface CrossModeV1 {
  readonly lead: RouteIdentityV1;
  readonly challenger: RouteIdentityV1;
  /**
   * Fix round 1 (owner direction): true when this arm is a PENDING one-shot
   * — Start chosen on an empty chat with no history yet, waiting for the
   * first message to run it exactly once through the pair, then disarming
   * automatically (`SessionStore.clearCrossModeOneShotIfPending`) once that
   * run reaches any terminal phase. Absent (not merely `false`) for
   * ordinary persistent "Keep Cross active" mode, which never auto-disarms
   * this way.
   */
  readonly oneShot?: true;
}

/**
 * P10b: the lead's own sidecar identity, queryable from the main chat once a
 * Cross run has published (see `SessionData.lastCrossRun`). `sidecarId` is
 * the `<uuid>-lead` directory name `cli.ts`'s Cross worker adapter creates
 * under `<appHome>/cross-sidecars/`; `chatId` is that sidecar session's own
 * chat id. Together with the reading process's live `appHome`, this is
 * exactly the `(appHome, chatId)` pair `findLastCompletedRun`/
 * `undoInterruptedRun` already accept for any chat — no Cross-specific
 * revert logic was needed, only this breadcrumb (Phase-11 report §5).
 */
export interface LastCrossRunV1 {
  /** ISO timestamp — mirrors `SessionData.lastCrossRunAt` at the moment this was recorded. */
  readonly at: string;
  readonly sidecarId: string;
  readonly chatId: string;
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
  route?: RouteIdentityV1;
  reasoning?: ReasoningSetting;
  /**
   * Persistent Cross mode (Phase 10): set only by the Cross start gate's
   * "Keep Cross active for this chat" choice, cleared by `/cross off` or by
   * switching the main route onto Kimi Code while armed. Chat-scoped like
   * `route`/`reasoning` above, but — unlike them — deliberately never copied
   * by `SessionStore.fork()` or a new chat (YOLO rule): a fork or a new chat
   * always starts disarmed, requiring its own explicit confirmation.
   */
  crossMode?: CrossModeV1;
  /**
   * ISO timestamp of the most recent Cross run published into this chat.
   * `/undo`'s Cross guard compares it against the candidate run's id (which
   * begins with the same, sortably-normalized timestamp) to refuse honestly
   * when the chat's newest run was a Cross run and no lead identity is
   * recorded for it (see `lastCrossRun` below) — Cross runs live in sidecar
   * journals a bare stamp cannot itself locate. Like `crossMode`, never
   * copied by `fork()` (a fork's runs directory starts empty, so a carried
   * timestamp would make the guard claim Cross runs that never happened
   * there).
   */
  lastCrossRunAt?: string;
  /**
   * P10b (Phase-11 ruling 6 completion): WHERE the most recent Cross run's
   * LEAD sidecar lives, recorded alongside `lastCrossRunAt` by the same
   * publication call so the two can never drift apart in normal operation —
   * `/undo`'s Cross branch runs the existing, unmodified discovery/revert
   * machinery (`findLastCompletedRun`/`undoInterruptedRun`/
   * `formatUndoConfirmation`) against `(appHome/cross-sidecars/sidecarId,
   * chatId)` instead of refusing blindly. `sidecarId` is the directory name
   * under THIS chat's own `<appHome>/cross-sidecars/` — relative, not an
   * absolute path, so a stale baked-in path never survives an appHome
   * migration/override that moves the chat itself; it always resolves
   * against whatever `SessionStore.appHome` the reading process has live.
   * Only the LEAD's identity is ever recorded — the Challenger never writes,
   * so there is nothing of its to revert. Set to `undefined` (never a stale
   * leftover) on any publish where no lead sidecar was created this
   * dispatch, so a newer `lastCrossRunAt` can never point at an older run's
   * identity. Like `crossMode`/`lastCrossRunAt`, never copied by `fork()`.
   */
  lastCrossRun?: LastCrossRunV1;
  /**
   * Phase 13 (/context): ids (`ChatTurn.id`) of turns the user pinned as
   * never-compress. The compressor's adoption gate (compressor.ts) excludes
   * a pinned turn's chars from what counts as "saved" and `SessionStore
   * .compactTurns` always retains a pinned turn verbatim regardless of
   * recency; neither ever removes an id from this list on its own — only
   * `/context unpin <n>` (or `/context pin <n>` to add one) does. Inherited
   * by `fork()` like `route`/`reasoning` (Ruling 3): a pin is a content
   * decision about the turns being copied, not a per-chat mode like
   * `crossMode` (deliberately NOT copied by fork).
   */
  pinnedTurns?: string[];
  /**
   * D9 (`/goal <text>`): a persistent, user-set standing instruction for this
   * chat, injected into every run's context — see `standingGoalInstruction`
   * (agent.ts), the one place that renders it, reused verbatim by both an
   * ordinary run and the Cross context packet's `projectInstructions` field
   * (cli.ts's `createCrossRuntimeForContext`). Fail-closed normalization on
   * load and merge (`normalizeGoal`, session.ts) mirrors `pinnedTurns`/
   * `crossMode` above: a non-string, blank, or over-`MAX_GOAL_CHARS` value
   * from a corrupt or hand-edited file normalizes to "no goal" rather than
   * throwing. The interactive setter (`SessionStore.setGoal`) is stricter —
   * it REFUSES an over-limit value with an honest error naming the limit
   * instead of silently truncating it. Inherited by `fork()` like
   * `pinnedTurns`/`route`/`reasoning` (Ruling 3): a goal is a content
   * decision about the chat being copied, not a per-chat mode like
   * `crossMode` (deliberately NOT copied by fork).
   */
  goal?: string;
  /**
   * ISO timestamp of the most recent `setSummary` call — when the current
   * `summary` handoff was folded. Present iff `summary` is non-empty (kept
   * in lockstep by `SessionStore.setSummary`); a session whose summary
   * predates this field (or was hand-built without it) simply omits it, and
   * `/context` shows an honest "unknown time" rather than a fabricated one.
   */
  summaryUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  workspace: string;
  turnCount: number;
  costUsd: number;
  /** Missing in legacy summaries means known. */
  costKnowledge?: CostKnowledge;
  model?: string;
  route?: RouteIdentityV1;
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
/**
 * `network-fetch` is an outbound request to an address the user does not
 * control (`browser_check` on anything but localhost/`file://` inside the
 * workspace). The danger is not local damage — it is that the fetched page's
 * content, scripts and redirects are outside anyone's control and, for the
 * agent tool, flow straight into the model's context (prompt injection,
 * tracking, exfiltration via query strings). Same treatment as
 * `remote-shell`: always asks, in every mode, and only `allow-all` skips it.
 */
export type ToolRisk =
  | "read"
  | "secret-read"
  | "edit"
  | "shell"
  | "remote-shell"
  | "network-fetch";

/** Stable effect classes shared by present and future capability subjects. */
export type ApprovalEffect =
  | "read"
  | "write"
  | "process"
  | "network"
  | "remote"
  | "git-history";

/**
 * Serializable authority identity for a remembered approval.
 *
 * Each variant carries only the data that changes what can happen. Values of
 * forwarded environment variables are deliberately absent from structured
 * processes; only their sorted, deduplicated names are persisted.
 */
export type ApprovalSubject =
  | { kind: "selected-path"; path: string }
  | { kind: "selected-path-glob"; base: string; pattern: string }
  | {
      kind: "shell-string";
      platform: string;
      executable: string;
      mode: string[];
      cwd: string;
      command: string;
    }
  | {
      kind: "structured-process";
      executable: string;
      argv: string[];
      cwd: string;
      environment: string[];
    }
  | { kind: "ssh-command"; host: string; command: string }
  | { kind: "url-operation"; origin: string; operation: string }
  | { kind: "mcp-tool"; server: string; tool: string; effect: ApprovalEffect }
  | { kind: "git-mutation"; repository: string; mutation: string };

export interface ToolCallPreview {
  name: string;
  risk: ToolRisk;
  summary: string;
  details?: string;
  /** Canonical, terminal-safe serialization of the policy subject. */
  subject?: string;
  /** True only when the exact subject is safe and the capability permits stored rules. */
  rememberAvailable?: boolean;
}

/** One concrete child-process execution. The UUID is stable for its complete lifecycle. */
export interface ProcessOperation {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Local immutable identity of the actual tool execution, when one owns this process. */
  invocationId?: string;
}

/** Terminal process data emitted exactly once, independently of a tool's final result. */
export interface ProcessCompletion {
  exitCode: number | null;
  /** Child termination signal when the OS ended it without an ordinary exit. */
  signal?: NodeJS.Signals;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Bounded terminal aggregate; the canonical ProcessResult stays unchanged. */
  stdout?: string;
  /** Bounded terminal aggregate; the canonical ProcessResult stays unchanged. */
  stderr?: string;
  error?: string;
}

/** Volatile observer boundary shared by tools, hardened Git, SSH, and verification. */
export interface ProcessCallbacks {
  onProcessStart?: (operation: ProcessOperation) => void;
  onProcessChunk?: (
    operation: ProcessOperation,
    stream: "stdout" | "stderr",
    text: string,
  ) => void;
  onProcessEnd?: (operation: ProcessOperation, completion: ProcessCompletion) => void;
}

export type AgentRunEvent =
  | {
      type: "run-start";
      model: string;
      maxSteps: number;
      /** Missing in legacy/OpenRouter run logs means known. */
      costKnowledge?: CostKnowledge;
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
      /** Missing in legacy run logs means known. */
      costKnowledge?: CostKnowledge;
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
       * A mid-run interjection actually delivered into the model (Phase 3b,
       * Part B) — recorded so a crash mid-run (`src/resume.ts`) can account
       * for it, exactly like the "text" event exists for the answer.
       */
      type: "interjection";
      text: string;
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
      /** Collision-free local identity created at the actual tool execute boundary. */
      invocationId?: string;
      number: number;
      name: string;
      input: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "tool-end";
      id: string;
      invocationId?: string;
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
      invocationId?: string;
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
      invocationId?: string;
      number: number;
      stream: "stdout" | "stderr";
      text: string;
      timestamp: number;
    }
  | {
      /**
       * FIX-3: one applied workspace edit, emitted by the two journal-recording
       * tools (`write_file`, `replace_text`) the moment the write is on disk —
       * so the owner sees WHAT changed in every approval mode, not only the
       * `✓ 3 replacement(s)` result line. Carried as the unified-diff text
       * `workspace.ts`'s single differ already produces (`diffText().text`), so
       * this stays one diff mechanism end to end: the renderer feeds it through
       * the same `parseUnifiedDiff` that `/diff` uses.
       */
      type: "file-change";
      /** Workspace-relative display path, exactly as the tool result reports it. */
      path: string;
      /** The tool that wrote it — `write_file` or `replace_text`. */
      tool: string;
      /** True when the file did not exist before this write. */
      created: boolean;
      /** Complete counts for the whole file, never only the shown hunks. */
      added: number;
      removed: number;
      /** Unified diff, already capped by `diffText`'s changed-line budget. */
      diff: string;
      /** True when `diff` left changed lines out. */
      truncated: boolean;
      timestamp: number;
    }
  | {
      type: "process-start";
      id: string;
      invocationId?: string;
      name: string;
      input: Record<string, unknown>;
      toolId?: string;
      toolNumber?: number;
      timestamp: number;
    }
  | {
      type: "process-output";
      id: string;
      invocationId?: string;
      name: string;
      stream: "stdout" | "stderr";
      text: string;
      toolId?: string;
      toolNumber?: number;
      timestamp: number;
    }
  | ({
      type: "process-end";
      id: string;
      invocationId?: string;
      name: string;
      input: Record<string, unknown>;
      toolId?: string;
      toolNumber?: number;
      timestamp: number;
    } & ProcessCompletion)
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
    }
  | {
      /**
       * Phase 11: appended (never rewritten in place — the log stays
       * append-only) after a deliberate `/undo` has reverted this run's
       * tracked file changes, so a later `/undo` can honestly refuse with
       * "already undone" (one level only, no undo-the-undo) instead of
       * guessing from file state. Purely additive: a run log written before
       * this event existed simply never has one, which
       * `findLastCompletedRun`'s `undone` field treats as "not undone" —
       * fail-closed, never assumed true without this explicit record.
       */
      type: "run-undone";
      timestamp: number;
    };
