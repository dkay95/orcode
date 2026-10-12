// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { Block, RunSummary } from "../src/chat-model.js";
import { createWorkbenchPanel } from "../src/workbench-panel.js";

type FileChange = Extract<Block, { kind: "file-change" }>;
type Tool = Extract<Block, { kind: "tool" }>;

function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    kind: "file-change", id: "change-1", at: 1, path: "src/main.ts",
    tool: "replace_text", created: false, added: 1, removed: 1,
    diff: "--- before\n+++ after\n@@ -1,1 +1,1 @@\n-old\n+new",
    truncated: false, ...overrides,
  };
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    kind: "tool", id: "tool-1", at: 2, key: "shell:1", number: 1,
    name: "shell", label: "SHELL", title: "Shell", input: "npm test",
    rawInput: { command: "npm test" }, state: "running", lines: [],
    totalLines: 0, collapsed: true, ...overrides,
  };
}

function input(blocks: readonly Block[] = [], run: RunSummary | null = null) {
  return {
    blocks, run, workspace: "/work/project", ready: true,
    busy: false, undoAvailable: true,
  };
}

function button(node: HTMLElement, label: string): HTMLButtonElement {
  const result = [...node.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function panel() {
  const commands: string[] = [];
  let closeCount = 0;
  const view = createWorkbenchPanel({
    command: (raw) => commands.push(raw),
    close: () => { closeCount++; },
  });
  document.body.append(view.node);
  return { ...view, commands, closeCount: () => closeCount };
}

afterEach(() => document.body.replaceChildren());

describe("the session workbench inspector", () => {
  it("shows explicit unknown/empty states instead of deriving changes from assistant text", () => {
    const view = panel();
    view.update(input([
      { kind: "assistant", id: "answer", at: 0, text: "All files changed; tests passed", streaming: false },
    ]));

    expect(view.node.tagName).toBe("ASIDE");
    expect(view.node.id).toBe("workbench-panel");
    expect(view.node.getAttribute("aria-label")).toBe("Änderungen und Ausführungen");
    expect(view.node.textContent).toContain("Arbeitsstand");
    expect(view.node.textContent).toContain("Änderungen in dieser Sitzung");
    expect(view.node.textContent).toContain("Noch keine Änderungen gemeldet.");
    expect(view.node.textContent).toContain("Noch keine Ausführung gemeldet.");
    expect(view.node.textContent).toContain("kein Live-Git-Status");
    expect(view.node.textContent).toContain("/work/project");
    expect(view.node.textContent).not.toContain("All files changed");
  });

  it("expands the actual event diff, counts and creation flag without parsing markup", () => {
    const view = panel();
    view.update(input([change({
      path: "src/<img src=x>.ts", created: true, added: 9, removed: 4,
      diff: "--- before\n+++ after\n@@ -1,1 +1,1 @@\n-old\n+<script>alert(1)</script>",
      truncated: true,
    })]));

    const details = view.node.querySelector<HTMLDetailsElement>("details.workbench-change")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("src/<img src=x>.ts");
    expect(details.querySelector("summary")?.textContent).toContain("+9 −4");
    expect(details.textContent).toContain("Neu angelegt");
    details.open = true;
    expect(details.querySelector(".diff-text")?.textContent).toBe("old");
    expect(details.textContent).toContain("<script>alert(1)</script>");
    expect(details.textContent).toContain("replace_text");
    expect(details.textContent).toContain("more changed lines not shown");
    expect(view.node.querySelector("img, script, textarea, [contenteditable]")).toBeNull();
  });

  it("retains separate reported changes even when their file path is the same", () => {
    const view = panel();
    view.update(input([change(), change({ id: "change-2", added: 3, removed: 0 })]));
    expect(view.node.querySelectorAll(".workbench-change")).toHaveLength(2);
    expect(view.node.querySelector(".workbench-change[data-block='change-2']")?.textContent).toContain("+3 −0");
  });

  it.each([
    ["running", "Läuft"],
    ["ok", "Abgeschlossen"],
    ["failed", "Fehlgeschlagen"],
    ["cancelled", "Abgebrochen"],
    ["unverified", "Nicht verifiziert"],
  ] as const)("reports the tool's %s state without declaring tests passed", (state, label) => {
    const view = panel();
    view.update(input([tool({ state, exitCode: state === "ok" ? 0 : undefined })]));
    const entry = view.node.querySelector(".workbench-tool")!;
    expect(entry.textContent).toContain("SHELL");
    expect(entry.textContent).toContain("npm test");
    expect(entry.querySelector(".workbench-state")?.textContent).toBe(label);
    if (state === "ok") expect(entry.textContent).toContain("Exit 0");
    expect(entry.textContent).not.toMatch(/bestanden|Tests erfolgreich|Tests passed/i);
  });

  it("keeps errors and the reported output-tail limit visible and escaped", () => {
    const view = panel();
    view.update(input([tool({
      state: "failed", exitCode: 2, lines: ["<img src=x>", "tail"],
      totalLines: 25, error: "<script>failure</script>",
    })]));
    const entry = view.node.querySelector<HTMLDetailsElement>(".workbench-tool")!;
    entry.open = true;
    expect(entry.querySelector("pre")?.textContent).toBe("<img src=x>\ntail");
    expect(entry.textContent).toContain("25 Zeilen insgesamt · 2 gezeigt");
    expect(entry.textContent).toContain("<script>failure</script>");
    expect(entry.textContent).toContain("Exit 2");
    expect(entry.querySelector("img, script")).toBeNull();
  });

  it("routes enabled actions through exact commands and closes through its own handler", () => {
    const view = panel();
    view.update(input());
    button(view.node, "Diff ansehen").click();
    button(view.node, "Prüfen").click();
    button(view.node, "Zurücknehmen").click();
    view.node.querySelector<HTMLButtonElement>("button[aria-label='Arbeitsstand schließen']")!.click();
    expect(view.commands).toEqual(["/diff", "/verify now", "/undo"]);
    expect(view.closeCount()).toBe(1);
  });

  it.each([
    { ready: false, busy: false, undoAvailable: true },
    { ready: true, busy: true, undoAvailable: true },
  ])("prevents commands while unavailable: %j", (state) => {
    const view = panel();
    view.update({ ...input(), ...state });
    for (const label of ["Diff ansehen", "Prüfen", "Zurücknehmen"]) {
      const action = button(view.node, label);
      expect(action.disabled).toBe(true);
      action.click();
      action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(view.commands).toEqual([]);
  });

  it("disables only Undo when the engine reports no undoable run", () => {
    const view = panel();
    view.update({ ...input(), undoAvailable: false });
    expect(button(view.node, "Diff ansehen").disabled).toBe(false);
    expect(button(view.node, "Prüfen").disabled).toBe(false);
    expect(button(view.node, "Zurücknehmen").disabled).toBe(true);
    button(view.node, "Zurücknehmen").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.commands).toEqual([]);
  });

  it("preserves opened change details and focused summary through assistant streaming and unrelated tool events", () => {
    const view = panel();
    const file = change();
    view.update(input([file]));
    const details = view.node.querySelector<HTMLDetailsElement>(".workbench-change")!;
    const summary = details.querySelector("summary")!;
    details.open = true;
    summary.focus();

    view.update(input([
      file,
      { kind: "assistant", id: "stream", at: 3, text: "One streamed delta", streaming: true },
    ]));
    view.update(input([file, tool()]));
    expect(view.node.querySelector(".workbench-change")).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
  });

  it("refreshes same-length mutable event data without replacing the opened card", () => {
    const view = panel();
    const file = change();
    const execution = tool({ lines: ["start"], totalLines: 1 });
    view.update(input([file, execution]));
    const fileDetails = view.node.querySelector<HTMLDetailsElement>(".workbench-change")!;
    const toolDetails = view.node.querySelector<HTMLDetailsElement>(".workbench-tool")!;
    toolDetails.open = true;
    fileDetails.open = true;
    file.diff = file.diff.replace("+new", "+end");
    execution.lines[0] = "ended";
    execution.state = "unverified";
    view.update(input([file, execution]));
    expect(view.node.querySelector(".workbench-change")).toBe(fileDetails);
    expect(fileDetails.open).toBe(true);
    expect(fileDetails.textContent).toContain("end");
    expect(view.node.querySelector(".workbench-tool")).toBe(toolDetails);
    expect(toolDetails.open).toBe(true);
    expect(toolDetails.querySelector("pre")?.textContent).toBe("ended");
    expect(toolDetails.textContent).toContain("Nicht verifiziert");
  });

  it("reports the actual run outcome without fabricating an implementation plan or verification result", () => {
    const view = panel();
    const run: RunSummary = {
      active: false, model: "provider/model", maxSteps: 8, step: 2,
      costUsd: 0, costKnowledge: "unknown", toolCount: 1,
      startedAt: 1, outcome: "cancelled",
    };
    view.update(input([], run));
    expect(view.node.querySelector(".workbench-run")?.textContent).toContain("Agentlauf abgebrochen");
    expect(view.node.querySelector(".workbench-run")?.textContent).toContain("provider/model");
    expect(view.node.textContent).not.toMatch(/Plan|Tests bestanden|Git sauber/);
    run.active = true;
    run.outcome = null;
    view.update(input([], run));
    expect(view.node.querySelector(".workbench-run")?.textContent).toContain("Agent läuft");
  });

  it("clears old event details and run state when the chat replaces its transcript", () => {
    const view = panel();
    view.update(input([change(), tool()]));
    view.update(input());
    expect(view.node.querySelector(".workbench-change, .workbench-tool, .workbench-run")).toBeNull();
    expect(view.node.textContent).toContain("Noch keine Änderungen gemeldet.");
    expect(view.node.textContent).toContain("Noch keine Ausführung gemeldet.");
    expect(view.node.textContent).not.toContain("src/main.ts");
  });
});
