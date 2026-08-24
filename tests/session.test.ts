import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { evaluateBudget } from "../src/config.js";
import {
  chatLockPath,
  dayKey,
  exportSessionMarkdown,
  type PersistedSessionData,
  rankChatMatches,
  redactSensitive,
  SessionStore,
  workspaceSpend,
} from "../src/session.js";
import {
  CHAT_ARTIFACT_REGISTRY,
  migrationManifestPath,
  workspaceStorageHash,
} from "../src/storage.js";
import type { ChatSummary, SessionData } from "../src/types.js";
import type { RouteIdentityV1 } from "../src/backends.js";
import type { ProviderConnectionStateV1 } from "../src/provider-state.js";

async function workspaceRoot(prefix: string): Promise<{
  workspace: string;
  appHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `routercode-${prefix}-`));
  return { workspace: join(root, "project"), appHome: join(root, ".routercode") };
}

function legacyPathFor(appHome: string, workspace: string): string {
  const workspaceId = createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 16);
  return join(appHome, "sessions", `${workspaceId}.json`);
}

async function writeLegacySession(
  appHome: string,
  workspace: string,
): Promise<string> {
  const legacyPath = legacyPathFor(appHome, workspace);
  await mkdir(join(appHome, "sessions"), { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({
      version: 1,
      workspace,
      summary: "",
      turns: [
        {
          role: "user",
          content: "Alter Verlauf",
          createdAt: "2026-07-24T08:00:00.000Z",
        },
      ],
      costs: {
        mainUsd: 0.1,
        compressorUsd: 0.02,
        totalUsd: 0.12,
      },
      updatedAt: "2026-07-24T08:00:00.000Z",
    }),
  );
  return legacyPath;
}

test("SessionStore.remove löscht einen Chat endgültig und bleibt bei Wiederholung idempotent", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-delete");

  const keep = SessionStore.create(workspace, appHome, "Bleibt");
  await keep.save();
  const gone = SessionStore.create(workspace, appHome, "Weg damit");
  await gone.save();
  assert.equal((await SessionStore.list(workspace, appHome)).length, 2);

  await SessionStore.remove(workspace, gone.data.id, appHome);
  const remaining = await SessionStore.list(workspace, appHome);
  assert.deepEqual(remaining.map((chat) => chat.id), [keep.data.id]);
  await assert.rejects(
    SessionStore.openById(workspace, gone.data.id, appHome),
    /nicht gefunden/,
  );
  await assert.doesNotReject(SessionStore.remove(workspace, gone.data.id, appHome));
});

test("chat deletion removes every registry-owned artifact and mapped legacy sidecar but retains config backups", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-owned-delete");
  const chat = SessionStore.create(workspace, appHome, "Alles weg");
  await chat.save();
  const chatId = chat.data.id;
  const workspaceHash = workspaceStorageHash(workspace);
  const conflictId = "conflict-1";
  const localPaths = [
    chat.path,
    CHAT_ARTIFACT_REGISTRY.resolve("chat-conflict", { appHome, workspace, chatId, conflictId }),
    CHAT_ARTIFACT_REGISTRY.resolve("conversation-state", { appHome, workspace, chatId }),
    CHAT_ARTIFACT_REGISTRY.resolve("conversation-conflict", { appHome, workspace, chatId, conflictId }),
    CHAT_ARTIFACT_REGISTRY.resolve("lock", { appHome, workspace, chatId, artifactId: "chat" }),
    CHAT_ARTIFACT_REGISTRY.resolve("lock", { appHome, workspace, chatId, artifactId: "conversation-state" }),
    CHAT_ARTIFACT_REGISTRY.resolve("run-log", { appHome, chatId, artifactId: "run-1" }),
    CHAT_ARTIFACT_REGISTRY.resolve("checkpoint", { appHome, chatId, artifactId: "run-1" }),
    CHAT_ARTIFACT_REGISTRY.resolve("task-sidecar", { appHome, chatId, artifactId: "task-1" }),
  ];
  for (const path of localPaths.slice(1)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "owned");
  }

  const oldId = "legacy-chat-id";
  const checksum = "a".repeat(64);
  const managedBackup = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const legacyPaths = [
    CHAT_ARTIFACT_REGISTRY.resolve("chat", { appHome: managedBackup, workspaceHash, chatId: oldId }),
    CHAT_ARTIFACT_REGISTRY.resolve("conversation-state", { appHome: managedBackup, workspaceHash, chatId: oldId }),
    CHAT_ARTIFACT_REGISTRY.resolve("run-log", { appHome: managedBackup, chatId: oldId, artifactId: "run-legacy" }),
    CHAT_ARTIFACT_REGISTRY.resolve("checkpoint", { appHome: managedBackup, chatId: oldId, artifactId: "run-legacy" }),
    CHAT_ARTIFACT_REGISTRY.resolve("task-sidecar", { appHome: managedBackup, chatId: oldId, artifactId: "task-legacy" }),
  ];
  for (const path of legacyPaths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "legacy-owned");
  }
  await mkdir(dirname(migrationManifestPath(appHome)), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(dirname(appHome), ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath: managedBackup,
    chatIdMap: { [oldId]: chatId },
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
  }));
  const configBackup = join(appHome, "migration-backups", "config-v0-retained.json");
  await writeFile(configBackup, "non-chat-config-backup");

  const first = await SessionStore.remove(workspace, chatId, appHome);
  const second = await SessionStore.remove(workspace, chatId, appHome);

  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  for (const path of [...localPaths, ...legacyPaths]) {
    await assert.rejects(stat(path), /ENOENT/, `${path} must be deleted`);
  }
  await assert.rejects(stat(managedBackup), /ENOENT/, "empty managed legacy backup must be removed");
  assert.equal(await readFile(configBackup, "utf8"), "non-chat-config-backup");
});

test("chat deletion removes the genuine mapped v1 sessions entry before its canonical transcript", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-delete-v1-backup");
  const chat = SessionStore.create(workspace, appHome, "Aus v1 migriert");
  await chat.save();
  const checksum = "e".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const legacySession = await writeLegacySession(backupPath, workspace);
  const workspaceHash = workspaceStorageHash(workspace);
  await mkdir(dirname(migrationManifestPath(appHome)), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(dirname(appHome), ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: { [`legacy-${workspaceHash}`]: chat.data.id },
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-22T11:59:00.000Z",
    completedAt: "2026-08-22T12:00:00.000Z",
  }));

  const deletion = await SessionStore.remove(workspace, chat.data.id, appHome);

  assert.deepEqual(deletion.errors, []);
  await assert.rejects(readFile(legacySession, "utf8"), /ENOENT/);
  await assert.rejects(readFile(chat.path, "utf8"), /ENOENT/);
  await assert.rejects(stat(backupPath), /ENOENT/, "the emptied managed backup is removed before completion");
});

test("chat deletion keeps the transcript retryable when a sidecar cannot be removed", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-delete-retry");
  const chat = SessionStore.create(workspace, appHome, "Retry");
  await chat.save();
  const outside = join(dirname(appHome), "outside-owned-by-user.txt");
  await writeFile(outside, "outside");
  const trappedSidecar = CHAT_ARTIFACT_REGISTRY.resolve("task-sidecar", {
    appHome,
    chatId: chat.data.id,
    artifactId: "trapped",
  });
  await mkdir(dirname(trappedSidecar), { recursive: true });
  await symlink(outside, trappedSidecar);

  const partial = await SessionStore.remove(workspace, chat.data.id, appHome);

  assert.equal(partial.errors.length, 1);
  assert.match(await readFile(chat.path, "utf8"), /Retry/, "transcript remains until sidecars are clear");
  assert.equal(await readFile(outside, "utf8"), "outside", "root-scoped deletion never follows the sidecar symlink");

  await rm(trappedSidecar);
  const retried = await SessionStore.remove(workspace, chat.data.id, appHome);
  assert.deepEqual(retried.errors, []);
  await assert.rejects(readFile(chat.path, "utf8"), /ENOENT/);
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("a mapped legacy transcript failure cannot remove the canonical retry anchor", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-delete-legacy-retry");
  const chat = SessionStore.create(workspace, appHome, "Legacy Retry");
  await chat.save();
  const oldId = "legacy-retry-chat";
  const checksum = "c".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const legacyChat = CHAT_ARTIFACT_REGISTRY.resolve("chat", {
    appHome: backupPath,
    workspaceHash: workspaceStorageHash(workspace),
    chatId: oldId,
  });
  const outside = join(dirname(appHome), "legacy-transcript-outside.txt");
  await writeFile(outside, "outside");
  await mkdir(dirname(legacyChat), { recursive: true });
  await symlink(outside, legacyChat);
  await mkdir(dirname(migrationManifestPath(appHome)), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(dirname(appHome), ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: { [oldId]: chat.data.id },
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
  }));

  const partial = await SessionStore.remove(workspace, chat.data.id, appHome);

  assert.equal(partial.errors.length, 1);
  assert.match(await readFile(chat.path, "utf8"), /Legacy Retry/);
  assert.equal(await readFile(outside, "utf8"), "outside");

  await rm(legacyChat);
  const retried = await SessionStore.remove(workspace, chat.data.id, appHome);
  assert.deepEqual(retried.errors, []);
  await assert.rejects(readFile(chat.path, "utf8"), /ENOENT/);
});

test("mapped legacy deletion trusts only a validated completed manifest and preserves non-chat files", async () => {
  const { workspace, appHome } = await workspaceRoot("chat-delete-manifest");
  const chat = SessionStore.create(workspace, appHome, "Manifest");
  await chat.save();
  const oldId = "old-manifest-chat";
  const checksum = "b".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const oldChat = CHAT_ARTIFACT_REGISTRY.resolve("chat", {
    appHome: backupPath,
    workspaceHash: workspaceStorageHash(workspace),
    chatId: oldId,
  });
  await mkdir(dirname(oldChat), { recursive: true });
  await writeFile(oldChat, "legacy-chat");
  await writeFile(join(backupPath, "config.json"), "legacy-config");
  await writeFile(join(backupPath, "permissions.json"), "legacy-rules");
  await mkdir(dirname(migrationManifestPath(appHome)), { recursive: true });
  const manifest = {
    version: 1,
    phase: "complete",
    sourcePath: join(dirname(appHome), ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: { [oldId]: chat.data.id },
    destinationPaths: [],
    isolated: [],
    complete: false,
    startedAt: "2026-08-20T00:00:00.000Z",
  };
  await writeFile(migrationManifestPath(appHome), JSON.stringify(manifest));

  await SessionStore.remove(workspace, chat.data.id, appHome);
  assert.equal(await readFile(oldChat, "utf8"), "legacy-chat", "incomplete manifest maps are ignored");

  manifest.complete = true;
  await writeFile(migrationManifestPath(appHome), JSON.stringify(manifest));
  await SessionStore.remove(workspace, chat.data.id, appHome);
  await assert.rejects(readFile(oldChat, "utf8"), /ENOENT/);
  assert.equal(await readFile(join(backupPath, "config.json"), "utf8"), "legacy-config");
  assert.equal(await readFile(join(backupPath, "permissions.json"), "utf8"), "legacy-rules");
  assert.ok((await stat(backupPath)).isDirectory(), "non-chat backup content keeps the managed backup");
});

test("SessionStore resolves its redacted transcript path through the central artifact registry", async () => {
  const { workspace, appHome } = await workspaceRoot("registry-path");
  const { CHAT_ARTIFACT_REGISTRY } = await import("../src/storage.js");
  const store = SessionStore.create(workspace, appHome, "Registry");

  assert.equal(
    store.path,
    CHAT_ARTIFACT_REGISTRY.resolve("chat", {
      appHome,
      workspace,
      chatId: store.data.id,
    }),
  );
  assert.equal(CHAT_ARTIFACT_REGISTRY.get("chat").privacy, "redacted");
});

test("workspace can contain multiple independently persisted chats", async () => {
  const { workspace, appHome } = await workspaceRoot("chats");

  const first = SessionStore.create(workspace, appHome);
  first.addTurn("user", "Parser reparieren");
  first.addTurn("assistant", "Ich prüfe den Parser.");
  first.addCost("main", 0.25);
  first.setPreferences("moonshotai/kimi-k3", {
    mode: "effort",
    effort: "high",
  });
  await first.save();

  const second = SessionStore.create(workspace, appHome, "Tests");
  second.addTurn("user", "Tests ausführen");
  await second.save();

  const chats = await SessionStore.list(workspace, appHome);
  assert.equal(chats.length, 2);
  assert.deepEqual(
    new Set(chats.map((chat) => chat.title)),
    new Set(["Parser reparieren", "Tests"]),
  );

  const reopened = await SessionStore.openById(workspace, first.data.id, appHome);
  assert.equal(reopened.data.turns.length, 2);
  assert.equal(reopened.data.costs.totalUsd, 0.25);
  assert.equal(reopened.data.model, "moonshotai/kimi-k3");
  assert.deepEqual(reopened.data.reasoning, {
    mode: "effort",
    effort: "high",
  });
});

test("clearRouteIfExact durably removes only one complete exact route and rejects mismatches or invalid identities", async (t) => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_kimi_clear_exact",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-clear-route-exact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const store = SessionStore.create(workspace, appHome, "Exact route");
  store.addTurn("user", "unverändert");
  store.addCost("main", 1.25);
  store.setPreferences("k3", { mode: "effort", effort: "high" }, route);
  await store.save();
  const before = structuredClone(store.data);

  assert.equal(await store.clearRouteIfExact({ ...route, accountFingerprint: "acct_kimi_foreign" }), false);
  assert.deepEqual(store.data, before);
  assert.equal(await store.clearRouteIfExact({ ...route, version: 2 } as never), false);
  assert.deepEqual(store.data, before);
  assert.equal(await store.clearRouteIfExact(route), true);
  assert.equal(store.data.route, undefined);
  assert.deepEqual(
    { ...store.data, route: before.route, revision: before.revision },
    { ...before },
    "model, reasoning, turns, costs, timestamps, and every non-route field stay byte-exact",
  );
  assert.equal(store.data.revision, before.revision + 1);
  assert.equal((await SessionStore.openById(workspace, store.data.id, appHome)).data.route, undefined);
  assert.equal(await store.clearRouteIfExact(route), false);

  const legacy = SessionStore.create(workspace, appHome, "Legacy route");
  legacy.setPreferences("k3", { mode: "auto" }, {
    ...route,
    resolutionState: "legacy-unverified",
    canonicalModelId: null,
  });
  const legacyBefore = structuredClone(legacy.data);
  assert.equal(await legacy.clearRouteIfExact(route), false);
  assert.deepEqual(legacy.data, legacyBefore);
});

test("clearRouteIfExact preserves and adopts a concurrently persisted foreign route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-clear-route-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const kimiRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_kimi_clear_race",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
  };
  const openRouterRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_openrouter_clear_race",
    billingRealm: "openrouter-payg",
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
    resolutionState: "resolved",
  };
  const seed = SessionStore.create(workspace, appHome, "Concurrent route");
  seed.setPreferences("k3", { mode: "auto" }, kimiRoute);
  await seed.save();
  const staleLifecycleOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  const concurrentOwner = await SessionStore.openById(workspace, seed.data.id, appHome);
  concurrentOwner.setPreferences("openrouter/auto", { mode: "auto" }, openRouterRoute);
  await concurrentOwner.save();

  assert.equal(await staleLifecycleOwner.clearRouteIfExact(kimiRoute), false);
  assert.deepEqual(staleLifecycleOwner.data.route, openRouterRoute);
  assert.deepEqual(
    (await SessionStore.openById(workspace, seed.data.id, appHome)).data.route,
    openRouterRoute,
  );
});

test("a secret-bearing workspace remains listable and reopenable after save", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-workspace-identity-"));
  const secret = `${["sk", "or", "v1"].join("-")}-${"i".repeat(40)}`;
  const workspace = join(root, `project-${secret}`);
  const appHome = join(root, ".routercode");
  const store = SessionStore.create(workspace, appHome, "Workspace identity");
  store.addTurn("user", "remember me");
  await store.save();

  const listed = await SessionStore.list(workspace, appHome);
  assert.deepEqual(listed.map((chat) => chat.id), [store.data.id]);
  assert.equal(listed[0]!.workspace, workspace);

  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.workspace, workspace);
  assert.equal(reopened.data.turns[0]!.content, "remember me");

  const resumed = await SessionStore.open(workspace, appHome);
  assert.equal(resumed.data.id, store.data.id);
  assert.equal(resumed.data.workspace, workspace);
});

test("fork copies context but starts a separate cost ledger", async () => {
  const { workspace, appHome } = await workspaceRoot("fork");
  const source = SessionStore.create(workspace, appHome, "Original");
  source.addTurn("user", "Baue die Funktion");
  source.addTurn("assistant", "Ich beginne.");
  source.addCost("main", 0.5);
  await source.save();

  const fork = await source.fork("Alternative");
  assert.notEqual(fork.data.id, source.data.id);
  assert.equal(fork.data.title, "Alternative");
  assert.deepEqual(fork.data.turns, source.data.turns);
  assert.equal(fork.data.costs.totalUsd, 0);
});

test("legacy workspace session migrates once and marks the source", async () => {
  const { workspace, appHome } = await workspaceRoot("legacy");
  const legacyPath = await writeLegacySession(appHome, workspace);

  const migrated = await SessionStore.open(workspace, appHome);
  assert.equal(migrated.data.version, 2);
  assert.equal(migrated.data.title, "Alter Verlauf");
  assert.ok(Math.abs(migrated.data.costs.totalUsd - 0.12) < 1e-9);
  assert.equal((await SessionStore.list(workspace, appHome)).length, 1);

  // The v1 content is preserved, but only under the marker name.
  await assert.rejects(readFile(legacyPath, "utf8"), /ENOENT/);
  assert.match(await readFile(`${legacyPath}.migrated`, "utf8"), /"version":1/);
});

test("list and search never migrate or write to disk", async () => {
  const { workspace, appHome } = await workspaceRoot("readonly");
  const legacyPath = await writeLegacySession(appHome, workspace);

  assert.deepEqual(await SessionStore.list(workspace, appHome), []);
  assert.deepEqual(await SessionStore.search(workspace, "Alter", appHome), []);

  // No chat directory, no marker, no touched legacy file.
  await assert.rejects(readdir(join(appHome, "chats")), /ENOENT/);
  await assert.rejects(stat(`${legacyPath}.migrated`), /ENOENT/);
  assert.match(await readFile(legacyPath, "utf8"), /"version":1/);
});

test("a deleted legacy chat is not resurrected by the next start", async () => {
  const { workspace, appHome } = await workspaceRoot("deleted");
  await writeLegacySession(appHome, workspace);

  const migrated = await SessionStore.open(workspace, appHome);
  await rm(migrated.path);

  assert.deepEqual(await SessionStore.list(workspace, appHome), []);
  const fresh = await SessionStore.open(workspace, appHome);
  assert.equal(fresh.data.turns.length, 0);
  assert.notEqual(fresh.data.id, migrated.data.id);
  assert.equal((await SessionStore.list(workspace, appHome)).length, 0);
});

test("two instances on the same chat merge instead of overwriting", async () => {
  const { workspace, appHome } = await workspaceRoot("parallel");

  const windowA = SessionStore.create(workspace, appHome, "Gemeinsam");
  windowA.addTurn("user", "erste Frage");
  windowA.addCost("main", 0.1);
  await windowA.save();

  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  windowB.addTurn("user", "zweite Frage aus Fenster B");
  windowB.addCost("main", 0.05);
  const outcomeB = await windowB.save();
  assert.equal(outcomeB.merged, false);

  // Window A still holds the old state and must not wipe B's turn.
  windowA.addTurn("assistant", "Antwort aus Fenster A");
  windowA.addCost("main", 0.2);
  const outcomeA = await windowA.save();
  assert.equal(outcomeA.merged, true);
  assert.equal(outcomeA.conflictBackupPath, null);

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.deepEqual(
    new Set(reopened.data.turns.map((turn) => turn.content)),
    new Set(["erste Frage", "zweite Frage aus Fenster B", "Antwort aus Fenster A"]),
  );
  assert.ok(Math.abs(reopened.data.costs.totalUsd - 0.35) < 1e-9);
  assert.ok(reopened.data.revision >= 3);
});

test("stale unchanged session adopts a foreign save without rewriting bytes or revision", async () => {
  const { workspace, appHome } = await workspaceRoot("stale-unchanged-noop");
  const initial = SessionStore.create(workspace, appHome, "Shared base");
  initial.addTurn("user", "initial turn");
  await initial.save();

  const windowA = await SessionStore.openById(workspace, initial.data.id, appHome);
  const windowB = await SessionStore.openById(workspace, initial.data.id, appHome);
  windowB.rename("Foreign title");
  windowB.addTurn("assistant", "foreign turn");
  const outcomeB = await windowB.save();
  const foreignBytes = await readFile(windowB.path, "utf8");
  const foreignState = structuredClone(windowB.data);

  const outcomeA = await windowA.save();

  assert.equal(await readFile(windowA.path, "utf8"), foreignBytes);
  assert.equal(outcomeA.revision, outcomeB.revision);
  assert.deepEqual(windowA.data, foreignState);
  assert.equal(windowA.data.revision, foreignState.revision);
});

test("concurrent merge distinguishes redaction projection from a local edit", async () => {
  const { workspace, appHome } = await workspaceRoot("redacted-merge");
  const secret = `${["sk", "or", "v1"].join("-")}-${"m".repeat(40)}`;
  const windowA = SessionStore.create(workspace, appHome, `Original ${secret}`);
  windowA.setSummary(`Live summary ${secret}`);
  windowA.addTurn("user", `Initial ${secret}`);
  await windowA.save();

  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  const initialTurnAt = Date.parse(windowA.data.turns[0]!.createdAt);
  windowB.rename("Remote rename");
  windowB.addTurn("assistant", "Remote turn");
  windowB.data.turns.at(-1)!.createdAt = new Date(initialTurnAt + 1).toISOString();
  await windowB.save();

  windowA.addTurn("assistant", "Local turn");
  windowA.data.turns.at(-1)!.createdAt = new Date(initialTurnAt + 2).toISOString();
  const outcome = await windowA.save();
  assert.equal(outcome.merged, true);
  assert.ok(windowA.data.summary.includes(secret));

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.equal(reopened.data.title, "Remote rename");
  assert.deepEqual(
    reopened.data.turns.map((turn) => turn.content),
    [
      "Initial [REDACTED_OPENROUTER_KEY]",
      "Remote turn",
      "Local turn",
    ],
  );
});

test("concurrent merge preserves an exact live scalar edit within one redaction category", async () => {
  const { workspace, appHome } = await workspaceRoot("redacted-scalar-merge");
  const secretA = `${["sk", "or", "v1"].join("-")}-${"a".repeat(40)}`;
  const secretB = `${["sk", "or", "v1"].join("-")}-${"b".repeat(40)}`;
  const windowA = SessionStore.create(workspace, appHome, "Original title");
  windowA.setSummary(secretA);
  await windowA.save();

  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  windowB.setSummary("Remote public summary");
  windowB.rename("Remote rename");
  await windowB.save();

  const unchangedTimestamp = windowA.data.updatedAt;
  windowA.setSummary(secretB);
  (windowA.data as PersistedSessionData).updatedAt = unchangedTimestamp;
  const outcome = await windowA.save();
  assert.equal(outcome.merged, true);
  assert.equal(windowA.data.summary, secretB);
  assert.equal(windowA.data.title, "Remote rename");

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.equal(reopened.data.summary, "[REDACTED_OPENROUTER_KEY]");
  assert.equal(reopened.data.title, "Remote rename");
});

test("concurrent same-projection turns survive beyond the projected base multiplicity", async () => {
  const { workspace, appHome } = await workspaceRoot("redacted-turn-merge");
  const secretA = `${["sk", "or", "v1"].join("-")}-${"c".repeat(40)}`;
  const secretB = `${["sk", "or", "v1"].join("-")}-${"d".repeat(40)}`;
  const timestamp = "2026-08-22T09:00:00.000Z";
  const windowA = SessionStore.create(workspace, appHome, "Concurrent turns");
  await windowA.save();
  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );

  windowA.addTurn("user", secretA);
  windowA.data.turns[0]!.createdAt = timestamp;
  windowB.addTurn("user", secretB);
  windowB.data.turns[0]!.createdAt = timestamp;
  await windowB.save();
  await windowA.save();

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.deepEqual(
    reopened.data.turns.map((turn) => turn.content),
    [
      "[REDACTED_OPENROUTER_KEY]",
      "[REDACTED_OPENROUTER_KEY]",
    ],
  );
});

test("concurrent same-projection tool calls survive beyond the projected base multiplicity", async () => {
  const { workspace, appHome } = await workspaceRoot("redacted-tool-merge");
  const secretA = `${["sk", "or", "v1"].join("-")}-${"e".repeat(40)}`;
  const secretB = `${["sk", "or", "v1"].join("-")}-${"f".repeat(40)}`;
  const timestamp = "2026-08-22T09:30:00.000Z";
  const windowA = SessionStore.create(workspace, appHome, "Concurrent tools");
  await windowA.save();
  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );

  const callA = windowA.recordToolCall("run_command", secretA);
  callA.at = timestamp;
  const callB = windowB.recordToolCall("run_command", secretB);
  callB.at = timestamp;
  await windowB.save();
  await windowA.save();

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.deepEqual(
    reopened.data.toolCalls.map((call) => call.summary),
    [
      "[REDACTED_OPENROUTER_KEY]",
      "[REDACTED_OPENROUTER_KEY]",
    ],
  );
});

test("simultaneous saves of the same chat lose nothing", async () => {
  const { workspace, appHome } = await workspaceRoot("simultan");
  const windowA = SessionStore.create(workspace, appHome, "Gleichzeitig");
  await windowA.save();
  const windowB = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );

  windowA.addTurn("user", "aus A");
  windowA.addCost("main", 0.01);
  windowB.addTurn("user", "aus B");
  windowB.addCost("main", 0.02);
  const [resultA, resultB] = await Promise.all([windowA.save(), windowB.save()]);
  assert.ok(resultA.merged || resultB.merged);

  const reopened = await SessionStore.openById(
    workspace,
    windowA.data.id,
    appHome,
  );
  assert.deepEqual(
    new Set(reopened.data.turns.map((turn) => turn.content)),
    new Set(["aus A", "aus B"]),
  );
  assert.ok(Math.abs(reopened.data.costs.totalUsd - 0.03) < 1e-9);
  await assert.rejects(stat(chatLockPath(windowA.path)), /ENOENT/);
});

test("a stale lock from a dead process is cleaned up", async () => {
  const { workspace, appHome } = await workspaceRoot("lock");
  const store = SessionStore.create(workspace, appHome, "Lock");
  await store.save();
  const lockPath = chatLockPath(store.path);

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_000,
      startedAt: new Date().toISOString(),
      host: hostname(),
    }),
  );
  store.addTurn("user", "trotz totem Lock speichern");
  await store.save();
  await assert.rejects(stat(lockPath), /ENOENT/);

  // A lock older than the timeout is broken as well.
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 1,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      host: "irgendwo",
    }),
  );
  store.addTurn("user", "trotz altem Lock speichern");
  await store.save();
  await assert.rejects(stat(lockPath), /ENOENT/);

  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.turns.length, 2);
});

test("an unreadable chat file is preserved instead of overwritten", async () => {
  const { workspace, appHome } = await workspaceRoot("conflict");
  const store = SessionStore.create(workspace, appHome, "Konflikt");
  store.addTurn("user", "erste Frage");
  await store.save();

  await writeFile(store.path, "{ das ist kein JSON");
  await chmod(store.path, 0o644);
  store.addTurn("assistant", "zweite Antwort");
  const outcome = await store.save();

  assert.ok(outcome.conflictBackupPath);
  assert.match(
    await readFile(outcome.conflictBackupPath as string, "utf8"),
    /das ist kein JSON/,
  );
  const { CHAT_ARTIFACT_REGISTRY } = await import("../src/storage.js");
  assert.equal(CHAT_ARTIFACT_REGISTRY.get("chat-conflict").privacy, "exact");
  assert.ok(
    (await CHAT_ARTIFACT_REGISTRY.existing("chat-conflict", {
      appHome,
      workspace,
      chatId: store.data.id,
      chatFilePath: store.path,
    })).includes(outcome.conflictBackupPath as string),
  );
  assert.equal((await stat(outcome.conflictBackupPath as string)).mode & 0o777, 0o600);
  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.turns.length, 2);
});

test("checkpoints rewind the transcript but keep the spent costs", async () => {
  const { workspace, appHome } = await workspaceRoot("checkpoint");
  const store = SessionStore.create(workspace, appHome, "Checkpoints");
  store.addTurn("user", "Schritt eins");
  store.addTurn("assistant", "erledigt");
  const checkpoint = store.createCheckpoint("vor dem Refactor");
  store.addTurn("user", "Schritt zwei");
  store.addTurn("assistant", "leider falsch");
  store.recordToolCall("write_file", "src/kaputt.ts");
  store.addCost("main", 0.02);
  await store.save();

  assert.equal(store.listCheckpoints().length, 1);
  assert.equal(checkpoint.turnIndex, 2);

  const restored = store.restoreCheckpoint(checkpoint.id);
  assert.equal(restored.label, "vor dem Refactor");
  assert.equal(store.data.turns.length, 2);
  assert.equal(store.data.turns.at(-1)?.content, "erledigt");
  assert.equal(store.data.costs.totalUsd, 0.02);
  await store.save();

  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.turns.length, 2);
  assert.equal(reopened.data.toolCalls.length, 0);
  assert.throws(
    () => reopened.restoreCheckpoint("gibt-es-nicht"),
    /Checkpoint nicht gefunden/,
  );
});

test("workspace spend answers the budget question and survives /clear", async () => {
  const { workspace, appHome } = await workspaceRoot("budget");
  const first = SessionStore.create(workspace, appHome, "Erster");
  first.addCost("main", 0.25);
  await first.save();
  const second = SessionStore.create(workspace, appHome, "Zweiter");
  second.addCost("compressor", 0.1);
  await second.save();

  const spend = await workspaceSpend(workspace, appHome);
  assert.equal(spend.day, dayKey());
  assert.equal(spend.chatCount, 2);
  assert.ok(Math.abs(spend.dayUsd - 0.35) < 1e-9);
  assert.ok(Math.abs(spend.totalUsd - 0.35) < 1e-9);

  const verdict = evaluateBudget(
    { dailyLimitUsd: 0.3, totalLimitUsd: null, onExceed: "block" },
    spend,
  );
  assert.equal(verdict.exceeded, true);
  assert.equal(verdict.scope, "daily");
  assert.equal(verdict.action, "block");
  assert.match(verdict.message ?? "", /Tagesbudget/);

  // Clearing a chat resets its ledger but must not erase today's spend.
  first.clear();
  await first.save();
  const afterClear = await workspaceSpend(workspace, appHome);
  assert.ok(Math.abs(afterClear.dayUsd - 0.35) < 1e-9);
  assert.ok(Math.abs(afterClear.totalUsd - 0.1) < 1e-9);
});

test("unknown provider-managed model cost persists without entering USD accumulation or free formatting", async () => {
  const { workspace, appHome } = await workspaceRoot("unknown-cost");
  const store = SessionStore.create(workspace, appHome, "Kimi unknown cost");
  store.addCost("main", 999, "unknown");
  assert.equal(store.data.costs.costKnowledge, "unknown");
  assert.equal(store.data.costs.mainUsd, 0);
  assert.equal(store.data.costs.totalUsd, 0);
  await store.save();

  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.costs.costKnowledge, "unknown");
  assert.equal(reopened.data.costs.totalUsd, 0);
  const [summary] = await SessionStore.list(workspace, appHome);
  assert.equal(summary?.costKnowledge, "unknown");
  assert.equal(summary?.costUsd, 0);
  const spend = await workspaceSpend(workspace, appHome);
  assert.equal(spend.costKnowledge, "unknown");
  assert.equal(spend.dayUsd, 0);
  assert.equal(spend.totalUsd, 0);

  const markdown = reopened.exportMarkdown();
  assert.match(markdown, /unbekannt|providerverwaltet/i);
  assert.doesNotMatch(markdown, /kostenlos|\$0(?:\.0+)?\b|0(?:,0+)?\s*\$/i);
});

test("legacy cost ledgers normalize to known numeric cost", () => {
  const markdown = exportSessionMarkdown({
    version: 2,
    id: "legacy-known-cost",
    title: "Legacy",
    workspace: "/tmp/legacy",
    summary: "",
    turns: [],
    costs: { mainUsd: 0.125, compressorUsd: 0, voiceUsd: 0, totalUsd: 0.125 },
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
  });
  assert.match(markdown, /\$0\.125/);
  assert.doesNotMatch(markdown, /providerverwaltet/i);
});

test("unknown cost knowledge is monotonic across concurrent merge, checkpoint restore, and export", async () => {
  const { workspace, appHome } = await workspaceRoot("unknown-cost-merge");
  const base = SessionStore.create(workspace, appHome, "Merged Kimi cost");
  base.addTurn("user", "start");
  await base.save();
  const kimiWindow = await SessionStore.openById(workspace, base.data.id, appHome);
  const knownWindow = await SessionStore.openById(workspace, base.data.id, appHome);

  kimiWindow.addCost("main", 0, "unknown");
  const checkpoint = kimiWindow.createCheckpoint("Kimi checkpoint");
  assert.equal(checkpoint.costKnowledge, "unknown");
  knownWindow.addCost("main", 0.25, "known");
  await knownWindow.save();
  await kimiWindow.save();

  const merged = await SessionStore.openById(workspace, base.data.id, appHome);
  assert.equal(merged.data.costs.costKnowledge, "unknown");
  assert.equal(merged.data.costs.totalUsd, 0.25, "known amounts remain numeric without resolving unknown spend");
  assert.equal(merged.listCheckpoints()[0]?.costKnowledge, "unknown");
  merged.restoreCheckpoint("Kimi checkpoint");
  assert.equal(merged.data.costs.costKnowledge, "unknown");
  const markdown = merged.exportMarkdown();
  assert.match(markdown, /Kimi checkpoint.*(?:providerverwaltet|unbekannt)/i);
  assert.match(markdown, /Kosten:.*(?:providerverwaltet|unbekannt)/i);
  assert.doesNotMatch(markdown, /Kimi checkpoint[^\n]*\$0(?:\.0+)?\b/i);
});

test("a persisted legacy ledger without costKnowledge reopens as known", async () => {
  const { workspace, appHome } = await workspaceRoot("legacy-cost-knowledge");
  const store = SessionStore.create(workspace, appHome, "Legacy known");
  store.addCost("main", 0.125);
  await store.save();
  const raw = JSON.parse(await readFile(store.path, "utf8")) as { costs: Record<string, unknown> };
  delete raw.costs.costKnowledge;
  await writeFile(store.path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const reopened = await SessionStore.openById(workspace, store.data.id, appHome);
  assert.equal(reopened.data.costs.costKnowledge, "known");
  assert.equal(reopened.data.costs.totalUsd, 0.125);
});

test("markdown export contains metadata, turns, tool calls and costs", async () => {
  const { workspace, appHome } = await workspaceRoot("export");
  const store = SessionStore.create(workspace, appHome, "Export-Test");
  store.setPreferences("anthropic/example", { mode: "effort", effort: "high" });
  store.addTurn("user", "Bitte die Tests reparieren");
  store.recordToolCall("run_command", "npm test");
  store.addTurn("assistant", "Alle Tests sind grün.");
  store.addCost("main", 0.125);
  store.createCheckpoint("nach den Tests");

  const markdown = store.exportMarkdown();
  assert.match(markdown, /^# Export-Test/);
  assert.match(markdown, /- Chat-ID: `.+`/);
  assert.match(markdown, /- Modell: anthropic\/example/);
  assert.match(markdown, /- Reasoning: Aufwand high/);
  // Same USD formatting as the rest of the UI (utils.formatUsd).
  assert.match(markdown, /- Kosten: gesamt \$0\.125/);
  assert.match(markdown, /## Checkpoints\n\n- \*\*nach den Tests\*\*/);
  assert.match(markdown, /### 1\. Du — /);
  assert.match(markdown, /Bitte die Tests reparieren/);
  assert.match(markdown, /### 2\. Assistent — /);
  assert.match(markdown, /Alle Tests sind grün\./);
  assert.match(markdown, /#### Werkzeugaufrufe\n\n- `run_command` — npm test/);
});

test("markdown export redacts secrets that reached the transcript", () => {
  const secret = `${["sk", "or", "v1"].join("-")}-${"a".repeat(32)}`;
  const githubToken = `${["ghp", ""].join("_")}${"b".repeat(30)}`;
  const markdown = exportSessionMarkdown({
    version: 2,
    id: "abcdefgh",
    title: "Geheim",
    workspace: "/tmp/x",
    summary: `Token ${githubToken}`,
    turns: [
      {
        role: "user",
        content: `Key: ${secret}`,
        createdAt: "2026-07-24T08:00:00.000Z",
      },
    ],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
  });
  assert.ok(!markdown.includes(secret));
  assert.ok(!markdown.includes(githubToken));
  assert.match(markdown, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(markdown, /\[REDACTED_GITHUB_TOKEN\]/);
});

test("markdown export redacts metadata, checkpoints, turns and tool summaries as a final boundary", () => {
  const secret = `${["sk", "or", "v1"].join("-")}-${"x".repeat(40)}`;
  const timestamp = "2026-08-22T08:00:00.000Z";
  const markdown = exportSessionMarkdown({
    version: 2,
    id: "chat-safe-id",
    title: `Titel ${secret}`,
    workspace: `/tmp/${secret}`,
    summary: `Zusammenfassung ${secret}`,
    turns: [{ role: "user", content: `Frage ${secret}`, createdAt: timestamp }],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model: `provider/${secret}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoints: [
      {
        id: "checkpoint-safe-id",
        label: `Checkpoint ${secret}`,
        turnIndex: 1,
        costUsd: 0,
        createdAt: timestamp,
      },
    ],
    toolCalls: [
      {
        name: "run_command",
        summary: `Ausgabe ${secret}`,
        turnIndex: 1,
        at: timestamp,
      },
    ],
  });

  assert.ok(!markdown.includes(secret));
  assert.ok(
    (markdown.match(/\[REDACTED_OPENROUTER_KEY\]/g) ?? []).length >= 7,
  );
});

test("save sanitizes a cloned payload while preserving live setter values", async () => {
  const { workspace, appHome } = await workspaceRoot("save-clone");
  const secret = `${["sk", "or", "v1"].join("-")}-${"y".repeat(40)}`;
  const store = SessionStore.create(workspace, appHome, `Titel ${secret}`);
  store.rename(`Umbenannt ${secret}`);
  store.setPreferences(`provider/${secret}`, { mode: "auto" });
  store.setSummary(`Zusammenfassung ${secret}`);
  store.addTurn("user", `Frage ${secret}`);
  store.createCheckpoint(`Marke ${secret}`);
  store.recordToolCall("run_command", `Ergebnis ${secret}`);

  assert.ok(store.data.title.includes(secret));
  assert.ok(store.data.summary.includes(secret));
  assert.ok(store.data.turns[0]!.content.includes(secret));
  assert.ok(store.data.checkpoints[0]!.label.includes(secret));
  assert.ok(store.data.toolCalls[0]!.summary.includes(secret));
  await store.save();

  const raw = await readFile(store.path, "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(store.data.title.includes(secret));
  assert.ok(store.data.summary.includes(secret));
  assert.ok(store.data.turns[0]!.content.includes(secret));
  assert.ok(store.data.checkpoints[0]!.label.includes(secret));
  assert.ok(store.data.toolCalls[0]!.summary.includes(secret));
});

test("save sanitizes normalized and direct legacy fields in the raw chat JSON", async () => {
  const { workspace, appHome } = await workspaceRoot("save-legacy-fields");
  const secret = `${["sk", "or", "v1"].join("-")}-${"w".repeat(40)}`;
  const timestamp = "2026-08-22T08:00:00.000Z";
  const path = join(appHome, "chats", "direct", "legacy-chat.json");
  const direct: SessionData & Partial<PersistedSessionData> = {
    version: 2,
    id: "legacy-chat",
    title: `Titel ${secret}`,
    workspace: `${workspace}/${secret}`,
    summary: `Zusammenfassung ${secret}`,
    turns: [
      { role: "assistant", content: `Antwort ${secret}`, createdAt: timestamp },
    ],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model: `provider/${secret}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoints: [
      {
        id: "checkpoint-direct",
        label: `Marke ${secret}`,
        turnIndex: 1,
        costUsd: 0,
        createdAt: timestamp,
      },
    ],
    toolCalls: [
      {
        name: `tool-${secret}`,
        summary: `Werkzeug ${secret}`,
        turnIndex: 1,
        at: timestamp,
      },
    ],
    dailySpendUsd: {},
    revision: 0,
  };
  const store = new SessionStore(appHome, path, direct);

  assert.ok(store.data.checkpoints[0]!.label.includes(secret));
  assert.ok(store.data.toolCalls[0]!.summary.includes(secret));
  await store.save();

  const raw = await readFile(path, "utf8");
  const saved = JSON.parse(raw) as PersistedSessionData;
  assert.ok(!raw.includes(secret));
  assert.match(saved.title, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.workspace, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.summary, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.turns[0]!.content, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.model ?? "", /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.checkpoints[0]!.label, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.toolCalls[0]!.name, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(saved.toolCalls[0]!.summary, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.ok(store.data.title.includes(secret));
  assert.ok(store.data.workspace.includes(secret));
  assert.ok(store.data.model?.includes(secret));
});

test("two historical chats derive one migrated route lazily and persist only on ordinary save", async () => {
  const { workspace, appHome } = await workspaceRoot("provider-route-lazy");
  const directory = join(appHome, "chats", workspaceStorageHash(workspace));
  await mkdir(directory, { recursive: true });
  const timestamp = "2026-08-23T08:00:00.000Z";
  const makeLegacyChat = (id: string, model: string, content: string) => ({
    version: 2,
    id,
    title: id,
    workspace,
    summary: "",
    turns: [{ role: "user", content, createdAt: timestamp }],
    costs: { mainUsd: 0.25, compressorUsd: 0.05, voiceUsd: 0.01, totalUsd: 0.31 },
    model,
    reasoning: { mode: "effort", effort: "high" },
    revision: 4,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: { "2026-08-23": 0.31 },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const firstId = "legacy-chat-one";
  const secondId = "legacy-chat-two";
  const firstPath = join(directory, `${firstId}.json`);
  const secondPath = join(directory, `${secondId}.json`);
  await writeFile(firstPath, `${JSON.stringify(makeLegacyChat(firstId, "vendor/a/b", "first"), null, 2)}\n`);
  await writeFile(secondPath, `${JSON.stringify(makeLegacyChat(secondId, "vendor/second", "second"), null, 2)}\n`);
  const firstOriginal = await readFile(firstPath, "utf8");
  const secondOriginal = await readFile(secondPath, "utf8");
  const connection: ProviderConnectionStateV1 = {
    id: "legacy-csprng-id",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_legacy_legacy-csprng-id",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };

  const listed = await SessionStore.list(workspace, appHome, connection);
  assert.deepEqual(new Set(listed.map((chat) => chat.route?.requestedModelId)), new Set(["vendor/a/b", "vendor/second"]));
  assert.equal(await readFile(firstPath, "utf8"), firstOriginal);
  assert.equal(await readFile(secondPath, "utf8"), secondOriginal);

  const first = await SessionStore.openById(workspace, firstId, appHome, connection);
  assert.deepEqual(first.data.route, {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_legacy_legacy-csprng-id",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/a/b",
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  });
  assert.equal(await readFile(firstPath, "utf8"), firstOriginal);
  assert.equal(await readFile(secondPath, "utf8"), secondOriginal);
  const turns = structuredClone(first.data.turns);
  const costs = structuredClone(first.data.costs);

  await first.save();
  const firstSaved = await readFile(firstPath, "utf8");
  const firstPersisted = JSON.parse(firstSaved) as SessionData;
  assert.deepEqual(firstPersisted.route, first.data.route);
  assert.deepEqual(firstPersisted.turns, turns);
  assert.deepEqual(firstPersisted.costs, costs);
  assert.equal(await readFile(secondPath, "utf8"), secondOriginal);

  const reopened = await SessionStore.openById(workspace, firstId, appHome, connection);
  assert.deepEqual(reopened.data.route, first.data.route);
  assert.equal(await readFile(firstPath, "utf8"), firstSaved);
  assert.equal(await readFile(secondPath, "utf8"), secondOriginal);
});

test("concurrent foreign save preserves both lazy historical route and foreign turn", async () => {
  const { workspace, appHome } = await workspaceRoot("provider-route-concurrent-turn");
  const directory = join(appHome, "chats", workspaceStorageHash(workspace));
  await mkdir(directory, { recursive: true });
  const id = "lazy-route-concurrent-turn";
  const timestamp = "2026-08-24T08:00:00.000Z";
  const path = join(directory, `${id}.json`);
  await writeFile(path, `${JSON.stringify({
    version: 2,
    id,
    title: "Lazy route concurrency",
    workspace,
    summary: "",
    turns: [{ role: "user", content: "historical turn", createdAt: timestamp }],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model: "synthetic/lazy-concurrent",
    revision: 4,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const connection: ProviderConnectionStateV1 = {
    id: "legacy-concurrent-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_legacy_concurrent_projection",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const expectedRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: connection.accountFingerprint,
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "synthetic/lazy-concurrent",
    canonicalModelId: null,
    resolutionState: "legacy-unverified" as const,
  };

  const lazyWindow = await SessionStore.openById(workspace, id, appHome, connection);
  const foreignWindow = await SessionStore.openById(workspace, id, appHome);
  assert.deepEqual(lazyWindow.data.route, expectedRoute);
  assert.equal(foreignWindow.data.route, undefined);
  foreignWindow.addTurn("assistant", "foreign turn");
  const foreignOutcome = await foreignWindow.save();

  const lazyOutcome = await lazyWindow.save();
  const persisted = await SessionStore.openById(workspace, id, appHome);
  assert.equal(lazyOutcome.merged, true);
  assert.equal(lazyOutcome.revision, foreignOutcome.revision + 1);
  assert.deepEqual(persisted.data.route, expectedRoute);
  assert.deepEqual(
    new Set(persisted.data.turns.map((turn) => turn.content)),
    new Set(["historical turn", "foreign turn"]),
  );
});

test("foreign persisted route is authoritative over a pending lazy projection without revision churn", async () => {
  const { workspace, appHome } = await workspaceRoot("provider-route-foreign-authority");
  const directory = join(appHome, "chats", workspaceStorageHash(workspace));
  await mkdir(directory, { recursive: true });
  const id = "lazy-route-foreign-authority";
  const timestamp = "2026-08-24T08:30:00.000Z";
  const path = join(directory, `${id}.json`);
  await writeFile(path, `${JSON.stringify({
    version: 2,
    id,
    title: "Foreign route authority",
    workspace,
    summary: "",
    turns: [],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model: "synthetic/lazy-authority",
    revision: 2,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const connection: ProviderConnectionStateV1 = {
    id: "legacy-authority-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_legacy_pending_authority",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const authoritativeRoute = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_or_foreign_verified_authority",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "synthetic/lazy-authority",
    canonicalModelId: "synthetic/lazy-authority",
    resolutionState: "resolved" as const,
  };

  const lazyWindow = await SessionStore.openById(workspace, id, appHome, connection);
  const foreignWindow = await SessionStore.openById(workspace, id, appHome);
  foreignWindow.setPreferences(
    "synthetic/lazy-authority",
    { mode: "effort", effort: "medium" },
    authoritativeRoute,
  );
  const foreignOutcome = await foreignWindow.save();
  const foreignBytes = await readFile(path, "utf8");

  const lazyOutcome = await lazyWindow.save();
  assert.equal(lazyOutcome.merged, false);
  assert.equal(lazyOutcome.revision, foreignOutcome.revision);
  assert.equal(await readFile(path, "utf8"), foreignBytes);
  assert.deepEqual(lazyWindow.data.route, authoritativeRoute);
});

test("summaries are redacted before they are persisted", async () => {
  const { workspace, appHome } = await workspaceRoot("summary");
  const store = SessionStore.create(workspace, appHome, "Zusammenfassung");
  const token = `${["ghp", ""].join("_")}${"c".repeat(30)}`;
  store.setSummary(`Der Nutzer nannte ${token}.`);
  await store.save();

  const raw = await readFile(store.path, "utf8");
  assert.ok(!raw.includes(token));
  assert.match(raw, /\[REDACTED_GITHUB_TOKEN\]/);
});

test("redactSensitive covers the common secret formats", () => {
  const openRouterKey = `${["sk", "or", "v1"].join("-")}-${"a".repeat(32)}`;
  const awsAccessKey = `${["A", "K", "I", "A"].join("")}${"D".repeat(16)}`;
  const anthropicKey = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const genericKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz01"].join("-");
  const githubToken = (kind: string): string => `${kind}_${"abcdefghijklmnopqrstuvwxyz0123"}`;
  const githubPat = `${["github", "pat"].join("_")}_11ABCDEFG0abcdefghijklmnopqrstuvwxyz`;
  const awsSecretName = ["aws", "secret", "access", "key"].join("_");
  const awsSecretBody = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const googleKey = `${["AI", "za"].join("")}SyA1234567890abcdefghijklmnopqrstuv`;
  const slackToken = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
  const bearerToken = "abcdef1234567890abcdef";
  const bearerValue = `Authorization: ${["Bear", "er"].join("")} ${bearerToken}`;
  const jwtPayload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    jwtPayload,
    "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join(".");
  const privateKey = [
    ["-----BEGIN OPENSSH PRIVATE", "KEY-----"].join(" "),
    "b3BlbnNzaC1rZXktdjEA",
    ["-----END OPENSSH PRIVATE", "KEY-----"].join(" "),
  ].join("\n");
  // [Klartext, erwartete Markierung, Teilstück, das verschwinden muss]
  const cases: [string, RegExp, string][] = [
    [
      openRouterKey,
      /\[REDACTED_OPENROUTER_KEY\]/,
      "abcdefghijklmnop",
    ],
    [
      anthropicKey,
      /\[REDACTED_ANTHROPIC_KEY\]/,
      "api03-abcdefghij",
    ],
    [
      genericKey,
      /\[REDACTED_API_KEY\]/,
      "proj-abcdefghijk",
    ],
    [githubToken("ghp"), /\[REDACTED_GITHUB_TOKEN\]/, "ghp_abcdefghij"],
    [githubToken("gho"), /\[REDACTED_GITHUB_TOKEN\]/, "gho_abcdefghij"],
    [githubToken("ghs"), /\[REDACTED_GITHUB_TOKEN\]/, "ghs_abcdefghij"],
    [
      githubPat,
      /\[REDACTED_GITHUB_TOKEN\]/,
      "11ABCDEFG0abcdef",
    ],
    [awsAccessKey, /\[REDACTED_AWS_KEY_ID\]/, awsAccessKey],
    [
      `${awsSecretName} = "${awsSecretBody}"`,
      /\[REDACTED_AWS_SECRET\]/,
      "wJalrXUtnFEMI",
    ],
    [
      googleKey,
      /\[REDACTED_GOOGLE_KEY\]/,
      "AIzaSyA1234567890",
    ],
    [
      slackToken,
      /\[REDACTED_SLACK_TOKEN\]/,
      slackToken.slice(0, 17),
    ],
    [
      bearerValue,
      /Bearer \[REDACTED_TOKEN\]/,
      "abcdef1234567890",
    ],
    [
      jwt,
      /\[REDACTED_JWT\]/,
      jwtPayload.slice(0, 16),
    ],
    [
      privateKey,
      /\[REDACTED_PRIVATE_KEY\]/,
      "b3BlbnNzaC1rZXktdjEA",
    ],
  ];

  for (const [input, expected, secret] of cases) {
    const redacted = redactSensitive(input);
    assert.match(redacted, expected, `nicht erkannt: ${input}`);
    assert.ok(
      !redacted.includes(secret),
      `Klartext blieb stehen (${secret}): ${redacted}`,
    );
  }
});

test("redactSensitive leaves harmless text intact", () => {
  const harmless = [
    "sk-test",
    "Das Skript skip-lint.sh läuft.",
    "Bearer token",
    "Bearer of bad news",
    "ghp_kurz",
    `${["A", "K", "I", "A"].join("")}small`,
    "AIzaKurz",
    "xoxb-kurz",
    "Wir nutzen -----BEGIN als Trennzeichen.",
    "https://openrouter.ai/api/v1/chat/completions",
    "eyJhbGciOiJIUzI1NiJ9 ohne Punkte",
    "Der Commit 1234567890abcdef1234567890abcdef12345678 ist grün.",
  ];
  for (const value of harmless) {
    assert.equal(redactSensitive(value), value, `zerstört: ${value}`);
  }
});

function summary(
  partial: Partial<ChatSummary> & Pick<ChatSummary, "id" | "title">,
): ChatSummary {
  return {
    workspace: "/tmp/workspace",
    turnCount: 0,
    costUsd: 0,
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
    ...partial,
  };
}

test("rankChatMatches returns nothing for blank queries", () => {
  const chats = [summary({ id: "abc123", title: "Parser" })];
  assert.deepEqual(rankChatMatches(chats, ""), []);
  assert.deepEqual(rankChatMatches(chats, "   "), []);
});

test("rankChatMatches orders by match quality and is case-insensitive", () => {
  const chats = [
    summary({ id: "x1", title: "Refactor parser core" }),
    summary({ id: "x2", title: "Parser fixes" }),
    summary({ id: "parser-9", title: "Sonstiges" }),
    summary({ id: "x4", title: "parser" }),
  ];
  const matches = rankChatMatches(chats, "PARSER");
  assert.deepEqual(
    matches.map((match) => match.chat.id),
    ["x4", "parser-9", "x2", "x1"],
  );
  for (let index = 1; index < matches.length; index += 1) {
    assert.ok(matches[index - 1]!.score > matches[index]!.score);
  }
});

test("rankChatMatches prefers an exact id over an exact title", () => {
  const chats = [
    summary({ id: "a1", title: "release" }),
    summary({ id: "release", title: "Anderer Titel" }),
  ];
  const matches = rankChatMatches(chats, "release");
  assert.deepEqual(
    matches.map((match) => match.chat.id),
    ["release", "a1"],
  );
  assert.ok(matches[0]!.score > matches[1]!.score);
});

test("rankChatMatches breaks score ties by recency", () => {
  const chats = [
    summary({ id: "a", title: "Parser alt", updatedAt: "2026-07-20T08:00:00.000Z" }),
    summary({ id: "b", title: "Parser neu", updatedAt: "2026-07-24T08:00:00.000Z" }),
  ];
  const matches = rankChatMatches(chats, "parser");
  assert.deepEqual(
    matches.map((match) => match.chat.id),
    ["b", "a"],
  );
  assert.equal(matches[0]!.score, matches[1]!.score);
});

test("rankChatMatches ignores chats without any match", () => {
  const chats = [
    summary({ id: "a", title: "Parser" }),
    summary({ id: "b", title: "Doku" }),
  ];
  const matches = rankChatMatches(chats, "parser");
  assert.deepEqual(
    matches.map((match) => match.chat.id),
    ["a"],
  );
});

test("search finds chats by title and content, titles first", async () => {
  const { workspace, appHome } = await workspaceRoot("search");

  const byTitle = SessionStore.create(workspace, appHome, "Deploy vorbereiten");
  byTitle.addTurn("user", "Bitte planen.");
  await byTitle.save();

  const byContent = SessionStore.create(workspace, appHome, "Sonstiges");
  byContent.addTurn("user", "Der Deploy\n  schlägt fehl.");
  await byContent.save();

  const unrelated = SessionStore.create(workspace, appHome, "Doku");
  unrelated.addTurn("user", "Lies mich.");
  await unrelated.save();

  const hits = await SessionStore.search(workspace, "deploy", appHome);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.chat.id, byTitle.data.id);
  assert.equal(hits[0]!.titleMatch, true);
  assert.equal(hits[0]!.snippet, "");
  assert.equal(hits[1]!.chat.id, byContent.data.id);
  assert.equal(hits[1]!.titleMatch, false);
  assert.match(hits[1]!.snippet, /Deploy schlägt fehl/);
});

test("search builds a windowed snippet for long messages", async () => {
  const { workspace, appHome } = await workspaceRoot("snippet");

  const store = SessionStore.create(workspace, appHome, "Lang");
  store.addTurn(
    "user",
    `${"x".repeat(200)} geheimer Suchbegriff ${"y".repeat(200)}`,
  );
  await store.save();

  const hits = await SessionStore.search(workspace, "suchbegriff", appHome);
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.snippet.startsWith("…"));
  assert.ok(hits[0]!.snippet.endsWith("…"));
  assert.match(hits[0]!.snippet, /Suchbegriff/);
  assert.ok(hits[0]!.snippet.length < 200);
});

test("search ignores blank queries", async () => {
  const { workspace, appHome } = await workspaceRoot("blank");

  const store = SessionStore.create(workspace, appHome, "Etwas");
  await store.save();

  assert.deepEqual(await SessionStore.search(workspace, "   ", appHome), []);
});
