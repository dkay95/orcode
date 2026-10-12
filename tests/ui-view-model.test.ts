import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunEvent } from "../src/types.js";
import type { PanelResult } from "../src/panel.js";
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
  // Controller decision C: the head bullet is constant (accent) now —
  // failure shows up one line down, on the `⎿` outcome line instead.
  const lines = renderBlock(block, 80, theme);
  const head = lines[0]!;
  assert.equal(head.spans[0]?.role, "accent");
  assert.equal(plainText(head).startsWith("●"), true);
  const outcome = lines[1]!;
  assert.equal(outcome.spans[1]?.role, "danger");
  assert.equal(plainText(outcome).startsWith("⎿ ✗"), true);
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
  const lines = renderBlock(tools(second)[0]!, 80, theme);
  assert.equal(plainText(lines[0]!).startsWith("●"), true);
  assert.equal(plainText(lines[1]!).startsWith("⎿ ~"), true);
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
  const lines = renderBlock(tools(model)[0]!, 80, theme);
  assert.equal(plainText(lines[0]!).startsWith("●"), true);
  assert.equal(plainText(lines[1]!).startsWith("⎿ ⚠"), true);
});

test("Meldungen werden zu Notice-Blöcken", () => {
  const model = new RunViewModel();
  model.apply({
    type: "notice",
    level: "error",
    code: "http-429",
    message: "OpenRouter HTTP 429",
    hint: "Der Lauf endete nach Schritt 3.",
    timestamp: AT,
  });
  const block = model.blocks[0]! as Extract<ChatBlock, { kind: "notice" }>;
  assert.equal(block.kind, "notice");
  assert.equal(block.level, "error");
  assert.equal(block.cause[0], "Der Lauf endete nach Schritt 3.");
  const lines = renderBlock(block, 80, theme, { last: true }).map(plainText);
  assert.equal(lines.length >= 2, true, "eine Fehlerkarte hat Titel und Ursache");
  assert.match(lines.at(-1)!, /Der Lauf endete nach Schritt 3\./);
});

test("D3: an identical consecutive notice collapses into the prior block instead of appending", () => {
  const model = new RunViewModel();
  model.pushNotice("warn", "Cross · Blocked", ["Task or context invalid"], AT);
  model.pushNotice("warn", "Cross · Blocked", ["Task or context invalid"], AT + 10);
  model.pushNotice("warn", "Cross · Blocked", ["Task or context invalid"], AT + 20);

  assert.equal(model.blocks.length, 1, "no duplicate blocks — one collapsed notice");
  const block = model.blocks[0]! as Extract<ChatBlock, { kind: "notice" }>;
  assert.equal(block.repeatCount, 3);
  assert.equal(block.at, AT + 20, "the timestamp moves to the latest occurrence");

  const lines = renderBlock(block, 80, theme).map(plainText);
  assert.match(lines[0]!, /Cross · Blocked × 3/, "a muted counter suffix, not three stacked lines");
});

test("D3: a different notice in between resets the repeat streak", () => {
  const model = new RunViewModel();
  model.pushNotice("warn", "Cross · Blocked", ["Task or context invalid"]);
  model.pushNotice("info", "Cross mode: armed for this chat", []);
  model.pushNotice("warn", "Cross · Blocked", ["Task or context invalid"]);

  assert.equal(model.blocks.length, 3, "an intervening different line starts a fresh streak");
  for (const block of model.blocks) {
    assert.equal((block as Extract<ChatBlock, { kind: "notice" }>).repeatCount ?? 1, 1);
  }
});

test("D3: a single (non-repeated) notice renders with no counter suffix", () => {
  const model = new RunViewModel();
  model.pushNotice("info", "Cross mode activated · claude + gpt-5", []);
  const block = model.blocks[0]! as Extract<ChatBlock, { kind: "notice" }>;
  const lines = renderBlock(block, 80, theme).map(plainText);
  assert.doesNotMatch(lines[0]!, /×/);
});

test("D3: D3 never touches non-notice blocks — a repeated identical tool call still appends", () => {
  const model = new RunViewModel();
  model.apply(toolStart("a", 1, "npm test"));
  model.apply(toolEnd("a", 1, 0));
  model.apply(toolStart("b", 2, "npm test"));
  model.apply(toolEnd("b", 2, 0));
  assert.equal(tools(model).length, 2, "identical tool blocks are never collapsed");
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
  assert.equal(foot.includes("more hunks"), true);
  // FIX-3: the foot names only reachable mechanisms. `u` was never bound —
  // the hint now points at the real command, and at `/diff` for what was cut.
  assert.equal(foot.includes("u undo"), false);
  assert.equal(foot.includes("/undo reverts the run"), true);
  assert.equal(foot.includes("/diff"), true);
});

test("FIX-3: an applied edit becomes a diff block — path, whole-file counts, hunks", () => {
  const model = new RunViewModel();
  const before = ["alpha", "beta", "gamma"].join("\n");
  const after = ["alpha", "BETA", "gamma", "delta"].join("\n");
  const source = diffText(before, after);

  model.apply({
    type: "file-change",
    path: "src/foo.ts",
    tool: "replace_text",
    created: false,
    added: source.added,
    removed: source.removed,
    diff: source.text,
    truncated: source.truncated,
    timestamp: AT,
  });

  const block = model.blocks.at(-1) as Extract<ChatBlock, { kind: "diff" }>;
  assert.equal(block.kind, "diff");
  assert.equal(block.path, "src/foo.ts");
  assert.equal(block.added, source.added);
  assert.equal(block.removed, source.removed);
  assert.equal(block.truncated, false);
  assert.equal(block.undoable, true);
  assert.equal(block.at, AT);

  const text = renderBlock(block, 80, theme, { last: true }).map(plainText);
  assert.equal(text[0]!.includes("src/foo.ts"), true);
  assert.equal(text[0]!.includes(`+${source.added}`), true);
  assert.equal(text[0]!.includes(`-${source.removed}`), true);
  // The changed lines themselves are on screen, not only the counts.
  assert.equal(text.some((line) => line.includes("+") && line.includes("BETA")), true);
  assert.equal(text.some((line) => line.includes("-") && line.includes("beta")), true);
  assert.equal(text.at(-1)!.includes("applied"), true);
});

test("FIX-3: a capped diff says so and names /diff, and the counts stay the file's own", () => {
  const model = new RunViewModel();
  const before = Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n");
  const after = before
    .split("\n")
    .map((line, index) => (index % 15 === 0 ? `${line} changed` : line))
    .join("\n");
  const source = diffText(before, after);
  assert.equal(source.truncated, true, "fixture must exceed the differ's changed-line budget");

  model.apply({
    type: "file-change",
    path: "src/big.ts",
    tool: "write_file",
    created: false,
    added: source.added,
    removed: source.removed,
    diff: source.text,
    truncated: source.truncated,
    timestamp: AT,
  });

  const block = model.blocks.at(-1) as Extract<ChatBlock, { kind: "diff" }>;
  assert.equal(block.hunks.length, 3, "the approval preview's cap, shared");
  assert.equal(block.hiddenHunks > 0, true);
  assert.equal(block.truncated, true);
  // The head still tells the truth about the whole file (134 changed lines
  // here), even though only three hunks are drawn.
  assert.equal(block.added, source.added);
  assert.equal(block.removed, source.removed);

  const foot = plainText(renderBlock(block, 80, theme, { last: true }).at(-1)!);
  assert.equal(foot.includes("more hunks"), true);
  assert.equal(foot.includes("truncated"), true);
  assert.equal(foot.includes("/diff"), true);
});

test("FIX-3: a created file reports +N with no phantom removal", () => {
  const model = new RunViewModel();
  const content = "one\ntwo";
  const source = diffText("", content);
  assert.equal(source.added, 2);
  assert.equal(source.removed, 0);

  model.apply({
    type: "file-change",
    path: "src/new.ts",
    tool: "write_file",
    created: true,
    added: source.added,
    removed: source.removed,
    diff: source.text,
    truncated: source.truncated,
    timestamp: AT,
  });

  const block = model.blocks.at(-1) as Extract<ChatBlock, { kind: "diff" }>;
  const head = plainText(renderBlock(block, 80, theme, { last: true })[0]!);
  assert.equal(head.includes("+2"), true);
  assert.equal(head.includes("-0"), true);
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

function samplePanelResult(): PanelResult {
  return {
    question: "Welcher Ansatz ist robuster?",
    answers: [
      {
        model: "a/one",
        text: "Antwort A",
        costUsd: 0.001,
        durationMs: 10,
        inputTokens: 5,
        outputTokens: 5,
        error: null,
      },
      {
        model: "b/two",
        text: "Antwort B",
        costUsd: 0.002,
        durationMs: 20,
        inputTokens: 5,
        outputTokens: 5,
        error: null,
      },
    ],
    totalCostUsd: 0.003,
    durationMs: 20,
  };
}

test("pushPanel legt bei jedem Aufruf einen frischen Block an, statt einen bestehenden zu verändern", () => {
  const model = new RunViewModel();
  const result = samplePanelResult();
  const first = model.pushPanel(result, null, null, AT) as Extract<ChatBlock, { kind: "panel" }>;
  assert.equal(model.blocks.length, 1);
  assert.equal(first.kind, "panel");
  assert.equal(first.result, result);
  assert.equal(first.expandedIndex, null);

  // A later "/panel show <n>" for the same result appends its own block —
  // the first one is untouched, exactly like every other command output.
  const second = model.pushPanel(result, null, 1, AT + 10) as Extract<ChatBlock, { kind: "panel" }>;
  assert.equal(model.blocks.length, 2);
  assert.notEqual(second.id, first.id);
  assert.equal(first.expandedIndex, null, "der erste Block darf sich nicht rückwirkend ändern");
  assert.equal(second.expandedIndex, 1);

  const lines = renderBlock(second, 80, theme).map(plainText);
  assert.ok(lines.some((line) => line.includes("full")));
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

test("a live reasoning panel never shows 0 tokens", () => {
  // The provider only reports the real count with `model-end`, i.e. after the
  // thinking is over. Before this was fixed the header read "0 Tokens" for the
  // entire time the panel was live.
  const vm = new RunViewModel();
  vm.apply({
    type: "reasoning",
    model: "m",
    step: 1,
    delta: "Ich prüfe zuerst die Schnittstellen des Kompressors.",
    timestamp: 1,
  });
  const live = vm.blocks.at(-1)!;
  assert.equal(live.kind, "reasoning");
  if (live.kind !== "reasoning") return;
  assert.ok(live.tokens > 0, "a live panel must show an estimate, not 0");
  assert.equal(live.estimated, true);

  vm.apply({
    type: "model-end",
    model: "m",
    step: 1,
    durationMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 640,
    cachedTokens: 0,
    costUsd: 0.001,
    timestamp: 2,
  });
  const done = vm.blocks.at(-1)!;
  if (done.kind !== "reasoning") return;
  assert.equal(done.tokens, 640, "the provider's real count wins at the end");
  assert.equal(done.estimated, false);
});

test("a provider reporting zero reasoning tokens keeps the estimate", () => {
  const vm = new RunViewModel();
  vm.apply({ type: "reasoning", model: "m", step: 1, delta: "x".repeat(400), timestamp: 1 });
  vm.apply({
    type: "model-end",
    model: "m",
    step: 1,
    durationMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0.001,
    timestamp: 2,
  });
  const block = vm.blocks.at(-1)!;
  if (block.kind !== "reasoning") return;
  assert.ok(block.tokens > 0, "must not fall back to 0 after showing a number");
  assert.equal(block.estimated, true);
});
