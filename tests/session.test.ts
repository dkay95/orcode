import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session.js";

test("workspace can contain multiple independently persisted chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-chats-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");

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

test("fork copies context but starts a separate cost ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-fork-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");
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

test("legacy workspace session migrates without deleting the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-legacy-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");
  const workspaceId = createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 16);
  const legacyPath = join(appHome, "sessions", `${workspaceId}.json`);
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

  const migrated = await SessionStore.open(workspace, appHome);
  assert.equal(migrated.data.version, 2);
  assert.equal(migrated.data.title, "Alter Verlauf");
  assert.ok(Math.abs(migrated.data.costs.totalUsd - 0.12) < 1e-9);
  assert.equal((await SessionStore.list(workspace, appHome)).length, 1);
  assert.match(await readFile(legacyPath, "utf8"), /"version":1/);
});
