/**
 * The `ssh_command` agent tool (src/workspace.ts) end to end: its own
 * approval risk level, the host baked into the remembered-rule subject, and
 * the no-auth / unknown-host paths. Every `ssh` invocation is injected —
 * these tests never spawn a real `ssh` process or touch `~/.ssh` /
 * `~/.routercode`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import { RuleStore } from "../src/rules.js";
import type { RunSsh, SshSession } from "../src/ssh.js";
import type { SshHost } from "../src/ssh-config.js";
import type { ApprovalMode, ToolCallPreview } from "../src/types.js";
import { ChangeJournal, WorkspaceGuard, createCodingTools } from "../src/workspace.js";
import type { ProcessResult } from "../src/workspace.js";

type ToolBundle = ReturnType<typeof createCodingTools>;

interface RawTool {
  function: {
    name: string;
    inputSchema: { parse: (value: unknown) => unknown };
    execute: (input: never, context: never) => Promise<unknown>;
  };
}

function toolByName(tools: ToolBundle, name: string): RawTool {
  const found = (tools as unknown as RawTool[]).find((entry) => entry.function.name === name);
  if (!found) throw new Error(`Tool ${name} nicht gefunden`);
  return found;
}

async function invoke(
  tools: ToolBundle,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entry = toolByName(tools, name);
  const parsed = entry.function.inputSchema.parse(input);
  const output = await entry.function.execute(parsed as never, {} as never);
  return (output ?? {}) as Record<string, unknown>;
}

const VPS: SshHost = { alias: "vps", hostName: "203.0.113.5", user: "deploy" };
const PROD: SshHost = { alias: "produktion", hostName: "198.51.100.9", user: "root" };
const HOSTS: readonly SshHost[] = [VPS, PROD];

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

interface Sandbox {
  tools: ToolBundle;
  approvals: ApprovalManager;
  asked: ToolCallPreview[];
  cleanup: () => Promise<void>;
}

async function sandbox(options: {
  mode: ApprovalMode;
  answer?: boolean;
  runSsh?: RunSsh;
  ruleStore?: RuleStore;
  workspace?: string;
  onProcessStart?: (operation: { id: string }) => void;
  onProcessEnd?: (
    operation: { id: string },
    completion: { exitCode: number | null; error?: string },
  ) => void;
  session?: SshSession;
}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "routercode-sshtool-"));
  const guard = await WorkspaceGuard.create(root);
  const approvals = new ApprovalManager(options.mode, {
    ...(options.ruleStore ? { ruleStore: options.ruleStore, workspace: options.workspace ?? root } : {}),
  });
  const asked: ToolCallPreview[] = [];
  if (options.answer !== undefined) {
    approvals.setPromptHandler(async (preview) => {
      asked.push(preview);
      return { accepted: options.answer === true };
    });
  }
  const journal = new ChangeJournal({ appHome: join(root, ".routercode"), chatId: "test-chat" });
  const runner = options.runSsh ? { runSsh: options.runSsh, calls: [] } : recordingRunner(okResult());
  const tools = createCodingTools(guard, approvals, journal, {
    ssh: {
      hosts: HOSTS,
      runSsh: runner.runSsh,
      appHome: join(root, ".routercode-ssh"),
      ...(options.session ? { session: options.session } : {}),
    },
    ...(options.onProcessStart ? { onProcessStart: options.onProcessStart } : {}),
    ...(options.onProcessEnd ? { onProcessEnd: options.onProcessEnd } : {}),
  });
  return {
    tools,
    approvals,
    asked,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("ssh_command asks for approval in ask mode", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "ask", answer: true });
  try {
    const output = await invoke(tools, "ssh_command", { host: "vps", command: "uptime" });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.risk, "remote-shell");
    assert.equal(output.exitCode, 0);
  } finally {
    await cleanup();
  }
});

test("ssh_command asks for approval in auto-edit mode too — the case that would be red without remote-shell", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "auto-edit", answer: true });
  try {
    await invoke(tools, "ssh_command", { host: "vps", command: "uptime" });
    assert.equal(asked.length, 1, "auto-edit darf ssh_command nicht wie einen lokalen Edit durchwinken");
  } finally {
    await cleanup();
  }
});

test("ssh_command rejection leaves the approval manager's normal rejection handling intact", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "ask", answer: false });
  try {
    await assert.rejects(invoke(tools, "ssh_command", { host: "vps", command: "uptime" }), /denied/);
    assert.equal(asked.length, 1);
  } finally {
    await cleanup();
  }
});

test("ssh_command allow-all runs without asking", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "allow-all" });
  try {
    const output = await invoke(tools, "ssh_command", { host: "vps", command: "uptime" });
    assert.equal(asked.length, 0);
    assert.equal(output.exitCode, 0);
  } finally {
    await cleanup();
  }
});

test("ssh_command without host resolves the active shared session at execution time", async () => {
  const runner = recordingRunner(okResult({ stdout: "active host\n" }));
  const session: SshSession = { active: null };
  const { tools, cleanup } = await sandbox({
    mode: "allow-all",
    runSsh: runner.runSsh,
    session,
  });
  try {
    session.active = "vps";
    const output = await invoke(tools, "ssh_command", { command: "hostname" });
    assert.equal(output.host, "vps");
    assert.deepEqual(runner.calls[0]?.slice(-2), ["vps", "hostname"]);
  } finally {
    await cleanup();
  }
});

test("ssh_command without host or active session fails clearly before approval or spawn", async () => {
  const runner = recordingRunner(okResult());
  const session: SshSession = { active: null };
  const { tools, asked, cleanup } = await sandbox({
    mode: "ask",
    answer: true,
    runSsh: runner.runSsh,
    session,
  });
  try {
    await assert.rejects(
      invoke(tools, "ssh_command", { command: "hostname" }),
      /No active SSH target.*\/ssh <alias>/,
    );
    assert.equal(asked.length, 0);
    assert.equal(runner.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test("ssh_command rejects an unknown active session before approval or spawn", async () => {
  const runner = recordingRunner(okResult());
  const session: SshSession = { active: "ghost" };
  const { tools, asked, cleanup } = await sandbox({
    mode: "ask",
    answer: true,
    runSsh: runner.runSsh,
    session,
  });
  try {
    await assert.rejects(
      invoke(tools, "ssh_command", { command: "hostname" }),
      /not a known host/,
    );
    assert.equal(asked.length, 0);
    assert.equal(runner.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test("ssh_command explicit host wins over the active shared session", async () => {
  const runner = recordingRunner(okResult());
  const session: SshSession = { active: "vps" };
  const { tools, cleanup } = await sandbox({
    mode: "allow-all",
    runSsh: runner.runSsh,
    session,
  });
  try {
    const output = await invoke(tools, "ssh_command", {
      host: "produktion",
      command: "hostname",
    });
    assert.equal(output.host, "produktion");
    assert.deepEqual(runner.calls[0]?.slice(-2), ["produktion", "hostname"]);
  } finally {
    await cleanup();
  }
});

test("ssh_command preserves a structured launch failure after one null-exit lifecycle", async () => {
  const lifecycle: Array<{ type: "start" | "end"; id: string; exitCode?: number | null; error?: string }> = [];
  const runner = recordingRunner(okResult({
    code: null,
    launchError: "spawn ssh ENOENT",
  }));
  const { tools, cleanup } = await sandbox({
    mode: "allow-all",
    runSsh: runner.runSsh,
    onProcessStart: (operation) => lifecycle.push({ type: "start", id: operation.id }),
    onProcessEnd: (operation, completion) => lifecycle.push({
      type: "end",
      id: operation.id,
      exitCode: completion.exitCode,
      ...(completion.error ? { error: completion.error } : {}),
    }),
  });
  try {
    await assert.rejects(
      invoke(tools, "ssh_command", { host: "vps", command: "uptime" }),
      /spawn ssh ENOENT/,
    );
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(lifecycle.map((event) => event.type), ["start", "end"]);
    assert.equal(new Set(lifecycle.map((event) => event.id)).size, 1);
    assert.equal(lifecycle[1]?.exitCode, null);
    assert.match(lifecycle[1]?.error ?? "", /spawn ssh ENOENT/);
  } finally {
    await cleanup();
  }
});

test("ssh_command's approval preview names the target host prominently", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "ask", answer: true });
  try {
    await invoke(tools, "ssh_command", { host: "vps", command: "systemctl restart nginx" });
    const preview = asked[0]!;
    assert.match(preview.summary, /VPS/);
    assert.match(preview.summary, /203\.0\.113\.5/);
    assert.match(preview.details ?? "", /SSH TARGET \(NOT LOCAL\): VPS/);
    assert.equal(preview.rememberAvailable, true);
    assert.equal(
      preview.subject,
      '{"kind":"ssh-command","host":"vps","command":"systemctl restart nginx"}',
    );
  } finally {
    await cleanup();
  }
});

test("ssh_command rejects an alias that is not in the ssh config, before ever asking for approval", async () => {
  const { tools, asked, cleanup } = await sandbox({ mode: "ask", answer: true });
  try {
    await assert.rejects(
      invoke(tools, "ssh_command", { host: "ghost", command: "uptime" }),
      /not a known host/,
    );
    assert.equal(asked.length, 0, "ein unbekannter Host darf keine Freigabe-Anfrage auslösen");
  } finally {
    await cleanup();
  }
});

test("ssh_command surfaces the ssh-copy-id message on missing key auth and runs nothing else", async () => {
  const runner = recordingRunner(okResult({ code: 255, stderr: "Permission denied (publickey)." }));
  const { tools, cleanup } = await sandbox({ mode: "allow-all", runSsh: runner.runSsh });
  try {
    await assert.rejects(
      invoke(tools, "ssh_command", { host: "vps", command: "rm -rf /var/log/*" }),
      /ssh-copy-id vps/,
    );
    assert.equal(runner.calls.length, 1, "genau ein ssh-Versuch, kein Retry");
  } finally {
    await cleanup();
  }
});

test("ssh_command passes BatchMode=yes so a stuck password prompt cannot hang the run", async () => {
  const runner = recordingRunner(okResult());
  const { tools, cleanup } = await sandbox({ mode: "allow-all", runSsh: runner.runSsh });
  try {
    await invoke(tools, "ssh_command", { host: "vps", command: "uptime" });
    assert.ok(runner.calls[0]?.includes("BatchMode=yes"));
    assert.deepEqual(runner.calls[0]?.slice(-2), ["vps", "uptime"]);
  } finally {
    await cleanup();
  }
});

test("a remembered ssh_command rule for one host does not leak to another, through the real tool", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "routercode-sshtool-rules-"));
  try {
    const ruleStore = await RuleStore.load(appHome);
    const workspace = "/ws-ssh";
    const bundle = await sandbox({ mode: "ask", ruleStore, workspace });
    try {
      const asked: ToolCallPreview[] = [];
      let remember = true;
      bundle.approvals.setPromptHandler(async (preview) => {
        asked.push(preview);
        const decision = remember ? { accepted: true, remember: "allow" as const } : { accepted: true };
        remember = false;
        return decision;
      });

      await invoke(bundle.tools, "ssh_command", { host: "vps", command: "uptime" });
      // Second call to the same host + command: the remembered rule skips the question.
      await invoke(bundle.tools, "ssh_command", { host: "vps", command: "uptime" });
      assert.equal(asked.length, 1, "die vps-Regel hätte das zweite Mal nicht fragen dürfen");

      // A different host with the exact same command must still ask.
      await invoke(bundle.tools, "ssh_command", { host: "produktion", command: "uptime" });
      assert.equal(asked.length, 2, "produktion darf nicht von der vps-Regel profitieren");
    } finally {
      await bundle.cleanup();
    }
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
