import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalNativePlatformRequest, decodeNativePlatformRequest, encodeNativePlatformRequest,
  NativeTransferReceiver, NATIVE_LIMITS,
} from "../src/native-platform-protocol.js";

const base = { kind: "native-platform-request", version: 1, requestId: "r".repeat(32), childGeneration: 7 } as const;
const lease = { ref: "l".repeat(32), runId: "run-1", epoch: 1, generation: "g".repeat(32) };
const root = "w".repeat(32);

test("the first journal compare-and-replace uses expected revision zero", () => {
  const request = { ...base, operation: "write-private-journal", journalRef: root, revision: 0, transferId: root };
  assert.deepEqual(decodeNativePlatformRequest(encodeNativePlatformRequest(request)), request);
  assert.throws(() => canonicalNativePlatformRequest({ ...request, revision: -1 }));
});

test("native RPC accepts a closed operation union, never arbitrary methods or raw handles", () => {
  const requests = [
    { ...base, operation: "open-ntfs-root", path: "C:\\project", purpose: "project" },
    { ...base, operation: "create-private-run", homeRef: root, runId: "run-1" },
    { ...base, operation: "read-private-journal", journalRef: root, maxBytes: NATIVE_LIMITS.journalBytes },
    { ...base, operation: "write-private-journal", journalRef: root, revision: 1, transferId: root },
    { ...base, operation: "snapshot-tree", rootRef: root },
    { ...base, operation: "copy-workspace", sourceRef: root, destinationRef: "d".repeat(32), lease },
    { ...base, operation: "inspect-executable", path: "C:\\runtime\\node.exe" },
    { ...base, operation: "prepare-sandbox", lease, binaries: [root] },
    { ...base, operation: "execute-tool", lease, spec: { executableRef: root, argv: ["--version"], cwdRef: root, env: {}, timeoutMs: 1000 } },
    { ...base, operation: "retire-run", lease },
    { ...base, operation: "quiesce-run", lease, drainMs: 500 },
    { ...base, operation: "publish-exact", lease, originalRef: root, candidateHash: "a".repeat(64), effectsTransferId: root, journalRef: root },
    { ...base, operation: "cancel-request", targetRequestId: "t".repeat(32) },
  ];
  for (const request of requests) {
    assert.deepEqual(decodeNativePlatformRequest(encodeNativePlatformRequest(request)), request);
    assert.throws(() => canonicalNativePlatformRequest({ ...request, rawHandle: "123" }));
    assert.throws(() => canonicalNativePlatformRequest({ ...request, childGeneration: 0 }));
  }
  for (const operation of ["spawn", "eval", "shell", "SetNamedSecurityInfoW", "__proto__"]) {
    assert.throws(() => canonicalNativePlatformRequest({ ...base, operation }));
  }
});

test("RPC frames reject duplicate JSON, oversized messages and accessor bodies", () => {
  const request = { ...base, operation: "snapshot-tree", rootRef: root };
  const duplicate = Buffer.from(JSON.stringify(request).replace('"version":1', '"version":1,"version":1'));
  assert.throws(() => decodeNativePlatformRequest(duplicate));
  assert.throws(() => decodeNativePlatformRequest(Buffer.alloc(4097, 32)));
  let calls = 0;
  const getter = { ...request };
  Object.defineProperty(getter, "rootRef", { enumerable: true, get() { calls++; return root; } });
  assert.throws(() => canonicalNativePlatformRequest(getter));
  assert.equal(calls, 0);
  assert.throws(() => canonicalNativePlatformRequest({ ...base, operation: "execute-tool", lease,
    spec: { executableRef: root, argv: [], cwdRef: root, env: { TOKEN: "not-allowed\0" }, timeoutMs: 1000 } }));
});

test("array canonicalization cannot invoke inherited methods or skip element validation", () => {
  let mapCalls = 0;
  const argv: unknown[] = [];
  Object.setPrototypeOf(argv, { map() { mapCalls++; return [42]; } });
  const request = { ...base, operation: "execute-tool", lease,
    spec: { executableRef: root, argv, cwdRef: root, env: {}, timeoutMs: 1000 } };
  assert.throws(() => canonicalNativePlatformRequest(request));
  assert.equal(mapCalls, 0);
  assert.throws(() => canonicalNativePlatformRequest({ ...request, spec: { ...request.spec, argv: Array(1) } }));
  let getterCalls = 0;
  const getter: unknown[] = ["safe"];
  Object.defineProperty(getter, "0", { get() { getterCalls++; return "unsafe"; } });
  assert.throws(() => canonicalNativePlatformRequest({ ...request, spec: { ...request.spec, argv: getter } }));
  assert.equal(getterCalls, 0);
});

function receiver(data: Uint8Array, purpose: "staging-file" | "tree" | "journal" | "interactive-read" = "staging-file") {
  return new NativeTransferReceiver({ transferId: root, childGeneration: 7, purpose,
    totalBytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), entries: 1 });
}

test("transfer is sequential, bounded, hash-checked and poisoned on invalid chunks", () => {
  const data = Buffer.alloc(2049, 65);
  const transfer = receiver(data);
  transfer.chunk({ transferId: root, childGeneration: 7, sequence: 0, data: data.subarray(0, 2048).toString("base64url") });
  transfer.chunk({ transferId: root, childGeneration: 7, sequence: 1, data: data.subarray(2048).toString("base64url") });
  assert.deepEqual(transfer.finish(), { totalBytes: 2049, sha256: createHash("sha256").update(data).digest("hex") });
  assert.throws(() => transfer.finish());
  for (const delta of [{ sequence: 1 }, { childGeneration: 8 }, { transferId: "z".repeat(32) },
    { data: data.toString("base64url") }, { data: "QQ==" }, { data: "" }, { rawHandle: 3 }]) {
    const bad = receiver(data);
    assert.throws(() => bad.chunk({ transferId: root, childGeneration: 7, sequence: 0,
      data: data.subarray(0, 2048).toString("base64url"), ...delta }));
    assert.throws(() => bad.chunk({ transferId: root, childGeneration: 7, sequence: 0, data: "QQ" }));
  }
  const corrupt = receiver(Buffer.from("A"));
  corrupt.chunk({ transferId: root, childGeneration: 7, sequence: 0, data: "Qg" });
  assert.throws(() => corrupt.finish(), /hash/i);
  const truncated = receiver(Buffer.from("A"));
  assert.throws(() => truncated.finish(), /size|length/i);
});

test("transfer cancellation forbids later chunks and empty transfers have a real digest", () => {
  const transfer = receiver(Buffer.from("A"));
  transfer.cancel();
  transfer.cancel();
  assert.throws(() => transfer.chunk({ transferId: root, childGeneration: 7, sequence: 0, data: "QQ" }));
  assert.throws(() => transfer.finish());
  assert.equal(receiver(Buffer.alloc(0)).finish().totalBytes, 0);
});

test("file, tree, entry, interactive-read and journal budgets remain distinct", () => {
  const limits = { "staging-file": 32 * 1024 ** 2, tree: 512 * 1024 ** 2,
    journal: 720 * 1024 ** 2, "interactive-read": 1_500_000 } as const;
  for (const [purpose, totalBytes] of Object.entries(limits)) {
    const begin = { transferId: root, childGeneration: 7, purpose, totalBytes, sha256: "a".repeat(64), entries: 1 };
    assert.doesNotThrow(() => new NativeTransferReceiver(begin));
    assert.throws(() => new NativeTransferReceiver({ ...begin, totalBytes: totalBytes + 1 }));
  }
  assert.throws(() => new NativeTransferReceiver({ transferId: root, childGeneration: 7,
    purpose: "tree", totalBytes: 1, sha256: "a".repeat(64), entries: 100001 }));
});
