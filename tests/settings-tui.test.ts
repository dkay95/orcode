import assert from "node:assert/strict";
import test from "node:test";

import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import type { SettingsViewModel } from "../src/settings-controller.js";
import type {
  SettingsCategory,
  SettingsItem,
} from "../src/settings-registry.js";
import { displayWidth } from "../src/ui/compose.js";
import {
  buildSettingsFrame,
  type SettingsFrameResult,
} from "../src/ui/settings-frame.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const CATEGORIES = [
  {
    id: "models-reasoning",
    label: "Modelle & Denken",
    description: "Route und Denkstufe",
  },
  {
    id: "providers-accounts",
    label: "Provider & Konten",
    description: "Eigene Providerzugänge",
  },
  {
    id: "security-approvals",
    label: "Sicherheit & Freigaben",
    description: "Ausführungsgrenzen",
  },
  {
    id: "costs-budgets",
    label: "Kosten & Budgets",
    description: "Ausgaben begrenzen",
  },
  {
    id: "verify-tools",
    label: "Prüfen & Werkzeuge",
    description: "Verifikation und Browser",
  },
  {
    id: "appearance",
    label: "Darstellung",
    description: "Logo und Glyphen",
  },
] as const satisfies readonly SettingsCategory[];

const ITEMS = [
  {
    id: "main-model",
    categoryId: "models-reasoning",
    label: "Hauptmodell",
    description: "Providergebundene Route wählen",
    aliases: ["private-alias-must-never-render"],
    displayValue: "openai/gpt-5.4",
    editor: { kind: "model", actionId: "main-model", filter: "main" },
    affectsActiveRun: true,
  },
  {
    id: "reasoning",
    categoryId: "models-reasoning",
    label: "Denkstufe",
    description: "Denkbudget des Hauptmodells",
    aliases: [],
    displayValue: "Hoch",
    editor: { kind: "choice", actionId: "reasoning", options: [] },
    affectsActiveRun: true,
    disabledReason: "Lauf aktiv",
  },
  {
    id: "max-steps",
    categoryId: "models-reasoning",
    label: "Max. Schritte",
    description: "Maximale Agentenschritte",
    aliases: [],
    displayValue: "24",
    editor: {
      kind: "number",
      actionId: "max-steps",
      minimum: 1,
      maximum: 100,
    },
    affectsActiveRun: true,
  },
] as const satisfies readonly SettingsItem[];

function view(overrides: Partial<SettingsViewModel> = {}): SettingsViewModel {
  return {
    categories: CATEGORIES,
    items: ITEMS,
    allItems: ITEMS,
    selectedCategoryId: "models-reasoning",
    selectedItemId: "main-model",
    search: { active: false, query: "" },
    readOnlyReason: null,
    runActive: true,
    notice: { kind: "success", message: "Gespeichert" },
    ...overrides,
  };
}

function build(
  width: number,
  height: number,
  overrides: Partial<SettingsViewModel> = {},
): SettingsFrameResult {
  return buildSettingsFrame({
    width,
    height,
    theme: createTheme({ level: 0 }),
    view: view(overrides),
    brand: {
      large: routeCoreLarge("unicode"),
      compact: routeCoreCompact("unicode"),
      visible: true,
    },
  });
}

function semanticSnapshot(result: SettingsFrameResult): string[] {
  return result.frame.lines.flatMap((value, index) => {
    const text = plainText(value);
    if (text.trim() === "") return [];
    if (/^[─-]+$/u.test(text)) {
      return [`${index + 1}:<divider:${lineWidth(value)}>`];
    }
    return [`${index + 1}:${text.trim().replace(/\s+/gu, " ")}`];
  });
}

function assertBounded(result: SettingsFrameResult, width: number, height: number): void {
  assert.equal(result.frame.lines.length, height);
  for (const [index, value] of result.frame.lines.entries()) {
    assert.equal(
      lineWidth(value) <= width - 1,
      true,
      `Zeile ${index + 1} überschreitet ${width - 1} Zellen`,
    );
    assert.doesNotMatch(plainText(value), /\u001b/u);
  }
}

const WIDE_CONTENT = [
  "1:╭────────╮ ●",
  "2:╱ ╲ ╱",
  "3:╱ ◇ ├────┤",
  "4:╲ ╱ ╲",
  "5:╰────────╯ ○",
  "6:ORCODE",
  "8:ORCODE · Einstellungen Lauf aktiv",
  "10:Bereiche │ Einstellungen · Modelle & Denken",
  "11:› 1 Modelle & Denken │ › Hauptmodell · openai/gpt-5.4",
  "12:2 Provider & Konten │ Providergebundene Route wählen",
  "13:3 Sicherheit & Freigaben │ Denkstufe · Hoch",
  "14:4 Kosten & Budgets │ Gesperrt · Lauf aktiv",
  "15:5 Prüfen & Werkzeuge │ Max. Schritte · 24",
  "16:6 Darstellung │ Maximale Agentenschritte",
] as const;

test("120x36 rendert Route Core, zwei Spalten und Zustände als Klartext-Snapshot", () => {
  const result = build(120, 36);
  assertBounded(result, 120, 36);
  assert.deepEqual(semanticSnapshot(result), [
    ...WIDE_CONTENT.slice(0, 7),
    "9:<divider:119>",
    ...WIDE_CONTENT.slice(7),
    "34:✓ Gespeichert",
    "36:↑↓ wählen · Enter ändern · / suchen · Esc zurück",
  ]);
});

test("80x24 behält das deterministische Zweispalten-Layout ohne Überlauf", () => {
  const first = build(80, 24);
  const second = build(80, 24);
  assertBounded(first, 80, 24);
  assert.deepEqual(first, second);
  assert.deepEqual(semanticSnapshot(first), [
    ...WIDE_CONTENT.slice(0, 7),
    "9:<divider:79>",
    ...WIDE_CONTENT.slice(7),
    "22:✓ Gespeichert",
    "24:↑↓ wählen · Enter ändern · / suchen · Esc zurück",
  ]);
});

test("50x16 stapelt Bereiche und Einstellungen mit kompakter Marke", () => {
  const result = build(50, 16);
  assertBounded(result, 50, 16);
  assert.deepEqual(semanticSnapshot(result), [
    "1:⬡─┤●○ ORCODE · Einstellungen Lauf aktiv",
    "2:<divider:49>",
    "3:Bereiche",
    "4:› 1 Modelle & Denken",
    "5:2 Provider & Konten",
    "6:3 Sicherheit & Freigaben",
    "7:Einstellungen · Modelle & Denken",
    "8:› Hauptmodell · openai/gpt-5.4",
    "9:Providergebundene Route wählen",
    "10:Denkstufe · Hoch",
    "11:Gesperrt · Lauf aktiv",
    "12:Max. Schritte · 24",
    "13:Maximale Agentenschritte",
    "14:✓ Gespeichert",
    "16:↑↓ wählen · Enter ändern · / suchen · Esc zurück",
  ]);
});

test("39x7 liefert ausschließlich eine begrenzte Resize-Meldung", () => {
  const result = build(39, 7);
  assert.deepEqual(semanticSnapshot(result), [
    "1:Fenster vergrößern · mindestens 40×8",
  ]);
  assert.equal(result.frame.lines.length, 1);
  assert.equal(lineWidth(result.frame.lines[0]!), 36);
  assert.deepEqual(result.frame.cursor, { row: 1, col: 1 });
  assert.equal(result.frame.chatHeight, 0);
  assert.equal(result.frame.maxScrollOffset, 0);
  assert.deepEqual(result.hitTargets, []);
});

test("Suche ersetzt die normale Liste und behält Kontext, Fehler und eigenen Footer", () => {
  const result = build(80, 24, {
    items: [ITEMS[2]],
    selectedItemId: "max-steps",
    search: { active: true, query: "schritt" },
    notice: { kind: "error", message: "Suche nicht verfügbar" },
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  assert.match(rendered, /ORCODE · Einstellungen/u);
  assert.match(rendered, /Suche · "schritt"/u);
  assert.match(rendered, /Max\. Schritte · 24/u);
  assert.doesNotMatch(rendered, /Hauptmodell|Denkstufe/u);
  assert.match(rendered, /✗ Suche nicht verfügbar/u);
  assert.equal(
    plainText(result.frame.lines.at(-1)!),
    "Suche · ↑↓ wählen · Enter ändern · Esc zurück",
  );
  assertBounded(result, 80, 24);
});

test("ausgeblendetes Branding entfernt beide Marken, aber nicht den Fenstertitel", () => {
  const result = buildSettingsFrame({
    width: 50,
    height: 16,
    theme: createTheme({ level: 0 }),
    view: view(),
    brand: {
      large: routeCoreLarge("unicode"),
      compact: routeCoreCompact("unicode"),
      visible: false,
    },
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  assert.match(rendered, /ORCODE · Einstellungen/u);
  assert.doesNotMatch(rendered, /⬡─┤●○|╭────────╮/u);
});

test("Hit-Targets sind 1-basiert, inklusiv und existieren nur für sichtbare Zeilen", () => {
  const result = build(50, 16);
  const plain = result.frame.lines.map(plainText);
  assert.equal(result.hitTargets.length, 6);
  assert.deepEqual(
    result.hitTargets.map((target) => target.intent),
    [
      { kind: "category", categoryId: "models-reasoning" },
      { kind: "category", categoryId: "providers-accounts" },
      { kind: "category", categoryId: "security-approvals" },
      { kind: "select-item", itemId: "main-model" },
      { kind: "select-item", itemId: "reasoning" },
      { kind: "select-item", itemId: "max-steps" },
    ],
  );
  for (const target of result.hitTargets) {
    assert.deepEqual(Object.keys(target), [
      "row",
      "columnStart",
      "columnEnd",
      "intent",
    ]);
    assert.equal(target.row >= 1 && target.row <= result.frame.lines.length, true);
    assert.equal(target.columnStart >= 1, true);
    assert.equal(target.columnEnd >= target.columnStart, true);
    assert.equal(target.columnEnd <= 49, true);
    const visibleText = plain[target.row - 1]!;
    const selectedText = Array.from(visibleText)
      .slice(target.columnStart - 1, target.columnEnd)
      .join("");
    assert.equal(selectedText.trim() !== "", true);
  }
  assert.deepEqual(result.frame.cursor, {
    row: 8,
    col: result.hitTargets[3]!.columnStart,
  });
});

test("Frame bleibt ANSI-frei, width-sicher und gibt weder Aliase noch Kontrollcodes aus", () => {
  const maliciousItem: SettingsItem = {
    ...ITEMS[0],
    label: "主modell 👩‍💻 e\u0301 \u001b[31m",
    description: "界".repeat(80),
    displayValue: "Wert",
    aliases: ["top-secret-token"],
  };
  const result = buildSettingsFrame({
    width: 50,
    height: 16,
    theme: createTheme({ level: 3 }),
    view: view({
      items: [maliciousItem],
      allItems: [maliciousItem],
      selectedItemId: "main-model",
      notice: { kind: "info", message: "Hinweis\u001b[2J" },
    }),
    brand: {
      large: ["\u001b[31m fremd"],
      compact: "⬡─┤●○\u001b[0m",
      visible: true,
    },
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  for (const value of result.frame.lines) {
    assert.doesNotMatch(plainText(value), /[\u0000-\u001f\u007f-\u009f]/u);
  }
  assert.doesNotMatch(rendered, /top-secret-token|private-alias-must-never-render/u);
  assert.match(rendered, /👩‍💻/u);
  for (const value of result.frame.lines) {
    assert.equal(lineWidth(value) <= 49, true);
  }
});

test("Farbstufe 0 und 3 erzeugen vor dem Renderer identische Klartextgeometrie", () => {
  const input = {
    width: 80,
    height: 24,
    view: view(),
    brand: {
      large: routeCoreLarge("unicode"),
      compact: routeCoreCompact("unicode"),
      visible: true,
    },
  } as const;
  const plain = buildSettingsFrame({ ...input, theme: createTheme({ level: 0 }) });
  const colored = buildSettingsFrame({ ...input, theme: createTheme({ level: 3 }) });
  assert.deepEqual(
    colored.frame.lines.map(plainText),
    plain.frame.lines.map(plainText),
  );
  assert.deepEqual(colored.hitTargets, plain.hitTargets);
  assert.equal(
    colored.frame.lines.some((value) => plainText(value).includes("\u001b")),
    false,
  );
});

test("jede gerenderte Zeile verwendet displayWidth statt JavaScript-Länge", () => {
  const result = build(50, 16, {
    notice: { kind: "info", message: "界界界 👨‍👩‍👧‍👦 e\u0301" },
  });
  for (const value of result.frame.lines) {
    const text = plainText(value);
    assert.equal(lineWidth(value), displayWidth(text));
    assert.equal(displayWidth(text) <= 49, true);
  }
});

test("lange Listen fenstern in Wide, Stack und Suche paarweise um das selektierte Item", () => {
  const laterItems = [
    {
      ...ITEMS[0],
      id: "compression-mode",
      label: "Kompression",
      displayValue: "Automatisch",
      editor: { kind: "readonly" },
    },
    {
      ...ITEMS[0],
      id: "compressor-model",
      label: "Kompressor-Modell",
      displayValue: "openai/gpt-5.4-mini",
      editor: { kind: "readonly" },
    },
    {
      ...ITEMS[0],
      id: "current-route",
      label: "Aktuelle Route",
      description: "Die aktuell gebundene Sessionroute",
      displayValue: "OpenAI",
      editor: { kind: "readonly" },
      disabledReason: "Lauf aktiv",
    },
  ] as const satisfies readonly SettingsItem[];
  const allItems = [...ITEMS, ...laterItems];

  for (const [width, height, search] of [
    [80, 24, false],
    [50, 16, false],
    [80, 24, true],
  ] as const) {
    const result = build(width, height, {
      items: allItems,
      allItems,
      selectedItemId: "current-route",
      search: { active: search, query: search ? "route" : "" },
    });
    const rendered = result.frame.lines.map(plainText).join("\n");
    assert.match(rendered, /› Aktuelle Route · OpenAI/u, `${width}x${height}`);
    assert.match(rendered, /Gesperrt · Lauf aktiv/u, `${width}x${height}`);
    assert.doesNotMatch(rendered, /Hauptmodell/u, `${width}x${height}`);
    assert.equal(
      result.hitTargets.some(
        (target) => target.intent.kind === "select-item"
          && target.intent.itemId === "current-route",
      ),
      true,
      `${width}x${height}`,
    );
    assertBounded(result, width, height);
  }
});

test("Stack-Fenster hält Bereich 6 samt ausgewähltem Item sichtbar", () => {
  const appearanceItem: SettingsItem = {
    ...ITEMS[0],
    id: "appearance-large-logo",
    categoryId: "appearance",
    label: "Großes Logo",
    description: "Route Core im Titelbereich anzeigen",
    displayValue: "An",
    editor: { kind: "readonly" },
  };
  const result = build(50, 16, {
    items: [appearanceItem],
    allItems: [appearanceItem],
    selectedCategoryId: "appearance",
    selectedItemId: "appearance-large-logo",
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  assert.match(rendered, /› 6 Darstellung/u);
  assert.match(rendered, /› Großes Logo · An/u);
  assert.equal(
    result.hitTargets.some(
      (target) => target.intent.kind === "category"
        && target.intent.categoryId === "appearance",
    ),
    true,
  );
});

test("40x8 zeigt im kompakten gültigen Frame Auswahl und Disabled-Zustand", () => {
  const result = build(40, 8, {
    items: [ITEMS[1]],
    allItems: [ITEMS[1]],
    selectedItemId: "reasoning",
  });
  assertBounded(result, 40, 8);
  assert.deepEqual(semanticSnapshot(result), [
    "1:⬡─┤●○ ORCODE · Einstellungen",
    "2:<divider:39>",
    "3:› 1 Modelle & Denken",
    "4:› Denkstufe · Hoch",
    "5:Gesperrt · Lauf aktiv",
    "6:✓ Gespeichert",
    "8:↑↓ · Enter · / Suche · Esc zurück",
  ]);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
  assert.equal(result.hitTargets.length, 2);
});

test("50x16 zeigt den globalen Schreibschutz auch ohne Farbe im Titel", () => {
  const result = build(50, 16, {
    readOnlyReason: "Konfiguration schreibgeschützt",
    runActive: false,
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  assert.match(rendered, /Schreibgeschützt/u);
  assertBounded(result, 50, 16);
});

test("40x8 Suche behält Query, selektiertes Ergebnis und Disabled-Grund", () => {
  const result = build(40, 8, {
    items: [ITEMS[1]],
    allItems: [ITEMS[1]],
    selectedItemId: "reasoning",
    search: { active: true, query: "denk" },
  });
  assertBounded(result, 40, 8);
  assert.deepEqual(semanticSnapshot(result), [
    "1:⬡─┤●○ ORCODE · Einstellungen",
    "2:<divider:39>",
    "3:› Suche · \"denk\" · 1 Modelle & Denken",
    "4:› Denkstufe · Hoch",
    "5:Gesperrt · Lauf aktiv",
    "6:✓ Gespeichert",
    "8:Suche · ↑↓ · Enter · Esc zurück",
  ]);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
  assert.equal(result.hitTargets.length, 2);
});
