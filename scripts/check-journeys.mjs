#!/usr/bin/env node
/**
 * Task J1 — owner-journey end-to-end checks, real POSIX PTY, real built
 * `dist/cli.js`/`dist/tui.js`.
 *
 * WHY this file exists (the owner's own words, translated): "What I don't
 * understand is why the design was half-finished each time — why was it
 * never fully implemented although we talked about it?" Every earlier task
 * verified its own component; nobody drove the actual binary through the
 * owner's actual journey — hub → recent chat → transcript → quit — the way
 * the owner does at a real terminal. `scripts/check-pty.mjs` (suspend/
 * resume/Ctrl+P/Settings) and `tests/fixtures/provider-setup-pty-harness.mjs`
 * (the setup wizard) are the precedents this reuses: same real-PTY
 * technique (openpty + select + a bounded byte cap), same "child harness
 * imports the real dist build, drives it through a synthetic
 * network-free ProviderRuntime" shape. This script is the driver + Python
 * PTY controller; `tests/fixtures/journey-pty-harness.mjs` is the child
 * process each PTY session actually runs.
 *
 * Seven pinned journeys (`JOURNEYS` below), each its own isolated PTY run
 * against its own temp app-home/workspace (never shared, never reused):
 *   J-A hub-with-recent          — launch in a folder with a populated chat
 *                                   already on disk: the HUB renders (brand
 *                                   block + version + Route row, a Recent
 *                                   row for that chat), no old transcript.
 *   J-B new-command-stays-hub    — `/new` + Enter from the hub: still the
 *                                   hub, no transcript flip, no UUID shown.
 *   J-C recent-row-opens-chat    — ↓ + Enter on the Recent row: the
 *                                   TRANSCRIPT renders (real turn text),
 *                                   hub gone.
 *   J-D quit-fresh-hub-no-ghost  — quit (Ctrl+C, the codebase's one real
 *                                   quit key at the hub — see the finding in
 *                                   j1-report.md about Esc being inert
 *                                   there) from the fresh hub: clean exit,
 *                                   AND no new chat file on disk afterward.
 *   J-E cost-forecast-on-draft   — hub → type a short draft: the status
 *                                   line gains the cost-forecast segment
 *                                   once the (synthetic, deliberately
 *                                   priced) catalog resolves.
 *   J-F zones-on-screen          — V4-C: the screen anatomy proved on the
 *                                   SHIPPED BINARY. Palette → Settings →
 *                                   a Settings editor → back out, asserting
 *                                   zone 1 (the inverse title bar and its
 *                                   crumb), zone 2 (tab bar, dense rows,
 *                                   the grown crumb + `Current:` line) and
 *                                   zone 3 (the key chips) in the RAW PTY
 *                                   bytes.
 *   J-G zones-on-screen-no-color — the same pass with a real NO_COLOR=1
 *                                   environment: the bar degrades to the
 *                                   divider rule, the chips grow square
 *                                   brackets, and not one SGR byte is
 *                                   emitted (the FIX-21 pattern J-A already
 *                                   established, applied to the zones).
 *
 * Deliberately NOT part of `npm test`/`npm run check` (a real PTY smoke is
 * slow and environment-sensitive, same reasoning `test:pty` already
 * documents) — wired instead as `npm run test:journeys`, its own entry in
 * the PTY check family, and into the release gate documented in README.md's
 * PTY section.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBuildIsFresh } from "./check-pty.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
// Wider than the other PTY checks' 6-10s (check-pty.mjs, provider-setup-pty-
// harness.mjs): this suite runs seven full PTY sessions back to back, each
// importing the whole compiled dist/cli.js afresh, and this class of check
// is documented as environment-sensitive under load (see the sibling
// scripts' own PTY-timing notes) — a generous per-scenario budget avoids a
// slow CI box turning a real pass into a false failure.
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 384 * 1024;

const PRIOR_CHAT_TITLE = "River Facts";
const PRIOR_ASSISTANT_TEXT = "The Volga is the longest river in Europe";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * V4-C (J-F/J-G). The crumbs the zone journeys steer by, spelled ONCE and
 * shared between the Python controller's `wait_for_after` markers and the
 * JavaScript assertions — the two must never be able to drift into waiting
 * for one string and asserting another.
 *
 * The chevron is a literal ` > `, not `theme.glyph("chevron")`: this whole
 * harness forces `glyphMode: "ascii"` (`ORCODE_ASCII=1`, and the seeded
 * config's own `appearance.glyphMode`), so the shipped binary really does
 * paint these bytes. That makes the ASCII fallback itself part of what the
 * journey proves, the same way `check-pty.mjs`'s own markers do.
 */
const ZONE_PALETTE_CRUMB = "Commands";
const ZONE_SETTINGS_CRUMB = "Settings > Models";
const ZONE_APPEARANCE_CRUMB = "Settings > Appearance";
/** The first Appearance row — the one an Enter at the top of the list opens. */
const ZONE_EDITOR_ROW = "Large ORCODE logo";
const ZONE_EDITOR_CRUMB = `${ZONE_APPEARANCE_CRUMB} > ${ZONE_EDITOR_ROW}`;
/** `showLargeLogo: false` in the harness's own seeded config (`booleanLabel`). */
const ZONE_EDITOR_CURRENT = "Current: Off";
/** The five Settings categories, as `settingsCategoryLabel` spells them. */
const ZONE_CATEGORY_LABELS = ["Models", "Accounts", "Approvals & Costs", "Tools", "Appearance"];

/**
 * The Python controller is one shared template, branching on `scenario` for
 * its key sequence — the exact structure
 * `provider-setup-pty-harness.mjs`'s own `PYTHON_CONTROLLER` uses for its
 * five setup-wizard scenarios, reused here rather than duplicated per
 * journey.
 */
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
# V4-C: byte offsets the controller KNOWS (it drove the keys that produced
# them), handed to the JavaScript assertions so they never have to guess a
# region boundary out of the transcript. Empty for every other scenario.
marks = {}

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
            raise TimeoutError("Journey PTY exceeded its fixed time limit at " + stage)
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("Journey PTY harness ended before the expected marker at " + stage)
        read_once(0.05)

def wait_for_after(marker, offset):
    while marker not in captured[offset:]:
        if time.monotonic() >= deadline:
            raise TimeoutError("Journey PTY exceeded its fixed time limit at " + stage)
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("Journey PTY harness ended before the expected marker at " + stage)
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
        "ORCODE_JOURNEY_CLI_MODULE": config["cliModuleUrl"],
        "ORCODE_JOURNEY_TUI_MODULE": config["tuiModuleUrl"],
        "TERM": "xterm-256color",
    })
    # J-F and J-G are an explicit colour/no-colour pair. Pin only those two
    # control cases; the unrelated journeys continue to inherit the owner's
    # ordinary terminal preferences.
    if config["scenario"] == "zones-on-screen":
        environment.pop("NO_COLOR", None)
        environment["FORCE_COLOR"] = "3"
    elif config["scenario"] in ("hub-with-recent", "zones-on-screen-no-color"):
        # NO_COLOR real-binary parity (FIX-21, visual audit 2026-08-28,
        # finding 1): theme.ts's own header explains chalk never implements
        # NO_COLOR itself (only FORCE_COLOR/argv/CI/TERM/TTY) and the defect
        # stayed invisible for a long time because every in-process test runs
        # on a non-TTY, where the level is already 0 for an unrelated reason
        # -- it only reproduced "driven over a real PTY with
        # TERM=xterm-256color and NO_COLOR=1". This IS that real PTY. J-A
        # piggybacks the check (rather than adding a sixth named journey):
        # its own hub-render assertions stay exactly as strict, PLUS the
        # rendered bytes must carry zero SGR colour/style codes.
        environment.pop("FORCE_COLOR", None)
        environment["NO_COLOR"] = "1"
    process = subprocess.Popen(
        [config["nodeExecutable"], config["harnessPath"], config["scenario"]],
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

    scenario = config["scenario"]

    stage = "ready marker"
    wait_for(b"ORCODE_JOURNEY_READY:")
    # Anchored right after the READY marker's own line: the harness writes
    # this marker BEFORE it ever calls cli.runCli(), so everything the real
    # TerminalUi renders is strictly after this point. This must NOT be
    # anchored after the (later, async) MODEL_RESOLVED marker instead: the
    # renderer only ever emits CHANGED rows (a real diffing terminal
    # renderer, not a fixed re-paint), and the hub's wordmark/Route/Recent
    # rows are painted once at the FIRST frame and never rewritten again —
    # by the time listModels() resolves and MODEL_RESOLVED is written, that
    # first paint is already old news and will never be retransmitted, so
    # waiting for it to reappear AFTER that later marker hangs forever.
    ready_line_end = captured.index(b"\n", captured.index(b"ORCODE_JOURNEY_READY:")) + 1

    stage = "hub brand block"
    wait_for_after(b"ORCODE", ready_line_end)
    stage = "hub Recent heading"
    wait_for_after(b"Recent", ready_line_end)
    stage = "hub Recent row for the prior chat"
    wait_for_after(b${JSON.stringify(PRIOR_CHAT_TITLE)}, ready_line_end)
    hub_confirmed_at = len(captured)

    stage = "model resolved marker"
    wait_for(b"ORCODE_JOURNEY_MODEL_RESOLVED:")
    # A real background Promise chain (loadProviderModelSnapshot(...).then(...))
    # assigns currentModelInfo right after listModels() resolves — a tiny,
    # real settle margin before J-E types its draft, not a timing heuristic
    # the assertions themselves rely on (the actual pass/fail signal is
    # always the rendered text, checked below).
    time.sleep(0.1)

    if scenario == "hub-with-recent":
        # Audit FIX-1: Shift+Tab (terminals send CSI Z) cycles the approval
        # mode ask -> auto-edit -> read-only, allow-all deliberately excluded
        # from the cycle. One press from the default "ask" must land on
        # "auto-edit" -- verified in scripts/check-journeys.mjs's own
        # assertHubWithRecent.
        before_shift_tab = len(captured)
        write_all(b"\x1b[Z")
        stage = "shift-tab approval cycle"
        wait_for_after(b"Approvals: ", before_shift_tab)
    elif scenario == "new-command-stays-hub":
        before_new = len(captured)
        type_text(b"/new")
        write_all(b"\r")
        stage = "new command dispatched"
        wait_for_after(b"Running command", before_new)
        # J2 finding 1: the status row DOES change here ("Ready" falls through
        # to the identity chrome, the confirmation replaces it), so unlike the
        # hub's stable Route/Recent/quick-action rows this one really is
        # retransmitted by the diffing renderer and is safe to wait for. J1
        # found it never arrived at all -- the confirmation was computed and
        # dispatched, then erased by the next readInput()'s own "Ready" before
        # the debounced paint could fire. Waited for BEFORE the composer
        # placeholder below purely for a sharper failure stage: both rows are
        # painted by the same single write, status row first (it sits above
        # the composer), so this can never wait on something the placeholder
        # wait would not already have covered.
        stage = "new chat confirmation on the status line"
        wait_for_after(b"New chat started.", before_new)
        # The hub's own composer placeholder is what proves the VIEW did not
        # flip: it holds the literal typed "/new" while typing, then reverts
        # to this text once the command completes (a transcript view uses the
        # generic "Describe your task …" placeholder instead, see
        # inputPlaceholder() in dashboard-frame.ts). The Route/Recent/quick-
        # action rows are byte-identical before and after /new (same folder,
        # same single prior chat, same route), so a renderer that only ever
        # transmits CHANGED rows never repaints them -- waiting for any of
        # those to reappear would hang forever.
        stage = "hub placeholder restored after /new"
        wait_for_after(b"Type to start a new chat in", before_new)
    elif scenario == "recent-row-opens-chat":
        write_all(b"\x1b[B")
        write_all(b"\r")
        stage = "transcript turn text"
        wait_for_after(b${JSON.stringify(PRIOR_ASSISTANT_TEXT)}, hub_confirmed_at)
    elif scenario == "quit-fresh-hub-no-ghost":
        pass
    elif scenario == "cost-forecast-on-draft":
        before_draft = len(captured)
        type_text(b"Explain how routing works here")
        stage = "cost forecast segment"
        # Not "~$": a sub-$0.01 bound renders as "~<$0.01-$0.02"
        # (forecastBound/formatCostForecastBand, utils.ts) -- "<" sits
        # between the "~" prefix and the "$" for a small estimate, so "~$"
        # would never match. "~" alone is the one byte every forecast
        # rendering shares (equal-bound "~$0.02" and split-bound
        # "~<$0.01-$0.02" alike) and it appears nowhere else on this ASCII-
        # glyph hub (the box/brand art below only ever uses "-", "|", "/",
        # "\\").
        wait_for_after(b"~", before_draft)
        # The render debounce is 30ms (TerminalUi#scheduleRender); typing
        # the last couple of characters and quitting immediately can outrun
        # it, so the composer's own final redraw (proving the FULL draft
        # text, not just its first few characters, actually reached the
        # terminal) never gets flushed before teardown. A short real settle
        # avoids that harness-timing race — the forecast wait above already
        # proved the causal thing this journey is about.
        time.sleep(0.15)
        wait_for_after(b"Explain how routing works here", before_draft)
    elif scenario in ("zones-on-screen", "zones-on-screen-no-color"):
        # V4-C. One pass over the three zoned surfaces an owner meets in a
        # row, driven by the keys an owner actually presses. Every wait is
        # marker-driven (no sleeps): each surface change is a full repaint,
        # so the diffing renderer really does retransmit the rows below.
        marks["paletteOpen"] = len(captured)
        # Ctrl+P — the palette's own key (check-pty.mjs drives it the same
        # way). Deliberately NOT the inline "/" trigger: that one puts the
        # typed text in the composer as well, and this journey is about what
        # the PALETTE paints, not about the composer.
        write_all(b"\x10")
        stage = "palette title bar"
        wait_for_after(b${JSON.stringify(ZONE_PALETTE_CRUMB)}, marks["paletteOpen"])
        stage = "palette action bar"
        # Just the KEY, never "Esc close": a coloured render puts an SGR
        # sequence between the key and its effect word, so the two are never
        # adjacent bytes. The pairing is asserted on the JavaScript side,
        # which strips SGR first; this wait only has to know the bar arrived.
        wait_for_after(b"Esc", marks["paletteOpen"])
        marks["paletteClosed"] = len(captured)
        write_all(b"\x1b")

        # /settings takes an optional category argument, so the palette's
        # Enter INSERTS it into the composer (commandMenuEnterVerb -> "insert",
        # ui/command-menu.ts) and a second Enter is what submits it. Both
        # presses are deliberate; neither is a retry. (No backticks anywhere in
        # this Python: it lives inside a JS template literal, and one backtick
        # ends the template and turns the rest of the controller into code.)
        marks["settingsOpen"] = len(captured)
        type_text(b"/settings")
        write_all(b"\r")
        write_all(b"\r")
        stage = "settings title bar"
        wait_for_after(b${JSON.stringify(ZONE_SETTINGS_CRUMB)}, marks["settingsOpen"])
        stage = "settings action bar"
        wait_for_after(b"Esc", marks["settingsOpen"])

        # The ordinal key the tab bar itself advertises: Appearance is the
        # fifth category, and it is the one category whose editors touch no
        # provider at all (check-pty.mjs picks it for the same reason).
        appearance_at = len(captured)
        write_all(b"5")
        stage = "settings Appearance category"
        wait_for_after(b${JSON.stringify(ZONE_APPEARANCE_CRUMB)}, appearance_at)

        marks["editorOpen"] = len(captured)
        write_all(b"\r")
        stage = "settings editor crumb"
        wait_for_after(b${JSON.stringify(ZONE_EDITOR_CRUMB)}, marks["editorOpen"])
        stage = "settings editor current value"
        # The LABEL only: the value beside it is a span of its own, so a
        # coloured render never puts "Current: Off" in adjacent bytes. The
        # full line is asserted on the JavaScript side, SGR stripped first.
        wait_for_after(b"Current: ", marks["editorOpen"])

        editor_cancel_at = len(captured)
        write_all(b"\x1b")
        stage = "editor cancelled, back on the Settings surface"
        wait_for_after(b${JSON.stringify(ZONE_APPEARANCE_CRUMB)}, editor_cancel_at)
        marks["settingsClosed"] = len(captured)
        write_all(b"\x1b")
        stage = "settings closed, back on the hub"
        wait_for_after(b"Recent", marks["settingsClosed"])
    else:
        raise RuntimeError("unknown-scenario: " + scenario)

    stage = "quit (first Ctrl+C)"
    # FIX-1/FIX-20 (audit 2026-08-28): a single Ctrl+C at the idle prompt no
    # longer closes orcode outright (it used to discard a typed draft with
    # no warning). The first press now only clears any draft and arms a
    # 6-second "press again" window (#interrupt, src/tui.ts); a SECOND
    # Ctrl+C while that window is still fresh, with no draft left, is what
    # actually raises UiExitError. J-E deliberately quits with an unsent
    # draft still in the composer, so its first press consumes exactly that
    # clear-the-draft step -- the second press below is what quits for every
    # journey alike.
    before_first_ctrl_c = len(captured)
    write_all(b"\x03")
    stage = "quit (arm confirmation)"
    wait_for_after(b"Ctrl+C again closes orcode", before_first_ctrl_c)
    stage = "quit (second Ctrl+C)"
    write_all(b"\x03")
    stage = "exit message"
    wait_for(b"See you soon.")
    stage = "result marker"
    wait_for(b"ORCODE_JOURNEY_RESULT:")

    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("Journey PTY did not exit within the fixed time limit")
        read_once(0.05)
    while read_once(0.0):
        pass

    result = {
        "exitCode": process.returncode,
        "marks": marks,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
        "timedOut": False,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
except Exception as error:
    failure = {
        "controllerError": str(error),
        "stage": stage,
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

/**
 * The five pinned journeys (task brief order J-A..J-E). `assert` runs
 * against the FULL decoded PTY transcript plus the self-reported
 * `ORCODE_JOURNEY_RESULT:` JSON — tolerant-but-honest matchers (structure,
 * key strings, ordering), never a byte-for-byte frame pin.
 */
export const JOURNEYS = Object.freeze([
  {
    id: "hub-with-recent",
    label: "J-A: launch into a folder with a populated chat",
    assert: assertHubWithRecent,
  },
  {
    id: "new-command-stays-hub",
    label: "J-B: /new from the hub stays on the hub",
    assert: assertNewCommandStaysHub,
  },
  {
    id: "recent-row-opens-chat",
    label: "J-C: opening the Recent row renders the transcript",
    assert: assertRecentRowOpensChat,
  },
  {
    id: "quit-fresh-hub-no-ghost",
    label: "J-D: quitting the fresh hub leaves no ghost chat file",
    assert: assertQuitFreshHubNoGhost,
  },
  {
    id: "cost-forecast-on-draft",
    label: "J-E: a draft on the hub gains the cost-forecast segment",
    assert: assertCostForecastOnDraft,
  },
  {
    id: "zones-on-screen",
    label: "J-F: the V4 zones are on the real screen — palette, Settings, editor",
    assert: zonesAssertion({ color: true }),
  },
  {
    id: "zones-on-screen-no-color",
    label: "J-G: the same zones under a real NO_COLOR=1, carried by shape alone",
    assert: zonesAssertion({ color: false }),
  },
]);

function readMarker(output, marker) {
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`Journey PTY output does not contain ${marker}.`);
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
 * Every journey shares this precondition + postcondition shape: a real TTY
 * pair, a clean exit, and the self-reported result marker. Also returns
 * `renderStart`/`renderEnd` — the byte range of ACTUAL terminal rendering,
 * excluding the harness's own diagnostic marker lines (which embed real
 * UUIDs and path-shaped JSON of their own and must never be mistaken for
 * rendered content by a substring check).
 */
function commonChecks(output) {
  if (!output.includes("See you soon.")) {
    throw new Error("The journey did not reach the normal exit message — quit was not clean.");
  }
  const ready = readMarker(output, "ORCODE_JOURNEY_READY:");
  if (ready.stdinTTY !== true || ready.stdoutTTY !== true) {
    throw new Error("The journey did not run on a real TTY pair.");
  }
  const journeyResult = readMarker(output, "ORCODE_JOURNEY_RESULT:");
  if (journeyResult.exitCode !== 0) {
    throw new Error(`The journey harness exited with code ${String(journeyResult.exitCode)}.`);
  }
  // Anchored past the READY marker's own line, not the later MODEL_RESOLVED
  // one — see the matching comment in the Python controller above
  // (`ready_line_end`) for why: the hub's wordmark/Route/Recent rows paint
  // once at the very first frame, strictly after READY and strictly before
  // the async MODEL_RESOLVED marker in the byte stream.
  const readyAt = output.indexOf("ORCODE_JOURNEY_READY:");
  const renderStart = output.indexOf("\n", readyAt) + 1;
  const renderEnd = output.indexOf("ORCODE_JOURNEY_RESULT:");
  return { ready, journeyResult, renderStart, renderEnd };
}

function assertHubWithRecent(output) {
  const { ready, journeyResult, renderStart, renderEnd } = commonChecks(output);
  // Brand block (wordmark + version) and the Route row, near the top of the
  // very first hub render — before any key was ever sent.
  const wordmarkAt = output.indexOf("ORCODE", renderStart);
  const routeAt = output.indexOf("Route", wordmarkAt);
  const recentHeadingAt = output.indexOf("Recent", routeAt);
  const recentRowAt = output.indexOf(PRIOR_CHAT_TITLE, recentHeadingAt);
  if (wordmarkAt < 0 || routeAt <= wordmarkAt || recentHeadingAt <= routeAt || recentRowAt <= recentHeadingAt) {
    throw new Error("The hub did not render brand block, then Route, then a Recent row, in order.");
  }
  // The owner's own complaint: no OLD transcript content leaking onto a
  // fresh hub — the prior chat's actual turn text must never appear, only
  // its Recent-row metadata (title, message count, relative time).
  if (output.slice(renderStart).includes(PRIOR_ASSISTANT_TEXT)) {
    throw new Error("The prior chat's transcript text leaked onto the fresh hub.");
  }
  // "no bare path line above a void": the hub suppresses the plain
  // workspace-path header line (dashboard-frame.ts's `isHub` -> `omitWorkspace`)
  // in favor of the brand block stating it — a bare raw absolute path line
  // between the harness's own markers and the wordmark would be the pre-D8
  // regression this journey exists to catch.
  const beforeWordmark = output.slice(renderStart, wordmarkAt);
  if (/^\/\S+\s*$/m.test(beforeWordmark)) {
    throw new Error("A bare workspace-path header line rendered above the hub's brand block.");
  }
  if (journeyResult.chatFileIds.length !== 1 || journeyResult.chatFileIds[0] !== journeyResult.existingChatId) {
    throw new Error(
      `Merely viewing the hub must not persist the fresh session: chat files on disk were ${JSON.stringify(journeyResult.chatFileIds)}.`,
    );
  }
  // Audit FIX-1 (Shift+Tab approval cycle): ask -> auto-edit -> read-only,
  // allow-all NEVER reachable from this key (SHIFT_TAB_APPROVAL_CYCLE,
  // src/tui.ts). The default config starts at "ask", so one press must land
  // on exactly "auto-edit".
  const cycleAt = output.indexOf("Approvals: ", renderStart);
  if (cycleAt < 0) {
    throw new Error("Shift+Tab never announced an approval-mode change.");
  }
  const announced = output.slice(cycleAt + "Approvals: ".length, cycleAt + "Approvals: ".length + 20);
  if (!announced.startsWith("auto-edit")) {
    throw new Error(`Shift+Tab from the default "ask" mode did not land on "auto-edit" (saw: ${JSON.stringify(announced)}).`);
  }
  if (output.slice(renderStart).includes("Approvals: allow-all")) {
    throw new Error("Shift+Tab must never cycle into allow-all.");
  }
  // NO_COLOR real-binary parity (FIX-21): this scenario runs with a real
  // NO_COLOR=1 environment (scripts/check-journeys.mjs's Python controller)
  // specifically because the bug this guards against ONLY reproduced over a
  // real PTY (every in-process/non-TTY test already reads level 0 for an
  // unrelated reason and could never have caught it) -- theme.ts's own
  // `base()` returns identity at level 0, so zero SGR "...m" sequences
  // should exist anywhere in a real render. Cursor positioning and other
  // control sequences use different terminators (H, K, J, ...), so this
  // pattern is unambiguous.
  const sgrMatch = /\x1b\[[0-9;]*m/.exec(output.slice(renderStart, renderEnd));
  if (sgrMatch) {
    throw new Error(`NO_COLOR=1 still produced an SGR colour/style code: ${JSON.stringify(sgrMatch[0])}.`);
  }
  return { columns: ready.columns, rows: ready.rows };
}

function assertNewCommandStaysHub(output) {
  const { ready, journeyResult, renderStart, renderEnd } = commonChecks(output);
  const rendered = output.slice(renderStart, renderEnd);
  const newAt = rendered.indexOf("/new");
  if (newAt < 0) throw new Error("The typed /new command was never echoed to the terminal.");
  const dispatchedAt = rendered.indexOf("Running command", newAt);
  if (dispatchedAt < 0) throw new Error("/new was never dispatched to the command handler.");
  // Proof the hub (not a transcript) owns the screen again: the empty-hub
  // composer placeholder ("Type to start a new chat in <folder> …",
  // dashboard-frame.ts's `inputPlaceholder`) is unique to `atHub` — a
  // transcript view shows the generic "Describe your task …" placeholder
  // instead. This specific text is guaranteed to be genuinely retransmitted
  // (not skipped by the diffing renderer) because its row's content
  // actually changes across this exact span: it held the literal typed
  // "/new" a moment ago, then reverts to this placeholder once the new,
  // empty chat is live — unlike the Route/Recent rows, which stay pixel-for-
  // pixel identical across /new (same folder, same one prior chat, same
  // route) and are therefore never retransmitted at all by a renderer that
  // only ever writes CHANGED rows.
  // J2 finding 1: not "the confirmation was computed" — "the confirmation was
  // PAINTED". `applyDashboardCommandOutput` put it on the transient status
  // channel exactly as D8e designed and the loop's `landedOnEmptyChat` guard
  // spared it from the generic "Ready" reset, yet the next `readInput()`'s own
  // mode entry overwrote it and painted immediately, cancelling the debounced
  // paint that would have shown it. This is the only check that can tell those
  // two states apart, because every in-process test sees the correct string on
  // the correct channel either way.
  const confirmationAt = rendered.indexOf("New chat started.", dispatchedAt);
  if (confirmationAt < 0) {
    throw new Error("/new's confirmation never reached the terminal — the status channel was overwritten before it was painted.");
  }
  const hubPlaceholderAt = rendered.indexOf("Type to start a new chat in", dispatchedAt);
  if (hubPlaceholderAt < 0) {
    throw new Error("The hub's empty-composer placeholder never returned after /new — did the view flip away from the hub?");
  }
  // J2 finding 2, at the `/new` site: `replaceSession` (commands.ts) used to
  // save the chat it created and the one it walked away from unconditionally,
  // so `launch → /new → quit` left THREE files behind (the prior chat plus two
  // untouched "New Chat" ghosts) where one belongs.
  assertOnlyThePriorChatOnDisk(journeyResult, "launching, running /new and quitting");
  // Scoped to `rendered` (excludes the harness's own diagnostic marker
  // lines, which legitimately embed real chat UUIDs of their own) --
  // otherwise this would always be true regardless of what the terminal
  // actually showed.
  if (UUID_REGEX().test(rendered)) {
    throw new Error("A raw chat UUID was rendered on screen after /new.");
  }
  if (rendered.includes(PRIOR_ASSISTANT_TEXT)) {
    throw new Error("/new must not flip to any transcript content.");
  }
  return { chatFileIds: journeyResult.chatFileIds, ready };
}

function assertRecentRowOpensChat(output) {
  const { ready, journeyResult, renderStart, renderEnd } = commonChecks(output);
  // No lower bound tighter than `renderStart` is meaningful here: the
  // down-arrow/Enter bytes the controller SENT are PTY input, never echoed
  // back into this captured OUTPUT stream, so there is no "after the
  // keypress" marker to search from other than the render range itself —
  // which is exactly what the absence check below (turn text not appearing
  // anywhere in the initial hub paint) already relies on.
  const turnAt = output.indexOf(PRIOR_ASSISTANT_TEXT, renderStart);
  if (turnAt < 0) {
    throw new Error("Opening the Recent row never rendered the prior chat's real turn text.");
  }
  // Hub gone: neither the wordmark nor the Recent heading is re-emitted
  // after the transcript's own turn text has appeared (the renderer only
  // ever writes rows that changed -- once the transcript owns the screen, the
  // hub's own rows are never redrawn again).
  const afterSwitch = output.slice(turnAt, renderEnd);
  if (afterSwitch.includes("Recent") || afterSwitch.includes("No route configured")) {
    throw new Error("The hub's welcome box kept rendering after the Recent row was opened.");
  }
  // J2 finding 2, at the pick site: `saveDashboardSessionPreferences`
  // (cli.ts) writes the chat being LEFT, and a bare launch always leaves an
  // untouched fresh session current (D8c) — so without its `isUntouched`
  // guard the very first Recent pick of a session turned that session into a
  // permanent "New Chat" file, which then appeared as its own Recent row on
  // the next launch. The chat this journey OPENED has real content, so a
  // guard that mistakenly skipped a touched chat would show up as the prior
  // chat's own id going missing from this same list.
  assertOnlyThePriorChatOnDisk(journeyResult, "opening a Recent row and quitting");
  return { chatFileIds: journeyResult.chatFileIds, ready };
}

/**
 * The one on-disk claim J-B, J-C and J-D all make, in one place: after this
 * journey, the only chat file that exists is the populated one the workspace
 * started with. Read off the harness's own `CHAT_ARTIFACT_REGISTRY.all`
 * enumeration — the same registry the app itself uses — so it counts real
 * files, not a listing surface (`listChatsAcrossWorkspaces`'s ghost filter is
 * a display guard: it hides ghosts, it never stops them accumulating).
 */
function assertOnlyThePriorChatOnDisk(journeyResult, what) {
  if (
    journeyResult.chatFileIds.length !== 1
    || journeyResult.chatFileIds[0] !== journeyResult.existingChatId
  ) {
    throw new Error(
      `${what} left a ghost chat file: ${JSON.stringify(journeyResult.chatFileIds)} (expected only the prior chat ${journeyResult.existingChatId}).`,
    );
  }
}

function assertQuitFreshHubNoGhost(output) {
  const { ready, journeyResult } = commonChecks(output);
  assertOnlyThePriorChatOnDisk(journeyResult, "quitting the untouched fresh hub");
  if (journeyResult.agentCalls !== 0 || journeyResult.providerCalls !== 0) {
    throw new Error("Quitting the fresh hub must never call the agent or a provider action.");
  }
  return { chatFileIds: journeyResult.chatFileIds, ready };
}

// Matches both of `formatCostForecastBand`'s (utils.ts) shapes: an
// equal-bound "~$0.02" and a split-bound "~<$0.01-$0.02" (a sub-$0.01 low
// bound inserts "<" between the "~" prefix and the "$" figure, so a plain
// "~$" substring check would never match the common small-draft case).
const COST_FORECAST_PATTERN = /~<?\$/;

function assertCostForecastOnDraft(output) {
  const { ready, journeyResult, renderStart } = commonChecks(output);
  // NOT anchored on where the draft text itself first appears in the BYTE
  // stream: a single render paints top-down (the status row sits above the
  // composer row in this layout), so a render triggered by a keystroke
  // writes the status segment's bytes BEFORE that same keystroke's echoed
  // character, even though the character causally came first. Byte position
  // is therefore not a reliable proxy for real time here. The one boundary
  // that genuinely IS real-time-ordered is the harness's own
  // MODEL_RESOLVED marker: the PTY controller (scripts/check-journeys.mjs's
  // Python side) only ever sends the draft's keystrokes strictly after it
  // has observed that marker, so anything at or before it is provably
  // pre-typing.
  const beforeTyping = output.indexOf("ORCODE_JOURNEY_MODEL_RESOLVED:");
  if (beforeTyping < 0) throw new Error("Missing the model-resolved marker.");
  if (COST_FORECAST_PATTERN.test(output.slice(renderStart, beforeTyping))) {
    throw new Error("A cost-forecast segment was visible before any draft existed.");
  }
  if (!COST_FORECAST_PATTERN.test(output.slice(beforeTyping))) {
    throw new Error("The status line never gained a cost-forecast segment for a draft over a priced route.");
  }
  if (!output.includes("Explain how routing works here")) {
    throw new Error("The full typed draft was never echoed to the terminal.");
  }
  return { chatFileIds: journeyResult.chatFileIds, ready };
}

function UUID_REGEX() {
  return new RegExp(UUID_PATTERN, "i");
}

// ---------------------------------------------------------------------------
// J-F / J-G — the V4 screen anatomy, on the shipped binary.
//
// `tests/ui-zone-anatomy*.test.ts` and `tests/ui-zone-cross-surface.test.ts`
// pin the zones on FRAMES, in process. They cannot see the one thing that
// matters most to the owner: whether the bytes the real binary writes into a
// real terminal actually carry them. Everything below is asserted on the raw
// PTY transcript — the inverse SGR run for the title bar, the crumb text, the
// chips, the dense row, the grown crumb and the `Current:` line — and, at
// NO_COLOR, on their shape-only degradations with not one SGR byte emitted.
// ---------------------------------------------------------------------------

/** One SGR colour/style sequence — the only escapes a theme ever writes. */
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
/** `chalk.inverse` — the `inverse` role, and the whole of zone 1's loudness. */
const INVERSE_OPEN = "\x1b[7m";

/**
 * The transcript as a reader would see it: SGR dropped (it is asserted
 * separately, on the raw bytes), every OTHER control sequence turned into a
 * line break.
 *
 * The line break matters. A diffing renderer repositions the cursor between
 * rows, so simply deleting the control sequences would glue the tail of one
 * row onto the head of the next and let a substring check match text that was
 * never on one line — the exact false pass a screen-anatomy pin must not be
 * able to give.
 */
function paintedText(bytes) {
  return bytes
    .toString("utf8")
    .replace(SGR_PATTERN, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "\n");
}

/**
 * Builds J-F (colour) or J-G (NO_COLOR) — one key sequence, one set of facts,
 * two renderings. Everything that is about STRUCTURE (crumb text, chips,
 * dense rows, the counter) is asserted identically in both; only how each
 * fact is CARRIED differs, which is precisely the iron rule under test.
 */
function zonesAssertion({ color }) {
  return function assertZonesOnScreen(output, controller, bytes) {
    const { ready, journeyResult, renderStart, renderEnd } = commonChecks(output);
    const marks = controller?.marks ?? {};
    const needed = ["paletteOpen", "paletteClosed", "settingsOpen", "editorOpen", "settingsClosed"];
    for (const name of needed) {
      if (typeof marks[name] !== "number") {
        throw new Error(`The PTY controller did not report its "${name}" byte offset.`);
      }
    }
    // Sliced on the raw BYTES the controller counted, never on the decoded
    // string: the two only agree while the output is pure ASCII, and a
    // regression that leaked one non-ASCII byte would otherwise silently
    // shift every region boundary instead of failing.
    const rawPalette = bytes.subarray(marks.paletteOpen, marks.paletteClosed).toString("utf8");
    const rawSettings = bytes.subarray(marks.settingsOpen, marks.settingsClosed).toString("utf8");
    const palette = paintedText(bytes.subarray(marks.paletteOpen, marks.paletteClosed));
    const settings = paintedText(bytes.subarray(marks.settingsOpen, marks.settingsClosed));
    const editor = paintedText(bytes.subarray(marks.editorOpen, marks.settingsClosed));
    const has = (region, needle, what) => {
      if (!region.includes(needle)) {
        throw new Error(`${what}: the terminal never showed ${JSON.stringify(needle)}.`);
      }
    };

    // --- Zone 1, the title bar -------------------------------------------
    has(palette, ZONE_PALETTE_CRUMB, "The palette's title bar");
    has(settings, ZONE_SETTINGS_CRUMB, "The Settings title bar");
    has(editor, ZONE_EDITOR_CRUMB, "The Settings editor's grown crumb");
    if (color) {
      // The bar is REALLY the inverse role, not a lookalike drawn out of
      // spaces: `chalk.inverse` opens with CSI 7 m and the crumb follows it
      // immediately.
      for (const [region, crumb, what] of [
        [rawPalette, ZONE_PALETTE_CRUMB, "palette"],
        [rawSettings, ZONE_SETTINGS_CRUMB, "Settings"],
      ]) {
        if (!region.includes(`${INVERSE_OPEN} ${crumb}`)) {
          throw new Error(`The ${what} crumb was painted, but not as the inverse title bar.`);
        }
      }
      // ONE LOOK PER MEANING, on the real screen. Across the WHOLE zoned pass
      // — palette, Settings, the editor opened on top of it, and every
      // repaint in between — the inverse role is spent on nothing but a title
      // bar, and a title bar is a crumb. Anything else that came out inverse
      // is something else wearing the screen's one loud look, which is
      // exactly the drift `ui/zones.ts` caps zone 1 at one line to prevent.
      const crumbs = [ZONE_PALETTE_CRUMB, ZONE_SETTINGS_CRUMB.split(" > ")[0]];
      const zoned = bytes.subarray(marks.paletteOpen, marks.settingsClosed).toString("utf8");
      let at = zoned.indexOf(INVERSE_OPEN);
      let bars = 0;
      while (at >= 0) {
        const painted = zoned.slice(at + INVERSE_OPEN.length, at + INVERSE_OPEN.length + 48);
        if (!crumbs.some((crumb) => painted.startsWith(` ${crumb}`))) {
          throw new Error(
            `Something other than a title bar was painted in the inverse role: ${JSON.stringify(painted)}.`,
          );
        }
        bars += 1;
        at = zoned.indexOf(INVERSE_OPEN, at + 1);
      }
      if (bars === 0) throw new Error("The zoned surfaces painted no inverse title bar at all.");
    } else {
      // Shape, not colour. The bar degrades to the divider rule it replaced
      // (`─ <crumb>`, ASCII `-`), and the whole pass emits no SGR whatsoever
      // — the FIX-21 defect class, checked over the zones this time.
      has(palette, `- ${ZONE_PALETTE_CRUMB}`, "The palette's degraded title rule");
      has(settings, `- ${ZONE_SETTINGS_CRUMB}`, "The Settings degraded title rule");
      has(editor, `- ${ZONE_EDITOR_CRUMB}`, "The editor's degraded title rule");
      const sgr = new RegExp(SGR_PATTERN.source).exec(output.slice(renderStart, renderEnd));
      if (sgr) {
        throw new Error(`NO_COLOR=1 still produced an SGR colour/style code: ${JSON.stringify(sgr[0])}.`);
      }
    }

    // --- Zone 2, the content ---------------------------------------------
    // The tab bar: every category on one line, the live one on the filled
    // bullet (`*` in this harness's forced ASCII glyph mode) and the rest on
    // the hollow one — never on a second `>` cursor.
    ZONE_CATEGORY_LABELS.forEach((label, index) => {
      const live = `*${index + 1} ${label}`;
      const idle = `o${index + 1} ${label}`;
      if (!settings.includes(live) && !settings.includes(idle)) {
        throw new Error(`The Settings tab bar never showed category ${index + 1} (${label}).`);
      }
    });
    if (!settings.includes(`*1 ${ZONE_CATEGORY_LABELS[0]}`)) {
      throw new Error("Settings opened without marking its live category on the tab bar.");
    }
    if (!settings.includes(`*5 ${ZONE_CATEGORY_LABELS[4]}`)) {
      throw new Error("Pressing 5 never moved the live mark to the fifth category.");
    }
    // A dense row is ONE line carrying name, value and explanation — the
    // whole point of the Settings rebuild, and unprovable from a frame test
    // alone once a real terminal's width fitting is in play.
    if (!/Large ORCODE logo\s+Off\s+Show the large ORCODE mark/.test(settings)) {
      throw new Error("The Appearance rows are not dense (name, value and explanation on one line).");
    }
    // The universal counter, in its one form: `N of M` plus the theme
    // separator and a disclosure marker (ASCII `^`/`v`), never the arrow keys.
    if (!/\d+ of \d+ - [\^v]+/.test(palette)) {
      throw new Error("The overflowing palette never disclosed itself on the one `N of M` counter.");
    }
    // The editor state's own second line — what the row says right now.
    has(editor, ZONE_EDITOR_CURRENT, "The Settings editor's current-value line");

    // --- Zone 3, the action bar ------------------------------------------
    // The way out is on every one of the three surfaces, in that surface's
    // own words (`listActionChips`: close / back / cancel). At colour level 0
    // the key wears square brackets, which is the shape standing in for the
    // emphasis colour cannot carry.
    const chip = (key, effect) => (color ? `${key} ${effect}` : `[${key}] ${effect}`);
    has(palette, chip("Esc", "close"), "The palette's action bar");
    has(settings, chip("Esc", "back"), "The Settings action bar");
    has(editor, chip("Esc", "cancel"), "The editor's action bar");
    // …and it is a BAR of chips, not one key: the sideways axis the Settings
    // surface alone binds (`<` `>` in ASCII glyph mode) and its search key are
    // both advertised beside it.
    has(settings, chip("<>", "category"), "The Settings action bar");
    has(settings, chip("/", "search"), "The Settings action bar");
    has(palette, chip("^v", "select"), "The palette's action bar");

    // --- The honesty state, on the real screen ----------------------------
    // This harness deliberately launches with the owner's own shape: the
    // config file names one main model, the open chat runs on another,
    // because a resumed chat's preference lives in the runtime config only.
    // Settings used to read that as a foreign write to config.json and open
    // LOCKED on every such install — so the surface-wide warn state must be
    // absent here, and the editor above (which a locked row can never open)
    // is the second, independent proof of the same fact.
    //
    // Asserted on the TAB-BAR line, where `statusForms` right-aligns that
    // state: a bare "Locked" anywhere else is a single row naming its own
    // gate (`Locked · Model catalog not available`), which is a different
    // and entirely honest thing.
    const tabRows = settings.split("\n").filter((line) => line.includes("Approvals & Costs"));
    if (tabRows.length === 0) {
      throw new Error("The Settings tab bar never rendered, so its honesty state could not be read.");
    }
    for (const row of tabRows) {
      for (const word of ["Read-only", "Locked"]) {
        if (row.includes(word)) {
          throw new Error(
            `Settings showed "${word}" although only this process's own session preference differed from the file.`,
          );
        }
      }
    }

    // --- Postconditions ---------------------------------------------------
    // Reading three screens and cancelling out of an editor is a read-only
    // journey: no chat file, no provider call, no agent run.
    assertOnlyThePriorChatOnDisk(journeyResult, "walking the palette, Settings and an editor");
    if (journeyResult.agentCalls !== 0 || journeyResult.providerCalls !== 0) {
      throw new Error("Walking the zoned surfaces must never call the agent or a provider action.");
    }
    return { columns: ready.columns, rows: ready.rows, chatFileIds: journeyResult.chatFileIds };
  };
}

export async function runJourneyScenario(scenarioId, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("The real POSIX PTY journeys are not supported on Windows.");
  }
  const root = resolve(options.projectRoot ?? projectRoot);
  const cliModule = join(root, "dist", "cli.js");
  const tuiModule = join(root, "dist", "tui.js");
  const harnessPath = join(root, "tests", "fixtures", "journey-pty-harness.mjs");
  const accessFile = options.accessFile ?? access;
  for (const artifact of [cliModule, tuiModule, harnessPath]) {
    try {
      await accessFile(artifact);
    } catch (error) {
      throw new Error(
        `Build artifact or harness missing: ${artifact}. \`npm run build\` must run before the journey checks.`,
        { cause: error },
      );
    }
  }

  const request = {
    columns: options.columns ?? DEFAULT_COLUMNS,
    harnessPath,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    projectRoot: root,
    pythonExecutable: options.pythonExecutable ?? "python3",
    rows: options.rows ?? DEFAULT_ROWS,
    scenario: scenarioId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cliModuleUrl: pathToFileURL(cliModule).href,
    tuiModuleUrl: pathToFileURL(tuiModule).href,
  };
  const runController = options.runController ?? runPythonController;
  const controller = await runController(request);
  if (controller.timedOut === true || typeof controller.controllerError === "string") {
    const transcript = typeof controller.outputBase64 === "string"
      ? Buffer.from(controller.outputBase64, "base64").toString("utf8").slice(-1200)
      : "";
    throw new Error(
      `Journey "${scenarioId}" PTY controller failed at stage "${controller.stage ?? "?"}": ${
        controller.controllerError ?? "timed out"
      }${transcript ? `\n${transcript}` : ""}`,
    );
  }
  if (typeof controller.outputBase64 !== "string") {
    throw new Error(`Journey "${scenarioId}" did not return bounded raw output.`);
  }
  const bytes = Buffer.from(controller.outputBase64, "base64");
  if (bytes.length === 0 || bytes.length > request.maxOutputBytes) {
    throw new Error(`Journey "${scenarioId}" raw output is empty or exceeds the fixed output limit.`);
  }
  const output = bytes.toString("utf8");
  const journey = JOURNEYS.find((entry) => entry.id === scenarioId);
  if (!journey) throw new Error(`Unknown journey scenario: ${scenarioId}`);
  try {
    // `bytes` as well as `output`: J-F/J-G slice the transcript on the BYTE
    // offsets their PTY controller counted, and a byte offset is only a
    // character offset while the stream stays ASCII.
    return { id: scenarioId, ok: true, details: journey.assert(output, controller, bytes) };
  } catch (error) {
    const transcript = output.slice(-1200);
    throw new Error(
      `Journey "${journey.label}" FAILED: ${error instanceof Error ? error.message : String(error)}\n--- tail of captured PTY output ---\n${transcript}`,
      { cause: error },
    );
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
    scenario: request.scenario,
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
              `The journey PTY controller did not return valid JSON${
                stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "."
              }`,
              { cause: parseError },
            ),
          );
          return;
        }
        if (error && typeof parsed.controllerError !== "string") {
          reject(new Error(`The journey PTY controller process failed: ${error.message}`, { cause: error }));
          return;
        }
        resolvePromise(parsed);
      },
    );
  });
}

export async function runAllJourneys(options = {}) {
  const root = resolve(options.projectRoot ?? projectRoot);
  const cliModule = join(root, "dist", "cli.js");
  const tuiModule = join(root, "dist", "tui.js");
  const accessFile = options.accessFile ?? access;
  for (const artifact of [cliModule, tuiModule]) {
    try {
      await accessFile(artifact);
    } catch (error) {
      throw new Error(
        `Build artifact missing: ${artifact}. \`npm run build\` must run before \`npm run test:journeys\`.`,
        { cause: error },
      );
    }
  }
  const assertFresh = options.assertBuildIsFresh ?? assertBuildIsFresh;
  await assertFresh(root);

  const log = options.log ?? console.log;
  const results = [];
  for (const journey of JOURNEYS) {
    const result = await runJourneyScenario(journey.id, options);
    log(`  PASS  ${journey.label}`);
    results.push(result);
  }
  log(`Owner-journey PTY checks: ${results.length}/${JOURNEYS.length} journeys passed against the real built dist/cli.js.`);
  await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--test", "tests/gui-desktop-journey.test.ts"],
      {
        cwd: root,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NODE_TEST_CONTEXT: undefined,
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error) => error ? reject(error) : resolvePromise(),
    );
  });
  log("Desktop Cross GUI journey: 3/3 checks passed against the real built dist/gui-server.js.");
  return results;
}

export function isJourneyCheckEntrypoint(
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

if (isJourneyCheckEntrypoint(import.meta.url)) {
  runAllJourneys().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
