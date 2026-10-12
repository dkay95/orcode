import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_DIFF_HUNKS,
  looksLikeUnifiedDiff,
  parseUnifiedDiff,
  splitHunks,
} from "../src/diff-parse.js";
import { parseUnifiedDiff as viaDiffView, splitHunks as splitViaDiffView } from "../src/ui/diff-view.js";
import { changePreview, diffText } from "../src/workspace.js";

const SOURCE = new URL("../src/", import.meta.url);

test("there is exactly one unified-diff parser, in src AND in the window", async () => {
  // The hunk-header regex IS the parser, and so is a prefix matcher over
  // diff lines. A second one anywhere is a second reader of the same text,
  // which is the divergence FIX-3 closed for the terminal and G3 closed for
  // the window — so the sweep walks BOTH source trees, not only `src/`
  // (fix round 1, i12: the window is exactly where the fork used to live).
  const roots = [
    { base: SOURCE, label: "src" },
    { base: new URL("../gui/src/", import.meta.url), label: "gui/src" },
  ];
  // The hunk-header REGEX is the signal, and it is the right one: a second
  // reader has to recognise `@@ -a,b +c,d @@` to be a reader at all, and one
  // that does not is worse than useless. A rendering fork that skipped it
  // would still be caught by `gui/tests/diff.test.ts`, which pins the
  // window's own reduction against `splitHunks(parseUnifiedDiff(...))`.
  const hunkHeader = /@@\\s\+-\(\\d\+\)/;
  const declaring: string[] = [];
  // Round-2 re-review regression: a flat readdir silently dropped src/ui —
  // the walk is recursive now, so a parser planted in ANY subdirectory of
  // either tree turns this red.
  for (const root of roots) {
    for (const file of await readdir(root.base, { recursive: true })) {
      const name = String(file);
      if (!name.endsWith(".ts")) continue;
      const text = await readFile(new URL(name, root.base), "utf8");
      if (hunkHeader.test(text)) declaring.push(`${root.label}/${name}`);
    }
  }
  assert.deepEqual(declaring, ["src/diff-parse.ts"]);
});

test("ui/diff-view re-exports the shared reader rather than owning one", () => {
  assert.equal(viaDiffView, parseUnifiedDiff);
  assert.equal(splitViaDiffView, splitHunks);
});

test("a write approval's own preview text parses as a diff", () => {
  // `changePreview` is what `writeApprovalRequest` puts into
  // `ToolCallPreview.details`, so this is literally the string the GUI's
  // approval panel receives.
  const before = ["one", "two", "three", "four", "five"].join("\n");
  const after = ["one", "TWO", "three", "four", "five"].join("\n");
  const details = changePreview(before, after);
  assert.equal(looksLikeUnifiedDiff(details), true);
  const parsed = parseUnifiedDiff(details);
  assert.equal(parsed.added, 1);
  assert.equal(parsed.removed, 1);
  const hunks = splitHunks(parsed.lines);
  assert.equal(hunks.length, 1);
  const changed = hunks[0]!.lines.filter((line) => line.type !== "ctx");
  assert.deepEqual(changed.map((line) => line.text), ["two", "TWO"]);
  // Line numbers survive: the row a reader sees is the row in the file.
  assert.equal(changed[0]!.oldLine, 2);
  assert.equal(changed[1]!.newLine, 2);
});

test("a new file's preview carries no hunk header, and says so", () => {
  const details = changePreview(null, "hello\n");
  assert.equal(looksLikeUnifiedDiff(details), false);
});

test("the hunk cap is one number, shared by both surfaces", () => {
  // Four separated changes in a long file produce four hunks; the cap is
  // three, which is the approval preview's own long-standing budget.
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const changed = [...lines];
  for (const index of [2, 20, 38, 55]) changed[index] = `CHANGED ${index}`;
  const diff = diffText(lines.join("\n"), changed.join("\n"));
  const hunks = splitHunks(diff.lines);
  assert.equal(hunks.length, 4);
  assert.equal(MAX_DIFF_HUNKS, 3);
  assert.equal(hunks.slice(0, MAX_DIFF_HUNKS).length, 3);
});
