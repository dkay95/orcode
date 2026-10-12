import { isAbsolute, relative, sep } from "node:path";

import {
  ApprovalManager,
  authorizeOneShotApproval,
  type ApprovalRequest,
  type OneShotApprovalDecision,
} from "./approval.js";
import {
  claimCodexOperationAuthority,
  type ClaimedCodexOperation,
  type CodexOperationAuthority,
} from "./codex-route-gate.js";
import type { CodexAppServerRequestId } from "./codex-app-server.js";
import {
  approveCodexPatchPreview,
  assertCodexPatchPreviewCurrent,
  createCodexPatchApprovalBinding,
  createCodexPatchPreview,
  type CodexApprovedPatchPreview,
  type CodexPatchChange,
  type CodexPatchPreview,
  CodexStagingWorkspace,
} from "./codex-staging-workspace.js";
import { classifyPath } from "./policy.js";

const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const MAX_IDENTIFIER_BYTES = 4_096;
const MAX_COMMAND_BYTES = 128 * 1_024;
const MAX_REASON_BYTES = 32 * 1_024;

type JsonRpcId = CodexAppServerRequestId;

export interface CodexApprovalResponse {
  readonly decision: OneShotApprovalDecision;
}

export interface CodexPatchUpdatedObservation {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly changes: readonly CodexPatchChange[];
}

export interface CodexApprovalBridgeOptions {
  readonly threadId: string;
  readonly turnId: string;
  readonly childGeneration: number;
  readonly deadlineAt: number;
  readonly staging: CodexStagingWorkspace;
  readonly approvals: ApprovalManager;
  readonly routeDigest: string;
  readonly operationAuthority: CodexOperationAuthority;
  /** Turn startup replays earlier notifications before claiming queued requests. */
  readonly deferRequests?: boolean;
  readonly onApproval?: (itemId: string, decision: OneShotApprovalDecision) => void;
  /** Task 6 binds this callback to the currently-owned child generation. */
  readonly isCurrentGeneration?: (generation: number) => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

interface CommandApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly startedAtMs: number;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly reason?: string | null;
  readonly approvalId?: string | null;
  readonly environmentId: string | null;
  readonly networkApprovalContext?: unknown;
  readonly commandActions?: unknown;
  readonly proposedExecpolicyAmendment?: unknown;
  readonly proposedNetworkPolicyAmendments?: unknown;
}

interface FileApprovalParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly startedAtMs: number;
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
}

interface ParsedRequest<T> {
  readonly id: JsonRpcId;
  readonly params: T;
}

/**
 * One-turn adapter for the two stable Codex v2 approval requests. It never
 * returns reusable/session authority and closes on every protocol mismatch.
 */
export class CodexApprovalBridge {
  readonly #threadId: string;
  readonly #turnId: string;
  readonly #childGeneration: number;
  readonly #deadlineAt: number;
  readonly #staging: CodexStagingWorkspace;
  readonly #approvals: ApprovalManager;
  readonly #operation: ClaimedCodexOperation;
  #detachRequests: () => void = () => {};
  #requestsAttached = false;
  readonly #detachTerminal: () => void;
  readonly #isCurrentGeneration: NonNullable<CodexApprovalBridgeOptions["isCurrentGeneration"]>;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => number;
  readonly #onApproval: NonNullable<CodexApprovalBridgeOptions["onApproval"]>;
  readonly #seenRequestIds = new Set<string>();
  readonly #responseAttempts = new Set<string>();
  readonly #seenItems = new Set<string>();
  readonly #patches = new Map<string, Promise<CodexPatchPreview>>();
  readonly #undoPaths = new Set<string>();
  readonly #approved: CodexApprovedPatchPreview[] = [];
  #closed = false;
  #closing = false;
  #cleanupPromise: Promise<void> | null = null;
  #requestWork: Promise<void> = Promise.resolve();

  constructor(options: CodexApprovalBridgeOptions) {
    if (!options || typeof options !== "object"
      || Reflect.ownKeys(options).some((key) => key === "appServer" || key === "respond")
      || !safeIdentifier(options.threadId) || !safeIdentifier(options.turnId)
      || !Number.isSafeInteger(options.childGeneration) || options.childGeneration < 0
      || !Number.isFinite(options.deadlineAt)
      || !/^[0-9a-f]{64}$/.test(options.routeDigest)
      || !(options.staging instanceof CodexStagingWorkspace) || !options.staging.active
      || !(options.approvals instanceof ApprovalManager)
      || !options.operationAuthority || typeof options.operationAuthority !== "object"
      || (options.deferRequests !== undefined && typeof options.deferRequests !== "boolean")
      || (options.isCurrentGeneration !== undefined
        && typeof options.isCurrentGeneration !== "function")
      || (options.onApproval !== undefined && typeof options.onApproval !== "function")
      || (options.now !== undefined && typeof options.now !== "function")) {
      throw new Error("Codex approval bridge options are invalid.");
    }
    this.#threadId = options.threadId;
    this.#turnId = options.turnId;
    this.#childGeneration = options.childGeneration;
    this.#deadlineAt = options.deadlineAt;
    this.#staging = options.staging;
    this.#approvals = options.approvals;
    this.#operation = claimCodexOperationAuthority(options.operationAuthority, {
      childGeneration: options.childGeneration,
      threadId: options.threadId,
      turnId: options.turnId,
      stagingRealpath: options.staging.canonicalPath,
      routeDigest: options.routeDigest,
    });
    this.#isCurrentGeneration = options.isCurrentGeneration ?? (() => true);
    this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
    this.#onApproval = options.onApproval ?? (() => {});
    this.#detachTerminal = this.#operation.onTerminal(() => {
      this.#closeAfterNotification("Codex App Server closed before the operation settled.");
    });
    try {
      if (!options.deferRequests) this.activateRequests();
    } catch (error) {
      this.#detachTerminal();
      throw error;
    }
  }

  activateRequests(): void {
    this.#assertOpen();
    if (this.#requestsAttached) throw new Error("Codex approval requests were already attached.");
    this.#detachRequests = this.#operation.onRequest((request) => {
      const work = this.handleServerRequest(request);
      this.#requestWork = work;
      return work;
    });
    this.#requestsAttached = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get childGeneration(): number {
    return this.#childGeneration;
  }

  get stagedUndoPaths(): readonly string[] {
    return Object.freeze([...this.#undoPaths].sort((left, right) => left.localeCompare(right)));
  }

  get approvedPreviews(): readonly CodexApprovedPatchPreview[] {
    return Object.freeze([...this.#approved]);
  }

  waitForCleanup(): Promise<void> {
    return this.#cleanupPromise ?? Promise.resolve();
  }

  /**
   * Freeze completed-turn authority before inspecting/publishing its effects.
   * Unlike cancellation, successful drain preserves staging for exact publish.
   * The caller must have observed the correlated successful terminal event.
   */
  async completeAndDrain(): Promise<void> {
    this.#assertOpen();
    await this.#requestWork;
    if (!this.#isCurrent()) throw new Error("Codex completion authority is stale.");
    this.#closing = true;
    this.#detachRequests();
    this.#detachTerminal();
    this.#cleanupPromise = (async () => {
      const drained = await this.#operation.drain();
      if (drained !== "closed" && drained !== "killed") {
        throw new Error("Codex completion did not prove child drain.");
      }
      this.#closed = true;
    })();
    await this.#cleanupPromise;
  }

  async cancelAndDrain(): Promise<void> {
    this.#assertOpen();
    const interrupt = this.#operation.interrupt();
    const cleanup = this.#closeForViolation("Codex operation was cancelled by the owner.");
    const [interruptResult, cleanupResult] = await Promise.allSettled([interrupt, cleanup]);
    const interruptFailure = interruptResult.status === "rejected"
      && !isExpectedInterruptDrain(interruptResult.reason)
      ? interruptResult.reason
      : null;
    if (interruptFailure !== null && cleanupResult.status === "rejected") {
      throw new AggregateError(
        [interruptFailure, cleanupResult.reason],
        "Codex cancellation interrupt and cleanup both failed.",
      );
    }
    if (cleanupResult.status === "rejected") throw cleanupResult.reason;
    if (interruptFailure !== null) throw interruptFailure;
  }

  /** Records only a complete, exact patch notification for this turn. */
  async observePatchUpdated(observation: CodexPatchUpdatedObservation): Promise<void> {
    this.#assertOpen();
    if (!this.#isCurrent()) {
      this.#closeAfterNotification("Codex patch notification is stale.");
      throw new Error("Codex patch notification is stale.");
    }
    if (!isExactPatchObservation(observation)
      || observation.threadId !== this.#threadId
      || observation.turnId !== this.#turnId
      || this.#patches.has(observation.itemId)) {
      this.#closeAfterNotification("Codex patch notification violates the current turn schema.");
      throw new Error("Codex patch notification is stale, duplicate, or invalid.");
    }
    const previewPromise = createCodexPatchPreview({
      staging: this.#staging,
      threadId: observation.threadId,
      turnId: observation.turnId,
      itemId: observation.itemId,
      childGeneration: this.#childGeneration,
      changes: observation.changes,
    });
    this.#patches.set(observation.itemId, previewPromise);
    try {
      const preview = await previewPromise;
      for (const change of preview.changes) this.#undoPaths.add(change.path);
    } catch (error) {
      this.#patches.delete(observation.itemId);
      this.#closeAfterNotification("Codex patch notification could not be verified.");
      throw error;
    }
  }

  async handleServerRequest(request: unknown): Promise<void> {
    this.#assertOpen();
    const id = extractRequestId(request);
    if (id === null) {
      await this.#closeForViolation("Codex server request has no valid JSON-RPC id.");
      throw new Error("Codex server request has an invalid protocol id.");
    }
    const idKey = requestIdKey(id);
    if (this.#seenRequestIds.has(idKey)) {
      await this.#closeForViolation("Codex server request id was reused.");
      throw new Error("Codex approval request is duplicate; the bridge is closed.");
    }
    this.#seenRequestIds.add(idKey);

    if (!this.#isCurrent()) {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex server request is stale or expired.");
      return;
    }
    if (!isPlainRecord(request) || !exactDataKeys(request, ["id", "method", "params"])
      || typeof request.method !== "string") {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex server request has an unknown schema.");
      return;
    }

    if (request.method === COMMAND_APPROVAL_METHOD) {
      const parsed = parseCommandRequest(id, request.params);
      if (parsed === null) {
        await this.#respondOnce(id, "cancel");
        await this.#closeForViolation("Codex command approval has an unknown schema.");
        return;
      }
      await this.#handleCommand(parsed);
      return;
    }
    if (request.method === FILE_APPROVAL_METHOD) {
      const parsed = parseFileRequest(id, request.params);
      if (parsed === null) {
        await this.#respondOnce(id, "cancel");
        await this.#closeForViolation("Codex file approval has an unknown schema.");
        return;
      }
      await this.#handleFile(parsed);
      return;
    }

    await this.#respondOnce(id, "cancel");
    await this.#closeForViolation(`Unsupported Codex server request: ${request.method}`);
  }

  async #handleCommand(request: ParsedRequest<CommandApprovalParams>): Promise<void> {
    const { id, params } = request;
    if (params.command === null || params.cwd === null) {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex command approval omitted command or cwd.");
      return;
    }
    if (!this.#matchesScope(params.threadId, params.turnId)
      || params.cwd !== this.#staging.canonicalPath
      || !isCanonicalStagingCwd(params.cwd, this.#staging.canonicalPath)
      || !this.#claimCommandCallback(params.itemId, params.approvalId)) {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex command approval escaped or mismatched the current turn.");
      return;
    }
    if (hasAdditionalAuthority(params)) {
      await this.#respondOnce(id, "decline");
      return;
    }

    const command = params.command;
    const approvalRequest: ApprovalRequest = {
      name: "codex_command",
      risk: "shell",
      summary: `Run in isolated Codex staging: ${truncateForApproval(command, 400)}`,
      details: [
        `Working directory: ${this.#staging.canonicalPath}`,
        params.reason ? `Reason: ${params.reason}` : "",
      ].filter(Boolean).join("\n"),
      rememberable: false,
    };
    const result = await this.#authorizeAndRespond(id, approvalRequest);
    this.#onApproval(params.itemId, result.decision);
  }

  async #handleFile(request: ParsedRequest<FileApprovalParams>): Promise<void> {
    const { id, params } = request;
    if (!this.#matchesScope(params.threadId, params.turnId)
      || !this.#claimItem("file", params.itemId)) {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex file approval mismatched the current turn.");
      return;
    }
    if (params.grantRoot !== undefined && params.grantRoot !== null) {
      await this.#respondOnce(id, "decline");
      return;
    }
    const pending = this.#patches.get(params.itemId);
    if (!pending) {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex file approval has no matching verified preview.");
      return;
    }

    let preview: CodexPatchPreview;
    try {
      preview = await pending;
      await assertCodexPatchPreviewCurrent(preview);
    } catch {
      await this.#respondOnce(id, "cancel");
      await this.#closeForViolation("Codex file approval preview is stale or link-swapped.");
      return;
    }
    const policies = preview.changes.map((change) => classifyPath(change.path, "write"));
    if (policies.some((policy) => policy.verdict === "deny")) {
      await this.#respondOnce(id, "decline");
      return;
    }
    const protectedPolicies = policies.filter((policy) => policy.verdict === "approve");
    const approvalRequest: ApprovalRequest = {
      name: "codex_file_change",
      risk: "edit",
      summary: `Apply ${preview.changes.length} staged file change${preview.changes.length === 1 ? "" : "s"}.`,
      details: [
        preview.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"),
        params.reason ? `Reason: ${params.reason}` : "",
      ].filter(Boolean).join("\n"),
      ...(protectedPolicies.length === 0 ? {} : {
        alwaysAsk: true,
        policyRule: protectedPolicies.map((policy) => policy.rule).join(","),
      }),
      rememberable: false,
    };
    const binding = createCodexPatchApprovalBinding(preview, requestIdKey(id));
    let approved: CodexApprovedPatchPreview | null = null;
    const result = await this.#authorizeAndRespond(id, approvalRequest, {
      authorityBinding: binding,
      onAccept: async (receipt) => {
        if (!this.#isCurrent()) throw new Error("Codex file approval became stale after owner review.");
        await assertCodexPatchPreviewCurrent(preview);
        if (!this.#isCurrent()) throw new Error("Codex file approval became stale after preview validation.");
        approved = approveCodexPatchPreview(preview, receipt, binding);
      },
    });
    this.#onApproval(params.itemId, result.decision);
    if (result.decision === "accept") {
      if (approved === null) throw new Error("Codex file approval has no exact preview authority.");
      this.#approved.push(approved);
    }
  }

  async #authorizeAndRespond(
    id: JsonRpcId,
    request: ApprovalRequest,
    options: Readonly<{
      authorityBinding?: object;
      onAccept?: (
        receipt: Awaited<ReturnType<typeof authorizeOneShotApproval>>,
      ) => Promise<void> | void;
    }> = {},
  ): Promise<Readonly<{
    decision: OneShotApprovalDecision;
    receipt: Awaited<ReturnType<typeof authorizeOneShotApproval>>;
  }>> {
    let receipt: Awaited<ReturnType<typeof authorizeOneShotApproval>>;
    try {
      receipt = await authorizeOneShotApproval(this.#approvals, request, {
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
        deadlineAt: this.#deadlineAt,
        now: this.#now,
        ...(options.authorityBinding === undefined
          ? {}
          : { authorityBinding: options.authorityBinding }),
      });
    } catch (error) {
      try {
        await this.#respondOnce(id, "cancel");
      } finally {
        await this.#closeForViolation("Orcode approval authority failed.");
      }
      throw error;
    }
    if (receipt.decision === "accept") {
      try {
        if (!this.#isCurrent()) throw new Error("Codex approval became stale after owner review.");
        await options.onAccept?.(receipt);
        if (!this.#isCurrent()) throw new Error("Codex approval became stale before response.");
      } catch {
        await this.#respondOnce(id, "cancel");
        await this.#closeForViolation("Codex approval authority became stale after owner review.");
        return Object.freeze({ decision: "cancel", receipt });
      }
    }
    try {
      await this.#respondOnce(id, receipt.decision);
    } catch (error) {
      await this.#closeForViolation("Codex approval response could not be delivered.");
      throw error;
    }
    if (receipt.decision === "cancel") {
      await this.#closeForViolation("Codex approval expired or was cancelled.");
    }
    return Object.freeze({ decision: receipt.decision, receipt });
  }

  #claimItem(kind: "command" | "file", itemId: string): boolean {
    const key = `${kind}:${itemId}`;
    if (this.#seenItems.has(key)) return false;
    this.#seenItems.add(key);
    return true;
  }

  #claimCommandCallback(itemId: string, approvalId: string | null | undefined): boolean {
    const key = approvalId === undefined || approvalId === null
      ? `command:item:${itemId}`
      : `command:callback:${approvalId}`;
    if (this.#seenItems.has(key)) return false;
    this.#seenItems.add(key);
    return true;
  }

  #matchesScope(threadId: string, turnId: string): boolean {
    return threadId === this.#threadId && turnId === this.#turnId && this.#isCurrent();
  }

  #isCurrent(): boolean {
    return !this.#closed && !this.#closing && !this.#signal?.aborted && this.#now() < this.#deadlineAt
      && this.#staging.active && this.#isCurrentGeneration(this.#childGeneration)
      && this.#operation.isCurrent();
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) throw new Error("Codex approval protocol bridge is closed.");
  }

  async #respondOnce(id: JsonRpcId, decision: OneShotApprovalDecision): Promise<void> {
    const key = requestIdKey(id);
    if (this.#responseAttempts.has(key)) {
      await this.#closeForViolation("Codex server request received a second response attempt.");
      throw new Error("Codex server request already received its one response attempt.");
    }
    this.#responseAttempts.add(key);
    try {
      await this.#operation.respond(id, Object.freeze({ decision }), decision === "accept"
        ? () => {
          if (!this.#isCurrent()) {
            throw new Error("Codex approval authority changed before the physical response write.");
          }
        }
        : undefined);
    } catch (error) {
      await this.#closeForViolation("Codex approval response could not be delivered.");
      throw error;
    }
  }

  async #closeForViolation(reason: string): Promise<void> {
    if (this.#closed) return;
    await this.#beginCleanup(reason);
  }

  #closeAfterNotification(reason: string): void {
    void this.#beginCleanup(reason).catch(() => undefined);
  }

  #beginCleanup(reason: string): Promise<void> {
    if (this.#cleanupPromise !== null) return this.#cleanupPromise;
    this.#closing = true;
    this.#detachRequests();
    this.#detachTerminal();
    const cleanup = Promise.resolve().then(async () => {
      const drained = await this.#operation.drain();
      if (drained !== "closed" && drained !== "killed") {
        throw new Error(`Codex App Server did not prove drain after protocol violation: ${reason}`);
      }
      await this.#staging.discard();
      this.#closed = true;
    });
    this.#cleanupPromise = cleanup;
    return cleanup;
  }
}

export async function cancelAndDrainCodexOperation(bridge: CodexApprovalBridge): Promise<void> {
  if (!(bridge instanceof CodexApprovalBridge)) throw new Error("A bound Codex operation bridge is required.");
  await bridge.cancelAndDrain();
}

function parseCommandRequest(
  id: JsonRpcId,
  value: unknown,
): ParsedRequest<CommandApprovalParams> | null {
  if (!isPlainRecord(value) || !exactOptionalDataKeys(value, [
    "threadId", "turnId", "itemId", "startedAtMs", "environmentId",
  ], [
    "reason", "approvalId", "networkApprovalContext", "command", "cwd",
    "commandActions", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments",
  ]) || !safeIdentifier(value.threadId) || !safeIdentifier(value.turnId)
    || !safeIdentifier(value.itemId) || typeof value.startedAtMs !== "number"
    || !Number.isSafeInteger(value.startedAtMs) || value.startedAtMs < 0
    || !(value.command === null || boundedCommand(value.command))
    || !(value.cwd === null || typeof value.cwd === "string" && isAbsolute(value.cwd))
    || !nullableBoundedText(value.reason, MAX_REASON_BYTES)
    || !nullableIdentifier(value.approvalId)
    || !nullableIdentifier(value.environmentId)
    || !validCommandActions(value.commandActions)) {
    return null;
  }
  return { id, params: value as unknown as CommandApprovalParams };
}

function parseFileRequest(
  id: JsonRpcId,
  value: unknown,
): ParsedRequest<FileApprovalParams> | null {
  if (!isPlainRecord(value) || !exactOptionalDataKeys(value,
    ["threadId", "turnId", "itemId", "startedAtMs"], ["reason", "grantRoot"])
    || !safeIdentifier(value.threadId) || !safeIdentifier(value.turnId)
    || !safeIdentifier(value.itemId) || typeof value.startedAtMs !== "number"
    || !Number.isSafeInteger(value.startedAtMs) || value.startedAtMs < 0
    || !nullableBoundedText(value.reason, MAX_REASON_BYTES)
    || (value.grantRoot !== undefined && value.grantRoot !== null
      && (typeof value.grantRoot !== "string" || !isAbsolute(value.grantRoot)))) {
    return null;
  }
  return { id, params: value as unknown as FileApprovalParams };
}

function hasAdditionalAuthority(params: CommandApprovalParams): boolean {
  return params.environmentId !== undefined && params.environmentId !== null
    || params.networkApprovalContext !== undefined && params.networkApprovalContext !== null
    || params.proposedExecpolicyAmendment !== undefined
      && params.proposedExecpolicyAmendment !== null
    || params.proposedNetworkPolicyAmendments !== undefined
      && params.proposedNetworkPolicyAmendments !== null;
}

function isCanonicalStagingCwd(value: string, canonical: string): boolean {
  const rel = relative(canonical, value);
  return rel === "" && !rel.startsWith(`..${sep}`);
}

function isExactPatchObservation(value: unknown): value is CodexPatchUpdatedObservation {
  return isPlainRecord(value) && exactDataKeys(value, [
    "threadId", "turnId", "itemId", "changes",
  ]) && safeIdentifier(value.threadId) && safeIdentifier(value.turnId)
    && safeIdentifier(value.itemId) && Array.isArray(value.changes)
    && value.changes.length > 0;
}

function extractRequestId(value: unknown): JsonRpcId | null {
  if (!isPlainRecord(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "id");
  if (!descriptor || !("value" in descriptor)) return null;
  const id = descriptor.value as unknown;
  if (typeof id === "number") {
    return Number.isSafeInteger(id) ? id : null;
  }
  return typeof id === "string" ? id : null;
}

function requestIdKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}

function isExpectedInterruptDrain(value: unknown): boolean {
  return value instanceof Error && value.constructor === Error
    && value.message === "Codex App Server is closed.";
}

function boundedCommand(value: unknown): value is string {
  if (typeof value === "string") {
    return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_COMMAND_BYTES
      && !value.includes("\0");
  }
  return false;
}

function validCommandActions(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length <= 4_096
    && boundedPlainData(value, 0, { bytes: 0 });
}

function validAvailableDecisions(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length > 0 && value.length <= 8
    && new Set(value).size === value.length
    && value.every((decision) => decision === "accept" || decision === "acceptForSession"
      || decision === "decline" || decision === "cancel"
      || decision === "acceptWithExecpolicyAmendment"
      || decision === "applyNetworkPolicyAmendment");
}

function boundedPlainData(
  value: unknown,
  depth: number,
  budget: { bytes: number },
): boolean {
  if (depth > 12 || budget.bytes > MAX_COMMAND_BYTES) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    return budget.bytes <= MAX_COMMAND_BYTES && !value.includes("\0");
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4_096
      && value.every((item) => boundedPlainData(item, depth + 1, budget));
  }
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= 128 && keys.every((key) => typeof key === "string"
    && safeIdentifier(key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && boundedPlainData(value[key], depth + 1, budget));
}

function nullableBoundedText(value: unknown, maxBytes: number): boolean {
  return value === undefined || value === null
    || (typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
      && !value.includes("\0"));
}

function nullableIdentifier(value: unknown): boolean {
  return value === undefined || value === null || safeIdentifier(value);
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function truncateForApproval(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return exactOptionalDataKeys(value, expected, []);
}

function exactOptionalDataKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  const accepted = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== "string" || !accepted.has(key))) return false;
  const present = new Set(keys as string[]);
  if (required.some((key) => !present.has(key))) return false;
  return keys.every((key) => {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return false; }
    return descriptor !== undefined && "value" in descriptor;
  });
}
