import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

const EXPECTED_INPUT = "Erste Zeile\nZweite Zeile";

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
  pasteReadySeen: boolean;
  resultBeforeEnter: boolean;
  timedOut: boolean;
  resumedSeen: boolean;
  settingsSeen: boolean;
  providerCalls: number;
  configMode: number;
  configRaw: string;
}

interface PtyCheckModule {
  runPtySmoke(options?: {
    accessFile?(path: string): Promise<void>;
    log?(message: string): void;
    platform?: NodeJS.Platform;
    projectRoot?: string;
    pythonExecutable?: string;
    runController?(request: PtyControllerRequest): Promise<PtyControllerResult>;
  }): Promise<{
    columns: number;
    input: string;
    rows: number;
    stdinTTY: boolean;
    stdoutTTY: boolean;
  }>;
}

async function loadPtyCheck(): Promise<PtyCheckModule> {
  const modulePath = "../scripts/check-pty.mjs";
  return import(modulePath) as Promise<PtyCheckModule>;
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
    "    /--------\\         *\r\n<>-+*o",
    "\u001b[?2004l\u001b[?25h\u001b[?1049l",
    "\u001b[?1049h\u001b[?2004h",
    "ORCODE · Einstellungen\r\n",
    "Enter sendet alles gemeinsam",
    "\u001b[?2004l\u001b[?25h\u001b[?1049l",
    `\r\nORCODE_PTY_RESULT:${result}\r\n`,
  ].join("");
  return {
    aliveBeforeEnter: true,
    exitCode: 0,
    outputBase64: Buffer.from(output, "utf8").toString("base64"),
    pasteReadySeen: true,
    resultBeforeEnter: false,
    timedOut: false,
    resumedSeen: true,
    settingsSeen: true,
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
    input: EXPECTED_INPUT,
    rows: 28,
    stdinTTY: true,
    stdoutTTY: true,
  });
  assert.match(logged.join("\n"), /echtes POSIX-PTY/i);
  assert.doesNotMatch(
    Buffer.from(successfulControllerResult().outputBase64, "base64").toString("utf8"),
    /ORCODE_PTY_RESUMED/,
  );
});

test("the PTY contract rejects submission before the separate Enter", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  await assert.rejects(
    runPtySmoke({
      platform: "linux",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => successfulControllerResult({ resultBeforeEnter: true }),
      log: () => {},
    }),
    /vor dem separaten Enter/i,
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
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({
        ...controller,
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
      }),
      log: () => {},
    }),
    /Suspend-resume Terminal-Cycle.*Bracketed Paste.*Alternate Screen/i,
  );
});

test("the PTY contract rejects mouse reporting and requires a suspend-resume checkpoint", async () => {
  const { runPtySmoke } = await loadPtyCheck();
  await assert.rejects(
    runPtySmoke({
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
      platform: "darwin",
      projectRoot: "/virtual/orcode",
      accessFile: async () => {},
      runController: async () => ({ ...withMouse, outputBase64: Buffer.from(output).toString("base64") }),
      log: () => {},
    }),
    /mouse reporting/i,
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
    /Windows.*nicht unterstützt.*ConPTY.*nicht geprüft/i,
  );
  assert.equal(ran, false);
});
