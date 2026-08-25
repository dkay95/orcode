#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 28;
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const EXPECTED_INPUT = "Erste Zeile\nZweite Zeile";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const ENABLE_SGR_MOUSE = "\u001b[?1000h";
const ASCII_ROUTE_CORE_START = "/--------\\";
const ASCII_ROUTE_CORE_COMPACT = "<>-+*o";

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

def stop_on_signal(number, _frame):
    raise RuntimeError("PTY-Controller wurde durch Signal " + str(number) + " beendet")

signal.signal(signal.SIGINT, stop_on_signal)
signal.signal(signal.SIGTERM, stop_on_signal)

def append_output(chunk):
    if not chunk:
        return
    if len(captured) + len(chunk) > config["maxOutputBytes"]:
        raise RuntimeError("PTY-Ausgabe überschreitet das feste Ausgabelimit")
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

def wait_for(marker):
    while marker not in captured:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY-Smoke überschritt sein festes Zeitlimit")
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("PTY-Harness endete vor dem erwarteten Marker")
        read_once(0.05)

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

    wait_for(b"ORCODE_PTY_READY:")
    wait_for(b"ORCODE_PTY_RESUMED")
    wait_for(b"ORCODE_PTY_SETTINGS_READY")
    write_all(b"6")
    wait_for(b"ORCODE_PTY_SETTINGS_CATEGORY")
    write_all(b"\x1b")
    wait_for(b"ORCODE_PTY_SETTINGS_RESTORED")
    write_all(b"\x1b[200~Erste Zeile\nZweite Zeile\x1b[201~")
    wait_for(b"Enter sendet alles gemeinsam")
    paste_ready_seen = True

    quiet_deadline = min(deadline, time.monotonic() + 0.2)
    while time.monotonic() < quiet_deadline:
        read_once(0.02)
    result_before_enter = b"ORCODE_PTY_RESULT:" in captured
    alive_before_enter = process.poll() is None

    write_all(b"\r")
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY-Harness beendete sich nicht innerhalb des festen Zeitlimits")
        read_once(0.05)
    while read_once(0.0):
        pass

    result = {
        "aliveBeforeEnter": alive_before_enter,
        "exitCode": process.returncode,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
        "pasteReadySeen": paste_ready_seen,
        "resultBeforeEnter": result_before_enter,
        "resumedSeen": b"ORCODE_PTY_RESUMED" in captured,
        "settingsSeen": b"ORCODE_PTY_SETTINGS_RESTORED" in captured,
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

export function isPtyCheckEntrypoint(
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

export async function runPtySmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error(
      "Der echte POSIX-PTY-Smoke wird unter Windows nicht unterstützt; der Workflow muss ihn dort explizit überspringen. ConPTY wurde damit nicht geprüft.",
    );
  }

  const root = resolve(options.projectRoot ?? projectRoot);
  const tuiModule = join(root, "dist", "tui.js");
  const harnessPath = join(root, "tests", "fixtures", "pty-harness.mjs");
  const accessFile = options.accessFile ?? access;
  try {
    await accessFile(tuiModule);
  } catch (error) {
    throw new Error(
      `Build-Artefakt fehlt: ${tuiModule}. Vor dem PTY-Smoke muss \`npm run build\` laufen.`,
      { cause: error },
    );
  }
  try {
    await accessFile(harnessPath);
  } catch (error) {
    throw new Error(`PTY-Harness fehlt: ${harnessPath}`, { cause: error });
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
    tuiModuleUrl: pathToFileURL(tuiModule).href,
  };
  const runController = options.runController ?? runPythonController;
  const controller = await runController(request);
  const result = validateControllerResult(controller, request);
  const log = options.log ?? console.log;
  log(
    `Echtes POSIX-PTY geprüft: stdin/stdout TTY · ${result.columns}x${result.rows} · mehrzeiliges Bracketed Paste wartet auf separates Enter · Terminal-Cleanup vollständig.`,
  );
  return result;
}

export function validateControllerResult(controller, request) {
  if (!controller || typeof controller !== "object") {
    throw new Error("Der PTY-Controller lieferte kein Ergebnisobjekt.");
  }
  if (controller.timedOut === true) {
    throw new Error("Der PTY-Smoke überschritt sein festes Zeitlimit.");
  }
  if (controller.pasteReadySeen !== true) {
    throw new Error("Der PTY-Smoke sah keinen abgeschlossenen mehrzeiligen Paste-Zustand.");
  }
  if (controller.resumedSeen !== true) {
    throw new Error("Der PTY-Smoke erreichte keinen suspend-resume Checkpoint.");
  }
  if (controller.settingsSeen !== true) {
    throw new Error("Der PTY-Smoke erreichte keinen keyboard-only Settings Checkpoint.");
  }
  if (controller.resultBeforeEnter === true) {
    throw new Error("Die Eingabe wurde vor dem separaten Enter abgeschickt.");
  }
  if (controller.aliveBeforeEnter !== true) {
    throw new Error("Das TUI blieb bis zum separaten Enter nicht aktiv.");
  }
  if (controller.exitCode !== 0) {
    throw new Error(`Das PTY-Harness endete mit Exit-Code ${String(controller.exitCode)}.`);
  }
  if (typeof controller.outputBase64 !== "string") {
    throw new Error("Der PTY-Controller lieferte keine begrenzte Roh-Ausgabe.");
  }

  const bytes = Buffer.from(controller.outputBase64, "base64");
  if (bytes.length === 0 || bytes.length > request.maxOutputBytes) {
    throw new Error("Die PTY-Roh-Ausgabe ist leer oder überschreitet das feste Ausgabelimit.");
  }
  const output = bytes.toString("utf8");
  if (!output.includes(ASCII_ROUTE_CORE_START) || !output.includes(ASCII_ROUTE_CORE_COMPACT)) {
    throw new Error("Der PTY-Smoke sah nicht beide kanonischen Route-Core-Marken.");
  }
  if (output.includes(ENABLE_SGR_MOUSE)) {
    throw new Error("Settings-PTY darf kein SGR mouse reporting aktivieren.");
  }
  const ready = readMarker(output, "ORCODE_PTY_READY:");
  const result = readMarker(output, "ORCODE_PTY_RESULT:");
  if (
    ready.stdinTTY !== true ||
    ready.stdoutTTY !== true ||
    ready.columns !== request.columns ||
    ready.rows !== request.rows
  ) {
    throw new Error(
      `Das Harness lief nicht auf dem erwarteten TTY-Paar mit ${request.columns}x${request.rows}.`,
    );
  }
  if (result.value !== EXPECTED_INPUT) {
    throw new Error("Das mehrzeilige Paste wurde nicht genau einmal als eine Eingabe übernommen.");
  }

  const enabledAt = output.indexOf(ENABLE_BRACKETED_PASTE);
  const disabledAt = output.lastIndexOf(DISABLE_BRACKETED_PASTE);
  const leftAt = output.lastIndexOf(LEAVE_ALTERNATE_SCREEN);
  const resultAt = output.lastIndexOf("ORCODE_PTY_RESULT:");
  if (
    enabledAt < 0 ||
    disabledAt <= enabledAt ||
    leftAt <= disabledAt ||
    resultAt <= leftAt
  ) {
    throw new Error(
      "Terminal-Cleanup unvollständig: Bracketed Paste muss deaktiviert und der Alternate Screen vor dem Exit verlassen werden.",
    );
  }

  return {
    columns: ready.columns,
    input: result.value,
    rows: ready.rows,
    stdinTTY: ready.stdinTTY,
    stdoutTTY: ready.stdoutTTY,
  };
}

function readMarker(output, marker) {
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`PTY-Ausgabe enthält ${marker} nicht.`);
  const valueStart = start + marker.length;
  const lineEnd = output.indexOf("\n", valueStart);
  const line = output.slice(valueStart, lineEnd < 0 ? output.length : lineEnd).replace(/\r$/, "");
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${marker} enthält kein gültiges JSON.`, { cause: error });
  }
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
              `Der Python-PTY-Controller lieferte kein gültiges JSON${
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
          reject(new Error(`Der echte POSIX-PTY-Lauf schlug fehl: ${detail}`, { cause: error }));
          return;
        }
        resolvePromise(parsed);
      },
    );
  });
}

if (isPtyCheckEntrypoint(import.meta.url)) {
  runPtySmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
