import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_FRAME_TAG,
  CONTROL_FRAME_TAG,
  MAX_NATIVE_SIDECAR_PAYLOAD_BYTES,
  NativeSidecarChannel,
  createFixedDescriptorTransportForTest,
  createKimiRequestId,
  canonicalCodexNativeActionRequest,
  canonicalCodexNativeActionResult,
  canonicalKimiDesktopControlRecord,
  canonicalKimiNativeActionRecord,
  decodeActionFrame,
  decodePrivateActionFrame,
  decodeControlFrame,
  encodeActionFrame,
  encodeControlFrame,
  type KimiNativeActionRecord,
  type KimiNativeActionRequest,
  type KimiNativeActionRevocation,
  type CodexNativeActionRequest,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";
import { digestFinalKimiProviderRequest } from "../src/kimi-provider-request-digest.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
const fixedDescriptorFactoryIsParameterless:
  Equal<Parameters<typeof NativeSidecarChannel.fromFixedDescriptors>, []> = true;
void fixedDescriptorFactoryIsParameterless;

function request(): Extract<KimiNativeActionRequest, { kind: "kimi-turn" }> {
  return {
    kind: "kimi-turn",
    requestId: createKimiRequestId(),
    sessionId: "session-1",
    childPid: 4242,
    runId: "run-1",
    route: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "account-1",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "k3",
      canonicalModelId: "k3",
      resolutionState: "resolved",
    },
    requestDigest: digestFinalKimiProviderRequest({
      version: 1,
      url: "https://api.kimi.com/coding/v1/chat/completions",
      method: "POST",
      model: "k3",
      headers: [["accept", "application/json"]],
      credentialHeaders: ["authorization"],
      messages: [{ role: "user", content: "hello", reasoningContent: null, toolCalls: [], toolCallId: null }],
      tools: [],
      options: {
        maxCompletionTokens: null,
        promptCacheKey: null,
        reasoningEffort: "high",
        stream: true,
        thinking: null,
        toolChoice: null,
      },
    }),
    revision: 7,
    generation: 3,
    deadlineAt: Date.now() + 60_000,
  };
}

test("private channel writes action-tagged bounded frames and reads only control-tagged frames", async () => {
  const action = request();
  const writes: Uint8Array[] = [];
  const controls = [encodeControlFrame({ kind: "permit", request: action, nonce: "AAAAAAAAAAAAAAAAAAAAAA" })];
  const transport: NativeSidecarTransport = {
    async writeAction(frame) { writes.push(frame); },
    async readControl() { return controls.shift() ?? null; },
    close() {},
  };
  const channel = new NativeSidecarChannel(transport);
  await channel.writeKimiAction(action);
  assert.equal(writes[0]![0], ACTION_FRAME_TAG);
  assert.deepEqual(decodeActionFrame(writes[0]!), action);
  assert.equal((await channel.readKimiControl())?.kind, "permit");

  const wrongDirection = Uint8Array.from(writes[0]!);
  wrongDirection[0] = CONTROL_FRAME_TAG;
  assert.throws(() => decodeActionFrame(wrongDirection), /direction/i);
  assert.throws(() => decodeControlFrame(writes[0]!), /direction/i);
});

test("packaged startup codec is exact private-channel-only and binds its attestation", () => {
  const startup = { kind: "packaged-startup" as const, requestId: createKimiRequestId(), challenge: "AAAAAAAAAAAAAAAAAAAAAA", sessionId: "session-startup", childPid: 4242, actionChannelId: "fd:198" as const, controlChannelId: "fd:199" as const };
  assert.deepEqual(decodePrivateActionFrame(encodeActionFrame(startup)), startup);
  const attestation = { ...startup, kind: "packaged-attestation" as const, generation: 7, executablePath: "/Volumes/Orcode/Orcode.app/Contents/MacOS/orcode-gui", executableDevice: 1, executableInode: 2, executableSize: 3, policySha256: "a".repeat(64), executableSha256: "b".repeat(64) };
  assert.deepEqual(decodeControlFrame(encodeControlFrame(attestation)), attestation);
  assert.throws(() => encodeActionFrame({ ...startup, publicFrame: true } as never), /unknown/i);
  assert.throws(() => encodeControlFrame({ ...attestation, challenge: "bad" }), /attestation|challenge|invalid/i);
});

test("private codecs reject duplicate JSON keys, unknown keys, truncation, and oversized payloads", () => {
  const action = request();
  const frame = encodeActionFrame(action);
  assert.throws(() => decodeActionFrame(frame.subarray(0, frame.length - 1)), /truncated|length/i);

  const duplicate = new TextEncoder().encode('{"kind":"denied","kind":"denied"}');
  const duplicateFrame = new Uint8Array(5 + duplicate.length);
  duplicateFrame[0] = CONTROL_FRAME_TAG;
  new DataView(duplicateFrame.buffer).setUint32(1, duplicate.length, false);
  duplicateFrame.set(duplicate, 5);
  assert.throws(() => decodeControlFrame(duplicateFrame), /duplicate/i);

  const unknown = structuredClone(action) as KimiNativeActionRequest & { publicEvent?: string };
  unknown.publicEvent = "native-local-action-required";
  assert.throws(() => encodeActionFrame(unknown), /unknown|keys/i);

  const huge = new Uint8Array(5 + MAX_NATIVE_SIDECAR_PAYLOAD_BYTES + 1);
  huge[0] = ACTION_FRAME_TAG;
  new DataView(huge.buffer).setUint32(1, MAX_NATIVE_SIDECAR_PAYLOAD_BYTES + 1, false);
  assert.throws(() => decodeActionFrame(huge), /maximum|large/i);
});

test("private action codec carries exact revocation and bounded Cross request budget", async () => {
  const revocation: KimiNativeActionRevocation = {
    kind: "revoke",
    requestId: createKimiRequestId(),
    sessionId: "session-revoke",
    childPid: 4242,
    revision: 7,
    generation: 3,
    deadlineAt: Date.now() + 60_000,
  };
  const writes: KimiNativeActionRecord[] = [];
  const channel = new NativeSidecarChannel({
    async writeAction(frame) { writes.push(decodeActionFrame(frame)); },
    async readControl() { return null; },
    close() {},
  });

  await channel.writeKimiRevocation(revocation);
  assert.deepEqual(writes, [revocation]);
  assert.deepEqual(Object.keys(writes[0]!).sort(), [
    "childPid", "deadlineAt", "generation", "kind", "requestId", "revision", "sessionId",
  ]);

  const cross: KimiNativeActionRecord = {
    kind: "kimi-cross",
    requestId: createKimiRequestId(),
    sessionId: "session-cross",
    childPid: 4242,
    crossRunId: "cross-1",
    lead: request().route,
    challenger: { ...request().route, accountFingerprint: "challenger" },
    repairBudget: 1,
    requestBudgetPerStage: 100,
    revision: 7,
    generation: 3,
    deadlineAt: Date.now() + 60_000,
  };
  assert.deepEqual(decodeActionFrame(encodeActionFrame(cross)), cross);
  for (const requestBudgetPerStage of [0, 101, 1.5, "1"] as const) {
    assert.throws(
      () => encodeActionFrame({ ...cross, requestBudgetPerStage } as never),
      /budget|invalid/i,
    );
  }
});

test("product action serialization never starts queued or remaining writes after close", async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writeStarts: Uint8Array[] = [];
  const transport = createFixedDescriptorTransportForTest({
    async read(_fd, _buffer) { return 0; },
    async write(_fd, buffer) {
      writeStarts.push(Uint8Array.from(buffer));
      if (writeStarts.length === 1) {
        markFirstStarted();
        await firstGate;
        return 1;
      }
      return buffer.byteLength;
    },
    close(_fd) {},
  });
  const channel = new NativeSidecarChannel(transport);
  const first = channel.writeKimiAction(request());
  const second = channel.writeKimiAction(request());
  await firstStarted;

  channel.close();
  releaseFirst();
  const settled = await Promise.allSettled([first, second]);

  assert.deepEqual(settled.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(writeStarts.length, 1);
});

test("Codex action and result records are disjoint, exact, bounded, and secretless by direction", async () => {
  const browser: CodexNativeActionRequest = {
    kind: "codex-browser-login-prepare",
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    loginId: "login-1",
    authUrl: "https://auth.openai.com/oauth/authorize?opaque=1",
    deadlineAt: Date.now() + 60_000,
  };
  const commit: CodexNativeActionRequest = {
    kind: "codex-native-action-commit",
    requestId: browser.requestId,
    childGeneration: 4,
    deadlineAt: browser.deadlineAt,
  };
  const revoke: CodexNativeActionRequest = {
    kind: "codex-native-action-revoke",
    requestId: browser.requestId,
    childGeneration: 4,
    deadlineAt: browser.deadlineAt,
  };
  const result = {
    kind: "codex-native-action-result" as const,
    requestId: browser.requestId,
    childGeneration: 4,
    status: "presented" as const,
  };
  assert.deepEqual(canonicalCodexNativeActionRequest(browser), browser);
  assert.deepEqual(canonicalCodexNativeActionRequest(commit), commit);
  assert.deepEqual(canonicalCodexNativeActionRequest(revoke), revoke);
  assert.doesNotMatch(JSON.stringify([commit, revoke]), /https:|loginId|userCode|authUrl/i);
  assert.deepEqual(canonicalCodexNativeActionResult(result), result);
  assert.deepEqual(decodeActionFrame(encodeActionFrame(browser)), browser);
  assert.deepEqual(decodeControlFrame(encodeControlFrame(result)), result);
  assert.throws(() => canonicalKimiNativeActionRecord(browser), /Kimi|kind/i);
  assert.throws(() => canonicalKimiDesktopControlRecord(result), /Kimi|kind/i);
  assert.throws(() => canonicalCodexNativeActionRequest({ ...browser, publicFrame: true }), /unknown|keys/i);
  assert.throws(() => canonicalCodexNativeActionRequest({ ...commit, authUrl: browser.authUrl }), /unknown|keys/i);
  assert.throws(() => canonicalCodexNativeActionResult({ ...result, authUrl: browser.authUrl }), /unknown|keys/i);

  const writes: CodexNativeActionRequest[] = [];
  const channel = new NativeSidecarChannel({
    async writeAction(frame) { writes.push(decodeActionFrame(frame) as CodexNativeActionRequest); },
    async readControl() { return encodeControlFrame(result); },
    close() {},
  });
  await channel.writeCodexAction(browser);
  assert.deepEqual(writes, [browser]);
  assert.deepEqual(await channel.readCodexControl(), result);
});

test("one channel read pump demultiplexes interleaved Codex and Kimi controls", async () => {
  const kimiRequest = request();
  const codexResult = {
    kind: "codex-native-action-result" as const,
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    status: "presented" as const,
  };
  const controls = [
    encodeControlFrame(codexResult),
    encodeControlFrame({ kind: "permit", request: kimiRequest, nonce: "AAAAAAAAAAAAAAAAAAAAAA" }),
  ];
  let reads = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  const channel = new NativeSidecarChannel({
    async writeAction() {},
    async readControl() {
      reads += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const control = controls.shift() ?? null;
      activeReads -= 1;
      return control;
    },
    close() {},
  });

  const kimi = channel.readKimiControl();
  const codex = channel.readCodexControl();
  assert.deepEqual(await codex, codexResult);
  assert.deepEqual(await kimi, { kind: "permit", request: kimiRequest, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
  assert.ok(reads >= 2);
  assert.equal(maxActiveReads, 1);
});

test("the shared pump preserves back-to-back Kimi controls while its consumer settles", async () => {
  const first = request();
  const second = { ...request(), requestId: createKimiRequestId(), runId: "run-2" };
  const controls = [
    encodeControlFrame({ kind: "permit", request: first, nonce: "AAAAAAAAAAAAAAAAAAAAAA" }),
    encodeControlFrame({ kind: "permit", request: second, nonce: "BBBBBBBBBBBBBBBBBBBBBB" }),
  ];
  const channel = new NativeSidecarChannel({
    async writeAction() {},
    async readControl() {
      if (controls.length > 0) return controls.shift()!;
      return new Promise<Uint8Array | null>(() => {});
    },
    close() {},
  });

  assert.deepEqual(await channel.readKimiControl(), {
    kind: "permit", request: first, nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await channel.readKimiControl(), {
    kind: "permit", request: second, nonce: "BBBBBBBBBBBBBBBBBBBBBB",
  });
});
