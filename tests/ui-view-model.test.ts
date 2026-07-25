import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunEvent } from "../src/types.js";
import { diffText } from "../src/workspace.js";
import { RUNNING_TAIL_LINES, TAIL_CAPACITY, type ChatBlock } from "../src/ui/blocks.js";
import { RunViewModel, selectTail } from "../src/ui/view-model.js";
import { renderBlock } from "../src/ui/render-block.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const theme = createTheme({ level: 0 });
const AT = 1_700_000_000_000;

function toolStart(id: string, number: number, command: string): AgentRunEvent {
  return {
    type: "tool-start",
    id,
    number,
    name: "run_command",
    input: { command },
    timestamp: AT,
  };
}

function toolEnd(id: string, number: number, exitCode: number): AgentRunEvent {
  return {
    type: "tool-end",
    id,
    number,
    name: "run_command",
    input: { command: "npm test" },
    output: { exitCode, stdout: "95 passed", stderr: "", truncated: false },
    durationMs: 2400,
    timestamp: AT + 2400,
  };
}

function tools(model: RunViewModel): Array<Extract<ChatBlock, { kind: "tool" }>> {
  return model.blocks.filter(
    (block): block is Extract<ChatBlock, { kind: "tool" }> => block.kind === "tool",
  );
}

test("verschachtelte Toolaufrufe behalten ihre Startreihenfolge", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm run check"));
  model.apply(toolStart("b", 2, "npm test"));
  model.apply(toolEnd("b", 2, 0));
  model.apply(toolEnd("a", 1, 0));

  const blocks = tools(model);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.input.startsWith("npm run check"), true);
  assert.equal(blocks[1]!.input.startsWith("npm test"), true);
  assert.equal(blocks[0]!.state, "ok");
  assert.equal(blocks[1]!.state, "ok");
  assert.equal(model.activeSpinnerId, null);
});

test("tool-error macht den Block rot und hebt die Fehlerzeilen auf", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm test"));
  model.apply({
    type: "tool-error",
    id: "a",
    number: 1,
    name: "run_command",
    input: { command: "npm test" },
    error: ["Hinweis eins", "error TS2345: Argument of type", "Hinweis zwei"].join("\n"),
    durationMs: 900,
    timestamp: AT + 900,
  });

  const block = tools(model)[0]!;
  assert.equal(block.state, "failed");
  assert.equal(block.tail.some((item) => item.includes("error TS2345")), true);
  const head = renderBlock(block, 80, theme)[0]!;
  assert.equal(head.spans[0]?.role, "danger");
  assert.equal(plainText(head).startsWith("✗"), true);
});

test("Exit ungleich 0 ist ein Fehler, alles andere Erfolgreiche bleibt unverifiziert", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm test"));
  model.apply(toolEnd("a", 1, 1));
  assert.equal(tools(model)[0]!.state, "failed");
  assert.equal(tools(model)[0]!.exitCode, 1);

  const second = new RunViewModel();
  second.apply({
    type: "tool-start",
    id: "w",
    number: 1,
    name: "write_file",
    input: { path: "src/session.ts", content: "x" },
    timestamp: AT,
  });
  second.apply({
    type: "tool-end",
    id: "w",
    number: 1,
    name: "write_file",
    input: { path: "src/session.ts", content: "x" },
    output: { path: "src/session.ts", bytes: 1240 },
    durationMs: 12,
    timestamp: AT + 12,
  });
  assert.equal(tools(second)[0]!.state, "unverified");
  assert.equal(plainText(renderBlock(tools(second)[0]!, 80, theme)[0]!).startsWith("~"), true);
});

test("Live-Ausgabe füllt einen Ringpuffer und lässt den Block nicht wachsen", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm run build"));
  for (let index = 0; index < TAIL_CAPACITY + 50; index += 1) {
    model.apply({
      type: "tool-output",
      id: "a",
      number: 1,
      stream: "stdout",
      text: `Zeile ${index}\n`,
      timestamp: AT + index,
    });
  }
  const block = tools(model)[0]!;
  assert.equal(block.state, "running");
  assert.equal(block.tail.length, RUNNING_TAIL_LINES);
  assert.equal(block.tail.at(-1), `Zeile ${TAIL_CAPACITY + 49}`);
  assert.equal(block.totalLines, TAIL_CAPACITY + 50);
  assert.equal(renderBlock(block, 80, theme, { now: AT }).length, 1 + RUNNING_TAIL_LINES);
  assert.equal(model.activeSpinnerId, block.id);
});

test("Reasoning sammelt sich in einem Block und endet mit model-end", () => {
  const model = new RunViewModel();
  model.apply({ type: "reasoning", model: "m", step: 1, delta: "Ich prüfe ", timestamp: AT });
  model.apply({ type: "reasoning", model: "m", step: 1, delta: "die Schnittstellen.", timestamp: AT });
  model.apply({
    type: "model-end",
    model: "m",
    step: 1,
    durationMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 912,
    cachedTokens: 0,
    costUsd: 0.001,
    timestamp: AT,
  });

  const blocks = model.blocks.filter((block) => block.kind === "reasoning");
  assert.equal(blocks.length, 1);
  const block = blocks[0]! as Extract<ChatBlock, { kind: "reasoning" }>;
  assert.equal(block.text, "Ich prüfe die Schnittstellen.");
  assert.equal(block.tokens, 912);
  assert.equal(block.live, false);
  assert.equal(model.activeSpinnerId, null);
});

test("toggle klappt Reasoning und Toolblöcke auf und zu", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm test"));
  const id = tools(model)[0]!.id;
  assert.equal(model.toggle(id), true);
  assert.equal(tools(model)[0]!.expanded, true);
  assert.equal(model.toggle(id), true);
  assert.equal(tools(model)[0]!.expanded, false);
  assert.equal(model.toggle("gibt-es-nicht"), false);
});

test("Abbruch markiert laufende Blöcke als abgebrochen", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm run build"));
  model.apply({
    type: "run-end",
    outcome: "cancelled",
    durationMs: 42_000,
    toolCount: 1,
    timestamp: AT,
  });
  assert.equal(tools(model)[0]!.state, "cancelled");
  assert.equal(model.activeSpinnerId, null);
  assert.equal(plainText(renderBlock(tools(model)[0]!, 80, theme)[0]!).startsWith("⚠"), true);
});

test("Meldungen werden zu Notice-Blöcken mit Aktionen", () => {
  const model = new RunViewModel();
  model.apply({
    type: "notice",
    level: "error",
    code: "http-429",
    message: "OpenRouter HTTP 429",
    hint: "Der Lauf endete nach Schritt 3.",
    actions: [{ key: "r", label: "erneut" }],
    timestamp: AT,
  });
  const block = model.blocks[0]! as Extract<ChatBlock, { kind: "notice" }>;
  assert.equal(block.kind, "notice");
  assert.equal(block.level, "error");
  assert.equal(block.cause[0], "Der Lauf endete nach Schritt 3.");
  const lines = renderBlock(block, 80, theme, { last: true }).map(plainText);
  assert.equal(lines.length >= 3, true, "eine Fehlerkarte hat drei Teile");
  assert.equal(lines.at(-1)!.includes("r erneut"), true);
});

test("Nutzer- und Antwortblöcke wechseln sich sauber ab", () => {
  const model = new RunViewModel();
  model.pushUser("Bau die Suche um", 2, AT);
  model.appendAssistant("Erst ", AT);
  model.appendAssistant("lesen.", AT);
  model.finishAssistant(0.012);
  model.pushUser("Weiter", 0, AT);

  assert.equal(model.blocks.length, 3);
  const answer = model.blocks[1]! as Extract<ChatBlock, { kind: "assistant" }>;
  assert.equal(answer.text, "Erst lesen.");
  assert.equal(answer.costUsd, 0.012);
});

test("Diffblöcke kommen aus diffText und zählen versteckte Hunks", () => {
  const model = new RunViewModel();
  const before = Array.from({ length: 60 }, (_, index) => `Zeile ${index}`).join("\n");
  const after = before
    .split("\n")
    .map((item, index) => (index % 12 === 0 ? `${item} geändert` : item))
    .join("\n");
  const block = model.pushDiff("src/session.ts", diffText(before, after), {
    undoable: true,
    at: AT,
  }) as Extract<ChatBlock, { kind: "diff" }>;
  assert.equal(block.hunks.length, 3);
  assert.equal(block.hiddenHunks > 0, true);
  assert.equal(block.added > 0, true);
  const foot = plainText(renderBlock(block, 80, theme, { last: true }).at(-1)!);
  assert.equal(foot.includes("weitere Hunks"), true);
  assert.equal(foot.includes("u rückgängig"), true);
});

test("Freigabeblöcke verschwinden wieder, sobald sie beantwortet sind", () => {
  const model = new RunViewModel();
  const block = model.pushApproval({
    risk: "shell",
    summary: "SHELL",
    details: ["rm -rf build dist"],
    rememberHint: "keine gemerkte Regel für „rm“",
    at: AT,
  });
  assert.equal(model.blocks.length, 1);
  assert.equal(model.dropApproval(block.id), true);
  assert.equal(model.blocks.length, 0);
  assert.equal(model.dropApproval(block.id), false);
});

test("selectTail bevorzugt bei Fehlern die Fehlerzeilen, sonst die letzten", () => {
  const lines = ["a", "b", "FAIL hier", "c", "error TS1: dort", "d"];
  assert.deepEqual(selectTail(lines, true, 2), ["FAIL hier", "error TS1: dort"]);
  assert.deepEqual(selectTail(lines, false, 2), ["error TS1: dort", "d"]);
  assert.deepEqual(selectTail(["nur eine"], true, 3), ["nur eine"]);
});

test("clear setzt das Modell zurück", () => {
  const model = new RunViewModel();
  model.pushUser("x");
  model.apply(toolStart("a", 1, "npm test"));
  model.clear();
  assert.equal(model.blocks.length, 0);
  assert.equal(model.activeSpinnerId, null);
});
