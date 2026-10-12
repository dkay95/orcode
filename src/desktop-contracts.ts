export type DesktopDisabledReasonCode =
  | "provider-not-connected" | "provider-connecting" | "provider-degraded"
  | "provider-disabled" | "provider-blocked" | "setup-method-unavailable"
  | "model-not-runnable" | "native-local-action-unavailable"
  | "codex-runtime-unavailable" | "codex-profile-isolation-unproven"
  | "account-authentication-required" | "account-limit-reached"
  | "route-stale" | "route-activation-failed" | "cross-routes-must-differ"
  | "cross-selection-incomplete" | "update-required";
export interface DesktopDisabledPresentation {
  readonly code: DesktopDisabledReasonCode;
  readonly label: string;
  readonly recoveryLabel?: string;
}
export type DesktopCommandDisabledReasonCode =
  | "run-active" | "cross-run-active" | "question-pending"
  | "command-in-flight" | "settings-open" | "no-run"
  | "terminal-only-picker" | "route-stale" | "provider-unavailable";
export interface DesktopCommandDisabledPresentation {
  readonly code: DesktopCommandDisabledReasonCode;
  readonly label: string;
  readonly recoveryLabel: string;
}
export interface DesktopCommandPresentation {
  readonly description: string;
  readonly actionLabel: "Ausführen" | "Einfügen" | "Öffnen";
  readonly currentLabel?: string;
  readonly disabled?: DesktopCommandDisabledPresentation;
}
export type DesktopSetupMethod =
  | "openrouter-owner-connect" | "codex-browser-login"
  | "codex-device-login" | "kimi-owner-connect";
export type DesktopProviderState =
  | "disconnected" | "connecting" | "ready" | "degraded" | "disabled" | "blocked";
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
  readonly dataPolicy: DesktopDataPolicyKnowledge;
  readonly runnable: boolean; readonly disabled?: DesktopDisabledPresentation;
}
export interface DesktopMultiProfileCapability {
  readonly enabled: boolean;
  readonly disabled?: DesktopDisabledPresentation;
}
export interface DesktopActiveRoute {
  readonly routeHandle: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly accountLabel: string | null;
}
export interface DesktopProviderCapability {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly connectionId: string | null;
  readonly accountLabel: string | null;
  readonly state: DesktopProviderState;
  readonly setupMethods: readonly DesktopSetupMethod[];
  readonly multiProfile: DesktopMultiProfileCapability;
  readonly routes: readonly DesktopRouteCandidate[];
  readonly disabled?: DesktopDisabledPresentation;
  readonly repair?: DesktopDisabledPresentation;
}
export interface DesktopCapabilitySnapshot {
  readonly schemaVersion: 1; readonly revision: number; readonly generation: number;
  readonly routeRunnable: boolean; readonly activeRoute: DesktopActiveRoute | null;
  readonly providers: readonly DesktopProviderCapability[]; readonly undoAvailable: boolean;
  readonly appearance: { readonly showLargeLogo: boolean; readonly showHeaderMark: boolean };
}
export interface DesktopOnboardingView {
  readonly revision: number; readonly generation: number; readonly step: OnboardingStep;
  readonly returnTo: "chat" | "model-picker" | "settings";
  readonly providers: readonly DesktopProviderCapability[];
  /** Opaque process-local identity present only while one operation is active. */
  readonly operationHandle?: string;
  readonly providerId?: string; readonly connectionId?: string; readonly accountLabel?: string;
  readonly candidates: readonly DesktopRouteCandidate[];
  readonly error?: DesktopDisabledPresentation;
}
export type OnboardingStep = "provider" | "account" | "model" | "binding" | "ready" | "error";
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
  | "setup-opened" | "setup-cancelled" | "setup-completed"
  | "settings-opened" | "settings-closed" | "engine-restarted"
  | "diagnostic-available";
export interface DesktopActivityMessagePresentation {
  readonly code: DesktopActivityMessageCode;
  readonly label: string;
}
export interface DesktopActivity {
  readonly id: string; readonly revision: number; readonly generation?: number;
  readonly kind: "setup" | "settings" | "engine" | "diagnostic";
  readonly level: "info" | "warning" | "error";
  readonly message: DesktopActivityMessagePresentation;
  readonly expiresAt?: number;
}
export interface NativeLocalActionRequirement {
  readonly kind: "kimi-setup" | "kimi-turn" | "kimi-cross";
  readonly revision: number; readonly generation: number;
  readonly purposeCode: "connect-membership" | "send-turn" | "start-cross";
}
export type DesktopSettingsCategoryId = "model" | "accounts" | "security" | "more";
export type DesktopSettingsControl = "boolean" | "choice" | "action" | "readonly" | "locked";
export type DesktopSettingsDisabledReasonCode =
  | "run-active" | "cross-run-active" | "cross-unavailable" | "cross-role-unset"
  | "cross-swap-incomplete" | "cross-routes-must-differ"
  | "external-model-role-unsupported"
  | "architect-unavailable" | "no-remembered-rules" | "no-verify-commands"
  | "voice-consent-required" | "model-catalog-unavailable"
  | "model-reasoning-unsupported" | "provider-not-connected"
  | "provider-degraded" | "config-changed-restart"
  | "config-unreadable" | "restart-required" | "setting-locked";
export interface DesktopSettingsDisabledPresentation {
  readonly code: DesktopSettingsDisabledReasonCode;
  readonly label: string;
  readonly recoveryLabel?: string;
}
export interface DesktopSettingsRow {
  readonly handle: string; readonly label: string; readonly description: string;
  readonly displayValue: string; readonly control: DesktopSettingsControl;
  /** Stable, display-only focus identity. Never accepted as mutation authority. */
  readonly focusKey?: string;
  readonly booleanValue?: boolean; readonly actionLabel?: string;
  readonly disabled?: DesktopSettingsDisabledPresentation;
}
export interface DesktopSettingsCategory {
  readonly id: DesktopSettingsCategoryId; readonly label: string; readonly description: string;
  readonly expanded: boolean;
  readonly commonItems: readonly DesktopSettingsRow[];
  readonly advancedItems: readonly DesktopSettingsRow[];
}
export type DesktopSettingsNoticeCode = "saved" | "cancelled" | "stale" | "failed";
export interface DesktopSettingsNoticePresentation {
  readonly code: DesktopSettingsNoticeCode;
  readonly level: "info" | "warning" | "error";
  readonly label: string;
}
export interface DesktopSettingsView {
  readonly revision: number; readonly categories: readonly DesktopSettingsCategory[];
  readonly selectedCategoryId: DesktopSettingsCategoryId;
  readonly search: Readonly<{ active: boolean; query: string; results: readonly DesktopSettingsRow[] }>;
  readonly notice: DesktopSettingsNoticePresentation | null;
  /** Optional server-owned focus return target, distinct from every mutation handle. */
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
export interface DesktopSettingsEditorNoticePresentation {
  readonly level: "warning" | "error";
  readonly label: string;
}
interface DesktopSettingsEditorBasePresentation {
  readonly kind: DesktopSettingsEditorKind;
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly busyLabel: string;
  readonly notice?: DesktopSettingsEditorNoticePresentation;
}
export interface DesktopSettingsChoiceEditorOption {
  readonly handle: string;
  readonly label: string;
  readonly selected: boolean;
}
export interface DesktopSettingsChoiceEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "choice";
  readonly options: readonly DesktopSettingsChoiceEditorOption[];
}
export interface DesktopSettingsNumberEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "number";
  readonly inputLabel: string;
  readonly initialValue: string;
  readonly constraintLabel: string;
  readonly submitLabel: string;
}
export interface DesktopSettingsTextEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "text";
  readonly inputLabel: string;
  readonly initialValue: string;
  readonly multiline: boolean;
  readonly submitLabel: string;
}
export interface DesktopSettingsConfirmEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "confirm";
  readonly destructive: boolean;
  readonly confirmLabel: string;
}
export interface DesktopSettingsInvokeEditorPresentation extends DesktopSettingsEditorBasePresentation {
  readonly kind: "invoke";
  readonly invokeLabel: string;
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
