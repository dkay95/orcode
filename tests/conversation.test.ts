import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createInitialState,
  deserializeConversationState,
  serializeConversationState,
  type ConversationState,
} from "@openrouter/agent";
import { ConversationStore, type StateFile } from "../src/conversation.js";
import { PrivateStore } from "../src/private-store.js";
import { SessionStore, conversationHistoryDigest } from "../src/session.js";

async function setup(prefix: string): Promise<{
  appHome: string;
  workspace: string;
  session: SessionStore;
}> {
  const workspace = await mkdtemp(join(tmpdir(), `routercode-conv-${prefix}-`));
  const appHome = join(workspace, ".state");
  const session = SessionStore.create(workspace, appHome, "Testchat");
  await session.save();
  return { appHome, workspace, session };
}

function sampleState(tag: string): ConversationState {
  const state = createInitialState();
  return { ...state, messages: [{ role: "user", content: tag }] as never };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// --- K7 criterion 1 --------------------------------------------------------

test("K7.1: accessor().save() never writes; commit() does; discard() leaves the file unchanged", async () => {
  const env = await setup("commit");
  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const accessor = store.accessor();

  assert.equal(await accessor.load(), null, "ein frischer Chat hat keinen Zustand");

  await accessor.save(sampleState("buffered-only"));
  assert.equal(
    await exists(statePath),
    false,
    "save() darf keine Datei schreiben",
  );

  store.discard();
  assert.equal(
    await exists(statePath),
    false,
    "discard() darf ebenfalls keine Datei erzeugen",
  );

  await accessor.save(sampleState("committed"));
  await store.commit(env.session.data.turns.length);
  assert.equal(await exists(statePath), true, "commit() muss schreiben");
  const written = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  assert.equal(written.revision, 1);
  const decoded = deserializeConversationState(written.state);
  assert.deepEqual(decoded.messages, [{ role: "user", content: "committed" }]);

  // A discard AFTER a real commit must not touch the already-persisted file.
  await accessor.save(sampleState("thrown-away"));
  store.discard();
  const unchanged = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  assert.equal(unchanged.revision, 1);
  assert.deepEqual(
    deserializeConversationState(unchanged.state).messages,
    [{ role: "user", content: "committed" }],
    "der committete Inhalt darf durch einen späteren discard() nicht verändert werden",
  );
});

// --- K7 criterion 2 --------------------------------------------------------

test("K7.2: two stores committing the same file — the higher revision survives, the other becomes a .konflikt file, nothing is lost", async () => {
  const env = await setup("conflict");
  const storeA = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  const storeB = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  const statePath = ConversationStore.path(env.appHome, env.session.path);

  await storeA.accessor().save(sampleState("von-a"));
  await storeA.commit(0);

  await storeB.accessor().save(sampleState("von-b"));
  await storeB.commit(0);

  const main = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  assert.equal(main.revision, 1);
  assert.deepEqual(deserializeConversationState(main.state).messages, [
    { role: "user", content: "von-a" },
  ]);

  const siblings = await readdir(dirname(statePath));
  const conflictName = siblings.find((name) => name.includes(".konflikt-"));
  assert.ok(conflictName, "der Verlierer muss als .konflikt-*.json überleben");
  const conflictPath = join(dirname(statePath), conflictName!);
  const conflict = JSON.parse(await readFile(conflictPath, "utf8")) as StateFile;
  assert.deepEqual(deserializeConversationState(conflict.state).messages, [
    { role: "user", content: "von-b" },
  ]);
});

// --- K7 criterion 3 --------------------------------------------------------

test("K7.3: a state file whose turnCount exceeds the chat's actual turn count is treated as absent", async () => {
  const env = await setup("turncount");
  for (let index = 0; index < 4; index += 1) {
    env.session.addTurn(index % 2 === 0 ? "user" : "assistant", `Turn ${index}`);
  }
  await env.session.save();
  assert.equal(env.session.data.turns.length, 4);

  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const stale: StateFile = {
    version: 1,
    revision: 3,
    chatId: env.session.data.id,
    turnCount: 10,
    historyDigest: "0".repeat(64),
    updatedAt: new Date().toISOString(),
    state: serializeConversationState(sampleState("zu-viel")),
  };
  await writeFile(statePath, JSON.stringify(stale), "utf8");

  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  assert.equal(store.hasState(), false);
  assert.equal(await store.accessor().load(), null);
});

test("K7.3 (positive case): a state file whose turnCount and digest exactly match the chat is usable", async () => {
  const env = await setup("turncount-ok");
  for (let index = 0; index < 4; index += 1) {
    env.session.addTurn(index % 2 === 0 ? "user" : "assistant", `Turn ${index}`);
  }
  await env.session.save();

  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const fresh: StateFile = {
    version: 1,
    revision: 1,
    chatId: env.session.data.id,
    turnCount: 4,
    historyDigest: conversationHistoryDigest(env.session.data),
    updatedAt: new Date().toISOString(),
    state: serializeConversationState(sampleState("passt")),
  };
  await writeFile(statePath, JSON.stringify(fresh), "utf8");

  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  assert.equal(store.hasState(), true);
  const loaded = await store.accessor().load();
  assert.deepEqual(loaded?.messages, [{ role: "user", content: "passt" }]);
});

test("K7.3: equal turn counts cannot reuse state from a different transcript or summary epoch", async () => {
  const env = await setup("history-digest");
  env.session.addTurn("user", "Ursprüngliche Frage");
  env.session.addTurn("assistant", "Ursprüngliche Antwort");
  env.session.setSummary("Ursprüngliche Zusammenfassung");
  await env.session.save();

  const originalDigest = conversationHistoryDigest(env.session.data);
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const stateFile: StateFile = {
    version: 1,
    revision: 1,
    chatId: env.session.data.id,
    turnCount: env.session.data.turns.length,
    historyDigest: originalDigest,
    updatedAt: new Date().toISOString(),
    state: serializeConversationState(sampleState("alter-inhalt")),
  };
  await writeFile(statePath, JSON.stringify(stateFile), "utf8");

  env.session.setSummary("Andere Zusammenfassung bei gleichem Turn-Count");
  await env.session.save();
  assert.notEqual(conversationHistoryDigest(env.session.data), originalDigest);

  const reopened = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  assert.equal(reopened.hasState(), false);
  assert.equal(await reopened.accessor().load(), null);
});

test("legacy conversation state without a history digest is safely treated as unusable", async () => {
  const env = await setup("legacy-no-digest");
  env.session.addTurn("user", "Sichtbarer Verlauf");
  env.session.addTurn("assistant", "Bleibt maßgeblich");
  await env.session.save();
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      revision: 7,
      chatId: env.session.data.id,
      turnCount: env.session.data.turns.length,
      updatedAt: new Date().toISOString(),
      state: serializeConversationState(sampleState("legacy-sdk-only")),
    }),
    "utf8",
  );

  const reopened = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  assert.equal(reopened.hasState(), false);
  assert.equal(await reopened.accessor().load(), null);
});

test("a failed state commit invalidates in-memory coverage and a reopen falls back instead of replaying stale state", async () => {
  const env = await setup("commit-failure");
  env.session.addTurn("user", "Alter Verlauf");
  env.session.addTurn("assistant", "Alte Antwort");
  await env.session.save();
  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  await store.accessor().save(sampleState("alter-sdk-state"));
  await store.commit(env.session.data.turns.length);
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const before = await readFile(statePath, "utf8");

  env.session.addTurn("user", "Neuer Verlauf");
  env.session.addTurn("assistant", "Neue Antwort");
  await env.session.save();
  await store.accessor().save(sampleState("darf-nicht-als-abgedeckt-gelten"));
  const originalWrite = PrivateStore.prototype.writeTextAtomic;
  PrivateStore.prototype.writeTextAtomic = async function(path, content) {
    if (path === statePath) {
      throw new Error("synthetic state commit failure");
    }
    return originalWrite.call(this, path, content);
  };
  try {
    await assert.rejects(
      store.commit(env.session.data.turns.length),
      /synthetic state commit failure/,
    );
  } finally {
    PrivateStore.prototype.writeTextAtomic = originalWrite;
  }

  assert.equal(await readFile(statePath, "utf8"), before);
  assert.equal(store.hasState(), false);
  assert.equal(await store.accessor().load(), null);
  const reopened = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  assert.equal(reopened.hasState(), false);
});

// --- extra coverage ---------------------------------------------------------

test("path() derives the state file name from the chat file path", () => {
  assert.equal(
    ConversationStore.path("/home/x/.routercode", "/home/x/.routercode/chats/a/b.json"),
    "/home/x/.routercode/chats/a/b.json.state.json",
  );
});

test("reset(seed) stages a usable fresh state for the same call without touching the committed file", async () => {
  const env = await setup("reset");
  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  await store.accessor().save(sampleState("vor-reset"));
  await store.commit(0);
  assert.equal(store.hasState(), true);

  store.reset("Kurzer Handoff nach Kompression.");
  assert.equal(store.hasState(), true);
  const seeded = await store.accessor().load();
  assert.equal(seeded?.status, "in_progress");
  assert.deepEqual(seeded?.messages, [
    { role: "user", content: "Kurzer Handoff nach Kompression." },
  ]);

  // The file committed before the reset must not be touched by reset() itself.
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const stillThere = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  assert.equal(stillThere.revision, 1);

  store.discard();
  assert.deepEqual((await store.accessor().load())?.messages, [
    { role: "user", content: "vor-reset" },
  ]);
});

test("transient developer messages are visible for one request but never persisted in SDK state", async () => {
  const env = await setup("transient-state");
  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  const transient = "RUN LIMITS: TRANSIENT_SENTINEL";
  const accessor = store.accessor([transient]);
  const state = sampleState("dauerhafte-history");
  state.messages = [
    { role: "user", content: "dauerhafte-history" },
    { role: "developer", content: transient },
    { role: "assistant", content: "Antwort" },
  ] as never;

  await accessor.save(state);
  await store.commit(0);
  const reopened = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  const persisted = await reopened.accessor().load();

  assert.match(JSON.stringify(persisted), /dauerhafte-history/);
  assert.doesNotMatch(JSON.stringify(persisted), /TRANSIENT_SENTINEL|RUN LIMITS/);
});

test("a chat id mismatch is treated as no state", async () => {
  const env = await setup("mismatch");
  const store = await ConversationStore.open(
    env.appHome,
    env.session.path,
    env.session.data.id,
  );
  await store.accessor().save(sampleState("fuer-diesen-chat"));
  await store.commit(0);

  const reopenedForAnotherChat = await ConversationStore.open(
    env.appHome,
    env.session.path,
    "ein-anderer-chat-id",
  );
  assert.equal(reopenedForAnotherChat.hasState(), false);
});
