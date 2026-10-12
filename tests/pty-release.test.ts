import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const EXPECTED_DRAFT_LINES = ["Erste Zeile", "Zweite Zeile"] as const;

interface PtyControllerRequest {
  columns: number;
  harnessPath: string;
  maxOutputBytes: number;
  nodeExecutable: string;
  projectRoot: string;
  pythonExecutable: string;
  rows: number;
  cliModuleUrl: string;
  timeoutMs: number;
  tuiModuleUrl: string;
}

interface PtyControllerResult {
  aliveBeforeEnter: boolean;
  exitCode: number;
  outputBase64: string;
  resultBeforeEnter: boolean;
  timedOut: boolean;
  resumedSeen: boolean;
  providerCalls: number;
  configMode: number;
  configRaw: string;
}

interface PtyCheckModule {
  runPtySmoke(options?: {
    accessFile?(path: string): Promise<void>;
    assertBuildIsFresh?(root: string): Promise<void>;
    log?(message: string): void;
    platform?: NodeJS.Platform;
    projectRoot?: string;
    pythonExecutable?: string;
    runController?(request: PtyControllerRequest): Promise<PtyControllerResult>;
  }): Promise<{
    columns: number;
    draftRestored: boolean;
    rows: number;
    stdinTTY: boolean;
    stdoutTTY: boolean;
  }>;
  assertBuildIsFresh(
    root: string,
    io?: {
      statFile?(path: string): Promise<{ mtimeMs: number }>;
      readdirEntries?(path: string, options: { withFileTypes: true }): Promise<
        readonly { name: string; isDirectory(): boolean; isFile(): boolean }[]
      >;
    },
  ): Promise<void>;
}

interface ProviderSetupCliPtyCheckModule {
  runProviderSetupCliPtyCheck(options?: {
    accessFile?(path: string): Promise<void>;
    assertBuildIsFresh?(root: string): Promise<void>;
    log?(message: string): void;
    platform?: NodeJS.Platform;
    projectRoot?: string;
    runScenario?(input: { projectRoot: string; moduleRoot: string }): Promise<unknown>;
  }): Promise<unknown>;
}

/** Every existing behavioral test below predates the freshness guard and
 * uses a fake `/virtual/orcode` root with no real `src/`/`dist/` on disk —
 * stub the guard out so it never runs a real filesystem walk against them. */
const NO_FRESHNESS_CHECK = { assertBuildIsFresh: async () => {} };

async function loadPtyCheck(): Promise<PtyCheckModule> {
  const modulePath = "../scripts/check-pty.mjs";
  return import(modulePath) as Promise<PtyCheckModule>;
}

async function loadProviderSetupCliPtyCheck(): Promise<ProviderSetupCliPtyCheckModule> {
  const modulePath = "../scripts/check-provider-setup-cli-pty.mjs";
  return import(modulePath) as Promise<ProviderSetupCliPtyCheckModule>;
}

function successfulControllerResult(overrides: Partial<PtyControllerResult> = {}): PtyControllerResult {
  const ready = JSON.stringify({
    stdinTTY: true,
    stdoutTTY: true,
    columns: 100,
    rows: 28,
  });
  const result = JSON.stringify({
    agentCalls: 0,
    sessionTurns: 0,
    providerCalls: 0,
    configMode: 0o600,
    configRaw: '{"appearance":{"showHeaderMark":false}}',
  });
  const output = [
    `ORCODE_PTY_READY:${ready}\r\n`,
    "\u001b[?1049h\u001b[?2004h",
    "     >    ---------*\r\n>-*",
    "\u001b[?2004l\u001b[?25h\u001b[?1049l",
    "\u001b[?1049h\u001b[?2004h",
    // F6 PTY evidence: the real settings-frame title now respects
    // glyphMode: ascii for the first time (previously hardcoded unicode
    // regardless of theme) — this fixture's synthetic byte stream must
    // match what validateControllerResult actually searches for now.
    //
    // V4-B moved that landmark twice over, and this line had gone stale on
    // both moves: the "ORCODE - Settings" header became the zone crumb title
    // bar, and the crumb in turn cannot serve as the mark at all because the
    // row editor's own crumb ("Settings > Appearance > Large ORCODE logo")
    // contains the category's. What the check anchors on now — here and over
    // the real PTY — is the category CHIP row, painted only at category
    // level, with "*" on the active chip under ASCII glyph mode.
    "o1 Models  o2 Accounts  o3 Approvals & Costs  o4 Tools  *5 Appearance\r\n",
    `${EXPECTED_DRAFT_LINES.join("\r\n")}\r\nfixture.png\r\n`,
    "Enter sends everything together",
    "\u001b[?2004l\u001b[?25h\u001b[?1049l",
    `\r\nORCODE_PTY_RESULT:${result}\r\n`,
  ].join("");
  return {
    aliveBeforeEnter: true,
    exitCode: 0,
    outputBase64: Buffer.from(output, "utf8").toString("base64"),
    resultBeforeEnter: false,
    timedOut: false,
    resumedSeen: true,
    providerCalls: 0,
    configMode: 0o600,
    configRaw: '{"appearance":{"showHeaderMark":false}}',
    ...overrides,
  };
}

test("the POSIX PTY smoke uses deterministic geometry and validates a later Enter", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  const accessed: string[] = [];
  const logged: string[] = [];
  let request: PtyControllerRequest | undefined;
  const projectRoot = "/virtual/orcode";

  const result = await runPtySmoke({
    ...NO_FRESHNESS_CHECK,
    platform: "darwin",
    projectRoot,
    pythonExecutable: "/usr/bin/python3",
    accessFile: async (path) => {
      accessed.push(path);
    },
    runController: async (value) => {
      request = value;
      return successfulControllerResult();
    },
    log: (message) => {
      logged.push(message);
    },
  });

  assert.deepEqual(accessed, [
    join(projectRoot, "dist", "cli.js"),
    join(projectRoot, "dist", "tui.js"),
    join(projectRoot, "tests", "fixtures", "pty-harness.mjs"),
  ]);
  assert.equal(request?.columns, 100);
  assert.equal(request?.rows, 28);
  assert.equal(request?.pythonExecutable, "/usr/bin/python3");
  assert.equal(request?.maxOutputBytes, 256 * 1024);
  assert.match(request?.cliModuleUrl ?? "", /dist\/cli\.js$/);
  assert.ok((request?.timeoutMs ?? 0) > 0);
  assert.deepEqual(result, {
    columns: 100,
    draftRestored: true,
    rows: 28,
    stdinTTY: true,
    stdoutTTY: true,
  });
  assert.match(logged.join("\n"), /real POSIX PTY/i);
  assert.doesNotMatch(
    Buffer.from(successfulControllerResult().outputBase64, "base64").toString("utf8"),
    /ORCODE_PTY_RESUMED/,
  );
});

test("the PTY contract rejects submission before the separate Enter", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "linux",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => successfulControllerResult({ resultBeforeEnter: true }),
      log: () => {},
    }),
    /before the separate Enter/i,
  );
});

test("the PTY contract requires disable-paste and leave-screen cleanup before exit", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  const controller = successfulControllerResult();
  const raw = Buffer.from(controller.outputBase64, "base64")
    .toString("utf8")
    .replace("\u001b[?2004l\u001b[?25h\u001b[?1049l", "");

  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({
        ...controller,
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
      }),
      log: () => {},
    }),
    /Suspend-resume terminal cycle.*bracketed paste.*alternate screen/i,
  );
});

test("the PTY contract rejects mouse reporting and requires a suspend-resume checkpoint", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => successfulControllerResult({ resumedSeen: false }),
      log: () => {},
    }),
    /suspend-resume/i,
  );
  const withMouse = successfulControllerResult();
  const output = Buffer.from(withMouse.outputBase64, "base64").toString("utf8")
    .replace("ORCODE_PTY_READY:", "\u001b[?1000hORCODE_PTY_READY:");
  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({ ...withMouse, outputBase64: Buffer.from(output).toString("base64") }),
      log: () => {},
    }),
    /mouse reporting/i,
  );
});

test("the PTY contract requires both restored draft lines after Settings closes", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  const controller = successfulControllerResult();
  const output = Buffer.from(controller.outputBase64, "base64")
    .toString("utf8")
    .replace("Zweite Zeile\r\n", "");

  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({ ...controller, outputBase64: Buffer.from(output).toString("base64") }),
      log: () => {},
    }),
    /restored draft line/i,
  );
});

test("the PTY contract requires the restored attachment and ignores asserted restoration booleans", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  const controller = successfulControllerResult();
  const output = Buffer.from(controller.outputBase64, "base64")
    .toString("utf8")
    .replace("fixture.png\r\n", "");

  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({
        ...controller,
        draftRestored: true,
        pasteReadySeen: true,
        settingsSeen: true,
        outputBase64: Buffer.from(output).toString("base64"),
      }),
      log: () => {},
    }),
    /restored attachment/i,
  );
});

test("the PTY contract rejects a fabricated resume marker without a terminal re-entry cycle", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  const controller = successfulControllerResult();
  const output = Buffer.from(controller.outputBase64, "base64")
    .toString("utf8")
    .replace("\u001b[?2004l\u001b[?25h\u001b[?1049l\u001b[?1049h\u001b[?2004h", "ORCODE_PTY_RESUMED");

  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({ ...controller, outputBase64: Buffer.from(output).toString("base64") }),
      log: () => {},
    }),
    /resume.*marker/i,
  );
});

test("Windows is explicitly unsupported and never presented as ConPTY coverage", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  let ran = false;
  await assert.rejects(
    runPtySmoke({
      ...NO_FRESHNESS_CHECK,
      platform: "win32",
      accessFile: async () => {
        ran = true;
      },
      runController: async () => {
        ran = true;
        return successfulControllerResult();
      },
      log: () => {},
    }),
    /not supported on Windows.*ConPTY.*not checked/i,
  );
  assert.equal(ran, false);
});

function fakeFileTree(mtimesByPath: Record<string, number>, dirsByPath: Record<string, string[]>) {
  const statFile = async (path: string) => {
    const mtimeMs = mtimesByPath[path];
    if (mtimeMs === undefined) throw new Error(`no fake stat for ${path}`);
    return { mtimeMs };
  };
  const readdirEntries = async (dir: string) => {
    const names = dirsByPath[dir];
    if (!names) throw new Error(`no fake dir listing for ${dir}`);
    return names.map((name) => ({
      name,
      isDirectory: () => Boolean(dirsByPath[join(dir, name)]),
      isFile: () => !dirsByPath[join(dir, name)],
    }));
  };
  return { statFile, readdirEntries };
}

test("assertBuildIsFresh rejects when a src/ file is newer than the built dist/", async () => {
  const { assertBuildIsFresh } = await loadPtyCheck();
  const root = "/virtual/orcode";
  const src = join(root, "src");
  const nested = join(src, "ui");
  const io = fakeFileTree(
    {
      [join(src, "cli.ts")]: 1_000,
      [join(nested, "tui.ts")]: 5_000, // touched after the last build
      [join(root, "dist", "cli.js")]: 2_000,
      [join(root, "dist", "tui.js")]: 2_000,
    },
    {
      [src]: ["cli.ts", "ui"],
      [nested]: ["tui.ts"],
    },
  );

  await assert.rejects(assertBuildIsFresh(root, io), /dist\/ is stale.*npm run build/i);
});

test("assertBuildIsFresh resolves when dist/ is newer than everything under src/", async () => {
  const { assertBuildIsFresh } = await loadPtyCheck();
  const root = "/virtual/orcode";
  const src = join(root, "src");
  const io = fakeFileTree(
    {
      [join(src, "cli.ts")]: 1_000,
      [join(root, "dist", "cli.js")]: 5_000,
      [join(root, "dist", "tui.js")]: 5_000,
    },
    {
      [src]: ["cli.ts"],
    },
  );

  await assert.doesNotReject(assertBuildIsFresh(root, io));
});

test("runPtySmoke runs the freshness guard before spawning the real PTY controller", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  let controllerCalled = false;

  await assert.rejects(
    runPtySmoke({
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      assertBuildIsFresh: async () => {
        throw new Error("dist/ is stale: src/ has changes newer than the build (run `npm run build`).");
      },
      runController: async () => {
        controllerCalled = true;
        return successfulControllerResult();
      },
      log: () => {},
    }),
    /dist\/ is stale/i,
  );
  assert.equal(controllerCalled, false);
});

test("provider setup CLI PTY gate rejects a missing build before starting its scenario", async () => {
  const { runProviderSetupCliPtyCheck } = await loadProviderSetupCliPtyCheck();
  let freshnessCalled = false;
  let scenarioCalled = false;

  await assert.rejects(
    runProviderSetupCliPtyCheck({
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async (path) => {
        if (path === join("/virtual/orcode", "dist", "cli.js")) throw new Error("ENOENT");
      },
      assertBuildIsFresh: async () => { freshnessCalled = true; },
      runScenario: async () => { scenarioCalled = true; return {}; },
      log: () => {},
    }),
    /Build artifact missing:.*dist.*cli\.js.*npm run build/i,
  );
  assert.equal(freshnessCalled, false);
  assert.equal(scenarioCalled, false);
});

test("provider setup CLI PTY gate rejects a stale build before starting its scenario", async () => {
  const { runProviderSetupCliPtyCheck } = await loadProviderSetupCliPtyCheck();
  let scenarioCalled = false;

  await assert.rejects(
    runProviderSetupCliPtyCheck({
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      assertBuildIsFresh: async () => {
        throw new Error("dist/ is stale: run `npm run build` before `npm run test:pty`.");
      },
      runScenario: async () => { scenarioCalled = true; return {}; },
      log: () => {},
    }),
    /dist\/ is stale.*npm run build/i,
  );
  assert.equal(scenarioCalled, false);
});
