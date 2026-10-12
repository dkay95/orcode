/**
 * Run → blocks (Bauplan K2).
 *
 * Everything the UI knows about a tool comes from `toolMetadata(name)`; no
 * tool name and no output field name is spelled out here a second time.
 */

import type { PanelJudgment, PanelResult } from "../panel.js";
import type { AgentRunEvent, NoticeKind, ToolRisk } from "../types.js";
import {
  classifyToolOutcome,
  estimateReasoningTokens,
  outputLines,
  selectTail,
  textLines,
} from "../utils.js";
import { toolMetadata, type TextDiff } from "../workspace.js";
import {
  REASONING_MAX_LINES,
  RUNNING_TAIL_LINES,
  TAIL_CAPACITY,
  type BlockState,
  type ChatBlock,
} from "./blocks.js";
import { parseUnifiedDiff, splitHunks, type DiffHunkView } from "./diff-view.js";

/**
 * How many hunks a diff ever puts on screen — the approval preview's own
 * long-standing cap, now shared with the applied-edit block (FIX-3) so both
 * halves of the same change are cut at exactly the same place.
 */
const MAX_DIFF_HUNKS = 3;

/**
 * G3 (the G2 debt list): `selectTail`, `outputLines` and the reasoning-token
 * estimate moved to `utils.ts` — the one module with no imports, so the
 * desktop window applies the identical rules instead of its own. Re-exported
 * so every existing importer of this file is unchanged.
 */
export { selectTail } from "../utils.js";

/**
 * The grading rule moved to `utils.ts` (G2 fix round 1) so the desktop
 * window applies the identical one — it had forked, and defaulted a
 * finished `write_file` to "done" where this said "unverified". Same
 * behaviour here, one definition.
 */
const outcomeOf = classifyToolOutcome;

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

  /**
   * True while the model is actively streaming reasoning for the current
   * step (Phase 3b, Part C: the state `esc` branches on — end thinking vs.
   * abort the run). Mirrors the `model-end` handler below, which is the sole
   * place `live` flips back to false.
   */
  get reasoningLive(): boolean {
    const current = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
    return current?.kind === "reasoning" && current.live === true;
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
    // Audit FIX-1: "approval" joined the toggleable kinds — Ctrl+O inside
    // confirm mode expands a truncated approval's full detail so the
    // "Ctrl+O shows all" hint it renders is actually true.
    if (block.kind === "tool" || block.kind === "reasoning" || block.kind === "approval") {
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

  /**
   * A mid-run interjection (Phase 3b, Part B): a "user" block flagged for the
   * `↪` glyph + acceptance footer, deliberately NOT clearing `#assistantId`/
   * `#reasoningId` — the run this interjects into keeps streaming into its
   * existing assistant/reasoning blocks right after this one.
   */
  pushInterjection(text: string, at = Date.now()): ChatBlock {
    return this.#push({
      kind: "user",
      id: this.#id("interjection"),
      at,
      text,
      attachmentCount: 0,
      interjected: true,
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

  /**
   * D3 (owner design batch, calm-chrome principle): a notice identical to
   * the one immediately before it — same title and cause, the observable
   * content a human would compare — collapses into that block instead of
   * appending a new one: its repeat counter increments and its timestamp
   * moves to this latest occurrence, so the transcript shows one line with
   * a muted `× N` suffix instead of N stacked duplicates. Only ever compares
   * against the LAST block, and only when that block is itself a notice —
   * a different block kind or an intervening line always starts a fresh
   * streak. Persisted session history is untouched by this (nothing here
   * writes to `SessionStore`); it is a purely render-layer behavior.
   */
  pushNotice(
    // FIX-14 ticket 5: the shared vocabulary, narrowed to what a transcript
    // block can mean (see `ChatBlock`'s `notice` variant, blocks.ts).
    level: Exclude<NoticeKind, "busy" | "success">,
    title: string,
    cause: string[] = [],
    at = Date.now(),
  ): ChatBlock {
    this.#assistantId = null;
    const last = this.#blocks[this.#blocks.length - 1];
    if (
      last
      && last.kind === "notice"
      && last.title === title
      && last.cause.length === cause.length
      && last.cause.every((line, index) => line === cause[index])
    ) {
      last.repeatCount = (last.repeatCount ?? 1) + 1;
      last.at = at;
      return last;
    }
    return this.#push({
      kind: "notice",
      id: this.#id("notice"),
      at,
      level,
      title,
      cause,
    });
  }

  pushDiff(
    path: string,
    diff: TextDiff,
    options: { state?: BlockState; undoable?: boolean; maxHunks?: number; at?: number } = {},
  ): ChatBlock {
    const hunks = splitHunks(diff.lines);
    const maxHunks = options.maxHunks ?? MAX_DIFF_HUNKS;
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
      // Size honesty: `diff.added`/`diff.removed` above are the whole file's
      // counts, but `diff.lines` itself already stops at the differ's
      // changed-line budget. The block says so instead of letting the last
      // shown hunk pass for the end of the change.
      truncated: diff.truncated,
      state: options.state ?? "unverified",
      undoable: options.undoable ?? false,
    });
  }

  pushApproval(input: ApprovalInput): ChatBlock {
    const at = input.at ?? Date.now();
    let diff: DiffHunkView[] | undefined;
    if (input.diff) {
      diff = splitHunks(input.diff.lines).slice(0, MAX_DIFF_HUNKS);
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
      expanded: false,
    };
    if (diff) block.diff = diff;
    return this.#push(block);
  }

  /**
   * Pushes a `/panel` result as its own block instead of the generic notice
   * text `addMessage` would otherwise produce (see `CommandContext.onPanelResult`
   * in commands.ts). Every call — including a later `/panel show <n>` for the
   * same result — appends a fresh block, exactly like `pushDiff`/`pushNotice`
   * already do; nothing here is mutated in place.
   */
  pushPanel(
    result: PanelResult,
    judgment: PanelJudgment | null,
    expandedIndex: number | null,
    at = Date.now(),
  ): ChatBlock {
    this.#assistantId = null;
    return this.#push({
      kind: "panel",
      id: this.#id("panel"),
      at,
      result,
      judgment,
      expandedIndex,
    });
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
        // Fix round 1, Critical 2: a new model phase — including the
        // continuation `esc`-during-thinking starts after ending the
        // previous phase's thinking — supersedes any reasoning block still
        // marked live from an earlier, now-abandoned call. That call's own
        // "model-end" never fires when the request was aborted mid-stream
        // rather than completed, so without this, `live` (and hence
        // `reasoningLive`) would stay stuck true forever: the "Thinking …
        // Ns" header would keep ticking through the continuation, and a
        // second `esc` would wrongly re-arm end-thinking instead of
        // routing to run-abort (src/tui.ts's state-dependent esc split).
        // In the normal (non-aborted) multi-round flow this is a no-op:
        // each round's own "model-end" already clears `#reasoningId` before
        // the next round's "model-start" ever fires.
        const stale = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
        if (stale && stale.kind === "reasoning") {
          stale.live = false;
        }
        this.#reasoningId = null;
        return;
      }
      case "model-end": {
        const reasoning = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
        if (reasoning && reasoning.kind === "reasoning") {
          reasoning.live = false;
          // Prefer the provider's real count; some providers report 0 even
          // though tokens were spent, and dropping back to 0 after showing a
          // sensible estimate would look like the panel lost its content.
          if (event.reasoningTokens > 0) {
            reasoning.tokens = event.reasoningTokens;
            reasoning.estimated = false;
          }
        }
        this.#reasoningId = null;
        return;
      }
      case "reasoning": {
        const current = this.#reasoningId ? this.#index.get(this.#reasoningId) : undefined;
        if (current && current.kind === "reasoning") {
          current.text += event.delta;
          current.truncated = current.text.length > 4000;
          // The real count only arrives with `model-end`, i.e. after the
          // thinking is over. Without an estimate the header would read
          // "0 Tokens" for the entire time the panel is actually live.
          current.tokens = estimateReasoningTokens(current.text);
          current.estimated = true;
          return;
        }
        const block = this.#push({
          kind: "reasoning" as const,
          id: this.#id("reasoning"),
          at: event.timestamp,
          text: event.delta,
          tokens: estimateReasoningTokens(event.delta),
          estimated: true,
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
        // Keyboard-audit addendum: a failed block keeps as many lines as an
        // EXPANDED block can draw (`REASONING_MAX_LINES`, render-block's own
        // limit), not just the three the collapsed form shows. Without this,
        // expanding revealed nothing — the extra lines had already been
        // thrown away — which is what made its `N more lines` hint hollow.
        // The collapsed rendering is untouched: it slices the same first
        // three lines off the front of this list.
        block.tail = selectTail(lines, failed, failed ? REASONING_MAX_LINES : 1);
        const summary = meta.summarizeOutput(event.output);
        if (summary) block.input = `${block.input} — ${summary}`;
        this.#tools.delete(event.id);
        return;
      }
      case "file-change": {
        // FIX-3, the audit's Critical: in auto-edit/allow-all the owner never
        // saw WHAT changed. The diff block is that record, and it renders in
        // every approval mode — ask included, where the pre-execution preview
        // lived in an approval block the transcript deletes again the moment
        // it is answered (`dropApproval`), so nothing double-prints.
        //
        // `parseUnifiedDiff` is the same reader `/diff` uses; the counts come
        // from the event, because the parser can only count the lines that
        // survived the differ's budget while the event carries the file's real
        // `+N/-M`.
        const parsed = parseUnifiedDiff(event.diff);
        this.pushDiff(
          event.path,
          {
            ...parsed,
            added: event.added,
            removed: event.removed,
            truncated: event.truncated,
          },
          { undoable: true, at: event.timestamp },
        );
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
        // Same reason as `tool-end` above: keep what an expanded block can draw.
        block.tail = selectTail(lines, true, REASONING_MAX_LINES);
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
          title: "Verification run",
          input: `${event.command} — Round ${event.round}`,
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
        this.pushNotice(event.level, event.message, cause, event.timestamp);
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
