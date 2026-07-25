import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReadStream, WriteStream } from "node:tty";
import {
  TerminalUi,
  buildDashboardFrame,
  sanitizeTerminalText,
  type DashboardFrameInput,
  type DashboardState,
} from "../src/tui.js";
import type { ChatBlock } from "../src/ui/blocks.js";
import { lineWidth, plainText, type Line } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { RunViewModel } from "../src/ui/view-model.js";
import type { ModelInfo } from "../src/types.js";

const theme = createTheme({ level: 0 });
const NOW = 1_700_000_000_000;

const state: DashboardState = {
  workspace: "/Users/demo/projects/robopet",
  projectStatus: "robopet · Git main*3 · 12 Chat-Nachrichten",
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

function text(lines: readonly Line[]): string {
  return lines.map((line) => plainText(line)).join("\n");
}

function input(overrides: Partial<DashboardFrameInput> = {}): DashboardFrameInput {
  return {
    width: 100,
    height: 28,
    theme,
    state,
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "Bereit",
    now: NOW,
    ...overrides,
  };
}

function chat(count: number): ChatBlock[] {
  const model = new RunViewModel();
  for (let index = 0; index < count; index += 1) {
    model.pushUser(`Frage ${index}`, 0, NOW + index);
    model.appendAssistant(
      `Antwort ${index}: ${"ausführlicher Text ".repeat(4)}`,
      NOW + index,
    );
    model.finishAssistant();
  }
  return [...model.blocks];
}

function modelInfo(id: string, name = id): ModelInfo {
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

function ui(stdin: FakeInput, stdout: FakeOutput): TerminalUi {
  return new TerminalUi(
    () => state,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );
}

function press(stdin: FakeInput, name: string, character = "", extra: Record<string, unknown> = {}): void {
  stdin.emit("keypress", character, { name, ctrl: false, meta: false, ...extra });
}

function type(stdin: FakeInput, value: string): void {
  for (const character of value) {
    press(stdin, character.toLowerCase(), character);
  }
}

test("frame fills the screen and keeps chrome, divider and input in place", () => {
  const frame = buildDashboardFrame(input({ blocks: chat(6), input: "Bitte prüfe die Tests", cursor: 21 }));

  assert.equal(frame.lines.length, 28);
  assert.match(plainText(frame.lines[0]!), /openrouter\/auto → moonshotai\/kimi-k3/);
  assert.match(plainText(frame.lines[0]!), /ask/);
  const divider = frame.lines.findIndex((line) => /^─{10,}$/.test(plainText(line)));
  assert.ok(divider > 0);
  assert.match(plainText(frame.lines.at(-1)!), /^▌ Bitte prüfe die Tests/);
  assert.deepEqual(frame.cursor, { row: 28, col: 24 });
});

test("a 10-line prompt shows 6 rows and 6/10 (Bauplan A6)", () => {
  const prompt = Array.from({ length: 10 }, (_, index) => `Zeile ${index}`).join("\n");
  const frame = buildDashboardFrame(input({ input: prompt, cursor: prompt.length }));
  const inputArea = frame.lines.slice(-6).map(plainText);

  assert.equal(inputArea.length, 6);
  assert.match(inputArea.join("\n"), /6\/10/);
  assert.match(inputArea.at(-1)!, /Zeile 9/);
});

test("Kontextfüllstand wird ab 80% in Rolle warn angezeigt (Bauplan A7)", () => {
  const below = buildDashboardFrame(input({ contextPercent: 79 }));
  const atThreshold = buildDashboardFrame(input({ contextPercent: 80 }));
  const belowSpan = below.lines[0]!.spans.find((item) => item.text.includes("79%"));
  const atSpan = atThreshold.lines[0]!.spans.find((item) => item.text.includes("80%"));

  assert.equal(belowSpan?.role, "muted");
  assert.equal(atSpan?.role, "warn");
});

test("secret label stays visible at 200 characters (Bauplan A6)", () => {
  const secret = "x".repeat(200);
  const frame = buildDashboardFrame(
    input({ mode: "secret", input: secret, cursor: secret.length, secretLabel: "OpenRouter API-Key" }),
  );
  const maskedRows = frame.lines.filter((item) => plainText(item).includes(theme.glyph("mask")));

  assert.ok(maskedRows.length > 0);
  for (const row of maskedRows) {
    assert.match(plainText(row), /OpenRouter API-Key/);
  }
  assert.doesNotMatch(text(frame.lines), /xxxxx/);
});

test("at rest only header, hint, divider and prompt are on screen", () => {
  const frame = buildDashboardFrame(input({ mode: "idle", status: "" }));
  const lines = frame.lines.map((line) => plainText(line));
  const divider = lines.findIndex((line) => /^─{10,}$/.test(line));

  assert.equal(lines.length, 28);
  assert.match(lines[divider - 1]!, /Schreib eine Aufgabe/);
  assert.equal(lines.at(-1), "▌ ");
  assert.equal(lines.filter((line) => line.trim().length > 0).length, 4);
});

test("no rendered line is wider than the usable width", () => {
  for (const width of [40, 60, 100, 170]) {
    const frame = buildDashboardFrame(
      input({ width, blocks: chat(4), input: "x".repeat(300), cursor: 300 }),
    );
    for (const line of frame.lines) {
      assert.ok(lineWidth(line) <= width - 1, `width ${width}: ${plainText(line)}`);
    }
  }
});

test("a scrolled viewport adds an indicator line without eating a chat line", () => {
  const blocks = chat(12);
  const tail = buildDashboardFrame(input({ height: 24, blocks }));
  const anchor = { anchor: { blockId: blocks[0]!.id, lineOffset: 0 } };
  const scrolled = buildDashboardFrame(
    input({ height: 24, blocks, viewport: anchor, newLinesBelow: 12 }),
  );

  assert.equal(tail.lines.length, scrolled.lines.length);
  assert.deepEqual(plainText(tail.lines[0]!), plainText(scrolled.lines[0]!));
  assert.match(plainText(scrolled.lines[1]!), /↑ .*Zeilen darüber.*End springt ans Ende/);
  // The first chat line is still visible: the indicator is an extra row.
  assert.match(plainText(scrolled.lines[2]!), /Frage 0/);
  assert.match(text(scrolled.lines), /↓ 12 neue Zeilen/);
});

test("an approval keeps its details once on screen and offers j and n", () => {
  const model = new RunViewModel();
  model.pushApproval({
    risk: "shell",
    summary: "SHELL · Tests ausführen",
    details: ["npm test", "in ~/projekt/routercode"],
    rememberHint: "keine gemerkte Regel für „npm“",
  });
  const frame = buildDashboardFrame(
    input({ mode: "confirm", blocks: [...model.blocks], waitingSince: NOW - 14_000 }),
  );
  const screen = text(frame.lines);

  assert.match(screen, /⚠ Freigabe · SHELL · Tests ausführen/);
  assert.equal(screen.match(/npm test/g)?.length, 1);
  assert.match(screen, /wartet seit 00:14/);
  assert.match(plainText(frame.lines.at(-1)!), /j ja · n nein · Enter = nein/);
});

test("assistant Markdown is translated instead of stripped", () => {
  const model = new RunViewModel();
  model.appendAssistant(
    "## Ergebnis\n- **Tests** laufen mit `npm test` erfolgreich.",
    NOW,
  );
  const frame = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  const screen = text(frame.lines);

  assert.match(screen, /Ergebnis/);
  assert.match(screen, /– Tests laufen mit npm test/);
  assert.doesNotMatch(screen, /\*\*|## /);
});

test("the expansion area lists commands aligned on the longest visible name", () => {
  const frame = buildDashboardFrame(
    input({
      input: "/m",
      cursor: 2,
      list: {
        entries: [
          { name: "/model", description: "Main-Modell auswählen" },
          { name: "/max-cost", description: "Kostenlimit setzen" },
        ],
        selectedIndex: 1,
      },
    }),
  );
  const lines = frame.lines.map((line) => plainText(line));
  const first = lines.find((line) => line.includes("/model"))!;
  const second = lines.find((line) => line.includes("/max-cost"))!;

  assert.equal(first.indexOf("Main-Modell"), second.indexOf("Kostenlimit"));
  assert.match(second, /^› \/max-cost/);
  assert.match(second, /2 von 2/);
  assert.match(lines.at(-1)!, /Tab einsetzen · Enter vervollständigen · Esc Liste schließen/);
});

test("pending image attachments are reported in the status line", () => {
  const frame = buildDashboardFrame(input({ blocks: chat(2), attachmentCount: 2 }));
  assert.match(text(frame.lines), /2 Bilder bereit/);
});

test("reasoning collapses to one line and expands on Ctrl+T", () => {
  const model = new RunViewModel();
  model.apply({
    type: "reasoning",
    model: "moonshotai/kimi-k3",
    step: 1,
    delta: "Ich prüfe zuerst die Projektstruktur. Danach die Tests.",
    timestamp: NOW,
  });
  const collapsed = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  assert.match(text(collapsed.lines), /denkt · 0 Tokens · Ctrl\+T aufklappen/);

  model.toggle(model.blocks[0]!.id);
  const expanded = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  assert.match(text(expanded.lines), /Ctrl\+T einklappen/);
  assert.match(text(expanded.lines), /Ich prüfe zuerst die Projektstruktur/);
});

test("reasoning tokens without provider text never fake thoughts", () => {
  const model = new RunViewModel();
  model.apply({ type: "reasoning", model: "p/m", step: 1, delta: "   ", timestamp: NOW });
  const frame = buildDashboardFrame(input({ blocks: [...model.blocks] }));
  const shown = frame.lines.map((line) => plainText(line)).filter((line) => line.includes("denkt"));

  assert.equal(shown.length, 1);
  assert.match(shown[0]!, /denkt · 0 Tokens/);
});

test("small terminals drop chrome instead of the stream, tiny ones refuse", () => {
  const small = buildDashboardFrame(input({ width: 60, height: 12, blocks: chat(4) }));
  assert.equal(small.lines.length, 12);
  assert.ok(small.chatHeight >= 5);

  const short = buildDashboardFrame(input({ width: 60, height: 8, blocks: chat(4) }));
  assert.ok(short.chatHeight >= 5);
  assert.doesNotMatch(plainText(short.lines[0]!), /openrouter/);

  const tiny = buildDashboardFrame(input({ width: 39, height: 8 }));
  assert.equal(tiny.lines.length, 1);
  assert.match(plainText(tiny.lines[0]!), /Terminal zu klein \(mindestens 40×8/);
});

test("a running tool shows exactly one spinner, phase, step and cost", () => {
  const model = new RunViewModel();
  model.apply({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
  model.apply({
    type: "tool-start",
    id: "t1",
    number: 1,
    name: "run_command",
    input: { command: "npm run check" },
    timestamp: NOW,
  });
  const frame = buildDashboardFrame(
    input({
      mode: "busy",
      blocks: [...model.blocks],
      now: NOW + 7_000,
      run: {
        phase: "Tool läuft",
        startedAt: NOW,
        lastEventAt: NOW + 5_000,
        step: 4,
        maxSteps: 12,
        costUsd: 0.043,
        running: true,
      },
    }),
  );
  const screen = text(frame.lines);

  assert.match(screen, /Tool läuft/);
  assert.match(screen, /00:07/);
  assert.match(screen, /Schritt 4\/12/);
  assert.match(screen, /\$0\.0430/);
  assert.match(screen, /npm run check/);
});

test("secret entry never renders the actual API key", () => {
  const secret = "sk-or-v1-this-must-never-be-rendered";
  const frame = buildDashboardFrame(
    input({
      mode: "secret",
      input: secret,
      cursor: secret.length,
      secretLabel: "OpenRouter API-Key",
    }),
  );
  const screen = text(frame.lines);

  assert.doesNotMatch(screen, /this-must-never-be-rendered/);
  assert.match(screen, /▌ •+/);
  assert.match(screen, /Eingabe bleibt verdeckt/);
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

test("interactive picker filters typed text and selects with arrow keys", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const models = [modelInfo("alpha/default"), modelInfo("moonshotai/kimi-k3"), modelInfo("kilo/code")];

  terminal.start();
  try {
    const selection = terminal.pickModel(
      (query) => models.filter((item) => item.id.includes(query.toLowerCase())),
      "alpha/default",
      "Kompressor-Modell auswählen",
    );
    press(stdin, "k", "k");
    press(stdin, "down");
    press(stdin, "return");

    assert.equal((await selection)?.id, "kilo/code");
    assert.match(stdout.output, /kilo\/code/);
    assert.match(stdout.output, /▌ k/);
  } finally {
    terminal.stop();
  }
  assert.equal(stdin.isRaw, false);
});

test("ordinary f, F and T keys are accepted as text input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "f", "f");
    press(stdin, "f", "F", { shift: true });
    press(stdin, "t", "T", { shift: true });
    press(stdin, "return");
    assert.equal(await value, "fFT");
  } finally {
    terminal.stop();
  }
});

test("editor inserts text at the logical cursor position", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "Hllo");
    for (let index = 0; index < 3; index += 1) press(stdin, "left");
    press(stdin, "a", "a");
    press(stdin, "return");
    assert.equal(await value, "Hallo");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+A/E, Ctrl+U/K and Ctrl+W edit the current line only (Bauplan A6)", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "erste Zeile");
    press(stdin, "return", "", { shift: true });
    type(stdin, "zweite Zeile");
    // Ctrl+A must land at the start of the *current* (second) line.
    press(stdin, "a", "a", { ctrl: true });
    press(stdin, "x", "x");
    terminal.refresh();
    assert.match(stdout.output, /xzweite Zeile/);

    // Ctrl+K clears from the cursor to the end of the current line.
    press(stdin, "k", "k", { ctrl: true });
    terminal.refresh();
    assert.ok(
      stdout.output.lastIndexOf("▌ x[K") > stdout.output.lastIndexOf("zweite"),
      "the line should be cleared after the cursor",
    );

    // Ctrl+E jumps to line end, then Ctrl+W deletes the previous word.
    press(stdin, "e", "e", { ctrl: true });
    press(stdin, "w", "w", { ctrl: true });
    press(stdin, "return");
    assert.equal(await value, "erste Zeile");
  } finally {
    terminal.stop();
  }
});

test("submitted input clears immediately and busy typing is queued FIFO", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "Erste Aufgabe");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beforeSubmit = stdout.output.length;
    press(stdin, "return");
    assert.equal(await first, "Erste Aufgabe");
    assert.doesNotMatch(stdout.output.slice(beforeSubmit), /Erste Aufgabe/);

    type(stdin, "Zweite Aufgabe");
    press(stdin, "return");
    assert.match(stdout.output, /1 Nachricht vorgemerkt/);
    assert.equal(await terminal.readInput(), "Zweite Aufgabe");
  } finally {
    terminal.stop();
  }
});

test("bracketed multiline paste is inserted once and only submits on a later Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start");
    type(stdin, "Erste Zeile");
    press(stdin, "enter", "\n");
    type(stdin, "Zweite Zeile");
    press(stdin, "paste-end");
    await Promise.resolve();

    assert.equal(settled, false);
    assert.match(stdout.output, /2 Zeilen eingefügt/);
    assert.match(stdout.output, /Erste Zeile/);
    assert.match(stdout.output, /\u001b\[\?2004h/);

    press(stdin, "return");
    assert.equal(await value, "Erste Zeile\nZweite Zeile");
  } finally {
    terminal.stop();
  }
  assert.match(stdout.output, /\u001b\[\?2004l/);
});

test("a paste without its end marker still lets Ctrl+C through", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  let cancellations = 0;

  terminal.start();
  try {
    terminal.setStatus("Modell arbeitet");
    terminal.setCancelHandler(() => {
      cancellations += 1;
    });
    press(stdin, "paste-start");
    type(stdin, "halb eingefügt");
    press(stdin, "c", "", { ctrl: true });

    assert.equal(cancellations, 1);
    assert.match(stdout.output, /Abbruch angefordert/);
  } finally {
    terminal.stop();
  }
});

test("resize redraws without a full clear and repositions the real cursor", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const beforeResize = stdout.output.length;
    stdout.columns = 175;
    stdout.rows = 55;
    process.emit("SIGWINCH");
    const redraw = stdout.output.slice(beforeResize);

    assert.doesNotMatch(redraw, /\u001b\[2J/);
    assert.match(redraw, /^\u001b\[\?25l\u001b\[H/);
    assert.match(redraw, /\u001b\[K\r\n/);
    assert.match(redraw, /\u001b\[J\u001b\[\d+;\d+H\u001b\[\?25h$/);
  } finally {
    terminal.stop();
  }
});

test("assistant text after a tool is rendered after the completed tool card", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.beginAssistant("moonshotai/kimi-k3");
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.appendAssistant("Text vor dem Tool.");
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "python -m pytest" },
      timestamp: NOW + 100,
    });
    terminal.handleRunEvent({
      type: "tool-end",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "python -m pytest" },
      output: { exitCode: 0, stdout: "116 passed in 0.47s\n", stderr: "", truncated: false },
      durationMs: 470,
      timestamp: NOW + 570,
    });
    terminal.appendAssistant("Text nach dem Tool.");

    const screen = text(terminal.frame().lines);
    const before = screen.indexOf("Text vor dem Tool.");
    const tool = screen.indexOf("python -m pytest");
    const after = screen.indexOf("Text nach dem Tool.");

    assert.ok(before >= 0);
    assert.ok(tool > before);
    assert.ok(after > tool);
    // exit 0 earns the verified glyph, everything else would only get `~`.
    assert.match(screen, /✓ python -m pytest/);
  } finally {
    terminal.stop();
  }
});

test("Ctrl+T toggles the reasoning block, a bare T does not", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 34;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "reasoning",
      model: "m",
      step: 1,
      delta: "Ich untersuche zunächst die betroffenen Dateien.",
      timestamp: NOW + 10,
    });
    assert.match(text(terminal.frame().lines), /Ctrl\+T aufklappen/);

    press(stdin, "t", "", { ctrl: true });
    const expanded = text(terminal.frame().lines);
    assert.match(expanded, /Ctrl\+T einklappen/);
    assert.match(expanded, /Ich untersuche zunächst/);

    terminal.finishAssistant("Fertig.");
    const value = terminal.readInput();
    press(stdin, "t", "T", { shift: true });
    press(stdin, "return");
    assert.equal(await value, "T");
  } finally {
    terminal.stop();
  }
});

test("Enter in the command list completes first and executes only afterwards", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/mo");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "return");
    await Promise.resolve();
    assert.equal(settled, false);
    assert.match(stdout.output, /▌ \/model/);

    press(stdin, "return");
    assert.equal(await value, "/model");
  } finally {
    terminal.stop();
  }
});

test("Esc closes the command list and keeps the typed text", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/mo");
    assert.match(stdout.output, /Main-Modell/);
    press(stdin, "escape");
    const afterEscape = stdout.output.length;
    terminal.refresh();
    assert.doesNotMatch(stdout.output.slice(afterEscape), /Esc Liste schließen/);

    press(stdin, "return");
    assert.equal(await value, "/mo");
  } finally {
    terminal.stop();
  }
});

test("command list uses arrows and Tab without recalling chat history", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    press(stdin, "/", "/");
    press(stdin, "down");
    press(stdin, "tab");
    type(stdin, "high");
    press(stdin, "return");
    assert.equal(await value, "/think high");
  } finally {
    terminal.stop();
  }
});

test("@ opens fuzzy file completion and Tab inserts the relative path", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "routercode-at-"));
  writeFileSync(join(workspace, "compressor.ts"), "// stub");
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const localState: DashboardState = { ...state, workspace };
  const terminal = new TerminalUi(
    () => localState,
    stdin as unknown as ReadStream,
    stdout as unknown as WriteStream,
    theme,
  );

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "sieh dir @compr");
    terminal.refresh();
    assert.match(stdout.output, /compressor\.ts/);
    press(stdin, "tab");
    type(stdin, "an");
    press(stdin, "return");
    assert.equal(await value, "sieh dir compressor.ts an");
  } finally {
    terminal.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Ctrl+R searches the own history; Tab inserts, Esc leaves the buffer alone", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.readInput();
    type(stdin, "npm test ausführen");
    press(stdin, "return");
    assert.equal(await first, "npm test ausführen");

    const second = terminal.readInput();
    press(stdin, "r", "r", { ctrl: true });
    type(stdin, "npm");
    terminal.refresh();
    assert.match(stdout.output, /npm test ausführen/);
    press(stdin, "tab");
    press(stdin, "return");
    assert.equal(await second, "npm test ausführen");
  } finally {
    terminal.stop();
  }
});

test("compress list selects the interactive model subcommand", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/compress");
    assert.match(stdout.output, /\/compress model/);
    press(stdin, "down");
    press(stdin, "return");
    press(stdin, "return");
    assert.equal(await value, "/compress model");
  } finally {
    terminal.stop();
  }
});

test("Tab keeps the primary /allow command instead of rewriting it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const value = terminal.readInput();
    type(stdin, "/allow");
    press(stdin, "tab");
    press(stdin, "return");
    assert.equal(await value, "/allow");
  } finally {
    terminal.stop();
  }
});

test("generic choice picker filters and returns the selected option", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const selection = terminal.pickChoice(
      "Thinking",
      [
        { value: "auto", label: "Automatisch", description: "Modellvorgabe" },
        { value: "high", label: "High", description: "Mehr Reasoning" },
      ],
      "auto",
    );
    press(stdin, "h", "h");
    press(stdin, "return");
    assert.equal((await selection)?.value, "high");
    assert.match(stdout.output, /Mehr Reasoning/);
  } finally {
    terminal.stop();
  }
});

test("arrow keys submit a selected quick reply, typing overrides it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    terminal.setSuggestedReplies(["Zeig mir den Diff", "Tests erneut ausführen"]);
    const first = terminal.readInput();
    press(stdin, "down");
    press(stdin, "return");
    assert.equal(await first, "Tests erneut ausführen");
    assert.match(stdout.output, /Zeig mir den Diff/);

    terminal.setSuggestedReplies(["Zeig mir den Diff"]);
    const second = terminal.readInput();
    type(stdin, "Mein eigener Kommentar");
    press(stdin, "return");
    assert.equal(await second, "Mein eigener Kommentar");
  } finally {
    terminal.stop();
  }
});

test("an approval accepts j as well as y and answers unbound keys", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const first = terminal.confirmApproval({
      name: "run_command",
      risk: "shell",
      summary: "rm -rf build",
      details: "rm -rf build dist",
    });
    press(stdin, "q", "q");
    assert.match(stdout.output, /Nicht belegt · j ja · n nein/);
    press(stdin, "j", "j");
    assert.deepEqual(await first, { accepted: true });

    const second = terminal.confirmAction("Sitzung löschen", "alles weg");
    press(stdin, "n", "n");
    assert.deepEqual(await second, { accepted: false });
  } finally {
    terminal.stop();
  }
});

test("a immer remembers allow, d nie remembers deny, g asks for a reason", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const allow = terminal.confirmAction("SHELL · npm test", "npm test");
    press(stdin, "a", "a");
    assert.deepEqual(await allow, { accepted: true, remember: "allow" });

    const deny = terminal.confirmAction("SHELL · rm -rf", "rm -rf build");
    press(stdin, "d", "d");
    assert.deepEqual(await deny, { accepted: false, remember: "deny" });

    const reasoned = terminal.confirmAction("SHELL · curl", "curl example.com");
    press(stdin, "g", "g");
    assert.match(stdout.output, /Begründung eingeben/);
    type(stdin, "sieht verdächtig aus");
    press(stdin, "return");
    assert.deepEqual(await reasoned, { accepted: false, reason: "sieht verdächtig aus" });
  } finally {
    terminal.stop();
  }
});

test("scrolling back survives new tool output and End returns to the tail", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 20;
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    for (const turn of chat(8)) {
      if (turn.kind === "user") terminal.addMessage("user", turn.text);
      else if (turn.kind === "assistant") terminal.addMessage("assistant", turn.text);
    }
    press(stdin, "pageup");
    const before = plainText(terminal.frame().lines[2]!);
    assert.match(plainText(terminal.frame().lines[1]!), /Zeilen darüber/);

    terminal.handleRunEvent({ type: "run-start", model: "m", maxSteps: 12, timestamp: NOW });
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-1",
      number: 1,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: NOW,
    });

    // R9: new content must not yank a scrolled-back viewport to the end.
    assert.equal(plainText(terminal.frame().lines[2]!), before);
    assert.match(text(terminal.frame().lines), /neue Zeilen/);

    press(stdin, "end");
    assert.doesNotMatch(plainText(terminal.frame().lines[1]!), /Zeilen darüber/);
  } finally {
    terminal.stop();
  }
});

test("Ctrl+C requests cancellation during a busy run and restores raw mode on stop", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  let cancellations = 0;

  terminal.start();
  terminal.setStatus("Modell arbeitet");
  terminal.setCancelHandler(() => {
    cancellations += 1;
  });
  press(stdin, "c", "", { ctrl: true });

  assert.equal(cancellations, 1);
  assert.match(stdout.output, /Abbruch angefordert/);
  terminal.stop();
  assert.equal(stdin.isRaw, false);
  assert.match(stdout.output, /\u001b\[\?25h\u001b\[\?1049l/);
});

test("Enter stops a /whisper recording, Escape cancels it", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const stopped = terminal.awaitRecordingControl("Aufnahme läuft · 0s · Enter stoppt · Esc bricht ab");
    terminal.updateRecordingStatus("Aufnahme läuft · 3s · Enter stoppt · Esc bricht ab");
    assert.match(stdout.output, /Aufnahme läuft · 3s/);
    press(stdin, "return");
    assert.equal(await stopped, "stop");

    const cancelled = terminal.awaitRecordingControl("Aufnahme läuft · 0s");
    press(stdin, "escape");
    assert.equal(await cancelled, "cancel");
  } finally {
    terminal.stop();
  }
});

test("Ctrl+C during a recording cancels it instead of exiting", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const recording = terminal.awaitRecordingControl("Aufnahme läuft · 0s");
    press(stdin, "c", "", { ctrl: true });
    assert.equal(await recording, "cancel");
  } finally {
    terminal.stop();
  }
});

test("triggerRecordingControl ends the recording programmatically, e.g. on a hard limit", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const recording = terminal.awaitRecordingControl("Aufnahme läuft · 0s");
    terminal.triggerRecordingControl("stop");
    assert.equal(await recording, "stop");
    // A no-op once the mode has already moved on -- must not throw or hang.
    terminal.triggerRecordingControl("stop");
  } finally {
    terminal.stop();
  }
});

test("insertInputText lands text in the input line, appending rather than replacing", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    void terminal.readInput().catch(() => {});
    terminal.insertInputText("Hallo Welt");
    assert.match(text(terminal.frame().lines), /Hallo Welt/);

    type(stdin, " bitte");
    assert.match(text(terminal.frame().lines), /Hallo Welt bitte/);

    terminal.insertInputText("und noch mehr");
    assert.match(text(terminal.frame().lines), /Hallo Welt bitte und noch mehr/);
  } finally {
    terminal.stop();
  }
});
