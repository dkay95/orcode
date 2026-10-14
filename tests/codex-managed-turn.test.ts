import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalManager } from "../src/approval.js";
import { CodexAppServerClient, createCodexAppServerLaunchPlan, resolveOfficialCodexPayload,
  type CodexAppServerTransport } from "../src/codex-app-server.js";
import { createCodexHome } from "../src/codex-profile.js";
import { CodexRouteGate } from "../src/codex-route-gate.js";
import { ChangeJournal, WorkspaceGuard } from "../src/workspace.js";
import * as managed from "../src/codex-managed-turn.js";

const turn = (status = "inProgress") => ({ id: "turn-1", items: [], itemsView: "full", status,
  error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1 });

class ManagedTransport implements CodexAppServerTransport {
  frames: Array<Record<string, any>> = [];
  lines: Array<string | null> = [];
  waiters: Array<(line: string | null) => void> = [];
  closed = false;
  staging = "";
  drainObservedWorkspace = "";
  passiveFrames: readonly unknown[] = [];
  assistantDeltas: readonly string[] | ((staging: string) => readonly string[]) = ["Hello from Codex."];
  constructor(readonly home: string, readonly realWorkspace: string,
    readonly scenario: "text" | "patch" | "invalid-auth" | "pending" | "extra-write" | "error" = "text") {}
  emit(value: unknown | null): void {
    const line = value === null ? null : JSON.stringify(value);
    const waiter = this.waiters.shift();
    if (waiter) waiter(line); else this.lines.push(line);
  }
  async writeLine(line: string): Promise<void> {
    const f = JSON.parse(line); this.frames.push(f);
    if (f.method === "initialize") {
      this.emit({ id: f.id, result: {
        codexHome: this.home, platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.159.1" } });
      this.emit({ method: "remoteControl/status/changed", params: {
        status: "disabled", installationId: "private-installation", serverName: "private-device", environmentId: null } });
    }
    if (f.method === "account/read") this.emit({ id: f.id, result: {
      account: this.scenario === "invalid-auth" ? { type: "apiKey" } : { type: "chatgpt", email: null, planType: "pro" },
      requiresOpenaiAuth: true } });
    if (f.method === "thread/start") {
      this.staging = f.params.cwd;
      this.emit({ id: f.id, result: {
        thread: { id: "thread-1", sessionId: "session-1", forkedFromId: null, parentThreadId: null,
          preview: "", ephemeral: true, modelProvider: "openai", createdAt: 1, updatedAt: 1, recencyAt: 1,
          status: { type: "idle" }, path: null, cwd: f.params.cwd, cliVersion: "0.159.1", source: "appServer",
          threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] },
        model: f.params.model, modelProvider: "openai", serviceTier: null, cwd: f.params.cwd,
        instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true }, reasoningEffort: null,
      } });
    }
    if (f.method === "turn/start") {
      this.emit({ id: f.id, result: { turn: turn() } });
      for (const frame of this.passiveFrames) this.emit(frame);
      const deltas = typeof this.assistantDeltas === "function" ? this.assistantDeltas(this.staging) : this.assistantDeltas;
      for (const delta of deltas) this.emit({ method: "item/agentMessage/delta", params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "text-1", delta } });
      if (this.scenario === "pending") return;
      if (this.scenario === "error") {
        this.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { ...turn("failed"),
          error: { message: "private provider error", codexErrorInfo: null, additionalDetails: null } } } });
        return;
      }
      if (this.scenario === "patch" || this.scenario === "extra-write") {
        this.emit({ method: "item/fileChange/patchUpdated", params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "patch-1",
          changes: [{ path: "main.ts", kind: { type: "update", move_path: null },
            diff: "--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-before\n+after\n" }] } });
        this.emit({ id: "approve-1", method: "item/fileChange/requestApproval", params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", startedAtMs: 1 } });
        return;
      }
      this.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed") } });
    }
    if (f.id === "approve-1" && f.result) {
      if (f.result.decision === "accept") {
        await writeFile(join(this.staging, "main.ts"), "after\n", { mode: 0o600 });
        if (this.scenario === "extra-write") await writeFile(join(this.staging, "extra.txt"), "unapproved\n");
      }
      this.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed") } });
    }
    if (f.method === "turn/interrupt") this.emit({ id: f.id, result: {} });
  }
  readLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter(null); }
  async drain(): Promise<"closed"> {
    this.drainObservedWorkspace = await readFile(join(this.realWorkspace, "main.ts"), "utf8");
    this.close(); return "closed";
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, scenario: ManagedTransport["scenario"] = "text", accepted = true) {
  const root = await mkdtemp(join(tmpdir(), "orcode-managed-codex-"));
  let client: CodexAppServerClient | null = null;
  t.after(async () => {
    await client?.drain().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const appHome = join(root, "app private"); const realWorkspace = join(root, "workspace");
  await mkdir(appHome, { mode: 0o700 }); await mkdir(realWorkspace, { mode: 0o700 });
  await writeFile(join(realWorkspace, "main.ts"), "before\n");
  const fakePath = join(root, "untrusted-codex"); await writeFile(fakePath, "not a signed payload", { mode: 0o700 });
  await assert.rejects(resolveOfficialCodexPayload(fakePath), /trusted signed Codex payload/i);
  const profile = await createCodexHome({ appHome, accountLabel: "Owner" });
  const transport = new ManagedTransport(profile.codexHome, realWorkspace, scenario);
  client = new CodexAppServerClient(await createCodexAppServerLaunchPlan(profile,
    await resolveOfficialCodexPayload()), async () => transport);
  await client.start();
  const binding = { profileId: profile.binding.homeId, codexHomeRealpath: profile.codexHome, modelId: "gpt-5.4",
    route: { version: 1 as const, backendId: "codex" as const, accountFingerprint: "fixture-owner",
      billingRealm: "chatgpt-subscription-provider-managed-overage" as const, requestedModelId: "gpt-5.4",
      canonicalModelId: "gpt-5.4", resolutionState: "resolved" as const } };
  const gate = new CodexRouteGate({ client, childGeneration: 1, ...binding });
  gate.observeAccountUpdated({ childGeneration: 1, params: { authMode: "chatgpt", planType: "pro" } });
  const approvals = new ApprovalManager("ask"); let prompts = 0;
  approvals.setPromptHandler(async () => { prompts++; return { accepted }; });
  const events: managed.CodexManagedTurnEvent[] = [];
  return { transport, events, appHome, realWorkspace, prompts: () => prompts, input: {
    authority: { client, gate, binding, childGeneration: 1 }, appHome, approvals,
    workspace: await WorkspaceGuard.create(realWorkspace), journal: new ChangeJournal({ appHome, chatId: "managed" }),
    runId: "run-managed", task: "Please inspect main.ts", onEvent: (event: managed.CodexManagedTurnEvent) => events.push(event),
  } };
}

test("managed Codex turns stream text, settle completed, and drain before staging cleanup", async (t) => {
  const state = await fixture(t);
  assert.equal(typeof (managed as any).runCodexManagedTurn, "function", "managed production turn entry point is missing");
  const result = await (managed as any).runCodexManagedTurn(state.input);
  assert.deepEqual(result, { status: "completed", text: "Hello from Codex.", publishedPaths: [], cost: "unknown" });
  assert.deepEqual(state.events, [{ type: "text", text: "Hello from Codex." }, { type: "completed" }]);
  assert.equal(JSON.stringify(state.events).includes("private-installation"), false);
  assert.equal(JSON.stringify(state.events).includes("private-device"), false);
  assert.equal(state.transport.closed, true);
  assert.deepEqual(await readdir(join(state.appHome, "codex-staging")), []);
});

test("managed Codex streaming preserves frame order across the pending-to-live handoff", async (t) => {
  const state = await fixture(t);
  state.transport.assistantDeltas = ["A", "B", "C", "D", "E"];
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "completed", result.message);
  assert.equal(result.text, "ABCDE");
  assert.equal(state.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "ABCDE");
});

for (const accepted of [true, false]) test(`managed Codex patch ${accepted ? "approval publishes" : "denial leaves"} exact real bytes`, async (t) => {
  const state = await fixture(t, "patch", accepted);
  const result = await (managed as any).runCodexManagedTurn(state.input);
  assert.equal(result.status, "completed", result.message);
  assert.equal(state.prompts(), 1);
  assert.equal(state.transport.drainObservedWorkspace, "before\n", "publication must occur only after child drain");
  assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), accepted ? "after\n" : "before\n");
  assert.deepEqual(result.publishedPaths, accepted ? ["main.ts"] : []);
  if (accepted) {
    await state.input.journal.undoLastRun(state.input.workspace, new ApprovalManager("allow-all"));
    assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), "before\n",
      "managed publication must write the normal undo journal");
  }
});

test("managed Codex invalid auth dispatches zero task bytes and extra staging writes publish nothing", async (t) => {
  for (const scenario of ["invalid-auth", "extra-write"] as const) {
    const state = await fixture(t, scenario);
    const result = await (managed as any).runCodexManagedTurn(state.input);
    assert.equal(result.status, "error");
    assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), "before\n");
    if (scenario === "invalid-auth") assert.equal(state.transport.frames.some((frame) => frame.method === "turn/start"), false);
    assert.equal(state.transport.closed, true);
  }
});

test("managed Codex cancellation interrupts and drains without publication", async (t) => {
  const state = await fixture(t, "pending"); const abort = new AbortController();
  const result = await (managed as any).runCodexManagedTurn({ ...state.input, signal: abort.signal,
    onEvent(event: managed.CodexManagedTurnEvent) { state.events.push(event); abort.abort(); } });
  assert.equal(result.status, "cancelled");
  assert.equal(state.transport.closed, true);
  assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), "before\n");
  assert.equal(state.events.some((event) => event.type === "completed"), false);
});

test("the pinned client accepts correlated login completion but rejects private extra fields before delivery", async (t) => {
  const state = await fixture(t);
  const completions: unknown[] = [];
  const client = state.input.authority.client;
  client.onNotification("account/login/completed", (params) => { completions.push(params); });
  state.transport.emit({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [{ loginId: "login-1", success: true, error: null }]);
  const ended = new Promise<void>((resolve) => client.onTerminal(() => resolve()));
  state.transport.emit({ method: "account/login/completed", params: {
    loginId: "login-2", success: true, error: null, accessToken: "must-never-be-delivered" } });
  await ended;
  assert.equal(completions.length, 1);
});

test("a failed Codex turn never reports completed or leaks the provider error body", async (t) => {
  const state = await fixture(t, "error");
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("private provider error"), false);
  assert.equal(state.events.some((event) => event.type === "completed"), false);
  assert.equal(state.transport.closed, true);
});

test("a completion display failure cannot hide an already published Codex patch", async (t) => {
  const state = await fixture(t, "patch");
  const result = await managed.runCodexManagedTurn({ ...state.input, onEvent(event) {
    if (event.type === "completed") throw new Error("surface closed after commit");
  } });
  assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), "after\n");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.publishedPaths, ["main.ts"]);
});

test("queued work after terminal completion prevents publication even when drain has started", async (t) => {
  const state = await fixture(t, "patch");
  const emit = state.transport.emit.bind(state.transport);
  state.transport.emit = (frame: any) => {
    emit(frame);
    if (frame?.method === "turn/completed") emit({ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "late", delta: "late event" } });
  };
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "error");
  assert.deepEqual(result.publishedPaths, []);
  assert.equal(await readFile(join(state.realWorkspace, "main.ts"), "utf8"), "before\n");
  assert.equal(state.transport.closed, true);
  assert.equal(state.events.some((event) => event.type === "completed"), false);
});

test("standard pinned reasoning, output, plan, and usage notifications do not break a normal turn", async (t) => {
  const state = await fixture(t);
  const scope = { threadId: "thread-1", turnId: "turn-1" };
  const usage = { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 };
  state.transport.passiveFrames = [
    { method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } } },
    { method: "thread/name/updated", params: { threadId: "thread-1", threadName: "Fixture task" } },
    { method: "item/reasoning/summaryPartAdded", params: { ...scope, itemId: "r1", summaryIndex: 0 } },
    { method: "item/reasoning/summaryTextDelta", params: { ...scope, itemId: "r1", summaryIndex: 0, delta: "Private reasoning." } },
    { method: "item/reasoning/textDelta", params: { ...scope, itemId: "r1", contentIndex: 0, delta: "Private reasoning." } },
    { method: "item/commandExecution/outputDelta", params: { ...scope, itemId: "cmd1", delta: "test output" } },
    { method: "item/plan/delta", params: { ...scope, itemId: "plan1", delta: "inspect" } },
    { method: "turn/plan/updated", params: { ...scope, explanation: null, plan: [{ step: "Inspect", status: "completed" }] } },
    { method: "turn/diff/updated", params: { ...scope, diff: "" } },
    { method: "thread/tokenUsage/updated", params: { ...scope, tokenUsage: { total: usage, last: usage, modelContextWindow: 100000 } } },
  ];
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "completed", result.message);
  assert.equal(result.text, "Hello from Codex.");
  assert.equal(JSON.stringify(state.events).includes("Private reasoning"), false);
});

test("assistant streaming cannot reconstruct private profile paths or credentials across delta boundaries", async (t) => {
  const state = await fixture(t);
  const privatePath = state.input.authority.binding.codexHomeRealpath;
  // Release a delimiter to the generic credential redactor before completing
  // the private path. An ordinary per-delta replacement leaks this case.
  state.transport.assistantDeltas = ["Location ", privatePath.slice(0, 5), privatePath.slice(5),
    "; Key sk-", "abcdefghijklmnopqrstuvwxyz123456", " done."];
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "completed");
  const visible = state.events.filter((event) => event.type === "text").map((event) => event.text).join("");
  assert.equal(visible.includes(privatePath), false);
  assert.equal(visible.includes(privatePath.split("/providers/")[0]!), false);
  assert.equal(visible.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(result.text.includes(privatePath), false);
});

test("every split boundary of exact private authority values is redacted before public streaming", async (t) => {
  const state = await fixture(t);
  const binding = state.input.authority.binding;
  const privateValues = [state.appHome, binding.codexHomeRealpath, binding.profileId, binding.route.accountFingerprint];
  state.transport.assistantDeltas = (staging) => [...privateValues, staging].flatMap((value) =>
    Array.from({ length: value.length - 1 }, (_, index) =>
      ["Location ", value.slice(0, index + 1), value.slice(index + 1), " done.\n"]).flat());
  const result = await managed.runCodexManagedTurn(state.input);
  assert.equal(result.status, "completed", result.message);
  const visible = state.events.filter((event) => event.type === "text").map((event) => event.text).join("");
  for (const value of [...privateValues, state.transport.staging]) {
    assert.equal(visible.includes(value), false, "private authority value leaked in streaming");
    assert.equal(result.text.includes(value), false, "private authority value leaked in result");
  }
  assert.ok(visible.includes("Location [private] done."));
});
