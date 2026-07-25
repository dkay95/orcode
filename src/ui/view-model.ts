/**
 * Run → blocks (Bauplan K2).
 *
 * Everything the UI knows about a tool comes from `toolMetadata(name)`; no
 * tool name and no output field name is spelled out here a second time.
 */

import type { AgentRunEvent, ToolRisk } from "../types.js";
import { toolMetadata, type TextDiff } from "../workspace.js";
import {
  RUNNING_TAIL_LINES,
  TAIL_CAPACITY,
  type BlockState,
  type ChatBlock,
} from "./blocks.js";
import { splitHunks, type DiffHunkView } from "./diff-view.js";

const ERROR_LINE = /(^|\s)(error|ERROR|FAIL|Fail|✗|panic|Traceback|error TS\d+)/;

function textLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((item) => item.replace(/\s+$/, ""))
    .filter((item) => item.trim().length > 0);
}

/**
 * Which lines survive in a collapsed block: on failure the first lines that
 * look like the actual error, on success the last ones.
 */
export function selectTail(lines: readonly string[], failed: boolean, keep: number): string[] {
  if (lines.length <= keep) return [...lines];
  if (failed) {
    const hits = lines.filter((item) => ERROR_LINE.test(item));
    if (hits.length > 0) return hits.slice(0, keep);
    return lines.slice(0, keep);
  }
  return lines.slice(-keep);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `✓` only when a process exited with 0. Everything else that merely worked
 * gets `~` (unverified) — Bauplan 2.5.
 */
function outcomeOf(output: unknown): { state: BlockState; exitCode?: number } {
  const data = asRecord(output);
  const exitCode = data && typeof data.exitCode === "number" ? data.exitCode : undefined;
  if (exitCode === undefined) return { state: "unverified" };
  return { state: exitCode === 0 ? "ok" : "failed", exitCode };
}

function outputLines(output: unknown): string[] {
  const data = asRecord(output);
  if (!data) return [];
  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "diff", "content", "matches"] as const) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(...textLines(value));
    }
  }
  return parts;
}

export interface ApprovalInput {
  id?: string;
  risk: ToolRisk;
  summary: string;
  details?: string[];
  diff?: TextDiff;
  rememberHint?: string;
  at?: number;
}

export class RunViewModel {
  #blocks: ChatBlock[] = [];
  #index = new Map<string, ChatBlock>();
  #tools = new Map<string, string>();
  #buffers = new Map<string, string[]>();
  #assistantId: string | null = null;
  #reasoningId: string | null = null;
  #sequence = 0;
  #step = 0;

  get blocks(): readonly ChatBlock[] {
    return this.#blocks;
  }

  get step(): number {
    return this.#step;
  }

  /** Id of the one block that may show a spinner (R7). */
  get activeSpinnerId(): string | null {
    for (let index = this.#blocks.length - 1; index >= 0; index -= 1) {
      const block = this.#blocks[index]!;
      if (block.kind === "tool" && block.state === "running") return block.id;
      if (block.kind === "reasoning" && block.live) return block.id;
    }
    return null;
  }

  find(id: string): ChatBlock | undefined {
    return this.#index.get(id);
  }

  clear(): void {
    this.#blocks = [];
    this.#index.clear();
    this.#tools.clear();
    this.#buffers.clear();
    this.#assistantId = null;
    this.#reasoningId = null;
    this.#step = 0;
  }

  toggle(id: string): boolean {
    const block = this.#index.get(id);
    if (!block) return false;
    if (block.kind === "tool" || block.kind === "reasoning") {
      block.expanded = !block.expanded;
      return true;
    }
    return false;
  }

  #push(block: ChatBlock): ChatBlock {
    this.#blocks.push(block);
    this.#index.set(block.id, block);
    return block;
  }

  #id(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  pushUser(text: string, attachmentCount = 0, at = Date.now()): ChatBlock {
    this.#assistantId = null;
    this.#reasoningId = null;
    return this.#push({
      kind: "user",
      id: this.#id("user"),
      at,
      text,
      attachmentCount,
    });
  }

  appendAssistant(delta: string, at = Date.now()): ChatBlock {
    const current = this.#assistantId ? this.#index.get(this.#assistantId) : undefined;
    if (current && current.kind === "assistant") {
      current.text += delta;
      return current;
    }
    const block = this.#push({
      kind: "assistant" as const,
      id: this.#id("assistant"),
      at,
      text: delta,
    });
    this.#assistantId = block.id;
    return block;
  }

  finishAssistant(costUsd?: number): void {
    const current = this.#assistantId ? this.#index.get(this.#assistantId) : undefined;
    if (current && current.kind === "assistant" && costUsd !== undefined) {
      current.costUsd = costUsd;
    }
    this.#assistantId = null;
  }

  pushNotice(
    level: "info" | "warn" | "error",
    title: string,
    cause: string[] = [],
    actions: Array<{ key: string; label: string }> = [],
    at = Date.now(),
  ): ChatBlock {
    this.#assistantId = null;
    return this.#push({
      kind: "notice",
      id: this.#id("notice"),
      at,
      level,
      title,
      cause,
      actions,
    });
  }

  pushDiff(
    path: string,
    diff: TextDiff,
    options: { state?: BlockState; undoable?: boolean; maxHunks?: number; at?: number } = {},
  ): ChatBlock {
    const hunks = splitHunks(diff.lines);
    const maxHunks = options.maxHunks ?? 3;
    this.#assistantId = null;
    return this.#push({
      kind: "diff",
      id: this.#id("diff"),
      at: options.at ?? Date.now(),
      path,
      added: diff.added,
      removed: diff.removed,
      hunks: hunks.slice(0, maxHunks),
      hiddenHunks: Math.max(0, hunks.length - maxHunks),
      state: options.state ?? "unverified",
      undoable: options.undoable ?? false,
    });
  }

  pushApproval(input: ApprovalInput): ChatBlock {
    const at = input.at ?? Date.now();
    let diff: DiffHunkView[] | undefined;
    if (input.diff) {
      diff = splitHunks(input.diff.lines).slice(0, 3);
    }
    this.#assistantId = null;
    const block: ChatBlock = {
      kind: "approval",
      id: input.id ?? this.#id("approval"),
      at,
      risk: input.risk,
      summary: input.summary,
      details: input.details ?? [],
      waitingSince: at,
      rememberHint: input.rememberHint ?? "",
    };
    if (diff) block.diff = diff;
    return this.#push(block);
  }

  /** Removes a pending approval block once it has been answered. */
  dropApproval(id: string): boolean {
    const block = this.#index.get(id);
    if (!block || block.kind !== "approval") return false;
    this.#blocks = this.#blocks.filter((item) => item.id !== id);
    this.#index.delete(id);
    return true;
  }

  apply(event: AgentRunEvent): void {
    switch (event.type) {
      case "run-start": {
        this.#step = 0;
        return;
      }
      case "model-start": {
        this.#step = event.step;
        return;
      }
      case "model-end": {
        const reasoning = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
        if (reasoning && reasoning.kind === "reasoning") {
          reasoning.live = false;
          reasoning.tokens = event.reasoningTokens;
        }
        this.#reasoningId = null;
        return;
      }
      case "reasoning": {
        const current = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
        if (current && current.kind === "reasoning") {
          current.text += event.delta;
          current.truncated = current.text.length > 4000;
          return;
        }
        const block = this.#push({
          kind: "reasoning" as const,
          id: this.#id("reasoning"),
          at: event.timestamp,
          text: event.delta,
          tokens: 0,
          live: true,
          expanded: false,
          truncated: false,
        });
        this.#reasoningId = block.id;
        this.#assistantId = null;
        return;
      }
      case "tool-start": {
        const meta = toolMetadata(event.name);
        const id = this.#id("tool");
        this.#tools.set(event.id, id);
        this.#buffers.set(id, []);
        this.#assistantId = null;
        this.#push({
          kind: "tool",
          id,
          at: event.timestamp,
          tool: event.name,
          label: meta.label,
          title: meta.title,
          input: meta.summarizeInput(event.input),
          state: "running",
          tail: [],
          totalLines: 0,
          step: this.#step,
          expanded: false,
        });
        return;
      }
      case "tool-output": {
        const id = this.#tools.get(event.id);
        if (!id) return;
        const block = this.#index.get(id);
        if (!block || block.kind !== "tool") return;
        const buffer = this.#buffers.get(id) ?? [];
        buffer.push(...textLines(event.text));
        while (buffer.length > TAIL_CAPACITY) buffer.shift();
        this.#buffers.set(id, buffer);
        block.totalLines += textLines(event.text).length;
        block.tail = buffer.slice(-RUNNING_TAIL_LINES);
        return;
      }
      case "tool-end": {
        const id = this.#tools.get(event.id);
        const block = id ? this.#index.get(id) : undefined;
        if (!block || block.kind !== "tool") return;
        const meta = toolMetadata(event.name);
        const outcome = outcomeOf(event.output);
        const buffer = this.#buffers.get(block.id) ?? [];
        const lines = buffer.length > 0 ? buffer : outputLines(event.output);
        const failed = outcome.state === "failed";
        block.state = outcome.state;
        if (outcome.exitCode !== undefined) block.exitCode = outcome.exitCode;
        block.durationMs = event.durationMs;
        block.totalLines = Math.max(block.totalLines, lines.length);
        block.tail = selectTail(lines, failed, failed ? RUNNING_TAIL_LINES : 1);
        const summary = meta.summarizeOutput(event.output);
        if (summary) block.input = `${block.input} — ${summary}`;
        this.#tools.delete(event.id);
        return;
      }
      case "tool-error": {
        const id = this.#tools.get(event.id);
        const block = id ? this.#index.get(id) : undefined;
        if (!block || block.kind !== "tool") return;
        const lines = textLines(event.error);
        block.state = "failed";
        block.durationMs = event.durationMs;
        block.totalLines = Math.max(block.totalLines, lines.length);
        block.tail = selectTail(lines, true, RUNNING_TAIL_LINES);
        this.#tools.delete(event.id);
        return;
      }
      case "verify": {
        const failed = event.exitCode !== 0;
        this.#push({
          kind: "tool",
          id: this.#id("verify"),
          at: event.timestamp,
          tool: "verify",
          label: "VERIFY",
          title: "Prüflauf",
          input: `${event.command} — Runde ${event.round}`,
          state: failed ? "failed" : "ok",
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          tail: [],
          totalLines: 0,
          step: this.#step,
          expanded: false,
        });
        this.#assistantId = null;
        return;
      }
      case "notice": {
        const cause = event.hint ? [event.hint] : [];
        this.pushNotice(event.level, event.message, cause, event.actions ?? [], event.timestamp);
        return;
      }
      case "run-end": {
        for (const block of this.#blocks) {
          if (block.kind === "tool" && block.state === "running") {
            block.state = event.outcome === "cancelled" ? "cancelled" : "unverified";
          }
          if (block.kind === "reasoning" && block.live) {
            block.live = false;
          }
        }
        this.#tools.clear();
        this.#reasoningId = null;
        this.#assistantId = null;
        return;
      }
      default:
        return;
    }
  }
}
