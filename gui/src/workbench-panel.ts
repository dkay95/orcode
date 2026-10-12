import type { Block, RunSummary } from "./chat-model.js";
import { readDiff, renderDiffView } from "./diff.js";
import { el } from "./dom.js";

export interface WorkbenchInput {
  blocks: readonly Block[];
  run: RunSummary | null;
  workspace: string;
  ready: boolean;
  busy: boolean;
  undoAvailable: boolean;
}

export interface WorkbenchHandlers {
  command(raw: string): void;
  close(): void;
}

type FileChange = Extract<Block, { kind: "file-change" }>;
type Tool = Extract<Block, { kind: "tool" }>;
type InspectorBlock = FileChange | Tool;

interface Entry {
  node: HTMLDetailsElement;
  label: HTMLSpanElement;
  title: HTMLSpanElement;
  input: HTMLSpanElement;
  state: HTMLSpanElement;
  meta: HTMLSpanElement;
  body: HTMLDivElement;
  signature: string;
}

const TOOL_STATES: Record<Tool["state"], string> = {
  running: "Läuft",
  ok: "Abgeschlossen",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
  unverified: "Nicht verifiziert",
};

function signature(block: InspectorBlock): string {
  // Only fields actually shown here participate. Assistant deltas and the
  // transcript's independent collapsed state must not rebuild these cards.
  return JSON.stringify(block.kind === "file-change"
    ? [block.path, block.tool, block.created, block.added, block.removed, block.diff, block.truncated]
    : [block.label, block.title, block.input, block.state, block.lines, block.totalLines,
      block.exitCode, block.error, block.durationMs]);
}

function entryFor(block: InspectorBlock): Entry {
  const node = el("details", {
    class: block.kind === "file-change" ? "workbench-change" : "workbench-tool",
    "data-block": block.id,
  });
  const label = el("span", { class: "workbench-label" });
  const title = el("span", { class: "workbench-title" });
  const input = el("span", { class: "workbench-path mono" });
  const state = el("span", { class: "workbench-state" });
  const meta = el("span", { class: "workbench-meta mono" });
  const body = el("div", { class: "workbench-detail" });
  node.append(el("summary", { class: "workbench-entry-head" }, [label, title, input, state, meta]), body);
  return { node, label, title, input, state, meta, body, signature: "" };
}

function updateEntry(entry: Entry, block: InspectorBlock): void {
  const next = signature(block);
  if (entry.signature === next) return;
  entry.signature = next;

  // The summary and details element stay mounted, even when a running tool
  // gains output. The browser owns expansion and keyboard focus.
  if (block.kind === "file-change") {
    entry.title.textContent = "";
    entry.label.textContent = "Datei";
    entry.input.textContent = block.path;
    entry.state.textContent = block.created ? "Neu angelegt" : "Geändert";
    entry.meta.textContent = `+${block.added} −${block.removed}`;
    const source = el("p", { class: "workbench-source", text: `Gemeldet durch ${block.tool || "Dateiwerkzeug"}` });
    const diff = readDiff(block.diff, {
      added: block.added, removed: block.removed, truncated: block.truncated,
    });
    // The shared reader handles unified diffs. A source event without hunks
    // remains source text, not an invented before/after editor.
    const detail = diff.hunks.length > 0
      ? renderDiffView(diff)
      : el("pre", { class: "workbench-output", text: block.diff || "Kein Diff im Ereignis enthalten." });
    entry.body.replaceChildren(source, detail);
    if (diff.hunks.length === 0 && block.truncated) {
      entry.body.append(el("p", { class: "workbench-note", text: "Diff gekürzt: Weitere Änderungszeilen sind nicht enthalten." }));
    }
    return;
  }

  entry.label.textContent = block.label;
  entry.title.textContent = block.title;
  entry.input.textContent = block.input;
  entry.state.textContent = TOOL_STATES[block.state];
  entry.state.dataset.state = block.state;
  const meta: string[] = [];
  // An exit code states exactly what the process reported; zero is not a
  // verdict that tests, deployment, or the requested task succeeded.
  if (block.exitCode !== undefined) meta.push(`Exit ${block.exitCode}`);
  if (block.durationMs !== undefined && block.state !== "running") {
    meta.push(`${(block.durationMs / 1000).toFixed(1)} s`);
  }
  entry.meta.textContent = meta.join(" · ");
  const output: HTMLElement[] = [];
  if (block.lines.length > 0) {
    output.push(el("pre", { class: "workbench-output", text: block.lines.join("\n") }));
  }
  if (block.totalLines > block.lines.length) {
    output.push(el("p", {
      class: "workbench-note",
      text: `${block.totalLines} Zeilen insgesamt · ${block.lines.length} gezeigt`,
    }));
  }
  if (block.error) output.push(el("pre", { class: "workbench-output err", text: block.error }));
  if (output.length === 0) {
    output.push(el("p", { class: "workbench-note", text: "Keine Ausgabe gemeldet." }));
  }
  entry.body.replaceChildren(...output);
}

function reconcile(
  list: HTMLElement,
  entries: Map<string, Entry>,
  blocks: readonly InspectorBlock[],
  empty: HTMLElement,
): void {
  const present = new Set(blocks.map((block) => block.id));
  for (const [id, entry] of entries) {
    if (present.has(id)) continue;
    entry.node.remove();
    entries.delete(id);
  }
  if (blocks.length === 0) {
    if (empty.parentElement !== list) list.append(empty);
    return;
  }
  empty.remove();
  blocks.forEach((block, index) => {
    let entry = entries.get(block.id);
    if (!entry) {
      entry = entryFor(block);
      entries.set(block.id, entry);
    }
    updateEntry(entry, block);
    const position = list.children.item(index);
    if (position !== entry.node) list.insertBefore(entry.node, position);
  });
}

function runLabel(run: RunSummary): string {
  if (run.active) return "Agent läuft";
  switch (run.outcome) {
    case "complete": return "Agentlauf beendet";
    case "cancelled": return "Agentlauf abgebrochen";
    case "error": return "Agentlauf mit Fehler beendet";
    case "step-limit": return "Schrittlimit erreicht";
    case "cost-limit": return "Kostenlimit erreicht";
    case "unverified": return "Agentlauf nicht verifiziert";
    case null: return "Agentlauf beendet · Ergebnis nicht gemeldet";
  }
}

export function createWorkbenchPanel(handlers: WorkbenchHandlers): {
  node: HTMLElement;
  update(input: WorkbenchInput): void;
} {
  const node = el("aside", {
    class: "workbench-panel", id: "workbench-panel",
    "aria-label": "Änderungen und Ausführungen",
  });
  const close = el("button", {
    type: "button", class: "workbench-close", "aria-label": "Arbeitsstand schließen", text: "×",
  });
  close.addEventListener("click", () => handlers.close());
  const workspace = el("p", { class: "workbench-workspace mono" });
  const actions = el("div", { class: "workbench-actions" });
  const controls = ([
    ["Diff ansehen", "/diff"],
    ["Prüfen", "/verify now"],
    ["Zurücknehmen", "/undo"],
  ] as const).map(([label, command]) => {
    const control = el("button", { type: "button", text: label, disabled: true });
    control.addEventListener("click", () => {
      if (!control.disabled) handlers.command(command);
    });
    actions.append(control);
    return { control, command };
  });

  const changesList = el("div", { class: "workbench-list" });
  const toolsList = el("div", { class: "workbench-list" });
  const emptyChanges = el("p", { class: "workbench-empty", text: "Noch keine Änderungen gemeldet." });
  const emptyTools = el("p", { class: "workbench-empty", text: "Noch keine Ausführung gemeldet." });
  changesList.append(emptyChanges);
  toolsList.append(emptyTools);
  const runSlot = el("div", { class: "workbench-run-slot" });
  const runNode = el("div", { class: "workbench-run" });
  const runState = el("span", { class: "workbench-state" });
  const runModel = el("span", { class: "workbench-run-model mono" });
  runNode.append(runState, runModel);
  const changes = new Map<string, Entry>();
  const tools = new Map<string, Entry>();

  node.append(
    el("header", { class: "workbench-head" }, [el("h2", { text: "Arbeitsstand" }), close]),
    workspace,
    el("p", { class: "workbench-note", text: "Gemeldete Ereignisse dieser Sitzung · kein Live-Git-Status." }),
    actions,
    el("section", { class: "workbench-section" }, [
      el("h3", { class: "workbench-section-head", text: "Änderungen in dieser Sitzung" }), changesList,
    ]),
    el("section", { class: "workbench-section" }, [
      el("h3", { class: "workbench-section-head", text: "Ausführungen" }), runSlot, toolsList,
    ]),
  );

  return {
    node,
    update(input) {
      if (workspace.textContent !== input.workspace) workspace.textContent = input.workspace;
      for (const { control, command } of controls) {
        control.disabled = !input.ready || input.busy || (command === "/undo" && !input.undoAvailable);
      }
      // No transcript prose, planning claims, or replayed assistant text can
      // create an entry. Each card requires its actual structured event.
      reconcile(changesList, changes, input.blocks.filter((block): block is FileChange => block.kind === "file-change"), emptyChanges);
      reconcile(toolsList, tools, input.blocks.filter((block): block is Tool => block.kind === "tool"), emptyTools);
      if (input.run) {
        const state = runLabel(input.run);
        if (runState.textContent !== state) runState.textContent = state;
        if (runModel.textContent !== input.run.model) runModel.textContent = input.run.model;
        if (runNode.parentElement !== runSlot) runSlot.append(runNode);
      } else runNode.remove();
    },
  };
}
