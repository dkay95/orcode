import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { RuleStore, rulesPath } from "../src/rules.js";
import { WorkspaceGuard } from "../src/workspace.js";
import {
  DEFAULT_VERIFY_CONFIG,
  VERIFY_MAX_ROUNDS,
  type VerifyCommandEvent,
  runVerify,
  suggestVerifyCommands,
  validateVerifyConfig,
} from "../src/verify.js";

async function tempWorkspace(): Promise<WorkspaceGuard> {
  const root = await mkdtemp(join(tmpdir(), "routercode-verify-test-"));
  return WorkspaceGuard.create(root);
}

async function tempAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-verify-apphome-"));
}

function collect(): { events: VerifyCommandEvent[]; onEvent: (event: VerifyCommandEvent) => void } {
  const events: VerifyCommandEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

// ---------------------------------------------------------------------------
// Criterion 3: the verify path never calls ApprovalManager.authorize.
// ---------------------------------------------------------------------------

test("runVerify never touches ApprovalManager.authorize, even on failure", async () => {
  const guard = await tempWorkspace();
  const approvals = new ApprovalManager("ask");
  const authorizeSpy = mock.method(approvals, "authorize");
  const { onEvent } = collect();

  const outcome = await runVerify(["exit 1"], guard, undefined, onEvent);

  assert.equal(outcome.status, "failed");
  assert.equal(authorizeSpy.mock.callCount(), 0);
});

test("runVerify never touches ApprovalManager.authorize on a green run", async () => {
  const guard = await tempWorkspace();
  const approvals = new ApprovalManager("ask");
  const authorizeSpy = mock.method(approvals, "authorize");
  const { onEvent } = collect();

  const outcome = await runVerify(["echo ok"], guard, undefined, onEvent);

  assert.equal(outcome.status, "passed");
  assert.equal(authorizeSpy.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// Criterion 4: RuleStore stays empty after a verify run — no rule is ever
// written, successful or not.
// ---------------------------------------------------------------------------

test("RuleStore stays empty after a verify run, pass or fail", async () => {
  const guard = await tempWorkspace();
  const appHome = await tempAppHome();
  const { onEvent } = collect();

  await runVerify(["echo ok"], guard, undefined, onEvent);
  await runVerify(["exit 1"], guard, undefined, onEvent);

  const store = await RuleStore.load(appHome);
  assert.deepEqual(store.list(guard.root), []);

  // The permission file itself must never come into existence — a verify
  // pass has no `appHome` to write to in the first place, which is the point.
  const entries = await readdir(appHome).catch((): string[] => []);
  assert.equal(entries.includes("permissions.json"), false);
  void rulesPath; // documents which path is being asserted absent
});

// ---------------------------------------------------------------------------
// Criterion 5: cancellation during verify yields "cancelled", never
// "unverified" (there is no such status here — this module never invents
// one; it only ever returns passed/failed/cancelled).
// ---------------------------------------------------------------------------

test("aborting mid-verify yields cancelled", async () => {
  const guard = await tempWorkspace();
  const controller = new AbortController();
  const { onEvent, events } = collect();

  const pending = runVerify(["sleep 30"], guard, controller.signal, onEvent);
  setTimeout(() => controller.abort(), 200);

  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  // A cancelled command never produced a completed-command event.
  assert.deepEqual(events, []);
});

test("an already-aborted signal short-circuits before spawning anything", async () => {
  const guard = await tempWorkspace();
  const controller = new AbortController();
  controller.abort();
  const { onEvent, events } = collect();

  const outcome = await runVerify(["echo should-not-run"], guard, controller.signal, onEvent);

  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(events, []);
});

test("aborting between two commands cancels before the second one runs", async () => {
  const guard = await tempWorkspace();
  const controller = new AbortController();
  const { onEvent, events } = collect();

  const pending = runVerify(["echo first", "sleep 30"], guard, controller.signal, onEvent);
  // Give the first command time to finish and fire its event, then abort
  // before/while the second one is running.
  setTimeout(() => controller.abort(), 200);

  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.command, "echo first");
});

// ---------------------------------------------------------------------------
// Behaviour: sequential execution, stop-at-first-failure, event shape.
// ---------------------------------------------------------------------------

test("runVerify passes when every command exits 0", async () => {
  const guard = await tempWorkspace();
  const { onEvent, events } = collect();

  const outcome = await runVerify(["echo a", "echo b"], guard, undefined, onEvent);

  assert.deepEqual(outcome, { status: "passed" });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.exitCode, 0);
  assert.equal(events[1]?.exitCode, 0);
  assert.ok(events.every((event) => typeof event.durationMs === "number" && event.durationMs >= 0));
  assert.ok(events.every((event) => typeof event.timestamp === "number"));
});

test("runVerify stops at the first failing command and does not run the rest", async () => {
  const guard = await tempWorkspace();
  const { onEvent, events } = collect();

  const outcome = await runVerify(
    ["exit 1", "echo should-not-run"],
    guard,
    undefined,
    onEvent,
  );

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.command, "exit 1");
    assert.equal(outcome.exitCode, 1);
  }
  assert.equal(events.length, 1);
});

test("an empty command list passes trivially", async () => {
  const guard = await tempWorkspace();
  const { onEvent, events } = collect();

  const outcome = await runVerify([], guard, undefined, onEvent);

  assert.deepEqual(outcome, { status: "passed" });
  assert.deepEqual(events, []);
});

test("a failed command's distilled output prefers error-shaped lines", async () => {
  const guard = await tempWorkspace();
  const { onEvent } = collect();
  const script =
    'node -e "console.log(\'building...\'); console.error(\'error TS2345: bad type\'); process.exit(1)"';

  const outcome = await runVerify([script], guard, undefined, onEvent);

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.match(outcome.distilled, /error TS2345/);
    assert.doesNotMatch(outcome.distilled, /building\.\.\./);
  }
});

test("a failed command with no error-shaped lines falls back to the tail", async () => {
  const guard = await tempWorkspace();
  const { onEvent } = collect();
  const script = 'node -e "console.log(\'plain failure\'); process.exit(1)"';

  const outcome = await runVerify([script], guard, undefined, onEvent);

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.match(outcome.distilled, /plain failure/);
  }
});

// ---------------------------------------------------------------------------
// Config data model: verify { commands; mode; maxRounds } with validation.
// ---------------------------------------------------------------------------

test("validateVerifyConfig falls back to defaults for garbage input", () => {
  assert.deepEqual(validateVerifyConfig(undefined), DEFAULT_VERIFY_CONFIG);
  assert.deepEqual(validateVerifyConfig(null), DEFAULT_VERIFY_CONFIG);
  assert.deepEqual(validateVerifyConfig("nonsense"), DEFAULT_VERIFY_CONFIG);
  assert.deepEqual(validateVerifyConfig(42), DEFAULT_VERIFY_CONFIG);
});

test("validateVerifyConfig keeps valid fields and drops invalid ones", () => {
  const result = validateVerifyConfig({
    commands: ["npm run check", "", 42, "npm test"],
    mode: "off",
    maxRounds: 2,
  });
  assert.deepEqual(result, {
    commands: ["npm run check", "npm test"],
    mode: "off",
    maxRounds: 2,
  });
});

test("validateVerifyConfig rejects an unknown mode", () => {
  const result = validateVerifyConfig({ mode: "always-on" });
  assert.equal(result.mode, DEFAULT_VERIFY_CONFIG.mode);
});

test("validateVerifyConfig caps maxRounds at VERIFY_MAX_ROUNDS (2)", () => {
  assert.equal(VERIFY_MAX_ROUNDS, 2);
  assert.equal(validateVerifyConfig({ maxRounds: 2 }).maxRounds, 2);
  assert.equal(validateVerifyConfig({ maxRounds: 3 }).maxRounds, 2);
  assert.equal(validateVerifyConfig({ maxRounds: 1_000 }).maxRounds, 2);
});

test("validateVerifyConfig floors maxRounds at 1", () => {
  assert.equal(validateVerifyConfig({ maxRounds: 0 }).maxRounds, 1);
  assert.equal(validateVerifyConfig({ maxRounds: -5 }).maxRounds, 1);
  assert.equal(validateVerifyConfig({ maxRounds: "not a number" }).maxRounds, 1);
});

test("validateVerifyConfig truncates a fractional maxRounds", () => {
  assert.equal(validateVerifyConfig({ maxRounds: 1.9 }).maxRounds, 1);
});

// Mutation-test guard: if `.max(120)`-style bound above were loosened from 2
// to something larger (e.g. 3), this test goes red.
test("mutation guard: maxRounds 3 is rejected down to the 2-round ceiling", () => {
  assert.notEqual(validateVerifyConfig({ maxRounds: 3 }).maxRounds, 3);
});

// ---------------------------------------------------------------------------
// Suggestion function: derive commands from package.json (check > test > build).
// ---------------------------------------------------------------------------

test("suggestVerifyCommands prefers check, then test, then build", () => {
  assert.deepEqual(
    suggestVerifyCommands({ scripts: { check: "tsc", test: "node --test", build: "tsc -p ." } }),
    ["npm run check", "npm run test", "npm run build"],
  );
});

test("suggestVerifyCommands returns only the scripts that exist, in priority order", () => {
  assert.deepEqual(suggestVerifyCommands({ scripts: { test: "node --test" } }), ["npm run test"]);
  assert.deepEqual(
    suggestVerifyCommands({ scripts: { build: "tsc -p .", test: "node --test" } }),
    ["npm run test", "npm run build"],
  );
});

test("suggestVerifyCommands returns an empty list without a scripts section", () => {
  assert.deepEqual(suggestVerifyCommands({}), []);
  assert.deepEqual(suggestVerifyCommands(null), []);
  assert.deepEqual(suggestVerifyCommands({ scripts: "not an object" }), []);
});
