/**
 * What an owner is told when something failed — and what they are not.
 *
 * The rule is the wire's own, one layer down: `gui-server.ts` describes an
 * unexplained error with a fixed sentence and *never* `error.message`,
 * because an exception's text is written for whoever wrote the code, and
 * because that is where provider bodies and request ids live. This module
 * applies the same rule on this side of the pipe.
 *
 * Three sources of a failure, three treatments:
 *
 *  1. **The engine's own refusal** (`RequestFailed`) — already classified by
 *     the server through `safePanelMessage`. Shown verbatim: it is its truth
 *     to state.
 *  2. **The shell's own refusal** (`ShellError` from a Rust command) — a
 *     sentence written in `lib.rs` for a person, with a code. Shown verbatim.
 *  3. **Anything else** — a `TypeError`, a rejected promise, a string thrown
 *     from a library. NEVER shown. A fixed sentence goes on screen and the
 *     original goes to the console, which is where a developer looks and
 *     where a future debug pane can pick it up under R-SEC-5's rule.
 */

import { RequestFailed, asShellError } from "./bridge.js";
import type { ErrorBody } from "./protocol.js";

/** The one sentence for "something on this side broke and we cannot say what". */
export const UNEXPECTED_FAILURE =
  "Something in this window failed unexpectedly. The details are in the shell's log.";

/** The one sentence for "the window is not running inside the orcode shell". */
export const SHELL_UNAVAILABLE =
  "This window could not reach the orcode shell, so no engine was started.";

/** The one sentence for a pipe that failed underneath us. */
export const ENGINE_PIPE_FAILED = "The connection to the engine failed.";

/**
 * The bridge is missing entirely — the window is being served outside the
 * app (a plain browser pointed at the dev server, most often). Recognised
 * rather than guessed at: the API's own entry point is absent.
 */
function bridgeMissing(): boolean {
  return !("__TAURI_INTERNALS__" in globalThis);
}

export type Diagnose = (label: string, detail: unknown) => void;

const toConsole: Diagnose = (label, detail) => {
  // Not `console.log`: this is the developer's channel, and the only place
  // the raw text exists on this side.
  console.error(`orcode-gui: ${label}`, detail);
};

/**
 * Classifies a failure into something an owner may read.
 *
 * `diagnose` receives the untouched original. Nothing else does.
 */
export function classifyFailure(
  error: unknown,
  context: "start" | "request",
  diagnose: Diagnose = toConsole,
): ErrorBody {
  if (error instanceof RequestFailed) return error.body;
  const shell = asShellError(error);
  if (shell) return shell;
  diagnose(context === "start" ? "the engine could not be started" : "a request failed", error);
  if (context === "start" && bridgeMissing()) {
    return {
      code: "shell-unavailable",
      message: SHELL_UNAVAILABLE,
      hint: "This build has to run inside the orcode app.",
    };
  }
  return { code: "unexpected", message: UNEXPECTED_FAILURE };
}

/** The window's own sentence for an `EngineMessage::Failed` code. */
export function describeEngineFailure(code: string): ErrorBody {
  return code === "engine-io"
    ? { code, message: ENGINE_PIPE_FAILED }
    : { code, message: UNEXPECTED_FAILURE };
}
