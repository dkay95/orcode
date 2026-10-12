import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteIdentityV1 } from "../src/backends.js";
import {
  KimiDesktopPermitReader,
  KimiDesktopPermitRequiredError,
  hasCurrentKimiPackagedRuntimeAttestation,
  type KimiCrossRequestBinding,
  type KimiCrossRunAuthority,
} from "../src/kimi-desktop-permit.js";
import {
  NativeSidecarChannel,
  createKimiRequestId,
  decodeActionFrame,
  decodePrivateActionFrame,
  encodeControlFrame,
  type KimiDesktopControlRecord,
  type KimiNativeActionRecord,
  type KimiNativeActionRequest,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";
import {
  digestFinalKimiProviderRequest,
  type FinalKimiProviderRequestV1,
} from "../src/kimi-provider-request-digest.js";
import type { CrossProviderStage } from "../src/collaboration.js";
import { createDesktopKimiRuntimeCapability } from "../src/kimi-execution-origin.js";

const kimiLead: RouteIdentityV1 = {
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "lead-account",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "k3",
  canonicalModelId: "k3",
  resolutionState: "resolved",
};
const kimiChallenger: RouteIdentityV1 = {
  ...kimiLead,
  accountFingerprint: "challenger-account",
  requestedModelId: "k3-256k",
  canonicalModelId: "k3-256k",
};

function finalRequest(model = "k3"): FinalKimiProviderRequestV1 {
  return {
    version: 1,
    url: "https://api.kimi.com/coding/v1/chat/completions",
    method: "POST",
    model,
    headers: [["accept", "application/json"]],
    credentialHeaders: ["authorization"],
    messages: [{ role: "user", content: "task", reasoningContent: null, toolCalls: [], toolCallId: null }],
    tools: [],
    options: {
      maxCompletionTokens: null,
      promptCacheKey: null,
      reasoningEffort: "high",
      stream: true,
      thinking: null,
      toolChoice: null,
    },
  };
}

async function consumeCrossStage(
  authority: KimiCrossRunAuthority,
  crossRunId: string,
  stage: CrossProviderStage,
  route: RouteIdentityV1,
  effect: (request: FinalKimiProviderRequestV1) => Promise<void>,
): Promise<void> {
  const request = finalRequest(route.canonicalModelId!);
  await authority.runStage({ crossRunId, stage, route }, async (scope) => {
    await scope.consumeRequest({
      requestId: createKimiRequestId(),
      crossRunId,
      stage,
      route,
      request,
      requestDigest: digestFinalKimiProviderRequest(request),
    }, effect);
  });
}

function permitChannel(
  reply: (request: KimiNativeActionRequest) => KimiDesktopControlRecord | null,
): { channel: NativeSidecarChannel; writes: KimiNativeActionRequest[] } {
  const writes: KimiNativeActionRequest[] = [];
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const { decodeActionFrame } = await import("../src/native-sidecar-channel.js");
      const request = decodeActionFrame(frame);
      if (request.kind === "revoke") throw new Error("unexpected revocation");
      writes.push(request);
      const control = reply(request);
      if (control) controls.push(encodeControlFrame(control));
      wake?.();
      wake = null;
    },
    async readControl() {
      while (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift()!;
    },
    close() { wake?.(); wake = null; },
  };
  return { channel: new NativeSidecarChannel(transport), writes };
}

test("packaged startup attestation hashes an opened no-follow executable and is one-use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orcode-attestation-"));
  const executablePath = join(dir, "orcode-gui");
  const bytes = Buffer.from("signed-executable-fixture");
  await writeFile(executablePath, bytes, { mode: 0o700 });
  const info = await stat(executablePath);
  let response: Uint8Array | null = null;
  const channel = new NativeSidecarChannel({
    async writeAction(frame) {
      const request = decodePrivateActionFrame(frame);
      assert.equal(request.kind, "packaged-startup");
      if (request.kind !== "packaged-startup") return;
      response = encodeControlFrame({ ...request, kind: "packaged-attestation", generation: 1,
        executablePath, executableDevice: info.dev, executableInode: info.ino, executableSize: info.size,
        policySha256: "b".repeat(64), executableSha256: createHash("sha256").update(bytes).digest("hex") });
    },
    async readControl() {
      if (response === null) return new Promise<Uint8Array | null>(() => {});
      const value = response;
      response = null;
      return value;
    },
    close() {},
  });
  const reader = new KimiDesktopPermitReader(channel);
  const attestation = await reader.consumePackagedStartup();
  assert.equal(attestation.executableSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(hasCurrentKimiPackagedRuntimeAttestation(attestation), true);
  assert.throws(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: reader, childPid: process.pid + 1, generation: 1, now: Date.now, emitRequirement() {} }), /attestation|capability/i);
  assert.throws(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: reader, childPid: process.pid, generation: 2, now: Date.now, emitRequirement() {} }), /attestation|capability/i);
  assert.throws(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: new KimiDesktopPermitReader(new NativeSidecarChannel({ async writeAction() {}, async readControl() { return null; }, close() {} })), childPid: process.pid, generation: 1, now: Date.now, emitRequirement() {} }), /attestation|capability/i);
  assert.throws(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: reader, childPid: process.pid, generation: 1, now: Date.now, emitRequirement() {}, extra: true } as never), /capability/i);
  assert.doesNotThrow(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: reader, childPid: process.pid, generation: 1, now: Date.now, emitRequirement() {} }));
  assert.equal(hasCurrentKimiPackagedRuntimeAttestation(attestation), false);
  assert.throws(() => createDesktopKimiRuntimeCapability(attestation, { permitReader: reader, childPid: process.pid, generation: 1, now: Date.now, emitRequirement() {} }), /attestation|capability/i);
  await assert.rejects(reader.consumePackagedStartup(), KimiDesktopPermitRequiredError);
  reader.close("restart");
  assert.equal(hasCurrentKimiPackagedRuntimeAttestation(attestation), false);

  let changed: Uint8Array | null = null;
  const changedReader = new KimiDesktopPermitReader(new NativeSidecarChannel({
    async writeAction(frame) { const request = decodePrivateActionFrame(frame); if (request.kind === "packaged-startup") changed = encodeControlFrame({ ...request, kind: "packaged-attestation", generation: 2, executablePath, executableDevice: info.dev, executableInode: info.ino, executableSize: info.size, policySha256: "b".repeat(64), executableSha256: "c".repeat(64) }); },
    async readControl() { const value = changed; changed = null; return value; }, close() {},
  }));
  await assert.rejects(changedReader.consumePackagedStartup(), KimiDesktopPermitRequiredError);
  assert.equal(changedReader.isOpen, false);
});

test("packaged startup and action writes are deadline bounded and close the compromised channel", async () => {
  for (const kind of ["startup", "turn"] as const) {
    let closes = 0;
    const channel = new NativeSidecarChannel({
      writeAction() { return new Promise<void>(() => {}); },
      readControl() { return new Promise<Uint8Array | null>(() => {}); },
      close() { closes += 1; },
    });
    const reader = new KimiDesktopPermitReader(channel);
    const pending = kind === "startup"
      ? reader.consumePackagedStartup(10)
      : reader.consumeTurn({
        requestId: createKimiRequestId(), sessionId: "bounded", childPid: 4242, runId: "bounded",
        route: kimiLead, requestDigest: digestFinalKimiProviderRequest(finalRequest()), revision: 1,
        generation: 2, deadlineAt: Date.now() + 10,
      });
    const outcome = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    assert.equal(outcome, "rejected", kind);
    assert.equal(closes, 1, kind);
    assert.equal(reader.isOpen, false, kind);
  }
});

test("a stalled revocation never delays caller settlement or a later closed-reader rejection", async () => {
  let writes = 0;
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel({
    writeAction() {
      writes += 1;
      if (writes === 1) return Promise.resolve();
      return new Promise<void>(() => {});
    },
    readControl() { return new Promise<Uint8Array | null>(() => {}); },
    close() {},
  }));
  const binding = {
    requestId: createKimiRequestId(), sessionId: "revoke-bound", childPid: 4242, runId: "revoke-bound",
    route: kimiLead, requestDigest: digestFinalKimiProviderRequest(finalRequest()), revision: 1,
    generation: 2, deadlineAt: Date.now() + 15,
  };
  const outcome = await Promise.race([
    reader.consumeTurn(binding).then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 50)),
  ]);
  assert.equal(outcome, "rejected");
  await assert.rejects(reader.consumeTurn({ ...binding, requestId: createKimiRequestId() }), KimiDesktopPermitRequiredError);
});

test("turn permit is consumed once before credential authority", async () => {
  let credentialAuthorityCalls = 0;
  const request = finalRequest();
  const requestDigest = digestFinalKimiProviderRequest(request);
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-1",
    childPid: 4242,
    runId: "run-1",
    route: kimiLead,
    requestDigest,
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  await reader.consumeTurn(binding);
  await assert.rejects(reader.consumeTurn(binding), KimiDesktopPermitRequiredError);
  assert.equal(credentialAuthorityCalls, 0);
  reader.close("end");
});

test("concurrent consumers reserve the same turn permit before either await", async () => {
  const request = finalRequest();
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-concurrent",
    childPid: 4242,
    runId: "run-concurrent",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(request),
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel, writes } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "DDDDDDDDDDDDDDDDDDDDDD",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  const settled = await Promise.allSettled([
    reader.consumeTurn(binding),
    reader.consumeTurn(binding),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(writes.length, 1);
  reader.close("end");
});

test("unknown control closes the reader and rejects current and future effects", async () => {
  const makeBinding = (runId: string) => ({
    requestId: createKimiRequestId(),
    sessionId: "session-unknown-control",
    childPid: 4242,
    runId,
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  });
  const firstBinding = makeBinding("run-first");
  const secondBinding = makeBinding("run-second");
  const unknownRequest: KimiNativeActionRequest = {
    kind: "kimi-turn",
    ...makeBinding("run-unknown"),
  };
  const controls = [encodeControlFrame({
    kind: "permit",
    request: unknownRequest,
    nonce: "FFFFFFFFFFFFFFFFFFFFFF",
  })];
  let wake: (() => void) | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const { decodeActionFrame } = await import("../src/native-sidecar-channel.js");
      const request = decodeActionFrame(frame);
      if (request.kind === "revoke") throw new Error("unexpected revocation");
      controls.push(encodeControlFrame({
        kind: "permit",
        request,
        nonce: "GGGGGGGGGGGGGGGGGGGGGG",
      }));
      wake?.();
      wake = null;
    },
    async readControl() {
      while (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift()!;
    },
    close() { wake?.(); wake = null; },
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  let effects = 0;
  const first = reader.consumeTurn(firstBinding).then(() => { effects += 1; });
  const second = reader.consumeTurn(secondBinding).then(() => { effects += 1; });

  const settled = await Promise.allSettled([first, second]);

  assert.deepEqual(settled.map(({ status }) => status), ["rejected", "rejected"]);
  await assert.rejects(reader.consumeTurn(makeBinding("run-future")), KimiDesktopPermitRequiredError);
  assert.equal(effects, 0);
  assert.equal(reader.isOpen, false);
});

test("permit control rechecks the absolute deadline when it settles", async () => {
  let now = 1_000;
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-deadline-settlement",
    childPid: 4242,
    runId: "run-deadline-settlement",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
    deadlineAt: 1_100,
  };
  let releaseControl!: () => void;
  let markActionWritten!: () => void;
  const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
  const actionWritten = new Promise<void>((resolve) => { markActionWritten = resolve; });
  let control: Uint8Array | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const { decodeActionFrame } = await import("../src/native-sidecar-channel.js");
      const request = decodeActionFrame(frame);
      if (request.kind === "revoke") throw new Error("unexpected revocation");
      control = encodeControlFrame({
        kind: "permit",
        request,
        nonce: "HHHHHHHHHHHHHHHHHHHHHH",
      });
      markActionWritten();
    },
    async readControl() {
      await actionWritten;
      await controlGate;
      return control;
    },
    close() {},
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport), () => now);
  let effects = 0;
  const result = reader.consumeTurn(binding).then(() => { effects += 1; });
  await actionWritten;
  now = binding.deadlineAt;
  releaseControl();

  await assert.rejects(result, KimiDesktopPermitRequiredError);
  assert.equal(effects, 0);
  assert.equal(reader.isOpen, false);
});

test("issued turn awaits the full action write before exposing only a fresh four-field requirement", async () => {
  const request = finalRequest();
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-issued",
    childPid: 4242,
    runId: "run-issued",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(request),
    revision: 8,
    generation: 5,
    deadlineAt: Date.now() + 60_000,
  };
  let releaseWrite!: () => void;
  let markWriteStarted!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
  let control: Uint8Array | null = null;
  let wake: (() => void) | null = null;
  let callbackCount = 0;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const action = decodeActionFrame(frame);
      markWriteStarted();
      await writeGate;
      if (action.kind !== "revoke") {
        control = encodeControlFrame({ kind: "permit", request: action, nonce: "IIIIIIIIIIIIIIIIIIIIII" });
        wake?.();
        wake = null;
      }
    },
    async readControl() {
      while (control === null) await new Promise<void>((resolve) => { wake = resolve; });
      const next = control;
      control = null;
      return next;
    },
    close() { wake?.(); wake = null; },
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  const issued = reader.issueTurn(binding, {
    onActionWritten(requirement) {
      callbackCount += 1;
      assert.equal(requirement.kind, "kimi-turn");
      throw new Error("projection-probe");
    },
  });
  await writeStarted;
  assert.equal(callbackCount, 0);
  releaseWrite();

  await assert.rejects(issued, /projection-probe/);
  assert.equal(callbackCount, 1);
  reader.close("end");

  const successful = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "JJJJJJJJJJJJJJJJJJJJJJ",
  }));
  const successfulReader = new KimiDesktopPermitReader(successful.channel);
  let exposed: unknown;
  await successfulReader.issueTurn({ ...binding, requestId: createKimiRequestId() }, {
    onActionWritten(requirement) { exposed = requirement; },
  });
  assert.deepEqual(exposed, {
    kind: "kimi-turn",
    revision: 8,
    generation: 5,
    purposeCode: "send-turn",
  });
  assert.deepEqual(Object.keys(exposed as object), ["kind", "revision", "generation", "purposeCode"]);
  successfulReader.close("end");
});

test("public callback failure writes one exact revocation and closes only on revoke failure", async () => {
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-public-failure",
    childPid: 4242,
    runId: "run-public-failure",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 3,
    generation: 4,
    deadlineAt: Date.now() + 60_000,
  };
  const writes: KimiNativeActionRecord[] = [];
  const transport: NativeSidecarTransport = {
    async writeAction(frame) { writes.push(decodeActionFrame(frame)); },
    async readControl() { return await new Promise<Uint8Array | null>(() => {}); },
    close() {},
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  await assert.rejects(
    reader.issueTurn(binding, {
      onActionWritten() { throw new Error("public projection failed"); },
    }),
    /public projection failed/,
  );
  assert.deepEqual(writes, [
    { kind: "kimi-turn", ...binding },
    {
      kind: "revoke",
      requestId: binding.requestId,
      sessionId: binding.sessionId,
      childPid: binding.childPid,
      revision: binding.revision,
      generation: binding.generation,
      deadlineAt: binding.deadlineAt,
    },
  ]);
  assert.equal(reader.isOpen, true);
  reader.close("end");

  const failingChannel = new NativeSidecarChannel({
    async writeAction(frame) {
      if (decodeActionFrame(frame).kind === "revoke") throw new Error("revoke write failed");
    },
    async readControl() { return await new Promise<Uint8Array | null>(() => {}); },
    close() {},
  });
  const failingReader = new KimiDesktopPermitReader(failingChannel);
  await assert.rejects(
    failingReader.issueTurn({ ...binding, requestId: createKimiRequestId() }, {
      onActionWritten() { throw new Error("public projection failed"); },
    }),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(failingReader.isOpen, false);
});

test("cancellation tombstone discards only its matching late control and preserves a later action", async () => {
  const writes: KimiNativeActionRecord[] = [];
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    const current = wake;
    wake = null;
    if (current) current();
  };
  const transport: NativeSidecarTransport = {
    async writeAction(frame) { writes.push(decodeActionFrame(frame)); },
    async readControl() {
      while (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift()!;
    },
    close() { wake?.(); wake = null; },
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-cancel",
    childPid: 4242,
    runId: "run-cancel",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const abort = new AbortController();
  let markProjected!: () => void;
  const projected = new Promise<void>((resolve) => { markProjected = resolve; });
  const first = reader.issueTurn(binding, {
    signal: abort.signal,
    onActionWritten() { markProjected(); },
  });
  await projected;
  abort.abort();
  await assert.rejects(first, KimiDesktopPermitRequiredError);
  assert.equal(writes[1]?.kind, "revoke");

  controls.push(encodeControlFrame({
    kind: "permit",
    request: writes[0] as KimiNativeActionRequest,
    nonce: "KKKKKKKKKKKKKKKKKKKKKK",
  }));
  notify();

  const nextBinding = { ...binding, requestId: createKimiRequestId(), runId: "run-next" };
  const next = reader.issueTurn(nextBinding, { onActionWritten() {} });
  while (writes.length < 3) await new Promise((resolve) => setImmediate(resolve));
  controls.push(encodeControlFrame({
    kind: "permit",
    request: writes[2] as KimiNativeActionRequest,
    nonce: "LLLLLLLLLLLLLLLLLLLLLL",
  }));
  notify();

  await next;
  assert.equal(reader.isOpen, true);
  reader.close("end");
});

test("a foreign late control cannot hide behind a cancellation tombstone", async () => {
  const writes: KimiNativeActionRecord[] = [];
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    const current = wake;
    wake = null;
    if (current) current();
  };
  const transport: NativeSidecarTransport = {
    async writeAction(frame) { writes.push(decodeActionFrame(frame)); },
    async readControl() {
      while (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift()!;
    },
    close() { const current = wake; wake = null; current?.(); },
  };
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport));
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-foreign-late",
    childPid: 4242,
    runId: "run-original",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const abort = new AbortController();
  const issued = reader.issueTurn(binding, { signal: abort.signal, onActionWritten() {} });
  while (writes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(issued, KimiDesktopPermitRequiredError);

  controls.push(encodeControlFrame({
    kind: "permit",
    request: { ...(writes[0] as Extract<KimiNativeActionRequest, { kind: "kimi-turn" }>), runId: "forged" },
    nonce: "MMMMMMMMMMMMMMMMMMMMMM",
  }));
  notify();
  while (reader.isOpen) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reader.isOpen, false);
});

test("expired and settled action history closes fail-closed at its generation cap", async () => {
  const historyCap = 1_024;
  let publicCallbacks = 0;
  const base = {
    sessionId: "session-history-cap",
    childPid: 4242,
    runId: "run-history-cap",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
  };
  const { channel, writes } = permitChannel((request) => ({
    kind: "permit",
    request,
    nonce: "NNNNNNNNNNNNNNNNNNNNNN",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  for (let index = 0; index < historyCap / 2; index += 1) {
    await assert.rejects(reader.issueTurn({
      ...base,
      requestId: createKimiRequestId(),
      deadlineAt: Date.now() - 1,
    }, { onActionWritten() { publicCallbacks += 1; } }), KimiDesktopPermitRequiredError);
  }
  for (let index = historyCap / 2; index < historyCap; index += 1) {
    await reader.issueTurn({
      ...base,
      requestId: createKimiRequestId(),
      deadlineAt: Date.now() + 60_000,
    }, { onActionWritten() { publicCallbacks += 1; } });
  }

  await assert.rejects(reader.issueTurn({
    ...base,
    requestId: createKimiRequestId(),
    deadlineAt: Date.now() + 60_000,
  }, { onActionWritten() { publicCallbacks += 1; } }), KimiDesktopPermitRequiredError);
  assert.equal(reader.isOpen, false);
  assert.equal(writes.length, historyCap / 2);
  assert.equal(publicCallbacks, historyCap / 2);
});

test("cancelled actions without late controls cannot exceed the generation history cap", async () => {
  const historyCap = 1_024;
  const writes: KimiNativeActionRecord[] = [];
  let wake: (() => void) | null = null;
  const reader = new KimiDesktopPermitReader(new NativeSidecarChannel({
    async writeAction(frame) { writes.push(decodeActionFrame(frame)); },
    async readControl() {
      return await new Promise<Uint8Array | null>((resolve) => { wake = () => resolve(null); });
    },
    close() { const current = wake; wake = null; current?.(); },
  }));
  const base = {
    sessionId: "session-cancel-cap",
    childPid: 4242,
    runId: "run-cancel-cap",
    route: kimiLead,
    requestDigest: digestFinalKimiProviderRequest(finalRequest()),
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  for (let index = 0; index < historyCap; index += 1) {
    const abort = new AbortController();
    let actionWritten!: () => void;
    const written = new Promise<void>((resolve) => { actionWritten = resolve; });
    const issued = reader.issueTurn({ ...base, requestId: createKimiRequestId() }, {
      signal: abort.signal,
      onActionWritten() { actionWritten(); },
    });
    await written;
    abort.abort();
    await assert.rejects(issued, KimiDesktopPermitRequiredError);
  }
  let nextCallback = 0;
  await assert.rejects(reader.issueTurn({
    ...base,
    requestId: createKimiRequestId(),
    deadlineAt: Date.now() + 20,
  }, {
    onActionWritten() { nextCallback += 1; },
  }), KimiDesktopPermitRequiredError);
  assert.equal(reader.isOpen, false);
  assert.equal(nextCallback, 0);
  assert.equal(writes.length, historyCap * 2);
});

test("Cross claim permits only the closed named stage graph", async () => {
  let providerCalls = 0;
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-1",
    childPid: 4242,
    crossRunId: "cross-1",
    lead: kimiLead,
    challenger: kimiChallenger,
    repairBudget: 1 as const,
    requestBudgetPerStage: 10,
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "BBBBBBBBBBBBBBBBBBBBBB",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  const authority = await reader.consumeCrossClaim(binding);
  assert.equal(JSON.stringify(authority), "{}", "run authority must not serialize its binding");

  const consume = async (stage: CrossProviderStage, route: RouteIdentityV1): Promise<void> => {
    await consumeCrossStage(authority, "cross-1", stage, route, async (immutableRequest) => {
      providerCalls += 1;
      assert.equal(Object.isFrozen(immutableRequest), true);
    });
  };

  await Promise.all([
    consume("lead-analysis", kimiLead),
    consume("challenger-analysis", kimiChallenger),
  ]);
  await consume("lead-implementation", kimiLead);
  await consume("challenger-review", kimiChallenger);
  await consume("lead-repair", kimiLead);
  await consume("challenger-repair-review", kimiChallenger);
  await assert.rejects(consume("lead-repair", kimiLead), KimiDesktopPermitRequiredError);
  assert.equal(providerCalls, 6);
  reader.close("end");
});

test("mixed Cross routes require every earlier applicable Kimi stage without serializing analyses", async () => {
  const mint = async (
    suffix: string,
    lead: RouteIdentityV1,
    challenger: RouteIdentityV1,
  ) => {
    const binding = {
      requestId: createKimiRequestId(),
      sessionId: `session-mixed-${suffix}`,
      childPid: 4242,
      crossRunId: `cross-mixed-${suffix}`,
      lead,
      challenger,
      repairBudget: 1 as const,
      requestBudgetPerStage: 4,
      revision: 1,
      generation: 2,
      deadlineAt: Date.now() + 60_000,
    };
    const { channel } = permitChannel((pending) => ({
      kind: "permit",
      request: pending,
      nonce: "MIXED_STAGE_PERMIT_123456",
    }));
    const reader = new KimiDesktopPermitReader(channel);
    return { binding, reader, authority: await reader.consumeCrossClaim(binding) };
  };
  const openLead = { ...kimiLead, backendId: "openrouter", billingRealm: "openrouter-payg" } as RouteIdentityV1;
  const openChallenger = { ...kimiChallenger, backendId: "openrouter", billingRealm: "openrouter-payg" } as RouteIdentityV1;

  const leadOnly = await mint("lead", kimiLead, openChallenger);
  await consumeCrossStage(leadOnly.authority, leadOnly.binding.crossRunId, "lead-analysis", kimiLead, async () => {});
  let leadDownstreamEffects = 0;
  await assert.rejects(
    consumeCrossStage(
      leadOnly.authority,
      leadOnly.binding.crossRunId,
      "lead-repair",
      kimiLead,
      async () => { leadDownstreamEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(leadDownstreamEffects, 0);
  leadOnly.reader.close("end");

  const challengerOnly = await mint("challenger", openLead, kimiChallenger);
  await consumeCrossStage(
    challengerOnly.authority,
    challengerOnly.binding.crossRunId,
    "challenger-analysis",
    kimiChallenger,
    async () => {},
  );
  let challengerDownstreamEffects = 0;
  await assert.rejects(
    consumeCrossStage(
      challengerOnly.authority,
      challengerOnly.binding.crossRunId,
      "challenger-repair-review",
      kimiChallenger,
      async () => { challengerDownstreamEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(challengerDownstreamEffects, 0);
  challengerOnly.reader.close("end");
});

test("revoked Cross authorities release reader ownership and retained bindings without reader close", async () => {
  const { channel } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "AUTHORITYDISPOSE123456",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  for (let index = 0; index < 4; index += 1) {
    const authority = await reader.consumeCrossClaim({
      requestId: createKimiRequestId(),
      sessionId: `session-dispose-${index}`,
      childPid: 4242,
      crossRunId: `cross-dispose-${index}`,
      lead: kimiLead,
      challenger: kimiChallenger,
      repairBudget: 0,
      requestBudgetPerStage: 2,
      revision: 1,
      generation: 2,
      deadlineAt: Date.now() + 60_000,
    });
    assert.equal(reader.readActiveCrossAuthorityCountForTest(), 1);
    authority.revoke("end");
    authority.revoke("stop");
    assert.equal(reader.readActiveCrossAuthorityCountForTest(), 0);
  }
  assert.equal(reader.isOpen, true);
  reader.close("end");
});

test("one Kimi Cross stage authorizes multiple fresh request effects within its bound budget", async () => {
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-multi-request",
    childPid: 4242,
    crossRunId: "cross-multi-request",
    lead: kimiLead,
    challenger: { ...kimiChallenger, backendId: "openrouter", billingRealm: "openrouter-payg" } as RouteIdentityV1,
    repairBudget: 0 as const,
    requestBudgetPerStage: 2,
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "MULTIREQUESTPERMIT1234",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  const authority = await reader.consumeCrossClaim(binding);
  const effectRequestIds: string[] = [];

  await authority.runStage({
    crossRunId: binding.crossRunId,
    stage: "lead-analysis",
    route: kimiLead,
  }, async (scope) => {
    for (const content of ["first", "second"]) {
      const request = finalRequest();
      (request.messages[0] as { content: string }).content = content;
      const requestId = createKimiRequestId();
      await scope.consumeRequest({
        requestId,
        crossRunId: binding.crossRunId,
        stage: "lead-analysis",
        route: kimiLead,
        request,
        requestDigest: digestFinalKimiProviderRequest(request),
      }, async (immutableRequest) => {
        effectRequestIds.push(requestId);
        assert.equal(Object.isFrozen(immutableRequest), true);
      });
    }
  });

  assert.equal(new Set(effectRequestIds).size, 2);
  reader.close("end");
});

test("Cross request replay, budget overflow, and zero-request settlement revoke before later effects", async () => {
  const mint = async (suffix: string, requestBudgetPerStage: number) => {
    const binding = {
      requestId: createKimiRequestId(),
      sessionId: `session-${suffix}`,
      childPid: 4242,
      crossRunId: `cross-${suffix}`,
      lead: kimiLead,
      challenger: { ...kimiChallenger, backendId: "openrouter", billingRealm: "openrouter-payg" } as RouteIdentityV1,
      repairBudget: 0 as const,
      requestBudgetPerStage,
      revision: 1,
      generation: 2,
      deadlineAt: Date.now() + 60_000,
    };
    const { channel } = permitChannel((pending) => ({
      kind: "permit",
      request: pending,
      nonce: "REQUESTLIMITPERMIT1234",
    }));
    const reader = new KimiDesktopPermitReader(channel);
    return { binding, reader, authority: await reader.consumeCrossClaim(binding) };
  };

  const overflow = await mint("overflow", 1);
  let overflowEffects = 0;
  await assert.rejects(overflow.authority.runStage({
    crossRunId: overflow.binding.crossRunId,
    stage: "lead-analysis",
    route: kimiLead,
  }, async (scope) => {
    for (const content of ["first", "overflow"]) {
      const request = finalRequest();
      (request.messages[0] as { content: string }).content = content;
      await scope.consumeRequest({
        requestId: createKimiRequestId(),
        crossRunId: overflow.binding.crossRunId,
        stage: "lead-analysis",
        route: kimiLead,
        request,
        requestDigest: digestFinalKimiProviderRequest(request),
      }, async () => { overflowEffects += 1; });
    }
  }), KimiDesktopPermitRequiredError);
  assert.equal(overflowEffects, 1);
  overflow.reader.close("end");

  const replay = await mint("replay", 2);
  let replayEffects = 0;
  const repeatedId = createKimiRequestId();
  await assert.rejects(replay.authority.runStage({
    crossRunId: replay.binding.crossRunId,
    stage: "lead-analysis",
    route: kimiLead,
  }, async (scope) => {
    const request = finalRequest();
    const requestBinding: KimiCrossRequestBinding = {
      requestId: repeatedId,
      crossRunId: replay.binding.crossRunId,
      stage: "lead-analysis",
      route: kimiLead,
      request,
      requestDigest: digestFinalKimiProviderRequest(request),
    };
    await scope.consumeRequest(requestBinding, async () => { replayEffects += 1; });
    await scope.consumeRequest(requestBinding, async () => { replayEffects += 1; });
  }), KimiDesktopPermitRequiredError);
  assert.equal(replayEffects, 1);
  replay.reader.close("end");

  const empty = await mint("empty", 2);
  let emptyEffects = 0;
  await assert.rejects(empty.authority.runStage({
    crossRunId: empty.binding.crossRunId,
    stage: "lead-analysis",
    route: kimiLead,
  }, async () => {}), KimiDesktopPermitRequiredError);
  await assert.rejects(
    consumeCrossStage(
      empty.authority,
      empty.binding.crossRunId,
      "lead-analysis",
      kimiLead,
      async () => { emptyEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(emptyEffects, 0);
  empty.reader.close("end");
});

test("Cross stage cancellation and detached scope work leave no later request effects", async () => {
  const binding = {
    requestId: createKimiRequestId(),
    sessionId: "session-cross-cancel",
    childPid: 4242,
    crossRunId: "cross-cancel",
    lead: kimiLead,
    challenger: { ...kimiChallenger, backendId: "openrouter", billingRealm: "openrouter-payg" } as RouteIdentityV1,
    repairBudget: 0 as const,
    requestBudgetPerStage: 2,
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel } = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "CROSSCANCELPERMIT12345",
  }));
  const reader = new KimiDesktopPermitReader(channel);
  const authority = await reader.consumeCrossClaim(binding);
  const controller = new AbortController();
  let entered!: () => void;
  const stageEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let effects = 0;
  const pending = authority.runStage({
    crossRunId: binding.crossRunId,
    stage: "lead-analysis",
    route: kimiLead,
    signal: controller.signal,
  }, async (scope) => {
    entered();
    await gate;
    const request = finalRequest();
    await scope.consumeRequest({
      requestId: createKimiRequestId(),
      crossRunId: binding.crossRunId,
      stage: "lead-analysis",
      route: kimiLead,
      request,
      requestDigest: digestFinalKimiProviderRequest(request),
    }, async () => { effects += 1; });
  });
  await stageEntered;
  controller.abort();
  release();
  await assert.rejects(pending, KimiDesktopPermitRequiredError);
  assert.equal(effects, 0);
  reader.close("end");
});

test("wrong, skipped, replayed, changed, denied, and closed claims fail before effects", async () => {
  const base = {
    requestId: createKimiRequestId(),
    sessionId: "session-1",
    childPid: 4242,
    crossRunId: "cross-negative",
    lead: kimiLead,
    challenger: kimiChallenger,
    repairBudget: 0 as const,
    requestBudgetPerStage: 10,
    revision: 1,
    generation: 2,
    deadlineAt: Date.now() + 60_000,
  };
  const { channel } = permitChannel((pending) => ({ kind: "permit", request: pending, nonce: "CCCCCCCCCCCCCCCCCCCCCC" }));
  const reader = new KimiDesktopPermitReader(channel);
  const authority = await reader.consumeCrossClaim(base);
  let effects = 0;
  await assert.rejects(
    consumeCrossStage(authority, base.crossRunId, "lead-implementation", kimiLead, async () => { effects += 1; }),
    KimiDesktopPermitRequiredError,
  );

  const changedBinding = { ...base, requestId: createKimiRequestId(), crossRunId: "cross-changed" };
  const changedChannel = permitChannel((pending) => ({
    kind: "permit",
    request: pending,
    nonce: "CHANGEDREQUESTPERMIT12",
  })).channel;
  const changedAuthority = await new KimiDesktopPermitReader(changedChannel).consumeCrossClaim(changedBinding);
  const changed = finalRequest();
  const staleDigest = digestFinalKimiProviderRequest(changed);
  (changed.messages[0] as { content: string }).content = "changed";
  await assert.rejects(
    changedAuthority.runStage({
      crossRunId: changedBinding.crossRunId,
      stage: "lead-analysis",
      route: kimiLead,
    }, async (scope) => scope.consumeRequest({
      requestId: createKimiRequestId(),
      crossRunId: changedBinding.crossRunId,
      stage: "lead-analysis",
      route: kimiLead,
      request: changed,
      requestDigest: staleDigest,
    }, async () => { effects += 1; })),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(effects, 0);

  const deniedBinding = { ...base, requestId: createKimiRequestId(), crossRunId: "denied" };
  const deniedChannel = permitChannel((pending) => ({
    kind: "denied",
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    childPid: pending.childPid,
    revision: pending.revision,
    generation: pending.generation,
    deadlineAt: pending.deadlineAt,
  })).channel;
  await assert.rejects(
    new KimiDesktopPermitReader(deniedChannel).consumeCrossClaim(deniedBinding),
    KimiDesktopPermitRequiredError,
  );

  reader.close("restart");
  await assert.rejects(reader.consumeCrossClaim({ ...base, requestId: createKimiRequestId() }), KimiDesktopPermitRequiredError);
});

test("running predecessors, full-route drift, impossible repair, and failed effects revoke before later calls", async () => {
  const mint = async (suffix: string, repairBudget: 0 | 1 = 1) => {
    const binding = {
      requestId: createKimiRequestId(),
      sessionId: `session-${suffix}`,
      childPid: 4242,
      crossRunId: `cross-${suffix}`,
      lead: kimiLead,
      challenger: kimiChallenger,
      repairBudget,
      requestBudgetPerStage: 10,
      revision: 1,
      generation: 2,
      deadlineAt: Date.now() + 60_000,
    };
    const { channel } = permitChannel((pending) => ({
      kind: "permit",
      request: pending,
      nonce: "EEEEEEEEEEEEEEEEEEEEEE",
    }));
    const reader = new KimiDesktopPermitReader(channel);
    return { binding, reader, authority: await reader.consumeCrossClaim(binding) };
  };
  const running = await mint("running");
  let releaseLead!: () => void;
  const leadGate = new Promise<void>((resolve) => { releaseLead = resolve; });
  const leadPromise = consumeCrossStage(
    running.authority,
    running.binding.crossRunId,
    "lead-analysis",
    kimiLead,
    () => leadGate,
  );
  await consumeCrossStage(
    running.authority,
    running.binding.crossRunId,
    "challenger-analysis",
    kimiChallenger,
    async () => {},
  );
  let implementationEffects = 0;
  await assert.rejects(
    consumeCrossStage(
      running.authority,
      running.binding.crossRunId,
      "lead-implementation",
      kimiLead,
      async () => { implementationEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  releaseLead();
  await assert.rejects(leadPromise, KimiDesktopPermitRequiredError);
  assert.equal(implementationEffects, 0);
  running.reader.close("end");

  const drift = await mint("drift");
  let driftEffects = 0;
  const wrongRoute = { ...kimiLead, requestedModelId: "changed-requested-model" };
  await assert.rejects(
    consumeCrossStage(
      drift.authority,
      drift.binding.crossRunId,
      "lead-analysis",
      wrongRoute,
      async () => { driftEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(driftEffects, 0);
  drift.reader.close("end");

  const noRepair = await mint("no-repair", 0);
  let repairEffects = 0;
  await assert.rejects(
    consumeCrossStage(
      noRepair.authority,
      noRepair.binding.crossRunId,
      "lead-repair",
      kimiLead,
      async () => { repairEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(repairEffects, 0);
  noRepair.reader.close("end");

  const failure = await mint("failure");
  await assert.rejects(consumeCrossStage(
    failure.authority,
    failure.binding.crossRunId,
    "lead-analysis",
    kimiLead,
    async () => { throw new Error("local fake failure"); },
  ), /local fake failure/);
  let laterEffects = 0;
  await assert.rejects(
    consumeCrossStage(
      failure.authority,
      failure.binding.crossRunId,
      "challenger-analysis",
      kimiChallenger,
      async () => { laterEffects += 1; },
    ),
    KimiDesktopPermitRequiredError,
  );
  assert.equal(laterEffects, 0);
  failure.reader.close("end");
});
