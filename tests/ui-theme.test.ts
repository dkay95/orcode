import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, type Role } from "../src/ui/spans.js";
import { createTheme, spinnerFrame } from "../src/ui/theme.js";

const EXPECTED: Record<Role, { 3: string; 2: string; 1: string }> = {
  text: { 3: "", 2: "", 1: "" },
  muted: { 3: "\u001b[38;2;139;148;158m", 2: "\u001b[38;5;245m", 1: "\u001b[2m" },
  structure: { 3: "\u001b[38;2;75;85;99m", 2: "\u001b[38;5;240m", 1: "\u001b[2m" },
  accent: { 3: "\u001b[38;2;110;168;254m", 2: "\u001b[38;5;111m", 1: "\u001b[36m" },
  active: { 3: "\u001b[38;2;217;164;65m", 2: "\u001b[38;5;179m", 1: "\u001b[33m" },
  ok: { 3: "\u001b[38;2;63;185;80m", 2: "\u001b[38;5;114m", 1: "\u001b[32m" },
  warn: { 3: "\u001b[38;2;210;153;34m", 2: "\u001b[38;5;178m", 1: "\u001b[33m" },
  danger: { 3: "\u001b[38;2;248;81;73m", 2: "\u001b[38;5;203m", 1: "\u001b[31m" },
  add: { 3: "\u001b[38;2;63;185;80m", 2: "\u001b[38;5;114m", 1: "\u001b[32m" },
  del: { 3: "\u001b[38;2;248;81;73m", 2: "\u001b[38;5;203m", 1: "\u001b[31m" },
  inverse: { 3: "\u001b[7m", 2: "\u001b[7m", 1: "\u001b[7m" },
};

test("jede Rolle erzeugt auf Stufe 3, 2 und 1 genau den spezifizierten Präfix", () => {
  for (const level of [3, 2, 1] as const) {
    const theme = createTheme({ level });
    for (const role of ROLES) {
      const painted = theme.color(role)("x");
      const expected = EXPECTED[role][level];
      assert.equal(
        painted.startsWith(expected),
        true,
        `${role}@${level}: ${JSON.stringify(painted)} beginnt nicht mit ${JSON.stringify(expected)}`,
      );
      if (expected === "") {
        assert.equal(painted, "x", `${role}@${level} darf keinen Code tragen`);
      }
    }
  }
});

test("Rolle text trägt in keiner Stufe einen Vordergrundcode", () => {
  for (const level of [0, 1, 2, 3] as const) {
    const theme = createTheme({ level });
    assert.equal(theme.color("text")("Antwort"), "Antwort");
  }
});

test("Stufe 0 färbt gar nicht", () => {
  const theme = createTheme({ level: 0 });
  for (const role of ROLES) {
    assert.equal(theme.color(role)("x"), "x");
    assert.equal(theme.color(role, { bold: true, underline: true })("x"), "x");
  }
});

test("keine Rolle setzt eine Hintergrundfarbe", () => {
  const theme = createTheme({ level: 3 });
  for (const role of ROLES) {
    const painted = theme.color(role)("x");
    assert.equal(/\u001b\[(4[0-79]|10[0-7]|48;)/.test(painted), false, role);
  }
});

test("bold und underline sind orthogonal zur Rolle", () => {
  const theme = createTheme({ level: 1 });
  const bold = theme.color("ok", { bold: true })("x");
  assert.equal(bold.includes("\u001b[1m"), true);
  assert.equal(bold.includes("\u001b[32m"), true);
  const underline = theme.color("text", { underline: true })("x");
  assert.equal(underline.includes("\u001b[4m"), true);
});

test("Glyphtabelle hat beide Sätze und eindeutige Zustandszeichen", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  assert.equal(unicode.glyph("ok"), "✓");
  assert.equal(unicode.glyph("failed"), "✗");
  assert.equal(unicode.glyph("warn"), "⚠");
  assert.equal(unicode.glyph("divider"), "─");
  assert.equal(unicode.glyph("userGutter"), "▌");
  assert.equal(ascii.glyph("ok"), "+");
  assert.equal(ascii.glyph("failed"), "x");
  assert.equal(ascii.glyph("warn"), "!");
  assert.equal(ascii.glyph("divider"), "-");
  assert.equal(ascii.glyph("userGutter"), ">");
  assert.equal(ascii.ascii, true);

  for (const theme of [unicode, ascii]) {
    const states = ["ok", "unverified", "failed", "warn", "toolHead"] as const;
    const seen = new Set(states.map((name) => theme.glyph(name)));
    assert.equal(seen.size, states.length, "Zustandsglyphen müssen eindeutig sein");
  }
});

test("ASCII-Glyphen sind reines ASCII", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  const names = [
    "userGutter",
    "toolHead",
    "diffHead",
    "blockEdge",
    "blockFoot",
    "divider",
    "marker",
    "spinner",
    "ok",
    "unverified",
    "failed",
    "warn",
    "quoteGutter",
    "scrollUp",
    "separator",
    "ellipsis",
    "mask",
  ] as const;
  for (const name of names) {
    // eslint-disable-next-line no-control-regex
    assert.equal(/^[\x20-\x7e]+$/.test(ascii.glyph(name)), true, name);
  }
});

test("genau ein Spinner, der zyklisch läuft", () => {
  const theme = createTheme({ level: 0 });
  const frames = Array.from(theme.glyph("spinner"));
  assert.equal(frames.length, 10);
  assert.equal(spinnerFrame(theme, 0), frames[0]);
  assert.equal(spinnerFrame(theme, frames.length), frames[0]);
  assert.equal(spinnerFrame(theme, -1), frames[frames.length - 1]);
});
