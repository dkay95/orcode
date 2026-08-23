import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumeConfigWarning,
  DEFAULT_CONFIG,
  evaluateBudget,
  isApprovalMode,
  isBudgetAction,
  isCompressionMode,
  loadConfig,
  loadConfigDetailed,
  saveConfig,
  validateBudget,
  validateConfig,
  validateFallbackModels,
  validateProvider,
  validateVerify,
} from "../src/config.js";

async function configPath(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `routercode-${prefix}-`));
  return join(root, "config.json");
}

test("validateConfig preserves valid values", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    mainModel: "anthropic/example",
    approvalMode: "allow-all",
    compressionMode: "always",
    maxSteps: 25,
    maxCostUsd: 2.5,
    reasoningByModel: {
      "anthropic/example": { mode: "effort", effort: "high" },
      "openrouter/auto": { mode: "budget", maxTokens: 8_000 },
    },
  });

  assert.equal(config.mainModel, "anthropic/example");
  assert.equal(config.approvalMode, "allow-all");
  assert.equal(config.compressionMode, "always");
  assert.equal(config.maxSteps, 25);
  assert.equal(config.maxCostUsd, 2.5);
  assert.deepEqual(config.reasoningByModel["anthropic/example"], {
    mode: "effort",
    effort: "high",
  });
});

test("validateConfig rejects unsafe or nonsensical persisted values", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    approvalMode: "anything" as never,
    compressionMode: "magic" as never,
    maxSteps: 0,
    maxCostUsd: -1,
    compressionThresholdChars: 3,
    reasoningByModel: {
      broken: { mode: "effort", effort: "ultrahigh" as never },
      negative: { mode: "budget", maxTokens: -1 },
    },
  });

  assert.equal(config.approvalMode, DEFAULT_CONFIG.approvalMode);
  assert.equal(config.compressionMode, DEFAULT_CONFIG.compressionMode);
  assert.equal(config.maxSteps, DEFAULT_CONFIG.maxSteps);
  assert.equal(config.maxCostUsd, DEFAULT_CONFIG.maxCostUsd);
  assert.equal(
    config.compressionThresholdChars,
    DEFAULT_CONFIG.compressionThresholdChars,
  );
  assert.deepEqual(config.reasoningByModel, {});
});

test("validateConfig keeps a custom transcriptionModel and voiceConsentGiven, falling back on nonsense", () => {
  const withValues = validateConfig({
    ...DEFAULT_CONFIG,
    transcriptionModel: "openai/gpt-audio-mini",
    voiceConsentGiven: true,
  });
  assert.equal(withValues.transcriptionModel, "openai/gpt-audio-mini");
  assert.equal(withValues.voiceConsentGiven, true);

  const withNonsense = validateConfig({
    ...DEFAULT_CONFIG,
    transcriptionModel: "   ",
    voiceConsentGiven: "yes" as never,
  });
  assert.equal(withNonsense.transcriptionModel, DEFAULT_CONFIG.transcriptionModel);
  assert.equal(withNonsense.voiceConsentGiven, false);

  const withoutFields = validateConfig({ ...DEFAULT_CONFIG } as never);
  assert.equal(withoutFields.transcriptionModel, DEFAULT_CONFIG.transcriptionModel);
  assert.equal(withoutFields.voiceConsentGiven, false);
});

test("mode guards accept only documented modes", () => {
  assert.equal(isApprovalMode("auto-edit"), true);
  assert.equal(isApprovalMode("yolo"), false);
  assert.equal(isCompressionMode("auto"), true);
  assert.equal(isCompressionMode("sometimes"), false);
  assert.equal(isBudgetAction("block"), true);
  assert.equal(isBudgetAction("explode"), false);
});

test("budget validation keeps sane limits and drops nonsense", () => {
  assert.deepEqual(
    validateBudget({ dailyLimitUsd: 5, totalLimitUsd: 50, onExceed: "block" }),
    { dailyLimitUsd: 5, totalLimitUsd: 50, onExceed: "block" },
  );
  assert.deepEqual(
    validateBudget({
      dailyLimitUsd: -3,
      totalLimitUsd: "viel" as never,
      onExceed: "explodieren" as never,
    }),
    { dailyLimitUsd: null, totalLimitUsd: null, onExceed: "warn" },
  );
  assert.deepEqual(validateBudget("nichts"), {
    dailyLimitUsd: null,
    totalLimitUsd: null,
    onExceed: "warn",
  });
  assert.deepEqual(validateConfig(DEFAULT_CONFIG).budget, {
    dailyLimitUsd: null,
    totalLimitUsd: null,
    onExceed: "warn",
  });
});

test("evaluateBudget reports the exceeded scope and stays quiet otherwise", () => {
  const budget = {
    dailyLimitUsd: 1,
    totalLimitUsd: 10,
    onExceed: "block" as const,
  };
  const quiet = evaluateBudget(budget, { dayUsd: 0.5, totalUsd: 2 });
  assert.equal(quiet.exceeded, false);
  assert.equal(quiet.scope, null);
  assert.equal(quiet.message, null);

  const daily = evaluateBudget(budget, { dayUsd: 1.5, totalUsd: 2 });
  assert.equal(daily.exceeded, true);
  assert.equal(daily.scope, "daily");
  assert.equal(daily.action, "block");
  assert.match(daily.message ?? "", /Tagesbudget/);

  const total = evaluateBudget(budget, { dayUsd: 0.1, totalUsd: 11 });
  assert.equal(total.scope, "total");
  assert.match(total.message ?? "", /Gesamtbudget/);

  const off = evaluateBudget(
    { dailyLimitUsd: null, totalLimitUsd: null, onExceed: "warn" },
    { dayUsd: 999, totalUsd: 999 },
  );
  assert.equal(off.exceeded, false);
});

test("loadConfig falls back to defaults when the file is missing", async () => {
  const path = await configPath("config-missing");
  const outcome = await loadConfigDetailed(path);
  assert.equal(outcome.source, "defaults");
  assert.equal(outcome.warning, null);
  assert.deepEqual(outcome.config, validateConfig(DEFAULT_CONFIG));
});

test("broken JSON does not prevent the start and is reported in German", async () => {
  const path = await configPath("config-broken");
  await writeFile(path, '{ "mainModel": "x/y", ');

  const outcome = await loadConfigDetailed(path);
  assert.equal(outcome.source, "defaults");
  assert.equal(outcome.config.mainModel, DEFAULT_CONFIG.mainModel);
  assert.match(outcome.warning ?? "", /beschädigt/);
  assert.match(outcome.warning ?? "", /Standardwerten/);

  consumeConfigWarning();
  assert.equal((await loadConfig(path)).mainModel, DEFAULT_CONFIG.mainModel);
  assert.match(consumeConfigWarning() ?? "", /beschädigt/);
  assert.equal(consumeConfigWarning(), null);
});

test("unreadable config and non-objects fall back instead of throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-config-dir-"));
  const asDirectory = join(directory, "config.json");
  await mkdir(asDirectory);
  const blocked = await loadConfigDetailed(asDirectory);
  assert.equal(blocked.source, "defaults");
  assert.match(blocked.warning ?? "", /konnte nicht gelesen werden|kein Objekt/);

  const path = await configPath("config-array");
  await writeFile(path, "[1,2,3]");
  const array = await loadConfigDetailed(path);
  assert.equal(array.source, "defaults");
  assert.match(array.warning ?? "", /kein Objekt/);
});

test("saveConfig writes atomically, leaves no temp file and keeps 0600", async () => {
  const path = await configPath("config-save");
  await saveConfig(
    {
      ...DEFAULT_CONFIG,
      mainModel: "anthropic/example",
      budget: { dailyLimitUsd: 2, totalLimitUsd: null, onExceed: "block" },
    },
    path,
  );

  const written = await loadConfigDetailed(path);
  assert.equal(written.source, "file");
  assert.equal(written.config.mainModel, "anthropic/example");
  assert.deepEqual(written.config.budget, {
    dailyLimitUsd: 2,
    totalLimitUsd: null,
    onExceed: "block",
  });

  const entries = await readdir(join(path, ".."));
  assert.deepEqual(entries, ["config.json"]);
  const info = await stat(path);
  // NTFS has no POSIX mode bits — the mode is asserted on POSIX only.
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o600);
  }
});

test("saveConfig keeps a copy of a config it could not parse", async () => {
  const path = await configPath("config-rescue");
  await writeFile(path, "kaputt, aber vom Nutzer geschrieben");

  await saveConfig(DEFAULT_CONFIG, path);

  assert.equal(
    await readFile(`${path}.beschaedigt`, "utf8"),
    "kaputt, aber vom Nutzer geschrieben",
  );
  assert.equal((await loadConfigDetailed(path)).source, "file");
});

test("DEFAULT_CONFIG trägt die A2/A3-Defaults", () => {
  assert.deepEqual(DEFAULT_CONFIG.fallbackModels, []);
  assert.deepEqual(DEFAULT_CONFIG.provider, { dataCollection: "deny" });
  assert.equal(DEFAULT_CONFIG.web, "auto");
  assert.deepEqual(DEFAULT_CONFIG.verify, {
    commands: [],
    mode: "on-edit",
    maxRepairRounds: 1,
  });
  assert.equal(DEFAULT_CONFIG.contextBudgetRatio, 0.7);
});

test("validateFallbackModels behält gültige Modelle, verwirft den Rest", () => {
  assert.deepEqual(validateFallbackModels(["a/b", " c/d ", "", 5, null]), [
    "a/b",
    "c/d",
  ]);
  assert.deepEqual(validateFallbackModels("kaputt"), []);
  assert.deepEqual(validateFallbackModels(undefined), []);
});

test("validateProvider erzwingt dataCollection=deny als Default und filtert Unsinn", () => {
  assert.deepEqual(validateProvider(undefined), { dataCollection: "deny" });
  assert.deepEqual(
    validateProvider({ sort: "price", dataCollection: "allow", only: ["anthropic"], ignore: [] }),
    { sort: "price", dataCollection: "allow", only: ["anthropic"] },
  );
  assert.deepEqual(validateProvider({ sort: "fastest", dataCollection: "vielleicht" }), {
    dataCollection: "deny",
  });
  assert.deepEqual(
    validateProvider({ allowFallbacks: false }),
    { dataCollection: "deny", allowFallbacks: false },
  );
  assert.deepEqual(validateProvider({ allowFallbacks: "nein" }), {
    dataCollection: "deny",
  });
});

test("validateVerify allows zero through two repair rounds and normalizes the mode", () => {
  assert.deepEqual(
    validateVerify({ commands: ["npm test", ""], mode: "on-edit", maxRepairRounds: 2 }),
    { commands: ["npm test"], mode: "on-edit", maxRepairRounds: 2 },
  );
  assert.deepEqual(validateVerify({ commands: ["x"], mode: "on-edit", maxRepairRounds: 0 }), {
    commands: ["x"],
    mode: "on-edit",
    maxRepairRounds: 0,
  });
  assert.deepEqual(validateVerify({ commands: ["x"], mode: "on-edit", maxRepairRounds: 5 }), {
    commands: ["x"],
    mode: "on-edit",
    maxRepairRounds: 1,
  });
  assert.deepEqual(validateVerify({ mode: "sofort" as never }), {
    commands: [],
    mode: "on-edit",
    maxRepairRounds: 1,
  });
  assert.deepEqual(validateVerify("nichts"), {
    commands: [],
    mode: "on-edit",
    maxRepairRounds: 1,
  });
});

test("validateVerify migrates legacy total-pass maxRounds without raising the limit", () => {
  assert.equal(validateVerify({ maxRounds: 1 }).maxRepairRounds, 0);
  assert.equal(validateVerify({ maxRounds: 2 }).maxRepairRounds, 1);
  assert.equal(validateVerify({ maxRounds: 3 }).maxRepairRounds, 2);
  assert.equal(
    validateVerify({ maxRounds: 1, maxRepairRounds: 2 }).maxRepairRounds,
    2,
    "the explicit new field wins over the legacy field",
  );
});

test("validateConfig übernimmt fallbackModels/provider/web/verify/contextBudgetRatio", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    fallbackModels: ["anthropic/x"],
    provider: { sort: "throughput", allowFallbacks: false },
    web: "on",
    verify: { commands: ["npm run check"], mode: "on-edit", maxRepairRounds: 2 },
    contextBudgetRatio: 0.5,
  });
  assert.deepEqual(config.fallbackModels, ["anthropic/x"]);
  assert.deepEqual(config.provider, {
    sort: "throughput",
    dataCollection: "deny",
    allowFallbacks: false,
  });
  assert.equal(config.web, "on");
  assert.deepEqual(config.verify, {
    commands: ["npm run check"],
    mode: "on-edit",
    maxRepairRounds: 2,
  });
  assert.equal(config.contextBudgetRatio, 0.5);

  const rejected = validateConfig({
    ...DEFAULT_CONFIG,
    web: "immer" as never,
    contextBudgetRatio: 5,
  });
  assert.equal(rejected.web, DEFAULT_CONFIG.web);
  assert.equal(rejected.contextBudgetRatio, DEFAULT_CONFIG.contextBudgetRatio);
});

test("saveConfig/loadConfig runden die neuen Felder verlustfrei", async () => {
  const path = await configPath("config-a2-a3");
  await saveConfig(
    {
      ...DEFAULT_CONFIG,
      fallbackModels: ["anthropic/x", "openai/y"],
      provider: { sort: "price", only: ["anthropic"], allowFallbacks: false },
      web: "off",
      verify: { commands: ["npm test"], mode: "on-edit", maxRepairRounds: 2 },
      contextBudgetRatio: 0.6,
    },
    path,
  );
  const written = await loadConfigDetailed(path);
  assert.equal(written.source, "file");
  assert.deepEqual(written.config.fallbackModels, ["anthropic/x", "openai/y"]);
  assert.deepEqual(written.config.provider, {
    sort: "price",
    dataCollection: "deny",
    only: ["anthropic"],
    allowFallbacks: false,
  });
  assert.equal(written.config.web, "off");
  assert.deepEqual(written.config.verify, {
    commands: ["npm test"],
    mode: "on-edit",
    maxRepairRounds: 2,
  });
  assert.equal(written.config.contextBudgetRatio, 0.6);
});

test("legacy verify config loads idempotently and save writes only maxRepairRounds", async () => {
  for (const [legacy, expected] of [[1, 0], [2, 1]] as const) {
    const path = await configPath(`verify-legacy-${legacy}`);
    await writeFile(path, JSON.stringify({
      ...DEFAULT_CONFIG,
      verify: { commands: ["npm test"], mode: "on-edit", maxRounds: legacy },
    }));

    const loaded = await loadConfigDetailed(path);
    assert.equal(loaded.source, "file");
    assert.equal(loaded.config.verify.maxRepairRounds, expected);
    await saveConfig(loaded.config, path);

    const saved = JSON.parse(await readFile(path, "utf8")) as {
      verify: Record<string, unknown>;
    };
    assert.equal(saved.verify.maxRepairRounds, expected);
    assert.equal("maxRounds" in saved.verify, false);
    assert.equal((await loadConfigDetailed(path)).config.verify.maxRepairRounds, expected);
  }

  const mixedPath = await configPath("verify-mixed");
  await writeFile(mixedPath, JSON.stringify({
    ...DEFAULT_CONFIG,
    verify: {
      commands: ["npm test"],
      mode: "on-edit",
      maxRounds: 1,
      maxRepairRounds: 2,
    },
  }));
  assert.equal((await loadConfigDetailed(mixedPath)).config.verify.maxRepairRounds, 2);
});

test("config schema v0 reads as current while unknown future versions are visibly refused", async () => {
  const { CONFIG_SCHEMA_VERSION } = await import("../src/config.js");
  const legacyPath = await configPath("schema-v0");
  await writeFile(legacyPath, JSON.stringify({ mainModel: "legacy/model" }));
  const legacy = await loadConfigDetailed(legacyPath);
  assert.equal(legacy.source, "file");
  assert.equal(legacy.config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(legacy.config.mainModel, "legacy/model");

  const futurePath = await configPath("schema-future");
  const futureRaw = JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 1, mainModel: "future/model" });
  await writeFile(futurePath, futureRaw);
  const future = await loadConfigDetailed(futurePath);
  assert.equal(future.source, "defaults");
  assert.match(future.warning ?? "", /zukünftige|Version/i);
  await assert.rejects(saveConfig(DEFAULT_CONFIG, futurePath), /zukünftige|Version/i);
  assert.equal(await readFile(futurePath, "utf8"), futureRaw);
});

test("missing config is never-configured while an existing legacy config is source-aware migrated", async () => {
  const missingPath = await configPath("provider-never-configured");
  const missing = await loadConfigDetailed(missingPath, {
    randomUUID: () => {
      throw new Error("missing files must not allocate a migration connection");
    },
  });
  assert.equal(missing.source, "defaults");
  assert.ok(!("kind" in missing.config.providerSetup));
  assert.equal(missing.config.providerSetup.lifecycle, "never-configured");

  const legacyPath = await configPath("provider-existing-legacy");
  const legacyPreferences = {
    mainModel: "vendor/main/exact",
    fallbackModels: ["vendor/fallback/one"],
    compressorModel: "vendor/compressor",
    transcriptionModel: "vendor/audio",
    panelModels: ["vendor/judge"],
    reasoningByModel: { "vendor/main/exact": { mode: "effort", effort: "high" } },
    provider: { sort: "latency", dataCollection: "allow", only: ["exact-provider"], allowFallbacks: false },
  };
  await writeFile(legacyPath, JSON.stringify(legacyPreferences));
  let uuidCalls = 0;
  const migrated = await loadConfigDetailed(legacyPath, {
    randomUUID: () => {
      uuidCalls += 1;
      return "injected-legacy-id";
    },
  });
  assert.equal(uuidCalls, 1);
  assert.equal(migrated.source, "file");
  assert.ok(!("kind" in migrated.config.providerSetup));
  assert.equal(migrated.config.providerSetup.lifecycle, "migrated");
  assert.equal(migrated.config.providerSetup.connections[0]?.id, "injected-legacy-id");
  assert.equal(migrated.config.providerSetup.connections[0]?.accountFingerprint, "acct_legacy_injected-legacy-id");
  assert.deepEqual(migrated.config.provider, legacyPreferences.provider);
  assert.equal(migrated.config.mainModel, legacyPreferences.mainModel);
  assert.deepEqual(migrated.config.fallbackModels, legacyPreferences.fallbackModels);
  assert.equal(migrated.config.compressorModel, legacyPreferences.compressorModel);
  assert.equal(migrated.config.transcriptionModel, legacyPreferences.transcriptionModel);
  assert.deepEqual(migrated.config.panelModels, legacyPreferences.panelModels);
  assert.deepEqual(migrated.config.reasoningByModel, legacyPreferences.reasoningByModel);
});

test("persisting a source-aware migration is stable and never reallocates its legacy connection", async () => {
  const path = await configPath("provider-migration-idempotent");
  await writeFile(path, JSON.stringify({ mainModel: "vendor/main", provider: { dataCollection: "allow" } }));
  const first = await loadConfigDetailed(path, { randomUUID: () => "stable-csprng-id" });
  await saveConfig(first.config, path);
  const firstBytes = await readFile(path, "utf8");

  let uuidCalls = 0;
  const second = await loadConfigDetailed(path, {
    randomUUID: () => {
      uuidCalls += 1;
      return "must-not-replace";
    },
  });
  await saveConfig(second.config, path);
  assert.equal(uuidCalls, 0);
  assert.ok(!("kind" in second.config.providerSetup));
  assert.equal(second.config.providerSetup.lifecycle, "migrated");
  assert.equal(second.config.providerSetup.connections[0]?.credentialSlot, "legacy:inference");
  assert.equal(second.config.providerSetup.connections[0]?.id, "stable-csprng-id");
  assert.equal(await readFile(path, "utf8"), firstBytes);
});
