import chalk from "chalk";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  commandTokenIsExact,
  rankSlashCommands,
  type SlashCommandDefinition,
} from "./command-catalog.js";
import type {
  AgentRunEvent,
  ChatTurn,
  ModelInfo,
  ToolCallPreview,
} from "./types.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_AND_HOME = "\u001b[2J\u001b[H";
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g;
const STRING_SEQUENCE = /\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/g;
const ESCAPE_SEQUENCE = /\u001b[@-_]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MAX_REASONING_PANEL_CHARACTERS = 16_000;

export type UiMessageRole = "user" | "assistant" | "system" | "error";

export interface UiMessage {
  role: UiMessageRole;
  content: string;
  meta?: string;
  createdAt?: string;
}

export interface DashboardState {
  workspace: string;
  projectStatus?: string;
  model: string;
  modelDetails?: string;
  resolvedModel?: string;
  approval: string;
  compressor: string;
  compressorModel: string;
  reasoning: string;
  balance: string;
  sessionCost: string;
  maxCost: string;
  maxSteps: number;
  keyStatus: string;
}

export interface DashboardLayoutInput {
  width: number;
  height: number;
  state: DashboardState;
  messages: readonly UiMessage[];
  input: string;
  cursor: number;
  scrollOffset: number;
  status: string;
  busy: boolean;
  queuedCount?: number;
  run?: RunStatusLayoutInput;
  picker?: ModelPickerLayoutInput;
  commandPalette?: CommandPaletteLayoutInput;
  choicePicker?: ChoicePickerLayoutInput;
  quickReplies?: QuickReplyLayoutInput;
  reasoningPanel?: ReasoningPanelLayoutInput;
  secret?: {
    label: string;
  };
  confirm?: {
    title: string;
    details: string;
  };
}

export interface RunStatusLayoutInput {
  model: string;
  phase: string;
  startedAt: number;
  lastEventAt: number;
  step: number;
  maxSteps: number;
  toolCount: number;
  activeTools: Array<{
    id: string;
    name: string;
    summary: string;
    startedAt: number;
  }>;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  now?: number;
}

export interface ModelPickerLayoutInput {
  title: string;
  query: string;
  cursor: number;
  models: readonly ModelInfo[];
  selectedIndex: number;
  currentModel: string;
}

export interface CommandPaletteLayoutInput {
  input: string;
  commands: readonly SlashCommandDefinition[];
  selectedIndex: number;
}

export interface ChoicePickerItem {
  value: string;
  label: string;
  description: string;
}

export interface ChoicePickerLayoutInput {
  title: string;
  query: string;
  cursor: number;
  items: readonly ChoicePickerItem[];
  selectedIndex: number;
  currentValue: string;
}

export interface QuickReplyLayoutInput {
  items: readonly string[];
  selectedIndex: number;
}

export interface ReasoningPanelLayoutInput {
  model: string;
  text: string;
  tokenCount: number;
  expanded: boolean;
  live: boolean;
  truncated: boolean;
}

export interface DashboardLayout {
  lines: string[];
  chatHeight: number;
  maxScrollOffset: number;
}

export class UiExitError extends Error {
  constructor() {
    super("RouterCode wurde beendet.");
    this.name = "UiExitError";
  }
}

type UiMode =
  | "idle"
  | "input"
  | "busy"
  | "confirm"
  | "model-picker"
  | "choice-picker"
  | "secret";

export class TerminalUi {
  readonly supported: boolean;
  #messages: UiMessage[] = [];
  #inputChars: string[] = [];
  #cursor = 0;
  #scrollOffset = 0;
  #status = "Bereit";
  #mode: UiMode = "idle";
  #active = false;
  #renderTimer: NodeJS.Timeout | null = null;
  #inputResolve: ((value: string) => void) | null = null;
  #inputReject: ((error: Error) => void) | null = null;
  #confirmResolve: ((accepted: boolean) => void) | null = null;
  #confirmState: { title: string; details: string } | null = null;
  #assistantIndex: number | null = null;
  #history: string[] = [];
  #historyIndex = 0;
  #queuedInputs: string[] = [];
  #pickerSearch: ((query: string) => readonly ModelInfo[]) | null = null;
  #pickerModels: ModelInfo[] = [];
  #pickerSelectedIndex = 0;
  #pickerCurrentModel = "";
  #pickerTitle = "Modell auswählen";
  #pickerResolve: ((model: ModelInfo | null) => void) | null = null;
  #commandSelectedIndex = 0;
  #choiceTitle = "";
  #choiceAllItems: ChoicePickerItem[] = [];
  #choiceItems: ChoicePickerItem[] = [];
  #choiceSelectedIndex = 0;
  #choiceCurrentValue = "";
  #choiceInitialValue = "";
  #choiceResolve: ((choice: ChoicePickerItem | null) => void) | null = null;
  #suggestedReplies: string[] = [];
  #suggestedReplyIndex = 0;
  #reasoningPanel: ReasoningPanelLayoutInput | null = null;
  #secretLabel = "";
  #secretResolve: ((value: string | null) => void) | null = null;
  #cancelHandler: (() => void) | null = null;
  #cancelRequestedAt = 0;
  #followTail = true;
  #lastRenderedLines: string[] = [];
  #lastWidth = 0;
  #lastHeight = 0;
  #runState: RunStatusLayoutInput | null = null;
  #runClockTimer: NodeJS.Timeout | null = null;
  readonly #toolMessageIndices = new Map<string, number>();

  constructor(
    private readonly getState: () => DashboardState,
    private readonly stdin = process.stdin as ReadStream,
    private readonly stdout = process.stdout as WriteStream,
  ) {
    this.supported = Boolean(
      stdin.isTTY &&
      stdout.isTTY &&
      typeof stdin.setRawMode === "function",
    );
  }

  get active(): boolean {
    return this.#active;
  }

  loadTurns(turns: readonly ChatTurn[], maximum = 12): void {
    this.#clearSuggestedReplies();
    this.#reasoningPanel = null;
    this.#messages = turns.slice(-maximum).map((turn) => ({
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
    }));
  }

  addMessage(
    role: UiMessageRole,
    content: string,
    meta?: string,
  ): number | null {
    const clean = sanitizeTerminalText(content).trim();
    if (!clean) {
      return null;
    }
    const width = this.#chatWidth();
    const previousLineCount = this.#followTail
      ? 0
      : buildChatLines(this.#messages, width).length;
    this.#messages.push({
      role,
      content: clean,
      meta,
      createdAt: new Date().toISOString(),
    });
    if (this.#messages.length > 120) {
      const removed = this.#messages.length - 120;
      this.#messages = this.#messages.slice(removed);
      for (const [id, index] of this.#toolMessageIndices) {
        if (index < removed) {
          this.#toolMessageIndices.delete(id);
        } else {
          this.#toolMessageIndices.set(id, index - removed);
        }
      }
      if (this.#assistantIndex !== null) {
        this.#assistantIndex = Math.max(
          0,
          this.#assistantIndex - removed,
        );
      }
    }
    this.#stabilizeScroll(previousLineCount, width);
    this.scheduleRender();
    return this.#messages.length - 1;
  }

  /**
   * Keeps the viewport stable for users who scrolled up: new content must not
   * yank them back to the tail. When following the tail, stay at offset 0.
   */
  #stabilizeScroll(previousLineCount: number, width: number): void {
    if (this.#followTail) {
      this.#scrollOffset = 0;
      return;
    }
    const nextLineCount = buildChatLines(this.#messages, width).length;
    this.#scrollOffset += Math.max(0, nextLineCount - previousLineCount);
  }

  #chatWidth(): number {
    return Math.max(40, this.stdout.columns || 80) - 1;
  }

  beginAssistant(model: string): void {
    this.#clearSuggestedReplies();
    this.#reasoningPanel = null;
    this.#messages.push({
      role: "assistant",
      content: "",
      meta: model,
      createdAt: new Date().toISOString(),
    });
    this.#assistantIndex = this.#messages.length - 1;
    this.#scrollOffset = 0;
    this.#followTail = true;
    this.#mode = "busy";
    this.scheduleRender();
  }

  appendAssistant(delta: string): void {
    if (this.#assistantIndex === null) {
      this.beginAssistant(this.getState().model);
    }
    const width = this.#chatWidth();
    const previousLineCount = this.#followTail
      ? 0
      : buildChatLines(this.#messages, width).length;
    const message = this.#messages[this.#assistantIndex!];
    const cleanDelta = sanitizeTerminalText(delta);
    message.content += cleanDelta;
    if (cleanDelta && this.#runState) {
      this.#runState.phase = "Modell streamt Antwort";
      this.#runState.lastEventAt = Date.now();
    }
    this.#stabilizeScroll(previousLineCount, width);
    this.scheduleRender();
  }

  finishAssistant(fallback = ""): void {
    if (this.#assistantIndex !== null) {
      const message = this.#messages[this.#assistantIndex];
      if (!message.content.trim() && fallback.trim()) {
        message.content = sanitizeTerminalText(fallback).trim();
      } else if (!message.content.trim()) {
        this.#messages.splice(this.#assistantIndex, 1);
      }
    }
    this.#assistantIndex = null;
    this.finishRun();
    this.#mode = "idle";
    this.#status = "Bereit";
    this.scheduleRender(true);
  }

  setSuggestedReplies(replies: readonly string[]): void {
    const clean: string[] = [];
    for (const reply of replies) {
      const value = sanitizeTerminalText(reply)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
      if (
        value &&
        !clean.some(
          (existing) => existing.toLowerCase() === value.toLowerCase(),
        )
      ) {
        clean.push(value);
      }
      if (clean.length === 4) {
        break;
      }
    }
    this.#suggestedReplies = clean;
    this.#suggestedReplyIndex = 0;
    this.scheduleRender(true);
  }

  setStatus(status: string, busy = true): void {
    this.#status = sanitizeTerminalText(status).replace(/\s+/g, " ").trim() || "Bereit";
    if (busy && this.#runState) {
      this.#runState.phase = this.#status;
      this.#runState.lastEventAt = Date.now();
    }
    if (busy && this.#mode !== "confirm") {
      this.#mode = "busy";
    } else if (!busy && this.#mode === "busy") {
      this.#mode = "idle";
    }
    this.scheduleRender();
  }

  refresh(): void {
    this.scheduleRender(true);
  }

  setCancelHandler(handler?: () => void): void {
    this.#cancelHandler = handler ?? null;
    this.#cancelRequestedAt = 0;
  }

  handleRunEvent(event: AgentRunEvent): void {
    if (event.type === "run-start") {
      this.#runState = {
        model: event.model,
        phase: "Lauf wird vorbereitet",
        startedAt: event.timestamp,
        lastEventAt: event.timestamp,
        step: 1,
        maxSteps: event.maxSteps,
        toolCount: 0,
        activeTools: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      };
      this.#reasoningPanel = {
        model: event.model,
        text: "",
        tokenCount: 0,
        expanded: false,
        live: true,
        truncated: false,
      };
      this.#toolMessageIndices.clear();
      this.#mode = "busy";
      this.#ensureRunClock();
      this.scheduleRender(true);
      return;
    }

    const run = this.#runState;
    if (!run) {
      return;
    }
    run.lastEventAt = event.timestamp;

    if (event.type === "model-start") {
      run.model = event.model;
      run.step = event.step;
      run.phase = "Modell wartet";
    } else if (event.type === "model-end") {
      run.model = event.model;
      run.step = event.step;
      run.phase = "Modellantwort empfangen";
      run.inputTokens += event.inputTokens;
      run.outputTokens += event.outputTokens;
      run.reasoningTokens += event.reasoningTokens;
      run.costUsd += event.costUsd;
      if (this.#reasoningPanel) {
        this.#reasoningPanel.model = event.model;
        this.#reasoningPanel.tokenCount += event.reasoningTokens;
      }
    } else if (event.type === "reasoning") {
      run.model = event.model;
      run.step = event.step;
      run.phase = "Modell denkt";
      this.#appendReasoning(event.model, event.delta);
    } else if (event.type === "tool-start") {
      this.#closeAssistantSegment();
      const summary = toolInputSummary(event.name, event.input);
      run.toolCount = Math.max(run.toolCount, event.number);
      run.activeTools.push({
        id: event.id,
        name: event.name,
        summary,
        startedAt: event.timestamp,
      });
      run.phase = `${toolLabel(event.name)} läuft`;
      const index = this.addMessage(
        "system",
        [`▶ ${toolLabel(event.name)} gestartet`, summary].join("\n"),
        `Tool ${event.number}`,
      );
      if (index !== null) {
        this.#toolMessageIndices.set(event.id, index);
      }
    } else if (event.type === "tool-end") {
      run.toolCount = Math.max(run.toolCount, event.number);
      this.#finishToolMessage(
        event.id,
        event.number,
        event.name,
        event.input,
        `✓ ${toolLabel(event.name)} beendet · ${formatToolDuration(event.durationMs)}`,
        toolOutputSummary(event.name, event.output),
      );
      run.activeTools = run.activeTools.filter(
        (tool) => tool.id !== event.id,
      );
      run.phase = run.activeTools.length
        ? `${run.activeTools.length} Tools laufen`
        : "Modell verarbeitet Tool-Ergebnis";
    } else if (event.type === "tool-error") {
      run.toolCount = Math.max(run.toolCount, event.number);
      this.#finishToolMessage(
        event.id,
        event.number,
        event.name,
        event.input,
        `✗ ${toolLabel(event.name)} fehlgeschlagen · ${formatToolDuration(event.durationMs)}`,
        oneLine(event.error),
      );
      run.activeTools = run.activeTools.filter(
        (tool) => tool.id !== event.id,
      );
      run.phase = run.activeTools.length
        ? `${run.activeTools.length} Tools laufen`
        : "Modell verarbeitet Toolfehler";
    } else if (event.type === "run-end") {
      run.toolCount = Math.max(run.toolCount, event.toolCount);
      run.phase =
        event.outcome === "complete"
          ? "Lauf beendet"
          : event.outcome === "cancelled"
            ? "Lauf abgebrochen"
            : "Lauf fehlgeschlagen";
      this.#stopRunClock();
      if (this.#reasoningPanel) {
        this.#reasoningPanel.live = false;
      }
    }
    this.scheduleRender(true);
  }

  finishRun(): void {
    this.#stopRunClock();
    if (this.#reasoningPanel) {
      this.#reasoningPanel.live = false;
    }
    this.#runState = null;
    this.#toolMessageIndices.clear();
  }

  pickModel(
    searchModels: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title = "Modell auswählen",
  ): Promise<ModelInfo | null> {
    if (!this.#active) {
      throw new Error("Die Terminal-Oberfläche ist nicht aktiv.");
    }
    this.#pickerSearch = searchModels;
    this.#pickerCurrentModel = currentModel;
    this.#pickerTitle =
      sanitizeTerminalText(title).replace(/\s+/g, " ").trim() ||
      "Modell auswählen";
    this.#inputChars = [];
    this.#cursor = 0;
    this.#refreshPicker();
    this.#mode = "model-picker";
    this.#status = "Modell auswählen";
    this.scheduleRender(true);
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
    if (!this.#active) {
      throw new Error("Die Terminal-Oberfläche ist nicht aktiv.");
    }
    this.#choiceTitle = sanitizeTerminalText(title).replace(/\s+/g, " ").trim();
    this.#choiceAllItems = [...items];
    this.#choiceCurrentValue = currentValue;
    this.#choiceInitialValue = initialValue;
    this.#inputChars = [];
    this.#cursor = 0;
    this.#refreshChoices();
    this.#mode = "choice-picker";
    this.#status = `${this.#choiceTitle} auswählen`;
    this.scheduleRender(true);
    return new Promise<ChoicePickerItem | null>((resolve) => {
      this.#choiceResolve = resolve;
    });
  }

  readSecret(label: string): Promise<string | null> {
    if (!this.#active) {
      throw new Error("Die Terminal-Oberfläche ist nicht aktiv.");
    }
    this.#secretLabel = sanitizeTerminalText(label).replace(/\s+/g, " ").trim();
    this.#inputChars = [];
    this.#cursor = 0;
    this.#mode = "secret";
    this.#status = `${this.#secretLabel} verdeckt eingeben`;
    this.scheduleRender(true);
    return new Promise<string | null>((resolve) => {
      this.#secretResolve = resolve;
    });
  }

  confirmAction(title: string, details: string): Promise<boolean> {
    if (!this.#active) {
      return Promise.resolve(false);
    }
    this.#confirmState = {
      title: sanitizeTerminalText(title).replace(/\s+/g, " ").trim(),
      details: sanitizeTerminalText(details).trim(),
    };
    this.#mode = "confirm";
    this.#status = "Bestätigung erforderlich";
    this.scheduleRender(true);
    return new Promise<boolean>((resolve) => {
      this.#confirmResolve = resolve;
    });
  }

  start(): void {
    if (!this.supported || this.#active) {
      return;
    }
    emitKeypressEvents(this.stdin);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.#active = true;
    this.stdin.on("keypress", this.#onKeypress);
    process.on("SIGWINCH", this.#onResize);
    process.on("SIGINT", this.#onSigint);
    process.on("SIGTERM", this.#onSigterm);
    process.on("SIGHUP", this.#onSighup);
    process.on("exit", this.#onProcessExit);
    process.on("uncaughtExceptionMonitor", this.#onFatalError);
    this.stdout.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${CLEAR_AND_HOME}`);
    this.#lastRenderedLines = [];
    this.#lastWidth = 0;
    this.#lastHeight = 0;
    if (this.#runState) {
      this.#ensureRunClock();
    }
    this.render(true);
  }

  stop(): void {
    if (!this.#active) {
      return;
    }
    try {
      this.#detachTerminal();
    } finally {
      try {
        this.stdin.pause();
      } catch {
        // Best-effort cleanup for partially closed terminals.
      }
      try {
        this.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
      } catch {
        // Best-effort cleanup for partially closed terminals.
      }
      this.#lastRenderedLines = [];
      this.#lastWidth = 0;
      this.#lastHeight = 0;
    }
  }

  async suspend<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#active) {
      return operation();
    }
    this.#detachTerminal();
    this.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
    try {
      return await operation();
    } finally {
      this.start();
    }
  }

  readInput(): Promise<string> {
    if (!this.#active) {
      throw new Error("Die Terminal-Oberfläche ist nicht aktiv.");
    }
    const queued = this.#queuedInputs.shift();
    if (queued !== undefined) {
      this.#mode = "busy";
      this.#status = this.#queuedInputs.length
        ? `Vorgemerkte Eingabe wird verarbeitet · ${this.#queuedInputs.length} weitere`
        : "Vorgemerkte Eingabe wird verarbeitet";
      this.scheduleRender(true);
      return Promise.resolve(queued);
    }
    this.#mode = "input";
    this.#status = "Bereit";
    this.#historyIndex = this.#history.length;
    this.#commandSelectedIndex = 0;
    this.scheduleRender(true);
    return new Promise<string>((resolve, reject) => {
      this.#inputResolve = resolve;
      this.#inputReject = reject;
    });
  }

  confirmApproval(preview: ToolCallPreview): Promise<boolean> {
    if (!this.#active) {
      return Promise.resolve(false);
    }
    this.addMessage(
      "system",
      [
        `${riskIcon(preview.risk)} ${preview.summary}`,
        preview.details ?? `Aktion: ${preview.name}`,
      ].join("\n"),
      "Freigabe",
    );
    return this.confirmAction(
      `${riskIcon(preview.risk)} ${preview.summary}`,
      preview.details ?? preview.name,
    );
  }

  render(forceFull = false): void {
    if (!this.#active) {
      return;
    }
    const width = Math.max(40, this.stdout.columns || 80);
    const height = Math.max(12, this.stdout.rows || 24);
    const geometryChanged =
      width !== this.#lastWidth || height !== this.#lastHeight;
    const layout = buildDashboardLayout({
      width,
      height,
      state: this.getState(),
      messages: this.#messages,
      input: this.#inputChars.join(""),
      cursor: this.#cursor,
      scrollOffset: this.#scrollOffset,
      status: this.#status,
      busy: this.#mode === "busy",
      queuedCount: this.#queuedInputs.length,
      run: this.#runState
        ? {
            ...this.#runState,
            activeTools: this.#runState.activeTools.map((tool) => ({
              ...tool,
            })),
            now: Date.now(),
          }
        : undefined,
      picker: this.#mode === "model-picker"
        ? {
            title: this.#pickerTitle,
            query: this.#inputChars.join(""),
            cursor: this.#cursor,
            models: this.#pickerModels,
            selectedIndex: this.#pickerSelectedIndex,
            currentModel: this.#pickerCurrentModel,
          }
        : undefined,
      commandPalette:
        (this.#mode === "input" || this.#mode === "busy") &&
        this.#inputChars[0] === "/"
        ? {
            input: this.#inputChars.join(""),
            commands: this.#commandMatches(),
            selectedIndex: this.#commandSelectedIndex,
          }
        : undefined,
      choicePicker: this.#mode === "choice-picker"
        ? {
            title: this.#choiceTitle,
            query: this.#inputChars.join(""),
            cursor: this.#cursor,
            items: this.#choiceItems,
            selectedIndex: this.#choiceSelectedIndex,
            currentValue: this.#choiceCurrentValue,
          }
        : undefined,
      quickReplies:
        this.#suggestedReplies.length &&
        (this.#mode === "idle" || this.#mode === "input")
          ? {
              items: this.#suggestedReplies,
              selectedIndex: this.#suggestedReplyIndex,
            }
          : undefined,
      reasoningPanel:
        this.#reasoningPanel &&
        (this.#reasoningPanel.text || this.#reasoningPanel.tokenCount > 0)
          ? { ...this.#reasoningPanel }
          : undefined,
      secret: this.#mode === "secret"
        ? { label: this.#secretLabel }
        : undefined,
      confirm: this.#confirmState ?? undefined,
    });
    this.#scrollOffset = Math.min(this.#scrollOffset, layout.maxScrollOffset);
    const styled = layout.lines.map((line, index) =>
      styleDashboardLine(line, index, layout.lines.length),
    );
    if (
      forceFull ||
      geometryChanged ||
      this.#lastRenderedLines.length !== styled.length
    ) {
      this.stdout.write(`${CLEAR_AND_HOME}${styled.join("\r\n")}\u001b[J`);
    } else {
      let output = "";
      for (let index = 0; index < styled.length; index += 1) {
        if (styled[index] !== this.#lastRenderedLines[index]) {
          output += `\u001b[${index + 1};1H${styled[index]}\u001b[K`;
        }
      }
      if (output) {
        this.stdout.write(output);
      }
    }
    this.#lastRenderedLines = styled;
    this.#lastWidth = width;
    this.#lastHeight = height;
  }

  scheduleRender(immediate = false): void {
    if (!this.#active) {
      return;
    }
    if (immediate) {
      if (this.#renderTimer) {
        clearTimeout(this.#renderTimer);
        this.#renderTimer = null;
      }
      this.render();
      return;
    }
    if (this.#renderTimer) {
      return;
    }
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      this.render();
    }, 30);
  }

  #detachTerminal(): void {
    if (this.#renderTimer) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
    }
    this.stdin.off("keypress", this.#onKeypress);
    process.off("SIGWINCH", this.#onResize);
    process.off("SIGINT", this.#onSigint);
    process.off("SIGTERM", this.#onSigterm);
    process.off("SIGHUP", this.#onSighup);
    process.off("exit", this.#onProcessExit);
    process.off("uncaughtExceptionMonitor", this.#onFatalError);
    try {
      this.stdin.setRawMode(false);
    } catch {
      // The terminal may already be closed after a fatal signal.
    }
    this.#active = false;
    this.#lastRenderedLines = [];
    this.#lastWidth = 0;
    this.#lastHeight = 0;
    this.#stopRunClock();
  }

  #ensureRunClock(): void {
    if (this.#runClockTimer) {
      return;
    }
    this.#runClockTimer = setInterval(() => {
      this.scheduleRender(true);
    }, 1_000);
    this.#runClockTimer.unref();
  }

  #stopRunClock(): void {
    if (!this.#runClockTimer) {
      return;
    }
    clearInterval(this.#runClockTimer);
    this.#runClockTimer = null;
  }

  #closeAssistantSegment(): void {
    if (this.#assistantIndex === null) {
      return;
    }
    const index = this.#assistantIndex;
    const message = this.#messages[index];
    if (!message?.content.trim()) {
      this.#messages.splice(index, 1);
      for (const [id, toolIndex] of this.#toolMessageIndices) {
        if (toolIndex > index) {
          this.#toolMessageIndices.set(id, toolIndex - 1);
        }
      }
    }
    this.#assistantIndex = null;
  }

  #finishToolMessage(
    id: string,
    number: number,
    name: string,
    input: Record<string, unknown>,
    headline: string,
    result: string,
  ): void {
    const index = this.#toolMessageIndices.get(id);
    const lines = [
      headline,
      toolInputSummary(name, input),
      result,
    ].filter(Boolean);
    if (index === undefined || !this.#messages[index]) {
      this.addMessage("system", lines.join("\n"), `Tool ${number}`);
      return;
    }
    const width = this.#chatWidth();
    const previousLineCount = this.#followTail
      ? 0
      : buildChatLines(this.#messages, width).length;
    this.#messages[index] = {
      ...this.#messages[index],
      content: sanitizeTerminalText(lines.join("\n")).trim(),
      meta: `Tool ${number}`,
    };
    this.#toolMessageIndices.delete(id);
    this.#stabilizeScroll(previousLineCount, width);
  }

  #terminate(signal: NodeJS.Signals): void {
    if (!this.#active) {
      return;
    }
    this.stop();
    process.kill(process.pid, signal);
  }

  #onSigint = (): void => {
    this.#terminate("SIGINT");
  };

  #onSigterm = (): void => {
    this.#terminate("SIGTERM");
  };

  #onSighup = (): void => {
    this.#terminate("SIGHUP");
  };

  #onProcessExit = (): void => {
    if (!this.#active) {
      return;
    }
    try {
      this.stdin.setRawMode(false);
      this.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
    } catch {
      // Process exit must not be delayed by terminal cleanup failures.
    }
  };

  #onFatalError = (): void => {
    this.stop();
  };

  #onResize = (): void => {
    this.#lastRenderedLines = [];
    this.render(true);
  };

  #onKeypress = (character: string, key: Key): void => {
    if (key.ctrl && key.name === "c") {
      if (this.#mode === "model-picker") {
        this.#resolvePicker(null);
        return;
      }
      if (this.#mode === "choice-picker") {
        this.#resolveChoice(null);
        return;
      }
      if (this.#mode === "secret") {
        this.#resolveSecret(null);
        return;
      }
      if (this.#mode === "confirm") {
        this.#resolveConfirm(false);
        this.#requestCancel();
        return;
      }
      if (this.#inputReject) {
        const reject = this.#inputReject;
        this.#clearInputPromise();
        reject(new UiExitError());
      } else {
        this.#requestCancel();
      }
      return;
    }

    if (this.#mode === "model-picker") {
      this.#handlePickerKey(character, key);
      return;
    }
    if (this.#mode === "choice-picker") {
      this.#handleChoiceKey(character, key);
      return;
    }

    if (this.#mode === "secret") {
      if (key.name === "return") {
        this.#resolveSecret(this.#inputChars.join("").trim());
      } else if (key.name === "escape") {
        this.#resolveSecret(null);
      } else {
        this.#editInput(character, key, false);
        this.scheduleRender();
      }
      return;
    }

    if (key.name === "pageup") {
      this.#scrollOffset += Math.max(4, Math.floor((this.stdout.rows || 24) / 2));
      this.#followTail = false;
      this.scheduleRender(true);
      return;
    }
    if (key.name === "pagedown") {
      this.#scrollOffset = Math.max(
        0,
        this.#scrollOffset - Math.max(4, Math.floor((this.stdout.rows || 24) / 2)),
      );
      this.#followTail = this.#scrollOffset === 0;
      this.scheduleRender(true);
      return;
    }

    if (this.#mode === "confirm") {
      if (key.name === "y") {
        this.#resolveConfirm(true);
      } else if (key.name === "n" || key.name === "escape" || key.name === "return") {
        this.#resolveConfirm(false);
      }
      return;
    }
    if (this.#mode !== "input" && this.#mode !== "busy") {
      return;
    }

    const togglesReasoning =
      (key.ctrl && key.name === "t") ||
      (character === "T" && this.#inputChars.length === 0);
    if (togglesReasoning && this.#reasoningPanel) {
      this.#reasoningPanel.expanded = !this.#reasoningPanel.expanded;
      this.scheduleRender(true);
      return;
    }

    if (
      this.#suggestedReplies.length &&
      this.#inputChars.length === 0 &&
      this.#mode === "input"
    ) {
      if (key.name === "up") {
        this.#suggestedReplyIndex =
          (this.#suggestedReplyIndex - 1 + this.#suggestedReplies.length) %
          this.#suggestedReplies.length;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "down" || key.name === "tab") {
        this.#suggestedReplyIndex =
          (this.#suggestedReplyIndex + 1) % this.#suggestedReplies.length;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "escape") {
        this.#clearSuggestedReplies();
        this.scheduleRender(true);
        return;
      }
    }

    if (this.#inputChars[0] === "/") {
      const matches = this.#commandMatches();
      const selected = matches[this.#commandSelectedIndex];
      if (key.name === "up") {
        this.#commandSelectedIndex = matches.length
          ? Math.max(0, this.#commandSelectedIndex - 1)
          : 0;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "down") {
        this.#commandSelectedIndex = matches.length
          ? Math.min(matches.length - 1, this.#commandSelectedIndex + 1)
          : 0;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "tab") {
        if (selected) {
          this.#completeSlashCommand(selected, true);
          this.scheduleRender(true);
        }
        return;
      }
      if (
        key.name === "return" &&
        selected &&
        !commandTokenIsExact(this.#inputChars.join(""), selected)
      ) {
        this.#completeSlashCommand(selected, false);
      }
    }

    if (key.name === "return") {
      const typedValue = this.#inputChars.join("").trim();
      const value =
        typedValue ||
        (this.#mode === "input"
          ? this.#suggestedReplies[this.#suggestedReplyIndex] ?? ""
          : "");
      this.#clearSuggestedReplies();
      if (value) {
        this.#history.push(value);
        if (this.#history.length > 100) {
          this.#history = this.#history.slice(-100);
        }
      }
      this.#inputChars = [];
      this.#cursor = 0;
      this.#commandSelectedIndex = 0;
      if (this.#mode === "busy") {
        if (value) {
          this.#queuedInputs.push(value);
          this.#status = `${this.#queuedInputs.length} Nachricht${
            this.#queuedInputs.length === 1 ? "" : "en"
          } vorgemerkt · aktueller Lauf arbeitet weiter`;
        }
        this.scheduleRender(true);
        return;
      }
      const resolve = this.#inputResolve;
      this.#clearInputPromise();
      this.#mode = "busy";
      this.#status = value ? "Eingabe wird verarbeitet" : "Bereit";
      this.scheduleRender(true);
      resolve?.(value);
      return;
    }
    const previousCommandToken = slashCommandToken(this.#inputChars.join(""));
    this.#editInput(character, key, true);
    if (slashCommandToken(this.#inputChars.join("")) !== previousCommandToken) {
      this.#commandSelectedIndex = 0;
    }
    this.scheduleRender(this.#inputChars[0] === "/");
  };

  #editInput(character: string, key: Key, allowHistory: boolean): void {
    if (key.name === "backspace") {
      if (this.#cursor > 0) {
        this.#inputChars.splice(this.#cursor - 1, 1);
        this.#cursor -= 1;
      }
    } else if (key.name === "delete") {
      this.#inputChars.splice(this.#cursor, 1);
    } else if (key.name === "left") {
      this.#cursor = Math.max(0, this.#cursor - 1);
    } else if (key.name === "right") {
      this.#cursor = Math.min(this.#inputChars.length, this.#cursor + 1);
    } else if (key.name === "home") {
      this.#cursor = 0;
    } else if (key.name === "end") {
      this.#cursor = this.#inputChars.length;
    } else if (allowHistory && key.name === "up") {
      this.#recallHistory(-1);
    } else if (allowHistory && key.name === "down") {
      this.#recallHistory(1);
    } else if (allowHistory && key.name === "escape") {
      this.#inputChars = [];
      this.#cursor = 0;
    } else if (
      character &&
      !key.ctrl &&
      !key.meta &&
      !isFunctionKey(key.name)
    ) {
      const chars = Array.from(character).filter((value) => value >= " ");
      this.#inputChars.splice(this.#cursor, 0, ...chars);
      this.#cursor += chars.length;
    }
  }

  #handlePickerKey(character: string, key: Key): void {
    if (key.name === "escape") {
      this.#resolvePicker(null);
      return;
    }
    if (key.name === "return") {
      this.#resolvePicker(this.#pickerModels[this.#pickerSelectedIndex] ?? null);
      return;
    }
    if (key.name === "up") {
      this.#pickerSelectedIndex = Math.max(0, this.#pickerSelectedIndex - 1);
    } else if (key.name === "down") {
      this.#pickerSelectedIndex = this.#pickerModels.length
        ? Math.min(
            this.#pickerModels.length - 1,
            this.#pickerSelectedIndex + 1,
          )
        : 0;
    } else if (key.name === "pageup") {
      this.#pickerSelectedIndex = Math.max(0, this.#pickerSelectedIndex - 8);
    } else if (key.name === "pagedown") {
      this.#pickerSelectedIndex = this.#pickerModels.length
        ? Math.min(
            this.#pickerModels.length - 1,
            this.#pickerSelectedIndex + 8,
          )
        : 0;
    } else {
      const previousQuery = this.#inputChars.join("");
      this.#editInput(character, key, false);
      if (this.#inputChars.join("") !== previousQuery) {
        this.#refreshPicker();
      }
    }
    this.scheduleRender(true);
  }

  #handleChoiceKey(character: string, key: Key): void {
    if (key.name === "escape") {
      this.#resolveChoice(null);
      return;
    }
    if (key.name === "return") {
      this.#resolveChoice(this.#choiceItems[this.#choiceSelectedIndex] ?? null);
      return;
    }
    if (key.name === "up") {
      this.#choiceSelectedIndex = Math.max(0, this.#choiceSelectedIndex - 1);
    } else if (key.name === "down") {
      this.#choiceSelectedIndex = this.#choiceItems.length
        ? Math.min(this.#choiceItems.length - 1, this.#choiceSelectedIndex + 1)
        : 0;
    } else if (key.name === "pageup") {
      this.#choiceSelectedIndex = Math.max(0, this.#choiceSelectedIndex - 8);
    } else if (key.name === "pagedown") {
      this.#choiceSelectedIndex = this.#choiceItems.length
        ? Math.min(this.#choiceItems.length - 1, this.#choiceSelectedIndex + 8)
        : 0;
    } else {
      const previousQuery = this.#inputChars.join("");
      this.#editInput(character, key, false);
      if (this.#inputChars.join("") !== previousQuery) {
        this.#refreshChoices();
      }
    }
    this.scheduleRender(true);
  }

  #refreshPicker(): void {
    const matches = this.#pickerSearch?.(this.#inputChars.join("")) ?? [];
    this.#pickerModels = matches.slice(0, 80);
    this.#pickerSelectedIndex = this.#pickerModels.findIndex(
      (model) => model.id === this.#pickerCurrentModel,
    );
    if (this.#pickerSelectedIndex < 0) {
      this.#pickerSelectedIndex = 0;
    }
  }

  #resolvePicker(model: ModelInfo | null): void {
    const resolve = this.#pickerResolve;
    this.#pickerResolve = null;
    this.#pickerSearch = null;
    this.#pickerModels = [];
    this.#pickerSelectedIndex = 0;
    this.#pickerTitle = "Modell auswählen";
    this.#inputChars = [];
    this.#cursor = 0;
    this.#mode = "busy";
    this.#status = model ? "Modell wird übernommen" : "Modellwahl abgebrochen";
    this.scheduleRender(true);
    resolve?.(model);
  }

  #refreshChoices(): void {
    const query = this.#inputChars.join("").trim().toLowerCase();
    this.#choiceItems = this.#choiceAllItems
      .map((item, index) => ({
        item,
        index,
        score: choiceSearchScore(item, query),
      }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) =>
        right.score - left.score || left.index - right.index)
      .map(({ item }) => item);
    this.#choiceSelectedIndex = query
      ? 0
      : this.#choiceItems.findIndex(
          (item) => item.value === this.#choiceInitialValue,
        );
    if (this.#choiceSelectedIndex < 0) {
      this.#choiceSelectedIndex = 0;
    }
  }

  #resolveChoice(choice: ChoicePickerItem | null): void {
    const resolve = this.#choiceResolve;
    this.#choiceResolve = null;
    this.#choiceTitle = "";
    this.#choiceAllItems = [];
    this.#choiceItems = [];
    this.#choiceSelectedIndex = 0;
    this.#choiceCurrentValue = "";
    this.#choiceInitialValue = "";
    this.#inputChars = [];
    this.#cursor = 0;
    this.#mode = "busy";
    this.#status = choice ? "Auswahl wird übernommen" : "Auswahl abgebrochen";
    this.scheduleRender(true);
    resolve?.(choice);
  }

  #resolveSecret(value: string | null): void {
    const resolve = this.#secretResolve;
    this.#secretResolve = null;
    this.#secretLabel = "";
    this.#inputChars = [];
    this.#cursor = 0;
    this.#mode = "busy";
    this.#status = value === null ? "Eingabe abgebrochen" : "Key wird geprüft";
    this.scheduleRender(true);
    resolve?.(value);
  }

  #requestCancel(): void {
    if (this.#cancelRequestedAt && !this.#cancelHandler) {
      this.#terminate("SIGINT");
      return;
    }
    if (!this.#cancelHandler) {
      this.#status = "Dieser Vorgang kann gerade nicht abgebrochen werden.";
      this.scheduleRender(true);
      return;
    }
    this.#cancelRequestedAt = Date.now();
    this.#status = "Abbruch angefordert · erneut Ctrl+C beendet RouterCode sofort";
    const handler = this.#cancelHandler;
    this.#cancelHandler = null;
    handler();
    this.scheduleRender(true);
  }

  #recallHistory(direction: -1 | 1): void {
    if (!this.#history.length) {
      return;
    }
    this.#historyIndex = Math.min(
      this.#history.length,
      Math.max(0, this.#historyIndex + direction),
    );
    const value = this.#history[this.#historyIndex] ?? "";
    this.#inputChars = Array.from(value);
    this.#cursor = this.#inputChars.length;
  }

  #resolveConfirm(accepted: boolean): void {
    const resolve = this.#confirmResolve;
    this.#confirmResolve = null;
    this.#confirmState = null;
    this.#mode = "busy";
    this.#status = accepted ? "Freigabe erteilt" : "Freigabe abgelehnt";
    this.scheduleRender(true);
    resolve?.(accepted);
  }

  #clearInputPromise(): void {
    this.#inputResolve = null;
    this.#inputReject = null;
  }

  #clearSuggestedReplies(): void {
    this.#suggestedReplies = [];
    this.#suggestedReplyIndex = 0;
  }

  #appendReasoning(model: string, delta: string): void {
    const clean = sanitizeTerminalText(delta);
    if (!clean) {
      return;
    }
    const panel = this.#reasoningPanel ?? {
      model,
      text: "",
      tokenCount: 0,
      expanded: false,
      live: true,
      truncated: false,
    };
    panel.model = model;
    panel.live = true;
    panel.text += clean;
    if (panel.text.length > MAX_REASONING_PANEL_CHARACTERS) {
      panel.text = panel.text.slice(-MAX_REASONING_PANEL_CHARACTERS);
      panel.truncated = true;
    }
    this.#reasoningPanel = panel;
  }

  #commandMatches(): SlashCommandDefinition[] {
    const matches = rankSlashCommands(this.#inputChars.join(""));
    if (this.#commandSelectedIndex >= matches.length) {
      this.#commandSelectedIndex = Math.max(0, matches.length - 1);
    }
    return matches;
  }

  #completeSlashCommand(
    command: SlashCommandDefinition,
    appendArgumentSpace: boolean,
  ): void {
    const input = this.#inputChars.join("");
    const commandParts = command.name.split(/\s+/);
    const rootRemainder = input.match(/^\/\S*(.*)$/s)?.[1] ?? "";
    const typedRoot = input
      .slice(1)
      .trimStart()
      .split(/\s+/, 1)[0]
      ?.toLowerCase() ?? "";
    const completedName =
      commandParts.length === 1 && command.aliases?.includes(typedRoot)
        ? typedRoot
        : command.name;
    const remainder =
      commandParts.length > 1
        ? rootRemainder.trimStart().match(/^\S+(.*)$/s)?.[1] ?? ""
        : rootRemainder;
    const suffix =
      remainder ||
      (appendArgumentSpace && command.acceptsArguments ? " " : "");
    const completed = `/${completedName}${suffix}`;
    this.#inputChars = Array.from(completed);
    this.#cursor = this.#inputChars.length;
    this.#commandSelectedIndex = 0;
  }
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
  if (!query) {
    return 0;
  }
  const label = item.label.toLowerCase();
  const value = item.value.toLowerCase();
  if (label === query || value === query) return 10_000;
  if (label.startsWith(query) || value.startsWith(query)) return 5_000;
  return `${label} ${value} ${item.description.toLowerCase()}`.includes(query)
    ? 1_000
    : -1;
}

export function buildDashboardLayout(input: DashboardLayoutInput): DashboardLayout {
  const width = Math.max(40, Math.floor(input.width));
  const height = Math.max(12, Math.floor(input.height));
  const usableWidth = width - 1;
  const header = buildHeader(input.state, usableWidth, height);
  const footerHeight = 5;
  const hasOverlay = Boolean(
    input.picker || input.choicePicker || input.commandPalette,
  );
  const accessoryCapacity = Math.max(
    0,
    height - header.length - footerHeight - 2,
  );
  const showReasoningPanel = Boolean(
    !hasOverlay &&
    input.reasoningPanel &&
    (input.reasoningPanel.text || input.reasoningPanel.tokenCount > 0),
  );
  const desiredReasoningHeight = showReasoningPanel
    ? input.reasoningPanel!.expanded
      ? 8
      : 2
    : 0;
  const reasoningHeight =
    desiredReasoningHeight > 0 && accessoryCapacity >= 2
      ? Math.min(desiredReasoningHeight, accessoryCapacity)
      : 0;
  const remainingAccessoryCapacity = accessoryCapacity - reasoningHeight;
  const quickReplyHeight =
    !hasOverlay &&
    input.quickReplies &&
    remainingAccessoryCapacity >= 2
    ? Math.min(
        input.quickReplies.items.length + 1,
        remainingAccessoryCapacity,
      )
    : 0;
  const chatHeight = Math.max(
    2,
    height -
      header.length -
      footerHeight -
      reasoningHeight -
      quickReplyHeight,
  );
  const chatLines = input.picker
    ? buildModelPickerLines(input.picker, usableWidth, chatHeight)
    : input.choicePicker
      ? buildChoicePickerLines(input.choicePicker, usableWidth, chatHeight)
      : input.commandPalette
        ? buildCommandPaletteLines(input.commandPalette, usableWidth, chatHeight)
        : buildChatLines(input.messages, usableWidth);
  const maxScrollOffset = hasOverlay
    ? 0
    : Math.max(0, chatLines.length - chatHeight);
  const scrollOffset = Math.min(
    Math.max(0, input.scrollOffset),
    maxScrollOffset,
  );
  const start = hasOverlay
    ? 0
    : Math.max(0, chatLines.length - chatHeight - scrollOffset);
  const viewport = chatLines.slice(start, start + chatHeight);
  while (viewport.length < chatHeight) {
    viewport.push("");
  }
  if (scrollOffset > 0 && viewport.length) {
    viewport[0] = fitLine(
      ` ↑ ${scrollOffset} neuere Chat-Zeile${scrollOffset === 1 ? "" : "n"} unterhalb`,
      usableWidth,
    );
  }
  const quickReplyLines =
    input.quickReplies && quickReplyHeight > 0
      ? buildQuickReplyLines(
          input.quickReplies,
          usableWidth,
          quickReplyHeight,
        )
      : [];
  const reasoningLines =
    input.reasoningPanel && reasoningHeight > 0
      ? buildReasoningPanelLines(
          input.reasoningPanel,
          usableWidth,
          reasoningHeight,
        )
      : [];

  const statusIcon = input.busy || input.run ? "◌" : "●";
  const queueLabel = input.queuedCount
    ? ` · ${input.queuedCount} vorgemerkt`
    : "";
  const status = input.confirm
    ? `${input.confirm.title} — ${oneLine(input.confirm.details)}`
    : input.picker
      ? `◆ ${input.picker.title} · ${input.picker.models.length} Treffer`
      : input.choicePicker
        ? `◆ ${input.choicePicker.title} · ${input.choicePicker.items.length} Optionen`
        : input.commandPalette
          ? `◆ Befehle · ${input.commandPalette.commands.length} Treffer`
      : input.secret
        ? `◆ ${input.secret.label} · Eingabe bleibt verdeckt`
        : input.run
          ? `${statusIcon} AKTIV · ${runStatusSummary(input.run)}${queueLabel}`
          : `${statusIcon} ${input.status}${queueLabel}`;
  const detail = input.run
    ? runDetailSummary(input.run, input.state)
    : idleDetailSummary(input.state);
  const prompt = input.confirm
    ? " Freigeben?  [y] Ja   [n/Enter] Nein"
    : input.picker
      ? buildInputLine(input.picker.query, input.picker.cursor, usableWidth, "Suche")
      : input.choicePicker
        ? buildInputLine(
            input.choicePicker.query,
            input.choicePicker.cursor,
            usableWidth,
            "Suche",
          )
      : input.secret
        ? buildSecretLine(input.input, input.cursor, usableWidth)
        : buildInputLine(
            input.input,
            input.cursor,
            usableWidth,
            input.quickReplies ? "Eigene Antwort" : "",
          );
  const reasoningHelp = reasoningHeight > 0 ? " · T Denken" : "";
  const help = input.confirm
    ? " Die Aktion wird erst nach deiner Entscheidung ausgeführt."
    : input.picker
      ? " Tippen filtert · ↑↓/PgUp/PgDn wählen · Enter übernehmen · Esc abbrechen"
      : input.choicePicker
        ? " Tippen filtert · ↑↓/PgUp/PgDn wählen · Enter übernehmen · Esc abbrechen"
        : input.commandPalette
          ? " Tippen filtert · ↑↓ wählen · Tab einsetzen · Enter ausführen · Esc schließen"
      : input.secret
        ? " Der Key wird nie angezeigt · Enter prüfen und speichern · Esc abbrechen"
        : input.quickReplies
          ? ` ↑↓/Tab Vorschlag · Enter übernehmen · eigene Antwort tippen · Esc ausblenden${reasoningHelp}`
        : input.busy
          ? ` / Befehle · Enter vormerken · ←→ Cursor · Ctrl+C Abbruch · PgUp/Dn Chat${reasoningHelp}`
          : ` / Befehle · Enter senden · ←→ Cursor · Ctrl+C Ende · ↑↓ Verlauf · PgUp/Dn Chat${reasoningHelp}`;

  const lines = [
    ...header,
    ...viewport,
    ...reasoningLines,
    ...quickReplyLines,
    divider(usableWidth, "─"),
    fitLine(` ${status}`, usableWidth),
    fitLine(` ${detail}`, usableWidth),
    fitLine(prompt, usableWidth),
    fitLine(help, usableWidth),
  ];
  return {
    lines: lines.slice(0, height).map((line) => fitLine(line, usableWidth)),
    chatHeight,
    maxScrollOffset,
  };
}

function runStatusSummary(run: RunStatusLayoutInput): string {
  const now = run.now ?? Date.now();
  const elapsed = formatDuration(Math.max(0, now - run.startedAt));
  const idle = Math.max(0, now - run.lastEventAt);
  return [
    run.phase,
    elapsed,
    `letztes Ereignis ${formatAge(idle)}`,
    `Schritt ${run.step}/${run.maxSteps}`,
  ].join(" · ");
}

function runDetailSummary(
  run: RunStatusLayoutInput,
  state: DashboardState,
): string {
  const now = run.now ?? Date.now();
  const active = run.activeTools[0];
  if (active) {
    const parallel =
      run.activeTools.length > 1
        ? ` · +${run.activeTools.length - 1} parallel`
        : "";
    return `TOOL ${toolLabel(active.name)} · ${active.summary} · läuft ${formatDuration(
      Math.max(0, now - active.startedAt),
    )}${parallel}`;
  }
  const tokenTotal = run.inputTokens + run.outputTokens;
  return [
    `MAIN ${run.model}`,
    `THINK ${state.reasoning}`,
    `TOKENS ${formatTokenCount(tokenTotal)}`,
    `REASON ${formatTokenCount(run.reasoningTokens)}`,
    `TOOLS ${run.toolCount}`,
    `RUN ${formatRunUsd(run.costUsd)}`,
  ].join(" · ");
}

function idleDetailSummary(state: DashboardState): string {
  const route =
    state.resolvedModel && state.resolvedModel !== state.model
      ? `${state.model} → ${state.resolvedModel}`
      : state.model;
  return `MAIN ${route} · THINK ${state.reasoning} · bereit für neue Aufgabe`;
}

function buildHeader(
  state: DashboardState,
  width: number,
  height: number,
): string[] {
  const route =
    state.resolvedModel && state.resolvedModel !== state.model
      ? `${state.model} → ${state.resolvedModel}`
      : state.model;
  const modeLine =
    width < 100
      ? ` APPROVAL ${state.approval}  │  THINK ${state.reasoning}  │  KOMP ${state.compressor}  │  LIMIT ${state.maxCost}/${state.maxSteps}  │  KEY ${state.keyStatus}`
      : ` APPROVAL ${state.approval}  │  THINK ${state.reasoning}  │  KOMPRESSOR ${state.compressor} (${state.compressorModel})  │  LIMIT ${state.maxCost} / ${state.maxSteps} Schritte  │  KEY ${state.keyStatus}`;
  if (height < 14) {
    return [
      fitLine(
        ` ROUTERCODE 0.3  │  Guthaben ${state.balance}  │  Sitzung ${state.sessionCost}`,
        width,
      ),
      fitLine(` WORKSPACE  ${state.workspace}`, width),
      fitLine(` MODELL     ${route}`, width),
      fitLine(modeLine, width),
      divider(width, "━"),
    ];
  }
  return [
    fitLine(
      ` ROUTERCODE 0.3  │  OpenRouter ●  │  Guthaben ${state.balance}  │  Sitzung ${state.sessionCost}`,
      width,
    ),
    fitLine(` WORKSPACE  ${state.workspace}`, width),
    fitLine(
      ` PROJEKT    ${state.projectStatus ?? "lokaler Workspace"}`,
      width,
    ),
    fitLine(` MODELL     ${route}`, width),
    fitLine(` DETAILS    ${state.modelDetails ?? "Metadaten werden geladen"}`, width),
    fitLine(modeLine, width),
    divider(width, "━"),
  ];
}

function buildChatLines(messages: readonly UiMessage[], width: number): string[] {
  const columnWidth = Math.min(108, Math.max(20, width - 4));
  const leftPadding = Math.max(2, Math.floor((width - columnWidth) / 2));
  const prefix = " ".repeat(leftPadding);
  if (!messages.length) {
    return [
      "",
      fitLine(`${prefix}Willkommen bei RouterCode.`, width),
      fitLine(
        `${prefix}Schreibe eine Aufgabe oder öffne mit /model die Modellauswahl.`,
        width,
      ),
      fitLine(
        `${prefix}Mit /chat wechselst du die Sitzung; / zeigt alle Befehle.`,
        width,
      ),
    ];
  }
  const contentWidth = columnWidth;
  const lines: string[] = [];
  for (const message of messages) {
    if (
      message.role === "system" &&
      !message.meta &&
      !message.content.includes("\n") &&
      /^Lauf (?:beendet|abgebrochen|fehlgeschlagen)\b/.test(message.content)
    ) {
      const icon = message.content.startsWith("Lauf beendet") ? "✓" : "!";
      lines.push(fitLine(`${prefix}${icon} ${message.content}`, width));
      lines.push("");
      continue;
    }
    const time = formatTime(message.createdAt);
    const label =
      message.role === "user"
        ? "DU"
        : message.role === "assistant"
          ? "ROUTERCODE"
          : message.role === "error"
            ? "FEHLER"
            : "SYSTEM";
    const meta = message.meta ? ` · ${message.meta}` : "";
    lines.push(
      fitLine(`${prefix}${label}${meta}${time ? ` · ${time}` : ""}`, width),
    );
    const content = message.content || "…";
    let inCodeBlock = false;
    for (const logicalLine of content.split(/\r?\n/)) {
      const fence = logicalLine.match(/^\s*```(.*)$/);
      if (fence) {
        if (inCodeBlock) {
          lines.push(fitLine(`${prefix}└─`, width));
        } else {
          const language = oneLine(fence[1] ?? "");
          lines.push(
            fitLine(`${prefix}┌─${language ? ` ${language}` : ""}`, width),
          );
        }
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) {
        const code = sanitizeTerminalText(logicalLine).replace(/\t/g, "  ");
        const chunks = splitByWidth(code, Math.max(1, contentWidth - 2));
        for (const line of chunks.length ? chunks : [""]) {
          lines.push(fitLine(`${prefix}│ ${line}`, width));
        }
        continue;
      }
      const rendered = renderMarkdownLine(logicalLine);
      const wrapped = wrapPlainText(rendered || " ", contentWidth);
      for (const line of wrapped) {
        lines.push(fitLine(`${prefix}${line}`, width));
      }
    }
    if (inCodeBlock) {
      lines.push(fitLine(`${prefix}└─`, width));
    }
    lines.push("");
  }
  return lines;
}

function renderMarkdownLine(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^(\s*)[-*+]\s+/, "$1• ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "‹$1›")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
}

function buildReasoningPanelLines(
  panel: ReasoningPanelLayoutInput,
  width: number,
  height: number,
): string[] {
  if (height < 2 || (!panel.text && panel.tokenCount <= 0)) {
    return [];
  }
  const columnWidth = Math.min(108, Math.max(20, width - 4));
  const prefix = " ".repeat(
    Math.max(2, Math.floor((width - columnWidth) / 2)),
  );
  const contentWidth = Math.max(12, columnWidth - 2);
  const control = panel.expanded ? "T zuklappen" : "T aufklappen";
  const activity = panel.live ? "LIVE" : "LETZTER LAUF";
  const tokenLabel =
    panel.tokenCount > 0
      ? `${formatTokenCount(panel.tokenCount)} Reasoning-Tokens`
      : "Reasoning-Text";
  const truncated = panel.truncated ? " · Ansicht gekürzt" : "";
  const lines = [
    fitLine(
      `${prefix}DENKEN [${control}] · ${activity} · ${panel.model} · ${tokenLabel}${truncated}`,
      width,
    ),
  ];

  if (!panel.text.trim()) {
    lines.push(
      fitLine(
        `${prefix}  Der Provider meldet Reasoning-Tokens, liefert aber keinen lesbaren Text.`,
        width,
      ),
    );
  } else if (!panel.expanded) {
    const preview =
      panel.text
        .split(/\r?\n/)
        .map((line) => oneLine(renderMarkdownLine(line)))
        .filter(Boolean)
        .at(-1) ?? oneLine(panel.text);
    lines.push(fitLine(`${prefix}  ${preview}`, width));
  } else {
    const rendered = panel.text
      .split(/\r?\n/)
      .flatMap((line) =>
        wrapPlainText(renderMarkdownLine(line) || " ", contentWidth),
      );
    const visible = rendered.slice(-(height - 1));
    for (const line of visible) {
      lines.push(fitLine(`${prefix}  ${line}`, width));
    }
  }

  while (lines.length < height) {
    lines.push("");
  }
  return lines.slice(0, height);
}

function buildQuickReplyLines(
  quickReplies: QuickReplyLayoutInput,
  width: number,
  height: number,
): string[] {
  if (!quickReplies.items.length || height < 2) {
    return [];
  }
  const columnWidth = Math.min(108, Math.max(20, width - 4));
  const prefix = " ".repeat(
    Math.max(2, Math.floor((width - columnWidth) / 2)),
  );
  const selectedIndex = Math.min(
    Math.max(0, quickReplies.selectedIndex),
    quickReplies.items.length - 1,
  );
  const visibleRows = height - 1;
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleRows / 2)),
    Math.max(0, quickReplies.items.length - visibleRows),
  );
  const lines = [
    fitLine(
      `${prefix}ANTWORTVORSCHLÄGE · auswählen oder selbst schreiben`,
      width,
    ),
  ];
  for (
    let index = start;
    index < quickReplies.items.length && lines.length < height;
    index += 1
  ) {
    const marker = index === selectedIndex ? "›" : " ";
    lines.push(
      fitLine(`${prefix}${marker} ${quickReplies.items[index]}`, width),
    );
  }
  return lines;
}

function buildModelPickerLines(
  picker: ModelPickerLayoutInput,
  width: number,
  height: number,
): string[] {
  const lines = [
    fitLine(
      `  ${picker.title.toLocaleUpperCase("de-DE")} · ${picker.models.length} Treffer für „${picker.query || "alle"}“`,
      width,
    ),
  ];
  if (!picker.models.length) {
    lines.push(
      "",
      fitLine("  Keine passenden tool-fähigen Modelle gefunden.", width),
      fitLine("  Ändere den Suchbegriff oder drücke Esc.", width),
    );
    return lines;
  }

  const selectedIndex = Math.min(
    Math.max(0, picker.selectedIndex),
    picker.models.length - 1,
  );
  const detailsHeight = height >= 11 ? 4 : 2;
  const resultRows = Math.max(1, height - detailsHeight - 2);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(resultRows / 2)),
    Math.max(0, picker.models.length - resultRows),
  );
  const visible = picker.models.slice(start, start + resultRows);
  for (let index = 0; index < visible.length; index += 1) {
    const absoluteIndex = start + index;
    const model = visible[index];
    const marker = absoluteIndex === selectedIndex ? "›" : " ";
    const current = model.id === picker.currentModel ? "  ● aktiv" : "";
    lines.push(fitLine(`  ${marker} ${model.id}${current}`, width));
  }
  while (lines.length < resultRows + 1) {
    lines.push("");
  }

  const selected = picker.models[selectedIndex];
  lines.push(divider(width, "┄"));
  lines.push(fitLine(`  ${selected.name}`, width));
  lines.push(fitLine(`  ${modelPickerSummary(selected)}`, width));
  if (height >= 11) {
    const description = oneLine(selected.description) || "Keine Beschreibung verfügbar.";
    lines.push(...wrapPlainText(description, Math.max(10, width - 4))
      .slice(0, 1)
      .map((line) => fitLine(`  ${line}`, width)));
  }
  return lines.slice(0, height);
}

function buildCommandPaletteLines(
  palette: CommandPaletteLayoutInput,
  width: number,
  height: number,
): string[] {
  const lines = [
    fitLine(
      `  BEFEHLE · ${palette.commands.length} Treffer für „${slashCommandToken(palette.input) || "alle"}“`,
      width,
    ),
  ];
  if (!palette.commands.length) {
    return [
      ...lines,
      "",
      fitLine("  Kein passender Befehl.", width),
      fitLine("  Backspace ändert die Suche; /help zeigt alle Befehle.", width),
    ];
  }
  const selectedIndex = Math.min(
    Math.max(0, palette.selectedIndex),
    palette.commands.length - 1,
  );
  const detailsHeight = height >= 9 ? 4 : 2;
  const resultRows = Math.max(1, height - detailsHeight - 2);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(resultRows / 2)),
    Math.max(0, palette.commands.length - resultRows),
  );
  const visible = palette.commands.slice(start, start + resultRows);
  for (let index = 0; index < visible.length; index += 1) {
    const absoluteIndex = start + index;
    const command = visible[index];
    const marker = absoluteIndex === selectedIndex ? "›" : " ";
    lines.push(
      fitLine(
        `  ${marker} /${command.name.padEnd(12)} ${command.description}`,
        width,
      ),
    );
  }
  while (lines.length < resultRows + 1) {
    lines.push("");
  }
  const selected = palette.commands[selectedIndex];
  lines.push(divider(width, "┄"));
  lines.push(fitLine(`  ${selected.usage}`, width));
  if (height >= 9) {
    lines.push(fitLine(`  ${selected.description}`, width));
  }
  return lines.slice(0, height);
}

function buildChoicePickerLines(
  picker: ChoicePickerLayoutInput,
  width: number,
  height: number,
): string[] {
  const lines = [
    fitLine(
      `  ${picker.title.toUpperCase()} · ${picker.items.length} Optionen`,
      width,
    ),
  ];
  if (!picker.items.length) {
    return [
      ...lines,
      "",
      fitLine("  Keine passende Option.", width),
      fitLine("  Ändere die Suche oder drücke Esc.", width),
    ];
  }
  const selectedIndex = Math.min(
    Math.max(0, picker.selectedIndex),
    picker.items.length - 1,
  );
  const detailsHeight = height >= 9 ? 4 : 2;
  const resultRows = Math.max(1, height - detailsHeight - 2);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(resultRows / 2)),
    Math.max(0, picker.items.length - resultRows),
  );
  const visible = picker.items.slice(start, start + resultRows);
  for (let index = 0; index < visible.length; index += 1) {
    const absoluteIndex = start + index;
    const item = visible[index];
    const marker = absoluteIndex === selectedIndex ? "›" : " ";
    const current = item.value === picker.currentValue ? "  ● aktiv" : "";
    lines.push(fitLine(`  ${marker} ${item.label}${current}`, width));
  }
  while (lines.length < resultRows + 1) {
    lines.push("");
  }
  const selected = picker.items[selectedIndex];
  lines.push(divider(width, "┄"));
  lines.push(fitLine(`  ${selected.label}`, width));
  if (height >= 9) {
    lines.push(
      ...wrapPlainText(selected.description, Math.max(10, width - 4))
        .slice(0, 1)
        .map((line) => fitLine(`  ${line}`, width)),
    );
  }
  return lines.slice(0, height);
}

function modelPickerSummary(model: ModelInfo): string {
  const capabilities = [
    model.supportedParameters.includes("tools") ? "Tools" : "",
    model.supportedParameters.includes("reasoning") ? "Reasoning" : "",
    model.inputModalities.includes("image") ? "Bild" : "",
    model.inputModalities.includes("audio") ? "Audio" : "",
  ].filter(Boolean);
  const inputPrice = pickerPrice(model.promptPrice);
  const outputPrice = pickerPrice(model.completionPrice);
  return `In ${inputPrice} · Out ${outputPrice} · Kontext ${compactTokens(model.contextLength)} · ${capabilities.join(", ") || "Text"}`;
}

function pickerPrice(perToken: number): string {
  if (perToken < 0) return "variabel";
  if (perToken === 0) return "kostenlos";
  return `$${(perToken * 1_000_000).toFixed(3)}/M`;
}

function compactTokens(value: number): string {
  return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function buildInputLine(
  input: string,
  cursor: number,
  width: number,
  label = "",
): string {
  const chars = Array.from(input);
  const safeCursor = Math.min(Math.max(0, cursor), chars.length);
  const labelPrefix = label ? `${label} › ` : "› ";
  const capacity = Math.max(8, width - displayWidth(labelPrefix) - 3);
  let start = 0;
  if (safeCursor > capacity - 2) {
    start = safeCursor - capacity + 2;
  }
  const visible = chars.slice(start, start + capacity);
  const cursorInView = safeCursor - start;
  visible.splice(cursorInView, 0, "█");
  const prefix = start > 0 ? "… " : labelPrefix;
  return fitLine(` ${prefix}${visible.join("")}`, width);
}

function buildSecretLine(input: string, cursor: number, width: number): string {
  const hidden = Array.from(input).map(() => "•").join("");
  return buildInputLine(hidden, cursor, width, "Key");
}

export function wrapPlainText(value: string, width: number): string[] {
  const maximum = Math.max(1, Math.floor(width));
  const source = sanitizeTerminalText(value).replace(/\t/g, "  ");
  if (!source) {
    return [""];
  }
  const words = source.split(/(\s+)/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (displayWidth(line + word) <= maximum) {
      line += word;
      continue;
    }
    if (line.trimEnd()) {
      lines.push(line.trimEnd());
      line = "";
    }
    if (/^\s+$/.test(word)) {
      continue;
    }
    const chunks = splitByWidth(word, maximum);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line || !lines.length) {
    lines.push(line.trimEnd());
  }
  return lines;
}

function splitByWidth(value: string, width: number): string[] {
  const result: string[] = [];
  let chunk = "";
  for (const character of Array.from(value)) {
    if (displayWidth(chunk + character) > width && chunk) {
      result.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) {
    result.push(chunk);
  }
  return result;
}

function fitLine(value: string, width: number): string {
  const clean = sanitizeTerminalText(value).replace(/\r?\n/g, " ");
  if (displayWidth(clean) <= width) {
    return clean;
  }
  let result = "";
  for (const character of Array.from(clean)) {
    if (displayWidth(`${result}${character}…`) > width) {
      break;
    }
    result += character;
  }
  return `${result}…`;
}

function divider(width: number, character: string): string {
  return character.repeat(Math.max(1, width));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of Array.from(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0x300 && code <= 0x36f)) {
      continue;
    }
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  );
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

function toolLabel(name: string): string {
  switch (name) {
    case "run_command":
      return "SHELL";
    case "read_file":
      return "READ";
    case "list_files":
      return "LIST";
    case "search_files":
      return "SEARCH";
    case "write_file":
      return "WRITE";
    case "replace_text":
      return "EDIT";
    case "git_diff":
      return "GIT DIFF";
    default:
      return name.replaceAll("_", " ").toUpperCase();
  }
}

function toolInputSummary(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name === "run_command") {
    return truncateOneLine(stringValue(input.command) || "Shell-Befehl", 300);
  }
  if (name === "read_file") {
    const range =
      input.lineStart || input.lineEnd
        ? ` · Zeilen ${stringValue(input.lineStart) || "1"}–${
            stringValue(input.lineEnd) || "…"
          }`
        : "";
    return `${stringValue(input.path) || "Datei"}${range}`;
  }
  if (name === "list_files") {
    return `${stringValue(input.path) || "."} · ${
      stringValue(input.pattern) || "**/*"
    }`;
  }
  if (name === "search_files") {
    return `„${truncateOneLine(stringValue(input.query), 160)}“ in ${
      stringValue(input.path) || "."
    }`;
  }
  if (name === "write_file" || name === "replace_text") {
    return stringValue(input.path) || "Datei";
  }
  if (name === "git_diff") {
    return input.staged ? "gestagte Änderungen" : "Arbeitsbaum";
  }
  const serialized = safeJson(input);
  return truncateOneLine(serialized || name, 300);
}

function toolOutputSummary(name: string, output: unknown): string {
  const record = recordValue(output);
  if (!record) {
    return output === undefined ? "" : truncateOneLine(String(output), 240);
  }
  if (name === "run_command") {
    const exitCode = numberValue(record.exitCode);
    const lastLine = lastNonEmptyLine(
      stringValue(record.stdout) || stringValue(record.stderr),
    );
    return [
      `Exit ${exitCode ?? "?"}`,
      lastLine ? truncateOneLine(lastLine, 240) : "",
      record.truncated ? "Ausgabe gekürzt" : "",
    ].filter(Boolean).join(" · ");
  }
  if (name === "read_file") {
    return `${numberValue(record.totalLines) ?? "?"} Zeilen${
      record.truncated ? " · Ausschnitt" : ""
    }`;
  }
  if (name === "list_files") {
    const files = Array.isArray(record.files) ? record.files.length : 0;
    return `${files} Dateien${record.truncated ? " · Liste gekürzt" : ""}`;
  }
  if (name === "search_files") {
    const matches = nonEmptyLineCount(stringValue(record.matches));
    return `${matches} Trefferzeilen${
      record.truncated ? " · Ausgabe gekürzt" : ""
    }`;
  }
  if (name === "write_file") {
    return `${numberValue(record.bytes) ?? "?"} Bytes geschrieben`;
  }
  if (name === "replace_text") {
    return `${numberValue(record.replacements) ?? "?"} Ersetzung(en)`;
  }
  if (name === "git_diff") {
    return `${nonEmptyLineCount(stringValue(record.diff))} Diff-Zeilen${
      record.truncated ? " · Ausgabe gekürzt" : ""
    }`;
  }
  return "Ergebnis empfangen";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function lastNonEmptyLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function nonEmptyLineCount(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim()).length;
}

function truncateOneLine(value: string, maximum: number): string {
  const clean = oneLine(value);
  return clean.length <= maximum
    ? clean
    : `${clean.slice(0, Math.max(1, maximum - 1))}…`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatToolDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${Math.max(0, Math.round(milliseconds))}ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`;
  }
  return formatDuration(milliseconds);
}

function formatAge(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return "gerade";
  }
  return `vor ${formatDuration(milliseconds)}`;
}

function formatTokenCount(value: number): string {
  if (value <= 0) {
    return "—";
  }
  return Intl.NumberFormat("de-DE", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatRunUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

function formatTime(value?: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function riskIcon(risk: ToolCallPreview["risk"]): string {
  if (risk === "shell") return "⚠ SHELL";
  if (risk === "edit") return "◆ EDIT";
  return "● READ";
}

function styleDashboardLine(line: string, index: number, total: number): string {
  if (/^ ROUTERCODE/.test(line)) return chalk.bold.cyan(line);
  if (/^ WORKSPACE/.test(line)) return chalk.dim(line);
  if (/^ PROJEKT/.test(line)) return chalk.green(line);
  if (/^ MODELL/.test(line)) return chalk.cyan(line);
  if (/^ DETAILS/.test(line)) return chalk.dim.cyan(line);
  if (/^ APPROVAL/.test(line)) return chalk.yellow(line);
  if (/^━+$/.test(line) || index === total - 5) return chalk.dim(line);
  if (index === total - 4) return chalk.yellow(line);
  if (index === total - 3) return chalk.cyan(line);
  if (index === total - 2) return chalk.bold.white(line);
  if (index === total - 1) return chalk.dim(line);
  if (/^\s*DU(?:\s|·|$)/.test(line)) return chalk.bold.green(line);
  if (/^\s*ROUTERCODE(?:\s|·|$)/.test(line)) return chalk.bold.cyan(line);
  if (/^\s*FEHLER(?:\s|·|$)/.test(line)) return chalk.bold.red(line);
  if (/^\s*SYSTEM(?:\s|·|$)/.test(line)) return chalk.bold.magenta(line);
  if (/^\s*✓\s/.test(line)) return chalk.green(line);
  if (/^\s*!\s/.test(line)) return chalk.yellow(line);
  if (/^\s*(?:KOMPRESSOR-)?MODELL AUSWÄHLEN/.test(line)) {
    return chalk.bold.cyan(line);
  }
  if (/^\s*DENKEN \[/.test(line)) return chalk.bold.magenta(line);
  if (/^\s*ANTWORTVORSCHLÄGE/.test(line)) return chalk.bold.cyan(line);
  if (/^\s*›/.test(line)) return chalk.bold.green(line);
  if (/^\s*[┌│└]/.test(line)) return chalk.cyan(line);
  if (/^\s*↑/.test(line)) return chalk.yellow(line);
  return line;
}
