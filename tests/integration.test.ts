import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrcodeAgent } from "../src/agent.js";
import { ApprovalManager } from "../src/approval.js";
import {
  createPlainCommandOutput,
  handleSlashCommand,
  type CommandContext,
  type CommandOutput,
} from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CredentialStoreLike } from "../src/credentials.js";
import { OpenRouterService } from "../src/openrouter.js";
import { RuleStore } from "../src/rules.js";
import { SessionStore } from "../src/session.js";
import type { ToolCallPreview } from "../src/types.js";

/**
 * These tests cover the seams between the modules, not the modules themselves:
 * whatever the command layer writes into the workspace must obey exactly the
 * same path policy as the write tools.
 */

interface Harness {
  context: CommandContext;
  workspace: string;
  asked: ToolCallPreview[];
}

async function harness(
  options: { approve?: boolean } = {},
): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-integration-"));
  const appHome = join(workspace, ".state");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
  const session = await SessionStore.open(workspace, appHome);
  session.addTurn("user", "Erste Frage");
  session.addTurn("assistant", "Erste Antwort");

  const approvals = new ApprovalManager("allow-all");
  const asked: ToolCallPreview[] = [];
  approvals.setPromptHandler(async (preview) => {
    asked.push(preview);
    return { accepted: options.approve === true };
  });

  const openRouter = new OpenRouterService("sk-or-v1-integration-test-key-0001");
  const config = {
    ...DEFAULT_CONFIG,
    reasoningByModel: {},
    budget: { ...DEFAULT_CONFIG.budget },
  };
  const agent = await OrcodeAgent.create({
    openRouter,
    approvals,
    session,
    config,
    workspace,
  });
  const ruleStore = await RuleStore.load(appHome);
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
  return {
    workspace,
    asked,
    context: {
      config,
      approvals,
      openRouter,
      session,
      agent,
      workspace,
      credentials,
      out: createPlainCommandOutput(),
      ruleStore,
      // REGEL: no test may ever write to the real ~/.routercode/config.json —
      // every command that persists `config` must go through this instead of
      // `saveConfig`'s bare default path.
      configPath: join(appHome, "config.json"),
    },
  };
}

/** Collects `ctx.out` writes instead of printing them, for assertions. */
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

test("/export writes plain files without a fight", async () => {
  const { context, workspace, asked } = await harness({ approve: true });
  await handleSlashCommand("/export chat.md", context);
  const written = await readFile(join(workspace, "chat.md"), "utf8");
  assert.match(written, /## Verlauf/);
  assert.match(written, /Erste Antwort/);
  assert.equal(
    asked.length,
    0,
    "ein unverdächtiger Pfad darf in allow-all nicht nachfragen",
  );
});

test("/export cannot be used to slip past the deny list", async () => {
  // Same policy as write_file: .git/** always asks, .git/hooks/** is sealed.
  const denied = await harness({ approve: false });
  await assert.rejects(
    handleSlashCommand("/export .git/config", denied.context),
    /abgelehnt|gesperrt/i,
  );
  const gitConfig = denied.asked.at(-1);
  assert.equal(gitConfig?.risk, "edit");
  assert.match(String(gitConfig?.details), /git-metadata|\.git/);

  const hooks = await harness({ approve: true });
  await assert.rejects(
    handleSlashCommand("/export .git/hooks/pre-commit", hooks.context),
    /gesperrt/,
  );
  assert.equal(
    hooks.asked.length,
    0,
    "ein Git-Hook darf gar nicht erst zur Freigabe angeboten werden",
  );
});

test("/export refuses to leave the workspace", async () => {
  const { context } = await harness({ approve: true });
  await assert.rejects(
    handleSlashCommand("/export ../ausserhalb.md", context),
    /außerhalb des Arbeitsverzeichnisses/,
  );
});

test("/init creates its file through the guard, not through a raw path join", async () => {
  const { context, workspace, asked } = await harness({ approve: true });
  await handleSlashCommand("/init", context);
  const created = await readFile(join(workspace, "ORCODE.md"), "utf8");
  assert.match(created, /# orcode project instructions/);
  assert.equal(
    asked.length,
    0,
    "ORCODE.md ist kein geschützter Pfad und fragt in allow-all nicht nach",
  );
});

test("a protected path forces a question even in allow-all", async () => {
  // The mode decides how much the model may do on its own; the path policy
  // decides what nobody may do silently. This is the seam between the two.
  const { context, asked } = await harness({ approve: false });
  assert.equal(context.approvals.mode, "allow-all");
  await assert.rejects(
    handleSlashCommand("/export .env.backup", context),
    /abgelehnt/i,
  );
  assert.equal(asked.length, 1);
  assert.match(String(asked[0]?.details), /Geschützter Pfad|Zugangsdaten/);
});

test("/status reports the limits it can actually enforce", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/status", context);
  const output = lines.join("\n");
  assert.match(output, /Approval: allow-all/);
  assert.match(output, /Budget: kein Tageslimit/);
  // The compressor limit is only enforceable up front when a price is known.
  assert.match(output, /Kompressorlimit/);
});

test("/checkpoint marks a point and rewinds to it", async () => {
  const { context } = await harness({ approve: true });
  await handleSlashCommand("/checkpoint new Basis", context);
  context.session.addTurn("user", "Zweite Frage");
  context.session.addTurn("assistant", "Zweite Antwort");
  assert.equal(context.session.data.turns.length, 4);

  await handleSlashCommand("/checkpoint restore Basis", context);
  assert.equal(context.session.data.turns.length, 2);

  const reopened = await SessionStore.openById(
    context.workspace,
    context.session.data.id,
    context.session.appHome,
  );
  assert.equal(
    reopened.data.turns.length,
    2,
    "der Rücksprung muss gespeichert worden sein",
  );
});

test("/allow list shows nothing, then a remembered rule, then nothing after forget", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/allow list", context);
  assert.match(lines.join("\n"), /Keine gemerkten Regeln/);

  const rule = await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "run_command",
    match: { kind: "command-prefix", value: "npm test" },
    decision: "allow",
  });
  lines.length = 0;
  await handleSlashCommand("/allow list", context);
  assert.match(lines.join("\n"), /allow/);
  assert.match(lines.join("\n"), /npm test/);

  lines.length = 0;
  await handleSlashCommand(`/allow forget ${rule.id}`, context);
  assert.match(lines.join("\n"), /vergessen/);
  assert.equal(context.ruleStore.list(context.workspace).length, 0);
});

test("/allow forget all clears every rule for this workspace", async () => {
  const { context } = await harness();
  await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "run_command",
    match: { kind: "command-prefix", value: "npm test" },
    decision: "allow",
  });
  await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "write_file",
    match: { kind: "path-glob", value: "src/**" },
    decision: "allow",
  });
  assert.equal(context.ruleStore.list(context.workspace).length, 2);

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/allow forget all", context);
  assert.match(lines.join("\n"), /2 Regel/);
  assert.equal(context.ruleStore.list(context.workspace).length, 0);
});

test("/undo --dry-run restores nothing and leaves the journal intact", async () => {
  const { context, workspace } = await harness({ approve: true });
  const target = join(workspace, "dry-run.txt");
  await handleSlashCommand("/init", context); // exercises a real write path
  const before = await readFile(join(workspace, "ORCODE.md"), "utf8");

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/undo --dry-run", context);
  assert.match(lines.join("\n"), /würden wiederhergestellt|Keine orcode-Änderung/);

  const after = await readFile(join(workspace, "ORCODE.md"), "utf8");
  assert.equal(before, after, "--dry-run darf nichts auf die Platte schreiben");
  void target;
});

test("/web sets the config mode and rejects unknown values", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/web off", context);
  assert.equal(context.config.web, "off");
  assert.match(lines.join("\n"), /off/);

  await assert.rejects(handleSlashCommand("/web maybe", context), /Ungültiger Web-Modus/);
  assert.equal(context.config.web, "off", "eine ungültige Eingabe darf den Modus nicht ändern");
});

test("/provider sort, deny/allow, only and clear round-trip through config", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/provider sort price", context);
  assert.equal(context.config.provider.sort, "price");

  await handleSlashCommand("/provider allow", context);
  assert.equal(context.config.provider.dataCollection, "allow");

  await handleSlashCommand("/provider only anthropic openai", context);
  assert.deepEqual(context.config.provider.only, ["anthropic", "openai"]);

  await handleSlashCommand("/provider clear", context);
  assert.equal(context.config.provider.sort, undefined);
  assert.equal(context.config.provider.only, undefined);
  assert.equal(
    context.config.provider.dataCollection,
    "deny",
    "clear fällt auf den sicheren Default zurück",
  );
  void lines;
});

test("/fallback adds, removes, and clears the fallback chain", async () => {
  const { context } = await harness();

  await handleSlashCommand("/fallback +anthropic/claude", context);
  assert.deepEqual(context.config.fallbackModels, ["anthropic/claude"]);

  await handleSlashCommand("/fallback +anthropic/claude", context);
  assert.deepEqual(
    context.config.fallbackModels,
    ["anthropic/claude"],
    "ein doppelter Eintrag darf die Kette nicht verlängern",
  );

  await handleSlashCommand("/fallback +openai/gpt", context);
  assert.deepEqual(context.config.fallbackModels, ["anthropic/claude", "openai/gpt"]);

  await handleSlashCommand("/fallback -anthropic/claude", context);
  assert.deepEqual(context.config.fallbackModels, ["openai/gpt"]);

  await handleSlashCommand("/fallback clear", context);
  assert.deepEqual(context.config.fallbackModels, []);
});

test("/verify adds a command, then on/off/rounds/clear all persist", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/verify npm test", context);
  assert.deepEqual(context.config.verify.commands, ["npm test"]);

  await handleSlashCommand("/verify off", context);
  assert.equal(context.config.verify.mode, "off");
  await handleSlashCommand("/verify on", context);
  assert.equal(context.config.verify.mode, "on-edit");

  await handleSlashCommand("/verify rounds 2", context);
  assert.equal(context.config.verify.maxRounds, 2);
  await assert.rejects(handleSlashCommand("/verify rounds 9", context), /zwischen 1 und/);

  await handleSlashCommand("/verify clear", context);
  assert.deepEqual(context.config.verify.commands, []);
  void lines;
});

test("/budget reports the workspace spend and rejects nonsense limits", async () => {
  // Only the paths that do NOT call saveConfig are exercised here: saveConfig
  // writes to the real ~/.routercode/config.json, which a test must not touch.
  // Validation and persistence of the budget are covered by config.test.ts.
  const { context } = await harness({ approve: true });
  context.session.addCost("main", 0.25);
  await context.session.save();
  context.config.budget.dailyLimitUsd = 5;

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/budget", context);
  assert.match(lines.join("\n"), /Tag \$5\.00/);
  assert.match(lines.join("\n"), /heute \$0\.25/);

  await assert.rejects(
    handleSlashCommand("/budget day tausend", context),
    /Budgetgrenze/,
  );
  await assert.rejects(
    handleSlashCommand("/budget on-exceed vielleicht", context),
    /on-exceed/,
  );
});
