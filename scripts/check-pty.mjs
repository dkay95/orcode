#!/usr/bin/env node

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 28;
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const EXPECTED_DRAFT_LINES = ["Erste Zeile", "Zweite Zeile"];
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const ENABLE_SGR_MOUSE = "\u001b[?1000h";
/**
 * The Settings CATEGORY level's own mark — the V4-B chip row's active chip,
 * `*5 Appearance` under this harness's forced ASCII glyph mode. The crumb
 * title bar cannot stand in for it: the row editor's crumb reads
 * "Settings > Appearance > Large ORCODE logo", so "Settings > Appearance"
 * matches both levels and cannot anchor "Settings is back at its list".
 */
const APPEARANCE_CATEGORY_MARK = "*5 Appearance";
const ASCII_ROUTE_CORE_START = "---------*";
const ASCII_ROUTE_CORE_COMPACT = ">-*";
const FORBIDDEN_TRANSCRIPT = ["synthetic-pty-account", "PTY_SECRET_SENTINEL", "PTY_ACCOUNT_SENTINEL"];

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
control_path = None
control_created = False
deadline = time.monotonic() + (config["timeoutMs"] / 1000.0)
resumed_seen = False
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

def wait_for(marker):
    while marker not in captured:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY smoke exceeded its fixed time limit at " + stage)
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("PTY harness ended before the expected marker")
        read_once(0.05)

def wait_for_after(marker, offset):
    while marker not in captured[offset:]:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY smoke exceeded its fixed time limit at " + stage)
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("PTY harness ended before the expected marker")
        read_once(0.05)

def write_all(data):
    offset = 0
    while offset < len(data):
        offset += os.write(master, data[offset:])

def type_text(data, interval_seconds=0.01):
    for byte in data:
        write_all(bytes([byte]))
        time.sleep(interval_seconds)

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
    stage = "fixture marker"
    wait_for(b"ORCODE_PTY_FIXTURE:")
    fixture_start = captured.index(b"ORCODE_PTY_FIXTURE:") + len(b"ORCODE_PTY_FIXTURE:")
    fixture_end = captured.index(b"\n", fixture_start)
    fixture = bytes(captured[fixture_start:fixture_end]).rstrip(b"\r")
    stage = "suspend control marker"
    wait_for(b"ORCODE_PTY_SUSPEND_CONTROL:")
    control_start = captured.index(b"ORCODE_PTY_SUSPEND_CONTROL:") + len(b"ORCODE_PTY_SUSPEND_CONTROL:")
    control_end = captured.index(b"\n", control_start)
    control_path = bytes(captured[control_start:control_end]).rstrip(b"\r").decode("utf-8")
    if (
        not os.path.isabs(control_path)
        or os.path.basename(control_path) != "suspend.trigger"
        or "orcode-pty-lifecycle-" not in os.path.dirname(control_path)
        or os.path.exists(control_path)
    ):
        raise RuntimeError("PTY suspend control path is not safe or already in use")
    stage = "large Route Core mark"
    wait_for(b"---------*")
    # Exercise the exact control bytes emitted by a real terminal. Unit-test
    # key stubs previously hid Return/Escape/Backspace being consumed as
    # Ctrl+P search text.
    # F6 PTY evidence pass: these markers had gone stale (this script's own
    # header comment already anticipates that class of bug). The command
    # menu's breadcrumb has no separate "heading" to join against its own
    # "Commands" (dashboard-frame.ts's listChrome) — it never was
    # "Commands \xc2\xb7 Commands" doubled, just plain "Commands"; the child
    # crumb's " > " comes from the (already ASCII-aware) chevron glyph, and
    # this whole harness forces glyphMode: ascii (ORCODE_ASCII=1 below), so
    # "Model" joins with a literal ">" not the unicode "\xe2\x80\xba".
    type_text(b"DRAFT-CTRL-P")
    write_all(b"\x10")
    stage = "Ctrl+P root menu"
    wait_for(b"Commands")
    child_start = len(captured)
    write_all(b"\r")
    stage = "Ctrl+P child menu"
    wait_for_after(b"Commands > Model", child_start)
    root_start = len(captured)
    write_all(b"\x1b")
    stage = "Ctrl+P back to root"
    wait_for_after(b"Commands", root_start)
    draft_start = len(captured)
    write_all(b"\x1b")
    stage = "Ctrl+P draft restore"
    # The restored draft is real (root cause verified against the base
    # commit too: a plain wait_for_after(b"DRAFT-CTRL-P", draft_start)
    # times out here even before any F6 change) — the composer's own row
    # never actually changes across the whole Ctrl+P round trip (open,
    # drill, back, close all restore the exact same "> DRAFT-CTRL-P"), so
    # the render's own diffing correctly never re-emits it as new bytes.
    # The cursor's own reposition to column 15 — two-column "> " prompt
    # plus DRAFT-CTRL-P's 12 characters — is the part that IS necessarily
    # re-emitted and is exactly as specific a signal of a correct restore.
    wait_for_after(b"[28;15H", draft_start)
    write_all(b"\x15")
    type_text(b"/image " + fixture)
    write_all(b"\r")
    stage = "image attachment confirmation"
    wait_for(b"was attached")
    write_all(b"\x1b[200~Erste Zeile\nZweite Zeile\x1b[201~")
    stage = "bracketed draft"
    wait_for(b"Zweite Zeile")
    os.killpg(process.pid, signal.SIGUSR1)
    # settings-frame.ts's title/footer used to be hardcoded unicode
    # regardless of glyphMode (the exact bug F6's ASCII sweep fixed); under
    # this harness's forced ORCODE_ASCII=1 the separator is now correctly
    # "-", matching every other ASCII-mode marker in this script.
    # V4-B: the old "ORCODE - Settings" header is gone — the zone title bar
    # carries the crumb ("Settings > Models" in ASCII glyph mode) instead.
    stage = "settings root"
    wait_for(b"Settings > Models")
    # Every wait below distinguishes the two Settings LEVELS, and the crumb
    # title bar alone cannot: the row editor's own crumb is
    # "Settings > Appearance > Large ORCODE logo", so a bare
    # "Settings > Appearance" wait is satisfied by the editor as happily as by
    # the category list. That ambiguity is what let this script run its whole
    # appearance sequence in ~1 ms of "waiting", writing each key into a
    # surface it had not actually reached — the reopen Enter landed in the
    # still-open first editor and applied it (saving the value unchanged),
    # after which every later key was one level off and the closing Esc only
    # got back to the category list instead of closing Settings.
    #
    # The category CHIP row is the unambiguous level marker: it is painted
    # only at category level, and the "*" marks the active category
    # (ORCODE_ASCII=1 turns the selected-chip glyph into "*", the unselected
    # ones into "o"). The editor's three-segment crumb is the equally
    # unambiguous editor-level marker.
    APPEARANCE_CATEGORY = b"*5 Appearance"
    LOGO_ROW_EDITOR = b"Settings > Appearance > Large ORCODE logo"
    # The shipped Settings surface has exactly five root areas; Appearance is
    # the fifth of them, a real top-level category reached directly (no
    # legacy nested sub-picker).
    appearance_start = len(captured)
    write_all(b"5")
    stage = "settings area Appearance"
    wait_for_after(APPEARANCE_CATEGORY, appearance_start)
    editor_start = len(captured)
    write_all(b"\r")
    stage = "appearance editor"
    wait_for_after(LOGO_ROW_EDITOR, editor_start)
    category_cancel_start = len(captured)
    write_all(b"\x1b")
    stage = "appearance cancel"
    wait_for_after(APPEARANCE_CATEGORY, category_cancel_start)
    # First cancel proves the editor is non-destructive; the second editor
    # visit confirms one real appearance save through the controller.
    editor_reopen_start = len(captured)
    write_all(b"\r")
    stage = "appearance editor reopen"
    wait_for_after(LOGO_ROW_EDITOR, editor_reopen_start)
    # Down then Return are both editor-local keys on one ordered stream with
    # no async controller hop between them, so they cannot be reordered once
    # the editor is provably open — no sleep is needed to separate them. The
    # save is proved by its OUTCOME instead of by the intermediate highlight:
    # "  Off  " is the category row's value cell, painted only once the
    # controller has written the config and reloaded the view, so a Down that
    # never landed would apply the unchanged "On" and fail here by name.
    save_start = len(captured)
    write_all(b"\x1b[B")
    write_all(b"\r")
    stage = "appearance save"
    wait_for_after(b"  Off  ", save_start)
    wait_for_after(b"Saved", save_start)
    size = struct.pack("HHHH", max(8, config["rows"] - 4), config["columns"], 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    # A bounded harness trigger invokes public production suspend() on the
    # captured runDashboard TerminalUi; its callback stops this real child.
    suspend_start = len(captured)
    control_fd = os.open(control_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(control_fd)
    control_created = True
    stage = "suspend cleanup"
    wait_for_after(b"\x1b[?2004l", suspend_start)
    wait_for_after(b"\x1b[?1049l", suspend_start)
    stopped = False
    stop_deadline = min(deadline, time.monotonic() + 1.0)
    while time.monotonic() < stop_deadline:
        waited_pid, waited_status = os.waitpid(process.pid, os.WNOHANG | os.WUNTRACED)
        if waited_pid == process.pid and os.WIFSTOPPED(waited_status):
            stopped = True
            break
        time.sleep(0.01)
    if not stopped:
        raise RuntimeError("PTY child did not reach a real suspend SIGSTOP")
    if not os.WIFSTOPPED(waited_status) or os.WSTOPSIG(waited_status) != signal.SIGSTOP:
        raise RuntimeError("PTY child did not stop via the expected suspend SIGSTOP")
    os.killpg(process.pid, signal.SIGCONT)
    stage = "resume alternate screen"
    wait_for_after(b"\x1b[?1049h", suspend_start)
    wait_for_after(b"\x1b[?2004h", suspend_start)
    wait_for_after(APPEARANCE_CATEGORY, suspend_start)
    resume = bytes(captured[suspend_start:])
    suspend_disable = resume.find(b"\x1b[?2004l")
    suspend_leave = resume.find(b"\x1b[?1049l", suspend_disable + 1)
    resume_enter = resume.find(b"\x1b[?1049h", suspend_leave + 1)
    resume_enable = resume.find(b"\x1b[?2004h", resume_enter + 1)
    # V4-B marker swap surfaced a pre-existing race: the waits above can all
    # be satisfied by the resize repaint that precedes the suspend, so the
    # ordered check used to read the buffer before the post-resume repaint
    # arrived. Wait anchored strictly after the resume enable, re-snapshot.
    if resume_enable >= 0:
        wait_for_after(APPEARANCE_CATEGORY, suspend_start + resume_enable)
        resume = bytes(captured[suspend_start:])
    settings_frame = resume.find(APPEARANCE_CATEGORY, resume_enable + 1)
    resumed_seen = (
        suspend_disable >= 0 and
        suspend_leave > suspend_disable and
        resume_enter > suspend_leave and
        resume_enable > resume_enter and
        settings_frame > resume_enable
    )
    if not resumed_seen:
        raise RuntimeError("PTY child did not show an ordered suspend-resume terminal cycle")
    dashboard_return_start = len(captured)
    write_all(b"\x1b")
    stage = "dashboard draft restore"
    wait_for_after(b"Erste Zeile", dashboard_return_start)
    wait_for_after(b"Zweite Zeile", dashboard_return_start)
    wait_for_after(b"fixture.png", dashboard_return_start)
    restored = bytes(captured[dashboard_return_start:])
    first_draft = restored.find(b"Erste Zeile")
    second_draft = restored.find(b"Zweite Zeile", first_draft + len(b"Erste Zeile"))
    attachment = restored.find(b"fixture.png")
    if first_draft < 0 or second_draft <= first_draft or attachment < 0:
        raise RuntimeError("PTY draft and attachment were not restored exactly after Settings closed")

    quiet_deadline = min(deadline, time.monotonic() + 0.2)
    while time.monotonic() < quiet_deadline:
        read_once(0.02)
    result_before_enter = b"ORCODE_PTY_RESULT:" in captured
    alive_before_enter = process.poll() is None

    # Ctrl+C over a non-empty composer is deliberately NOT an exit any more
    # (tui.ts's own interrupt handler, "Audit FIX-1"): the first press clears
    # the draft and arms a fresh two-press window; only a second press closes
    # orcode. This script still sent one press and then waited for an exit
    # that by contract was never coming; drive the real contract instead.
    #
    # The arming HINT is not the anchor to wait on between the two presses:
    # dashboard-frame.ts's status row ranks the attachment count above a
    # fresh status, and this scenario still holds the fixture image, so
    # "1 image ready" keeps the line and the hint is never painted. The first
    # press's real, visible effect is that the restored draft is gone and the
    # composer falls back to its empty-state placeholder — which is also the
    # honest proof that press one cleared the draft rather than submitting it.
    exit_arm_start = len(captured)
    write_all(b"\x03")
    stage = "exit armed"
    wait_for_after(b"Type to start a new chat in", exit_arm_start)
    write_all(b"\x03")
    stage = "exit"
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("PTY harness did not exit within the fixed time limit")
        read_once(0.05)
    while read_once(0.0):
        pass

    result = {
        "aliveBeforeEnter": alive_before_enter,
        "exitCode": process.returncode,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
        "resultBeforeEnter": result_before_enter,
        "resumedSeen": resumed_seen,
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
    if control_created and control_path is not None:
        try:
            os.unlink(control_path)
        except FileNotFoundError:
            pass
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

async function newestMtimeMsUnder(dir, statFile, readdirEntries) {
  let newest = 0;
  const entries = await readdirEntries(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtimeMsUnder(full, statFile, readdirEntries));
    } else if (entry.isFile()) {
      const info = await statFile(full);
      newest = Math.max(newest, info.mtimeMs);
    }
  }
  return newest;
}

/**
 * `dist/` is a build artifact `npm run test:pty` never rebuilds on its own —
 * it only checks that `dist/cli.js`/`dist/tui.js` exist. A stale build (from
 * before a `src/` edit) makes the PTY smoke pass or hang against UI text that
 * no longer matches the real, current source, which is exactly how this
 * script's own wait markers went silently stale during the English-copy
 * migration. Failing fast with a clear message beats a confusing hang.
 */
export async function assertBuildIsFresh(root, io = {}) {
  const statFile = io.statFile ?? stat;
  const readdirEntries = io.readdirEntries ?? readdir;
  const srcDir = join(root, "src");
  const cliModule = join(root, "dist", "cli.js");
  const tuiModule = join(root, "dist", "tui.js");
  const newestSrcMtime = await newestMtimeMsUnder(srcDir, statFile, readdirEntries);
  const [cliInfo, tuiInfo] = await Promise.all([statFile(cliModule), statFile(tuiModule)]);
  const oldestDistMtime = Math.min(cliInfo.mtimeMs, tuiInfo.mtimeMs);
  if (newestSrcMtime > oldestDistMtime) {
    throw new Error(
      "dist/ is stale: src/ has changes newer than the build (run `npm run build` before `npm run test:pty`).",
    );
  }
}

export async function runPtySmoke(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error(
      "The real POSIX PTY smoke is not supported on Windows; the workflow must explicitly skip it there. ConPTY was therefore not checked.",
    );
  }

  const root = resolve(options.projectRoot ?? projectRoot);
  const cliModule = join(root, "dist", "cli.js");
  const tuiModule = join(root, "dist", "tui.js");
  const harnessPath = join(root, "tests", "fixtures", "pty-harness.mjs");
  const accessFile = options.accessFile ?? access;
  try {
    await accessFile(cliModule);
  } catch (error) {
    throw new Error(
      `Build artifact missing: ${cliModule}. \`npm run build\` must run before the PTY smoke.`,
      { cause: error },
    );
  }
  try {
    await accessFile(tuiModule);
  } catch (error) {
    throw new Error(
      `Build artifact missing: ${tuiModule}. \`npm run build\` must run before the PTY smoke.`,
      { cause: error },
    );
  }
  try {
    await accessFile(harnessPath);
  } catch (error) {
    throw new Error(`PTY harness missing: ${harnessPath}`, { cause: error });
  }
  const assertFresh = options.assertBuildIsFresh ?? assertBuildIsFresh;
  await assertFresh(root);

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
    `Real POSIX PTY checked: stdin/stdout TTY · ${result.columns}x${result.rows} · multi-line bracketed paste waits for a separate Enter · terminal cleanup complete.`,
  );
  return result;
}

export function validateControllerResult(controller, request) {
  if (!controller || typeof controller !== "object") {
    throw new Error("The PTY controller did not return a result object.");
  }
  if (controller.timedOut === true) {
    throw new Error("The PTY smoke exceeded its fixed time limit.");
  }
  if (controller.resumedSeen !== true) {
    throw new Error("The PTY smoke did not reach a suspend-resume checkpoint.");
  }
  if (controller.resultBeforeEnter === true) {
    throw new Error("The input was submitted before the separate Enter.");
  }
  if (controller.aliveBeforeEnter !== true) {
    throw new Error("The TUI did not stay active until the separate Enter.");
  }
  if (controller.exitCode !== 0) {
    throw new Error(`The PTY harness exited with code ${String(controller.exitCode)}.`);
  }
  if (typeof controller.outputBase64 !== "string") {
    throw new Error("The PTY controller did not return bounded raw output.");
  }

  const bytes = Buffer.from(controller.outputBase64, "base64");
  if (bytes.length === 0 || bytes.length > request.maxOutputBytes) {
    throw new Error("The PTY raw output is empty or exceeds the fixed output limit.");
  }
  const output = bytes.toString("utf8");
  if (!output.includes(ASCII_ROUTE_CORE_START) || !output.includes(ASCII_ROUTE_CORE_COMPACT)) {
    throw new Error("The PTY smoke did not see both canonical Route Core marks.");
  }
  if (FORBIDDEN_TRANSCRIPT.some((sentinel) => output.includes(sentinel))) {
    throw new Error("The PTY transcript contains a forbidden secret or account identity.");
  }
  if (output.includes(ENABLE_SGR_MOUSE)) {
    throw new Error("Settings PTY must not enable SGR mouse reporting.");
  }
  if (output.includes("ORCODE_PTY_RESUMED")) {
    throw new Error("The PTY transcript must not contain a forged resume marker.");
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
      `The harness did not run on the expected TTY pair at ${request.columns}x${request.rows}.`,
    );
  }
  if (result.agentCalls !== 0 || result.sessionTurns !== 0) {
    throw new Error("The restored draft was executed instead of staying unchanged.");
  }
  if (result.providerCalls !== 0) {
    throw new Error("A cancelled Settings action triggered a provider effect.");
  }
  if (result.configMode !== 0o600 || !/"show(?:LargeLogo|HeaderMark)"\s*:\s*false/.test(result.configRaw ?? "")) {
    throw new Error(`The confirmed Appearance change was not saved safely and durably (mode ${String(result.configMode)}).`);
  }

  const initialEnterAt = output.indexOf(ENTER_ALTERNATE_SCREEN);
  const initialEnableAt = output.indexOf(ENABLE_BRACKETED_PASTE, initialEnterAt + ENTER_ALTERNATE_SCREEN.length);
  const suspendDisableAt = output.indexOf(DISABLE_BRACKETED_PASTE, initialEnableAt + ENABLE_BRACKETED_PASTE.length);
  const suspendLeaveAt = output.indexOf(LEAVE_ALTERNATE_SCREEN, suspendDisableAt + DISABLE_BRACKETED_PASTE.length);
  const resumeEnterAt = output.indexOf(ENTER_ALTERNATE_SCREEN, suspendLeaveAt + LEAVE_ALTERNATE_SCREEN.length);
  const resumeEnableAt = output.indexOf(ENABLE_BRACKETED_PASTE, resumeEnterAt + ENTER_ALTERNATE_SCREEN.length);
  const settingsFrameAt = output.indexOf(APPEARANCE_CATEGORY_MARK, resumeEnableAt + ENABLE_BRACKETED_PASTE.length);
  const firstDraftAt = output.indexOf(EXPECTED_DRAFT_LINES[0], settingsFrameAt + APPEARANCE_CATEGORY_MARK.length);
  const secondDraftAt = output.indexOf(EXPECTED_DRAFT_LINES[1], firstDraftAt + EXPECTED_DRAFT_LINES[0].length);
  const attachmentAt = output.indexOf("fixture.png", settingsFrameAt + APPEARANCE_CATEGORY_MARK.length);
  const finalDisableAt = output.lastIndexOf(DISABLE_BRACKETED_PASTE);
  const finalLeaveAt = output.lastIndexOf(LEAVE_ALTERNATE_SCREEN);
  const resultAt = output.lastIndexOf("ORCODE_PTY_RESULT:");
  if (
    initialEnterAt < 0 ||
    initialEnableAt <= initialEnterAt ||
    suspendDisableAt <= initialEnableAt ||
    suspendLeaveAt <= suspendDisableAt ||
    resumeEnterAt <= suspendLeaveAt ||
    resumeEnableAt <= resumeEnterAt ||
    settingsFrameAt <= resumeEnableAt ||
    finalDisableAt <= resumeEnableAt ||
    finalLeaveAt <= finalDisableAt ||
    resultAt <= finalLeaveAt
  ) {
    throw new Error(
      "Suspend-resume terminal cycle incomplete: bracketed paste and alternate screen must be left and re-entered in order.",
    );
  }
  if (firstDraftAt <= settingsFrameAt || secondDraftAt <= firstDraftAt) {
    throw new Error("The restored draft line is missing after Settings closed.");
  }
  if (attachmentAt <= settingsFrameAt || resultAt <= attachmentAt) {
    throw new Error("The restored attachment is missing after Settings closed.");
  }

  return {
    columns: ready.columns,
    draftRestored: true,
    rows: ready.rows,
    stdinTTY: ready.stdinTTY,
    stdoutTTY: ready.stdoutTTY,
  };
}

function readMarker(output, marker) {
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`PTY output does not contain ${marker}.`);
  const valueStart = start + marker.length;
  const lineEnd = output.indexOf("\n", valueStart);
  const line = output.slice(valueStart, lineEnd < 0 ? output.length : lineEnd).replace(/\r$/, "");
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${marker} does not contain valid JSON.`, { cause: error });
  }
}

/**
 * Writes the WHOLE failing transcript next to the error and names the file.
 *
 * The 800-byte tail below is enough to recognise a failure but not to
 * diagnose one: when the appearance stage started writing keys into surfaces
 * it had not reached, the tail showed only the last repaint and pointed at
 * two different wrong culprits. The full transcript is what actually
 * identified the ambiguous level markers, and it is already bounded by the
 * controller's own `maxOutputBytes` cap, so keeping it costs nothing on the
 * green path and saves the next reader the same detour.
 */
function dumpFailureTranscript(parsed) {
  if (typeof parsed.outputBase64 !== "string") return "";
  try {
    const file = join(tmpdir(), `orcode-pty-failure-${process.pid}.log`);
    writeFileSync(file, Buffer.from(parsed.outputBase64, "base64"));
    return `\nFull PTY transcript: ${file}`;
  } catch {
    return "";
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
          reject(
            new Error(
              `The real POSIX PTY run failed: ${detail}${dumpFailureTranscript(parsed)}${
                transcript ? `\n${transcript}` : ""
              }`,
              { cause: error },
            ),
          );
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
