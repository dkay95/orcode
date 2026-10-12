import { ROUTE_CORE_WORDMARK } from "../branding.js";
import type { DashboardBranding } from "./dashboard-frame.js";
import { fitSpans } from "./compose.js";
import { fillSelectionBar } from "./list-core.js";
import { span, spansWidth, type Line, type Span } from "./spans.js";
import type { Theme } from "./theme.js";
import { formatUsd, isLowBalance } from "../utils.js";

export interface WorkbenchInput {
  readonly branding: DashboardBranding;
  /**
   * The hub's "Recent" section rows (Controller ruling 1/3, D8): up to 4
   * chats across every known workspace, most-recent first, already composed
   * by the caller (`dashboard-frame.ts`) via the exact `/chats` row composer
   * (`formatChatRow`, `utils.js`) — this module only lays them out, it never
   * reformats a chat itself. Empty means no chat exists anywhere (ruling 5's
   * empty state), not "not loaded yet" — the caller owns that distinction.
   */
  readonly recentChats: readonly { readonly label: string; readonly hint: string }[];
  /**
   * The hub's fixed quick-action row (Controller ruling 1, D8): New chat ·
   * All chats · Folder · Settings, in this order — the single "Continue"
   * quick action it superseded is gone, along with its hint plumbing.
   */
  readonly quickGroups: readonly { readonly label: string; readonly hint: string }[];
  /**
   * Index into the ONE selection list `recentChats` then `quickGroups`
   * concatenate into (Controller ruling 2: no new list mechanism — the
   * existing quick-action machinery generalized to cover both). `undefined`
   * shows no `❯` marker at all (V3 interaction ruling).
   */
  readonly quickActionIndex?: number;
  readonly theme: Theme;
  /** Render width — the box degrades atomically when it would not fit. */
  readonly width: number;
  readonly workspace: string;
  /** Used only to abbreviate `workspace` to `~/...`; omit and it renders in full. */
  readonly homeDir?: string;
  readonly route: string;
  /**
   * FIX-18 (F3, one connection truth): true when the provider runtime says
   * the shown route cannot RUN (derived from the same predicate /provider
   * status derives "Not connected" from — never a second, restated check).
   * The Route row then carries the honest state instead of claiming a dead
   * route. `undefined` means the caller could not derive it: no claim.
   */
  readonly routeNotConnected?: boolean;
  readonly approval: string;
  /** The status line's own git-branch derivation (3f8bb12) — folded into the muted context line; omitted outside a git repository. */
  readonly branch?: string;
  /** Remaining OpenRouter credit in USD, net of this session's spend. `undefined` omits the Balance row entirely — never a fabricated number. */
  readonly balanceRemainingUsd?: number;
  /** True on a provider-managed (Kimi) route — the Balance row then reads "provider-managed" regardless of `balanceRemainingUsd`. */
  readonly balanceProviderManaged?: boolean;
  /** D6 (the cost thread): below this figure, the Balance row switches to the warn state (`isLowBalance`, utils.ts). `undefined`/`0` both mean the warn is off. */
  readonly lowBalanceThresholdUsd?: number;
  /** Workspace-wide spend today — folded into the Balance row's `· $Y spent today` suffix when both it and `balanceRemainingUsd` are known. */
  readonly dayUsd?: number;
  /** Phase 10 honesty guard: short model labels, already applied by the caller (dashboard-frame.ts). `undefined` omits the Cross row entirely — a fresh or disarmed chat has nothing to disclose here. */
  readonly crossArmed?: { readonly lead: string; readonly challenger: string; readonly oneShot?: boolean };
}

/** Content sizes to fit between these two bounds (Terminal-Look spec principle 1). */
const MIN_BOX_INNER = 24;
const MAX_BOX_INNER = 56;

/** `~`-abbreviates `path` under `homeDir` — shared with the sectioned `/chats` list's `<~folder>` rows (workspace-mobility Phase F1b). */
export function abbreviateHome(path: string, homeDir?: string): string {
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  return path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * Balance row, appended after Route when there is anything honest to say
 * (V3 deltas): a real remaining-credit figure with today's spend, or
 * "provider-managed" on a Kimi route. `null` when neither applies — credits
 * were never fetched or the fetch failed — so the row is omitted outright
 * rather than showing a fabricated number.
 *
 * FIX-10 H3 (money honesty): the figure is a cached fetch net of this
 * session's tracked spend, not a live account read — it renders with the
 * `~` hedge every other derived money figure already carries, never as
 * bare precision.
 *
 * D6 (the cost thread): below `lowBalanceThresholdUsd`, the figure switches
 * to the warn role and an explicit `· low` marker rides alongside it — the
 * same NO_COLOR-safe convention `crossArmedRow` and the allow-all context
 * line below already use (the wording itself carries the meaning, colour is
 * decoration only, so nothing is lost at colour level 0). Never reachable
 * for a provider-managed route: there is no metered figure to compare.
 */
function balanceRow(input: WorkbenchInput): Span[] | null {
  if (input.balanceProviderManaged) {
    return [span("Balance   ", "muted"), span("provider-managed", "text")];
  }
  if (input.balanceRemainingUsd === undefined) return null;
  const sep = input.theme.glyph("separator");
  const low = isLowBalance(input.balanceRemainingUsd, input.lowBalanceThresholdUsd ?? 0);
  // FIX-14 ticket 3: `formatUsd` (utils.ts) — this row used to carry two
  // more inline `.toFixed(2)` money literals of its own.
  const remaining = `~${formatUsd(input.balanceRemainingUsd)}`;
  const spentToday = input.dayUsd !== undefined
    ? `${sep}${formatUsd(input.dayUsd)} spent today`
    : "";
  return [
    span("Balance   ", "muted"),
    span(remaining, low ? "warn" : "text", low ? { bold: true } : undefined),
    ...(low ? [span(`${sep}low`, "warn")] : []),
    span(spentToday, "muted"),
  ];
}

/**
 * Cross row, appended when Cross mode is armed (persistent) or waiting
 * (pending one-shot) for this chat (Phase 10 honesty guard, extended by the
 * owner's fix-round ruling): "armed"/"waiting" carries the meaning in
 * wording, not just colour, the same NO_COLOR-safe treatment the allow-all
 * warning gets on the context line below — a plain-text terminal must not
 * lose the fact that either state has a real cost consequence once it fires.
 */
function crossArmedRow(input: WorkbenchInput): Span[] | null {
  if (!input.crossArmed) return null;
  const sep = input.theme.glyph("separator");
  return [
    span("Cross     ", "muted"),
    span(input.crossArmed.oneShot ? "waiting" : "armed", "warn", { bold: true }),
    span(`${sep}${input.crossArmed.lead}+${input.crossArmed.challenger}${sep}/cross off to stop`, "muted"),
  ];
}

/**
 * The ONE muted context line (Controller ruling 1, D8): Folder + branch +
 * approval mode collapse into a single unlabeled row — `~/folder ·
 * <branch> · approvals <mode> · /approvals to change` — the same "unlabeled,
 * muted, `·`-joined" convention the bottom status line's own permanent
 * identity chrome already uses (`statusInfo`, `dashboard-frame.ts`), so the
 * hub's chrome and the idle status line read as one family.
 *
 * Allow-all is dangerous enough that the wording itself carries the warning
 * (NO_COLOR-safe), not just the "warn" role's colour, which disappears
 * entirely at colour level 0: only the `approvals <mode>` segment (and the
 * `/approvals to change` hint after it) is replaced by the full warn
 * treatment — the folder/branch prefix stays exactly as it was. The warning
 * never shrinks: this is the same wording the pre-D8 Approvals row used.
 */
function contextLine(input: WorkbenchInput): Span[] {
  const sep = input.theme.glyph("separator");
  const folderValue = abbreviateHome(input.workspace, input.homeDir);
  const prefix = input.branch ? `${folderValue}${sep}${input.branch}` : folderValue;
  if (input.approval === "allow-all") {
    return [
      span(`${prefix}${sep}`, "muted"),
      span("allow-all", "warn", { bold: true }),
      span(`${sep}every action runs unasked`, "warn"),
    ];
  }
  return [span(`${prefix}${sep}approvals ${input.approval}${sep}/approvals to change`, "muted")];
}

/**
 * The header row's own wordmark + version (D8d, one source): `ROUTE_CORE_
 * WORDMARK` (branding.ts) is also the fallback tier's bare-mark line below,
 * and `branding.version` is `readPackageVersion()` (branding.js), threaded
 * through by the caller — the same figure `orcode --version`/the plain
 * banner state, never a second read.
 */
function headerRow(input: WorkbenchInput): Span[] {
  const wordmark = `${ROUTE_CORE_WORDMARK} ${input.branding.version}`;
  return input.branding.showHeaderMark
    ? [span(`${input.branding.compactMark} `, "accent"), span(wordmark, "text", { bold: true })]
    : [span(wordmark, "text", { bold: true })];
}

/**
 * The Route row, or — when genuinely nothing is configured — an honest
 * stand-in naming the way out (D8d root-cause fix): a fresh/switched chat's
 * `resolvedModel` is `""` between the reset and that chat's first completed
 * run (`effectiveRoute`, dashboard-frame.ts, already falls back to the
 * always-populated configured route for that ordinary case), so this branch
 * is reachable only when the caller's own `route` is truly empty — never a
 * fabricated "not set" for a route that was in fact known the whole time.
 */
function routeRow(input: WorkbenchInput): Span[] {
  const routeValue = input.route.trim();
  const emdash = input.theme.glyph("emdash");
  if (!routeValue) {
    // FIX-18 (F3): with no provider connected, /model is not the way out —
    // it needs a connected provider itself. Name the one working step.
    return input.routeNotConnected === true
      ? [span(`No provider connected ${emdash} /provider setup`, "muted")]
      : [span(`No route configured ${emdash} /model picks one`, "muted")];
  }
  if (input.routeNotConnected === true) {
    // FIX-18 (F3): the hub must not claim a dead route as if it could run.
    // The warn state itself rides on this row; the next-step hint gets its
    // own row below (`routeNotConnectedRow`) so the box's width clamp can
    // never ellipsize the one working command away.
    return [
      span("Route     ", "muted"),
      span(routeValue, "text"),
      span(`${input.theme.glyph("separator")}not connected`, "warn", { bold: true }),
    ];
  }
  return [span("Route     ", "muted"), span(routeValue, "text")];
}

/**
 * FIX-18 (F3): the honest follow-up to a claimed-but-dead Route row — warn
 * wording carries the state (NO_COLOR-safe, the same convention the Cross
 * "armed" and Balance "low" rows use) and the muted tail names the ONE
 * working next step. Its own row, not a Route-row suffix, so the box's
 * MAX_BOX_INNER clamp cannot truncate the command on long model ids.
 */
function routeNotConnectedRow(input: WorkbenchInput): Span[] | null {
  if (input.routeNotConnected !== true || !input.route.trim()) return null;
  return [
    span("          ", "muted"),
    span("run /provider setup to connect", "muted"),
  ];
}

/**
 * The box's content rows, before any bordering — shared by the bordered and
 * plain-degrade paths. Order (Controller ruling 1, D8): header, Route,
 * Balance (when known), the one muted context line, then Cross (when
 * armed) — Balance now sits ABOVE the context line, a deliberate reorder
 * from the pre-D8 box.
 */
function identityRows(input: WorkbenchInput): Span[][] {
  const balance = balanceRow(input);
  const notConnected = routeNotConnectedRow(input);
  const crossArmed = crossArmedRow(input);
  return [
    headerRow(input),
    routeRow(input),
    ...(notConnected ? [notConnected] : []),
    ...(balance ? [balance] : []),
    contextLine(input),
    ...(crossArmed ? [crossArmed] : []),
  ];
}

function boxRow(theme: Theme, spans: Span[], innerWidth: number): Line {
  const fitted = fitSpans(spans, innerWidth, theme.glyph("ellipsis"));
  const pad = Math.max(0, innerWidth - spansWidth(fitted));
  return {
    spans: [
      span(`${theme.glyph("boxV")} `, "structure"),
      ...fitted,
      span(`${" ".repeat(pad)} ${theme.glyph("boxV")}`, "structure"),
    ],
  };
}

/**
 * The one welcome box (Terminal-Look spec principle 1): compact mark +
 * `orcode · Route Core`, then Route / Balance (when known) / the one muted
 * context line, plus Cross when armed. Sizes to content between
 * `MIN_BOX_INNER` and `MAX_BOX_INNER`; returns `null` when even the minimum
 * would not fit — the caller then falls back to the same rows with no
 * border at all, since a clipped border is worse than no border.
 */
function welcomeBox(input: WorkbenchInput): Line[] | null {
  const { theme } = input;
  const rows = identityRows(input);
  const contentWidth = rows.reduce((widest, row) => Math.max(widest, spansWidth(row)), 0);
  const innerWidth = Math.min(MAX_BOX_INNER, Math.max(MIN_BOX_INNER, contentWidth));
  const totalWidth = innerWidth + 4; // one padding space + one border char, both sides
  if (totalWidth > input.width) return null;

  const horizontal = theme.glyph("boxH").repeat(innerWidth + 2);
  const top: Line = {
    spans: [span(`${theme.glyph("boxTopLeft")}${horizontal}${theme.glyph("boxTopRight")}`, "structure")],
  };
  const bottom: Line = {
    spans: [span(`${theme.glyph("boxBottomLeft")}${horizontal}${theme.glyph("boxBottomRight")}`, "structure")],
  };
  return [top, ...rows.map((row) => boxRow(theme, row, innerWidth)), bottom];
}

/** Atomic width degrade: the same identity information, no border at all. */
function plainIdentityLines(input: WorkbenchInput): Line[] {
  return identityRows(input).map((row) => ({
    spans: fitSpans(row, Math.max(1, input.width), input.theme.glyph("ellipsis")),
  }));
}

/**
 * One selectable row — a "Recent" chat or a fixed quick action render
 * identically (Controller ruling 2: one list mechanism, generalized rather
 * than duplicated): a bold accent label, two spaces, then a muted hint.
 *
 * The active row (D1 bar-consistency addendum) carries the SAME selected-row
 * convention `list-core.ts`'s pickers/command menu use everywhere else: a
 * full-width inverse bar — marker, label, gap and hint all painted with the
 * "inverse" role, padded with more inverse-painted spaces out to `width` so
 * the highlight reads as one solid bar, not just a coloured marker glyph.
 * The bar-fill step itself is `list-core.ts`'s own exported
 * `fillSelectionBar` (D8b: this used to be hand-copied here — the exact
 * drift the one-list-mechanism constraint exists to prevent, per the D8
 * review) — this function only builds the row's own fitted spans and hands
 * them to it. The rest of `list-core.ts`'s `ListView`/`buildListLines`
 * pipeline stays unused here: its description/"n of total" column shape
 * does not fit this fixed, unpaginated 4-or-fewer-plus-4 row list.
 *
 * Unlike the pre-D8b version, level 0 is NOT special-cased: `fillSelectionBar`
 * always pads to `width`, at every colour level, matching `list-core.ts`'s
 * own pickers exactly (`buildListLines` calls it unconditionally too).
 * `theme.color("inverse")` (`theme.ts`'s `base()`/`paintSpan`) already
 * collapses every role, including "inverse", to plain text at colour level
 * 0 — so the padding is real bytes but genuinely invisible on a real
 * terminal, never a visible artifact. The pre-D8b skip-padding-at-level-0
 * behavior was a disclosed divergence from `list-core.ts`'s convention;
 * this closes it in `list-core.ts`'s favor rather than the reverse.
 */
function actionLine(theme: Theme, label: string, hint: string, active: boolean, width: number): Line {
  // D8d fix: both branches now go through the SAME `fitSpans` call the
  // active bar always used — the un-highlighted branch used to return its
  // raw spans unfitted, so a Recent row's `~folder` suffix (appended by
  // `formatChatRow` with no width awareness of its own) could run past the
  // frame's width with no ellipsis at all; the terminal itself then hard-cut
  // it, mid-word, on the next repaint. One truncation mechanism for every
  // row, active or not — never a second, narrower one.
  if (!active) {
    const fitted = fitSpans(
      [
        span("  ", "accent", { bold: true }),
        span(label, "accent", { bold: true }),
        span("  ", "text"),
        span(hint, "muted"),
      ],
      width,
      theme.glyph("ellipsis"),
    );
    return { spans: fitted };
  }
  const fitted = fitSpans(
    [
      span(`${theme.glyph("marker")} `, "inverse", { bold: true }),
      span(label, "inverse", { bold: true }),
      span("  ", "inverse"),
      span(hint, "inverse"),
    ],
    width,
    theme.glyph("ellipsis"),
  );
  return fillSelectionBar({ spans: fitted }, width);
}

/**
 * The "Recent" section (Controller ruling 1/5, D8): a muted heading, then up
 * to 4 selectable chat rows, or — when no chat exists anywhere — one muted
 * invitation line standing in for the (empty) list. The invitation is
 * decorative, not selectable: it never claims a slot in the shared
 * selection index (`quickActionIndex`).
 */
function recentSection(input: WorkbenchInput): Line[] {
  const heading: Line = { spans: [span("Recent", "muted")] };
  if (input.recentChats.length === 0) {
    return [
      heading,
      { spans: [span(`No chats yet ${input.theme.glyph("emdash")} type below to start your first one.`, "muted")] },
    ];
  }
  const rows = input.recentChats.map(({ label, hint }, index) =>
    actionLine(input.theme, label, hint, input.quickActionIndex === index, input.width));
  return [heading, ...rows];
}

/**
 * The fixed quick-action row(s) (Controller ruling 1, D8): New chat · All
 * chats · Folder · Settings. Indexed right after `recentChats` in the one
 * shared selection list (Controller ruling 2).
 */
function quickActionSection(input: WorkbenchInput): Line[] {
  const offset = input.recentChats.length;
  return input.quickGroups.map(({ label, hint }, index) =>
    actionLine(input.theme, label, hint, input.quickActionIndex === offset + index, input.width));
}

/**
 * Atomic empty-workbench presentations, ordered from most to least spacious.
 * The frame chooses one complete alternative; Route Core geometry is never
 * clipped to make a half-mark fit.
 */
export function workbenchAlternatives(
  input: WorkbenchInput,
): readonly (readonly Line[])[] {
  // Rock-bottom fallback only (Controller ruling 1 drops the generic
  // invitation from the hub itself — the "Recent" heading and the fixed
  // actions' own human-readable labels are self-explanatory now): a
  // terminal too small even for one row still needs something, so this stays
  // the last rung of the degrade ladder below.
  const invitation: Line = { spans: [span("What would you like to do?", "text", { bold: true })] };
  const recent = recentSection(input);
  const quickTasks = quickActionSection(input);
  // Richest: the welcome box (Route/Balance when known/the one muted context
  // line, plus Cross when armed), or its border-less width-degrade — either
  // way, the same identity information.
  const identity = welcomeBox(input) ?? plainIdentityLines(input);
  const boxWelcome = [
    ...identity,
    { spans: [] },
    ...recent,
    { spans: [] },
    ...quickTasks,
  ];
  // Lighter fallback for terminals too short for the box: the pre-box compact
  // mark line, kept so a merely-short terminal still gets the Recent section
  // and quick actions instead of jumping straight to the bare invitation.
  const legacyWelcome = [...recent, { spans: [] }, ...quickTasks];

  if (!input.branding.showLargeLogo) return [boxWelcome, legacyWelcome, [invitation]];
  return [
    [
      ...input.branding.largeLines.map((value) => ({ spans: [span(value, "muted")] })),
      { spans: [] },
      ...boxWelcome,
    ],
    boxWelcome,
    [
      { spans: [span(`${input.branding.compactMark} ${ROUTE_CORE_WORDMARK} ${input.branding.version}`, "muted")] },
      ...legacyWelcome,
    ],
    [invitation],
  ];
}
