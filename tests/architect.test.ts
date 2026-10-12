import assert from "node:assert/strict";
import test from "node:test";
import { PermissionDeniedError } from "../src/approval.js";
import type { ApprovalRequest } from "../src/approval.js";
import type { ToolCallPreview } from "../src/types.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import { createTheme } from "../src/ui/theme.js";
import {
  ARCHITECT_CONFIRM_TITLE,
  ARCHITECT_EMPTY_DRAFT_REFUSAL,
  ARCHITECT_EXECUTOR_UNSET_REFUSAL,
  ARCHITECT_UNAVAILABLE_KIMI,
  architectCancelNotice,
  architectConfirmConsequence,
  architectEmptyExecutorSummary,
  architectResultBlock,
  architectResultFacts,
  architectResultHead,
  architectStepOutcome,
  createArchitectPlannerApprovals,
} from "../src/architect.js";

function route(model: string, backendId: RouteIdentityV1["backendId"] = "openrouter"): RouteIdentityV1 {
  return Object.freeze({
    version: 1,
    backendId,
    accountFingerprint: `acct-${model}`,
    billingRealm: backendId === "openrouter" ? "openrouter-payg" : "kimi-code-membership-provider-managed-overage",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
}

const planner = route("anthropic/claude-opus-5");
const executor = route("qwen/qwen3.5-flash-02-23");

// ---------------------------------------------------------------------------
// Ruling 3: the planner's structural write-block. "Structurally unreachable"
// means the prompt handler is never even consulted for a write-risk request
// — proven the same way `tests/approval.test.ts`'s own "read-only blocks
// writes" test proves it for `ApprovalManager` generally: an ACCEPTING
// prompt handler still never gets asked.
// ---------------------------------------------------------------------------

const editRequest: ApprovalRequest = {
  name: "write_file",
  risk: "edit",
  summary: "src/index.ts overwrite",
};
const shellRequest: ApprovalRequest = {
  name: "run_command",
  risk: "shell",
  summary: "npm test",
};
const secretReadRequest: ApprovalRequest = {
  name: "read_file",
  risk: "secret-read",
  summary: "confidential file read",
};
const readRequest: ApprovalRequest = {
  name: "read_file",
  risk: "read",
  summary: "src/index.ts read",
};

test("createArchitectPlannerApprovals is read-only mode", () => {
  assert.equal(createArchitectPlannerApprovals().mode, "read-only");
});

test("policy assertion: a write tool is structurally unreachable for the planner, not merely unused", async () => {
  const asked: ToolCallPreview[] = [];
  const approvals = createArchitectPlannerApprovals();
  // Overwrite the auto-deny handler with one that WOULD accept if ever
  // reached — proves the block happens before the prompt handler, not
  // because nothing asked it to accept.
  approvals.setPromptHandler(async (preview) => {
    asked.push(preview);
    return { accepted: true };
  });
  await assert.rejects(approvals.authorize(editRequest), PermissionDeniedError);
  await assert.rejects(approvals.authorize(shellRequest), PermissionDeniedError);
  assert.deepEqual(asked, [], "read-only must deny edit/shell without ever consulting the prompt handler");
});

test("planner's own auto-deny prompt handler additionally closes the always-ask risk categories", async () => {
  const approvals = createArchitectPlannerApprovals();
  await assert.rejects(approvals.authorize(secretReadRequest), PermissionDeniedError);
});

test("planner can still read — the block is write-specific, not a refusal of everything", async () => {
  const approvals = createArchitectPlannerApprovals();
  await assert.doesNotReject(approvals.authorize(readRequest));
});

// ---------------------------------------------------------------------------
// Ruling 1: refusal copy.
// ---------------------------------------------------------------------------

test("refusal copy is fixed and non-empty", () => {
  assert.equal(
    ARCHITECT_EMPTY_DRAFT_REFUSAL,
    "Type your task first — /architect plans it before a cheaper model builds it.",
  );
  assert.equal(
    ARCHITECT_EXECUTOR_UNSET_REFUSAL,
    "No executor model set — Settings > Models picks one.",
  );
  assert.equal(ARCHITECT_UNAVAILABLE_KIMI, "Architect is unavailable on Kimi Code routes");
  assert.equal(ARCHITECT_CONFIRM_TITLE, "Execute this plan with the executor model?");
});

// ---------------------------------------------------------------------------
// Ruling 4: the D4 confirmation's call-split + cost line.
// ---------------------------------------------------------------------------

test("confirmation consequence: exact call count, priced executor", () => {
  const line = architectConfirmConsequence(
    planner,
    executor,
    { backendId: "openrouter", promptPrice: 0.000001, completionPrice: 0.000002 },
    4_000,
  );
  assert.match(line, /^Planner: claude-opus-5 · Executor: qwen3\.5-flash-02-23 · 1 planning call done · 1 executor call ahead · est\. /);
  assert.doesNotMatch(line, /cost unknown/);
});

test("confirmation consequence: provider-managed executor route reads as cost unknown, never silent", () => {
  const line = architectConfirmConsequence(
    planner,
    route("kimi-k2", "kimi-code"),
    { backendId: "kimi-code", promptPrice: undefined, completionPrice: undefined },
    4_000,
  );
  assert.match(line, /1 planning call done · 1 executor call ahead · est\. cost unknown$/);
});

test("confirmation consequence: an unpriced OpenRouter route also reads as cost unknown (diverges from cost-forecast.ts's own silence convention)", () => {
  const line = architectConfirmConsequence(
    planner,
    executor,
    { backendId: "openrouter", promptPrice: undefined, completionPrice: undefined },
    4_000,
  );
  assert.match(line, /est\. cost unknown$/);
});

// ---------------------------------------------------------------------------
// Ruling 4: cancel-after-plan books only the planning cost, disclosed.
// ---------------------------------------------------------------------------

test("cancel notice discloses the already-booked planning cost", () => {
  const notice = architectCancelNotice({ costUsd: 0.1234, costKnowledge: "known" });
  // `formatUsd` (utils.ts), not the D2 block's own `.toFixed(4)` — 3
  // decimals above the 1-cent threshold.
  assert.equal(
    notice,
    "Architect cancelled — planning cost already booked: $0.123. No executor calls were made.",
  );
});

test("cancel notice is honest about unknown cost knowledge", () => {
  const notice = architectCancelNotice({ costUsd: 0, costKnowledge: "unknown" });
  assert.equal(
    notice,
    "Architect cancelled — planning cost already booked (provider-managed / unknown). No executor calls were made.",
  );
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 1: the empty-summary copy reports the real `changed`
// flag rather than assuming changes were made.
// ---------------------------------------------------------------------------

test("empty-executor-summary copy never claims changes the diff did not show", () => {
  assert.equal(
    architectEmptyExecutorSummary(true),
    "(the executor made changes but produced no summary text)",
  );
  const unchanged = architectEmptyExecutorSummary(false);
  assert.equal(
    unchanged,
    "(the executor produced no summary and no workspace changes were detected)",
  );
  assert.doesNotMatch(unchanged, /made changes/, "the no-change copy must not read as a change claim");
});

// ---------------------------------------------------------------------------
// Step outcome mapping.
// ---------------------------------------------------------------------------

test("architectStepOutcome mirrors crossWorkerOutcome's own real-content-survives mapping", () => {
  assert.equal(architectStepOutcome("completed", "anything"), "completed");
  assert.equal(architectStepOutcome("completed", ""), "completed");
  assert.equal(architectStepOutcome("step-limit", "partial text"), "partial");
  assert.equal(architectStepOutcome("cancelled", ""), "blocked");
  assert.equal(architectStepOutcome("error", ""), "blocked");
});

// ---------------------------------------------------------------------------
// Ruling 6: the D2 (`●`/`⎿`) published-result block pin.
// ---------------------------------------------------------------------------

test("D2 result block pin: head names both short model names, foot states phase and cost", () => {
  const theme = createTheme({ level: 0 });
  const block = architectResultBlock(theme, planner, executor, "completed", 0.5);
  assert.equal(
    block,
    "● Architect(claude-opus-5 + qwen3.5-flash-02-23)\n"
    + "⎿ ✓ completed · $0.500",
  );
});

test("D2 result block pin: cancelled phase, cost omitted when unknown (never $0.0000)", () => {
  const theme = createTheme({ level: 0 });
  const block = architectResultBlock(theme, planner, executor, "cancelled", undefined);
  assert.equal(
    block,
    "● Architect(claude-opus-5 + qwen3.5-flash-02-23)\n"
    + "⎿ ⚠ cancelled",
  );
});

test("D2 result block pin: blocked phase glyph", () => {
  const theme = createTheme({ level: 0 });
  const facts = architectResultFacts(theme, "blocked", 1.5);
  assert.equal(facts, "✗ blocked · $1.500");
});

test("architectResultHead uses short model names, matching Cross's own crossResultHead convention", () => {
  assert.equal(architectResultHead(planner, executor), "Architect(claude-opus-5 + qwen3.5-flash-02-23)");
});
