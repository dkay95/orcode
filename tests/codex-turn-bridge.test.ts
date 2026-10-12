import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalManager } from "../src/approval.js";
import {
  CodexOperationJournal,
  exactThreadStartParams,
  isOfficialTurn,
  prepareCodexExecution,
  startCodexThread,
  startCodexTurn,
  translateCodexNotification,
} from "../src/codex-execution.js";
import {
  CodexAppServerClient,
  createCodexAppServerLaunchPlan,
  resolveOfficialCodexPayload,
  type CodexAppServerTransport,
} from "../src/codex-app-server.js";
import { createCodexHome, parseCodexHomeId } from "../src/codex-profile.js";
import { CodexRouteGate } from "../src/codex-route-gate.js";
import { ChangeJournal, WorkspaceGuard } from "../src/workspace.js";
import { codexOperationHandoff } from "../src/conversation.js";

class TurnHarnessTransport implements CodexAppServerTransport {
  readonly frames: unknown[] = [];
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | null) => void> = [];
  readonly #responseWaiters = new Map<string, (value: unknown) => void>();
  closed = false;
  constructor(
    readonly codexHome: string,
    readonly invalidTurn = false,
    readonly malformedThread = false,
    readonly beforeTurnStartResponse?: (emit: (frame: unknown) => void) => void,
  ) {}
  async writeLine(line: string): Promise<void> {
    const frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown };
    this.frames.push(frame);
    if (frame.method === undefined && (typeof frame.id === "number" || typeof frame.id === "string")) {
      this.#responseWaiters.get(`${typeof frame.id}:${String(frame.id)}`)?.(frame.result);
      this.#responseWaiters.delete(`${typeof frame.id}:${String(frame.id)}`);
      return;
    }
    if (frame.method === "initialized") return;
    if (frame.method === "initialize") this.#emit({ id: frame.id, result: {
      codexHome: this.codexHome, platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.142.5",
    } });
    else if (frame.method === "account/read") this.#emit({ id: frame.id, result: {
      account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true,
    } });
    else if (frame.method === "thread/start") this.#emit({ id: frame.id, result: {
      thread: { id: "thread-exact", sessionId: "session-exact", forkedFromId: null,
        parentThreadId: null, preview: "", ephemeral: true, modelProvider: "openai",
        createdAt: this.malformedThread ? "not-a-timestamp" : 1,
        updatedAt: 1, recencyAt: 1,
        status: this.malformedThread ? { type: "active", activeFlags: ["unknown"] } : { type: "idle" },
        path: null,
        cwd: frame.params?.cwd, cliVersion: "0.142.5", source: "appServer",
        threadSource: null, agentNickname: null, agentRole: null,
        gitInfo: this.malformedThread ? { sha: 7, branch: null, originUrl: null } : null,
        name: null, turns: [] },
      model: frame.params?.model, modelProvider: "openai", serviceTier: null,
      cwd: frame.params?.cwd, instructionSources: this.malformedThread ? [7] : [],
      approvalPolicy: frame.params?.approvalPolicy,
      approvalsReviewer: frame.params?.approvalsReviewer,
      sandbox: this.malformedThread ? { type: "workspaceWrite", writableRoots: [7], networkAccess: "no",
        excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      reasoningEffort: this.malformedThread ? { invalid: true } : null,
    } });
    else if (frame.method === "turn/start") {
      this.beforeTurnStartResponse?.((notification) => this.#emit(notification));
      this.#emit(this.invalidTurn
        ? { id: frame.id, result: { turn: { id: "old-shape" } } }
        : { id: frame.id, result: { turn: {
        id: "turn-exact", items: [], itemsView: "full", status: "inProgress", error: null,
        startedAt: 1, completedAt: null, durationMs: null,
      } } });
    }
    else if (frame.method === "turn/interrupt") this.#emit({ id: frame.id, result: {} });
  }
  readLine(): Promise<string | null> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  close(): void { this.closed = true; this.#emit(null); }
  async drain(): Promise<"closed"> { this.close(); return "closed"; }
  async emitServerRequest(frame: Readonly<{ id: string | number; method: string; params: unknown }>): Promise<unknown> {
    const key = `${typeof frame.id}:${String(frame.id)}`;
    const response = new Promise<unknown>((resolve) => this.#responseWaiters.set(key, resolve));
    this.#emit(frame);
    const delivered = await response;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return delivered;
  }
  #emit(value: unknown | null): void {
    const line = value === null ? null : JSON.stringify(value);
    const waiter = this.#waiters.shift();
    if (waiter) waiter(line); else if (line !== null) this.#lines.push(line);
  }
}

async function preparedFixture() {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-turn-"));
  const appHome = join(root, "app-home");
  const workspacePath = join(root, "workspace");
  const codexHome = join(appHome, "providers", "codex", "codex-0123456789abcdef0123456789abcdef");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  await writeFile(join(workspacePath, "main.ts"), "before\n");
  const binding = { profileId: "owner", codexHomeRealpath: await realpath(codexHome), route: {
    version: 1 as const, backendId: "codex" as const, accountFingerprint: "owner",
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "gpt-5.4", canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const,
  }, modelId: "gpt-5.4" };
  const accountClient = { onNotification: () => () => undefined, request: async <T>() => ({
    account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true,
  }) as T };
  const approvals = new ApprovalManager("ask");
  approvals.setPromptHandler(async () => ({ accepted: true }));
  const prepared = await prepareCodexExecution({
    appHome, workspace: await WorkspaceGuard.create(workspacePath), approvals,
    journal: new ChangeJournal({ appHome, chatId: "turn" }),
    routeGate: new CodexRouteGate({ ...binding, client: accountClient, childGeneration: 4 }), routeBinding: binding,
  });
  return { root, prepared };
}

test("emits only exact staging-bound thread/start parameters", async () => {
  const state = await preparedFixture();
  try {
    assert.deepEqual(exactThreadStartParams(state.prepared), {
      cwd: state.prepared.staging.canonicalPath,
      model: "gpt-5.4",
      ephemeral: true,
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
  } finally { await state.prepared.staging.discard(); await rm(state.root, { recursive: true, force: true }); }
});

test("starts one exact staging-bound thread and turn on the route-gate client", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-turn-integrated-"));
  const appHome = join(root, "app-home");
  const workspacePath = join(root, "workspace");
  await mkdir(appHome, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(join(workspacePath, "main.ts"), "before\n");
  const profile = await createCodexHome({
    appHome, homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"), accountLabel: "Owner",
  });
  let transport!: TurnHarnessTransport;
  const client = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(profile, await resolveOfficialCodexPayload("/usr/local/bin/codex")),
    async () => (transport = new TurnHarnessTransport(profile.codexHome)),
  );
  await client.start();
  const binding = { profileId: "owner", codexHomeRealpath: profile.codexHome, route: {
    version: 1 as const, backendId: "codex" as const, accountFingerprint: "owner",
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "gpt-5.4", canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const,
  }, modelId: "gpt-5.4" };
  const gate = new CodexRouteGate({ ...binding, client, childGeneration: 9 });
  gate.observeAccountUpdated({ childGeneration: 9, params: { authMode: "chatgpt", planType: "pro" } });
  const approvals = new ApprovalManager("ask");
  approvals.setPromptHandler(async () => ({ accepted: true }));
  const prepared = await prepareCodexExecution({
    appHome, workspace: await WorkspaceGuard.create(workspacePath), approvals,
    journal: new ChangeJournal({ appHome, chatId: "integrated" }), routeGate: gate, routeBinding: binding,
  });
  try {
    const operation = await startCodexTurn({ prepared, client, childGeneration: 9, task: "Fix main.ts" });
    assert.deepEqual(codexOperationHandoff(operation), {
      threadId: "thread-exact", turnId: "turn-exact", childGeneration: 9,
      routeDigest: operation.routeDigest, settled: false,
    });
    const thread = transport.frames.find((frame) => (frame as { method?: string }).method === "thread/start") as { params: unknown };
    assert.deepEqual(thread.params, exactThreadStartParams(prepared));
    const turn = transport.frames.find((frame) => (frame as { method?: string }).method === "turn/start") as { params: unknown };
    assert.deepEqual(turn.params, {
      threadId: "thread-exact", input: [{ type: "text", text: "Fix main.ts", text_elements: [] }], cwd: prepared.staging.canonicalPath,
      model: "gpt-5.4", sandboxPolicy: prepared.sandbox.turn,
      approvalPolicy: "untrusted", approvalsReviewer: "user",
    });
    await transport.emitServerRequest({
      id: 91, method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-exact", turnId: "turn-exact", itemId: "command-exact", startedAtMs: 1,
        command: "npm test", cwd: prepared.staging.canonicalPath, environmentId: null,
      },
    });
    assert.deepEqual(operation.events, [{ type: "approval", itemId: "command-exact" }]);
    gate.setChildGeneration(10);
    await transport.emitServerRequest({
      id: 92, method: "item/commandExecution/requestApproval", params: {
        threadId: "thread-exact", turnId: "turn-exact", itemId: "command-stale",
        startedAtMs: 2, command: "npm test", cwd: prepared.staging.canonicalPath, environmentId: null,
      },
    });
    await operation.approvalBridge!.waitForCleanup();
    assert.equal(operation.approvalBridge!.closed, true,
      "generation drift after turn/start revokes approval authority");
  } finally {
    await client.drain().catch(() => undefined);
    await prepared.staging.discard().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("translates only documented notification classes and rejects unknown frames", () => {
  assert.deepEqual(translateCodexNotification({ method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hi",
  } }), {
    type: "assistant-text", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hi",
    },
  });
  assert.deepEqual(translateCodexNotification({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-2",
    changes: [{ path: "main.ts", kind: { type: "update", move_path: null }, diff: "@@" }],
  } }), { type: "patch-preview", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-2",
    changes: [{ path: "main.ts", kind: "update", diff: "@@" }],
  } });
  assert.throws(() => translateCodexNotification({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-2",
    changes: [{ path: "main.ts", kind: { type: "update", move_path: "moved.ts" }, diff: "@@" }],
  } }), /move authority/i);
  assert.throws(() => translateCodexNotification({ method: "future/event", params: {} }), /unsupported/i);
});

test("rejects exact-key thread/start responses with malformed official field types", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-thread-validator-"));
  const profile = await createCodexHome({ appHome: root,
    homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"), accountLabel: "Owner" });
  let transport!: TurnHarnessTransport;
  const client = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(profile, await resolveOfficialCodexPayload("/usr/local/bin/codex")),
    async () => (transport = new TurnHarnessTransport(profile.codexHome, false, true)),
  );
  await client.start();
  const prepared = {
    staging: { active: true, canonicalPath: join(root, "staging") },
    routeBinding: { modelId: "gpt-5.4" },
    sandbox: { thread: "workspace-write" },
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
  };
  try {
    await assert.rejects(startCodexThread(prepared as never, client), /thread\/start response/i);
  } finally {
    await client.drain().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  void transport;
});

test("rejects malformed nullable and union fields in an exact-key Turn", () => {
  const valid = {
    id: "turn-1", items: [], itemsView: "full", status: "inProgress",
    error: null, startedAt: 1, completedAt: null, durationMs: null,
  };
  for (const malformed of [
    { error: "bad" },
    { error: { message: 7, codexErrorInfo: null, additionalDetails: null } },
    { startedAt: "bad" },
    { completedAt: {} },
    { durationMs: -99 },
    { items: [null] },
    { items: [{ type: "userMessage", id: "i1", clientId: null, content: [{ bogus: true }] }] },
    { items: [{ type: "agentMessage", id: "i2", text: "x", phase: null,
      memoryCitation: { foo: 1 } }] },
    { items: [{ type: "commandExecution", id: "i3", command: "ls", cwd: "/tmp",
      processId: null, source: "agent", status: "completed", commandActions: [{ foo: 1 }],
      aggregatedOutput: null, exitCode: 0, durationMs: 1 }] },
    { items: [{ type: "fileChange", id: "i4", changes: [{ foo: 1 }], status: "completed" }] },
    { items: [{ type: "dynamicToolCall", id: "i5", namespace: null, tool: "t", arguments: null,
      status: "completed", contentItems: [{ foo: 1 }], success: true, durationMs: 1 }] },
    { items: [{ type: "collabAgentToolCall", id: "i6", tool: "spawnAgent", status: "completed",
      senderThreadId: "s", receiverThreadIds: ["r"], prompt: null, model: null,
      reasoningEffort: null, agentsStates: { r: { foo: 1 } } }] },
  ]) {
    assert.equal(isOfficialTurn({ ...valid, ...malformed }), false, JSON.stringify(malformed));
  }
});

test("accepts representative generated 0.142.5 nested ThreadItem shapes", () => {
  const items = [
    { type: "userMessage", id: "i1", clientId: null, content: [{ type: "text", text: "x",
      text_elements: [{ byteRange: { start: 0, end: 1 }, placeholder: null }] }] },
    { type: "agentMessage", id: "i2", text: "x", phase: "final_answer",
      memoryCitation: { entries: [{ path: "memory.md", lineStart: 1, lineEnd: 1, note: "source" }],
        threadIds: ["thread-1"] } },
    { type: "commandExecution", id: "i3", command: "ls", cwd: "/tmp", processId: null,
      source: "agent", status: "completed", commandActions: [{ type: "unknown", command: "ls" }],
      aggregatedOutput: null, exitCode: 0, durationMs: 1 },
    { type: "fileChange", id: "i4", changes: [{ path: "main.ts",
      kind: { type: "update", move_path: null }, diff: "@@" }], status: "completed" },
    { type: "dynamicToolCall", id: "i5", namespace: null, tool: "t", arguments: null,
      status: "completed", contentItems: [{ type: "inputText", text: "done" }],
      success: true, durationMs: 1 },
    { type: "collabAgentToolCall", id: "i6", tool: "spawnAgent", status: "completed",
      senderThreadId: "s", receiverThreadIds: ["r"], prompt: null, model: null,
      reasoningEffort: null, agentsStates: { r: { status: "running", message: null } } },
  ];
  assert.equal(isOfficialTurn({
    id: "turn-1", items, itemsView: "full", status: "inProgress",
    error: null, startedAt: 1, completedAt: null, durationMs: null,
  }), true);
});

test("a malformed turn response drains first and only then discards staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-turn-cleanup-"));
  const appHome = join(root, "app-home");
  const workspacePath = join(root, "workspace");
  await mkdir(appHome, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(join(workspacePath, "main.ts"), "before\n");
  const profile = await createCodexHome({ appHome,
    homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"), accountLabel: "Owner" });
  let transport!: TurnHarnessTransport;
  const client = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(profile, await resolveOfficialCodexPayload("/usr/local/bin/codex")),
    async () => (transport = new TurnHarnessTransport(profile.codexHome, true)),
  );
  await client.start();
  const binding = { profileId: "owner", codexHomeRealpath: profile.codexHome, route: {
    version: 1 as const, backendId: "codex" as const, accountFingerprint: "owner",
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "gpt-5.4", canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const,
  }, modelId: "gpt-5.4" };
  const gate = new CodexRouteGate({ ...binding, client, childGeneration: 2 });
  gate.observeAccountUpdated({ childGeneration: 2, params: { authMode: "chatgpt", planType: "pro" } });
  const approvals = new ApprovalManager("ask");
  const prepared = await prepareCodexExecution({ appHome,
    workspace: await WorkspaceGuard.create(workspacePath), approvals,
    journal: new ChangeJournal({ appHome, chatId: "cleanup" }), routeGate: gate, routeBinding: binding });
  await assert.rejects(startCodexTurn({ prepared, client, childGeneration: 2, task: "fail" }), /turn\/start response/i);
  assert.equal(transport.closed, true);
  assert.equal(prepared.staging.active, false);
  await rm(root, { recursive: true, force: true });
});

test("a stale captured patch shares one drain-before-discard cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-turn-replay-cleanup-"));
  const appHome = join(root, "app-home");
  const workspacePath = join(root, "workspace");
  await mkdir(appHome, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(join(workspacePath, "main.ts"), "before\n");
  const profile = await createCodexHome({ appHome,
    homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"), accountLabel: "Owner" });
  let gate!: CodexRouteGate;
  let transport!: TurnHarnessTransport;
  const client = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(profile, await resolveOfficialCodexPayload("/usr/local/bin/codex")),
    async () => (transport = new TurnHarnessTransport(profile.codexHome, false, false, (emit) => {
      emit({ method: "item/fileChange/patchUpdated", params: {
        threadId: "thread-exact", turnId: "turn-exact", itemId: "patch-stale",
        changes: [{ path: "main.ts", kind: { type: "update", move_path: null }, diff: "@@" }],
      } });
      gate.observeAccountUpdated({ childGeneration: 2,
        params: { authMode: "chatgpt", planType: "pro" } });
    })),
  );
  await client.start();
  const binding = { profileId: "owner", codexHomeRealpath: profile.codexHome, route: {
    version: 1 as const, backendId: "codex" as const, accountFingerprint: "owner",
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "gpt-5.4", canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const,
  }, modelId: "gpt-5.4" };
  gate = new CodexRouteGate({ ...binding, client, childGeneration: 2 });
  gate.observeAccountUpdated({ childGeneration: 2,
    params: { authMode: "chatgpt", planType: "pro" } });
  const prepared = await prepareCodexExecution({ appHome,
    workspace: await WorkspaceGuard.create(workspacePath), approvals: new ApprovalManager("ask"),
    journal: new ChangeJournal({ appHome, chatId: "replay-cleanup" }),
    routeGate: gate, routeBinding: binding });
  const stagingPrototype = Object.getPrototypeOf(prepared.staging) as {
    discard(this: typeof prepared.staging): Promise<void>;
  };
  const originalDiscard = stagingPrototype.discard;
  let discardCalls = 0;
  let concurrentDiscards = 0;
  let maxConcurrentDiscards = 0;
  let everyDiscardStartedAfterDrain = true;
  stagingPrototype.discard = async function discardInstrumented() {
    if (this !== prepared.staging) return originalDiscard.call(this);
    discardCalls += 1;
    concurrentDiscards += 1;
    maxConcurrentDiscards = Math.max(maxConcurrentDiscards, concurrentDiscards);
    everyDiscardStartedAfterDrain &&= transport.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await originalDiscard.call(this);
    } finally {
      concurrentDiscards -= 1;
    }
  };
  try {
    await assert.rejects(
      startCodexTurn({ prepared, client, childGeneration: 2, task: "stale replay" }),
      /patch notification is stale/i,
    );
    assert.equal(discardCalls, 1);
    assert.equal(maxConcurrentDiscards, 1);
    assert.equal(everyDiscardStartedAfterDrain, true);
    assert.equal(prepared.staging.active, false);
  } finally {
    stagingPrototype.discard = originalDiscard;
    await client.drain().catch(() => undefined);
    await prepared.staging.discard().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("operation journal accepts official turn scope without a top-level turnId", async () => {
  const journal = new CodexOperationJournal({
    threadId: "thread-1", turnId: "turn-1", childGeneration: 4,
    routeDigest: "a".repeat(64), authority: Object.freeze({}) as never,
  });
  await journal.recordNotification({ method: "turn/started", params: {
    threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full",
      status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
  } });
  assert.deepEqual(journal.events, [{ type: "turn-start" }]);
});

test("operation journal settles exactly once and carries no response body", () => {
  const journal = new CodexOperationJournal({
    threadId: "thread-1", turnId: "turn-1", childGeneration: 4,
    routeDigest: "a".repeat(64), authority: Object.freeze({}) as never,
  });
  journal.settle();
  assert.deepEqual(codexOperationHandoff(journal), {
    threadId: "thread-1", turnId: "turn-1", childGeneration: 4,
    routeDigest: "a".repeat(64), settled: true,
  });
  assert.throws(() => journal.settle(), /already settled/i);
  assert.equal(JSON.stringify(journal).includes("response"), false);
});
