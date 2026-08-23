import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { migrateAppHome } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { approvalSubjectFingerprint } from "../src/rules.js";
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
  assert.match(stored.rules.find((rule) => rule.id === "broad-command")?.match.reason ?? "", /nicht exakt/);
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

test("migration refuses a symlinked legacy source before rename and leaves its target untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-source-symlink-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  const outsideSource = join(root, "outside-source");
  await seedHome(outsideSource);
  const originalConfig = await readFile(join(outsideSource, "config.json"), "utf8");
  await symlink(outsideSource, legacy, "dir");

  const result = await migrateAppHome(target, legacy);
  const manifest = JSON.parse(
    await readFile(join(target, "migrations", "app-home-v1.json"), "utf8"),
  ) as { backupPath: string };

  assert.equal((result as typeof result & { status?: string }).status, "recovery-required");
  assert.equal(await exists(legacy), true);
  assert.equal((await lstat(legacy)).isSymbolicLink(), true);
  assert.equal(await exists(manifest.backupPath), false);
  assert.equal(await readFile(join(outsideSource, "config.json"), "utf8"), originalConfig);
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

  assert.match(result.warning ?? "", /isoliert/i);
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

  assert.match(result.warning ?? "", /2 .*isoliert/i);
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
  assert.match(result.warning ?? "", /archivieren|Backup.*groß/i);
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
  assert.match(result.warning ?? "", /Backup.*groß|archivieren/i);
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

test("a current top-level config persists source-aware provider migration once", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-current-provider-config-"));
  const legacy = join(root, ".routercode");
  const target = join(root, ".orcode");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "config.json"), JSON.stringify({
    schemaVersion: 1,
    mainModel: "vendor/current/model",
  }));
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
  const stored = JSON.parse(firstBytes) as {
    providerSetup: { lifecycle: string; connections: Array<{ id: string }> };
  };

  assert.equal(first.appHome, target);
  assert.equal(second.appHome, target);
  assert.equal(stored.providerSetup.lifecycle, "migrated");
  assert.equal(stored.providerSetup.connections[0]?.id, "current-provider-1");
  assert.equal(uuidCalls, 1);
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
    { workspace: HISTORICAL_FIXTURE_WORKSPACE, newChat: false },
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
        connections: Array<{ id: string; credentialSlot: string; accountFingerprint: string }>;
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
    assert.equal(storedConfig.providerSetup.schemaVersion, 1);
    assert.equal(storedConfig.providerSetup.lifecycle, "migrated");
    assert.deepEqual(storedConfig.providerSetup.connections[0], {
      id: "fixture-provider-id",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "legacy:inference",
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
      /nicht exakt/,
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
