import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createCodexPatchApprovalBinding,
  createCodexPatchPreview,
  createCodexStagingWorkspace,
  publishExactStagedEffects,
  snapshotCodexTree,
} from "../src/codex-staging-workspace.js";
import {
  ApprovalManager,
  authorizeOneShotApproval,
} from "../src/approval.js";
import { approveCodexPatchPreview } from "../src/codex-staging-workspace.js";
import {
  ChangeJournal,
  WorkspaceGuard,
} from "../src/workspace.js";
import * as workspaceApi from "../src/workspace.js";

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-staging-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(join(workspacePath, "src"), { recursive: true, mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  await writeFile(join(workspacePath, "src", "main.ts"), "export const value = 1;\n");
  await writeFile(join(workspacePath, ".gitignore"), "ignored.log\n");
  await writeFile(join(workspacePath, "ignored.log"), "ignore me\n");
  await writeFile(join(workspacePath, ".env.local"), "SECRET=canary\n");
  await mkdir(join(workspacePath, ".git"));
  await writeFile(join(workspacePath, ".git", "config"), "private git state\n");
  return {
    root,
    workspacePath,
    appHome,
    workspace: await WorkspaceGuard.create(workspacePath),
  };
}

async function approvePreview<T extends Awaited<ReturnType<typeof createCodexPatchPreview>>>(
  preview: T,
) {
  const binding = createCodexPatchApprovalBinding(preview, `test:${preview.itemId}`);
  const receipt = await authorizeOneShotApproval(
    new ApprovalManager("allow-all"),
    {
      name: "codex_file_change",
      risk: "edit",
      summary: "Approve exact test preview",
      rememberable: false,
    },
    { authorityBinding: binding },
  );
  return approveCodexPatchPreview(preview, receipt, binding);
}

test("creates a fresh owner-only staging copy and excludes ignored or private state", async () => {
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({
      appHome: state.appHome,
      realWorkspace: state.workspace,
    });
    assert.notEqual(staging.canonicalPath, state.workspace.canonicalRoot);
    assert.equal(staging.canonicalPath.startsWith(join(await realpath(state.appHome), "codex-staging") + sep), true);
    assert.equal((await lstat(staging.canonicalPath)).mode & 0o077, 0);
    assert.equal(await readFile(join(staging.canonicalPath, "src", "main.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(existsSync(join(staging.canonicalPath, "ignored.log")), false);
    assert.equal(existsSync(join(staging.canonicalPath, ".env.local")), false);
    assert.equal(existsSync(join(staging.canonicalPath, ".git")), false);
    assert.equal((await lstat(join(staging.canonicalPath, "src", "main.ts"))).mode & 0o077, 0);
    await staging.discard();
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rejects links in the verified workspace and removes the incomplete staging run", async (context) => {
  if (process.platform === "win32") {
    context.skip("symbolic-link privilege varies on Windows");
    return;
  }
  const state = await fixture();
  await symlink("src/main.ts", join(state.workspacePath, "linked.ts"));
  try {
    await assert.rejects(
      createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace }),
      /link/i,
    );
    const stagingRoot = join(state.appHome, "codex-staging");
    assert.deepEqual(existsSync(stagingRoot) ? await readdir(stagingRoot) : [], []);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("publishes an exact approved update through WorkspaceGuard and one journal batch", async () => {
  const state = await fixture();
  class PreMutationJournal extends ChangeJournal {
    override async recordBatch(entries: Parameters<ChangeJournal["recordBatch"]>[0]): Promise<void> {
      assert.equal(
        await readFile(join(state.workspacePath, "src", "main.ts"), "utf8"),
        "export const value = 1;\n",
        "the durable recovery entry must exist before the first real-workspace mutation",
      );
      await super.recordBatch(entries);
    }
  }
  const journal = new PreMutationJournal({ appHome: state.appHome, chatId: "chat-update" });
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n");
    const result = await publishExactStagedEffects({
      staging,
      previews: [preview],
      realWorkspace: state.workspace,
      journal,
      runId: "run-update",
    });
    assert.deepEqual(result.publishedPaths, ["src/main.ts"]);
    assert.equal(await readFile(join(state.workspacePath, "src", "main.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(journal.size, 1);
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("discards staging on any unpreviewed write and leaves the real workspace byte-identical", async () => {
  const state = await fixture();
  const journal = new ChangeJournal({ appHome: state.appHome, chatId: "chat-extra" });
  try {
    const before = await snapshotCodexTree(state.workspace.canonicalRoot);
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n");
    await writeFile(join(staging.canonicalPath, "unpreviewed.txt"), "extra\n");
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal,
        runId: "run-extra",
      }),
      /unpreviewed effect|exact preview/i,
    );
    assert.deepEqual(await snapshotCodexTree(state.workspace.canonicalRoot), before);
    assert.equal(existsSync(staging.canonicalPath), false);
    assert.equal(journal.size, 0);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a real-workspace conflict aborts before publication and preserves the external bytes", async () => {
  const state = await fixture();
  const journal = new ChangeJournal({ appHome: state.appHome, chatId: "chat-conflict" });
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-1",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n");
    await writeFile(join(state.workspacePath, "src", "main.ts"), "external edit\n");
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal,
        runId: "run-conflict",
      }),
      /conflict|pre-image/i,
    );
    assert.equal(await readFile(join(state.workspacePath, "src", "main.ts"), "utf8"), "external edit\n");
    assert.equal(existsSync(staging.canonicalPath), false);
    assert.equal(journal.size, 0);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("metadata broadening is an uncovered effect and is never published", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode assertion");
    return;
  }
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    await chmod(join(staging.canonicalPath, "src", "main.ts"), 0o644);
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-mode" }),
        runId: "run-mode",
      }),
      /metadata|owner-only|unpreviewed effect/i,
    );
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rejects a new file whose mode is not owner-only", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode assertion");
    return;
  }
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-add-mode",
      childGeneration: 2,
      changes: [{
        path: "new.txt",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+new\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "new.txt"), "new\n", { mode: 0o666 });
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-new-mode" }),
        runId: "run-new-mode",
      }),
      /metadata|owner-only/i,
    );
    assert.equal(existsSync(join(state.workspacePath, "new.txt")), false);
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("one owner decision cannot approve two different patch previews", async () => {
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const first = await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-first",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    });
    const second = await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-second",
      childGeneration: 2,
      changes: [{
        path: "new.txt",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+new\n",
      }],
    });
    const binding = createCodexPatchApprovalBinding(first, "number:reuse");
    const receipt = await authorizeOneShotApproval(
      new ApprovalManager("allow-all"),
      {
        name: "codex_file_change",
        risk: "edit",
        summary: "Approve exactly one patch preview",
        rememberable: false,
      },
      { authorityBinding: binding },
    );
    approveCodexPatchPreview(first, receipt, binding);
    assert.throws(
      () => approveCodexPatchPreview(second, receipt, binding),
      /one-shot|approval/i,
    );
    await staging.discard();
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a staging-root permission change is an uncovered metadata effect", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode assertion");
    return;
  }
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    await chmod(staging.canonicalPath, 0o755);
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-root-mode" }),
        runId: "run-root-mode",
      }),
      /metadata|owner-only/i,
    );
    assert.equal(existsSync(staging.canonicalPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("the persisted journal can recover a crash after a pre-image was moved aside", async () => {
  const state = await fixture();
  const target = join(state.workspacePath, "src", "main.ts");
  const rollbackPath = join(
    state.workspacePath,
    "src",
    ".orcode-01234567-89ab-4cde-8fab-0123456789ab.rollback",
  );
  const runId = "run-crash-recovery";
  try {
    const journal = new ChangeJournal({ appHome: state.appHome, chatId: "chat-crash" });
    await journal.recordBatch([{
      path: target,
      before: "export const value = 1;\n",
      after: "export const value = 2;\n",
      createdAt: "2026-09-02T00:00:00.000Z",
      runId,
      rollbackPath,
    }]);
    await rename(target, rollbackPath);

    const recovered = new ChangeJournal({ appHome: state.appHome, chatId: "chat-crash" });
    assert.equal((await recovered.hydrateRun(runId)).length, 1);
    const outcome = await recovered.undoLastRun(
      state.workspace,
      new ApprovalManager("allow-all"),
    );
    assert.deepEqual(outcome, { restored: ["src/main.ts"], skipped: [] });
    assert.equal(await readFile(target, "utf8"), "export const value = 1;\n");
    assert.equal(existsSync(rollbackPath), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a receipt approved for one preview cannot authorize another item or path", async () => {
  const state = await fixture();
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const first = await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-a",
      childGeneration: 2,
      changes: [{
        path: "a.txt",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+a\n",
      }],
    });
    const second = await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-b",
      childGeneration: 2,
      changes: [{
        path: "b.txt",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+b\n",
      }],
    });
    const binding = createCodexPatchApprovalBinding(first, "number:41");
    const receipt = await authorizeOneShotApproval(
      new ApprovalManager("allow-all"),
      {
        name: "codex_file_change",
        risk: "edit",
        summary: "Approve a.txt only",
        rememberable: false,
      },
      { authorityBinding: binding },
    );

    assert.throws(
      () => approveCodexPatchPreview(second, receipt, binding),
      /binding|digest|item|path|approval/i,
    );
    await writeFile(join(staging.canonicalPath, "b.txt"), "b\n", { mode: 0o600 });
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [second as never],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-binding" }),
        runId: "run-binding",
      }),
      /approved|authority/i,
    );
    assert.equal(existsSync(join(state.workspacePath, "b.txt")), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("fails closed instead of replacing a real-workspace file with extended attributes", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS extended-attribute boundary");
    return;
  }
  const state = await fixture();
  const target = join(state.workspacePath, "src", "main.ts");
  await execFileAsync("/usr/bin/xattr", ["-w", "com.orcode.task5", "bound", target]);
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-xattr",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n");
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-xattr" }),
        runId: "run-xattr",
      }),
      /extended attribute|metadata|xattr/i,
    );
    assert.equal(await readFile(target, "utf8"), "export const value = 1;\n");
    const { stdout } = await execFileAsync("/usr/bin/xattr", ["-p", "com.orcode.task5", target]);
    assert.equal(stdout.trim(), "bound");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rejects an unpreviewed staged extended-attribute effect before real mutation", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS extended-attribute boundary");
    return;
  }
  const state = await fixture();
  const realTarget = join(state.workspacePath, "src", "main.ts");
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-staged-xattr",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    const stagedTarget = join(staging.canonicalPath, "src", "main.ts");
    await writeFile(stagedTarget, "export const value = 2;\n", { mode: 0o600 });
    await execFileAsync("/usr/bin/xattr", ["-w", "com.orcode.unpreviewed", "secret-metadata", stagedTarget]);
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-staged-xattr" }),
        runId: "run-staged-xattr",
      }),
      /unpreviewed|metadata|attribute|exact preview/i,
    );
    assert.equal(await readFile(realTarget, "utf8"), "export const value = 1;\n");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rejects changed or removed staged extended attributes as uncovered effects", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS extended-attribute boundary");
    return;
  }
  for (const operation of ["changed", "removed"] as const) {
    await context.test(operation, async () => {
      const state = await fixture();
      const realTarget = join(state.workspacePath, "src", "main.ts");
      try {
        await execFileAsync("/usr/bin/xattr", ["-w", "com.orcode.bound", "initial", realTarget]);
        const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
        const preview = await approvePreview(await createCodexPatchPreview({
          staging, threadId: "thread-1", turnId: "turn-1", itemId: `patch-xattr-${operation}`,
          childGeneration: 2,
          changes: [{ path: "src/main.ts", kind: "update", diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" }],
        }));
        const stagedTarget = join(staging.canonicalPath, "src", "main.ts");
        await writeFile(stagedTarget, "export const value = 2;\n", { mode: 0o600 });
        if (operation === "changed") {
          await execFileAsync("/usr/bin/xattr", ["-w", "com.orcode.bound", "changed", stagedTarget]);
        } else {
          const { stdout: stagedNames } = await execFileAsync("/usr/bin/xattr", [stagedTarget]);
          if (!stagedNames.split("\n").includes("com.apple.provenance")) {
            context.skip("this filesystem did not attach a provenance xattr to the staged pre-image");
            return;
          }
          await execFileAsync("/usr/bin/xattr", ["-d", "com.apple.provenance", stagedTarget]);
        }
        await assert.rejects(
          publishExactStagedEffects({
            staging, previews: [preview], realWorkspace: state.workspace,
            journal: new ChangeJournal({ appHome: state.appHome, chatId: `chat-xattr-${operation}` }),
            runId: `run-xattr-${operation}`,
          }),
          /unpreviewed|metadata|attribute|exact preview/i,
        );
        assert.equal(await readFile(realTarget, "utf8"), "export const value = 1;\n");
      } finally {
        await rm(state.root, { recursive: true, force: true });
      }
    });
  }
});

test("undo of a published delete restores the exact original executable mode", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode assertion");
    return;
  }
  const state = await fixture();
  const target = join(state.workspacePath, "src", "main.ts");
  await chmod(target, 0o700);
  const journal = new ChangeJournal({ appHome: state.appHome, chatId: "chat-delete-mode" });
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-delete-mode",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "delete",
        diff: "@@ -1 +0,0 @@\n-export const value = 1;\n",
      }],
    }));
    await unlink(join(staging.canonicalPath, "src", "main.ts"));
    await publishExactStagedEffects({
      staging,
      previews: [preview],
      realWorkspace: state.workspace,
      journal,
      runId: "run-delete-mode",
    });
    assert.equal(existsSync(target), false);
    await journal.undoLastRun(state.workspace, new ApprovalManager("allow-all"));
    assert.equal((await lstat(target)).mode & 0o777, 0o700);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rejects a parent-directory inode swap before publishing a new file", async () => {
  const state = await fixture();
  const sourceParent = join(state.workspacePath, "src");
  const movedParent = join(state.workspacePath, "src-external");
  const journal = new ChangeJournal({ appHome: state.appHome, chatId: "chat-parent-swap" });
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-parent-swap",
      childGeneration: 2,
      changes: [{
        path: "src/new.ts",
        kind: "add",
        diff: "@@ -0,0 +1 @@\n+new\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "new.ts"), "new\n", { mode: 0o600 });
    const assertCurrent = WorkspaceGuard.prototype.assertCurrent.bind(state.workspace);
    let checks = 0;
    Object.defineProperty(state.workspace, "assertCurrent", {
      configurable: true,
      value: async () => {
        await assertCurrent();
        checks += 1;
        if (checks === 3) {
          await rename(sourceParent, movedParent);
          await mkdir(sourceParent, { mode: 0o700 });
        }
      },
    });
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal,
        runId: "run-parent-swap",
      }),
      /directory|identity|parent|changed/i,
    );
    assert.equal(existsSync(join(sourceParent, "new.ts")), false);
    assert.equal(await readFile(join(movedParent, "main.ts"), "utf8"), "export const value = 1;\n");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("rollback follows the bound parent inode after a post-mutation directory swap", async () => {
  const state = await fixture();
  const sourceParent = join(state.workspacePath, "src");
  const movedParent = join(state.workspacePath, "src-moved-after-apply");
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-post-apply-parent-swap",
      childGeneration: 2,
      changes: [
        { path: "src/main.ts", kind: "update", diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" },
        { path: "src/second.ts", kind: "add", diff: "@@ -0,0 +1 @@\n+second\n" },
      ],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n", { mode: 0o600 });
    await writeFile(join(staging.canonicalPath, "src", "second.ts"), "second\n", { mode: 0o600 });
    const assertCurrent = WorkspaceGuard.prototype.assertCurrent.bind(state.workspace);
    let checks = 0;
    Object.defineProperty(state.workspace, "assertCurrent", {
      configurable: true,
      value: async () => {
        await assertCurrent();
        checks += 1;
        if (checks === 5) {
          await rename(sourceParent, movedParent);
          await mkdir(sourceParent, { mode: 0o700 });
        }
      },
    });
    await assert.rejects(
      publishExactStagedEffects({
        staging,
        previews: [preview],
        realWorkspace: state.workspace,
        journal: new ChangeJournal({ appHome: state.appHome, chatId: "chat-post-apply-parent-swap" }),
        runId: "run-post-apply-parent-swap",
      }),
      /directory|identity|parent|changed/i,
    );
    assert.ok(checks >= 5, "the swap must occur after the first physical mutation");
    assert.equal(await readFile(join(movedParent, "main.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(existsSync(join(movedParent, "second.ts")), false);
    assert.equal(existsSync(join(sourceParent, "main.ts")), false, "replacement parent stays untouched");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("direct guarded publication cannot bypass exact preview approval authority", async () => {
  const state = await fixture();
  const hook = join(state.workspacePath, ".git", "hooks", "post-commit");
  try {
    assert.equal(
      (workspaceApi as Record<string, unknown>).publishGuardedWorkspaceFiles,
      undefined,
      "the raw mutation primitive must not be exported",
    );
    await assert.rejects(
      state.workspace.publishCodexApprovedEffects(
        Object.freeze({}),
        new ChangeJournal({ appHome: state.appHome, chatId: "chat-api-bypass" }),
        "run-api-bypass",
      ),
      /approval|authority|preview|protected/i,
    );
    assert.equal(existsSync(hook), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("discard unlinks hostile staging symlinks without following them and settles inactive", async (context) => {
  if (process.platform === "win32") {
    context.skip("symbolic-link privilege varies on Windows");
    return;
  }
  const state = await fixture();
  const outside = join(state.root, "outside.txt");
  await writeFile(outside, "outside\n");
  const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
  await symlink(outside, join(staging.canonicalPath, "hostile-link"));
  try {
    await staging.discard();
    assert.equal(staging.active, false);
    assert.equal(existsSync(staging.canonicalPath), false);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a fresh process reclaims only a validated owner-only stale run", async (context) => {
  if (process.platform === "win32") {
    context.skip("restart fixture uses POSIX symlink and mode boundaries");
    return;
  }
  const state = await fixture();
  try {
    const stagingModule = pathToFileURL(resolve("src/codex-staging-workspace.js")).href;
    const workspaceModule = pathToFileURL(resolve("src/workspace.js")).href;
    const script = [
      `import { createCodexStagingWorkspace } from ${JSON.stringify(stagingModule)};`,
      `import { WorkspaceGuard } from ${JSON.stringify(workspaceModule)};`,
      "const staging = await createCodexStagingWorkspace({ appHome: process.argv[2], realWorkspace: await WorkspaceGuard.create(process.argv[1]) });",
      "process.stdout.write(staging.canonicalPath);",
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", script,
      state.workspacePath,
      state.appHome,
    ]);
    const stalePath = stdout.trim();
    assert.equal(existsSync(stalePath), true);
    const stagingRoot = join(state.appHome, "codex-staging");
    const outside = join(state.root, "outside-decoy");
    await mkdir(outside, { mode: 0o700 });
    const symlinkDecoy = join(stagingRoot, `run-${"a".repeat(32)}`);
    const broadModeDecoy = join(stagingRoot, `run-${"b".repeat(32)}`);
    const nameDecoy = join(stagingRoot, "not-an-orcode-run");
    await symlink(outside, symlinkDecoy);
    await mkdir(broadModeDecoy, { mode: 0o755 });
    await mkdir(nameDecoy, { mode: 0o700 });

    const current = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    assert.equal(existsSync(stalePath), false);
    assert.equal(existsSync(symlinkDecoy), true, "symlink decoy is never followed or broadly removed");
    assert.equal(existsSync(broadModeDecoy), true, "non-owner-only decoy is not claimed");
    assert.equal(existsSync(nameDecoy), true, "non-run names are outside reclamation");
    assert.equal(existsSync(current.canonicalPath), true);
    await current.discard();
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a ChangeJournal subclass cannot replace durable batch methods with no-ops", async () => {
  const state = await fixture();
  class NoopJournal extends ChangeJournal {
    override async recordBatch(): Promise<void> {}
    override async rollbackBatch(): Promise<void> {}
  }
  const journal = new NoopJournal({ appHome: state.appHome, chatId: "chat-noop-journal" });
  try {
    const staging = await createCodexStagingWorkspace({ appHome: state.appHome, realWorkspace: state.workspace });
    const preview = await approvePreview(await createCodexPatchPreview({
      staging,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-noop-journal",
      childGeneration: 2,
      changes: [{
        path: "src/main.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
      }],
    }));
    await writeFile(join(staging.canonicalPath, "src", "main.ts"), "export const value = 2;\n");
    await publishExactStagedEffects({
      staging,
      previews: [preview],
      realWorkspace: state.workspace,
      journal,
      runId: "run-noop-journal",
    });
    assert.equal(journal.size, 1, "publication must invoke the authentic journal implementation");
    assert.equal(await readFile(join(state.workspacePath, "src", "main.ts"), "utf8"), "export const value = 2;\n");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
