import assert from "node:assert/strict";
import test from "node:test";

import { projectPaletteRow } from "../src/gui-protocol.js";
import { resolveDesktopOnboardingCommand } from "../src/gui-server.js";
import {
  commandMenuCrumbParts,
  commandMenuEnterVerb,
  resolveCommandMenuRows,
} from "../src/ui/command-menu.js";

function rowsAt(path: readonly string[], query = ""): ReturnType<typeof resolveCommandMenuRows> {
  return resolveCommandMenuRows({ path: [...path], query, selectedIndex: 0 });
}

test("the palette's verb is FIX-11's verb, not a second reading of the flag", () => {
  // Every row the catalog can produce, both ways, at every level and in
  // search: the projection must never disagree with the terminal's footer.
  const sample = [
    ...rowsAt([]),
    ...rowsAt(["Workspace"]),
    ...rowsAt(["Models"]),
    ...rowsAt(["Models", "cross"]),
    ...rowsAt([], "model"),
    ...rowsAt([], "zzzz-no-such-command"),
  ];
  assert.ok(sample.length > 20);
  for (const row of sample) {
    assert.equal(projectPaletteRow(row).verb, commandMenuEnterVerb(row));
  }
});

test("an argument-less leaf runs, a leaf with arguments inserts", () => {
  const workspace = rowsAt(["Workspace"]).map((row) => projectPaletteRow(row));
  const diff = workspace.find((row) => row.command === "/diff");
  const undo = workspace.find((row) => row.command === "/undo");
  assert.equal(diff?.verb, "run");
  // `/undo [--dry-run]` accepts arguments, so Enter fills the composer:
  // running it would silently discard the flag the palette was opened to type.
  assert.equal(undo?.verb, "insert");
  assert.equal(undo?.usage, "/undo [--dry-run]");
  assert.equal(undo?.description, "Revert the last run's file changes");
  assert.equal(undo?.group, "workspace");
});

test("a browse branch opens, an actionable branch inserts its own token", () => {
  const roots = rowsAt([]).map((row) => projectPaletteRow(row));
  const models = roots.find((row) => row.name === "Models");
  assert.equal(models?.verb, "open");
  // A browse group has no command at all — which is what `open` means.
  assert.equal(models?.command, undefined);

  const inModels = rowsAt(["Models"]).map((row) => projectPaletteRow(row));
  const cross = inModels.find((row) => row.name === "cross");
  assert.equal(cross?.verb, "insert");
  assert.equal(cross?.command, "/cross");
});

test("the no-match row is a way out, never a dead end", () => {
  const [row, ...rest] = rowsAt([], "zzzz-no-such-command").map((entry) => projectPaletteRow(entry));
  assert.equal(rest.length, 0);
  assert.equal(row?.kind, "recovery");
  assert.equal(row?.verb, "open");
  assert.match(row?.description ?? "", /No matches for "zzzz-no-such-command"/);
});

test("the crumb is one composition, joined by whichever surface renders it", () => {
  assert.deepEqual(commandMenuCrumbParts({ path: [], query: "" }), ["Commands"]);
  assert.deepEqual(commandMenuCrumbParts({ path: ["Models", "cross"], query: "" }), [
    "Commands",
    "Models",
    "cross",
  ]);
  // A search reaches every leaf, so it has no location to state.
  assert.deepEqual(commandMenuCrumbParts({ path: ["Models"], query: "swap" }), ["Commands"]);
});

test("a searched row carries its whole canonical path as the command", () => {
  const rows = rowsAt([], "swap").map((row) => projectPaletteRow(row));
  const swap = rows.find((row) => row.command === "/cross swap");
  assert.equal(swap?.kind, "match");
  assert.equal(swap?.verb, "run");
});

test("only the exact canonical provider setup command resolves to Desktop onboarding", () => {
  assert.equal(resolveDesktopOnboardingCommand("/provider setup"), true);
  for (const raw of [
    "/provider",
    "/provider status",
    "/provider setup extra",
    "/provider Setup",
    "/key setup",
  ]) {
    assert.equal(resolveDesktopOnboardingCommand(raw), false, raw);
  }
});
