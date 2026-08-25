import type { ProviderCommandBackendId } from "./commands.js";
import type { OrcodeConfigWithBudget } from "./config.js";
import {
  getReasoningSetting,
  reasoningChoiceValue,
  reasoningChoices,
  reasoningLabel,
  supportsReasoning,
} from "./reasoning.js";
import type { CostKnowledge, ModelInfo } from "./types.js";
import { formatUsd } from "./utils.js";

export const SETTINGS_CATEGORY_IDS = [
  "models-reasoning",
  "providers-accounts",
  "security-approvals",
  "costs-budgets",
  "verify-tools",
  "appearance",
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

export const SETTINGS_ACTION_IDS = [
  "main-model",
  "reasoning",
  "compression-mode",
  "compressor-model",
  "max-steps",
  "provider-setup",
  "provider-connect",
  "provider-enable",
  "provider-disable",
  "provider-disconnect",
  "provider-reconnect",
  "provider-models",
  "provider-logout",
  "provider-sort",
  "provider-data-collection",
  "provider-only",
  "provider-ignore",
  "provider-fallback",
  "approval-mode",
  "approval-forget",
  "approval-forget-all",
  "max-cost",
  "compressor-max-cost",
  "budget-daily",
  "budget-total",
  "budget-on-exceed",
  "verify-mode",
  "verify-commands",
  "verify-suggest",
  "verify-clear",
  "verify-repair-rounds",
  "web-mode",
  "browser-path",
  "browser-timeout",
  "panel-models",
  "panel-judge",
  "transcription-model",
  "voice-consent-clear",
  "appearance-large-logo",
  "appearance-header-mark",
  "appearance-glyph-mode",
] as const satisfies readonly string[];

export type SettingsActionId = (typeof SETTINGS_ACTION_IDS)[number];

export type ProviderBackendAction =
  | "connect"
  | "enable"
  | "disable"
  | "disconnect"
  | "reconnect"
  | "models"
  | "logout";

export type SettingsItemId =
  | SettingsActionId
  | "current-route"
  | "cost-summary"
  | "voice-consent-status"
  | "security-provider-data-collection"
  | "security-provider-only"
  | "security-provider-ignore"
  | `provider-status:${ProviderCommandBackendId}`
  | `provider-action:${ProviderCommandBackendId}:${ProviderBackendAction}`
  | `approval-rule:${string}`
  | `approval-forget:${string}`;

export interface SettingsChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export type SettingsEditorDescriptor =
  | {
      readonly kind: "choice";
      readonly actionId: SettingsActionId;
      readonly options: readonly SettingsChoice[];
    }
  | {
      readonly kind: "model";
      readonly actionId: SettingsActionId;
      readonly filter: "main" | "compressor" | "panel" | "audio-input";
      readonly multiple?: boolean;
    }
  | {
      readonly kind: "number";
      readonly actionId: SettingsActionId;
      readonly minimum: number;
      readonly maximum: number;
      readonly allowOff?: boolean;
      readonly unit?: string;
    }
  | {
      readonly kind: "text";
      readonly actionId: SettingsActionId;
      readonly valueKind: "path" | "command-list" | "provider-list";
    }
  | {
      readonly kind: "confirm";
      readonly actionId: SettingsActionId;
      readonly destructive: boolean;
    }
  | { readonly kind: "invoke"; readonly actionId: SettingsActionId }
  | { readonly kind: "readonly" };

export interface SettingsItem {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly displayValue: string;
  readonly editor: SettingsEditorDescriptor;
  /** False only for status and presentation-only actions such as Appearance. */
  readonly affectsActiveRun: boolean;
  readonly disabledReason?: "Lauf aktiv" | string;
}

export interface SettingsCategory {
  readonly id: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
}

export interface SettingsRegistry {
  readonly categories: readonly SettingsCategory[];
  readonly items: readonly SettingsItem[];
}

export interface SettingsRouteProjection {
  readonly backendId: ProviderCommandBackendId;
  readonly providerLabel: string;
  readonly requestedModelId: string;
  readonly canonicalModelId: string;
  readonly modelLabel: string;
  readonly billingRealm:
    | "openrouter-payg"
    | "kimi-code-membership-provider-managed-overage"
    | "none";
}

export interface SettingsProviderHealthProjection {
  readonly credential:
    | "valid"
    | "rejected"
    | "expired"
    | "login-required"
    | "unknown"
    | "not-applicable";
  readonly connectivity: "connected" | "offline" | "unknown";
  readonly spend: "available" | "limit-reached" | "unknown";
  readonly runtime:
    | "ready"
    | "missing"
    | "incompatible"
    | "policy-unavailable"
    | "not-applicable";
}

export type SettingsProviderHeadline =
  | "ready"
  | "login-required"
  | "auth-rejected"
  | "credential-expired"
  | "offline"
  | "limit-reached"
  | "runtime-missing"
  | "incompatible-runtime"
  | "policy-unavailable"
  | "unknown";

/**
 * Safe cached provider view. Lifecycle capabilities arrive from the provider
 * command authority; this module deliberately owns no backend capability map.
 */
export interface SettingsProviderProjection {
  readonly backendId: ProviderCommandBackendId;
  readonly displayName: string;
  readonly availability: "connectable" | "coming-soon";
  readonly configuration: "enabled" | "disabled";
  readonly maturity: "stable" | "preview" | "coming-soon";
  readonly billingRealm:
    | "openrouter-payg"
    | "kimi-code-membership-provider-managed-overage"
    | "none";
  readonly headline: SettingsProviderHeadline | null;
  readonly health: SettingsProviderHealthProjection | null;
  readonly isDefault: boolean;
  readonly selectedModel: {
    readonly requestedModelId: string;
    readonly canonicalModelId: string;
    readonly displayName: string;
  } | null;
  readonly allowedActions: readonly ProviderBackendAction[];
}

export interface SettingsApprovalRuleProjection {
  readonly id: string;
  readonly decision: "allow" | "deny";
}

export interface SettingsCostProjection {
  readonly costKnowledge: CostKnowledge;
  readonly sessionUsd: number;
  readonly dayUsd: number;
  readonly totalUsd: number;
}

export interface SettingsAuthoritativeSnapshot {
  readonly config: OrcodeConfigWithBudget;
  readonly runActive: boolean;
  readonly route: SettingsRouteProjection | null;
  readonly providers: readonly SettingsProviderProjection[];
  readonly approvalRules: readonly SettingsApprovalRuleProjection[];
  readonly costs: SettingsCostProjection;
  readonly cachedModels: readonly ModelInfo[];
}

const PROVIDER_BACKEND_ORDER = [
  "openrouter",
  "kimi-code",
  "anthropic",
] as const satisfies readonly ProviderCommandBackendId[];

const PROVIDER_ACTION_ORDER = [
  "connect",
  "enable",
  "disable",
  "disconnect",
  "reconnect",
  "models",
  "logout",
] as const satisfies readonly ProviderBackendAction[];

const COMPRESSION_CHOICES = [
  { value: "off", label: "Aus", description: "Kontext nie automatisch komprimieren" },
  { value: "auto", label: "Automatisch", description: "Kontext bei Bedarf komprimieren" },
  { value: "always", label: "Immer", description: "Kontext vor jedem Lauf komprimieren" },
] as const satisfies readonly SettingsChoice[];

const PROVIDER_SORT_CHOICES = [
  { value: "off", label: "Aus", description: "Keine bevorzugte Provider-Sortierung senden" },
  { value: "price", label: "Preis", description: "Günstigere Provider bevorzugen" },
  { value: "throughput", label: "Durchsatz", description: "Provider mit höherem Durchsatz bevorzugen" },
  { value: "latency", label: "Latenz", description: "Provider mit niedrigerer Latenz bevorzugen" },
] as const satisfies readonly SettingsChoice[];

const DATA_COLLECTION_CHOICES = [
  { value: "deny", label: "Ablehnen", description: "Provider mit Datenweitergabe nicht zulassen" },
  { value: "allow", label: "Erlauben", description: "Provider mit Datenweitergabe zulassen" },
] as const satisfies readonly SettingsChoice[];

const ON_OFF_CHOICES = [
  { value: "on", label: "An", description: "Einstellung einschalten" },
  { value: "off", label: "Aus", description: "Einstellung ausschalten" },
] as const satisfies readonly SettingsChoice[];

const APPROVAL_CHOICES = [
  { value: "read-only", label: "Nur lesen", description: "Nur lesen; Änderungen und Shell-Befehle werden blockiert. Lesezugriff auf Geheimnisse fragt nach." },
  { value: "ask", label: "Nachfragen", description: "Vor Dateiänderungen und jedem Shell-Befehl fragen." },
  { value: "auto-edit", label: "Änderungen automatisch", description: "Dateiänderungen automatisch, vor Shell-Befehlen fragen. Geschützte Pfade fragen trotzdem nach." },
  { value: "allow-all", label: "Alles erlauben", description: "Dateiänderungen und Shell-Befehle ohne Nachfrage. Gefährlich. Nur geschützte Pfade fragen weiter nach." },
] as const satisfies readonly SettingsChoice[];

const BUDGET_ACTION_CHOICES = [
  { value: "warn", label: "Warnen", description: "Bei Überschreitung warnen und fortfahren" },
  { value: "block", label: "Blockieren", description: "Neue Läufe bei Überschreitung blockieren" },
] as const satisfies readonly SettingsChoice[];

const VERIFY_MODE_CHOICES = [
  { value: "off", label: "Aus", description: "Nach Änderungen keine automatische Prüfung starten" },
  { value: "on-edit", label: "Nach Änderungen", description: "Konfigurierte Prüfungen nach Dateiänderungen starten" },
] as const satisfies readonly SettingsChoice[];

const WEB_MODE_CHOICES = [
  { value: "auto", label: "Automatisch", description: "Webzugriff abhängig von der Aufgabe anbieten" },
  { value: "on", label: "An", description: "Webwerkzeug aktivieren" },
  { value: "off", label: "Aus", description: "Webwerkzeug deaktivieren" },
] as const satisfies readonly SettingsChoice[];

const GLYPH_MODE_CHOICES = [
  { value: "auto", label: "Automatisch", description: "Terminalfähigkeiten automatisch berücksichtigen" },
  { value: "unicode", label: "Unicode", description: "Unicode-Zeichen erzwingen" },
  { value: "ascii", label: "ASCII", description: "Nur ASCII-Zeichen verwenden" },
] as const satisfies readonly SettingsChoice[];

const READONLY_EDITOR = Object.freeze({ kind: "readonly" } as const);

interface ItemInput {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly displayValue: string;
  readonly editor: SettingsEditorDescriptor;
  readonly affectsActiveRun: boolean;
  readonly disabledReason?: string;
}

export function buildSettingsRegistry(
  snapshot: SettingsAuthoritativeSnapshot,
): SettingsRegistry {
  const categories = SETTINGS_CATEGORY_IDS.map(categoryDefinition);
  const items = [
    ...modelItems(snapshot),
    ...providerItems(snapshot),
    ...securityItems(snapshot),
    ...costItems(snapshot),
    ...toolItems(snapshot),
    ...appearanceItems(snapshot),
  ];
  return Object.freeze({
    categories: Object.freeze(categories),
    items: Object.freeze(items),
  });
}

export function searchSettings(
  registry: SettingsRegistry,
  query: string,
): readonly SettingsItem[] {
  const wanted = normalizeSearchText(query);
  if (!wanted) return registry.items;
  return registry.items
    .map((candidate, index) => ({
      candidate,
      index,
      score: searchScore(candidate, wanted),
    }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score! - right.score! || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function categoryDefinition(id: SettingsCategoryId): SettingsCategory {
  switch (id) {
    case "models-reasoning":
      return Object.freeze({
        id,
        label: "Modelle & Denken",
        description: "Modellroute, Reasoning und Kontextkompression",
      });
    case "providers-accounts":
      return Object.freeze({
        id,
        label: "Anbieter & Konten",
        description: "Sichere Provider-Zustände, Verbindungen und Routingregeln",
      });
    case "security-approvals":
      return Object.freeze({
        id,
        label: "Sicherheit & Freigaben",
        description: "Werkzeugfreigaben und OpenRouter-Datenschutz",
      });
    case "costs-budgets":
      return Object.freeze({
        id,
        label: "Kosten & Budgets",
        description: "Laufgrenzen, Workspace-Budgets und Kostenstand",
      });
    case "verify-tools":
      return Object.freeze({
        id,
        label: "Prüfen & Tools",
        description: "Prüfkommandos, Browser, Panel und Spracheingabe",
      });
    case "appearance":
      return Object.freeze({
        id,
        label: "Darstellung",
        description: "Route-Core-Sichtbarkeit und Terminalzeichen",
      });
    default:
      return assertNever(id);
  }
}

function modelItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  const currentModel = findModel(snapshot.cachedModels, config.mainModel);
  const currentReasoning = getReasoningSetting(config);
  const currentReasoningLabel = reasoningLabel(currentReasoning);
  const reasoningOptions = currentModel === null
    ? [{
        value: reasoningChoiceValue(currentReasoning),
        label: `Gespeichert · ${currentReasoningLabel}`,
        description: "Gespeicherter Wert; Modellfähigkeiten sind ohne Katalog nicht prüfbar",
      }]
    : reasoningChoices(currentModel, currentReasoning).map(({ value, label, description }) => ({
        value,
        label,
        description,
      }));
  return [
    item(snapshot, {
      id: "main-model",
      categoryId: "models-reasoning",
      label: "Hauptmodell",
      description: "Providergebundenes Hauptmodell und aktive Sitzungsroute atomar wechseln",
      aliases: ["modell", "route", "main"],
      displayValue: modelDisplay(snapshot.cachedModels, config.mainModel),
      editor: { kind: "model", actionId: "main-model", filter: "main" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "current-route",
      categoryId: "models-reasoning",
      label: "Aktuelle Route",
      description: "Sicherer Status der aktuell gebundenen Provider- und Modellroute",
      aliases: ["route", "anbieter", "provider"],
      displayValue: routeDisplay(snapshot.route),
      editor: READONLY_EDITOR,
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "reasoning",
      categoryId: "models-reasoning",
      label: "Reasoning",
      description: "Thinking-Modus oder unterstützte Aufwandsstufe des Hauptmodells wählen",
      aliases: ["thinking", "denken", "effort"],
      displayValue: currentReasoningLabel,
      editor: { kind: "choice", actionId: "reasoning", options: reasoningOptions },
      affectsActiveRun: true,
      ...(currentModel === null
        ? { disabledReason: "Modellkatalog nicht verfügbar" }
        : !supportsReasoning(currentModel)
          ? { disabledReason: "Modell unterstützt Reasoning nicht" }
          : {}),
    }),
    item(snapshot, {
      id: "compression-mode",
      categoryId: "models-reasoning",
      label: "Kompressionsmodus",
      description: "Steuert, wann langer Kontext durch das Kompressormodell verdichtet wird",
      aliases: ["kompression", "context", "compress"],
      displayValue: compressionModeLabel(config.compressionMode),
      editor: { kind: "choice", actionId: "compression-mode", options: COMPRESSION_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "compressor-model",
      categoryId: "models-reasoning",
      label: "Kompressormodell",
      description: "Modell für die Verdichtung langen Kontexts auswählen",
      aliases: ["kompressor", "zusammenfassen", "compressor"],
      displayValue: modelDisplay(snapshot.cachedModels, config.compressorModel),
      editor: { kind: "model", actionId: "compressor-model", filter: "compressor" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "max-steps",
      categoryId: "models-reasoning",
      label: "Maximale Tool-Schritte",
      description: "Begrenzt die Werkzeugschritte eines einzelnen Agentenlaufs",
      aliases: ["schritte", "steps", "werkzeuge"],
      displayValue: String(config.maxSteps),
      editor: { kind: "number", actionId: "max-steps", minimum: 1, maximum: 100 },
      affectsActiveRun: true,
    }),
  ];
}

function providerItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const result: SettingsItem[] = [
    item(snapshot, {
      id: "provider-setup",
      categoryId: "providers-accounts",
      label: "Anbieter einrichten",
      description: "Geschützten Einrichtungsdialog für unterstützte Anbieter öffnen",
      aliases: ["setup", "verbinden", "konto"],
      displayValue: "Öffnen",
      editor: { kind: "invoke", actionId: "provider-setup" },
      affectsActiveRun: true,
    }),
  ];
  for (const provider of orderedProviders(snapshot.providers)) {
    result.push(item(snapshot, {
      id: `provider-status:${provider.backendId}`,
      categoryId: "providers-accounts",
      label: provider.displayName,
      description: "Sicherer Anbieterstatus mit Reifegrad, Aktivierung, Zustand und Abrechnungsart",
      aliases: providerAliases(provider.backendId),
      displayValue: providerStatusDisplay(provider),
      editor: READONLY_EDITOR,
      affectsActiveRun: false,
    }));
    if (provider.backendId === "anthropic"
      || provider.availability === "coming-soon"
      || provider.maturity === "coming-soon") continue;
    const allowed = new Set(provider.allowedActions);
    for (const action of PROVIDER_ACTION_ORDER) {
      if (!allowed.has(action)) continue;
      const definition = providerActionDefinition(action);
      result.push(item(snapshot, {
        id: `provider-action:${provider.backendId}:${action}`,
        categoryId: "providers-accounts",
        label: `${provider.displayName}: ${definition.label}`,
        description: `${definition.description} (${provider.displayName})`,
        aliases: [provider.backendId, action, definition.label],
        displayValue: "Ausführen",
        editor: { kind: "invoke", actionId: definition.actionId },
        affectsActiveRun: true,
      }));
    }
  }
  result.push(
    item(snapshot, {
      id: "provider-sort",
      categoryId: "providers-accounts",
      label: "OpenRouter-Sortierung",
      description: "Provider nach Preis, Durchsatz oder Latenz bevorzugen",
      aliases: ["sort", "preis", "latenz", "durchsatz"],
      displayValue: providerSortLabel(snapshot.config.provider.sort),
      editor: { kind: "choice", actionId: "provider-sort", options: PROVIDER_SORT_CHOICES },
      affectsActiveRun: true,
    }),
    ...privacyItems(snapshot, "providers-accounts", false),
    item(snapshot, {
      id: "provider-fallback",
      categoryId: "providers-accounts",
      label: "OpenRouter-Provider-Fallback",
      description: "OpenRouter darf für dasselbe Modell einen Ersatzprovider verwenden",
      aliases: ["provider fallback", "backup provider"],
      displayValue: optionalBooleanLabel(snapshot.config.provider.allowFallbacks),
      editor: { kind: "choice", actionId: "provider-fallback", options: ON_OFF_CHOICES },
      affectsActiveRun: true,
    }),
  );
  return result;
}

function securityItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const rules = orderedRules(snapshot.approvalRules);
  const result: SettingsItem[] = [
    item(snapshot, {
      id: "approval-mode",
      categoryId: "security-approvals",
      label: "Freigabemodus",
      description: "Legt fest, welche Werkzeugaktionen eine ausdrückliche Bestätigung brauchen",
      aliases: ["approval", "berechtigung", "sicherheit"],
      displayValue: approvalModeLabel(snapshot.config.approvalMode),
      editor: { kind: "choice", actionId: "approval-mode", options: APPROVAL_CHOICES },
      affectsActiveRun: true,
    }),
  ];
  for (const rule of rules) {
    const anchor = ruleAnchor(rule.id);
    result.push(
      item(snapshot, {
        id: `approval-rule:${rule.id}`,
        categoryId: "security-approvals",
        label: `Gemerkte Regel · ${anchor}`,
        description: "Read-only Ansicht einer lokal gemerkten Werkzeugfreigabe",
        aliases: ["regel", "remembered", anchor],
        displayValue: `${rule.decision === "allow" ? "Erlauben" : "Ablehnen"} · Regel ${anchor}`,
        editor: READONLY_EDITOR,
        affectsActiveRun: false,
      }),
      item(snapshot, {
        id: `approval-forget:${rule.id}`,
        categoryId: "security-approvals",
        label: `Regel vergessen · ${anchor}`,
        description: "Diese gemerkte Werkzeugfreigabe nach Bestätigung entfernen",
        aliases: ["regel löschen", "forget", anchor],
        displayValue: `Regel ${anchor}`,
        editor: { kind: "confirm", actionId: "approval-forget", destructive: true },
        affectsActiveRun: true,
      }),
    );
  }
  result.push(
    item(snapshot, {
      id: "approval-forget-all",
      categoryId: "security-approvals",
      label: "Alle Regeln vergessen",
      description: "Alle gemerkten Werkzeugfreigaben dieses Workspace nach Bestätigung entfernen",
      aliases: ["regeln löschen", "forget all"],
      displayValue: `${rules.length} Regel(n)`,
      editor: { kind: "confirm", actionId: "approval-forget-all", destructive: true },
      affectsActiveRun: true,
      ...(rules.length === 0 ? { disabledReason: "Keine gemerkten Regeln" } : {}),
    }),
    ...privacyItems(snapshot, "security-approvals", true),
  );
  return result;
}

function privacyItems(
  snapshot: SettingsAuthoritativeSnapshot,
  categoryId: "providers-accounts" | "security-approvals",
  securityIds: boolean,
): SettingsItem[] {
  const provider = snapshot.config.provider;
  return [
    item(snapshot, {
      id: securityIds ? "security-provider-data-collection" : "provider-data-collection",
      categoryId,
      label: "OpenRouter-Datenweitergabe",
      description: "Legt fest, ob OpenRouter Provider mit Datenweitergabe verwenden darf",
      aliases: ["datenschutz", "privacy", "data collection"],
      displayValue: provider.dataCollection === "allow" ? "Erlauben" : "Ablehnen",
      editor: { kind: "choice", actionId: "provider-data-collection", options: DATA_COLLECTION_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: securityIds ? "security-provider-only" : "provider-only",
      categoryId,
      label: "Nur diese OpenRouter-Provider",
      description: "Ausführung auf eine ausdrücklich erlaubte Providerliste begrenzen",
      aliases: ["allowlist", "only", "provider liste"],
      displayValue: stringListLabel(provider.only),
      editor: { kind: "text", actionId: "provider-only", valueKind: "provider-list" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: securityIds ? "security-provider-ignore" : "provider-ignore",
      categoryId,
      label: "OpenRouter-Provider ignorieren",
      description: "Ausdrücklich ausgeschlossene Provider bei der Auswahl überspringen",
      aliases: ["denylist", "ignore", "provider ausschließen"],
      displayValue: stringListLabel(provider.ignore),
      editor: { kind: "text", actionId: "provider-ignore", valueKind: "provider-list" },
      affectsActiveRun: true,
    }),
  ];
}

function costItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  return [
    item(snapshot, {
      id: "max-cost",
      categoryId: "costs-budgets",
      label: "Kostenlimit pro Hauptlauf",
      description: "Maximale geschätzte Hauptmodellkosten eines Laufs in USD",
      aliases: ["kosten", "max cost", "lauf limit"],
      displayValue: formatUsd(config.maxCostUsd),
      editor: { kind: "number", actionId: "max-cost", minimum: 0.001, maximum: 1_000, unit: "USD" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "compressor-max-cost",
      categoryId: "costs-budgets",
      label: "Kostenlimit pro Kompression",
      description: "Maximale geschätzte Kompressormodellkosten in USD",
      aliases: ["kompressor kosten", "compressor limit"],
      displayValue: formatUsd(config.compressorMaxCostUsd),
      editor: { kind: "number", actionId: "compressor-max-cost", minimum: 0.001, maximum: 100, unit: "USD" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "budget-daily",
      categoryId: "costs-budgets",
      label: "Tagesbudget",
      description: "Workspace-Kostenlimit pro Tag oder ausgeschaltet",
      aliases: ["budget", "tag", "daily"],
      displayValue: optionalUsd(config.budget.dailyLimitUsd),
      editor: { kind: "number", actionId: "budget-daily", minimum: 0.01, maximum: 100_000, allowOff: true, unit: "USD" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "budget-total",
      categoryId: "costs-budgets",
      label: "Gesamtbudget",
      description: "Kumuliertes Workspace-Kostenlimit oder ausgeschaltet",
      aliases: ["gesamtbudget", "total budget"],
      displayValue: optionalUsd(config.budget.totalLimitUsd),
      editor: { kind: "number", actionId: "budget-total", minimum: 0.01, maximum: 100_000, allowOff: true, unit: "USD" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "budget-on-exceed",
      categoryId: "costs-budgets",
      label: "Bei Budgetüberschreitung",
      description: "Neue Läufe nach Überschreitung warnen oder blockieren",
      aliases: ["budget aktion", "warn", "block"],
      displayValue: config.budget.onExceed === "block" ? "Blockieren" : "Warnen",
      editor: { kind: "choice", actionId: "budget-on-exceed", options: BUDGET_ACTION_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "cost-summary",
      categoryId: "costs-budgets",
      label: "Aktueller Kostenstand",
      description: "Read-only Kostenstand für Sitzung, Tag und Workspace",
      aliases: ["kostenstand", "verbrauch", "spend"],
      displayValue: costSummary(snapshot.costs),
      editor: READONLY_EDITOR,
      affectsActiveRun: false,
    }),
  ];
}

function toolItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  return [
    item(snapshot, {
      id: "verify-mode",
      categoryId: "verify-tools",
      label: "Prüfmodus",
      description: "Automatische Prüfungen nach Dateiänderungen ein- oder ausschalten",
      aliases: ["prüfen", "verify", "check"],
      displayValue: config.verify.mode === "on-edit" ? "Nach Änderungen" : "Aus",
      editor: { kind: "choice", actionId: "verify-mode", options: VERIFY_MODE_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "verify-commands",
      categoryId: "verify-tools",
      label: "Prüfkommandos",
      description: "Geordnete lokale Kommandos für die automatische Prüfung bearbeiten",
      aliases: ["commands", "tests", "build"],
      displayValue: config.verify.commands.length > 0 ? config.verify.commands.join(" · ") : "Keine",
      editor: { kind: "text", actionId: "verify-commands", valueKind: "command-list" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "verify-suggest",
      categoryId: "verify-tools",
      label: "Prüfkommandos vorschlagen",
      description: "Geeignete Workspace-Kommandos aus vorhandenen Projektskripten ableiten",
      aliases: ["suggest", "package scripts", "empfehlen"],
      displayValue: "Ausführen",
      editor: { kind: "invoke", actionId: "verify-suggest" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "verify-clear",
      categoryId: "verify-tools",
      label: "Prüfkommandos leeren",
      description: "Alle konfigurierten Prüfkommandos nach Bestätigung entfernen",
      aliases: ["clear", "tests löschen"],
      displayValue: `${config.verify.commands.length} Kommando(s)`,
      editor: { kind: "confirm", actionId: "verify-clear", destructive: true },
      affectsActiveRun: true,
      ...(config.verify.commands.length === 0 ? { disabledReason: "Keine Prüfkommandos" } : {}),
    }),
    item(snapshot, {
      id: "verify-repair-rounds",
      categoryId: "verify-tools",
      label: "Reparaturrunden",
      description: "Zusätzliche Modellrunden nach einer fehlgeschlagenen Prüfung begrenzen",
      aliases: ["repair", "runden", "retry"],
      displayValue: String(config.verify.maxRepairRounds),
      editor: { kind: "number", actionId: "verify-repair-rounds", minimum: 0, maximum: 2 },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "web-mode",
      categoryId: "verify-tools",
      label: "Webmodus",
      description: "Verfügbarkeit des Webwerkzeugs für Agentenläufe steuern",
      aliases: ["web", "internet", "browse"],
      displayValue: webModeLabel(config.web),
      editor: { kind: "choice", actionId: "web-mode", options: WEB_MODE_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "browser-path",
      categoryId: "verify-tools",
      label: "Browserpfad",
      description: "Expliziten Pfad zu Chrome, Chromium, Edge oder Brave setzen",
      aliases: ["browser", "chrome", "executable", "pfad"],
      displayValue: config.browserPath || "Automatisch suchen",
      editor: { kind: "text", actionId: "browser-path", valueKind: "path" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "browser-timeout",
      categoryId: "verify-tools",
      label: "Browser-Zeitlimit",
      description: "Browser-Start und Seitenprüfung nach einer festen Dauer abbrechen",
      aliases: ["browser timeout", "zeitlimit", "start"],
      displayValue: `${config.browserTimeoutSeconds} s`,
      editor: { kind: "number", actionId: "browser-timeout", minimum: 1, maximum: 120, unit: "s" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "panel-models",
      categoryId: "verify-tools",
      label: "Panel-Modelle",
      description: "Zwei bis fünf Modelle für parallele Antwortvergleiche auswählen",
      aliases: ["panel", "vergleich", "mehrere modelle"],
      displayValue: config.panelModels.length > 0
        ? config.panelModels.map((id) => modelDisplay(snapshot.cachedModels, id)).join(" · ")
        : "Nicht gesetzt",
      editor: { kind: "model", actionId: "panel-models", filter: "panel", multiple: true },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "panel-judge",
      categoryId: "verify-tools",
      label: "Panel-Richter",
      description: "Eine zusätzliche Modellrunde zur Synthese der Panelantworten verwenden",
      aliases: ["judge", "richter", "synthese"],
      displayValue: booleanLabel(config.panelJudge),
      editor: { kind: "choice", actionId: "panel-judge", options: ON_OFF_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "transcription-model",
      categoryId: "verify-tools",
      label: "Transkriptionsmodell",
      description: "Audioeingabefähiges Modell für Sprachaufnahmen auswählen",
      aliases: ["voice", "audio", "whisper", "transkription"],
      displayValue: modelDisplay(snapshot.cachedModels, config.transcriptionModel),
      editor: { kind: "model", actionId: "transcription-model", filter: "audio-input" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "voice-consent-status",
      categoryId: "verify-tools",
      label: "Sprachfreigabe",
      description: "Read-only Status der ausdrücklich erteilten Aufnahmeübermittlung",
      aliases: ["voice consent", "mikrofon", "aufnahme"],
      displayValue: config.voiceConsentGiven ? "Erteilt" : "Nicht erteilt",
      editor: READONLY_EDITOR,
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "voice-consent-clear",
      categoryId: "verify-tools",
      label: "Sprachfreigabe zurücksetzen",
      description: "Gespeicherte Sprachfreigabe nach Bestätigung entfernen; eine neue Freigabe erfolgt nur im Sprachfluss",
      aliases: ["voice consent clear", "mikrofon zurücksetzen"],
      displayValue: config.voiceConsentGiven ? "Zurücksetzen" : "Nicht erteilt",
      editor: { kind: "confirm", actionId: "voice-consent-clear", destructive: true },
      affectsActiveRun: true,
      ...(!config.voiceConsentGiven ? { disabledReason: "Keine Sprachfreigabe gespeichert" } : {}),
    }),
  ];
}

function appearanceItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const appearance = snapshot.config.appearance;
  return [
    item(snapshot, {
      id: "appearance-large-logo",
      categoryId: "appearance",
      label: "Großes Route-Core-Logo",
      description: "Großes Route-Core-Zeichen auf Startseite und Settings anzeigen",
      aliases: ["logo", "route core", "start"],
      displayValue: booleanLabel(appearance.showLargeLogo),
      editor: { kind: "choice", actionId: "appearance-large-logo", options: ON_OFF_CHOICES },
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "appearance-header-mark",
      categoryId: "appearance",
      label: "Kompaktes Header-Zeichen",
      description: "Kompakte Route-Core-Marke im normalen Chatheader anzeigen",
      aliases: ["header", "marke", "compact"],
      displayValue: booleanLabel(appearance.showHeaderMark),
      editor: { kind: "choice", actionId: "appearance-header-mark", options: ON_OFF_CHOICES },
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "appearance-glyph-mode",
      categoryId: "appearance",
      label: "Zeichenmodus",
      description: "Terminalzeichen automatisch wählen oder Unicode beziehungsweise ASCII erzwingen",
      aliases: ["ascii", "unicode", "glyph", "zeichen"],
      displayValue: appearance.glyphMode === "ascii"
        ? "ASCII"
        : appearance.glyphMode === "unicode"
          ? "Unicode"
          : "Automatisch",
      editor: { kind: "choice", actionId: "appearance-glyph-mode", options: GLYPH_MODE_CHOICES },
      affectsActiveRun: false,
    }),
  ];
}

function item(snapshot: SettingsAuthoritativeSnapshot, input: ItemInput): SettingsItem {
  const editor = freezeEditor(input.editor);
  const disabledReason = snapshot.runActive
    && input.affectsActiveRun
    && editor.kind !== "readonly"
    ? "Lauf aktiv"
    : input.disabledReason;
  return Object.freeze({
    id: input.id,
    categoryId: input.categoryId,
    label: input.label,
    description: input.description,
    aliases: Object.freeze([...(input.aliases ?? [])]),
    displayValue: input.displayValue,
    editor,
    affectsActiveRun: input.affectsActiveRun,
    ...(disabledReason ? { disabledReason } : {}),
  });
}

function freezeEditor(editor: SettingsEditorDescriptor): SettingsEditorDescriptor {
  switch (editor.kind) {
    case "choice":
      return Object.freeze({
        ...editor,
        options: Object.freeze(editor.options.map((option) => Object.freeze({ ...option }))),
      });
    case "model":
    case "number":
    case "text":
    case "confirm":
    case "invoke":
    case "readonly":
      return Object.freeze({ ...editor });
    default:
      return assertNever(editor);
  }
}

function providerActionDefinition(action: ProviderBackendAction): {
  readonly actionId: SettingsActionId;
  readonly label: string;
  readonly description: string;
} {
  switch (action) {
    case "connect":
      return { actionId: "provider-connect", label: "Verbinden", description: "Anbieter über den geschützten Einrichtungsfluss verbinden" };
    case "enable":
      return { actionId: "provider-enable", label: "Aktivieren", description: "Vorhandene Anbieterverbindung aktivieren" };
    case "disable":
      return { actionId: "provider-disable", label: "Deaktivieren", description: "Anbieterverbindung nach bestehender Bestätigungsregel deaktivieren" };
    case "disconnect":
      return { actionId: "provider-disconnect", label: "Trennen", description: "Anbieterverbindung nach bestehender Bestätigungsregel trennen" };
    case "reconnect":
      return { actionId: "provider-reconnect", label: "Neu verbinden", description: "Anbieterzustand erneut prüfen und verbinden" };
    case "models":
      return { actionId: "provider-models", label: "Modelle aktualisieren", description: "Verfügbaren Modellkatalog dieses Anbieters aktualisieren" };
    case "logout":
      return { actionId: "provider-logout", label: "Abmelden", description: "Lokale Anbieteranmeldung nach bestehender Bestätigungsregel entfernen" };
    default:
      return assertNever(action);
  }
}

function orderedProviders(
  providers: readonly SettingsProviderProjection[],
): SettingsProviderProjection[] {
  const byBackend = new Map<ProviderCommandBackendId, SettingsProviderProjection>();
  for (const provider of providers) {
    if (byBackend.has(provider.backendId)) {
      throw new Error("Settings-Anbieterprojektion ist ungültig.");
    }
    byBackend.set(provider.backendId, provider);
  }
  return PROVIDER_BACKEND_ORDER
    .map((backendId) => byBackend.get(backendId))
    .filter((provider): provider is SettingsProviderProjection => provider !== undefined);
}

function orderedRules(
  rules: readonly SettingsApprovalRuleProjection[],
): SettingsApprovalRuleProjection[] {
  const byId = new Map<string, SettingsApprovalRuleProjection>();
  for (const rule of rules) {
    if (!CANONICAL_RULE_ID.test(rule.id)
      || (rule.decision !== "allow" && rule.decision !== "deny")
      || byId.has(rule.id)) {
      throw new Error("Settings-Regelprojektion ist ungültig.");
    }
    byId.set(rule.id, { id: rule.id, decision: rule.decision });
  }
  return [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

const CANONICAL_RULE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ruleAnchor(id: string): string {
  return id.slice(0, 8);
}

function findModel(models: readonly ModelInfo[], id: string): ModelInfo | null {
  return models.find((model) => model.id === id || model.canonicalSlug === id) ?? null;
}

function modelDisplay(models: readonly ModelInfo[], id: string): string {
  const model = findModel(models, id);
  return model && model.name !== id ? `${model.name} · ${id}` : id;
}

function routeDisplay(route: SettingsRouteProjection | null): string {
  if (!route) return "Keine aktive Route";
  const resolved = route.requestedModelId === route.canonicalModelId
    ? route.requestedModelId
    : `${route.requestedModelId} → ${route.canonicalModelId}`;
  return `${route.modelLabel} · ${route.providerLabel} · ${resolved}`;
}

function providerStatusDisplay(provider: SettingsProviderProjection): string {
  if (provider.backendId === "anthropic"
    || provider.availability === "coming-soon"
    || provider.maturity === "coming-soon") return "Coming soon";
  const configuration = provider.configuration === "enabled" ? "Aktiv" : "Inaktiv";
  const maturity = provider.maturity === "stable" ? "Stable" : "Preview";
  const defaultLabel = provider.isDefault ? " · Standardroute" : "";
  const selected = provider.selectedModel ? ` · ${provider.selectedModel.displayName}` : "";
  return `${configuration} · ${maturity} · ${billingRealmLabel(provider.billingRealm)} · ${headlineLabel(provider.headline)}${defaultLabel}${selected}`;
}

function billingRealmLabel(billingRealm: SettingsProviderProjection["billingRealm"]): string {
  switch (billingRealm) {
    case "openrouter-payg":
      return "API Pay-as-you-go";
    case "kimi-code-membership-provider-managed-overage":
      return "Abo · providerverwaltet";
    case "none":
      return "Keine Abrechnung";
    default:
      return assertNever(billingRealm);
  }
}

function headlineLabel(headline: SettingsProviderHeadline | null): string {
  switch (headline) {
    case "ready":
      return "Bereit";
    case "login-required":
      return "Anmeldung nötig";
    case "auth-rejected":
      return "Anmeldung abgelehnt";
    case "credential-expired":
      return "Anmeldung abgelaufen";
    case "offline":
      return "Offline";
    case "limit-reached":
      return "Providerlimit erreicht";
    case "runtime-missing":
      return "Laufzeit fehlt";
    case "incompatible-runtime":
      return "Laufzeit inkompatibel";
    case "policy-unavailable":
      return "Richtlinie nicht verfügbar";
    case "unknown":
    case null:
      return "Nicht geprüft";
    default:
      return assertNever(headline);
  }
}

function providerAliases(backendId: ProviderCommandBackendId): readonly string[] {
  switch (backendId) {
    case "openrouter":
      return ["openrouter", "api", "payg"];
    case "kimi-code":
      return ["kimi", "kimi code", "abo", "membership"];
    case "anthropic":
      return ["anthropic", "claude"];
    default:
      return assertNever(backendId);
  }
}

function providerSortLabel(value: OrcodeConfigWithBudget["provider"]["sort"]): string {
  switch (value) {
    case "price":
      return "Preis";
    case "throughput":
      return "Durchsatz";
    case "latency":
      return "Latenz";
    case undefined:
      return "Aus";
    default:
      return assertNever(value);
  }
}

function compressionModeLabel(value: OrcodeConfigWithBudget["compressionMode"]): string {
  switch (value) {
    case "off":
      return "Aus";
    case "auto":
      return "Automatisch";
    case "always":
      return "Immer";
    default:
      return assertNever(value);
  }
}

function approvalModeLabel(value: OrcodeConfigWithBudget["approvalMode"]): string {
  switch (value) {
    case "read-only":
      return "Nur lesen";
    case "ask":
      return "Nachfragen";
    case "auto-edit":
      return "Änderungen automatisch";
    case "allow-all":
      return "Alles erlauben";
    default:
      return assertNever(value);
  }
}

function webModeLabel(value: OrcodeConfigWithBudget["web"]): string {
  switch (value) {
    case "on":
      return "An";
    case "off":
      return "Aus";
    case "auto":
      return "Automatisch";
    default:
      return assertNever(value);
  }
}

function booleanLabel(value: boolean): string {
  return value ? "An" : "Aus";
}

function optionalBooleanLabel(value: boolean | undefined): string {
  return value === undefined ? "Automatisch" : booleanLabel(value);
}

function optionalUsd(value: number | null): string {
  return value === null ? "Aus" : formatUsd(value);
}

function stringListLabel(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "Keine Einschränkung";
}

function costSummary(costs: SettingsCostProjection): string {
  if (costs.costKnowledge === "unknown") {
    return "Kosten unbekannt · providerverwaltet";
  }
  return `Sitzung ${formatUsd(costs.sessionUsd)} · Tag ${formatUsd(costs.dayUsd)} · Gesamt ${formatUsd(costs.totalUsd)}`;
}

function searchScore(item: SettingsItem, query: string): number | null {
  let best: number | null = null;
  const fields = [item.label, item.description, ...item.aliases, item.displayValue];
  for (const field of fields) {
    const normalized = normalizeSearchText(field);
    const score = normalized === query
      ? 0
      : normalized.startsWith(query)
        ? 1
        : normalized.includes(query)
          ? 2
          : null;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function assertNever(value: never): never {
  throw new Error(`Nicht erreichbarer Settings-Wert: ${String(value)}`);
}
