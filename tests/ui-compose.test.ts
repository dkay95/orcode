import assert from "node:assert/strict";
import test from "node:test";

import {
  composeLine,
  displayWidth,
  fitSpans,
  renderLines,
  wrapSpans,
  type Segment,
} from "../src/ui/compose.js";
import { line, lineWidth, plainText, span } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { markdownToLines } from "../src/ui/markdown.js";

const WIDTHS = [40, 60, 80, 120] as const;

function headerSegments(): Segment[] {
  return [
    { spans: [span("anthropic/claude-sonnet-4.5", "text")], align: "left", priority: 100 },
    { spans: [span("· ask", "warn")], align: "left", priority: 95 },
    { spans: [span("$0.31", "muted")], align: "right", priority: 90 },
    { spans: [span("Kontext 42%", "muted")], align: "left", priority: 80 },
    {
      spans: [span("~/projekt/routercode", "muted")],
      compact: [span("routercode", "muted")],
      align: "left",
      priority: 60,
    },
  ];
}

test("composeLine überschreitet nie die Breite und lässt ganze Segmente weg", () => {
  for (const width of WIDTHS) {
    const result = composeLine(headerSegments(), width);
    const text = plainText(result);
    assert.equal(lineWidth(result) <= width, true, `Breite ${width}: ${text}`);

    const parts = ["anthropic/claude-sonnet-4.5", "· ask", "$0.31", "Kontext 42%"];
    for (const part of parts) {
      if (text.includes(part.slice(0, 3))) {
        assert.equal(text.includes(part), true, `${part} steht halb da (${width})`);
      }
    }
    // Modell (100) und Modus (95) überleben in jeder erlaubten Breite.
    assert.equal(text.includes("ask"), true, `Modus fehlt bei ${width}`);
  }
});

test("das unwichtigste Segment fällt zuerst weg", () => {
  const narrow = plainText(composeLine(headerSegments(), 40));
  const wide = plainText(composeLine(headerSegments(), 120));
  assert.equal(wide.includes("~/projekt/routercode"), true);
  assert.equal(narrow.includes("routercode"), false);
  assert.equal(narrow.includes("anthropic/claude-sonnet-4.5"), true);
});

test("vor dem Weglassen greift die Kurzform", () => {
  const result = plainText(composeLine(headerSegments(), 70));
  assert.equal(result.includes("routercode"), true);
  assert.equal(result.includes("~/projekt/routercode"), false);
});

test("ein einzelnes zu langes Segment endet auf … und ist exakt breit", () => {
  const long = "x".repeat(300);
  for (const width of WIDTHS) {
    const result = composeLine(
      [{ spans: [span(long, "text")], align: "left", priority: 100 }],
      width,
    );
    assert.equal(lineWidth(result), width, `Breite ${width}`);
    assert.equal(plainText(result).endsWith("…"), true);
  }
});

test("fitSpans kürzt spanweise und respektiert das ASCII-Kürzungszeichen", () => {
  const spans = [span("abcdef", "text"), span("ghijkl", "muted")];
  const cut = fitSpans(spans, 8);
  assert.equal(plainText(line(...cut)), "abcdefg…");
  const ascii = fitSpans(spans, 8, "...");
  assert.equal(plainText(line(...ascii)), "abcde...");
  assert.deepEqual(fitSpans(spans, 40), spans);
});

test("renderLines erzeugt bei Stufe 0 kein einziges ESC", () => {
  const theme = createTheme({ level: 0 });
  const rendered = renderLines(
    [line(span("✓ npm test", "ok"), span(" 2.4s", "muted"))],
    theme,
  );
  assert.equal(rendered.join("").includes("\u001b"), false);
  assert.equal(rendered[0], "✓ npm test 2.4s");
});

test("renderLines färbt ab Stufe 1", () => {
  const theme = createTheme({ level: 1 });
  const rendered = renderLines([line(span("ok", "ok"))], theme);
  assert.equal(rendered[0]?.includes("\u001b[32m"), true);
});

test("displayWidth zählt Zellen für CJK, Emoji und kombinierende Zeichen", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("你好"), 4);
  assert.equal(displayWidth("こんにちは"), 10);
  assert.equal(displayWidth("👍"), 2);
  assert.equal(displayWidth("👍🏽"), 2);
  assert.equal(displayWidth("👨‍👩‍👧"), 2);
  assert.equal(displayWidth("🇩🇪"), 2);
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth("áb̂"), 2);
  assert.equal(displayWidth("Füße"), 4);
});

test("Kürzung schneidet keine Emoji-Sequenz auseinander", () => {
  const cut = fitSpans([span("👨‍👩‍👧👍🏽ende", "text")], 5);
  const text = plainText(line(...cut));
  assert.equal(displayWidth(text) <= 5, true);
  assert.equal(text.includes("‍") ? text.startsWith("👨‍👩‍👧") : true, true);
});

test("wrapSpans bricht an Wortgrenzen und hält die Breite", () => {
  const wrapped = wrapSpans([span("eins zwei drei vier fünf sechs", "text")], 12);
  for (const item of wrapped) {
    assert.equal(lineWidth(item) <= 12, true, plainText(item));
  }
  assert.equal(plainText(wrapped[0]!).startsWith("eins"), true);
});

test("Markdown wird übersetzt, nicht entfernt", () => {
  const theme = createTheme({ level: 0 });
  const lines = markdownToLines(
    ["# Titel", "", "**fett** und `code`", "- eins", "- zwei", "> Zitat"].join("\n"),
    40,
    theme,
  );
  const text = lines.map(plainText);
  assert.equal(text[0], "Titel");
  assert.equal(text.some((item) => item.includes("fett und code")), true);
  assert.equal(text.some((item) => item.startsWith("– eins")), true);
  assert.equal(text.some((item) => item.startsWith("▏ Zitat")), true);

  const roles = lines.flatMap((item) => item.spans);
  assert.equal(roles.some((item) => item.text === "fett" && item.bold === true), true);
  assert.equal(roles.some((item) => item.text === "code" && item.role === "structure"), true);
  assert.equal(roles.some((item) => item.text === "Titel" && item.role === "accent"), true);
  for (const item of lines) {
    assert.equal(lineWidth(item) <= 40, true, plainText(item));
  }
});
