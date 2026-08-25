import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  ConfigEditConflictError,
  ConfigEditUnavailableError,
  consumeConfigWarning,
  DEFAULT_APPEARANCE,
  DEFAULT_CONFIG,
  assertConfigFileSnapshot,
  evaluateBudget,
  isApprovalMode,
  isBudgetAction,
  isCompressionMode,
  isAtomicFilePostPublicationError,
  loadConfig,
  loadConfigDetailed,
  readConfigEditSnapshot,
  readConfigFileSnapshot,
  saveConfig,
  saveConfigEdit,
  saveConfigEditUnderLock,
  withConfigWriteLock,
  validateAppearance,
  validateBudget,
  validateConfig,
  validateFallbackModels,
  validateProvider,
  validateVerify,
  writeFileAtomicCreateSecure,
  writeFileAtomicSecure,
  type AppearanceConfig,
  type ConfigInput,
  type ConfigWriteOwnership,
} from "../src/config.js";
import { sameConfigFileSnapshot } from "../src/config-file.js";
import { createNeverConfiguredProviderState } from "../src/provider-state.js";

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

test("atomic file writers preserve pre-publication error identity and expose no forgeable post-publication proof", async () => {
  const createPath = await configPath("atomic-create-pre-error");
  const createReason = new DOMException("fixed create fence abort", "AbortError");
  await assert.rejects(
    writeFileAtomicCreateSecure(createPath, "candidate", undefined, () => {
      throw createReason;
    }),
    (error: unknown) => error === createReason,
  );
  await assert.rejects(readFile(createPath, "utf8"), { code: "ENOENT" });

  const replacePath = await configPath("atomic-replace-pre-error");
  await writeFile(replacePath, "old", { encoding: "utf8", mode: 0o600 });
  const replaceReason = new Error("fixed replace fence rejection");
  await assert.rejects(
    writeFileAtomicSecure(replacePath, "candidate", undefined, () => {
      throw replaceReason;
    }),
    (error: unknown) => error === replaceReason,
  );
  assert.equal(await readFile(replacePath, "utf8"), "old");

  assert.equal(isAtomicFilePostPublicationError({
    name: "AtomicFilePostPublicationError",
    message: "forged",
    operation: "replace",
    publicationError: null,
  }), false);

  const createPostPath = await configPath("atomic-create-post-error");
  const createPostReason = new Error("fixed create post-publication failure");
  const createPostError = await writeFileAtomicCreateSecure(
    createPostPath,
    "created",
    undefined,
    undefined,
    () => { throw createPostReason; },
  ).catch((error: unknown) => error);
  assert.equal(isAtomicFilePostPublicationError(createPostError), true);
  if (!isAtomicFilePostPublicationError(createPostError)) assert.fail("missing create post-publication proof");
  assert.equal(createPostError.operation, "create");
  assert.equal(createPostError.publicationError, createPostReason);
  assert.equal(await readFile(createPostPath, "utf8"), "created");
  assert.deepEqual(await readdir(dirname(createPostPath)), ["config.json"]);

  const replacePostPath = await configPath("atomic-replace-post-error");
  await writeFile(replacePostPath, "old", { encoding: "utf8", mode: 0o600 });
  const replacePostReason = new Error("fixed replace post-publication failure");
  const replacePostError = await writeFileAtomicSecure(
    replacePostPath,
    "replaced",
    undefined,
    undefined,
    () => { throw replacePostReason; },
  ).catch((error: unknown) => error);
  assert.equal(isAtomicFilePostPublicationError(replacePostError), true);
  if (!isAtomicFilePostPublicationError(replacePostError)) assert.fail("missing replace post-publication proof");
  assert.equal(replacePostError.operation, "replace");
  assert.equal(replacePostError.publicationError, replacePostReason);
  assert.equal(await readFile(replacePostPath, "utf8"), "replaced");
  assert.deepEqual(await readdir(dirname(replacePostPath)), ["config.json"]);
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

test("saveConfig rejects a symlinked config target without consuming or replacing outside bytes", async () => {
  const path = await configPath("symlink-target");
  const outsideRoot = await mkdtemp(join(tmpdir(), "routercode-config-outside-"));
  const outside = join(outsideRoot, "outside.json");
  const sentinel = "outside-config-secret-sentinel";
  await writeFile(outside, sentinel, "utf8");
  await symlink(outside, path);

  const error = await saveConfig(DEFAULT_CONFIG, path).catch((reason: unknown) => reason);

  assert.ok(error instanceof Error);
  assert.doesNotMatch(String(error), /outside-config-secret-sentinel/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), sentinel);
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

test("an unrelated save cannot overwrite nested provider setup schema 3", async () => {
  const path = await configPath("provider-setup-schema-three");
  const raw = `${JSON.stringify({
    ...DEFAULT_CONFIG,
    providerSetup: { schemaVersion: 3, opaque: "keep-exactly" },
  })}\n`;
  await writeFile(path, raw);
  await assert.rejects(
    saveConfig({ ...DEFAULT_CONFIG, mainModel: "unrelated/change" }, path),
    /future-version/,
  );
  assert.equal(await readFile(path, "utf8"), raw);
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

test("saveConfig waits for an independently held cross-process config writer lock", async () => {
  const path = await configPath("cross-process-writer-lock");
  await saveConfig(DEFAULT_CONFIG, path);
  const moduleUrl = new URL("../src/config.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      const api = await import(process.env.ORCODE_FIX2_CONFIG_MODULE_URL);
      try {
        await api.withConfigWriteLock(
          process.env.ORCODE_FIX2_CONFIG_PATH,
          async () => {
            process.send({ type: "held" });
            await new Promise((resolve) => {
              process.once("message", (message) => {
                if (message?.type === "release") resolve();
              });
            });
          },
        );
        process.send({ type: "done" });
      } catch (error) {
        process.send({ type: "error", message: String(error) });
        process.exitCode = 1;
      }
    `,
  ], {
    env: {
      ...process.env,
      ORCODE_FIX2_CONFIG_MODULE_URL: moduleUrl,
      ORCODE_FIX2_CONFIG_PATH: path,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const held = new Promise<void>((resolve, reject) => {
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "held") resolve();
      if (message.type === "error") {
        reject(new Error(String("message" in message ? message.message : "child error")));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`config lock child exited ${code}`));
    });
  });
  await held;

  let saveSettled = false;
  const updated = {
    ...structuredClone(DEFAULT_CONFIG),
    mainModel: "preserve/cross-process-writer",
  };
  const saving = saveConfig(updated, path).then(() => { saveSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledWhileHeld = saveSettled;
  child.send({ type: "release" });
  await saving;
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", resolve);
  });

  assert.equal(settledWhileHeld, false);
  assert.equal(exitCode, 0);
  const loaded = await loadConfig(path);
  assert.equal(loaded.mainModel, "preserve/cross-process-writer");
});

test("a writer retries when the live claim disappears before adoption", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const path = await configPath("claim-release-before-adoption");
  const originalCreate = PrivateStore.prototype.createDirectoryExclusive;
  const originalAdopt = PrivateStore.prototype.adoptDirectoryClaim;
  let injectContention = true;
  let injectedAdoptAbsence = false;
  PrivateStore.prototype.createDirectoryExclusive = async function (claimPath) {
    if (injectContention) {
      injectContention = false;
      return null;
    }
    return originalCreate.call(this, claimPath);
  };
  PrivateStore.prototype.adoptDirectoryClaim = async function (claimPath) {
    if (!injectedAdoptAbsence) {
      injectedAdoptAbsence = true;
      throw Object.assign(new Error("released before adoption"), { code: "ENOENT" });
    }
    return originalAdopt.call(this, claimPath);
  };
  let entered = false;
  try {
    await withConfigWriteLock(path, async () => {
      entered = true;
    });
  } finally {
    PrivateStore.prototype.createDirectoryExclusive = originalCreate;
    PrivateStore.prototype.adoptDirectoryClaim = originalAdopt;
  }

  assert.equal(injectedAdoptAbsence, true);
  assert.equal(entered, true);
});

test("abort after awaited config claim acquisition keeps the exact reason and never starts the task", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const path = await configPath("abort-after-claim-acquisition");
  const originalCreate = PrivateStore.prototype.createDirectoryExclusive;
  let claimCreated!: () => void;
  let resumeCreate!: () => void;
  const created = new Promise<void>((resolve) => { claimCreated = resolve; });
  const paused = new Promise<void>((resolve) => { resumeCreate = resolve; });
  let intercepted = false;
  PrivateStore.prototype.createDirectoryExclusive = async function (claimPath) {
    const claim = await originalCreate.call(this, claimPath);
    if (claim !== null && !intercepted) {
      intercepted = true;
      claimCreated();
      await paused;
    }
    return claim;
  };

  const controller = new AbortController();
  const reason = new DOMException("claim acquisition cancelled", "AbortError");
  let taskEntered = false;
  let operation: Promise<void> | null = null;
  try {
    operation = withConfigWriteLock(path, async () => {
      taskEntered = true;
    }, { signal: controller.signal });
    await created;
    controller.abort(reason);
    resumeCreate();
    await assert.rejects(operation, (error: unknown) => error === reason);
  } finally {
    resumeCreate();
    await operation?.catch(() => undefined);
    PrivateStore.prototype.createDirectoryExclusive = originalCreate;
  }

  let successorEntered = false;
  await withConfigWriteLock(path, async () => {
    successorEntered = true;
  });
  assert.equal(intercepted, true);
  assert.equal(taskEntered, false);
  assert.equal(successorEntered, true, "the acquired claim was released after cancellation");
});

test("an aborted queued writer cannot let a third writer bypass the live holder", async () => {
  const path = await configPath("aborted-writer-queue");
  let holderReached!: () => void;
  let releaseHolder!: () => void;
  const reached = new Promise<void>((resolve) => { holderReached = resolve; });
  const pause = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = withConfigWriteLock(path, async () => {
    holderReached();
    await pause;
  });
  await reached;

  const controller = new AbortController();
  const reason = new DOMException("queued writer cancelled", "AbortError");
  const queued = withConfigWriteLock(path, async () => {
    assert.fail("aborted queued writer entered");
  }, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(queued, (error: unknown) => error === reason);

  let thirdEntered = false;
  const third = withConfigWriteLock(path, async () => {
    thirdEntered = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const enteredWhileHeld = thirdEntered;
  releaseHolder();
  await Promise.all([holder, third]);

  assert.equal(enteredWhileHeld, false);
  assert.equal(thirdEntered, true);
});

test("an expired timestamp never lets a successor reclaim a live cross-process writer", async () => {
  const path = await configPath("live-expired-writer");
  await saveConfig(DEFAULT_CONFIG, path);
  const moduleUrl = new URL("../src/config.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
      Date.now = () => 0;
      const api = await import(process.env.ORCODE_FIX2_CONFIG_MODULE_URL);
      try {
        await api.withConfigWriteLock(
          process.env.ORCODE_FIX2_CONFIG_PATH,
          async () => {
            process.send({ type: "held" });
            await new Promise((resolve) => {
              process.once("message", (message) => {
                if (message?.type === "release") resolve();
              });
            });
          },
        );
        process.send({ type: "done" });
      } catch (error) {
        process.send({ type: "error", message: String(error) });
        process.exitCode = 1;
      }
    `,
  ], {
    env: {
      ...process.env,
      ORCODE_FIX2_CONFIG_MODULE_URL: moduleUrl,
      ORCODE_FIX2_CONFIG_PATH: path,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let childFailure: string | null = null;
  const held = new Promise<void>((resolve, reject) => {
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "held") resolve();
      if (message.type === "error") {
        childFailure = String("message" in message ? message.message : "child error");
        reject(new Error(childFailure));
      }
    });
    child.once("error", reject);
  });
  await held;

  let successorEntered = false;
  const successor = withConfigWriteLock(path, async () => { successorEntered = true; });
  for (let turn = 0; turn < 20 && !successorEntered; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const enteredWhileLive = successorEntered;
  child.send({ type: "release" });
  await successor;
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", resolve);
  });

  assert.equal(enteredWhileLive, false);
  assert.equal(exitCode, 0, childFailure ?? "live writer child exited unsuccessfully");
});

test("case aliases of the same config directory share one writer ownership", async (t) => {
  const path = await configPath("Case-Alias-Writer");
  const root = dirname(path);
  const aliasRoot = join(dirname(root), basename(root).toLowerCase());
  let original: Awaited<ReturnType<typeof stat>>;
  let alias: Awaited<ReturnType<typeof stat>>;
  try {
    [original, alias] = await Promise.all([stat(root), stat(aliasRoot)]);
  } catch {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  if (original.dev !== alias.dev || original.ino !== alias.ino) {
    t.skip("requires a case-insensitive filesystem");
    return;
  }

  let releaseOriginal!: () => void;
  let originalReached!: () => void;
  const originalPause = new Promise<void>((resolve) => { releaseOriginal = resolve; });
  const reached = new Promise<void>((resolve) => { originalReached = resolve; });
  const first = withConfigWriteLock(path, async () => {
    originalReached();
    await originalPause;
  });
  await reached;

  let aliasEntered = false;
  const second = withConfigWriteLock(join(aliasRoot, "config.json"), async () => {
    aliasEntered = true;
  });
  for (let turn = 0; turn < 500 && !aliasEntered; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const enteredWhileOriginalHeld = aliasEntered;
  releaseOriginal();
  await Promise.all([first, second]);

  assert.equal(enteredWhileOriginalHeld, false);
  assert.equal(aliasEntered, true);
});

test("case aliases of the same absent config directory share one writer ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "RouterCode-Absent-Case-Alias-"));
  const aliasRoot = join(dirname(root), basename(root).toLowerCase());
  let original: Awaited<ReturnType<typeof stat>>;
  let alias: Awaited<ReturnType<typeof stat>>;
  try {
    [original, alias] = await Promise.all([stat(root), stat(aliasRoot)]);
  } catch {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  if (original.dev !== alias.dev || original.ino !== alias.ino) {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  const firstPath = join(root, "Absent-App", "config.json");
  const aliasPath = join(root, "absent-app", "config.json");

  let releaseFirst!: () => void;
  let firstReached!: () => void;
  const pause = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reached = new Promise<void>((resolve) => { firstReached = resolve; });
  const first = withConfigWriteLock(firstPath, async () => {
    firstReached();
    await pause;
  });
  await reached;

  let aliasEntered = false;
  const second = withConfigWriteLock(aliasPath, async () => {
    aliasEntered = true;
  });
  for (let turn = 0; turn < 500 && !aliasEntered; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const enteredWhileFirstHeld = aliasEntered;
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(enteredWhileFirstHeld, false);
  assert.equal(aliasEntered, true);
});

test("an absent config snapshot rejects replacement of its parent before publication", async () => {
  const path = await configPath("parent-swap-before-publication");
  const root = dirname(path);
  const movedRoot = `${root}.moved`;
  const snapshot = await readConfigFileSnapshot(path);
  assert.equal(snapshot.kind, "absent");

  await rename(root, movedRoot);
  await mkdir(root);

  await assert.rejects(
    assertConfigFileSnapshot(path, snapshot),
    /changed before publication/i,
  );
  assert.deepEqual(await readdir(root), []);
});

test("an exact live writer remains assertable after its wall-clock lease duration", async () => {
  const path = await configPath("live-writer-past-wall-clock-lease");
  const originalNow = Date.now;
  Date.now = () => 0;
  try {
    await withConfigWriteLock(path, async (ownership) => {
      await ownership.assertHeld();
      Date.now = () => 30_001;
      await ownership.assertHeld();
    });
  } finally {
    Date.now = originalNow;
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pendingTemporaryFiles(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));
}

/** Structural check so the regression links against sources that predate the typed error. */
function isConfigEditUnverified(error: unknown): error is Error & { readonly code: "config-edit-unverified" } {
  return error instanceof Error
    && error.name === "ConfigEditUnverifiedError"
    && (error as { code?: unknown }).code === "config-edit-unverified";
}

test("validateConfig and DEFAULT_CONFIG carry the additive appearance defaults", () => {
  assert.deepEqual(DEFAULT_APPEARANCE, {
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "auto",
  });
  assert.deepEqual(DEFAULT_CONFIG.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG } as ConfigInput).appearance, {
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "auto",
  });
  assert.equal(validateConfig({ ...DEFAULT_CONFIG } as ConfigInput).schemaVersion, 1);

  assert.deepEqual(validateAppearance({
    showLargeLogo: false,
    showHeaderMark: false,
    glyphMode: "ascii",
  }), {
    showLargeLogo: false,
    showHeaderMark: false,
    glyphMode: "ascii",
  });
});

test("validateAppearance fills missing fields individually and malformed values never erase valid siblings", () => {
  assert.deepEqual(validateAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance("ascii"), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance([]), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance({}), DEFAULT_APPEARANCE);
  assert.deepEqual(validateAppearance({ glyphMode: "unicode" }), {
    showLargeLogo: true,
    showHeaderMark: true,
    glyphMode: "unicode",
  });
  assert.deepEqual(validateAppearance({ showLargeLogo: false, showHeaderMark: "no", glyphMode: "neon" }), {
    showLargeLogo: false,
    showHeaderMark: true,
    glyphMode: "auto",
  });
  assert.deepEqual(validateAppearance({ showLargeLogo: 0, showHeaderMark: false, glyphMode: "ASCII" }), {
    showLargeLogo: true,
    showHeaderMark: false,
    glyphMode: "auto",
  });
  const fresh = validateAppearance(DEFAULT_APPEARANCE);
  assert.notEqual(fresh, DEFAULT_APPEARANCE);
  assert.deepEqual(fresh, DEFAULT_APPEARANCE);

  const config = validateConfig({
    ...DEFAULT_CONFIG,
    mainModel: "vendor/main",
    appearance: { glyphMode: "ascii", showHeaderMark: 1 },
  } as ConfigInput);
  assert.deepEqual(config.appearance, { showLargeLogo: true, showHeaderMark: true, glyphMode: "ascii" });
  assert.equal(config.mainModel, "vendor/main");
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, appearance: null } as ConfigInput).appearance, DEFAULT_APPEARANCE);
});

test("appearance round-trips through save/load and a schema-v1 file without appearance reads additive defaults", async () => {
  const path = await configPath("appearance-roundtrip");
  await saveConfig(
    { ...DEFAULT_CONFIG, appearance: { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" } },
    path,
  );
  const written = await loadConfigDetailed(path);
  assert.equal(written.source, "file");
  assert.equal(written.warning, null);
  assert.deepEqual(written.config.appearance, { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" });
  const stored = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; appearance: unknown };
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.appearance, { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" });

  const legacyPath = await configPath("appearance-absent-v1");
  const raw = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: "vendor/main",
    providerSetup: createNeverConfiguredProviderState(),
  }, null, 2)}\n`;
  await writeFile(legacyPath, raw, { encoding: "utf8", mode: 0o600 });
  const loaded = await loadConfigDetailed(legacyPath);
  assert.equal(loaded.source, "file");
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.config.appearance, DEFAULT_APPEARANCE);
  assert.equal(loaded.config.mainModel, "vendor/main");
  assert.equal(await readFile(legacyPath, "utf8"), raw);
});

test("sameConfigFileSnapshot compares absence, parent identity, file identity and exact raw bytes", async () => {
  const path = await configPath("same-snapshot");
  const absentA = await readConfigFileSnapshot(path);
  const absentB = await readConfigFileSnapshot(path);
  assert.equal(sameConfigFileSnapshot(absentA, absentB), true);

  await writeFile(path, "one", { encoding: "utf8", mode: 0o600 });
  const fileA = await readConfigFileSnapshot(path);
  const fileB = await readConfigFileSnapshot(path);
  assert.equal(sameConfigFileSnapshot(fileA, fileB), true);
  assert.equal(sameConfigFileSnapshot(absentA, fileA), false);
  assert.equal(sameConfigFileSnapshot(fileA, absentA), false);

  await writeFile(path, "two", "utf8");
  const edited = await readConfigFileSnapshot(path);
  if (fileA.kind !== "file" || edited.kind !== "file") assert.fail("expected file snapshots");
  assert.equal(edited.ino, fileA.ino);
  assert.equal(edited.dev, fileA.dev);
  assert.equal(sameConfigFileSnapshot(fileA, edited), false);

  const replacement = `${path}.replacement`;
  await writeFile(replacement, "two", { encoding: "utf8", mode: 0o600 });
  await rename(replacement, path);
  const replaced = await readConfigFileSnapshot(path);
  if (replaced.kind !== "file") assert.fail("expected file snapshot");
  assert.equal(replaced.raw, edited.raw);
  assert.equal(sameConfigFileSnapshot(edited, replaced), false);

  const otherPath = await configPath("same-snapshot-other");
  assert.equal(sameConfigFileSnapshot(absentA, await readConfigFileSnapshot(otherPath)), false);

  const nestedPath = join(dirname(path), "missing", "config.json");
  const nestedAbsent = await readConfigFileSnapshot(nestedPath);
  assert.equal(nestedAbsent.parent.kind, "absent");
  assert.equal(sameConfigFileSnapshot(nestedAbsent, await readConfigFileSnapshot(nestedPath)), true);
  assert.equal(sameConfigFileSnapshot(nestedAbsent, absentA), false);
  assert.equal(sameConfigFileSnapshot(absentA, nestedAbsent), false);
});

test("readConfigEditSnapshot parses exactly the raw bytes it returns and yields defaults for an absent target", async () => {
  const absentPath = await configPath("edit-snapshot-absent");
  const absent = await readConfigEditSnapshot(absentPath);
  assert.equal(absent.file.kind, "absent");
  assert.deepEqual(absent.config, validateConfig({ ...DEFAULT_CONFIG } as ConfigInput));
  assert.ok(!("kind" in absent.config.providerSetup));
  assert.equal(absent.config.providerSetup.lifecycle, "never-configured");
  assert.deepEqual(absent.config.appearance, DEFAULT_APPEARANCE);
  assert.deepEqual(await readdir(dirname(absentPath)), []);
  assert.equal(Object.isFrozen(absent), true);
  assert.equal(Object.isFrozen(absent.config), true);

  const path = await configPath("edit-snapshot-file");
  const raw = `${JSON.stringify({
    schemaVersion: 1,
    mainModel: " vendor/main ",
    appearance: { glyphMode: "ascii" },
    providerSetup: { ...createNeverConfiguredProviderState(), revision: 3 },
  }, null, 4)}\n`;
  await writeFile(path, raw, { encoding: "utf8", mode: 0o600 });
  const snapshot = await readConfigEditSnapshot(path);
  if (snapshot.file.kind !== "file") assert.fail("expected file snapshot");
  assert.equal(snapshot.file.raw, raw);
  assert.equal(sameConfigFileSnapshot(snapshot.file, await readConfigFileSnapshot(path)), true);
  assert.equal(snapshot.config.mainModel, "vendor/main");
  assert.equal(snapshot.config.schemaVersion, 1);
  assert.deepEqual(snapshot.config.appearance, { showLargeLogo: true, showHeaderMark: true, glyphMode: "ascii" });
  assert.ok(!("kind" in snapshot.config.providerSetup));
  assert.equal(snapshot.config.providerSetup.revision, 3);
  assert.deepEqual(snapshot.config, validateConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) } as ConfigInput));
  assert.equal(await readFile(path, "utf8"), raw);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("saveConfigEdit creates an absent config exactly once and refuses the stale absent snapshot afterwards", async () => {
  const path = await configPath("edit-create-once");
  const expected = await readConfigEditSnapshot(path);
  const candidate = {
    ...expected.config,
    mainModel: "vendor/created",
    appearance: { showLargeLogo: false, showHeaderMark: true, glyphMode: "unicode" as const },
  };

  const saved = await saveConfigEdit(expected, candidate, path);
  assert.deepEqual(saved, validateConfig(candidate));
  const savedBytes = `${JSON.stringify(saved, null, 2)}\n`;
  assert.equal(await readFile(path, "utf8"), savedBytes);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  const stale = await saveConfigEdit(expected, { ...candidate, mainModel: "vendor/stale" }, path)
    .catch((error: unknown) => error);
  assert.ok(stale instanceof ConfigEditConflictError);
  assert.equal(stale.code, "config-edit-conflict");
  assert.equal(await readFile(path, "utf8"), savedBytes);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);

  const fresh = await readConfigEditSnapshot(path);
  assert.deepEqual(fresh.config, saved);
  const second = await saveConfigEdit(fresh, { ...fresh.config, mainModel: "vendor/second" }, path);
  assert.equal(second.mainModel, "vendor/second");
  assert.deepEqual(second.appearance, { showLargeLogo: false, showHeaderMark: true, glyphMode: "unicode" });
  assert.deepEqual((await readConfigEditSnapshot(path)).config, second);

  const nestedPath = join(dirname(path), "nested", "config.json");
  const nestedExpected = await readConfigEditSnapshot(nestedPath);
  assert.equal(nestedExpected.file.kind, "absent");
  assert.equal(nestedExpected.file.parent.kind, "absent");
  const nested = await saveConfigEdit(nestedExpected, { ...nestedExpected.config, mainModel: "vendor/nested" }, nestedPath);
  assert.equal(await readFile(nestedPath, "utf8"), `${JSON.stringify(nested, null, 2)}\n`);
  assert.deepEqual(await readdir(dirname(nestedPath)), ["config.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(dirname(nestedPath))).mode & 0o777, 0o700);
  }
});

test("a concurrent creator wins over an expected-absent edit and is never replaced", async () => {
  const path = await configPath("edit-create-race");
  const expected = await readConfigEditSnapshot(path);
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/concurrent-creator" }, path);
  const creatorBytes = await readFile(path, "utf8");

  const error = await saveConfigEdit(expected, { ...expected.config, mainModel: "vendor/stale-editor" }, path)
    .catch((reason: unknown) => reason);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.doesNotMatch(String(error), /concurrent-creator|stale-editor/);
  assert.equal(await readFile(path, "utf8"), creatorBytes);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);

  const racePath = await configPath("edit-create-fence-race");
  const raceExpected = await readConfigEditSnapshot(racePath);
  const raceBytes = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/fence-creator" }, null, 2)}\n`;
  const fenceError = await withConfigWriteLock(racePath, async (ownership) => {
    const racing: ConfigWriteOwnership = {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if ((await pendingTemporaryFiles(racePath)).length > 0 && !(await pathExists(racePath))) {
          await writeFile(racePath, raceBytes, { encoding: "utf8", mode: 0o600 });
        }
      },
    };
    return saveConfigEditUnderLock(racing, raceExpected, { ...raceExpected.config, mainModel: "vendor/stale-editor" })
      .catch((reason: unknown) => reason);
  });
  assert.ok(fenceError instanceof ConfigEditConflictError);
  assert.equal(fenceError.code, "config-edit-conflict");
  assert.equal(await readFile(racePath, "utf8"), raceBytes);
  assert.deepEqual(await readdir(dirname(racePath)), ["config.json"]);
});

test("a same-inode in-place byte edit after editor open is rejected as config-edit-conflict", async () => {
  const path = await configPath("edit-same-inode");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/original" }, path);
  const expected = await readConfigEditSnapshot(path);
  const before = await lstat(path, { bigint: true });

  const edited = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/edited-in-place" }, null, 2)}\n`;
  const handle = await open(path, "r+");
  try {
    await handle.truncate(0);
    await handle.write(edited, 0, "utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  // The identity-only pre-publication check cannot see this edit; only the raw-byte CAS can.
  await assertConfigFileSnapshot(path, expected.file);

  const error = await saveConfigEdit(expected, { ...expected.config, mainModel: "vendor/stale" }, path)
    .catch((reason: unknown) => reason);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.equal(await readFile(path, "utf8"), edited);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("atomic file replacement after editor open is rejected even with identical bytes", async () => {
  const path = await configPath("edit-replaced");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/original" }, path);
  const expected = await readConfigEditSnapshot(path);

  const replaced = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/replaced" }, null, 2)}\n`;
  const temporary = `${path}.replacement`;
  await writeFile(temporary, replaced, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  const error = await saveConfigEdit(expected, { ...expected.config, mainModel: "vendor/stale" }, path)
    .catch((reason: unknown) => reason);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.equal(await readFile(path, "utf8"), replaced);

  const identicalPath = await configPath("edit-replaced-identical");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/original" }, identicalPath);
  const identicalExpected = await readConfigEditSnapshot(identicalPath);
  if (identicalExpected.file.kind !== "file") assert.fail("expected file snapshot");
  const identicalTemporary = `${identicalPath}.replacement`;
  await writeFile(identicalTemporary, identicalExpected.file.raw, { encoding: "utf8", mode: 0o600 });
  await rename(identicalTemporary, identicalPath);
  const identicalError = await saveConfigEdit(
    identicalExpected,
    { ...identicalExpected.config, mainModel: "vendor/stale" },
    identicalPath,
  ).catch((reason: unknown) => reason);
  assert.ok(identicalError instanceof ConfigEditConflictError);
  assert.equal(await readFile(identicalPath, "utf8"), identicalExpected.file.raw);
  assert.deepEqual(await readdir(dirname(identicalPath)), ["config.json"]);
});

test("a concurrent provider-state change is never overwritten by a stale edit", async () => {
  const path = await configPath("edit-provider-state-race");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/original" }, path);
  const expected = await readConfigEditSnapshot(path);

  // A concurrent provider writer advances the persisted revision in place.
  const providerBytes = `${JSON.stringify({
    ...DEFAULT_CONFIG,
    mainModel: "vendor/original",
    providerSetup: { ...createNeverConfiguredProviderState(), revision: 1 },
  }, null, 2)}\n`;
  await writeFile(path, providerBytes, "utf8");
  const error = await saveConfigEdit(
    expected,
    { ...expected.config, appearance: { ...expected.config.appearance, glyphMode: "ascii" } },
    path,
  ).catch((reason: unknown) => reason);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.equal(await readFile(path, "utf8"), providerBytes);
  const stored = JSON.parse(providerBytes) as { providerSetup: { revision: number }; appearance: { glyphMode: string } };
  assert.equal(stored.providerSetup.revision, 1);
  assert.equal(stored.appearance.glyphMode, "auto");

  const fresh = await readConfigEditSnapshot(path);
  const nonPersistable = await saveConfigEdit(
    fresh,
    { ...fresh.config, providerSetup: { schemaVersion: 99, opaque: "future" } },
    path,
  ).catch((reason: unknown) => reason);
  assert.ok(nonPersistable instanceof Error);
  assert.match(String(nonPersistable), /future-version/);
  assert.equal(await readFile(path, "utf8"), providerBytes);
});

test("corrupt, non-object, future and non-persistable configs are config-edit-unavailable and stay byte-identical", async () => {
  const cases = [
    { name: "corrupt-json", raw: "{ not json", tolerant: /beschädigt/ },
    { name: "non-object", raw: "[1,2,3]\n", tolerant: /kein Objekt/ },
    { name: "future-schema", raw: JSON.stringify({ schemaVersion: 2, mainModel: "future/model" }), tolerant: /zukünftige/ },
    { name: "future-provider", raw: JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 99, opaque: "keep-exactly" } }), tolerant: null },
    { name: "corrupt-provider", raw: JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 2, connections: "wrong" } }), tolerant: null },
  ] as const;
  for (const entry of cases) {
    const path = await configPath(`edit-unavailable-${entry.name}`);
    await writeFile(path, entry.raw, { encoding: "utf8", mode: 0o600 });
    const error = await readConfigEditSnapshot(path).catch((reason: unknown) => reason);
    assert.ok(error instanceof ConfigEditUnavailableError, entry.name);
    assert.equal(error.code, "config-edit-unavailable", entry.name);
    assert.doesNotMatch(String(error), /keep-exactly|future\/model|not json/, entry.name);
    assert.equal(await readFile(path, "utf8"), entry.raw, entry.name);
    assert.deepEqual(await readdir(dirname(path)), ["config.json"], entry.name);

    const tolerant = await loadConfigDetailed(path);
    if (entry.tolerant) {
      assert.equal(tolerant.source, "defaults", entry.name);
      assert.match(tolerant.warning ?? "", entry.tolerant, entry.name);
    } else {
      assert.equal(tolerant.source, "file", entry.name);
      assert.ok("kind" in tolerant.config.providerSetup, entry.name);
    }
    assert.equal(await readFile(path, "utf8"), entry.raw, entry.name);
  }

  const symlinkPath = await configPath("edit-unavailable-symlink");
  const outsideRoot = await mkdtemp(join(tmpdir(), "routercode-edit-outside-"));
  const outside = join(outsideRoot, "outside.json");
  const sentinel = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "outside-secret-sentinel" })}\n`;
  await writeFile(outside, sentinel, "utf8");
  await symlink(outside, symlinkPath);
  const symlinkError = await readConfigEditSnapshot(symlinkPath).catch((reason: unknown) => reason);
  assert.ok(symlinkError instanceof ConfigEditUnavailableError);
  assert.doesNotMatch(String(symlinkError), /outside-secret-sentinel/);
  assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), sentinel);
});

test("an injected write failure leaves the old file byte-identical without temp files", async () => {
  const path = await configPath("edit-write-failure");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/old" }, path);
  const oldBytes = await readFile(path, "utf8");
  const expected = await readConfigEditSnapshot(path);
  const candidate = { ...expected.config, mainModel: "vendor/new" };

  const fenceReason = new Error("fixed ownership fence rejection");
  let fenceCalls = 0;
  const fenceError = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if ((await pendingTemporaryFiles(path)).length > 0) {
          fenceCalls += 1;
          throw fenceReason;
        }
      },
    },
    expected,
    candidate,
  ).catch((reason: unknown) => reason));
  assert.equal(fenceError, fenceReason);
  assert.equal(fenceCalls, 1);
  assert.equal(await readFile(path, "utf8"), oldBytes);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);

  const nested = await withConfigWriteLock(path, () => saveConfigEdit(expected, candidate, path)
    .catch((reason: unknown) => reason));
  assert.match(String(nested), /Nested config writer ownership/);
  assert.equal(await readFile(path, "utf8"), oldBytes);

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await chmod(dirname(path), 0o500);
    let writeError: unknown;
    try {
      writeError = await saveConfigEdit(expected, candidate, path).catch((reason: unknown) => reason);
    } finally {
      await chmod(dirname(path), 0o700);
    }
    assert.ok(writeError instanceof Error);
    assert.equal(writeError instanceof ConfigEditConflictError, false);
    assert.equal(writeError instanceof ConfigEditUnavailableError, false);
    assert.equal(await readFile(path, "utf8"), oldBytes);
    assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
  }

  const saved = await saveConfigEdit(expected, candidate, path);
  assert.equal(saved.mainModel, "vendor/new");
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(saved, null, 2)}\n`);
});

test("saveConfigEdit returns the exact frozen validated value and mutates no caller-owned object", async () => {
  const path = await configPath("edit-exact-value");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/old", fallbackModels: ["vendor/fallback"] }, path);
  const expected = await readConfigEditSnapshot(path);
  const expectedClone = structuredClone(expected);
  const candidate = {
    ...expected.config,
    mainModel: " vendor/new ",
    maxSteps: 500,
    fallbackModels: [...expected.config.fallbackModels, " vendor/extra ", ""],
    appearance: { showLargeLogo: false, showHeaderMark: false, glyphMode: "ascii" as const },
  };
  const candidateClone = structuredClone(candidate);
  const live = { ...expected.config };
  const liveClone = structuredClone(live);

  const saved = await saveConfigEdit(expected, candidate, path);
  assert.deepEqual(saved, validateConfig(candidate));
  assert.equal(saved.mainModel, "vendor/new");
  assert.equal(saved.maxSteps, DEFAULT_CONFIG.maxSteps);
  assert.deepEqual(saved.fallbackModels, ["vendor/fallback", "vendor/extra"]);
  assert.equal(Object.isFrozen(saved), true);
  assert.notEqual(saved, candidate);
  assert.notEqual(saved.fallbackModels, candidate.fallbackModels);
  assert.notEqual(saved.appearance, candidate.appearance);
  assert.deepEqual(expected, expectedClone);
  assert.deepEqual(candidate, candidateClone);
  assert.deepEqual(live, liveClone);
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(saved, null, 2)}\n`);
  assert.deepEqual((await readConfigEditSnapshot(path)).config, saved);
  assert.deepEqual((await loadConfigDetailed(path)).config, saved);
});

test("a same-inode edit of invalid UTF-8 bytes that decode identically is still a config-edit-conflict", async () => {
  const path = await configPath("edit-invalid-utf8");
  const head = Buffer.from('{"schemaVersion":1,"mainModel":"vendor/', "utf8");
  const tail = Buffer.from(`","providerSetup":${JSON.stringify(createNeverConfiguredProviderState())}}\n`, "utf8");
  const original = Buffer.concat([head, Buffer.from([0x80]), tail]);
  const mutated = Buffer.concat([head, Buffer.from([0x81]), tail]);
  assert.equal(original.equals(mutated), false);
  assert.equal(original.toString("utf8"), mutated.toString("utf8"));
  await writeFile(path, original, { mode: 0o600 });

  const expected = await readConfigEditSnapshot(path);
  if (expected.file.kind !== "file") assert.fail("expected file snapshot");
  assert.equal(expected.file.raw, original.toString("utf8"));
  assert.equal(expected.file.digest, createHash("sha256").update(original).digest("hex"));
  assert.equal(expected.config.mainModel, "vendor/�");
  const before = await lstat(path, { bigint: true });

  const handle = await open(path, "r+");
  try {
    await handle.write(mutated, 0, mutated.length, 0);
  } finally {
    await handle.close();
  }
  const after = await lstat(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.deepEqual(await readFile(path), mutated);
  // Identity-only and decoded-text comparisons cannot see this edit; only the byte proof can.
  await assertConfigFileSnapshot(path, expected.file);
  const current = await readConfigFileSnapshot(path);
  if (current.kind !== "file") assert.fail("expected file snapshot");
  assert.equal(current.raw, expected.file.raw);
  assert.notEqual(current.digest, expected.file.digest);
  assert.equal(sameConfigFileSnapshot(expected.file, current), false);
  assert.equal(sameConfigFileSnapshot(current, await readConfigFileSnapshot(path)), true);

  const error = await saveConfigEdit(
    expected,
    { ...expected.config, appearance: { ...expected.config.appearance, glyphMode: "ascii" } },
    path,
  ).catch((reason: unknown) => reason);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.deepEqual(await readFile(path), mutated);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("readConfigEditSnapshot never allocates a legacy provider identity and is unavailable until startup migration persisted providerSetup", async () => {
  const path = await configPath("edit-legacy-provider");
  const raw = `${JSON.stringify({ schemaVersion: 1, mainModel: "openrouter/auto", provider: { dataCollection: "allow" } }, null, 2)}\n`;
  await writeFile(path, raw, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const error = await readConfigEditSnapshot(path).catch((reason: unknown) => reason);
    assert.ok(error instanceof ConfigEditUnavailableError, `attempt ${attempt}`);
    assert.equal(error.code, "config-edit-unavailable");
    assert.doesNotMatch(String(error), /openrouter|legacy/);
  }
  assert.equal(await readFile(path, "utf8"), raw);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);

  const v0Path = await configPath("edit-legacy-v0");
  const v0Raw = JSON.stringify({ mainModel: "legacy/model" });
  await writeFile(v0Path, v0Raw, { encoding: "utf8", mode: 0o600 });
  const v0Error = await readConfigEditSnapshot(v0Path).catch((reason: unknown) => reason);
  assert.ok(v0Error instanceof ConfigEditUnavailableError);
  assert.equal(await readFile(v0Path, "utf8"), v0Raw);

  // Tolerant startup is unchanged: it still migrates in memory with the injected id and writes nothing.
  const startup = await loadConfigDetailed(path, { randomUUID: () => "startup-legacy-id" });
  assert.equal(startup.source, "file");
  assert.equal(startup.warning, null);
  if ("kind" in startup.config.providerSetup) assert.fail("expected persistable provider state");
  assert.equal(startup.config.providerSetup.lifecycle, "migrated");
  assert.equal(startup.config.providerSetup.connections[0]?.id, "startup-legacy-id");
  assert.equal(await readFile(path, "utf8"), raw);

  // Once the authoritative migration persisted stable provider state, identical bytes yield identical configs.
  await saveConfig(startup.config, path);
  const first = await readConfigEditSnapshot(path);
  const second = await readConfigEditSnapshot(path);
  assert.deepEqual(first.config, second.config);
  assert.equal(sameConfigFileSnapshot(first.file, second.file), true);
  if ("kind" in first.config.providerSetup) assert.fail("expected persistable provider state");
  assert.equal(first.config.providerSetup.connections[0]?.id, "startup-legacy-id");
  const reloaded = await loadConfigDetailed(path, {
    randomUUID: () => {
      throw new Error("persisted provider state must not allocate");
    },
  });
  assert.deepEqual(first.config, reloaded.config);

  const saved = await saveConfigEdit(
    first,
    { ...first.config, appearance: { ...first.config.appearance, glyphMode: "ascii" } },
    path,
  );
  assert.deepEqual(saved.providerSetup, first.config.providerSetup);
  assert.equal(saved.appearance.glyphMode, "ascii");
  const stored = JSON.parse(await readFile(path, "utf8")) as { providerSetup: { connections: { id: string }[] } };
  assert.equal(stored.providerSetup.connections[0]?.id, "startup-legacy-id");
});

test("a foreign parent directory created after the absent snapshot is never adopted, published into, or touched", async () => {
  const root = dirname(await configPath("edit-foreign-parent"));
  const parent = join(root, "nested");
  const path = join(parent, "config.json");
  const expected = await readConfigEditSnapshot(path);
  assert.equal(expected.file.kind, "absent");
  assert.equal(expected.file.parent.kind, "absent");

  let fenceCalls = 0;
  let planted = false;
  const error = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        fenceCalls += 1;
        // A competing process creates the parent after the first exact recheck.
        if (fenceCalls >= 2 && !planted && !(await pathExists(parent))) {
          planted = true;
          await mkdir(parent);
          await chmod(parent, 0o755);
          await writeFile(join(parent, "sentinel"), "foreign-sentinel", { encoding: "utf8", mode: 0o644 });
        }
      },
    },
    expected,
    { ...expected.config, mainModel: "vendor/stale-editor" },
  ).catch((reason: unknown) => reason));
  assert.equal(planted, true);
  assert.ok(error instanceof ConfigEditConflictError);
  assert.equal(error.code, "config-edit-conflict");
  assert.doesNotMatch(String(error), /stale-editor|sentinel|nested/);
  assert.deepEqual(await readdir(parent), ["sentinel"]);
  assert.equal(await readFile(join(parent, "sentinel"), "utf8"), "foreign-sentinel");
  if (process.platform !== "win32") {
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
  }
  assert.equal(await pathExists(path), false);

  // A foreign creator that already published its own config inside the new parent keeps it byte-exact.
  const otherRoot = dirname(await configPath("edit-foreign-parent-config"));
  const otherParent = join(otherRoot, "nested");
  const otherPath = join(otherParent, "config.json");
  const otherExpected = await readConfigEditSnapshot(otherPath);
  const foreignBytes = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/foreign-creator" }, null, 2)}\n`;
  let otherCalls = 0;
  const otherError = await withConfigWriteLock(otherPath, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        otherCalls += 1;
        if (otherCalls >= 2 && !(await pathExists(otherParent))) {
          await mkdir(otherParent);
          await chmod(otherParent, 0o755);
          await writeFile(otherPath, foreignBytes, { encoding: "utf8", mode: 0o600 });
        }
      },
    },
    otherExpected,
    { ...otherExpected.config, mainModel: "vendor/stale-editor" },
  ).catch((reason: unknown) => reason));
  assert.ok(otherError instanceof ConfigEditConflictError);
  assert.equal(await readFile(otherPath, "utf8"), foreignBytes);
  assert.deepEqual(await readdir(otherParent), ["config.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(otherParent)).mode & 0o777, 0o755);
  }
});

test("post-publication ownership loss adopts a confirmed commit and an unverifiable publication is config-edit-unverified", async () => {
  const path = await configPath("edit-post-publication");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/old" }, path);
  const fenceReason = new Error("fixed post-publication ownership rejection");
  const bytesOf = (candidate: ConfigInput): string => `${JSON.stringify(validateConfig(candidate), null, 2)}\n`;
  const currentBytes = async (target: string): Promise<string | null> =>
    readFile(target, "utf8").catch(() => null);

  // Ownership is lost only after the candidate bytes are durable: the commit is confirmed and adopted.
  const expected = await readConfigEditSnapshot(path);
  const candidate = { ...expected.config, mainModel: "vendor/new" };
  let rejections = 0;
  const adopted = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if ((await currentBytes(path)) === bytesOf(candidate)) {
          rejections += 1;
          throw fenceReason;
        }
      },
    },
    expected,
    candidate,
  ));
  assert.deepEqual(adopted, validateConfig(candidate));
  assert.ok(rejections >= 1);
  assert.equal(await readFile(path, "utf8"), bytesOf(candidate));
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
  assert.deepEqual((await readConfigEditSnapshot(path)).config, adopted);

  // Ownership is lost and a foreign writer replaces the durable candidate before readback.
  const second = await readConfigEditSnapshot(path);
  const secondCandidate = { ...second.config, mainModel: "vendor/second" };
  const foreign = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/foreign-after-publish" }, null, 2)}\n`;
  let replaced = false;
  const unverified = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if (!replaced && (await currentBytes(path)) === bytesOf(secondCandidate)) {
          replaced = true;
          await writeFile(path, foreign, "utf8");
          throw fenceReason;
        }
      },
    },
    second,
    secondCandidate,
  ).catch((reason: unknown) => reason));
  assert.equal(replaced, true);
  assert.ok(isConfigEditUnverified(unverified), String(unverified));
  assert.equal(unverified.code, "config-edit-unverified");
  assert.equal(unverified instanceof ConfigEditConflictError, false);
  assert.notEqual(unverified, fenceReason);
  assert.doesNotMatch(String(unverified), /vendor\/|foreign|second/);
  assert.equal(await readFile(path, "utf8"), foreign);
  assert.equal((await readConfigEditSnapshot(path)).config.mainModel, "vendor/foreign-after-publish");
  // The stale snapshot is no longer authoritative: a retry from it conflicts instead of overwriting.
  const retry = await saveConfigEdit(second, secondCandidate, path).catch((reason: unknown) => reason);
  assert.ok(retry instanceof ConfigEditConflictError);
  assert.equal(await readFile(path, "utf8"), foreign);

  // Readback becomes impossible after publication: never a silent success, never a conflict.
  const third = await readConfigEditSnapshot(path);
  const thirdCandidate = { ...third.config, mainModel: "vendor/third" };
  let broken = false;
  const unreadable = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if (!broken && (await currentBytes(path)) === bytesOf(thirdCandidate)) {
          broken = true;
          await rename(path, `${path}.published`);
          await mkdir(path);
        }
      },
    },
    third,
    thirdCandidate,
  ).catch((reason: unknown) => reason));
  assert.equal(broken, true);
  assert.ok(isConfigEditUnverified(unreadable), String(unreadable));
  assert.equal(unreadable.code, "config-edit-unverified");
  assert.equal(await readFile(`${path}.published`, "utf8"), bytesOf(thirdCandidate));
  const afterwards = await readConfigEditSnapshot(path).catch((reason: unknown) => reason);
  assert.ok(afterwards instanceof ConfigEditUnavailableError);

  // The create-only path adopts a confirmed commit the same way.
  const createPath = await configPath("edit-post-publication-create");
  const createExpected = await readConfigEditSnapshot(createPath);
  const createCandidate = { ...createExpected.config, mainModel: "vendor/created" };
  let createRejections = 0;
  const created = await withConfigWriteLock(createPath, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if ((await currentBytes(createPath)) === bytesOf(createCandidate)) {
          createRejections += 1;
          throw fenceReason;
        }
      },
    },
    createExpected,
    createCandidate,
  ));
  assert.deepEqual(created, validateConfig(createCandidate));
  assert.ok(createRejections >= 1);
  assert.equal(await readFile(createPath, "utf8"), bytesOf(createCandidate));
  assert.deepEqual(await readdir(dirname(createPath)), ["config.json"]);
});

function assertDeepFrozen(value: unknown, label: string, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${label}.${key}`, seen);
  }
}

test("edit snapshots and saved configs are deeply frozen while caller-owned objects stay mutable", async () => {
  const legacyPath = await configPath("edit-deep-freeze-legacy");
  await writeFile(legacyPath, JSON.stringify({ mainModel: "vendor/main" }));
  const migrated = (await loadConfigDetailed(legacyPath, { randomUUID: () => "deep-freeze-id" })).config;
  const path = await configPath("edit-deep-freeze");
  await saveConfig({
    ...migrated,
    fallbackModels: ["vendor/fallback"],
    panelModels: ["vendor/a", "vendor/b"],
    reasoningByModel: { "vendor/main": { mode: "effort", effort: "high" } },
    verify: { commands: ["npm test"], mode: "on-edit", maxRepairRounds: 1 },
  }, path);

  const snapshot = await readConfigEditSnapshot(path);
  assertDeepFrozen(snapshot, "snapshot");
  if ("kind" in snapshot.config.providerSetup) assert.fail("expected persistable provider state");
  assert.equal(snapshot.config.providerSetup.connections.length, 1);
  const connection = snapshot.config.providerSetup.connections[0] as { enabled: boolean };
  assert.throws(() => { (snapshot.config.appearance as { glyphMode: string }).glyphMode = "ascii"; }, TypeError);
  assert.throws(() => { (snapshot.config.fallbackModels as string[]).push("vendor/extra"); }, TypeError);
  assert.throws(() => { connection.enabled = false; }, TypeError);
  assert.throws(() => { (snapshot.config.reasoningByModel["vendor/main"] as { mode: string }).mode = "auto"; }, TypeError);
  assert.throws(() => { (snapshot.config.verify.commands as string[]).pop(); }, TypeError);
  assert.equal(sameConfigFileSnapshot(snapshot.file, await readConfigFileSnapshot(path)), true);

  const candidateAppearance: AppearanceConfig = { ...snapshot.config.appearance, glyphMode: "ascii" };
  const candidate = {
    ...snapshot.config,
    appearance: candidateAppearance,
    fallbackModels: [...snapshot.config.fallbackModels, "vendor/extra"],
    providerSetup: structuredClone(snapshot.config.providerSetup),
    reasoningByModel: structuredClone(snapshot.config.reasoningByModel),
  };
  const saved = await saveConfigEdit(snapshot, candidate, path);
  assertDeepFrozen(saved, "saved");
  assert.deepEqual(saved, validateConfig(candidate));
  assert.throws(() => { (saved.appearance as { glyphMode: string }).glyphMode = "unicode"; }, TypeError);
  assert.notEqual(saved.appearance, candidate.appearance);
  assert.notEqual(saved.providerSetup, candidate.providerSetup);
  assert.notEqual(saved.fallbackModels, candidate.fallbackModels);
  assert.equal(Object.isFrozen(candidate), false);
  assert.equal(Object.isFrozen(candidate.appearance), false);
  assert.equal(Object.isFrozen(candidate.fallbackModels), false);
  assert.equal(Object.isFrozen(candidate.providerSetup), false);
  assert.equal(Object.isFrozen(candidate.providerSetup.connections[0]), false);
  assert.equal(Object.isFrozen(candidate.reasoningByModel["vendor/main"]), false);
  candidate.appearance.glyphMode = "unicode";
  candidate.fallbackModels.push("vendor/later");
  assert.equal(saved.appearance.glyphMode, "ascii");
  assert.deepEqual(saved.fallbackModels, ["vendor/fallback", "vendor/extra"]);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), false);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.appearance), false);
  assert.equal(Object.isFrozen(DEFAULT_APPEARANCE), false);
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(saved, null, 2)}\n`);
  assert.deepEqual((await readConfigEditSnapshot(path)).config, saved);

  // The intended live-object pattern: copy, never adopt frozen references.
  const live = structuredClone(saved);
  live.appearance.glyphMode = "auto";
  assert.equal(saved.appearance.glyphMode, "ascii");
});

test("saveConfigEdit adopts an exactly confirmed commit or stays typed-unverified when the outer lock release fails, and keeps earlier errors verbatim", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const path = await configPath("edit-release-failure");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/old" }, path);
  const bytesOf = (candidate: ConfigInput): string => `${JSON.stringify(validateConfig(candidate), null, 2)}\n`;
  const releaseReason = new Error("fixed release verification failure");
  const originalRelease = PrivateStore.prototype.releaseDirectoryClaim;
  const originalAssert = PrivateStore.prototype.assertDirectoryClaim;
  let releases = 0;
  let foreignPlant: (() => Promise<void>) | null = null;
  PrivateStore.prototype.releaseDirectoryClaim = async function (this: InstanceType<typeof PrivateStore>, ...args) {
    await originalRelease.apply(this, args);
    releases += 1;
    throw releaseReason;
  };
  PrivateStore.prototype.assertDirectoryClaim = async function (this: InstanceType<typeof PrivateStore>, ...args) {
    await originalAssert.apply(this, args);
    await foreignPlant?.();
  };
  try {
    // Control: the bare lock surfaces the release failure, so the seam is real.
    const control = await withConfigWriteLock(path, async () => "done").catch((reason: unknown) => reason);
    assert.match(String(control), /release could not be verified/);
    assert.equal(releases, 1);

    // Durable and exactly confirmed, then the outer release fails: adopted, never the raw release error.
    const expected = await readConfigEditSnapshot(path);
    const candidate = { ...expected.config, mainModel: "vendor/new" };
    const saved = await saveConfigEdit(expected, candidate, path);
    assert.deepEqual(saved, validateConfig(candidate));
    assert.equal(Object.isFrozen(saved), true);
    assert.equal(Object.isFrozen(saved.appearance), true);
    assert.equal(await readFile(path, "utf8"), bytesOf(candidate));
    assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
    assert.equal(releases, 2);

    // Pre-publication failure with the same failing release: the conflict identity is preserved.
    const stale = await saveConfigEdit(expected, { ...candidate, mainModel: "vendor/stale" }, path)
      .catch((reason: unknown) => reason);
    assert.ok(stale instanceof ConfigEditConflictError);
    assert.equal(await readFile(path, "utf8"), bytesOf(candidate));
    assert.equal(releases, 3);

    // Pre-task failure (nested ownership) is neither adopted nor reclassified.
    let nested: unknown;
    await withConfigWriteLock(path, async () => {
      nested = await saveConfigEdit(expected, candidate, path).catch((reason: unknown) => reason);
    }).catch(() => undefined);
    assert.match(String(nested), /Nested config writer ownership/);
    assert.equal(isConfigEditUnverified(nested), false);

    // Pre-acquisition failure (symlinked parent) surfaces verbatim and writes nothing.
    const linkRoot = await mkdtemp(join(tmpdir(), "routercode-edit-release-link-"));
    const linkDir = join(linkRoot, "linked");
    await symlink(dirname(path), linkDir);
    const before = await readFile(path, "utf8");
    const aliased = await saveConfigEdit(await readConfigEditSnapshot(path), { ...candidate, mainModel: "vendor/aliased" }, join(linkDir, "config.json"))
      .catch((reason: unknown) => reason);
    assert.match(String(aliased), /real directory|could not be verified/);
    assert.equal(isConfigEditUnverified(aliased), false);
    assert.equal(aliased instanceof ConfigEditConflictError, false);
    assert.equal(await readFile(path, "utf8"), before);

    // Post-publication foreign replacement plus failing release: typed unverified, never the raw release error.
    const second = await readConfigEditSnapshot(path);
    const secondCandidate = { ...second.config, mainModel: "vendor/second" };
    const foreign = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/foreign-after-publish" }, null, 2)}\n`;
    let planted = false;
    foreignPlant = async () => {
      if (planted || (await readFile(path, "utf8")) !== bytesOf(secondCandidate)) return;
      planted = true;
      await writeFile(path, foreign, "utf8");
    };
    const unverified = await saveConfigEdit(second, secondCandidate, path).catch((reason: unknown) => reason);
    foreignPlant = null;
    assert.equal(planted, true);
    assert.ok(isConfigEditUnverified(unverified), String(unverified));
    assert.notEqual(unverified, releaseReason);
    assert.equal(await readFile(path, "utf8"), foreign);
  } finally {
    PrivateStore.prototype.releaseDirectoryClaim = originalRelease;
    PrivateStore.prototype.assertDirectoryClaim = originalAssert;
  }
  const fresh = await readConfigEditSnapshot(path);
  const after = await saveConfigEdit(fresh, { ...fresh.config, mainModel: "vendor/after-seam" }, path);
  assert.equal(after.mainModel, "vendor/after-seam");
});

test("a replacement of the parent this writer just created is rejected at every later fence and is never chmod-ed or published into", async () => {
  const scenarios = [
    { name: "at the next fence after exclusive creation", replaceOnExistingCall: 1 },
    { name: "after the publish snapshot before directory preparation", replaceOnExistingCall: 2 },
  ] as const;
  for (const scenario of scenarios) {
    const root = dirname(await configPath(`edit-created-parent-${scenario.replaceOnExistingCall}`));
    const parent = join(root, "nested");
    const moved = join(root, "nested.moved");
    const path = join(parent, "config.json");
    const expected = await readConfigEditSnapshot(path);
    assert.equal(expected.file.kind, "absent");
    assert.equal(expected.file.parent.kind, "absent");

    let existingCalls = 0;
    let replaced = false;
    const error = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
      {
        canonicalPath: ownership.canonicalPath,
        assertHeld: async () => {
          await ownership.assertHeld();
          if (replaced || !(await pathExists(parent))) return;
          existingCalls += 1;
          if (existingCalls === scenario.replaceOnExistingCall) {
            replaced = true;
            // The writer's own directory survives elsewhere, so the replacement has a distinct identity.
            await rename(parent, moved);
            await mkdir(parent);
            await chmod(parent, 0o755);
            await writeFile(join(parent, "sentinel"), "foreign-sentinel", { encoding: "utf8", mode: 0o644 });
          }
        },
      },
      expected,
      { ...expected.config, mainModel: "vendor/stale-editor" },
    ).catch((reason: unknown) => reason));
    assert.equal(replaced, true, scenario.name);
    assert.ok(error instanceof ConfigEditConflictError, `${scenario.name}: ${String(error)}`);
    assert.doesNotMatch(String(error), /stale-editor|sentinel|nested/);
    assert.deepEqual(await readdir(parent), ["sentinel"], scenario.name);
    assert.equal(await readFile(join(parent, "sentinel"), "utf8"), "foreign-sentinel");
    if (process.platform !== "win32") {
      assert.equal((await stat(parent)).mode & 0o777, 0o755, scenario.name);
      assert.equal((await stat(moved)).mode & 0o777, 0o700, scenario.name);
    }
    assert.deepEqual(await readdir(moved), [], scenario.name);
    assert.equal(await pathExists(path), false, scenario.name);
  }
});

test("saveConfigEdit re-reads exactly after a failed outer release and is typed-unverified when the confirmed bytes were superseded meanwhile", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const path = await configPath("edit-release-supersede");
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/old" }, path);
  const expected = await readConfigEditSnapshot(path);
  const candidate = { ...expected.config, mainModel: "vendor/new" };
  const content = `${JSON.stringify(validateConfig(candidate), null, 2)}\n`;
  const foreign = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/foreign-after-release" }, null, 2)}\n`;
  const releaseReason = new Error("fixed release verification failure");
  const originalRelease = PrivateStore.prototype.releaseDirectoryClaim;
  let superseded = false;
  PrivateStore.prototype.releaseDirectoryClaim = async function (this: InstanceType<typeof PrivateStore>, ...args) {
    await originalRelease.apply(this, args);
    // The real release completed; a foreign writer supersedes the confirmed bytes before the failure surfaces.
    if (!superseded && (await readFile(path, "utf8")) === content) {
      superseded = true;
      await writeFile(path, foreign, "utf8");
    }
    throw releaseReason;
  };
  try {
    const result = await saveConfigEdit(expected, candidate, path).catch((reason: unknown) => reason);
    assert.equal(superseded, true);
    assert.ok(isConfigEditUnverified(result), String(result));
    assert.notEqual(result, releaseReason);
    assert.equal(await readFile(path, "utf8"), foreign);
    assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
  } finally {
    PrivateStore.prototype.releaseDirectoryClaim = originalRelease;
  }
  const fresh = await readConfigEditSnapshot(path);
  assert.equal(fresh.config.mainModel, "vendor/foreign-after-release");
  const after = await saveConfigEdit(fresh, { ...fresh.config, mainModel: "vendor/after-supersede" }, path);
  assert.equal(after.mainModel, "vendor/after-supersede");
});

test("the create-only edit path publishes 0600 from the secured temp handle under a restrictive umask and never chmod-s an after-fence replacement", async () => {
  if (process.platform === "win32") return;
  // The restrictive umask is applied only under the held lock (PrivateStore verifies exact modes while
  // acquiring) and restored at the first post-link fence. The temp file is created as 0400 by the umask;
  // the writer must secure 0600 on the exact temp handle before linking, so no pathname chmod exists after
  // publication. The replacement is planted deterministically in a microtask after that fence resolves.
  const previousUmask = process.umask();
  let umaskApplied = false;
  const restoreUmask = () => {
    if (umaskApplied) {
      umaskApplied = false;
      process.umask(previousUmask);
    }
  };
  // Every pathname `chmod` of the final config path is counted through the builtin the sources import;
  // handle-bound `FileHandle.chmod` is a different function and stays allowed (and required).
  const fsModule = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const originalChmod = fsModule.promises.chmod;
  let finalPathChmods = 0;
  let restoreChmod: (() => void) | null = null;
  try {
    const root = dirname(await configPath("edit-handle-secured-mode"));
    const parent = join(root, "nested");
    const moved = join(root, "nested.moved");
    const path = join(parent, "config.json");
    (fsModule.promises as { chmod: typeof originalChmod }).chmod = (async (target, mode) => {
      if (String(target) === path) finalPathChmods += 1;
      return originalChmod(target, mode);
    }) as typeof originalChmod;
    syncBuiltinESMExports();
    restoreChmod = () => {
      (fsModule.promises as { chmod: typeof originalChmod }).chmod = originalChmod;
      syncBuiltinESMExports();
    };
    const expected = await readConfigEditSnapshot(path);
    assert.equal(expected.file.kind, "absent");
    assert.equal(expected.file.parent.kind, "absent");
    const candidate = { ...expected.config, mainModel: "vendor/created" };
    const content = `${JSON.stringify(validateConfig(candidate), null, 2)}\n`;
    const foreign = `${JSON.stringify({ ...DEFAULT_CONFIG, mainModel: "vendor/foreign-replacement" }, null, 2)}\n`;

    let observedMode: number | null = null;
    let replaced = false;
    const error = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
      {
        canonicalPath: ownership.canonicalPath,
        assertHeld: async () => {
          await ownership.assertHeld();
          if (replaced) return;
          if (!umaskApplied) {
            umaskApplied = true;
            process.umask(0o277);
          }
          if ((await readFile(path, "utf8").catch(() => null)) !== content) return;
          // First fence after the link: the published file is already 0600 (secured on the temp handle).
          observedMode = (await stat(path)).mode & 0o777;
          restoreUmask();
          replaced = true;
          queueMicrotask(() => {
            renameSync(parent, moved);
            mkdirSync(parent);
            chmodSync(parent, 0o755);
            writeFileSync(join(parent, "config.json"), foreign, { encoding: "utf8", mode: 0o644 });
            chmodSync(join(parent, "config.json"), 0o644);
          });
        },
      },
      expected,
      candidate,
    ).catch((reason: unknown) => reason));
    assert.equal(replaced, true);
    assert.equal(observedMode, 0o600, "the published file must already be 0600 at the first post-link fence");
    assert.ok(isConfigEditUnverified(error), String(error));
    assert.equal((await stat(join(parent, "config.json"))).mode & 0o777, 0o644, "replacement never chmod-ed");
    assert.equal(await readFile(join(parent, "config.json"), "utf8"), foreign);
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(moved), ["config.json"]);
    assert.equal(await readFile(join(moved, "config.json"), "utf8"), content);
    assert.equal((await stat(join(moved, "config.json"))).mode & 0o777, 0o600, "secured on the handle before link");
    assert.equal((await stat(moved)).mode & 0o777, 0o700);
    assert.equal(finalPathChmods, 0, "no pathname chmod of the final config path may exist on the create path");
  } finally {
    restoreChmod?.();
    restoreUmask();
  }
});

test("saveConfigEditUnderLock and saveConfigEdit fail closed on unsafe current bytes even with a structurally supplied exact snapshot", async () => {
  const cases = [
    { name: "corrupt-json", raw: "{broken-json" },
    { name: "non-object", raw: "[1,2,3]\n" },
    { name: "legacy-v0", raw: JSON.stringify({ mainModel: "legacy/model" }) },
    { name: "legacy-v1-no-provider", raw: `${JSON.stringify({ schemaVersion: 1, mainModel: "vendor/main" }, null, 2)}\n` },
    { name: "future-schema", raw: JSON.stringify({ schemaVersion: 2, mainModel: "future/model" }) },
    { name: "future-provider", raw: JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 99, opaque: "keep-exactly" } }) },
    { name: "corrupt-provider", raw: JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 2, connections: "wrong" } }) },
  ] as const;
  for (const entry of cases) {
    for (const mode of ["under-lock", "wrapper"] as const) {
      const label = `${entry.name}/${mode}`;
      const path = await configPath(`edit-unsafe-${entry.name}-${mode}`);
      await writeFile(path, entry.raw, { encoding: "utf8", mode: 0o600 });
      const file = await readConfigFileSnapshot(path);
      assert.equal(file.kind, "file", label);
      const expected = { config: validateConfig({ ...DEFAULT_CONFIG } as ConfigInput), file };
      const candidate = { ...expected.config, mainModel: "vendor/overwrite-attempt" };
      const error = mode === "under-lock"
        ? await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(ownership, expected, candidate))
          .catch((reason: unknown) => reason)
        : await saveConfigEdit(expected, candidate, path).catch((reason: unknown) => reason);
      assert.ok(error instanceof ConfigEditUnavailableError, `${label}: ${String(error)}`);
      assert.equal(error.code, "config-edit-unavailable", label);
      assert.equal(error.name, "ConfigEditUnavailableError", label);
      assert.equal(error.message, "Config cannot be edited in its current stored state.", label);
      assert.doesNotMatch(String(error), /keep-exactly|legacy|future|overwrite|broken|\.json/, label);
      assert.equal(await readFile(path, "utf8"), entry.raw, label);
      assert.deepEqual(await readdir(dirname(path)), ["config.json"], label);
    }
  }

  // Tolerant `saveConfig()` semantics are unchanged: corrupt bytes are backed up, not refused.
  const tolerantPath = await configPath("edit-unsafe-tolerant-save");
  await writeFile(tolerantPath, "{broken-json", { encoding: "utf8", mode: 0o600 });
  await saveConfig({ ...DEFAULT_CONFIG, mainModel: "vendor/tolerant" }, tolerantPath);
  assert.deepEqual((await readdir(dirname(tolerantPath))).sort(), ["config.json", "config.json.beschaedigt"]);
  assert.equal(await readFile(`${tolerantPath}.beschaedigt`, "utf8"), "{broken-json");
});

test("create-only temp cleanup after a parent replacement never unlinks a foreign entry at the temp pathname", async () => {
  const root = dirname(await configPath("edit-foreign-temp"));
  const parent = join(root, "nested");
  const moved = join(root, "nested.moved");
  const path = join(parent, "config.json");
  const expected = await readConfigEditSnapshot(path);
  assert.equal(expected.file.kind, "absent");
  assert.equal(expected.file.parent.kind, "absent");
  const candidate = { ...expected.config, mainModel: "vendor/created" };
  const content = `${JSON.stringify(validateConfig(candidate), null, 2)}\n`;

  let temporaryName: string | null = null;
  const error = await withConfigWriteLock(path, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if (temporaryName !== null || !(await pathExists(parent))) return;
        const pending = await pendingTemporaryFiles(path);
        if (pending.length === 0) return;
        // Third post-create fence: the temp exists. Swap the parent and plant a foreign file under the
        // observed temp basename; the exact fence must reject and cleanup must not touch that file.
        temporaryName = pending[0]!;
        await rename(parent, moved);
        await mkdir(parent);
        await chmod(parent, 0o755);
        await writeFile(join(parent, temporaryName), "foreign-temp-sentinel", { encoding: "utf8", mode: 0o644 });
        await chmod(join(parent, temporaryName), 0o644);
      },
    },
    expected,
    candidate,
  ).catch((reason: unknown) => reason));
  assert.notEqual(temporaryName, null);
  const name = temporaryName as unknown as string;
  assert.ok(error instanceof ConfigEditConflictError, String(error));
  assert.deepEqual(await readdir(parent), [name]);
  assert.equal(await readFile(join(parent, name), "utf8"), "foreign-temp-sentinel");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(parent, name))).mode & 0o777, 0o644);
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
  }
  assert.equal(await pathExists(path), false);
  // Bounded outcome: Node has no unlinkat, so the writer cannot reach its own temp through the moved
  // parent by pathname; it stays there unpublished with the candidate bytes and secure mode.
  assert.deepEqual(await readdir(moved), [name]);
  assert.equal(await readFile(join(moved, name), "utf8"), content);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(moved, name))).mode & 0o777, 0o600);
  }

  // An ordinary fence rejection with the parent intact still leaves no temp behind.
  const plainRoot = dirname(await configPath("edit-foreign-temp-plain"));
  const plainPath = join(plainRoot, "nested", "config.json");
  const plainExpected = await readConfigEditSnapshot(plainPath);
  const plainReason = new Error("fixed fence rejection with temp present");
  const plainError = await withConfigWriteLock(plainPath, (ownership) => saveConfigEditUnderLock(
    {
      canonicalPath: ownership.canonicalPath,
      assertHeld: async () => {
        await ownership.assertHeld();
        if ((await pathExists(dirname(plainPath))) && (await pendingTemporaryFiles(plainPath)).length > 0) {
          throw plainReason;
        }
      },
    },
    plainExpected,
    { ...plainExpected.config, mainModel: "vendor/plain" },
  ).catch((reason: unknown) => reason));
  assert.equal(plainError, plainReason);
  assert.deepEqual(await readdir(dirname(plainPath)), []);
});

test("the create-only writer never reports success when the parent is exchanged between the pre-link lstat and the link", async () => {
  const fsModule = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const root = dirname(await configPath("atomic-create-lstat-link-gap"));
  const parent = join(root, "nested");
  const moved = join(root, "nested.moved");
  const path = join(parent, "config.json");
  await mkdir(parent, { mode: 0o700 });
  const originalLstat = fsModule.promises.lstat;
  let swapped = false;
  let temporaryName: string | null = null;
  (fsModule.promises as { lstat: typeof originalLstat }).lstat = (async (target: unknown, options: unknown) => {
    const result = await (originalLstat as (t: unknown, o: unknown) => Promise<unknown>)(target, options);
    const spelled = String(target);
    const name = basename(spelled);
    if (!swapped && dirname(spelled) === parent && name.startsWith("config.json.") && name.endsWith(".tmp")) {
      // Exactly the pre-link identity lstat on the temp pathname: exchange the parent before `link` runs.
      swapped = true;
      temporaryName = name;
      renameSync(parent, moved);
      mkdirSync(parent);
      chmodSync(parent, 0o755);
      writeFileSync(join(parent, name), "FOREIGN", { encoding: "utf8", mode: 0o644 });
      chmodSync(join(parent, name), 0o644);
    }
    return result;
  }) as unknown as typeof originalLstat;
  syncBuiltinESMExports();
  let outcome: unknown;
  try {
    outcome = await writeFileAtomicCreateSecure(path, "candidate\n").then(
      () => "resolved" as const,
      (reason: unknown) => reason,
    );
  } finally {
    (fsModule.promises as { lstat: typeof originalLstat }).lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(swapped, true);
  const name = temporaryName as unknown as string;
  assert.notEqual(outcome, "resolved", "the helper must never resolve after publishing foreign bytes");
  assert.ok(isAtomicFilePostPublicationError(outcome), String(outcome));
  assert.equal(outcome.operation, "create");
  // Bounded adversarial outcome: the foreign bytes were linked and stay untouched; nothing is unlinked.
  assert.equal(await readFile(path, "utf8"), "FOREIGN");
  assert.equal(await readFile(join(parent, name), "utf8"), "FOREIGN");
  assert.deepEqual((await readdir(parent)).sort(), ["config.json", name].sort());
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    assert.equal((await stat(join(parent, name))).mode & 0o777, 0o644);
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
  }
  assert.deepEqual(await readdir(moved), [name]);
  assert.equal(await readFile(join(moved, name), "utf8"), "candidate\n");
});
