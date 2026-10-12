import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderHelpLines } from "../src/commands.js";
import {
  SHORTCUTS,
  SHORTCUT_CONTEXTS,
  listActionChips,
  shortcutHintLine,
  shortcutKeys,
  shortcutsByContext,
} from "../src/ui/keymap.js";
import { createTheme } from "../src/ui/theme.js";
import { actionBarLine } from "../src/ui/zones.js";
import { plainText } from "../src/ui/spans.js";

/**
 * V4-A (zone 3). This used to pin `commandMenuKeyHints`, a `·`-joined string.
 * The generic list consumers show the same four keys with the same four words
 * — the appearance is the change: chips, and the keys are looked up in the
 * table rather than spelled at the call site. Chip order is the mockup's
 * (filter, move, take, insert, leave), which is why Enter now precedes Tab.
 */
test("generic list chips render through the theme and the keymap table, both glyph modes", () => {
  const verbs = { enter: "choose", esc: "back/close", tab: "open" } as const;

  const unicode = createTheme({ level: 0 });
  assert.equal(
    plainText(actionBarLine(unicode, listActionChips(unicode, "Lists & pickers", verbs))),
    "[↑↓] select  [Enter] choose  [Tab] open  [Esc] back/close",
  );

  const ascii = createTheme({ level: 0, ascii: true });
  const asciiLine = plainText(actionBarLine(ascii, listActionChips(ascii, "Lists & pickers", verbs)));
  assert.equal(asciiLine, "[^v] select  [Enter] choose  [Tab] open  [Esc] back/close");
  assert.doesNotMatch(asciiLine, /[^\x00-\x7f]/);
});

/**
 * V4-A: the chips are only "from the one keymap source" while the rows they
 * read actually exist. `listActionChips` silently skips a key it cannot find
 * (a renderer must never throw), so this is the tripwire that makes the skip
 * loud: every key either action bar asks for must still be a row, and every
 * `chip` word must be the single lowercase clause the bar is laid out for.
 */
test("every key the action bars ask for is a keymap row with a chip word (V4-A tripwire)", () => {
  const theme = createTheme({ level: 0 });
  const required = [
    { context: "Palette" as const, keys: ["<up><down>", "Enter", "Tab", "Esc"] },
    { context: "Lists & pickers" as const, keys: ["Typing", "<up><down>", "Enter", "Tab", "Esc"] },
    // V4-B: the Settings action bar's five keys.
    { context: "Settings" as const, keys: ["<left><right>", "<up><down>", "Enter", "/", "Esc"] },
  ];
  for (const { context, keys } of required) {
    for (const wanted of keys) {
      const binding = SHORTCUTS.find((item) => item.context === context && item.keys === wanted);
      assert.ok(binding, `${context} must still bind ${wanted} — the action bar renders it from this table`);
      assert.ok(
        binding!.chip,
        `${context} / ${wanted} needs a chip word: the action bar drops a row that has none`,
      );
      assert.match(
        binding!.chip!,
        /^[a-z][a-z/ ]*$/,
        `${context} / ${wanted}: a chip word is one lowercase clause, not "${binding!.chip}"`,
      );
    }
  }
  // Both bars render every key they were asked for — the count is the proof
  // that nothing was silently skipped.
  assert.equal(listActionChips(theme, "Palette", { tab: "complete" }).length, 4);
  assert.equal(listActionChips(theme, "Lists & pickers", { typing: true, tab: "insert" }).length, 5);
  // A surface that does not bind Tab never advertises it.
  assert.equal(listActionChips(theme, "Palette", {}).length, 3);
  // V4-B: the Settings bar, whose five words all come from the table —
  // `horizontal: true` / `search: true` mean "no override", so key AND word
  // both come from the one source and the call site spells neither.
  assert.deepEqual(
    listActionChips(theme, "Settings", { horizontal: true, search: true })
      .map((chip) => `${chip.key} ${chip.effect}`),
    ["←→ category", "↑↓ row", "Enter change", "/ search", "Esc back"],
  );
  // A surface that does not bind the sideways axis never advertises it.
  assert.equal(listActionChips(theme, "Settings", {}).length, 3);
});

/**
 * V4-A: the chips carry the surface's own truth. FIX-11's whole point was
 * that `Enter run` must not be printed on a row Enter does not run — the
 * override has to reach the rendered line.
 */
test("a caller's verb overrides the table's default chip word (FIX-11 truth survives)", () => {
  const theme = createTheme({ level: 0 });
  const chips = listActionChips(theme, "Palette", { enter: "insert", esc: "back" });
  assert.deepEqual(
    chips.map((chip) => `${chip.key} ${chip.effect}`),
    ["↑↓ select", "Enter insert", "Esc back"],
  );
});

const tuiSource = (): string => readFileSync(new URL("../src/tui.ts", import.meta.url), "utf8");

/**
 * FIX-4's drift tripwire, in the structural-guard style `tests/cli.test.ts`
 * already uses for source-level invariants: the keymap table is a promise
 * made to the user in two places (`/help`'s `─ Shortcuts` section and the `?`
 * footer), so every row must still be answered by a real handler in
 * `tui.ts`. Renaming or deleting a binding without touching the table fails
 * here instead of quietly shipping a lie.
 */
test("every keymap row is still bound in tui.ts's keypress handlers (FIX-4 drift tripwire)", () => {
  const tui = tuiSource();
  const unbound: string[] = [];
  for (const binding of SHORTCUTS) {
    if (binding.pendingLane) continue;
    assert.ok(
      binding.proof.length > 0,
      `${binding.keys} claims a binding but names no handler proof`,
    );
    for (const proof of binding.proof) {
      if (!tui.includes(proof)) unbound.push(`${binding.keys} (${binding.context}): ${proof}`);
    }
  }
  assert.deepEqual(
    unbound,
    [],
    "the keymap table claims bindings tui.ts no longer has — fix the table or the handler",
  );
});

/**
 * `pendingLane` existed for exactly one merge coupling: FIX-4 stated the
 * Shift+Tab row ahead of FIX-1's handler, and this test tripped at FIX-1's
 * merge so the flag got deleted and the row a real `proof` (done 2026-08-28).
 * The surviving invariant is the inverse: the flag is a merge coupling, not a
 * parking lot — no row may sit pending outside such a declared two-lane deal.
 */
test("no keymap row is left pending — pendingLane is a merge coupling, not a parking lot", () => {
  const pending = SHORTCUTS.filter((binding) => binding.pendingLane);
  assert.deepEqual(
    pending.map((binding) => `${binding.keys} <- ${binding.pendingLane}`),
    [],
    "a pending row must name a live parallel lane and be reconciled at its merge",
  );
});

test("`/help`'s Shortcuts section renders every keymap row, grouped by context", () => {
  const theme = createTheme({ level: 0 });
  const rendered = renderHelpLines(theme, 200).map((line) =>
    line.spans.map((entry) => entry.text).join(""),
  );
  const divider = theme.glyph("divider");
  const sectionStart = rendered.indexOf(`${divider} Shortcuts`);
  assert.ok(sectionStart >= 0, "`/help` must open a `─ Shortcuts` section");
  const section = rendered.slice(sectionStart);

  // Every context rule, in the table's own order, and nothing else.
  assert.deepEqual(
    section.filter((line) => SHORTCUT_CONTEXTS.some((name) => line === `${divider} ${name}`)),
    shortcutsByContext().map((group) => `${divider} ${group.context}`),
  );
  assert.deepEqual(shortcutsByContext().map((group) => group.context), [...SHORTCUT_CONTEXTS]);

  // Every row: key column and full description, at a width wide enough that
  // nothing ellipsizes — so a row silently dropped from the renderer fails.
  for (const binding of SHORTCUTS) {
    const keys = shortcutKeys(theme, binding);
    const row = section.find(
      (line) => line.startsWith(`  ${keys} `) && line.endsWith(binding.action),
    );
    assert.ok(row, `\`/help\` never printed the ${binding.context} row for ${keys}`);
  }
});

test("the Shortcuts key column never truncates at the 40-column floor — the description ellipsizes instead", () => {
  const theme = createTheme({ level: 0 });
  const narrow = renderHelpLines(theme, 40).map((line) =>
    line.spans.map((entry) => entry.text).join(""),
  );
  // The table's widest key (`Ctrl+Home / Ctrl+End`, 20 columns) consumes the
  // whole 40-column name column plus indent, exactly like the catalog's
  // longest `/name` does — and survives intact.
  const widest = narrow.find((line) => line.trimStart().startsWith("Ctrl+Home / Ctrl+End"));
  assert.equal(widest, "  Ctrl+Home / Ctrl+End  Jump to the top…");
  assert.ok(widest!.endsWith(theme.glyph("ellipsis")));
  for (const binding of SHORTCUTS) {
    const keys = shortcutKeys(theme, binding);
    assert.ok(
      narrow.some((line) => line.startsWith(`  ${keys}`)),
      `${keys} truncated at the 40-column floor`,
    );
  }
});

test("the `?` footer hint is the six most-missed bindings, straight out of the table, one line, ASCII-clean", () => {
  const theme = createTheme({ level: 0 });
  assert.equal(
    shortcutHintLine(theme),
    "/ commands · @ files · Ctrl+P palette · Ctrl+O thinking · Shift+Enter newline · Ctrl+C cancel",
  );
  assert.equal(SHORTCUTS.filter((binding) => binding.hint).length, 6);
  assert.doesNotMatch(shortcutHintLine(theme), /\n/);

  const ascii = createTheme({ level: 0, ascii: true });
  assert.doesNotMatch(shortcutHintLine(ascii), /[^\x00-\x7f]/);
  // Every hinted key also stands as a full row in `/help` — the footer is a
  // view of the table, never a second list.
  for (const binding of SHORTCUTS.filter((entry) => entry.hint)) {
    assert.ok(shortcutHintLine(theme).includes(`${binding.keys} ${binding.hint}`));
  }
});

/**
 * FIX-14 ticket 1 (one hint grammar). The audit found three spellings of the
 * same key in rendered hints: `Ctrl+O` (the keymap table's own form, used by
 * `/help`, the `?` footer and the reasoning block), `ctrl+o` (the tool
 * block's expand hints) and `esc …` (the interjection hints), all on screen
 * at once and sometimes within four lines of each other.
 *
 * The one standard, taken from the keymap table because it is the surface
 * that TEACHES the bindings: a key token is Title-Case, a modifier is joined
 * with `+` and both halves are Title-Case (`Ctrl+O`, `Shift+Enter`,
 * `Alt+Left`), and the verb after it is lowercase (`Ctrl+O expand`,
 * `Esc cancels`).
 *
 * This is a source-level guard in the same style as the drift tripwire
 * above: the rendered-string sites live behind width fitting, glyph modes
 * and run state, so pinning every frame that can show a hint is neither
 * complete nor readable. Comment lines are stripped first — prose about a
 * key is not a hint.
 */
test("no rendered UI hint spells a key name in lowercase (FIX-14 ticket 1 grammar tripwire)", () => {
  const files = [
    "../src/tui.ts",
    "../src/ui/render-block.ts",
    "../src/ui/render-frame.ts",
    "../src/ui/dashboard-frame.ts",
    "../src/ui/list-core.ts",
    "../src/ui/list-plain.ts",
    "../src/ui/keymap.ts",
    "../src/ui/workbench.ts",
    "../src/ui/settings-frame.ts",
    "../src/ui/view-model.ts",
  ];
  // Every lowercase spelling of a key token the product actually binds.
  const forbidden = /\b(?:ctrl|alt|shift|cmd)\+|(?:^|[ (·-])(?:esc|enter|tab|backspace|pgup|pgdn)(?=[ .,)·-]|$)/;
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    source.split("\n").forEach((line, index) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      for (const text of stringLiterals(code)) {
        // A literal with no inner whitespace is a key IDENTIFIER
        // (`key.name === "enter"`), never a hint — a hint always pairs the
        // key with a verb.
        if (!/\S\s\S/.test(text)) continue;
        if (forbidden.test(text)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these lines spell a key name in lowercase; the one grammar is the keymap table's\n${offenders.join("\n")}`,
  );
});

/**
 * The string CONTENT of one source line — quoted literals plus the static
 * chunks of template literals, with `${…}` holes skipped as the code they
 * are. Written as a scanner rather than a regex because a template literal
 * can contain quoted literals inside its holes (`` `a${x ? "b" : "c"}` ``),
 * and a regex that consumes from backtick to backtick swallows exactly the
 * copy this guard is looking for.
 */
function stringLiterals(code: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < code.length) {
    const quote = code[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }
    index += 1;
    let text = "";
    while (index < code.length && code[index] !== quote) {
      if (code[index] === "\\") {
        index += 2;
        continue;
      }
      if (quote === "`" && code[index] === "$" && code[index + 1] === "{") {
        // Skip the hole, brace-balanced, and collect any literals inside it.
        let depth = 1;
        const from = index + 2;
        index = from;
        while (index < code.length && depth > 0) {
          if (code[index] === "{") depth += 1;
          else if (code[index] === "}") depth -= 1;
          index += 1;
        }
        out.push(...stringLiterals(code.slice(from, Math.max(from, index - 1))));
        out.push(text);
        text = "";
        continue;
      }
      text += code[index];
      index += 1;
    }
    index += 1;
    out.push(text);
  }
  return out;
}
