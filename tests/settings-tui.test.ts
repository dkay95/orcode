import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";

import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import type {
  SettingsController,
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "../src/settings-controller.js";
import { runSettingsSession } from "../src/settings-session.js";
import {
  TerminalUi,
  type DashboardState,
  type TerminalUiOptions,
} from "../src/tui.js";
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
import type { ModelInfo } from "../src/types.js";

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

const DASHBOARD_STATE: DashboardState = {
  workspace: "/workspace",
  model: "openrouter/auto",
  approval: "ask",
  compressor: "auto",
  compressorModel: "openrouter/auto",
  reasoning: "auto",
  balance: "unbekannt",
  sessionCost: "$0.00",
  maxCost: "$1.00",
  maxSteps: 12,
  keyStatus: "im Speicher",
};

class SettingsFakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class SettingsFakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  output = "";

  write(value: string | Uint8Array): boolean {
    this.output += value.toString();
    return true;
  }
}

function settingsUi(options: TerminalUiOptions = {}): {
  readonly terminal: TerminalUi;
  readonly stdin: SettingsFakeInput;
  readonly stdout: SettingsFakeOutput;
} {
  const stdin = new SettingsFakeInput();
  const stdout = new SettingsFakeOutput();
  return {
    terminal: new TerminalUi(
      () => DASHBOARD_STATE,
      stdin as unknown as ReadStream,
      stdout as unknown as WriteStream,
      createTheme({ level: 0 }),
      options,
    ),
    stdin,
    stdout,
  };
}

function cachedModel(id: string): ModelInfo {
  return {
    id,
    name: id,
    description: `${id} cached`,
    contextLength: 128_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}

function editorRequest(
  editor: SettingsEditorRequest["editor"],
  overrides: Partial<SettingsEditorRequest> = {},
): SettingsEditorRequest {
  return {
    generation: 1,
    categoryId: "models-reasoning",
    itemId: "reasoning",
    label: "Denkstufe",
    description: "Denkbudget wählen",
    editor,
    ...overrides,
  };
}

function pressSettings(
  stdin: SettingsFakeInput,
  name: string,
  character = "",
  extra: Record<string, unknown> = {},
): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false, ...extra });
}

function emitSettingsData(stdin: SettingsFakeInput, value: string): void {
  stdin.emit("data", Buffer.from(value));
}

test("Settings ist eine eigene Surface und lässt den Chat-Entwurf bytegleich", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  const pendingChat = terminal.readInput();
  for (const character of "draft") pressSettings(stdin, character, character);
  pressSettings(stdin, "left");

  terminal.begin(view());
  const settingsText = terminal.frame().lines.map(plainText).join("\n");
  assert.match(settingsText, /ORCODE · Einstellungen/u);
  assert.doesNotMatch(settingsText, /draft/u);

  const intent = terminal.nextIntent(view());
  pressSettings(stdin, "down");
  assert.deepEqual(await intent, { kind: "move", delta: 1 });

  terminal.end();
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /draft/u);
  pressSettings(stdin, "return");
  assert.equal(await pendingChat, "draft");
  terminal.stop();
});

test("Kategorie und Suche liefern sequenzielle Intents ohne Chat-Puffer zu benutzen", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  const pendingChat = terminal.readInput();
  for (const character of "unberührt") pressSettings(stdin, character, character);
  terminal.begin(view());

  const category = terminal.nextIntent(view());
  pressSettings(stdin, "6", "6");
  assert.deepEqual(await category, { kind: "category", categoryId: "appearance" });

  const appearanceView = view({ selectedCategoryId: "appearance" });
  const searchStart = terminal.nextIntent(appearanceView);
  pressSettings(stdin, "/", "/");
  assert.deepEqual(await searchStart, { kind: "search-start" });

  const emptySearch = view({
    selectedCategoryId: "appearance",
    search: { active: true, query: "" },
  });
  const firstCharacter = terminal.nextIntent(emptySearch);
  pressSettings(stdin, "k", "k");
  assert.deepEqual(await firstCharacter, { kind: "search-change", query: "k" });

  const oneCharacter = view({
    selectedCategoryId: "appearance",
    search: { active: true, query: "k" },
  });
  const digit = terminal.nextIntent(oneCharacter);
  pressSettings(stdin, "3", "3");
  assert.deepEqual(await digit, { kind: "search-change", query: "k3" });

  const withDigit = view({
    selectedCategoryId: "appearance",
    search: { active: true, query: "k3" },
  });
  const erased = terminal.nextIntent(withDigit);
  pressSettings(stdin, "backspace");
  assert.deepEqual(await erased, { kind: "search-change", query: "k" });

  const boundedView = view({
    selectedCategoryId: "appearance",
    search: { active: true, query: "a".repeat(120) },
  });
  let boundedSettled = false;
  const bounded = terminal.nextIntent(boundedView).then((value) => {
    boundedSettled = true;
    return value;
  });
  pressSettings(stdin, "z", "z");
  await Promise.resolve();
  assert.equal(boundedSettled, false);
  pressSettings(stdin, "backspace");
  assert.deepEqual(await bounded, {
    kind: "search-change",
    query: "a".repeat(119),
  });

  terminal.end();
  pressSettings(stdin, "return");
  assert.equal(await pendingChat, "unberührt");
  terminal.stop();
});

test("ein gebatchter Settings-Datenblock bleibt geordnet bis zum nächsten Intent erhalten", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view({ search: { active: true, query: "" } }));
  const observed: SettingsIntent[] = [];
  try {
    const first = terminal.nextIntent(view({ search: { active: true, query: "" } }));
    stdin.emit("data", Buffer.from("abc"));
    observed.push(await first);

    for (const query of ["a", "ab"] as const) {
      const pending = terminal.nextIntent(view({ search: { active: true, query } }));
      const result = await Promise.race([
        pending.then((intent) => ({ settled: true as const, intent })),
        new Promise<{ settled: false }>((resolve) => setImmediate(() => resolve({ settled: false }))),
      ]);
      if (!result.settled) {
        terminal.end();
        await pending.catch(() => undefined);
        break;
      }
      observed.push(result.intent);
    }
  } finally {
    terminal.end();
    terminal.stop();
  }
  assert.deepEqual(observed, [
    { kind: "search-change", query: "a" },
    { kind: "search-change", query: "ab" },
    { kind: "search-change", query: "abc" },
  ]);
});

test("Settings-Eingabepuffer ist deterministisch auf 128 Folgeereignisse begrenzt", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const first = terminal.nextIntent(view());
  for (let index = 0; index < 141; index += 1) pressSettings(stdin, "down");
  let delivered = 0;
  try {
    assert.deepEqual(await first, { kind: "move", delta: 1 });
    delivered += 1;
    for (let index = 0; index < 128; index += 1) {
      assert.deepEqual(await terminal.nextIntent(view()), { kind: "move", delta: 1 });
      delivered += 1;
    }
    const overflow = terminal.nextIntent(view());
    const settled = await Promise.race([
      overflow.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(settled, false);
    terminal.end();
    await overflow.catch(() => undefined);
  } finally {
    terminal.end();
    terminal.stop();
  }
  assert.equal(delivered, 129);
});

test("ein lokaler Cursor-Key blockiert dahinter gepufferte Settings-Zeichen nicht", async () => {
  const initial = view({ search: { active: true, query: "a" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  try {
    const first = terminal.nextIntent(initial);
    stdin.emit("data", Buffer.from("b\u001b[Dx"));
    assert.deepEqual(await first, { kind: "search-change", query: "ab" });

    const second = terminal.nextIntent(view({ search: { active: true, query: "ab" } }));
    const result = await Promise.race([
      second.then((intent) => ({ settled: true as const, intent })),
      new Promise<{ settled: false }>((resolve) => setImmediate(() => resolve({ settled: false }))),
    ]);
    assert.deepEqual(result, {
      settled: true,
      intent: { kind: "search-change", query: "axb" },
    });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("Settings-Suchpaste zwischen zwei Intents wird als ein begrenztes Folgeereignis erhalten", async () => {
  const initial = view({ search: { active: true, query: "a" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  try {
    const first = terminal.nextIntent(initial);
    pressSettings(stdin, "b", "b");
    pressSettings(stdin, "paste-start");
    pressSettings(stdin, "c", "c");
    pressSettings(stdin, "d", "d");
    pressSettings(stdin, "paste-end");
    assert.deepEqual(await first, { kind: "search-change", query: "ab" });
    assert.deepEqual(
      await terminal.nextIntent(view({ search: { active: true, query: "ab" } })),
      { kind: "search-change", query: "abcd" },
    );
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("runSettingsSession übergibt Raw-Folgekeys nach Activate exakt einmal an den neuen Editor", async (context) => {
  const cases: Array<{
    readonly name: string;
    readonly raw: string;
    readonly request: SettingsEditorRequest;
    readonly expected: SettingsEditorResult;
    readonly options?: TerminalUiOptions;
  }> = [
    {
      name: "text",
      raw: "\rabc\r",
      request: editorRequest({ kind: "text", actionId: "browser-path", valueKind: "path" }),
      expected: { kind: "value", value: "abc" },
    },
    {
      name: "choice",
      raw: "\rb\r",
      request: editorRequest({
        kind: "choice",
        actionId: "reasoning",
        options: [
          { value: "a", label: "Alpha", description: "A" },
          { value: "b", label: "Beta", description: "B" },
        ],
      }),
      expected: { kind: "value", value: "b" },
    },
    {
      name: "model",
      raw: "\rb\r",
      request: editorRequest({ kind: "model", actionId: "main-model", filter: "main" }),
      expected: { kind: "value", value: "model/b" },
      options: {
        settingsEditorResolver: {
          searchModels: (_request, query) => [cachedModel("model/a"), cachedModel("model/b")]
            .filter(({ id }) => id.includes(query)),
        },
      },
    },
    {
      name: "confirm",
      raw: "\ry",
      request: editorRequest({ kind: "confirm", actionId: "verify-clear", destructive: true }),
      expected: { kind: "value", value: true },
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const { terminal, stdin } = settingsUi(scenario.options);
      terminal.start();
      const chat = terminal.readInput();
      for (const character of "chat-draft") pressSettings(stdin, character, character);
      let completed: SettingsEditorResult | null = null;
      const controller = {
        get view() { return view({ runActive: false }); },
        async dispatch(intent: SettingsIntent) {
          assert.deepEqual(intent, { kind: "activate" });
          return { kind: "edit", request: scenario.request } as const;
        },
        async completeEditor(_request: SettingsEditorRequest, result: SettingsEditorResult) {
          completed = result;
          return { kind: "close" } as const;
        },
      } as unknown as SettingsController;
      let settled = false;
      const session = runSettingsSession(controller, terminal).then(() => {
        settled = true;
      });
      stdin.emit("data", Buffer.from(scenario.raw));
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!settled) terminal.end();
      await session;
      assert.deepEqual(completed, scenario.expected);
      pressSettings(stdin, "return");
      assert.equal(await chat, "chat-draft");
      terminal.stop();
    });
  }
});

test("lokaler Settings-Suchcursor bleibt über den bestätigten Controller-Refresh erhalten", async () => {
  const initial = view({ search: { active: true, query: "ac" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  try {
    const first = terminal.nextIntent(initial);
    stdin.emit("data", Buffer.from("\u001b[Dbx"));
    assert.deepEqual(await first, { kind: "search-change", query: "abc" });
    assert.deepEqual(
      await terminal.nextIntent(view({ search: { active: true, query: "abc" } })),
      { kind: "search-change", query: "abxc" },
    );
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("gepufferte Settings-Nutzlast wird vor Speicherung auf 120 Codepoints normalisiert", async () => {
  const initial = view({ search: { active: true, query: "" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  let sequenceReads = 0;
  const key = { name: "x", ctrl: false, meta: false } as Record<string, unknown>;
  Object.defineProperty(key, "sequence", {
    enumerable: true,
    get() {
      sequenceReads += 1;
      return "secret-retained-payload".repeat(10_000);
    },
  });
  try {
    stdin.emit("keypress", "x".repeat(1_000_000), key);
    assert.equal(sequenceReads, 0);
    assert.deepEqual(await terminal.nextIntent(initial), {
      kind: "search-change",
      query: "x".repeat(120),
    });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("Settings-Maus nutzt ausschließlich den letzten inklusiven Hit-Target", async () => {
  const { terminal, stdin, stdout } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const rendered = build(80, 24);
  const target = rendered.hitTargets.find(
    ({ intent }) => intent.kind === "select-item" && intent.itemId === "main-model",
  );
  assert.ok(target);

  let settled = false;
  const pending = terminal.nextIntent(view()).then((intent) => {
    settled = true;
    return intent;
  });
  terminal.frame();
  emitSettingsData(stdin, `\u001b[<0;${target.columnStart};${target.row}m`);
  emitSettingsData(stdin, `\u001b[<2;${target.columnStart};${target.row}M`);
  emitSettingsData(stdin, `\u001b[<0;${stdout.columns + 1};${target.row}M`);
  await Promise.resolve();
  assert.equal(settled, false);

  emitSettingsData(stdin, `\u001b[<0;${target.columnEnd};${target.row}M`);
  assert.deepEqual(await pending, { kind: "select-item", itemId: "main-model" });
  terminal.end();
  terminal.stop();
});

test("SGR Press und Release bleiben nach dem Schließen eines Pickers vollständig unterdrückt", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  try {
    const picked = terminal.pickChoice("Provider", [
      { value: "a", label: "Alpha", description: "A" },
      { value: "b", label: "Beta", description: "B" },
    ], "a");
    const row = terminal.frame().lines.findIndex(
      (line) => plainText(line).includes("Beta"),
    ) + 1;
    assert.ok(row > 0);

    stdin.emit(
      "data",
      Buffer.from(`\u001b[<0;1;${row}M\u001b[<0;1;${row}m`),
    );
    assert.equal((await picked)?.value, "b");

    const chat = terminal.readInput();
    pressSettings(stdin, "return");
    assert.equal(await chat, "");
  } finally {
    terminal.stop();
  }
});

test("partielles SGR Release bleibt über Picker zu Secret vollständig unterdrückt", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  try {
    const picked = terminal.pickChoice("Provider", [
      { value: "a", label: "Alpha", description: "A" },
      { value: "b", label: "Beta", description: "B" },
    ], "a");
    const row = terminal.frame().lines.findIndex(
      (line) => plainText(line).includes("Beta"),
    ) + 1;
    assert.ok(row > 0);

    stdin.emit(
      "data",
      Buffer.from(`\u001b[<0;1;${row}M\u001b[<0;1;`),
    );
    assert.equal((await picked)?.value, "b");

    const secret = terminal.readSecret("Provider-Key");
    stdin.emit("data", Buffer.from(`${row}m`));
    pressSettings(stdin, "return");
    assert.equal(await secret, "");
  } finally {
    terminal.stop();
  }
});

test("zweites ausstehendes Settings-Intent scheitert geschlossen zurück zum Chat", async () => {
  const { terminal } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const first = terminal.nextIntent(view());
  const firstFailure = assert.rejects(first, /nur eine Settings-Eingabe/u);
  await assert.rejects(terminal.nextIntent(view()), /nur eine Settings-Eingabe/u);
  await firstFailure;
  assert.doesNotMatch(
    terminal.frame().lines.map(plainText).join("\n"),
    /ORCODE · Einstellungen/u,
  );
  terminal.stop();
});

test("Resize auf unter Mindestgröße bleibt während Settings begrenzt", () => {
  const { terminal, stdout } = settingsUi();
  terminal.start();
  terminal.begin(view());
  stdout.columns = 39;
  stdout.rows = 7;
  const frame = terminal.frame();
  assert.equal(frame.lines.length, 1);
  assert.match(plainText(frame.lines[0]!), /Fenster vergrößern/u);
  terminal.end();
  terminal.stop();
});

test("Choice-Editor übernimmt und Esc kehrt zur exakt gleichen Settings-Zeile zurück", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const request = editorRequest({
    kind: "choice",
    actionId: "reasoning",
    options: [
      { value: "low", label: "Niedrig", description: "kurz" },
      { value: "high", label: "Hoch", description: "gründlich" },
    ],
  }, { initialValue: "low" });

  const chosen = terminal.edit(request);
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");
  assert.deepEqual(await chosen, { kind: "value", value: "high" });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Hauptmodell/u);

  const cancelled = terminal.edit(request);
  pressSettings(stdin, "escape");
  assert.deepEqual(await cancelled, { kind: "cancel" });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Hauptmodell/u);
  terminal.end();
  terminal.stop();
});

test("Model-Resolver liest nur Cache synchron und Panel-Multi toggelt mit Space", async () => {
  const models = [cachedModel("model/a"), cachedModel("model/b")];
  const queries: string[] = [];
  const { terminal, stdin } = settingsUi({
    settingsEditorResolver: {
      searchModels(_request, query) {
        queries.push(query);
        return models.filter(({ id }) => id.includes(query));
      },
    },
  });
  terminal.start();
  terminal.begin(view());

  const single = terminal.edit(editorRequest({
    kind: "model",
    actionId: "main-model",
    filter: "main",
  }, { itemId: "main-model", initialValue: "model/a" }));
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");
  assert.deepEqual(await single, { kind: "value", value: "model/b" });

  const multi = terminal.edit(editorRequest({
    kind: "model",
    actionId: "panel-models",
    filter: "panel",
    multiple: true,
  }, { itemId: "panel-models", initialValue: ["model/a"] }));
  pressSettings(stdin, "down");
  pressSettings(stdin, "space", " ");
  pressSettings(stdin, "return");
  assert.deepEqual(await multi, { kind: "value", value: ["model/a", "model/b"] });
  assert.deepEqual(queries, ["", ""]);
  terminal.end();
  terminal.stop();
});

test("Picker-Cachefehler bleibt begrenzt neben der letzten nutzbaren Liste und wird danach gelöscht", async () => {
  const models = Array.from({ length: 6 }, (_, index) => cachedModel(`model/${index + 1}`));
  const { terminal, stdin, stdout } = settingsUi({
    settingsEditorResolver: {
      searchModels(_request, query) {
        if (query === "x") throw new Error("cache offline");
        return models;
      },
    },
  });
  terminal.start();
  terminal.begin(view());
  const editor = terminal.edit(editorRequest({
    kind: "model",
    actionId: "main-model",
    filter: "main",
  }, { itemId: "main-model", initialValue: "model/1" }));
  try {
    pressSettings(stdin, "x", "x");
    const failed = terminal.frame();
    const failedText = failed.lines.map(plainText).join("\n");
    assert.match(failedText, /Modellcache konnte nicht gelesen werden/u);
    assert.match(failedText, /model\/1/u);
    assert.equal(failed.lines.length, stdout.rows);
    for (const line of failed.lines) assert.ok(lineWidth(line) <= stdout.columns - 1);

    pressSettings(stdin, "backspace");
    const recoveredText = terminal.frame().lines.map(plainText).join("\n");
    assert.doesNotMatch(recoveredText, /Modellcache konnte nicht gelesen werden/u);
    assert.match(recoveredText, /model\/1/u);
  } finally {
    pressSettings(stdin, "escape");
    await editor;
    terminal.end();
    terminal.stop();
  }
});

test("sechstes Panel-Modell zeigt den Pickerfehler und ein erfolgreicher Deselect löscht ihn", async () => {
  const models = Array.from({ length: 6 }, (_, index) => cachedModel(`model/${index + 1}`));
  const { terminal, stdin } = settingsUi({
    settingsEditorResolver: { searchModels: () => models },
  });
  terminal.start();
  terminal.begin(view());
  const editor = terminal.edit(editorRequest({
    kind: "model",
    actionId: "panel-models",
    filter: "panel",
    multiple: true,
  }, {
    itemId: "panel-models",
    initialValue: models.slice(0, 5).map(({ id }) => id),
  }));
  try {
    for (let index = 0; index < 5; index += 1) pressSettings(stdin, "down");
    pressSettings(stdin, "space", " ");
    const blocked = terminal.frame().lines.map(plainText).join("\n");
    assert.match(blocked, /Höchstens fünf Panel-Modelle/u);
    assert.match(blocked, /model\/6/u);

    pressSettings(stdin, "up");
    pressSettings(stdin, "space", " ");
    assert.doesNotMatch(
      terminal.frame().lines.map(plainText).join("\n"),
      /Höchstens fünf Panel-Modelle/u,
    );
  } finally {
    pressSettings(stdin, "escape");
    await editor;
    terminal.end();
    terminal.stop();
  }
});

test("validierter Zahl- und Texteditor behalten Fehleingabe lokal", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());

  const number = terminal.edit(editorRequest({
    kind: "number",
    actionId: "max-steps",
    minimum: 1,
    maximum: 100,
  }, { itemId: "max-steps", initialValue: "" }));
  for (const character of "101") pressSettings(stdin, character, character);
  pressSettings(stdin, "return");
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /1.*100/u);
  pressSettings(stdin, "u", "", { ctrl: true });
  for (const character of "12") pressSettings(stdin, character, character);
  pressSettings(stdin, "return");
  assert.deepEqual(await number, { kind: "value", value: 12 });

  const path = terminal.edit(editorRequest({
    kind: "text",
    actionId: "browser-path",
    valueKind: "path",
  }, { itemId: "browser-path", initialValue: "" }));
  for (const character of "/opt/browser") pressSettings(stdin, character, character);
  pressSettings(stdin, "return");
  assert.deepEqual(await path, { kind: "value", value: "/opt/browser" });
  terminal.end();
  terminal.stop();
});

test("Settings-Bestätigung ist ViewModel-frei und Enter bestätigt", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.addMessage("assistant", "Chat bleibt erhalten");
  const chatDraft = terminal.readInput();
  for (const character of "private-confirm-draft") {
    pressSettings(stdin, character, character);
  }
  terminal.begin(view());
  const confirmation = terminal.edit(editorRequest({
    kind: "confirm",
    actionId: "verify-clear",
    destructive: true,
  }, {
    itemId: "verify-clear",
    label: "Prüfbefehle löschen",
    description: "Alle lokalen Prüfbefehle entfernen",
  }));
  const nested = terminal.frame().lines.map(plainText).join("\n");
  assert.match(nested, /Prüfbefehle löschen/u);
  assert.doesNotMatch(nested, /SHELL/u);
  assert.doesNotMatch(nested, /private-confirm-draft/u);
  pressSettings(stdin, "paste-start");
  for (const character of "must-not-touch-chat") {
    pressSettings(stdin, character, character);
  }
  pressSettings(stdin, "paste-end");
  pressSettings(stdin, "return");
  assert.deepEqual(await confirmation, { kind: "value", value: true });
  assert.deepEqual(await terminal.edit(editorRequest({
    kind: "invoke",
    actionId: "verify-suggest",
  }, { itemId: "verify-suggest", label: "Vorschläge" })), {
    kind: "value",
    value: true,
  });
  terminal.end();
  const restored = terminal.frame().lines.map(plainText).join("\n");
  assert.match(restored, /Chat bleibt erhalten/u);
  assert.doesNotMatch(restored, /Prüfbefehle löschen/u);
  pressSettings(stdin, "return");
  assert.equal(await chatDraft, "private-confirm-draft");
  terminal.stop();
});

test("Settings-Maus ist über suspend, resume, end und stop exakt balanciert", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const { terminal, stdout } = settingsUi();
  terminal.start();
  terminal.begin(view());
  await terminal.suspend(async () => undefined);
  terminal.end();
  terminal.stop();
  assert.equal(stdout.output.split(enable).length - 1, 2, stdout.output);
  assert.equal(stdout.output.split(disable).length - 1, 2, stdout.output);
});

test("stop und end settlen Settings-Intent und verschachtelten Editor genau einmal", async () => {
  const { terminal } = settingsUi();
  terminal.start();
  terminal.begin(view());
  let intentSettlements = 0;
  const intent = terminal.nextIntent(view()).catch((error: unknown) => {
    intentSettlements += 1;
    throw error;
  });
  const rejected = assert.rejects(intent, /orcode wurde beendet/u);
  terminal.stop();
  await rejected;
  assert.equal(intentSettlements, 1);

  terminal.start();
  terminal.begin(view());
  let editorSettlements = 0;
  const editor = terminal.edit(editorRequest({
    kind: "text",
    actionId: "browser-path",
    valueKind: "path",
  })).then((result) => {
    editorSettlements += 1;
    return result;
  });
  terminal.end();
  assert.deepEqual(await editor, { kind: "cancel" });
  assert.equal(editorSettlements, 1);
  terminal.stop();
});

test("applyAppearance wechselt live, aber ORCODE_ASCII bleibt dominant", () => {
  const factoryCalls: boolean[] = [];
  const options: TerminalUiOptions = {
    environment: { LANG: "de_DE.UTF-8" },
    themeFactory({ ascii }) {
      factoryCalls.push(ascii);
      return createTheme({ level: 0, ascii });
    },
  };
  const { terminal } = settingsUi(options);
  terminal.start();
  terminal.begin(view());
  terminal.applyAppearance({
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "ascii",
  });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /\+----\+/u);
  terminal.applyAppearance({
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "unicode",
  });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /◇/u);
  assert.deepEqual(factoryCalls, [true, false]);
  terminal.end();
  terminal.stop();

  const overridden = settingsUi({
    environment: { ORCODE_ASCII: "1", LANG: "de_DE.UTF-8" },
    themeFactory: options.themeFactory,
  }).terminal;
  overridden.start();
  overridden.begin(view());
  overridden.applyAppearance({
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "unicode",
  });
  const overriddenText = overridden.frame().lines.map(plainText).join("\n");
  assert.match(overriddenText, /\+----\+/u);
  assert.doesNotMatch(overriddenText, /◇/u);
  overridden.end();
  overridden.stop();
});

test("applyAppearance bewahrt die Farbstufe eines explizit injizierten Themes", () => {
  const stdin = new SettingsFakeInput();
  const stdout = new SettingsFakeOutput();
  const terminal = new TerminalUi(
    () => DASHBOARD_STATE,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    createTheme({ level: 3 }),
    { environment: { LANG: "de_DE.UTF-8" } },
  );
  terminal.start();
  terminal.begin(view());
  stdout.output = "";
  terminal.applyAppearance({
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "ascii",
  });
  assert.match(stdout.output, /\u001b\[38;2;/u);
  terminal.end();
  terminal.stop();
});

test("Settings-Rundreise bewahrt Draft-Cursor, Anhänge, Viewport und externen Route-State bytegleich", async () => {
  const { terminal, stdin } = settingsUi();
  const routeState = { selectedChatId: "chat-7", routeId: "route-private" };
  const routeBefore = JSON.stringify(routeState);
  let loadTurnsCalls = 0;
  const originalLoadTurns = terminal.loadTurns.bind(terminal);
  terminal.loadTurns = (...args) => {
    loadTurnsCalls += 1;
    return originalLoadTurns(...args);
  };
  terminal.start();
  const pendingChat = terminal.readInput();
  for (const character of "draft-byte") pressSettings(stdin, character, character);
  pressSettings(stdin, "left");
  pressSettings(stdin, "left");
  terminal.setImageAttachments([{
    path: "/tmp/private.png",
    name: "private.png",
    mimeType: "image/png",
    sizeBytes: 128,
  }]);
  for (let index = 0; index < 14; index += 1) {
    terminal.addMessage("assistant", `Antwort ${index} ${"lang ".repeat(12)}`);
  }
  terminal.render(true);
  pressSettings(stdin, "pageup");
  const before = terminal.frame();

  terminal.begin(view());
  const move = terminal.nextIntent(view());
  pressSettings(stdin, "down");
  assert.deepEqual(await move, { kind: "move", delta: 1 });
  terminal.end();

  assert.deepEqual(terminal.frame(), before);
  assert.equal(loadTurnsCalls, 0);
  assert.equal(JSON.stringify(routeState), routeBefore);
  pressSettings(stdin, "end");
  pressSettings(stdin, "return");
  assert.equal(await pendingChat, "draft-byte");
  terminal.stop();
});

test("end im Editor stellt Chat-Status exakt wieder her und aktiviert die Settings-Maus nicht erneut", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const { terminal, stdin, stdout } = settingsUi();
  terminal.start();
  const pendingChat = terminal.readInput();
  for (const character of "status-draft") pressSettings(stdin, character, character);
  now = 8_000;
  const before = terminal.frame();
  stdout.output = "";
  terminal.begin(view());
  const editor = terminal.edit(editorRequest({
    kind: "text",
    actionId: "browser-path",
    valueKind: "path",
  }));
  try {
    terminal.end();
    assert.deepEqual(await editor, { kind: "cancel" });
    assert.deepEqual(terminal.frame(), before);
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    pressSettings(stdin, "return");
    assert.equal(await pendingChat, "status-draft");
  } finally {
    Date.now = originalNow;
    terminal.stop();
  }
});

test("split und fehlerhafte SGR-Frames lecken keine Bytes in Settings-Suche", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const target = build(80, 24).hitTargets.find(
    ({ intent }) => intent.kind === "select-item" && intent.itemId === "main-model",
  );
  assert.ok(target);
  const selected = terminal.nextIntent(view());
  terminal.frame();
  for (const part of ["\u001b", "[", "<0", `;${target.columnStart}`, `;${target.row}`, "M"]) {
    emitSettingsData(stdin, part);
  }
  assert.deepEqual(await selected, { kind: "select-item", itemId: "main-model" });

  const searchView = view({ search: { active: true, query: "" } });
  const changed = terminal.nextIntent(searchView);
  emitSettingsData(stdin, "\u001b[<x;2;3M");
  pressSettings(stdin, "x", "x");
  assert.deepEqual(await changed, { kind: "search-change", query: "x" });
  terminal.end();
  terminal.stop();
});

test("SGR verarbeitet mehrere Frames und liefert den normalen Suffix exakt einmal", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = build(80, 24, { search: { active: true, query: "" } }).hitTargets.find(
    ({ intent }) => intent.kind === "select-item" && intent.itemId === "main-model",
  );
  assert.ok(target);
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  const observed: SettingsIntent[] = [];
  try {
    terminal.frame();
    const click = terminal.nextIntent(searchView);
    stdin.emit(
      "data",
      Buffer.from(`\u001b[<2;${target.columnStart};${target.row}M`
        + `\u001b[<0;${target.columnStart};${target.row}M`
        + "z"),
    );
    const clickResult = await Promise.race([
      click.then((intent) => ({ settled: true as const, intent })),
      new Promise<{ settled: false }>((resolve) => setImmediate(() => resolve({ settled: false }))),
    ]);
    if (clickResult.settled) observed.push(clickResult.intent);
    else {
      terminal.end();
      await click.catch(() => undefined);
    }
    if (clickResult.settled) {
      const suffix = terminal.nextIntent(searchView);
      const suffixResult = await Promise.race([
        suffix.then((intent) => ({ settled: true as const, intent })),
        new Promise<{ settled: false }>((resolve) => setImmediate(() => resolve({ settled: false }))),
      ]);
      if (suffixResult.settled) observed.push(suffixResult.intent);
      else {
        terminal.end();
        await suffix.catch(() => undefined);
      }
    }
  } finally {
    terminal.end();
    terminal.stop();
  }
  assert.deepEqual(observed, [
    { kind: "select-item", itemId: "main-model" },
    { kind: "search-change", query: "z" },
  ]);
});

test("ein fehlerhaftes SGR-Frame verschluckt seine Bytes, aber nicht den Suffix", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  try {
    const changed = terminal.nextIntent(searchView);
    stdin.emit("data", Buffer.from("\u001b[<x;2;3Mz"));
    assert.deepEqual(await changed, { kind: "search-change", query: "z" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("normaler Raw-Präfix bleibt vor einem SGR-Klick geordnet und Mausbytes bleiben unsichtbar", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = build(80, 24, { search: { active: true, query: "" } }).hitTargets.find(
    ({ intent }) => intent.kind === "select-item" && intent.itemId === "main-model",
  );
  assert.ok(target);
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  try {
    terminal.frame();
    const prefix = terminal.nextIntent(searchView);
    stdin.emit(
      "data",
      Buffer.from(`z\u001b[<0;${target.columnStart};${target.row}M`),
    );
    assert.deepEqual(await prefix, { kind: "search-change", query: "z" });
    assert.deepEqual(
      await terminal.nextIntent(view({ search: { active: true, query: "z" } })),
      { kind: "select-item", itemId: "main-model" },
    );
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("malformed SGR mit trailing ESC lässt ein split-valides Folgeframe anklicken", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = build(80, 24, { search: { active: true, query: "" } }).hitTargets.find(
    ({ intent }) => intent.kind === "select-item" && intent.itemId === "main-model",
  );
  assert.ok(target);
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  const selected = terminal.nextIntent(searchView);
  let after: Promise<SettingsIntent> | null = null;
  try {
    terminal.frame();
    stdin.emit("data", Buffer.from("\u001b[<x\u001b"));
    stdin.emit(
      "data",
      Buffer.from(`[<0;${target.columnStart};${target.row}M`),
    );
    const result = await Promise.race([
      selected,
      new Promise<null>((resolve) => setImmediate(() => resolve(null))),
    ]);
    assert.deepEqual(result, { kind: "select-item", itemId: "main-model" });

    after = terminal.nextIntent(searchView);
    const leaked = await Promise.race([
      after.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(leaked, false);
  } finally {
    terminal.end();
    await Promise.allSettled([selected, ...(after ? [after] : [])]);
    terminal.stop();
  }
});

test("malformed SGR mit Recovery-CSI bewahrt Readlines Left-Semantik", async () => {
  const initial = view({ search: { active: true, query: "ab" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  try {
    const changed = terminal.nextIntent(initial);
    stdin.emit("data", Buffer.from("\u001b[<x\u001b["));
    stdin.emit("data", Buffer.from("D"));
    stdin.emit("data", Buffer.from("x"));
    assert.deepEqual(await changed, { kind: "search-change", query: "axb" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("split normales CSI wird nicht als Mauspräfix verschluckt", async () => {
  const initial = view({ search: { active: true, query: "ab" } });
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(initial);
  try {
    const changed = terminal.nextIntent(initial);
    stdin.emit("data", Buffer.from("\u001b["));
    stdin.emit("data", Buffer.from("D"));
    stdin.emit("data", Buffer.from("x"));
    assert.deepEqual(await changed, { kind: "search-change", query: "axb" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("bestehende Picker, Secret und Approval kehren aus Settings zur selben Zeile zurück", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());

  const secret = terminal.readSecret("Provider-Key");
  pressSettings(stdin, "escape");
  assert.equal(await secret, null);
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Hauptmodell/u);

  const choice = terminal.pickChoice("Provider", [
    { value: "a", label: "A", description: "A" },
  ], "a");
  pressSettings(stdin, "escape");
  assert.equal(await choice, null);
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Hauptmodell/u);

  const confirmation = terminal.confirmAction("Extern bestätigen", "lokale Aktion");
  pressSettings(stdin, "n", "n");
  assert.deepEqual(await confirmation, { accepted: false });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Hauptmodell/u);
  terminal.end();
  terminal.stop();
});

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
