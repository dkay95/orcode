/**
 * Terminal binding (Bauplan 4.2).
 *
 * This module owns four things and nothing else: the terminal itself
 * (start/stop/suspend/resize), frame output with a line diff and a real
 * cursor, the seven-mode input state machine, and a thin bridge from run
 * events into `RunViewModel` and from UI state into `buildDashboardFrame`.
 *
 * It makes no styling decisions: every line it emits carries roles, and
 * `renderLines` is the only place that turns those into ANSI.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  commandTokenIsExact,
  rankSlashCommands,
  type SlashCommandDefinition,
} from "./command-catalog.js";
import type { AgentRunEvent, ChatTurn, ModelInfo, ToolCallPreview } from "./types.js";
import type { ImageAttachment } from "./attachments.js";
import type { PanelJudgment, PanelResult } from "./panel.js";
import { approvalRiskLabel } from "./approval.js";
import { TAIL, type ChatBlock, type Viewport } from "./ui/blocks.js";
import { renderLines } from "./ui/compose.js";
import {
  buildDashboardFrame,
  clamp,
  type DashboardFrameInput,
  type DashboardState,
  type ListView,
  type RunSnapshot,
  type UiMode,
} from "./ui/dashboard-frame.js";
import { renderBlock } from "./ui/render-block.js";
import { MAX_CONTENT_WIDTH, type Frame } from "./ui/render-frame.js";
import { createTheme, type Theme } from "./ui/theme.js";
import { RunViewModel } from "./ui/view-model.js";

export {
  buildDashboardFrame,
  buildListLines,
  type DashboardFrameInput,
  type DashboardState,
  type ListEntry,
  type ListView,
  type RunSnapshot,
  type UiMode,
} from "./ui/dashboard-frame.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const HOME = "\u001b[H";
const ERASE_LINE = "\u001b[K";
const ERASE_BELOW = "\u001b[J";
const LEAVE_TERMINAL = `${DISABLE_BRACKETED_PASTE}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g;
const STRING_SEQUENCE = /\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/g;
const ESCAPE_SEQUENCE = /\u001b[@-_]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const SPINNER_INTERVAL_MS = 80;
const STATUS_FRESH_MS = 6_000;
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface ChoicePickerItem {
  value: string;
  label: string;
  description: string;
}

export class UiExitError extends Error {
  constructor() {
    super("orcode wurde beendet.");
    this.name = "UiExitError";
  }
}

/**
 * Result of an approval prompt (Bauplan A6/A7).
 *
 * Declared locally — structurally identical to `approval.ts`'s own
 * `ApprovalDecision` — so this module compiles independently of that
 * (parallel) change. `remember` and `reason` mirror `approval.ts` exactly;
 * see the needsElsewhere note in the task report for the merge.
 */
export interface ApprovalDecision {
  accepted: boolean;
  remember?: "allow" | "deny";
  reason?: string;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_CONTROL, "")
    .replace(/[^\S\r\n]+/g, (spaces) => spaces.replace(/[^\t ]/g, " "));
}

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

/** German label for a run-end outcome. Exported so cli.ts says the same thing. */
export function runOutcomeLabel(
  outcome: Extract<AgentRunEvent, { type: "run-end" }>["outcome"],
): string {
  switch (outcome) {
    case "complete":
      return "Lauf beendet";
    case "step-limit":
      return "Schrittlimit erreicht";
    case "cost-limit":
      return "Kostenlimit erreicht";
    case "cancelled":
      return "Lauf abgebrochen";
    case "error":
      return "Lauf fehlgeschlagen";
    case "unverified":
      return "Lauf beendet · unbestätigt";
  }
}

function lineCount(value: string): number {
  return value ? value.split(/\r\n?|\n/).length : 1;
}

function asciiRequested(): boolean {
  if (process.env.ORCODE_ASCII === "1" || process.env.ROUTERCODE_ASCII === "1") return true;
  const locale = process.env.LC_ALL || process.env.LANG || "";
  return locale === "C" || locale === "POSIX";
}

function isFunctionKey(name?: string): boolean {
  return /^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(name ?? "");
}

function slashCommandToken(input: string): string {
  return input.startsWith("/")
    ? input.slice(1).trimStart().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function choiceSearchScore(item: ChoicePickerItem, query: string): number {
  if (!query) return 0;
  const label = item.label.toLowerCase();
  const value = item.value.toLowerCase();
  if (label === query || value === query) return 10_000;
  if (label.startsWith(query) || value.startsWith(query)) return 5_000;
  return `${label} ${value} ${item.description.toLowerCase()}`.includes(query) ? 1_000 : -1;
}

/** A6, `@`-completion: never walk into these directories. */
function isIgnoredWorkspaceEntry(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name.startsWith(".");
}

/** Fuzzy score for `@` file completion, `query` already lower-cased. */
function fuzzyPathScore(candidate: string, query: string): number {
  const value = candidate.toLowerCase();
  if (value === query) return 10_000;
  if (value.startsWith(query)) return 5_000;
  const base = value.slice(value.lastIndexOf("/") + 1);
  if (base.startsWith(query)) return 3_000;
  return value.includes(query) ? 1_000 : -1;
}

function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

export class TerminalUi {
  readonly supported: boolean;
  readonly #theme: Theme;
  readonly #vm = new RunViewModel();
  #inputChars: string[] = [];
  #cursor = 0;
  #status = "Bereit";
  #statusAt = 0;
  #mode: UiMode = "idle";
  #active = false;
  #renderTimer: NodeJS.Timeout | null = null;
  #inputResolve: ((value: string) => void) | null = null;
  #inputReject: ((error: Error) => void) | null = null;
  #confirmResolve: ((decision: ApprovalDecision) => void) | null = null;
  #confirmSince = 0;
  #confirmReasonMode = false;
  #approvalBlockId: string | null = null;
  #contextPercent: number | undefined = undefined;
  #historyActive = false;
  #historySelectedIndex = 0;
  #atSelectedIndex = 0;
  #atClosed = false;
  #atFilesCache: { root: string; files: readonly string[] } | null = null;
  #assistantChars = 0;
  #history: string[] = [];
  #historyIndex = 0;
  #queuedInputs: string[] = [];
  #pickerSearch: ((query: string) => readonly ModelInfo[]) | null = null;
  #pickerModels: ModelInfo[] = [];
  #pickerResolve: ((model: ModelInfo | null) => void) | null = null;
  #pickerCurrent = "";
  #choiceAll: ChoicePickerItem[] = [];
  #choiceItems: ChoicePickerItem[] = [];
  #choiceResolve: ((choice: ChoicePickerItem | null) => void) | null = null;
  #choiceCurrent = "";
  #choiceInitial = "";
  #selectedIndex = 0;
  #commandSelectedIndex = 0;
  #listClosed = false;
  #suggestedReplies: string[] = [];
  #suggestedReplyIndex = 0;
  #attachments: ImageAttachment[] = [];
  #pasting = false;
  #pasteBuffer = "";
  #secretLabel = "";
  #secretResolve: ((value: string | null) => void) | null = null;
  #recordingResolve: ((action: "stop" | "cancel") => void) | null = null;
  #cancelHandler: (() => void) | null = null;
  #cancelRequestedAt = 0;
  #viewport: Viewport = TAIL;
  #linesAtScroll = 0;
  #lastChatHeight = 0;
  #lastRenderedLines: string[] = [];
  #lastWidth = 0;
  #lastHeight = 0;
  #run: RunSnapshot | null = null;
  #tick = 0;
  #spinnerTimer: NodeJS.Timeout | null = null;
  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly getState: () => DashboardState,
    private readonly stdin = process.stdin as ReadStream,
    private readonly stdout = process.stdout as WriteStream,
    theme?: Theme,
  ) {
    this.supported = Boolean(
      stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function",
    );
    this.#theme = theme ?? createTheme({ ascii: asciiRequested() });
    for (const signal of SIGNALS) {
      this.#signalHandlers.set(signal, () => this.#terminate(signal));
    }
  }

  get active(): boolean {
    return this.#active;
  }

  loadTurns(turns: readonly ChatTurn[], maximum = 12): void {
    this.#clearSuggestedReplies();
    this.#vm.clear();
    for (const turn of turns.slice(-maximum)) {
      const content = sanitizeTerminalText(turn.content).trim();
      if (!content) continue;
      const parsed = Date.parse(turn.createdAt);
      const at = Number.isFinite(parsed) ? parsed : Date.now();
      if (turn.role === "user") this.#vm.pushUser(content, 0, at);
      else {
        this.#vm.appendAssistant(content, at);
        this.#vm.finishAssistant();
      }
    }
    this.#viewport = TAIL;
    this.scheduleRender();
  }

  addMessage(
    role: "user" | "assistant" | "system" | "error",
    content: string,
    meta?: string,
  ): void {
    const clean = sanitizeTerminalText(content).trim();
    if (!clean) return;
    if (role === "user") this.#vm.pushUser(clean, this.#attachments.length);
    else if (role === "assistant") {
      this.#vm.appendAssistant(clean);
      this.#vm.finishAssistant();
    } else {
      // Only the title line is torn off here; the rest — including blank
      // lines that separate sections — is kept intact so `markdownToLines`
      // can render it with structure instead of a flattened line dump.
      const [head = clean, ...rest] = clean.split("\n");
      const title = meta ? `${meta}${this.#theme.glyph("separator")}${head}` : head;
      const cause = rest.join("\n");
      this.#vm.pushNotice(role === "error" ? "error" : "info", title, cause ? [cause] : []);
    }
    this.scheduleRender();
  }

  /**
   * Renders a `/panel` result as its own block in the chat stream instead of
   * flattening it into a text notice — see `CommandContext.onPanelResult` in
   * commands.ts, which calls this when the fullscreen TUI is active. Every
   * call, including a later `/panel show <n>` for the same result, appends a
   * fresh block, exactly like every other command result already does.
   */
  addPanelResult(
    result: PanelResult,
    judgment: PanelJudgment | null,
    expandedIndex: number | null,
  ): void {
    this.#vm.pushPanel(result, judgment, expandedIndex);
    this.scheduleRender();
  }

  beginAssistant(_model: string): void {
    this.#clearSuggestedReplies();
    this.#assistantChars = 0;
    this.#mode = "busy";
    this.scheduleRender();
  }

  appendAssistant(delta: string): void {
    const clean = sanitizeTerminalText(delta);
    if (!clean) return;
    this.#assistantChars += clean.length;
    this.#vm.appendAssistant(clean);
    if (this.#run) {
      this.#run.phase = "Modell streamt Antwort";
      this.#run.lastEventAt = Date.now();
    }
    this.scheduleRender();
  }

  finishAssistant(fallback = ""): void {
    const rest = sanitizeTerminalText(fallback).trim();
    if (this.#assistantChars === 0 && rest) this.#vm.appendAssistant(rest);
    this.#vm.finishAssistant();
    this.#assistantChars = 0;
    this.finishRun();
    this.#mode = "idle";
    this.setStatus("Bereit", false);
  }

  setSuggestedReplies(replies: readonly string[]): void {
    const clean: string[] = [];
    for (const reply of replies) {
      const value = oneLine(reply).slice(0, 140);
      if (value && !clean.some((item) => item.toLowerCase() === value.toLowerCase())) {
        clean.push(value);
      }
      if (clean.length === 4) break;
    }
    this.#suggestedReplies = clean;
    this.#suggestedReplyIndex = 0;
    this.scheduleRender(true);
  }

  setImageAttachments(attachments: readonly ImageAttachment[]): void {
    this.#attachments = attachments.map((attachment) => ({ ...attachment }));
    this.scheduleRender(true);
  }

  setStatus(status: string, busy = true): void {
    this.#status = oneLine(status) || "Bereit";
    this.#statusAt = Date.now();
    if (busy && this.#run) {
      this.#run.phase = this.#status;
      this.#run.lastEventAt = Date.now();
    }
    if (busy && this.#mode !== "confirm") this.#mode = "busy";
    else if (!busy && this.#mode === "busy") this.#mode = "idle";
    this.scheduleRender();
  }

  refresh(): void {
    this.scheduleRender(true);
  }

  setCancelHandler(handler?: () => void): void {
    this.#cancelHandler = handler ?? null;
    this.#cancelRequestedAt = 0;
  }

  /** Bridge: the blocks belong to the view model, the run header stays here. */
  handleRunEvent(event: AgentRunEvent): void {
    this.#vm.apply(event);
    if (event.type === "run-start") {
      this.#run = {
        phase: "Lauf wird vorbereitet",
        startedAt: event.timestamp,
        lastEventAt: event.timestamp,
        step: 1,
        maxSteps: event.maxSteps,
        costUsd: 0,
        running: true,
      };
      this.#mode = "busy";
      this.#startSpinner();
      this.scheduleRender(true);
      return;
    }
    const run = this.#run;
    if (run) {
      run.lastEventAt = event.timestamp;
      if (event.type === "model-start" || event.type === "model-end" || event.type === "reasoning") {
        run.step = event.step;
      }
      if (event.type === "model-end") run.costUsd += event.costUsd;
      if (event.type === "run-end") {
        run.running = false;
        this.#stopSpinner();
      }
      run.phase = this.#phaseOf(event, run.phase);
    }
    this.scheduleRender(true);
  }

  finishRun(): void {
    this.#stopSpinner();
    this.#run = null;
  }

  pickModel(
    searchModels: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title = "Modell auswählen",
  ): Promise<ModelInfo | null> {
    this.#requireActive();
    this.#pickerSearch = searchModels;
    this.#pickerCurrent = currentModel;
    this.#resetQuery();
    this.#refreshPicker();
    this.#enterMode("model-picker", oneLine(title) || "Modell auswählen");
    return new Promise<ModelInfo | null>((resolve) => {
      this.#pickerResolve = resolve;
    });
  }

  pickChoice(
    title: string,
    items: readonly ChoicePickerItem[],
    currentValue: string,
    initialValue = currentValue,
  ): Promise<ChoicePickerItem | null> {
    this.#requireActive();
    this.#choiceAll = [...items];
    this.#choiceCurrent = currentValue;
    this.#choiceInitial = initialValue;
    this.#resetQuery();
    this.#refreshChoices();
    this.#enterMode("choice-picker", `${oneLine(title)} auswählen`);
    return new Promise<ChoicePickerItem | null>((resolve) => {
      this.#choiceResolve = resolve;
    });
  }

  readSecret(label: string): Promise<string | null> {
    this.#requireActive();
    this.#secretLabel = oneLine(label);
    this.#resetQuery();
    this.#enterMode("secret", `${this.#secretLabel} eingeben`);
    return new Promise<string | null>((resolve) => {
      this.#secretResolve = resolve;
    });
  }

  /**
   * Enters the dedicated "recording" mode (`/whisper`): Enter resolves
   * `"stop"`, Escape resolves `"cancel"`. Nothing else is read while this
   * mode is active — the input buffer is untouched so the caller can insert
   * the transcript into it afterwards via `insertInputText`.
   */
  awaitRecordingControl(initialStatus: string): Promise<"stop" | "cancel"> {
    if (!this.#active) return Promise.resolve("cancel");
    this.#enterMode("recording", initialStatus);
    return new Promise<"stop" | "cancel">((resolve) => {
      this.#recordingResolve = resolve;
    });
  }

  /** Updates the status line while recording (e.g. the running elapsed-seconds counter) without leaving "recording" mode. */
  updateRecordingStatus(status: string): void {
    if (this.#mode !== "recording") return;
    this.#status = oneLine(status) || "Aufnahme läuft";
    this.#statusAt = Date.now();
    // Immediate, not debounced: this drives a live once-per-second counter,
    // where a batched render would read as visibly laggy.
    this.scheduleRender(true);
  }

  /**
   * Ends the recording control mode as if the user had pressed Enter/Escape
   * — used when a hard limit (duration/size) forces an automatic stop while
   * the user hasn't pressed anything yet. A no-op outside "recording" mode.
   */
  triggerRecordingControl(action: "stop" | "cancel"): void {
    if (this.#mode !== "recording") return;
    this.#resolveRecording(action);
  }

  /**
   * Inserts text into the input line — used to land a `/whisper` transcript
   * in the prompt instead of sending it. Appends after existing text (with a
   * separating space) rather than replacing it, and moves the cursor to the
   * end of the inserted text.
   */
  insertInputText(text: string): void {
    if (!text) return;
    const existing = this.#inputChars.join("");
    const next = existing ? `${existing} ${text}` : text;
    this.#inputChars = Array.from(next);
    this.#cursor = this.#inputChars.length;
    this.scheduleRender(true);
  }

  confirmAction(title: string, details: string): Promise<ApprovalDecision> {
    if (!this.#active) return Promise.resolve({ accepted: false });
    if (!this.#approvalBlockId) {
      this.#approvalBlockId = this.#vm.pushApproval({
        risk: "shell",
        summary: oneLine(title),
        details: this.#detailLines(details),
      }).id;
    }
    this.#confirmSince = Date.now();
    this.#enterMode("confirm", "Bestätigung erforderlich");
    return new Promise<ApprovalDecision>((resolve) => {
      this.#confirmResolve = resolve;
    });
  }

  confirmApproval(preview: ToolCallPreview): Promise<ApprovalDecision> {
    if (!this.#active) return Promise.resolve({ accepted: false });
    const separator = this.#theme.glyph("separator");
    this.#approvalBlockId = this.#vm.pushApproval({
      risk: preview.risk,
      summary: `${approvalRiskLabel(preview.risk)}${separator}${oneLine(preview.summary)}`,
      details: this.#detailLines(preview.details ?? preview.name),
      rememberHint: "keine gemerkte Regel für diese Aktion",
    }).id;
    return this.confirmAction(preview.summary, preview.details ?? preview.name);
  }

  /** A7: the context-fill header segment is fed from outside (agent/session). */
  setContextPercent(percent: number | undefined): void {
    this.#contextPercent = percent === undefined ? undefined : clamp(percent, 0, 999);
    this.scheduleRender();
  }

  start(): void {
    if (!this.supported || this.#active) return;
    emitKeypressEvents(this.stdin);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.#active = true;
    // B12: a paste whose end marker never arrived must not survive a restart —
    // otherwise every later key, Ctrl+C included, is swallowed as paste text.
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.stdin.on("keypress", this.#onKeypress);
    process.on("SIGWINCH", this.#onResize);
    for (const [signal, handler] of this.#signalHandlers) process.on(signal, handler);
    process.on("exit", this.#onProcessExit);
    process.on("uncaughtExceptionMonitor", this.#onFatalError);
    this.stdout.write(`${ENTER_ALTERNATE_SCREEN}${ENABLE_BRACKETED_PASTE}${HOME}${ERASE_BELOW}`);
    this.#forgetGeometry();
    if (this.#run?.running) this.#startSpinner();
    this.render(true);
  }

  stop(): void {
    if (!this.#active) return;
    try {
      this.#detachTerminal();
    } finally {
      this.#pasting = false;
      this.#pasteBuffer = "";
      try {
        this.stdin.pause();
      } catch {
        // Best-effort cleanup for partially closed terminals.
      }
      try {
        this.stdout.write(LEAVE_TERMINAL);
      } catch {
        // Best-effort cleanup for partially closed terminals.
      }
      this.#forgetGeometry();
    }
  }

  async suspend<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#active) return operation();
    this.#detachTerminal();
    this.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
    try {
      return await operation();
    } finally {
      this.start();
    }
  }

  readInput(): Promise<string> {
    this.#requireActive();
    const queued = this.#queuedInputs.shift();
    if (queued !== undefined) {
      this.#enterMode(
        "busy",
        this.#queuedInputs.length
          ? `Vorgemerkte Eingabe wird verarbeitet · ${this.#queuedInputs.length} weitere`
          : "Vorgemerkte Eingabe wird verarbeitet",
      );
      return Promise.resolve(queued);
    }
    this.#historyIndex = this.#history.length;
    this.#commandSelectedIndex = 0;
    this.#listClosed = false;
    this.#historyActive = false;
    this.#atClosed = false;
    this.#enterMode("input", "Bereit");
    return new Promise<string>((resolve, reject) => {
      this.#inputResolve = resolve;
      this.#inputReject = reject;
    });
  }

  /** The current frame. Exposed so layout can be asserted without a TTY. */
  frame(): Frame {
    const input: DashboardFrameInput = {
      width: Math.max(1, this.stdout.columns || 80),
      height: Math.max(1, this.stdout.rows || 24),
      theme: this.#theme,
      state: this.getState(),
      blocks: this.#vm.blocks,
      mode: this.#mode,
      input: this.#inputChars.join(""),
      cursor: this.#cursor,
      viewport: this.#viewport,
      status: this.#status,
      statusFresh: Date.now() - this.#statusAt < STATUS_FRESH_MS,
      queuedCount: this.#queuedInputs.length,
      attachmentCount: this.#attachments.length,
      helpRequested: this.#inputChars.join("").trim() === "?",
      tick: this.#tick,
      now: Date.now(),
    };
    if (this.#contextPercent !== undefined) input.contextPercent = this.#contextPercent;
    if (this.#run) input.run = this.#run;
    if (this.#mode === "confirm") input.waitingSince = this.#confirmSince;
    if (this.#mode === "secret") input.secretLabel = this.#secretLabel;
    const list = this.#listView();
    if (list) input.list = list;
    if (this.#viewport.anchor !== "tail") {
      input.newLinesBelow = Math.max(0, this.#flatten().length - this.#linesAtScroll);
    }
    return buildDashboardFrame(input);
  }

  render(forceFull = false): void {
    if (!this.#active) return;
    const width = Math.max(1, this.stdout.columns || 80);
    const height = Math.max(1, this.stdout.rows || 24);
    const geometryChanged = width !== this.#lastWidth || height !== this.#lastHeight;
    const frame = this.frame();
    this.#lastChatHeight = frame.chatHeight;
    const styled = renderLines(frame.lines, this.#theme);
    const cursor = `\u001b[${frame.cursor.row};${frame.cursor.col}H`;
    if (forceFull || geometryChanged || this.#lastRenderedLines.length !== styled.length) {
      // B14: no `2J`. Home, erase each line while writing it, erase the rest —
      // that redraws without the flash a full clear produces on every resize.
      const body = styled.map((line) => `${line}${ERASE_LINE}`).join("\r\n");
      this.stdout.write(`${HIDE_CURSOR}${HOME}${body}${ERASE_BELOW}${cursor}${SHOW_CURSOR}`);
    } else {
      let output = "";
      for (let index = 0; index < styled.length; index += 1) {
        if (styled[index] !== this.#lastRenderedLines[index]) {
          output += `\u001b[${index + 1};1H${styled[index]}${ERASE_LINE}`;
        }
      }
      // The real cursor is repositioned after every partial redraw as well.
      this.stdout.write(`${output}${cursor}${SHOW_CURSOR}`);
    }
    this.#lastRenderedLines = styled;
    this.#lastWidth = width;
    this.#lastHeight = height;
  }

  scheduleRender(immediate = false): void {
    if (!this.#active) return;
    if (immediate) {
      if (this.#renderTimer) {
        clearTimeout(this.#renderTimer);
        this.#renderTimer = null;
      }
      this.render();
      return;
    }
    if (this.#renderTimer) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      this.render();
    }, 30);
  }

  #requireActive(): void {
    if (!this.#active) throw new Error("Die Terminal-Oberfläche ist nicht aktiv.");
  }

  #enterMode(mode: UiMode, status: string): void {
    this.#mode = mode;
    this.#status = status;
    this.#statusAt = Date.now();
    this.scheduleRender(true);
  }

  #resetQuery(): void {
    this.#inputChars = [];
    this.#cursor = 0;
  }

  #forgetGeometry(): void {
    this.#lastRenderedLines = [];
    this.#lastWidth = 0;
    this.#lastHeight = 0;
  }

  #detailLines(value: string): string[] {
    return sanitizeTerminalText(value)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  #phaseOf(event: AgentRunEvent, current: string): string {
    switch (event.type) {
      case "model-start":
        return "Modell wartet";
      case "model-end":
        return "Modellantwort empfangen";
      case "reasoning":
        return "Modell denkt";
      case "tool-start":
        return "Tool läuft";
      case "tool-output":
        return "Tool schreibt Ausgabe";
      case "tool-end":
        return "Modell verarbeitet Tool-Ergebnis";
      case "tool-error":
        return "Modell verarbeitet Toolfehler";
      case "verify":
        return "Prüflauf";
      case "run-end":
        return runOutcomeLabel(event.outcome);
      default:
        return current;
    }
  }

  #listView(): ListView | undefined {
    if (this.#mode === "model-picker") {
      return {
        entries: this.#pickerModels.map((model) => ({
          name: model.id,
          description: model.name,
          current: model.id === this.#pickerCurrent,
        })),
        selectedIndex: this.#selectedIndex,
      };
    }
    if (this.#mode === "choice-picker") {
      return {
        entries: this.#choiceItems.map((item) => ({
          name: item.label,
          description: item.description,
          current: item.value === this.#choiceCurrent,
        })),
        selectedIndex: this.#selectedIndex,
      };
    }
    if (this.#mode !== "input" && this.#mode !== "busy") return undefined;
    // A6: Ctrl+R history search has the highest priority among triggers.
    if (this.#historyActive) {
      const matches = this.#historyMatches();
      return {
        entries: matches.map((value) => ({ name: value, description: "" })),
        selectedIndex: this.#historySelectedIndex,
      };
    }
    if (!this.#listClosed && this.#inputChars[0] === "/") {
      const matches = this.#commandMatches();
      if (!matches.length) return undefined;
      return {
        entries: matches.map((command) => ({
          name: `/${command.name}`,
          description: command.description,
        })),
        selectedIndex: this.#commandSelectedIndex,
      };
    }
    const atToken = this.#atToken();
    if (atToken && !this.#atClosed) {
      const matches = this.#atMatches(atToken.query);
      if (matches.length) {
        return {
          entries: matches.map((path) => ({ name: path, description: "" })),
          selectedIndex: this.#atSelectedIndex,
        };
      }
    }
    if (this.#mode === "input" && this.#suggestedReplies.length && !this.#inputChars.length) {
      return {
        entries: this.#suggestedReplies.map((reply) => ({ name: reply, description: "" })),
        selectedIndex: this.#suggestedReplyIndex,
      };
    }
    return undefined;
  }

  /**
   * Flat line index of the stream, mirroring how `buildFrame` glues blocks
   * together (one blank line before every block but the first). Used only for
   * scroll maths, so that an anchor survives a re-layout (B10, B11).
   */
  #flatten(): Array<{ blockId: string; offset: number }> {
    const width = Math.min(MAX_CONTENT_WIDTH, Math.max(1, (this.stdout.columns || 80) - 1));
    const out: Array<{ blockId: string; offset: number }> = [];
    const blocks = this.#vm.blocks;
    blocks.forEach((block, index) => {
      const lines = renderBlock(block, width, this.#theme, {
        tick: this.#tick,
        last: index === blocks.length - 1,
        now: Date.now(),
      });
      let offset = 0;
      if (index > 0) {
        out.push({ blockId: block.id, offset: 0 });
        offset = 1;
      }
      for (let line = 0; line < lines.length; line += 1) {
        out.push({ blockId: block.id, offset: offset + line });
      }
    });
    return out;
  }

  /** Scrolls by `delta` lines and stores the result as a block anchor. */
  #scroll(delta: number): void {
    const flat = this.#flatten();
    const chatHeight = this.#lastChatHeight || Math.max(5, (this.stdout.rows || 24) - 6);
    const maxTop = Math.max(0, flat.length - chatHeight);
    const anchor = this.#viewport.anchor;
    let top = maxTop;
    if (anchor !== "tail") {
      const first = flat.findIndex((item) => item.blockId === anchor.blockId);
      if (first >= 0) top = clamp(first + anchor.lineOffset, 0, maxTop);
    }
    const next = clamp(top + delta, 0, maxTop);
    this.#linesAtScroll = flat.length;
    const entry = flat[next];
    this.#viewport =
      next >= maxTop || !entry
        ? TAIL
        : { anchor: { blockId: entry.blockId, lineOffset: entry.offset } };
  }

  #detachTerminal(): void {
    if (this.#renderTimer) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
    }
    this.stdin.off("keypress", this.#onKeypress);
    process.off("SIGWINCH", this.#onResize);
    for (const [signal, handler] of this.#signalHandlers) process.off(signal, handler);
    process.off("exit", this.#onProcessExit);
    process.off("uncaughtExceptionMonitor", this.#onFatalError);
    try {
      this.stdout.write(DISABLE_BRACKETED_PASTE);
      this.stdin.setRawMode(false);
    } catch {
      // The terminal may already be closed after a fatal signal.
    }
    this.#active = false;
    this.#forgetGeometry();
    this.#stopSpinner();
  }

  #startSpinner(): void {
    if (this.#spinnerTimer) return;
    this.#spinnerTimer = setInterval(() => {
      this.#tick += 1;
      this.scheduleRender(true);
    }, SPINNER_INTERVAL_MS);
    this.#spinnerTimer.unref();
  }

  #stopSpinner(): void {
    if (this.#run) this.#run.running = false;
    if (!this.#spinnerTimer) return;
    clearInterval(this.#spinnerTimer);
    this.#spinnerTimer = null;
  }

  #terminate(signal: NodeJS.Signals): void {
    if (!this.#active) return;
    this.stop();
    process.kill(process.pid, signal);
  }

  #onFatalError = (): void => this.stop();

  #onProcessExit = (): void => {
    if (!this.#active) return;
    try {
      this.stdin.setRawMode(false);
      this.stdout.write(LEAVE_TERMINAL);
    } catch {
      // Process exit must not be delayed by terminal cleanup failures.
    }
  };

  #onResize = (): void => {
    this.#lastRenderedLines = [];
    this.render(true);
  };

  #onKeypress = (character: string, key: Key): void => {
    // Ctrl+C is evaluated before everything else, especially before the paste
    // buffer: a paste without an end marker must never freeze the exit (B12).
    if (key.ctrl && key.name === "c") {
      this.#pasting = false;
      this.#pasteBuffer = "";
      this.#interrupt();
      return;
    }
    if (key.name === "paste-start") {
      this.#pasting = true;
      this.#pasteBuffer = "";
      this.setStatus("Einfügen läuft …", false);
      this.scheduleRender(true);
      return;
    }
    if (key.name === "paste-end") {
      if (this.#pasting) this.#finishPaste();
      return;
    }
    if (this.#pasting) {
      if (key.name === "enter" || key.name === "return") this.#pasteBuffer += "\n";
      else if (key.name === "tab") this.#pasteBuffer += "\t";
      else if (character) this.#pasteBuffer += character;
      return;
    }
    if (this.#mode === "model-picker" || this.#mode === "choice-picker") {
      this.#handleSelectKey(character, key);
      return;
    }
    if (this.#mode === "secret") {
      if (key.name === "return") this.#resolveSecret(this.#inputChars.join("").trim());
      else if (key.name === "escape") this.#resolveSecret(null);
      else {
        this.#editInput(character, key, false);
        this.scheduleRender();
      }
      return;
    }
    if (this.#mode === "recording") {
      if (key.name === "return") this.#resolveRecording("stop");
      else if (key.name === "escape") this.#resolveRecording("cancel");
      return;
    }
    // A6: page size is the viewport height minus 2, not a terminal-wide guess.
    if (key.name === "pageup" || key.name === "pagedown") {
      const viewportHeight = this.#lastChatHeight || Math.max(5, (this.stdout.rows || 24) - 6);
      const page = Math.max(1, viewportHeight - 2);
      this.#scroll(key.name === "pageup" ? -page : page);
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && (key.name === "home" || key.name === "end")) {
      this.#scroll(key.name === "home" ? -1_000_000 : 1_000_000);
      this.scheduleRender(true);
      return;
    }
    // While the view is scrolled back, End is the promised way home; only then
    // does it take precedence over "cursor to end of line".
    if (key.name === "end" && this.#viewport.anchor !== "tail") {
      this.#viewport = TAIL;
      this.scheduleRender(true);
      return;
    }
    if (this.#mode === "confirm") {
      // `g` (Begründung) opens a one-line reason prompt; everything else
      // still resolves the approval directly.
      if (this.#confirmReasonMode) {
        if (key.name === "return") {
          const reason = this.#inputChars.join("").trim();
          this.#resolveConfirm({ accepted: false, reason: reason || undefined });
        } else if (key.name === "escape") {
          this.#confirmReasonMode = false;
          this.#resetQuery();
          this.setStatus("Bestätigung erforderlich", false);
          this.#mode = "confirm";
          this.scheduleRender(true);
        } else {
          this.#editInput(character, key, false);
          this.scheduleRender(true);
        }
        return;
      }
      // `j`/`y` yes, `a` always allow, `d` never allow, `g` Begründung; an
      // unbound key answers instead of staying silent (Bauplan 2.5).
      if (key.name === "y" || key.name === "j") this.#resolveConfirm({ accepted: true });
      else if (key.name === "a") this.#resolveConfirm({ accepted: true, remember: "allow" });
      else if (key.name === "d") this.#resolveConfirm({ accepted: false, remember: "deny" });
      else if (key.name === "g") {
        this.#confirmReasonMode = true;
        this.#resetQuery();
        this.setStatus("Begründung eingeben · Enter senden · Esc zurück", false);
        this.scheduleRender(true);
      } else if (key.name === "n" || key.name === "escape" || key.name === "return") {
        this.#resolveConfirm({ accepted: false });
      } else {
        this.setStatus("Nicht belegt · j ja · n nein · a immer · d nie · g Begründung · Enter = nein", false);
        this.#mode = "confirm";
        this.scheduleRender(true);
      }
      return;
    }
    if (this.#mode !== "input" && this.#mode !== "busy") return;
    // B9: the reasoning panel toggles on Ctrl+T only. A bare `T` stays text.
    if (key.ctrl && key.name === "t") {
      const reasoning = [...this.#vm.blocks].reverse().find((item) => item.kind === "reasoning");
      if (reasoning && this.#vm.toggle(reasoning.id)) this.scheduleRender(true);
      return;
    }
    if (this.#handleLineEditKey(key)) {
      this.scheduleRender(true);
      return;
    }
    // A6: Ctrl+R opens inline completion over the user's own history.
    if (key.ctrl && key.name === "r") {
      this.#historyActive = !this.#historyActive;
      this.#historySelectedIndex = 0;
      this.scheduleRender(true);
      return;
    }
    if ((key.name === "return" || key.name === "enter") && key.shift) {
      this.#inputChars.splice(this.#cursor, 0, "\n");
      this.#cursor += 1;
      const lines = lineCount(this.#inputChars.join(""));
      this.setStatus(`${lines} Eingabezeilen · Enter sendet alles gemeinsam`, false);
      this.scheduleRender(true);
      return;
    }
    if (this.#historyActive && this.#handleHistoryKey(key)) return;
    if (this.#suggestedReplies.length && !this.#inputChars.length && this.#mode === "input") {
      if (this.#handleReplyKey(key)) return;
    }
    if (this.#inputChars[0] === "/" && !this.#listClosed && this.#handlePaletteKey(key)) return;
    if (this.#atToken() && !this.#atClosed && this.#handleAtKey(key)) return;
    if (key.name === "return") {
      this.#submit();
      return;
    }
    // A6: Esc closes an open accessory (handled above); with nothing open, it
    // must not silently wipe the buffer (heutiger Bug) — it stays "not belegt".
    if (key.name === "escape") return;
    const previousToken = slashCommandToken(this.#inputChars.join(""));
    this.#editInput(character, key, true);
    if (slashCommandToken(this.#inputChars.join("")) !== previousToken) {
      this.#commandSelectedIndex = 0;
      this.#listClosed = false;
    }
    if (!this.#atToken()) this.#atClosed = false;
    this.scheduleRender(this.#inputChars[0] === "/");
  };

  #interrupt(): void {
    if (this.#mode === "model-picker" || this.#mode === "choice-picker") {
      this.#resolveSelection(null);
    } else if (this.#mode === "secret") {
      this.#resolveSecret(null);
    } else if (this.#mode === "recording") {
      this.#resolveRecording("cancel");
    } else if (this.#mode === "confirm") {
      this.#resolveConfirm({ accepted: false });
      this.#requestCancel();
    } else if (this.#inputReject) {
      const reject = this.#inputReject;
      this.#clearInputPromise();
      reject(new UiExitError());
    } else {
      this.#requestCancel();
    }
  }

  /** Returns true when the key belonged to the quick reply list. */
  #handleReplyKey(key: Key): boolean {
    const count = this.#suggestedReplies.length;
    if (key.name === "up") {
      this.#suggestedReplyIndex = (this.#suggestedReplyIndex - 1 + count) % count;
    } else if (key.name === "down" || key.name === "tab") {
      this.#suggestedReplyIndex = (this.#suggestedReplyIndex + 1) % count;
    } else if (key.name === "escape") {
      this.#clearSuggestedReplies();
    } else {
      return false;
    }
    this.scheduleRender(true);
    return true;
  }

  /** Returns true when the key belonged to the open command list. */
  #handlePaletteKey(key: Key): boolean {
    const matches = this.#commandMatches();
    const selected = matches[this.#commandSelectedIndex];
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      this.#commandSelectedIndex = matches.length
        ? clamp(this.#commandSelectedIndex + step, 0, matches.length - 1)
        : 0;
    } else if (key.name === "escape") {
      // Esc closes the list and leaves the typed text alone — exactly what the
      // help line promises.
      this.#listClosed = true;
    } else if (key.name === "tab") {
      if (selected) this.#completeSlashCommand(selected, true);
    } else if (key.name === "return" && selected) {
      const input = this.#inputChars.join("");
      if (commandTokenIsExact(input, selected)) return false;
      // The first Enter completes — to the common prefix when the input is
      // ambiguous — and only the second one executes.
      const prefix = commonPrefix(matches.map((command) => `/${command.name}`));
      if (prefix.length > input.length) {
        this.#inputChars = Array.from(prefix);
        this.#cursor = this.#inputChars.length;
      } else {
        this.#completeSlashCommand(selected, false);
      }
    } else {
      return false;
    }
    this.scheduleRender(true);
    return true;
  }

  #submit(): void {
    const typed = this.#inputChars.join("").trim();
    const value =
      typed ||
      (this.#mode === "input" ? this.#suggestedReplies[this.#suggestedReplyIndex] ?? "" : "");
    this.#clearSuggestedReplies();
    if (value) {
      this.#history.push(value);
      if (this.#history.length > 100) this.#history = this.#history.slice(-100);
    }
    this.#resetQuery();
    this.#commandSelectedIndex = 0;
    this.#listClosed = false;
    if (this.#mode === "busy") {
      if (value) {
        this.#queuedInputs.push(value);
        const count = this.#queuedInputs.length;
        this.#enterMode(
          "busy",
          `${count} Nachricht${count === 1 ? "" : "en"} vorgemerkt · aktueller Lauf arbeitet weiter`,
        );
      } else {
        this.scheduleRender(true);
      }
      return;
    }
    const resolve = this.#inputResolve;
    this.#clearInputPromise();
    this.#enterMode("busy", value ? "Eingabe wird verarbeitet" : "Bereit");
    resolve?.(value);
  }

  /** Start of the logical line the cursor is on (Bauplan A6, Ctrl+A). */
  #lineStart(): number {
    let index = this.#cursor;
    while (index > 0 && this.#inputChars[index - 1] !== "\n") index -= 1;
    return index;
  }

  /** End of the logical line the cursor is on (Bauplan A6, Ctrl+E). */
  #lineEnd(): number {
    let index = this.#cursor;
    while (index < this.#inputChars.length && this.#inputChars[index] !== "\n") index += 1;
    return index;
  }

  #wordLeft(from: number): number {
    let index = from;
    while (index > 0 && this.#inputChars[index - 1] === " ") index -= 1;
    while (index > 0 && this.#inputChars[index - 1] !== " " && this.#inputChars[index - 1] !== "\n") {
      index -= 1;
    }
    return index;
  }

  #wordRight(from: number): number {
    let index = from;
    const total = this.#inputChars.length;
    while (index < total && this.#inputChars[index] === " ") index += 1;
    while (index < total && this.#inputChars[index] !== " " && this.#inputChars[index] !== "\n") {
      index += 1;
    }
    return index;
  }

  /**
   * Line-oriented editing (Bauplan A6): Ctrl+A/E, Ctrl+U/K, Ctrl+W, Alt+←/→,
   * Ctrl+L. Returns true when the key was one of these.
   */
  #handleLineEditKey(key: Key): boolean {
    if (key.ctrl && key.name === "a") {
      this.#cursor = this.#lineStart();
    } else if (key.ctrl && key.name === "e") {
      this.#cursor = this.#lineEnd();
    } else if (key.ctrl && key.name === "u") {
      const start = this.#lineStart();
      this.#inputChars.splice(start, this.#cursor - start);
      this.#cursor = start;
    } else if (key.ctrl && key.name === "k") {
      const end = this.#lineEnd();
      this.#inputChars.splice(this.#cursor, end - this.#cursor);
    } else if (key.ctrl && key.name === "w") {
      const start = this.#wordLeft(this.#cursor);
      this.#inputChars.splice(start, this.#cursor - start);
      this.#cursor = start;
    } else if (key.meta && key.name === "left") {
      this.#cursor = this.#wordLeft(this.#cursor);
    } else if (key.meta && key.name === "right") {
      this.#cursor = this.#wordRight(this.#cursor);
    } else if (key.ctrl && key.name === "l") {
      this.#forgetGeometry();
    } else {
      return false;
    }
    return true;
  }

  #editInput(character: string, key: Key, allowHistory: boolean): void {
    const chars = this.#inputChars;
    if (key.name === "backspace") {
      if (this.#cursor > 0) {
        chars.splice(this.#cursor - 1, 1);
        this.#cursor -= 1;
      }
    } else if (key.name === "delete") chars.splice(this.#cursor, 1);
    else if (key.name === "left") this.#cursor = Math.max(0, this.#cursor - 1);
    else if (key.name === "right") this.#cursor = Math.min(chars.length, this.#cursor + 1);
    else if (key.name === "home") this.#cursor = 0;
    else if (key.name === "end") this.#cursor = chars.length;
    else if (allowHistory && (key.name === "up" || key.name === "down")) {
      this.#recallHistory(key.name === "up" ? -1 : 1);
    } else if (character && !key.ctrl && !key.meta && !isFunctionKey(key.name)) {
      const inserted = Array.from(character).filter((value) => value >= " ");
      chars.splice(this.#cursor, 0, ...inserted);
      this.#cursor += inserted.length;
    }
  }

  /** Both list pickers share one key map; only the item source differs. */
  #handleSelectKey(character: string, key: Key): void {
    const models = this.#mode === "model-picker";
    const items: Array<ModelInfo | ChoicePickerItem> = models
      ? this.#pickerModels
      : this.#choiceItems;
    if (key.name === "escape") {
      this.#resolveSelection(null);
      return;
    }
    if (key.name === "return") {
      this.#resolveSelection(items[this.#selectedIndex] ?? null);
      return;
    }
    const step =
      key.name === "up"
        ? -1
        : key.name === "down"
          ? 1
          : key.name === "pageup"
            ? -8
            : key.name === "pagedown"
              ? 8
              : 0;
    if (step !== 0) {
      this.#selectedIndex = items.length
        ? clamp(this.#selectedIndex + step, 0, items.length - 1)
        : 0;
    } else {
      const previous = this.#inputChars.join("");
      this.#editInput(character, key, false);
      if (this.#inputChars.join("") !== previous) {
        if (models) this.#refreshPicker();
        else this.#refreshChoices();
      }
    }
    this.scheduleRender(true);
  }

  #refreshPicker(): void {
    this.#pickerModels = (this.#pickerSearch?.(this.#inputChars.join("")) ?? []).slice(0, 80);
    const index = this.#pickerModels.findIndex((model) => model.id === this.#pickerCurrent);
    this.#selectedIndex = Math.max(0, index);
  }

  #refreshChoices(): void {
    const query = this.#inputChars.join("").trim().toLowerCase();
    this.#choiceItems = this.#choiceAll
      .map((item, index) => ({ item, index, score: choiceSearchScore(item, query) }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ item }) => item);
    const index = query
      ? 0
      : this.#choiceItems.findIndex((item) => item.value === this.#choiceInitial);
    this.#selectedIndex = Math.max(0, index);
  }

  #resolveSelection(value: ModelInfo | ChoicePickerItem | null): void {
    const pickerResolve = this.#pickerResolve;
    const choiceResolve = this.#choiceResolve;
    this.#pickerResolve = null;
    this.#choiceResolve = null;
    this.#pickerSearch = null;
    this.#pickerModels = [];
    this.#choiceAll = [];
    this.#choiceItems = [];
    this.#choiceCurrent = "";
    this.#choiceInitial = "";
    this.#selectedIndex = 0;
    this.#resetQuery();
    this.#enterMode("busy", value ? "Auswahl wird übernommen" : "Auswahl abgebrochen");
    if (pickerResolve) pickerResolve((value as ModelInfo | null) ?? null);
    choiceResolve?.((value as ChoicePickerItem | null) ?? null);
  }

  #resolveSecret(value: string | null): void {
    const resolve = this.#secretResolve;
    this.#secretResolve = null;
    this.#secretLabel = "";
    this.#resetQuery();
    this.#enterMode("busy", value === null ? "Eingabe abgebrochen" : "Key wird geprüft");
    resolve?.(value);
  }

  #resolveRecording(action: "stop" | "cancel"): void {
    const resolve = this.#recordingResolve;
    this.#recordingResolve = null;
    this.#enterMode("busy", action === "stop" ? "Aufnahme wird verarbeitet" : "Aufnahme abgebrochen");
    resolve?.(action);
  }

  #resolveConfirm(decision: ApprovalDecision): void {
    const resolve = this.#confirmResolve;
    this.#confirmResolve = null;
    this.#confirmReasonMode = false;
    this.#resetQuery();
    if (this.#approvalBlockId) {
      this.#vm.dropApproval(this.#approvalBlockId);
      this.#approvalBlockId = null;
    }
    this.#enterMode("busy", decision.accepted ? "Freigabe erteilt" : "Freigabe abgelehnt");
    resolve?.(decision);
  }

  #requestCancel(): void {
    if (this.#cancelRequestedAt && !this.#cancelHandler) {
      this.#terminate("SIGINT");
      return;
    }
    if (!this.#cancelHandler) {
      this.setStatus("Dieser Vorgang kann gerade nicht abgebrochen werden.", false);
      return;
    }
    this.#cancelRequestedAt = Date.now();
    this.#status = "Abbruch angefordert · erneut Ctrl+C beendet orcode sofort";
    this.#statusAt = Date.now();
    const handler = this.#cancelHandler;
    this.#cancelHandler = null;
    handler();
    this.scheduleRender(true);
  }

  #recallHistory(direction: -1 | 1): void {
    if (!this.#history.length) return;
    this.#historyIndex = clamp(this.#historyIndex + direction, 0, this.#history.length);
    this.#inputChars = Array.from(this.#history[this.#historyIndex] ?? "");
    this.#cursor = this.#inputChars.length;
  }

  #clearInputPromise(): void {
    this.#inputResolve = null;
    this.#inputReject = null;
  }

  #clearSuggestedReplies(): void {
    this.#suggestedReplies = [];
    this.#suggestedReplyIndex = 0;
  }

  #finishPaste(): void {
    const clean = sanitizeTerminalText(this.#pasteBuffer)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ");
    this.#pasting = false;
    this.#pasteBuffer = "";
    if (!clean) {
      this.setStatus("Einfügen enthielt keinen verwendbaren Text", false);
      this.scheduleRender(true);
      return;
    }
    const chars = Array.from(clean);
    this.#inputChars.splice(this.#cursor, 0, ...chars);
    this.#cursor += chars.length;
    const lines = lineCount(clean);
    this.#commandSelectedIndex = 0;
    this.#listClosed = false;
    this.setStatus(
      `${chars.length.toLocaleString("de-DE")} Zeichen · ${lines} Zeile${
        lines === 1 ? "" : "n"
      } eingefügt · Enter sendet alles gemeinsam`,
      false,
    );
    this.scheduleRender(true);
  }

  #commandMatches(): SlashCommandDefinition[] {
    const matches = rankSlashCommands(this.#inputChars.join(""));
    if (this.#commandSelectedIndex >= matches.length) {
      this.#commandSelectedIndex = Math.max(0, matches.length - 1);
    }
    return matches;
  }

  #completeSlashCommand(command: SlashCommandDefinition, appendArgumentSpace: boolean): void {
    const input = this.#inputChars.join("");
    const parts = command.name.split(/\s+/);
    const rootRemainder = input.match(/^\/\S*(.*)$/s)?.[1] ?? "";
    const typedRoot = input.slice(1).trimStart().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const name =
      parts.length === 1 && command.aliases?.includes(typedRoot) ? typedRoot : command.name;
    const remainder =
      parts.length > 1 ? rootRemainder.trimStart().match(/^\S+(.*)$/s)?.[1] ?? "" : rootRemainder;
    const suffix = remainder || (appendArgumentSpace && command.acceptsArguments ? " " : "");
    this.#inputChars = Array.from(`/${name}${suffix}`);
    this.#cursor = this.#inputChars.length;
    this.#commandSelectedIndex = 0;
  }

  /** A6, Ctrl+R: the user's own history, most recent first, deduplicated. */
  #historyMatches(): string[] {
    const query = this.#inputChars.join("").trim().toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      const value = this.#history[index]!;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      if (query && !key.includes(query)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= 50) break;
    }
    return out;
  }

  /** Returns true when the key belonged to the open history search. */
  #handleHistoryKey(key: Key): boolean {
    const matches = this.#historyMatches();
    if (this.#historySelectedIndex >= matches.length) {
      this.#historySelectedIndex = Math.max(0, matches.length - 1);
    }
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      this.#historySelectedIndex = matches.length
        ? clamp(this.#historySelectedIndex + step, 0, matches.length - 1)
        : 0;
    } else if (key.name === "escape") {
      this.#historyActive = false;
    } else if (key.name === "tab" || key.name === "return") {
      const selected = matches[this.#historySelectedIndex];
      if (selected) {
        this.#inputChars = Array.from(selected);
        this.#cursor = this.#inputChars.length;
      }
      this.#historyActive = false;
    } else {
      return false;
    }
    this.scheduleRender(true);
    return true;
  }

  /**
   * A6, `@`: the token under the cursor when it starts with `@` — the
   * trigger works anywhere in the line, not only at position 0 like `/`.
   */
  #atToken(): { start: number; query: string } | null {
    const chars = this.#inputChars;
    let start = this.#cursor;
    while (start > 0 && chars[start - 1] !== " " && chars[start - 1] !== "\n") start -= 1;
    if (chars[start] !== "@" || this.#cursor < start) return null;
    return { start, query: chars.slice(start + 1, this.#cursor).join("") };
  }

  /** Fuzzy-scored workspace files for `@`, analogous to `choiceSearchScore`. */
  #atMatches(query: string): string[] {
    const files = this.#listWorkspaceFiles(this.getState().workspace);
    const needle = query.toLowerCase();
    if (!needle) return files.slice(0, 50);
    return files
      .map((path) => ({ path, score: fuzzyPathScore(path, needle) }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map((item) => item.path);
  }

  /** `.gitignore`-unaware but node_modules/.git/dotfile-blind directory walk. */
  #listWorkspaceFiles(root: string): readonly string[] {
    if (this.#atFilesCache?.root === root) return this.#atFilesCache.files;
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || out.length >= 4_000) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= 4_000) return;
        if (isIgnoredWorkspaceEntry(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) out.push(relative(root, full));
      }
    };
    walk(root, 0);
    this.#atFilesCache = { root, files: out };
    return out;
  }

  /** Returns true when the key belonged to the open file completion. */
  #handleAtKey(key: Key): boolean {
    const token = this.#atToken();
    if (!token) return false;
    const matches = this.#atMatches(token.query);
    if (this.#atSelectedIndex >= matches.length) {
      this.#atSelectedIndex = Math.max(0, matches.length - 1);
    }
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      this.#atSelectedIndex = matches.length
        ? clamp(this.#atSelectedIndex + step, 0, matches.length - 1)
        : 0;
    } else if (key.name === "escape") {
      this.#atClosed = true;
    } else if (key.name === "tab" || key.name === "return") {
      const selected = matches[this.#atSelectedIndex];
      if (!selected) return false;
      this.#insertAtCompletion(token, selected);
    } else {
      return false;
    }
    this.scheduleRender(true);
    return true;
  }

  /** The relative path replaces the whole `@query` token, `@` included. */
  #insertAtCompletion(token: { start: number; query: string }, relativePath: string): void {
    const replacement = Array.from(`${relativePath} `);
    this.#inputChars.splice(token.start, this.#cursor - token.start, ...replacement);
    this.#cursor = token.start + replacement.length;
    this.#atClosed = false;
    this.#atSelectedIndex = 0;
  }
}
