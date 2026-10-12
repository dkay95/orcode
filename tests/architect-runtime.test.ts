import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArchitectRuntime,
  type ArchitectAgentFactoryInput,
} from "../src/cli.js";
import { ApprovalManager } from "../src/approval.js";
import { AgentRunError, bindModelRuntimeIdentity } from "../src/agent.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { RouteIdentityV1 } from "../src/backends.js";

function route(model: string, account = `acct-${model}`): RouteIdentityV1 {
  return Object.freeze({
    version: 1,
    backendId: "openrouter",
    accountFingerprint: account,
    billingRealm: "openrouter-payg",
    requestedModelId: model,
    canonicalModelId: model,
    resolutionState: "resolved",
  });
}

const completed = (text: string) => ({
  text,
  outcome: "completed" as const,
  costKnowledge: "known" as const,
  costUsd: 0.01,
  mainCostUsd: 0.01,
  compressorCostUsd: 0,
});

function boundRuntime(exact: RouteIdentityV1, generation: number) {
  assert.equal(exact.backendId, "openrouter");
  return bindModelRuntimeIdentity({ backendId: "openrouter" } as never, {
    version: 1,
    stateRevision: generation,
    generation,
    connectionId: `connection-${generation}`,
    backendId: "openrouter",
    route: exact,
  });
}

interface Harness {
  readonly appHome: string;
  readonly creations: ArchitectAgentFactoryInput[];
  readonly prompts: Array<{ role: string; prompt: string }>;
  readonly executorApprovals: ApprovalManager;
  readonly plannerRoute: RouteIdentityV1;
  readonly executorRouteValue: { route: RouteIdentityV1 | null };
  readonly runtime: ReturnType<typeof createArchitectRuntime>;
}

async function harness(overrides: {
  readonly run?: (input: ArchitectAgentFactoryInput, prompt: string) => Promise<ReturnType<typeof completed>>;
  readonly unavailableReason?: string | null;
  readonly context?: () => { chat: Array<{ role: "user" | "assistant"; content: string }>; omissions: string[] };
} = {}): Promise<Harness> {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-architect-runtime-"));
  const plannerRoute = route("vendor/planner-main");
  const executorRouteValue: { route: RouteIdentityV1 | null } = { route: route("vendor/executor-cheap") };
  const creations: ArchitectAgentFactoryInput[] = [];
  const prompts: Array<{ role: string; prompt: string }> = [];
  const executorApprovals = new ApprovalManager("ask");
  let diffReads = 0;

  const runtime = createArchitectRuntime({
    workspace: "/tmp/architect-workspace",
    appHome,
    config: (() => {
      const config = structuredClone(DEFAULT_CONFIG);
      config.mainModel = "vendor/owner-main";
      return config;
    })(),
    executorApprovals,
    providerRuntime: {
      modelRuntime(exact) {
        return boundRuntime(exact, 1);
      },
      currentSessionRoute() {
        return plannerRoute;
      },
    },
    async createAgent(input) {
      creations.push(input);
      return {
        async run(prompt: string) {
          prompts.push({ role: input.role, prompt });
          if (overrides.run) return overrides.run(input, prompt);
          return completed(`${input.role} output`);
        },
      };
    },
    async readDiff() {
      diffReads += 1;
      return diffReads === 1 ? "before" : "after";
    },
    context: overrides.context ?? (() => ({ chat: [], omissions: [] })),
    executorRoute: () => executorRouteValue.route,
    unavailableReason: () => overrides.unavailableReason ?? null,
  });

  return { appHome, creations, prompts, executorApprovals, plannerRoute, executorRouteValue, runtime };
}

async function withHarness(
  overrides: Parameters<typeof harness>[0],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness(overrides);
  try {
    await run(h);
  } finally {
    await rm(h.appHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Ruling 3: the planner is structurally read-only; the executor reuses
// "normal approvals" directly.
// ---------------------------------------------------------------------------

test("plan() creates a read-only planner sidecar; execute() reuses the caller's own approvals directly", async () => {
  await withHarness({}, async (h) => {
    const plan = await h.runtime.plan("bounded task");
    assert.equal(plan.plannerRoute.requestedModelId, h.plannerRoute.requestedModelId);
    const plannerCreation = h.creations.find((entry) => entry.role === "planner")!;
    assert.equal(plannerCreation.approvals.mode, "read-only");
    assert.equal(plannerCreation.config.approvalMode, "read-only");

    const executed = await h.runtime.execute("bounded task", plan);
    const executorCreation = h.creations.find((entry) => entry.role === "executor")!;
    // Identity, not just mode — proves "normal approvals" is the CALLER's
    // own manager reused, not a fresh one that merely copies the mode.
    assert.equal(executorCreation.approvals, h.executorApprovals);
    assert.equal(executed.executorRoute.requestedModelId, "vendor/executor-cheap");
  });
});

test("planner and executor sidecars never share a session path or appHome with the owner chat", async () => {
  await withHarness({}, async (h) => {
    await h.runtime.plan("task");
    const executorRouteValue = h.executorRouteValue.route!;
    await h.runtime.execute("task", await h.runtime.plan("task"));
    const [firstPlanner, secondPlanner, executor] = h.creations;
    assert.notEqual(firstPlanner!.session.path, secondPlanner!.session.path, "each plan() call gets a fresh sidecar");
    assert.notEqual(firstPlanner!.session.path, executor!.session.path);
    assert.notEqual(firstPlanner!.session.appHome, h.appHome);
    assert.deepEqual(firstPlanner!.session.data.turns, []);
    assert.equal(executor!.route.requestedModelId, executorRouteValue.requestedModelId);
  });
});

// ---------------------------------------------------------------------------
// Ruling 3: per-role thinking applies automatically via reasoningByModel.
// ---------------------------------------------------------------------------

test("planner and executor sidecars read their OWN role's reasoningByModel entry, never the owner chat's main setting", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-architect-runtime-reasoning-"));
  try {
    const plannerRoute = route("vendor/planner-thinking");
    const executorRoute = route("vendor/executor-thinking");
    const creations: ArchitectAgentFactoryInput[] = [];
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = "vendor/owner-main";
    config.reasoningByModel = {
      "vendor/owner-main": { mode: "effort", effort: "low" },
      [plannerRoute.requestedModelId]: { mode: "effort", effort: "high" },
      [executorRoute.requestedModelId]: { mode: "budget", maxTokens: 4_000 },
    };
    const runtime = createArchitectRuntime({
      workspace: "/tmp/architect-workspace",
      appHome,
      config,
      executorApprovals: new ApprovalManager("ask"),
      providerRuntime: {
        modelRuntime(exact) { return boundRuntime(exact, 1); },
        currentSessionRoute() { return plannerRoute; },
      },
      async createAgent(input) {
        creations.push(input);
        return { async run() { return completed("ok"); } };
      },
      async readDiff() { return ""; },
      context: () => ({ chat: [], omissions: [] }),
      executorRoute: () => executorRoute,
      unavailableReason: () => null,
    });

    const plan = await runtime.plan("task");
    await runtime.execute("task", plan);

    const plannerCreation = creations.find((entry) => entry.role === "planner")!;
    const executorCreation = creations.find((entry) => entry.role === "executor")!;
    assert.equal(plannerCreation.config.mainModel, plannerRoute.requestedModelId);
    assert.equal(executorCreation.config.mainModel, executorRoute.requestedModelId);
    assert.deepEqual(
      plannerCreation.config.reasoningByModel[plannerRoute.requestedModelId],
      { mode: "effort", effort: "high" },
    );
    assert.deepEqual(
      executorCreation.config.reasoningByModel[executorRoute.requestedModelId],
      { mode: "budget", maxTokens: 4_000 },
    );
    assert.notDeepEqual(
      plannerCreation.config.reasoningByModel[plannerRoute.requestedModelId],
      config.reasoningByModel["vendor/owner-main"],
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Redaction, cost/outcome propagation, and `changed` detection.
// ---------------------------------------------------------------------------

test("planner and executor text is redacted before it is ever returned", async () => {
  await withHarness({
    run: async (input) => completed(`${input.role} leaked sk-or-v1-abcdefghijklmnopqrstuvwx key`),
  }, async (h) => {
    const plan = await h.runtime.plan("task");
    assert.doesNotMatch(plan.text, /sk-or-v1-/);
    assert.match(plan.text, /\[REDACTED_OPENROUTER_KEY\]/);
    const executed = await h.runtime.execute("task", plan);
    assert.doesNotMatch(executed.text, /sk-or-v1-/);
  });
});

test("execute() reports changed=true only when the workspace diff actually differs before/after", async () => {
  await withHarness({}, async (h) => {
    const plan = await h.runtime.plan("task");
    const executed = await h.runtime.execute("task", plan);
    assert.equal(executed.changed, true, "the harness's readDiff returns different before/after text");
  });
});

test("an AgentRunError's charged partial result is preserved, not dropped", async () => {
  await withHarness({
    run: async () => {
      throw new AgentRunError(new Error("cancelled"), "cancelled", {
        text: "charged fragment",
        outcome: "cancelled",
        costKnowledge: "known",
        costUsd: 0.3,
        mainCostUsd: 0.25,
        compressorCostUsd: 0.05,
      } as never);
    },
  }, async (h) => {
    const plan = await h.runtime.plan("task");
    assert.equal(plan.text, "charged fragment");
    // Mirrors crossWorkerOutcome's own mapping: real content survives even a
    // non-"completed" outcome as "partial" — only truly empty text is
    // "blocked". Never silently reads as "completed".
    assert.equal(plan.outcome, "partial");
    assert.equal(plan.costUsd, 0.3);
    assert.equal(plan.mainCostUsd, 0.25);
    assert.equal(plan.compressorCostUsd, 0.05);
  });
});

// ---------------------------------------------------------------------------
// Port pass-throughs and defensive guards.
// ---------------------------------------------------------------------------

test("executorRoute()/unavailableReason() are the exact live functions passed in, not cached snapshots", async () => {
  await withHarness({ unavailableReason: "Architect is unavailable on Kimi Code routes" }, async (h) => {
    assert.equal(h.runtime.unavailableReason(), "Architect is unavailable on Kimi Code routes");
    assert.equal(h.runtime.executorRoute()!.requestedModelId, "vendor/executor-cheap");
    h.executorRouteValue.route = null;
    assert.equal(h.runtime.executorRoute(), null, "reads live, not a snapshot taken at construction");
  });
});

test("chatContextChars() counts the exact context slice the executor's own packet carries, read live", async () => {
  const chat: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: "aaaa" },
    { role: "assistant", content: "bbbbbb" },
  ];
  const omissions = ["3 older chat message(s) omitted"];
  await withHarness({ context: () => ({ chat, omissions }) }, async (h) => {
    const expected = 4 + 6 + omissions[0]!.length;
    assert.equal(h.runtime.chatContextChars!(), expected);
    // Live, never a construction-time snapshot: the confirm happens after
    // the planner run, and a longer chat must price higher by then.
    chat.push({ role: "assistant", content: "cccccccc" });
    assert.equal(h.runtime.chatContextChars!(), expected + 8, "reads live, like every other port method");
    // And it is exactly the slice that actually rides in the executor's prompt.
    const plan = await h.runtime.plan("task");
    await h.runtime.execute("task", plan);
    const executorPrompt = h.prompts.find((entry) => entry.role === "executor")!.prompt;
    for (const turn of chat) {
      assert.ok(executorPrompt.includes(turn.content), `the priced turn "${turn.content}" must actually be sent`);
    }
    assert.ok(executorPrompt.includes(omissions[0]!), "the priced omission marker must actually be sent");
  });
});

test("execute() refuses honestly when the executor route vanished between the caller's own check and this call", async () => {
  await withHarness({}, async (h) => {
    const plan = await h.runtime.plan("task");
    h.executorRouteValue.route = null;
    await assert.rejects(h.runtime.execute("task", plan), /executor route is not set/);
  });
});

test("a missing model runtime binding fails honestly instead of running an unbound agent", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-architect-runtime-unbound-"));
  try {
    const plannerRoute = route("vendor/unbound");
    const runtime = createArchitectRuntime({
      workspace: "/tmp/architect-workspace",
      appHome,
      config: structuredClone(DEFAULT_CONFIG),
      executorApprovals: new ApprovalManager("ask"),
      providerRuntime: {
        // Never bound via bindModelRuntimeIdentity — readModelRuntimeIdentity returns null.
        modelRuntime: () => ({ backendId: "openrouter" }) as never,
        currentSessionRoute: () => plannerRoute,
      },
      async createAgent() {
        throw new Error("must never be reached without a bound runtime");
      },
      async readDiff() { return ""; },
      context: () => ({ chat: [], omissions: [] }),
      executorRoute: () => route("vendor/executor"),
      unavailableReason: () => null,
    });
    await assert.rejects(runtime.plan("task"), /Architect model runtime binding is missing/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
