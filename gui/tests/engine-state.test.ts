import { describe, expect, it } from "vitest";

import {
  INITIAL_ENGINE_STATE,
  describeExit,
  describeExitCause,
  engineHeadline,
  exitConsequence,
  reduceEngine,
  type EngineState,
} from "../src/engine-state.js";
import { PROTOCOL_VERSION, type GuiStatus, type HelloFrame, type ServerFrame } from "../src/protocol.js";

const hello: HelloFrame = {
  t: "hello",
  v: PROTOCOL_VERSION,
  protocol: PROTOCOL_VERSION,
  orcode: "0.7.0",
  node: "v22.14.0",
  pid: 4242,
  capabilities: ["chat"],
};

const status = { chatTitle: "A chat", workspace: "/tmp/w" } as unknown as GuiStatus;

function feed(state: EngineState, frame: ServerFrame): EngineState {
  return reduceEngine(state, { kind: "frame", frame });
}

describe("the readiness gate", () => {
  it("does not open on hello — the engine is speaking, not ready", () => {
    const state = feed(INITIAL_ENGINE_STATE, hello);
    expect(state.phase).toBe("speaking");
    expect(state.everReady).toBe(false);
    expect(state.hello).toEqual(hello);
  });

  it("opens on the first successful status.get, and only that", () => {
    let state = feed(INITIAL_ENGINE_STATE, hello);
    state = reduceEngine(state, { kind: "status", status });
    expect(state.phase).toBe("ready");
    expect(state.everReady).toBe(true);
    expect(state.status).toBe(status);
  });

  it("accepts events that arrive before the handshake without becoming ready", () => {
    const state = feed(INITIAL_ENGINE_STATE, {
      t: "event",
      v: PROTOCOL_VERSION,
      e: "status",
      text: "Checking provider …",
      busy: false,
    });
    expect(state.phase).toBe("starting");
    expect(state.everReady).toBe(false);
  });
});

describe("states that are never soft", () => {
  it("a protocol mismatch fails outright — there is no degraded mode", () => {
    const state = feed(INITIAL_ENGINE_STATE, { ...hello, protocol: 99 });
    expect(state.phase).toBe("failed");
    expect(state.failure?.code).toBe("protocol-mismatch");
    expect(engineHeadline(state)).toContain("99");
  });

  it("a fatal frame carries the engine's own words", () => {
    const state = feed(INITIAL_ENGINE_STATE, {
      t: "event",
      v: PROTOCOL_VERSION,
      e: "fatal",
      code: "engine-failed",
      message: "The engine failed to start.",
    });
    expect(state.phase).toBe("failed");
    expect(engineHeadline(state)).toBe("The engine failed to start.");
  });

  it("a ready engine that exits is stopped, never still ready", () => {
    let state = reduceEngine(feed(INITIAL_ENGINE_STATE, hello), { kind: "status", status });
    state = reduceEngine(state, { kind: "exited", code: 1, signal: null });
    expect(state.phase).toBe("stopped");
    expect(state.status).toBeNull();
    expect(describeExit(state)).toBe("The engine stopped (exit 1).");
  });

  it("names the signal when one ended it", () => {
    const state = reduceEngine(INITIAL_ENGINE_STATE, { kind: "exited", code: null, signal: 9 });
    expect(describeExit(state)).toBe("The engine stopped (signal 9).");
  });

  it("says what a death mid-run means, and only when a run was live", () => {
    let state = reduceEngine(feed(INITIAL_ENGINE_STATE, hello), { kind: "status", status });
    state = reduceEngine(state, { kind: "exited", code: null, signal: 9 });
    expect(exitConsequence(state, true)).toContain("not automatically undone");
    expect(exitConsequence(state, false)).toBeNull();
  });

  it("an engine that never became ready says so instead of blaming a run", () => {
    const state = reduceEngine(INITIAL_ENGINE_STATE, { kind: "exited", code: 1, signal: null });
    expect(exitConsequence(state, true)).toContain("never finished starting");
  });
});

describe("restart", () => {
  it("is a new engine, never a resumed one", () => {
    let state = reduceEngine(feed(INITIAL_ENGINE_STATE, hello), { kind: "status", status });
    state = reduceEngine(state, { kind: "exited", code: 0, signal: null });
    state = reduceEngine(state, { kind: "spawned" });
    expect(state).toEqual(INITIAL_ENGINE_STATE);
  });
});

describe("lines that are not protocol", () => {
  it("are counted, and never become content", () => {
    let state = INITIAL_ENGINE_STATE;
    state = reduceEngine(state, { kind: "unparseable" });
    state = reduceEngine(state, { kind: "unparseable" });
    expect(state.unparseableLines).toBe(2);
    expect(state.phase).toBe("starting");
  });
});

describe("a death before hello", () => {
  function died(cause: string | null): EngineState {
    // Never ready: the engine exited before it could answer a `status.get`.
    return reduceEngine(INITIAL_ENGINE_STATE, { kind: "exited", code: 1, signal: null, cause });
  }

  /** A session that got all the way to ready, then ended somehow. */
  function livedThenDied(
    exit: { code: number | null; signal: number | null; cause: string | null },
  ): EngineState {
    const ready = reduceEngine(feed(INITIAL_ENGINE_STATE, hello), { kind: "status", status });
    return reduceEngine(ready, { kind: "exited", ...exit });
  }

  it("says nothing about a CLEAN exit, whatever the session left on stderr", () => {
    // Fix round 1 (B-1): the tail accumulates over a whole session — one
    // mid-run provider failure writes `run failed: …` into it — so a clean
    // quit was being told it "stopped on an error it did not handle".
    const clean = livedThenDied({ code: 0, signal: null, cause: "engine-crashed" });
    expect(describeExitCause(clean)).toBeNull();
    // The plain honest state is still there, and it is all anyone knows.
    expect(describeExit(clean)).toBe("The engine stopped.");
  });

  it("still says it when the exit was abnormal, or when it never became ready", () => {
    // A signal: the process is claiming it did not end on its own terms.
    expect(describeExitCause(livedThenDied({ code: null, signal: 15, cause: "engine-crashed" })))
      .toBe("It stopped on an error it did not handle.");
    // A non-zero code: the same claim.
    expect(describeExitCause(livedThenDied({ code: 7, signal: null, cause: "engine-out-of-memory" })))
      .toBe("It ran out of memory.");
    // Never ready: the case the mechanism was built for, and the one where
    // the tail IS the reason — even on a code this build treats as clean.
    const stillborn = reduceEngine(INITIAL_ENGINE_STATE, {
      kind: "exited", code: 0, signal: null, cause: "engine-module-missing",
    });
    expect(describeExitCause(stillborn)).toContain("could not find part of its own code");
  });

  it("says what the shell classified, and says it as this window's own sentence", () => {
    const state = died("engine-node-too-old");
    expect(describeExit(state)).toBe("The engine stopped (exit 1).");
    expect(describeExitCause(state)).toBe(
      "The Node.js runtime it was started with is too old to run this engine.",
    );
    // G2 concern 4's other half: it never started, and the panel says so.
    expect(exitConsequence(state, false)).toBe("It never finished starting, so nothing was opened.");
  });

  it("says nothing rather than guessing when the shell recognised nothing", () => {
    expect(describeExitCause(died(null))).toBeNull();
  });

  it("names an unknown code rather than dropping it", () => {
    // A newer shell classifying something this build has no words for: the
    // fact that the shell knows more is itself worth saying.
    expect(describeExitCause(died("engine-from-the-future"))).toContain("engine-from-the-future");
  });
});
