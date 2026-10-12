/**
 * The one explicit Cross start gate (audit move 4, E-HONEST-02/03).
 *
 * Every `/cross` entry path — bare, `run [task]`, `/cross models`, and
 * the plain-mode wiring — funnels into `runCrossGate` instead of starting a
 * run directly or opening a separate picker-only flow. The gate:
 *
 *   - shows the stored pair pre-filled, each role a consciously
 *     confirmable/changeable row (English role copy, never bare
 *     "Lead"/"Challenger");
 *   - stages role/swap changes locally and publishes them only together with
 *     Start, using the same "partial pairs never publish" contract the
 *     runtime's own `readCrossPreferences`/`publishCrossPreferences` flow
 *     already enforces (see `createCrossCommandRuntime` in src/cli.ts);
 *   - keeps Start disabled (never auto-started, never silently adopted)
 *     until the pair is complete and the two routes are distinct;
 *   - discloses the expected model-call range and a cost estimate (or an
 *     honest "unknown") before Start is ever pressed;
 *   - renders the concrete unavailable reason instead of opening role
 *     pickers when Cross itself is unavailable (Kimi routes today).
 *
 * Greenfield module: this replaces `openPreflight`/`crossPreflightChoices`
 * (deleted from src/cli.ts in the same commit) rather than reworking them in
 * place. It is built only against the ports already in the codebase —
 * `CrossCommandPort` (src/commands.ts), `ModelRoutePickerPort`
 * (src/model-route-catalog.ts) — plus the same small, cli.ts-local surface
 * pattern every other Cross/Settings integration already uses to bridge a
 * port to a concrete terminal surface (compare `CrossRuntimeSurface`).
 */

import type { RouteIdentityV1 } from "./backends.js";
import type { CrossCommandPort } from "./commands.js";
import type { CrossPreferencesV1, CrossRole, CrossRunResult } from "./collaboration.js";
import type {
  DesktopCostKnowledge,
  DesktopDisabledPresentation,
} from "./desktop-contracts.js";
import {
  sameCanonicalModelRoute,
  parsePublicRoutePickerSelection,
  type ModelRoutePickerPort,
  type PublicModelRoutePickerPort,
} from "./model-route-catalog.js";
import type {
  DesktopRoutePickerCandidate,
  ResolvedRoutePickerSelection,
  RoutePickerAuthority,
  RoutePickerSelectionIntent,
  RoutePickerView,
} from "./route-picker.js";
import { estimatePanelModelCostUsd, modelCapabilities } from "./openrouter.js";
import type { ModelInfo } from "./types.js";
import { formatUsd, shortModelName } from "./utils.js";

// ---------------------------------------------------------------------------
// Gate copy — English-first, replaces every bare "Lead"/"Challenger" in
// gate-rendered surfaces (owner decision 2026-08-26; audit E-HONEST-02).
// ---------------------------------------------------------------------------

export const CROSS_GATE_TITLE = "Cross · Start";
export const CROSS_GATE_CODING_ROLE_LABEL = "Coding model · writes files";
export const CROSS_GATE_REVIEW_ROLE_LABEL = "Review model · read-only";
export const CROSS_GATE_SWAP_LABEL = "Swap roles";
export const CROSS_GATE_START_LABEL = "Start";
/**
 * Phase 10: the one explicit arming confirmation for persistent Cross mode —
 * the audit's conscious-confirmation requirement is satisfied the same way
 * YOLO (approvalMode persistence) satisfies it: one deliberate choice here,
 * not a per-message gate. Selecting this row publishes the pair exactly like
 * Start, additionally arms the chat (`CrossGateDeps.armForChat`), and starts
 * this same first run — see `runCrossGate`'s `"keep-active"` handling.
 */
export const CROSS_GATE_KEEP_ACTIVE_LABEL = "Keep Cross active for this chat";
export const CROSS_GATE_NOT_SET = "Not set";
export const CROSS_GATE_INCOMPLETE_REASON = "Set both the coding and review models to start.";
export const CROSS_GATE_SAME_ROUTE_REASON = "Coding and review models must be different.";
// ---------------------------------------------------------------------------
// Owner addendum (fix round 1): every arming path must print a clearly
// visible "Cross mode activated" notice at the moment of activation — the
// owner wants to SEE it happen, not infer it from a later status line. Each
// constant below is the situational detail half of that notice; the shared
// headline ("Cross mode activated · <leadShort> + <challengerShort>") is
// composed by the concrete surface (cli.ts, where the short-model-label
// helper already lives) via `CrossGateDeps.notifyActivated(pair, detail)`.
// Never shown for a plain one-shot Start (nothing is armed there) — only
// for the four paths that actually call `armForChat`/`armPendingOneShot`.
// ---------------------------------------------------------------------------
/** "Keep Cross active", empty draft, no history: arms and waits — nothing runs yet. */
export const CROSS_GATE_ARMED_IDLE_DETAIL = "your first message starts the first run.";
/**
 * Owner correction (fix round 1, final ruling): "if I start a chat and the
 * first thing I do is /cross, it should simply wait until the first input
 * comes" — Start on a genuinely empty chat (empty draft, no history) never
 * refuses and never fires a doomed empty-task run. It arms a PENDING
 * one-shot instead (`CrossGateDeps.armPendingOneShot`, `CrossModeV1.oneShot`)
 * and waits — the very next message runs once through the pair, then this
 * disarms automatically.
 */
export const CROSS_GATE_PENDING_ONESHOT_DETAIL =
  "waiting for your first message; it will run once through the pair, then turns off automatically.";
/** "Keep Cross active", empty draft, chat history exists: arms AND immediately fires the continuation run below. */
export const CROSS_GATE_ARMED_CONTINUATION_DETAIL = "continuing the current chat.";
/** "Keep Cross active", non-empty draft: arms AND immediately runs the typed message below. */
export const CROSS_GATE_ARMED_RUNNING_DETAIL = "running your message.";
/**
 * Owner direction (fix round 1): "when I activate Cross, both models should
 * directly understand the task together with the conversation history." An
 * empty draft with existing chat history is not "nothing to run" — the
 * context packet already carries the recent turns (`CROSS_CONTEXT_TURNS`,
 * cli.ts), so an empty draft there means "continue this conversation," not
 * "refuse." This fixed English instruction is the task text sent in that
 * case; the chat history in the packet supplies the actual substance.
 */
/**
 * Testrun finding (owner live test, 2026-08-28): an empty draft with chat
 * history was firing this fixed task even when nothing in that history was
 * actually actionable — the pair would then "investigate the workspace" or
 * produce unrequested analysis chasing a request that was never made. The
 * second sentence is a cheap, explicit escape hatch: ask, don't invent work.
 */
export const CROSS_GATE_CONTINUATION_TASK =
  "Continue the conversation above: address the latest user request. If the "
  + "conversation contains no actionable request, reply briefly asking what "
  + "to work on — do not investigate the workspace or produce analysis.";

/**
 * Owner direction (fix round 1): the gate never hides what an empty-draft
 * run will actually do — shown alongside the Start/Keep-active row
 * descriptions exactly when the draft is empty and history exists (see
 * `CrossGateView.continuationTaskLabel`).
 */
export function crossGateContinuationTaskLabel(historyCount: number): string {
  return `Task: continue the current chat (${historyCount} recent message${historyCount === 1 ? "" : "s"})`;
}
/** setBusy's in-progress label (Phase 7, E-VIS-02) — same one-source-of-truth pattern as the labels above. */
export const CROSS_GATE_PUBLISHING_LABEL = "Publishing …";

// ---------------------------------------------------------------------------
// Call-count range — derived from the coordinator's own phase machine, not a
// hardcoded guess. Source: src/collaboration.ts, CrossCoordinator#run and
// #verifyAndReview.
//
// One run always makes: worker.analyze(lead) + worker.analyze(challenger) in
// the "analysis" phase, then worker.implement(lead) in "implementation", then
// worker.review(challenger) once verification passes in "verification"/
// "review" — 4 model calls minimum. `CrossRunSnapshot.repairCount` is typed
// `0 | 1` and the code path matches: at most ONE additional "repair" round
// runs worker.implement(lead) again followed by worker.review(challenger)
// again — 2 more model calls, 6 maximum. `CrossVerificationPort.run` (the
// configured local verify commands) also runs once or twice alongside this,
// but it is not a billed model call, so it is not counted here.
// ---------------------------------------------------------------------------

const CROSS_GATE_LEAD_CALLS = Object.freeze({ min: 2, max: 3 }); // analyze + implement (+ repair implement)
const CROSS_GATE_CHALLENGER_CALLS = Object.freeze({ min: 2, max: 3 }); // analyze + review (+ repair review)
export const CROSS_GATE_CALL_RANGE = Object.freeze({
  min: CROSS_GATE_LEAD_CALLS.min + CROSS_GATE_CHALLENGER_CALLS.min,
  max: CROSS_GATE_LEAD_CALLS.max + CROSS_GATE_CHALLENGER_CALLS.max,
});

/**
 * Phase 10 (controller ruling 1): the exact, fixed copy shown next to
 * "Keep Cross active for this chat" — derived from `CROSS_GATE_CALL_RANGE`
 * above so it can never drift from the Start row's own call-count math.
 * Unlike `crossGateConsequence`, this never depends on the pair or a cost
 * estimate: the per-message multiplier is a fact about Cross itself, not
 * about which models are chosen.
 */
export function crossGateKeepActiveConsequence(): string {
  return `every message in this chat will use ${CROSS_GATE_CALL_RANGE.min}-${CROSS_GATE_CALL_RANGE.max} agent phases; provider requests and cost can vary with tool work until /cross off`;
}

/**
 * Same upfront-estimate heuristic as `/panel` (chars/4 ≈ tokens, plus a fixed
 * output-token allowance — see `estimatePanelModelCostUsd` in openrouter.ts),
 * applied per role and then scaled by how many times that role is actually
 * called across the run (`CROSS_GATE_LEAD_CALLS`/`CROSS_GATE_CHALLENGER_CALLS`
 * above) instead of once. A route with unknown/dynamic pricing yields `null`
 * for its own per-call estimate; since a run always calls BOTH roles, a
 * `null` on either side makes the whole total "cost unknown" rather than a
 * silently understated partial number.
 */
export interface CrossGateConsequence {
  readonly callRange: { readonly min: number; readonly max: number };
  readonly cost: { readonly min: number; readonly max: number } | "unknown";
}

function findModelInfo(models: readonly ModelInfo[], requestedModelId: string): ModelInfo | null {
  return models.find(
    (model) => model.id === requestedModelId || model.canonicalSlug === requestedModelId,
  ) ?? null;
}

function perCallUsd(
  models: readonly ModelInfo[],
  route: RouteIdentityV1 | null,
  promptChars: number,
): number | null {
  if (!route) return null;
  const info = findModelInfo(models, route.requestedModelId);
  if (!info) return null;
  return estimatePanelModelCostUsd(modelCapabilities(info), promptChars);
}

/**
 * Pure, directly testable consequence projection: the Start row's
 * "N–M model calls · est. from $X–$Y" (or "cost unknown") disclosure.
 *
 * FIX-14 ticket 18: what this prices is the context packet plus the task,
 * per role call — a FLOOR, not a ceiling. See
 * `formatCrossGateConsequence` below for why that is presented as one
 * rather than estimated away.
 */
export function crossGateConsequence(
  models: readonly ModelInfo[],
  lead: RouteIdentityV1 | null,
  challenger: RouteIdentityV1 | null,
  promptChars: number,
): CrossGateConsequence {
  const leadUsd = perCallUsd(models, lead, promptChars);
  const challengerUsd = perCallUsd(models, challenger, promptChars);
  if (leadUsd === null || challengerUsd === null) {
    return { callRange: CROSS_GATE_CALL_RANGE, cost: "unknown" };
  }
  return {
    callRange: CROSS_GATE_CALL_RANGE,
    cost: {
      min: leadUsd * CROSS_GATE_LEAD_CALLS.min + challengerUsd * CROSS_GATE_CHALLENGER_CALLS.min,
      max: leadUsd * CROSS_GATE_LEAD_CALLS.max + challengerUsd * CROSS_GATE_CHALLENGER_CALLS.max,
    },
  };
}

/**
 * FIX-14 ticket 18 — the consent-point decision, recorded here because this
 * is the string the decision is about.
 *
 * The estimate prices the CONTEXT PACKET plus the task, once per role call
 * (`crossGateConsequence` above). It has never priced the content the run
 * itself produces and then carries into its later rounds: `acceptedPlan`
 * and `critique` ride into `implement`, `leadResult` and `diff` ride into
 * `review`, and a repair round carries all of it again (P15's own report
 * records the gap; `collaboration.ts` builds the packets). So the figure at
 * the gate is a FLOOR, and it used to be presented as a two-sided estimate,
 * which reads as a ceiling.
 *
 * Two honest options were on the table. **Estimator extension** was
 * rejected: the carried content is model output and a workspace diff, whose
 * sizes are not knowable before the run. Part of it could be inferred from
 * `PANEL_ESTIMATE_OUTPUT_TOKENS` (the fixed output allowance the per-call
 * estimator already assumes), but the diff — the part that can dominate on
 * a real task — cannot be inferred from anything. Extending the estimator
 * would price some of the gap while making the number look MORE
 * authoritative than before, which is the exact failure mode the honesty
 * layer exists to prevent at a consent point.
 *
 * So: **band and disclosure.** `est.` becomes `est. from` — the same floor
 * semantics `formatChatCost`'s "at least $X" already uses elsewhere — and
 * the line names what is missing. The floor marker comes FIRST, before the
 * explanation, because a narrow surface ellipsizes from the right: the
 * shortest honest signal is the one that survives.
 *
 * The `cost === "unknown"` branch is untouched. It already claims nothing.
 */
export function formatCrossGateConsequence(consequence: CrossGateConsequence): string {
  return crossGateConsequenceParts(consequence).join(" · ");
}

/**
 * FIX-14 fix round 1 (review M1, controller ruling): the same one wording,
 * as INDIVISIBLE parts.
 *
 * The floor marker and the figure it qualifies live and die together. Handed
 * to a list row as `ListEntry.descriptionParts`, each part is rendered whole
 * or shed whole, so a narrow row can lose the money segment but can never
 * cut into it. Measured before this: at 40 columns the Start row read
 * `est. from $0…` for a real floor of $0.068 — a fragment a reader can take
 * for "from $0", i.e. free, which is the one thing a consent point may never
 * imply. Consent-point honesty outranks width here exactly as it does for
 * the status line's cancel hint.
 *
 * `formatCrossGateConsequence` above joins these, so there is still one
 * place the wording lives and a surface with no width budget (a status line,
 * a log) is unchanged.
 *
 * Note what is NOT split: `est. from $X-$Y` is ONE part. Splitting the
 * marker from the numbers is precisely the failure this prevents.
 */
export function crossGateConsequenceParts(
  consequence: CrossGateConsequence,
): readonly string[] {
  const phases = consequence.callRange.min === consequence.callRange.max
    ? `${consequence.callRange.min} agent phases`
    : `${consequence.callRange.min}-${consequence.callRange.max} agent phases`;
  return [phases, CROSS_GATE_FOLLOW_ROUND_DISCLOSURE];
}

/**
 * FIX-14 ticket 18: the clause that keeps the floor from reading as a
 * ceiling. Exported so a surface's own test can pin it without re-spelling
 * it, exactly like the `CROSS_GATE_*` labels above.
 */
export const CROSS_GATE_FOLLOW_ROUND_DISCLOSURE =
  "provider requests and cost can vary with tool work";

/**
 * FIX-9 (internal leaks): a gate role row names the MODEL, short — the same
 * `shortModelName` label the status line and every other model surface uses.
 * `backendId` is an internal routing key, so it never appears in the row;
 * the route identity itself (`RouteIdentityV1`, backend included) is
 * untouched — only what the row renders changed.
 */
/** Kept beside the label it builds so a surface's own tests can pin the exact composition. */
export const CROSS_GATE_THINKING_SEPARATOR = " · thinking ";

function crossGateRouteLabel(
  route: RouteIdentityV1 | null,
  thinkingLabel?: (route: RouteIdentityV1) => string | null,
): string {
  if (!route) return CROSS_GATE_NOT_SET;
  const model = shortModelName(route.requestedModelId);
  // P15 item 1: each role's own think level, at the consent point. The label
  // comes from the caller (`CrossGateDeps.thinkingLabel`, wired to the exact
  // `reasoningLabel(getReasoningSetting(config, <role's model id>))` Settings'
  // own "Thinking · Cross coding/review" rows display) — one mechanism, one
  // string, so the gate can never disagree with Settings about what a role
  // will actually think with.
  const thinking = thinkingLabel?.(route) ?? null;
  return thinking ? `${model}${CROSS_GATE_THINKING_SEPARATOR}${thinking}` : model;
}

function startBlockedReason(pair: CrossPreferencesV1): string | null {
  if (!pair.lead || !pair.challenger) return CROSS_GATE_INCOMPLETE_REASON;
  if (sameCanonicalModelRoute(pair.lead, pair.challenger)) return CROSS_GATE_SAME_ROUTE_REASON;
  return null;
}

// ---------------------------------------------------------------------------
// View model + surface contract
// ---------------------------------------------------------------------------

export type CrossGateAction = "coding" | "review" | "swap" | "start" | "keep-active";

export type DesktopCrossDuration = "one-task" | "chat";

export interface DesktopCrossPreflightView {
  readonly lead: DesktopRoutePickerCandidate | null;
  readonly challenger: DesktopRoutePickerCandidate | null;
  readonly duration: DesktopCrossDuration | null;
  readonly estimatedCalls: { readonly min: 4; readonly max: 6 };
  readonly cost: DesktopCostKnowledge;
  readonly startDisabled: DesktopDisabledPresentation | null;
}

interface DesktopCrossPreflightSource {
  readonly leadCandidate: DesktopRoutePickerCandidate | null;
  readonly challengerCandidate: DesktopRoutePickerCandidate | null;
  readonly consequence: CrossGateConsequence | null;
  readonly canStart: boolean;
  readonly selectionProblem?: DesktopDisabledPresentation | null;
}

const DESKTOP_CROSS_INCOMPLETE = Object.freeze({
  code: "cross-selection-incomplete",
  label: "Lead, Challenger und Dauer auswählen",
  recoveryLabel: "Beide Modelle und Dauer wählen",
} satisfies DesktopDisabledPresentation);

const DESKTOP_CROSS_SAME_ROUTE = Object.freeze({
  code: "cross-routes-must-differ",
  label: "Lead und Challenger müssen verschieden sein",
  recoveryLabel: "Anderes Modell wählen",
} satisfies DesktopDisabledPresentation);

const DESKTOP_CROSS_ROUTE_STALE = Object.freeze({
  code: "route-stale",
  label: "Die gewählte Cross-Modellroute ist nicht mehr verfügbar.",
  recoveryLabel: "Konto unter Einstellungen → Konten prüfen und Cross erneut öffnen",
} satisfies DesktopDisabledPresentation);

function sameDesktopCrossRoute(
  left: DesktopRoutePickerCandidate,
  right: DesktopRoutePickerCandidate,
): boolean {
  return left.providerId === right.providerId
    && left.connectionId === right.connectionId
    && left.canonicalModelId === right.canonicalModelId;
}

const DESKTOP_CROSS_REASONING: Readonly<Record<DesktopRoutePickerCandidate["reasoning"], string>> = Object.freeze({
  supported: "unterstützt",
  unsupported: "nicht unterstützt",
  unknown: "unbekannt",
});
const DESKTOP_CROSS_CAPABILITIES: Readonly<Record<DesktopRoutePickerCandidate["capabilities"][number], string>> = Object.freeze({
  text: "Text",
  "image-input": "Bildeingabe",
  tools: "Werkzeuge",
  reasoning: "Denkmodus",
  patch: "Dateiänderungen",
});

/** One unambiguous, secretless identity used in picker, preflight and confirm. */
export function desktopCrossRoutePresentation(candidate: DesktopRoutePickerCandidate): string {
  return `${candidate.providerLabel} · ${candidate.accountLabel} · ${candidate.displayName} · ${candidate.canonicalModelId}`;
}

/** The same safe execution facts shown anywhere a Cross route is chosen. */
export function desktopCrossRouteDetails(candidate: DesktopRoutePickerCandidate): string {
  return `Denkmodus: ${DESKTOP_CROSS_REASONING[candidate.reasoning]}`
    + ` · Fähigkeiten: ${candidate.capabilities.map((capability) => DESKTOP_CROSS_CAPABILITIES[capability]).join(" · ")}`;
}

/** Secretless Desktop projection of the existing authority-owned Cross gate. */
export function desktopCrossPreflight(
  source: DesktopCrossPreflightSource,
  duration: DesktopCrossDuration | null,
): DesktopCrossPreflightView {
  const lead = source.leadCandidate;
  const challenger = source.challengerCandidate;
  const complete = Boolean(
    lead?.runnable && !lead.disabled
    && challenger?.runnable && !challenger.disabled
    && duration,
  );
  const sameRoute = Boolean(lead && challenger && sameDesktopCrossRoute(lead, challenger));
  const startDisabled = source.selectionProblem ?? (!complete
    ? DESKTOP_CROSS_INCOMPLETE
    : sameRoute || !source.canStart
      ? DESKTOP_CROSS_SAME_ROUTE
      : null);
  const cost: DesktopCostKnowledge = source.consequence?.cost === "unknown"
    || source.consequence === null
    ? { kind: "unknown", label: "Kosten unbekannt" }
    : {
        kind: "known",
        label: `Mindestens ${formatUsd(source.consequence.cost.min)}–${formatUsd(source.consequence.cost.max)}`,
        source: "provider",
      };
  return Object.freeze({
    lead,
    challenger,
    duration,
    estimatedCalls: CROSS_GATE_CALL_RANGE as { readonly min: 4; readonly max: 6 },
    cost,
    startDisabled,
  });
}

export interface CrossGateView {
  /** Exact public candidates selected for Desktop's explicit role preflight. */
  readonly leadCandidate: DesktopRoutePickerCandidate | null;
  readonly challengerCandidate: DesktopRoutePickerCandidate | null;
  /** Safe, actionable reason for a rejected explicit role selection. */
  readonly selectionProblem?: DesktopDisabledPresentation | null;
  /** Current (possibly staged, not yet published) coding-role route label, or "Not set". */
  readonly coding: string;
  /** Current (possibly staged, not yet published) review-role route label, or "Not set". */
  readonly review: string;
  /** The preserved composer/task draft, shown so the gate never hides what it will run. */
  readonly draft: string;
  readonly canStart: boolean;
  /**
   * Set only when the pair is present-but-invalid (missing a role, or both
   * roles resolve to the same canonical model). `null` whenever `canStart`
   * is true OR Cross itself is unavailable — `unavailableReason` below
   * carries that second case instead, so a surface never has to show both.
   */
  readonly startBlockedReason: string | null;
  /**
   * Owner direction (fix round 1): non-null exactly when the draft is empty
   * AND chat history exists — the fixed continuation-task preview
   * (`crossGateContinuationTaskLabel`) a surface shows alongside the
   * Start/Keep-active row descriptions so an empty-draft run is never a
   * hidden surprise. `null` when the draft has real text (the user already
   * sees what they typed) or when there is no history either (Start's own
   * pending-one-shot preview, `startWaitingLabel`, covers that case instead).
   */
  readonly continuationTaskLabel: string | null;
  /**
   * Owner correction (fix round 1, final ruling): non-null exactly when the
   * draft is empty AND there is no chat history — Start never refuses this
   * case, it arms a pending one-shot instead (`CROSS_GATE_PENDING_ONESHOT_DETAIL`)
   * and does not run yet. Shown on the **Start** row only (not Keep-active's
   * — its own row already says everything relevant via
   * `keepActiveConsequence`), so the gate never hides that choosing Start
   * here arms-and-waits rather than running immediately. Independent of
   * `startBlockedReason`/`canStart` — an incomplete pair still blocks Start
   * outright regardless of this.
   */
  readonly startWaitingLabel: string | null;
  /**
   * Non-null exactly when Cross cannot run at all in the current session
   * (Kimi routes today). A surface MUST NOT open the coding/review pickers
   * or offer swap/start while this is set — it renders this reason instead
   * (E-HONEST-01/E-HONEST-02: never a selectable action with no real effect).
   */
  readonly unavailableReason: string | null;
  /** `null` only alongside `unavailableReason` — nothing to disclose when Cross cannot run. */
  readonly consequence: CrossGateConsequence | null;
  /**
   * Phase 10: the fixed "Keep Cross active for this chat" consequence line
   * (`crossGateKeepActiveConsequence`). `null` only alongside
   * `unavailableReason` — matches `consequence` above exactly, since neither
   * choice can be offered when Cross itself cannot run.
   */
  readonly keepActiveConsequence: string | null;
}

/**
 * The one cli.ts-local rendering seam the gate drives, analogous to
 * `CrossRuntimeSurface`'s `choosePreflight` it replaces. Each concrete
 * surface (plain Inquirer loop, fullscreen TUI) is responsible for: showing
 * `view.unavailableReason` and returning `null` without prompting anything
 * selectable when it is set (no pickers on an unavailable route), and for
 * rendering `view.startBlockedReason`/`view.consequence` so Start's state is
 * visible before the user ever presses it.
 */
export interface CrossGateSurface {
  chooseGate(view: CrossGateView): Promise<CrossGateAction | null>;
  /**
   * Optional loading-state hook (Phase 7, E-VIS-02 gap fill): called `true`
   * immediately before publishing a staged pair change and `false` once it
   * settles. Publishing writes `~/.orcode/config.json` under the shared
   * config write lock (`publishCrossPreferences`) — a real, sometimes
   * noticeable wait under contention with a concurrent Settings edit — and
   * previously had no presentation between "Start pressed" and the run
   * actually launching. The catalog purpose identifies the explicit route
   * list preparation, which is cleared in finally even when loading fails.
   * Surfaces that omit it keep today's behavior.
   */
  setBusy?(active: boolean, purpose?: "catalog" | "publish"): void;
}

export interface CrossGateDeps {
  /** Only `start` is ever called — the gate is the sole confirmed-pair entry point into a run. */
  readonly port: Pick<CrossCommandPort, "start">;
  readonly picker: ModelRoutePickerPort;
  /** Task 5B public surface boundary. Both fields are supplied together by new runtimes. */
  readonly publicPicker?: PublicModelRoutePickerPort;
  readonly routeAuthority?: RoutePickerAuthority;
  /** Runs only on explicit gate opening, before any opaque choices are shown. */
  readonly prepareRoutePicker?: () => Promise<void>;
  readonly readPreferences: () => CrossPreferencesV1;
  readonly publishPreferences: (next: CrossPreferencesV1) => Promise<void>;
  readonly surface: CrossGateSurface;
  /**
   * Hands the pending task text back to the composer on every path that
   * abandons a gate visit — cancel, a failed publish, a failed arm.
   *
   * FIX-20, finding 6: `draft` is the text this visit was holding, which is
   * NOT always the composer draft the surface captured. `/cross run <task>`
   * supplies its task as a command ARGUMENT, so the surface has nothing of
   * its own to restore and Esc silently ate what the owner typed. Passing
   * the text explicitly makes both entry paths behave the same: whatever
   * the gate was about to run comes back, rather than only what the palette
   * happened to capture.
   */
  readonly restoreDraft: (draft: string) => void;
  /** Production loops register the started run here so the gate call itself returns immediately. */
  readonly launchRun?: (run: Promise<CrossRunResult>) => void;
  /** Non-null when Cross cannot run in the current session (Kimi routes today). */
  readonly unavailableReason: () => string | null;
  /** Already-cached model metadata (never a fresh network fetch) used only for the cost estimate. */
  readonly cachedModels: () => readonly ModelInfo[];
  /**
   * Phase 10: called exactly once, with the exact pair this same gate visit
   * is about to start, when the user chooses "Keep Cross active for this
   * chat" instead of plain Start — arms persistent Cross mode for the
   * current chat. Omitted by a surface that never offers the row (there is
   * none today, but the type stays optional so a future minimal test double
   * need not supply it).
   */
  readonly armForChat?: (pair: CrossPreferencesV1) => Promise<void>;
  /**
   * Owner correction (fix round 1, final ruling): called instead of
   * `port.start` when **Start** is chosen on a genuinely empty chat (empty
   * draft, no history) — arms a PENDING one-shot (`CrossModeV1.oneShot`)
   * with the exact pair this gate visit was about to start, rather than
   * refusing or firing a doomed empty-task run. The very next plain message
   * runs once through the pair via the ordinary armed-dispatch path.
   */
  readonly armPendingOneShot?: (pair: CrossPreferencesV1) => Promise<void>;
  /**
   * Owner addendum (fix round 1): called exactly once on every path that
   * calls `armForChat`/`armPendingOneShot` above (never for a plain one-shot
   * Start, which arms nothing) — `pair` is the exact pair just armed,
   * `detail` one of the `CROSS_GATE_*_DETAIL` constants naming what happens
   * next. Surfaces compose the shared "Cross mode activated · <lead> +
   * <challenger> — <detail>" headline through their own idiom (the
   * short-model-label helper lives in cli.ts, not here).
   */
  readonly notifyActivated?: (pair: CrossPreferencesV1, detail: string) => void;
  /**
   * Owner direction (fix round 1): the number of recent chat turns the
   * context packet will actually carry (the same count `input.context()`
   * feeds the coordinator, cli.ts's `createCrossRuntimeForContext`) — used
   * only to decide whether an empty draft means "continue the conversation"
   * (history exists) or "nothing to run" (it doesn't), and to render
   * `continuationTaskLabel`. Omitted (defaults to 0) treats every empty
   * draft as having no history, matching pre-fix-round behavior for a
   * minimal test double.
   */
  readonly chatHistoryCount?: () => number;
  /**
   * FIX-10 H1 (money honesty): the number of chars the run's context packet
   * will ACTUALLY carry — the same `input.context()` slice the coordinator
   * is fed on start (chat turn contents plus omission markers, cli.ts's
   * `createCrossRuntimeForContext`). The Start row's cost estimate prices
   * context + task, never the draft alone: an empty draft with history
   * still ships the full packet plus the fixed continuation task, and a
   * draft-only estimate understated that run by construction at the consent
   * point.
   *
   * FIX-14 ticket 4: REQUIRED, not optional. The "omitted defaults to 0"
   * convention it used to share with `chatHistoryCount` is a foot-gun on
   * this dep specifically: `chatHistoryCount`'s default only changes which
   * copy renders, while this one silently understates the MONEY the Start
   * row asks the user to consent to, and a surface that forgot to wire it
   * was indistinguishable from a double that meant 0. A caller with no
   * packet returns 0 explicitly.
   */
  readonly chatContextChars: () => number;
  /**
   * P15 item 1 (owner: "du hast auch ein Denklevel … beide Modelle müssen
   * wissen, was gerade passiert"): the think level a role will ACTUALLY run
   * with, rendered into that role's gate row so it is visible at the consent
   * point rather than only inside Settings. Production wires the exact same
   * `reasoningLabel(getReasoningSetting(config, route.requestedModelId))`
   * lookup Settings' own "Thinking · Cross coding/review" rows display, so
   * the two surfaces show one value from one store — never a second
   * derivation that could drift.
   *
   * Returning `null` (or omitting the dep entirely) leaves the row exactly as
   * it was: the model name alone, never a fabricated level.
   */
  readonly thinkingLabel?: (route: RouteIdentityV1) => string | null;
}

/**
 * Drives one gate visit to completion: cancel (restores the draft), or
 * exactly one confirmed Start (publishes any staged pair change, then calls
 * `deps.port.start` exactly once — this is the only place in the codebase
 * that may do so after the cutover). Role picks and swap stage locally and
 * are never published on their own; a partial pair is never published,
 * mirroring Settings' own Cross staging contract (Phase 2).
 */
export async function runCrossGate(deps: CrossGateDeps, draft: string): Promise<void> {
  let preservedDraft: string | null = draft;
  let staged: CrossPreferencesV1 | null = null;
  type OpaqueStage = { intent: RoutePickerSelectionIntent; resolved: ResolvedRoutePickerSelection };
  let opaque: { lead: OpaqueStage | null; challenger: OpaqueStage | null } = {
    lead: null, challenger: null,
  };
  const usesOpaque = Boolean(deps.publicPicker && deps.routeAuthority);
  let selectionProblem: DesktopDisabledPresentation | null = null;
  let preparationProblem: string | null = null;
  if (Boolean(deps.publicPicker) !== Boolean(deps.routeAuthority)) {
    deps.restoreDraft(draft);
    throw new Error("Cross route picker is unavailable.");
  }
  if (usesOpaque && deps.prepareRoutePicker && !deps.unavailableReason()) {
    deps.surface.setBusy?.(true, "catalog");
    try {
      await deps.prepareRoutePicker();
    } catch {
      preparationProblem = "Der Modellkatalog konnte nicht geladen werden. Konto unter Einstellungen → Konten prüfen und Cross erneut öffnen.";
    } finally {
      deps.surface.setBusy?.(false, "catalog");
    }
  }
  const currentPair = (): CrossPreferencesV1 => structuredClone(usesOpaque
    ? { lead: opaque.lead?.resolved.route ?? null, challenger: opaque.challenger?.resolved.route ?? null }
    : staged ?? deps.readPreferences());

  while (true) {
    const reason = deps.unavailableReason() ?? preparationProblem;
    let pair = currentPair();
    const publicViews = usesOpaque && !reason ? {
      lead: deps.routeAuthority!.view({ role: "lead" }),
      challenger: deps.routeAuthority!.view({ role: "challenger" }),
    } : null;
    const blocked = selectionProblem
      ? `${selectionProblem.label} ${selectionProblem.recoveryLabel ?? ""}`.trim()
      : usesOpaque
      ? (!opaque.lead || !opaque.challenger
          ? "Choose both models before starting Cross."
          : sameCanonicalModelRoute(opaque.lead.resolved.route, opaque.challenger.resolved.route)
            ? CROSS_GATE_SAME_ROUTE_REASON
            : null)
      : startBlockedReason(pair);
    const canStart = !reason && blocked === null;
    // Owner direction (fix round 1): an empty draft is only "nothing to
    // run" when the chat ALSO has no history — with history, it means
    // "continue the conversation" instead (CROSS_GATE_CONTINUATION_TASK).
    // Neither ever affects `canStart`/`startBlockedReason` themselves,
    // since "Keep Cross active" stays actionable on an empty draft either
    // way (it arms regardless; only whether it also fires a run differs).
    const draftEmpty = (preservedDraft ?? "").trim().length === 0;
    const historyCount = deps.chatHistoryCount?.() ?? 0;
    const hasHistory = historyCount > 0;
    const emptyWithNoHistory = draftEmpty && !hasHistory;
    // FIX-10 H1: the consequence estimate prices what a confirmed Start
    // will actually send — the context packet's chars plus the task text
    // that rides with it (the typed draft, or the fixed continuation task
    // an empty draft with history resolves to below). Same estimator as
    // before (`estimatePanelModelCostUsd` via `perCallUsd`), only fed the
    // honest char count instead of the draft alone.
    // Fix round 1 (F8): only computed when a consequence will actually
    // render — an unavailable route discards it, so the packet chars are
    // never built for nothing. Both context-dep reads happen inside this
    // one synchronous block, so inter-call drift is impossible.
    const estimatedPromptChars = reason
      ? 0
      : deps.chatContextChars()
        + (draftEmpty && hasHistory
          ? CROSS_GATE_CONTINUATION_TASK.length
          : (preservedDraft ?? "").length);
    const view: CrossGateView = {
      leadCandidate: usesOpaque ? opaque.lead?.resolved.candidate ?? null : null,
      challengerCandidate: usesOpaque ? opaque.challenger?.resolved.candidate ?? null : null,
      selectionProblem,
      coding: publicViews ? opaqueRouteLabel(opaque.lead?.intent ?? null, publicViews.lead) : crossGateRouteLabel(pair.lead, deps.thinkingLabel),
      review: publicViews ? opaqueRouteLabel(opaque.challenger?.intent ?? null, publicViews.challenger) : crossGateRouteLabel(pair.challenger, deps.thinkingLabel),
      draft: preservedDraft ?? "",
      canStart,
      startBlockedReason: reason ? null : blocked,
      continuationTaskLabel: !reason && draftEmpty && hasHistory
        ? crossGateContinuationTaskLabel(historyCount)
        : null,
      startWaitingLabel: !reason && emptyWithNoHistory ? CROSS_GATE_PENDING_ONESHOT_DETAIL : null,
      unavailableReason: reason,
      consequence: reason
        ? null
        : crossGateConsequence(deps.cachedModels(), pair.lead, pair.challenger, estimatedPromptChars),
      keepActiveConsequence: reason ? null : crossGateKeepActiveConsequence(),
    };
    const action = await deps.surface.chooseGate(view);

    // Cancel, or Cross is unavailable: a surface must never offer a real
    // action on an unavailable route, but this never trusts it blindly —
    // any returned action is treated as cancel while `reason` is set.
    if (action === null || reason) {
      const abandoned = preservedDraft ?? "";
      preservedDraft = null;
      staged = null;
      deps.restoreDraft(abandoned);
      return;
    }

    if (action === "coding" || action === "review") {
      const role: CrossRole = action === "coding" ? "lead" : "challenger";
      if (usesOpaque) {
        const view = publicViews![role];
        const selected = await deps.publicPicker!.pickModelRoute({
          request: { role }, view,
          title: `Cross · ${role === "lead" ? CROSS_GATE_CODING_ROLE_LABEL : CROSS_GATE_REVIEW_ROLE_LABEL}`,
          ...(opaque[role] ? { currentHandle: opaque[role]!.intent.handle } : {}),
        });
        const parsed = parsePublicRoutePickerSelection(selected);
        if (parsed) {
          let chosenCandidate = view.candidates.find((candidate) => candidate.handle === parsed.handle);
          try {
            const resolved = deps.routeAuthority!.resolve({ role }, parsed);
            chosenCandidate = resolved.candidate;
            assertCrossRoleSelection(resolved);
            opaque = { ...opaque, [role]: { intent: parsed, resolved } };
            selectionProblem = null;
          } catch {
            opaque = { ...opaque, [role]: null };
            selectionProblem = chosenCandidate && !chosenCandidate.capabilities.includes("tools")
              ? {
                  code: "model-not-runnable",
                  label: "Für dieses Modell ist keine Werkzeugunterstützung für Cross bestätigt.",
                  recoveryLabel: "Ein Modell mit Werkzeugunterstützung wählen; bei fehlendem Katalog das Konto unter Einstellungen → Konten öffnen",
                }
              : DESKTOP_CROSS_ROUTE_STALE;
          }
        }
        continue;
      }
      const pairNow = currentPair();
      const counterpart = role === "lead" ? pairNow.challenger : pairNow.lead;
      const selected = await deps.picker.pickModelRoute({
        title: `Cross · ${role === "lead" ? CROSS_GATE_CODING_ROLE_LABEL : CROSS_GATE_REVIEW_ROLE_LABEL}`,
        role,
        current: pairNow[role],
        ...(counterpart ? { exclude: counterpart } : {}),
        preserveDraft: true,
      });
      if (selected) {
        staged = structuredClone({ ...pairNow, [role]: selected.route });
      }
      continue;
    }

    if (action === "swap") {
      if (usesOpaque) {
        opaque = { lead: opaque.challenger, challenger: opaque.lead };
        continue;
      }
      const pairNow = currentPair();
      if (pairNow.lead && pairNow.challenger) {
        staged = structuredClone({ lead: pairNow.challenger, challenger: pairNow.lead });
      }
      continue;
    }

    // action === "start" or "keep-active" — re-check defensively; a surface
    // must never be able to force a start on an invalid pair even if it
    // mis-renders. Owner correction (fix round 1, final ruling): Start is
    // NEVER refused for an empty draft any more, not even empty+empty —
    // that case arms a pending one-shot and waits (below) instead of
    // refusing or firing a doomed empty-task run.
    if (!canStart) {
      const abandoned = preservedDraft ?? "";
      preservedDraft = null;
      staged = null;
      opaque = { lead: null, challenger: null };
      deps.restoreDraft(abandoned);
      return;
    }
    if (usesOpaque) {
      try {
        // One synchronous, last-responsible-moment proof for both selections,
        // before publish/arm/start can observe either route.
        const lead = deps.routeAuthority!.resolve({ role: "lead" }, opaque.lead!.intent);
        const challenger = deps.routeAuthority!.resolve({ role: "challenger" }, opaque.challenger!.intent);
        assertCrossRoleSelection(lead);
        assertCrossRoleSelection(challenger);
        if (!sameResolvedPickerRoute(lead, opaque.lead!.resolved)
          || !sameResolvedPickerRoute(challenger, opaque.challenger!.resolved)) {
          throw new Error("Cross route selection changed.");
        }
        pair = { lead: lead.route, challenger: challenger.route };
        if (!pair.lead || !pair.challenger || sameCanonicalModelRoute(pair.lead, pair.challenger)) {
          opaque = { lead: null, challenger: null };
          staged = null;
          continue;
        }
        staged = pair;
      } catch {
        opaque = { lead: null, challenger: null };
        selectionProblem = DESKTOP_CROSS_ROUTE_STALE;
        continue;
      }
    }
    try {
      if (staged?.lead && staged.challenger) {
        deps.surface.setBusy?.(true);
        try {
          await deps.publishPreferences(staged);
        } finally {
          deps.surface.setBusy?.(false);
        }
        staged = null;
      }
    } catch (error) {
      const abandoned = preservedDraft ?? "";
      staged = null;
      preservedDraft = null;
      deps.restoreDraft(abandoned);
      throw error;
    }
    // Owner correction (fix round 1, final ruling): Start on a genuinely
    // empty chat arms a PENDING one-shot and waits, exactly like
    // "keep-active" does for the same empty+empty case below — the only
    // difference is the `oneShot` marker, which auto-disarms after that one
    // run (`SessionStore.clearCrossModeOneShotIfPending`, wired into the
    // armed-dispatch seam in runPlainLoop/runDashboard). Arming can fail
    // (a save error, a lock timeout); when it does, this whole gate visit
    // aborts — restore the draft (never silently drop the typed task) and
    // propagate, so the caller's existing error reporting shows a concrete
    // reason, exactly like a publish failure does above.
    if (action === "start" && emptyWithNoHistory) {
      try {
        await deps.armPendingOneShot?.(pair);
      } catch (error) {
        const abandoned = preservedDraft ?? "";
        preservedDraft = null;
        deps.restoreDraft(abandoned);
        throw new Error(
          `Cross could not be armed for this chat: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      preservedDraft = null;
      deps.notifyActivated?.(pair, CROSS_GATE_PENDING_ONESHOT_DETAIL);
      return;
    }
    // Phase 10 (fix round 1, MINOR 4): `pair` above already reflects exactly
    // what was just published (either it was already complete, or `staged`
    // — the thing just published — is deep-equal to it) — arming with it
    // here needs no re-read. Arming CAN fail; when it does, this whole gate
    // visit aborts exactly like a publish failure does above — restore the
    // draft (never silently drop the typed task) and propagate. A "keep
    // active" request that could not be durably armed must never quietly
    // downgrade into an unpersisted one-shot run — that would silently
    // defeat the one thing the user explicitly asked for.
    if (action === "keep-active") {
      try {
        await deps.armForChat?.(pair);
      } catch (error) {
        const abandoned = preservedDraft ?? "";
        preservedDraft = null;
        deps.restoreDraft(abandoned);
        throw new Error(
          `Cross could not be armed for this chat: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Owner direction (fix round 1): arming with an empty draft AND no
      // history has nothing to run yet — firing one anyway would be the
      // same doomed-run confusion Start's own pending-one-shot path above
      // avoids ("Cross started …" immediately followed by a context/
      // task-invalid block). Notify and stop here instead: the very next
      // message the user sends starts the first real run through the
      // ordinary armed-dispatch path (runPlainLoop/runDashboard). With
      // history present, arming instead falls straight through to the
      // continuation run below — "when I activate Cross, both models
      // should directly understand the task together with the conversation
      // history."
      if (emptyWithNoHistory) {
        preservedDraft = null;
        deps.notifyActivated?.(pair, CROSS_GATE_ARMED_IDLE_DETAIL);
        return;
      }
      deps.notifyActivated?.(
        pair,
        draftEmpty ? CROSS_GATE_ARMED_CONTINUATION_DETAIL : CROSS_GATE_ARMED_RUNNING_DETAIL,
      );
    }
    // `draftEmpty` here always implies history exists — the only other
    // empty-draft case (`emptyWithNoHistory`) already returned above for
    // both "start" and "keep-active".
    const task = draftEmpty ? CROSS_GATE_CONTINUATION_TASK : (preservedDraft ?? "");
    preservedDraft = null;
    const run = deps.port.start(task, pair);
    if (deps.launchRun) deps.launchRun(run);
    else await run;
    return;
  }
}

function assertCrossRoleSelection(selection: ResolvedRoutePickerSelection): void {
  if (!selection.candidate.capabilities.includes("text")
    || !selection.candidate.capabilities.includes("tools")) {
    throw new Error("Cross route lacks required capabilities.");
  }
}

function sameResolvedPickerRoute(
  left: ResolvedRoutePickerSelection,
  right: ResolvedRoutePickerSelection,
): boolean {
  const a = left.route;
  const b = right.route;
  return left.connectionId === right.connectionId
    && a.version === b.version
    && a.backendId === b.backendId
    && a.accountFingerprint === b.accountFingerprint
    && a.billingRealm === b.billingRealm
    && a.requestedModelId === b.requestedModelId
    && a.canonicalModelId === b.canonicalModelId
    && a.resolutionState === b.resolutionState;
}

function opaqueRouteLabel(selection: RoutePickerSelectionIntent | null, view: RoutePickerView): string {
  if (!selection) return "Not selected";
  const row = view.candidates.find((candidate) => candidate.handle === selection.handle);
  return row ? desktopCrossRoutePresentation(row) : "Selection expired";
}
