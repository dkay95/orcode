import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunId, runLogPath, runsDir, RunLog } from "../src/runlog.js";
import type { AgentRunEvent } from "../src/types.js";

async function appHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `routercode-runlog-${prefix}-`));
}

const SAMPLE_EVENTS: AgentRunEvent[] = [
  { type: "run-start", model: "anthropic/example", maxSteps: 10, timestamp: 1 },
  { type: "model-start", model: "anthropic/example", step: 1, timestamp: 2 },
  {
    type: "model-end",
    model: "anthropic/example",
    step: 1,
    durationMs: 500,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cachedTokens: 30,
    costUsd: 0.01,
    timestamp: 3,
  },
  { type: "reasoning", model: "anthropic/example", step: 1, delta: "denke nach", timestamp: 4 },
  {
    type: "tool-start",
    id: "t1",
    number: 1,
    name: "run_command",
    input: { command: "npm test" },
    timestamp: 5,
  },
  {
    type: "tool-end",
    id: "t1",
    number: 1,
    name: "run_command",
    input: { command: "npm test" },
    output: { exitCode: 0 },
    durationMs: 200,
    timestamp: 6,
  },
  {
    type: "tool-error",
    id: "t2",
    number: 2,
    name: "read_file",
    input: { path: "x.ts" },
    error: "ENOENT",
    durationMs: 10,
    timestamp: 7,
  },
  {
    type: "tool-output",
    id: "t1",
    number: 1,
    stream: "stdout",
    text: "ok\n",
    timestamp: 8,
  },
  {
    type: "verify",
    command: "npm test",
    round: 1,
    exitCode: 1,
    durationMs: 300,
    timestamp: 9,
  },
  {
    type: "notice",
    level: "warn",
    code: "cache-miss",
    message: "Kein Cache-Treffer",
    hint: "Präfix instabil",
    actions: [{ key: "r", label: "Wiederholen" }],
    timestamp: 10,
  },
  {
    type: "notice",
    level: "info",
    code: "info-only",
    message: "ohne Hinweis oder Aktionen",
    timestamp: 11,
  },
  { type: "run-end", outcome: "complete", durationMs: 1000, toolCount: 2, timestamp: 12 },
  { type: "run-end", outcome: "unverified", durationMs: 1000, toolCount: 2, timestamp: 13 },
  { type: "run-end", outcome: "step-limit", durationMs: 1000, toolCount: 2, timestamp: 14 },
  { type: "run-end", outcome: "cost-limit", durationMs: 1000, toolCount: 2, timestamp: 15 },
  { type: "run-end", outcome: "error", durationMs: 1000, toolCount: 2, timestamp: 16 },
  { type: "run-end", outcome: "cancelled", durationMs: 1000, toolCount: 2, timestamp: 17 },
];

test("every AgentRunEvent union member survives JSON round-trip losslessly", () => {
  for (const event of SAMPLE_EVENTS) {
    const roundTripped = JSON.parse(JSON.stringify(event));
    assert.deepEqual(roundTripped, event);
  }
});

test("RunLog write/close/read round-trips every sample event in order", async () => {
  const home = await appHome("roundtrip");
  const chatId = "chat-1";
  const runId = createRunId();

  const log = await RunLog.open(home, chatId, runId);
  for (const event of SAMPLE_EVENTS) {
    log.write(event);
  }
  await log.close();

  const read: AgentRunEvent[] = [];
  for await (const event of RunLog.read(home, chatId, runId)) {
    read.push(event);
  }
  assert.deepEqual(read, SAMPLE_EVENTS);
});

test("RunLog.open creates the chat directory with mode 0700 and the file with mode 0600", async () => {
  const home = await appHome("perms");
  const chatId = "chat-perm";
  const runId = createRunId();

  const log = await RunLog.open(home, chatId, runId);
  log.write(SAMPLE_EVENTS[0]!);
  await log.close();

  const dirStat = await stat(runsDir(home, chatId));
  const fileStat = await stat(runLogPath(home, chatId, runId));
  assert.equal(dirStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test("RunLog.prune with 60 files keeps exactly the 50 most recent", async () => {
  const home = await appHome("prune");
  const chatId = "chat-prune";

  const runIds: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const runId = `2026-01-01T00-00-${String(i).padStart(2, "0")}-000-${String(i).padStart(6, "0")}`;
    runIds.push(runId);
    const log = await RunLog.open(home, chatId, runId);
    log.write(SAMPLE_EVENTS[0]!);
    await log.close();
  }

  await RunLog.prune(home, chatId, 50);

  const remaining = (await readdir(runsDir(home, chatId))).sort();
  assert.equal(remaining.length, 50);
  const expectedKept = runIds
    .slice(10)
    .map((id) => `${id}.ndjson`)
    .sort();
  assert.deepEqual(remaining, expectedKept);
});

test("RunLog.prune on a chat with no runs directory does nothing", async () => {
  const home = await appHome("prune-empty");
  await assert.doesNotReject(RunLog.prune(home, "no-such-chat", 50));
});
