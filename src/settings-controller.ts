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
import type { ProviderCommandIntent } from "./commands.js";
import {
  getReasoningSetting,
  reasoningChoiceValue,
} from "./reasoning.js";
import {
  SETTINGS_CATEGORY_IDS,
  buildSettingsRegistry,
  searchSettings,
  type ProviderBackendAction,
  type SettingsActionId,
  type SettingsAuthoritativeSnapshot,
  type SettingsCategory,
  type SettingsCategoryId,
  type SettingsEditorDescriptor,
  type SettingsItem,
  type SettingsItemId,
} from "./settings-registry.js";
import type {
  ApprovalMode,
  CompressionMode,
  ReasoningEffort,
  ReasoningSetting,
} from "./types.js";

export type SettingsControllerSnapshot = SettingsAuthoritativeSnapshot;

export type SettingsIntent =
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "category"; readonly categoryId: SettingsCategoryId }
  | { readonly kind: "search-start" }
  | { readonly kind: "search-change"; readonly query: string }
  | { readonly kind: "activate" }
  | { readonly kind: "select-item"; readonly itemId: SettingsItemId }
  | { readonly kind: "back" };

export type SettingsEditorValue = string | number | boolean | readonly string[];

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
}

export type SettingsControllerEffect =
  | { readonly kind: "render" }
  | { readonly kind: "close" }
  | { readonly kind: "edit"; readonly request: SettingsEditorRequest };

export type SettingsEditorResult =
  | { readonly kind: "cancel" }
  | { readonly kind: "value"; readonly value: SettingsEditorValue };

export interface SettingsSnapshotPort {
  read(): Promise<SettingsControllerSnapshot>;
}

export type SettingsExternalAction =
  | { readonly kind: "provider"; readonly intent: ProviderCommandIntent }
  | {
      readonly kind: "main-model";
      readonly requestedModelId: string;
      readonly canonicalModelId: string;
    }
  | { readonly kind: "compressor-model"; readonly modelId: string }
  | { readonly kind: "approval-forget"; readonly ruleId: string }
  | { readonly kind: "approval-forget-all" }
  | { readonly kind: "verify-suggest" }
  | { readonly kind: "panel-models"; readonly modelIds: readonly string[] }
  | { readonly kind: "transcription-model"; readonly modelId: string };

export interface SettingsExternalActionPort {
  execute(action: SettingsExternalAction): Promise<void>;
}

export interface PreparedLiveConfigPublication {
  /** Prevalidated synchronous commit; implementations MUST NOT throw. */
  publish(): void;
}

export interface SettingsLiveConfigPort {
  prepare(config: OrcodeConfigWithBudget): PreparedLiveConfigPublication;
}

export type SettingsConfigEditState =
  | { readonly kind: "editable"; readonly snapshot: ConfigEditSnapshot }
  | {
      readonly kind: "read-only";
      readonly config: OrcodeConfigWithBudget;
      readonly reason: "Konfiguration schreibgeschützt";
    };

export interface SettingsControllerDependencies {
  readonly configPath: string;
  readonly snapshots: SettingsSnapshotPort;
  readonly externalActions: SettingsExternalActionPort;
  readonly liveConfig: SettingsLiveConfigPort;
  readonly readConfig: (path: string) => Promise<ConfigEditSnapshot>;
  readonly saveConfig: (
    expected: ConfigEditSnapshot,
    candidate: ConfigInput,
    path: string,
  ) => Promise<OrcodeConfigWithBudget>;
}

export interface SettingsNotice {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
}

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
  readonly readOnlyReason: "Konfiguration schreibgeschützt" | null;
  readonly runActive: boolean;
  readonly notice: SettingsNotice | null;
}

export type SettingsConfigAction =
  | { readonly kind: "reasoning"; readonly value: ReasoningSetting }
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

const READ_ONLY_REASON = "Konfiguration schreibgeschützt" as const;
const CONFLICT_NOTICE = "Einstellung wurde parallel geändert";
const SAVE_ERROR_NOTICE = "Einstellung konnte nicht gespeichert werden";
const EXTERNAL_ERROR_NOTICE = "Aktion konnte nicht ausgeführt werden";
const UNVERIFIED_NOTICE = "Speicherzustand konnte nicht sicher bestätigt werden";
const ACTIVITY_ERROR_NOTICE = "Aktueller Laufstatus konnte nicht geprüft werden";
const SAVED_REFRESH_NOTICE = "Gespeichert; Ansicht konnte nicht aktualisiert werden";
const ACTION_REFRESH_NOTICE = "Aktion ausgeführt; Ansicht konnte nicht aktualisiert werden";
const ALLOW_ALL_WARNING =
  "allow-all führt Dateiänderungen und Shell-Befehle ohne Nachfrage aus. Wirklich aktivieren?";

/** A dependency may discover a run between the controller refresh and its CAS. */
export class SettingsRunActiveError extends Error {
  readonly code = "settings-run-active" as const;
}

export class SettingsController {
  readonly #dependencies: SettingsControllerDependencies;
  #snapshot: SettingsControllerSnapshot;
  #configEditState: SettingsConfigEditState;
  #allItems: readonly SettingsItem[] = [];
  #selectedCategoryId: SettingsCategoryId;
  #categoryFocus = new Map<SettingsCategoryId, SettingsItemId>();
  #searchActive = false;
  #searchQuery = "";
  #searchItemId: SettingsItemId | null = null;
  #notice: SettingsNotice | null = null;
  #pending: PendingEditor | null = null;
  #generation = 0;
  #completionTail: Promise<void> = Promise.resolve();

  private constructor(
    dependencies: SettingsControllerDependencies,
    snapshot: SettingsControllerSnapshot,
    configEditState: SettingsConfigEditState,
    initialCategory: SettingsCategoryId,
  ) {
    this.#dependencies = dependencies;
    this.#snapshot = freezeClone(snapshot);
    this.#configEditState = configEditState;
    this.#selectedCategoryId = initialCategory;
    this.#rebuildRegistry();
    this.#ensureCategoryFocus(initialCategory);
  }

  static async open(
    dependencies: SettingsControllerDependencies,
    initialCategory: SettingsCategoryId = "models-reasoning",
  ): Promise<SettingsController> {
    const runtime = await dependencies.snapshots.read();
    let controllerSnapshot = runtime;
    let configEditState: SettingsConfigEditState;
    try {
      const exact = await dependencies.readConfig(dependencies.configPath);
      if (sameConfig(runtime.config, exact.config)) {
        configEditState = { kind: "editable", snapshot: exact };
      } else {
        controllerSnapshot = { ...runtime, config: exact.config };
        configEditState = {
          kind: "read-only",
          config: freezeClone(exact.config),
          reason: READ_ONLY_REASON,
        };
      }
    } catch {
      configEditState = {
        kind: "read-only",
        config: freezeClone(runtime.config),
        reason: READ_ONLY_REASON,
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
      categories: Object.freeze([...buildSettingsRegistry(this.#snapshot).categories]),
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

  async dispatch(intent: SettingsIntent): Promise<SettingsControllerEffect> {
    if (this.#pending) return { kind: "edit", request: this.#pending.request };
    this.#notice = null;
    switch (intent.kind) {
      case "move":
        this.#move(intent.delta);
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
        return { kind: "close" };
      default:
        return assertNever(intent);
    }
  }

  completeEditor(
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsControllerEffect> {
    let resolveResult!: (effect: SettingsControllerEffect) => void;
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<SettingsControllerEffect>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#completionTail = this.#completionTail.then(async () => {
      try {
        resolveResult(await this.#completeEditorSerial(request, result));
      } catch (error) {
        rejectResult(error);
      }
    }, async () => {
      try {
        resolveResult(await this.#completeEditorSerial(request, result));
      } catch (error) {
        rejectResult(error);
      }
    });
    return resultPromise;
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
    if (result.kind === "cancel") return { kind: "render" };

    const interpreted = pending.phase === "allow-all-confirm"
      ? interpretAllowAllConfirmation(result.value)
      : interpretEditorValue(pending.item, result.value, this.#snapshot);
    if (interpreted.kind === "cancel") return { kind: "render" };
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
      activity = await this.#dependencies.snapshots.read();
    } catch {
      this.#notice = Object.freeze({ kind: "error", message: ACTIVITY_ERROR_NOTICE });
      return { kind: "render" };
    }
    if (activity.runActive && pending.item.affectsActiveRun) {
      this.#snapshot = freezeClone(activity);
      this.#notice = Object.freeze({ kind: "info", message: "Lauf aktiv" });
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
      label: "allow-all aktivieren?",
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

  async #executeExternal(
    pending: PendingEditor,
    action: SettingsExternalAction,
  ): Promise<SettingsControllerEffect> {
    try {
      await this.#dependencies.externalActions.execute(action);
    } catch {
      this.#notice = Object.freeze({ kind: "error", message: EXTERNAL_ERROR_NOTICE });
      return { kind: "render" };
    }

    if (!await this.#refreshOrReadOnly(
      pending.item.id,
      this.#snapshot,
      this.#snapshot.config,
    )) {
      this.#notice = Object.freeze({ kind: "success", message: ACTION_REFRESH_NOTICE });
      return { kind: "render" };
    }
    this.#notice = Object.freeze({ kind: "success", message: "Gespeichert" });
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
          "Der Wert ist für diese Einstellung nicht zulässig",
        );
      }
    } catch {
      return this.#retryEditor(
        pending,
        retainedValueForAction(action),
        "Der Wert ist für diese Einstellung nicht zulässig",
      );
    }

    let publication: PreparedLiveConfigPublication;
    try {
      publication = this.#dependencies.liveConfig.prepare(validated);
    } catch {
      this.#notice = Object.freeze({ kind: "error", message: SAVE_ERROR_NOTICE });
      return { kind: "render" };
    }

    let saved: OrcodeConfigWithBudget;
    try {
      saved = await this.#dependencies.saveConfig(
        pending.configSnapshot,
        validated,
        this.#dependencies.configPath,
      );
    } catch (error) {
      if (error instanceof SettingsRunActiveError) {
        this.#notice = Object.freeze({ kind: "info", message: "Lauf aktiv" });
        return { kind: "render" };
      }
      if (error instanceof ConfigEditConflictError) {
        await this.#refreshOrReadOnly(
          pending.item.id,
          activity,
          activity.config,
        );
        this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
        return { kind: "render" };
      }
      if (error instanceof ConfigEditUnverifiedError) {
        return this.#reconcileUnverified(
          pending.item.id,
          activity,
          validated,
          publication,
        );
      }
      this.#notice = Object.freeze({ kind: "error", message: SAVE_ERROR_NOTICE });
      return { kind: "render" };
    }

    if (!sameConfig(saved, validated)) {
      await this.#refreshOrReadOnly(
        pending.item.id,
        { ...activity, config: saved },
        saved,
      );
      this.#notice = Object.freeze({ kind: "error", message: UNVERIFIED_NOTICE });
      return { kind: "render" };
    }

    publication.publish();
    if (!await this.#refreshOrReadOnly(
      pending.item.id,
      { ...activity, config: saved },
      saved,
    )) {
      this.#notice = Object.freeze({ kind: "success", message: SAVED_REFRESH_NOTICE });
      return { kind: "render" };
    }
    this.#notice = Object.freeze({ kind: "success", message: "Gespeichert" });
    return { kind: "render" };
  }

  async #reconcileUnverified(
    focusItemId: SettingsItemId,
    activity: SettingsControllerSnapshot,
    validated: OrcodeConfigWithBudget,
    publication: PreparedLiveConfigPublication,
  ): Promise<SettingsControllerEffect> {
    let exact: ConfigEditSnapshot;
    try {
      exact = await this.#dependencies.readConfig(this.#dependencies.configPath);
    } catch {
      this.#snapshot = freezeClone(activity);
      this.#configEditState = {
        kind: "read-only",
        config: freezeClone(activity.config),
        reason: READ_ONLY_REASON,
      };
      this.#rebuildRegistry();
      this.#restoreFocus(focusItemId);
      this.#notice = Object.freeze({ kind: "error", message: UNVERIFIED_NOTICE });
      return { kind: "render" };
    }

    if (!sameConfig(exact.config, validated)) {
      try {
        const runtime = await this.#dependencies.snapshots.read();
        if (!sameConfig(runtime.config, exact.config)) {
          this.#enterReadOnly(
            focusItemId,
            { ...runtime, config: exact.config },
            exact.config,
          );
          this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
          return { kind: "render" };
        }
        this.#snapshot = freezeClone(runtime);
        this.#configEditState = { kind: "editable", snapshot: exact };
      } catch {
        this.#enterReadOnly(
          focusItemId,
          { ...activity, config: exact.config },
          exact.config,
        );
        this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
        return { kind: "render" };
      }
      this.#rebuildRegistry();
      this.#restoreFocus(focusItemId);
      this.#notice = Object.freeze({ kind: "error", message: CONFLICT_NOTICE });
      return { kind: "render" };
    }

    publication.publish();
    let runtime: SettingsControllerSnapshot;
    try {
      runtime = await this.#dependencies.snapshots.read();
    } catch {
      this.#enterReadOnly(
        focusItemId,
        { ...activity, config: validated },
        validated,
      );
      this.#notice = Object.freeze({ kind: "success", message: SAVED_REFRESH_NOTICE });
      return { kind: "render" };
    }
    if (!sameConfig(runtime.config, exact.config)) {
      this.#enterReadOnly(
        focusItemId,
        { ...runtime, config: exact.config },
        exact.config,
      );
      this.#notice = Object.freeze({ kind: "success", message: SAVED_REFRESH_NOTICE });
      return { kind: "render" };
    }
    this.#snapshot = freezeClone(runtime);
    this.#configEditState = { kind: "editable", snapshot: exact };
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
    this.#notice = Object.freeze({ kind: "success", message: "Gespeichert" });
    return { kind: "render" };
  }

  #activate(): SettingsControllerEffect {
    const item = this.#selectedItem();
    if (!item || item.editor.kind === "readonly") return { kind: "render" };
    if (item.disabledReason) {
      this.#notice = Object.freeze({ kind: "info", message: oneLine(item.disabledReason) });
      return { kind: "render" };
    }
    if (this.#configEditState.kind !== "editable") return { kind: "render" };
    const request = freezeRequest({
      generation: ++this.#generation,
      categoryId: item.categoryId,
      itemId: item.id,
      label: item.label,
      description: item.description,
      editor: item.editor,
      initialValue: initialValue(item, this.#configEditState.snapshot.config),
    });
    this.#pending = {
      request,
      item,
      configSnapshot: this.#configEditState.snapshot,
      phase: "editor",
    };
    return { kind: "edit", request };
  }

  async #refresh(focusItemId: SettingsItemId): Promise<boolean> {
    const runtime = await this.#dependencies.snapshots.read();
    this.#snapshot = freezeClone(runtime);
    let editable = false;
    try {
      const exact = await this.#dependencies.readConfig(this.#dependencies.configPath);
      if (sameConfig(runtime.config, exact.config)) {
        this.#configEditState = { kind: "editable", snapshot: exact };
        editable = true;
      } else {
        this.#snapshot = freezeClone({ ...runtime, config: exact.config });
        this.#configEditState = {
          kind: "read-only",
          config: freezeClone(exact.config),
          reason: READ_ONLY_REASON,
        };
      }
    } catch {
      this.#configEditState = {
        kind: "read-only",
        config: freezeClone(runtime.config),
        reason: READ_ONLY_REASON,
      };
    }
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
    return editable;
  }

  async #refreshOrReadOnly(
    focusItemId: SettingsItemId,
    fallbackSnapshot: SettingsControllerSnapshot,
    fallbackConfig: OrcodeConfigWithBudget,
  ): Promise<boolean> {
    try {
      return await this.#refresh(focusItemId);
    } catch {
      this.#enterReadOnly(focusItemId, fallbackSnapshot, fallbackConfig);
      return false;
    }
  }

  #enterReadOnly(
    focusItemId: SettingsItemId,
    snapshot: SettingsControllerSnapshot,
    config: OrcodeConfigWithBudget,
  ): void {
    this.#snapshot = freezeClone({ ...snapshot, config });
    this.#configEditState = {
      kind: "read-only",
      config: freezeClone(config),
      reason: READ_ONLY_REASON,
    };
    this.#rebuildRegistry();
    this.#restoreFocus(focusItemId);
  }

  #restoreFocus(focusItemId: SettingsItemId): void {
    this.#selectedCategoryId = this.#allItems.find(({ id }) => id === focusItemId)?.categoryId
      ?? this.#selectedCategoryId;
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
    const registry = buildSettingsRegistry(this.#snapshot);
    this.#allItems = Object.freeze(registry.items.map((item) => {
      if (this.#configEditState.kind === "editable" || item.editor.kind === "readonly") {
        return item;
      }
      return Object.freeze({ ...item, disabledReason: READ_ONLY_REASON });
    }));
    for (const category of registry.categories) this.#ensureCategoryFocus(category.id);
  }

  #visibleItems(): readonly SettingsItem[] {
    if (this.#searchActive) {
      return searchSettings(
        { categories: [], items: this.#allItems },
        this.#searchQuery,
      );
    }
    return this.#allItems.filter(({ categoryId }) => categoryId === this.#selectedCategoryId);
  }

  #currentItemId(items = this.#visibleItems()): SettingsItemId | null {
    const wanted = this.#searchActive
      ? this.#searchItemId
      : this.#categoryFocus.get(this.#selectedCategoryId) ?? null;
    return wanted && items.some(({ id }) => id === wanted) ? wanted : null;
  }

  #selectedItem(): SettingsItem | null {
    const id = this.#currentItemId();
    return id ? this.#allItems.find((item) => item.id === id) ?? null : null;
  }

  #move(delta: -1 | 1): void {
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

  #selectCategory(categoryId: SettingsCategoryId): void {
    if (!SETTINGS_CATEGORY_IDS.includes(categoryId)) {
      throw new Error("Ungültige Settings-Kategorie.");
    }
    this.#searchActive = false;
    this.#searchQuery = "";
    this.#searchItemId = null;
    this.#selectedCategoryId = categoryId;
    this.#ensureCategoryFocus(categoryId);
  }

  #selectItem(itemId: SettingsItemId): void {
    const item = this.#allItems.find(({ id }) => id === itemId);
    if (!item) return;
    if (this.#searchActive) {
      if (this.#visibleItems().some(({ id }) => id === itemId)) this.#searchItemId = itemId;
      return;
    }
    this.#selectedCategoryId = item.categoryId;
    this.#categoryFocus.set(item.categoryId, itemId);
  }

  #ensureCategoryFocus(categoryId: SettingsCategoryId): void {
    const categoryItems = this.#allItems.filter((item) => item.categoryId === categoryId);
    const current = this.#categoryFocus.get(categoryId);
    if (current && categoryItems.some(({ id }) => id === current)) return;
    const first = this.#firstEnabled(categoryItems) ?? categoryItems[0];
    if (first) this.#categoryFocus.set(categoryId, first.id);
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
    message: "Bestätigung ist ungültig",
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
      if (typeof value !== "string"
        || !descriptor.options.some((option) => option.value === value)) {
        return invalid(value, "Ungültige Auswahl");
      }
      normalized = value;
      break;
    }
    case "number": {
      const parsed = parseNumberValue(value, descriptor.allowOff === true);
      if (parsed.kind === "invalid"
        || (parsed.value !== null
          && (parsed.value < descriptor.minimum || parsed.value > descriptor.maximum))) {
        return invalid(
          parsed.retained,
          `Zahl muss zwischen ${descriptor.minimum} und ${descriptor.maximum} liegen`,
        );
      }
      if (parsed.value !== null
        && integerAction(descriptor.actionId)
        && !Number.isInteger(parsed.value)) {
        return invalid(parsed.retained, "Nur ganze Zahlen sind zulässig");
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
      if (value !== true) return invalid(value, "Bestätigung ist ungültig");
      normalized = true;
      break;
    case "invoke":
      if (value === false) return { kind: "cancel" };
      if (value !== true) return invalid(value, "Aktion ist ungültig");
      normalized = true;
      break;
    case "model": {
      const parsed = parseModelValue(value, descriptor.multiple === true);
      if (parsed.kind === "invalid") return invalid(parsed.retained, "Modellauswahl ist ungültig");
      normalized = parsed.value;
      break;
    }
    default:
      return assertNever(descriptor);
  }

  return actionForItem(item, normalized, snapshot);
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
      if (typeof value !== "string") return invalid(value, "Modellauswahl ist ungültig");
      const model = findModel(snapshot, value);
      if (!model) return invalid(value, "Modellauswahl ist nicht mehr verfügbar");
      return {
        kind: "external",
        action: {
          kind: "main-model",
          requestedModelId: model.id,
          canonicalModelId: model.canonicalSlug ?? model.id,
        },
      };
    }
    case "reasoning": {
      if (typeof value !== "string") return invalid(value, "Reasoning-Auswahl ist ungültig");
      const parsed = parseReasoning(value);
      return parsed
        ? { kind: "config", action: { kind: "reasoning", value: parsed } }
        : invalid(value, "Reasoning-Auswahl ist ungültig");
    }
    case "compression-mode":
      return stringIn(value, ["off", "auto", "always"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Kompressionsmodus ist ungültig");
    case "compressor-model":
      return modelAction(snapshot, value, "compressor-model");
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
        : invalid(value, "Provider-Sortierung ist ungültig");
    case "provider-data-collection":
      return stringIn(value, ["allow", "deny"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Datenschutz-Auswahl ist ungültig");
    case "provider-only":
    case "provider-ignore":
      return isStringArray(value)
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Providerliste ist ungültig");
    case "provider-fallback":
      return onOffAction(value, actionId);
    case "approval-mode":
      if (!stringIn(value, ["read-only", "ask", "auto-edit", "allow-all"])) {
        return invalid(value, "Freigabemodus ist ungültig");
      }
      return value === "allow-all"
        ? { kind: "allow-all-confirm" }
        : { kind: "config", action: { kind: actionId, value } };
    case "approval-forget": {
      const ruleId = dynamicSuffix(item.id, "approval-forget:");
      return ruleId
        ? { kind: "external", action: { kind: "approval-forget", ruleId } }
        : invalid(value, "Regel ist ungültig");
    }
    case "approval-forget-all":
      return { kind: "external", action: { kind: "approval-forget-all" } };
    case "max-cost":
    case "compressor-max-cost":
      return finiteNumberAction(actionId, value);
    case "budget-daily":
    case "budget-total":
      return nullableNumberAction(actionId, value);
    case "budget-on-exceed":
      return stringIn(value, ["warn", "block"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Budgetaktion ist ungültig");
    case "verify-mode":
      return stringIn(value, ["off", "on-edit"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Prüfmodus ist ungültig");
    case "verify-commands":
      return isStringArray(value)
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Prüfkommandos sind ungültig");
    case "verify-suggest":
      return { kind: "external", action: { kind: "verify-suggest" } };
    case "verify-clear":
      return { kind: "config", action: { kind: "verify-clear" } };
    case "verify-repair-rounds":
      return finiteNumberAction(actionId, value);
    case "web-mode":
      return stringIn(value, ["on", "off", "auto"])
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Webmodus ist ungültig");
    case "browser-path":
      return typeof value === "string"
        ? { kind: "config", action: { kind: actionId, value } }
        : invalid(value, "Browserpfad ist ungültig");
    case "browser-timeout":
      return finiteNumberAction(actionId, value);
    case "panel-models": {
      if (!isStringArray(value)) return invalid(value, "Panel-Auswahl ist ungültig");
      try {
        const modelIds = validatePanelModelSelection(
          value,
          snapshot.cachedModels.flatMap((model) => [model.id, model.canonicalSlug].filter(isString)),
        );
        return { kind: "external", action: { kind: "panel-models", modelIds } };
      } catch {
        return invalid(value, "Panel-Auswahl ist ungültig");
      }
    }
    case "panel-judge":
      return onOffAction(value, actionId);
    case "transcription-model": {
      if (typeof value !== "string") return invalid(value, "Audiomodell ist ungültig");
      const model = findModel(snapshot, value);
      if (!model || !model.inputModalities.includes("audio")) {
        return invalid(value, "Audiomodell ist nicht verfügbar");
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
        : invalid(value, "Zeichenmodus ist ungültig");
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
      candidate.reasoningByModel[candidate.mainModel] = structuredClone(action.value);
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
      return sameValue(config.reasoningByModel[config.mainModel], action.value);
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

function initialValue(
  item: SettingsItem,
  config: OrcodeConfigWithBudget,
): SettingsEditorValue | undefined {
  if (item.editor.kind === "readonly") return undefined;
  switch (item.editor.actionId) {
    case "main-model":
      return config.mainModel;
    case "reasoning":
      return reasoningChoiceValue(getReasoningSetting(config));
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
    case "provider-setup":
    case "provider-connect":
    case "provider-enable":
    case "provider-disable":
    case "provider-disconnect":
    case "provider-reconnect":
    case "provider-models":
    case "provider-logout":
    case "verify-suggest":
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
      return { kind: "invalid", retained: sanitizeEditorValue(value), message: "Pfad ist ungültig" };
    }
    const retained = sanitizeEditorString(value, 4_096).trim();
    if (hasDisallowedControls(value, false) || [...value].length > 4_096) {
      return { kind: "invalid", retained, message: "Pfad ist ungültig" };
    }
    return { kind: "value", value: retained };
  }

  const rawValues = typeof value === "string"
    ? value.split(kind === "command-list" ? /[\r\n]+/ : /[,\r\n]+/)
    : isStringArray(value)
      ? [...value]
      : null;
  if (!rawValues) {
    return { kind: "invalid", retained: sanitizeEditorValue(value), message: "Liste ist ungültig" };
  }
  const retained = rawValues.map((entry) => sanitizeEditorString(entry, 512).trim());
  if (rawValues.some((entry) => hasDisallowedControls(entry, false))
    || rawValues.length > 20
    || rawValues.some((entry) => [...entry].length > 512)) {
    return { kind: "invalid", retained, message: "Liste ist ungültig" };
  }
  const normalized = retained.filter(Boolean);
  if (kind === "command-list" && normalized.length === 0) {
    return { kind: "invalid", retained, message: "Mindestens ein Prüfkommando ist erforderlich" };
  }
  return { kind: "value", value: normalized };
}

function parseModelValue(
  value: SettingsEditorValue,
  multiple: boolean,
):
  | { readonly kind: "value"; readonly value: string | readonly string[] }
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

function modelAction(
  snapshot: SettingsControllerSnapshot,
  value: SettingsEditorValue | number | null,
  kind: "compressor-model",
): InterpretedEditorResult {
  if (typeof value !== "string") return invalid(value, "Modellauswahl ist ungültig");
  const model = findModel(snapshot, value);
  return model
    ? { kind: "external", action: { kind, modelId: model.id } }
    : invalid(value, "Modellauswahl ist nicht mehr verfügbar");
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
  if (!match) return invalid(true, "Provideraktion ist ungültig");
  const backendId = match[1] as "openrouter" | "kimi-code" | "anthropic";
  const operation = match[2] as ProviderBackendAction;
  if (`provider-${operation}` !== actionId) {
    return invalid(true, "Provideraktion ist ungültig");
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
    return invalid(value, "Zahl ist ungültig");
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
    return invalid(value, "Zahl ist ungültig");
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
  if (value !== "on" && value !== "off") return invalid(value, "An/Aus-Auswahl ist ungültig");
  return {
    kind: "config",
    action: { kind, value: value === "on" } as SettingsConfigAction,
  };
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
  return "off";
}

function sanitizeEditorString(value: string, limit: number): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, limit).join("");
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

function oneLine(value: string): string {
  return [...value.replace(/[\r\n\p{Cc}\p{Cf}]/gu, " ")].slice(0, 160).join("");
}

function sameConfig(left: OrcodeConfigWithBudget, right: OrcodeConfigWithBudget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeRequest(request: SettingsEditorRequest): SettingsEditorRequest {
  return freezeClone(request);
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
  throw new Error(`Nicht erreichbarer Settings-Wert: ${String(value)}`);
}
