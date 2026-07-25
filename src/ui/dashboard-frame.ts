/**
 * Dashboard state → `FrameInput` (Bauplan 2.4/2.5).
 *
 * Pure: no terminal, no clock of its own, no side effects. `tui.ts` collects
 * the state, this module decides what the frame is made of, and
 * `render-frame.ts` assembles it. Every layout rule is therefore testable
 * without a TTY.
 */

import type { ChatBlock, Viewport } from "./blocks.js";
import { composeLine, displayWidth, type Segment } from "./compose.js";
import {
  buildFrame,
  type Frame,
  type FrameInput,
  type HeaderInfo,
  type StatusInfo,
} from "./render-frame.js";
import { span, type Line, type Span } from "./spans.js";
import type { Theme } from "./theme.js";

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
  /** Active `/ssh` target alias, if any — shown permanently in the header while set (see `headerSegments`). */
  sshHost?: string;
}

/** One row of the expansion area (Bauplan 2.5), whatever fills it. */
export interface ListEntry {
  name: string;
  description: string;
  current?: boolean;
}

export interface ListView {
  entries: readonly ListEntry[];
  selectedIndex: number;
}

export interface RunSnapshot {
  phase: string;
  startedAt: number;
  lastEventAt: number;
  step: number;
  maxSteps: number;
  costUsd: number;
  running: boolean;
}

export type UiMode =
  | "idle"
  | "input"
  | "busy"
  | "confirm"
  | "model-picker"
  | "choice-picker"
  | "secret"
  | "recording";

export interface DashboardFrameInput {
  width: number;
  height: number;
  theme: Theme;
  state: DashboardState;
  blocks: readonly ChatBlock[];
  mode: UiMode;
  /** Raw input buffer; may contain newlines. */
  input: string;
  cursor: number;
  viewport?: Viewport;
  status: string;
  statusFresh?: boolean;
  queuedCount?: number;
  attachmentCount?: number;
  run?: RunSnapshot;
  list?: ListView;
  waitingSince?: number;
  secretLabel?: string;
  helpRequested?: boolean;
  newLinesBelow?: number;
  tick?: number;
  now?: number;
  /**
   * `inputTokens / ModelInfo.contextLength` as a percentage (Bauplan A7).
   * Filled in from outside — this module only decides how it is shown.
   */
  contextPercent?: number;
}

export const WELCOME =
  "Schreib eine Aufgabe. / zeigt Befehle, @ fügt eine Datei ein, ? die Tasten.";

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function headerInfo(state: DashboardState, contextPercent?: number): HeaderInfo {
  const info: HeaderInfo = {
    workspace: state.workspace,
    model:
      state.resolvedModel && state.resolvedModel !== state.model
        ? `${state.model} → ${state.resolvedModel}`
        : state.model,
    approvalMode: state.approval,
    balance: state.balance,
  };
  if (contextPercent !== undefined) info.contextPercent = contextPercent;
  if (state.sshHost) info.sshHost = state.sshHost;
  const git = (state.projectStatus ?? "")
    .split("·")
    .map((part) => part.trim())
    .find((part) => /^Git\b/.test(part));
  if (git) info.git = git;
  const cost = state.sessionCost.match(/-?\d+(?:[.,]\d+)?/);
  const parsed = cost ? Number(cost[0].replace(",", ".")) : Number.NaN;
  if (Number.isFinite(parsed)) info.costUsd = parsed;
  return info;
}

/**
 * The expansion area (Bauplan 2.5): the description column lines up with the
 * longest *visible* name, never with a fixed pad width.
 */
export function buildListLines(
  list: ListView,
  width: number,
  limit: number,
  theme: Theme,
): Line[] {
  const entries = list.entries;
  if (entries.length === 0 || limit <= 0) return [];
  const selected = clamp(list.selectedIndex, 0, entries.length - 1);
  const rows = Math.min(limit, entries.length);
  const start = clamp(selected - Math.floor(rows / 2), 0, entries.length - rows);
  const visible = entries.slice(start, start + rows);
  const nameWidth = visible.reduce(
    (widest, entry) => Math.max(widest, displayWidth(entry.name)),
    0,
  );
  return visible.map((entry, index) => {
    const active = start + index === selected;
    const spans: Span[] = [
      span(active ? `${theme.glyph("marker")} ` : "  ", active ? "accent" : "text"),
      span(entry.name.padEnd(nameWidth), active ? "accent" : "text", { bold: active }),
    ];
    if (entry.description) spans.push(span("  ", "text"), span(entry.description, "muted"));
    if (entry.current) spans.push(span(`${theme.glyph("separator")}aktiv`, "ok"));
    const segments: Segment[] = [{ spans, align: "left", priority: 100 }];
    if (index === visible.length - 1) {
      segments.push({
        spans: [span(`${selected + 1} von ${entries.length}`, "muted")],
        align: "right",
        priority: 40,
      });
    }
    return composeLine(segments, width, { ellipsis: theme.glyph("ellipsis") });
  });
}

/** Bauplan 2.4: the help line only appears on approval, open list or `?`. */
function helpText(input: DashboardFrameInput): string | undefined {
  if (input.mode === "confirm") {
    return "j ja · n nein · Enter = nein · a immer erlauben · d nie erlauben · g Begründung";
  }
  if (input.mode === "model-picker" || input.mode === "choice-picker") {
    return "Tippen filtert · ↑↓ wählen · Enter übernehmen · Esc abbrechen";
  }
  if (input.mode === "secret") return "Der Key wird nie angezeigt · Enter prüfen · Esc abbrechen";
  if (input.list) return "↑↓ wählen · Tab einsetzen · Enter vervollständigen · Esc Liste schließen";
  if (input.helpRequested) {
    return "/ Befehle · @ Datei · Ctrl+T Denken · PgUp/PgDn blättern · Ctrl+C Abbruch";
  }
  return undefined;
}

/** Bauplan 2.4: a status line only on a run, an approval or a fresh notice. */
function statusInfo(input: DashboardFrameInput): StatusInfo | undefined {
  const now = input.now ?? Date.now();
  const queue = input.queuedCount ? `${input.queuedCount} vorgemerkt` : "";
  if (input.mode === "confirm") {
    // An unbound key answers instead of staying silent: its notice rides along
    // on the right of the waiting clock.
    const notice =
      input.statusFresh && input.status !== "Bestätigung erforderlich" ? input.status : "";
    return {
      phase: `wartet seit ${clock(now - (input.waitingSince ?? now))}`,
      role: "warn",
      cancelHint: notice,
    };
  }
  if (input.mode === "secret") {
    return { phase: `${input.secretLabel ?? "Key"} · Eingabe bleibt verdeckt`, role: "muted" };
  }
  if (input.run) {
    return {
      phase: input.run.phase,
      spinning: input.run.running,
      elapsedMs: Math.max(0, now - input.run.startedAt),
      step: `Schritt ${input.run.step}/${input.run.maxSteps}`,
      cost: `$${input.run.costUsd.toFixed(4)}`,
      lastEventAgeMs: Math.max(0, now - input.run.lastEventAt),
      cancelHint: queue || "Ctrl+C Abbruch",
    };
  }
  if (input.attachmentCount) {
    const count = input.attachmentCount;
    return {
      phase: `${count} Bild${count === 1 ? "" : "er"} bereit`,
      role: "muted",
      cancelHint: queue,
    };
  }
  if (input.statusFresh && input.status) {
    return { phase: input.status, role: "muted", cancelHint: queue };
  }
  return queue ? { phase: queue, role: "muted" } : undefined;
}

/** The single mapping from UI state to a frame. */
export function buildDashboardFrame(input: DashboardFrameInput): Frame {
  const theme = input.theme;
  const width = Math.floor(input.width);
  const height = Math.floor(input.height);
  const text =
    input.mode === "secret"
      ? Array.from(input.input).map(() => theme.glyph("mask")).join("")
      : input.input;
  const inputCursor = clamp(input.cursor, 0, Array.from(text).length);
  // A7: the label — the only hint that a secret is being typed — is a fixed
  // prefix, never part of the scrollable text.
  const inputLabel = input.mode === "secret" ? input.secretLabel || "Key" : undefined;
  const expansionLimit = height >= 20 ? 6 : 4;
  const expansion: Line[] = input.list
    ? buildListLines(input.list, Math.max(1, width - 1), expansionLimit, theme)
    : input.blocks.length === 0
      // R8: the welcome text sits directly above the divider, not below a header.
      ? [{ spans: [span("  ", "text"), span(WELCOME, "muted")] }]
      : [];

  const frameInput: FrameInput = {
    width,
    height,
    theme,
    blocks: input.blocks,
    inputText: text,
    inputCursor,
    header: headerInfo(input.state, input.contextPercent),
    expansion,
    tick: input.tick ?? 0,
    now: input.now ?? Date.now(),
  };
  if (inputLabel) frameInput.inputLabel = inputLabel;
  if (input.viewport) frameInput.viewport = input.viewport;
  const status = statusInfo(input);
  if (status) frameInput.status = status;
  const help = helpText(input);
  if (help) frameInput.help = help;
  if (input.newLinesBelow) frameInput.newLinesBelow = input.newLinesBelow;
  return buildFrame(frameInput);
}
