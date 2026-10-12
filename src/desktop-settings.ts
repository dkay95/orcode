import { randomUUID } from "node:crypto";
import type {
  DesktopSettingsCategory,
  DesktopSettingsCategoryId,
  DesktopSettingsIntent,
  DesktopSettingsNoticePresentation,
  DesktopSettingsRow,
  DesktopSettingsView,
} from "./desktop-contracts.js";
import {
  DESKTOP_SETTINGS_NOTICE_COPY,
  DesktopSettingsProjectionError,
  mapSettingsDisabledReason,
  projectGermanSettingsRow,
} from "./desktop-german-copy.js";
import type {
  SettingsDesktopOperationResult,
  SettingsDesktopOperationStart,
  SettingsDesktopOperationToken,
  SettingsDesktopProjectionCapture,
  SettingsDesktopProjectionItem,
  SettingsEditorRequest,
  SettingsEditorResult,
} from "./settings-controller.js";
import type { SettingsItemId } from "./settings-registry.js";

const AREA_ORDER = ["model", "accounts", "security", "more"] as const;
const AREA_COPY = Object.freeze({
  model: ["Modell", "Modelle, Denken, Zusammenfassung und Cross"],
  accounts: ["Konten", "Anbieter verbinden und Konten verwalten"],
  security: ["Sicherheit", "Freigaben und Datenschutz verwalten"],
  more: ["Mehr", "Kosten, Werkzeuge und Darstellung"],
} satisfies Record<DesktopSettingsCategoryId, readonly [string, string]>);

export class DesktopSettingsDispatchError extends Error {
  constructor(message: string) { super(message); }
}

interface HandleBinding { readonly itemId: SettingsItemId; readonly revision: number; }
export type DesktopSettingsNavigation = Readonly<{
  kind: "model" | "provider";
  /** Internal semantic focus identity, never sent over the public GUI wire. */
  focusItemId?: SettingsItemId;
  /** Exact provider deep link for safe, non-destructive account actions. */
  providerId?: "openrouter" | "kimi-code";
}>;
export interface DesktopSettingsEditorPort { edit(request: SettingsEditorRequest): Promise<SettingsEditorResult>; }
export interface DesktopSettingsCorePort {
  captureDesktopProjection(): SettingsDesktopProjectionCapture;
  beginDesktopOperation(itemId: SettingsItemId): Promise<SettingsDesktopOperationStart>;
  advanceDesktopOperation(
    token: SettingsDesktopOperationToken,
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsDesktopOperationResult>;
  abortDesktopOperation(
    token: SettingsDesktopOperationToken,
    request: SettingsEditorRequest,
  ): Promise<SettingsDesktopOperationResult>;
}

interface DesktopSettingsState {
  readonly revision: number;
  readonly selected: DesktopSettingsCategoryId;
  readonly query: string;
  readonly advanced: readonly DesktopSettingsCategoryId[];
  readonly handles: ReadonlyMap<string, HandleBinding>;
  readonly rowsByItem: ReadonlyMap<SettingsItemId, DesktopSettingsRow>;
  readonly view: DesktopSettingsView;
}

interface DesktopSettingsLocalState {
  readonly selected: DesktopSettingsCategoryId;
  readonly query: string;
  readonly advanced: readonly DesktopSettingsCategoryId[];
}

export class DesktopSettingsController {
  readonly #controller: DesktopSettingsCorePort;
  readonly #editor: DesktopSettingsEditorPort | null;
  readonly #namespace = randomUUID();
  readonly #focusKeys = new Map<SettingsItemId, string>();
  #state: DesktopSettingsState;
  #tail: Promise<void> = Promise.resolve();

  constructor(controller: DesktopSettingsCorePort, editor: DesktopSettingsEditorPort | null = null) {
    this.#controller = controller;
    this.#editor = editor;
    this.#state = this.#buildState(1, {
      selected: "model",
      query: "",
      advanced: Object.freeze([]),
    });
  }

  get view(): DesktopSettingsView { return this.#state.view; }

  /** Resolve a display-only focus target without exposing its item binding. */
  focusKeyForNavigation(navigation: DesktopSettingsNavigation): string | null {
    const itemId = navigation.focusItemId
      ?? (navigation.kind === "model" ? "main-model" : "provider-setup");
    return this.#state.rowsByItem.get(itemId)?.focusKey ?? null;
  }

  /**
   * Resolve the two shared picker rows while their opaque binding is still
   * private to this controller. Item ids and navigation hints never enter the
   * public Settings DTO.
   */
  navigationFor(intent: DesktopSettingsIntent): DesktopSettingsNavigation | null {
    if (intent.kind !== "activate-row") return null;
    if (intent.revision !== this.#state.revision) {
      throw new DesktopSettingsDispatchError("Diese Ansicht ist veraltet.");
    }
    const binding = this.#binding(intent.handle);
    const row = this.#state.rowsByItem.get(binding.itemId);
    if (!row) throw new DesktopSettingsDispatchError("Diese Einstellung ist nicht verfügbar.");
    if (row.control === "locked" || row.disabled) {
      throw new DesktopSettingsDispatchError("Diese Einstellung ist gesperrt.");
    }
    if (binding.itemId === "main-model") return { kind: "model" };
    if (binding.itemId === "provider-setup") return { kind: "provider" };
    const providerAction = /^provider-action:(openrouter|kimi-code):(connect|reconnect|models)$/.exec(binding.itemId);
    if (providerAction) {
      return {
        kind: "provider",
        focusItemId: binding.itemId,
        providerId: providerAction[1] as "openrouter" | "kimi-code",
      };
    }
    return null;
  }

  dispatch(intent: DesktopSettingsIntent): Promise<DesktopSettingsView> {
    const result = this.#tail.then(() => this.#dispatchSerial(intent)).catch((error: unknown) => {
      if (error instanceof DesktopSettingsDispatchError) throw error;
      throw new DesktopSettingsDispatchError("Die Einstellung konnte nicht sicher geändert werden.");
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #dispatchSerial(intent: DesktopSettingsIntent): Promise<DesktopSettingsView> {
    const previous = this.#state;
    if (intent.revision !== previous.revision) throw new DesktopSettingsDispatchError("Diese Ansicht ist veraltet.");
    let selected = previous.selected;
    let query = previous.query;
    const advanced = new Set(previous.advanced);
    let coreSettled = false;
    let settledCapture: SettingsDesktopProjectionCapture | null = null;
    switch (intent.kind) {
      case "select-category":
        if (!AREA_ORDER.includes(intent.categoryId)) throw new DesktopSettingsDispatchError("Bereich ist nicht verfügbar.");
        selected = intent.categoryId;
        break;
      case "search-change":
        if ([...intent.query].length > 120) throw new DesktopSettingsDispatchError("Die Suche ist zu lang.");
        query = sanitizeSearch(intent.query);
        break;
      case "toggle-advanced":
        if (!AREA_ORDER.includes(intent.categoryId)) throw new DesktopSettingsDispatchError("Bereich ist nicht verfügbar.");
        if (advanced.has(intent.categoryId)) advanced.delete(intent.categoryId);
        else advanced.add(intent.categoryId);
        selected = intent.categoryId;
        break;
      case "activate-row": {
        const binding = this.#binding(intent.handle);
        const begun = await this.#activate(binding.itemId);
        settledCapture = await this.#pumpEditors(binding.itemId, begun);
        coreSettled = true;
        break;
      }
      case "set-boolean": {
        const binding = this.#binding(intent.handle);
        const row = previous.rowsByItem.get(binding.itemId);
        if (!row || row.control !== "boolean") throw new DesktopSettingsDispatchError("Diese Einstellung ist kein Schalter.");
        const begun = await this.#activate(binding.itemId);
        if (begun.result.kind !== "edit") throw new DesktopSettingsDispatchError("Diese Einstellung kann nicht geändert werden.");
        const request = begun.result.request;
        const completed = await this.#controller.advanceDesktopOperation(
          begun.token,
          request,
          { kind: "value", value: intent.value ? "on" : "off" },
        );
        if (completed.kind === "edit") {
          await this.#controller.abortDesktopOperation(begun.token, completed.request);
          throw new DesktopSettingsDispatchError("Diese Einstellung konnte nicht sicher geändert werden.");
        }
        settledCapture = completed.capture;
        coreSettled = true;
        break;
      }
      case "back":
        if (query) query = "";
        else if (advanced.has(selected)) advanced.delete(selected);
        else throw new DesktopSettingsDispatchError("Hier gibt es nichts zurückzunehmen.");
        break;
      default:
        throw new DesktopSettingsDispatchError("Unbekannte Einstellungsaktion.");
    }
    const nextRevision = previous.revision + 1;
    const local = Object.freeze({
      selected,
      query,
      advanced: Object.freeze(AREA_ORDER.filter((id) => advanced.has(id))),
    });
    if (coreSettled && !settledCapture) {
      this.#state = this.#buildDiagnosticState(nextRevision, selected);
      return this.#state.view;
    }
    try {
      const next = this.#buildState(nextRevision, local, settledCapture ?? undefined);
      this.#state = next;
    } catch (error) {
      if (!coreSettled) throw error;
      this.#state = this.#buildDiagnosticState(nextRevision, selected);
    }
    return this.#state.view;
  }

  async #activate(itemId: SettingsItemId): Promise<SettingsDesktopOperationStart> {
    const row = this.#state.rowsByItem.get(itemId);
    if (!row) throw new DesktopSettingsDispatchError("Diese Einstellung ist nicht verfügbar.");
    if (row.control === "locked") throw new DesktopSettingsDispatchError("Diese Einstellung ist gesperrt.");
    try {
      return await this.#controller.beginDesktopOperation(itemId);
    } catch {
      throw new DesktopSettingsDispatchError("Eine andere Eingabe ist noch offen und wurde nicht geändert.");
    }
  }

  async #pumpEditors(_itemId: SettingsItemId, begun: SettingsDesktopOperationStart): Promise<SettingsDesktopProjectionCapture | null> {
    let result = begun.result;
    while (result.kind === "edit") {
      const request = result.request;
      if (!this.#editor) {
        await this.#controller.abortDesktopOperation(begun.token, request);
        throw new DesktopSettingsDispatchError("Für diese Einstellung ist eine Eingabe erforderlich.");
      }
      let editorResult: SettingsEditorResult;
      try {
        editorResult = await this.#editor.edit(request);
      } catch {
        await this.#controller.abortDesktopOperation(begun.token, request);
        throw new DesktopSettingsDispatchError("Die Eingabe konnte nicht sicher abgeschlossen werden.");
      }
      try {
        result = await this.#controller.advanceDesktopOperation(begun.token, request, editorResult);
      } catch {
        throw new DesktopSettingsDispatchError("Die Einstellung konnte nicht sicher geändert werden.");
      }
    }
    return result.capture;
  }

  #binding(handle: string): HandleBinding {
    const binding = this.#state.handles.get(handle);
    if (!binding || binding.revision !== this.#state.revision) throw new DesktopSettingsDispatchError("Diese Einstellung ist nicht verfügbar.");
    return binding;
  }

  #buildDiagnosticState(revision: number, selected: DesktopSettingsCategoryId): DesktopSettingsState {
    const categories = AREA_ORDER.map((id) => Object.freeze({
      id, label: AREA_COPY[id][0], description: AREA_COPY[id][1], expanded: false,
      commonItems: Object.freeze([]), advancedItems: Object.freeze([]),
    }));
    const view = Object.freeze({
      revision, categories: Object.freeze(categories), selectedCategoryId: selected,
      search: Object.freeze({ active: false, query: "", results: Object.freeze([]) }),
      notice: DESKTOP_SETTINGS_NOTICE_COPY.failed,
    });
    return Object.freeze({
      revision,
      selected,
      query: "",
      advanced: Object.freeze([]),
      handles: new Map(),
      rowsByItem: new Map(),
      view,
    });
  }

  #buildState(
    nextRevision: number,
    local: DesktopSettingsLocalState,
    captured?: SettingsDesktopProjectionCapture,
  ): DesktopSettingsState {
    const capture = captured ?? this.#controller.captureDesktopProjection();
    const handles = new Map<string, HandleBinding>();
    const rowsByItem = new Map<SettingsItemId, DesktopSettingsRow>();
    const grouped = new Map<DesktopSettingsCategoryId, Array<{ item: SettingsDesktopProjectionItem; row: DesktopSettingsRow }>>(
      AREA_ORDER.map((id) => [id, []]),
    );
    let index = 0;
    for (const item of capture.items) {
      const area = areaFor(item);
      const handle = `ds_${this.#namespace}_${nextRevision}_${index++}`;
      let focusKey = this.#focusKeys.get(item.id);
      if (!focusKey) {
        focusKey = `dsf_${this.#namespace}_${this.#focusKeys.size}`;
        this.#focusKeys.set(item.id, focusKey);
      }
      const truth = capture.rowTruth[item.id];
      if (!truth) throw new DesktopSettingsProjectionError();
      let row = Object.freeze({ ...projectGermanSettingsRow(item, handle, truth), focusKey });
      if (capture.readOnlyReason && row.control !== "readonly") {
        row = Object.freeze({ ...row, control: "locked", disabled: mapSettingsDisabledReason(capture.readOnlyReason) });
      }
      handles.set(handle, { itemId: item.id, revision: nextRevision });
      rowsByItem.set(item.id, row);
      grouped.get(area)!.push({ item, row });
    }
    const categories: DesktopSettingsCategory[] = AREA_ORDER.map((id) => {
      const ordered = promoteAccountRepair(grouped.get(id)!, capture);
      const common = ordered.slice(0, 3).map(({ row }) => row);
      const rest = ordered.slice(3).map(({ row }) => row);
      return Object.freeze({
        id, label: AREA_COPY[id][0], description: AREA_COPY[id][1],
        expanded: local.advanced.includes(id),
        commonItems: Object.freeze(common),
        advancedItems: Object.freeze(rest),
      });
    });
    const query = normalize(local.query);
    const results = query ? [...rowsByItem.values()].filter((row) =>
      normalize(`${row.label} ${row.description} ${row.displayValue}`).includes(query)) : [];
    const view = Object.freeze({
      revision: nextRevision, categories: Object.freeze(categories), selectedCategoryId: local.selected,
      search: Object.freeze({ active: query.length > 0, query: local.query, results: Object.freeze(results) }),
      notice: mapNotice(capture.noticeOutcome),
    });
    return Object.freeze({
      revision: nextRevision,
      selected: local.selected,
      query: local.query,
      advanced: Object.freeze([...local.advanced]),
      handles,
      rowsByItem,
      view,
    });
  }
}

function areaFor(item: SettingsDesktopProjectionItem): DesktopSettingsCategoryId {
  if (item.categoryId === "models") return "model";
  if (item.categoryId === "accounts" && !["provider-data-collection", "provider-only", "provider-ignore"].includes(item.id)) return "accounts";
  if (item.categoryId === "approvals-costs" && (item.id.startsWith("approval-") || ["provider-data-collection", "provider-only", "provider-ignore"].includes(item.id))) return "security";
  if (item.categoryId === "approvals-costs" || item.categoryId === "tools" || item.categoryId === "appearance") return "more";
  throw new DesktopSettingsProjectionError();
}

function promoteAccountRepair(
  rows: Array<{ item: SettingsDesktopProjectionItem; row: DesktopSettingsRow }>,
  capture: SettingsDesktopProjectionCapture,
) {
  const knownDegraded = new Set([
    "login-required", "auth-rejected", "credential-expired", "offline", "limit-reached",
    "runtime-missing", "incompatible-runtime", "policy-unavailable",
  ]);
  const degraded = Object.values(capture.rowTruth)
    .filter((truth) => truth.kind === "provider-status")
    .map((truth) => truth.provider)
    .find(({ configuration, headline }) => configuration === "enabled" && headline !== null && knownDegraded.has(headline));
  const repair = degraded?.allowedActions.includes("reconnect") ? "reconnect"
    : degraded?.allowedActions.includes("connect") ? "connect" : null;
  const promoted = degraded && repair
    ? rows.findIndex(({ item }) => item.id === `provider-action:${degraded.backendId}:${repair}`) : -1;
  const status = promoted < 0 && degraded
    ? rows.findIndex(({ item }) => item.id === `provider-status:${degraded.backendId}`) : promoted;
  return status > 2 ? [rows[status]!, ...rows.slice(0, status), ...rows.slice(status + 1)] : rows;
}

function mapNotice(outcome: SettingsDesktopProjectionCapture["noticeOutcome"]): DesktopSettingsNoticePresentation | null {
  switch (outcome) {
    case null:
      return null;
    case "saved":
    case "cancelled":
    case "stale":
    case "failed":
      return DESKTOP_SETTINGS_NOTICE_COPY[outcome];
    default:
      throw new DesktopSettingsProjectionError();
  }
}

function sanitizeSearch(value: string): string { return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 120).join(""); }
function normalize(value: string): string { return value.normalize("NFKD").toLocaleLowerCase("de").replace(/\p{M}/gu, "").trim(); }
