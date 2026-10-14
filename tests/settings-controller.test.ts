import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NOTICE_KINDS } from "../src/types.js";
import { DesktopSettingsController, type DesktopSettingsCorePort } from "../src/desktop-settings.js";

import {
  ConfigEditConflictError,
  ConfigEditUnverifiedError,
  DEFAULT_CONFIG,
  loadConfig,
  readConfigEditSnapshot,
  saveConfig,
  saveConfigEdit,
  validateConfig,
  type ConfigEditSnapshot,
  type ConfigInput,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import {
  SETTINGS_READ_ONLY_REASONS,
  SettingsController,
  SettingsRunActiveError,
  applyConfigAction,
  externalActionSuccessNotice,
  type SettingsConfigAction,
  type SettingsControllerDependencies,
  type SettingsControllerSnapshot,
  type SettingsEditorRequest,
  type SettingsExternalAction,
  type SettingsExternalActionOutcome,
  type SettingsIntent,
} from "../src/settings-controller.js";
import {
  runSettingsSession,
  SettingsEditorOpenError,
  type SettingsSurface,
} from "../src/settings-session.js";
import type { SelectableModelRoute } from "../src/model-route-catalog.js";
import { sameCanonicalModelRoute } from "../src/model-route-catalog.js";
import {
  type SettingsItemId,
  type SettingsItem,
  SETTINGS_CATEGORY_IDS,
  type SettingsCrossProjection,
} from "../src/settings-registry.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import type { CrossPreferencesV1 } from "../src/collaboration.js";

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

function runtimeSnapshot(
  config: OrcodeConfigWithBudget = structuredClone(DEFAULT_CONFIG),
  runActive = false,
): SettingsControllerSnapshot {
  return {
    config,
    runActive,
    route: null,
    providers: [],
    approvalRules: [],
    costs: {
      costKnowledge: "unknown",
      sessionUsd: 0,
      dayUsd: 0,
      totalUsd: 0,
    },
    cachedModels: [],
    cross: crossProjection(),
  };
}

function selectableSettingsRoute(
  requestedModelId: string,
  backendId: "openrouter" | "kimi-code" = "openrouter",
): SelectableModelRoute {
  const kimi = backendId === "kimi-code";
  return {
    route: {
      version: 1,
      backendId,
      accountFingerprint: kimi ? "acct_kimi_settings" : "acct_openrouter_settings",
      billingRealm: kimi
        ? "kimi-code-membership-provider-managed-overage"
        : "openrouter-payg",
      requestedModelId,
      canonicalModelId: requestedModelId,
      resolutionState: "resolved",
    },
    providerLabel: kimi ? "Kimi Code" : "OpenRouter",
    model: {
      id: requestedModelId,
      name: requestedModelId,
      contextLength: 128_000,
      reasoning: undefined,
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: false,
  };
}

function routeIntent(name: string) {
  return { handle: `handle:${name}`, revision: 7, generation: 3 } as const;
}

function fullConfigFromProjection(
  config: SettingsControllerSnapshot["config"],
): OrcodeConfigWithBudget {
  return validateConfig({
    ...structuredClone(config),
    providerSetup: structuredClone(DEFAULT_CONFIG.providerSetup),
  });
}

const RULE_ID = "11111111-1111-4111-8111-111111111111";

function completeRuntimeSnapshot(): SettingsControllerSnapshot {
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = "openai/test-main";
  config.compressorModel = "openai/test-compressor";
  config.verify.commands = ["npm test"];
  config.voiceConsentGiven = true;
  return {
    ...runtimeSnapshot(config),
    providers: [
      {
        backendId: "openrouter",
        displayName: "OpenRouter",
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
        isDefault: true,
        selectedModel: null,
        allowedActions: ["connect", "enable", "disable", "disconnect", "reconnect", "models", "logout"],
      },
      {
        backendId: "kimi-code",
        displayName: "Kimi Code",
        availability: "connectable",
        configuration: "enabled",
        maturity: "preview",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        headline: "ready",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
        },
        isDefault: false,
        selectedModel: null,
        allowedActions: ["connect", "enable", "disable", "reconnect", "models", "logout"],
      },
    ],
    approvalRules: [{ id: RULE_ID, decision: "allow" }],
    cachedModels: [
      {
        id: "openai/test-main",
        canonicalSlug: "openai/test-main-canonical",
        name: "Test Main",
        description: "test",
        contextLength: 100_000,
        promptPrice: 0,
        completionPrice: 0,
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: {
          mandatory: false,
          supportedEfforts: ["low", "medium", "high"],
          supportsMaxTokens: true,
        },
      },
      {
        id: "openai/test-compressor",
        name: "Test Compressor",
        description: "test",
        contextLength: 100_000,
        promptPrice: 0,
        completionPrice: 0,
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: {
          mandatory: false,
          supportedEfforts: ["low", "medium", "high"],
          supportsMaxTokens: true,
        },
      },
      {
        id: "audio/test-model",
        name: "Test Audio",
        description: "test",
        contextLength: 100_000,
        promptPrice: 0,
        completionPrice: 0,
        supportedParameters: [],
        inputModalities: ["text", "audio"],
        outputModalities: ["text"],
      },
      // Both Cross roles below (cross/test-lead, cross/test-challenger) need
      // their own catalog entry too, so their "Thinking · Cross ..." rows are
      // actionable in the completeness sweep instead of falling back to the
      // uncached-model "Model catalog not available" gate.
      {
        id: "cross/test-lead",
        name: "Test Cross Lead",
        description: "test",
        contextLength: 100_000,
        promptPrice: 0,
        completionPrice: 0,
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: {
          mandatory: false,
          supportedEfforts: ["low", "medium", "high"],
          supportsMaxTokens: true,
        },
      },
      {
        id: "cross/test-challenger",
        name: "Test Cross Challenger",
        description: "test",
        contextLength: 100_000,
        promptPrice: 0,
        completionPrice: 0,
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: {
          mandatory: false,
          supportedEfforts: ["low", "medium", "high"],
          supportsMaxTokens: true,
        },
      },
    ],
    // Both roles pre-set so cross-pair-swap is exercised as an actionable row too.
    cross: crossProjection({
      preferences: {
        lead: crossRoute("cross/test-lead"),
        challenger: crossRoute("cross/test-challenger"),
      },
    }),
  };
}

async function withTempConfig(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orcode-settings-controller-"));
  try {
    await run(join(directory, "config.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface HarnessOptions {
  readonly runActive?: boolean;
  readonly initialSnapshot?: SettingsControllerSnapshot;
  readonly failSnapshotReadAt?: number;
  readonly snapshotForRead?: (
    snapshot: SettingsControllerSnapshot,
    readCount: number,
  ) => SettingsControllerSnapshot;
  readonly readConfig?: (path: string) => Promise<ConfigEditSnapshot>;
  /**
   * What this process knows the file to hold when Settings opens — the value
   * a real startup seeds from its own config load. A test that wants a
   * FOREIGN write lets `readConfig` answer with something else.
   */
  readonly baseline?: OrcodeConfigWithBudget;
  readonly saveConfig?: SettingsControllerDependencies["saveConfig"];
  readonly executeExternal?: (action: SettingsExternalAction) => Promise<SettingsExternalActionOutcome | void>;
  readonly prepareLive?: SettingsControllerDependencies["liveConfig"]["prepare"];
  readonly runConfigMutation?: SettingsControllerDependencies["runConfigMutation"];
}

function harness(
  path: string,
  options: HarnessOptions = {},
): {
  readonly events: string[];
  readonly published: OrcodeConfigWithBudget[];
  readonly externalActions: SettingsExternalAction[];
  setRunActive(value: boolean): void;
  readonly dependencies: SettingsControllerDependencies;
} {
  const events: string[] = [];
  const published: OrcodeConfigWithBudget[] = [];
  const externalActions: SettingsExternalAction[] = [];
  let snapshotReads = 0;
  let defaultEditSnapshot: ConfigEditSnapshot | null = null;
  // What this process knows the file to hold. A real run seeds it from the
  // startup config load; here the first `readConfig` stands in for that load,
  // so every later read is the guard's own and can differ from it. A test that
  // wants a FOREIGN write already on the first read supplies `baseline`.
  let baseline: OrcodeConfigWithBudget = structuredClone(
    options.baseline ?? DEFAULT_CONFIG,
  );
  let baselineSeeded = options.baseline !== undefined;
  let current = options.initialSnapshot
    ? structuredClone(options.initialSnapshot)
    : runtimeSnapshot(
        structuredClone(DEFAULT_CONFIG),
        options.runActive ?? false,
      );
  return {
    events,
    published,
    externalActions,
    setRunActive(value) {
      current = { ...current, runActive: value };
    },
    dependencies: {
      configPath: path,
      snapshots: {
        async read() {
          snapshotReads += 1;
          events.push(snapshotReads === 1 ? "open-snapshot" : snapshotReads === 2 ? "read-snapshot" : "refresh");
          if (snapshotReads === options.failSnapshotReadAt) {
            throw new Error("private-refresh-failure");
          }
          return options.snapshotForRead?.(
            structuredClone(current),
            snapshotReads,
          ) ?? current;
        },
      },
      externalActions: {
        async execute(action) {
          events.push("external-action");
          externalActions.push(action);
          // FIX-14 ticket 14: the port reports its outcome. A double that
          // supplies no `executeExternal` did the thing, so it says so;
          // a case that wants the "changed nothing" path returns it.
          return await options.executeExternal?.(action) ?? { kind: "changed" };
        },
      },
      liveConfig: {
        prepare: options.prepareLive ?? ((config) => {
          events.push("validate-candidate");
          return {
            publish() {
              events.push("publish-live");
              published.push(config);
              current = { ...current, config };
            },
          };
        }),
      },
      async readConfig(configPath) {
        const snapshot = options.readConfig
          ? await options.readConfig(configPath)
          : (defaultEditSnapshot ??= await readConfigEditSnapshot(configPath));
        if (!baselineSeeded) {
          baselineSeeded = true;
          baseline = structuredClone(snapshot.config);
        }
        return snapshot;
      },
      // Exactly the production contract: seeded by what this process loaded,
      // moved only by a publication this process proved — never by a read.
      configBaseline: {
        read: () => baseline,
        note(config) {
          baseline = structuredClone(config);
        },
      },
      saveConfig: async (expected, candidate, configPath) => {
        const saved = options.saveConfig
          ? await options.saveConfig(expected, candidate, configPath)
          : await (async () => {
              events.push("persist-start");
              const validated = validateConfig(candidate);
              events.push("persist-done");
              return validated;
            })();
        baseline = structuredClone(saved);
        if (!options.readConfig && defaultEditSnapshot) {
          defaultEditSnapshot = {
            file: defaultEditSnapshot.file,
            config: structuredClone(saved),
          };
        }
        return saved;
      },
      ...(options.runConfigMutation
        ? { runConfigMutation: options.runConfigMutation }
        : {}),
    },
  };
}

test("Config-Persistenz und Live-Publikation bleiben innerhalb eines atomaren Aktivitäts-Fence", async () => {
  await withTempConfig(async (path) => {
    const events: string[] = [];
    let insideFence = false;
    const setup = harness(path, {
      runConfigMutation: async (task) => {
        events.push("fence-enter");
        insideFence = true;
        try { return await task(); } finally {
          insideFence = false;
          events.push("fence-exit");
        }
      },
      saveConfig: async (_expected, candidate) => {
        assert.equal(insideFence, true);
        events.push("persist");
        return validateConfig(candidate);
      },
      prepareLive: (candidate) => ({
        publish() {
          assert.equal(insideFence, true);
          events.push("publish");
          void candidate;
        },
      }),
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.deepEqual(events, ["fence-enter", "persist", "publish", "fence-exit"]);
  });
});

test("Idle-zu-Busy am Mutations-Fence schreibt und publiziert nichts und aktualisiert Lauf aktiv", async () => {
  await withTempConfig(async (path) => {
    let tasks = 0;
    const setup = harness(path, {
      runConfigMutation: async () => {
        setup.setRunActive(true);
        throw new SettingsRunActiveError();
      },
      saveConfig: async () => {
        tasks += 1;
        throw new Error("unreachable");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(tasks, 0);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.runActive, true);
    assert.equal(controller.view.notice?.message, "Run active");
  });
});

test("open wählt Kategorie eins und behält stabile Zeilen beim Navigieren, Suchen und Zurückgehen", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(controller.view.selectedCategoryId, "models");
    assert.equal(controller.view.selectedItemId, "main-model");

    await controller.dispatch({ kind: "move", delta: -1 });
    assert.equal(controller.view.selectedItemId, "main-model");
    await controller.dispatch({ kind: "move", delta: 1 });
    const remembered = controller.view.selectedItemId;

    await controller.dispatch({ kind: "category", categoryId: "tools" });
    assert.equal(controller.view.selectedItemId, "verify-mode");
    await controller.dispatch({ kind: "category", categoryId: "models" });
    assert.equal(controller.view.selectedItemId, remembered);

    await controller.dispatch({ kind: "search-start" });
    await controller.dispatch({ kind: "search-change", query: "ascii" });
    assert.equal(controller.view.search.active, true);
    assert.equal(controller.view.selectedItemId, "appearance-glyph-mode");
    assert.equal((await controller.dispatch({ kind: "back" })).kind, "render");
    assert.equal(controller.view.search.active, false);
    assert.equal(controller.view.selectedItemId, remembered);
    assert.equal((await controller.dispatch({ kind: "back" })).kind, "close");
  });
});

/**
 * V4-B (pin moved deliberately — justification): this used to be "Esc
 * verlässt eine ausgeklappte Unterebene um genau eine Stufe" and pinned F6
 * addendum (b)'s collapse step. The `More settings …` mechanism is deleted,
 * so a category HAS no sub-level any more: the whole category is one list.
 * What survives is the half of that ruling that still has a level to talk
 * about — the search — plus the fact that Esc at the category level closes,
 * which is exactly what the new action bar's `Esc back` chip promises.
 */
test("eine tiefe Zeile ist ohne Zwischenstufe erreichbar, und Esc schließt von dort", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    await controller.dispatch({ kind: "category", categoryId: "tools" });
    // `browser-path` used to sit behind the "More settings …" row; it is now
    // simply one of the category's rows, reachable by pointing at it.
    await controller.dispatch({ kind: "select-item", itemId: "browser-path" });
    assert.equal(controller.view.selectedItemId, "browser-path");
    assert.equal(controller.view.items.some(({ id }) => id === "browser-path"), true);
    assert.equal((await controller.dispatch({ kind: "back" })).kind, "close");
  });
});

test("eine per Deep-Link gewählte Zeile bleibt in ihrer Kategorie sichtbar", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "compressor-model" });
    assert.equal(controller.view.selectedItemId, "compressor-model");
    assert.equal(
      controller.view.items.some(({ id }) => id === "compressor-model"),
      true,
    );
    assert.equal((await controller.dispatch({ kind: "back" })).kind, "close");
  });
});

test("Esc räumt Suche und Settings in genau dieser Reihenfolge ab", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    await controller.dispatch({ kind: "category", categoryId: "tools" });
    await controller.dispatch({ kind: "select-item", itemId: "browser-path" });
    await controller.dispatch({ kind: "search-start" });
    await controller.dispatch({ kind: "search-change", query: "browser" });

    assert.equal((await controller.dispatch({ kind: "back" })).kind, "render");
    assert.equal(controller.view.search.active, false);
    assert.equal(controller.view.selectedItemId, "browser-path");
    assert.equal((await controller.dispatch({ kind: "back" })).kind, "close");
  });
});

test("Enter auf einer gesperrten Zeile bleibt in Settings und nennt den Grund", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(
      harness(path, { runActive: true }).dependencies,
    );
    const locked = controller.view.items.find(
      ({ disabledReason }) => disabledReason !== undefined,
    );
    assert.ok(locked, "Fixture braucht mindestens eine gesperrte Zeile");
    await controller.dispatch({ kind: "select-item", itemId: locked.id });
    const effect = await controller.dispatch({ kind: "activate" });
    // Never "edit" (which could fail while opening and take the surface with
    // it) and never "close" — the reason is voiced inside Settings.
    assert.equal(effect.kind, "render");
    assert.deepEqual(controller.view.notice, {
      kind: "info",
      message: locked.disabledReason,
    });
  });
});

/**
 * V4-B (pin moved deliberately — justification): this used to be "fünf
 * Bereiche halten alle realen Zeilen genau einmal über Common und Advanced
 * erreichbar", and it asserted a four-row ceiling per category plus a
 * synthetic `More settings …` row. Both are gone: the mockup's ruling is
 * "alles sichtbar statt `More settings …`", so a category's visible list IS
 * its whole list. The invariant this test exists for — every real row
 * reachable exactly once, no row lost, no row duplicated — is unchanged and
 * is now simply the identity of the two lists.
 */
test("fünf Bereiche zeigen alle realen Zeilen genau einmal, ohne verborgene Stufe", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path, {
      initialSnapshot: completeRuntimeSnapshot(),
    }).dependencies);
    assert.deepEqual(controller.view.categories.map(({ id }) => id), SETTINGS_CATEGORY_IDS);
    // F7 (ruling 4): "current-route" folded into "main-model"'s own detail
    // line and retired as its own row.
    assert.deepEqual(controller.view.items.map(({ id }) => id).slice(0, 2), [
      "main-model",
      "reasoning",
    ]);
    await controller.dispatch({ kind: "category", categoryId: "accounts" });
    assert.equal(controller.view.items[0]?.id, "provider-setup");
    await controller.dispatch({ kind: "category", categoryId: "appearance" });
    assert.deepEqual(controller.view.items.map(({ id }) => id), [
      "appearance-large-logo",
      "appearance-header-mark",
      "appearance-glyph-mode",
    ]);

    const expected = controller.view.allItems.map(({ id }) => id);
    const reached: string[] = [];
    for (const categoryId of SETTINGS_CATEGORY_IDS) {
      await controller.dispatch({ kind: "category", categoryId });
      // No ceiling, and no synthetic row: what the category holds is what
      // the reader can scroll through.
      assert.equal(
        controller.view.items.every((item) => item.categoryId === categoryId),
        true,
        categoryId,
      );
      reached.push(...controller.view.items.map(({ id }) => id));
    }
    assert.equal(new Set(reached).size, reached.length);
    assert.deepEqual([...reached].sort(), [...expected].sort());

    await controller.dispatch({ kind: "category", categoryId: "models" });
    await controller.dispatch({ kind: "search-start" });
    await controller.dispatch({ kind: "search-change", query: "Browser path" });
    assert.deepEqual(controller.view.items.map(({ id }) => id), ["browser-path"]);
  });
});

test("Suche findet Effizienzzeilen unabhängig vom aktuell fokussierten Bereich", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    // "appearance" holds none of the efficiency rows; search must still
    // surface them globally instead of staying scoped to this category.
    await controller.dispatch({ kind: "category", categoryId: "appearance" });
    for (const query of ["effizienz", "efficiency"]) {
      await controller.dispatch({ kind: "search-start" });
      await controller.dispatch({ kind: "search-change", query });
      const ids = controller.view.items.map(({ id }) => id);
      assert.ok(ids.includes("compressor-model"), query);
      assert.ok(ids.includes("compression-mode"), query);
      assert.ok(ids.includes("compressor-max-cost"), query);
      await controller.dispatch({ kind: "back" });
      assert.equal(controller.view.selectedCategoryId, "appearance", query);
    }
  });
});

/**
 * V4-B (pin moved deliberately — justification): this used to assert that a
 * problematic provider was PROMOTED to the top of Accounts, together with one
 * repair action. That ordering existed only to win one of the three visible
 * slots the `More settings …` ceiling left — with the ceiling deleted there
 * is nothing to win: every provider row and every repair action is in the one
 * scrollable list. What still has to be true, and is asserted here, is that
 * the repair action exists and sits with the status row it repairs.
 */
test("Konten zeigt zu einem problematischen Provider die echte Reparaturaktion direkt an seiner Statuszeile", async () => {
  await withTempConfig(async (path) => {
    const base = completeRuntimeSnapshot();
    const controller = await SettingsController.open(harness(path, {
      initialSnapshot: {
        ...base,
        providers: base.providers.map((provider) => provider.backendId === "kimi-code"
          ? { ...provider, configuration: "disabled" as const, headline: "login-required" as const }
          : provider),
      },
    }).dependencies);
    await controller.dispatch({ kind: "category", categoryId: "accounts" });
    const ids = controller.view.items.map(({ id }) => id);
    const status = ids.indexOf("provider-status:kimi-code");
    assert.ok(status >= 0, "the broken provider must have a status row");
    assert.equal(ids[status + 1], "provider-action:kimi-code:connect");
    assert.equal(ids.includes("provider-status:openrouter"), true);
  });
});

test("Nano-GPT Settings actions keep their provider identity through core and desktop navigation", async () => {
  await withTempConfig(async (path) => {
    const base = completeRuntimeSnapshot();
    const setup = harness(path, { initialSnapshot: { ...base, providers: [{
      ...base.providers[0]!, backendId: "nano-gpt", displayName: "Nano-GPT", maturity: "preview",
      billingRealm: "nanogpt-subscription",
    }] } });
    const controller = await SettingsController.open(setup.dependencies);
    const capture = controller.captureDesktopProjection();
    assert.deepEqual(capture.rowTruth["provider-action:nano-gpt:connect"], {
      kind: "provider-action", backendId: "nano-gpt", action: "connect",
    });
    const desktop = new DesktopSettingsController(controller);
    await desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: desktop.view.revision });
    const accounts = desktop.view.categories.find((category) => category.id === "accounts")!;
    const row = [...accounts.commonItems, ...accounts.advancedItems].find((candidate) => candidate.label === "Nano-GPT · Verbinden")!;
    assert.ok(row);
    assert.deepEqual(desktop.navigationFor({ kind: "activate-row", handle: row.handle, revision: desktop.view.revision }), {
      kind: "provider", providerId: "nano-gpt", focusItemId: "provider-action:nano-gpt:connect",
    });
    await controller.dispatch({ kind: "select-item", itemId: "provider-action:nano-gpt:connect" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind === "edit") await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.deepEqual(setup.externalActions, [{ kind: "provider", intent: { kind: "connect", backendId: "nano-gpt" } }]);
  });
});

test("ein unsicherer Config-Snapshot hält Settings lesbar und sperrt ausnahmslos jede Mutation", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, {
      readConfig: async () => {
        throw new Error("private-storage-secret-must-not-surface");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.unreadableConfig);
    for (const item of controller.view.allItems) {
      if (item.editor.kind === "readonly") continue;
      assert.equal(item.disabledReason, SETTINGS_READ_ONLY_REASONS.unreadableConfig, item.id);
    }
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    assert.equal(setup.events.includes("external-action"), false);
  });
});

test("ein fremder Schreiber auf config.json sperrt Open, zeigt den Disk-Wert und nennt den Ausweg", async () => {
  await withTempConfig(async (path) => {
    const exact = await readConfigEditSnapshot(path);
    // Diese Instanz kennt die Datei so, wie sie sie geladen hat; danach hat
    // ein zweites orcode andere Bytes publiziert.
    const foreign = structuredClone(DEFAULT_CONFIG);
    foreign.appearance.showLargeLogo = false;
    const setup = harness(path, {
      baseline: structuredClone(DEFAULT_CONFIG),
      readConfig: async () => ({ file: exact.file, config: foreign }),
    });

    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(
      controller.view.readOnlyReason,
      SETTINGS_READ_ONLY_REASONS.foreignConfig,
    );
    for (const item of controller.view.allItems) {
      if (item.editor.kind === "readonly") continue;
      assert.equal(item.disabledReason, SETTINGS_READ_ONLY_REASONS.foreignConfig, item.id);
    }
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Off",
    );
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    assert.equal(setup.events.includes("persist-start"), false);
    assert.equal(setup.published.length, 0);
  });
});

test("eine frische Instanz mit Session-Modell abseits der Disk-mainModel bleibt voll editierbar", async () => {
  await withTempConfig(async (path) => {
    // Genau die Gestalt der Owner-Meldung: `openrouter/auto` steht auf der
    // Platte, der fortgesetzte Chat trägt ein konkretes Modell, und der
    // Startup hat diese Session-Präferenz NUR in die Runtime-Config gelegt.
    const disk = structuredClone(DEFAULT_CONFIG);
    disk.mainModel = "openrouter/auto";
    const exact = await readConfigEditSnapshot(path);
    const runtime = structuredClone(disk);
    runtime.mainModel = "qwen/qwen3.8-max";
    let stored = structuredClone(disk);
    const setup = harness(path, {
      initialSnapshot: runtimeSnapshot(runtime),
      baseline: structuredClone(disk),
      readConfig: async () => ({ file: exact.file, config: stored }),
      saveConfig: async (_expected, candidate) => {
        stored = validateConfig(candidate);
        return stored;
      },
    });

    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(controller.view.readOnlyReason, null);
    const lockReasons = new Set<string>(Object.values(SETTINGS_READ_ONLY_REASONS));
    for (const item of controller.view.allItems) {
      assert.equal(lockReasons.has(item.disabledReason ?? ""), false, item.id);
    }

    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(controller.view.notice?.message, "Saved");
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.appearance.showLargeLogo, false);
    // Der eigene CAS-Save bewegt die Baseline mit, also sperrt der nächste
    // Blick auf die Platte die Ansicht nicht.
    assert.equal(controller.view.readOnlyReason, null);
  });
});

test("eine gültige Config-Auswahl persistiert per CAS vor Live-Publikation und stellt den Fokus wieder her", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    setup.events.length = 0;

    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    const completed = await controller.completeEditor(opened.request, {
      kind: "value",
      value: "off",
    });

    assert.equal(completed.kind, "render");
    assert.deepEqual(setup.events, [
      "read-snapshot",
      "validate-candidate",
      "persist-start",
      "persist-done",
      "publish-live",
      "refresh",
    ]);
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.appearance.showLargeLogo, false);
    assert.equal(controller.view.notice?.message, "Saved");
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
  });
});

test("D6: a valid low-balance threshold persists per CAS before live publication, 0 included as a real (not rejected) value", async () => {
  await withTempConfig(async (path) => {
    for (const [input, expected] of [["5", 5], ["0", 0]] as const) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      setup.events.length = 0;

      await controller.dispatch({ kind: "select-item", itemId: "low-balance-threshold" });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit", input);
      if (opened.kind !== "edit") continue;
      const completed = await controller.completeEditor(opened.request, { kind: "value", value: input });

      assert.equal(completed.kind, "render", input);
      assert.equal(setup.published.length, 1, input);
      assert.equal(setup.published[0]?.lowBalanceThresholdUsd, expected, input);
      assert.equal(controller.view.notice?.message, "Saved", input);
    }
  });
});

test("D6: an out-of-range or negative low-balance threshold is rejected without persisting, editor stays open with a concrete range message", async () => {
  await withTempConfig(async (path) => {
    for (const input of ["-1", "5000"]) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId: "low-balance-threshold" });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit", input);
      if (opened.kind !== "edit") continue;
      const completed = await controller.completeEditor(opened.request, { kind: "value", value: input });

      assert.equal(completed.kind, "edit", input);
      if (completed.kind !== "edit") continue;
      assert.match(completed.request.validationMessage ?? "", /Number must be between 0 and 1000/, input);
      assert.equal(setup.published.length, 0, input);
    }
  });
});

test("ein Refreshfehler nach durable Save und Live-Publikation settled sicher ohne falschen Schreibfehler", async () => {
  await withTempConfig(async (path) => {
    let writes = 0;
    const setup = harness(path, {
      failSnapshotReadAt: 3,
      saveConfig: async (_expected, candidate) => {
        writes += 1;
        return validateConfig(candidate);
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 1);
    assert.equal(controller.view.notice?.message, "Saved; view could not be refreshed");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Off",
    );

    await controller.completeEditor(opened.request, { kind: "value", value: "on" });
    assert.equal(writes, 1, "der durable Editor darf nach fehlgeschlagenem Refresh nie erneut schreiben");
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("fehlender exakter Readback nach durable Save meldet ehrliches Refresh-Settlement", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let configReads = 0;
    let writes = 0;
    const setup = harness(path, {
      readConfig: async () => {
        configReads += 1;
        if (configReads === 1) return initial;
        throw new Error("private-readback-failure");
      },
      saveConfig: async (_expected, candidate) => {
        writes += 1;
        return validateConfig(candidate);
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 1);
    assert.equal(controller.view.notice?.message, "Saved; view could not be refreshed");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.unreadableConfig);
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("ein CAS-Konflikt publiziert nichts, lädt neu und verlangt einen frischen Editor", async () => {
  await withTempConfig(async (path) => {
    let writes = 0;
    const setup = harness(path, {
      saveConfig: async (
        _expected: ConfigEditSnapshot,
        _candidate: ConfigInput,
        _path: string,
      ) => {
        writes += 1;
        throw new ConfigEditConflictError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Setting was changed in parallel");
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1, "ein verbrauchter Request darf nie erneut schreiben");
    const fresh = await controller.dispatch({ kind: "activate" });
    assert.equal(fresh.kind, "edit");
    if (fresh.kind === "edit") {
      assert.notEqual(fresh.request.generation, opened.request.generation);
    }
  });
});

test("ein CAS-Konflikt mit Runtime-Disk-Split zeigt den fremden Disk-Wert und bleibt read-only", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    const foreign = structuredClone(DEFAULT_CONFIG);
    foreign.appearance.showLargeLogo = false;
    let configReads = 0;
    let writes = 0;
    const setup = harness(path, {
      readConfig: async () => {
        configReads += 1;
        return configReads === 1
          ? initial
          : { file: initial.file, config: foreign };
      },
      saveConfig: async () => {
        writes += 1;
        throw new ConfigEditConflictError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Setting was changed in parallel");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.foreignConfig);
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Off",
    );
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    await controller.completeEditor(opened.request, { kind: "value", value: "on" });
    assert.equal(writes, 1);
  });
});

test("ein Refreshfehler nach CAS-Konflikt behält die Konfliktmeldung und sperrt den stale Editor", async () => {
  await withTempConfig(async (path) => {
    let writes = 0;
    const setup = harness(path, {
      failSnapshotReadAt: 3,
      saveConfig: async () => {
        writes += 1;
        throw new ConfigEditConflictError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Setting was changed in parallel");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1, "der Konflikt-Editor darf trotz Refreshfehler nie erneut schreiben");
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("ein Request eines anderen Controllers wird trotz gleicher Generation und Zeile abgelehnt", async () => {
  await withTempConfig(async (path) => {
    let writes = 0;
    const setup = harness(path, {
      saveConfig: async (_expected, candidate) => {
        writes += 1;
        return validateConfig(candidate);
      },
    });
    const left = await SettingsController.open(setup.dependencies);
    const right = await SettingsController.open(setup.dependencies);
    for (const controller of [left, right]) {
      await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    }
    const leftOpened = await left.dispatch({ kind: "activate" });
    const rightOpened = await right.dispatch({ kind: "activate" });
    assert.equal(leftOpened.kind, "edit");
    assert.equal(rightOpened.kind, "edit");
    if (leftOpened.kind !== "edit" || rightOpened.kind !== "edit") return;
    assert.equal(leftOpened.request.generation, rightOpened.request.generation);

    await left.completeEditor(rightOpened.request, { kind: "value", value: "off" });
    assert.equal(writes, 0);
    await left.completeEditor(leftOpened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1);
  });
});

test("Navigation ist unveränderlich, klemmt an der letzten Zeile und begrenzt sichere Unicode-Suche", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    const before = controller.view;
    assert.equal(Object.isFrozen(before), true);
    assert.equal(Object.isFrozen(before.items), true);

    await controller.dispatch({ kind: "category", categoryId: "tools" });
    // V4-B: `verify-commands` used to sit behind the "More settings …" row;
    // three ↓ now simply walk onto it, because the list is the whole category.
    await controller.dispatch({ kind: "move", delta: 1 });
    assert.equal(controller.view.selectedItemId, "verify-commands");
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "boundary", edge: "last" });
    assert.equal(controller.view.selectedItemId, "voice-consent-clear");
    await controller.dispatch({ kind: "page", delta: -1 });
    assert.notEqual(controller.view.selectedItemId, "voice-consent-clear");
    assert.equal(before.selectedCategoryId, "models");

    const unsafe = `\u0000\u202e${"🧭".repeat(130)}\n`;
    await controller.dispatch({ kind: "search-change", query: unsafe });
    assert.equal([...controller.view.search.query].length, 120);
    assert.doesNotMatch(controller.view.search.query, /[\p{Cc}\p{Cf}]/u);
  });
});

test("Cancel und ungültige Eingabe bleiben ohne Mutation am selben stabilen Editor", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "max-steps" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    setup.events.length = 0;

    const invalid = await controller.completeEditor(opened.request, {
      kind: "value",
      value: "999\nprivate-secret",
    });
    assert.equal(invalid.kind, "edit");
    if (invalid.kind !== "edit") return;
    assert.equal(invalid.request.itemId, opened.request.itemId);
    assert.notEqual(invalid.request.generation, opened.request.generation);
    assert.equal(invalid.request.initialValue, "999 private-secret");
    assert.ok((invalid.request.validationMessage?.length ?? 999) <= 160);
    assert.doesNotMatch(invalid.request.validationMessage ?? "", /private-secret/);
    assert.deepEqual(setup.events, []);

    const cancelled = await controller.completeEditor(invalid.request, { kind: "cancel" });
    assert.equal(cancelled.kind, "render");
    assert.equal(controller.view.selectedItemId, "max-steps");
    assert.equal(setup.published.length, 0);
  });
});

test("aktive Läufe sperren mutierende Zeilen, aber Darstellung bleibt editierbar", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, { runActive: true });
    const controller = await SettingsController.open(setup.dependencies);

    await controller.dispatch({ kind: "select-item", itemId: "max-steps" });
    assert.equal(controller.view.selectedItemId, "max-steps");
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    assert.equal(setup.externalActions.length, 0);

    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(setup.published.length, 1);
  });
});

test("allow-all braucht die bestehende Warnung und eine zweite Bestätigung; Cancel und Busy-Race schreiben nie", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "approval-mode" });

    const choose = await controller.dispatch({ kind: "activate" });
    assert.equal(choose.kind, "edit");
    if (choose.kind !== "edit") return;
    const confirm = await controller.completeEditor(choose.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(confirm.kind, "edit");
    if (confirm.kind !== "edit") return;
    assert.equal(confirm.request.editor.kind, "confirm");
    assert.equal(
      confirm.request.description,
      "allow-all runs file changes and shell commands without asking. Really enable it?",
    );
    await controller.completeEditor(confirm.request, { kind: "cancel" });
    assert.equal(setup.published.length, 0);

    const chooseAgain = await controller.dispatch({ kind: "activate" });
    assert.equal(chooseAgain.kind, "edit");
    if (chooseAgain.kind !== "edit") return;
    const confirmAgain = await controller.completeEditor(chooseAgain.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(confirmAgain.kind, "edit");
    if (confirmAgain.kind !== "edit") return;
    await controller.completeEditor(confirmAgain.request, { kind: "value", value: true });
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.approvalMode, "allow-all");

    const busySetup = harness(path);
    const busyController = await SettingsController.open(busySetup.dependencies);
    await busyController.dispatch({ kind: "select-item", itemId: "approval-mode" });
    const busyChoose = await busyController.dispatch({ kind: "activate" });
    assert.equal(busyChoose.kind, "edit");
    if (busyChoose.kind !== "edit") return;
    const busyConfirm = await busyController.completeEditor(busyChoose.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(busyConfirm.kind, "edit");
    if (busyConfirm.kind !== "edit") return;
    busySetup.setRunActive(true);
    await busyController.completeEditor(busyConfirm.request, { kind: "value", value: true });
    assert.equal(busySetup.published.length, 0);
    assert.equal(busyController.view.notice?.message, "Run active");
  });
});

test("an opaque Desktop operation token owns selection activation and completion atomically", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const begun = await controller.beginDesktopOperation("approval-mode");
    assert.equal(begun.result.kind, "edit");
    if (begun.result.kind !== "edit") return;

    const foreignCompletion = await controller.completeEditor(begun.result.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(foreignCompletion.kind, "render", "ordinary completion cannot consume the owned request");
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render", "ordinary dispatch cannot replace the owner");

    const confirm = await controller.advanceDesktopOperation(
      begun.token,
      begun.result.request,
      { kind: "value", value: "allow-all" },
    );
    assert.equal(confirm.kind, "edit");
    if (confirm.kind !== "edit") return;
    assert.equal(confirm.request.itemId, "approval-mode");
    assert.equal(confirm.request.editor.kind, "confirm");
    assert.equal(confirm.request.generation, begun.result.request.generation + 1);

    const terminal = await controller.advanceDesktopOperation(
      begun.token,
      confirm.request,
      { kind: "cancel" },
    );
    assert.equal(terminal.kind, "terminal");
    if (terminal.kind !== "terminal") return;
    assert.equal(terminal.effect, "render");
    assert.ok(terminal.capture);
    assert.equal(terminal.capture.noticeOutcome, "cancelled");
    assert.equal(setup.published.length, 0);
  });
});

test("direct and interpreted editor cancellation publish the typed cancelled outcome", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "approval-mode" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "cancel" });
    assert.equal(controller.captureDesktopProjection().noticeOutcome, "cancelled");

    const reopened = await controller.dispatch({ kind: "activate" });
    assert.equal(reopened.kind, "edit");
    if (reopened.kind !== "edit") return;
    const confirmation = await controller.completeEditor(reopened.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(confirmation.kind, "edit");
    if (confirmation.kind !== "edit") return;
    await controller.completeEditor(confirmation.request, { kind: "value", value: false });
    assert.equal(controller.captureDesktopProjection().noticeOutcome, "cancelled");
  });
});

test("a same-shaped cloned request cannot exercise an atomic Desktop token and cleanup releases the lane", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const begun = await controller.beginDesktopOperation("max-steps");
    assert.equal(begun.result.kind, "edit");
    if (begun.result.kind !== "edit") return;
    const clone = structuredClone(begun.result.request);

    await assert.rejects(
      controller.advanceDesktopOperation(begun.token, clone, { kind: "value", value: 42 }),
      /could not be verified/,
    );

    assert.equal(controller.captureDesktopProjection().noticeOutcome, "failed");
    assert.equal(setup.published.length, 0);
    const recovered = await controller.beginDesktopOperation("appearance-large-logo");
    assert.equal(recovered.result.kind, "edit");
    if (recovered.result.kind !== "edit") return;
    const terminal = await controller.advanceDesktopOperation(
      recovered.token,
      recovered.result.request,
      { kind: "value", value: false },
    );
    assert.equal(terminal.kind, "terminal");
    assert.equal(setup.published.length, 1);
  });
});

test("Desktop boolean intent cannot complete a foreign pending allow-all confirmation", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "approval-mode" });
    const choose = await controller.dispatch({ kind: "activate" });
    assert.equal(choose.kind, "edit");
    if (choose.kind !== "edit") return;
    const confirm = await controller.completeEditor(choose.request, {
      kind: "value",
      value: "allow-all",
    });
    assert.equal(confirm.kind, "edit");
    if (confirm.kind !== "edit") return;

    const desktop = new DesktopSettingsController(controller);
    const logo = desktop.view.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Großes ORCODE-Logo");
    assert.ok(logo);
    await assert.rejects(
      desktop.dispatch({ kind: "set-boolean", handle: logo.handle, value: true, revision: desktop.view.revision }),
      /nicht sicher|nicht geändert|gehört/i,
    );
    assert.equal(setup.published.length, 0);
    assert.deepEqual(controller.view.notice, { kind: "error", message: "Setting could not be saved" });
    assert.equal(controller.captureDesktopProjection().noticeOutcome, "failed");

    assert.equal((await controller.completeEditor(confirm.request, { kind: "cancel" })).kind, "render");
    const changed = await desktop.dispatch({
      kind: "set-boolean",
      handle: logo.handle,
      value: false,
      revision: desktop.view.revision,
    });
    assert.equal(changed.notice?.code, "saved");
    assert.equal(setup.published.length, 1, "the cancelled foreign owner cannot poison a later real edit");
    const recovered = await desktop.dispatch({
      kind: "search-change",
      query: "Terminalzeichen",
      revision: desktop.view.revision,
    });
    assert.equal(recovered.search.results.some(({ label }) => label === "Terminalzeichen"), true);
  });
});

test("Desktop pumps the real allow-all confirmation under one owned operation", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const editorKinds: string[] = [];
    const requests: SettingsEditorRequest[] = [];
    const desktop = new DesktopSettingsController(controller, {
      async edit(request) {
        requests.push(request);
        editorKinds.push(request.editor.kind);
        return request.editor.kind === "confirm"
          ? { kind: "value", value: true }
          : { kind: "value", value: "allow-all" };
      },
    });
    const approval = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Freigabemodus");
    assert.ok(approval);
    await desktop.dispatch({ kind: "activate-row", handle: approval.handle, revision: desktop.view.revision });
    assert.deepEqual(editorKinds, ["choice", "confirm"]);
    assert.equal(requests.length, 2);
    assert.notStrictEqual(requests[0], requests[1]);
    assert.equal(requests[1]!.generation, requests[0]!.generation + 1);
    assert.equal(requests[0]!.itemId, "approval-mode");
    assert.equal(requests[1]!.itemId, "approval-mode");
    assert.equal(requests[1]!.editor.kind, "confirm");
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.approvalMode, "allow-all");
    assert.equal(setup.events.filter((event) => event === "validate-candidate").length, 1);
    assert.equal(setup.events.filter((event) => event === "persist-start").length, 1);
    assert.equal(setup.events.filter((event) => event === "publish-live").length, 1);
  });
});

test("Desktop cancels the exact editor after a throwing port and its lane recovers without leaking the cause", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const desktop = new DesktopSettingsController(controller, {
      async edit() { throw new Error("PRIVATE_EDITOR_CANARY"); },
    });
    const revision = desktop.view.revision;
    const approval = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Freigabemodus");
    assert.ok(approval);
    await assert.rejects(
      desktop.dispatch({ kind: "activate-row", handle: approval.handle, revision }),
      (error: unknown) => error instanceof Error && /sicher/.test(error.message) && !/PRIVATE_EDITOR_CANARY/.test(error.message),
    );
    assert.equal(desktop.view.revision, revision);
    assert.equal(setup.published.length, 0);
    const recovered = await desktop.dispatch({ kind: "search-change", query: "Terminalzeichen", revision });
    assert.equal(recovered.search.results.some(({ label }) => label === "Terminalzeichen"), true);
  });
});

test("Desktop retains the exact invalid value across one real validation retry and commits only the retry", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const requests: SettingsEditorRequest[] = [];
    const desktop = new DesktopSettingsController(controller, {
      async edit(request) {
        requests.push(request);
        return { kind: "value", value: requests.length === 1 ? 101 : 42 };
      },
    });
    const target = desktop.view.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Aktionen pro Lauf");
    assert.ok(target);

    const settled = await desktop.dispatch({ kind: "activate-row", handle: target.handle, revision: desktop.view.revision });

    assert.equal(settled.notice?.code, "saved");
    assert.equal(requests.length, 2);
    assert.notStrictEqual(requests[0], requests[1]);
    assert.equal(requests[1]!.generation, requests[0]!.generation + 1);
    assert.equal(requests[1]!.initialValue, 101);
    assert.match(requests[1]!.validationMessage ?? "", /between 1 and 100/);
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.maxSteps, 42);
    assert.equal(setup.events.filter((event) => event === "validate-candidate").length, 1);
    assert.equal(setup.events.filter((event) => event === "persist-start").length, 1);
    assert.equal(setup.events.filter((event) => event === "publish-live").length, 1);
  });
});

test("a throwing retry editor aborts that exact request once and a different edit succeeds at the unchanged revision", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const requests: SettingsEditorRequest[] = [];
    const desktop = new DesktopSettingsController(controller, {
      async edit(request) {
        requests.push(request);
        if (requests.length === 1) return { kind: "value", value: 101 };
        throw new Error("PRIVATE_RETRY_EDITOR_CANARY");
      },
    });
    const before = desktop.view;
    const rows = before.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]);
    const maxSteps = rows.find(({ label }) => label === "Aktionen pro Lauf");
    const logo = rows.find(({ label }) => label === "Großes ORCODE-Logo");
    assert.ok(maxSteps && logo);

    await assert.rejects(
      desktop.dispatch({ kind: "activate-row", handle: maxSteps.handle, revision: before.revision }),
      (error: unknown) => error instanceof Error && /sicher/.test(error.message) && !/PRIVATE_RETRY_EDITOR_CANARY/.test(error.message),
    );

    assert.strictEqual(desktop.view, before);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.generation, requests[0]!.generation + 1);
    assert.equal(controller.captureDesktopProjection().noticeOutcome, "failed");
    assert.equal(setup.published.length, 0);
    assert.equal(setup.events.filter((event) => event === "persist-start").length, 0);
    assert.equal(setup.events.filter((event) => event === "publish-live").length, 0);

    const recovered = await desktop.dispatch({
      kind: "set-boolean",
      handle: logo.handle,
      value: false,
      revision: before.revision,
    });
    assert.equal(recovered.notice?.code, "saved");
    assert.equal(setup.published.length, 1);
  });
});

test("a malformed runtime editor outcome is failed cleanup, never a user cancellation or Core effect", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const desktop = new DesktopSettingsController(controller, {
      async edit() {
        return { kind: "future", value: "PRIVATE_EDITOR_OUTCOME_CANARY" } as never;
      },
    });
    const before = desktop.view;
    const approval = before.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Freigabemodus");
    assert.ok(approval);

    await assert.rejects(
      desktop.dispatch({ kind: "activate-row", handle: approval.handle, revision: before.revision }),
      (error: unknown) => error instanceof Error && /sicher/.test(error.message) && !/PRIVATE_EDITOR_OUTCOME_CANARY/.test(error.message),
    );

    assert.strictEqual(desktop.view, before);
    assert.equal(controller.captureDesktopProjection().noticeOutcome, "failed");
    assert.equal(setup.published.length, 0);
    assert.equal(setup.events.filter((event) => event === "persist-start").length, 0);
    assert.equal(setup.events.filter((event) => event === "publish-live").length, 0);
  });
});

test("same-revision real Boolean intents allow exactly one Core save prepare and publication", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const desktop = new DesktopSettingsController(controller);
    const logo = desktop.view.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Großes ORCODE-Logo");
    assert.ok(logo);
    const revision = desktop.view.revision;

    const outcomes = await Promise.allSettled([
      desktop.dispatch({ kind: "set-boolean", handle: logo.handle, value: false, revision }),
      desktop.dispatch({ kind: "set-boolean", handle: logo.handle, value: true, revision }),
    ]);

    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(setup.published.length, 1);
    assert.equal(setup.published[0]?.appearance.showLargeLogo, false);
    assert.equal(setup.events.filter((event) => event === "validate-candidate").length, 1);
    assert.equal(setup.events.filter((event) => event === "persist-start").length, 1);
    assert.equal(setup.events.filter((event) => event === "publish-live").length, 1);
  });
});

test("real Desktop projection pins saved cancelled stale and failed notice outcomes", async () => {
  await withTempConfig(async (path) => {
    const run = async (
      setup: ReturnType<typeof harness>,
      editorResult?: { readonly kind: "cancel" },
    ) => {
      const controller = await SettingsController.open(setup.dependencies);
      const desktop = new DesktopSettingsController(controller, editorResult ? {
        async edit() { return editorResult; },
      } : null);
      const rows = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]);
      const target = editorResult
        ? rows.find(({ label }) => label === "Freigabemodus")
        : rows.find(({ label }) => label === "Großes ORCODE-Logo");
      assert.ok(target);
      return editorResult
        ? desktop.dispatch({ kind: "activate-row", handle: target.handle, revision: desktop.view.revision })
        : desktop.dispatch({ kind: "set-boolean", handle: target.handle, value: false, revision: desktop.view.revision });
    };

    assert.equal((await run(harness(path))).notice?.code, "saved");
    assert.equal((await run(harness(path), { kind: "cancel" })).notice?.code, "cancelled");
    assert.equal((await run(harness(path, {
      saveConfig: async () => { throw new ConfigEditConflictError(); },
    }))).notice?.code, "stale");
    assert.equal((await run(harness(path, {
      prepareLive: () => { throw new Error("PRIVATE_PREPARE_CANARY"); },
    }))).notice?.code, "failed");
  });
});

test("a real live publication arms one post-commit poison then recovers with fresh handles and no extra effect", async () => {
  await withTempConfig(async (path) => {
    let prepares = 0;
    let saves = 0;
    let publishes = 0;
    let poisonNextTerminal = false;
    let durable: OrcodeConfigWithBudget | null = null;
    let live: OrcodeConfigWithBudget | null = null;
    const setup = harness(path, {
      snapshotForRead: (snapshot) => live ? { ...snapshot, config: structuredClone(live) } : snapshot,
      saveConfig: async (_expected, candidate) => {
        saves += 1;
        durable = validateConfig(candidate);
        return durable;
      },
      prepareLive: (candidate) => {
        prepares += 1;
        return {
          publish() {
            publishes += 1;
            live = structuredClone(candidate);
            poisonNextTerminal = true;
          },
        };
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    const poisonCapture = (capture: ReturnType<SettingsController["captureDesktopProjection"]> | null) => {
      if (!capture) return capture;
      const poison = {
        id: "future-private-row",
        categoryId: "appearance",
        editor: { kind: "readonly" },
      } as unknown as ReturnType<SettingsController["captureDesktopProjection"]>["items"][number];
      return Object.freeze({
        ...capture,
        items: Object.freeze([...capture.items, poison]),
        rowTruth: Object.freeze({
          ...capture.rowTruth,
          "future-private-row": Object.freeze({ kind: "choice", value: "PRIVATE_POST_COMMIT_CANARY" }),
        }),
      });
    };
    const facade: DesktopSettingsCorePort = {
      captureDesktopProjection: () => controller.captureDesktopProjection(),
      beginDesktopOperation: (itemId) => controller.beginDesktopOperation(itemId),
      advanceDesktopOperation: async (token, request, result) => {
        const settled = await controller.advanceDesktopOperation(token, request, result);
        if (settled.kind === "terminal" && poisonNextTerminal) {
          poisonNextTerminal = false;
          return Object.freeze({ ...settled, capture: poisonCapture(settled.capture) });
        }
        return settled;
      },
      abortDesktopOperation: (token, request) => controller.abortDesktopOperation(token, request),
    };
    const desktop = new DesktopSettingsController(facade);
    const expanded = await desktop.dispatch({ kind: "toggle-advanced", categoryId: "more", revision: desktop.view.revision });
    const oldHandles = expanded.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .map(({ handle }) => handle);
    const logo = expanded.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .find(({ label }) => label === "Großes ORCODE-Logo");
    assert.ok(logo);

    const diagnostic = await desktop.dispatch({
      kind: "set-boolean",
      handle: logo.handle,
      value: false,
      revision: expanded.revision,
    });

    assert.equal(prepares, 1);
    assert.equal(saves, 1);
    assert.equal(publishes, 1);
    assert.equal((durable as unknown as OrcodeConfigWithBudget).appearance.showLargeLogo, false);
    assert.equal((live as unknown as OrcodeConfigWithBudget).appearance.showLargeLogo, false);
    assert.equal(diagnostic.revision, expanded.revision + 1);
    assert.equal(diagnostic.notice?.code, "failed");
    assert.equal(diagnostic.search.query, "");
    assert.equal(diagnostic.categories.every(({ expanded: open }) => open === false), true);
    assert.equal(diagnostic.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]).length, 0);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_POST_COMMIT_CANARY|future-private-row/);
    await assert.rejects(
      desktop.dispatch({ kind: "activate-row", handle: logo.handle, revision: diagnostic.revision }),
      /nicht verfügbar/,
    );

    const recovered = await desktop.dispatch({
      kind: "search-change",
      query: "Terminalzeichen",
      revision: diagnostic.revision,
    });
    const freshHandles = recovered.categories
      .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
      .map(({ handle }) => handle);
    assert.equal(recovered.search.results.some(({ label }) => label === "Terminalzeichen"), true);
    assert.equal(freshHandles.some((handle) => oldHandles.includes(handle)), false);
    assert.equal(prepares, 1);
    assert.equal(saves, 1);
    assert.equal(publishes, 1);
  });
});

test("typed-unverified wird exakt neu gelesen, bei bestätigtem Kandidaten reconciled und sonst read-only", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let durable: OrcodeConfigWithBudget | null = null;
    let reads = 0;
    const setup = harness(path, {
      readConfig: async () => {
        reads += 1;
        if (reads === 1) return initial;
        if (!durable) throw new Error("ambiguous-private-storage");
        return { file: initial.file, config: durable };
      },
      saveConfig: async (_expected, candidate) => {
        durable = validateConfig(candidate);
        throw new ConfigEditUnverifiedError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(setup.published.length, 1);
    assert.equal(controller.view.notice?.message, "Saved");
    await controller.completeEditor(opened.request, { kind: "value", value: "on" });
    assert.equal(setup.published.length, 1, "der unverified Ausgangssnapshot ist verbraucht");

    let ambiguousReads = 0;
    const ambiguous = harness(path, {
      readConfig: async () => {
        ambiguousReads += 1;
        if (ambiguousReads === 1) return initial;
        throw new Error("ambiguous-private-storage");
      },
      saveConfig: async () => {
        throw new ConfigEditUnverifiedError();
      },
    });
    const ambiguousController = await SettingsController.open(ambiguous.dependencies);
    await ambiguousController.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const ambiguousOpened = await ambiguousController.dispatch({ kind: "activate" });
    assert.equal(ambiguousOpened.kind, "edit");
    if (ambiguousOpened.kind !== "edit") return;
    await ambiguousController.completeEditor(ambiguousOpened.request, { kind: "value", value: "off" });
    assert.equal(ambiguous.published.length, 0);
    assert.equal(ambiguousController.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(
      ambiguousController.view.notice?.message,
      "Save state could not be safely confirmed",
    );
  });
});

test("typed-unverified bestätigter Kandidat mit fehlendem Runtime-Refresh settled read-only", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let durable: OrcodeConfigWithBudget | null = null;
    let configReads = 0;
    let writes = 0;
    const setup = harness(path, {
      failSnapshotReadAt: 3,
      readConfig: async () => {
        configReads += 1;
        if (configReads === 1) return initial;
        if (!durable) throw new Error("unexpected missing durable config");
        return { file: initial.file, config: durable };
      },
      saveConfig: async (_expected, candidate) => {
        writes += 1;
        durable = validateConfig(candidate);
        throw new ConfigEditUnverifiedError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 1);
    assert.equal(controller.view.notice?.message, "Saved; view could not be refreshed");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Off",
    );
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    await controller.completeEditor(opened.request, { kind: "value", value: "on" });
    assert.equal(writes, 1);
  });
});

test("typed-unverified bestätigter Disk-Kandidat bleibt trotz abweichender Runtime editierbar", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let durable: OrcodeConfigWithBudget | null = null;
    let configReads = 0;
    let writes = 0;
    const staleRuntime = runtimeSnapshot(structuredClone(DEFAULT_CONFIG));
    const setup = harness(path, {
      snapshotForRead: (snapshot, readCount) => readCount === 3 ? staleRuntime : snapshot,
      readConfig: async () => {
        configReads += 1;
        if (configReads === 1) return initial;
        if (!durable) throw new Error("unexpected missing durable config");
        return { file: initial.file, config: durable };
      },
      saveConfig: async (_expected, candidate) => {
        writes += 1;
        durable = validateConfig(candidate);
        throw new ConfigEditUnverifiedError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 1);
    // Der exakte Readback hat bewiesen, dass die Datei die EIGENEN Bytes
    // dieses Prozesses trägt: die Baseline wandert mit, also ist die
    // abweichende Runtime-Config kein fremder Schreiber und kein Sperrgrund.
    assert.equal(controller.view.notice?.message, "Saved");
    assert.equal(controller.view.readOnlyReason, null);
    // Die editierbare Ansicht zeigt die Runtime-Config — hier absichtlich ein
    // veraltetes Double, damit sichtbar bleibt, aus welcher Quelle die Zeilen
    // lesen; der Editor selbst öffnet auf dem durablen Disk-Snapshot.
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "On",
    );
    const reopened = await controller.dispatch({ kind: "activate" });
    assert.equal(reopened.kind, "edit");
    if (reopened.kind === "edit") assert.equal(reopened.request.initialValue, "off");
  });
});

test("typed-unverified Mismatch mit fehlendem Runtime-Refresh bleibt fail-closed und verwendet keinen alten Snapshot", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let reads = 0;
    let writes = 0;
    const setup = harness(path, {
      failSnapshotReadAt: 3,
      readConfig: async () => {
        reads += 1;
        return reads === 1
          ? initial
          : { file: initial.file, config: structuredClone(DEFAULT_CONFIG) };
      },
      saveConfig: async () => {
        writes += 1;
        throw new ConfigEditUnverifiedError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Setting was changed in parallel");
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "On",
    );
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1, "ein unverified Ausgangssnapshot darf nie wiederverwendet werden");
  });
});

test("typed-unverified Mismatch reconciled auf die eigene Baseline und sperrt nur bei fremden Bytes", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    // (a) Die Platte trägt wieder genau die Baseline: die Publikation ist nie
    // gelandet. Ein Split zwischen Runtime und Platte ist danach kein
    // Sperrgrund — die Runtime trägt die Session-Präferenzen dieses Prozesses.
    let configReads = 0;
    let writes = 0;
    const splitRuntime = runtimeSnapshot(structuredClone(DEFAULT_CONFIG));
    splitRuntime.config.appearance.showLargeLogo = false;
    const setup = harness(path, {
      snapshotForRead: (snapshot, readCount) => readCount === 3 ? splitRuntime : snapshot,
      readConfig: async () => {
        configReads += 1;
        return configReads === 1
          ? initial
          : { file: initial.file, config: structuredClone(DEFAULT_CONFIG) };
      },
      saveConfig: async () => {
        writes += 1;
        throw new ConfigEditUnverifiedError();
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });

    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Setting was changed in parallel");
    assert.equal(controller.view.readOnlyReason, null);
    // Editierbar heißt: die Zeilen lesen die Runtime-Config (hier das
    // absichtlich abweichende Double), nicht mehr den Disk-Snapshot.
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Off",
    );
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1, "ein unverified Ausgangssnapshot darf nie wiederverwendet werden");

    // (b) Derselbe Pfad mit fremden Bytes auf der Platte sperrt weiterhin —
    // und sagt jetzt, wer geschrieben hat und wie der Ausweg aussieht.
    let foreignReads = 0;
    const foreignDisk = structuredClone(DEFAULT_CONFIG);
    foreignDisk.maxSteps = DEFAULT_CONFIG.maxSteps - 1;
    const foreignSetup = harness(path, {
      readConfig: async () => {
        foreignReads += 1;
        return foreignReads === 1
          ? initial
          : { file: initial.file, config: foreignDisk };
      },
      saveConfig: async () => {
        throw new ConfigEditUnverifiedError();
      },
    });
    const foreignController = await SettingsController.open(foreignSetup.dependencies);
    await foreignController.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
    const foreignOpened = await foreignController.dispatch({ kind: "activate" });
    assert.equal(foreignOpened.kind, "edit");
    if (foreignOpened.kind !== "edit") return;

    await foreignController.completeEditor(foreignOpened.request, { kind: "value", value: "off" });

    assert.equal(foreignSetup.published.length, 0);
    assert.equal(foreignController.view.notice?.message, "Setting was changed in parallel");
    assert.equal(
      foreignController.view.readOnlyReason,
      SETTINGS_READ_ONLY_REASONS.foreignConfig,
    );
    assert.equal((await foreignController.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("FIX-14 ticket 14: an external action that changed nothing never reports the act's verb", async () => {
  await withTempConfig(async (path) => {
    // The FIX-18 F7 residual, exactly: disconnecting a connection the
    // binding selector cannot see returns `unchanged`, and Settings used to
    // print "Disconnected" over the top of it because the port returned
    // `void` and had no way to say otherwise.
    const setup = harness(path, {
      executeExternal: async () => ({
        kind: "unchanged" as const,
        reason: "the stored connection is already disabled; nothing was removed",
      }),
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: true });

    assert.equal(
      controller.view.notice?.message,
      "Nothing changed — the stored connection is already disabled; nothing was removed",
    );
    // Not a success, for the same reason a cancel is not one.
    assert.equal(controller.view.notice?.kind, "info");
  });
});

test("FIX-14 ticket 14: a port that did change the thing still reports the act's verb", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, { executeExternal: async () => ({ kind: "changed" as const }) });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.equal(controller.view.notice?.kind, "success");
  });
});

test("externe Fehler behalten die Projektion und zeigen nie fremden Fehlertext", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, {
      executeExternal: async () => {
        throw new Error("provider-private-request-id-123");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const before = controller.view.allItems.map(({ id, displayValue }) => ({ id, displayValue }));
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: true });

    assert.deepEqual(
      controller.view.allItems.map(({ id, displayValue }) => ({ id, displayValue })),
      before,
    );
    assert.equal(controller.view.notice?.message, "Action could not be completed");
    assert.doesNotMatch(controller.view.notice?.message ?? "", /request-id|private/i);
    assert.deepEqual(setup.externalActions, [{ kind: "provider", intent: { kind: "setup" } }]);
  });
});

test("externe Fehler lesen die passive Runtime-Projektion nach einem internen Staging-Cleanup neu", async () => {
  await withTempConfig(async (path) => {
    let cleaned = false;
    const initial = { ...completeRuntimeSnapshot(), cross: crossProjection({
      preferences: { lead: crossRoute("vendor/staged"), challenger: null },
    }) };
    const setup = harness(path, {
      initialSnapshot: initial,
      snapshotForRead(snapshot) {
        if (!cleaned) return snapshot;
        return { ...snapshot, cross: crossProjection({ preferences: { lead: null, challenger: null } }) };
      },
      executeExternal: async () => {
        cleaned = true;
        throw new Error("private-stale-route");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    assert.match(controller.view.allItems.find((item) => item.id === "cross-lead-model")!.displayValue, /staged/);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.equal(controller.view.notice?.message, "Action could not be completed");
    assert.equal(controller.view.allItems.find((item) => item.id === "cross-lead-model")!.displayValue, "Not set");
    assert.equal(controller.view.allItems.find((item) => item.id === "cross-challenger-model")!.displayValue, "Not set");
    assert.ok(setup.events.filter((event) => event === "refresh").length >= 1);
  });
});

test("ein Refreshfehler nach erfolgreicher externer Action meldet Settlement und führt nie erneut aus", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, { failSnapshotReadAt: 3 });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: true });

    assert.equal(setup.externalActions.length, 1);
    assert.equal(
      controller.view.notice?.message,
      "Action completed; view could not be refreshed",
    );
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.restartRequired);
    assert.equal(controller.view.selectedItemId, "provider-setup");
    await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.equal(setup.externalActions.length, 1, "eine ausgeführte Action darf nie wiederholt werden");
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("fehlender exakter Readback nach externer Action meldet ehrliches Refresh-Settlement", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
    let configReads = 0;
    const setup = harness(path, {
      readConfig: async () => {
        configReads += 1;
        if (configReads === 1) return initial;
        throw new Error("private-readback-failure");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "provider-setup" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: true });

    assert.equal(setup.externalActions.length, 1);
    assert.equal(
      controller.view.notice?.message,
      "Action completed; view could not be refreshed",
    );
    assert.equal(controller.view.readOnlyReason, SETTINGS_READ_ONLY_REASONS.unreadableConfig);
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
  });
});

test("Prepare- und Schreibfehler publizieren nie live und bleiben secretless", async () => {
  await withTempConfig(async (path) => {
    for (const mode of ["prepare", "save"] as const) {
      const setup = harness(path, {
        ...(mode === "prepare"
          ? {
              prepareLive: () => {
                throw new Error("prepare-private-secret");
              },
            }
          : {
              saveConfig: async () => {
                throw new Error("storage-private-secret");
              },
            }),
      });
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId: "appearance-large-logo" });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit");
      if (opened.kind !== "edit") continue;
      await controller.completeEditor(opened.request, { kind: "value", value: "off" });
      assert.equal(setup.published.length, 0, mode);
      assert.equal(controller.view.notice?.message, "Setting could not be saved");
    }
  });
});

test("jede einfache Config-Action ändert ausschließlich ihr typisiertes Zielfeld", () => {
  const expectedPath: Record<SettingsConfigAction["kind"], string> = {
    reasoning: `reasoningByModel.${DEFAULT_CONFIG.mainModel}`,
    "compression-mode": "compressionMode",
    "max-steps": "maxSteps",
    "provider-sort": "provider.sort",
    "provider-data-collection": "provider.dataCollection",
    "provider-only": "provider.only",
    "provider-ignore": "provider.ignore",
    "provider-fallback": "provider.allowFallbacks",
    "approval-mode": "approvalMode",
    "max-cost": "maxCostUsd",
    "low-balance-threshold": "lowBalanceThresholdUsd",
    "compressor-max-cost": "compressorMaxCostUsd",
    "budget-daily": "budget.dailyLimitUsd",
    "budget-total": "budget.totalLimitUsd",
    "budget-on-exceed": "budget.onExceed",
    "verify-mode": "verify.mode",
    "verify-commands": "verify.commands",
    "verify-clear": "verify.commands",
    "verify-repair-rounds": "verify.maxRepairRounds",
    "web-mode": "web",
    "browser-path": "browserPath",
    "browser-timeout": "browserTimeoutSeconds",
    "panel-judge": "panelJudge",
    "voice-consent-clear": "voiceConsentGiven",
    "appearance-large-logo": "appearance.showLargeLogo",
    "appearance-header-mark": "appearance.showHeaderMark",
    "appearance-glyph-mode": "appearance.glyphMode",
  };
  const cases: readonly {
    readonly action: SettingsConfigAction;
    readonly read: (config: OrcodeConfigWithBudget) => unknown;
    readonly expected: unknown;
  }[] = [
    {
      action: { kind: "reasoning", modelId: DEFAULT_CONFIG.mainModel, value: { mode: "effort", effort: "high" } },
      read: (c) => c.reasoningByModel[c.mainModel],
      expected: { mode: "effort", effort: "high" },
    },
    { action: { kind: "compression-mode", value: "always" }, read: (c) => c.compressionMode, expected: "always" },
    { action: { kind: "max-steps", value: 33 }, read: (c) => c.maxSteps, expected: 33 },
    { action: { kind: "provider-sort", value: "price" }, read: (c) => c.provider.sort, expected: "price" },
    { action: { kind: "provider-data-collection", value: "allow" }, read: (c) => c.provider.dataCollection, expected: "allow" },
    { action: { kind: "provider-only", value: ["A", "B"] }, read: (c) => c.provider.only, expected: ["A", "B"] },
    { action: { kind: "provider-ignore", value: ["C"] }, read: (c) => c.provider.ignore, expected: ["C"] },
    { action: { kind: "provider-fallback", value: false }, read: (c) => c.provider.allowFallbacks, expected: false },
    { action: { kind: "approval-mode", value: "auto-edit" }, read: (c) => c.approvalMode, expected: "auto-edit" },
    { action: { kind: "max-cost", value: 2.5 }, read: (c) => c.maxCostUsd, expected: 2.5 },
    { action: { kind: "low-balance-threshold", value: 5 }, read: (c) => c.lowBalanceThresholdUsd, expected: 5 },
    { action: { kind: "compressor-max-cost", value: 0.2 }, read: (c) => c.compressorMaxCostUsd, expected: 0.2 },
    { action: { kind: "budget-daily", value: 8 }, read: (c) => c.budget.dailyLimitUsd, expected: 8 },
    { action: { kind: "budget-total", value: null }, read: (c) => c.budget.totalLimitUsd, expected: null },
    { action: { kind: "budget-on-exceed", value: "block" }, read: (c) => c.budget.onExceed, expected: "block" },
    { action: { kind: "verify-mode", value: "off" }, read: (c) => c.verify.mode, expected: "off" },
    { action: { kind: "verify-commands", value: ["npm test"] }, read: (c) => c.verify.commands, expected: ["npm test"] },
    { action: { kind: "verify-clear" }, read: (c) => c.verify.commands, expected: [] },
    { action: { kind: "verify-repair-rounds", value: 2 }, read: (c) => c.verify.maxRepairRounds, expected: 2 },
    { action: { kind: "web-mode", value: "on" }, read: (c) => c.web, expected: "on" },
    { action: { kind: "browser-path", value: "/Applications/Chromium.app" }, read: (c) => c.browserPath, expected: "/Applications/Chromium.app" },
    { action: { kind: "browser-timeout", value: 60 }, read: (c) => c.browserTimeoutSeconds, expected: 60 },
    { action: { kind: "panel-judge", value: true }, read: (c) => c.panelJudge, expected: true },
    { action: { kind: "voice-consent-clear" }, read: (c) => c.voiceConsentGiven, expected: false },
    { action: { kind: "appearance-large-logo", value: false }, read: (c) => c.appearance.showLargeLogo, expected: false },
    { action: { kind: "appearance-header-mark", value: false }, read: (c) => c.appearance.showHeaderMark, expected: false },
    { action: { kind: "appearance-glyph-mode", value: "ascii" }, read: (c) => c.appearance.glyphMode, expected: "ascii" },
  ];

  for (const entry of cases) {
    const candidate = structuredClone(DEFAULT_CONFIG);
    candidate.provider = {
      sort: "latency",
      dataCollection: "deny",
      only: ["Old Only"],
      ignore: ["Old Ignore"],
      allowFallbacks: true,
    };
    candidate.budget = {
      dailyLimitUsd: null,
      totalLimitUsd: 7,
      onExceed: "warn",
    };
    candidate.verify = {
      mode: "on-edit",
      commands: ["old command"],
      maxRepairRounds: 1,
    };
    candidate.voiceConsentGiven = true;
    const before = structuredClone(candidate);
    applyConfigAction(candidate, entry.action);
    assert.deepEqual(entry.read(candidate), entry.expected, entry.action.kind);
    assert.deepEqual(
      changedLeafPaths(before, candidate),
      [expectedPath[entry.action.kind]],
      `${entry.action.kind} darf kein zweites Feld verändern`,
    );
  }
});

function changedLeafPaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix];
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    return keys.flatMap((key) => changedLeafPaths(
      leftRecord[key],
      rightRecord[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return [prefix];
}

test("reasoning-compressor save touches only reasoningByModel[compressorModel], never the main model's entry", async () => {
  await withTempConfig(async (path) => {
    const projected = completeRuntimeSnapshot();
    const exactFile = await readConfigEditSnapshot(path);
    const editable: ConfigEditSnapshot = {
      file: exactFile.file,
      config: fullConfigFromProjection(projected.config),
    };
    const setup = harness(path, {
      initialSnapshot: projected,
      readConfig: async () => editable,
    });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "select-item", itemId: "reasoning-compressor" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    const completed = await controller.completeEditor(opened.request, { kind: "value", value: "effort:high" });
    assert.equal(completed.kind, "render");
    // reasoningByModel is plain config (unlike Phase 2's Cross rows): no
    // external action, straight to the same live-config publish path.
    assert.equal(setup.externalActions.length, 0);
    assert.equal(setup.published.length, 1);
    const saved = setup.published[0]!;
    assert.deepEqual(
      saved.reasoningByModel[projected.config.compressorModel],
      { mode: "effort", effort: "high" },
    );
    assert.equal(
      saved.reasoningByModel[projected.config.mainModel],
      undefined,
      "the main role's own entry must stay untouched",
    );
    assert.deepEqual(
      changedLeafPaths(editable.config, saved),
      [`reasoningByModel.${projected.config.compressorModel}`],
      "reasoning-compressor darf kein zweites Feld verändern",
    );
  });
});

test("main and compressor model editors preserve only the opaque shared selection intent", async () => {
  await withTempConfig(async (path) => {
    for (const itemId of ["main-model", "compressor-model"] as const) {
      const snapshot = completeRuntimeSnapshot();
      const exactFile = await readConfigEditSnapshot(path);
      const setup = harness(path, {
        initialSnapshot: {
          ...snapshot,
          route: {
            backendId: "openrouter",
            providerLabel: "OpenRouter",
            requestedModelId: "openai/test-main",
            canonicalModelId: "openai/test-main-canonical",
            modelLabel: "Test Main",
            billingRealm: "openrouter-payg",
          },
        },
        readConfig: async () => ({
          file: exactFile.file,
          config: fullConfigFromProjection(snapshot.config),
        }),
      });
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit");
      if (opened.kind !== "edit") continue;
      const selection = routeIntent(itemId);
      const completed = await controller.completeEditor(opened.request, {
        kind: "value",
        value: { kind: "model-route", selection },
      });
      assert.equal(completed.kind, "render");
      assert.deepEqual(setup.externalActions, [{
        kind: itemId,
        selection,
      }]);
    }
  });
});

test("model editors reject retired and surplus private payloads without reflecting them or causing effects", async () => {
  await withTempConfig(async (path) => {
    for (const value of [
      { kind: "model-route", candidate: { route: "PRIVATE_ROUTE_CANARY", credentialSlot: "PRIVATE_SLOT_CANARY" } },
      { kind: "model-route", selection: { ...routeIntent("retired"), route: "PRIVATE_ROUTE_CANARY" }, surplus: "PRIVATE_SLOT_CANARY" },
    ]) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId: "main-model" });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit");
      if (opened.kind !== "edit") continue;
      setup.events.length = 0;
      const rejected = await controller.completeEditor(opened.request, { kind: "value", value } as never);
      assert.equal(rejected.kind, "edit");
      if (rejected.kind !== "edit") continue;
      assert.match(rejected.request.validationMessage ?? "", /model choice is (?:invalid|no longer available)/i);
      assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_ROUTE_CANARY|PRIVATE_SLOT_CANARY|credentialSlot|"route"/);
      assert.deepEqual(setup.externalActions, []);
      assert.deepEqual(setup.published, []);
      assert.deepEqual(setup.events, []);
    }
  });
});

test("jede konkrete Registry-Zeile erreicht exakt eine Config- oder ExternalAction", async () => {
  await withTempConfig(async (path) => {
    const projected = completeRuntimeSnapshot();
    const exactFile = await readConfigEditSnapshot(path);
    const editable: ConfigEditSnapshot = {
      file: exactFile.file,
      config: fullConfigFromProjection(projected.config),
    };
    const registryController = await SettingsController.open(harness(path, {
      initialSnapshot: projected,
      readConfig: async () => editable,
    }).dependencies);
    const actionable = registryController.view.allItems.filter(({ editor }) => editor.kind !== "readonly");

    for (const item of actionable) {
      const setup = harness(path, {
        initialSnapshot: projected,
        readConfig: async () => editable,
      });
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId: item.id });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit", item.id);
      if (opened.kind !== "edit") continue;
      const value = (() => {
        switch (item.editor.kind) {
          case "choice":
            return item.editor.options[0]!.value;
          case "number":
            return item.editor.minimum;
          case "text":
            return item.editor.valueKind === "path"
              ? "/Applications/Chromium.app"
              : item.editor.valueKind === "command-list"
                ? ["npm test"]
                : ["Example Provider"];
          case "confirm":
          case "invoke":
            return true;
          case "model":
            if (item.editor.actionId === "panel-models") {
              return ["openai/test-main", "openai/test-compressor"];
            }
            if (item.editor.actionId === "main-model") {
              const candidate = selectableSettingsRoute("openai/test-main");
              return {
                kind: "model-route" as const,
                selection: routeIntent("openai/test-main"),
              };
            }
            if (item.editor.actionId === "compressor-model") {
              return {
                kind: "model-route" as const,
                selection: routeIntent("openai/test-compressor"),
              };
            }
            if (item.editor.actionId === "transcription-model") return "audio/test-model";
            if (item.editor.actionId === "cross-lead-model") {
              return {
                kind: "model-route" as const,
                selection: routeIntent("cross/test-lead-new"),
              };
            }
            if (item.editor.actionId === "cross-challenger-model") {
              return {
                kind: "model-route" as const,
                selection: routeIntent("cross/test-challenger-new"),
              };
            }
            if (item.editor.actionId === "architect-executor-model") {
              return {
                kind: "model-route" as const,
                selection: routeIntent("architect/test-executor-new"),
              };
            }
            throw new Error(`unexpected model action ${item.editor.actionId}`);
          case "readonly":
            throw new Error("readonly row escaped filter");
        }
      })();
      const completed = await controller.completeEditor(opened.request, { kind: "value", value });
      assert.equal(completed.kind, "render", item.id);

      const expectedExternal = (() => {
        const actionId = item.editor.actionId;
        if (actionId === "provider-setup") {
          return { kind: "provider", intent: { kind: "setup" } } as const;
        }
        if (actionId.startsWith("provider-") && item.id.startsWith("provider-action:")) {
          const [, backendId, operation] = item.id.split(":");
          return {
            kind: "provider",
            intent: { kind: operation, backendId },
          } as SettingsExternalAction;
        }
        switch (actionId) {
          case "main-model":
            return {
              kind: "main-model",
              selection: routeIntent("openai/test-main"),
            } as const;
          case "compressor-model":
            return {
              kind: "compressor-model",
              selection: routeIntent("openai/test-compressor"),
            } as const;
          case "approval-forget":
            return { kind: "approval-forget", ruleId: RULE_ID } as const;
          case "approval-forget-all":
            return { kind: "approval-forget-all" } as const;
          case "verify-suggest":
            return { kind: "verify-suggest" } as const;
          case "panel-models":
            return {
              kind: "panel-models",
              modelIds: ["openai/test-main", "openai/test-compressor"],
            } as const;
          case "transcription-model":
            return { kind: "transcription-model", modelId: "audio/test-model" } as const;
          case "cross-lead-model":
            return {
              kind: "cross-role",
              role: "lead",
              selection: routeIntent("cross/test-lead-new"),
            } as const;
          case "cross-challenger-model":
            return {
              kind: "cross-role",
              role: "challenger",
              selection: routeIntent("cross/test-challenger-new"),
            } as const;
          case "cross-pair-swap":
            return { kind: "cross-swap" } as const;
          case "architect-executor-model":
            return {
              kind: "architect-executor-model",
              selection: routeIntent("architect/test-executor-new"),
            } as const;
          default:
            return null;
        }
      })();

      if (expectedExternal) {
        assert.deepEqual(setup.externalActions, [expectedExternal], item.id);
        assert.equal(setup.published.length, 0, item.id);
      } else {
        assert.deepEqual(setup.externalActions, [], item.id);
        assert.equal(setup.published.length, 1, item.id);
      }
    }
  });
});

test("unbekannte und gefälschte dynamische IDs bleiben ohne jede Action", async () => {
  await withTempConfig(async (path) => {
    const projected = completeRuntimeSnapshot();
    const exact = await readConfigEditSnapshot(path);
    const setup = harness(path, {
      initialSnapshot: projected,
      readConfig: async () => ({
        file: exact.file,
        config: fullConfigFromProjection(projected.config),
      }),
    });
    const controller = await SettingsController.open(setup.dependencies);
    const original = controller.view.selectedItemId;

    await controller.dispatch({
      kind: "select-item",
      itemId: "provider-action:openrouter:erase" as never,
    });
    assert.equal(controller.view.selectedItemId, original);
    await controller.dispatch({ kind: "select-item", itemId: "provider-action:openrouter:connect" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    const forgedProvider = Object.freeze({
      ...opened.request,
      itemId: "provider-action:openrouter:erase" as never,
    });
    await controller.completeEditor(forgedProvider, { kind: "value", value: true });
    assert.deepEqual(setup.externalActions, []);
    await controller.completeEditor(opened.request, { kind: "cancel" });

    await controller.dispatch({ kind: "select-item", itemId: `approval-forget:${RULE_ID}` });
    const ruleOpened = await controller.dispatch({ kind: "activate" });
    assert.equal(ruleOpened.kind, "edit");
    if (ruleOpened.kind !== "edit") return;
    const forgedRule = Object.freeze({
      ...ruleOpened.request,
      itemId: "approval-forget:not-a-rule-id" as never,
    });
    await controller.completeEditor(forgedRule, { kind: "value", value: true });
    assert.deepEqual(setup.externalActions, []);
  });
});

test("überlange oder kontrollierte Modellwerte und Panel-Arrays über fünf lösen keine Action aus", async () => {
  await withTempConfig(async (path) => {
    const exact = await readConfigEditSnapshot(path);
    const runInvalid = async (
      projected: SettingsControllerSnapshot,
      itemId: "main-model" | "panel-models",
      value: string | readonly string[],
    ): Promise<void> => {
      const setup = harness(path, {
        initialSnapshot: projected,
        readConfig: async () => ({
          file: exact.file,
          config: fullConfigFromProjection(projected.config),
        }),
      });
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit");
      if (opened.kind !== "edit") return;
      const completed = await controller.completeEditor(opened.request, { kind: "value", value });
      assert.equal(completed.kind, "edit");
      assert.deepEqual(setup.externalActions, []);
      assert.deepEqual(setup.published, []);
    };

    const longId = "m".repeat(512);
    const longSnapshot = completeRuntimeSnapshot();
    longSnapshot.config.mainModel = longId;
    longSnapshot.cachedModels[0]!.id = longId;
    delete longSnapshot.cachedModels[0]!.canonicalSlug;
    await runInvalid(longSnapshot, "main-model", `${longId}x`);

    const projected = completeRuntimeSnapshot();
    await runInvalid(projected, "main-model", "openai/test-main\u0000");
    await runInvalid(projected, "panel-models", [
      "openai/test-main",
      "openai/test-compressor",
      "audio/test-model",
      "four",
      "five",
      "six",
    ]);
    await runInvalid(projected, "panel-models", [
      "openai/test-main\u202e",
      "openai/test-compressor",
    ]);
  });
});

test("kontrollierte oder überlange Zahlenstrings werden nie nach Bereinigung gespeichert", async () => {
  await withTempConfig(async (path) => {
    for (const value of ["33\u0000", `33${" ".repeat(127)}`]) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId: "max-steps" });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit");
      if (opened.kind !== "edit") continue;
      const completed = await controller.completeEditor(opened.request, { kind: "value", value });
      assert.equal(completed.kind, "edit");
      assert.equal(setup.published.length, 0);
      assert.equal(setup.events.includes("persist-start"), false);
    }
  });
});

test("strukturierte Kommando- und Provider-Arrays lehnen CR/LF vor Bereinigung ohne Mutation ab", async () => {
  await withTempConfig(async (path) => {
    for (const [itemId, value] of [
      ["verify-commands", ["echo safe\n&& dangerous"]],
      ["provider-only", ["openai\nanthropic"]],
    ] as const) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit", itemId);
      if (opened.kind !== "edit") continue;

      const completed = await controller.completeEditor(opened.request, { kind: "value", value });

      assert.equal(completed.kind, "edit", itemId);
      assert.equal(setup.published.length, 0, itemId);
      assert.equal(setup.events.includes("persist-start"), false, itemId);
    }
  });
});

type VoiceConsentAction = Extract<SettingsConfigAction, { kind: "voice-consent-clear" }>;
type Assert<T extends true> = T;
const VOICE_CONSENT_HAS_NO_TRUE_VALUE: Assert<"value" extends keyof VoiceConsentAction ? false : true> = true;
void VOICE_CONSENT_HAS_NO_TRUE_VALUE;

test("die vier Desktop-Schalter akzeptieren echte Booleans ohne Display-Parsing", async () => {
  await withTempConfig(async (path) => {
    for (const itemId of ["provider-fallback", "panel-judge", "appearance-large-logo", "appearance-header-mark"] as const) {
      const setup = harness(path);
      const controller = await SettingsController.open(setup.dependencies);
      await controller.dispatch({ kind: "select-item", itemId });
      const opened = await controller.dispatch({ kind: "activate" });
      assert.equal(opened.kind, "edit", itemId);
      if (opened.kind !== "edit") continue;
      const completed = await controller.completeEditor(opened.request, { kind: "value", value: true });
      assert.equal(completed.kind, "render", itemId);
      assert.equal(setup.published.length, 1, itemId);
    }
  });
});

test("Desktop-Capture hält den automatischen Provider-Fallback typisiert wahr", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    const source = controller.view.allItems.find(({ id }) => id === "provider-fallback");
    assert.equal(source?.displayValue, "Automatic");
    assert.deepEqual(
      controller.captureDesktopProjection().rowTruth["provider-fallback"],
      { kind: "boolean", value: true },
    );
  });
});

test("real Desktop capture keeps only ordered choice values and no source option copy", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path, {
      initialSnapshot: completeRuntimeSnapshot(),
    }).dependencies);

    const capture = controller.captureDesktopProjection();
    assert.equal(Object.isFrozen(capture), true);
    assert.equal(Object.isFrozen(capture.items), true);
    assert.equal(Object.isFrozen(capture.rowTruth), true);
    assert.doesNotMatch(
      JSON.stringify(capture),
      /Automatic|Offer web access depending on the task/,
    );
    assert.deepEqual(Object.keys(capture).sort(), ["items", "noticeOutcome", "readOnlyReason", "rowTruth"]);
    const webMode = capture.items.find(({ id }) => id === "web-mode");
    assert.deepEqual(webMode, {
      id: "web-mode",
      categoryId: "tools",
      editor: { kind: "choice", actionId: "web-mode", values: ["auto", "on", "off"] },
    });
    const projected = (id: SettingsItemId) => {
      const found = capture.items.find((item) => item.id === id);
      assert.ok(found, id);
      return found;
    };
    assert.deepEqual(projected("cost-summary"), {
      id: "cost-summary", categoryId: "approvals-costs", editor: { kind: "readonly" },
    });
    assert.deepEqual(projected("provider-setup"), {
      id: "provider-setup", categoryId: "accounts", editor: { kind: "invoke", actionId: "provider-setup" },
    });
    assert.deepEqual(projected("main-model"), {
      id: "main-model", categoryId: "models", editor: { kind: "model", actionId: "main-model", filter: "main" },
    });
    assert.deepEqual(projected("panel-models"), {
      id: "panel-models", categoryId: "tools",
      editor: { kind: "model", actionId: "panel-models", filter: "panel", multiple: true },
    });
    assert.deepEqual(projected("max-cost"), {
      id: "max-cost", categoryId: "approvals-costs",
      editor: { kind: "number", actionId: "max-cost", minimum: 0.001, maximum: 1_000, unit: "USD" },
    });
    assert.deepEqual(projected("budget-daily"), {
      id: "budget-daily", categoryId: "approvals-costs",
      editor: { kind: "number", actionId: "budget-daily", minimum: 0.01, maximum: 100_000, unit: "USD", allowOff: true },
    });
    assert.deepEqual(projected("provider-only"), {
      id: "provider-only", categoryId: "approvals-costs",
      editor: { kind: "text", actionId: "provider-only", valueKind: "provider-list" },
    });
    assert.deepEqual(projected("approval-forget-all"), {
      id: "approval-forget-all", categoryId: "approvals-costs",
      editor: { kind: "confirm", actionId: "approval-forget-all", destructive: true },
    });
    for (const item of capture.items) {
      assert.equal(Object.isFrozen(item), true, `${item.id}: item frozen`);
      assert.equal(Object.isFrozen(item.editor), true, `${item.id}: editor frozen`);
      assert.deepEqual(
        Object.keys(item).sort(),
        (item.disabledReason === undefined
          ? ["categoryId", "editor", "id"]
          : ["categoryId", "disabledReason", "editor", "id"]).sort(),
        item.id,
      );
      const optionalEditorKeys = item.editor.kind === "model" && item.editor.multiple === true
        ? ["multiple"]
        : item.editor.kind === "number"
          ? [
              ...(item.editor.allowOff === true ? ["allowOff"] : []),
              ...(item.editor.unit === undefined ? [] : ["unit"]),
            ]
          : [];
      const expectedEditorKeys = item.editor.kind === "readonly"
        ? ["kind"]
        : item.editor.kind === "choice"
          ? ["actionId", "kind", "values"]
          : item.editor.kind === "model"
            ? ["actionId", "filter", "kind", ...optionalEditorKeys]
            : item.editor.kind === "number"
              ? ["actionId", "kind", "maximum", "minimum", ...optionalEditorKeys]
              : item.editor.kind === "text"
                ? ["actionId", "kind", "valueKind"]
                : item.editor.kind === "confirm"
                  ? ["actionId", "destructive", "kind"]
                  : ["actionId", "kind"];
      assert.deepEqual(Object.keys(item.editor).sort(), expectedEditorKeys.sort(), `${item.id}: editor schema`);
    }
    for (const source of controller.view.allItems) {
      if (source.editor.kind !== "choice") continue;
      const captured = projected(source.id);
      assert.equal(captured.editor.kind, "choice", source.id);
      if (captured.editor.kind !== "choice") continue;
      assert.equal(Object.isFrozen(captured.editor.values), true, `${source.id}: values frozen`);
      assert.deepEqual(
        captured.editor.values,
        source.editor.options.map(({ value }) => value),
        `${source.id}: ordered choice values`,
      );
    }
  });
});

test("Desktop-Capture exposes command counts and rule decisions but no raw command query or source display", async () => {
  await withTempConfig(async (path) => {
    const complete = completeRuntimeSnapshot();
    const initialSnapshot = {
      ...complete,
      config: {
        ...complete.config,
        verify: {
          ...complete.config.verify,
          commands: ["PRIVATE_VERIFY_COMMAND_CANARY --token secret"],
        },
      },
      providers: complete.providers.map((provider) => provider.backendId === "openrouter" ? ({
        ...provider,
        displayName: "PRIVATE_PROVIDER_DISPLAY_CANARY",
        health: { ...provider.health!, privateRawBody: "PRIVATE_PROVIDER_HEALTH_CANARY" },
        selectedModel: {
          requestedModelId: "openai/safe-requested-model",
          canonicalModelId: "PRIVATE_PROVIDER_CANONICAL_CANARY",
          displayName: "PRIVATE_SELECTED_MODEL_DISPLAY_CANARY",
        },
      } as unknown as typeof provider) : provider),
    } satisfies SettingsControllerSnapshot;
    const setup = harness(path, { initialSnapshot });
    const controller = await SettingsController.open(setup.dependencies);
    await controller.dispatch({ kind: "search-change", query: "PRIVATE_QUERY_CANARY" });

    const capture = controller.captureDesktopProjection();

    assert.deepEqual(capture.rowTruth["verify-commands"], { kind: "count", count: 1, subject: "commands" });
    assert.deepEqual(capture.rowTruth[`approval-rule:${RULE_ID}`], { kind: "approval-rule", decision: "allow" });
    assert.equal(capture.readOnlyReason, null);
    assert.deepEqual(capture.items.find(({ id }) => id === "verify-commands"), {
      id: "verify-commands",
      categoryId: "tools",
      editor: { kind: "text", actionId: "verify-commands", valueKind: "command-list" },
    });
    const providerTruth = capture.rowTruth["provider-status:openrouter"];
    assert.equal(providerTruth?.kind, "provider-status");
    if (providerTruth?.kind === "provider-status") {
      assert.deepEqual(Object.keys(providerTruth.provider).sort(), [
        "allowedActions", "availability", "backendId", "billingRealm", "configuration", "headline",
        "isDefault", "maturity", "selectedRequestedModelId",
      ]);
      assert.equal(providerTruth.provider.selectedRequestedModelId, "openai/safe-requested-model");
    }
    assert.doesNotMatch(
      JSON.stringify(capture),
      /PRIVATE_VERIFY_COMMAND_CANARY|PRIVATE_QUERY_CANARY|--token secret|PRIVATE_PROVIDER_|PRIVATE_SELECTED_MODEL_/,
    );
  });
});

test("der sequentielle Session-Loop hält höchstens einen Await offen und beendet exakt einmal", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    const events: string[] = [];
    let outstanding = 0;
    let maxOutstanding = 0;
    const intents = [
      { kind: "category", categoryId: "tools" } as const,
      { kind: "activate" } as const,
      { kind: "back" } as const,
    ];
    const surface: SettingsSurface = {
      begin() {
        events.push("begin");
      },
      async nextIntent() {
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        const intent = intents.shift();
        outstanding -= 1;
        if (!intent) throw new Error("unexpected intent request");
        return intent;
      },
      async edit(request) {
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        events.push(`edit:${request.itemId}`);
        outstanding -= 1;
        return { kind: "cancel" };
      },
      end() {
        events.push("end");
      },
    };

    await runSettingsSession(controller, surface);
    assert.equal(maxOutstanding, 1);
    assert.deepEqual(events, ["begin", "edit:verify-mode", "end"]);
  });
});

test("Desktop appearance changes survive a genuine same-home close and controller recreation", async () => {
  await withTempConfig(async (path) => {
    await saveConfig(DEFAULT_CONFIG, path);

    const openSession = async () => {
      const loaded = await loadConfig(path);
      const setup = harness(path, {
        initialSnapshot: runtimeSnapshot(loaded),
        baseline: loaded,
        readConfig: readConfigEditSnapshot,
        saveConfig: saveConfigEdit,
      });
      const controller = await SettingsController.open(setup.dependencies);
      let requestClose!: () => void;
      let signalBegin!: () => void;
      const began = new Promise<void>((resolve) => { signalBegin = resolve; });
      const surface: SettingsSurface = {
        begin(_view, control) {
          requestClose = () => control.requestClose();
          signalBegin();
        },
        nextIntent() {
          return new Promise<SettingsIntent>(() => undefined);
        },
        async edit() {
          throw new Error("the Desktop boolean path must not open an editor surface");
        },
        end() {},
      };
      const completed = runSettingsSession(controller, surface);
      await began;
      return {
        desktop: new DesktopSettingsController(controller),
        async close() {
          requestClose();
          await completed;
        },
      };
    };

    const findBoolean = (desktop: DesktopSettingsController, label: string) => {
      const row = desktop.view.categories
        .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
        .find((candidate) => candidate.label === label);
      assert.ok(row, `${label} must be projected`);
      assert.equal(row.control, "boolean");
      return row;
    };

    const first = await openSession();
    const logo = findBoolean(first.desktop, "Großes ORCODE-Logo");
    const afterLogo = await first.desktop.dispatch({
      kind: "set-boolean",
      handle: logo.handle,
      value: false,
      revision: first.desktop.view.revision,
    });
    assert.equal(
      afterLogo.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
        .find(({ label }) => label === "Großes ORCODE-Logo")?.booleanValue,
      false,
      "the settled projection updates immediately",
    );
    const header = findBoolean(first.desktop, "Kompakte Kopfmarke");
    const afterHeader = await first.desktop.dispatch({
      kind: "set-boolean",
      handle: header.handle,
      value: false,
      revision: first.desktop.view.revision,
    });
    assert.equal(
      (await loadConfig(path)).appearance.showHeaderMark,
      false,
      "the second action reaches the real config file before close",
    );
    assert.equal(
      afterHeader.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
        .find(({ label }) => label === "Kompakte Kopfmarke")?.booleanValue,
      false,
      "the second settled projection also updates immediately",
    );
    await first.close();

    const durable = await loadConfig(path);
    assert.equal(durable.appearance.showLargeLogo, false);
    assert.equal(durable.appearance.showHeaderMark, false);

    const second = await openSession();
    assert.equal(findBoolean(second.desktop, "Großes ORCODE-Logo").booleanValue, false);
    assert.equal(findBoolean(second.desktop, "Kompakte Kopfmarke").booleanValue, false);
    await second.close();
  });
});

test("der Session-Loop beendet auch bei Begin-, Intent-, Editor- und Controllerfehler exakt einmal", async () => {
  await withTempConfig(async (path) => {
    for (const failure of ["begin", "intent", "editor", "controller"] as const) {
      const controller = await SettingsController.open(harness(path).dependencies);
      let ended = 0;
      const surface: SettingsSurface = {
        begin() {
          if (failure === "begin") throw new Error("begin failed");
        },
        async nextIntent() {
          if (failure === "intent") throw new DOMException("aborted", "AbortError");
          if (failure === "controller") return { kind: "category", categoryId: "invalid" as never };
          return { kind: "activate" };
        },
        async edit() {
          if (failure === "editor") throw new Error("editor failed");
          return { kind: "cancel" };
        },
        end() {
          ended += 1;
        },
      };
      await assert.rejects(runSettingsSession(controller, surface));
      assert.equal(ended, 1, failure);
    }
  });
});

test("FIX-14 ticket 12: an editor that fails to OPEN still tears down once, and says why Settings closed", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    let ended = 0;
    let openedRequest: SettingsEditorRequest | null = null;
    const cause = new Error("catalog-read-failed-request-id-123");
    const surface: SettingsSurface = {
      begin() {},
      async nextIntent() { return { kind: "activate" }; },
      async edit(request) {
        openedRequest = request;
        throw cause;
      },
      end() { ended += 1; },
    };

    await assert.rejects(
      runSettingsSession(controller, surface),
      (error: unknown) => {
        assert.ok(error instanceof SettingsEditorOpenError, String(error));
        // Names the row whose editor could not open — the fact that makes
        // sense of Settings vanishing.
        assert.equal(
          error.message,
          `Settings closed — the editor for "${openedRequest!.label}" could not be opened.`,
        );
        // The foreign failure's own text never reaches this surface, exactly
        // as the controller's own external-error notice already guarantees.
        assert.doesNotMatch(error.message, /request-id|catalog-read-failed/);
        assert.equal(error.cause, cause, "the original is kept, not swallowed");
        return true;
      },
    );
    // The pinned teardown contract is untouched.
    assert.equal(ended, 1);
  });
});

test("Cross Settings staging holds a partial pair, publishes exactly once when complete, and rejects equal routes without publishing", async () => {
  await withTempConfig(async (path) => {
    const lead = selectableSettingsRoute("cross/staging-lead");
    const challenger = selectableSettingsRoute("cross/staging-challenger");
    let crossState: CrossPreferencesV1 = { lead: null, challenger: null };
    const publishes: CrossPreferencesV1[] = [];
    const projected = { ...completeRuntimeSnapshot(), cross: crossProjection({ preferences: crossState }) };
    const exactFile = await readConfigEditSnapshot(path);
    const editable: ConfigEditSnapshot = {
      file: exactFile.file,
      config: fullConfigFromProjection(projected.config),
    };
    const setup = harness(path, {
      initialSnapshot: projected,
      readConfig: async () => editable,
      snapshotForRead: (snapshot) => ({ ...snapshot, cross: crossProjection({ preferences: crossState }) }),
      // Mirrors createSettingsSession's real cross-role executor in src/cli.ts:
      // stage a partial pair, publish exactly once both roles resolve and
      // differ, and never publish (or move staging) on an equal pair.
      executeExternal: async (action) => {
        if (action.kind !== "cross-role") return;
        const selected = action.selection.handle.includes("challenger") ? challenger.route : lead.route;
        const next = { ...crossState, [action.role]: selected };
        if (next.lead && next.challenger) {
          if (sameCanonicalModelRoute(next.lead, next.challenger)) {
            throw new Error("Cross needs two different, fully resolved model routes.");
          }
          publishes.push(next);
        }
        crossState = next;
      },
    });
    const controller = await SettingsController.open(setup.dependencies);
    const displayValue = (id: string) =>
      controller.view.allItems.find((candidate) => candidate.id === id)!.displayValue;

    await controller.dispatch({ kind: "select-item", itemId: "cross-lead-model" });
    const openedLead = await controller.dispatch({ kind: "activate" });
    assert.equal(openedLead.kind, "edit");
    if (openedLead.kind !== "edit") return;
    // F1b: nothing to exclude while the counterpart is unset — the same answer
    // the route-valued `excludeRoute` gave, said without an identity.
    assert.equal(openedLead.request.excludeCrossRole, undefined);
    const afterLead = await controller.completeEditor(openedLead.request, {
      kind: "value",
      value: { kind: "model-route", selection: routeIntent("cross/staging-lead") },
    });
    assert.equal(afterLead.kind, "render");
    assert.equal(publishes.length, 0, "one role alone must not publish");
    assert.deepEqual(setup.externalActions, [{ kind: "cross-role", role: "lead", selection: routeIntent("cross/staging-lead") }]);
    assert.match(displayValue("cross-lead-model"), /staged/, "the staged role needs a visible hint");
    assert.equal(displayValue("cross-challenger-model"), "Not set");

    await controller.dispatch({ kind: "select-item", itemId: "cross-challenger-model" });
    const openedChallenger = await controller.dispatch({ kind: "activate" });
    assert.equal(openedChallenger.kind, "edit");
    if (openedChallenger.kind !== "edit") return;
    // F1b: the STAGED lead is excluded from the challenger's picker — named by
    // role, so the request a surface receives carries no `accountFingerprint`.
    assert.equal(openedChallenger.request.excludeCrossRole, "lead");
    assert.equal(
      JSON.stringify(openedChallenger.request).includes(lead.route.accountFingerprint),
      false,
    );
    const afterChallenger = await controller.completeEditor(openedChallenger.request, {
      kind: "value",
      value: { kind: "model-route", selection: routeIntent("cross/staging-challenger") },
    });
    assert.equal(afterChallenger.kind, "render");
    assert.equal(publishes.length, 1, "a complete distinct pair publishes exactly once");
    assert.deepEqual(publishes[0], { lead: lead.route, challenger: challenger.route });
    assert.equal(displayValue("cross-lead-model"), "cross/staging-lead", "no stale staged hint once published");
    assert.equal(displayValue("cross-challenger-model"), "cross/staging-challenger");

    await controller.dispatch({ kind: "select-item", itemId: "cross-challenger-model" });
    const openedSame = await controller.dispatch({ kind: "activate" });
    assert.equal(openedSame.kind, "edit");
    if (openedSame.kind !== "edit") return;
    const afterSame = await controller.completeEditor(openedSame.request, {
      kind: "value",
      value: { kind: "model-route", selection: routeIntent("cross/staging-lead") },
    });
    assert.equal(afterSame.kind, "render");
    assert.equal(controller.view.notice?.kind, "error", "an equal-model pair must show a visible error");
    assert.equal(publishes.length, 1, "the equal-route attempt must not publish");
  });
});

test("Cross pair swap publishes once with roles exchanged and stays unreachable while a role is missing", async () => {
  await withTempConfig(async (path) => {
    const lead = selectableSettingsRoute("cross/swap-lead");
    const challenger = selectableSettingsRoute("cross/swap-challenger");
    let crossState: CrossPreferencesV1 = { lead: lead.route, challenger: challenger.route };
    const publishes: CrossPreferencesV1[] = [];
    const projected = { ...completeRuntimeSnapshot(), cross: crossProjection({ preferences: crossState }) };
    const exactFile = await readConfigEditSnapshot(path);
    const editable: ConfigEditSnapshot = {
      file: exactFile.file,
      config: fullConfigFromProjection(projected.config),
    };
    const setup = harness(path, {
      initialSnapshot: projected,
      readConfig: async () => editable,
      snapshotForRead: (snapshot) => ({ ...snapshot, cross: crossProjection({ preferences: crossState }) }),
      executeExternal: async (action) => {
        if (action.kind !== "cross-swap") return;
        if (!crossState.lead || !crossState.challenger) {
          throw new Error("Cross swap requires both roles to be set.");
        }
        const next = { lead: crossState.challenger, challenger: crossState.lead };
        publishes.push(next);
        crossState = next;
      },
    });
    const controller = await SettingsController.open(setup.dependencies);

    await controller.dispatch({ kind: "select-item", itemId: "cross-pair-swap" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;
    const completed = await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.equal(completed.kind, "render");
    assert.deepEqual(setup.externalActions, [{ kind: "cross-swap" }]);
    assert.equal(publishes.length, 1);
    assert.deepEqual(publishes[0], { lead: challenger.route, challenger: lead.route });
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "cross-lead-model")!.displayValue,
      "cross/swap-challenger",
      "roles must be exchanged",
    );

    const incompleteSetup = harness(path, {
      initialSnapshot: {
        ...completeRuntimeSnapshot(),
        cross: crossProjection({ preferences: { lead: lead.route, challenger: null } }),
      },
      readConfig: async () => editable,
    });
    const incompleteController = await SettingsController.open(incompleteSetup.dependencies);
    await incompleteController.dispatch({ kind: "select-item", itemId: "cross-pair-swap" });
    const blockedOpen = await incompleteController.dispatch({ kind: "activate" });
    assert.equal(blockedOpen.kind, "render", "an incomplete pair must never open the swap editor");
    assert.deepEqual(incompleteSetup.externalActions, [], "an incomplete pair must never reach the external port");
    assert.equal(
      incompleteController.view.allItems.find(({ id }) => id === "cross-pair-swap")!.disabledReason,
      "Both roles must be set before swapping",
    );
  });
});

test("the settings success notice states the provider mutation that actually happened (FIX-18 F7)", () => {
  // "Saved" claimed a value write for destructive account mutations —
  // disconnecting reported "✓ Saved". The verb now matches the act.
  const provider = (kind: "disconnect" | "disable" | "logout" | "reconnect" | "enable") =>
    ({ kind: "provider", intent: { kind, backendId: "openrouter" } }) as SettingsExternalAction;
  assert.equal(externalActionSuccessNotice(provider("disconnect")), "Disconnected");
  assert.equal(externalActionSuccessNotice(provider("disable")), "Disabled");
  assert.equal(externalActionSuccessNotice(provider("logout")), "Logged out");
  assert.equal(externalActionSuccessNotice(provider("reconnect")), "Saved");
  assert.equal(externalActionSuccessNotice(provider("enable")), "Saved");
  assert.equal(
    externalActionSuccessNotice({ kind: "approval-forget-all" } as SettingsExternalAction),
    "Saved",
  );
});

/**
 * FIX-14 ticket 5 (one notice shape, one vocabulary). Three explicit notice
 * shapes carried five disagreeing vocabularies: the settings slot could say
 * "success" but not "warn", a transcript block could say "warn" but not
 * "success", and the setup surface encoded severity and settled/in-progress
 * in two booleans. One vocabulary is declared in types.ts now, and each
 * surface narrows FROM it rather than declaring its own.
 */
test("FIX-14 ticket 5: every notice kind a surface uses comes from the one vocabulary", () => {
  // The settings slot's own four, still exactly the four it emits or renders.
  for (const kind of ["success", "info", "error", "busy"] as const) {
    assert.ok(NOTICE_KINDS.includes(kind), kind);
  }
  // The transcript block's three are a subset of the same list, never a
  // parallel union — a `NoticeKind` that a block rejects is excluded from
  // it explicitly (`Exclude<NoticeKind, "busy" | "success">`, blocks.ts).
  for (const level of ["info", "warn", "error"] as const) {
    assert.ok(NOTICE_KINDS.includes(level), level);
  }
  // And the vocabulary itself is closed: a fifth idea of "what an outcome
  // is" has to be added here, where every surface sees it.
  assert.deepEqual([...NOTICE_KINDS], ["success", "info", "warn", "error", "busy"]);
});
