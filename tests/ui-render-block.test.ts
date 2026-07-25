import assert from "node:assert/strict";
import test from "node:test";

import { diffText } from "../src/workspace.js";
import type { BlockState, ChatBlock } from "../src/ui/blocks.js";
import { BLOCK_STATES, RUNNING_TAIL_LINES } from "../src/ui/blocks.js";
import { parseUnifiedDiff, renderDiff, splitHunks } from "../src/ui/diff-view.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { renderBlock } from "../src/ui/render-block.js";
import { lineWidth, plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";

const WIDTHS = [40, 60, 80, 120] as const;
const theme = createTheme({ level: 0 });
const AT = 1_700_000_000_000;

const BEFORE = ["const data = this.d;", "await write(path, data);", "this.base = data;"].join(
  "\n",
);
const AFTER = [
  "const data = this.d;",
  "const tmp = `${path}.tmp`;",
  "await write(tmp, data, { mode: 0o600 });",
  "await rename(tmp, path);",
  "this.base = data;",
].join("\n");

function sampleBlocks(): ChatBlock[] {
  const diff = diffText(BEFORE, AFTER);
  return [
    { kind: "user", id: "u1", at: AT, text: "Bau die Suche um: .gitignore respektieren", attachmentCount: 1 },
    { kind: "assistant", id: "a1", at: AT, text: "# Plan\n\n- **erst** lesen\n- dann `schreiben`", costUsd: 0.0123 },
    { kind: "reasoning", id: "r1", at: AT, text: "Dann prüfe ich die Schnittstellen des Kompressors.", tokens: 912, live: false, expanded: false, truncated: false },
    {
      kind: "tool",
      id: "t1",
      at: AT,
      tool: "run_command",
      label: "SHELL",
      title: "Shell-Befehl",
      input: "npm test",
      state: "failed",
      exitCode: 1,
      durationMs: 2400,
      tail: ["FAIL tests/session.test.ts", "AssertionError: expected 2 to be 3", "94 passed, 1 failed"],
      totalLines: 214,
      step: 3,
      expanded: false,
    },
    {
      kind: "diff",
      id: "d1",
      at: AT,
      path: "src/session.ts",
      added: diff.added,
      removed: diff.removed,
      hunks: splitHunks(diff.lines),
      hiddenHunks: 4,
      state: "unverified",
      undoable: true,
    },
    {
      kind: "approval",
      id: "p1",
      at: AT,
      risk: "shell",
      summary: "SHELL",
      details: ["rm -rf build dist", "in ~/projekt/routercode"],
      waitingSince: AT,
      rememberHint: "keine gemerkte Regel für „rm“",
    },
    {
      kind: "notice",
      id: "n1",
      at: AT,
      level: "error",
      title: "OpenRouter HTTP 429 rate limited",
      cause: ["Anbieter anthropic, Modell claude-sonnet-4.5. Der Lauf endete nach Schritt 3."],
      actions: [
        { key: "r", label: "erneut" },
        { key: "m", label: "Modell wechseln" },
      ],
    },
  ];
}

test("renderBlock hält für alle sieben Blockarten jede Breite ein", () => {
  for (const block of sampleBlocks()) {
    for (const width of WIDTHS) {
      const lines = renderBlock(block, width, theme, { last: true, now: AT + 7000 });
      assert.equal(lines.length > 0, true, `${block.kind} liefert nichts`);
      for (const item of lines) {
        assert.equal(
          lineWidth(item) <= width,
          true,
          `${block.kind}@${width}: „${plainText(item)}“ (${lineWidth(item)})`,
        );
      }
    }
  }
});

test("ein laufender Toolblock ist immer exakt vier Zeilen hoch", () => {
  const block: ChatBlock = {
    kind: "tool",
    id: "t9",
    at: AT,
    tool: "run_command",
    label: "SHELL",
    title: "Shell-Befehl",
    input: "npm run check",
    state: "running",
    tail: [],
    totalLines: 0,
    step: 1,
    expanded: false,
  };
  for (const count of [0, 1, 3, 50, 500]) {
    block.tail = Array.from({ length: Math.min(count, RUNNING_TAIL_LINES) }, (_, index) => `Zeile ${index}`);
    block.totalLines = count;
    for (const width of WIDTHS) {
      const lines = renderBlock(block, width, theme, { now: AT + 7000 });
      assert.equal(lines.length, 1 + RUNNING_TAIL_LINES, `${count} Ausgabezeilen @${width}`);
    }
  }
});

test("Erfolg kollabiert, Fehler bleibt offen", () => {
  const base = {
    kind: "tool" as const,
    id: "t2",
    at: AT,
    tool: "run_command",
    label: "SHELL",
    title: "Shell-Befehl",
    input: "npm test",
    durationMs: 2400,
    tail: ["eine Ausgabezeile"],
    totalLines: 95,
    step: 2,
    expanded: false,
  };
  const green = renderBlock({ ...base, state: "ok", exitCode: 0 }, 80, theme);
  assert.equal(green.length, 1);
  const red = renderBlock({ ...base, state: "failed", exitCode: 1 }, 80, theme, { last: true });
  assert.equal(red.length > 1, true);
  assert.equal(plainText(red[red.length - 1]!).includes("weitere Zeilen"), true);
});

test("Barrierefreiheit: bei Stufe 0 beginnt jede Zustandszeile mit einem eindeutigen Glyph", () => {
  const glyphs = new Map<BlockState, string>();
  for (const state of BLOCK_STATES) {
    const block: ChatBlock = {
      kind: "tool",
      id: `s-${state}`,
      at: AT,
      tool: "run_command",
      label: "SHELL",
      title: "Shell-Befehl",
      input: "npm test",
      state,
      durationMs: 1200,
      tail: [],
      totalLines: 0,
      step: 1,
      expanded: false,
    };
    const first = plainText(renderBlock(block, 80, theme, { now: AT })[0]!);
    const glyph = Array.from(first)[0] ?? "";
    assert.equal(glyph.trim().length > 0, true, `${state} beginnt mit Leerraum`);
    assert.equal(/[A-Za-z0-9]/.test(glyph), false, `${state} beginnt ohne Glyph`);
    glyphs.set(state, glyph);
  }
  assert.equal(new Set(glyphs.values()).size, BLOCK_STATES.length, [...glyphs].join(" "));

  const diff = plainText(
    renderBlock(sampleBlocks()[4]!, 80, theme)[0]!,
  );
  const approval = plainText(renderBlock(sampleBlocks()[5]!, 80, theme)[0]!);
  const notice = plainText(renderBlock(sampleBlocks()[6]!, 80, theme)[0]!);
  assert.equal(diff.startsWith("±"), true);
  assert.equal(approval.startsWith("⚠"), true);
  assert.equal(notice.startsWith("✗"), true);
});

test("ASCII-Theme kommt ohne Nicht-ASCII aus", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  for (const block of sampleBlocks()) {
    for (const item of renderBlock(block, 60, ascii, { last: true, now: AT })) {
      const text = plainText(item);
      const foreign = Array.from(text).filter((character) => character.codePointAt(0)! > 0x7e);
      // Nutzertext und Modellantwort dürfen Umlaute enthalten, Chrome nicht.
      if (block.kind !== "user" && block.kind !== "assistant" && block.kind !== "approval") {
        assert.deepEqual(foreign.filter((c) => !/[äöüÄÖÜßé–]/.test(c)), [], text);
      }
    }
  }
});

test("renderDiff hält die Breite, kürzt hart und bleibt ohne Farbe unterscheidbar", () => {
  const long = `${"a".repeat(200)}`;
  const diff = diffText(BEFORE, `${AFTER}\n${long}`);
  for (const width of WIDTHS) {
    const lines = renderDiff(diff, width, theme);
    for (const item of lines) {
      assert.equal(lineWidth(item) <= width, true, plainText(item));
    }
    assert.equal(
      lines.some((item) => plainText(item).endsWith("…")),
      true,
      `harte Kürzung fehlt bei ${width}`,
    );
  }
  const signs = renderDiff(diff, 80, theme).map((item) => plainText(item));
  assert.equal(signs.some((item) => /^\│\s+\d+\s\+\s/.test(item)), true);
  assert.equal(signs.some((item) => /^\│\s+\d+\s-\s/.test(item)), true);
});

test("Unified-Parser: Round-Trip erzeugt dieselben Zeilennummern", () => {
  const diff = diffText(BEFORE, AFTER);
  const direct = renderDiff(diff, 120, theme).map(plainText);
  const parsed = renderDiff(parseUnifiedDiff(diff.text), 120, theme).map(plainText);
  const numbers = (lines: string[]): string[] =>
    lines.map((item) => item.replace(/^\S+\s+(\d*)\s.*/, "$1"));
  assert.deepEqual(numbers(parsed), numbers(direct));
});

test("Unified-Parser versteht auch echten git-diff-Text", () => {
  const raw = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1234567..89abcde 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " export {};",
  ].join("\n");
  const parsed = parseUnifiedDiff(raw);
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  assert.equal(parsed.lines[0]?.oldLine, 10);
  assert.equal(parsed.lines.at(-1)?.newLine, 13);
});

test("buildFrame verankert den Stream unten und hält Breite und Höhe ein", () => {
  const blocks = sampleBlocks();
  for (const width of WIDTHS) {
    for (const height of [8, 12, 24, 40]) {
      const frame = buildFrame({
        width,
        height,
        theme,
        blocks,
        inputText: "npm test",
        inputCursor: 8,
        header: { model: "sonnet-4.5", approvalMode: "ask", costUsd: 0.31, workspace: "~/projekt/routercode" },
        status: { phase: "läuft", spinning: true, elapsedMs: 7000 },
        help: "? Tasten",
        now: AT + 7000,
      });
      assert.equal(frame.lines.length, height, `Zeilenzahl @${width}x${height}`);
      for (const item of frame.lines) {
        assert.equal(lineWidth(item) <= width, true, `${width}x${height}: ${plainText(item)}`);
      }
      assert.equal(frame.chatHeight >= 1, true);
      assert.equal(frame.cursor.row <= height, true);
    }
  }
});

test("buildFrame meldet zu kleine Terminals statt zu rendern", () => {
  const frame = buildFrame({ width: 39, height: 24, theme, blocks: [], inputText: "", inputCursor: 0 });
  assert.equal(plainText(frame.lines[0]!).startsWith("Terminal zu klein"), true);
  assert.equal(frame.lines.length, 1);
});

test("Chrome im Ruhezustand sind drei Zeilen", () => {
  const frame = buildFrame({
    width: 80,
    height: 24,
    theme,
    blocks: [],
    inputText: "", inputCursor: 0,
    header: { model: "sonnet-4.5", approvalMode: "ask", costUsd: 0 },
  });
  assert.equal(frame.chatHeight, 24 - 3);
  assert.equal(plainText(frame.lines[frame.lines.length - 2]!).startsWith("─"), true);
  assert.equal(plainText(frame.lines[frame.lines.length - 1]!).startsWith("▌"), true);
});

test("zurückgescrollt zeigt der Rahmen den Scroll-Indikator", () => {
  const blocks = sampleBlocks();
  const frame = buildFrame({
    width: 80,
    height: 14,
    theme,
    blocks,
    inputText: "", inputCursor: 0,
    viewport: { anchor: { blockId: "u1", lineOffset: 0 } },
    newLinesBelow: 12,
    now: AT,
  });
  assert.equal(
    frame.lines.some((item) => plainText(item).startsWith("↑")),
    true,
  );
  assert.equal(
    frame.lines.some((item) => plainText(item).includes("12 neue Zeilen")),
    true,
  );
  assert.equal(frame.maxScrollOffset > 0, true);
});
