import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSlashCommand,
  type ArchitectCommandPort,
  type CommandContext,
} from "../src/commands.js";
import {
  ARCHITECT_EMPTY_DRAFT_REFUSAL,
  ARCHITECT_EXECUTOR_UNSET_REFUSAL,
  architectConfirmConsequence,
  architectEmptyExecutorSummary,
  type ArchitectExecuteResult,
  type ArchitectPlanResult,
} from "../src/architect.js";
import type { RouteIdentityV1 } from "../src/backends.js";

function route(model: string): RouteIdentityV1 {
  return Object.freeze({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: `acct-${model}`,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
}

const plannerRoute = route("anthropic/claude-opus-5");
const executorRoute = route("qwen/qwen3.5-flash-02-23");

function planResult(overrides: Partial<ArchitectPlanResult> = {}): ArchitectPlanResult {
  return {
    text: "1. Do the thing\n2. Test the thing",
    outcome: "completed",
    costKnowledge: "known",
    costUsd: 0.05,
    mainCostUsd: 0.05,
    compressorCostUsd: 0,
    plannerRoute,
    ...overrides,
  };
}

function executeResult(overrides: Partial<ArchitectExecuteResult> = {}): ArchitectExecuteResult {
  return {
    text: "Done: implemented the thing.",
    changed: true,
    outcome: "completed",
    costKnowledge: "known",
    costUsd: 0.02,
    mainCostUsd: 0.02,
    compressorCostUsd: 0,
    executorRoute,
    ...overrides,
  };
}

interface Fixture {
  readonly context: CommandContext;
  readonly calls: string[];
  readonly output: string[];
  readonly costEntries: Array<{ kind: string; amount: number; knowledge?: string }>;
  readonly turns: Array<{ role: string; content: string }>;
  readonly saves: { count: number };
  readonly restores: { count: number };
}

function fixture(input: {
  readonly draft?: string;
  readonly unavailableReason?: string | null;
  readonly executorRoute?: RouteIdentityV1 | null;
  readonly plan?: ArchitectPlanResult | (() => ArchitectPlanResult);
  readonly execute?: ArchitectExecuteResult | (() => ArchitectExecuteResult);
  readonly confirmAnswer?: boolean;
  readonly chatContextChars?: number;
  readonly executorPromptPrice?: number;
}): Fixture {
  const calls: string[] = [];
  const output: string[] = [];
  const costEntries: Array<{ kind: string; amount: number; knowledge?: string }> = [];
  const turns: Array<{ role: string; content: string }> = [];
  const saves = { count: 0 };
  const restores = { count: 0 };

  const architect: ArchitectCommandPort = {
    unavailableReason: () => input.unavailableReason ?? null,
    executorRoute: () => (input.executorRoute === undefined ? executorRoute : input.executorRoute),
    // FIX-14 ticket 4: `chatContextChars` is REQUIRED on the port now, so
    // the double always supplies it — "no packet" is stated as 0, never
    // left to a default that would understate a money figure at the
    // confirmation.
    chatContextChars: () => input.chatContextChars ?? 0,
    async plan(task) {
      calls.push(`plan:${task}`);
      return typeof input.plan === "function" ? input.plan() : input.plan ?? planResult();
    },
    async execute(task) {
      calls.push(`execute:${task}`);
      return typeof input.execute === "function" ? input.execute() : input.execute ?? executeResult();
    },
  };

  const context = {
    architect,
    composerDraft: {
      read: () => input.draft ?? "",
      restore: () => { restores.count += 1; },
    },
    // FIX-14 ticket 6: the one shared confirm seam.
    confirm: async (request: { consequence?: string }) => {
      calls.push(`confirm:${request.consequence ?? ""}`);
      return input.confirmAnswer ?? true;
    },
    openRouter: {
      async loadModels() {
        return input.executorPromptPrice === undefined ? [] : [{
          id: executorRoute.requestedModelId,
          canonicalSlug: executorRoute.requestedModelId,
          promptPrice: input.executorPromptPrice,
          completionPrice: input.executorPromptPrice * 2,
        }];
      },
    },
    session: {
      addCost: (kind: string, amount: number, knowledge?: string) => {
        costEntries.push({ kind, amount, knowledge });
      },
      addTurn: (role: string, content: string) => {
        turns.push({ role, content });
      },
      save: async () => {
        saves.count += 1;
      },
    },
    out: {
      text: (value: string) => output.push(value),
      error: (value: string) => output.push(value),
    },
  } as unknown as CommandContext;

  return { context, calls, output, costEntries, turns, saves, restores };
}

test("empty draft (no inline task, empty composer draft) refuses honestly and never plans", async () => {
  const { context, calls, output } = fixture({ draft: "  " });
  assert.equal(await handleSlashCommand("/architect", context), "continue");
  assert.deepEqual(calls, []);
  assert.deepEqual(output, [ARCHITECT_EMPTY_DRAFT_REFUSAL]);
});

test("unset executor refuses honestly and never plans — never a silent main-route fallback", async () => {
  const { context, calls, output } = fixture({ executorRoute: null, draft: "fix the bug" });
  assert.equal(await handleSlashCommand("/architect", context), "continue");
  assert.deepEqual(calls, []);
  assert.deepEqual(output, [ARCHITECT_EXECUTOR_UNSET_REFUSAL]);
});

test("Kimi unavailability refuses before checking the executor or planning", async () => {
  const { context, calls, output } = fixture({
    unavailableReason: "Architect is unavailable on Kimi Code routes",
    draft: "fix the bug",
  });
  assert.equal(await handleSlashCommand("/architect", context), "continue");
  assert.deepEqual(calls, []);
  assert.deepEqual(output, ["Architect is unavailable on Kimi Code routes"]);
});

test("inline task text is used directly, bypassing the composer draft", async () => {
  const { context, calls } = fixture({ draft: "ignored draft" });
  await handleSlashCommand("/architect fix the exact bug", context);
  assert.ok(calls.includes("plan:fix the exact bug"), calls.join(", "));
});

test("bare /architect takes the task from the composer draft, exactly like Cross's gate", async () => {
  const { context, calls } = fixture({ draft: "the drafted task" });
  await handleSlashCommand("/architect", context);
  assert.ok(calls.includes("plan:the drafted task"), calls.join(", "));
});

// ---------------------------------------------------------------------------
// Fix round 1, controller addendum: a refusal hands the consumed composer
// draft straight back — the same restore seam Cross's cancelled gate calls,
// never a silent "failed submit clears the composer".
// ---------------------------------------------------------------------------

test("every refusal restores the consumed composer draft; a run that actually starts spends it", async () => {
  for (const refusal of [
    { name: "Kimi unavailable", input: { unavailableReason: "Architect is unavailable on Kimi Code routes" } },
    { name: "executor unset", input: { executorRoute: null } },
    { name: "whitespace-only draft", input: { draft: "   " } },
  ] as const) {
    const { context, calls, restores } = fixture({ draft: "refactor the parser", ...refusal.input });
    await handleSlashCommand("/architect", context);
    assert.deepEqual(calls, [], `${refusal.name}: nothing may run`);
    assert.equal(restores.count, 1, `${refusal.name}: the owner's text must go back to the composer`);
  }

  // Once the planner has run, real work happened and real cost was booked:
  // the draft is spent, exactly like Cross discards it on start.
  const started = fixture({ draft: "refactor the parser", confirmAnswer: false });
  await handleSlashCommand("/architect", started.context);
  assert.equal(started.restores.count, 0, "a booked planning call must not resurrect the draft");

  // An inline task consumes no draft, so a refusal has nothing of this
  // invocation's to give back — and must never restore an older one.
  const inline = fixture({ draft: "refactor the parser", executorRoute: null });
  await handleSlashCommand("/architect fix the bug", inline.context);
  assert.equal(inline.restores.count, 0, "an inline task must never resurrect a stale draft");
});

test("empty plan text refuses without ever offering a confirmation — planning cost is still booked", async () => {
  const { context, calls, output, costEntries, turns } = fixture({
    draft: "fix the bug",
    plan: () => planResult({ text: "" }),
  });
  await handleSlashCommand("/architect", context);
  assert.ok(calls.includes("plan:fix the bug"), `the planner must still have run: ${calls.join(", ")}`);
  assert.ok(!calls.some((call) => call.startsWith("confirm:")), "no confirmation was ever offered");
  assert.ok(!calls.some((call) => call.startsWith("execute:")), "the executor must never run");
  assert.deepEqual(costEntries, [
    { kind: "main", amount: 0.05, knowledge: undefined },
    { kind: "compressor", amount: 0, knowledge: undefined },
  ]);
  assert.deepEqual(turns, [], "an empty plan produces no fabricated conversation turn");
  assert.ok(output.some((line) => line.includes("no plan")), output.join("\n---\n"));
});

// ---------------------------------------------------------------------------
// Ruling 4: one confirmation gates execution; cancel books only the planning
// cost, disclosed.
// ---------------------------------------------------------------------------

test("one confirmation gates execution: declining runs the planner's cost only, the executor never runs", async () => {
  const { context, calls, costEntries, turns, saves } = fixture({
    draft: "fix the bug",
    confirmAnswer: false,
  });
  await handleSlashCommand("/architect", context);

  assert.ok(calls.includes("plan:fix the bug"), `the planner must have run: ${calls.join(", ")}`);
  assert.ok(calls.some((call) => call.startsWith("confirm:")), `exactly one confirmation must have been offered: ${calls.join(", ")}`);
  assert.ok(!calls.some((call) => call.startsWith("execute:")), "cancel must structurally never reach execute");

  // Exactly the planner's cost was booked — no executor cost entries exist
  // anywhere in the call history, not merely "zero this time".
  assert.deepEqual(costEntries, [
    { kind: "main", amount: 0.05, knowledge: undefined },
    { kind: "compressor", amount: 0, knowledge: undefined },
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, "user");
  assert.equal(turns[0]!.content, "fix the bug");
  assert.equal(turns[1]!.role, "assistant");
  assert.match(turns[1]!.content, /^1\. Do the thing\n2\. Test the thing\n\n/);
  assert.match(turns[1]!.content, /● Architect\(claude-opus-5 \+ qwen3\.5-flash-02-23\)/);
  assert.match(turns[1]!.content, /⎿ ⚠ cancelled · \$0\.050/);

  assert.equal(saves.count, 2, "cost booking and the cancelled turn each save once");
});

test("cancel notice discloses the already-booked planning cost and that zero executor calls were made", async () => {
  const { context, output } = fixture({ draft: "fix the bug", confirmAnswer: false });
  await handleSlashCommand("/architect", context);
  assert.ok(
    output.some((line) => line.includes("planning cost already booked") && line.includes("No executor calls were made")),
    output.join("\n---\n"),
  );
});

test("accepting the confirmation runs the executor and books both costs", async () => {
  const { context, calls, costEntries, turns } = fixture({ draft: "fix the bug", confirmAnswer: true });
  await handleSlashCommand("/architect", context);

  assert.ok(calls.includes("plan:fix the bug"), `the planner must have run: ${calls.join(", ")}`);
  assert.ok(calls.includes("execute:fix the bug"), `the executor must have run the same task: ${calls.join(", ")}`);

  assert.deepEqual(costEntries, [
    { kind: "main", amount: 0.05, knowledge: undefined },
    { kind: "compressor", amount: 0, knowledge: undefined },
    { kind: "main", amount: 0.02, knowledge: undefined },
    { kind: "compressor", amount: 0, knowledge: undefined },
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[1]!.content, "Done: implemented the thing.\n\n● Architect(claude-opus-5 + qwen3.5-flash-02-23)\n⎿ ✓ completed · $0.070");
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 3 (money honesty, the Cross gate's own H1 defect):
// the consent point prices what the executor call ACTUALLY sends — context
// packet + task + plan — never the plan text alone.
// ---------------------------------------------------------------------------

function confirmedConsequence(calls: readonly string[]): string {
  const line = calls.find((call) => call.startsWith("confirm:"));
  assert.ok(line !== undefined, `no confirmation was offered: ${calls.join(", ")}`);
  return line.slice("confirm:".length);
}

test("the confirmation prices context packet + task + plan, strictly above the old plan-only estimate", async () => {
  const task = "fix the bug";
  const withContext = fixture({
    draft: task,
    confirmAnswer: false,
    chatContextChars: 40_000,
    executorPromptPrice: 0.000001,
  });
  await handleSlashCommand("/architect", withContext.context);

  const planOnly = fixture({ draft: task, confirmAnswer: false, executorPromptPrice: 0.000001 });
  await handleSlashCommand("/architect", planOnly.context);

  const priced = confirmedConsequence(withContext.calls);
  const understated = confirmedConsequence(planOnly.calls);
  assert.doesNotMatch(priced, /cost unknown/, priced);
  assert.notEqual(
    priced,
    understated,
    "a 40k-char context packet must move the consent-point band, not vanish from it",
  );
  assert.equal(
    priced,
    architectConfirmConsequence(
      plannerRoute,
      executorRoute,
      { backendId: "openrouter", promptPrice: 0.000001, completionPrice: 0.000002 },
      40_000 + task.length + planResult().text.length,
    ),
    "the band must be the one estimator fed the exact chars the executor call will send",
  );
});

test("a chatContextChars of 0 prices task + plan alone — never a fabricated context figure (FIX-14 ticket 4: the port method is required, so 0 is stated, not defaulted)", async () => {
  const task = "fix the bug";
  const { context, calls } = fixture({ draft: task, confirmAnswer: false, executorPromptPrice: 0.000001, chatContextChars: 0 });
  await handleSlashCommand("/architect", context);
  assert.equal(
    confirmedConsequence(calls),
    architectConfirmConsequence(
      plannerRoute,
      executorRoute,
      { backendId: "openrouter", promptPrice: 0.000001, completionPrice: 0.000002 },
      task.length + planResult().text.length,
    ),
  );
});

// ---------------------------------------------------------------------------
// Ruling 6: the existing run-status machinery shows phases honestly.
// ---------------------------------------------------------------------------

test("both phases are announced, in order, before their own work runs", async () => {
  const { context, output } = fixture({ draft: "fix the bug", confirmAnswer: true });
  await handleSlashCommand("/architect", context);
  const planningIndex = output.indexOf("Architect: planning (read-only) …");
  const executingIndex = output.indexOf("Architect: executing with qwen3.5-flash-02-23 …");
  assert.ok(planningIndex >= 0, output.join("\n---\n"));
  assert.ok(executingIndex >= 0, output.join("\n---\n"));
  assert.ok(planningIndex < executingIndex, "the planning phase is announced before the executing phase");
  // The plan text itself is printed between the two announcements, exactly
  // like a normal assistant response — not hidden until the confirm.
  const planTextIndex = output.indexOf("1. Do the thing\n2. Test the thing");
  assert.ok(planningIndex < planTextIndex && planTextIndex < executingIndex, output.join("\n---\n"));
});

test("only the planning phase is announced when the confirmation is declined", async () => {
  const { context, output } = fixture({ draft: "fix the bug", confirmAnswer: false });
  await handleSlashCommand("/architect", context);
  assert.ok(output.includes("Architect: planning (read-only) …"), output.join("\n---\n"));
  assert.ok(!output.some((line) => line.startsWith("Architect: executing")), output.join("\n---\n"));
});

test("D2 result block pin: partial executor outcome still publishes real content with the correct phase", async () => {
  const { context, turns } = fixture({
    draft: "fix the bug",
    confirmAnswer: true,
    execute: () => executeResult({ outcome: "partial", text: "partial progress" }),
  });
  await handleSlashCommand("/architect", context);
  assert.match(turns[1]!.content, /^partial progress\n\n/);
  assert.match(turns[1]!.content, /⎿ ⚠ partial/);
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 1: the completion line reports the executor's REAL
// `changed` flag (the before/after `readDiff()` comparison), never an
// assumed "made changes" that would contradict the block printed above it.
// ---------------------------------------------------------------------------

test("an empty executor summary with no workspace changes says so — it never claims changes were made", async () => {
  const { context, output, turns } = fixture({
    draft: "fix the bug",
    confirmAnswer: true,
    execute: () => executeResult({ text: "", changed: false, outcome: "blocked" }),
  });
  await handleSlashCommand("/architect", context);
  const last = output.at(-1)!;
  assert.equal(last, architectEmptyExecutorSummary(false), output.join("\n---\n"));
  assert.doesNotMatch(last, /made changes/, "a run that touched nothing must never claim it made changes");
  // And it must agree with the ✗ blocked block published right above it.
  assert.match(turns[1]!.content, /⎿ ✗ blocked/);
});

test("an empty executor summary after real workspace changes still reports the changes", async () => {
  const { context, output } = fixture({
    draft: "fix the bug",
    confirmAnswer: true,
    execute: () => executeResult({ text: "", changed: true, outcome: "partial" }),
  });
  await handleSlashCommand("/architect", context);
  assert.equal(output.at(-1)!, architectEmptyExecutorSummary(true), output.join("\n---\n"));
});

test("unknown cost knowledge on either leg omits the cost figure — never a fabricated $0.0000", async () => {
  const { context, turns } = fixture({
    draft: "fix the bug",
    confirmAnswer: true,
    plan: () => planResult({ costKnowledge: "unknown" }),
  });
  await handleSlashCommand("/architect", context);
  assert.doesNotMatch(turns[1]!.content, /\$/);
});
