import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNeverConfiguredProviderState,
  migrateLegacyOpenRouterState,
  projectLegacyModelRoutes,
  type ProviderConnectionStateV1,
  validateProviderSetupState,
} from "../src/provider-state.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";

function legacyConnectionFixture(): ProviderConnectionStateV1 {
  return {
    id: "legacy-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_legacy_legacy-connection",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
}

function legacyConfigFixture() {
  return {
    mainModel: "vendor/main",
    fallbackModels: ["vendor/a/b"],
    compressorModel: "vendor/compressor",
    transcriptionModel: "vendor/audio",
    panelModels: ["vendor/judge"],
    reasoningByModel: {
      "vendor/a/b": { mode: "effort", effort: "high" as const },
    },
  };
}

test("a missing nested state in an existing config migrates OpenRouter without network or key reads", () => {
  const result = migrateLegacyOpenRouterState({
    mainModel: "openai/gpt-main",
    fallbackModels: ["anthropic/claude-fallback"],
    compressorModel: "qwen/compressor",
    transcriptionModel: "mistral/voice",
    panelModels: ["google/judge"],
    reasoningByModel: { "openai/gpt-main": { mode: "effort", effort: "high" } },
  }, { connectionId: "legacy-csprng-id" });

  assert.equal(result.lifecycle, "migrated");
  assert.equal(result.connections[0]?.backendId, "openrouter");
  assert.equal(result.connections[0]?.credentialSlot, "legacy:inference");
  assert.equal(result.connections[0]?.accountFingerprint, "acct_legacy_legacy-csprng-id");
  assert.equal(result.connections[0]?.accountFingerprintState, "provisional");
  assert.equal(result.defaultRoute?.requestedModelId, "openai/gpt-main");
  assert.equal(result.defaultRoute?.canonicalModelId, null);
  assert.equal(result.defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(result.cross.enabled, false);
});

test("legacy model projection preserves every role without slash parsing", () => {
  const projected = projectLegacyModelRoutes(legacyConfigFixture(), legacyConnectionFixture());
  assert.equal(projected.default?.requestedModelId, "vendor/main");
  assert.deepEqual(projected.fallbacks.map((route) => route.requestedModelId), ["vendor/a/b"]);
  assert.equal(projected.compressor?.requestedModelId, "vendor/compressor");
  assert.equal(projected.transcription?.requestedModelId, "vendor/audio");
  assert.deepEqual(projected.panel.map((route) => route.requestedModelId), ["vendor/judge"]);
  assert.equal(projected.reasoning["vendor/a/b"]?.requestedModelId, "vendor/a/b");
});

test("validation accepts the exact current schema and rejects malformed nested members", () => {
  const current = createNeverConfiguredProviderState();
  assert.deepEqual(validateProviderSetupState(current), current);
  assert.deepEqual(
    validateProviderSetupState({ ...current, connections: [{ ...legacyConnectionFixture(), backendId: "unknown" }] }),
    { kind: "corrupt" },
  );
  assert.deepEqual(
    validateProviderSetupState({ ...current, defaultRoute: { requestedModelId: "missing tuple" } }),
    { kind: "corrupt" },
  );
});

test("future and corrupt provider state remain distinct and cannot be saved over", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-state-refusal-"));
  const path = join(root, "config.json");
  const future = validateProviderSetupState({ schemaVersion: 99 });
  const corrupt = validateProviderSetupState({ schemaVersion: 1, connections: "wrong" });
  assert.deepEqual(future, { kind: "future-version", version: 99 });
  assert.deepEqual(corrupt, { kind: "corrupt" });
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: future }, path), /future-version/);
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: corrupt }, path), /corrupt/);

  const raw = `${JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 99, opaque: "keep-exactly" } })}\n`;
  await writeFile(path, raw);
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, budget: { dailyLimitUsd: 2, totalLimitUsd: null, onExceed: "warn" } }, path), /future-version/);
  assert.equal(await readFile(path, "utf8"), raw);
});
