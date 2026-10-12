// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { AskQueue, type PendingAsk } from "../src/asks.js";
import {
  PROTOCOL_VERSION,
  type AskFrame,
  type DesktopSettingsCategory,
  type DesktopSettingsCategoryId,
  type DesktopSettingsRow,
  type DesktopSettingsView,
} from "../src/protocol.js";
import { settingsContent, settingsHeader } from "../src/settings-view.js";
import { askPanel } from "../src/views.js";

function row(over: Partial<DesktopSettingsRow> = {}): DesktopSettingsRow {
  return {
    handle: "opaque-main-model",
    label: "Hauptmodell",
    description: "Modell und aktive Sitzung gemeinsam wechseln",
    displayValue: "Modell: model/main",
    control: "choice",
    ...over,
  };
}

function category(
  id: DesktopSettingsCategoryId,
  label: string,
  over: Partial<DesktopSettingsCategory> = {},
): DesktopSettingsCategory {
  return {
    id,
    label,
    description: `${label} verwalten`,
    expanded: false,
    commonItems: [],
    advancedItems: [],
    ...over,
  };
}

function view(over: Partial<DesktopSettingsView> = {}): DesktopSettingsView {
  const categories = over.categories ?? [
    category("model", "Modell", {
      commonItems: [
        row(),
        row({ handle: "opaque-reasoning", label: "Denken · Hauptmodell", displayValue: "Automatisch" }),
        row({ handle: "opaque-max-steps", label: "Aktionen pro Lauf", displayValue: "42" }),
      ],
      advancedItems: [
        row({ handle: "opaque-rare", label: "Seltene Einstellung", description: "Nur bei Bedarf", displayValue: "Aus" }),
      ],
    }),
    category("accounts", "Konten", {
      commonItems: [row({
        handle: "opaque-provider-setup",
        label: "Anbieter einrichten",
        description: "Geführte Kontoeinrichtung öffnen",
        displayValue: "Öffnen",
        control: "action",
        actionLabel: "Einrichten",
      })],
    }),
    category("security", "Sicherheit"),
    category("more", "Mehr", {
      commonItems: [row({
        handle: "opaque-logo",
        label: "Großes ORCODE-Logo",
        description: "Großes Logo auf der Startseite anzeigen",
        displayValue: "beliebiger Text",
        control: "boolean",
        booleanValue: false,
      })],
    }),
  ];
  return {
    revision: 4,
    categories,
    selectedCategoryId: "model",
    search: { active: false, query: "", results: [] },
    notice: null,
    ...over,
  };
}

function ask(kind: string, payload: Record<string, unknown> = {}): PendingAsk {
  const queue = new AskQueue();
  return queue.push({ t: "ask", v: PROTOCOL_VERSION, askId: `a-${kind}`, kind, ...payload } as AskFrame);
}

function handlers() {
  return { dispatch: vi.fn(), close: vi.fn() };
}

describe("the Settings screen", () => {
  it("renders four categories, no more than three common rows, and projected advanced rows", () => {
    const initial = view();
    const node = settingsContent(initial, handlers());
    expect(initial.categories.map(({ id }) => id)).toEqual(["model", "accounts", "security", "more"]);
    expect(initial.categories.every(({ commonItems }) => commonItems.length <= 3)).toBe(true);
    expect([...node.querySelectorAll("[role='tab']")].map((tab) => tab.textContent))
      .toEqual(["Modell", "Konten", "Sicherheit", "Mehr"]);
    expect([...node.querySelectorAll(".settings-row .name")].map((name) => name.textContent))
      .toEqual(["Hauptmodell", "Denken · Hauptmodell", "Aktionen pro Lauf"]);
    expect(node.textContent).not.toContain("Seltene Einstellung");

    const advanced = settingsContent(view({
      categories: initial.categories.map((entry) => entry.id === "model"
        ? { ...entry, expanded: true }
        : entry),
    }), handlers());
    expect(advanced.querySelector(".settings-advanced")?.textContent).toBe("Seltene Einstellung");
    expect(advanced.querySelector<HTMLButtonElement>(".settings-more")?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("selects a category and discloses advanced rows with revision-bound intents", () => {
    const acted = handlers();
    const node = settingsContent(view(), acted);
    [...node.querySelectorAll<HTMLButtonElement>(".tab")][1]!.click();
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "select-category", categoryId: "accounts", revision: 4,
    });
    node.querySelector<HTMLButtonElement>(".settings-more")!.click();
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "toggle-advanced", categoryId: "model", revision: 4,
    });
  });

  it("renders the projected search results, including rows hidden behind advanced", () => {
    const rare = row({
      handle: "opaque-search-result",
      label: "Seltene Einstellung",
      description: "Nur bei Bedarf",
      displayValue: "Aus",
    });
    const searching = view({ search: { active: true, query: "seltene", results: [rare] } });
    const acted = handlers();
    const node = settingsContent(searching, acted);
    expect([...node.querySelectorAll(".settings-row .name")].map((name) => name.textContent))
      .toEqual(["Seltene Einstellung"]);
    const input = node.querySelector<HTMLInputElement>(".settings-search")!;
    input.value = "seltene einstellung";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "search-change", query: "seltene einstellung", revision: 4,
    });
  });

  it("calls the dedicated close handler once on the first Fertig click during search", () => {
    const acted = handlers();
    const head = settingsHeader(view({
      search: { active: true, query: "logo", results: [] },
    }), acted);
    [...head.querySelectorAll("button")].find((b) => b.textContent === "Fertig")!.click();
    expect(acted.close).toHaveBeenCalledOnce();
    expect(acted.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a boolean switch from booleanValue without parsing displayValue", () => {
    const acted = handlers();
    const node = settingsContent(view({ selectedCategoryId: "more" }), acted);
    const toggle = node.querySelector<HTMLButtonElement>("[role='switch']")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "set-boolean", handle: "opaque-logo", value: true, revision: 4,
    });
  });

  it("uses opaque activate-row for model and account rows without constructing another picker", () => {
    const acted = handlers();
    const node = settingsContent(view(), acted);
    node.querySelector<HTMLButtonElement>(".settings-row")!.click();
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "activate-row", handle: "opaque-main-model", revision: 4,
    });
    expect(node.querySelector(".route-picker")).toBeNull();

    const accounts = settingsContent(view({ selectedCategoryId: "accounts" }), acted);
    accounts.querySelector<HTMLButtonElement>(".settings-row")!.click();
    expect(acted.dispatch).toHaveBeenCalledWith({
      kind: "activate-row", handle: "opaque-provider-setup", revision: 4,
    });
    expect(accounts.querySelector(".route-picker")).toBeNull();
  });

  it("renders disabled and recovery presentation without a handler or raw code", () => {
    const acted = handlers();
    const disabled = row({
      handle: "opaque-disabled",
      label: "Denken · Hauptmodell",
      control: "locked",
      disabled: {
        code: "model-reasoning-unsupported",
        label: "Denkmodus wird nicht unterstützt",
        recoveryLabel: "Anderes Modell wählen",
      },
    });
    const initial = view();
    const node = settingsContent(view({
      categories: initial.categories.map((entry) => entry.id === "model"
        ? { ...entry, commonItems: [disabled], advancedItems: [] }
        : entry),
    }), acted);
    const locked = node.querySelector<HTMLButtonElement>(".settings-row")!;
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(node.textContent).toContain("Denkmodus wird nicht unterstützt");
    expect(node.textContent).toContain("Anderes Modell wählen");
    expect(node.textContent).not.toContain("model-reasoning-unsupported");
    locked.click();
    expect(acted.dispatch).not.toHaveBeenCalled();
  });

  it("renders readonly values as visible text, never as a disabled control or tab stop", () => {
    const initial = view();
    const readonly = row({
      handle: "opaque-readonly",
      label: "Aktuelle Kosten",
      displayValue: "Chat 1,20 USD · Heute 3,40 USD",
      control: "readonly",
    });
    const node = settingsContent(view({
      categories: initial.categories.map((entry) => entry.id === "model"
        ? { ...entry, commonItems: [readonly], advancedItems: [] }
        : entry),
    }), handlers());
    const text = node.querySelector<HTMLElement>(".settings-readonly");
    expect(text?.textContent).toContain("Aktuelle Kosten");
    expect(text?.textContent).toContain("Chat 1,20 USD · Heute 3,40 USD");
    expect(text?.tagName).not.toBe("BUTTON");
    expect(text?.hasAttribute("tabindex")).toBe(false);
    expect(node.querySelector("button.settings-row, [role='switch']")).toBeNull();
  });

  it("renders every Foundation notice label and never its code or English fallback", () => {
    for (const [code, level, label] of [
      ["saved", "info", "Gespeichert"],
      ["cancelled", "info", "Änderung abgebrochen"],
      ["stale", "warning", "Ansicht veraltet · erneut öffnen"],
      ["failed", "error", "Änderung fehlgeschlagen · erneut versuchen"],
    ] as const) {
      const node = settingsContent(view({ notice: { code, level, label } }), handlers());
      expect(node.querySelector(".setnotice")?.textContent).toBe(label);
      expect(node.querySelector(".setnotice")?.getAttribute("data-level")).toBe(level);
      expect(node.textContent).not.toContain(code);
      expect(node.textContent).not.toMatch(/\b(Saved|Cancelled|Stale|Failed|Settings)\b/i);
    }
  });
});

describe("a settings editor", () => {
  it("renders only the closed German choice presentation and returns an opaque option handle", () => {
    const answer = vi.fn();
    const panel = askPanel(
      ask("settings-editor", {
        editor: {
          kind: "choice",
          title: "Freigabemodus",
          description: "Bestimmt, welche Aktionen bestätigt werden müssen",
          options: [
            { handle: "choice-a", label: "Nachfragen", selected: true },
            { handle: "choice-b", label: "Alles erlauben", selected: false },
          ],
          cancelLabel: "Abbrechen",
          busyLabel: "Änderung wird angewendet …",
        },
      }),
      { answer, decline: () => {} },
    );
    expect([...panel.querySelectorAll(".settings-editor-option .n")].map((n) => n.textContent))
      .toEqual(["❯Nachfragen", "Alles erlauben"]);
    expect(panel.querySelector(".picker")).toBeNull();
    expect(panel.textContent).not.toMatch(/Approvals|ask every time|allow-all|actionId|categoryId/i);
    panel.querySelectorAll<HTMLButtonElement>(".settings-editor-option")[1]!.click();
    expect(answer).toHaveBeenCalledWith(expect.anything(), {
      t: "answer",
      askId: "a-settings-editor",
      decision: { kind: "choice", optionHandle: "choice-b" },
    });
  });

  it("renders canonical number and text editors without raw validation text", () => {
    const answer = vi.fn();
    for (const editor of [
      {
        kind: "number" as const,
        title: "Aktionen pro Lauf",
        description: "Maximale Anzahl der Modellaktionen",
        inputLabel: "Anzahl",
        initialValue: "40",
        constraintLabel: "1 bis 100",
        submitLabel: "Speichern",
        cancelLabel: "Abbrechen",
        busyLabel: "Änderung wird angewendet …",
        notice: { level: "error" as const, label: "Bitte einen Wert im angegebenen Bereich eingeben." },
      },
      {
        kind: "text" as const,
        title: "Browserpfad",
        description: "Expliziten Browserpfad festlegen",
        inputLabel: "Pfad",
        initialValue: "/Applications/Browser.app",
        multiline: false,
        submitLabel: "Speichern",
        cancelLabel: "Abbrechen",
        busyLabel: "Änderung wird angewendet …",
      },
    ]) {
      const pending = ask("settings-editor", { editor });
      const panel = askPanel(pending, { answer, decline: () => {} });
      const field = panel.querySelector<HTMLInputElement>("input")!;
      expect(field.labels?.[0]?.textContent?.trim()).toBe(editor.inputLabel);
      expect(panel.textContent).not.toMatch(/Number must|Steps per run|actionId|categoryId|itemId/i);
      field.value = editor.kind === "number" ? "60" : "/Applications/Neu.app";
      [...panel.querySelectorAll("button")].find((b) => b.textContent === "Speichern")!.click();
      expect(answer).toHaveBeenLastCalledWith(pending, {
        t: "answer",
        askId: pending.askId,
        decision: { kind: editor.kind, value: field.value },
      });
    }
  });

  it("renders canonical confirm and invoke editors with German safe actions", () => {
    const panel = askPanel(
      ask("settings-editor", {
        editor: {
          kind: "confirm",
          title: "Alles erlauben aktivieren?",
          description: "Dateiänderungen und Befehle laufen dann ohne weitere Nachfrage.",
          destructive: true,
          confirmLabel: "Bestätigen",
          cancelLabel: "Abbrechen",
          busyLabel: "Änderung wird angewendet …",
        },
      }),
      { answer: () => {}, decline: () => {} },
    );
    expect(panel.querySelector(".conseq")!.textContent)
      .toBe("Dateiänderungen und Befehle laufen dann ohne weitere Nachfrage.");
    const confirm = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Bestätigen")!;
    expect(confirm.hasAttribute("data-default")).toBe(false);
    expect(confirm.getAttribute("data-danger")).toBe("");
    const cancel = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Abbrechen")!;
    expect(cancel.hasAttribute("data-default")).toBe(true);
    expect(panel.textContent).not.toMatch(/allow-all|Really enable|actionId/i);

    const invoked = askPanel(ask("settings-editor", {
      editor: {
        kind: "invoke",
        title: "Prüf-Befehle vorschlagen",
        description: "Passende Projektbefehle ermitteln",
        invokeLabel: "Vorschlagen",
        cancelLabel: "Abbrechen",
        busyLabel: "Änderung wird angewendet …",
      },
    }), { answer: () => {}, decline: () => {} });
    expect([...invoked.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["Abbrechen", "Vorschlagen"]);
  });
});
