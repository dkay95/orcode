/**
 * Is there an engine, and is it ready? Nothing else.
 *
 * The gate is the protocol's own rule, not a guess: `hello` says the engine
 * is SPEAKING; readiness is the first successful `status.get`
 * (`src/gui-protocol.ts`'s header). The difference is not academic — the
 * engine writes `hello` before it has bootstrapped a workspace, a session or
 * a provider, and a hub drawn on `hello` would show a chat list that does
 * not exist yet.
 *
 * Every transition here has an honest destination. There is no state that
 * means "something happened, keep the last screen up".
 */

import type { ErrorBody, GuiStatus, HelloFrame, ServerFrame } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export type EnginePhase =
  | "starting"
  | "speaking"
  | "ready"
  /** `/quit` was accepted: the engine is shutting itself down, on request. */
  | "quitting"
  | "stopped"
  | "failed";

export interface EngineState {
  readonly phase: EnginePhase;
  readonly hello: HelloFrame | null;
  readonly status: GuiStatus | null;
  /** Why it is not running. The engine's own words wherever it said any. */
  readonly failure: ErrorBody | null;
  readonly exit: {
    readonly code: number | null;
    readonly signal: number | null;
    /**
     * A code from the shell's closed exit-cause vocabulary, or null.
     *
     * The engine's stderr never reaches this window (R-SEC-5); the shell reads
     * a bounded tail of it and picks one word from a fixed list. `null` means
     * nothing in that list matched, which is rendered as not knowing — never
     * as a guess.
     */
    readonly cause: string | null;
  } | null;
  /** True once a `status.get` has ever succeeded in this engine's life. */
  readonly everReady: boolean;
  /** Non-protocol lines seen. Counted and surfaced, never rendered. */
  readonly unparseableLines: number;
}

export const INITIAL_ENGINE_STATE: EngineState = Object.freeze({
  phase: "starting",
  hello: null,
  status: null,
  failure: null,
  exit: null,
  everReady: false,
  unparseableLines: 0,
});

export type EngineInput =
  /** A fresh sidecar was spawned — a restart is a NEW engine, never a resumed one. */
  | { readonly kind: "spawned" }
  | {
      readonly kind: "spawn-failed";
      readonly message: string;
      /** The technical tail, kept apart from the sentence a person reads. */
      readonly hint?: string;
      readonly code?: string;
    }
  | { readonly kind: "frame"; readonly frame: ServerFrame }
  | { readonly kind: "unparseable" }
  /** `/quit` was acknowledged — the engine is ending itself, on request. */
  | { readonly kind: "quitting" }
  /** A `status.get` came back ok — the readiness gate, and the only one. */
  | { readonly kind: "status"; readonly status: GuiStatus }
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: number | null;
      readonly cause?: string | null;
    };

export function reduceEngine(state: EngineState, input: EngineInput): EngineState {
  switch (input.kind) {
    case "spawned":
      // Everything the previous engine knew died with its process: the
      // config baseline, the palette's runtime context, every pending
      // editor (G0 §3.7). So a restart starts from nothing, deliberately.
      return { ...INITIAL_ENGINE_STATE };
    case "spawn-failed":
      return {
        ...state,
        phase: "failed",
        failure: {
          code: input.code ?? "engine-not-started",
          message: input.message,
          ...(input.hint ? { hint: input.hint } : {}),
        },
      };
    case "unparseable":
      return { ...state, unparseableLines: state.unparseableLines + 1 };
    case "quitting":
      // Not `stopped`: the process is still alive, saving. The exit frame
      // that follows is what makes it stopped, and it says how it ended.
      return state.phase === "ready" ? { ...state, phase: "quitting" } : state;
    case "status":
      // The gate. `hello` never opens it; only this does.
      return { ...state, phase: "ready", status: input.status, everReady: true };
    case "exited":
      // A dead engine is never "still running": a UI that keeps its last
      // frame is lying about what is happening to the owner's money.
      return {
        ...state,
        phase: "stopped",
        exit: { code: input.code, signal: input.signal, cause: input.cause ?? null },
        status: null,
      };
    case "frame":
      return reduceFrame(state, input.frame);
  }
}

function reduceFrame(state: EngineState, frame: ServerFrame): EngineState {
  if (frame.t === "hello") {
    if (frame.protocol !== PROTOCOL_VERSION) {
      // No degraded mode, by the protocol's own rule.
      return {
        ...state,
        phase: "failed",
        hello: frame,
        failure: {
          code: "protocol-mismatch",
          message: `This app speaks protocol ${PROTOCOL_VERSION}; the engine speaks ${frame.protocol}.`,
          hint: "Update the app and the engine together.",
        },
      };
    }
    // Speaking, not ready.
    return { ...state, phase: state.phase === "starting" ? "speaking" : state.phase, hello: frame };
  }
  if (frame.t === "event" && frame.e === "fatal") {
    const message = typeof frame.message === "string"
      ? frame.message
      : "The engine reported a fatal error.";
    const code = typeof frame.code === "string" ? frame.code : "fatal";
    return { ...state, phase: "failed", failure: { code, message } };
  }
  return state;
}

/**
 * What the owner is told while there is no hub yet.
 *
 * Deliberately narrow: these sentences describe the SHELL's own situation —
 * a process that has not answered yet, a process that ended — which is the
 * one thing no engine could have sent, because there is no engine to send
 * it. Every other sentence on screen comes off the wire.
 */
export function engineHeadline(state: EngineState): string {
  switch (state.phase) {
    case "starting":
      return "Starting the engine …";
    case "speaking":
      return "The engine is starting up …";
    case "ready":
      return "Ready";
    case "quitting":
      return "Quitting …";
    case "failed":
      return state.failure?.message ?? "The engine could not be started.";
    case "stopped":
      return describeExit(state);
  }
}

/**
 * The status line's version of the same state — a word, not the sentence.
 *
 * The panel already carries the sentence, and printing it twice on one
 * screen reads as two problems rather than one.
 */
export function engineStatusWord(state: EngineState): string {
  switch (state.phase) {
    case "starting":
      return "Starting the engine …";
    case "speaking":
      return "The engine is starting up …";
    case "ready":
      return "Ready";
    case "quitting":
      return "Quitting …";
    case "failed":
      return "No engine";
    case "stopped":
      return "Engine stopped";
  }
}

export function describeExit(state: EngineState): string {
  const exit = state.exit;
  if (!exit) return "The engine stopped.";
  if (exit.signal !== null) return `The engine stopped (signal ${exit.signal}).`;
  if (exit.code !== null && exit.code !== 0) return `The engine stopped (exit ${exit.code}).`;
  return "The engine stopped.";
}

/**
 * The classified cause, as this window's own sentence.
 *
 * G2 concern 4: an engine that died before `hello` used to show an exit code
 * and nothing else, because its stderr is not protocol and never crosses. What
 * crosses now is a CODE the shell chose from a closed list after reading a
 * bounded tail — so this map is exhaustive by construction, and an unknown
 * code says exactly that rather than being printed.
 */
const EXIT_CAUSE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  "engine-module-missing":
    "It could not find part of its own code. The build is incomplete or was moved.",
  "engine-node-too-old":
    "The Node.js runtime it was started with is too old to run this engine.",
  "engine-syntax": "Its code could not be parsed, so the build is not usable.",
  "engine-permission": "It was not allowed to read something it needs.",
  "engine-out-of-memory": "It ran out of memory.",
  "engine-port-in-use": "Something it needs was already in use.",
  "engine-crashed": "It stopped on an error it did not handle.",
});

/**
 * Was this death abnormal, or did the engine simply end?
 *
 * A signal or a non-zero code is the process saying it did not finish on its
 * own terms. Exit 0 is the opposite claim, and the two must not be told the
 * same story about why.
 */
function endedAbnormally(state: EngineState): boolean {
  const exit = state.exit;
  if (!exit) return false;
  return exit.signal !== null || (exit.code !== null && exit.code !== 0);
}

/**
 * The classified cause — and the SCOPE it is true in.
 *
 * Fix round 1 (B-1). This mechanism exists for one question (G2 concern 4:
 * an engine that dies before it can speak shows an exit code and no reason),
 * and it was being answered for every death. The tail it reads accumulates
 * over a whole session — the engine writes `run failed: …` there for any
 * mid-run provider failure, and the R1 stdout guard reroutes stray,
 * model-influenced text there too — so a CLEAN quit hours later could be
 * presented as "It stopped on an error it did not handle."
 *
 * A guess stated as a fact is the one thing this layer may never do, so the
 * cause is shown only where it is answering its own question:
 *
 *  * the engine never became ready — it died on the way up, which is the case
 *    the mechanism was built for and the case where the tail IS the reason;
 *  * or the exit was abnormal — a signal, or a non-zero code — where the
 *    process itself is claiming it did not end on its own terms.
 *
 * A clean exit says only what `describeExit` says, which is all anyone knows.
 */
export function describeExitCause(state: EngineState): string | null {
  const cause = state.exit?.cause;
  if (!cause) return null;
  if (state.everReady && !endedAbnormally(state)) return null;
  return EXIT_CAUSE_SENTENCES[cause]
    // A code this build has no sentence for is named rather than dropped: the
    // shell knows something this window does not, and hiding that is worse
    // than showing a bare code the log can be searched for.
    ?? `It stopped for a reason this app does not have words for (${cause}).`;
}

/**
 * The consequence the owner has to know about, and only when it applies.
 *
 * An engine that dies mid-run took its provider call with it, and the tool
 * actions it had already taken stand — the same sentence the dashboard uses
 * for a cancelled run, for the same reason.
 */
export function exitConsequence(state: EngineState, runWasActive: boolean): string | null {
  if (state.phase !== "stopped") return null;
  if (!state.everReady) {
    return "It never finished starting, so nothing was opened.";
  }
  if (runWasActive) {
    return "A run was in flight. Tool actions already taken were not automatically undone; a partial answer may have been saved.";
  }
  return null;
}
