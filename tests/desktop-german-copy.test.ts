import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_ACTIVITY_COPY,
  DESKTOP_COMMAND_DISABLED_COPY,
  DESKTOP_DISABLED_COPY,
  DESKTOP_SETTINGS_DISABLED_COPY,
  DESKTOP_SETTINGS_NOTICE_COPY,
  DESKTOP_SETTINGS_RAW_DISABLED_REASONS,
  DesktopSettingsProjectionError,
  DESKTOP_SETTINGS_STATIC_ROW_IDS,
  mapSettingsDisabledReason,
  projectGermanSettingsEditor,
  projectGermanSettingsRow,
} from "../src/desktop-german-copy.js";
import type { SettingsItem } from "../src/settings-registry.js";
import { buildSettingsRegistry, type SettingsAuthoritativeSnapshot } from "../src/settings-registry.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  SETTINGS_READ_ONLY_REASONS,
  projectSettingsDesktopRowTruth,
  projectSettingsConfig,
  type SettingsControllerSnapshot,
  type SettingsDesktopEditorSchema,
  type SettingsDesktopProjectionItem,
  type SettingsDesktopRowTruth,
  type SettingsEditorRequest,
} from "../src/settings-controller.js";
import { DesktopSettingsController, type DesktopSettingsCorePort } from "../src/desktop-settings.js";
import type { ModelInfo } from "../src/types.js";

const RULE_V1_ALLOW = "11111111-1111-1111-8111-111111111111";
const RULE_V1_DENY = "11111111-1111-1222-9222-111111111112";
const RULE_V7_ALLOW = "77777777-7777-7111-a777-777777777771";
const RULE_V7_DENY = "77777777-7777-7777-8777-777777777777";
const RULE_V8_ALLOW = "88888888-8888-8888-a888-888888888888";
const RULE_V8_DENY = "88888888-8888-8222-b888-888888888882";

test("ordinary editor projection closes Registry authority behind German handles", () => {
  const requests: SettingsEditorRequest[] = [
    {
      generation: 7, categoryId: "approvals-costs", itemId: "approval-mode",
      label: "PRIVATE RAW APPROVAL LABEL", description: "PRIVATE RAW DESCRIPTION",
      editor: { kind: "choice", actionId: "approval-mode", options: [
        { value: "ask", label: "RAW ASK", description: "RAW ASK DESCRIPTION" },
        { value: "allow-all", label: "RAW ALLOW", description: "RAW ALLOW DESCRIPTION" },
      ] },
      initialValue: "ask",
    },
    {
      generation: 8, categoryId: "approvals-costs", itemId: "max-steps",
      label: "PRIVATE RAW NUMBER", description: "PRIVATE RAW DESCRIPTION",
      editor: { kind: "number", actionId: "max-steps", minimum: 1, maximum: 100 },
      initialValue: 42, validationMessage: "PRIVATE RAW VALIDATION",
    },
    {
      generation: 9, categoryId: "tools", itemId: "browser-path",
      label: "PRIVATE RAW PATH", description: "PRIVATE RAW DESCRIPTION",
      editor: { kind: "text", actionId: "browser-path", valueKind: "path" },
      initialValue: "/Applications/Browser.app",
    },
    {
      generation: 10, categoryId: "tools", itemId: "verify-clear",
      label: "PRIVATE RAW CONFIRM", description: "PRIVATE RAW DESCRIPTION",
      editor: { kind: "confirm", actionId: "verify-clear", destructive: true },
      initialValue: false,
    },
    {
      generation: 11, categoryId: "tools", itemId: "verify-suggest",
      label: "PRIVATE RAW INVOKE", description: "PRIVATE RAW DESCRIPTION",
      editor: { kind: "invoke", actionId: "verify-suggest" },
    },
  ];

  const projected = requests.map((request, index) =>
    projectGermanSettingsEditor(request, `opaque-editor-${index}`));
  assert.deepEqual(projected.map(({ editor }) => editor.kind), ["choice", "number", "text", "confirm", "invoke"]);
  const wire = JSON.stringify(projected.map(({ editor }) => editor));
  assert.doesNotMatch(wire, /PRIVATE RAW|actionId|categoryId|itemId|validationMessage|generation/);
  assert.match(wire, /Freigabemodus/);
  assert.match(wire, /Aktionen pro Lauf/);
  assert.match(wire, /Browserpfad/);
  assert.match(wire, /Prüf-Befehle löschen/);
  assert.match(wire, /Prüf-Befehle vorschlagen/);

  const choice = projected[0]!;
  assert.equal(choice.editor.kind, "choice");
  const allow = choice.editor.kind === "choice" ? choice.editor.options[1]! : assert.fail();
  assert.deepEqual(choice.resolve({ kind: "choice", optionHandle: allow.handle }), { kind: "value", value: "allow-all" });
  assert.deepEqual(choice.resolve({ kind: "choice", optionHandle: "forged" }), { kind: "cancel" });
  assert.deepEqual(projected[1]!.resolve({ kind: "number", value: "60" }), { kind: "value", value: "60" });
  assert.deepEqual(projected[2]!.resolve({ kind: "text", value: "/tmp/browser" }), { kind: "value", value: "/tmp/browser" });
  assert.deepEqual(projected[3]!.resolve({ kind: "confirm", accepted: true }), { kind: "value", value: true });
  assert.deepEqual(projected[4]!.resolve({ kind: "invoke" }), { kind: "value", value: true });
});
const ALL_OPENROUTER_ACTIONS = ["connect", "enable", "disable", "disconnect", "reconnect", "models", "logout"] as const;
const ALL_KIMI_ACTIONS = ["connect", "enable", "disable", "reconnect", "models", "logout"] as const;
const EXPECTED_RAW_REASON_PRESENTATIONS = {
  "Run active": { code: "run-active", label: "Während eines Laufs gesperrt.", recoveryLabel: "Lauf zuerst beenden" },
  "Cross is unavailable": { code: "cross-unavailable", label: "Cross ist nicht verfügbar.", recoveryLabel: "Cross-Konfiguration prüfen" },
  "Cross is not available in this runtime": { code: "cross-unavailable", label: "Cross ist nicht verfügbar.", recoveryLabel: "Cross-Konfiguration prüfen" },
  "Cross is unavailable on Kimi Code routes": { code: "cross-unavailable", label: "Cross ist nicht verfügbar.", recoveryLabel: "Cross-Konfiguration prüfen" },
  "No provider is connected — run /provider setup first": { code: "provider-not-connected", label: "Anbieter ist nicht verbunden.", recoveryLabel: "Konto verbinden" },
  "Choose a model first": { code: "cross-role-unset", label: "Cross-Modell fehlt.", recoveryLabel: "Modell wählen" },
  "Both roles must be set before swapping": { code: "cross-swap-incomplete", label: "Beide Cross-Modelle werden benötigt.", recoveryLabel: "Beide Modelle wählen" },
  "Kimi Code doesn't support this external model role; an OpenRouter route is required": { code: "external-model-role-unsupported", label: "Dieses Konto unterstützt die Modellrolle nicht.", recoveryLabel: "OpenRouter-Modell wählen" },
  "Architect is unavailable on Kimi Code routes": { code: "architect-unavailable", label: "Architect ist für diese Route nicht verfügbar.", recoveryLabel: "Kompatible Route wählen" },
  "No remembered rules": { code: "no-remembered-rules", label: "Keine gemerkten Regeln vorhanden." },
  "No verify commands": { code: "no-verify-commands", label: "Keine Prüf-Befehle vorhanden." },
  "No voice consent stored": { code: "voice-consent-required", label: "Keine Sprachfreigabe gespeichert.", recoveryLabel: "Sprachfunktion erneut öffnen" },
  "Model catalog not available": { code: "model-catalog-unavailable", label: "Modellkatalog ist nicht verfügbar.", recoveryLabel: "Modelle neu laden" },
  "Model doesn't support reasoning": { code: "model-reasoning-unsupported", label: "Modell unterstützt diesen Denkmodus nicht.", recoveryLabel: "Anderen Modus wählen" },
  "Another orcode changed the config. Restart to adopt it.": { code: "config-changed-restart", label: "Konfiguration wurde außerhalb geändert.", recoveryLabel: "orcode neu starten" },
  "The config could not be read. Fix it, then restart.": { code: "config-unreadable", label: "Konfiguration kann nicht gelesen werden.", recoveryLabel: "Datei reparieren und neu starten" },
  "Restart orcode before changing settings again.": { code: "restart-required", label: "Neustart ist erforderlich.", recoveryLabel: "orcode neu starten" },
} as const;

function catalogModel(id: string, reasoning = true, audio = false): ModelInfo {
  return {
    id, name: id, description: "matrix model", contextLength: 128_000,
    promptPrice: 0, completionPrice: 0,
    supportedParameters: reasoning ? ["tools", "reasoning"] : ["tools"],
    inputModalities: audio ? ["text", "audio"] : ["text"], outputModalities: ["text"],
    ...(reasoning ? { reasoning: { mandatory: false, supportedEfforts: ["low", "medium", "high"], supportsMaxTokens: true } } : {}),
  };
}

function richRegistrySnapshot(): SettingsAuthoritativeSnapshot {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "model/main";
  config.compressorModel = "model/compressor";
  config.compressionMode = "always";
  config.approvalMode = "allow-all";
  config.maxSteps = 42;
  config.maxCostUsd = 1.25;
  config.compressorMaxCostUsd = 0.5;
  config.transcriptionModel = "model/audio";
  config.voiceConsentGiven = true;
  config.budget = { dailyLimitUsd: 12.5, totalLimitUsd: 99, onExceed: "block" };
  config.provider = {
    sort: "latency", dataCollection: "allow", only: ["provider-a", "provider-b"],
    ignore: ["provider-z"], allowFallbacks: false,
  };
  config.web = "on";
  config.verify = { commands: ["npm test", "npm run build"], mode: "off", maxRepairRounds: 2 };
  config.panelModels = ["model/panel-a", "model/panel-b"];
  config.panelJudge = true;
  config.browserPath = "/Applications/Test Browser";
  config.browserTimeoutSeconds = 45;
  config.appearance = { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" };
  config.lowBalanceThresholdUsd = 2.5;
  config.architectExecutor = {
    version: 1, backendId: "openrouter", accountFingerprint: "matrix-account", billingRealm: "openrouter-payg",
    requestedModelId: "model/executor", canonicalModelId: "model/executor", resolutionState: "resolved",
  };
  const modelIds = [
    "model/main", "model/compressor", "model/lead", "model/challenger", "model/executor",
    "model/panel-a", "model/panel-b",
  ];
  return {
    config,
    runActive: false,
    route: {
      backendId: "openrouter", providerLabel: "OpenRouter", requestedModelId: "model/main",
      canonicalModelId: "model/main", modelLabel: "Matrix Main", billingRealm: "openrouter-payg",
    },
    routeRunnable: true,
    providers: [
      {
        backendId: "openrouter", displayName: "OpenRouter", availability: "connectable", configuration: "enabled",
        maturity: "stable", billingRealm: "openrouter-payg", headline: "ready",
        health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" },
        isDefault: true,
        selectedModel: { requestedModelId: "model/main", canonicalModelId: "matrix-private-canonical", displayName: "matrix private display" },
        allowedActions: ALL_OPENROUTER_ACTIONS,
      },
      {
        backendId: "kimi-code", displayName: "Kimi Code", availability: "connectable", configuration: "disabled",
        maturity: "preview", billingRealm: "kimi-code-membership-provider-managed-overage", headline: "offline",
        health: { credential: "login-required", connectivity: "offline", spend: "unknown", runtime: "not-applicable" },
        isDefault: false, selectedModel: null, allowedActions: ALL_KIMI_ACTIONS,
      },
      {
        backendId: "anthropic", displayName: "Anthropic", availability: "coming-soon", configuration: "not-connected",
        maturity: "coming-soon", billingRealm: "none", headline: null, health: null,
        isDefault: false, selectedModel: null, allowedActions: [],
      },
    ],
    approvalRules: [
      { id: RULE_V1_ALLOW, decision: "allow" },
      { id: RULE_V1_DENY, decision: "deny" },
      { id: RULE_V7_ALLOW, decision: "allow" },
      { id: RULE_V7_DENY, decision: "deny" },
      { id: RULE_V8_ALLOW, decision: "allow" },
      { id: RULE_V8_DENY, decision: "deny" },
    ],
    costs: { costKnowledge: "known", sessionUsd: 1.25, dayUsd: 2.5, totalUsd: 10 },
    cachedModels: [...modelIds.map((id) => catalogModel(id)), catalogModel("model/audio", false, true)],
    cross: {
      preferences: { lead: { requestedModelId: "model/lead" }, challenger: { requestedModelId: "model/challenger" } },
      available: true,
    },
  };
}

type MatrixExpectation = Readonly<Record<string, Readonly<{ displayValue: string; disabledReason: string | null }>>>;
type MatrixScenario = Readonly<{ name: string; snapshot: SettingsAuthoritativeSnapshot; expected: MatrixExpectation }>;

function scenario(
  name: string,
  mutate: (snapshot: SettingsAuthoritativeSnapshot) => void,
  expected: MatrixExpectation,
): MatrixScenario {
  const snapshot = structuredClone(richRegistrySnapshot());
  mutate(snapshot);
  return { name, snapshot, expected };
}

function reachableSettingsRegistryMatrix(): readonly MatrixScenario[] {
  return [
    scenario("idle-different-ready-present", () => {}, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: null },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: null },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: null },
      "reasoning": { displayValue: "Automatisch", disabledReason: null },
      "provider-status:openrouter": { displayValue: "Aktiviert · Stabil · Bereit · API-Nutzungsabrechnung · Standardroute · Modell model/main", disabledReason: null },
      "verify-clear": { displayValue: "2 Befehle", disabledReason: null },
      "voice-consent-clear": { displayValue: "Zurücksetzen", disabledReason: null },
    }),
    scenario("active", (snapshot) => { (snapshot as { runActive: boolean }).runActive = true; }, {
      "main-model": { displayValue: "Modell: model/main", disabledReason: "Run active" },
      "provider-action:openrouter:disconnect": { displayValue: "Aktion: Trennen", disabledReason: "Run active" },
      [`approval-forget:${RULE_V7_DENY}`]: { displayValue: "Regel löschen", disabledReason: "Run active" },
      "appearance-large-logo": { displayValue: "Aus", disabledReason: null },
    }),
    scenario("cross-unset", (snapshot) => {
      (snapshot.cross as { preferences: { lead: null; challenger: null } }).preferences = { lead: null, challenger: null };
    }, {
      "cross-lead-model": { displayValue: "Nicht festgelegt", disabledReason: null },
      "cross-challenger-model": { displayValue: "Nicht festgelegt", disabledReason: null },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Choose a model first" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Choose a model first" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Both roles must be set before swapping" },
    }),
    scenario("cross-lead-only", (snapshot) => {
      (snapshot.cross as { preferences: { lead: { requestedModelId: string }; challenger: null } }).preferences = {
        lead: { requestedModelId: "model/lead" }, challenger: null,
      };
    }, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: null },
      "cross-challenger-model": { displayValue: "Nicht festgelegt", disabledReason: null },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: null },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Choose a model first" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Both roles must be set before swapping" },
    }),
    scenario("cross-challenger-only", (snapshot) => {
      (snapshot.cross as { preferences: { lead: null; challenger: { requestedModelId: string } } }).preferences = {
        lead: null, challenger: { requestedModelId: "model/challenger" },
      };
    }, {
      "cross-lead-model": { displayValue: "Nicht festgelegt", disabledReason: null },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: null },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Choose a model first" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: null },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Both roles must be set before swapping" },
    }),
    scenario("cross-equal", (snapshot) => {
      (snapshot.cross as { preferences: { lead: { requestedModelId: string }; challenger: { requestedModelId: string } } }).preferences = {
        lead: { requestedModelId: "model/lead" }, challenger: { requestedModelId: "model/lead" },
      };
    }, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: null },
      "cross-challenger-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: null },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: null },
    }),
    scenario("cross-unavailable-runtime", (snapshot) => {
      (snapshot.cross as { available: boolean; unavailableReason?: string }).available = false;
      (snapshot.cross as { unavailableReason?: string }).unavailableReason = "Cross is not available in this runtime";
    }, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: "Cross is not available in this runtime" },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: "Cross is not available in this runtime" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Cross is not available in this runtime" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Cross is not available in this runtime" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Cross is not available in this runtime" },
    }),
    scenario("cross-unavailable-generic", (snapshot) => {
      (snapshot.cross as { available: boolean }).available = false;
    }, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: "Cross is unavailable" },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: "Cross is unavailable" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Cross is unavailable" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Cross is unavailable" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Cross is unavailable" },
    }),
    scenario("cross-unavailable-no-provider", (snapshot) => {
      (snapshot.cross as { available: boolean; unavailableReason?: string }).available = false;
      (snapshot.cross as { unavailableReason?: string }).unavailableReason = "No provider is connected — run /provider setup first";
    }, {
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: "No provider is connected — run /provider setup first" },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: "No provider is connected — run /provider setup first" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "No provider is connected — run /provider setup first" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "No provider is connected — run /provider setup first" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "No provider is connected — run /provider setup first" },
    }),
    scenario("catalog-missing", (snapshot) => { (snapshot as unknown as { cachedModels: ModelInfo[] }).cachedModels = []; }, {
      reasoning: { displayValue: "Automatisch", disabledReason: "Model catalog not available" },
      "reasoning-compressor": { displayValue: "Automatisch", disabledReason: "Model catalog not available" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Model catalog not available" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Model catalog not available" },
    }),
    scenario("catalog-present-no-reasoning", (snapshot) => {
      (snapshot as unknown as { cachedModels: ModelInfo[] }).cachedModels = snapshot.cachedModels.map((model) => catalogModel(model.id, false, model.id === "model/audio"));
    }, {
      reasoning: { displayValue: "Automatisch", disabledReason: "Model doesn't support reasoning" },
      "reasoning-compressor": { displayValue: "Automatisch", disabledReason: "Model doesn't support reasoning" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Model doesn't support reasoning" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Model doesn't support reasoning" },
    }),
    scenario("kimi-policy-gates", (snapshot) => {
      (snapshot as { route: SettingsAuthoritativeSnapshot["route"] }).route = {
        backendId: "kimi-code", providerLabel: "Kimi Code", requestedModelId: "model/main",
        canonicalModelId: "model/main", modelLabel: "Matrix Main", billingRealm: "kimi-code-membership-provider-managed-overage",
      };
      (snapshot.cross as { available: boolean; unavailableReason?: string }).available = false;
      (snapshot.cross as { unavailableReason?: string }).unavailableReason = "Cross is unavailable on Kimi Code routes";
    }, {
      "compressor-model": { displayValue: "Modell: model/compressor", disabledReason: "Kimi Code doesn't support this external model role; an OpenRouter route is required" },
      "cross-lead-model": { displayValue: "Modell: model/lead · vorgemerkt", disabledReason: "Cross is unavailable on Kimi Code routes" },
      "cross-challenger-model": { displayValue: "Modell: model/challenger · vorgemerkt", disabledReason: "Cross is unavailable on Kimi Code routes" },
      "reasoning-cross-lead": { displayValue: "Automatisch", disabledReason: "Cross is unavailable on Kimi Code routes" },
      "reasoning-cross-challenger": { displayValue: "Automatisch", disabledReason: "Cross is unavailable on Kimi Code routes" },
      "panel-models": { displayValue: "Modell: model/panel-a · model/panel-b", disabledReason: "Kimi Code doesn't support this external model role; an OpenRouter route is required" },
      "transcription-model": { displayValue: "Modell: model/audio", disabledReason: "Kimi Code doesn't support this external model role; an OpenRouter route is required" },
      "architect-executor-model": { displayValue: "Modell: model/executor", disabledReason: "Architect is unavailable on Kimi Code routes" },
      "cross-pair-swap": { displayValue: "Tauschen", disabledReason: "Cross is unavailable on Kimi Code routes" },
    }),
    scenario("rules-absent", (snapshot) => { (snapshot as unknown as { approvalRules: [] }).approvalRules = []; }, {
      "approval-forget-all": { displayValue: "0 Regeln", disabledReason: "No remembered rules" },
    }),
    scenario("verify-and-voice-absent", (snapshot) => {
      (snapshot.config.verify as { commands: string[] }).commands = [];
      (snapshot.config as { voiceConsentGiven: boolean }).voiceConsentGiven = false;
    }, {
      "verify-commands": { displayValue: "0 Befehle", disabledReason: null },
      "verify-clear": { displayValue: "0 Befehle", disabledReason: "No verify commands" },
      "voice-consent-status": { displayValue: "Nicht erteilt", disabledReason: null },
      "voice-consent-clear": { displayValue: "Nicht erteilt", disabledReason: "No voice consent stored" },
    }),
    scenario("provider-disconnected", (snapshot) => {
      const provider = snapshot.providers[0]! as { configuration: "not-connected"; headline: null; isDefault: boolean };
      provider.configuration = "not-connected"; provider.headline = null; provider.isDefault = false;
    }, {
      "provider-status:openrouter": { displayValue: "Nicht verbunden · Stabil · Nicht geprüft · API-Nutzungsabrechnung · Modell model/main", disabledReason: null },
    }),
    scenario("provider-degraded", (snapshot) => {
      const provider = snapshot.providers[0]! as { configuration: "enabled"; headline: "offline" };
      provider.configuration = "enabled"; provider.headline = "offline";
    }, {
      "provider-status:openrouter": { displayValue: "Aktiviert · Stabil · Offline · API-Nutzungsabrechnung · Standardroute · Modell model/main", disabledReason: null },
      "provider-action:openrouter:reconnect": { displayValue: "Aktion: Neu verbinden", disabledReason: null },
    }),
    scenario("appearance-on-auto", (snapshot) => {
      (snapshot.config as { appearance: { showLargeLogo: boolean; showHeaderMark: boolean; glyphMode: "auto" } }).appearance = {
        showLargeLogo: true, showHeaderMark: true, glyphMode: "auto",
      };
    }, {
      "appearance-large-logo": { displayValue: "Ein", disabledReason: null },
      "appearance-header-mark": { displayValue: "Ein", disabledReason: null },
      "appearance-glyph-mode": { displayValue: "Automatisch", disabledReason: null },
    }),
    scenario("appearance-off-unicode", (snapshot) => {
      (snapshot.config as { appearance: { showLargeLogo: boolean; showHeaderMark: boolean; glyphMode: "unicode" } }).appearance = {
        showLargeLogo: false, showHeaderMark: false, glyphMode: "unicode",
      };
    }, {
      "appearance-large-logo": { displayValue: "Aus", disabledReason: null },
      "appearance-header-mark": { displayValue: "Aus", disabledReason: null },
      "appearance-glyph-mode": { displayValue: "Unicode", disabledReason: null },
    }),
    scenario("appearance-mixed-ascii", (snapshot) => {
      (snapshot.config as { appearance: { showLargeLogo: boolean; showHeaderMark: boolean; glyphMode: "ascii" } }).appearance = {
        showLargeLogo: true, showHeaderMark: false, glyphMode: "ascii",
      };
    }, {
      "appearance-large-logo": { displayValue: "Ein", disabledReason: null },
      "appearance-header-mark": { displayValue: "Aus", disabledReason: null },
      "appearance-glyph-mode": { displayValue: "ASCII", disabledReason: null },
    }),
  ];
}

function project(item: SettingsItem, truth: SettingsDesktopRowTruth, handle = "h") {
  return projectGermanSettingsRow(item, handle, truth);
}

function narrowItem(item: SettingsItem): SettingsDesktopProjectionItem {
  let editor: SettingsDesktopEditorSchema;
  switch (item.editor.kind) {
    case "choice":
      editor = { kind: "choice", actionId: item.editor.actionId, values: item.editor.options.map(({ value }) => value) };
      break;
    case "model":
      editor = {
        kind: "model", actionId: item.editor.actionId, filter: item.editor.filter,
        ...(item.editor.multiple === true ? { multiple: true as const } : {}),
      };
      break;
    case "number":
      editor = {
        kind: "number", actionId: item.editor.actionId,
        minimum: item.editor.minimum, maximum: item.editor.maximum,
        ...(item.editor.unit !== undefined ? { unit: item.editor.unit } : {}),
        ...(item.editor.allowOff === true ? { allowOff: true as const } : {}),
      };
      break;
    case "text":
      editor = { kind: "text", actionId: item.editor.actionId, valueKind: item.editor.valueKind };
      break;
    case "confirm":
      editor = { kind: "confirm", actionId: item.editor.actionId, destructive: item.editor.destructive };
      break;
    case "invoke":
      editor = { kind: "invoke", actionId: item.editor.actionId };
      break;
    case "readonly":
      editor = { kind: "readonly" };
      break;
  }
  return {
    id: item.id, categoryId: item.categoryId, editor,
    ...(item.disabledReason !== undefined ? { disabledReason: item.disabledReason } : {}),
  };
}

const EXPECTED_STATIC_ROW_IDS = [
  "main-model", "reasoning", "compression-mode", "compressor-model", "reasoning-compressor",
  "cross-lead-model", "cross-challenger-model", "reasoning-cross-lead", "reasoning-cross-challenger",
  "cross-pair-swap", "architect-executor-model", "provider-setup", "provider-sort", "provider-fallback",
  "approval-mode", "approval-forget-all", "provider-data-collection", "provider-only", "provider-ignore",
  "max-cost", "max-steps", "compressor-max-cost", "budget-daily", "budget-total", "budget-on-exceed",
  "low-balance-threshold", "cost-summary", "verify-mode", "verify-commands", "verify-suggest", "verify-clear",
  "verify-repair-rounds", "web-mode", "browser-path", "browser-timeout", "panel-models", "panel-judge",
  "transcription-model", "voice-consent-status", "voice-consent-clear", "appearance-large-logo",
  "appearance-header-mark", "appearance-glyph-mode",
] as const;

const EXPECTED_DYNAMIC_ROW_IDS = [
  "provider-status:openrouter", "provider-action:openrouter:connect", "provider-action:openrouter:enable",
  "provider-action:openrouter:disable", "provider-action:openrouter:disconnect", "provider-action:openrouter:reconnect",
  "provider-action:openrouter:models", "provider-action:openrouter:logout", "provider-status:kimi-code",
  "provider-action:kimi-code:connect", "provider-action:kimi-code:enable", "provider-action:kimi-code:disable",
  "provider-action:kimi-code:reconnect", "provider-action:kimi-code:models", "provider-action:kimi-code:logout",
  "provider-status:anthropic",
  `approval-rule:${RULE_V1_ALLOW}`, `approval-forget:${RULE_V1_ALLOW}`,
  `approval-rule:${RULE_V1_DENY}`, `approval-forget:${RULE_V1_DENY}`,
  `approval-rule:${RULE_V7_ALLOW}`, `approval-forget:${RULE_V7_ALLOW}`,
  `approval-rule:${RULE_V7_DENY}`, `approval-forget:${RULE_V7_DENY}`,
  `approval-rule:${RULE_V8_ALLOW}`, `approval-forget:${RULE_V8_ALLOW}`,
  `approval-rule:${RULE_V8_DENY}`, `approval-forget:${RULE_V8_DENY}`,
] as const;

type ExactPresentation = Readonly<{
  label: string;
  description: string;
  displayValue: string;
  control: "readonly" | "choice" | "boolean" | "action" | "locked";
  booleanValue: boolean | null;
  actionLabel: string | null;
}>;

const EXPECTED_RICH_STATIC_PRESENTATION: Readonly<Record<(typeof EXPECTED_STATIC_ROW_IDS)[number], ExactPresentation>> = {
  "main-model": { label: "Hauptmodell", description: "Modell und aktive Sitzung gemeinsam wechseln", displayValue: "Modell: model/main", control: "choice", booleanValue: null, actionLabel: null },
  reasoning: { label: "Denken · Hauptmodell", description: "Denkmodus des Hauptmodells festlegen", displayValue: "Automatisch", control: "choice", booleanValue: null, actionLabel: null },
  "compression-mode": { label: "Lange Chats kürzen", description: "Automatische Zusammenfassung steuern", displayValue: "Immer", control: "choice", booleanValue: null, actionLabel: null },
  "compressor-model": { label: "Zusammenfassungsmodell", description: "Modell für lange Chats wählen", displayValue: "Modell: model/compressor", control: "choice", booleanValue: null, actionLabel: null },
  "reasoning-compressor": { label: "Denken · Zusammenfassung", description: "Denkmodus der Zusammenfassung festlegen", displayValue: "Automatisch", control: "choice", booleanValue: null, actionLabel: null },
  "cross-lead-model": { label: "Cross · Codemodell", description: "Schreibendes Cross-Modell wählen", displayValue: "Modell: model/lead · vorgemerkt", control: "choice", booleanValue: null, actionLabel: null },
  "cross-challenger-model": { label: "Cross · Prüfmodell", description: "Prüfendes Cross-Modell wählen", displayValue: "Modell: model/challenger · vorgemerkt", control: "choice", booleanValue: null, actionLabel: null },
  "reasoning-cross-lead": { label: "Denken · Cross-Code", description: "Denkmodus des Codemodells festlegen", displayValue: "Automatisch", control: "choice", booleanValue: null, actionLabel: null },
  "reasoning-cross-challenger": { label: "Denken · Cross-Prüfung", description: "Denkmodus des Prüfmodells festlegen", displayValue: "Automatisch", control: "choice", booleanValue: null, actionLabel: null },
  "cross-pair-swap": { label: "Cross-Paar tauschen", description: "Code- und Prüfrolle vertauschen", displayValue: "Tauschen", control: "action", booleanValue: null, actionLabel: "Tauschen" },
  "architect-executor-model": { label: "Architect · Ausführungsmodell", description: "Modell für angenommene Pläne wählen", displayValue: "Modell: model/executor", control: "choice", booleanValue: null, actionLabel: null },
  "provider-setup": { label: "Anbieter einrichten", description: "Geführte Kontoeinrichtung öffnen", displayValue: "Öffnen", control: "action", booleanValue: null, actionLabel: "Einrichten" },
  "provider-sort": { label: "OpenRouter-Sortierung", description: "Anbieter nach Preis, Durchsatz oder Latenz ordnen", displayValue: "Latenz", control: "choice", booleanValue: null, actionLabel: null },
  "provider-fallback": { label: "OpenRouter-Ersatzanbieter", description: "Ersatzanbieter für dasselbe Modell zulassen", displayValue: "Aus", control: "boolean", booleanValue: false, actionLabel: null },
  "approval-mode": { label: "Freigabemodus", description: "Bestimmt, welche Aktionen bestätigt werden müssen", displayValue: "Alles erlauben", control: "choice", booleanValue: null, actionLabel: null },
  "approval-forget-all": { label: "Alle Regeln vergessen", description: "Alle gemerkten Freigaben entfernen", displayValue: "6 Regeln", control: "action", booleanValue: null, actionLabel: "Alle Regeln löschen" },
  "provider-data-collection": { label: "OpenRouter-Datenfreigabe", description: "Anbieter mit Datenfreigabe zulassen oder sperren", displayValue: "Erlauben", control: "choice", booleanValue: null, actionLabel: null },
  "provider-only": { label: "Nur diese OpenRouter-Anbieter", description: "Ausführung auf eine Liste begrenzen", displayValue: "Anbieter: provider-a · provider-b", control: "choice", booleanValue: null, actionLabel: null },
  "provider-ignore": { label: "Diese OpenRouter-Anbieter ignorieren", description: "Anbieter bei der Auswahl überspringen", displayValue: "Anbieter: provider-z", control: "choice", booleanValue: null, actionLabel: null },
  "max-cost": { label: "Kostenlimit pro Lauf", description: "Maximale geschätzte Hauptmodellkosten", displayValue: "1,25 USD", control: "choice", booleanValue: null, actionLabel: null },
  "max-steps": { label: "Aktionen pro Lauf", description: "Maximale Anzahl der Modellaktionen", displayValue: "42", control: "choice", booleanValue: null, actionLabel: null },
  "compressor-max-cost": { label: "Kostenlimit der Zusammenfassung", description: "Maximale Kosten der Zusammenfassung", displayValue: "0,5 USD", control: "choice", booleanValue: null, actionLabel: null },
  "budget-daily": { label: "Tagesbudget", description: "Kostenlimit dieses Ordners pro Tag", displayValue: "12,5 USD", control: "choice", booleanValue: null, actionLabel: null },
  "budget-total": { label: "Gesamtbudget", description: "Gesamtes Kostenlimit dieses Ordners", displayValue: "99 USD", control: "choice", booleanValue: null, actionLabel: null },
  "budget-on-exceed": { label: "Bei Budgetüberschreitung", description: "Warnen oder neue Läufe sperren", displayValue: "Sperren", control: "choice", booleanValue: null, actionLabel: null },
  "low-balance-threshold": { label: "Warnung bei niedrigem Guthaben", description: "Warnschwelle für verbleibendes Guthaben", displayValue: "2,5 USD", control: "choice", booleanValue: null, actionLabel: null },
  "cost-summary": { label: "Aktuelle Kosten", description: "Kosten dieses Chats, Tages und Ordners", displayValue: "Chat 1,25 USD · Heute 2,5 USD · Ordner 10 USD", control: "readonly", booleanValue: null, actionLabel: null },
  "verify-mode": { label: "Prüfmodus", description: "Automatische Prüfungen steuern", displayValue: "Aus", control: "choice", booleanValue: null, actionLabel: null },
  "verify-commands": { label: "Prüf-Befehle", description: "Geordnete lokale Prüf-Befehle bearbeiten", displayValue: "2 Befehle", control: "choice", booleanValue: null, actionLabel: null },
  "verify-suggest": { label: "Prüf-Befehle vorschlagen", description: "Passende Projektbefehle ermitteln", displayValue: "Vorschlagen", control: "action", booleanValue: null, actionLabel: "Vorschlagen" },
  "verify-clear": { label: "Prüf-Befehle löschen", description: "Alle Prüf-Befehle entfernen", displayValue: "2 Befehle", control: "action", booleanValue: null, actionLabel: "Löschen" },
  "verify-repair-rounds": { label: "Wiederholungen nach Fehler", description: "Anzahl weiterer Versuche festlegen", displayValue: "2", control: "choice", booleanValue: null, actionLabel: null },
  "web-mode": { label: "Webmodus", description: "Webzugriff für Läufe steuern", displayValue: "Ein", control: "choice", booleanValue: null, actionLabel: null },
  "browser-path": { label: "Browserpfad", description: "Expliziten Browserpfad festlegen", displayValue: "Pfad: /Applications/Test Browser", control: "choice", booleanValue: null, actionLabel: null },
  "browser-timeout": { label: "Browser-Zeitlimit", description: "Start und Prüfung zeitlich begrenzen", displayValue: "45 s", control: "choice", booleanValue: null, actionLabel: null },
  "panel-models": { label: "Panel-Modelle", description: "Modelle für parallele Vergleiche wählen", displayValue: "Modell: model/panel-a · model/panel-b", control: "choice", booleanValue: null, actionLabel: null },
  "panel-judge": { label: "Panel-Auswertung", description: "Panel-Antworten zusätzlich zusammenführen", displayValue: "Ein", control: "boolean", booleanValue: true, actionLabel: null },
  "transcription-model": { label: "Transkriptionsmodell", description: "Modell für Sprachaufnahmen wählen", displayValue: "Modell: model/audio", control: "choice", booleanValue: null, actionLabel: null },
  "voice-consent-status": { label: "Sprachfreigabe", description: "Gespeicherte Upload-Freigabe anzeigen", displayValue: "Erteilt", control: "readonly", booleanValue: null, actionLabel: null },
  "voice-consent-clear": { label: "Sprachfreigabe zurücksetzen", description: "Gespeicherte Freigabe entfernen", displayValue: "Zurücksetzen", control: "action", booleanValue: null, actionLabel: "Zurücksetzen" },
  "appearance-large-logo": { label: "Großes ORCODE-Logo", description: "Großes Logo auf Startseite und in Einstellungen anzeigen", displayValue: "Aus", control: "boolean", booleanValue: false, actionLabel: null },
  "appearance-header-mark": { label: "Kompakte Kopfmarke", description: "Kompakte ORCODE-Marke im Chatkopf anzeigen", displayValue: "Aus", control: "boolean", booleanValue: false, actionLabel: null },
  "appearance-glyph-mode": { label: "Terminalzeichen", description: "Unicode- oder ASCII-Zeichen festlegen", displayValue: "ASCII", control: "choice", booleanValue: null, actionLabel: null },
};

const dynamicAction = (provider: "OpenRouter" | "Kimi Code", action: string): ExactPresentation => ({
  label: `${provider} · ${action}`,
  description: "Kontoverbindung sicher verwalten",
  displayValue: `Aktion: ${action}`,
  control: "action",
  booleanValue: null,
  actionLabel: action,
});

const EXPECTED_RICH_DYNAMIC_PRESENTATION: Readonly<Record<(typeof EXPECTED_DYNAMIC_ROW_IDS)[number], ExactPresentation>> = {
  "provider-status:openrouter": { label: "Kontostatus · OpenRouter", description: "Verbindung und Kontozustand anzeigen", displayValue: "Aktiviert · Stabil · Bereit · API-Nutzungsabrechnung · Standardroute · Modell model/main", control: "readonly", booleanValue: null, actionLabel: null },
  "provider-action:openrouter:connect": dynamicAction("OpenRouter", "Verbinden"),
  "provider-action:openrouter:enable": dynamicAction("OpenRouter", "Aktivieren"),
  "provider-action:openrouter:disable": dynamicAction("OpenRouter", "Deaktivieren"),
  "provider-action:openrouter:disconnect": dynamicAction("OpenRouter", "Trennen"),
  "provider-action:openrouter:reconnect": dynamicAction("OpenRouter", "Neu verbinden"),
  "provider-action:openrouter:models": dynamicAction("OpenRouter", "Modelle aktualisieren"),
  "provider-action:openrouter:logout": dynamicAction("OpenRouter", "Abmelden"),
  "provider-status:kimi-code": { label: "Kontostatus · Kimi Code", description: "Verbindung und Kontozustand anzeigen", displayValue: "Deaktiviert · Vorschau · Offline · Abo · Mehrkosten vom Anbieter verwaltet", control: "readonly", booleanValue: null, actionLabel: null },
  "provider-action:kimi-code:connect": dynamicAction("Kimi Code", "Verbinden"),
  "provider-action:kimi-code:enable": dynamicAction("Kimi Code", "Aktivieren"),
  "provider-action:kimi-code:disable": dynamicAction("Kimi Code", "Deaktivieren"),
  "provider-action:kimi-code:reconnect": dynamicAction("Kimi Code", "Neu verbinden"),
  "provider-action:kimi-code:models": dynamicAction("Kimi Code", "Modelle aktualisieren"),
  "provider-action:kimi-code:logout": dynamicAction("Kimi Code", "Abmelden"),
  "provider-status:anthropic": { label: "Kontostatus · Anthropic", description: "Verbindung und Kontozustand anzeigen", displayValue: "Nicht als direkter Anbieter verfügbar · Claude-Modelle laufen über OpenRouter", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-rule:${RULE_V1_ALLOW}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Erlauben", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V1_ALLOW}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
  [`approval-rule:${RULE_V1_DENY}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Ablehnen", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V1_DENY}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
  [`approval-rule:${RULE_V7_ALLOW}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Erlauben", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V7_ALLOW}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
  [`approval-rule:${RULE_V7_DENY}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Ablehnen", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V7_DENY}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
  [`approval-rule:${RULE_V8_ALLOW}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Erlauben", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V8_ALLOW}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
  [`approval-rule:${RULE_V8_DENY}`]: { label: "Gemerkte Regel", description: "Lokal gemerkte Werkzeugfreigabe anzeigen", displayValue: "Ablehnen", control: "readonly", booleanValue: null, actionLabel: null },
  [`approval-forget:${RULE_V8_DENY}`]: { label: "Regel vergessen", description: "Gemerkte Werkzeugfreigabe entfernen", displayValue: "Regel löschen", control: "action", booleanValue: null, actionLabel: "Regel löschen" },
};

test("German Desktop copy tables are closed and exhaustive at runtime", () => {
  assert.equal(Object.keys(DESKTOP_DISABLED_COPY).length, 17);
  assert.equal(Object.keys(DESKTOP_COMMAND_DISABLED_COPY).length, 9);
  assert.equal(Object.keys(DESKTOP_SETTINGS_DISABLED_COPY).length, 19);
  assert.equal(Object.keys(DESKTOP_ACTIVITY_COPY).length, 7);
  assert.equal(Object.keys(DESKTOP_SETTINGS_NOTICE_COPY).length, 4);
  assert.equal(DESKTOP_SETTINGS_STATIC_ROW_IDS.length, 43);
  assert.deepEqual([...DESKTOP_SETTINGS_STATIC_ROW_IDS].sort(), [...EXPECTED_STATIC_ROW_IDS].sort());
  for (const value of Object.values({
    ...DESKTOP_DISABLED_COPY, ...DESKTOP_COMMAND_DISABLED_COPY,
    ...DESKTOP_SETTINGS_DISABLED_COPY, ...DESKTOP_ACTIVITY_COPY,
    ...DESKTOP_SETTINGS_NOTICE_COPY,
  })) assert.match(JSON.stringify(value), /[A-Za-zÄÖÜäöüß]/);
});

test("all reachable Registry and read-only overlay reasons have closed German mappings", () => {
  assert.deepEqual(
    DESKTOP_SETTINGS_RAW_DISABLED_REASONS,
    Object.fromEntries(Object.entries(EXPECTED_RAW_REASON_PRESENTATIONS).map(([reason, presentation]) => [reason, presentation.code])),
  );
  for (const [reason, presentation] of Object.entries(EXPECTED_RAW_REASON_PRESENTATIONS)) {
    assert.deepEqual(DESKTOP_SETTINGS_DISABLED_COPY[presentation.code], presentation);
    assert.deepEqual(mapSettingsDisabledReason(reason), presentation);
  }
});

test("the real no-provider reason maps while synthetic disabled reasons fail closed", () => {
  assert.equal(
    mapSettingsDisabledReason("No provider is connected — run /provider setup first").code,
    "provider-not-connected",
  );
  for (const synthetic of [
    "Cross routes must differ",
    "Provider not connected",
    "Provider degraded",
    "toString",
  ]) {
    assert.throws(
      () => mapSettingsDisabledReason(synthetic),
      DesktopSettingsProjectionError,
      synthetic,
    );
  }
});

test("approval row families accept only canonical lowercase UUID versions 1 through 8", () => {
  const base = {
    categoryId: "approvals-costs", label: "source", description: "source", aliases: [],
    displayValue: "Allow · Rule safe", editor: { kind: "readonly" }, affectsActiveRun: false,
  } as unknown as SettingsItem;
  for (const version of ["1", "7", "8"]) {
    const id = `approval-rule:11111111-1111-${version}111-8111-111111111111`;
    assert.equal(project({ ...base, id } as SettingsItem, { kind: "approval-rule", decision: "allow" }, `h-${version}`).label, "Gemerkte Regel");
  }
  for (const id of [
    "approval-rule:11111111-1111-9111-8111-111111111111",
    "approval-rule:11111111-1111-7111-8111-11111111111Z",
    "approval-rule:11111111-1111-7111-8111-AAAAAAAAAAAA",
  ]) assert.throws(() => project({ ...base, id } as SettingsItem, { kind: "approval-rule", decision: "allow" }), DesktopSettingsProjectionError);
});

test("German values and actions preserve concrete safe truth without generic fallbacks", () => {
  const item = (overrides: Partial<SettingsItem>): SettingsItem => ({
    id: "main-model", categoryId: "models", label: "source", description: "source", aliases: [],
    displayValue: "vendor/modell-ä", editor: { kind: "model", actionId: "main-model", filter: "main" },
    affectsActiveRun: false, ...overrides,
  } as SettingsItem);
  assert.equal(project(item({}), { kind: "model", modelIds: ["vendor/modell-ä"], state: "configured" }).displayValue, "Modell: vendor/modell-ä");
  assert.equal(project(item({ id: "provider-action:openrouter:models", categoryId: "accounts", displayValue: "Run", editor: { kind: "invoke", actionId: "provider-models" } } as never), { kind: "provider-action", backendId: "openrouter", action: "models" }).actionLabel, "Modelle aktualisieren");
  assert.equal(project(item({ id: "cost-summary", categoryId: "approvals-costs", displayValue: "cost unknown · provider-managed", editor: { kind: "readonly" } }), { kind: "cost", knowledge: "unknown", sessionUsd: 0, dayUsd: 0, totalUsd: 0 }).displayValue, "Kosten unbekannt · vom Anbieter verwaltet");
  assert.throws(() => project(item({ displayValue: "ignored raw source" }), { kind: "model", modelIds: ["PRIVATE\nCANARY"], state: "configured" }), DesktopSettingsProjectionError);
});

test("known rows reject printable raw canaries and mismatched Core actions", () => {
  const numeric = {
    id: "max-steps", categoryId: "approvals-costs", label: "source", description: "source", aliases: [],
    displayValue: "PRIVATE_VALUE_CANARY", editor: { kind: "number", actionId: "max-steps", minimum: 1, maximum: 100 },
    affectsActiveRun: true,
  } as SettingsItem;
  assert.throws(() => project(numeric, { kind: "number", value: Number.NaN, unit: "integer" }), DesktopSettingsProjectionError);
  assert.throws(() => project(numeric, { kind: "number", value: 12, unit: "usd" }), DesktopSettingsProjectionError);
  assert.throws(
    () => project({ ...numeric, editor: { ...numeric.editor, maximum: 101 } } as SettingsItem, { kind: "number", value: 12, unit: "integer" }),
    DesktopSettingsProjectionError,
  );
  assert.throws(() => project(numeric, { kind: "number", value: 101, unit: "integer" }), DesktopSettingsProjectionError);

  const mismatched = {
    id: "provider-setup", categoryId: "accounts", label: "source", description: "source", aliases: [],
    displayValue: "Run", editor: { kind: "invoke", actionId: "provider-disconnect" }, affectsActiveRun: true,
  } as SettingsItem;
  assert.throws(() => project(mismatched, { kind: "action", actionId: "provider-setup" }), DesktopSettingsProjectionError);

  const providerSetup = {
    ...mismatched,
    editor: { kind: "invoke", actionId: "provider-setup" },
  } as SettingsItem;
  assert.throws(() => project(providerSetup, { kind: "action", actionId: "cross-pair-swap" }), DesktopSettingsProjectionError);

  const forgetAll = {
    id: "approval-forget-all", categoryId: "approvals-costs", label: "source", description: "source", aliases: [],
    displayValue: "source", editor: { kind: "confirm", actionId: "approval-forget-all", destructive: true }, affectsActiveRun: true,
  } as SettingsItem;
  assert.throws(() => project(forgetAll, { kind: "count", count: 1, subject: "commands" }), DesktopSettingsProjectionError);

  const main = {
    id: "main-model", categoryId: "models", label: "source", description: "source", aliases: [], displayValue: "source",
    editor: { kind: "model", actionId: "main-model", filter: "main" }, affectsActiveRun: true,
  } as SettingsItem;
  assert.throws(() => project(main, { kind: "model", modelIds: ["a", "b"], state: "staged" }), DesktopSettingsProjectionError);

  const approval = {
    id: "approval-mode", categoryId: "approvals-costs", label: "source", description: "source", aliases: [],
    displayValue: "source", editor: { kind: "choice", actionId: "approval-mode", options: [
      { value: "read-only", label: "source", description: "source" }, { value: "ask", label: "source", description: "source" },
      { value: "auto-edit", label: "source", description: "source" }, { value: "allow-all", label: "source", description: "source" },
    ] }, affectsActiveRun: true,
  } as SettingsItem;
  assert.throws(() => project(approval, { kind: "choice", value: "toString" }), DesktopSettingsProjectionError);
});

test("malformed runtime truth primitives arrays and provider policy fail with one fixed projection error", () => {
  const assertFixedProjectionFailure = (run: () => unknown, label: string) => {
    assert.throws(run, (error: unknown) => {
      assert.equal(error instanceof DesktopSettingsProjectionError, true, label);
      assert.equal((error as Error).message, "Diese Einstellung kann nicht sicher angezeigt werden.", label);
      assert.doesNotMatch(String(error), /PRIVATE_RUNTIME_CANARY/, label);
      return true;
    });
  };
  const appearance = {
    id: "appearance-large-logo", categoryId: "appearance", label: "source", description: "source", aliases: [],
    displayValue: "source", editor: { kind: "choice", actionId: "appearance-large-logo", options: [
      { value: "on", label: "source", description: "source" }, { value: "off", label: "source", description: "source" },
    ] }, affectsActiveRun: false,
  } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(appearance, { kind: "boolean", value: "false" } as never),
    "string boolean",
  );

  const consent = {
    id: "voice-consent-status", categoryId: "tools", label: "source", description: "source", aliases: [],
    displayValue: "source", editor: { kind: "readonly" }, affectsActiveRun: false,
  } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(consent, { kind: "consent", granted: "false" } as never),
    "string consent",
  );

  const approval = {
    ...consent,
    id: "approval-rule:11111111-1111-4111-8111-111111111111",
    categoryId: "approvals-costs",
  } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(approval, { kind: "approval-rule", decision: "PRIVATE_RUNTIME_CANARY" } as never),
    "future approval decision",
  );

  const main = {
    id: "main-model", categoryId: "models", label: "source", description: "source", aliases: [], displayValue: "source",
    editor: { kind: "model", actionId: "main-model", filter: "main" }, affectsActiveRun: true,
  } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(main, { kind: "model", modelIds: null, state: "configured" } as never),
    "non-array model ids",
  );

  const providerList = {
    id: "provider-only", categoryId: "approvals-costs", label: "source", description: "source", aliases: [], displayValue: "source",
    editor: { kind: "text", actionId: "provider-only", valueKind: "provider-list" }, affectsActiveRun: true,
  } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(providerList, { kind: "provider-list", values: Array.from({ length: 21 }, (_, index) => `provider-${index}`) }),
    "unbounded provider list",
  );

  const providerStatus = {
    id: "provider-status:openrouter", categoryId: "accounts", label: "source", description: "source", aliases: [],
    displayValue: "source", editor: { kind: "readonly" }, affectsActiveRun: false,
  } as SettingsItem;
  const openRouter = {
    kind: "provider-status", provider: {
      backendId: "openrouter", availability: "connectable", configuration: "enabled", maturity: "stable",
      billingRealm: "openrouter-payg", headline: "ready", isDefault: true,
      selectedRequestedModelId: null, allowedActions: ["connect"],
    },
  } as const;
  assertFixedProjectionFailure(
    () => project(providerStatus, { ...openRouter, provider: { ...openRouter.provider, availability: "coming-soon" } } as never),
    "OpenRouter availability contradiction",
  );
  assertFixedProjectionFailure(
    () => project(providerStatus, { ...openRouter, provider: { ...openRouter.provider, allowedActions: "connect" } } as never),
    "non-array provider actions",
  );

  const anthropicStatus = { ...providerStatus, id: "provider-status:anthropic" } as SettingsItem;
  assertFixedProjectionFailure(
    () => project(anthropicStatus, {
      kind: "provider-status", provider: {
        backendId: "anthropic", availability: "coming-soon", configuration: "enabled", maturity: "coming-soon",
        billingRealm: "none", headline: "ready", isDefault: true,
        selectedRequestedModelId: "PRIVATE_RUNTIME_CANARY", allowedActions: ["connect"],
      },
    } as never),
    "Anthropic policy contradiction",
  );
});

test("reachable disconnected and staged model truth never serializes English state suffixes", () => {
  const main = {
    id: "main-model", categoryId: "models", label: "source", description: "source", aliases: [],
    displayValue: "openrouter/auto · not connected",
    editor: { kind: "model", actionId: "main-model", filter: "main" }, affectsActiveRun: true,
  } as SettingsItem;
  const cross = {
    ...main,
    id: "cross-lead-model",
    displayValue: "openai/gpt-5 · staged",
    editor: { kind: "model", actionId: "cross-lead-model", filter: "cross-lead" },
  } as SettingsItem;
  assert.equal(project(main, { kind: "model", modelIds: ["openrouter/auto"], state: "not-connected" }, "main").displayValue, "Modell: openrouter/auto · nicht verbunden");
  assert.equal(project(cross, { kind: "model", modelIds: ["openai/gpt-5"], state: "staged" }, "cross").displayValue, "Modell: openai/gpt-5 · vorgemerkt");
});

test("unknown rows choices and disabled reasons fail closed with one typed error", () => {
  const base = {
    id: "appearance-glyph-mode", categoryId: "appearance", label: "Terminal characters",
    description: "English source", aliases: [], displayValue: "Automatic",
    editor: { kind: "choice", actionId: "appearance-glyph-mode", options: [
      { value: "future", label: "Future", description: "Future choice" },
    ] }, affectsActiveRun: false,
  } as unknown as SettingsItem;
  assert.throws(() => project(base, { kind: "choice", value: "auto" }), DesktopSettingsProjectionError);
  assert.throws(() => project({ ...base, id: "future-row" } as never, { kind: "choice", value: "auto" }), DesktopSettingsProjectionError);
  assert.throws(() => project({ ...base, editor: { kind: "readonly" }, disabledReason: "future reason" } as never, { kind: "choice", value: "auto" }), DesktopSettingsProjectionError);
  assert.throws(() => project({ ...base, id: "approval-rule:not-a-uuid", editor: { kind: "readonly" } } as never, { kind: "approval-rule", decision: "allow" }), DesktopSettingsProjectionError);
});

test("the rich real Registry pins exact German presentation for all 43 static and 28 dynamic rows", () => {
  const snapshot = richRegistrySnapshot();
  const registry = buildSettingsRegistry(snapshot);
  const projectedSnapshot = { ...snapshot, config: projectSettingsConfig(snapshot.config) } as SettingsControllerSnapshot;
  const exactPresentation = (item: SettingsItem): ExactPresentation => {
    const row = project(item, projectSettingsDesktopRowTruth(projectedSnapshot, item), `exact:${item.id}`);
    return {
      label: row.label,
      description: row.description,
      displayValue: row.displayValue,
      control: row.control,
      booleanValue: row.booleanValue ?? null,
      actionLabel: row.actionLabel ?? null,
    };
  };
  const staticPresentation = Object.fromEntries(
    registry.items.filter(({ id }) => (EXPECTED_STATIC_ROW_IDS as readonly string[]).includes(id))
      .map((item) => [item.id, exactPresentation(item)]),
  );
  const dynamicPresentation = Object.fromEntries(
    registry.items.filter(({ id }) => (EXPECTED_DYNAMIC_ROW_IDS as readonly string[]).includes(id))
      .map((item) => [item.id, exactPresentation(item)]),
  );
  assert.deepEqual(
    registry.items.map(({ id }) => id).sort(),
    [...EXPECTED_STATIC_ROW_IDS, ...EXPECTED_DYNAMIC_ROW_IDS].sort(),
  );
  assert.deepEqual(staticPresentation, EXPECTED_RICH_STATIC_PRESENTATION);
  assert.deepEqual(dynamicPresentation, EXPECTED_RICH_DYNAMIC_PRESENTATION);
});

test("the named real Registry matrix has exact contributions IDs reasons choices and Desktop common-XOR-advanced ownership", () => {
  const scenarios = reachableSettingsRegistryMatrix();
  const ids = new Set<string>();
  const reasons = new Set<string>();
  const choicePairs = new Set<string>();
  assert.deepEqual(scenarios.map(({ name }) => name), [
    "idle-different-ready-present", "active", "cross-unset", "cross-lead-only", "cross-challenger-only",
    "cross-equal", "cross-unavailable-runtime", "cross-unavailable-generic", "cross-unavailable-no-provider", "catalog-missing",
    "catalog-present-no-reasoning", "kimi-policy-gates", "rules-absent", "verify-and-voice-absent",
    "provider-disconnected", "provider-degraded", "appearance-on-auto", "appearance-off-unicode",
    "appearance-mixed-ascii",
  ]);
  for (const { name, snapshot, expected } of scenarios) {
    assert.ok(Object.keys(expected).length > 0, `${name}: nonzero scenario contribution`);
    const registry = buildSettingsRegistry(snapshot);
    const expectedIds = name === "rules-absent"
      ? [...EXPECTED_STATIC_ROW_IDS, ...EXPECTED_DYNAMIC_ROW_IDS.filter((id) => !/^approval-(?:rule|forget):/.test(id))]
      : [...EXPECTED_STATIC_ROW_IDS, ...EXPECTED_DYNAMIC_ROW_IDS];
    assert.deepEqual(registry.items.map(({ id }) => id).sort(), expectedIds.sort(), `${name}: exact emitted IDs once`);
    const projectedSnapshot = { ...snapshot, config: projectSettingsConfig(snapshot.config) } as SettingsControllerSnapshot;
    const truth = Object.fromEntries(registry.items.map((item) => [
      item.id,
      projectSettingsDesktopRowTruth(projectedSnapshot, item),
    ]));
    const actualContribution = Object.fromEntries(Object.keys(expected).map((id) => {
      const item = registry.items.find((candidate) => candidate.id === id);
      if (!item) assert.fail(`${name}: missing ${id}`);
      const rowTruth = truth[id];
      if (!rowTruth) assert.fail(`${name}: missing truth for ${id}`);
      const row = project(item, rowTruth, `contribution:${name}:${id}`);
      return [id, { displayValue: row.displayValue, disabledReason: item.disabledReason ?? null }];
    }));
    assert.deepEqual(actualContribution, expected, `${name}: exact scenario contribution`);

    for (const item of registry.items) {
      ids.add(item.id);
      if (item.disabledReason) reasons.add(item.disabledReason);
      if (item.editor.kind === "choice") {
        for (const option of item.editor.options) choicePairs.add(`${item.editor.actionId}:${option.value}`);
      }
    }

    const capture = { items: registry.items.map(narrowItem), readOnlyReason: null, rowTruth: truth, noticeOutcome: null };
    const unavailable = async (): Promise<never> => { throw new Error("matrix core mutation is unavailable"); };
    const desktop = new DesktopSettingsController({
      captureDesktopProjection: () => capture,
      beginDesktopOperation: unavailable,
      advanceDesktopOperation: unavailable,
      abortDesktopOperation: unavailable,
    } as unknown as DesktopSettingsCorePort);
    assert.deepEqual(desktop.view.categories.map(({ id }) => id), ["model", "accounts", "security", "more"], name);
    assert.deepEqual(desktop.view.categories.map(({ commonItems }) => commonItems.length <= 3), [true, true, true, true], name);

    const rowWithoutHandle = (row: ReturnType<typeof project>) => {
      const { handle: _handle, focusKey: _focusKey, ...presentation } = row;
      return presentation;
    };
    const expectedArea = (item: SettingsItem): "model" | "accounts" | "security" | "more" => {
      if (item.categoryId === "models") return "model";
      if (item.categoryId === "accounts") return "accounts";
      if (item.categoryId === "approvals-costs"
        && (item.id.startsWith("approval-") || ["provider-data-collection", "provider-only", "provider-ignore"].includes(item.id))) {
        return "security";
      }
      return "more";
    };
    for (const category of desktop.view.categories) {
      const actual = [...category.commonItems, ...category.advancedItems]
        .map(rowWithoutHandle).map((row) => JSON.stringify(row)).sort();
      const expectedRows = registry.items.filter((item) => expectedArea(item) === category.id)
        .map((item) => rowWithoutHandle(project(item, truth[item.id]!, `expected:${name}:${item.id}`)))
        .map((row) => JSON.stringify(row)).sort();
      assert.deepEqual(actual, expectedRows, `${name}: ${category.id} common XOR advanced`);
      const handles = [...category.commonItems, ...category.advancedItems].map(({ handle }) => handle);
      assert.deepEqual([...new Set(handles)], handles, `${name}: ${category.id} unique handles`);
    }
    const allPlacements = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [
      ...commonItems,
      ...advancedItems,
    ]);
    assert.equal(allPlacements.length, expectedIds.length, `${name}: every emitted row has exactly one Desktop placement`);
    assert.equal(
      new Set(allPlacements.map(({ handle }) => handle)).size,
      allPlacements.length,
      `${name}: no handle is shared across Desktop categories`,
    );
    const appearanceRows = desktop.view.categories.find(({ id }) => id === "more")!;
    assert.deepEqual(
      [...appearanceRows.commonItems, ...appearanceRows.advancedItems]
        .flatMap(({ label }) => ["Großes ORCODE-Logo", "Kompakte Kopfmarke", "Terminalzeichen"].includes(label) ? [label] : [])
        .sort(),
      ["Großes ORCODE-Logo", "Kompakte Kopfmarke", "Terminalzeichen"].sort(),
      `${name}: all appearance rows under Mehr`,
    );

    if (name === "rules-absent") {
      assert.deepEqual(
        registry.items.flatMap(({ id }) => /^approval-(?:rule|forget):/.test(id) ? [id] : []),
        [],
      );
    }
  }
  assert.deepEqual([...ids].sort(), [...EXPECTED_STATIC_ROW_IDS, ...EXPECTED_DYNAMIC_ROW_IDS].sort());
  const reasoningValues = [
    "auto", "effort:low", "effort:medium", "effort:high",
    "budget:2000", "budget:4000", "budget:8000", "budget:16000", "budget:32000",
  ];
  const reasoningActions = ["reasoning", "reasoning-compressor", "reasoning-cross-lead", "reasoning-cross-challenger"];
  const expectedChoicePairs = [
    "appearance-glyph-mode:ascii", "appearance-glyph-mode:auto", "appearance-glyph-mode:unicode",
    "appearance-header-mark:off", "appearance-header-mark:on", "appearance-large-logo:off", "appearance-large-logo:on",
    "approval-mode:allow-all", "approval-mode:ask", "approval-mode:auto-edit", "approval-mode:read-only",
    "budget-on-exceed:block", "budget-on-exceed:warn", "compression-mode:always", "compression-mode:auto",
    "compression-mode:off", "panel-judge:off", "panel-judge:on", "provider-data-collection:allow",
    "provider-data-collection:deny", "provider-fallback:off", "provider-fallback:on", "provider-sort:latency",
    "provider-sort:off", "provider-sort:price", "provider-sort:throughput", "verify-mode:off",
    "verify-mode:on-edit", "web-mode:auto", "web-mode:off", "web-mode:on",
    ...reasoningActions.flatMap((action) => reasoningValues.map((value) => `${action}:${value}`)),
  ];
  assert.deepEqual([...choicePairs].sort(), expectedChoicePairs.sort());
  assert.deepEqual([...reasons].sort(), [
    "Architect is unavailable on Kimi Code routes",
    "Both roles must be set before swapping",
    "Choose a model first",
    "Cross is not available in this runtime",
    "Cross is unavailable",
    "Cross is unavailable on Kimi Code routes",
    "Kimi Code doesn't support this external model role; an OpenRouter route is required",
    "Model catalog not available",
    "Model doesn't support reasoning",
    "No remembered rules",
    "No provider is connected — run /provider setup first",
    "No verify commands",
    "No voice consent stored",
    "Run active",
  ].sort());
  assert.deepEqual(
    [...new Set([...reasons, ...Object.values(SETTINGS_READ_ONLY_REASONS)])].sort(),
    Object.keys(EXPECTED_RAW_REASON_PRESENTATIONS).sort(),
  );
  const retired = [
    "security-provider-data-collection", "security-provider-only", "security-provider-ignore",
    "provider-connect", "provider-enable", "provider-disable", "provider-disconnect", "provider-reconnect",
    "provider-models", "provider-logout", "approval-forget",
  ];
  assert.deepEqual(retired.flatMap((id) => ids.has(id) ? [id] : []), []);
});
