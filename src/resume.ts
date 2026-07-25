import { readFile, readdir } from "node:fs/promises";
import { RunLog, runLogPath, runsDir } from "./runlog.js";
import type { ApprovalManager } from "./approval.js";
import {
  checkpointRunPath,
  toolMetadata,
  type ChangeEntry,
  type ChangeJournal,
  type UndoRunOutcome,
  type WorkspaceGuard,
} from "./workspace.js";
import type { AgentRunEvent } from "./types.js";
import { formatUsd, hasCode, isRecord, truncate } from "./utils.js";

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
  /** Every event the log contains, in order. Corrupt/half-written lines are already skipped (see `RunLog.read`). */
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
 * corrupted content — all of that just means "nothing to report".
 */
export async function findInterruptedRun(
  appHome: string,
  chatId: string,
): Promise<InterruptedRun | null> {
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
    // `createRunId()` prefixes an ISO timestamp with fixed-width fields, so
    // lexical order is chronological order — the same assumption `RunLog.prune`
    // already relies on.
    .sort();
  const runId = runIds.at(-1);
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
        break;
      case "model-end":
        costUsd += event.costUsd;
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
    answerCharsSoFar: answerText.length,
    partialAnswerText: truncate(answerText, PARTIAL_ANSWER_CAP),
    brokeOffAt: describeBrokeOffAt(events.at(-1)),
  };
}

function writtenFilePath(name: string, output: unknown): string | null {
  if (name !== "write_file" && name !== "replace_text") {
    return null;
  }
  if (!isRecord(output) || output.ok !== true) {
    return null;
  }
  return typeof output.path === "string" ? output.path : null;
}

function describeBrokeOffAt(last: AgentRunEvent | undefined): string {
  if (!last) {
    return "vor dem ersten aufgezeichneten Ereignis";
  }
  switch (last.type) {
    case "run-start":
      return "direkt nach dem Start, vor der ersten Modellantwort";
    case "model-start":
      return `während der Modellantwort (Schritt ${last.step})`;
    case "model-end":
      return `nach Abschluss von Schritt ${last.step}, vor dem nächsten Ereignis`;
    case "reasoning":
      return `während des Denkens (Schritt ${last.step})`;
    case "text":
      return "während des Formulierens der Antwort";
    case "tool-start":
      return `während des Tool-Aufrufs „${last.name}“ (#${last.number})`;
    case "tool-output":
      return `während laufender Ausgabe von Tool #${last.number}`;
    case "tool-end":
      return `nach Tool-Aufruf „${last.name}“ (#${last.number}), vor dem nächsten Ereignis`;
    case "tool-error":
      return `nach einem fehlgeschlagenen Tool-Aufruf „${last.name}“ (#${last.number})`;
    case "verify":
      return `nach dem Prüflauf „${last.command}“ (Runde ${last.round})`;
    case "notice":
      return `bei einem Hinweis: ${last.message}`;
    case "run-end":
      // Unreachable via findInterruptedRun (a run-end event means the run is
      // not interrupted), kept so this switch stays exhaustive.
      return "der Lauf war bereits abgeschlossen";
    default:
      return "unbekannt";
  }
}

// ---------------------------------------------------------------------------
// Building the resume prompt for a new run
// ---------------------------------------------------------------------------

/**
 * A factual German block for the *new* run: what already happened, what
 * already changed, what was left open. Never invents anything — a field
 * that is missing from the summary is simply left out, not guessed at. Makes
 * no claim about continuing the old run; the wording is explicit that this
 * starts a new one.
 */
export function buildResumePrompt(summary: RunSummary): string {
  const lines: string[] = [
    "Wiederaufnahme nach einem abgebrochenen vorherigen Lauf (Absturz oder Abbruch). " +
      "Dies ist ein NEUER Lauf — der bisherige Modell-/Werkzeugzustand ist nicht erhalten geblieben.",
  ];

  if (summary.prompt) {
    lines.push("", `Ursprüngliche Aufgabe: ${summary.prompt}`);
  }
  if (summary.model) {
    lines.push("", `Modell des abgebrochenen Laufs: ${summary.model}`);
  }
  lines.push("", `Abgebrochen: ${summary.brokeOffAt}.`);

  if (summary.tools.length) {
    lines.push("", "Bereits ausgeführte Werkzeugaufrufe:");
    for (const tool of summary.tools) {
      const status =
        tool.outcome === "ok" ? "erfolgreich" : tool.outcome === "error" ? "fehlgeschlagen" : "nicht abgeschlossen";
      const detail = tool.result ? ` — ${tool.result}` : "";
      lines.push(`- ${tool.name} (${tool.input}) — ${status}${detail}`);
    }
  }

  if (summary.filesChanged.length) {
    lines.push(
      "",
      `Bereits geänderte Dateien (${summary.filesChanged.length}):`,
      ...summary.filesChanged.map((path) => `- ${path}`),
    );
  }

  if (summary.costUsd > 0) {
    lines.push("", `Bereits angefallene Kosten (Hauptmodell): ${formatUsd(summary.costUsd)}`);
  }

  if (summary.partialAnswerText.trim()) {
    lines.push("", "Bereits begonnene, unvollständige Antwort:", summary.partialAnswerText.trim());
  }

  lines.push(
    "",
    "Prüfe den aktuellen Stand der genannten Dateien selbst, bevor du weitermachst — " +
      "seit dem Abbruch kann sich etwas geändert haben. Wiederhole keinen bereits erfolgreich " +
      "abgeschlossenen Schritt unnötig.",
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
    ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(summary.startedAt),
      )
    : "unbekannter Zeitpunkt";
  const lines: string[] = [`Ein vorheriger Lauf wurde nicht sauber beendet (${when}).`];
  if (summary.prompt) {
    lines.push(`Aufgabe: ${truncate(oneLine(summary.prompt), 160)}`);
  }
  lines.push(`Abgebrochen: ${summary.brokeOffAt}.`);
  if (summary.filesChanged.length) {
    lines.push(
      `Geänderte Dateien: ${summary.filesChanged.length}${
        summary.filesChanged.length ? ` (${summary.filesChanged.join(", ")})` : ""
      }`,
    );
  }
  if (summary.costUsd > 0) {
    lines.push(`Kosten dieses Laufs: ${formatUsd(summary.costUsd)}`);
  }
  const drifted = fileDrift.filter((entry) => entry.status !== "matches");
  if (drifted.length) {
    lines.push(
      `Achtung: ${drifted.length} dieser Datei(en) wurden seit dem Lauf extern verändert oder sind nicht mehr vorhanden — ` +
        "ein Zurücknehmen würde diese auslassen: " +
        drifted.map((entry) => `${entry.path} (${driftLabel(entry.status)})`).join(", "),
    );
  }
  return lines.join("\n");
}

function driftLabel(status: FileDriftEntry["status"]): string {
  switch (status) {
    case "modified-since":
      return "seither verändert";
    case "missing":
      return "nicht mehr vorhanden";
    case "unreadable":
      return "nicht lesbar";
    case "matches":
      return "unverändert";
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
 * Takes back an interrupted run's file changes by hydrating a (normally
 * empty, freshly constructed) `ChangeJournal` with that run's persisted
 * checkpoint entries and then calling the very same `undoLastRun` that
 * `/undo` already uses for an in-process run. Intentionally not a second
 * restore implementation: the skip-on-external-change logic, the approval
 * flow, and the run-as-a-unit grouping all come from `ChangeJournal` as-is.
 *
 * Must be called before any tool call has happened in this process on
 * `journal` — otherwise `undoLastRun`'s "last run" would no longer be the
 * hydrated one. That is always true at startup, which is the only place
 * this is meant to run.
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

/** German one-line-per-file summary of an undo outcome, for display next to the interrupted-run flow. */
export function formatUndoOutcome(outcome: UndoRunOutcome): string {
  if (outcome.restored.length === 0 && outcome.skipped.length === 0) {
    return "Keine Dateiänderung dieses Laufs zum Zurücknehmen gefunden.";
  }
  const lines: string[] = [];
  if (outcome.restored.length) {
    lines.push(`${outcome.restored.length} Datei(en) wiederhergestellt: ${outcome.restored.join(", ")}`);
  }
  if (outcome.skipped.length) {
    lines.push(
      `${outcome.skipped.length} Datei(en) übersprungen: ${outcome.skipped
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}
