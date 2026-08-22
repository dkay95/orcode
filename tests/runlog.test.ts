import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRunId,
  runLogPath,
  runsDir,
  RunLog,
  type RunLogEnvelope,
} from "../src/runlog.js";
import { findInterruptedRun, summarizeRun } from "../src/resume.js";
import { redactRunEvent } from "../src/redaction.js";
import type { AgentRunEvent } from "../src/types.js";

async function appHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `routercode-runlog-${prefix}-`));
}

function syntheticCredential(): string {
  return `${["sk", "or", "v1"].join("-")}-${"z".repeat(40)}`;
}

function streamingCredentialFixtures(): Array<{ name: string; secret: string; sensitive: string }> {
  const awsSecret = "A".repeat(40);
  const bearer = `token9${"b".repeat(24)}`;
  const privateBody = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
  const privateLabel = ["PRIVATE", "KEY"].join(" ");
  return [
    { name: "openrouter", secret: `${["sk", "or", "v1"].join("-")}-${"o".repeat(24)}`, sensitive: "o".repeat(24) },
    { name: "anthropic", secret: `${["sk", "ant"].join("-")}-${"a".repeat(24)}`, sensitive: "a".repeat(24) },
    { name: "generic-sk", secret: `${["sk", "generic"].join("-")}-${"g".repeat(24)}`, sensitive: "g".repeat(24) },
    { name: "aws-access", secret: `${["AK", "IA"].join("")}${"C".repeat(16)}`, sensitive: "C".repeat(16) },
    { name: "aws-secret", secret: `aws_secret_access_key=${awsSecret}`, sensitive: awsSecret },
    { name: "github", secret: `${["gh", "p_"].join("")}${"H".repeat(24)}`, sensitive: "H".repeat(24) },
    { name: "gitlab", secret: `${["glpat", ""].join("-")}${"L".repeat(24)}`, sensitive: "L".repeat(24) },
    { name: "slack", secret: `${["xox", "b-"].join("")}${"1".repeat(16)}`, sensitive: "1".repeat(16) },
    { name: "google", secret: `${["AI", "za"].join("")}${"Q".repeat(35)}`, sensitive: "Q".repeat(35) },
    { name: "npm", secret: `${["npm", "_"].join("")}${"N".repeat(36)}`, sensitive: "N".repeat(36) },
    { name: "bearer", secret: `Bearer ${bearer}`, sensitive: bearer },
    { name: "jwt", secret: `eyJ${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}`, sensitive: `${"j".repeat(10)}.${"k".repeat(10)}.${"m".repeat(10)}` },
    {
      name: "private-key",
      secret: `-----BEGIN ${privateLabel}-----\n${privateBody}\n-----END ${privateLabel}-----`,
      sensitive: privateBody,
    },
  ];
}

const SAMPLE_EVENTS: AgentRunEvent[] = [
  {
    type: "run-start",
    model: "anthropic/example",
    maxSteps: 10,
    prompt: "Bitte die Tests reparieren",
    timestamp: 1,
  },
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
  { type: "text", delta: "Alles ", timestamp: 4.5 },
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
    type: "process-start",
    id: "process-1",
    name: "run_command",
    input: { command: "npm test" },
    toolId: "t1",
    toolNumber: 1,
    timestamp: 8.1,
  },
  {
    type: "process-output",
    id: "process-1",
    name: "run_command",
    stream: "stderr",
    text: "live error\n",
    toolId: "t1",
    toolNumber: 1,
    timestamp: 8.2,
  },
  {
    type: "process-end",
    id: "process-1",
    name: "run_command",
    input: { command: "npm test" },
    exitCode: 0,
    durationMs: 200,
    truncated: false,
    timedOut: false,
    aborted: false,
    toolId: "t1",
    toolNumber: 1,
    timestamp: 8.3,
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

test("new writes use a versioned envelope and redact a clone of the live event", async () => {
  const home = await appHome("envelope-redaction");
  const chatId = "chat-envelope";
  const runId = createRunId();
  const secret = syntheticCredential();
  const event: AgentRunEvent = {
    type: "tool-end",
    id: "t1",
    number: 1,
    name: "run_command",
    input: { command: `deploy ${secret}` },
    output: { stdout: secret, exitCode: 0 },
    durationMs: 17,
    timestamp: 23,
  };
  const liveBefore = structuredClone(event);

  const log = await RunLog.open(home, chatId, runId);
  log.write(event);
  await log.close();

  assert.deepEqual(event, liveBefore);
  const raw = await readFile(runLogPath(home, chatId, runId), "utf8");
  assert.doesNotMatch(raw, new RegExp(secret));
  const envelope = JSON.parse(raw) as RunLogEnvelope;
  assert.equal(envelope.version, 1);
  assert.equal(envelope.event.type, "tool-end");
  assert.equal(envelope.event.timestamp, 23);
  assert.equal(envelope.event.durationMs, 17);
});

test("appendRunEvent redacts a clone and writes the same versioned envelope", async () => {
  const home = await appHome("append-redaction");
  const chatId = "chat-append-redaction";
  const runId = createRunId();
  const seed = await RunLog.open(home, chatId, runId);
  await seed.close();
  const secret = syntheticCredential();
  const event: AgentRunEvent = {
    type: "notice",
    level: "error",
    code: "synthetic",
    message: `failed with ${secret}`,
    hint: secret,
    timestamp: 31,
  };
  const liveBefore = structuredClone(event);

  await RunLog.appendRunEvent(home, chatId, runId, event);

  assert.deepEqual(event, liveBefore);
  const raw = await readFile(runLogPath(home, chatId, runId), "utf8");
  assert.doesNotMatch(raw, new RegExp(secret));
  const envelope = JSON.parse(raw) as RunLogEnvelope;
  assert.equal(envelope.version, 1);
  assert.equal(envelope.event.type, "notice");
});

test("process output is redacted at RunLog persistence without mutating the volatile event", async () => {
  const home = await appHome("process-output-redaction");
  const secret = syntheticCredential();
  const event = {
    type: "process-output",
    id: "process-secret",
    name: "verify",
    stream: "stdout",
    text: `live ${secret}`,
    timestamp: 44,
  } as AgentRunEvent;
  const before = structuredClone(event);
  const log = await RunLog.open(home, "chat-process", "run-process");
  log.write(event);
  await log.close();

  assert.deepEqual(event, before);
  assert.doesNotMatch(await readFile(runLogPath(home, "chat-process", "run-process"), "utf8"), new RegExp(secret));
});

test("RunLog hides every registered credential family at every process chunk split and flushes benign suffixes", async () => {
  const home = await appHome("all-process-splits");
  const chatId = "chat-all-process-splits";
  const runId = createRunId();
  const log = await RunLog.open(home, chatId, runId);
  const fixtures = streamingCredentialFixtures();
  let timestamp = 1;

  for (const fixture of fixtures) {
    for (let split = 1; split < fixture.secret.length; split += 1) {
      const id = `${fixture.name}-${split}`;
      log.write({ type: "process-start", id, name: "verify", input: {}, timestamp: timestamp++ });
      log.write({ type: "process-output", id, name: "verify", stream: "stdout", text: fixture.secret.slice(0, split), timestamp: timestamp++ });
      log.write({ type: "process-output", id, name: "verify", stream: "stdout", text: `${fixture.secret.slice(split)}\n`, timestamp: timestamp++ });
      log.write({
        type: "process-end",
        id,
        name: "verify",
        input: {},
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        aborted: false,
        timestamp: timestamp++,
      });
    }
  }
  log.write({ type: "process-start", id: "benign-suffix", name: "verify", input: {}, timestamp: timestamp++ });
  log.write({ type: "process-output", id: "benign-suffix", name: "verify", stream: "stdout", text: "ordinary trailing s", timestamp: timestamp++ });
  log.write({
    type: "process-end",
    id: "benign-suffix",
    name: "verify",
    input: {},
    exitCode: 0,
    durationMs: 1,
    truncated: false,
    timedOut: false,
    aborted: false,
    timestamp: timestamp++,
  });
  await log.close();

  const outputById = new Map<string, string>();
  for await (const event of RunLog.read(home, chatId, runId)) {
    if (event.type === "process-output") {
      outputById.set(event.id, `${outputById.get(event.id) ?? ""}${event.text}`);
    }
  }
  for (const fixture of fixtures) {
    for (let split = 1; split < fixture.secret.length; split += 1) {
      assert.equal(
        outputById.get(`${fixture.name}-${split}`)?.includes(fixture.sensitive),
        false,
        `${fixture.name} leaked at split ${split}`,
      );
    }
  }
  assert.equal(outputById.get("benign-suffix"), "ordinary trailing s");
});

test("RunLog keeps later stderr behind an earlier ambiguous stdout prefix", async () => {
  const home = await appHome("cross-stream-order");
  const chatId = "chat-cross-stream-order";
  const runId = createRunId();
  const log = await RunLog.open(home, chatId, runId);
  const id = "cross-stream-order";
  log.write({ type: "process-start", id, name: "run_command", input: { command: "order" }, timestamp: 10 });
  log.write({ type: "process-output", id, name: "run_command", stream: "stdout", text: "eyJ", timestamp: 11 });
  log.write({ type: "process-output", id, name: "run_command", stream: "stderr", text: "ERR-LATER\n", timestamp: 12 });
  log.write({
    type: "process-end",
    id,
    name: "run_command",
    input: { command: "order" },
    exitCode: 1,
    durationMs: 3,
    truncated: false,
    timedOut: false,
    aborted: false,
    timestamp: 13,
  });
  await log.close();

  const output: Array<{ stream: "stdout" | "stderr"; text: string; timestamp: number }> = [];
  for await (const event of RunLog.read(home, chatId, runId)) {
    if (event.type === "process-output") {
      output.push({ stream: event.stream, text: event.text, timestamp: event.timestamp });
    }
  }
  assert.deepEqual(output, [
    { stream: "stdout", text: "eyJ", timestamp: 11 },
    { stream: "stderr", text: "ERR-LATER\n", timestamp: 12 },
  ]);
});

test("read accepts versioned and legacy events while isolating future versions", async () => {
  const home = await appHome("mixed-versions");
  const chatId = "chat-mixed";
  const runId = createRunId();
  const path = runLogPath(home, chatId, runId);
  const log = await RunLog.open(home, chatId, runId);
  await log.close();
  const legacy: AgentRunEvent = {
    type: "run-start",
    model: "legacy-model",
    maxSteps: 7,
    prompt: "legacy prompt",
    timestamp: 10,
  };
  const modern: AgentRunEvent = {
    type: "model-end",
    model: "modern-model",
    step: 2,
    durationMs: 80,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedTokens: 40,
    costUsd: 0.125,
    timestamp: 20,
  };
  const terminal: AgentRunEvent = {
    type: "run-end",
    outcome: "cost-limit",
    durationMs: 900,
    toolCount: 3,
    timestamp: 30,
  };
  const envelope: RunLogEnvelope = { version: 1, event: modern };
  await writeFile(
    path,
    [
      JSON.stringify(legacy),
      JSON.stringify(envelope),
      JSON.stringify({ version: 99, event: { type: "text", delta: "future", timestamp: 25 } }),
      JSON.stringify({ version: 1, event: terminal }),
      "",
    ].join("\n"),
  );

  const read: AgentRunEvent[] = [];
  await assert.doesNotReject(async () => {
    for await (const event of RunLog.read(home, chatId, runId)) {
      read.push(event);
    }
  });
  assert.deepEqual(read, [legacy, modern, terminal]);
});

test("resume reads a mixed legacy and envelope log without losing timing or cost", async () => {
  const home = await appHome("resume-mixed");
  const chatId = "chat-resume-mixed";
  const runId = "2026-08-22T10-00-00-000-resume";
  const path = runLogPath(home, chatId, runId);
  const log = await RunLog.open(home, chatId, runId);
  await log.close();
  const legacy: AgentRunEvent = {
    type: "run-start",
    model: "legacy-model",
    maxSteps: 5,
    prompt: "continue safely",
    timestamp: 100,
  };
  const modelEnd: AgentRunEvent = {
    type: "model-end",
    model: "legacy-model",
    step: 1,
    durationMs: 75,
    inputTokens: 12,
    outputTokens: 8,
    reasoningTokens: 2,
    cachedTokens: 4,
    costUsd: 0.25,
    timestamp: 200,
  };
  const partial: AgentRunEvent = {
    type: "text",
    delta: "partial answer",
    timestamp: 300,
  };
  await writeFile(
    path,
    [
      JSON.stringify(legacy),
      JSON.stringify({ version: 1, event: modelEnd } satisfies RunLogEnvelope),
      JSON.stringify({ version: 1, event: partial } satisfies RunLogEnvelope),
      "",
    ].join("\n"),
  );

  const interrupted = await findInterruptedRun(home, chatId);
  assert.ok(interrupted);
  assert.deepEqual(interrupted.events, [legacy, modelEnd, partial]);
  const summary = summarizeRun(interrupted.events);
  assert.equal(summary.startedAt, 100);
  assert.equal(summary.costUsd, 0.25);
  assert.equal(summary.partialAnswerText, "partial answer");
  assert.match(summary.brokeOffAt, /Formulieren/);
});

test("recognizable credential prefixes split across stream events cannot be reconstructed", async () => {
  const home = await appHome("split-stream");
  const chatId = "chat-split";
  const runId = createRunId();
  const prefix = `${["sk", "or", "v1"].join("-")}-`;
  const body = "q".repeat(40);
  const events: AgentRunEvent[] = [
    { type: "reasoning", model: "m", step: 1, delta: prefix, timestamp: 1 },
    { type: "text", delta: body, timestamp: 2 },
    {
      type: "tool-output",
      id: "t",
      number: 1,
      stream: "stdout",
      text: prefix,
      timestamp: 3,
    },
    { type: "text", delta: body, timestamp: 4 },
  ];
  const log = await RunLog.open(home, chatId, runId);
  for (const event of events) {
    log.write(event);
  }
  await log.close();

  const raw = await readFile(runLogPath(home, chatId, runId), "utf8");
  const persisted = raw
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as RunLogEnvelope).event);
  const persistedContent = persisted
    .map((event) =>
      event.type === "reasoning"
        ? event.delta
        : event.type === "text"
          ? event.delta
          : event.type === "tool-output"
            ? event.text
            : "",
    )
    .join("");
  assert.ok(!persistedContent.includes(`${prefix}${body}`));
  assert.deepEqual(
    persisted.map((event) => event.type),
    events.map((event) => event.type),
  );
  assert.deepEqual(
    persisted.map((event) => event.timestamp),
    events.map((event) => event.timestamp),
  );
});

test("generic sk credential prefixes split across deltas cannot be reconstructed", () => {
  const prefix = `${["sk", "proj"].join("-")}-`;
  const body = "g".repeat(32);
  const events: AgentRunEvent[] = [
    { type: "reasoning", model: "m", step: 1, delta: prefix, timestamp: 1 },
    { type: "text", delta: body, timestamp: 2 },
  ];
  const before = structuredClone(events);
  const persisted = events.map((event) => redactRunEvent(event));
  assert.deepEqual(events, before);
  const persistedContent = persisted
    .map((event) =>
      event.type === "reasoning"
        ? event.delta
        : event.type === "text"
          ? event.delta
          : "",
    )
    .join("");
  assert.ok(!persistedContent.includes(`${prefix}${body}`));
  assert.deepEqual(
    persisted.map((event) => event.type),
    events.map((event) => event.type),
  );
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
  // NTFS has no POSIX mode bits — the modes are asserted on POSIX only.
  if (process.platform !== "win32") {
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  }
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

test("RunLog retention clamps age and per-chat configuration downward while excluding an active run", async () => {
  const home = await appHome("retention-ceilings");
  const chatId = "chat-retention";
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const activeRunId = "2026-06-01T00-00-00-000-active";
  const staleRunId = "2026-07-01T00-00-00-000-stale";

  for (const [runId, terminal] of [[activeRunId, false], [staleRunId, true]] as const) {
    const log = await RunLog.open(home, chatId, runId);
    log.write({ type: "run-start", model: "vendor/model", maxSteps: 1, prompt: runId, timestamp: now });
    if (terminal) {
      log.write({ type: "run-end", outcome: "complete", durationMs: 1, toolCount: 0, timestamp: now + 1 });
    }
    await log.close();
    await utimes(runLogPath(home, chatId, runId), new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
  }

  for (let index = 0; index < 101; index += 1) {
    const runId = `2026-08-01T00-00-${String(index).padStart(3, "0")}-000-terminal`;
    const log = await RunLog.open(home, chatId, runId);
    log.write({ type: "run-end", outcome: "complete", durationMs: 1, toolCount: 0, timestamp: now + index });
    await log.close();
    await utimes(runLogPath(home, chatId, runId), new Date(now - (101 - index) * 1_000), new Date(now - (101 - index) * 1_000));
  }

  await RunLog.prune(home, {
    now,
    maxAgeDays: 365,
    maxRunsPerChat: 1_000,
    maxBytesGlobal: Number.MAX_SAFE_INTEGER,
  });

  const remaining = await readdir(runsDir(home, chatId));
  assert.ok(remaining.includes(`${activeRunId}.ndjson`), "active run must survive age and count pruning");
  assert.ok(!remaining.includes(`${staleRunId}.ndjson`), "age cannot be configured above 30 days");
  assert.equal(
    remaining.filter((name) => name.endsWith("-terminal.ndjson")).length,
    100,
    "per-chat retention cannot be configured above 100 terminal runs",
  );
});

test("RunLog retention enforces a downward global byte limit oldest first across chats", async () => {
  const home = await appHome("retention-global");
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const paths: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const chatId = `chat-global-${index}`;
    const runId = `2026-08-22T00-00-0${index}-000-run`;
    const log = await RunLog.open(home, chatId, runId);
    log.write({
      type: "notice",
      level: "info",
      code: "payload",
      message: `${index}-${"x".repeat(900)}`,
      timestamp: now + index,
    });
    log.write({ type: "run-end", outcome: "complete", durationMs: 1, toolCount: 0, timestamp: now + index + 1 });
    await log.close();
    const path = runLogPath(home, chatId, runId);
    paths.push(path);
    await utimes(path, new Date(now - (3 - index) * 1_000), new Date(now - (3 - index) * 1_000));
  }

  const sizes = await Promise.all(paths.map(async (path) => (await stat(path)).size));
  await RunLog.prune(home, {
    now,
    maxAgeDays: 30,
    maxRunsPerChat: 100,
    maxBytesGlobal: sizes[1]! + sizes[2]!,
  });

  await assert.rejects(readFile(paths[0]!, "utf8"), /ENOENT/);
  assert.match(await readFile(paths[1]!, "utf8"), /run-end/);
  assert.match(await readFile(paths[2]!, "utf8"), /run-end/);
});

// --- resilience: a crash can leave a half-written last line ---------------

test("RunLog.read skips a truncated (half-written) trailing line instead of throwing", async () => {
  const home = await appHome("half-written");
  const chatId = "chat-crash";
  const runId = createRunId();

  const log = await RunLog.open(home, chatId, runId);
  log.write(SAMPLE_EVENTS[0]!);
  log.write(SAMPLE_EVENTS[1]!);
  await log.close();
  // Simulate the process dying mid-`appendFile` of the next event: a
  // syntactically broken JSON fragment with no trailing newline.
  await appendFile(runLogPath(home, chatId, runId), '{"type":"model-end","step":1,"dur');

  const read: AgentRunEvent[] = [];
  await assert.doesNotReject(async () => {
    for await (const event of RunLog.read(home, chatId, runId)) {
      read.push(event);
    }
  });
  assert.deepEqual(read, [SAMPLE_EVENTS[0], SAMPLE_EVENTS[1]]);
});

test("RunLog.read skips a line that parses as JSON but is not a plausible event", async () => {
  const home = await appHome("garbage-json");
  const chatId = "chat-garbage";
  const runId = createRunId();

  const log = await RunLog.open(home, chatId, runId);
  log.write(SAMPLE_EVENTS[0]!);
  await log.close();
  await appendFile(
    runLogPath(home, chatId, runId),
    `${JSON.stringify({ not: "an event" })}\n${JSON.stringify(null)}\n${JSON.stringify(42)}\n`,
  );

  const read: AgentRunEvent[] = [];
  for await (const event of RunLog.read(home, chatId, runId)) {
    read.push(event);
  }
  assert.deepEqual(read, [SAMPLE_EVENTS[0]]);
});

test("RunLog.appendRunEvent appends to an already-closed log without a live RunLog instance", async () => {
  const home = await appHome("append");
  const chatId = "chat-append";
  const runId = createRunId();

  const log = await RunLog.open(home, chatId, runId);
  log.write(SAMPLE_EVENTS[0]!);
  await log.close();

  const runEnd: AgentRunEvent = {
    type: "run-end",
    outcome: "cancelled",
    durationMs: 0,
    toolCount: 0,
    timestamp: 99,
  };
  await RunLog.appendRunEvent(home, chatId, runId, runEnd);

  const read: AgentRunEvent[] = [];
  for await (const event of RunLog.read(home, chatId, runId)) {
    read.push(event);
  }
  assert.deepEqual(read, [SAMPLE_EVENTS[0], runEnd]);

  const raw = await readFile(runLogPath(home, chatId, runId), "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, 2);
});
