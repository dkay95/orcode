import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, type OrcodeConfigWithBudget } from "../src/config.js";
import {
  SETTINGS_ACTION_IDS,
  SETTINGS_CATEGORY_IDS,
  buildSettingsRegistry,
  searchSettings,
  type SettingsActionId,
  type SettingsAuthoritativeSnapshot,
  type SettingsItem,
  type SettingsProviderProjection,
  type SettingsRegistry,
} from "../src/settings-registry.js";
import type { ModelInfo } from "../src/types.js";

type Assert<T extends true> = T;
type ActionIdsStayClosed = Assert<string extends SettingsActionId ? false : true>;
const ACTION_IDS_STAY_CLOSED: ActionIdsStayClosed = true;

const EXPECTED_ACTION_IDS = [
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
] as const satisfies readonly SettingsActionId[];

const PROVIDER_ACTION_ORDER = [
  "connect",
  "enable",
  "disable",
  "disconnect",
  "reconnect",
  "models",
  "logout",
] as const;

const CURRENT_MODEL_ID = "openai/gpt-5.4";

function model(
  id: string,
  overrides: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id,
    name: id === CURRENT_MODEL_ID ? "GPT-5.4" : id,
    description: "Text- und Werkzeugmodell",
    contextLength: 128_000,
    promptPrice: 0.000001,
    completionPrice: 0.000004,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: {
      mandatory: false,
      supportedEfforts: ["low", "medium", "high"],
      supportsMaxTokens: true,
    },
    ...overrides,
  };
}

function provider(
  overrides: Partial<SettingsProviderProjection> & Pick<SettingsProviderProjection, "backendId" | "displayName">,
): SettingsProviderProjection {
  return {
    availability: "connectable",
    configuration: "enabled",
    maturity: "stable",
    billingRealm: "openrouter-payg",
    headline: "ready",
    health: {
      credential: "valid",
      connectivity: "connected",
      spend: "available",
      runtime: "ready",
    },
    isDefault: false,
    selectedModel: null,
    allowedActions: [],
    ...overrides,
  };
}

function snapshot(runActive = false): SettingsAuthoritativeSnapshot {
  const config = structuredClone(DEFAULT_CONFIG) as OrcodeConfigWithBudget;
  config.mainModel = CURRENT_MODEL_ID;
  config.reasoningByModel = {
    [CURRENT_MODEL_ID]: { mode: "effort", effort: "high" },
  };
  config.compressionMode = "always";
  config.compressorModel = "qwen/qwen3.5-flash-02-23";
  config.maxSteps = 17;
  config.maxCostUsd = 2.5;
  config.compressorMaxCostUsd = 0.08;
  config.budget = {
    dailyLimitUsd: 12,
    totalLimitUsd: null,
    onExceed: "block",
  };
  config.provider = {
    sort: "latency",
    dataCollection: "deny",
    only: ["Example Cloud"],
    ignore: ["Slow Host"],
    allowFallbacks: false,
  };
  config.verify = {
    mode: "on-edit",
    commands: ["npm run check", "npm test"],
    maxRepairRounds: 2,
  };
  config.web = "auto";
  config.browserPath = "/Applications/Chromium.app";
  config.browserTimeoutSeconds = 45;
  config.panelModels = [CURRENT_MODEL_ID, "anthropic/claude-sonnet-4"];
  config.panelJudge = true;
  config.transcriptionModel = "mistralai/voxtral-small-24b-2507";
  config.voiceConsentGiven = true;
  config.appearance = {
    showLargeLogo: true,
    showHeaderMark: false,
    glyphMode: "ascii",
  };

  return {
    config,
    runActive,
    route: {
      backendId: "openrouter",
      providerLabel: "OpenRouter",
      requestedModelId: CURRENT_MODEL_ID,
      canonicalModelId: CURRENT_MODEL_ID,
      modelLabel: "GPT-5.4",
      billingRealm: "openrouter-payg",
    },
    // Deliberately not in canonical order: registry order must not depend on
    // the adapter's iteration order.
    providers: [
      provider({
        backendId: "kimi-code",
        displayName: "Kimi Code",
        maturity: "preview",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        headline: "ready",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
        },
        selectedModel: {
          requestedModelId: "kimi-for-coding",
          canonicalModelId: "kimi-k2.5",
          displayName: "Kimi K2.5",
        },
        allowedActions: ["logout", "models", "reconnect", "disable", "enable", "connect"],
      }),
      provider({
        backendId: "anthropic",
        displayName: "Anthropic",
        availability: "coming-soon",
        configuration: "disabled",
        maturity: "coming-soon",
        billingRealm: "none",
        headline: null,
        health: null,
        // A malformed upstream projection must not turn Coming soon into a
        // control. The structural slash-command set is intentionally broader.
        allowedActions: [...PROVIDER_ACTION_ORDER],
      }),
      provider({
        backendId: "openrouter",
        displayName: "OpenRouter",
        isDefault: true,
        selectedModel: {
          requestedModelId: CURRENT_MODEL_ID,
          canonicalModelId: CURRENT_MODEL_ID,
          displayName: "GPT-5.4",
        },
        allowedActions: [...PROVIDER_ACTION_ORDER].reverse(),
      }),
    ],
    // Deliberately reversed; stable local rule IDs own dynamic ordering.
    approvalRules: [
      {
        id: "rule-b",
        tool: "shell",
        display: "npm test",
        decision: "allow",
      },
      {
        id: "rule-a",
        tool: "edit",
        display: "src/**/*.ts",
        decision: "deny",
      },
    ],
    costs: {
      costKnowledge: "unknown",
      sessionUsd: 1.25,
      dayUsd: 4.5,
      totalUsd: 19,
    },
    cachedModels: [
      model(CURRENT_MODEL_ID),
      model("anthropic/claude-sonnet-4"),
      model("mistralai/voxtral-small-24b-2507", {
        inputModalities: ["text", "audio"],
      }),
    ],
  };
}

function actionId(item: SettingsItem): SettingsActionId | null {
  return item.editor.kind === "readonly" ? null : item.editor.actionId;
}

function item(registry: SettingsRegistry, id: SettingsItem["id"]): SettingsItem {
  const found = registry.items.find((candidate) => candidate.id === id);
  assert.ok(found, `fehlendes Settings-Item ${id}`);
  return found;
}

function providerActionIds(
  registry: SettingsRegistry,
  backendId: SettingsProviderProjection["backendId"],
): string[] {
  const prefix = `provider-action:${backendId}:`;
  return registry.items
    .filter((candidate) => candidate.id.startsWith(prefix))
    .map((candidate) => candidate.id.slice(prefix.length));
}

function assertNoForbiddenKeyOrValue(value: unknown): void {
  const forbidden = [
    "accountFingerprint",
    "accountFingerprintSuffix",
    "credentialSlot",
    "apiKey",
    "secret",
    "requestId",
  ].map((entry) => entry.toLowerCase());
  const walk = (candidate: unknown, path: string): void => {
    if (typeof candidate === "string") {
      const normalized = candidate.toLowerCase();
      for (const blocked of forbidden) {
        assert.equal(
          normalized.includes(blocked),
          false,
          `${path} enthält verbotenen Wertbestandteil ${blocked}`,
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, entry] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      for (const blocked of forbidden) {
        assert.equal(
          normalizedKey.includes(blocked),
          false,
          `${path}.${key} enthält verbotenen Schlüsselbestandteil ${blocked}`,
        );
      }
      walk(entry, `${path}.${key}`);
    }
  };
  walk(value, "registry");
}

test("Registry besitzt exakt sechs stabile Kategorien in deutscher Reihenfolge", () => {
  assert.equal(ACTION_IDS_STAY_CLOSED, true);
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(registry.categories.map(({ id }) => id), SETTINGS_CATEGORY_IDS);
  assert.deepEqual(registry.categories.map(({ label }) => label), [
    "Modelle & Denken",
    "Anbieter & Konten",
    "Sicherheit & Freigaben",
    "Kosten & Budgets",
    "Prüfen & Tools",
    "Darstellung",
  ]);
});

test("Item-IDs sind global eindeutig und dynamische Reihenfolge ist reproduzierbar", () => {
  const first = buildSettingsRegistry(snapshot());
  const base = snapshot();
  const secondSnapshot: SettingsAuthoritativeSnapshot = {
    ...base,
    providers: [...base.providers].reverse(),
    approvalRules: [...base.approvalRules].reverse(),
  };
  const second = buildSettingsRegistry(secondSnapshot);
  const ids = first.items.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(second.items.map(({ id }) => id), ids);
  assert.ok(ids.indexOf("provider-status:openrouter") < ids.indexOf("provider-status:kimi-code"));
  assert.ok(ids.indexOf("provider-status:kimi-code") < ids.indexOf("provider-status:anthropic"));
  assert.ok(ids.indexOf("approval-rule:rule-a") < ids.indexOf("approval-rule:rule-b"));
  assert.ok(ids.indexOf("approval-forget:rule-a") < ids.indexOf("approval-forget:rule-b"));
});

test("geschlossene Action-Union deckt jede reale Zeile ab und keine Zeile ist Platzhalter", () => {
  assert.deepEqual(SETTINGS_ACTION_IDS, EXPECTED_ACTION_IDS);
  const registry = buildSettingsRegistry(snapshot());
  const allowed = new Set<SettingsActionId>(SETTINGS_ACTION_IDS);
  const observed = new Set<SettingsActionId>();
  for (const candidate of registry.items) {
    assert.ok(candidate.description.trim(), `${candidate.id} braucht eine Beschreibung`);
    assert.equal(/todo|tbd|placeholder/i.test(candidate.description), false, candidate.id);
    if (candidate.editor.kind === "readonly") continue;
    assert.equal(allowed.has(candidate.editor.actionId), true, candidate.id);
    observed.add(candidate.editor.actionId);
    if (candidate.editor.kind === "choice") {
      assert.ok(candidate.editor.options.length > 0, `${candidate.id} braucht echte Optionen`);
      for (const option of candidate.editor.options) {
        assert.ok(option.label.trim(), `${candidate.id} hat eine leere Option`);
        assert.ok(option.description.trim(), `${candidate.id} hat eine unbeschriebene Option`);
      }
    }
  }
  assert.deepEqual([...observed].sort(), [...SETTINGS_ACTION_IDS].sort());
});

test("Coming soon bleibt ausschließlich eine nicht ausführbare Anthropic-Statuszeile", () => {
  const registry = buildSettingsRegistry(snapshot());
  const comingSoon = registry.items.filter((candidate) =>
    [candidate.label, candidate.description, candidate.displayValue]
      .some((value) => /coming soon/i.test(value))
  );
  assert.deepEqual(comingSoon.map(({ id }) => id), ["provider-status:anthropic"]);
  assert.equal(comingSoon[0]?.editor.kind, "readonly");
  assert.deepEqual(providerActionIds(registry, "anthropic"), []);
});

test("Registry baut ausschließlich eine secretless Ansicht statt Eingaben durchzureichen", () => {
  const input = snapshot();
  const polluted = input.providers[0] as SettingsProviderProjection & Record<string, unknown>;
  polluted["accountFingerprintSuffix"] = "…private";
  polluted["credentialSlot"] = "slot-private";
  (input.route as SettingsAuthoritativeSnapshot["route"] & Record<string, unknown>)["accountFingerprint"] = "private";
  const registry = buildSettingsRegistry(input);
  assertNoForbiddenKeyOrValue(registry);
});

test("aktive Läufe sperren nur mutierende Laufzeilen; Status und Darstellung bleiben verfügbar", () => {
  const registry = buildSettingsRegistry(snapshot(true));
  for (const candidate of registry.items) {
    if (candidate.editor.kind === "readonly" || candidate.categoryId === "appearance") {
      assert.equal(candidate.disabledReason, undefined, candidate.id);
      continue;
    }
    assert.equal(candidate.affectsActiveRun, true, candidate.id);
    assert.equal(candidate.disabledReason, "Lauf aktiv", candidate.id);
  }
  for (const appearance of registry.items.filter(({ categoryId }) => categoryId === "appearance")) {
    assert.equal(appearance.affectsActiveRun, false, appearance.id);
    assert.notEqual(appearance.editor.kind, "readonly", appearance.id);
  }
});

test("aktuelle Konfiguration wird konkret und ohne erfundene Kosten projiziert", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.equal(item(registry, "main-model").displayValue, "GPT-5.4 · openai/gpt-5.4");
  assert.equal(item(registry, "reasoning").displayValue, "high");
  assert.equal(item(registry, "compression-mode").displayValue, "Immer");
  assert.equal(item(registry, "max-steps").displayValue, "17");
  assert.equal(item(registry, "provider-sort").displayValue, "Latenz");
  assert.equal(item(registry, "provider-data-collection").displayValue, "Ablehnen");
  assert.equal(item(registry, "budget-total").displayValue, "Aus");
  assert.equal(item(registry, "verify-commands").displayValue, "npm run check · npm test");
  assert.equal(item(registry, "appearance-header-mark").displayValue, "Aus");
  assert.equal(item(registry, "appearance-glyph-mode").displayValue, "ASCII");
  assert.equal(item(registry, "cost-summary").displayValue, "Kosten unbekannt · providerverwaltet");
  assert.equal(item(registry, "cost-summary").displayValue.includes("$0"), false);
});

test("Provider-Aktionszeilen entsprechen exakt der gelieferten Capability-Projektion", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(providerActionIds(registry, "openrouter"), PROVIDER_ACTION_ORDER);
  assert.deepEqual(providerActionIds(registry, "kimi-code"), [
    "connect",
    "enable",
    "disable",
    "reconnect",
    "models",
    "logout",
  ]);
  assert.equal(providerActionIds(registry, "kimi-code").includes("disconnect"), false);
  assert.deepEqual(providerActionIds(registry, "anthropic"), []);
});

test("OpenRouter-Datenschutz erscheint mit separaten Item-IDs aber identischen Actions", () => {
  const registry = buildSettingsRegistry(snapshot());
  const pairs = [
    ["provider-data-collection", "security-provider-data-collection"],
    ["provider-only", "security-provider-only"],
    ["provider-ignore", "security-provider-ignore"],
  ] as const;
  for (const [providerId, securityId] of pairs) {
    const providerItem = item(registry, providerId);
    const securityItem = item(registry, securityId);
    assert.notEqual(providerItem.id, securityItem.id);
    assert.equal(actionId(providerItem), actionId(securityItem));
  }
});

test("Suche normalisiert Diakritika und bewertet exakt, Präfix und Enthalten deterministisch", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.equal(searchSettings(registry, "budget")[0]?.id, "budget-daily");
  assert.equal(searchSettings(registry, "kimi")[0]?.id, "provider-status:kimi-code");
  assert.equal(searchSettings(registry, "ASCII")[0]?.id, "appearance-glyph-mode");
  assert.equal(searchSettings(registry, CURRENT_MODEL_ID)[0]?.id, "main-model");
  assert.equal(searchSettings(registry, "thinking")[0]?.id, "reasoning");
  assert.ok(searchSettings(registry, "Browser-Start").some(({ id }) => id === "browser-timeout"));
  assert.deepEqual(
    searchSettings(registry, "prufen").map(({ id }) => id),
    searchSettings(registry, "Prüfen").map(({ id }) => id),
  );
  assert.deepEqual(searchSettings(registry, "  "), registry.items);
  assert.deepEqual(searchSettings(registry, "nicht-vorhanden"), []);
});
