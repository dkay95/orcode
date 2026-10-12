/**
 * The GUI sidecar's wire protocol — types, projections and the outbound
 * secret boundary. No I/O: everything here is a pure function of a value,
 * so the boundary rules are testable without a process.
 *
 * Shape (G0 §3.1): one JSON object per line, `{"v":2,"t":…}`. `v` is the
 * PROTOCOL version and moves only on a breaking change to an existing
 * message; a new `t` or a new optional field is not breaking.
 *
 * **Handshake.** `hello` is the first frame the server writes, and no
 * REQUEST is served before `hello-ack` — an early one is refused with
 * `handshake-required`, and a version mismatch is refused outright and
 * followed by `fatal`, never a degraded mode.
 *
 * EVENTS are a different matter, and a client must be ready for this: the
 * session starts as soon as the process does, so `status`, `notice` and
 * `fatal` frames CAN precede the ack. That is deliberate. Buffering them
 * until a client acks would hide a startup failure from precisely the client
 * that never gets far enough to ack, and every frame is versioned, so an
 * early one is readable on its own. A client should therefore treat events
 * as valid from the first byte, and treat `hello` as "the engine is
 * speaking" — not as "the engine is ready". Readiness is the first
 * successful `status.get`.
 *
 * **Shutdown.** Three triggers, one path: a `shutdown` request, a `/quit`
 * command, or stdin EOF (the client closing its end — the only reliable
 * parent-death signal on macOS). `shutdown` and EOF cancel an in-flight run
 * through the run's own cancel handler; `/quit` is a COMMAND and is refused
 * with `run-active` while a run is live, exactly as the dashboard cannot
 * type one mid-run. Whichever trigger fires, the path is the same: cancel
 * (where applicable), drain under a bound, save once, end the process. A
 * client does not need to close the pipe to make the sidecar exit, and
 * closing it is enough on its own if the client is gone.
 *
 * The protocol SERIALIZES existing truths. It never re-derives one: the run
 * stream is `AgentRunEvent` 1:1, the palette is the command catalog, the
 * Settings screen is Foundation's closed `DesktopSettingsView`, the confirm grammar is D4's own
 * `danger`/`defaultAccept` pair. Anything this file computes is a
 * projection that REMOVES fields, never one that invents them.
 */

import type { AgentRunEvent, ChatSummary, NoticeKind, ToolCallPreview } from "./types.js";
import type { DesktopCrossPreflightView } from "./cross-gate.js";
import type { SetupHubEntry, SetupPresentation } from "./setup-surface/index.js";
import type {
  DesktopActivity,
  DesktopActivityMessageCode,
  DesktopActivityMessagePresentation,
  DesktopCapabilitySnapshot,
  DesktopCommandDisabledPresentation,
  DesktopCommandPresentation,
  DesktopDataPolicyKnowledge,
  DesktopDisabledPresentation,
  DesktopModelCapability,
  DesktopOnboardingIntent,
  DesktopOnboardingView,
  DesktopSettingsDisabledPresentation,
  DesktopSettingsEditorDecision,
  DesktopSettingsEditorPresentation,
  DesktopSettingsIntent,
  DesktopSettingsNoticeCode,
  DesktopSettingsNoticePresentation,
  DesktopSettingsRow,
  DesktopSettingsView,
  NativeLocalActionRequirement,
} from "./desktop-contracts.js";
import { commandMenuEnterVerb, type CommandMenuRow } from "./ui/command-menu.js";
import { assertNoPrivateProviderStateLeaves } from "./provider-state.js";
import { redactValue } from "./redaction.js";

/** Bumped only when an existing message changes shape. */
export const GUI_PROTOCOL_VERSION = 2;

/* -------------------------------------------------------------------------
 * Message-type inventory
 * ---------------------------------------------------------------------- */

/** Client → server. */
export const GUI_REQUEST_TYPES = Object.freeze([
  "hello-ack",
  "submit",
  "cancel",
  "interject",
  "end-thinking",
  "command",
  "catalog.level",
  "catalog.search",
  "chats.list",
  "chat.open",
  "chat.new",
  /**
   * G3: destructive, so it was deliberately held back until there was a D4
   * danger ask to put in front of it. It is a typed front door onto
   * `/chat delete`'s one implementation, never a second deletion path.
   *
   * **G4 ruling — a chat in another folder stays refused, by design.**
   * `/chat delete` resolves its target through `SessionStore.list` over the
   * CURRENT folder, so the terminal cannot delete a foreign chat either. The
   * limit therefore belongs to the shared command, not to this surface, and
   * the two ways to lift it were both worse than living with it:
   *
   *  * reaching across folders from the sidecar would be the second deletion
   *    path this request exists to avoid — a destructive operation that only
   *    one of the two surfaces can perform;
   *  * widening the core command would change what a destructive command
   *    means on every surface, in the last phase, without an owner ruling.
   *
   * So the refusal stays and is made actionable instead: it names the folder
   * the chat actually lives in and the one move that reaches it (open it,
   * which re-roots the runtime, then delete). If this turns out to be the
   * common case, the fix is still the core-side one the G3 review named —
   * `SessionStore.remove` already takes a workspace — with the same D4 ask
   * naming the folder, and it lands for both surfaces at once.
   */
  "chat.delete",
  "status.get",
  /**
   * The pre-submit band the terminal's status line shows (G2 concern 2).
   * A REQUEST, not an event: the client owns the draft and asks when the
   * draft changed, which is exactly when the figure can change.
   */
  "cost.forecast",
  "settings.open",
  "settings.dispatch",
  "desktop.snapshot.get",
  "onboarding.dispatch",
  "settings.close",
  "answer",
  "shutdown",
] as const);
export type GuiRequestType = (typeof GUI_REQUEST_TYPES)[number];

/** Server → client, unsolicited. Carried as `{t:"event", e:<name>}`. */
export const GUI_EVENT_NAMES = Object.freeze([
  "run",
  "assistant",
  "status",
  "transcript",
  "suggestions",
  "context-percent",
  "attachments",
  "draft",
  "command-output",
  /**
   * G4: the live Cross panel's own frame — `CrossCommandRuntime`'s
   * `dashboardState()` projection, which is the SAME bounded object the
   * dashboard's panel renders (raw prompts, account ids and worker text
   * never enter it). `state: null` means no panel, decided by the
   * dashboard's own rule rather than by the client.
   */
  "cross",
  "settings.view",
  "settings.closed",
  "desktop.snapshot",
  "onboarding.view",
  "activity",
  "native-local-action-required",
  "setup.present",
  "chat.opened",
  "chat.reset",
  "notice",
  "fatal",
] as const);
export type GuiEventName = (typeof GUI_EVENT_NAMES)[number];

/** Server → client, awaiting a human answer. Carried as `{t:"ask", kind:…}`. */
export const GUI_ASK_KINDS = Object.freeze([
  "confirm",
  "approval",
  "folder-path",
  "secret",
  /** The generic picker: a server-minted candidate list, chosen by opaque id. */
  "choice",
  "choose-hub",
  "choose-model",
  "settings-editor",
] as const);
export type GuiAskKind = (typeof GUI_ASK_KINDS)[number];

/** Server → client, structural frames that are neither event nor ask. */
export const GUI_SERVER_FRAME_TYPES = Object.freeze([
  "hello",
  "response",
  "event",
  "ask",
] as const);

/**
 * Every distinct message the protocol can carry, counted once.
 * Pinned in the test suite so a silent addition is visible in review.
 */
export const GUI_PROTOCOL_MESSAGE_TYPES: readonly string[] = Object.freeze([
  ...GUI_REQUEST_TYPES,
  ...GUI_SERVER_FRAME_TYPES,
  ...GUI_EVENT_NAMES.map((name) => `event:${name}`),
  ...GUI_ASK_KINDS.map((kind) => `ask:${kind}`),
]);

/* -------------------------------------------------------------------------
 * Envelope
 * ---------------------------------------------------------------------- */

export interface GuiHello {
  readonly v: number;
  readonly t: "hello";
  readonly protocol: number;
  readonly orcode: string;
  readonly node: string;
  readonly pid: number;
  readonly capabilities: readonly string[];
}

export interface GuiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

export type GuiResponse =
  | { readonly v: number; readonly t: "response"; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly v: number; readonly t: "response"; readonly id: string; readonly ok: false; readonly error: GuiErrorBody };

export interface GuiEvent {
  readonly v: number;
  readonly t: "event";
  readonly e: GuiEventName;
  readonly [key: string]: unknown;
}

export interface GuiAsk {
  readonly v: number;
  readonly t: "ask";
  readonly askId: string;
  readonly kind: GuiAskKind;
  readonly [key: string]: unknown;
}

export type GuiServerMessage = GuiHello | GuiResponse | GuiEvent | GuiAsk;

export interface GuiRequest {
  readonly v?: number;
  readonly t: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}

export interface DesktopSnapshotGetRequest {
  readonly v: 2;
  readonly t: "desktop.snapshot.get";
}

export interface DesktopOnboardingDispatchRequest {
  readonly v: 2;
  readonly t: "onboarding.dispatch";
  readonly intent: DesktopOnboardingIntent;
}

export interface DesktopSettingsDispatchRequest {
  readonly v: 2;
  readonly t: "settings.dispatch";
  readonly intent: DesktopSettingsIntent;
}

export interface DesktopSettingsCloseRequest {
  readonly v: 2;
  readonly t: "settings.close";
}

export interface GuiDesktopSnapshotEvent {
  readonly snapshot: DesktopCapabilitySnapshot;
}

export interface GuiOnboardingViewEvent {
  readonly view: DesktopOnboardingView;
}

export interface GuiActivityEvent {
  readonly activity: DesktopActivity;
}

/** A display-only local-action requirement; matching stays on the private pipe. */
export interface GuiNativeLocalActionRequiredEvent {
  readonly requirement: NativeLocalActionRequirement;
}

/* -------------------------------------------------------------------------
 * Ask payloads — the D4 grammar, spelled out
 * ---------------------------------------------------------------------- */

/**
 * D4 (approval.ts:53-61): `danger` inverts the default. Danger renders an
 * explicit Confirm control that is NEVER the default and prints the
 * consequence on its own line; ordinary accepts on Enter unless
 * `defaultAccept` is false — the third state, ordinary in presentation with
 * danger's key grammar. All three cross the wire as themselves.
 */
export interface GuiConfirmAsk {
  readonly title: string;
  readonly consequence?: string;
  readonly danger: boolean;
  readonly defaultAccept: boolean;
}

export interface GuiApprovalAsk {
  readonly preview: ToolCallPreview;
  readonly rememberAvailable: boolean;
  readonly reasonAvailable: boolean;
  /** Tool approvals are consent points: never a default-accepted control. */
  readonly danger: boolean;
}

export interface GuiSettingsEditorAsk {
  /** Closed Foundation presentation; registry authority stays server-side. */
  readonly editor: DesktopSettingsEditorPresentation;
}

export type GuiAnswer =
  | { readonly kind: "confirm"; readonly accepted: boolean }
  | { readonly kind: "approval"; readonly accepted: boolean; readonly remember?: "allow" | "deny"; readonly reason?: string }
  | { readonly kind: "folder-path"; readonly path: string | null }
  | { readonly kind: "secret"; readonly value: string | null }
  | { readonly kind: "choose-hub"; readonly id: string | null }
  | { readonly kind: "choose-model"; readonly id: string | null }
  | { readonly kind: "choice"; readonly value: string | null }
  | { readonly kind: "settings-editor"; readonly decision: DesktopSettingsEditorDecision };

/* -------------------------------------------------------------------------
 * Projections — allow-lists, never deny-lists (R-SEC-3)
 * ---------------------------------------------------------------------- */

/**
 * A Recent/chats row.
 *
 * Mirrors `DashboardState.recentChats` (dashboard-frame.ts:89-108), the
 * hand-written projection the TUI is safe because of:
 * `ChatSummary.route` carries an `accountFingerprint` into every row
 * (types.ts:307), so `ChatSummary` itself may never ship.
 */
export interface GuiChatRow {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly turnCount: number;
  readonly costUsd: number;
  readonly costKnowledge?: "known" | "unknown";
  readonly model?: string;
  readonly updatedAt: string;
  readonly workspaceVerified?: boolean;
}

export function projectChatRow(
  chat: ChatSummary & { readonly workspaceVerified?: boolean },
): GuiChatRow {
  return {
    id: chat.id,
    title: chat.title,
    workspace: chat.workspace,
    turnCount: chat.turnCount,
    costUsd: chat.costUsd,
    ...(chat.costKnowledge ? { costKnowledge: chat.costKnowledge } : {}),
    ...(chat.model ? { model: chat.model } : {}),
    updatedAt: chat.updatedAt,
    ...(chat.workspaceVerified === undefined
      ? {}
      : { workspaceVerified: chat.workspaceVerified }),
  };
}

/**
 * The status payload — every figure a tri-state, exactly as the TUI's.
 *
 * `remainingUsd: undefined` means the segment is ABSENT, never `0`
 * (commands.ts:5133-5134, :5226-5229). `providerManaged` is why a missing
 * number must not read as free. `costForecast` follows cost-forecast.ts's
 * own pair: `unknown` prints "cost unknown", `none` prints nothing at all.
 */
export interface GuiStatus {
  readonly model: string;
  readonly resolvedModel: string;
  readonly workspace: string;
  readonly chatId: string;
  readonly chatTitle: string;
  readonly approval: string;
  readonly routeConnected: boolean | undefined;
  readonly providerManaged: boolean;
  readonly balanceRemainingUsd: number | undefined;
  readonly balanceHedged: true;
  readonly lowBalanceThresholdUsd: number;
  readonly dayUsd: number | undefined;
  readonly sessionUsd: number;
  readonly sessionCostKnowledge: "known" | "unknown";
  readonly runActive: boolean;
  /**
   * What this process DERIVED for itself, and whether that allows the
   * owner-only provider paths. See `GUI_EXECUTION_MODE_TRUST_RULE`: a
   * launcher's claim about the mode is corroborating, never load-bearing,
   * so this is the derived value and nothing else.
   */
  readonly executionMode: string;
  readonly ownerPathsAllowed: boolean;
}

/**
 * What a chat switch changed, said once so a client never has to infer it.
 *
 * `rerooted` is the honesty half: opening a chat that lives in another folder
 * moves the whole runtime, and the TUI names the destination outright rather
 * than letting a workspace basename quietly change (FIX-20 finding 9). The
 * GUI gets the same sentence through the `status` event the surface already
 * emits; this frame carries the structured facts a hub row needs to redraw.
 */
export interface GuiChatOpened {
  readonly chatId: string;
  readonly title: string;
  readonly workspace: string;
  readonly rerooted: boolean;
  readonly turnCount: number;
  /**
   * `SessionStore.isUntouched` verbatim: no turns, no cost, still the default
   * title. `SessionStore.create()` never writes on its own, and every save
   * path skips a session in this state (D8c / FIX-20 finding 7's ghost-file
   * guard) — so while this is true nothing has been written for the chat and
   * `chats.list` will not show it. Naming a new chat clears it, because a
   * chat the owner named is no longer nothing.
   */
  readonly untouched: boolean;
}

/**
 * The transcript changed in a way an append-only client cannot follow.
 *
 * `/clear` empties the chat, `/new` and `/fork` replace it, `/compact`
 * rewrites it — the dashboard answers all of them with `ui.loadTurns(...)`,
 * and a GUI with no equivalent would render deleted history forever. This is
 * that answer, and it is derived from what the session actually holds rather
 * than from which command was typed: no client and no server re-derives a
 * truth by sniffing command names.
 */
export interface GuiChatReset {
  readonly chatId: string;
  readonly title: string;
  readonly workspace: string;
  readonly turnCount: number;
  readonly reason: "cleared" | "replaced";
}

/**
 * One palette row.
 *
 * The palette is the command CATALOG, and this projection removes nothing a
 * reader needs while adding nothing the catalog does not already know. The
 * one computed field is `verb`, and it is computed by
 * `commandMenuEnterVerb` — the exact function FIX-11 pinned for the
 * terminal's own footer, so the window can never promise a different Enter:
 *
 *   run    — an argument-less leaf; Enter executes it outright.
 *   insert — a leaf that takes arguments (running it would discard the
 *            argument the palette was opened to type), and the one
 *            actionable branch, whose Enter likewise fills the composer.
 *   open   — a browse branch (Enter descends), and the no-match recovery
 *            row (Enter clears the failed query).
 */
export interface GuiPaletteRow {
  readonly kind: "node" | "match" | "recovery";
  /** What the composer would receive: `/undo`, `/cross swap`. Absent on a branch. */
  readonly command?: string;
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly group?: string;
  readonly verb: "run" | "insert" | "open";
  readonly presentation: DesktopCommandPresentation;
}

export function projectPaletteRow(row: CommandMenuRow): GuiPaletteRow {
  const verb = commandMenuEnterVerb(row);
  if (row.kind === "recovery") {
    return {
      kind: "recovery",
      name: "Show all commands",
      description: `No matches for "${row.query}" — input will be cleared`,
      verb,
      presentation: palettePresentation(`No matches for "${row.query}" — input will be cleared`, verb),
    };
  }
  if (row.kind === "node") {
    const { node } = row;
    return node.kind === "command"
      ? {
          kind: "node",
          command: `/${node.name}`,
          name: `/${node.name}`,
          description: node.description,
          usage: node.usage,
          group: node.group,
          verb,
          presentation: palettePresentation(node.description, verb),
        }
      : {
          kind: "node",
          name: node.name,
          description: node.description,
          // An actionable branch (`cross`) inserts its own token; a browse
          // branch has no command at all, which is what `open` means.
          ...(node.handlerId ? { command: `/${node.name}` } : {}),
          verb,
          presentation: palettePresentation(node.description, verb),
        };
  }
  return {
    kind: "match",
    command: `/${row.entry.name}`,
    name: `/${row.entry.name}`,
    description: row.entry.description,
    usage: row.entry.usage,
    group: row.entry.group,
    verb,
    presentation: palettePresentation(row.entry.description, verb),
  };
}

function palettePresentation(
  description: string,
  verb: GuiPaletteRow["verb"],
): DesktopCommandPresentation {
  return {
    description,
    actionLabel: verb === "run" ? "Ausführen" : verb === "insert" ? "Einfügen" : "Öffnen",
  };
}

/**
 * `cost.forecast`'s answer — the same three states `cost-forecast.ts` has,
 * serialized without re-deriving one of them.
 *
 * `none` means NO SEGMENT AT ALL (silence over a guess, for an OpenRouter
 * route the cached catalog has no real price for); `unknown` means the route
 * is provider-managed and prints "cost unknown", which is not the same as
 * free; `band` carries the `~$min-max` the status line shows. `text` is
 * `formatPromptCostForecast`'s own output, so a client renders a string it
 * was given rather than formatting money itself.
 */
/**
 * The live Cross panel, as much of one as may leave the process.
 *
 * Phase, verification and reason remain the terminal's own labels. Each
 * live/last-run role is re-projected from its exact private identity through
 * the current Desktop route authority. Once settled, `selection` separately
 * carries the current next-run choice so a later swap never rewrites history
 * or appears to do nothing. No route identity or credential crosses.
 */
export interface GuiCrossRoute {
  readonly providerLabel: string;
  readonly accountLabel: string;
  readonly displayName: string;
  readonly canonicalModelId: string;
  readonly reasoning: "supported" | "unsupported" | "unknown";
  readonly capabilities: readonly DesktopModelCapability[];
}

export interface GuiCrossSelection {
  readonly lead: GuiCrossRoute | null;
  readonly challenger: GuiCrossRoute | null;
}

export interface GuiCrossPanel {
  readonly sequence: number;
  readonly updatedAt: number;
  readonly phase: string;
  readonly reason: string | null;
  readonly verification: string;
  readonly lead: GuiCrossRoute | null;
  readonly challenger: GuiCrossRoute | null;
  /** Current next-run selection, shown separately only after the run settles. */
  readonly selection?: GuiCrossSelection;
  readonly active?: boolean;
  readonly result?: string;
}

export interface GuiCrossEvent {
  readonly state: GuiCrossPanel | null;
  readonly preflight: DesktopCrossPreflightView | null;
}

export interface GuiCostForecast {
  readonly kind: "band" | "unknown" | "none";
  readonly text?: string;
  readonly minUsd?: number;
  readonly maxUsd?: number;
}

/**
 * The GUI sidecar's TRUST RULE for its execution mode (G2 concern 1).
 *
 * The shell states a fact about itself — it spawns the engine with
 * `ORCODE_GUI_SHELL` and `ORCODE_GUI_EXECUTION_MODE` — and the sidecar reads
 * those as CORROBORATION, never as authority. The mode stays what
 * `deriveProviderExecutionMode` derives from this process's own stdio, which
 * over a pipe is `piped`; a launcher-supplied mode is honoured only as a
 * DOWNGRADE (`TRUSTED_EXECUTION_MODE_DOWNGRADES`, cli.ts), and a claim of
 * `local-interactive-owner` is exactly the claim a hostile launcher would
 * make. Nothing about a process's parent is verifiable from inside it, so a
 * self-declared upgrade would be trust granted to an unauthenticated string.
 *
 * The technical fact remains available in `GuiStatus` and stderr diagnostics.
 * It is not emitted as chat-like public copy. The Desktop capability snapshot
 * owns the localized, actionable availability state for each provider, while
 * Settings, runs and Cross remain unaffected by this mode.
 */
export const GUI_EXECUTION_MODE_TRUST_RULE =
  "The engine derives its own execution mode. A launcher's claim about it is corroborating, never load-bearing.";

export interface GuiSettingsViewFrame {
  readonly view: DesktopSettingsView;
}

export type GuiSettingsIntentPayload = DesktopSettingsIntent;

export type GuiProtocolVersionResult = null | { readonly code: "update-required" };

/** v2 has no compatibility mode: callers show the canonical update recovery. */
export function assertGuiProtocolVersion(value: unknown): GuiProtocolVersionResult {
  return isRecord(value) && value.v === GUI_PROTOCOL_VERSION ? null : { code: "update-required" };
}

export function parseOnboardingIntent(value: unknown): DesktopOnboardingIntent {
  requireV2Request(value, "onboarding.dispatch");
  return parseDesktopOnboardingIntent((value as Record<string, unknown>).intent);
}

export function parseDesktopOnboardingIntent(value: unknown): DesktopOnboardingIntent {
  const record = requireRecord(value);
  const revision = numberValue(record.revision);
  const generation = numberValue(record.generation);
  switch (record.kind) {
    case "open-model-picker":
      return { kind: record.kind, returnTo: enumValue(record.returnTo, ["chat", "model-picker"] as const), revision, generation };
    case "choose-provider":
      return { kind: record.kind, providerId: stringValue(record.providerId), revision, generation };
    case "choose-account":
      return { kind: record.kind, connectionId: stringValue(record.connectionId), revision, generation };
    case "choose-model":
      return { kind: record.kind, routeHandle: stringValue(record.routeHandle), revision, generation };
    case "retry": case "back":
      return { kind: record.kind, revision, generation };
    case "cancel":
      return {
        kind: record.kind,
        revision,
        generation,
        ...(optionalString(record.operationHandle, "operationHandle")),
      };
    default: throw new TypeError("Invalid desktop onboarding intent.");
  }
}

export function parseDesktopSettingsIntent(value: unknown): DesktopSettingsIntent {
  const record = requireRecord(value);
  const revision = numberValue(record.revision);
  switch (record.kind) {
    case "select-category":
      return { kind: record.kind, categoryId: enumValue(record.categoryId, ["model", "accounts", "security", "more"] as const), revision };
    case "search-change": return { kind: record.kind, query: stringValue(record.query), revision };
    case "toggle-advanced":
      return { kind: record.kind, categoryId: enumValue(record.categoryId, ["model", "accounts", "security", "more"] as const), revision };
    case "activate-row": return { kind: record.kind, handle: stringValue(record.handle), revision };
    case "set-boolean": return { kind: record.kind, handle: stringValue(record.handle), value: booleanValue(record.value), revision };
    case "back": return { kind: record.kind, revision };
    default: throw new TypeError("Invalid desktop Settings intent.");
  }
}

export function parseGuiPaletteRow(value: unknown): GuiPaletteRow {
  const record = requireRecord(value);
  const kind = enumValue(record.kind, ["node", "match", "recovery"] as const);
  return {
    kind,
    ...(optionalString(record.command, "command")),
    name: stringValue(record.name),
    description: stringValue(record.description),
    ...(optionalString(record.usage, "usage")),
    ...(optionalString(record.group, "group")),
    verb: enumValue(record.verb, ["run", "insert", "open"] as const),
    presentation: parseDesktopCommandPresentation(record.presentation),
  };
}

export function parseDesktopActivity(value: unknown): DesktopActivity {
  const record = requireRecord(value);
  return {
    id: stringValue(record.id),
    revision: numberValue(record.revision),
    ...(optionalNumber(record.generation, "generation")),
    kind: enumValue(record.kind, ["setup", "settings", "engine", "diagnostic"] as const),
    level: enumValue(record.level, ["info", "warning", "error"] as const),
    message: parseDesktopActivityMessagePresentation(record.message),
    ...(optionalNumber(record.expiresAt, "expiresAt")),
  };
}

export function parseDesktopSettingsRow(value: unknown): DesktopSettingsRow {
  const record = requireRecord(value);
  return {
    handle: stringValue(record.handle), label: stringValue(record.label), description: stringValue(record.description),
    displayValue: stringValue(record.displayValue),
    control: enumValue(record.control, ["boolean", "choice", "action", "readonly", "locked"] as const),
    ...(optionalString(record.focusKey, "focusKey")),
    ...(optionalBoolean(record.booleanValue, "booleanValue")),
    ...(optionalString(record.actionLabel, "actionLabel")),
    ...(record.disabled === undefined ? {} : { disabled: parseDesktopSettingsDisabledPresentation(record.disabled) }),
  };
}

export function parseDesktopSettingsView(value: unknown): DesktopSettingsView {
  const record = requireRecord(value);
  const search = requireRecord(record.search);
  return {
    revision: numberValue(record.revision),
    categories: arrayValue(record.categories).map(parseDesktopSettingsCategory),
    selectedCategoryId: enumValue(record.selectedCategoryId, ["model", "accounts", "security", "more"] as const),
    search: {
      active: booleanValue(search.active), query: stringValue(search.query),
      results: arrayValue(search.results).map(parseDesktopSettingsRow),
    },
    notice: record.notice === null ? null : parseDesktopSettingsNoticePresentation(record.notice),
    ...(optionalString(record.initialFocusKey, "initialFocusKey")),
  };
}

export function parseDesktopCapabilitySnapshot(value: unknown): DesktopCapabilitySnapshot {
  const record = requireRecord(value);
  const appearance = requireRecord(record.appearance);
  return {
    schemaVersion: enumValue(record.schemaVersion, [1] as const),
    revision: numberValue(record.revision), generation: numberValue(record.generation), routeRunnable: booleanValue(record.routeRunnable),
    activeRoute: record.activeRoute === null ? null : parseDesktopActiveRoute(record.activeRoute),
    providers: arrayValue(record.providers).map(parseDesktopProviderCapability),
    undoAvailable: booleanValue(record.undoAvailable),
    appearance: { showLargeLogo: booleanValue(appearance.showLargeLogo), showHeaderMark: booleanValue(appearance.showHeaderMark) },
  };
}

export function parseDesktopOnboardingView(value: unknown): DesktopOnboardingView {
  const record = requireRecord(value);
  return {
    revision: numberValue(record.revision), generation: numberValue(record.generation),
    step: enumValue(record.step, ["provider", "account", "model", "binding", "ready", "error"] as const),
    returnTo: enumValue(record.returnTo, ["chat", "model-picker", "settings"] as const),
    providers: arrayValue(record.providers).map(parseDesktopProviderCapability),
    ...(optionalString(record.operationHandle, "operationHandle")),
    ...(optionalString(record.providerId, "providerId")), ...(optionalString(record.connectionId, "connectionId")),
    ...(optionalString(record.accountLabel, "accountLabel")),
    candidates: arrayValue(record.candidates).map(parseDesktopRouteCandidate),
    ...(record.error === undefined ? {} : { error: parseDesktopDisabledPresentation(record.error) }),
  };
}

export function parseNativeLocalActionRequirement(value: unknown): NativeLocalActionRequirement {
  const record = requireRecord(value);
  return {
    kind: enumValue(record.kind, ["kimi-setup", "kimi-turn", "kimi-cross"] as const),
    revision: numberValue(record.revision), generation: numberValue(record.generation),
    purposeCode: enumValue(record.purposeCode, ["connect-membership", "send-turn", "start-cross"] as const),
  };
}

function parseDesktopCommandPresentation(value: unknown): DesktopCommandPresentation {
  const record = requireRecord(value);
  return {
    description: stringValue(record.description),
    actionLabel: enumValue(record.actionLabel, ["Ausführen", "Einfügen", "Öffnen"] as const),
    ...(optionalString(record.currentLabel, "currentLabel")),
    ...(record.disabled === undefined ? {} : { disabled: parseDesktopCommandDisabledPresentation(record.disabled) }),
  };
}

function parseDesktopCommandDisabledPresentation(value: unknown): DesktopCommandDisabledPresentation {
  const record = requireRecord(value);
  return {
    code: enumValue(record.code, ["run-active", "cross-run-active", "question-pending", "command-in-flight", "settings-open", "no-run", "terminal-only-picker", "route-stale", "provider-unavailable"] as const),
    label: stringValue(record.label), recoveryLabel: stringValue(record.recoveryLabel),
  };
}

function parseDesktopActivityMessagePresentation(value: unknown): DesktopActivityMessagePresentation {
  const record = requireRecord(value);
  return {
    code: enumValue(record.code, ["setup-opened", "setup-cancelled", "setup-completed", "settings-opened", "settings-closed", "engine-restarted", "diagnostic-available"] as const) as DesktopActivityMessageCode,
    label: stringValue(record.label),
  };
}

function parseDesktopSettingsNoticePresentation(value: unknown): DesktopSettingsNoticePresentation {
  const record = requireRecord(value);
  return {
    code: enumValue(record.code, ["saved", "cancelled", "stale", "failed"] as const) as DesktopSettingsNoticeCode,
    level: enumValue(record.level, ["info", "warning", "error"] as const), label: stringValue(record.label),
  };
}

function parseDesktopSettingsDisabledPresentation(value: unknown): DesktopSettingsDisabledPresentation {
  const record = requireRecord(value);
  return {
    code: enumValue(record.code, ["run-active", "cross-run-active", "cross-unavailable", "cross-role-unset", "cross-swap-incomplete", "cross-routes-must-differ", "external-model-role-unsupported", "architect-unavailable", "no-remembered-rules", "no-verify-commands", "voice-consent-required", "model-catalog-unavailable", "model-reasoning-unsupported", "provider-not-connected", "provider-degraded", "config-changed-restart", "config-unreadable", "restart-required", "setting-locked"] as const),
    label: stringValue(record.label), ...(optionalString(record.recoveryLabel, "recoveryLabel")),
  };
}

function parseDesktopSettingsCategory(value: unknown) {
  const record = requireRecord(value);
  return {
    id: enumValue(record.id, ["model", "accounts", "security", "more"] as const),
    label: stringValue(record.label), description: stringValue(record.description),
    expanded: booleanValue(record.expanded),
    commonItems: arrayValue(record.commonItems).map(parseDesktopSettingsRow),
    advancedItems: arrayValue(record.advancedItems).map(parseDesktopSettingsRow),
  };
}

function parseDesktopActiveRoute(value: unknown) {
  const record = requireRecord(value);
  return { routeHandle: stringValue(record.routeHandle), providerLabel: stringValue(record.providerLabel), modelLabel: stringValue(record.modelLabel), accountLabel: nullableString(record.accountLabel) };
}

function parseDesktopProviderCapability(value: unknown) {
  const record = requireRecord(value);
  const multiProfile = requireRecord(record.multiProfile);
  return {
    providerId: stringValue(record.providerId), providerLabel: stringValue(record.providerLabel),
    connectionId: nullableString(record.connectionId), accountLabel: nullableString(record.accountLabel),
    state: enumValue(record.state, ["disconnected", "connecting", "ready", "degraded", "disabled", "blocked"] as const),
    setupMethods: arrayValue(record.setupMethods).map((item) => enumValue(item, ["openrouter-owner-connect", "codex-browser-login", "codex-device-login", "kimi-owner-connect"] as const)),
    multiProfile: { enabled: booleanValue(multiProfile.enabled), ...(multiProfile.disabled === undefined ? {} : { disabled: parseDesktopDisabledPresentation(multiProfile.disabled) }) },
    routes: arrayValue(record.routes).map(parseDesktopRouteCandidate),
    ...(record.disabled === undefined ? {} : { disabled: parseDesktopDisabledPresentation(record.disabled) }),
    ...(record.repair === undefined ? {} : { repair: parseDesktopDisabledPresentation(record.repair) }),
  };
}

function parseDesktopRouteCandidate(value: unknown) {
  const record = requireRecord(value);
  return {
    handle: stringValue(record.handle), providerId: stringValue(record.providerId), connectionId: stringValue(record.connectionId),
    accountLabel: stringValue(record.accountLabel), canonicalModelId: stringValue(record.canonicalModelId), displayName: stringValue(record.displayName),
    reasoning: enumValue(record.reasoning, ["supported", "unsupported", "unknown"] as const),
    capabilities: arrayValue(record.capabilities).map((item) => enumValue(item, ["text", "image-input", "tools", "reasoning", "patch"] as const)),
    cost: parseDesktopCostKnowledge(record.cost), dataPolicy: parseDesktopDataPolicyKnowledge(record.dataPolicy),
    runnable: booleanValue(record.runnable), ...(record.disabled === undefined ? {} : { disabled: parseDesktopDisabledPresentation(record.disabled) }),
  };
}

function parseDesktopCostKnowledge(value: unknown) {
  const record = requireRecord(value);
  if (record.kind === "unknown") return { kind: "unknown" as const, label: enumValue(record.label, ["Kosten unbekannt"] as const) };
  return { kind: enumValue(record.kind, ["known"] as const), label: stringValue(record.label), source: enumValue(record.source, ["provider", "subscription"] as const) };
}

function parseDesktopDataPolicyKnowledge(value: unknown): DesktopDataPolicyKnowledge {
  const record = requireRecord(value);
  if (record.kind === "unknown") return { kind: "unknown", label: enumValue(record.label, ["Datenrichtlinie unbekannt"] as const) };
  return { kind: enumValue(record.kind, ["known"] as const), label: stringValue(record.label), source: enumValue(record.source, ["provider", "owner-config"] as const) };
}

function parseDesktopDisabledPresentation(value: unknown): DesktopDisabledPresentation {
  const record = requireRecord(value);
  return {
    code: enumValue(record.code, ["provider-not-connected", "provider-connecting", "provider-degraded", "provider-disabled", "provider-blocked", "setup-method-unavailable", "model-not-runnable", "native-local-action-unavailable", "codex-runtime-unavailable", "codex-profile-isolation-unproven", "account-authentication-required", "account-limit-reached", "route-stale", "route-activation-failed", "cross-routes-must-differ", "cross-selection-incomplete", "update-required"] as const),
    label: stringValue(record.label), ...(optionalString(record.recoveryLabel, "recoveryLabel")),
  };
}

function requireV2Request(value: unknown, type: string): void {
  if (assertGuiProtocolVersion(value) !== null || !isRecord(value) || value.t !== type) throw new TypeError("Unsupported GUI protocol request.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected a protocol object.");
  return value;
}

function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected a protocol array.");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected protocol text.");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Expected a finite protocol number.");
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected a protocol boolean.");
  return value;
}

function enumValue<T extends readonly (string | number)[]>(value: unknown, values: T): T[number] {
  if (!values.includes(value as T[number])) throw new TypeError("Unexpected protocol value.");
  return value as T[number];
}

function optionalString(value: unknown, name: string): Record<string, string> {
  return value === undefined ? {} : { [name]: stringValue(value) };
}

function optionalNumber(value: unknown, name: string): Record<string, number> {
  return value === undefined ? {} : { [name]: numberValue(value) };
}

function optionalBoolean(value: unknown, name: string): Record<string, boolean> {
  return value === undefined ? {} : { [name]: booleanValue(value) };
}

export type { SetupHubEntry, SetupPresentation, AgentRunEvent, NoticeKind };

/* -------------------------------------------------------------------------
 * R-SEC-0 — the outbound boundary
 * ---------------------------------------------------------------------- */

/**
 * Key names that may never appear anywhere in an outbound frame.
 *
 * Taken verbatim from the repo's own enforced denylists
 * (tests/settings-registry.test.ts, tests/cli.test.ts) plus G0's §2.6 sweep.
 * This is the BACKSTOP; the primary guard is the per-message projections
 * above, because `redactValue` rewrites values and never keys and therefore
 * cannot strip any of these on its own (redaction.ts:207-213).
 */
export const GUI_FORBIDDEN_KEY_PATTERN =
  /^(providerSetup|credentialSlot|credentialBinding|pointer|homeId|codexHome|accountFingerprint|accountFingerprintSuffix|apiKey|secret|requestId|creatorUserId|candidateHmac|secretFingerprintDomain|fingerprint)$/i;

/** Secret-derived identity strings: an HMAC account id, a credential slot id. */
export const GUI_FORBIDDEN_VALUE_PATTERN =
  /(^|[^A-Za-z0-9])(acct_(or|kimi|legacy)_[A-Za-z0-9_-]{6,}|v1:(inference|management|kimi-code):[A-Za-z0-9-]{8,}|codex-[0-9a-f]{32}|keychain-pointer-canary|orcode-keychain|provider-runtime|(?:\/private\/)?provider-home(?:-canary)?|(?:\/[^\s"']+)*\/providers\/codex\/codex-[0-9a-f]{32})(?=$|[^A-Za-z0-9])/;

/**
 * Terminal escape sequences, mirroring `sanitizeTerminalText` (tui.ts:314) —
 * `commands.ts` hands `out.text` pre-coloured ANSI from ~125 sites, and an
 * escape sequence is noise at best in a WebView.
 */
const GUI_ANSI_SEQUENCES: readonly RegExp[] = Object.freeze([
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g,
  /\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/g,
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g,
  /\u001b[@-_]/g,
]);

/**
 * C0/C1 controls (keeping `\t`, `\n`, `\r`, which carry real structure)
 * plus every bidirectional override, isolate and marker.
 *
 * The bidi half is the one that matters in a WebView: U+202E and friends
 * survive HTML escaping intact and reverse rendered text, so a model — or a
 * tool's output, or a file name in a diff — can display one thing and mean
 * another. `safeText` (ui/settings-frame.ts) strips exactly these for the
 * terminal; the same spoofing vector exists in a browser, so the outbound
 * choke point strips them for every surface downstream of it.
 */
const GUI_UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** The one outbound text rule. Applied to every string leaf of every frame. */
export function sanitizeOutboundText(value: string): string {
  let text = value;
  for (const pattern of GUI_ANSI_SEQUENCES) text = text.replace(pattern, "");
  return text.replace(GUI_UNSAFE_TEXT, "");
}

export const GUI_REDACTED_FIELD = "[REDACTED_FIELD]";
export const GUI_REDACTED_ACCOUNT = "[REDACTED_ACCOUNT]";

export interface GuiBoundaryFinding {
  /** Dotted path to the offender, for a diagnostic that names no value. */
  readonly path: string;
  readonly reason: "forbidden-key" | "account-identity" | "key-collision";
}

export interface GuiBoundaryResult<T> {
  readonly value: T;
  readonly findings: readonly GuiBoundaryFinding[];
}

/**
 * The last thing that touches a frame before `JSON.stringify`.
 *
 * R-SEC-1: redaction happens BEFORE serialization, never after — anything
 * written to stdout has already left the boundary. Three passes, in order:
 *
 *  1. forbidden KEYS are dropped (their value replaced by a marker),
 *  2. forbidden VALUES — account fingerprints, credential slot ids — are
 *     replaced,
 *  3. every surviving string is stripped of ANSI, C0/C1 and bidi controls
 *     (`sanitizeOutboundText`),
 *  4. `redactValue` runs for the 13 `SECRET_RULES` shapes.
 *
 * It redacts rather than throws, and reports what it caught, because a
 * dropped frame is a silent failure and silence is the one thing the
 * honesty layer forbids: the caller turns a non-empty `findings` list into
 * a visible `notice`.
 */
export function guardOutboundFrame<T>(frame: T): GuiBoundaryResult<T> {
  const findings: GuiBoundaryFinding[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      if (GUI_FORBIDDEN_VALUE_PATTERN.test(value)) {
        findings.push({ path, reason: "account-identity" });
        return GUI_REDACTED_ACCOUNT;
      }
      // Not a finding: escape sequences and bidi overrides are ordinary
      // content hazards, not leaks, and they are stripped from EVERY string
      // — run-event text included. The union's shape is untouched; only
      // codepoints that can make a surface display something other than
      // what it holds are removed.
      return sanitizeOutboundText(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    }
    if (value && typeof value === "object") {
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        if (GUI_FORBIDDEN_KEY_PATTERN.test(key)) {
          findings.push({ path: childPath, reason: "forbidden-key" });
          let redactedKey = "redacted";
          let ordinal = 2;
          while (redactedKey in next) {
            redactedKey = `redacted#${ordinal}`;
            ordinal += 1;
          }
          next[redactedKey] = GUI_REDACTED_FIELD;
          continue;
        }
        // Keys are content too: `tool-start.input`'s keys are the model's own
        // JSON argument names, so a direction override in a KEY would spoof a
        // rendered argument list exactly as one in a value would.
        //
        // Round-2 re-review: sanitizing can make two keys COLLIDE — a hostile
        // `pa<U+202E>th` sanitizes to `path` and would silently overwrite the
        // honest field, re-creating the spoofing class inside its own fix.
        // A collision never overwrites: the later key gets a disclosed
        // disambiguated name and a finding, so nothing is lost or spoofed.
        let sanitizedKey = sanitizeOutboundText(key);
        if (sanitizedKey in next) {
          let ordinal = 2;
          while (`${sanitizedKey}#${ordinal}` in next) ordinal += 1;
          sanitizedKey = `${sanitizedKey}#${ordinal}`;
          findings.push({ path: childPath, reason: "key-collision" });
        }
        next[sanitizedKey] = walk(entry, childPath);
      }
      return next;
    }
    return value;
  };
  const walked = walk(frame, "") as T;
  const redacted = redactValue(walked);
  assertNoPrivateProviderStateLeaves(redacted);
  return { value: redacted, findings };
}

/* -------------------------------------------------------------------------
 * Backpressure (G0 §3.4, L1) — bounded coalescing of streamed output
 * ---------------------------------------------------------------------- */

export interface GuiBatchedChunk {
  readonly key: string;
  readonly text: string;
  readonly elided: number;
}

/**
 * Line-boundary buffering plus a per-tick coalesce, ported from the TUI's
 * proven mechanisms (tui.ts:1390-1422 for the line hold, the 30 ms render
 * debounce for the tick) rather than invented.
 *
 * The core cannot be back-pressured — `onEvent`/`onText`/`onStatus` return
 * `void` and are never awaited (agent.ts:179-197) — so the sidecar absorbs
 * the flood itself. A per-key ceiling drops MIDDLE text and reports how
 * much, because a silent drop would be a lie about what a tool printed.
 */
export class GuiOutputBatcher {
  readonly #pending = new Map<string, { text: string; elided: number }>();
  readonly #ceiling: number;
  readonly #holdPartialLine: boolean;

  constructor(options: { ceilingChars?: number; holdPartialLine?: boolean } = {}) {
    this.#ceiling = options.ceilingChars ?? 64_000;
    this.#holdPartialLine = options.holdPartialLine ?? false;
  }

  push(key: string, text: string): void {
    if (!text) return;
    const slot = this.#pending.get(key) ?? { text: "", elided: 0 };
    slot.text += text;
    if (slot.text.length > this.#ceiling) {
      // Keep the head and the tail: the start says what the tool was doing,
      // the tail says how it ended. The middle is what a reader loses, and
      // the count says so out loud.
      const half = Math.floor(this.#ceiling / 2);
      const dropped = slot.text.length - this.#ceiling;
      slot.text = `${slot.text.slice(0, half)}${slot.text.slice(slot.text.length - half)}`;
      slot.elided += dropped;
    }
    this.#pending.set(key, slot);
  }

  /**
   * Everything ready to send. With `holdPartialLine`, a trailing fragment
   * with no newline stays behind so a reader never sees a torn line.
   */
  drain(options: { flushPartial?: boolean } = {}): readonly GuiBatchedChunk[] {
    const flushPartial = options.flushPartial ?? !this.#holdPartialLine;
    const chunks: GuiBatchedChunk[] = [];
    for (const [key, slot] of [...this.#pending]) {
      let ready = slot.text;
      let keep = "";
      if (!flushPartial) {
        const boundary = Math.max(ready.lastIndexOf("\n"), ready.lastIndexOf("\r"));
        if (boundary < 0) continue;
        keep = ready.slice(boundary + 1);
        ready = ready.slice(0, boundary + 1);
      }
      if (!ready && !slot.elided) {
        continue;
      }
      chunks.push({ key, text: ready, elided: slot.elided });
      if (keep) this.#pending.set(key, { text: keep, elided: 0 });
      else this.#pending.delete(key);
    }
    return chunks;
  }

  get size(): number {
    return this.#pending.size;
  }
}
