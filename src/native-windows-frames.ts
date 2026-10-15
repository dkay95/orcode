/** Framing only; neither this decoder nor any record creates native owner authority. */
export type WindowsPrivateFrame = Readonly<{ tag: number; payload: Uint8Array }>;
const TAGS = [0xb0, 0xb1, 0xa1, 0xc1, 0xd1, 0xd2, 0xd3] as const;
const MAX_BYTES = 4096;
const MAX_BACKLOG = 32;
function invalid(): never { throw new TypeError("Windows private frame invalid."); }

export function encodeWindowsPrivateFrame(tag: number, payload: Uint8Array): Uint8Array {
  if (!(TAGS as readonly number[]).includes(tag) || payload.byteLength > MAX_BYTES) invalid();
  const frame = Buffer.alloc(5 + payload.byteLength); frame[0] = tag;
  frame.writeUInt32BE(payload.byteLength, 1); frame.set(payload, 5); return frame;
}

export class WindowsPrivateFrameDecoder {
  readonly #allowed: readonly number[];
  #buffer = Buffer.alloc(0);
  #closed = false;
  constructor(direction: "core-input" | "core-output") {
    this.#allowed = direction === "core-input" ? [0xb0, 0xa1, 0xd1, 0xd3]
      : direction === "core-output" ? [0xb1, 0xc1, 0xd2, 0xd3] : invalid();
  }
  push(chunk: Uint8Array): readonly WindowsPrivateFrame[] {
    if (this.#closed) invalid();
    try {
      if (chunk.byteLength > MAX_BACKLOG * (MAX_BYTES + 5)) invalid();
      const bytes = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
      const frames: WindowsPrivateFrame[] = []; let offset = 0;
      while (bytes.length - offset >= 5) {
        const tag = bytes[offset]!; const length = bytes.readUInt32BE(offset + 1);
        if (!this.#allowed.includes(tag) || length > MAX_BYTES) invalid();
        if (bytes.length - offset < 5 + length) break;
        if (frames.length >= MAX_BACKLOG) invalid();
        frames.push(Object.freeze({ tag, payload: Uint8Array.from(bytes.subarray(offset + 5, offset + 5 + length)) }));
        offset += 5 + length;
      }
      this.#buffer = Buffer.from(bytes.subarray(offset));
      if (this.#buffer.length > MAX_BYTES + 4) invalid();
      return Object.freeze(frames);
    } catch { this.#closed = true; this.#buffer = Buffer.alloc(0); invalid(); }
  }
  finish(): void {
    if (this.#closed || this.#buffer.length) { this.#closed = true; this.#buffer = Buffer.alloc(0); invalid(); }
    this.#closed = true;
  }
}
