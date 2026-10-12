import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { displayWidth } from "../src/ui/compose.js";
import { ROLES, type Role } from "../src/ui/spans.js";
import { createTheme, spinnerFrame } from "../src/ui/theme.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED: Record<Role, { 3: string; 2: string; 1: string }> = {
  text: { 3: "", 2: "", 1: "" },
  muted: { 3: "\u001b[38;2;139;148;158m", 2: "\u001b[38;5;245m", 1: "\u001b[2m" },
  structure: { 3: "\u001b[38;2;75;85;99m", 2: "\u001b[38;5;240m", 1: "\u001b[2m" },
  accent: { 3: "\u001b[38;2;232;137;12m", 2: "\u001b[38;5;172m", 1: "\u001b[33m" },
  // FIX-21 finding 2: one accent hue — `active` paints exactly like `accent`.
  active: { 3: "\u001b[38;2;232;137;12m", 2: "\u001b[38;5;172m", 1: "\u001b[33m" },
  ok: { 3: "\u001b[38;2;63;185;80m", 2: "\u001b[38;5;114m", 1: "\u001b[32m" },
  warn: { 3: "\u001b[38;2;210;153;34m", 2: "\u001b[38;5;178m", 1: "\u001b[33m" },
  danger: { 3: "\u001b[38;2;248;81;73m", 2: "\u001b[38;5;203m", 1: "\u001b[31m" },
  add: { 3: "\u001b[38;2;63;185;80m", 2: "\u001b[38;5;114m", 1: "\u001b[32m" },
  del: { 3: "\u001b[38;2;248;81;73m", 2: "\u001b[38;5;203m", 1: "\u001b[31m" },
  inverse: { 3: "\u001b[7m", 2: "\u001b[7m", 1: "\u001b[7m" },
};

test("jede Rolle erzeugt auf Stufe 3, 2 und 1 genau den spezifizierten Präfix", () => {
  for (const level of [3, 2, 1] as const) {
    const theme = createTheme({ level });
    for (const role of ROLES) {
      const painted = theme.color(role)("x");
      const expected = EXPECTED[role][level];
      assert.equal(
        painted.startsWith(expected),
        true,
        `${role}@${level}: ${JSON.stringify(painted)} beginnt nicht mit ${JSON.stringify(expected)}`,
      );
      if (expected === "") {
        assert.equal(painted, "x", `${role}@${level} darf keinen Code tragen`);
      }
    }
  }
});

test("Rolle text trägt in keiner Stufe einen Vordergrundcode", () => {
  for (const level of [0, 1, 2, 3] as const) {
    const theme = createTheme({ level });
    assert.equal(theme.color("text")("Antwort"), "Antwort");
  }
});

test("Stufe 0 färbt gar nicht", () => {
  const theme = createTheme({ level: 0 });
  for (const role of ROLES) {
    assert.equal(theme.color(role)("x"), "x");
    assert.equal(theme.color(role, { bold: true, underline: true })("x"), "x");
  }
});

/**
 * FIX-21 finding 2 tripwire: ONE accent hue, project-wide.
 *
 * The audit found two — ansi256 172 (#d78700) on the dashboard and the
 * command menu (`accent`), ansi256 214 (#ffaf00) on the Settings surface
 * (`active`, which paints its selected row, its title status and every
 * spinner). One meaning, two looks, on surfaces one keystroke apart. Level 1
 * had always collapsed both to `yellow`, so the split was never designed.
 *
 * The two ROLES stay (R1 — "the live/selected one" is a real meaning worth
 * naming at span-creation time); what may never diverge again is the paint.
 */
test("exactly one accent hue: `active` paints identically to `accent` at every level (FIX-21 finding 2)", () => {
  for (const level of [0, 1, 2, 3] as const) {
    const theme = createTheme({ level });
    assert.equal(
      theme.color("active")("x"),
      theme.color("accent")("x"),
      `level ${level}: the settings/spinner accent must be the dashboard accent, not a second orange`,
    );
    assert.equal(
      theme.color("active", { bold: true })("x"),
      theme.color("accent", { bold: true })("x"),
      `level ${level}: the bold variants must not diverge either`,
    );
  }
});

test("keine Rolle setzt eine Hintergrundfarbe", () => {
  const theme = createTheme({ level: 3 });
  for (const role of ROLES) {
    const painted = theme.color(role)("x");
    assert.equal(/\u001b\[(4[0-79]|10[0-7]|48;)/.test(painted), false, role);
  }
});

test("bold und underline sind orthogonal zur Rolle", () => {
  const theme = createTheme({ level: 1 });
  const bold = theme.color("ok", { bold: true })("x");
  assert.equal(bold.includes("\u001b[1m"), true);
  assert.equal(bold.includes("\u001b[32m"), true);
  const underline = theme.color("text", { underline: true })("x");
  assert.equal(underline.includes("\u001b[4m"), true);
});

test("Glyphtabelle hat beide Sätze und eindeutige Zustandszeichen", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  assert.equal(unicode.glyph("ok"), "✓");
  assert.equal(unicode.glyph("failed"), "✗");
  assert.equal(unicode.glyph("warn"), "⚠");
  assert.equal(unicode.glyph("divider"), "─");
  assert.equal(unicode.glyph("userGutter"), ">");
  assert.equal(ascii.glyph("ok"), "+");
  assert.equal(ascii.glyph("failed"), "x");
  assert.equal(ascii.glyph("warn"), "!");
  assert.equal(ascii.glyph("divider"), "-");
  assert.equal(ascii.glyph("userGutter"), ">");
  assert.equal(ascii.ascii, true);

  for (const theme of [unicode, ascii]) {
    const states = ["ok", "unverified", "failed", "warn", "toolHead"] as const;
    const seen = new Set(states.map((name) => theme.glyph(name)));
    assert.equal(seen.size, states.length, "Zustandsglyphen müssen eindeutig sein");
  }
});

/**
 * FIX-21 finding 3 tripwire: the transcript's column-0 marks must be
 * distinguishable by SHAPE alone, in both charsets.
 *
 * The audit found `●` collapsing to `*` for several meanings at once. The
 * one that actually costs information is the pair that shares a position:
 * the answer gutter and the tool head both start a transcript row in column
 * 0, and in ASCII both were `*`. With NO_COLOR that left an answer and a
 * tool call literally identical — colour was the only thing telling them
 * apart, which is the failure mode the iron rule exists to prevent. The
 * elbow (`blockFoot`) belongs to the same column family: it opens the result
 * row under a tool head.
 *
 * Meanings that share a shape but never share a surface are deliberately
 * NOT in this set — `bullet` (the list overlay's `>-*` route-core cap) and
 * `mask` (the composer's secret input) both stay `*`, and `unverified`'s `~`
 * is shared with `interject`, which only ever appears behind a `>` on a user
 * row. Those are positional, not ambiguous.
 *
 * The set is asserted for ASCII only, on purpose: the UNICODE inventory has
 * the very same answer/tool ambiguity (`assistantGutter` is `● `, `toolHead`
 * is `●`, and both paint in the accent role), and it predates this fix. That
 * is a brand-mark decision for the design owner, not a fallback-table one —
 * recorded in the FIX-21 report rather than changed here. The ASCII mode is
 * where the iron rule bites, because there colour cannot help at all.
 */
test("transcript column-0 ASCII marks are unique by shape (FIX-21 finding 3)", () => {
  const family = ["userGutter", "assistantGutter", "toolHead", "blockEdge", "blockFoot"] as const;
  const ascii = createTheme({ level: 0, ascii: true });
  const marks = family.map((name) => ascii.glyph(name).trimEnd());
  assert.equal(
    new Set(marks).size,
    family.length,
    `a transcript row's opening mark must name its own meaning, got ${JSON.stringify(marks)}`,
  );
  // Named explicitly, because this exact pair is the audit's finding.
  assert.notEqual(
    ascii.glyph("assistantGutter").trimEnd(),
    ascii.glyph("toolHead"),
    "an answer and a tool call must not be the same character in the same column",
  );
});

/**
 * FIX-21 finding 3, the elbow specifically: `⎿`'s ASCII pair used to be a
 * backtick, which reads as debris rather than as structure. Pinned by value
 * so the choice cannot silently drift back.
 */
test("the block elbow's ASCII pair is a corner shape, never a backtick (FIX-21 finding 3)", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  assert.equal(ascii.glyph("blockFoot"), "L");
  assert.notEqual(ascii.glyph("blockFoot"), "`");
  // It must not collide with the outcome glyph printed right after it on the
  // same line (`⎿ ✓ …` / `L + …`), nor with any spinner frame one row above.
  assert.notEqual(ascii.glyph("blockFoot"), ascii.glyph("ok"));
  assert.equal(
    Array.from(ascii.glyph("spinner")).includes(ascii.glyph("blockFoot")),
    false,
    "the elbow must not be a spinner frame",
  );
});

test("ASCII-Glyphen sind reines ASCII", () => {
  const ascii = createTheme({ level: 0, ascii: true });
  const names = [
    "userGutter",
    "assistantGutter",
    "toolHead",
    "diffHead",
    "blockEdge",
    "blockFoot",
    "divider",
    "marker",
    "spinner",
    "interject",
    "ok",
    "unverified",
    "failed",
    "warn",
    "quoteGutter",
    "scrollUp",
    "scrollDown",
    "scrollLeft",
    "scrollRight",
    "bullet",
    "separator",
    "ellipsis",
    "mask",
    "boxTopLeft",
    "boxTopRight",
    "boxBottomLeft",
    "boxBottomRight",
    "boxH",
    "boxV",
  ] as const;
  for (const name of names) {
    // eslint-disable-next-line no-control-regex
    assert.equal(/^[\x20-\x7e]+$/.test(ascii.glyph(name)), true, name);
  }
});

test("genau ein Spinner, der zyklisch läuft", () => {
  const theme = createTheme({ level: 0 });
  const frames = Array.from(theme.glyph("spinner"));
  assert.equal(frames.length, 6);
  assert.equal(spinnerFrame(theme, 0), frames[0]);
  assert.equal(spinnerFrame(theme, frames.length), frames[0]);
  assert.equal(spinnerFrame(theme, -1), frames[frames.length - 1]);
});

test("Terrain-Glyphen: Unicode- und ASCII-Variante belegen gleich viele Zellen", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  const names = [
    "toolHead",
    "blockFoot",
    "userGutter",
    "marker",
    "assistantGutter",
    "interject",
    "boxTopLeft",
    "boxTopRight",
    "boxBottomLeft",
    "boxBottomRight",
    "boxH",
    "boxV",
    // F6 width-parity ruling: the ascii ellipsis is a single "." (it used
    // to be the three-char "...", which failed exactly this assertion).
    "ellipsis",
    // FIX-14 ticket 8: the live/not-live marker pair the plain list rows
    // use. Both must occupy one cell, and they must differ from each other
    // in BOTH charsets — a row column where the two shapes coincide would
    // leave "which one is live" to colour alone.
    "bullet",
    "bulletOff",
  ] as const;
  for (const name of names) {
    assert.equal(
      displayWidth(unicode.glyph(name)),
      displayWidth(ascii.glyph(name)),
      `${name}: Unicode- und ASCII-Breite müssen übereinstimmen`,
    );
  }
  for (const theme of [unicode, ascii]) {
    assert.notEqual(
      theme.glyph("bullet"),
      theme.glyph("bulletOff"),
      "the live and not-live markers must differ by shape, not only by colour",
    );
  }
});

test("box glyphs are single-cell in both charsets and pair the ASCII shape from the design contract", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  const pairs: Record<string, string> = {
    boxTopLeft: "/",
    boxTopRight: "\\",
    boxBottomLeft: "\\",
    boxBottomRight: "/",
    boxH: "-",
    boxV: "|",
  };
  for (const [name, expectedAscii] of Object.entries(pairs)) {
    const glyphName = name as Parameters<typeof unicode.glyph>[0];
    assert.equal(ascii.glyph(glyphName), expectedAscii);
    assert.equal(displayWidth(unicode.glyph(glyphName)), 1, `${name} unicode must be one cell`);
    assert.equal(displayWidth(ascii.glyph(glyphName)), 1, `${name} ascii must be one cell`);
  }
});

test("Spinner-Frames sind je eine Zelle breit, in beiden Sätzen", () => {
  const unicode = createTheme({ level: 0 });
  const ascii = createTheme({ level: 0, ascii: true });
  for (const theme of [unicode, ascii]) {
    for (const frame of Array.from(theme.glyph("spinner"))) {
      assert.equal(displayWidth(frame), 1, `Spinnerframe ${JSON.stringify(frame)} muss eine Zelle breit sein`);
    }
  }
});

/**
 * V3 audit principle 3 tripwire (F5): `src/ui/theme.ts`'s own header claims
 * it is the ONLY module allowed to import `chalk` — before F5 this was
 * false (commands.ts, approval.ts, agent.ts, cli.ts all bypassed it). Grep
 * every tracked source file except theme.ts itself for `from "chalk"` (also
 * catches `import type {...} from "chalk"` — a type-only bypass counts too,
 * per ruling 6) or `require("chalk")`, structural-guard style (see
 * cli.test.ts's embedded-NUL-byte test for the same `git ls-files` pattern).
 */
test("no file under src/ except src/ui/theme.ts imports chalk (V3 audit principle 3 tripwire)", () => {
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", "src"],
    { cwd: REPOSITORY_ROOT },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => /\.(ts|tsx|mts|cts)$/.test(path))
    .filter((path) => path !== "src/ui/theme.ts");
  assert.ok(tracked.length > 50, "sanity: the tracked src/ TypeScript set must not be empty");

  const CHALK_IMPORT = /(?:from\s+["']chalk["']|require\(\s*["']chalk["']\s*\))/;
  const violations: string[] = [];
  for (const relativePath of tracked) {
    const source = readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
    if (CHALK_IMPORT.test(source)) {
      violations.push(relativePath);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `chalk imported outside src/ui/theme.ts: ${violations.join(", ")}`,
  );
});

/**
 * Ruling 4 (behavior parity): every migrated call site in commands.ts,
 * approval.ts, agent.ts, and cli.ts resolves its `Theme` through
 * `createTheme()` with no explicit `level` — exactly like the pre-existing
 * `printPanelResult` neighborhood always did — so they all inherit whatever
 * `createTheme` autodetects. `createTheme`'s own doc says this defers
 * entirely to chalk's own `NO_COLOR`/`FORCE_COLOR`/TTY detection (`new
 * Chalk()`), so there is deliberately no second sniffer anywhere in the
 * project. That autodetection is cached per-process the moment any `Chalk`
 * instance is constructed (verified empirically: changing
 * `process.env.FORCE_COLOR` after an initial `new Chalk()` call does not
 * change a later one's `.level` in the same process) — so the only reliable
 * way to prove real env-driven parity is a fresh child process per case,
 * exactly like `cli-entrypoint.test.ts`'s installer-import test spawns one
 * for its own isolation needs.
 */
test("createTheme()'s autodetected level matches chalk's own NO_COLOR/FORCE_COLOR behavior (ruling 4 parity, shared by every migrated call site)", async () => {
  const themeModuleUrl = pathToFileURL(join(REPOSITORY_ROOT, "src", "ui", "theme.ts")).href;
  const script = `import(${JSON.stringify(themeModuleUrl)}).then(({ createTheme }) => {
    const theme = createTheme();
    process.stdout.write(theme.color("ok")("X"));
  });`;

  // A merely-empty FORCE_COLOR still counts as "set" to chalk (Node even
  // warns "'NO_COLOR' env is ignored due to 'FORCE_COLOR' env being set") —
  // the two envs must be genuinely absent, not present-but-empty, or this
  // test would silently prove nothing.
  const withoutColorEnv: NodeJS.ProcessEnv = { ...process.env };
  delete withoutColorEnv.FORCE_COLOR;
  delete withoutColorEnv.NO_COLOR;

  const forced = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--eval", script],
    { env: { ...withoutColorEnv, FORCE_COLOR: "1" } },
  );
  const esc = String.fromCharCode(27);
  assert.equal(forced.stdout, `${esc}[32mX${esc}[39m`, "FORCE_COLOR=1 must still colour a no-explicit-level theme");

  const plain = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--eval", script],
    { env: { ...withoutColorEnv, NO_COLOR: "1" } },
  );
  assert.equal(plain.stdout, "X", "NO_COLOR=1 must degrade a no-explicit-level theme to plain text — content identical, no ANSI");
});

/**
 * FIX-21 finding 1, the real-PTY proof the test above cannot give.
 *
 * `execFile` hands the child a PIPE, and chalk's `supports-color` returns 0
 * for any non-TTY stream before it looks at a single environment variable —
 * so the `NO_COLOR` assertion above passed for the wrong reason and would
 * have kept passing through the entire defect. The audit's finding was that
 * a real terminal tells a different story, and it does: on a real PTY with
 * `TERM=xterm-256color`, `new Chalk().level` is 2 whether or not `NO_COLOR`
 * is set, because chalk 5 never reads `NO_COLOR` at all (see
 * `detectColorLevel`, `src/ui/theme.ts`).
 *
 * The controller below is the same `os.openpty()` + `select` pattern
 * `scripts/check-pty.mjs` already uses for the release smoke — one Python
 * dependency, already required by `npm run test:pty`, and skipped on Windows
 * exactly like that smoke skips itself.
 */
const PTY_LEVEL_CONTROLLER = String.raw`
import json, os, select, subprocess, sys, time

config = json.loads(sys.argv[1])
master, slave = os.openpty()
environment = os.environ.copy()
environment.pop("FORCE_COLOR", None)
environment.pop("NO_COLOR", None)
environment["TERM"] = "xterm-256color"
environment.update(config["env"])
process = subprocess.Popen(
    config["argv"],
    cwd=config["cwd"],
    env=environment,
    stdin=slave,
    stdout=slave,
    stderr=subprocess.DEVNULL,
    close_fds=True,
)
os.close(slave)
captured = bytearray()
deadline = time.monotonic() + (config["timeoutMs"] / 1000.0)
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 8192)
        except OSError:
            break
        if not chunk:
            break
        captured.extend(chunk)
        if b"PTY_THEME_DONE" in captured:
            break
    elif process.poll() is not None:
        break
process.wait(timeout=5)
sys.stdout.write(json.dumps({"output": captured.decode("utf-8", "replace")}))
`;

interface PtyPaintResult {
  readonly output: string;
}

function paintOverRealPty(env: Record<string, string>): PtyPaintResult {
  const themeModuleUrl = pathToFileURL(join(REPOSITORY_ROOT, "src", "ui", "theme.ts")).href;
  // `stdout.isTTY` is true inside the PTY, so this is the exact detection a
  // real `orcode` session performs. `ok` is painted because it is the one
  // role with a foreground code at every level (`text` never has one).
  const script = `import(${JSON.stringify(themeModuleUrl)}).then(({ createTheme }) => {
    const theme = createTheme();
    process.stdout.write("LEVEL:" + theme.level + ":" + theme.color("ok")("X") + ":PTY_THEME_DONE\\n");
  });`;
  const raw = execFileSync(
    "python3",
    [
      "-c",
      PTY_LEVEL_CONTROLLER,
      JSON.stringify({
        argv: [process.execPath, "--import", "tsx", "--eval", script],
        cwd: REPOSITORY_ROOT,
        env,
        timeoutMs: 60_000,
      }),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(raw) as PtyPaintResult;
}

test(
  "real PTY: NO_COLOR=1 forces colour level 0 and emits zero SGR bytes (FIX-21 finding 1)",
  { skip: process.platform === "win32" ? "POSIX PTY only" : false },
  () => {
    const esc = String.fromCharCode(27);

    // Control case: the very same PTY, same TERM, no NO_COLOR — proves the
    // terminal really does offer colour, so the assertion below cannot pass
    // just because the harness failed to produce a colour-capable stream.
    const colored = paintOverRealPty({});
    assert.match(
      colored.output,
      /LEVEL:[23]:/,
      `a real 256-colour PTY must autodetect level 2 or 3, got ${JSON.stringify(colored.output)}`,
    );
    assert.equal(
      colored.output.includes(esc),
      true,
      "control case must actually emit SGR, or the NO_COLOR assertion proves nothing",
    );

    const plain = paintOverRealPty({ NO_COLOR: "1" });
    assert.match(
      plain.output,
      /LEVEL:0:/,
      `NO_COLOR=1 must resolve level 0 on a real PTY, got ${JSON.stringify(plain.output)}`,
    );
    // The iron rule, stated as bytes: not "fewer" escapes, none.
    assert.equal(
      plain.output.includes(esc),
      false,
      `NO_COLOR=1 must emit zero SGR bytes, got ${JSON.stringify(plain.output)}`,
    );
    assert.equal(plain.output.includes("LEVEL:0:X:PTY_THEME_DONE"), true, "content must be identical, only the colour gone");

    // Precedence, on the same real PTY: FORCE_COLOR still wins, exactly as
    // Node's own warning ("'NO_COLOR' env is ignored due to 'FORCE_COLOR'
    // env being set") describes — NO_COLOR must not become a second,
    // stronger sniffer that overrides an explicit opt-in.
    // (`FORCE_COLOR=3` asks for "at least colour"; chalk still lets the
    // terminal's own `TERM` cap the ceiling, so the pin is "not 0", not "3".)
    const forced = paintOverRealPty({ FORCE_COLOR: "3", NO_COLOR: "1" });
    assert.match(forced.output, /LEVEL:[123]:/, "FORCE_COLOR must still win over NO_COLOR");
    assert.equal(forced.output.includes(esc), true, "FORCE_COLOR=3 must still paint");
  },
);
