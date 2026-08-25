import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigEditConflictError,
  ConfigEditUnverifiedError,
  DEFAULT_CONFIG,
  readConfigEditSnapshot,
  validateConfig,
  type ConfigEditSnapshot,
  type ConfigInput,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import {
  SettingsController,
  applyConfigAction,
  type SettingsConfigAction,
  type SettingsControllerDependencies,
  type SettingsControllerSnapshot,
  type SettingsExternalAction,
} from "../src/settings-controller.js";
import {
  runSettingsSession,
  type SettingsSurface,
} from "../src/settings-session.js";

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
  };
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
        supportedParameters: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
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
    ],
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
  readonly saveConfig?: SettingsControllerDependencies["saveConfig"];
  readonly executeExternal?: (action: SettingsExternalAction) => Promise<void>;
  readonly prepareLive?: SettingsControllerDependencies["liveConfig"]["prepare"];
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
          await options.executeExternal?.(action);
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
      readConfig: options.readConfig ?? readConfigEditSnapshot,
      saveConfig: options.saveConfig ?? (async (_expected, candidate, _path) => {
        events.push("persist-start");
        const saved = validateConfig(candidate);
        events.push("persist-done");
        return saved;
      }),
    },
  };
}

test("open wählt Kategorie eins und behält stabile Zeilen beim Navigieren, Suchen und Zurückgehen", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(controller.view.selectedCategoryId, "models-reasoning");
    assert.equal(controller.view.selectedItemId, "main-model");

    await controller.dispatch({ kind: "move", delta: -1 });
    assert.equal(controller.view.selectedItemId, "main-model");
    await controller.dispatch({ kind: "move", delta: 1 });
    const remembered = controller.view.selectedItemId;

    await controller.dispatch({ kind: "category", categoryId: "appearance" });
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    await controller.dispatch({ kind: "category", categoryId: "models-reasoning" });
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

test("ein unsicherer Config-Snapshot hält Settings lesbar und sperrt ausnahmslos jede Mutation", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path, {
      readConfig: async () => {
        throw new Error("private-storage-secret-must-not-surface");
      },
    });
    const controller = await SettingsController.open(setup.dependencies);

    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    for (const item of controller.view.allItems) {
      if (item.editor.kind === "readonly") continue;
      assert.equal(item.disabledReason, "Konfiguration schreibgeschützt", item.id);
    }
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    assert.equal(setup.events.includes("external-action"), false);
  });
});

test("eine gültige Config-Auswahl persistiert per CAS vor Live-Publikation und stellt den Fokus wieder her", async () => {
  await withTempConfig(async (path) => {
    const setup = harness(path);
    const controller = await SettingsController.open(setup.dependencies);
    setup.events.length = 0;

    await controller.dispatch({ kind: "category", categoryId: "appearance" });
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
    assert.equal(controller.view.notice?.message, "Gespeichert");
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
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
    assert.equal(controller.view.notice?.message, "Gespeichert; Ansicht konnte nicht aktualisiert werden");
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Aus",
    );

    await controller.completeEditor(opened.request, { kind: "value", value: "on" });
    assert.equal(writes, 1, "der durable Editor darf nach fehlgeschlagenem Refresh nie erneut schreiben");
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
    await controller.dispatch({ kind: "category", categoryId: "appearance" });
    const opened = await controller.dispatch({ kind: "activate" });
    assert.equal(opened.kind, "edit");
    if (opened.kind !== "edit") return;

    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1);
    assert.equal(setup.published.length, 0);
    assert.equal(controller.view.notice?.message, "Einstellung wurde parallel geändert");
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
    assert.equal(controller.view.notice?.message, "Einstellung wurde parallel geändert");
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "Aus",
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
    assert.equal(controller.view.notice?.message, "Einstellung wurde parallel geändert");
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
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

    await controller.dispatch({ kind: "category", categoryId: "appearance" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "move", delta: 1 });
    assert.equal(controller.view.selectedItemId, "appearance-glyph-mode");
    assert.equal(before.selectedCategoryId, "models-reasoning");

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
      "allow-all führt Dateiänderungen und Shell-Befehle ohne Nachfrage aus. Wirklich aktivieren?",
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
    assert.equal(busyController.view.notice?.message, "Lauf aktiv");
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
    assert.equal(controller.view.notice?.message, "Gespeichert");
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
    assert.equal(ambiguousController.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(
      ambiguousController.view.notice?.message,
      "Speicherzustand konnte nicht sicher bestätigt werden",
    );
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
    assert.equal(controller.view.notice?.message, "Einstellung wurde parallel geändert");
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(controller.view.selectedItemId, "appearance-large-logo");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "An",
    );
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1, "ein unverified Ausgangssnapshot darf nie wiederverwendet werden");
  });
});

test("typed-unverified Mismatch bleibt bei Runtime-Disk-Split trotz erfolgreichem Refresh read-only", async () => {
  await withTempConfig(async (path) => {
    const initial = await readConfigEditSnapshot(path);
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
    assert.equal(controller.view.notice?.message, "Einstellung wurde parallel geändert");
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(
      controller.view.allItems.find(({ id }) => id === "appearance-large-logo")?.displayValue,
      "An",
    );
    assert.equal((await controller.dispatch({ kind: "activate" })).kind, "render");
    await controller.completeEditor(opened.request, { kind: "value", value: "off" });
    assert.equal(writes, 1);
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
    assert.equal(controller.view.notice?.message, "Aktion konnte nicht ausgeführt werden");
    assert.doesNotMatch(controller.view.notice?.message ?? "", /request-id|private/i);
    assert.deepEqual(setup.externalActions, [{ kind: "provider", intent: { kind: "setup" } }]);
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
      "Aktion ausgeführt; Ansicht konnte nicht aktualisiert werden",
    );
    assert.equal(controller.view.readOnlyReason, "Konfiguration schreibgeschützt");
    assert.equal(controller.view.selectedItemId, "provider-setup");
    await controller.completeEditor(opened.request, { kind: "value", value: true });
    assert.equal(setup.externalActions.length, 1, "eine ausgeführte Action darf nie wiederholt werden");
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
      assert.equal(controller.view.notice?.message, "Einstellung konnte nicht gespeichert werden");
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
    { action: { kind: "reasoning", value: { mode: "effort", effort: "high" } }, read: (c) => c.reasoningByModel[c.mainModel], expected: { mode: "effort", effort: "high" } },
    { action: { kind: "compression-mode", value: "always" }, read: (c) => c.compressionMode, expected: "always" },
    { action: { kind: "max-steps", value: 33 }, read: (c) => c.maxSteps, expected: 33 },
    { action: { kind: "provider-sort", value: "price" }, read: (c) => c.provider.sort, expected: "price" },
    { action: { kind: "provider-data-collection", value: "allow" }, read: (c) => c.provider.dataCollection, expected: "allow" },
    { action: { kind: "provider-only", value: ["A", "B"] }, read: (c) => c.provider.only, expected: ["A", "B"] },
    { action: { kind: "provider-ignore", value: ["C"] }, read: (c) => c.provider.ignore, expected: ["C"] },
    { action: { kind: "provider-fallback", value: false }, read: (c) => c.provider.allowFallbacks, expected: false },
    { action: { kind: "approval-mode", value: "auto-edit" }, read: (c) => c.approvalMode, expected: "auto-edit" },
    { action: { kind: "max-cost", value: 2.5 }, read: (c) => c.maxCostUsd, expected: 2.5 },
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

test("jede konkrete Registry-Zeile erreicht exakt eine Config- oder ExternalAction", async () => {
  await withTempConfig(async (path) => {
    const projected = completeRuntimeSnapshot();
    const exactFile = await readConfigEditSnapshot(path);
    const editable: ConfigEditSnapshot = {
      file: exactFile.file,
      config: projected.config,
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
            if (item.editor.actionId === "compressor-model") return "openai/test-compressor";
            if (item.editor.actionId === "transcription-model") return "audio/test-model";
            return "openai/test-main";
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
              requestedModelId: "openai/test-main",
              canonicalModelId: "openai/test-main-canonical",
            } as const;
          case "compressor-model":
            return { kind: "compressor-model", modelId: "openai/test-compressor" } as const;
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
      readConfig: async () => ({ file: exact.file, config: projected.config }),
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
        readConfig: async () => ({ file: exact.file, config: projected.config }),
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

test("der sequentielle Session-Loop hält höchstens einen Await offen und beendet exakt einmal", async () => {
  await withTempConfig(async (path) => {
    const controller = await SettingsController.open(harness(path).dependencies);
    const events: string[] = [];
    let outstanding = 0;
    let maxOutstanding = 0;
    const intents = [
      { kind: "category", categoryId: "appearance" } as const,
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
    assert.deepEqual(events, ["begin", "edit:appearance-large-logo", "end"]);
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
