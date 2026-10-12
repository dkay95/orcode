import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INITIAL_ENGINE_STATE, reduceEngine, type EngineState } from "../src/engine-state.js";
import { hubRows, statusSegments } from "../src/hub-model.js";
import { PROTOCOL_VERSION, parseFrame, type GuiStatus, type ChatRow, type ServerFrame } from "../src/protocol.js";

/**
 * The end-to-end smoke, without a browser.
 *
 * `tauri-driver` does not exist on macOS (G0 §1.8, D4), so nothing here
 * drives a window. What it DOES drive is everything below the window: a real
 * `dist/gui-server.js`, spawned exactly as the shell spawns it — the same
 * `HOME` seam for a fixture app home, the same one-JSON-object-per-line pipe
 * — through the same client modules the WebView uses.
 *
 * It answers the milestone's question: does an engine started this way reach
 * a hub? And it pins the premise the whole shutdown path rests on: closing
 * stdin ends it.
 */

const ENGINE = fileURLToPath(new URL("../../dist/gui-server.js", import.meta.url));

class Probe {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: ServerFrame[] = [];
  stderr = "";
  nonProtocol: string[] = [];
  #sequence = 0;
  #waiters: { match: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];

  constructor(home: string, workspace: string) {
    this.child = spawn(process.execPath, [ENGINE], {
      cwd: workspace,
      env: { ...process.env, HOME: home, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      const frame = parseFrame(line);
      if (!frame) {
        if (line.trim()) this.nonProtocol.push(line);
        return;
      }
      this.frames.push(frame);
      for (const waiter of [...this.#waiters]) {
        if (waiter.match(frame)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  await(match: (frame: ServerFrame) => boolean, timeoutMs = 20_000): Promise<ServerFrame> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out.\nstderr: ${this.stderr}`)),
        timeoutMs,
      );
      this.#waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  async request(t: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    this.#sequence += 1;
    const id = `p${this.#sequence}`;
    const settled = this.await((frame) => frame.t === "response" && frame.id === id);
    this.child.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, t, id, ...payload })}\n`);
    const frame = (await settled) as Extract<ServerFrame, { t: "response" }>;
    if (!frame.ok) throw new Error(`${frame.error.code}: ${frame.error.message}`);
    return frame.result;
  }

  /** Closes our end of the pipe — the shell's own shutdown trigger. */
  endInput(): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
      this.child.once("exit", (code, signal) =>
        resolve({ code, signal, ms: Date.now() - started }),
      );
      this.child.stdin.end();
    });
  }
}

let probe: Probe;
let home: string;
let workspace: string;
let engine: EngineState = INITIAL_ENGINE_STATE;

beforeAll(() => {
  if (!existsSync(ENGINE)) {
    throw new Error("dist/gui-server.js is missing — run `npm run build` in the repo root first.");
  }
  // The harness discipline the protocol pins already use: a real app home
  // and a real workspace on a temp dir. Never the owner's own.
  const root = mkdtempSync(join(tmpdir(), "orcode-gui-smoke-"));
  home = root;
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, ".orcode"), { recursive: true });
  probe = new Probe(home, workspace);
});

afterAll(() => {
  probe?.child.kill("SIGKILL");
});

describe("a real engine, spawned the way the shell spawns it", () => {
  it("speaks first, and speaking is not readiness", async () => {
    const hello = await probe.await((frame) => frame.t === "hello");
    engine = reduceEngine(engine, { kind: "frame", frame: hello });
    expect(engine.phase).toBe("speaking");
    expect(engine.hello?.protocol).toBe(PROTOCOL_VERSION);
  }, 30_000);

  it("reaches the hub: handshake, then status, then the chat list", async () => {
    await probe.request("hello-ack", { protocol: PROTOCOL_VERSION, client: "orcode-gui-smoke" });
    const status = (await probe.request("status.get")) as GuiStatus;
    engine = reduceEngine(engine, { kind: "status", status });
    expect(engine.phase).toBe("ready");

    // The hub's own two projections, over what the engine actually sent.
    const segments = statusSegments(status, home);
    // `endsWith`, because macOS resolves `/var/folders/…` to `/private/var/…`
    // and the engine reports the real path it is actually working in.
    expect(segments.folder.endsWith(workspace.replace(/^\/private/, ""))).toBe(true);
    // A fixture home has no provider, and the status line says so rather
    // than showing a balance it does not have.
    expect(segments.balance).toBeNull();

    const list = (await probe.request("chats.list")) as { chats: ChatRow[] };
    expect(Array.isArray(list.chats)).toBe(true);
    expect(hubRows(list.chats, status.workspace, home, Date.now())).toHaveLength(list.chats.length);
  }, 30_000);

  it("routes exact provider setup through canonical onboarding without transcript output", async () => {
    // `status.get` proves engine readiness; the provider Foundation finishes
    // independently and announces its own readiness with this first snapshot.
    // Anchor to that event rather than racing it or sleeping.
    await probe.await((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
    const before = probe.frames.length;
    const result = await probe.request("command", { raw: "/provider setup", draft: "" });
    expect(result).toEqual({ outcome: "continue" });

    const emitted = probe.frames.slice(before);
    const views = emitted.filter(
      (frame): frame is Extract<ServerFrame, { t: "event" }> =>
        frame.t === "event" && frame.e === "onboarding.view",
    );
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.some((frame) => {
      const view = frame.view as { operationHandle?: unknown } | undefined;
      return typeof view?.operationHandle === "string" && view.operationHandle.length > 0;
    })).toBe(true);
    expect(emitted.some(
      (frame) => frame.t === "event" && (frame.e === "transcript" || frame.e === "command-output"),
    )).toBe(false);
  }, 30_000);

  it("puts nothing but protocol on its stdout", () => {
    // R1: the core writes the answer to stdout when an observer is missing.
    // One stray line would corrupt every frame after it.
    expect(probe.nonProtocol).toEqual([]);
  });

  it("ends when the shell closes its stdin", async () => {
    const exit = await probe.endInput();
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    // Well inside the grace window the shell gives it before SIGKILL
    // (`SHUTDOWN_GRACE`, 10 s). Measured readings on this machine sit
    // between 2.6 s and 5.2 s, which is why that bound is where it is.
    expect(exit.ms).toBeLessThan(10_000);
  }, 30_000);
});
