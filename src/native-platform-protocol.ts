import { createHash } from "node:crypto";
import { parseStrictJsonValue } from "./kimi-provider-request-digest.js";
import type { NativePurpose, NativeRef, RunLease, ToolSpec } from "./native-platform-port.js";

export const NATIVE_LIMITS = Object.freeze({ payloadBytes: 4096, chunkBytes: 2048,
  stagingFileBytes: 32 * 1024 ** 2, treeBytes: 512 * 1024 ** 2, entries: 100_000,
  interactiveReadBytes: 1_500_000, journalBytes: 720 * 1024 ** 2, queueDepth: 32 });

type Fence = Readonly<{ kind: "native-platform-request"; version: 1; requestId: string; childGeneration: number }>;
export type NativePlatformRequest = Fence & (
  | Readonly<{ operation: "open-ntfs-root"; path: string; purpose: NativePurpose }>
  | Readonly<{ operation: "create-private-run"; homeRef: NativeRef; runId: string }>
  | Readonly<{ operation: "read-private-journal"; journalRef: NativeRef; maxBytes: number }>
  | Readonly<{ operation: "write-private-journal"; journalRef: NativeRef; revision: number; transferId: string }>
  | Readonly<{ operation: "snapshot-tree"; rootRef: NativeRef }>
  | Readonly<{ operation: "copy-workspace"; sourceRef: NativeRef; destinationRef: NativeRef; lease: RunLease }>
  | Readonly<{ operation: "inspect-executable"; path: string }>
  | Readonly<{ operation: "prepare-sandbox"; lease: RunLease; binaries: readonly NativeRef[] }>
  | Readonly<{ operation: "execute-tool"; lease: RunLease; spec: ToolSpec }>
  | Readonly<{ operation: "retire-run"; lease: RunLease }>
  | Readonly<{ operation: "quiesce-run"; lease: RunLease; drainMs: number }>
  | Readonly<{ operation: "publish-exact"; lease: RunLease; originalRef: NativeRef; candidateHash: string;
      effectsTransferId: string; journalRef: NativeRef }>
  | Readonly<{ operation: "cancel-request"; targetRequestId: string }>
);

type Validator = (value: unknown) => unknown;
function invalid(reason: string): never { throw new TypeError(`Native platform ${reason}.`); }
function dataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) invalid("record invalid");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) invalid("properties invalid");
  }
  return value as Record<string, unknown>;
}
function shape(value: unknown, schema: Readonly<Record<string, Validator>>): Readonly<Record<string, unknown>> {
  const input = dataRecord(value);
  const keys = Object.keys(schema);
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid("keys invalid");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, schema[key]!(input[key])])));
}
const literal = (expected: unknown): Validator => (value) => value === expected ? value : invalid("tag invalid");
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER): Validator => (value) =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? value : invalid("integer invalid");
const text = (max: number, empty = false): Validator => (value) => typeof value === "string"
  && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid("string invalid");
const token: Validator = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : invalid("reference invalid");
const digest: Validator = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : invalid("hash invalid");
const oneOf = (...values: readonly string[]): Validator => (value) => typeof value === "string" && values.includes(value) ? value : invalid("choice invalid");
const array = (element: Validator, max: number): Validator => (value) => {
  if (!Array.isArray(value) || value.length > max) invalid("array invalid");
  // No holes, attached properties or getters; map alone would silently skip holes.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid("array properties invalid");
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) invalid("array property invalid");
  }
  return Object.freeze(value.map(element));
};
const lease: Validator = (value) => shape(value, { ref: token, runId: text(256), epoch: integer(1), generation: token });
const env: Validator = (value) => {
  const input = dataRecord(value);
  if (Object.keys(input).length > 64) invalid("environment too large");
  const seen = new Set<string>();
  for (const [key, item] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || seen.has(key.toUpperCase())) invalid("environment key invalid");
    seen.add(key.toUpperCase());
    text(2048, true)(item);
  }
  return Object.freeze({ ...input });
};
const spec: Validator = (value) => shape(value, { executableRef: token, argv: array(text(2048, true), 128),
  cwdRef: token, env, timeoutMs: integer(1, 300_000) });
const OPERATIONS: Readonly<Record<string, Readonly<Record<string, Validator>>>> = Object.freeze({
  "open-ntfs-root": { path: text(2048), purpose: oneOf("project", "app-home", "work", "scratch") },
  "create-private-run": { homeRef: token, runId: text(256) },
  "read-private-journal": { journalRef: token, maxBytes: integer(1, NATIVE_LIMITS.journalBytes) },
  "write-private-journal": { journalRef: token, revision: integer(1), transferId: token },
  "snapshot-tree": { rootRef: token },
  "copy-workspace": { sourceRef: token, destinationRef: token, lease },
  "inspect-executable": { path: text(2048) },
  "prepare-sandbox": { lease, binaries: array(token, 32) },
  "execute-tool": { lease, spec },
  "retire-run": { lease },
  "quiesce-run": { lease, drainMs: integer(1, 30_000) },
  "publish-exact": { lease, originalRef: token, candidateHash: digest, effectsTransferId: token, journalRef: token },
  "cancel-request": { targetRequestId: token },
});

export function canonicalNativePlatformRequest(value: unknown): NativePlatformRequest {
  const input = dataRecord(value);
  if (typeof input.operation !== "string" || !Object.hasOwn(OPERATIONS, input.operation)) invalid("operation invalid");
  return shape(input, { kind: literal("native-platform-request"), version: literal(1), requestId: token,
    childGeneration: integer(1), operation: literal(input.operation), ...OPERATIONS[input.operation] }) as NativePlatformRequest;
}

export function encodeNativePlatformRequest(value: unknown): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(canonicalNativePlatformRequest(value)), "utf8");
  if (bytes.length > NATIVE_LIMITS.payloadBytes) invalid("payload too large");
  return bytes;
}

export function decodeNativePlatformRequest(bytes: Uint8Array): NativePlatformRequest {
  if (bytes.byteLength > NATIVE_LIMITS.payloadBytes) invalid("payload too large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return canonicalNativePlatformRequest(parseStrictJsonValue(text));
}

type TransferPurpose = "staging-file" | "tree" | "journal" | "interactive-read";
type TransferBegin = Readonly<{ transferId: string; childGeneration: number; purpose: TransferPurpose;
  totalBytes: number; sha256: string; entries: number }>;

/** Streams only verified-size chunks; caller must stage data and commit only after finish(). */
export class NativeTransferReceiver {
  readonly #begin: TransferBegin;
  readonly #hash = createHash("sha256");
  #sequence = 0;
  #bytes = 0;
  #closed = false;

  constructor(value: unknown) {
    this.#begin = shape(value, { transferId: token, childGeneration: integer(1),
      purpose: oneOf("staging-file", "tree", "journal", "interactive-read"), totalBytes: integer(0),
      sha256: digest, entries: integer(0, NATIVE_LIMITS.entries) }) as TransferBegin;
    const limit = { "staging-file": NATIVE_LIMITS.stagingFileBytes, tree: NATIVE_LIMITS.treeBytes,
      journal: NATIVE_LIMITS.journalBytes, "interactive-read": NATIVE_LIMITS.interactiveReadBytes }[this.#begin.purpose];
    if (this.#begin.totalBytes > limit || (this.#begin.purpose !== "tree" && this.#begin.entries !== 1)) invalid("transfer budget exceeded");
  }

  chunk(value: unknown): Uint8Array {
    if (this.#closed) invalid("transfer closed");
    try {
      const input = shape(value, { transferId: token, childGeneration: integer(1), sequence: integer(0), data: text(2731) });
      if (input.transferId !== this.#begin.transferId || input.childGeneration !== this.#begin.childGeneration
        || input.sequence !== this.#sequence || typeof input.data !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.data)) invalid("chunk binding invalid");
      const bytes = Buffer.from(input.data, "base64url");
      if (bytes.length === 0 || bytes.length > NATIVE_LIMITS.chunkBytes || bytes.toString("base64url") !== input.data
        || this.#bytes + bytes.length > this.#begin.totalBytes) invalid("chunk size or encoding invalid");
      this.#hash.update(bytes);
      this.#bytes += bytes.length;
      this.#sequence++;
      return bytes;
    } catch (error) { this.cancel(); throw error; }
  }

  finish(): Readonly<{ totalBytes: number; sha256: string }> {
    if (this.#closed) invalid("transfer closed");
    this.#closed = true;
    if (this.#bytes !== this.#begin.totalBytes) invalid("transfer size mismatch");
    const sha256 = this.#hash.digest("hex");
    if (sha256 !== this.#begin.sha256) invalid("transfer hash mismatch");
    return Object.freeze({ totalBytes: this.#bytes, sha256 });
  }

  cancel(): void { this.#closed = true; }
}
