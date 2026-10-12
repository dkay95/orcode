/**
 * A frozen, PROTOTYPE-LESS lookup table, and the honest type to read it with.
 *
 * Any table keyed by text that reaches us from outside — a typed command
 * token, a category name, an alias — must be built with this. A plain object
 * literal inherits `constructor`, `__proto__`, `toString` and friends from
 * `Object.prototype`, so `TABLE[whateverWasTyped]` can hand back a FUNCTION
 * from a table that only ever declared strings: `/constructor` used to crash
 * the slash dispatcher with a raw TypeError, and `/settings constructor`
 * opened Settings with `Object` as its category. `Object.freeze` does not
 * sever the prototype — only a null prototype does.
 *
 * The return type is the other half of the fix. Without
 * `noUncheckedIndexedAccess`, `Record<string, V>` types a miss as `V`, which
 * is precisely the lie that let a prototype hit flow onward as if it were a
 * real entry. Spelling the value `V | undefined` forces every call site to
 * answer what a miss means.
 */
export function lookupTable<Value>(
  entries: Readonly<Record<string, Value>>,
): Readonly<Record<string, Value | undefined>> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, Value>, entries),
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n… truncated …`;
}

/**
 * FIX-14 (consolidation wave, ticket 7): the ONE single-line truncator.
 *
 * Census of "cut a string to at most N characters and mark that it was cut":
 *
 *   workspace.ts   `oneLine(value, max)`     collapse + `slice(0, max - 1) + "…"`
 *   workspace.ts   `oneLineLimited(value)`   `slice(0, MAX) + "…"`      (no -1)
 *   openrouter.ts  `truncateDetail(text)`    collapse + `slice(0, 200) + "…"` (no -1)
 *
 * Three copies of one rule, disagreeing about whether the marker counts
 * toward the budget. Two of them broke their own promise: with the marker
 * appended outside the slice, "at most 200 characters" rendered 201. The
 * marker is inside the budget here, which is the only reading under which
 * the caller's number means what it says.
 *
 * `truncate` above stays separate and says why in its own shape: it marks a
 * cut on its own LINE, for multi-line content (an approval preview's
 * details), and callers of it are budgeting bytes of a block, not cells of
 * a row. Whitespace collapsing stays with the callers that want it — it is
 * a statement about the content, not about the budget.
 *
 * Display-cell truncation (`middleEllipsis`/`fitSpans`, `ui/compose.ts`) is
 * a third, genuinely different concept and is NOT folded in: it measures
 * terminal cells rather than code units, and it takes the theme's own
 * `ellipsis` glyph so ASCII glyph mode stays ASCII.
 */
export function ellipsize(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  // FIX-14 fix round 1 (review L3): "at most N" holds at EVERY budget,
  // including the degenerate ones. This used to return the bare marker for
  // `maximum <= 0` — one character past a zero budget, i.e. the exact
  // promise this survivor was chosen over the other two for keeping. A
  // budget with no room for the marker has no room to say anything at all.
  if (maximum <= 0) return "";
  return `${value.slice(0, maximum - 1)}…`;
}

/**
 * FIX-14 (consolidation wave, ticket 3): the ONE exact-USD formatter.
 *
 * The audit counted five dollar rules at five precisions plus eight inline
 * sites; the fresh census found three named formatters and nine inline
 * `.toFixed()` money literals, all rendering the same concept — "an exact
 * amount of money orcode is reporting to the user":
 *
 *   - this one                  5 decimals under a cent, else 3
 *   - `usd()`, commands.ts      5 decimals under a cent, else 2  (25 callers)
 *   - `costText()`, panel-view  5 decimals under a cent, else 4
 *   - inline `.toFixed(4)`      architect.ts, cli.ts, agent.ts,
 *                               dashboard-frame.ts (×2), render-block.ts
 *   - inline `.toFixed(2)`      dashboard-frame.ts, workbench.ts (×2)
 *
 * All of them are gone; every one of those sites calls this. The rule kept
 * is this function's own — it was already the most widely used, and it is
 * the only one of the three that is honest at both ends: five decimals
 * below a cent so a real sub-cent charge can never render as `$0.00`, three
 * above it so a run cost still shows mills. The visible cost of unifying is
 * that a plain dollar figure (a balance, a day's spend) now reads
 * `$14.760` rather than `$14.76`; that is the price of one spelling, and it
 * is stated rather than hidden.
 *
 * NOT unified into this, deliberately — two different concepts, each with
 * its own documented rule: `formatCostForecastBand` below (a MUTED,
 * pre-spend estimate band, which must fit a status line and says `<$0.01`
 * rather than pretend to precision it does not have) and
 * `formatCatalogPricePerMillion` (a per-MILLION-token catalog price, a
 * different unit entirely).
 *
 * ZERO IS ITS OWN SEMANTIC, not a fourth precision (FIX-14 fix round 1,
 * review L1 — the controller's ruling). Zero is the additive identity, not
 * a very small charge: the five-decimal branch exists so a REAL sub-cent
 * amount can never round away to `$0.00`, and routing zero through it
 * produced `$0.00000` — five digits of precision about nothing. With the
 * explicit case, `$0.00` becomes UNAMBIGUOUS: it can only ever mean exactly
 * zero, because every nonzero value below a cent still takes the
 * five-decimal branch. That STRENGTHENS the honesty invariant rather than
 * relaxing it, and it is the reading `forecastBound` below already uses one
 * function down (`!(value > 0)` renders `$0.00`, five decimals never).
 * `tests/utils.test.ts` pins the invariant in both directions.
 */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  const rendered = value.toFixed(Math.abs(value) < 0.01 ? 5 : 3);
  return "$" + rendered;
}

/**
 * Phase 12 (per-prompt cost forecast): the one pure formatter for the
 * status line's muted upfront estimate — `src/cost-forecast.ts`'s
 * `computePromptCostForecast` produces the raw `minUsd`/`maxUsd`; this
 * decides only the compact two-decimal wording (`~$0.04-0.09`), a
 * deliberately different shape from `formatUsd` above (which exists for
 * exact, already-spent amounts, not a muted band squeezed into a narrow
 * status line).
 *
 * Honesty rule (binding): a genuinely non-zero bound must never silently
 * round down to "$0.00" — below one cent it renders as `<$0.01` instead. An
 * ASCII hyphen joins the two bounds (not an em/en dash), matching
 * `formatCrossGateConsequence`'s own range wording (`cross-gate.ts`) for the
 * same NO_COLOR/width-safety reason. The two bounds share one leading `$`
 * only when neither needed the `<$0.01` fallback — that fallback already
 * carries its own `$`, so stripping the high bound's would misleadingly
 * read as a single ambiguous number (`<0.01-0.09`).
 */
export function formatCostForecastBand(minUsd: number, maxUsd: number): string {
  const low = forecastBound(minUsd);
  const high = forecastBound(Math.max(minUsd, maxUsd));
  if (low.text === high.text) {
    return `~${low.text}`;
  }
  return low.bare && high.bare
    ? `~${low.text}-${high.text.slice(1)}`
    : `~${low.text}-${high.text}`;
}

function forecastBound(value: number): { text: string; bare: boolean } {
  if (!(value > 0)) return { text: "$0.00", bare: true };
  if (value < 0.01) return { text: "<$0.01", bare: false };
  return { text: `$${value.toFixed(2)}`, bare: true };
}

/**
 * FIX-14 (consolidation wave, ticket 4): the ONE chars→tokens ratio.
 *
 * Three modules used to declare their own `4`: `compressor.ts`
 * (`CHARS_PER_TOKEN`), `openrouter.ts` (`PANEL_CHARS_PER_TOKEN`, exported
 * precisely because a fourth site wanted to reuse "the same" number), and
 * `ui/view-model.ts` (a bare `/ 4` inside its reasoning estimator). Three
 * declarations of one heuristic means the ratio can be corrected in one
 * place and silently stay wrong in the other two — and every one of them
 * feeds a number the user is asked to consent to money on.
 *
 * Exported because `/panel`'s estimate needs the ratio in the INVERSE
 * direction (output tokens → the chars they will cost), which no
 * chars→tokens function can express.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * FIX-14 ticket 4: the ONE chars→tokens estimator. `Math.ceil` (never
 * `Math.round`): a cost/context estimate that rounds DOWN understates what
 * the user is about to spend, and the whole honesty layer exists to stop
 * exactly that. Negative or zero chars yield 0 — never a fabricated
 * minimum.
 *
 * Lives here rather than in `compressor.ts` (its previous home) so
 * `openrouter.ts` and `ui/view-model.ts` can share it without either
 * importing a module that pulls in the agent SDK and a session store.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * D6 (the cost thread): one shared "is this balance low" predicate for the
 * bottom status line's shared balance/day segment, the welcome box's
 * Balance row, and `/provider status`'s appended sentence — so "low" can
 * never quietly mean something different on one surface than another.
 * `remainingUsd === undefined` (no cached balance — never fetched, or the
 * fetch failed) is never low: a warn state must never be inferred from the
 * absence of a real figure. `thresholdUsd <= 0` is the settings row's own
 * "0 disables" — the warn is switched off entirely, at any balance.
 */
export function isLowBalance(remainingUsd: number | undefined, thresholdUsd: number): boolean {
  return remainingUsd !== undefined && thresholdUsd > 0 && remainingUsd < thresholdUsd;
}

/**
 * A chat's cost, honestly: a real dollar figure normally, or
 * "provider-managed / unknown" (with an "at least $X" floor when some
 * metered spend is still known) for a chat whose cost is provider-managed.
 * Lives here — not in `cli.ts`, where it originated — so both the `/chats`
 * picker (`chatChoice`, `src/cli.ts`) and the start hub's "Recent" rows
 * (`tui.ts`) import the exact same wording instead of each keeping their
 * own copy that could drift. FIX-14 ticket 3 also folded `commands.ts`'s
 * `displayCost` — a second copy of this exact wording over a different
 * dollar formatter — into it.
 *
 * FIX-14 ticket 8: `separator` is a REQUIRED parameter, for exactly the
 * reason `formatChatRow` below spells out — the "at least $X · further
 * provider-managed costs unknown" branch used to hardcode a raw `·`, so a
 * caller that dutifully passed `theme.glyph("separator")` everywhere else
 * still leaked a non-ASCII byte out of this one branch. A default would let
 * that come back silently.
 */
export function formatChatCost(
  chat: { readonly costKnowledge?: "known" | "unknown"; readonly costUsd: number },
  separator: string,
): string {
  if (chat.costKnowledge === "unknown") {
    return chat.costUsd > 0
      ? `at least ${formatUsd(chat.costUsd)}${separator}further provider-managed costs unknown`
      : "provider-managed / unknown";
  }
  return formatUsd(chat.costUsd);
}

/**
 * FIX-9 (plurals): `<n> <noun>` with the noun actually inflected — the
 * generalization of the count pattern `formatChatRow` below already spells
 * out inline (`1 message` / `3 messages`). It exists so user copy never has
 * to fall back on the lazy `N file(s)` form, which reads as unfinished
 * placeholder text; `plural` is only needed for a noun that is irregular or
 * does not simply take `-s` (`entry`/`entries`).
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}

/**
 * Coarse relative time ("2h ago", "1d ago") for chrome with no room for an
 * absolute timestamp — the start hub's "Recent" rows (V3 deltas, generalized
 * D8). Takes both instants explicitly; this module keeps no clock of its own.
 */
export function relativeAge(nowMs: number, thenMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * `anthropic/claude-sonnet-5` → `claude-sonnet-5` (controller decision B:
 * "model short"). Moved here from `ui/dashboard-frame.ts` (D8) so this row
 * composer (`formatChatRow` below) can use it without `ui/dashboard-frame.ts`
 * importing from here and `workbench.ts` importing `ui/dashboard-frame.ts`
 * back — that would cycle. `ui/dashboard-frame.ts` re-exports this name so
 * every existing `from "./ui/dashboard-frame.js"` import keeps working
 * unchanged.
 */
export function shortModelName(model: string): string {
  const index = model.indexOf("/");
  return index === -1 ? model : model.slice(index + 1);
}

/**
 * FIX-10 H4 (retention honesty): a chat retains at most this many turns —
 * `session.ts` slices to exactly this constant on every addTurn (it imports
 * THIS value, so the cap and its disclosure can never drift apart). At the
 * cap a rendered count cannot distinguish "exactly 80" from "80 retained of
 * more"; `formatMessageCount` below renders the cap marker for that case
 * instead of a bare number that silently saturates.
 */
export const MAX_RETAINED_TURNS = 80;

/**
 * FIX-10 H4: the ONE message-count formatter — "1 message", "N messages",
 * and at the retention cap the honest "80+ messages" marker. Used by
 * `formatChatRow` below, the plain `/chats` rows (`commands.ts`), and the
 * dashboard header's chat segment (`cli.ts`) — never a second
 * implementation that could saturate silently again.
 */
export function formatMessageCount(count: number): string {
  if (count >= MAX_RETAINED_TURNS) return `${MAX_RETAINED_TURNS}+ messages`;
  return count === 1 ? "1 message" : `${count} messages`;
}

/**
 * The one row composition for "a chat, summarized": `<n> messages · $<cost>
 * · <model short> · <relative time>[ · <folder>]`. Used verbatim by the
 * `/chats` picker (`chatChoice`, `src/cli.ts`) and the start hub's "Recent"
 * rows (`tui.ts`, D8) — one composer, never a second implementation that
 * could drift from it. `folder` is omitted for the current folder's own
 * chats (the caller decides that by comparing workspaces); when given, it is
 * appended last, unchanged from the pre-D8 wording.
 *
 * FIX-21 finding 5 (visual audit 2026-08-28, frame-verified): the separator
 * used to be a raw `·` literal, so the hub's "Recent" rows kept emitting a
 * non-ASCII byte in ASCII glyph mode. `separator` is a required parameter
 * rather than a defaulted one on purpose — a default would let a future call
 * site re-introduce the leak silently; every caller must hand over
 * `theme.glyph("separator")` (spaces already baked in, same as everywhere
 * else this glyph is used as a join delimiter).
 */
export function formatChatRow(
  chat: {
    readonly title: string;
    readonly turnCount: number;
    readonly costUsd: number;
    readonly costKnowledge?: "known" | "unknown";
    readonly model?: string;
  },
  updatedAtMs: number,
  folder: string | undefined,
  separator: string,
): { readonly label: string; readonly description: string } {
  // FIX-10's one message-count formatter + FIX-21's theme separator.
  const messages = formatMessageCount(chat.turnCount);
  const model = chat.model ? `${separator}${shortModelName(chat.model)}` : "";
  const folderSuffix = folder ? `${separator}${folder}` : "";
  return {
    label: chat.title,
    description: `${messages}${separator}${formatChatCost(chat, separator)}${model}${separator}`
      + `${relativeAge(Date.now(), updatedAtMs)}${folderSuffix}`,
  };
}

/**
 * Humanizes a token count the same way everywhere a model's context window
 * is shown compactly (`200000` → `"200K"`, `1000000` → `"1M"`). Moved here
 * from `commands.ts` (Phase F3, information-dense pickers) so
 * `createTerminalModelRoutePicker` (`tui.ts`) can share the exact same
 * rendering instead of growing its own copy.
 *
 * `Intl`'s compact notation is decimal (1000-based) throughout — honest for
 * a round decimal size like `200000` or `1000000`, but it renders a
 * power-of-2 context window (`131072`, `65536`, …) with a misleading
 * fractional digit (`"131.1K"`) instead of the conventional binary label
 * every model card actually advertises (`"128K"`). `contextLengthLabel`
 * below is the ctx-specific helper that catches that case; this function's
 * own decimal semantics are unchanged for every other caller (general
 * compact-number display has no binary convention to honor).
 */
export function compactNumber(value: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** 1024 and 1024*1024, named for `contextLengthLabel`'s power-of-2 test below. */
const BINARY_K = 1024;
const BINARY_M = BINARY_K * BINARY_K;

/**
 * The ctx segment every `/model` row shows (Phase F3 review, parked;
 * F6 formatter consolidation). Model context windows are conventionally
 * quoted in binary units — a "128K" model really has a `131072`-token
 * window (128 × 1024) — but `compactNumber`'s decimal notation renders that
 * as `"131.1K"`, a fractional digit nobody asked for and no model card
 * shows. For a value that is an exact power of 1024 at or above one binary
 * K, this renders the conventional binary label (`131072` → `"128K"`,
 * `65536` → `"64K"`, `1048576` → `"1M"`); every other size (a round decimal
 * like `200000`, or anything else) falls through to `compactNumber`
 * unchanged, since there is no binary convention to honor for those.
 */
export function contextLengthLabel(value: number): string {
  if (
    Number.isInteger(value)
    && value >= BINARY_K
    && Number.isSafeInteger(value)
    && (value & (value - 1)) === 0
  ) {
    return value % BINARY_M === 0 ? `${value / BINARY_M}M` : `${value / BINARY_K}K`;
  }
  return compactNumber(value);
}

/**
 * `<perToken>` USD → the compact "$X/M" a model-route picker row shows,
 * trimmed to the fewest decimals that still represent the real value
 * (`0.000003` → `"$3/M"`, `0.00000007` → `"$0.07/M"`) — never rounds a
 * genuine non-zero price down to "$0/M" (six decimal places of per-million
 * precision covers every real OpenRouter price). Used by
 * `formatModelRouteDetail` below; exported separately so a test can pin the
 * rounding rule on its own.
 */
export function formatCatalogPricePerMillion(perToken: number): string {
  const perMillion = perToken * 1_000_000;
  const fixed = perMillion.toFixed(6);
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return `$${trimmed}/M`;
}

/**
 * The one `<provider> · <price> · <ctx>` detail line every /model route
 * picker row composes (Phase F3, information-dense pickers — honesty
 * ruling): a route with real per-token pricing shows `$in/M in · $out/M
 * out`; a provider-managed route (Kimi & friends, no meterable per-token
 * price) shows `subscription` instead of a price — never a fabricated
 * number. An unknown/zero context length omits the ctx segment rather than
 * inventing one. Shared by `pickSelectableModelRoute` and
 * `modelChoiceDescription` (`commands.ts`) and
 * `createTerminalModelRoutePicker` (`tui.ts`) — the fullscreen route
 * picker, its plain-mode fallback, and the plain legacy ModelInfo picker —
 * so the same honesty rule never drifts into three different wordings.
 */
export function formatModelRouteDetail(input: {
  readonly providerLabel: string;
  readonly price:
    | { readonly kind: "known"; readonly promptUsdPerToken: number; readonly completionUsdPerToken: number }
    | { readonly kind: "subscription" };
  readonly contextLength: number;
}): string {
  const segments = [
    input.providerLabel,
    input.price.kind === "known"
      ? `${formatCatalogPricePerMillion(input.price.promptUsdPerToken)} in · `
        + `${formatCatalogPricePerMillion(input.price.completionUsdPerToken)} out`
      : "subscription",
  ];
  if (Number.isFinite(input.contextLength) && input.contextLength > 0) {
    segments.push(contextLengthLabel(input.contextLength));
  }
  return segments.join(" · ");
}

/**
 * What a block in the stream is showing — one word per state, shared by
 * every surface that draws the stream (`ui/blocks.ts` re-exports it as
 * `BlockState`).
 *
 * Lives here because the classification below has to live here, and the two
 * belong together.
 */
export type ToolBlockState = "running" | "ok" | "unverified" | "failed" | "cancelled";

export const TOOL_BLOCK_STATES: readonly ToolBlockState[] = Object.freeze([
  "running",
  "ok",
  "unverified",
  "failed",
  "cancelled",
] as const);

/**
 * How a finished tool call is graded — the honesty rule, in one function.
 *
 * `✓` only when a process exited with 0. Everything else that merely
 * worked gets `~` (unverified) — Bauplan 2.5. That default is the whole
 * point: `write_file` returns `{ok:true, path, bytes}` and reports no exit
 * code, so it is **unverified**, not done, until something verifies it. A
 * surface that defaulted the other way would quietly promote every edit to
 * "done" and soften the same rule `agent.ts` enforces at run level.
 *
 * Moved here from `ui/view-model.ts` (G2 fix round 1): the desktop window
 * grades the same events, and a second copy of this had already forked —
 * it defaulted to `ok`, so a written file read as "done" in the window
 * while the terminal called it unverified. One function, both surfaces.
 */
export function classifyToolOutcome(
  output: unknown,
): { state: ToolBlockState; exitCode?: number } {
  const data = isRecord(output) ? output : null;
  const exitCode = data && typeof data.exitCode === "number" ? data.exitCode : undefined;
  if (exitCode === undefined) {
    // The process adapter folds a structured completion.error into stderr so
    // the existing output selector can render it. A null exit plus that
    // terminal reason is a failed launch, not an ordinary unverified result;
    // keep the exit code absent instead of inventing one.
    const terminalReason = data?.exitCode === null
      && typeof data.stderr === "string"
      && data.stderr.trim().length > 0;
    return { state: terminalReason ? "failed" : "unverified" };
  }
  return { state: exitCode === 0 ? "ok" : "failed", exitCode };
}

/**
 * How a run ended — the same six words `AgentRunEvent`'s `run-end` carries.
 *
 * Spelled out here rather than imported so this module keeps its one
 * property that makes it shareable: it imports nothing, from anywhere. The
 * two unions cannot drift apart silently — `src/tui.ts` holds a compile-time
 * proof that the core's own outcome type is assignable to this one.
 */
export type RunEndOutcome =
  | "complete"
  | "step-limit"
  | "cost-limit"
  | "error"
  | "cancelled"
  | "unverified";

/**
 * Display label for a run-end outcome — the one place this wording lives.
 *
 * The honesty rule it carries: a cancelled run is never "complete", and an
 * unverified one says so on the same line. Moved here from `src/tui.ts` (G2)
 * so the desktop window renders the identical sentence instead of keeping a
 * second copy that could drift; `tui.ts` re-exports it for every existing
 * caller.
 *
 * FIX-21 finding 5 (frame-verified): the `unverified` label used to compose
 * a raw `·`, which meant the run-complete line kept a unicode byte in ASCII
 * glyph mode. `separator` is required rather than defaulted so a future call
 * site cannot silently re-introduce the literal.
 */
/* -------------------------------------------------------------------------
 * List windowing — which rows a bounded list actually shows.
 * ---------------------------------------------------------------------- */

/** Which rows a bounded list renders. `rows: 0` means it cannot render at all. */
export interface ListWindow {
  /** Index of the first rendered row. */
  readonly start: number;
  /** How many rows are rendered. */
  readonly rows: number;
}

export function clampListIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(value, 0), length - 1);
}

/**
 * The window FOLLOWS the selection, keeping it roughly centred.
 *
 * A list that renders a fixed prefix while the cursor walks past it puts the
 * selection off screen: no marker anywhere, and Return acts on a row nobody
 * can see. That is what this prevents, and it is the same computation the
 * terminal's pickers use (`ui/list-core.ts` re-exports it) — one rule, so a
 * broad search behaves the same in the window and in the terminal.
 */
export function listWindow(
  entryCount: number,
  selectedIndex: number,
  limit: number,
): ListWindow {
  if (entryCount <= 0 || limit <= 0) return { start: 0, rows: 0 };
  const selected = clampListIndex(selectedIndex, entryCount);
  const rows = Math.min(limit, entryCount);
  return { start: clampListIndex(selected - Math.floor(rows / 2), entryCount - rows + 1), rows };
}

/* -------------------------------------------------------------------------
 * Stream reduction — how much of a tool's output a surface keeps, and which
 * of it. Shared for the same reason the grading is (G2's named debt list).
 * ---------------------------------------------------------------------- */

/** Visible output lines of a running tool block — the block never grows. */
export const RUNNING_TAIL_LINES = 3;

/** Ring buffer size per tool block. */
export const TAIL_CAPACITY = 200;

/** Collapsed reasoning shows one line; expanded at most this many. */
export const REASONING_MAX_LINES = 12;

/** From the design doc (section 2.5): lines a failed run's preview prefers. */
const ERROR_LINE = /(^|\s)(error|ERROR|FAIL|Fail|\u2717|panic|Traceback|error TS\d+)/;

/** Output split into the lines a surface can show: no blanks, no trailing space. */
export function textLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((item) => item.replace(/\s+$/, ""))
    .filter((item) => item.trim().length > 0);
}

/**
 * Which lines survive in a collapsed block: on failure the first lines that
 * look like the actual error, on success the last ones.
 *
 * This decides WHAT A PERSON IS SHOWN about a failure, so it is not
 * formatting — a surface that kept the tail of a failed build shows the
 * summary line and hides the error. One rule, every surface.
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

/**
 * Which keys of a tool result are OUTPUT.
 *
 * A surface that read a different set would silently show nothing for a tool
 * whose result happens to use one of the others — an invisible tool, which is
 * the failure this list prevents.
 */
export function outputLines(output: unknown): string[] {
  const data = isRecord(output) ? output : null;
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

/**
 * The live token estimate while reasoning streams in.
 *
 * Providers only report the real count when the model call ends, so without
 * this a thinking panel sits at "0 tokens" for its whole lifetime. The
 * arithmetic is `estimateTokensFromChars` — the one ratio in the project.
 * Only the whitespace guard is local: it is a statement about what counts as
 * a thought, not about the ratio. A panel that claimed a different size on
 * one surface would be a claim about the same thinking, twice.
 */
export function estimateReasoningTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return estimateTokensFromChars(trimmed.length);
}

export function runOutcomeLabel(outcome: RunEndOutcome, separator: string): string {
  switch (outcome) {
    case "complete":
      return "Run complete";
    case "step-limit":
      return "Step limit reached";
    case "cost-limit":
      return "Cost limit reached";
    case "cancelled":
      return "Run cancelled";
    case "error":
      return "Run failed";
    case "unverified":
      return `Run complete${separator}unverified`;
  }
}

/**
 * Strips anything that looks like a secret from an environment before it is
 * handed to a child process. Lives here (rather than in workspace.ts, which
 * originally defined it) so both workspace.ts's `run_command`/`git_diff` and
 * browser.ts's headless-browser launch can import it without the two files
 * importing from each other.
 */
export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (/(key|token|secret|password|credential|authorization|cookie)/i.test(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}
