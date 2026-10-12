// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../src/protocol.js";

/**
 * The bridge with a fake Tauri underneath it.
 *
 * What is pinned here is the one thing a restart can get wrong: a replaced
 * engine's reader task publishes its own `Terminated` through the OLD
 * channel, and that can arrive after the new engine is already running. If
 * the bridge listened to it, a freshly started engine's window would say
 * "the engine stopped".
 */

interface FakeChannel {
  onmessage: ((message: unknown) => void) | null;
}

const channels: FakeChannel[] = [];
const invoked: { command: string; args: unknown }[] = [];
let sendOverride: (() => Promise<unknown>) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
    constructor() {
      channels.push(this as unknown as FakeChannel);
    }
  },
  invoke: (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === "engine_send" && sendOverride) return sendOverride();
    return Promise.resolve({ pid: channels.length });
  },
}));

const {
  CROSS_ACTION_COMMANDS,
  createCrossActionHandlers,
  EngineBridge,
} = await import("../src/bridge.js");
const { crossPanel } = await import("../src/views.js");

describe("a rejected send", () => {
  beforeEach(() => {
    channels.length = 0;
    invoked.length = 0;
    sendOverride = undefined;
  });

  it("rejects the waiting request so the window can report the send failure", async () => {
    const failure = { code: "engine-not-reading", message: "The engine has stopped reading its input." };
    sendOverride = () => Promise.reject(failure);
    const bridge = new EngineBridge({
      onFrame() {}, onUnparseable() {}, onExit() {}, onFailure() {},
    });
    try {
      await expect(bridge.request("settings.open")).rejects.toEqual(failure);
    } finally {
      sendOverride = undefined;
    }
  }, 500);

  it("does not replace a response already delivered before a late send failure", async () => {
    let rejectSend!: (reason: unknown) => void;
    sendOverride = () => new Promise((_, reject) => { rejectSend = reject; });
    const bridge = new EngineBridge({
      onFrame() {}, onUnparseable() {}, onExit() {}, onFailure() {},
    });
    try {
      await bridge.start();
      const result = bridge.request("status.get");
      const request = JSON.parse((invoked.at(-1)!.args as { line: string }).line);
      channels[0]!.onmessage?.({ kind: "frame", line: JSON.stringify({
        t: "response", v: PROTOCOL_VERSION, id: request.id, ok: true, result: { ready: true },
      }) });
      await expect(result).resolves.toEqual({ ready: true });
      rejectSend({ code: "engine-stalled", message: "The engine did not accept that message." });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(result).resolves.toEqual({ ready: true });
    } finally {
      sendOverride = undefined;
    }
  });
});

describe("the direct Cross action catalog mapping", () => {
  it("uses only the four existing slash-command paths", () => {
    expect(CROSS_ACTION_COMMANDS).toEqual({
      models: "/cross models",
      swap: "/cross swap",
      status: "/cross status",
      stop: "/cross stop",
    });
    const dispatch = vi.fn();
    const actions = createCrossActionHandlers(dispatch);
    actions.models();
    actions.swap();
    actions.status();
    actions.stop();
    expect(dispatch.mock.calls.map(([raw]) => raw)).toEqual([
      "/cross models",
      "/cross swap",
      "/cross status",
      "/cross stop",
    ]);
  });

  it("sends exactly one canonical wire request for each clicked panel action", () => {
    invoked.length = 0;
    const bridge = new EngineBridge({
      onFrame: () => {},
      onUnparseable: () => {},
      onExit: () => {},
      onFailure: () => {},
    });
    const handlers = createCrossActionHandlers((raw) => {
      void bridge.request("command", { raw, draft: "" });
    });
    const base = {
      sequence: 8,
      updatedAt: 1,
      phase: "Bereit",
      reason: null,
      verification: "Nicht aktiv",
      lead: {
        providerLabel: "OpenAI",
        accountLabel: "Codex Privat",
        displayName: "Shared Model",
        canonicalModelId: "openai/gpt-5.4-codex",
        reasoning: "supported" as const,
        capabilities: ["text", "tools"] as const,
      },
      challenger: {
        providerLabel: "OpenRouter",
        accountLabel: "OpenRouter Privat",
        displayName: "Shared Model",
        canonicalModelId: "moonshotai/kimi-k3",
        reasoning: "unknown" as const,
        capabilities: ["text", "tools"] as const,
      },
      active: false,
    };

    for (const [label, raw, active] of [
      ["Modelle ändern", "/cross models", false],
      ["Tauschen", "/cross swap", false],
      ["Status", "/cross status", false],
      ["Stop", "/cross stop", true],
    ] as const) {
      const before = invoked.filter((entry) => entry.command === "engine_send").length;
      const panel = crossPanel({ ...base, active }, handlers);
      const control = [...panel.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;
      expect(control, label).toBeTruthy();
      control!.click();
      control!.click();
      const sends = invoked.filter((entry) => entry.command === "engine_send");
      expect(sends, `${label} must dispatch once`).toHaveLength(before + 1);
      const line = JSON.parse((sends.at(-1)!.args as { line: string }).line) as {
        t: string;
        raw: string;
        draft: string;
      };
      expect(line).toMatchObject({ t: "command", raw, draft: "" });
    }

    const commands = invoked
      .filter((entry) => entry.command === "engine_send")
      .map((entry) => JSON.parse((entry.args as { line: string }).line) as { raw: string });
    expect(commands.map(({ raw }) => raw)).toEqual([
      "/cross models",
      "/cross swap",
      "/cross status",
      "/cross stop",
    ]);
  });
});

describe("a superseded channel", () => {
  beforeEach(() => {
    channels.length = 0;
    invoked.length = 0;
  });

  it("is not listened to any more once a new engine has been started", async () => {
    const exits: (number | null)[] = [];
    const frames: string[] = [];
    const bridge = new EngineBridge({
      onFrame: (frame) => frames.push(frame.t),
      onUnparseable: () => {},
      onExit: (code) => exits.push(code),
      onFailure: () => {},
    });

    await bridge.start();
    const first = channels[0]!;
    await bridge.start();
    const second = channels[1]!;

    // The old engine's death, arriving late.
    first.onmessage?.({ kind: "exited", code: 0, signal: null });
    expect(exits).toEqual([]);
    first.onmessage?.({ kind: "frame", line: JSON.stringify({ v: PROTOCOL_VERSION, t: "hello", protocol: PROTOCOL_VERSION }) });
    expect(frames).toEqual([]);

    // The new engine is heard.
    second.onmessage?.({ kind: "frame", line: JSON.stringify({ v: PROTOCOL_VERSION, t: "hello", protocol: PROTOCOL_VERSION }) });
    expect(frames).toEqual(["hello"]);
    second.onmessage?.({ kind: "exited", code: 1, signal: null });
    expect(exits).toEqual([1]);
  });

  it("passes a pipe failure on as a code, never as raw text", async () => {
    const failures: string[] = [];
    const bridge = new EngineBridge({
      onFrame: () => {},
      onUnparseable: () => {},
      onExit: () => {},
      onFailure: (code) => failures.push(code),
    });
    await bridge.start();
    channels[0]!.onmessage?.({ kind: "failed", code: "engine-io" });
    expect(failures).toEqual(["engine-io"]);
  });

  it("counts a line that is not protocol instead of passing it on as a frame", async () => {
    const unparseable: string[] = [];
    const frames: string[] = [];
    const bridge = new EngineBridge({
      onFrame: (frame) => frames.push(frame.t),
      onUnparseable: (line) => unparseable.push(line),
      onExit: () => {},
      onFailure: () => {},
    });
    await bridge.start();
    channels[0]!.onmessage?.({ kind: "frame", line: "Thinking about the answer …" });
    expect(unparseable).toEqual(["Thinking about the answer …"]);
    expect(frames).toEqual([]);
  });
});

describe("the exit's classified cause", () => {
  beforeEach(() => {
    channels.length = 0;
    invoked.length = 0;
  });

  it("crosses as the shell sent it, and is null when the shell said nothing", async () => {
    const seen: (string | null)[] = [];
    const bridge = new EngineBridge({
      onFrame: () => {},
      onUnparseable: () => {},
      onExit: (_code, _signal, cause) => seen.push(cause),
      onFailure: () => {},
    });
    await bridge.start();
    channels[0]?.onmessage?.({
      kind: "exited",
      code: 1,
      signal: null,
      cause: "engine-module-missing",
    });
    // An older shell sends no `cause` at all; that is "not known", not a crash.
    channels[0]?.onmessage?.({ kind: "exited", code: 1, signal: null });
    expect(seen).toEqual(["engine-module-missing", null]);
  });
});
