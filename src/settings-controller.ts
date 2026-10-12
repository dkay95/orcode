import {
  ConfigEditConflictError,
  ConfigEditUnverifiedError,
  type BudgetAction,
  type ConfigEditSnapshot,
  type ConfigInput,
  type DataCollectionPreference,
  type GlyphMode,
  type OrcodeConfigWithBudget,
  type ProviderSortPreference,
  type VerifyMode,
  type WebMode,
  validatePanelModelSelection,
  validateConfig,
} from "./config.js";
import {
  isAudioInputModelCandidate,
  isPanelModelCandidate,
  type ProviderCommandIntent,
} from "./commands.js";
import {
  DEFAULT_REASONING_SETTING,
  getReasoningSetting,
  reasoningChoiceValue,
} from "./reasoning.js";
import {
  SETTINGS_CATEGORY_IDS,
  buildSettingsRegistry,
  searchSettings,
  type ProviderBackendAction,
  type SettingsActionId,
  type SettingsArchitectExecutorProjection,
  type SettingsAuthoritativeSnapshot,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsEditorDescriptor,
  type SettingsItem,
  type SettingsItemId,
  type SettingsProviderProjection,
} from "./settings-registry.js";
import type {
  ApprovalMode,
  CompressionMode,
  Notice,
  ReasoningEffort,
  ReasoningSetting,
} from "./types.js";
import {
  createNeverConfiguredProviderState,
} from "./provider-state.js";
import { parsePublicRoutePickerSelection } from "./model-route-catalog.js";
import type { RoutePickerSelectionIntent } from "./route-picker.js";

export type SettingsConfigProjection =
  & Omit<OrcodeConfigWithBudget, "providerSetup" | "architectExecutor">
  & { readonly architectExecutor: SettingsArchitectExecutorProjection | null };

export type SettingsControllerSnapshot = Omit<SettingsAuthoritativeSnapshot, "config"> & {
  readonly config: SettingsConfigProjection;
};

/** Explicit allow-list: provider identities and credential slots never enter Settings state. */
export function projectSettingsConfig(
  config: OrcodeConfigWithBudget | SettingsConfigProjection,
): SettingsConfigProjection {
  return freezeClone({
    schemaVersion: config.schemaVersion,
    mainModel: config.mainModel,
    compressorModel: config.compressorModel,
    compressionMode: config.compressionMode,
    compressionThresholdChars: config.compressionThresholdChars,
    approvalMode: config.approvalMode,
    maxSteps: config.maxSteps,
    maxCostUsd: config.maxCostUsd,
    compressorMaxCostUsd: config.compressorMaxCostUsd,
    reasoningByModel: config.reasoningByModel,
    transcriptionModel: config.transcriptionModel,
    voiceConsentGiven: config.voiceConsentGiven,
    budget: config.budget,
    fallbackModels: config.fallbackModels,
    provider: config.provider,
    web: config.web,
    verify: config.verify,
    contextBudgetRatio: config.contextBudgetRatio,
    panelModels: config.panelModels,
    panelJudge: config.panelJudge,
    browserPath: config.browserPath,
    browserTimeoutSeconds: config.browserTimeoutSeconds,
    appearance: config.appearance,
    lowBalanceThresholdUsd: config.lowBalanceThresholdUsd,
    // The persisted value is a whole `RouteIdentityV1`, `accountFingerprint`
    // included — the one field the Settings row renders is all that may pass
    // the allow-list above, the same reduction
    // `projectSettingsProviderStatus`'s `selectedModel` already applies.
    architectExecutor: config.architectExecutor
      ? { requestedModelId: config.architectExecutor.requestedModelId }
      : null,
  });
}

export type SettingsIntent =
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "page"; readonly delta: -1 | 1 }
  | { readonly kind: "boundary"; readonly edge: "first" | "last" }
  | { readonly kind: "category"; readonly categoryId: SettingsCategoryId }
  | { readonly kind: "search-start" }
  | { readonly kind: "search-change"; readonly query: string }
  | { readonly kind: "activate" }
  | { readonly kind: "select-item"; readonly itemId: SettingsItemId }
  | { readonly kind: "back" };

export interface SettingsModelRouteValue {
  readonly kind: "model-route";
  readonly selection: RoutePickerSelectionIntent;
}

export type SettingsEditorValue =
  | string
  | number
  | boolean
  | readonly string[]
  | SettingsModelRouteValue;

export interface SettingsEditorRequest {
  /** Monotonic issuance token, additionally bound by object identity. */
  readonly generation: number;
  readonly categoryId: SettingsCategoryId;
  readonly itemId: SettingsItemId;
  readonly label: string;
  readonly description: string;
  readonly editor: SettingsEditorDescriptor;
  readonly initialValue?: SettingsEditorValue;
  readonly validationMessage?: string;
  /**
   * cross-lead-model/cross-challenger-model only: the counterpart ROLE whose
   * currently configured route the picker must exclude — present exactly when
   * that counterpart is set.
   *
   * F1b: this used to be the counterpart's whole `RouteIdentityV1`, so every
   * editor request for a Cross row carried an `accountFingerprint` out through
   * the surface seam. The picker's exclusion genuinely needs the full identity
   * (`sameCanonicalModelRoute` compares account and billing realm, and the
   * catalog really can offer the same canonical model on two accounts), so it
   * is resolved runtime-side now, where the pair already lives: the picker
   * turns this role name back into the route it must drop
   * (`createTerminalModelRoutePicker`, tui.ts). Settings names the role; only
   * the runtime knows the identity.
   */
  readonly excludeCrossRole?: "lead" | "challenger";
}

export type SettingsControllerEffect =
  | { readonly kind: "render" }
  | { readonly kind: "close" }
  | { readonly kind: "edit"; readonly request: SettingsEditorRequest };

export type SettingsEditorResult =
  | { readonly kind: "cancel" }
  | { readonly kind: "value"; readonly value: SettingsEditorValue };

declare const SETTINGS_DESKTOP_OPERATION_TOKEN: unique symbol;

/**
 * An in-process capability for one Desktop-owned editor conversation.
 *
 * The brand is intentionally not constructible outside this module and the
 * controller additionally compares the runtime object by identity. It is
 * never copied into a request or projection capture.
 */
export interface SettingsDesktopOperationToken {
  readonly [SETTINGS_DESKTOP_OPERATION_TOKEN]: never;
}

export type SettingsDesktopOperationResult =
  | { readonly kind: "edit"; readonly request: SettingsEditorRequest }
  | {
      readonly kind: "terminal";
      readonly effect: "render" | "close";
      /** Null means the mutation settled but its safe projection failed. */
      readonly capture: SettingsDesktopProjectionCapture | null;
    };

export interface SettingsDesktopOperationStart {
  readonly token: SettingsDesktopOperationToken;
  readonly result: SettingsDesktopOperationResult;
}

export class SettingsDesktopOperationError extends Error {
  readonly code = "settings-desktop-operation-invalid" as const;

  constructor() {
    super("The Desktop settings operation could not be verified.");
    this.name = "SettingsDesktopOperationError";
  }
}

export interface SettingsSnapshotPort {
  read(): Promise<SettingsControllerSnapshot>;
}

export type SettingsExternalAction =
  | { readonly kind: "provider"; readonly intent: ProviderCommandIntent }
  | {
      readonly kind: "main-model";
      readonly selection: RoutePickerSelectionIntent;
    }
  | { readonly kind: "compressor-model"; readonly selection: RoutePickerSelectionIntent }
  | { readonly kind: "approval-forget"; readonly ruleId: string }
  | { readonly kind: "approval-forget-all" }
  | { readonly kind: "verify-suggest" }
  | { readonly kind: "panel-models"; readonly modelIds: readonly string[] }
  | { readonly kind: "transcription-model"; readonly modelId: string }
  | { readonly kind: "cross-role"; readonly role: "lead" | "challenger"; readonly selection: RoutePickerSelectionIntent }
  | { readonly kind: "cross-swap" }
  | { readonly kind: "architect-executor-model"; readonly selection: RoutePickerSelectionIntent };

/**
 * FIX-14 ticket 14 (FIX-18 F7 residual). `execute` used to return `void`, so
 * "the port ran and changed nothing" was indistinguishable from "the port
 * ran and did the thing" — and Settings reported the success verb
 * ("Disconnected") for a disconnect that removed nothing at all, which is
 * the case for a connection the binding selector cannot see (a disabled
 * one). Cancel-never-success already had its own channel
 * (`SettingsExternalActionCancelledError`); this is the same rule for the
 * third outcome. `reason` is the port's own words, shown verbatim, so the
 * notice can never generalize a specific "nothing happened" into a wrong
 * one.
 */
export type SettingsExternalActionOutcome =
  | { readonly kind: "changed" }
  | { readonly kind: "unchanged"; readonly reason: string };

export interface SettingsExternalActionPort {
  execute(action: SettingsExternalAction): Promise<SettingsExternalActionOutcome>;
}

export interface PreparedLiveConfigPublication {
  /** Runs only after exact durable config readback; async owner state must settle before success. */
  publish(): Promise<void> | void;
}

export interface SettingsLiveConfigPort {
  prepare(config: OrcodeConfigWithBudget): PreparedLiveConfigPublication;
}

/**
 * Why Settings is locked, in the reader's own terms.
 *
 * A lock the reader cannot explain is a lock they cannot escape, and the one
 * word this used to say ("Configuration read-only") named neither the cause
 * nor the way out. Each entry states what happened and what to do about it;
 * there is deliberately no generic member to fall back on, so a new lock
 * cause has to be given words before it can reach the surface.
 *
 * Each is short enough to survive the densest row a locked surface renders
 * (`Locked · <reason>` in the Appearance list at 100 columns, measured on the
 * real PTY), so the way out is readable without pressing anything. ASCII
 * only, like every other string this theme-free module ships: a literal `—`
 * or `·` here would leak Unicode into `glyphMode: "ascii"`.
 */
export const SETTINGS_READ_ONLY_REASONS = Object.freeze({
  /** The file no longer holds what this process published or loaded. */
  foreignConfig: "Another orcode changed the config. Restart to adopt it.",
  /** The stored config could not be read as an editable snapshot at all. */
  unreadableConfig: "The config could not be read. Fix it, then restart.",
  /** A save settled in a state this session cannot safely continue editing from. */
  restartRequired: "Restart orcode before changing settings again.",
} as const);

export type SettingsReadOnlyReason =
  (typeof SETTINGS_READ_ONLY_REASONS)[keyof typeof SETTINGS_READ_ONLY_REASONS];

/**
 * What THIS process knows the stored config to be — the pristine baseline a
 * foreign-write check compares the file against, and never the runtime config,
 * whose session-owned overrides are exactly what such a check must not see
 * (`noteConfigDiskBaseline`, config.ts).
 */
export interface SettingsConfigBaselinePort {
  /** `null` when this process has never observed the file at all. */
  read(): OrcodeConfigWithBudget | SettingsConfigProjection | null;
  /**
   * This process has just PROVEN, by exact readback, that the file holds these
   * bytes. Only a publication whose durability the CAS path could not confirm
   * on its own reaches this; every confirmed one already moved the baseline
   * inside config.ts.
   */
  note(config: OrcodeConfigWithBudget): void;
}

export type SettingsConfigEditState =
  | { readonly kind: "editable"; readonly snapshot: ConfigEditSnapshot }
  | {
      readonly kind: "read-only";
      readonly config: SettingsConfigProjection;
      readonly reason: SettingsReadOnlyReason;
    };

export interface SettingsControllerDependencies {
  readonly configPath: string;
  readonly snapshots: SettingsSnapshotPort;
  readonly externalActions: SettingsExternalActionPort;
  readonly liveConfig: SettingsLiveConfigPort;
  readonly readConfig: (path: string) => Promise<ConfigEditSnapshot>;
  readonly configBaseline: SettingsConfigBaselinePort;
  readonly saveConfig: (
    expected: ConfigEditSnapshot,
    candidate: ConfigInput,
    path: string,
  ) => Promise<OrcodeConfigWithBudget>;
  readonly runConfigMutation?: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * FIX-14 ticket 5: an alias for the ONE notice shape (`Notice`, types.ts),
 * kept as a name because "the notice this controller is holding" is a
 * meaningful thing to say — but no longer a second declaration of what a
 * notice IS.
 *
 * "busy" is never produced by the controller itself — `#notice` only ever
 * holds a settled outcome. It exists so a `SettingsSurface` (Phase 7's
 * `setBusy` hook, `settings-session.ts`) can render an in-progress state in
 * the exact same notice slot while `dispatch`/`completeEditor` are still
 * running, without inventing a parallel display mechanism. "warn" comes with
 * the shared vocabulary and is likewise not emitted here; a member this
 * surface does not use costs nothing, while a second vocabulary that omits
 * it costs a reader the ability to carry one idea across surfaces.
 */
export type SettingsNotice = Notice;

export interface SettingsViewModel {
  readonly categories: readonly SettingsCategory[];
  /** Rows visible in the selected category, or current search results. */
  readonly items: readonly SettingsItem[];
  /** Complete secretless registry projection, used by responsive renderers. */
  readonly allItems: readonly SettingsItem[];
  readonly selectedCategoryId: SettingsCategoryId;
  readonly selectedItemId: SettingsItemId | null;
  readonly search: {
    readonly active: boolean;
    readonly query: string;
  };
  readonly readOnlyReason: SettingsReadOnlyReason | null;
  readonly runActive: boolean;
  readonly notice: SettingsNotice | null;
}

export type SettingsDesktopEditorSchema =
  | {
      readonly kind: "choice";
      readonly actionId: SettingsActionId;
      /** Ordered authoritative values only; source option copy never crosses. */
      readonly values: readonly string[];
    }
  | {
      readonly kind: "model";
      readonly actionId: SettingsActionId;
      readonly filter: Extract<SettingsEditorDescriptor, { readonly kind: "model" }>["filter"];
      readonly multiple?: true;
    }
  | {
      readonly kind: "number";
      readonly actionId: SettingsActionId;
      readonly minimum: number;
      readonly maximum: number;
      readonly allowOff?: true;
      readonly unit?: string;
    }
  | {
      readonly kind: "text";
      readonly actionId: SettingsActionId;
      readonly valueKind: Extract<SettingsEditorDescriptor, { readonly kind: "text" }>["valueKind"];
    }
  | {
      readonly kind: "confirm";
      readonly actionId: SettingsActionId;
      readonly destructive: boolean;
    }
  | { readonly kind: "invoke"; readonly actionId: SettingsActionId }
  | { readonly kind: "readonly" };

/** The complete and only Registry shell allowed across the Desktop capture. */
export interface SettingsDesktopProjectionItem {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly editor: SettingsDesktopEditorSchema;
  readonly disabledReason?: string;
}

export type SettingsDesktopRowTruth =
  | {
      readonly kind: "model";
      readonly modelIds: readonly string[];
      readonly state: "configured" | "not-connected" | "staged" | "unset";
    }
  | { readonly kind: "reasoning"; readonly value: string; readonly options: readonly string[] }
  | { readonly kind: "choice"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number; readonly unit: "integer" | "usd" | "seconds" }
  | { readonly kind: "optional-usd"; readonly value: number | null }
  | { readonly kind: "provider-list"; readonly values: readonly string[] }
  | { readonly kind: "path"; readonly value: string | null }
  | { readonly kind: "count"; readonly count: number; readonly subject: "rules" | "commands" }
  | { readonly kind: "action"; readonly actionId: SettingsActionId; readonly active?: boolean }
  | { readonly kind: "provider-status"; readonly provider: SettingsDesktopProviderTruth }
  | {
      readonly kind: "provider-action";
      readonly backendId: SettingsProviderProjection["backendId"];
      readonly action: ProviderBackendAction;
    }
  | { readonly kind: "approval-rule"; readonly decision: "allow" | "deny" }
  | { readonly kind: "approval-forget" }
  | {
      readonly kind: "cost";
      readonly knowledge: SettingsControllerSnapshot["costs"]["costKnowledge"];
      readonly sessionUsd: number;
      readonly dayUsd: number;
      readonly totalUsd: number;
    }
  | { readonly kind: "consent"; readonly granted: boolean };

export interface SettingsDesktopProviderTruth {
  readonly backendId: SettingsProviderProjection["backendId"];
  readonly availability: SettingsProviderProjection["availability"];
  readonly configuration: SettingsProviderProjection["configuration"];
  readonly maturity: SettingsProviderProjection["maturity"];
  readonly billingRealm: SettingsProviderProjection["billingRealm"];
  readonly headline: SettingsProviderProjection["headline"];
  readonly isDefault: boolean;
  readonly selectedRequestedModelId: string | null;
  readonly allowedActions: readonly ProviderBackendAction[];
}

export interface SettingsDesktopProjectionCapture {
  readonly items: readonly SettingsDesktopProjectionItem[];
  readonly readOnlyReason: SettingsReadOnlyReason | null;
  readonly rowTruth: Readonly<Record<string, SettingsDesktopRowTruth>>;
  readonly noticeOutcome: "saved" | "cancelled" | "stale" | "failed" | null;
}

export type SettingsConfigAction =
  | { readonly kind: "reasoning"; readonly modelId: string; readonly value: ReasoningSetting }
  | { readonly kind: "compression-mode"; readonly value: CompressionMode }
  | { readonly kind: "max-steps"; readonly value: number }
  | { readonly kind: "provider-sort"; readonly value: ProviderSortPreference | undefined }
  | { readonly kind: "provider-data-collection"; readonly value: DataCollectionPreference }
  | { readonly kind: "provider-only"; readonly value: readonly string[] }
  | { readonly kind: "provider-ignore"; readonly value: readonly string[] }
  | { readonly kind: "provider-fallback"; readonly value: boolean }
  | { readonly kind: "approval-mode"; readonly value: ApprovalMode }
  | { readonly kind: "max-cost"; readonly value: number }
  | { readonly kind: "compressor-max-cost"; readonly value: number }
  | { readonly kind: "low-balance-threshold"; readonly value: number }
  | { readonly kind: "budget-daily"; readonly value: number | null }
  | { readonly kind: "budget-total"; readonly value: number | null }
  | { readonly kind: "budget-on-exceed"; readonly value: BudgetAction }
  | { readonly kind: "verify-mode"; readonly value: VerifyMode }
  | { readonly kind: "verify-commands"; readonly value: readonly string[] }
  | { readonly kind: "verify-clear" }
  | { readonly kind: "verify-repair-rounds"; readonly value: number }
  | { readonly kind: "web-mode"; readonly value: WebMode }
  | { readonly kind: "browser-path"; readonly value: string }
  | { readonly kind: "browser-timeout"; readonly value: number }
  | { readonly kind: "panel-judge"; readonly value: boolean }
  | { readonly kind: "voice-consent-clear" }
  | { readonly kind: "appearance-large-logo"; readonly value: boolean }
  | { readonly kind: "appearance-header-mark"; readonly value: boolean }
  | { readonly kind: "appearance-glyph-mode"; readonly value: GlyphMode };

type PreparedSettingsAction =
  | { readonly kind: "config"; readonly action: SettingsConfigAction }
  | { readonly kind: "external"; readonly action: SettingsExternalAction };

type InterpretedEditorResult =
  | PreparedSettingsAction
  | { readonly kind: "cancel" }
  | {
      readonly kind: "invalid";
      readonly retainedValue: SettingsEditorValue;
      readonly message: string;
    }
  | { readonly kind: "allow-all-confirm" };

interface PendingEditor {
  readonly request: SettingsEditorRequest;
  readonly item: SettingsItem;
  readonly configSnapshot: ConfigEditSnapshot;
  readonly phase: "editor" | "allow-all-confirm";
}

interface DesktopOperationOwner {
  readonly token: SettingsDesktopOperationToken;
  readonly itemId: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly actionId: SettingsActionId;
  readonly phase: PendingEditor["phase"];
  readonly request: SettingsEditorRequest;
}

const CONFLICT_NOTICE = "Setting was changed in parallel";
const SAVE_ERROR_NOTICE = "Setting could not be saved";
const RECOVERY_REQUIRED_NOTICE =
  "Recovery required · restart orcode before changing settings again";
const EXTERNAL_ERROR_NOTICE = "Action could not be completed";

/**
 * FIX-18 (F7): the settings success notice states what actually happened.
 * "Saved" was a lie for the destructive provider account mutations —
 * disconnecting reported "✓ Saved" as if a value had been written. The
 * cancel path stays "Cancelled" (cancel-never-success) and every
 * non-provider external action keeps the established "Saved".
 */
export function externalActionSuccessNotice(action: SettingsExternalAction): string {
  if (action.kind !== "provider") return "Saved";
  switch (action.intent.kind) {
    case "disconnect":
      return "Disconnected";
    case "disable":
      return "Disabled";
    case "logout":
      return "Logged out";
    default:
      return "Saved";
  }
}
/**
 * FIX-14 ticket 14: the third outcome's notice. Never a success verb and
 * never the `success` kind — an action that changed nothing did not
 * succeed at what it was asked to do, exactly as a cancelled one did not.
 * The port's own `reason` is appended verbatim rather than restated.
 */
export function externalActionUnchangedNotice(reason: string): string {
  return reason ? `Nothing changed ${EM_DASH} ${reason}` : "Nothing changed";
}

/** The one dash this module's notices use; the theme is not reachable here. */
const EM_DASH = "—";

const UNVERIFIED_NOTICE = "Save state could not be safely confirmed";
const ACTIVITY_ERROR_NOTICE = "Current run status could not be checked";
const SAVED_REFRESH_NOTICE = "Saved; view could not be refreshed";
const ACTION_REFRESH_NOTICE = "Action completed; view could not be refreshed";
const ALLOW_ALL_WARNING =
  "allow-all runs file changes and shell commands without asking. Really enable it?";

export class SettingsRunActiveError extends Error {
  readonly code = "settings-run-active" as const;
}

/** A durable Settings owner could not be reconciled; callers must stop editing until restart recovery. */
export class SettingsLiveConfigRecoveryRequiredError extends Error {
  readonly code = "settings-live-config-recovery-required" as const;

  constructor() {
    super("Settings live config recovery is required before another edit.");
    this.name = "SettingsLiveConfigRecoveryRequiredError";
  }
}

export class SettingsExternalActionCancelledError extends Error {
  readonly code = "settings-action-cancelled" as const;

  constructor() {
    super("Settings action was cancelled.");
    this.name = "SettingsExternalActionCancelledError";
  }
}

class SettingsConfigUnverifiedMismatchError extends Error {
  constructor(readonly exact: ConfigEditSnapshot) {
    super("Settings config readback differs from the requested candidate.");
    this.name = "SettingsConfigUnverifiedMismatchError";
  }
}

export class SettingsController {
  readonly #dependencies: SettingsControllerDependencies;
  #snapshot: SettingsControllerSnapshot;
  #configEditState: SettingsConfigEditState;
  #allItems: readonly SettingsItem[] = [];
  #categories: readonly SettingsCategory[] = [];
  #selectedCategoryId: SettingsCategoryId;
  #categoryFocus = new Map<SettingsCategoryId, SettingsItemId>();
  #searchActive = false;
  #searchQuery = "";
  #searchItemId: SettingsItemId | null = null;
  #notice: SettingsNotice | null = null;
  #desktopNoticeOutcome: SettingsDesktopProjectionCapture["noticeOutcome"] = null;
  #pending: PendingEditor | null = null;
  #desktopOwner: DesktopOperationOwner | null = null;
  #generation = 0;
  #operationTail: Promise<void> = Promise.resolve();

  private constructor(
    dependencies: SettingsControllerDependencies,
    snapshot: SettingsControllerSnapshot,
    configEditState: SettingsConfigEditState,
    initialCategory: SettingsCategoryId,
  ) {
    this.#dependencies = dependencies;
    this.#snapshot = projectControllerSnapshot(snapshot);
    this.#configEditState = configEditState;
    this.#selectedCategoryId = initialCategory;
    this.#rebuildRegistry();
    this.#ensureCategoryFocus(initialCategory);
  }

  static async open(
    dependencies: SettingsControllerDependencies,
    initialCategory: SettingsCategoryId = "models",
  ): Promise<SettingsController> {
    const runtime = projectControllerSnapshot(await dependencies.snapshots.read());
    let controllerSnapshot = runtime;
    let configEditState: SettingsConfigEditState;
    try {
      const exact = await dependencies.readConfig(dependencies.configPath);
      // The guard's one question is whether somebody ELSE wrote the file, so
      // the file is compared against this process's own pristine baseline —
      // never against `runtime.config`, which legitimately carries this
      // session's standing overrides (a resumed chat's model is restored into
      // it in memory and never written to disk). Comparing against the runtime
      // copy made the process read its own override as foreign drift and
      // locked Settings on a fresh launch, for good.
      if (!foreignConfigWrite(dependencies.configBaseline.read(), exact.config)) {
        configEditState = { kind: "editable", snapshot: exact };
      } else {
        controllerSnapshot = { ...runtime, config: projectSettingsConfig(exact.config) };
        configEditState = {
          kind: "read-only",
          config: projectSettingsConfig(exact.config),
          reason: SETTINGS_READ_ONLY_REASONS.foreignConfig,
        };
      }
    } catch {
      configEditState = {
        kind: "read-only",
        config: freezeClone(runtime.config),
        reason: SETTINGS_READ_ONLY_REASONS.unreadableConfig,
      };
    }
    return new SettingsController(
      dependencies,
      controllerSnapshot,
      configEditState,
      initialCategory,
    );
  }

  get view(): SettingsViewModel {
    const items = this.#visibleItems();
    return Object.freeze({
      categories: Object.freeze([...buildSettingsRegistry(registrySnapshot(this.#snapshot)).categories]),
      items: Object.freeze([...items]),
      allItems: Object.freeze([...this.#allItems]),
      selectedCategoryId: this.#selectedCategoryId,
      selectedItemId: this.#currentItemId(items),
      search: Object.freeze({
        active: this.#searchActive,
        query: this.#searchQuery,
      }),
      readOnlyReason: this.#configEditState.kind === "read-only"
        ? this.#configEditState.reason
        : null,
      runActive: this.#snapshot.runActive,
      notice: this.#notice,
    });
  }

  captureDesktopProjection(): SettingsDesktopProjectionCapture {
    const rowTruth = Object.fromEntries(this.#allItems.map((item) => [
      item.id,
      projectSettingsDesktopRowTruth(this.#snapshot, item),
    ]));
    return freezeClone({
      items: this.#allItems.map(desktopProjectionItem),
      readOnlyReason: this.#configEditState.kind === "read-only"
        ? this.#configEditState.reason
        : null,
      rowTruth,
      noticeOutcome: this.#desktopNoticeOutcome,
    });
  }

  dispatch(intent: SettingsIntent): Promise<SettingsControllerEffect> {
    return this.#enqueueOperation(() => this.#dispatchSerial(intent));
  }

  async #dispatchSerial(intent: SettingsIntent): Promise<SettingsControllerEffect> {
    if (this.#desktopOwner) return { kind: "render" };
    if (this.#pending) return { kind: "edit", request: this.#pending.request };
    this.#notice = null;
    this.#desktopNoticeOutcome = null;
    switch (intent.kind) {
      case "move":
        this.#move(intent.delta);
        return { kind: "render" };
      case "page":
        this.#moveBy(intent.delta * 5);
        return { kind: "render" };
      case "boundary":
        this.#moveToBoundary(intent.edge);
        return { kind: "render" };
      case "category":
        this.#selectCategory(intent.categoryId);
        return { kind: "render" };
      case "search-start":
        this.#searchActive = true;
        this.#searchQuery = "";
        this.#searchItemId = this.#firstEnabled(this.#visibleItems())?.id ?? null;
        return { kind: "render" };
      case "search-change":
        this.#searchActive = true;
        this.#searchQuery = sanitizeSearchQuery(intent.query);
        this.#repairSearchFocus();
        return { kind: "render" };
      case "select-item":
        this.#selectItem(intent.itemId);
        return { kind: "render" };
      case "activate":
        return this.#activate();
      case "back":
        if (this.#searchActive) {
          this.#searchActive = false;
          this.#searchQuery = "";
          this.#searchItemId = null;
          this.#ensureCategoryFocus(this.#selectedCategoryId);
          return { kind: "render" };
        }
        // V4-B: there is no sub-level left to pop. F6 addendum (b) gave Esc a
        // "collapse the expanded `More settings …` list" step because a
        // category could be two levels deep; V4's dense list shows every row
        // of the active category at once, so inside Settings there is exactly
        // one level below the search, and Esc means what it says on the
        // action bar — `Esc back`.
        return { kind: "close" };
      default:
        return assertNever(intent);
    }
  }

  completeEditor(
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsControllerEffect> {
    return this.#enqueueOperation(() => {
      if (this.#desktopOwner) return { kind: "render" } as const;
      return this.#completeEditorSerial(request, result);
    });
  }

  /** Atomically selects and activates one exact item under an opaque owner. */
  beginDesktopOperation(itemId: SettingsItemId): Promise<SettingsDesktopOperationStart> {
    return this.#enqueueOperation(async () => {
      if (this.#desktopOwner) throw new SettingsDesktopOperationError();
      if (this.#pending) {
        this.#cancelPendingEditor("failed");
        throw new SettingsDesktopOperationError();
      }
      this.#notice = null;
      this.#desktopNoticeOutcome = null;
      const item = this.#allItems.find(({ id }) => id === itemId);
      if (!item) throw new SettingsDesktopOperationError();
      this.#selectCategory(item.categoryId);
      this.#selectItem(itemId);
      const effect = this.#activate();
      const token = Object.freeze({}) as SettingsDesktopOperationToken;
      if (effect.kind !== "edit") {
        return Object.freeze({
          token,
          result: this.#terminalDesktopResult(effect),
        });
      }
      const actionId = editorActionId(effect.request);
      const pending = this.#currentPending();
      if (!actionId || !pending || pending.request !== effect.request) {
        this.#cancelPendingEditor("failed");
        throw new SettingsDesktopOperationError();
      }
      this.#desktopOwner = Object.freeze({
        token,
        itemId,
        categoryId: item.categoryId,
        actionId,
        phase: pending.phase,
        request: effect.request,
      });
      return Object.freeze({
        token,
        result: Object.freeze({ kind: "edit" as const, request: effect.request }),
      });
    });
  }

  /** Completes exactly the currently owned request and advances its phase. */
  advanceDesktopOperation(
    token: SettingsDesktopOperationToken,
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsDesktopOperationResult> {
    return this.#enqueueOperation(async () => {
      const owner = this.#desktopOwner;
      if (!owner || owner.token !== token) throw new SettingsDesktopOperationError();
      if (!validRuntimeEditorResult(result)) {
        this.#cancelOwnedOperation(owner, "failed");
        throw new SettingsDesktopOperationError();
      }
      if (!this.#ownedRequestMatches(owner, request)) {
        this.#cancelOwnedOperation(owner, "failed");
        throw new SettingsDesktopOperationError();
      }
      let effect: SettingsControllerEffect;
      try {
        effect = await this.#completeEditorSerial(request, result);
      } catch (error) {
        this.#cancelOwnedOperation(owner, "failed");
        throw error;
      }
      if (effect.kind !== "edit") {
        try {
          return this.#terminalDesktopResult(effect);
        } finally {
          this.#desktopOwner = null;
        }
      }
      const pending = this.#pending;
      if (!pending || !this.#validOwnedTransition(owner, effect.request, pending, result)) {
        this.#cancelOwnedOperation(owner, "failed");
        throw new SettingsDesktopOperationError();
      }
      this.#desktopOwner = Object.freeze({
        ...owner,
        phase: pending.phase,
        request: effect.request,
      });
      return Object.freeze({ kind: "edit" as const, request: effect.request });
    });
  }

  /** Cancels only the exact currently owned request and releases the owner. */
  abortDesktopOperation(
    token: SettingsDesktopOperationToken,
    request: SettingsEditorRequest,
  ): Promise<SettingsDesktopOperationResult> {
    return this.#enqueueOperation(() => {
      const owner = this.#desktopOwner;
      if (!owner || owner.token !== token) throw new SettingsDesktopOperationError();
      if (!this.#ownedRequestMatches(owner, request)) {
        this.#cancelOwnedOperation(owner, "failed");
        throw new SettingsDesktopOperationError();
      }
      this.#cancelOwnedOperation(owner, "failed");
      return this.#terminalDesktopResult({ kind: "render" });
    });
  }

  #enqueueOperation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #currentPending(): PendingEditor | null {
    return this.#pending;
  }

  async #completeEditorSerial(
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsControllerEffect> {
    const pending = this.#pending;
    if (!pending || pending.request !== request) {
      return { kind: "render" };
    }
    this.#pending = null;
    if (result.kind === "cancel") {
      this.#publishCancelled();
      return { kind: "render" };
    }

    const interpreted = pending.phase === "allow-all-confirm"
      ? interpretAllowAllConfirmation(result.value)
      : interpretEditorValue(pending.item, result.value, this.#snapshot);
    if (interpreted.kind === "cancel") {
      this.#publishCancelled();
      return { kind: "render" };
    }
    if (interpreted.kind === "invalid") {
      return this.#retryEditor(
        pending,
        interpreted.retainedValue,
        interpreted.message,
      );
    }
    if (interpreted.kind === "allow-all-confirm") {
      return this.#requestAllowAllConfirmation(pending);
    }

    let activity: SettingsControllerSnapshot;
    try {
      activity = projectControllerSnapshot(await this.#dependencies.snapshots.read());
    } catch {
      this.#notice = Object.freeze({ kind: "error", message: ACTIVITY_ERROR_NOTICE });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }
    if (activity.runActive && pending.item.affectsActiveRun) {
      this.#snapshot = freezeClone(activity);
      this.#notice = Object.freeze({ kind: "info", message: "Run active" });
      this.#desktopNoticeOutcome = "failed";
      this.#rebuildRegistry();
      return { kind: "render" };
    }

    if (interpreted.kind === "external") {
      return this.#executeExternal(pending, interpreted.action);
    }
    return this.#saveConfigAction(pending, interpreted.action, activity);
  }

  #retryEditor(
    pending: PendingEditor,
    initialValue: SettingsEditorValue,
    validationMessage: string,
  ): SettingsControllerEffect {
    const request = freezeRequest({
      ...pending.request,
      generation: ++this.#generation,
      initialValue,
      validationMessage: oneLine(validationMessage),
    });
    this.#pending = { ...pending, request };
    return { kind: "edit", request };
  }

  #requestAllowAllConfirmation(pending: PendingEditor): SettingsControllerEffect {
    const request = freezeRequest({
      generation: ++this.#generation,
      categoryId: pending.item.categoryId,
      itemId: pending.item.id,
      label: "Enable allow-all?",
      description: ALLOW_ALL_WARNING,
      editor: {
        kind: "confirm",
        actionId: "approval-mode",
        destructive: true,
      },
      initialValue: false,
    });
    this.#pending = {
      ...pending,
      request,
      phase: "allow-all-confirm",
    };
    return { kind: "edit", request };
  }

  #ownedRequestMatches(owner: DesktopOperationOwner, request: SettingsEditorRequest): boolean {
    const pending = this.#pending;
    return request === owner.request
      && pending?.request === request
      && pending.item.id === owner.itemId
      && pending.item.categoryId === owner.categoryId
      && pending.phase === owner.phase
      && request.itemId === owner.itemId
      && request.categoryId === owner.categoryId
      && editorActionId(request) === owner.actionId;
  }

  #validOwnedTransition(
    owner: DesktopOperationOwner,
    request: SettingsEditorRequest,
    pending: PendingEditor,
    result: SettingsEditorResult,
  ): boolean {
    if (request === owner.request || request.generation !== owner.request.generation + 1
      || request.itemId !== owner.itemId || request.categoryId !== owner.categoryId
      || editorActionId(request) !== owner.actionId || pending.request !== request) return false;
    if (owner.phase === "allow-all-confirm") {
      return pending.phase === "allow-all-confirm"
        && request.editor.kind === "confirm"
        && result.kind === "value" && result.value !== true && result.value !== false;
    }
    if (pending.phase === "allow-all-confirm") {
      return owner.actionId === "approval-mode"
        && owner.request.editor.kind === "choice"
        && request.editor.kind === "confirm"
        && result.kind === "value" && result.value === "allow-all";
    }
    return pending.phase === "editor"
      && request.editor.kind === owner.request.editor.kind
      && request.validationMessage !== undefined;
  }

  #cancelOwnedOperation(owner: DesktopOperationOwner, outcome: "cancelled" | "failed"): void {
    if (this.#desktopOwner !== owner) return;
    this.#pending = null;
    if (outcome === "cancelled") this.#publishCancelled();
    else this.#publishFailedCleanup();
    this.#desktopOwner = null;
  }

  #cancelPendingEditor(outcome: "cancelled" | "failed"): void {
    if (!this.#pending) return;
    this.#pending = null;
    if (outcome === "cancelled") this.#publishCancelled();
    else this.#publishFailedCleanup();
  }

  #publishCancelled(): void {
    this.#notice = Object.freeze({ kind: "info", message: "Cancelled" });
    this.#desktopNoticeOutcome = "cancelled";
  }

  #publishFailedCleanup(): void {
    this.#notice = Object.freeze({ kind: "error", message: SAVE_ERROR_NOTICE });
    this.#desktopNoticeOutcome = "failed";
  }

  #terminalDesktopResult(effect: Exclude<SettingsControllerEffect, { readonly kind: "edit" }>): SettingsDesktopOperationResult {
    let capture: SettingsDesktopProjectionCapture | null = null;
    try {
      capture = this.captureDesktopProjection();
    } catch {
      // The Core effect has already settled. The adapter must advance to its
      // fixed, handle-free diagnostic revision rather than pretending the old
      // view still describes durable/live state.
    }
    return Object.freeze({
      kind: "terminal" as const,
      effect: effect.kind,
      capture,
    });
  }

  async #executeExternal(
    pending: PendingEditor,
    action: SettingsExternalAction,
  ): Promise<SettingsControllerEffect> {
    let outcome: SettingsExternalActionOutcome;
    try {
      outcome = await this.#dependencies.externalActions.execute(action);
    } catch (error) {
      if (error instanceof SettingsRunActiveError) {
        await this.#showRunActive(pending.item.id);
        return { kind: "render" };
      }
      if (error instanceof SettingsExternalActionCancelledError) {
        this.#notice = Object.freeze({ kind: "info", message: "Cancelled" });
        this.#desktopNoticeOutcome = "cancelled";
        return { kind: "render" };
      }
      await this.#refreshOrReadOnly(
        pending.item.id,
        this.#snapshot,
        this.#snapshot.config,
      );
      this.#notice = Object.freeze({ kind: "error", message: EXTERNAL_ERROR_NOTICE });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }

    if (!await this.#refreshOrReadOnly(
      pending.item.id,
      this.#snapshot,
      this.#snapshot.config,
    )) {
      this.#notice = Object.freeze({ kind: "success", message: ACTION_REFRESH_NOTICE });
      this.#desktopNoticeOutcome = "saved";
      return { kind: "render" };
    }
    // FIX-14 ticket 14: a port run that changed nothing is reported as
    // exactly that — never as the act it was asked to perform.
    this.#notice = outcome.kind === "unchanged"
      ? Object.freeze({
          kind: "info" as const,
          message: externalActionUnchangedNotice(outcome.reason),
        })
      : Object.freeze({
          kind: "success" as const,
          message: externalActionSuccessNotice(action),
        });
    this.#desktopNoticeOutcome = outcome.kind === "unchanged" ? "cancelled" : "saved";
    return { kind: "render" };
  }

  async #saveConfigAction(
    pending: PendingEditor,
    action: SettingsConfigAction,
    activity: SettingsControllerSnapshot,
  ): Promise<SettingsControllerEffect> {
    const candidate = structuredClone(pending.configSnapshot.config);
    applyConfigAction(candidate, action);
    let validated: OrcodeConfigWithBudget;
    try {
      validated = validateConfig(candidate);
      if (!configActionApplied(validated, action)) {
        return this.#retryEditor(
          pending,
          retainedValueForAction(action),
          "This value isn't allowed for this setting",
        );
      }
    } catch {
      return this.#retryEditor(
        pending,
        retainedValueForAction(action),
        "This value isn't allowed for this setting",
      );
    }

    let publication: PreparedLiveConfigPublication;
    try {
      publication = this.#dependencies.liveConfig.prepare(validated);
    } catch {
      this.#notice = Object.freeze({ kind: "error", message: SAVE_ERROR_NOTICE });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }

    let saved: OrcodeConfigWithBudget;
    try {
      const runMutation = this.#dependencies.runConfigMutation
        ?? (<T>(task: () => Promise<T>) => task());
      saved = await runMutation(async () => {
        let persisted: OrcodeConfigWithBudget;
        try {
          persisted = await this.#dependencies.saveConfig(
            pending.configSnapshot,
            validated,
            this.#dependencies.configPath,
          );
        } catch (error) {
          if (!(error instanceof ConfigEditUnverifiedError)) throw error;
          let exact: ConfigEditSnapshot;
          try {
            exact = await this.#dependencies.readConfig(this.#dependencies.configPath);
          } catch {
            throw error;
          }
          if (!sameExactConfig(exact.config, validated)) {
            throw new SettingsConfigUnverifiedMismatchError(exact);
          }
          // The CAS path could not confirm this publication, but an exact
          // readback just did: the file holds THIS process's own bytes, so
          // the refresh below must not report them as a foreign write.
          this.#dependencies.configBaseline.note(exact.config);
          persisted = exact.config;
        }
        if (sameExactConfig(persisted, validated)) await publication.publish();
        return persisted;
      });
    } catch (error) {
      if (error instanceof SettingsRunActiveError) {
        await this.#showRunActive(pending.item.id);
        return { kind: "render" };
      }
      if (error instanceof SettingsLiveConfigRecoveryRequiredError) {
        this.#enterReadOnly(
          pending.item.id,
          activity,
          activity.config,
          SETTINGS_READ_ONLY_REASONS.restartRequired,
        );
        this.#notice = Object.freeze({ kind: "error", message: RECOVERY_REQUIRED_NOTICE });
        this.#desktopNoticeOutcome = "failed";
        return { kind: "render" };
      }
      if (error instanceof ConfigEditConflictError) {
        await this.#refreshOrReadOnly(
          pending.item.id,
          activity,
          activity.config,
        );
        this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
        this.#desktopNoticeOutcome = "stale";
        return { kind: "render" };
      }
      if (error instanceof ConfigEditUnverifiedError) {
        this.#enterReadOnly(
          pending.item.id,
          activity,
          activity.config,
          SETTINGS_READ_ONLY_REASONS.restartRequired,
        );
        this.#notice = Object.freeze({ kind: "error", message: UNVERIFIED_NOTICE });
        this.#desktopNoticeOutcome = "failed";
        return { kind: "render" };
      }
      if (error instanceof SettingsConfigUnverifiedMismatchError) {
        return this.#reconcileUnverifiedMismatch(
          pending.item.id,
          activity,
          error.exact,
        );
      }
      this.#notice = Object.freeze({ kind: "error", message: SAVE_ERROR_NOTICE });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }

    if (!sameExactConfig(saved, validated)) {
      await this.#refreshOrReadOnly(
        pending.item.id,
        { ...activity, config: saved },
        saved,
      );
      this.#notice = Object.freeze({ kind: "error", message: UNVERIFIED_NOTICE });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }

    if (!await this.#refreshOrReadOnly(
      pending.item.id,
      { ...activity, config: saved },
      saved,
    )) {
      this.#notice = Object.freeze({ kind: "success", message: SAVED_REFRESH_NOTICE });
      this.#desktopNoticeOutcome = "saved";
      return { kind: "render" };
    }
    this.#notice = Object.freeze({ kind: "success", message: "Saved" });
    this.#desktopNoticeOutcome = "saved";
    return { kind: "render" };
  }

  async #reconcileUnverifiedMismatch(
    focusItemId: SettingsItemId,
    activity: SettingsControllerSnapshot,
    exact: ConfigEditSnapshot,
  ): Promise<SettingsControllerEffect> {
    try {
      const runtime = projectControllerSnapshot(await this.#dependencies.snapshots.read());
      // The publication was reached but the file does not hold what this
      // process wrote. If the file still matches this process's baseline the
      // write simply never landed and editing may continue from it; anything
      // else means somebody else owns those bytes now.
      if (foreignConfigWrite(this.#dependencies.configBaseline.read(), exact.config)) {
        this.#enterReadOnly(
          focusItemId,
          { ...runtime, config: projectSettingsConfig(exact.config) },
          exact.config,
          SETTINGS_READ_ONLY_REASONS.foreignConfig,
        );
        this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
        this.#desktopNoticeOutcome = "stale";
        return { kind: "render" };
      }
      this.#snapshot = freezeClone(runtime);
      this.#configEditState = { kind: "editable", snapshot: exact };
    } catch {
      this.#enterReadOnly(
        focusItemId,
        { ...activity, config: projectSettingsConfig(exact.config) },
        exact.config,
        SETTINGS_READ_ONLY_REASONS.restartRequired,
      );
      this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
      this.#desktopNoticeOutcome = "stale";
      return { kind: "render" };
    }
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
    this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
    this.#desktopNoticeOutcome = "stale";
    return { kind: "render" };
  }

  #activate(): SettingsControllerEffect {
    const item = this.#selectedItem();
    if (!item) return { kind: "render" };
    // F6 addendum (a): a locked row answers Enter inside Settings, always.
    // This check used to sit BELOW the readonly early-return, so a row that
    // was both readonly and locked (a status row during an active run)
    // swallowed Enter without a word — and, more importantly, no locked row
    // may ever reach the editor path below, whose surface can fail while
    // opening (a model picker whose catalog throws) and take the whole
    // Settings session down to the dashboard with it. The row itself renders
    // `Locked · <reason>`; the notice repeats the reason alone, because the
    // controller is deliberately theme-free and cannot ask for the ` · `
    // glyph — a literal `·` here would leak Unicode into `glyphMode: "ascii"`.
    if (item.disabledReason) {
      this.#notice = Object.freeze({ kind: "info", message: oneLine(item.disabledReason) });
      this.#desktopNoticeOutcome = "failed";
      return { kind: "render" };
    }
    if (item.editor.kind === "readonly") return { kind: "render" };
    if (this.#configEditState.kind !== "editable") return { kind: "render" };
    const excludeCrossRole = crossExcludeCounterpartRole(item, this.#snapshot.cross);
    const request = freezeRequest({
      generation: ++this.#generation,
      categoryId: item.categoryId,
      itemId: item.id,
      label: item.label,
      description: item.description,
      editor: item.editor,
      initialValue: initialValue(item, this.#configEditState.snapshot.config, this.#snapshot.cross),
      ...(excludeCrossRole ? { excludeCrossRole } : {}),
    });
    this.#pending = {
      request,
      item,
      configSnapshot: this.#configEditState.snapshot,
      phase: "editor",
    };
    return { kind: "edit", request };
  }

  async #showRunActive(focusItemId: SettingsItemId): Promise<void> {
    try {
      const runtime = projectControllerSnapshot(await this.#dependencies.snapshots.read());
      this.#snapshot = freezeClone(runtime.runActive ? runtime : { ...runtime, runActive: true });
    } catch {
      this.#snapshot = freezeClone({ ...this.#snapshot, runActive: true });
    }
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
    this.#notice = Object.freeze({ kind: "info", message: "Run active" });
    this.#desktopNoticeOutcome = "failed";
  }

  async #refresh(focusItemId: SettingsItemId): Promise<boolean> {
    const runtime = projectControllerSnapshot(await this.#dependencies.snapshots.read());
    this.#snapshot = freezeClone(runtime);
    let editable = false;
    try {
      const exact = await this.#dependencies.readConfig(this.#dependencies.configPath);
      // Same rule as `open`: disk against this process's baseline. This runs
      // right after a save, and the CAS publication has already moved that
      // baseline, so a save never locks the view it just wrote.
      if (!foreignConfigWrite(this.#dependencies.configBaseline.read(), exact.config)) {
        this.#configEditState = { kind: "editable", snapshot: exact };
        editable = true;
      } else {
        this.#snapshot = freezeClone({ ...runtime, config: projectSettingsConfig(exact.config) });
        this.#configEditState = {
          kind: "read-only",
          config: projectSettingsConfig(exact.config),
          reason: SETTINGS_READ_ONLY_REASONS.foreignConfig,
        };
      }
    } catch {
      this.#configEditState = {
        kind: "read-only",
        config: freezeClone(runtime.config),
        reason: SETTINGS_READ_ONLY_REASONS.unreadableConfig,
      };
    }
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
    return editable;
  }

  async #refreshOrReadOnly(
    focusItemId: SettingsItemId,
    fallbackSnapshot: SettingsControllerSnapshot,
    fallbackConfig: SettingsConfigProjection,
  ): Promise<boolean> {
    try {
      return await this.#refresh(focusItemId);
    } catch {
      this.#enterReadOnly(
        focusItemId,
        fallbackSnapshot,
        fallbackConfig,
        SETTINGS_READ_ONLY_REASONS.restartRequired,
      );
      return false;
    }
  }

  #enterReadOnly(
    focusItemId: SettingsItemId,
    snapshot: SettingsControllerSnapshot,
    config: OrcodeConfigWithBudget | SettingsConfigProjection,
    reason: SettingsReadOnlyReason,
  ): void {
    const projected = projectSettingsConfig(config);
    this.#snapshot = freezeClone({ ...snapshot, config: projected });
    this.#configEditState = {
      kind: "read-only",
      config: projected,
      reason,
    };
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
  }

  #restoreFocus(focusItemId: SettingsItemId): void {
    const item = this.#allItems.find(({ id }) => id === focusItemId);
    this.#selectedCategoryId = item?.categoryId ?? this.#selectedCategoryId;
    this.#categoryFocus.set(this.#selectedCategoryId, focusItemId);
    this.#ensureCategoryFocus(this.#selectedCategoryId);
    if (this.#searchActive) {
      this.#searchItemId = this.#allItems.some(({ id }) => id === focusItemId)
        ? focusItemId
        : null;
      this.#repairSearchFocus();
    }
  }

  #rebuildRegistry(): void {
    const registry = buildSettingsRegistry(registrySnapshot(this.#snapshot));
    this.#categories = registry.categories;
    const state = this.#configEditState;
    this.#allItems = Object.freeze(registry.items.map((item) => {
      if (state.kind === "editable" || item.editor.kind === "readonly") {
        return item;
      }
      // The row says WHY it is locked, in the same words the surface-wide
      // state does — `Locked · <reason>` is the one place the reader can read
      // the cause and the way out without pressing anything.
      return Object.freeze({ ...item, disabledReason: state.reason });
    }));
    for (const category of registry.categories) this.#ensureCategoryFocus(category.id);
  }

  #visibleItems(): readonly SettingsItem[] {
    if (this.#searchActive) {
      return searchSettings(
        { categories: this.#categories, items: this.#allItems },
        this.#searchQuery,
      );
    }
    return this.#categoryPresentationItems(this.#selectedCategoryId);
  }

  #currentItemId(items = this.#visibleItems()): SettingsItemId | null {
    const wanted = this.#searchActive
      ? this.#searchItemId
      : this.#categoryFocus.get(this.#selectedCategoryId) ?? null;
    return wanted && items.some(({ id }) => id === wanted) ? wanted : null;
  }

  #selectedItem(): SettingsItem | null {
    const id = this.#currentItemId();
    return id ? this.#visibleItems().find((item) => item.id === id) ?? null : null;
  }

  #move(delta: -1 | 1): void {
    this.#moveBy(delta);
  }

  #moveBy(delta: number): void {
    const items = this.#visibleItems();
    if (items.length === 0) return;
    const current = this.#currentItemId(items);
    const currentIndex = Math.max(0, items.findIndex(({ id }) => id === current));
    const next = items[Math.max(0, Math.min(items.length - 1, currentIndex + delta))]!;
    if (this.#searchActive) {
      this.#searchItemId = next.id;
    } else {
      this.#categoryFocus.set(this.#selectedCategoryId, next.id);
    }
  }

  #moveToBoundary(edge: "first" | "last"): void {
    const items = this.#visibleItems();
    if (items.length === 0) return;
    const next = edge === "first" ? items[0]! : items[items.length - 1]!;
    if (this.#searchActive) this.#searchItemId = next.id;
    else this.#categoryFocus.set(this.#selectedCategoryId, next.id);
  }

  #selectCategory(categoryId: SettingsCategoryId): void {
    if (!SETTINGS_CATEGORY_IDS.includes(categoryId)) {
      throw new Error("Invalid settings category.");
    }
    this.#searchActive = false;
    this.#searchQuery = "";
    this.#searchItemId = null;
    this.#selectedCategoryId = categoryId;
    this.#ensureCategoryFocus(categoryId);
  }

  #selectItem(itemId: SettingsItemId): void {
    const item = this.#visibleItems().find(({ id }) => id === itemId)
      ?? this.#allItems.find(({ id }) => id === itemId);
    if (!item) return;
    if (this.#searchActive) {
      if (this.#visibleItems().some(({ id }) => id === itemId)) this.#searchItemId = itemId;
      return;
    }
    // V4-B: every row of a category is always present, so a deep link never
    // has to reveal a hidden list first — it only has to point at the row.
    this.#selectedCategoryId = item.categoryId;
    this.#categoryFocus.set(item.categoryId, itemId);
  }

  #ensureCategoryFocus(categoryId: SettingsCategoryId): void {
    const categoryItems = this.#categoryPresentationItems(categoryId);
    const current = this.#categoryFocus.get(categoryId);
    if (current && categoryItems.some(({ id }) => id === current)) return;
    const first = this.#firstEnabled(categoryItems) ?? categoryItems[0];
    if (first) this.#categoryFocus.set(categoryId, first.id);
  }

  /**
   * Every item of `categoryId`, in registry order — the whole category, one
   * scrollable list.
   *
   * V4-B deleted the two-tier presentation this used to build: a hand-kept
   * `#commonItemIds` allow-list per category, everything else folded behind a
   * synthetic `More settings …` row that had to be activated (and then
   * collapsed again by Esc) to reach the rest. The owner-approved V4 mockup
   * is explicit — "alles sichtbar statt `More settings …`" — and the two-tier
   * split cost more than it saved: which rows counted as "common" was a
   * standing ruling that every category-IA change had to re-litigate
   * (`max-steps` moving category is the documented example), a deep link had
   * to secretly expand a list to point at a row, and Esc carried a second
   * meaning that existed only for this one surface. What replaces it is the
   * dense list plus the overflow counter — rows can lie off screen, but
   * nothing is hidden behind a keystroke.
   */
  #categoryPresentationItems(categoryId: SettingsCategoryId): readonly SettingsItem[] {
    return this.#allItems.filter((item) => item.categoryId === categoryId);
  }

  #repairSearchFocus(): void {
    const items = this.#visibleItems();
    if (this.#searchItemId && items.some(({ id }) => id === this.#searchItemId)) return;
    this.#searchItemId = (this.#firstEnabled(items) ?? items[0])?.id ?? null;
  }

  #firstEnabled(items: readonly SettingsItem[]): SettingsItem | undefined {
    return items.find(({ disabledReason }) => disabledReason === undefined);
  }
}

function interpretAllowAllConfirmation(value: SettingsEditorValue): InterpretedEditorResult {
  if (value === false) return { kind: "cancel" };
  if (value === true) {
    return {
      kind: "config",
      action: { kind: "approval-mode", value: "allow-all" },
    };
  }
  return {
    kind: "invalid",
    retainedValue: sanitizeEditorValue(value),
    message: "Confirmation is invalid",
  };
}

function interpretEditorValue(
  item: SettingsItem,
  value: SettingsEditorValue,
  snapshot: SettingsControllerSnapshot,
): InterpretedEditorResult {
  const descriptor = item.editor;
  if (descriptor.kind === "readonly") return { kind: "cancel" };

  let normalized: SettingsEditorValue | number | null;
  switch (descriptor.kind) {
    case "choice": {
      const typedOnOff = typeof value === "boolean"
        && isOnOffAction(descriptor.actionId)
        ? (value ? "on" : "off")
        : value;
      if (typeof typedOnOff !== "string"
        || !descriptor.options.some((option) => option.value === typedOnOff)) {
        return invalid(value, "Invalid choice");
      }
      normalized = typedOnOff;
      break;
    }
    case "number": {
      const parsed = parseNumberValue(value, descriptor.allowOff === true);
      if (parsed.kind === "invalid"
        || (parsed.value !== null
          && (parsed.value < descriptor.minimum || parsed.value > descriptor.maximum))) {
        return invalid(
          parsed.retained,
          `Number must be between ${descriptor.minimum} and ${descriptor.maximum}`,
        );
      }
      if (parsed.value !== null
        && integerAction(descriptor.actionId)
        && !Number.isInteger(parsed.value)) {
        return invalid(parsed.retained, "Only whole numbers are allowed");
      }
      normalized = parsed.value;
      break;
    }
    case "text": {
      const parsed = parseTextValue(value, descriptor.valueKind);
      if (parsed.kind === "invalid") return invalid(parsed.retained, parsed.message);
      normalized = parsed.value;
      break;
    }
    case "confirm":
      if (value === false) return { kind: "cancel" };
      if (value !== true) return invalid(value, "Confirmation is invalid");
      normalized = true;
      break;
    case "invoke":
      if (value === false) return { kind: "cancel" };
      if (value !== true) return invalid(value, "Action is invalid");
      normalized = true;
      break;
    case "model": {
      const parsed = parseModelValue(value, descriptor.multiple === true);
      if (parsed.kind === "invalid") return invalid(parsed.retained, "Model choice is invalid");
      normalized = parsed.value;
      break;
    }
    default:
      return assertNever(descriptor);
  }

  return actionForItem(item, normalized, snapshot);
}

function isOnOffAction(actionId: SettingsActionId): actionId is
  | "provider-fallback" | "panel-judge" | "appearance-large-logo" | "appearance-header-mark" {
  return actionId === "provider-fallback" || actionId === "panel-judge"
    || actionId === "appearance-large-logo" || actionId === "appearance-header-mark";
}

function actionForItem(
  item: SettingsItem,
  value: SettingsEditorValue | number | null,
  snapshot: SettingsControllerSnapshot,
): InterpretedEditorResult {
  if (item.editor.kind === "readonly") return { kind: "cancel" };
  const actionId = item.editor.actionId;
  switch (actionId) {
    case "main-model": {
      const selection = exactRoutePickerSelection(value);
      if (!selection) {
        return invalid(value, "Model choice is no longer available");
      }
      return {
        kind: "external",
        action: {
          kind: "main-model",
          selection,
        },
      };
    }
    case "reasoning":
    case "reasoning-compressor":
    case "reasoning-cross-lead":
    case "reasoning-cross-challenger": {
      if (typeof value !== "string") return invalid(value, "Reasoning choice is invalid");
      const parsed = parseReasoning(value);
      if (!parsed) return invalid(value, "Reasoning choice is invalid");
      const modelId = reasoningRoleModelId(actionId, snapshot);
      return modelId
        ? { kind: "config", action: { kind: "reasoning", modelId, value: parsed } }
        : invalid(value, "Reasoning choice is invalid");
    }
    case "compression-mode":
      return stringIn(value, ["off", "auto", "always"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Summarizer mode is invalid");
    case "compressor-model":
      return modelRouteAction(value, "compressor-model");
    case "max-steps":
      return finiteNumberAction(actionId, value);
    case "provider-setup":
      return { kind: "external", action: { kind: "provider", intent: { kind: "setup" } } };
    case "provider-connect":
    case "provider-enable":
    case "provider-disable":
    case "provider-disconnect":
    case "provider-reconnect":
    case "provider-models":
    case "provider-logout":
      return providerAction(item, actionId);
    case "provider-sort":
      return stringIn(value, ["off", "price", "throughput", "latency"])
        ? {
            kind: "config",
            action: {
              kind: actionId,
              value: value === "off" ? undefined : value,
            },
          }
        : invalid(value, "Provider sort is invalid");
    case "provider-data-collection":
      return stringIn(value, ["allow", "deny"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Data-sharing choice is invalid");
    case "provider-only":
    case "provider-ignore":
      return isStringArray(value)
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Provider list is invalid");
    case "provider-fallback":
      return onOffAction(value, actionId);
    case "approval-mode":
      if (!stringIn(value, ["read-only", "ask", "auto-edit", "allow-all"])) {
        return invalid(value, "Approval mode is invalid");
      }
      return value === "allow-all"
        ? { kind: "allow-all-confirm" }
        : { kind: "config", action: { kind: actionId, value } };
    case "approval-forget": {
      const ruleId = dynamicSuffix(item.id, "approval-forget:");
      return ruleId
        ? { kind: "external", action: { kind: "approval-forget", ruleId } }
        : invalid(value, "Rule is invalid");
    }
    case "approval-forget-all":
      return { kind: "external", action: { kind: "approval-forget-all" } };
    case "max-cost":
    case "compressor-max-cost":
    case "low-balance-threshold":
      return finiteNumberAction(actionId, value);
    case "budget-daily":
    case "budget-total":
      return nullableNumberAction(actionId, value);
    case "budget-on-exceed":
      return stringIn(value, ["warn", "block"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Budget action is invalid");
    case "verify-mode":
      return stringIn(value, ["off", "on-edit"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Verify mode is invalid");
    case "verify-commands":
      return isStringArray(value)
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Verify commands are invalid");
    case "verify-suggest":
      return { kind: "external", action: { kind: "verify-suggest" } };
    case "verify-clear":
      return { kind: "config", action: { kind: "verify-clear" } };
    case "verify-repair-rounds":
      return finiteNumberAction(actionId, value);
    case "web-mode":
      return stringIn(value, ["on", "off", "auto"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Web mode is invalid");
    case "browser-path":
      return typeof value === "string"
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Browser path is invalid");
    case "browser-timeout":
      return finiteNumberAction(actionId, value);
    case "panel-models": {
      if (!isStringArray(value)) return invalid(value, "Panel choice is invalid");
      try {
        const modelIds = validatePanelModelSelection(
          value,
          snapshot.cachedModels
            .filter(isPanelModelCandidate)
            .flatMap((model) => [model.id, model.canonicalSlug].filter(isString)),
        );
        return { kind: "external", action: { kind: "panel-models", modelIds } };
      } catch {
        return invalid(value, "Panel choice is invalid");
      }
    }
    case "panel-judge":
      return onOffAction(value, actionId);
    case "transcription-model": {
      if (typeof value !== "string") return invalid(value, "Audio model is invalid");
      const model = findModel(snapshot, value);
      if (!model || !isAudioInputModelCandidate(model)) {
        return invalid(value, "Audio model is not available");
      }
      return {
        kind: "external",
        action: { kind: "transcription-model", modelId: model.id },
      };
    }
    case "voice-consent-clear":
      return { kind: "config", action: { kind: "voice-consent-clear" } };
    case "appearance-large-logo":
    case "appearance-header-mark":
      return onOffAction(value, actionId);
    case "appearance-glyph-mode":
      return stringIn(value, ["auto", "unicode", "ascii"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Terminal characters choice is invalid");
    case "cross-lead-model":
      return crossRoleModelAction(value, "lead");
    case "cross-challenger-model":
      return crossRoleModelAction(value, "challenger");
    case "cross-pair-swap":
      return { kind: "external", action: { kind: "cross-swap" } };
    case "architect-executor-model":
      return architectExecutorModelAction(value);
    default:
      return assertNever(actionId);
  }
}

export function applyConfigAction(
  candidate: OrcodeConfigWithBudget,
  action: SettingsConfigAction,
): void {
  switch (action.kind) {
    case "reasoning":
      candidate.reasoningByModel[action.modelId] = structuredClone(action.value);
      return;
    case "compression-mode":
      candidate.compressionMode = action.value;
      return;
    case "max-steps":
      candidate.maxSteps = action.value;
      return;
    case "provider-sort":
      if (action.value === undefined) delete candidate.provider.sort;
      else candidate.provider.sort = action.value;
      return;
    case "provider-data-collection":
      candidate.provider.dataCollection = action.value;
      return;
    case "provider-only":
      if (action.value.length === 0) delete candidate.provider.only;
      else candidate.provider.only = [...action.value];
      return;
    case "provider-ignore":
      if (action.value.length === 0) delete candidate.provider.ignore;
      else candidate.provider.ignore = [...action.value];
      return;
    case "provider-fallback":
      candidate.provider.allowFallbacks = action.value;
      return;
    case "approval-mode":
      candidate.approvalMode = action.value;
      return;
    case "max-cost":
      candidate.maxCostUsd = action.value;
      return;
    case "low-balance-threshold":
      candidate.lowBalanceThresholdUsd = action.value;
      return;
    case "compressor-max-cost":
      candidate.compressorMaxCostUsd = action.value;
      return;
    case "budget-daily":
      candidate.budget.dailyLimitUsd = action.value;
      return;
    case "budget-total":
      candidate.budget.totalLimitUsd = action.value;
      return;
    case "budget-on-exceed":
      candidate.budget.onExceed = action.value;
      return;
    case "verify-mode":
      candidate.verify.mode = action.value;
      return;
    case "verify-commands":
      candidate.verify.commands = [...action.value];
      return;
    case "verify-clear":
      candidate.verify.commands = [];
      return;
    case "verify-repair-rounds":
      candidate.verify.maxRepairRounds = action.value;
      return;
    case "web-mode":
      candidate.web = action.value;
      return;
    case "browser-path":
      candidate.browserPath = action.value;
      return;
    case "browser-timeout":
      candidate.browserTimeoutSeconds = action.value;
      return;
    case "panel-judge":
      candidate.panelJudge = action.value;
      return;
    case "voice-consent-clear":
      candidate.voiceConsentGiven = false;
      return;
    case "appearance-large-logo":
      candidate.appearance.showLargeLogo = action.value;
      return;
    case "appearance-header-mark":
      candidate.appearance.showHeaderMark = action.value;
      return;
    case "appearance-glyph-mode":
      candidate.appearance.glyphMode = action.value;
      return;
    default:
      return assertNever(action);
  }
}

function configActionApplied(
  config: OrcodeConfigWithBudget,
  action: SettingsConfigAction,
): boolean {
  switch (action.kind) {
    case "reasoning":
      return sameValue(config.reasoningByModel[action.modelId], action.value);
    case "compression-mode":
      return config.compressionMode === action.value;
    case "max-steps":
      return config.maxSteps === action.value;
    case "provider-sort":
      return config.provider.sort === action.value;
    case "provider-data-collection":
      return config.provider.dataCollection === action.value;
    case "provider-only":
      return sameValue(config.provider.only ?? [], action.value);
    case "provider-ignore":
      return sameValue(config.provider.ignore ?? [], action.value);
    case "provider-fallback":
      return config.provider.allowFallbacks === action.value;
    case "approval-mode":
      return config.approvalMode === action.value;
    case "max-cost":
      return config.maxCostUsd === action.value;
    case "low-balance-threshold":
      return config.lowBalanceThresholdUsd === action.value;
    case "compressor-max-cost":
      return config.compressorMaxCostUsd === action.value;
    case "budget-daily":
      return config.budget.dailyLimitUsd === action.value;
    case "budget-total":
      return config.budget.totalLimitUsd === action.value;
    case "budget-on-exceed":
      return config.budget.onExceed === action.value;
    case "verify-mode":
      return config.verify.mode === action.value;
    case "verify-commands":
      return sameValue(config.verify.commands, action.value);
    case "verify-clear":
      return config.verify.commands.length === 0;
    case "verify-repair-rounds":
      return config.verify.maxRepairRounds === action.value;
    case "web-mode":
      return config.web === action.value;
    case "browser-path":
      return config.browserPath === action.value;
    case "browser-timeout":
      return config.browserTimeoutSeconds === action.value;
    case "panel-judge":
      return config.panelJudge === action.value;
    case "voice-consent-clear":
      return config.voiceConsentGiven === false;
    case "appearance-large-logo":
      return config.appearance.showLargeLogo === action.value;
    case "appearance-header-mark":
      return config.appearance.showHeaderMark === action.value;
    case "appearance-glyph-mode":
      return config.appearance.glyphMode === action.value;
    default:
      return assertNever(action);
  }
}

function retainedValueForAction(action: SettingsConfigAction): SettingsEditorValue {
  switch (action.kind) {
    case "reasoning":
      return reasoningChoiceValue(action.value);
    case "verify-clear":
    case "voice-consent-clear":
      return true;
    case "provider-sort":
      return action.value ?? "off";
    case "provider-only":
    case "provider-ignore":
    case "verify-commands":
      return [...action.value];
    case "budget-daily":
    case "budget-total":
      return action.value ?? "off";
    case "provider-fallback":
    case "panel-judge":
    case "appearance-large-logo":
    case "appearance-header-mark":
      return action.value ? "on" : "off";
    case "compression-mode":
    case "max-steps":
    case "provider-data-collection":
    case "approval-mode":
    case "max-cost":
    case "compressor-max-cost":
    case "low-balance-threshold":
    case "budget-on-exceed":
    case "verify-mode":
    case "verify-repair-rounds":
    case "web-mode":
    case "browser-path":
    case "browser-timeout":
    case "appearance-glyph-mode":
      return action.value;
    default:
      return assertNever(action);
  }
}

/**
 * The counterpart ROLE the picker must exclude — never the row's own role,
 * and (F1b) never the counterpart's route: Settings holds only the reduced
 * pair now, so all it can honestly say is "exclude whatever is set as the
 * challenger". `undefined` when the counterpart is unset, which is the same
 * answer the route-valued predecessor gave.
 */
function crossExcludeCounterpartRole(
  item: SettingsItem,
  cross: SettingsControllerSnapshot["cross"],
): "lead" | "challenger" | undefined {
  if (item.editor.kind !== "model") return undefined;
  if (item.editor.actionId === "cross-lead-model") {
    return cross.preferences.challenger ? "challenger" : undefined;
  }
  if (item.editor.actionId === "cross-challenger-model") {
    return cross.preferences.lead ? "lead" : undefined;
  }
  return undefined;
}

function initialValue(
  item: SettingsItem,
  config: OrcodeConfigWithBudget,
  cross: SettingsControllerSnapshot["cross"],
): SettingsEditorValue | undefined {
  if (item.editor.kind === "readonly") return undefined;
  switch (item.editor.actionId) {
    case "main-model":
      return config.mainModel;
    case "reasoning":
      return reasoningChoiceValue(getReasoningSetting(config));
    case "reasoning-compressor":
      return reasoningChoiceValue(getReasoningSetting(config, config.compressorModel));
    case "reasoning-cross-lead":
      return reasoningChoiceValue(
        cross.preferences.lead
          ? getReasoningSetting(config, cross.preferences.lead.requestedModelId)
          : DEFAULT_REASONING_SETTING,
      );
    case "reasoning-cross-challenger":
      return reasoningChoiceValue(
        cross.preferences.challenger
          ? getReasoningSetting(config, cross.preferences.challenger.requestedModelId)
          : DEFAULT_REASONING_SETTING,
      );
    case "compression-mode":
      return config.compressionMode;
    case "compressor-model":
      return config.compressorModel;
    case "max-steps":
      return config.maxSteps;
    case "provider-sort":
      return config.provider.sort ?? "off";
    case "provider-data-collection":
      return config.provider.dataCollection;
    case "provider-only":
      return [...(config.provider.only ?? [])];
    case "provider-ignore":
      return [...(config.provider.ignore ?? [])];
    case "provider-fallback":
      return config.provider.allowFallbacks === false ? "off" : "on";
    case "approval-mode":
      return config.approvalMode;
    case "max-cost":
      return config.maxCostUsd;
    case "low-balance-threshold":
      return config.lowBalanceThresholdUsd;
    case "compressor-max-cost":
      return config.compressorMaxCostUsd;
    case "budget-daily":
      return config.budget.dailyLimitUsd ?? "off";
    case "budget-total":
      return config.budget.totalLimitUsd ?? "off";
    case "budget-on-exceed":
      return config.budget.onExceed;
    case "verify-mode":
      return config.verify.mode;
    case "verify-commands":
      return [...config.verify.commands];
    case "verify-repair-rounds":
      return config.verify.maxRepairRounds;
    case "web-mode":
      return config.web;
    case "browser-path":
      return config.browserPath;
    case "browser-timeout":
      return config.browserTimeoutSeconds;
    case "panel-models":
      return [...config.panelModels];
    case "panel-judge":
      return config.panelJudge ? "on" : "off";
    case "transcription-model":
      return config.transcriptionModel;
    case "voice-consent-clear":
    case "verify-clear":
    case "approval-forget":
    case "approval-forget-all":
      return false;
    case "appearance-large-logo":
      return config.appearance.showLargeLogo ? "on" : "off";
    case "appearance-header-mark":
      return config.appearance.showHeaderMark ? "on" : "off";
    case "appearance-glyph-mode":
      return config.appearance.glyphMode;
    case "cross-lead-model":
      return cross.preferences.lead?.requestedModelId ?? "";
    case "cross-challenger-model":
      return cross.preferences.challenger?.requestedModelId ?? "";
    case "architect-executor-model":
      return config.architectExecutor?.requestedModelId ?? "";
    case "provider-setup":
    case "provider-connect":
    case "provider-enable":
    case "provider-disable":
    case "provider-disconnect":
    case "provider-reconnect":
    case "provider-models":
    case "provider-logout":
    case "verify-suggest":
    case "cross-pair-swap":
      return undefined;
    default:
      return assertNever(item.editor.actionId);
  }
}

function invalid(
  value: SettingsEditorValue | number | null,
  message: string,
): InterpretedEditorResult {
  return {
    kind: "invalid",
    retainedValue: sanitizeEditorValue(value ?? "off"),
    message,
  };
}

function parseNumberValue(
  value: SettingsEditorValue,
  allowOff: boolean,
):
  | { readonly kind: "value"; readonly value: number | null; readonly retained: SettingsEditorValue }
  | { readonly kind: "invalid"; readonly retained: SettingsEditorValue } {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "value", value, retained: value }
      : { kind: "invalid", retained: 0 };
  }
  if (typeof value !== "string") {
    return { kind: "invalid", retained: sanitizeEditorValue(value) };
  }
  const retained = sanitizeEditorString(value, 128).trim();
  if (hasDisallowedControls(value, false) || [...value].length > 128) {
    return { kind: "invalid", retained };
  }
  if (allowOff && retained.toLowerCase() === "off") {
    return { kind: "value", value: null, retained };
  }
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(retained)) {
    return { kind: "invalid", retained };
  }
  const parsed = Number(retained);
  return Number.isFinite(parsed)
    ? { kind: "value", value: parsed, retained }
    : { kind: "invalid", retained };
}

function parseTextValue(
  value: SettingsEditorValue,
  kind: "path" | "command-list" | "provider-list",
):
  | { readonly kind: "value"; readonly value: string | readonly string[] }
  | { readonly kind: "invalid"; readonly retained: SettingsEditorValue; readonly message: string } {
  if (kind === "path") {
    if (typeof value !== "string") {
      return { kind: "invalid", retained: sanitizeEditorValue(value), message: "Path is invalid" };
    }
    const retained = sanitizeEditorString(value, 4_096).trim();
    if (hasDisallowedControls(value, false) || [...value].length > 4_096) {
      return { kind: "invalid", retained, message: "Path is invalid" };
    }
    return { kind: "value", value: retained };
  }

  const rawValues = typeof value === "string"
    ? value.split(kind === "command-list" ? /[\r\n]+/ : /[,\r\n]+/)
    : isStringArray(value)
      ? [...value]
      : null;
  if (!rawValues) {
    return { kind: "invalid", retained: sanitizeEditorValue(value), message: "List is invalid" };
  }
  const retained = rawValues.map((entry) => sanitizeEditorString(entry, 512).trim());
  if (rawValues.some((entry) => hasDisallowedControls(entry, false))
    || rawValues.length > 20
    || rawValues.some((entry) => [...entry].length > 512)) {
    return { kind: "invalid", retained, message: "List is invalid" };
  }
  const normalized = retained.filter(Boolean);
  if (kind === "command-list" && normalized.length === 0) {
    return { kind: "invalid", retained, message: "At least one verify command is required" };
  }
  return { kind: "value", value: normalized };
}

function parseModelValue(
  value: SettingsEditorValue,
  multiple: boolean,
):
  | { readonly kind: "value"; readonly value: string | readonly string[] | SettingsModelRouteValue }
  | { readonly kind: "invalid"; readonly retained: SettingsEditorValue } {
  if (multiple) {
    if (!isStringArray(value)) return { kind: "invalid", retained: sanitizeEditorValue(value) };
    const retained = value.map((entry) => sanitizeEditorString(entry, 512).trim());
    if (value.length > 5
      || value.some((entry) => [...entry].length > 512 || hasDisallowedControls(entry, false))
      || retained.some((entry) => !entry)
      || new Set(retained).size !== retained.length) {
      return { kind: "invalid", retained };
    }
    return { kind: "value", value: retained };
  }
  if (isSettingsModelRouteValue(value)) {
    return exactRoutePickerSelection(value)
      ? { kind: "value", value }
      : { kind: "invalid", retained: "off" };
  }
  if (typeof value !== "string") return { kind: "invalid", retained: sanitizeEditorValue(value) };
  const retained = sanitizeEditorString(value, 512).trim();
  return retained
    && [...value].length <= 512
    && !hasDisallowedControls(value, false)
    ? { kind: "value", value: retained }
    : { kind: "invalid", retained };
}

function integerAction(actionId: SettingsActionId): boolean {
  return actionId === "max-steps"
    || actionId === "verify-repair-rounds"
    || actionId === "browser-timeout";
}

function modelRouteAction(
  value: SettingsEditorValue | number | null,
  kind: "compressor-model",
): InterpretedEditorResult {
  const selection = exactRoutePickerSelection(value);
  return selection
    ? { kind: "external", action: { kind, selection } }
    : invalid(value, "Model choice is no longer available");
}

function crossRoleModelAction(
  value: SettingsEditorValue | number | null,
  role: "lead" | "challenger",
): InterpretedEditorResult {
  const selection = exactRoutePickerSelection(value);
  return selection
    ? { kind: "external", action: { kind: "cross-role", role, selection } }
    : invalid(value, "Model choice is no longer available");
}

/** Phase 14: same shape as `crossRoleModelAction` above, minus the role/staging — a single route commits immediately, no counterpart to wait on. */
function architectExecutorModelAction(
  value: SettingsEditorValue | number | null,
): InterpretedEditorResult {
  const selection = exactRoutePickerSelection(value);
  return selection
    ? { kind: "external", action: { kind: "architect-executor-model", selection } }
    : invalid(value, "Model choice is no longer available");
}

function isSettingsModelRouteValue(value: unknown): value is SettingsModelRouteValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SettingsModelRouteValue>;
  return Object.keys(value).length === 2
    && record.kind === "model-route"
    && Boolean(record.selection)
    && typeof record.selection === "object";
}

function exactRoutePickerSelection(
  value: SettingsEditorValue | number | null,
): RoutePickerSelectionIntent | null {
  if (!isSettingsModelRouteValue(value)) return null;
  return parsePublicRoutePickerSelection(value.selection);
}

function providerAction(
  item: SettingsItem,
  actionId: Extract<SettingsActionId,
    | "provider-connect"
    | "provider-enable"
    | "provider-disable"
    | "provider-disconnect"
    | "provider-reconnect"
    | "provider-models"
    | "provider-logout">,
): InterpretedEditorResult {
  const match = /^provider-action:(openrouter|kimi-code|anthropic):(connect|enable|disable|disconnect|reconnect|models|logout)$/.exec(item.id);
  if (!match) return invalid(true, "Provider action is invalid");
  const backendId = match[1] as "openrouter" | "kimi-code" | "anthropic";
  const operation = match[2] as ProviderBackendAction;
  if (`provider-${operation}` !== actionId) {
    return invalid(true, "Provider action is invalid");
  }
  return {
    kind: "external",
    action: {
      kind: "provider",
      intent: { kind: operation, backendId },
    },
  };
}

function finiteNumberAction(
  kind: Extract<SettingsConfigAction, { readonly value: number }>["kind"],
  value: SettingsEditorValue | number | null,
): InterpretedEditorResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(value, "Number is invalid");
  }
  return {
    kind: "config",
    action: { kind, value } as SettingsConfigAction,
  };
}

function nullableNumberAction(
  kind: "budget-daily" | "budget-total",
  value: SettingsEditorValue | number | null,
): InterpretedEditorResult {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    return invalid(value, "Number is invalid");
  }
  return { kind: "config", action: { kind, value } };
}

function onOffAction(
  value: SettingsEditorValue | number | null,
  kind:
    | "provider-fallback"
    | "panel-judge"
    | "appearance-large-logo"
    | "appearance-header-mark",
): InterpretedEditorResult {
  if (value !== "on" && value !== "off") return invalid(value, "On/off choice is invalid");
  return {
    kind: "config",
    action: { kind, value: value === "on" } as SettingsConfigAction,
  };
}

/**
 * Resolves a reasoning row's action id to the model id it targets — the same
 * id `reasoningByModel` keys by, so `main-model`'s "reasoning" action and a
 * Cross role's action both write and read through one shared per-model store
 * with no schema change. Null means the role has no model chosen yet (only
 * possible for the two Cross roles); callers must reject the action then,
 * matching the row being disabled in the registry.
 */
function reasoningRoleModelId(
  actionId: Extract<
    SettingsActionId,
    "reasoning" | "reasoning-compressor" | "reasoning-cross-lead" | "reasoning-cross-challenger"
  >,
  snapshot: SettingsControllerSnapshot,
): string | null {
  switch (actionId) {
    case "reasoning":
      return snapshot.config.mainModel;
    case "reasoning-compressor":
      return snapshot.config.compressorModel;
    case "reasoning-cross-lead":
      return snapshot.cross.preferences.lead?.requestedModelId ?? null;
    case "reasoning-cross-challenger":
      return snapshot.cross.preferences.challenger?.requestedModelId ?? null;
    default:
      return assertNever(actionId);
  }
}

function parseReasoning(value: string): ReasoningSetting | null {
  if (value === "auto") return { mode: "auto" };
  if (value.startsWith("effort:")) {
    const effort = value.slice("effort:".length);
    if (stringIn(effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max"])) {
      return { mode: "effort", effort: effort as ReasoningEffort };
    }
    return null;
  }
  const budget = /^budget:(\d+)$/.exec(value);
  if (!budget) return null;
  const maxTokens = Number(budget[1]);
  return Number.isSafeInteger(maxTokens) && maxTokens >= 1
    ? { mode: "budget", maxTokens }
    : null;
}

function findModel(snapshot: SettingsControllerSnapshot, id: string) {
  return snapshot.cachedModels.find((model) => model.id === id || model.canonicalSlug === id);
}

function dynamicSuffix(itemId: SettingsItemId, prefix: string): string | null {
  return itemId.startsWith(prefix) && itemId.length > prefix.length
    ? itemId.slice(prefix.length)
    : null;
}

function stringIn<const T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sanitizeEditorValue(
  value: SettingsEditorValue | number | null,
): SettingsEditorValue {
  if (typeof value === "string") return sanitizeEditorString(value, 4_096);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeEditorString(entry, 512));
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (isSettingsModelRouteValue(value)) return value;
  return "off";
}

function validRuntimeEditorResult(value: unknown): value is SettingsEditorResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return record.kind === "cancel"
    ? keys.length === 1 && keys[0] === "kind"
    : record.kind === "value"
      ? keys.length === 2 && keys.includes("kind") && keys.includes("value")
      : false;
}

/**
 * FIX-14 ticket 7 (honesty half): this used to cut SILENTLY — an editor
 * value longer than `limit` lost its tail with nothing on screen to say so,
 * which is the "nothing may silently not-exist" rule FIX-5 ruling 1 states
 * for lists, applied to a string. It marks the cut now.
 *
 * The slice stays code-POINT based (`[...value]`) rather than going through
 * `ellipsize`: an editor value can carry astral characters, and cutting a
 * surrogate pair in half would produce a lone surrogate. Same rule (the
 * marker is inside the budget), different unit, stated rather than shared.
 */
function sanitizeEditorString(value: string, limit: number): string {
  const points = [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")];
  return points.length <= limit
    ? points.join("")
    : `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function hasDisallowedControls(value: string, allowLineBreaks: boolean): boolean {
  const candidate = allowLineBreaks ? value.replace(/[\r\n]/g, "") : value;
  return /[\p{Cc}\p{Cf}]/u.test(candidate);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeSearchQuery(value: string): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 120).join("");
}

/** FIX-14 ticket 7: same rule, same reason — a cut notice says it was cut. */
function oneLine(value: string): string {
  return sanitizeEditorString(value.replace(/[\r\n]/g, " "), 160);
}

function sameExactConfig(left: OrcodeConfigWithBudget, right: OrcodeConfigWithBudget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProjectedConfig(
  left: OrcodeConfigWithBudget | SettingsConfigProjection,
  right: OrcodeConfigWithBudget | SettingsConfigProjection,
): boolean {
  return JSON.stringify(projectSettingsConfig(left)) === JSON.stringify(projectSettingsConfig(right));
}

/**
 * The stored config is not what THIS process last published or loaded, so
 * somebody else owns those bytes now.
 *
 * A process that never observed the file has nothing to call foreign: the
 * guard only ever speaks about a file this process has actually seen, and
 * `null` is never reached from a real startup, which seeds the baseline from
 * the same load that produced the runtime config.
 */
function foreignConfigWrite(
  baseline: OrcodeConfigWithBudget | SettingsConfigProjection | null,
  stored: OrcodeConfigWithBudget,
): boolean {
  return baseline !== null && !sameProjectedConfig(baseline, stored);
}

/** Registry compatibility shell with a static identity-free provider state it never reads. */
function registrySnapshot(snapshot: SettingsControllerSnapshot): SettingsAuthoritativeSnapshot {
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      providerSetup: createNeverConfiguredProviderState(),
    },
  };
}

function desktopProjectionItem(item: SettingsItem): SettingsDesktopProjectionItem {
  return Object.freeze({
    id: item.id,
    categoryId: item.categoryId,
    editor: desktopProjectionEditor(item.editor),
    ...(item.disabledReason !== undefined ? { disabledReason: item.disabledReason } : {}),
  });
}

function desktopProjectionEditor(editor: SettingsEditorDescriptor): SettingsDesktopEditorSchema {
  switch (editor.kind) {
    case "choice":
      return Object.freeze({
        kind: editor.kind,
        actionId: editor.actionId,
        values: Object.freeze(editor.options.map(({ value }) => value)),
      });
    case "model":
      return Object.freeze({
        kind: editor.kind,
        actionId: editor.actionId,
        filter: editor.filter,
        ...(editor.multiple === true ? { multiple: true as const } : {}),
      });
    case "number":
      return Object.freeze({
        kind: editor.kind,
        actionId: editor.actionId,
        minimum: editor.minimum,
        maximum: editor.maximum,
        ...(editor.unit !== undefined ? { unit: editor.unit } : {}),
        ...(editor.allowOff === true ? { allowOff: true as const } : {}),
      });
    case "text":
      return Object.freeze({ kind: editor.kind, actionId: editor.actionId, valueKind: editor.valueKind });
    case "confirm":
      return Object.freeze({ kind: editor.kind, actionId: editor.actionId, destructive: editor.destructive });
    case "invoke":
      return Object.freeze({ kind: editor.kind, actionId: editor.actionId });
    case "readonly":
      return Object.freeze({ kind: editor.kind });
    default:
      return assertNever(editor);
  }
}

export function projectSettingsDesktopRowTruth(
  snapshot: SettingsControllerSnapshot,
  item: SettingsItem,
): SettingsDesktopRowTruth {
  const config = snapshot.config;
  switch (item.id) {
    case "main-model":
      return Object.freeze({
        kind: "model",
        modelIds: Object.freeze([config.mainModel]),
        state: snapshot.routeRunnable === false ? "not-connected" : "configured",
      });
    case "compressor-model":
      return Object.freeze({ kind: "model", modelIds: Object.freeze([config.compressorModel]), state: "configured" });
    case "cross-lead-model": {
      const modelId = snapshot.cross.preferences.lead?.requestedModelId ?? null;
      return Object.freeze({
        kind: "model",
        modelIds: Object.freeze(modelId ? [modelId] : []),
        state: modelId ? "staged" : "unset",
      });
    }
    case "cross-challenger-model": {
      const modelId = snapshot.cross.preferences.challenger?.requestedModelId ?? null;
      return Object.freeze({
        kind: "model",
        modelIds: Object.freeze(modelId ? [modelId] : []),
        state: modelId ? "staged" : "unset",
      });
    }
    case "architect-executor-model": {
      const modelId = config.architectExecutor?.requestedModelId ?? null;
      return Object.freeze({
        kind: "model",
        modelIds: Object.freeze(modelId ? [modelId] : []),
        state: modelId ? "configured" : "unset",
      });
    }
    case "panel-models":
      return Object.freeze({
        kind: "model",
        modelIds: Object.freeze([...config.panelModels]),
        state: config.panelModels.length > 0 ? "configured" : "unset",
      });
    case "transcription-model":
      return Object.freeze({ kind: "model", modelIds: Object.freeze([config.transcriptionModel]), state: "configured" });
    case "reasoning":
      return desktopReasoningTruth(item, config.mainModel, config);
    case "reasoning-compressor":
      return desktopReasoningTruth(item, config.compressorModel, config);
    case "reasoning-cross-lead":
      return desktopReasoningTruth(item, snapshot.cross.preferences.lead?.requestedModelId ?? null, config);
    case "reasoning-cross-challenger":
      return desktopReasoningTruth(item, snapshot.cross.preferences.challenger?.requestedModelId ?? null, config);
    case "compression-mode":
      return Object.freeze({ kind: "choice", value: config.compressionMode });
    case "provider-sort":
      return Object.freeze({ kind: "choice", value: config.provider.sort ?? "off" });
    case "provider-data-collection":
      return Object.freeze({ kind: "choice", value: config.provider.dataCollection ?? "deny" });
    case "approval-mode":
      return Object.freeze({ kind: "choice", value: config.approvalMode });
    case "budget-on-exceed":
      return Object.freeze({ kind: "choice", value: config.budget.onExceed });
    case "verify-mode":
      return Object.freeze({ kind: "choice", value: config.verify.mode });
    case "web-mode":
      return Object.freeze({ kind: "choice", value: config.web });
    case "appearance-glyph-mode":
      return Object.freeze({ kind: "choice", value: config.appearance.glyphMode });
    case "provider-fallback":
      return Object.freeze({ kind: "boolean", value: config.provider.allowFallbacks ?? true });
    case "panel-judge":
      return Object.freeze({ kind: "boolean", value: config.panelJudge });
    case "appearance-large-logo":
      return Object.freeze({ kind: "boolean", value: config.appearance.showLargeLogo });
    case "appearance-header-mark":
      return Object.freeze({ kind: "boolean", value: config.appearance.showHeaderMark });
    case "max-steps":
      return Object.freeze({ kind: "number", value: config.maxSteps, unit: "integer" });
    case "verify-repair-rounds":
      return Object.freeze({ kind: "number", value: config.verify.maxRepairRounds, unit: "integer" });
    case "max-cost":
      return Object.freeze({ kind: "number", value: config.maxCostUsd, unit: "usd" });
    case "compressor-max-cost":
      return Object.freeze({ kind: "number", value: config.compressorMaxCostUsd, unit: "usd" });
    case "low-balance-threshold":
      return Object.freeze({ kind: "number", value: config.lowBalanceThresholdUsd, unit: "usd" });
    case "browser-timeout":
      return Object.freeze({ kind: "number", value: config.browserTimeoutSeconds, unit: "seconds" });
    case "budget-daily":
      return Object.freeze({ kind: "optional-usd", value: config.budget.dailyLimitUsd });
    case "budget-total":
      return Object.freeze({ kind: "optional-usd", value: config.budget.totalLimitUsd });
    case "provider-only":
      return Object.freeze({ kind: "provider-list", values: Object.freeze([...(config.provider.only ?? [])]) });
    case "provider-ignore":
      return Object.freeze({ kind: "provider-list", values: Object.freeze([...(config.provider.ignore ?? [])]) });
    case "browser-path":
      return Object.freeze({ kind: "path", value: config.browserPath || null });
    case "approval-forget-all":
      return Object.freeze({ kind: "count", count: snapshot.approvalRules.length, subject: "rules" });
    case "verify-commands":
      return Object.freeze({ kind: "count", count: config.verify.commands.length, subject: "commands" });
    case "verify-clear":
      return Object.freeze({ kind: "count", count: config.verify.commands.length, subject: "commands" });
    case "provider-setup":
    case "cross-pair-swap":
    case "verify-suggest":
      return Object.freeze({ kind: "action", actionId: item.id });
    case "voice-consent-clear":
      return Object.freeze({ kind: "action", actionId: item.id, active: config.voiceConsentGiven });
    case "cost-summary":
      return Object.freeze({
        kind: "cost",
        knowledge: snapshot.costs.costKnowledge,
        sessionUsd: snapshot.costs.sessionUsd,
        dayUsd: snapshot.costs.dayUsd,
        totalUsd: snapshot.costs.totalUsd,
      });
    case "voice-consent-status":
      return Object.freeze({ kind: "consent", granted: config.voiceConsentGiven });
    default:
      break;
  }

  const providerStatus = /^provider-status:(openrouter|kimi-code|anthropic)$/.exec(item.id);
  if (providerStatus) {
    const provider = snapshot.providers.find(({ backendId }) => backendId === providerStatus[1]);
    if (!provider) throw new Error("Invalid Desktop Settings provider status row.");
    return Object.freeze({
      kind: "provider-status",
      provider: Object.freeze({
        backendId: provider.backendId,
        availability: provider.availability,
        configuration: provider.configuration,
        maturity: provider.maturity,
        billingRealm: provider.billingRealm,
        headline: provider.headline,
        isDefault: provider.isDefault,
        selectedRequestedModelId: provider.selectedModel?.requestedModelId ?? null,
        allowedActions: Object.freeze([...provider.allowedActions]),
      }),
    });
  }
  const providerAction = /^provider-action:(openrouter|kimi-code|anthropic):(connect|enable|disable|disconnect|reconnect|models|logout)$/.exec(item.id);
  if (providerAction) {
    const backendId = providerAction[1] as SettingsProviderProjection["backendId"];
    const action = providerAction[2] as ProviderBackendAction;
    const provider = snapshot.providers.find((candidate) => candidate.backendId === backendId);
    if (!provider?.allowedActions.includes(action)) {
      throw new Error("Invalid Desktop Settings provider action row.");
    }
    return Object.freeze({ kind: "provider-action", backendId, action });
  }
  const approvalRule = /^approval-rule:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(item.id);
  if (approvalRule) {
    const rule = snapshot.approvalRules.find(({ id }) => id === approvalRule[1]);
    if (!rule) throw new Error("Invalid Desktop Settings approval row.");
    return Object.freeze({ kind: "approval-rule", decision: rule.decision });
  }
  const approvalForget = /^approval-forget:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(item.id);
  if (approvalForget && snapshot.approvalRules.some(({ id }) => id === approvalForget[1])) {
    return Object.freeze({ kind: "approval-forget" });
  }
  throw new Error("Invalid Desktop Settings row truth.");
}

function desktopReasoningTruth(
  item: SettingsItem,
  modelId: string | null,
  config: SettingsConfigProjection,
): SettingsDesktopRowTruth {
  if (item.editor.kind !== "choice") throw new Error("Invalid Desktop Settings reasoning row.");
  const setting = modelId ? getReasoningSetting(config, modelId) : DEFAULT_REASONING_SETTING;
  return Object.freeze({
    kind: "reasoning",
    value: reasoningChoiceValue(setting),
    options: Object.freeze(item.editor.options.map(({ value }) => value)),
  });
}

function projectControllerSnapshot(snapshot: SettingsControllerSnapshot): SettingsControllerSnapshot {
  return freezeClone({
    ...snapshot,
    config: projectSettingsConfig(snapshot.config),
  });
}

function freezeRequest(request: SettingsEditorRequest): SettingsEditorRequest {
  return freezeClone(request);
}

function editorActionId(request: SettingsEditorRequest): SettingsActionId | null {
  return request.editor.kind === "readonly" ? null : request.editor.actionId;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unreachable settings value: ${String(value)}`);
}
