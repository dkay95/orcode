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
    assert.ok(lines.some((line) => /Keine benannten Hosts/.test(line)));
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
    assert.match(listing, /produktion.*\(aktiv\).*198\.51\.100\.9/s);
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
    assert.ok(lines.some((line) => /erreichbar/.test(line)));
    assert.ok(lines.some((line) => /SSH-Ziel gesetzt: vps/.test(line)));
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
    assert.ok(lines.some((line) => /kein bekannter Host/.test(line)));
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh status without an active target says so instead of probing anything", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    await handleSlashCommand("/ssh status", context);
    assert.ok(lines.some((line) => /Kein aktives SSH-Ziel/.test(line)));
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
    assert.ok(lines.some((line) => /Aktives SSH-Ziel: vps/.test(line)));
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
    assert.ok(lines.some((line) => /getrennt/.test(line)));
    assert.ok(runner.calls[0]?.includes("-O"));
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("/ssh off with nothing active says so and does not touch ssh", async () => {
  const runner = recordingRunner(okResult());
  const { context, lines, appHome } = await harness({ runSsh: runner.runSsh });
  try {
    await handleSlashCommand("/ssh off", context);
    assert.ok(lines.some((line) => /Keine aktive SSH-Sitzung/.test(line)));
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
