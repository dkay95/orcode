import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalManager } from "../src/approval.js";
import {
  codexSandboxPlan,
  prepareCodexExecution,
} from "../src/codex-execution.js";
import { CodexRouteGate, type CodexRouteBinding } from "../src/codex-route-gate.js";
import { ChangeJournal, WorkspaceGuard } from "../src/workspace.js";

const routeBindingTemplate: CodexRouteBinding = {
  profileId: "profile-personal",
  codexHomeRealpath: "/private/orcode/providers/codex/codex-0123456789abcdef0123456789abcdef",
  route: {
    version: 1,
    backendId: "codex",
    accountFingerprint: "owner-profile-fingerprint",
    billingRealm: "chatgpt-subscription-provider-managed-overage",
    requestedModelId: "gpt-5.4",
    canonicalModelId: "gpt-5.4",
    resolutionState: "resolved",
  },
  modelId: "gpt-5.4",
};

function routeGate(
  binding: CodexRouteBinding,
  onRequest: () => void = () => undefined,
): CodexRouteGate {
  return new CodexRouteGate({
    ...binding,
    childGeneration: 4,
    client: {
      onNotification: () => () => undefined,
      request: async <T>() => {
        onRequest();
        return ({
          account: { type: "chatgpt", email: null, planType: "pro" },
          requiresOpenaiAuth: true,
        }) as unknown as T;
      },
    },
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-execution-"));
  const workspacePath = join(root, "workspace");
  const appHome = join(root, "app-home");
  await mkdir(workspacePath, { mode: 0o700 });
  await mkdir(appHome, { mode: 0o700 });
  const codexHome = join(appHome, "providers", "codex", "codex-0123456789abcdef0123456789abcdef");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  await writeFile(join(workspacePath, "main.ts"), "export const value = 1;\n");
  const routeBinding = {
    ...routeBindingTemplate,
    codexHomeRealpath: await realpath(codexHome),
  };
  return {
    root,
    appHome,
    workspace: await WorkspaceGuard.create(workspacePath),
    routeBinding,
  };
}

test("does not invoke the wired Codex route client before workspace and approval preparation", async () => {
  const { root, appHome, routeBinding } = await fixture();
  let taskBytes = 0;
  try {
    await assert.rejects(
      prepareCodexExecution({
        appHome,
        workspace: "/unverified/workspace" as never,
        approvals: undefined as never,
        journal: new ChangeJournal({ appHome, chatId: "chat-1" }),
        routeGate: routeGate(routeBinding, () => { taskBytes += 1; }),
        routeBinding,
      }),
      /verified workspace|approval/i,
    );
    assert.equal(taskBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maps every owner mode to a bounded no-network App Server sandbox", async () => {
  const { root, appHome, workspace, routeBinding } = await fixture();
  try {
    const preparedReadOnly = await prepareCodexExecution({
      appHome,
      workspace,
      approvals: new ApprovalManager("read-only"),
      journal: new ChangeJournal({ appHome, chatId: "chat-read" }),
      routeGate: routeGate(routeBinding),
      routeBinding,
    });
    assert.deepEqual(codexSandboxPlan("read-only", preparedReadOnly.staging), {
      thread: "read-only",
      turn: { type: "readOnly", networkAccess: false },
    });
    await preparedReadOnly.staging.discard();

    for (const mode of ["ask", "auto-edit", "allow-all"] as const) {
      const prepared = await prepareCodexExecution({
        appHome,
        workspace,
        approvals: new ApprovalManager(mode),
        journal: new ChangeJournal({ appHome, chatId: `chat-${mode}` }),
        routeGate: routeGate(routeBinding),
        routeBinding,
      });
      assert.deepEqual(prepared.sandbox, {
        thread: "workspace-write",
        turn: {
          type: "workspaceWrite",
          writableRoots: [prepared.staging.canonicalPath],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      });
      assert.equal(JSON.stringify(prepared.sandbox).includes("dangerFullAccess"), false);
      assert.equal(JSON.stringify(prepared.sandbox).includes(workspace.canonicalRoot), false);
      assert.equal(prepared.approvalPolicy, "untrusted");
      assert.equal(prepared.approvalsReviewer, "user");
      assert.equal(Object.isFrozen(prepared), true);
      await prepared.staging.discard();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an app home that would place writable staging inside the real workspace", async () => {
  const { root, workspace, routeBinding } = await fixture();
  const nestedAppHome = join(workspace.canonicalRoot, ".private-app-home");
  await mkdir(nestedAppHome, { mode: 0o700 });
  const nestedCodexHome = join(
    nestedAppHome,
    "providers",
    "codex",
    "codex-fedcba9876543210fedcba9876543210",
  );
  await mkdir(nestedCodexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(nestedCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const nestedRoute = { ...routeBinding, codexHomeRealpath: await realpath(nestedCodexHome) };
  try {
    await assert.rejects(
      prepareCodexExecution({
        appHome: nestedAppHome,
        workspace,
        approvals: new ApprovalManager("ask"),
        journal: new ChangeJournal({ appHome: nestedAppHome, chatId: "chat-overlap" }),
        routeGate: routeGate(nestedRoute),
        routeBinding: nestedRoute,
      }),
      /staging.*real workspace|overlap/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a broad-mode app home without silently tightening it", async () => {
  const { root, appHome, workspace, routeBinding } = await fixture();
  await chmod(appHome, 0o755);
  try {
    await assert.rejects(
      prepareCodexExecution({
        appHome,
        workspace,
        approvals: new ApprovalManager("ask"),
        journal: new ChangeJournal({ appHome, chatId: "chat-broad-home" }),
        routeGate: routeGate(routeBinding),
        routeBinding,
      }),
      /owner-only|app home|mode/i,
    );
    assert.equal((await lstat(appHome)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds staging app home to both the selected Codex profile and journal home", async () => {
  const { root, appHome, workspace, routeBinding } = await fixture();
  const otherHome = join(root, "other-home");
  const foreignCodexHome = join(otherHome, "providers", "codex", "codex-abcdef0123456789abcdef0123456789");
  await mkdir(foreignCodexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(foreignCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  try {
    const mismatchedRoute = {
      ...routeBinding,
      codexHomeRealpath: await realpath(foreignCodexHome),
    };
    await assert.rejects(
      prepareCodexExecution({
        appHome,
        workspace,
        approvals: new ApprovalManager("ask"),
        journal: new ChangeJournal({ appHome, chatId: "chat-foreign-profile" }),
        routeGate: routeGate(mismatchedRoute),
        routeBinding: mismatchedRoute,
      }),
      /profile|codex home|app home/i,
    );
    await assert.rejects(
      prepareCodexExecution({
        appHome,
        workspace,
        approvals: new ApprovalManager("ask"),
        journal: new ChangeJournal({ appHome: otherHome, chatId: "chat-foreign-journal" }),
        routeGate: routeGate(routeBinding),
        routeBinding,
      }),
      /journal|app home/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
