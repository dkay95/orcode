import type { ApprovalManager } from "./approval.js";
import type { CodexAppServerClient } from "./codex-app-server.js";
import type { CodexRouteBinding, CodexRouteGate } from "./codex-route-gate.js";
import type { ChangeJournal, WorkspaceGuard } from "./workspace.js";
import { prepareCodexExecution, startCodexTurn,
  type CodexOperationJournal, type PreparedCodexExecution } from "./codex-execution.js";
import { ProcessEventRedactor, redactText } from "./redaction.js";

/** Process-local authority. Never serialize this into GUI or session state. */
export interface CodexManagedTurnAuthority {
  readonly client: CodexAppServerClient;
  readonly gate: CodexRouteGate;
  readonly binding: CodexRouteBinding;
  readonly childGeneration: number;
}

export type CodexManagedTurnEvent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "tool"; itemId: string; phase: "start" | "end"; title: string; output?: string }>
  | Readonly<{ type: "patch-preview"; itemId: string }>
  | Readonly<{ type: "completed" }>;

export interface CodexManagedTurnInput {
  readonly authority: CodexManagedTurnAuthority;
  readonly appHome: string;
  readonly workspace: WorkspaceGuard;
  readonly approvals: ApprovalManager;
  readonly journal: ChangeJournal;
  readonly runId: string;
  readonly task: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: CodexManagedTurnEvent) => void;
}

export type CodexManagedTurnResult = Readonly<{
  status: "completed" | "cancelled" | "error";
  text: string;
  publishedPaths: readonly string[];
  /** Provider-managed usage is never represented as a known zero charge. */
  cost: "unknown";
  message?: string;
}>;

/** A complete managed turn, separate from the OpenRouter SDK agent runtime. */
export async function runCodexManagedTurn(input: CodexManagedTurnInput): Promise<CodexManagedTurnResult> {
  const deadline = AbortSignal.timeout(30 * 60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let prepared: PreparedCodexExecution | null = null;
  let operation: CodexOperationJournal | null = null;
  let text = "";
  let successfulTerminal = false;
  let committedPaths: readonly string[] | null = null;
  let detachTerminal = () => {};
  let detachAbort = () => {};
  const redactor = new ProcessEventRedactor();
  let privateStream: PrivateValueStreamRedactor | null = null;
  // The process redactor buffers split credential prefixes before any public
  // event, unlike independently redacting each provider delta.
  const emitText = (delta: string, flush = false) => {
    privateStream ??= new PrivateValueStreamRedactor(privateTextValues(input, prepared));
    // Exact private values must be joined before generic redaction can alter
    // a token within a path, and before any chunk reaches the public surface.
    const filtered = privateStream.push(delta, flush);
    const events = filtered ? redactor.push({
      type: "process-output", id: "codex-assistant", name: "Codex", timestamp: Date.now(), stream: "stdout", text: filtered,
    }) : [];
    if (flush) events.push(...redactor.flushAll());
    for (const event of events) {
      if (event.type !== "process-output") continue;
      const safe = scrubPrivateText(event.text, input, prepared);
      if (safe) { text += safe; input.onEvent({ type: "text", text: safe }); }
    }
  };
  let resolveTerminal!: () => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<void>((resolve, reject) => {
    resolveTerminal = resolve; rejectTerminal = reject;
  });
  // A terminal/error may arrive before turn/start returns its journal.
  void terminal.catch(() => undefined);
  try {
    if (signal.aborted) throw new Error("Codex turn was cancelled.");
    prepared = await prepareCodexExecution({
      appHome: input.appHome, workspace: input.workspace, approvals: input.approvals, journal: input.journal,
      routeGate: input.authority.gate, routeBinding: input.authority.binding,
    });
    detachTerminal = input.authority.client.onTerminal(() => rejectTerminal(new Error("Codex connection closed.")));
    const onAbort = () => rejectTerminal(new Error("Codex turn was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
    operation = await startCodexTurn({
      prepared, client: input.authority.client, childGeneration: input.authority.childGeneration,
      task: input.task, signal,
      onNotification(event) {
        if (successfulTerminal) throw new Error("Codex emitted work after terminal completion.");
        const params = event.params;
        if (event.type === "assistant-text") emitText(params.delta as string);
        if (event.type === "tool-start" || event.type === "file-change") {
          const item = params.item as Record<string, unknown>;
          if (item.type === "commandExecution" && typeof item.command === "string"
            && typeof item.id === "string") {
            const output = typeof item.aggregatedOutput === "string"
              ? scrubPrivateText(item.aggregatedOutput, input, prepared) : undefined;
            input.onEvent({ type: "tool", itemId: item.id,
              phase: event.type === "tool-start" ? "start" : "end",
              title: scrubPrivateText(item.command, input, prepared), ...(output ? { output } : {}) });
          }
        }
        if (event.type === "patch-preview") input.onEvent({ type: "patch-preview", itemId: params.itemId as string });
        if (event.type === "error" && params.willRetry !== true) rejectTerminal(new Error("Codex could not complete this turn."));
        if (event.type === "run-end") {
          const completed = params.turn as Record<string, unknown>;
          if (completed.status !== "completed" || completed.error !== null) {
            rejectTerminal(new Error("Codex did not complete this turn."));
          } else {
            successfulTerminal = true;
            resolveTerminal();
          }
        }
      },
    });
    if (signal.aborted) throw new Error("Codex turn was cancelled.");
    await terminal;
    if (signal.aborted) throw new Error("Codex turn was cancelled.");
    if (!operation.approvalBridge) throw new Error("Codex completion has no approval authority.");
    // Draining before publication prevents the child from mutating staging
    // between exact-effect comparison and guarded real-workspace publication.
    detachTerminal(); detachTerminal = () => {};
    await operation.approvalBridge.completeAndDrain();
    if (signal.aborted) throw new Error("Codex turn was cancelled.");
    const publishedPaths = await operation.publishApproved(prepared, input.runId);
    committedPaths = publishedPaths;
    emitText("", true);
    input.onEvent({ type: "completed" });
    return { status: "completed", text, publishedPaths, cost: "unknown" };
  } catch {
    // A surface callback may fail after the guarded atomic publication. The
    // completed filesystem outcome must not be rewritten as an empty failure.
    if (committedPaths !== null) {
      return { status: "completed", text, publishedPaths: committedPaths, cost: "unknown" };
    }
    detachTerminal(); detachTerminal = () => {};
    const bridge = operation?.approvalBridge;
    let drained = false;
    try {
      if (bridge && !bridge.closed) {
        await bridge.cancelAndDrain();
        drained = true;
      } else {
        const result = await input.authority.client.drain();
        drained = result === "closed" || result === "killed";
      }
      await bridge?.waitForCleanup();
    } catch {
      const result = await input.authority.client.drain().catch(() => null);
      drained = result === "closed" || result === "killed";
      await bridge?.waitForCleanup().catch(() => undefined);
    }
    if (drained && prepared?.staging.active) await prepared.staging.discard().catch(() => undefined);
    if (operation && !operation.settled) operation.settle();
    emitText("", true);
    return { status: input.signal?.aborted ? "cancelled" : "error", text, publishedPaths: [], cost: "unknown",
      message: input.signal?.aborted ? "Codex-Ausführung abgebrochen." : "Codex konnte die Aufgabe nicht sicher abschließen." };
  } finally {
    detachTerminal(); detachAbort();
  }
}

function scrubPrivateText(text: string, input: CodexManagedTurnInput, prepared: PreparedCodexExecution | null): string {
  let safe = text;
  for (const value of privateTextValues(input, prepared)) safe = safe.split(value).join("[private]");
  return redactText(safe).replace(/codex-[0-9a-f]{32}/g, "[private]");
}

function privateTextValues(input: CodexManagedTurnInput, prepared: PreparedCodexExecution | null): string[] {
  return [...new Set([input.appHome, input.authority.binding.codexHomeRealpath,
    input.authority.binding.profileId, input.authority.binding.route.accountFingerprint,
    prepared?.staging.canonicalPath].filter((value): value is string => Boolean(value)))].sort((a, b) => b.length - a.length);
}

/** Retains only possible prefixes of the exact process-local private values. */
class PrivateValueStreamRedactor {
  #pending = "";
  constructor(readonly values: readonly string[]) {}

  push(delta: string, flush: boolean): string {
    const input = this.#pending + delta;
    let safe = "";
    let index = 0;
    while (index < input.length) {
      const remaining = input.slice(index);
      const full = this.values.find((value) => remaining.startsWith(value));
      const partial = this.values.some((value) => remaining.length < value.length && value.startsWith(remaining));
      if (partial && !flush) break;
      if (full) { safe += "[private]"; index += full.length; }
      else if (partial) { safe += "[private]"; index = input.length; }
      else { safe += input[index]; index++; }
    }
    this.#pending = input.slice(index);
    return safe;
  }
}
