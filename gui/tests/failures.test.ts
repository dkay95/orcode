// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { RequestFailed } from "../src/bridge.js";
import { INITIAL_ENGINE_STATE, reduceEngine } from "../src/engine-state.js";
import {
  ENGINE_PIPE_FAILED,
  SHELL_UNAVAILABLE,
  UNEXPECTED_FAILURE,
  classifyFailure,
  describeEngineFailure,
} from "../src/failures.js";
import { enginePanel } from "../src/views.js";

/**
 * The rule under test is the wire's own, one layer down (`gui-server.ts`):
 * an unexplained error is described by a fixed sentence and NEVER by
 * `error.message`. These pin both halves — what reaches the screen, and
 * that the original still reaches a developer.
 */

/** The exact exception a window served outside the app throws. */
const TRANSFORM_CALLBACK = new TypeError(
  "Cannot read properties of undefined (reading 'transformCallback')",
);

describe("what may be shown", () => {
  it("shows the engine's own refusal verbatim — it is its truth to state", () => {
    const body = classifyFailure(
      new RequestFailed({ code: "run-active", message: "A run is in flight.", hint: "cancel" }),
      "request",
      () => {},
    );
    expect(body).toEqual({ code: "run-active", message: "A run is in flight.", hint: "cancel" });
  });

  it("shows the shell's own refusal verbatim — a sentence written for a person", () => {
    const body = classifyFailure(
      { code: "node-missing", message: "No Node.js runtime was found. Looked in: /usr/bin/node." },
      "start",
      () => {},
    );
    expect(body.code).toBe("node-missing");
    expect(body.message).toContain("No Node.js runtime was found");
  });

  it("never shows an exception's own text, and says so in a fixed sentence", () => {
    const diagnose = vi.fn();
    const body = classifyFailure(TRANSFORM_CALLBACK, "start", diagnose);
    expect(body.message).toBe(SHELL_UNAVAILABLE);
    expect(JSON.stringify(body)).not.toContain("transformCallback");
    // The original is not lost — it goes where a developer looks.
    expect(diagnose).toHaveBeenCalledWith(expect.any(String), TRANSFORM_CALLBACK);
  });

  it("uses the same discipline for a failing request", () => {
    const diagnose = vi.fn();
    const body = classifyFailure(new Error("ECONNRESET at socket.js:42"), "request", diagnose);
    expect(body).toEqual({ code: "unexpected", message: UNEXPECTED_FAILURE });
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("turns a pipe-failure CODE into the window's own sentence", () => {
    expect(describeEngineFailure("engine-io").message).toBe(ENGINE_PIPE_FAILED);
    expect(describeEngineFailure("something-new").message).toBe(UNEXPECTED_FAILURE);
  });
});

describe("the panel a person actually reads", () => {
  it("renders the fixed sentence and no exception text at all", () => {
    const body = classifyFailure(TRANSFORM_CALLBACK, "start", () => {});
    const state = reduceEngine(INITIAL_ENGINE_STATE, {
      kind: "spawn-failed",
      code: body.code,
      message: body.message,
      ...(body.hint ? { hint: body.hint } : {}),
    });
    const panel = enginePanel(state, ["node: /usr/local/bin/node"], false, () => {});
    const text = panel.textContent ?? "";
    expect(text).toContain(SHELL_UNAVAILABLE);
    expect(text).not.toContain("transformCallback");
    expect(text).not.toContain("Cannot read properties");
  });
});
