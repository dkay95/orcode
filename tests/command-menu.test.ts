import assert from "node:assert/strict";
import test from "node:test";
import { budgetLimitsLabel } from "../src/commands.js";
import { DEFAULT_BUDGET } from "../src/config.js";
import { formatUsd } from "../src/utils.js";
import {
  commandMenuEnterVerb,
  projectCommandMenu,
  resolveCommandMenuRows,
} from "../src/ui/command-menu.js";
import { displayWidth } from "../src/ui/compose.js";
import { buildDashboardFrame } from "../src/ui/dashboard-frame.js";
import { createTheme } from "../src/ui/theme.js";

test("the root projection is the ordered hierarchy from the sole command tree", () => {
  const projection = projectCommandMenu({ path: [], query: "", selectedIndex: 0 }, new Map());

  assert.equal(projection.breadcrumb, "Commands");
  assert.deepEqual(projection.entries.map((entry) => entry.name), [
    "Models", "Chat", "Workspace", "Accounts", "Approvals & Costs", "System",
  ]);
});

test("menu frames retain breadcrumb and pagination at the supported compact sizes", () => {
  const entries = projectCommandMenu({ path: [], query: "", selectedIndex: 5 }, new Map()).entries;
  const render = (width: number, height: number): string => {
    const frame = buildDashboardFrame({
      width, height, theme: createTheme({ level: 0 }),
      state: { workspace: "w", model: "m", approval: "ask", reasoning: "auto", maxCost: "$1", maxSteps: 1 },
      blocks: [], mode: "input", input: "/", cursor: 1, status: "Ready",
      list: { entries, selectedIndex: 5, heading: "Commands", breadcrumb: "Commands" },
    });
    return frame.lines.map((line) => line.spans.map((part) => part.text).join("")).join("\n");
  };
  for (const [width, height] of [[80, 24], [50, 16], [40, 8]] as const) {
    const text = render(width, height);
    assert.match(text, /Commands/);
    // The selected row is always on screen and always legible, at every
    // supported size — a group whose label is 17 columns wide included.
    assert.match(text, /Approvals & Costs/);
    assert.match(text, /System/);
  }
  assert.match(render(80, 24), /6 of 6/);
  // FIX-15 paid a cost knowingly here and FIX-14 ticket 19 repays it. The
  // root list's name column is padded to its widest visible label, and
  // Settings' own "Approvals & Costs" is 17 columns where the old
  // "Accounts" was 8; `composeLine`'s iron rule is "never shorten, leave
  // out" (ui/compose.ts, R3), so below roughly 60 columns the right-aligned
  // "n of total" corner — the lower-priority segment — was what got left
  // out. That corner is the OVERFLOW DISCLOSURE (FIX-5 ruling 1): the one
  // thing on the row that says other rows exist off screen, which is
  // exactly what a 16- or 8-row-tall frame guarantees. Losing a row's
  // description at 40 columns costs detail; losing the corner cost the fact
  // that there is more.
  //
  // `buildListLines` supplies the row a `compact` form (marker + name, plus
  // `current`/`disabledReason` — the two suffixes that carry meaning rather
  // than detail), and `composeLine` tries compact BEFORE it drops anything.
  // So both survive at every supported size now. This pin is the inverse of
  // the one it replaces.
  for (const [width, height] of [[50, 16], [40, 8]] as const) {
    assert.match(render(width, height), /of 6/, `${width}x${height}`);
  }
  // Never at the price of overflowing the frame: every rendered line stays
  // inside its own width.
  for (const [width, height] of [[80, 24], [50, 16], [40, 8]] as const) {
    for (const line of render(width, height).split("\n")) {
      assert.ok(
        displayWidth(line) <= width,
        `${width}x${height}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("a query searches globally — ignoring the browsed path — and projects current and disabled runtime state", () => {
  // Being drilled into "Models" must not scope the search to that group's
  // own children: this is the one global finder, not a level-local filter.
  const projection = projectCommandMenu(
    { path: ["Models"], query: "th", selectedIndex: 0 },
    new Map([["think", { current: "high", disabledReason: "Only with main model" }]]),
  );

  assert.equal(projection.breadcrumb, "Commands");
  // "/settings" rides along on its FIX-15 `theme` alias — an alias is a
  // search key by design. `/think` still leads, and it is the row whose
  // runtime state this test is really about.
  assert.deepEqual(projection.entries.map((entry) => entry.name), ["/think", "/settings"]);
  assert.equal(projection.entries[0]?.current, "high");
  assert.equal(projection.entries[0]?.disabledReason, "Only with main model");
  assert.equal(projection.entries[1]?.current, undefined);
});

test("a query reaches every branch regardless of the currently browsed path", () => {
  // "/settings" lives under "System", not "Models" — proving the search
  // truly ignores `path` rather than coincidentally matching within it.
  const projection = projectCommandMenu({ path: ["Models"], query: "se", selectedIndex: 0 }, new Map());
  assert.deepEqual(projection.entries.map((entry) => entry.name), ["/settings"]);
});

test("the shared /co projection is the canonical four-row completion", () => {
  for (const query of ["co", "/co"]) {
    const rows = projectCommandMenu({ path: [], query, selectedIndex: 0 }, new Map()).entries;
    assert.deepEqual(
      rows.map((row) => row.name),
      ["/compress", "/context", "/cost", "/cross"],
      query,
    );
  }
});

test("provider setup search materializes one existing runnable match row", () => {
  const rows = resolveCommandMenuRows({ path: [], query: "provider setup", selectedIndex: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "match");
  if (rows[0]?.kind !== "match") return;
  assert.equal(rows[0].entry.name, "provider setup");
  assert.equal(rows[0].entry.usage, "/provider setup");
  assert.equal(rows[0].entry.acceptsArguments, false);
  assert.equal(commandMenuEnterVerb(rows[0]), "run");
});

test("an empty query at an empty path shows the browsable root, never a search", () => {
  const projection = projectCommandMenu({ path: [], query: "", selectedIndex: 0 }, new Map());
  assert.equal(projection.breadcrumb, "Commands");
  assert.deepEqual(projection.entries.map((entry) => entry.name), [
    "Models", "Chat", "Workspace", "Accounts", "Approvals & Costs", "System",
  ]);
});

test("a query with zero matches renders one recovery entry instead of a dead end", () => {
  const projection = projectCommandMenu({ path: [], query: "zzz-nichts", selectedIndex: 0 }, new Map());
  assert.equal(projection.entries.length, 1);
  assert.match(projection.entries[0]!.name, /Show all commands/);
  assert.match(projection.entries[0]!.description ?? "", /No matches/);
  assert.match(projection.entries[0]!.description ?? "", /zzz-nichts/);
});

test("group nodes never appear among search results, even nested several levels deep", () => {
  // "cross" is a branch token, not a command; only its six leaves are
  // executable and only they may appear as matches (Phase 10 added "off"
  // alongside run/models/swap/status/stop). FIX-15 dropped the `collab`
  // umbrella from the canonical names — it is a compatibility alias now,
  // so the rows are one token shorter but there are still exactly six.
  const projection = projectCommandMenu({ path: [], query: "cross", selectedIndex: 0 }, new Map());
  assert.deepEqual(projection.entries.map((entry) => entry.name), [
    "/cross run",
    "/cross models",
    "/cross swap",
    "/cross status",
    "/cross stop",
    "/cross off",
  ]);
});

// ---------------------------------------------------------------------------
// FIX-15 (command-IA, ratified): the `/budget` row annotated itself with
// `maxCost` — the value `/max-cost` owns, one row below it in the same
// group — so the palette confidently stated the wrong setting. A palette
// annotation is a claim about the current value; a wrong one is worse than
// none.
// ---------------------------------------------------------------------------

test("the /budget row's current value is the budget, and /max-cost's is the run limit", () => {
  const projection = projectCommandMenu(
    { path: [], query: "budget", selectedIndex: 0 },
    new Map([
      ["budget", { current: "Day $2.000 · Total $50.000" }],
      ["max-cost", { current: "$1.000" }],
    ]),
  );
  const budget = projection.entries.find((entry) => entry.name === "/budget");
  assert.equal(budget?.current, "Day $2.000 · Total $50.000");
  assert.notEqual(budget?.current, "$1.000", "this is /max-cost's value, not /budget's");

  const limits = projectCommandMenu(
    { path: [], query: "max-cost", selectedIndex: 0 },
    new Map([
      ["budget", { current: "Day $2.000 · Total $50.000" }],
      ["max-cost", { current: "$1.000" }],
    ]),
  );
  assert.equal(limits.entries.find((entry) => entry.name === "/max-cost")?.current, "$1.000");
});

test("budgetLimitsLabel spells money the way its own surface spells it", () => {
  // Fix round 1 (F6): `formatUsd` (3 decimals) and "Off" — the same spelling
  // the `/max-cost` palette row directly beneath this one uses, and the same
  // one Settings uses for these exact two numbers. It used to render
  // `$2.00`/"No limit" while its neighbours rendered `$2.000`/"Off": one
  // value, three spellings, in the row FIX-15 was written to correct.
  assert.equal(budgetLimitsLabel({ ...DEFAULT_BUDGET }), "Off");
  assert.equal(
    budgetLimitsLabel({ ...DEFAULT_BUDGET, dailyLimitUsd: 2 }),
    "Day $2.000",
  );
  assert.equal(
    budgetLimitsLabel({ ...DEFAULT_BUDGET, totalLimitUsd: 50 }),
    "Total $50.000",
  );
  assert.equal(
    budgetLimitsLabel({ ...DEFAULT_BUDGET, dailyLimitUsd: 2, totalLimitUsd: 50 }),
    "Day $2.000 · Total $50.000",
  );
  // The exact bytes Settings shows for the same two values.
  assert.equal(
    budgetLimitsLabel({ ...DEFAULT_BUDGET, dailyLimitUsd: 2, totalLimitUsd: 50 }),
    `Day ${formatUsd(2)} · Total ${formatUsd(50)}`,
  );
});
