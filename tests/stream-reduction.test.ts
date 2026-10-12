import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REASONING_MAX_LINES,
  RUNNING_TAIL_LINES,
  TAIL_CAPACITY,
  outputLines,
  selectTail,
  textLines,
} from "../src/utils.js";
import { composeCrossPanel, crossPanelFacts, crossPanelTitle } from "../src/cross-panel.js";
import { toolMetadata, TOOL_METADATA } from "../src/tool-metadata.js";
import { toolMetadata as viaWorkspace } from "../src/workspace.js";
import { selectTail as viaViewModel } from "../src/ui/view-model.js";
import {
  REASONING_MAX_LINES as viaBlocks,
  RUNNING_TAIL_LINES as runningViaBlocks,
  TAIL_CAPACITY as capacityViaBlocks,
} from "../src/ui/blocks.js";

test("the reduction rules have one definition, re-exported not re-written", () => {
  assert.equal(viaViewModel, selectTail);
  assert.equal(viaWorkspace, toolMetadata);
  assert.equal(viaBlocks, REASONING_MAX_LINES);
  assert.equal(runningViaBlocks, RUNNING_TAIL_LINES);
  assert.equal(capacityViaBlocks, TAIL_CAPACITY);
});

test("tool-metadata reaches nothing a WebView cannot have", async () => {
  // The `@core` seam admits a module whose runtime imports are import-free.
  // `types.js` is a TYPE import (erased), `utils.js` imports nothing at all.
  const source = await readFile(new URL("../src/tool-metadata.ts", import.meta.url), "utf8");
  const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from "([^"]+)";$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(runtimeImports, ["./utils.js"]);
  const utils = await readFile(new URL("../src/utils.ts", import.meta.url), "utf8");
  assert.equal(/^import /m.test(utils), false);
});

test("selectTail prefers the error on a failure and the tail otherwise", () => {
  const lines = ["start", "error TS2345: nope", "middle", "end"];
  assert.deepEqual(selectTail(lines, true, 2), ["error TS2345: nope"]);
  assert.deepEqual(selectTail(lines, false, 2), ["middle", "end"]);
  // No recognisable error: the FRONT, not the tail — a failure's first lines
  // are where the reason usually is.
  assert.deepEqual(selectTail(["a", "b", "c"], true, 2), ["a", "b"]);
});

test("outputLines reads the five keys, and only non-empty ones", () => {
  assert.deepEqual(outputLines({ stdout: "a\nb", stderr: "  ", content: "c" }), ["a", "b", "c"]);
  assert.deepEqual(outputLines({ diff: "d", matches: "m" }), ["d", "m"]);
  assert.deepEqual(outputLines({ somethingElse: "x" }), []);
  assert.deepEqual(outputLines("not an object"), []);
});

test("textLines drops blanks and trailing whitespace", () => {
  assert.deepEqual(textLines("a  \r\n\n b\n"), ["a", " b"]);
});

test("the tool table is the one table, keyed safely", () => {
  // FIX-14 ticket 17: a model can call a tool named `constructor`, and a
  // frozen literal would have handed back a FUNCTION.
  assert.equal(TOOL_METADATA["constructor"], undefined);
  assert.equal(toolMetadata("constructor").label, "CONSTRUCTOR");
  assert.equal(toolMetadata("run_command").label, "SHELL");
});

// ---------------------------------------------------------------------------
// G4 fix round 1 (B-6): the live Cross panel's COMPOSITION is one source too.
//
// Its content was already single-source (`dashboardState()`), but the shape —
// which facts, in which order, what dedups against what, and when the Control
// row exists at all — was written once in `dashboard-frame.ts` and once in
// `gui/src/views.ts`. Those are D2 rulings, so a second copy is a second place
// for the "Cross · Blocked · Blocked" twin to grow back.
// ---------------------------------------------------------------------------

test("the Cross panel's D2 rules are composed once, for both surfaces", async () => {
  const state = {
    phase: "Blocked",
    reason: "Verification failed",
    verification: "Not run",
    lead: "gpt-5",
    challenger: "claude-4",
    active: false,
    result: "Blocked",
  };
  // The dedup: `result` earns a segment only when it says what `phase` does not.
  assert.equal(crossPanelTitle(state, " · "), "Cross · Blocked");
  assert.equal(
    crossPanelTitle({ ...state, result: "Partial" }, " · "),
    "Cross · Blocked · Partial",
  );
  // The rows, in order, with the reason riding verification.
  assert.deepEqual(crossPanelFacts(state, " · "), [
    "Coding · gpt-5",
    "Review · claude-4",
    "Verification · Not run · Verification failed",
  ]);
  // Control exists only while the run does — it names commands that are only
  // reachable then.
  assert.ok(
    crossPanelFacts({ ...state, active: true }, " · ")
      .includes("Control · /cross status · /cross stop"),
  );
  // The separator is the only thing either surface may choose.
  assert.equal(crossPanelTitle(state, "|"), "Cross|Blocked");
  assert.deepEqual(composeCrossPanel(state), {
    phase: "Blocked",
    result: null,
    roles: [
      { kind: "coding", value: "gpt-5" },
      { kind: "review", value: "claude-4" },
    ],
    verification: { status: "Not run", reason: "Verification failed" },
    controlsVisible: false,
  });

  // Neither renderer keeps a copy of the composition. The terminal consumes
  // the two text projections; the richer window consumes the same structured
  // composition before arranging its route cards.
  const frame = await readFile(new URL("../src/ui/dashboard-frame.ts", import.meta.url), "utf8");
  const window = await readFile(new URL("../gui/src/views.ts", import.meta.url), "utf8");
  assert.match(frame, /crossPanelTitle\(/, "dashboard-frame.ts uses the shared text title");
  assert.match(frame, /crossPanelFacts\(/, "dashboard-frame.ts uses the shared text facts");
  assert.match(window, /composeCrossPanel\(/, "gui/src/views.ts uses the shared structured composition");
  for (const [name, source] of [["dashboard-frame.ts", frame], ["gui/src/views.ts", window]]) {
    assert.ok(
      !/`Coding\$\{/.test(source) && !source.includes("`Coding · "),
      `${name} must not re-compose a Cross panel row`,
    );
  }

  // And the module stays crossable: the WebView's `@core` seam only admits
  // modules nothing Node-shaped can follow.
  const shared = await readFile(new URL("../src/cross-panel.ts", import.meta.url), "utf8");
  assert.deepEqual(
    [...shared.matchAll(/^import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map((match) => match[1]),
    [],
    "cross-panel.ts must import nothing at runtime",
  );
});
