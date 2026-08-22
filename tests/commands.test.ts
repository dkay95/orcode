import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpendUnavailableError, assertSpendAvailable } from "../src/agent.js";
import {
  handleSlashCommand,
  shouldReplaceCredential,
  type CommandContext,
} from "../src/commands.js";
import { OpenRouterHttpError } from "../src/openrouter.js";
import { SessionStore } from "../src/session.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { migrationManifestPath } from "../src/storage.js";

test("only unusable credentials trigger replacement", () => {
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(401, "User not found")),
    true,
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(403, "Forbidden")),
    true,
  );
  assert.equal(
    shouldReplaceCredential(
      new SpendUnavailableError("key-expired", "Der OpenRouter-Key ist abgelaufen."),
    ),
    true,
  );
  assert.equal(
    shouldReplaceCredential(new Error("OpenRouter ist nicht erreichbar")),
    false,
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(500, "Provider down")),
    false,
  );
});

function spendError(balance: Parameters<typeof assertSpendAvailable>[0]) {
  try {
    assertSpendAvailable(balance);
  } catch (error) {
    assert.ok(
      error instanceof SpendUnavailableError,
      `Erwartet wurde ein SpendUnavailableError, bekommen: ${String(error)}`,
    );
    return error;
  }
  throw new assert.AssertionError({
    message: "assertSpendAvailable hat nichts geworfen.",
  });
}

test("an exhausted balance never deletes a valid key (B3)", () => {
  // The verdict must not depend on the wording of a German message: the old
  // /aufgebraucht|abgelaufen/ regex deleted keys that OpenRouter had just
  // confirmed as valid.
  const noCredits = spendError({
    key: { limit: null, limitRemaining: null },
    credits: { totalCredits: 5, totalUsage: 5, remaining: 0 },
  });
  assert.equal(noCredits.reason, "account-credits");
  assert.match(noCredits.message, /aufgebraucht/);
  assert.equal(shouldReplaceCredential(noCredits), false);

  const noKeyLimit = spendError({ key: { limit: 10, limitRemaining: 0 } });
  assert.equal(noKeyLimit.reason, "key-limit");
  assert.equal(shouldReplaceCredential(noKeyLimit), false);

  // A plain error that merely *reads* like an expiry stays harmless too.
  assert.equal(
    shouldReplaceCredential(new Error("Der Cache ist abgelaufen.")),
    false,
  );
});

test("an expired key is still replaced", () => {
  const expired = spendError({
    key: {
      limit: null,
      limitRemaining: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert.equal(expired.reason, "key-expired");
  assert.equal(shouldReplaceCredential(expired), true);
});

test("chat deletion asks exactly once; decline changes nothing and accept deletes the selected chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-delete-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Aktiv");
  const target = SessionStore.create(workspace, appHome, "Löschziel");
  await active.save();
  await target.save();
  const output: string[] = [];
  const confirmations: Array<{ title: string; details: string }> = [];
  let accepted = false;
  const context = {
    workspace,
    session: active,
    agent: { setSession: () => undefined },
    out: { text: (value: string) => output.push(value), error: (value: string) => output.push(value) },
    confirmChatDeletion: async (title: string, details: string) => {
      confirmations.push({ title, details });
      return accepted;
    },
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${target.data.id}`, context);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!.details, new RegExp(target.data.id));
  assert.match(await readFile(target.path, "utf8"), /Löschziel/);
  assert.equal((await SessionStore.list(workspace, appHome)).length, 2);

  accepted = true;
  await handleSlashCommand(`/chat delete ${target.data.id}`, context);
  assert.equal(confirmations.length, 2, "each delete attempt has one and only one confirmation");
  await assert.rejects(readFile(target.path, "utf8"), /ENOENT/);
  assert.deepEqual((await SessionStore.list(workspace, appHome)).map((chat) => chat.id), [active.data.id]);
  assert.ok(output.some((line) => /endgültig gelöscht/.test(line)));
});

test("accepting deletion of the active chat rebinds before autosave can resurrect it", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-active-delete-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Aktiv löschen");
  await active.save();
  const oldId = active.data.id;
  const rebound: string[] = [];
  const context = {
    workspace,
    session: active,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: (session: SessionStore) => rebound.push(session.data.id) },
    out: { text: () => undefined, error: () => undefined },
    confirmChatDeletion: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);
  await context.session.save();

  assert.notEqual(context.session.data.id, oldId);
  assert.deepEqual(rebound, [context.session.data.id]);
  assert.equal((await SessionStore.list(workspace, appHome)).some((chat) => chat.id === oldId), false);
});

test("failed managed-backup cleanup keeps the active transcript bound and a retry cannot resurrect it", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-command-backup-retry-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  const active = SessionStore.create(workspace, appHome, "Backup-Retry");
  await active.save();
  const oldId = active.data.id;
  const checksum = "d".repeat(64);
  const backupPath = join(appHome, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  const outsideEmpty = join(root, "outside-empty");
  await mkdir(join(appHome, "migration-backups"), { recursive: true });
  await mkdir(outsideEmpty);
  await symlink(outsideEmpty, backupPath);
  await mkdir(join(appHome, "migrations"), { recursive: true });
  await writeFile(migrationManifestPath(appHome), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: join(root, ".routercode"),
    sourceChecksum: checksum,
    stagingPath: join(appHome, ".migration-staging", checksum),
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-22T11:59:00.000Z",
    completedAt: "2026-08-22T12:00:00.000Z",
  }));
  const rebound: string[] = [];
  const errors: string[] = [];
  const context = {
    workspace,
    session: active,
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    agent: { setSession: (session: SessionStore) => rebound.push(session.data.id) },
    out: { text: () => undefined, error: (value: string) => errors.push(value) },
    confirmChatDeletion: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand(`/chat delete ${oldId}`, context);

  assert.equal(context.session.data.id, oldId, "a failed cleanup keeps the active binding");
  assert.deepEqual(rebound, []);
  assert.match(await readFile(active.path, "utf8"), /Backup-Retry/, "the transcript remains the retry anchor");
  assert.ok(errors.some((value) => /nicht vollständig gelöscht/.test(value)));

  await rm(backupPath);
  await mkdir(backupPath);
  await handleSlashCommand(`/chat delete ${oldId}`, context);
  await context.session.save();

  assert.notEqual(context.session.data.id, oldId);
  assert.deepEqual(rebound, [context.session.data.id]);
  assert.equal((await SessionStore.list(workspace, appHome)).some((chat) => chat.id === oldId), false);
  await assert.rejects(stat(backupPath), /ENOENT/);
});
