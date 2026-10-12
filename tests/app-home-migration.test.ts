import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createInitialState,
  deserializeConversationState,
  serializeConversationState,
} from "@openrouter/agent";
import { initializeStartupStorage } from "../src/cli.js";
import {
  ConfigEditUnavailableError,
  DEFAULT_APPEARANCE,
  loadConfigDetailed,
  migrateAppHome,
  readConfigEditSnapshot,
  sameConfigFileSnapshot,
  withConfigWriteLock,
} from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { PrivateStore } from "../src/private-store.js";
import {
  projectLegacyModelRoutes,
  requireKeychainCredentialPointer,
  type ProviderConnectionStateV3,
} from "../src/provider-state.js";
import { approvalSubjectFingerprint } from "../src/rules.js";
import { SessionStore } from "../src/session.js";
import {
  migrationManifestPath,
  parseCheckpointEntries,
  parseConversationStateFile,
} from "../src/storage.js";

const WORKSPACE = "/synthetic/workspace";
const WORKSPACE_HASH = createHash("sha256").update(WORKSPACE).digest("hex").slice(0, 16);
const HISTORICAL_FIXTURE_WORKSPACE = "/fixture/workspace";
const HISTORICAL_FIXTURE_HASH = "c55218afb5a1f354";
const HISTORICAL_FIXTURE_CHAT_ID = "legacy-fixture-chat";
const HISTORICAL_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "app-home-v0",
);

function serializedState(tag: string): string {
  const state = createInitialState();
  return serializeConversationState({
    ...state,
    messages: [{ role: "user", content: tag }] as never,
  });
}

function syntheticCredential(): string {
  return `${["sk", "or", "v1"].join("-")}-${"m".repeat(40)}`;
}

function chat(id: string, title: string, secret = ""): Record<string, unknown> {
  return {
    version: 2,
    id,
    title,
    workspace: WORKSPACE,
    summary: secret ? `summary ${secret}` : "summary",
    turns: [{ role: "user", content: secret ? `prompt ${secret}` : "prompt", createdAt: "2026-08-20T10:00:00.000Z" }],
    costs: { mainUsd: 0.2, compressorUsd: 0, voiceUsd: 0, totalUsd: 0.2 },
    revision: 1,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:01:00.000Z",
  };
}

async function seedHome(home: string, options: { id?: string; model?: string; secret?: string } = {}): Promise<string> {
  const id = options.id ?? "legacy-chat-a";
  await mkdir(join(home, "chats", WORKSPACE_HASH), { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ mainModel: options.model ?? "legacy/model" }));
  await writeFile(join(home, "chats", WORKSPACE_HASH, `${id}.json`), JSON.stringify(chat(id, "Legacy", options.secret)));
  return id;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await treeBytes(child) : (await stat(child)).size;
  }
  return total;
}

async function snapshotFileTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, relativePath);
      } else {
        snapshot[relativePath] = (await readFile(path)).toString("base64");
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

interface ManifestResumeFixture {
  legacy: string;
  target: string;
  configPath: string;
  stagingPath: string;
}

async function completedManifestResumeFixture(prefix: string): Promise<ManifestResumeFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const completed = await migrateAppHome(target, legacy);
  assert.equal(completed.status, "ready");
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as {
    phase: string;
    complete: boolean;
    stagingPath: string;
  };
  assert.equal(manifest.phase, "complete");
  assert.equal(manifest.complete, true);
  await mkdir(manifest.stagingPath, { recursive: true });
  await writeFile(join(manifest.stagingPath, "must-remain.txt"), "completed staging sentinel");
  return {
    legacy,
    target,
    configPath: join(target, "config.json"),
    stagingPath: manifest.stagingPath,
  };
}

async function postRenameManifestResumeFixture(prefix: string): Promise<ManifestResumeFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await assert.rejects(
    migrateAppHome(target, legacy, {
      onPhase: async (phase: string) => {
        if (phase === "backed-up") {
          throw new Error("synthetic stop after legacy rename");
        }
      },
    } as never),
    /synthetic stop after legacy rename/,
  );
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as {
    phase: string;
    complete: boolean;
    stagingPath: string;
  };
  assert.equal(manifest.phase, "backed-up");
  assert.equal(manifest.complete, false);
  assert.equal(await exists(legacy), false);
  await writeFile(join(manifest.stagingPath, "must-remain.txt"), "post-rename staging sentinel");
  return {
    legacy,
    target,
    configPath: join(target, "config.json"),
    stagingPath: manifest.stagingPath,
  };
}

interface MigrationRaceResult {
  status: "ready" | "declined" | "future" | "recovery-required";
  appHome: string;
  warning: string | null;
}

async function publishConfigBehindMigrationLockAttempt(options: {
  target: string;
  legacy: string;
  blockedConfigPath: string;
  writerConfigPath: string;
  writerBytes: string;
}): Promise<MigrationRaceResult> {
  let holderReached!: () => void;
  let releaseHolder!: () => void;
  const reached = new Promise<void>((resolve) => { holderReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = withConfigWriteLock(options.blockedConfigPath, async (ownership) => {
    holderReached();
    await release;
    if (options.writerConfigPath === options.blockedConfigPath) {
      const store = new PrivateStore({ root: dirname(ownership.canonicalPath) });
      await ownership.assertHeld();
      await store.writeTextAtomic(
        ownership.canonicalPath,
        options.writerBytes,
        ownership.assertHeld,
      );
      await ownership.assertHeld();
    }
  });
  await reached;

  const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;
  const privateStoreModuleUrl = new URL("../src/private-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      const privateApi = await import(process.env.ORCODE_FIX3_PRIVATE_STORE_MODULE_URL);
      const originalCreate = privateApi.PrivateStore.prototype.createDirectoryExclusive;
      let firstLockAttempt = true;
      privateApi.PrivateStore.prototype.createDirectoryExclusive = async function (path) {
        if (firstLockAttempt) {
          firstLockAttempt = false;
          await new Promise((resolve, reject) => {
            const onMessage = (message) => {
              if (message?.type !== "lock-attempt-ack") return;
              process.off("message", onMessage);
              resolve();
            };
            process.on("message", onMessage);
            process.send({ type: "lock-attempt" }, (error) => {
              if (!error) return;
              process.off("message", onMessage);
              reject(error);
            });
          });
        }
        return originalCreate.call(this, path);
      };
      try {
        const api = await import(process.env.ORCODE_FIX3_CONFIG_MODULE_URL);
        const result = await api.migrateAppHome(
          process.env.ORCODE_FIX3_TARGET,
          process.env.ORCODE_FIX3_LEGACY,
        );
        process.send({ type: "result", result });
      } catch (error) {
        process.send({ type: "error", message: String(error) });
        process.exitCode = 1;
      }
    `,
  ], {
    env: {
      ...process.env,
      ORCODE_FIX3_CONFIG_MODULE_URL: configModuleUrl,
      ORCODE_FIX3_PRIVATE_STORE_MODULE_URL: privateStoreModuleUrl,
      ORCODE_FIX3_TARGET: options.target,
      ORCODE_FIX3_LEGACY: options.legacy,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  let lockAttemptReached!: () => void;
  const lockAttempt = new Promise<void>((resolve) => { lockAttemptReached = resolve; });
  let resolveResult!: (result: MigrationRaceResult) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<MigrationRaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let receivedResult = false;
  child.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "lock-attempt") lockAttemptReached();
    if (message.type === "result" && "result" in message) {
      receivedResult = true;
      resolveResult(message.result as MigrationRaceResult);
    }
    if (message.type === "error") {
      rejectResult(new Error(String("message" in message ? message.message : "migration child failed")));
    }
  });
  child.once("error", rejectResult);
  const childExit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      if (!receivedResult && code !== 0) {
        rejectResult(new Error(`migration child exited ${code}: ${stderr}`));
      }
      resolve(code);
    });
  });

  let holderReleased = false;
  try {
    await Promise.race([
      lockAttempt,
      resultPromise.then(() => {
        throw new Error("migration completed before requesting serialized config ownership");
      }),
    ]);
    if (options.writerConfigPath !== options.blockedConfigPath) {
      await withConfigWriteLock(options.writerConfigPath, async (ownership) => {
        const store = new PrivateStore({ root: dirname(ownership.canonicalPath) });
        await ownership.assertHeld();
        await store.writeTextAtomic(
          ownership.canonicalPath,
          options.writerBytes,
          ownership.assertHeld,
        );
        await ownership.assertHeld();
      });
    }
    releaseHolder();
    holderReleased = true;
    await holder;
    await new Promise<void>((resolve, reject) => {
      child.send({ type: "lock-attempt-ack" }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const result = await resultPromise;
    const exitCode = await childExit;
    assert.equal(exitCode, 0, stderr);
    return result;
  } finally {
    if (!holderReleased) releaseHolder();
    await holder.catch(() => undefined);
    if (child.exitCode === null) child.kill();
  }
}

test("ChatArtifactRegistry centrally classifies every 0.4 chat artifact and only reserves task sidecars", async () => {
  const { CHAT_ARTIFACT_REGISTRY } = await import("../src/storage.js");
  assert.deepEqual(
    CHAT_ARTIFACT_REGISTRY.entries().map((entry) => ({
      kind: entry.kind,
      privacy: entry.privacy,
      retention: entry.retention,
      migration: entry.migration,
      deletion: entry.deletion,
    })),
    [
      { kind: "chat", privacy: "redacted", retention: "chat", migration: "required", deletion: "file" },
      { kind: "chat-conflict", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
      { kind: "conversation-state", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
      { kind: "conversation-conflict", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "file" },
      { kind: "run-log", privacy: "redacted", retention: "redacted-run-log", migration: "required", deletion: "chat-tree" },
      { kind: "checkpoint", privacy: "exact", retention: "exact-recovery", migration: "required", deletion: "chat-tree" },
      { kind: "lock", privacy: "exact", retention: "exact-recovery", migration: "never", deletion: "file" },
      { kind: "task-sidecar", privacy: "exact", retention: "exact-recovery", migration: "reserved", deletion: "chat-tree" },
    ],
  );
  assert.equal(
    CHAT_ARTIFACT_REGISTRY.resolve("run-log", { appHome: "/app", chatId: "chat-a", artifactId: "run-a" }),
    join("/app", "runs", "chat-a", "run-a.ndjson"),
  );
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("task-sidecar", { appHome: "/app", chatId: "chat-a" }), []);
});

test("ChatArtifactRegistry enumerates actual files and classifies locks as non-migrating", async () => {
  const { CHAT_ARTIFACT_REGISTRY } = await import("../src/storage.js") as typeof import("../src/storage.js") & {
    CHAT_ARTIFACT_REGISTRY: {
      existing: (kind: string, location: Record<string, unknown>) => Promise<string[]>;
      resolve: (kind: string, location: Record<string, unknown>) => string;
    };
  };
  const root = await mkdtemp(join(tmpdir(), "orcode-registry-existing-"));
  const location = {
    appHome: root,
    workspaceHash: WORKSPACE_HASH,
    chatId: "chat-a",
  };
  const chatPath = join(root, "chats", WORKSPACE_HASH, "chat-a.json");
  const paths = [
    chatPath,
    `${chatPath}.konflikt-1.json`,
    `${chatPath}.state.json`,
    `${chatPath}.state.json.konflikt-1.json`,
    `${chatPath}.lock`,
    `${chatPath}.state.json.lock`,
    join(root, "runs", "chat-a", "run-a.ndjson"),
    join(root, "checkpoints", "chat-a", "run-a.json"),
  ];
  for (const path of paths) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{}\n");
  }

  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("chat", location), [chatPath]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("chat-conflict", location), [`${chatPath}.konflikt-1.json`]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("conversation-state", location), [`${chatPath}.state.json`]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("conversation-conflict", location), [`${chatPath}.state.json.konflikt-1.json`]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("run-log", location), [join(root, "runs", "chat-a", "run-a.ndjson")]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("checkpoint", location), [join(root, "checkpoints", "chat-a", "run-a.json")]);
  assert.deepEqual(await CHAT_ARTIFACT_REGISTRY.existing("lock", location), [`${chatPath}.lock`, `${chatPath}.state.json.lock`]);
});

test("ChatArtifactRegistry.get rejects an unknown kind in English, as a plain Error (F4: the last defensive German throw, translated with the same semantics and class)", async () => {
  const { CHAT_ARTIFACT_REGISTRY } = await import("../src/storage.js") as typeof import("../src/storage.js") & {
    CHAT_ARTIFACT_REGISTRY: { get: (kind: string) => unknown };
  };
  assert.throws(
    () => CHAT_ARTIFACT_REGISTRY.get("not-a-real-kind"),
    (error: unknown) =>
      error instanceof Error
      && error.message === "Unknown chat artifact type: not-a-real-kind",
  );
});

test("legacy-only migration stages, validates, maps every sidecar, redacts readable data, and keeps one protected exact backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-full-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const secret = syntheticCredential();
  const oldId = await seedHome(legacy, { secret });
  const oldChatPath = join(legacy, "chats", WORKSPACE_HASH, `${oldId}.json`);
  const exactState = serializedState("opaque exact state");
  const historyDigest = "0".repeat(64);
  await writeFile(`${oldChatPath}.state.json`, JSON.stringify({ version: 1, revision: 1, chatId: oldId, turnCount: 1, historyDigest, updatedAt: "2026-08-20T10:01:00.000Z", state: exactState }));
  await writeFile(`${oldChatPath}.konflikt-old.json`, `unreadable exact conflict ${secret}`);
  await mkdir(join(legacy, "runs", oldId), { recursive: true });
  const legacyEvents = [
    { type: "run-start", model: "synthetic/model", maxSteps: 5, prompt: `run ${secret}`, timestamp: 11 },
    { type: "model-end", model: "synthetic/model", step: 1, durationMs: 9, inputTokens: 4, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.125, timestamp: 12 },
    { type: "run-end", outcome: "complete", durationMs: 10, toolCount: 0, timestamp: 13 },
  ];
  await writeFile(join(legacy, "runs", oldId, "run-a.ndjson"), `${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await mkdir(join(legacy, "checkpoints", oldId), { recursive: true });
  await writeFile(join(legacy, "checkpoints", oldId, "run-a.json"), JSON.stringify([{ path: "/synthetic/file", before: secret, after: "after", createdAt: "2026-08-20T10:00:00.000Z", runId: "run-a" }]));
  await mkdir(join(legacy, "tasks", oldId), { recursive: true });
  await writeFile(join(legacy, "tasks", oldId, "future.json"), JSON.stringify({ future: true }));
  await writeFile(join(legacy, "chats", WORKSPACE_HASH, `${oldId}.json.lock`), "do not migrate");

  const result = await migrateAppHome(target, legacy);
  const { migrationManifestPath } = await import("../src/storage.js");
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as {
    phase: string;
    complete: boolean;
    sourceChecksum: string;
    chatIdMap: Record<string, string>;
    destinationPaths: string[];
    backupPath: string;
  };
  const newId = manifest.chatIdMap[oldId]!;

  assert.equal(result.appHome, target);
  assert.equal(manifest.phase, "complete");
  assert.equal(manifest.complete, true);
  assert.match(manifest.sourceChecksum, /^[a-f0-9]{64}$/);
  assert.notEqual(newId, oldId);
  assert.ok(manifest.destinationPaths.every((path) => path.startsWith(target)));
  assert.equal(await exists(legacy), false, "the legacy home must not remain unmanaged");
  const migratedChat = await readFile(join(target, "chats", WORKSPACE_HASH, `${newId}.json`), "utf8");
  assert.doesNotMatch(migratedChat, new RegExp(secret));
  assert.equal((JSON.parse(migratedChat) as { id: string }).id, newId);
  const migratedState = JSON.parse(await readFile(join(target, "chats", WORKSPACE_HASH, `${newId}.json.state.json`), "utf8")) as { chatId: string; state: string };
  assert.deepEqual(migratedState, { version: 1, revision: 1, chatId: newId, turnCount: 1, historyDigest, updatedAt: "2026-08-20T10:01:00.000Z", state: exactState });
  const migratedChatConflict = join(target, "chats", WORKSPACE_HASH, `${newId}.json.konflikt-old.json`);
  assert.match(await readFile(migratedChatConflict, "utf8"), new RegExp(secret));
  assert.equal((await stat(migratedChatConflict)).mode & 0o777, 0o600);
  const migratedLogLines = (await readFile(join(target, "runs", newId, "run-a.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(migratedLogLines.map((line) => line.version), [1, 1, 1]);
  assert.deepEqual(migratedLogLines.map((line) => line.event.timestamp), [11, 12, 13]);
  assert.equal(migratedLogLines[1].event.costUsd, 0.125);
  assert.equal(migratedLogLines[2].event.outcome, "complete");
  assert.doesNotMatch(JSON.stringify(migratedLogLines), new RegExp(secret));
  assert.match(await readFile(join(target, "checkpoints", newId, "run-a.json"), "utf8"), new RegExp(secret), "exact journal stays exact");
  assert.equal(await exists(join(target, "tasks", newId, "future.json")), false, "reserved task sidecars have no 0.4 migrator");
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, `${newId}.json.lock`)), false);
  assert.equal((await stat(manifest.backupPath)).mode & 0o777, 0o700);
  assert.match(await readFile(join(manifest.backupPath, "chats", WORKSPACE_HASH, `${oldId}.json`), "utf8"), new RegExp(secret));
  assert.equal((await readdir(join(target, "migration-backups"))).length, 1);
});

test("dual-home migration keeps new config authoritative and merges exact rules by fingerprint without duplicate chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-dual-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const oldId = await seedHome(legacy, { id: "shared-chat", model: "legacy/model" });
  await seedHome(target, { id: "shared-chat", model: "new/model" });
  await writeFile(join(target, "config.json"), JSON.stringify({ mainModel: "new/model" }));
  const sharedRule = { id: "new-rule", workspace: WORKSPACE, tool: "read_file", match: { kind: "exact-subject", fingerprint: "f".repeat(64), display: "shared" }, decision: "allow", createdAt: "2026-08-20T00:00:00.000Z" };
  const legacyRule = { ...sharedRule, id: "legacy-duplicate" };
  const uniqueRule = { ...sharedRule, id: "legacy-unique", match: { ...sharedRule.match, fingerprint: "e".repeat(64), display: "unique" } };
  await writeFile(join(target, "permissions.json"), JSON.stringify({ version: 2, rules: [sharedRule] }));
  await writeFile(join(legacy, "permissions.json"), JSON.stringify({ version: 2, rules: [legacyRule, uniqueRule] }));

  const result = await migrateAppHome(target, legacy);
  const { migrationManifestPath } = await import("../src/storage.js");
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as { chatIdMap: Record<string, string> };
  const newId = manifest.chatIdMap[oldId]!;
  const config = JSON.parse(await readFile(join(target, "config.json"), "utf8")) as { schemaVersion: number; mainModel: string };
  const rules = JSON.parse(await readFile(join(target, "permissions.json"), "utf8")) as { rules: Array<{ match: { fingerprint: string } }> };

  assert.equal(result.appHome, target);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.mainModel, "new/model");
  assert.notEqual(newId, oldId);
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, "shared-chat.json")), true);
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, `${newId}.json`)), true);
  assert.deepEqual(rules.rules.map((rule) => rule.match.fingerprint).sort(), ["e".repeat(64), "f".repeat(64)]);
});

test("dual-home rule merge applies deny precedence only within workspace tool and subject scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-rule-scope-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await seedHome(target);
  const fingerprint = "a".repeat(64);
  const base = {
    tool: "read_file",
    match: { kind: "exact-subject", fingerprint, display: "same subject" },
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  await writeFile(join(target, "permissions.json"), JSON.stringify({
    version: 2,
    rules: [{ ...base, id: "new-allow", workspace: WORKSPACE, decision: "allow" }],
  }));
  await writeFile(join(legacy, "permissions.json"), JSON.stringify({
    version: 2,
    rules: [
      { ...base, id: "legacy-deny", workspace: WORKSPACE, decision: "deny" },
      { ...base, id: "other-workspace", workspace: "/synthetic/other", decision: "allow" },
      { ...base, id: "other-tool", workspace: WORKSPACE, tool: "write_file", decision: "allow" },
    ],
  }));

  await migrateAppHome(target, legacy);
  const stored = JSON.parse(await readFile(join(target, "permissions.json"), "utf8")) as {
    rules: Array<{ workspace: string; tool: string; decision: string }>;
  };

  assert.deepEqual(
    stored.rules.map((rule) => [rule.workspace, rule.tool, rule.decision]).sort(),
    [
      ["/synthetic/other", "read_file", "allow"],
      [WORKSPACE, "read_file", "deny"],
      [WORKSPACE, "write_file", "allow"],
    ].sort(),
  );
});

test("app-home migration upgrades legacy v1 rules before the startup rule store opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-v1-rules-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const base = {
    workspace: WORKSPACE,
    tool: "read_file",
    decision: "allow",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  await writeFile(join(legacy, "permissions.json"), JSON.stringify({
    version: 1,
    rules: [
      { ...base, id: "safe-path", match: { kind: "path-glob", value: "src/index.ts" } },
      { ...base, id: "broad-command", tool: "run_command", match: { kind: "command-prefix", value: "git" } },
    ],
  }));

  await migrateAppHome(target, legacy);
  const stored = JSON.parse(await readFile(join(target, "permissions.json"), "utf8")) as {
    version: number;
    rules: Array<{ id: string; match: { kind: string; fingerprint?: string; reason?: string } }>;
  };

  assert.equal(stored.version, 2);
  assert.equal(
    stored.rules.find((rule) => rule.id === "safe-path")?.match.fingerprint,
    approvalSubjectFingerprint({ kind: "selected-path", path: "src/index.ts" }),
  );
  assert.equal(stored.rules.find((rule) => rule.id === "broad-command")?.match.kind, "disabled");
  assert.match(stored.rules.find((rule) => rule.id === "broad-command")?.match.reason ?? "", /not exact/);
});

test("an interrupted staged migration resumes idempotently with the same persisted chat ID map", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-resume-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const oldId = await seedHome(legacy);
  let interrupted = false;
  await assert.rejects(
    migrateAppHome(target, legacy, {
      onPhase: async (phase: string) => {
        if (phase === "staged" && !interrupted) {
          interrupted = true;
          throw new Error("synthetic crash after staging");
        }
      },
    } as never),
    /synthetic crash/,
  );
  const { migrationManifestPath } = await import("../src/storage.js");
  const before = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as { phase: string; chatIdMap: Record<string, string> };
  assert.equal(before.phase, "staged");
  assert.equal(await exists(legacy), true);

  const resumed = await migrateAppHome(target, legacy);
  const after = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as { phase: string; chatIdMap: Record<string, string> };
  assert.equal(resumed.appHome, target);
  assert.equal(after.phase, "complete");
  assert.equal(after.chatIdMap[oldId], before.chatIdMap[oldId]);
  assert.equal((await readdir(join(target, "chats", WORKSPACE_HASH))).filter((name) => name.endsWith(".json")).length, 1);
});

test("migration rejects an invalid manifest phase or path before touching its source staging or backup traps", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-manifest-trap-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const sourceTrap = join(root, "source-trap");
  const stagingTrap = join(root, "staging-trap");
  const backupTrap = join(root, "backup-trap");
  await seedHome(legacy);
  await seedHome(sourceTrap);
  await mkdir(stagingTrap);
  await writeFile(join(stagingTrap, "must-remain.txt"), "untouched");
  await mkdir(join(target, "migrations"), { recursive: true });
  await writeFile(join(target, "migrations", "app-home-v1.json"), JSON.stringify({
    version: 1,
    phase: "teleport",
    sourcePath: sourceTrap,
    sourceChecksum: "0".repeat(64),
    stagingPath: stagingTrap,
    backupPath: backupTrap,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: false,
    startedAt: "2026-08-20T00:00:00.000Z",
  }));

  const result = await migrateAppHome(target, legacy);

  assert.equal(await exists(sourceTrap), true);
  assert.equal(await readFile(join(stagingTrap, "must-remain.txt"), "utf8"), "untouched");
  assert.equal(await exists(backupTrap), false);
  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
});

test("migration revalidates the source checksum after validation and before commit or rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-checksum-drift-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);

  const result = await migrateAppHome(target, legacy, {
    onPhase: async (phase: string) => {
      if (phase === "validated") {
        await writeFile(join(legacy, "config.json"), JSON.stringify({ mainModel: "drifted/model" }));
      }
    },
  } as never);

  assert.equal(await exists(legacy), true);
  const manifest = JSON.parse(await readFile(join(target, "migrations", "app-home-v1.json"), "utf8")) as {
    chatIdMap: Record<string, string>;
  };
  const mappedId = manifest.chatIdMap["legacy-chat-a"]!;
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, `${mappedId}.json`)), false);
  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
});

test("legacy migration rebuilds from a source config writer that completes while ownership waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-source-writer-wins-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy, { model: "staged/old-source" });
  const writerBytes = `${JSON.stringify({
    schemaVersion: 0,
    mainModel: "writer/new-source",
    approvalMode: "allow-all",
    exactSourceMarker: "source-writer-complete",
  }, null, 2)}\n`;

  const result = await publishConfigBehindMigrationLockAttempt({
    target,
    legacy,
    blockedConfigPath: join(target, "config.json"),
    writerConfigPath: join(legacy, "config.json"),
    writerBytes,
  });
  const stored = JSON.parse(await readFile(join(target, "config.json"), "utf8")) as {
    mainModel: string;
    approvalMode: string;
  };
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as {
    backupPath: string;
  };

  assert.equal(result.status, "ready");
  assert.equal(stored.mainModel, "writer/new-source");
  assert.equal(stored.approvalMode, "allow-all");
  assert.equal(await readFile(join(manifest.backupPath, "config.json"), "utf8"), writerBytes);
});

test("legacy migration preserves destination v1 semantics when a complete writer update wins ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-destination-writer-wins-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy, { model: "legacy/staged-model" });
  await seedHome(target, { model: "destination/staged-old" });
  const writerBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "destination/writer-new",
    compressorModel: "destination/writer-compressor",
    fallbackModels: Array.from({ length: 21 }, (_value, index) => `destination/fallback-${index + 1}`),
    unrelatedWriterState: { exact: true, generation: 7 },
    providerSetup: {
      schemaVersion: 1,
      revision: 9,
      lifecycle: "configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  }, null, 4)}\n`;

  const result = await publishConfigBehindMigrationLockAttempt({
    target,
    legacy,
    blockedConfigPath: join(target, "config.json"),
    writerConfigPath: join(target, "config.json"),
    writerBytes,
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(JSON.parse(await readFile(join(target, "config.json"), "utf8")), JSON.parse(writerBytes));
});

test("app-home migration upgrades only nested provider setup V1 and does not create Kimi state", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-kimi-nested-state-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const configPath = join(legacy, "config.json");
  const original = {
    schemaVersion: 1,
    mainModel: "openai/gpt-5",
    providerSetup: {
      schemaVersion: 1,
      revision: 2,
      lifecycle: "configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  };
  await writeFile(configPath, `${JSON.stringify(original)}\n`);
  const outcome = await migrateAppHome(target, legacy);
  const migrated = JSON.parse(await readFile(join(target, "config.json"), "utf8")) as typeof original;
  assert.equal(outcome.status, "ready");
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.providerSetup.schemaVersion, 3);
  assert.deepEqual(migrated.providerSetup.connections, []);
  assert.equal(migrated.providerSetup.lifecycle, original.providerSetup.lifecycle);
  assert.deepEqual(migrated.providerSetup.cross, original.providerSetup.cross);
});

test("legacy migration refuses a destination future schema published while ownership waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-destination-future-wins-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy, { model: "legacy/staged-model" });
  await seedHome(target, { model: "destination/staged-old" });
  const writerBytes = `${JSON.stringify({
    schemaVersion: 2,
    mainModel: "future/writer-model",
    opaqueFutureState: { exact: "future-destination-writer" },
  }, null, 2)}\n`;

  const result = await publishConfigBehindMigrationLockAttempt({
    target,
    legacy,
    blockedConfigPath: join(target, "config.json"),
    writerConfigPath: join(target, "config.json"),
    writerBytes,
  });

  assert.equal(result.status, "future");
  assert.equal(await readFile(join(target, "config.json"), "utf8"), writerBytes);
  assert.equal(await exists(migrationManifestPath(target)), false);
  assert.equal(await exists(legacy), true);
});

test("migration refuses a symlinked legacy source before rename and leaves its target untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-source-symlink-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const outsideSource = join(root, "outside-source");
  await seedHome(outsideSource);
  const originalConfig = await readFile(join(outsideSource, "config.json"), "utf8");
  await symlink(outsideSource, legacy, "dir");

  const result = await migrateAppHome(target, legacy);

  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
  assert.equal(await exists(legacy), true);
  assert.equal((await lstat(legacy)).isSymbolicLink(), true);
  assert.equal(await exists(target), false, "ownership refusal happens before migration artifacts");
  assert.equal(await readFile(join(outsideSource, "config.json"), "utf8"), originalConfig);
});

test("legacy root rename holds the source config writer ownership through the move", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-source-config-lock-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const privateStore = new PrivateStore({ root: target });
  const originalRename = privateStore.renameTree.bind(privateStore);
  let renameReached!: () => void;
  let resumeRename!: () => void;
  const reached = new Promise<void>((resolve) => { renameReached = resolve; });
  const pause = new Promise<void>((resolve) => { resumeRename = resolve; });
  privateStore.renameTree = async (...args) => {
    if (args[0] === legacy) {
      renameReached();
      await pause;
    }
    return originalRename(...args);
  };
  const migration = migrateAppHome(target, legacy, { privateStore });
  await reached;

  const controller = new AbortController();
  const reason = new DOMException("stale legacy writer cancelled", "AbortError");
  let writerEntered = false;
  let releaseWriter!: () => void;
  const writerPause = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = withConfigWriteLock(join(legacy, "config.json"), async () => {
    writerEntered = true;
    await writerPause;
  }, { signal: controller.signal });
  const writerOutcomePromise = writer.then(
    () => null,
    (error: unknown) => error,
  );
  for (let turn = 0; turn < 1_000 && !writerEntered; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const enteredWhileRenamePaused = writerEntered;
  if (!writerEntered) {
    controller.abort(reason);
  }
  resumeRename();
  const result = await migration;
  for (let turn = 0; turn < 20 && !writerEntered; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (writerEntered) {
    releaseWriter();
  }
  const writerOutcome = await writerOutcomePromise;

  assert.equal(enteredWhileRenamePaused, false);
  void writerOutcome;
  assert.equal((result as typeof result & { status?: string }).status, "ready");
});

test("completed migration classifies a persistent nested future provider state before staging cleanup", async () => {
  const fixture = await completedManifestResumeFixture("orcode-migration-complete-future-provider-");
  const futureBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "future/after-complete",
    providerSetup: { schemaVersion: 99, opaque: "persistent-future-provider-state" },
  }, null, 2)}\n`;
  await writeFile(fixture.configPath, futureBytes);
  const before = await snapshotFileTree(fixture.target);

  const result = await migrateAppHome(fixture.target, fixture.legacy);

  assert.equal(result.status, "future");
  assert.deepEqual(await snapshotFileTree(fixture.target), before);
  assert.equal(await readFile(fixture.configPath, "utf8"), futureBytes);
  assert.equal(await readFile(join(fixture.stagingPath, "must-remain.txt"), "utf8"), "completed staging sentinel");
});

test("completed migration classifies corrupt provider state before staging cleanup", async () => {
  const fixture = await completedManifestResumeFixture("orcode-migration-complete-corrupt-provider-");
  const corruptBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "corrupt/after-complete",
    providerSetup: { schemaVersion: 1, connections: "not-an-array" },
  }, null, 2)}\n`;
  await writeFile(fixture.configPath, corruptBytes);
  const before = await snapshotFileTree(fixture.target);

  const result = await migrateAppHome(fixture.target, fixture.legacy);

  assert.equal(result.status, "recovery-required");
  assert.deepEqual(await snapshotFileTree(fixture.target), before);
  assert.equal(await readFile(fixture.configPath, "utf8"), corruptBytes);
  assert.equal(await readFile(join(fixture.stagingPath, "must-remain.txt"), "utf8"), "completed staging sentinel");
});

test("post-rename resume classifies a nested future provider state before staging or manifest effects", async () => {
  const fixture = await postRenameManifestResumeFixture("orcode-migration-post-rename-future-provider-");
  const futureBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "future/after-rename",
    providerSetup: { schemaVersion: 99, opaque: "post-rename-future-provider-state" },
  }, null, 2)}\n`;
  await writeFile(fixture.configPath, futureBytes);
  const before = await snapshotFileTree(fixture.target);

  const result = await migrateAppHome(fixture.target, fixture.legacy);

  assert.equal(result.status, "future");
  assert.deepEqual(await snapshotFileTree(fixture.target), before);
  assert.equal(await readFile(fixture.configPath, "utf8"), futureBytes);
  assert.equal(await readFile(join(fixture.stagingPath, "must-remain.txt"), "utf8"), "post-rename staging sentinel");
});

test("post-rename resume classifies corrupt provider state before staging or manifest effects", async () => {
  const fixture = await postRenameManifestResumeFixture("orcode-migration-post-rename-corrupt-provider-");
  const corruptBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "corrupt/after-rename",
    providerSetup: { schemaVersion: 1, connections: "not-an-array" },
  }, null, 2)}\n`;
  await writeFile(fixture.configPath, corruptBytes);
  const before = await snapshotFileTree(fixture.target);

  const result = await migrateAppHome(fixture.target, fixture.legacy);

  assert.equal(result.status, "recovery-required");
  assert.deepEqual(await snapshotFileTree(fixture.target), before);
  assert.equal(await readFile(fixture.configPath, "utf8"), corruptBytes);
  assert.equal(await readFile(join(fixture.stagingPath, "must-remain.txt"), "utf8"), "post-rename staging sentinel");
});

test("a complete manifest resumes exact staging cleanup before startup reports ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-cleanup-resume-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const checksum = createHash("sha256").digest("hex");
  const stagingPath = join(target, ".migration-staging", checksum);
  const backupPath = join(target, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  await mkdir(stagingPath, { recursive: true });
  await writeFile(join(stagingPath, "exact.tmp"), "exact bytes");
  await mkdir(backupPath, { recursive: true });
  await mkdir(join(target, "migrations"), { recursive: true });
  await writeFile(join(target, "migrations", "app-home-v1.json"), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: legacy,
    sourceChecksum: checksum,
    stagingPath,
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
  }));

  const result = await migrateAppHome(target, legacy);

  assert.equal(await exists(stagingPath), false);
  assert.equal((result as typeof result & { status?: string }).status, "ready");
});

test("a complete manifest with historical isolations never replays the isolation warning on later startups", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-isolation-replay-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const checksum = createHash("sha256").digest("hex");
  const stagingPath = join(target, ".migration-staging", checksum);
  const backupPath = join(target, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  await mkdir(join(target, "migrations"), { recursive: true });
  await writeFile(join(target, "migrations", "app-home-v1.json"), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: legacy,
    sourceChecksum: checksum,
    stagingPath,
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [
      { path: join(legacy, "chats", "ws", "broken-1.json"), reason: "parse failure" },
      { path: join(legacy, "chats", "ws", "broken-2.json"), reason: "parse failure" },
    ],
    complete: true,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
  }));

  const first = await migrateAppHome(target, legacy);
  const second = await migrateAppHome(target, legacy);

  assert.equal((first as typeof first & { status?: string }).status, "ready");
  assert.equal((first as typeof first & { warning?: string | null }).warning, null);
  assert.equal((second as typeof second & { warning?: string | null }).warning, null);
});

test("complete migration refuses symlinked staging cleanup without touching outside", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-cleanup-symlink-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const outside = join(root, "outside");
  const checksum = "a".repeat(64);
  const outsideStaging = join(outside, checksum);
  const victim = join(outsideStaging, "must-survive.txt");
  const stagingPath = join(target, ".migration-staging", checksum);
  const backupPath = join(target, "migration-backups", `routercode-${checksum.slice(0, 16)}`);
  await mkdir(outsideStaging, { recursive: true });
  await writeFile(victim, "outside exact bytes");
  await mkdir(target, { recursive: true });
  await symlink(outside, join(target, ".migration-staging"), "dir");
  await mkdir(backupPath, { recursive: true });
  await mkdir(join(target, "migrations"), { recursive: true });
  await writeFile(join(target, "migrations", "app-home-v1.json"), JSON.stringify({
    version: 1,
    phase: "complete",
    sourcePath: legacy,
    sourceChecksum: checksum,
    stagingPath,
    backupPath,
    chatIdMap: {},
    destinationPaths: [],
    isolated: [],
    complete: true,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
  }));

  const result = await migrateAppHome(target, legacy);

  assert.equal(await exists(victim), true);
  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
});

test("one corrupt chat and one corrupt run are isolated without blocking valid chats or runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-corrupt-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const goodId = await seedHome(legacy, { id: "good-chat" });
  await writeFile(join(legacy, "chats", WORKSPACE_HASH, "bad-chat.json"), "{broken");
  await mkdir(join(legacy, "runs", goodId), { recursive: true });
  await writeFile(join(legacy, "runs", goodId, "good-run.ndjson"), `${JSON.stringify({ type: "run-end", outcome: "complete", durationMs: 1, toolCount: 0, timestamp: 1 })}\n`);
  await writeFile(join(legacy, "runs", goodId, "bad-run.ndjson"), "not-json\n");

  const result = await migrateAppHome(target, legacy);
  const { migrationManifestPath } = await import("../src/storage.js");
  const manifest = JSON.parse(await readFile(migrationManifestPath(target), "utf8")) as { chatIdMap: Record<string, string>; isolated: Array<{ path: string; reason: string }> };
  const newId = manifest.chatIdMap[goodId]!;

  assert.match(result.warning ?? "", /isolated/i);
  assert.ok(manifest.isolated.some((item) => item.path.endsWith("bad-chat.json")));
  assert.ok(manifest.isolated.some((item) => item.path.endsWith("bad-run.ndjson")));
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, `${newId}.json`)), true);
  assert.equal(await exists(join(target, "runs", newId, "good-run.ndjson")), true);
  assert.equal(await exists(join(target, "runs", newId, "bad-run.ndjson")), false);
});

test("migration isolates complete SDK state and checkpoint files rejected by production validators", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-invalid-exact-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const oldId = await seedHome(legacy);
  const oldChatPath = join(legacy, "chats", WORKSPACE_HASH, `${oldId}.json`);
  await writeFile(`${oldChatPath}.state.json`, JSON.stringify({
    version: 1,
    revision: 1,
    chatId: oldId,
    turnCount: 1,
    updatedAt: "2026-08-20T10:01:00.000Z",
    state: "parseable outer JSON but invalid SDK state",
  }));
  await mkdir(join(legacy, "checkpoints", oldId), { recursive: true });
  await writeFile(join(legacy, "checkpoints", oldId, "run-a.json"), JSON.stringify([
    { path: "/synthetic/file", before: null, after: "after", createdAt: "2026-08-20T10:00:00.000Z", runId: "run-a" },
    { parseable: true, but: "not a ChangeEntry" },
  ]));

  const result = await migrateAppHome(target, legacy);
  const manifest = JSON.parse(await readFile(join(target, "migrations", "app-home-v1.json"), "utf8")) as {
    chatIdMap: Record<string, string>;
    isolated: Array<{ path: string }>;
  };
  const newId = manifest.chatIdMap[oldId]!;

  assert.match(result.warning ?? "", /2 .*isolated/i);
  assert.equal(await exists(join(target, "chats", WORKSPACE_HASH, `${newId}.json.state.json`)), false);
  assert.equal(await exists(join(target, "checkpoints", newId, "run-a.json")), false);
  assert.ok(manifest.isolated.some((item) => item.path.endsWith(".state.json")));
  assert.ok(manifest.isolated.some((item) => item.path.endsWith("run-a.json")));
});

test("unknown future schema refuses migration without overwriting either home", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-future-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await writeFile(join(legacy, "config.json"), JSON.stringify({ schemaVersion: 99, mainModel: "future/model" }));

  const before = await readFile(join(legacy, "config.json"), "utf8");
  const result = await migrateAppHome(target, legacy);

  assert.equal(result.appHome, legacy);
  assert.match(result.warning ?? "", /zukünftige|future|Version 99/i);
  assert.equal(await exists(target), false);
  assert.equal(await readFile(join(legacy, "config.json"), "utf8"), before);
});

test("an unknown future migration manifest is never replaced by an older writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-future-manifest-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const manifestPath = join(target, "migrations", "app-home-v1.json");
  await mkdir(join(target, "migrations"), { recursive: true });
  const future = JSON.stringify({ version: 99, phase: "future", complete: false });
  await writeFile(manifestPath, future);

  const result = await migrateAppHome(target, legacy);

  assert.equal(result.appHome, target);
  assert.match(result.warning ?? "", /Manifest.*Version 99|zukünftige/i);
  assert.equal(await readFile(manifestPath, "utf8"), future);
  assert.equal(await exists(legacy), true);
});

test("backup-over-limit aborts before any destination write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-large-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);

  const result = await migrateAppHome(target, legacy, { maxBackupBytes: 1 } as never);

  assert.equal(result.appHome, legacy);
  assert.match(result.warning ?? "", /archive|backups.*too large/i);
  assert.equal(await exists(target), false);
});

test("global backup ceiling preflights legacy config rewrite and existing managed backups before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-global-ceiling-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await seedHome(target, { model: "authoritative/model" });
  const targetConfig = JSON.stringify({ mainModel: "authoritative/model" });
  await writeFile(join(target, "config.json"), targetConfig);
  const existingBackup = join(target, "migration-backups", "existing.bin");
  await mkdir(join(target, "migration-backups"), { recursive: true });
  await writeFile(existingBackup, "b".repeat(4_096));
  const sourceBytes = await treeBytes(legacy);
  const limit = sourceBytes + Buffer.byteLength(targetConfig) + 100;

  const result = await migrateAppHome(target, legacy, { maxBackupBytes: limit } as never);

  assert.equal(await exists(join(target, "migrations", "app-home-v1.json")), false);
  assert.equal(await exists(legacy), true);
  assert.equal(await readFile(join(target, "config.json"), "utf8"), targetConfig);
  assert.equal((await stat(existingBackup)).size, 4_096);
  assert.equal((result as typeof result & { status?: string }).status, "declined");
  assert.match(result.warning ?? "", /backups.*too large|archive/i);
});

test("an unavailable exact-private boundary aborts before migration writes and keeps legacy readable", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-private-fail-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  const privateStore = new PrivateStore({
    adapter: {
      name: "unavailable-test-boundary",
      available: async () => false,
      protectDirectory: async () => undefined,
      protectFile: async () => undefined,
    },
  });

  const result = await migrateAppHome(target, legacy, { privateStore } as never);

  assert.equal(result.appHome, legacy);
  assert.match(result.warning ?? "", /privat|private|Berechtigung/i);
  assert.equal(await exists(target), false);
  assert.equal(await exists(join(legacy, "config.json")), true);
});

test("current-home v0 future provider state preflights before any migration write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-preflight-v0-future-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config.json"), JSON.stringify({
    schemaVersion: 0,
    mainModel: "vendor/main",
    providerSetup: { schemaVersion: 99, opaque: "future-bytes" },
  }));
  const before = await snapshotFileTree(target);

  const result = await migrateAppHome(target, legacy).catch(() => null);

  assert.deepEqual(await snapshotFileTree(target), before);
  assert.equal(result?.status, "future");
});

test("current-home v0 corrupt provider state preflights before any migration write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-preflight-v0-corrupt-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config.json"), JSON.stringify({
    schemaVersion: 0,
    mainModel: "vendor/main",
    providerSetup: { schemaVersion: 1, connections: "wrong" },
  }));
  const before = await snapshotFileTree(target);

  const result = await migrateAppHome(target, legacy).catch(() => null);

  assert.deepEqual(await snapshotFileTree(target), before);
  assert.equal(result?.status, "recovery-required");
});

test("current-home migration waits for a future provider writer and classifies its final valid bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-future-writer-final-valid-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const config = join(target, "config.json");
  await mkdir(target, { recursive: true });
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "temporary/future",
    providerSetup: { schemaVersion: 99, opaque: "temporary-future-state" },
  }, null, 2)}\n`);
  const finalBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "writer/final-valid",
    unrelatedWriterState: { generation: 11, exact: true },
    providerSetup: {
      schemaVersion: 1,
      revision: 11,
      lifecycle: "configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  }, null, 4)}\n`;

  const result = await publishConfigBehindMigrationLockAttempt({
    target,
    legacy,
    blockedConfigPath: config,
    writerConfigPath: config,
    writerBytes: finalBytes,
  });

  assert.equal(result.status, "ready");
  const expected = JSON.parse(finalBytes) as { providerSetup: { schemaVersion: number } };
  expected.providerSetup.schemaVersion = 3;
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), expected);
  assert.equal(await exists(migrationManifestPath(target)), false);
});

test("current-home migration waits for a corrupt provider writer and classifies its final valid bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-corrupt-writer-final-valid-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const config = join(target, "config.json");
  await mkdir(target, { recursive: true });
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "temporary/corrupt",
    providerSetup: { schemaVersion: 1, connections: "wrong" },
  }, null, 2)}\n`);
  const finalBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "writer/final-valid-after-corrupt",
    unrelatedWriterState: { generation: 12, exact: true },
    providerSetup: {
      schemaVersion: 1,
      revision: 12,
      lifecycle: "configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  }, null, 4)}\n`;

  const result = await publishConfigBehindMigrationLockAttempt({
    target,
    legacy,
    blockedConfigPath: config,
    writerConfigPath: config,
    writerBytes: finalBytes,
  });

  assert.equal(result.status, "ready");
  const expected = JSON.parse(finalBytes) as { providerSetup: { schemaVersion: number } };
  expected.providerSetup.schemaVersion = 3;
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), expected);
  assert.equal(await exists(migrationManifestPath(target)), false);
});

test("legacy-home future provider state preflights before target artifacts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-preflight-legacy-future-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await writeFile(join(legacy, "config.json"), JSON.stringify({
    mainModel: "vendor/main",
    providerSetup: { schemaVersion: 99, opaque: "future-bytes" },
  }));
  const before = await snapshotFileTree(legacy);

  const result = await migrateAppHome(target, legacy).catch(() => null);

  assert.equal(await exists(target), false);
  assert.deepEqual(await snapshotFileTree(legacy), before);
  assert.equal(result?.status, "future");
  assert.equal(result?.appHome, legacy);
});

test("legacy-home corrupt provider state preflights before target artifacts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-preflight-legacy-corrupt-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacy);
  await writeFile(join(legacy, "config.json"), JSON.stringify({
    mainModel: "vendor/main",
    providerSetup: { schemaVersion: 1, connections: "wrong" },
  }));
  const before = await snapshotFileTree(legacy);

  const result = await migrateAppHome(target, legacy).catch(() => null);

  assert.equal(await exists(target), false);
  assert.deepEqual(await snapshotFileTree(legacy), before);
  assert.equal(result?.status, "recovery-required");
  assert.equal(result?.appHome, legacy);
});

test("new-only unversioned config is validated and atomically upgraded with one private backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-config-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(target, { model: "new-only/model" });
  await writeFile(
    join(target, "config.json"),
    JSON.stringify({ mainModel: "new-only/model", approvalMode: "unsafe", maxSteps: 0 }),
  );
  const original = await readFile(join(target, "config.json"), "utf8");

  const first = await migrateAppHome(target, legacy);
  const second = await migrateAppHome(target, legacy);
  const upgraded = JSON.parse(await readFile(join(target, "config.json"), "utf8")) as { schemaVersion: number; mainModel: string };
  const backups = await readdir(join(target, "migration-backups"));

  assert.equal(first.appHome, target);
  assert.equal(second.appHome, target);
  assert.equal(upgraded.schemaVersion, 1);
  assert.equal(upgraded.mainModel, "new-only/model");
  assert.equal((upgraded as { approvalMode?: string }).approvalMode, "ask");
  assert.equal((upgraded as { maxSteps?: number }).maxSteps, 12);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(target, "migration-backups", backups[0]!), "utf8"), original);
});

test("current-home migration rejects a symlinked config target without replacing outside bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-current-config-symlink-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const outside = join(root, "outside.json");
  const config = join(target, "config.json");
  const sentinel = '{"outside":"migration-secret-sentinel"}\n';
  await mkdir(target, { recursive: true });
  await writeFile(outside, sentinel, "utf8");
  await symlink(outside, config);

  const result = await migrateAppHome(target, legacy);

  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
  assert.equal((await lstat(config)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), sentinel);
  assert.doesNotMatch(String(result.warning), /migration-secret-sentinel/);
});

test("current-home migration refuses a config target swapped before atomic publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-current-config-swap-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const config = join(target, "config.json");
  const originalCopy = join(target, "config.original.json");
  const outside = join(root, "outside.json");
  const sentinel = '{"outside":"swap-secret-sentinel"}\n';
  await mkdir(target, { recursive: true });
  await writeFile(config, JSON.stringify({ mainModel: "legacy/model" }), "utf8");
  await writeFile(outside, sentinel, "utf8");
  const privateStore = new PrivateStore({ root: target });
  type AtomicWrite = (
    path: string,
    content: string,
    beforePublish?: () => Promise<void>,
  ) => Promise<void>;
  const originalWrite = privateStore.writeTextAtomic.bind(privateStore) as AtomicWrite;
  let swapped = false;
  privateStore.writeTextAtomic = (async (path, content, beforePublish) => {
    if (path === config && !swapped) {
      swapped = true;
      await rename(config, originalCopy);
      await symlink(outside, config);
    }
    return originalWrite(path, content, beforePublish);
  }) as typeof privateStore.writeTextAtomic;

  const result = await migrateAppHome(target, legacy, { privateStore });

  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
  assert.equal((await lstat(config)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), sentinel);
  assert.equal(await exists(originalCopy), true);
  assert.doesNotMatch(String(result.warning), /swap-secret-sentinel/);
});

test("v0 config with valid nested provider state still normalizes legacy top-level fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-v0-valid-provider-normalize-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config.json"), JSON.stringify({
    schemaVersion: 0,
    mainModel: "vendor/main",
    approvalMode: "unsafe",
    maxSteps: 0,
    providerSetup: {
      schemaVersion: 1,
      revision: 0,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  }));

  await migrateAppHome(target, legacy);
  const stored = JSON.parse(await readFile(join(target, "config.json"), "utf8")) as {
    approvalMode: string;
    maxSteps: number;
    providerSetup: { lifecycle: string };
  };

  assert.equal(stored.approvalMode, "ask");
  assert.equal(stored.maxSteps, 12);
  assert.equal(stored.providerSetup.lifecycle, "never-configured");
});

test("current v1 config upgrades nested provider state and preserves every model preference", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-v1-provider-byte-stability-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  const originalBytes = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: " vendor/main ",
    compressorModel: " vendor/compressor ",
    fallbackModels: [
      "vendor/fallback-01",
      "vendor/fallback-02",
      "vendor/fallback-03",
      "vendor/fallback-04",
      "vendor/fallback-05",
      "vendor/fallback-06",
      "vendor/fallback-07",
      "vendor/fallback-08",
      "vendor/fallback-09",
      "vendor/fallback-10",
      "vendor/fallback-11",
      "vendor/fallback-12",
      "vendor/fallback-13",
      "vendor/fallback-14",
      "vendor/fallback-15",
      "vendor/fallback-16",
      "vendor/fallback-17",
      "vendor/fallback-18",
      "vendor/fallback-19",
      "vendor/fallback-20",
      "vendor/fallback-21",
    ],
    providerSetup: {
      schemaVersion: 1,
      revision: 0,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
  }, null, 4)}\n`;
  await writeFile(join(target, "config.json"), originalBytes);

  const result = await migrateAppHome(target, legacy);
  const storedBytes = await readFile(join(target, "config.json"), "utf8");
  const stored = JSON.parse(storedBytes) as {
    mainModel: string;
    compressorModel: string;
    fallbackModels: string[];
    providerSetup: { schemaVersion: number };
  };

  assert.equal(result.status, "ready");
  assert.deepEqual(
    {
      mainModel: stored.mainModel,
      compressorModel: stored.compressorModel,
      fallbackCount: stored.fallbackModels.length,
      lastFallback: stored.fallbackModels.at(-1),
    },
    {
      mainModel: " vendor/main ",
      compressorModel: " vendor/compressor ",
      fallbackCount: 21,
      lastFallback: "vendor/fallback-21",
    },
  );
  assert.notEqual(storedBytes, originalBytes);
  assert.equal(stored.providerSetup.schemaVersion, 3);
});

test("a current top-level config persists source-aware provider migration once", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-current-provider-config-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  const original = JSON.stringify({
    schemaVersion: 1,
    mainModel: "vendor/current/model",
  });
  await writeFile(join(target, "config.json"), original);
  let uuidCalls = 0;
  const options = {
    randomUUID: () => {
      uuidCalls += 1;
      return `current-provider-${uuidCalls}`;
    },
  } as never;

  const first = await migrateAppHome(target, legacy, options);
  const firstBytes = await readFile(join(target, "config.json"), "utf8");
  const second = await migrateAppHome(target, legacy, options);
  const backupDirectory = join(target, "migration-backups");
  assert.equal(await exists(backupDirectory), true);
  const backups = await readdir(backupDirectory);
  const stored = JSON.parse(firstBytes) as {
    providerSetup: { lifecycle: string; connections: Array<{ id: string }> };
  };

  assert.equal(first.appHome, target);
  assert.equal(second.appHome, target);
  assert.equal(stored.providerSetup.lifecycle, "migrated");
  assert.equal(stored.providerSetup.connections[0]?.id, "current-provider-1");
  assert.equal(uuidCalls, 1);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(backupDirectory, backups[0]!), "utf8"), original);
  assert.equal(await readFile(join(target, "config.json"), "utf8"), firstBytes);
});

test("committed v0 app-home fixture migrates through real startup without external access and is byte-idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-historical-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyHome = join(root, ".routercode");
  const appHome = join(root, ".orcode");
  await cp(HISTORICAL_FIXTURE_ROOT, legacyHome, { recursive: true });
  const fixtureSnapshot = await snapshotFileTree(HISTORICAL_FIXTURE_ROOT);
  const fixtureChatPath = join(
    HISTORICAL_FIXTURE_ROOT,
    "chats",
    HISTORICAL_FIXTURE_HASH,
    `${HISTORICAL_FIXTURE_CHAT_ID}.json`,
  );
  const expectedChat = JSON.parse(await readFile(fixtureChatPath, "utf8")) as Record<string, unknown>;
  const expectedState = JSON.parse(await readFile(`${fixtureChatPath}.state.json`, "utf8")) as {
    chatId: string;
    state: string;
  } & Record<string, unknown>;
  const expectedRun = (await readFile(
    join(HISTORICAL_FIXTURE_ROOT, "runs", HISTORICAL_FIXTURE_CHAT_ID, "fixture-run.ndjson"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const expectedCheckpointBytes = await readFile(
    join(HISTORICAL_FIXTURE_ROOT, "checkpoints", HISTORICAL_FIXTURE_CHAT_ID, "fixture-run.json"),
  );

  let networkCalls = 0;
  let credentialCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalGet = CredentialStore.prototype.get;
  const originalSet = CredentialStore.prototype.set;
  const originalDelete = CredentialStore.prototype.delete;
  const originalHas = CredentialStore.prototype.has;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("historical fixture startup must remain offline");
  }) as typeof fetch;
  CredentialStore.prototype.get = async function() {
    credentialCalls += 1;
    throw new Error("historical fixture startup must not read credentials");
  };
  CredentialStore.prototype.set = async function() {
    credentialCalls += 1;
    throw new Error("historical fixture startup must not write credentials");
  };
  CredentialStore.prototype.delete = async function() {
    credentialCalls += 1;
    throw new Error("historical fixture startup must not delete credentials");
  };
  CredentialStore.prototype.has = async function() {
    credentialCalls += 1;
    throw new Error("historical fixture startup must not inspect credentials");
  };

  const start = () => initializeStartupStorage(
    // D8c: a bare launch now starts a fresh chat by default (Controller
    // ruling 1/2) — this test inspects the migrated chat itself, so it opts
    // into the old "continue the most recently used chat" default explicitly
    // via `continueChat`, exactly like a real `--continue` launch would.
    { workspace: HISTORICAL_FIXTURE_WORKSPACE, newChat: false, continueChat: true },
    {
      migrateAppHome: () => migrateAppHome(appHome, legacyHome, {
        randomUUID: () => "fixture-provider-id",
      } as never),
      pruneRunLogs: async () => undefined,
      pruneCheckpoints: async () => undefined,
      pruneBrowserTempArtifacts: async () => undefined,
    },
  );

  try {
    const first = await start();
    const manifest = JSON.parse(await readFile(migrationManifestPath(appHome), "utf8")) as {
      version: number;
      phase: string;
      complete: boolean;
      backupPath: string;
      chatIdMap: Record<string, string>;
    };
    const currentChatId = manifest.chatIdMap[HISTORICAL_FIXTURE_CHAT_ID]!;
    assert.match(currentChatId, /^legacy-[a-f0-9]{32}$/);
    assert.notEqual(currentChatId, HISTORICAL_FIXTURE_CHAT_ID);
    assert.equal(first.appHome, appHome);
    assert.equal(first.migrationWarning, null);
    assert.equal(first.session.data.id, currentChatId);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.phase, "complete");
    assert.equal(manifest.complete, true);
    assert.equal(await exists(legacyHome), false);

    const migratedChatPath = join(appHome, "chats", HISTORICAL_FIXTURE_HASH, `${currentChatId}.json`);
    const migratedChat = JSON.parse(await readFile(migratedChatPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual({ ...migratedChat, id: HISTORICAL_FIXTURE_CHAT_ID }, expectedChat);
    assert.equal(migratedChat.version, 2);

    const migratedState = parseConversationStateFile(
      await readFile(`${migratedChatPath}.state.json`, "utf8"),
      currentChatId,
      deserializeConversationState,
    );
    assert.deepEqual(
      { ...migratedState, chatId: HISTORICAL_FIXTURE_CHAT_ID },
      expectedState,
    );
    assert.deepEqual(
      deserializeConversationState(migratedState.state).messages,
      [{ role: "user", content: "Historische SDK-Nachricht" }],
    );

    const migratedRun = (await readFile(
      join(appHome, "runs", currentChatId, "fixture-run.ndjson"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      version: number;
      event: Record<string, unknown>;
    });
    assert.deepEqual(migratedRun.map((line) => line.version), [1, 1, 1]);
    assert.deepEqual(migratedRun.map((line) => line.event), expectedRun);

    const migratedCheckpointPath = join(appHome, "checkpoints", currentChatId, "fixture-run.json");
    const migratedCheckpointBytes = await readFile(migratedCheckpointPath);
    assert.deepEqual(migratedCheckpointBytes, expectedCheckpointBytes);
    assert.equal(parseCheckpointEntries(migratedCheckpointBytes.toString("utf8"), "fixture-run").length, 1);

    const storedConfig = JSON.parse(await readFile(join(appHome, "config.json"), "utf8")) as {
      schemaVersion: number;
      mainModel: string;
      compressorModel: string;
      reasoningByModel: Record<string, unknown>;
      verify: Record<string, unknown>;
      providerSetup: {
        schemaVersion: number;
        lifecycle: string;
        connections: Array<{
          id: string;
          credentialBinding: { kind: string; pointer: string };
          accountFingerprint: string;
        }>;
        defaultRoute: { requestedModelId: string; canonicalModelId: string | null; resolutionState: string } | null;
      };
    };
    assert.equal(storedConfig.schemaVersion, 1);
    assert.equal(storedConfig.mainModel, "synthetic/main-v0");
    assert.equal(storedConfig.compressorModel, "synthetic/compressor-v0");
    assert.deepEqual(storedConfig.reasoningByModel["synthetic/main-v0"], { mode: "effort", effort: "high" });
    assert.deepEqual(storedConfig.verify, {
      commands: ["npm test -- --fixture"],
      mode: "on-edit",
      maxRepairRounds: 1,
    });
    assert.equal(storedConfig.providerSetup.schemaVersion, 3);
    assert.equal(storedConfig.providerSetup.lifecycle, "migrated");
    assert.deepEqual(storedConfig.providerSetup.connections[0], {
      id: "fixture-provider-id",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain", pointer: "legacy:inference" },
      accountFingerprint: "acct_legacy_fixture-provider-id",
      accountFingerprintState: "provisional",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    });
    assert.equal(storedConfig.providerSetup.defaultRoute?.requestedModelId, "synthetic/main-v0");
    assert.equal(storedConfig.providerSetup.defaultRoute?.canonicalModelId, null);
    assert.equal(storedConfig.providerSetup.defaultRoute?.resolutionState, "legacy-unverified");
    assert.equal("maxRounds" in storedConfig.verify, false);
    assert.deepEqual(first.config.verify, storedConfig.verify);

    const storedRules = JSON.parse(await readFile(join(appHome, "permissions.json"), "utf8")) as {
      version: number;
      rules: Array<{ id: string; match: { kind: string; fingerprint?: string; reason?: string } }>;
    };
    assert.equal(storedRules.version, 2);
    assert.equal(storedRules.rules.length, 2);
    assert.equal(
      storedRules.rules.find((rule) => rule.id === "fixture-safe-path")?.match.fingerprint,
      approvalSubjectFingerprint({ kind: "selected-path", path: "src/legacy.ts" }),
    );
    assert.equal(
      storedRules.rules.find((rule) => rule.id === "fixture-command-prefix")?.match.kind,
      "disabled",
    );
    assert.match(
      storedRules.rules.find((rule) => rule.id === "fixture-command-prefix")?.match.reason ?? "",
      /not exact/,
    );
    assert.deepEqual(
      first.ruleStore.list(HISTORICAL_FIXTURE_WORKSPACE).map((rule) => ({
        id: rule.id,
        decision: rule.decision,
        match: rule.match.kind,
      })),
      [
        { id: "fixture-safe-path", decision: "allow", match: "exact-subject" },
        { id: "fixture-command-prefix", decision: "allow", match: "disabled" },
      ],
    );

    assert.deepEqual(await snapshotFileTree(manifest.backupPath), fixtureSnapshot);
    const beforeSecondStart = await snapshotFileTree(appHome);
    const firstRuntimeState = {
      config: first.config,
      session: first.session.data,
      rules: first.ruleStore.list(HISTORICAL_FIXTURE_WORKSPACE),
    };
    const second = await start();
    assert.deepEqual(await snapshotFileTree(appHome), beforeSecondStart);
    assert.deepEqual(
      {
        config: second.config,
        session: second.session.data,
        rules: second.ruleStore.list(HISTORICAL_FIXTURE_WORKSPACE),
      },
      firstRuntimeState,
    );
    assert.equal(networkCalls, 0);
    assert.equal(credentialCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    CredentialStore.prototype.get = originalGet;
    CredentialStore.prototype.set = originalSet;
    CredentialStore.prototype.delete = originalDelete;
    CredentialStore.prototype.has = originalHas;
  }
});

test("historical startup preserves every model role and creates one local migrated OpenRouter connection without provider or credential access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orcode-historical-provider-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyHome = join(root, ".routercode");
  const appHome = join(root, ".orcode");
  await cp(HISTORICAL_FIXTURE_ROOT, legacyHome, { recursive: true });
  const configPath = join(legacyHome, "config.json");
  const legacyConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  Object.assign(legacyConfig, {
    mainModel: "synthetic/main-v0",
    fallbackModels: ["synthetic/fallback-a-v0", "synthetic/fallback-b-v0"],
    compressorModel: "synthetic/compressor-v0",
    transcriptionModel: "synthetic/transcription-v0",
    panelModels: ["synthetic/panel-a-v0", "synthetic/panel-b-v0", "synthetic/panel-c-v0"],
    reasoningByModel: {
      "synthetic/main-v0": { mode: "effort", effort: "high" },
      "synthetic/fallback-a-v0": { mode: "effort", effort: "low" },
      "synthetic/panel-b-v0": { mode: "auto" },
    },
  });
  await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
  const firstChatPath = join(
    legacyHome,
    "chats",
    HISTORICAL_FIXTURE_HASH,
    `${HISTORICAL_FIXTURE_CHAT_ID}.json`,
  );
  const secondChatId = "legacy-fixture-chat-second";
  const secondChat = JSON.parse(await readFile(firstChatPath, "utf8")) as Record<string, unknown>;
  Object.assign(secondChat, {
    id: secondChatId,
    title: "Historischer zweiter Provider-Chat",
    model: "synthetic/session-second-v0",
    createdAt: "2024-08-21T09:59:00.000Z",
    updatedAt: "2024-08-21T10:01:00.000Z",
  });
  await writeFile(
    join(legacyHome, "chats", HISTORICAL_FIXTURE_HASH, `${secondChatId}.json`),
    `${JSON.stringify(secondChat, null, 2)}\n`,
  );

  let credentialCalls = 0;
  let networkCalls = 0;
  let capturedConnection: ProviderConnectionStateV3 | undefined;
  const originalFetch = globalThis.fetch;
  const originalGet = CredentialStore.prototype.get;
  const originalSet = CredentialStore.prototype.set;
  const originalDelete = CredentialStore.prototype.delete;
  const originalHas = CredentialStore.prototype.has;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("provider-role migration must remain offline");
  }) as typeof fetch;
  CredentialStore.prototype.get = async function() {
    credentialCalls += 1;
    return null;
  };
  CredentialStore.prototype.set = async function() {
    credentialCalls += 1;
  };
  CredentialStore.prototype.delete = async function() {
    credentialCalls += 1;
    return false;
  };
  CredentialStore.prototype.has = async function() {
    credentialCalls += 1;
    return false;
  };

  try {
    const startup = await initializeStartupStorage(
      { workspace: HISTORICAL_FIXTURE_WORKSPACE, newChat: false },
      {
        migrateAppHome: () => migrateAppHome(appHome, legacyHome, {
          randomUUID: () => "task-ten-migrated-connection",
        } as never),
        pruneRunLogs: async () => undefined,
        pruneCheckpoints: async () => undefined,
        pruneBrowserTempArtifacts: async () => undefined,
        openSession: (async (...args: unknown[]) => {
          const [workspace, selectedHome, , providerConnection] = args as [
            string,
            string,
            { newChat: boolean },
            ProviderConnectionStateV3 | undefined,
          ];
          capturedConnection = providerConnection;
          return SessionStore.open(workspace, selectedHome, providerConnection);
        }) as never,
      },
    );
    assert.ok(capturedConnection);
    if ("kind" in startup.config.providerSetup) assert.fail("provider state must be current");
    assert.equal(startup.config.providerSetup.connections.length, 1);
    assert.equal(
      requireKeychainCredentialPointer(startup.config.providerSetup.connections[0]!),
      "legacy:inference",
    );
    assert.equal(startup.config.providerSetup.connections[0]?.id, "task-ten-migrated-connection");
    assert.equal(startup.config.mainModel, "synthetic/main-v0");
    assert.deepEqual(startup.config.fallbackModels, [
      "synthetic/fallback-a-v0",
      "synthetic/fallback-b-v0",
    ]);
    assert.equal(startup.config.compressorModel, "synthetic/compressor-v0");
    assert.equal(startup.config.transcriptionModel, "synthetic/transcription-v0");
    assert.deepEqual(startup.config.panelModels, [
      "synthetic/panel-a-v0",
      "synthetic/panel-b-v0",
      "synthetic/panel-c-v0",
    ]);
    assert.deepEqual(Object.keys(startup.config.reasoningByModel).sort(), [
      "synthetic/fallback-a-v0",
      "synthetic/main-v0",
      "synthetic/panel-b-v0",
    ]);
    const projection = projectLegacyModelRoutes({
      mainModel: startup.config.mainModel,
      fallbackModels: startup.config.fallbackModels,
      compressorModel: startup.config.compressorModel,
      transcriptionModel: startup.config.transcriptionModel,
      panelModels: startup.config.panelModels,
      reasoningByModel: startup.config.reasoningByModel,
    }, capturedConnection);
    assert.deepEqual(
      [
        projection.default.requestedModelId,
        ...projection.fallbacks.map((route) => route.requestedModelId),
        projection.compressor.requestedModelId,
        projection.transcription.requestedModelId,
        ...projection.panel.map((route) => route.requestedModelId),
        ...Object.keys(projection.reasoning).sort(),
      ],
      [
        "synthetic/main-v0",
        "synthetic/fallback-a-v0",
        "synthetic/fallback-b-v0",
        "synthetic/compressor-v0",
        "synthetic/transcription-v0",
        "synthetic/panel-a-v0",
        "synthetic/panel-b-v0",
        "synthetic/panel-c-v0",
        "synthetic/fallback-a-v0",
        "synthetic/main-v0",
        "synthetic/panel-b-v0",
      ],
    );
    assert.equal(startup.session.data.route?.requestedModelId, "synthetic/session-second-v0");
    assert.equal(startup.session.data.route?.resolutionState, "legacy-unverified");
    assert.equal(networkCalls, 0);
    assert.equal(credentialCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    CredentialStore.prototype.get = originalGet;
    CredentialStore.prototype.set = originalSet;
    CredentialStore.prototype.delete = originalDelete;
    CredentialStore.prototype.has = originalHas;
  }
});

test("historical chats persist migrated routes independently and second open-save is stable", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-historical-route-stability-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const workspace = "/fixture/task-ten-route-workspace";
  const workspaceHash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const chatDirectory = join(appHome, "chats", workspaceHash);
  await mkdir(chatDirectory, { recursive: true });
  const firstId = "historical-route-chat-a";
  const secondId = "historical-route-chat-b";
  const sessionFixture = (id: string, model: string, updatedAt: string) => ({
    version: 2,
    id,
    title: id,
    workspace,
    summary: "",
    turns: [],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model,
    reasoning: { mode: "auto" },
    revision: 3,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: "2024-08-20T10:00:00.000Z",
    updatedAt,
  });
  const firstPath = join(chatDirectory, `${firstId}.json`);
  const secondPath = join(chatDirectory, `${secondId}.json`);
  await writeFile(firstPath, `${JSON.stringify(sessionFixture(
    firstId,
    "synthetic/session-route-a",
    "2024-08-20T10:01:00.000Z",
  ), null, 2)}\n`);
  await writeFile(secondPath, `${JSON.stringify(sessionFixture(
    secondId,
    "synthetic/session-route-b",
    "2024-08-21T10:01:00.000Z",
  ), null, 2)}\n`);
  const provisional: ProviderConnectionStateV3 = {
    id: "task-ten-legacy-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain", pointer: "legacy:inference" },
    accountFingerprint: "acct_legacy_task-ten-legacy-connection",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };

  const originalSecond = await readFile(secondPath, "utf8");
  const first = await SessionStore.openById(workspace, firstId, appHome, provisional);
  assert.equal(first.data.route?.requestedModelId, "synthetic/session-route-a");
  await first.save();
  assert.equal(await readFile(secondPath, "utf8"), originalSecond);
  const firstPersisted = await readFile(firstPath, "utf8");
  const firstAgain = await SessionStore.openById(workspace, firstId, appHome, provisional);
  const firstNoop = await firstAgain.save();
  assert.equal(await readFile(firstPath, "utf8"), firstPersisted);
  assert.equal(firstNoop.revision, firstAgain.data.revision);

  const verified: ProviderConnectionStateV3 = {
    ...provisional,
    accountFingerprint: "acct_or_task_ten_verified",
    accountFingerprintState: "verified",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 20,
      generation: 2,
    },
  };
  const second = await SessionStore.openById(workspace, secondId, appHome, verified);
  assert.equal(second.data.route?.requestedModelId, "synthetic/session-route-b");
  assert.equal(second.data.route?.accountFingerprint, verified.accountFingerprint);
  await second.save();
  assert.equal(await readFile(firstPath, "utf8"), firstPersisted);
  const secondPersisted = await readFile(secondPath, "utf8");
  const secondAgain = await SessionStore.openById(workspace, secondId, appHome, verified);
  await secondAgain.save();
  assert.equal(await readFile(secondPath, "utf8"), secondPersisted);
  const beforeSecondStartup = await snapshotFileTree(appHome);
  const startup = await SessionStore.open(workspace, appHome, verified);
  await startup.save();
  assert.deepEqual(await snapshotFileTree(appHome), beforeSecondStartup);
});

test("verified migrated connection lazily derives a historical route before persistence", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-verified-historical-route-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const workspace = "/fixture/task-ten-verified-route-workspace";
  const workspaceHash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  const chatDirectory = join(appHome, "chats", workspaceHash);
  await mkdir(chatDirectory, { recursive: true });
  const chatId = "verified-historical-route-chat";
  await writeFile(join(chatDirectory, `${chatId}.json`), `${JSON.stringify({
    version: 2,
    id: chatId,
    title: "Verified historical route",
    workspace,
    summary: "",
    turns: [],
    costs: { mainUsd: 0, compressorUsd: 0, voiceUsd: 0, totalUsd: 0 },
    model: "synthetic/verified-historical-model",
    reasoning: { mode: "auto" },
    revision: 1,
    checkpoints: [],
    toolCalls: [],
    dailySpendUsd: {},
    createdAt: "2024-08-20T10:00:00.000Z",
    updatedAt: "2024-08-20T10:01:00.000Z",
  }, null, 2)}\n`);
  const connection: ProviderConnectionStateV3 = {
    id: "task-ten-verified-legacy-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain", pointer: "legacy:inference" },
    accountFingerprint: "acct_or_task_ten_verified_historical",
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 50,
      generation: 5,
    },
  };

  const session = await SessionStore.openById(workspace, chatId, appHome, connection);

  assert.deepEqual(session.data.route, {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: connection.accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/verified-historical-model",
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  });
});

test("future and corrupt provider homes remain byte-identical and stop before setup credential deletion or network", async (t) => {
  for (const fixture of [
    { name: "future", providerSetup: { schemaVersion: 99, opaque: "safe-future-provider-state" } },
    { name: "corrupt", providerSetup: { schemaVersion: 1, connections: "invalid" } },
  ] as const) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), `orcode-provider-${fixture.name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const appHome = join(root, ".orcode");
      const legacyHome = join(root, ".routercode");
      await mkdir(appHome, { recursive: true });
      await writeFile(join(appHome, "config.json"), `${JSON.stringify({
        schemaVersion: 1,
        mainModel: "synthetic/safe-model",
        providerSetup: fixture.providerSetup,
      })}\n`);
      await writeFile(join(appHome, "sentinel.txt"), "safe-sentinel\n");
      const before = await snapshotFileTree(appHome);
      let credentialCalls = 0;
      let networkCalls = 0;
      let setupCalls = 0;
      let sessionCalls = 0;
      const originalFetch = globalThis.fetch;
      const originalGet = CredentialStore.prototype.get;
      const originalSet = CredentialStore.prototype.set;
      const originalDelete = CredentialStore.prototype.delete;
      const originalHas = CredentialStore.prototype.has;
      globalThis.fetch = (async () => {
        networkCalls += 1;
        throw new Error("network forbidden");
      }) as typeof fetch;
      CredentialStore.prototype.get = async function() {
        credentialCalls += 1;
        return null;
      };
      CredentialStore.prototype.set = async function() {
        credentialCalls += 1;
      };
      CredentialStore.prototype.delete = async function() {
        credentialCalls += 1;
        return false;
      };
      CredentialStore.prototype.has = async function() {
        credentialCalls += 1;
        return false;
      };
      try {
        const error = await initializeStartupStorage(
          { workspace: HISTORICAL_FIXTURE_WORKSPACE, newChat: false },
          {
            migrateAppHome: () => migrateAppHome(appHome, legacyHome),
            pruneRunLogs: async () => undefined,
            pruneCheckpoints: async () => undefined,
            pruneBrowserTempArtifacts: async () => undefined,
            loadRules: (async () => {
              setupCalls += 1;
              throw new Error("post-migration setup forbidden");
            }) as never,
            openSession: (async () => {
              sessionCalls += 1;
              throw new Error("post-migration session forbidden");
            }) as never,
          },
        ).then(
          () => null,
          (reason: unknown) => reason,
        );
        assert.ok(error instanceof Error);
        assert.doesNotMatch(String(error), /credential|network forbidden|post-migration|creator_user_id/i);
        assert.deepEqual(await snapshotFileTree(appHome), before);
        assert.equal(credentialCalls, 0);
        assert.equal(networkCalls, 0);
        assert.equal(setupCalls, 0);
        assert.equal(sessionCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
        CredentialStore.prototype.get = originalGet;
        CredentialStore.prototype.set = originalSet;
        CredentialStore.prototype.delete = originalDelete;
        CredentialStore.prototype.has = originalHas;
      }
    });
  }
});

test("current v1 config without appearance keeps additive defaults through migrateAppHome while explicit and legacy values survive", async () => {
  const providerSetup = {
    schemaVersion: 2,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };

  const fastRoot = await mkdtemp(join(tmpdir(), "orcode-appearance-fast-path-"));
  const fastTarget = join(fastRoot, ".orcode");
  await mkdir(fastTarget, { recursive: true });
  const fastBytes = `${JSON.stringify({ schemaVersion: 1, mainModel: "vendor/main", providerSetup }, null, 2)}\n`;
  await writeFile(join(fastTarget, "config.json"), fastBytes);
  const fastResult = await migrateAppHome(fastTarget, join(fastRoot, ".routercode"));
  assert.equal(fastResult.status, "ready");
  const fastStored = JSON.parse(await readFile(join(fastTarget, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(fastStored.schemaVersion, 1);
  assert.equal(fastStored.mainModel, "vendor/main");
  assert.equal("appearance" in fastStored, false);
  const fastLoaded = await loadConfigDetailed(join(fastTarget, "config.json"));
  assert.equal(fastLoaded.source, "file");
  assert.equal(fastLoaded.warning, null);
  assert.deepEqual(fastLoaded.config.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual((await readConfigEditSnapshot(join(fastTarget, "config.json"))).config.appearance, DEFAULT_APPEARANCE);

  const explicitRoot = await mkdtemp(join(tmpdir(), "orcode-appearance-explicit-"));
  const explicitTarget = join(explicitRoot, ".orcode");
  await mkdir(explicitTarget, { recursive: true });
  const explicitAppearance = { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" };
  await writeFile(
    join(explicitTarget, "config.json"),
    `${JSON.stringify({ schemaVersion: 1, mainModel: "vendor/main", appearance: explicitAppearance, providerSetup }, null, 2)}\n`,
  );
  const explicitResult = await migrateAppHome(explicitTarget, join(explicitRoot, ".routercode"));
  assert.equal(explicitResult.status, "ready");
  const explicitStored = JSON.parse(await readFile(join(explicitTarget, "config.json"), "utf8")) as { appearance: unknown };
  assert.deepEqual(explicitStored.appearance, explicitAppearance);
  assert.deepEqual((await loadConfigDetailed(join(explicitTarget, "config.json"))).config.appearance, explicitAppearance);

  const legacyRoot = await mkdtemp(join(tmpdir(), "orcode-appearance-legacy-"));
  const legacyHome = join(legacyRoot, ".routercode");
  const legacyTarget = join(legacyRoot, ".orcode");
  await seedHome(legacyHome, { model: "legacy/model" });
  const legacyResult = await migrateAppHome(legacyTarget, legacyHome, { randomUUID: () => "appearance-legacy-id" });
  assert.equal(legacyResult.status, "ready");
  const legacyStored = JSON.parse(await readFile(join(legacyTarget, "config.json"), "utf8")) as {
    schemaVersion: number;
    mainModel: string;
    appearance: unknown;
  };
  assert.equal(legacyStored.schemaVersion, 1);
  assert.equal(legacyStored.mainModel, "legacy/model");
  assert.deepEqual(legacyStored.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual((await loadConfigDetailed(join(legacyTarget, "config.json"))).config.appearance, DEFAULT_APPEARANCE);
});

test("a legacy home is config-edit-unavailable until migrateAppHome persisted stable provider state, after which edit reads are identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-edit-legacy-stable-"));
  const legacyHome = join(root, ".routercode");
  const target = join(root, ".orcode");
  await seedHome(legacyHome, { model: "legacy/model" });
  const legacyConfig = join(legacyHome, "config.json");
  const legacyBytes = await readFile(legacyConfig, "utf8");
  const before = await readConfigEditSnapshot(legacyConfig).catch((reason: unknown) => reason);
  assert.ok(before instanceof ConfigEditUnavailableError);
  assert.equal(before.code, "config-edit-unavailable");
  assert.equal(await readFile(legacyConfig, "utf8"), legacyBytes);

  let uuidCalls = 0;
  const result = await migrateAppHome(target, legacyHome, {
    randomUUID: () => {
      uuidCalls += 1;
      return "edit-stable-legacy-id";
    },
  });
  assert.equal(result.status, "ready");
  assert.ok(uuidCalls >= 1);

  const configFile = join(target, "config.json");
  const first = await readConfigEditSnapshot(configFile);
  const second = await readConfigEditSnapshot(configFile);
  assert.deepEqual(first.config, second.config);
  assert.equal(sameConfigFileSnapshot(first.file, second.file), true);
  if ("kind" in first.config.providerSetup) assert.fail("expected persistable provider state");
  assert.equal(first.config.providerSetup.lifecycle, "migrated");
  assert.equal(first.config.providerSetup.connections[0]?.id, "edit-stable-legacy-id");
  assert.equal(first.config.mainModel, "legacy/model");
  assert.deepEqual(first.config.appearance, DEFAULT_APPEARANCE);
  const reloaded = await loadConfigDetailed(configFile, {
    randomUUID: () => {
      throw new Error("persisted provider state must not allocate");
    },
  });
  assert.deepEqual(first.config, reloaded.config);
});
