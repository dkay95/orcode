import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSlashCommand,
  type CommandContext,
  type CrossCommandPort,
} from "../src/commands.js";
import type { CrossRunResult, CrossRunSnapshot } from "../src/collaboration.js";

const SNAPSHOT = Object.freeze({ phase: "idle" }) as unknown as CrossRunSnapshot;
const RESULT = Object.freeze({ snapshot: SNAPSHOT }) as unknown as CrossRunResult;

function fixture(draft = "") {
  const calls: Array<{ method: string; value?: string }> = [];
  const cross: CrossCommandPort = {
    async openGate(value) { calls.push({ method: "openGate", value }); },
    async swapModels() { calls.push({ method: "swapModels" }); },
    async start(value) { calls.push({ method: "start", value }); return RESULT; },
    status() { calls.push({ method: "status" }); return SNAPSHOT; },
    async stop() { calls.push({ method: "stop" }); return SNAPSHOT; },
  };
  const output: string[] = [];
  const context = {
    cross,
    composerDraft: { read: () => draft },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;
  return { calls, context, output };
}

test("bare canonical and alias Cross commands open the same gate with the preserved draft", async () => {
  for (const command of ["/collab cross", "/cross"]) {
    const { calls, context } = fixture("draft byte-for-byte\n");
    assert.equal(await handleSlashCommand(command, context), "continue");
    assert.deepEqual(calls, [{ method: "openGate", value: "draft byte-for-byte\n" }]);
  }
});

test("Cross run pre-fills the gate with the supplied task instead of starting directly", async () => {
  for (const [command, task] of [
    ["/collab cross run prüfe exakt diese Aufgabe", "prüfe exakt diese Aufgabe"],
    ["/cross run prüfe exakt diese Aufgabe", "prüfe exakt diese Aufgabe"],
    ["/cross run \"prüfe exakt diese Aufgabe\"", "prüfe exakt diese Aufgabe"],
    ["/collab cross run", ""],
    ["/cross run", ""],
  ] as const) {
    const { calls, context } = fixture("must remain runtime-owned");
    await handleSlashCommand(command, context);
    assert.deepEqual(calls, [{ method: "openGate", value: task }]);
  }
});

test("Cross run decodes escaped matching quotes but preserves ordinary backslashes", async () => {
  for (const prefix of ["/collab cross", "/cross"]) {
    const { calls, context } = fixture();
    await handleSlashCommand(`${prefix} run "say \\"hello\\" exactly; keep C:\\temp\\file"`, context);
    assert.deepEqual(calls, [{
      method: "openGate",
      value: 'say "hello" exactly; keep C:\\temp\\file',
    }]);
  }
});

test("/collab cross models opens the same gate as bare /cross — no separate picker-only flow", async () => {
  for (const prefix of ["/collab cross", "/cross"]) {
    const { calls, context } = fixture("draft byte-for-byte\n");
    await handleSlashCommand(`${prefix} models`, context);
    assert.deepEqual(calls, [{ method: "openGate", value: "draft byte-for-byte\n" }]);
  }
});

test("every one of the four Cross start-reaching entry arms calls openGate and never start directly", async () => {
  // (a) every entry arm reaches the gate; none starts a run directly
  // (E-HONEST-02). The fourth arm — the plain-mode wiring itself — is
  // exercised end-to-end in tests/cross-gate.test.ts's real-runtime harness,
  // since it is a wiring concern rather than a distinct dispatch case here.
  for (const command of ["/cross", "/cross run a task", "/cross models"]) {
    const { calls, context } = fixture("draft");
    await handleSlashCommand(command, context);
    assert.ok(calls.length > 0, command);
    for (const call of calls) {
      assert.notEqual(call.method, "start", `${command} must never call start directly`);
    }
  }
});

test("every Cross control command dispatches one exact typed port method", async () => {
  for (const [command, method] of [
    ["swap", "swapModels"],
    ["status", "status"],
    ["stop", "stop"],
  ] as const) {
    for (const prefix of ["/collab cross", "/cross"]) {
      const { calls, context, output } = fixture();
      await handleSlashCommand(`${prefix} ${command}`, context);
      assert.deepEqual(calls, [{ method }]);
      assert.deepEqual(output, [], "commands must not invent placeholder output");
    }
  }
});

test("Cross controls reject every trailing token before calling the runtime port", async () => {
  for (const control of ["models", "swap", "status", "stop"]) {
    for (const prefix of ["/collab cross", "/cross"]) {
      const { calls, context, output } = fixture();
      await handleSlashCommand(`${prefix} ${control} typo`, context);
      assert.deepEqual(calls, []);
      assert.match(output.join("\n"), /Unknown command/u);
    }
  }
});

test("Cross commands fail explicitly when the runtime port is absent", async () => {
  const context = {
    out: { text() {}, error() {} },
  } as unknown as CommandContext;
  for (const command of [
    "/collab cross",
    "/cross run task",
    "/cross models",
    "/cross swap",
    "/cross status",
    "/cross stop",
  ]) {
    await assert.rejects(
      handleSlashCommand(command, context),
      /Cross.*not available/i,
    );
  }
});

test("unknown or branch-only collaboration input never falls back to the bare Cross handler", async () => {
  for (const command of ["/collab", "/collab cross nope", "/cross nope"]) {
    const { calls, context, output } = fixture("draft");
    await handleSlashCommand(command, context);
    assert.deepEqual(calls, []);
    assert.match(output.join("\n"), /Unknown command/u);
  }
});

test("an active Cross run permits status, stop, and every quit alias", async () => {
  const { calls, context, output } = fixture();
  context.crossRunActive = () => true;

  await handleSlashCommand("/cross models", context);
  await handleSlashCommand("/help", context);
  assert.deepEqual(calls, []);
  assert.match(output.join("\n"), /Cross.*running.*status.*stop.*quit/is);

  output.length = 0;
  await handleSlashCommand("/cross status", context);
  await handleSlashCommand("/cross stop", context);
  assert.deepEqual(calls, [{ method: "status" }, { method: "stop" }]);

  for (const command of ["/quit", "/exit", "/q"]) {
    assert.equal(await handleSlashCommand(command, context), "exit", command);
  }
});
