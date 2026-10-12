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
  type SettingsCategoryId,
  type SettingsCrossProjection,
  type SettingsItem,
  type SettingsProviderProjection,
  type SettingsRegistry,
} from "../src/settings-registry.js";
import type { ModelInfo } from "../src/types.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import { architectUnavailableReasonForRoute } from "../src/architect.js";
import { DEFAULT_REASONING_SETTING, reasoningLabel } from "../src/reasoning.js";

function crossRoute(model: string, account = `acct-${model}`): RouteIdentityV1 {
  return Object.freeze({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: account,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
}

function crossProjection(
  overrides: Partial<SettingsCrossProjection> = {},
): SettingsCrossProjection {
  return {
    preferences: { lead: null, challenger: null },
    available: true,
    ...overrides,
  };
}

type Assert<T extends true> = T;
type ActionIdsStayClosed = Assert<string extends SettingsActionId ? false : true>;
const ACTION_IDS_STAY_CLOSED: ActionIdsStayClosed = true;

const EXPECTED_ACTION_IDS = [
  "main-model",
  "reasoning",
  "reasoning-compressor",
  "reasoning-cross-lead",
  "reasoning-cross-challenger",
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
  "low-balance-threshold",
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
  "cross-lead-model",
  "cross-challenger-model",
  "cross-pair-swap",
  "architect-executor-model",
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
const RULE_PROJECTION_ERROR = "Settings rule projection is invalid.";
const PROVIDER_PROJECTION_ERROR = "Settings provider projection is invalid.";

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
    cross: crossProjection({
      preferences: {
        lead: crossRoute("openai/cross-lead"),
        challenger: crossRoute("openai/cross-challenger"),
      },
    }),
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
    "credentialBinding",
    "pointer",
    "homeId",
    "codexHome",
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

test("Registry besitzt exakt fünf stabile Bereiche in englischer Beschriftung", () => {
  assert.equal(ACTION_IDS_STAY_CLOSED, true);
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(registry.categories.map(({ id }) => id), SETTINGS_CATEGORY_IDS);
  assert.deepEqual(registry.categories.map(({ label }) => label), [
    "Models",
    "Accounts",
    "Approvals & Costs",
    "Tools",
    "Appearance",
  ]);
});

/**
 * V4-B: section metadata is a GROUPING, and the rules that keep it honest are
 * mechanical rather than editorial.
 *
 * 1. All or none, per category. A category either names a heading for every
 *    one of its rows or for none of them — so a row added later cannot land
 *    unheaded in the middle of a sectioned list, or under a heading that does
 *    not describe it.
 * 2. Contiguous. Each heading appears as exactly one run inside its category,
 *    so the heading order IS the row order and `settings-frame.ts` can emit a
 *    heading simply where the section changes.
 * 3. Only where the groups are real. Appearance's three rows are one idea and
 *    deliberately carry no section at all — the mockup's rule is section
 *    headings where a category has natural groups, not a heading per screen.
 */
test("Sektionen decken eine Kategorie ganz oder gar nicht ab und bilden je genau einen Block", () => {
  const registry = buildSettingsRegistry(snapshot());
  const seen = new Map<string, string[]>();
  for (const categoryId of SETTINGS_CATEGORY_IDS) {
    const rows = registry.items.filter((entry) => entry.categoryId === categoryId);
    const sectioned = rows.filter(({ section }) => section !== undefined);
    assert.equal(
      sectioned.length === 0 || sectioned.length === rows.length,
      true,
      `${categoryId}: ${sectioned.length} of ${rows.length} rows carry a section`,
    );
    const runs: string[] = [];
    for (const row of rows) {
      const section = row.section ?? "";
      if (runs.at(-1) !== section) runs.push(section);
    }
    assert.equal(
      new Set(runs).size,
      runs.length,
      `${categoryId}: a section must be one contiguous run, got ${JSON.stringify(runs)}`,
    );
    seen.set(categoryId, runs);
  }
  assert.deepEqual(seen.get("models"), ["Main model", "Summarizing", "Cross pair", "Architect"]);
  assert.deepEqual(seen.get("accounts"), ["Providers", "OpenRouter routing"]);
  assert.deepEqual(seen.get("approvals-costs"), ["Privacy", "Approvals", "Costs & budgets"]);
  assert.deepEqual(seen.get("tools"), ["Verification", "Web & browser", "Panel", "Voice"]);
  // Appearance: one idea, no invented heading.
  assert.deepEqual(seen.get("appearance"), [""]);
});

// F7 (ruling 4): "current-route" folded into "main-model"'s own detail
// line and was removed as its own row — one fewer canonical row overall,
// one fewer in the "models" category (42/12 -> 41/11).
test("45 feste Kompatibilitätszeilen ergeben 42 kanonische reale Zeilen ohne Datenschutz-Duplikate", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    providers: [],
    approvalRules: [],
  });
  // Phase 14: "Architect: executor model" joined the models category —
  // one more canonical row overall, one more in "models" (42/12 -> 43/13).
  // FIX-15 (command-IA, ratified) moved three rows, adding none and removing
  // none: "Actions per run" left Tools, and the summarizer cost cap and the
  // low-balance warning left Models, for Approvals & Costs — all three are
  // limits on what a run may spend or do. The total is unchanged, which is
  // the point of pinning it alongside the per-category counts.
  assert.equal(registry.items.length, 43);
  assert.deepEqual(
    Object.fromEntries(SETTINGS_CATEGORY_IDS.map((categoryId) => [
      categoryId,
      registry.items.filter((candidate) => candidate.categoryId === categoryId).length,
    ])),
    { models: 11, accounts: 3, "approvals-costs": 13, tools: 13, appearance: 3 },
  );
  assert.equal(42 + 3, 45, "drei alte Security-Datenschutz-IDs bleiben reine Typkompatibilität");
  for (const compatibilityId of [
    "security-provider-data-collection",
    "security-provider-only",
    "security-provider-ignore",
  ]) {
    assert.equal(registry.items.some(({ id }) => id === compatibilityId), false);
  }
  assert.equal(item(registry, "main-model").label, "Model");
  assert.equal(item(registry, "reasoning").label, "Thinking · main model");
  assert.equal(item(registry, "max-steps").label, "Actions per run");
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

// FIX-12: the row's value read "Coming soon" — the one Settings row that
// described a future rather than the present, for a backend BackendRegistry
// forbids an adapter and nobody is building. The structural contract this
// test exists for is unchanged (exactly one row, read-only, no actions);
// what it says is now the redirect that is actually true.
test("Anthropic bleibt ausschließlich eine nicht ausführbare Statuszeile, die auf OpenRouter verweist", () => {
  const registry = buildSettingsRegistry(snapshot());
  const redirect = registry.items.filter((candidate) =>
    [candidate.label, candidate.description, candidate.displayValue]
      .some((value) => /not available as a direct backend/i.test(value))
  );
  assert.deepEqual(redirect.map(({ id }) => id), ["provider-status:anthropic"]);
  assert.equal(redirect[0]?.editor.kind, "readonly");
  assert.match(redirect[0]?.displayValue ?? "", /via OpenRouter/);
  assert.deepEqual(providerActionIds(registry, "anthropic"), []);
  assert.equal(
    registry.items.some((candidate) =>
      [candidate.label, candidate.description, candidate.displayValue]
        .some((value) => /coming soon/i.test(value))),
    false,
  );
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
    schemaVersion: 3,
    revision: 7,
    lifecycle: "configured",
    connections: [{
      id: "33333333-3333-4333-8333-333333333333",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain", pointer: configSlotSentinel },
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
  assert.equal(item(registry, `approval-rule:${RULE_B_ID}`).label, "Remembered rule · 22222222");
  assert.equal(item(registry, `approval-rule:${RULE_B_ID}`).displayValue, "Allow · Rule 22222222");
  assert.equal(item(registry, `approval-forget:${RULE_B_ID}`).label, "Forget rule · 22222222");
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
    if (
      candidate.editor.kind === "readonly"
      || candidate.id.startsWith("appearance-")
      || candidate.id.startsWith("cross-")
      // D6: the low-balance threshold is a display-only warn knob — unlike
      // max-cost/budget-daily (which an active run's own guard actively
      // reads), nothing in a running agent ever consults it, so there is
      // nothing an in-flight edit could destabilize. Cosmetic, like
      // appearance-*.
      || candidate.id === "low-balance-threshold"
      // Phase 14: same reasoning as the cross-* rows above — the executor
      // route only ever affects a FUTURE, separate `/architect` invocation,
      // never the currently active run.
      || candidate.id === "architect-executor-model"
    ) {
      assert.equal(candidate.disabledReason, undefined, candidate.id);
      continue;
    }
    if (candidate.id.startsWith("reasoning-cross-")) {
      // A Cross role's thinking row never blocks on the ACTIVE run (it only
      // ever affects a future Cross run, like the plain cross-*-model rows)
      // but — unlike those — can still be independently disabled by catalog
      // or role-unset gating; this snapshot's Cross models are not cached,
      // so that independent disabling is expected here too.
      assert.equal(candidate.affectsActiveRun, false, candidate.id);
      continue;
    }
    assert.equal(candidate.affectsActiveRun, true, candidate.id);
    assert.equal(candidate.disabledReason, "Run active", candidate.id);
  }
  for (const appearance of registry.items.filter(({ id }) => id.startsWith("appearance-"))) {
    assert.equal(appearance.affectsActiveRun, false, appearance.id);
    assert.notEqual(appearance.editor.kind, "readonly", appearance.id);
  }
  for (const cross of registry.items.filter(({ id }) => id.startsWith("cross-"))) {
    assert.equal(cross.affectsActiveRun, false, cross.id);
    assert.notEqual(cross.editor.kind, "readonly", cross.id);
  }
});

test("aktuelle Konfiguration wird konkret und ohne erfundene Kosten projiziert", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.equal(item(registry, "main-model").displayValue, "GPT-5.4 · openai/gpt-5.4");
  assert.equal(item(registry, "reasoning").displayValue, "high");
  assert.equal(item(registry, "compression-mode").displayValue, "Always");
  assert.equal(item(registry, "max-steps").displayValue, "17");
  assert.equal(item(registry, "provider-sort").displayValue, "Latency");
  assert.equal(item(registry, "provider-data-collection").displayValue, "Deny");
  assert.equal(item(registry, "budget-total").displayValue, "Off");
  assert.equal(item(registry, "verify-commands").displayValue, "npm run check · npm test");
  assert.equal(item(registry, "appearance-header-mark").displayValue, "Off");
  assert.equal(item(registry, "appearance-glyph-mode").displayValue, "ASCII");
  assert.equal(item(registry, "cost-summary").displayValue, "cost unknown · provider-managed");
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
  assert.equal(reasoning.disabledReason, "Model catalog not available");
  assert.equal(reasoning.editor.kind, "choice");
  if (reasoning.editor.kind !== "choice") return;
  assert.deepEqual(reasoning.editor.options, [
    {
      value: "effort:high",
      label: "Saved · high",
      description: "Saved value; model capabilities can't be checked without current model data",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Phase 3 — Thinking per model role (four rows: main, compressor, Cross
// coding, Cross review). No schema change: each row keys the one shared
// `reasoningByModel` store by ITS OWN role's model id, resolved fresh at
// row-build time; there is no inheritance from the main model.
// ---------------------------------------------------------------------------

/**
 * V4-B (pin moved deliberately — justification): the four Thinking rows used
 * to be pinned as one contiguous block ahead of the efficiency rows. That was
 * a grouping decision, and V4-B replaces it with a stronger one — each
 * Thinking row now sits inside the section of the ROLE it configures
 * (`Summarizing` holds the summarizer's model and its thinking; `Cross pair`
 * holds both Cross models and both their thinking rows), which is what the
 * mockup's `─ Cross-Paar` draws. Phase 3's actual subject is untouched and
 * still asserted below: four rows, each keyed by its own role's model id,
 * no inheritance from the main model.
 */
test("vier Thinking-Zeilen stehen je bei ihrer Rolle, mit englischen Labels und rollen-eigenen Werten", () => {
  const base = snapshot();
  const config = structuredClone(base.config);
  config.mainModel = "role/main";
  config.compressorModel = "role/compressor";
  config.reasoningByModel = {
    "role/main": { mode: "effort", effort: "high" },
    "role/compressor": { mode: "effort", effort: "medium" },
    "role/lead": { mode: "budget", maxTokens: 4_000 },
    // Deliberately no entry for role/challenger: it must show the default.
  };
  const registry = buildSettingsRegistry({
    ...base,
    config,
    cachedModels: [
      model("role/main"),
      model("role/compressor"),
      model("role/lead"),
      model("role/challenger"),
    ],
    cross: crossProjection({
      preferences: { lead: crossRoute("role/lead"), challenger: crossRoute("role/challenger") },
    }),
  });

  const models = registry.items.filter(({ categoryId }) => categoryId === "models");
  assert.deepEqual(models.map(({ id }) => id), [
    "main-model",
    "reasoning",
    "compression-mode",
    "compressor-model",
    "reasoning-compressor",
    "cross-lead-model",
    "cross-challenger-model",
    "reasoning-cross-lead",
    "reasoning-cross-challenger",
    "cross-pair-swap",
    "architect-executor-model",
  ]);
  // Every Thinking row is under the heading of the role it configures.
  assert.deepEqual(
    models
      .filter(({ id }) => id.startsWith("reasoning"))
      .map(({ id, section }) => `${id}:${section}`),
    [
      "reasoning:Main model",
      "reasoning-compressor:Summarizing",
      "reasoning-cross-lead:Cross pair",
      "reasoning-cross-challenger:Cross pair",
    ],
  );

  const main = item(registry, "reasoning");
  const compressor = item(registry, "reasoning-compressor");
  const lead = item(registry, "reasoning-cross-lead");
  const challenger = item(registry, "reasoning-cross-challenger");

  assert.equal(main.label, "Thinking · main model");
  assert.equal(compressor.label, "Thinking · summarizer");
  assert.equal(lead.label, "Thinking · Cross coding");
  assert.equal(challenger.label, "Thinking · Cross review");
  for (const row of [main, compressor, lead, challenger]) {
    assert.match(row.description, /^[\x00-\x7F]*$/, `${row.id} description must be plain English`);
    assert.equal(row.editor.kind, "choice", row.id);
    if (row.editor.kind !== "choice") continue;
    assert.equal(row.editor.actionId, row.id);
    assert.ok(row.aliases.includes("thinking"), row.id);
    assert.equal(row.disabledReason, undefined, row.id);
  }
  for (const row of [lead, challenger]) {
    for (const required of ["cross", "lead", "challenger", "review"]) {
      assert.ok(row.aliases.includes(required), `${row.id} missing alias ${required}`);
    }
  }

  // Each role reads its OWN entry — never the main model's.
  assert.equal(main.displayValue, "high");
  assert.equal(compressor.displayValue, "medium");
  assert.equal(lead.displayValue, "4K");
  assert.equal(challenger.displayValue, reasoningLabel(DEFAULT_REASONING_SETTING));
  assert.notEqual(challenger.displayValue, main.displayValue);
});

test("an unset Cross role locks its thinking row with 'Choose a model first' and shows the default", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    cross: crossProjection({ preferences: { lead: null, challenger: null } }),
  });
  for (const id of ["reasoning-cross-lead", "reasoning-cross-challenger"] as const) {
    const row = item(registry, id);
    assert.equal(row.disabledReason, "Choose a model first", id);
    assert.equal(row.displayValue, reasoningLabel(DEFAULT_REASONING_SETTING), id);
  }
});

test("compressor and Cross thinking rows without catalog data fall back exactly like the main row", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    cross: crossProjection({
      preferences: {
        lead: crossRoute("role/no-catalog-lead"),
        challenger: crossRoute("role/no-catalog-challenger"),
      },
    }),
  });
  // base.config.compressorModel and these two Cross routes are all absent
  // from base.cachedModels, and none has its own reasoningByModel entry.
  for (const id of ["reasoning-compressor", "reasoning-cross-lead", "reasoning-cross-challenger"] as const) {
    const row = item(registry, id);
    assert.equal(row.disabledReason, "Model catalog not available", id);
    assert.equal(row.editor.kind, "choice", id);
    if (row.editor.kind !== "choice") continue;
    assert.deepEqual(row.editor.options, [{
      value: "auto",
      label: `Saved · ${reasoningLabel(DEFAULT_REASONING_SETTING)}`,
      description: "Saved value; model capabilities can't be checked without current model data",
    }], id);
  }
});

test("a role's thinking row disables when that role's own model doesn't support reasoning", () => {
  const base = snapshot();
  const config = structuredClone(base.config);
  config.compressorModel = "role/no-reasoning";
  const plainModel = model("role/no-reasoning", { reasoning: undefined, supportedParameters: ["tools"] });
  const registry = buildSettingsRegistry({
    ...base,
    config,
    cachedModels: [...base.cachedModels, plainModel],
    cross: crossProjection({
      preferences: {
        lead: crossRoute("role/no-reasoning"),
        challenger: crossRoute("anthropic/claude-sonnet-4"),
      },
    }),
  });
  for (const id of ["reasoning-compressor", "reasoning-cross-lead"] as const) {
    assert.equal(item(registry, id).disabledReason, "Model doesn't support reasoning", id);
  }
  // The challenger's own model (claude-sonnet-4) supports reasoning: no gate.
  assert.equal(item(registry, "reasoning-cross-challenger").disabledReason, undefined);
});

test("an unavailable Cross bridge disables both thinking rows with the concrete reason even when a role model is chosen", () => {
  const base = snapshot();
  const reason = "Cross is unavailable on Kimi Code routes";
  const registry = buildSettingsRegistry({
    ...base,
    cross: crossProjection({
      preferences: { lead: crossRoute("openai/cross-lead"), challenger: crossRoute("openai/cross-challenger") },
      available: false,
      unavailableReason: reason,
    }),
  });
  assert.equal(item(registry, "reasoning-cross-lead").disabledReason, reason);
  assert.equal(item(registry, "reasoning-cross-challenger").disabledReason, reason);
});

test("a Cross role sharing the main model shares its thinking entry — documented, not an inheritance bug", () => {
  const base = snapshot();
  const config = structuredClone(base.config);
  config.mainModel = CURRENT_MODEL_ID;
  config.reasoningByModel = { [CURRENT_MODEL_ID]: { mode: "effort", effort: "high" } };
  const registry = buildSettingsRegistry({
    ...base,
    config,
    cross: crossProjection({
      preferences: {
        lead: crossRoute(CURRENT_MODEL_ID),
        challenger: crossRoute("openai/cross-challenger"),
      },
    }),
  });
  const main = item(registry, "reasoning");
  const lead = item(registry, "reasoning-cross-lead");
  const challenger = item(registry, "reasoning-cross-challenger");
  assert.equal(main.disabledReason, undefined);
  assert.equal(lead.disabledReason, undefined);
  // Same model id as main -> same stored entry -> same value. Expected.
  assert.equal(main.displayValue, "high");
  assert.equal(lead.displayValue, "high");
  // The challenger is a genuinely different, uncached model id: it must
  // never silently borrow the shared lead/main value either.
  assert.equal(challenger.displayValue, reasoningLabel(DEFAULT_REASONING_SETTING));
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
        description: "Read only; file changes and shell commands are blocked. Reading credential files still asks first.",
      },
      {
        value: "ask",
        description: "Ask before file changes and every shell command.",
      },
      {
        value: "auto-edit",
        description: "File changes happen automatically; shell commands still ask first. Protected paths still ask regardless.",
      },
      {
        value: "allow-all",
        description: "File changes and shell commands run without asking. Dangerous. Only protected paths still ask.",
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

test("OpenRouter-Datenschutz erscheint genau einmal; Security-IDs bleiben nur Kompatibilitätstypen", () => {
  const registry = buildSettingsRegistry(snapshot());
  const pairs = [
    ["provider-data-collection", "security-provider-data-collection"],
    ["provider-only", "security-provider-only"],
    ["provider-ignore", "security-provider-ignore"],
  ] as const;
  for (const [providerId, securityId] of pairs) {
    const providerItem = item(registry, providerId);
    assert.ok(actionId(providerItem));
    assert.equal(registry.items.some(({ id }) => id === securityId), false);
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
    ["cross-lead-model", "cross-lead", false],
    ["cross-challenger-model", "cross-challenger", false],
    ["architect-executor-model", "architect-executor", false],
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
    ["low-balance-threshold", 0, 1_000, false, "USD"],
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

test("Kimi route keeps main selection available but disables unsupported compressor panel and audio rows truthfully", () => {
  const base = snapshot();
  base.config.mainModel = "k3";
  const current: SettingsAuthoritativeSnapshot = {
    ...base,
    route: {
      backendId: "kimi-code",
      providerLabel: "Kimi Code",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      modelLabel: "Kimi K3",
      billingRealm: "kimi-code-membership-provider-managed-overage",
    },
    cachedModels: [model("k3")],
  };

  const registry = buildSettingsRegistry(current);

  assert.equal(item(registry, "main-model").disabledReason, undefined);
  for (const id of ["compressor-model", "panel-models", "transcription-model"] as const) {
    assert.equal(
      item(registry, id).disabledReason,
      "Kimi Code doesn't support this external model role; an OpenRouter route is required",
      id,
    );
  }
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
      { id: "cross-pair-swap", actionId: "cross-pair-swap" },
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
      // V4-B: order follows the category's sections (each Thinking row under
      // the role it configures), not a Thinking block of its own.
      { id: "compression-mode", actionId: "compression-mode", values: ["off", "auto", "always"] },
      // The compressor model and both Cross roles are not part of this
      // snapshot's cachedModels and have no stored entry of their own, so
      // each falls back to the single "Saved · auto" option — exactly
      // like the main row does whenever its own catalog lookup misses.
      { id: "reasoning-compressor", actionId: "reasoning-compressor", values: ["auto"] },
      { id: "reasoning-cross-lead", actionId: "reasoning-cross-lead", values: ["auto"] },
      { id: "reasoning-cross-challenger", actionId: "reasoning-cross-challenger", values: ["auto"] },
      { id: "provider-sort", actionId: "provider-sort", values: ["off", "price", "throughput", "latency"] },
      { id: "provider-data-collection", actionId: "provider-data-collection", values: ["deny", "allow"] },
      { id: "provider-fallback", actionId: "provider-fallback", values: ["on", "off"] },
      { id: "approval-mode", actionId: "approval-mode", values: ["read-only", "ask", "auto-edit", "allow-all"] },
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
  assert.ok(searchSettings(registry, "Browser Startup").some(({ id }) => id === "browser-timeout"));
  assert.deepEqual(
    searchSettings(registry, "prufen").map(({ id }) => id),
    searchSettings(registry, "Prüfen").map(({ id }) => id),
  );
  assert.deepEqual(searchSettings(registry, "  "), registry.items);
  assert.deepEqual(searchSettings(registry, "nicht-vorhanden"), []);
});

// F7 (ruling 4): "current-route" (a second exact "route" alias hit) is
// gone; "main-model" alone already proves the exact tier, ahead of
// "appearance-large-logo"'s prefix hit ("route core") and
// "provider-status:openrouter"'s substring hit ("Default route").
test("Suche ordnet exakte Treffer vor Präfixen und Präfixe vor Enthalten", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.deepEqual(searchSettings(registry, "route").slice(0, 3).map(({ id }) => id), [
    "main-model",
    "appearance-large-logo",
    "provider-status:openrouter",
  ]);
});

// Fix round 1, M2: "current-route" carried a "provider" alias; folding it
// into "main-model" must carry that alias along too, or a "provider"
// search silently stops surfacing the row that shows route status.
test("Suche nach 'provider' findet weiterhin die Zeile mit dem Routenstatus", () => {
  const registry = buildSettingsRegistry(snapshot());
  assert.equal(searchSettings(registry, "provider")[0]?.id, "main-model");
  assert.equal(searchSettings(registry, "anbieter")[0]?.id, "main-model");
});

// Every canonical row from the pre-Phase-1 four-category registry keeps a
// home under the five job categories; none was silently dropped while the
// `Mehr` catch-all was dismantled. This mirrors the mapping table in the
// task report. F7 (ruling 4): "current-route" retired, folded into
// "main-model"'s own detail line.
const EXPECTED_STATIC_ROW_CATEGORIES: Readonly<Record<string, SettingsCategoryId>> = {
  "main-model": "models",
  reasoning: "models",
  "reasoning-compressor": "models",
  "reasoning-cross-lead": "models",
  "reasoning-cross-challenger": "models",
  "compression-mode": "models",
  "compressor-model": "models",
  // FIX-15: this row moved to the category that reasons about limits.
  // (`low-balance-threshold` is deliberately absent from this map — see the
  // exclusion note below — and its new home is asserted by the cluster test.)
  "compressor-max-cost": "approvals-costs",
  "cross-lead-model": "models",
  "cross-challenger-model": "models",
  "cross-pair-swap": "models",
  "provider-setup": "accounts",
  "provider-sort": "accounts",
  "provider-fallback": "accounts",
  "provider-data-collection": "approvals-costs",
  "provider-only": "approvals-costs",
  "provider-ignore": "approvals-costs",
  "approval-mode": "approvals-costs",
  "approval-forget-all": "approvals-costs",
  "max-cost": "approvals-costs",
  "budget-daily": "approvals-costs",
  "budget-total": "approvals-costs",
  "budget-on-exceed": "approvals-costs",
  "cost-summary": "approvals-costs",
  "max-steps": "approvals-costs",
  "verify-mode": "tools",
  "verify-commands": "tools",
  "verify-suggest": "tools",
  "verify-clear": "tools",
  "verify-repair-rounds": "tools",
  "web-mode": "tools",
  "browser-path": "tools",
  "browser-timeout": "tools",
  "panel-models": "tools",
  "panel-judge": "tools",
  "transcription-model": "tools",
  "voice-consent-status": "tools",
  "voice-consent-clear": "tools",
  "appearance-large-logo": "appearance",
  "appearance-header-mark": "appearance",
  "appearance-glyph-mode": "appearance",
};

test("jede vormals vorhandene Zeile ist weiterhin vorhanden und trägt ihre neue Kategorie", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({ ...base, providers: [], approvalRules: [] });
  const byId = new Map(registry.items.map((entry) => [entry.id, entry]));
  const expectedIds = Object.keys(EXPECTED_STATIC_ROW_CATEGORIES);

  for (const id of expectedIds) {
    const found = byId.get(id as SettingsItem["id"]);
    assert.ok(found, `Zeile ${id} wurde beim Umbau der Kategorien fallengelassen`);
    assert.equal(
      found.categoryId,
      EXPECTED_STATIC_ROW_CATEGORIES[id],
      `Zeile ${id} liegt in der falschen neuen Kategorie`,
    );
  }

  // No extra static row appeared, and no static row still points at a
  // retired category id. `low-balance-threshold` is excluded on purpose: it
  // is a genuinely new row D6 added (not one that "formerly existed" and
  // got recategorized, which is this map's whole job) — its own placement
  // is covered by the "efficiency cluster" test below instead.
  // `architect-executor-model` (Phase 14) is excluded for the identical
  // reason — a genuinely new row, covered by its own test below.
  const staticIds = registry.items
    .map(({ id }) => id)
    .filter((id) => !id.includes(":") && id !== "low-balance-threshold" && id !== "architect-executor-model");
  assert.deepEqual([...staticIds].sort(), [...expectedIds].sort());
  assert.equal(registry.items.some(({ categoryId }) => !SETTINGS_CATEGORY_IDS.includes(categoryId)), false);
});

test("globale Suche findet Effizienzzeilen über 'effizienz' und 'efficiency'", () => {
  const registry = buildSettingsRegistry(snapshot());
  for (const query of ["effizienz", "efficiency"]) {
    const ids = searchSettings(registry, query).map(({ id }) => id);
    assert.ok(ids.includes("compressor-model"), query);
    assert.ok(ids.includes("compression-mode"), query);
    assert.ok(ids.includes("compressor-max-cost"), query);
    // D6: the low-balance threshold joined this same efficiency cluster —
    // it must be searchable by the identical terms, not a silent addition.
    assert.ok(ids.includes("low-balance-threshold"), query);
  }
});

test("Mehr/more existiert als Kategorie-ID nicht mehr", () => {
  assert.equal((SETTINGS_CATEGORY_IDS as readonly string[]).includes("more"), false);
  const registry = buildSettingsRegistry(snapshot());
  assert.equal(registry.categories.some(({ id }) => (id as string) === "more"), false);
  assert.equal(registry.categories.some(({ label }) => label === "Mehr"), false);
  assert.equal(registry.items.some(({ categoryId }) => (categoryId as string) === "more"), false);
});

test("Cross rows land directly after the efficiency cluster with English copy and required aliases", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    cross: crossProjection(),
  });
  const modelsOrder = registry.items
    .filter(({ categoryId }) => categoryId === "models")
    .map(({ id }) => id);
  // FIX-15 moved this anchor DELIBERATELY. The test exists to pin that the
  // Cross rows sit directly after the summarizer cluster, with nothing
  // wedged between them — that is still exactly what it asserts. What
  // changed is where the cluster ENDS: the summarizer COST CAP and the
  // low-balance warning went to Approvals & Costs (they cap spending; they
  // do not choose a model), so "compressor-model" is now the last row before
  // Cross, and the two departed rows must no longer appear here at all.
  // V4-B moved the anchor once more, and for the same kind of reason: the
  // summarizer cluster now ENDS with its own thinking row (`Summarizing` holds
  // the model and its think level), and the Cross section opens immediately
  // after it. Nothing is wedged between the two clusters — the subject of this
  // test — and the swap row stays with the pair it swaps.
  const clusterEnd = modelsOrder.indexOf("reasoning-compressor");
  assert.equal(clusterEnd >= 0, true);
  assert.deepEqual(
    modelsOrder.slice(clusterEnd + 1, clusterEnd + 3),
    ["cross-lead-model", "cross-challenger-model"],
  );
  assert.equal(
    modelsOrder.indexOf("cross-pair-swap") > modelsOrder.indexOf("cross-challenger-model"),
    true,
  );
  for (const departed of ["compressor-max-cost", "low-balance-threshold"] as const) {
    assert.equal(modelsOrder.includes(departed), false, departed);
  }
  // And they land together, in the category that reasons about limits.
  const costsOrder = registry.items
    .filter(({ categoryId }) => categoryId === "approvals-costs")
    .map(({ id }) => id);
  for (const arrived of ["max-steps", "compressor-max-cost", "low-balance-threshold"] as const) {
    assert.equal(costsOrder.includes(arrived), true, arrived);
  }

  const lead = item(registry, "cross-lead-model");
  assert.equal(lead.label, "Cross: coding model");
  // P15 item 1 + fix round 1 (L3): the pair row discloses the role's think
  // level ahead of its static explanation (the same F7 composition
  // `main-model` uses) — but ONLY once the role has a model. This snapshot
  // has no Cross pair, so there is no level to name and the row is exactly
  // its static explanation, matching what the gate shows for an unset role.
  assert.equal(lead.description, "Default coding model for Cross — writes files");
  assert.equal(lead.displayValue, "Not set", "…which is the value the description must agree with");
  assert.equal(lead.editor.kind, "model");
  if (lead.editor.kind === "model") assert.equal(lead.editor.filter, "cross-lead");
  assert.equal(lead.affectsActiveRun, false);
  assert.equal(lead.disabledReason, undefined);

  const challenger = item(registry, "cross-challenger-model");
  assert.equal(challenger.label, "Cross: review model");
  assert.equal(challenger.description, "Default review model for Cross — read-only");
  assert.equal(challenger.displayValue, "Not set");
  assert.equal(challenger.editor.kind, "model");
  if (challenger.editor.kind === "model") assert.equal(challenger.editor.filter, "cross-challenger");
  assert.equal(challenger.affectsActiveRun, false);
  assert.equal(challenger.disabledReason, undefined);

  const swap = item(registry, "cross-pair-swap");
  assert.equal(swap.label, "Swap Cross pair");
  assert.equal(swap.description, "Exchange the coding and review roles");
  assert.equal(swap.displayValue, "Swap");
  assert.deepEqual(swap.editor, { kind: "invoke", actionId: "cross-pair-swap" });
  assert.equal(swap.affectsActiveRun, false);
  assert.equal(swap.disabledReason, "Both roles must be set before swapping", "an incomplete pair cannot swap");

  for (const row of [lead, challenger, swap]) {
    for (const required of ["cross", "lead", "challenger", "review"]) {
      assert.ok(row.aliases.includes(required), `${row.id} missing alias ${required}`);
    }
  }
});

// Phase 14 (ruling 2): "Settings row beside the Cross pair rows" — same
// external-action pattern, same model editor kind, unset shows "Not set"
// (never a fabricated default), and (ruling 5) disabled the same way
// compressor-model already is when the current session route is Kimi Code.
test("architect-executor-model row: unset shows Not set, set shows the route, disabled on Kimi routes", () => {
  const base = snapshot();

  const unset = buildSettingsRegistry(base);
  const row = item(unset, "architect-executor-model");
  assert.equal(row.label, "Architect: executor model");
  assert.equal(row.displayValue, "Not set");
  assert.equal(row.editor.kind, "model");
  if (row.editor.kind === "model") assert.equal(row.editor.filter, "architect-executor");
  assert.equal(row.affectsActiveRun, false);
  assert.equal(row.disabledReason, undefined);
  for (const required of ["architect", "executor", "planner"]) {
    assert.ok(row.aliases.includes(required), `architect-executor-model missing alias ${required}`);
  }

  const withRoute = buildSettingsRegistry({
    ...base,
    config: { ...base.config, architectExecutor: crossRoute("openai/executor-a") },
  });
  assert.equal(item(withRoute, "architect-executor-model").displayValue, "openai/executor-a");

  const onKimi = buildSettingsRegistry({
    ...base,
    route: { ...base.route!, backendId: "kimi-code" },
  });
  assert.equal(
    item(onKimi, "architect-executor-model").disabledReason,
    "Architect is unavailable on Kimi Code routes",
  );
  // Fix round 1, finding 5: the row's disabled state IS the one predicate
  // `/architect` itself gates on — not a second inline backend check that
  // could be extended in one place and forgotten in the other.
  const kimiRoute = { ...base.route!, backendId: "kimi-code" as const };
  assert.equal(
    item(onKimi, "architect-executor-model").disabledReason,
    architectUnavailableReasonForRoute(kimiRoute),
  );
  assert.equal(architectUnavailableReasonForRoute(base.route), null, "a non-Kimi route leaves the row enabled");
  assert.equal(architectUnavailableReasonForRoute(null), null, "no resolved route is not a Kimi route");
});

test("Cross model rows show a staged hint on the half-set role and a clean label once both roles persist", () => {
  const base = snapshot();

  const bothSet = buildSettingsRegistry({
    ...base,
    cross: crossProjection({
      preferences: { lead: crossRoute("openai/lead-a"), challenger: crossRoute("openai/challenger-a") },
    }),
  });
  assert.equal(item(bothSet, "cross-lead-model").displayValue, "openai/lead-a");
  assert.equal(item(bothSet, "cross-challenger-model").displayValue, "openai/challenger-a");
  assert.equal(item(bothSet, "cross-pair-swap").disabledReason, undefined);

  const leadStaged = buildSettingsRegistry({
    ...base,
    cross: crossProjection({ preferences: { lead: crossRoute("openai/lead-b"), challenger: null } }),
  });
  assert.equal(item(leadStaged, "cross-lead-model").displayValue, "openai/lead-b · staged");
  assert.equal(item(leadStaged, "cross-challenger-model").displayValue, "Not set");
  assert.equal(
    item(leadStaged, "cross-pair-swap").disabledReason,
    "Both roles must be set before swapping",
  );

  const challengerStaged = buildSettingsRegistry({
    ...base,
    cross: crossProjection({ preferences: { lead: null, challenger: crossRoute("openai/challenger-b") } }),
  });
  assert.equal(item(challengerStaged, "cross-lead-model").displayValue, "Not set");
  assert.equal(item(challengerStaged, "cross-challenger-model").displayValue, "openai/challenger-b · staged");
});

test("an unavailable Cross bridge disables all three rows with the concrete English reason but keeps the stored pair visible", () => {
  const base = snapshot();
  const reason = "Cross is unavailable on Kimi Code routes";
  const registry = buildSettingsRegistry({
    ...base,
    route: {
      backendId: "kimi-code",
      providerLabel: "Kimi Code",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      modelLabel: "Kimi K3",
      billingRealm: "kimi-code-membership-provider-managed-overage",
    },
    cross: crossProjection({
      preferences: { lead: crossRoute("openai/lead-c"), challenger: crossRoute("openai/challenger-c") },
      available: false,
      unavailableReason: reason,
    }),
  });
  for (const id of ["cross-lead-model", "cross-challenger-model", "cross-pair-swap"] as const) {
    assert.equal(item(registry, id).disabledReason, reason, id);
  }
  // Availability gates editing only; the configured pair itself stays visible.
  assert.equal(item(registry, "cross-lead-model").displayValue, "openai/lead-c");
  assert.equal(item(registry, "cross-challenger-model").displayValue, "openai/challenger-c");
});

test("Cross rows never let an account fingerprint reach a display value", () => {
  const base = snapshot();
  const registry = buildSettingsRegistry({
    ...base,
    cross: crossProjection({
      preferences: {
        lead: crossRoute("openai/fingerprint-lead", "CROSS_FINGERPRINT_SENTINEL_LEAD"),
        challenger: crossRoute("openai/fingerprint-challenger", "CROSS_FINGERPRINT_SENTINEL_CHALLENGER"),
      },
    }),
  });
  const rendered = JSON.stringify(registry);
  assert.equal(rendered.includes("CROSS_FINGERPRINT_SENTINEL_LEAD"), false);
  assert.equal(rendered.includes("CROSS_FINGERPRINT_SENTINEL_CHALLENGER"), false);
});

test("FIX-18 (F3): the Models row value states the runtime's not-connected reality instead of contradicting the route status", () => {
  const disconnected: SettingsAuthoritativeSnapshot = {
    ...snapshot(),
    route: null,
    routeRunnable: false,
  };
  const registry = buildSettingsRegistry(disconnected);
  const row = item(registry, "main-model");
  assert.equal(row.displayValue, "GPT-5.4 · openai/gpt-5.4 · not connected");
  assert.match(row.description, /No active route/);

  // A runnable route keeps the exact pre-existing value — and an UNKNOWN
  // predicate (older snapshot sources without the field) claims nothing.
  assert.equal(
    item(buildSettingsRegistry({ ...snapshot(), routeRunnable: true }), "main-model").displayValue,
    "GPT-5.4 · openai/gpt-5.4",
  );
  assert.equal(
    item(buildSettingsRegistry(snapshot()), "main-model").displayValue,
    "GPT-5.4 · openai/gpt-5.4",
  );
});

test("P15: the Cross pair rows disclose each role's own think level, from the same store their thinking rows edit", () => {
  const base = snapshot();
  const config = structuredClone(base.config);
  config.reasoningByModel = {
    ...config.reasoningByModel,
    "role/lead": { mode: "effort", effort: "xhigh" },
    "role/challenger": { mode: "budget", maxTokens: 4_000 },
  };
  const registry = buildSettingsRegistry({
    ...base,
    config,
    cross: crossProjection({
      preferences: { lead: crossRoute("role/lead"), challenger: crossRoute("role/challenger") },
    }),
  });

  // The pair row's disclosed level is character-identical to the value the
  // role's own thinking row displays — one mechanism, never a second lookup.
  const leadThinking = item(registry, "reasoning-cross-lead").displayValue;
  const challengerThinking = item(registry, "reasoning-cross-challenger").displayValue;
  assert.equal(leadThinking, "ultra (xhigh)");
  assert.equal(challengerThinking, "4K");
  assert.equal(
    item(registry, "cross-lead-model").description,
    `Thinking ${leadThinking} · Default coding model for Cross — writes files`,
  );
  assert.equal(
    item(registry, "cross-challenger-model").description,
    `Thinking ${challengerThinking} · Default review model for Cross — read-only`,
  );

  // The pair row stays a model picker: exposing the level added no second
  // editor for it (the "Thinking · Cross …" rows remain the one editor).
  assert.equal(item(registry, "cross-lead-model").editor.kind, "model");
  assert.equal(item(registry, "cross-challenger-model").editor.kind, "model");

  // Fix round 1 (L3): a role with no model names no level. Before this the
  // row read "Thinking auto · …" next to its own "Not set" value — a think
  // level for a model that does not exist — while the gate refused to do the
  // same. Half-set pairs are the sharp case: one role discloses, one does not.
  const halfSet = buildSettingsRegistry({
    ...base,
    config,
    cross: crossProjection({ preferences: { lead: crossRoute("role/lead"), challenger: null } }),
  });
  assert.equal(
    item(halfSet, "cross-lead-model").description,
    "Thinking ultra (xhigh) · Default coding model for Cross — writes files",
  );
  assert.equal(
    item(halfSet, "cross-challenger-model").description,
    "Default review model for Cross — read-only",
    "an unset role names no think level",
  );
  assert.equal(item(halfSet, "cross-challenger-model").displayValue, "Not set");
});
