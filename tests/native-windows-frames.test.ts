import assert from "node:assert/strict";
import test from "node:test";
import { WindowsPrivateFrameDecoder, encodeWindowsPrivateFrame } from "../src/native-windows-frames.js";

test("one Windows private decoder handles split and coalesced direction-bound frames", () => {
  const decoder = new WindowsPrivateFrameDecoder("core-output");
  const first = encodeWindowsPrivateFrame(0xb1, Buffer.from("owner"));
  const second = encodeWindowsPrivateFrame(0xc1, Buffer.from("control"));
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  const frames = decoder.push(Buffer.concat([first.subarray(2), second]));
  assert.deepEqual(frames.map(frame => [frame.tag, Buffer.from(frame.payload).toString()]), [[0xb1, "owner"], [0xc1, "control"]]);
  assert.doesNotThrow(() => decoder.finish());
});

test("wrong-direction, oversized and truncated frames permanently poison the private stream", () => {
  for (const bytes of [encodeWindowsPrivateFrame(0xa1, Buffer.from("action")), Buffer.from([0xc1, 0, 0, 16, 1]), Buffer.alloc(131_233)]) {
    const decoder = new WindowsPrivateFrameDecoder("core-output");
    assert.throws(() => decoder.push(bytes));
    assert.throws(() => decoder.push(encodeWindowsPrivateFrame(0xc1, Buffer.from("late"))));
  }
  const truncated = new WindowsPrivateFrameDecoder("core-output");
  truncated.push(encodeWindowsPrivateFrame(0xc1, Buffer.from("control")).subarray(0, 7));
  assert.throws(() => truncated.finish());
  assert.throws(() => encodeWindowsPrivateFrame(0, Buffer.alloc(0)));
  assert.throws(() => encodeWindowsPrivateFrame(0xc1, Buffer.alloc(4097)));
});

test("private framing cannot accumulate an unbounded control backlog", () => {
  const decoder = new WindowsPrivateFrameDecoder("core-output");
  const frame = encodeWindowsPrivateFrame(0xc1, Buffer.alloc(0));
  assert.throws(() => decoder.push(Buffer.concat(Array.from({ length: 33 }, () => frame))));
});
