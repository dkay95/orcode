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
  routeCoreCompact,
  routeCoreLarge,
  resolveGlyphMode,
  type GlyphEnvironment,
} from "./branding.js";
import {
  commandTokenIsExact,
  rankSlashCommands,
  type SlashCommandDefinition,
} from "./command-catalog.js";
import { DEFAULT_APPEARANCE, type AppearanceConfig } from "./config.js";
import type {
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "./settings-controller.js";
import type { SettingsSurface } from "./settings-session.js";
import type { AgentRunEvent, ChatTurn, ModelInfo, ToolCallPreview } from "./types.js";
import { ProcessEventRedactor } from "./redaction.js";
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
import {
  buildSettingsFrame,
  type SettingsHitTarget,
} from "./ui/settings-frame.js";
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
const ENABLE_SGR_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_SGR_MOUSE = "\u001b[?1000l\u001b[?1006l";
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
const TERMINAL_PROCESS_CAPACITY = 512;
const MAX_MOUSE_SEQUENCE_LENGTH = 32;
const MAX_SETTINGS_SEARCH_CODEPOINTS = 120;
const MAX_BUFFERED_SETTINGS_INPUTS = 128;
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

interface BufferedSettingsKey {
  readonly kind: "key";
  readonly character: string;
  readonly key: Pick<Key, "name" | "ctrl" | "meta" | "shift">;
  readonly codepoints: number;
}

interface BufferedSettingsIntent {
  readonly kind: "intent";
  readonly intent: SettingsIntent;
}

type BufferedSettingsInput = BufferedSettingsKey | BufferedSettingsIntent;

interface MouseKeypressToken {
  raw: string;
  consumed: number;
  complete: boolean;
  click: { readonly column: number; readonly row: number } | null;
  passthroughSuffix: boolean;
  readonly surface: UiSurface;
  readonly mode: UiMode;
}

export interface ChoicePickerItem {
  value: string;
  label: string;
  description: string;
}

export type UiSurface = "chat" | "settings";

export type TerminalThemeFactory = (options: { readonly ascii: boolean }) => Theme;

export type SettingsModelEditorRequest = Omit<SettingsEditorRequest, "editor"> & {
  readonly editor: Extract<SettingsEditorRequest["editor"], { readonly kind: "model" }>;
};

export interface SettingsEditorResolver {
  /** Synchronous, secretless lookup over the caller's already-cached ModelInfo projection. */
  searchModels(
    request: SettingsModelEditorRequest,
    query: string,
  ): readonly ModelInfo[];
}

export interface TerminalUiOptions {
  readonly appearance?: AppearanceConfig;
  readonly environment?: GlyphEnvironment;
  readonly settingsEditorResolver?: SettingsEditorResolver;
  readonly themeFactory?: TerminalThemeFactory;
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

function settingsSearchChars(value: string): string[] {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, "")]
    .slice(0, MAX_SETTINGS_SEARCH_CODEPOINTS);
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

export class TerminalUi implements SettingsSurface {
  readonly supported: boolean;
  #theme: Theme;
  readonly #themeFactory: TerminalThemeFactory;
  readonly #glyphEnvironment: GlyphEnvironment;
  readonly #settingsEditorResolver: SettingsEditorResolver | null;
  #appearance: AppearanceConfig;
  readonly #vm = new RunViewModel();
  #surface: UiSurface = "chat";
  #settingsView: SettingsViewModel | null = null;
  #settingsIntentResolve: ((intent: SettingsIntent) => void) | null = null;
  #settingsIntentReject: ((error: Error) => void) | null = null;
  #settingsInputQueue: BufferedSettingsInput[] = [];
  #settingsQueuedCodepoints = 0;
  #settingsSearchChars: string[] = [];
  #settingsSearchCursor = 0;
  #lastSettingsHitTargets: readonly SettingsHitTarget[] = [];
  #editorChars: string[] = [];
  #editorCursor = 0;
  #editorRequest: SettingsEditorRequest | null = null;
  #editorResolve: ((result: SettingsEditorResult) => void) | null = null;
  #editorValidationMessage = "";
  #returnSurface: UiSurface | null = null;
  #returnMode: UiMode | null = null;
  #settingsChatStatus: { readonly value: string; readonly at: number } | null = null;
  #closingSettings = false;
  #inputChars: string[] = [];
  #cursor = 0;
  #status = "Bereit";
  #statusAt = 0;
  #mode: UiMode = "idle";
  #active = false;
  #disposed = false;
  #renderTimer: NodeJS.Timeout | null = null;
  #inputResolve: ((value: string) => void) | null = null;
  #inputReject: ((error: Error) => void) | null = null;
  #confirmResolve: ((decision: ApprovalDecision) => void) | null = null;
  #confirmSince = 0;
  #confirmReasonMode = false;
  #confirmRememberAvailable = false;
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
  #pickerMultiple = false;
  readonly #pickerSelected = new Set<string>();
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
  readonly #processes = new Map<
    string,
    { eventId: string; number: number; name: string; input: Record<string, unknown>; bound: boolean }
  >();
  readonly #processPending = new Map<string, { stream: "stdout" | "stderr"; text: string }>();
  readonly #terminalProcesses = new Set<string>();
  readonly #processRedactor = new ProcessEventRedactor();
  #tick = 0;
  #spinnerTimer: NodeJS.Timeout | null = null;
  #mouseProtocolBuffer = "";
  #mouseProtocolBufferRecovery = false;
  #openMouseKeypressToken: MouseKeypressToken | null = null;
  #mouseKeypressTokens: MouseKeypressToken[] = [];
  #mouseReporting = false;
  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly getState: () => DashboardState,
    private readonly stdin = process.stdin as ReadStream,
    private readonly stdout = process.stdout as WriteStream,
    theme?: Theme,
    options: TerminalUiOptions = {},
  ) {
    this.supported = Boolean(
      stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function",
    );
    this.#themeFactory =
      options.themeFactory ??
      (theme
        ? ({ ascii }) => createTheme({ level: theme.level, ascii })
        : (themeOptions) => createTheme(themeOptions));
    this.#glyphEnvironment = options.environment ?? process.env;
    this.#settingsEditorResolver = options.settingsEditorResolver ?? null;
    this.#appearance = { ...(options.appearance ?? DEFAULT_APPEARANCE) };
    const glyphMode = resolveGlyphMode(this.#appearance.glyphMode, this.#glyphEnvironment);
    this.#theme = theme ?? this.#themeFactory({ ascii: glyphMode === "ascii" });
    for (const signal of SIGNALS) {
      this.#signalHandlers.set(signal, () => this.#terminate(signal));
    }
  }

  get active(): boolean {
    return this.#active;
  }

  begin(view: SettingsViewModel): void {
    this.#requireActive();
    if (this.#settingsIntentResolve || this.#settingsIntentReject) {
      throw new Error("Settings warten bereits auf eine Eingabe.");
    }
    if (this.#surface !== "settings") {
      this.#settingsChatStatus = { value: this.#status, at: this.#statusAt };
    }
    this.#surface = "settings";
    this.#settingsView = view;
    this.#clearSettingsInputQueue();
    this.#settingsSearchChars = settingsSearchChars(view.search.query);
    this.#settingsSearchCursor = this.#settingsSearchChars.length;
    this.#lastSettingsHitTargets = [];
    this.#syncMouseReporting();
    this.scheduleRender(true);
  }

  nextIntent(view: SettingsViewModel): Promise<SettingsIntent> {
    if (this.#surface !== "settings" || this.#settingsView === null) {
      return Promise.reject(new Error("Settings sind nicht geöffnet."));
    }
    if (this.#settingsIntentResolve || this.#settingsIntentReject) {
      const error = new Error("Es darf nur eine Settings-Eingabe gleichzeitig warten.");
      const reject = this.#settingsIntentReject;
      this.#settingsIntentResolve = null;
      this.#settingsIntentReject = null;
      this.#closeSettingsSurface();
      reject?.(error);
      return Promise.reject(error);
    }
    const previousView = this.#settingsView;
    const incomingSearchChars = settingsSearchChars(view.search.query);
    const incomingQuery = incomingSearchChars.join("");
    const preserveLocalCursor = Boolean(
      previousView
      && previousView.search.active === view.search.active
      && previousView.selectedCategoryId === view.selectedCategoryId
      && view.search.active
      && this.#settingsSearchChars.join("") === incomingQuery,
    );
    this.#settingsView = view;
    this.#settingsSearchChars = incomingSearchChars;
    this.#settingsSearchCursor = preserveLocalCursor
      ? clamp(this.#settingsSearchCursor, 0, incomingSearchChars.length)
      : incomingSearchChars.length;
    this.#lastSettingsHitTargets = [];
    this.scheduleRender(true);
    const pending = new Promise<SettingsIntent>((resolve, reject) => {
      this.#settingsIntentResolve = resolve;
      this.#settingsIntentReject = reject;
    });
    this.#drainSettingsInput();
    return pending;
  }

  edit(request: SettingsEditorRequest): Promise<SettingsEditorResult> {
    if (
      !this.#active
      || this.#surface !== "settings"
      || this.#settingsView === null
      || this.#settingsIntentResolve
      || this.#editorResolve
      || this.#returnSurface
    ) {
      return Promise.resolve({ kind: "cancel" });
    }

    this.#returnSurface = this.#surface;
    this.#returnMode = this.#mode;
    this.#surface = "chat";
    this.#lastSettingsHitTargets = [];
    this.#editorRequest = request;
    this.#editorValidationMessage = oneLine(request.validationMessage ?? "");
    this.#setEditorValue(request.initialValue);

    return new Promise<SettingsEditorResult>((resolve) => {
      this.#editorResolve = resolve;
      const descriptor = request.editor;
      switch (descriptor.kind) {
        case "choice":
          this.#choiceAll = descriptor.options.map((option) => ({ ...option }));
          this.#choiceCurrent = typeof request.initialValue === "string"
            ? request.initialValue
            : "";
          this.#choiceInitial = this.#choiceCurrent;
          this.#resetEditor();
          this.#refreshChoices();
          this.#enterMode("choice-picker", `${oneLine(request.label)} auswählen`);
          break;
        case "model": {
          if (!this.#settingsEditorResolver) {
            this.#resolveSettingsEditor({ kind: "cancel" });
            break;
          }
          const modelRequest = request as SettingsModelEditorRequest;
          this.#pickerSearch = (query) => this.#settingsEditorResolver!
            .searchModels(modelRequest, query);
          this.#pickerCurrent = typeof request.initialValue === "string"
            ? request.initialValue
            : "";
          this.#pickerMultiple = descriptor.multiple === true;
          this.#pickerSelected.clear();
          if (this.#pickerMultiple && Array.isArray(request.initialValue)) {
            for (const id of request.initialValue) this.#pickerSelected.add(id);
          }
          this.#resetEditor();
          try {
            this.#refreshPicker();
          } catch {
            this.#resolveSettingsEditor({ kind: "cancel" });
            break;
          }
          this.#enterMode("model-picker", oneLine(request.label) || "Modell auswählen");
          break;
        }
        case "number":
        case "text":
          this.#enterMode("validated-input", `${oneLine(request.label)} bearbeiten`);
          break;
        case "confirm":
          this.#confirmSince = Date.now();
          this.#confirmRememberAvailable = false;
          this.#enterMode("confirm", "Settings-Aktion bestätigen");
          break;
        case "invoke":
          this.#resolveSettingsEditor({ kind: "value", value: true });
          break;
        case "readonly":
          this.#resolveSettingsEditor({ kind: "cancel" });
          break;
      }
      this.#drainSettingsEditorInput();
    });
  }

  end(): void {
    this.#closingSettings = true;
    try {
      if (this.#editorResolve && this.#returnSurface === "settings") {
        this.#resolveSettingsEditor({ kind: "cancel" });
      }
      if (this.#returnSurface === "settings") {
        if (this.#pickerResolve || this.#choiceResolve) this.#resolveSelection(null);
        else if (this.#secretResolve) this.#resolveSecret(null);
        else if (this.#confirmResolve) this.#resolveConfirm({ accepted: false });
        else if (this.#recordingResolve) this.#resolveRecording("cancel");
      }
      if (this.#settingsIntentReject) {
        const reject = this.#settingsIntentReject;
        this.#settingsIntentResolve = null;
        this.#settingsIntentReject = null;
        reject(new UiExitError());
      }
      this.#closeSettingsSurface();
    } finally {
      this.#closingSettings = false;
    }
  }

  applyAppearance(appearance: AppearanceConfig): void {
    this.#appearance = { ...appearance };
    const glyphMode = resolveGlyphMode(appearance.glyphMode, this.#glyphEnvironment);
    this.#theme = this.#themeFactory({ ascii: glyphMode === "ascii" });
    this.#forgetGeometry();
    this.scheduleRender(true);
  }

  /**
   * `maximum` used to default to 12 while callers passed `recentTurns(40)`,
   * so the extra 28 turns were silently dropped here. The default now matches
   * what the callers ask for; pass a smaller value to cap deliberately.
   */
  loadTurns(turns: readonly ChatTurn[], maximum = 40): void {
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
    for (const safe of this.#processRedactor.push(event)) {
      this.#handleRedactedRunEvent(safe);
    }
  }

  #handleRedactedRunEvent(event: AgentRunEvent): void {
    if (
      event.type === "process-start" ||
      event.type === "process-output" ||
      event.type === "process-end"
    ) {
      this.#applyProcessEvent(event);
    } else {
      this.#vm.apply(event);
    }
    if (event.type === "run-start") {
      this.#run = {
        phase: "Lauf wird vorbereitet",
        startedAt: event.timestamp,
        lastEventAt: event.timestamp,
        step: 1,
        maxSteps: event.maxSteps,
        costUsd: 0,
        costKnowledge: event.costKnowledge === "unknown" ? "unknown" : "known",
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
      if (event.type === "model-end") {
        run.costUsd += event.costUsd;
        if (event.costKnowledge === "unknown") run.costKnowledge = "unknown";
      }
      if (event.type === "run-end") {
        run.running = false;
        for (const id of this.#processes.keys()) this.#rememberTerminalProcess(id);
        this.#processes.clear();
        this.#processPending.clear();
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

  #applyProcessEvent(
    event: Extract<AgentRunEvent, { type: "process-start" | "process-output" | "process-end" }>,
  ): void {
    if (this.#terminalProcesses.has(event.id)) return;
    const safe = event;
    if (safe.type === "process-start") {
      if (this.#processes.has(safe.id)) return;
      const binding = {
        eventId: safe.toolId ?? safe.id,
        number: safe.toolNumber ?? 0,
        name: safe.name,
        input: safe.input,
        bound: safe.toolId !== undefined,
      };
      this.#processes.set(safe.id, binding);
      if (!binding.bound) {
        this.#vm.apply({
          type: "tool-start",
          id: binding.eventId,
          number: binding.number,
          name: binding.name,
          input: binding.input,
          timestamp: safe.timestamp,
        });
      }
      return;
    }
    const binding = this.#processes.get(safe.id);
    if (!binding) return;
    if (safe.type === "process-output") {
      this.#bufferProcessOutput(binding, safe.stream, safe.text, safe.timestamp);
      return;
    }
    this.#flushProcessOutput(binding, safe.timestamp);
    if (!binding.bound) {
      const stdout = safe.stdout ?? "";
      const stderr = safe.stderr || safe.error || "";
      const output = safe.name === "git_diff"
        ? {
            diff: stdout,
            stderr,
            exitCode: safe.exitCode,
            truncated: safe.truncated,
            timedOut: safe.timedOut,
            aborted: safe.aborted,
          }
        : {
            stdout,
            stderr,
            exitCode: safe.exitCode,
            truncated: safe.truncated,
            timedOut: safe.timedOut,
            aborted: safe.aborted,
          };
      this.#vm.apply({
        type: "tool-end",
        id: binding.eventId,
        number: binding.number,
        name: binding.name,
        input: binding.input,
        output,
        durationMs: safe.durationMs,
        timestamp: safe.timestamp,
      });
    }
    this.#processes.delete(safe.id);
    this.#processPending.delete(safe.id);
    this.#rememberTerminalProcess(safe.id);
  }

  #rememberTerminalProcess(id: string): void {
    this.#terminalProcesses.delete(id);
    this.#terminalProcesses.add(id);
    while (this.#terminalProcesses.size > TERMINAL_PROCESS_CAPACITY) {
      const oldest = this.#terminalProcesses.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalProcesses.delete(oldest);
    }
  }

  #bufferProcessOutput(
    binding: { eventId: string; number: number },
    stream: "stdout" | "stderr",
    text: string,
    timestamp: number,
  ): void {
    const operationId = [...this.#processes.entries()].find(([, value]) => value === binding)?.[0];
    if (!operationId || !text) return;
    const pending = this.#processPending.get(operationId);
    if (pending && pending.stream !== stream) {
      this.#emitProcessOutput(binding, pending.stream, pending.text, timestamp);
      this.#processPending.delete(operationId);
    }
    const current = this.#processPending.get(operationId);
    const combined = `${current?.text ?? ""}${text}`;
    const lastNewline = Math.max(combined.lastIndexOf("\n"), combined.lastIndexOf("\r"));
    if (lastNewline >= 0) {
      this.#emitProcessOutput(binding, stream, combined.slice(0, lastNewline + 1), timestamp);
      const rest = combined.slice(lastNewline + 1);
      if (rest) this.#processPending.set(operationId, { stream, text: rest });
      else this.#processPending.delete(operationId);
    } else {
      this.#processPending.set(operationId, { stream, text: combined });
    }
  }

  #flushProcessOutput(binding: { eventId: string; number: number }, timestamp: number): void {
    const operationId = [...this.#processes.entries()].find(([, value]) => value === binding)?.[0];
    if (!operationId) return;
    const pending = this.#processPending.get(operationId);
    if (pending?.text) this.#emitProcessOutput(binding, pending.stream, pending.text, timestamp);
    this.#processPending.delete(operationId);
  }

  #emitProcessOutput(
    binding: { eventId: string; number: number },
    stream: "stdout" | "stderr",
    text: string,
    timestamp: number,
  ): void {
    if (!text) return;
    this.#vm.apply({
      type: "tool-output",
      id: binding.eventId,
      number: binding.number,
      stream,
      text,
      timestamp,
    });
  }

  pickModel(
    searchModels: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title = "Modell auswählen",
  ): Promise<ModelInfo | null> {
    this.#requireActive();
    this.#captureSettingsReturn();
    this.#pickerSearch = searchModels;
    this.#pickerCurrent = currentModel;
    this.#resetEditor();
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
    this.#captureSettingsReturn();
    this.#choiceAll = [...items];
    this.#choiceCurrent = currentValue;
    this.#choiceInitial = initialValue;
    this.#resetEditor();
    this.#refreshChoices();
    this.#enterMode("choice-picker", `${oneLine(title)} auswählen`);
    return new Promise<ChoicePickerItem | null>((resolve) => {
      this.#choiceResolve = resolve;
    });
  }

  readSecret(label: string): Promise<string | null> {
    this.#requireActive();
    this.#captureSettingsReturn();
    this.#secretLabel = oneLine(label);
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#clearMouseProtocol();
    this.#resetEditor();
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
    this.#captureSettingsReturn();
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

  confirmAction(
    title: string,
    details: string,
    rememberAvailable = false,
  ): Promise<ApprovalDecision> {
    if (!this.#active) return Promise.resolve({ accepted: false });
    this.#captureSettingsReturn();
    this.#confirmRememberAvailable = rememberAvailable;
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
    const rememberAvailable = preview.rememberAvailable === true && preview.subject !== undefined;
    const details = [
      ...(preview.subject
        ? ["Freigabe-Subjekt (exakt):", preview.subject]
        : []),
      ...this.#detailLines(preview.details ?? preview.name),
    ];
    this.#approvalBlockId = this.#vm.pushApproval({
      risk: preview.risk,
      summary: `${approvalRiskLabel(preview.risk)}${separator}${oneLine(preview.summary)}`,
      details,
      rememberHint: rememberAvailable
        ? "a = dieses exakte Subject immer erlauben · d = dieses exakte Subject nie erlauben"
        : "Immer/Nie ist ohne exaktes Subject nicht verfügbar",
    }).id;
    return this.confirmAction(preview.summary, preview.details ?? preview.name, rememberAvailable);
  }

  /** A7: the context-fill header segment is fed from outside (agent/session). */
  setContextPercent(percent: number | undefined): void {
    this.#contextPercent = percent === undefined ? undefined : clamp(percent, 0, 999);
    this.scheduleRender();
  }

  start(): void {
    if (!this.supported || this.#active || this.#disposed) return;
    emitKeypressEvents(this.stdin);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    // This listener must precede readline's keypress decoder. SGR mouse bytes
    // otherwise arrive as ordinary text after an Escape prefix. It is owned
    // only while the UI is active and is balanced in #detachTerminal.
    this.stdin.prependListener("data", this.#onTerminalData);
    this.#active = true;
    // B12: a paste whose end marker never arrived must not survive a restart —
    // otherwise every later key, Ctrl+C included, is swallowed as paste text.
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.stdin.on("keypress", this.#onKeypress);
    this.stdin.on("end", this.#onEof);
    process.on("SIGWINCH", this.#onResize);
    for (const [signal, handler] of this.#signalHandlers) process.on(signal, handler);
    process.on("exit", this.#onProcessExit);
    process.on("uncaughtExceptionMonitor", this.#onFatalError);
    this.stdout.write(`${ENTER_ALTERNATE_SCREEN}${ENABLE_BRACKETED_PASTE}${HOME}${ERASE_BELOW}`);
    this.#forgetGeometry();
    if (this.#run?.running) this.#startSpinner();
    this.render(true);
    this.#syncMouseReporting();
  }

  stop(): void {
    this.#settlePendingForStop();
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

  /** Permanently releases terminal input ownership. A disposed UI cannot restart. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.stdin.off("data", this.#onTerminalData);
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
    if (this.#surface === "settings" && this.#settingsView) {
      const glyphMode = resolveGlyphMode(this.#appearance.glyphMode, this.#glyphEnvironment);
      const result = buildSettingsFrame({
        width: Math.max(1, this.stdout.columns || 80),
        height: Math.max(1, this.stdout.rows || 24),
        theme: this.#theme,
        view: this.#settingsView,
        brand: {
          large: routeCoreLarge(glyphMode),
          compact: routeCoreCompact(glyphMode),
          visible: this.#appearance.showLargeLogo,
        },
      });
      this.#lastSettingsHitTargets = result.hitTargets;
      return result.frame;
    }
    const editorBuffer = this.#returnSurface === "settings"
      || this.#mode === "model-picker"
      || this.#mode === "choice-picker"
      || this.#mode === "secret"
      || this.#mode === "validated-input"
      || (this.#mode === "confirm" && this.#confirmReasonMode);
    const input: DashboardFrameInput = {
      width: Math.max(1, this.stdout.columns || 80),
      height: Math.max(1, this.stdout.rows || 24),
      theme: this.#theme,
      state: this.getState(),
      blocks: this.#vm.blocks,
      mode: this.#mode,
      input: editorBuffer ? this.#editorChars.join("") : this.#inputChars.join(""),
      cursor: editorBuffer ? this.#editorCursor : this.#cursor,
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
    if (this.#mode === "confirm") input.rememberAvailable = this.#confirmRememberAvailable;
    if (this.#mode === "secret") input.secretLabel = this.#secretLabel;
    if (this.#editorRequest && this.#returnSurface === "settings") {
      input.editorPrompt = {
        label: oneLine(this.#editorRequest.label),
        description: oneLine(this.#editorRequest.description),
        ...(this.#editorValidationMessage
          ? { validationMessage: this.#editorValidationMessage }
          : {}),
      };
      if (this.#mode === "confirm") input.settingsConfirmation = true;
    }
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

  #closeSettingsSurface(): void {
    this.#surface = "chat";
    this.#settingsView = null;
    this.#clearSettingsInputQueue();
    this.#settingsSearchChars = [];
    this.#settingsSearchCursor = 0;
    this.#lastSettingsHitTargets = [];
    if (this.#settingsChatStatus) {
      this.#status = this.#settingsChatStatus.value;
      this.#statusAt = this.#settingsChatStatus.at;
      this.#settingsChatStatus = null;
    }
    this.#syncMouseReporting();
    this.#forgetGeometry();
    this.scheduleRender(true);
  }

  #captureSettingsReturn(): void {
    if (this.#surface !== "settings" || this.#returnSurface !== null) return;
    this.#returnSurface = "settings";
    this.#returnMode = this.#mode;
    this.#surface = "chat";
    this.#lastSettingsHitTargets = [];
  }

  #restoreCapturedSurface(fallbackMode: UiMode, status: string): void {
    if (this.#returnSurface === null) {
      this.#enterMode(fallbackMode, status);
      return;
    }
    const returnSurface = this.#returnSurface;
    this.#surface = this.#closingSettings && returnSurface === "settings"
      ? "chat"
      : returnSurface;
    this.#mode = this.#returnMode ?? fallbackMode;
    this.#returnSurface = null;
    this.#returnMode = null;
    if (returnSurface !== "settings") {
      this.#status = status;
      this.#statusAt = Date.now();
    }
    if (this.#closingSettings) return;
    this.#syncMouseReporting();
    this.#forgetGeometry();
    this.scheduleRender(true);
  }

  #emitSettingsIntent(intent: SettingsIntent): void {
    const resolve = this.#settingsIntentResolve;
    if (this.#surface !== "settings") return;
    if (!resolve) {
      this.#enqueueSettingsIntent(intent);
      return;
    }
    this.#settingsIntentResolve = null;
    this.#settingsIntentReject = null;
    resolve(intent);
  }

  #handleSettingsKey(character: string, key: Key): void {
    if (!this.#settingsView) return;
    if (!this.#settingsIntentResolve) {
      this.#enqueueSettingsKey(character, key);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      this.#emitSettingsIntent({ kind: "move", delta: key.name === "up" ? -1 : 1 });
      return;
    }
    const ordinal = Number(key.name ?? character);
    if (
      Number.isInteger(ordinal)
      && ordinal >= 1
      && ordinal <= 6
      && !this.#settingsView.search.active
      && this.#settingsView.categories[ordinal - 1]
    ) {
      this.#emitSettingsIntent({
        kind: "category",
        categoryId: this.#settingsView.categories[ordinal - 1]!.id,
      });
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.#emitSettingsIntent({ kind: "activate" });
      return;
    }
    if (key.name === "escape") {
      this.#emitSettingsIntent({ kind: "back" });
      return;
    }
    if (!this.#settingsView.search.active) {
      if (character === "/" || key.name === "/") {
        this.#emitSettingsIntent({ kind: "search-start" });
      }
      return;
    }

    let changed = false;
    if (key.name === "backspace") {
      if (this.#settingsSearchCursor > 0) {
        this.#settingsSearchChars.splice(this.#settingsSearchCursor - 1, 1);
        this.#settingsSearchCursor -= 1;
        changed = true;
      }
    } else if (key.name === "delete") {
      if (this.#settingsSearchCursor < this.#settingsSearchChars.length) {
        this.#settingsSearchChars.splice(this.#settingsSearchCursor, 1);
        changed = true;
      }
    } else if (key.name === "left") {
      this.#settingsSearchCursor = Math.max(0, this.#settingsSearchCursor - 1);
      this.scheduleRender(true);
    } else if (key.name === "right") {
      this.#settingsSearchCursor = Math.min(
        this.#settingsSearchChars.length,
        this.#settingsSearchCursor + 1,
      );
      this.scheduleRender(true);
    } else if (key.name === "home") {
      this.#settingsSearchCursor = 0;
      this.scheduleRender(true);
    } else if (key.name === "end") {
      this.#settingsSearchCursor = this.#settingsSearchChars.length;
      this.scheduleRender(true);
    } else if (character && !key.ctrl && !key.meta && !isFunctionKey(key.name)) {
      const capacity = MAX_SETTINGS_SEARCH_CODEPOINTS - this.#settingsSearchChars.length;
      const inserted = settingsSearchChars(character)
        .filter((value) => value >= " ")
        .slice(0, Math.max(0, capacity));
      if (inserted.length) {
        this.#settingsSearchChars.splice(this.#settingsSearchCursor, 0, ...inserted);
        this.#settingsSearchCursor += inserted.length;
        changed = true;
      }
    }
    if (changed) {
      this.#emitSettingsIntent({
        kind: "search-change",
        query: this.#settingsSearchChars.join(""),
      });
    }
  }

  #enqueueSettingsKey(character: string, key: Key): void {
    if (this.#settingsInputQueue.length >= MAX_BUFFERED_SETTINGS_INPUTS) return;
    const capacity = MAX_SETTINGS_SEARCH_CODEPOINTS - this.#settingsQueuedCodepoints;
    const safeCharacter = typeof character === "string" ? character : "";
    const chars = settingsSearchChars(safeCharacter)
      .filter((value) => value >= " ")
      .slice(0, Math.max(0, capacity));
    const name = typeof key.name === "string" ? key.name.slice(0, 32) : undefined;
    if (!chars.length && !name) return;
    this.#settingsInputQueue.push({
      kind: "key",
      character: chars.join(""),
      key: {
        name,
        ctrl: key.ctrl === true,
        meta: key.meta === true,
        shift: key.shift === true,
      },
      codepoints: chars.length,
    });
    this.#settingsQueuedCodepoints += chars.length;
  }

  #enqueueSettingsIntent(intent: SettingsIntent): void {
    if (this.#settingsInputQueue.length >= MAX_BUFFERED_SETTINGS_INPUTS) return;
    this.#settingsInputQueue.push({ kind: "intent", intent });
  }

  #shiftSettingsInput(): BufferedSettingsInput | undefined {
    const input = this.#settingsInputQueue.shift();
    if (input?.kind === "key") {
      this.#settingsQueuedCodepoints = Math.max(
        0,
        this.#settingsQueuedCodepoints - input.codepoints,
      );
    }
    return input;
  }

  #clearSettingsInputQueue(): void {
    this.#settingsInputQueue = [];
    this.#settingsQueuedCodepoints = 0;
  }

  #drainSettingsInput(): void {
    while (this.#settingsIntentResolve && this.#settingsView) {
      const input = this.#shiftSettingsInput();
      if (!input) return;
      if (input.kind === "intent") this.#emitSettingsIntent(input.intent);
      else this.#handleSettingsKey(input.character, input.key as Key);
    }
  }

  #drainSettingsEditorInput(): void {
    while (this.#editorResolve && this.#returnSurface === "settings") {
      const next = this.#settingsInputQueue[0];
      if (!next || next.kind !== "key") return;
      const input = this.#shiftSettingsInput() as BufferedSettingsKey;
      this.#onKeypress(input.character, input.key as Key, true);
    }
  }

  #enterMode(mode: UiMode, status: string): void {
    this.#mode = mode;
    this.#status = status;
    this.#statusAt = Date.now();
    this.#syncMouseReporting();
    this.scheduleRender(true);
  }

  #resetQuery(): void {
    this.#inputChars = [];
    this.#cursor = 0;
  }

  #resetEditor(): void {
    this.#editorChars = [];
    this.#editorCursor = 0;
  }

  #setEditorValue(value: SettingsEditorRequest["initialValue"]): void {
    let text = "";
    if (typeof value === "string" || typeof value === "number") text = String(value);
    else if (Array.isArray(value)) {
      text = value.join(this.#editorRequest?.editor.kind === "text"
        && this.#editorRequest.editor.valueKind === "command-list"
        ? "\n"
        : ", ");
    }
    this.#editorChars = Array.from(text);
    this.#editorCursor = this.#editorChars.length;
  }

  #editEditor(character: string, key: Key): void {
    const chars = this.#editorChars;
    if (key.ctrl && key.name === "u") {
      chars.splice(0, this.#editorCursor);
      this.#editorCursor = 0;
    } else if (key.ctrl && key.name === "a") this.#editorCursor = 0;
    else if (key.ctrl && key.name === "e") this.#editorCursor = chars.length;
    else if (key.name === "backspace") {
      if (this.#editorCursor > 0) {
        chars.splice(this.#editorCursor - 1, 1);
        this.#editorCursor -= 1;
      }
    } else if (key.name === "delete") chars.splice(this.#editorCursor, 1);
    else if (key.name === "left") this.#editorCursor = Math.max(0, this.#editorCursor - 1);
    else if (key.name === "right") {
      this.#editorCursor = Math.min(chars.length, this.#editorCursor + 1);
    } else if (key.name === "home") this.#editorCursor = 0;
    else if (key.name === "end") this.#editorCursor = chars.length;
    else if (character && !key.ctrl && !key.meta && !isFunctionKey(key.name)) {
      const inserted = Array.from(character).filter((entry) => entry >= " ");
      chars.splice(this.#editorCursor, 0, ...inserted);
      this.#editorCursor += inserted.length;
    }
  }

  #submitValidatedEditor(): void {
    const request = this.#editorRequest;
    if (!request) return;
    const raw = this.#editorChars.join("");
    const descriptor = request.editor;
    if (descriptor.kind === "number") {
      const retained = raw.trim();
      if (descriptor.allowOff && retained.toLowerCase() === "off") {
        this.#resolveSettingsEditor({ kind: "value", value: "off" });
        return;
      }
      if (!/^-?(?:\d+|\d*\.\d+)$/u.test(retained)) {
        this.#editorValidationMessage = "Bitte eine gültige Zahl eingeben";
        this.scheduleRender(true);
        return;
      }
      const value = Number(retained);
      if (!Number.isFinite(value) || value < descriptor.minimum || value > descriptor.maximum) {
        this.#editorValidationMessage =
          `Zahl muss zwischen ${descriptor.minimum} und ${descriptor.maximum} liegen`;
        this.scheduleRender(true);
        return;
      }
      if (
        (descriptor.actionId === "max-steps"
          || descriptor.actionId === "verify-repair-rounds"
          || descriptor.actionId === "browser-timeout")
        && !Number.isInteger(value)
      ) {
        this.#editorValidationMessage = "Nur ganze Zahlen sind zulässig";
        this.scheduleRender(true);
        return;
      }
      this.#resolveSettingsEditor({ kind: "value", value });
      return;
    }
    if (descriptor.kind !== "text") return;
    if (descriptor.valueKind === "path") {
      const value = raw.trim();
      if ([...value].length > 4_096) {
        this.#editorValidationMessage = "Pfad ist zu lang";
        this.scheduleRender(true);
        return;
      }
      this.#resolveSettingsEditor({ kind: "value", value });
      return;
    }
    const values = raw
      .split(descriptor.valueKind === "command-list" ? /[\r\n]+/u : /[,\r\n]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length > 20 || values.some((entry) => [...entry].length > 512)) {
      this.#editorValidationMessage = "Liste ist ungültig";
      this.scheduleRender(true);
      return;
    }
    if (descriptor.valueKind === "command-list" && values.length === 0) {
      this.#editorValidationMessage = "Mindestens ein Prüfkommando ist erforderlich";
      this.scheduleRender(true);
      return;
    }
    this.#resolveSettingsEditor({ kind: "value", value: values });
  }

  #resolveSettingsEditor(result: SettingsEditorResult): void {
    const resolve = this.#editorResolve;
    if (!resolve) return;
    const returnSurface = this.#returnSurface;
    this.#editorResolve = null;
    this.#editorRequest = null;
    this.#editorValidationMessage = "";
    this.#resetEditor();
    this.#pickerSearch = null;
    this.#pickerModels = [];
    this.#pickerCurrent = "";
    this.#pickerMultiple = false;
    this.#pickerSelected.clear();
    this.#choiceAll = [];
    this.#choiceItems = [];
    this.#choiceCurrent = "";
    this.#choiceInitial = "";
    this.#selectedIndex = 0;
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#surface = this.#closingSettings && returnSurface === "settings"
      ? "chat"
      : returnSurface ?? "chat";
    this.#mode = this.#returnMode ?? "busy";
    this.#returnSurface = null;
    this.#returnMode = null;
    resolve(result);
    if (this.#closingSettings) return;
    this.#syncMouseReporting();
    this.#forgetGeometry();
    this.scheduleRender(true);
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
      case "process-start":
        return "Prozess läuft";
      case "process-output":
        return "Prozess schreibt Ausgabe";
      case "process-end":
        return event.exitCode === 0 ? "Prozess beendet" : "Prozess fehlgeschlagen";
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
          current: this.#pickerMultiple
            ? this.#pickerSelected.has(model.id)
            : model.id === this.#pickerCurrent,
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
    this.stdin.off("data", this.#onTerminalData);
    this.stdin.off("keypress", this.#onKeypress);
    this.stdin.off("end", this.#onEof);
    process.off("SIGWINCH", this.#onResize);
    for (const [signal, handler] of this.#signalHandlers) process.off(signal, handler);
    process.off("exit", this.#onProcessExit);
    process.off("uncaughtExceptionMonitor", this.#onFatalError);
    try {
      this.#disableMouseReporting();
      this.stdout.write(DISABLE_BRACKETED_PASTE);
      this.stdin.setRawMode(false);
    } catch {
      // The terminal may already be closed after a fatal signal.
    }
    this.#active = false;
    this.#clearMouseProtocol();
    this.#forgetGeometry();
    this.#stopSpinner();
  }

  #settlePendingForStop(): void {
    const editorResolve = this.#editorResolve;
    const pickerResolve = this.#pickerResolve;
    const choiceResolve = this.#choiceResolve;
    const secretResolve = this.#secretResolve;
    const confirmResolve = this.#confirmResolve;
    const recordingResolve = this.#recordingResolve;
    const settingsReject = this.#settingsIntentReject;
    this.#editorResolve = null;
    this.#editorRequest = null;
    this.#editorValidationMessage = "";
    this.#pickerResolve = null;
    this.#choiceResolve = null;
    this.#secretResolve = null;
    this.#confirmResolve = null;
    this.#recordingResolve = null;
    this.#settingsIntentResolve = null;
    this.#settingsIntentReject = null;
    this.#clearSettingsInputQueue();
    this.#pickerSearch = null;
    this.#pickerModels = [];
    this.#choiceAll = [];
    this.#choiceItems = [];
    this.#pickerMultiple = false;
    this.#pickerSelected.clear();
    this.#selectedIndex = 0;
    this.#secretLabel = "";
    this.#confirmReasonMode = false;
    this.#confirmRememberAvailable = false;
    if (this.#approvalBlockId) {
      this.#vm.dropApproval(this.#approvalBlockId);
      this.#approvalBlockId = null;
    }
    this.#resetEditor();
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#clearMouseProtocol();
    if (this.#surface === "settings" || this.#returnSurface === "settings") {
      this.#surface = "chat";
      this.#settingsView = null;
      this.#settingsSearchChars = [];
      this.#settingsSearchCursor = 0;
      this.#lastSettingsHitTargets = [];
    }
    this.#returnSurface = null;
    this.#returnMode = null;
    this.#settingsChatStatus = null;
    this.#closingSettings = false;
    if (!this.#inputResolve) this.#mode = "idle";
    this.#status = "Eingabe abgebrochen";
    this.#statusAt = Date.now();
    editorResolve?.({ kind: "cancel" });
    pickerResolve?.(null);
    choiceResolve?.(null);
    secretResolve?.(null);
    confirmResolve?.({ accepted: false });
    recordingResolve?.("cancel");
    settingsReject?.(new UiExitError());
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

  #onEof = (): void => this.stop();

  #onProcessExit = (): void => {
    if (!this.#active) return;
    this.#settlePendingForStop();
    try {
      this.stdin.setRawMode(false);
      if (this.#mouseReporting) this.stdout.write(DISABLE_SGR_MOUSE);
      this.stdout.write(LEAVE_TERMINAL);
    } catch {
      // Process exit must not be delayed by terminal cleanup failures.
    }
  };

  #onResize = (): void => {
    this.#lastRenderedLines = [];
    this.render(true);
  };

  #onKeypress = (character: string, key: Key, accepted = false): void => {
    if (!accepted) {
      const filteredKeypress = this.#filterMouseKeypress(character, key);
      if (!filteredKeypress) return;
      ({ character, key } = filteredKeypress);
    }
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
      if (this.#surface !== "settings") this.setStatus("Einfügen läuft …", false);
      this.scheduleRender(true);
      return;
    }
    if (key.name === "paste-end") {
      if (this.#pasting) this.#finishPaste();
      return;
    }
    if (this.#pasting) {
      const rawSecretBytes = this.#mode === "secret"
        ? key.sequence || character || ""
        : "";
      if (key.name === "enter" || key.name === "return") {
        this.#pasteBuffer += this.#mode === "secret" && rawSecretBytes
          ? rawSecretBytes
          : "\n";
      } else if (key.name === "tab") {
        this.#pasteBuffer += this.#mode === "secret" && rawSecretBytes
          ? rawSecretBytes
          : "\t";
      }
      else if (this.#mode === "secret" && rawSecretBytes) {
        this.#pasteBuffer += rawSecretBytes;
      } else if (character) this.#pasteBuffer += character;
      return;
    }
    if (this.#mode === "model-picker" || this.#mode === "choice-picker") {
      this.#handleSelectKey(character, key);
      return;
    }
    if (this.#mode === "secret") {
      if (key.name === "return") this.#resolveSecret(this.#editorChars.join(""));
      else if (key.name === "escape") this.#resolveSecret(null);
      else {
        this.#editEditor(character, key);
        this.scheduleRender();
      }
      return;
    }
    if (this.#mode === "validated-input") {
      if (
        (key.name === "return" || key.name === "enter")
        && key.shift
        && this.#editorRequest?.editor.kind === "text"
        && this.#editorRequest.editor.valueKind === "command-list"
      ) {
        this.#editorChars.splice(this.#editorCursor, 0, "\n");
        this.#editorCursor += 1;
        this.scheduleRender(true);
      } else if (key.name === "return" || key.name === "enter") this.#submitValidatedEditor();
      else if (key.name === "escape") this.#resolveSettingsEditor({ kind: "cancel" });
      else {
        const previous = this.#editorChars.join("");
        this.#editEditor(character, key);
        if (this.#editorChars.join("") !== previous) this.#editorValidationMessage = "";
        this.scheduleRender(true);
      }
      return;
    }
    if (this.#mode === "recording") {
      if (key.name === "return") this.#resolveRecording("stop");
      else if (key.name === "escape") this.#resolveRecording("cancel");
      return;
    }
    if (this.#surface === "settings") {
      this.#handleSettingsKey(character, key);
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
      if (this.#editorResolve && this.#returnSurface === "settings") {
        if (key.name === "return" || key.name === "enter" || key.name === "y" || key.name === "j") {
          this.#resolveSettingsEditor({ kind: "value", value: true });
        } else if (key.name === "n") {
          this.#resolveSettingsEditor({ kind: "value", value: false });
        } else if (key.name === "escape") {
          this.#resolveSettingsEditor({ kind: "cancel" });
        } else {
          this.#editorValidationMessage = "j oder Enter bestätigen · n oder Esc abbrechen";
          this.scheduleRender(true);
        }
        return;
      }
      // `g` (Begründung) opens a one-line reason prompt; everything else
      // still resolves the approval directly.
      if (this.#confirmReasonMode) {
        if (key.name === "return") {
          const reason = this.#editorChars.join("").trim();
          this.#resolveConfirm({ accepted: false, reason: reason || undefined });
        } else if (key.name === "escape") {
          this.#confirmReasonMode = false;
          this.#resetEditor();
          this.setStatus("Bestätigung erforderlich", false);
          this.#mode = "confirm";
          this.scheduleRender(true);
        } else {
          this.#editEditor(character, key);
          this.scheduleRender(true);
        }
        return;
      }
      // `j`/`y` yes, `a` always allow, `d` never allow, `g` Begründung; an
      // unbound key answers instead of staying silent (Bauplan 2.5).
      if (key.name === "y" || key.name === "j") this.#resolveConfirm({ accepted: true });
      else if (key.name === "a" && this.#confirmRememberAvailable) {
        this.#resolveConfirm({ accepted: true, remember: "allow" });
      } else if (key.name === "d" && this.#confirmRememberAvailable) {
        this.#resolveConfirm({ accepted: false, remember: "deny" });
      } else if (key.name === "a" || key.name === "d") {
        this.setStatus("Immer/Nie ist ohne exaktes Subject nicht verfügbar", false);
        this.#mode = "confirm";
        this.scheduleRender(true);
      } else if (key.name === "g") {
        this.#confirmReasonMode = true;
        this.#resetEditor();
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

  #onTerminalData = (chunk: string | Buffer): void => {
    if (!this.#active) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const buffered = this.#mouseProtocolBuffer;
    const sequence = `${buffered}${text}`;
    const openToken = this.#openMouseKeypressToken;
    let recoverBufferedPrefix = this.#mouseProtocolBufferRecovery;
    this.#mouseProtocolBuffer = "";
    this.#mouseProtocolBufferRecovery = false;
    this.#openMouseKeypressToken = null;

    if (buffered && recoverBufferedPrefix) {
      const confirmedMouse = sequence.startsWith("\u001b[<");
      const stillAmbiguous = "\u001b[<".startsWith(sequence);
      if (confirmedMouse) recoverBufferedPrefix = false;
      else if (!stillAmbiguous) {
        this.#createMouseRecoveryToken(buffered);
        recoverBufferedPrefix = false;
      }
    }

    let cursor = 0;
    while (cursor < sequence.length) {
      const escape = sequence.indexOf("\u001b", cursor);
      if (escape < 0) break;
      const rest = sequence.slice(escape);

      // ESC and ESC[ remain ambiguous until the next raw chunk. Do not mark
      // them as mouse bytes: readline may complete them as a normal CSI key.
      if (rest.length < 3 && "\u001b[<".startsWith(rest)) {
        this.#mouseProtocolBuffer = rest;
        this.#mouseProtocolBufferRecovery = recoverBufferedPrefix;
        break;
      }
      if (!rest.startsWith("\u001b[<")) {
        cursor = escape + 1;
        continue;
      }

      const token = openToken && escape === 0
        ? openToken
        : this.#createMouseKeypressToken();
      const freshStart = openToken === token ? buffered.length : escape;

      const match = /^\u001b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/.exec(rest);
      if (match) {
        const end = escape + match[0].length;
        if (end > freshStart) token.raw += sequence.slice(freshStart, end);
        const button = Number(match[1]);
        const column = Number(match[2]);
        const row = Number(match[3]);
        token.click = (
          match[4] === "M"
          && button === 0
          && Number.isSafeInteger(column)
          && Number.isSafeInteger(row)
        ) ? { column, row } : null;
        token.complete = true;
        cursor = end;
        continue;
      }

      if (
        rest.length <= MAX_MOUSE_SEQUENCE_LENGTH
        && /^\u001b\[<\d{0,3}(?:;\d{0,5}(?:;\d{0,5})?)?$/.test(rest)
      ) {
        if (sequence.length > freshStart) token.raw += sequence.slice(freshStart);
        this.#mouseProtocolBuffer = rest;
        this.#openMouseKeypressToken = token;
        break;
      }

      // A malformed SGR candidate is terminal control input, never user text.
      // Consume through its terminator when present so a printable suffix in
      // the same chunk can still reach readline exactly once.
      const terminator = rest.slice(3, MAX_MOUSE_SEQUENCE_LENGTH).search(/[Mm]/u);
      const nextEscape = rest.indexOf("\u001b", 1);
      const terminatorEnd = terminator >= 0
        ? escape + 3 + terminator + 1
        : sequence.length;
      const nextEscapeStart = nextEscape >= 0
        ? escape + nextEscape
        : sequence.length;
      const malformedEnd = Math.min(terminatorEnd, nextEscapeStart);
      if (malformedEnd > freshStart) token.raw += sequence.slice(freshStart, malformedEnd);
      token.complete = true;
      if (nextEscapeStart === malformedEnd) {
        const nextPrefix = sequence.slice(nextEscapeStart);
        recoverBufferedPrefix = nextPrefix.length < 3
          && "\u001b[<".startsWith(nextPrefix);
      }
      cursor = malformedEnd;
    }
  };

  #clearMouseProtocol(): void {
    this.#mouseProtocolBuffer = "";
    this.#mouseProtocolBufferRecovery = false;
    this.#openMouseKeypressToken = null;
    this.#mouseKeypressTokens = [];
  }

  #retireMouseProtocol(): void {
    this.#mouseProtocolBuffer = "";
    this.#mouseProtocolBufferRecovery = false;
    this.#openMouseKeypressToken = null;
    this.#mouseKeypressTokens = this.#mouseKeypressTokens.filter((token) => {
      if (!token.complete || token.consumed >= token.raw.length) return false;
      token.click = null;
      return true;
    });
  }

  #createMouseKeypressToken(): MouseKeypressToken {
    const token: MouseKeypressToken = {
      raw: "",
      consumed: 0,
      complete: false,
      click: null,
      passthroughSuffix: false,
      surface: this.#surface,
      mode: this.#mode,
    };
    this.#mouseKeypressTokens.push(token);
    return token;
  }

  #createMouseRecoveryToken(raw: string): void {
    if (!raw) return;
    const token = this.#createMouseKeypressToken();
    token.raw = raw;
    token.complete = true;
    token.passthroughSuffix = true;
  }

  #finishConsumedMouseTokens(): void {
    while (true) {
      const token = this.#mouseKeypressTokens[0];
      if (!token?.complete || token.consumed < token.raw.length) return;
      this.#mouseKeypressTokens.shift();
      if (this.#openMouseKeypressToken === token) this.#openMouseKeypressToken = null;
      if (
        token.click
        && token.surface === this.#surface
        && token.mode === this.#mode
      ) {
        this.#selectMouseRow(token.click.column, token.click.row);
      }
    }
  }

  #filterMouseKeypress(character: string, key: Key): { character: string; key: Key } | null {
    if (!this.#mouseKeypressTokens.length) {
      if (key.name === "escape" && this.#mouseProtocolBuffer === "\u001b") {
        this.#mouseProtocolBuffer = "";
      }
      return { character, key };
    }
    const actual = key.sequence || character || "";
    if (
      key.name === "escape"
      && actual === "\u001b"
      && this.#mouseProtocolBuffer === "\u001b"
      && !this.#openMouseKeypressToken
    ) {
      this.#mouseProtocolBuffer = "";
      return { character, key };
    }
    if (!actual) return { character, key };

    let remainder = actual;
    let passthroughSuffix = false;
    while (remainder) {
      this.#finishConsumedMouseTokens();
      const token = this.#mouseKeypressTokens[0];
      if (!token) break;
      const expected = token.raw.slice(token.consumed);
      if (!expected) return null;
      if (expected.startsWith(remainder)) {
        token.consumed += remainder.length;
        this.#finishConsumedMouseTokens();
        return null;
      }
      if (remainder.startsWith(expected)) {
        passthroughSuffix ||= token.passthroughSuffix;
        token.consumed += expected.length;
        remainder = remainder.slice(expected.length);
        this.#finishConsumedMouseTokens();
        continue;
      }
      // This key precedes the queued mouse frame in the same raw chunk. Keep
      // the token intact so the later SGR keypresses are still suppressed.
      return { character, key };
    }
    if (remainder === actual) return { character, key };
    const chars = Array.from(remainder);
    if (chars.length === 1 && chars[0]! >= " ") {
      return {
        character: chars[0]!,
        key: {
          ...key,
          name: chars[0]!.toLowerCase(),
          sequence: remainder,
          ctrl: false,
          meta: false,
          shift: chars[0] !== chars[0]!.toLowerCase(),
        },
      };
    }
    if (passthroughSuffix) {
      return {
        character: typeof character === "string" ? character : "",
        key: { ...key, sequence: remainder, meta: false },
      };
    }
    return null;
  }

  #enableMouseReporting(): void {
    if (!this.#active || this.#mouseReporting) return;
    this.#clearMouseProtocol();
    this.#mouseReporting = true;
    this.stdout.write(ENABLE_SGR_MOUSE);
  }

  #syncMouseReporting(): void {
    const wanted = this.#active && (
      this.#surface === "settings"
      || this.#mode === "model-picker"
      || this.#mode === "choice-picker"
    );
    if (wanted) this.#enableMouseReporting();
    else this.#disableMouseReporting();
  }

  #disableMouseReporting(): void {
    this.#retireMouseProtocol();
    if (!this.#mouseReporting) return;
    this.#mouseReporting = false;
    this.stdout.write(DISABLE_SGR_MOUSE);
  }

  #selectMouseRow(column: number, row: number): void {
    if (this.#surface === "settings") {
      if (
        column < 1
        || column > Math.max(1, this.stdout.columns || 1)
        || row < 1
        || row > Math.max(1, this.stdout.rows || 1)
      ) return;
      const target = this.#lastSettingsHitTargets.find(
        (candidate) => candidate.row === row
          && column >= candidate.columnStart
          && column <= candidate.columnEnd,
      );
      if (target) this.#emitSettingsIntent(target.intent);
      return;
    }
    if (
      (this.#mode !== "model-picker" && this.#mode !== "choice-picker")
      || column < 1
      || column > Math.max(1, this.stdout.columns || 1)
      || row < 1
    ) return;
    const models = this.#mode === "model-picker";
    const items: Array<ModelInfo | ChoicePickerItem> = models
      ? this.#pickerModels
      : this.#choiceItems;
    const expansionLimit = (this.stdout.rows || 24) >= 20 ? 6 : 4;
    const validationRows = this.#returnSurface === "settings"
      && this.#editorValidationMessage
      ? 1
      : 0;
    const visibleRows = Math.min(
      Math.max(0, expansionLimit - validationRows),
      items.length,
    );
    if (!visibleRows) return;
    const visibleStart = clamp(
      this.#selectedIndex - Math.floor(visibleRows / 2),
      0,
      items.length - visibleRows,
    );
    const frame = this.frame();
    const dividerIndex = frame.lines.findIndex((line) => line.spans.some((span) => span.role === "structure"));
    const firstRow = dividerIndex - visibleRows + 1;
    const offset = row - firstRow;
    const item = items[visibleStart + offset];
    const line = frame.lines[row - 1];
    const itemLabel = item && (models ? (item as ModelInfo).id : (item as ChoicePickerItem).label);
    if (!item || offset < 0 || offset >= visibleRows || !line || !itemLabel || !line.spans.some((span) => span.text.includes(itemLabel))) return;
    if (this.#editorResolve && this.#returnSurface === "settings") {
      this.#selectedIndex = visibleStart + offset;
      if (models && this.#pickerMultiple) {
        const id = (item as ModelInfo).id;
        if (this.#pickerSelected.has(id)) {
          this.#pickerSelected.delete(id);
          this.#editorValidationMessage = "";
        }
        else if (this.#pickerSelected.size < 5) {
          this.#pickerSelected.add(id);
          this.#editorValidationMessage = "";
        }
        else this.#editorValidationMessage = "Höchstens fünf Panel-Modelle sind zulässig";
        this.scheduleRender(true);
      } else {
        this.#resolveSettingsEditor({
          kind: "value",
          value: models ? (item as ModelInfo).id : (item as ChoicePickerItem).value,
        });
      }
    } else this.#resolveSelection(item);
  }

  #interrupt(): void {
    if (this.#surface === "settings") {
      this.#emitSettingsIntent({ kind: "back" });
      return;
    }
    if (this.#mode === "model-picker" || this.#mode === "choice-picker") {
      if (this.#editorResolve && this.#returnSurface === "settings") {
        this.#resolveSettingsEditor({ kind: "cancel" });
      } else this.#resolveSelection(null);
    } else if (this.#mode === "secret") {
      this.#resolveSecret(null);
    } else if (this.#mode === "validated-input") {
      this.#resolveSettingsEditor({ kind: "cancel" });
    } else if (this.#mode === "recording") {
      this.#resolveRecording("cancel");
    } else if (this.#mode === "confirm") {
      if (this.#editorResolve && this.#returnSurface === "settings") {
        this.#resolveSettingsEditor({ kind: "cancel" });
      } else {
        this.#resolveConfirm({ accepted: false });
        this.#requestCancel();
      }
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
      if (this.#editorResolve && this.#returnSurface === "settings") {
        this.#resolveSettingsEditor({ kind: "cancel" });
      } else this.#resolveSelection(null);
      return;
    }
    if (models && this.#pickerMultiple && key.name === "space") {
      const selected = this.#pickerModels[this.#selectedIndex];
      if (selected) {
        if (this.#pickerSelected.has(selected.id)) {
          this.#pickerSelected.delete(selected.id);
          this.#editorValidationMessage = "";
        }
        else if (this.#pickerSelected.size < 5) {
          this.#pickerSelected.add(selected.id);
          this.#editorValidationMessage = "";
        }
        else this.#editorValidationMessage = "Höchstens fünf Panel-Modelle sind zulässig";
      }
      this.scheduleRender(true);
      return;
    }
    if (key.name === "return") {
      if (this.#editorResolve && this.#returnSurface === "settings") {
        if (models && this.#pickerMultiple) {
          this.#resolveSettingsEditor({
            kind: "value",
            value: [...this.#pickerSelected],
          });
        } else {
          const selected = items[this.#selectedIndex];
          const value = models
            ? (selected as ModelInfo | undefined)?.id
            : (selected as ChoicePickerItem | undefined)?.value;
          if (value) this.#resolveSettingsEditor({ kind: "value", value });
        }
      } else this.#resolveSelection(items[this.#selectedIndex] ?? null);
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
      const previous = this.#editorChars.join("");
      this.#editEditor(character, key);
      if (this.#editorChars.join("") !== previous) {
        if (models) {
          try {
            this.#refreshPicker();
            this.#editorValidationMessage = "";
          } catch {
            this.#selectedIndex = 0;
            this.#editorValidationMessage = "Modellcache konnte nicht gelesen werden";
          }
        }
        else {
          this.#refreshChoices();
          this.#editorValidationMessage = "";
        }
      }
    }
    this.scheduleRender(true);
  }

  #refreshPicker(): void {
    this.#pickerModels = (this.#pickerSearch?.(this.#editorChars.join("")) ?? []).slice(0, 80);
    const index = this.#pickerModels.findIndex((model) => model.id === this.#pickerCurrent);
    this.#selectedIndex = Math.max(0, index);
  }

  #refreshChoices(): void {
    const query = this.#editorChars.join("").trim().toLowerCase();
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
    this.#resetEditor();
    if (pickerResolve) pickerResolve((value as ModelInfo | null) ?? null);
    choiceResolve?.((value as ChoicePickerItem | null) ?? null);
    this.#restoreCapturedSurface(
      "busy",
      value ? "Auswahl wird übernommen" : "Auswahl abgebrochen",
    );
  }

  #resolveSecret(value: string | null): void {
    const resolve = this.#secretResolve;
    // The hidden editor owns the authoritative bytes. Callers can only choose
    // submit vs cancel; they cannot substitute the chat draft or another buffer.
    const submitted = value === null ? null : this.#editorChars.join("");
    this.#secretResolve = null;
    this.#secretLabel = "";
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#resetEditor();
    resolve?.(submitted);
    this.#restoreCapturedSurface(
      "busy",
      submitted === null ? "Eingabe abgebrochen" : "Key wird geprüft",
    );
  }

  #resolveRecording(action: "stop" | "cancel"): void {
    const resolve = this.#recordingResolve;
    this.#recordingResolve = null;
    resolve?.(action);
    this.#restoreCapturedSurface(
      "busy",
      action === "stop" ? "Aufnahme wird verarbeitet" : "Aufnahme abgebrochen",
    );
  }

  #resolveConfirm(decision: ApprovalDecision): void {
    const resolve = this.#confirmResolve;
    this.#confirmResolve = null;
    this.#confirmReasonMode = false;
    this.#confirmRememberAvailable = false;
    this.#resetEditor();
    if (this.#approvalBlockId) {
      this.#vm.dropApproval(this.#approvalBlockId);
      this.#approvalBlockId = null;
    }
    resolve?.(decision);
    this.#restoreCapturedSurface(
      "busy",
      decision.accepted ? "Freigabe erteilt" : "Freigabe abgelehnt",
    );
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
    const clean = this.#mode === "secret"
      ? this.#pasteBuffer
      : sanitizeTerminalText(this.#pasteBuffer)
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, "  ");
    this.#pasting = false;
    this.#pasteBuffer = "";
    if (!clean) {
      this.setStatus("Einfügen enthielt keinen verwendbaren Text", false);
      this.scheduleRender(true);
      return;
    }
    if (
      this.#returnSurface === "settings"
      && (this.#mode === "recording"
        || (this.#mode === "confirm" && !this.#confirmReasonMode))
    ) {
      this.scheduleRender(true);
      return;
    }
    const chars = Array.from(clean);
    const editorBuffer = this.#mode === "secret"
      || this.#mode === "model-picker"
      || this.#mode === "choice-picker"
      || this.#mode === "validated-input"
      || (this.#mode === "confirm" && this.#confirmReasonMode);
    if (editorBuffer) {
      this.#editorChars.splice(this.#editorCursor, 0, ...chars);
      this.#editorCursor += chars.length;
      if (this.#mode === "model-picker") {
        try {
          this.#refreshPicker();
          this.#editorValidationMessage = "";
        } catch {
          this.#editorValidationMessage = "Modellcache konnte nicht gelesen werden";
        }
      } else if (this.#mode === "choice-picker") {
        this.#refreshChoices();
        this.#editorValidationMessage = "";
      } else this.#editorValidationMessage = "";
    } else if (this.#surface === "settings") {
      if (!this.#settingsView?.search.active) {
        this.scheduleRender(true);
        return;
      }
      if (!this.#settingsIntentResolve) {
        this.#enqueueSettingsKey(clean, { name: undefined, ctrl: false, meta: false });
        this.scheduleRender(true);
        return;
      }
      const capacity = MAX_SETTINGS_SEARCH_CODEPOINTS - this.#settingsSearchChars.length;
      const inserted = settingsSearchChars(clean).slice(0, Math.max(0, capacity));
      if (!inserted.length) {
        this.scheduleRender(true);
        return;
      }
      this.#settingsSearchChars.splice(this.#settingsSearchCursor, 0, ...inserted);
      this.#settingsSearchCursor += inserted.length;
      this.#emitSettingsIntent({
        kind: "search-change",
        query: this.#settingsSearchChars.join(""),
      });
      return;
    } else {
      this.#inputChars.splice(this.#cursor, 0, ...chars);
      this.#cursor += chars.length;
    }
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
