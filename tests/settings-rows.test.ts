import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { settingsCrumbParts, settingsDisplayRows } from "../src/settings-rows.js";

test("a heading is drawn only where the section changes", () => {
  const rows = settingsDisplayRows(
    [
      { id: "a", section: "Main" },
      { id: "b", section: "Main" },
      { id: "c", section: "Cross pair" },
      { id: "d", section: "Cross pair" },
    ],
    false,
  );
  assert.deepEqual(
    rows.map((row) => (row.kind === "heading" ? `─ ${row.heading}` : row.item.id)),
    ["─ Main", "a", "b", "─ Cross pair", "c", "d"],
  );
});

test("a category with no sections gets no invented heading", () => {
  const items: { id: string; section?: string }[] = [{ id: "a" }, { id: "b" }];
  const rows = settingsDisplayRows(items, false);
  assert.equal(rows.every((row) => row.kind === "item"), true);
});

test("a search suppresses headings — the results are not one category", () => {
  const items = [{ id: "a", section: "Main" }, { id: "b", section: "Keys" }];
  assert.equal(settingsDisplayRows(items, true).every((row) => row.kind === "item"), true);
  assert.equal(settingsDisplayRows(items, false).filter((row) => row.kind === "heading").length, 2);
});

test("the crumb names the category, the search, and the open editor", () => {
  const view = {
    categories: [
      { id: "models", label: "Models" },
      { id: "accounts", label: "Accounts" },
    ],
    selectedCategoryId: "models",
    search: { active: false },
  };
  assert.deepEqual(settingsCrumbParts(view), ["Settings", "Models"]);
  // V4-B: "Beim Editieren wächst die Brotkrume mit".
  assert.deepEqual(settingsCrumbParts(view, "Main model"), ["Settings", "Models", "Main model"]);
  assert.deepEqual(
    settingsCrumbParts({ ...view, search: { active: true } }),
    ["Settings", "Search"],
  );
});

test("the terminal's own frame reads the shared rules, not a copy", async () => {
  const frame = await readFile(new URL("../src/ui/settings-frame.ts", import.meta.url), "utf8");
  assert.match(frame, /settingsDisplayRows\(view\.items, view\.search\.active\)/);
  assert.match(frame, /settingsCrumbParts\(view\)/);
  // And it no longer walks the items itself.
  assert.equal(/let section: string \| undefined;/.test(frame), false);
});
