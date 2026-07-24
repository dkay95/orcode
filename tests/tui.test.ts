import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  TerminalUi,
  buildDashboardLayout,
  sanitizeTerminalText,
  wrapPlainText,
  type DashboardState,
  type UiMessage,
} from "../src/tui.js";
import type { ModelInfo } from "../src/types.js";

const state: DashboardState = {
  workspace: "/Users/demo/projects/robopet",
  projectStatus: "robopet · Git main · 3 Änderungen · 12 Chat-Nachrichten",
  model: "openrouter/auto",
  modelDetails: "Kontext 1M · dynamischer Preis · Tools, Reasoning",
  resolvedModel: "moonshotai/kimi-k3",
  approval: "ask",
  compressor: "auto",
  compressorModel: "qwen/qwen3.5-flash",
  reasoning: "auto",
  balance: "$12.48",
  sessionCost: "$0.00420",
  maxCost: "$1.000",
  maxSteps: 12,
  keyStatus: "im Speicher",
};

function messages(count: number): UiMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Nachricht ${index}: ${"langer Chatinhalt ".repeat(5)}`,
    createdAt: "2026-07-24T12:34:00.000Z",
  }));
}

function model(id: string, name = id): ModelInfo {
  return {
    id,
    name,
    description: `${name} ist ein tool-fähiges Coding-Modell.`,
    contextLength: 131_072,
    promptPrice: 0.000_000_2,
    completionPrice: 0.000_000_8,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: {
      defaultEffort: "low",
      defaultEnabled: true,
      mandatory: false,
      supportedEfforts: ["low", "high"],
      supportsMaxTokens: true,
    },
  };
}

class FakeInput extends EventEmitter {
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

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 28;
  output = "";

  write(value: string | Uint8Array): boolean {
    this.output += value.toString();
    return true;
  }
}

test("dashboard fills one screen and keeps status elements at fixed rows", () => {
  const layout = buildDashboardLayout({
    width: 100,
    height: 28,
    state,
    messages: messages(10),
    input: "Bitte prüfe die Tests",
    cursor: 22,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
  });

  assert.equal(layout.lines.length, 28);
  assert.match(layout.lines[0], /ROUTERCODE 0\.3/);
  assert.match(layout.lines[1], /WORKSPACE.*robopet/);
  assert.match(layout.lines[2], /Git main.*3 Änderungen/);
  assert.match(layout.lines[3], /openrouter\/auto.*moonshotai\/kimi-k3/);
  assert.match(layout.lines[4], /Kontext 1M.*Tools/);
  assert.match(layout.lines[5], /APPROVAL ask.*THINK auto.*KOMP auto/);
  assert.match(layout.lines.at(-4) ?? "", /● Bereit/);
  assert.match(layout.lines.at(-3) ?? "", /MAIN openrouter\/auto.*THINK auto/);
  assert.match(layout.lines.at(-2) ?? "", /Bitte prüfe die Tests/);
  assert.match(layout.lines.at(-1) ?? "", /\/ Befehle.*PgUp\/Dn Chat/);
});

test("scroll offset changes only the chat viewport", () => {
  const common = {
    width: 90,
    height: 24,
    state,
    messages: messages(20),
    input: "",
    cursor: 0,
    status: "Bereit",
    busy: false,
  };
  const bottom = buildDashboardLayout({ ...common, scrollOffset: 0 });
  const older = buildDashboardLayout({ ...common, scrollOffset: 12 });

  assert.deepEqual(bottom.lines.slice(0, 7), older.lines.slice(0, 7));
  assert.deepEqual(bottom.lines.slice(-5), older.lines.slice(-5));
  assert.notDeepEqual(
    bottom.lines.slice(7, -5),
    older.lines.slice(7, -5),
  );
  assert.match(older.lines[7], /neuere Chat-Zeilen unterhalb/);
});

test("approval appears in the fixed footer without replacing the chat", () => {
  const layout = buildDashboardLayout({
    width: 88,
    height: 22,
    state,
    messages: messages(4),
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Freigabe erforderlich",
    busy: true,
    confirm: {
      title: "⚠ SHELL Tests ausführen",
      details: "npm test",
    },
  });

  assert.match(layout.lines.at(-4) ?? "", /SHELL Tests ausführen.*npm test/);
  assert.match(layout.lines.at(-2) ?? "", /\[y\] Ja.*\[n\/Enter\] Nein/);
});

test("plain wrapping keeps every line within the requested width", () => {
  const wrapped = wrapPlainText(
    "Ein sehrlangerwertohneleerzeichen und normaler Text",
    12,
  );
  assert.ok(wrapped.length > 2);
  assert.ok(wrapped.every((line) => Array.from(line).length <= 12));
});

test("wide chat uses a readable centered column and normalizes Markdown", () => {
  const layout = buildDashboardLayout({
    width: 170,
    height: 30,
    state,
    messages: [
      {
        role: "assistant",
        content:
          "## Ergebnis\n- **Tests** laufen mit `npm test` erfolgreich und bleiben gut lesbar.",
        createdAt: "2026-07-24T12:34:00.000Z",
      },
    ],
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
  });

  const transcript = layout.lines.slice(7, -5).join("\n");
  const authorLine = layout.lines.find((line) => line.includes("ROUTERCODE ·"));
  assert.ok((authorLine?.indexOf("ROUTERCODE") ?? 0) > 20);
  assert.match(transcript, /• Tests laufen mit ‹npm test›/);
  assert.doesNotMatch(transcript, /\*\*|## Ergebnis/);
});

test("quick replies remain selectable above a free-form input", () => {
  const layout = buildDashboardLayout({
    width: 120,
    height: 30,
    state,
    messages: messages(2),
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
    quickReplies: {
      items: ["Zeig mir den Diff", "Tests erneut ausführen"],
      selectedIndex: 1,
    },
  });

  const screen = layout.lines.join("\n");
  assert.match(screen, /ANTWORTVORSCHLÄGE/);
  assert.match(screen, /› Tests erneut ausführen/);
  assert.match(layout.lines.at(-2) ?? "", /Eigene Antwort/);
  assert.match(
    layout.lines.at(-1) ?? "",
    /Vorschlag.*eigene Antwort tippen/,
  );
});

test("reasoning panel shows provider text compactly and expands without moving the footer", () => {
  const layout = buildDashboardLayout({
    width: 110,
    height: 30,
    state,
    messages: messages(6),
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Modell denkt",
    busy: true,
    reasoningPanel: {
      model: "moonshotai/kimi-k3",
      text: "Ich prüfe zuerst die Projektstruktur.\nDanach führe ich gezielt die Tests aus.",
      tokenCount: 1_240,
      expanded: false,
      live: true,
      truncated: false,
    },
  });

  const screen = layout.lines.join("\n");
  assert.equal(layout.lines.length, 30);
  assert.match(screen, /DENKEN \[T aufklappen\].*LIVE.*kimi-k3/);
  assert.match(screen, /Danach führe ich gezielt die Tests aus/);
  assert.match(screen, /1240 Reasoning-Tokens/);
  assert.match(layout.lines.at(-1) ?? "", /T Denken/);

  const expanded = buildDashboardLayout({
    ...{
      width: 110,
      height: 30,
      state,
      messages: messages(6),
      input: "",
      cursor: 0,
      scrollOffset: 0,
      status: "Bereit",
      busy: false,
    },
    reasoningPanel: {
      model: "moonshotai/kimi-k3",
      text: "Erster Gedankenschritt.\nZweiter Gedankenschritt.",
      tokenCount: 250,
      expanded: true,
      live: false,
      truncated: false,
    },
  });
  assert.equal(expanded.lines.length, 30);
  assert.match(expanded.lines.join("\n"), /DENKEN \[T zuklappen\].*LETZTER LAUF/);
  assert.match(expanded.lines.join("\n"), /Erster Gedankenschritt/);
  assert.match(expanded.lines.join("\n"), /Zweiter Gedankenschritt/);
  assert.match(expanded.lines.at(-4) ?? "", /Bereit/);
});

test("reasoning tokens without provider text are explained instead of faking thoughts", () => {
  const layout = buildDashboardLayout({
    width: 100,
    height: 24,
    state,
    messages: [],
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
    reasoningPanel: {
      model: "provider/model",
      text: "",
      tokenCount: 800,
      expanded: false,
      live: false,
      truncated: false,
    },
  });

  assert.match(
    layout.lines.join("\n"),
    /liefert aber keinen lesbaren Text/,
  );
});

test("small terminals use the compact header and retain the complete footer", () => {
  const layout = buildDashboardLayout({
    width: 60,
    height: 12,
    state,
    messages: [],
    input: "/help",
    cursor: 5,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
  });

  assert.equal(layout.lines.length, 12);
  assert.match(layout.lines[0], /ROUTERCODE 0\.3/);
  assert.doesNotMatch(layout.lines.join("\n"), /DETAILS/);
  assert.match(layout.lines.at(-4) ?? "", /Bereit/);
  assert.match(layout.lines.at(-2) ?? "", /\/help/);
  assert.match(layout.lines.at(-1) ?? "", /Ctrl\+C/);
});

test("model picker keeps the dashboard fixed and shows search details", () => {
  const layout = buildDashboardLayout({
    width: 100,
    height: 28,
    state,
    messages: messages(8),
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "Modell auswählen",
    busy: false,
    picker: {
      title: "Modell auswählen",
      query: "k",
      cursor: 1,
      models: [
        model("moonshotai/kimi-k3", "Kimi K3"),
        model("qwen/qwen3-coder", "Qwen Coder"),
      ],
      selectedIndex: 0,
      currentModel: "openrouter/auto",
    },
  });

  assert.match(layout.lines[0], /ROUTERCODE 0\.3/);
  assert.match(layout.lines.join("\n"), /MODELL AUSWÄHLEN/);
  assert.match(layout.lines.join("\n"), /moonshotai\/kimi-k3/);
  assert.match(layout.lines.join("\n"), /Kontext 131\.1K/);
  assert.match(layout.lines.at(-2) ?? "", /Suche.*k/);
  assert.match(layout.lines.at(-1) ?? "", /Enter übernehmen.*Esc abbrechen/);
});

test("slash input replaces the chat viewport with described command suggestions", () => {
  const layout = buildDashboardLayout({
    width: 100,
    height: 28,
    state,
    messages: messages(8),
    input: "/th",
    cursor: 3,
    scrollOffset: 0,
    status: "Bereit",
    busy: false,
    commandPalette: {
      input: "/th",
      commands: [
        {
          name: "think",
          usage: "/think [auto|off|Stufe|budget Tokens]",
          description: "Reasoning-Stufe oder Thinking-Budget steuern",
          acceptsArguments: true,
        },
      ],
      selectedIndex: 0,
    },
  });

  assert.match(layout.lines.join("\n"), /BEFEHLE/);
  assert.match(layout.lines.join("\n"), /\/think/);
  assert.match(layout.lines.join("\n"), /Thinking-Budget steuern/);
  assert.doesNotMatch(layout.lines.join("\n"), /Nachricht 7/);
  assert.match(layout.lines.at(-2) ?? "", /\/th/);
  assert.match(layout.lines.at(-1) ?? "", /Tab einsetzen.*Enter ausführen/);
});

test("secret entry never renders the actual API key", () => {
  const secret = "sk-or-v1-this-must-never-be-rendered";
  const layout = buildDashboardLayout({
    width: 90,
    height: 24,
    state,
    messages: [],
    input: secret,
    cursor: secret.length,
    scrollOffset: 0,
    status: "Key",
    busy: false,
    secret: { label: "OpenRouter API-Key" },
  });
  const rendered = layout.lines.join("\n");

  assert.doesNotMatch(rendered, /this-must-never-be-rendered/);
  assert.match(rendered, /Key › •+/);
  assert.match(rendered, /Eingabe bleibt verdeckt/);
});

test("terminal sanitizer removes CSI, OSC, DCS, and unsafe controls", () => {
  const unsafe = [
    "vor",
    "\u001b[31mrot\u001b[0m",
    "\u001b]0;Fenstertitel\u0007",
    "\u001b]52;c;Y2xpcGJvYXJk\u001b\\",
    "\u001bP1;2|payload\u001b\\",
    "\u0001",
    "nach",
  ].join("");

  assert.equal(sanitizeTerminalText(unsafe), "vorrotnach");
});

test("active run footer shows phase, elapsed time, last event, step, and tool", () => {
  const layout = buildDashboardLayout({
    width: 150,
    height: 30,
    state: {
      ...state,
      reasoning: "max",
      model: "moonshotai/kimi-k3",
      resolvedModel: "",
    },
    messages: messages(3),
    input: "",
    cursor: 0,
    scrollOffset: 0,
    status: "SHELL läuft",
    busy: true,
    queuedCount: 1,
    run: {
      model: "moonshotai/kimi-k3",
      phase: "SHELL läuft",
      startedAt: 1_000,
      lastEventAt: 35_000,
      step: 4,
      maxSteps: 12,
      toolCount: 3,
      activeTools: [
        {
          id: "tool-3",
          name: "run_command",
          summary: "./.venv/bin/python -m pytest tests/ -q",
          startedAt: 32_000,
        },
      ],
      inputTokens: 20_000,
      outputTokens: 4_000,
      reasoningTokens: 2_000,
      costUsd: 0.043,
      now: 39_000,
    },
  });

  assert.match(
    layout.lines.at(-4) ?? "",
    /AKTIV.*SHELL läuft.*00:38.*letztes Ereignis vor 00:04.*Schritt 4\/12.*1 vorgemerkt/,
  );
  assert.match(
    layout.lines.at(-3) ?? "",
    /TOOL SHELL.*pytest.*läuft 00:07/,
  );
  assert.match(layout.lines.at(-1) ?? "", /Enter vormerken.*Ctrl\+C Abbruch/);
});

test("interactive picker filters typed text and selects with arrow keys", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );
  const models = [
    model("alpha/default"),
    model("moonshotai/kimi-k3"),
    model("kilo/code"),
  ];

  ui.start();
  try {
    const selection = ui.pickModel(
      (query) => models.filter((item) => item.id.includes(query.toLowerCase())),
      "alpha/default",
      "Kompressor-Modell auswählen",
    );
    stdin.emit("keypress", "k", { name: "k", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "down", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });

    assert.equal((await selection)?.id, "kilo/code");
    const beforeReady = stdout.output.length;
    ui.setStatus("Bereit", false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(stdout.output, /KOMPRESSOR-MODELL AUSWÄHLEN/);
    assert.match(stdout.output, /Suche › k/);
    assert.match(stdout.output.slice(beforeReady), /● Bereit/);
  } finally {
    ui.stop();
  }
  assert.equal(stdin.isRaw, false);
});

test("ordinary f and F keys are accepted as text input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    stdin.emit("keypress", "f", {
      name: "f",
      ctrl: false,
      meta: false,
      shift: false,
    });
    stdin.emit("keypress", "F", {
      name: "f",
      ctrl: false,
      meta: false,
      shift: true,
    });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "fF");
  } finally {
    ui.stop();
  }
});

test("editor inserts text at the logical cursor position", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    for (const character of ["H", "l", "l", "o"]) {
      stdin.emit("keypress", character, {
        name: character.toLowerCase(),
        ctrl: false,
        meta: false,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      stdin.emit("keypress", "", { name: "left", ctrl: false, meta: false });
    }
    stdin.emit("keypress", "a", { name: "a", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "Hallo");
  } finally {
    ui.stop();
  }
});

test("submitted input clears immediately and busy typing is queued FIFO", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const first = ui.readInput();
    for (const character of "Erste Aufgabe") {
      stdin.emit("keypress", character, {
        name: character.toLowerCase(),
        ctrl: false,
        meta: false,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beforeSubmit = stdout.output.length;
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await first, "Erste Aufgabe");
    const submittedFrame = stdout.output.slice(beforeSubmit);
    assert.doesNotMatch(submittedFrame, /Erste Aufgabe/);
    assert.match(submittedFrame, /› █/);

    for (const character of "Zweite Aufgabe") {
      stdin.emit("keypress", character, {
        name: character.toLowerCase(),
        ctrl: false,
        meta: false,
      });
    }
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.match(stdout.output, /1 Nachricht vorgemerkt/);
    assert.equal(await ui.readInput(), "Zweite Aufgabe");
  } finally {
    ui.stop();
  }
});

test("resize performs a complete clear-screen redraw at the new geometry", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const beforeResize = stdout.output.length;
    stdout.columns = 175;
    stdout.rows = 55;
    process.emit("SIGWINCH");
    const redraw = stdout.output.slice(beforeResize);
    assert.match(redraw, /^\u001b\[2J\u001b\[H/);
    assert.match(redraw, /ROUTERCODE 0\.3/);
    assert.match(redraw, /\r\n/);
  } finally {
    ui.stop();
  }
});

test("assistant text after a tool is rendered after the completed tool card", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const startedAt = Date.now();
    ui.beginAssistant("moonshotai/kimi-k3");
    ui.handleRunEvent({
      type: "run-start",
      model: "moonshotai/kimi-k3",
      maxSteps: 12,
      timestamp: startedAt,
    });
    ui.appendAssistant("Text vor dem Tool.");
    ui.handleRunEvent({
      type: "tool-start",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: {
        command: "./.venv/bin/python -m pytest tests/ -q",
      },
      timestamp: startedAt + 100,
    });
    ui.handleRunEvent({
      type: "tool-end",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: {
        command: "./.venv/bin/python -m pytest tests/ -q",
      },
      output: {
        exitCode: 0,
        stdout: "116 passed in 0.47s\n",
        stderr: "",
        truncated: false,
      },
      durationMs: 470,
      timestamp: startedAt + 570,
    });
    ui.handleRunEvent({
      type: "model-start",
      model: "moonshotai/kimi-k3",
      step: 2,
      timestamp: startedAt + 571,
    });
    ui.appendAssistant("Text nach dem Tool.");

    const beforeResize = stdout.output.length;
    stdout.columns = 120;
    process.emit("SIGWINCH");
    const frame = stdout.output.slice(beforeResize);
    const beforeIndex = frame.indexOf("Text vor dem Tool.");
    const toolIndex = frame.indexOf("SHELL beendet");
    const afterIndex = frame.indexOf("Text nach dem Tool.");

    assert.ok(beforeIndex >= 0);
    assert.ok(toolIndex > beforeIndex);
    assert.ok(afterIndex > toolIndex);
    assert.match(frame, /Exit 0.*116 passed in 0\.47s/);
  } finally {
    ui.stop();
  }
});

test("uppercase T expands live provider reasoning while lowercase t remains text input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 34;
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const startedAt = Date.now();
    ui.beginAssistant("moonshotai/kimi-k3");
    ui.handleRunEvent({
      type: "run-start",
      model: "moonshotai/kimi-k3",
      maxSteps: 12,
      timestamp: startedAt,
    });
    ui.handleRunEvent({
      type: "reasoning",
      model: "moonshotai/kimi-k3",
      step: 1,
      delta: "Ich untersuche zunächst die betroffenen Dateien.\nDanach prüfe ich die Tests.",
      timestamp: startedAt + 10,
    });

    const beforeToggle = stdout.output.length;
    stdin.emit("keypress", "T", {
      name: "t",
      ctrl: false,
      meta: false,
      shift: true,
    });
    const expandedFrame = stdout.output.slice(beforeToggle);
    assert.match(expandedFrame, /DENKEN \[T zuklappen\]/);
    assert.match(expandedFrame, /Ich untersuche zunächst/);

    ui.finishAssistant("Fertig.");
    const input = ui.readInput();
    stdin.emit("keypress", "t", {
      name: "t",
      ctrl: false,
      meta: false,
      shift: false,
    });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "t");
  } finally {
    ui.stop();
  }
});

test("slash palette completes a partial command with Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    for (const character of ["/", "m", "o"]) {
      stdin.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
    }
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "/model");
    assert.match(stdout.output, /BEFEHLE/);
    assert.match(stdout.output, /Main-Modell suchen/);
  } finally {
    ui.stop();
  }
});

test("slash palette uses arrows and Tab without recalling chat history", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    stdin.emit("keypress", "/", { name: "/", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "down", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "tab", ctrl: false, meta: false });
    for (const character of ["h", "i", "g", "h"]) {
      stdin.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
    }
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "/think high");
  } finally {
    ui.stop();
  }
});

test("compress palette selects the interactive model subcommand", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    for (const character of "/compress") {
      stdin.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
    }
    assert.match(stdout.output, /\/compress model/);
    assert.match(stdout.output, /interaktiv suchen und auswählen/);
    stdin.emit("keypress", "", { name: "down", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "/compress model");
  } finally {
    ui.stop();
  }
});

test("Tab keeps the primary /allow command instead of rewriting it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const input = ui.readInput();
    for (const character of "/allow") {
      stdin.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
    }
    stdin.emit("keypress", "", { name: "tab", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "/allow");
  } finally {
    ui.stop();
  }
});

test("generic choice picker filters and returns the selected option", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    const selection = ui.pickChoice(
      "Thinking",
      [
        { value: "auto", label: "Automatisch", description: "Modellvorgabe" },
        { value: "high", label: "High", description: "Mehr Reasoning" },
      ],
      "auto",
    );
    stdin.emit("keypress", "h", { name: "h", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal((await selection)?.value, "high");
    assert.match(stdout.output, /THINKING/);
    assert.match(stdout.output, /Mehr Reasoning/);
  } finally {
    ui.stop();
  }
});

test("arrow keys submit a selected quick reply", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    ui.setSuggestedReplies([
      "Zeig mir den Diff",
      "Tests erneut ausführen",
    ]);
    const input = ui.readInput();
    stdin.emit("keypress", "", { name: "down", ctrl: false, meta: false });
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "Tests erneut ausführen");
    assert.match(stdout.output, /ANTWORTVORSCHLÄGE/);
  } finally {
    ui.stop();
  }
});

test("typing submits a custom reply instead of the selected suggestion", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );

  ui.start();
  try {
    ui.setSuggestedReplies(["Zeig mir den Diff", "Tests erneut ausführen"]);
    const input = ui.readInput();
    for (const character of "Mein eigener Kommentar") {
      stdin.emit("keypress", character, {
        name: character,
        ctrl: false,
        meta: false,
      });
    }
    stdin.emit("keypress", "", { name: "return", ctrl: false, meta: false });
    assert.equal(await input, "Mein eigener Kommentar");
  } finally {
    ui.stop();
  }
});

test("Ctrl+C requests cancellation during a busy run and restores raw mode on stop", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const ui = new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
  );
  let cancellations = 0;

  ui.start();
  ui.setStatus("Modell arbeitet");
  ui.setCancelHandler(() => {
    cancellations += 1;
  });
  stdin.emit("keypress", "\u0003", { name: "c", ctrl: true, meta: false });

  assert.equal(cancellations, 1);
  assert.match(stdout.output, /Abbruch angefordert/);
  ui.stop();
  assert.equal(stdin.isRaw, false);
  assert.match(stdout.output, /\u001b\[\?25h\u001b\[\?1049l/);
});
