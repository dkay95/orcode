/**
 * The `/ssh` slash command (src/commands.ts): listing, connecting, status,
 * and disconnecting — through `handleSlashCommand`, exactly as the TUI/CLI
 * call it. `sshConfigPath`/`sshRunner` are `CommandContext`'s test-only
 * seams (mirroring the existing `configPath`) so this never reads the real
 * `~/.ssh/config` or spawns a real `ssh`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import {
  createPlainCommandOutput,
  handleSlashCommand,
  type CommandContext,
  type CommandOutput,
} from "../src/commands.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import { RuleStore } from "../src/rules.js";
import type { RunSsh } from "../src/ssh.js";
import { buildDashboardFrame, type DashboardState } from "../src/ui/dashboard-frame.js";
import { plainText } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import type { ProcessResult } from "../src/workspace.js";

function collectOutput(): { out: CommandOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: {
      text(value: string): void {
        lines.push(value);
      },
      error(value: string, hint?: string): void {
        lines.push(hint ? `${value}\n${hint}` : value);
      },
    },
  };
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
  calls: string[][];
}

function recordingRunner(result: ProcessResult): RecordingRunner {
  const calls: string[][] = [];
  const runSsh: RunSsh = async (args) => {
    calls.push(args);
    return result;
  };
  return { runSsh, calls };
}

interface Harness {
  context: CommandContext;
  lines: string[];
  appHome: string;
}

/**
 * `/ssh` only ever touches `out`, `sshSession`, `sshConfigPath` and
 * `sshRunner` on the context — the rest is never exercised by this command,
 * so it is stubbed rather than standing up a full agent/session/OpenRouter
 * stack that would add nothing to what these tests check.
 */
async function harness(options: { configPath?: string; runSsh?: RunSsh } = {}): Promise<Harness> {
  const appHome = await mkdtemp(join(tmpdir(), "routercode-ssh-slash-"));
  const ruleStore = await RuleStore.load(appHome);
  const { out, lines } = collectOutput();
  const credentials: CredentialStoreLike = {
    location: "Test-Speicher",
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
  };
  const context = {
    config: {} as CommandContext["config"],
    approvals: new ApprovalManager("allow-all"),
    openRouter: {} as CommandContext["openRouter"],
    session: {} as CommandContext["session"],
    agent: {} as CommandContext["agent"],
    workspace: appHome,
    credentials,
    out,
    ruleStore,
    configPath: join(appHome, "config.json"),
    // MUST always be set: checkHost/closeSshControl create the ControlMaster
    // socket directory as a side effect even with a fake runner — without
    // this override that write lands in the real ~/.routercode.
    sshAppHome: join(appHome, "routercode-ssh"),
    ...(options.configPath ? { sshConfigPath: options.configPath } : {}),
    ...(options.runSsh ? { sshRunner: options.runSsh } : {}),
  } as CommandContext;
  return { context, lines, appHome };
}

async function writeSshConfig(dir: string, content: string): Promise<string> {
  const path = join(dir, "ssh-config");
  await writeFile(path, content);
  return path;
}

test("/ssh with no config file reports no hosts, not an error", async () => {
  const { context, lines, appHome } = await harness();
  try {
    context.sshConfigPath = join(appHome, "missing-ssh-config");
    const outcome = await handleSlashCommand("/ssh", context);
    assert.equal(outcome, "continue");
    assert.ok(lines.some((line) => /No named hosts/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh lists hosts from the injected config path and marks the active one", async () => {
  const { context, lines, appHome } = await harness();
  try {
    const configPath = await writeSshConfig(
      appHome,
      "Host vps\n  HostName 203.0.113.5\n  User deploy\n\nHost produktion\n  HostName 198.51.100.9\n",
    );
    context.sshConfigPath = configPath;
    context.sshSession = { active: "produktion" };
    await handleSlashCommand("/ssh", context);
    const listing = lines.join("\n");
    assert.match(listing, /vps → 203\.0\.113\.5 \(deploy\)/);
    assert.match(listing, /produktion.*\(active\).*198\.51\.100\.9/s);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh <alias> on a reachable host remembers it as the ssh_command target", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    await handleSlashCommand("/ssh vps", context);
    assert.equal(context.sshSession?.active, "vps");
    assert.ok(lines.some((line) => /reachable/.test(line)));
    assert.ok(lines.some((line) => /SSH target set: vps/.test(line)));
    assert.ok(runner.calls[0]?.includes("BatchMode=yes"));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh <alias> creates its ControlMaster socket directory under the injected sshAppHome, never the real ~/.routercode (regression: checkHost's appHome default was previously never overridden here)", async () => {
  const runner = recordingRunner(okResult());
  const { context, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    await handleSlashCommand("/ssh vps", context);
    const socketDir = join(context.sshAppHome!, "ssh");
    const info = await stat(socketDir);
    assert.ok(info.isDirectory());
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh <alias> without key auth does NOT set the target, and names ssh-copy-id", async () => {
  const runner = recordingRunner(okResult({ code: 255, stderr: "Permission denied (publickey)." }));
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    await handleSlashCommand("/ssh vps", context);
    assert.equal(context.sshSession?.active ?? null, null);
    assert.ok(lines.some((line) => /ssh-copy-id vps/.test(line)));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh <unknown-alias> reports unknown host and does not spawn ssh", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    await handleSlashCommand("/ssh ghost", context);
    assert.ok(lines.some((line) => /not a known host/.test(line)));
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh status without an active target says so instead of probing anything, and names the one next action (D5 invitation grammar)", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    await handleSlashCommand("/ssh status", context);
    assert.ok(lines.some((line) => /No active SSH target .* \/ssh <alias> connects one\.$/.test(line)));
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh status with an active target re-checks it", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    context.sshSession = { active: "vps" };
    await handleSlashCommand("/ssh status", context);
    assert.ok(lines.some((line) => /Active SSH target: vps/.test(line)));
    assert.equal(runner.calls.length, 1);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh off tears the control connection down and clears the remembered target", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshSession = { active: "vps" };
    await handleSlashCommand("/ssh off", context);
    assert.equal(context.sshSession.active, null);
    assert.ok(lines.some((line) => /disconnected/.test(line)));
    assert.ok(runner.calls[0]?.includes("-O"));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh off disables the shared target before awaiting close and never erases a newer selection", async () => {
  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => { markCloseStarted = resolve; });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const runSsh: RunSsh = async () => {
    markCloseStarted();
    await closeGate;
    return okResult();
  };
  const { context, appHome } = await harness({ runSsh });
  context.sshSession = { active: "vps" };
  const pending = handleSlashCommand("/ssh off", context);
  try {
    await closeStarted;
    assert.equal(context.sshSession.active, null, "active stayed stale while close was pending");
    context.sshSession.active = "produktion";
    releaseClose();
    await pending;
    assert.equal(context.sshSession.active, "produktion");
  } finally {
    releaseClose();
    await pending.catch(() => undefined);
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh off reports a real close failure after disabling the shared target", async () => {
  const runSsh: RunSsh = async () => {
    throw new Error("spawn ssh ENOENT: no such file or directory");
  };
  const { context, lines, appHome } = await harness({ runSsh });
  try {
    context.sshSession = { active: "vps" };
    await handleSlashCommand("/ssh off", context);
    assert.equal(context.sshSession.active, null);
    assert.match(lines.join("\n"), /disabled.*spawn ssh ENOENT/is);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh off with nothing active says so and does not touch ssh", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    await handleSlashCommand("/ssh off", context);
    assert.ok(lines.some((line) => /No active SSH session/.test(line)));
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh appears in the plain command output helper without throwing (smoke test)", async () => {
  // Sanity check that createPlainCommandOutput itself is still wired the
  // same way other commands expect — not SSH-specific, just cheap insurance.
  const out = createPlainCommandOutput();
  assert.equal(typeof out.text, "function");
});

// --- Phase 3b, Part D.3: the host listing adopts the standard numbered-list
// look (zero behavior change — still selected by alias, never by number). ---

test("/ssh with no active target lists every host numbered, in file order", async () => {
  const { context, lines, appHome } = await harness();
  try {
    context.sshConfigPath = await writeSshConfig(
      appHome,
      "Host vps\n  HostName 203.0.113.5\n\nHost produktion\n  HostName 198.51.100.9\n",
    );
    await handleSlashCommand("/ssh", context);
    const listing = lines.join("\n");
    assert.match(listing, /1\. vps → 203\.0\.113\.5/);
    assert.match(listing, /2\. produktion → 198\.51\.100\.9/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

// --- Phase 3b, Part D.1: the status line's muted `ssh:<host>` segment
// (Terminal-Look spec principles 5/9 — fix round 1, Critical 3 replaced the
// original "SSH: HOST" danger/bold format with this; see
// tests/ui-ssh-header.test.ts and task-3b-report.md's fix-round section)
// tracks `context.sshSession.active` end to end: this is the exact glue
// expression src/cli.ts's dashboard `getState()` closure evaluates on every
// frame. ---

function stateWithSshHost(sshHost: string | undefined): DashboardState {
  return {
    workspace: "/home/user/projekt",
    model: "vendor/model",
    approval: "ask",
    reasoning: "auto",
    maxCost: "$1.00",
    maxSteps: 10,
    sshHost,
  };
}

test("the status line's SSH segment appears exactly while /ssh has a remembered target and disappears on /ssh off", async () => {
  const runner = recordingRunner(okResult());
  const { context, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    context.sshConfigPath = await writeSshConfig(appHome, "Host vps\n  HostName 203.0.113.5\n");
    const theme = createTheme({ level: 0 });

    const before = buildDashboardFrame({
      width: 100,
      height: 24,
      theme,
      // cli.ts's exact expression: `context.sshSession.active ?? undefined`.
      state: stateWithSshHost(context.sshSession?.active ?? undefined),
      blocks: [],
      mode: "input",
      input: "",
      cursor: 0,
      status: "",
    });
    assert.doesNotMatch(plainText(before.lines[before.lines.length - 2]!), /ssh:/);

    await handleSlashCommand("/ssh vps", context);
    assert.equal(context.sshSession?.active, "vps");
    const during = buildDashboardFrame({
      width: 100,
      height: 24,
      theme,
      state: stateWithSshHost(context.sshSession?.active ?? undefined),
      blocks: [],
      mode: "input",
      input: "",
      cursor: 0,
      status: "",
    });
    // Fix round 1, Critical 3 (controller ruling: the spec wins) — the
    // muted, lowercase `ssh:<host>` segment (Terminal-Look spec principles
    // 5/9), not the earlier danger/bold "SSH: HOST" alert. Controller
    // decision B (composition phase) then moved it off the header entirely,
    // onto the always-on bottom status line alongside approval/model/branch.
    assert.match(plainText(during.lines[during.lines.length - 2]!), /ssh:vps/);

    await handleSlashCommand("/ssh off", context);
    assert.equal(context.sshSession?.active, null);
    const after = buildDashboardFrame({
      width: 100,
      height: 24,
      theme,
      state: stateWithSshHost(context.sshSession?.active ?? undefined),
      blocks: [],
      mode: "input",
      input: "",
      cursor: 0,
      status: "",
    });
    assert.doesNotMatch(plainText(after.lines[after.lines.length - 2]!), /ssh:/);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
