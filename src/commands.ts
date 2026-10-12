// `input` is aliased: `resolveFolderInput` already binds a parameter called
// `input`, and a shadowed import reads far worse than an explicit name.
import { input as promptLine, password } from "@inquirer/prompts";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { themeForGlyphPreference } from "./branding.js";
import { pickFromListPlain, type PlainListChoice, type PlainListIo } from "./ui/list-plain.js";
import { withListSections, type ListSection } from "./ui/list-core.js";
import { abbreviateHome } from "./ui/workbench.js";
import { shortModelName } from "./ui/dashboard-frame.js";
import { span, type Line, type Span } from "./ui/spans.js";
import { titleBarLine } from "./ui/zones.js";
import {
  billingRealmLabel,
  compressionModeLabel,
  providerConnectivityFactLabel,
  providerCredentialFactLabel,
  providerHealthFailureFactLabel,
  providerSpendFactLabel,
  resolveSettingsCategory,
  type SettingsCategoryId,
} from "./settings-registry.js";
import {
  assertSpendAvailable,
  contextFillPercent,
  type OrcodeAgent,
} from "./agent.js";
import {
  COMMAND_CATALOG,
  COMMAND_TREE,
  CROSS_RUN_ACTIVE_COMMAND_NOTICE,
  commandAllowedDuringCrossRun,
  flattenCommandTree,
  resolveSlashCommand,
  retiredSlashCommand,
} from "./command-catalog.js";
import { SHORTCUTS, shortcutKeys, shortcutsByContext } from "./ui/keymap.js";
import {
  APPROVAL_MODES,
  COMPRESSION_MODES,
  REASONING_EFFORTS,
  type BalanceInfo,
  type ChatTurn,
  type CreditInfo,
  type AgentRunEvent,
  type LastCrossRunV1,
  type ModelInfo,
  type ProcessCallbacks,
  type ReasoningEffort,
  type ReasoningSetting,
  type OrcodeConfig,
} from "./types.js";
import {
  CONFIG_PATH,
  DATA_COLLECTIONS,
  PROVIDER_SORTS,
  VERIFY_MAX_ROUNDS,
  VERIFY_MODES,
  WEB_MODES,
  isApprovalMode,
  isBudgetAction,
  isCompressionMode,
  saveConfig,
  readConfigEditSnapshot,
  validateConfig,
  validatePanelModelSelection,
  validateProvider,
  validateVerify,
  type BudgetConfig,
  type DataCollectionPreference,
  type ProviderSortPreference,
  type OrcodeConfigWithBudget,
  type VerifyMode,
  type WebMode,
} from "./config.js";
import {
  approvalDescription,
  ApprovalManager,
  confirmPlain,
  type ConfirmPlainOptions,
  type ConfirmPlainRequest,
} from "./approval.js";
import { RuleStore } from "./rules.js";
import type { ProviderPreferenceCommitPort } from "./provider-activation.js";
import {
  createModelPreferenceRouteAuthorityBridge,
  runModelPreferenceTransaction,
  sameExactModelPreferenceRoute,
  type ModelPreferenceAuthoritySnapshot,
  type ModelPreferenceRouteAuthority,
} from "./model-preference-transaction.js";
import {
  sameCanonicalModelRoute,
  type ModelRoutePickerPort,
  type SelectableModelRoute,
} from "./model-route-catalog.js";
import { loadSshHosts } from "./ssh-config.js";
import { checkHost, closeSshControl, createSshSession, type RunSsh, type SshSession } from "./ssh.js";
import {
  CredentialStoreError,
  normalizeProviderSecret,
  type CredentialStoreLike,
} from "./credentials.js";
import {
  OpenRouterHttpError,
  OpenRouterService,
  PANEL_ESTIMATE_OUTPUT_TOKENS,
  createPanelCall,
  estimatePanelModelCostUsd,
  isCompressorModelCandidate,
  isMainModelCandidate,
  modelCapabilities,
  proposePanelModels,
  type BalanceReport,
  type KeyOrigin,
} from "./openrouter.js";
import {
  PANEL_MIN_MODELS,
  PanelAuthenticationRejectedError,
  askPanel,
  estimatePanelRun,
  synthesize,
  type PanelCall,
  type PanelJudgment,
  type PanelResult,
} from "./panel.js";
import { renderPanel } from "./ui/panel-view.js";
import type { SetupSurface } from "./setup-surface/index.js";
import {
  ANTHROPIC_DIRECT_BACKEND_ROLE,
  ProviderSetupRequiredError,
  type RouteIdentityV1,
} from "./backends.js";
import { KIMI_CODE_MODELS } from "./kimi-code.js";
import { displayWidth, fitSpans, renderLines } from "./ui/compose.js";
import { createTheme, type Theme } from "./ui/theme.js";
import {
  buildResumePrompt,
  driftLabel,
  findInterruptedRun,
  findLastCompletedRun,
  formatInterruptedRunNotice,
  formatUndoConfirmation,
  formatUndoOutcome,
  markRunReviewed,
  markRunUndone,
  summarizeRun,
  undoInterruptedRun,
} from "./resume.js";
import {
  chatTurnTranscriptText,
  listChatsAcrossWorkspaces,
  migratedOpenRouterSessionConnection,
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  rankChatMatches,
  SessionStore,
  workspaceSpend,
  type CrossWorkspaceChat,
  type SessionToolCall,
} from "./session.js";
import {
  ChangeJournal,
  getGitDiff,
  reRootWorkspace as reRootWorkspaceCore,
  runProcess,
  writeApprovalRequest,
  type WorkspaceGuard,
  type WorkspaceReRootResult,
} from "./workspace.js";
import {
  getReasoningSetting,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
// `verify.js` is already eager everywhere it matters (`cli.ts`, `agent.ts`,
// and `suggestVerifyCommands` right here), so `/verify now` used to defer
// nothing by importing `runVerify` dynamically — it only hid the real cost
// and cost an extra module resolution at command time (FIX-16/5).
import { runVerify, suggestVerifyCommands } from "./verify.js";
import {
  CHARS_PER_TOKEN,
  contextLengthLabel,
  errorMessage,
  estimateTokensFromChars,
  formatCatalogPricePerMillion,
  formatUsd,
  formatChatCost,
  formatChatRow,
  formatMessageCount,
  formatModelRouteDetail,
  hasCode,
  isLowBalance,
  isRecord,
  lookupTable,
  pluralize,
  relativeAge,
  truncate,
} from "./utils.js";
import { ProcessEventRedactor } from "./redaction.js";
import {
  assertNoPrivateProviderStateLeaves,
  type ProviderConnectionStateV3,
} from "./provider-state.js";
import type { CrossPreferencesV1, CrossRunResult, CrossRunSnapshot } from "./collaboration.js";
import {
  ARCHITECT_CONFIRM_TITLE,
  ARCHITECT_EMPTY_DRAFT_REFUSAL,
  ARCHITECT_EXECUTOR_UNSET_REFUSAL,
  architectCancelNotice,
  architectConfirmConsequence,
  architectEmptyExecutorSummary,
  architectResultBlock,
  type ArchitectExecutorPriceInput,
  type ArchitectExecuteResult,
  type ArchitectPlanResult,
} from "./architect.js";

/** Sink for command output — replaces the direct `console.log`/`console.error` calls. */
export interface CommandOutput {
  text(value: string): void;
  error(value: string, hint?: string): void;
}

export interface SettingsCommandPort {
  /**
   * FIX-15: `category` deep-links Settings straight to one page. It is the
   * same `SettingsCategoryId` `SettingsController.open` has always taken as
   * its `initialCategory`, plumbed through instead of a second navigation
   * path; `undefined` keeps the controller's own default.
   */
  open(category?: SettingsCategoryId): Promise<void>;
}

export interface CrossCommandPort {
  /**
   * Opens the one explicit Cross start gate (src/cross-gate.ts) with `draft`
   * pre-filled as the pending task. Every entry arm — bare `/cross`,
   * `/cross run [task]`, and `/cross models` — funnels in here.
   *
   * Phase 10: the gate is still the only way to *arm* persistent Cross mode,
   * and the only caller of `start` below for a chat's first (manually
   * confirmed) run — but once a chat is armed, every later plain message
   * calls `start` directly with the armed pair, bypassing the gate on
   * purpose (that is the whole point of arming: one confirmation instead of
   * a gate per message). See the dispatch seam in `runPlainLoop`/
   * `runDashboard` (cli.ts).
   */
  openGate(draft: string): Promise<void>;
  swapModels(): Promise<void>;
  /**
   * `pair` overrides `readPreferences()` for this one call only — used
   * exclusively by the Phase 10 armed-dispatch seam, which must run with the
   * exact pair a chat was armed with, not whatever the global Cross
   * preferences currently hold (those can drift from another chat/window
   * after arming). Omitted, this behaves exactly as before Phase 10.
   */
  start(task: string, pair?: CrossPreferencesV1): Promise<CrossRunResult>;
  status(): CrossRunSnapshot;
  stop(): Promise<CrossRunSnapshot>;
}

/**
 * Phase 14 (architect mode). Deliberately NOT `CrossCommandPort`-shaped —
 * ruling 1 keeps v1 one-shot with no gate/arming/status/stop machinery, and
 * ruling 3's chosen path (two sequential ordinary agent runs, not a
 * `CrossCoordinator`-style phase machine) needs only two run methods.
 * Neither method touches `context.session` — `architectCommand` below owns
 * cost booking and turn publication, exactly once, so the confirm-gated
 * cancel path (ruling 4: cancelling books only the planning cost) has a
 * single, auditable place it happens.
 */
export interface ArchitectCommandPort {
  /** The executor route configured in Settings, or `null` when never set. */
  executorRoute(): RouteIdentityV1 | null;
  /** Non-null when Architect cannot run in the current session (Kimi routes) — same reason-copy pattern as Cross's own `unavailableReason`. */
  unavailableReason(): string | null;
  /**
   * Fix round 1 (money honesty, the same H1 defect FIX-10 fixed for the
   * Cross gate): the number of chars the executor's context packet will
   * ACTUALLY carry — the exact same `input.context()` slice `plan`/`execute`
   * feed to `createContextPacketV1` (chat turn contents plus omission
   * markers), never a separate re-derivation that could disagree with it.
   * The D4 confirmation prices context + task + plan, never the plan alone:
   * in a long chat the packet dwarfs the plan text, and a plan-only estimate
   * understated the consent point by construction.
   *
   * FIX-14 ticket 4: REQUIRED, not optional. It used to default to 0 "for a
   * minimal test double" — a foot-gun, because the default silently
   * understates a money figure at a consent point, and the port a real
   * surface forgets to wire looks exactly like the port a test deliberately
   * left out. A double that has no packet must say so by returning 0
   * itself. `CrossGateDeps.chatContextChars` was tightened in the same pass.
   */
  chatContextChars(): number;
  /** Runs the planner (the main route, structurally read-only) against `task`. */
  plan(task: string): Promise<ArchitectPlanResult>;
  /** Runs the executor (the configured cheap route, normal approvals) against the accepted plan. */
  execute(task: string, plan: ArchitectPlanResult): Promise<ArchitectExecuteResult>;
}

export class SettingsInteractiveRequiredError extends Error {
  readonly code = "settings-interactive-required" as const;

  constructor() {
    super(
      "settings-interactive-required · /settings is only available in a local interactive owner terminal.",
    );
    this.name = "SettingsInteractiveRequiredError";
  }
}

export type ProviderCredentialIntent =
  | {
      kind: "replace";
      credentialKind: "inference" | "management";
      candidate: string;
      allowProcessOnly?: (kind: "inference" | "management", reason: string) => Promise<boolean>;
    }
  | { kind: "save"; credentialKind: "inference" | "management" }
  | {
      kind: "forget";
      credentialKind: "inference" | "management";
      targetConnectionId?: string;
      targetCredentialSlot?: string;
      authorize?: () => boolean;
      onAuthoritativeMismatch?: (state: unknown) => never;
      onForgotten?: () => void;
    };

export interface ProviderCredentialIntentPort {
  apply(intent: ProviderCredentialIntent): Promise<{
    kind: "ready" | "forgotten" | "unchanged";
    credentialKind: "inference" | "management";
    persisted?: boolean;
    removed?: boolean;
    retained?: boolean;
    reason?: "shared-reference";
    balance?: BalanceReport;
    credits?: CreditInfo;
  }>;
}

export interface ProviderRouteIntentPort {
  listSelectableModelRoutes?(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly SelectableModelRoute[]>;
  /** Authoritative runtime projection; an explicit undefined must not fall back to startup state. */
  migratedSessionConnection?(): ProviderConnectionStateV3 | undefined;
  runModelCatalog?<T>(
    run: () => Promise<T>,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<T>;
  /** Exact route currently bound to the model-facing runtime. */
  currentSessionRoute?(): RouteIdentityV1;
  /** Proves and stages an already persisted resolved session route. */
  selectSessionRoute?(
    route: RouteIdentityV1,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1>;
  /** Commits the staged route together with current-session ownership. */
  adoptSession?(session: SessionStore): void;
  /** Internal owner-only transaction seam; callers cannot forge its opaque port. */
  transitionSessionRoute?(
    route: RouteIdentityV1,
    publication: ProviderPreferenceCommitPort,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1>;
  readModelPreferenceAuthority?(): ModelPreferenceAuthoritySnapshot;
  prepareSettingsModelPublication?(route: RouteIdentityV1): { publish(): void };
  transitionModel(
    modelId: string,
    canonicalModelId?: string,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<void>;
}

export type ProviderCommandBackendId = "openrouter" | "kimi-code" | "anthropic";

/** Backends the pure command domain can address with account mutations today. */
export type ProviderCommandConnectableBackendId = "openrouter" | "kimi-code";

export type ProviderCommandIntent =
  | { kind: "setup" }
  | { kind: "status" }
  | {
      kind: "connect" | "enable" | "disable" | "disconnect" | "reconnect" | "models" | "logout";
      backendId: ProviderCommandBackendId;
      confirmationToken?: string;
    };

export interface ProviderCommandStatusEntry {
  backendId: ProviderCommandBackendId;
  displayName: string;
  availability: "connectable" | "coming-soon";
  /**
   * FIX-10 fix round 1 (F1): a tri-state, not a boolean — "disabled" is a
   * definite claim that a stored connection exists and the user turned it
   * off; a backend with NO stored connection at all is "not-connected".
   * Conflating the two made /provider status call a fresh install's
   * providers "disabled" (a stored-state claim contradicted by the ✗ "Not
   * connected" fact right under it). Never persisted — computed per status
   * call (`#providerStatus`, cli.ts).
   */
  configuration: "enabled" | "disabled" | "not-connected";
  maturity: "stable" | "preview" | "coming-soon";
  billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage" | "none";
  accountFingerprintSuffix: string | null;
  headline: string | null;
  health: {
    credential: string;
    connectivity: string;
    spend: string;
    runtime: string;
  } | null;
  isDefault: boolean;
  selectedModel?: {
    requestedModelId: string;
    canonicalModelId: string;
    displayName: string;
  } | null;
}

export type ProviderCommandResult =
  | {
      kind: "provider-coming-soon";
      backendId: "anthropic";
      displayName: string;
      explanation: string;
    }
  | {
      kind: "setup";
      backendId: ProviderCommandConnectableBackendId;
      outcome: "ready" | "cancelled";
    }
  | { kind: "status"; providers: readonly ProviderCommandStatusEntry[]; crossEnabled: false }
  | {
      kind: "models";
      backendId: ProviderCommandConnectableBackendId;
      models: readonly {
        requestedModelId: string;
        canonicalModelId: string;
        displayName: string;
      }[];
    }
  | {
      kind: "reconnected";
      backendId: ProviderCommandConnectableBackendId;
      headline: string;
      generation: number;
    }
  | {
      kind: "confirmation-required";
      operation: "disable" | "disconnect" | "logout";
      backendId: ProviderCommandConnectableBackendId;
      message: string;
      confirmationToken: string;
    }
  | {
      kind: "changed";
      operation: "disable" | "disconnect" | "logout";
      backendId: ProviderCommandConnectableBackendId;
      setupRequired: boolean;
      defaultCleared: boolean;
    }
  | { kind: "unchanged"; backendId: ProviderCommandConnectableBackendId; reason: string };

export interface ProviderCommandIntentPort {
  execute(
    intent: ProviderCommandIntent,
    surface: SetupSurface | "plain" | "fullscreen",
  ): Promise<ProviderCommandResult>;
}

export interface CommandLocalRuntime {
  guard: WorkspaceGuard;
  journal: ChangeJournal;
  setSession(session: SessionStore): void;
  resetConversationMemory(): void;
}

/**
 * What the credential-secret seam is allowed to answer: whether a key was
 * entered and consumed, or the entry was cancelled. Deliberately not a
 * `string` — see `CommandContext.withCredentialSecret`.
 */
export type CredentialSecretEntry = "used" | "cancelled";

export interface CommandContext<Agent extends OrcodeAgent | null = OrcodeAgent> {
  config: OrcodeConfigWithBudget;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: Agent;
  /**
   * Phase 13 fix round 1: the exact chat id and ordered turn-id snapshot the
   * most recently printed `/context` view showed, so `/context pin
   * <n>`/`unpin <n>` can verify row `<n>` still names the same turn instead
   * of re-indexing whatever `session.data.turns` happens to hold *right
   * now* — which can differ from the view an automatic compression cycle,
   * a new message, or a chat switch may have run in between. Set by
   * `printContext`, read (never written) by `resolveCachedContextRow`.
   * In-memory only, on the same long-lived `CommandContext` the REPL loop
   * already reuses across commands — never persisted, never read by
   * anything outside commands.ts's own `/context` handling.
   */
  contextViewCache?: { chatId: string; turnIds: readonly (string | undefined)[] };
  /** Atomically transfers provider, session, agent, and local-runtime ownership. */
  commitSessionHandoff?(session: SessionStore): void;
  /**
   * The one shared workspace re-root (Phase F1b): a foreign `/chats` pick and
   * `/folder open|new` both call exactly this, never a second implementation.
   * Moves the workspace guard/policy root and repoints the (appHome-wide,
   * already workspace-filtered) `RuleStore` at the new path, forces the
   * cached agent to rebuild against it, and refuses outright — never a
   * partial switch — while a Cross run is active or the target folder is
   * missing/not a directory. Never touches `session`/`agent` identity itself;
   * callers open/adopt the actual chat afterward. Absent surfaces (a
   * lightweight test `CommandContext` that never wired the full runtime) fall
   * back to a best-effort in-place mutation, see `reRootCommandWorkspace`.
   */
  reRootWorkspace?(newWorkspace: string): Promise<WorkspaceReRootResult>;
  /**
   * FIX-14 ticket 6: the ONE confirmation seam between a command and the
   * surface it is running on.
   *
   * The census found two core mechanisms — `confirmPlain` (approval.ts, the
   * plain/Inquirer primitive D4 already unified) and `TerminalUi.confirmAction`
   * (the fullscreen modal) — which is right, because those are genuinely
   * different surfaces. What was not right was the SEVEN differently-shaped
   * ports between them (`confirmFolderCreate(path)`,
   * `confirmChatDeletion(title, details)`, `confirmCredentialForget(kind,
   * details)`, `confirmProviderMutation(operation, backendId, details)`,
   * `confirmProcessOnlyCredential(kind, reason)`, `confirmUndo(title,
   * details)`, plus the test-only `confirmClearSession()`,
   * `confirmPanelAsk(title)` and `confirmArchitectExecute(consequence)` that
   * production never wired at all). Each existed for one reason: its
   * fullscreen adapter in cli.ts built the QUESTION, so the port's shape
   * encoded which question. That split five confirmations' copy across two
   * files, and five of them had genuinely different wording on the two
   * surfaces — `/folder new` asked "Create folder <path>?" in plain mode and
   * "Create this folder?" with the path underneath in fullscreen; `/key
   * forget` put a whole sentence in the title in one and a short question in
   * the other.
   *
   * There is one port now, taking the same `{title, consequence}` request and
   * the same `{danger, defaultAccept}` grading `confirmPlain` already
   * defines, so the copy lives with the command and both surfaces render the
   * same question with the same D4 class. Every call site goes through
   * `confirmInContext` below; unset (the plain loop, most tests) falls back
   * to `confirmPlain` exactly as each individual port did.
   */
  confirm?: (
    request: ConfirmPlainRequest,
    options?: ConfirmPlainOptions,
  ) => Promise<boolean>;
  /**
   * FIX-8: bare `/folder`'s one path question. The fullscreen UI injects the
   * existing `validated-input` modal (`ui.readPath`); the plain loop falls
   * back to Inquirer's `input()`, guarded by a TTY check since there is no
   * one to ask non-interactively. `null` means the owner cancelled (Esc,
   * Ctrl+C, or an empty answer) — never a value, so a cancel can never be
   * mistaken for a path.
   */
  promptFolderPath?: (request: {
    readonly label: string;
    readonly description: string;
  }) => Promise<string | null>;
  localRuntime?: CommandLocalRuntime;
  providerCredentials?: ProviderCredentialIntentPort;
  /** Shared provider runtime seam for route-changing model/session commands. */
  providerRoutes?: ProviderRouteIntentPort;
  /** Fullscreen owner picker; when present `/model` must never open Inquirer. */
  modelRoutePicker?: ModelRoutePickerPort;
  /** One shared provider-command controller owned by the provider runtime. */
  providerCommands?: ProviderCommandIntentPort;
  /** Installed only by a local interactive owner surface. */
  settings?: SettingsCommandPort;
  /** One shared on-demand Cross runtime; absent surfaces fail explicitly. */
  cross?: CrossCommandPort;
  /** Busy gate: while true only `/cross status` and `/cross stop` are accepted. */
  crossRunActive?: () => boolean;
  /**
   * Optional owner-surface draft projection, consumed once when opening the
   * Cross gate or starting bare `/architect`. `restore` is the same seam
   * Cross's cancelled gate already reaches through `CrossRuntimeSurface`
   * (`ui.restoreCrossCommandDraft`, cli.ts) — a refusal hands the owner's
   * text back to the composer instead of silently eating it. Absent on
   * surfaces with no composer to restore into (the plain loop).
   *
   * FIX-14 ticket 11: named `crossDraft` until now, which was true only of
   * its first consumer. `/architect` reads the same slot, and any future
   * command that opens a gate over a typed draft will too — the thing it
   * projects is the COMPOSER's draft, not Cross's. Purely mechanical
   * rename; the shape and every behaviour are unchanged.
   */
  composerDraft?: { read(): string; restore?(): void };
  /** One shared on-demand Architect runtime (Phase 14); absent surfaces fail explicitly. */
  architect?: ArchitectCommandPort;
  providerRouteSurface?: SetupSurface | "plain" | "fullscreen";
  workspace: string;
  credentials: CredentialStoreLike;
  out: CommandOutput;
  ruleStore: RuleStore;
  /**
   * Where `/model`, `/approval`, `/budget`, `/verify`, `/web`, `/provider`,
   * `/fallback`, … persist `config`. Defaults to the real
   * `~/.orcode/config.json` (`saveConfig`'s own default) when unset —
   * tests MUST set this to a tmp path, or every config-mutating command in
   * this file writes straight into the real user config.
   */
  configPath?: string;
  /**
   * `/ssh`'s remembered target: which host alias `ssh_command` should be
   * used against. Optional so existing fixtures/tests that never touch SSH
   * stay valid; `sshCommand` below creates one on first use if it is unset.
   */
  sshSession?: SshSession;
  /**
   * Test-only seam for `/ssh`, mirroring `configPath` above: unset means the
   * real `~/.ssh/config`. Tests MUST set this to a tmp path — `/ssh` must
   * never read the real file.
   */
  sshConfigPath?: string;
  /**
   * Test-only seam for `/ssh`: unset means the real `ssh` binary via
   * `runProcess`. Tests MUST set this instead of ever spawning a real `ssh`.
   */
  sshRunner?: RunSsh;
  /**
   * Test-only seam for `/ssh`: where the `ControlMaster` socket directory
   * lives. Unset means the real `~/.orcode/ssh` (`checkHost`'s/
   * `closeSshControl`'s own default) — tests MUST set this to a tmp path,
   * since `checkHost` creates this directory as a side effect even with a
   * fake `sshRunner`.
   */
  sshAppHome?: string;
  /**
   * Test-only seam for the bare `/chats` picker (Fix round 1, IMPORTANT 3):
   * unset means `pickFromListPlain`'s own default (the real
   * `process.stdin`/`process.stdout`). Tests inject a fake TTY-shaped
   * `PlainListIo` here to drive the sectioned picker — including a foreign,
   * cross-workspace pick — end to end without ever touching the real
   * terminal.
   */
  chatPickerIo?: PlainListIo;
  /**
   * `/panel`'s last result in this session, so `/panel show <n>` can expand
   * one answer without re-running the (paid) panel call. Optional — a
   * session that never ran `/panel` simply never sets it.
   */
  lastPanelResult?: PanelResult;
  /** The judge's synthesis for `lastPanelResult`, if `/panel judge` was on for that run. `null` when it ran but produced nothing usable. */
  lastPanelJudgment?: PanelJudgment | null;
  /**
   * Injectable `PanelCall` for `/panel` — defaults to the real
   * `createPanelCall(context.openRouter)`. Tests MUST override this; it is
   * the only seam between `/panel` and an actual network call.
   */
  panelCall?: PanelCall;
  /**
   * Hook back to the active input surface: seeds the *next* message the user
   * sends without sending anything automatically — visible and editable in
   * the fullscreen TUI (wired to `ui.insertInputText`), prepended silently in
   * the plain loop (wired to its own pending-seed variable), exactly like
   * cli.ts's interrupted-run "Fortsetzen" choice already does at startup.
   * `/recover continue` and `/panel use <n>` both go through this one seam.
   * Unset in `-p`/`--json` and in every test that does not exercise either.
   */
  seedNextMessage?: (text: string) => void;
  /**
   * When set, `/panel`'s result is handed to this callback instead of being
   * rendered as plain lines via `out.text` — the fullscreen TUI uses this to
   * push a proper `"panel"` block onto the chat stream (see `src/ui/blocks.ts`)
   * instead of flattening the result into a generic notice block. Unset in
   * the plain loop and in every test that does not exercise it, where the
   * existing text rendering is preserved exactly.
   */
  onPanelResult?: (
    result: PanelResult,
    judgment: PanelJudgment | null,
    expandedIndex: number | null,
  ) => void;
  /**
   * Secret-input seam shared by plain Inquirer and the fullscreen modal.
   *
   * The flow is inverted on purpose: the surface captures the key and hands
   * it to `use`, and the seam answers with the entry verdict alone. A raw
   * provider key is therefore never a return value, so it cannot spread into
   * arbitrary call sites — and a surface that is not in this process (a
   * GUI's WebView) has nothing to send back over its bridge. The key still
   * exists inside `use`, which is where it is validated and stored; what
   * this shape removes is every OTHER place it could have travelled to.
   */
  withCredentialSecret?: (
    kind: "inference" | "management",
    use: (secret: string) => Promise<void>,
  ) => Promise<CredentialSecretEntry>;
  /** Active surface event sink; the dashboard uses it for direct `/diff` live output. */
  onRunEvent?: (event: AgentRunEvent) => void;
  /**
   * D6 (the cost thread): reads the dashboard's already-cached `BalanceInfo`
   * (`runDashboard`'s own `refreshDashboardBalance`-populated closure) — the
   * one seam `/provider status` uses to show a real `Balance $X.XX` figure
   * without ever triggering a new fetch of its own. `null`/unset both mean
   * "no cached balance" (never fetched, the fetch failed, or this surface
   * has no such cache at all — the plain loop never populates one today) —
   * `/provider status` then omits the segment, the same honesty rule the
   * welcome box's own Balance row already follows for the identical reason.
   */
  readCachedBalance?: () => BalanceInfo | null;
}

export type NullableCommandContext = CommandContext<OrcodeAgent | null>;

function commandLocalRuntime(
  context: NullableCommandContext,
): Pick<CommandLocalRuntime, "guard" | "journal"> {
  if (context.agent) return context.agent;
  if (context.localRuntime) return context.localRuntime;
  throw new Error("Local session functions are not available.");
}

function updateCommandSession(context: NullableCommandContext, next: SessionStore): void {
  context.agent?.setSession(next);
  context.localRuntime?.setSession(next);
}

function commitCommandSessionHandoff(
  context: NullableCommandContext,
  next: SessionStore,
): void {
  if (context.commitSessionHandoff) {
    context.commitSessionHandoff(next);
    return;
  }
  context.providerRoutes?.adoptSession?.(next);
  context.session = next;
  updateCommandSession(context, next);
}

function resetCommandConversation(context: NullableCommandContext): void {
  context.agent?.resetConversationMemory();
  context.localRuntime?.resetConversationMemory();
}

/**
 * The one shared workspace re-root (Phase F1b), reached via
 * `context.reRootWorkspace` when the full runtime wired it (every real
 * `orcode` process — `runCli`, `src/cli.ts`); a foreign `/chats` pick and
 * `/folder open|new` both call this same helper, never two implementations.
 *
 * The fallback below (no `reRootWorkspace` hook) covers a lightweight test
 * `CommandContext` that never wired the full runtime: it delegates to the
 * exact same `reRootWorkspace` core (`workspace.ts`) that `runCli` itself
 * wires — refuses a missing/non-directory target or an active Cross run,
 * moves `context.workspace`/`localRuntime.guard`/the approvals' rule-store
 * pointer in place — but it cannot force a cached agent to rebuild (there is
 * no outer `workspace` closure or `ensureAgentForPrompt` to reach from
 * here), so it is not a substitute for the real one in production.
 */
async function reRootCommandWorkspace(
  context: NullableCommandContext,
  newWorkspace: string,
): Promise<WorkspaceReRootResult> {
  if (context.reRootWorkspace) return context.reRootWorkspace(newWorkspace);
  const outcome = await reRootWorkspaceCore(
    {
      setWorkspace: (value) => { context.workspace = value; },
      setGuard: (guard) => {
        if (context.localRuntime) context.localRuntime.guard = guard;
      },
      approvals: context.approvals,
      ruleStore: context.ruleStore,
      crossRunActive: context.crossRunActive,
    },
    newWorkspace,
  );
  // Fix round 1, MINOR 9 (hardening): `context.agent.guard` is readonly —
  // this fallback has no `ensureAgentForPrompt` to force a rebuild the way
  // the fully-wired `reRootWorkspace` does, so the only safe move on success
  // is to drop the cached agent outright. Otherwise a future caller that
  // wires `agent` but never wires `reRootWorkspace` itself would silently
  // keep running tools against the old workspace's guard.
  if (outcome.ok) context.agent = null;
  return outcome;
}

/** Every command that persists `context.config` goes through this, never a bare `saveConfig(context.config)` — see `CommandContext.configPath`. */
function saveContextConfig(context: CommandContext): Promise<void> {
  return saveConfig(context.config, context.configPath);
}

/**
 * V3 audit principle 3 (F5): the one place this file resolves a `Theme`. Every
 * plain-output print site in this module goes through `commandTheme` (when a
 * `CommandContext` is in scope) instead of constructing its own `createTheme()`
 * — one seam, not dozens of ad hoc constructions.
 *
 * Also closes the F4 review's ascii gap for the one call site here that
 * actually renders glyphs (`printPanelResult`'s `renderPanel`): `config` is
 * reachable through `context`, so the configured glyph mode is resolved the
 * same way `tui.ts` resolves it, instead of always defaulting to Unicode.
 * Every other call site in this file only ever uses `theme.color()`, which
 * `ascii` does not affect — but resolving it uniformly here costs nothing and
 * keeps the seam single rather than two-tier.
 *
 * Not memoized across calls: `context.config` can be mutated in place by a
 * `/appearance` (or other settings) command mid-session, and level/ascii must
 * reflect the *current* config, exactly like the fullscreen TUI's own
 * `resolveGlyphMode` call sites (`tui.ts`) which recompute on every use
 * instead of caching once.
 */
function commandTheme(context: CommandContext): Theme {
  // Optional chaining, not `context.config.appearance.glyphMode`: many test
  // fixtures build a partial `CommandContext` (`{ out, credentials, ... } as
  // unknown as CommandContext`) with no `config` at all, since chalk never
  // needed one — this accessor must not turn "no config in this fixture"
  // into a crash. `"auto"` is `DEFAULT_APPEARANCE.glyphMode` itself, so a
  // missing field degrades to exactly the same env-driven detection a real
  // default config would produce. The resolve-then-build body itself now
  // lives in `themeForGlyphPreference` (F6 theme-accessor dedupe) — this
  // accessor's own job is only extracting the field from `CommandContext`.
  return themeForGlyphPreference(context.config?.appearance?.glyphMode ?? "auto", process.env);
}

/**
 * Fallback for the handful of print paths in this file with no
 * `CommandContext` in scope (`promptForValidKey`'s startup key-entry loop,
 * and this file's own `error()` sink below): there is no config to resolve
 * `ascii` from without threading a new parameter through their public
 * signatures (`promptForValidKey` is exercised directly by tests with a bare
 * `CommandOutput`-shaped object), and — as `commandTheme`'s own doc explains —
 * `ascii` only ever matters where `theme.glyph()` is used, which none of
 * these sites do. Level detection (NO_COLOR/FORCE_COLOR/TTY) still matches
 * chalk's own autodetection exactly, since `createTheme()` defers to it
 * unchanged (see `ui/theme.ts`). Parked for F6, per ruling 5.
 */
function plainTheme(): Theme {
  return createTheme();
}

/** Writes straight to stdout/stderr — the `--plain` and non-TTY sink. */
export function createPlainCommandOutput(): CommandOutput {
  return {
    text(value: string): void {
      console.log(value);
    },
    error(value: string, hint?: string): void {
      const theme = plainTheme();
      console.error(theme.color("danger")(value));
      if (hint) {
        console.error(theme.color("muted")(hint));
      }
    },
  };
}

function processCallbacksForEvents(onEvent: (event: AgentRunEvent) => void): ProcessCallbacks {
  const redactor = new ProcessEventRedactor();
  const emit = (event: AgentRunEvent): void => {
    for (const safe of redactor.push(event)) onEvent(safe);
  };
  return {
    onProcessStart: (operation) => emit({
      type: "process-start",
      ...operation,
      timestamp: Date.now(),
    }),
    onProcessChunk: (operation, stream, text) => emit({
      type: "process-output",
      id: operation.id,
      name: operation.name,
      stream,
      text,
      timestamp: Date.now(),
    }),
    onProcessEnd: (operation, completion) => emit({
      type: "process-end",
      id: operation.id,
      name: operation.name,
      input: operation.input,
      ...completion,
      timestamp: Date.now(),
    }),
  };
}

export async function handleSlashCommand(
  raw: string,
  context: NullableCommandContext,
): Promise<"continue" | "exit"> {
  const [commandToken = "", ...tokenizedArgs] = tokenize(raw.slice(1));
  // FIX-15: a retired top-level token says once where it went and then runs
  // the surviving command — never a second implementation of it. See
  // RETIRED_SLASH_COMMANDS (command-catalog.ts) for why `/reconnect` is one.
  const retired = retiredSlashCommand(raw);
  if (retired) {
    context.out.text(commandTheme(context as CommandContext).color("muted")(retired.notice));
    return handleSlashCommand(retired.replacement, context);
  }
  const resolution = resolveSlashCommand(raw)
    ?? (commandToken ? undefined : resolveSlashCommand("help"));
  if (!resolution) {
    context.out.error(
      `Unknown command: /${commandToken.toLowerCase()}.`,
      "Use /help.",
    );
    return "continue";
  }
  const command = resolution.handlerId;
  const args = command.startsWith("collab-cross-")
    ? [commandToken, ...tokenizedArgs].slice(commandToken.toLowerCase() === "cross" ? 2 : 3)
    : tokenizedArgs;
  // Preserve the owner-surface security gate: a missing Settings port must
  // fail before any unrelated runtime capability is inspected. When the port
  // exists, the active-Cross gate below still blocks opening Settings.
  if (command === "settings" && !context.settings) {
    throw new SettingsInteractiveRequiredError();
  }
  // l5's fourth copy, closed. This is the SHARED dispatcher every surface
  // calls, and it was the one place that could not reach the list in `cli.ts`
  // — the import runs the other way — so it kept an inline four-name chain
  // and a verbatim copy of the sentence. The list lives in
  // `command-catalog.ts` now, which both files already import.
  if (context.crossRunActive?.() && !commandAllowedDuringCrossRun(command)) {
    context.out.error(CROSS_RUN_ACTIVE_COMMAND_NOTICE);
    return "continue";
  }
  // Model-dependent handlers are dispatched only after the CLI route gate;
  // local handlers below use nullable-aware helpers when no agent exists.
  const dispatchContext = context as CommandContext;
  const kimiOnlyUnsupported = [
    "key",
    "balance",
    "image",
    "whisper",
    "panel",
    "web",
    "fallback",
  ].includes(command) || (
    command === "compress"
    && (args[0] ?? "").toLowerCase() === "model"
  );
  if (
    kimiOnlyUnsupported
    && currentCommandBackend(dispatchContext) === "kimi-code"
  ) {
    throw new Error(
      `${command === "image" ? "Images" : command === "whisper" ? "Voice and transcription" : command === "panel" ? "Panel" : command === "web" ? "Web" : command === "compress" ? "Summarizer model choice" : command === "fallback" ? "Fallback models" : "This OpenRouter feature"} isn't available yet in orcode with a Kimi Code subscription.`,
    );
  }

  switch (command) {
    case "help":
      printHelp(dispatchContext);
      return "continue";
    case "quit":
      return "exit";
    case "status":
      printStatus(dispatchContext);
      return "continue";
    case "key":
      await keyCommand(args, dispatchContext);
      return "continue";
    case "balance":
      await printBalance(await context.openRouter.checkBalance(), context.out);
      return "continue";
    case "model":
      await modelCommand(args, dispatchContext);
      return "continue";
    case "models":
      await modelsCommand(args, dispatchContext);
      return "continue";
    case "think":
      await reasoningCommand(args, dispatchContext);
      return "continue";
    case "allow":
      await approvalCommand(args, dispatchContext);
      return "continue";
    case "chat":
      await chatCommand(args, dispatchContext);
      return "continue";
    case "folder":
      await folderCommand(args, dispatchContext);
      return "continue";
    case "new":
      await chatCommand(["new", ...args], dispatchContext);
      return "continue";
    case "fork":
      await chatCommand(["fork", ...args], dispatchContext);
      return "continue";
    case "compress":
      await compressorCommand(args, dispatchContext);
      return "continue";
    case "compact":
      await compactCommand(dispatchContext);
      return "continue";
    case "image":
      context.out.text(
        "Image attachments are available in the fullscreen TUI: /image or /image <path>",
      );
      return "continue";
    case "whisper":
      context.out.text(
        "Voice input is available in the fullscreen TUI: /whisper.",
      );
      return "continue";
    case "panel":
      await panelCommand(args, dispatchContext);
      return "continue";
    case "architect":
      await architectCommand(args, dispatchContext);
      return "continue";
    case "cost":
      printCosts(context.session, context.out, commandTheme(dispatchContext));
      return "continue";
    case "max-cost":
      await maxCostCommand(args, dispatchContext);
      return "continue";
    case "steps":
      await stepsCommand(args, dispatchContext);
      return "continue";
    case "history":
      printHistory(context.session, args, context.out);
      return "continue";
    case "context":
      await contextCommand(args, dispatchContext);
      return "continue";
    case "goal":
      await goalCommand(args, dispatchContext);
      return "continue";
    case "clear":
      await clearSession(dispatchContext);
      return "continue";
    case "diff":
      {
        const callbacks = context.onRunEvent
          ? processCallbacksForEvents(context.onRunEvent)
          : undefined;
        const diff = await getGitDiff(context.workspace, runProcess, callbacks);
        if (!callbacks) context.out.text(diff);
      }
      return "continue";
    case "undo":
      if (args.includes("--dry-run")) {
        // Unchanged pre-Phase-11 preview path: reports directly off this
        // process's own in-memory journal, no run-log discovery, no
        // confirmation — a read-only "what would happen" debug affordance
        // that predates the deliberate flow below and stays exactly as it
        // was so it keeps working the same regardless of run-log state.
        const local = commandLocalRuntime(context);
        context.out.text(
          await local.journal.undoLast(local.guard, context.approvals, { dryRun: true }),
        );
      } else {
        await undoCommand(dispatchContext);
      }
      return "continue";
    case "recover":
      await recoverCommand(args, dispatchContext);
      return "continue";
    case "settings": {
      // One lookup serves both spellings: `/theme` arrives as the command
      // TOKEN, `/settings theme` as its argument, and both are category
      // names. Anything else is refused with the catalog's own usage rather
      // than silently opening the default page.
      const requested = args[0] ?? commandToken;
      const category = resolveSettingsCategory(requested);
      if (args.length > 1 || (args.length === 1 && !category)) {
        throw new Error(SETTINGS_COMMAND_USAGE);
      }
      await context.settings!.open(category);
      return "continue";
    }
    case "collab-cross":
      await requireCrossCommandPort(context).openGate(context.composerDraft?.read() ?? "");
      return "continue";
    case "collab-cross-run":
      // The task text pre-fills the gate's draft exactly like the composer
      // draft does for bare `/cross` — this arm never starts directly
      // (E-HONEST-02); the gate's own "start" action performs the same
      // launchCrossRun hand-off bare `/cross` already relies on.
      await requireCrossCommandPort(context).openGate(args.join(" "));
      return "continue";
    case "collab-cross-models":
      // No separate picker-only flow any more — this opens the same gate as
      // bare `/cross`, focused on role selection.
      await requireCrossCommandPort(context).openGate(context.composerDraft?.read() ?? "");
      return "continue";
    case "collab-cross-swap":
      await requireCrossCommandPort(context).swapModels();
      return "continue";
    case "collab-cross-status":
      requireCrossCommandPort(context).status();
      return "continue";
    case "collab-cross-stop":
      await requireCrossCommandPort(context).stop();
      return "continue";
    case "collab-cross-off":
      // Immediate disarm, no confirmation (controller ruling 6) — symmetric
      // with how easy arming is (one gate choice), disarming must never grow
      // its own confirmation step or the feature becomes sticky in a way the
      // owner never asked for.
      if (context.session.data.crossMode === undefined) {
        context.out.text("Cross mode is already off.");
        return "continue";
      }
      context.session.disarmCrossMode();
      await context.session.save();
      context.out.text("Cross mode off — next message runs single-model.");
      return "continue";
    case "config":
      context.out.text(commandTheme(dispatchContext).color("text", { bold: true })(context.configPath ?? CONFIG_PATH));
      if (context.config) {
        const { providerSetup: _privateProviderSetup, ...publicConfig } = context.config;
        assertNoPrivateProviderStateLeaves(publicConfig);
        context.out.text(JSON.stringify(publicConfig, null, 2));
      }
      return "continue";
    case "export":
      await exportCommand(args, dispatchContext);
      return "continue";
    case "checkpoint":
      await checkpointCommand(args, dispatchContext);
      return "continue";
    case "budget":
      await budgetCommand(args, dispatchContext);
      return "continue";
    case "verify":
      await verifyCommand(args, dispatchContext);
      return "continue";
    case "web":
      await webCommand(args, dispatchContext);
      return "continue";
    case "provider":
      await providerCommand(args, dispatchContext);
      return "continue";
    case "fallback":
      await fallbackCommand(args, dispatchContext);
      return "continue";
    case "init":
      await initInstructions(dispatchContext);
      return "continue";
    case "ssh":
      await sshCommand(args, dispatchContext);
      return "continue";
  }

  return unreachableSlashHandler(command);
}

function currentCommandBackend(
  context: CommandContext,
): RouteIdentityV1["backendId"] | null {
  try {
    return context.providerRoutes?.currentSessionRoute?.().backendId ?? null;
  } catch (error) {
    if (
      error instanceof ProviderSetupRequiredError
      || (typeof error === "object" && error !== null && "code" in error
        && error.code === "provider-setup-required")
    ) return null;
    throw error;
  }
}

function requireCrossCommandPort(context: NullableCommandContext): CrossCommandPort {
  if (!context.cross) throw new Error("Cross is not available in this runtime.");
  return context.cross;
}

function requireArchitectCommandPort(context: NullableCommandContext): ArchitectCommandPort {
  if (!context.architect) throw new Error("Architect is not available in this runtime.");
  return context.architect;
}

/**
 * Phase 14: `/architect` — the one-shot, non-persistent flow ruling 1
 * describes. No gate, no arming, no continuation: a drafted task is
 * required outright (ruling 1's honest one-liner), the executor route must
 * already be set (ruling 2's honest refusal, never a silent main-route
 * fallback), and Kimi sessions refuse the same way Cross does (ruling 5).
 *
 * Cost booking happens here, exactly once per phase, so ruling 4's "cancel
 * books only the planning cost" is trivially true by construction: the
 * executor's `session.addCost` calls are physically unreached on the
 * decline branch, not merely skipped by a flag.
 */
export async function architectCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<void> {
  const port = requireArchitectCommandPort(context);
  // The composer draft is consumed once, up front — exactly where `/cross`
  // consumes it (`openGate(context.composerDraft?.read() ?? "")`, before its own
  // gate can refuse) — so every refusal below can hand it straight back.
  const consumedDraft = args.length > 0 ? "" : context.composerDraft?.read() ?? "";
  /**
   * A refusal must never silently eat the draft it just consumed: that is
   * the same "failed submit clears the composer" defect the audit flagged.
   * This is the SAME restore seam Cross's own cancelled gate calls
   * (`deps.restoreDraft()` → `ui.restoreCrossCommandDraft()`, cli.ts), given
   * a second caller — never a second mechanism. Armed only when THIS
   * invocation actually consumed a non-empty draft, so it can never
   * resurrect an older one left in the restore slot. Once the planner has
   * run there is no restore: real work happened and real cost was booked, so
   * the draft is spent, matching Cross's own discard-on-start.
   */
  const restoreConsumedDraft = (): void => {
    if (consumedDraft) context.composerDraft?.restore?.();
  };
  const unavailable = port.unavailableReason();
  if (unavailable) {
    context.out.error(unavailable);
    restoreConsumedDraft();
    return;
  }
  const executorRoute = port.executorRoute();
  if (!executorRoute) {
    context.out.error(ARCHITECT_EXECUTOR_UNSET_REFUSAL);
    restoreConsumedDraft();
    return;
  }
  const task = (args.length > 0 ? args.join(" ") : consumedDraft).trim();
  if (!task) {
    context.out.error(ARCHITECT_EMPTY_DRAFT_REFUSAL);
    restoreConsumedDraft();
    return;
  }

  // Ruling 6: the existing run-status machinery shows phases honestly — a
  // plain phase announcement here, then the planner's own streamed output
  // (agent.ts prints it live when no observer is wired, exactly like an
  // ordinary turn) before the plan text and the confirmation appear.
  context.out.text("Architect: planning (read-only) …");
  const plan = await port.plan(task);
  context.session.addCost("main", plan.mainCostUsd);
  context.session.addCost("compressor", plan.compressorCostUsd);
  if (plan.costKnowledge === "unknown") context.session.addCost("main", 0, "unknown");
  await context.session.save();

  if (!plan.text.trim()) {
    context.out.error("Architect: the planner produced no plan. Planning cost is already booked.");
    return;
  }
  context.out.text(plan.text);

  const theme = commandTheme(context);
  // Fix round 1 (finding 3): price what the executor call will ACTUALLY
  // send — its prompt is the context packet (chat slice + omission markers
  // + the task) plus the accepted plan, not the plan alone. Same estimator
  // as before, only fed the honest char count, exactly as FIX-10 fixed the
  // Cross gate's own understated Start-row estimate.
  const promptChars = port.chatContextChars() + task.length + plan.text.length;
  const consequence = architectConfirmConsequence(
    plan.plannerRoute,
    executorRoute,
    await architectExecutorPrice(context, executorRoute),
    promptChars,
  );
  // D4 (ruling 4): ordinary, not danger — executing a shown plan with
  // normal approvals afterward is ordinary; Enter accepts (class default).
  // Same fallback-to-`confirmPlain` seam `confirmFolderCreate` already
  // establishes for `/folder new` — a surface may supply its own dialog
  // (dashboard polish, not yet wired); tests inject a fake answer directly.
  const accepted = await confirmInContext(context, { title: ARCHITECT_CONFIRM_TITLE, consequence });
  if (!accepted) {
    context.out.text(architectCancelNotice(plan));
    const plannedCostUsd = plan.costKnowledge === "unknown" ? undefined : plan.costUsd;
    const assistant = `${plan.text}\n\n${
      architectResultBlock(theme, plan.plannerRoute, executorRoute, "cancelled", plannedCostUsd)
    }`;
    context.session.addTurn("user", task);
    context.session.addTurn("assistant", assistant);
    await context.session.save();
    return;
  }

  context.out.text(`Architect: executing with ${shortModelName(executorRoute.requestedModelId)} …`);
  const executed = await port.execute(task, plan);
  context.session.addCost("main", executed.mainCostUsd);
  context.session.addCost("compressor", executed.compressorCostUsd);
  if (executed.costKnowledge === "unknown") context.session.addCost("main", 0, "unknown");

  const costKnown = plan.costKnowledge === "known" && executed.costKnowledge === "known";
  const totalCostUsd = costKnown ? plan.costUsd + executed.costUsd : undefined;
  const assistantText = executed.text.trim() || plan.text;
  const assistant = `${assistantText}\n\n${
    architectResultBlock(theme, plan.plannerRoute, executorRoute, executed.outcome, totalCostUsd)
  }`;
  context.session.addTurn("user", task);
  context.session.addTurn("assistant", assistant);
  await context.session.save();
  context.out.text(executed.text || architectEmptyExecutorSummary(executed.changed));
}

/**
 * Same estimate heuristic `/panel` and Cross's own gate use
 * (`estimatePanelModelCostUsd`/`crossGateConsequence`): the executor's
 * cached catalog price, looked up live exactly like `panelCommand` already
 * does (`context.openRouter.loadModels()`) rather than requiring a second
 * catalog-passing seam on `ArchitectCommandPort`. A provider-managed
 * (non-OpenRouter) executor route is unpriced by construction — its
 * `backendId` alone is enough for `classifyCostForecastPrice`
 * (cost-forecast.ts) to read it as "cost unknown".
 */
async function architectExecutorPrice(
  context: CommandContext,
  executorRoute: RouteIdentityV1,
): Promise<ArchitectExecutorPriceInput> {
  if (executorRoute.backendId !== "openrouter") {
    return { backendId: executorRoute.backendId, promptPrice: undefined, completionPrice: undefined };
  }
  const catalog = await context.openRouter.loadModels();
  const info = catalog.find((model) =>
    model.id === executorRoute.requestedModelId || model.canonicalSlug === executorRoute.requestedModelId);
  return {
    backendId: "openrouter",
    promptPrice: info?.promptPrice,
    completionPrice: info?.completionPrice,
  };
}

/**
 * Pure presentation result for the atomic Kimi preference edit. The caller
 * passes the exact session snapshot used to build the transaction candidate;
 * `prepareSessionPreferenceEdit` performs the actual Cross disarm inside that
 * candidate. Keeping this helper free of mutation/persistence makes it
 * impossible to reintroduce a misleading post-commit save failure.
 */
export function kimiCrossDisarmNoticeForPreference(
  sessionData: Readonly<{ readonly crossMode?: unknown }>,
  afterRoute: RouteIdentityV1,
): string | null {
  if (afterRoute.backendId !== "kimi-code" || sessionData.crossMode === undefined) {
    return null;
  }
  return "Cross mode off — Kimi Code routes do not support Cross; next message runs single-model.";
}

/**
 * FIX-14 ticket 6: every confirmation a command asks for goes through here.
 *
 * `context.confirm` is the surface's own modal when one exists (the
 * fullscreen dashboard wires it once, in cli.ts); otherwise this falls back
 * to `confirmPlain`, the plain-surface primitive D4 established. The
 * request and the grading options are the SAME shapes `confirmPlain`
 * defines, so a call site states its question and its D4 class once and both
 * surfaces honour both.
 */
/**
 * FIX-14 ticket 6: the ONE process-only credential question. Its title used
 * to live in cli.ts's fullscreen adapter and its (differently worded) plain
 * form in three separate `confirmPlain` calls here; the two halves are
 * merged into this one request, and the sentence about no plaintext file —
 * previously visible only in fullscreen — now reaches both surfaces.
 */
export function processOnlyCredentialRequest(
  kind: "inference" | "management",
  location: string,
  reason: string,
): ConfirmPlainRequest {
  return {
    title: kind === "inference"
      ? "Use the key for this process only?"
      : "Use the management key for this process only?",
    consequence: `The key is valid, but ${location} isn't available (${reason}).\n`
      + "No plaintext file or alternative storage will be created.",
  };
}

/**
 * D4: ordinary, not danger — declining a process-only key is not destructive
 * (it simply means the key is not used this run) — but with the documented
 * `defaultAccept: false`, because using an unpersisted key deserves an
 * explicit yes rather than an eager Enter.
 */
export const PROCESS_ONLY_CREDENTIAL_OPTIONS: ConfirmPlainOptions = Object.freeze({ defaultAccept: false });

function confirmProcessOnlyCredential(
  context: Pick<CommandContext, "confirm" | "credentials">,
  kind: "inference" | "management",
  reason: string,
): Promise<boolean> {
  return confirmInContext(
    context,
    processOnlyCredentialRequest(kind, context.credentials.location, reason),
    PROCESS_ONLY_CREDENTIAL_OPTIONS,
  );
}

export async function confirmInContext(
  context: Pick<CommandContext, "confirm">,
  request: ConfirmPlainRequest,
  options: ConfirmPlainOptions = {},
): Promise<boolean> {
  return context.confirm
    ? context.confirm(request, options)
    : confirmPlain(request, options);
}

function unreachableSlashHandler(handlerId: never): never {
  throw new Error(`Unimplemented command handler ID: ${handlerId}`);
}

/**
 * FIX-15 fix round 1 (F2a): the one sentence that tells an owner how to
 * re-check a connection whose live check just failed.
 *
 * It has to branch, because `/provider reconnect openrouter` resolves
 * credentials through `ProviderCredentialAuthority`, whose permit sources are
 * strictly saved-or-environment (provider-authority.ts). A key the owner
 * accepted interactively when the keychain was unavailable lives in this
 * process's memory only — orcode says so itself — and is invisible to that
 * path, which lands on `setup-required` instead. Recommending it there was
 * advice that could not work. In that state the honest next step is `/key
 * save`, which is precisely what makes the key visible to the command being
 * recommended.
 *
 * Both call sites share this so the two spellings cannot drift apart again.
 */
export function recheckConnectionHint(keyOrigin: KeyOrigin): string {
  return keyOrigin === "interactive"
    ? "It lives in this session's memory only, so /provider reconnect openrouter cannot see it — /key save stores it first, or /key status re-checks it as it stands."
    : "Check it again with /key status or /provider reconnect openrouter.";
}

export async function promptForValidKey(
  openRouter: OpenRouterService,
  credentials: CredentialStoreLike,
  out: CommandOutput,
  _fallback?: {
    key: string;
    origin: Exclude<KeyOrigin, "none">;
  },
): Promise<BalanceReport | null> {
  const theme = plainTheme();
  while (true) {
    if (openRouter.hasKey) {
      const origin = openRouter.keyOrigin;
      const activeKey = openRouter.requireKey();
      try {
        const balance = await openRouter.checkBalance();
        assertSpendAvailable(balance);
        if (origin === "environment") {
          out.text(
            theme.color("muted")(
              "OPENROUTER_API_KEY is valid and stays process-only. Save it permanently with /key save.",
            ),
          );
        }
        return balance;
      } catch (error) {
        if (!shouldReplaceCredential(error, openRouter)) {
          out.error(
            `OpenRouter startup check unavailable: ${openRouter.safeMessage(error)} The key stays loaded. ${recheckConnectionHint(openRouter.keyOrigin)}`,
          );
          return null;
        }
        const message = openRouter.safeMessage(error).replace(/[.!?]+$/, "");
        if (!process.stdin.isTTY) {
          throw new Error(
            `${originLabel(origin)} was rejected: ${message}. Set a valid key.`,
          );
        }
        out.error(
          `${originLabel(origin)} was rejected but stays stored unchanged until a validated replacement: ${message}`,
        );
      }
    }
    if (!process.stdin.isTTY) {
      throw new Error(
        "OPENROUTER_API_KEY is missing. Set the environment variable before a non-interactive start.",
      );
    }
    const candidate = await password({
      message: "OpenRouter API key (hidden):",
      mask: "•",
      validate: validateProviderSecretInput,
    });
    try {
      const activated = await validateAndActivateInferenceKey(
        candidate,
        { credentials, openRouter },
        {
          persist: true,
          // D4: ordinary (declining a process-only key isn't destructive),
          // but keeps its existing documented default: false — using an
          // unpersisted key deserves an explicit yes, not an eager accept.
          confirmProcessOnly: async (error) => confirmPlain(
            processOnlyCredentialRequest("inference", credentials.location, errorMessage(error)),
            PROCESS_ONLY_CREDENTIAL_OPTIONS,
          ),
        },
      );
      if (!activated) {
        out.text("Key unchanged; process-only use cancelled.");
        continue;
      }
      out.text(
        theme.color("ok")(
          activated.persisted
            ? `API key valid and stored securely in ${credentials.location}.`
            : "API key valid. It stays in process memory for this session.",
        ),
      );
      return activated.balance;
    } catch (error) {
      out.error(openRouter.safeMessage(error));
    }
  }
}

export async function printBalance(
  balance: Awaited<ReturnType<OpenRouterService["checkBalance"]>>,
  out: CommandOutput,
): Promise<void> {
  const theme = plainTheme();
  const bold = theme.color("text", { bold: true });
  out.text(bold("OpenRouter status"));
  out.text(`Key valid: ${theme.color("ok")("yes")}`);
  // FIX-9: `isFreeTier` is a two-state signal from OpenRouter's key endpoint
  // (`is_free_tier`) — false simply means "not the free tier", so the honest
  // rendering is the plain opposite word, not the "paid/custom" hedge that
  // implied a third, unreported plan shape.
  out.text(`Plan: ${balance.key.isFreeTier ? "Free tier" : "Paid"}`);
  if (balance.key.limit !== null && balance.key.limit !== undefined) {
    out.text(
      `Key limit: ${formatUsd(balance.key.limit)}${theme.glyph("separator")}remaining ${formatUsd(balance.key.limitRemaining ?? 0)}`,
    );
  } else {
    out.text(`Key usage: ${formatUsd(balance.key.usage ?? 0)}${theme.glyph("separator")}no key-specific limit`);
  }
  if (balance.credits) {
    out.text(
      `Account balance: ${formatUsd(balance.credits.remaining)} remaining${theme.glyph("separator")}${formatUsd(balance.credits.totalUsage)} used`,
    );
  } else if (balance.capabilities?.creditsSource === "none") {
    // No failed request happened here — the round was skipped on purpose.
    out.text(
      theme.color("warn")(
        `Account balance unknown: ${balance.creditsUnavailableReason ?? balance.capabilities.summary}`,
      ),
    );
  } else if (balance.creditsUnavailableReason) {
    out.text(theme.color("warn")(balance.creditsUnavailableReason));
  }
  if (balance.capabilities) {
    out.text(theme.color("muted")(`Key capabilities: ${balance.capabilities.summary}`));
  }
  if (balance.key.expiresAt) {
    out.text(`Key expires: ${balance.key.expiresAt}`);
  }
}

/** `/help`'s own floor — never asked to lay the catalog out any narrower than this, matching every other width-aware renderer's `Math.max(40, …)` clamp (`printPanelResult` below). */
const HELP_MIN_WIDTH = 40;

/**
 * `/help`'s closing muted hint line (D5, "the first 60 seconds"): `/name` is
 * deliberately the literal word, not a placeholder filled in per row — one
 * generic reminder that any row is itself a runnable command, plus the
 * palette as the interactive alternative. Matches the palette top rule's own
 * `${divider} ` prefix (`buildListLines`'s breadcrumb rule in
 * dashboard-frame.ts) so the two screens read as one grammar. The join
 * between its two clauses goes through `theme.glyph("separator")`, never a
 * raw `·` literal — the same NO_COLOR/ASCII-parity rule the palette's own
 * `chevron`/`separator` glyphs already follow (F2 ruling 2).
 */
function helpHintLine(theme: Theme): string {
  return `/name runs a command${theme.glyph("separator")}the / palette searches everything`;
}

/**
 * `/help` in the V3 palette/list optic (D5): grouped `─ <Group>` rules —
 * the exact glyph language the command palette's own top rule uses
 * (`theme.glyph("divider")` in "structure", the crumb text in "muted") —
 * then `  /name  <muted description>` rows aligned on ONE global column
 * (every leaf's `/name` width, not a per-group width, so the whole screen
 * reads as one table). `COMMAND_CATALOG`/`COMMAND_TREE` are the one source
 * of truth: a new command in the catalog appears here without touching this
 * function (`tests/commands.test.ts`'s catalog-driven proof).
 *
 * Deliberately renders the bare canonical name (`/model`), never the
 * catalog's `usage` field (`/model [provider/model|current]`) — `usage`'s
 * argument grammar is not shown anywhere else in the app (the palette rows
 * don't show it either); the old plain dump was its only reader, and typing
 * a bare command already surfaces its own usage on a bad argument. Pure and
 * width-driven (no `process.stdout` read in here) so callers — `printHelp`
 * below, and tests — can pin the 40-column floor's ellipsize-description
 * -never-the-name behavior with an explicit width, exactly like
 * `renderPanel` (`ui/panel-view.ts`) is tested.
 */
export function renderHelpLines(theme: Theme, width: number): Line[] {
  const usable = Math.max(HELP_MIN_WIDTH, width);
  const nameWidth = Math.max(
    ...COMMAND_CATALOG.map((entry) => displayWidth(`/${entry.name}`)),
  );
  const rule = (text: string): Line => ({
    spans: [
      span(`${theme.glyph("divider")} `, "structure"),
      span(text, "muted"),
    ],
  });
  const lines: Line[] = [
    { spans: [] },
    { spans: [span("orcode commands", "text", { bold: true })] },
  ];
  for (const group of COMMAND_TREE) {
    if (group.kind !== "branch") continue;
    lines.push(rule(group.name));
    for (const command of flattenCommandTree(group.children)) {
      lines.push(helpTableRow(theme, `/${command.name}`, command.description, nameWidth, usable));
    }
  }
  // FIX-4: the keyboard half of the same screen, rendered from `ui/keymap.ts`
  // exactly the way the rows above are rendered from the command catalog —
  // one `─ Shortcuts` section rule, then one `─ <Context>` rule per screen,
  // so `/help` and the `?` footer can never disagree with each other or with
  // `tui.ts`. The key column is measured across ALL contexts, so the whole
  // section reads as one table, and it never shrinks: at the 40-column floor
  // the description ellipsizes instead (same contract as a command row).
  const shortcutGroups = shortcutsByContext();
  const keyWidth = Math.max(
    ...SHORTCUTS.map((binding) => displayWidth(shortcutKeys(theme, binding))),
  );
  lines.push({ spans: [] }, rule("Shortcuts"));
  for (const group of shortcutGroups) {
    lines.push(rule(group.context));
    for (const binding of group.bindings) {
      lines.push(helpTableRow(theme, shortcutKeys(theme, binding), binding.action, keyWidth, usable));
    }
  }
  lines.push(rule(helpHintLine(theme)));
  return lines;
}

/**
 * One `/help` row — a command's `/name` or a shortcut's key column: the label
 * column never shrinks; the description ellipsizes into whatever the row's own
 * width leaves for it (`fitSpans`, the same primitive `ui/list-core.ts`'s
 * picker rows and `ui/workbench.ts`'s hub bar use), never the other way round
 * — the 40-column floor's binding behavior (D5 ruling 3, extended to the
 * shortcut table by FIX-4 rather than duplicated for it).
 */
function helpTableRow(
  theme: Theme,
  label: string,
  description: string,
  labelWidth: number,
  width: number,
): Line {
  const indent = 2;
  const gap = 2;
  const pad = Math.max(0, labelWidth - displayWidth(label));
  const spans: Span[] = [
    span(" ".repeat(indent), "text"),
    span(`${label}${" ".repeat(pad)}`, "text"),
  ];
  const budget = width - indent - labelWidth - gap;
  if (budget > 0) {
    spans.push(
      span(" ".repeat(gap), "text"),
      ...fitSpans([span(description, "muted")], budget, theme.glyph("ellipsis")),
    );
  }
  return { spans };
}

function printHelp(context: CommandContext): void {
  const theme = commandTheme(context);
  const width = Math.max(HELP_MIN_WIDTH, Math.min(process.stdout.columns || 100, 120));
  for (const rendered of renderLines(renderHelpLines(theme, width), theme)) {
    context.out.text(rendered);
  }
}

function printStatus(context: CommandContext): void {
  const theme = commandTheme(context);
  // FIX-14 ticket 8: one separator source for every row this prints.
  const sep = theme.glyph("separator");
  context.out.text(theme.color("text", { bold: true })("orcode Status"));
  context.out.text(`Folder: ${context.workspace}`);
  context.out.text(`Main model: ${context.config.mainModel}`);
  context.out.text(
    `Thinking: ${reasoningLabel(getReasoningSetting(context.config))}`,
  );
  context.out.text(
    `Summarize long chats: ${compressionModeLabel(context.config.compressionMode)}${sep}${context.config.compressorModel}${sep}threshold ${context.config.compressionThresholdChars} characters`,
  );
  context.out.text(
    `Approval: ${context.approvals.mode}${sep}${approvalDescription(context.approvals.mode)}`,
  );
  context.out.text(
    `Limits: ${context.config.maxSteps} actions per run${sep}${formatUsd(context.config.maxCostUsd)} main${sep}${formatUsd(context.config.compressorMaxCostUsd)} summarizer`,
  );
  context.out.text(theme.color("muted")(compressorLimitNote(context.config.compressorModel)));
  context.out.text(`Budget: ${budgetSummary(context.config.budget)}`);
  context.out.text(
    `API key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`,
  );
  context.out.text(
    `Management key: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}`,
  );
  printCosts(context.session, context.out, theme);
}

/**
 * The compressor limit is enforced before the call — but only when a price for
 * the model is known. A dynamic route has no price, so the limit can only be
 * checked afterwards; saying otherwise would be a promise we cannot keep.
 */
function compressorLimitNote(compressorModel: string): string {
  return compressorModel.startsWith("openrouter/")
    ? `There's no fixed price for ${compressorModel}: the summarizer limit can only be checked after the call.`
    : "The summarizer limit is checked before the call, provided OpenRouter reports a price for the model.";
}

/**
 * The palette's `current` annotation for `/budget` — the two limits only. It
 * is separate from `budgetSummary` because a palette annotation is the tail
 * of a single row: the full sentence (which also spells out the on-overrun
 * action, and says "no daily limit" rather than nothing at all) belongs to
 * `/budget`'s own multi-line output, not to a one-line row already carrying
 * a name and a description.
 *
 * Fix round 1 (F6): it renders money with `formatUsd` and says "Off", not
 * a second spelling and "No limit". One value must not have three spellings
 * across two owner surfaces — that is the defect class FIX-15 exists to
 * remove, and it would have been embarrassing in the very row this fix was
 * written to correct. `formatUsd`/"Off" is what the `/max-cost` row
 * directly beneath this one uses, and what Settings' own budget rows use
 * for these exact two numbers (`optionalUsd`, settings-registry.ts).
 *
 * FIX-14 ticket 3 finished that: this file's own `usd()` (5 decimals under
 * a cent, else 2) is deleted and its 25 call sites — `budgetSummary` below
 * included — call `formatUsd` too, so the whole file has one dollar
 * spelling rather than two neighbouring ones.
 */
export function budgetLimitsLabel(budget: BudgetConfig): string {
  const parts = [
    budget.dailyLimitUsd === null ? null : `Day ${formatUsd(budget.dailyLimitUsd)}`,
    budget.totalLimitUsd === null ? null : `Total ${formatUsd(budget.totalLimitUsd)}`,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Off";
}

function budgetSummary(budget: BudgetConfig): string {
  const parts = [
    budget.dailyLimitUsd === null
      ? "no daily limit"
      : `Day ${formatUsd(budget.dailyLimitUsd)}`,
    budget.totalLimitUsd === null
      ? "no total limit"
      : `Total ${formatUsd(budget.totalLimitUsd)}`,
  ];
  const action = budget.onExceed === "block" ? "blocks" : "warns";
  return `${parts.join(" · ")} · on overrun ${action}`;
}

async function keyCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    const stored = await context.credentials.has("inference");
    let balance: BalanceReport | null = null;
    let balanceError: unknown;
    if (context.openRouter.hasKey) {
      try {
        balance = await context.openRouter.checkBalance();
      } catch (error) {
        balanceError = error;
      }
    }
    context.out.text(`Active API key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`);
    context.out.text(`Key validity: ${credentialValidityLabel(context.openRouter.runtimeState.inferenceValidity)}`);
    context.out.text(`Connection: ${connectivityLabel(context.openRouter.runtimeState.connectivity)}`);
    context.out.text(`Balance status: ${creditStateLabel(context.openRouter.runtimeState.credit)}`);
    context.out.text(
      `Stored API key: ${
        stored ? `yes, in ${context.credentials.location}` : "no"
      }`,
    );
    if (balance) {
      await printBalance(balance, context.out);
    }
    // FIX-14 ticket 15: the ONE re-check sentence, printed at most once. A
    // failed live check states it as the error's next action; a stored
    // "disconnected" with no failure of its own still gets it, because the
    // `Connection:` line above no longer carries (unbranched, sometimes
    // wrong) advice of its own.
    if (balanceError) {
      context.out.error(
        `Live check unavailable: ${context.openRouter.safeMessage(balanceError)}`,
        `The key stays loaded. ${recheckConnectionHint(context.openRouter.keyOrigin)}`,
      );
    } else if (context.openRouter.runtimeState.connectivity === "disconnected") {
      context.out.text(recheckConnectionHint(context.openRouter.keyOrigin));
    }
    return;
  }
  if (action === "forget") {
    // FIX-14 ticket 6: one question for both surfaces. Plain mode used to put
    // the whole sentence in the title while fullscreen asked "Really remove
    // the API key?" with the sentence underneath; the second shape is the
    // one that survives, on both.
    const accepted = await confirmInContext(
      context,
      {
        title: "Really remove the API key?",
        consequence: `It will be removed from ${context.credentials.location} and from process memory. `
          + "It stays unchanged if multiple provider connections exist.",
      },
      { danger: true },
    );
    if (!accepted) {
      context.out.text("API key unchanged; removal cancelled.");
      return;
    }
    const delegated = context.providerCredentials
      ? await context.providerCredentials.apply({
          kind: "forget",
          credentialKind: "inference",
        })
      : null;
    if (delegated?.kind === "unchanged" && delegated.reason === "shared-reference") {
      context.out.text(
        "API key unchanged: multiple OpenRouter connections are set up. Remove them individually with /provider logout.",
      );
      return;
    }
    const removed = delegated
      ? delegated.removed === true
      : await context.credentials.delete("inference");
    if (!delegated) context.openRouter.forgetKey();
    context.out.text(
      removed
        ? `API key removed from process memory and ${context.credentials.location}.`
        : "API key removed from process memory; none was stored in the keyring.",
    );
    return;
  }
  if (action === "save") {
    if (!context.openRouter.hasKey) {
      throw new Error("No active API key to save. Use /key replace.");
    }
    const delegated = context.providerCredentials
      ? await context.providerCredentials.apply({
          kind: "save",
          credentialKind: "inference",
        })
      : null;
    const balance = delegated
      ? delegated.balance
      : await validateAndStoreInferenceKey(context.openRouter.requireKey(), context);
    context.out.text(
      theme.color("ok")(
        `API key checked and stored in ${context.credentials.location}.`,
      ),
    );
    if (balance) await printBalance(balance, context.out);
    return;
  }
  if (action === "set" || action === "replace") {
    const entry = await withCredentialSecret("inference", context, async (candidate) => {
      const activated = context.providerCredentials
        ? await context.providerCredentials.apply({
            kind: "replace",
            credentialKind: "inference",
            candidate,
            allowProcessOnly: (kind, reason) => confirmProcessOnlyCredential(context, kind, reason),
          })
        : await validateAndActivateInferenceKey(candidate, context, {
        persist: true,
        // D4: ordinary, documented default: false — see the identical
        // process-only confirm above in `checkAndSet`.
        confirmProcessOnly: (error) =>
          confirmProcessOnlyCredential(context, "inference", errorMessage(error)),
        });
      if (!activated) {
        context.out.text("Active and stored key unchanged.");
        return;
      }
      context.out.text(
        theme.color("ok")(
          activated.persisted
            ? `New key is valid and stored in ${context.credentials.location}.`
            : "New key is valid and active for this process only.",
        ),
      );
      if (activated.balance) await printBalance(activated.balance, context.out);
    });
    if (entry === "cancelled") {
      context.out.text("Key entry cancelled; active key unchanged.");
    }
    return;
  }
  if (action === "management") {
    const managementAction = (args[1] ?? "status").toLowerCase();
    if (managementAction === "status") {
      const stored = await context.credentials.has("management");
      context.out.text(
        context.openRouter.hasManagementKey
          ? `Management key active: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}.`
          : "No management key active; /balance only checks the inference key's limit.",
      );
      context.out.text(
        `Stored management key: ${
          stored ? `yes, in ${context.credentials.location}` : "no"
        }`,
      );
      context.out.text(
        `Management validity: ${credentialValidityLabel(context.openRouter.runtimeState.managementValidity)}`,
      );
      return;
    }
    if (managementAction === "forget") {
      const accepted = await confirmInContext(
        context,
        {
          title: "Really remove the management key?",
          consequence: `It will be removed from ${context.credentials.location} first, then from process memory.`,
        },
        { danger: true },
      );
      if (!accepted) {
        context.out.text("Management key unchanged; removal cancelled.");
        return;
      }
      if (context.providerCredentials) {
        await context.providerCredentials.apply({
          kind: "forget",
          credentialKind: "management",
        });
      } else {
        await context.credentials.delete("management");
        context.openRouter.forgetManagementKey();
      }
      context.out.text(
        `Management key removed from process memory and ${context.credentials.location}.`,
      );
      return;
    }
    if (managementAction === "save") {
      if (!context.openRouter.hasManagementKey) {
        throw new Error(
          "No active management key to save. Use /key management replace.",
        );
      }
      const delegated = context.providerCredentials
        ? await context.providerCredentials.apply({
            kind: "save",
            credentialKind: "management",
          })
        : null;
      const credits = delegated?.credits ?? await validateAndStoreManagementKey(
        context.openRouter.requireManagementKey(), context,
      );
      context.out.text(
        theme.color("ok")(
          `Management key checked and stored in ${context.credentials.location}. Account balance: ${formatUsd(credits.remaining)} remaining.`,
        ),
      );
      return;
    }
    if (managementAction === "set" || managementAction === "replace") {
      const entry = await withCredentialSecret("management", context, async (candidate) => {
        const activated = context.providerCredentials
          ? await context.providerCredentials.apply({
              kind: "replace",
              credentialKind: "management",
              candidate,
              allowProcessOnly: (kind, reason) => confirmProcessOnlyCredential(context, kind, reason),
            })
          : await validateAndActivateManagementKey(candidate, context, {
          // D4: ordinary, documented default: false — same reasoning as
          // the inference-key process-only confirms above.
          confirmProcessOnly: (error) =>
            confirmProcessOnlyCredential(context, "management", errorMessage(error)),
          });
        if (!activated) {
          context.out.text("Active and stored management key unchanged.");
          return;
        }
        context.out.text(
          theme.color("ok")(
            activated.persisted
              ? `Management key valid and stored in ${context.credentials.location}.${activated.credits ? ` Account balance: ${formatUsd(activated.credits.remaining)} remaining.` : ""}`
              : `Management key valid and active for this process only.${activated.credits ? ` Account balance: ${formatUsd(activated.credits.remaining)} remaining.` : ""}`,
          ),
        );
      });
      if (entry === "cancelled") {
        context.out.text("Management key entry cancelled; active key unchanged.");
      }
      return;
    }
    context.out.text(
      "Usage: /key management set | replace | save | status | forget",
    );
    return;
  }
  context.out.text(
    "Usage: /key set | replace | save | status | forget | /key management set | replace | save | status | forget",
  );
}

/**
 * Reads one provider secret and hands it straight to `use`. The secret is a
 * parameter, never a result — neither this helper nor the surface port it
 * delegates to can be asked for the raw key. Ordering is unchanged: the
 * prompt (Inquirer here, the modal in the wired port) is fully finished
 * before `use` runs, so validation, keychain writes and output happen
 * exactly where and when they did before.
 */
async function withCredentialSecret(
  kind: "inference" | "management",
  context: CommandContext,
  use: (secret: string) => Promise<void>,
): Promise<CredentialSecretEntry> {
  if (context.withCredentialSecret) {
    return context.withCredentialSecret(kind, use);
  }
  const secret = await password({
    message: kind === "inference"
      ? "New OpenRouter API key (hidden):"
      : "OpenRouter management key for /credits (hidden):",
    mask: "•",
    validate: validateProviderSecretInput,
  });
  await use(secret);
  return "used";
}

function validateProviderSecretInput(value: string): true | string {
  try {
    normalizeProviderSecret(value);
    return true;
  } catch (error) {
    return errorMessage(error);
  }
}

interface CredentialActivationOptions {
  persist?: boolean;
  processOrigin?: Exclude<KeyOrigin, "none" | "keychain">;
  signal?: AbortSignal;
  confirmProcessOnly?: (error: unknown) => Promise<boolean>;
}

export async function validateAndActivateInferenceKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  options: CredentialActivationOptions = {},
): Promise<{ balance: BalanceReport; persisted: boolean } | null> {
  const normalized = normalizeProviderSecret(candidate);
  const balance = await context.openRouter.validateInferenceKey(
    normalized,
    options.signal,
  );
  let persisted = options.persist !== false;
  if (persisted) {
    try {
      await context.credentials.set("inference", normalized);
    } catch (error) {
      if (
        error instanceof CredentialStoreError &&
        error.persistenceState === "unknown"
      ) {
        throw error;
      }
      if (!options.confirmProcessOnly || !(await options.confirmProcessOnly(error))) {
        if (options.confirmProcessOnly) return null;
        throw error;
      }
      persisted = false;
    }
  }
  context.openRouter.activateValidatedKey(
    normalized,
    persisted ? "keychain" : (options.processOrigin ?? "interactive"),
    balance,
  );
  return { balance, persisted };
}

export async function validateAndActivateManagementKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  options: Omit<CredentialActivationOptions, "processOrigin"> = {},
): Promise<{ credits: CreditInfo; persisted: boolean } | null> {
  const normalized = normalizeProviderSecret(candidate);
  const credits = await context.openRouter.validateManagementKey(
    normalized,
    options.signal,
  );
  let persisted = options.persist !== false;
  if (persisted) {
    try {
      await context.credentials.set("management", normalized);
    } catch (error) {
      if (
        error instanceof CredentialStoreError &&
        error.persistenceState === "unknown"
      ) {
        throw error;
      }
      if (!options.confirmProcessOnly || !(await options.confirmProcessOnly(error))) {
        if (options.confirmProcessOnly) return null;
        throw error;
      }
      persisted = false;
    }
  }
  context.openRouter.activateValidatedManagementKey(
    normalized,
    persisted ? "keychain" : "interactive",
    credits,
  );
  return { credits, persisted };
}

export async function validateAndStoreInferenceKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  signal?: AbortSignal,
): Promise<BalanceReport> {
  const activated = await validateAndActivateInferenceKey(candidate, context, {
    signal,
  });
  if (!activated) throw new Error("API key activation was cancelled.");
  return activated.balance;
}

export async function validateAndStoreManagementKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  signal?: AbortSignal,
): Promise<CreditInfo> {
  const activated = await validateAndActivateManagementKey(candidate, context, {
    signal,
  });
  if (!activated) throw new Error("Management key activation was cancelled.");
  return activated.credits;
}

async function modelCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const id = args.join(" ").trim();
  if (context.providerRoutes?.listSelectableModelRoutes
    && context.providerRoutes.transitionSessionRoute
    && context.providerRoutes.readModelPreferenceAuthority
    && context.providerRoutes.prepareSettingsModelPublication) {
    if (id.toLowerCase() === "current") {
      context.out.text(`Active model: ${context.config.mainModel}`);
      return;
    }
    const current = context.providerRoutes.currentSessionRoute?.() ?? null;
    let selected: SelectableModelRoute | null;
    if (!id) {
      selected = context.modelRoutePicker
        ? await context.modelRoutePicker.pickModelRoute({
            title: "Choose the main model",
            role: "main",
            current,
            preserveDraft: true,
          })
        : await pickSelectableModelRoute(
            await context.providerRoutes.listSelectableModelRoutes(""),
            current,
            // The exact title the fullscreen picker above uses for this
            // same choice — one screen, one name (FIX-14 ticket 9).
            "Choose the main model",
          );
    } else {
      const routes = await context.providerRoutes.listSelectableModelRoutes(id);
      const exactMatches = routes.filter((row) =>
        row.route.requestedModelId === id || row.route.canonicalModelId === id);
      if (exactMatches.length > 1) {
        if (!context.modelRoutePicker) {
          throw new Error(`Model ID ${id} is available in multiple provider accounts and is ambiguous.`);
        }
        const disambiguated = await context.modelRoutePicker.pickModelRoute({
          title: `Disambiguate ${id}`,
          role: "main",
          current,
          preserveDraft: true,
        });
        selected = disambiguated
          && exactMatches.some((row) => sameCanonicalModelRoute(row.route, disambiguated.route))
          ? disambiguated
          : null;
        if (!selected && disambiguated) {
          throw new Error(`Model ID ${id} is available in multiple provider accounts and is ambiguous.`);
        }
      } else {
        selected = exactMatches[0] ?? null;
      }
    }
    if (!selected) {
      if (id) throw new ModelNotFoundError("main", id);
      return;
    }
    const crossDisarmNotice = await commitSelectableModelRoute(selected, context);
    context.out.text(theme.color("ok")(`Main model: ${selected.route.requestedModelId}`));
    if (crossDisarmNotice) context.out.text(theme.color("warn")(crossDisarmNotice));
    return;
  }
  const kimiRoute = currentCommandBackend(context) === "kimi-code";
  if (kimiRoute) {
    if (!context.providerCommands) throw new Error("Kimi Code provider control is not available.");
    if (!id) {
      const result = await context.providerCommands.execute(
        { kind: "models", backendId: "kimi-code" },
        context.providerRouteSurface ?? "plain",
      );
      if (result.kind !== "models") throw new Error("Kimi Code models are not available.");
      context.out.text(result.models.length
        ? result.models.map((model) => `${model.displayName} · ${model.canonicalModelId}`).join("\n")
        : "No usable Kimi Code models available.");
      return;
    }
    if (id.toLowerCase() === "current") {
      context.out.text(`Active model: ${context.config.mainModel}`);
      return;
    }
    await context.providerRoutes?.transitionModel(id, id, context.providerRouteSurface);
    context.config.mainModel = id;
    context.session.setPreferences(
      context.config.mainModel,
      getReasoningSetting(context.config),
      context.providerRoutes?.currentSessionRoute?.(),
    );
    await saveContextConfig(context);
    await context.session.save();
    context.out.text(theme.color("ok")(`Main model: ${id}`));
    return;
  }
  if (!id) {
    const models = mainModelCandidates(
      await runTransitionCatalog(context, () => context.openRouter.listModels("", false)),
    );
    const selected = await pickModel(models, context.config.mainModel);
    if (!selected) {
      context.out.text("Model selection cancelled.");
      return;
    }
    await selectModel(selected, context);
    return;
  }
  if (id.toLowerCase() === "current") {
    const current = await resolveMainModelCandidate(
      context.openRouter,
      context.config.mainModel,
    );
    if (current) {
      printModelDetails(current, false, context.out);
    } else {
      context.out.text(`Active model: ${context.config.mainModel}`);
    }
    return;
  }
  const exact = await runTransitionCatalog(
    context,
    () => resolveMainModelCandidate(context.openRouter, id),
  );
  if (exact) {
    await selectModel(exact, context);
    return;
  }
  await context.providerRoutes?.transitionModel(id, id, context.providerRouteSurface);
  context.config.mainModel = id;
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await saveContextConfig(context);
  await context.session.save();
  context.out.text(theme.color("ok")(`Main model: ${id}`));
}

/**
 * FIX-14 ticket 9: `title` is a REQUIRED parameter, not a hardcode.
 *
 * Every caller already knows which model it is asking for — "Choose the main
 * model", "Cross · Coding model · writes files", "Disambiguate <id>" — and
 * `ModelRoutePickerPort.pickModelRoute` carries that title in its request.
 * The plain fallback (`createPlainCrossModelPicker`, cli.ts) dropped it on
 * the floor and this function put "Search models" on every screen instead,
 * so a plain-mode owner picking a Cross REVIEW model saw the same heading as
 * one picking their main model. Required rather than defaulted for the same
 * reason `formatChatRow`'s separator is: a default is how the hardcode comes
 * back.
 */
export async function pickSelectableModelRoute(
  routes: readonly SelectableModelRoute[],
  current: RouteIdentityV1 | null,
  title: string,
  pick: typeof pickFromListPlain = pickFromListPlain,
): Promise<SelectableModelRoute | null> {
  if (routes.length === 0) return null;
  const selectedCurrent = current === null
    ? undefined
    : routes.find((row) => sameCanonicalModelRoute(row.route, current));
  return pick<SelectableModelRoute>({
    title,
    initialValue: selectedCurrent,
    choices: (query) => routes
      .filter((row) => `${row.providerLabel} ${row.model.name} ${row.route.requestedModelId}`
        .toLowerCase().includes(query.toLowerCase()))
      .slice(0, 80)
      .map((row) => ({
        value: row,
        name: `${row.providerLabel} · ${row.model.name} [${row.route.requestedModelId}]`,
        description: formatModelRouteDetail({
          providerLabel: row.providerLabel,
          price: row.model.price.kind === "known" ? row.model.price : { kind: "subscription" },
          contextLength: row.model.contextLength,
        }),
      })),
  });
}

async function commitSelectableModelRoute(
  selected: SelectableModelRoute,
  context: CommandContext,
): Promise<string | null> {
  const runtime = context.providerRoutes!;
  const beforeRoute = runtime.currentSessionRoute?.();
  if (!beforeRoute) throw new ProviderSetupRequiredError();
  const afterRoute = selected.route;
  if (sameExactModelPreferenceRoute(beforeRoute, afterRoute)) return null;
  const configPath = resolveModelSelectionConfigPath(context);
  const expectedConfig = await readConfigEditSnapshot(configPath);
  const expectedSession = await readSessionEditSnapshot(context.session.path);
  const crossDisarmNotice = kimiCrossDisarmNoticeForPreference(expectedSession.data, afterRoute);
  const nextSession = prepareSessionPreferenceEdit(expectedSession, {
    requestedModelId: afterRoute.requestedModelId,
    reasoning: getReasoningSetting(expectedConfig.config, afterRoute.requestedModelId),
    route: afterRoute,
    ...(afterRoute.backendId === "kimi-code" ? { disarmCrossModeForKimi: true as const } : {}),
  });
  const sessionPublication = context.session.preparePreferencePublication(expectedSession, nextSession);
  const runtimePublication = runtime.prepareSettingsModelPublication!(afterRoute);
  let finalConfig: OrcodeConfigWithBudget | null = null;
  await runModelPreferenceTransaction({
    appHome: context.session.appHome,
    configPath,
    sessionPath: context.session.path,
    expectedConfig,
    nextConfig(nextProviderState) {
      const next = validateConfig({ ...structuredClone(expectedConfig.config), mainModel: afterRoute.requestedModelId, providerSetup: nextProviderState });
      finalConfig = next;
      return next;
    },
    expectedSession,
    nextSession,
    beforeRoute,
    afterRoute,
    routeAuthority: commandRouteAuthority(runtime, context.providerRouteSurface),
    publish() {
      Object.assign(context.config, finalConfig!);
      sessionPublication.publish();
      runtimePublication.publish();
    },
  });
  return crossDisarmNotice;
}

/** Exact path used by the atomic provider-aware model preference transaction. */
export function resolveModelSelectionConfigPath(
  context: Pick<CommandContext, "configPath">,
): string {
  return context.configPath ?? CONFIG_PATH;
}

function commandRouteAuthority(
  runtime: ProviderRouteIntentPort,
  surface?: SetupSurface | "plain" | "fullscreen",
): ModelPreferenceRouteAuthority {
  return createModelPreferenceRouteAuthorityBridge({
    read: () => runtime.readModelPreferenceAuthority!(),
    transition: (route, publication, forwardedSurface) =>
      runtime.transitionSessionRoute!(route, publication, forwardedSurface),
    surface,
    invalidError: () => new ProviderSetupRequiredError(),
  });
}

function runTransitionCatalog<T>(
  context: CommandContext,
  run: () => Promise<T>,
): Promise<T> {
  return context.providerRoutes?.runModelCatalog
    ? context.providerRoutes.runModelCatalog(run, context.providerRouteSurface)
    : run();
}

async function modelsCommand(args: string[], context: CommandContext): Promise<void> {
  const query = args.join(" ");
  if (currentCommandBackend(context) === "kimi-code") {
    if (!context.providerCommands) throw new Error("Kimi Code provider control is not available.");
    const result = await context.providerCommands.execute(
      { kind: "models", backendId: "kimi-code" },
      context.providerRouteSurface ?? "plain",
    );
    if (result.kind !== "models") throw new Error("Kimi Code models are not available.");
    const wanted = query.trim().toLowerCase();
    const models = result.models.filter((model) => !wanted
      || `${model.displayName} ${model.requestedModelId} ${model.canonicalModelId}`
        .toLowerCase().includes(wanted));
    context.out.text(models.length
      ? models.map((model) =>
          `${model.displayName} · ${model.requestedModelId} · ${model.canonicalModelId}`
        ).join("\n")
      // D5 invitation grammar: a typed search that matched nothing names the
      // recovery action (clear it); an empty catalog with no search typed is
      // a provider fact, not a search miss — no command hint would be honest
      // there, so it stays a plain statement.
      : wanted
        ? `No Kimi Code models matched "${query}" ${commandTheme(context).glyph("emdash")} /models with no search shows them all.`
        : "No usable Kimi Code models available.");
    return;
  }
  const models = mainModelCandidates(
    await context.openRouter.listModels(query, false),
  );
  if (!models.length) {
    context.out.text(
      query
        ? `No tool-capable models matched "${query}" ${commandTheme(context).glyph("emdash")} /models with no search shows them all.`
        : `No tool-capable models found ${commandTheme(context).glyph("emdash")} check the provider connection with /provider status.`,
    );
    return;
  }
  const theme = commandTheme(context);
  context.out.text(theme.color("text", { bold: true })(`Tool-capable models${query ? ` for "${query}"` : ""}`));
  for (const model of models.slice(0, 30)) {
    context.out.text(
      `${model.id.padEnd(52)} in ${formatPricePerMillion(model.promptPrice).padStart(11)} · out ${formatPricePerMillion(model.completionPrice).padStart(11)} · ctx ${contextLengthLabel(model.contextLength)}`,
    );
  }
  if (models.length > 30) {
    context.out.text(theme.color("muted")(`${models.length - 30} more; narrow down with /models <term>.`));
  }
}

// ---------------------------------------------------------------------------
// /undo — deliberately roll back the last completed run, reusing the exact
// same revert core (`undoInterruptedRun`) the crash path in resume.ts
// already relies on. Run discovery (`findLastCompletedRun`), the drift
// check, and the outcome formatting all come from resume.ts too; this
// function only orchestrates the confirmation and the surrounding
// commands.ts-level bookkeeping (session turn, runlog "undone" marker) a
// pure resume.ts function has no business doing itself.
// ---------------------------------------------------------------------------

async function undoCommand(context: CommandContext): Promise<void> {
  const local = commandLocalRuntime(context);
  const appHome = context.session.appHome;
  const chatId = context.session.data.id;

  const run = await findLastCompletedRun(appHome, chatId);
  // Cross guard: when the chat's newest run was a Cross run (its publication
  // timestamp, normalized to the run-id's sortable form, postdates the last
  // ordinary run — or no ordinary run exists at all), route to the Cross
  // branch (P10b) instead of misdescribing the situation as "nothing to
  // undo" or offering an older ordinary run under the "last run" title.
  const lastCrossRunAt = context.session.data.lastCrossRunAt;
  const crossIsNewest = typeof lastCrossRunAt === "string"
    && (run === null || run.runId < lastCrossRunAt.replace(/[:.]/g, "-"));
  if (crossIsNewest) {
    // P10b ruling 3, belt-and-suspenders: `identity.at` is checked against
    // the stamp even though no path reachable from `session.data` can
    // actually disagree today — `noteCrossRun` always writes both together,
    // `mergeSessions` (concurrent windows) drops BOTH fields together rather
    // than merging them independently (verified: neither is spread into its
    // returned object, so a merge can only ever leave both absent, never
    // mismatched), and a hand-edited file's mismatch is already caught by
    // `normalizeSession`'s own fail-closed check before `session.data` is
    // ever populated (see tests/session.test.ts). Kept anyway as cheap
    // insurance against a future regression in either of those guarantees —
    // fails closed to the exact same honest refusal as no identity at all,
    // never a revert against the wrong sidecar.
    const identity = context.session.data.lastCrossRun;
    if (!identity || identity.at !== lastCrossRunAt) {
      // FIX-10 M1 (honesty): /undo CAN revert Cross runs (undoCrossRun
      // below) — this branch fires only when the recorded sidecar identity
      // is missing or doesn't match its timestamp, so say that (the same
      // "Can't undo — …" wording family undoCrossRun's own refusals use),
      // never a fabricated capability gap.
      context.out.text(
        "Can't undo — the most recent run was a Cross run, but its sidecar identity is missing or doesn't match the recorded run, so nothing was reverted.",
      );
      return;
    }
    await undoCrossRun(context, local, identity);
    return;
  }
  if (!run) {
    context.out.text("No completed run to undo in this chat.");
    return;
  }
  if (run.undone) {
    context.out.text("Nothing to undo — the last run is already undone.");
    return;
  }

  // Boundary (ruling 3): honest and specific, no partial revert offer. A run
  // whose tracked files drifted since it ran is refused outright, before any
  // confirmation is even shown — not silently narrowed to "whatever still
  // matches".
  const drifted = run.fileDrift.filter((entry) => entry.status !== "matches");
  if (drifted.length > 0) {
    context.out.error(
      `Can't undo — ${pluralize(drifted.length, "file")} changed since the run, so nothing was reverted: ` +
        drifted.map((entry) => `${local.guard.display(entry.path)} (${driftLabel(entry.status)})`).join(", "),
    );
    return;
  }

  // Hydrating here (rather than only inside `undoInterruptedRun`, below) is
  // what lets the confirmation show the real diff before anything is
  // touched; `undoInterruptedRun`'s own hydrate is a harmless no-op repeat
  // (it dedupes by run id/path/createdAt).
  const entries = await local.journal.hydrateRun(run.runId);
  if (entries.length === 0) {
    context.out.text("No file change from this run found to undo.");
    return;
  }

  const summary = summarizeRun(run.events);
  const { title, details } = formatUndoConfirmation(
    entries,
    summary.tools,
    (path) => local.guard.display(path),
  );

  const accepted = await confirmUndoInContext(context, title, details);
  if (!accepted) {
    // Cancel-never-success: nothing happens, nothing is even reported.
    return;
  }

  const outcome = await undoInterruptedRun(local.journal, local.guard, context.approvals, run);
  await markRunUndone(appHome, chatId, run);
  const outcomeText = formatUndoOutcome(outcome);
  context.out.text(outcomeText);
  context.session.addTurn("assistant", `Run undone: ${outcomeText}`);
  await context.session.save();
}

/**
 * P10b (Phase-11 ruling 6 completion): the Cross branch of `/undo`. Exactly
 * the same discovery/drift/confirmation/revert machinery `undoCommand` above
 * uses for an ordinary run — `findLastCompletedRun`, `checkRunFileDrift` (via
 * `run.fileDrift`), `formatUndoConfirmation`, `undoInterruptedRun`,
 * `markRunUndone` — none of it changed for this call (Phase-11 report §5's
 * promise, held). The only two things that differ from the ordinary path:
 *
 * 1. Discovery and the "undone" marker target the LEAD's sidecar
 *    `(appHome, chatId)` (reconstructed from the recorded identity), not the
 *    main chat's — so a second `/undo` reads the SIDECAR's own marker.
 * 2. The revert itself runs against a fresh `ChangeJournal` scoped to that
 *    same sidecar identity (so it hydrates and clears the SIDECAR's own
 *    checkpoint, not the main chat's) — but `local.guard`/`context.approvals`
 *    are the MAIN chat's, unchanged, because the lead wrote into the REAL
 *    workspace through its own guard (verified: `createChatBinding`'s
 *    `ChangeJournal` only ever stores absolute paths, and the lead's own
 *    `WorkspaceGuard` is built from the live `context.workspace`, the same
 *    real workspace the main chat's guard already points at) — so drift
 *    checking, display paths, and the actual file writes/approvals all
 *    resolve correctly with zero path translation.
 */
async function undoCrossRun(
  context: CommandContext,
  local: Pick<CommandLocalRuntime, "guard" | "journal">,
  identity: LastCrossRunV1,
): Promise<void> {
  const sidecarAppHome = joinPath(context.session.appHome, "cross-sidecars", identity.sidecarId);
  const sidecarChatId = identity.chatId;

  const run = await findLastCompletedRun(sidecarAppHome, sidecarChatId);
  if (!run) {
    // Honest and specific (ruling 3): an identity IS on record, but its
    // sidecar has no completed run to show for it — either it never got
    // past the lead's first (possibly file-write-free) call before the
    // dispatch ended, or the sidecar's own log is gone/corrupt. Either way,
    // never a wrong-journal revert.
    context.out.text("Can't undo — the Cross run's sidecar record is missing or has no completed run.");
    return;
  }
  if (run.undone) {
    context.out.text("Nothing to undo — the last Cross run is already undone.");
    return;
  }

  const drifted = run.fileDrift.filter((entry) => entry.status !== "matches");
  if (drifted.length > 0) {
    context.out.error(
      `Can't undo — ${pluralize(drifted.length, "file")} changed since the run, so nothing was reverted: ` +
        drifted.map((entry) => `${local.guard.display(entry.path)} (${driftLabel(entry.status)})`).join(", "),
    );
    return;
  }

  // A fresh journal scoped to the SIDECAR identity — never `local.journal`
  // (the main chat's own, unrelated journal). `undoInterruptedRun` hydrates
  // it from the sidecar's persisted checkpoint and reverts through it, same
  // as the ordinary path.
  const sidecarJournal = new ChangeJournal({ appHome: sidecarAppHome, chatId: sidecarChatId });
  const entries = await sidecarJournal.hydrateRun(run.runId);
  if (entries.length === 0) {
    context.out.text("No file change from this Cross run found to undo.");
    return;
  }

  const summary = summarizeRun(run.events);
  const { title, details } = formatUndoConfirmation(
    entries,
    summary.tools,
    (path) => local.guard.display(path),
  );

  const accepted = await confirmUndoInContext(context, title, details);
  if (!accepted) {
    // Cancel-never-success: nothing happens, nothing is even reported.
    return;
  }

  const outcome = await undoInterruptedRun(sidecarJournal, local.guard, context.approvals, run);
  await markRunUndone(sidecarAppHome, sidecarChatId, run);
  const outcomeText = formatUndoOutcome(outcome);
  // Honest labeling (ruling 2): distinct from the ordinary path's "Run
  // undone: …" so the main chat never implies its OWN journal did anything —
  // the coding model's changes were reverted, but the run itself lived (and
  // stays recorded) entirely in the lead's sidecar.
  const label = "Cross run undone — the coding model's file changes were reverted.";
  context.out.text(`${label}\n${outcomeText}`);
  context.session.addTurn("assistant", `${label}\n${outcomeText}`);
  await context.session.save();
}

/**
 * Plain-mode fallback confirmation for `/undo` — Inquirer's `confirm()`,
 * guarded by the same TTY check the codebase already uses before any other
 * plain-mode secret/credential prompt (see `keyCommand` above). `/undo`
 * needs a real answer (Esc/decline must mean "nothing happens", never
 * "assume yes"), and Inquirer cannot produce one without a real terminal —
 * so a non-interactive caller (piped stdin, `-p`/`--json`) is refused
 * honestly instead of hanging or silently doing nothing (ruling 7).
 */
async function confirmUndoInContext(
  context: Pick<CommandContext, "confirm">,
  title: string,
  details: string,
): Promise<boolean> {
  // FIX-14 ticket 6: the confirmation itself is the one shared seam; only
  // this TTY guard is `/undo`-specific, and it applies exactly when there is
  // no surface modal to ask through.
  if (!context.confirm && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("undo requires an interactive session.");
  }
  return confirmInContext(context, { title, consequence: details }, { danger: true });
}

// ---------------------------------------------------------------------------
// /recover — review, continue, discard, or undo an interrupted previous run,
// reachable at any point in the session, not only at startup. Every actual
// effect (`buildResumePrompt`, `undoInterruptedRun`, `markRunReviewed`,
// `formatInterruptedRunNotice`, `formatUndoOutcome`) comes straight from
// resume.ts — the same functions cli.ts's own startup flow
// (`checkInterruptedRunPlain`/`checkInterruptedRunTui`) uses, so there is only
// ever one way an interrupted run gets recovered, discarded, or undone.
//
// This command used to be called `/resume`, which every peer CLI uses for
// "resume a conversation" — the single worst naming collision in the product
// (audit 2026-08-28). The semantics below are byte-identical to what
// `/resume` did; only the name moved, and `/resume` now resolves to the
// chats picker (see `command-catalog.ts`). resume.ts itself — the module,
// its functions, the run-log format — is deliberately untouched: this is a
// surface rename, not a machinery change.
// ---------------------------------------------------------------------------

async function recoverCommand(args: string[], context: CommandContext): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    context.out.text("No interrupted run found.");
    return;
  }
  const summary = summarizeRun(run.events);

  const theme = commandTheme(context);
  if (!sub) {
    context.out.text(formatInterruptedRunNotice(summary, run.fileDrift));
    context.out.text(
      theme.color("muted")(
        "Usage: /recover continue (prepend the summary to your next message) · " +
          "/recover undo (undo this run's file changes) · " +
          "/recover discard (stop reporting it, undo nothing)",
      ),
    );
    return;
  }

  if (sub === "undo") {
    // Mirrors the precondition `undoInterruptedRun` documents: hydrating a
    // journal that already holds this session's own, later entries would
    // make `undoLastRun`'s "last run" ambiguous (see resume.ts). At startup
    // that is guaranteed by construction; reachable mid-session as this
    // command is, it has to be checked explicitly instead.
    const local = commandLocalRuntime(context);
    if (local.journal.size > 0) {
      throw new Error(
        "/recover undo is only safe as long as this session hasn't made its own file change yet. " +
          "Use /undo for your own last run, or restart orcode to undo the interrupted run.",
      );
    }
    const outcome = await undoInterruptedRun(
      local.journal,
      local.guard,
      context.approvals,
      run,
    );
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    context.out.text(formatUndoOutcome(outcome));
    return;
  }

  if (sub === "discard") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    context.out.text("Discarded. This run's file changes remain as they are.");
    return;
  }

  if (sub === "continue") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    const prompt = buildResumePrompt(summary);
    if (context.seedNextMessage) {
      context.seedNextMessage(prompt);
      context.out.text(theme.color("muted")("Summary will be prepended to your next message."));
    } else {
      context.out.text(prompt);
    }
    return;
  }

  throw new Error("Usage: /recover [continue|undo|discard]");
}

// ---------------------------------------------------------------------------
// /panel — model panel: ask several models the same question in parallel and
// compare the answers. Core orchestration is `askPanel`/`synthesize` in
// panel.ts; this is just the interactive shell around it (proposal, cost
// preview, confirmation, rendering).
// ---------------------------------------------------------------------------

/**
 * `/panel <frage>` reuses the main-agent per-run cost limit
 * (`config.maxCostUsd`) as the panel's own budget guard rather than adding a
 * second, separately-configured limit — one number the user already knows
 * about, applied to "this one panel call" the same way it already applies to
 * "this one agent run".
 */
async function panelCommand(args: string[], context: CommandContext): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "models") {
    await panelModelsCommand(args.slice(1), context);
    return;
  }
  if (sub === "judge") {
    await panelJudgeCommand(args.slice(1), context);
    return;
  }
  if (sub === "show") {
    panelShowCommand(args.slice(1), context);
    return;
  }
  if (sub === "use") {
    panelUseCommand(args.slice(1), context);
    return;
  }
  // Anything else — including empty input — is treated as the question, the
  // same fallback `/verify` already uses for its literal-command case: a
  // small, fixed set of reserved words up front, free text after that.
  const question = args.join(" ").trim();
  if (!question) {
    printPanelStatus(context);
    return;
  }
  await panelAskCommand(question, context);
}

function printPanelStatus(context: CommandContext): void {
  const models = context.config.panelModels;
  const theme = commandTheme(context);
  context.out.text(
    models.length
      ? `Panel models: ${models.join(", ")}`
      : `Panel models: none configured ${theme.glyph("emdash")} /panel <question> suggests some from the catalog.`,
  );
  context.out.text(`Panel judge: ${context.config.panelJudge ? "on" : "off"}`);
  context.out.text(
    commandTheme(context).color("muted")(
      "Usage: /panel <question> · /panel models <a>,<b>,… · /panel judge on|off · /panel show <n> · /panel use <n>",
    ),
  );
}

async function panelModelsCommand(args: string[], context: CommandContext): Promise<void> {
  const raw = args.join(" ").trim();
  if (!raw) {
    // D5: mirrors `printPanelStatus`'s own "none configured" wording exactly
    // — same fact, same next action, one grammar for both call sites.
    const theme = commandTheme(context);
    context.out.text(
      context.config.panelModels.length
        ? `Panel models: ${context.config.panelModels.join(", ")}`
        : `No panel models configured ${theme.glyph("emdash")} /panel <question> suggests some from the catalog.`,
    );
    return;
  }
  const candidates = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const catalog = await context.openRouter.loadModels();
  const knownIds = catalog.flatMap((entry) =>
    entry.canonicalSlug ? [entry.id, entry.canonicalSlug] : [entry.id],
  );
  const selection = validatePanelModelSelection(candidates, knownIds);
  context.config.panelModels = selection;
  await saveContextConfig(context);
  context.out.text(commandTheme(context).color("ok")(`Panel models: ${selection.join(", ")}`));
}

async function panelJudgeCommand(args: string[], context: CommandContext): Promise<void> {
  const value = (args[0] ?? "").toLowerCase();
  if (!value) {
    context.out.text(`Panel judge: ${context.config.panelJudge ? "on" : "off"}`);
    return;
  }
  if (value !== "on" && value !== "off") {
    throw new Error("Usage: /panel judge on|off");
  }
  context.config.panelJudge = value === "on";
  await saveContextConfig(context);
  context.out.text(commandTheme(context).color("ok")(`Panel judge: ${context.config.panelJudge ? "on" : "off"}`));
}

function panelShowCommand(args: string[], context: CommandContext): void {
  const last = context.lastPanelResult;
  if (!last) {
    context.out.text(`No panel run yet this session ${commandTheme(context).glyph("emdash")} /panel <question> starts one.`);
    return;
  }
  const index = Number(args[0]);
  if (!Number.isInteger(index) || index < 1 || index > last.answers.length) {
    throw new Error(`Usage: /panel show <1-${last.answers.length}>`);
  }
  printPanelResult(context, last, context.lastPanelJudgment ?? null, index - 1);
}

/**
 * Hands one panel answer's text over to the normal chat as context. Seeded
 * into the next message via `context.seedNextMessage` — the exact same
 * mechanism cli.ts's interrupted-run "Fortsetzen" choice already uses
 * (`ui.insertInputText` in the fullscreen TUI, the plain loop's own
 * pending-seed variable otherwise) — never a second way of stuffing text into
 * the next turn. The answer's model is folded into the seeded text itself, so
 * the transcript later still shows where it came from.
 */
function panelUseCommand(args: string[], context: CommandContext): void {
  const last = context.lastPanelResult;
  if (!last) {
    context.out.text(`No panel run yet this session ${commandTheme(context).glyph("emdash")} /panel <question> starts one.`);
    return;
  }
  const index = Number(args[0]);
  if (!Number.isInteger(index) || index < 1 || index > last.answers.length) {
    throw new Error(`Usage: /panel use <1-${last.answers.length}>`);
  }
  const answer = last.answers[index - 1]!;
  if (answer.error || !answer.text.trim()) {
    throw new Error(`Answer ${index} (${answer.model}) has no usable text.`);
  }
  const seeded = `Answer from ${answer.model} (Panel):\n\n${answer.text.trim()}`;
  if (context.seedNextMessage) {
    context.seedNextMessage(seeded);
    context.out.text(
      commandTheme(context).color("muted")(`Answer ${index} (${answer.model}) will be prepended to the next message.`),
    );
  } else {
    context.out.text(seeded);
  }
}

/**
 * D5 fix round 1: `panelAskCommand`'s auto-suggestion notice, split into its
 * own pure function so its glyph routing is directly unit-testable — the
 * `/panel <question>` command it belongs to prompts for confirmation a few
 * lines later (via `confirmPlain` since D4; no injectable override),
 * which needs a real or injected-stdin TTY and hangs otherwise (see the
 * block comment above this file's `/panel` command test section); driving
 * this notice through `handleSlashCommand` end to end is exactly what that
 * comment already says this suite avoids. This was the fourth raw `—`
 * literal found in the panel command family (after `printPanelStatus`,
 * `panelModelsCommand`, `panelShowCommand`/`panelUseCommand`) — same
 * NO_COLOR/ASCII-parity defect, same `theme.glyph("emdash")` fix.
 */
export function panelAutoSuggestNotice(theme: Theme, models: readonly string[]): string {
  return `No panel configured ${theme.glyph("emdash")} suggestion from different providers: ${models.join(", ")}`;
}

async function panelAskCommand(question: string, context: CommandContext): Promise<void> {
  let models = context.config.panelModels;
  if (models.length < PANEL_MIN_MODELS) {
    const catalog = await context.openRouter.listModels("", false);
    const proposal = proposePanelModels(catalog, 3);
    if (proposal.length < PANEL_MIN_MODELS) {
      throw new Error(
        "Not enough distinct models in the catalog to suggest a panel. Set them manually with /panel models <a>,<b>,…",
      );
    }
    models = proposal.map((model) => model.id);
    const theme = commandTheme(context);
    context.out.text(theme.color("text", { bold: true })(panelAutoSuggestNotice(theme, models)));
    context.out.text(
      theme.color("muted")(`Make this permanent: /panel models ${models.join(",")}`),
    );
  }

  const catalog = await context.openRouter.loadModels();
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const promptChars = question.length;
  const estimateForModelAt = (model: string, chars: number): number | null => {
    const info = catalogById.get(model);
    return info ? estimatePanelModelCostUsd(modelCapabilities(info), chars) : null;
  };
  const estimateForModel = (model: string): number | null => estimateForModelAt(model, promptChars);
  // FIX-10 H2 (money honesty): when the judge is on, an accepted run also
  // books a synthesize() call on mainModel (see the `panelJudge` branch
  // below) — the confirm's estimate and copy must include that call, priced
  // through the same estimator as the panelists.
  // Fix round 1 (F4): the judge's input is buildJudgePrompt (question +
  // every panel answer), not the bare question — price it at question chars
  // plus N × the panelists' own output allowance, using the exact constants
  // the per-call estimator already assumes (PANEL_ESTIMATE_OUTPUT_TOKENS ×
  // CHARS_PER_TOKEN, utils.ts — FIX-14 ticket 4 merged openrouter.ts's own
  // PANEL_CHARS_PER_TOKEN into that one declaration) — same estimator, same ratio,
  // honest input size instead of a consent-point understatement.
  const judgeModel = context.config.panelJudge ? context.config.mainModel : null;
  const judgePromptChars = promptChars
    + models.length * PANEL_ESTIMATE_OUTPUT_TOKENS * CHARS_PER_TOKEN;
  const estimate = estimatePanelRun(
    models,
    judgeModel,
    estimateForModel,
    (model) => estimateForModelAt(model, judgePromptChars),
  );
  const judgeSuffix = estimate.judge ? ` + 1 judging call on ${estimate.judge.model}` : "";

  // Fix round 1 (F9): with the judge suffix present, "× estimated" no
  // longer reads sensibly after it — the judge-on line drops it and lets
  // "≈" carry the estimate hedge; the judge-off line stays byte-identical
  // to its pre-H2 form.
  context.out.text(
    `${pluralize(models.length, "model")}${estimate.judge ? `${judgeSuffix} ≈ ` : " × estimated ≈ "}${formatUsd(estimate.totalUsd)} total${
      estimate.unknownCount > 0
        ? ` (price for ${pluralize(estimate.unknownCount, "model")} unknown, not included)`
        : ""
    }.`,
  );
  for (const entry of estimate.perModelUsd) {
    context.out.text(
      `  ${entry.model.padEnd(40)} ${entry.usd === null ? "Price unknown" : formatUsd(entry.usd)}`,
    );
  }
  if (estimate.judge) {
    context.out.text(
      `  ${`${estimate.judge.model} (judge)`.padEnd(40)} ${estimate.judge.usd === null ? "Price unknown" : formatUsd(estimate.judge.usd)}`,
    );
  }

  // D4: ordinary (not destructive) but keeps the existing documented
  // default: false — this spends real money across every selected model,
  // and the cost breakdown just printed above deserves an explicit yes.
  const confirmTitle = `Query ${pluralize(models.length, "model")} in parallel${judgeSuffix} (≈ ${formatUsd(estimate.totalUsd)})?`;
  const proceed = await confirmInContext(context, { title: confirmTitle }, { defaultAccept: false });
  if (!proceed) {
    context.out.text("Panel cancelled.");
    return;
  }

  const callModel = context.panelCall ?? createPanelCall(context.openRouter);
  let result: PanelResult;
  try {
    result = await askPanel({
      question,
      models,
      callModel,
      maxCostUsd: context.config.maxCostUsd,
      estimateCostUsd: estimateForModel,
    });
  } catch (error) {
    if (
      error instanceof PanelAuthenticationRejectedError
      && error.partialResult
    ) {
      context.session.addCost("main", error.partialResult.totalCostUsd);
      context.lastPanelResult = error.partialResult;
      await context.session.save();
    }
    throw error;
  }
  // Counted as "main" spend so it counts toward the workspace budget
  // (/budget) like every other model call — the session type has no
  // dedicated "panel" cost category, and adding one is out of scope here.
  context.session.addCost("main", result.totalCostUsd);
  context.lastPanelResult = result;

  let judgment: PanelJudgment | null = null;
  if (context.config.panelJudge) {
    try {
      judgment = await synthesize({
        question,
        answers: result.answers,
        judgeModel: context.config.mainModel,
        callModel,
      });
      context.session.addCost("main", judgment.costUsd);
    } catch (error) {
      if (error instanceof PanelAuthenticationRejectedError) {
        context.lastPanelJudgment = null;
        await context.session.save();
        throw error;
      }
      context.out.text(commandTheme(context).color("warn")(`Judging skipped: ${errorMessage(error)}`));
    }
  }
  context.lastPanelJudgment = judgment;
  await context.session.save();

  printPanelResult(context, result, judgment, null);
}

function printPanelResult(
  context: CommandContext,
  result: PanelResult,
  judgment: PanelJudgment | null,
  expandedIndex: number | null,
): void {
  if (context.onPanelResult) {
    // Fullscreen TUI: render as its own block (src/ui/blocks.ts) instead of
    // flattening the result into command-output text — see src/tui.ts's
    // `addPanelResult`.
    context.onPanelResult(result, judgment, expandedIndex);
  } else {
    // F4 review's ascii gap (ruling 5): `context` is reachable here, so the
    // configured glyph mode reaches `renderPanel`'s box-drawing glyphs the
    // same way the fullscreen TUI's theme does, instead of always Unicode.
    const theme = commandTheme(context);
    const width = Math.max(40, Math.min(process.stdout.columns || 100, 120));
    const lines = renderPanel(result, width, theme, { expandedIndex, judgment });
    for (const line of renderLines(lines, theme)) {
      context.out.text(line);
    }
  }
  if (expandedIndex === null && result.answers.length > 0) {
    context.out.text(
      commandTheme(context).color("muted")(`View the full answer: /panel show <1-${result.answers.length}>`),
    );
  }
}

async function reasoningCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const model = currentCommandBackend(context) === "kimi-code"
    ? kimiCommandModel(context.config.mainModel)
    : await findCurrentModel(context.openRouter, context.config.mainModel);
  const current = getReasoningSetting(context.config);
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      `Thinking for ${context.config.mainModel}: ${reasoningLabel(current)}`,
    );
    if (model?.reasoning?.supportedEfforts) {
      context.out.text(
        `Supported levels: ${model.reasoning.supportedEfforts.join(", ")}`,
      );
    } else if (
      model &&
      !model.id.startsWith("openrouter/") &&
      !model.supportedParameters.includes("reasoning")
    ) {
      context.out.text("This model reports no reasoning support.");
    } else {
      context.out.text(`Gateway levels: ${REASONING_EFFORTS.join(", ")}`);
    }
    if (model?.reasoning?.supportsMaxTokens || model?.id.startsWith("openrouter/")) {
      context.out.text("Token budget is supported: /think budget <tokens>");
    }
    return;
  }

  let setting: ReasoningSetting;
  if (action === "auto") {
    setting = { mode: "auto" };
  } else if (action === "off") {
    setting = { mode: "effort", effort: "none" };
  } else if (action === "budget") {
    const maxTokens = Number(args[1]);
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < 256 ||
      maxTokens > 1_000_000
    ) {
      throw new Error(
        "Thinking budget must be a whole number between 256 and 1000000 tokens.",
      );
    }
    setting = { mode: "budget", maxTokens };
  } else {
    const effort = normalizeReasoningEffort(action);
    if (!effort) {
      throw new Error(
        `Usage: /think auto|off|${REASONING_EFFORTS.filter((value) => value !== "none").join("|")} | /think budget <tokens>`,
      );
    }
    setting = { mode: "effort", effort };
  }
  validateReasoningSetting(setting, model);
  setReasoningSetting(context.config, setting);
  context.session.setPreferences(context.config.mainModel, setting);
  await Promise.all([saveContextConfig(context), context.session.save()]);
  context.out.text(
    commandTheme(context).color("ok")(
      `Thinking for ${context.config.mainModel}: ${reasoningLabel(setting)}`,
    ),
  );
}

function kimiCommandModel(modelId: string): ModelInfo | null {
  const model = KIMI_CODE_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) return null;
  return {
    id: model.id,
    canonicalSlug: model.id,
    name: model.displayName,
    description: "Kimi Code membership model",
    contextLength: model.effectiveContextDefault,
    promptPrice: -1,
    completionPrice: -1,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: {
      defaultEffort: "high",
      defaultEnabled: true,
      mandatory: true,
      supportedEfforts: model.reasoningEfforts === null ? null : [...model.reasoningEfforts],
      supportsMaxTokens: false,
    },
  };
}

async function approvalCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "list") {
    const rules = context.ruleStore.list(context.workspace);
    if (!rules.length) {
      context.out.text("No remembered rules for this folder.");
      return;
    }
    for (const rule of rules) {
      const subject = rule.match.kind === "exact-subject"
        ? rule.match.display
        : `(disabled: ${rule.match.reason})`;
      context.out.text(
        `${rule.decision === "allow" ? theme.color("ok")("allow") : theme.color("danger")("deny")} ${theme.color("muted")(rule.tool)} ${subject}${theme.glyph("separator")}${rule.id.slice(0, 8)}`,
      );
    }
    return;
  }
  if (sub === "forget") {
    const target = (args[1] ?? "").toLowerCase();
    if (!target) {
      throw new Error("Usage: /allow forget <id>|all");
    }
    if (target === "all") {
      const rules = context.ruleStore.list(context.workspace);
      for (const rule of rules) {
        await context.ruleStore.forget(rule.id);
      }
      context.out.text(
        theme.color("ok")(`${pluralize(rules.length, "rule")} forgotten for this folder.`),
      );
      return;
    }
    const rules = context.ruleStore.list(context.workspace);
    const match = rules.find((rule) => rule.id === target || rule.id.startsWith(target));
    if (!match) {
      context.out.text(`No rule with ID "${target}" in this folder.`);
      return;
    }
    await context.ruleStore.forget(match.id);
    context.out.text(theme.color("ok")(`Rule forgotten: ${match.id.slice(0, 8)}`));
    return;
  }
  const mode = sub;
  if (!mode) {
    for (const candidate of APPROVAL_MODES) {
      context.out.text(
        // Which mode is live right now, not "this succeeded" — the theme's
        // `active` role is the dedicated live/selected-state marker (matches
        // the same ● pattern in /chat list and /chat search below), not `ok`.
        //
        // FIX-14 ticket 8: both marks come from the theme now (`bullet` /
        // `bulletOff`). The inactive one used to be a raw `○` literal beside
        // a themed `●`, so ASCII glyph mode asciified exactly half the pair.
        `${candidate === context.approvals.mode ? theme.color("active")(theme.glyph("bullet")) : theme.glyph("bulletOff")} ${candidate}: ${approvalDescription(candidate)}`,
      );
    }
    return;
  }
  if (!isApprovalMode(mode)) {
    throw new Error(`Invalid approval mode. Allowed: ${APPROVAL_MODES.join(", ")}`);
  }
  if (mode === "allow-all") {
    // FIX-14 ticket 6: through the shared seam, so the fullscreen surface
    // gets its modal here too — this call reached Inquirer directly before,
    // inside a raw-mode TUI.
    const accepted = await confirmInContext(
      context,
      { title: "allow-all runs file changes and shell commands without asking. Really enable it?" },
      { danger: true },
    );
    if (!accepted) {
      context.out.text("Approval mode unchanged.");
      return;
    }
  }
  context.approvals.mode = mode;
  context.config.approvalMode = mode;
  await saveContextConfig(context);
  context.out.text(theme.color("ok")(`Approval mode: ${mode}`));
}

async function chatCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const theme = commandTheme(context);
  const action = (args[0] ?? "").toLowerCase();
  const migratedConnection = authoritativeMigratedSessionConnection(context);
  if (!action) {
    // The global index (Phase F1b): current folder's chats first, then every
    // other known folder's, most-recent first within each — one enumeration
    // reused for both sections, never a second "current workspace only" query.
    const allChats = await listChatsAcrossWorkspaces(context.session.appHome, migratedConnection);
    const chatById = new Map(allChats.map((chat) => [chat.id, chat]));
    const home = homedir();
    // Phase F3 (information-dense pickers), ruling 2: `<n> messages ·
    // $<cost> · <model short> · <relative time>`, reusing the exact
    // `/chats` cost formatter (`formatChatCost`), model shortener
    // (`shortModelName`, the status line's own) and relative-time helper
    // (`relativeAge`) the fullscreen picker's `chatChoice` (`cli.ts`) uses —
    // one wording for the same chat, never two. F1b's foreign-folder suffix
    // stays appended last, untouched.
    // FIX-14 ticket 8: `formatChatRow` (utils.ts) — the SAME composer the
    // fullscreen picker's `chatChoice` (cli.ts) and the start hub's "Recent"
    // rows already use. This used to be a hand-rolled second copy of that
    // exact row (message count, cost, short model, relative age, foreign
    // folder) whose separators were raw `·` literals, so the plain picker
    // kept leaking a non-ASCII byte in ASCII glyph mode and could drift
    // from the fullscreen picker's wording at any time.
    const toChoice = (chat: CrossWorkspaceChat, foreign: boolean): PlainListChoice<string> => {
      const folder = !foreign
        ? undefined
        : chat.workspaceVerified
          ? abbreviateHome(chat.workspace, home)
          : "unknown folder";
      const { label, description } = formatChatRow(
        chat,
        Date.parse(chat.updatedAt),
        folder,
        theme.glyph("separator"),
      );
      return {
        name: label,
        value: chat.id,
        current: chat.id === context.session.data.id,
        description,
      };
    };
    const sections: ListSection[] = [
      {
        heading: "Current folder",
        entries: allChats
          .filter((chat) => chat.workspace === context.workspace)
          .map((chat) => toChoice(chat, false)),
      },
      {
        heading: "Other folders",
        entries: allChats
          .filter((chat) => chat.workspace !== context.workspace)
          .map((chat) => toChoice(chat, true)),
      },
    ];
    const choices: PlainListChoice<string>[] = [
      {
        // K11 (FIX-5 ruling 5): plain ASCII `+`, matching theme.ts's `plus`
        // glyph pair — the FULLWIDTH `＋` measured two cells and bled the row.
        // The plain picker is theme-less by design, and the glyph resolves to
        // this same byte in both charsets.
        name: "+ New Chat",
        value: "__new__",
        description: "Start a fresh, detached chat",
      },
      ...(withListSections(sections) as unknown as PlainListChoice<string>[]),
    ];
    const selected = await pickFromListPlain<string>(
      // FIX-11: one name for the chat list on both surfaces — the
      // fullscreen dashboard picker (cli.ts's `runChatPicker`) titles the
      // very same screen `Chats · <folder>`.
      { title: `Chats${theme.glyph("separator")}${basename(context.workspace)}`, choices },
      context.chatPickerIo,
    );
    if (selected === null) {
      printCurrentChat(context.session, context.out);
      return;
    }
    if (selected === "__new__") {
      await replaceSession(
        context,
        SessionStore.create(context.workspace, context.session.appHome),
      );
      printCurrentChat(context.session, context.out);
      return;
    }
    if (selected === context.session.data.id) {
      printCurrentChat(context.session, context.out);
      return;
    }
    const target = chatById.get(selected);
    if (target && target.workspace !== context.workspace) {
      if (!target.workspaceVerified) {
        context.out.error(
          `"${target.title}" has no folder orcode can trust — it cannot be reopened from here.`,
        );
        return;
      }
      const outcome = await reRootCommandWorkspace(context, target.workspace);
      if (!outcome.ok) {
        context.out.error(outcome.message);
        if (outcome.reason === "not-found" || outcome.reason === "not-a-directory") {
          const remove = await confirmInContext(
            context,
            {
              title: STALE_CHAT_DELETE_TITLE,
              consequence: staleChatDeleteDetails(target.title, target.workspace),
            },
            { danger: true },
          );
          if (remove) {
            const deletion = await SessionStore.remove(target.workspace, target.id, context.session.appHome);
            if (deletion.errors.length > 0) {
              context.out.error(
                "Stale entry could not be fully removed.",
                deletion.errors.map((error) => `${error.path}: ${error.message}`).join("\n"),
              );
            } else {
              context.out.text(`Stale entry removed: ${target.title}`);
            }
          }
        }
        return;
      }
      if (outcome.homeWarning) {
        context.out.text(theme.color("warn")(outcome.homeWarning));
      }
    }
    await replaceSession(
      context,
      await SessionStore.openById(
        context.workspace,
        selected,
        context.session.appHome,
        migratedConnection,
      ),
    );
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "list") {
    const chats = await SessionStore.list(
      context.workspace,
      context.session.appHome,
      migratedConnection,
    );
    if (!chats.length) {
      // D5 invitation grammar: what's empty, plain words, then the one next
      // action as a command hint — `/new` is the same action the bare
      // `/chat` picker's always-present "+ New Chat" row performs, so the
      // plain non-interactive `list` action names it explicitly instead of
      // leaving a dead end.
      context.out.text(`No saved chats in this folder yet ${theme.glyph("emdash")} /new starts one.`);
      return;
    }
    for (const chat of chats) {
      // Live/selected-state marker (same reasoning as the approval-mode ●
      // above): `active`, not `ok` — this is not a success signal.
      const marker = chat.id === context.session.data.id
        ? theme.color("active")(theme.glyph("bullet"))
        : theme.glyph("bulletOff");
      const sep = theme.glyph("separator");
      context.out.text(
        `${marker} ${chat.title}${sep}${formatMessageCount(chat.turnCount)}${sep}`
        + `${formatChatCost(chat, sep)}${sep}${formatChatDate(chat.updatedAt)}${sep}${chat.id}`,
      );
    }
    return;
  }

  if (action === "current") {
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "new") {
    const title = args.slice(1).join(" ").trim() || "New Chat";
    await replaceSession(
      context,
      SessionStore.create(context.workspace, context.session.appHome, title),
    );
    announceNewChat(context.out);
    return;
  }

  if (action === "rename") {
    const title = args.slice(1).join(" ").trim();
    if (!title) {
      throw new Error("Usage: /chat rename <title>");
    }
    context.session.rename(title);
    await context.session.save();
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "fork") {
    await saveSessionPreferences(context);
    const title = args.slice(1).join(" ").trim() ||
      `${context.session.data.title} (Fork)`;
    await replaceSession(context, await context.session.fork(title));
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "open" || action === "switch") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Usage: /chat open <ID or title>");
    }
    const chats = await SessionStore.list(
      context.workspace,
      context.session.appHome,
      migratedConnection,
    );
    const matches = rankChatMatches(chats, query);
    if (!matches.length) {
      throw new Error(`No chat found: ${query}`);
    }
    const best = matches[0]!;
    const contested = matches.length > 1 && matches[1]!.score === best.score;
    if (!contested) {
      await replaceSession(
        context,
        await SessionStore.openById(
          context.workspace,
          best.chat.id,
          context.session.appHome,
          migratedConnection,
        ),
      );
      printCurrentChat(context.session, context.out);
      return;
    }
    if (!process.stdout.isTTY) {
      throw new Error(
        `Chat selection is ambiguous: ${matches.map((match) => match.chat.title).join(", ")}`,
      );
    }
    const selected = await pickFromListPlain<string>({
      title: `Multiple chats match "${query}"`,
      choices: matches.map((match) => ({
        name: match.chat.title,
        value: match.chat.id,
        current: match.chat.id === context.session.data.id,
        description: `${formatMessageCount(match.chat.turnCount)}${theme.glyph("separator")}`
          + `${formatChatCost(match.chat, theme.glyph("separator"))}${theme.glyph("separator")}`
          + `${formatChatDate(match.chat.updatedAt)}${theme.glyph("separator")}${match.chat.id}`,
      })),
    });
    if (selected === null) {
      printCurrentChat(context.session, context.out);
      return;
    }
    if (selected !== context.session.data.id) {
      await replaceSession(
        context,
        await SessionStore.openById(
          context.workspace,
          selected,
          context.session.appHome,
          migratedConnection,
        ),
      );
    }
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Usage: /chat search <search term>");
    }
    const hits = await SessionStore.search(
      context.workspace,
      query,
      context.session.appHome,
      migratedConnection,
    );
    if (!hits.length) {
      // D5 invitation grammar: an empty search result names the one next
      // action too — clearing the search via `/chat list` shows every chat.
      context.out.text(`No chats matched "${query}" ${theme.glyph("emdash")} /chat list shows them all.`);
      return;
    }
    const shown = hits.slice(0, 10);
    for (const hit of shown) {
      const marker = hit.chat.id === context.session.data.id
        ? theme.color("active")(theme.glyph("bullet"))
        : theme.glyph("bulletOff");
      const sep = theme.glyph("separator");
      context.out.text(
        `${marker} ${hit.chat.title}${sep}${formatMessageCount(hit.chat.turnCount)}${sep}`
        + `${formatChatCost(hit.chat, sep)}${sep}${formatChatDate(hit.chat.updatedAt)}${sep}${hit.chat.id}`,
      );
      if (hit.snippet) {
        context.out.text(`  ${theme.color("muted")(hit.snippet)}`);
      }
    }
    if (hits.length > shown.length) {
      context.out.text(theme.color("muted")(`… and ${hits.length - shown.length} more match(es).`));
    }
    context.out.text(theme.color("muted")("Open with /chat open <ID or title>"));
    return;
  }

  if (action === "delete" || action === "rm") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Usage: /chat delete <ID or title>");
    }
    const chats = await SessionStore.list(
      context.workspace,
      context.session.appHome,
      migratedConnection,
    );
    const matches = rankChatMatches(chats, query);
    if (!matches.length) {
      throw new Error(`No chat found: ${query}`);
    }
    const best = matches[0]!;
    const contested = matches.length > 1 && matches[1]!.score === best.score;
    if (contested) {
      // Deletion is final — never guess here, not even interactively.
      throw new Error(
        `Delete cancelled, selection is ambiguous: ${matches.map((match) => match.chat.title).join(", ")}`,
      );
    }
    const target = best.chat;
    const wasActive = target.id === context.session.data.id;
    // FIX-14 ticket 6: one question. Plain mode used to ask a single long
    // sentence with the id inline; fullscreen asked the short question with
    // the id and the artifact list underneath. The second shape survives.
    const accepted = await confirmInContext(
      context,
      {
        title: `Permanently delete chat "${target.title}"?`,
        consequence: `Chat ID: ${target.id}\nTranscript, SDK state, run logs, checkpoints, journals, and task sidecars will be deleted.`,
      },
      { danger: true },
    );
    if (!accepted) {
      context.out.text("Chat unchanged; deletion cancelled.");
      return;
    }
    const deletion = await SessionStore.remove(context.workspace, target.id, context.session.appHome);
    if (deletion.errors.length > 0) {
      context.out.error(
        "Chat could not be fully deleted; the transcript is kept for a safe retry.",
        deletion.errors.map((error) => `${error.path}: ${error.message}`).join("\n"),
      );
      return;
    }
    if (wasActive) {
      // Otherwise the next auto-save would recreate the deleted file.
      await replaceDeletedSession(context, SessionStore.create(context.workspace, context.session.appHome));
    }
    context.out.text(
      `Chat permanently deleted: ${target.title} (${target.id})${wasActive ? " — started a new empty chat." : ""}`,
    );
    return;
  }

  throw new Error(
    "Usage: /chat [list|new [title]|open <ID|title>|search <term>|rename <title>|fork [title]|delete <ID|title>|current]",
  );
}

/** The one wording for "`/folder` was given something it cannot use". */
const FOLDER_USAGE = "Usage: /folder open <path> | /folder new <path>";

/**
 * `~`/`~/…` expansion plus workspace-relative resolution — the "validated-
 * input with `~` expansion" fallback the brief allows: the existing `@`-file
 * completion (`tui.ts`) only ever lists *files inside the current workspace*
 * for the model to read, so it does not fit picking an arbitrary folder
 * (often outside the current workspace) to re-root into. Shared verbatim by
 * bare `/folder`'s prompted path and by `open`/`new`'s argument (FIX-8).
 */
function resolveFolderInput(input: string, workspace: string): string {
  let value = input.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value === "~") {
    value = homedir();
  } else if (value.startsWith("~/")) {
    value = joinPath(homedir(), value.slice(2));
  }
  if (!value) {
    throw new Error(FOLDER_USAGE);
  }
  return isAbsolute(value) ? resolvePath(value) : resolvePath(workspace, value);
}

/**
 * What the owner already told `/folder` about the target, which is the ONLY
 * thing that differs between its three entry points: `open` promises the
 * folder exists, `new` promises it does not, and bare `/folder` (FIX-8)
 * promises neither and accepts whichever it finds. Everything after that —
 * the stat, the create confirmation, the re-root, the session handoff — is
 * one shared flow (`switchWorkspaceFolder`), never a second implementation.
 */
type FolderIntent = "open" | "new" | "either";

/**
 * The one stat `/folder` does. Both pre-FIX-8 branches are preserved
 * exactly: a permission failure is reported as such rather than as an
 * honest-sounding but false "does not exist" (F1b fix round 1, MINOR 10),
 * `open` treats every other failure as "no folder there", and `new` — which
 * is about to create something — surfaces any other failure as-is instead
 * of guessing. Bare `/folder` may create, so it follows `new`.
 */
async function statFolderTarget(
  resolved: string,
  intent: FolderIntent,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(resolved);
  } catch (error) {
    if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
      throw new Error(`Permission denied: ${resolved}`);
    }
    if (intent !== "open" && !hasCode(error, "ENOENT")) throw error;
    return null;
  }
}

/**
 * FIX-8: bare `/folder`'s one path question, asked through the existing
 * `validated-input` machinery (`ui.readPath`) or Inquirer in the plain loop.
 *
 * The current folder rides in the prompt's own description rather than being
 * printed first: the fullscreen surface buffers `out` until the command
 * returns, so a printed line would land *after* the question instead of
 * before it. The copy names `~` support because there is no path completion
 * yet (F2.3 residue) — typing a full path is still the only way.
 *
 * Returns the raw typed text, or `null` for every form of "no answer" —
 * cancelled, or empty.
 */
async function readFolderPath(context: CommandContext): Promise<string | null> {
  const request = {
    label: "Folder",
    description: `Now: ${abbreviateHome(context.workspace, homedir())} · type a path (~ works). An existing folder is opened; a new one is created after one confirmation.`,
  };
  let typed: string | null;
  if (context.promptFolderPath) {
    typed = await context.promptFolderPath(request);
  } else if (process.stdin.isTTY) {
    typed = await promptLine({ message: `${request.label} — ${request.description}` });
  } else {
    // Nobody to ask: keep the pre-FIX-8 answer for a non-interactive run.
    throw new Error(FOLDER_USAGE);
  }
  const value = typed?.trim() ?? "";
  return value === "" ? null : value;
}

/**
 * `/folder`: an owner command to change or create the workspace from inside
 * the TUI (Phase F1b, FIX-8). Three entry points, one flow —
 * `open <path>`/`new <path>` pre-fill the path and pin the expectation,
 * bare `/folder` asks for the path and accepts either outcome.
 */
async function folderCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  if (args.length === 0) {
    const typed = await readFolderPath(context);
    if (typed === null) {
      // Esc/Ctrl+C/empty: say so, and mutate nothing.
      context.out.text("Folder unchanged.");
      return;
    }
    await switchWorkspaceFolder(
      resolveFolderInput(typed, context.workspace),
      "either",
      context,
    );
    return;
  }
  const action = (args[0] ?? "").toLowerCase();
  if (action !== "open" && action !== "new") {
    throw new Error(FOLDER_USAGE);
  }
  const rawPath = args.slice(1).join(" ").trim();
  if (!rawPath) {
    throw new Error(`Usage: /folder ${action} <path>`);
  }
  await switchWorkspaceFolder(
    resolveFolderInput(rawPath, context.workspace),
    action,
    context,
  );
}

/**
 * The shared tail every `/folder` entry point runs. Shares
 * `reRootCommandWorkspace` with the foreign-`/chats`-pick path above — one
 * re-root, not two implementations — and reuses `replaceSession` (the same
 * session-handoff every other `/chat` mutation already goes through) once
 * the switch itself succeeds.
 */
async function switchWorkspaceFolder(
  resolved: string,
  intent: FolderIntent,
  context: CommandContext,
): Promise<void> {
  const info = await statFolderTarget(resolved, intent);
  if (info && !info.isDirectory()) {
    // `open`'s pre-FIX-8 wording for a non-directory target is kept verbatim.
    throw new Error(
      intent === "open"
        ? `Folder does not exist: ${resolved}`
        : `Not a folder: ${resolved}`,
    );
  }
  if (info) {
    if (intent === "new") {
      throw new Error(`Folder already exists — use /folder open ${resolved} instead.`);
    }
  } else {
    if (intent === "open") {
      throw new Error(`Folder does not exist: ${resolved}`);
    }
    // D4 danger class, unchanged: one explicit confirmation showing the
    // exact absolute path before anything is created.
    // FIX-14 ticket 6: one question, and the path goes in the consequence
    // where a long absolute path belongs — plain mode used to inline it in
    // the title while fullscreen already had this shape.
    const accepted = await confirmInContext(
      context,
      { title: "Create this folder?", consequence: resolved },
      { danger: true },
    );
    if (!accepted) {
      context.out.text("Folder unchanged; nothing created.");
      return;
    }
    await mkdir(resolved, { recursive: true });
  }

  const outcome = await reRootCommandWorkspace(context, resolved);
  if (!outcome.ok) {
    context.out.error(outcome.message);
    return;
  }
  const theme = commandTheme(context);
  if (outcome.homeWarning) {
    context.out.text(theme.color("warn")(outcome.homeWarning));
  }
  const migratedConnection = authoritativeMigratedSessionConnection(context);
  await replaceSession(
    context,
    await SessionStore.open(context.workspace, context.session.appHome, migratedConnection),
  );
  context.out.text(theme.color("ok")(`Folder switched: ${context.workspace}`));
  printCurrentChat(context.session, context.out);
}

function authoritativeMigratedSessionConnection(
  context: CommandContext,
): ProviderConnectionStateV3 | undefined {
  const runtimeProjection = context.providerRoutes?.migratedSessionConnection;
  if (runtimeProjection) {
    return runtimeProjection.call(context.providerRoutes);
  }
  return context.config === undefined
    ? undefined
    : migratedOpenRouterSessionConnection(context.config.providerSetup);
}

/**
 * FIX-20, finding 10: what a stale-entry cleanup actually does.
 *
 * It read "Remove stale entry?" over "<title> belongs to a folder that no
 * longer exists: <path>" — which describes bookkeeping, not the file
 * deletion it performs. The entry IS the chat: accepting deletes the chat's
 * file and the conversation with it, permanently.
 *
 * Shared by both surfaces (the fullscreen confirm and the plain Inquirer
 * fallback) so the two cannot drift into describing the same irreversible
 * action differently.
 */
export const STALE_CHAT_DELETE_TITLE = "Delete this chat permanently?";

/**
 * The explanation, as separate short lines rather than one long sentence.
 *
 * Approval details are fitted per line with an ellipsis (`render-block.ts`'s
 * `body`), so a single long line loses its tail first — which is exactly
 * where the consequence used to sit. Each line here fits inside the
 * supported 40-column floor, so the two that carry the actual reason always
 * survive intact; only the chat title and the folder path (data, not
 * reason) can ever be cut.
 */
export function staleChatDeleteDetails(title: string, workspace: string): string {
  return [
    "Deletes this chat's file permanently.",
    "The conversation cannot be recovered.",
    `Chat: ${title}`,
    "Its folder no longer exists:",
    workspace,
  ].join("\n");
}

async function replaceDeletedSession(
  context: CommandContext,
  next: SessionStore,
): Promise<void> {
  const route = readableCommandSessionRoute(context, false);
  if (route) {
    context.config.mainModel = route.requestedModelId;
  }
  commitCommandSessionHandoff(context, next);
  next.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
    route,
  );
  await Promise.all([next.save(), saveContextConfig(context)]);
}

async function replaceSession(
  context: CommandContext,
  next: SessionStore,
): Promise<void> {
  const previousRoute = readableCommandSessionRoute(context);
  let selectedRoute = readableCommandSessionRoute(context, false);
  if (next.data.routeCleared) {
    // A provider lifecycle action deliberately detached this chat. Opening it
    // must not inherit the current chat's route or trigger a model transition.
    selectedRoute = undefined;
  } else if (next.data.route?.resolutionState === "resolved") {
    if (!context.providerRoutes?.selectSessionRoute) {
      throw new ProviderSetupRequiredError();
    }
    selectedRoute = await context.providerRoutes.selectSessionRoute(
      next.data.route,
      context.providerRouteSurface,
    );
  } else if (next.data.model && next.data.model !== context.config.mainModel) {
    await context.providerRoutes?.transitionModel(
      next.data.model,
      undefined,
      context.providerRouteSurface,
    );
    selectedRoute = readableCommandSessionRoute(context, false) ?? next.data.route;
  }
  if (context.session.data.id !== next.data.id) {
    await saveSessionPreferences(context, previousRoute);
  }
  commitCommandSessionHandoff(context, next);
  if (selectedRoute) context.config.mainModel = selectedRoute.requestedModelId;
  if (!selectedRoute && next.data.model) {
    context.config.mainModel = next.data.model;
  }
  if (next.data.reasoning) {
    setReasoningSetting(context.config, next.data.reasoning);
  }
  // The one handoff above keeps provider/runtime/session ownership exact while
  // reusing the cached model resolution, compressor price cache, and journal.
  next.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
    selectedRoute,
  );
  // D8c/FIX-20 finding 7: a chat file appears when the chat has something in
  // it, not when it is created. `SessionStore.create()` is lazy by design and
  // both interactive loops' exit-time saves already honour that through
  // `isUntouched` — this eager save was the one place that did not, so every
  // `/new` wrote a permanent "New Chat" file whether or not a word was ever
  // said in it, and repeated `/new` accumulated one ghost each. The first
  // save with real content behind it writes the file in full, the
  // preferences just set included; `/new <title>` is already not untouched,
  // so a deliberately named chat still persists immediately. `/chat
  // open|fork` pass a chat that has content (or a file already on disk), so
  // neither is affected.
  await Promise.all([
    ...(next.isUntouched ? [] : [next.save()]),
    saveContextConfig(context),
  ]);
}

async function saveSessionPreferences(
  context: CommandContext,
  route = readableCommandSessionRoute(context),
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
    route,
  );
  // D8c/FIX-20 finding 7: the chat being LEFT is written here, and an
  // untouched one has nothing worth a file. Without this guard a second
  // `/new` still left a ghost — not the chat it created (guarded in
  // `replaceSession`), but the empty one it walked away from, so every
  // press after the first accumulated exactly one.
  if (context.session.isUntouched) return;
  await context.session.save();
}

function readableCommandSessionRoute(
  context: CommandContext,
  fallbackToPersisted = true,
): RouteIdentityV1 | undefined {
  if (!context.providerRoutes?.currentSessionRoute) {
    return fallbackToPersisted ? context.session.data.route : undefined;
  }
  try {
    return context.providerRoutes.currentSessionRoute();
  } catch (error) {
    if (
      error instanceof ProviderSetupRequiredError
      || (typeof error === "object" && error !== null && "code" in error
        && error.code === "provider-setup-required")
    ) {
      return fallbackToPersisted ? context.session.data.route : undefined;
    }
    throw error;
  }
}

/**
 * D8e: chat ids are internal (`/chats` is how users identify chats), and
 * "0 message(s)" is honest but useless copy for a chat that has nothing in
 * it yet — so the session id never appears here, and the count segment is
 * simply dropped instead of printing a zero. A nonzero count reuses the
 * exact "N messages" pluralization the `/chats` picker rows already use
 * (`formatChatRow`, `utils.ts`).
 */
function printCurrentChat(session: SessionStore, out: CommandOutput): void {
  const count = session.data.turns.length;
  // FIX-10 H4: the shared formatter (the reuse this comment block already
  // promises) — renders the "80+ messages" cap marker at the retention cap.
  const messages = count === 0 ? "" : ` · ${formatMessageCount(count)}`;
  out.text(
    plainTheme().color("ok")(`Chat: ${session.data.title}${messages}`),
  );
}

/**
 * D8e: `/new`'s one-and-only confirmation line — no title, no message
 * count, no session id. In the fullscreen TUI this same text is what gets
 * surfaced through the transient status channel instead of a transcript
 * block (see the dashboard command loop in `cli.ts`), which is what keeps a
 * freshly created chat presenting as the hub instead of the old bare
 * transcript layout; here (plain/non-interactive output) it is just the
 * one line printed directly.
 */
function announceNewChat(out: CommandOutput): void {
  out.text(plainTheme().color("ok")("New chat started."));
}

function formatChatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

// ---------------------------------------------------------------------------
// /compress (policy) and /compact (one pass, now)
//
// `/compress` configures WHEN the compressor runs by itself — mode, model,
// threshold, cost limit — and never runs it. `/compact` is the missing verb
// (audit 2026-08-28: `/compact` simply did not exist): it runs exactly one
// pass against the current chat, on demand, through
// `OrcodeAgent.compactNow` — the same `#compress` the automatic path uses,
// the same cost booking, the same pin gate. No confirmation: the user typed
// the command, which IS the decision (D4 — a confirm here would only ask
// them to repeat themselves).
// ---------------------------------------------------------------------------

/** Printed under bare `/compress` so the policy surface names the verb. */
const COMPRESS_COMPACT_CROSS_REFERENCE =
  "Policy lives here; /compact runs one compression now.";

async function compactCommand(context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  // Refused before anything is paid for: an empty chat has no context a
  // compressor could fold, and asking one anyway would cost money to learn
  // what is already knowable here.
  if (
    context.session.data.summary.trim().length === 0
    && context.session.data.turns.length === 0
  ) {
    context.out.text("Nothing to compress: this chat has no context yet.");
    return;
  }
  const agent = context.agent;
  if (!agent) {
    throw new Error("/compact needs a connected model — the compressor is a real model call.");
  }
  const result = await agent.compactNow();
  const { compression } = result;
  // Every hint the budget check and the compressor itself raised, in their
  // own words — on success too, exactly as a run reports them (a call whose
  // USD cap could not be checked upfront is worth saying either way).
  for (const notice of [...result.notices, ...compression.warnings]) {
    context.out.text(theme.color("warn")(notice));
  }
  if (compression.used) {
    const folded = result.foldedTurns === 1 ? "1 turn" : `${result.foldedTurns} turns`;
    context.out.text(
      theme.color("ok")(
        `Compacted: ${folded} folded into the handoff${theme.glyph("separator")}`
          + `${compression.originalChars} → ${compression.compressedChars} characters `
          + `(${compression.savedPercent}% smaller)${theme.glyph("separator")}`
          + `${formatUsd(compression.costUsd)}${theme.glyph("separator")}${result.compressorModel}`,
      ),
    );
    if (result.pinnedTurns > 0) {
      context.out.text(
        theme.color("muted")(
          `${result.pinnedTurns} pinned turn${result.pinnedTurns === 1 ? "" : "s"} kept verbatim (/context).`,
        ),
      );
    }
    return;
  }
  // Honest refusal. The reason itself was already printed above in the
  // compressor's own words (`warnings` — including Phase 13's "pinned turns
  // held" note); only a reason it reports silently gets a sentence here.
  context.out.text(theme.color("warn")("Nothing was compacted; the chat is unchanged."));
  if (compression.warnings.length === 0) {
    context.out.text(
      theme.color("muted")(
        compression.skipReason === "empty-handoff"
          ? `${result.compressorModel} returned nothing usable.`
          : `The compressor did not run (${compression.skipReason ?? "no reason reported"}).`,
      ),
    );
  }
  if (compression.costUsd > 0) {
    context.out.text(
      theme.color("muted")(`The compressor call still cost ${formatUsd(compression.costUsd)}; it is booked.`),
    );
  }
}

async function compressorCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      `Summarize long chats: ${compressionModeLabel(context.config.compressionMode)} · ${context.config.compressorModel} · threshold ${context.config.compressionThresholdChars} characters`,
    );
    context.out.text(
      commandTheme(context).color("muted")(COMPRESS_COMPACT_CROSS_REFERENCE),
    );
    return;
  }
  if (isCompressionMode(action)) {
    context.config.compressionMode = action;
  } else if (action === "model") {
    const requestedId = args.slice(1).join(" ").trim();
    if (!requestedId) {
      const models = compressorModelCandidates(
        await context.openRouter.listModels("", false),
      );
      const selected = await pickModel(
        models,
        context.config.compressorModel,
      );
      if (!selected) {
        context.out.text("Model selection cancelled.");
        return;
      }
      context.config.compressorModel = selected.id;
    } else {
      const exact = await resolveCompressorModelCandidate(
        context.openRouter,
        requestedId,
      );
      context.config.compressorModel = exact.id;
    }
  } else if (action === "threshold") {
    const threshold = Number(args[1]);
    if (!Number.isInteger(threshold) || threshold < 2_000 || threshold > 2_000_000) {
      throw new Error("Threshold must be between 2000 and 2000000 characters.");
    }
    context.config.compressionThresholdChars = threshold;
  } else if (action === "max-cost") {
    const value = Number(args[1]);
    if (!Number.isFinite(value) || value < 0.001 || value > 100) {
      throw new Error("Summarizer cost limit must be between 0.001 and 100 USD.");
    }
    context.config.compressorMaxCostUsd = value;
  } else {
    throw new Error(
      `Usage: /compress ${COMPRESSION_MODES.join("|")} | /compress model <id> | /compress threshold <characters> | /compress max-cost <USD>`,
    );
  }
  await saveContextConfig(context);
  context.out.text(
    commandTheme(context).color("ok")(
      `Summarize long chats: ${compressionModeLabel(context.config.compressionMode)} · ${context.config.compressorModel} · ${context.config.compressionThresholdChars} characters`,
    ),
  );
}

async function maxCostCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    context.out.text(`Main cost limit per run: ${formatUsd(context.config.maxCostUsd)}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < 0.001 || value > 1_000) {
    throw new Error("Cost limit must be between 0.001 and 1000 USD.");
  }
  context.config.maxCostUsd = value;
  await saveContextConfig(context);
  context.out.text(commandTheme(context).color("ok")(`Main cost limit: ${formatUsd(value)}`));
}

async function stepsCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    context.out.text(`Maximum actions per run: ${context.config.maxSteps}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Actions per run must be between 1 and 100.");
  }
  context.config.maxSteps = value;
  await saveContextConfig(context);
  context.out.text(commandTheme(context).color("ok")(`Maximum actions per run: ${value}`));
}

// FIX-14 ticket 8: takes the theme so its separators come from the glyph
// inventory. It used to be theme-less and joined every segment with a raw
// `·`, which is exactly the leak `theme.glyph("separator")` exists to close.
function printCosts(session: SessionStore, out: CommandOutput, theme: Theme): void {
  const costs = session.data.costs;
  const sep = theme.glyph("separator");
  if (costs.costKnowledge === "unknown") {
    out.text(`Chat cost: ${formatChatCost({ costUsd: costs.totalUsd, costKnowledge: "unknown" }, sep)}`);
    return;
  }
  out.text(
    `Chat cost: main ${formatUsd(costs.mainUsd)}${sep}summarizer ${formatUsd(costs.compressorUsd)}${sep}`
    + `transcription ${formatUsd(costs.voiceUsd)}${sep}total ${formatUsd(costs.totalUsd)}`,
  );
}

function printHistory(session: SessionStore, args: string[], out: CommandOutput): void {
  const theme = plainTheme();
  const requested = Number(args[0] ?? 10);
  const count = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
  const turns = session.recentTurns(count);
  if (!turns.length) {
    // D5 invitation grammar: nothing to show yet, plus the one next action —
    // sending a message is what actually starts history, not a slash command.
    out.text(`No chat history yet ${theme.glyph("emdash")} type below to start one.`);
    return;
  }
  for (const turn of turns) {
    out.text(
      `\n${theme.color("text", { bold: true })(turn.role === "user" ? "You" : "orcode")} ${theme.color("muted")(turn.createdAt)}\n${truncate(turn.content, 2_000)}`,
    );
  }
}

/**
 * The subset of `PersistedSessionData` `/context` actually reads — a
 * structural type (not `SessionStore`/`PersistedSessionData` itself) so a
 * test can hand `renderContextLines` a plain fake-store object instead of a
 * live `SessionStore` (bullet 1 of the phase's test plan: "view reflects
 * real window composition (fake store)").
 */
export interface ContextViewSession {
  readonly summary: string;
  readonly summaryUpdatedAt?: string;
  readonly turns: readonly ChatTurn[];
  readonly toolCalls: readonly SessionToolCall[];
  readonly pinnedTurns?: readonly string[];
  /** D9: the standing goal (`/goal <text>`), when set. */
  readonly goal?: string;
}

function contextHintLine(theme: Theme): string {
  return `/context pin <n> marks a turn never-compress${theme.glyph("separator")}/context unpin <n> removes it`;
}

/**
 * The lead meter line (V3 ruling 1): `Context: <n>% of <window> · <tokens>
 * tokens` from the exact same measurement the header uses
 * (`OrcodeAgent.lastUsage` run through `contextFillPercent`, agent.ts — one
 * computation, never a second inline percentage). `null`/`undefined` (no run
 * completed yet this process) renders the same honest absence the header
 * itself shows by simply not rendering its segment.
 */
function renderContextMeterLine(
  theme: Theme,
  lastUsage: Readonly<{ inputTokens: number; contextLength: number }> | null,
): Line {
  const percent = lastUsage
    ? contextFillPercent(lastUsage.inputTokens, lastUsage.contextLength)
    : undefined;
  if (!lastUsage || percent === undefined) {
    return {
      spans: [
        span(
          `Context: not yet measured this session ${theme.glyph("emdash")} send a message to measure the window fill.`,
          "muted",
        ),
      ],
    };
  }
  return {
    spans: [
      span(`Context: ${Math.round(percent)}% of ${contextLengthLabel(lastUsage.contextLength)}`, "text", { bold: true }),
      span(
        `${theme.glyph("separator")}${lastUsage.inputTokens.toLocaleString("en-US")} tokens (last measured)`,
        "muted",
      ),
    ],
  };
}

/**
 * D9: the standing goal's own composition row — it IS part of what the model
 * sees (`standingGoalInstruction`, agent.ts), so `/context` lists it as its
 * own row rather than leaving it invisible. Not numbered — never pinnable,
 * unlike a turn; `/goal off` (not `/context unpin`) is how it goes away.
 */
function contextGoalLine(theme: Theme, goal: string): Line {
  const tokens = estimateTokensFromChars(goal.length);
  return {
    spans: [
      span(`${theme.glyph("toolHead")} `, "accent"),
      span("Standing goal", "text", { bold: true }),
      span(` — ${truncate(goal, 120)}`, "muted"),
      span(
        ` · ${theme.glyph("unverified")}${tokens.toLocaleString("en-US")} tokens`,
        "muted",
      ),
    ],
  };
}

/** One `⎿ tool: <name> — <summary>` composition row (not numbered — never pinnable). */
function contextToolCallLine(theme: Theme, call: SessionToolCall): Line {
  const tokens = estimateTokensFromChars(call.name.length + call.summary.length);
  return {
    spans: [
      span(`  ${theme.glyph("blockFoot")} `, "structure"),
      span(`tool: ${call.name}`, "muted"),
      // FIX-21 finding 5 (frame-verified): this header composed a raw `—`
      // and a raw `·`, so `/context`'s tool rows kept both characters in
      // ASCII glyph mode while the elbow beside them asciified correctly.
      ...(call.summary
        ? [span(` ${theme.glyph("emdash")} ${truncate(call.summary, 120)}`, "muted")]
        : []),
      span(
        `${theme.glyph("separator")}${theme.glyph("unverified")}${tokens.toLocaleString("en-US")} tokens`,
        "muted",
      ),
    ],
  };
}

/** One numbered, pinnable turn row: `● <n>. You/orcode · ~<tokens> tokens[ · pinned]`. */
function contextTurnLine(theme: Theme, turn: ChatTurn, index: number, pinned: boolean): Line {
  const tokens = estimateTokensFromChars(chatTurnTranscriptText(turn).length);
  const role = turn.role === "user" ? "You" : "orcode";
  return {
    spans: [
      span(`${theme.glyph("toolHead")} `, "accent"),
      span(`${index}. ${role}`, "text", pinned ? { bold: true } : undefined),
      span(
        `${theme.glyph("separator")}${theme.glyph("unverified")}${tokens.toLocaleString("en-US")} tokens`,
        "muted",
      ),
      ...(pinned ? [span(`${theme.glyph("separator")}pinned`, "accent")] : []),
    ],
  };
}

/**
 * `/context`'s read view (D5 structure, F4 facts): a lead meter line, then
 * one row per composition block — the compressed summary (if any, labeled
 * with when it was folded), each tool-call record interleaved by the turn
 * index it happened around (same grouping `exportSessionMarkdown`'s
 * `appendToolCalls` already uses), and every turn, numbered 1..N in
 * chronological order — the same numbers `/context pin <n>`/`unpin <n>`
 * read back (Ruling 2). Every token count is the compressor's own
 * chars→tokens estimator (`estimateTokensFromChars`, utils.ts) —
 * reused, never a second one — and is marked with the `unverified` glyph
 * (`~`, identical in both glyph modes) plus one explicit "estimates" note in
 * the section rule; only the lead meter's own tokens figure is exact,
 * because it is the real measured value the header itself uses.
 */
export function renderContextLines(
  session: ContextViewSession,
  lastUsage: Readonly<{ inputTokens: number; contextLength: number }> | null,
  theme: Theme,
): Line[] {
  const rule = (text: string): Line => ({
    spans: [
      span(`${theme.glyph("divider")} `, "structure"),
      span(text, "muted"),
    ],
  });
  // V4-A zone 1: the title bar. `/context` is a printed view — it writes into
  // the scrolling transcript rather than a sized frame — so the bar hugs its
  // own text instead of filling a width it has no way to know; it is still
  // the one inverse line of the view, and at colour level 0 it degrades to
  // the `─ <crumb>` rule this view already uses for its section boundaries.
  const lines: Line[] = [
    { spans: [] },
    titleBarLine(theme, ["Chat", "Context"]),
    renderContextMeterLine(theme, lastUsage),
  ];
  lines.push(rule(`Composition ${theme.glyph("emdash")} token counts are estimates (~)`));

  // D9: shown ahead of the summary/turns — it is injected on every run
  // regardless of whether the chat has any history yet (the "no
  // conversation history" early return below is only about turns, not
  // about whether the model sees a standing goal).
  const trimmedGoal = session.goal?.trim();
  if (trimmedGoal) {
    lines.push(contextGoalLine(theme, trimmedGoal));
  }

  const pinned = new Set(session.pinnedTurns ?? []);
  if (session.summary.trim()) {
    const tokens = estimateTokensFromChars(session.summary.length);
    const folded = session.summaryUpdatedAt
      ? formatChatDate(session.summaryUpdatedAt)
      : "an unknown time";
    lines.push({
      spans: [
        span(`${theme.glyph("toolHead")} `, "accent"),
        span("Compressed summary", "text", { bold: true }),
        span(
          `${theme.glyph("separator")}${theme.glyph("unverified")}${tokens.toLocaleString("en-US")} tokens`
            + `${theme.glyph("separator")}folded ${folded}`,
          "muted",
        ),
      ],
    });
  }

  if (!session.turns.length && !session.summary.trim()) {
    lines.push({
      spans: [
        span(
          `No chat history yet ${theme.glyph("emdash")} type below to start one.`,
          "muted",
        ),
      ],
    });
    lines.push(rule(contextHintLine(theme)));
    return lines;
  }

  const toolsByTurnIndex = new Map<number, SessionToolCall[]>();
  for (const call of session.toolCalls) {
    const list = toolsByTurnIndex.get(call.turnIndex) ?? [];
    list.push(call);
    toolsByTurnIndex.set(call.turnIndex, list);
  }

  session.turns.forEach((turn, index) => {
    for (const call of toolsByTurnIndex.get(index) ?? []) {
      lines.push(contextToolCallLine(theme, call));
    }
    const isPinned = turn.id !== undefined && pinned.has(turn.id);
    lines.push(contextTurnLine(theme, turn, index + 1, isPinned));
  });
  for (const call of session.toolCalls.filter((call) => call.turnIndex >= session.turns.length)) {
    lines.push(contextToolCallLine(theme, call));
  }

  lines.push(rule(contextHintLine(theme)));
  return lines;
}

/**
 * Renders the view AND records the exact row→turn-id snapshot it just
 * showed on `context.contextViewCache` — the one thing `/context
 * pin|unpin <n>` is allowed to resolve a row number against (Phase 13 fix
 * round 1). Always overwrites any previous snapshot, chat-switch included
 * (the snapshot carries its own `chatId`).
 */
function printContext(context: CommandContext): void {
  const theme = commandTheme(context);
  const lines = renderContextLines(context.session.data, context.agent?.lastUsage ?? null, theme);
  for (const rendered of renderLines(lines, theme)) {
    context.out.text(rendered);
  }
  context.contextViewCache = {
    chatId: context.session.data.id,
    turnIds: context.session.data.turns.map((turn) => turn.id),
  };
}

const CONTEXT_VIEW_STALE_MESSAGE = "The context view has changed — run /context again.";

/**
 * The one place `/context pin|unpin <n>` turns a row number into a turn id
 * (Phase 13 fix round 1). Deliberately never touches `session.data.turns`
 * directly for this — it only trusts `context.contextViewCache`, and only
 * once that snapshot is proven to still describe the session's current
 * turns exactly (same chat, same turn ids, same order): a live re-index
 * would silently resolve `<n>` against whatever turns happen to exist *now*
 * — including after an automatic compression cycle ran between the view and
 * the pin command, which is exactly how row numbers used to point at the
 * wrong turn.
 *
 * Returns `"stale"` when there is no cached view for this exact chat state
 * (never viewed, or the turns changed underneath it in any way — a new
 * message, a compression cycle, a chat switch, a checkpoint restore, …);
 * `undefined` when the cache is fresh but `rowNumber` was never a valid row
 * in it (a plain out-of-range number, not a staleness problem); otherwise
 * the turn id at that row.
 */
function resolveCachedContextRow(
  context: CommandContext,
  rowNumber: number,
): string | undefined | "stale" {
  const cache = context.contextViewCache;
  if (!cache || cache.chatId !== context.session.data.id) {
    return "stale";
  }
  const liveIds = context.session.data.turns.map((turn) => turn.id);
  if (
    cache.turnIds.length !== liveIds.length
    || cache.turnIds.some((id, index) => id !== liveIds[index])
  ) {
    return "stale";
  }
  return cache.turnIds[rowNumber - 1];
}

/**
 * `/context` (view) and `/context pin|unpin <n>` (Ruling 2 — the row number
 * `/context` just printed). Pinning/unpinning a row that no longer names
 * what the last view showed (Phase 13 fix round 1 — the view is stale) or
 * never named anything (the number was never valid) is reported honestly
 * rather than silently doing nothing or acting on the wrong turn.
 */
async function contextCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    printContext(context);
    return;
  }
  if (action !== "pin" && action !== "unpin") {
    // `/pin 3` and `/context 3` both mean "pin row 3" to the person typing
    // them; saying so beats echoing a syntax summary that leaves them to
    // spot the missing verb.
    throw new Error(
      Number.isInteger(Number(action))
        ? `Usage: /context pin ${action} — the verb is required, and <n> is the row number /context prints.`
        : "Usage: /context [pin <n>|unpin <n>]",
    );
  }
  const rowNumber = Number(args[1]);
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`Usage: /context ${action} <n> — <n> is the row number /context prints.`);
  }
  const resolved = resolveCachedContextRow(context, rowNumber);
  if (resolved === "stale") {
    throw new Error(CONTEXT_VIEW_STALE_MESSAGE);
  }
  if (!resolved) {
    throw new Error(
      `No turn numbered ${rowNumber} ${theme.glyph("emdash")} run /context again to see the current rows.`,
    );
  }
  const turnId = resolved;
  if (action === "pin") {
    context.session.pinTurn(turnId);
    await context.session.save();
    context.out.text(theme.color("ok")(`Pinned turn ${rowNumber} as never-compress.`));
    return;
  }
  const changed = context.session.unpinTurn(turnId);
  if (changed) {
    await context.session.save();
  }
  context.out.text(
    changed
      ? theme.color("ok")(`Unpinned turn ${rowNumber}.`)
      : `Turn ${rowNumber} was not pinned.`,
  );
}

/**
 * `/goal` (D9): sets, shows, or clears this chat's persistent standing goal —
 * `/goal off` mirrors `/cross off`'s bare-subcommand style (controller
 * ruling). Setting/clearing needs no confirmation (D4: nothing here is
 * destructive or irreversible — the previous goal, if any, is simply
 * overwritten or removed). Length refusal (`SessionStore.setGoal`) and the
 * empty-args "no goal set" honesty both come straight from the session layer
 * or are rendered here verbatim — never silently truncated or fabricated.
 */
async function goalCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  if (!args.length) {
    const goal = context.session.data.goal;
    context.out.text(
      goal
        ? `Goal: ${goal}`
        : "No goal set — /goal <text> sets one.",
    );
    return;
  }
  // M-4 (review, accepted): a literal goal of "off" ("/goal off") is
  // unsettable — the single "off" argument always means the subcommand, not
  // goal text. Same accepted precedent as `/cross off`, which has the exact
  // same reserved-word tradeoff for its own bare "off" argument.
  if (args.length === 1 && args[0]!.toLowerCase() === "off") {
    if (context.session.data.goal === undefined) {
      context.out.text("No goal was set.");
      return;
    }
    context.session.clearGoal();
    await context.session.save();
    context.out.text("Goal cleared.");
    return;
  }
  context.session.setGoal(args.join(" "));
  await context.session.save();
  context.out.text(theme.color("ok")(`Goal set: ${context.session.data.goal}`));
}

/**
 * FIX-9 (vocabulary glossary): the ONE `/clear` confirmation question. Both
 * production surfaces — the plain loop's `confirmPlain` below and the
 * fullscreen dashboard's `ui.confirmAction` (`src/cli.ts`) — render this
 * exact string, so the two can never drift into separately worded questions
 * about the same irreversible action again.
 */
export const CLEAR_CHAT_CONFIRM_TITLE = "Reset this chat's history and its recorded cost?";

/**
 * The body under that question, likewise shared by both surfaces. The closing
 * sentence is load-bearing honesty, not decoration: `/clear` zeroes this
 * chat's own cost counters but never the per-folder day/total spend the
 * budget guard actually checks, so the confirmation says so instead of
 * letting "recorded cost" read as "all cost figures".
 */
export const CLEAR_CHAT_CONFIRM_DETAILS =
  "The stored chat history and cost statistics for this folder will be deleted. "
  + "Today's budget tracking is kept.";


async function clearSession(context: CommandContext): Promise<void> {
  const accepted = await confirmInContext(
    context,
    { title: CLEAR_CHAT_CONFIRM_TITLE, consequence: CLEAR_CHAT_CONFIRM_DETAILS },
    { danger: true },
  );
  if (!accepted) {
    return;
  }
  context.session.clear();
  resetCommandConversation(context);
  await context.session.save();
  context.out.text("Chat reset.");
}

async function exportCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const markdown = context.session.exportMarkdown();
  const requested = args.join(" ").trim();
  if (!requested) {
    context.out.text(markdown);
    return;
  }
  const local = commandLocalRuntime(context);
  const target = await local.guard.resolvePath(requested);
  const display = local.guard.display(target);
  // Same policy as the write tools: `/export .git/config` must not be a way
  // around the deny list.
  await context.approvals.authorize(
    writeApprovalRequest("export", display, {
      summary: `Write chat as Markdown: ${display}`,
      details: `${pluralize(context.session.data.turns.length, "message")} · ${markdown.length} characters`,
    }),
  );
  await writeFile(target, markdown, { encoding: "utf8", mode: 0o600 });
  // FIX-10 fix round 1 (F10): the success line names the file the way the
  // approval confirm above just did (`display`), not the raw resolved path
  // — same one-spelling-per-flow rule as /init's M6 fix.
  context.out.text(commandTheme(context).color("ok")(`Chat exported: ${display}`));
}

async function checkpointCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const action = (args[0] ?? "list").toLowerCase();
  if (action === "list") {
    const checkpoints = context.session.listCheckpoints();
    if (!checkpoints.length) {
      context.out.text(`No checkpoints in this chat ${commandTheme(context).glyph("emdash")} /checkpoint new [name] creates one.`);
      return;
    }
    const sep = commandTheme(context).glyph("separator");
    for (const checkpoint of checkpoints) {
      context.out.text(
        `${checkpoint.label}${sep}after ${pluralize(checkpoint.turnIndex, "message")}${sep}`
        + `${formatChatCost(checkpoint, sep)}${sep}${formatChatDate(checkpoint.createdAt)}${sep}`
        + `${checkpoint.id.slice(0, 8)}`,
      );
    }
    return;
  }
  if (action === "new" || action === "add" || action === "create") {
    const checkpoint = context.session.createCheckpoint(
      args.slice(1).join(" ").trim(),
    );
    await context.session.save();
    context.out.text(
      commandTheme(context).color("ok")(
        `Checkpoint created: ${checkpoint.label} (${checkpoint.id.slice(0, 8)})`,
      ),
    );
    return;
  }
  if (action === "restore" || action === "back") {
    const reference = args.slice(1).join(" ").trim();
    if (!reference) {
      throw new Error("Usage: /checkpoint restore <ID or name>");
    }
    const checkpoint = context.session.restoreCheckpoint(reference);
    resetCommandConversation(context);
    await context.session.save();
    context.out.text(
      commandTheme(context).color("ok")(
        `Reset to ${checkpoint.label}: ${pluralize(context.session.data.turns.length, "message")}. Cost remains booked.`,
      ),
    );
    return;
  }
  throw new Error("Usage: /checkpoint [list|new [name]|restore <ID|name>]");
}

async function budgetCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    // Same store the agent enforces against — not the process-wide default.
    const spend = await workspaceSpend(
      context.workspace,
      context.session.appHome,
    );
    const sep = commandTheme(context).glyph("separator");
    context.out.text(`Budget: ${budgetSummary(context.config.budget)}`);
    context.out.text(
      `Spent in this folder: today ${formatChatCost({ costUsd: spend.dayUsd, costKnowledge: spend.costKnowledge }, sep)}`
      + `${sep}total ${formatChatCost({ costUsd: spend.totalUsd, costKnowledge: spend.costKnowledge }, sep)}`
      + ` across ${pluralize(spend.chatCount, "chat")}`,
    );
    context.out.text(
      commandTheme(context).color("muted")(
        "Set: /budget day <USD|off> · /budget total <USD|off> · /budget on-exceed warn|block",
      ),
    );
    return;
  }
  if (action === "day" || action === "total") {
    const raw = (args[1] ?? "").toLowerCase();
    const limit = raw === "off" || raw === "aus" || raw === "none"
      ? null
      : parseBudgetLimit(raw);
    if (action === "day") {
      context.config.budget.dailyLimitUsd = limit;
    } else {
      context.config.budget.totalLimitUsd = limit;
    }
  } else if (action === "on-exceed" || action === "action") {
    const value = (args[1] ?? "").toLowerCase();
    if (!isBudgetAction(value)) {
      throw new Error("Usage: /budget on-exceed warn|block");
    }
    context.config.budget.onExceed = value;
  } else {
    throw new Error(
      "Usage: /budget [day <USD|off>|total <USD|off>|on-exceed warn|block]",
    );
  }
  await saveContextConfig(context);
  context.out.text(commandTheme(context).color("ok")(`Budget: ${budgetSummary(context.config.budget)}`));
}

function parseBudgetLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 100_000) {
    throw new Error(
      "Budget limit must be between 0.01 and 100000 USD, or \"off\" for no limit.",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// A4 — /verify. The automatic on-edit lifecycle lives in agent.ts; this
// command edits the same canonical config and offers an explicit one-shot run.
// ---------------------------------------------------------------------------

async function verifyCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    printVerifyStatus(context);
    return;
  }
  if (action === "on" || action === "off") {
    const mode: VerifyMode = action === "on" ? "on-edit" : "off";
    context.config.verify = validateVerify({ ...context.config.verify, mode });
    await saveContextConfig(context);
    context.out.text(theme.color("ok")(`Verify: ${mode}`));
    return;
  }
  if (action === "now") {
    if (!context.config.verify.commands.length) {
      context.out.text(
        `No verify commands configured ${theme.glyph("emdash")} /verify <command> adds one.`,
      );
      return;
    }
    const callbacks = context.onRunEvent
      ? processCallbacksForEvents(context.onRunEvent)
      : undefined;
    const outcome = await runVerify(
      context.config.verify.commands,
      commandLocalRuntime(context).guard,
      undefined,
      () => {},
      callbacks,
    );
    if (outcome.status === "passed") {
      context.out.text(theme.color("ok")("Verify: all commands green."));
    } else if (outcome.status === "failed") {
      context.out.error(
        `Verify failed: ${outcome.command} (exit ${outcome.exitCode})`,
      );
      context.out.text(outcome.distilled);
    } else if (outcome.status === "timed-out") {
      context.out.error(`Verify time limit reached: ${outcome.command}`);
    } else if (outcome.status === "terminated") {
      context.out.error(
        `Verify process ended by ${outcome.signal}: ${outcome.command}`,
      );
    } else if (outcome.status === "spawn-failed") {
      context.out.error(
        `Verify could not be started: ${outcome.command}`,
        outcome.error,
      );
    } else {
      context.out.text("Verify cancelled.");
    }
    return;
  }
  if (action === "suggest") {
    let packageJson: unknown;
    try {
      const raw = await readFile(
        await commandLocalRuntime(context).guard.resolvePath("package.json"),
        "utf8",
      );
      packageJson = JSON.parse(raw);
    } catch {
      context.out.text("No readable package.json found in this folder.");
      return;
    }
    const suggested = suggestVerifyCommands(packageJson);
    if (!suggested.length) {
      context.out.text("No check/test/build scripts found in package.json.");
      return;
    }
    context.config.verify = validateVerify({
      ...context.config.verify,
      commands: suggested,
    });
    await saveContextConfig(context);
    context.out.text(
      theme.color("ok")(`Verify commands adopted: ${suggested.join(", ")}`),
    );
    return;
  }
  if (action === "clear") {
    context.config.verify = validateVerify({ ...context.config.verify, commands: [] });
    await saveContextConfig(context);
    context.out.text(theme.color("ok")("Verify commands cleared."));
    return;
  }
  if (action === "rounds") {
    const rounds = Number(args[1]);
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > VERIFY_MAX_ROUNDS) {
      throw new Error(`/verify rounds must be between 0 and ${VERIFY_MAX_ROUNDS}.`);
    }
    context.config.verify = validateVerify({
      ...context.config.verify,
      maxRepairRounds: rounds,
    });
    await saveContextConfig(context);
    context.out.text(theme.color("ok")(`Verify rounds: ${rounds}`));
    return;
  }
  // Anything else is treated as a literal command to add, e.g. `/verify npm run check`.
  const command = args.join(" ").trim();
  if (!command) {
    throw new Error(
      `Usage: /verify [on|off|now|suggest|clear|rounds <0-${VERIFY_MAX_ROUNDS}>|<command>]`,
    );
  }
  context.config.verify = validateVerify({
    ...context.config.verify,
    commands: [...context.config.verify.commands, command],
  });
  await saveContextConfig(context);
  context.out.text(theme.color("ok")(`Verify command added: ${command}`));
}

function printVerifyStatus(context: CommandContext): void {
  const verify = context.config.verify;
  context.out.text(
    `Verify: ${verify.mode} · ${pluralize(verify.maxRepairRounds, "retry", "retries")} after a failed check · ${pluralize(verify.commands.length, "command")}`,
  );
  for (const command of verify.commands) {
    context.out.text(`  ${command}`);
  }
  context.out.text(
    commandTheme(context).color("muted")(
      "Set: /verify on|off · /verify <command> · /verify suggest · /verify clear · /verify rounds <n> · /verify now",
    ),
  );
}

// ---------------------------------------------------------------------------
// A2 — /web. The main call computes the SDK plugin from this persisted mode.
// ---------------------------------------------------------------------------

async function webCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const mode = (args[0] ?? "").toLowerCase();
  if (!mode) {
    context.out.text(`Web search: ${context.config.web}`);
    context.out.text(theme.color("muted")(`Set: /web ${WEB_MODES.join(" | ")}`));
    return;
  }
  if (!includesValue(WEB_MODES, mode)) {
    throw new Error(`Invalid web mode. Allowed: ${WEB_MODES.join(", ")}`);
  }
  context.config.web = mode as WebMode;
  await saveContextConfig(context);
  context.out.text(theme.color("ok")(`Web search: ${mode}`));
}

// ---------------------------------------------------------------------------
// A3 — /provider and /fallback. The main call applies this persisted routing
// policy; compressor and panel calls intentionally do not inherit it.
// ---------------------------------------------------------------------------

async function providerCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    printProviderStatus(context);
    return;
  }
  if (action === "sort") {
    const value = (args[1] ?? "").toLowerCase();
    if (value === "off" || value === "none") {
      const { sort: _drop, ...rest } = context.config.provider;
      context.config.provider = validateProvider(rest);
    } else if (includesValue(PROVIDER_SORTS, value)) {
      context.config.provider = validateProvider({
        ...context.config.provider,
        sort: value as ProviderSortPreference,
      });
    } else {
      throw new Error(`/provider sort allows: off, ${PROVIDER_SORTS.join(", ")}`);
    }
  } else if (action === "data" || action === "deny" || action === "allow") {
    // FIX-15: `data allow|deny` is the spelling the usage names. Bare
    // `/provider allow` read as a sibling of `/allow` (approvals) — one word,
    // two unrelated meanings, which the command-IA audit flagged as a
    // collision. The bare forms keep parsing so no muscle memory breaks; they
    // are simply not advertised any more.
    const value = (action === "data" ? (args[1] ?? "") : action).toLowerCase();
    if (!includesValue(DATA_COLLECTIONS, value)) {
      throw new Error("/provider data allows: allow or deny");
    }
    context.config.provider = validateProvider({
      ...context.config.provider,
      dataCollection: value as DataCollectionPreference,
    });
  } else if (action === "only" || action === "ignore") {
    const providers = args.slice(1);
    context.config.provider = validateProvider({
      ...context.config.provider,
      [action]: providers.length ? providers : undefined,
    });
  } else if (action === "fallback" || action === "fallbacks") {
    const value = (args[1] ?? "").toLowerCase();
    if (value !== "on" && value !== "off") {
      throw new Error("/provider fallbacks allows: on or off");
    }
    context.config.provider = validateProvider({
      ...context.config.provider,
      allowFallbacks: value === "on",
    });
  } else if (action === "clear" || action === "reset") {
    context.config.provider = validateProvider({});
  } else if (isProviderAccountAction(PROVIDER_ACTION_ALIASES[action] ?? action)) {
    await providerAccountCommand(
      (PROVIDER_ACTION_ALIASES[action] ?? action) as ProviderAccountAction,
      args.slice(1),
      context,
    );
    return;
  } else {
    throw new Error(PROVIDER_COMMAND_USAGE);
  }
  await saveContextConfig(context);
  printProviderStatus(context);
}

/** Same rule as `PROVIDER_COMMAND_USAGE` below: the refusal quotes the catalog. */
const SETTINGS_COMMAND_USAGE = `Usage: ${
  COMMAND_CATALOG.find((entry) => entry.handlerId === "settings")!.usage
}`;

/**
 * The refusal quotes the CATALOG's own usage line rather than a second copy
 * of it — before FIX-15 the two were separate literals that had to be edited
 * in lockstep, which is precisely how a usage string goes stale.
 */
const PROVIDER_COMMAND_USAGE = `Usage: ${
  COMMAND_CATALOG.find((entry) => entry.handlerId === "provider")!.usage
}`;

/**
 * `login` is an ALIAS of `connect`, never a second connect path: every peer
 * CLI spells signing in "login", and the audit listed it among the missing
 * doors. `logout` is already the canonical name of its own action, so the
 * pair reads the way an owner expects without duplicating either mechanism.
 */
const PROVIDER_ACTION_ALIASES = lookupTable<ProviderAccountAction>({ login: "connect" });

const PROVIDER_ACCOUNT_ACTIONS = [
  "setup",
  "connect",
  "enable",
  "disable",
  "disconnect",
  "reconnect",
  "status",
  "models",
  "logout",
] as const;

type ProviderAccountAction = (typeof PROVIDER_ACCOUNT_ACTIONS)[number];

export type ProviderBackendAction = Exclude<ProviderAccountAction, "setup" | "status">;

const PROVIDER_BACKEND_ACTION_ORDER = [
  "connect", "enable", "disable", "disconnect", "reconnect", "models", "logout",
] as const satisfies readonly ProviderBackendAction[];

/**
 * FIX-9 (internal leaks): the one backend id → user-facing provider name
 * mapping. `backendId` is an internal routing key (`kimi-code`), never copy;
 * every surface that names a provider to the owner goes through this instead
 * of printing the raw id or re-inlining its own ternary.
 */
const PROVIDER_DISPLAY_NAMES: Readonly<Record<ProviderCommandBackendId, string>> = Object.freeze({
  openrouter: "OpenRouter",
  "kimi-code": "Kimi Code",
  anthropic: "Anthropic",
});

export function providerDisplayName(backendId: ProviderCommandBackendId): string {
  return PROVIDER_DISPLAY_NAMES[backendId];
}

/**
 * Action-specific backend gate. Kimi Code is approved for connect, enable,
 * disable, reconnect, models, and logout only; disconnect stays unapproved
 * and must fail at the parser with the exact usage and zero port calls.
 */
export const PROVIDER_BACKEND_ACTIONS: Readonly<Record<ProviderCommandBackendId, ReadonlySet<ProviderBackendAction>>> = Object.freeze({
  openrouter: immutableReadonlySet<ProviderBackendAction>([
    "connect", "enable", "disable", "disconnect", "reconnect", "models", "logout",
  ]),
  "kimi-code": immutableReadonlySet<ProviderBackendAction>([
    "connect", "enable", "disable", "reconnect", "models", "logout",
  ]),
  anthropic: immutableReadonlySet<ProviderBackendAction>([
    "connect", "enable", "disable", "disconnect", "reconnect", "models", "logout",
  ]),
});

export function providerBackendActions(backendId: ProviderCommandBackendId): readonly ProviderBackendAction[] {
  return Object.freeze(
    PROVIDER_BACKEND_ACTION_ORDER.filter((action) => PROVIDER_BACKEND_ACTIONS[backendId].has(action)),
  );
}

function immutableReadonlySet<T>(values: readonly T[]): ReadonlySet<T> {
  const source = new Set(values);
  let view!: ReadonlySet<T>;
  view = Object.freeze({
    get size() { return source.size; },
    has(value: T) { return source.has(value); },
    entries() { return source.entries(); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) {
      source.forEach((value) => callback.call(thisArg, value, value, view));
    },
    [Symbol.iterator]() { return source[Symbol.iterator](); },
    [Symbol.toStringTag]: "Set",
  });
  return view;
}

function isProviderAccountAction(value: string): value is ProviderAccountAction {
  return includesValue(PROVIDER_ACCOUNT_ACTIONS, value);
}

function isProviderCommandBackendId(value: string | undefined): value is ProviderCommandBackendId {
  return value === "openrouter" || value === "kimi-code" || value === "anthropic";
}

async function providerAccountCommand(
  action: ProviderAccountAction,
  args: string[],
  context: CommandContext,
): Promise<void> {
  const providerCommands = context.providerCommands;
  if (!providerCommands) throw new Error("Provider control is not available.");
  const surface = context.providerRouteSurface ?? "plain";
  let intent: ProviderCommandIntent;
  if (action === "setup" || action === "status") {
    if (args.length !== 0) throw new Error(PROVIDER_COMMAND_USAGE);
    intent = { kind: action };
  } else {
    if (args.length !== 1) throw new Error(PROVIDER_COMMAND_USAGE);
    const backendId = args[0]?.toLowerCase();
    if (!isProviderCommandBackendId(backendId) || !PROVIDER_BACKEND_ACTIONS[backendId].has(action)) {
      throw new Error(PROVIDER_COMMAND_USAGE);
    }
    intent = { kind: action, backendId };
  }

  const balanceContext = providerStatusBalanceContext(context);
  let result = await providerCommands.execute(intent, surface);
  if (result.kind === "confirmation-required") {
    // FIX-14 ticket 6: one question. Plain mode used the runtime's own
    // `message` as the title with no question at all; fullscreen asked
    // "Confirm <Provider> <operation>?" with the message underneath. The
    // second shape survives — and FIX-9's rule that the owner sees the
    // provider NAME, never the internal routing key, comes with it.
    const accepted = await confirmInContext(
      context,
      {
        title: `Confirm ${providerDisplayName(result.backendId)} ${result.operation}?`,
        consequence: result.message,
      },
      { danger: true },
    );
    if (!accepted) {
      context.out.text("Provider change cancelled. The chat stays open.");
      return;
    }
    result = await providerCommands.execute({
      kind: result.operation,
      backendId: result.backendId,
      confirmationToken: result.confirmationToken,
    }, surface);
  }
  renderProviderCommandResult(result, context.out, balanceContext);
}

/**
 * D6 (the cost thread): resolves `/provider status`'s balance segment once,
 * from `context.readCachedBalance` alone — never a new fetch (Controller
 * ruling 1/2/5). `remainingUsd` is the raw cached figure, the same one
 * `/balance`'s own `printBalance` shows (`formatUsd(balance.credits.remaining)`),
 * deliberately NOT netted against this session's spend the way the
 * dashboard's welcome-box/status-line figures are — `/provider status` has
 * no "this session" framing to net against, so the honest thing is the
 * plain account figure, exactly like `/balance` already shows it.
 * `undefined` (never cached, or the fetch failed) means the Billing line
 * omits the segment entirely — never a fabricated number.
 */
function providerStatusBalanceContext(context: CommandContext): ProviderStatusBalance {
  const cached = context.readCachedBalance?.() ?? null;
  const remainingUsd = cached?.credits?.remaining;
  const thresholdUsd = context.config.lowBalanceThresholdUsd;
  return {
    remainingUsd,
    thresholdUsd,
    low: isLowBalance(remainingUsd, thresholdUsd),
  };
}

/**
 * `/provider status`'s role label (V3 audit principle 4): the active route
 * reads as "active route", everything else as a plain description of
 * whether it has been set up — never an internal state name.
 */
function providerStatusRoleLabel(provider: ProviderCommandStatusEntry): string {
  // FIX-12: was "coming soon" — a promise, and the only role label here
  // that described a future rather than the present. `coming-soon` is the
  // internal maturity value; what the reader needs is what it means today.
  if (provider.availability === "coming-soon") return ANTHROPIC_DIRECT_BACKEND_ROLE;
  if (provider.isDefault) return "active route";
  // FIX-10 M4 + fix round 1 (F1): plain descriptions off the tri-state —
  // "configured" (an enabled connection exists), "disabled" (a stored
  // connection the user turned off), "not connected" (no stored connection
  // at all). The old two-value field rendered a fresh install as "standby"
  // and then, post-M4, as "disabled" — both stored-state claims that were
  // simply false for a provider that was never connected.
  if (provider.configuration === "enabled") return "configured";
  return provider.configuration === "disabled" ? "disabled" : "not connected";
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/**
 * The bullet format's `⎿ ✓/✗ <facts>` line. A healthy provider gets the
 * mockup's flowing three-fact clause (credential · connectivity · spend);
 * anything else collapses to the one concrete reason a human would want —
 * `providerHealthFailureFactLabel` picks it with the same field precedence
 * `deriveProviderHeadline` (`backends.ts`) used to decide the provider was
 * unhealthy. A provider with no health snapshot at all (never probed) is
 * distinguished from one that was never connected in the first place.
 */
function providerStatusFact(provider: ProviderCommandStatusEntry): { ok: boolean; text: string } {
  if (!provider.health) {
    return {
      ok: false,
      // FIX-10 fix round 1 (F1): "not connected" only when no stored
      // connection exists; an existing (enabled or disabled) connection
      // that was never probed reads "not checked".
      text: capitalizeFirst(provider.configuration === "not-connected" ? "not connected" : "not checked"),
    };
  }
  if (provider.headline === "ready") {
    const facts = [
      providerCredentialFactLabel(provider.health.credential),
      providerConnectivityFactLabel(provider.health.connectivity),
      providerSpendFactLabel(provider.health.spend),
    ].join(" · ");
    return { ok: true, text: capitalizeFirst(facts) };
  }
  return { ok: false, text: capitalizeFirst(providerHealthFailureFactLabel(provider.health)) };
}

/**
 * D6 (the cost thread): `/provider status`'s balance segment, resolved once
 * per invocation by `providerStatusBalanceContext` from
 * `context.readCachedBalance` alone (never a new fetch). `remainingUsd` is
 * `undefined` whenever no balance is cached — the Billing line then omits
 * the segment entirely, and `low` is always `false` (see `isLowBalance`).
 */
interface ProviderStatusBalance {
  readonly remainingUsd: number | undefined;
  readonly thresholdUsd: number;
  readonly low: boolean;
}

/**
 * The `Billing:` sub-line. Billing realm always goes through the shared
 * `billingRealmLabel` humanizer (settings-registry.ts); the provider-managed
 * overage caveat is derived from the billing realm itself (not a backendId
 * special case) so any future provider-managed-overage realm picks it up
 * for free.
 *
 * D6: a cached balance's `Balance $X.XX` (F4 mockup segment, ratified F8
 * follow-up) is appended only for the `openrouter-payg` realm — the cached
 * figure always comes from `OpenRouterService.checkBalance()`, so it can
 * only ever honestly describe OpenRouter's own account, never Kimi's
 * provider-managed subscription or a coming-soon backend. `undefined`
 * (never cached, or the fetch failed) omits the segment outright — never a
 * fabricated number, the same "no-balance" honesty case F4 established,
 * now closed for the one realm where a cache genuinely exists.
 */
// FIX-14 ticket 8: `theme` is threaded in so both appended segments use the
// glyph inventory's separator rather than a raw `·` literal.
function providerBillingSpans(
  provider: ProviderCommandStatusEntry,
  balance: ProviderStatusBalance,
  theme: Theme,
): Span[] {
  const sep = theme.glyph("separator");
  const overage = provider.billingRealm === "kimi-code-membership-provider-managed-overage"
    ? `${sep}Extra usage may be billable`
    : "";
  const showBalance = provider.billingRealm === "openrouter-payg" && balance.remainingUsd !== undefined;
  return [
    span("    Billing: ", "muted"),
    span(billingRealmLabel(provider.billingRealm), "text"),
    ...(overage ? [span(overage, "muted")] : []),
    // FIX-10 H3 (money honesty): a cached figure, not a live account read —
    // hedged with the same `~` every other derived money figure carries.
    ...(showBalance ? [span(`${sep}Balance ~${formatUsd(balance.remainingUsd!)}`, "text")] : []),
  ];
}

/**
 * D6 low-balance warn (visibility only — never blocks): the one extra plain
 * sentence `/provider status` appends under a provider's Billing line once
 * the cached balance is known and below the configured threshold. Only
 * reachable when `providerBillingSpans` above actually showed a balance
 * figure for this provider (the `openrouter-payg` realm), so the sentence
 * never appears detached from the number it refers to.
 */
function providerLowBalanceSpans(theme: Theme, balance: ProviderStatusBalance): Span[] {
  return [
    span(
      `    Balance low ${theme.glyph("emdash")} below your ${formatUsd(balance.thresholdUsd)} threshold.`,
      "warn",
    ),
  ];
}

/**
 * `/provider status`'s bullet block (V3 audit principle 4 / the binding
 * before→after mockup): one `● <Provider> · <role>` head per provider, plus
 * a `⎿ ✓/✗ <facts>` line and a `Billing:` line for anything connectable.
 * A coming-soon backend (Anthropic today) has nothing to probe, so it gets
 * only the head line. Composed as theme `Span`s and flattened through the
 * same `renderLines` + plain `context.out.text` path `printPanelResult`
 * already uses for command output — the theme owns the `●`/`⎿`/`✓`/`✗`
 * glyphs (and their NO_COLOR/ASCII fallbacks) so none of them are raw
 * literals here.
 */
function renderProviderStatusList(
  providers: readonly ProviderCommandStatusEntry[],
  out: CommandOutput,
  balance: ProviderStatusBalance,
): void {
  const theme = createTheme();
  const lines: Line[] = [];
  for (const provider of providers) {
    lines.push({
      spans: [
        span(`${theme.glyph("toolHead")} `, "accent"),
        span(provider.displayName, "text", { bold: true }),
        span(`${theme.glyph("separator")}${providerStatusRoleLabel(provider)}`, "muted"),
      ],
    });
    if (provider.availability === "coming-soon") continue;
    const fact = providerStatusFact(provider);
    lines.push({
      spans: [
        span(`  ${theme.glyph("blockFoot")} `, "structure"),
        span(fact.ok ? theme.glyph("ok") : theme.glyph("failed"), fact.ok ? "ok" : "danger"),
        span(` ${fact.text}`, fact.ok ? "muted" : "text"),
      ],
    });
    // Privacy contract: rendered status must never include account
    // fingerprints or fingerprint suffixes, key fragments, account IDs,
    // emails, raw quota, or fabricated numeric zeros.
    lines.push({ spans: providerBillingSpans(provider, balance, theme) });
    // D6: the low-balance sentence rides directly under the Billing line it
    // annotates — only the realm that actually got a `Balance $X.XX` figure
    // above (`openrouter-payg`) can ever be "low".
    if (provider.billingRealm === "openrouter-payg" && balance.low) {
      lines.push({ spans: providerLowBalanceSpans(theme, balance) });
    }
    // Preserves the prior renderer's exact conditionality (kimi-code only) —
    // OpenRouter's `selectedModel` can be non-null too, but showing it here
    // was never part of OpenRouter's status line before this rewrite, and
    // F4 is a copy/format pass, not a scope change to what gets shown.
    if (provider.backendId === "kimi-code" && provider.selectedModel) {
      lines.push({
        spans: [
          span("    Model: ", "muted"),
          span(`${provider.selectedModel.displayName} (${provider.selectedModel.canonicalModelId})`, "text"),
        ],
      });
    }
  }
  // D5 empty state: one closing invitation stands in for "nothing
  // connected" instead of making the reader infer it from three
  // individually honest but silent rows. Coming-soon backends never count —
  // there is nothing to connect there yet.
  //
  // FIX-14 ticket 13 (FIX-10 residual). This used to key on `health ===
  // null` — "never probed" — and then claim "No providers connected". Those
  // are different facts, and the field that answers the claim is
  // `configuration`, the tri-state FIX-10 introduced for exactly this
  // distinction. A provider with a stored, enabled connection that simply
  // had not been probed yet in this process rendered a flat "No providers
  // connected" underneath its own row; and a stored-but-disabled connection
  // did too, though `/provider enable` — not `/provider connect` — is what
  // that state needs. Keyed on connection existence now: the line appears
  // only when no connectable provider has a stored connection AT ALL, which
  // is the only state in which "connect adds one" is the whole truth.
  const connectable = providers.filter((provider) => provider.availability !== "coming-soon");
  if (connectable.length > 0 && connectable.every((provider) => provider.configuration === "not-connected")) {
    lines.push({
      spans: [span(`No providers connected ${theme.glyph("emdash")} /provider connect adds one.`, "muted")],
    });
  }
  for (const rendered of renderLines(lines, theme)) {
    out.text(rendered);
  }
}

function renderProviderCommandResult(
  result: ProviderCommandResult,
  out: CommandOutput,
  balance: ProviderStatusBalance,
): void {
  if (result.kind === "provider-coming-soon") {
    out.text(`${result.displayName} · ${result.explanation}`);
    return;
  }
  if (result.kind === "setup") {
    // OpenRouter output stays byte-identical; a Kimi setup/connect result is
    // rendered under its own name and never relabeled as OpenRouter.
    const prefix = result.backendId === "kimi-code" ? "Kimi Code · " : "";
    out.text(`${prefix}Provider setup: ${result.outcome}`);
    return;
  }
  if (result.kind === "status") {
    renderProviderStatusList(result.providers, out, balance);
    out.text(`Cross: ${result.crossEnabled ? "on" : "off"}`);
    return;
  }
  if (result.kind === "models") {
    out.text(result.models.length
      ? result.models.map((model) =>
          `${model.displayName} · ${model.requestedModelId} · ${model.canonicalModelId}`
        ).join("\n")
      : result.backendId === "kimi-code"
        ? "No usable Kimi Code models available."
        : "No usable OpenRouter models available.");
    return;
  }
  if (result.kind === "reconnected") {
    // `result.generation` is an internal retry-round counter (V3 audit
    // principle 4) — it never reaches user copy; it stays available on the
    // result type for callers that log or key off it internally.
    out.text(`${providerDisplayName(result.backendId)} · ${result.headline}`);
    return;
  }
  if (result.kind === "changed") {
    out.text(
      `${providerDisplayName(result.backendId)} ${result.operation}: changed`
      + `${result.defaultCleared ? " · default route removed" : ""}`
      + `${result.setupRequired ? " · provider setup required" : ""}`,
    );
    return;
  }
  if (result.kind === "unchanged") {
    out.text(`${providerDisplayName(result.backendId)}: unchanged · ${result.reason}`);
    return;
  }
  throw new Error("Provider confirmation did not settle.");
}

function printProviderStatus(context: CommandContext): void {
  const provider = context.config.provider;
  context.out.text(
    [
      `Sort: ${provider.sort ?? "Default (price/availability)"}`,
      `Data sharing: ${provider.dataCollection ?? DATA_COLLECTIONS[1]}`,
      `Provider fallbacks: ${provider.allowFallbacks === false ? "off" : "on"}`,
      provider.only?.length ? `Only: ${provider.only.join(", ")}` : "",
      provider.ignore?.length ? `Excluded: ${provider.ignore.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

async function fallbackCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      context.config.fallbackModels.length
        ? `Fallback chain: ${context.config.mainModel} → ${context.config.fallbackModels.join(" → ")}`
        : `Fallback chain: ${context.config.mainModel} (no fallbacks)`,
    );
    context.out.text(theme.color("muted")("Set: /fallback +<model> · /fallback -<model> · /fallback clear"));
    return;
  }
  if (action === "clear") {
    context.config.fallbackModels = [];
  } else if (args[0]?.startsWith("+")) {
    const model = args[0].slice(1).trim();
    if (!model) {
      throw new Error("Usage: /fallback +<provider/model>");
    }
    await resolveMainModelCandidate(context.openRouter, model);
    const next = new Set(context.config.fallbackModels);
    next.add(model);
    context.config.fallbackModels = [...next];
  } else if (args[0]?.startsWith("-")) {
    const model = args[0].slice(1).trim();
    context.config.fallbackModels = context.config.fallbackModels.filter(
      (entry) => entry !== model,
    );
  } else {
    throw new Error("Usage: /fallback [+<model>|-<model>|clear]");
  }
  await saveContextConfig(context);
  context.out.text(
    context.config.fallbackModels.length
      ? theme.color("ok")(`Fallback chain: ${context.config.mainModel} → ${context.config.fallbackModels.join(" → ")}`)
      : theme.color("ok")("Fallback chain cleared."),
  );
}

function includesValue<T extends readonly string[]>(list: T, value: string): value is T[number] {
  return (list as readonly string[]).includes(value);
}

async function initInstructions(context: CommandContext): Promise<void> {
  const local = commandLocalRuntime(context);
  const target = await local.guard.resolvePath("ORCODE.md");
  // Also refuse to overwrite a pre-rename `ROUTERCODE.md`: creating a second,
  // redundant instructions file next to it would be more confusing than
  // helpful, and `loadProjectNotes` already reads both if both exist.
  const legacyTarget = await local.guard.resolvePath("ROUTERCODE.md");
  for (const [existing, label] of [
    [target, "ORCODE.md"],
    [legacyTarget, "ROUTERCODE.md"],
  ] as const) {
    try {
      await readFile(existing, "utf8");
      context.out.text(`${label} already exists and was not overwritten.`);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  await context.approvals.authorize(
    writeApprovalRequest("init", local.guard.display(target), {
      summary: "Create ORCODE.md in this folder",
      details:
        "Project commands, conventions, boundaries, and definition-of-done can be recorded there permanently.",
    }),
  );
  await writeFile(
    target,
    `# orcode project instructions

## Project

- Describe the project and important directories.

## Commands

- Build:
- Test:
- Lint:

## Conventions

- Add project-specific coding and review rules here.

## Safety

- Add paths or operations the agent must not touch.

## Done means

- Define the checks required before work is considered complete.
`,
    { encoding: "utf8", mode: 0o644 },
  );
  // FIX-10 M6: the success line names the file the way the approval confirm
  // just did (`local.guard.display`), not the raw resolved path — one
  // spelling for the same file within one flow.
  context.out.text(commandTheme(context).color("ok")(`Created: ${local.guard.display(target)}`));
}

/**
 * `/ssh`: lists hosts from `~/.ssh/config`, checks one, or ends the
 * remembered session. Never asks for or forwards a password — reachability
 * and auth both ride on `ssh -o BatchMode=yes`, so a missing key comes back
 * as a clear message instead of a hang. See `src/ssh.ts`/`src/ssh-config.ts`.
 */
async function sshCommand(args: string[], context: CommandContext): Promise<void> {
  const theme = commandTheme(context);
  const runSsh: RunSsh =
    context.sshRunner ??
    ((sshArgs, runOptions) => runProcess("ssh", sshArgs, runOptions));
  // `checkHost`/`closeSshControl` create the ControlMaster socket directory
  // as a side effect even with a fake `runSsh` — this MUST stay overridable,
  // or a test without `sshAppHome` silently touches the real ~/.orcode.
  const runtime = context.sshAppHome ? { appHome: context.sshAppHome } : {};
  const first = (args[0] ?? "").toLowerCase();

  if (first === "off") {
    const session = context.sshSession;
    const active = session?.active ?? null;
    if (!session || !active) {
      context.out.text("No active SSH session.");
      return;
    }
    // Disable first: the dashboard and any later tool execution must observe
    // `/ssh off` immediately, even while the best-effort ControlMaster close
    // is still pending. Never write this field again after the await — a
    // concurrently selected newer target owns the shared session by then.
    session.active = null;
    const close = await closeSshControl(active, runSsh, runtime);
    if (close.error) {
      context.out.error(
        `SSH target "${active}" is disabled, but the control connection could not be confirmed closed.`,
        close.error,
      );
      return;
    }
    context.out.text(theme.color("ok")(`SSH session to "${active}" disconnected.`));
    return;
  }

  if (first === "status") {
    const active = context.sshSession?.active ?? null;
    if (!active) {
      context.out.text(`No active SSH target ${theme.glyph("emdash")} /ssh <alias> connects one.`);
      return;
    }
    const hosts = await loadSshHosts({ configPath: context.sshConfigPath });
    const result = await checkHost(active, hosts, runSsh, runtime);
    context.out.text(`Active SSH target: ${active} — ${result.message}`);
    return;
  }

  const hosts = await loadSshHosts({ configPath: context.sshConfigPath });
  if (!first) {
    if (!hosts.length) {
      context.out.text("No named hosts found in ~/.ssh/config.");
      return;
    }
    context.out.text(theme.color("text", { bold: true })("SSH hosts from ~/.ssh/config"));
    const active = context.sshSession?.active;
    // Phase 3b, Part D.3: the standard numbered-list look only — still plain
    // text, still selected by alias, not by number (zero behavior change).
    hosts.forEach((host, index) => {
      // Explicit "(active)" label — the `active` role, not `ok` (same
      // reasoning as the ● markers above: this names a live state, not a
      // completed action).
      const marker = active === host.alias ? theme.color("active")(" (active)") : "";
      context.out.text(
        `${index + 1}. ${host.alias}${marker} → ${host.hostName}${host.user ? ` (${host.user})` : ""}`,
      );
    });
    context.out.text("Usage: /ssh <alias> | /ssh status | /ssh off");
    return;
  }

  const alias = args[0]!;
  const result = await checkHost(alias, hosts, runSsh, runtime);
  if (result.status === "reachable") {
    if (!context.sshSession) {
      context.sshSession = createSshSession();
    }
    context.sshSession.active = alias;
    context.out.text(theme.color("ok")(result.message));
    context.out.text(
      `SSH target set: ${alias}. ssh_command now runs against this host until /ssh off.`,
    );
    return;
  }
  context.out.text(result.status === "no-auth" ? theme.color("warn")(result.message) : theme.color("danger")(result.message));
}

function tokenize(value: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match[1] !== undefined) {
      result.push(unescapeMatchingQuote(match[1], '"'));
    } else if (match[2] !== undefined) {
      result.push(unescapeMatchingQuote(match[2], "'"));
    } else {
      result.push(match[3]!);
    }
  }
  return result;
}

function unescapeMatchingQuote(value: string, quote: '"' | "'"): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\\" && value[index + 1] === quote) {
      decoded += quote;
      index += 1;
    } else {
      decoded += character;
    }
  }
  return decoded;
}


async function selectModel(
  model: ModelInfo,
  context: CommandContext,
): Promise<void> {
  await context.providerRoutes?.transitionModel(
    model.id,
    model.canonicalSlug ?? model.id,
    context.providerRouteSurface,
  );
  context.config.mainModel = model.id;
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await saveContextConfig(context);
  await context.session.save();
  printModelDetails(model, true, context.out);
}

export function rankModels(
  models: ModelInfo[],
  term: string,
  currentModel: string,
): ModelInfo[] {
  const needle = term.trim().toLowerCase();
  return models
    .filter((model) => {
      if (!needle) {
        return true;
      }
      const fields = needle.length < 3
        ? [model.id, model.name]
        : [
            model.id,
            model.name,
            model.description,
            model.modality ?? "",
            ...model.supportedParameters,
          ];
      const haystack = fields
        .join(" ")
        .toLowerCase();
      return needle.split(/\s+/).every((part) => haystack.includes(part));
    })
    .map((model, index) => ({
      model,
      score: modelSearchScore(model, needle, currentModel) - index / 10_000,
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ model }) => model);
}

export function isTextGenerationModel(model: ModelInfo): boolean {
  return isCompressorModelCandidate(model);
}

export type ModelRole = "main" | "compressor";

export class ModelCapabilityError extends Error {
  constructor(
    readonly role: ModelRole,
    readonly modelId: string,
  ) {
    super(
      role === "main"
        ? `The model ${modelId} is incompatible with the main role: needs text input, text output, and tools.`
        // FIX-9: `role` stays the internal `"compressor"` union member —
        // only the sentence the owner reads uses the settings vocabulary.
        : `The model ${modelId} is incompatible with the summarizer role: needs text output.`,
    );
    this.name = "ModelCapabilityError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(
    readonly role: ModelRole,
    readonly modelId: string,
  ) {
    super(`No model with the exact ID found in the OpenRouter catalog: ${modelId}`);
    this.name = "ModelNotFoundError";
  }
}

type ModelCatalog = Pick<OpenRouterService, "listModels">;

export function mainModelCandidates(
  models: readonly ModelInfo[],
): ModelInfo[] {
  return models.filter(isMainModelCandidate);
}

export function compressorModelCandidates(
  models: readonly ModelInfo[],
): ModelInfo[] {
  return models.filter(isCompressorModelCandidate);
}

export function isPanelModelCandidate(model: ModelInfo): boolean {
  return model.inputModalities.includes("text")
    && model.outputModalities.includes("text");
}

export function panelModelCandidates(models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter(isPanelModelCandidate);
}

export function isAudioInputModelCandidate(model: ModelInfo): boolean {
  return model.inputModalities.includes("audio")
    && model.outputModalities.includes("text");
}

export function audioInputModelCandidates(models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter(isAudioInputModelCandidate);
}

export async function resolveMainModelCandidate(
  openRouter: ModelCatalog,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelInfo | null> {
  if (modelId === "openrouter/auto") {
    return null;
  }
  const matches = await openRouter.listModels(modelId, false, signal);
  const exact = matches.find((candidate) => candidate.id === modelId);
  if (!exact) {
    throw new ModelNotFoundError("main", modelId);
  }
  if (!isMainModelCandidate(exact)) {
    throw new ModelCapabilityError("main", modelId);
  }
  return exact;
}

export async function resolveCompressorModelCandidate(
  openRouter: ModelCatalog,
  modelId: string,
  signal?: AbortSignal,
): Promise<ModelInfo> {
  const matches = await openRouter.listModels(modelId, false, signal);
  const exact = matches.find((candidate) => candidate.id === modelId);
  if (!exact) {
    throw new ModelNotFoundError("compressor", modelId);
  }
  if (!isCompressorModelCandidate(exact)) {
    throw new ModelCapabilityError("compressor", modelId);
  }
  return exact;
}

export async function pickModel(
  models: ModelInfo[],
  currentModel: string,
  pick: typeof pickFromListPlain = pickFromListPlain,
): Promise<ModelInfo | null> {
  return pick<ModelInfo>({
    title: "Search models",
    choices: (query) =>
      rankModels(models, query, currentModel)
        .slice(0, 80)
        .map((model) => ({
          value: model,
          name: `${model.name}  [${model.id}]`,
          description: modelChoiceDescription(model),
        })),
  });
}

/**
 * F6 formatter consolidation (parked from F3 review): the actual `$X/M`
 * string math now delegates to `formatCatalogPricePerMillion` (utils.ts,
 * the survivor of four near-identical per-million formatters this file,
 * cli.ts and utils.ts each grew separately) — its trimmed-decimal output is
 * the honesty-safest of the three ("$3/M" rather than a fixed "$3.000/M"
 * that implies false precision, and never silently rounds a real sub-cent
 * price down to "$0/M"). This wrapper keeps the two domain guards that are
 * load-bearing at its own unguarded call site (`/models`'s per-model price
 * table, below): `-1` is this codebase's "dynamic/provider-managed" price
 * sentinel (see `priceSummary`, `summarizeModel`), and a genuinely free
 * model reads "free" rather than "$0/M".
 */
export function formatPricePerMillion(perToken: number): string {
  if (perToken < 0) {
    return "variable";
  }
  if (perToken === 0) {
    return "free";
  }
  return formatCatalogPricePerMillion(perToken);
}

/**
 * The plain legacy ModelInfo picker's row detail (Phase F3, information-
 * dense pickers): same `<provider> · <price> · <ctx>` shape and the same
 * honesty rule (`formatModelRouteDetail`, `utils.ts`) as the route-catalog
 * pickers, derived from the raw OpenRouter catalog fields this picker still
 * works from directly. `-1` is this catalog's own established "dynamic /
 * provider-managed" sentinel (see `priceSummary`, `formatPricePerMillion`
 * below) — never rendered as a fabricated price. `model.id`'s vendor slug
 * (before the first `/`) is the only provider label ModelInfo carries; it
 * is lower-case (e.g. `"anthropic"`, not `"Anthropic"`) unlike the
 * route-catalog pickers' friendlier `providerLabel` — the same derivation
 * `printModelDetails` already uses, not a second guess at branding.
 */
export function modelChoiceDescription(model: ModelInfo): string {
  const provider = model.id.split("/")[0] || "unknown";
  const dynamic = model.promptPrice < 0 || model.completionPrice < 0;
  return formatModelRouteDetail({
    providerLabel: provider,
    price: dynamic
      ? { kind: "subscription" }
      : {
          kind: "known",
          promptUsdPerToken: model.promptPrice,
          completionUsdPerToken: model.completionPrice,
        },
    contextLength: model.contextLength,
  });
}

function printModelDetails(model: ModelInfo, selected: boolean, out: CommandOutput): void {
  const theme = plainTheme();
  out.text(theme.color("ok", { bold: true })(selected ? "\nModel selected" : "\nActive model"));
  out.text(`Name: ${model.name}`);
  // Identity highlight for a single-subject detail view, not a live/selected
  // marker among alternatives (contrast with the chat/approval-mode ● bullets
  // above, which do use `active`) — cyan's default mapping, `accent`.
  out.text(`ID: ${theme.color("accent")(model.id)}`);
  out.text(`Provider: ${model.id.split("/")[0] ?? "unknown"} · Routing: OpenRouter`);
  out.text(`Price: ${priceSummary(model)}`);
  out.text(
    `Context: ${model.contextLength.toLocaleString("en-US")} tokens${
      model.maxCompletionTokens
        ? ` · max output ${model.maxCompletionTokens.toLocaleString("en-US")}`
        : ""
    }`,
  );
  const capabilities = capabilityLabels(model);
  if (capabilities.length) {
    out.text(`Capabilities: ${capabilities.join(", ")}`);
  }
  if (model.reasoning?.supportedEfforts?.length) {
    out.text(`Reasoning levels: ${model.reasoning.supportedEfforts.join(", ")}`);
  }
  if (model.reasoning?.supportsMaxTokens) {
    out.text("Reasoning token budget: supported");
  }
  const scores = [
    model.intelligenceIndex === undefined ? "" : `Intelligence ${model.intelligenceIndex}`,
    model.codingIndex === undefined ? "" : `Coding ${model.codingIndex}`,
    model.agenticIndex === undefined ? "" : `Agentic ${model.agenticIndex}`,
  ].filter(Boolean);
  if (scores.length) {
    out.text(`Artificial Analysis indices: ${scores.join(" · ")}`);
  }
  if (model.description) {
    out.text(`Info: ${truncate(model.description, 700)}`);
  }
  out.text("");
}

async function findCurrentModel(
  openRouter: OpenRouterService,
  modelId: string,
): Promise<ModelInfo | null> {
  try {
    return await resolveMainModelCandidate(openRouter, modelId);
  } catch {
    return null;
  }
}

function normalizeReasoningEffort(value: string): ReasoningEffort | null {
  const normalized =
    value === "ultra" || value === "ultrahigh" ? "xhigh" : value;
  return REASONING_EFFORTS.includes(normalized as ReasoningEffort)
    ? normalized as ReasoningEffort
    : null;
}

function modelSearchScore(
  model: ModelInfo,
  needle: string,
  currentModel: string,
): number {
  let score = model.id === currentModel ? 20_000 : 0;
  if (!needle) {
    score += model.id === "openrouter/auto" ? 10_000 : 0;
    score += (model.codingIndex ?? 0) * 10;
    score += (model.agenticIndex ?? 0) * 3;
    return score;
  }
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  if (id === needle) score += 15_000;
  if (name === needle) score += 14_000;
  if (name.startsWith(needle)) score += 8_000;
  if (id.startsWith(needle)) score += 7_000;
  if (new RegExp(`(^|[/\\s:_-])${escapeRegExp(needle)}`).test(id)) score += 6_000;
  if (new RegExp(`(^|[/\\s:_-])${escapeRegExp(needle)}`).test(name)) score += 5_000;
  if (id.includes(needle)) score += 2_000;
  if (name.includes(needle)) score += 1_500;
  score += (model.codingIndex ?? 0) * 2;
  return score;
}

function priceSummary(model: ModelInfo): string {
  if (model.promptPrice < 0 || model.completionPrice < 0) {
    return "dynamic/depends on the routed model";
  }
  if (model.promptPrice === 0 && model.completionPrice === 0) {
    return "free";
  }
  return `Input ${formatPricePerMillion(model.promptPrice)} · Output ${formatPricePerMillion(model.completionPrice)}`;
}

function capabilityLabels(model: ModelInfo): string[] {
  const labels: string[] = [];
  if (model.supportedParameters.includes("tools")) labels.push("Tools");
  if (model.supportedParameters.includes("reasoning")) labels.push("Reasoning");
  if (model.supportedParameters.includes("structured_outputs")) labels.push("Structured Output");
  if (model.inputModalities.includes("image")) labels.push("Images");
  if (model.inputModalities.includes("audio")) labels.push("Audio");
  if (model.isModerated) labels.push("moderated");
  return labels;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Should the stored key be thrown away and replaced?
 *
 * Only a structured HTTP 401 from the active OpenRouter request invalidates
 * the credential. Permission, money, expiry metadata and connectivity are
 * separate states and never authorize deleting a saved key.
 */
export function shouldReplaceCredential(
  error: unknown,
  openRouter?: OpenRouterService,
): boolean {
  return error instanceof PanelAuthenticationRejectedError
    || (isRecord(error) && error.code === "provider-authentication-rejected")
    || openRouter?.runtimeState.inferenceValidity === "rejected";
}

/** A raw 401 is only meaningful inside the request that owns its scope. */
export function isAuthenticationRejection(error: unknown): boolean {
  return error instanceof OpenRouterHttpError && error.status === 401;
}

function originLabel(origin: KeyOrigin): string {
  if (origin === "keychain") return "Stored API key";
  if (origin === "environment") return "OPENROUTER_API_KEY";
  return "API key";
}

function keyStatusLabel(origin: KeyOrigin, location: string): string {
  if (origin === "keychain") return `stored in ${location}`;
  if (origin === "environment") return "from environment variable";
  if (origin === "interactive") return "process-only";
  return "not set";
}

function credentialValidityLabel(
  value: OpenRouterService["runtimeState"]["inferenceValidity"],
): string {
  if (value === "valid") return "last valid";
  if (value === "rejected") return "rejected by OpenRouter";
  return "not checked yet";
}

/**
 * FIX-14 ticket 15 (FIX-15 residual). This used to append
 * `· /provider reconnect openrouter available` to the disconnected state
 * unconditionally — advice that is simply false for a key the owner
 * accepted interactively, since `/provider reconnect openrouter` resolves
 * credentials through `ProviderCredentialAuthority`, whose permit sources
 * are saved-or-environment only. Four lines further down the same command's
 * output, `recheckConnectionHint` was already branching on exactly that and
 * saying the opposite.
 *
 * There is one branched truth now, and it lives in `recheckConnectionHint`.
 * This function went back to being what its three neighbours
 * (`credentialValidityLabel`, `creditStateLabel`, `keyStatusLabel`) already
 * are: a state label that states the state and gives no advice. `/key
 * status` prints the hint once, from the one place that knows how to
 * qualify it.
 */
function connectivityLabel(
  value: OpenRouterService["runtimeState"]["connectivity"],
): string {
  if (value === "connected") return "connected";
  if (value === "disconnected") return "disconnected";
  return "not checked yet";
}

function creditStateLabel(
  value: OpenRouterService["runtimeState"]["credit"],
): string {
  if (value === "available") return "available";
  if (value === "insufficient") return "insufficient";
  if (value === "unavailable") return "unavailable";
  return "unknown";
}
