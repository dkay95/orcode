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
import { SessionStore } from "../src/session.js";

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
  await storeA.commit(2);

  await storeB.accessor().save(sampleState("von-b"));
  await storeB.commit(2);

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

test("K7.3 (positive case): a state file whose turnCount matches or trails the chat is usable", async () => {
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

// --- extra coverage ---------------------------------------------------------

test("path() derives the state file name from the chat file path", () => {
  assert.equal(
    ConversationStore.path("/home/x/.routercode", "/home/x/.routercode/chats/a/b.json"),
    "/home/x/.routercode/chats/a/b.json.state.json",
  );
});

test("reset() drops the in-memory state without touching a mismatched chatId file", async () => {
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
  assert.equal(store.hasState(), false);
  assert.equal(await store.accessor().load(), null);

  // The file committed before the reset must not be touched by reset() itself.
  const statePath = ConversationStore.path(env.appHome, env.session.path);
  const stillThere = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  assert.equal(stillThere.revision, 1);
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
