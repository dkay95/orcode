import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager } from "../src/approval.js";
import {
  ChangeJournal,
  WorkspaceGuard,
  createCodingTools,
  isWithinWorkspace,
  sanitizedEnvironment,
} from "../src/workspace.js";

test("workspace guard blocks lexical traversal and escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "routercode-outside-"));
  await symlink(outside, join(root, "escape"));
  const guard = await WorkspaceGuard.create(root);

  await assert.rejects(guard.resolvePath("../outside.txt"), /außerhalb/);
  await assert.rejects(guard.resolvePath("escape/file.txt"), /Symlink verlässt/);
  assert.equal(isWithinWorkspace(root, join(root, "src", "x.ts")), true);
  assert.equal(isWithinWorkspace(root, outside), false);
});

test("write, replace, and undo stay inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-tools-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "demo.txt"), "hello\n", "utf8");
  const guard = await WorkspaceGuard.create(root);
  const approvals = new ApprovalManager("allow-all");
  const journal = new ChangeJournal();
  const tools = createCodingTools(guard, approvals, journal);

  await tools[4].function.execute(
    {
      path: "src/demo.txt",
      oldText: "hello",
      newText: "world",
      replaceAll: false,
    },
    {} as never,
  );
  assert.equal(await readFile(join(root, "src", "demo.txt"), "utf8"), "world\n");
  assert.equal(journal.size, 1);

  await journal.undoLast(guard, approvals);
  assert.equal(await readFile(join(root, "src", "demo.txt"), "utf8"), "hello\n");

  await assert.rejects(
    async () =>
      tools[3].function.execute(
        { path: "../escape.txt", content: "nope" },
        {} as never,
      ),
    /außerhalb/,
  );
});

test("catastrophic shell commands stay blocked even in allow-all", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-shell-"));
  const guard = await WorkspaceGuard.create(root);
  const tools = createCodingTools(
    guard,
    new ApprovalManager("allow-all"),
    new ChangeJournal(),
  );

  await assert.rejects(
    async () =>
      tools[5].function.execute(
        { command: "rm -rf /", timeoutSeconds: 1 },
        {} as never,
      ),
    /Katastrophenschutz/,
  );
});

test("shell environment removes credential-like variables", () => {
  const result = sanitizedEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    OPENROUTER_API_KEY: "secret",
    GH_TOKEN: "secret",
    DATABASE_PASSWORD: "secret",
    NORMAL_SETTING: "visible",
  });

  assert.equal(result.PATH, "/usr/bin");
  assert.equal(result.NORMAL_SETTING, "visible");
  assert.equal(result.OPENROUTER_API_KEY, undefined);
  assert.equal(result.GH_TOKEN, undefined);
  assert.equal(result.DATABASE_PASSWORD, undefined);
});

test("run_command receives the sanitized environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-env-"));
  const guard = await WorkspaceGuard.create(root);
  const tools = createCodingTools(
    guard,
    new ApprovalManager("allow-all"),
    new ChangeJournal(),
  );
  process.env.ROUTERCODE_TEST_TOKEN = "must-not-reach-child";
  try {
    const result = await tools[5].function.execute(
      {
        command:
          'if [[ -z "${ROUTERCODE_TEST_TOKEN:-}" ]]; then echo hidden; else echo exposed; fi',
        timeoutSeconds: 5,
      },
      {} as never,
    );
    assert.equal(result.stdout.trim(), "hidden");
  } finally {
    delete process.env.ROUTERCODE_TEST_TOKEN;
  }
});
