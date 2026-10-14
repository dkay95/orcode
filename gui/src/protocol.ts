/**
 * The client half of the wire, as types.
 *
 * `src/gui-protocol.ts` in the orcode repo is the SOURCE OF TRUTH; this file
 * is the reader's view of it and adds nothing. It cannot import that module
 * (its type graph reaches into the core, which has no business in a
 * WebView), so `tests/protocol-inventory.test.ts` reads the real file and
 * fails the moment the two inventories drift.
 *
 * Two properties of the wire shape this whole frontend:
 *
 *  * `hello` means "the engine is speaking", NOT "the engine is ready".
 *    Readiness is the first successful `status.get`, and `engine-state.ts`
 *    is where that gate lives.
 *  * Events can arrive before the handshake is acknowledged — a startup
 *    failure must reach a client that never got far enough to ack.
 */

export const PROTOCOL_VERSION = 2;

export const REQUEST_TYPES = [
  "hello-ack",
  "submit",
  "cancel",
  "interject",
  "end-thinking",
  "command",
  "catalog.level",
  "catalog.search",
  "chats.list",
  "chat.open",
  "chat.new",
  "chat.delete",
  "status.get",
  "cost.forecast",
  "settings.open",
  "settings.dispatch",
  "desktop.snapshot.get",
  "official-cli.action",
  "local-run.action",
  "execution-policy.set",
  "project.open",
  "onboarding.dispatch",
  "settings.close",
  "answer",
  "shutdown",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const EVENT_NAMES = [
  "run",
  "assistant",
  "status",
  "transcript",
  "suggestions",
  "context-percent",
  "attachments",
  "draft",
  "command-output",
  "cross",
  "settings.view",
  "settings.closed",
  "desktop.snapshot",
  "local-run.state",
  "onboarding.view",
  "activity",
  "native-local-action-required",
  "setup.present",
  "chat.opened",
  "chat.reset",
  "notice",
  "fatal",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/**
 * The live Cross panel's frame, exactly as the engine projects it.
 *
 * Phase, verification and reason are the terminal's own labels. Live and
 * last-run roles carry safe provider/account/model facts plus canonical model
 * ID and capabilities. A settled panel may separately carry the current
 * next-run selection; no private route identity or credential crosses.
 */
export interface CrossPanelRoute {
  readonly providerLabel: string;
  readonly accountLabel: string;
  readonly displayName: string;
  readonly canonicalModelId: string;
  readonly reasoning: "supported" | "unsupported" | "unknown";
  readonly capabilities: readonly DesktopModelCapability[];
}

export interface CrossPanelSelection {
  readonly lead: CrossPanelRoute | null;
  readonly challenger: CrossPanelRoute | null;
}

export interface CrossPanel {
  readonly sequence: number;
  readonly updatedAt: number;
  readonly phase: string;
  readonly reason: string | null;
  readonly verification: string;
  readonly lead: CrossPanelRoute | null;
  readonly challenger: CrossPanelRoute | null;
  readonly selection?: CrossPanelSelection;
  readonly active?: boolean;
  readonly result?: string;
}

export const ASK_KINDS = [
  "confirm",
  "approval",
  "folder-path",
  "secret",
  "choice",
  "choose-hub",
  "choose-model",
  "settings-editor",
] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export interface HelloFrame {
  readonly t: "hello";
  readonly v: number;
  readonly protocol: number;
  readonly orcode: string;
  readonly node: string;
  readonly pid: number;
  readonly capabilities: readonly string[];
  readonly asks?: readonly string[];
}

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

export type ResponseFrame =
  | { readonly t: "response"; readonly v: number; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly t: "response"; readonly v: number; readonly id: string; readonly ok: false; readonly error: ErrorBody };

export interface EventFrame {
  readonly t: "event";
  readonly v: number;
  readonly e: EventName;
  readonly [key: string]: unknown;
}

export interface AskFrame {
  readonly t: "ask";
  readonly v: number;
  readonly askId: string;
  readonly kind: AskKind;
  readonly [key: string]: unknown;
}

export type ServerFrame = HelloFrame | ResponseFrame | EventFrame | AskFrame;

/* ---------------------------------------------------------------------- */

/* Desktop onboarding/settings wire contract. Mirrors src/desktop-contracts.ts. */

export type DesktopDisabledReasonCode =
  | "provider-not-connected" | "provider-connecting" | "provider-degraded"
  | "provider-disabled" | "provider-blocked" | "setup-method-unavailable"
  | "model-not-runnable" | "native-local-action-unavailable"
  | "codex-runtime-unavailable" | "codex-profile-isolation-unproven"
  | "account-authentication-required" | "account-limit-reached"
  | "route-stale" | "route-activation-failed" | "cross-routes-must-differ"
  | "cross-selection-incomplete" | "update-required";
export interface DesktopDisabledPresentation {
  readonly code: DesktopDisabledReasonCode; readonly label: string; readonly recoveryLabel?: string;
}
export type DesktopCommandDisabledReasonCode =
  | "run-active" | "cross-run-active" | "question-pending" | "command-in-flight"
  | "settings-open" | "no-run" | "terminal-only-picker" | "route-stale" | "provider-unavailable" | "local-flow-required";
export interface DesktopCommandDisabledPresentation {
  readonly code: DesktopCommandDisabledReasonCode; readonly label: string; readonly recoveryLabel: string;
}
export interface DesktopCommandPresentation {
  readonly description: string; readonly actionLabel: "Ausführen" | "Einfügen" | "Öffnen";
  readonly currentLabel?: string; readonly disabled?: DesktopCommandDisabledPresentation;
}
export type DesktopSetupMethod = "openrouter-owner-connect" | "codex-browser-login" | "codex-device-login" | "kimi-owner-connect" | "nanogpt-owner-connect";
export type DesktopProviderState = "disconnected" | "connecting" | "ready" | "degraded" | "disabled" | "blocked";
export type DesktopModelCapability = "text" | "image-input" | "tools" | "reasoning" | "patch";
export type DesktopCostKnowledge =
  | Readonly<{ kind: "known"; label: string; source: "provider" | "subscription" }>
  | Readonly<{ kind: "unknown"; label: "Kosten unbekannt" }>;
export type DesktopDataPolicyKnowledge =
  | Readonly<{ kind: "known"; label: string; source: "provider" | "owner-config" }>
  | Readonly<{ kind: "unknown"; label: "Datenrichtlinie unbekannt" }>;
export interface DesktopRouteCandidate {
  readonly handle: string; readonly providerId: string; readonly connectionId: string;
  readonly accountLabel: string; readonly canonicalModelId: string; readonly displayName: string;
  readonly reasoning: "supported" | "unsupported" | "unknown";
  readonly capabilities: readonly DesktopModelCapability[]; readonly cost: DesktopCostKnowledge;
  readonly dataPolicy: DesktopDataPolicyKnowledge; readonly runnable: boolean; readonly disabled?: DesktopDisabledPresentation;
}
export interface DesktopCrossRouteCandidate extends DesktopRouteCandidate {
  /** Canonical safe display label of the provider row that owns this route. */
  readonly providerLabel: string;
}
export type DesktopCrossDuration = "one-task" | "chat";
export interface DesktopCrossPreflightView {
  readonly lead: DesktopCrossRouteCandidate | null;
  readonly challenger: DesktopCrossRouteCandidate | null;
  readonly duration: DesktopCrossDuration | null;
  readonly estimatedCalls: { readonly min: 4; readonly max: 6 };
  readonly cost: DesktopCostKnowledge;
  readonly startDisabled: DesktopDisabledPresentation | null;
}
export interface DesktopMultiProfileCapability { readonly enabled: boolean; readonly disabled?: DesktopDisabledPresentation; }
export interface DesktopActiveRoute {
  readonly routeHandle: string; readonly providerLabel: string; readonly modelLabel: string; readonly accountLabel: string | null;
}
export interface DesktopProviderCapability {
  readonly providerId: string; readonly providerLabel: string;
  readonly connectionId: string | null; readonly accountLabel: string | null;
  readonly state: DesktopProviderState; readonly setupMethods: readonly DesktopSetupMethod[];
  readonly multiProfile: DesktopMultiProfileCapability; readonly routes: readonly DesktopRouteCandidate[];
  readonly disabled?: DesktopDisabledPresentation; readonly repair?: DesktopDisabledPresentation;
}
export interface DesktopCapabilitySnapshot {
  readonly schemaVersion: 1; readonly revision: number; readonly generation: number;
  readonly routeRunnable: boolean; readonly activeRoute: DesktopActiveRoute | null;
  readonly providers: readonly DesktopProviderCapability[]; readonly undoAvailable: boolean;
  readonly appearance: { readonly showLargeLogo: boolean; readonly showHeaderMark: boolean };
}
export type OnboardingStep = "provider" | "account" | "model" | "binding" | "ready" | "error";
export interface DesktopOnboardingView {
  readonly revision: number; readonly generation: number; readonly step: OnboardingStep; readonly returnTo: "chat" | "model-picker" | "settings";
  readonly providers: readonly DesktopProviderCapability[]; readonly operationHandle?: string;
  readonly providerId?: string; readonly connectionId?: string;
  readonly accountLabel?: string; readonly candidates: readonly DesktopRouteCandidate[]; readonly error?: DesktopDisabledPresentation;
}
export type DesktopOnboardingIntent =
  | Readonly<{ kind: "open-model-picker"; returnTo: "chat" | "model-picker"; revision: number; generation: number }>
  | Readonly<{ kind: "choose-provider"; providerId: string; revision: number; generation: number }>
  | Readonly<{ kind: "choose-account"; connectionId: string; revision: number; generation: number }>
  | Readonly<{ kind: "choose-model"; routeHandle: string; revision: number; generation: number }>
  | Readonly<{ kind: "retry" | "back"; revision: number; generation: number }>
  | Readonly<{ kind: "cancel"; revision: number; generation: number; operationHandle?: string }>;
export type DesktopOnboardingResult =
  | Readonly<{ kind: "view"; view: DesktopOnboardingView }>
  | Readonly<{ kind: "ready"; routeHandle: string; routeRunnable: true }>
  | Readonly<{ kind: "cancelled"; view: DesktopOnboardingView }>;
export type DesktopActivityMessageCode =
  | "setup-opened" | "setup-cancelled" | "setup-completed" | "settings-opened" | "settings-closed" | "engine-restarted" | "diagnostic-available";
export interface DesktopActivityMessagePresentation { readonly code: DesktopActivityMessageCode; readonly label: string; }
export interface DesktopActivity {
  readonly id: string; readonly revision: number; readonly generation?: number;
  readonly kind: "setup" | "settings" | "engine" | "diagnostic"; readonly level: "info" | "warning" | "error";
  readonly message: DesktopActivityMessagePresentation; readonly expiresAt?: number;
}
export interface NativeLocalActionRequirement {
  readonly kind: "kimi-setup" | "kimi-turn" | "kimi-cross"; readonly revision: number; readonly generation: number;
  readonly purposeCode: "connect-membership" | "send-turn" | "start-cross";
}
export type DesktopSettingsCategoryId = "model" | "accounts" | "security" | "more";
export type DesktopSettingsControl = "boolean" | "choice" | "action" | "readonly" | "locked";
export type DesktopSettingsDisabledReasonCode =
  | "run-active" | "cross-run-active" | "cross-unavailable" | "cross-role-unset" | "cross-swap-incomplete" | "cross-routes-must-differ"
  | "external-model-role-unsupported" | "architect-unavailable" | "no-remembered-rules" | "no-verify-commands" | "voice-consent-required"
  | "model-catalog-unavailable" | "model-reasoning-unsupported" | "provider-not-connected" | "provider-degraded" | "config-changed-restart"
  | "config-unreadable" | "restart-required" | "setting-locked";
export interface DesktopSettingsDisabledPresentation {
  readonly code: DesktopSettingsDisabledReasonCode; readonly label: string; readonly recoveryLabel?: string;
}
export interface DesktopSettingsRow {
  readonly handle: string; readonly label: string; readonly description: string; readonly displayValue: string;
  readonly control: DesktopSettingsControl; readonly focusKey?: string; readonly booleanValue?: boolean; readonly actionLabel?: string;
  readonly disabled?: DesktopSettingsDisabledPresentation;
}
export interface DesktopSettingsCategory {
  readonly id: DesktopSettingsCategoryId; readonly label: string; readonly description: string;
  readonly expanded: boolean;
  readonly commonItems: readonly DesktopSettingsRow[]; readonly advancedItems: readonly DesktopSettingsRow[];
}
export type DesktopSettingsNoticeCode = "saved" | "cancelled" | "stale" | "failed";
export interface DesktopSettingsNoticePresentation {
  readonly code: DesktopSettingsNoticeCode; readonly level: "info" | "warning" | "error"; readonly label: string;
}
export interface DesktopSettingsView {
  readonly revision: number; readonly categories: readonly DesktopSettingsCategory[]; readonly selectedCategoryId: DesktopSettingsCategoryId;
  readonly search: Readonly<{ active: boolean; query: string; results: readonly DesktopSettingsRow[] }>;
  readonly notice: DesktopSettingsNoticePresentation | null;
  readonly initialFocusKey?: string;
}
export type DesktopSettingsIntent =
  | Readonly<{ kind: "select-category"; categoryId: DesktopSettingsCategoryId; revision: number }>
  | Readonly<{ kind: "search-change"; query: string; revision: number }>
  | Readonly<{ kind: "toggle-advanced"; categoryId: DesktopSettingsCategoryId; revision: number }>
  | Readonly<{ kind: "activate-row"; handle: string; revision: number }>
  | Readonly<{ kind: "set-boolean"; handle: string; value: boolean; revision: number }>
  | Readonly<{ kind: "back"; revision: number }>;

export type DesktopSettingsEditorKind = "choice" | "number" | "text" | "confirm" | "invoke";
export interface DesktopSettingsEditorNoticePresentation { readonly level: "warning" | "error"; readonly label: string; }
interface DesktopSettingsEditorBasePresentation {
  readonly kind: DesktopSettingsEditorKind; readonly title: string; readonly description: string;
  readonly cancelLabel: string; readonly busyLabel: string; readonly notice?: DesktopSettingsEditorNoticePresentation;
}
export interface DesktopSettingsChoiceEditorOption { readonly handle: string; readonly label: string; readonly selected: boolean; }
export interface DesktopSettingsChoiceEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "choice"; readonly options: readonly DesktopSettingsChoiceEditorOption[];
}
export interface DesktopSettingsNumberEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "number"; readonly inputLabel: string; readonly initialValue: string; readonly constraintLabel: string; readonly submitLabel: string;
}
export interface DesktopSettingsTextEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "text"; readonly inputLabel: string; readonly initialValue: string; readonly multiline: boolean; readonly submitLabel: string;
}
export interface DesktopSettingsConfirmEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "confirm"; readonly destructive: boolean; readonly confirmLabel: string;
}
export interface DesktopSettingsInvokeEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "invoke"; readonly invokeLabel: string;
}
export type DesktopSettingsEditorPresentation =
  | DesktopSettingsChoiceEditorPresentation
  | DesktopSettingsNumberEditorPresentation
  | DesktopSettingsTextEditorPresentation
  | DesktopSettingsConfirmEditorPresentation
  | DesktopSettingsInvokeEditorPresentation;
export type DesktopSettingsEditorDecision =
  | Readonly<{ kind: "cancel" }>
  | Readonly<{ kind: "choice"; optionHandle: string }>
  | Readonly<{ kind: "number" | "text"; value: string }>
  | Readonly<{ kind: "confirm"; accepted: boolean }>
  | Readonly<{ kind: "invoke" }>;

export interface DesktopSnapshotGetRequest { readonly v: 2; readonly t: "desktop.snapshot.get"; }
export interface DesktopOnboardingDispatchRequest { readonly v: 2; readonly t: "onboarding.dispatch"; readonly intent: DesktopOnboardingIntent; }
export interface DesktopSettingsDispatchRequest { readonly v: 2; readonly t: "settings.dispatch"; readonly intent: DesktopSettingsIntent; }
export interface DesktopSettingsCloseRequest { readonly v: 2; readonly t: "settings.close"; }
export interface DesktopSnapshotEvent { readonly snapshot: DesktopCapabilitySnapshot; }
export interface DesktopOnboardingViewEvent { readonly view: DesktopOnboardingView; }
export interface DesktopActivityEvent { readonly activity: DesktopActivity; }
export interface NativeLocalActionRequiredEvent { readonly requirement: NativeLocalActionRequirement; }

export interface GuiPaletteRow {
  readonly kind: "node" | "match" | "recovery"; readonly command?: string; readonly name: string; readonly description: string;
  readonly usage?: string; readonly group?: string; readonly verb: "run" | "insert" | "open"; readonly presentation: DesktopCommandPresentation;
}

/* ---------------------------------------------------------------------- */

/** `status.get`'s result. Every figure a tri-state, exactly as the TUI's. */
export interface GuiStatus {
  readonly model: string;
  readonly resolvedModel: string;
  readonly workspace: string;
  readonly chatId: string;
  readonly chatTitle: string;
  readonly approval: string;
  readonly routeConnected: boolean | undefined;
  readonly providerManaged: boolean;
  readonly balanceRemainingUsd: number | undefined;
  readonly balanceHedged: true;
  readonly lowBalanceThresholdUsd: number;
  readonly dayUsd: number | undefined;
  readonly sessionUsd: number;
  readonly sessionCostKnowledge: "known" | "unknown";
  readonly runActive: boolean;
  /**
   * What the ENGINE derived for itself. The shell states a mode when it
   * spawns the sidecar, and the sidecar treats that as corroborating rather
   * than load-bearing — a launcher's claim about itself is not proof.
   * `ownerPathsAllowed` is false here, and Kimi Code setup and non-OpenRouter
   * credential recovery are refused with the reason.
   */
  readonly executionMode: string;
  readonly ownerPathsAllowed: boolean;
}

/** `cost.forecast`'s answer — three states, none of them a guess. */
export interface CostForecast {
  readonly kind: "band" | "unknown" | "none";
  /** The exact text the status line shows; absent means NO segment at all. */
  readonly text?: string;
  readonly minUsd?: number;
  readonly maxUsd?: number;
}

/** One `chats.list` row. `costKnowledge` absent means known. */
export interface ChatRow {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly turnCount: number;
  readonly costUsd: number;
  readonly costKnowledge?: "known" | "unknown";
  readonly model?: string;
  readonly updatedAt: string;
  readonly workspaceVerified?: boolean;
}

export interface ChatOpened {
  readonly chatId: string;
  readonly title: string;
  readonly workspace: string;
  /** Opening a chat in another folder MOVES the runtime. Never silent. */
  readonly rerooted: boolean;
  readonly turnCount: number;
  readonly untouched: boolean;
  readonly opened?: boolean;
  readonly reason?: string;
}

export interface ChatTurn {
  readonly role: string;
  readonly content: string;
  readonly [key: string]: unknown;
}

/* --- the run stream, 1:1 (src/types.ts `AgentRunEvent`) ----------------- */

export interface RunEventBase {
  readonly type: string;
  readonly timestamp: number;
  readonly [key: string]: unknown;
}

export type RunOutcome =
  | "complete"
  | "step-limit"
  | "cost-limit"
  | "error"
  | "cancelled"
  | "unverified";

/* --- asks --------------------------------------------------------------- */

/**
 * D4 (`approval.ts`), as it crosses the wire.
 *
 * Three states, and the third is not a rounding of the other two: `danger`
 * renders an explicit Confirm that is never the default and prints the
 * consequence on its own line; ordinary accepts on Enter; and ordinary with
 * `defaultAccept:false` is ordinary in presentation with danger's key
 * grammar — the state `/panel`'s spend confirm needs, which must not be
 * dressed up as destructive.
 */
export interface ConfirmAsk {
  readonly title: string;
  readonly consequence?: string;
  readonly danger: boolean;
  readonly defaultAccept: boolean;
}

export interface ToolCallPreview {
  readonly name: string;
  readonly risk: string;
  readonly summary: string;
  readonly details?: string;
  readonly subject?: string;
  readonly rememberAvailable?: boolean;
}

export interface ApprovalAsk {
  readonly preview: ToolCallPreview;
  readonly rememberAvailable: boolean;
  readonly reasonAvailable: boolean;
  readonly danger: boolean;
}

export interface ChoiceItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /**
   * FIX-14: the same wording as INDIVISIBLE parts. A row that has room for
   * only some of them sheds whole parts and never cuts inside one — `est.
   * from $0…` for a real floor of $0.068 reads as "from $0", i.e. free.
   */
  readonly descriptionParts?: readonly string[];
}

/* --- requests ----------------------------------------------------------- */

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!value || typeof value !== "object") return false;
  const t = (value as { t?: unknown }).t;
  return t === "hello" || t === "response" || t === "event" || t === "ask";
}

/**
 * A line off the pipe.
 *
 * A line that is not protocol JSON is NEVER content: rendering it as chat
 * text is exactly how the core's own stray stdout writes (G0's R1) would
 * reappear as a message. It is counted and named instead.
 */
export function parseFrame(line: string): ServerFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isServerFrame(parsed) ? parsed : null;
}
