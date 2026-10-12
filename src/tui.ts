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
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import {
  readPackageVersion,
  routeCoreCompact,
  routeCoreLarge,
  resolveGlyphMode,
  type GlyphEnvironment,
} from "./branding.js";
import {
  COMMAND_CATALOG,
  COMMAND_TREE,
  flattenCommandTree,
  resolveSlashCommand,
  type SlashCommandHandlerId,
} from "./command-catalog.js";
import { DEFAULT_APPEARANCE, type AppearanceConfig } from "./config.js";
import type {
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "./settings-controller.js";
import type { SettingsSurface } from "./settings-session.js";
import { settingsCategoryLabel } from "./settings-registry.js";
import type { AgentRunEvent, ChatTurn, ModelInfo, ToolCallPreview } from "./types.js";
import { ProcessEventRedactor } from "./redaction.js";
import type { ImageAttachment } from "./attachments.js";
import type { RouteIdentityV1 } from "./backends.js";
import {
  sameCanonicalModelRoute,
  type ModelRouteCatalogPort,
  type ModelRoutePickerPort,
  type PublicModelRoutePickerPort,
  type SelectableModelRoute,
} from "./model-route-catalog.js";
import type { RoutePickerAuthority } from "./route-picker.js";
import type { PanelJudgment, PanelResult } from "./panel.js";
import { approvalRiskLabel } from "./approval.js";
import { TAIL, isHubTranscript, type ChatBlock, type Viewport } from "./ui/blocks.js";
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
import {
  buildListEmptyLine,
  filterListEntries,
  interpretListKey,
  isListEntryDisabled,
  LIST_MULTI_SELECT_CAP,
  LIST_PAGE_STEP,
  stepListIndex,
  stepSelectableListIndex,
  toggleListMultiSelect,
} from "./ui/list-core.js";
import { renderBlock } from "./ui/render-block.js";
import {
  MAX_CONTENT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  type Frame,
} from "./ui/render-frame.js";
import { buildSettingsFrame } from "./ui/settings-frame.js";
import { holdTerminal, releaseTerminal, type TerminalHandover } from "./ui/terminal-lease.js";
import { createTheme, type Theme } from "./ui/theme.js";
import { plainText } from "./ui/spans.js";
import { listActionChips } from "./ui/keymap.js";
import { actionBarLine, crumbText } from "./ui/zones.js";
import { RunViewModel } from "./ui/view-model.js";
import {
  commandMenuEnterVerb,
  projectCommandMenu,
  resolveCommandMenuRows,
  type CommandMenuProjection,
  type CommandMenuState,
} from "./ui/command-menu.js";
import { formatModelRouteDetail, runOutcomeLabel, type RunEndOutcome } from "./utils.js";

export {
  buildDashboardFrame,
  shortModelName,
  type DashboardFrameInput,
  type DashboardState,
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
/**
 * Audit FIX-1 (2026-08-28): the Shift+Tab approval-mode cycle, in the order
 * Claude-Code-trained fingers expect — ask → auto-edit → read-only → ask.
 * allow-all is DELIBERATELY absent from this cycle: it stays exclusively
 * behind /allow's explicit danger confirm ("Enable allow-all?"), because a
 * single reflexive keypress must never be able to arm unattended file
 * changes and shell commands. From allow-all, Shift+Tab therefore LEAVES
 * toward "ask" (the safe direction); it can never enter allow-all.
 */
const SHIFT_TAB_APPROVAL_CYCLE = ["ask", "auto-edit", "read-only"] as const;
export type CycledApprovalMode = (typeof SHIFT_TAB_APPROVAL_CYCLE)[number];
/**
 * FIX-11 addendum (rendered truth): the choice picker's title belongs on
 * exactly one line — the muted heading directly above the rows
 * (`#listView`'s `heading`, rendered by `dashboard-frame.ts`'s
 * `listChrome`). Entering the mode used to ALSO push that same title into
 * `#status`, where the status line reprinted it verbatim right above the
 * filter row: every gate and picker rendered its own name twice, one line
 * apart. The picker claims no status text of its own now, so that line
 * falls through to the always-on identity chrome and the filter row below
 * it carries only the `❯` prompt.
 */
const CHOICE_PICKER_STATUS = "";
/**
 * The neutral start hub's fixed quick-action row (Controller ruling 1, D8):
 * New chat · All chats · Folder · Settings, in this order — the human-
 * readable label is the hub's own copy, not the shared catalog description
 * (the mockup's wording differs from what `/help` and the command menu show
 * for the same commands), while `command` is the real slash command typed
 * into the composer and submitted, exactly as the owner typing it out and
 * pressing Enter would (`#runQuickAction` below). The single "Continue"
 * quick action this row superseded — and its hint plumbing — is gone; the
 * "Recent" section (`workbench.ts`) covers that need now. Still checked
 * against `COMMAND_TREE` below so a renamed or removed command fails loudly
 * instead of silently offering a dead shortcut.
 */
// `hint` stays a function (none of these four currently need the theme,
// unlike the pre-D8 `/model` hint's em dash) so a future entry can reach
// `theme.glyph` for ASCII parity (F6) without changing this shape again.
// Exported since FIX-8 so an end-to-end test can dispatch the exact command
// a row submits, instead of re-typing the literal and drifting from it.
export const WORKBENCH_QUICK_ACTIONS = [
  { label: "New chat", command: "/new", hint: () => "Start a separate chat in this folder" },
  { label: "All chats", command: "/chats", hint: () => "Choose from every chat, every folder" },
  { label: "Folder", command: "/folder", hint: () => "Change or create the folder orcode works in" },
  { label: "Settings", command: "/settings", hint: () => "Models, accounts, approvals & costs" },
] as const;
/**
 * FIX-17 (fresh-launch audit, controller-ruled): provider setup is a calm,
 * prominent hub affordance instead of the removed unsolicited launch modal.
 * While `DashboardState.providerSetupNeeded` is true this row LEADS the
 * fixed quick actions — the first selectable action a fresh owner meets —
 * and Enter runs the real `/provider setup` command through the exact same
 * dispatch path typing it would use (the same hint the non-interactive
 * failure already names). Copy per the controller's ruling, in the D8 hub
 * label+hint grammar.
 */
const WORKBENCH_SETUP_ACTION = {
  label: "Set up a provider",
  command: "/provider setup",
  hint: () => "Connects OpenRouter or Kimi",
} as const;
// `resolveSlashCommand` (not `flattenCommandTree`, which only flattens leaf
// commands under their canonical path) also accepts a branch's own alias —
// `/chats` resolves via the `chat` command's own alias, exactly like a real
// typed command would. Checked once at module load so a renamed or removed
// command fails loudly instead of silently offering a dead shortcut.
for (const { command } of [...WORKBENCH_QUICK_ACTIONS, WORKBENCH_SETUP_ACTION]) {
  if (!resolveSlashCommand(command)) {
    throw new Error(`Workbench command missing from COMMAND_TREE: ${command}`);
  }
}
const TERMINAL_PROCESS_CAPACITY = 512;
const MAX_MOUSE_SEQUENCE_LENGTH = 32;
const MAX_SETTINGS_SEARCH_CODEPOINTS = 120;
const MAX_BUFFERED_SETTINGS_INPUTS = 128;
/**
 * FIX-19 finding 7: how much typeahead is held while the composer does not
 * exist yet. Generous enough for a real sentence typed into the startup
 * screen, small enough that a held key or a stray paste cannot grow it
 * without limit — and anything past it is reported, never dropped in
 * silence.
 */
const MAX_TYPEAHEAD_CODEPOINTS = 2_000;
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
  malformed: boolean;
  click: { readonly column: number; readonly row: number } | null;
  passthroughSuffix: boolean;
  readonly surface: UiSurface;
  readonly mode: UiMode;
}

export interface ChoicePickerItem {
  value: string;
  label: string;
  description: string;
  /** See `ListEntry.descriptionParts` (ui/list-core.ts) — indivisible description parts, shed whole. */
  descriptionParts?: readonly string[];
  /**
   * A non-selectable divider row introducing a section (workspace-mobility
   * Phase F1b's sectioned `/chats` picker — "current folder" then "Other
   * folders"). Navigation skips it (`stepSelectableListIndex`) and Enter is
   * a no-op on it (`isListEntryDisabled`); `value` is never read for one.
   */
  sectionHeading?: boolean;
}

export type UiSurface = "chat" | "settings";

export type TerminalThemeFactory = (options: { readonly ascii: boolean }) => Theme;

export type SettingsModelEditorRequest = Omit<SettingsEditorRequest, "editor"> & {
  readonly editor: Extract<SettingsEditorRequest["editor"], { readonly kind: "model" }>;
};

/**
 * What the `validated-input` mode itself actually consumes — the label and
 * description it renders, plus the descriptor `#submitValidatedEditor`
 * validates against. A settings `SettingsEditorRequest` satisfies this
 * structurally (`edit()` hands one straight through, unchanged), and so
 * does `readPath` below, whose prompt has no settings item behind it at all
 * and therefore no `SettingsActionId` to name. Deliberately a structural
 * subset rather than `SettingsEditorRequest`, so opening this one mode from
 * a slash command does not require inventing a fake settings item.
 */
interface ValidatedInputRequest {
  readonly label: string;
  readonly description: string;
  readonly editor:
    | SettingsEditorRequest["editor"]
    | { readonly kind: "text"; readonly valueKind: "path" };
}

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
  readonly commandMenuRuntime?: () => ReadonlyMap<SlashCommandHandlerId, { readonly current?: string; readonly disabledReason?: string }>;
}

export class UiExitError extends Error {
  constructor() {
    super("orcode was closed.");
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

function sameModelRouteOwner(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm;
}

/**
 * The `<provider> · <price> · <ctx>` detail line for one route row (Phase
 * F3, information-dense pickers, honesty ruling): `formatModelRouteDetail`
 * (`utils.ts`) owns the actual composition and the "never fabricate a
 * price" rule; this only maps `RuntimeModelPrice`'s `"unknown"` variant
 * (provider-managed routes — Kimi & friends have no meterable per-token
 * price) onto the shared `"subscription"` label.
 */
function routeDetailLine(candidate: SelectableModelRoute): string {
  if (candidate.model.price.kind === "unknown") {
    return `${oneLine(candidate.providerLabel)} · Kosten unbekannt · ${candidate.model.contextLength.toLocaleString("de-DE")} ctx`;
  }
  return formatModelRouteDetail({
    providerLabel: oneLine(candidate.providerLabel),
    price: candidate.model.price,
    contextLength: candidate.model.contextLength,
  });
}

export function createTerminalPublicRoutePicker(
  ui: Pick<TerminalUi, "pickChoice">,
): PublicModelRoutePickerPort {
  return Object.freeze({
    async pickModelRoute(input: Parameters<PublicModelRoutePickerPort["pickModelRoute"]>[0]) {
      const keyed = input.view.candidates.map((candidate) => ({ key: candidate.handle, candidate }));
      const selected = await ui.pickChoice(
        input.title,
        keyed.map(({ key, candidate }) => ({
          value: key,
          label: `${oneLine(candidate.accountLabel)} · ${oneLine(candidate.displayName)}`,
          description: `${oneLine(candidate.cost.label)} · ${oneLine(candidate.dataPolicy.label)}`,
          ...(candidate.disabled ? { disabled: oneLine(candidate.disabled.label) } : {}),
        })),
        input.currentHandle ?? "",
        input.currentHandle ?? "",
      );
      if (!selected) return null;
      const row = keyed.find(({ key }) => key === selected.value)?.candidate;
      if (!row || !row.runnable || row.disabled) return null;
      return { handle: row.handle, revision: input.view.revision, generation: input.view.generation };
    },
  });
}

/**
 * One fullscreen route picker: local filtering only, no Inquirer and no
 * mutation seam.
 *
 * F1b: `readCrossRoleRoute` is the runtime-side half of the Cross exclusion.
 * A caller that holds the pair itself (the Cross gate) keeps passing
 * `exclude`; a caller that must not hold it (Settings, whose snapshot carries
 * model ids only) passes `excludeCrossRole`, and the identity needed for the
 * comparison — `sameCanonicalModelRoute` reads `accountFingerprint` and
 * `billingRealm`, and the catalog really can offer one canonical model on two
 * accounts — is fetched here, never through Settings.
 */
export function createTerminalModelRoutePicker(
  ui: Pick<TerminalUi, "pickChoice">,
  catalog: ModelRouteCatalogPort,
  readCurrent: () => RouteIdentityV1 | null = () => null,
  readCrossRoleRoute: (role: "lead" | "challenger") => RouteIdentityV1 | null = () => null,
): ModelRoutePickerPort {
  return Object.freeze({
    async pickModelRoute(input: Parameters<ModelRoutePickerPort["pickModelRoute"]>[0]) {
      const current = input.current ?? readCurrent();
      const exclude = input.exclude
        ?? (input.excludeCrossRole ? readCrossRoleRoute(input.excludeCrossRole) : null);
      const catalogRows = await catalog.listSelectableModelRoutes("");
      const rows = catalogRows.filter((candidate) => {
        if (exclude && sameCanonicalModelRoute(candidate.route, exclude)) return false;
        return input.role !== "compressor"
          || (current !== null && sameModelRouteOwner(candidate.route, current));
      });
      const keyed = rows.map((candidate, index) => ({
        key: `model-route:${index}`,
        candidate,
      }));
      const currentModelId = input.currentModelId ?? current?.requestedModelId ?? null;
      const roleSpecificKey = currentModelId === null || current === null
        ? ""
        : keyed.find(({ candidate }) =>
            sameModelRouteOwner(candidate.route, current)
            && candidate.route.requestedModelId === currentModelId)?.key ?? "";
      const currentKey = roleSpecificKey || (keyed.find(({ candidate }) =>
        current !== null && sameCanonicalModelRoute(candidate.route, current))?.key ?? "");
      const selected = await ui.pickChoice(
        input.title,
        keyed.map(({ key, candidate }) => ({
          value: key,
          label: `${oneLine(candidate.providerLabel)} · ${oneLine(candidate.model.name)}`,
          description: routeDetailLine(candidate),
        })),
        currentKey,
        currentKey || keyed[0]?.key || "",
      );
      if (!selected) return null;
      return keyed.find(({ key }) => key === selected.value)?.candidate ?? null;
    },
  });
}

function settingsSearchChars(value: string): string[] {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, "")]
    .slice(0, MAX_SETTINGS_SEARCH_CODEPOINTS);
}

/**
 * Display label for a run-end outcome. Exported so cli.ts says the same thing.
 *
 * The wording itself moved to `utils.ts` (G2): the desktop window renders the
 * same line and imports it from there, and `utils.ts` is the one module with
 * no imports of its own, so it can be shared with a surface that has no Node
 * underneath it. This re-export keeps every existing caller unchanged.
 */
export { runOutcomeLabel };

/**
 * The compile-time proof that moving the wording did not split the type.
 *
 * `utils.ts` spells the six outcomes out by hand (it may not import
 * `types.ts`), so this asserts that the CORE's own `run-end` union is
 * exactly what that function accepts. Widen `AgentRunEvent` without widening
 * `RunEndOutcome` and this line fails to compile.
 */
const _runOutcomeUnionsAgree: (
  outcome: Extract<AgentRunEvent, { type: "run-end" }>["outcome"],
) => RunEndOutcome = (outcome) => outcome;
void _runOutcomeUnionsAgree;

function lineCount(value: string): number {
  return value ? value.split(/\r\n?|\n/).length : 1;
}

function isPrintableKeypressText(value: string): boolean {
  if (!value) return false;
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20
      && codePoint !== 0x7f
      && !(codePoint >= 0x80 && codePoint <= 0x9f);
  });
}

function isFunctionKey(name?: string): boolean {
  return /^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(name ?? "");
}

function slashCommandToken(input: string): string {
  return input.startsWith("/")
    ? input.slice(1).trimStart().replace(/\s+/g, " ").toLowerCase()
    : "";
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
  // D8d: read once at construction, not on every frame — `readPackageVersion`
  // hits the filesystem, and the version cannot change mid-process anyway.
  readonly #version: string = readPackageVersion();
  readonly #settingsEditorResolver: SettingsEditorResolver | null;
  #modelRoutePicker: ModelRoutePickerPort | null = null;
  #publicModelRoutePicker: {
    picker: PublicModelRoutePickerPort;
    authority: Pick<RoutePickerAuthority, "view">;
  } | null = null;
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
  #editorChars: string[] = [];
  #editorCursor = 0;
  #editorRequest: ValidatedInputRequest | null = null;
  #editorResolve: ((result: SettingsEditorResult) => void) | null = null;
  #editorValidationMessage = "";
  #returnSurface: UiSurface | null = null;
  #returnMode: UiMode | null = null;
  #settingsChatStatus: { readonly value: string; readonly at: number } | null = null;
  #closingSettings = false;
  #inputChars: string[] = [];
  /** FIX-19 finding 7: keystrokes held while the composer does not exist yet, replayed into it by `readInput`. */
  #typeahead: string[] = [];
  /** True when the hold above hit its cap and something really was lost — said out loud, never swallowed silently. */
  #typeaheadDropped = false;
  #crossCommandDraft: { chars: string[]; cursor: number } | null = null;
  #composerDraftRestore: { chars: string[]; cursor: number } | null = null;
  #cursor = 0;
  #status = "Ready";
  #statusAt = 0;
  /**
   * J2 finding 1: the last transient notice the status channel itself wrote
   * (`setStatus(…, busy=false)`) — the channel `/new`'s "New chat started.",
   * `/chats`' "Chat opened: <title>" and the "Cross is already running"
   * warning all speak through. Held so `#composerStatus` can let it survive
   * `readInput`'s own generic "Ready" default (see there for the race).
   *
   * Self-invalidating on purpose, with no bookkeeping at the other writers:
   * every write to `#status` also moves `#statusAt`, so the identity check
   * in `#composerStatus` refuses to carry a notice that a mode entry, a run
   * phase or a cancel has since replaced. Carrying it into the composer is
   * itself such a write, which is what makes a notice show exactly once.
   */
  #statusNotice: { readonly value: string; readonly at: number } | null = null;
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
  /**
   * D4 controller decision: ONE confirm-mode implementation, danger-graded.
   * `danger` keeps the safe `Enter`-declines default (only `y` accepts) and
   * states so in the footer; `ordinary` accepts on `Enter`/`y`. Set fresh
   * every time confirm mode is entered — from `confirmAction`'s own
   * `danger` option for the approval-style path, from the settings item's
   * own `destructive` flag for the settings-editor confirm sub-branch (the
   * audit's sharpest exemplar: both branches used to hardcode opposite,
   * undocumented key tables instead of sharing this one flag).
   */
  #confirmDanger = false;
  /**
   * FIX-14 fix round 1 (review M2, controller ruling): the KEY grammar,
   * separate from the CLASS. `#confirmDanger` grades presentation (the warn
   * title, the `a`/`d` extras); this grades only "may Enter accept?".
   *
   * D4 has three states, not two. Danger is Enter-declines AND destructive
   * presentation. Ordinary is Enter-accepts. `confirmPlain`'s
   * `defaultAccept: false` is the third — ordinary in class, but the action
   * deserves an explicit yes (spending real money across every panel model;
   * keeping an unpersisted key) — and the fullscreen surface had no way to
   * say it, so FIX-14's first pass mapped it onto the danger class outright
   * and gave two ordinary confirms a danger title and a dead `g reason`.
   * A separate flag gives that third state its honest rendering without
   * inventing a third key grammar for anyone to learn.
   */
  #confirmEnterDeclines = false;
  /**
   * FIX-14 fix round 1 (review M2.2): whether `g` (reason capture) is
   * genuinely bound. `#confirmResolve !== null` — the old signal — is true
   * for EVERY `confirmAction`, including command confirms whose caller
   * (`CommandContext.confirm`) reads `.accepted` and throws the typed
   * reason away. Only `confirmApproval` feeds a decision whose `reason`
   * reaches anything (`PermissionDeniedError`, and through it the model),
   * so only it sets this.
   */
  #confirmReasonBound = false;
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
  /**
   * V4-A zone 1: the model picker's own screen name, for its title bar.
   *
   * It always HAD a name — every caller passes one — but the name went only
   * into `#status`, where it lived for `STATUS_FRESH_MS` and then vanished,
   * leaving the busiest list in the product with no answer at all to "where
   * am I". The choice picker's `#choiceTitle` (added by Task 7 for exactly
   * this reason) is the precedent; this is the same field for the other
   * picker, and both now feed the one title bar.
   */
  #pickerTitle = "";
  #pickerMultiple = false;
  readonly #pickerSelected = new Set<string>();
  #choiceAll: ChoicePickerItem[] = [];
  #choiceItems: ChoicePickerItem[] = [];
  #choiceResolve: ((choice: ChoicePickerItem | null) => void) | null = null;
  #choiceCurrent = "";
  #choiceInitial = "";
  /**
   * Task 7 (composition gap report): a persistent heading for the picker's
   * `ListView`, instead of the old `Choose <title>` status text that only
   * lived for `STATUS_FRESH_MS` before going blank.
   */
  #choiceTitle = "";
  /**
   * V4-B (concern 5 of the V4-A report): what the row being edited says
   * right now — the settings row's OWN `displayValue`, not a second
   * formatting of the same config.
   *
   * The mockup's edit state opens with `Aktuell: qwen3.8-max` above the
   * choices, and it is the one fact a picker cannot otherwise show: the `·
   * active` tag only marks the current row while that row happens to be
   * inside the window. Set only by `edit()`, so `readPath`'s reuse of the
   * same validated-input mode (which has no settings row behind it) shows
   * nothing.
   */
  #editorCurrentValue = "";
  /**
   * V4-B: the open settings editor's crumb, for the modes that render it
   * themselves (`validated-input`'s prompt block). Empty for `readPath`,
   * which borrows the same mode from the chat surface and has no settings
   * row — and therefore no path — behind it.
   */
  #editorCrumb = "";
  #selectedIndex = 0;
  #commandMenu: CommandMenuState | null = null;
  #commandMenuDraft: { readonly chars: string[]; readonly cursor: number } | null = null;
  #dismissedCommandMenuInput: string | null = null;
  #suggestedReplies: string[] = [];
  #suggestedReplyIndex = 0;
  /**
   * V3 interaction ruling: index into the start workbench's quick-action
   * list once ↓ has moved a visible `❯` selection into it from the empty
   * composer; `null` means the composer itself has focus. Reset to `null`
   * on any mode change away from "input" (see `#enterMode`), on Esc, and
   * on typing a printable character.
   */
  #quickActionIndex: number | null = null;
  /**
   * FIX-17 (finding 2): the armed row's stable identity
   * (`#workbenchRowKey`), kept in lockstep with `#quickActionIndex` —
   * non-null exactly while the index is. `#syncQuickActionSelection` uses
   * it to follow the logical row when the list shifts under the selection.
   */
  #quickActionRowKey: string | null = null;
  /**
   * One-shot: the chat id Enter just picked from the hub's "Recent" section
   * (Controller ruling 2/3, D8, generalizing the old single-slot "Continue"
   * armed flag to up to 4 rows); consumed by `consumeQuickActionChat()`.
   * `null` when Enter instead ran one of the fixed quick actions (or
   * nothing was selected at all).
   */
  #quickActionChatPick: string | null = null;
  #attachments: ImageAttachment[] = [];
  #pasting = false;
  #pasteBuffer = "";
  #secretLabel = "";
  /** FIX-18 (Esc depth): per-call override for the secret footer's Esc hint. */
  #secretEscHint: string | null = null;
  #secretResolve: ((value: string | null) => void) | null = null;
  #recordingResolve: ((action: "stop" | "cancel") => void) | null = null;
  #cancelHandler: (() => void) | null = null;
  #cancelRequestedAt = 0;
  // Audit FIX-1 (2026-08-28): the idle prompt's two-press Ctrl+C window.
  // Non-zero after a first Ctrl+C at the idle prompt; only a second press
  // while the "Ctrl+C again closes orcode" hint is still fresh
  // (STATUS_FRESH_MS) actually closes orcode. Any other key disarms it.
  #exitArmedAt = 0;
  // Phase 3b, Part B: while set, busy-mode submissions feed the running task
  // (interjections) instead of `#queuedInputs`'s next-run fallback.
  #interjectHandler: ((text: string) => void) | null = null;
  // Phase 3b, Part C: while set, `esc` during live reasoning ends only the
  // thinking step instead of falling through to `#requestCancel()`.
  #endThinkingHandler: (() => void) | null = null;
  // Audit FIX-1: while set, Shift+Tab cycles the approval mode through this
  // sink (which persists exactly the way /allow does). Never registered by
  // callers that have no /allow persistence — the key stays inert there.
  #approvalModeHandler: ((mode: CycledApprovalMode) => void) | null = null;
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
  readonly #commandMenuRuntimeOverride: TerminalUiOptions["commandMenuRuntime"];

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
    this.#commandMenuRuntimeOverride = options.commandMenuRuntime;
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

  setModelRoutePicker(picker: ModelRoutePickerPort | null): void {
    this.#modelRoutePicker = picker;
  }

  setPublicModelRoutePicker(
    picker: PublicModelRoutePickerPort,
    authority: Pick<RoutePickerAuthority, "view">,
  ): void {
    this.#publicModelRoutePicker = { picker, authority };
  }

  /**
   * One-shot bridge from the command palette into a bare draft-taking
   * command's preflight — `/cross`'s gate and (Phase 14) `/architect`'s
   * planner both read exactly this. One slot, one capture site pair, so the
   * two surfaces cannot drift apart.
   */
  consumeCrossCommandDraft(): string {
    const draft = this.#crossCommandDraft;
    this.#crossCommandDraft = null;
    if (draft) {
      this.#composerDraftRestore = { chars: [...draft.chars], cursor: draft.cursor };
    }
    return draft?.chars.join("") ?? "";
  }

  /**
   * Restores the exact chars and logical cursor captured before palette
   * selection, or — FIX-20, finding 6 — the gate's own pending task text
   * when there was no captured composer draft to begin with.
   *
   * `/cross run <task>` carries its task as a command ARGUMENT: nothing was
   * ever captured from the composer, so Esc used to drop the typed task on
   * the floor with no way to get it back. `fallback` is what the abandoned
   * gate visit was holding; it only lands in an EMPTY composer, so it can
   * never overwrite something typed while the gate was open.
   */
  restoreCrossCommandDraft(fallback = ""): void {
    const draft = this.#composerDraftRestore;
    this.#composerDraftRestore = null;
    if (draft) {
      this.#inputChars = [...draft.chars];
      this.#cursor = clamp(draft.cursor, 0, this.#inputChars.length);
      this.scheduleRender(true);
      return;
    }
    if (!fallback || this.#inputChars.length > 0) return;
    this.#inputChars = Array.from(fallback);
    this.#cursor = this.#inputChars.length;
    this.scheduleRender(true);
  }

  /** A started Cross run consumes the palette draft permanently. */
  discardCrossCommandDraft(): void {
    this.#crossCommandDraft = null;
    this.#composerDraftRestore = null;
  }

  begin(view: SettingsViewModel): void {
    this.#requireActive();
    if (this.#settingsIntentResolve || this.#settingsIntentReject) {
      throw new Error("Settings is already waiting for an input.");
    }
    if (this.#surface !== "settings") {
      this.#settingsChatStatus = { value: this.#status, at: this.#statusAt };
    }
    this.#surface = "settings";
    this.#settingsView = view;
    this.#clearSettingsInputQueue();
    this.#settingsSearchChars = settingsSearchChars(view.search.query);
    this.#settingsSearchCursor = this.#settingsSearchChars.length;
    this.#syncMouseReporting();
    this.scheduleRender(true);
  }

  nextIntent(view: SettingsViewModel): Promise<SettingsIntent> {
    if (this.#surface !== "settings" || this.#settingsView === null) {
      return Promise.reject(new Error("Settings is not open."));
    }
    if (this.#settingsIntentResolve || this.#settingsIntentReject) {
      const error = new Error("Only one settings input may be pending at a time.");
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

    if (
      request.editor.kind === "model"
      && request.editor.multiple !== true
      && (
        request.editor.actionId === "main-model"
        || request.editor.actionId === "compressor-model"
        || request.editor.actionId === "cross-lead-model"
        || request.editor.actionId === "cross-challenger-model"
        || request.editor.actionId === "architect-executor-model"
      )
      && (this.#publicModelRoutePicker || this.#modelRoutePicker)
    ) {
      const role = request.editor.actionId === "main-model"
        ? "main"
        : request.editor.actionId === "compressor-model"
          ? "compressor"
          : request.editor.actionId === "cross-lead-model"
            ? "lead"
            : request.editor.actionId === "cross-challenger-model"
              ? "challenger"
              : "executor";
      if (this.#publicModelRoutePicker) {
        const { picker, authority } = this.#publicModelRoutePicker;
        const pickerRequest = { role } as const;
        const view = authority.view(pickerRequest);
        return picker.pickModelRoute({ request: pickerRequest, view, title: request.label })
          .then((selection): SettingsEditorResult => selection
            ? { kind: "value", value: { kind: "model-route", selection } }
            : { kind: "cancel" });
      }
      return Promise.resolve({ kind: "cancel" });
    }

    this.#returnSurface = this.#surface;
    this.#returnMode = this.#mode;
    this.#surface = "chat";
    this.#editorRequest = request;
    this.#editorValidationMessage = oneLine(request.validationMessage ?? "");
    this.#setEditorValue(request.initialValue);
    // V4-B (V4-A concern 5): the crumb GROWS. `Settings › Models` becomes
    // `Settings › Models › Main model` for as long as the editor is open, so
    // the reader can see how deep they are and that one Esc is one level —
    // the mockup's "Beim Editieren wächst die Brotkrume mit". This replaces
    // `Choose <label>`, which named the same row but said nothing about where
    // it lives, and read as a broken sentence for half its callers.
    const crumb = this.#settingsCrumb(request);
    // The row's own current value, for the editors that CHANGE a value. A
    // confirm asks a yes/no question about an action (D4's grammar, out of
    // this lane's bounds) and an invoke runs one — neither has a value to
    // state, and neither grows a crumb line it never had.
    const current = this.#settingsCurrentValue(request);

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
          this.#choiceTitle = crumb;
          this.#editorCurrentValue = current;
          this.#resetEditor();
          this.#refreshChoices();
          this.#enterMode("choice-picker", CHOICE_PICKER_STATUS);
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
          this.#pickerTitle = crumb;
          this.#editorCurrentValue = current;
          this.#resetEditor();
          try {
            this.#refreshPicker();
          } catch {
            this.#resolveSettingsEditor({ kind: "cancel" });
            break;
          }
          this.#enterMode("model-picker", this.#pickerTitle);
          break;
        }
        case "number":
        case "text":
          this.#editorCurrentValue = current;
          this.#editorCrumb = crumb;
          this.#enterMode("validated-input", crumb);
          break;
        case "confirm":
          this.#confirmSince = Date.now();
          this.#confirmRememberAvailable = false;
          // D4: the settings item's own `destructive` flag IS the danger
          // grading for this sub-branch. Concretely: "Enable allow-all?"
          // reached from here now declines on Enter exactly like the same
          // question reached via `/allow allow-all` already did (both are
          // now the same `confirmAction`-style danger grammar); the other
          // destructive confirms here (forgetting an approval rule,
          // clearing verify commands, clearing voice consent) had no
          // command-driven counterpart to diverge from, but get the same
          // safe-by-default treatment on the same reasoning.
          this.#confirmDanger = descriptor.destructive === true;
          // This mechanism has only the two classes; its key grammar has
          // always followed them exactly.
          this.#confirmEnterDeclines = descriptor.destructive === true;
          this.#confirmReasonBound = false;
          this.#enterMode("confirm", "Confirm settings action");
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

  /**
   * Phase 7 (E-VIS-02): before this, an intent that reached a slow external
   * action (provider activation, a config save under the write lock) left
   * the settings frame sitting exactly as it was — no different from a
   * frozen terminal — until the real outcome replaced it. This overrides
   * the notice line in place, in the exact slot success/error notices
   * already use; the very next `nextIntent(view)` call (right after
   * `dispatch`/`completeEditor` settle) replaces `#settingsView` wholesale
   * with the controller's real view, so there is nothing to clear on the
   * way out.
   */
  setBusy(active: boolean): void {
    if (!active || this.#surface !== "settings" || !this.#settingsView) return;
    this.#settingsView = {
      ...this.#settingsView,
      notice: { kind: "busy", message: "Running …" },
    };
    this.scheduleRender(true);
  }

  /** Settings setup bridge: never writes an event into the chat transcript. */
  showSettingsNotice(message: string): void {
    this.#settingsChatStatus = { value: oneLine(message), at: Date.now() };
    this.scheduleRender(true);
  }

  /** Restores the Settings frame after a nested picker/secret/confirmation. */
  restoreSettings(): void {
    if (this.#settingsView) {
      this.#surface = "settings";
      this.#syncMouseReporting();
      this.scheduleRender(true);
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
      this.#run.phase = "Model streaming response";
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
    this.setStatus("Ready", false);
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
    this.#status = oneLine(status) || "Ready";
    this.#statusAt = Date.now();
    // J2 finding 1: only a NON-busy write is a notice addressed to the
    // person at the terminal; a busy write is a run's own phase text, which
    // belongs to the run and must never outlive it into an idle composer.
    this.#statusNotice = busy ? null : { value: this.#status, at: this.#statusAt };
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

  /**
   * The picked chat's id exactly once, right after Enter activates one of
   * the hub's "Recent" rows via the ↓/↑ selection (V3 interaction ruling,
   * generalized from the single-slot "Continue" quick action to up to 4
   * rows — Controller ruling 2/3, D8). The caller (the dashboard loop)
   * checks this before treating a resolved empty `readInput()` value as
   * "open this chat" — a bare Enter with nothing selected must stay a
   * no-op, unlike the composition round's "Continue" shortcut this
   * supersedes. `undefined` when Enter instead ran a fixed quick action, or
   * when nothing was selected at all.
   */
  consumeQuickActionChat(): string | undefined {
    const picked = this.#quickActionChatPick;
    this.#quickActionChatPick = null;
    return picked ?? undefined;
  }

  setCancelHandler(handler?: () => void): void {
    this.#cancelHandler = handler ?? null;
    this.#cancelRequestedAt = 0;
  }

  /**
   * Registers the running task's interjection sink (Phase 3b, Part B). While
   * set, text submitted during a run feeds the running task instead of
   * `#queuedInputs`'s next-run fallback. Call with no argument when the run
   * ends, mirroring `setCancelHandler`.
   */
  setInterjectHandler(handler?: (text: string) => void): void {
    this.#interjectHandler = handler ?? null;
  }

  /**
   * Registers the "end thinking" sink for `esc` pressed while reasoning
   * streams live (Phase 3b, Part C). Call with no argument when the run ends.
   */
  setEndThinkingHandler(handler?: () => void): void {
    this.#endThinkingHandler = handler ?? null;
  }

  /**
   * Registers the Shift+Tab approval-mode sink (audit FIX-1). The handler
   * must persist the change through the SAME path /allow uses
   * (`context.approvals.mode` + `config.approvalMode` + `saveConfig`) — one
   * mechanism, never a second store. The TUI itself only picks the next
   * mode from `SHIFT_TAB_APPROVAL_CYCLE` (allow-all excluded by design)
   * and announces it. Call with no argument to unregister, mirroring
   * `setCancelHandler`.
   */
  setApprovalModeHandler(handler?: (mode: CycledApprovalMode) => void): void {
    this.#approvalModeHandler = handler ?? null;
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
        phase: "Preparing run",
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
    title = "Choose a model",
  ): Promise<ModelInfo | null> {
    this.#requireActive();
    this.#captureSettingsReturn();
    this.#pickerSearch = searchModels;
    this.#pickerCurrent = currentModel;
    this.#pickerTitle = oneLine(title) || "Choose a model";
    this.#resetEditor();
    this.#refreshPicker();
    this.#enterMode("model-picker", this.#pickerTitle);
    return new Promise<ModelInfo | null>((resolve) => {
      this.#pickerResolve = resolve;
    });
  }

  /**
   * FIX-11 (rendered truth): `title` is the picker's heading verbatim.
   * This used to prefix a fixed `Choose ` onto whatever it was handed,
   * which turned every caller's own screen name into a broken sentence —
   * `Choose Provider setup`, `Choose Chats · routercode`, `Choose Cross ·
   * Start`, `Choose Approval mode`. Callers name their screen; the picker
   * renders that name, exactly as the plain surface's `pickFromListPlain`
   * already does with the very same strings.
   */
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
    this.#choiceTitle = oneLine(title);
    this.#resetEditor();
    this.#refreshChoices();
    this.#enterMode("choice-picker", CHOICE_PICKER_STATUS);
    return new Promise<ChoicePickerItem | null>((resolve) => {
      this.#choiceResolve = resolve;
    });
  }

  readSecret(label: string, options?: { escHint?: string }): Promise<string | null> {
    this.#requireActive();
    this.#captureSettingsReturn();
    this.#secretLabel = oneLine(label);
    // FIX-18 (Esc depth): the setup flow's key stage goes BACK one level on
    // Escape, so its hint says "Esc back"; every other secret prompt keeps
    // the default full-cancel hint.
    this.#secretEscHint = options?.escHint ?? null;
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#retireMouseProtocol();
    this.#resetEditor();
    this.#enterMode("secret", `Enter ${this.#secretLabel}`);
    return new Promise<string | null>((resolve) => {
      this.#secretResolve = resolve;
    });
  }

  /**
   * FIX-8 (keyboard audit K7/F2.2): the chat surface's own path question,
   * which bare `/folder` asks. Deliberately the SAME `validated-input`
   * machinery a settings `valueKind: "path"` item already uses — the same
   * editor buffer, the same `label`/`description` prompt block, the same
   * `Enter apply · Esc cancel` footer, the same `#submitValidatedEditor`
   * trim-and-length validation, the same `#resolveSettingsEditor` teardown
   * — rather than a second text-input mode. `edit()` above is settings-only
   * by construction (it needs an open settings view), so this is the one
   * seam that opens that mode from a slash command.
   *
   * Resolves the validated value, or `null` whenever the owner did not
   * answer: Esc, Ctrl+C (`#interrupt`), or a shutdown that settles pending
   * prompts (`#settlePendingForStop`) — every one of which routes through
   * `{ kind: "cancel" }`, so a cancel can never be mistaken for a value.
   */
  readPath(request: { readonly label: string; readonly description: string }): Promise<string | null> {
    if (!this.#active || this.#editorResolve || this.#returnSurface) {
      return Promise.resolve(null);
    }
    this.#returnSurface = this.#surface;
    this.#returnMode = this.#mode;
    this.#surface = "chat";
    this.#editorRequest = {
      label: request.label,
      description: request.description,
      editor: { kind: "text", valueKind: "path" },
    };
    this.#editorValidationMessage = "";
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#resetEditor();
    return new Promise<SettingsEditorResult>((resolve) => {
      this.#editorResolve = resolve;
      // The footer (`helpText`, dashboard-frame.ts) already states
      // `Enter apply · Esc cancel` for this mode — the status line only
      // names what is being asked for.
      this.#enterMode("validated-input", oneLine(request.label));
    }).then((result) => (
      result.kind === "value" && typeof result.value === "string" ? result.value : null
    ));
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
    this.#status = oneLine(status) || "Recording";
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

  /**
   * FIX-19 finding 4: hands a submission back to the composer when it was
   * REFUSED before any run started (a provider-required refusal, a route
   * that never resolved). Submitting clears the composer — correct once a
   * run owns the text, a silent destruction of typed or pasted work when
   * nothing ever ran and only an unsaid `↑` could get it back.
   *
   * Deliberately not `insertInputText`: this restores, it never appends. A
   * composer the user has already typed into again is left alone — their
   * newer text outranks the recovered one, and the run history (`↑`) still
   * holds the refused submission either way.
   */
  restoreSubmittedDraft(text: string): void {
    if (!text || this.#inputChars.length > 0) return;
    this.#inputChars = Array.from(text);
    this.#cursor = this.#inputChars.length;
    this.scheduleRender(true);
  }

  /**
   * D4: one confirm entry point for both grammar classes. `danger` (the
   * default — every pre-existing caller of this method was already the
   * approval-style, Enter-declines flow) keeps `y` as the only accept key
   * and states the safe default in the footer instead of leaving it
   * silent; `danger: false` is the ordinary class (Enter or `y` accepts),
   * used only where a caller has explicitly classified its action as
   * benign/non-destructive (see the per-site table in the D4 report).
   */
  confirmAction(
    title: string,
    details: string,
    options: {
      rememberAvailable?: boolean;
      danger?: boolean;
      /**
       * FIX-14 fix round 1 (review M2): `confirmPlain`'s own third state,
       * threaded through instead of collapsed onto `danger`. `false` means
       * "Enter must not accept" for an action that is NOT destructive — the
       * key grammar of danger with the presentation of ordinary. Omitted
       * follows the class (danger declines, ordinary accepts).
       */
      defaultAccept?: boolean;
      /**
       * FIX-14 fix round 1 (review M2.2): only a caller that can actually
       * USE a typed reason may advertise `g`. Default `false`: every
       * command and settings confirm reads `.accepted` alone.
       */
      reasonAvailable?: boolean;
    } = {},
  ): Promise<ApprovalDecision> {
    const rememberAvailable = options.rememberAvailable ?? false;
    const danger = options.danger ?? true;
    if (!this.#active) return Promise.resolve({ accepted: false });
    this.#captureSettingsReturn();
    this.#confirmRememberAvailable = rememberAvailable;
    this.#confirmDanger = danger;
    this.#confirmEnterDeclines = danger || options.defaultAccept === false;
    this.#confirmReasonBound = options.reasonAvailable === true;
    if (!this.#approvalBlockId) {
      this.#approvalBlockId = this.#vm.pushApproval({
        risk: "shell",
        summary: oneLine(title),
        details: this.#detailLines(details),
      }).id;
    }
    this.#confirmSince = Date.now();
    this.#enterMode("confirm", "Confirmation required");
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
        ? ["Applies only to:", preview.subject]
        : []),
      ...this.#detailLines(preview.details ?? preview.name),
    ];
    this.#approvalBlockId = this.#vm.pushApproval({
      risk: preview.risk,
      summary: `${approvalRiskLabel(preview.risk)}${separator}${oneLine(preview.summary)}`,
      details,
      rememberHint: rememberAvailable
        ? "a = always allow this exact subject · d = never allow this exact subject"
        : "'Always' and 'never' need a specific file or command",
    }).id;
    // Tool-call approvals are always the danger class (the option default),
    // and are the ONE confirm whose typed reason reaches anything: the
    // decision flows back into `PermissionDeniedError` and from there to the
    // model (FIX-14 fix round 1, review M2.2).
    return this.confirmAction(
      preview.summary,
      preview.details ?? preview.name,
      { rememberAvailable, reasonAvailable: true },
    );
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
    // FIX-19: from here on this UI owns the terminal — a plain in-place
    // picker opened by a command must suspend it instead of reading the same
    // bytes alongside it (see terminal-lease.ts).
    holdTerminal(this.#terminalHandover);
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

  /**
   * FIX-19 (findings 3 + addendum): what `terminal-lease.ts` hands to a plain
   * in-place picker so it never runs on top of this UI. Held as one stable
   * function so `releaseTerminal` can tell "this UI's own claim" apart from a
   * later one (see `holdTerminal`'s note on re-claiming inside `suspend`).
   */
  readonly #terminalHandover: TerminalHandover = (operation) => this.suspend(operation);

  readInput(): Promise<string> {
    this.#requireActive();
    const queued = this.#queuedInputs.shift();
    if (queued !== undefined) {
      this.#enterMode(
        "busy",
        this.#queuedInputs.length
          ? `Queued input processing · ${this.#queuedInputs.length} more`
          : "Queued input processing",
      );
      return Promise.resolve(queued);
    }
    this.#historyIndex = this.#history.length;
    this.#commandMenu = null;
    this.#commandMenuDraft = null;
    this.#dismissedCommandMenuInput = null;
    this.#historyActive = false;
    this.#atClosed = false;
    // FIX-19 finding 7: whatever was typed before the composer existed lands
    // in it now, in order, instead of having been thrown away — the composer
    // is the honest place for it, since it is still editable and nothing is
    // sent without an Enter of its own. `#syncSlashCommandMenu` runs for the
    // same reason a typed `/` opens the palette: replayed text must behave
    // exactly like text that was typed a moment later.
    const replay = this.#typeahead;
    const dropped = this.#typeaheadDropped;
    this.#typeahead = [];
    this.#typeaheadDropped = false;
    if (replay.length) {
      this.#inputChars.splice(this.#cursor, 0, ...replay);
      this.#cursor += replay.length;
    }
    this.#enterMode(
      "input",
      dropped
        ? "Some input typed before startup finished did not fit and was discarded"
        : this.#composerStatus(),
    );
    if (replay.length) this.#syncSlashCommandMenu();
    return new Promise<string>((resolve, reject) => {
      this.#inputResolve = resolve;
      this.#inputReject = reject;
    });
  }

  /**
   * J2 finding 1 — the status a fresh composer opens with.
   *
   * The defect this exists to close was a render-scheduler race, not a
   * missing message. `setStatus` asks for the ORDINARY debounced paint
   * (`scheduleRender()`, 30 ms); `#enterMode` overwrites `#status` and asks
   * for an IMMEDIATE one (`scheduleRender(true)`), which clears the pending
   * timer. When a caller sets a status and then returns to the composer in
   * the same synchronous stretch — `cli.ts`'s dashboard loop does exactly
   * that after every command: `applyDashboardCommandOutput` →
   * `ui.setStatus(…, false)` → `continue` → `await ui.readInput()` — the
   * debounced paint never fires and the immediate one paints the value that
   * already replaced it. `/new`'s "New chat started." was computed,
   * dispatched, guarded against the loop's own "Ready" reset
   * (`landedOnEmptyChat`), and still never reached a single frame.
   *
   * The ordering could not be fixed by making `setStatus` paint immediately
   * (that would repaint on every streamed token) nor by delaying the mode
   * entry (a sleep, and readInput must be synchronous for typeahead). What
   * was actually wrong is precedence: "Ready" is the composer's DEFAULT, a
   * fallback for "nothing to report", and it was outranking a notice that
   * had genuinely just been written. So it yields — to a notice, still
   * fresh by the same `STATUS_FRESH_MS` the status line itself uses to
   * decide whether a status is worth showing, and still the current status.
   * Anything else — a run's phase text, a status some other writer has
   * since replaced, a notice older than the status line would render, or
   * plain "Ready" — falls back to "Ready" exactly as before.
   *
   * Every sibling of `/new` benefits by the same rule, none of them by a
   * mechanism of their own: `pickDashboardChat`'s "Chat opened: <title>"
   * and "Folder switched: …" confirmations (`cli.ts`) and the dashboard
   * loop's "Cross is already running …" refusal were all being erased by
   * this same next-`readInput()` overwrite.
   */
  #composerStatus(): string {
    const notice = this.#statusNotice;
    if (!notice || notice.value === "Ready") return "Ready";
    // Identity check, not just presence: any later `#status` write moves
    // `#statusAt`, so a superseded notice is silently dropped here without
    // every other writer having to know this field exists.
    if (notice.value !== this.#status || notice.at !== this.#statusAt) return "Ready";
    return Date.now() - notice.at < STATUS_FRESH_MS ? notice.value : "Ready";
  }

  /**
   * The hub's fixed quick-action row (Controller ruling 1, D8): New chat ·
   * All chats · Folder · Settings, in this order. FIX-17 adds exactly one
   * state-dependent exception: while provider setup is still needed
   * (`providerSetupNeeded`), the "Set up a provider" affordance LEADS the
   * list — prominent, never buried — and retires by itself the moment a
   * route resolves. Shared source (`#workbenchActions`) with
   * `#workbenchRows` below so what renders and what Enter activates can
   * never disagree about position.
   */
  #workbenchActions(
    state: DashboardState,
  ): readonly (typeof WORKBENCH_QUICK_ACTIONS[number] | typeof WORKBENCH_SETUP_ACTION)[] {
    return state.providerSetupNeeded
      ? [WORKBENCH_SETUP_ACTION, ...WORKBENCH_QUICK_ACTIONS]
      : WORKBENCH_QUICK_ACTIONS;
  }

  #quickActions(
    state: DashboardState,
  ): readonly { readonly label: string; readonly hint: string }[] {
    return this.#workbenchActions(state).map(({ label, hint }) => ({ label, hint: hint() }));
  }

  /**
   * The ONE selectable list the hub's ↓/↑ selection navigates (Controller
   * ruling 2, D8: the pre-D8 quick-action machinery generalized to cover
   * the "Recent" rows too, rather than growing a second list mechanism):
   * up to 4 "Recent" chat picks, most-recent first, then the fixed quick
   * actions (led by the FIX-17 setup affordance while setup is needed —
   * `#workbenchActions` is the one shared source with what renders). Shared
   * by `#handleQuickActionKey` (bounds + navigation) and `#runQuickAction`
   * (what Enter does with the highlighted row).
   */
  #workbenchRows(
    state: DashboardState,
  ): readonly (
    | { readonly kind: "chat"; readonly chatId: string }
    | { readonly kind: "action"; readonly command: string }
  )[] {
    const chats = (state.recentChats ?? []).slice(0, 4).map((chat) => ({
      kind: "chat" as const,
      chatId: chat.id,
    }));
    const actions = this.#workbenchActions(state).map(({ command }) => ({
      kind: "action" as const,
      command,
    }));
    return [...chats, ...actions];
  }

  /**
   * FIX-17 (finding 2, the activation race): the stable identity of one
   * workbench row — a chat by its id, an action by its command. The armed
   * selection is tracked by THIS, not only by index, because the rows list
   * can legitimately change under an armed selection (the fire-and-forget
   * "Recent" refresh prepending rows right after launch, the setup
   * affordance retiring): `#syncQuickActionSelection` then remaps the index
   * to the SAME logical row, or disarms entirely when that row is gone —
   * never activating a row the owner did not see highlighted.
   */
  static #workbenchRowKey(
    row: { readonly kind: "chat"; readonly chatId: string }
      | { readonly kind: "action"; readonly command: string },
  ): string {
    return row.kind === "chat" ? `chat:${row.chatId}` : `action:${row.command}`;
  }

  /** See `#workbenchRowKey`. Re-anchors `#quickActionIndex` onto the armed row's identity, disarming when it left the list. */
  #syncQuickActionSelection(
    rows: readonly ({ readonly kind: "chat"; readonly chatId: string }
      | { readonly kind: "action"; readonly command: string })[],
  ): void {
    if (this.#quickActionIndex === null) return;
    const current = rows[this.#quickActionIndex];
    if (current && TerminalUi.#workbenchRowKey(current) === this.#quickActionRowKey) return;
    const remapped = rows.findIndex(
      (row) => TerminalUi.#workbenchRowKey(row) === this.#quickActionRowKey,
    );
    if (remapped >= 0) {
      this.#quickActionIndex = remapped;
      return;
    }
    this.#quickActionIndex = null;
    this.#quickActionRowKey = null;
  }

  /**
   * Executes the row Enter just activated (see `#handleQuickActionKey`). A
   * "Recent" chat pick has no slash command of its own — it arms
   * `#quickActionChatPick` and submits the empty composer exactly as a bare
   * Enter used to, so the dashboard loop's existing chat-switch step (the
   * same `pickDashboardChat` preset path a foreign `/chats` pick uses —
   * Controller ruling 3: one code path) runs unchanged. Every fixed action
   * is a real slash command: typing it into the composer and submitting
   * reuses the normal dispatch path verbatim, so "Enter runs the selected
   * action" behaves exactly like the owner typing it out and pressing
   * Enter would.
   */
  #runQuickAction(
    row: { readonly kind: "chat"; readonly chatId: string }
      | { readonly kind: "action"; readonly command: string },
  ): void {
    if (row.kind === "chat") {
      this.#quickActionChatPick = row.chatId;
      this.#submit();
      return;
    }
    this.#inputChars = Array.from(row.command);
    this.#cursor = this.#inputChars.length;
    this.#submit();
  }

  /**
   * V3 interaction ruling (owner-endorsed; supersedes the composition
   * round's "Enter on the empty composer continues the last chat"):
   * ↓ from the empty start-workbench composer moves a visible `❯`
   * selection into the combined Recent/quick-action list; ↑/↓ then navigate
   * it; Enter runs the highlighted row; Esc returns focus to the composer
   * with no selection. Returns true when the key was fully handled here.
   */
  #handleQuickActionKey(key: Key): boolean {
    // FIX-17 (finding 2): every decision below is made against the CURRENT
    // rows, with the armed selection first re-anchored onto its logical row
    // (`#syncQuickActionSelection`) — a fire-and-forget "Recent" refresh
    // that prepends rows between two keypresses can therefore never make
    // Enter activate a row the owner did not see highlighted; when the
    // armed row vanished entirely the arming is dropped and the key falls
    // back to its unarmed meaning (a bare Enter is then the V3 no-op).
    const rows = this.#workbenchRows(this.getState());
    this.#syncQuickActionSelection(rows);
    if (this.#quickActionIndex === null) {
      const onEmptyWorkbench = this.#mode === "input"
        && this.#inputChars.length === 0
        // FIX-17 (finding 1): `isHubTranscript`, not `length === 0` — the
        // same shared hub rule dashboard-frame.ts renders by. A transcript
        // holding only notices (a cancelled setup, a startup warning) keeps
        // ↓ arming the hub selection instead of dying for the session.
        && isHubTranscript(this.#vm.blocks)
        // The command menu (Ctrl+P or a bare `/`) owns ↓/↑ for its own tree
        // navigation even while the composer is otherwise empty — quick
        // actions must not steal that key out from under it.
        && !this.#commandMenu;
      if (!onEmptyWorkbench || key.name !== "down") return false;
      const first = rows[0];
      if (!first) return false;
      this.#quickActionIndex = 0;
      this.#quickActionRowKey = TerminalUi.#workbenchRowKey(first);
      this.scheduleRender(true);
      return true;
    }
    if (key.name === "up" || key.name === "down") {
      this.#quickActionIndex = clamp(
        this.#quickActionIndex + (key.name === "up" ? -1 : 1),
        0,
        Math.max(0, rows.length - 1),
      );
      const selected = rows[this.#quickActionIndex];
      this.#quickActionRowKey = selected ? TerminalUi.#workbenchRowKey(selected) : null;
      this.scheduleRender(true);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const row = rows[this.#quickActionIndex];
      this.#quickActionIndex = null;
      this.#quickActionRowKey = null;
      if (row) this.#runQuickAction(row);
      else this.scheduleRender(true);
      return true;
    }
    if (key.name === "escape") {
      this.#quickActionIndex = null;
      this.#quickActionRowKey = null;
      this.scheduleRender(true);
      return true;
    }
    return false;
  }

  /** The current frame. Exposed so layout can be asserted without a TTY. */
  frame(): Frame {
    if (this.#surface === "settings" && this.#settingsView) {
      // V4-B: no `brand` input any more. The compact mark is the chat
      // HEADER's decoration (`appearance.showHeaderMark`); Settings has a
      // title bar instead of a header, and its one loud line is spent on the
      // breadcrumb rather than on a wordmark that says nothing.
      const result = buildSettingsFrame({
        width: Math.max(1, this.stdout.columns || 80),
        height: Math.max(1, this.stdout.rows || 24),
        theme: this.#theme,
        view: this.#settingsView,
      });
      return result.frame;
    }
    const editorBuffer = this.#returnSurface === "settings"
      || this.#mode === "model-picker"
      || this.#mode === "choice-picker"
      || this.#mode === "secret"
      || this.#mode === "validated-input"
      || (this.#mode === "confirm" && this.#confirmReasonMode);
    const state = this.getState();
    // FIX-17 (finding 2): the frame's highlight must show the row Enter
    // would actually run — re-anchor the armed selection onto its logical
    // row before handing the index to the renderer, so an async "Recent"
    // prepend moves the visible `❯` bar with the row instead of leaving it
    // on whatever now occupies the old index.
    this.#syncQuickActionSelection(this.#workbenchRows(state));
    const quickGroups = this.#quickActions(state);
    const input: DashboardFrameInput = {
      width: Math.max(1, this.stdout.columns || 80),
      height: Math.max(1, this.stdout.rows || 24),
      theme: this.#theme,
      state,
      blocks: this.#vm.blocks,
      mode: this.#mode,
      input: editorBuffer ? this.#editorChars.join("") : this.#inputChars.join(""),
      cursor: editorBuffer ? this.#editorCursor : this.#cursor,
      viewport: this.#viewport,
      status: this.#status,
      statusFresh: Date.now() - this.#statusAt < STATUS_FRESH_MS,
      queuedCount: this.#queuedInputs.length,
      interjectable: this.#interjectHandler !== null,
      // Audit FIX-1: the hint's esc segment and the escape handler branch on
      // the SAME state — the hint can never claim an esc meaning the key
      // does not have right now.
      reasoningLive: this.#vm.reasoningLive,
      attachmentCount: this.#attachments.length,
      helpRequested: this.#inputChars.join("").trim() === "?",
      tick: this.#tick,
      now: Date.now(),
      brand: {
        showLargeLogo: this.#appearance.showLargeLogo,
        showHeaderMark: this.#appearance.showHeaderMark,
        largeLines: routeCoreLarge(resolveGlyphMode(this.#appearance.glyphMode, this.#glyphEnvironment)),
        compactMark: routeCoreCompact(resolveGlyphMode(this.#appearance.glyphMode, this.#glyphEnvironment)),
        version: this.#version,
      },
      quickGroups,
      homeDir: homedir(),
    };
    if (this.#quickActionIndex !== null) input.quickActionIndex = this.#quickActionIndex;
    if (this.#contextPercent !== undefined) input.contextPercent = this.#contextPercent;
    if (this.#run) input.run = this.#run;
    if (this.#mode === "confirm") input.waitingSince = this.#confirmSince;
    if (this.#mode === "confirm") input.rememberAvailable = this.#confirmRememberAvailable;
    if (this.#mode === "confirm") input.confirmDanger = this.#confirmDanger;
    // FIX-14 fix round 1 (review M2): the footer states the KEY grammar,
    // which an ordinary `defaultAccept: false` confirm shares with danger
    // while keeping ordinary presentation.
    if (this.#mode === "confirm") input.confirmEnterDeclines = this.#confirmEnterDeclines;
    // Fix round 1, IMPORTANT: the footer's `g reason` hint must reflect
    // which MECHANISM is actually live — `g` (reason capture) only exists
    // on the approval mechanism (`#confirmResolve`); the settings-editor
    // mechanism (`#resolveSettingsEditor`) never binds it, even for a
    // danger-class settings confirm (e.g. "Enable allow-all?"). Discriminated
    // by mechanism directly, not by `editorPrompt` presence — the two
    // happen to coincide today, but the mechanism is the actual contract
    // the confirm-mode key handler switches on.
    // FIX-14 fix round 1 (review M2.2): tightened from "an approval-style
    // resolver is live" — true for every `confirmAction`, command confirms
    // included, whose caller discards the reason — to "the caller can
    // actually use one", which only `confirmApproval` sets.
    if (this.#mode === "confirm") input.confirmReasonAvailable = this.#confirmReasonBound;
    if (this.#mode === "secret") input.secretLabel = this.#secretLabel;
    if (this.#mode === "secret" && this.#secretEscHint) input.secretEscHint = this.#secretEscHint;
    // FIX-8: gated on the live editor request itself, not on
    // `#returnSurface === "settings"`. Every pre-FIX-8 request came from
    // `edit()` and therefore always had that surface, so this renders
    // exactly as before for them — but `readPath` opens the same mode from
    // the chat surface, and its label/description must render too.
    if (this.#editorRequest) {
      input.editorPrompt = {
        label: oneLine(this.#editorRequest.label),
        description: oneLine(this.#editorRequest.description),
        ...(this.#editorValidationMessage
          ? { validationMessage: this.#editorValidationMessage }
          : {}),
        // V4-B: a settings editor opens with the grown crumb and the row's
        // current value, exactly like the settings-driven pickers do. Unset
        // for `readPath`, which reuses this mode from the chat surface with
        // no settings row behind it — that prompt keeps its plain label.
        ...(this.#editorCrumb ? { crumb: this.#editorCrumb } : {}),
        ...(this.#editorCurrentValue ? { currentValue: this.#editorCurrentValue } : {}),
      };
    }
    const list = this.#listView();
    if (list) input.list = list;
    if (this.#viewport.anchor !== "tail") {
      input.newLinesBelow = Math.max(0, this.#flatten().length - this.#linesAtScroll);
    }
    return buildDashboardFrame(input);
  }

  /**
   * The current command-menu projection, if the menu is open. Exposed so
   * Ctrl+P and inline `/` completion can be compared directly — proving
   * they share one data path — without parsing rendered text.
   */
  commandMenuProjection(): CommandMenuProjection | undefined {
    if (!this.#commandMenu) return undefined;
    return projectCommandMenu(this.#commandMenu, this.#commandMenuRuntime(), this.#theme);
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
    if (!this.#active) throw new Error("The terminal surface is not active.");
  }

  /**
   * ` Settings › Models › Main model ` — the open editor's own crumb, one
   * step deeper than the surface behind it (V4-B; V4-A concern 5).
   *
   * The category label comes from `settingsCategoryLabel`, the registry's one
   * spelling of it, so the crumb can never disagree with the tab bar or with
   * `/settings <category>`. Joined through `crumbText`, so the chevron
   * follows the glyph mode like every other crumb in the product.
   */
  #settingsCrumb(request: SettingsEditorRequest): string {
    return crumbText(this.#theme, [
      "Settings",
      settingsCategoryLabel(request.categoryId),
      oneLine(request.label),
    ]);
  }

  /** The edited row's own `displayValue` — the exact string the row shows. */
  #settingsCurrentValue(request: SettingsEditorRequest): string {
    const item = this.#settingsView?.allItems.find(({ id }) => id === request.itemId);
    return oneLine(item?.displayValue ?? "");
  }

  #closeSettingsSurface(): void {
    this.#surface = "chat";
    this.#settingsView = null;
    this.#clearSettingsInputQueue();
    this.#settingsSearchChars = [];
    this.#settingsSearchCursor = 0;
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
    const undersized = Math.max(1, this.stdout.columns || 80) < MIN_WIDTH
      || Math.max(1, this.stdout.rows || 24) < MIN_HEIGHT;
    if (undersized) {
      if (key.name === "escape") this.#emitSettingsIntent({ kind: "back" });
      return;
    }
    if (!this.#settingsIntentResolve) {
      this.#enqueueSettingsKey(character, key);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      this.#emitSettingsIntent({ kind: "move", delta: key.name === "up" ? -1 : 1 });
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      this.#emitSettingsIntent({ kind: "page", delta: key.name === "pageup" ? -1 : 1 });
      return;
    }
    if (key.name === "home" || key.name === "end") {
      this.#emitSettingsIntent({ kind: "boundary", edge: key.name === "home" ? "first" : "last" });
      return;
    }
    const categories = this.#settingsView.categories;
    // F6 ruling 1: `←`/`→` walk the category pane — the keys a two-column
    // layout invites, and until now dead no-ops, which left the digits as
    // the screen's only (and entirely undisclosed) way to change category.
    // They are the SAME jump, not a second mechanism: one `category` intent,
    // one `#selectCategory` in the controller. Digit semantics decide the
    // edges too — a digit outside the range selects nothing and an in-range
    // digit re-selects even the current category, so an arrow at either end
    // clamps and re-selects rather than wrapping. While the search owns the
    // keyboard both axes belong to the query (`←→` walk it, digits type into
    // it), so neither path fires there.
    if (
      (key.name === "left" || key.name === "right")
      && !this.#settingsView.search.active
      && categories.length > 0
    ) {
      const current = categories.findIndex(({ id }) => id === this.#settingsView?.selectedCategoryId);
      const next = categories[Math.min(
        categories.length - 1,
        Math.max(0, Math.max(0, current) + (key.name === "left" ? -1 : 1)),
      )];
      if (next) this.#emitSettingsIntent({ kind: "category", categoryId: next.id });
      return;
    }
    const ordinal = Number(key.name ?? character);
    if (
      Number.isInteger(ordinal)
      && ordinal >= 1
      && ordinal <= categories.length
      && !this.#settingsView.search.active
      && categories[ordinal - 1]
    ) {
      this.#emitSettingsIntent({
        kind: "category",
        categoryId: categories[ordinal - 1]!.id,
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
    // The quick-action selection only ever makes sense over the empty
    // "input" composer — any other mode (a run starting, a picker opening)
    // drops it, so it never survives stale into an unrelated screen.
    if (mode !== "input") {
      this.#quickActionIndex = null;
      this.#quickActionRowKey = null;
    }
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
        this.#editorValidationMessage = "Enter a valid number";
        this.scheduleRender(true);
        return;
      }
      const value = Number(retained);
      if (!Number.isFinite(value) || value < descriptor.minimum || value > descriptor.maximum) {
        this.#editorValidationMessage =
          `Number must be between ${descriptor.minimum} and ${descriptor.maximum}`;
        this.scheduleRender(true);
        return;
      }
      if (
        (descriptor.actionId === "max-steps"
          || descriptor.actionId === "verify-repair-rounds"
          || descriptor.actionId === "browser-timeout")
        && !Number.isInteger(value)
      ) {
        this.#editorValidationMessage = "Only whole numbers are allowed";
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
        this.#editorValidationMessage = "Path is too long";
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
      this.#editorValidationMessage = "List is invalid";
      this.scheduleRender(true);
      return;
    }
    if (descriptor.valueKind === "command-list" && values.length === 0) {
      this.#editorValidationMessage = "At least one verify command is required";
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
    this.#editorCurrentValue = "";
    this.#editorCrumb = "";
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
    this.#choiceTitle = "";
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
        return "Model waiting";
      case "model-end":
        return "Model response received";
      case "reasoning":
        return "Model thinking";
      case "tool-start":
        return "Tool running";
      case "tool-output":
        return "Tool writing output";
      case "process-start":
        return "Process running";
      case "process-output":
        return "Process writing output";
      case "process-end":
        return event.exitCode === 0 ? "Process complete" : "Process failed";
      case "tool-end":
        return "Model processing tool result";
      case "tool-error":
        return "Model processing tool error";
      case "verify":
        return "Verify run";
      case "run-end":
        return runOutcomeLabel(event.outcome, this.#theme.glyph("separator"));
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
        // V4-A zone 1 — the same field the choice picker below already fed.
        heading: this.#pickerTitle || undefined,
        // V4-B: what the row says right now, stated once above the list
        // instead of only where the `· active` tag happens to be visible.
        ...(this.#editorCurrentValue ? { currentValue: this.#editorCurrentValue } : {}),
      };
    }
    if (this.#mode === "choice-picker") {
      return {
        entries: this.#choiceItems.map((item) => ({
          name: item.label,
          description: item.description,
          ...(item.descriptionParts ? { descriptionParts: item.descriptionParts } : {}),
          // FIX-20, finding 4: an empty `currentValue` is the explicit "no
          // row holds a current value" signal (an action list), and must
          // never tag anything — `· active` marks a current VALUE, and a
          // list of actions has none. Which row the cursor starts on is
          // `initialValue`'s job, kept separate for exactly this reason.
          current: this.#choiceCurrent !== "" && item.value === this.#choiceCurrent,
          sectionHeading: item.sectionHeading,
        })),
        selectedIndex: this.#selectedIndex,
        heading: this.#choiceTitle || undefined,
        ...(this.#editorCurrentValue ? { currentValue: this.#editorCurrentValue } : {}),
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
    if (this.#commandMenu) {
      const menu = this.#commandMenu;
      const projection = projectCommandMenu(menu, this.#commandMenuRuntime(), this.#theme);
      const rows = resolveCommandMenuRows(menu);
      const soleRow = rows.length === 1 ? rows[0] : undefined;
      if (soleRow?.kind === "recovery") {
        // V3 state 3 (F2 ruling 5): the recovery row replaces the whole
        // list body — rows and footer both vanish behind one honest
        // "never a dead end" message. `#handleCommandMenuKey`'s handling of
        // this same row (`selected.kind === "recovery"`) is untouched —
        // Tab/Enter still clear the query and open the root tree exactly as
        // before; only how the state LOOKS changes here.
        const failedQuery = soleRow.query;
        // Ctrl+P's own search field never carries a leading slash; the
        // inline `/` trigger's query is always the composer text minus that
        // slash, so re-adding it here quotes exactly what the user typed
        // ("query quoted verbatim", ruling 5).
        const verbatim = this.#commandMenuDraft === null ? `/${failedQuery}` : failedQuery;
        return {
          entries: projection.entries,
          selectedIndex: menu.selectedIndex,
          emptyLine: buildListEmptyLine(
            this.#theme,
            // FIX-5 ruling 3: the old wording ("Esc clears") named the one
            // key that does NOT clear. `#handleCommandMenuKey` gives this row
            // to Tab/Enter — they drop the failed query and reopen the root
            // tree — while Esc closes the menu with the typed text left in
            // the composer, exactly as typed. The line now says both, in the
            // footer's own `verb` order (Enter first, Esc last).
            `No command matches "${verbatim}" ${this.#theme.glyph("emdash")} Enter clears`
              + `${this.#theme.glyph("separator")}Esc closes`
              + `${this.#theme.glyph("separator")}/help lists everything`,
          ),
        };
      }
      // A search has no "current location" (it reaches every leaf
      // regardless of the browsed path), so `projectCommandMenu` already
      // collapses the crumb TEXT to the bare "Commands" form while
      // querying — same as true root browse, never a group. D1 ruling 4
      // (superseding the original F2 ruling 3 this comment used to cite):
      // the palette's top rule now carries that crumb in every state,
      // filtering included, so the block always shows a top boundary —
      // the old on/off-while-browsing suppression is gone.
      const isQuerying = menu.query.trim().length > 0;
      // Esc's real behavior (`#handleCommandMenuKey`) steps back one browsed
      // level whenever one is open, regardless of query — the footer's Esc
      // wording follows that same `path.length` check, not the query.
      const drilled = menu.path.length > 0;
      return {
        entries: projection.entries,
        selectedIndex: menu.selectedIndex,
        breadcrumb: projection.breadcrumb,
        // Fix round 1 (controller ruling on the counter): the palette hands
        // the counter NO numbers of its own. `N of M` means one thing on
        // every surface and in every state — the cursor's rank among the rows
        // the list currently holds — so while a query is on it reads "row N
        // of M matches", not "M matches of every command there is". The
        // palette's old footer count was the second meaning; it is gone with
        // the footer, and `buildListLines` draws the one counter there is.
        // V4-A zone 3 (appearance pin changed, keys and verbs unchanged): the
        // same three verbs, now rendered as chips out of the one keymap table
        // instead of `·`-joined into a muted string. Every verb below is
        // still computed exactly where it was.
        footer: actionBarLine(
          this.#theme,
          listActionChips(this.#theme, "Palette", {
            // FIX-11 (rendered truth): the verb names what Enter does to
            // the SELECTED row, not a single hardcoded promise the leaf
            // path only sometimes kept. `#activateCommandLeaf` runs an
            // argument-less leaf outright and only inserts one that takes
            // arguments, so the chip follows the very same catalog flag
            // (`commandMenuEnterVerb`, ui/command-menu.ts).
            enter: commandMenuEnterVerb(rows[menu.selectedIndex]),
            // FIX-5 ruling 4: Esc pops exactly ONE browsed level
            // (`#handleCommandMenuKey`: `menu.path.slice(0, -1)`), so from
            // `Commands › Model › cross` it lands on `Commands › Model`, not
            // "all commands". The verb states what the key does — one step
            // back — and the title bar above already shows where that is.
            esc: drilled ? "back" : "close",
            // Tab still completes/drills at every level (ruling 3) — the
            // action bar only ADVERTISES it while a query is active,
            // matching the two binding mockup frames verbatim.
            tab: isQuerying ? "complete" : undefined,
          }),
          {
            leadingDivider: true,
            // The frame's usable width (`width - 1`, the same budget every
            // full-width line lays out against) so the bar sheds whole chips
            // rather than being cut mid-chip by `fitFrameLine` — at 40
            // columns the old joined footer lost `Esc close` outright.
            width: Math.max(1, (this.stdout.columns || 80) - 1),
          },
        ),
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
    // The start workbench can use substantially more chrome than a populated
    // conversation. Derive the current stream budget before paging so a key
    // pressed between the first conversation block and its scheduled redraw
    // still scrolls the conversation rather than treating the empty layout as
    // authoritative.
    const chatHeight = this.frame().chatHeight || this.#lastChatHeight || Math.max(5, (this.stdout.rows || 24) - 6);
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
    releaseTerminal(this.#terminalHandover);
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
    this.#editorCurrentValue = "";
    this.#editorCrumb = "";
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
    this.#secretEscHint = null;
    this.#confirmReasonMode = false;
    this.#confirmRememberAvailable = false;
    this.#confirmDanger = false;
    this.#confirmEnterDeclines = false;
    this.#confirmReasonBound = false;
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
    }
    this.#returnSurface = null;
    this.#returnMode = null;
    this.#settingsChatStatus = null;
    this.#closingSettings = false;
    if (!this.#inputResolve) this.#mode = "idle";
    this.#status = "Input cancelled";
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
    if ((key.ctrl && key.name === "c") || character === "\u0003") {
      this.#pasting = false;
      this.#pasteBuffer = "";
      this.#interrupt();
      return;
    }
    // Audit FIX-1: any key other than Ctrl+C disarms the idle two-press
    // quit window — once typing resumes, quitting takes two fresh presses.
    this.#exitArmedAt = 0;
    if (key.name === "paste-start") {
      this.#pasting = true;
      this.#pasteBuffer = "";
      if (this.#surface !== "settings") this.setStatus("Pasting …", false);
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
      // Audit FIX-1 (2026-08-28): confirm mode used to return before the
      // chat-surface Ctrl+O handler below, so the truncated approval's
      // "Ctrl+O shows all" hint was false 100% of the time it rendered —
      // a large write had to be approved blind. Ctrl+O (and its Ctrl+T
      // synonym, matching the reasoning toggle pair) now toggles the
      // pending approval block's full detail; every decision key keeps
      // working while it is expanded.
      if (key.ctrl && (key.name === "o" || key.name === "t")) {
        if (this.#approvalBlockId && this.#vm.toggle(this.#approvalBlockId)) {
          this.scheduleRender(true);
          return;
        }
        // No pending approval block (a settings-editor confirm): fall
        // through to the existing unbound-key answers below.
      }
      const danger = this.#confirmDanger;
      // FIX-14 fix round 1 (review M2): the accept/decline DIRECTION is the
      // key grammar, which an ordinary `defaultAccept: false` confirm shares
      // with danger; `danger` itself still gates the class-only extras
      // (`a`/`d`) below.
      const enterDeclines = this.#confirmEnterDeclines;
      if (this.#editorResolve && this.#returnSurface === "settings") {
        // D4 unified grammar — ordinary: Enter or `y` accepts, Esc or `n`
        // cancels. danger: `y` is the only accept key, Enter/Esc/`n`
        // cancel (Enter's decline is now stated in the footer instead of
        // silent). Escape always routes through the explicit cancel path
        // (never the `value: false` path) — Esc-always-cancels is a
        // preserved invariant, not just an equivalent outcome.
        const accepts = key.name === "y" || (!danger && (key.name === "return" || key.name === "enter"));
        if (accepts) {
          this.#resolveSettingsEditor({ kind: "value", value: true });
        } else if (key.name === "escape") {
          this.#resolveSettingsEditor({ kind: "cancel" });
        } else if (key.name === "n" || (danger && (key.name === "return" || key.name === "enter"))) {
          this.#resolveSettingsEditor({ kind: "value", value: false });
        } else {
          this.#editorValidationMessage = danger
            ? "y confirm · Enter, Esc, or n cancel"
            : "Enter or y confirm · Esc or n cancel";
          this.scheduleRender(true);
        }
        return;
      }
      // `g` (reason) opens a one-line reason prompt — only where the caller
      // can actually use the typed reason (`#confirmReasonBound`, review
      // M2.2); everything else still resolves the confirm directly.
      if (this.#confirmReasonBound && this.#confirmReasonMode) {
        if (key.name === "return") {
          const reason = this.#editorChars.join("").trim();
          this.#resolveConfirm({ accepted: false, reason: reason || undefined });
        } else if (key.name === "escape") {
          this.#confirmReasonMode = false;
          this.#resetEditor();
          this.setStatus("Confirmation required", false);
          this.#mode = "confirm";
          this.scheduleRender(true);
        } else {
          this.#editEditor(character, key);
          this.scheduleRender(true);
        }
        return;
      }
      if (enterDeclines) {
        // D4: `y` is the only accept key once Enter declines (the old `j`
        // — German "ja" — synonym is gone, folded into "unbound" below);
        // `a` always allow / `d` never allow / `g` reason are pre-existing
        // approval-only extras layered on top of the accept/cancel binary,
        // untouched by the classification itself. An unbound key answers
        // instead of staying silent (Bauplan 2.5).
        //
        // FIX-14 fix round 1 (review M2): the branch is keyed on the KEY
        // grammar, so an ordinary `defaultAccept: false` confirm gets the
        // explicit-yes direction it asked for. Its extras stay off on their
        // own flags — `#confirmRememberAvailable` and `#confirmReasonBound`
        // are both false there — so nothing danger-only leaks in with it.
        if (key.name === "y") this.#resolveConfirm({ accepted: true });
        else if (key.name === "a" && this.#confirmRememberAvailable) {
          this.#resolveConfirm({ accepted: true, remember: "allow" });
        } else if (key.name === "d" && this.#confirmRememberAvailable) {
          this.#resolveConfirm({ accepted: false, remember: "deny" });
        } else if ((key.name === "a" || key.name === "d") && danger) {
          this.setStatus("'Always' and 'never' need a specific file or command", false);
          this.#mode = "confirm";
          this.scheduleRender(true);
        } else if (key.name === "g" && this.#confirmReasonBound) {
          this.#confirmReasonMode = true;
          this.#resetEditor();
          this.setStatus("Enter a reason · Enter send · Esc back", false);
          this.scheduleRender(true);
        } else if (
          key.name === "n" || key.name === "escape" || key.name === "return" || key.name === "enter"
        ) {
          // Fix round 1, MINOR 2: `enter` (some inputs report `\n` with
          // that name instead of `return`) unifies with `return` across
          // every branch of confirm mode — the settings/ordinary branches
          // already treated them the same; this danger branch used to
          // leave `enter` unbound instead of declining like `return`
          // does. Safe-direction delta (decline, not accept) — sanctioned.
          this.#resolveConfirm({ accepted: false });
        } else {
          // Fix round 1, MINOR 1: reworded to the same grammar the footer
          // now states (`y confirm · Enter/Esc cancel …`) instead of the
          // pre-D4 `y yes · n no · … · Enter = no` phrasing.
          //
          // FIX-14 fix round 1 (review M2.2): the line names only the two
          // keys every Enter-declines confirm binds. It used to end by
          // claiming `g reason` "is always genuinely bound here" — true
          // when only tool approvals reached this branch, false since
          // command confirms do, and the a/d/g extras were already left to
          // the footer (which gates each on its own availability flag)
          // for the length reason below.
          //
          // FIX-9 addendum: the opener says in plain words what happened
          // ("Unbound" named the key's state and told the owner nothing).
          // Two constraints shape the rest of the line. It must stay
          // DISTINCT from the danger footer (`dashboard-frame.ts`'s
          // `y confirm · Enter/Esc cancel · …`), which is already on screen
          // — without its own opener this line would be byte-identical to
          // it, so a dead keypress would produce no visible change at all.
          // And it must stay SHORT: `statusInfo` composes it as the
          // right-hand segment beside `waiting since MM:SS`, so an
          // over-long notice is dropped whole rather than truncated. The
          // a/d/g extras therefore stay on the footer below, which renders
          // them in full; repeating them here only risked losing the line.
          this.setStatus(
            "That key does nothing here · y confirm · Enter/Esc cancel",
            false,
          );
          this.#mode = "confirm";
          this.scheduleRender(true);
        }
        return;
      }
      // Ordinary class, Enter accepting: Enter or `y` accepts, Esc or `n`
      // cancels — no remember/reason extras, those are approval-only.
      //
      // FIX-14 fix round 1 (review M2.3): the example this used to name —
      // "use this key for this process only?" — has NOT taken this branch
      // since `confirmPlain`'s documented `defaultAccept: false` reached the
      // fullscreen surface. That confirm is still ordinary in class, but it
      // asks for an explicit yes, so it takes the `enterDeclines` branch
      // above with ordinary presentation. A settings confirm on a
      // non-destructive item is the live example.
      if (key.name === "return" || key.name === "enter" || key.name === "y") {
        this.#resolveConfirm({ accepted: true });
      } else if (key.name === "n" || key.name === "escape") {
        this.#resolveConfirm({ accepted: false });
      } else {
        // FIX-9 addendum: same plain opener as the danger branch above,
        // and for the same reason — the ordinary footer already reads
        // `Enter confirm · Esc cancel`, so the opener is what makes a
        // dead keypress visible. Same length budget applies.
        this.setStatus("That key does nothing here · Enter or y confirm · Esc or n cancel", false);
        this.#mode = "confirm";
        this.scheduleRender(true);
      }
      return;
    }
    // FIX-19 finding 7 (typeahead): "idle" is the window between the first
    // paint and the loop's first `readInput()` — startup work, a balance
    // refresh, the interrupted-run check. The frame looks ready, so people
    // type into it, and every one of those keystrokes used to be dropped on
    // the floor (measured: 16 characters swallowed at the hub, and the
    // pre-frame seconds' typeahead with them, since those bytes arrive here
    // too once stdin is resumed). They are held instead, and replayed into
    // the composer the moment it opens — bounded, so a pasted file or a
    // held key can never grow this without limit.
    if (this.#mode === "idle") {
      if (key.ctrl || key.meta || !isPrintableKeypressText(character)) return;
      const held = Array.from(character);
      const capacity = MAX_TYPEAHEAD_CODEPOINTS - this.#typeahead.length;
      if (capacity <= 0) {
        this.#typeaheadDropped = true;
        return;
      }
      if (held.length > capacity) this.#typeaheadDropped = true;
      this.#typeahead.push(...held.slice(0, capacity));
      return;
    }
    if (this.#mode !== "input" && this.#mode !== "busy") return;
    // B9: the reasoning panel toggles on Ctrl+T (original binding, kept) or
    // Ctrl+O (Phase 3b, Part C: the hint text the "Thinking …" line now
    // advertises). A bare `T`/`O` stays text.
    if (key.ctrl && (key.name === "t" || key.name === "o")) {
      // FIX-3 keyboard addendum (single marked addition in FIX-1's dispatch
      // region): a tool block at the very END of the transcript is the one
      // that renders `N more lines · Ctrl+O expand`, so Ctrl+O has to reach
      // it — before this, the hint named a key that only ever moved the last
      // reasoning panel. Anything else keeps the pre-existing behavior
      // exactly: the last reasoning block, wherever it sits.
      const last = this.#vm.blocks[this.#vm.blocks.length - 1];
      if (last && last.kind === "tool") {
        if (this.#vm.toggle(last.id)) this.scheduleRender(true);
        return;
      }
      const reasoning = [...this.#vm.blocks].reverse().find((item) => item.kind === "reasoning");
      if (reasoning && this.#vm.toggle(reasoning.id)) this.scheduleRender(true);
      return;
    }
    // Audit FIX-1: Shift+Tab (terminals send CSI Z; node's keypress decoder
    // reports `{ name: "tab", shift: true }`) cycles the approval mode —
    // the Claude Code reflex. Checked before the reply list and the line
    // editor so plain Tab keeps its meanings there; a bare `\t` was already
    // filtered out of the composer by `#editInput`'s printable filter.
    if (key.name === "tab" && key.shift) {
      this.#cycleApprovalMode();
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
      this.setStatus(`${lines} input line${lines === 1 ? "" : "s"} · Enter sends everything together`, false);
      this.scheduleRender(true);
      return;
    }
    if (this.#historyActive && this.#handleHistoryKey(key)) return;
    if (this.#suggestedReplies.length && !this.#inputChars.length && this.#mode === "input") {
      if (this.#handleReplyKey(key)) return;
    }
    if (this.#handleQuickActionKey(key)) return;
    // Typing a real character always returns focus to the composer — the
    // character itself still falls through below to be typed normally.
    if (this.#quickActionIndex !== null && isPrintableKeypressText(character) && !key.ctrl && !key.meta) {
      this.#quickActionIndex = null;
      this.#quickActionRowKey = null;
    }
    if (key.ctrl && key.name === "p") {
      this.#openCommandMenu();
      this.scheduleRender(true);
      return;
    }
    // Ctrl+P owns a separate search query and must leave the exact composer
    // draft untouched. A menu opened by typing `/`, however, is only an
    // inline suggestion surface: printable bytes still belong to the real
    // composer so direct commands such as `/image path` remain executable.
    if (
      this.#commandMenu
      && this.#commandMenuDraft
      && !key.ctrl
      && !key.meta
      && isPrintableKeypressText(character)
    ) {
      this.#commandMenu = {
        ...this.#commandMenu,
        query: `${this.#commandMenu.query}${character}`,
        selectedIndex: 0,
      };
      this.scheduleRender(true);
      return;
    }
    if (
      this.#commandMenu
      && this.#commandMenuDraft === null
      && (key.name === "return" || key.name === "enter")
      && resolveSlashCommand(this.#inputChars.join(""))
    ) {
      this.#submit();
      return;
    }
    if (this.#commandMenu && this.#handleCommandMenuKey(key)) return;
    if (this.#atToken() && !this.#atClosed && this.#handleAtKey(key)) return;
    if (key.name === "return") {
      this.#submit();
      return;
    }
    // A6: Esc closes an open accessory (handled above); with nothing open and
    // no run active, it must not silently wipe the buffer (the bug this
    // replaced) — it stays unbound.
    // Phase 3b, Part C: with a run active, esc's meaning is state-dependent —
    // deterministic on view-model state, never a timing heuristic. While
    // reasoning streams live, esc ends only the thinking (the run continues);
    // otherwise esc keeps the existing run-abort meaning (`#requestCancel`,
    // today only reachable via Ctrl+C).
    if (key.name === "escape") {
      if (this.#mode === "busy") {
        if (this.#vm.reasoningLive) this.#endThinkingHandler?.();
        else this.#requestCancel();
      }
      return;
    }
    this.#editInput(character, key, true);
    this.#syncSlashCommandMenu();
    if (!this.#atToken()) this.#atClosed = false;
    this.scheduleRender(this.#inputChars[0] === "/");
  };

  #onTerminalData = (chunk: string | Buffer): void => {
    if (!this.#active) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let buffered = this.#mouseProtocolBuffer;
    let sequence = `${buffered}${text}`;
    let openToken = this.#openMouseKeypressToken;
    let recoverBufferedPrefix = this.#mouseProtocolBufferRecovery;
    this.#mouseProtocolBuffer = "";
    this.#mouseProtocolBufferRecovery = false;
    this.#openMouseKeypressToken = null;

    if (openToken?.malformed) {
      const capacity = Math.max(0, MAX_MOUSE_SEQUENCE_LENGTH - openToken.raw.length);
      let freshCursor = 0;
      let recoveryEscape = false;
      while (freshCursor < text.length && freshCursor < capacity) {
        const value = text[freshCursor]!;
        if (/[\d;]/u.test(value)) {
          openToken.raw += value;
          freshCursor += 1;
          continue;
        }
        if (value === "M" || value === "m") {
          openToken.raw += value;
          freshCursor += 1;
          openToken.complete = true;
        } else {
          openToken.complete = true;
          recoveryEscape = value === "\u001b";
        }
        break;
      }
      if (
        !openToken.complete
        && freshCursor === text.length
        && openToken.raw.length < MAX_MOUSE_SEQUENCE_LENGTH
      ) {
        this.#mouseProtocolBuffer = openToken.raw;
        this.#openMouseKeypressToken = openToken;
        return;
      }
      if (!openToken.complete) openToken.complete = true;
      buffered = "";
      sequence = text.slice(freshCursor);
      openToken = null;
      recoverBufferedPrefix = recoveryEscape
        && sequence.length < 3
        && "\u001b[<".startsWith(sequence);
    }

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
      if (
        terminator < 0
        && nextEscape < 0
        && rest.length < MAX_MOUSE_SEQUENCE_LENGTH
      ) {
        if (sequence.length > freshStart) token.raw += sequence.slice(freshStart);
        token.malformed = true;
        token.click = null;
        this.#mouseProtocolBuffer = token.raw;
        this.#openMouseKeypressToken = token;
        break;
      }
      const terminatorEnd = terminator >= 0
        ? escape + 3 + terminator + 1
        : Math.min(sequence.length, escape + MAX_MOUSE_SEQUENCE_LENGTH);
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
    const openToken = this.#openMouseKeypressToken;
    const keepOpenToken = Boolean(
      openToken
      && !openToken.complete
      && openToken.raw.length <= MAX_MOUSE_SEQUENCE_LENGTH
      && this.#mouseProtocolBuffer.length <= MAX_MOUSE_SEQUENCE_LENGTH,
    );
    // An ambiguous ESC / ESC[ prefix is still held by readline's decoder as
    // well. Dropping it here would desynchronise both parsers: the frame that
    // completes it in the next chunk would then reach the new mode as text.
    const ambiguousPrefix = this.#mouseProtocolBuffer.length > 0
      && this.#mouseProtocolBuffer.length < 3
      && "\u001b[<".startsWith(this.#mouseProtocolBuffer);
    const keepRecoveryBuffer = Boolean(
      !keepOpenToken
      && (this.#mouseProtocolBufferRecovery || ambiguousPrefix)
      && this.#mouseProtocolBuffer.length <= MAX_MOUSE_SEQUENCE_LENGTH,
    );
    this.#mouseKeypressTokens = this.#mouseKeypressTokens.filter((token) => {
      const pendingComplete = token.complete && token.consumed < token.raw.length;
      const pendingOpen = keepOpenToken && token === openToken;
      if (!pendingComplete && !pendingOpen) return false;
      token.click = null;
      return true;
    });
    if (!keepOpenToken) this.#openMouseKeypressToken = null;
    if (!keepOpenToken && !keepRecoveryBuffer) {
      this.#mouseProtocolBuffer = "";
      this.#mouseProtocolBufferRecovery = false;
    }
  }

  #createMouseKeypressToken(): MouseKeypressToken {
    const token: MouseKeypressToken = {
      raw: "",
      consumed: 0,
      complete: false,
      malformed: false,
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
      if (!expected) {
        if (token.malformed && !token.complete) {
          token.complete = true;
          this.#finishConsumedMouseTokens();
          continue;
        }
        return null;
      }
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
    if (passthroughSuffix) {
      if (key.meta && !key.ctrl && chars.length === 1 && chars[0]! >= " ") {
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
      return {
        character: typeof character === "string" ? character : "",
        key: { ...key, sequence: remainder },
      };
    }
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
    return null;
  }

  #enableMouseReporting(): void {
    if (!this.#active || this.#mouseReporting) return;
    this.#retireMouseProtocol();
    this.#mouseReporting = true;
    this.stdout.write(ENABLE_SGR_MOUSE);
  }

  #syncMouseReporting(): void {
    // orcode 0.7: Settings and every nested Settings editor are keyboard-only.
    // SGR mouse reporting belongs solely to the generic non-Settings pickers.
    const wanted = this.#active
      && this.#surface !== "settings"
      && this.#returnSurface !== "settings"
      && (this.#mode === "model-picker" || this.#mode === "choice-picker");
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
    // Settings never enable mouse reporting; a stray SGR click must not act.
    if (this.#surface === "settings" || this.#returnSurface === "settings") return;
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
    const frame = this.frame();
    // Fix round 1 (review MAJOR 1): the frame REPORTS where it put the rows
    // (`Frame.listRows`, derived by `listWindow` from the same budget
    // `buildListLines` was given), so this no longer re-derives a row count
    // from a hand-copied `height >= 20 ? 6 : 4`, and no longer hunts for the
    // divider by role. That copy did not know the list's own chrome costs
    // rows, so V4-A's title bar shifted the window one row and every click on
    // the fullscreen model picker became a silent no-op — or, with substring
    // model ids (`glm-4` inside `glm-4-air`), resolved the wrong row. A zone
    // added above or below the rows now moves the pointer's map with it.
    const geometry = frame.listRows;
    if (!geometry) return;
    const offset = (row - 1) - geometry.firstLine;
    if (offset < 0 || offset >= geometry.count) return;
    const item = items[geometry.startIndex + offset];
    const line = frame.lines[row - 1];
    if (!item || !line) return;
    // `#listView` builds one entry per item, in order, so the entry index the
    // frame reported IS this item's index. A non-selectable row (a `/chats`
    // section heading, an unavailable provider) must still refuse the click —
    // keyboard navigation already steps past those (`stepSelectableListIndex`)
    // and Enter already rejects them (`isListEntryDisabled`).
    const entry = models
      ? { name: (item as ModelInfo).id }
      : {
          name: (item as ChoicePickerItem).label,
          sectionHeading: (item as ChoicePickerItem).sectionHeading,
        };
    if (isListEntryDisabled(entry)) return;
    // A last sanity check that the addressed line really is this row: the row
    // opens with a two-cell marker column and then the name. Anchored, not a
    // substring search — `includes` would let `glm-4` pass on a `glm-4-air`
    // row, which is exactly the wrong-model resolve this fix exists to close.
    if (!plainText(line).slice(2).startsWith(entry.name)) return;
    this.#resolveSelection(item);
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
      // Audit FIX-1 (2026-08-28): a single Ctrl+C here used to close orcode
      // instantly — discarding a typed draft without warning. The idle
      // prompt now follows the same two-press convention `#requestCancel`
      // already uses during runs: the first press clears the draft (if any)
      // and shows the transient hint; only a second press while that hint
      // is still fresh closes orcode. A press while a draft exists never
      // quits — it only clears the draft and (re)arms the window.
      const hasDraft = this.#inputChars.length > 0;
      const armed =
        this.#exitArmedAt > 0 && Date.now() - this.#exitArmedAt < STATUS_FRESH_MS;
      if (!hasDraft && armed) {
        const reject = this.#inputReject;
        this.#clearInputPromise();
        reject(new UiExitError());
        return;
      }
      if (hasDraft) {
        this.#resetQuery();
        this.#commandMenu = null;
        this.#commandMenuDraft = null;
        this.#historyActive = false;
      }
      this.#exitArmedAt = Date.now();
      this.setStatus("Ctrl+C again closes orcode", false);
      this.scheduleRender(true);
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

  #openCommandMenu(): void {
    if (!this.#commandMenu) {
      this.#commandMenuDraft = { chars: [...this.#inputChars], cursor: this.#cursor };
      this.#commandMenu = { path: [], query: "", selectedIndex: 0 };
    }
  }

  #commandMenuRuntime(): ReadonlyMap<SlashCommandHandlerId, { readonly current?: string; readonly disabledReason?: string }> {
    if (this.#commandMenuRuntimeOverride) return this.#commandMenuRuntimeOverride();
    const state = this.getState();
    return new Map([
      ["model", { current: state.model }],
      ["think", { current: state.reasoning }],
      ["allow", { current: state.approval }],
      // FIX-15: `/budget`'s annotation is the BUDGET. It used to read
      // `state.maxCost` — the value `/max-cost` owns, one row below it in the
      // same group — so the palette confidently stated the wrong setting.
      ["budget", { current: state.budget }],
      ["max-cost", { current: state.maxCost }],
      ["steps", { current: String(state.maxSteps) }],
    ]);
  }

  #syncSlashCommandMenu(): void {
    const input = this.#inputChars.join("");
    const dismissed = this.#dismissedCommandMenuInput;
    if (dismissed && (input === dismissed || input.startsWith(`${dismissed.trimEnd()} `))) return;
    this.#dismissedCommandMenuInput = null;
    if (input.startsWith("/")) {
      this.#commandMenuDraft = null;
      this.#commandMenu = { path: [], query: input.slice(1), selectedIndex: 0 };
    } else if (this.#commandMenuDraft === null) {
      this.#commandMenu = null;
    }
  }

  /** Returns true when the key belonged to the shared command menu. */
  #handleCommandMenuKey(key: Key): boolean {
    const menu = this.#commandMenu;
    if (!menu) return false;
    // At the inline slash root, Backspace edits the composer just like every
    // other normal CLI byte. Ctrl+P and nested menu levels keep their own
    // query/back-navigation behavior.
    if (key.name === "backspace" && this.#commandMenuDraft === null && menu.path.length === 0) {
      return false;
    }
    // The one shared data path: an empty query browses `menu.path` (tree
    // nodes), any other query searches every executable leaf globally (a
    // recovery row stands in for zero matches). Ctrl+P and inline `/`
    // completion both flow through this same call.
    const rows = resolveCommandMenuRows(menu);
    const selected = rows[menu.selectedIndex];
    const intent = interpretListKey(key);
    if (intent === "up" || intent === "down") {
      const step = intent === "up" ? -1 : 1;
      this.#commandMenu = { ...menu, selectedIndex: stepListIndex(menu.selectedIndex, rows.length, step) };
    } else if (key.name === "escape") {
      if (menu.path.length) this.#commandMenu = { path: menu.path.slice(0, -1), query: "", selectedIndex: 0 };
      else this.#closeCommandMenu();
    } else if ((key.name === "tab" || key.name === "return") && selected) {
      if (selected.kind === "recovery") {
        // Never a dead end: drop the failed query and open the root tree.
        // Ctrl+P's own pre-palette draft is untouched — only the menu's own
        // query/path resets — but inline `/` typing has no separate draft,
        // so the composer itself held the failed query and must be cleared
        // back to a bare slash, or the very next render would resurrect it.
        if (this.#commandMenuDraft === null) {
          this.#inputChars = ["/"];
          this.#cursor = 1;
        }
        this.#commandMenu = { path: [], query: "", selectedIndex: 0 };
      } else if (selected.kind === "match") {
        const entry = selected.entry;
        this.#activateCommandLeaf(
          entry.handlerId as SlashCommandHandlerId,
          entry.name,
          "acceptsArguments" in entry && entry.acceptsArguments === true,
          key.name,
        );
      } else if (selected.node.kind === "branch") {
        const branch = selected.node;
        if (branch.handlerId && key.name === "return") {
          if (branch.handlerId === "collab-cross" && this.#commandMenuDraft) {
            this.#crossCommandDraft = {
              chars: [...this.#commandMenuDraft.chars],
              cursor: this.#commandMenuDraft.cursor,
            };
          }
          // FIX-15: no branch-specific spelling any more. This used to read
          // `handlerId === "collab-cross" ? "/cross" : …` because the branch's
          // own name ("cross") sat under a `collab` umbrella that its command
          // token did not want; the umbrella is now only a compatibility
          // alias, so every actionable branch inserts its own name.
          const command = `/${branch.name}`;
          this.#inputChars = Array.from(command);
          this.#cursor = this.#inputChars.length;
          this.#commandMenu = null;
          this.#commandMenuDraft = null;
          this.#dismissedCommandMenuInput = command;
        } else {
          this.#commandMenu = { path: [...menu.path, branch.name], query: "", selectedIndex: 0 };
        }
      } else {
        // A browse-mode leaf: its own `.name` is level-local (e.g. "run"
        // inside "cross"), so its canonical dotted path is looked up
        // by handler id — a global search match already carries that
        // canonical name directly and needs no such lookup.
        const leaf = selected.node;
        const canonicalName = flattenCommandTree(COMMAND_TREE).find(
          (candidate) => candidate.handlerId === leaf.handlerId,
        )?.name ?? leaf.name;
        this.#activateCommandLeaf(
          leaf.handlerId as SlashCommandHandlerId,
          canonicalName,
          leaf.acceptsArguments === true,
          key.name,
        );
      }
    } else if (key.name === "backspace" && !menu.query) {
      if (menu.path.length) this.#commandMenu = { path: menu.path.slice(0, -1), query: "", selectedIndex: 0 };
      else this.#closeCommandMenu();
    } else if (key.name === "backspace" && menu.query) {
      this.#commandMenu = { ...menu, query: Array.from(menu.query).slice(0, -1).join(""), selectedIndex: 0 };
    } else {
      return false;
    }
    this.scheduleRender(true);
    return true;
  }

  /**
   * Shared tail for both a browse-mode leaf and a global search match:
   * reject a disabled handler with a status message, or replace the
   * composer with its canonical `/name` (plus a trailing space on Tab for
   * an argument-taking command) and close the menu.
   *
   * FIX-11 (rendered truth, controller ruling): on Enter, a leaf that takes
   * NO arguments is also SUBMITTED right here. The palette footer promised
   * `Enter run` while every leaf merely filled the composer and waited for
   * a second Return — for `/clear`, `/diff`, `/status` and friends there is
   * nothing left to type, so that second Return was ceremony the footer
   * never mentioned. A leaf that DOES take arguments still only fills the
   * composer (the footer says `Enter insert` for it, `commandMenuEnterVerb`
   * in ui/command-menu.ts), because running it immediately would discard
   * the argument the palette was opened to type. Tab is untouched at every
   * leaf: it inserts, argument-taking or not.
   */
  #activateCommandLeaf(
    handlerId: SlashCommandHandlerId,
    canonicalName: string,
    acceptsArguments: boolean,
    keyName: string,
  ): void {
    if (this.#commandMenuRuntime().get(handlerId)?.disabledReason) {
      this.setStatus("Command is not available right now", false);
      return;
    }
    // The one-shot palette→command draft bridge, identical to the
    // `collab-cross` branch above and gated the same way (Return only —
    // Tab hands the owner an argument-taking `/architect ` to finish
    // typing, so their inline text, not a hidden draft, is the task).
    // Without this, bare `/architect` could only ever see an empty draft
    // in production and always refused (Phase 14 review, finding 2).
    if (handlerId === "architect" && keyName === "return" && this.#commandMenuDraft) {
      this.#crossCommandDraft = {
        chars: [...this.#commandMenuDraft.chars],
        cursor: this.#commandMenuDraft.cursor,
      };
    }
    this.#inputChars = Array.from(`/${canonicalName}${keyName === "tab" && acceptsArguments ? " " : ""}`);
    this.#cursor = this.#inputChars.length;
    this.#commandMenu = null;
    this.#commandMenuDraft = null;
    this.#dismissedCommandMenuInput = this.#inputChars.join("");
    if (keyName === "return" && !acceptsArguments) {
      // `#submit` empties the composer, so there is no filled-in text left
      // for the dismissal guard to protect against a reopening menu.
      this.#dismissedCommandMenuInput = null;
      this.#submit();
    }
  }

  #closeCommandMenu(): void {
    if (this.#commandMenuDraft) {
      this.#inputChars = [...this.#commandMenuDraft.chars];
      this.#cursor = this.#commandMenuDraft.cursor;
    }
    this.#commandMenu = null;
    this.#commandMenuDraft = null;
    this.#dismissedCommandMenuInput = this.#inputChars.join("");
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
    this.#commandMenu = null;
    this.#commandMenuDraft = null;
    if (this.#mode === "busy") {
      if (!value) {
        this.scheduleRender(true);
        return;
      }
      // Phase 3b, Part B: a registered interject handler means a run is
      // actively steerable — the line feeds the RUNNING task now instead of
      // `#queuedInputs`'s next-run fallback (kept below for callers that
      // never opt into interjections, so typed text is never lost).
      if (this.#interjectHandler) {
        this.#vm.pushInterjection(value);
        this.#interjectHandler(value);
        // Fix round 1, Minor: English, matching the interjection glyph/
        // confirmation footer and the input hint — all born-new steering
        // copy the Terminal-Look spec keeps in English (principle 7).
        this.#enterMode("busy", "Interjection queued · run continues");
        return;
      }
      // FIX-19 finding 5: "queued for the next run · current run keeps
      // going" is only true while something is actually running. During a
      // gate that merely LOOKS busy — provider activation at startup, a
      // credential check — nothing is running, and the owner was told a
      // run was continuing while the terminal sat still. Worse, a slash
      // command typed there was silently reclassified as a MESSAGE: the
      // picker it named never opened, and the text later vanished into a
      // refusal. A run owns this line when it has a snapshot or a cancel
      // handler; anything else is a gate, and a gate does not queue
      // commands.
      const runOwnsTheLine = this.#run !== null || this.#cancelHandler !== null;
      if (!runOwnsTheLine && value.startsWith("/")) {
        this.#inputChars = Array.from(value);
        this.#cursor = this.#inputChars.length;
        this.#enterMode(
          "busy",
          `${this.#status} — commands wait for it · your text stays · Enter again in a moment`,
        );
        return;
      }
      this.#queuedInputs.push(value);
      const count = this.#queuedInputs.length;
      this.#enterMode(
        "busy",
        runOwnsTheLine
          ? `${count} message${count === 1 ? "" : "s"} queued for the next run · current run keeps going`
          : `${count} message${count === 1 ? "" : "s"} queued · nothing is running yet`,
      );
      return;
    }
    const resolve = this.#inputResolve;
    this.#clearInputPromise();
    this.#enterMode("busy", value ? "Processing input" : "Ready");
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
    if (models && this.#pickerMultiple && interpretListKey(key) === "toggle") {
      const selected = this.#pickerModels[this.#selectedIndex];
      if (selected) {
        const result = toggleListMultiSelect(this.#pickerSelected, selected.id, LIST_MULTI_SELECT_CAP);
        this.#pickerSelected.clear();
        for (const id of result.selected) this.#pickerSelected.add(id);
        this.#editorValidationMessage = result.rejected ? "At most five panel models are allowed" : "";
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
      } else {
        const chosen = items[this.#selectedIndex] ?? null;
        // A section heading is never a resolvable choice (workspace-mobility
        // Phase F1b's sectioned `/chats` list) — Enter is a no-op on it, same
        // as `isListEntryDisabled` already treats it everywhere else.
        if (!models && chosen && isListEntryDisabled({ sectionHeading: (chosen as ChoicePickerItem).sectionHeading })) return;
        this.#resolveSelection(chosen);
      }
      return;
    }
    const intent = interpretListKey(key);
    const step =
      intent === "up"
        ? -1
        : intent === "down"
          ? 1
          : intent === "pageUp"
            ? -LIST_PAGE_STEP
            : intent === "pageDown"
              ? LIST_PAGE_STEP
              : 0;
    if (step !== 0) {
      const stepEntries = items.map((item) => ({
        name: "",
        sectionHeading: models ? false : Boolean((item as ChoicePickerItem).sectionHeading),
      }));
      this.#selectedIndex = stepSelectableListIndex(stepEntries, this.#selectedIndex, step);
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
            this.#editorValidationMessage = "Model cache could not be read";
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
    const query = this.#editorChars.join("");
    if (!query.trim()) {
      // Unfiltered: keep section headings (workspace-mobility Phase F1b's
      // "current folder" / "Other folders" split) in their catalog order.
      this.#choiceItems = [...this.#choiceAll];
      const index = this.#choiceItems.findIndex((item) => item.value === this.#choiceInitial);
      this.#selectedIndex = this.#firstSelectableChoiceIndex(Math.max(0, index));
      return;
    }
    // A live search flattens sections outright — a heading never matches
    // typed text and would otherwise survive as an orphaned, unlabeled row.
    const selectable = this.#choiceAll.filter((item) => !item.sectionHeading);
    this.#choiceItems = filterListEntries(selectable, query, (item) => ({
      name: item.label,
      description: item.description,
      ...(item.descriptionParts ? { descriptionParts: item.descriptionParts } : {}),
      haystack: item.value,
    }));
    this.#selectedIndex = 0;
  }

  /** The first selectable (non-heading) `#choiceItems` index at or after `from`. */
  #firstSelectableChoiceIndex(from: number): number {
    if (!this.#choiceItems[from]?.sectionHeading) return Math.max(0, from);
    const entries = this.#choiceItems.map((item) => ({ name: "", sectionHeading: Boolean(item.sectionHeading) }));
    return stepSelectableListIndex(entries, from, 1);
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
    this.#choiceTitle = "";
    this.#selectedIndex = 0;
    this.#resetEditor();
    if (pickerResolve) pickerResolve((value as ModelInfo | null) ?? null);
    choiceResolve?.((value as ChoicePickerItem | null) ?? null);
    this.#restoreCapturedSurface(
      "busy",
      value ? "Applying selection" : "Selection cancelled",
    );
  }

  #resolveSecret(value: string | null): void {
    const resolve = this.#secretResolve;
    // The hidden editor owns the authoritative bytes. Callers can only choose
    // submit vs cancel; they cannot substitute the chat draft or another buffer.
    const submitted = value === null ? null : this.#editorChars.join("");
    this.#secretResolve = null;
    this.#secretLabel = "";
    this.#secretEscHint = null;
    this.#pasting = false;
    this.#pasteBuffer = "";
    this.#resetEditor();
    resolve?.(submitted);
    this.#restoreCapturedSurface(
      "busy",
      submitted === null ? "Input cancelled" : "Checking key",
    );
  }

  #resolveRecording(action: "stop" | "cancel"): void {
    const resolve = this.#recordingResolve;
    this.#recordingResolve = null;
    resolve?.(action);
    this.#restoreCapturedSurface(
      "busy",
      action === "stop" ? "Processing recording" : "Recording cancelled",
    );
  }

  #resolveConfirm(decision: ApprovalDecision): void {
    const resolve = this.#confirmResolve;
    this.#confirmResolve = null;
    this.#confirmReasonMode = false;
    this.#confirmRememberAvailable = false;
    this.#confirmDanger = false;
    this.#confirmEnterDeclines = false;
    this.#confirmReasonBound = false;
    this.#resetEditor();
    if (this.#approvalBlockId) {
      this.#vm.dropApproval(this.#approvalBlockId);
      this.#approvalBlockId = null;
    }
    resolve?.(decision);
    this.#restoreCapturedSurface(
      "busy",
      decision.accepted ? "Approval granted" : "Approval denied",
    );
  }

  /**
   * Audit FIX-1: the Shift+Tab cycle — ask → auto-edit → read-only → ask.
   * allow-all is NEVER entered from here: it stays exclusively behind
   * /allow's explicit danger confirm. An unknown current mode — including
   * allow-all — enters the cycle at "ask", so from allow-all the key can
   * only leave in the safe direction. Persistence goes through the ONE
   * registered sink (see `setApprovalModeHandler`), which reuses /allow's
   * own path; without a sink the key stays inert instead of announcing a
   * change nothing stored.
   */
  #cycleApprovalMode(): void {
    const handler = this.#approvalModeHandler;
    if (!handler) return;
    const current = this.getState().approval;
    const index = SHIFT_TAB_APPROVAL_CYCLE.indexOf(current as CycledApprovalMode);
    const next = SHIFT_TAB_APPROVAL_CYCLE[(index + 1) % SHIFT_TAB_APPROVAL_CYCLE.length]!;
    handler(next);
    // Direct status write (the `#requestCancel` precedent): `setStatus`
    // with `busy: false` would flip a running "busy" mode back to "idle",
    // which this announcement must not do.
    this.#status = `Approvals: ${next}`;
    this.#statusAt = Date.now();
    this.scheduleRender(true);
  }

  #requestCancel(): void {
    if (this.#cancelRequestedAt && !this.#cancelHandler) {
      this.#terminate("SIGINT");
      return;
    }
    if (!this.#cancelHandler) {
      this.setStatus("This operation cannot be cancelled right now.", false);
      return;
    }
    this.#cancelRequestedAt = Date.now();
    this.#status = "Cancel requested · Ctrl+C again closes orcode immediately";
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
      this.setStatus("Paste contained no usable text", false);
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
          this.#editorValidationMessage = "Model cache could not be read";
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
    this.#syncSlashCommandMenu();
    this.setStatus(
      `${chars.length.toLocaleString("en-US")} character${chars.length === 1 ? "" : "s"} · ${lines} line${
        lines === 1 ? "" : "s"
      } pasted · Enter sends everything together`,
      false,
    );
    this.scheduleRender(true);
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

  /** Fuzzy-scored workspace files for `@`, analogous to `list-core.ts`'s `scoreListEntry` — a path completion, not a picker, so it stays its own small scorer. */
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
