import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import type { AgentRunEvent, ModelInfo } from "../src/types.js";
import { handleSlashCommand, type CommandContext } from "../src/commands.js";
import * as credentialsModule from "../src/credentials.js";
import { createTuiSetupSurface, type TuiSetupPromptUi } from "../src/setup-ui.js";

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

function awsCaptureLabels(): Array<{ name: string; label: string }> {
  return [
    { name: "bare-equals", label: "aws_secret_access_key=" },
    { name: "spaced-double-value", label: 'aws_secret_access_key =  "' },
    { name: "double-quoted-json", label: 'aws_secret_access_key" : "' },
    { name: "single-quoted-tabbed", label: "AWS-SECRET-ACCESS-KEY'\t=\t'" },
  ];
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

function emitTerminalData(stdin: FakeInput, value: string): void {
  const listener = stdin.listeners("data")[0];
  assert.ok(listener, "TerminalUi raw-data listener must be installed first");
  listener(Buffer.from(value));
}

function pressReadlineEscape(stdin: FakeInput): void {
  emitTerminalData(stdin, "\u001b");
  press(stdin, "escape", "", { sequence: "\u001b" });
}

function type(stdin: FakeInput, value: string): void {
  for (const character of value) {
    press(stdin, character.toLowerCase(), character);
  }
}

test("setup TUI surface uses the existing picker, secret, model, and confirm primitives", async () => {
  const calls: string[] = [];
  const promptUi: TuiSetupPromptUi = {
    async pickChoice(_title, items) {
      calls.push(`choice:${items[0]?.value}`);
      return items[0] ?? null;
    },
    async readSecret() { calls.push("secret"); return "candidate"; },
    async pickModel(search) { calls.push(`model:${search("")[0]?.id}`); return search("")[0] ?? null; },
    async confirmAction() { calls.push("confirm"); return { accepted: true }; },
    addMessage(_role, message) { calls.push(`notice:${message}`); },
    setStatus(status) { calls.push(`status:${status}`); },
  };
  const surface = createTuiSetupSurface(promptUi);

  assert.equal(await surface.chooseHub([{ id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 3 }]), "anthropic");
  assert.equal(await surface.readSecret({ backendId: "openrouter", message: "Key" }), "candidate");
  assert.equal(await surface.chooseModel({ backendId: "openrouter", models: [{ backendId: "openrouter", requestedModelId: "vendor/a", canonicalModelId: "vendor/a", displayName: "A", capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false } }] }), "vendor/a");
  assert.equal(await surface.confirm({ id: "save", message: "Save?", defaultValue: true }), true);
  surface.present({ version: 1, type: "notice", message: "Coming soon" });
  assert.deepEqual(calls, ["choice:anthropic", "secret", "model:vendor/a", "confirm", "status:Coming soon"]);
});

test("choice picker parses real SGR mouse bytes into the same Anthropic selection as keyboard", async () => {
  async function select(method: "keyboard" | "mouse"): Promise<string | null> {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      if (method === "keyboard") {
        press(stdin, "down");
        press(stdin, "return");
      } else {
        const row = terminal.frame().lines.findIndex((line) => plainText(line).includes("Anthropic")) + 1;
        assert.ok(row > 0, "Anthropic must occupy a visible picker row");
        stdin.emit("data", Buffer.from(`\u001b[<0;1;${row}M`));
      }
      const selected = await picked;
      assert.match(stdout.output, /\u001b\[\?1000h\u001b\[\?1006h/);
      return selected?.value ?? null;
    } finally {
      terminal.stop();
      assert.match(stdout.output, /\u001b\[\?1000l\u001b\[\?1006l/);
    }
  }

  assert.equal(await select("keyboard"), "anthropic");
  assert.equal(await select("mouse"), "anthropic");
});

test("Readline standalone Escape cancels a choice picker and disables mouse reporting", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let picker: Promise<{ value: string } | null> | null = null;
  try {
    picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    void picker.then(() => {
      settled = true;
    });

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle the picker");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.match(text(terminal.frame().lines), /Auswahl abgebrochen/);
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await picker;
    }
    terminal.stop();
  }
});

test("Readline standalone Escape cancels a model picker and disables mouse reporting", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let picker: Promise<ModelInfo | null> | null = null;
  try {
    picker = terminal.pickModel(() => [modelInfo("vendor/a")], "vendor/a");
    void picker.then(() => {
      settled = true;
    });

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle the picker");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.match(text(terminal.frame().lines), /Auswahl abgebrochen/);
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await picker;
    }
    terminal.stop();
  }
});

test("Readline standalone Escape cancels secret entry and clears its input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  let settled = false;
  let secret: Promise<string | null> | null = null;
  try {
    secret = terminal.readSecret("OpenRouter API-Key");
    void secret.then(() => {
      settled = true;
    });
    type(stdin, "stale-secret");

    pressReadlineEscape(stdin);
    await Promise.resolve();

    assert.equal(settled, true, "completed Escape keypress must settle secret entry");
    assert.equal(await secret, null);
    assert.match(text(terminal.frame().lines), /Eingabe abgebrochen/);
    const next = terminal.readInput();
    type(stdin, "clean");
    press(stdin, "return");
    assert.equal(await next, "clean");
  } finally {
    if (!settled) {
      press(stdin, "c", "\u0003", { ctrl: true });
      await secret;
    }
    terminal.stop();
  }
});

test("SGR mouse parsing accepts every split escape prefix without leaking into the picker", async () => {
  for (const prefixLength of [1, 2, 3]) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    let picked: Promise<{ value: string } | null> | null = null;
    try {
      picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      const row = terminal.frame().lines.findIndex((line) => plainText(line).includes("Anthropic")) + 1;
      const packet = `\u001b[<0;1;${row}M`;
      stdin.emit("data", Buffer.from(packet.slice(0, prefixLength)));
      stdin.emit("data", Buffer.from(packet.slice(prefixLength)));

      const selected = await Promise.race([
        picked.then((item) => item?.value ?? null),
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      assert.equal(selected, "anthropic", `split ${prefixLength}`);
    } finally {
      press(stdin, "escape");
      await picked;
      terminal.stop();
    }
  }
});

test("ESC [ followed by a divergent non-mouse escape resets before the next chat key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b["));
    stdin.emit("data", Buffer.from("\u001b"));
    stdin.emit("data", Buffer.from("a"));
    stdin.emit("data", Buffer.from("\u001b[<0;1;1M"));
    press(stdin, "return");

    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("ESC [ < followed by a divergent non-mouse escape resets before the next secret key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const secret = terminal.readSecret("OpenRouter API-Key");
    stdin.emit("data", Buffer.from("\u001b[<"));
    stdin.emit("data", Buffer.from("\u001b"));
    stdin.emit("data", Buffer.from("a"));
    press(stdin, "return");

    assert.equal(await secret, "a");
  } finally {
    terminal.stop();
  }
});

test("a malformed SGR prefix resets before the next ordinary input key", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b[<x"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    type(stdin, "a");
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("mouse reporting belongs only to a pending picker and ends at settlement", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    assert.doesNotMatch(stdout.output, /\u001b\[\?1000h\u001b\[\?1006h/);
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
    press(stdin, "return");
    assert.equal((await picker)?.value, "openrouter");
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    assert.ok(stdout.output.lastIndexOf(disable) > stdout.output.lastIndexOf(enable), stdout.output);
  } finally {
    terminal.stop();
  }
});

test("a pending picker re-enables SGR mouse only after suspend resumes it", async () => {
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
    ], "openrouter");
    await terminal.suspend(async () => undefined);
    assert.equal(stdout.output.split(enable).length - 1, 2, stdout.output);
    assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
    press(stdin, "escape");
    assert.equal(await picker, null);
    assert.equal(stdout.output.split(disable).length - 1, 2, stdout.output);
  } finally {
    terminal.stop();
  }
});

test("mouse protocol rejects malformed, non-left, release, and out-of-range bytes without leaking into chat", async () => {
  const ignored = [
    "\u001b[<x;1;1M",
    "\u001b[<2;1;1M",
    "\u001b[<0;1;1m",
    "\u001b[<0;1;999M",
  ];
  for (const sequence of ignored) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const picked = terminal.pickChoice("Provider", [
        { value: "openrouter", label: "OpenRouter", description: "Ready" },
        { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
      ], "openrouter");
      stdin.emit("data", Buffer.from(sequence));
      await new Promise<void>((resolve) => setImmediate(resolve));
      press(stdin, "escape");
      assert.equal(await picked, null, sequence);
    } finally {
      terminal.stop();
    }
  }

  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("\u001b[<0;1;1M"));
    type(stdin, "a");
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("mouse reporting stays disabled after picker cancel across suspend and terminal stop", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const picker = terminal.pickChoice("Provider", [
      { value: "openrouter", label: "OpenRouter", description: "Ready" },
      { value: "anthropic", label: "Anthropic · Coming soon", description: "Coming soon" },
    ], "openrouter");
    press(stdin, "escape");
    assert.equal(await picker, null);
    await terminal.suspend(async () => undefined);
  } finally {
    terminal.stop();
  }
  const enable = "\u001b[?1000h\u001b[?1006h";
  const disable = "\u001b[?1000l\u001b[?1006l";
  assert.equal(stdout.output.split(enable).length - 1, 1, stdout.output);
  assert.equal(stdout.output.split(disable).length - 1, 1, stdout.output);
  assert.ok(stdout.output.lastIndexOf(disable) > stdout.output.lastIndexOf(enable), stdout.output);
});

test("partial SGR bytes are cleared before a restarted terminal accepts ordinary input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  stdin.emit("data", Buffer.from("\u001b[<0;1"));
  terminal.stop();
  terminal.start();
  try {
    const input = terminal.readInput();
    stdin.emit("data", Buffer.from("a"));
    press(stdin, "return");
    assert.equal(await input, "a");
  } finally {
    terminal.stop();
  }
});

test("raw terminal data ownership is inert before start and balanced across stop suspend and restart", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  assert.equal(stdin.listenerCount("data"), 0, "construction must not own a live raw listener");

  terminal.start();
  const firstActive = stdin.listenerCount("data");
  assert.ok(firstActive > 0);
  terminal.stop();
  const stopped = stdin.listenerCount("data");
  assert.equal(firstActive, stopped + 1, "stop must detach exactly the UI-owned raw listener");

  terminal.start();
  assert.equal(stdin.listenerCount("data"), firstActive, "restart must not accumulate listeners");
  await terminal.suspend(async () => {
    assert.equal(
      stdin.listenerCount("data"),
      stopped,
      "suspend must detach the UI-owned raw listener while the terminal is released",
    );
  });
  assert.equal(stdin.listenerCount("data"), firstActive, "resume must restore exactly one listener");

  terminal.stop();
  assert.equal(stdin.listenerCount("data"), stopped);
});

test("dispose permanently releases terminal input ownership", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  const active = stdin.listenerCount("data");
  terminal.dispose();
  assert.equal(terminal.active, false);
  assert.equal(stdin.listenerCount("data"), active - 1);
  terminal.dispose();
  terminal.start();
  assert.equal(terminal.active, false, "a disposed terminal must not reacquire raw input");
  assert.equal(stdin.listenerCount("data"), active - 1);
});

test("stop settles a pasted secret once and clears it before fallible terminal cleanup and restart", async () => {
  class FallibleOutput extends FakeOutput {
    failCleanup = false;

    override write(value: string | Uint8Array): boolean {
      if (this.failCleanup) throw new Error("fixed terminal cleanup failure");
      return super.write(value);
    }
  }

  const stdin = new FakeInput();
  const stdout = new FallibleOutput();
  const terminal = ui(stdin, stdout);
  let settlements = 0;

  terminal.start();
  const pending = terminal.readSecret("OpenRouter API-Key");
  void pending.then(() => {
    settlements += 1;
  });
  press(stdin, "paste-start");
  type(stdin, "stale-secret-bytes");
  press(stdin, "paste-end");
  emitTerminalData(stdin, "\u001b[<0;1");
  stdout.failCleanup = true;

  terminal.stop();
  const stoppedValue = await Promise.race([
    pending,
    new Promise<"still-pending">((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  assert.equal(stoppedValue, null);
  assert.equal(settlements, 1);

  stdout.failCleanup = false;
  terminal.start();
  const restarted = terminal.readSecret("OpenRouter API-Key");
  press(stdin, "return");
  assert.equal(await restarted, "", "restart must not resubmit bytes from the stopped secret");
  assert.equal(settlements, 1, "the stopped resolver must remain settled exactly once");

  const cleanInput = terminal.readInput();
  type(stdin, "clean-after-stop");
  press(stdin, "return");
  assert.equal(await cleanInput, "clean-after-stop");
  terminal.stop();
});

test("stop and restart preserve an ordinary chat draft", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  const input = terminal.readInput();
  type(stdin, "draft survives");
  terminal.stop();
  terminal.start();
  try {
    press(stdin, "return");
    assert.equal(await input, "draft survives");
  } finally {
    terminal.stop();
  }
});

test("suspend and resume preserve a pending secret until explicit submission", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const secret = terminal.readSecret("OpenRouter API-Key");
    type(stdin, "before-");
    await terminal.suspend(async () => undefined);
    type(stdin, "after");
    press(stdin, "return");
    assert.equal(await secret, "before-after");
  } finally {
    terminal.stop();
  }
});

test("setup TUI retry shows one latest current revision card at narrow and wide widths and replaces status", async () => {
  for (const columns of [58, 120]) {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stdout.columns = columns;
    const terminal = ui(stdin, stdout);
    const surface = createTuiSetupSurface(terminal);
    terminal.start();
    try {
      const initial = surface.chooseHub([
        { id: "openrouter", label: "OpenRouter", description: "Nicht verbunden", disabled: false, current: true, generation: 6 },
        { id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 6 },
      ]);
      press(stdin, "escape");
      await initial;
      surface.present({ version: 1, type: "notice", message: "Alter Fehler" });
      const choice = surface.chooseHub([
        { id: "openrouter", label: "OpenRouter", description: "Verbunden", disabled: false, current: true, generation: 7 },
        { id: "anthropic", label: "Anthropic", description: "Coming soon", disabled: true, current: false, generation: 7 },
      ]);
      surface.present({ version: 1, type: "notice", message: "Erfolgreich erneut verbunden" });
      const screen = terminal.frame().lines.map(plainText).join("\n");
      press(stdin, "escape");
      await choice;
      assert.equal((screen.match(/Aktuell r7/g) ?? []).length, 1, `width ${columns}\n${screen}`);
      assert.match(screen, /Anthropic · Coming soon/);
      assert.match(screen, /Erfolgreich erneut verbunden/);
      assert.doesNotMatch(screen, /Alter Fehler/);
    } finally {
      terminal.stop();
    }
  }
});

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
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    blocks: [...model.blocks],
    waitingSince: NOW - 14_000,
    rememberAvailable: true,
  }));
  const screen = text(frame.lines);

  assert.match(screen, /⚠ Freigabe · SHELL · Tests ausführen/);
  assert.equal(screen.match(/npm test/g)?.length, 1);
  assert.match(screen, /wartet seit 00:14/);
  assert.match(plainText(frame.lines.at(-1)!), /j ja · n nein · Enter = nein/);
  assert.match(plainText(frame.lines.at(-1)!), /a immer erlauben · d nie erlauben/);
});

test("the confirm footer hides remember actions when no safe subject exists", () => {
  const frame = buildDashboardFrame(input({
    mode: "confirm",
    waitingSince: NOW - 2_000,
    rememberAvailable: false,
  }));
  const footer = plainText(frame.lines.at(-1)!);

  assert.match(footer, /j ja · n nein · Enter = nein/);
  assert.doesNotMatch(footer, /immer erlauben|nie erlauben/);
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
  // While the panel is live the provider has not reported a count yet, so the
  // header shows a marked estimate. A plain "0 Tokens" here would be the bug
  // this test used to cement.
  assert.match(text(collapsed.lines), /denkt · ~\d+ Tokens · Ctrl\+T aufklappen/);

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

test("a running Kimi task renders provider-managed cost instead of a zero-dollar value", () => {
  const frame = buildDashboardFrame(
    input({
      mode: "busy",
      now: NOW + 1_000,
      state: { ...state, sessionCost: "providerverwaltet / unbekannt" },
      run: {
        phase: "Modell arbeitet",
        startedAt: NOW,
        lastEventAt: NOW,
        step: 1,
        maxSteps: 12,
        costUsd: 0,
        costKnowledge: "unknown",
        running: true,
      },
    }),
  );
  const screen = text(frame.lines);
  assert.match(screen, /providerverwaltet|unbekannt/i);
  assert.doesNotMatch(screen, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("an idle Kimi session keeps provider-managed cost visible in the dashboard header", () => {
  const frame = buildDashboardFrame(input({
    width: 160,
    state: { ...state, sessionCost: "providerverwaltet / unbekannt" },
  }));
  const header = plainText(frame.lines[0]!);
  assert.match(header, /providerverwaltet|unbekannt/i);
  assert.doesNotMatch(header, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("Kimi run-start marks live TUI cost unknown before the first model-end", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "k3",
      maxSteps: 12,
      prompt: "hello",
      costKnowledge: "unknown",
      timestamp: NOW,
    });
    const statusLine = plainText(terminal.frame().lines.at(-2)!);
    assert.match(statusLine, /providerverwaltet|unbekannt/i);
    assert.doesNotMatch(statusLine, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
  } finally {
    terminal.stop();
  }
});

test("secret entry never renders the actual API key", () => {
  const secret = `${["sk", "or", "v1"].join("-")}-this-must-never-be-rendered`;
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

test("secret bracketed paste preserves raw CRLF until common normalization, masks it, and waits for later Enter", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const body = `${["sk", "or", "v1"].join("-")}-${"r".repeat(48)}`;
  const raw = `\r\n${body}\r\n`;

  terminal.start();
  try {
    const value = terminal.readSecret("OpenRouter API-Key");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start");
    press(stdin, "enter", "\r\n");
    type(stdin, body);
    press(stdin, "enter", "\r\n");
    press(stdin, "paste-end");
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(settled, false, "paste-end must not submit a secret");
    assert.doesNotMatch(stdout.output, new RegExp(body));
    assert.match(stdout.output, /•{8,}/);

    press(stdin, "return");
    const received = await value;
    assert.equal(received, raw);
    assert.equal(
      (credentialsModule as typeof credentialsModule & {
        normalizeProviderSecret(value: string): string;
      }).normalizeProviderSecret(received ?? ""),
      body,
    );
  } finally {
    terminal.stop();
  }
});

test("secret paste preserves non-framing readline key.sequence bytes for rejection and clears the next input", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const body = `candidate-${"q".repeat(32)}`;
  const raw = `${body}\u001b[31m\0\r\n`;
  const normalize = (credentialsModule as typeof credentialsModule & {
    normalizeProviderSecret(value: string): string;
  }).normalizeProviderSecret;

  terminal.start();
  try {
    const value = terminal.readSecret("OpenRouter API-Key");
    let settled = false;
    void value.then(() => {
      settled = true;
    });
    press(stdin, "paste-start", "", { sequence: "\u001b[200~" });
    type(stdin, body);
    press(stdin, "unknown", "", { sequence: "\u001b[31m" });
    press(stdin, "unknown", "", { sequence: "\0" });
    press(stdin, "enter", "", { sequence: "\r\n" });
    press(stdin, "paste-end", "", { sequence: "\u001b[201~" });
    await Promise.resolve();

    assert.equal(settled, false, "paste-end must not submit a secret");
    assert.doesNotMatch(stdout.output, new RegExp(body));
    assert.match(stdout.output, /•{8,}/);

    press(stdin, "return");
    const received = await value;
    assert.equal(received, raw);
    assert.throws(() => normalize(received ?? ""), /ungültig|Steuer|Leerzeichen/i);

    const next = terminal.readInput();
    type(stdin, "clean-next-input");
    press(stdin, "return");
    assert.equal(await next, "clean-next-input");
  } finally {
    terminal.stop();
  }
});

test("secret success, validation error, and cancellation leave the next input buffer clean", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);
  const normalize = (credentialsModule as typeof credentialsModule & {
    normalizeProviderSecret(value: string): string;
  }).normalizeProviderSecret;

  terminal.start();
  try {
    const invalid = terminal.readSecret("OpenRouter API-Key");
    press(stdin, "paste-start");
    type(stdin, "bad key");
    press(stdin, "paste-end");
    press(stdin, "return");
    const invalidValue = await invalid;
    assert.throws(() => normalize(invalidValue ?? ""), /ungültig|Leerzeichen/i);

    const afterError = terminal.readInput();
    type(stdin, "nach-fehler");
    press(stdin, "return");
    assert.equal(await afterError, "nach-fehler");

    const cancelled = terminal.readSecret("OpenRouter API-Key");
    press(stdin, "paste-start");
    type(stdin, "stale-secret-bytes");
    press(stdin, "c", "\u0003", { ctrl: true });
    assert.equal(await cancelled, null);

    const afterCancel = terminal.readInput();
    type(stdin, "nach-abbruch");
    press(stdin, "return");
    assert.equal(await afterCancel, "nach-abbruch");
  } finally {
    terminal.stop();
  }
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

test("volatile process events render live and one terminal event does not duplicate the tail", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "process-start",
      id: "direct-diff-1",
      name: "git_diff",
      input: { staged: false },
      timestamp: NOW,
    } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-output",
      id: "direct-diff-1",
      name: "git_diff",
      stream: "stdout",
      text: "+live-line\n",
      timestamp: NOW + 1,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /live-line/);

    const terminalEvent = {
      type: "process-end",
      id: "direct-diff-1",
      name: "git_diff",
      input: { staged: false },
      exitCode: 0,
      durationMs: 20,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 20,
    } as AgentRunEvent;
    terminal.handleRunEvent(terminalEvent);
    terminal.handleRunEvent(terminalEvent);
    const screen = text(terminal.frame().lines);
    assert.ok((screen.match(/live-line/g)?.length ?? 0) <= 1);
    assert.equal(screen.match(/Arbeitsbaum/g)?.length, 1);
  } finally {
    terminal.stop();
  }
});

test("automatic verification uses one process card and renders the root unverified terminal once", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "edit",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "task9-verify",
      name: "verify",
      input: { command: "task9-check" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-output",
      id: "task9-verify",
      name: "verify",
      stream: "stderr",
      text: "ERROR task9-only-tail\n",
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "task9-verify",
      name: "verify",
      input: { command: "task9-check" },
      exitCode: 1,
      durationMs: 20,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 3,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "unverified",
      durationMs: 30,
      toolCount: 0,
      timestamp: NOW + 4,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-check/g)?.length, 1);
    assert.equal(screen.match(/task9-only-tail/g)?.length, 1);
    assert.equal(screen.match(/Lauf beendet · unbestätigt/g)?.length, 1);
    assert.doesNotMatch(screen, /Prüflauf.*Runde/);
  } finally {
    terminal.stop();
  }
});

test("invalid verification shell shows one redacted process-card reason and one root terminal", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "edit",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "task9-invalid-shell",
      name: "verify",
      input: { command: "task9-shell-check" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "task9-invalid-shell",
      name: "verify",
      input: { command: "task9-shell-check" },
      exitCode: null,
      durationMs: 2,
      truncated: false,
      timedOut: false,
      aborted: false,
      error: "ENOENT: missing shell [REDACTED]",
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "unverified",
      durationMs: 3,
      toolCount: 0,
      timestamp: NOW + 3,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-shell-check/g)?.length, 1);
    assert.equal(screen.match(/missing shell \[REDACTED\]/g)?.length, 1, screen);
    assert.equal(screen.match(/Lauf beendet · unbestätigt/g)?.length, 1);
    assert.doesNotMatch(screen, /Prüflauf.*Runde/);
  } finally {
    terminal.stop();
  }
});

test("a tool-bound null-exit launch failure renders one cause and one terminal tool card", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({
      type: "run-start",
      model: "vendor/model",
      maxSteps: 6,
      prompt: "run",
      timestamp: NOW,
    });
    terminal.handleRunEvent({
      type: "tool-start",
      id: "tool-launch",
      invocationId: "invocation-launch",
      number: 1,
      name: "run_command",
      input: { command: "task9-bound-command" },
      timestamp: NOW + 1,
    });
    terminal.handleRunEvent({
      type: "process-start",
      id: "process-launch",
      invocationId: "invocation-launch",
      name: "run_command",
      input: { command: "task9-bound-command" },
      toolId: "tool-launch",
      toolNumber: 1,
      timestamp: NOW + 2,
    });
    terminal.handleRunEvent({
      type: "process-end",
      id: "process-launch",
      invocationId: "invocation-launch",
      name: "run_command",
      input: { command: "task9-bound-command" },
      toolId: "tool-launch",
      toolNumber: 1,
      exitCode: null,
      durationMs: 2,
      truncated: false,
      timedOut: false,
      aborted: false,
      error: "spawn shell ENOENT [REDACTED]",
      timestamp: NOW + 3,
    });
    terminal.handleRunEvent({
      type: "tool-error",
      id: "tool-launch",
      invocationId: "invocation-launch",
      number: 1,
      name: "run_command",
      input: { command: "task9-bound-command" },
      error: "spawn shell ENOENT [REDACTED]",
      durationMs: 3,
      timestamp: NOW + 4,
    });
    terminal.handleRunEvent({
      type: "run-end",
      outcome: "error",
      durationMs: 4,
      toolCount: 1,
      timestamp: NOW + 5,
    });

    const screen = text(terminal.frame().lines);
    assert.equal(screen.match(/task9-bound-command/g)?.length, 1, screen);
    assert.equal(screen.match(/spawn shell ENOENT \[REDACTED\]/g)?.length, 1, screen);
    assert.equal(screen.match(/Lauf fehlgeschlagen/g)?.length, 1, screen);
  } finally {
    terminal.stop();
  }
});

test("fullscreen /diff terminal frames distinguish dirty, clean, and failed repositories without duplicate tails", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git ist nicht installiert");
    return;
  }
  const renderDiff = async (workspace: string): Promise<string> => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stdout.rows = 40;
    const terminal = ui(stdin, stdout);
    terminal.start();
    try {
      const context = {
        workspace,
        onRunEvent: (event: AgentRunEvent) => terminal.handleRunEvent(event),
        out: { text: () => undefined, error: () => undefined },
      } as unknown as CommandContext;
      await handleSlashCommand("/diff", context);
      return text(terminal.frame().lines);
    } finally {
      terminal.stop();
    }
  };
  const repository = mkdtempSync(join(tmpdir(), "routercode-tui-diff-"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "RouterCode Test"], { cwd: repository });
  writeFileSync(join(repository, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repository });
  const failed = mkdtempSync(join(tmpdir(), "routercode-tui-diff-failed-"));
  try {
    const clean = await renderDiff(repository);
    assert.match(clean, /0 Diff-Zeilen/);

    writeFileSync(join(repository, "tracked.txt"), "after\n");
    const dirty = await renderDiff(repository);
    assert.match(dirty, /[1-9]\d* Diff-Zeilen/);
    assert.ok((dirty.match(/after/g)?.length ?? 0) <= 1, "the streamed tail was duplicated at terminal completion");

    const failure = await renderDiff(failed);
    assert.match(failure, /(?:Git fehlgeschlagen|exit 1(?:28|29))/i);
    assert.doesNotMatch(failure, /0 Diff-Zeilen/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(failed, { recursive: true, force: true });
  }
});

test("process chunks are redacted and partial lines are reassembled before TUI rendering", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    terminal.handleRunEvent({ type: "process-start", id: "p-secret", name: "verify", input: { command: "check" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stdout", text: "partial", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stdout", text: "-line\n", timestamp: NOW + 2 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stderr", text: `${["sk", "or", "v1"].join("-")}-`, timestamp: NOW + 3 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "p-secret", name: "verify", stream: "stderr", text: `${"q".repeat(40)}\n`, timestamp: NOW + 4 } as AgentRunEvent);
    const screen = text(terminal.frame().lines);
    assert.match(screen, /partial-line/);
    assert.doesNotMatch(screen, /^partial$/m);
    assert.doesNotMatch(screen, new RegExp(`${["sk", "or", "v1"].join("-")}-${"q".repeat(40)}`));
  } finally {
    terminal.stop();
  }
});

test("TUI hides every registered credential family at every process chunk split and flushes benign suffixes", () => {
  const awsSecret = "A".repeat(40);
  const bearer = `token9${"b".repeat(24)}`;
  const privateBody = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
  const privateLabel = ["PRIVATE", "KEY"].join(" ");
  const fixtures = [
    { name: "openrouter", secret: `${["sk", "or", "v1"].join("-")}-${"o".repeat(24)}`, sensitive: "o".repeat(24) },
    { name: "anthropic", secret: `${["sk", "ant"].join("-")}-${"a".repeat(24)}`, sensitive: "a".repeat(24) },
    { name: "generic-sk", secret: `${["sk", "generic"].join("-")}-${"g".repeat(24)}`, sensitive: "g".repeat(24) },
    { name: "aws-access", secret: `${["AK", "IA"].join("")}${"C".repeat(16)}`, sensitive: "C".repeat(16) },
    { name: "aws-secret", secret: `aws_secret_access_key=${awsSecret}`, sensitive: awsSecret },
    { name: "github", secret: `${["gh", "p_"].join("")}${"H".repeat(24)}`, sensitive: "H".repeat(24) },
    { name: "gitlab", secret: `${["glpat", ""].join("-")}${"L".repeat(24)}`, sensitive: "L".repeat(24) },
    { name: "slack", secret: `${["xox", "b-"].join("")}${"1".repeat(16)}`, sensitive: "1".repeat(16) },
    { name: "google", secret: `${["AI", "za"].join("")}${"Q".repeat(35)}`, sensitive: "Q".repeat(35) },
    { name: "npm", secret: `${["npm", "_"].join("")}${"N".repeat(36)}`, sensitive: "N".repeat(36) },
    { name: "bearer", secret: `Bearer ${bearer}`, sensitive: bearer },
    { name: "jwt", secret: `eyJ${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}`, sensitive: `${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}` },
    { name: "private-key", secret: `-----BEGIN ${privateLabel}-----\n${privateBody}\n-----END ${privateLabel}-----`, sensitive: privateBody },
  ];
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 40;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    let timestamp = NOW;
    for (const fixture of fixtures) {
      for (let split = 1; split < fixture.secret.length; split += 1) {
        const id = `${fixture.name}-${split}`;
        terminal.handleRunEvent({ type: "process-start", id, name: "verify", input: {}, timestamp: timestamp++ } as AgentRunEvent);
        terminal.handleRunEvent({ type: "process-output", id, name: "verify", stream: "stdout", text: fixture.secret.slice(0, split), timestamp: timestamp++ } as AgentRunEvent);
        terminal.handleRunEvent({ type: "process-output", id, name: "verify", stream: "stdout", text: `${fixture.secret.slice(split)}\n`, timestamp: timestamp++ } as AgentRunEvent);
        assert.equal(
          text(terminal.frame().lines).includes(fixture.sensitive),
          false,
          `${fixture.name} leaked at split ${split}`,
        );
        terminal.handleRunEvent({
          type: "process-end",
          id,
          name: "verify",
          input: {},
          exitCode: 0,
          durationMs: 1,
          truncated: false,
          timedOut: false,
          aborted: false,
          timestamp: timestamp++,
        } as AgentRunEvent);
      }
    }
    terminal.handleRunEvent({ type: "process-start", id: "benign-suffix", name: "verify", input: {}, timestamp: timestamp++ } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id: "benign-suffix", name: "verify", stream: "stdout", text: "ordinary trailing s", timestamp: timestamp++ } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-end",
      id: "benign-suffix",
      name: "verify",
      input: {},
      exitCode: 1,
      durationMs: 1,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: timestamp++,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /ordinary trailing s/);
  } finally {
    terminal.stop();
  }
});

test("TUI keeps later stderr behind an earlier ambiguous stdout prefix", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const id = "cross-stream-order";
    terminal.handleRunEvent({ type: "process-start", id, name: "run_command", input: { command: "order" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: "eyJ", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stderr", text: "ERR-LATER\n", timestamp: NOW + 2 } as AgentRunEvent);
    assert.doesNotMatch(
      text(terminal.frame().lines),
      /ERR-LATER/,
      "later stderr escaped while the earlier stdout overlap was unresolved",
    );
    terminal.handleRunEvent({
      type: "process-end",
      id,
      name: "run_command",
      input: { command: "order" },
      exitCode: 1,
      durationMs: 3,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 3,
    } as AgentRunEvent);

    const screen = text(terminal.frame().lines);
    const earlier = screen.indexOf("eyJ");
    const later = screen.indexOf("ERR-LATER");
    assert.ok(earlier >= 0 && later >= 0, screen);
    assert.ok(earlier < later, screen);
  } finally {
    terminal.stop();
  }
});

test("TUI preserves retained stdout provenance when a same-stream chunk resolves mid-process", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    const id = "cross-stream-provenance";
    terminal.handleRunEvent({ type: "process-start", id, name: "run_command", input: { command: "order" }, timestamp: NOW } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: "eyJ", timestamp: NOW + 1 } as AgentRunEvent);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stderr", text: "ERR-LATER\n", timestamp: NOW + 2 } as AgentRunEvent);
    assert.doesNotMatch(text(terminal.frame().lines), /ERR-LATER/);
    terminal.handleRunEvent({ type: "process-output", id, name: "run_command", stream: "stdout", text: " benign\n", timestamp: NOW + 3 } as AgentRunEvent);

    const screen = text(terminal.frame().lines);
    const oldStdout = screen.indexOf("eyJ");
    const interveningStderr = screen.indexOf("ERR-LATER");
    const currentStdout = screen.indexOf("benign");
    assert.ok(oldStdout >= 0 && interveningStderr >= 0 && currentStdout >= 0, screen);
    assert.ok(oldStdout < interveningStderr, screen);
    assert.ok(interveningStderr < currentStdout, screen);

    terminal.handleRunEvent({
      type: "process-end",
      id,
      name: "run_command",
      input: { command: "order" },
      exitCode: 1,
      durationMs: 4,
      truncated: false,
      timedOut: false,
      aborted: false,
      timestamp: NOW + 4,
    } as AgentRunEvent);
  } finally {
    terminal.stop();
  }
});

test("TUI emits exactly one AWS marker in original output order across every capture split", () => {
  const sensitive = "S".repeat(40);
  const marker = "[REDACTED_AWS_SECRET]";
  for (const variant of awsCaptureLabels()) {
    for (let split = 1; split <= variant.label.length; split += 1) {
      const stdin = new FakeInput();
      const stdout = new FakeOutput();
      stdout.columns = 180;
      stdout.rows = 50;
      const terminal = ui(stdin, stdout);
      terminal.start();
      try {
        const id = `aws-${variant.name}-${split}`;
        const oldTag = `OLD-${variant.name}-${split}|`;
        const errorTag = `ERR-${variant.name}-${split}`;
        const currentTag = `|CURRENT-${variant.name}-${split}`;
        terminal.handleRunEvent({
          type: "process-start",
          id,
          name: "verify",
          input: {},
          timestamp: NOW,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stdout",
          text: `${oldTag}${variant.label.slice(0, split)}`,
          timestamp: NOW + 1,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stderr",
          text: `${errorTag}\n`,
          timestamp: NOW + 2,
        } as AgentRunEvent);
        assert.doesNotMatch(
          text(terminal.frame().lines),
          new RegExp(errorTag),
          `${id} let stderr pass an unresolved stdout capture`,
        );
        terminal.handleRunEvent({
          type: "process-output",
          id,
          name: "verify",
          stream: "stdout",
          text: `${variant.label.slice(split)}${sensitive}${currentTag}\n`,
          timestamp: NOW + 3,
        } as AgentRunEvent);
        terminal.handleRunEvent({
          type: "process-end",
          id,
          name: "verify",
          input: {},
          exitCode: 1,
          durationMs: 4,
          truncated: false,
          timedOut: false,
          aborted: false,
          timestamp: NOW + 4,
        } as AgentRunEvent);

        const screen = text(terminal.frame().lines);
        const markerIsOld = split === variant.label.length;
        const oldText = `${oldTag}${variant.label.slice(0, split)}${markerIsOld ? marker : ""}`.trim();
        const currentText = `${variant.label.slice(split)}${markerIsOld ? "" : marker}${currentTag}`.trim();
        assert.equal(
          screen.split(marker).length - 1,
          1,
          `${id} emitted more than one marker:\n${screen}`,
        );
        assert.doesNotMatch(screen, new RegExp(sensitive), `${id} leaked secret bytes`);
        const oldIndex = screen.indexOf(oldText);
        const errorIndex = screen.indexOf(errorTag);
        const currentIndex = screen.indexOf(currentText);
        assert.ok(oldIndex >= 0, `${id} lost old-frame text:\n${screen}`);
        assert.ok(errorIndex >= 0, `${id} lost stderr text:\n${screen}`);
        assert.ok(currentIndex >= 0, `${id} lost current-frame text:\n${screen}`);
        assert.ok(oldIndex < errorIndex, `${id} reordered old stdout behind stderr:\n${screen}`);
        assert.ok(errorIndex < currentIndex, `${id} reordered current stdout before stderr:\n${screen}`);
      } finally {
        terminal.stop();
      }
    }
  }
});

test("terminal process deduplication is bounded and eventually releases old operation IDs", () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  stdout.rows = 36;
  const terminal = ui(stdin, stdout);
  terminal.start();
  try {
    for (let index = 0; index < 513; index += 1) {
      const id = `bounded-${index}`;
      terminal.handleRunEvent({
        type: "process-start",
        id,
        name: "verify",
        input: { command: String(index) },
        timestamp: NOW + index,
      } as AgentRunEvent);
      terminal.handleRunEvent({
        type: "process-end",
        id,
        name: "verify",
        input: { command: String(index) },
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        aborted: false,
        timestamp: NOW + index,
      } as AgentRunEvent);
    }
    terminal.handleRunEvent({
      type: "process-start",
      id: "bounded-0",
      name: "verify",
      input: { command: "reused" },
      timestamp: NOW + 600,
    } as AgentRunEvent);
    terminal.handleRunEvent({
      type: "process-output",
      id: "bounded-0",
      name: "verify",
      stream: "stdout",
      text: "reused-live\n",
      timestamp: NOW + 601,
    } as AgentRunEvent);
    assert.match(text(terminal.frame().lines), /reused-live/);
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

test("always/never are available only when the same preview carries a safe exact subject", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const terminal = ui(stdin, stdout);

  terminal.start();
  try {
    const exactSubject = '{"kind":"selected-path","path":"src/index.ts"}';
    const allow = terminal.confirmApproval({
      name: "write_file",
      risk: "edit",
      summary: "src/index.ts schreiben",
      details: "eine synthetische Änderung",
      subject: exactSubject,
      rememberAvailable: true,
    });
    assert.match(stdout.output, /Freigabe-Subjekt \(exakt\)/);
    assert.match(stdout.output, /selected-path/);
    assert.match(stdout.output, /src\/index\.ts/);
    press(stdin, "a", "a");
    assert.deepEqual(await allow, { accepted: true, remember: "allow" });

    const deny = terminal.confirmApproval({
      name: "write_file",
      risk: "edit",
      summary: "src/index.ts schreiben",
      subject: exactSubject,
      rememberAvailable: true,
    });
    press(stdin, "d", "d");
    assert.deepEqual(await deny, { accepted: false, remember: "deny" });

    const unavailable = terminal.confirmAction("Sitzung löschen", "lokale Sitzung");
    press(stdin, "a", "a");
    assert.match(stdout.output, /Immer\/Nie ist ohne exaktes Subject nicht verfügbar/);
    press(stdin, "j", "j");
    assert.deepEqual(await unavailable, { accepted: true });

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
