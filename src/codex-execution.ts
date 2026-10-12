import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import { assertStagedAgentWorkspaceBoundary } from "./agent.js";
import {
  ApprovalManager,
  assertOrcodeApprovalPolicy,
} from "./approval.js";
import {
  CodexRouteGate,
  type CodexOperationAuthority,
  type CodexRouteBinding,
} from "./codex-route-gate.js";
import {
  CodexStagingWorkspace,
  createCodexStagingWorkspace,
  publishExactStagedEffects,
} from "./codex-staging-workspace.js";
import { CodexApprovalBridge } from "./codex-approval-bridge.js";
import { assertCodexHomePolicy, requireOwnedLocalDirectory } from "./codex-profile.js";
import type { ApprovalMode } from "./types.js";
import { ChangeJournal, WorkspaceGuard } from "./workspace.js";
import {
  CodexAppServerClient,
} from "./codex-app-server.js";

export type CodexSandboxPlan = Readonly<{
  thread: "read-only";
  turn: Readonly<{
    type: "readOnly";
    networkAccess: false;
  }>;
}> | Readonly<{
  thread: "workspace-write";
  turn: Readonly<{
    type: "workspaceWrite";
    writableRoots: readonly [string];
    networkAccess: false;
    excludeSlashTmp: true;
    excludeTmpdirEnvVar: true;
  }>;
}>;

export interface CodexExecutionInput {
  readonly appHome: string;
  readonly workspace: WorkspaceGuard;
  readonly approvals: ApprovalManager;
  readonly journal: ChangeJournal;
  readonly routeGate: CodexRouteGate;
  readonly routeBinding: CodexRouteBinding;
}

export interface PreparedCodexExecution {
  readonly realWorkspace: WorkspaceGuard;
  readonly staging: CodexStagingWorkspace;
  readonly sandbox: CodexSandboxPlan;
  readonly approvalPolicy: "untrusted";
  readonly approvalsReviewer: "user";
  readonly approvals: ApprovalManager;
  readonly journal: ChangeJournal;
  readonly routeGate: CodexRouteGate;
  readonly routeBinding: CodexRouteBinding;
}

export interface CodexTurnExecutionInput {
  readonly prepared: PreparedCodexExecution;
  readonly client: CodexAppServerClient;
  readonly childGeneration: number;
  readonly task: string;
  readonly signal?: AbortSignal;
  /** Receives only validated, operation-correlated notifications. */
  readonly onNotification?: (event: Readonly<{ type: string; params: Readonly<Record<string, unknown>> }>) => void;
}

export class CodexOperationJournal {
  readonly threadId: string;
  readonly turnId: string;
  readonly childGeneration: number;
  readonly routeDigest: string;
  readonly authority: CodexOperationAuthority;
  #bridge: CodexApprovalBridge | null = null;
  readonly #events: Array<Readonly<{ type: string; itemId?: string }>> = [];
  readonly #items = new Set<string>();
  readonly #detachNotifications: Array<() => void> = [];
  #notificationDelivery: Promise<void> = Promise.resolve();
  #settled = false;
  readonly #onNotification: CodexTurnExecutionInput["onNotification"];
  constructor(input: {
    threadId: string; turnId: string; childGeneration: number;
    routeDigest: string; authority: CodexOperationAuthority;
    onNotification?: CodexTurnExecutionInput["onNotification"];
  }) {
    Object.assign(this, input);
    this.threadId = input.threadId;
    this.turnId = input.turnId;
    this.childGeneration = input.childGeneration;
    this.routeDigest = input.routeDigest;
    this.authority = input.authority;
    this.#onNotification = input.onNotification;
  }
  settle(): void {
    if (this.#settled) throw new Error("Codex operation was already settled.");
    this.#settled = true;
    for (const detach of this.#detachNotifications.splice(0)) detach();
  }
  get settled(): boolean { return this.#settled; }
  bindApprovalBridge(prepared: PreparedCodexExecution, deadlineAt: number, signal?: AbortSignal,
    deferRequests = false): CodexApprovalBridge {
    if (this.#settled || this.#bridge !== null) throw new Error("Codex operation bridge was already bound or settled.");
    this.#bridge = new CodexApprovalBridge({
      threadId: this.threadId,
      turnId: this.turnId,
      childGeneration: this.childGeneration,
      deadlineAt,
      staging: prepared.staging,
      approvals: prepared.approvals,
      routeDigest: this.routeDigest,
      operationAuthority: this.authority,
      deferRequests,
      isCurrentGeneration: (generation) => prepared.routeGate.isCurrentChildGeneration(generation),
      onApproval: (itemId) => {
        if (this.#settled) throw new Error("Late Codex approval rejected after settlement.");
        this.#events.push(Object.freeze({ type: "approval", itemId }));
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return this.#bridge;
  }
  get approvalBridge(): CodexApprovalBridge | null { return this.#bridge; }
  get events(): readonly Readonly<{ type: string; itemId?: string }>[] { return Object.freeze([...this.#events]); }
  attachNotifications(client: CodexAppServerClient,
    initial: readonly Readonly<{ method: string; params: unknown }>[] = []): Promise<void> {
    if (this.#detachNotifications.length !== 0) throw new Error("Codex notifications already attached.");
    // Queue the entire early backlog before attaching live delivery. Awaiting
    // each early frame after attachment lets live deltas overtake the backlog.
    const enqueue = (notification: Readonly<{ method: string; params: unknown }>) => {
      this.#notificationDelivery = this.#notificationDelivery.then(() => this.recordNotification(notification));
      return this.#notificationDelivery;
    };
    for (const notification of initial) enqueue(notification);
    const replay = this.#notificationDelivery;
    for (const method of OPERATION_NOTIFICATION_METHODS) {
      this.#detachNotifications.push(client.onNotification(method, (params) =>
        enqueue({ method, params })));
    }
    return replay;
  }
  async recordNotification(value: unknown): Promise<void> {
    if (this.#settled) throw new Error("Late Codex notification rejected after settlement.");
    const event = translateCodexNotification(value);
    const params = event.params as Record<string, unknown>;
    const eventThreadId = params.threadId;
    const eventTurnId = isPlainRecord(params.turn) ? params.turn.id : params.turnId;
    if (eventThreadId !== this.threadId || eventTurnId !== this.turnId) {
      throw new Error("Codex notification does not match the active operation.");
    }
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    if (itemId && event.type !== "assistant-text") {
      const key = `${event.type}:${itemId}`;
      if (this.#items.has(key)) throw new Error("Repeated Codex operation item rejected.");
      this.#items.add(key);
    }
    if (event.type === "patch-preview") {
      if (this.#bridge === null || !Array.isArray(params.changes)) throw new Error("Codex patch notification is invalid.");
      await this.#bridge.observePatchUpdated({ threadId: this.threadId, turnId: this.turnId,
        itemId: itemId ?? "", changes: params.changes as never });
    }
    this.#events.push(Object.freeze({ type: event.type, ...(itemId === undefined ? {} : { itemId }) }));
    this.#onNotification?.(Object.freeze({ type: event.type, params }));
  }
  async publishApproved(prepared: PreparedCodexExecution, runId: string): Promise<readonly string[]> {
    if (this.#settled || this.#bridge === null) throw new Error("Codex operation is not active.");
    // The client is drained before managed publication. Preserve any queued
    // observer failure that settled while its read pump was already closing.
    await this.#notificationDelivery;
    const result = await publishExactStagedEffects({
      staging: prepared.staging,
      previews: this.#bridge.approvedPreviews,
      realWorkspace: prepared.realWorkspace,
      journal: prepared.journal,
      runId,
    });
    this.settle();
    return result.publishedPaths;
  }
}

export async function startCodexThread(
  prepared: PreparedCodexExecution,
  client: CodexAppServerClient,
  signal?: AbortSignal,
): Promise<string> {
  if (!(client instanceof CodexAppServerClient) || !prepared.staging.active) {
    throw new Error("A ready Codex client and active prepared execution are required.");
  }
  const params = exactThreadStartParams(prepared);
  const response = await client.request<unknown>("thread/start", params, signal);
  if (!isOfficialThreadStartResponse(response)
    || response.cwd !== params.cwd || response.model !== params.model
    || response.approvalPolicy !== params.approvalPolicy
    || response.approvalsReviewer !== params.approvalsReviewer
    || response.thread.cwd !== params.cwd || response.thread.ephemeral !== true
    || response.thread.modelProvider !== response.modelProvider || response.thread.turns.length !== 0
    || !matchesRequestedThreadSandbox(response.sandbox, params.sandbox, params.cwd)) {
    throw new Error("Codex thread/start response is invalid.");
  }
  return response.thread.id;
}

function matchesRequestedThreadSandbox(
  sandbox: Record<string, any>,
  requested: "read-only" | "workspace-write",
  stagingPath: string,
): boolean {
  if (requested === "read-only") {
    return sandbox.type === "readOnly" && sandbox.networkAccess === false;
  }
  return sandbox.type === "workspaceWrite" && sandbox.networkAccess === false
    && sandbox.excludeTmpdirEnvVar === true && sandbox.excludeSlashTmp === true
    && (sandbox.writableRoots as unknown[]).every((root) => root === stagingPath);
}

export function exactThreadStartParams(prepared: PreparedCodexExecution) {
  if (!prepared.staging.active) throw new Error("A current staging workspace is required.");
  return Object.freeze({
    cwd: prepared.staging.canonicalPath,
    model: prepared.routeBinding.modelId,
    ephemeral: true,
    sandbox: prepared.sandbox.thread,
    approvalPolicy: prepared.approvalPolicy,
    approvalsReviewer: prepared.approvalsReviewer,
  });
}

export async function startCodexTurn(input: CodexTurnExecutionInput): Promise<CodexOperationJournal> {
  if (!input || typeof input !== "object" || !(input.client instanceof CodexAppServerClient)
    || !Number.isSafeInteger(input.childGeneration) || input.childGeneration < 0
    || typeof input.task !== "string" || input.task.length === 0 || /\0/.test(input.task)) {
    throw new Error("Codex turn execution input is invalid.");
  }
  let approvalBridge: CodexApprovalBridge | null = null;
  try {
  const threadId = await startCodexThread(input.prepared, input.client, input.signal);
  const permit = await input.prepared.routeGate.refreshAndIssueDispatchPermit(
    input.prepared.routeBinding,
    input.signal,
  );
  const routeDigest = digestCodexRoute(input.prepared.routeBinding);
  const params = Object.freeze({
    threadId,
    input: Object.freeze([{ type: "text", text: input.task, text_elements: Object.freeze([]) }]),
    cwd: input.prepared.staging.canonicalPath,
    model: input.prepared.routeBinding.modelId,
    sandboxPolicy: input.prepared.sandbox.turn,
    approvalPolicy: input.prepared.approvalPolicy,
    approvalsReviewer: input.prepared.approvalsReviewer,
  });
  const pendingNotifications: Array<{ method: string; params: unknown }> = [];
  const pendingDetachers = OPERATION_NOTIFICATION_METHODS.map((method) =>
    input.client.onNotification(method, (notificationParams) => {
      pendingNotifications.push({ method, params: notificationParams });
    }));
  let turn;
  try {
    turn = await input.prepared.routeGate.consumeAndWriteTurn(
      permit, input.client, input.prepared.routeBinding, params,
      { childGeneration: input.childGeneration, threadId,
        stagingRealpath: input.prepared.staging.canonicalPath, routeDigest },
      input.signal,
    );
  } catch (error) {
    for (const detach of pendingDetachers) detach();
    throw error;
  }
  if (!isPlainRecord(turn.result) || !exactDataKeys(turn.result, ["turn"])
    || !isOfficialTurn(turn.result.turn)) {
    for (const detach of pendingDetachers) detach();
    throw new Error("Codex turn/start response is invalid.");
  }
  const turnId = turn.result.turn.id as string;
  const journal = new CodexOperationJournal({
    threadId, turnId, childGeneration: input.childGeneration,
    routeDigest, authority: turn.authority,
    ...(input.onNotification ? { onNotification: input.onNotification } : {}),
  });
  for (const detach of pendingDetachers) detach();
  approvalBridge = journal.bindApprovalBridge(input.prepared, Date.now() + 30 * 60_000, input.signal, true);
  await journal.attachNotifications(input.client, pendingNotifications);
  approvalBridge.activateRequests();
  return journal;
  } catch (error) {
    let drainProven = false;
    try {
      const drained = await input.client.drain();
      drainProven = drained === "closed" || drained === "killed";
      await approvalBridge?.waitForCleanup();
    } finally {
      if (drainProven && input.prepared.staging.active) await input.prepared.staging.discard();
    }
    throw error;
  }
}

export function translateCodexNotification(value: unknown): Readonly<{ type: string; [key: string]: unknown }> {
  if (!isPlainRecord(value) || typeof value.method !== "string" || !isPlainRecord(value.params)) {
    throw new Error("Codex notification is invalid.");
  }
  const types: Readonly<Record<string, string>> = Object.freeze({
    "thread/started": "thread-start",
    "turn/started": "turn-start",
    "item/agentMessage/delta": "assistant-text",
    "item/started": "tool-start",
    "item/fileChange/patchUpdated": "patch-preview",
    "item/completed": "file-change",
    "turn/completed": "run-end",
    "error": "error",
  });
  const type = types[value.method];
  if (!type) throw new Error("Unsupported Codex notification.");
  const params = validateOfficialNotification(value.method, value.params);
  return Object.freeze({ type, params });
}

const OPERATION_NOTIFICATION_METHODS = Object.freeze([
  "turn/started", "item/started", "item/completed",
  "item/agentMessage/delta", "item/fileChange/patchUpdated", "turn/completed", "error",
]);

function validateOfficialNotification(method: string, params: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const schemas: Record<string, readonly string[]> = {
    "thread/started": ["thread"], "turn/started": ["threadId", "turn"],
    "item/started": ["item", "threadId", "turnId", "startedAtMs"],
    "item/completed": ["item", "threadId", "turnId", "completedAtMs"],
    "item/agentMessage/delta": ["threadId", "turnId", "itemId", "delta"],
    "item/fileChange/patchUpdated": ["threadId", "turnId", "itemId", "changes"],
    "turn/completed": ["threadId", "turn"],
    "error": ["error", "willRetry", "threadId", "turnId"],
  };
  if (!exactDataKeys(params, schemas[method] ?? [])) throw new Error("Codex notification schema is invalid.");
  if (method === "thread/started") {
    if (!isOfficialThread(params.thread)) throw new Error("Codex thread notification is invalid.");
  } else if (method === "turn/started" || method === "turn/completed") {
    if (!boundedText(params.threadId) || !isOfficialTurn(params.turn)) throw new Error("Codex turn notification is invalid.");
  } else {
    if (!boundedText(params.threadId) || !boundedText(params.turnId)) throw new Error("Codex notification scope is invalid.");
  }
  if ((method === "item/started" || method === "item/completed")
    && (!isPlainRecord(params.item) || !boundedText(params.item.id)
      || !Number.isSafeInteger(params[method === "item/started" ? "startedAtMs" : "completedAtMs"]))) {
    throw new Error("Codex item notification is invalid.");
  }
  if (method === "item/agentMessage/delta"
    && (!boundedText(params.itemId) || typeof params.delta !== "string")) throw new Error("Codex delta notification is invalid.");
  if (method === "item/fileChange/patchUpdated") {
    if (!boundedText(params.itemId) || !Array.isArray(params.changes) || params.changes.length === 0) {
      throw new Error("Codex patch notification is invalid.");
    }
    const changes = params.changes.map(normalizeFileUpdateChange);
    return Object.freeze({ ...params, changes: Object.freeze(changes) });
  }
  if (method === "error" && (!isPlainRecord(params.error) || typeof params.willRetry !== "boolean")) {
    throw new Error("Codex error notification is invalid.");
  }
  return Object.freeze({ ...params });
}

function normalizeFileUpdateChange(value: unknown) {
  if (!isPlainRecord(value) || !exactDataKeys(value, ["path", "kind", "diff"])
    || !boundedText(value.path) || typeof value.diff !== "string" || !isPlainRecord(value.kind)) {
    throw new Error("Codex file update change is invalid.");
  }
  if (exactDataKeys(value.kind, ["type"])
    && (value.kind.type === "add" || value.kind.type === "delete")) {
    return Object.freeze({ path: value.path, kind: value.kind.type, diff: value.diff });
  }
  if (exactDataKeys(value.kind, ["type", "move_path"]) && value.kind.type === "update"
    && value.kind.move_path === null) {
    return Object.freeze({ path: value.path, kind: "update", diff: value.diff });
  }
  throw new Error("Codex file move authority is unsupported.");
}

function isOfficialThreadStartResponse(value: unknown): value is Record<string, any> {
  return isPlainRecord(value) && exactDataKeys(value, ["thread", "model", "modelProvider", "serviceTier", "cwd",
    "instructionSources", "approvalPolicy", "approvalsReviewer", "sandbox", "reasoningEffort"])
    && isOfficialThread(value.thread) && boundedText(value.model) && boundedText(value.modelProvider)
    && nullableBoundedString(value.serviceTier) && absolutePath(value.cwd)
    && boundedArray(value.instructionSources, (entry) => boundedString(entry))
    && isOfficialApprovalPolicy(value.approvalPolicy)
    && ["user", "auto_review", "guardian_subagent"].includes(value.approvalsReviewer as string)
    && isOfficialSandboxPolicy(value.sandbox)
    && nullableBoundedString(value.reasoningEffort);
}

function isOfficialThread(value: unknown): value is Record<string, any> {
  return isPlainRecord(value) && exactDataKeys(value, ["id", "sessionId", "forkedFromId", "parentThreadId", "preview",
    "ephemeral", "modelProvider", "createdAt", "updatedAt", "recencyAt", "status", "path", "cwd", "cliVersion",
    "source", "threadSource", "agentNickname", "agentRole", "gitInfo", "name", "turns"])
    && boundedText(value.id) && boundedText(value.sessionId) && boundedText(value.modelProvider)
    && nullableBoundedText(value.forkedFromId) && nullableBoundedText(value.parentThreadId)
    && boundedString(value.preview) && typeof value.ephemeral === "boolean"
    && nonNegativeFiniteNumber(value.createdAt) && nonNegativeFiniteNumber(value.updatedAt)
    && nullableNonNegativeFiniteNumber(value.recencyAt) && isOfficialThreadStatus(value.status)
    && nullableBoundedString(value.path) && absolutePath(value.cwd) && boundedText(value.cliVersion)
    && isOfficialSessionSource(value.source) && nullableBoundedString(value.threadSource)
    && nullableBoundedString(value.agentNickname) && nullableBoundedString(value.agentRole)
    && isOfficialGitInfo(value.gitInfo) && nullableBoundedString(value.name)
    && boundedArray(value.turns, isOfficialTurn);
}

export function isOfficialTurn(value: unknown): value is Record<string, any> {
  return isPlainRecord(value) && exactDataKeys(value, ["id", "items", "itemsView", "status", "error",
    "startedAt", "completedAt", "durationMs"]) && boundedText(value.id)
    && boundedArray(value.items, isOfficialThreadItem)
    && ["notLoaded", "summary", "full"].includes(value.itemsView as string)
    && ["completed", "interrupted", "failed", "inProgress"].includes(value.status as string)
    && (value.error === null || isOfficialTurnError(value.error))
    && nullableNonNegativeFiniteNumber(value.startedAt)
    && nullableNonNegativeFiniteNumber(value.completedAt)
    && nullableNonNegativeFiniteNumber(value.durationMs);
}

function isOfficialThreadStatus(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (["notLoaded", "idle", "systemError"].includes(value.type)) {
    return exactDataKeys(value, ["type"]);
  }
  return value.type === "active" && exactDataKeys(value, ["type", "activeFlags"])
    && boundedArray(value.activeFlags, (flag) =>
      flag === "waitingOnApproval" || flag === "waitingOnUserInput");
}

function isOfficialSessionSource(value: unknown): boolean {
  if (["cli", "vscode", "exec", "appServer", "unknown"].includes(value as string)) return true;
  if (!isPlainRecord(value)) return false;
  if (exactDataKeys(value, ["custom"])) return boundedString(value.custom);
  return exactDataKeys(value, ["subAgent"]) && isOfficialSubAgentSource(value.subAgent);
}

function isOfficialSubAgentSource(value: unknown): boolean {
  if (["review", "compact", "memory_consolidation"].includes(value as string)) return true;
  if (!isPlainRecord(value)) return false;
  if (exactDataKeys(value, ["other"])) return boundedString(value.other);
  if (!exactDataKeys(value, ["thread_spawn"]) || !isPlainRecord(value.thread_spawn)
    || !exactDataKeys(value.thread_spawn, [
      "parent_thread_id", "depth", "agent_path", "agent_nickname", "agent_role",
    ])) return false;
  return boundedText(value.thread_spawn.parent_thread_id)
    && Number.isSafeInteger(value.thread_spawn.depth) && (value.thread_spawn.depth as number) >= 0
    && nullableBoundedString(value.thread_spawn.agent_path)
    && nullableBoundedString(value.thread_spawn.agent_nickname)
    && nullableBoundedString(value.thread_spawn.agent_role);
}

function isOfficialGitInfo(value: unknown): boolean {
  return value === null || isPlainRecord(value) && exactDataKeys(value, ["sha", "branch", "originUrl"])
    && nullableBoundedString(value.sha) && nullableBoundedString(value.branch)
    && nullableBoundedString(value.originUrl);
}

function isOfficialApprovalPolicy(value: unknown): boolean {
  if (["untrusted", "on-failure", "on-request", "never"].includes(value as string)) return true;
  if (!isPlainRecord(value) || !exactDataKeys(value, ["granular"]) || !isPlainRecord(value.granular)
    || !exactDataKeys(value.granular, [
      "sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations",
    ])) return false;
  return Object.values(value.granular).every((entry) => typeof entry === "boolean");
}

function isOfficialSandboxPolicy(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "dangerFullAccess") return exactDataKeys(value, ["type"]);
  if (value.type === "readOnly") {
    return exactDataKeys(value, ["type", "networkAccess"])
      && typeof value.networkAccess === "boolean";
  }
  if (value.type === "externalSandbox") {
    return exactDataKeys(value, ["type", "networkAccess"])
      && (value.networkAccess === "restricted" || value.networkAccess === "enabled");
  }
  return value.type === "workspaceWrite"
    && exactDataKeys(value, [
      "type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp",
    ])
    && boundedArray(value.writableRoots, absolutePath)
    && typeof value.networkAccess === "boolean"
    && typeof value.excludeTmpdirEnvVar === "boolean"
    && typeof value.excludeSlashTmp === "boolean";
}

function isOfficialTurnError(value: unknown): boolean {
  return isPlainRecord(value) && exactDataKeys(value, ["message", "codexErrorInfo", "additionalDetails"])
    && boundedString(value.message) && isOfficialCodexErrorInfo(value.codexErrorInfo)
    && nullableBoundedString(value.additionalDetails);
}

function isOfficialCodexErrorInfo(value: unknown): boolean {
  if (value === null) return true;
  if ([
    "contextWindowExceeded", "usageLimitExceeded", "serverOverloaded", "cyberPolicy",
    "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed",
    "sandboxError", "other",
  ].includes(value as string)) return true;
  if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== 1) return false;
  const connectionKinds = [
    "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ];
  const kind = Object.keys(value)[0]!;
  if (connectionKinds.includes(kind)) {
    const detail = value[kind];
    return isPlainRecord(detail) && exactDataKeys(detail, ["httpStatusCode"])
      && (detail.httpStatusCode === null
        || Number.isSafeInteger(detail.httpStatusCode) && (detail.httpStatusCode as number) >= 100);
  }
  if (kind === "activeTurnNotSteerable") {
    const detail = value[kind];
    return isPlainRecord(detail) && exactDataKeys(detail, ["turnKind"])
      && (detail.turnKind === "review" || detail.turnKind === "compact");
  }
  return false;
}

const THREAD_ITEM_KEYS: Readonly<Record<string, Readonly<{
  required: readonly string[];
  optional?: readonly string[];
}>>> = Object.freeze({
  userMessage: { required: ["type", "id", "clientId", "content"] },
  hookPrompt: { required: ["type", "id", "fragments"] },
  agentMessage: { required: ["type", "id", "text", "phase", "memoryCitation"] },
  plan: { required: ["type", "id", "text"] },
  reasoning: { required: ["type", "id", "summary", "content"] },
  commandExecution: { required: ["type", "id", "command", "cwd", "processId", "source", "status",
    "commandActions", "aggregatedOutput", "exitCode", "durationMs"] },
  fileChange: { required: ["type", "id", "changes", "status"] },
  mcpToolCall: { required: ["type", "id", "server", "tool", "status", "arguments", "appContext",
    "pluginId", "result", "error", "durationMs"], optional: ["mcpAppResourceUri"] },
  dynamicToolCall: { required: ["type", "id", "namespace", "tool", "arguments", "status",
    "contentItems", "success", "durationMs"] },
  collabAgentToolCall: { required: ["type", "id", "tool", "status", "senderThreadId", "receiverThreadIds",
    "prompt", "model", "reasoningEffort", "agentsStates"] },
  subAgentActivity: { required: ["type", "id", "kind", "agentThreadId", "agentPath"] },
  webSearch: { required: ["type", "id", "query", "action"] },
  imageView: { required: ["type", "id", "path"] },
  sleep: { required: ["type", "id", "durationMs"] },
  imageGeneration: { required: ["type", "id", "status", "revisedPrompt", "result"], optional: ["savedPath"] },
  enteredReviewMode: { required: ["type", "id", "review"] },
  exitedReviewMode: { required: ["type", "id", "review"] },
  contextCompaction: { required: ["type", "id"] },
});

function isOfficialThreadItem(value: unknown): boolean {
  if (!isPlainRecord(value) || !boundedText(value.type) || !boundedText(value.id)) return false;
  const schema = THREAD_ITEM_KEYS[value.type];
  if (schema === undefined || !exactOptionalDataKeys(value, schema.required, schema.optional ?? [])) return false;
  if (!isJsonData(value)) return false;
  switch (value.type) {
    case "userMessage":
      return nullableBoundedString(value.clientId)
        && boundedArray(value.content, isOfficialUserInput);
    case "hookPrompt":
      return boundedArray(value.fragments, (entry) => isPlainRecord(entry)
        && exactDataKeys(entry, ["text", "hookRunId"])
        && boundedString(entry.text) && boundedText(entry.hookRunId));
    case "agentMessage":
      return boundedString(value.text)
        && (value.phase === null || value.phase === "commentary" || value.phase === "final_answer")
        && (value.memoryCitation === null || isOfficialMemoryCitation(value.memoryCitation));
    case "plan":
      return boundedString(value.text);
    case "reasoning":
      return boundedArray(value.summary, boundedString) && boundedArray(value.content, boundedString);
    case "commandExecution":
      return boundedString(value.command) && boundedString(value.cwd)
        && nullableBoundedString(value.processId)
        && ["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"].includes(value.source as string)
        && ["inProgress", "completed", "failed", "declined"].includes(value.status as string)
        && boundedArray(value.commandActions, isOfficialCommandAction)
        && nullableBoundedString(value.aggregatedOutput) && nullableInteger(value.exitCode)
        && nullableNonNegativeFiniteNumber(value.durationMs);
    case "fileChange":
      return boundedArray(value.changes, isOfficialFileUpdateChange)
        && ["inProgress", "completed", "failed", "declined"].includes(value.status as string);
    case "mcpToolCall":
      return boundedText(value.server) && boundedText(value.tool)
        && ["inProgress", "completed", "failed"].includes(value.status as string)
        && isJsonData(value.arguments)
        && (value.appContext === null || isOfficialMcpAppContext(value.appContext))
        && (!Object.hasOwn(value, "mcpAppResourceUri") || boundedString(value.mcpAppResourceUri))
        && nullableBoundedString(value.pluginId)
        && (value.result === null || isOfficialMcpResult(value.result))
        && (value.error === null || isPlainRecord(value.error)
          && exactDataKeys(value.error, ["message"]) && boundedString(value.error.message))
        && nullableNonNegativeFiniteNumber(value.durationMs);
    case "dynamicToolCall":
      return nullableBoundedString(value.namespace) && boundedText(value.tool)
        && isJsonData(value.arguments)
        && ["inProgress", "completed", "failed"].includes(value.status as string)
        && (value.contentItems === null
          || boundedArray(value.contentItems, isOfficialDynamicContentItem))
        && (value.success === null || typeof value.success === "boolean")
        && nullableNonNegativeFiniteNumber(value.durationMs);
    case "collabAgentToolCall":
      return ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"].includes(value.tool as string)
        && ["inProgress", "completed", "failed"].includes(value.status as string)
        && boundedText(value.senderThreadId) && boundedArray(value.receiverThreadIds, boundedText)
        && nullableBoundedString(value.prompt) && nullableBoundedString(value.model)
        && nullableBoundedString(value.reasoningEffort)
        && isOfficialCollabAgentStates(value.agentsStates);
    case "subAgentActivity":
      return ["started", "interacted", "interrupted"].includes(value.kind as string)
        && boundedText(value.agentThreadId) && boundedText(value.agentPath);
    case "webSearch":
      return boundedString(value.query) && (value.action === null || isOfficialWebSearchAction(value.action));
    case "imageView":
      return absolutePath(value.path);
    case "sleep":
      return nonNegativeFiniteNumber(value.durationMs);
    case "imageGeneration":
      return boundedString(value.status) && nullableBoundedString(value.revisedPrompt)
        && boundedString(value.result)
        && (!Object.hasOwn(value, "savedPath") || absolutePath(value.savedPath));
    case "enteredReviewMode":
    case "exitedReviewMode":
      return boundedString(value.review);
    case "contextCompaction":
      return true;
    default:
      return false;
  }
}

function isOfficialUserInput(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") {
    return exactDataKeys(value, ["type", "text", "text_elements"])
      && boundedString(value.text) && boundedArray(value.text_elements, isOfficialTextElement);
  }
  if (value.type === "image" || value.type === "localImage") {
    const contentKey = value.type === "image" ? "url" : "path";
    return exactOptionalDataKeys(value, ["type", contentKey], ["detail"])
      && boundedString(value[contentKey])
      && (!Object.hasOwn(value, "detail")
        || ["auto", "low", "high", "original"].includes(value.detail as string));
  }
  return (value.type === "skill" || value.type === "mention")
    && exactDataKeys(value, ["type", "name", "path"])
    && boundedText(value.name) && boundedString(value.path);
}

function isOfficialTextElement(value: unknown): boolean {
  return isPlainRecord(value) && exactDataKeys(value, ["byteRange", "placeholder"])
    && isPlainRecord(value.byteRange) && exactDataKeys(value.byteRange, ["start", "end"])
    && Number.isSafeInteger(value.byteRange.start) && (value.byteRange.start as number) >= 0
    && Number.isSafeInteger(value.byteRange.end)
    && (value.byteRange.end as number) >= (value.byteRange.start as number)
    && nullableBoundedString(value.placeholder);
}

function isOfficialMemoryCitation(value: unknown): boolean {
  return isPlainRecord(value) && exactDataKeys(value, ["entries", "threadIds"])
    && boundedArray(value.entries, (entry) => isPlainRecord(entry)
      && exactDataKeys(entry, ["path", "lineStart", "lineEnd", "note"])
      && boundedString(entry.path) && Number.isSafeInteger(entry.lineStart)
      && (entry.lineStart as number) >= 0 && Number.isSafeInteger(entry.lineEnd)
      && (entry.lineEnd as number) >= (entry.lineStart as number) && boundedString(entry.note))
    && boundedArray(value.threadIds, boundedText);
}

function isOfficialCommandAction(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string" || !boundedString(value.command)) return false;
  if (value.type === "read") {
    return exactDataKeys(value, ["type", "command", "name", "path"])
      && boundedString(value.name) && absolutePath(value.path);
  }
  if (value.type === "listFiles") {
    return exactDataKeys(value, ["type", "command", "path"])
      && nullableBoundedString(value.path);
  }
  if (value.type === "search") {
    return exactDataKeys(value, ["type", "command", "query", "path"])
      && nullableBoundedString(value.query) && nullableBoundedString(value.path);
  }
  return value.type === "unknown" && exactDataKeys(value, ["type", "command"]);
}

function isOfficialFileUpdateChange(value: unknown): boolean {
  if (!isPlainRecord(value) || !exactDataKeys(value, ["path", "kind", "diff"])
    || !boundedString(value.path) || !boundedString(value.diff) || !isPlainRecord(value.kind)) return false;
  if (value.kind.type === "add" || value.kind.type === "delete") {
    return exactDataKeys(value.kind, ["type"]);
  }
  return value.kind.type === "update" && exactDataKeys(value.kind, ["type", "move_path"])
    && nullableBoundedString(value.kind.move_path);
}

function isOfficialDynamicContentItem(value: unknown): boolean {
  return isPlainRecord(value) && (value.type === "inputText"
    ? exactDataKeys(value, ["type", "text"]) && boundedString(value.text)
    : value.type === "inputImage" && exactDataKeys(value, ["type", "imageUrl"])
      && boundedString(value.imageUrl));
}

function isOfficialCollabAgentStates(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4_096 || keys.some((key) => typeof key !== "string")) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const state = descriptor !== undefined && "value" in descriptor ? descriptor.value : null;
    return isPlainRecord(state) && exactDataKeys(state, ["status", "message"])
      && ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]
        .includes(state.status as string)
      && nullableBoundedString(state.message);
  });
}

function isOfficialMcpAppContext(value: unknown): boolean {
  return isPlainRecord(value) && exactDataKeys(value, ["connectorId", "linkId", "resourceUri"])
    && boundedText(value.connectorId) && nullableBoundedString(value.linkId)
    && nullableBoundedString(value.resourceUri);
}

function isOfficialMcpResult(value: unknown): boolean {
  return isPlainRecord(value) && exactDataKeys(value, ["content", "structuredContent", "_meta"])
    && boundedArray(value.content, (entry) => isJsonData(entry))
    && (value.structuredContent === null || isJsonData(value.structuredContent))
    && (value._meta === null || isJsonData(value._meta));
}

function isOfficialWebSearchAction(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "other") return exactDataKeys(value, ["type"]);
  if (value.type === "search") {
    return exactDataKeys(value, ["type", "query", "queries"])
      && nullableBoundedString(value.query)
      && (value.queries === null || boundedArray(value.queries, boundedString));
  }
  if (value.type === "openPage") {
    return exactDataKeys(value, ["type", "url"]) && nullableBoundedString(value.url);
  }
  return value.type === "findInPage" && exactDataKeys(value, ["type", "url", "pattern"])
    && nullableBoundedString(value.url) && nullableBoundedString(value.pattern);
}

function digestCodexRoute(binding: CodexRouteBinding): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

/**
 * Produces only the two bounded App Server sandbox shapes Orcode permits.
 * Even the owner's broadest local mode remains staging-only and offline.
 */
export function codexSandboxPlan(
  mode: ApprovalMode,
  staging: CodexStagingWorkspace,
): CodexSandboxPlan {
  assertApprovalMode(mode);
  if (!(staging instanceof CodexStagingWorkspace) || !staging.active) {
    throw new Error("A current Codex staging workspace is required for sandboxing.");
  }
  if (mode === "read-only") {
    return Object.freeze({
      thread: "read-only",
      turn: Object.freeze({ type: "readOnly", networkAccess: false }),
    });
  }
  return Object.freeze({
    thread: "workspace-write",
    turn: Object.freeze({
      type: "workspaceWrite",
      writableRoots: Object.freeze([staging.canonicalPath]) as readonly [string],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    }),
  });
}

/**
 * Finishes every local authority boundary before any App Server turn exists.
 * This function intentionally has no App Server/client argument and therefore
 * cannot send task bytes during preflight.
 */
export async function prepareCodexExecution(
  input: CodexExecutionInput,
): Promise<PreparedCodexExecution> {
  if (!isExactExecutionInput(input)) {
    throw new Error("Codex execution preparation has an unknown schema.");
  }
  if (!(input.workspace instanceof WorkspaceGuard)) {
    throw new Error("A verified workspace is required before Codex execution.");
  }
  assertOrcodeApprovalPolicy(input.approvals);
  if (!(input.journal instanceof ChangeJournal)) {
    throw new Error("A change journal is required before Codex execution.");
  }
  if (!(input.routeGate instanceof CodexRouteGate)) {
    throw new Error("A current Codex route gate is required before execution.");
  }
  const routeBinding = canonicalPreparedRouteBinding(input.routeBinding);
  await input.workspace.assertCurrent();
  const canonicalAppHome = await requireOwnedLocalDirectory(input.appHome, "Orcode app home");
  await assertCodexHomePolicy(routeBinding.codexHomeRealpath);
  assertProfileBelongsToAppHome(canonicalAppHome, routeBinding.codexHomeRealpath);
  const canonicalJournalHome = await requireOwnedLocalDirectory(
    input.journal.appHomeRoot,
    "Codex journal app home",
  );
  if (canonicalJournalHome !== canonicalAppHome) {
    throw new Error("The Codex change journal is not bound to the canonical app home.");
  }

  const staging = await createCodexStagingWorkspace({
    appHome: canonicalAppHome,
    realWorkspace: input.workspace,
  });
  try {
    await assertStagedAgentWorkspaceBoundary(input.workspace, staging.canonicalPath);
    const prepared: PreparedCodexExecution = {
      realWorkspace: input.workspace,
      staging,
      sandbox: codexSandboxPlan(input.approvals.mode, staging),
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      approvals: input.approvals,
      journal: input.journal,
      routeGate: input.routeGate,
      routeBinding,
    };
    return Object.freeze(prepared);
  } catch (error) {
    await staging.discard().catch(() => undefined);
    throw error;
  }
}

function assertProfileBelongsToAppHome(appHome: string, codexHome: string): void {
  const codexRoot = join(appHome, "providers", "codex");
  const normalizedHome = resolve(codexHome);
  const rel = relative(codexRoot, normalizedHome);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || rel.includes(sep) || !/^codex-[0-9a-f]{32}$/.test(basename(normalizedHome))) {
    throw new Error("The selected Codex profile home is not bound to this canonical app home.");
  }
}

function assertApprovalMode(value: unknown): asserts value is ApprovalMode {
  if (value !== "read-only" && value !== "ask"
    && value !== "auto-edit" && value !== "allow-all") {
    throw new Error("Codex sandbox mode is invalid.");
  }
}

function isExactExecutionInput(value: unknown): value is CodexExecutionInput {
  return isPlainRecord(value) && exactDataKeys(value, [
    "appHome", "workspace", "approvals", "journal", "routeGate", "routeBinding",
  ]) && typeof value.appHome === "string" && value.appHome.length > 0;
}

function canonicalPreparedRouteBinding(value: unknown): CodexRouteBinding {
  if (!isPlainRecord(value) || !exactDataKeys(value, [
    "profileId", "codexHomeRealpath", "route", "modelId",
  ]) || !boundedText(value.profileId) || !boundedText(value.modelId)
    || typeof value.codexHomeRealpath !== "string" || !isAbsolute(value.codexHomeRealpath)
    || !isPlainRecord(value.route) || !exactDataKeys(value.route, [
      "version", "backendId", "accountFingerprint", "billingRealm",
      "requestedModelId", "canonicalModelId", "resolutionState",
    ]) || value.route.version !== 1 || value.route.backendId !== "codex"
    || value.route.resolutionState !== "resolved"
    || !boundedText(value.route.accountFingerprint)
    || !boundedText(value.route.requestedModelId)
    || value.route.canonicalModelId !== value.modelId
    || (value.route.billingRealm !== "chatgpt-subscription-provider-managed-overage"
      && value.route.billingRealm !== "chatgpt-account-provider-managed-limits")) {
    throw new Error("The selected Codex route binding is invalid.");
  }
  return Object.freeze({
    profileId: value.profileId,
    codexHomeRealpath: value.codexHomeRealpath,
    route: Object.freeze({
      version: 1,
      backendId: "codex",
      accountFingerprint: value.route.accountFingerprint,
      billingRealm: value.route.billingRealm,
      requestedModelId: value.route.requestedModelId,
      canonicalModelId: value.route.canonicalModelId,
      resolutionState: "resolved",
    }),
    modelId: value.modelId,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) return false;
  const expectedSet = new Set(expected);
  return keys.every((key) => expectedSet.has(key as string))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
}

function exactOptionalDataKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key as string))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
}

function boundedArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is T[];
function boundedArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is unknown[];
function boundedArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is unknown[] {
  return Array.isArray(value) && value.length <= 4_096 && value.every(predicate);
}

function absolutePath(value: unknown): value is string {
  return boundedString(value) && isAbsolute(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 * 1_024 && !value.includes("\0");
}

function nullableBoundedString(value: unknown): value is string | null {
  return value === null || boundedString(value);
}

function nullableBoundedText(value: unknown): value is string | null {
  return value === null || boundedText(value);
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableNonNegativeFiniteNumber(value: unknown): value is number | null {
  return value === null || nonNegativeFiniteNumber(value);
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function isJsonData(value: unknown, depth = 0, budget = { remaining: 10_000 }): boolean {
  if (budget.remaining-- <= 0 || depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4_096 && value.every((entry) => isJsonData(entry, depth + 1, budget));
  }
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4_096 || keys.some((key) => typeof key !== "string")) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)
      || !isJsonData(descriptor.value, depth + 1, budget)) return false;
  }
  return true;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/.test(value);
}
