import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPROVAL_MODES,
  COMPRESSION_MODES,
  REASONING_EFFORTS,
  type ApprovalMode,
  type CompressionMode,
  type ReasoningSetting,
  type OrcodeConfig,
} from "./types.js";
import { PANEL_MAX_MODELS, PANEL_MIN_MODELS } from "./panel.js";
import { errorMessage, formatUsd, hasCode, isRecord } from "./utils.js";

export const APP_HOME = join(homedir(), ".orcode");
/** Pre-rename state directory (the tool was called RouterCode before). `migrateAppHome` moves it once, on first startup. */
export const LEGACY_APP_HOME = join(homedir(), ".routercode");
export const CONFIG_PATH = join(APP_HOME, "config.json");

export const SECURE_DIRECTORY_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export const BUDGET_ACTIONS = ["warn", "block"] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/** `null` means "no limit". Amounts are US dollars. */
export interface BudgetConfig {
  dailyLimitUsd: number | null;
  totalLimitUsd: number | null;
  onExceed: BudgetAction;
}

export const WEB_MODES = ["on", "off", "auto"] as const;
export type WebMode = (typeof WEB_MODES)[number];

export const PROVIDER_SORTS = ["price", "throughput", "latency"] as const;
export type ProviderSortPreference = (typeof PROVIDER_SORTS)[number];

export const DATA_COLLECTIONS = ["allow", "deny"] as const;
export type DataCollectionPreference = (typeof DATA_COLLECTIONS)[number];

/** Passed through as the OpenRouter `provider` request field. */
export interface ProviderConfig {
  sort?: ProviderSortPreference;
  dataCollection?: DataCollectionPreference;
  only?: string[];
  ignore?: string[];
}

export const VERIFY_MODES = ["off", "on-edit"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export const VERIFY_MAX_ROUNDS = 2;

export interface VerifyConfig {
  commands: string[];
  mode: VerifyMode;
  maxRounds: number;
}

/**
 * The budget lives outside `OrcodeConfig` (types.ts) so the shared type
 * stays untouched; every consumer of `OrcodeConfig` keeps working and only
 * the budget-aware callers need the wider type. Every field added since
 * follows the same pattern: additive, validated here, never touching
 * `types.ts`.
 */
export interface OrcodeConfigWithBudget extends OrcodeConfig {
  budget: BudgetConfig;
  fallbackModels: string[];
  provider: ProviderConfig;
  web: WebMode;
  verify: VerifyConfig;
  contextBudgetRatio: number;
  /** `/panel`'s persisted model selection (2 to 5 ids), or `[]` when unset — see `panel.ts`. */
  panelModels: string[];
  /** `/panel judge`: run an extra judge round after every panel call. Off by default — not free, and not automatically an improvement. */
  panelJudge: boolean;
  /**
   * Explicit path to a Chrome/Edge/Chromium/Brave executable for
   * `browser_check`/`/browser`. Empty string (the default) means "search the
   * usual per-platform locations" — see `findBrowserExecutable` in
   * browser.ts.
   */
  browserPath: string;
  /** Hard timeout for one `browser_check`/`/browser` inspection. Default 30s, capped at 120s — a headless page load that hangs must not hang the agent run. */
  browserTimeoutSeconds: number;
}

/** Anything that may be handed to `validateConfig`/`saveConfig`. */
export type ConfigInput = OrcodeConfig & {
  budget?: unknown;
  fallbackModels?: unknown;
  provider?: unknown;
  web?: unknown;
  verify?: unknown;
  contextBudgetRatio?: unknown;
  panelModels?: unknown;
  panelJudge?: unknown;
  browserPath?: unknown;
  browserTimeoutSeconds?: unknown;
};

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyLimitUsd: null,
  totalLimitUsd: null,
  onExceed: "warn",
};

export const DEFAULT_PROVIDER: ProviderConfig = {
  dataCollection: "deny",
};

/** Spec default is `"on-edit"` — harmless with an empty `commands` list until the first-run suggestion (A4) fills it in. */
export const DEFAULT_VERIFY: VerifyConfig = {
  commands: [],
  mode: "on-edit",
  maxRounds: 1,
};

export const DEFAULT_CONFIG: OrcodeConfigWithBudget = {
  mainModel: "openrouter/auto",
  compressorModel: "qwen/qwen3.5-flash-02-23",
  compressionMode: "auto",
  compressionThresholdChars: 18_000,
  approvalMode: "ask",
  maxSteps: 12,
  maxCostUsd: 1,
  compressorMaxCostUsd: 0.05,
  reasoningByModel: {},
  // Chosen by querying OpenRouter's live catalogue for audio-input-capable
  // models (`inputModalities.includes("audio")`) and picking the cheapest
  // one built specifically for speech: Mistral's Voxtral. Any model with
  // audio input works; validated against the catalogue at call time (K1).
  transcriptionModel: "mistralai/voxtral-small-24b-2507",
  voiceConsentGiven: false,
  budget: { ...DEFAULT_BUDGET },
  fallbackModels: [],
  provider: { ...DEFAULT_PROVIDER },
  web: "auto",
  verify: { ...DEFAULT_VERIFY },
  contextBudgetRatio: 0.7,
  panelModels: [],
  panelJudge: false,
  browserPath: "",
  browserTimeoutSeconds: 30,
};

export interface ConfigLoadOutcome {
  config: OrcodeConfigWithBudget;
  /** German, user facing. `null` when everything was fine. */
  warning: string | null;
  source: "file" | "defaults";
}

let pendingWarning: string | null = null;

/**
 * Never throws: a broken, unreadable or half-written config must not keep
 * orcode from starting. The reason is reported through `warning`.
 */
export async function loadConfigDetailed(
  path = CONFIG_PATH,
): Promise<ConfigLoadOutcome> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { config: defaults(), warning: null, source: "defaults" };
    }
    return {
      config: defaults(),
      warning: `Konfiguration ${path} konnte nicht gelesen werden (${errorMessage(error)}). orcode startet mit den Standardwerten.`,
      source: "defaults",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: defaults(),
      warning: `Konfiguration ${path} ist beschädigt (${errorMessage(error)}). orcode startet mit den Standardwerten; die defekte Datei wird beim nächsten Speichern als ${path}.beschaedigt gesichert.`,
      source: "defaults",
    };
  }

  if (!isRecord(parsed)) {
    return {
      config: defaults(),
      warning: `Konfiguration ${path} enthält kein Objekt. orcode startet mit den Standardwerten; die defekte Datei wird beim nächsten Speichern als ${path}.beschaedigt gesichert.`,
      source: "defaults",
    };
  }

  try {
    return {
      config: validateConfig({
        ...DEFAULT_CONFIG,
        ...(parsed as Partial<OrcodeConfigWithBudget>),
      }),
      warning: null,
      source: "file",
    };
  } catch (error) {
    return {
      config: defaults(),
      warning: `Konfiguration ${path} konnte nicht ausgewertet werden (${errorMessage(error)}). orcode startet mit den Standardwerten.`,
      source: "defaults",
    };
  }
}

export async function loadConfig(
  path = CONFIG_PATH,
): Promise<OrcodeConfigWithBudget> {
  const outcome = await loadConfigDetailed(path);
  if (outcome.warning) {
    pendingWarning = outcome.warning;
  }
  return outcome.config;
}

/** Returns and clears the warning of the last `loadConfig` call. */
export function consumeConfigWarning(): string | null {
  const warning = pendingWarning;
  pendingWarning = null;
  return warning;
}

export async function saveConfig(
  config: ConfigInput,
  path = CONFIG_PATH,
): Promise<void> {
  const validated = validateConfig(config);
  await preserveBrokenConfig(path);
  await writeFileAtomicSecure(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * `mkdir({ mode })` only applies to directories it actually creates, so an
 * existing `~/.orcode` keeps whatever mode it had (N5).
 */
export async function ensureSecureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  if (securedDirectories.has(path)) {
    return;
  }
  securedDirectories.add(path);
  try {
    await chmod(path, SECURE_DIRECTORY_MODE);
  } catch (error) {
    if (!hasCode(error, "EPERM") && !hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

const securedDirectories = new Set<string>();

/**
 * Atomic write with an unpredictable temp name and `wx`, so a hostile or stale
 * temp file can never be reused and a crash cannot leave a half written target
 * (N2).
 */
export async function writeFileAtomicSecure(
  path: string,
  content: string,
): Promise<void> {
  await ensureSecureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: SECURE_FILE_MODE,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  try {
    await chmod(path, SECURE_FILE_MODE);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export interface AppHomeMigrationResult {
  /** The app home the caller should use for the rest of this process. */
  appHome: string;
  /** German, user facing. `null` when nothing needed reporting. */
  warning: string | null;
}

/**
 * Moves `~/.routercode` to `~/.orcode` once, the first time this build of the
 * renamed tool runs. Idempotent and safe to call on every startup:
 *
 * - `newHome` already exists (migration already ran, or the user started
 *   fresh under the new name) → does nothing, returns `newHome`.
 * - Neither directory exists (genuinely first run) → does nothing, returns
 *   `newHome`; it is created lazily by `ensureSecureDirectory` on first write.
 * - Only `legacyHome` exists → `rename()`s it in one atomic step (a real move,
 *   not a copy-and-leave-behind) so chats, config and rules all move together
 *   and nothing can end up duplicated between the two directories.
 * - The move fails (permissions, cross-device, …) → `legacyHome` is left
 *   completely untouched, the caller keeps working against it, and a German
 *   warning explains what happened. The next startup simply tries again,
 *   since `newHome` still won't exist.
 *
 * Callers must always pass explicit paths in tests — the defaults resolve to
 * the real home directory.
 */
export async function migrateAppHome(
  newHome: string = APP_HOME,
  legacyHome: string = LEGACY_APP_HOME,
): Promise<AppHomeMigrationResult> {
  if (await pathExists(newHome)) {
    return { appHome: newHome, warning: null };
  }
  if (!(await pathExists(legacyHome))) {
    return { appHome: newHome, warning: null };
  }
  try {
    await rename(legacyHome, newHome);
    return { appHome: newHome, warning: null };
  } catch (error) {
    return {
      appHome: legacyHome,
      warning: `${legacyHome} konnte nicht nach ${newHome} verschoben werden (${errorMessage(error)}). orcode arbeitet für diese Sitzung weiter mit ${legacyHome}.`,
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(value: ConfigInput): OrcodeConfigWithBudget {
  const approvalMode = includes(APPROVAL_MODES, value.approvalMode)
    ? value.approvalMode
    : DEFAULT_CONFIG.approvalMode;
  const compressionMode = includes(COMPRESSION_MODES, value.compressionMode)
    ? value.compressionMode
    : DEFAULT_CONFIG.compressionMode;

  return {
    mainModel: nonEmpty(value.mainModel, DEFAULT_CONFIG.mainModel),
    compressorModel: nonEmpty(value.compressorModel, DEFAULT_CONFIG.compressorModel),
    compressionMode,
    compressionThresholdChars: boundedInteger(value.compressionThresholdChars, 2_000, 2_000_000, DEFAULT_CONFIG.compressionThresholdChars),
    approvalMode,
    maxSteps: boundedInteger(value.maxSteps, 1, 100, DEFAULT_CONFIG.maxSteps),
    maxCostUsd: boundedNumber(value.maxCostUsd, 0.001, 1_000, DEFAULT_CONFIG.maxCostUsd),
    compressorMaxCostUsd: boundedNumber(
      value.compressorMaxCostUsd,
      0.001,
      100,
      DEFAULT_CONFIG.compressorMaxCostUsd,
    ),
    reasoningByModel: validateReasoningByModel(value.reasoningByModel),
    transcriptionModel: nonEmpty(value.transcriptionModel, DEFAULT_CONFIG.transcriptionModel),
    voiceConsentGiven: value.voiceConsentGiven === true,
    budget: validateBudget(value.budget),
    fallbackModels: validateFallbackModels(value.fallbackModels),
    provider: validateProvider(value.provider),
    web: includes(WEB_MODES, value.web) ? value.web : DEFAULT_CONFIG.web,
    verify: validateVerify(value.verify),
    contextBudgetRatio: boundedNumber(
      value.contextBudgetRatio,
      0.1,
      1,
      DEFAULT_CONFIG.contextBudgetRatio,
    ),
    panelModels: validatePanelModels(value.panelModels),
    panelJudge: value.panelJudge === true,
    browserPath: validateBrowserPath(value.browserPath),
    browserTimeoutSeconds: boundedInteger(
      value.browserTimeoutSeconds,
      1,
      120,
      DEFAULT_CONFIG.browserTimeoutSeconds,
    ),
  };
}

/**
 * Unlike `nonEmpty` (used for `mainModel` etc.), an empty string is the valid,
 * meaningful default here — "search the usual per-platform locations" — not a
 * value to fall back away from.
 */
export function validateBrowserPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : DEFAULT_CONFIG.browserPath;
}

export function validateFallbackModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value.slice(0, 20)) {
    if (typeof item === "string" && item.trim()) {
      result.push(item.trim());
    }
  }
  return result;
}

/**
 * Silent/lossy validator for the persisted `panelModels` field — used while
 * *loading* a config, where throwing would break startup on a stale or
 * hand-edited file (`loadConfigDetailed` must never throw). Keeps at most
 * `PANEL_MAX_MODELS` non-empty, de-duplicated ids; anything else (too many,
 * wrong type, duplicates) is silently trimmed rather than rejected — a config
 * with 7 stale entries should still let orcode start, just with a shorter
 * list. Interactive validation with clear rejection messages for `/panel
 * models …` is `validatePanelModelSelection` below.
 */
export function validatePanelModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= PANEL_MAX_MODELS) {
      break;
    }
  }
  return result;
}

/**
 * Throwing, user-facing validator for `/panel models <a>,<b>,…`. Unlike
 * `validatePanelModels` above, this must give the user a clear reason when a
 * selection is rejected instead of quietly reinterpreting it: too few models,
 * too many, or an id OpenRouter does not know.
 *
 * `knownModelIds` is the caller's current OpenRouter catalogue (ids and
 * canonical slugs) passed in as plain strings rather than this function
 * reaching for `OpenRouterService` itself — that keeps this a pure,
 * synchronous function the config layer can unit-test without a network.
 */
export function validatePanelModelSelection(
  candidates: readonly string[],
  knownModelIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  if (deduped.length < PANEL_MIN_MODELS) {
    throw new Error(
      `Panel braucht mindestens ${PANEL_MIN_MODELS} unterschiedliche Modelle, erhalten: ${deduped.length}.`,
    );
  }
  if (deduped.length > PANEL_MAX_MODELS) {
    throw new Error(
      `Panel erlaubt höchstens ${PANEL_MAX_MODELS} Modelle, erhalten: ${deduped.length}.`,
    );
  }
  const known = new Set(knownModelIds.map((id) => id.toLowerCase()));
  const unknown = deduped.filter((model) => !known.has(model.toLowerCase()));
  if (unknown.length > 0) {
    throw new Error(
      `Unbekannte Modell-ID(s): ${unknown.join(", ")}. Prüfe die Schreibweise mit /models <suche>.`,
    );
  }
  return deduped;
}

export function validateProvider(value: unknown): ProviderConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_PROVIDER };
  }
  const result: ProviderConfig = {};
  if (includes(PROVIDER_SORTS, value.sort)) {
    result.sort = value.sort;
  }
  if (includes(DATA_COLLECTIONS, value.dataCollection)) {
    result.dataCollection = value.dataCollection;
  } else {
    result.dataCollection = DEFAULT_PROVIDER.dataCollection;
  }
  const only = stringListOf(value.only);
  if (only) {
    result.only = only;
  }
  const ignore = stringListOf(value.ignore);
  if (ignore) {
    result.ignore = ignore;
  }
  return result;
}

export function validateVerify(value: unknown): VerifyConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_VERIFY };
  }
  const commands = Array.isArray(value.commands)
    ? value.commands.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ).slice(0, 20)
    : [];
  const mode = includes(VERIFY_MODES, value.mode) ? value.mode : DEFAULT_VERIFY.mode;
  const maxRounds = boundedInteger(value.maxRounds, 1, VERIFY_MAX_ROUNDS, DEFAULT_VERIFY.maxRounds);
  return { commands, mode, maxRounds };
}

function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return result.length > 0 ? result : undefined;
}

export function validateBudget(value: unknown): BudgetConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_BUDGET };
  }
  return {
    dailyLimitUsd: optionalLimit(value.dailyLimitUsd),
    totalLimitUsd: optionalLimit(value.totalLimitUsd),
    onExceed: includes(BUDGET_ACTIONS, value.onExceed)
      ? value.onExceed
      : DEFAULT_BUDGET.onExceed,
  };
}

export interface BudgetVerdict {
  exceeded: boolean;
  scope: "daily" | "total" | null;
  action: BudgetAction;
  /** German, user facing. `null` when nothing was exceeded. */
  message: string | null;
}

/**
 * Pure verdict; enforcing it (blocking a run, warning the user) happens in the
 * agent/CLI layer.
 */
export function evaluateBudget(
  budget: BudgetConfig,
  spend: { dayUsd: number; totalUsd: number },
): BudgetVerdict {
  const ok: BudgetVerdict = {
    exceeded: false,
    scope: null,
    action: budget.onExceed,
    message: null,
  };
  if (budget.dailyLimitUsd !== null && spend.dayUsd >= budget.dailyLimitUsd) {
    return {
      exceeded: true,
      scope: "daily",
      action: budget.onExceed,
      message: `Tagesbudget erreicht: heute ${formatUsd(spend.dayUsd)} von ${formatUsd(budget.dailyLimitUsd)} in diesem Workspace verbraucht.`,
    };
  }
  if (budget.totalLimitUsd !== null && spend.totalUsd >= budget.totalLimitUsd) {
    return {
      exceeded: true,
      scope: "total",
      action: budget.onExceed,
      message: `Gesamtbudget erreicht: ${formatUsd(spend.totalUsd)} von ${formatUsd(budget.totalLimitUsd)} in diesem Workspace verbraucht.`,
    };
  }
  return ok;
}

export function isApprovalMode(value: string): value is ApprovalMode {
  return includes(APPROVAL_MODES, value);
}

export function isCompressionMode(value: string): value is CompressionMode {
  return includes(COMPRESSION_MODES, value);
}

export function isBudgetAction(value: string): value is BudgetAction {
  return includes(BUDGET_ACTIONS, value);
}

function defaults(): OrcodeConfigWithBudget {
  return {
    ...DEFAULT_CONFIG,
    reasoningByModel: {},
    budget: { ...DEFAULT_BUDGET },
    fallbackModels: [],
    provider: { ...DEFAULT_PROVIDER },
    verify: { ...DEFAULT_VERIFY },
    panelModels: [],
  };
}

/**
 * A config we could not parse is user data. Keep a copy instead of letting the
 * next write destroy it silently.
 */
async function preserveBrokenConfig(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return;
    }
  } catch {
    // fall through: unparsable
  }
  await rename(path, `${path}.beschaedigt`).catch(() => {});
}

function optionalLimit(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0.01 &&
    value <= 100_000
    ? value
    : null;
}

function includes<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === "string" && values.includes(candidate as T);
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function validateReasoningByModel(
  value: unknown,
): Record<string, ReasoningSetting> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, ReasoningSetting> = {};
  for (const [modelId, candidate] of Object.entries(value).slice(0, 500)) {
    if (!modelId.trim() || !isRecord(candidate)) {
      continue;
    }
    if (candidate.mode === "auto") {
      result[modelId] = { mode: "auto" };
    } else if (
      candidate.mode === "effort" &&
      includes(REASONING_EFFORTS, candidate.effort)
    ) {
      result[modelId] = {
        mode: "effort",
        effort: candidate.effort,
      };
    } else if (
      candidate.mode === "budget" &&
      Number.isInteger(candidate.maxTokens) &&
      Number(candidate.maxTokens) >= 1 &&
      Number(candidate.maxTokens) <= 1_000_000
    ) {
      result[modelId] = {
        mode: "budget",
        maxTokens: Number(candidate.maxTokens),
      };
    }
  }
  return result;
}
