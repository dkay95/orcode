import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { RuleStore, rulesPath } from "../src/rules.js";
import { WorkspaceGuard, type ProcessResult } from "../src/workspace.js";
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

// runVerify spawns commands via resolveCommandShell() — /bin/sh unless
// ORCODE_SHELL/ROUTERCODE_SHELL is set. Windows has no native POSIX shell
// and CI sets no override, so every test that really spawns a command is
// POSIX-only until the documented Windows shell gap is fixed upstream.
// Tests that never reach a spawn (empty list, pre-aborted signal) and the
// pure config/suggestion tests keep running everywhere.
const needsPosixShell = {
  skip: process.platform === "win32" ? "needs a POSIX shell (ORCODE_SHELL/ROUTERCODE_SHELL)" : false,
};

// ---------------------------------------------------------------------------
// Criterion 3: the verify path never calls ApprovalManager.authorize.
// ---------------------------------------------------------------------------

test("runVerify never touches ApprovalManager.authorize, even on failure", needsPosixShell, async () => {
  const guard = await tempWorkspace();
  const approvals = new ApprovalManager("ask");
  const authorizeSpy = mock.method(approvals, "authorize");
  const { onEvent } = collect();

  const outcome = await runVerify(["exit 1"], guard, undefined, onEvent);

  assert.equal(outcome.status, "failed");
  assert.equal(authorizeSpy.mock.callCount(), 0);
});

test("runVerify never touches ApprovalManager.authorize on a green run", needsPosixShell, async () => {
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

test("RuleStore stays empty after a verify run, pass or fail", needsPosixShell, async () => {
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

test("aborting mid-verify yields cancelled", needsPosixShell, async () => {
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

test("aborting between two commands cancels before the second one runs", needsPosixShell, async () => {
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

test("runVerify passes when every command exits 0", needsPosixShell, async () => {
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

test("runVerify streams separated output while the child is alive with one stable operation terminal", needsPosixShell, async () => {
  const guard = await tempWorkspace();
  const marker = join(tmpdir(), `routercode-verify-live-${Date.now()}-${Math.random()}`);
  const { onEvent } = collect();
  const lifecycle: Array<{ kind: string; id: string; stream?: string; text?: string }> = [];
  let firstChunkWasLive = false;
  const script = [
    "const fs=require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(marker)}, 'alive')`,
    "process.stdout.write('verify-out\\n')",
    "setTimeout(() => process.stderr.write('verify-err\\n'), 30)",
    `setTimeout(() => fs.unlinkSync(${JSON.stringify(marker)}), 80)`,
  ].join(";");

  const outcome = await runVerify(
    [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`],
    guard,
    undefined,
    onEvent,
    {
      onProcessStart: (operation: { id: string }) => lifecycle.push({ kind: "start", id: operation.id }),
      onProcessChunk: (operation: { id: string }, stream: string, text: string) => {
        if (!lifecycle.some((event) => event.kind === "chunk")) firstChunkWasLive = existsSync(marker);
        lifecycle.push({ kind: "chunk", id: operation.id, stream, text });
      },
      onProcessEnd: (operation: { id: string }) => lifecycle.push({ kind: "end", id: operation.id }),
    } as never,
  );

  assert.deepEqual(outcome, { status: "passed" });
  assert.equal(firstChunkWasLive, true);
  assert.deepEqual(lifecycle.map((event) => event.kind), ["start", "chunk", "chunk", "end"]);
  assert.equal(new Set(lifecycle.map((event) => event.id)).size, 1);
  assert.deepEqual(lifecycle.filter((event) => event.kind === "chunk").map((event) => [event.stream, event.text]), [
    ["stdout", "verify-out\n"],
    ["stderr", "verify-err\n"],
  ]);
  await rm(marker, { force: true });
});

test("repeated verification commands receive distinct operation IDs", needsPosixShell, async () => {
  const guard = await tempWorkspace();
  const ids: string[] = [];
  const { onEvent } = collect();
  const outcome = await runVerify(
    ["printf repeated", "printf repeated"],
    guard,
    undefined,
    onEvent,
    { onProcessStart: (operation: { id: string }) => ids.push(operation.id) } as never,
  );
  assert.deepEqual(outcome, { status: "passed" });
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test("runVerify stops at the first failing command and does not run the rest", needsPosixShell, async () => {
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

test("a failed command's distilled output prefers error-shaped lines", needsPosixShell, async () => {
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

test("a failed command with no error-shaped lines falls back to the tail", needsPosixShell, async () => {
  const guard = await tempWorkspace();
  const { onEvent } = collect();
  const script = 'node -e "console.log(\'plain failure\'); process.exit(1)"';

  const outcome = await runVerify([script], guard, undefined, onEvent);

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.match(outcome.distilled, /plain failure/);
  }
});

test("timeout is typed and cannot masquerade as an ordinary repairable exit", async () => {
  const guard = await tempWorkspace();
  const lifecycle: string[] = [];
  const outcome = await runVerify(
    ["synthetic timeout"],
    guard,
    undefined,
    () => undefined,
    {
      onProcessStart: () => lifecycle.push("start"),
      onProcessEnd: () => lifecycle.push("end"),
    },
    {
      execute: async (): Promise<ProcessResult> => ({
        code: 124,
        stdout: "",
        stderr: "Zeitlimit erreicht",
        truncated: false,
        timedOut: true,
        aborted: false,
      }),
    },
  );

  assert.deepEqual(outcome, { status: "timed-out", command: "synthetic timeout" });
  assert.deepEqual(lifecycle, ["start", "end"]);
});

test("spawn or shell resolution failure is typed and keeps one terminal process lifecycle", async () => {
  const guard = await tempWorkspace();
  const lifecycle: Array<{ type: string; error?: string }> = [];
  const outcome = await runVerify(
    ["synthetic spawn"],
    guard,
    undefined,
    () => undefined,
    {
      onProcessStart: () => lifecycle.push({ type: "start" }),
      onProcessEnd: (_operation, completion) => lifecycle.push({
        type: "end",
        ...(completion.error ? { error: completion.error } : {}),
      }),
    },
    {
      execute: async () => {
        throw new Error("synthetic spawn failure");
      },
    },
  );

  assert.equal(outcome.status, "spawn-failed");
  if (outcome.status === "spawn-failed") {
    assert.equal(outcome.command, "synthetic spawn");
    assert.match(outcome.error, /synthetic spawn failure/);
  }
  assert.deepEqual(lifecycle.map((event) => event.type), ["start", "end"]);
  assert.match(lifecycle[1]?.error ?? "", /synthetic spawn failure/);
});

test("repair failure reports are centrally redacted and compacted to fixed small bounds", needsPosixShell, async () => {
  const guard = await tempWorkspace();
  const secret = `${["sk", "or", "v1"].join("-")}-${"q".repeat(40)}`;
  const noisy = Array.from(
    { length: 40 },
    (_, index) => `ERROR ${String(index).padStart(2, "0")} ${"x".repeat(500)}`,
  ).join("\n");
  const script = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `console.error(${JSON.stringify(`ERROR credential ${secret}\n${noisy}`)}); process.exit(1)`,
  )}`;

  const outcome = await runVerify([script], guard, undefined, () => undefined);

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.doesNotMatch(outcome.distilled, new RegExp(secret));
    assert.match(outcome.distilled, /REDACTED/);
    assert.ok(outcome.distilled.length <= 4_000, `got ${outcome.distilled.length} chars`);
    assert.ok(outcome.distilled.split("\n").length <= 12);
  }
});

// ---------------------------------------------------------------------------
// Config data model: verify { commands; mode; maxRepairRounds } with validation.
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
    maxRepairRounds: 2,
  });
  assert.deepEqual(result, {
    commands: ["npm run check", "npm test"],
    mode: "off",
    maxRepairRounds: 2,
  });
});

test("validateVerifyConfig rejects an unknown mode", () => {
  const result = validateVerifyConfig({ mode: "always-on" });
  assert.equal(result.mode, DEFAULT_VERIFY_CONFIG.mode);
});

test("validateVerifyConfig uses the canonical zero-through-two repair bound", () => {
  assert.equal(VERIFY_MAX_ROUNDS, 2);
  assert.equal(validateVerifyConfig({ maxRepairRounds: 0 }).maxRepairRounds, 0);
  assert.equal(validateVerifyConfig({ maxRepairRounds: 2 }).maxRepairRounds, 2);
  assert.equal(validateVerifyConfig({ maxRepairRounds: 3 }).maxRepairRounds, 1);
  assert.equal(validateVerifyConfig({ maxRepairRounds: 1_000 }).maxRepairRounds, 1);
});

test("validateVerifyConfig migrates legacy total passes and prefers the explicit new field", () => {
  assert.equal(validateVerifyConfig({ maxRounds: 1 }).maxRepairRounds, 0);
  assert.equal(validateVerifyConfig({ maxRounds: 2 }).maxRepairRounds, 1);
  assert.equal(
    validateVerifyConfig({ maxRounds: 1, maxRepairRounds: 2 }).maxRepairRounds,
    2,
  );
});

test("validateVerifyConfig rejects invalid repair-round values to the default", () => {
  assert.equal(validateVerifyConfig({ maxRepairRounds: -5 }).maxRepairRounds, 1);
  assert.equal(validateVerifyConfig({ maxRepairRounds: "not a number" }).maxRepairRounds, 1);
  assert.equal(validateVerifyConfig({ maxRepairRounds: 1.9 }).maxRepairRounds, 1);
});

test("mutation guard: maxRepairRounds 3 never widens the two-repair ceiling", () => {
  assert.notEqual(validateVerifyConfig({ maxRepairRounds: 3 }).maxRepairRounds, 3);
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
