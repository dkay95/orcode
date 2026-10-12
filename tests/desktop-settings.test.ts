import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSettingsController, type DesktopSettingsCorePort } from "../src/desktop-settings.js";
import type {
  SettingsDesktopEditorSchema,
  SettingsDesktopProjectionItem,
} from "../src/settings-controller.js";
import type { SettingsItem } from "../src/settings-registry.js";

const row = (id: string, categoryId: SettingsItem["categoryId"], editor: SettingsItem["editor"], displayValue = "Off"): SettingsItem => ({
  id: id as SettingsItem["id"], categoryId, label: `English ${id}`, description: `English description ${id}`,
  aliases: [], displayValue, editor, affectsActiveRun: false,
});

function projectionItem(item: SettingsItem): SettingsDesktopProjectionItem {
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

function fixture(readOnlyReason: string | null = null) {
  let poisoned = false;
  let noticeOutcome: unknown = null;
  let rowTruthOverride: unknown = undefined;
  let providers: Array<{ backendId: string; configuration: "enabled" | "disabled" | "not-connected"; headline: string | null }> = [
    { backendId: "kimi-code", configuration: "enabled", headline: "offline" },
  ];
  const calls: Array<{ kind: "select-item"; itemId: SettingsItem["id"] } | { complete: unknown }> = [];
  const allItems: SettingsItem[] = [
    row("main-model", "models", { kind: "model", actionId: "main-model", filter: "main" }),
    row("provider-setup", "accounts", { kind: "invoke", actionId: "provider-setup" }, "Open"),
    row("provider-status:openrouter", "accounts", { kind: "readonly" }, "Ready"),
    row("provider-action:openrouter:connect", "accounts", { kind: "invoke", actionId: "provider-connect" }, "Run"),
    row("provider-action:openrouter:enable", "accounts", { kind: "invoke", actionId: "provider-enable" }, "Run"),
    row("provider-action:openrouter:disable", "accounts", { kind: "invoke", actionId: "provider-disable" }, "Run"),
    row("provider-action:openrouter:disconnect", "accounts", { kind: "invoke", actionId: "provider-disconnect" }, "Run"),
    row("provider-action:openrouter:reconnect", "accounts", { kind: "invoke", actionId: "provider-reconnect" }, "Run"),
    row("provider-action:openrouter:models", "accounts", { kind: "invoke", actionId: "provider-models" }, "Run"),
    row("provider-action:openrouter:logout", "accounts", { kind: "invoke", actionId: "provider-logout" }, "Run"),
    row("provider-status:kimi-code", "accounts", { kind: "readonly" }, "Offline"),
    row("provider-action:kimi-code:reconnect", "accounts", { kind: "invoke", actionId: "provider-reconnect" }, "Run"),
    row("approval-mode", "approvals-costs", { kind: "choice", actionId: "approval-mode", options: [
      { value: "read-only", label: "Read only", description: "Read only" },
      { value: "ask", label: "Ask", description: "Ask" },
      { value: "auto-edit", label: "Auto-edit", description: "Auto-edit" },
      { value: "allow-all", label: "Allow all", description: "Allow all" },
    ] }, "Ask"),
    row("provider-data-collection", "approvals-costs", { kind: "choice", actionId: "provider-data-collection", options: [{ value: "deny", label: "Deny", description: "Deny" }, { value: "allow", label: "Allow", description: "Allow" }] }, "Deny"),
    row("max-cost", "approvals-costs", {
      kind: "number", actionId: "max-cost", minimum: 0.001, maximum: 1_000, unit: "USD",
    }, "$1.00"),
    row("verify-mode", "tools", { kind: "choice", actionId: "verify-mode", options: [{ value: "off", label: "Off", description: "Off" }, { value: "on-edit", label: "After changes", description: "After" }] }),
    row("web-mode", "tools", { kind: "choice", actionId: "web-mode", options: [{ value: "auto", label: "Automatic", description: "Auto" }, { value: "on", label: "On", description: "On" }, { value: "off", label: "Off", description: "Off" }] }, "Automatic"),
    row("appearance-large-logo", "appearance", { kind: "choice", actionId: "appearance-large-logo", options: [{ value: "on", label: "On", description: "On" }, { value: "off", label: "Off", description: "Off" }] }),
    row("appearance-header-mark", "appearance", { kind: "choice", actionId: "appearance-header-mark", options: [{ value: "on", label: "On", description: "On" }, { value: "off", label: "Off", description: "Off" }] }),
    row("appearance-glyph-mode", "appearance", { kind: "choice", actionId: "appearance-glyph-mode", options: [{ value: "auto", label: "Automatic", description: "Auto" }, { value: "unicode", label: "Unicode", description: "Unicode" }, { value: "ascii", label: "ASCII", description: "ASCII" }] }, "Automatic"),
  ];
  const captureDesktopProjection = () => {
    const rowTruth = {
      "main-model": { kind: "model", modelIds: ["openrouter/auto"], state: "configured" },
      "provider-setup": { kind: "action", actionId: "provider-setup" },
      "provider-status:openrouter": { kind: "provider-status", provider: providerProjection("openrouter", providers) },
      "provider-action:openrouter:connect": { kind: "provider-action", backendId: "openrouter", action: "connect" },
      "provider-action:openrouter:enable": { kind: "provider-action", backendId: "openrouter", action: "enable" },
      "provider-action:openrouter:disable": { kind: "provider-action", backendId: "openrouter", action: "disable" },
      "provider-action:openrouter:disconnect": { kind: "provider-action", backendId: "openrouter", action: "disconnect" },
      "provider-action:openrouter:reconnect": { kind: "provider-action", backendId: "openrouter", action: "reconnect" },
      "provider-action:openrouter:models": { kind: "provider-action", backendId: "openrouter", action: "models" },
      "provider-action:openrouter:logout": { kind: "provider-action", backendId: "openrouter", action: "logout" },
      "provider-status:kimi-code": { kind: "provider-status", provider: providerProjection("kimi-code", providers) },
      "provider-action:kimi-code:reconnect": { kind: "provider-action", backendId: "kimi-code", action: "reconnect" },
      "approval-mode": { kind: "choice", value: "ask" },
      "provider-data-collection": { kind: "choice", value: "deny" },
      "max-cost": { kind: "number", value: 1, unit: "usd" },
      "verify-mode": { kind: "choice", value: "off" },
      "web-mode": { kind: "choice", value: "auto" },
      "appearance-large-logo": { kind: "boolean", value: false },
      "appearance-header-mark": { kind: "boolean", value: false },
      "appearance-glyph-mode": { kind: "choice", value: "auto" },
      ...(poisoned ? { "future-private-row": { kind: "choice", value: "PRIVATE_POISON_CANARY" } } : {}),
    };
    return {
      items: [
        ...allItems.map(projectionItem),
        ...(poisoned ? [{
          id: "future-private-row", categoryId: "appearance", editor: { kind: "readonly" },
        }] : []),
      ],
      readOnlyReason,
      rowTruth: rowTruthOverride === undefined ? rowTruth : rowTruthOverride,
      noticeOutcome,
    };
  };
  const controller = {
    captureDesktopProjection() {
      return captureDesktopProjection();
    },
    async beginDesktopOperation(itemId: SettingsItem["id"]) {
      calls.push({ kind: "select-item", itemId });
      const token = Object.freeze({});
      if (itemId === "appearance-large-logo") {
        return {
          token,
          result: {
            kind: "edit",
            request: { generation: 1, categoryId: "appearance", itemId, label: "English", description: "English", editor: allItems.find(({ id }) => id === itemId)!.editor },
          },
        };
      }
      return { token, result: { kind: "terminal", effect: "render", capture: captureDesktopProjection() } };
    },
    async advanceDesktopOperation(_token: unknown, _request: unknown, result: unknown) {
      calls.push({ complete: result });
      return { kind: "terminal", effect: "render", capture: captureDesktopProjection() };
    },
    async abortDesktopOperation(_token: unknown, _request: unknown) {
      calls.push({ complete: { kind: "cancel" } });
      return { kind: "terminal", effect: "render", capture: captureDesktopProjection() };
    },
  } as unknown as DesktopSettingsCorePort;
  return {
    desktop: new DesktopSettingsController(controller), calls,
    setPoison(value: boolean) { poisoned = value; },
    setNoticeOutcome(value: unknown) { noticeOutcome = value; },
    setProviders(value: typeof providers) { providers = value; },
    setRowTruth(value: unknown) { rowTruthOverride = value; },
  };
}

function providerProjection(
  backendId: "openrouter" | "kimi-code",
  providers: Array<{ backendId: string; configuration: "enabled" | "disabled" | "not-connected"; headline: string | null }>,
) {
  const source = providers.find((provider) => provider.backendId === backendId)
    ?? { configuration: "not-connected" as const, headline: null };
  return {
    backendId,
    availability: "connectable" as const,
    configuration: source.configuration,
    maturity: backendId === "openrouter" ? "stable" as const : "preview" as const,
    billingRealm: backendId === "openrouter" ? "openrouter-payg" as const : "kimi-code-membership-provider-managed-overage" as const,
    headline: source.headline,
    isDefault: backendId === "openrouter",
    selectedRequestedModelId: null,
    allowedActions: backendId === "openrouter" ? ["connect"] as const : ["reconnect"] as const,
  };
}

test("Desktop Settings has four ordered German areas and every appearance row lives under Mehr", async () => {
  const { desktop } = fixture();
  const beforeHandles = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]).map(({ handle }) => handle);
  const view = await desktop.dispatch({ kind: "toggle-advanced", categoryId: "more", revision: desktop.view.revision });
  assert.deepEqual(view.categories.map(({ id }) => id), ["model", "accounts", "security", "more"]);
  assert.ok(view.categories.every(({ commonItems }) => commonItems.length <= 3));
  const more = view.categories[3]!;
  assert.equal(more.expanded, true);
  assert.ok(view.categories.slice(0, 3).every(({ expanded }) => expanded === false));
  assert.equal(more.advancedItems.length > 0, true);
  assert.equal(beforeHandles.some((handle) => view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]).some((row) => row.handle === handle)), false);
  assert.deepEqual([...more.commonItems, ...more.advancedItems].map(({ label }) => label).filter((label) => ["Großes ORCODE-Logo", "Kompakte Kopfmarke", "Terminalzeichen"].includes(label)).sort(), ["Großes ORCODE-Logo", "Kompakte Kopfmarke", "Terminalzeichen"].sort());
});

test("German search reaches a hidden advanced glyph row", async () => {
  const { desktop } = fixture();
  assert.equal(desktop.view.categories[3]!.expanded, false);
  assert.ok(desktop.view.categories[3]!.advancedItems.length > 0);
  const next = await desktop.dispatch({ kind: "search-change", query: "terminalzeichen", revision: desktop.view.revision });
  assert.equal(next.search.results.some(({ label }) => label === "Terminalzeichen"), true);
});

test("a typed degraded account promotes its repair row without parsing English status copy", () => {
  const { desktop } = fixture();
  assert.equal(desktop.view.categories[1]!.commonItems[0]?.label, "Kimi Code · Neu verbinden");
});

test("disabled disconnected and recovered providers keep their own semantics instead of degraded repair", async () => {
  const { desktop, setProviders } = fixture();
  setProviders([{ backendId: "kimi-code", configuration: "disabled", headline: "offline" }]);
  let view = await desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: desktop.view.revision });
  assert.notEqual(view.categories[1]!.commonItems[0]?.label, "Kimi Code · Neu verbinden");
  setProviders([{ backendId: "kimi-code", configuration: "not-connected", headline: null }]);
  view = await desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: view.revision });
  assert.notEqual(view.categories[1]!.commonItems[0]?.label, "Kimi Code · Neu verbinden");
  setProviders([{ backendId: "kimi-code", configuration: "enabled", headline: "ready" }]);
  view = await desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: view.revision });
  assert.notEqual(view.categories[1]!.commonItems[0]?.label, "Kimi Code · Neu verbinden");
});

test("typed boolean dispatch never reads displayValue and adapts only at the private Core editor boundary", async () => {
  const { desktop, calls } = fixture();
  const expanded = await desktop.dispatch({ kind: "toggle-advanced", categoryId: "more", revision: desktop.view.revision });
  const target = [...expanded.categories[3]!.commonItems, ...expanded.categories[3]!.advancedItems]
    .find(({ label }) => label === "Großes ORCODE-Logo")!;
  assert.equal(target.booleanValue, false, "the stale display deliberately disagrees with the typed update");
  await desktop.dispatch({ kind: "set-boolean", handle: target.handle, value: true, revision: expanded.revision });
  assert.deepEqual(calls.at(-1), { complete: { kind: "value", value: "on" } });
});

test("typed boolean dispatch rejects data-sharing and glyph choices before Core calls", async () => {
  const { desktop, calls } = fixture();
  const all = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]);
  for (const label of ["OpenRouter-Datenfreigabe", "Terminalzeichen"]) {
    const target = all.find((row) => row.label === label)!;
    await assert.rejects(
      desktop.dispatch({ kind: "set-boolean", handle: target.handle, value: true, revision: desktop.view.revision }),
      /kein Schalter/,
      label,
    );
  }
  assert.equal(calls.length, 0);
});

test("a locally locked Desktop row rejects before the Core begin authority", async () => {
  const { desktop, calls } = fixture("Another orcode changed the config. Restart to adopt it.");
  const row = desktop.view.categories
    .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
    .find(({ label }) => label === "Anbieter einrichten");
  assert.ok(row);
  assert.equal(row.control, "locked");

  await assert.rejects(
    desktop.dispatch({ kind: "activate-row", handle: row.handle, revision: desktop.view.revision }),
    /gesperrt/,
  );
  assert.deepEqual(calls, []);
});

test("stale unknown handles and overlong search fail before controller mutation", async () => {
  const { desktop, calls } = fixture();
  const revision = desktop.view.revision;
  await assert.rejects(desktop.dispatch({ kind: "activate-row", handle: "forged", revision }), /nicht verfügbar/);
  await assert.rejects(desktop.dispatch({ kind: "search-change", query: "x".repeat(121), revision }), /zu lang/);
  await desktop.dispatch({ kind: "select-category", categoryId: "more", revision });
  await assert.rejects(desktop.dispatch({ kind: "back", revision }), /veraltet/);
  assert.equal(calls.length, 0);
});

test("live opaque Settings handles resolve picker rows and non-destructive provider deep links before Core", () => {
  const { desktop, calls } = fixture();
  const rows = desktop.view.categories
    .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]);
  const main = rows.find(({ label }) => label === "Hauptmodell")!;
  const provider = rows.find(({ label }) => label === "Anbieter einrichten")!;
  const openRouterConnect = rows.find(({ label }) => label === "OpenRouter · Verbinden")!;
  const kimiReconnect = rows.find(({ label }) => label === "Kimi Code · Neu verbinden")!;
  const ordinary = rows.find(({ label }) => label === "Terminalzeichen")!;

  assert.deepEqual(desktop.navigationFor({
    kind: "activate-row",
    handle: main.handle,
    revision: desktop.view.revision,
  }), { kind: "model" });
  assert.deepEqual(desktop.navigationFor({
    kind: "activate-row",
    handle: provider.handle,
    revision: desktop.view.revision,
  }), { kind: "provider" });
  assert.deepEqual(desktop.navigationFor({
    kind: "activate-row",
    handle: openRouterConnect.handle,
    revision: desktop.view.revision,
  }), {
    kind: "provider",
    focusItemId: "provider-action:openrouter:connect",
    providerId: "openrouter",
  });
  for (const [label, action] of [
    ["OpenRouter · Neu verbinden", "reconnect"],
    ["OpenRouter · Modelle aktualisieren", "models"],
  ] as const) {
    const direct = rows.find((row) => row.label === label)!;
    assert.deepEqual(desktop.navigationFor({
      kind: "activate-row",
      handle: direct.handle,
      revision: desktop.view.revision,
    }), {
      kind: "provider",
      focusItemId: `provider-action:openrouter:${action}`,
      providerId: "openrouter",
    });
  }
  for (const label of [
    "OpenRouter · Aktivieren",
    "OpenRouter · Deaktivieren",
    "OpenRouter · Trennen",
    "OpenRouter · Abmelden",
  ]) {
    const lifecycleMutation = rows.find((row) => row.label === label)!;
    assert.equal(desktop.navigationFor({
      kind: "activate-row",
      handle: lifecycleMutation.handle,
      revision: desktop.view.revision,
    }), null, label);
  }
  assert.deepEqual(desktop.navigationFor({
    kind: "activate-row",
    handle: kimiReconnect.handle,
    revision: desktop.view.revision,
  }), {
    kind: "provider",
    focusItemId: "provider-action:kimi-code:reconnect",
    providerId: "kimi-code",
  });
  assert.equal(desktop.navigationFor({
    kind: "activate-row",
    handle: ordinary.handle,
    revision: desktop.view.revision,
  }), null);
  assert.equal(desktop.focusKeyForNavigation({ kind: "model" }), main.focusKey);
  assert.equal(desktop.focusKeyForNavigation({ kind: "provider" }), provider.focusKey);
  assert.equal(desktop.focusKeyForNavigation({
    kind: "provider",
    focusItemId: "provider-action:openrouter:connect",
    providerId: "openrouter",
  }), openRouterConnect.focusKey);
  assert.equal(desktop.focusKeyForNavigation({
    kind: "provider",
    focusItemId: "provider-action:kimi-code:reconnect",
    providerId: "kimi-code",
  }), kimiReconnect.focusKey);
  assert.notEqual(main.focusKey, main.handle, "focus identity is never mutation authority");
  assert.deepEqual(calls, [], "navigation resolution never starts a Core operation");
});

test("display-only row focus keys survive revision rotation while mutation handles do not", async () => {
  const { desktop } = fixture();
  const before = desktop.view.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]);
  const beforeMain = before.find(({ label }) => label === "Hauptmodell")!;
  const next = await desktop.dispatch({
    kind: "select-category", categoryId: "more", revision: desktop.view.revision,
  });
  const afterMain = next.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
    .find(({ label }) => label === "Hauptmodell")!;
  assert.notEqual(afterMain.handle, beforeMain.handle);
  assert.equal(afterMain.focusKey, beforeMain.focusKey);
});

test("Settings picker navigation rejects forged, stale and locked handles before Core", async () => {
  const open = fixture();
  assert.throws(() => open.desktop.navigationFor({
    kind: "activate-row",
    handle: "forged",
    revision: open.desktop.view.revision,
  }), /nicht verfügbar/);
  const staleHandle = open.desktop.view.categories
    .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
    .find(({ label }) => label === "Hauptmodell")!.handle;
  await open.desktop.dispatch({
    kind: "select-category",
    categoryId: "accounts",
    revision: open.desktop.view.revision,
  });
  assert.throws(() => open.desktop.navigationFor({
    kind: "activate-row",
    handle: staleHandle,
    revision: open.desktop.view.revision,
  }), /nicht verfügbar/);

  const locked = fixture("Another orcode changed the config. Restart to adopt it.");
  const lockedProvider = locked.desktop.view.categories
    .flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems])
    .find(({ label }) => label === "Anbieter einrichten")!;
  assert.throws(() => locked.desktop.navigationFor({
    kind: "activate-row",
    handle: lockedProvider.handle,
    revision: locked.desktop.view.revision,
  }), /gesperrt/);
  assert.deepEqual(open.calls, []);
  assert.deepEqual(locked.calls, []);
});

test("same-revision concurrency accepts only the first intent and the lane survives rejection", async () => {
  const { desktop, calls } = fixture();
  const revision = desktop.view.revision;
  const [first, second] = await Promise.allSettled([
    desktop.dispatch({ kind: "select-category", categoryId: "more", revision }),
    desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(calls.length, 0);
  const after = await desktop.dispatch({ kind: "search-change", query: "terminalzeichen", revision: desktop.view.revision });
  assert.equal(after.search.results.some(({ label }) => label === "Terminalzeichen"), true);
});

test("late projection poison publishes a handle-free diagnostic revision and then recovers atomically", async () => {
  const { desktop, setPoison } = fixture();
  const expanded = await desktop.dispatch({ kind: "toggle-advanced", categoryId: "more", revision: desktop.view.revision });
  const logo = [...expanded.categories[3]!.commonItems, ...expanded.categories[3]!.advancedItems]
    .find(({ label }) => label === "Großes ORCODE-Logo")!;
  setPoison(true);
  const diagnostic = await desktop.dispatch({ kind: "set-boolean", handle: logo.handle, value: true, revision: expanded.revision });
  assert.equal(diagnostic.revision, expanded.revision + 1);
  assert.equal(diagnostic.notice?.code, "failed");
  assert.equal(diagnostic.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]).length, 0);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_POISON_CANARY|future-private-row/);
  await assert.rejects(desktop.dispatch({ kind: "activate-row", handle: logo.handle, revision: diagnostic.revision }), /nicht verfügbar/);
  setPoison(false);
  const recovered = await desktop.dispatch({ kind: "search-change", query: "Terminalzeichen", revision: diagnostic.revision });
  assert.equal(recovered.notice, null);
  assert.equal(recovered.search.results.some(({ label }) => label === "Terminalzeichen"), true);
});

test("post-Core malformed capture TypeError publishes a handle-free diagnostic and recovers", async () => {
  const { desktop, setRowTruth } = fixture();
  const expanded = await desktop.dispatch({ kind: "toggle-advanced", categoryId: "more", revision: desktop.view.revision });
  const logo = [...expanded.categories[3]!.commonItems, ...expanded.categories[3]!.advancedItems]
    .find(({ label }) => label === "Großes ORCODE-Logo")!;
  setRowTruth(null);
  const diagnostic = await desktop.dispatch({ kind: "set-boolean", handle: logo.handle, value: true, revision: expanded.revision });
  assert.equal(diagnostic.revision, expanded.revision + 1);
  assert.equal(diagnostic.notice?.code, "failed");
  assert.equal(diagnostic.search.query, "");
  assert.equal(diagnostic.search.results.length, 0);
  assert.equal(diagnostic.categories.flatMap(({ commonItems, advancedItems }) => [...commonItems, ...advancedItems]).length, 0);
  await assert.rejects(desktop.dispatch({ kind: "activate-row", handle: logo.handle, revision: diagnostic.revision }), /nicht verfügbar/);
  setRowTruth(undefined);
  const recovered = await desktop.dispatch({ kind: "search-change", query: "Terminalzeichen", revision: diagnostic.revision });
  assert.equal(recovered.notice, null);
  assert.equal(recovered.search.results.some(({ label }) => label === "Terminalzeichen"), true);
  assert.equal(recovered.search.results.some(({ handle }) => handle === logo.handle), false);
});

test("invalid advanced category and root back reject without rotating revision", async () => {
  const { desktop, calls } = fixture();
  const revision = desktop.view.revision;
  await assert.rejects(desktop.dispatch({ kind: "toggle-advanced", categoryId: "future" as never, revision }), /Bereich/);
  await assert.rejects(desktop.dispatch({ kind: "back", revision }), /nichts/);
  assert.equal(desktop.view.revision, revision);
  assert.equal(calls.length, 0);
});

test("a failed local projection cannot commit selected query or advanced state", async () => {
  const { desktop, calls, setPoison } = fixture();
  const before = desktop.view;
  setPoison(true);
  await assert.rejects(
    desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: before.revision }),
    /sicher/,
  );
  assert.strictEqual(desktop.view, before, "the complete published state stays byte-for-byte unchanged");
  assert.deepEqual(calls, [], "pre-Core projection failure performs no Core operation");

  setPoison(false);
  const recovered = await desktop.dispatch({
    kind: "search-change",
    query: "Terminalzeichen",
    revision: before.revision,
  });
  assert.equal(recovered.selectedCategoryId, before.selectedCategoryId, "the rejected category never resurfaces");
  assert.equal(recovered.categories.every(({ expanded }) => expanded === false), true);
});

test("a malformed Core notice outcome fails closed without rotating the atomic state", async () => {
  const { desktop, setNoticeOutcome } = fixture();
  const before = desktop.view;
  setNoticeOutcome("PRIVATE_FUTURE_NOTICE");
  await assert.rejects(
    desktop.dispatch({ kind: "select-category", categoryId: "accounts", revision: before.revision }),
    (error: unknown) => error instanceof Error && /sicher/.test(error.message) && !/PRIVATE_FUTURE_NOTICE/.test(error.message),
  );
  assert.strictEqual(desktop.view, before);
});
