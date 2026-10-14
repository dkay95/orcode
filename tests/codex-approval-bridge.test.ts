import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalManager } from "../src/approval.js";
import { CodexAppServerClient } from "../src/codex-app-server.js";
import { createCodexAppServerLaunchPlan, resolveOfficialCodexPayload, type CodexAppServerTransport } from "../src/codex-app-server.js";
import { CodexApprovalBridge } from "../src/codex-approval-bridge.js";
import { createCodexHome, parseCodexHomeId } from "../src/codex-profile.js";
import { CodexRouteGate } from "../src/codex-route-gate.js";
import { createCodexStagingWorkspace } from "../src/codex-staging-workspace.js";
import { WorkspaceGuard } from "../src/workspace.js";

class BridgeHarnessTransport implements CodexAppServerTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | null) => void> = [];
  #buffer = "";
  drainCalls = 0;
  readonly frames: unknown[] = [];
  readonly responseWritten: Promise<void>;
  readonly #resolveResponseWritten: () => void;
  readonly drainStarted: Promise<void>;
  readonly #resolveDrainStarted: () => void;
  #nextWriteBlock: null | {
    readonly started: () => void;
    readonly release: Promise<void>;
  } = null;
  readonly #responseWaiters = new Map<string, {
    resolve: (response: { id: string | number; decision: string }) => void;
    reject: (error: Error) => void;
  }>();
  constructor(codexHome: string, readonly approvalResponses: Array<{ id: string | number; decision: string }>, readonly lifecycleEvents: string[] = [], readonly stagingPath = "", emitApproval = false, readonly failApprovalResponse = false, interruptMode: "ok" | "error" | "silent" = "ok") {
    let resolveResponseWritten!: () => void;
    let resolveDrainStarted!: () => void;
    this.responseWritten = new Promise((resolve) => { resolveResponseWritten = resolve; });
    this.drainStarted = new Promise((resolve) => { resolveDrainStarted = resolve; });
    this.#resolveResponseWritten = resolveResponseWritten;
    this.#resolveDrainStarted = resolveDrainStarted;
    const script = `import readline from "node:readline";
const home=process.argv[1]; const rl=readline.createInterface({input:process.stdin});
const send=(v)=>process.stdout.write(JSON.stringify(v)+"\\n");
rl.on("line",(line)=>{const f=JSON.parse(line); if(f.method==="initialized")return;
if(!f.method)return;
if(f.method==="initialize")return send({id:f.id,result:{codexHome:home,platformFamily:"unix",platformOs:"macos",userAgent:"codex_cli_rs/0.159.1"}});
if(f.method==="account/read")return send({id:f.id,result:{account:{type:"chatgpt",email:null,planType:"pro"},requiresOpenaiAuth:true}});
if(f.method==="turn/start"){send({id:f.id,result:{turn:{id:"turn-1",items:[],itemsView:"full",status:"inProgress",error:null,startedAt:1,completedAt:null,durationMs:null}}});${emitApproval ? `send({id:777,method:"item/commandExecution/requestApproval",params:{threadId:"thread-1",turnId:"turn-1",itemId:"auto-command",startedAtMs:1,command:"npm test",cwd:${JSON.stringify(stagingPath)},environmentId:"blocked"}});` : ""}return;}
if(f.method==="turn/interrupt")${interruptMode === "silent" ? "return;" : interruptMode === "error"
  ? "return send({id:f.id,error:{code:-32000,message:\"interrupt rejected\"}});"
  : "return send({id:f.id,result:{}});"}
send({id:f.id,result:{thread:{id:"thread-1"}}});});`;
    this.#child = spawn(process.execPath, ["--input-type=module", "-e", script, codexHome], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.resume();
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) { const i = this.#buffer.indexOf("\n"); if (i < 0) break; const line = this.#buffer.slice(0, i); this.#buffer = this.#buffer.slice(i + 1); this.#enqueue(line); }
    });
    this.#child.once("exit", () => this.#enqueue(null));
  }
  async writeLine(line: string): Promise<void> {
    const blocked = this.#nextWriteBlock;
    if (blocked !== null) {
      this.#nextWriteBlock = null;
      blocked.started();
      await blocked.release;
    }
    const frame = JSON.parse(line) as { id?: string | number; result?: { decision?: string } };
    this.frames.push(frame);
    if ((typeof frame.id === "number" || typeof frame.id === "string")
      && typeof frame.result?.decision === "string") {
      const response = { id: frame.id, decision: frame.result.decision };
      const key = typedRequestIdKey(frame.id);
      const waiter = this.#responseWaiters.get(key);
      this.#responseWaiters.delete(key);
      if (this.failApprovalResponse) {
        const failure = new Error("injected approval response write failure");
        waiter?.reject(failure);
        throw failure;
      }
      this.approvalResponses.push(response);
      waiter?.resolve(response);
      this.#resolveResponseWritten();
    }
    if (!this.#child.stdin.write(`${line}\n`)) await once(this.#child.stdin, "drain");
  }
  readLine(): Promise<string | null> { if (this.#lines.length) return Promise.resolve(this.#lines.shift()!); return new Promise((resolve) => this.#waiters.push(resolve)); }
  close(): void { this.#child.stdin.end(); }
  async drain(): Promise<"closed" | "killed"> { this.drainCalls += 1; this.#resolveDrainStarted(); this.lifecycleEvents.push("drain-start"); this.close(); if (this.#child.exitCode === null) await once(this.#child, "exit"); if (this.stagingPath && !existsSync(this.stagingPath)) throw new Error("staging discarded before drain completed"); this.lifecycleEvents.push("drain-complete"); return this.#child.signalCode === null ? "closed" : "killed"; }
  blockNextWrite(): { started: Promise<void>; release: () => void } {
    if (this.#nextWriteBlock !== null) throw new Error("write block is already armed");
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.#nextWriteBlock = { started: markStarted, release: releasePromise };
    return { started, release };
  }
  emitServerFrame(frame: unknown): void { this.#enqueue(JSON.stringify(frame)); }
  waitForApprovalResponse(id: string | number): Promise<{ id: string | number; decision: string }> {
    const key = typedRequestIdKey(id);
    const existing = this.approvalResponses.find((response) => typedRequestIdKey(response.id) === key);
    if (existing !== undefined) return Promise.resolve(existing);
    if (this.#responseWaiters.has(key)) throw new Error("approval response waiter already exists");
    return new Promise((resolve, reject) => this.#responseWaiters.set(key, { resolve, reject }));
  }
  #enqueue(line: string | null): void { const waiter = this.#waiters.shift(); if (waiter) waiter(line); else if (line !== null) this.#lines.push(line); }
}

function typedRequestIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

const trustedCodex = resolveOfficialCodexPayload("/usr/local/bin/codex");

async function operationAuthority(
  appHome: string,
  stagingRealpath: string,
  responses: Array<{ id: string | number; decision: string }>,
  events: string[] = [],
  emitApproval = false,
  failApprovalResponse = false,
  interruptMode: "ok" | "error" | "silent" = "ok",
) {
  const homeId = parseCodexHomeId(`codex-${Buffer.from(stagingRealpath).toString("hex").slice(-32).padStart(32, "0")}`);
  const profile = await createCodexHome({ appHome, homeId, accountLabel: "Owner" });
  let transport!: BridgeHarnessTransport;
  const client = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(profile, await trustedCodex),
    async () => (transport = new BridgeHarnessTransport(
      profile.codexHome, responses, events, stagingRealpath, emitApproval, failApprovalResponse, interruptMode,
    )),
  );
  await client.start();
  const binding = { profileId: "owner", codexHomeRealpath: profile.codexHome, route: {
    version: 1 as const, backendId: "codex" as const, accountFingerprint: "owner",
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "gpt-5.4", canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const,
  }, modelId: "gpt-5.4" };
  const gate = new CodexRouteGate({ ...binding, client, childGeneration: 7 });
  gate.observeAccountUpdated({ childGeneration: 7, params: { authMode: "chatgpt", planType: "pro" } });
  const permit = await gate.refreshAndIssueDispatchPermit(binding);
  const routeDigest = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const operation = await gate.consumeAndWriteTurn(permit, client, binding, {
    threadId: "thread-1", input: [{ type: "text", text: "test" }], cwd: stagingRealpath,
  }, { childGeneration: 7, threadId: "thread-1", stagingRealpath, routeDigest });
  return { client, transport, profile, gate, authority: operation.authority, routeDigest };
}

async function fixture(
  decisions: readonly boolean[] = [true],
  options: Readonly<{
    prompt?: () => Promise<{ accepted: boolean; remember?: "allow" | "deny" }>;
    isCurrentGeneration?: (generation: number) => boolean;
    failApprovalResponse?: boolean;
    interruptMode?: "ok" | "error" | "silent";
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-approval-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(workspacePath, "src.txt"), "before\n");
  const workspace = await WorkspaceGuard.create(workspacePath);
  const staging = await createCodexStagingWorkspace({ appHome, realWorkspace: workspace });
  const approvals = new ApprovalManager("ask");
  let approvalCalls = 0;
  approvals.setPromptHandler(async () => {
    approvalCalls += 1;
    if (options.prompt) return options.prompt();
    return {
      accepted: decisions[approvalCalls - 1] ?? decisions.at(-1) ?? false,
      remember: "allow",
    };
  });
  const responses: Array<{ id: string | number; decision: string }> = [];
  const operation = await operationAuthority(
    appHome, staging.canonicalPath, responses, [], false, options.failApprovalResponse ?? false,
    options.interruptMode ?? "ok",
  );
  const bridge = new CodexApprovalBridge({
    threadId: "thread-1",
    turnId: "turn-1",
    childGeneration: 7,
    deadlineAt: Date.now() + 30_000,
    staging,
    approvals,
    routeDigest: operation.routeDigest,
    operationAuthority: operation.authority,
    ...(options.isCurrentGeneration === undefined
      ? {}
      : { isCurrentGeneration: options.isCurrentGeneration }),
  });
  return {
    root,
    workspace,
    staging,
    bridge,
    responses,
    approvalCalls: () => approvalCalls,
    appServer: operation.client,
    appTransport: operation.transport,
    routeGate: operation.gate,
    deliver: async (request: unknown) => {
      if (typeof request !== "object" || request === null
        || !("id" in request)
        || !(typeof request.id === "string" || typeof request.id === "number")) {
        throw new Error("test request requires a typed JSON-RPC id");
      }
      const response = operation.transport.waitForApprovalResponse(request.id);
      operation.transport.emitServerFrame(request);
      try {
        const delivered = await response;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await bridge.waitForCleanup();
        return delivered;
      } catch (error) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await bridge.waitForCleanup();
        throw error;
      }
    },
  };
}

const commandRequest = {
  id: 1,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1", startedAtMs: 1,
    command: "npm test",
    cwd: "",
    reason: "Tests ausführen",
    environmentId: null,
  },
} as const;

test("routes only stable command and preview-matched file requests through Orcode authority", async () => {
  const state = await fixture([true, false]);
  try {
    const command = structuredClone(commandRequest) as {
      id: number;
      method: string;
      params: { threadId: string; turnId: string; itemId: string; command: string; cwd: string; reason: string };
    };
    command.params.cwd = state.staging.canonicalPath;
    await state.deliver(command);
    await state.bridge.observePatchUpdated({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      changes: [{
        path: "src.txt",
        kind: "update",
        diff: "@@ -1 +1 @@\n-before\n+after\n",
      }],
    });
    await state.deliver({
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", startedAtMs: 1 },
    });
    assert.deepEqual(state.responses.map(({ decision }) => decision), ["accept", "decline"]);
    assert.equal(state.responses.some(({ decision }) => decision === "acceptForSession"), false);
    assert.deepEqual(state.bridge.stagedUndoPaths, ["src.txt"]);
    assert.equal(state.bridge.approvedPreviews.length, 0, "declined patches never become publish authority");
    assert.equal(await readFile(join(state.staging.canonicalPath, "src.txt"), "utf8"), "before\n");
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("revalidates the bound generation after the owner prompt before accepting", async () => {
  let currentGeneration = true;
  let releasePrompt!: () => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const prompt = new Promise<{ accepted: boolean }>((resolve) => {
    releasePrompt = () => resolve({ accepted: true });
  });
  const state = await fixture([true], {
    isCurrentGeneration: () => currentGeneration,
    prompt: async () => {
      promptStarted();
      return prompt;
    },
  });
  try {
    const command = structuredClone(commandRequest) as {
      id: number;
      method: string;
      params: { threadId: string; turnId: string; itemId: string; command: string; cwd: string; reason: string };
    };
    command.params.cwd = state.staging.canonicalPath;
    const handling = state.deliver(command);
    await started;
    currentGeneration = false;
    releasePrompt();
    await handling;

    assert.deepEqual(state.responses, [{ id: 1, decision: "cancel" }]);
    assert.equal(state.bridge.closed, true);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("revokes an active owner approval after route or account epoch drift", async () => {
  let releasePrompt!: () => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const prompt = new Promise<{ accepted: boolean }>((resolve) => {
    releasePrompt = () => resolve({ accepted: true });
  });
  const state = await fixture([true], {
    prompt: async () => {
      promptStarted();
      return prompt;
    },
  });
  try {
    const request = structuredClone(commandRequest) as Record<string, any>;
    request.params.cwd = state.staging.canonicalPath;
    const handling = state.deliver(request);
    await started;
    state.routeGate.observeRateLimits({ primary: { usedPercent: 99 } });
    releasePrompt();
    await handling;
    assert.deepEqual(state.responses, [{ id: 1, decision: "cancel" }]);
    assert.equal(state.bridge.closed, true);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    releasePrompt?.();
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rechecks route authority at the physical accept-response write", async () => {
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const state = await fixture([true], {
    prompt: async () => {
      promptStarted();
      return { accepted: true };
    },
  });
  const block = state.appTransport.blockNextWrite();
  const blockingRead = state.appServer.request("account/read", {}).catch(() => undefined);
  try {
    await block.started;
    const request = structuredClone(commandRequest) as Record<string, any>;
    request.id = 70;
    request.params.cwd = state.staging.canonicalPath;
    state.appTransport.emitServerFrame(request);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    state.routeGate.observeRateLimits({ primary: { usedPercent: 99 } });
    block.release();
    const outcome = await Promise.race([
      state.appTransport.drainStarted.then(() => "drained" as const),
      state.appTransport.responseWritten.then(() => "stale-response" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);
    assert.equal(outcome, "drained", "a stale accept must fail before its transport frame");
    await state.bridge.waitForCleanup();
    assert.equal(state.responses.some((response) =>
      response.id === 70 && response.decision === "accept"), false);
    assert.equal(state.bridge.closed, true);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    block.release();
    await blockingRead;
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("notification-origin patch violations complete exact drain before staging cleanup", async () => {
  const state = await fixture([true]);
  let listenerEntered!: () => void;
  const entered = new Promise<void>((resolve) => { listenerEntered = resolve; });
  state.appServer.onNotification("item/fileChange/patchUpdated", (params) => {
    listenerEntered();
    return state.bridge.observePatchUpdated(params as never);
  });
  state.appTransport.emitServerFrame({
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "invalid-empty-patch",
      changes: [],
    },
  });
  try {
    await entered;
    await Promise.race([
      state.bridge.waitForCleanup(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("notification cleanup deadlocked on its read pump")), 2_000).unref();
      }),
    ]);
    assert.equal(state.bridge.closed, true);
    assert.equal(state.appTransport.drainCalls, 1);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("requires a real App Server client to drain before discarding on an unknown request", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-drain-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(workspacePath, "src.txt"), "before\n");
  const staging = await createCodexStagingWorkspace({
    appHome,
    realWorkspace: await WorkspaceGuard.create(workspacePath),
  });
  const responses: Array<{ id: string | number; decision: string }> = [];
  const lifecycleEvents: string[] = [];
  const operation = await operationAuthority(appHome, staging.canonicalPath, responses, lifecycleEvents);
  let decoyTransport!: BridgeHarnessTransport;
  const decoy = new CodexAppServerClient(
    await createCodexAppServerLaunchPlan(operation.profile, await trustedCodex),
    async () => (decoyTransport = new BridgeHarnessTransport(operation.profile.codexHome, [])),
  );
  await decoy.start();
  try {
    assert.throws(() => new CodexApprovalBridge({
      threadId: "thread-1", turnId: "turn-1", childGeneration: 7,
      deadlineAt: Date.now() + 30_000, staging, approvals: new ApprovalManager("ask"),
      routeDigest: operation.routeDigest, operationAuthority: operation.authority,
      appServer: decoy,
    } as never), /invalid/i, "a second started client cannot be substituted into the operation bridge");
    const bridge = new CodexApprovalBridge({
      threadId: "thread-1",
      turnId: "turn-1",
      childGeneration: 7,
      deadlineAt: Date.now() + 30_000,
      staging,
      approvals: new ApprovalManager("ask"),
      routeDigest: operation.routeDigest,
      operationAuthority: operation.authority,
    });
    assert.throws(() => new CodexApprovalBridge({
      threadId: "thread-1", turnId: "turn-1", childGeneration: 7,
      deadlineAt: Date.now() + 30_000, staging, approvals: new ApprovalManager("ask"),
      routeDigest: operation.routeDigest, operationAuthority: operation.authority,
    }), /already used|invalid|stale/i);
    const response = operation.transport.waitForApprovalResponse(99);
    operation.transport.emitServerFrame({
      id: 99,
      method: "item/permissions/requestApproval",
      params: {},
    });
    await response;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await bridge.waitForCleanup();
    assert.deepEqual(responses, [{ id: 99, decision: "cancel" }]);
    assert.equal(existsSync(staging.canonicalPath), false);
    await assert.rejects(operation.client.request("account/read", {}), /closed|not initialized/i);
    assert.deepEqual(await decoy.request("account/read", {}), {
      account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true,
    });
    assert.equal(operation.transport.drainCalls, 1);
    assert.equal(decoyTransport.drainCalls, 0);
    assert.deepEqual(lifecycleEvents, ["drain-start", "drain-complete"]);
  } finally {
    await operation.client.drain().catch(() => undefined);
    await decoy.drain().catch(() => undefined);
    await staging.discard().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("claims a server request queued by the exact turn client and responds on that client", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-queued-request-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(workspacePath, "src.txt"), "before\n");
  const staging = await createCodexStagingWorkspace({ appHome, realWorkspace: await WorkspaceGuard.create(workspacePath) });
  const responses: Array<{ id: string | number; decision: string }> = [];
  const operation = await operationAuthority(appHome, staging.canonicalPath, responses, [], true);
  try {
    new CodexApprovalBridge({
      threadId: "thread-1", turnId: "turn-1", childGeneration: 7,
      deadlineAt: Date.now() + 30_000, staging, approvals: new ApprovalManager("ask"),
      routeDigest: operation.routeDigest, operationAuthority: operation.authority,
    });
    await Promise.race([
      operation.transport.responseWritten,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(
          `queued approval response timed out; frames=${JSON.stringify(operation.transport.frames)}`,
        )), 2_000).unref();
      }),
    ]);
    assert.deepEqual(responses, [{ id: 777, decision: "decline" }]);
  } finally {
    await operation.client.drain().catch(() => undefined);
    await staging.discard().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation sends the exact turn interrupt before draining and discarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-cancel-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(workspacePath, "src.txt"), "before\n");
  const staging = await createCodexStagingWorkspace({ appHome, realWorkspace: await WorkspaceGuard.create(workspacePath) });
  const operation = await operationAuthority(appHome, staging.canonicalPath, []);
  try {
    const bridge = new CodexApprovalBridge({
      threadId: "thread-1", turnId: "turn-1", childGeneration: 7,
      deadlineAt: Date.now() + 30_000, staging, approvals: new ApprovalManager("ask"),
      routeDigest: operation.routeDigest, operationAuthority: operation.authority,
    });
    await bridge.cancelAndDrain();
    const interrupt = operation.transport.frames.find((frame) => (frame as { method?: string }).method === "turn/interrupt");
    assert.deepEqual(interrupt, { method: "turn/interrupt", id: 3, params: { threadId: "thread-1", turnId: "turn-1" } });
    assert.equal(operation.transport.drainCalls, 1);
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await operation.client.drain().catch(() => undefined);
    await staging.discard().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation drains and discards even when turn interrupt errors or stays silent", async (context) => {
  for (const mode of ["error", "silent"] as const) {
    await context.test(mode, async () => {
      const state = await fixture([true], { interruptMode: mode });
      try {
        const outcome = await Promise.race([
          state.bridge.cancelAndDrain().then(
            () => ({ type: "resolved" as const, error: null }),
            (error: unknown) => ({ type: "rejected" as const, error }),
          ),
          new Promise<{ type: "timeout"; error: null }>((resolve) =>
            setTimeout(() => resolve({ type: "timeout", error: null }), 2_000)),
        ]);
        assert.notEqual(outcome.type, "timeout", "cancellation cleanup must be bounded");
        assert.equal(outcome.type, mode === "error" ? "rejected" : "resolved",
          "real RPC errors remain visible while self-drain closes a silent interrupt");
        if (mode === "error") assert.match(String(outcome.error), /interrupt rejected/i);
        assert.equal(state.bridge.closed, true);
        assert.equal(state.staging.active, false);
        await assert.rejects(state.appServer.request("account/read", {}), /closed|initialized/i);
      } finally {
        await state.appServer.drain().catch(() => undefined);
        await state.staging.discard().catch(() => undefined);
        await rm(state.root, { recursive: true, force: true });
      }
    });
  }
});

test("declines every official additional-authority field before ApprovalManager", async () => {
  const state = await fixture([true]);
  try {
    const dangerousFields = [
      { networkApprovalContext: { host: "example.com", protocol: "https" } },
      { proposedNetworkPolicyAmendments: [{ host: "example.com" }] },
      { proposedExecpolicyAmendment: ["npm", "test"] },
      { environmentId: "external-environment" },
    ] as const;
    for (let index = 0; index < dangerousFields.length; index += 1) {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = 10 + index;
      request.params.itemId = `network-${index}`;
      request.params.cwd = state.staging.canonicalPath;
      Object.assign(request.params, dangerousFields[index]);
      await state.deliver(request);
    }
    assert.deepEqual(state.responses.map(({ decision }) => decision), [
      "decline", "decline", "decline", "decline",
    ]);
    assert.equal(state.approvalCalls(), 0);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("missing required environmentId fails closed before owner approval", async () => {
  const state = await fixture([true]);
  try {
    const request = structuredClone(commandRequest) as Record<string, any>;
    request.params.cwd = state.staging.canonicalPath;
    delete request.params.environmentId;
    await state.deliver(request);
    assert.deepEqual(state.responses, [{ id: 1, decision: "cancel" }]);
    assert.equal(state.approvalCalls(), 0);
    assert.equal(state.bridge.closed, true);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a failed approval response write drains before staging cleanup", async () => {
  const state = await fixture([true], { failApprovalResponse: true });
  try {
    const request = structuredClone(commandRequest) as Record<string, any>;
    request.params.cwd = state.staging.canonicalPath;
    request.params.environmentId = "external-environment";
    await assert.rejects(state.deliver(request), /response write failure/i);
    await state.bridge.waitForCleanup();
    assert.equal(state.bridge.closed, true);
    assert.equal(state.appTransport.drainCalls, 1);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("routes an official string approval id and keeps numeric and string ids distinct", async () => {
  const state = await fixture([true]);
  try {
    for (const id of [1, "1"] as const) {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = id;
      request.params.itemId = `command-${typeof id}`;
      request.params.cwd = state.staging.canonicalPath;
      request.params.environmentId = "external-environment";
      await state.deliver(request);
    }
    assert.deepEqual(state.responses, [
      { id: 1, decision: "decline" },
      { id: "1", decision: "decline" },
    ]);
    assert.equal(state.bridge.closed, false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("allows distinct official command callback ids for one item and rejects callback reuse", async () => {
  const state = await fixture([true, true]);
  try {
    for (const [id, approvalId] of [[81, "callback-a"], [82, "callback-b"]] as const) {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = id;
      request.params.itemId = "shared-command-item";
      request.params.approvalId = approvalId;
      request.params.cwd = state.staging.canonicalPath;
      await state.deliver(request);
    }
    assert.deepEqual(state.responses, [
      { id: 81, decision: "accept" },
      { id: 82, decision: "accept" },
    ]);
    assert.equal(state.approvalCalls(), 2);
    const duplicate = structuredClone(commandRequest) as Record<string, any>;
    duplicate.id = 83;
    duplicate.params.itemId = "shared-command-item";
    duplicate.params.approvalId = "callback-a";
    duplicate.params.cwd = state.staging.canonicalPath;
    await state.deliver(duplicate);
    assert.deepEqual(state.responses.at(-1), { id: 83, decision: "cancel" });
    assert.equal(state.bridge.closed, true);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("cancels absent or nullable official command and cwd before owner approval", async (context) => {
  for (const [field, absent] of [
    ["command", false], ["cwd", false], ["command", true], ["cwd", true],
  ] as const) {
    await context.test(`${field}-${absent ? "absent" : "null"}`, async () => {
      const state = await fixture([true]);
      try {
        const request = structuredClone(commandRequest) as Record<string, any>;
        request.params.cwd = state.staging.canonicalPath;
        if (absent) delete request.params[field];
        else request.params[field] = null;
        await state.deliver(request);
        assert.deepEqual(state.responses, [{ id: 1, decision: "cancel" }]);
        assert.equal(state.approvalCalls(), 0);
        assert.equal(state.bridge.closed, true);
      } finally {
        await state.appServer.drain().catch(() => undefined);
        await state.staging.discard().catch(() => undefined);
        await rm(state.root, { recursive: true, force: true });
      }
    });
  }
});

test("rejects accessor-backed patch fields without evaluating them", async () => {
  const state = await fixture([true]);
  let getterCalls = 0;
  try {
    const change = {
      kind: "update",
      diff: "@@ -1 +1 @@\n-before\n+after\n",
    } as Record<string, unknown>;
    Object.defineProperty(change, "path", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "src.txt";
      },
    });
    await assert.rejects(
      state.bridge.observePatchUpdated({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-accessor",
        changes: [change as never],
      }),
      /schema|invalid|verified/i,
    );
    await state.bridge.waitForCleanup();
    assert.equal(getterCalls, 0);
    assert.equal(existsSync(state.staging.canonicalPath), false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("accepts a current add preview while the target is still absent", async () => {
  const state = await fixture([true]);
  try {
    await state.bridge.observePatchUpdated({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-add",
      changes: [{
        path: "new.txt",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+new\n",
      }],
    });
    await state.deliver({
      id: 20,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-add", startedAtMs: 1 },
    });
    assert.deepEqual(state.responses, [{ id: 20, decision: "accept" }]);
    assert.equal(state.bridge.approvedPreviews.length, 1);
    assert.equal(state.bridge.closed, false);
  } finally {
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});

test("cancels each unknown, stale, duplicate, escaping, and unmatched request at its wired boundary", async (context) => {
  await context.test("unknown method", async () => {
    const state = await fixture([true]);
    try {
      await state.deliver({ id: 30, method: "item/permissions/requestApproval", params: {} });
      assert.deepEqual(state.responses, [{ id: 30, decision: "cancel" }]);
      assert.equal(state.bridge.closed, true);
      assert.equal(state.approvalCalls(), 0);
      assert.equal(existsSync(state.staging.canonicalPath), false);
    } finally {
      await state.appServer.drain().catch(() => undefined);
      await state.staging.discard().catch(() => undefined);
      await rm(state.root, { recursive: true, force: true });
    }
  });

  await context.test("stale generation", async () => {
    const state = await fixture([true], { isCurrentGeneration: () => false });
    try {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = 31;
      request.params.cwd = state.staging.canonicalPath;
      await state.deliver(request);
      assert.deepEqual(state.responses, [{ id: 31, decision: "cancel" }]);
      assert.equal(state.approvalCalls(), 0);
      assert.equal(existsSync(state.staging.canonicalPath), false);
    } finally {
      await state.appServer.drain().catch(() => undefined);
      await state.staging.discard().catch(() => undefined);
      await rm(state.root, { recursive: true, force: true });
    }
  });

  await context.test("duplicate request id", async () => {
    const state = await fixture([true]);
    try {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = 32;
      request.params.cwd = state.staging.canonicalPath;
      request.params.environmentId = "blocked";
      await state.deliver(request);
      state.appTransport.emitServerFrame(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await state.bridge.waitForCleanup();
      await assert.rejects(state.appServer.request("account/read", {}),
        /duplicate|closed|request id|protocol|initialized/i);
      assert.deepEqual(state.responses, [{ id: 32, decision: "decline" }]);
      assert.equal(existsSync(state.staging.canonicalPath), false);
    } finally {
      await state.appServer.drain().catch(() => undefined);
      await state.staging.discard().catch(() => undefined);
      await rm(state.root, { recursive: true, force: true });
    }
  });

  await context.test("escaping command cwd", async () => {
    const state = await fixture([true]);
    try {
      const request = structuredClone(commandRequest) as Record<string, any>;
      request.id = 33;
      request.params.cwd = tmpdir();
      await state.deliver(request);
      assert.deepEqual(state.responses, [{ id: 33, decision: "cancel" }]);
      assert.equal(state.approvalCalls(), 0);
      assert.equal(existsSync(state.staging.canonicalPath), false);
    } finally {
      await state.appServer.drain().catch(() => undefined);
      await state.staging.discard().catch(() => undefined);
      await rm(state.root, { recursive: true, force: true });
    }
  });

  await context.test("unmatched file item", async () => {
    const state = await fixture([true]);
    try {
      await state.deliver({
        id: 34,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "missing", startedAtMs: 1 },
      });
      assert.deepEqual(state.responses, [{ id: 34, decision: "cancel" }]);
      assert.equal(state.approvalCalls(), 0);
      assert.equal(existsSync(state.staging.canonicalPath), false);
    } finally {
      await state.appServer.drain().catch(() => undefined);
      await state.staging.discard().catch(() => undefined);
      await rm(state.root, { recursive: true, force: true });
    }
  });
});

test("revalidates the exact staged effect after the owner prompt before file acceptance", async () => {
  let releasePrompt!: () => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const prompt = new Promise<{ accepted: boolean }>((resolve) => {
    releasePrompt = () => resolve({ accepted: true });
  });
  const state = await fixture([true], {
    prompt: async () => {
      promptStarted();
      return prompt;
    },
  });
  const outside = join(state.root, "outside.txt");
  await writeFile(outside, "outside\n");
  try {
    await state.bridge.observePatchUpdated({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-link-swap",
      changes: [{
        path: "src.txt",
        kind: "update",
        diff: "@@ -1 +1 @@\n-before\n+after\n",
      }],
    });
    const handling = state.deliver({
      id: 40,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-link-swap", startedAtMs: 1 },
    });
    await started;
    await unlink(join(state.staging.canonicalPath, "src.txt"));
    await symlink(outside, join(state.staging.canonicalPath, "src.txt"));
    releasePrompt();
    await handling;

    assert.deepEqual(state.responses, [{ id: 40, decision: "cancel" }]);
    assert.equal(state.bridge.approvedPreviews.length, 0);
    assert.equal(state.bridge.closed, true);
    assert.equal(existsSync(state.staging.canonicalPath), false);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  } finally {
    releasePrompt?.();
    await state.appServer.drain().catch(() => undefined);
    await state.staging.discard().catch(() => undefined);
    await rm(state.root, { recursive: true, force: true });
  }
});
