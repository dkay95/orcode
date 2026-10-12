import assert from "node:assert/strict";
import test from "node:test";

import { diffText } from "../src/workspace.js";
import type { BlockState, ChatBlock } from "../src/ui/blocks.js";
import { BLOCK_STATES, RUNNING_TAIL_LINES } from "../src/ui/blocks.js";
import { parseUnifiedDiff, renderDiff, splitHunks } from "../src/ui/diff-view.js";
import { buildFrame } from "../src/ui/render-frame.js";
import { APPROVAL_DETAIL_LINES, renderBlock } from "../src/ui/render-block.js";
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
    { kind: "reasoning", id: "r1", at: AT, text: "Dann prüfe ich die Schnittstellen des Kompressors.", tokens: 912, estimated: false, live: false, expanded: false, truncated: false },
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
      truncated: diff.truncated,
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
      expanded: false,
    },
    {
      kind: "notice",
      id: "n1",
      at: AT,
      level: "error",
      title: "OpenRouter HTTP 429 rate limited",
      cause: ["Anbieter anthropic, Modell claude-sonnet-4.5. Der Lauf endete nach Schritt 3."],
    },
    {
      kind: "panel",
      id: "pn1",
      at: AT,
      result: {
        question: "Welche Cache-Strategie passt hier am besten?",
        answers: [
          {
            model: "anthropic/claude-opus-5",
            text: "Nutze einen Write-Through-Cache mit kurzer TTL, weil sich die Daten selten ändern.",
            costUsd: 0.004,
            durationMs: 1800,
            inputTokens: 120,
            outputTokens: 60,
            error: null,
          },
          {
            model: "openai/gpt-5.1-codex-mini",
            text: "",
            costUsd: 0,
            durationMs: 900,
            inputTokens: 0,
            outputTokens: 0,
            error: "OpenRouter HTTP 429: Rate limit reached.",
          },
        ],
        totalCostUsd: 0.004,
        durationMs: 1800,
      },
      judgment: null,
      expandedIndex: null,
    },
  ];
}

test("renderBlock hält für alle acht Blockarten jede Breite ein", () => {
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

test("Erfolg zeigt Kopf + eine Ergebniszeile, Fehler bleibt offen", () => {
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
  // Controller decision C: success no longer collapses to the head alone —
  // the outcome (✓) moved off the head onto its own `⎿` result line, so
  // NO_COLOR still shows it even for a successful, collapsed call.
  assert.equal(green.length, 2);
  assert.equal(plainText(green[0]!).startsWith("● Shell(npm test)"), true);
  assert.equal(plainText(green[1]!).startsWith("⎿ ✓ eine Ausgabezeile"), true);
  const red = renderBlock({ ...base, state: "failed", exitCode: 1 }, 80, theme, { last: true });
  assert.equal(red.length > 2, true);
  assert.equal(plainText(red[0]!).startsWith("● Shell(npm test)"), true);
  assert.equal(plainText(red[1]!).startsWith("⎿ ✗ eine Ausgabezeile"), true);
  assert.equal(plainText(red[red.length - 1]!).includes("more lines"), true);
});

test("a finished reasoning block reads its head line in English — thought/tokens/Ctrl+O expand·collapse", () => {
  const base = {
    kind: "reasoning" as const,
    id: "r9",
    at: AT,
    text: "irrelevant to the head line under test",
    tokens: 912,
    estimated: true,
    live: false,
    truncated: false,
  };
  const collapsed = plainText(renderBlock({ ...base, expanded: false }, 80, theme)[0]!);
  const expanded = plainText(renderBlock({ ...base, expanded: true }, 80, theme)[0]!);
  assert.equal(collapsed, "● thought · ~912 tokens · Ctrl+O expand");
  assert.equal(expanded, "● thought · ~912 tokens · Ctrl+O collapse");
});

function toolBlockForState(state: BlockState): ChatBlock {
  return {
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
}

test("Barrierefreiheit: bei Stufe 0 trägt jede Zustandszeile ein eindeutiges Glyph — am Kopf während des Laufs, sonst in der Ergebniszeile", () => {
  // Controller decision C: the head bullet is constant (`●`, accent) for
  // every state but "running" — the per-state, NO_COLOR-safe glyph moved to
  // the first result line (`⎿ <outcome> …`) instead.
  const glyphs = new Map<BlockState, string>();
  for (const state of BLOCK_STATES) {
    const lines = renderBlock(toolBlockForState(state), 80, theme, { now: AT });
    if (state === "running") {
      const head = plainText(lines[0]!);
      glyphs.set(state, Array.from(head)[0] ?? "");
      continue;
    }
    assert.equal(plainText(lines[0]!).startsWith("● "), true, `${state} head must be the constant bullet`);
    const outcomeLine = plainText(lines[1]!);
    assert.equal(outcomeLine.startsWith("⎿ "), true, `${state} must have an outcome result line`);
    const glyph = Array.from(outcomeLine)[2] ?? "";
    assert.equal(glyph.trim().length > 0, true, `${state} outcome glyph is blank`);
    assert.equal(/[A-Za-z0-9]/.test(glyph), false, `${state} outcome starts without a glyph`);
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
      // Nutzertext und Modellantwort (auch aus dem Panel) dürfen Umlaute
      // enthalten, Chrome nicht.
      if (
        block.kind !== "user" &&
        block.kind !== "assistant" &&
        block.kind !== "approval" &&
        block.kind !== "panel"
      ) {
        assert.deepEqual(foreign.filter((c) => !/[äöüÄÖÜßé–]/.test(c)), [], text);
      }
    }
  }
});

// F6 fix round 1: the sweep above deliberately excludes "user" blocks from
// its strict ASCII check (free user-typed text may carry umlauts) — which
// means it can never catch a raw non-ASCII literal in *chrome* a "user"
// block also renders, like the interjection-accepted footer. That exact
// gap let one through: `foot(theme, usable, "Interjection accepted —
// feeds into the next step")` carried a raw em dash with no ASCII branch.
// This test targets that one footer line directly, in both glyph modes.
test("the interjection-accepted footer is theme-driven, not a raw em dash", () => {
  const block: ChatBlock = {
    kind: "user",
    id: "u1",
    at: AT,
    text: "Bitte auch die Tests prüfen",
    attachmentCount: 0,
    interjected: true,
  };
  const unicode = createTheme({ level: 0 });
  const unicodeFoot = plainText(renderBlock(block, 60, unicode, { last: true, now: AT }).at(-1)!);
  assert.match(unicodeFoot, /⎿ Interjection accepted — feeds into the next step/u);

  const ascii = createTheme({ level: 0, ascii: true });
  const asciiFoot = plainText(renderBlock(block, 60, ascii, { last: true, now: AT }).at(-1)!);
  // FIX-21 finding 3: the elbow's ASCII pair is a corner shape now, not the
  // backtick that read as debris.
  assert.match(asciiFoot, /L Interjection accepted - feeds into the next step/u);
  assert.doesNotMatch(asciiFoot, /[^\x00-\x7f]/u, asciiFoot);
});

// FIX-3: the diff block was implemented but unreachable — every production
// edit now renders one, so its glyph pairs and its foot have to hold up in
// both modes, colorless included.
test("FIX-3: the applied-edit block keeps its meaning in ascii and without color", () => {
  const block = sampleBlocks()[4]!;
  const unicode = plainText(renderBlock(block, 80, createTheme({ level: 0 }), { last: true, now: AT })[0]!);
  assert.equal(unicode.startsWith("±"), true);

  const ascii = createTheme({ level: 0, ascii: true });
  const lines = renderBlock(block, 80, ascii, { last: true, now: AT }).map(plainText);
  assert.equal(lines[0]!.startsWith("~"), true, lines[0]);
  assert.match(lines[0]!, /src\/session\.ts/);
  // +/- stay literal signs in both modes, so a colorless terminal can still
  // tell an added line from a removed one.
  assert.equal(lines.slice(1, -1).some((line) => /\|\s+\d+ \+ /.test(line)), true, lines.join("\n"));
  assert.equal(lines.slice(1, -1).some((line) => /\|\s+\d+ - /.test(line)), true, lines.join("\n"));
  const foot = lines.at(-1)!;
  assert.match(foot, /more hunks/);
  assert.match(foot, /applied/);
  assert.match(foot, /\/undo reverts the run/);
  for (const line of lines) {
    assert.doesNotMatch(line, /[^\x00-\x7f]/u, line);
  }
});

// Keyboard-audit addendum: the tool block's expand hint named a bare `o`
// nothing ever bound. It names the key the dispatch really carries now, and
// follows the block's own state exactly like the reasoning line does.
test("FIX-3 addendum: the tool block's more-lines hint names Ctrl+O, never a bare o", () => {
  const failed = sampleBlocks()[3]! as Extract<ChatBlock, { kind: "tool" }>;
  const collapsed = plainText(renderBlock(failed, 80, theme, { last: true, now: AT }).at(-1)!);
  assert.match(collapsed, /more lines/);
  assert.match(collapsed, /Ctrl\+O expand/);
  assert.doesNotMatch(collapsed, /(^|[^+])\bo open\b/);

  const expanded = plainText(
    renderBlock({ ...failed, expanded: true }, 80, theme, { last: true, now: AT }).at(-1)!,
  );
  assert.match(expanded, /Ctrl\+O collapse/);

  // Not the last block: no key hint at all, only the honest line count.
  const middle = plainText(renderBlock(failed, 80, theme, { now: AT }).at(-1)!);
  assert.match(middle, /more lines/);
  assert.doesNotMatch(middle, /Ctrl\+O/);
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
        header: { workspace: "~/projekt/routercode" },
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
  assert.equal(plainText(frame.lines[0]!).startsWith("Terminal too small"), true);
  assert.equal(frame.lines.length, 1);
});

test("Chrome im Ruhezustand sind drei Zeilen", () => {
  const frame = buildFrame({
    width: 80,
    height: 24,
    theme,
    blocks: [],
    inputText: "", inputCursor: 0,
    header: { workspace: "~/projekt/routercode" },
  });
  assert.equal(frame.chatHeight, 24 - 3);
  assert.equal(plainText(frame.lines[frame.lines.length - 2]!).startsWith("─"), true);
  assert.equal(plainText(frame.lines[frame.lines.length - 1]!).startsWith(">"), true);
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
    frame.lines.some((item) => plainText(item).includes("12 new lines")),
    true,
  );
});

test("a huge pending change never crowds out the approval question", () => {
  // Writing a 600-line file used to render 600 lines, pushing the question and
  // its key hints out of the terminal — the run looked frozen while it was
  // waiting for an answer nobody could see.
  const theme = createTheme({ level: 0 });
  const block: ChatBlock = {
    kind: "approval",
    id: "ap1",
    at: AT,
    risk: "edit",
    summary: "Datei schreiben: index.html",
    details: Array.from({ length: 600 }, (_, i) => `<div class="z-${i}">Inhalt ${i}</div>`),
    waitingSince: AT,
    rememberHint: "keine gemerkte Regel für diese Aktion",
    expanded: false,
  };

  const lines = renderBlock(block, 100, theme, { last: true });

  assert.ok(
    lines.length <= APPROVAL_DETAIL_LINES + 4,
    `approval block grew to ${lines.length} lines`,
  );
  const text = lines.map((line) => plainText(line)).join("\n");
  assert.match(text, /… 590 more lines/);
  assert.match(text, /Ctrl\+O shows all/);
  assert.match(text, /Datei schreiben: index\.html/);
});

// Audit FIX-1 (2026-08-28): the "Ctrl+O shows all" hint above must be TRUE —
// an expanded approval renders every detail line, and the hint flips to the
// file's established collapse wording.
test("an expanded approval shows every detail line and offers Ctrl+O collapse", () => {
  const theme = createTheme({ level: 0 });
  const block: ChatBlock = {
    kind: "approval",
    id: "ap2",
    at: AT,
    risk: "edit",
    summary: "Datei schreiben: index.html",
    details: Array.from({ length: 600 }, (_, i) => `<div class="z-${i}">Inhalt ${i}</div>`),
    waitingSince: AT,
    rememberHint: "keine gemerkte Regel für diese Aktion",
    expanded: true,
  };

  const lines = renderBlock(block, 100, theme, { last: true });
  const text = lines.map((line) => plainText(line)).join("\n");

  assert.ok(lines.length >= 600, `expanded approval rendered only ${lines.length} lines`);
  assert.match(text, /z-599/);
  assert.match(text, /Ctrl\+O collapse/);
  assert.doesNotMatch(text, /more lines/);
  assert.doesNotMatch(text, /Ctrl\+O shows all/);
});
