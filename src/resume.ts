import { readFile, readdir } from "node:fs/promises";
import { RunLog, runLogPath, runsDir } from "./runlog.js";
import type { ApprovalManager } from "./approval.js";
import {
  checkpointRunPath,
  diffText,
  toolMetadata,
  type ChangeEntry,
  type ChangeJournal,
  type UndoRunOutcome,
  type WorkspaceGuard,
} from "./workspace.js";
import type { AgentRunEvent, CostKnowledge } from "./types.js";
import { formatUsd, hasCode, isRecord, pluralize, truncate } from "./utils.js";

/**
 * Honesty check for this whole module: the SDK's `ConversationState` for an
 * interrupted run was never committed (`ConversationStore.commit` only ever
 * runs after a *successful* run, on purpose — see conversation.ts) and never
 * will be. There is no "continue the SDK state mid-run". What this module
 * offers instead: reconstruct what happened from the run log, show it to the
 * user honestly, and — only with explicit consent — seed a brand new run
 * with that context, or undo the interrupted run's file changes as one unit
 * via the existing `ChangeJournal`.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface FileDriftEntry {
  /** Absolute path, as recorded by the change journal. */
  path: string;
  status: "matches" | "modified-since" | "missing" | "unreadable";
}

export interface InterruptedRun {
  chatId: string;
  runId: string;
  /** Absolute path to the run's NDJSON log. */
  path: string;
  /** Every supported event in order. Legacy bare events and current envelopes are decoded; corrupt and future-version lines are isolated by `RunLog.read`. */
  events: AgentRunEvent[];
  /**
   * Whether the files this run wrote still match what it wrote, checked
   * against the change journal's persisted checkpoint for this run. Empty
   * when the run never wrote a file, or its checkpoint is gone.
   */
  fileDrift: FileDriftEntry[];
}

/**
 * A run counts as interrupted when its NDJSON log has no `run-end` event —
 * the process never reached the `finally` in `OrcodeAgent.run()` that always
 * writes one, on success, failure, or cancellation alike. Only the most
 * recent run for the chat is ever considered: an older crash that a later,
 * completed run has since superseded is not worth resurfacing.
 *
 * Never throws on a missing runs directory, a vanished log file, or
 * corrupted or unsupported future-version content — all of that just means
 * "nothing to report" for that content, without affecting other run files.
 */
export async function findInterruptedRun(
  appHome: string,
  chatId: string,
): Promise<InterruptedRun | null> {
  const runId = await latestRunId(appHome, chatId);
  if (!runId) {
    return null;
  }

  let events: AgentRunEvent[];
  try {
    events = await collectEvents(appHome, chatId, runId);
  } catch {
    // The newest log vanished or is unreadable between `readdir` and now —
    // nothing reliable to report.
    return null;
  }
  if (events.some((event) => event.type === "run-end")) {
    return null;
  }

  return {
    chatId,
    runId,
    path: runLogPath(appHome, chatId, runId),
    events,
    fileDrift: await checkRunFileDrift(appHome, chatId, runId),
  };
}

/**
 * The most recent run id for a chat, or null when the chat never ran (no
 * runs directory at all). Shared by `findInterruptedRun` (the crash path:
 * "the newest run, whatever its state") and `findLastCompletedRun` (the
 * deliberate `/undo` path: "the newest run, but only once it has ended").
 * `createRunId()` prefixes an ISO timestamp with fixed-width fields, so
 * lexical order is chronological order — the same assumption `RunLog.prune`
 * already relies on.
 */
async function latestRunId(appHome: string, chatId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(runsDir(appHome, chatId));
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const runIds = entries
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => name.slice(0, -".ndjson".length))
    .sort();
  return runIds.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Run discovery for the deliberate path: the last COMPLETED run
// ---------------------------------------------------------------------------

export interface CompletedRun {
  chatId: string;
  runId: string;
  /** Absolute path to the run's NDJSON log. */
  path: string;
  events: AgentRunEvent[];
  fileDrift: FileDriftEntry[];
  /** True once a prior `/undo` already reverted this run (one level only — no undo-the-undo). */
  undone: boolean;
}

/**
 * Finds the last run `/undo` may act on: the most recent run for this chat,
 * but only once it has actually ended (`run-end` present) — a still-running
 * or not-yet-reviewed interrupted run is `findInterruptedRun`'s territory,
 * never a target for the deliberate undo path. Returns null when the chat
 * never ran, or when its newest run has not ended yet; never throws on a
 * missing runs directory, a vanished log file, or corrupted content.
 */
export async function findLastCompletedRun(
  appHome: string,
  chatId: string,
): Promise<CompletedRun | null> {
  const runId = await latestRunId(appHome, chatId);
  if (!runId) {
    return null;
  }
  let events: AgentRunEvent[];
  try {
    events = await collectEvents(appHome, chatId, runId);
  } catch {
    return null;
  }
  if (!events.some((event) => event.type === "run-end")) {
    return null;
  }
  return {
    chatId,
    runId,
    path: runLogPath(appHome, chatId, runId),
    events,
    fileDrift: await checkRunFileDrift(appHome, chatId, runId),
    undone: events.some((event) => event.type === "run-undone"),
  };
}

/**
 * Records that `/undo` reverted this run — appended the same way
 * `markRunReviewed` closes out a reviewed crash: a new line on the existing
 * log, never a rewrite of what is already there. Called exactly once, right
 * after a successful `undoInterruptedRun`, so a later `/undo` on the same
 * chat sees `findLastCompletedRun(...).undone === true` and refuses honestly
 * instead of reverting the same run twice.
 */
export async function markRunUndone(
  appHome: string,
  chatId: string,
  run: Pick<CompletedRun, "runId">,
): Promise<void> {
  await RunLog.appendRunEvent(appHome, chatId, run.runId, {
    type: "run-undone",
    timestamp: Date.now(),
  });
}

async function collectEvents(
  appHome: string,
  chatId: string,
  runId: string,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of RunLog.read(appHome, chatId, runId)) {
    events.push(event);
  }
  return events;
}

/**
 * Marks a run as reviewed by appending a synthetic `run-end` to its log, so
 * `findInterruptedRun` stops reporting it on the next start. Used after the
 * user has explicitly decided what to do with an interrupted run — resume,
 * discard, or undo — never on its own.
 */
export async function markRunReviewed(
  appHome: string,
  chatId: string,
  run: Pick<InterruptedRun, "runId" | "events">,
): Promise<void> {
  await RunLog.appendRunEvent(appHome, chatId, run.runId, {
    type: "run-end",
    outcome: "cancelled",
    durationMs: 0,
    toolCount: run.events.filter((event) => event.type === "tool-start").length,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Summarizing (pure)
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  name: string;
  /** One-line summary of the call arguments — never the raw input, which can carry full file contents or secrets. */
  input: string;
  outcome: "ok" | "error" | "running";
  /** One-line summary of the result, once the call finished. */
  result?: string;
}

export interface RunSummary {
  model: string | null;
  maxSteps: number | null;
  /** Epoch ms the run started, or null if even `run-start` is missing/corrupt. */
  startedAt: number | null;
  /** The task this run was working on. Null when the log predates this field or the event is missing. */
  prompt: string | null;
  tools: ToolCallSummary[];
  /** Workspace-relative-turned-absolute paths a write_file/replace_text call touched successfully. */
  filesChanged: string[];
  /** Sum of every `model-end` event's cost — the compressor's own cost is not logged as an event and is not included. */
  costUsd: number;
  costKnowledge: CostKnowledge;
  /** How many characters of the final answer had already streamed before the log broke off. */
  answerCharsSoFar: number;
  /** The partial answer text itself, capped to a sane length for display/reuse. */
  partialAnswerText: string;
  /** German, human-readable description of the last recorded moment. */
  brokeOffAt: string;
}

const PARTIAL_ANSWER_CAP = 4_000;

/**
 * Pure and total: any array of `AgentRunEvent`, including an empty one or one
 * with only a handful of events, produces a `RunSummary` — never throws.
 */
export function summarizeRun(events: readonly AgentRunEvent[]): RunSummary {
  let model: string | null = null;
  let maxSteps: number | null = null;
  let startedAt: number | null = null;
  let prompt: string | null = null;
  let costUsd = 0;
  let costKnowledge: CostKnowledge = "known";
  let answerText = "";
  const tools = new Map<string, ToolCallSummary>();
  const filesChanged = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "run-start":
        model = event.model;
        maxSteps = event.maxSteps;
        startedAt = event.timestamp;
        if (event.prompt) {
          prompt = event.prompt;
        }
        if (event.costKnowledge === "unknown") costKnowledge = "unknown";
        break;
      case "model-end":
        costUsd += event.costUsd;
        if (event.costKnowledge === "unknown") costKnowledge = "unknown";
        break;
      case "text":
        answerText += event.delta;
        break;
      case "tool-start":
        tools.set(event.id, {
          name: event.name,
          input: toolMetadata(event.name).summarizeInput(event.input),
          outcome: "running",
        });
        break;
      case "tool-end": {
        const existing = tools.get(event.id) ?? {
          name: event.name,
          input: toolMetadata(event.name).summarizeInput(event.input),
          outcome: "running" as const,
        };
        tools.set(event.id, {
          ...existing,
          outcome: "ok",
          result: toolMetadata(event.name).summarizeOutput(event.output),
        });
        const path = writtenFilePath(event.name, event.output);
        if (path) {
          filesChanged.add(path);
        }
        break;
      }
      case "tool-error": {
        const existing = tools.get(event.id) ?? {
          name: event.name,
          input: toolMetadata(event.name).summarizeInput(event.input),
          outcome: "running" as const,
        };
        tools.set(event.id, {
          ...existing,
          outcome: "error",
          result: truncate(event.error, 300),
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    model,
    maxSteps,
    startedAt,
    prompt,
    tools: [...tools.values()],
    filesChanged: [...filesChanged].sort(),
    costUsd,
    costKnowledge,
    answerCharsSoFar: answerText.length,
    partialAnswerText: truncate(answerText, PARTIAL_ANSWER_CAP),
    brokeOffAt: describeBrokeOffAt(events.at(-1)),
  };
}

/**
 * The only two tool calls `ChangeJournal` ever records — and therefore the
 * only two an undo (crash-path or deliberate `/undo`) can ever revert.
 * Shared so the disclosure `/undo` shows ("Not reverted: …") is derived from
 * the exact same predicate that decides what gets tracked in the first
 * place, instead of a second, hand-maintained list that could drift from it.
 */
export function isFileWriteTool(name: string): boolean {
  return name === "write_file" || name === "replace_text";
}

function writtenFilePath(name: string, output: unknown): string | null {
  if (!isFileWriteTool(name)) {
    return null;
  }
  if (!isRecord(output) || output.ok !== true) {
    return null;
  }
  return typeof output.path === "string" ? output.path : null;
}

function describeBrokeOffAt(last: AgentRunEvent | undefined): string {
  if (!last) {
    return "before the first recorded event";
  }
  switch (last.type) {
    case "run-start":
      return "right after the start, before the first model response";
    case "model-start":
      return `during the model response (step ${last.step})`;
    case "model-end":
      return `after step ${last.step} finished, before the next event`;
    case "reasoning":
      return `during thinking (step ${last.step})`;
    case "interjection":
      return `right after an interjection: "${truncate(oneLine(last.text), 120)}"`;
    case "text":
      return "while composing the response";
    case "tool-start":
      return `during the tool call "${last.name}" (#${last.number})`;
    case "tool-output":
      return `while tool #${last.number} is still producing output`;
    case "tool-end":
      return `after the tool call "${last.name}" (#${last.number}), before the next event`;
    case "tool-error":
      return `after a failed tool call "${last.name}" (#${last.number})`;
    case "file-change":
      // FIX-3's event lands between a write and its own tool-end, so a crash
      // can genuinely stop here — naming the file beats "unknown".
      return `right after writing ${last.path} (+${last.added}/-${last.removed})`;
    case "verify":
      return `after the verify run "${last.command}" (round ${last.round})`;
    case "notice":
      return `at a notice: ${last.message}`;
    case "run-end":
      // Unreachable via findInterruptedRun (a run-end event means the run is
      // not interrupted), kept so this switch stays exhaustive.
      return "the run had already finished";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Building the resume prompt for a new run
// ---------------------------------------------------------------------------

/**
 * A factual block for the *new* run: what already happened, what
 * already changed, what was left open. Never invents anything — a field
 * that is missing from the summary is simply left out, not guessed at. Makes
 * no claim about continuing the old run; the wording is explicit that this
 * starts a new one.
 */
export function buildResumePrompt(summary: RunSummary): string {
  const lines: string[] = [
    "Resuming after an interrupted previous run (crash or abort). " +
      "This is a NEW run — the prior model/tool state was not preserved.",
  ];

  if (summary.prompt) {
    lines.push("", `Original task: ${summary.prompt}`);
  }
  if (summary.model) {
    lines.push("", `Model of the interrupted run: ${summary.model}`);
  }
  lines.push("", `Broke off: ${summary.brokeOffAt}.`);

  if (summary.tools.length) {
    lines.push("", "Tool calls already made:");
    for (const tool of summary.tools) {
      const status =
        tool.outcome === "ok" ? "succeeded" : tool.outcome === "error" ? "failed" : "did not finish";
      const detail = tool.result ? ` — ${tool.result}` : "";
      lines.push(`- ${tool.name} (${tool.input}) — ${status}${detail}`);
    }
  }

  if (summary.filesChanged.length) {
    lines.push(
      "",
      `Files already changed (${summary.filesChanged.length}):`,
      ...summary.filesChanged.map((path) => `- ${path}`),
    );
  }

  if (summary.costKnowledge === "unknown") {
    lines.push("", `Cost already incurred (main model): ${unknownRunCost(summary.costUsd)}`);
  } else if (summary.costUsd > 0) {
    lines.push("", `Cost already incurred (main model): ${formatUsd(summary.costUsd)}`);
  }

  if (summary.partialAnswerText.trim()) {
    lines.push("", "Incomplete response already started:", summary.partialAnswerText.trim());
  }

  lines.push(
    "",
    "Check the current state of the files named above yourself before continuing — " +
      "something may have changed since the abort. Don't needlessly repeat a step that already " +
      "finished successfully.",
  );
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Reporting the interrupted run at startup (short notice, not the resume prompt)
// ---------------------------------------------------------------------------

/**
 * The short status block shown at startup — time, task, number of changed
 * files, cost — never the full `buildResumePrompt` block. Callers append
 * their own three-way choice prompt (resume / discard / undo) after this.
 */
export function formatInterruptedRunNotice(
  summary: RunSummary,
  fileDrift: readonly FileDriftEntry[],
): string {
  const when = summary.startedAt
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(summary.startedAt),
      )
    : "unknown time";
  const lines: string[] = [`A previous run did not end cleanly (${when}).`];
  if (summary.prompt) {
    lines.push(`Task: ${truncate(oneLine(summary.prompt), 160)}`);
  }
  lines.push(`Broke off: ${summary.brokeOffAt}.`);
  if (summary.filesChanged.length) {
    lines.push(
      `Files changed: ${summary.filesChanged.length}${
        summary.filesChanged.length ? ` (${summary.filesChanged.join(", ")})` : ""
      }`,
    );
  }
  if (summary.costKnowledge === "unknown") {
    lines.push(`Cost of this run: ${unknownRunCost(summary.costUsd)}`);
  } else if (summary.costUsd > 0) {
    lines.push(`Cost of this run: ${formatUsd(summary.costUsd)}`);
  }
  const drifted = fileDrift.filter((entry) => entry.status !== "matches");
  if (drifted.length) {
    lines.push(
      `Note: ${drifted.length === 1 ? "1 of these files was" : `${drifted.length} of these files were`} changed externally or no longer exist since the run — ` +
        "an undo would skip them: " +
        drifted.map((entry) => `${entry.path} (${driftLabel(entry.status)})`).join(", "),
    );
  }
  return lines.join("\n");
}

function unknownRunCost(knownAmount: number): string {
  return knownAmount > 0
    ? `at least ${formatUsd(knownAmount)}; further provider-managed costs are unknown`
    : "provider-managed / unknown";
}

export function driftLabel(status: FileDriftEntry["status"]): string {
  switch (status) {
    case "modified-since":
      return "changed since";
    case "missing":
      return "no longer exists";
    case "unreadable":
      return "unreadable";
    case "matches":
      return "unchanged";
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// File drift: did the run's own files stay as it left them?
// ---------------------------------------------------------------------------

/**
 * Compares the current content of every file an interrupted run wrote
 * against what the change journal's checkpoint recorded it as writing. A
 * checkpoint that is missing, unreadable, or empty (the run never wrote a
 * file, or the checkpoint never made it to disk) yields an empty list —
 * never a thrown error.
 */
export async function checkRunFileDrift(
  appHome: string,
  chatId: string,
  runId: string,
): Promise<FileDriftEntry[]> {
  const entries = await readCheckpointEntries(appHome, chatId, runId);
  const results: FileDriftEntry[] = [];
  for (const entry of entries) {
    try {
      const current = await readFile(entry.path, "utf8");
      results.push({
        path: entry.path,
        status: current === entry.after ? "matches" : "modified-since",
      });
    } catch (error) {
      results.push({
        path: entry.path,
        status: hasCode(error, "ENOENT") ? "missing" : "unreadable",
      });
    }
  }
  return results;
}

async function readCheckpointEntries(
  appHome: string,
  chatId: string,
  runId: string,
): Promise<ChangeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(checkpointRunPath(appHome, chatId, runId), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isChangeEntry);
}

function isChangeEntry(value: unknown): value is ChangeEntry {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.before === null || typeof value.before === "string") &&
    typeof value.after === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.runId === "string"
  );
}

// ---------------------------------------------------------------------------
// Undo, reusing ChangeJournal.undoLastRun — no second restore path
// ---------------------------------------------------------------------------

/**
 * The one revert core, shared by both undo paths (Phase 11 ruling: never a
 * second revert implementation). Takes back a run's file changes by
 * hydrating a (normally empty, freshly constructed) `ChangeJournal` with
 * that run's persisted checkpoint entries and then calling the very same
 * `undoLastRun` `ChangeJournal` already exposes. Intentionally not a second
 * restore implementation of its own: the skip-on-external-change logic, the
 * approval flow, and the run-as-a-unit grouping all come from `ChangeJournal`
 * as-is.
 *
 * Two callers, unchanged behavior for the original one:
 * - The crash path (`findInterruptedRun` + `/recover undo`): resurfaced at
 *   startup, no confirmation of its own (the interrupted-run notice already
 *   asked).
 * - The deliberate path (`findLastCompletedRun` + `/undo`): reached mid-session
 *   on a run that ended cleanly, gated by its own confirmation
 *   (`formatUndoConfirmation`) and drift/one-level refusals in commands.ts.
 *
 * Must be called before any tool call has happened in this process on
 * `journal` — otherwise `undoLastRun`'s "last run" would no longer be the
 * hydrated one. True by construction at startup (the crash path); true for
 * the deliberate path too, since "the last completed run" this process can
 * name is, by definition, the newest thing `journal` could hold.
 */
export async function undoInterruptedRun(
  journal: ChangeJournal,
  guard: WorkspaceGuard,
  approvals: ApprovalManager,
  run: Pick<InterruptedRun, "runId">,
  options: { dryRun?: boolean } = {},
): Promise<UndoRunOutcome> {
  await journal.hydrateRun(run.runId);
  return journal.undoLastRun(guard, approvals, options);
}

/** One-line-per-file summary of an undo outcome, for display next to the interrupted-run flow. */
export function formatUndoOutcome(outcome: UndoRunOutcome): string {
  if (outcome.restored.length === 0 && outcome.skipped.length === 0) {
    return "No file change from this run found to undo.";
  }
  const lines: string[] = [];
  if (outcome.restored.length) {
    lines.push(`${pluralize(outcome.restored.length, "file")} restored: ${outcome.restored.join(", ")}`);
  }
  if (outcome.skipped.length) {
    lines.push(
      `${pluralize(outcome.skipped.length, "file")} skipped: ${outcome.skipped
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The deliberate /undo confirmation — diff summary, honest disclosure,
// consequence sentence, in that order (Phase 11 ruling 2).
// ---------------------------------------------------------------------------

export interface UndoConfirmation {
  title: string;
  details: string;
}

/**
 * Builds the exact confirmation `/undo` shows before reverting a run — pure,
 * takes only data already gathered by the caller (checkpoint entries hydrated
 * from `journal.hydrateRun`, the run's own tool-call summary), never touches
 * disk itself.
 *
 * Three parts, always in this order:
 * 1. The diff summary: every file about to be reverted, with a +/- line
 *    count (or "new file" for one the run created outright).
 * 2. The honest disclosure: every tool call in the run `isFileWriteTool`
 *    does not cover — bash and other external side effects this undo does
 *    NOT and cannot take back, named plainly by tool name, never glossed
 *    over the way a silent competitor `/rewind` would.
 * 3. The one consequence sentence: this undo cannot itself be undone (v1 is
 *    one level only — no undo-the-undo).
 */
export function formatUndoConfirmation(
  entries: readonly ChangeEntry[],
  tools: readonly ToolCallSummary[],
  displayPath: (path: string) => string,
): UndoConfirmation {
  const fileLines = entries.map((entry) => {
    const diff = diffText(entry.before ?? "", entry.after);
    const label = entry.before === null ? `new file, +${diff.added}` : `+${diff.added}/-${diff.removed}`;
    return `- ${displayPath(entry.path)} (${label})`;
  });
  const notReverted = tools.filter((tool) => !isFileWriteTool(tool.name));
  // FIX-9 (honest silence): with nothing left un-reverted there is no
  // disclosure to make, so the run of "Not reverted: 0 …" — a line that read
  // like a warning about nothing — is dropped along with its blank spacer
  // rather than printed as a zero.
  const disclosure = notReverted.length
    ? [
        "",
        `Not reverted: ${pluralize(notReverted.length, "command/tool execution")} from this run: ${notReverted
          .map((tool) => tool.name)
          .join(", ")}`,
      ]
    : [];
  const details = [
    `${pluralize(entries.length, "file")} will be reverted:`,
    ...fileLines,
    ...disclosure,
    "",
    "This cannot be undone.",
  ].join("\n");
  return { title: "Undo the last run?", details };
}
