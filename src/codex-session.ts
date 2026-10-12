import { AgentRunError, standingGoalInstruction, type AgentRunObserver, type AgentRunResult } from "./agent.js";
import type { ApprovalManager } from "./approval.js";
import { runCodexManagedTurn, type CodexManagedTurnAuthority, type CodexManagedTurnResult } from "./codex-managed-turn.js";
import { rawCompressionResult } from "./compressor.js";
import { createRunId, RunLog } from "./runlog.js";
import { redactText } from "./redaction.js";
import type { AgentRunEvent } from "./types.js";
import { chatTurnTranscriptText, type SessionStore } from "./session.js";
import type { ChangeJournal, WorkspaceGuard } from "./workspace.js";
import { isDeepStrictEqual } from "node:util";

export interface CodexSessionTurnInput {
  authority: CodexManagedTurnAuthority;
  session: SessionStore;
  workspace: WorkspaceGuard;
  approvals: ApprovalManager;
  journal: ChangeJournal;
  text: string;
  observer: AgentRunObserver;
  /** Internal test seam; not a configuration or GUI capability. */
  execute?: typeof runCodexManagedTurn;
}

export async function runCodexSessionTurn(input: CodexSessionTurnInput): Promise<AgentRunResult> {
  const { session, observer } = input;
  const model = input.authority.binding.route.canonicalModelId;
  if (!model) throw new Error("Codex hat kein ausdrücklich gewähltes Modell.");
  const runId = createRunId();
  const startedAt = Date.now();
  let history = "";
  const notices: string[] = [];
  let streamed = "";
  let log: RunLog | null = null;
  const tools = new Map<string, { number: number; startedAt: number; title: string }>();
  const emit = (event: AgentRunEvent) => {
    log?.write(event);
    try { observer.onEvent?.(event); } catch { /* The view cannot fail a provider turn. */ }
  };
  const status = (message: string) => {
    try { observer.onStatus?.(message); } catch { /* Observational only. */ }
  };
  try { log = await RunLog.open(session.appHome, session.data.id, runId); }
  catch { notices.push("Das Ausführungsprotokoll konnte nicht geöffnet werden."); }
  emit({ type: "run-start", model, maxSteps: 1, costKnowledge: "unknown", prompt: input.text, timestamp: startedAt });
  let managed: CodexManagedTurnResult;
  let executionStarted = false;
  try {
    // Persist the prompt before the external process starts; a crash must not erase it.
    session.addTurn("user", input.text);
    const promptId = session.data.turns.at(-1)?.id;
    const before = await session.save();
    if (before.merged) notices.push("Der Chat wurde mit Änderungen aus einem anderen Fenster zusammengeführt.");
    if (session.data.routeCleared === true || (session.data.route !== undefined
      && !isDeepStrictEqual(session.data.route, input.authority.binding.route))) {
      notices.push("Die Modellauswahl wurde in einem anderen Fenster geändert. Bitte wähle das gewünschte Modell erneut.");
      throw new Error("Codex session route changed before dispatch.");
    }
    // Save may adopt newer owner instructions. Build from that readback, not a stale snapshot.
    const transcript = session.data.turns.filter((turn) => turn.id !== promptId)
      .map(chatTurnTranscriptText).join("\n\n");
    history = redactText([
      session.data.summary ? `PREVIOUS COMPRESSED HANDOFF:\n${session.data.summary}` : "",
      transcript ? `CONVERSATION TRANSCRIPT:\n${transcript}` : "",
    ].filter(Boolean).join("\n\n"));
    const task = [standingGoalInstruction(session.data.goal), history,
      `CURRENT USER REQUEST:\n${input.text}`].filter(Boolean).join("\n\n");
    status("Codex arbeitet – Dateiänderungen werden vor Übernahme geprüft.");
    executionStarted = true;
    managed = await (input.execute ?? runCodexManagedTurn)({
      authority: input.authority, appHome: session.appHome, workspace: input.workspace,
      approvals: input.approvals, journal: input.journal, runId, task, signal: observer.signal,
      onEvent(event) {
        if (event.type === "text") {
          streamed += event.text;
          emit({ type: "text", delta: event.text, timestamp: Date.now() });
          try { observer.onText?.(event.text, streamed); } catch { /* Observational only. */ }
        } else if (event.type === "tool") {
          let tool = tools.get(event.itemId);
          if (!tool) {
            tool = { number: tools.size + 1, startedAt: Date.now(), title: event.title };
            tools.set(event.itemId, tool);
          }
          const base = { id: event.itemId, invocationId: `${runId}:${event.itemId}`, number: tool.number,
            name: "codex_command", input: { command: tool.title }, timestamp: Date.now() };
          if (event.phase === "start") emit({ type: "tool-start", ...base });
          else emit({ type: "tool-end", ...base, output: event.output ?? "",
            durationMs: Date.now() - tool.startedAt });
        } else if (event.type === "patch-preview") {
          status("Codex prüft eine Dateiänderung zur Freigabe.");
        }
      },
    });
  } catch {
    if (!executionStarted) await input.authority.client.drain().catch(() => undefined);
    managed = { status: observer.signal?.aborted ? "cancelled" : "error", text: streamed,
      publishedPaths: [], cost: "unknown", message: "Codex-Ausführung konnte nicht abgeschlossen werden." };
  }
  const result: AgentRunResult = {
    text: redactText(managed.text), suggestions: [], outcome: managed.status, costUsd: 0,
    mainCostUsd: 0, compressorCostUsd: 0, costKnowledge: "unknown",
    compression: rawCompressionResult(history, undefined, [], "unknown"),
    selectedModel: model, resolvedModel: model, notices, partial: managed.status !== "completed", modelSteps: 1,
  };
  session.addCost("main", 0, "unknown");
  if (result.text) session.addTurn("assistant", result.text);
  try {
    const saved = await session.save();
    if (saved.merged) notices.push("Der Chat wurde mit Änderungen aus einem anderen Fenster zusammengeführt.");
  } catch {
    result.outcome = "error";
    result.partial = true;
    notices.push("Die Antwort konnte nicht im Chat gespeichert werden. Bitte kopiere sie vor dem Schließen.");
  }
  emit({ type: "run-end", outcome: result.outcome === "completed" ? "complete" : result.outcome,
    durationMs: Date.now() - startedAt, toolCount: tools.size, timestamp: Date.now() });
  try { await log?.close(); } catch { notices.push("Das Ausführungsprotokoll konnte nicht vollständig gespeichert werden."); }
  if (result.outcome !== "completed") {
    throw new AgentRunError(new Error(managed.message ?? (result.outcome === "cancelled"
      ? "Codex-Ausführung abgebrochen." : "Codex-Ausführung fehlgeschlagen.")),
    result.outcome === "cancelled" ? "cancelled" : "error", result);
  }
  return result;
}
