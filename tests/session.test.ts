import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateBudget } from "../src/config.js";
import {
  chatLockPath,
  dayKey,
  exportSessionMarkdown,
  rankChatMatches,
  redactSensitive,
  SessionStore,
  workspaceSpend,
} from "../src/session.js";
import type { ChatSummary } from "../src/types.js";

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
  store.addTurn("assistant", "zweite Antwort");
  const outcome = await store.save();

  assert.ok(outcome.conflictBackupPath);
  assert.match(
    await readFile(outcome.conflictBackupPath as string, "utf8"),
    /das ist kein JSON/,
  );
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
  const markdown = exportSessionMarkdown({
    version: 2,
    id: "abcdefgh",
    title: "Geheim",
    workspace: "/tmp/x",
    summary: "Token ghp_abcdefghijklmnopqrstuvwxyz0123",
    turns: [
      {
        role: "user",
        content: "Key: sk-or-v1-abcdefghijklmnopqrstuvwxyz",
        createdAt: "2026-07-24T08:00:00.000Z",
      },
    ],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    createdAt: "2026-07-24T08:00:00.000Z",
    updatedAt: "2026-07-24T08:00:00.000Z",
  });
  assert.doesNotMatch(markdown, /sk-or-v1-abcdefghij/);
  assert.doesNotMatch(markdown, /ghp_abcdefghij/);
  assert.match(markdown, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(markdown, /\[REDACTED_GITHUB_TOKEN\]/);
});

test("summaries are redacted before they are persisted", async () => {
  const { workspace, appHome } = await workspaceRoot("summary");
  const store = SessionStore.create(workspace, appHome, "Zusammenfassung");
  store.setSummary("Der Nutzer nannte ghp_abcdefghijklmnopqrstuvwxyz0123.");
  await store.save();

  const raw = await readFile(store.path, "utf8");
  assert.doesNotMatch(raw, /ghp_abcdefghij/);
  assert.match(raw, /\[REDACTED_GITHUB_TOKEN\]/);
});

test("redactSensitive covers the common secret formats", () => {
  // [Klartext, erwartete Markierung, Teilstück, das verschwinden muss]
  const cases: [string, RegExp, string][] = [
    [
      "sk-or-v1-abcdefghijklmnopqrstuvwxyz012345",
      /\[REDACTED_OPENROUTER_KEY\]/,
      "abcdefghijklmnop",
    ],
    [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      /\[REDACTED_ANTHROPIC_KEY\]/,
      "api03-abcdefghij",
    ],
    [
      "sk-proj-abcdefghijklmnopqrstuvwxyz01",
      /\[REDACTED_API_KEY\]/,
      "proj-abcdefghijk",
    ],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", /\[REDACTED_GITHUB_TOKEN\]/, "ghp_abcdefghij"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123", /\[REDACTED_GITHUB_TOKEN\]/, "gho_abcdefghij"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123", /\[REDACTED_GITHUB_TOKEN\]/, "ghs_abcdefghij"],
    [
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      /\[REDACTED_GITHUB_TOKEN\]/,
      "11ABCDEFG0abcdef",
    ],
    ["AKIAIOSFODNN7EXAMPLE", /\[REDACTED_AWS_KEY_ID\]/, "AKIAIOSFODNN7EXAMPLE"],
    [
      'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
      /\[REDACTED_AWS_SECRET\]/,
      "wJalrXUtnFEMI",
    ],
    [
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      /\[REDACTED_GOOGLE_KEY\]/,
      "AIzaSyA1234567890",
    ],
    [
      "xoxb-123456789012-abcdefghijkl",
      /\[REDACTED_SLACK_TOKEN\]/,
      "xoxb-123456789012",
    ],
    [
      "Authorization: Bearer abcdef1234567890abcdef",
      /Bearer \[REDACTED_TOKEN\]/,
      "abcdef1234567890",
    ],
    [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      /\[REDACTED_JWT\]/,
      "eyJzdWIiOiIxMjM0",
    ],
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----",
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
    "AKIAsmall",
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
