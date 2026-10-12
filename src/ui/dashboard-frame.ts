/**
 * Dashboard state → `FrameInput` (Bauplan 2.4/2.5).
 *
 * Pure: no terminal, no clock of its own, no side effects. `tui.ts` collects
 * the state, this module decides what the frame is made of, and
 * `render-frame.ts` assembles it. Every layout rule is therefore testable
 * without a TTY.
 */

import { isHubTranscript, type ChatBlock, type Viewport } from "./blocks.js";
import { crossPanelFacts, crossPanelTitle } from "../cross-panel.js";
// The list primitive lives in list-core.ts (Phase F1, one implementation for
// every picker + the command menu). Only the two types with real
// `dashboard-frame.js` importers are re-exported here (`ListEntry` for
// command-menu.ts, `ListView` for tui.ts); everything else imports from
// list-core.js directly.
export {
  type ListEntry,
  type ListView,
} from "./list-core.js";
import { buildListLines, listWindow, type ListView } from "./list-core.js";
import {
  buildFrame,
  type Frame,
  type FrameInput,
  type HeaderInfo,
  type StatusInfo,
} from "./render-frame.js";
import { displayWidth, middleEllipsis, wrapSpans } from "./compose.js";
import { span, type Line } from "./spans.js";
import type { Theme } from "./theme.js";
import type { CostKnowledge } from "../types.js";
import { listActionChips, shortcutHintLine } from "./keymap.js";
import { actionBarLine, emphasize, titleBarLine } from "./zones.js";
import { abbreviateHome, workbenchAlternatives } from "./workbench.js";
import { formatChatRow, formatUsd, isLowBalance, shortModelName } from "../utils.js";
import {
  computePromptCostForecast,
  formatPromptCostForecast,
  FALLBACK_OUTPUT_TOKEN_BAND,
  type CostForecastPrice,
  type OutputTokenBand,
} from "../cost-forecast.js";

export interface DashboardState {
  workspace: string;
  projectStatus?: string;
  model: string;
  resolvedModel?: string;
  /**
   * FIX-18 (F3): true when the provider runtime reports the active route
   * cannot run (the same predicate behind /provider status's honest "Not
   * connected"). The welcome box's Route row then states it instead of
   * claiming a dead route. `undefined` = unknown, no claim.
   */
  routeNotConnected?: boolean;
  approval: string;
  reasoning: string;
  maxCost: string;
  maxSteps: number;
  /**
   * This folder's budget limits, already formatted (`budgetLimitsLabel`,
   * commands.ts). FIX-15: the command palette's `/budget` row used to
   * annotate itself with `maxCost` — a different setting entirely, owned by
   * `/max-cost` one row below it — so the palette stated the wrong current
   * value. `undefined` means no claim, exactly like every other optional
   * field here.
   */
  budget?: string;
  /** Active `/ssh` target alias, if any — shown in the header as `ssh:<host>` while set (see `headerSegments`). */
  sshHost?: string;
  /**
   * FIX-17 (fresh-launch audit): true while this launch determined provider
   * setup is required AND no route has been resolved since. The hub then
   * leads its fixed quick actions with a prominent "Set up a provider" row
   * (tui.ts's `WORKBENCH_SETUP_ACTION`) instead of the removed unsolicited
   * launch modal — setup necessity stays visible, the owner stays in
   * control. Cleared live by the caller (cli.ts computes it per frame from
   * the cached route projection), so completing setup mid-session retires
   * the row without a restart.
   */
  providerSetupNeeded?: boolean;
  /**
   * The top 4 most recently used chats across every known workspace, most-
   * recent first — powers the neutral start hub's "Recent" section (D8,
   * superseding Controller decision A's single-slot "Continue" quick
   * action; the field name follows, `recentChat` → `recentChats`).
   * `undefined`/empty until loaded or when no chat exists anywhere.
   */
  recentChats?: readonly {
    readonly id: string;
    readonly title: string;
    readonly turnCount: number;
    readonly costUsd: number;
    readonly costKnowledge?: CostKnowledge;
    /** Raw model id, same convention as `model`/`resolvedModel` above — `shortModelName` is applied where this is rendered, not here. */
    readonly model?: string;
    /** Epoch ms — `Date.parse(ChatSummary.updatedAt)`, computed once by the caller. */
    readonly updatedAt: number;
    /**
     * The chat's own folder (Phase F1b: the source spans every known
     * workspace, most-recent first, not just this one). Optional — additive,
     * so existing fixtures that never set it keep meaning "same folder, no
     * suffix" exactly as before this phase. The hub's "Recent" row appends
     * it, `~`-abbreviated, only when it differs from `workspace` above — the
     * current folder's own chat never grows a redundant suffix.
     */
    readonly workspace?: string;
  }[];
  /**
   * Workspace-wide "spent today" (`workspaceSpend().dayUsd`, `session.ts`) —
   * Task 1 (composition gap report): computed for a while but only ever
   * surfaced one-off by `/budget`; now threaded into the status line's
   * `<costs today>` segment (Terminal-Look spec principle 5) and the
   * welcome box's Balance row (V3 deltas).
   */
  dayUsd?: number;
  /**
   * Remaining OpenRouter credit in USD, already net of this session's own
   * spend — the same computation `/balance` and the startup inspection
   * already do (`formatBalanceSummary`, `src/cli.ts`), threaded here raw so
   * this module decides the wording. `undefined` whenever credits were
   * never fetched or the fetch failed — the Balance row must then omit
   * itself rather than show a fabricated number.
   */
  balanceRemainingUsd?: number;
  /**
   * True when the active route's costs are provider-managed (Kimi) instead
   * of metered OpenRouter credits — the Balance row then reads
   * "provider-managed" instead of a dollar figure, regardless of
   * `balanceRemainingUsd`.
   */
  balanceProviderManaged?: boolean;
  /**
   * D6 (the cost thread): below this remaining-credit figure,
   * `balanceRemainingUsd` counts as "low" (`isLowBalance`, utils.ts) — the
   * welcome box's Balance row and the status line's shared balance/day
   * segment both switch to the warn state. `undefined` (a caller that never
   * threads config through, e.g. the plain settings overlay's dashboard
   * state) behaves exactly like `0`: the warn stays off, never inferred.
   */
  lowBalanceThresholdUsd?: number;
  /**
   * FIX-20, finding 9: the open chat's title, shown on the in-chat header's
   * identity line beside the folder. A foreign `/chats` pick re-roots the
   * entire runtime, and before this the only visible change was the
   * workspace basename — the chat that was actually opened appeared nowhere.
   * Omitted at the hub, where the welcome box already covers a chat that has
   * not started.
   */
  chatTitle?: string;
  /** Safe, bounded Cross projection. Raw prompts, account ids and worker text never enter chrome. */
  cross?: {
    readonly sequence: number;
    readonly updatedAt: number;
    readonly phase: string;
    readonly reason: string | null;
    readonly verification: string;
    readonly lead: string;
    readonly challenger: string;
    readonly active?: boolean;
    readonly result?: string;
  };
  /**
   * Phase 10 honesty guard: the pair persistent Cross mode is armed with for
   * this chat, `undefined` when disarmed. Distinct from `cross` above, which
   * only exists once a run has actually happened — this is visible on the
   * idle status line and the welcome box the whole time the chat stays
   * armed, including before any run and between runs. Raw model ids (same
   * convention as `model`/`resolvedModel` above); `shortModelName` is
   * applied where this is rendered, not here.
   */
  crossArmed?: {
    readonly lead: string;
    readonly challenger: string;
    /**
     * Owner ruling (fix round 1): true while this is a PENDING one-shot
     * (Start on an empty chat, waiting for the first message) rather than
     * persistent "Keep Cross active" mode — "waiting-to-spend must be
     * visible like armed-to-spend," so the status segment and welcome box
     * both render a distinct `once:` variant for it.
     */
    readonly oneShot?: boolean;
  };
  /**
   * Phase 12 (per-prompt cost forecast): the active route's cached catalog
   * price, classified honestly (`classifyCostForecastPrice`,
   * `cost-forecast.ts`) — `undefined` only when the caller has no route
   * resolved yet at all (a fresh chat before its first model snapshot
   * loads), which reads exactly like the "unpriced" case: no segment.
   * Combined with `input.input` (the live draft, already threaded through
   * `DashboardFrameInput` — this module never needs a duplicate copy of it)
   * and `costForecastContextChars` below to produce the status line's muted
   * `~$min-max` band. Cross-armed chats never combine this with `crossArmed`
   * above (Controller ruling 4): a single-model estimate would understate
   * the real per-message cost of 4-6 calls, and the `cross:` segment
   * already discloses that multiplier — see `statusInfo` below.
   */
  costForecastPrice?: CostForecastPrice;
  /**
   * Chars of context already accumulated in this chat (everything except
   * the live draft) — `contextCharsForForecast` (`compressor.ts`), a cheap
   * approximation deliberately distinct from the compressor's own
   * redaction-passing `uncompressedContext`. `undefined`/omitted counts as
   * `0` (a fresh chat with no prior turns).
   */
  costForecastContextChars?: number;
  /**
   * The forecast's output-token allowance — `estimateOutputTokenBand`
   * (`cost-forecast.ts`), the chat's own rolling average once it has enough
   * assistant turns, `FALLBACK_OUTPUT_TOKEN_BAND` otherwise. Optional only
   * for callers (fixtures, the plain settings overlay) that never populate
   * it; `statusInfo` below falls back to the same fixed band itself.
   */
  costForecastOutputTokenBand?: OutputTokenBand;
}

export interface RunSnapshot {
  phase: string;
  startedAt: number;
  lastEventAt: number;
  step: number;
  maxSteps: number;
  costUsd: number;
  costKnowledge?: CostKnowledge;
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
  | "recording"
  | "validated-input";

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
  /**
   * True while a registered interject handler owns the busy input line
   * (Phase 3b, Part B): typed text now feeds the running task instead of
   * queuing for the next run, so the cancel hint advertises that instead of
   * `Ctrl+C cancels`/`N queued`.
   */
  interjectable?: boolean;
  /**
   * Audit FIX-1: true while the model is actively streaming reasoning
   * (`RunViewModel.reasoningLive` — the exact state the escape handler in
   * tui.ts branches on). Drives the interjection hint's esc segment:
   * `esc ends thinking` while true, `esc cancels the run` otherwise.
   */
  reasoningLive?: boolean;
  run?: RunSnapshot;
  list?: ListView;
  waitingSince?: number;
  /** Whether this exact approval request has a safe persistable subject. */
  rememberAvailable?: boolean;
  secretLabel?: string;
  /** FIX-18 (Esc depth): overrides the secret footer's default "Esc cancel". */
  secretEscHint?: string;
  editorPrompt?: {
    readonly label: string;
    readonly description: string;
    readonly validationMessage?: string;
    /**
     * V4-B: `Settings › Tools › Browser path` — present only for a settings
     * editor, where it REPLACES the plain accent label with zone 1's title
     * bar, so the number/text editors say where they are exactly like the
     * settings-driven pickers do. Absent for `readPath` (the same mode,
     * opened from the chat surface with no settings row behind it) and for
     * D4's confirm grammar, both of which keep their label untouched.
     */
    readonly crumb?: string;
    /** V4-B: the edited row's own `displayValue` — see `ListView.currentValue`. */
    readonly currentValue?: string;
  };
  /**
   * D4 controller decision: true for the danger confirm class (Enter
   * declines, `y` is the only accept key), false/undefined for ordinary
   * (Enter or `y` accepts) — drives both the footer grammar (`helpText`)
   * and the settings-confirm prompt title's role (warn vs accent) below.
   * Set for every `mode: "confirm"` frame regardless of which of the two
   * underlying confirm mechanisms (settings-editor or `confirmAction`) is
   * active — the grammar is the same either way.
   */
  confirmDanger?: boolean;
  /**
   * FIX-14 fix round 1 (review M2): the KEY grammar — "Enter must not
   * accept" — as distinct from the CLASS. Every danger confirm sets it, and
   * so does the third D4 state `confirmDanger` cannot express: an ORDINARY
   * action that still deserves an explicit yes (`confirmPlain`'s
   * `defaultAccept: false` — `/panel`'s spend confirm, the process-only
   * credential confirm). Those two used to be graded as danger outright,
   * which gave them a destructive title and a dead `g reason`. Absent
   * follows `confirmDanger`, so every pre-existing caller is unchanged.
   */
  confirmEnterDeclines?: boolean;
  /**
   * Fix round 1, IMPORTANT: true only when confirm mode's live mechanism
   * is `confirmAction`'s approval-style resolver (`#confirmResolve`) —
   * the only one that ever binds `g` (reason capture). The settings-editor
   * mechanism (`#resolveSettingsEditor`) never does, even for a danger-
   * class settings confirm, so the footer must not claim it does. Kept
   * separate from `confirmDanger` (which grades key/footer grammar) and
   * from `editorPrompt` presence (a rendering artifact that happens to
   * coincide with the settings mechanism today, not the authoritative
   * signal) — this is set directly from which mechanism is live.
   */
  confirmReasonAvailable?: boolean;
  helpRequested?: boolean;
  newLinesBelow?: number;
  tick?: number;
  now?: number;
  /**
   * `inputTokens / ModelInfo.contextLength` as a percentage (Bauplan A7).
   * Filled in from outside — this module only decides how it is shown.
   */
  contextPercent?: number;
  brand?: DashboardBranding;
  quickGroups?: readonly { readonly label: string; readonly hint: string }[];
  /**
   * Index into the hub's ONE selection list — `state.recentChats` then
   * `quickGroups` concatenated (Controller ruling 2, D8) — currently
   * highlighted by ↓/↑ navigation (V3 interaction ruling); `undefined`
   * means the composer itself has focus and no row shows the `❯` selection
   * marker.
   */
  quickActionIndex?: number;
  /** Used only to abbreviate the welcome box's muted context line (and the composer's placeholder, and a foreign "Recent" row) to `~/...`. */
  homeDir?: string;
}

export interface DashboardBranding {
  readonly showLargeLogo: boolean;
  readonly showHeaderMark: boolean;
  readonly largeLines: readonly string[];
  readonly compactMark: string;
  /**
   * `readPackageVersion()` (branding.js), threaded through rather than read
   * here — this module stays a pure function of its input, no filesystem
   * reads of its own. Shown after the wordmark in the hub's welcome box
   * (D8d: `❯─● ORCODE <version>`, one source, matching the calibration
   * `orcode --version`/the plain banner already use).
   */
  readonly version: string;
}

/**
 * The `❯` prompt's placeholder when the buffer is empty (Terminal-Look
 * mockup, start screen). Shown only in ordinary input mode — `secret`,
 * `validated-input` and the pickers all speak for themselves. A function of
 * the theme, not a plain constant: the trailing ellipsis only has an
 * ASCII-safe form via `theme.glyph` (F6 ASCII sweep). Not exported (F6
 * dead-layer sweep): only `buildDashboardFrame` below ever calls it.
 *
 * `folderLabel`, when given, names the current folder (Controller ruling 1,
 * D8): "Type to start a new chat in ~/folder …", shown only over the empty-
 * transcript hub, where typing genuinely does start a new chat there. Mid-
 * conversation this stays the generic prompt below — scope guard ruling 7
 * limits D8 to this placeholder text, nothing else about the composer.
 *
 * FIX-19 finding 1 (one-line contract): the folder form embeds a real
 * filesystem path, so at a narrow width it used to be the ONE frame line
 * long enough to soft-wrap in the terminal — and a composer that occupies
 * two terminal rows while the frame counted one desynchronises the whole
 * diff (stale duplicated placeholder rows, a tripled composer, the logo
 * pushed off; 4 of 12 rows eaten at 40×12). It never wraps now: the label
 * is `~`-abbreviated by the caller and then middle-ellipsised here to
 * whatever `budget` cells the composer row actually has, and the folder
 * form is dropped for the short generic prompt once even a stub of a path
 * would not fit.
 */
function inputPlaceholder(theme: Theme, budget: number, folderLabel?: string): string {
  const generic = `Describe your task ${theme.glyph("ellipsis")}`;
  if (!folderLabel) return generic;
  const ellipsis = theme.glyph("ellipsis");
  const prefix = "Type to start a new chat in ";
  const suffix = ` ${ellipsis}`;
  const labelBudget = budget - displayWidth(prefix) - displayWidth(suffix);
  // Below this a "path" is no longer a path — two characters and an
  // ellipsis name nothing, so the generic prompt is the honest fallback.
  const MIN_LABEL = 8;
  if (labelBudget < MIN_LABEL) return generic;
  return `${prefix}${middleEllipsis(folderLabel, labelBudget, ellipsis)}${suffix}`;
}

/**
 * Phase 1a `interject` token + Terminal-Look spec principle 7: born-new
 * English steering copy, shown while the input line accepts a mid-run
 * interjection instead of the German rest of the UI. A function of the
 * theme for the same reason as `inputPlaceholder` above. Not exported (F6
 * dead-layer sweep): only `statusInfo` below ever calls it.
 */
function interjectionInputHint(theme: Theme, reasoningLive: boolean): string {
  const sep = theme.glyph("separator");
  // Audit FIX-1 (2026-08-28): the Esc segment must state what Esc actually
  // does right now — while reasoning streams live, Esc ends only the
  // thinking (the run continues; see the escape handler in tui.ts, which
  // branches on the same view-model state), so claiming "cancels the run"
  // there was a lie. The behavior is correct and unchanged; only the hint
  // is now state-dependent.
  //
  // FIX-14 ticket 1: `Esc`, not `esc`. This hint pair was the last place a
  // key name was spelled in lowercase; every other hint in the product —
  // the confirm footer below, the keymap table, `/help`, the list footers —
  // writes it the way the keymap does.
  return `Type an interjection ${theme.glyph("ellipsis")} (Enter queues it${sep}${
    reasoningLive ? "Esc ends thinking" : "Esc cancels the run"
  })`;
}

/**
 * FIX-11 addendum, controller ruling A: the same hint at 62 cells is wider
 * than a narrow terminal has left over beside the phase, so the status
 * line's priority fitter is given a shorter but still complete form
 * (`StatusInfo.cancelHintCompact`) to fall back to before it drops
 * anything. Both keys survive with what each of them does — the shortest
 * wording that still names them. Only the invitation to type ("Type an
 * interjection …", inferable from the composer sitting right below) and the
 * objects ("it", "the run") are what the compact form gives up. It carries
 * the same FIX-1 state split as the full form — a compact hint that said
 * "Esc cancels" while Esc would only end the thinking would re-tell the
 * exact lie FIX-1 removed, just at narrower widths.
 */
function interjectionInputHintCompact(theme: Theme, reasoningLive: boolean): string {
  const sep = theme.glyph("separator");
  return `Enter queues${sep}${reasoningLive ? "Esc ends thinking" : "Esc cancels"}`;
}

/**
 * FIX-20, finding 5: how long a confirm has been waiting — honest in both
 * of the two states this line can actually be in.
 *
 * It used to read `waiting since 00:00`: an elapsed duration dressed as a
 * wall clock ("since" plus `mm:ss`), and frozen at 00:00 for every confirm
 * raised outside a run, because nothing repaints the frame while waiting
 * for a keypress. Two wrong impressions from one line — a timestamp that
 * was never a timestamp, and a stopped clock.
 *
 * A confirm raised DURING a run does have a cadence: the run spinner's own
 * interval repaints the whole frame every 80ms, so a real elapsed reading
 * genuinely advances there and is worth showing. Outside a run there is no
 * cadence and no new timer is introduced for one — the line says "waiting"
 * and claims nothing it cannot keep. The unit is explicit either way, so
 * neither form can be misread as a clock.
 */
function waitingPhase(elapsedMs: number, ticking: boolean): string {
  if (!ticking) return "waiting";
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return seconds < 60
    ? `waiting ${seconds}s`
    : `waiting ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The git branch, if `projectStatus` carries one — shared by the header's
 * former composition and the status line's own `<branch>` segment. Derived
 * the same way the dashboard header always has: a `"Git <branch>"` token
 * inside the `·`-joined `projectStatus` summary.
 */
function gitBranch(projectStatus: string | undefined): string | undefined {
  const token = (projectStatus ?? "")
    .split("·")
    .map((part) => part.trim())
    .find((part) => /^Git\b/.test(part));
  return token?.replace(/^Git\s+/, "");
}

/**
 * The active route, one source for both the status line's `<model>` segment
 * and the hub's Route row (D8d root-cause fix). `state.resolvedModel` is
 * `""` — not `undefined` — the whole time between a fresh/switched chat
 * (`cli.ts` resets it to `""` on `/chat`, `/model`, a session switch, and at
 * every D8c launch) and that chat's first completed run actually resolving
 * a route; `resolvedModel ?? state.model` never falls through for an empty
 * string (`??` only triggers on `null`/`undefined`), so a fresh hub used to
 * read as "not set"/a blank status segment even though `state.model` (the
 * configured route, always populated) was known the whole time. `||`
 * catches both the empty-string and the `undefined` case identically.
 */
function effectiveRoute(state: DashboardState): string {
  return (state.resolvedModel && state.resolvedModel.trim()) || state.model;
}

/**
 * `anthropic/claude-sonnet-5` → `claude-sonnet-5` (controller decision B:
 * "model short"). The implementation now lives in `../utils.js` (D8, so the
 * hub's row composer `formatChatRow` can use it without cycling back
 * through this module) — re-exported here so every existing
 * `from "./ui/dashboard-frame.js"` import (`/chats` row builders, `cli.ts`,
 * `tui.ts`, `commands.ts`) keeps working unchanged.
 */
export { shortModelName } from "../utils.js";

/**
 * `omitWorkspace` (D8d): true only at the pure hub (`isHub` below) — the
 * welcome box's own header row and muted context line already state the
 * folder, abbreviated, so the plain unbordered, unabbreviated path this
 * segment would otherwise carry is a duplicate, orphaned line above a block
 * that already says the same thing better (Controller ruling: the hub's
 * brand block absorbs it). `contextPercent`/`brandMark` are untouched either
 * way — the render-frame `showHeader` gate below decides whether an
 * otherwise-empty header row (workspace omitted, nothing else populated,
 * the ordinary case at a genuinely fresh hub) costs a line at all.
 */
function headerInfo(
  state: DashboardState,
  contextPercent?: number,
  brandMark?: string,
  omitWorkspace?: boolean,
): HeaderInfo {
  const info: HeaderInfo = omitWorkspace ? {} : { workspace: state.workspace };
  // FIX-20, finding 9: in-chat, the header names the chat as well as the
  // folder. It is omitted exactly where the workspace is (the hub), whose
  // welcome box already says everything about a chat that has not started.
  if (!omitWorkspace && state.chatTitle) info.chatTitle = state.chatTitle;
  if (contextPercent !== undefined) info.contextPercent = contextPercent;
  if (brandMark) info.brandMark = brandMark;
  return info;
}

/**
 * The cells an action bar rendered as the frame's help row actually has: the
 * frame's usable width (`width - 1`, `render-frame.ts`) minus the two-space
 * indent that row is pushed in by. Below it the bar sheds whole chips instead
 * of letting `fitFrameLine` cut one in half.
 */
function helpBarWidth(input: DashboardFrameInput): number {
  return Math.max(1, Math.floor(input.width) - 1 - 2);
}

/**
 * Bauplan 2.4: the help line only appears on approval, open list or `?`.
 *
 * V4-A: for the two LIST-shaped states this row is now zone 3 — the action
 * bar, chips built from the one keymap table (`listActionChips`) rather than
 * a `·`-joined string written out here. The confirm, secret and
 * validated-input branches keep their existing strings verbatim: the confirm
 * grammar is D4's ratified wording (untouchable), and the other two are
 * single-key prompts rather than lists. The `?` hint still renders the keymap
 * TABLE, which is a different thing from a screen's own action bar.
 */
function helpText(input: DashboardFrameInput): string | Line | undefined {
  const sep = input.theme.glyph("separator");
  if (input.mode === "confirm") {
    // D4 controller decision: one phrasing order for both classes — the
    // exact `y confirm · Enter/Esc cancel` / `Enter confirm · Esc cancel`
    // grammar always leads, so the divergence the audit found (this exact
    // footer silently disagreeing with itself across the settings and
    // approval sub-branches) cannot recur. `a`/`d`/`g` are pre-existing
    // approval-only extras (remember-allow/deny, reason) appended after
    // the grammar, never replacing it — and, per fix round 1, only ever
    // appended when the live mechanism actually binds them: `g` (reason)
    // exists only on the approval mechanism, never on the settings-editor
    // one (not even for a danger-class settings confirm), so it must not
    // be claimed there.
    // FIX-14 fix round 1 (review M2): the footer states the KEY grammar,
    // which is what the reader has to act on. `a`/`d`/`g` stay gated on
    // their own availability flags — both are false for an ordinary
    // `defaultAccept: false` confirm, so it gets danger's honest key line
    // without advertising controls that do nothing.
    const enterDeclines = input.confirmEnterDeclines ?? input.confirmDanger;
    if (!enterDeclines) return `Enter confirm${sep}Esc cancel`;
    const remember = input.rememberAvailable
      ? `${sep}a always allow${sep}d never allow`
      : "";
    const reason = input.confirmReasonAvailable ? `${sep}g reason` : "";
    return `y confirm${sep}Enter/Esc cancel${remember}${reason}`;
  }
  if (input.mode === "model-picker" || input.mode === "choice-picker") {
    // V4-A zone 3 (appearance pin changed, keys unchanged): this used to be a
    // hand-joined `Typing filters · ↑↓ select · Enter apply · Esc cancel`.
    // Every one of those four keys is a row in the "Lists & pickers" context
    // of the keymap table, with those exact words as its `chip`, so the line
    // is derived now instead of retyped — and it renders as chips (key in
    // emphasis, effect muted) like every other action bar.
    return actionBarLine(
      input.theme,
      listActionChips(input.theme, "Lists & pickers", { typing: true }),
      { width: helpBarWidth(input) },
    );
  }
  if (input.mode === "secret") return `The key is never shown${sep}Enter check${sep}${input.secretEscHint ?? "Esc cancel"}`;
  if (input.mode === "validated-input") return `Enter apply${sep}Esc cancel`;
  // A caller that supplies its own V3 footer (the command palette) already
  // carries the key hints directly above the composer — the generic help
  // line below it would just repeat them. Every other `list` consumer
  // (history search, @ completion, quick replies) still falls through to it.
  if (input.list) {
    return (input.list.footer || input.list.emptyLine)
      ? undefined
      // The generic list consumers (history search, `@` completion, quick
      // replies) get the same chips from the same table; only the words
      // differ, because Enter/Esc/Tab genuinely do something else there.
      : actionBarLine(
          input.theme,
          listActionChips(input.theme, "Lists & pickers", {
            enter: "choose",
            esc: "back/close",
            tab: "open",
          }),
          { width: helpBarWidth(input) },
        );
  }
  // FIX-4: the `?` hint is the six most-missed bindings, taken from the one
  // keymap table (`ui/keymap.ts`) that `/help`'s `─ Shortcuts` section also
  // renders — one muted line, never a hand-kept second list that drifts.
  if (input.helpRequested) return shortcutHintLine(input.theme);
  return undefined;
}

/** Bauplan 2.4: a status line only on a run, an approval or a fresh notice. */
function statusInfo(input: DashboardFrameInput): StatusInfo | undefined {
  const now = input.now ?? Date.now();
  const sep = input.theme.glyph("separator");
  const queue = input.queuedCount ? `${input.queuedCount} queued` : "";
  if (input.mode === "confirm") {
    // An unbound key answers instead of staying silent: its notice rides along
    // on the right of the waiting label.
    const notice =
      input.statusFresh && input.status !== "Confirmation required" ? input.status : "";
    return {
      phase: waitingPhase(now - (input.waitingSince ?? now), input.run?.running === true),
      role: "warn",
      cancelHint: notice,
    };
  }
  if (input.run) {
    return {
      phase: input.run.phase,
      spinning: input.run.running,
      elapsedMs: Math.max(0, now - input.run.startedAt),
      step: `Step ${input.run.step}/${input.run.maxSteps}`,
      // FIX-14 ticket 3: `formatUsd` (utils.ts), not two more inline
      // `.toFixed(4)` money literals.
      cost: input.run.costKnowledge === "unknown"
        ? (input.run.costUsd > 0
            ? `≥${formatUsd(input.run.costUsd)}${sep}provider-managed`
            : `Cost unknown${sep}provider-managed`)
        : formatUsd(input.run.costUsd),
      lastEventAgeMs: Math.max(0, now - input.run.lastEventAt),
      cancelHint: input.interjectable
        ? interjectionInputHint(input.theme, input.reasoningLive === true)
        : (queue || "Ctrl+C cancels"),
      // Only the long interjection form needs a compact tier; `Ctrl+C
      // cancels` and the queue count already fit wherever the line does.
      ...(input.interjectable
        ? { cancelHintCompact: interjectionInputHintCompact(input.theme, input.reasoningLive === true) }
        : {}),
    };
  }
  // The moment between "busy" taking effect and the first `run-start` event
  // still owns the input line — the hint must not flicker in only once a
  // `RunSnapshot` exists.
  if (input.mode === "busy" && input.interjectable) {
    return {
      phase: input.status || "Ready",
      role: "muted",
      cancelHint: interjectionInputHint(input.theme, input.reasoningLive === true),
      cancelHintCompact: interjectionInputHintCompact(input.theme, input.reasoningLive === true),
    };
  }
  if (input.mode === "secret") {
    return { phase: `${input.secretLabel ?? "Key"}${sep}input stays hidden`, role: "muted" };
  }
  if (input.attachmentCount) {
    const count = input.attachmentCount;
    return { phase: `${count} image${count === 1 ? "" : "s"} ready`, role: "muted", cancelHint: queue };
  }
  if (input.statusFresh && input.status && input.status !== "Ready") {
    return { phase: input.status, role: "muted", cancelHint: queue };
  }
  // Terminal-Look spec principle 5 / controller decision B: once nothing
  // else claims the line, it becomes the permanent identity chrome —
  // `<approval mode> · <model> · <branch>[ · ssh:<host>] · <costs today>`,
  // muted, never coloured. The header (see `headerInfo`) keeps only the
  // workspace path so this information lives in exactly one place.
  //
  // D6 (the cost thread): `costToday` doubles as the status line's shared
  // balance/day segment — below the configured threshold, the wording
  // itself gains a `balance low` marker (NO_COLOR-safe on its own, same
  // convention as `crossArmedRow`/the allow-all context line in
  // workbench.ts) and `costTodayRole` switches the whole segment to the
  // warn role. The ordinary case (no cached balance, or not low) is left
  // exactly as it always was: the plain `$Y today`, omitted outright when
  // even the day spend is unknown.
  const balanceLow = isLowBalance(input.state.balanceRemainingUsd, input.state.lowBalanceThresholdUsd ?? 0);
  const dayText = input.state.dayUsd !== undefined ? `${formatUsd(input.state.dayUsd)} today` : undefined;
  // Phase 12 (per-prompt cost forecast): only while the composer genuinely
  // owns the input line (`mode === "input"` — a picker/secret/editor
  // buffer's filter text is not a prompt draft), the draft is non-empty,
  // and no run is active (every earlier branch above already claims the
  // line for those cases, so reaching here already means none apply).
  // Controller ruling 4: never combined with an armed Cross pair — a
  // single-model estimate would understate a 4-6-call run, and `crossArmed`
  // below already discloses the multiplier.
  const costForecast =
    input.mode === "input" && !input.state.crossArmed && input.input.trim().length > 0 && input.state.costForecastPrice
      ? formatPromptCostForecast(
          computePromptCostForecast({
            promptChars: (input.state.costForecastContextChars ?? 0) + input.input.length,
            price: input.state.costForecastPrice,
            outputTokenBand: input.state.costForecastOutputTokenBand ?? FALLBACK_OUTPUT_TOKEN_BAND,
          }),
        )
      : undefined;
  return {
    phase: input.state.approval,
    role: "muted",
    model: shortModelName(effectiveRoute(input.state)),
    branch: gitBranch(input.state.projectStatus),
    sshHost: input.state.sshHost,
    costToday: balanceLow
      ? (dayText ? `balance low · ${dayText}` : "balance low")
      : dayText,
    costTodayRole: balanceLow ? "warn" : undefined,
    // Phase 10 honesty guard: the per-message multi-call cost must never be
    // invisible while armed — this segment is the mechanism (no per-message
    // confirmation, which would defeat the point of arming). Highest
    // priority of the idle identity segments (render-frame.ts) so it is the
    // very last one dropped at a narrow width.
    // Owner ruling (fix round 1): `once:` distinguishes a pending one-shot
    // (waiting-to-spend) from persistent armed mode — both must stay
    // visible, but never look identical to each other.
    crossArmed: input.state.crossArmed
      ? `cross:${input.state.crossArmed.oneShot ? "once:" : ""}${shortModelName(input.state.crossArmed.lead)}+${shortModelName(input.state.crossArmed.challenger)}`
      : undefined,
    costForecast,
  };
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
  const inputLabel = input.mode === "secret"
    ? input.secretLabel || "Key"
    : input.mode === "validated-input"
      ? input.editorPrompt?.label
      : undefined;
  // The one fixed row budget every fullscreen list surface shares — model
  // picker, choice picker, command palette, at-mention, history search,
  // suggested replies alike (`buildListLines`' `limit` argument below is
  // this minus whatever chrome/footer/validation lines that particular
  // caller adds). D1 ruling 4 deliberately does NOT widen this constant to
  // pay for the command palette's new always-on top rule (`listChrome`
  // above): that would inflate the row budget for every OTHER list surface
  // too, none of which carry that rule's line cost. Instead the palette
  // simply loses one visible row wherever the rule is a genuinely new
  // line — the filter state, which had no crumb line at all before this
  // ruling (5 rows -> 4 at height>=20, 3 -> 2 below it; see d1-report.md's
  // budget math). The browse states (root and drilled) already paid for a
  // crumb line pre-D1, so folding it into the rule costs them nothing —
  // their row count is unchanged.
  const expansionLimit = height >= 20 ? 6 : 4;
  // D4: the danger class renders its settings-confirm title through the
  // warn role instead of plain accent — calm emphasis, no new banner —
  // while every other editor kind (and an ordinary settings confirm) keeps
  // the existing accent title untouched. The approval flow's own title
  // treatment (its risk-colored block, rendered separately) is unaffected.
  const confirmPromptDanger = input.mode === "confirm" && input.confirmDanger === true;
  // Audit FIX-1 (2026-08-28): the description/validation lines used to be
  // raw, unfitted spans — at a narrow terminal the danger explanation was
  // hard-cut mid-word with no ellipsis ("allow-all runs file changes and
  // shell co"), unreadable right when the consequence text matters most.
  // Confirm BODIES now word-wrap (the same `wrapSpans` convention the
  // expanded reasoning block uses); the label stays one line (titles are
  // terse by the D4 grammar, and pins address its role via `spans[0]`),
  // and the key/footer lines keep their existing single-line handling.
  // The height budget is unchanged — render-frame's `expansionLimit`
  // still caps the total rows.
  const promptWrapWidth = Math.max(1, width - 1);
  const editorExpansion: Line[] = input.editorPrompt
    ? [
        // V4-B: a settings editor opens with the grown crumb in zone 1 and
        // the row's current value below it — the mockup's edit state. Every
        // other user of this block (D4's confirm grammar, `readPath`) sets
        // no crumb and keeps its accent label byte for byte.
        input.editorPrompt.crumb
          ? titleBarLine(theme, input.editorPrompt.crumb, { width: promptWrapWidth })
          : { spans: [span(input.editorPrompt.label, confirmPromptDanger ? "warn" : "accent", { bold: true })] },
        ...(input.editorPrompt.currentValue
          ? [{ spans: [emphasize("4", "Current: "), emphasize("3b", input.editorPrompt.currentValue)] }]
          : []),
        ...wrapSpans([span(input.editorPrompt.description, "muted")], promptWrapWidth),
        ...(input.editorPrompt.validationMessage
          ? wrapSpans([span(input.editorPrompt.validationMessage, "warn")], promptWrapWidth)
          : []),
      ]
    : [];
  const listValidation: Line[] = input.list && input.editorPrompt?.validationMessage
    ? [{ spans: [span(input.editorPrompt.validationMessage, "warn")] }]
    : [];
  // D8d: the exact "pure hub" condition the `expansion`/`expansionAlternatives`
  // branches below already gated on ad hoc (no list open, no editor prompt,
  // no transcript, no active Cross) — named once so the header-suppression
  // rule below it (Controller ruling: the hub's brand block absorbs the
  // plain workspace-path header) shares the identical definition rather than
  // drifting from a second copy of the same four checks. FIX-17: the
  // "no transcript" check is `isHubTranscript` (blocks.ts), not
  // `length === 0` — a transcript carrying ONLY notice blocks (a cancelled
  // setup, a startup warning) keeps the hub alive instead of orphaning the
  // owner on a dead screen; the notices render beneath the brand block
  // (`render-frame.ts`'s isHub ordering).
  const isHub = !input.list
    && editorExpansion.length === 0
    && isHubTranscript(input.blocks)
    && !input.state.cross;
  // The hub's "Recent" rows (Controller ruling 1/3, D8): the exact `/chats`
  // row composer (`formatChatRow`, `utils.js`) — one composer, no duplicate —
  // pre-formatted here (not inside `workbench.ts`) for the same reason the
  // Cross row's model pair is pre-shortened below: the caller decides the
  // wording, `workbench.ts` only lays rows out. The current folder's own
  // chats never grow a `~folder` suffix; a foreign chat's does, `~`-
  // abbreviated exactly like the picker's "Other folders" section.
  const recentChatRows = (input.state.recentChats ?? []).slice(0, 4).map((chat) => {
    const folder = chat.workspace && chat.workspace !== input.state.workspace
      ? abbreviateHome(chat.workspace, input.homeDir)
      : undefined;
    // FIX-21 finding 5 (frame-verified): these rows used to carry
    // `formatChatRow`'s raw `·`, so the hub's "Recent" section leaked a
    // unicode byte straight through ASCII glyph mode.
    const { label, description } = formatChatRow(
      chat,
      chat.updatedAt,
      folder,
      theme.glyph("separator"),
    );
    return { label, hint: description };
  });
  const emptyBrandAlternatives = input.brand
    ? workbenchAlternatives({
        branding: input.brand,
        recentChats: recentChatRows,
        quickGroups: input.quickGroups ?? [],
        quickActionIndex: input.quickActionIndex,
        theme,
        // Every other full-width line in this frame — header, divider,
        // status (render-frame.ts), and the /chats picker's own bar just
        // below (`buildListLines` above) — lays out against `usableWidth`
        // (`width - 1`), never the raw frame `width`. Fix round 1: this call
        // was the one holdout, so the hub's selected-row bar (and the box's
        // own max-width clamp, and the border-less identity degrade) all
        // overflowed the frame by exactly one column on every coloured
        // render.
        width: Math.max(1, width - 1),
        workspace: input.state.workspace,
        homeDir: input.homeDir,
        route: effectiveRoute(input.state),
        routeNotConnected: input.state.routeNotConnected,
        approval: input.state.approval,
        branch: gitBranch(input.state.projectStatus),
        balanceRemainingUsd: input.state.balanceRemainingUsd,
        balanceProviderManaged: input.state.balanceProviderManaged,
        lowBalanceThresholdUsd: input.state.lowBalanceThresholdUsd ?? 0,
        dayUsd: input.state.dayUsd,
        crossArmed: input.state.crossArmed
          ? {
              lead: shortModelName(input.state.crossArmed.lead),
              challenger: shortModelName(input.state.crossArmed.challenger),
              oneShot: input.state.crossArmed.oneShot,
            }
          : undefined,
      })
    : [[{ spans: [span("What would you like to do?", "text", { bold: true })] }]];
  // The V3 command palette's empty-result state (ruling 5) supplies its own
  // single `emptyLine` and nothing else — chrome, rows and footer all vanish
  // behind it, never a blank or dead-end list.
  // V4-A zone 1: the title bar. One line, one inverse bar, carrying the
  // breadcrumb — "wo bin ich?", the screen's only loud line.
  //
  // It replaces two different things that said the same fact two ways: D1
  // ruling 4's palette rule (`─ Commands › Models`, `breadcrumb`) and the
  // picker's plain muted title line (`heading`). Neither call site ever sets
  // both, so they are alternatives, and both now feed the one bar —
  // `breadcrumb` first because the palette's crumb logic
  // (`projectCommandMenu`) is the source of truth for path text and already
  // grows with the browsed path.
  //
  // Appearance pin changed, position and row cost unchanged (still exactly
  // one line, still the first line of the expansion — see the
  // `expansionLimit` comment). At colour level 0 the bar degrades to D1's
  // rule byte for byte, so every NO_COLOR pin of that rule still holds.
  const listCrumb = input.list?.emptyLine ? undefined : input.list?.breadcrumb || input.list?.heading;
  // V4-B: the edit state's `Current: <value>` (mockup "Aktuell:
  // qwen3.8-max") — level 4 for the label, level 3b for the value, the same
  // two levels a settings ROW spends on the same two facts. It is chrome, so
  // it comes out of the one row budget below and `Frame.listRows` moves with
  // it; there is no second geometry to keep in sync.
  const listChrome: Line[] = [
    ...(listCrumb ? [titleBarLine(theme, listCrumb, { width: Math.max(1, width - 1) })] : []),
    ...(!input.list?.emptyLine && input.list?.currentValue
      ? [{ spans: [emphasize("4", "Current: "), emphasize("3b", input.list.currentValue)] }]
      : []),
  ];
  const listFooter: Line[] = !input.list?.emptyLine && input.list?.footer ? [input.list.footer] : [];
  // The row budget, computed ONCE: whatever the expansion has left after the
  // list's own chrome. Fix round 1 (review MAJOR 1) — `tui.ts`'s pointer
  // mapping used to re-derive this from a hand-copied `height >= 20 ? 6 : 4`
  // that knew nothing about the chrome, so V4-A's title bar silently shifted
  // the rows out from under every click. The window is derived from this
  // budget by `listWindow` (list-core.ts, the same function `buildListLines`
  // uses) and reported on the frame, so there is no second formula left to
  // drift.
  const listLimit = Math.max(
    0,
    expansionLimit - listValidation.length - listChrome.length - listFooter.length,
  );
  const listGeometry = input.list && !input.list.emptyLine
    ? listWindow(input.list.entries.length, input.list.selectedIndex, listLimit)
    : undefined;
  const expansion: Line[] = input.list
    ? input.list.emptyLine
      ? [input.list.emptyLine]
      : [
          ...listChrome,
          ...listValidation,
          ...buildListLines(input.list, Math.max(1, width - 1), listLimit, theme),
          ...listFooter,
        ]
    : editorExpansion.length
    ? editorExpansion
    : isHub
      ? [...emptyBrandAlternatives[0]!]
      : [];

  const crossBlock: ChatBlock | null = input.state.cross
    ? {
        kind: "notice",
        id: `cross:${input.state.cross.sequence}`,
        at: input.state.cross.updatedAt,
        level: input.state.cross.reason ? "warn" : "info",
        // G4 fix round 1 (B-6): the panel's COMPOSITION — the `result`/`phase`
        // dedup and the row grammar — moved to the import-free
        // `src/cross-panel.ts` so the window renders the same shape rather
        // than a second copy of these rules. Only the compact brand mark, a
        // terminal-height affordance with no counterpart in a window, is
        // still composed here.
        title: `${
          input.blocks.length === 0
          && height < 12
          && input.brand?.showHeaderMark
            ? `${input.brand.compactMark}${theme.glyph("separator")}`
            : ""
        }${crossPanelTitle(input.state.cross, theme.glyph("separator"))}`,
        cause: [...crossPanelFacts(input.state.cross, theme.glyph("separator"))],
      }
    : null;
  const frameInput: FrameInput = {
    width,
    height,
    theme,
    blocks: crossBlock ? [...input.blocks, crossBlock] : input.blocks,
    inputText: text,
    inputCursor,
    header: headerInfo(
      input.state,
      input.contextPercent,
      // FIX-17: `!isHub` (not `blocks.length > 0`) — a notice-only hub
      // renders the brand box itself, so the header mark would be a
      // duplicate exactly like at the pure-empty hub. Every non-hub frame
      // with content (or Cross) keeps the mark as before.
      !isHub && (input.blocks.length > 0 || input.state.cross) && input.brand?.showHeaderMark
        ? input.brand.compactMark
        : undefined,
      isHub,
    ),
    expansion,
    tick: input.tick ?? 0,
    now: input.now ?? Date.now(),
  };
  if (input.mode === "input") {
    // The folder-naming placeholder only makes sense over the empty-
    // transcript hub, where typing genuinely does start a new chat there
    // (Controller ruling 1, D8); mid-conversation keeps the generic prompt.
    // FIX-17: notice-only transcripts still count — a cancelled setup adds
    // notices but typing still starts this chat's first real turn.
    const atHub = isHubTranscript(input.blocks) && !input.state.cross;
    // The exact cell budget `render-frame.ts` gives the composer's text
    // column: the frame's usable width (`width - 1`) minus the `❯ ` gutter
    // it prefixes every input row with. Derived from the same theme glyph
    // rather than a hardcoded 2, so an ASCII gutter of a different width
    // stays correct.
    const composerBudget = Math.max(1, width - 1 - displayWidth(`${theme.glyph("userGutter")} `));
    frameInput.inputPlaceholder = inputPlaceholder(
      theme,
      composerBudget,
      atHub ? abbreviateHome(input.state.workspace, input.homeDir) : undefined,
    );
  }
  if (isHub) {
    frameInput.expansionAlternatives = emptyBrandAlternatives;
  }
  // A picker open over an empty transcript (the startup chat chooser, most
  // notably) would otherwise leave the whole stream area blank above it —
  // the picker keeps its own `expansion` layout untouched; this only fills
  // the dead rows above it with the same atomic workbench alternatives.
  // Mid-session pickers over real conversation content are unaffected: the
  // `input.blocks.length === 0` guard is the same "nothing to show yet"
  // check the branch above already uses.
  if (input.list && input.blocks.length === 0 && !input.state.cross) {
    frameInput.streamFallbackAlternatives = emptyBrandAlternatives;
  }
  if (inputLabel) frameInput.inputLabel = inputLabel;
  if (input.viewport) frameInput.viewport = input.viewport;
  const status = statusInfo(input);
  if (status) frameInput.status = status;
  const help = helpText(input);
  if (help) frameInput.help = help;
  if (input.newLinesBelow) frameInput.newLinesBelow = input.newLinesBelow;
  // Where the rows sit inside the expansion: after the title bar and any
  // validation line, before the action bar. `buildFrame` turns that into
  // absolute line indices — and drops it if the expansion did not survive.
  if (listGeometry && listGeometry.rows > 0) {
    frameInput.expansionListRows = {
      offset: listChrome.length + listValidation.length,
      count: listGeometry.rows,
      startIndex: listGeometry.start,
    };
  }
  return buildFrame(frameInput);
}
