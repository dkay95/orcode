import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { OrcodeAgent } from "../src/agent.js";
import { ensureSecureDirectory } from "../src/config.js";
import {
  handleSlashCommand,
  type CommandContext,
  type CommandOutput,
} from "../src/commands.js";
import { DEFAULT_CONFIG, type OrcodeConfigWithBudget } from "../src/config.js";
import type { OpenRouterService } from "../src/openrouter.js";
import { createRunId, RunLog, runsDir } from "../src/runlog.js";
import { SessionStore } from "../src/session.js";
import type { AgentRunEvent } from "../src/types.js";
import { ChangeJournal, WorkspaceGuard, createCodingTools, type ChangeEntry } from "../src/workspace.js";
import {
  buildResumePrompt,
  checkRunFileDrift,
  findInterruptedRun,
  findLastCompletedRun,
  formatInterruptedRunNotice,
  formatUndoConfirmation,
  formatUndoOutcome,
  isFileWriteTool,
  markRunReviewed,
  markRunUndone,
  summarizeRun,
  undoInterruptedRun,
  type CompletedRun,
  type InterruptedRun,
  type RunSummary,
} from "../src/resume.js";

async function appHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `routercode-resume-${prefix}-`));
}

/** Writes a run log that never gets a `run-end` — exactly what a crash leaves behind. */
async function writeInterruptedRun(
  home: string,
  chatId: string,
  runId: string,
  events: AgentRunEvent[],
): Promise<void> {
  const log = await RunLog.open(home, chatId, runId);
  for (const event of events) {
    log.write(event);
  }
  await log.close();
}

async function writeCompletedRun(
  home: string,
  chatId: string,
  runId: string,
  events: AgentRunEvent[],
): Promise<void> {
  await writeInterruptedRun(home, chatId, runId, [
    ...events,
    { type: "run-end", outcome: "complete", durationMs: 10, toolCount: 0, timestamp: 9_999 },
  ]);
}

// ---------------------------------------------------------------------------
// findInterruptedRun
// ---------------------------------------------------------------------------

test("a run without run-end is reported as interrupted", async () => {
  const home = await appHome("detect-interrupted");
  const runId = createRunId();
  await writeInterruptedRun(home, "chat-1", runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Aufgabe X", timestamp: 1 },
  ]);

  const found = await findInterruptedRun(home, "chat-1");
  assert.ok(found);
  assert.equal(found.runId, runId);
  assert.equal(found.chatId, "chat-1");
  assert.equal(found.events.length, 1);
});

test("a run that ended normally is not reported", async () => {
  const home = await appHome("detect-complete");
  const runId = createRunId();
  await writeCompletedRun(home, "chat-1", runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Aufgabe X", timestamp: 1 },
  ]);

  assert.equal(await findInterruptedRun(home, "chat-1"), null);
});

test("only the newest run counts: a completed run supersedes an older interrupted one", async () => {
  const home = await appHome("newest-completed");
  const older = createRunId();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = createRunId();

  await writeInterruptedRun(home, "chat-1", older, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  await writeCompletedRun(home, "chat-1", newer, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 2 },
  ]);

  assert.equal(await findInterruptedRun(home, "chat-1"), null);
});

test("only the newest run counts: a newer interrupted run is reported even if an older one completed fine", async () => {
  const home = await appHome("newest-interrupted");
  const older = createRunId();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = createRunId();

  await writeCompletedRun(home, "chat-1", older, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  await writeInterruptedRun(home, "chat-1", newer, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 2 },
  ]);

  const found = await findInterruptedRun(home, "chat-1");
  assert.ok(found);
  assert.equal(found.runId, newer);
});

test("no runs directory at all yields null, not a throw", async () => {
  const home = await appHome("no-runs-dir");
  assert.equal(await findInterruptedRun(home, "never-ran"), null);
});

test("a half-written trailing line does not crash detection and the run still counts as interrupted", async () => {
  const home = await appHome("half-written-detect");
  const runId = createRunId();
  const log = await RunLog.open(home, "chat-1", runId);
  log.write({ type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Kaputte Zeile am Ende", timestamp: 1 });
  log.write({ type: "model-start", model: "vendor/model", step: 1, timestamp: 2 });
  await log.close();
  // The process died mid-write of the next line: no trailing newline, not
  // valid JSON.
  await writeFile(join(runsDir(home, "chat-1"), `${runId}.ndjson`), '{"type":"tool-start","id":"t1","n', {
    flag: "a",
  });

  const found = await findInterruptedRun(home, "chat-1");
  assert.ok(found);
  assert.equal(found.events.length, 2);
  assert.equal(found.events[0]?.type, "run-start");
  assert.equal(found.events[1]?.type, "model-start");
});

// ---------------------------------------------------------------------------
// summarizeRun (pure)
// ---------------------------------------------------------------------------

function realisticInterruptedEvents(): AgentRunEvent[] {
  return [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Räum die Testdatei auf", timestamp: 1_000 },
    { type: "model-start", model: "vendor/model", step: 1, timestamp: 1_010 },
    {
      type: "model-end",
      model: "vendor/model",
      step: 1,
      durationMs: 500,
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0.002,
      timestamp: 1_020,
    },
    {
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "read_file",
      input: { path: "a.ts" },
      timestamp: 1_030,
    },
    {
      type: "tool-end",
      id: "t1",
      number: 1,
      name: "read_file",
      input: { path: "a.ts" },
      output: { path: "a.ts", content: "…", totalLines: 10, truncated: false, sha256: "x" },
      durationMs: 20,
      timestamp: 1_040,
    },
    {
      type: "tool-start",
      id: "t2",
      number: 2,
      name: "write_file",
      input: { path: "a.ts", content: "neuer inhalt" },
      timestamp: 1_050,
    },
    {
      type: "tool-end",
      id: "t2",
      number: 2,
      name: "write_file",
      input: { path: "a.ts", content: "neuer inhalt" },
      output: { ok: true, path: "a.ts", bytes: 12 },
      durationMs: 15,
      timestamp: 1_060,
    },
    {
      type: "tool-start",
      id: "t3",
      number: 3,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: 1_070,
    },
    {
      type: "tool-error",
      id: "t3",
      number: 3,
      name: "run_command",
      input: { command: "npm test" },
      error: "ENOENT: npm nicht gefunden",
      durationMs: 5,
      timestamp: 1_080,
    },
    { type: "model-start", model: "vendor/model", step: 2, timestamp: 1_090 },
    {
      type: "model-end",
      model: "vendor/model",
      step: 2,
      durationMs: 300,
      inputTokens: 120,
      outputTokens: 20,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0.001,
      timestamp: 1_100,
    },
    { type: "text", delta: "Ich habe ", timestamp: 1_110 },
    { type: "text", delta: "a.ts aufgeräumt", timestamp: 1_120 },
    {
      type: "tool-start",
      id: "t4",
      number: 4,
      name: "replace_text",
      input: { path: "b.ts", oldText: "x", newText: "y" },
      timestamp: 1_130,
    },
    // Cuts off here — t4 never gets a tool-end/tool-error.
  ];
}

test("summarizeRun extracts prompt, tool outcomes, changed files, cost, partial answer, and break-off point from a realistic sequence", () => {
  const summary = summarizeRun(realisticInterruptedEvents());

  assert.equal(summary.prompt, "Räum die Testdatei auf");
  assert.equal(summary.model, "vendor/model");
  assert.equal(summary.maxSteps, 40);
  assert.equal(summary.startedAt, 1_000);

  assert.equal(summary.tools.length, 4);
  const byName = Object.fromEntries(summary.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.read_file?.outcome, "ok");
  assert.equal(byName.write_file?.outcome, "ok");
  assert.equal(byName.run_command?.outcome, "error");
  assert.match(byName.run_command?.result ?? "", /npm nicht gefunden/);
  assert.equal(byName.replace_text?.outcome, "running");

  assert.deepEqual(summary.filesChanged, ["a.ts"]);
  assert.ok(Math.abs(summary.costUsd - 0.003) < 1e-9);

  assert.equal(summary.answerCharsSoFar, "Ich habe a.ts aufgeräumt".length);
  assert.equal(summary.partialAnswerText, "Ich habe a.ts aufgeräumt");

  assert.match(summary.brokeOffAt, /replace_text/);
  assert.match(summary.brokeOffAt, /#4/);
});

test("summarizeRun on an empty event list is total, not a throw, and everything is empty/null", () => {
  const summary = summarizeRun([]);
  assert.equal(summary.model, null);
  assert.equal(summary.prompt, null);
  assert.equal(summary.startedAt, null);
  assert.deepEqual(summary.tools, []);
  assert.deepEqual(summary.filesChanged, []);
  assert.equal(summary.costUsd, 0);
  assert.equal(summary.answerCharsSoFar, 0);
  assert.equal(summary.partialAnswerText, "");
  assert.match(summary.brokeOffAt, /before the first/);
});

test("summarizeRun accounts for a crash right after a delivered interjection (Phase 3b, Part B replay)", () => {
  const summary = summarizeRun([
    { type: "run-start", model: "vendor/model", maxSteps: 10, timestamp: 1_000 },
    { type: "model-start", model: "vendor/model", step: 1, timestamp: 1_010 },
    {
      type: "interjection",
      text: "Bitte auch die Linter-Warnungen beheben",
      timestamp: 1_020,
    },
    // Cuts off right here — the crash this run-log reconstructs.
  ]);
  assert.match(summary.brokeOffAt, /interjection/);
  assert.match(summary.brokeOffAt, /Linter-Warnungen/);
});

// ---------------------------------------------------------------------------
// buildResumePrompt — never invents what summarizeRun did not find
// ---------------------------------------------------------------------------

test("buildResumePrompt includes every fact the summary actually has", () => {
  const summary = summarizeRun(realisticInterruptedEvents());
  const text = buildResumePrompt(summary);

  assert.match(text, /NEW run/);
  assert.match(text, /Räum die Testdatei auf/);
  assert.match(text, /vendor\/model/);
  assert.match(text, /a\.ts/);
  assert.match(text, /read_file/);
  assert.match(text, /run_command/);
  assert.match(text, /failed/);
  assert.match(text, /Ich habe a\.ts aufgeräumt/);
  assert.match(text, /\$0\.003/);
});

test("buildResumePrompt omits sections the summary has no data for, never fabricating them", () => {
  const summary: RunSummary = {
    model: null,
    maxSteps: null,
    startedAt: null,
    prompt: null,
    tools: [],
    filesChanged: [],
    costUsd: 0,
    costKnowledge: "known",
    answerCharsSoFar: 0,
    partialAnswerText: "",
    brokeOffAt: "before the first recorded event",
  };
  const text = buildResumePrompt(summary);
  assert.doesNotMatch(text, /Original task/);
  assert.doesNotMatch(text, /Model of the interrupted run/);
  assert.doesNotMatch(text, /Tool calls already made/);
  assert.doesNotMatch(text, /files already changed/i);
  assert.doesNotMatch(text, /Cost/);
  assert.doesNotMatch(text, /Incomplete response/);
  assert.match(text, /before the first recorded event/);
});

// ---------------------------------------------------------------------------
// formatInterruptedRunNotice — the short startup banner
// ---------------------------------------------------------------------------

test("formatInterruptedRunNotice reports time, task, file count, and cost, and flags drifted files", () => {
  const summary = summarizeRun(realisticInterruptedEvents());
  const notice = formatInterruptedRunNotice(summary, [
    { path: "/abs/a.ts", status: "modified-since" },
  ]);
  assert.match(notice, /did not end cleanly/);
  assert.match(notice, /Räum die Testdatei auf/);
  assert.match(notice, /Files changed: 1/);
  assert.match(notice, /\$0\.003/);
  assert.match(notice, /changed externally/);
  assert.match(notice, /a\.ts/);
});

test("resume summaries preserve unknown provider-managed cost without rendering it as free", () => {
  const summary = summarizeRun([
    { type: "run-start", model: "k3", maxSteps: 40, prompt: "Weiter", timestamp: 1 },
    {
      type: "model-end",
      model: "k3",
      step: 1,
      durationMs: 10,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cachedTokens: 0,
      costUsd: 0,
      costKnowledge: "unknown",
      timestamp: 2,
    },
  ]);
  assert.equal(summary.costKnowledge, "unknown");
  assert.equal(summary.costUsd, 0);
  for (const text of [buildResumePrompt(summary), formatInterruptedRunNotice(summary, [])]) {
    assert.match(text, /provider-managed|unknown/i);
    assert.doesNotMatch(text, /free|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
  }
});

test("a Kimi run interrupted before its first model-end remains unknown from run-start alone", () => {
  const summary = summarizeRun([
    {
      type: "run-start",
      model: "k3",
      maxSteps: 40,
      prompt: "Weiter",
      costKnowledge: "unknown",
      timestamp: 1,
    },
  ]);
  assert.equal(summary.costKnowledge, "unknown");
  for (const text of [buildResumePrompt(summary), formatInterruptedRunNotice(summary, [])]) {
    assert.match(text, /provider-managed|unknown/i);
    assert.doesNotMatch(text, /free|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
  }
});

// ---------------------------------------------------------------------------
// checkRunFileDrift — did the run's own files stay as it left them?
// ---------------------------------------------------------------------------

interface Sandbox {
  root: string;
  journal: ChangeJournal;
  guard: WorkspaceGuard;
  approvals: ApprovalManager;
}

async function sandbox(home: string, chatId: string, prefix: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `routercode-resume-ws-${prefix}-`));
  const guard = await WorkspaceGuard.create(root);
  const approvals = new ApprovalManager("allow-all");
  const journal = new ChangeJournal({ appHome: home, chatId });
  return { root, journal, guard, approvals };
}

test("checkRunFileDrift reports 'matches' for a file untouched since the run", async () => {
  const home = await appHome("drift-matches");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "matches");
  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "kept.txt", content: "vom lauf geschrieben\n" } as never,
    {} as never,
  );

  const drift = await checkRunFileDrift(home, chatId, runId);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.status, "matches");
  assert.match(drift[0]?.path ?? "", /kept\.txt$/);
});

test("checkRunFileDrift reports 'modified-since' once the user has edited the file afterwards", async () => {
  const home = await appHome("drift-modified");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "modified");
  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "changed.txt", content: "vom lauf geschrieben\n" } as never,
    {} as never,
  );

  await writeFile(join(box.root, "changed.txt"), "vom nutzer überschrieben\n", "utf8");

  const drift = await checkRunFileDrift(home, chatId, runId);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.status, "modified-since");
});

test("checkRunFileDrift reports 'missing' once the file was deleted since the run, and is empty for a run without a checkpoint", async () => {
  const home = await appHome("drift-missing");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "missing");
  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "gone.txt", content: "wird gelöscht\n" } as never,
    {} as never,
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(join(box.root, "gone.txt"));

  const drift = await checkRunFileDrift(home, chatId, runId);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.status, "missing");

  assert.deepEqual(await checkRunFileDrift(home, chatId, "no-such-run"), []);
});

// ---------------------------------------------------------------------------
// undoInterruptedRun — reuses ChangeJournal.undoLastRun, no second path
// ---------------------------------------------------------------------------

test("undoInterruptedRun restores an interrupted run's files from a freshly constructed journal (a new process)", async () => {
  const home = await appHome("undo");
  const chatId = "chat-1";
  const runId = createRunId();
  const producing = await sandbox(home, chatId, "undo-produce");
  await writeFile(join(producing.root, "one.txt"), "original\n", "utf8");
  const tools = createCodingTools(producing.guard, producing.approvals, producing.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "one.txt", content: "vom abgebrochenen lauf geändert\n" } as never,
    {} as never,
  );
  await writeFileTool.function.execute(
    { path: "two.txt", content: "vom abgebrochenen lauf neu angelegt\n" } as never,
    {} as never,
  );

  // Simulate a fresh process: a brand new, empty ChangeJournal over the same
  // appHome/chatId — nothing in memory, only what is on disk.
  const freshJournal = new ChangeJournal({ appHome: home, chatId });
  assert.equal(freshJournal.size, 0);

  const run: InterruptedRun = {
    chatId,
    runId,
    path: "",
    events: [],
    fileDrift: [],
  };
  const outcome = await undoInterruptedRun(freshJournal, producing.guard, producing.approvals, run);

  assert.equal(outcome.skipped.length, 0);
  assert.equal(outcome.restored.length, 2);
  assert.equal(await readFile(join(producing.root, "one.txt"), "utf8"), "original\n");
  assert.equal(existsSync(join(producing.root, "two.txt")), false);
  assert.match(formatUndoOutcome(outcome), /2 files restored/);
});

test("undoInterruptedRun on a run with no checkpoint restores nothing and reports that honestly", async () => {
  const home = await appHome("undo-none");
  const chatId = "chat-1";
  const box = await sandbox(home, chatId, "undo-none-ws");
  const freshJournal = new ChangeJournal({ appHome: home, chatId });

  const outcome = await undoInterruptedRun(freshJournal, box.guard, box.approvals, {
    runId: "never-recorded",
  });
  assert.deepEqual(outcome, { restored: [], skipped: [] });
  assert.match(formatUndoOutcome(outcome), /No file change/);
});

// ---------------------------------------------------------------------------
// markRunReviewed — the only way an interrupted run stops being reported
// ---------------------------------------------------------------------------

test("markRunReviewed makes findInterruptedRun stop reporting the run", async () => {
  const home = await appHome("mark-reviewed");
  const chatId = "chat-1";
  const runId = createRunId();
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  const before = await findInterruptedRun(home, chatId);
  assert.ok(before);

  await markRunReviewed(home, chatId, before);

  assert.equal(await findInterruptedRun(home, chatId), null);
});

// ---------------------------------------------------------------------------
// findLastCompletedRun — run discovery for the deliberate /undo path
// ---------------------------------------------------------------------------

test("findLastCompletedRun returns null when the chat never ran", async () => {
  const home = await appHome("last-completed-none");
  assert.equal(await findLastCompletedRun(home, "never-ran"), null);
});

test("findLastCompletedRun returns null while the newest run has not ended yet", async () => {
  const home = await appHome("last-completed-interrupted");
  const chatId = "chat-1";
  await writeInterruptedRun(home, chatId, createRunId(), [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  assert.equal(await findLastCompletedRun(home, chatId), null);
});

test("findLastCompletedRun finds the newest ended run, not yet undone", async () => {
  const home = await appHome("last-completed-found");
  const chatId = "chat-1";
  const older = createRunId();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = createRunId();
  await writeCompletedRun(home, chatId, older, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  await writeCompletedRun(home, chatId, newer, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 2 },
  ]);

  const found = await findLastCompletedRun(home, chatId);
  assert.ok(found);
  assert.equal(found.runId, newer);
  assert.equal(found.undone, false);
});

test("markRunUndone makes findLastCompletedRun report the run as already undone (one level only)", async () => {
  const home = await appHome("mark-undone");
  const chatId = "chat-1";
  const runId = createRunId();
  await writeCompletedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  const before = await findLastCompletedRun(home, chatId);
  assert.ok(before);
  assert.equal(before.undone, false);

  await markRunUndone(home, chatId, before);

  const after = await findLastCompletedRun(home, chatId);
  assert.ok(after);
  assert.equal(after.runId, runId);
  assert.equal(after.undone, true, "the same run must still be found, now flagged undone");
});

test("a run log written before run-undone existed is honestly 'not undone', never assumed otherwise (fail-closed)", async () => {
  const home = await appHome("legacy-run-log");
  const chatId = "chat-1";
  const runId = createRunId();
  // No run-undone event anywhere in this log — exactly what every run log
  // written before Phase 11 looks like.
  await writeCompletedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  const found = await findLastCompletedRun(home, chatId);
  assert.ok(found);
  assert.equal(found.undone, false);
});

// ---------------------------------------------------------------------------
// isFileWriteTool — the one predicate deciding what an undo can ever touch
// ---------------------------------------------------------------------------

test("isFileWriteTool recognizes exactly the two tools ChangeJournal ever records", () => {
  assert.equal(isFileWriteTool("write_file"), true);
  assert.equal(isFileWriteTool("replace_text"), true);
  assert.equal(isFileWriteTool("run_command"), false);
  assert.equal(isFileWriteTool("read_file"), false);
  assert.equal(isFileWriteTool("ssh_command"), false);
});

// ---------------------------------------------------------------------------
// formatUndoConfirmation — the exact /undo confirmation copy (ruling 2):
// diff summary, then honest disclosure, then the one consequence sentence.
// ---------------------------------------------------------------------------

function toolCall(name: string): { name: string; input: string; outcome: "ok" } {
  return { name, input: "", outcome: "ok" };
}

test("formatUndoConfirmation shows the diff summary, the disclosure, and the consequence sentence, in that order", () => {
  const entries: ChangeEntry[] = [
    { path: "/ws/new.txt", before: null, after: "one\ntwo\n", createdAt: "2026-01-01T00:00:00.000Z", runId: "r1" },
    { path: "/ws/edited.txt", before: "a\nb\nc\n", after: "a\nx\nc\n", createdAt: "2026-01-01T00:00:00.000Z", runId: "r1" },
  ];
  const tools = [toolCall("read_file"), toolCall("write_file"), toolCall("run_command"), toolCall("replace_text")];

  const { title, details } = formatUndoConfirmation(entries, tools, (path) => path.replace("/ws/", ""));

  assert.equal(title, "Undo the last run?");
  const diffIndex = details.indexOf("2 files will be reverted:");
  const newFileIndex = details.indexOf("new.txt (new file, +2)");
  const editedIndex = details.indexOf("edited.txt (+1/-1)");
  const disclosureIndex = details.indexOf(
    "Not reverted: 2 command/tool executions from this run: read_file, run_command",
  );
  const consequenceIndex = details.indexOf("This cannot be undone.");

  assert.ok(diffIndex >= 0, "diff summary header missing");
  assert.ok(newFileIndex > diffIndex, "new-file diff line missing or out of order");
  assert.ok(editedIndex > diffIndex, "edited-file diff line missing or out of order");
  assert.ok(disclosureIndex > newFileIndex && disclosureIndex > editedIndex, "disclosure must follow the diff summary");
  assert.ok(consequenceIndex > disclosureIndex, "consequence sentence must come last");
  // write_file/replace_text are what this undo reverts — never named in the
  // "not reverted" disclosure.
  assert.doesNotMatch(details, /Not reverted:.*write_file/);
  assert.doesNotMatch(details, /Not reverted:.*replace_text/);
});

test("formatUndoConfirmation omits the not-reverted line entirely when every call was a file write", () => {
  const entries: ChangeEntry[] = [
    { path: "/ws/only.txt", before: "a\n", after: "b\n", createdAt: "2026-01-01T00:00:00.000Z", runId: "r1" },
  ];
  const { details } = formatUndoConfirmation(entries, [toolCall("write_file")], (path) => path);
  assert.doesNotMatch(details, /Not reverted:/);
  assert.match(details, /^1 file will be reverted:/);
});

// ---------------------------------------------------------------------------
// "ohne Zustimmung passiert nichts": mere detection is read-only
// ---------------------------------------------------------------------------

test("findInterruptedRun, summarizeRun, and checkRunFileDrift never modify anything on disk by themselves", async () => {
  const home = await appHome("read-only");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "read-only-ws");
  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "untouched.txt", content: "bleibt so\n" } as never,
    {} as never,
  );
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "nur ansehen", timestamp: 1 },
  ]);

  const before = await readFile(join(box.root, "untouched.txt"), "utf8");
  const rawLogBefore = await readFile(join(runsDir(home, chatId), `${runId}.ndjson`), "utf8");

  // Called repeatedly and in every combination — none of this is allowed to
  // change anything: no undo, no "reviewed" marker, no file edits.
  const first = await findInterruptedRun(home, chatId);
  assert.ok(first);
  summarizeRun(first.events);
  await checkRunFileDrift(home, chatId, runId);
  const second = await findInterruptedRun(home, chatId);

  assert.deepEqual(first, second);
  assert.equal(await readFile(join(box.root, "untouched.txt"), "utf8"), before);
  assert.equal(
    await readFile(join(runsDir(home, chatId), `${runId}.ndjson`), "utf8"),
    rawLogBefore,
  );
});

// ---------------------------------------------------------------------------
// /recover slash command (src/commands.ts) — the interactive shell around
// resume.ts, reachable at any point in the session, not only at startup.
// Reuses every helper above (`sandbox`, `writeInterruptedRun`,
// `createCodingTools`) exactly as the direct resume.ts tests do; only the
// entry point (`handleSlashCommand`) changes.
//
// FIX-2 (audit 2026-08-28): this command was called `/resume` until the
// rename; the assertions below are byte-identical to the ones that guarded
// `/resume`, only re-pointed at the new token. `/resume` itself now resolves
// to the chats picker (see tests/commands-catalog.test.ts).
// ---------------------------------------------------------------------------

function collectResumeOutput(): { out: CommandOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: {
      text(value: string): void {
        lines.push(value);
      },
      error(value: string, hint?: string): void {
        lines.push(hint ? `${value}\n${hint}` : value);
      },
    },
  };
}

/**
 * A `CommandContext` for `/recover` alone: real `session`/`agent.journal`/
 * `agent.guard`/`approvals` (everything `recoverCommand` actually touches),
 * everything else stubbed since `/recover` never reads it.
 */
function recoverCommandContext(options: {
  home: string;
  chatId: string;
  guard: WorkspaceGuard;
  journal?: ChangeJournal;
  approvals?: ApprovalManager;
}): { context: CommandContext; lines: string[] } {
  const { out, lines } = collectResumeOutput();
  const journal = options.journal ?? new ChangeJournal({ appHome: options.home, chatId: options.chatId });
  const approvals = options.approvals ?? new ApprovalManager("allow-all");
  const session = {
    appHome: options.home,
    data: { id: options.chatId },
  } as unknown as CommandContext["session"];
  const agent = { journal, guard: options.guard } as unknown as CommandContext["agent"];
  const context: CommandContext = {
    config: {} as CommandContext["config"],
    approvals,
    openRouter: {} as CommandContext["openRouter"],
    session,
    agent,
    workspace: options.guard.root,
    credentials: {} as CommandContext["credentials"],
    out,
    ruleStore: {} as CommandContext["ruleStore"],
  };
  return { context, lines };
}

test("/recover with nothing interrupted reports that plainly and changes nothing", async () => {
  const home = await appHome("cmd-none");
  const box = await sandbox(home, "chat-1", "cmd-none-ws");
  const { context, lines } = recoverCommandContext({ home, chatId: "chat-1", guard: box.guard });

  await handleSlashCommand("/recover", context);
  assert.ok(lines.some((line) => /No interrupted run found/.test(line)));
});

test("/recover with no argument shows the notice and all three possibilities, without acting", async () => {
  const home = await appHome("cmd-bare");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-bare-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Nur ansehen, bitte", timestamp: 1 },
  ]);
  const { context, lines } = recoverCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/recover", context);
  const joined = lines.join("\n");
  assert.match(joined, /did not end cleanly/);
  assert.match(joined, /Nur ansehen, bitte/);
  assert.match(joined, /continue/);
  assert.match(joined, /undo/);
  assert.match(joined, /discard/);
  // The hint names the command the user actually typed, never the old token.
  assert.match(joined, /\/recover continue/);
  assert.match(joined, /\/recover undo/);
  assert.match(joined, /\/recover discard/);
  assert.doesNotMatch(joined, /\/resume/);

  // A bare `/recover` is read-only: the run must still be reported next time.
  const still = await findInterruptedRun(home, chatId);
  assert.ok(still);
  assert.equal(still.runId, runId);
});

test("/recover discard marks the run reviewed and touches no files", async () => {
  const home = await appHome("cmd-discard");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-discard-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  const { context, lines } = recoverCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/recover discard", context);
  assert.ok(lines.some((line) => /Discarded/.test(line)));
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/recover continue seeds the resume prompt via seedNextMessage and marks the run reviewed", async () => {
  const home = await appHome("cmd-continue");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-continue-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Räum b.ts auf", timestamp: 1 },
  ]);
  const { context, lines } = recoverCommandContext({ home, chatId, guard: box.guard });
  const seeded: string[] = [];
  context.seedNextMessage = (text) => seeded.push(text);

  await handleSlashCommand("/recover continue", context);
  assert.equal(seeded.length, 1);
  assert.match(seeded[0]!, /NEW run/);
  assert.match(seeded[0]!, /Räum b\.ts auf/);
  assert.ok(lines.some((line) => /prepended to your next message/.test(line)));
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/recover continue prints the resume prompt directly when seedNextMessage is unset", async () => {
  const home = await appHome("cmd-continue-fallback");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-continue-fallback-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Räum b.ts auf", timestamp: 1 },
  ]);
  const { context, lines } = recoverCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/recover continue", context);
  assert.ok(lines.some((line) => /NEW run/.test(line) && /Räum b\.ts auf/.test(line)));
});

test("/recover undo restores the interrupted run's files and marks it reviewed — using undoInterruptedRun, no second path", async () => {
  const home = await appHome("cmd-undo");
  const chatId = "chat-1";
  const runId = createRunId();
  const producing = await sandbox(home, chatId, "cmd-undo-produce");
  await writeFile(join(producing.root, "one.txt"), "original\n", "utf8");
  const tools = createCodingTools(producing.guard, producing.approvals, producing.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "one.txt", content: "vom abgebrochenen lauf geändert\n" } as never,
    {} as never,
  );
  await writeFileTool.function.execute(
    { path: "two.txt", content: "vom abgebrochenen lauf neu angelegt\n" } as never,
    {} as never,
  );
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  // A brand new, empty journal — the precondition undoInterruptedRun documents
  // and recoverCommand's own guard enforces — reusing producing.guard so the
  // undo writes land in the same workspace the "crash" wrote to.
  const { context, lines } = recoverCommandContext({ home, chatId, guard: producing.guard });
  assert.equal(context.agent.journal.size, 0);

  await handleSlashCommand("/recover undo", context);
  assert.ok(lines.some((line) => /restored/.test(line)));
  assert.equal(await readFile(join(producing.root, "one.txt"), "utf8"), "original\n");
  assert.equal(existsSync(join(producing.root, "two.txt")), false);
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/recover undo refuses once this session's own journal already holds a change, and leaves everything untouched", async () => {
  const home = await appHome("cmd-undo-guard");
  const chatId = "chat-1";
  const crashRunId = createRunId();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const ownRunId = createRunId();

  // A stale crash from before this session started.
  const crashProducing = await sandbox(home, chatId, "cmd-undo-guard-crash");
  const crashTools = createCodingTools(
    crashProducing.guard,
    crashProducing.approvals,
    crashProducing.journal,
    { runId: crashRunId },
  );
  const crashWriteFile = crashTools.find((tool) => tool.function.name === "write_file")!;
  await crashWriteFile.function.execute(
    { path: "crashed.txt", content: "vom abgebrochenen lauf\n" } as never,
    {} as never,
  );
  await writeInterruptedRun(home, chatId, crashRunId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);

  // This session's own journal already has a real entry from a tool call it
  // made itself — the exact situation undoInterruptedRun's doc comment warns
  // about: hydrating on top of it would make undoLastRun's "last run" this
  // session's own, not the crash's.
  const box = await sandbox(home, chatId, "cmd-undo-guard-own");
  const ownJournal = new ChangeJournal({ appHome: home, chatId });
  const ownTools = createCodingTools(box.guard, box.approvals, ownJournal, { runId: ownRunId });
  const ownWriteFile = ownTools.find((tool) => tool.function.name === "write_file")!;
  await ownWriteFile.function.execute(
    { path: "own.txt", content: "von dieser sitzung selbst\n" } as never,
    {} as never,
  );
  assert.equal(ownJournal.size, 1);

  const { context } = recoverCommandContext({ home, chatId, guard: box.guard, journal: ownJournal });

  await assert.rejects(handleSlashCommand("/recover undo", context), /only safe/);

  // Nothing was touched: the own session's journal entry survives untouched,
  // and the crash is still reported as interrupted (not marked reviewed).
  assert.equal(ownJournal.size, 1);
  assert.equal(await readFile(join(box.root, "own.txt"), "utf8"), "von dieser sitzung selbst\n");
  const still = await findInterruptedRun(home, chatId);
  assert.ok(still);
  assert.equal(still.runId, crashRunId);
});

test("/recover with an unknown subcommand reports usage instead of doing anything", async () => {
  const home = await appHome("cmd-unknown");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-unknown-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  const { context } = recoverCommandContext({ home, chatId, guard: box.guard });

  await assert.rejects(handleSlashCommand("/recover klingonisch", context), /Usage: \/recover/);
  assert.ok(await findInterruptedRun(home, chatId));
});

// ---------------------------------------------------------------------------
// End-to-end: OrcodeAgent really writes the run log resume.ts reads.
//
// A real `agent.run()` cannot be made to leave an interrupted (no run-end)
// log from inside this process — its own try/catch/finally always writes
// run-end, on success, error, and cancellation alike; only an actual killed
// process skips that, which cannot be simulated in-process. So this proves
// the wiring the other way round: a normal, completed run produces a real
// run log at the expected path, carrying the prompt and a run-end, and
// `findInterruptedRun` correctly sees it as *not* interrupted.
// ---------------------------------------------------------------------------

interface FakeCallResult {
  getTextStream(): AsyncGenerator<string>;
  getReasoningStream(): AsyncGenerator<string>;
  getResponse(): Promise<{ model?: string; usage?: { cost?: number } }>;
}

function fakeAgentClient(): unknown {
  return {
    callModel(): FakeCallResult {
      return {
        async *getTextStream() {
          yield "Erledigt.";
        },
        async *getReasoningStream() {},
        async getResponse() {
          return { model: "vendor/echt", usage: { cost: 0.001 } };
        },
      };
    },
  };
}

test("a real OrcodeAgent.run() writes a run log with the prompt and a run-end, so findInterruptedRun sees it as not interrupted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-resume-agent-"));
  const home = join(workspace, ".state");
  const session = await SessionStore.open(workspace, home);
  const config: OrcodeConfigWithBudget = {
    ...DEFAULT_CONFIG,
    reasoningByModel: {},
    budget: { ...DEFAULT_CONFIG.budget },
  };
  const approvals = new ApprovalManager("read-only");
  const openRouter = {
    client: () => fakeAgentClient(),
    checkBalance: async () => ({ key: { limit: 10, limitRemaining: 8, usage: 2 } }),
    onConnectionEvent: () => () => {},
    safeMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    listModels: async () => [],
  } as unknown as OpenRouterService;
  const agent = await OrcodeAgent.create({ openRouter, approvals, session, config, workspace });

  const result = await agent.run("Bitte a.ts prüfen", { onText: () => {} });
  assert.equal(result.outcome, "completed");

  const found = await findInterruptedRun(home, session.data.id);
  assert.equal(found, null, "ein sauber beendeter Lauf darf nicht als abgebrochen gelten");

  const dir = runsDir(home, session.data.id);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const events: AgentRunEvent[] = [];
  for await (const event of RunLog.read(home, session.data.id, files[0]!.replace(/\.ndjson$/, ""))) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "run-start");
  assert.equal((events[0] as { prompt?: string }).prompt, "Bitte a.ts prüfen");
  assert.equal(events.at(-1)?.type, "run-end");
});

// ---------------------------------------------------------------------------
// /undo slash command (src/commands.ts) — the deliberate path, generalized
// from resume.ts's crash-path revert core (`undoInterruptedRun`) rather than
// a second implementation. Real `SessionStore` throughout (not a stub) so
// the session-turn and cost-ledger assertions below are meaningful.
// ---------------------------------------------------------------------------

async function undoSandbox(
  home: string,
  prefix: string,
  title = "Undo test",
): Promise<{
  session: SessionStore;
  chatId: string;
  guard: WorkspaceGuard;
  approvals: ApprovalManager;
  journal: ChangeJournal;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `routercode-resume-undo-ws-${prefix}-`));
  const session = SessionStore.create(root, home, title);
  const chatId = session.data.id;
  const guard = await WorkspaceGuard.create(root);
  const approvals = new ApprovalManager("allow-all");
  const journal = new ChangeJournal({ appHome: home, chatId });
  return { session, chatId, guard, approvals, journal, root };
}

function undoCommandContext(options: {
  session: SessionStore;
  guard: WorkspaceGuard;
  journal: ChangeJournal;
  approvals: ApprovalManager;
  confirmUndo?: (title: string, details: string) => Promise<boolean>;
}): { context: CommandContext; lines: string[] } {
  const { out, lines } = collectResumeOutput();
  const context: CommandContext = {
    config: {} as CommandContext["config"],
    approvals: options.approvals,
    openRouter: {} as CommandContext["openRouter"],
    session: options.session,
    agent: { journal: options.journal, guard: options.guard } as unknown as CommandContext["agent"],
    workspace: options.guard.root,
    credentials: {} as CommandContext["credentials"],
    out,
    ruleStore: {} as CommandContext["ruleStore"],
    // FIX-14 ticket 6: `/undo` reaches the surface through the one shared
    // `confirm` seam now. This harness keeps its (title, details) shape and
    // adapts, so every case below reads unchanged.
    ...(options.confirmUndo
      ? {
          confirm: (request: { title: string; consequence?: string }) =>
            options.confirmUndo!(request.title, request.consequence ?? ""),
        }
      : {}),
  };
  return { context, lines };
}

/** Writes a completed run's NDJSON log carrying a write_file call for `path` plus one run_command call, so the disclosure always has something to name. */
async function writeCompletedRunWithToolCalls(
  home: string,
  chatId: string,
  runId: string,
  writtenPath: string,
): Promise<void> {
  await writeCompletedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Undo mich", timestamp: 1 },
    {
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "write_file",
      input: { path: writtenPath },
      timestamp: 2,
    },
    {
      type: "tool-end",
      id: "t1",
      number: 1,
      name: "write_file",
      input: { path: writtenPath },
      output: { ok: true, path: writtenPath, bytes: 10 },
      durationMs: 5,
      timestamp: 3,
    },
    {
      type: "tool-start",
      id: "t2",
      number: 2,
      name: "run_command",
      input: { command: "npm test" },
      timestamp: 4,
    },
    {
      type: "tool-end",
      id: "t2",
      number: 2,
      name: "run_command",
      input: { command: "npm test" },
      output: { exitCode: 0, stdout: "ok", stderr: "" },
      durationMs: 6,
      timestamp: 5,
    },
  ]);
}

test("/undo reverts the last completed run as one unit, discloses the run_command call, marks the run undone, records a session turn, and never un-books cost", async () => {
  const home = await appHome("undo-cmd-basic");
  const box = await undoSandbox(home, "basic");
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "one.txt", content: "vom lauf geschrieben\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "one.txt");
  box.session.addCost("main", 0.42);
  const costBefore = box.session.data.costs.totalUsd;

  let confirmed: { title: string; details: string } | null = null;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async (title, details) => {
      confirmed = { title, details };
      return true;
    },
  });

  await handleSlashCommand("/undo", context);

  if (!confirmed) throw new Error("the confirmation must have been shown");
  const { title, details } = confirmed;
  assert.equal(title, "Undo the last run?");
  assert.match(details, /1 file will be reverted/);
  assert.match(details, /one\.txt/);
  assert.match(details, /Not reverted: 1 command\/tool execution from this run: run_command/);
  assert.match(details, /This cannot be undone\./);

  assert.equal(existsSync(join(box.root, "one.txt")), false, "the newly created file must be deleted");
  assert.ok(lines.some((line) => /restored/.test(line)));

  const after = await findLastCompletedRun(home, box.chatId);
  assert.ok(after);
  assert.equal(after.runId, runId);
  assert.equal(after.undone, true);

  const turns = box.session.recentTurns(10);
  assert.ok(turns.some((turn) => turn.role === "assistant" && /Run undone/.test(turn.content)));

  assert.equal(box.session.data.costs.totalUsd, costBefore, "costs stay booked — never un-booked by an undo");
});

test("/undo refuses honestly when a tracked file drifted since the run, names the file, and never shows a confirmation", async () => {
  const home = await appHome("undo-cmd-drift");
  const box = await undoSandbox(home, "drift");
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "drifted.txt", content: "vom lauf geschrieben\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "drifted.txt");

  // The user (or something else) touched the file after the run.
  await writeFile(join(box.root, "drifted.txt"), "von jemand anderem geändert\n", "utf8");

  let confirmCalls = 0;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async () => {
      confirmCalls += 1;
      return true;
    },
  });

  await handleSlashCommand("/undo", context);

  assert.equal(confirmCalls, 0, "drift must refuse before any confirmation is shown");
  assert.ok(lines.some((line) => /changed since the run/.test(line)));
  assert.ok(lines.some((line) => /drifted\.txt/.test(line)));
  assert.equal(
    await readFile(join(box.root, "drifted.txt"), "utf8"),
    "von jemand anderem geändert\n",
    "no partial revert — the drifted file must be left exactly as found",
  );
});

test("/undo refuses 'No completed run to undo in this chat' when the chat never ran", async () => {
  const home = await appHome("undo-cmd-no-run");
  const box = await undoSandbox(home, "no-run");
  const { context, lines } = undoCommandContext({ ...box, confirmUndo: async () => true });

  await handleSlashCommand("/undo", context);

  assert.ok(lines.some((line) => /No completed run to undo in this chat\./.test(line)));
});

test("/undo refuses honestly when the chat's only run was a Cross run", async () => {
  const home = await appHome("undo-cmd-cross-only");
  const box = await undoSandbox(home, "cross-only");
  box.session.noteCrossRun();
  await box.session.save();
  let confirmCalls = 0;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async () => { confirmCalls += 1; return true; },
  });

  await handleSlashCommand("/undo", context);

  assert.equal(confirmCalls, 0);
  // FIX-10 M1: /undo CAN revert Cross runs — this refusal (a noteCrossRun()
  // without a sidecar identity) must name the honest cause, never a
  // fabricated "can't revert Cross runs yet" capability gap.
  assert.ok(lines.some((line) =>
    /Can't undo — the most recent run was a Cross run, but its sidecar identity is missing or doesn't match the recorded run/.test(line)));
  assert.ok(!lines.some((line) => /can't revert Cross runs/.test(line)));
  assert.ok(!lines.some((line) => /No completed run to undo/.test(line)));
});

test("/undo refuses the Cross guard when a Cross run postdates the last ordinary run, and still works when the ordinary run is newer", async () => {
  const home = await appHome("undo-cmd-cross-order");
  const box = await undoSandbox(home, "cross-order");
  const runId = createRunId(new Date(Date.now() - 60_000));
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "ordnung.txt");

  // Cross ran AFTER the ordinary run: guard refuses, never confirms.
  box.session.noteCrossRun();
  await box.session.save();
  let confirmCalls = 0;
  const refused = undoCommandContext({
    ...box,
    confirmUndo: async () => { confirmCalls += 1; return true; },
  });
  await handleSlashCommand("/undo", refused.context);
  assert.equal(confirmCalls, 0);
  assert.ok(refused.lines.some((line) => /was a Cross run/.test(line)));

  // Ordinary run newer than the Cross stamp: guard stays out of the way.
  const newerRunId = createRunId(new Date(Date.now() + 60_000));
  await writeCompletedRunWithToolCalls(home, box.chatId, newerRunId, "ordnung.txt");
  const allowed = undoCommandContext({ ...box, confirmUndo: async () => false });
  await handleSlashCommand("/undo", allowed.context);
  assert.ok(!allowed.lines.some((line) => /was a Cross run/.test(line)));
});

test("/undo refuses 'already undone' the second time (one level only, no undo-the-undo)", async () => {
  const home = await appHome("undo-cmd-already");
  const box = await undoSandbox(home, "already");
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "once.txt", content: "einmal rückgängig gemacht\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "once.txt");

  const first = undoCommandContext({ ...box, confirmUndo: async () => true });
  await handleSlashCommand("/undo", first.context);
  assert.ok(first.lines.some((line) => /restored/.test(line)));

  let secondConfirmCalls = 0;
  const second = undoCommandContext({
    ...box,
    confirmUndo: async () => {
      secondConfirmCalls += 1;
      return true;
    },
  });
  await handleSlashCommand("/undo", second.context);

  assert.equal(secondConfirmCalls, 0, "an already-undone run must never reach a confirmation");
  assert.ok(second.lines.some((line) => /Nothing to undo — the last run is already undone\./.test(line)));
});

test("/undo does nothing at all when the confirmation is declined (cancel-never-success)", async () => {
  const home = await appHome("undo-cmd-decline");
  const box = await undoSandbox(home, "decline");
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "kept.txt", content: "bleibt so\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "kept.txt");

  const { context, lines } = undoCommandContext({ ...box, confirmUndo: async () => false });

  await handleSlashCommand("/undo", context);

  assert.equal(lines.length, 0, "a decline must produce no output at all");
  assert.equal(await readFile(join(box.root, "kept.txt"), "utf8"), "bleibt so\n");
  const still = await findLastCompletedRun(home, box.chatId);
  assert.ok(still);
  assert.equal(still.undone, false, "declining must not mark the run undone");
});

test("/undo refuses non-interactively instead of hanging or silently assuming yes", async () => {
  const home = await appHome("undo-cmd-noninteractive");
  const box = await undoSandbox(home, "noninteractive");
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, box.journal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "unattended.txt", content: "unbeaufsichtigt\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(home, box.chatId, runId, "unattended.txt");

  // No confirm seam set — the plain-mode fallback path — with stdin/stdout
  // forced to a non-TTY shape, exactly like a piped or `-p`/`--json` start.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    const { context } = undoCommandContext(box);
    await assert.rejects(handleSlashCommand("/undo", context), /undo requires an interactive session/);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }

  assert.equal(
    await readFile(join(box.root, "unattended.txt"), "utf8"),
    "unbeaufsichtigt\n",
    "nothing must have been touched by a refused attempt",
  );
  const still = await findLastCompletedRun(home, box.chatId);
  assert.ok(still);
  assert.equal(still.undone, false);
});

// ---------------------------------------------------------------------------
// P10b (Phase-11 ruling 6 completion): the Cross branch of /undo. Builds a
// lead sidecar the same way cli.ts's Cross worker adapter does —
// `<mainAppHome>/cross-sidecars/<uuid>-lead`, a fresh chat id, its own
// ChangeJournal/run log — and arms the main chat's `lastCrossRun` identity
// exactly as `publishCrossResultToSession` would. Critically, the checkpoint
// entries are written through `box.guard` (the MAIN workspace guard,
// verified in cli.ts to be what the real Lead's own WorkspaceGuard resolves
// to) while being RECORDED into the sidecar's own journal — proving the
// revert core/drift check/confirmation composer (all UNTOUCHED by this
// phase) already work correctly against a sidecar identity with zero
// Cross-specific logic inside them.
// ---------------------------------------------------------------------------

async function crossSidecarFor(
  home: string,
  box: { session: SessionStore },
): Promise<{
  sidecarId: string;
  sidecarHome: string;
  sidecarChatId: string;
  sidecarJournal: ChangeJournal;
  arm: () => Promise<void>;
}> {
  const sidecarId = `${randomUUID()}-lead`;
  const sidecarHome = join(home, "cross-sidecars", sidecarId);
  const sidecarChatId = randomUUID();
  // Mirrors production's real ordering guarantee: in cli.ts, the lead's
  // OrcodeAgent always opens its RunLog (which recursively creates
  // `sidecarHome` via `ensureSecureDirectory`) before any tool call — and
  // therefore before `ChangeJournal.record()` ever writes a checkpoint —
  // every real run. `PrivateStore`'s own directory walk only ever creates
  // ONE missing segment at a time (never `{recursive:true}`), so a fabricated
  // test run that skips straight to a checkpoint write without a real,
  // sequenced `RunLog.open()` first must recreate that same precondition
  // itself, or the checkpoint write ENOENTs on the still-missing
  // `cross-sidecars/<uuid>-lead` directory.
  await ensureSecureDirectory(sidecarHome);
  const sidecarJournal = new ChangeJournal({ appHome: sidecarHome, chatId: sidecarChatId });
  return {
    sidecarId,
    sidecarHome,
    sidecarChatId,
    sidecarJournal,
    async arm() {
      box.session.noteCrossRun({ sidecarId, chatId: sidecarChatId });
      await box.session.save();
    },
  };
}

test("/undo (Cross branch) reverts the lead's tracked changes as one unit, discloses the lead's process calls, marks it undone in the SIDECAR log, and posts honest Cross labeling in the main chat", async () => {
  const home = await appHome("undo-cross-e2e");
  const box = await undoSandbox(home, "cross-e2e");
  const sidecar = await crossSidecarFor(home, box);
  await sidecar.arm();
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, sidecar.sidecarJournal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "cross-one.txt", content: "vom Lead-Lauf geschrieben\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(sidecar.sidecarHome, sidecar.sidecarChatId, runId, "cross-one.txt");

  let confirmed: { title: string; details: string } | null = null;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async (title, details) => {
      confirmed = { title, details };
      return true;
    },
  });

  await handleSlashCommand("/undo", context);

  if (!confirmed) throw new Error("the confirmation must have been shown");
  const { title, details } = confirmed;
  // Same confirmation shape as the ordinary path — `formatUndoConfirmation`
  // is byte-for-byte unchanged (ruling 5).
  assert.equal(title, "Undo the last run?");
  assert.match(details, /1 file will be reverted/);
  assert.match(details, /cross-one\.txt/);
  assert.match(details, /Not reverted: 1 command\/tool execution from this run: run_command/);
  assert.match(details, /This cannot be undone\./);

  assert.equal(existsSync(join(box.root, "cross-one.txt")), false, "the lead's newly created file must be deleted from the REAL workspace");
  assert.ok(lines.some((line) => /Cross run undone — the coding model's file changes were reverted\./.test(line)));
  assert.ok(lines.some((line) => /restored/.test(line)));

  // Marked undone in the SIDECAR's own log — the main chat's own run log
  // (which never had anything written to it) stays exactly as empty as it
  // started (ruling 2).
  const sidecarState = await findLastCompletedRun(sidecar.sidecarHome, sidecar.sidecarChatId);
  assert.ok(sidecarState);
  assert.equal(sidecarState.undone, true);
  const mainState = await findLastCompletedRun(home, box.chatId);
  assert.equal(mainState, null, "the main chat's own run log must stay untouched — nothing was ever written there by a Cross run");

  const turns = box.session.recentTurns(10);
  assert.ok(turns.some((turn) => turn.role === "assistant" && /Cross run undone — the coding model's file changes were reverted\./.test(turn.content)));
});

test("/undo (Cross branch) refuses honestly when a tracked file drifted since the run — the drift check reads the REAL workspace path straight from the sidecar's checkpoint", async () => {
  const home = await appHome("undo-cross-drift");
  const box = await undoSandbox(home, "cross-drift");
  const sidecar = await crossSidecarFor(home, box);
  await sidecar.arm();
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, sidecar.sidecarJournal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "cross-drifted.txt", content: "vom Lead-Lauf geschrieben\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(sidecar.sidecarHome, sidecar.sidecarChatId, runId, "cross-drifted.txt");

  // Someone (or something) touched the real workspace file after the Cross run.
  await writeFile(join(box.root, "cross-drifted.txt"), "von jemand anderem geändert\n", "utf8");

  let confirmCalls = 0;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async () => { confirmCalls += 1; return true; },
  });

  await handleSlashCommand("/undo", context);

  assert.equal(confirmCalls, 0, "drift must refuse before any confirmation is shown");
  assert.ok(lines.some((line) => /changed since the run/.test(line)));
  assert.ok(lines.some((line) => /cross-drifted\.txt/.test(line)));
  assert.equal(
    await readFile(join(box.root, "cross-drifted.txt"), "utf8"),
    "von jemand anderem geändert\n",
    "no partial revert — the drifted file must be left exactly as found",
  );
});

test("/undo (Cross branch) refuses 'already undone' the second time, via the SIDECAR's own marker (one level only)", async () => {
  const home = await appHome("undo-cross-already");
  const box = await undoSandbox(home, "cross-already");
  const sidecar = await crossSidecarFor(home, box);
  await sidecar.arm();
  const runId = createRunId();

  const tools = createCodingTools(box.guard, box.approvals, sidecar.sidecarJournal, { runId });
  const writeFileTool = tools.find((tool) => tool.function.name === "write_file")!;
  await writeFileTool.function.execute(
    { path: "cross-once.txt", content: "einmal rückgängig gemacht\n" } as never,
    {} as never,
  );
  await writeCompletedRunWithToolCalls(sidecar.sidecarHome, sidecar.sidecarChatId, runId, "cross-once.txt");

  const first = undoCommandContext({ ...box, confirmUndo: async () => true });
  await handleSlashCommand("/undo", first.context);
  assert.ok(first.lines.some((line) => /restored/.test(line)));

  let secondConfirmCalls = 0;
  const second = undoCommandContext({
    ...box,
    confirmUndo: async () => { secondConfirmCalls += 1; return true; },
  });
  await handleSlashCommand("/undo", second.context);

  assert.equal(secondConfirmCalls, 0, "an already-undone Cross run must never reach a confirmation");
  assert.ok(second.lines.some((line) => /Nothing to undo — the last Cross run is already undone\./.test(line)));
});

test("/undo (Cross branch) refuses honestly when the sidecar record is missing entirely — never a wrong-journal revert", async () => {
  const home = await appHome("undo-cross-missing");
  const box = await undoSandbox(home, "cross-missing");
  const sidecar = await crossSidecarFor(home, box);
  await sidecar.arm();
  // No run log is ever written for this sidecar's `runs/` directory — the
  // same `readdir` ENOENT `findLastCompletedRun` already treats as "chat
  // never ran" for an ordinary chat, whether the sidecar directory itself is
  // entirely absent (retention finding: nothing in the codebase cleans these
  // up automatically, so this only happens via manual deletion or disk loss
  // today) or — as fabricated here — present but never got as far as a run.

  const { context, lines } = undoCommandContext({ ...box, confirmUndo: async () => true });
  await handleSlashCommand("/undo", context);

  assert.ok(lines.some((line) =>
    /Can't undo — the Cross run's sidecar record is missing or has no completed run\./.test(line)));
});

test("/undo (Cross branch): a cancelled/never-completed lead run is honestly non-undoable — the sidecar's existing run-end semantics need no special case (ruling 4)", async () => {
  const home = await appHome("undo-cross-cancelled");
  const box = await undoSandbox(home, "cross-cancelled");
  const sidecar = await crossSidecarFor(home, box);
  await sidecar.arm();
  const runId = createRunId();
  // Exactly what a lead run that never reached its own `finally` (crashed,
  // or aborted before the coding model produced anything) leaves behind: a
  // log with no `run-end` — `findLastCompletedRun` (unmodified) already
  // treats this as "nothing to undo yet", the same as it does for an
  // ordinary chat.
  await writeInterruptedRun(sidecar.sidecarHome, sidecar.sidecarChatId, runId, [
    { type: "run-start", model: "vendor/lead-model", maxSteps: 40, prompt: "Cross task", timestamp: 1 },
  ]);

  let confirmCalls = 0;
  const { context, lines } = undoCommandContext({
    ...box,
    confirmUndo: async () => { confirmCalls += 1; return true; },
  });
  await handleSlashCommand("/undo", context);

  assert.equal(confirmCalls, 0, "a never-completed lead run must never reach a confirmation");
  assert.ok(lines.some((line) =>
    /Can't undo — the Cross run's sidecar record is missing or has no completed run\./.test(line)));
});
