import { randomBytes } from "node:crypto";
import { close, read, write } from "node:fs";

import type { RouteIdentityV1 } from "./backends.js";
import {
  parseStrictJsonValue,
  type KimiProviderRequestDigest,
} from "./kimi-provider-request-digest.js";

export const NATIVE_ACTION_WRITER_FD = 198 as const;
export const NATIVE_CONTROL_READER_FD = 199 as const;
export const ACTION_FRAME_TAG = 0xa1 as const;
export const CONTROL_FRAME_TAG = 0xc1 as const;
export const MAX_NATIVE_SIDECAR_PAYLOAD_BYTES = 4096 as const;

const REQUEST_ID = /^[A-Za-z0-9_-]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_ID_CHARS = 256;
const MAX_CONTROL_HISTORY = 1_024;

export type KimiPackagedStartupRequest = Readonly<{
      kind: "packaged-startup";
      requestId: string;
      challenge: string;
      sessionId: string;
      childPid: number;
      actionChannelId: "fd:198";
      controlChannelId: "fd:199";
    }>;

export type KimiNativeActionRequest =
  | Readonly<{
      kind: "kimi-setup";
      requestId: string;
      sessionId: string;
      childPid: number;
      setupId: string;
      provider: "kimi-code";
      operation: "initial-setup" | "replace";
      revision: number;
      generation: number;
      deadlineAt: number;
    }>
  | Readonly<{
      kind: "kimi-turn";
      requestId: string;
      sessionId: string;
      childPid: number;
      runId: string;
      route: RouteIdentityV1;
      requestDigest: KimiProviderRequestDigest;
      revision: number;
      generation: number;
      deadlineAt: number;
    }>
  | Readonly<{
      kind: "kimi-cross";
      requestId: string;
      sessionId: string;
      childPid: number;
      crossRunId: string;
      lead: RouteIdentityV1;
      challenger: RouteIdentityV1;
      repairBudget: 0 | 1;
      requestBudgetPerStage: number;
      revision: number;
      generation: number;
      deadlineAt: number;
    }>;

export type KimiNativeActionRevocation = Readonly<{
  kind: "revoke";
  requestId: string;
  sessionId: string;
  childPid: number;
  revision: number;
  generation: number;
  deadlineAt: number;
}>;

export type KimiNativeActionRecord = KimiNativeActionRequest | KimiNativeActionRevocation;
export type KimiPrivateActionRecord = KimiPackagedStartupRequest | KimiNativeActionRecord;

export type KimiDesktopControlRecord =
  | Readonly<{
      kind: "packaged-attestation";
      requestId: string;
      challenge: string;
      sessionId: string;
      childPid: number;
      generation: number;
      actionChannelId: "fd:198";
      controlChannelId: "fd:199";
      executablePath: string;
      executableDevice: number;
      executableInode: number;
      executableSize: number;
      policySha256: string;
      executableSha256: string;
    }>
  | Readonly<{ kind: "permit"; request: Exclude<KimiNativeActionRequest, { kind: "packaged-startup" }>; nonce: string }>
  | Readonly<{
      kind: "denied";
      requestId: string;
      sessionId: string;
      childPid: number;
      revision: number;
      generation: number;
      deadlineAt: number;
    }>;

export type CodexNativeActionRequest =
  | Readonly<{
      kind: "codex-browser-login-prepare";
      requestId: string;
      childGeneration: number;
      loginId: string;
      authUrl: string;
      deadlineAt: number;
    }>
  | Readonly<{
      kind: "codex-device-login-prepare";
      requestId: string;
      childGeneration: number;
      loginId: string;
      verificationUrl: string;
      userCode: string;
      deadlineAt: number;
    }>
  | Readonly<{
      kind: "codex-native-action-commit" | "codex-native-action-revoke";
      requestId: string;
      childGeneration: number;
      deadlineAt: number;
    }>;

export type CodexNativeActionResult = Readonly<{
  kind: "codex-native-action-result";
  requestId: string;
  childGeneration: number;
  status: "presented" | "failed";
}>;

export type NativeActionRecord = KimiPrivateActionRecord | CodexNativeActionRequest;
export type NativeControlRecord = KimiDesktopControlRecord | CodexNativeActionResult;

export interface NativeSidecarTransport {
  writeAction(frame: Uint8Array): Promise<void>;
  readControl(): Promise<Uint8Array | null>;
  close(): void;
}

function invalid(message: string): never {
  throw new TypeError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid("Native record contains unknown keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      invalid("Native record contains invalid properties.");
    }
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid("Native record contains unknown keys.");
  }
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    invalid(`Native ${name} is invalid.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) invalid(`Native ${name} is invalid.`);
  return value;
}

function boundedUrl(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)) invalid(`Native ${name} is invalid.`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`Native ${name} is invalid.`);
  return Number(value);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(`Native ${name} is invalid.`);
  return Number(value);
}

function canonicalRoute(value: unknown): Readonly<RouteIdentityV1> {
  if (!isPlainObject(value)) invalid("Native route is invalid.");
  exactKeys(value, [
    "version",
    "backendId",
    "accountFingerprint",
    "billingRealm",
    "requestedModelId",
    "canonicalModelId",
    "resolutionState",
  ]);
  if (value.version !== 1
    || (value.backendId !== "openrouter" && value.backendId !== "kimi-code" && value.backendId !== "codex" && value.backendId !== "anthropic")
    || (value.billingRealm !== "openrouter-payg"
      && value.billingRealm !== "kimi-code-membership-provider-managed-overage"
      && value.billingRealm !== "chatgpt-subscription-provider-managed-overage"
      && value.billingRealm !== "chatgpt-account-provider-managed-limits"
      && value.billingRealm !== "none")
    || (value.resolutionState !== "legacy-unverified" && value.resolutionState !== "resolved")
    || (value.canonicalModelId !== null && typeof value.canonicalModelId !== "string")) {
    invalid("Native route is invalid.");
  }
  const accountFingerprint = boundedString(value.accountFingerprint, "account fingerprint");
  const requestedModelId = boundedString(value.requestedModelId, "requested model");
  if (typeof value.canonicalModelId === "string") boundedString(value.canonicalModelId, "canonical model");
  return Object.freeze({
    version: 1,
    backendId: value.backendId,
    accountFingerprint,
    billingRealm: value.billingRealm,
    requestedModelId,
    canonicalModelId: value.canonicalModelId,
    resolutionState: value.resolutionState,
  });
}

function canonicalCrossRoute(value: unknown): Readonly<RouteIdentityV1> {
  const route = canonicalRoute(value);
  if (route.backendId === "kimi-code"
    && (route.billingRealm !== "kimi-code-membership-provider-managed-overage"
      || route.resolutionState !== "resolved"
      || route.canonicalModelId === null)) invalid("Native Kimi Cross route is invalid.");
  return route;
}

function canonicalFence(value: Record<string, unknown>): {
  requestId: string;
  sessionId: string;
  childPid: number;
  revision: number;
  generation: number;
  deadlineAt: number;
} {
  const requestId = boundedString(value.requestId, "request ID");
  if (!REQUEST_ID.test(requestId)) invalid("Native request ID is invalid.");
  return {
    requestId,
    sessionId: boundedString(value.sessionId, "session ID"),
    childPid: positiveInteger(value.childPid, "child PID"),
    revision: nonNegativeInteger(value.revision, "revision"),
    generation: nonNegativeInteger(value.generation, "generation"),
    deadlineAt: positiveInteger(value.deadlineAt, "deadline"),
  };
}

export function canonicalKimiNativeActionRequest(value: unknown): KimiNativeActionRequest {
  if (!isPlainObject(value)) invalid("Native Kimi action is invalid.");
  if (value.kind === "kimi-setup") {
    exactKeys(value, [
      "kind", "requestId", "sessionId", "childPid", "setupId", "provider", "operation",
      "revision", "generation", "deadlineAt",
    ]);
    const fence = canonicalFence(value);
    if (value.provider !== "kimi-code"
      || (value.operation !== "initial-setup" && value.operation !== "replace")) {
      invalid("Native Kimi setup action is invalid.");
    }
    return Object.freeze({
      kind: "kimi-setup",
      ...fence,
      setupId: boundedString(value.setupId, "setup ID"),
      provider: "kimi-code",
      operation: value.operation,
    });
  }
  if (value.kind === "kimi-turn") {
    exactKeys(value, [
      "kind", "requestId", "sessionId", "childPid", "runId", "route", "requestDigest",
      "revision", "generation", "deadlineAt",
    ]);
    const fence = canonicalFence(value);
    if (typeof value.requestDigest !== "string" || !DIGEST.test(value.requestDigest)) {
      invalid("Native Kimi request digest is invalid.");
    }
    const route = canonicalRoute(value.route);
    if (route.backendId !== "kimi-code"
      || route.billingRealm !== "kimi-code-membership-provider-managed-overage"
      || route.resolutionState !== "resolved"
      || route.canonicalModelId === null) invalid("Native Kimi turn route is invalid.");
    return Object.freeze({
      kind: "kimi-turn",
      ...fence,
      runId: boundedString(value.runId, "run ID"),
      route,
      requestDigest: value.requestDigest as KimiProviderRequestDigest,
    });
  }
  if (value.kind === "kimi-cross") {
    exactKeys(value, [
      "kind", "requestId", "sessionId", "childPid", "crossRunId", "lead", "challenger",
      "repairBudget", "requestBudgetPerStage", "revision", "generation", "deadlineAt",
    ]);
    const fence = canonicalFence(value);
    if (value.repairBudget !== 0 && value.repairBudget !== 1) invalid("Native repair budget is invalid.");
    const requestBudgetPerStage = positiveInteger(value.requestBudgetPerStage, "request budget per stage");
    if (requestBudgetPerStage > 100) invalid("Native request budget per stage is invalid.");
    const lead = canonicalCrossRoute(value.lead);
    const challenger = canonicalCrossRoute(value.challenger);
    if (lead.backendId !== "kimi-code" && challenger.backendId !== "kimi-code") {
      invalid("Native Kimi Cross action requires a Kimi route.");
    }
    return Object.freeze({
      kind: "kimi-cross",
      ...fence,
      crossRunId: boundedString(value.crossRunId, "Cross run ID"),
      lead,
      challenger,
      repairBudget: value.repairBudget,
      requestBudgetPerStage,
    });
  }
  return invalid("Native Kimi action kind is invalid.");
}

export function canonicalKimiNativeActionRecord(value: unknown): KimiPrivateActionRecord {
  if (!isPlainObject(value)) invalid("Native Kimi action is invalid.");
  if (value.kind === "packaged-startup") {
    exactKeys(value, ["kind", "requestId", "challenge", "sessionId", "childPid", "actionChannelId", "controlChannelId"]);
    const requestId = boundedString(value.requestId, "request ID"); const challenge = boundedString(value.challenge, "startup challenge");
    if (!REQUEST_ID.test(requestId) || !NONCE.test(challenge) || value.actionChannelId !== "fd:198" || value.controlChannelId !== "fd:199") invalid("Native packaged startup is invalid.");
    return Object.freeze({ kind: "packaged-startup", requestId, challenge, sessionId: boundedString(value.sessionId, "session ID"), childPid: positiveInteger(value.childPid, "child PID"), actionChannelId: "fd:198", controlChannelId: "fd:199" });
  }
  if (value.kind === "revoke") {
    exactKeys(value, [
      "kind", "requestId", "sessionId", "childPid", "revision", "generation", "deadlineAt",
    ]);
    return Object.freeze({ kind: "revoke", ...canonicalFence(value) });
  }
  return canonicalKimiNativeActionRequest(value);
}

export function canonicalKimiDesktopControlRecord(value: unknown): KimiDesktopControlRecord {
  if (!isPlainObject(value)) invalid("Native Kimi control is invalid.");
  if (value.kind === "packaged-attestation") {
    exactKeys(value, ["kind", "requestId", "challenge", "sessionId", "childPid", "generation", "actionChannelId", "controlChannelId", "executablePath", "executableDevice", "executableInode", "executableSize", "policySha256", "executableSha256"]);
    const requestId = boundedString(value.requestId, "request ID"); const challenge = boundedString(value.challenge, "startup challenge");
    if (!REQUEST_ID.test(requestId) || !NONCE.test(challenge) || value.actionChannelId !== "fd:198" || value.controlChannelId !== "fd:199" || typeof value.executablePath !== "string" || !value.executablePath.startsWith("/") || typeof value.policySha256 !== "string" || !DIGEST.test(value.policySha256) || typeof value.executableSha256 !== "string" || !DIGEST.test(value.executableSha256)) invalid("Native packaged attestation is invalid.");
    return Object.freeze({ kind: "packaged-attestation", requestId, challenge, sessionId: boundedString(value.sessionId, "session ID"), childPid: positiveInteger(value.childPid, "child PID"), generation: nonNegativeInteger(value.generation, "generation"), actionChannelId: "fd:198", controlChannelId: "fd:199", executablePath: value.executablePath, executableDevice: nonNegativeInteger(value.executableDevice, "executable device"), executableInode: nonNegativeInteger(value.executableInode, "executable inode"), executableSize: nonNegativeInteger(value.executableSize, "executable size"), policySha256: value.policySha256, executableSha256: value.executableSha256 });
  }
  if (value.kind === "permit") {
    exactKeys(value, ["kind", "request", "nonce"]);
    const nonce = boundedString(value.nonce, "permit nonce");
    if (!NONCE.test(nonce)) invalid("Native permit nonce is invalid.");
    const request = canonicalKimiNativeActionRequest(value.request);
    return Object.freeze({ kind: "permit", request, nonce });
  }
  if (value.kind === "denied") {
    exactKeys(value, [
      "kind", "requestId", "sessionId", "childPid", "revision", "generation", "deadlineAt",
    ]);
    return Object.freeze({ kind: "denied", ...canonicalFence(value) });
  }
  return invalid("Native Kimi control kind is invalid.");
}

export function canonicalCodexNativeActionRequest(value: unknown): CodexNativeActionRequest {
  if (!isPlainObject(value)) invalid("Native Codex action is invalid.");
  if (value.kind === "codex-browser-login-prepare") {
    exactKeys(value, [
      "kind", "requestId", "childGeneration", "loginId", "authUrl", "deadlineAt",
    ]);
    const requestId = boundedString(value.requestId, "request ID");
    if (!REQUEST_ID.test(requestId)) invalid("Native request ID is invalid.");
    return Object.freeze({
      kind: "codex-browser-login-prepare",
      requestId,
      childGeneration: nonNegativeInteger(value.childGeneration, "child generation"),
      loginId: boundedString(value.loginId, "login ID"),
      authUrl: boundedUrl(value.authUrl, "Codex login URL"),
      deadlineAt: positiveInteger(value.deadlineAt, "deadline"),
    });
  }
  if (value.kind === "codex-device-login-prepare") {
    exactKeys(value, [
      "kind", "requestId", "childGeneration", "loginId", "verificationUrl", "userCode", "deadlineAt",
    ]);
    const requestId = boundedString(value.requestId, "request ID");
    if (!REQUEST_ID.test(requestId)) invalid("Native request ID is invalid.");
    return Object.freeze({
      kind: "codex-device-login-prepare",
      requestId,
      childGeneration: nonNegativeInteger(value.childGeneration, "child generation"),
      loginId: boundedString(value.loginId, "login ID"),
      verificationUrl: boundedUrl(value.verificationUrl, "Codex verification URL"),
      userCode: boundedString(value.userCode, "Codex user code"),
      deadlineAt: positiveInteger(value.deadlineAt, "deadline"),
    });
  }
  if (value.kind === "codex-native-action-commit" || value.kind === "codex-native-action-revoke") {
    exactKeys(value, ["kind", "requestId", "childGeneration", "deadlineAt"]);
    const requestId = boundedString(value.requestId, "request ID");
    if (!REQUEST_ID.test(requestId)) invalid("Native request ID is invalid.");
    return Object.freeze({
      kind: value.kind,
      requestId,
      childGeneration: nonNegativeInteger(value.childGeneration, "child generation"),
      deadlineAt: positiveInteger(value.deadlineAt, "deadline"),
    });
  }
  return invalid("Native Codex action kind is invalid.");
}

export function canonicalCodexNativeActionResult(value: unknown): CodexNativeActionResult {
  if (!isPlainObject(value)) invalid("Native Codex control is invalid.");
  exactKeys(value, ["kind", "requestId", "childGeneration", "status"]);
  if (value.kind !== "codex-native-action-result"
    || (value.status !== "presented" && value.status !== "failed")) {
    invalid("Native Codex control is invalid.");
  }
  const requestId = boundedString(value.requestId, "request ID");
  if (!REQUEST_ID.test(requestId)) invalid("Native request ID is invalid.");
  return Object.freeze({
    kind: "codex-native-action-result",
    requestId,
    childGeneration: nonNegativeInteger(value.childGeneration, "child generation"),
    status: value.status,
  });
}

function canonicalNativeActionRecord(value: unknown): NativeActionRecord {
  if (isPlainObject(value) && (
    value.kind === "codex-browser-login-prepare"
    || value.kind === "codex-device-login-prepare"
    || value.kind === "codex-native-action-commit"
    || value.kind === "codex-native-action-revoke"
  )) {
    return canonicalCodexNativeActionRequest(value);
  }
  return canonicalKimiNativeActionRecord(value);
}

function canonicalNativeControlRecord(value: unknown): NativeControlRecord {
  if (isPlainObject(value) && value.kind === "codex-native-action-result") {
    return canonicalCodexNativeActionResult(value);
  }
  return canonicalKimiDesktopControlRecord(value);
}

function encodeFrame(tag: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  if (payload.byteLength > MAX_NATIVE_SIDECAR_PAYLOAD_BYTES) {
    invalid("Native sidecar payload exceeds the maximum.");
  }
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = tag;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

function decodePayload(frame: Uint8Array, expectedTag: number, direction: string): unknown {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 5) invalid("Native frame is truncated.");
  if (frame[0] !== expectedTag) invalid(`Native frame has the wrong ${direction} direction tag.`);
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
  if (length > MAX_NATIVE_SIDECAR_PAYLOAD_BYTES) invalid("Native sidecar payload exceeds the maximum.");
  if (frame.byteLength !== 5 + length) invalid("Native frame length is truncated or mismatched.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(5));
  } catch {
    return invalid("Native frame JSON is invalid.");
  }
  return parseStrictJsonValue(source);
}

export function encodeActionFrame(request: NativeActionRecord): Uint8Array {
  return encodeFrame(ACTION_FRAME_TAG, canonicalNativeActionRecord(request));
}

export function decodeActionFrame<
  Record extends Exclude<NativeActionRecord, KimiPackagedStartupRequest> = KimiNativeActionRecord,
>(frame: Uint8Array): Record {
  const record = canonicalNativeActionRecord(decodePayload(frame, ACTION_FRAME_TAG, "action"));
  if (record.kind === "packaged-startup") invalid("Native runtime action is invalid.");
  return record as Record;
}

export function decodePrivateActionFrame(frame: Uint8Array): KimiPrivateActionRecord {
  return canonicalKimiNativeActionRecord(decodePayload(frame, ACTION_FRAME_TAG, "action"));
}

export function encodeControlFrame(record: NativeControlRecord): Uint8Array {
  return encodeFrame(CONTROL_FRAME_TAG, canonicalNativeControlRecord(record));
}

export function decodeControlFrame<Record extends NativeControlRecord = KimiDesktopControlRecord>(frame: Uint8Array): Record {
  return canonicalNativeControlRecord(decodePayload(frame, CONTROL_FRAME_TAG, "control")) as Record;
}

export function createKimiRequestId(): string {
  const requestId = randomBytes(24).toString("base64url");
  if (!REQUEST_ID.test(requestId)) invalid("Generated native request ID is invalid.");
  return requestId;
}

function fsRead(fd: number, buffer: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buffer, 0, buffer.byteLength, null, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

async function readExactly(
  fd: number,
  bytes: number,
  eofAllowed: boolean,
  readChunk: (fd: number, buffer: Uint8Array) => Promise<number> = fsRead,
): Promise<Uint8Array | null> {
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  while (offset < bytes) {
    const target = buffer.subarray(offset);
    const count = await readChunk(fd, target);
    if (count === 0) {
      if (offset === 0 && eofAllowed) return null;
      invalid("Native control frame is truncated.");
    }
    offset += count;
  }
  return buffer;
}

function fsWrite(fd: number, buffer: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, buffer, 0, buffer.byteLength, null, (error, written) => {
      if (error) reject(error);
      else resolve(written);
    });
  });
}

function fsClose(fd: number): void {
  close(fd, () => {});
}

interface FixedDescriptorIo {
  readonly read: (fd: number, buffer: Uint8Array) => Promise<number>;
  readonly write: (fd: number, buffer: Uint8Array) => Promise<number>;
  readonly close: (fd: number) => void;
}

const FIXED_DESCRIPTOR_IO: FixedDescriptorIo = {
  read: fsRead,
  write: fsWrite,
  close: fsClose,
};

class FixedDescriptorTransport implements NativeSidecarTransport {
  #closed = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly actionFd: number,
    private readonly controlFd: number,
    private readonly io: FixedDescriptorIo = FIXED_DESCRIPTOR_IO,
  ) {}

  writeAction(frame: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Native sidecar channel is closed."));
    const copy = Uint8Array.from(frame);
    const operation = this.#writeTail.then(async () => {
      if (this.#closed) throw new Error("Native sidecar channel is closed.");
      let offset = 0;
      while (offset < copy.byteLength) {
        if (this.#closed) throw new Error("Native sidecar channel is closed.");
        const written = await this.io.write(this.actionFd, copy.subarray(offset));
        if (written <= 0) throw new Error("Native sidecar action channel closed during write.");
        offset += written;
      }
    });
    this.#writeTail = operation.catch(() => {});
    return operation;
  }

  async readControl(): Promise<Uint8Array | null> {
    if (this.#closed) return null;
    const header = await readExactly(this.controlFd, 5, true, this.io.read);
    if (header === null) return null;
    if (header[0] !== CONTROL_FRAME_TAG) invalid("Native frame has the wrong control direction tag.");
    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
    if (length > MAX_NATIVE_SIDECAR_PAYLOAD_BYTES) invalid("Native sidecar payload exceeds the maximum.");
    const payload = await readExactly(this.controlFd, length, false, this.io.read);
    const frame = new Uint8Array(5 + length);
    frame.set(header);
    frame.set(payload!, 5);
    return frame;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.io.close(this.actionFd);
    if (this.controlFd !== this.actionFd) this.io.close(this.controlFd);
  }
}

/** Test-only seam that exercises the production fixed-descriptor serializer with local fake I/O. */
export function createFixedDescriptorTransportForTest(io: FixedDescriptorIo): NativeSidecarTransport {
  return new FixedDescriptorTransport(NATIVE_ACTION_WRITER_FD, NATIVE_CONTROL_READER_FD, io);
}

export class NativeSidecarChannel {
  #closed = false;
  #pump: Promise<void> | null = null;
  readonly #kimiWaiters: Array<{
    resolve: (record: KimiDesktopControlRecord | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  readonly #kimiQueue: KimiDesktopControlRecord[] = [];
  readonly #codexWaiters: Array<{
    resolve: (record: CodexNativeActionResult | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  readonly #codexPending = new Map<string, {
    resolve: (record: CodexNativeActionResult | null) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  readonly #codexTombstones = new Set<string>();

  constructor(private readonly transport: NativeSidecarTransport) {
    if (!transport
      || typeof transport.writeAction !== "function"
      || typeof transport.readControl !== "function"
      || typeof transport.close !== "function") {
      invalid("Native sidecar transport is invalid.");
    }
  }

  static fromFixedDescriptors(): NativeSidecarChannel {
    return new NativeSidecarChannel(new FixedDescriptorTransport(
      NATIVE_ACTION_WRITER_FD,
      NATIVE_CONTROL_READER_FD,
    ));
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  async writeKimiAction(request: KimiNativeActionRequest): Promise<void> {
    if (this.#closed) throw new Error("Native sidecar channel is closed.");
    await this.transport.writeAction(encodeActionFrame(request));
  }

  async writePackagedStartup(request: KimiPackagedStartupRequest): Promise<void> {
    if (this.#closed) throw new Error("Native sidecar channel is closed.");
    await this.transport.writeAction(encodeActionFrame(request));
  }

  async writeKimiRevocation(revocation: KimiNativeActionRevocation): Promise<void> {
    if (this.#closed) throw new Error("Native sidecar channel is closed.");
    await this.transport.writeAction(encodeActionFrame(revocation));
  }

  readKimiControl(): Promise<KimiDesktopControlRecord | null> {
    if (this.#closed) return Promise.resolve(null);
    const queued = this.#kimiQueue.shift();
    if (queued) return Promise.resolve(queued);
    const pending = new Promise<KimiDesktopControlRecord | null>((resolve, reject) => {
      this.#kimiWaiters.push({ resolve, reject });
    });
    this.#ensurePump();
    return pending;
  }

  async writeCodexAction(request: CodexNativeActionRequest): Promise<void> {
    if (this.#closed) throw new Error("Native sidecar channel is closed.");
    await this.transport.writeAction(encodeActionFrame(request));
  }

  readCodexControl(): Promise<CodexNativeActionResult | null> {
    if (this.#closed) return Promise.resolve(null);
    const pending = new Promise<CodexNativeActionResult | null>((resolve, reject) => {
      this.#codexWaiters.push({ resolve, reject });
    });
    this.#ensurePump();
    return pending;
  }

  waitForCodexControl(requestId: string, signal?: AbortSignal): Promise<CodexNativeActionResult | null> {
    if (!REQUEST_ID.test(requestId)) return Promise.reject(new TypeError("Native request ID is invalid."));
    if (this.#closed) return Promise.resolve(null);
    if (this.#codexPending.has(requestId) || this.#codexTombstones.has(requestId)) {
      return Promise.reject(new Error("Native Codex request ID is already pending."));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }
    const pending = new Promise<CodexNativeActionResult | null>((resolve, reject) => {
      const entry: {
        resolve: (record: CodexNativeActionResult | null) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject };
      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => {
          if (this.#codexPending.delete(requestId)) {
            const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
            reject(reason);
            if (this.#codexTombstones.size >= MAX_CONTROL_HISTORY) {
              this.#settleClosed(new Error("Native Codex control history is exhausted."));
            } else {
              this.#codexTombstones.add(requestId);
            }
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#codexPending.set(requestId, entry);
    });
    this.#ensurePump();
    return pending;
  }

  close(): void {
    if (this.#closed) return;
    this.#settleClosed();
  }

  #ensurePump(): void {
    if (this.#pump !== null || this.#closed) return;
    this.#pump = this.#runPump()
      .catch((error) => { this.#settleClosed(error); })
      .finally(() => { this.#pump = null; });
  }

  async #runPump(): Promise<void> {
    while (!this.#closed) {
      const frame = await this.transport.readControl();
      if (frame === null) {
        this.#settleClosed();
        return;
      }
      const record = decodeControlFrame<NativeControlRecord>(frame);
      if (record.kind === "codex-native-action-result") {
        const pending = this.#codexPending.get(record.requestId);
        if (pending) {
          this.#codexPending.delete(record.requestId);
          if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener("abort", pending.onAbort);
          }
          pending.resolve(record);
          continue;
        }
        if (this.#codexTombstones.delete(record.requestId)) continue;
        const generic = this.#codexWaiters.shift();
        if (generic) {
          generic.resolve(record);
          continue;
        }
        throw new Error("Native Codex control has no pending request.");
      }
      const kimi = this.#kimiWaiters.shift();
      if (kimi) {
        kimi.resolve(record);
      } else if (this.#kimiQueue.length < MAX_CONTROL_HISTORY) {
        this.#kimiQueue.push(record);
      } else {
        throw new Error("Native Kimi control backlog is exhausted.");
      }
    }
  }

  #settleClosed(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.transport.close();
    const settle = <Value>(
      entries: Array<{ resolve: (value: Value | null) => void; reject: (reason: unknown) => void }>,
    ) => {
      for (const entry of entries.splice(0)) {
        if (error === undefined) entry.resolve(null);
        else entry.reject(error);
      }
    };
    settle(this.#kimiWaiters);
    settle(this.#codexWaiters);
    this.#kimiQueue.splice(0);
    for (const [requestId, pending] of this.#codexPending) {
      this.#codexPending.delete(requestId);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      if (error === undefined) pending.resolve(null);
      else pending.reject(error);
    }
    this.#codexTombstones.clear();
  }
}
