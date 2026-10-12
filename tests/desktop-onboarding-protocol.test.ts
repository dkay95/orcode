import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGuiProtocolVersion,
  parseDesktopActivity,
  parseDesktopOnboardingView,
  parseDesktopSettingsIntent,
  parseDesktopSettingsRow,
  parseDesktopSettingsView,
  parseGuiPaletteRow,
  parseOnboardingIntent,
} from "../src/gui-protocol.js";

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

function fixtureSettingsView(overrides: Record<string, unknown>) {
  return {
    revision: 9,
    categories: [],
    selectedCategoryId: "model",
    search: { active: false, query: "", results: [] },
    notice: null,
    ...overrides,
  };
}

test("rejects v1 onboarding input and accepts a generation-bound v2 dispatch", () => {
  assert.deepEqual(assertGuiProtocolVersion({ v: 1, t: "onboarding.dispatch" }), { code: "update-required" });
  assert.deepEqual(parseOnboardingIntent({ v: 2, t: "onboarding.dispatch", intent: { kind: "choose-model", revision: 9, generation: 4, routeHandle: "m-1" } }), { kind: "choose-model", revision: 9, generation: 4, routeHandle: "m-1" });
});

test("the canonical onboarding view can return to its paused Settings owner", () => {
  const parsed = parseDesktopOnboardingView({
    revision: 9,
    generation: 4,
    step: "provider",
    returnTo: "settings",
    providers: [],
    candidates: [],
  });
  assert.equal(parsed.returnTo, "settings");
});

test("round-trips a typed boolean Settings mutation without parsing display copy", () => {
  assert.deepEqual(
    parseDesktopSettingsIntent({ kind: "set-boolean", handle: "appearance-large-logo", value: false, revision: 9 }),
    { kind: "set-boolean", handle: "appearance-large-logo", value: false, revision: 9 },
  );
  assert.deepEqual(parseDesktopSettingsRow({
    handle: "verify", label: "Prüfbefehle", description: "Prüfbefehle verwalten",
    displayValue: "Keine", control: "locked", focusKey: "focus-verify",
    disabled: { code: "no-verify-commands", label: "Keine Prüfbefehle eingerichtet", recoveryLabel: "Prüfbefehl hinzufügen" },
  }), {
    handle: "verify", label: "Prüfbefehle", description: "Prüfbefehle verwalten",
    displayValue: "Keine", control: "locked", focusKey: "focus-verify",
    disabled: { code: "no-verify-commands", label: "Keine Prüfbefehle eingerichtet", recoveryLabel: "Prüfbefehl hinzufügen" },
  });
});

test("round-trips the server-owned Settings focus return without turning it into mutation authority", () => {
  const parsed = parseDesktopSettingsView(fixtureSettingsView({
    initialFocusKey: "focus-provider-entry",
  }));
  assert.equal(parsed.initialFocusKey, "focus-provider-entry");
  assert.equal(JSON.stringify(parsed).includes("itemId"), false);
});

test("adds German command presentation without changing legacy palette fields", () => {
  const row = parseGuiPaletteRow({
    kind: "match", command: "/cost", name: "/cost", description: "Show cost summary",
    usage: "/cost", group: "approvals-costs", verb: "run",
    presentation: {
      description: "Kostenübersicht anzeigen", actionLabel: "Ausführen",
      disabled: { code: "run-active", label: "Während eines Laufs nicht verfügbar", recoveryLabel: "Lauf zuerst stoppen" },
    },
  });
  assert.deepEqual(pick(row, ["kind", "command", "name", "description", "usage", "group", "verb"]), {
    kind: "match", command: "/cost", name: "/cost", description: "Show cost summary",
    usage: "/cost", group: "approvals-costs", verb: "run",
  });
  assert.deepEqual(row.presentation, {
    description: "Kostenübersicht anzeigen", actionLabel: "Ausführen",
    disabled: { code: "run-active", label: "Während eines Laufs nicht verfügbar", recoveryLabel: "Lauf zuerst stoppen" },
  });
});

test("round-trips closed German Activity and Settings-notice presentations", () => {
  assert.deepEqual(parseDesktopActivity({
    id: "activity-1", revision: 9, kind: "setup", level: "info",
    message: { code: "setup-completed", label: "Einrichtung abgeschlossen" },
  }).message, { code: "setup-completed", label: "Einrichtung abgeschlossen" });
  assert.deepEqual(parseDesktopSettingsView(fixtureSettingsView({
    notice: { code: "saved", level: "info", label: "Gespeichert" },
  })).notice, { code: "saved", level: "info", label: "Gespeichert" });
});
