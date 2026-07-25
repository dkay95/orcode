import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { OrcodeAgent } from "../src/agent.js";
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
import { ChangeJournal, WorkspaceGuard, createCodingTools } from "../src/workspace.js";
import {
  buildResumePrompt,
  checkRunFileDrift,
  findInterruptedRun,
  formatInterruptedRunNotice,
  formatUndoOutcome,
  markRunReviewed,
  summarizeRun,
  undoInterruptedRun,
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
  assert.match(summary.brokeOffAt, /vor dem ersten/);
});

// ---------------------------------------------------------------------------
// buildResumePrompt — never invents what summarizeRun did not find
// ---------------------------------------------------------------------------

test("buildResumePrompt includes every fact the summary actually has", () => {
  const summary = summarizeRun(realisticInterruptedEvents());
  const text = buildResumePrompt(summary);

  assert.match(text, /NEUER Lauf/);
  assert.match(text, /Räum die Testdatei auf/);
  assert.match(text, /vendor\/model/);
  assert.match(text, /a\.ts/);
  assert.match(text, /read_file/);
  assert.match(text, /run_command/);
  assert.match(text, /fehlgeschlagen/);
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
    answerCharsSoFar: 0,
    partialAnswerText: "",
    brokeOffAt: "vor dem ersten aufgezeichneten Ereignis",
  };
  const text = buildResumePrompt(summary);
  assert.doesNotMatch(text, /Ursprüngliche Aufgabe/);
  assert.doesNotMatch(text, /Modell des abgebrochenen Laufs/);
  assert.doesNotMatch(text, /Werkzeugaufrufe/);
  assert.doesNotMatch(text, /geänderte Dateien/i);
  assert.doesNotMatch(text, /Kosten/);
  assert.doesNotMatch(text, /unvollständige Antwort/);
  assert.match(text, /vor dem ersten aufgezeichneten Ereignis/);
});

// ---------------------------------------------------------------------------
// formatInterruptedRunNotice — the short startup banner
// ---------------------------------------------------------------------------

test("formatInterruptedRunNotice reports time, task, file count, and cost, and flags drifted files", () => {
  const summary = summarizeRun(realisticInterruptedEvents());
  const notice = formatInterruptedRunNotice(summary, [
    { path: "/abs/a.ts", status: "modified-since" },
  ]);
  assert.match(notice, /nicht sauber beendet/);
  assert.match(notice, /Räum die Testdatei auf/);
  assert.match(notice, /Geänderte Dateien: 1/);
  assert.match(notice, /\$0\.003/);
  assert.match(notice, /extern verändert/);
  assert.match(notice, /a\.ts/);
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
  assert.match(formatUndoOutcome(outcome), /2 Datei\(en\) wiederhergestellt/);
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
  assert.match(formatUndoOutcome(outcome), /Keine Dateiänderung/);
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
// /resume slash command (src/commands.ts) — the interactive shell around
// resume.ts, reachable at any point in the session, not only at startup.
// Reuses every helper above (`sandbox`, `writeInterruptedRun`,
// `createCodingTools`) exactly as the direct resume.ts tests do; only the
// entry point (`handleSlashCommand`) changes.
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
 * A `CommandContext` for `/resume` alone: real `session`/`agent.journal`/
 * `agent.guard`/`approvals` (everything `resumeCommand` actually touches),
 * everything else stubbed since `/resume` never reads it.
 */
function resumeCommandContext(options: {
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

test("/resume with nothing interrupted reports that plainly and changes nothing", async () => {
  const home = await appHome("cmd-none");
  const box = await sandbox(home, "chat-1", "cmd-none-ws");
  const { context, lines } = resumeCommandContext({ home, chatId: "chat-1", guard: box.guard });

  await handleSlashCommand("/resume", context);
  assert.ok(lines.some((line) => /Kein abgebrochener Lauf gefunden/.test(line)));
});

test("/resume with no argument shows the notice and all three possibilities, without acting", async () => {
  const home = await appHome("cmd-bare");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-bare-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Nur ansehen, bitte", timestamp: 1 },
  ]);
  const { context, lines } = resumeCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/resume", context);
  const joined = lines.join("\n");
  assert.match(joined, /nicht sauber beendet/);
  assert.match(joined, /Nur ansehen, bitte/);
  assert.match(joined, /fortsetzen/);
  assert.match(joined, /undo/);
  assert.match(joined, /verwerfen/);

  // A bare `/resume` is read-only: the run must still be reported next time.
  const still = await findInterruptedRun(home, chatId);
  assert.ok(still);
  assert.equal(still.runId, runId);
});

test("/resume verwerfen marks the run reviewed and touches no files", async () => {
  const home = await appHome("cmd-discard");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-discard-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  const { context, lines } = resumeCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/resume verwerfen", context);
  assert.ok(lines.some((line) => /Verworfen/.test(line)));
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/resume fortsetzen seeds the resume prompt via seedNextMessage and marks the run reviewed", async () => {
  const home = await appHome("cmd-continue");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-continue-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Räum b.ts auf", timestamp: 1 },
  ]);
  const { context, lines } = resumeCommandContext({ home, chatId, guard: box.guard });
  const seeded: string[] = [];
  context.seedNextMessage = (text) => seeded.push(text);

  await handleSlashCommand("/resume fortsetzen", context);
  assert.equal(seeded.length, 1);
  assert.match(seeded[0]!, /NEUER Lauf/);
  assert.match(seeded[0]!, /Räum b\.ts auf/);
  assert.ok(lines.some((line) => /wird der nächsten Nachricht vorangestellt/.test(line)));
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/resume fortsetzen prints the resume prompt directly when seedNextMessage is unset", async () => {
  const home = await appHome("cmd-continue-fallback");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-continue-fallback-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, prompt: "Räum b.ts auf", timestamp: 1 },
  ]);
  const { context, lines } = resumeCommandContext({ home, chatId, guard: box.guard });

  await handleSlashCommand("/resume fortsetzen", context);
  assert.ok(lines.some((line) => /NEUER Lauf/.test(line) && /Räum b\.ts auf/.test(line)));
});

test("/resume undo restores the interrupted run's files and marks it reviewed — using undoInterruptedRun, no second path", async () => {
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
  // and resumeCommand's own guard enforces — reusing producing.guard so the
  // undo writes land in the same workspace the "crash" wrote to.
  const { context, lines } = resumeCommandContext({ home, chatId, guard: producing.guard });
  assert.equal(context.agent.journal.size, 0);

  await handleSlashCommand("/resume undo", context);
  assert.ok(lines.some((line) => /wiederhergestellt/.test(line)));
  assert.equal(await readFile(join(producing.root, "one.txt"), "utf8"), "original\n");
  assert.equal(existsSync(join(producing.root, "two.txt")), false);
  assert.equal(await findInterruptedRun(home, chatId), null);
});

test("/resume undo refuses once this session's own journal already holds a change, and leaves everything untouched", async () => {
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

  const { context } = resumeCommandContext({ home, chatId, guard: box.guard, journal: ownJournal });

  await assert.rejects(handleSlashCommand("/resume undo", context), /nur sicher/);

  // Nothing was touched: the own session's journal entry survives untouched,
  // and the crash is still reported as interrupted (not marked reviewed).
  assert.equal(ownJournal.size, 1);
  assert.equal(await readFile(join(box.root, "own.txt"), "utf8"), "von dieser sitzung selbst\n");
  const still = await findInterruptedRun(home, chatId);
  assert.ok(still);
  assert.equal(still.runId, crashRunId);
});

test("/resume with an unknown subcommand reports usage instead of doing anything", async () => {
  const home = await appHome("cmd-unknown");
  const chatId = "chat-1";
  const runId = createRunId();
  const box = await sandbox(home, chatId, "cmd-unknown-ws");
  await writeInterruptedRun(home, chatId, runId, [
    { type: "run-start", model: "vendor/model", maxSteps: 40, timestamp: 1 },
  ]);
  const { context } = resumeCommandContext({ home, chatId, guard: box.guard });

  await assert.rejects(handleSlashCommand("/resume klingonisch", context), /Verwendung: \/resume/);
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
