/**
 * Frame assembly (Bauplan 2.4): head, bottom-anchored stream, expansion,
 * the one divider, status, input block, help line.
 *
 * Chrome at rest is three lines. Accessories never win over the stream: the
 * expansion goes first, then the help line, then the head.
 */

import { isHubTranscript, type ChatBlock, type Viewport } from "./blocks.js";
import { composeLine, displayWidth, fitSpans, type Segment } from "./compose.js";
// FIX-14 ticket 2: `elapsedClock` is the one `mm:ss` reading (this file used
// to keep a verbatim second copy of it).
import { elapsedClock, renderBlock } from "./render-block.js";
import { lineWidth, span, type Line, type Span } from "./spans.js";
import { spinnerFrame, type Theme } from "./theme.js";

export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
// MIN_STREAM and MAX_INPUT_LINES are not exported (F6 dead-layer sweep):
// only this file's own frame-assembly logic below reads them.
const MIN_STREAM = 5;
export const MAX_CONTENT_WIDTH = 100;
const MAX_INPUT_LINES = 6;

/**
 * Terminal-Look spec principle 5 / controller decision B: the header shrinks
 * to the workspace path (and the decorative brand mark) only — approval
 * mode, model, branch, ssh target and costs all moved to the always-on
 * bottom status line (`StatusInfo` below) instead of living in both places.
 */
export interface HeaderInfo {
  workspace?: string;
  /**
   * FIX-20, finding 9: which chat this is. The header named only the folder,
   * so a foreign `/chats` pick — which re-roots the whole runtime — changed
   * nothing visible in-chat but a short basename, and the chat that was just
   * opened was nowhere on screen at all.
   */
  chatTitle?: string;
  contextPercent?: number;
  /** Decorative Route Core mark. It is deliberately the first header segment dropped. */
  brandMark?: string;
}

export interface StatusInfo {
  phase: string;
  spinning?: boolean;
  elapsedMs?: number;
  step?: string;
  cost?: string;
  lastEventAgeMs?: number;
  cancelHint?: string;
  /**
   * FIX-11 addendum, controller ruling A: a shorter but still COMPLETE form
   * of `cancelHint` — the priority fitter's `Segment.compact`, so a narrow
   * terminal shortens the escape hint instead of losing it. Must still name
   * the key and what it does (`Enter queues · esc cancels`); the key is
   * never what gets dropped. `undefined` for hints that are already short
   * (`Ctrl+C cancels`, `2 queued`), which need no compact tier.
   */
  cancelHintCompact?: string;
  role?: Span["role"];
  /**
   * Idle identity segments (Terminal-Look spec principle 5): `<approval
   * mode> · <model> · <branch>[ · ssh:<host>] · <costs today>`, shown only
   * once nothing else (a run, a confirmation, a fresh notice, …) claims the
   * status line instead.
   */
  model?: string;
  branch?: string;
  sshHost?: string;
  costToday?: string;
  /**
   * D6 (the cost thread): `costToday` doubles as the status line's shared
   * balance/day segment — below the configured threshold its text gains a
   * `balance low` marker (`dashboard-frame.ts`'s `statusInfo`) and this role
   * switches to `"warn"`. `undefined` (the ordinary case) keeps the segment
   * muted exactly as before.
   */
  costTodayRole?: Span["role"];
  /**
   * Phase 10 honesty guard: `cross:<leadShort>+<challengerShort>` while
   * persistent Cross mode is armed for this chat, `undefined` when disarmed.
   * Pre-formatted by the caller (dashboard-frame.ts) with the theme's own
   * short-model-label helper — this module only places it, same as every
   * other idle identity segment above.
   */
  crossArmed?: string;
  /**
   * Phase 12 (per-prompt cost forecast): the muted upfront estimate
   * (`~$0.04-0.09`, or `cost unknown` on a provider-managed route),
   * pre-formatted by `dashboard-frame.ts`'s `statusInfo` via
   * `formatPromptCostForecast` (`cost-forecast.ts`). `undefined` whenever
   * the draft is empty, a run is active, Cross is armed, or the active
   * route's catalog price is unknown — see that function for the exact
   * gate. The LEAST essential idle identity segment (lowest priority,
   * `statusSegments` below): the first one dropped at a narrow width,
   * unlike `crossArmed` above which is the last.
   */
  costForecast?: string;
}

export interface FrameInput {
  width: number;
  height: number;
  theme: Theme;
  blocks: readonly ChatBlock[];
  /** Raw input buffer; may contain `\n` from Shift+Enter. */
  inputText: string;
  /**
   * Shown, muted, in place of the buffer when `inputText` is empty — the
   * `❯` prompt's placeholder (Terminal-Look mockup). Never affects wrapping
   * or cursor math, which stay driven by the real (empty) buffer.
   */
  inputPlaceholder?: string;
  /** Code-point cursor index into `inputText`. */
  inputCursor: number;
  /**
   * Fixed prefix shown on every visible input row, ahead of the gutter — the
   * one hint (e.g. the secret's name) that must never scroll out of view
   * (Bauplan A6).
   */
  inputLabel?: string;
  viewport?: Viewport;
  header?: HeaderInfo;
  status?: StatusInfo;
  expansion?: Line[];
  /**
   * Empty-state candidates ordered from the richest presentation to the
   * smallest usable fallback. The frame chooses against its real chrome
   * budget, including wrapped input and help rows.
   */
  expansionAlternatives?: readonly (readonly Line[])[];
  /**
   * Empty-stream candidates (richest to smallest, same atomic contract as
   * `expansionAlternatives`) shown in the chat-stream area — above whatever
   * fills `expansion` — while there are no chat blocks at all. This is how
   * the Route Core workbench greets a startup picker (e.g. the chat
   * chooser) instead of leaving blank rows above it: the picker's own
   * `expansion` content and layout are untouched, only the otherwise-blank
   * padding above it gets filled, and only with an alternative that wholly
   * fits the space already left over once the picker's own budget is set.
   */
  streamFallbackAlternatives?: readonly (readonly Line[])[];
  /**
   * Where the open list's ROWS sit inside `expansion` — the offset of the
   * first of them from the expansion's own first line, how many there are,
   * and which entry the first one is.
   *
   * Fix round 1 (review MAJOR 1). The frame translates this into absolute
   * line indices on the `Frame` it returns (`Frame.listRows`) so pointer
   * hit-testing reads the geometry the renderer ACTUALLY used. It is omitted
   * whenever the rows did not survive to the screen — the expansion shed for
   * the stream floor, or sliced below the offset — so a click can never land
   * on rows that are not there.
   */
  expansionListRows?: {
    readonly offset: number;
    readonly count: number;
    readonly startIndex: number;
  };
  /**
   * The frame's bottom hint row.
   *
   * A plain `string` is rendered muted, exactly as it always was. V4-A added
   * the `Line` form for zone 3: the action bar's chips need two roles on one
   * line (key in emphasis, effect muted beside it), which a single muted
   * string cannot carry. Same row, same one-line budget, same position — only
   * the producer got richer, so no caller that still passes a string changes
   * shape.
   */
  help?: string | Line;
  /** Lines that arrived while the user was scrolled back (R9). */
  newLinesBelow?: number;
  tick?: number;
  now?: number;
}

export interface Frame {
  lines: Line[];
  chatHeight: number;
  cursor: { row: number; col: number };
  /**
   * Where the open list's rows really landed in `lines` (0-based), and which
   * entry the first of them is — see `FrameInput.expansionListRows`. Absent
   * when no list is open, or when its rows did not make it onto the screen.
   * The one geometry a pointer may map against.
   */
  listRows?: {
    readonly firstLine: number;
    readonly count: number;
    readonly startIndex: number;
  };
}

function headerSegments(theme: Theme, info: HeaderInfo): Segment[] {
  const segments: Segment[] = [];
  if (info.workspace) {
    const compact = info.workspace.split("/").filter(Boolean).at(-1) ?? info.workspace;
    segments.push({
      spans: [span(info.workspace, "muted")],
      compact: [span(compact, "muted")],
      align: "left",
      priority: 60,
    });
  }
  if (info.chatTitle) {
    // Above the workspace path (60) and below the context gauge (80): when
    // the header has to shed something, the folder — which the welcome box,
    // the status line's branch segment and the composer placeholder all
    // still state — goes before the one thing that names the open chat.
    segments.push({
      spans: [span(info.chatTitle, "text")],
      align: "left",
      priority: 70,
    });
  }
  if (info.contextPercent !== undefined) {
    // A7: from 80% the fill level warns — a colour role, backed by the digits
    // themselves so NO_COLOR loses no information (R4).
    const role = info.contextPercent >= 80 ? "warn" : "muted";
    segments.push({
      spans: [span(`Context ${Math.round(info.contextPercent)}%`, role)],
      compact: [span(`${Math.round(info.contextPercent)}%`, role)],
      align: "left",
      priority: 80,
    });
  }
  if (info.brandMark) {
    segments.push({
      spans: [span(info.brandMark, "muted")],
      align: "right",
      priority: 1,
    });
  }
  return segments;
}

interface StatusLine {
  readonly segments: Segment[];
  /**
   * Filler `composeLine` puts between two neighbouring same-side segments.
   *
   * FIX-11 (rendered truth): the idle identity segments below prepend their
   * own `· ` separator, and the fitter's default two-space gap landed in
   * front of it — `ask  · gpt-5.4  · main  · $1.23 today`, contradicting
   * this file's own documented single-space intent a few lines down. On the
   * identity line the separator IS the gap, so one space is all the fitter
   * adds. Every other status line (a run, a confirmation, a fresh notice)
   * carries no separators of its own and keeps the two-space gap that
   * visually groups `Running  00:12  Step 3/40`.
   */
  readonly gap: string;
}

function statusSegments(theme: Theme, info: StatusInfo, tick: number): StatusLine {
  const role = info.role ?? "text";
  const glyph = info.spinning
    ? `${spinnerFrame(theme, tick)} `
    : `${theme.glyph("warn")} `;
  const segments: Segment[] = [
    {
      spans: [
        span(info.spinning ? glyph : "", "active"),
        span(info.phase, role),
      ],
      align: "left",
      priority: 100,
    },
  ];
  if (info.elapsedMs !== undefined) {
    segments.push({
      spans: [span(elapsedClock(info.elapsedMs), "muted")],
      align: "left",
      priority: 90,
    });
  }
  if (info.step) {
    segments.push({ spans: [span(info.step, "muted")], align: "left", priority: 80 });
  }
  if (info.cost) {
    segments.push({ spans: [span(info.cost, "muted")], align: "right", priority: 70 });
  }
  // FIX-11 (rendered truth) + addendum ruling A: the cancel/escape hint is
  // the run's ONLY rendered way out, so safety outranks every decorative
  // segment on this line at EVERY width — it now sits directly below the
  // phase itself (95), above the clock (90), the step counter (80), the
  // running cost (70) and the "last event Xs ago" readout (50, the first
  // thing shed). It used to be the LAST of them, which is how 80 columns
  // with an interjection live rendered the age readout and no way out.
  // Where even that ordering is not enough (the interjection hint is 62
  // cells wide on its own), `cancelHintCompact` gives the fitter a shorter
  // COMPLETE form to fall back to before anything is dropped — the key is
  // never what disappears.
  if (info.lastEventAgeMs !== undefined) {
    segments.push({
      spans: [span(`last event ${Math.round(info.lastEventAgeMs / 1000)}s ago`, "muted")],
      align: "right",
      priority: 50,
    });
  }
  if (info.cancelHint) {
    segments.push({
      spans: [span(info.cancelHint, "muted")],
      ...(info.cancelHintCompact
        ? { compact: [span(info.cancelHintCompact, "muted")] }
        : {}),
      align: "right",
      priority: 95,
    });
  }
  // Terminal-Look spec principle 5 / controller decision B: the idle
  // identity chrome — always muted, each segment prepending its own
  // separator so it reads as one joined line (`ask · claude-sonnet-5 · main
  // · $0.42 today`) once assembled left-to-right, the same trick
  // `info.phase`'s role already relies on for the run/confirm branches.
  const separator = theme.glyph("separator").trim();
  if (info.model) {
    segments.push({ spans: [span(`${separator} ${info.model}`, "muted")], align: "left", priority: 95 });
  }
  if (info.branch) {
    segments.push({ spans: [span(`${separator} ${info.branch}`, "muted")], align: "left", priority: 85 });
  }
  if (info.sshHost) {
    segments.push({
      spans: [span(`${separator} ssh:${info.sshHost}`, "muted")],
      align: "left",
      priority: 75,
    });
  }
  if (info.costToday) {
    segments.push({
      spans: [span(`${separator} ${info.costToday}`, info.costTodayRole ?? "muted")],
      align: "left",
      priority: 96,
    });
  }
  // Phase 10 honesty guard: the highest-priority idle identity segment —
  // the very last one dropped at a narrow width — since this is the one
  // mechanism disclosing the per-message multi-call cost while armed.
  if (info.crossArmed) {
    segments.push({ spans: [span(`${separator} ${info.crossArmed}`, "muted")], align: "left", priority: 97 });
  }
  // Phase 12 (per-prompt cost forecast): the LOWEST priority of every idle
  // identity segment on this line (all of which sit at 75-100 above) — it
  // is display-only chrome the owner never asked to keep at the cost of the
  // approval mode, model, branch, ssh target or the balance/day and Cross
  // segments, so it is the first thing a narrow terminal loses.
  if (info.costForecast) {
    segments.push({ spans: [span(`${separator} ${info.costForecast}`, "muted")], align: "left", priority: 65 });
  }
  // One of those separator-carrying segments present means this is the idle
  // identity line, so the fitter's gap shrinks to the single space the
  // joined form documented above needs (see `StatusLine.gap`).
  // `dashboard-frame.ts`'s `statusInfo` never mixes the two families, so no
  // run/confirm/notice line is affected.
  const identity = Boolean(
    info.model
    || info.branch
    || info.sshHost
    || info.costToday
    || info.crossArmed
    || info.costForecast,
  );
  return { segments, gap: identity ? " " : "  " };
}

interface StreamEntry {
  blockId: string;
  lines: Line[];
}

function buildStream(input: FrameInput, width: number): StreamEntry[] {
  const entries: StreamEntry[] = [];
  const last = input.blocks[input.blocks.length - 1];
  input.blocks.forEach((block, index) => {
    if (index > 0) entries.push({ blockId: block.id, lines: [{ spans: [] }] });
    entries.push({
      blockId: block.id,
      lines: renderBlock(block, width, input.theme, {
        tick: input.tick ?? 0,
        last: last?.id === block.id,
        now: input.now ?? Date.now(),
      }),
    });
  });
  return entries;
}

function clampNumber(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

interface InputRow {
  /** Visible text of this wrapped row. */
  text: string;
  /** Code-point offset into the raw buffer where this row starts. */
  start: number;
}

/**
 * Real soft wrap (Bauplan A6): every logical (`\n`-separated) line is cut
 * into rows of at most `capacity` code points. An empty logical line still
 * produces one empty row so the cursor has somewhere to land on a blank
 * line.
 */
function wrapInputText(text: string, capacity: number): InputRow[] {
  const rows: InputRow[] = [];
  let offset = 0;
  const logicalLines = text.split("\n");
  logicalLines.forEach((line, index) => {
    const chars = Array.from(line);
    if (chars.length === 0) {
      rows.push({ text: "", start: offset });
    } else {
      for (let cut = 0; cut < chars.length; cut += capacity) {
        rows.push({ text: chars.slice(cut, cut + capacity).join(""), start: offset + cut });
      }
    }
    offset += chars.length + (index < logicalLines.length - 1 ? 1 : 0);
  });
  return rows;
}

/** The row whose span `[start, start+length]` contains `cursor`. */
function inputRowForCursor(rows: readonly InputRow[], cursor: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (cursor >= rows[index]!.start) return index;
  }
  return 0;
}

function tooSmall(width: number, theme: Theme): Frame {
  const message = span(
    `Terminal too small (at least ${MIN_WIDTH}${theme.glyph("multiply")}${MIN_HEIGHT} characters)`,
    "danger",
  );
  return {
    lines: [composeLine([{ spans: [message], align: "left", priority: 100 }], Math.max(1, width))],
    chatHeight: 0,
    cursor: { row: 1, col: 1 },
  };
}

export function buildFrame(input: FrameInput): Frame {
  const { theme, width, height } = input;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return tooSmall(width, theme);
  }

  const usableWidth = Math.max(1, width - 1);
  const bodyWidth = Math.min(MAX_CONTENT_WIDTH, usableWidth);

  // A6: the label (if any, e.g. the secret's name) and the gutter are a fixed
  // prefix on every visible row — only the text after it scrolls.
  const inputGutter = `${theme.glyph("userGutter")} `;
  const inputLabel = input.inputLabel ? `${input.inputLabel} ` : "";
  const inputPrefix = `${inputLabel}${inputGutter}`;
  const inputPrefixWidth = displayWidth(inputPrefix);
  const inputWrapWidth = Math.max(4, usableWidth - inputPrefixWidth);
  const inputRows = wrapInputText(input.inputText, inputWrapWidth);
  const inputTotalRows = Math.max(1, inputRows.length);
  const inputHeight = Math.min(MAX_INPUT_LINES, inputTotalRows);
  const expansionLimit = height >= 20 ? 7 : 4;
  // D8d controller ruling: `expansionAlternatives` is exclusively how the
  // empty-transcript hub (dashboard-frame.ts's pure hub branch — no list,
  // no Cross, no conversation content) hands over its brand block; no other
  // caller ever sets it. Detected structurally, from the shape of the input,
  // rather than a new flag every other `FrameInput` producer would have to
  // remember not to set — so a run transcript or a picker-over-the-hub
  // (which uses `streamFallbackAlternatives` instead, see below) is
  // untouched by anything gated on `isHub`. FIX-17: the structural check is
  // the shared `isHubTranscript` predicate (blocks.ts), matching
  // dashboard-frame.ts exactly — a transcript of ONLY notice blocks keeps
  // the hub layout, with the notices rendered beneath the brand block.
  const isHub = Boolean(input.expansionAlternatives) && isHubTranscript(input.blocks);
  // The zero floors below (`streamFloor`, the final `chatHeight` clamp) are
  // ONLY safe while there is genuinely nothing to show in the stream —
  // notice blocks at the hub must stay visible (honesty), so they keep the
  // ordinary reserve.
  const hubEmpty = isHub && input.blocks.length === 0;
  // Alternatives are atomic presentations: slicing the large mark would make
  // an incomplete logo look like a viable compact layout.
  const expansionCandidates = input.expansionAlternatives?.map((candidate) => [...candidate])
    ?? [(input.expansion ?? []).slice(0, expansionLimit)];
  let expansion = expansionCandidates.at(-1) ?? [];
  let help = input.help
    && (typeof input.help === "string" ? input.help.length > 0 : input.help.spans.length > 0)
    ? input.help
    : undefined;
  // The hub's brand block absorbs the plain workspace-path header (D8d):
  // dashboard-frame.ts omits `header.workspace` at the pure hub (its own
  // box header row and muted context line already state the folder,
  // abbreviated — the raw, unbordered, unabbreviated path would otherwise be
  // a duplicate, orphaned line above a block that already says the same
  // thing better). This gate is content-based, not a blanket `isHub` check,
  // so a header that DOES still carry something (`contextPercent`, or the
  // compact `brandMark` once a run/Cross starts) is never silently dropped —
  // only a header that would render zero segments costs zero rows.
  let showHeader = height >= 12
    && Boolean(input.header?.workspace || input.header?.contextPercent !== undefined || input.header?.brandMark);
  let showStatus = Boolean(input.status);

  const chrome = (): number =>
    (showHeader ? 1 : 0) + expansion.length + 1 + (showStatus ? 1 : 0) + inputHeight + (help ? 1 : 0);

  // MIN_STREAM exists to guarantee scroll headroom for a live transcript —
  // meaningless at the hub, where `blocks.length === 0` means there is
  // nothing to scroll and the "stream" rows below are pure blank filler
  // (R8's padding, not scrollback). Enforcing it there was the D8d
  // regression: it forced the candidate loop below past the full brand box
  // (Route/Balance/context rows) down to its bare-mark tier, just to keep
  // blank rows that would never hold anything, on every hub taller than a
  // couple of chats' worth of Recent rows. A hub WITH notice blocks
  // (FIX-17) keeps MIN_STREAM: those rows hold real, must-stay-visible
  // content, so the brand box degrades before the notices disappear.
  const streamFloor = hubEmpty ? 0 : MIN_STREAM;
  let chatHeight = height - chrome();
  for (const candidate of expansionCandidates) {
    expansion = candidate;
    chatHeight = height - chrome();
    if (chatHeight >= streamFloor) break;
  }
  if (chatHeight < streamFloor && expansion.length > 0 && input.blocks.length > 0) {
    expansion = [];
    chatHeight = height - chrome();
  }
  if (chatHeight < streamFloor && help) {
    help = undefined;
    chatHeight = height - chrome();
  }
  if (chatHeight < streamFloor && showHeader) {
    showHeader = false;
    chatHeight = height - chrome();
  }
  // The always-on identity status line (Terminal-Look spec principle 5) is
  // the last thing dropped, after header and help — the 40×8 floor invariant
  // still wins over "always-on" at the smallest sizes the layout supports.
  if (chatHeight < streamFloor && showStatus) {
    showStatus = false;
    chatHeight = height - chrome();
  }
  // The floor is 1 for a real transcript (there is always at least one row
  // of chat area to reserve) but 0 at the hub — `streamFloor` already let
  // the candidate loop above settle on an exact fit (`chatHeight === 0`,
  // the brand block's own row count plus chrome exactly filling `height`);
  // flooring that to 1 here would silently reopen the one-line overflow the
  // `isHub` floor above exists to close. (`hubEmpty`, not `isHub`: a hub
  // with notice blocks needs its one-row reserve like any transcript.)
  chatHeight = Math.max(hubEmpty ? 0 : 1, chatHeight);

  const entries = buildStream(input, bodyWidth);
  const flat: Array<{ blockId: string; line: Line }> = [];
  const firstLineOf = new Map<string, number>();
  for (const entry of entries) {
    for (const item of entry.lines) {
      if (!firstLineOf.has(entry.blockId)) firstLineOf.set(entry.blockId, flat.length);
      flat.push({ blockId: entry.blockId, line: item });
    }
  }

  const viewport = input.viewport ?? { anchor: "tail" as const };
  const maxScrollOffset = Math.max(0, flat.length - chatHeight);
  let top = maxScrollOffset;
  if (viewport.anchor !== "tail") {
    const start = firstLineOf.get(viewport.anchor.blockId);
    if (start !== undefined) {
      top = Math.min(maxScrollOffset, Math.max(0, start + viewport.anchor.lineOffset));
    }
  }

  const scrolled = top < maxScrollOffset;
  const streamLines: Line[] = [];
  let capacity = chatHeight;
  if (scrolled && chatHeight > 1) {
    const above = top;
    streamLines.push(
      composeLine(
        [
          {
            spans: [
              span(`${theme.glyph("scrollUp")} `, "muted"),
              span(
                [
                  `${above} lines above`,
                  `line ${top + 1} of ${flat.length}`,
                  "End jumps to the end",
                ].join(theme.glyph("separator")),
                "muted",
              ),
            ],
            align: "left",
            priority: 100,
          },
        ],
        usableWidth,
      ),
    );
    capacity -= 1;
  }

  const window = flat.slice(top, top + capacity).map((item) => item.line);
  // The workbench-behind-a-picker fallback only ever applies where the
  // stream has nothing of its own to show — never trims real transcript.
  let streamFallback: Line[] = [];
  if (flat.length === 0 && input.streamFallbackAlternatives) {
    for (const candidate of input.streamFallbackAlternatives) {
      if (candidate.length <= capacity) {
        streamFallback = [...candidate];
        break;
      }
    }
  }
  // R8: content is anchored at the bottom; empty space grows at the top. This
  // is exactly backwards for the hub (D8d controller ruling): there is no
  // conversation to keep glued to the composer — `window` holds at most the
  // hub's notice blocks (FIX-17; empty at the pure hub), `streamFallback`
  // never pairs with `expansionAlternatives` (dashboard-frame.ts sets at
  // most one of the two) and the rest of `streamLines` is blank filler.
  // Below, that filler is pushed AFTER `expansion` instead of before — the
  // brand block renders from the top of the content area, with the notices
  // (bottom-anchored, nearest the composer) and empty space beneath it,
  // toward the divider. Nothing here touches `capacity`/`chatHeight`
  // accounting, only the order lines are appended in, so scroll math and
  // the input cursor row stay correct either way.
  const padding = Math.max(0, capacity - window.length - streamFallback.length);
  for (let index = 0; index < padding; index += 1) {
    streamLines.push({ spans: [] });
  }
  streamLines.push(...streamFallback, ...window);

  const lines: Line[] = [];
  if (showHeader) {
    lines.push(composeLine(headerSegments(theme, input.header ?? {}), usableWidth));
  }
  let expansionStart: number;
  if (isHub) {
    expansionStart = lines.length;
    lines.push(...expansion);
    lines.push(...streamLines);
  } else {
    lines.push(...streamLines);
    expansionStart = lines.length;
    lines.push(...expansion);
  }
  // Fix round 1: the rows' real addresses, or nothing. `expansion` may have
  // been shed entirely (the stream floor) or sliced by `expansionLimit` above,
  // so the offset/count the caller declared is honoured only while it still
  // falls inside what was actually pushed.
  const declaredRows = input.expansionListRows;
  const listRows = declaredRows
    && declaredRows.count > 0
    && declaredRows.offset + declaredRows.count <= expansion.length
    ? {
        firstLine: expansionStart + declaredRows.offset,
        count: declaredRows.count,
        startIndex: declaredRows.startIndex,
      }
    : undefined;

  const dividerText = theme.glyph("divider").repeat(usableWidth);
  if (scrolled && (input.newLinesBelow ?? 0) > 0) {
    const note = ` ${theme.glyph("scrollDown")} ${input.newLinesBelow} new lines `;
    const keep = Math.max(0, usableWidth - note.length);
    lines.push({
      spans: [
        span(theme.glyph("divider").repeat(Math.max(0, keep)), "structure"),
        span(note, "warn"),
      ],
    });
  } else {
    lines.push({ spans: [span(dividerText, "structure")] });
  }

  if (input.status && showStatus) {
    const status = statusSegments(theme, input.status, input.tick ?? 0);
    lines.push(composeLine(status.segments, usableWidth, { gap: status.gap }));
  }

  const inputCursorRow = inputRowForCursor(inputRows, input.inputCursor);
  // The window follows the cursor: typing at the tail keeps it bottom
  // anchored, but scrolling or editing further up keeps that row visible too.
  const inputWindowStart = clampNumber(
    inputCursorRow - inputHeight + 1,
    0,
    Math.max(0, inputTotalRows - inputHeight),
  );
  const inputWindowTop = Math.min(inputWindowStart, inputCursorRow);
  const visibleInput = inputRows.slice(inputWindowTop, inputWindowTop + inputHeight);
  const inputStart = lines.length;
  const showInputScrollHint = inputTotalRows > inputHeight;
  const showPlaceholder = input.inputText.length === 0 && Boolean(input.inputPlaceholder);
  visibleInput.forEach((row, index) => {
    const spans: Span[] = [
      span(inputPrefix, "accent"),
      showPlaceholder ? span(input.inputPlaceholder!, "muted") : span(row.text, "text"),
    ];
    if (index === visibleInput.length - 1 && showInputScrollHint) {
      lines.push(
        composeLine(
          [
            { spans, align: "left", priority: 100 },
            {
              spans: [span(`${visibleInput.length}/${inputTotalRows}`, "muted")],
              align: "right",
              priority: 40,
            },
          ],
          usableWidth,
        ),
      );
      return;
    }
    lines.push({ spans });
  });

  if (help) {
    lines.push({
      spans: typeof help === "string"
        ? [span("  ", "text"), span(help, "muted")]
        : [span("  ", "text"), ...help.spans],
    });
  }

  const cursorRowInWindow = inputCursorRow - inputWindowTop;
  const clampedRow = clampNumber(cursorRowInWindow, 0, visibleInput.length - 1);
  const cursorColumn = input.inputCursor - (inputRows[inputCursorRow]?.start ?? 0);
  const row = inputStart + clampedRow + 1;
  const col = inputPrefixWidth + cursorColumn + 1;

  return {
    // One mechanism (controller ruling at the FIX-19×FIX-20 merge): FIX-20's
    // `fitFrameLine` is the frame-wide one-line contract both lanes arrived
    // at independently — the net under producers that never fitted their own
    // lines (composer placeholder, help line, settings-editor expansion,
    // palette breadcrumb), and the root-cause fix for the repaint-debris
    // family (a wrapped line breaks the absolute-row repaint below it).
    lines: lines.map((item) => fitFrameLine(item, usableWidth, theme)),
    chatHeight,
    cursor: { row, col },
    ...(listRows ? { listRows } : {}),
  };
}

/**
 * FIX-20 (repaint-debris root cause): the frame's width contract, enforced
 * once at the only place a line leaves the builder.
 *
 * `tui.ts`'s partial repaint addresses every row absolutely
 * (`ESC[<row>;1H`) and trusts that frame line N occupies exactly physical
 * row N. A single line wider than the terminal breaks that assumption for
 * the whole frame below it: the terminal soft-wraps it onto the next
 * physical row, the row it displaced is never rewritten (the diff only
 * touches rows whose CONTENT changed), and everything under it reads one
 * row out of place — the owner-reported "status line rendered twice, the
 * separator gone" after `/new`, `/model` and `/help` at 80 columns, the
 * hub's stranded welcome-box row, and an empty-state line still standing
 * under async-filled Recent rows. All of it is the same accounting break,
 * not three bugs.
 *
 * Most lines already come from `composeLine`, which can never exceed the
 * width it is given. Three did not, each pushed as raw spans: the composer
 * row (its placeholder is not width-aware at all — FIX-19's lane, and the
 * one that actually fires at 80 columns once the workspace path is long),
 * the help footer, and the hub's own un-fitted workbench lines. Rather
 * than a fourth width check at each site (the pattern that let three drift
 * in the first place), the invariant is asserted here for every line at
 * once — a line already within the contract is returned untouched, so no
 * existing layout changes shape.
 */
function fitFrameLine(item: Line, usableWidth: number, theme: Theme): Line {
  if (lineWidth(item) <= usableWidth) return item;
  return { spans: fitSpans(item.spans, usableWidth, theme.glyph("ellipsis")) };
}
