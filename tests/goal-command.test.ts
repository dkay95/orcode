/**
 * The `/goal` slash command (D9, src/commands.ts): setting, showing, and
 * clearing a chat's persistent standing goal, through `handleSlashCommand`
 * exactly as the TUI/CLI dispatcher calls it. Mirrors
 * `tests/context-command.test.ts`'s minimal `fakeContext` harness — `/goal`
 * only ever touches `context.session` and `context.out`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMMAND_CATALOG } from "../src/command-catalog.js";
import {
  handleSlashCommand,
  type CommandContext,
} from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MAX_GOAL_CHARS, SessionStore } from "../src/session.js";

function fakeContext(session: SessionStore, overrides: Partial<CommandContext> = {}): {
  context: CommandContext;
  output: string[];
} {
  const output: string[] = [];
  return {
    context: {
      workspace: session.data.workspace,
      session,
      config: structuredClone(DEFAULT_CONFIG),
      out: {
        text: (value: string) => output.push(value),
        error: (value: string) => output.push(value),
      },
      ...overrides,
    } as unknown as CommandContext,
    output,
  };
}

async function tempRoot(prefix: string): Promise<{ workspace: string; appHome: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `orcode-goal-cmd-${prefix}-`));
  return {
    workspace: join(root, "project"),
    appHome: join(root, ".orcode"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("the /goal catalog entry lives in the Chat group and documents the off subcommand", () => {
  const entry = COMMAND_CATALOG.find((command) => command.name === "goal");
  assert.ok(entry, "/goal must be registered in the shared catalog");
  assert.equal(entry!.handlerId, "goal");
  assert.match(entry!.usage, /off/);
});

test("bare /goal on a chat with no goal shows an honest 'no goal set' message", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("bare-empty");
  try {
    const session = SessionStore.create(workspace, appHome, "Goal bare");
    const { context, output } = fakeContext(session);

    await handleSlashCommand("/goal", context);
    assert.match(output.join("\n"), /No goal set — \/goal <text> sets one\./);
  } finally {
    await cleanup();
  }
});

test("/goal <text> sets the goal, persists it, and bare /goal then shows it", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("set-and-show");
  try {
    const session = SessionStore.create(workspace, appHome, "Goal set");
    const { context, output } = fakeContext(session);

    await handleSlashCommand("/goal Ship the D9 feature end to end", context);
    assert.match(output.join("\n"), /Goal set: Ship the D9 feature end to end/);
    assert.equal(context.session.data.goal, "Ship the D9 feature end to end");

    const persisted = JSON.parse(await readFile(context.session.path, "utf8")) as { goal?: string };
    assert.equal(persisted.goal, "Ship the D9 feature end to end");

    output.length = 0;
    await handleSlashCommand("/goal", context);
    assert.match(output.join("\n"), /^Goal: Ship the D9 feature end to end$/m);
  } finally {
    await cleanup();
  }
});

test("/goal off clears an existing goal, persists the clear, and reports honestly when nothing was set", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("off");
  try {
    const session = SessionStore.create(workspace, appHome, "Goal off");
    const { context, output } = fakeContext(session);

    await handleSlashCommand("/goal Keep it green", context);
    output.length = 0;

    await handleSlashCommand("/goal off", context);
    assert.match(output.join("\n"), /Goal cleared\./);
    assert.equal(context.session.data.goal, undefined);

    const persisted = JSON.parse(await readFile(context.session.path, "utf8")) as { goal?: string };
    assert.equal(persisted.goal, undefined, "the clear itself must persist");

    output.length = 0;
    await handleSlashCommand("/goal off", context);
    assert.match(output.join("\n"), /No goal was set\./);
  } finally {
    await cleanup();
  }
});

test("/goal refuses an over-limit value with an honest error naming the exact limit, instead of silently truncating it", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("over-limit");
  try {
    const session = SessionStore.create(workspace, appHome, "Goal over limit");
    const { context } = fakeContext(session);

    const tooLong = "x".repeat(MAX_GOAL_CHARS + 1);
    await assert.rejects(
      handleSlashCommand(`/goal ${tooLong}`, context),
      new RegExp(`too long.*limit is ${MAX_GOAL_CHARS}`, "s"),
    );
    assert.equal(context.session.data.goal, undefined, "a refused goal must never be partially applied");
  } finally {
    await cleanup();
  }
});

test("/goal '' (an explicitly empty argument) is refused honestly rather than silently accepted", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("empty-arg");
  try {
    const session = SessionStore.create(workspace, appHome, "Goal empty arg");
    const { context } = fakeContext(session);

    await assert.rejects(handleSlashCommand("/goal ''", context), /must not be empty/);
    assert.equal(context.session.data.goal, undefined);
  } finally {
    await cleanup();
  }
});
