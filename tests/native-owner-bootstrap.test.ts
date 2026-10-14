import assert from "node:assert/strict";
import test from "node:test";
import {
  WindowsOwnerGate,
  type WindowsOwnerHelloV1,
  type WindowsOwnerAttestationV1,
} from "../src/native-owner-bootstrap.js";
import { encodeActionFrame, encodeControlFrame } from "../src/native-sidecar-channel.js";

function ownerReplyForTest(hello: WindowsOwnerHelloV1): WindowsOwnerAttestationV1 {
  return { ...hello, kind: "windows-owner-attestation", childCreationTime: "100",
    peerPid: 1001, peerCreationTime: "101", ownerPid: 999, ownerCreationTime: "99",
    ownerImageSha256: "1".repeat(64) };
}

test("Windows attestation is exact, generation-bound and single-use", () => {
  const gate = new WindowsOwnerGate({ generation: 7, now: () => 100 });
  const hello = gate.hello({ childPid: 1000, deadlineAt: 200 });
  const reply = ownerReplyForTest(hello);
  assert.throws(() => gate.accept({ ...reply, childGeneration: 6 }));
  assert.throws(() => gate.accept({ ...reply, rawHandle: "forged" }));
  assert.deepEqual(gate.accept(reply), reply);
  assert.throws(() => gate.accept(reply));
  assert.throws(() => gate.hello({ childPid: 1000, deadlineAt: 200 }));
});

test("bootstrap binds every hello field and cannot issue parallel challenges", () => {
  const gate = new WindowsOwnerGate({ generation: 7, now: () => 100 });
  const hello = gate.hello({ childPid: 1000, deadlineAt: 200 });
  const reply = ownerReplyForTest(hello);
  assert.throws(() => gate.hello({ childPid: 1000, deadlineAt: 200 }));
  for (const field of ["requestId", "sessionId", "challenge", "pipeInstanceId"] as const) {
    assert.throws(() => gate.accept({ ...reply, [field]: "x".repeat(32) }), field);
  }
  assert.throws(() => gate.accept({ ...reply, childPid: 1002 }));
  assert.throws(() => gate.accept({ ...reply, deadlineAt: 201 }));
  assert.equal(gate.accept(reply).childPid, 1000);
  assert.equal(Object.isFrozen(hello), true);
});

test("expired, revoked, unsolicited and clock-reversed owner records fail closed", () => {
  let now = 100;
  const gate = new WindowsOwnerGate({ generation: 1, now: () => now });
  assert.throws(() => gate.accept({}));
  const hello = gate.hello({ childPid: 1000, deadlineAt: 200 });
  now = 200;
  assert.throws(() => gate.accept(ownerReplyForTest(hello)), /expired|closed/i);
  now = 100;
  assert.throws(() => gate.accept(ownerReplyForTest(hello)));
  const revoked = new WindowsOwnerGate({ generation: 1, now: () => now });
  const other = revoked.hello({ childPid: 1000, deadlineAt: 200 });
  revoked.revoke();
  revoked.revoke();
  assert.throws(() => revoked.accept(ownerReplyForTest(other)));
  const reversed = new WindowsOwnerGate({ generation: 1, now: () => now });
  const past = reversed.hello({ childPid: 1000, deadlineAt: 200 });
  now = 99;
  assert.throws(() => reversed.accept(ownerReplyForTest(past)), /clock|closed/i);
});

test("creation times are canonical u64 strings, never unsafe JS numbers", () => {
  const gate = new WindowsOwnerGate({ generation: 1, now: () => 100 });
  const reply = ownerReplyForTest(gate.hello({ childPid: 1000, deadlineAt: 200 }));
  for (const field of ["childCreationTime", "peerCreationTime", "ownerCreationTime"] as const) {
    for (const value of [0, 1, 9007199254740992, "0", "01", "-1", "1.0", "18446744073709551616", "1e3"]) {
      assert.throws(() => gate.accept({ ...reply, [field]: value }), `${field}: ${String(value)}`);
    }
  }
  assert.equal(gate.accept({ ...reply, childCreationTime: "18446744073709551615" }).childCreationTime,
    "18446744073709551615");
});

test("bootstrap rejects prototypes, accessors, symbols and malformed native identities", () => {
  const gate = new WindowsOwnerGate({ generation: 1, now: () => 100 });
  const reply = ownerReplyForTest(gate.hello({ childPid: 1000, deadlineAt: 200 }));
  let getterCalls = 0;
  const getter = { ...reply };
  Object.defineProperty(getter, "ownerPid", { enumerable: true, get() { getterCalls++; return 999; } });
  for (const value of [getter, { ...reply, [Symbol("native")]: true }, Object.assign(Object.create(null), reply),
    { ...reply, ownerPid: 0 }, { ...reply, peerPid: 4294967296 }, { ...reply, ownerImageSha256: "A".repeat(64) },
    { ...reply, ownerPid: reply.childPid }, { ...reply, peerPid: reply.childPid }]) {
    assert.throws(() => gate.accept(value));
  }
  assert.equal(getterCalls, 0);
  const accepted = gate.accept(reply);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Reflect.ownKeys(accepted).some((key) => typeof key === "symbol"), false);
});

test("hello validates bounded generation, PID, deadline and pipe-instance inputs", () => {
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new WindowsOwnerGate({ generation, now: () => 100 }));
  }
  for (const childPid of [0, -1, 1.5, 4294967296]) {
    assert.throws(() => new WindowsOwnerGate({ generation: 1, now: () => 100 }).hello({ childPid, deadlineAt: 200 }));
  }
  for (const deadlineAt of [99, 100, 30101, Infinity, NaN, 100.5]) {
    assert.throws(() => new WindowsOwnerGate({ generation: 1, now: () => 100 }).hello({ childPid: 1000, deadlineAt }));
  }
  assert.throws(() => new WindowsOwnerGate({ generation: 1, now: () => 100, pipeInstanceId: "\\\\.\\pipe\\forged" }));
  const pipeInstanceId = "p".repeat(32);
  const gate = new WindowsOwnerGate({ generation: 1, now: () => 100, pipeInstanceId });
  assert.equal(gate.hello({ childPid: 1000, deadlineAt: 200 }).pipeInstanceId, pipeInstanceId);
});

test("separate Windows records never widen the Mac fixed-descriptor protocol", () => {
  const gate = new WindowsOwnerGate({ generation: 1, now: () => 100 });
  const hello = gate.hello({ childPid: 1000, deadlineAt: 200 });
  assert.throws(() => encodeActionFrame(hello as never));
  assert.throws(() => encodeControlFrame(ownerReplyForTest(hello) as never));
});
