import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compressContext } from "../src/compressor.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SessionStore } from "../src/session.js";

test("compressor off performs no model call", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-compress-off-"));
  const session = await SessionStore.open(workspace, join(workspace, ".state"));
  let calls = 0;
  const client = {
    callModel: () => {
      calls += 1;
      throw new Error("should not be called");
    },
  };

  const result = await compressContext(
    client as never,
    { ...DEFAULT_CONFIG, compressionMode: "off" },
    session,
    "current task",
  );
  assert.equal(calls, 0);
  assert.equal(result.used, false);
  assert.match(result.handoff, /current task/);
});

test("compressor always creates and accounts for a handoff", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-compress-on-"));
  const session = await SessionStore.open(workspace, join(workspace, ".state"));
  for (let index = 0; index < 8; index += 1) {
    session.addTurn(index % 2 === 0 ? "user" : "assistant", `Turn ${index}`);
  }
  const client = {
    callModel: () => ({
      getText: async () => "Task: fix parser. Preserve tests.",
      getResponse: async () => ({ usage: { cost: 0.002 } }),
    }),
  };

  const result = await compressContext(
    client as never,
    { ...DEFAULT_CONFIG, compressionMode: "always" },
    session,
    "Continue",
  );
  assert.equal(result.used, true);
  assert.equal(result.costUsd, 0.002);
  assert.equal(session.data.summary, "Task: fix parser. Preserve tests.");
  assert.equal(session.data.costs.compressorUsd, 0.002);
  assert.equal(session.data.turns.length, 4);
});
