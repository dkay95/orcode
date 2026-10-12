import type {
  DesktopActivityMessageCode,
  DesktopActivityMessagePresentation,
  DesktopCommandDisabledPresentation,
  DesktopCommandDisabledReasonCode,
  DesktopDisabledPresentation,
  DesktopDisabledReasonCode,
  DesktopSettingsDisabledPresentation,
  DesktopSettingsDisabledReasonCode,
  DesktopSettingsEditorDecision,
  DesktopSettingsEditorPresentation,
  DesktopSettingsNoticeCode,
  DesktopSettingsNoticePresentation,
  DesktopSettingsRow,
} from "./desktop-contracts.js";
import type {
  SettingsDesktopEditorSchema,
  SettingsDesktopProjectionItem,
  SettingsDesktopRowTruth,
  SettingsEditorRequest,
  SettingsEditorResult,
} from "./settings-controller.js";
import type { SettingsActionId, SettingsCategoryId, SettingsItem } from "./settings-registry.js";

type GermanSettingsItem = SettingsItem | SettingsDesktopProjectionItem;

export class DesktopSettingsProjectionError extends Error {
  readonly code = "desktop-settings-projection-unavailable" as const;
  readonly activity = Object.freeze({ code: "diagnostic-available" as const, label: "Diagnose verfügbar" });
  constructor() { super("Diese Einstellung kann nicht sicher angezeigt werden."); }
}

const disabled = <T extends string>(code: T, label: string, recoveryLabel?: string) =>
  Object.freeze({ code, label, ...(recoveryLabel ? { recoveryLabel } : {}) });
const commandDisabled = <T extends string>(code: T, label: string, recoveryLabel: string) =>
  Object.freeze({ code, label, recoveryLabel });

export const DESKTOP_DISABLED_COPY = Object.freeze({
  "provider-not-connected": disabled("provider-not-connected", "Anbieter ist nicht verbunden.", "Konto verbinden"),
  "provider-connecting": disabled("provider-connecting", "Verbindung wird hergestellt.", "Kurz warten"),
  "provider-degraded": disabled("provider-degraded", "Anbieterverbindung ist eingeschränkt.", "Verbindung reparieren"),
  "provider-disabled": disabled("provider-disabled", "Anbieter ist deaktiviert.", "Anbieter aktivieren"),
  "provider-blocked": disabled("provider-blocked", "Anbieter ist blockiert.", "Kontostatus prüfen"),
  "setup-method-unavailable": disabled("setup-method-unavailable", "Einrichtung ist hier nicht verfügbar.", "Lokales Terminal öffnen"),
  "model-not-runnable": disabled("model-not-runnable", "Modell ist nicht ausführbar.", "Anderes Modell wählen"),
  "native-local-action-unavailable": disabled("native-local-action-unavailable", "Aktion ist nur lokal verfügbar.", "Lokales Eigentümer-Terminal öffnen"),
  "codex-runtime-unavailable": disabled("codex-runtime-unavailable", "Codex-Laufzeit ist nicht verfügbar.", "Codex prüfen"),
  "codex-profile-isolation-unproven": disabled("codex-profile-isolation-unproven", "Profiltrennung ist nicht bestätigt.", "Anmeldung erneut prüfen"),
  "account-authentication-required": disabled("account-authentication-required", "Anmeldung ist erforderlich.", "Erneut anmelden"),
  "account-limit-reached": disabled("account-limit-reached", "Kontolimit ist erreicht.", "Kontolimit prüfen"),
  "route-stale": disabled("route-stale", "Modellauswahl ist veraltet.", "Liste neu laden"),
  "route-activation-failed": disabled("route-activation-failed", "Modellroute konnte nicht aktiviert werden.", "Erneut versuchen"),
  "cross-routes-must-differ": disabled("cross-routes-must-differ", "Cross-Modelle müssen verschieden sein.", "Anderes Modell wählen"),
  "cross-selection-incomplete": disabled("cross-selection-incomplete", "Cross-Auswahl ist unvollständig.", "Beide Modelle wählen"),
  "update-required": disabled("update-required", "Aktualisierung ist erforderlich.", "orcode aktualisieren"),
} satisfies Record<DesktopDisabledReasonCode, DesktopDisabledPresentation>);

export const DESKTOP_COMMAND_DISABLED_COPY = Object.freeze({
  "run-active": commandDisabled("run-active", "Ein Lauf ist aktiv.", "Lauf zuerst beenden"),
  "cross-run-active": commandDisabled("cross-run-active", "Cross läuft gerade.", "Cross zuerst beenden"),
  "question-pending": commandDisabled("question-pending", "Eine Rückfrage ist offen.", "Rückfrage beantworten"),
  "command-in-flight": commandDisabled("command-in-flight", "Ein Befehl wird ausgeführt.", "Abschluss abwarten"),
  "settings-open": commandDisabled("settings-open", "Einstellungen sind geöffnet.", "Einstellungen schließen"),
  "no-run": commandDisabled("no-run", "Kein Lauf ist aktiv.", "Einen Lauf starten"),
  "terminal-only-picker": commandDisabled("terminal-only-picker", "Auswahl ist nur im Terminal verfügbar.", "Lokales Terminal öffnen"),
  "route-stale": commandDisabled("route-stale", "Modellauswahl ist veraltet.", "Modelle neu laden"),
  "provider-unavailable": commandDisabled("provider-unavailable", "Anbieter ist nicht verfügbar.", "Anbieter prüfen"),
} satisfies Record<DesktopCommandDisabledReasonCode, DesktopCommandDisabledPresentation>);

export const DESKTOP_SETTINGS_DISABLED_COPY = Object.freeze({
  "run-active": disabled("run-active", "Während eines Laufs gesperrt.", "Lauf zuerst beenden"),
  "cross-run-active": disabled("cross-run-active", "Während Cross gesperrt.", "Cross zuerst beenden"),
  "cross-unavailable": disabled("cross-unavailable", "Cross ist nicht verfügbar.", "Cross-Konfiguration prüfen"),
  "cross-role-unset": disabled("cross-role-unset", "Cross-Modell fehlt.", "Modell wählen"),
  "cross-swap-incomplete": disabled("cross-swap-incomplete", "Beide Cross-Modelle werden benötigt.", "Beide Modelle wählen"),
  "cross-routes-must-differ": disabled("cross-routes-must-differ", "Cross-Modelle müssen verschieden sein.", "Anderes Modell wählen"),
  "external-model-role-unsupported": disabled("external-model-role-unsupported", "Dieses Konto unterstützt die Modellrolle nicht.", "OpenRouter-Modell wählen"),
  "architect-unavailable": disabled("architect-unavailable", "Architect ist für diese Route nicht verfügbar.", "Kompatible Route wählen"),
  "no-remembered-rules": disabled("no-remembered-rules", "Keine gemerkten Regeln vorhanden."),
  "no-verify-commands": disabled("no-verify-commands", "Keine Prüf-Befehle vorhanden."),
  "voice-consent-required": disabled("voice-consent-required", "Keine Sprachfreigabe gespeichert.", "Sprachfunktion erneut öffnen"),
  "model-catalog-unavailable": disabled("model-catalog-unavailable", "Modellkatalog ist nicht verfügbar.", "Modelle neu laden"),
  "model-reasoning-unsupported": disabled("model-reasoning-unsupported", "Modell unterstützt diesen Denkmodus nicht.", "Anderen Modus wählen"),
  "provider-not-connected": disabled("provider-not-connected", "Anbieter ist nicht verbunden.", "Konto verbinden"),
  "provider-degraded": disabled("provider-degraded", "Anbieterverbindung ist eingeschränkt.", "Verbindung reparieren"),
  "config-changed-restart": disabled("config-changed-restart", "Konfiguration wurde außerhalb geändert.", "orcode neu starten"),
  "config-unreadable": disabled("config-unreadable", "Konfiguration kann nicht gelesen werden.", "Datei reparieren und neu starten"),
  "restart-required": disabled("restart-required", "Neustart ist erforderlich.", "orcode neu starten"),
  "setting-locked": disabled("setting-locked", "Einstellung ist gesperrt.", "Sperrgrund beheben"),
} satisfies Record<DesktopSettingsDisabledReasonCode, DesktopSettingsDisabledPresentation>);

export const DESKTOP_ACTIVITY_COPY = Object.freeze({
  "setup-opened": { code: "setup-opened", label: "Einrichtung geöffnet" },
  "setup-cancelled": { code: "setup-cancelled", label: "Einrichtung abgebrochen" },
  "setup-completed": { code: "setup-completed", label: "Einrichtung abgeschlossen" },
  "settings-opened": { code: "settings-opened", label: "Einstellungen geöffnet" },
  "settings-closed": { code: "settings-closed", label: "Einstellungen geschlossen" },
  "engine-restarted": { code: "engine-restarted", label: "Engine neu gestartet" },
  "diagnostic-available": { code: "diagnostic-available", label: "Diagnose verfügbar" },
} satisfies Record<DesktopActivityMessageCode, DesktopActivityMessagePresentation>);

export const DESKTOP_SETTINGS_NOTICE_COPY = Object.freeze({
  saved: { code: "saved", level: "info", label: "Gespeichert" },
  cancelled: { code: "cancelled", level: "info", label: "Abgebrochen" },
  stale: { code: "stale", level: "warning", label: "Ansicht ist veraltet" },
  failed: { code: "failed", level: "error", label: "Änderung fehlgeschlagen" },
} satisfies Record<DesktopSettingsNoticeCode, DesktopSettingsNoticePresentation>);

const ROW_COPY = Object.freeze({
  "main-model": ["Hauptmodell", "Modell und aktive Sitzung gemeinsam wechseln"],
  reasoning: ["Denken · Hauptmodell", "Denkmodus des Hauptmodells festlegen"],
  "compression-mode": ["Lange Chats kürzen", "Automatische Zusammenfassung steuern"],
  "compressor-model": ["Zusammenfassungsmodell", "Modell für lange Chats wählen"],
  "reasoning-compressor": ["Denken · Zusammenfassung", "Denkmodus der Zusammenfassung festlegen"],
  "cross-lead-model": ["Cross · Codemodell", "Schreibendes Cross-Modell wählen"],
  "cross-challenger-model": ["Cross · Prüfmodell", "Prüfendes Cross-Modell wählen"],
  "reasoning-cross-lead": ["Denken · Cross-Code", "Denkmodus des Codemodells festlegen"],
  "reasoning-cross-challenger": ["Denken · Cross-Prüfung", "Denkmodus des Prüfmodells festlegen"],
  "cross-pair-swap": ["Cross-Paar tauschen", "Code- und Prüfrolle vertauschen"],
  "architect-executor-model": ["Architect · Ausführungsmodell", "Modell für angenommene Pläne wählen"],
  "provider-setup": ["Anbieter einrichten", "Geführte Kontoeinrichtung öffnen"],
  "provider-sort": ["OpenRouter-Sortierung", "Anbieter nach Preis, Durchsatz oder Latenz ordnen"],
  "provider-fallback": ["OpenRouter-Ersatzanbieter", "Ersatzanbieter für dasselbe Modell zulassen"],
  "approval-mode": ["Freigabemodus", "Bestimmt, welche Aktionen bestätigt werden müssen"],
  "approval-forget-all": ["Alle Regeln vergessen", "Alle gemerkten Freigaben entfernen"],
  "provider-data-collection": ["OpenRouter-Datenfreigabe", "Anbieter mit Datenfreigabe zulassen oder sperren"],
  "provider-only": ["Nur diese OpenRouter-Anbieter", "Ausführung auf eine Liste begrenzen"],
  "provider-ignore": ["Diese OpenRouter-Anbieter ignorieren", "Anbieter bei der Auswahl überspringen"],
  "max-cost": ["Kostenlimit pro Lauf", "Maximale geschätzte Hauptmodellkosten"],
  "max-steps": ["Aktionen pro Lauf", "Maximale Anzahl der Modellaktionen"],
  "compressor-max-cost": ["Kostenlimit der Zusammenfassung", "Maximale Kosten der Zusammenfassung"],
  "budget-daily": ["Tagesbudget", "Kostenlimit dieses Ordners pro Tag"],
  "budget-total": ["Gesamtbudget", "Gesamtes Kostenlimit dieses Ordners"],
  "budget-on-exceed": ["Bei Budgetüberschreitung", "Warnen oder neue Läufe sperren"],
  "low-balance-threshold": ["Warnung bei niedrigem Guthaben", "Warnschwelle für verbleibendes Guthaben"],
  "cost-summary": ["Aktuelle Kosten", "Kosten dieses Chats, Tages und Ordners"],
  "verify-mode": ["Prüfmodus", "Automatische Prüfungen steuern"],
  "verify-commands": ["Prüf-Befehle", "Geordnete lokale Prüf-Befehle bearbeiten"],
  "verify-suggest": ["Prüf-Befehle vorschlagen", "Passende Projektbefehle ermitteln"],
  "verify-clear": ["Prüf-Befehle löschen", "Alle Prüf-Befehle entfernen"],
  "verify-repair-rounds": ["Wiederholungen nach Fehler", "Anzahl weiterer Versuche festlegen"],
  "web-mode": ["Webmodus", "Webzugriff für Läufe steuern"],
  "browser-path": ["Browserpfad", "Expliziten Browserpfad festlegen"],
  "browser-timeout": ["Browser-Zeitlimit", "Start und Prüfung zeitlich begrenzen"],
  "panel-models": ["Panel-Modelle", "Modelle für parallele Vergleiche wählen"],
  "panel-judge": ["Panel-Auswertung", "Panel-Antworten zusätzlich zusammenführen"],
  "transcription-model": ["Transkriptionsmodell", "Modell für Sprachaufnahmen wählen"],
  "voice-consent-status": ["Sprachfreigabe", "Gespeicherte Upload-Freigabe anzeigen"],
  "voice-consent-clear": ["Sprachfreigabe zurücksetzen", "Gespeicherte Freigabe entfernen"],
  "appearance-large-logo": ["Großes ORCODE-Logo", "Großes Logo auf Startseite und in Einstellungen anzeigen"],
  "appearance-header-mark": ["Kompakte Kopfmarke", "Kompakte ORCODE-Marke im Chatkopf anzeigen"],
  "appearance-glyph-mode": ["Terminalzeichen", "Unicode- oder ASCII-Zeichen festlegen"],
} as const);
export const DESKTOP_SETTINGS_STATIC_ROW_IDS = Object.freeze(Object.keys(ROW_COPY));

type RowSchema = Readonly<{
  categoryId: SettingsCategoryId;
  editorKind: SettingsDesktopEditorSchema["kind"];
  actionId?: SettingsActionId;
  choices?: readonly string[];
  modelFilter?: Extract<SettingsDesktopEditorSchema, { readonly kind: "model" }>["filter"];
  multiple?: boolean;
  valueKind?: Extract<SettingsDesktopEditorSchema, { readonly kind: "text" }>["valueKind"];
  minimum?: number;
  maximum?: number;
  unit?: Extract<SettingsDesktopEditorSchema, { readonly kind: "number" }>["unit"];
  allowOff?: boolean;
}>;

const choice = (
  categoryId: SettingsCategoryId,
  actionId: SettingsActionId,
  choices?: readonly string[],
): RowSchema => Object.freeze({ categoryId, editorKind: "choice", actionId, ...(choices ? { choices: Object.freeze([...choices]) } : {}) });
const model = (
  actionId: SettingsActionId,
  modelFilter: NonNullable<RowSchema["modelFilter"]>,
  multiple = false,
): RowSchema => Object.freeze({ categoryId: "models", editorKind: "model", actionId, modelFilter, multiple });
const simple = (
  categoryId: SettingsCategoryId,
  editorKind: RowSchema["editorKind"],
  actionId?: SettingsActionId,
): RowSchema => Object.freeze({ categoryId, editorKind, ...(actionId ? { actionId } : {}) });
const numeric = (
  categoryId: SettingsCategoryId,
  actionId: SettingsActionId,
  minimum: number,
  maximum: number,
  unit?: Extract<SettingsDesktopEditorSchema, { readonly kind: "number" }>["unit"],
  allowOff = false,
): RowSchema => Object.freeze({
  categoryId, editorKind: "number", actionId, minimum, maximum,
  ...(unit ? { unit } : {}),
  ...(allowOff ? { allowOff: true } : {}),
});

const ON_OFF = Object.freeze(["on", "off"]);
const STATIC_ROW_SCHEMA: Readonly<Record<string, RowSchema>> = Object.freeze({
  "main-model": model("main-model", "main"),
  reasoning: choice("models", "reasoning"),
  "compression-mode": choice("models", "compression-mode", ["off", "auto", "always"]),
  "compressor-model": model("compressor-model", "compressor"),
  "reasoning-compressor": choice("models", "reasoning-compressor"),
  "cross-lead-model": model("cross-lead-model", "cross-lead"),
  "cross-challenger-model": model("cross-challenger-model", "cross-challenger"),
  "reasoning-cross-lead": choice("models", "reasoning-cross-lead"),
  "reasoning-cross-challenger": choice("models", "reasoning-cross-challenger"),
  "cross-pair-swap": simple("models", "invoke", "cross-pair-swap"),
  "architect-executor-model": model("architect-executor-model", "architect-executor"),
  "provider-setup": simple("accounts", "invoke", "provider-setup"),
  "provider-sort": choice("accounts", "provider-sort", ["off", "price", "throughput", "latency"]),
  "provider-fallback": choice("accounts", "provider-fallback", ON_OFF),
  "approval-mode": choice("approvals-costs", "approval-mode", ["read-only", "ask", "auto-edit", "allow-all"]),
  "approval-forget-all": simple("approvals-costs", "confirm", "approval-forget-all"),
  "provider-data-collection": choice("approvals-costs", "provider-data-collection", ["deny", "allow"]),
  "provider-only": Object.freeze({ categoryId: "approvals-costs", editorKind: "text", actionId: "provider-only", valueKind: "provider-list" }),
  "provider-ignore": Object.freeze({ categoryId: "approvals-costs", editorKind: "text", actionId: "provider-ignore", valueKind: "provider-list" }),
  "max-cost": numeric("approvals-costs", "max-cost", 0.001, 1_000, "USD"),
  "max-steps": numeric("approvals-costs", "max-steps", 1, 100),
  "compressor-max-cost": numeric("approvals-costs", "compressor-max-cost", 0.001, 100, "USD"),
  "budget-daily": numeric("approvals-costs", "budget-daily", 0.01, 100_000, "USD", true),
  "budget-total": numeric("approvals-costs", "budget-total", 0.01, 100_000, "USD", true),
  "budget-on-exceed": choice("approvals-costs", "budget-on-exceed", ["warn", "block"]),
  "low-balance-threshold": numeric("approvals-costs", "low-balance-threshold", 0, 1_000, "USD"),
  "cost-summary": simple("approvals-costs", "readonly"),
  "verify-mode": choice("tools", "verify-mode", ["off", "on-edit"]),
  "verify-commands": Object.freeze({ categoryId: "tools", editorKind: "text", actionId: "verify-commands", valueKind: "command-list" }),
  "verify-suggest": simple("tools", "invoke", "verify-suggest"),
  "verify-clear": simple("tools", "confirm", "verify-clear"),
  "verify-repair-rounds": numeric("tools", "verify-repair-rounds", 0, 2),
  "web-mode": choice("tools", "web-mode", ["auto", "on", "off"]),
  "browser-path": Object.freeze({ categoryId: "tools", editorKind: "text", actionId: "browser-path", valueKind: "path" }),
  "browser-timeout": numeric("tools", "browser-timeout", 1, 120, "s"),
  "panel-models": Object.freeze({ categoryId: "tools", editorKind: "model", actionId: "panel-models", modelFilter: "panel", multiple: true }),
  "panel-judge": choice("tools", "panel-judge", ON_OFF),
  "transcription-model": Object.freeze({ categoryId: "tools", editorKind: "model", actionId: "transcription-model", modelFilter: "audio-input", multiple: false }),
  "voice-consent-status": simple("tools", "readonly"),
  "voice-consent-clear": simple("tools", "confirm", "voice-consent-clear"),
  "appearance-large-logo": choice("appearance", "appearance-large-logo", ON_OFF),
  "appearance-header-mark": choice("appearance", "appearance-header-mark", ON_OFF),
  "appearance-glyph-mode": choice("appearance", "appearance-glyph-mode", ["auto", "unicode", "ascii"]),
});

function dynamicCopy(item: GermanSettingsItem): readonly [string, string] | null {
  let match = /^provider-status:(openrouter|kimi-code|anthropic)$/.exec(item.id);
  if (match) return [`Kontostatus · ${providerName(match[1]!)}`, "Verbindung und Kontozustand anzeigen"];
  match = /^provider-action:(openrouter|kimi-code|anthropic):(connect|enable|disable|disconnect|reconnect|models|logout)$/.exec(item.id);
  if (match) {
    if (match[1] === "anthropic" || (match[1] === "kimi-code" && match[2] === "disconnect")) return null;
    return [`${providerName(match[1]!)} · ${actionName(match[2]!)}`, "Kontoverbindung sicher verwalten"];
  }
  match = /^approval-rule:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(item.id);
  if (match) return ["Gemerkte Regel", "Lokal gemerkte Werkzeugfreigabe anzeigen"];
  match = /^approval-forget:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(item.id);
  if (match) return ["Regel vergessen", "Gemerkte Werkzeugfreigabe entfernen"];
  return null;
}

export function projectGermanSettingsRow(
  item: GermanSettingsItem,
  handle: string,
  truth: SettingsDesktopRowTruth,
): DesktopSettingsRow {
  try {
    return projectGermanSettingsRowUnsafe(item, handle, truth);
  } catch (error) {
    if (error instanceof DesktopSettingsProjectionError) throw error;
    throw new DesktopSettingsProjectionError();
  }
}

export interface ProjectedGermanSettingsEditor {
  readonly editor: DesktopSettingsEditorPresentation;
  readonly resolve: (decision: DesktopSettingsEditorDecision) => SettingsEditorResult;
}

/**
 * Turns a private Registry editor request into the complete public dialog.
 * The returned resolver closes over raw option values; only opaque handles
 * ever cross the GUI boundary.
 */
export function projectGermanSettingsEditor(
  request: SettingsEditorRequest,
  namespace: string,
): ProjectedGermanSettingsEditor {
  try {
    return projectGermanSettingsEditorUnsafe(request, namespace);
  } catch (error) {
    if (error instanceof DesktopSettingsProjectionError) throw error;
    throw new DesktopSettingsProjectionError();
  }
}

function projectGermanSettingsEditorUnsafe(
  request: SettingsEditorRequest,
  namespace: string,
): ProjectedGermanSettingsEditor {
  if (!/^[-A-Za-z0-9_]{1,100}$/.test(namespace)) throw new DesktopSettingsProjectionError();
  const copy = editorCopy(request);
  const common = Object.freeze({
    title: copy[0],
    description: editorDescription(request, copy[1]),
    cancelLabel: "Abbrechen",
    busyLabel: "Änderung wird angewendet …",
    ...(request.validationMessage
      ? { notice: Object.freeze({ level: "error" as const, label: editorValidationLabel(request.editor.kind) }) }
      : {}),
  });

  switch (request.editor.kind) {
    case "choice": {
      const bindings = new Map<string, string>();
      const options = request.editor.options.map((option, index) => {
        const handle = `dse_${namespace}_${index}`;
        bindings.set(handle, option.value);
        return Object.freeze({
          handle,
          label: editorChoiceLabel(request.itemId, option.value),
          selected: request.initialValue === option.value,
        });
      });
      const editor = Object.freeze({ ...common, kind: "choice" as const, options: Object.freeze(options) });
      return Object.freeze({
        editor,
        resolve: (decision: DesktopSettingsEditorDecision): SettingsEditorResult => {
          if (decision.kind !== "choice") return { kind: "cancel" };
          const value = bindings.get(decision.optionHandle);
          return value === undefined ? { kind: "cancel" } : { kind: "value", value };
        },
      });
    }
    case "number": {
      const unit = request.editor.unit ? ` ${safeEditorUnit(request.editor.unit)}` : "";
      const off = request.editor.allowOff ? " · oder Aus" : "";
      const editor = Object.freeze({
        ...common,
        kind: "number" as const,
        inputLabel: copy[0],
        initialValue: editorInitialValue(request.initialValue),
        constraintLabel: `${plainNumber(request.editor.minimum)} bis ${plainNumber(request.editor.maximum)}${unit}${off}`,
        submitLabel: "Speichern",
      });
      return Object.freeze({
        editor,
        resolve: (decision: DesktopSettingsEditorDecision): SettingsEditorResult => decision.kind === "number"
          ? { kind: "value", value: decision.value }
          : { kind: "cancel" },
      });
    }
    case "text": {
      const editor = Object.freeze({
        ...common,
        kind: "text" as const,
        inputLabel: editorTextInputLabel(request.editor.valueKind),
        initialValue: editorInitialValue(request.initialValue),
        multiline: request.editor.valueKind !== "path",
        submitLabel: "Speichern",
      });
      return Object.freeze({
        editor,
        resolve: (decision: DesktopSettingsEditorDecision): SettingsEditorResult => decision.kind === "text"
          ? { kind: "value", value: decision.value }
          : { kind: "cancel" },
      });
    }
    case "confirm": {
      const editor = Object.freeze({
        ...common,
        kind: "confirm" as const,
        destructive: request.editor.destructive === true,
        confirmLabel: editorActionLabel(request.itemId, "confirm"),
      });
      return Object.freeze({
        editor,
        resolve: (decision: DesktopSettingsEditorDecision): SettingsEditorResult =>
          decision.kind === "confirm" && decision.accepted
            ? { kind: "value", value: true }
            : { kind: "cancel" },
      });
    }
    case "invoke": {
      const editor = Object.freeze({
        ...common,
        kind: "invoke" as const,
        invokeLabel: editorActionLabel(request.itemId, "invoke"),
      });
      return Object.freeze({
        editor,
        resolve: (decision: DesktopSettingsEditorDecision): SettingsEditorResult => decision.kind === "invoke"
          ? { kind: "value", value: true }
          : { kind: "cancel" },
      });
    }
    case "model":
    case "readonly":
      throw new DesktopSettingsProjectionError();
    default:
      return failProjection();
  }
}

function editorCopy(request: SettingsEditorRequest): readonly [string, string] {
  if (request.editor.kind === "confirm" && request.itemId === "approval-mode") {
    if (request.editor.actionId !== "approval-mode" || request.categoryId !== "approvals-costs") {
      throw new DesktopSettingsProjectionError();
    }
    return ["Alles erlauben aktivieren?", "Dateiänderungen und Befehle laufen dann ohne weitere Nachfrage."];
  }
  const copy = Object.prototype.hasOwnProperty.call(ROW_COPY, request.itemId)
    ? (ROW_COPY as Record<string, readonly [string, string]>)[request.itemId]
    : dynamicCopy({ id: request.itemId } as GermanSettingsItem);
  if (!copy) throw new DesktopSettingsProjectionError();
  const schema = Object.prototype.hasOwnProperty.call(STATIC_ROW_SCHEMA, request.itemId)
    ? STATIC_ROW_SCHEMA[request.itemId]
    : dynamicEditorSchema(request);
  if (!schema || schema.categoryId !== request.categoryId || schema.editorKind !== request.editor.kind) {
    throw new DesktopSettingsProjectionError();
  }
  const actionId = request.editor.kind === "readonly" ? undefined : request.editor.actionId;
  if (actionId !== schema.actionId) throw new DesktopSettingsProjectionError();
  return copy;
}

function dynamicEditorSchema(request: SettingsEditorRequest): RowSchema | null {
  const provider = /^provider-action:(openrouter|kimi-code):(connect|enable|disable|disconnect|reconnect|models|logout)$/.exec(request.itemId);
  if (provider) return simple("accounts", "invoke", `provider-${provider[2]}` as SettingsActionId);
  if (/^approval-forget:[0-9a-f-]{36}$/.test(request.itemId)) {
    return simple("approvals-costs", "confirm", "approval-forget");
  }
  return null;
}

function editorDescription(request: SettingsEditorRequest, fallback: string): string {
  return request.editor.kind === "confirm" && request.itemId === "approval-mode"
    ? "Dateiänderungen und Befehle laufen dann ohne weitere Nachfrage."
    : fallback;
}

function editorChoiceLabel(itemId: string, value: string): string {
  return itemId.startsWith("reasoning") ? reasoningLabel(value) : choiceLabel(value);
}

function editorInitialValue(value: SettingsEditorRequest["initialValue"]): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map(safeTechnicalIdentifier).join("\n");
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Ein" : "Aus";
  throw new DesktopSettingsProjectionError();
}

function editorTextInputLabel(valueKind: string): string {
  return exactLabel(valueKind, {
    path: "Pfad",
    "command-list": "Prüf-Befehle",
    "provider-list": "Anbieter",
  });
}

function safeEditorUnit(unit: string): string {
  return exactLabel(unit, { USD: "USD", s: "s" });
}

function editorValidationLabel(kind: SettingsEditorRequest["editor"]["kind"]): string {
  switch (kind) {
    case "choice": return "Bitte eine verfügbare Auswahl treffen.";
    case "number": return "Bitte einen Wert im angegebenen Bereich eingeben.";
    case "text": return "Bitte einen gültigen Wert eingeben.";
    case "confirm": return "Die Bestätigung konnte nicht übernommen werden.";
    case "invoke": return "Die Aktion konnte nicht ausgeführt werden.";
    case "model": return "Bitte ein verfügbares Modell wählen.";
    case "readonly": return "Diese Einstellung kann hier nicht geändert werden.";
    default: return failProjection();
  }
}

function editorActionLabel(itemId: string, kind: "confirm" | "invoke"): string {
  if (kind === "confirm" && itemId === "approval-mode") return "Bestätigen";
  const labels: Readonly<Record<string, string>> = Object.freeze({
    "approval-forget-all": "Alle Regeln löschen",
    "verify-clear": "Löschen",
    "voice-consent-clear": "Zurücksetzen",
    "cross-pair-swap": "Tauschen",
    "verify-suggest": "Vorschlagen",
    "provider-setup": "Einrichten",
  });
  const direct = labels[itemId];
  if (direct) return direct;
  if (kind === "confirm" && /^approval-forget:[0-9a-f-]{36}$/.test(itemId)) return "Regel löschen";
  const provider = /^provider-action:(?:openrouter|kimi-code):([a-z-]+)$/.exec(itemId);
  if (kind === "invoke" && provider) return actionName(provider[1]!);
  throw new DesktopSettingsProjectionError();
}

function projectGermanSettingsRowUnsafe(
  item: GermanSettingsItem,
  handle: string,
  truth: SettingsDesktopRowTruth,
): DesktopSettingsRow {
  const copy = Object.prototype.hasOwnProperty.call(ROW_COPY, item.id)
    ? (ROW_COPY as Record<string, readonly [string, string]>)[item.id]
    : dynamicCopy(item);
  if (!copy) throw new DesktopSettingsProjectionError();
  validateRowSchema(item, truth);
  const disabledPresentation = item.disabledReason ? mapSettingsDisabledReason(item.disabledReason) : undefined;
  const isBoolean = truth.kind === "boolean";
  const control = disabledPresentation ? "locked" : isBoolean ? "boolean"
    : item.editor.kind === "readonly" ? "readonly"
      : item.editor.kind === "choice" || item.editor.kind === "model" || item.editor.kind === "number" || item.editor.kind === "text"
        ? "choice" : "action";
  return Object.freeze({
    handle,
    label: copy[0],
    description: copy[1],
    displayValue: germanDisplay(truth),
    control,
    ...(isBoolean ? { booleanValue: truth.value } : {}),
    ...(control === "action" ? { actionLabel: germanAction(item, truth) } : {}),
    ...(disabledPresentation ? { disabled: disabledPresentation } : {}),
  });
}

export const DESKTOP_SETTINGS_RAW_DISABLED_REASONS: Readonly<Record<string, DesktopSettingsDisabledReasonCode>> = Object.freeze({
    "Run active": "run-active",
    "Cross is unavailable": "cross-unavailable",
    "Cross is not available in this runtime": "cross-unavailable",
    "Cross is unavailable on Kimi Code routes": "cross-unavailable",
    "No provider is connected — run /provider setup first": "provider-not-connected",
    "Choose a model first": "cross-role-unset",
    "Both roles must be set before swapping": "cross-swap-incomplete",
    "Kimi Code doesn't support this external model role; an OpenRouter route is required": "external-model-role-unsupported",
    "Architect is unavailable on Kimi Code routes": "architect-unavailable",
    "No remembered rules": "no-remembered-rules",
    "No verify commands": "no-verify-commands",
    "No voice consent stored": "voice-consent-required",
    "Model catalog not available": "model-catalog-unavailable",
    "Model doesn't support reasoning": "model-reasoning-unsupported",
    "Another orcode changed the config. Restart to adopt it.": "config-changed-restart",
    "The config could not be read. Fix it, then restart.": "config-unreadable",
    "Restart orcode before changing settings again.": "restart-required",
  });

export function mapSettingsDisabledReason(raw: string): DesktopSettingsDisabledPresentation {
  if (!Object.prototype.hasOwnProperty.call(DESKTOP_SETTINGS_RAW_DISABLED_REASONS, raw)) {
    throw new DesktopSettingsProjectionError();
  }
  const code = DESKTOP_SETTINGS_RAW_DISABLED_REASONS[raw];
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(DESKTOP_SETTINGS_DISABLED_COPY, code)) {
    throw new DesktopSettingsProjectionError();
  }
  const presentation = DESKTOP_SETTINGS_DISABLED_COPY[code];
  if (!presentation) throw new DesktopSettingsProjectionError();
  return presentation;
}

function validateRowSchema(item: GermanSettingsItem, truth: SettingsDesktopRowTruth): void {
  validateTruthShape(truth);
  const schema = Object.prototype.hasOwnProperty.call(STATIC_ROW_SCHEMA, item.id)
    ? STATIC_ROW_SCHEMA[item.id]
    : dynamicSchema(item, truth);
  if (!schema || schema.categoryId !== item.categoryId || schema.editorKind !== item.editor.kind) {
    throw new DesktopSettingsProjectionError();
  }
  const actionId = item.editor.kind === "readonly" ? undefined : item.editor.actionId;
  if (actionId !== schema.actionId) throw new DesktopSettingsProjectionError();
  if (item.editor.kind === "choice") {
    const actual = choiceValues(item.editor);
    const expected = schema.choices ?? (truth.kind === "reasoning" ? truth.options : null);
    if (!expected || !sameStrings(actual, expected)) throw new DesktopSettingsProjectionError();
    if (truth.kind === "reasoning" && (!actual.includes(truth.value) || actual.some((value) => !isReasoningValue(value)))) {
      throw new DesktopSettingsProjectionError();
    }
  }
  if (item.editor.kind === "model"
    && (item.editor.filter !== schema.modelFilter || (item.editor.multiple === true) !== (schema.multiple === true))) {
    throw new DesktopSettingsProjectionError();
  }
  if (item.editor.kind === "text" && item.editor.valueKind !== schema.valueKind) {
    throw new DesktopSettingsProjectionError();
  }
  if (item.editor.kind === "number"
    && (item.editor.minimum !== schema.minimum || item.editor.maximum !== schema.maximum
      || item.editor.unit !== schema.unit || (item.editor.allowOff === true) !== (schema.allowOff === true))) {
    throw new DesktopSettingsProjectionError();
  }
  if (item.editor.kind === "confirm" && item.editor.destructive !== true) {
    throw new DesktopSettingsProjectionError();
  }
  validateTruthForSchema(item, truth, schema);
}

function dynamicSchema(item: GermanSettingsItem, truth: SettingsDesktopRowTruth): RowSchema | null {
  let match = /^provider-status:(openrouter|kimi-code|anthropic)$/.exec(item.id);
  if (match) {
    return truth.kind === "provider-status" && truth.provider.backendId === match[1]
      ? simple("accounts", "readonly") : null;
  }
  match = /^provider-action:(openrouter|kimi-code|anthropic):(connect|enable|disable|disconnect|reconnect|models|logout)$/.exec(item.id);
  if (match) {
    const actionId = `provider-${match[2]}` as SettingsActionId;
    return truth.kind === "provider-action" && truth.backendId === match[1] && truth.action === match[2]
      ? simple("accounts", "invoke", actionId) : null;
  }
  if (/^approval-rule:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)) {
    return truth.kind === "approval-rule" ? simple("approvals-costs", "readonly") : null;
  }
  if (/^approval-forget:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)) {
    return truth.kind === "approval-forget" ? simple("approvals-costs", "confirm", "approval-forget") : null;
  }
  return null;
}

function validateTruthForSchema(item: GermanSettingsItem, truth: SettingsDesktopRowTruth, schema: RowSchema): void {
  const id = item.id;
  if (id === "main-model") return requireModelTruth(truth, 1, ["configured", "not-connected"]);
  if (id === "compressor-model" || id === "transcription-model") return requireModelTruth(truth, 1, ["configured"]);
  if (id === "cross-lead-model" || id === "cross-challenger-model") {
    return requireOptionalModelTruth(truth, "staged");
  }
  if (id === "architect-executor-model") return requireOptionalModelTruth(truth, "configured");
  if (id === "panel-models") {
    if (truth.kind !== "model" || !Array.isArray(truth.modelIds) || truth.modelIds.length > 5
      || (truth.modelIds.length === 0 ? truth.state !== "unset" : truth.state !== "configured")) {
      throw new DesktopSettingsProjectionError();
    }
    return;
  }
  if (id === "reasoning" || id === "reasoning-compressor" || id === "reasoning-cross-lead" || id === "reasoning-cross-challenger") {
    if (truth.kind !== "reasoning" || !Array.isArray(truth.options) || typeof truth.value !== "string") {
      throw new DesktopSettingsProjectionError();
    }
    return;
  }
  if (id === "provider-fallback" || id === "panel-judge" || id === "appearance-large-logo" || id === "appearance-header-mark") {
    if (truth.kind !== "boolean" || typeof truth.value !== "boolean") throw new DesktopSettingsProjectionError();
    return;
  }
  if (id.startsWith("provider-status:") || id.startsWith("provider-action:")
    || id.startsWith("approval-rule:") || id.startsWith("approval-forget:")) return;
  if (schema.editorKind === "choice") {
    if (truth.kind !== "choice" || !schema.choices?.includes(truth.value)) throw new DesktopSettingsProjectionError();
    return;
  }
  switch (id) {
    case "max-steps":
    case "verify-repair-rounds":
      if (truth.kind !== "number" || truth.unit !== "integer" || !Number.isSafeInteger(truth.value)
        || !numberWithinSchema(truth.value, schema)) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "max-cost":
    case "compressor-max-cost":
    case "low-balance-threshold":
      if (truth.kind !== "number" || truth.unit !== "usd" || !Number.isFinite(truth.value)
        || !numberWithinSchema(truth.value, schema)) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "browser-timeout":
      if (truth.kind !== "number" || truth.unit !== "seconds" || !Number.isFinite(truth.value)
        || !numberWithinSchema(truth.value, schema)) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "budget-daily":
    case "budget-total":
      if (truth.kind !== "optional-usd"
        || (truth.value === null ? schema.allowOff !== true
          : typeof truth.value !== "number" || !Number.isFinite(truth.value) || !numberWithinSchema(truth.value, schema))) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "provider-only":
    case "provider-ignore":
      if (truth.kind !== "provider-list" || !Array.isArray(truth.values) || truth.values.length > 20) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "browser-path":
      if (truth.kind !== "path" || (truth.value !== null && typeof truth.value !== "string")) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "approval-forget-all":
      if (truth.kind !== "count" || truth.subject !== "rules" || !Number.isSafeInteger(truth.count) || truth.count < 0) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "verify-commands":
    case "verify-clear":
      if (truth.kind !== "count" || truth.subject !== "commands" || !Number.isSafeInteger(truth.count) || truth.count < 0) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "provider-setup":
    case "cross-pair-swap":
    case "verify-suggest":
      if (truth.kind !== "action" || truth.actionId !== id || truth.active !== undefined) throw new DesktopSettingsProjectionError();
      return;
    case "voice-consent-clear":
      if (truth.kind !== "action" || truth.actionId !== id || typeof truth.active !== "boolean") throw new DesktopSettingsProjectionError();
      return;
    case "cost-summary":
      if (truth.kind !== "cost" || (truth.knowledge !== "known" && truth.knowledge !== "unknown")
        || ![truth.sessionUsd, truth.dayUsd, truth.totalUsd].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "voice-consent-status":
      if (truth.kind !== "consent" || typeof truth.granted !== "boolean") throw new DesktopSettingsProjectionError();
      return;
    default:
      throw new DesktopSettingsProjectionError();
  }
}

function requireModelTruth(
  truth: SettingsDesktopRowTruth,
  cardinality: number,
  states: readonly Extract<SettingsDesktopRowTruth, { readonly kind: "model" }>["state"][],
): void {
  if (truth.kind !== "model" || !Array.isArray(truth.modelIds)
    || truth.modelIds.length !== cardinality || !states.includes(truth.state)) {
    throw new DesktopSettingsProjectionError();
  }
}

function requireOptionalModelTruth(
  truth: SettingsDesktopRowTruth,
  presentState: Extract<SettingsDesktopRowTruth, { readonly kind: "model" }>["state"],
): void {
  if (truth.kind !== "model" || !Array.isArray(truth.modelIds) || truth.modelIds.length > 1
    || (truth.modelIds.length === 0 ? truth.state !== "unset" : truth.state !== presentState)) {
    throw new DesktopSettingsProjectionError();
  }
}

function numberWithinSchema(value: number, schema: RowSchema): boolean {
  return typeof schema.minimum === "number" && typeof schema.maximum === "number"
    && value >= schema.minimum && value <= schema.maximum;
}

function germanDisplay(truth: SettingsDesktopRowTruth): string {
  switch (truth.kind) {
    case "model": {
      if (truth.modelIds.length === 0) {
        if (truth.state !== "unset") throw new DesktopSettingsProjectionError();
        return "Nicht festgelegt";
      }
      const ids = truth.modelIds.map(safeTechnicalIdentifier);
      const suffix = truth.state === "not-connected" ? " · nicht verbunden"
        : truth.state === "staged" ? " · vorgemerkt" : truth.state === "configured" ? "" : null;
      if (suffix === null) throw new DesktopSettingsProjectionError();
      return `Modell: ${ids.join(" · ")}${suffix}`;
    }
    case "reasoning":
      return reasoningLabel(truth.value);
    case "choice":
      return choiceLabel(truth.value);
    case "boolean":
      return truth.value ? "Ein" : "Aus";
    case "number":
      if (!Number.isFinite(truth.value) || (truth.unit === "integer" && !Number.isInteger(truth.value))) throw new DesktopSettingsProjectionError();
      return truth.unit === "usd" ? `${plainNumber(truth.value)} USD`
        : truth.unit === "seconds" ? `${plainNumber(truth.value)} s` : plainNumber(truth.value);
    case "optional-usd":
      return truth.value === null ? "Aus" : Number.isFinite(truth.value) ? `${plainNumber(truth.value)} USD` : failProjection();
    case "provider-list":
      return truth.values.length === 0 ? "Keine Einschränkung" : `Anbieter: ${truth.values.map(safeTechnicalIdentifier).join(" · ")}`;
    case "path":
      return truth.value === null || truth.value === "" ? "Automatisch suchen" : `Pfad: ${safePath(truth.value)}`;
    case "count":
      if (!Number.isSafeInteger(truth.count) || truth.count < 0) throw new DesktopSettingsProjectionError();
      return truth.subject === "rules" ? `${truth.count} ${truth.count === 1 ? "Regel" : "Regeln"}`
        : `${truth.count} ${truth.count === 1 ? "Befehl" : "Befehle"}`;
    case "action":
      return actionDisplay(truth);
    case "provider-status":
      return providerStatusLabel(truth.provider);
    case "provider-action":
      return `Aktion: ${actionName(truth.action)}`;
    case "approval-rule":
      return truth.decision === "allow" ? "Erlauben" : "Ablehnen";
    case "approval-forget":
      return "Regel löschen";
    case "cost":
      return truth.knowledge === "unknown" ? "Kosten unbekannt · vom Anbieter verwaltet"
        : `Chat ${plainUsd(truth.sessionUsd)} · Heute ${plainUsd(truth.dayUsd)} · Ordner ${plainUsd(truth.totalUsd)}`;
    case "consent":
      return truth.granted ? "Erteilt" : "Nicht erteilt";
    default:
      return assertNeverTruth(truth);
  }
}

function germanAction(item: GermanSettingsItem, truth: SettingsDesktopRowTruth): string {
  if (truth.kind === "provider-action") return actionName(truth.action);
  if (truth.kind === "approval-forget") return "Regel löschen";
  const labels: Readonly<Record<string, string>> = Object.freeze({
    "provider-setup": "Einrichten", "cross-pair-swap": "Tauschen", "approval-forget-all": "Alle Regeln löschen",
    "verify-suggest": "Vorschlagen", "verify-clear": "Löschen", "voice-consent-clear": "Zurücksetzen",
  });
  const label = labels[item.id];
  if (!label) throw new DesktopSettingsProjectionError();
  return label;
}

function providerStatusLabel(
  provider: Extract<SettingsDesktopRowTruth, { readonly kind: "provider-status" }>["provider"],
): string {
  if (provider.backendId === "anthropic") {
    if (provider.availability !== "coming-soon" || provider.configuration !== "not-connected"
      || provider.maturity !== "coming-soon" || provider.billingRealm !== "none" || provider.headline !== null
      || provider.isDefault !== false || provider.selectedRequestedModelId !== null || provider.allowedActions.length !== 0) {
      throw new DesktopSettingsProjectionError();
    }
    return "Nicht als direkter Anbieter verfügbar · Claude-Modelle laufen über OpenRouter";
  }
  const configuration = exactLabel(provider.configuration, {
    enabled: "Aktiviert", disabled: "Deaktiviert", "not-connected": "Nicht verbunden",
  });
  const maturity = exactLabel(provider.maturity, { stable: "Stabil", preview: "Vorschau", "coming-soon": "Demnächst" });
  const headline = provider.headline === null ? "Nicht geprüft" : exactLabel(provider.headline, {
    ready: "Bereit", "login-required": "Anmeldung erforderlich", "auth-rejected": "Anmeldung abgelehnt",
    "credential-expired": "Anmeldung abgelaufen", offline: "Offline", "limit-reached": "Anbieterlimit erreicht",
    "runtime-missing": "Laufzeit fehlt", "incompatible-runtime": "Laufzeit inkompatibel",
    "policy-unavailable": "Richtlinie nicht verfügbar", unknown: "Nicht geprüft",
  });
  const billing = exactLabel(provider.billingRealm, {
    "openrouter-payg": "API-Nutzungsabrechnung",
    "kimi-code-membership-provider-managed-overage": "Abo · Mehrkosten vom Anbieter verwaltet",
    none: "Keine Abrechnung",
  });
  const selected = provider.selectedRequestedModelId
    ? ` · Modell ${safeTechnicalIdentifier(provider.selectedRequestedModelId)}` : "";
  return `${configuration} · ${maturity} · ${headline} · ${billing}${provider.isDefault ? " · Standardroute" : ""}${selected}`;
}

function choiceLabel(value: string): string {
  return exactLabel(value, {
    off: "Aus", auto: "Automatisch", always: "Immer", price: "Preis", throughput: "Durchsatz", latency: "Latenz",
    deny: "Ablehnen", allow: "Erlauben", "read-only": "Nur lesen", ask: "Nachfragen",
    "auto-edit": "Automatisch bearbeiten", "allow-all": "Alles erlauben", warn: "Warnen", block: "Sperren",
    "on-edit": "Nach Änderungen", on: "Ein", unicode: "Unicode", ascii: "ASCII",
  });
}

function reasoningLabel(value: string): string {
  if (value === "auto") return "Automatisch";
  const effort = /^effort:(none|minimal|low|medium|high|xhigh|max)$/.exec(value);
  if (effort) return `Aufwand: ${exactLabel(effort[1]!, {
    none: "Keiner", minimal: "Minimal", low: "Niedrig", medium: "Mittel", high: "Hoch", xhigh: "Sehr hoch", max: "Maximum",
  })}`;
  const budget = /^budget:([1-9]\d*)$/.exec(value);
  if (budget && Number.isSafeInteger(Number(budget[1]))) return `Budget: ${budget[1]} Token`;
  throw new DesktopSettingsProjectionError();
}

function isReasoningValue(value: string): boolean {
  return value === "auto" || /^effort:(?:none|minimal|low|medium|high|xhigh|max)$/.test(value)
    || /^budget:[1-9]\d*$/.test(value);
}

function actionDisplay(truth: Extract<SettingsDesktopRowTruth, { readonly kind: "action" }>): string {
  if (truth.actionId === "voice-consent-clear") {
    if (typeof truth.active !== "boolean") throw new DesktopSettingsProjectionError();
    return truth.active ? "Zurücksetzen" : "Nicht erteilt";
  }
  if (truth.active !== undefined) throw new DesktopSettingsProjectionError();
  return exactLabel(truth.actionId, {
    "provider-setup": "Öffnen", "cross-pair-swap": "Tauschen", "verify-suggest": "Vorschlagen",
  });
}

function safeTechnicalIdentifier(value: string): string {
  const normalized = value.normalize("NFC");
  if (normalized !== value || [...value].length < 1 || [...value].length > 200 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new DesktopSettingsProjectionError();
  }
  return value;
}

function safePath(value: string): string {
  if ([...value].length > 1_024 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new DesktopSettingsProjectionError();
  return value;
}

function choiceValues(
  editor:
    | Extract<SettingsItem["editor"], { readonly kind: "choice" }>
    | Extract<SettingsDesktopEditorSchema, { readonly kind: "choice" }>,
): readonly string[] {
  return "values" in editor ? editor.values : editor.options.map(({ value }) => value);
}

function sameStrings(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.every((value) => typeof value === "string")
    && right.every((value) => typeof value === "string")
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateTruthShape(truth: unknown): asserts truth is SettingsDesktopRowTruth {
  if (!isRecord(truth) || typeof truth.kind !== "string") throw new DesktopSettingsProjectionError();
  switch (truth.kind) {
    case "model":
      requireExactKeys(truth, ["kind", "modelIds", "state"]);
      if (!Array.isArray(truth.modelIds) || !truth.modelIds.every((value) => typeof value === "string")
        || truth.modelIds.some((value) => !isSafeTechnicalIdentifier(value))
        || new Set(truth.modelIds).size !== truth.modelIds.length
        || !isOneOf(truth.state, ["configured", "not-connected", "staged", "unset"])) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "reasoning":
      requireExactKeys(truth, ["kind", "value", "options"]);
      if (typeof truth.value !== "string" || !isReasoningValue(truth.value)
        || !Array.isArray(truth.options) || truth.options.length === 0
        || !truth.options.every((value) => typeof value === "string" && isReasoningValue(value))
        || new Set(truth.options).size !== truth.options.length) throw new DesktopSettingsProjectionError();
      return;
    case "choice":
      requireExactKeys(truth, ["kind", "value"]);
      if (typeof truth.value !== "string") throw new DesktopSettingsProjectionError();
      return;
    case "boolean":
      requireExactKeys(truth, ["kind", "value"]);
      if (typeof truth.value !== "boolean") throw new DesktopSettingsProjectionError();
      return;
    case "number":
      requireExactKeys(truth, ["kind", "value", "unit"]);
      if (typeof truth.value !== "number" || !Number.isFinite(truth.value)
        || !isOneOf(truth.unit, ["integer", "usd", "seconds"])) throw new DesktopSettingsProjectionError();
      return;
    case "optional-usd":
      requireExactKeys(truth, ["kind", "value"]);
      if (truth.value !== null && (typeof truth.value !== "number" || !Number.isFinite(truth.value))) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "provider-list":
      requireExactKeys(truth, ["kind", "values"]);
      if (!Array.isArray(truth.values) || truth.values.length > 20
        || !truth.values.every((value) => typeof value === "string" && isSafeTechnicalIdentifier(value))) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "path":
      requireExactKeys(truth, ["kind", "value"]);
      if (truth.value !== null && (typeof truth.value !== "string" || !isSafePath(truth.value))) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "count":
      requireExactKeys(truth, ["kind", "count", "subject"]);
      if (!Number.isSafeInteger(truth.count) || Number(truth.count) < 0 || !isOneOf(truth.subject, ["rules", "commands"])) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "action": {
      const keys = Object.prototype.hasOwnProperty.call(truth, "active")
        ? ["kind", "actionId", "active"] : ["kind", "actionId"];
      requireExactKeys(truth, keys);
      if (typeof truth.actionId !== "string"
        || (Object.prototype.hasOwnProperty.call(truth, "active") && typeof truth.active !== "boolean")) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    }
    case "provider-status":
      requireExactKeys(truth, ["kind", "provider"]);
      validateProviderTruth(truth.provider);
      return;
    case "provider-action":
      requireExactKeys(truth, ["kind", "backendId", "action"]);
      if (!isOneOf(truth.backendId, ["openrouter", "kimi-code", "anthropic"])
        || !isProviderAction(truth.action)) throw new DesktopSettingsProjectionError();
      return;
    case "approval-rule":
      requireExactKeys(truth, ["kind", "decision"]);
      if (!isOneOf(truth.decision, ["allow", "deny"])) throw new DesktopSettingsProjectionError();
      return;
    case "approval-forget":
      requireExactKeys(truth, ["kind"]);
      return;
    case "cost":
      requireExactKeys(truth, ["kind", "knowledge", "sessionUsd", "dayUsd", "totalUsd"]);
      if (!isOneOf(truth.knowledge, ["known", "unknown"])
        || ![truth.sessionUsd, truth.dayUsd, truth.totalUsd]
          .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        throw new DesktopSettingsProjectionError();
      }
      return;
    case "consent":
      requireExactKeys(truth, ["kind", "granted"]);
      if (typeof truth.granted !== "boolean") throw new DesktopSettingsProjectionError();
      return;
    default:
      throw new DesktopSettingsProjectionError();
  }
}

function validateProviderTruth(provider: unknown): void {
  if (!isRecord(provider)) throw new DesktopSettingsProjectionError();
  requireExactKeys(provider, [
    "backendId", "availability", "configuration", "maturity", "billingRealm", "headline",
    "isDefault", "selectedRequestedModelId", "allowedActions",
  ]);
  if (!isOneOf(provider.backendId, ["openrouter", "kimi-code", "anthropic"])
    || !isOneOf(provider.availability, ["connectable", "coming-soon"])
    || !isOneOf(provider.configuration, ["enabled", "disabled", "not-connected"])
    || !isOneOf(provider.maturity, ["stable", "preview", "coming-soon"])
    || !isOneOf(provider.billingRealm, ["openrouter-payg", "kimi-code-membership-provider-managed-overage", "none"])
    || !(provider.headline === null || isOneOf(provider.headline, [
      "ready", "login-required", "auth-rejected", "credential-expired", "offline", "limit-reached",
      "runtime-missing", "incompatible-runtime", "policy-unavailable", "unknown",
    ]))
    || typeof provider.isDefault !== "boolean"
    || !(provider.selectedRequestedModelId === null
      || (typeof provider.selectedRequestedModelId === "string" && isSafeTechnicalIdentifier(provider.selectedRequestedModelId)))
    || !Array.isArray(provider.allowedActions)
    || provider.allowedActions.length > 7
    || !provider.allowedActions.every(isProviderAction)
    || new Set(provider.allowedActions).size !== provider.allowedActions.length) {
    throw new DesktopSettingsProjectionError();
  }
  if (provider.backendId === "openrouter") {
    if (provider.availability !== "connectable" || provider.maturity !== "stable"
      || provider.billingRealm !== "openrouter-payg") throw new DesktopSettingsProjectionError();
    return;
  }
  if (provider.backendId === "kimi-code") {
    if (provider.availability !== "connectable" || provider.maturity !== "preview"
      || provider.billingRealm !== "kimi-code-membership-provider-managed-overage"
      || provider.allowedActions.includes("disconnect")) throw new DesktopSettingsProjectionError();
    return;
  }
  if (provider.availability !== "coming-soon" || provider.configuration !== "not-connected"
    || provider.maturity !== "coming-soon" || provider.billingRealm !== "none" || provider.headline !== null
    || provider.isDefault !== false || provider.selectedRequestedModelId !== null || provider.allowedActions.length !== 0) {
    throw new DesktopSettingsProjectionError();
  }
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameStrings(actual, wanted)) throw new DesktopSettingsProjectionError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isProviderAction(value: unknown): value is "connect" | "enable" | "disable" | "disconnect" | "reconnect" | "models" | "logout" {
  return isOneOf(value, ["connect", "enable", "disable", "disconnect", "reconnect", "models", "logout"]);
}

function isSafeTechnicalIdentifier(value: string): boolean {
  return value.normalize("NFC") === value && [...value].length >= 1 && [...value].length <= 200
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isSafePath(value: string): boolean {
  return [...value].length <= 1_024 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function plainNumber(value: number): string {
  if (!Number.isFinite(value)) throw new DesktopSettingsProjectionError();
  return String(value).replace(".", ",");
}

function plainUsd(value: number): string {
  return `${plainNumber(value)} USD`;
}

function exactLabel(value: string, labels: Readonly<Record<string, string>>): string {
  if (!Object.prototype.hasOwnProperty.call(labels, value)) throw new DesktopSettingsProjectionError();
  const label = labels[value];
  if (typeof label !== "string" || !label) throw new DesktopSettingsProjectionError();
  return label;
}

function failProjection(): never {
  throw new DesktopSettingsProjectionError();
}

function assertNeverTruth(value: never): never {
  throw new DesktopSettingsProjectionError();
}

function providerName(id: string): string { return id === "kimi-code" ? "Kimi Code" : id === "openrouter" ? "OpenRouter" : "Anthropic"; }
function actionName(id: string): string {
  const labels: Readonly<Record<string, string>> = Object.freeze({
    connect: "Verbinden", enable: "Aktivieren", disable: "Deaktivieren", disconnect: "Trennen",
    reconnect: "Neu verbinden", models: "Modelle aktualisieren", logout: "Abmelden",
  });
  return exactLabel(id, labels);
}
