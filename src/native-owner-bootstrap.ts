import { randomBytes } from "node:crypto";

/** Correlation data only. Neither record is a native owner capability. */
export type WindowsOwnerHelloV1 = Readonly<{
  kind: "windows-owner-hello";
  version: 1;
  requestId: string;
  sessionId: string;
  challenge: string;
  childPid: number;
  childGeneration: number;
  pipeInstanceId: string;
  deadlineAt: number;
}>;

export type WindowsOwnerAttestationV1 = Readonly<Omit<WindowsOwnerHelloV1, "kind"> & {
  kind: "windows-owner-attestation";
  childCreationTime: string;
  peerPid: number;
  peerCreationTime: string;
  ownerPid: number;
  ownerCreationTime: string;
  ownerImageSha256: string;
}>;

const HELLO_KEYS = ["kind", "version", "requestId", "sessionId", "challenge", "childPid",
  "childGeneration", "pipeInstanceId", "deadlineAt"] as const;
const ATTESTATION_KEYS = [...HELLO_KEYS, "childCreationTime", "peerPid", "peerCreationTime",
  "ownerPid", "ownerCreationTime", "ownerImageSha256"] as const;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const U64 = /^[1-9][0-9]{0,19}$/;
const U64_MAX = 18446744073709551615n;
export const MAX_OWNER_BOOTSTRAP_MS = 30_000;

function invalid(reason: string): never {
  throw new TypeError(`Windows owner ${reason}.`);
}

/** Reject accessors before reading any property; untrusted input never gets to run a getter. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid("record is invalid");
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid("record keys are invalid");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid("record properties are invalid");
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function pid(value: unknown): value is number {
  return positive(value) && value <= 0xffff_ffff;
}

function creationTime(value: unknown): value is string {
  return typeof value === "string" && U64.test(value) && BigInt(value) <= U64_MAX;
}

/** Validates syntax only; real peer/process-handle verification belongs to the native port. */
export function canonicalWindowsOwnerHello(value: unknown): WindowsOwnerHelloV1 {
  const input = record(value, HELLO_KEYS);
  if (input.kind !== "windows-owner-hello" || input.version !== 1 || !pid(input.childPid)
    || !positive(input.childGeneration) || !positive(input.deadlineAt)
    || [input.requestId, input.sessionId, input.challenge, input.pipeInstanceId]
      .some((item) => typeof item !== "string" || !TOKEN.test(item))) invalid("hello is invalid");
  return Object.freeze({ ...input }) as WindowsOwnerHelloV1;
}

export function canonicalWindowsOwnerAttestation(value: unknown): WindowsOwnerAttestationV1 {
  const input = record(value, ATTESTATION_KEYS);
  if (input.kind !== "windows-owner-attestation") invalid("attestation kind is invalid");
  const hello: Record<string, unknown> = {};
  for (const key of HELLO_KEYS) hello[key] = key === "kind" ? "windows-owner-hello" : input[key];
  canonicalWindowsOwnerHello(hello);
  if (!creationTime(input.childCreationTime) || !creationTime(input.peerCreationTime)
    || !creationTime(input.ownerCreationTime) || !pid(input.peerPid) || !pid(input.ownerPid)
    || input.peerPid === input.childPid || input.ownerPid === input.childPid || input.ownerPid === input.peerPid
    || typeof input.ownerImageSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.ownerImageSha256)) {
    invalid("attestation identity is invalid");
  }
  return Object.freeze({ ...input }) as WindowsOwnerAttestationV1;
}

/** Single-use correlation gate; its result intentionally has no authority brand. */
export class WindowsOwnerGate {
  readonly #generation: number;
  readonly #now: () => number;
  readonly #pipeInstanceId: string;
  #pending: WindowsOwnerHelloV1 | null = null;
  #closed = false;
  #lastTime: number;

  constructor(options: { generation: number; now: () => number; pipeInstanceId?: string }) {
    if (!positive(options.generation) || typeof options.now !== "function") invalid("gate options are invalid");
    this.#generation = options.generation;
    this.#now = options.now;
    this.#lastTime = this.#now();
    if (!Number.isSafeInteger(this.#lastTime) || this.#lastTime < 0) invalid("clock is invalid");
    this.#pipeInstanceId = options.pipeInstanceId ?? randomBytes(24).toString("base64url");
    if (!TOKEN.test(this.#pipeInstanceId)) invalid("pipe instance is invalid");
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < this.#lastTime) {
      this.revoke();
      invalid("clock reversed or invalid");
    }
    this.#lastTime = now;
    return now;
  }

  hello(options: { childPid: number; deadlineAt: number }): WindowsOwnerHelloV1 {
    if (this.#closed || this.#pending) invalid("gate is closed or pending");
    const now = this.#time();
    if (!pid(options.childPid) || !positive(options.deadlineAt) || options.deadlineAt <= now
      || options.deadlineAt - now > MAX_OWNER_BOOTSTRAP_MS) invalid("hello deadline or PID is invalid");
    this.#pending = canonicalWindowsOwnerHello({
      kind: "windows-owner-hello", version: 1,
      requestId: randomBytes(24).toString("base64url"), sessionId: randomBytes(24).toString("base64url"),
      challenge: randomBytes(32).toString("base64url"), childPid: options.childPid,
      childGeneration: this.#generation, pipeInstanceId: this.#pipeInstanceId, deadlineAt: options.deadlineAt,
    });
    return this.#pending;
  }

  accept(value: unknown): WindowsOwnerAttestationV1 {
    if (this.#closed || !this.#pending) invalid("gate is closed or has no challenge");
    if (this.#time() >= this.#pending.deadlineAt) {
      this.revoke();
      invalid("challenge expired");
    }
    const reply = canonicalWindowsOwnerAttestation(value);
    for (const key of HELLO_KEYS) {
      if (key !== "kind" && reply[key] !== this.#pending[key]) invalid("attestation binding does not match");
    }
    this.revoke();
    return reply;
  }

  revoke(): void {
    this.#closed = true;
    this.#pending = null;
  }
}
