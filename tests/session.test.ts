import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rankChatMatches, SessionStore } from "../src/session.js";
import type { ChatSummary } from "../src/types.js";

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
  const root = await mkdtemp(join(tmpdir(), "routercode-search-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");

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
  const root = await mkdtemp(join(tmpdir(), "routercode-snippet-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");

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
  const root = await mkdtemp(join(tmpdir(), "routercode-blank-"));
  const workspace = join(root, "project");
  const appHome = join(root, ".routercode");

  const store = SessionStore.create(workspace, appHome, "Etwas");
  await store.save();

  assert.deepEqual(await SessionStore.search(workspace, "   ", appHome), []);
});
