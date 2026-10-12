#!/usr/bin/env node
/**
 * Phase 3b, Part C — end-to-end proof of the esc-split state machine over a
 * REAL POSIX PTY: a genuine raw ESC byte, parsed by the real
 * `TerminalUi#onKeypress`, must reach `setEndThinkingHandler` while
 * reasoning streams live and `setCancelHandler` otherwise — deterministic on
 * `RunViewModel.reasoningLive`, never a timing heuristic
 * (task-3b-brief.md Part C.2).
 *
 * Deliberately narrow: it does not drive a real `OrcodeAgent.run()` call —
 * `ensureRunnableModelConfiguration` (src/cli.ts) sits between a real
 * dashboard prompt submission and the agent and would need real or faked
 * network model listing this harness does not set up (see
 * tests/fixtures/pty-harness.mjs's SIGUSR2 handler doc comment). Two
 * signals (SIGUSR2, sent twice) drive the REAL captured `TerminalUi`
 * instance through the two states directly — the agent-side mechanism
 * (abort + continuation + reasoning `none` + honest cost booking) has its
 * own fake-runtime coverage in tests/agent.test.ts.
 *
 * Fix round 1, Critical 2: the transition into stage 2 is a "model-start"
 * event, not "model-end" — exactly what a real end-thinking continuation
 * emits, and exactly the event whose failure to clear `reasoningLive` was
 * the bug (view-model.ts). This script proves the fix over a real terminal,
 * not just the fake-stream unit test.
 *
 * Modeled directly on scripts/check-pty.mjs's proven real-PTY technique
 * (same openpty/select/read loop, same marker-wait helpers) but trimmed to
 * only this scenario, in its own file, so it can never destabilize the
 * release smoke test.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 28;
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

const PYTHON_CONTROLLER = String.raw`
import base64
import errno
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

config = json.loads(sys.argv[1])
master = -1
slave = -1
process = None
captured = bytearray()
deadline = time.monotonic() + (config["timeoutMs"] / 1000.0)
stage = "bootstrap"

def stop_on_signal(number, _frame):
    raise RuntimeError("PTY controller was terminated by signal " + str(number))

signal.signal(signal.SIGINT, stop_on_signal)
signal.signal(signal.SIGTERM, stop_on_signal)
signal.signal(signal.SIGCHLD, signal.SIG_DFL)

def append_output(chunk):
    if not chunk:
        return
    if len(captured) + len(chunk) > config["maxOutputBytes"]:
        raise RuntimeError("PTY output exceeds the fixed output limit")
    captured.extend(chunk)

def read_once(wait_seconds):
    remaining = max(0.0, deadline - time.monotonic())
    wait = min(wait_seconds, remaining)
    ready, _, _ = select.select([master], [], [], wait)
    if not ready:
        return False
    try:
        chunk = os.read(master, 8192)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    if not chunk:
        return False
    append_output(chunk)
    return True

def wait_for_after(marker, offset):
    while marker not in captured[offset:]:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY smoke exceeded its fixed time limit at " + stage)
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("PTY harness ended before the expected marker (" + stage + ")")
        read_once(0.05)

def wait_for(marker):
    wait_for_after(marker, 0)

def write_all(data):
    offset = 0
    while offset < len(data):
        offset += os.write(master, data[offset:])

try:
    master, slave = os.openpty()
    size = struct.pack("HHHH", config["rows"], config["columns"], 0, 0)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)

    environment = os.environ.copy()
    environment.update({
        "ORCODE_ASCII": "1",
        "ORCODE_PTY_CLI_MODULE": config["cliModuleUrl"],
        "ORCODE_PTY_TUI_MODULE": config["tuiModuleUrl"],
        "TERM": "xterm-256color",
    })
    process = subprocess.Popen(
        [config["nodeExecutable"], config["harnessPath"]],
        cwd=config["projectRoot"],
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)
    slave = -1

    stage = "ready marker"
    wait_for(b"ORCODE_PTY_READY:")
    stage = "large Route Core mark"
    wait_for(b"---------*")

    # --- Stage 1: esc WHILE reasoning streams live must end only the
    # thinking, never abort the run. ---
    stage1_start = len(captured)
    os.killpg(process.pid, signal.SIGUSR2)
    stage = "armed reasoning"
    wait_for_after(b"ORCODE_PTY_ESC_SPLIT:armed-reasoning", stage1_start)
    esc1_start = len(captured)
    write_all(b"\x1b")
    stage = "esc ends thinking"
    wait_for_after(b"ORCODE_PTY_ESC_SPLIT:end-thinking", esc1_start)
    if b"ORCODE_PTY_ESC_SPLIT:cancel-1" in captured[esc1_start:]:
        raise RuntimeError("esc during live reasoning also fired the cancel handler")

    # --- Stage 2: esc OTHERWISE keeps the existing run-abort meaning. ---
    stage2_start = len(captured)
    os.killpg(process.pid, signal.SIGUSR2)
    stage = "armed otherwise"
    wait_for_after(b"ORCODE_PTY_ESC_SPLIT:armed-otherwise", stage2_start)
    esc2_start = len(captured)
    write_all(b"\x1b")
    stage = "esc aborts"
    wait_for_after(b"ORCODE_PTY_ESC_SPLIT:cancel-2", esc2_start)
    if b"ORCODE_PTY_ESC_SPLIT:end-thinking-2" in captured[esc2_start:]:
        raise RuntimeError("esc outside reasoning also fired the end-thinking handler")

    stage = "clean exit"
    # Since "idle Ctrl+C follows the two-press quit convention" (tui.ts's
    # interrupt handler, Audit FIX-1) one Ctrl+C no longer closes orcode: the
    # first press only arms a fresh six-second window and the second one
    # inside it exits. This script still sent a single press and then waited
    # out its whole budget for an exit that by contract was never coming.
    #
    # Unlike the settings smoke there is nothing to wait on between the two
    # presses here: this scenario leaves a synthetic run on screen, and
    # dashboard-frame.ts's status row ranks the run phase above a fresh
    # status, so the arming hint is never painted and the first press has no
    # visible effect at all. No anchor is needed either — both presses are
    # ordinary keypresses on one ordered stream, handled synchronously in
    # order, so the second is guaranteed to see the window the first opened.
    write_all(b"\x03")
    write_all(b"\x03")
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY harness did not exit within the fixed time limit")
        read_once(0.05)
    while read_once(0.0):
        pass

    result = {
        "exitCode": process.returncode,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
        "timedOut": False,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
except Exception as error:
    failure = {
        "controllerError": str(error),
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
    }
    sys.stdout.write(json.dumps(failure, separators=(",", ":")))
    sys.exit(1)
finally:
    if slave >= 0:
        os.close(slave)
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=0.5)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=0.5)
    if master >= 0:
        os.close(master)
`;

export function isEscSplitEntrypoint(
  moduleUrl,
  argvEntry = process.argv[1],
  resolvePath = resolve,
) {
  if (!argvEntry) return false;
  try {
    return pathToFileURL(resolvePath(argvEntry)).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function runEscSplitPtySmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error(
      "The real POSIX PTY smoke is not supported on Windows; the workflow must explicitly skip it there.",
    );
  }

  const root = resolve(options.projectRoot ?? projectRoot);
  const cliModule = join(root, "dist", "cli.js");
  const tuiModule = join(root, "dist", "tui.js");
  const harnessPath = join(root, "tests", "fixtures", "pty-harness.mjs");
  const accessFile = options.accessFile ?? access;
  for (const artifact of [cliModule, tuiModule, harnessPath]) {
    try {
      await accessFile(artifact);
    } catch (error) {
      throw new Error(
        `Build artifact or harness missing: ${artifact}. \`npm run build\` must run before the PTY smoke.`,
        { cause: error },
      );
    }
  }

  const request = {
    columns: DEFAULT_COLUMNS,
    harnessPath,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    projectRoot: root,
    pythonExecutable: options.pythonExecutable ?? "python3",
    rows: DEFAULT_ROWS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cliModuleUrl: pathToFileURL(cliModule).href,
    tuiModuleUrl: pathToFileURL(tuiModule).href,
  };
  const runController = options.runController ?? runPythonController;
  const controller = await runController(request);
  const result = validateControllerResult(controller, request);
  const log = options.log ?? console.log;
  log(
    "Real POSIX PTY esc-split checked: esc during live reasoning ends only the thinking · esc otherwise aborts the run.",
  );
  return result;
}

export function validateControllerResult(controller) {
  if (!controller || typeof controller !== "object") {
    throw new Error("The PTY controller did not return a result object.");
  }
  if (typeof controller.controllerError === "string") {
    const transcript = typeof controller.outputBase64 === "string"
      ? Buffer.from(controller.outputBase64, "base64").toString("utf8").slice(-800)
      : "";
    throw new Error(`${controller.controllerError}${transcript ? `\n${transcript}` : ""}`);
  }
  if (controller.timedOut === true) {
    throw new Error("The esc-split PTY smoke exceeded its fixed time limit.");
  }
  if (controller.exitCode !== 0) {
    throw new Error(`The PTY harness exited with code ${String(controller.exitCode)}.`);
  }
  if (typeof controller.outputBase64 !== "string") {
    throw new Error("The PTY controller did not return bounded raw output.");
  }
  const output = Buffer.from(controller.outputBase64, "base64").toString("utf8");
  if (!output.includes("ORCODE_PTY_ESC_SPLIT:end-thinking")) {
    throw new Error("esc during live reasoning did not reach the end-thinking handler.");
  }
  if (!output.includes("ORCODE_PTY_ESC_SPLIT:cancel-2")) {
    throw new Error("esc outside reasoning did not reach the cancel handler.");
  }
  if (output.includes("ORCODE_PTY_ESC_SPLIT:cancel-1")) {
    throw new Error("esc during live reasoning incorrectly also reached the cancel handler.");
  }
  if (output.includes("ORCODE_PTY_ESC_SPLIT:end-thinking-2")) {
    throw new Error("esc outside reasoning incorrectly also reached the end-thinking handler.");
  }
  return { escSplitVerified: true };
}

async function runPythonController(request) {
  const payload = JSON.stringify({
    columns: request.columns,
    harnessPath: request.harnessPath,
    maxOutputBytes: request.maxOutputBytes,
    nodeExecutable: request.nodeExecutable,
    projectRoot: request.projectRoot,
    rows: request.rows,
    timeoutMs: request.timeoutMs,
    cliModuleUrl: request.cliModuleUrl,
    tuiModuleUrl: request.tuiModuleUrl,
  });
  return new Promise((resolvePromise, reject) => {
    execFile(
      request.pythonExecutable,
      ["-c", PYTHON_CONTROLLER, payload],
      {
        cwd: request.projectRoot,
        encoding: "utf8",
        maxBuffer: request.maxOutputBytes * 2,
        timeout: request.timeoutMs + 1_500,
      },
      (error, stdout, stderr) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch (parseError) {
          reject(
            new Error(
              `The Python PTY controller did not return valid JSON${
                stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "."
              }`,
              { cause: parseError },
            ),
          );
          return;
        }
        if (error) {
          const detail = typeof parsed.controllerError === "string"
            ? parsed.controllerError
            : error.message;
          const transcript = typeof parsed.outputBase64 === "string"
            ? Buffer.from(parsed.outputBase64, "base64").toString("utf8").slice(-800)
            : "";
          reject(new Error(`The real POSIX PTY run failed: ${detail}${transcript ? `\n${transcript}` : ""}`, { cause: error }));
          return;
        }
        resolvePromise(parsed);
      },
    );
  });
}

if (isEscSplitEntrypoint(import.meta.url)) {
  runEscSplitPtySmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
