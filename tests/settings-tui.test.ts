import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";

import { SETTINGS_READ_ONLY_REASONS } from "../src/settings-controller.js";
import type {
  SettingsController,
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "../src/settings-controller.js";
import { runSettingsSession } from "../src/settings-session.js";
import {
  createTerminalModelRoutePicker,
  createTerminalPublicRoutePicker,
  TerminalUi,
  type DashboardState,
  type TerminalUiOptions,
} from "../src/tui.js";
import type { ModelRoutePickerPort, SelectableModelRoute } from "../src/model-route-catalog.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import { createRoutePickerAuthority } from "../src/route-picker.js";
import type {
  SettingsCategory,
  SettingsItem,
} from "../src/settings-registry.js";
import { displayWidth, renderLines } from "../src/ui/compose.js";
import {
  buildSettingsFrame,
  type SettingsFrameResult,
} from "../src/ui/settings-frame.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import type { ModelInfo } from "../src/types.js";

const CATEGORIES = [
  {
    id: "models",
    label: "Models",
    description: "Choose your model, tune reasoning, and manage compression to control cost and quality.",
  },
  {
    id: "accounts",
    label: "Accounts",
    description: "Connect and manage the providers powering your models.",
  },
  {
    id: "approvals-costs",
    label: "Approvals & Costs",
    description: "Decide what the agent may do without asking, and set spending limits.",
  },
  {
    id: "tools",
    label: "Tools",
    description: "Turn features like verification, browsing, panels, and voice on or off.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Customize the logo, header mark, and terminal characters.",
  },
] as const satisfies readonly SettingsCategory[];

const ITEMS = [
  {
    id: "main-model",
    categoryId: "models",
    label: "Model & route",
    description: "Choose the provider-bound route",
    aliases: ["private-alias-must-never-render"],
    displayValue: "openai/gpt-5.4",
    editor: { kind: "model", actionId: "main-model", filter: "main" },
    affectsActiveRun: true,
  },
  {
    id: "reasoning",
    categoryId: "models",
    label: "Thinking",
    description: "Thinking budget for the main model",
    aliases: [],
    displayValue: "High",
    editor: { kind: "choice", actionId: "reasoning", options: [] },
    affectsActiveRun: true,
    disabledReason: "Run active",
  },
  {
    id: "max-steps",
    categoryId: "models",
    label: "Max steps",
    description: "Maximum agent steps",
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
    selectedCategoryId: "models",
    selectedItemId: "main-model",
    search: { active: false, query: "" },
    readOnlyReason: null,
    runActive: true,
    notice: { kind: "success", message: "Saved" },
    ...overrides,
  };
}

function build(
  width: number,
  height: number,
  overrides: Partial<SettingsViewModel> = {},
  level: 0 | 1 | 2 | 3 = 0,
): SettingsFrameResult {
  return buildSettingsFrame({
    width,
    height,
    theme: createTheme({ level }),
    view: view(overrides),
  });
}

/**
 * A plausible-looking SGR mouse click coordinate, for the tests below that
 * prove such a click is ignored in Settings (orcode 0.7 made Settings and
 * every nested editor keyboard-only — `tui.ts`'s `#syncMouseReporting`
 * never even enables SGR mouse reporting for this surface). Any positive
 * row/column pair works equally well for that: the point is that this
 * *looks* like a real click, not that it lands on a specific row (F6
 * dead-layer sweep — `SettingsFrameResult` no longer exposes the hit-target
 * catalog these coordinates used to come from, since nothing outside
 * `settings-frame.ts` ever read it).
 */
const FAKE_SGR_TARGET = { row: 5, columnStart: 10, columnEnd: 20 };

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
  reasoning: "auto",
  maxCost: "$1.00",
  maxSteps: 12,
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
    categoryId: "models",
    itemId: "reasoning",
    label: "Thinking",
    description: "Choose a thinking budget",
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
  // V4-B: the surface identifies itself by its title-bar crumb, not by a
  // wordmark — see the title-bar pin below.
  assert.match(settingsText, /Settings › Models/u);
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
  for (const character of "untouched") pressSettings(stdin, character, character);
  terminal.begin(view());

  const category = terminal.nextIntent(view());
  pressSettings(stdin, "6", "6");
  assert.equal(await Promise.race([
    category.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]), false, "Taste 6 darf keinen verborgenen Bereich auswählen");
  pressSettings(stdin, "4", "4");
  assert.deepEqual(await category, { kind: "category", categoryId: "tools" });

  const toolsView = view({ selectedCategoryId: "tools" });
  const searchStart = terminal.nextIntent(toolsView);
  pressSettings(stdin, "/", "/");
  assert.deepEqual(await searchStart, { kind: "search-start" });

  const emptySearch = view({
    selectedCategoryId: "tools",
    search: { active: true, query: "" },
  });
  const firstCharacter = terminal.nextIntent(emptySearch);
  pressSettings(stdin, "k", "k");
  assert.deepEqual(await firstCharacter, { kind: "search-change", query: "k" });

  const oneCharacter = view({
    selectedCategoryId: "tools",
    search: { active: true, query: "k" },
  });
  const digit = terminal.nextIntent(oneCharacter);
  pressSettings(stdin, "3", "3");
  assert.deepEqual(await digit, { kind: "search-change", query: "k3" });

  const withDigit = view({
    selectedCategoryId: "tools",
    search: { active: true, query: "k3" },
  });
  const erased = terminal.nextIntent(withDigit);
  pressSettings(stdin, "backspace");
  assert.deepEqual(await erased, { kind: "search-change", query: "k" });

  const boundedView = view({
    selectedCategoryId: "tools",
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
  assert.equal(await pendingChat, "untouched");
  terminal.stop();
});

test("← und → wählen den Bereich wie die Ziffern und klemmen an den Rändern", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  try {
    const forward = terminal.nextIntent(view());
    pressSettings(stdin, "right");
    assert.deepEqual(await forward, { kind: "category", categoryId: "accounts" });

    const backward = terminal.nextIntent(view({ selectedCategoryId: "accounts" }));
    pressSettings(stdin, "left");
    assert.deepEqual(await backward, { kind: "category", categoryId: "models" });

    // Digit semantics decide the edges: an out-of-range digit selects
    // nothing and an in-range digit re-selects even the current category, so
    // an arrow at either end clamps and re-selects rather than wrapping.
    const firstEdge = terminal.nextIntent(view());
    pressSettings(stdin, "left");
    assert.deepEqual(await firstEdge, { kind: "category", categoryId: "models" });

    const lastEdge = terminal.nextIntent(view({ selectedCategoryId: "appearance" }));
    pressSettings(stdin, "right");
    assert.deepEqual(await lastEdge, { kind: "category", categoryId: "appearance" });

    // Same intent as the digit path, not a parallel one.
    const digit = terminal.nextIntent(view());
    pressSettings(stdin, "2", "2");
    assert.deepEqual(await digit, { kind: "category", categoryId: "accounts" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("← und → gehören in der Suche weiter der Query, nicht dem Bereich", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  const searching = view({ search: { active: true, query: "" } });
  terminal.begin(searching);
  try {
    const pending = terminal.nextIntent(searching);
    pressSettings(stdin, "left");
    pressSettings(stdin, "right");
    assert.equal(await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]), false, "Pfeile dürfen in der Suche keinen Bereichswechsel auslösen");
    pressSettings(stdin, "escape");
    assert.deepEqual(await pending, { kind: "back" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("Settings leitet PageUp PageDown Home und End als echte Listennavigation weiter", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  try {
    const pageDown = terminal.nextIntent(view());
    pressSettings(stdin, "pagedown");
    assert.deepEqual(await pageDown, { kind: "page", delta: 1 });

    const pageUp = terminal.nextIntent(view());
    pressSettings(stdin, "pageup");
    assert.deepEqual(await pageUp, { kind: "page", delta: -1 });

    const home = terminal.nextIntent(view());
    pressSettings(stdin, "home");
    assert.deepEqual(await home, { kind: "boundary", edge: "first" });

    const end = terminal.nextIntent(view());
    pressSettings(stdin, "end");
    assert.deepEqual(await end, { kind: "boundary", edge: "last" });
  } finally {
    terminal.end();
    terminal.stop();
  }
});

test("unter 40x8 ignoriert Settings jede Navigation und Mutation außer Esc", async () => {
  const { terminal, stdin, stdout } = settingsUi();
  stdout.columns = 39;
  stdout.rows = 7;
  terminal.start();
  terminal.begin(view());
  try {
    const pending = terminal.nextIntent(view());
    for (const [name, character] of [
      ["down", ""], ["pagedown", ""], ["end", ""], ["4", "4"],
      ["return", ""], ["/", "/"],
    ] as const) pressSettings(stdin, name, character);
    assert.equal(await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]), false);
    pressSettings(stdin, "escape");
    assert.deepEqual(await pending, { kind: "back" });
  } finally {
    terminal.end();
    terminal.stop();
  }

  const valid = settingsUi();
  valid.stdout.columns = 40;
  valid.stdout.rows = 8;
  valid.terminal.start();
  valid.terminal.begin(view());
  const move = valid.terminal.nextIntent(view());
  pressSettings(valid.stdin, "down");
  assert.deepEqual(await move, { kind: "move", delta: 1 });
  valid.terminal.end();
  valid.terminal.stop();
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

test("Settings-Oberfläche aktiviert nie SGR-Mausreporting und bleibt über suspend und resume per Tastatur bedienbar", async () => {
  const { terminal, stdin, stdout } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const move = terminal.nextIntent(view());
  pressSettings(stdin, "down");
  assert.deepEqual(await move, { kind: "move", delta: 1 });

  await terminal.suspend(async () => undefined);
  const activate = terminal.nextIntent(view());
  pressSettings(stdin, "return");
  assert.deepEqual(await activate, { kind: "activate" });

  const back = terminal.nextIntent(view());
  pressSettings(stdin, "escape");
  assert.deepEqual(await back, { kind: "back" });
  terminal.end();
  terminal.stop();
  assert.doesNotMatch(stdout.output, /\u001b\[\?1000h/u, stdout.output);
  assert.doesNotMatch(stdout.output, /\u001b\[\?1006h/u, stdout.output);
  assert.doesNotMatch(stdout.output, /\u001b\[\?1000l/u, stdout.output);
});

test("verschachtelte Settings-Choice- und Modell-Editoren aktivieren nie SGR-Mausreporting und bleiben per Tastatur bedienbar", async () => {
  const models = [cachedModel("model/a"), cachedModel("model/b")];
  const { terminal, stdin, stdout } = settingsUi({
    settingsEditorResolver: { searchModels: () => models },
  });
  terminal.start();
  terminal.begin(view());

  const chosen = terminal.edit(editorRequest({
    kind: "choice",
    actionId: "reasoning",
    options: [
      { value: "low", label: "Low", description: "short" },
      { value: "high", label: "High", description: "thorough" },
    ],
  }, { initialValue: "low" }));
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");
  assert.deepEqual(await chosen, { kind: "value", value: "high" });

  const picked = terminal.edit(editorRequest({
    kind: "model",
    actionId: "main-model",
    filter: "main",
  }, { itemId: "main-model", initialValue: "model/a" }));
  await terminal.suspend(async () => undefined);
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");
  assert.deepEqual(await picked, { kind: "value", value: "model/b" });

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

  terminal.end();
  terminal.stop();
  assert.doesNotMatch(stdout.output, /\u001b\[\?1000h/u, stdout.output);
  assert.doesNotMatch(stdout.output, /\u001b\[\?1006h/u, stdout.output);
  assert.doesNotMatch(stdout.output, /\u001b\[\?1000l/u, stdout.output);
});

test("SGR-Klick auf ein Settings-Hit-Target löst kein Intent aus, Enter aktiviert per Tastatur", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const target = FAKE_SGR_TARGET;
  terminal.frame();

  const pending = terminal.nextIntent(view());
  emitSettingsData(stdin, `\u001b[<0;${target.columnStart};${target.row}M`);
  emitSettingsData(stdin, `\u001b[<0;${target.columnEnd};${target.row}m`);
  const clicked = await Promise.race([
    pending.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(clicked, false);

  pressSettings(stdin, "return");
  assert.deepEqual(await pending, { kind: "activate" });
  terminal.end();
  terminal.stop();
});

test("SGR-Klick auf eine Zeile eines verschachtelten Settings-Choice-Editors wählt nichts, Esc bricht per Tastatur ab", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const editor = terminal.edit(editorRequest({
    kind: "choice",
    actionId: "reasoning",
    options: [
      { value: "low", label: "Low", description: "short" },
      { value: "high", label: "High", description: "thorough" },
    ],
  }, { initialValue: "low" }));
  const row = terminal.frame().lines.findIndex(
    (line) => plainText(line).includes("High"),
  ) + 1;
  assert.ok(row > 0);

  emitSettingsData(stdin, `\u001b[<0;1;${row}M\u001b[<0;1;${row}m`);
  const clicked = await Promise.race([
    editor.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(clicked, false);

  pressSettings(stdin, "escape");
  assert.deepEqual(await editor, { kind: "cancel" });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);
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

test("generischer Picker: Press und Release lecken an keiner Chunkgrenze in Chat oder Secret", async () => {
  const items = [
    { value: "a", label: "Alpha", description: "A" },
    { value: "b", label: "Beta", description: "B" },
  ];
  for (const follow of ["input", "secret"] as const) {
    const probe = settingsUi();
    probe.terminal.start();
    const probePick = probe.terminal.pickChoice("Provider", items, "a");
    const row = probe.terminal.frame().lines.findIndex(
      (line) => plainText(line).includes("Beta"),
    ) + 1;
    probe.terminal.stop();
    await probePick;
    assert.ok(row > 0);
    const packet = `\u001b[<0;1;${row}M\u001b[<0;1;${row}m`;

    for (let split = 1; split < packet.length; split += 1) {
      const { terminal, stdin } = settingsUi();
      terminal.start();
      try {
        const attempt = terminal.pickChoice("Provider", items, "a");
        terminal.frame();
        stdin.emit("data", Buffer.from(packet.slice(0, split)));
        const settledEarly = await Promise.race([
          attempt.then(() => true),
          new Promise<false>((resolve) => setImmediate(() => resolve(false))),
        ]);
        const early = settledEarly
          ? (follow === "input" ? terminal.readInput() : terminal.readSecret("Provider-Key"))
          : null;
        stdin.emit("data", Buffer.from(packet.slice(split)));
        assert.equal((await attempt)?.value, "b", `${follow} split ${split}`);
        const next = early
          ?? (follow === "input" ? terminal.readInput() : terminal.readSecret("Provider-Key"));
        pressSettings(stdin, "return");
        assert.equal(await next, "", `${follow} split ${split}`);
      } finally {
        terminal.stop();
      }
    }
  }
});

test("zweites ausstehendes Settings-Intent scheitert geschlossen zurück zum Chat", async () => {
  const { terminal } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const first = terminal.nextIntent(view());
  const firstFailure = assert.rejects(first, /Only one settings input/u);
  await assert.rejects(terminal.nextIntent(view()), /Only one settings input/u);
  await firstFailure;
  assert.doesNotMatch(
    terminal.frame().lines.map(plainText).join("\n"),
    /ORCODE · Settings/u,
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
  assert.match(plainText(frame.lines[0]!), /Enlarge window/u);
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
      { value: "low", label: "Low", description: "short" },
      { value: "high", label: "High", description: "thorough" },
    ],
  }, { initialValue: "low" });

  const chosen = terminal.edit(request);
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");
  assert.deepEqual(await chosen, { kind: "value", value: "high" });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);

  const cancelled = terminal.edit(request);
  pressSettings(stdin, "escape");
  assert.deepEqual(await cancelled, { kind: "cancel" });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);
  terminal.end();
  terminal.stop();
});

/**
 * V4-B, discharging V4-A's concern 3 and 5 (owner-approved mockup, "orcode —
 * Wert ändern (Editier-Zustand)").
 *
 * Two facts the edit state used to leave out. The crumb GROWS — `Settings ›
 * Models › Thinking` instead of `Choose Thinking`, which named the row but
 * never said where it lives or that Esc is one level back. And the state
 * opens with `Current: <value>`, taken from the settings row's OWN
 * `displayValue`: the `· active` tag on the current row only says so while
 * that row happens to be inside the window, which for a model catalog it
 * usually is not.
 */
test("ein Settings-Editor wächst die Brotkrume und nennt den aktuellen Wert", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());

  const choice = terminal.edit(editorRequest({
    kind: "choice",
    actionId: "reasoning",
    options: [
      { value: "low", label: "Low", description: "short" },
      { value: "high", label: "High", description: "thorough" },
    ],
  }, { initialValue: "low" }));
  const chosenFrame = terminal.frame().lines.map(plainText);
  assert.match(chosenFrame.join("\n"), /Settings › Models › Thinking/u);
  // `High` is ITEMS[1].displayValue — the exact string the settings row shows.
  assert.match(chosenFrame.join("\n"), /Current: High/u);
  assert.doesNotMatch(chosenFrame.join("\n"), /Choose Thinking/u);
  // The crumb is the title bar, so it is the screen's one loud line.
  const crumbLine = terminal.frame().lines.find((line) =>
    plainText(line).includes("Settings › Models › Thinking"));
  assert.ok(crumbLine);
  // Levels, not a second look: the label is muted (4), the value accent (3b).
  const currentLine = terminal.frame().lines.find((line) =>
    plainText(line).startsWith("Current: "));
  assert.ok(currentLine);
  assert.deepEqual(
    currentLine!.spans.map(({ text, role }) => `${text}|${role}`),
    ["Current: |muted", "High|accent"],
  );
  pressSettings(stdin, "escape");
  assert.deepEqual(await choice, { kind: "cancel" });

  // A number/text editor says the same two things through the same zone.
  const number = terminal.edit(editorRequest({
    kind: "number",
    actionId: "max-steps",
    minimum: 1,
    maximum: 100,
  }, { itemId: "max-steps", label: "Max steps", initialValue: "24" }));
  const numberFrame = terminal.frame().lines.map(plainText).join("\n");
  assert.match(numberFrame, /Settings › Models › Max steps/u);
  assert.match(numberFrame, /Current: 24/u);
  pressSettings(stdin, "escape");
  assert.deepEqual(await number, { kind: "cancel" });

  terminal.end();
  terminal.stop();
});

test("shared route picker maps exact provider identity and preserves draft cursor attachments viewport and route", async () => {
  const currentRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_openrouter_picker",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "openai/current",
    canonicalModelId: "openai/current",
    resolutionState: "resolved" as const,
  };
  const selected: SelectableModelRoute = {
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "acct_kimi_picker",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    providerLabel: "Kimi Code",
    model: {
      id: "k3",
      name: "Kimi K3",
      contextLength: 262_144,
      reasoning: { mandatory: true, supportedEfforts: ["low", "high", "max"], supportsMaxTokens: true },
      price: { kind: "unknown" },
    },
    supportsTools: true,
    supportsReasoning: true,
    selected: false,
  };
  const current: SelectableModelRoute = {
    ...selected,
    route: currentRoute,
    providerLabel: "OpenRouter",
    model: { ...selected.model, id: "openai/current", name: "OpenAI Current" },
    selected: true,
  };
  const compressor: SelectableModelRoute = {
    ...current,
    route: {
      ...currentRoute,
      requestedModelId: "openai/compressor",
      canonicalModelId: "openai/compressor",
    },
    model: {
      ...current.model,
      id: "openai/compressor",
      name: "OpenAI Compressor",
    },
    selected: false,
  };
  const calls: string[] = [];
  const { terminal, stdin } = settingsUi();
  const publicRows = [current, selected, compressor].map((row, index) => ({
    handle: `opaque-${index}`,
    providerId: row.route.backendId,
    connectionId: `connection-${index}`,
    accountLabel: row.providerLabel,
    canonicalModelId: row.route.canonicalModelId!,
    displayName: row.model.name,
    reasoning: row.supportsReasoning ? "supported" as const : "unsupported" as const,
    capabilities: ["text", "tools"] as const,
    cost: index === 1
      ? { kind: "known" as const, label: "OpenRouter-Tarif" as const, source: "provider" as const }
      : { kind: "unknown" as const, label: "Kosten unbekannt" as const },
    dataPolicy: index === 1
      ? { kind: "known" as const, label: "OpenRouter Datenschutz" as const, source: "provider" as const }
      : { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const },
    runnable: true,
  }));
  const realAuthority = createRoutePickerAuthority({ capture() {
    calls.push("view");
    return {
      snapshot: {
        schemaVersion: 1, revision: 9, generation: 4, routeRunnable: true,
        activeRoute: null, undoAvailable: false,
        appearance: { showLargeLogo: true, showHeaderMark: true },
        providers: [{ providerId: "openrouter", providerLabel: "OpenRouter",
          connectionId: "connection-0", accountLabel: "OpenRouter",
          state: "ready", setupMethods: [], multiProfile: { enabled: false }, routes: publicRows }],
      },
      bindings: new Map(publicRows.map((candidate, index) => [candidate.handle, {
        connectionId: candidate.connectionId, route: [current, selected, compressor][index]!.route,
      }])),
    };
  } });
  const authorityProjection = { view() { return realAuthority.view({ role: "main" }); } };
  const projectedKnown = authorityProjection.view().candidates.find((candidate) => candidate.canonicalModelId === selected.route.canonicalModelId)!;
  const projectedCurrent = authorityProjection.view().candidates.find((candidate) => candidate.canonicalModelId === current.route.canonicalModelId)!;
  assert.deepEqual(projectedKnown.cost, { kind: "known", label: "OpenRouter-Tarif", source: "provider" });
  assert.deepEqual(projectedKnown.dataPolicy, { kind: "known", label: "OpenRouter Datenschutz", source: "provider" });
  calls.length = 0;
  terminal.setPublicModelRoutePicker(createTerminalPublicRoutePicker(terminal), authorityProjection);
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
    terminal.addMessage("assistant", `Response ${index} ${"long ".repeat(12)}`);
  }
  terminal.render(true);
  pressSettings(stdin, "pageup");
  const routeState = { route: currentRoute };
  const routeBefore = JSON.stringify(routeState);
  const before = terminal.frame();

  terminal.begin(view({ runActive: false }));
  const result = terminal.edit(editorRequest(
    { kind: "model", actionId: "main-model", filter: "main" },
    { itemId: "main-model", label: "Main model", initialValue: currentRoute.requestedModelId },
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /OpenRouter.*OpenAI Current/u);
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Kimi Code.*Kimi K3/u);
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /OpenRouter-Tarif.*OpenRouter Datenschutz/u);
  pressSettings(stdin, "down");
  pressSettings(stdin, "return");

  assert.deepEqual(await result, {
    kind: "value",
    value: { kind: "model-route", selection: { handle: projectedKnown.handle, revision: 9, generation: 4 } },
  });
  const compressorResult = terminal.edit(editorRequest(
    { kind: "model", actionId: "compressor-model", filter: "compressor" },
    { itemId: "compressor-model", label: "Compressor model", initialValue: "openai/compressor" },
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  pressSettings(stdin, "return");
  assert.deepEqual(await compressorResult, {
    kind: "value",
    value: { kind: "model-route", selection: { handle: projectedCurrent.handle, revision: 9, generation: 4 } },
  });
  assert.deepEqual(calls, ["view", "view"]);
  terminal.end();
  assert.deepEqual(terminal.frame(), before);
  assert.equal(JSON.stringify(routeState), routeBefore);
  pressSettings(stdin, "x", "X", { shift: true });
  pressSettings(stdin, "return");
  assert.equal(await pendingChat, "draft-byXte");
  terminal.stop();
});

// F1b: the Cross rows still exclude the counterpart, but the editor request
// now NAMES the counterpart role instead of carrying its `RouteIdentityV1`
// (which carries `accountFingerprint`) out through the surface seam. The
// identity `sameCanonicalModelRoute` needs is resolved by the picker itself,
// on the runtime side — the second half of this test proves the resolved
// exclusion still drops exactly the counterpart candidate and nothing else.
test("cross-lead-model and cross-challenger-model reach the shared picker with their role and the counterpart's role — never its route", async () => {
  const leadRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_cross_lead_exclude",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/lead",
    canonicalModelId: "openai/lead",
    resolutionState: "resolved",
  };
  const challengerRoute: RouteIdentityV1 = {
    ...leadRoute,
    accountFingerprint: "acct_cross_challenger_exclude",
    requestedModelId: "openai/challenger",
    canonicalModelId: "openai/challenger",
  };
  const pair = { lead: leadRoute, challenger: challengerRoute };
  const cases = [
    {
      actionId: "cross-lead-model" as const,
      filter: "cross-lead" as const,
      role: "lead" as const,
      initialValue: "openai/current-lead",
      excludeCrossRole: "challenger" as const,
    },
    {
      actionId: "cross-challenger-model" as const,
      filter: "cross-challenger" as const,
      role: "challenger" as const,
      initialValue: "openai/current-challenger",
      excludeCrossRole: "lead" as const,
    },
  ];
  for (const scenario of cases) {
    const calls: string[] = [];
    const { terminal } = settingsUi();
    terminal.setPublicModelRoutePicker({
      async pickModelRoute(input) { calls.push(input.request.role); return null; },
    }, {
      view(request) { calls.push(`view:${request.role}`); return { revision: 1, generation: 1, candidates: [] }; },
    });
    terminal.start();
    terminal.begin(view());
    const request = editorRequest(
      { kind: "model", actionId: scenario.actionId, filter: scenario.filter },
      {
        itemId: scenario.actionId,
        label: scenario.actionId,
        initialValue: scenario.initialValue,
        excludeCrossRole: scenario.excludeCrossRole,
      },
    );
    // The request is what a remote surface would be handed: no identity in it.
    assert.equal(JSON.stringify(request).includes("acct_cross"), false, scenario.actionId);
    const result = await terminal.edit(request);
    assert.deepEqual(calls, [`view:${scenario.role}`, scenario.role], scenario.actionId);
    assert.deepEqual(result, { kind: "cancel" }, scenario.actionId);
    terminal.end();
    terminal.stop();

    // …and the picker resolves that role back into the exact same exclusion
    // the route-valued request used to produce: the counterpart's row is gone,
    // every other row (same canonical model on a DIFFERENT account included)
    // survives.
    const excluded = scenario.excludeCrossRole === "lead" ? leadRoute : challengerRoute;
    const otherAccount: RouteIdentityV1 = {
      ...excluded,
      accountFingerprint: `${excluded.accountFingerprint}_second_account`,
    };
    const rows = [excluded, otherAccount, { ...excluded, requestedModelId: "openai/other", canonicalModelId: "openai/other" }]
      .map((route) => selectableCrossRoute(route));
    const offered: string[] = [];
    const roles: Array<"lead" | "challenger"> = [];
    const picker = createTerminalModelRoutePicker(
      {
        async pickChoice(_title, choices) {
          offered.push(...choices.map((choice) => choice.label));
          return null;
        },
      },
      { async listSelectableModelRoutes() { return rows; } },
      () => null,
      (role) => { roles.push(role); return pair[role]; },
    );
    await picker.pickModelRoute({
      title: scenario.actionId,
      role: scenario.role,
      current: null,
      excludeCrossRole: scenario.excludeCrossRole,
      preserveDraft: true,
    });
    assert.deepEqual(roles, [scenario.excludeCrossRole], scenario.actionId);
    assert.deepEqual(
      offered,
      [`OpenRouter · ${otherAccount.requestedModelId}`, "OpenRouter · openai/other"],
      scenario.actionId,
    );
  }
});

function selectableCrossRoute(route: RouteIdentityV1): SelectableModelRoute {
  return {
    route,
    providerLabel: "OpenRouter",
    model: {
      id: route.requestedModelId,
      name: route.requestedModelId,
      contextLength: 128_000,
      reasoning: undefined,
      price: { kind: "known", promptUsdPerToken: 0, completionUsdPerToken: 0 },
    },
    supportsTools: true,
    supportsReasoning: false,
    selected: false,
  };
}

// Phase 14 (ruling 2): "same picker machinery" — architect-executor-model
// reaches the exact same `ModelRoutePickerPort` main-model/compressor-model/
// cross-*-model already go through, with role "executor" and no counterpart
// to exclude (unlike Cross's pair, there is nothing to stage against).
test("architect-executor-model reaches the public shared picker with role executor", async () => {
  const calls: string[] = [];
  const { terminal } = settingsUi();
  terminal.setPublicModelRoutePicker({
    async pickModelRoute(input) { calls.push(input.request.role); return null; },
  }, {
    view(request) { calls.push(`view:${request.role}`); return { revision: 1, generation: 1, candidates: [] }; },
  });
  terminal.start();
  terminal.begin(view());
  const result = await terminal.edit(editorRequest(
    { kind: "model", actionId: "architect-executor-model", filter: "architect-executor" },
    {
      itemId: "architect-executor-model",
      label: "architect-executor-model",
      initialValue: "qwen/qwen3.5-flash-02-23",
    },
  ));
  assert.deepEqual(calls, ["view:executor", "executor"]);
  assert.deepEqual(result, { kind: "cancel" });
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
    assert.match(failedText, /Model cache could not be read/u);
    assert.match(failedText, /model\/1/u);
    assert.equal(failed.lines.length, stdout.rows);
    for (const line of failed.lines) assert.ok(lineWidth(line) <= stdout.columns - 1);

    pressSettings(stdin, "backspace");
    const recoveredText = terminal.frame().lines.map(plainText).join("\n");
    assert.doesNotMatch(recoveredText, /Model cache could not be read/u);
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
    assert.match(blocked, /At most five panel models/u);
    assert.match(blocked, /model\/6/u);

    pressSettings(stdin, "up");
    pressSettings(stdin, "space", " ");
    assert.doesNotMatch(
      terminal.frame().lines.map(plainText).join("\n"),
      /At most five panel models/u,
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

// D4: renamed and updated deliberately — `verify-clear` is `destructive:
// true`, which now makes it the danger confirm class, so Enter declines
// (stated in the footer instead of silent) and `y` is the accept key. The
// old title/assertion pinned "Enter bestätigt" (Enter confirms), exactly
// the undocumented settings-vs-approval divergence the D4 audit flagged;
// see the companion test right below for the new Enter-declines behavior.
test("Settings-Bestätigung ist ViewModel-frei und y bestätigt bei einer destruktiven Aktion", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.addMessage("assistant", "Chat is preserved");
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
    label: "Clear verify commands",
    description: "Remove all local verify commands",
  }));
  const nested = terminal.frame().lines.map(plainText).join("\n");
  assert.match(nested, /Clear verify commands/u);
  assert.doesNotMatch(nested, /SHELL/u);
  assert.doesNotMatch(nested, /private-confirm-draft/u);
  pressSettings(stdin, "paste-start");
  for (const character of "must-not-touch-chat") {
    pressSettings(stdin, character, character);
  }
  pressSettings(stdin, "paste-end");
  pressSettings(stdin, "y", "y");
  assert.deepEqual(await confirmation, { kind: "value", value: true });
  assert.deepEqual(await terminal.edit(editorRequest({
    kind: "invoke",
    actionId: "verify-suggest",
  }, { itemId: "verify-suggest", label: "Suggestions" })), {
    kind: "value",
    value: true,
  });
  terminal.end();
  const restored = terminal.frame().lines.map(plainText).join("\n");
  assert.match(restored, /Chat is preserved/u);
  assert.doesNotMatch(restored, /Clear verify commands/u);
  pressSettings(stdin, "return");
  assert.equal(await chatDraft, "private-confirm-draft");
  terminal.stop();
});

// D4: the safe default, now stated instead of silent — pressing Enter on a
// destructive settings confirm declines it (cancel-never-success: nothing
// happens), matching the same "Enable allow-all?" question's behavior
// whether it is reached from `/allow allow-all` or from Settings.
test("eine destruktive Settings-Bestätigung lehnt bei Enter ab, akzeptiert nur bei y", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const declined = terminal.edit(editorRequest({
    kind: "confirm",
    actionId: "verify-clear",
    destructive: true,
  }, {
    itemId: "verify-clear",
    label: "Clear verify commands",
    description: "Remove all local verify commands",
  }));
  // Fix round 1, IMPORTANT: strengthened from assert.match to an exact
  // equality — a `match` against a substring let the footer silently also
  // claim `g reason` (which the settings-editor mechanism never binds) and
  // still pass. Equality is the only way a future footer-key lie can't
  // slip back in here.
  const footer = plainText(terminal.frame().lines.at(-1)!).trim();
  assert.equal(footer, "y confirm · Enter/Esc cancel");
  const titleLine = terminal.frame().lines.find((line) =>
    line.spans.some((sp) => sp.text.includes("Clear verify commands")));
  assert.equal(titleLine?.spans[0]?.role, "warn");
  pressSettings(stdin, "return");
  // Enter declines via the same `value: false` path `n` uses (not the
  // explicit `cancel` path, which stays reserved for Esc — Esc-always-
  // cancels is a preserved invariant, not just an equivalent outcome); the
  // controller treats both as "nothing changes" all the same.
  assert.deepEqual(await declined, { kind: "value", value: false });

  const accepted = terminal.edit(editorRequest({
    kind: "confirm",
    actionId: "verify-clear",
    destructive: true,
  }, {
    itemId: "verify-clear",
    label: "Clear verify commands",
    description: "Remove all local verify commands",
  }));
  pressSettings(stdin, "y", "y");
  assert.deepEqual(await accepted, { kind: "value", value: true });
  terminal.end();
  terminal.stop();
});

// D4: an ordinary (non-destructive) settings confirm keeps the opposite,
// friendlier default — Enter (or `y`) accepts, `n`/Esc cancels — matching
// the controller decision's `ordinary` class table exactly.
test("eine nicht-destruktive Settings-Bestätigung akzeptiert bei Enter", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const confirmation = terminal.edit(editorRequest({
    kind: "confirm",
    actionId: "verify-clear",
    destructive: false,
  }, {
    itemId: "verify-clear",
    label: "Adopt these verify commands?",
    description: "npm test",
  }));
  const footer = plainText(terminal.frame().lines.at(-1)!).trim();
  assert.equal(footer, "Enter confirm · Esc cancel");
  const titleLine = terminal.frame().lines.find((line) =>
    line.spans.some((sp) => sp.text.includes("Adopt these verify commands?")));
  assert.equal(titleLine?.spans[0]?.role, "accent");
  pressSettings(stdin, "return");
  assert.deepEqual(await confirmation, { kind: "value", value: true });
  terminal.end();
  terminal.stop();
});

test("Settings schreiben über suspend, resume, end und stop keine SGR-Maussequenzen", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const { terminal, stdout } = settingsUi();
  terminal.start();
  terminal.begin(view());
  await terminal.suspend(async () => undefined);
  terminal.end();
  terminal.stop();
  assert.equal(stdout.output.split(enable).length - 1, 0, stdout.output);
  assert.equal(stdout.output.split(disable).length - 1, 0, stdout.output);
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
  const rejected = assert.rejects(intent, /orcode was closed/u);
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
  // V4-B: the surface's live glyph-mode proof is its own tab bar, not the
  // brand mark it no longer carries — `●`/`○` (FIX-14 ticket 8's live pair)
  // asciify to `*`/`o`, and the active tab is the one thing on this screen
  // that must keep its SHAPE in both charsets.
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /\*1 Models  o2 /u);
  terminal.applyAppearance({
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "unicode",
  });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /●1 Models  ○2 /u);
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
  assert.match(overriddenText, /\*1 Models  o2 /u);
  assert.doesNotMatch(overriddenText, /●|○/u);
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
    terminal.addMessage("assistant", `Response ${index} ${"long ".repeat(12)}`);
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

test("end im Editor stellt Chat-Status exakt wieder her und aktiviert nie die Maus", async () => {
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
    assert.equal(stdout.output.split(enable).length - 1, 0, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 0, stdout.output);
    pressSettings(stdin, "return");
    assert.equal(await pendingChat, "status-draft");
  } finally {
    Date.now = originalNow;
    terminal.stop();
  }
});

test("split und fehlerhafte SGR-Frames lösen in Settings kein Intent aus und lecken keine Bytes in die Suche", async () => {
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(view());
  const target = FAKE_SGR_TARGET;
  const pending = terminal.nextIntent(view());
  terminal.frame();
  for (const part of ["\u001b", "[", "<0", `;${target.columnStart}`, `;${target.row}`, "M"]) {
    emitSettingsData(stdin, part);
  }
  const clicked = await Promise.race([
    pending.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(clicked, false);
  pressSettings(stdin, "return");
  assert.deepEqual(await pending, { kind: "activate" });

  const searchView = view({ search: { active: true, query: "" } });
  const changed = terminal.nextIntent(searchView);
  emitSettingsData(stdin, "\u001b[<x;2;3M");
  pressSettings(stdin, "x", "x");
  assert.deepEqual(await changed, { kind: "search-change", query: "x" });
  terminal.end();
  terminal.stop();
});

test("mehrere SGR-Frames vor einem Suffix lösen kein Intent aus und liefern den Suffix exakt einmal", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = FAKE_SGR_TARGET;
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  let after: Promise<SettingsIntent> | null = null;
  try {
    terminal.frame();
    const changed = terminal.nextIntent(searchView);
    stdin.emit(
      "data",
      Buffer.from(`\u001b[<2;${target.columnStart};${target.row}M`
        + `\u001b[<0;${target.columnStart};${target.row}M`
        + "z"),
    );
    assert.deepEqual(await changed, { kind: "search-change", query: "z" });

    after = terminal.nextIntent(view({ search: { active: true, query: "z" } }));
    const leaked = await Promise.race([
      after.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(leaked, false);
  } finally {
    terminal.end();
    await Promise.allSettled(after ? [after] : []);
    terminal.stop();
  }
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

test("malformed SGR bleibt an jeder Chunkgrenze unterdrückt und liefert den Suffix einmal", async () => {
  const malformed = "\u001b[<x;2;3M";
  for (let split = 1; split < malformed.length; split += 1) {
    const initial = view({ search: { active: true, query: "" } });
    const { terminal, stdin } = settingsUi();
    terminal.start();
    terminal.begin(initial);
    try {
      const changed = terminal.nextIntent(initial);
      stdin.emit("data", Buffer.from(malformed.slice(0, split)));
      await new Promise<void>((resolve) => setImmediate(resolve));
      stdin.emit("data", Buffer.from(`${malformed.slice(split)}z`));
      assert.deepEqual(
        await changed,
        { kind: "search-change", query: "z" },
        `split ${split}`,
      );
    } finally {
      terminal.end();
      terminal.stop();
    }
  }
});

test("valides SGR-Klickframe löst an keiner Chunkgrenze ein Settings-Intent aus und lässt die Tastatur unberührt", async () => {
  const initial = view({ search: { active: true, query: "" } });
  const target = FAKE_SGR_TARGET;
  const packet = `\u001b[<0;${target.columnStart};${target.row}M`;
  for (let split = 1; split < packet.length; split += 1) {
    const { terminal, stdin } = settingsUi();
    terminal.start();
    terminal.begin(initial);
    try {
      terminal.frame();
      const changed = terminal.nextIntent(initial);
      stdin.emit("data", Buffer.from(packet.slice(0, split)));
      await new Promise<void>((resolve) => setImmediate(resolve));
      stdin.emit("data", Buffer.from(packet.slice(split)));
      const clicked = await Promise.race([
        changed.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      assert.equal(clicked, false, `split ${split}`);
      stdin.emit("data", Buffer.from("z"));
      assert.deepEqual(
        await changed,
        { kind: "search-change", query: "z" },
        `split ${split}`,
      );
    } finally {
      terminal.end();
      terminal.stop();
    }
  }
});

test("normaler Raw-Präfix vor einem SGR-Frame kommt an und die Mausbytes bleiben unsichtbar", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = FAKE_SGR_TARGET;
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  let after: Promise<SettingsIntent> | null = null;
  try {
    terminal.frame();
    const prefix = terminal.nextIntent(searchView);
    stdin.emit(
      "data",
      Buffer.from(`z\u001b[<0;${target.columnStart};${target.row}M`),
    );
    assert.deepEqual(await prefix, { kind: "search-change", query: "z" });
    after = terminal.nextIntent(view({ search: { active: true, query: "z" } }));
    const leaked = await Promise.race([
      after.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(leaked, false);
  } finally {
    terminal.end();
    await Promise.allSettled(after ? [after] : []);
    terminal.stop();
  }
});

test("malformed SGR mit trailing ESC und split-validem Folgeframe löst kein Intent aus und leckt nichts", async () => {
  const searchView = view({ search: { active: true, query: "" } });
  const target = FAKE_SGR_TARGET;
  const { terminal, stdin } = settingsUi();
  terminal.start();
  terminal.begin(searchView);
  const pending = terminal.nextIntent(searchView);
  try {
    terminal.frame();
    stdin.emit("data", Buffer.from("\u001b[<x\u001b"));
    stdin.emit(
      "data",
      Buffer.from(`[<0;${target.columnStart};${target.row}M`),
    );
    const leaked = await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(leaked, false);
    pressSettings(stdin, "x", "x");
    assert.deepEqual(await pending, { kind: "search-change", query: "x" });
  } finally {
    terminal.end();
    await Promise.allSettled([pending]);
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
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);

  const choice = terminal.pickChoice("Provider", [
    { value: "a", label: "A", description: "A" },
  ], "a");
  pressSettings(stdin, "escape");
  assert.equal(await choice, null);
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);

  const confirmation = terminal.confirmAction("Confirm externally", "local action");
  pressSettings(stdin, "n", "n");
  assert.deepEqual(await confirmation, { accepted: false });
  assert.match(terminal.frame().lines.map(plainText).join("\n"), /Model & route/u);
  terminal.end();
  terminal.stop();
});

/**
 * V4-B — the whole layout family moved, deliberately and together (plan lane
 * V4-B; owner-approved mockup "Der Härtefall: Settings vorher/nachher").
 *
 * What these pins used to hold was the two-column layout the mockup names as
 * the problem: a `Categories` pane on the left with its own `❯` cursor, a
 * `Settings · Models` heading on the right, one setting spread over two lines
 * (name/value, then description), and a hand-fitted footer of seven `·`-joined
 * hints. All four are gone at once, because each of them alone would have made
 * the screen worse — see `settings-frame.ts`'s own header.
 *
 * The three body rows below are the same three settings the old pins carried,
 * so the fixture is unchanged and only the SHAPE moved.
 */
const BODY = [
  "4:❯ Model & route openai/gpt-5.4 Choose the provider-bound route",
  // The honesty layer survives the redesign visibly: a locked row still says
  // the word `Locked` and still carries the warn role (pinned by role in
  // "eine gesperrte Zeile behält Warnfarbe UND Wort" below).
  "5:Thinking High Locked · Run active",
  "6:Max steps 24 Maximum agent steps",
] as const;

/** Zone 3, from the one keymap table — no surface-local footer budget left. */
const FULL_BAR = "[←→] category [↑↓] row [Enter] change [/] search [Esc] back";

test("120x36 rendert Titelleiste, Tab-Leiste, dichte Zeilen und Aktionsleiste als Klartext-Snapshot", () => {
  const result = build(120, 36);
  assertBounded(result, 120, 36);
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Models",
    "2:●1 Models ○2 Accounts ○3 Approvals & Costs ○4 Tools ○5 Appearance Run active",
    "3:<divider:119>",
    ...BODY,
    "34:✓ Saved",
    "35:<divider:119>",
    `36:${FULL_BAR}`,
  ]);
});

test("80x24 behält das deterministische Zonen-Layout ohne Überlauf", () => {
  const first = build(80, 24);
  const second = build(80, 24);
  assertBounded(first, 80, 24);
  assert.deepEqual(first, second);
  assert.deepEqual(semanticSnapshot(first), [
    "1:─ Settings › Models",
    // Review fix round, F1 (controller ruling): the state summary reserves
    // its space BEFORE the tab labels expand, so disclosure only ever
    // degrades with width. 79 cells cannot hold both every label (69) and
    // `Run active`, and the summary is the warning — so the labels compact
    // to ordinals, which keep the bullet and the key that selects each
    // category while the title bar above names the open one in full. No
    // category is dropped. Idle (no run, editable config) keeps every label
    // here, because then there is nothing to reserve for.
    "2:●1 Models ○2 ○3 ○4 ○5 Run active",
    "3:<divider:79>",
    ...BODY,
    "22:✓ Saved",
    "23:<divider:79>",
    `24:${FULL_BAR}`,
  ]);
  // The other half of that trade, stated rather than implied: with no state
  // to disclose there is nothing to reserve, so 79 cells hold every label.
  assert.equal(
    plainText(build(80, 24, { runActive: false }).frame.lines[1]!),
    "●1 Models  ○2 Accounts  ○3 Approvals & Costs  ○4 Tools  ○5 Appearance",
  );
});

test("50x16 hält alle fünf Bereiche als Ordinale und dichte Zeilen ohne Spaltenpolster", () => {
  const result = build(50, 16);
  assertBounded(result, 50, 16);
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Models",
    // Every category is still there — the LABEL shrinks, never the tab, and
    // the ordinal is the exact key that jumps to it. The title bar above
    // names the open one in full, so nothing is unknowable.
    "2:●1 Models ○2 ○3 ○4 ○5 Run active",
    "3:<divider:49>",
    // Below the description floor the rows close their column padding up and
    // spend the cells on words instead — one decision for the whole body, so
    // the list is never half aligned.
    "4:❯ Model & route openai/gpt-5.4 Choose the prov…",
    "5:Thinking High Locked · Run ac…",
    "6:Max steps 24 Maximum agent s…",
    "14:✓ Saved",
    "15:<divider:49>",
    // 49 cells shed whole chips, lowest priority first: the two arrow hints
    // (both discoverable by pressing an arrow) go before `/ search`, and the
    // way out is never what disappears.
    "16:[Enter] change [/] search [Esc] back",
  ]);
});

test("39x7 liefert ausschließlich eine begrenzte Resize-Meldung", () => {
  const result = build(39, 7);
  assert.deepEqual(semanticSnapshot(result), [
    "1:Enlarge window · at least 40×8",
  ]);
  assert.equal(result.frame.lines.length, 1);
  assert.equal(lineWidth(result.frame.lines[0]!), 30);
  assert.deepEqual(result.frame.cursor, { row: 1, col: 1 });
  assert.equal(result.frame.chatHeight, 0);
});

test("Suche ersetzt die normale Liste und behält Kontext, Fehler und eigenen Footer", () => {
  const result = build(80, 24, {
    items: [ITEMS[2]],
    selectedItemId: "max-steps",
    search: { active: true, query: "schritt" },
    notice: { kind: "error", message: "Search not available" },
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  // V4-B: the crumb says where the reader is, and the tab bar's row becomes
  // the filter line they are actually typing into — a search reaches every
  // category at once, so no tab is live and the arrows belong to the query.
  assert.match(rendered, /─ Settings › Search/u);
  assert.match(rendered, /❯ schritt/u);
  assert.match(rendered, /Max steps {2}24/u);
  assert.doesNotMatch(rendered, /Model & route|Thinking/u);
  assert.match(rendered, /✗ Search not available/u);
  // Neither `←→` nor `/` is offered while the query owns them: a bar that
  // names a key which does something else right now is the exact failure the
  // one keymap table exists to end.
  assert.equal(
    plainText(result.frame.lines.at(-1)!),
    "[↑↓] row  [Enter] change  [Esc] back",
  );
  assertBounded(result, 80, 24);
});

test("Suchergebnisse aus mehreren Bereichen tragen je Zeile ihr eigenes Kategorie-Label", () => {
  const toolsItem: SettingsItem = {
    ...ITEMS[2],
    id: "web-mode",
    categoryId: "tools",
    label: "Web mode",
    description: "Control availability of the web tool for agent runs",
    displayValue: "Automatic",
    editor: { kind: "readonly" },
  };
  const result = build(80, 24, {
    items: [ITEMS[0], toolsItem],
    allItems: [ITEMS[0], toolsItem],
    selectedItemId: "main-model",
    search: { active: true, query: "route" },
  });
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Search",
    "2:❯ route• Run active",
    "3:<divider:79>",
    "4:❯ Model & route openai/gpt-5.4 Models · Choose the provider-bound route",
    "5:Web mode Automatic Tools · Control availability of the web tool …",
    "22:✓ Saved",
    "23:<divider:79>",
    "24:[↑↓] row [Enter] change [Esc] back",
  ]);
  // Outside search, the very same rows never carry a category tag: the title
  // bar's crumb and the tab bar already give that context.
  const browsing = build(80, 24, {
    items: [ITEMS[0], toolsItem],
    allItems: [ITEMS[0], toolsItem],
    selectedItemId: "main-model",
  });
  const browsingRendered = browsing.frame.lines.map(plainText).join("\n");
  assert.doesNotMatch(browsingRendered, /Models · Choose the provider-bound route/u);
  assert.doesNotMatch(browsingRendered, /Tools · Control availability of the web tool for agent runs/u);
  assertBounded(result, 80, 24);
});

/**
 * V4-B (pin moved deliberately — justification): the Settings surface no
 * longer takes a `brand` input at all. `appearance.showHeaderMark` controls
 * the chat HEADER's compact mark; Settings has a title bar rather than a
 * header, and V4 spends that one loud line on the breadcrumb — a wordmark
 * repeated on the screen that exists to answer "where am I" is chrome that
 * says nothing. So the mark cannot appear here in either appearance state,
 * which is what this now pins, together with the crumb that replaced it.
 */
test("die Titelleiste trägt die Brotkrume und in keinem Zustand eine Wortmarke", () => {
  const rendered = build(50, 16).frame.lines.map(plainText).join("\n");
  assert.match(rendered, /Settings › Models/u);
  assert.doesNotMatch(rendered, /ORCODE|❯─●|─────────●/u);
});

// F6 dead-layer sweep: this used to also assert on the exported
// `hitTargets` catalog (1-based, inclusive columns, one entry per visible
// category/item row) — a mouse-click hit-testing mechanism `buildSettingsFrame`
// still computes internally to place `Frame.cursor` on the selected row, but
// orcode 0.7 made Settings keyboard-only (`tui.ts`'s `#syncMouseReporting`
// never enables SGR mouse reporting here), so no click could ever reach one,
// and nothing outside `settings-frame.ts` ever read the catalog itself — see
// `SettingsFrameResult`. What remains genuinely observable, and still worth
// pinning, is that the cursor still lands correctly on the selected item
// amid a busier multi-category layout.
test("the cursor lands on the selected item's row", () => {
  // V4-B: row 4 — title bar, tab bar, the enclosing rule, then the first
  // setting. The category pane that used to push it to row 10 is gone.
  const result = build(50, 16);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
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

test("Farbstufe 0 und 3 erzeugen dieselbe Geometrie; nur der Balken wird zur Linie", () => {
  const input = { width: 80, height: 24, view: view() } as const;
  const plain = buildSettingsFrame({ ...input, theme: createTheme({ level: 0 }) });
  const colored = buildSettingsFrame({ ...input, theme: createTheme({ level: 3 }) });
  // V4-B: the frame has the same number of lines and the same content at
  // every colour level. The two ZONES are the deliberate exceptions
  // (`zones.ts`): at level 0 every role collapses to plain text, so shape
  // takes over — the title bar becomes the divider rule it replaced, and each
  // action chip's KEY grows square brackets. Nothing is signalled by colour
  // alone, which is the whole point.
  assert.equal(colored.frame.lines.length, plain.frame.lines.length);
  assert.deepEqual(
    colored.frame.lines.slice(1, -1).map(plainText),
    plain.frame.lines.slice(1, -1).map(plainText),
  );
  assert.equal(plainText(plain.frame.lines[0]!), "─ Settings › Models");
  assert.equal(plainText(colored.frame.lines[0]!).trimEnd(), " Settings › Models");
  assert.equal(
    plainText(plain.frame.lines.at(-1)!),
    "[←→] category  [↑↓] row  [Enter] change  [/] search  [Esc] back",
  );
  assert.equal(
    plainText(colored.frame.lines.at(-1)!),
    "←→ category  ↑↓ row  Enter change  / search  Esc back",
  );
  assert.deepEqual(colored.frame.cursor, plain.frame.cursor);
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
      // F7 (ruling 4) retired the real "current-route" row; this fixture
      // only needs a valid readonly-editor SettingsItemId as a stand-in for
      // the frame-rendering behavior under test, so it moves to another
      // still-existing id without changing anything else about the case.
      id: "voice-consent-status",
      label: "Aktuelle Route",
      description: "Die aktuell gebundene Sessionroute",
      displayValue: "OpenAI",
      editor: { kind: "readonly" },
      disabledReason: "Run active",
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
      selectedItemId: "voice-consent-status",
      search: { active: search, query: search ? "route" : "" },
    });
    const rendered = result.frame.lines.map(plainText).join("\n");
    // V4-B: one dense row per setting, so the selected row carries its own
    // name, value and reason instead of a name/value line plus a detail line.
    assert.match(rendered, /❯ Aktuelle Route {2,}OpenAI/u, `${width}x${height}`);
    assert.match(rendered, /Locked · Run active/u, `${width}x${height}`);
    assertBounded(result, width, height);
  }

  // The window follows the cursor, and the counter states where it is among
  // the rows the list holds — V4-A's one counter, in its `N of M · ▾` form,
  // built by the very function every picker's corner is built by.
  for (const [index, candidate] of allItems.entries()) {
    const result = build(40, 8, {
      items: allItems,
      allItems,
      selectedItemId: candidate.id,
    });
    const rendered = result.frame.lines.map(plainText).join("\n");
    assert.match(
      rendered,
      new RegExp(`${index + 1} of ${allItems.length} · [▴▾]+`, "u"),
      candidate.id,
    );
    assert.match(rendered, new RegExp(`❯ ${candidate.label}`, "u"), candidate.id);
  }
});

test("Stack-Fenster hält Bereich 5 (Appearance) als eigenständige Kategorie sichtbar", () => {
  const appearanceItem: SettingsItem = {
    ...ITEMS[0],
    id: "appearance-large-logo",
    categoryId: "appearance",
    label: "Large logo",
    description: "Show Route Core in the title area",
    displayValue: "On",
    editor: { kind: "readonly" },
  };
  const result = build(50, 16, {
    items: [appearanceItem],
    allItems: [appearanceItem],
    selectedCategoryId: "appearance",
    selectedItemId: "appearance-large-logo",
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  // V4-B: the fifth category is a tab like every other, marked live by the
  // filled bullet (never by the `❯` a cursor owns), and named in full by the
  // crumb above it.
  assert.match(rendered, /●5 Appearance/u);
  assert.match(rendered, /─ Settings › Appearance/u);
  assert.match(rendered, /❯ Large logo {2}On/u);
});

test("40x8 zeigt im kompakten gültigen Frame Auswahl und Disabled-Zustand", () => {
  const result = build(40, 8, {
    items: [ITEMS[1]],
    allItems: [ITEMS[1]],
    selectedItemId: "reasoning",
  });
  assertBounded(result, 40, 8);
  // The supported floor keeps the whole anatomy: title bar, every category,
  // the rule, a usable row, the notice and the action bar. Only the CHIPS
  // shed — lowest priority first, the way out last of all (`Esc back`).
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Models",
    "2:●1 Models ○2 ○3 ○4 ○5 Run active",
    "3:<divider:39>",
    "4:❯ Thinking High Locked · Run active",
    "6:✓ Saved",
    "7:<divider:39>",
    "8:[Enter] change [/] search [Esc] back",
  ]);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
});

/**
 * V4-B (pin moved deliberately — justification): position and direction used
 * to be two words on the footer (`2/3 · above · below`). They are now the ONE
 * counter every list in the product carries — `N of M · ▾`, built by
 * `list-core.ts`'s `listCounterText`, riding the last visible row instead of a
 * line of its own. Same two facts, one look, one builder: word order is the
 * mockup's ("wie viel gibt es" before "in welche Richtung"), and the marker is
 * the disclosure pair rather than the arrow keys the action bar prints.
 */
test("der Überall-Zähler nennt Rang, Gesamtzahl und nur die echt ausgeblendeten Richtungen", () => {
  const counter = (selectedItemId: string): string => {
    const text = build(40, 8, { selectedItemId: selectedItemId as never })
      .frame.lines.map(plainText).join("\n");
    return /(\d+ of \d+ · [▴▾]+)/u.exec(text)?.[1] ?? "";
  };
  assert.equal(counter("main-model"), "1 of 3 · ▾");
  assert.equal(counter("reasoning"), "2 of 3 · ▾");
  assert.equal(counter("max-steps"), "3 of 3 · ▴");
  // A list that hides nothing counts nothing (FIX-14 ticket 10).
  const whole = build(40, 8, {
    items: [ITEMS[1]],
    allItems: [ITEMS[1]],
    selectedItemId: "reasoning",
  }).frame.lines.map(plainText).join("\n");
  assert.doesNotMatch(whole, /\d+ of \d+/u);
});

/**
 * V4-B, discharging V4-A's concern 4 — and superseding F6 ruling 2 outright.
 *
 * F6's answer to "two identical `❯` cursors" was to give the two panes two
 * LOOKS: the item row got D1's full-width inverse bar, the category row kept
 * the plain marker. V4 deletes the question instead of answering it: the
 * category pane is a tab bar, so there is one cursor on the screen, and
 * `inverse` is spent on the title bar — the screen's ONE loud line, which
 * only works as a landmark while it is the only one.
 *
 * So this pin now holds the invariant the whole anatomy rests on: exactly one
 * inverse line per screen, and it is the title bar.
 */
test("Genau eine laute Zeile: die Titelleiste; die Auswahl ist Ebene 2 hinter dem Marker", () => {
  const colored = build(50, 16, {}, 3);
  const inverse = colored.frame.lines.filter(
    (value) => value.spans.some(({ role }) => role === "inverse"),
  );
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0], colored.frame.lines[0]);
  assert.match(plainText(colored.frame.lines[0]!), /^ Settings › Models/u);
  assert.equal(lineWidth(colored.frame.lines[0]!), 49);
  assert.equal(renderLines([colored.frame.lines[0]!], createTheme({ level: 3 }))[0]!.includes("\u001b[7m"), true);

  // The selected row: marker plus accent+bold (level 2), no bar and no
  // padding — exactly what `list-core.ts`'s pickers draw since V4-A.
  const itemLine = colored.frame.lines[3]!;
  assert.match(plainText(itemLine), /^❯ Model & route/u);
  assert.equal(itemLine.spans.some(({ role }) => role === "inverse"), false);
  assert.equal(itemLine.spans[0]!.role, "accent");
  assert.equal(itemLine.spans[0]!.bold, true);
  // No bar: the row ends where its text ends, never padded out to the frame.
  assert.doesNotMatch(plainText(itemLine), / $/u);
  assert.equal(lineWidth(build(80, 24, {}, 3).frame.lines[3]!) < 79, true);

  // The active tab is marked by SHAPE (the live bullet), never by hue alone,
  // and it is never the `❯` a cursor owns.
  const tabs = plainText(colored.frame.lines[1]!);
  assert.match(tabs, /^●1 Models/u);
  assert.doesNotMatch(tabs, /❯/u);

  // Level 0 (NO_COLOR): the bar becomes the rule, the selection still reads
  // from its marker, and no byte of SGR is emitted at all.
  const plain = build(50, 16);
  assert.equal(plainText(plain.frame.lines[0]!), "─ Settings › Models");
  assert.equal(plainText(plain.frame.lines[3]!), plainText(itemLine));
  assert.match(plainText(plain.frame.lines[3]!), /^❯ /u);
  assert.match(plainText(plain.frame.lines[1]!), /^●1 Models/u);
  assert.equal(
    renderLines(plain.frame.lines, createTheme({ level: 0 }))
      .some((value) => value.includes("\u001b")),
    false,
  );
});

/**
 * V4-B (pins moved deliberately — justification): F6 ruling 3's own footer
 * budget is gone with `footerLine`. Its three subjects survive, restated on
 * the zone-3 action bar:
 *
 *  - both axes are named (`←→ category`, `↑↓ row`);
 *  - `/ search` — the bound-but-undiscoverable key F6 fought for — outranks
 *    both arrow hints and survives further down the width;
 *  - the shed order is a DECISION, and the way out (`Esc back`) is never what
 *    disappears (FIX-11 addendum ruling A).
 *
 * What changed: the ordinals moved from the hint (`←→/1-5 category`) onto the
 * tab bar, which prints them beside the very categories they select, and the
 * position/direction pair became the one counter. Both are closer to the
 * reader than a footer word was.
 */
test("die Aktionsleiste nennt beide Achsen und gibt sie in erklärter Reihenfolge auf", () => {
  const bar = (width: number, height: number, over = {}): string =>
    plainText(build(width, height, over).frame.lines.at(-1)!);

  // Wide: every chip the surface binds, in the mockup's order.
  assert.equal(
    bar(120, 36),
    "[←→] category  [↑↓] row  [Enter] change  [/] search  [Esc] back",
  );

  // Narrower: whole chips go, lowest priority first — the two arrow hints
  // (both discoverable by pressing an arrow) before `/ search`, and `Esc`
  // never at all. A chip is whole or absent; half a chip is never shown.
  assert.equal(bar(50, 16), "[Enter] change  [/] search  [Esc] back");
  assert.equal(bar(40, 8), "[Enter] change  [/] search  [Esc] back");
  for (const width of [40, 50, 72, 80, 120]) {
    assert.match(bar(width, 24), /\[Esc\] back$/u, `${width}`);
  }
});

test("die Aktionsleiste liest ihre Achse aus der Registry statt sie zu behaupten", () => {
  const bar = (over: Partial<SettingsViewModel>): string =>
    plainText(build(120, 36, over).frame.lines.at(-1)!);
  assert.match(bar({ categories: CATEGORIES.slice(0, 2) }), /\[←→\] category/u);
  // A single category has no second place to go, so the chip would be a lie
  // about a choice that does not exist.
  const one = bar({ categories: [CATEGORIES[0]], selectedCategoryId: "models" });
  assert.doesNotMatch(one, /category/u);
  assert.match(one, /\[\/\] search/u);
});

test("50x16 zeigt den globalen Schreibschutz auch ohne Farbe im Titel", () => {
  const result = build(50, 16, {
    readOnlyReason: SETTINGS_READ_ONLY_REASONS.foreignConfig,
    runActive: false,
  });
  const rendered = result.frame.lines.map(plainText).join("\n");
  assert.match(rendered, /Read-only/u);
  assertBounded(result, 50, 16);
});

test("40x8 Suche behält Query, selektiertes Ergebnis und Disabled-Grund", () => {
  const result = build(40, 8, {
    items: [ITEMS[1]],
    allItems: [ITEMS[1]],
    selectedItemId: "reasoning",
    search: { active: true, query: "think" },
  });
  assertBounded(result, 40, 8);
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Search",
    // The tab bar's row becomes the query the reader is typing into — the
    // palette's own filter line, `buildListFilterLine`, block cursor and all.
    "2:❯ think• Run active",
    "3:<divider:39>",
    // The honesty layer survives the floor: warn role AND the word `Locked`.
    "4:❯ Thinking High Locked · Run active",
    "6:✓ Saved",
    "7:<divider:39>",
    // The bar was once cut mid-word here (`… · Ente…`), hiding `Esc`
    // entirely. Chips are shed whole, and the way out is shed last.
    "8:[↑↓] row [Enter] change [Esc] back",
  ]);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
});

test("40x8 Suche fittet den längsten Kategorie-Tag auf einer nicht gesperrten Zeile", () => {
  // The previous 40x8 search test uses a disabled row, which suppresses the
  // category tag entirely (the "Locked · ..." branch never adds one). This
  // exercises the tag on a live, editable row with the longest category
  // label ("Approvals & Costs"), at the tightest floor size, to prove the
  // ellipsis/fitting machinery still keeps the row within width.
  const approvalsItem: SettingsItem = {
    ...ITEMS[0],
    id: "approval-mode",
    categoryId: "approvals-costs",
    label: "Approval mode",
    description: "Sets which tool actions require explicit confirmation",
    displayValue: "Ask",
    editor: { kind: "readonly" },
  };
  const result = build(40, 8, {
    items: [approvalsItem],
    allItems: [approvalsItem],
    selectedItemId: "approval-mode",
    search: { active: true, query: "appro" },
  });
  assertBounded(result, 40, 8);
  assert.deepEqual(semanticSnapshot(result), [
    "1:─ Settings › Search",
    "2:❯ appro• Run active",
    "3:<divider:39>",
    "4:❯ Approval mode Ask Approvals & Cost…",
    "6:✓ Saved",
    "7:<divider:39>",
    "8:[↑↓] row [Enter] change [Esc] back",
  ]);
  assert.deepEqual(result.frame.cursor, { row: 4, col: 1 });
});
