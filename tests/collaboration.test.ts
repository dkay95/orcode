import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RouteIdentityV1 } from "../src/backends.js";
import {
  CROSS_ANSWER_MARKER,
  CROSS_REASONING_MARKER,
  CROSS_REASONING_SUMMARY_MAX_CHARS,
  CROSS_REASONING_SUMMARY_MAX_LINES,
  CrossCoordinator,
  createContextPacketV1,
  crossRoleBrief,
  parseCrossResponse,
  summarizeCrossReasoning,
  type CrossProviderStage,
  type CrossRunPhase,
  type CrossStartRequest,
  type CrossVerificationPort,
  type CrossWorkerPort,
} from "../src/collaboration.js";

const leadRoute: RouteIdentityV1 = {
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "acct_private_lead",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/lead",
  canonicalModelId: "vendor/lead",
  resolutionState: "resolved",
};

const challengerRoute: RouteIdentityV1 = {
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "acct_private_challenger",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "kimi-for-coding",
  canonicalModelId: "kimi-for-coding",
  resolutionState: "resolved",
};

function passingVerification(diff = "diff --git a/a.ts b/a.ts"): CrossVerificationPort {
  return {
    async run() {
      return { diff, outcome: { status: "passed" } };
    },
  };
}

function happyWorker(): CrossWorkerPort {
  return {
    async analyze({ role }) {
      return {
        text: role === "lead" ? "Lead plan" : "Challenger critique",
        outcome: "completed",
      };
    },
    async implement() {
      return { text: "Unified answer", changed: true, outcome: "completed" };
    },
    async review() {
      return { blocking: false, finding: "clean" };
    },
  };
}

function startCross(
  coordinator: CrossCoordinator,
  request: Omit<CrossStartRequest, "repairBudget">,
  repairBudget: 0 | 1 = 1,
) {
  return coordinator.start({ ...request, repairBudget });
}

test("Cross accepts explicitly selected Nano-GPT Abo and PAYG routes without changing billing", async () => {
  for (const billingRealm of ["nanogpt-subscription", "nanogpt-payg"] as const) {
    const nanoRoute: RouteIdentityV1 = {
      ...leadRoute,
      backendId: "nano-gpt",
      billingRealm,
      accountFingerprint: "acct_nano_fixture",
    };
    const selected: RouteIdentityV1[] = [];
    const worker = happyWorker();
    const originalAnalyze = worker.analyze;
    worker.analyze = async (input) => {
      selected.push(input.route);
      return originalAnalyze(input);
    };
    const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
    const result = await startCross(coordinator, {
      task: "owner-selected Nano coding route",
      lead: nanoRoute,
      challenger: challengerRoute,
    });
    assert.equal(result.phase, "completed");
    assert.equal(result.reason, null);
    assert.ok(selected.some((route) => route.backendId === "nano-gpt" && route.billingRealm === billingRealm));
  }
});

test("repair budget zero stops after the exact four literal coordinator stages", async () => {
  const stages: CrossProviderStage[] = [];
  const worker: CrossWorkerPort = {
    async analyze(input) {
      stages.push(input.stage);
      return { text: input.role, outcome: "completed" };
    },
    async implement(input) {
      stages.push(input.stage);
      return { text: "implemented", changed: true, outcome: "completed" };
    },
    async review(input) {
      stages.push(input.stage);
      return { blocking: true, finding: "bounded blocker" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const result = await startCross(coordinator, {
    task: "four phases",
    lead: leadRoute,
    challenger: challengerRoute,
  }, 0);

  assert.equal(result.reason, "review-blocked");
  assert.equal(result.repairCount, 0);
  assert.deepEqual(new Set(stages.slice(0, 2)), new Set(["lead-analysis", "challenger-analysis"]));
  assert.deepEqual(stages.slice(2), ["lead-implementation", "challenger-review"]);
});

test("repair budget one permits the exact six literal coordinator stages once", async () => {
  const stages: CrossProviderStage[] = [];
  let reviews = 0;
  const worker: CrossWorkerPort = {
    async analyze(input) {
      stages.push(input.stage);
      return { text: input.role, outcome: "completed" };
    },
    async implement(input) {
      stages.push(input.stage);
      return { text: input.stage, changed: true, outcome: "completed" };
    },
    async review(input) {
      stages.push(input.stage);
      reviews += 1;
      return reviews === 1
        ? { blocking: true, finding: "repair once" }
        : { blocking: false, finding: "clean" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const result = await startCross(coordinator, {
    task: "six phases",
    lead: leadRoute,
    challenger: challengerRoute,
  });

  assert.equal(result.phase, "completed");
  assert.equal(result.repairCount, 1);
  assert.deepEqual(new Set(stages.slice(0, 2)), new Set(["lead-analysis", "challenger-analysis"]));
  assert.deepEqual(stages.slice(2), [
    "lead-implementation",
    "challenger-review",
    "lead-repair",
    "challenger-repair-review",
  ]);
});

test("missing or hostile repair budgets reject before worker or verification effects", async () => {
  let workerEffects = 0;
  let verificationEffects = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze() {
      workerEffects += 1;
      return { text: "unexpected", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({
    worker,
    verification: {
      async run() {
        verificationEffects += 1;
        return { diff: "", outcome: { status: "passed" } };
      },
    },
  });

  for (const repairBudget of [undefined, -1, 2, 0.5, Number.NaN, "1"] as const) {
    await assert.rejects(coordinator.start({
      task: "reject hostile budget",
      lead: leadRoute,
      challenger: challengerRoute,
      repairBudget,
    } as never), /repair budget/i);
  }
  assert.equal(workerEffects, 0);
  assert.equal(verificationEffects, 0);
});

test("ContextPacket uses stable redacted JSON bytes, explicit limits, and sha256", () => {
  const first = createContextPacketV1({
    task: "inspect sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890 for owner@example.invalid",
    chat: [{ role: "user", content: "second" }],
    projectInstructions: ["first"],
    workspaceReferences: [{ path: "src/a.ts", excerpt: "const z = 1;" }],
    omissions: ["older chat omitted"],
  });
  const second = createContextPacketV1({
    workspaceReferences: [{ excerpt: "const z = 1;", path: "src/a.ts" }],
    omissions: ["older chat omitted"],
    projectInstructions: ["first"],
    chat: [{ content: "second", role: "user" }],
    task: "inspect sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890 for owner@example.invalid",
  });

  assert.equal(Buffer.from(first.serialized).equals(Buffer.from(second.serialized)), true);
  assert.equal(first.sha256, second.sha256);
  assert.equal(
    first.sha256,
    createHash("sha256").update(first.serialized).digest("hex"),
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.omissions), true);
  assert.equal(first.request.includes("sk-or-v1-"), false);
  assert.equal(first.request.includes("owner@example.invalid"), false);
  assert.equal(Buffer.from(first.serialized).toString("utf8").includes("sk-or-v1-"), false);
  assert.equal(Buffer.from(first.serialized).toString("utf8").includes("owner@example.invalid"), false);
  assert.deepEqual(first.omissions, ["older chat omitted"]);

  assert.throws(
    () => createContextPacketV1({ task: "irreducible request", maxBytes: 8 }),
    /context-limit/i,
  );
  assert.throws(
    () => createContextPacketV1({ task: "x", maxBytes: 64 * 1024 * 1024 }),
    /context-limit/i,
  );
});

test("preflight rejects missing, unresolved, and same exact routes before workers start", async () => {
  const calls: string[] = [];
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze() {
      calls.push("analyze");
      return { text: "unexpected", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const unresolved = { ...leadRoute, canonicalModelId: null, resolutionState: "legacy-unverified" } as const;
  const sameCanonical = {
    ...leadRoute,
    requestedModelId: "alias/lead",
  };

  const cases = [
    { lead: null, challenger: challengerRoute, reason: "missing-routes" },
    { lead: leadRoute, challenger: null, reason: "missing-routes" },
    { lead: unresolved, challenger: challengerRoute, reason: "unresolved-routes" },
    { lead: leadRoute, challenger: unresolved, reason: "unresolved-routes" },
    { lead: leadRoute, challenger: sameCanonical, reason: "same-route" },
  ] as const;

  for (const fixture of cases) {
    const result = await startCross(coordinator, {
      task: "check",
      lead: fixture.lead,
      challenger: fixture.challenger,
    });
    assert.equal(result.phase, "blocked");
    assert.equal(result.reason, fixture.reason);
    assert.equal(result.text, "");
  }
  assert.deepEqual(calls, []);
});

test("initial analyses start concurrently with one frozen packet and exact authorities", async () => {
  const calls: Array<{
    role: string;
    authority: string;
    context: Parameters<CrossWorkerPort["analyze"]>[0]["context"];
  }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze(input) {
      calls.push({ role: input.role, authority: input.authority, context: input.context });
      await gate;
      return { text: input.role === "lead" ? "plan" : "critique", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const run = startCross(coordinator, { task: "build safely", lead: leadRoute, challenger: challengerRoute });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(({ role, authority }) => ({ role, authority })), [
    { role: "lead", authority: "writer" },
    { role: "challenger", authority: "read-only" },
  ]);
  assert.equal(calls[0]!.context, calls[1]!.context);
  assert.equal(Object.isFrozen(calls[0]!.context), true);
  assert.notEqual(calls[0]!.context.serialized, calls[1]!.context.serialized);
  assert.equal(
    Buffer.from(calls[0]!.context.serialized).equals(Buffer.from(calls[1]!.context.serialized)),
    true,
  );
  assert.equal(calls[0]!.context.sha256, calls[1]!.context.sha256);
  release();
  assert.equal((await run).phase, "completed");
});

test("a Lead cannot mutate the canonical packet bytes before Challenger reads them", async () => {
  let leadOriginal = "";
  let challengerObserved = "";
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role, context }) {
      const bytes = context.serialized;
      const original = Buffer.from(bytes).toString("utf8");
      if (role === "lead") {
        leadOriginal = original;
        bytes.fill(0);
      } else {
        challengerObserved = original;
      }
      return { text: role, outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const result = await startCross(coordinator, { task: "immutable", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "completed");
  assert.equal(challengerObserved, leadOriginal);
  assert.match(challengerObserved, /immutable/);
});

test("preflight rejects a forged backend and billing tuple before dispatch", async () => {
  let analyses = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze() {
      analyses += 1;
      return { text: "unexpected", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const forged = {
    ...challengerRoute,
    billingRealm: "openrouter-payg",
  } as RouteIdentityV1;

  const result = await startCross(coordinator, { task: "invalid tuple", lead: leadRoute, challenger: forged });

  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "invalid-routes");
  assert.equal(analyses, 0);
});

test("reentrant start fails closed before any worker can overlap the active run", async () => {
  let coordinator!: CrossCoordinator;
  let reentered = false;
  let nested!: Promise<Awaited<ReturnType<CrossCoordinator["start"]>>>;
  let analyses = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      analyses += 1;
      if (role === "lead" && !reentered) {
        reentered = true;
        nested = startCross(coordinator, {
          task: "nested",
          lead: leadRoute,
          challenger: challengerRoute,
        });
      }
      return { text: role, outcome: "completed" };
    },
  };
  coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const outer = startCross(coordinator, { task: "outer", lead: leadRoute, challenger: challengerRoute });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const nestedResult = await nested;
  const outerResult = await outer;

  assert.equal(nestedResult.phase, "blocked");
  assert.equal(nestedResult.reason, "run-active");
  assert.equal(outerResult.phase, "completed");
  assert.equal(analyses, 2);
  assert.equal(coordinator.status().phase, "completed");
});

test("route fingerprints repeated in task text never enter the shared packet", async () => {
  const packets: Array<Parameters<CrossWorkerPort["analyze"]>[0]["context"]> = [];
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role, context }) {
      packets.push(context);
      return { text: role, outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const task = `compare ${leadRoute.accountFingerprint} with ${challengerRoute.accountFingerprint}`;

  const result = await startCross(coordinator, { task, lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "completed");
  for (const packet of packets) {
    const visible = `${packet.request}\n${Buffer.from(packet.serialized).toString("utf8")}`;
    assert.equal(visible.includes(leadRoute.accountFingerprint), false);
    assert.equal(visible.includes(challengerRoute.accountFingerprint), false);
  }
});

test("only Lead implements, verification precedes Challenger review, and one text is returned", async () => {
  const order: string[] = [];
  const worker: CrossWorkerPort = {
    async analyze({ role }) {
      order.push(`analyze:${role}`);
      return { text: role === "lead" ? "accepted plan" : "critique", outcome: "completed" };
    },
    async implement(input) {
      order.push(`implement:${input.route.canonicalModelId}`);
      assert.equal(input.acceptedPlan, "accepted plan");
      assert.equal(input.critique, "critique");
      assert.equal(input.repairFinding, undefined);
      return {
        text: "final sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890",
        changed: true,
        outcome: "completed",
      };
    },
    async review(input) {
      order.push(`review:${input.route.canonicalModelId}`);
      assert.equal(input.leadResult.includes("sk-or-v1-"), false);
      assert.equal(input.diff, "safe diff");
      assert.deepEqual(input.verification, { status: "passed" });
      return { blocking: false, finding: "clean" };
    },
  };
  const verification: CrossVerificationPort = {
    async run() {
      order.push("verify");
      return { diff: "safe diff", outcome: { status: "passed" } };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification });

  const result = await startCross(coordinator, { task: "implement", lead: leadRoute, challenger: challengerRoute });

  assert.deepEqual(order.slice(2), [
    "implement:vendor/lead",
    "verify",
    "review:kimi-for-coding",
  ]);
  assert.equal(result.phase, "completed");
  assert.equal(result.verification, "passed");
  assert.equal(result.repairCount, 0);
  assert.equal(result.text.includes("sk-or-v1-"), false);
  assert.equal(result.text, "final [REDACTED_OPENROUTER_KEY]");
  assert.equal(JSON.stringify(result).includes("acct_private"), false);
});

test("one blocker causes exactly one Lead repair, reverify, and rereview", async () => {
  let implementations = 0;
  let verifications = 0;
  let reviews = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async implement(input) {
      implementations += 1;
      if (implementations === 1) {
        assert.equal(input.repairFinding, undefined);
        return { text: "first", changed: true, outcome: "completed" };
      }
      assert.equal(input.repairFinding, "fix boundary");
      return { text: "repaired", changed: true, outcome: "completed" };
    },
    async review() {
      reviews += 1;
      return reviews === 1
        ? { blocking: true, finding: "fix boundary" }
        : { blocking: false, finding: "clean" };
    },
  };
  const verification: CrossVerificationPort = {
    async run() {
      verifications += 1;
      return { diff: `diff ${verifications}`, outcome: { status: "passed" } };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification });

  const result = await startCross(coordinator, { task: "repair once", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "completed");
  assert.equal(result.text, "repaired");
  assert.equal(result.repairCount, 1);
  assert.equal(implementations, 2);
  assert.equal(verifications, 2);
  assert.equal(reviews, 2);
});

test("a second blocker stops partial without a second repair", async () => {
  let implementations = 0;
  let reviews = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async implement() {
      implementations += 1;
      return { text: `lead ${implementations}`, changed: true, outcome: "completed" };
    },
    async review() {
      reviews += 1;
      return { blocking: true, finding: `blocker ${reviews}` };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const result = await startCross(coordinator, { task: "bounded repair", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "partial");
  assert.equal(result.reason, "review-blocked");
  assert.equal(result.repairCount, 1);
  assert.equal(implementations, 2);
  assert.equal(reviews, 2);
});

test("failed verification can never produce completed", async () => {
  let reviews = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async review() {
      reviews += 1;
      return { blocking: false, finding: "verification still failed" };
    },
  };
  const verification: CrossVerificationPort = {
    async run() {
      return {
        diff: "partial diff",
        outcome: { status: "failed", command: "npm test", exitCode: 1, distilled: "failed" },
      };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification });

  const result = await startCross(coordinator, { task: "must verify", lead: leadRoute, challenger: challengerRoute });

  assert.equal(reviews, 1);
  assert.equal(result.phase, "partial");
  assert.equal(result.reason, "verification-failed");
  assert.equal(result.verification, "failed");
});

test("unified output cannot echo either private route fingerprint", async () => {
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async implement() {
      return {
        text: `used ${leadRoute.accountFingerprint} and ${challengerRoute.accountFingerprint}`,
        changed: false,
        outcome: "completed",
      };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification("") });

  const result = await startCross(coordinator, { task: "private", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "completed");
  assert.equal(result.text.includes(leadRoute.accountFingerprint), false);
  assert.equal(result.text.includes(challengerRoute.accountFingerprint), false);
});

test("worker output limit blocks before implementation", async () => {
  let implementations = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      return { text: role === "lead" ? "too many bytes" : "ok", outcome: "completed" };
    },
    async implement() {
      implementations += 1;
      return { text: "unexpected", changed: true, outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({
    worker,
    verification: passingVerification(),
    workerTextMaxBytes: 4,
  });

  const result = await startCross(coordinator, { task: "bounded", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "worker-limit");
  assert.equal(implementations, 0);
});

test("worker failure aborts and drains the sibling without silent fallback", async () => {
  let challengerDrained = false;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    analyze({ role, signal }) {
      if (role === "lead") throw new Error("provider raw response must stay private");
      return new Promise((_, reject) => {
        const drain = () => {
          challengerDrained = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) drain();
        else signal.addEventListener("abort", drain, { once: true });
      });
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });

  const result = await startCross(coordinator, { task: "no fallback", lead: leadRoute, challenger: challengerRoute });

  assert.equal(challengerDrained, true);
  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "worker-failed");
  assert.equal(result.text, "");
  assert.equal(JSON.stringify(result).includes("provider raw"), false);
});

test("stop aborts and drains an active run, then remains idempotent", async () => {
  let drained = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ signal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      drained += 1;
      throw new DOMException("Aborted", "AbortError");
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const run = startCross(coordinator, { task: "cancel me", lead: leadRoute, challenger: challengerRoute });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const stopped = await coordinator.stop();
  const result = await run;
  const stoppedAgain = await coordinator.stop();

  assert.equal(drained, 2);
  assert.equal(result.phase, "cancelled");
  assert.deepEqual(stopped, result.snapshot);
  assert.deepEqual(stoppedAgain, stopped);
});

test("cancelling verification cannot publish the Lead draft as a unified result", async () => {
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  const verification: CrossVerificationPort = {
    async run(signal) {
      verificationStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { diff: "partial", outcome: { status: "cancelled" } };
    },
  };
  const coordinator = new CrossCoordinator({ worker: happyWorker(), verification });
  const run = startCross(coordinator, { task: "cancel verify", lead: leadRoute, challenger: challengerRoute });
  await started;

  await coordinator.stop();
  const result = await run;

  assert.equal(result.phase, "cancelled");
  assert.equal(result.text, "");
  assert.equal(result.verification, "cancelled");
});

test("status snapshots have monotone sequences and stable terminal phases", async () => {
  const phases: CrossRunPhase[] = [];
  const sequences: number[] = [];
  let releaseAnalysis!: () => void;
  const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      await analysisGate;
      return { text: role, outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const capture = () => {
    const snapshot = coordinator.status();
    phases.push(snapshot.phase);
    sequences.push(snapshot.sequence);
  };

  capture();
  const run = startCross(coordinator, { task: "observe", lead: leadRoute, challenger: challengerRoute });
  capture();
  await new Promise<void>((resolve) => setImmediate(resolve));
  capture();
  releaseAnalysis();
  const result = await run;
  capture();
  const terminal = coordinator.status();
  capture();

  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index]! >= sequences[index - 1]!);
  }
  assert.deepEqual(phases.slice(0, 3), ["idle", "preflight", "analysis"]);
  assert.equal(result.phase, "completed");
  assert.deepEqual(terminal, coordinator.status());
  assert.equal(phases.at(-1), "completed");
});

test("a second start while active fails closed without replacing active status", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      await gate;
      return { text: role, outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const first = startCross(coordinator, { task: "first", lead: leadRoute, challenger: challengerRoute });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = coordinator.status();

  const second = await startCross(coordinator, { task: "second", lead: leadRoute, challenger: challengerRoute });

  assert.equal(second.phase, "blocked");
  assert.equal(second.reason, "run-active");
  assert.deepEqual(coordinator.status(), before);
  release();
  assert.equal((await first).phase, "completed");
});

test("unknown worker spend reaches implementation, verification, and review before an honest partial terminal", async () => {
  let implementations = 0;
  let verifications = 0;
  let reviews = 0;
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      return {
        text: role,
        outcome: "completed",
        costKnowledge: role === "lead" ? "unknown" : "known",
        costUsd: role === "lead" ? 0.1 : 0.2,
        mainCostUsd: role === "lead" ? 0.1 : 0.2,
        compressorCostUsd: 0,
      };
    },
    async implement() {
      implementations += 1;
      return { text: "implemented", changed: true, outcome: "completed" };
    },
    async review() {
      reviews += 1;
      return { blocking: false, finding: "clean", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({
    worker,
    verification: {
      async run() {
        verifications += 1;
        return { diff: "safe diff", outcome: { status: "passed" } };
      },
    },
  });
  const result = await startCross(coordinator, { task: "unknown spend", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "partial");
  assert.equal(result.reason, "cost-unknown");
  assert.deepEqual({ implementations, verifications, reviews }, {
    implementations: 1,
    verifications: 1,
    reviews: 1,
  });
  assert.equal(result.costKnowledge, "unknown");
  assert.ok(Math.abs(result.mainCostUsd - 0.3) < 1e-9);
  assert.equal(result.compressorCostUsd, 0);
  assert.ok(Math.abs(result.costUsd - 0.3) < 1e-9);
});

test("a non-completed Challenger review can never produce a completed Cross result", async () => {
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async review() {
      return {
        blocking: false,
        finding: "review fragment",
        outcome: "partial",
        costKnowledge: "known",
        costUsd: 0.1,
        mainCostUsd: 0.1,
        compressorCostUsd: 0,
      };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification() });
  const result = await startCross(coordinator, { task: "review must finish", lead: leadRoute, challenger: challengerRoute });
  assert.equal(result.phase, "partial", "Lead may already have changed the workspace");
  assert.equal(result.reason, "review-failed");
  assert.equal(result.costUsd, 0.1);
});

test("snapshots carry a stable transition timestamp instead of treating sequence as epoch time", async () => {
  let now = 1_700_000_000_000;
  const coordinator = new CrossCoordinator({
    worker: happyWorker(),
    verification: passingVerification(),
    now: () => now,
  });
  assert.equal(coordinator.status().updatedAt, now);
  now += 25;
  const result = await startCross(coordinator, { task: "timestamp", lead: leadRoute, challenger: challengerRoute });
  assert.equal(result.snapshot.updatedAt, now);
  assert.ok(result.snapshot.updatedAt > 1_000_000_000_000);
});

// ---------------------------------------------------------------------------
// FIX-20, finding 1: a blocked run names WHICH role failed and WHY.
//
// Every one of these paths used to resolve `null`/reject into a bare
// "worker-failed", discarding the only fact the owner could have acted on.
// ---------------------------------------------------------------------------

/**
 * Stands in for production's own humanizer (`OpenRouterService.safeMessage`,
 * wired in cli.ts). Disclosure is opt-in by design — without one of these a
 * caught error is never described at all, so the raw-provider-text contract
 * above stays absolute.
 */
const describeFailure = (error: unknown): string =>
  `checked: ${error instanceof Error ? error.message : String(error)}`;

test("a rejected analysis attributes the failure to the concrete role and humanizes it", async () => {
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      if (role === "lead") throw new Error("raw transport blew up");
      return { text: "critique", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({
    worker,
    verification: passingVerification(),
    describeFailure: (error) => `401 from provider (${(error as Error).message})`,
  });

  const result = await startCross(coordinator, { task: "attribute", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "worker-failed");
  assert.deepEqual(result.failure, {
    role: "lead",
    message: "401 from provider (raw transport blew up)",
  });
  assert.deepEqual(result.snapshot.failure, result.failure, "the snapshot carries the same one recorded fact");
});

test("a rejected challenger analysis is attributed to the challenger, not the lead", async () => {
  const worker: CrossWorkerPort = {
    ...happyWorker(),
    async analyze({ role }) {
      if (role === "challenger") throw new Error("review side is down");
      return { text: "plan", outcome: "completed" };
    },
  };
  const coordinator = new CrossCoordinator({ worker, verification: passingVerification(), describeFailure });

  const result = await startCross(coordinator, { task: "attribute", lead: leadRoute, challenger: challengerRoute });

  assert.equal(result.failure?.role, "challenger");
  assert.equal(result.failure?.message, "checked: review side is down");
});

test("a rejected implementation and a rejected verification each name their own step", async () => {
  const implementation = new CrossCoordinator({
    worker: {
      ...happyWorker(),
      async implement() {
        throw new Error("the writer stopped mid-edit");
      },
    },
    verification: passingVerification(),
    describeFailure,
  });
  const implemented = await startCross(implementation, {
    task: "attribute",
    lead: leadRoute,
    challenger: challengerRoute,
  });
  assert.equal(implemented.reason, "worker-failed");
  assert.deepEqual(implemented.failure, { role: "lead", message: "checked: the writer stopped mid-edit" });

  const verification = new CrossCoordinator({
    worker: happyWorker(),
    verification: {
      async run() {
        throw new Error("npm test could not be started");
      },
    },
    describeFailure,
  });
  const verified = await startCross(verification, {
    task: "attribute",
    lead: leadRoute,
    challenger: challengerRoute,
  });
  assert.equal(verified.reason, "verification-failed");
  assert.deepEqual(verified.failure, { role: "verification", message: "checked: npm test could not be started" });
});

test("a failure message is flattened, bounded, and never leaks a route's private values", async () => {
  const coordinator = new CrossCoordinator({
    worker: {
      ...happyWorker(),
      async analyze({ role }) {
        if (role !== "lead") return { text: "critique", outcome: "completed" };
        throw new Error(
          `account ${leadRoute.accountFingerprint} failed\n${"x".repeat(400)}`,
        );
      },
    },
    verification: passingVerification(),
    describeFailure,
  });

  const result = await startCross(coordinator, { task: "bounded", lead: leadRoute, challenger: challengerRoute });

  const message = result.failure?.message ?? "";
  assert.doesNotMatch(message, /acct_private_lead/, "a private route value must never reach a result line");
  assert.doesNotMatch(message, /\n/, "the message occupies exactly one line");
  assert.ok(message.length <= 180, `expected a bounded message, got ${message.length} characters`);
  assert.ok(message.endsWith("…"), "a truncated message says so");
});

test("a new run never inherits the previous run's failure", async () => {
  let failNext = true;
  const coordinator = new CrossCoordinator({
    worker: {
      ...happyWorker(),
      async analyze({ role }) {
        if (failNext && role === "lead") throw new Error("first run only");
        return { text: role, outcome: "completed" };
      },
    },
    verification: passingVerification(),
    describeFailure,
  });

  const first = await startCross(coordinator, { task: "one", lead: leadRoute, challenger: challengerRoute });
  assert.equal(first.failure?.message, "checked: first run only");

  failNext = false;
  const second = await startCross(coordinator, { task: "two", lead: leadRoute, challenger: challengerRoute });
  assert.equal(second.phase, "completed");
  assert.equal(second.failure, null, "a clean run must not report the previous run's cause");
  assert.equal(coordinator.status().failure, null);
});

// ---------------------------------------------------------------------------
// P15: the agreed response shape ("vereinbarte Antwort") — the brief a worker
// is given, and the tolerant reader that splits its reply apart again.
// ---------------------------------------------------------------------------

test("P15: a role brief states the role, the task, the current phase and the required response shape", () => {
  const lead = crossRoleBrief({
    role: "lead",
    step: "implementation",
    job: "Implement the accepted plan.",
  });

  assert.match(lead, /Your role: lead/, "the brief names the role");
  assert.match(lead, /only worker in this run that may change the workspace/, "…and its authority");
  assert.match(lead, /Current phase: implementation \(step 2 of 3/, "…the phase the run is in");
  assert.match(lead, /Your job now: Implement the accepted plan\./, "…the job for this step");
  // Controller ruling (P15 addendum): the task is NOT restated. The brief
  // points at the packet's own `request` field — one copy of one fact, and
  // one that stays inside what the gate's FIX-10 estimate prices. That the
  // field genuinely arrives in the prompt is pinned in cross-runtime.test.ts.
  assert.match(lead, /The task is the ContextPacket's `request` field below/, "…and where the task is");
  assert.match(lead, new RegExp(`${CROSS_ANSWER_MARKER}:`), "…plus the required response shape");
  assert.match(lead, new RegExp(`${CROSS_REASONING_MARKER}:`));
  assert.ok(
    lead.indexOf(CROSS_ANSWER_MARKER) < lead.indexOf(CROSS_REASONING_MARKER),
    "answer-first: the shape asks for ANSWER before REASONING",
  );

  const challenger = crossRoleBrief({
    role: "challenger",
    step: "review",
    job: "Review the result and the safe diff.",
  });
  assert.match(challenger, /Your role: challenger/);
  assert.match(challenger, /strictly read-only and never change the workspace/);
  assert.match(challenger, /Current phase: review \(step 3 of 3/);
  // The blocking convention rides the shape, so a challenger that follows the
  // shape still produces a first answer line the coordinator can classify.
  assert.match(challenger, /Start this line with BLOCKING:/);
});

/**
 * The five job strings `createCrossWorkerAdapter` actually passes (cli.ts) —
 * copied here so the size pin below measures real briefs. Fix round 1 (L2a):
 * it used to pass `job: "job"`, 3 chars against real jobs of 39-95, so most
 * of the headroom it appeared to guard was untested.
 */
const PRODUCTION_CROSS_JOBS = [
  { role: "lead", step: "analysis", job: "Produce a concise, actionable plan; you are the only later writer." },
  { role: "challenger", step: "analysis", job: "Review risks, gaps, and assumptions strictly read-only." },
  { role: "lead", step: "implementation", job: "Implement the accepted plan. Only you may make workspace changes." },
  { role: "lead", step: "repair", job: "Run exactly one bounded repair round." },
  { role: "challenger", step: "review", job: "Review the result and the safe diff read-only. Only start with `BLOCKING:` for a blocking issue." },
] as const;

test("P15: each Cross step gets its own phase/state sentence, and the brief stays a fixed-size frame", () => {
  const states = (["analysis", "implementation", "repair", "review"] as const).map((step) =>
    crossRoleBrief({ role: "lead", step, job: "job" })
      .split("\n")
      .find((line) => line.startsWith("Current phase:"))!,
  );
  assert.equal(new Set(states).size, 4, "each step states a distinct phase");
  assert.match(states[2]!, /repair/, "the repair round says it is the repair round");

  // Controller ruling (P15 addendum): the brief carries no task copy, so its
  // size depends only on the role and the step — never on the run's task.
  // Nothing here can grow the prompt outside what the gate's estimate prices.
  // Measured on the REAL production jobs (L2a), not a 3-char stand-in.
  const sizes = PRODUCTION_CROSS_JOBS.map(({ role, step, job }) =>
    crossRoleBrief({ role, step, job }).length,
  );
  assert.ok(Math.min(...sizes) > 600, `the pin must measure real briefs, smallest was ${Math.min(...sizes)}`);
  assert.ok(
    Math.max(...sizes) < 900,
    `the brief is a small fixed frame, never a second task copy; largest was ${Math.max(...sizes)}`,
  );

  // Fix round 1 (L1): `authority` is gone because it was never read. Pinned so
  // nobody re-adds a second source for a fact `CROSS_ROLE_STANDING` owns: the
  // role alone decides what the brief says about write authority.
  assert.match(
    crossRoleBrief({ role: "lead", step: "analysis", job: "j" }),
    /only worker in this run that may change the workspace/,
  );
  assert.match(
    crossRoleBrief({ role: "challenger", step: "analysis", job: "j" }),
    /strictly read-only and never change the workspace/,
  );
});

test("P15: parseCrossResponse splits the agreed shape answer-first", () => {
  const parsed = parseCrossResponse("ANSWER:\nThe module is renamed.\n\nREASONING:\n- one\n- two");
  assert.equal(parsed.structured, true);
  assert.equal(parsed.answer, "The module is renamed.");
  assert.equal(parsed.reasoning, "- one\n- two");
});

test("P15 fix round 1 (H1): only the exact uppercase markers count — decoration, lowercase and bare keywords are CONTENT", () => {
  // Every one of these was a marker before the fix, and every one of them is
  // ordinary answer text a coding model plausibly writes.
  for (const notAMarker of [
    "## Answer",
    "**REASONING:**",
    "- answer",
    "> reasoning",
    "Reasoning",
    "answer: 42",
    "reasoning: none",
    "Answer:",
    "  ANSWER:",
    "ANSWER",
    "Verification: npm test green.",
  ]) {
    const body = `Renamed the module.\n${notAMarker}\nand the imports too.`;
    const parsed = parseCrossResponse(body);
    assert.equal(parsed.structured, false, `"${notAMarker}" must not be read as a marker`);
    assert.equal(parsed.answer, body, `"${notAMarker}": the whole reply stays the answer`);
    assert.equal(parsed.reasoning, "", `"${notAMarker}": nothing is re-labelled as reasoning`);
  }

  // The exact shape the brief instructs still reads exactly as intended,
  // inline content and reversed order included.
  const inline = parseCrossResponse("ANSWER: done in one line\nREASONING: short why");
  assert.equal(inline.answer, "done in one line");
  assert.equal(inline.reasoning, "short why");

  const reversed = parseCrossResponse("REASONING:\nthought\nANSWER:\nthe answer");
  assert.equal(reversed.structured, true);
  assert.equal(reversed.answer, "the answer", "the answer is read from its marker, not from position");
  assert.equal(reversed.reasoning, "thought");
});

test("P15 fix round 1 (H1): the reviewer's two reproduced deletions, verbatim", () => {
  // Case 1 — a `Reasoning` line inside the answer body. Before the fix the
  // five bullets and the Verification line moved into `reasoning`, where the
  // persist-time bound cut them; "npm test green" did not survive persist.
  const caseOne = [
    "ANSWER:",
    "Renamed the widget module and updated the imports.",
    "- src/widget.ts",
    "- src/widget-view.ts",
    "- tests/widget.test.ts",
    "- docs/widget.md",
    "- CHANGELOG.md",
    "Reasoning",
    "Verification: npm test green.",
  ].join("\n");
  const one = parseCrossResponse(caseOne);
  assert.match(one.answer, /npm test green\./, "the verification line survives in the answer");
  assert.match(one.answer, /CHANGELOG\.md/, "every bullet survives in the answer");
  assert.match(one.answer, /^Reasoning$/m, "a bare `Reasoning` line is content and stays put");
  assert.equal(one.reasoning, "", "nothing was re-labelled as reasoning");

  // Case 2 — a YAML fixture inside the answer. Before the fix `reasoning:
  // none` was deleted entirely, `answer: 42` was reduced to a bare `42`, and
  // `none` re-surfaced on the ⎿ Reasoning line.
  const caseTwo = [
    "ANSWER:",
    "Added the fixture the review asked for:",
    "```yaml",
    "reasoning: none",
    "answer: 42",
    "timeout: 30",
    "```",
  ].join("\n");
  const two = parseCrossResponse(caseTwo);
  assert.ok(two.answer.includes("reasoning: none"), '"reasoning: none" survives');
  assert.ok(two.answer.includes("answer: 42"), '"answer: 42" survives, not reduced to a bare 42');
  assert.ok(two.answer.includes("timeout: 30"));
  assert.equal(two.reasoning, "", "no fragment of the fixture leaks onto the reasoning line");
});

test("P15 fix round 1 (H1): fenced code cannot be mistaken for structure, even when it quotes the shape itself", () => {
  const quoting = [
    "ANSWER:",
    "The shape I was given reads:",
    "```",
    "ANSWER:",
    "  <your answer>",
    "REASONING:",
    "  <at most 3 short lines>",
    "```",
    "I followed it.",
    "REASONING:",
    "quoted the prompt back",
  ].join("\n");
  const parsed = parseCrossResponse(quoting);
  assert.ok(parsed.answer.includes("<your answer>"), "the quoted shape stays inside the answer");
  assert.ok(parsed.answer.includes("<at most 3 short lines>"));
  assert.match(parsed.answer, /I followed it\./, "content after the fence is still answer");
  assert.equal(parsed.reasoning, "quoted the prompt back", "only the real marker split anything");

  // An unterminated fence keeps the rest as content — the safe direction.
  const unterminated = "ANSWER:\nhere is a diff\n```diff\n-old\n+new\nREASONING:\nnever closed";
  const safe = parseCrossResponse(unterminated);
  assert.ok(safe.answer.includes("REASONING:"), "an unclosed fence never lets the bound reach content");
  assert.equal(safe.reasoning, "");
});

test("P15 fix round 1 (H1): property sweep — without BOTH exact markers, the answer is the whole input", () => {
  const fragments = [
    "Renamed the module.",
    "## Answer",
    "answer: 42",
    "Reasoning",
    "- reasoning",
    "**ANSWER:**",
    "Verification: npm test green.",
    "  ANSWER:",
    "answer",
    "REASONING",
    "> ANSWER:",
    "```",
    "text with ANSWER: in the middle of a sentence",
  ];
  let checked = 0;
  for (const first of fragments) {
    for (const second of fragments) {
      const input = `${first}\n${second}`;
      // The exact markers are the ONLY thing that may split a reply. No
      // fragment above is one, so every one of these must come back whole.
      if (/^(ANSWER|REASONING):/m.test(input)) continue;
      const parsed = parseCrossResponse(input);
      assert.equal(parsed.answer, input, `byte-for-byte for: ${JSON.stringify(input)}`);
      assert.equal(parsed.reasoning, "", `nothing bounded away for: ${JSON.stringify(input)}`);
      assert.equal(parsed.structured, false);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `the sweep must actually cover the corpus, covered ${checked}`);

  // And the invariant that matters for persistence: whatever a reply is, no
  // non-marker line of it can go missing across answer + reasoning.
  for (const input of [
    "ANSWER:\nkept\nReasoning\nalso kept",
    "preamble\nANSWER:\nkept\nREASONING:\nwhy",
    "REASONING:\nonly thoughts",
    "no markers at all",
  ]) {
    const parsed = parseCrossResponse(input);
    const carried = `${parsed.answer}\n${parsed.reasoning}`;
    for (const line of input.split("\n")) {
      if (!line.trim() || /^(ANSWER|REASONING):$/.test(line)) continue;
      assert.ok(carried.includes(line.trim()), `"${line}" must survive parsing of ${JSON.stringify(input)}`);
    }
  }
});

test("P15 fix round 1 (M3): a REASONING-only reply takes the LOSSLESS reading — the whole text is the answer", () => {
  // Controller ruling, fix round 1. The alternatives (bounding it, or taking
  // the no-content notice path) both delete a reply the worker did produce;
  // on this one path "nothing is lost" outranks the reasoning bound. The
  // trade-off is named in the report rather than hidden here.
  const dump = Array.from({ length: 40 }, (_, index) => `chain of thought step ${index}`).join("\n");
  const parsed = parseCrossResponse(`REASONING:\n${dump}`);
  assert.equal(parsed.structured, false, "no answer landed, so the shape was not honoured");
  assert.equal(parsed.answer, `REASONING:\n${dump}`, "byte-for-byte, marker line included");
  assert.equal(parsed.reasoning, "", "nothing is routed to the bounded reasoning slot");
  assert.ok(parsed.answer.includes("chain of thought step 39"), "the last line is not cut away");
});

test("P15: a malformed or shape-ignoring reply degrades honestly — whole text as answer, never dropped, never an error", () => {
  const plain = parseCrossResponse("I just wrote prose and ignored your shape entirely.");
  assert.equal(plain.structured, false);
  assert.equal(plain.answer, "I just wrote prose and ignored your shape entirely.");
  assert.equal(plain.reasoning, "");

  // A line that merely begins with the word is not a marker.
  const nearMiss = parseCrossResponse("Answer the question below\nstill the same paragraph");
  assert.equal(nearMiss.structured, false);
  assert.equal(nearMiss.answer, "Answer the question below\nstill the same paragraph");

  // Reasoning only: showing nothing would be worse than showing it unsplit.
  const reasoningOnly = parseCrossResponse("REASONING:\nonly thoughts, no answer marker");
  assert.equal(reasoningOnly.structured, false);
  assert.match(reasoningOnly.answer, /only thoughts, no answer marker/);

  // A preamble before the first marker is content, not noise.
  const preamble = parseCrossResponse("Heads up first.\nANSWER:\nthe answer\nREASONING:\nwhy");
  assert.equal(preamble.structured, true);
  assert.match(preamble.answer, /Heads up first\./);
  assert.match(preamble.answer, /the answer/);

  assert.equal(parseCrossResponse("").answer, "");
  assert.equal(parseCrossResponse(undefined as unknown as string).answer, "");
});

test("P15: summarizeCrossReasoning bounds a think-dump to a folded detail and names what it dropped", () => {
  assert.deepEqual(summarizeCrossReasoning(""), []);
  assert.deepEqual(summarizeCrossReasoning("one\ntwo"), ["one", "two"]);

  const dump = summarizeCrossReasoning(Array.from({ length: 40 }, (_, i) => `thought ${i}`).join("\n"));
  assert.equal(dump.length, CROSS_REASONING_SUMMARY_MAX_LINES + 1);
  assert.match(dump.at(-1)!, /37 more reasoning lines not shown/);

  const long = summarizeCrossReasoning("y".repeat(1_000));
  assert.equal(long.length, 1);
  assert.equal(long[0]!.length, CROSS_REASONING_SUMMARY_MAX_CHARS);
  assert.ok(long[0]!.endsWith("…"), "a truncated reasoning line says so");
});
