import { page, userEvent } from "@vitest/browser/context";
import { expect, test } from "vitest";

import type { BridgeHandlers, EngineInfo } from "../src/bridge.js";
import {
  mountDesktopWindow,
  type DesktopWindowBridge,
} from "../src/main.js";
import type {
  ChatRow,
  CostForecast,
  DesktopCapabilitySnapshot,
  DesktopOnboardingView,
  DesktopProviderCapability,
  DesktopRouteCandidate,
  DesktopSettingsCategoryId,
  DesktopSettingsRow,
  DesktopSettingsView,
  GuiStatus,
  ServerFrame,
} from "../src/protocol.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

function capabilitySnapshot(
  overrides: Partial<DesktopCapabilitySnapshot> = {},
): DesktopCapabilitySnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    generation: 3,
    routeRunnable: false,
    activeRoute: null,
    providers: [],
    undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
    ...overrides,
  };
}

function onboardingRoute(
  overrides: Partial<DesktopRouteCandidate> = {},
): DesktopRouteCandidate {
  return {
    handle: "route-owner-sonnet",
    providerId: "opaque-provider-owner",
    connectionId: "opaque-connection-owner",
    accountLabel: "Eigentümerkonto",
    canonicalModelId: "anthropic/claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    reasoning: "supported",
    capabilities: ["text", "image-input", "tools", "reasoning", "patch"],
    cost: { kind: "known", label: "Abrechnung nach Nutzung", source: "provider" },
    dataPolicy: { kind: "known", label: "Provider-Richtlinie", source: "provider" },
    runnable: true,
    ...overrides,
  };
}

function onboardingProvider(
  overrides: Partial<DesktopProviderCapability> = {},
): DesktopProviderCapability {
  return {
    providerId: "opaque-provider-owner",
    providerLabel: "OpenRouter · Eigentümerkonto",
    connectionId: "opaque-connection-owner",
    accountLabel: "Eigentümerkonto",
    state: "ready",
    setupMethods: ["openrouter-owner-connect"],
    multiProfile: { enabled: false },
    routes: [],
    ...overrides,
  };
}

function onboardingStep(
  overrides: Partial<DesktopOnboardingView> = {},
): DesktopOnboardingView {
  return {
    revision: 7,
    generation: 3,
    step: "provider",
    returnTo: "chat",
    operationHandle: "operation-browser-owner",
    providers: [],
    candidates: [],
    ...overrides,
  };
}

function onboardingEvent(view: DesktopOnboardingView): ServerFrame {
  return { t: "event", v: PROTOCOL_VERSION, e: "onboarding.view", view };
}

function settingsRow(
  handle: string,
  label: string,
  overrides: Partial<DesktopSettingsRow> = {},
): DesktopSettingsRow {
  return {
    handle,
    focusKey: handle.replace("opaque-settings", "focus-settings"),
    label,
    description: `${label} sicher verwalten`,
    displayValue: "Öffnen",
    control: "choice",
    ...overrides,
  };
}

test("Settings serializes rapid Search and turns immediate Escape into one canonical back", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const first = deferred<Record<string, unknown>>();
  bridge.queueResponse("settings.dispatch", first.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView() });
    await expect.element(page.getByRole("searchbox", { name: "Einstellungen durchsuchen" })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Einstellungen durchsuchen" }).element() as HTMLInputElement;
    search.focus();
    for (const draft of ["s", "se", "seltene"]) {
      search.value = draft;
      search.dispatchEvent(new InputEvent("input", { bubbles: true, data: draft.at(-1) ?? null }));
    }
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(1);
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")[0]).toEqual({
      t: "settings.dispatch",
      intent: { kind: "search-change", query: "s", revision: 40 },
    });

    await userEvent.keyboard("{Escape}");
    expect(bridge.requests.filter(({ t }) => t === "settings.close")).toHaveLength(0);
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(1);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41, searchQuery: "s" }),
    });
    first.resolve({ dispatched: "search-change" });
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(2);
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")[1]).toEqual({
      t: "settings.dispatch", intent: { kind: "back", revision: 41 },
    });
    expect(bridge.requests.some(({ intent }) =>
      (intent as { query?: string } | undefined)?.query === "seltene")).toBe(false);

    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView({ revision: 42 }) });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41, searchQuery: "stale replay" }),
    });
    await expect.poll(() => (page.getByRole("searchbox", { name: "Einstellungen durchsuchen" }).element() as HTMLInputElement).value)
      .toBe("");
    expect(root.textContent).not.toContain("stale replay");

    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 42, searchQuery: "closed replay" }),
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(root.querySelector(".settings")).toBeNull();
    expect(root.textContent).not.toContain("closed replay");
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("Settings queues deepest Escape behind a pending Weitere-Einstellungen transition", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const pending = deferred<Record<string, unknown>>();
  bridge.queueResponse("settings.dispatch", pending.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView() });
    await userEvent.click(page.getByRole("button", { name: "Weitere Einstellungen" }));
    await userEvent.keyboard("{Escape}");
    expect(bridge.requests.filter(({ t }) => t === "settings.close")).toHaveLength(0);
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(1);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41, modelExpanded: true }),
    });
    pending.resolve({ dispatched: "toggle-advanced" });
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(2);
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")[1]).toEqual({
      t: "settings.dispatch", intent: { kind: "back", revision: 41 },
    });
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("Settings restores presentation-only focus anchors after canonical transitions", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView() });
    const more = page.getByRole("button", { name: "Weitere Einstellungen" });
    await userEvent.click(more);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41, modelExpanded: true }),
    });
    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Weitere Einstellungen ausblenden");

    (page.getByRole("tab", { name: "Modell" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 42, selectedCategoryId: "accounts", modelExpanded: true }),
    });
    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Konten");

    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 43, selectedCategoryId: "more" }),
    });
    const toggle = page.getByRole("switch", { name: /Kompakte Kopfmarke/ });
    await userEvent.click(toggle);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 44, selectedCategoryId: "more", showHeaderMark: false }),
    });
    await expect.poll(() => (document.activeElement as HTMLElement | null)?.dataset.settingsFocusKey)
      .toBe("focus-settings-header");
    const latest = bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1);
    expect(JSON.stringify(latest)).not.toContain("focus-settings-header");
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("Settings request failures stay transient and never become chat transcript", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const rejected = deferred<Record<string, unknown>>();
  bridge.queueResponse("settings.dispatch", rejected.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView() });
    await userEvent.click(page.getByRole("tab", { name: "Konten" }));
    rejected.reject(new Error("PRIVATE ENGLISH ERROR"));
    await expect.poll(() => root.querySelector(".settings-request-error")?.textContent)
      .toBe("Änderung fehlgeschlagen · erneut versuchen");
    expect(root.textContent).not.toContain("PRIVATE ENGLISH ERROR");
    expect(root.querySelector(".msg-note")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();
    expect(root.querySelector(".msg-note")).toBeNull();
  } finally {
    mount.dispose();
  }
});

test("a rejected Settings close stays on Settings and never leaves a latent chat block", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const rejected = deferred<Record<string, unknown>>();
  bridge.queueResponse("settings.close", rejected.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: settingsMatrixView() });
    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    rejected.reject(new Error("PRIVATE CLOSE ERROR"));
    await expect.poll(() => root.querySelector(".settings-request-error")?.textContent)
      .toBe("Änderung fehlgeschlagen · erneut versuchen");
    expect(root.querySelector(".settings")).not.toBeNull();
    expect(root.querySelector(".msg-note")).toBeNull();
    expect(root.textContent).not.toContain("PRIVATE CLOSE ERROR");

    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();
    expect(root.querySelector(".msg-note")).toBeNull();
  } finally {
    mount.dispose();
  }
});

test("760×520 wraps long canonical Settings values and readonly text without horizontal overflow", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const mount = mountDesktopWindow({ bridge, root });
  const longPath = `Pfad: /Applications/${"SehrLangerOrdner/".repeat(12)}Browser.app`;
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    const base = settingsMatrixView({ selectedCategoryId: "more" });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: {
        ...base,
        categories: base.categories.map((category) => category.id === "more" ? {
          ...category,
          commonItems: [
            settingsRow("opaque-settings-path", "Browserpfad", { displayValue: longPath }),
            settingsRow("opaque-settings-cost", "Aktuelle Kosten", { control: "readonly", displayValue: longPath }),
          ],
        } : category),
      },
    });
    await expect.element(page.getByText("Browserpfad", { exact: true })).toBeVisible();
    for (const value of root.querySelectorAll<HTMLElement>(".settings-row .value")) {
      expect(getComputedStyle(value).whiteSpace).not.toBe("nowrap");
      expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
      expect(value.textContent).toContain(longPath);
    }
    const readonly = root.querySelector<HTMLElement>(".settings-readonly")!;
    expect(readonly.tagName).toBe("DIV");
    expect(readonly.hasAttribute("tabindex")).toBe(false);
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("all five canonical Settings editors submit, cancel, go back and restore the Settings row", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true }));
  const mount = mountDesktopWindow({ bridge, root });
  const emitEditor = (askId: string, editor: Record<string, unknown>) => bridge.emit({
    t: "ask", v: PROTOCOL_VERSION, askId, kind: "settings-editor", editor,
  } as ServerFrame);
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ selectedCategoryId: "security" }),
    });
    const trigger = page.getByRole("button", { name: /Freigabemodus/ });
    await expect.element(trigger).toBeVisible();
    const triggerNode = trigger.element() as HTMLButtonElement;

    const editors: readonly {
      readonly key: string;
      readonly title: string;
      readonly editor: Record<string, unknown>;
      readonly decision: Record<string, unknown>;
      readonly submit: () => Promise<void>;
    }[] = [
      {
        key: "choice",
        title: "Freigabemodus",
        editor: {
          kind: "choice", title: "Freigabemodus", description: "Aktionen sicher bestätigen",
          options: [{ handle: "approval-ask", label: "Nachfragen", selected: true }, { handle: "approval-auto", label: "Automatisch bearbeiten", selected: false }],
          cancelLabel: "Abbrechen", busyLabel: "Änderung wird angewendet …",
        },
        decision: { kind: "choice", optionHandle: "approval-auto" },
        submit: async () => userEvent.click(page.getByRole("button", { name: /Automatisch bearbeiten/ })),
      },
      {
        key: "number",
        title: "Aktionen pro Lauf",
        editor: {
          kind: "number", title: "Aktionen pro Lauf", description: "Maximale Anzahl der Modellaktionen",
          inputLabel: "Anzahl", initialValue: "7", constraintLabel: "1 bis 100",
          submitLabel: "Speichern", cancelLabel: "Abbrechen", busyLabel: "Änderung wird angewendet …",
        },
        decision: { kind: "number", value: "12" },
        submit: async () => {
          const field = page.getByRole("textbox", { name: "Anzahl" });
          await userEvent.fill(field, "12");
          await userEvent.keyboard("{Enter}");
        },
      },
      {
        key: "text",
        title: "Prüfhinweise",
        editor: {
          kind: "text", title: "Prüfhinweise", description: "Eigene Hinweise für die Prüfung",
          inputLabel: "Hinweise", initialValue: "", multiline: true,
          submitLabel: "Speichern", cancelLabel: "Abbrechen", busyLabel: "Änderung wird angewendet …",
        },
        decision: { kind: "text", value: "Build und Tests prüfen" },
        submit: async () => {
          await userEvent.fill(page.getByRole("textbox", { name: "Hinweise" }), "Build und Tests prüfen");
          await userEvent.click(page.getByRole("button", { name: "Speichern" }));
        },
      },
      {
        key: "confirm",
        title: "Alle Regeln vergessen",
        editor: {
          kind: "confirm", title: "Alle Regeln vergessen", description: "Gemerkte Freigaben dauerhaft entfernen",
          destructive: true, confirmLabel: "Alle Regeln löschen", cancelLabel: "Abbrechen",
          busyLabel: "Änderung wird angewendet …",
        },
        decision: { kind: "confirm", accepted: true },
        submit: async () => userEvent.click(page.getByRole("button", { name: "Alle Regeln löschen" })),
      },
      {
        key: "invoke",
        title: "Prüf-Befehle vorschlagen",
        editor: {
          kind: "invoke", title: "Prüf-Befehle vorschlagen", description: "Passende Projektbefehle ermitteln",
          invokeLabel: "Vorschlagen", cancelLabel: "Abbrechen", busyLabel: "Änderung wird angewendet …",
        },
        decision: { kind: "invoke" },
        submit: async () => userEvent.click(page.getByRole("button", { name: "Vorschlagen" })),
      },
    ];

    const expectRestoredFocus = async (): Promise<void> => {
      await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
      await expect.poll(() => document.activeElement).toBe(triggerNode);
    };

    for (const item of editors) {
      triggerNode.focus();
      emitEditor(`${item.key}-submit`, item.editor);
      await expect.element(page.getByRole("dialog", { name: item.title })).toBeVisible();
      expect(document.querySelector(".picker")).toBeNull();
      await item.submit();
      await expect.poll(() => bridge.writes.at(-1)).toEqual({
        t: "answer", askId: `${item.key}-submit`, decision: item.decision,
      });
      await expectRestoredFocus();

      triggerNode.focus();
      emitEditor(`${item.key}-cancel`, item.editor);
      await expect.element(page.getByRole("dialog", { name: item.title })).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Abbrechen" }));
      await expect.poll(() => bridge.writes.at(-1)).toEqual({
        t: "answer", askId: `${item.key}-cancel`, decision: { kind: "cancel" },
      });
      await expectRestoredFocus();

      triggerNode.focus();
      emitEditor(`${item.key}-back`, item.editor);
      await expect.element(page.getByRole("dialog", { name: item.title })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => bridge.writes.at(-1)).toEqual({
        t: "answer", askId: `${item.key}-back`, decision: { kind: "cancel" },
      });
      await expectRestoredFocus();
    }

    const closesBeforeBack = requestCount(bridge, "settings.close");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => requestCount(bridge, "settings.close")).toBe(closesBeforeBack + 1);
    expect(root.textContent).not.toMatch(/allow-all|actionId|categoryId|itemId|validationMessage|Ready|Applying/i);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

function progressiveSettingsView(
  selectedCategoryId: DesktopSettingsCategoryId,
): DesktopSettingsView {
  return {
    revision: 4,
    selectedCategoryId,
    search: { active: false, query: "", results: [] },
    notice: null,
    categories: [
      {
        id: "model",
        label: "Modell",
        description: "Modell und Denken verwalten",
        expanded: false,
        commonItems: [settingsRow("opaque-settings-model", "Hauptmodell")],
        advancedItems: [],
      },
      {
        id: "accounts",
        label: "Konten",
        description: "Provider und Konten verwalten",
        expanded: false,
        commonItems: [settingsRow("opaque-settings-provider", "Anbieter einrichten", {
          control: "action",
          actionLabel: "Einrichten",
        })],
        advancedItems: [],
      },
      {
        id: "security",
        label: "Sicherheit",
        description: "Freigaben verwalten",
        expanded: false,
        commonItems: [],
        advancedItems: [],
      },
      {
        id: "more",
        label: "Mehr",
        description: "Werkzeuge und Darstellung verwalten",
        expanded: false,
        commonItems: [],
        advancedItems: [],
      },
    ],
  };
}

function settingsMatrixView(options: {
  readonly revision?: number;
  readonly selectedCategoryId?: DesktopSettingsCategoryId;
  readonly modelExpanded?: boolean;
  readonly searchQuery?: string;
  readonly notice?: DesktopSettingsView["notice"];
  readonly showLargeLogo?: boolean;
  readonly showHeaderMark?: boolean;
} = {}): DesktopSettingsView {
  const rare = settingsRow("opaque-settings-rare", "Seltene Einstellung", {
    description: "Nur bei ausdrücklichem Bedarf",
    displayValue: "Aus",
  });
  const categories: DesktopSettingsView["categories"] = [
    {
      id: "model", label: "Modell", description: "Modelle und Denkmodus verwalten",
      expanded: options.modelExpanded === true,
      commonItems: [
        settingsRow("opaque-settings-model", "Hauptmodell", { displayValue: "Aktives Modell" }),
        settingsRow("opaque-settings-reasoning", "Denkmodus", { displayValue: "Automatisch" }),
        settingsRow("opaque-settings-steps", "Aktionen pro Lauf", { displayValue: "42" }),
      ],
      advancedItems: [rare],
    },
    {
      id: "accounts", label: "Konten", description: "Anbieter und Konten verwalten", expanded: false,
      commonItems: [settingsRow("opaque-settings-provider", "Anbieter einrichten", {
        control: "locked",
        disabled: {
          code: "provider-degraded",
          label: "Anbieter ist eingeschränkt",
          recoveryLabel: "Verbindung zuerst reparieren",
        },
      })],
      advancedItems: [],
    },
    {
      id: "security", label: "Sicherheit", description: "Freigaben verwalten", expanded: false,
      commonItems: [settingsRow("opaque-settings-approval", "Freigabemodus", { displayValue: "Nachfragen" })],
      advancedItems: [],
    },
    {
      id: "more", label: "Mehr", description: "Werkzeuge und Darstellung verwalten", expanded: false,
      commonItems: [
        settingsRow("opaque-settings-logo", "Großes ORCODE-Logo", {
          control: "boolean", booleanValue: options.showLargeLogo ?? true, displayValue: "beliebiger Text",
        }),
        settingsRow("opaque-settings-header", "Kompakte Kopfmarke", {
          control: "boolean", booleanValue: options.showHeaderMark ?? true, displayValue: "noch mehr Text",
        }),
      ],
      advancedItems: [],
    },
  ];
  const searchQuery = options.searchQuery ?? "";
  return {
    revision: options.revision ?? 40,
    selectedCategoryId: options.selectedCategoryId ?? "model",
    categories,
    search: {
      active: searchQuery.length > 0,
      query: searchQuery,
      results: searchQuery.length > 0 ? [rare] : [],
    },
    notice: options.notice ?? null,
  };
}

const READY_STATUS: GuiStatus = {
  model: "",
  resolvedModel: "",
  workspace: "/tmp/orcode-browser-mode",
  chatId: "chat-browser",
  chatTitle: "Neuer Chat",
  approval: "ask",
  routeConnected: false,
  providerManaged: false,
  balanceRemainingUsd: undefined,
  balanceHedged: true,
  lowBalanceThresholdUsd: 1,
  dayUsd: undefined,
  sessionUsd: 0,
  sessionCostKnowledge: "unknown",
  runActive: false,
  executionMode: "desktop",
  ownerPathsAllowed: false,
};

class FakeDesktopBridge implements DesktopWindowBridge {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly writes: Array<Record<string, unknown>> = [];
  readonly #snapshot: DesktopCapabilitySnapshot;
  readonly #status: GuiStatus;
  readonly #chats: readonly ChatRow[];
  readonly #catalogRows: readonly import("../src/protocol.js").GuiPaletteRow[];
  readonly #queuedResponses = new Map<string, Promise<unknown>[]>();
  #handlers: BridgeHandlers | null = null;

  constructor(
    snapshot: DesktopCapabilitySnapshot,
    status: GuiStatus = READY_STATUS,
    chats: readonly ChatRow[] = [],
    catalogRows: readonly import("../src/protocol.js").GuiPaletteRow[] = [],
  ) {
    this.#snapshot = snapshot;
    this.#status = status;
    this.#chats = chats;
    this.#catalogRows = catalogRows;
  }

  queueResponse<T>(type: string, response: Promise<T>): void {
    const queued = this.#queuedResponses.get(type) ?? [];
    queued.push(response as Promise<unknown>);
    this.#queuedResponses.set(type, queued);
  }

  emit(frame: ServerFrame): void {
    this.#handlers?.onFrame(frame);
  }

  exit(): void {
    this.#handlers?.onExit(1, null, "engine-crashed");
  }

  async start(handlers: BridgeHandlers): Promise<EngineInfo> {
    this.#handlers = handlers;
    queueMicrotask(() => handlers.onFrame({
      t: "hello",
      v: PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION,
      orcode: "0.7.0",
      node: "browser-fake",
      pid: 1,
      capabilities: [],
    }));
    return {
      node: "browser-fake",
      script: "fake-gui-server.js",
      workspace: this.#status.workspace,
      home: "/tmp/orcode-browser-mode/home",
      realHome: false,
      pid: 1,
    };
  }

  async request<T = unknown>(
    t: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    this.requests.push({ t, ...payload });
    const queued = this.#queuedResponses.get(t);
    if (queued && queued.length > 0) return await queued.shift() as T;
    if (t === "status.get") return this.#status as T;
    if (t === "chats.list") return { chats: this.#chats } as T;
    if (t === "desktop.snapshot.get") {
      this.#handlers?.onFrame({
        t: "event",
        v: PROTOCOL_VERSION,
        e: "desktop.snapshot",
        snapshot: this.#snapshot,
      });
      return { snapshot: this.#snapshot } as T;
    }
    if (t === "catalog.search") return { query: payload.query, crumb: ["Commands"], rows: this.#catalogRows, total: this.#catalogRows.length } as T;
    if (t === "chat.new") return await new Promise<T>(() => {});
    return {} as T;
  }

  async write(frame: Record<string, unknown>): Promise<void> {
    this.writes.push(frame);
  }
}

const CO_ROWS = ["compress", "context", "cost", "cross"].map((name) => ({
  kind: "match" as const, command: `/${name}`, name: `/${name}`, usage: `/${name}`,
  description: "legacy English", verb: name === "cross" ? "insert" as const : "run" as const,
  presentation: { description: `Deutsch ${name}`, actionLabel: name === "cross" ? "Einfügen" as const : "Ausführen" as const },
}));

const PROVIDER_SETUP_ROW = {
  kind: "match" as const,
  command: "/provider setup",
  name: "Provider setup",
  usage: "/provider setup",
  description: "legacy description must not become a second GUI catalog",
  verb: "run" as const,
  presentation: {
    description: "Provider und Konto einrichten",
    actionLabel: "Ausführen" as const,
  },
};

const SETTINGS_ROW = {
  kind: "match" as const,
  command: "/settings",
  name: "/settings",
  usage: "/settings",
  description: "legacy description must not become GUI copy",
  verb: "run" as const,
  presentation: {
    description: "Einstellungen öffnen",
    actionLabel: "Ausführen" as const,
  },
};

function catalogLevel(rows = CO_ROWS) {
  return { query: "co", crumb: ["Commands"], rows, total: rows.length };
}

test.each(["button", "typed"] as const)(
  "Settings opens from the visible %s entry through one canonical Settings view",
  async (entry) => {
    await page.viewport(760, 520);
    document.body.replaceChildren();
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    const bridge = new FakeDesktopBridge(
      capabilitySnapshot({ routeRunnable: true }),
      READY_STATUS,
      [],
      [SETTINGS_ROW],
    );
    const mount = mountDesktopWindow({ bridge, root });
    try {
      await expect.element(page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
      if (entry === "button") {
        await userEvent.click(page.getByRole("button", { name: "Einstellungen" }));
        await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.open")).toEqual([
          { t: "settings.open" },
        ]);
        expect(requestCount(bridge, "command")).toBe(0);
      } else {
        const composer = page.getByRole("textbox", { name: "Nachricht" });
        await userEvent.type(composer, "/settings");
        await expect.poll(() => [...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
          .toEqual(["/settings"]);
        await userEvent.keyboard("{Enter}");
        await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([{
          t: "command", raw: "/settings", draft: "",
        }]);
        expect(requestCount(bridge, "settings.open")).toBe(0);
      }

      bridge.emit({
        t: "event", v: PROTOCOL_VERSION, e: "settings.view",
        view: settingsMatrixView(),
      });
      await expect.element(page.getByRole("searchbox", { name: "Einstellungen durchsuchen" })).toBeVisible();
      expect([...root.querySelectorAll("[role='tab']")].map((node) => node.textContent))
        .toEqual(["Modell", "Konten", "Sicherheit", "Mehr"]);
      expect(document.querySelector(".picker")).toBeNull();
      expect(root.querySelectorAll("[data-block]")).toHaveLength(0);
      expect(bridge.writes).toHaveLength(0);

      await userEvent.click(page.getByRole("button", { name: "Fertig" }));
      await expect.poll(() => requestCount(bridge, "settings.close")).toBe(1);
      bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
      await expect.poll(() => root.querySelector(".settings")).toBeNull();
    } finally {
      mount.dispose();
      await page.viewport(1280, 720);
    }
  },
);

test("typed /settings reopens after a completed button visit and retires its command window", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(
    capabilitySnapshot({ routeRunnable: true }),
    READY_STATUS,
    [],
    [SETTINGS_ROW],
  );
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await userEvent.click(page.getByRole("button", { name: "Einstellungen" }));
    await expect.poll(() => requestCount(bridge, "settings.open")).toBe(1);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 40 }),
    });
    await expect.element(page.getByRole("searchbox", { name: "Einstellungen durchsuchen" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    await expect.poll(() => requestCount(bridge, "settings.close")).toBe(1);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();

    const command = deferred<{ outcome: string }>();
    bridge.queueResponse("command", command.promise);
    const composer = page.getByRole("textbox", { name: "Nachricht" });
    await userEvent.type(composer, "/settings");
    await expect.poll(() => [...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
      .toEqual(["/settings"]);
    await userEvent.click(page.getByRole("button", { name: "Senden" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([{
      t: "command", raw: "/settings", draft: "",
    }]);
    await expect.element(composer).toHaveValue("");
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(0);
    expect(root.textContent).not.toContain("/settings Einstellungen öffnen");

    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41 }),
    });
    await expect.element(page.getByRole("searchbox", { name: "Einstellungen durchsuchen" })).toBeVisible();
    expect(requestCount(bridge, "settings.open")).toBe(1);
    expect(root.querySelectorAll("[data-block]")).toHaveLength(0);

    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    await expect.poll(() => requestCount(bridge, "settings.close")).toBe(2);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    command.resolve({ outcome: "continue" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();

    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 42, searchQuery: "retired command replay" }),
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(root.querySelector(".settings")).toBeNull();
    expect(root.textContent).not.toContain("retired command replay");
    expect(root.querySelectorAll("[data-block]")).toHaveLength(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("real Composer completion activates the selected /co result with Enter", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const mount = mountDesktopWindow({ bridge, root });
  await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Nachricht" });
  await userEvent.type(composer, "/co");
  await expect.poll(() => [...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(requestCount(bridge, "command")).toBe(0);
  await expect.element(composer).toHaveValue("/cross ");
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.value = "/co";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([{
    t: "command", raw: "/cost", draft: "",
  }]);
  await expect.element(composer).toHaveValue("");
  field.value = "/cost";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBeGreaterThan(1);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => requestCount(bridge, "command")).toBe(2);
  await expect.element(composer).toHaveValue("");
  const refused = deferred<never>();
  bridge.queueResponse("command", refused.promise);
  field.value = "/cost";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBeGreaterThan(3);
  await userEvent.keyboard("{Enter}");
  refused.reject(new Error("refused"));
  await expect.poll(() => requestCount(bridge, "command")).toBe(3);
  await expect.element(composer).toHaveValue("/cost");
  mount.dispose();
});

test("Composer Enter never activates a disabled selected completion", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const disabledRows = CO_ROWS.map((row, index) => index === 2
    ? {
        ...row,
        presentation: {
          ...row.presentation,
          disabled: {
            code: "run-active" as const,
            label: "Ein Lauf ist aktiv.",
            recoveryLabel: "Lauf zuerst beenden",
          },
        },
      }
    : row);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], disabledRows);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const composer = page.getByRole("textbox", { name: "Nachricht" });
    await expect.element(composer).toBeVisible();
    await userEvent.type(composer, "/co");
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(requestCount(bridge, "command")).toBe(0);
    await expect.element(composer).toHaveValue("/co");
  } finally {
    mount.dispose();
  }
});

test("a stale visible completion cannot overwrite a newer Composer draft", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const composer = page.getByRole("textbox", { name: "Nachricht" });
    await expect.element(composer).toBeVisible();
    await userEvent.type(composer, "/co");
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    const staleCross = root.querySelectorAll<HTMLButtonElement>('[role="option"]')[3]!;
    const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = "/new";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    staleCross.click();
    await expect.element(composer).toHaveValue("/new");
    expect(requestCount(bridge, "command")).toBe(0);

    field.value = "/co";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    staleCross.click();
    await expect.element(composer).toHaveValue("/co");
    expect(requestCount(bridge, "command")).toBe(0);
  } finally {
    mount.dispose();
  }
});

test("a delayed command refusal never overwrites a newer Composer draft", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const command = deferred<never>();
  bridge.queueResponse("command", command.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
    const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = "/cost";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    field.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => requestCount(bridge, "command")).toBe(1);
    await expect.element(field).toHaveValue("");

    await userEvent.type(field, "Diesen Entwurf behalten");
    command.reject(new Error("refused"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(field.value).toBe("Diesen Entwurf behalten");
  } finally {
    mount.dispose();
  }
});

test("a refused slash command restores its draft through a fresh completion request", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const staleSearch = deferred<ReturnType<typeof catalogLevel>>();
  const freshSearch = deferred<ReturnType<typeof catalogLevel>>();
  const command = deferred<never>();
  bridge.queueResponse("catalog.search", staleSearch.promise);
  bridge.queueResponse("catalog.search", freshSearch.promise);
  bridge.queueResponse("command", command.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
    const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = "/cost";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(1);

    root.querySelector<HTMLButtonElement>(".send")!.click();
    await expect.poll(() => requestCount(bridge, "command")).toBe(1);
    await expect.element(field).toHaveValue("");
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(0);

    command.reject(new Error("refused"));
    await expect.element(field).toHaveValue("/cost");
    await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(2);

    const stale = [{ ...CO_ROWS[0]!, command: "/stale", name: "/stale", usage: "/stale" }];
    staleSearch.resolve(catalogLevel(stale));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(root.textContent).not.toContain("/stale");

    freshSearch.resolve(catalogLevel());
    await expect.poll(() => [...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
      .toEqual(["/compress", "/context", "/cost", "/cross"]);
  } finally {
    mount.dispose();
  }
});

test("a delayed command success never clears a newer Composer draft", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const command = deferred<{ outcome: string }>();
  bridge.queueResponse("command", command.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
    const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = "/cost";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    field.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => requestCount(bridge, "command")).toBe(1);
    await expect.element(field).toHaveValue("");

    await userEvent.type(field, "Diesen Entwurf behalten");
    command.resolve({ outcome: "continue" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(field.value).toBe("Diesen Entwurf behalten");
  } finally {
    mount.dispose();
  }
});

test("only the newest unchanged submit clear may restore its text", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const first = deferred<never>();
  const second = deferred<never>();
  bridge.queueResponse("command", first.promise);
  bridge.queueResponse("submit", second.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
    const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = "/cost";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
    field.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => requestCount(bridge, "command")).toBe(1);

    field.value = "Neuer Entwurf";
    root.querySelector<HTMLButtonElement>(".send")!.click();
    await expect.poll(() => requestCount(bridge, "submit")).toBe(1);
    expect(field.value).toBe("");

    first.reject(new Error("first refused"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(field.value).toBe("");
    second.reject(new Error("second refused"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(field.value).toBe("Neuer Entwurf");
  } finally {
    mount.dispose();
  }
});

test("Composer waits for the current slash generation and rejects same-raw ABA", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const old = deferred<ReturnType<typeof catalogLevel>>();
  const current = deferred<ReturnType<typeof catalogLevel>>();
  bridge.queueResponse("catalog.search", old.promise);
  bridge.queueResponse("catalog.search", current.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
  await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.focus();

  field.value = "/co";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(1);
  field.value = "Zwischentext";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.value = "/co";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(2);

  await userEvent.keyboard("{Enter}");
  expect(requestCount(bridge, "command")).toBe(0);
  current.resolve(catalogLevel());
  await expect.poll(() => [...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);

  const stale = [{ ...CO_ROWS[0]!, command: "/stale", name: "/stale", usage: "/stale" }];
  old.resolve(catalogLevel(stale));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect([...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);
  expect(requestCount(bridge, "command")).toBe(0);
  } finally {
    mount.dispose();
  }
});

test("a stale slash rejection cannot replace the current selected result", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const old = deferred<ReturnType<typeof catalogLevel>>();
  const current = deferred<ReturnType<typeof catalogLevel>>();
  bridge.queueResponse("catalog.search", old.promise);
  bridge.queueResponse("catalog.search", current.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
  await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.focus();

  field.value = "/c";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(1);
  field.value = "Zwischentext";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.value = "/co";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(2);
  current.resolve(catalogLevel());
  await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(4);
  old.reject(new Error("stale search refused"));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  expect([...root.querySelectorAll('[role="option"] .usage')].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(requestCount(bridge, "command")).toBe(0);
  await expect.element(field).toHaveValue("/cross ");
  } finally {
    mount.dispose();
  }
});

test("the real palette ignores deferred stale answers and accepts co with or without slash", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], CO_ROWS);
  const old = deferred<ReturnType<typeof catalogLevel>>();
  const current = deferred<ReturnType<typeof catalogLevel>>();
  bridge.queueResponse("catalog.search", old.promise);
  bridge.queueResponse("catalog.search", current.promise);
  const mount = mountDesktopWindow({ bridge, root });
  try {
  await expect.element(page.getByRole("button", { name: "Neuer Chat" })).toBeVisible();
  pressCommandPaletteShortcut();
  await expect.element(page.getByRole("textbox", { name: "Befehl suchen" })).toBeVisible();
  const search = root.parentElement!.querySelector<HTMLInputElement>(".palette .filter")!;

  search.value = "co";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(1);
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.value = "/co";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(bridge, "catalog.search")).toBe(2);
  current.resolve(catalogLevel());
  await expect.poll(() => [...document.querySelectorAll(".palette .prow .n")].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);

  const stale = [{ ...CO_ROWS[0]!, command: "/stale", name: "/stale", usage: "/stale" }];
  old.resolve(catalogLevel(stale));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect([...document.querySelectorAll(".palette .prow .n")].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);

  search.value = "co";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => [...document.querySelectorAll(".palette .prow .n")].map((node) => node.textContent))
    .toEqual(["/compress", "/context", "/cost", "/cross"]);
  } finally {
    mount.dispose();
  }
});

test("disabled Composer and palette rows are inert for mouse, Enter, and Tab", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const disabledCost = {
    ...CO_ROWS[2]!,
    presentation: {
      ...CO_ROWS[2]!.presentation,
      disabled: { code: "run-active" as const, label: "Ein Lauf ist aktiv.", recoveryLabel: "Lauf zuerst beenden" },
    },
  };
  const bridge = new FakeDesktopBridge(capabilitySnapshot(), READY_STATUS, [], [disabledCost]);
  const mount = mountDesktopWindow({ bridge, root });
  try {
  await expect.element(page.getByRole("textbox", { name: "Nachricht" })).toBeVisible();
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.value = "/co";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => root.querySelectorAll('[role="option"]').length).toBe(1);
  const completion = root.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(completion.disabled).toBe(true);
  expect(completion.getAttribute("aria-disabled")).toBe("true");
  completion.click();
  field.focus();
  await userEvent.keyboard("{Enter}{Tab}");
  expect(field.value).toBe("/co");
  expect(requestCount(bridge, "command")).toBe(0);

  pressCommandPaletteShortcut();
  await expect.element(page.getByRole("textbox", { name: "Befehl suchen" })).toBeVisible();
  const search = document.querySelector<HTMLInputElement>(".palette .filter")!;
  search.value = "cost";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => document.querySelectorAll(".palette .prow").length).toBe(1);
  const paletteRow = document.querySelector<HTMLButtonElement>(".palette .prow")!;
  expect(paletteRow.disabled).toBe(true);
  expect(paletteRow.getAttribute("aria-disabled")).toBe("true");
  paletteRow.click();
  search.focus();
  await userEvent.keyboard("{Enter}{Tab}");
  expect(requestCount(bridge, "command")).toBe(0);
  } finally {
    mount.dispose();
  }
});

function pressCommandPaletteShortcut(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "p",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function requestCount(bridge: FakeDesktopBridge, type: string): number {
  return bridge.requests.filter(({ t }) => t === type).length;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

test("supports two complete mount lifecycles without retained state or listeners", async () => {
  document.body.replaceChildren();
  const firstRoot = document.createElement("div");
  firstRoot.id = "first-app";
  document.body.append(firstRoot);
  const firstBridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: false }));

  const firstMount = mountDesktopWindow({ bridge: firstBridge, root: firstRoot });

  await expect.element(page.getByRole("button", { name: "Neuer Chat" })).toBeVisible();
  await expect.poll(() => requestCount(firstBridge, "desktop.snapshot.get")).toBe(1);
  const firstComposer = firstRoot.querySelector<HTMLTextAreaElement>("textarea");
  if (!firstComposer) throw new Error("The first mount did not render its composer.");
  expect(pressCommandPaletteShortcut().defaultPrevented).toBe(true);
  await expect.poll(() => requestCount(firstBridge, "catalog.level")).toBe(1);

  firstMount.dispose();

  expect(firstRoot.childElementCount).toBe(0);
  expect(document.body.children).toHaveLength(1);
  const firstRequestCount = firstBridge.requests.length;
  expect(pressCommandPaletteShortcut().defaultPrevented).toBe(false);
  await Promise.resolve();
  expect(firstBridge.requests).toHaveLength(firstRequestCount);

  const secondRoot = document.createElement("div");
  secondRoot.id = "second-app";
  document.body.replaceChildren(secondRoot);
  const secondBridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: false }));

  const secondMount = mountDesktopWindow({ bridge: secondBridge, root: secondRoot });

  const newChat = page.getByRole("button", { name: "Neuer Chat" });
  await expect.element(newChat).toBeVisible();
  await expect.poll(() => requestCount(secondBridge, "desktop.snapshot.get")).toBe(1);

  firstComposer.value = "stale draft";
  firstComposer.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  expect(requestCount(secondBridge, "cost.forecast")).toBe(0);

  const secondComposer = secondRoot.querySelector<HTMLTextAreaElement>("textarea");
  if (!secondComposer) throw new Error("The second mount did not render its composer.");
  secondComposer.value = "fresh draft";
  secondComposer.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(secondBridge, "cost.forecast")).toBe(1);

  expect(pressCommandPaletteShortcut().defaultPrevented).toBe(true);
  await expect.poll(() => requestCount(secondBridge, "catalog.level")).toBe(1);
  expect(pressCommandPaletteShortcut().defaultPrevented).toBe(true);
  await userEvent.click(newChat);
  await expect.poll(() => secondBridge.requests.at(-1)).toEqual({ t: "chat.new" });

  secondMount.dispose();

  expect(secondRoot.childElementCount).toBe(0);
});

test("ignores every first-mount request continuation after dispose and remount", async () => {
  document.body.replaceChildren();
  const firstRoot = document.createElement("div");
  document.body.append(firstRoot);
  const firstStatus: GuiStatus = { ...READY_STATUS, chatTitle: "First mount" };
  const firstBridge = new FakeDesktopBridge(capabilitySnapshot(), firstStatus);
  const firstMount = mountDesktopWindow({ bridge: firstBridge, root: firstRoot });

  await expect.poll(() => requestCount(firstBridge, "chats.list")).toBe(1);
  const staleStatus = deferred<GuiStatus>();
  const staleChats = deferred<{ chats: ChatRow[] }>();
  const staleForecast = deferred<CostForecast>();
  const staleHelloAck = deferred<Record<string, never>>();

  firstBridge.queueResponse("status.get", staleStatus.promise);
  firstBridge.emit({
    t: "event",
    v: PROTOCOL_VERSION,
    e: "run",
    event: { type: "run-end" },
  });
  await expect.poll(() => requestCount(firstBridge, "status.get")).toBe(2);

  firstBridge.queueResponse("chats.list", staleChats.promise);
  firstBridge.emit({
    t: "event",
    v: PROTOCOL_VERSION,
    e: "chat.reset",
    chatId: "first-chat",
    rerooted: false,
  });
  await expect.poll(() => requestCount(firstBridge, "chats.list")).toBe(2);

  firstBridge.queueResponse("cost.forecast", staleForecast.promise);
  const firstComposer = firstRoot.querySelector<HTMLTextAreaElement>("textarea");
  if (!firstComposer) throw new Error("The first mount did not render its composer.");
  firstComposer.value = "first draft";
  firstComposer.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => requestCount(firstBridge, "cost.forecast")).toBe(1);

  firstBridge.queueResponse("hello-ack", staleHelloAck.promise);
  firstBridge.exit();
  firstBridge.emit({
    t: "hello",
    v: PROTOCOL_VERSION,
    protocol: PROTOCOL_VERSION,
    orcode: "0.7.0",
    node: "browser-fake",
    pid: 1,
    capabilities: [],
  });
  await expect.poll(() => requestCount(firstBridge, "hello-ack")).toBe(2);

  firstMount.dispose();
  const secondRoot = document.createElement("div");
  document.body.replaceChildren(secondRoot);
  const secondStatus: GuiStatus = { ...READY_STATUS, chatId: "second-chat", chatTitle: "Second mount" };
  const secondBridge = new FakeDesktopBridge(capabilitySnapshot(), secondStatus);
  const secondMount = mountDesktopWindow({ bridge: secondBridge, root: secondRoot });

  await expect.poll(() => requestCount(secondBridge, "chats.list")).toBe(1);
  await expect.element(page.getByText("Second mount", { exact: true })).toBeVisible();
  const secondRequestCount = secondBridge.requests.length;

  staleHelloAck.resolve({});
  staleStatus.resolve({ ...firstStatus, chatTitle: "STALE STATUS" });
  staleChats.resolve({
    chats: [{
      id: "stale-chat",
      title: "STALE CHAT",
      workspace: READY_STATUS.workspace,
      turnCount: 1,
      costUsd: 0,
      model: "stale/model",
      updatedAt: new Date(0).toISOString(),
    }],
  });
  staleForecast.resolve({ kind: "band", text: "STALE FORECAST", minUsd: 1, maxUsd: 2 });
  await new Promise((resolve) => window.setTimeout(resolve, 100));

  expect(secondBridge.requests).toHaveLength(secondRequestCount);
  expect(secondRoot.textContent).toContain("Second mount");
  expect(secondRoot.textContent).not.toContain("STALE STATUS");
  expect(secondRoot.textContent).not.toContain("STALE CHAT");
  expect(secondRoot.textContent).not.toContain("STALE FORECAST");

  secondMount.dispose();
});

test("mountDesktopWindow owns approval focus, safe Escape, live copy, and restoration", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot());
  const mount = mountDesktopWindow({ bridge, root });

  await expect.element(page.getByRole("button", { name: "Neuer Chat" })).toBeVisible();
  const trigger = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.includes("Neuer Chat"),
  );
  if (!trigger) throw new Error("The production window did not render its ask trigger.");
  trigger.focus();

  bridge.emit({
    t: "ask",
    v: PROTOCOL_VERSION,
    askId: "approval-browser",
    kind: "approval",
    preview: {
      name: "write_file",
      risk: "write",
      summary: "Datei schreiben",
      details: "src/a.ts",
    },
    danger: true,
    rememberAvailable: true,
    reasonAvailable: true,
  });

  const dialog = page.getByRole("dialog", { name: "Datei schreiben" });
  await expect.element(dialog).toBeVisible();
  await expect.element(page.getByRole("textbox", {
    name: "Grund für Ablehnung (optional)",
  })).toBeVisible();
  await expect.poll(() => root.inert).toBe(true);
  expect(root.getAttribute("aria-hidden")).toBe("true");
  await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Ablehnen");

  const mountedDialog = document.querySelector<HTMLElement>("[role='dialog']");
  if (!mountedDialog) throw new Error("The production ask did not mount a dialog.");
  const controls = [...mountedDialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter((node) => !node.hidden);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) throw new Error("The production ask has no focusable controls.");

  last.focus();
  const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.dispatchEvent(forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);

  first.focus();
  const backward = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(backward);
  expect(backward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);

  const alert = document.querySelector<HTMLElement>("[role='alert'][aria-live='assertive']");
  const status = document.querySelector<HTMLElement>("[role='status'][aria-live='polite']");
  expect(alert?.textContent).toContain("Datei schreiben");
  expect(status).not.toBeNull();

  const escape = (): void => document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  escape();
  escape();
  await expect.poll(() => bridge.writes.filter(
    ({ askId }) => askId === "approval-browser",
  )).toHaveLength(1);
  await expect.poll(() => bridge.writes.at(-1)).toEqual({
    t: "answer",
    askId: "approval-browser",
    accepted: false,
  });
  await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
  expect(root.inert).toBe(false);
  expect(root.hasAttribute("aria-hidden")).toBe(false);
  expect(document.activeElement).toBe(trigger);

  expect(pressCommandPaletteShortcut().defaultPrevented).toBe(true);
  await expect.element(page.getByRole("textbox", { name: "Befehl suchen" })).toBeVisible();

  mount.dispose();
});

test("writes one answer when the same rendered ask control fires twice", async () => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot());
  const mount = mountDesktopWindow({ bridge, root });

  await expect.element(page.getByRole("button", { name: "Neuer Chat" })).toBeVisible();
  bridge.emit({
    t: "ask",
    v: PROTOCOL_VERSION,
    askId: "approval-double-control",
    kind: "approval",
    preview: { name: "shell", risk: "execute", summary: "Befehl ausführen" },
    danger: true,
  });

  const deny = page.getByRole("button", { name: "Ablehnen" });
  await expect.element(deny).toBeVisible();
  const denyNode = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Ablehnen",
  );
  if (!denyNode) throw new Error("The production approval did not render its denial control.");
  denyNode.click();
  denyNode.click();

  await expect.poll(() => bridge.writes.filter(
    ({ askId }) => askId === "approval-double-control",
  )).toHaveLength(1);

  mount.dispose();
});

test("renders the canonical responsive shell and dispatches Verbinden once", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: false }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const connect = page.getByRole("button", { name: "Verbinden" });
    await expect.element(connect).toBeVisible();
    const side = root.querySelector<HTMLElement>(".side")!;
    const main = root.querySelector<HTMLElement>(".main")!;
    expect(side.getBoundingClientRect().width).toBeGreaterThanOrEqual(180);
    expect(side.getBoundingClientRect().width).toBeLessThanOrEqual(200);
    expect(main.getBoundingClientRect().width).toBeGreaterThanOrEqual(560);
    expect(document.documentElement.lang).toBe("de");

    for (const label of ["Verbinden", "Ordner", "Einstellungen"]) {
      const node = [...root.querySelectorAll<HTMLElement>(".footrow .n")]
        .find((candidate) => candidate.textContent?.trim() === label);
      expect(node, `${label} must be rendered as a complete fixed navigation label`).toBeDefined();
      expect(node!.scrollWidth, `${label} must not be ellipsized`).toBeLessThanOrEqual(node!.clientWidth);
    }
    const brands = root.querySelectorAll<HTMLImageElement>('img[data-brand="route-core"]');
    expect(brands).toHaveLength(1);
    await brands[0]!.decode();
    expect(brands[0]!.naturalWidth).toBeGreaterThan(0);
    expect(root.textContent).not.toContain("❯─●");
    expect(root.textContent).not.toContain("ORCODE");

    await userEvent.click(connect);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toEqual([{
      t: "onboarding.dispatch",
      intent: { kind: "open-model-picker", returnTo: "chat", revision: 7, generation: 3 },
    }]);

    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "transcript", role: "user", content: "Hallo",
    });
    await expect.poll(() => root.querySelector(".route-core-brand--chat-header")).not.toBeNull();
    expect(root.querySelectorAll('img[data-brand="route-core"]')).toHaveLength(1);
    expect(root.querySelector(".route-core-brand--empty")).toBeNull();
    const chatBrand = root.querySelector<HTMLImageElement>('img[data-brand="route-core"]')!;
    await chatBrand.decode();
    const chatHeader = root.querySelector<HTMLElement>(".chathead")!;
    expect(chatHeader.getBoundingClientRect().right - chatBrand.getBoundingClientRect().right)
      .toBeCloseTo(20, 0);
    expect(root.querySelector<HTMLElement>(".chathead .title")!.getBoundingClientRect().right)
      .toBeLessThanOrEqual(chatBrand.getBoundingClientRect().left);

    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "settings.view",
      view: progressiveSettingsView("model"),
    });
    await expect.poll(() => root.querySelector(".route-core-brand--settings-header")).not.toBeNull();
    expect(root.querySelectorAll('img[data-brand="route-core"]')).toHaveLength(1);
    expect(root.querySelector(".route-core-brand--chat-header")).toBeNull();
    const settingsBrand = root.querySelector<HTMLImageElement>('img[data-brand="route-core"]')!;
    await settingsBrand.decode();
    const settingsHeader = root.querySelector<HTMLElement>(".chathead")!;
    expect(settingsHeader.getBoundingClientRect().right - settingsBrand.getBoundingClientRect().right)
      .toBeCloseTo(20, 0);
    expect(root.querySelector<HTMLElement>(".chathead .title")!.getBoundingClientRect().right)
      .toBeLessThanOrEqual(settingsBrand.getBoundingClientRect().left);
    expect(root.querySelector<HTMLButtonElement>(".sethead-row .iconbtn")!.getBoundingClientRect().right)
      .toBeLessThanOrEqual(settingsBrand.getBoundingClientRect().left);

    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "desktop.snapshot",
      snapshot: capabilitySnapshot({
        routeRunnable: false,
        appearance: { showLargeLogo: true, showHeaderMark: false },
      }),
    });
    await expect.poll(() => root.querySelectorAll('img[data-brand="route-core"]').length).toBe(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test.each([
  {
    categoryId: "model" as const,
    rowName: "Hauptmodell",
    handle: "opaque-settings-model",
    keyboard: true,
    picker: onboardingStep({
      step: "model",
      returnTo: "settings",
      providers: [onboardingProvider({ routes: [onboardingRoute()] })],
      candidates: [onboardingRoute()],
    }),
  },
  {
    categoryId: "accounts" as const,
    rowName: "Anbieter einrichten",
    handle: "opaque-settings-provider",
    keyboard: false,
    picker: onboardingStep({
      step: "provider",
      returnTo: "settings",
      providers: [onboardingProvider({ routes: [onboardingRoute()] })],
    }),
  },
])("Settings $rowName reaches the canonical Task-5 picker without auto-selection", async ({
  categoryId,
  rowName,
  handle,
  keyboard,
  picker,
}) => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({
    routeRunnable: true,
    providers: [onboardingProvider({ routes: [onboardingRoute()] })],
  }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "settings.view",
      view: progressiveSettingsView(categoryId),
    });
    const rowControl = page.getByRole("button", { name: rowName });
    await expect.element(rowControl).toBeVisible();
    if (keyboard) {
      (rowControl.element() as HTMLButtonElement).focus();
      await userEvent.keyboard("{Enter}");
    } else {
      await userEvent.click(rowControl);
    }
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "activate-row", handle, revision: 4 },
    });

    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    bridge.emit(onboardingEvent(picker));
    await expect.poll(() => document.querySelector(".route-picker, .onboarding-view"))
      .not.toBeNull();
    expect(document.querySelector(".picker")).toBeNull();
    expect(document.querySelector("[role='option'][aria-selected='true']")).toBeNull();
    expect(bridge.writes).toHaveLength(0);
    const confirm = document.querySelector<HTMLButtonElement>(".route-picker .primary");
    if (confirm) expect(confirm.disabled).toBe(true);
    const transcriptBefore = root.querySelectorAll(".message, .turn").length;
    bridge.queueResponse("onboarding.dispatch", Promise.resolve({ kind: "cancelled", view: picker }));
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1))
      .toEqual({
        t: "onboarding.dispatch",
        intent: {
          kind: "cancel",
          revision: picker.revision,
          generation: picker.generation,
          operationHandle: picker.operationHandle,
        },
      });
    const restored = progressiveSettingsView(categoryId);
    const restoredRow = restored.categories
      .flatMap((category) => category.commonItems)
      .find((row) => row.label === rowName)!;
    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "settings.view",
      view: { ...restored, initialFocusKey: restoredRow.focusKey },
    });
    await expect.element(page.getByRole("button", { name: rowName })).toBeVisible();
    await expect.poll(() => document.querySelector(".route-picker, .onboarding-view")).toBeNull();
    await expect.poll(() => (document.activeElement as HTMLElement | null)?.dataset.settingsFocusKey)
      .toBe(restoredRow.focusKey);
    expect(root.querySelectorAll(".message, .turn")).toHaveLength(transcriptBefore);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("a direct provider account deep link cancels back to its exact Settings row", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const route = onboardingRoute({ providerId: "openrouter", connectionId: "openrouter-owner" });
  const provider = onboardingProvider({
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    connectionId: "openrouter-owner",
    accountLabel: "Persönliches OpenRouter",
    routes: [route],
  });
  const bridge = new FakeDesktopBridge(capabilitySnapshot({
    routeRunnable: true,
    providers: [provider],
  }));
  const mount = mountDesktopWindow({ bridge, root });
  const directRow = settingsRow(
    "opaque-settings-openrouter-reconnect",
    "OpenRouter · Neu verbinden",
    { control: "action", actionLabel: "Neu verbinden" },
  );
  const settingsView = progressiveSettingsView("accounts");
  const withDirectRow: DesktopSettingsView = {
    ...settingsView,
    categories: settingsView.categories.map((category) => category.id === "accounts"
      ? { ...category, commonItems: [directRow] }
      : category),
  };
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: withDirectRow });
    await userEvent.click(page.getByRole("button", { name: "OpenRouter · Neu verbinden" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "activate-row", handle: directRow.handle, revision: withDirectRow.revision },
    });

    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    const account = onboardingStep({
      step: "account",
      returnTo: "settings",
      providerId: provider.providerId,
      providers: [provider],
    });
    bridge.emit(onboardingEvent(account));
    await expect.element(page.getByRole("dialog", { name: "Konto wählen" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /Persönliches OpenRouter/ })).toBeVisible();
    expect(bridge.writes).toHaveLength(0);
    expect(root.querySelectorAll(".message, .turn, [data-block]")).toHaveLength(0);

    bridge.queueResponse("onboarding.dispatch", Promise.resolve({ kind: "cancelled", view: account }));
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1)).toEqual({
      t: "onboarding.dispatch",
      intent: {
        kind: "cancel",
        revision: account.revision,
        generation: account.generation,
        operationHandle: account.operationHandle,
      },
    });
    const restoredRow = { ...directRow, handle: "opaque-settings-openrouter-reconnect-fresh" };
    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "settings.view",
      view: {
        ...withDirectRow,
        revision: withDirectRow.revision + 1,
        initialFocusKey: restoredRow.focusKey,
        categories: withDirectRow.categories.map((category) => category.id === "accounts"
          ? { ...category, commonItems: [restoredRow] }
          : category),
      },
    });
    await expect.element(page.getByRole("button", { name: "OpenRouter · Neu verbinden" })).toBeVisible();
    await expect.poll(() => (document.activeElement as HTMLElement | null)?.dataset.settingsFocusKey)
      .toBe(restoredRow.focusKey);
    expect(root.querySelectorAll(".message, .turn, [data-block]")).toHaveLength(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("cancelling a direct provider secret restores Settings without revealing a hidden provider overlay", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const disconnected = onboardingProvider({
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    connectionId: null,
    accountLabel: null,
    state: "disconnected",
    routes: [],
  });
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers: [disconnected] }));
  const mount = mountDesktopWindow({ bridge, root });
  const directRow = settingsRow(
    "opaque-settings-openrouter-connect",
    "OpenRouter · Verbinden",
    { control: "action", actionLabel: "Verbinden" },
  );
  const settingsView = progressiveSettingsView("accounts");
  const withDirectRow: DesktopSettingsView = {
    ...settingsView,
    categories: settingsView.categories.map((category) => category.id === "accounts"
      ? { ...category, commonItems: [directRow] }
      : category),
  };
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.view", view: withDirectRow });
    await userEvent.click(page.getByRole("button", { name: "OpenRouter · Verbinden" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "activate-row", handle: directRow.handle, revision: withDirectRow.revision },
    });

    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    bridge.emit({
      t: "ask",
      v: PROTOCOL_VERSION,
      askId: "direct-openrouter-secret",
      kind: "secret",
      label: "OpenRouter API key",
      escHint: "Zurück zu Konten",
    });
    await expect.element(page.getByRole("dialog", { name: "OpenRouter API key" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Zurück" }));
    await expect.poll(() => bridge.writes.at(-1)).toEqual({
      t: "answer",
      askId: "direct-openrouter-secret",
      value: null,
    });

    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "desktop.snapshot",
      snapshot: capabilitySnapshot({ providers: [disconnected] }),
    });
    bridge.emit(onboardingEvent(onboardingStep({
      operationHandle: undefined,
      step: "provider",
      returnTo: "settings",
      providers: [disconnected],
    })));
    const restoredRow = { ...directRow, handle: "opaque-settings-openrouter-connect-fresh" };
    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "settings.view",
      view: {
        ...withDirectRow,
        revision: withDirectRow.revision + 1,
        initialFocusKey: restoredRow.focusKey,
        categories: withDirectRow.categories.map((category) => category.id === "accounts"
          ? { ...category, commonItems: [restoredRow] }
          : category),
      },
    });
    await expect.element(page.getByRole("button", { name: "OpenRouter · Verbinden" })).toBeVisible();
    await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
    await expect.poll(() => (document.activeElement as HTMLElement | null)?.dataset.settingsFocusKey)
      .toBe(restoredRow.focusKey);
    expect(root.querySelectorAll(".message, .turn, [data-block]")).toHaveLength(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("Settings Anbieter einrichten walks the visible shared route picker and readiness restores Konten", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const route = onboardingRoute();
  const provider = onboardingProvider({ routes: [route] });
  const providers = [provider];
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ routeRunnable: true, providers }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    const restored = progressiveSettingsView("accounts");
    const restoredRow = restored.categories[1]!.commonItems[0]!;
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: { ...restored, initialFocusKey: restoredRow.focusKey },
    });
    await userEvent.click(page.getByRole("button", { name: "Anbieter einrichten" }));
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    bridge.emit(onboardingEvent(onboardingStep({ step: "provider", returnTo: "settings", providers })));
    await expect.element(page.getByRole("dialog", { name: "Provider wählen" })).toBeVisible();
    expect(document.querySelector(".route-picker")).toBeNull();
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(0);

    await userEvent.click(page.getByRole("option", { name: /OpenRouter · Eigentümerkonto/ }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1)).toEqual({
      t: "onboarding.dispatch",
      intent: { kind: "choose-provider", providerId: provider.providerId, revision: 7, generation: 3 },
    });
    bridge.emit(onboardingEvent(onboardingStep({
      step: "account", returnTo: "settings", providerId: provider.providerId, providers,
    })));
    await expect.element(page.getByRole("dialog", { name: "Konto wählen" })).toBeVisible();
    const account = page.getByRole("option", { name: /Eigentümerkonto/ });
    (account.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1)).toEqual({
      t: "onboarding.dispatch",
      intent: { kind: "choose-account", connectionId: provider.connectionId, revision: 7, generation: 3 },
    });
    bridge.emit(onboardingEvent(onboardingStep({
      step: "model",
      returnTo: "settings",
      providerId: provider.providerId,
      connectionId: provider.connectionId ?? undefined,
      accountLabel: provider.accountLabel ?? undefined,
      providers,
      candidates: [route],
    })));
    await expect.element(page.getByRole("dialog", { name: "Modell und Konto wählen" })).toBeVisible();
    expect(document.querySelector(".route-picker")).not.toBeNull();
    const choose = page.getByRole("button", { name: "Auswählen" });
    await expect.element(choose).toBeDisabled();
    await userEvent.click(page.getByRole("option", { name: /Claude Sonnet 4/ }));
    await expect.element(choose).toBeEnabled();
    await userEvent.click(choose);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1)).toEqual({
      t: "onboarding.dispatch",
      intent: { kind: "choose-model", routeHandle: route.handle, revision: 7, generation: 3 },
    });

    bridge.emit(onboardingEvent(onboardingStep({
      operationHandle: undefined,
      step: "ready",
      returnTo: "settings",
      providers,
    })));
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: { ...progressiveSettingsView("accounts"), initialFocusKey: restoredRow.focusKey },
    });
    await expect.element(page.getByRole("button", { name: "Anbieter einrichten" })).toBeVisible();
    await expect.poll(() => document.querySelector(".route-picker, .onboarding-view")).toBeNull();
    await expect.poll(() => (document.activeElement as HTMLElement | null)?.dataset.settingsFocusKey)
      .toBe(restoredRow.focusKey);
    expect(root.querySelectorAll(".message, .turn, [data-block]")).toHaveLength(0);
    expect(bridge.writes).toHaveLength(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("760×520 walks progressive Settings, typed switches, deepest Escape and dedicated close", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot({
    routeRunnable: true,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByRole("button", { name: "Einstellungen" })).toBeVisible();
    await expect.poll(() => bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView(),
    });
    await expect.poll(() => [...root.querySelectorAll("[role='tab']")].map((node) => node.textContent))
      .toEqual(["Modell", "Konten", "Sicherheit", "Mehr"]);
    expect(root.querySelectorAll(".settings-row")).toHaveLength(3);
    expect(root.textContent).not.toContain("Seltene Einstellung");

    await userEvent.click(page.getByRole("button", { name: "Weitere Einstellungen" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "toggle-advanced", categoryId: "model", revision: 40 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 41, modelExpanded: true }),
    });
    await expect.element(page.getByRole("button", { name: /Seltene Einstellung/ })).toBeVisible();

    const search = page.getByRole("searchbox", { name: "Einstellungen durchsuchen" });
    await userEvent.fill(search, "seltene");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "search-change", query: "seltene", revision: 41 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 42, modelExpanded: true, searchQuery: "seltene" }),
    });
    await expect.element(page.getByRole("button", { name: /Seltene Einstellung/ })).toBeVisible();

    const closeBeforeEscape = bridge.requests.filter(({ t }) => t === "settings.close").length;
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch", intent: { kind: "back", revision: 42 },
    });
    expect(bridge.requests.filter(({ t }) => t === "settings.close")).toHaveLength(closeBeforeEscape);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 43, modelExpanded: true }),
    });
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch", intent: { kind: "back", revision: 43 },
    });
    expect(bridge.requests.filter(({ t }) => t === "settings.close")).toHaveLength(closeBeforeEscape);
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 44 }),
    });

    (page.getByRole("tab", { name: "Modell" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "select-category", categoryId: "accounts", revision: 44 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 45, selectedCategoryId: "accounts" }),
    });
    const disabled = page.getByRole("button", { name: /Anbieter einrichten/ });
    await expect.element(disabled).toBeDisabled();
    await expect.element(disabled).toHaveAttribute("aria-disabled", "true");
    const dispatchesBeforeDisabled = bridge.requests.filter(({ t }) => t === "settings.dispatch").length;
    (disabled.element() as HTMLButtonElement).click();
    expect(bridge.requests.filter(({ t }) => t === "settings.dispatch")).toHaveLength(dispatchesBeforeDisabled);
    expect(root.textContent).toContain("Anbieter ist eingeschränkt");
    expect(root.textContent).toContain("Verbindung zuerst reparieren");
    expect(root.textContent).not.toContain("provider-degraded");

    await userEvent.click(page.getByRole("tab", { name: "Sicherheit" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "select-category", categoryId: "security", revision: 45 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 46, selectedCategoryId: "security" }),
    });
    await expect.element(page.getByRole("button", { name: /Freigabemodus/ })).toBeVisible();

    await userEvent.click(page.getByRole("tab", { name: "Mehr" }));
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 47, selectedCategoryId: "more" }),
    });
    const headerSwitch = page.getByRole("switch", { name: /Kompakte Kopfmarke/ });
    await userEvent.click(headerSwitch);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "set-boolean", handle: "opaque-settings-header", value: false, revision: 47 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "desktop.snapshot",
      snapshot: capabilitySnapshot({ routeRunnable: true, appearance: { showLargeLogo: true, showHeaderMark: false } }),
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "settings.view",
      view: settingsMatrixView({ revision: 48, selectedCategoryId: "more", showHeaderMark: false }),
    });
    await expect.poll(() => root.querySelector(".route-core-brand--settings-header")).toBeNull();

    const logoSwitch = page.getByRole("switch", { name: /Großes ORCODE-Logo/ });
    await userEvent.click(logoSwitch);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.dispatch").at(-1)).toEqual({
      t: "settings.dispatch",
      intent: { kind: "set-boolean", handle: "opaque-settings-logo", value: false, revision: 48 },
    });
    bridge.emit({
      t: "event", v: PROTOCOL_VERSION, e: "desktop.snapshot",
      snapshot: capabilitySnapshot({ routeRunnable: true, appearance: { showLargeLogo: false, showHeaderMark: false } }),
    });

    for (const [index, notice] of [
      { code: "saved", level: "info", label: "Gespeichert" },
      { code: "cancelled", level: "info", label: "Änderung abgebrochen" },
      { code: "stale", level: "warning", label: "Ansicht veraltet · erneut öffnen" },
      { code: "failed", level: "error", label: "Änderung fehlgeschlagen · erneut versuchen" },
    ].entries()) {
      bridge.emit({
        t: "event", v: PROTOCOL_VERSION, e: "settings.view",
        view: settingsMatrixView({
          revision: 49 + index,
          selectedCategoryId: "more",
          showLargeLogo: false,
          showHeaderMark: false,
          notice: notice as DesktopSettingsView["notice"],
        }),
      });
      await expect.poll(() => root.querySelector(".setnotice")?.textContent).toBe(notice.label);
      expect(root.querySelector(".setnotice")?.getAttribute("data-level")).toBe(notice.level);
      expect(root.querySelector(".setnotice")?.textContent).not.toContain(notice.code);
    }
    expect(root.textContent).not.toMatch(/\b(Choose|Current|Run active|No |Settings|Automatic|Enabled|Disabled|Show|Open|Save|Cancel)\b/i);

    const closeMark = bridge.requests.filter(({ t }) => t === "settings.close").length;
    await userEvent.click(page.getByRole("button", { name: "Fertig" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "settings.close").length).toBe(closeMark + 1);
    bridge.emit({ t: "event", v: PROTOCOL_VERSION, e: "settings.closed" });
    await expect.poll(() => root.querySelector(".settings")).toBeNull();
    expect(root.querySelector(".route-core-brand--empty")).toBeNull();
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("760×520 drives the real provider-account-model flow without auto-selection", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);

  const known = onboardingRoute();
  const unknown = onboardingRoute({
    handle: "route-kimi-unknown",
    providerId: "opaque-provider-kimi",
    connectionId: "opaque-connection-kimi",
    accountLabel: "Mitgliedschaft",
    canonicalModelId: "moonshotai/kimi-k2",
    displayName: "Kimi K2",
    reasoning: "unknown",
    capabilities: ["text", "tools"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    runnable: false,
    disabled: {
      code: "native-local-action-unavailable",
      label: "Lokale Bestätigung ist nicht verfügbar",
      recoveryLabel: "In der Terminal-App verbinden",
    },
  });
  const owner = onboardingProvider({ routes: [known] });
  const kimi = onboardingProvider({
    providerId: "opaque-provider-kimi",
    providerLabel: "Kimi Code · Mitgliedschaft",
    connectionId: "opaque-connection-kimi",
    accountLabel: "Mitgliedschaft",
    state: "disabled",
    setupMethods: ["kimi-owner-connect"],
    routes: [unknown],
    disabled: {
      code: "native-local-action-unavailable",
      label: "Lokale Bestätigung ist nicht verfügbar",
      recoveryLabel: "In der Terminal-App verbinden",
    },
  });
  const codex = onboardingProvider({
    providerId: "opaque-provider-codex",
    providerLabel: "Codex · Browser-Anmeldung",
    connectionId: null,
    accountLabel: null,
    state: "disconnected",
    setupMethods: ["codex-browser-login"],
  });
  const repair = onboardingProvider({
    providerId: "opaque-provider-repair",
    providerLabel: "OpenRouter · Reparaturkonto",
    connectionId: "opaque-connection-repair",
    accountLabel: "Reparaturkonto",
    state: "degraded",
    repair: {
      code: "account-authentication-required",
      label: "Anmeldung erneuern",
      recoveryLabel: "Konto erneut verbinden",
    },
  });
  const providers = [owner, kimi, codex, repair];
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const connect = page.getByRole("button", { name: "Verbinden" });
    await expect.element(connect).toBeVisible();
    await userEvent.click(connect);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toEqual([{
      t: "onboarding.dispatch",
      intent: { kind: "open-model-picker", returnTo: "chat", revision: 7, generation: 3 },
    }]);

    const providerView = onboardingStep({ providers });
    bridge.emit(onboardingEvent(providerView));
    const dialog = page.getByRole("dialog", { name: "Provider wählen" });
    await expect.element(dialog).toBeVisible();
    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Abbrechen");
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(1);

    const mountedDialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    const beforeReplay = document.querySelector<HTMLElement>("[role='dialog']");
    bridge.emit(onboardingEvent({
      ...providerView,
      generation: 2,
      providers: [onboardingProvider({ providerLabel: "STALE PROVIDER" })],
    }));
    bridge.emit(onboardingEvent(providerView));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.querySelector<HTMLElement>("[role='dialog']")).toBe(beforeReplay);
    expect(document.body.textContent).not.toContain("STALE PROVIDER");

    const controls = [...mountedDialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    const first = controls[0]!;
    const last = controls.at(-1)!;
    last.focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(first);
    first.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);

    const kimiButton = [...document.querySelectorAll<HTMLButtonElement>(".onboarding-option")]
      .find((node) => node.textContent?.includes("Kimi Code · Mitgliedschaft"))!;
    expect(kimiButton.disabled).toBe(true);
    expect(kimiButton.getAttribute("aria-disabled")).toBe("true");
    kimiButton.click();
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(1);
    expect(mountedDialog.textContent).toContain("Lokale Bestätigung ist nicht verfügbar");
    expect(mountedDialog.textContent).toContain("In der Terminal-App verbinden");
    expect(mountedDialog.textContent).toContain("Codex · Browser-Anmeldung");
    expect(mountedDialog.textContent).toContain("Anmeldung erneuern");
    expect(mountedDialog.textContent).toContain("Konto erneut verbinden");
    expect(mountedDialog.textContent).not.toContain("opaque-provider");
    expect(mountedDialog.textContent).not.toContain("native-local-action-unavailable");
    expect(mountedDialog.textContent).not.toContain("account-authentication-required");
    expect(mountedDialog.textContent).not.toContain("disconnected");

    await userEvent.click(page.getByRole("option", { name: /OpenRouter · Eigentümerkonto/ }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(2);
    bridge.emit(onboardingEvent(onboardingStep({
      step: "account",
      providerId: owner.providerId,
      providers,
    })));
    await expect.element(page.getByRole("dialog", { name: "Konto wählen" })).toBeVisible();
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(2);
    await userEvent.click(page.getByRole("option", { name: /Eigentümerkonto/ }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(3);

    bridge.emit(onboardingEvent(onboardingStep({
      step: "model",
      providerId: owner.providerId,
      connectionId: owner.connectionId ?? undefined,
      accountLabel: owner.accountLabel ?? undefined,
      providers,
      candidates: [known, unknown],
    })));
    await expect.element(page.getByRole("dialog", { name: "Modell und Konto wählen" })).toBeVisible();
    expect(document.body.textContent).toContain("Abrechnung nach Nutzung");
    expect(document.body.textContent).toContain("Provider-Richtlinie");
    expect(document.body.textContent).toContain("Kosten unbekannt");
    expect(document.body.textContent).toContain("Datenrichtlinie unbekannt");
    expect(document.body.textContent).toContain("Denkmodus unterstützt");
    expect(document.body.textContent).toContain("Denkmodus unbekannt");
    const modelDialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(modelDialog.textContent).not.toContain("supported");
    expect(modelDialog.textContent).not.toContain("unknown");
    expect(modelDialog.textContent).not.toContain("opaque-provider");
    expect(modelDialog.textContent).not.toContain("Reasoning");
    const choose = page.getByRole("button", { name: "Auswählen" });
    await expect.element(choose).toBeDisabled();
    const knownOption = page.getByRole("option", { name: /Claude Sonnet 4/ });
    (knownOption.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect.element(knownOption).toHaveAttribute("aria-selected", "true");
    await expect.element(choose).toBeEnabled();
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(3);
    await userEvent.click(choose);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toEqual([
      {
        t: "onboarding.dispatch",
        intent: { kind: "open-model-picker", returnTo: "chat", revision: 7, generation: 3 },
      },
      {
        t: "onboarding.dispatch",
        intent: { kind: "choose-provider", providerId: owner.providerId, revision: 7, generation: 3 },
      },
      {
        t: "onboarding.dispatch",
        intent: { kind: "choose-account", connectionId: owner.connectionId, revision: 7, generation: 3 },
      },
      {
        t: "onboarding.dispatch",
        intent: { kind: "choose-model", routeHandle: known.handle, revision: 7, generation: 3 },
      },
    ]);

    bridge.emit(onboardingEvent(onboardingStep({
      operationHandle: undefined,
      step: "error",
      providerId: owner.providerId,
      connectionId: owner.connectionId ?? undefined,
      accountLabel: owner.accountLabel ?? undefined,
      providers,
      candidates: [known, unknown],
      error: {
        code: "route-activation-failed",
        label: "Das Modell konnte nicht aktiviert werden",
        recoveryLabel: "Erneut versuchen oder zurückgehen",
      },
    })));
    await expect.element(page.getByRole("dialog", { name: "Auswahl nicht abgeschlossen" })).toBeVisible();
    expect(document.body.textContent).toContain("Das Modell konnte nicht aktiviert werden");
    expect(document.body.textContent).toContain("Erneut versuchen oder zurückgehen");
    expect(document.body.textContent).not.toContain("route-activation-failed");
    await userEvent.click(page.getByRole("button", { name: "Erneut versuchen" }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch").at(-1)).toEqual({
      t: "onboarding.dispatch",
      intent: { kind: "retry", revision: 7, generation: 3 },
    });

    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "desktop.snapshot",
      snapshot: capabilitySnapshot({
        routeRunnable: true,
        activeRoute: {
          routeHandle: known.handle,
          providerLabel: owner.providerLabel,
          modelLabel: known.displayName,
          accountLabel: known.accountLabel,
        },
        providers,
      }),
    });
    bridge.emit(onboardingEvent(onboardingStep({ step: "ready", providers })));
    await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Modell/Konto · Ändern" })).toBeVisible();
    expect(root.textContent).toContain("Claude Sonnet 4 · Eigentümerkonto");
    expect(root.querySelectorAll("[data-block]")).toHaveLength(0);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("a child exit retires current onboarding before engine recovery and dead controls stay inert", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const owner = onboardingProvider();
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers: [owner] }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await userEvent.click(page.getByRole("button", { name: "Verbinden" }));
    bridge.emit(onboardingEvent(onboardingStep({ providers: [owner] })));

    const providerDialog = page.getByRole("dialog", { name: "Provider wählen" });
    await expect.element(providerDialog).toBeVisible();
    const deadProviderControl = page.getByRole("option", { name: /OpenRouter · Eigentümerkonto/ })
      .element() as HTMLButtonElement;
    const requestsBeforeExit = bridge.requests.filter(({ t }) => t === "onboarding.dispatch").length;

    bridge.exit();

    await expect.element(page.getByRole("button", { name: "Neuen Motor starten" })).toBeVisible();
    expect(document.querySelector(".onboarding-view")).toBeNull();
    expect(document.body.textContent).toContain("The engine stopped (exit 1).");
    deadProviderControl.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(requestsBeforeExit);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("exact typed provider setup opens canonical onboarding without transcript output", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const owner = onboardingProvider();
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers: [owner] }), READY_STATUS, [], [PROVIDER_SETUP_ROW]);
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const composer = page.getByRole("textbox", { name: "Nachricht" });
    await expect.element(composer).toBeVisible();
    const passive = onboardingStep({ operationHandle: undefined, providers: [owner] });
    bridge.emit(onboardingEvent(passive));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    await userEvent.type(composer, "/provider setup{Enter}");
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([{
      t: "command",
      raw: "/provider setup",
      draft: "",
    }]);
    // The exact command reaches the server's canonical onboarding dispatch;
    // that operation view carries its server-injected capability handle.
    bridge.emit(onboardingEvent(onboardingStep({ providers: [owner] })));
    await expect.element(page.getByRole("dialog", { name: "Provider wählen" })).toBeVisible();
    expect(requestCount(bridge, "onboarding.dispatch")).toBe(0);
    expect(document.querySelector("[role='option'][aria-selected='true']")).toBeNull();
    expect(bridge.writes).toHaveLength(0);
    expect(root.querySelectorAll("[data-block]")).toHaveLength(0);
    expect(root.textContent).not.toContain("/provider setup");
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("the catalog-owned Provider setup run row reaches the same renderer by mouse and Enter", async () => {
  await page.viewport(760, 520);
  for (const activation of ["mouse", "enter"] as const) {
    document.body.replaceChildren();
    const root = document.createElement("div");
    document.body.append(root);
    const owner = onboardingProvider();
    const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers: [owner] }), READY_STATUS, [], [PROVIDER_SETUP_ROW]);
    const mount = mountDesktopWindow({ bridge, root });
    try {
      await expect.element(page.getByRole("button", { name: "Neuer Chat" })).toBeVisible();
      pressCommandPaletteShortcut();
      const search = page.getByRole("textbox", { name: "Befehl suchen" });
      await expect.element(search).toBeVisible();
      await userEvent.type(search, "Provider setup");
      const run = page.getByRole("button", { name: /Provider setup/ });
      await expect.element(run).toBeVisible();
      if (activation === "mouse") await userEvent.click(run);
      else await userEvent.keyboard("{Enter}");
      await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([{
        t: "command",
        raw: "/provider setup",
        draft: "",
      }]);
      bridge.emit(onboardingEvent(onboardingStep({ providers: [owner] })));
      await expect.element(page.getByRole("dialog", { name: "Provider wählen" })).toBeVisible();
      expect(document.querySelector(".palette")).toBeNull();
      expect(document.querySelectorAll(".onboarding-list")).toHaveLength(1);
      expect(requestCount(bridge, "onboarding.dispatch")).toBe(0);
      expect(document.querySelector("[role='option'][aria-selected='true']")).toBeNull();
      expect(bridge.writes).toHaveLength(0);
      expect(root.querySelectorAll("[data-block]")).toHaveLength(0);
    } finally {
      mount.dispose();
    }
  }
  await page.viewport(1280, 720);
});

test("chat header entry contexts are canonical and Escape restores its production trigger", async () => {
  await page.viewport(760, 520);
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  const owner = onboardingProvider();
  const candidate = onboardingRoute();
  const providers = [{ ...owner, routes: [candidate] }];
  const bridge = new FakeDesktopBridge(capabilitySnapshot({ providers }));
  const mount = mountDesktopWindow({ bridge, root });
  try {
    const disconnected = page.getByRole("button", { name: "Modell wählen" });
    await expect.element(disconnected).toBeVisible();
    await userEvent.click(disconnected);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toEqual([{
      t: "onboarding.dispatch",
      intent: { kind: "open-model-picker", returnTo: "model-picker", revision: 7, generation: 3 },
    }]);
    expect(requestCount(bridge, "command")).toBe(0);

    bridge.emit({
      t: "event",
      v: PROTOCOL_VERSION,
      e: "desktop.snapshot",
      snapshot: capabilitySnapshot({
        routeRunnable: true,
        activeRoute: {
          routeHandle: candidate.handle,
          providerLabel: owner.providerLabel,
          modelLabel: candidate.displayName,
          accountLabel: candidate.accountLabel,
        },
        providers,
      }),
    });
    const change = page.getByRole("button", { name: "Modell/Konto · Ändern" });
    await expect.element(change).toBeVisible();
    await userEvent.click(change);
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(2);
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")[1]).toEqual({
      t: "onboarding.dispatch",
      intent: { kind: "open-model-picker", returnTo: "chat", revision: 7, generation: 3 },
    });
    expect(requestCount(bridge, "command")).toBe(0);

    const visible = onboardingStep({ providers });
    bridge.emit(onboardingEvent(visible));
    await expect.element(page.getByRole("dialog", { name: "Provider wählen" })).toBeVisible();
    await expect.poll(() => document.activeElement?.textContent?.trim()).toBe("Abbrechen");
    bridge.queueResponse("onboarding.dispatch", Promise.resolve({ kind: "cancelled", view: visible }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect.poll(() => bridge.requests.filter(({ t }) => t === "onboarding.dispatch")).toHaveLength(3);
    expect(bridge.requests.filter(({ t }) => t === "onboarding.dispatch")[2]).toEqual({
      t: "onboarding.dispatch",
      intent: {
        kind: "cancel",
        revision: 7,
        generation: 3,
        operationHandle: "operation-browser-owner",
      },
    });
    await expect.poll(() => document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(change.element());
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});

test("shows the subminimum hint, wraps reasons, and emits no request", async () => {
  await page.viewport(759, 519);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeDesktopBridge(capabilitySnapshot());
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await expect.element(page.getByText("Fenster vergrößern", { exact: true })).toBeVisible();
    const reason = document.createElement("div");
    reason.className = "disabled-reason";
    reason.textContent = "Diese ausführliche Begründung muss vollständig umbrechen können.";
    root.querySelector(".main")?.append(reason);
    const style = getComputedStyle(reason);
    expect(style.textOverflow).not.toBe("ellipsis");
    expect(style.overflowWrap).toBe("anywhere");
    await expect.poll(() => bridge.requests.some(({ t }) => t === "chats.list")).toBe(true);
    const before = bridge.requests.length;
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(bridge.requests).toHaveLength(before);
  } finally {
    mount.dispose();
    await page.viewport(1280, 720);
  }
});
