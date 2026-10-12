/**
 * Frames in, blocks out. No decisions, no re-derivation, no wording of its
 * own for anything the engine already said.
 *
 * The run stream crosses the wire as `AgentRunEvent` 1:1, so this is the
 * same reduction the TUI performs in `src/ui/view-model.ts` — and it keeps
 * that file's load-bearing rules rather than inventing softer ones:
 *
 *  * a tool still running when the run ends becomes `cancelled` or
 *    `unverified`, NEVER `ok` (`view-model.ts`'s `run-end` case);
 *  * `text` run events are not rendered here — the answer arrives through
 *    the `assistant` event, and rendering both would print it twice;
 *  * process events bind to their tool block through `toolId`, and an
 *    unbound process gets a block of its own (`tui.ts`'s
 *    `#applyProcessEvent`);
 *  * reasoning is a collapsed block by default. P15's shape is answer
 *    first, the thinking available but never in the way;
 *  * the ANSWER is one block per run, and the block is opened by the first
 *    delta rather than by `assistant/begin` — `tui.ts`'s
 *    `beginAssistant`/`appendAssistant`/`finishAssistant` trio. The whole
 *    reconciliation lives in `#streamedChars`: the run's own fallback text
 *    is adopted only when the run streamed NOTHING, which is the one rule
 *    that survives `reasoning`, `tool-start` and `run-end` all clearing
 *    `#assistantId` between the deltas and the end frame;
 *  * a run states its outcome ONCE, and the sentence is the engine's
 *    (`runFooter`, which crosses as a `system` transcript line). The
 *    terminal has no run-end block either: `view-model.ts`'s `run-end` case
 *    settles the open blocks and pushes nothing.
 */

// The two classifications that decide what a person is told happened are
// imported, not re-typed: a cancelled run is never "complete", and a tool
// that reported no exit code is unverified rather than done. Both surfaces
// have to say that with the same words or the difference is itself a
// finding — and a copy of the second one had already forked.
import {
  REASONING_MAX_LINES,
  TAIL_CAPACITY,
  classifyToolOutcome,
  outputLines,
  selectTail,
  textLines,
  type ToolBlockState,
} from "@core/utils";
// The presentation half of the tool layer — the badge, the title, and the
// one-line summaries. It used to be unreachable from here (it lived in
// `workspace.ts`, which reaches into node), which is why this window printed
// a raw tool name and a three-key argument dump while the terminal printed
// `SHELL · npm test`. One table now, both surfaces (G2's largest named gap).
import { toolMetadata } from "@core/tool-metadata";

import type {
  ChatOpened,
  ChatTurn,
  CrossPanel,
  EventFrame,
  RunEventBase,
  RunOutcome,
} from "./protocol.js";

/** The stream's five states, from the module both surfaces share. */
export type BlockState = ToolBlockState;

export type Block =
  | { kind: "user"; id: string; at: number; text: string; interjected: boolean }
  | {
      kind: "system";
      id: string;
      at: number;
      text: string;
      meta?: string;
      /** `error` when the wire said the role was `error`, never inferred. */
      level?: "error";
      /**
       * Set on the ONE line that concludes a run — see `#footerPending`. It
       * carries the run's outcome so the footer's dot can repeat in colour
       * what the sentence already says in words; it adds no fact of its own,
       * and the text is the engine's `runFooter` unchanged.
       */
      footer?: RunOutcome;
    }
  | { kind: "assistant"; id: string; at: number; text: string; streaming: boolean; model?: string }
  | { kind: "reasoning"; id: string; at: number; text: string; live: boolean; collapsed: boolean }
  | {
      kind: "tool";
      id: string;
      at: number;
      key: string;
      number: number;
      /** The tool's own name, as the model called it. */
      name: string;
      /** `SHELL`, `READ`, `WRITE` … — `toolMetadata`'s badge. */
      label: string;
      /** The tool's display name. */
      title: string;
      /** `toolMetadata.summarizeInput` — never a re-reading of the raw input. */
      input: string;
      /** The raw call arguments, kept so nothing is invented from a summary. */
      rawInput: Record<string, unknown>;
      state: BlockState;
      lines: string[];
      totalLines: number;
      collapsed: boolean;
      durationMs?: number;
      exitCode?: number;
      error?: string;
    }
  | {
      kind: "file-change";
      id: string;
      at: number;
      path: string;
      tool: string;
      created: boolean;
      added: number;
      removed: number;
      diff: string;
      truncated: boolean;
    }
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string; hint?: string }
  | { kind: "command-output"; id: string; at: number; raw: string; level: string; lines: string[] };

export interface RunSummary {
  active: boolean;
  model: string;
  maxSteps: number;
  step: number;
  /** Accumulated from `model-end`. `unknown` is sticky, and it is not zero. */
  costUsd: number;
  costKnowledge: "known" | "unknown";
  toolCount: number;
  startedAt: number;
  outcome: RunOutcome | null;
}

export interface StatusLine {
  text: string;
  busy: boolean;
}

/**
 * No line buffer here on purpose: the engine already holds a partial line
 * back (`GuiOutputBatcher({holdPartialLine: true})`, `gui-server.ts`), so
 * every `process-output` frame that arrives ends on a line boundary and a
 * second buffer on this side would only add latency.
 */
interface ProcessBinding {
  blockKey: string;
  bound: boolean;
}

export class ChatModel {
  blocks: Block[] = [];
  run: RunSummary | null = null;
  status: StatusLine = { text: "", busy: false };
  suggestions: readonly string[] = [];
  contextPercent: number | null = null;
  attachments: readonly { name: string; mimeType: string; sizeBytes: number }[] = [];
  draft: { text: string; reason: string } | null = null;
  chat: { chatId: string; title: string; workspace: string; turnCount: number } | null = null;
  /** The last re-root, so a hub row can say the folder moved (never silent). */
  lastOpened: ChatOpened | null = null;
  /** The live Cross panel, or null when the engine says there is none. */
  cross: CrossPanel | null = null;

  #sequence = 0;
  #tools = new Map<string, string>();
  #processes = new Map<string, ProcessBinding>();
  #assistantId: string | null = null;
  #reasoningId: string | null = null;
  /**
   * How many characters THIS run streamed — `tui.ts`'s `#assistantChars`.
   *
   * It is the reconciliation key, and it is deliberately not "is a block
   * open right now": `reasoning`, `tool-start`, `file-change` and `run-end`
   * all clear `#assistantId` mid-run, so by the time `assistant/end` lands
   * there is no open block to compare against. Counting what crossed is the
   * only question that still has the right answer then — and the answer
   * decides whether the end frame's `text` is a fallback (adopt it) or the
   * run's own text coming back a second time (ignore it).
   */
  #streamedChars = 0;
  /** The model `assistant/begin` named, for the block the first delta opens. */
  #streamModel: string | undefined;
  /**
   * True from `run-end` until the run's concluding line has been seen.
   *
   * `run-session.ts` writes that line itself, as the transcript message
   * immediately after the run resolves: the success path pushes
   * `deps.runFooter(result, config)`, the failure path pushes the cancel
   * sentence (or the engine's description of the error). Both are un-`meta`'d,
   * and both are the run stating its outcome. This flag is the ONLY thing
   * that decides which line that is — nothing here reads or reformats the
   * sentence, and a run whose engine sends none simply has no footer.
   */
  #footerPending = false;

  get runActive(): boolean {
    return this.run?.active === true;
  }

  /**
   * True while a reasoning block is still streaming.
   *
   * The dashboard's Esc is state-dependent — it ends the thinking while the
   * model is thinking and aborts the run otherwise (`tui.ts`'s esc split) —
   * and this is the state it splits on.
   */
  get reasoningLive(): boolean {
    return this.blocks.some((block) => block.kind === "reasoning" && block.live);
  }

  /** Drops every block. Used when the wire says the transcript was replaced. */
  reset(): void {
    this.blocks = [];
    // A replaced transcript is a replaced run: a panel about the old one would
    // be describing a run this chat no longer shows.
    this.cross = null;
    this.#tools.clear();
    this.#processes.clear();
    this.#assistantId = null;
    this.#reasoningId = null;
    this.#streamedChars = 0;
    this.#streamModel = undefined;
    this.#footerPending = false;
    this.run = null;
  }

  loadTurns(turns: readonly ChatTurn[]): void {
    this.reset();
    for (const turn of turns) {
      const content = typeof turn.content === "string" ? turn.content : "";
      if (!content.trim()) continue;
      if (turn.role === "assistant") {
        // `tui.ts`'s `loadTurns`: append, then finish — one settled block
        // per stored turn, through the same pair a live run uses.
        this.#appendAssistant(content, 0);
        this.#finishAssistant();
      } else if (turn.role === "user") {
        this.#push({ kind: "user", id: this.#id("user"), at: 0, text: content, interjected: false });
      } else {
        this.#push({ kind: "system", id: this.#id("system"), at: 0, text: content });
      }
    }
  }

  apply(frame: EventFrame): void {
    switch (frame.e) {
      case "transcript":
        return this.#applyTranscript(frame);
      case "assistant":
        return this.#applyAssistant(frame);
      case "run":
        return this.#applyRun(frame);
      case "status": {
        this.status = {
          text: typeof frame.text === "string" ? frame.text : "",
          busy: frame.busy === true,
        };
        return;
      }
      case "suggestions": {
        this.suggestions = Array.isArray(frame.replies) ? (frame.replies as string[]) : [];
        return;
      }
      case "context-percent": {
        this.contextPercent = typeof frame.percent === "number" ? frame.percent : null;
        return;
      }
      case "attachments": {
        this.attachments = Array.isArray(frame.files)
          ? (frame.files as { name: string; mimeType: string; sizeBytes: number }[])
          : [];
        return;
      }
      case "draft": {
        this.draft = {
          text: typeof frame.text === "string" ? frame.text : "",
          reason: typeof frame.reason === "string" ? frame.reason : "insert",
        };
        return;
      }
      case "command-output": {
        const lines = Array.isArray(frame.lines) ? (frame.lines as string[]) : [];
        this.#push({
          kind: "command-output",
          id: this.#id("command"),
          at: Date.now(),
          raw: typeof frame.raw === "string" ? frame.raw : "",
          level: typeof frame.level === "string" ? frame.level : "text",
          lines,
        });
        return;
      }
      case "cross": {
        // The engine decides whether there is a panel at all — the dashboard's
        // own rule (a sequence past zero AND an active phase). A client that
        // re-derived visibility would be the second implementation of a rule
        // that already exists.
        this.cross = (frame.state as CrossPanel | null) ?? null;
        return;
      }
      case "notice": {
        this.#pushNotice(
          frame.kind === "error" ? "error" : frame.kind === "warn" ? "warn" : "info",
          typeof frame.message === "string" ? frame.message : "",
        );
        return;
      }
      case "setup.present": {
        // FIX-18, exactly as the terminal applies it: a SETTLED outcome — a
        // success, a named failure with its reason, an explicit cancel —
        // renders DURABLY, because the surface that shows it is about to be
        // replaced by the next prompt. The "Kimi Code can only be set up here
        // in the terminal, on your own machine." refusal is one of these, and
        // a window that swallowed it would make a real refusal look like
        // nothing happening.
        //
        // Everything else is not dropped, it is routed the way the terminal
        // routes it: a `busy` line and a pre-prompt disclosure both belong to
        // the prompt they precede, so they ride the status line (the engine
        // emits it) and the secret ask's own `notice` field. Pushing them here
        // too would say each of them twice.
        const presentation = frame.presentation as
          | { type?: string; message?: string; title?: string; busy?: boolean; outcome?: boolean }
          | undefined;
        if (presentation?.type !== "notice" || presentation.outcome !== true) return;
        const message = typeof presentation.message === "string" ? presentation.message : "";
        this.#pushNotice(
          "info",
          presentation.title ? `${presentation.title} — ${message}` : message,
        );
        return;
      }
      case "chat.opened":
      case "chat.reset": {
        const turns = Array.isArray(frame.turns) ? (frame.turns as ChatTurn[]) : [];
        this.chat = {
          chatId: String(frame.chatId ?? ""),
          title: String(frame.title ?? ""),
          workspace: String(frame.workspace ?? ""),
          turnCount: typeof frame.turnCount === "number" ? frame.turnCount : 0,
        };
        if (frame.e === "chat.opened") {
          this.lastOpened = frame as unknown as ChatOpened;
        }
        // The wire says the transcript changed in a way an append-only
        // client cannot follow, and hands over what the session now holds.
        // Rendering the old blocks after this would show deleted history.
        this.loadTurns(turns);
        return;
      }
      default:
        return;
    }
  }

  /* --- transcript / assistant ------------------------------------------ */

  #applyTranscript(frame: EventFrame): void {
    const content = typeof frame.content === "string" ? frame.content : "";
    if (!content.trim()) return;
    const role = String(frame.role ?? "system");
    const meta = typeof frame.meta === "string" ? frame.meta : undefined;
    const at = Date.now();
    if (role === "user") {
      this.#push({ kind: "user", id: this.#id("user"), at, text: content, interjected: false });
      return;
    }
    if (role === "assistant") {
      // `tui.ts`'s `addMessage("assistant", …)`: it goes into the block the
      // run is already streaming into when there is one, and opens its own
      // when there is not. A published answer is not a second turn.
      this.#appendAssistant(content, at);
      this.#finishAssistant();
      return;
    }
    // The run's concluding line: the first un-`meta`'d transcript message
    // after `run-end`, which is exactly what `run-session.ts` writes there.
    // A message that carries a `meta` label is something else (a notice, a
    // `/panel` report, a Cross line) and never claims the footer.
    const footer = this.#footerPending && !meta ? (this.run?.outcome ?? null) : null;
    if (footer !== null) this.#footerPending = false;
    this.#push({
      kind: "system",
      id: this.#id("system"),
      at,
      text: content,
      ...(meta ? { meta } : {}),
      ...(role === "error" ? { level: "error" as const } : {}),
      ...(footer !== null ? { footer } : {}),
    });
  }

  #applyAssistant(frame: EventFrame): void {
    const phase = String(frame.phase ?? "");
    if (phase === "begin") {
      // `tui.ts`'s `beginAssistant`: it opens NO block. An answer that never
      // arrives must leave no trace, and a block opened here is the empty
      // bullet with a caret in it that the owner photographed — the first
      // `reasoning` event orphans it before a single character lands.
      this.#streamedChars = 0;
      this.#streamModel = typeof frame.model === "string" ? frame.model : undefined;
      this.#assistantId = null;
      return;
    }
    if (phase === "delta") {
      const delta = typeof frame.delta === "string" ? frame.delta : "";
      if (!delta) return;
      this.#streamedChars += delta.length;
      this.#appendAssistant(delta, Date.now());
      return;
    }
    if (phase === "end") {
      const fallback = (typeof frame.text === "string" ? frame.text : "").trim();
      // `tui.ts`'s `finishAssistant`: the run's text is adopted only when
      // the run streamed nothing. Anything else is the same answer arriving
      // twice — once as deltas, once as the result — and printing both is
      // the duplicate.
      if (this.#streamedChars === 0 && fallback) this.#appendAssistant(fallback, Date.now());
      this.#finishAssistant();
      this.#streamedChars = 0;
      this.#streamModel = undefined;
    }
  }

  /**
   * The one place an answer block is created or grown — `RunViewModel`'s
   * `appendAssistant`, function for function.
   */
  #appendAssistant(text: string, at: number): void {
    if (!text) return;
    const existing = this.#assistantId ? this.#find(this.#assistantId) : undefined;
    if (existing && existing.kind === "assistant") {
      existing.text += text;
      return;
    }
    const block = this.#push<Extract<Block, { kind: "assistant" }>>({
      kind: "assistant",
      id: this.#id("assistant"),
      at,
      text,
      streaming: true,
      ...(this.#streamModel ? { model: this.#streamModel } : {}),
    });
    this.#assistantId = block.id;
  }

  /** `RunViewModel`'s `finishAssistant`: the block settles, the id is let go. */
  #finishAssistant(): void {
    const block = this.#assistantId ? this.#find(this.#assistantId) : undefined;
    if (block?.kind === "assistant") block.streaming = false;
    this.#assistantId = null;
  }

  /* --- the run stream --------------------------------------------------- */

  #applyRun(frame: EventFrame): void {
    const event = frame.event as RunEventBase | undefined;
    if (!event || typeof event.type !== "string") return;
    const at = typeof event.timestamp === "number" ? event.timestamp : Date.now();
    switch (event.type) {
      case "run-start": {
        this.run = {
          active: true,
          model: String(event.model ?? ""),
          maxSteps: typeof event.maxSteps === "number" ? event.maxSteps : 0,
          step: 0,
          costUsd: 0,
          // Absent means known — the run log's own convention (types.ts).
          costKnowledge: event.costKnowledge === "unknown" ? "unknown" : "known",
          toolCount: 0,
          startedAt: at,
          outcome: null,
        };
        // A new run has no footer yet, whatever the last one left behind.
        this.#footerPending = false;
        return;
      }
      case "model-start": {
        if (this.run) this.run.step = typeof event.step === "number" ? event.step : this.run.step;
        // A new model phase supersedes reasoning left live by an aborted one.
        this.#closeReasoning();
        return;
      }
      case "model-end": {
        if (this.run) {
          this.run.costUsd += typeof event.costUsd === "number" ? event.costUsd : 0;
          // Sticky: once any phase priced as unknown, the run's total is not
          // a number anyone may present as complete.
          if (event.costKnowledge === "unknown") this.run.costKnowledge = "unknown";
        }
        this.#closeReasoning();
        return;
      }
      case "reasoning": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) return;
        const current = this.#reasoningId ? this.#find(this.#reasoningId) : undefined;
        if (current && current.kind === "reasoning") {
          current.text += delta;
          return;
        }
        const block: Block = {
          kind: "reasoning",
          id: this.#id("reasoning"),
          at,
          text: delta,
          live: true,
          // P15: the answer leads, the thinking is one click away.
          collapsed: true,
        };
        this.#push(block);
        this.#reasoningId = block.id;
        this.#assistantId = null;
        return;
      }
      case "interjection": {
        this.#push({
          kind: "user",
          id: this.#id("interjection"),
          at,
          text: String(event.text ?? ""),
          interjected: true,
        });
        return;
      }
      case "text":
        // Deliberately ignored: the same characters arrive as `assistant`
        // deltas, and this is the run log's mirror of them.
        return;
      case "tool-start": {
        const key = String(event.id ?? "");
        const block = this.#openTool(
          key,
          typeof event.number === "number" ? event.number : 0,
          String(event.name ?? ""),
          (event.input as Record<string, unknown>) ?? {},
          at,
        );
        this.#tools.set(key, block.id);
        if (this.run) this.run.toolCount += 1;
        return;
      }
      case "tool-output": {
        const block = this.#toolBlock(String(event.id ?? ""));
        if (block) this.#appendToolLines(block, String(event.text ?? ""));
        return;
      }
      case "tool-end": {
        const block = this.#toolBlock(String(event.id ?? ""));
        if (!block) return;
        // The terminal's own grading, not this window's reading of it: no
        // exit code means UNVERIFIED, which is what a finished `write_file`
        // is until something verifies it.
        const outcome = classifyToolOutcome(event.output);
        block.state = outcome.state;
        block.durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
        if (outcome.exitCode !== undefined) block.exitCode = outcome.exitCode;
        // The terminal's own reduction, function for function: which keys of
        // the result count as output, and which of those lines survive a
        // collapse — failure-first on a failure, tail-last otherwise.
        const failed = outcome.state === "failed";
        const lines = outputLines(event.output);
        if (lines.length > 0) {
          block.totalLines = Math.max(block.totalLines, lines.length);
          block.lines = selectTail(lines, failed, failed ? REASONING_MAX_LINES : TAIL_CAPACITY);
        } else if (block.lines.length > 0) {
          block.lines = selectTail(block.lines, failed, failed ? REASONING_MAX_LINES : TAIL_CAPACITY);
        }
        const summary = toolMetadata(block.name).summarizeOutput(event.output);
        if (summary) block.input = `${block.input} — ${summary}`;
        this.#tools.delete(String(event.id ?? ""));
        return;
      }
      case "tool-error": {
        const block = this.#toolBlock(String(event.id ?? ""));
        if (!block) return;
        block.state = "failed";
        block.error = String(event.error ?? "");
        block.lines = selectTail(textLines(block.error), true, REASONING_MAX_LINES);
        block.durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
        block.collapsed = false;
        this.#tools.delete(String(event.id ?? ""));
        return;
      }
      case "file-change": {
        this.#push({
          kind: "file-change",
          id: this.#id("diff"),
          at,
          path: String(event.path ?? ""),
          tool: String(event.tool ?? ""),
          created: event.created === true,
          added: typeof event.added === "number" ? event.added : 0,
          removed: typeof event.removed === "number" ? event.removed : 0,
          diff: String(event.diff ?? ""),
          truncated: event.truncated === true,
        });
        this.#assistantId = null;
        return;
      }
      case "process-start":
        return this.#processStart(event, at);
      case "process-output": {
        const binding = this.#processes.get(String(event.id ?? ""));
        if (!binding) return;
        const block = this.#find(binding.blockKey);
        if (block?.kind === "tool") this.#appendToolLines(block, String(event.text ?? ""));
        return;
      }
      case "process-end":
        return this.#processEnd(event);
      case "verify": {
        const failed = event.exitCode !== 0;
        const block = this.#openTool(
          `verify:${String(event.command ?? "")}:${String(event.round ?? "")}`,
          0,
          "verify",
          { command: event.command, round: event.round },
          at,
        );
        block.state = failed ? "failed" : "ok";
        block.exitCode = typeof event.exitCode === "number" ? event.exitCode : 0;
        block.durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
        return;
      }
      case "notice": {
        const level = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "info";
        this.#pushNotice(
          level,
          String(event.message ?? ""),
          typeof event.hint === "string" ? event.hint : undefined,
        );
        return;
      }
      case "run-end": {
        const outcome = (event.outcome as RunOutcome) ?? "error";
        for (const block of this.blocks) {
          if (block.kind === "tool" && block.state === "running") {
            // Never `ok`. The tool did not finish; whether that was a cancel
            // or an unverified end is the only question.
            block.state = outcome === "cancelled" ? "cancelled" : "unverified";
          }
          if (block.kind === "reasoning" && block.live) block.live = false;
          // Nothing streams past the end of the run. The caret is painted
          // from this flag, and a stale one is a settled answer wearing a
          // live block's cursor.
          if (block.kind === "assistant" && block.streaming) block.streaming = false;
        }
        this.#tools.clear();
        this.#processes.clear();
        this.#reasoningId = null;
        this.#assistantId = null;
        if (this.run) {
          this.run.active = false;
          this.run.outcome = outcome;
        }
        // No block: the run's outcome reaches the stream as the engine's own
        // `runFooter` line, exactly once, in the terminal's wording. This is
        // `view-model.ts`'s `run-end` case — it settles and returns. All the
        // flag does is remember that the NEXT un-`meta`'d system line is that
        // sentence, so the window can draw it as the run's footer instead of
        // as one more grey line.
        this.#footerPending = true;
        return;
      }
      default:
        return;
    }
  }

  #processStart(event: RunEventBase, at: number): void {
    const id = String(event.id ?? "");
    if (this.#processes.has(id)) return;
    const toolId = typeof event.toolId === "string" ? event.toolId : undefined;
    if (toolId) {
      const blockId = this.#tools.get(toolId);
      if (blockId) {
        this.#processes.set(id, { blockKey: blockId, bound: true });
        return;
      }
    }
    const block = this.#openTool(
      `process:${id}`,
      typeof event.toolNumber === "number" ? event.toolNumber : 0,
      String(event.name ?? ""),
      (event.input as Record<string, unknown>) ?? {},
      at,
    );
    this.#processes.set(id, { blockKey: block.id, bound: false });
  }

  #processEnd(event: RunEventBase): void {
    const id = String(event.id ?? "");
    const binding = this.#processes.get(id);
    if (!binding) return;
    this.#processes.delete(id);
    if (binding.bound) return;
    const block = this.#find(binding.blockKey);
    if (block?.kind !== "tool") return;
    // The dashboard folds an unbound process end into the same `tool-end`
    // shape and grades it with the same function (`tui.ts`'s
    // `#applyProcessEvent`), so this builds that shape rather than inventing
    // a second rule — `exitCode: null` plus a terminal reason on stderr is a
    // failed launch, and no exit code at all is unverified.
    const outcome = classifyToolOutcome({
      stdout: event.stdout ?? "",
      stderr: event.stderr || event.error || "",
      exitCode: event.exitCode ?? null,
    });
    block.state = outcome.state;
    if (outcome.exitCode !== undefined) block.exitCode = outcome.exitCode;
    block.durationMs = typeof event.durationMs === "number" ? event.durationMs : 0;
  }

  /* --- block plumbing --------------------------------------------------- */

  #openTool(
    key: string,
    numberValue: number,
    name: string,
    input: Record<string, unknown>,
    at: number,
  ): Extract<Block, { kind: "tool" }> {
    const meta = toolMetadata(name);
    const block: Extract<Block, { kind: "tool" }> = {
      kind: "tool",
      id: this.#id("tool"),
      at,
      key,
      number: numberValue,
      name,
      label: meta.label,
      title: meta.title,
      input: meta.summarizeInput(input),
      rawInput: input,
      state: "running",
      lines: [],
      totalLines: 0,
      collapsed: true,
    };
    this.#push(block);
    this.#assistantId = null;
    return block;
  }

  #toolBlock(eventId: string): Extract<Block, { kind: "tool" }> | undefined {
    const id = this.#tools.get(eventId);
    if (!id) return undefined;
    const block = this.#find(id);
    return block?.kind === "tool" ? block : undefined;
  }

  /**
   * The terminal's own ring buffer, at the terminal's own size: keep
   * `TAIL_CAPACITY` lines while the tool runs, show `RUNNING_TAIL_LINES` of
   * them collapsed. The window used to keep a round 200 of its own, which is
   * the same number by accident rather than by rule.
   */
  #appendToolLines(block: Extract<Block, { kind: "tool" }>, text: string): void {
    if (!text) return;
    const lines = textLines(text);
    if (lines.length === 0) return;
    block.totalLines += lines.length;
    block.lines.push(...lines);
    while (block.lines.length > TAIL_CAPACITY) block.lines.shift();
  }

  #closeReasoning(): void {
    const block = this.#reasoningId ? this.#find(this.#reasoningId) : undefined;
    if (block?.kind === "reasoning") block.live = false;
    this.#reasoningId = null;
  }

  #pushNotice(level: "info" | "warn" | "error", text: string, hint?: string): void {
    if (!text) return;
    this.#push({
      kind: "notice",
      id: this.#id("notice"),
      at: Date.now(),
      level,
      text,
      ...(hint ? { hint } : {}),
    });
  }

  #push<T extends Block>(block: T): T {
    this.blocks.push(block);
    return block;
  }

  #find(id: string): Block | undefined {
    return this.blocks.find((block) => block.id === id);
  }

  #id(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}
