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
  assert.deepEqual(DEFAULT_CONFIG.verify, { commands: [], mode: "on-edit", maxRounds: 1 });
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
});

test("validateVerify begrenzt maxRounds auf 2 und normalisiert den Modus", () => {
  assert.deepEqual(
    validateVerify({ commands: ["npm test", ""], mode: "on-edit", maxRounds: 2 }),
    { commands: ["npm test"], mode: "on-edit", maxRounds: 2 },
  );
  assert.deepEqual(validateVerify({ commands: ["x"], mode: "on-edit", maxRounds: 5 }), {
    commands: ["x"],
    mode: "on-edit",
    maxRounds: 1,
  });
  assert.deepEqual(validateVerify({ mode: "sofort" as never }), {
    commands: [],
    mode: "on-edit",
    maxRounds: 1,
  });
  assert.deepEqual(validateVerify("nichts"), { commands: [], mode: "on-edit", maxRounds: 1 });
});

test("validateConfig übernimmt fallbackModels/provider/web/verify/contextBudgetRatio", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    fallbackModels: ["anthropic/x"],
    provider: { sort: "throughput" },
    web: "on",
    verify: { commands: ["npm run check"], mode: "on-edit", maxRounds: 2 },
    contextBudgetRatio: 0.5,
  });
  assert.deepEqual(config.fallbackModels, ["anthropic/x"]);
  assert.deepEqual(config.provider, { sort: "throughput", dataCollection: "deny" });
  assert.equal(config.web, "on");
  assert.deepEqual(config.verify, { commands: ["npm run check"], mode: "on-edit", maxRounds: 2 });
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
      provider: { sort: "price", only: ["anthropic"] },
      web: "off",
      verify: { commands: ["npm test"], mode: "on-edit", maxRounds: 2 },
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
  });
  assert.equal(written.config.web, "off");
  assert.deepEqual(written.config.verify, {
    commands: ["npm test"],
    mode: "on-edit",
    maxRounds: 2,
  });
  assert.equal(written.config.contextBudgetRatio, 0.6);
});
