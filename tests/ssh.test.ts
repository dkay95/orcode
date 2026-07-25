import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SshHost } from "../src/ssh-config.js";
import {
  checkHost,
  classifySshFailure,
  closeSshControl,
  createSshSession,
  execSshCommand,
  noAuthMessage,
  SshAuthError,
  sshSocketPath,
  type RunSsh,
} from "../src/ssh.js";
import type { ProcessResult } from "../src/workspace.js";

const VPS: SshHost = { alias: "vps", hostName: "203.0.113.5", user: "deploy" };
const HOSTS: readonly SshHost[] = [VPS];

/**
 * `checkHost`/`execSshCommand`/`closeSshControl` all call `ensureSshSocketDir`,
 * which really does create `<appHome>/ssh` on disk (0700) — so every test
 * that reaches them gets its own throwaway `appHome` under a mkdtemp root,
 * cleaned up afterwards. Never the real `~/.routercode`.
 */
async function tempAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-ssh-test-"));
}

function okResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

interface RecordingRunner {
  runSsh: RunSsh;
  calls: Array<{ args: string[] }>;
}

function recordingRunner(result: ProcessResult): RecordingRunner {
  const calls: Array<{ args: string[] }> = [];
  const runSsh: RunSsh = async (args) => {
    calls.push({ args });
    return result;
  };
  return { runSsh, calls };
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

test("sshSocketPath: stays well under the ~104 byte macOS sun_path limit, even for a very long alias", () => {
  const appHome = join(homedir(), ".routercode");
  const short = sshSocketPath("vps", appHome);
  const long = sshSocketPath("a".repeat(500), appHome);
  assert.ok(
    Buffer.byteLength(short, "utf8") < 104,
    `Socketpfad zu lang: ${short} (${Buffer.byteLength(short, "utf8")} Bytes)`,
  );
  assert.ok(
    Buffer.byteLength(long, "utf8") < 104,
    `Socketpfad zu lang: ${long} (${Buffer.byteLength(long, "utf8")} Bytes)`,
  );
  // The whole point of hashing: length is independent of the alias's length.
  assert.equal(short.length, long.length);
});

test("sshSocketPath: different aliases get different sockets, same alias is stable", () => {
  const appHome = "/tmp/routercode-test-home";
  assert.notEqual(sshSocketPath("vps", appHome), sshSocketPath("produktion", appHome));
  assert.equal(sshSocketPath("vps", appHome), sshSocketPath("vps", appHome));
});

// ---------------------------------------------------------------------------
// checkHost
// ---------------------------------------------------------------------------

test("checkHost: unknown alias never spawns ssh", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult());
    const result = await checkHost("ghost", HOSTS, runner.runSsh, { appHome });
    assert.equal(result.status, "unknown-host");
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("checkHost: exit 0 means reachable with working key auth", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult());
    const result = await checkHost("vps", HOSTS, runner.runSsh, { appHome });
    assert.equal(result.status, "reachable");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("checkHost: every invocation sets BatchMode=yes, so a password prompt cannot hang the run", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult());
    await checkHost("vps", HOSTS, runner.runSsh, { appHome });
    assert.equal(runner.calls.length, 1);
    const args = runner.calls[0]!.args;
    const batchModeIndex = args.indexOf("BatchMode=yes");
    assert.ok(batchModeIndex > 0, `BatchMode=yes fehlt in: ${args.join(" ")}`);
    assert.equal(args[batchModeIndex - 1], "-o");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("checkHost: a missing key surfaces as no-auth with the ssh-copy-id message, not a raw error", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(
      okResult({ code: 255, stderr: "deploy@203.0.113.5: Permission denied (publickey)." }),
    );
    const result = await checkHost("vps", HOSTS, runner.runSsh, { appHome });
    assert.equal(result.status, "no-auth");
    assert.match(result.message, /ssh-copy-id vps/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("checkHost: a network failure surfaces as unreachable", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(
      okResult({ code: 255, stderr: "ssh: connect to host 203.0.113.5 port 22: Connection refused" }),
    );
    const result = await checkHost("vps", HOSTS, runner.runSsh, { appHome });
    assert.equal(result.status, "unreachable");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// execSshCommand
// ---------------------------------------------------------------------------

test("execSshCommand: unknown alias throws before touching ssh at all", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult());
    await assert.rejects(
      execSshCommand("ghost", HOSTS, "uptime", runner.runSsh, { runtime: { appHome } }),
      /kein bekannter Host/,
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("execSshCommand: runs the command and returns stdout/stderr/exit code", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult({ stdout: "up 3 days\n" }));
    const result = await execSshCommand("vps", HOSTS, "uptime", runner.runSsh, { runtime: { appHome } });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "up 3 days\n");
    const args = runner.calls[0]!.args;
    assert.deepEqual(args.slice(-2), ["vps", "uptime"]);
    assert.ok(args.includes("BatchMode=yes"));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("execSshCommand: missing key throws SshAuthError with the ssh-copy-id message and runs nothing else", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult({ code: 255, stderr: "Permission denied (publickey)." }));
    await assert.rejects(
      execSshCommand("vps", HOSTS, "rm -rf /var/log/*", runner.runSsh, { runtime: { appHome } }),
      (error: unknown) => {
        assert.ok(error instanceof SshAuthError);
        assert.match((error as Error).message, /ssh-copy-id vps/);
        return true;
      },
    );
    // Exactly one ssh invocation — no retry, nothing else attempted.
    assert.equal(runner.calls.length, 1);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("execSshCommand: a remote command that merely exits non-zero is returned normally, not thrown", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult({ code: 1, stderr: "no such file" }));
    const result = await execSshCommand("vps", HOSTS, "cat missing", runner.runSsh, { runtime: { appHome } });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "no such file");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// closeSshControl / session / misc
// ---------------------------------------------------------------------------

test("closeSshControl: sends -O exit against the host's own ControlPath", async () => {
  const appHome = await tempAppHome();
  try {
    const runner = recordingRunner(okResult());
    await closeSshControl("vps", runner.runSsh, { appHome });
    assert.equal(runner.calls.length, 1);
    const args = runner.calls[0]!.args;
    assert.ok(args.includes("-O"));
    assert.ok(args.includes("exit"));
    assert.ok(args.includes("vps"));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("closeSshControl: a runner that throws (no live socket) does not propagate", async () => {
  const appHome = await tempAppHome();
  try {
    const runSsh: RunSsh = async () => {
      throw new Error("no such file or directory");
    };
    await assert.doesNotReject(closeSshControl("vps", runSsh, { appHome }));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("createSshSession: starts with no active host", () => {
  assert.equal(createSshSession().active, null);
});

test("classifySshFailure / noAuthMessage stay consistent with checkHost's own classification", () => {
  assert.equal(
    classifySshFailure({ code: 255, stderr: "Permission denied (publickey,password)." }),
    "no-auth",
  );
  assert.equal(classifySshFailure({ code: 255, stderr: "Connection timed out" }), "unreachable");
  assert.match(noAuthMessage("prod"), /ssh-copy-id prod/);
});
