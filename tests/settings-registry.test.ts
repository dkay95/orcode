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
const RULE_A_ID = "11111111-1111-4111-8111-111111111111";
const RULE_B_ID = "22222222-2222-4222-8222-222222222222";
const RULE_PROJECTION_ERROR = "Settings-Regelprojektion ist ungültig.";
const PROVIDER_PROJECTION_ERROR = "Settings-Anbieterprojektion ist ungültig.";

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
        id: RULE_B_ID,
        decision: "allow",
      },
      {
        id: RULE_A_ID,
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
  assert.ok(ids.indexOf(`approval-rule:${RULE_A_ID}`) < ids.indexOf(`approval-rule:${RULE_B_ID}`));
  assert.ok(ids.indexOf(`approval-forget:${RULE_A_ID}`) < ids.indexOf(`approval-forget:${RULE_B_ID}`));
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
  const base = snapshot();
  const rawRuleSentinel = "Authorization: Bearer raw-rule-token\u001b[31m\nINJECT";
  const configSlotSentinel = "CONFIG_PROVIDER_SLOT_SENTINEL";
  const configFingerprintSentinel = "CONFIG_ACCOUNT_FINGERPRINT_SENTINEL";
  const rawRule = {
    id: RULE_B_ID,
    decision: "allow",
    tool: `shell-${rawRuleSentinel}`,
    display: rawRuleSentinel,
    match: { kind: "exact-subject", display: rawRuleSentinel },
  } as unknown as SettingsAuthoritativeSnapshot["approvalRules"][number];
  const providerSetup = {
    schemaVersion: 2,
    revision: 7,
    lifecycle: "configured",
    connections: [{
      id: "33333333-3333-4333-8333-333333333333",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: configSlotSentinel,
      accountFingerprint: configFingerprintSentinel,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: configFingerprintSentinel,
      billingRealm: "openrouter-payg",
      requestedModelId: CURRENT_MODEL_ID,
      canonicalModelId: CURRENT_MODEL_ID,
      resolutionState: "resolved",
    },
    cross: {
      enabled: false,
      preferredLead: null,
      preferredChallenger: null,
    },
  } as unknown as OrcodeConfigWithBudget["providerSetup"];
  const input: SettingsAuthoritativeSnapshot = {
    ...base,
    config: { ...base.config, providerSetup },
    approvalRules: [rawRule, ...base.approvalRules.slice(1)],
  };
  const polluted = input.providers[0] as SettingsProviderProjection & Record<string, unknown>;
  polluted["accountFingerprintSuffix"] = "…private";
  polluted["credentialSlot"] = "slot-private";
  (input.route as SettingsAuthoritativeSnapshot["route"] & Record<string, unknown>)["accountFingerprint"] = "private";
  const registry = buildSettingsRegistry(input);
  assertNoForbiddenKeyOrValue(registry);
  const rendered = JSON.stringify(registry);
  assert.equal(rendered.includes("raw-rule-token"), false);
  assert.equal(rendered.includes("INJECT"), false);
  assert.equal(rendered.includes(configSlotSentinel), false);
  assert.equal(rendered.includes(configFingerprintSentinel), false);
  for (const candidate of registry.items.flatMap((entry) => [
    entry.label,
    entry.description,
    ...entry.aliases,
    entry.displayValue,
  ])) {
    assert.equal(/[\u0000-\u001f\u007f]/u.test(candidate), false, candidate);
  }
  assert.equal(item(registry, `approval-rule:${RULE_B_ID}`).label, "Gemerkte Regel · 22222222");
  assert.equal(item(registry, `approval-rule:${RULE_B_ID}`).displayValue, "Erlauben · Regel 22222222");
  assert.equal(item(registry, `approval-forget:${RULE_B_ID}`).label, "Regel vergessen · 22222222");
});

test("ungültige oder doppelte Regel-IDs scheitern mit fester secretloser Copy", () => {
  const invalidIds = [
    "rule-a",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "not-valid\u001b[31m\nAuthorization: Bearer never-echo",
  ];
  for (const id of invalidIds) {
    const base = snapshot();
    const input: SettingsAuthoritativeSnapshot = {
      ...base,
      approvalRules: [{ id, decision: "allow" }],
    };
    assert.throws(() => buildSettingsRegistry(input), { message: RULE_PROJECTION_ERROR });
  }

  const left = {
    id: RULE_A_ID,
    decision: "allow" as const,
    display: "Authorization: Bearer left",
  } as unknown as SettingsAuthoritativeSnapshot["approvalRules"][number];
  const right = {
    id: RULE_A_ID,
    decision: "deny" as const,
    tool: "shell-right\u001b[31m",
  } as unknown as SettingsAuthoritativeSnapshot["approvalRules"][number];
  for (const approvalRules of [[left, right], [right, left]]) {
    const base = snapshot();
    assert.throws(
      () => buildSettingsRegistry({ ...base, approvalRules }),
      { message: RULE_PROJECTION_ERROR },
    );
  }
});

test("doppelte Provider-Backends scheitern unabhängig von Eingabereihenfolge", () => {
  const base = snapshot();
  const original = base.providers.find(({ backendId }) => backendId === "openrouter");
  assert.ok(original);
  const conflicting: SettingsProviderProjection = {
    ...original,
    displayName: "Authorization: Bearer provider-left\u001b[31m",
    configuration: "disabled",
    allowedActions: ["logout"],
  };
  for (const pair of [[original, conflicting], [conflicting, original]]) {
    const input: SettingsAuthoritativeSnapshot = {
      ...base,
      providers: [
        ...base.providers.filter(({ backendId }) => backendId !== "openrouter"),
        ...pair,
      ],
    };
    assert.throws(
      () => buildSettingsRegistry(input),
      { message: PROVIDER_PROJECTION_ERROR },
    );
  }
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

test("fehlender Hauptmodell-Katalog sperrt Reasoning ohne Optionen zu erfinden", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    cachedModels: base.cachedModels.filter(({ id }) => id !== CURRENT_MODEL_ID),
  });
  const reasoning = item(registry, "reasoning");
  assert.equal(reasoning.displayValue, "high");
  assert.equal(reasoning.disabledReason, "Modellkatalog nicht verfügbar");
  assert.equal(reasoning.editor.kind, "choice");
  if (reasoning.editor.kind !== "choice") return;
  assert.deepEqual(reasoning.editor.options, [
    {
      value: "effort:high",
      label: "Gespeichert · high",
      description: "Gespeicherter Wert; Modellfähigkeiten sind ohne Katalog nicht prüfbar",
    },
  ]);
});

test("Freigabemodi erklären die vollständige bestehende Sicherheitswirkung", () => {
  const registry = buildSettingsRegistry(snapshot());
  const approval = item(registry, "approval-mode");
  assert.equal(approval.editor.kind, "choice");
  if (approval.editor.kind !== "choice") return;
  assert.deepEqual(
    approval.editor.options.map(({ value, description }) => ({ value, description })),
    [
      {
        value: "read-only",
        description: "Nur lesen; Änderungen und Shell-Befehle werden blockiert. Lesezugriff auf Geheimnisse fragt nach.",
      },
      {
        value: "ask",
        description: "Vor Dateiänderungen und jedem Shell-Befehl fragen.",
      },
      {
        value: "auto-edit",
        description: "Dateiänderungen automatisch, vor Shell-Befehlen fragen. Geschützte Pfade fragen trotzdem nach.",
      },
      {
        value: "allow-all",
        description: "Dateiänderungen und Shell-Befehle ohne Nachfrage. Gefährlich. Nur geschützte Pfade fragen weiter nach.",
      },
    ],
  );
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

test("jede Editorfamilie sowie Modell- und Zahlgrenzen sind konkret verdrahtet", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(
    [...new Set(registry.items.map(({ editor }) => editor.kind))].sort(),
    ["choice", "confirm", "invoke", "model", "number", "readonly", "text"],
  );

  const expectedModels = [
    ["main-model", "main", false],
    ["compressor-model", "compressor", false],
    ["panel-models", "panel", true],
    ["transcription-model", "audio-input", false],
  ] as const;
  for (const [id, filter, multiple] of expectedModels) {
    const editor = item(registry, id).editor;
    assert.equal(editor.kind, "model", id);
    if (editor.kind !== "model") continue;
    assert.equal(editor.filter, filter, id);
    assert.equal(editor.multiple === true, multiple, id);
  }

  const expectedNumbers = [
    ["max-steps", 1, 100, false, undefined],
    ["max-cost", 0.001, 1_000, false, "USD"],
    ["compressor-max-cost", 0.001, 100, false, "USD"],
    ["budget-daily", 0.01, 100_000, true, "USD"],
    ["budget-total", 0.01, 100_000, true, "USD"],
    ["verify-repair-rounds", 0, 2, false, undefined],
    ["browser-timeout", 1, 120, false, "s"],
  ] as const;
  for (const [id, minimum, maximum, allowOff, unit] of expectedNumbers) {
    const editor = item(registry, id).editor;
    assert.equal(editor.kind, "number", id);
    if (editor.kind !== "number") continue;
    assert.equal(editor.minimum, minimum, id);
    assert.equal(editor.maximum, maximum, id);
    assert.equal(editor.allowOff === true, allowOff, id);
    assert.equal(editor.unit, unit, id);
  }
  assert.equal(
    registry.items.filter(({ editor }) => editor.kind === "number").length,
    expectedNumbers.length,
  );
});

test("alle Text-Editoren besitzen exakt ihre stabile ID, Action und Werteart", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(
    registry.items.flatMap(({ id, editor }) => editor.kind === "text"
      ? [{ id, actionId: editor.actionId, valueKind: editor.valueKind }]
      : []),
    [
      { id: "provider-only", actionId: "provider-only", valueKind: "provider-list" },
      { id: "provider-ignore", actionId: "provider-ignore", valueKind: "provider-list" },
      { id: "security-provider-only", actionId: "provider-only", valueKind: "provider-list" },
      { id: "security-provider-ignore", actionId: "provider-ignore", valueKind: "provider-list" },
      { id: "verify-commands", actionId: "verify-commands", valueKind: "command-list" },
      { id: "browser-path", actionId: "browser-path", valueKind: "path" },
    ],
  );
});

test("alle Confirm-Editoren besitzen exakt ihre stabile ID, Action und Destruktivität", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(
    registry.items.flatMap(({ id, editor }) => editor.kind === "confirm"
      ? [{ id, actionId: editor.actionId, destructive: editor.destructive }]
      : []),
    [
      { id: `approval-forget:${RULE_A_ID}`, actionId: "approval-forget", destructive: true },
      { id: `approval-forget:${RULE_B_ID}`, actionId: "approval-forget", destructive: true },
      { id: "approval-forget-all", actionId: "approval-forget-all", destructive: true },
      { id: "verify-clear", actionId: "verify-clear", destructive: true },
      { id: "voice-consent-clear", actionId: "voice-consent-clear", destructive: true },
    ],
  );
});

test("alle Invoke-Editoren besitzen exakt ihre stabile ID und Action", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(
    registry.items.flatMap(({ id, editor }) => editor.kind === "invoke"
      ? [{ id, actionId: editor.actionId }]
      : []),
    [
      { id: "provider-setup", actionId: "provider-setup" },
      { id: "provider-action:openrouter:connect", actionId: "provider-connect" },
      { id: "provider-action:openrouter:enable", actionId: "provider-enable" },
      { id: "provider-action:openrouter:disable", actionId: "provider-disable" },
      { id: "provider-action:openrouter:disconnect", actionId: "provider-disconnect" },
      { id: "provider-action:openrouter:reconnect", actionId: "provider-reconnect" },
      { id: "provider-action:openrouter:models", actionId: "provider-models" },
      { id: "provider-action:openrouter:logout", actionId: "provider-logout" },
      { id: "provider-action:kimi-code:connect", actionId: "provider-connect" },
      { id: "provider-action:kimi-code:enable", actionId: "provider-enable" },
      { id: "provider-action:kimi-code:disable", actionId: "provider-disable" },
      { id: "provider-action:kimi-code:reconnect", actionId: "provider-reconnect" },
      { id: "provider-action:kimi-code:models", actionId: "provider-models" },
      { id: "provider-action:kimi-code:logout", actionId: "provider-logout" },
      { id: "verify-suggest", actionId: "verify-suggest" },
    ],
  );
});

test("alle Choice-Editoren besitzen exakt ID, Action und kanonische Optionsreihenfolge", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(
    registry.items.flatMap(({ id, editor }) => editor.kind === "choice"
      ? [{ id, actionId: editor.actionId, values: editor.options.map(({ value }) => value) }]
      : []),
    [
      {
        id: "reasoning",
        actionId: "reasoning",
        values: [
          "auto",
          "effort:low",
          "effort:medium",
          "effort:high",
          "budget:2000",
          "budget:4000",
          "budget:8000",
          "budget:16000",
          "budget:32000",
        ],
      },
      { id: "compression-mode", actionId: "compression-mode", values: ["off", "auto", "always"] },
      { id: "provider-sort", actionId: "provider-sort", values: ["off", "price", "throughput", "latency"] },
      { id: "provider-data-collection", actionId: "provider-data-collection", values: ["deny", "allow"] },
      { id: "provider-fallback", actionId: "provider-fallback", values: ["on", "off"] },
      { id: "approval-mode", actionId: "approval-mode", values: ["read-only", "ask", "auto-edit", "allow-all"] },
      { id: "security-provider-data-collection", actionId: "provider-data-collection", values: ["deny", "allow"] },
      { id: "budget-on-exceed", actionId: "budget-on-exceed", values: ["warn", "block"] },
      { id: "verify-mode", actionId: "verify-mode", values: ["off", "on-edit"] },
      { id: "web-mode", actionId: "web-mode", values: ["auto", "on", "off"] },
      { id: "panel-judge", actionId: "panel-judge", values: ["on", "off"] },
      { id: "appearance-large-logo", actionId: "appearance-large-logo", values: ["on", "off"] },
      { id: "appearance-header-mark", actionId: "appearance-header-mark", values: ["on", "off"] },
      { id: "appearance-glyph-mode", actionId: "appearance-glyph-mode", values: ["auto", "unicode", "ascii"] },
    ],
  );
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

test("Suche ordnet exakte Treffer vor Präfixen und Präfixe vor Enthalten", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(searchSettings(registry, "route").slice(0, 4).map(({ id }) => id), [
    "main-model",
    "current-route",
    "appearance-large-logo",
    "provider-status:openrouter",
  ]);
});
