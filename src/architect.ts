/**
 * Phase 14: Architect mode — an expensive planner (the main route, read-only)
 * produces a plan; on one D4-ordinary confirmation, a cheap configurable
 * executor route implements it with normal approvals.
 *
 * Controller ruling 3: this is a "degenerate Cross" in SPIRIT (planner
 * analyzes, executor implements, no challenger/verification/repair phases)
 * but NOT in implementation — `CrossCoordinator#run` (collaboration.ts)
 * hardcodes a fixed dual-role shape (lead ANALYZES its own plan and later
 * IMPLEMENTS it itself; challenger only ever reviews read-only) that cannot
 * express "one model plans, a DIFFERENT model implements that plan" without
 * surgery to the coordinator's private `#run` state machine — exactly the
 * restructuring the program-wide constraint forbids. The sanctioned
 * alternative (ruling 3) is used instead: two sequential ordinary agent runs
 * through the EXISTING agent machinery (`OrcodeAgent.create`, `SessionStore`,
 * `ApprovalManager`) — the same sidecar-session pattern
 * `createCrossWorkerAdapter` (cli.ts) already uses for Cross's own lead/
 * challenger roles, just without the coordinator class wrapped around it.
 * Genuine reuse still applies where it fits: `createContextPacketV1`
 * (collaboration.ts) builds both prompts' redacted context packet, and the
 * cost-estimate math below is `cost-forecast.ts`'s own Phase-12 functions,
 * not a second implementation.
 *
 * This module holds the pure, directly testable pieces: refusal/label copy,
 * the D4 confirmation's cost-split line, the D2 (`●`/`⎿`) published-result
 * block, and the planner's structural write-block policy factory. The
 * sequential orchestration itself (call planner, print, confirm, call
 * executor, book cost, publish) lives in commands.ts's `architectCommand`,
 * driven through `ArchitectCommandPort`; the concrete sidecar-agent wiring
 * lives in cli.ts, mirroring exactly how Cross splits between the two.
 */

import { ApprovalManager } from "./approval.js";
import type { RouteIdentityV1 } from "./backends.js";
import {
  classifyCostForecastPrice,
  computePromptCostForecast,
  FALLBACK_OUTPUT_TOKEN_BAND,
  type PromptCostForecast,
} from "./cost-forecast.js";
import type { CostKnowledge } from "./types.js";
import { formatCostForecastBand, formatUsd, shortModelName } from "./utils.js";
import type { Theme } from "./ui/theme.js";

// ---------------------------------------------------------------------------
// Ruling 1: surface copy — bare `/architect` requires a drafted task; the
// Cross-style waiting/continuation machinery is deliberately NOT replicated.
// ---------------------------------------------------------------------------

export const ARCHITECT_EMPTY_DRAFT_REFUSAL =
  "Type your task first — /architect plans it before a cheaper model builds it.";

/**
 * Ruling 2: unset executor is an honest refusal, never a silent fallback to
 * the main route (that would defeat both the mode's purpose and its cost
 * promise).
 */
export const ARCHITECT_EXECUTOR_UNSET_REFUSAL =
  "No executor model set — Settings > Models picks one.";

/**
 * Ruling 5: same reason-copy pattern as Cross's own
 * `crossUnavailableReasonFor` ("Cross is unavailable on Kimi Code routes",
 * cli.ts) — gates the whole `/architect` command AND the executor Settings
 * row the same way, when the CURRENT session's route is Kimi Code.
 */
export const ARCHITECT_UNAVAILABLE_KIMI = "Architect is unavailable on Kimi Code routes";

/**
 * The ONE place the Architect availability CONDITION is evaluated. Both
 * gates call exactly this — `/architect` itself
 * (`architectUnavailableReasonFor`, cli.ts) and the executor Settings row
 * (settings-registry.ts) — for the reason Cross's own doc comment already
 * names for its equivalent: two independently maintained checks drift
 * apart. A shared reason STRING only keeps the copy aligned; a second
 * provider-managed backend would still have to be remembered in two
 * places. `null`/`undefined` (no resolved session route yet) is not a Kimi
 * route, so gating does not apply.
 */
export function architectUnavailableReasonForRoute(
  route: Pick<RouteIdentityV1, "backendId"> | null | undefined,
): string | null {
  return route?.backendId === "kimi-code" ? ARCHITECT_UNAVAILABLE_KIMI : null;
}

/**
 * Ruling 4: D4 ordinary class (not danger) — executing a shown plan with
 * normal approvals afterward is ordinary; Enter accepts.
 */
export const ARCHITECT_CONFIRM_TITLE = "Execute this plan with the executor model?";

// ---------------------------------------------------------------------------
// Ruling 3: the planner's structural write-block.
// ---------------------------------------------------------------------------

/**
 * Constructs the EXACT `ApprovalManager` the planner runs with: `"read-only"`
 * mode denies risk `"edit"`/`"shell"` at the `#decide` layer before any
 * prompt is ever shown (approval.ts), and the auto-deny prompt handler below
 * additionally closes the always-ask risk categories (`secret-read`,
 * `remote-shell`, `network-fetch`) that read-only mode alone still routes to
 * a prompt. This is the identical construction Cross's own challenger role
 * uses (`createCrossWorkerAdapter`, cli.ts) to guarantee it never writes —
 * proven-in-production, not new policy. Exported (not inlined at the one
 * production call site) so the policy-assertion test exercises this SAME
 * factory: proof that a write tool is structurally unreachable, not merely
 * unused by whatever the model happened to try.
 */
export function createArchitectPlannerApprovals(): ApprovalManager {
  const approvals = new ApprovalManager("read-only");
  approvals.setPromptHandler(async () => ({ accepted: false }));
  return approvals;
}

// ---------------------------------------------------------------------------
// Cost/usage shapes — deliberately NOT `CrossWorkerUsage`/`CrossWorkerTextResult`
// (collaboration.ts): architect has no lead/challenger roles, so its own
// small, self-contained shapes avoid coupling to Cross's internal types.
// ---------------------------------------------------------------------------

export interface ArchitectRunUsage {
  readonly costKnowledge: CostKnowledge;
  readonly costUsd: number;
  readonly mainCostUsd: number;
  readonly compressorCostUsd: number;
}

export type ArchitectStepOutcome = "completed" | "partial" | "blocked";

export interface ArchitectPlanResult extends ArchitectRunUsage {
  readonly text: string;
  readonly outcome: ArchitectStepOutcome;
  readonly plannerRoute: RouteIdentityV1;
}

export interface ArchitectExecuteResult extends ArchitectRunUsage {
  readonly text: string;
  readonly changed: boolean;
  readonly outcome: ArchitectStepOutcome;
  readonly executorRoute: RouteIdentityV1;
}

/** Same mapping `crossWorkerOutcome` (cli.ts) uses for Cross's own worker results: real content survives even a non-"completed" run outcome. */
export function architectStepOutcome(
  outcome: "completed" | "unverified" | "step-limit" | "cost-limit" | "cancelled" | "error",
  text: string,
): ArchitectStepOutcome {
  if (outcome === "completed") return "completed";
  return text.trim() ? "partial" : "blocked";
}

// ---------------------------------------------------------------------------
// Ruling 4: the confirmation's honest call-split + cost line.
// ---------------------------------------------------------------------------

export interface ArchitectExecutorPriceInput {
  readonly backendId: string;
  readonly promptPrice: number | undefined;
  readonly completionPrice: number | undefined;
}

/**
 * No repair loop exists (ruling 3: no challenger/verification/repair
 * phases), so the call count is exact, not a band: exactly one planning
 * call (already done, its cost already booked) and exactly one executor
 * call ahead (one `agent.run()` invocation implements the whole plan). Only
 * the DOLLAR estimate is a band — reusing `cost-forecast.ts`'s own Phase-12
 * math (`classifyCostForecastPrice`/`computePromptCostForecast`) against the
 * executor's cached catalog price.
 *
 * `promptChars` is what the executor call will ACTUALLY send, never a
 * fraction of it: the caller (`architectCommand`, commands.ts) sums the
 * context packet's chars, the task, and the accepted plan. Feeding the plan
 * alone understated the consent point by construction in any long chat —
 * the same H1 defect FIX-10 fixed for the Cross gate's Start row, fixed the
 * same way (one estimator, honest input).
 *
 * Deliberately diverges from `formatPromptCostForecast`'s own "unpriced
 * shows no segment" convention: THIS is a confirmation gate about to spend
 * real money, not muted status-line chrome, so an unpriced or
 * provider-managed executor route reads as the explicit "cost unknown"
 * ruling 4 asks for, never silence.
 */
export function architectConfirmConsequence(
  plannerRoute: RouteIdentityV1,
  executorRoute: RouteIdentityV1,
  executorPrice: ArchitectExecutorPriceInput,
  promptChars: number,
): string {
  const forecast = computePromptCostForecast({
    promptChars,
    price: classifyCostForecastPrice(executorPrice),
    outputTokenBand: FALLBACK_OUTPUT_TOKEN_BAND,
  });
  const costLabel = architectCostLabel(forecast);
  return `Planner: ${shortModelName(plannerRoute.requestedModelId)} · `
    + `Executor: ${shortModelName(executorRoute.requestedModelId)} · `
    + `1 planning call done · 1 executor call ahead · est. ${costLabel}`;
}

function architectCostLabel(forecast: PromptCostForecast): string {
  if (forecast.kind === "band") return formatCostForecastBand(forecast.minUsd, forecast.maxUsd);
  return "cost unknown";
}

/**
 * The one line that tells the owner what the executor actually did when it
 * returned no summary text of its own. It reports `changed` — the real
 * before/after `readDiff()` comparison the executor run computes (cli.ts's
 * `execute()`) — never an assumption: a blocked or empty executor run that
 * touched nothing must not claim changes were made, least of all directly
 * under a `✗ blocked` D2 block stating the opposite.
 */
export function architectEmptyExecutorSummary(changed: boolean): string {
  return changed
    ? "(the executor made changes but produced no summary text)"
    : "(the executor produced no summary and no workspace changes were detected)";
}

/**
 * Ruling 4: "Cancel: plan cost stays booked (disclosed in the cancel
 * notice), zero executor calls." The planning cost is booked into the
 * session unconditionally, before this notice is ever printed — the text
 * only DISCLOSES that fact, it never re-books anything.
 */
export function architectCancelNotice(plan: Pick<ArchitectPlanResult, "costUsd" | "costKnowledge">): string {
  return plan.costKnowledge === "unknown"
    ? "Architect cancelled — planning cost already booked (provider-managed / unknown). No executor calls were made."
    : `Architect cancelled — planning cost already booked: ${formatUsd(plan.costUsd)}. No executor calls were made.`;
}

// ---------------------------------------------------------------------------
// Ruling 6: the D2 (`●`/`⎿`) published-result block, reusing the exact
// grammar `crossResultBlock` (cli.ts) established — same glyph roles
// (`toolHead`/`blockFoot`), same "head names the pair, foot states the
// facts" shape, only the facts differ (no verification/repair phase exists
// for architect to report).
// ---------------------------------------------------------------------------

export type ArchitectResultPhase = "completed" | "partial" | "blocked" | "cancelled";

function architectPhaseGlyph(theme: Theme, phase: ArchitectResultPhase): string {
  switch (phase) {
    case "completed":
      return theme.glyph("ok");
    case "partial":
    case "cancelled":
      return theme.glyph("warn");
    case "blocked":
      return theme.glyph("failed");
  }
}

/** D2: the bare `Architect(<planner> + <executor>)` head text — mirrors `crossResultHead` (cli.ts) exactly, short model names via the same shared `shortModelName` helper. */
export function architectResultHead(plannerRoute: RouteIdentityV1, executorRoute: RouteIdentityV1): string {
  return `Architect(${shortModelName(plannerRoute.requestedModelId)} + ${shortModelName(executorRoute.requestedModelId)})`;
}

/** D2: `<glyph> <phase>[ · $<cost>]` — the facts line, `costUsd` omitted (never `$0.0000`) wherever the caller has no cost figure to report. */
export function architectResultFacts(
  theme: Theme,
  phase: ArchitectResultPhase,
  costUsd?: number,
): string {
  const facts = [
    phase,
    // FIX-14 ticket 3: `formatUsd`, the one exact-USD formatter. This used
    // to be a deliberate inline `.toFixed(4)` "to match `crossResultFacts`'s
    // own D2 cost formatting (cli.ts)" — two persisted grammars agreeing
    // with each other while disagreeing with every other money surface in
    // the product. Both now agree with all of them instead.
    ...(costUsd !== undefined ? [formatUsd(costUsd)] : []),
  ];
  return `${architectPhaseGlyph(theme, phase)} ${facts.join(" · ")}`;
}

/**
 * The full two-line block every published Architect result becomes:
 * `● Architect(<planner> + <executor>)` / `⎿ <glyph> <phase>[ · $<cost>]`.
 * Persisted verbatim into the assistant turn, so only `theme.glyph()` is
 * used — never `theme.color()` — matching `crossResultBlock`'s own reasoning
 * for staying valid regardless of which theme later re-displays the turn.
 */
export function architectResultBlock(
  theme: Theme,
  plannerRoute: RouteIdentityV1,
  executorRoute: RouteIdentityV1,
  phase: ArchitectResultPhase,
  costUsd?: number,
): string {
  return [
    `${theme.glyph("toolHead")} ${architectResultHead(plannerRoute, executorRoute)}`,
    `${theme.glyph("blockFoot")} ${architectResultFacts(theme, phase, costUsd)}`,
  ].join("\n");
}
