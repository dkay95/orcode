import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  APPROVAL_MODES,
  COMPRESSION_MODES,
  REASONING_EFFORTS,
  type ApprovalMode,
  type CompressionMode,
  type ProviderFallbackPolicy,
  type ReasoningSetting,
  type OrcodeConfig,
} from "./types.js";
import type { RouteIdentityV1 } from "./backends.js";
import { PANEL_MAX_MODELS, PANEL_MIN_MODELS } from "./panel.js";
import { errorMessage, formatUsd, hasCode, isRecord } from "./utils.js";
import {
  migrateStorageHome,
  STORAGE_SCHEMA_VERSION,
  type AppHomeMigrationOptions,
  type AppHomeMigrationResult,
} from "./storage.js";
import {
  createNeverConfiguredProviderState,
  isProviderStateIssue,
  migrateLegacyOpenRouterState,
  requirePersistableProviderState,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderSetupState,
} from "./provider-state.js";
import {
  withConfigWriteLock,
  type ConfigWriteOwnership,
} from "./config-write-lock.js";
import {
  assertConfigFileSnapshot,
  assertConfigParentIdentity,
  configBytesDigest,
  readConfigFileSnapshot,
  sameConfigFileSnapshot,
  sameConfigParentIdentity,
  secureCreatedConfigParent,
  type ConfigFileSnapshot,
  type ConfigParentIdentity,
} from "./config-file.js";

export {
  withConfigWriteLock,
  withConfigWriteLocks,
  type ConfigWriteOwnership,
} from "./config-write-lock.js";
export {
  assertConfigFileSnapshot,
  readConfigFileSnapshot,
  sameConfigFileSnapshot,
  type ConfigFileSnapshot,
} from "./config-file.js";

export const APP_HOME = join(homedir(), ".orcode");
/** Pre-rename state directory (the tool was called RouterCode before). `migrateAppHome` moves it once, on first startup. */
export const LEGACY_APP_HOME = join(homedir(), ".routercode");
export const CONFIG_PATH = join(APP_HOME, "config.json");
export const CONFIG_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION;

export function configPath(appHome: string = APP_HOME): string {
  return join(appHome, "config.json");
}

export const SECURE_DIRECTORY_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export interface AtomicFilePostPublicationError extends Error {
  readonly operation: "create" | "replace";
  readonly publicationError: unknown;
}

class AtomicFilePostPublicationFailure extends Error implements AtomicFilePostPublicationError {
  constructor(
    readonly operation: "create" | "replace",
    readonly publicationError: unknown,
  ) {
    super("Atomic file publication completed before cleanup failed.");
    this.name = "AtomicFilePostPublicationError";
  }
}

const atomicFilePostPublicationErrors = new WeakSet<object>();

/** A non-forgeable phase proof; exact readback is still required before adoption. */
export function isAtomicFilePostPublicationError(
  error: unknown,
): error is AtomicFilePostPublicationError {
  return typeof error === "object"
    && error !== null
    && atomicFilePostPublicationErrors.has(error);
}

function atomicFilePostPublicationError(
  operation: "create" | "replace",
  publicationError: unknown,
): AtomicFilePostPublicationError {
  const error = new AtomicFilePostPublicationFailure(operation, publicationError);
  atomicFilePostPublicationErrors.add(error);
  return Object.freeze(error);
}

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
  /** OpenRouter's provider-level backup-provider policy. */
  allowFallbacks?: ProviderFallbackPolicy;
}

export const VERIFY_MODES = ["off", "on-edit"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export const VERIFY_MAX_ROUNDS = 2;

export interface VerifyConfig {
  commands: string[];
  mode: VerifyMode;
  /** Additional model repair phases after the initial verification pass. */
  maxRepairRounds: number;
}

export const GLYPH_MODES = ["auto", "unicode", "ascii"] as const;
export type GlyphMode = (typeof GLYPH_MODES)[number];

/** Presentation only: never affects stored chats, routes, or provider identity. */
export interface AppearanceConfig {
  showLargeLogo: boolean;
  showHeaderMark: boolean;
  glyphMode: GlyphMode;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  showLargeLogo: true,
  showHeaderMark: true,
  glyphMode: "auto",
};

/**
 * The budget lives outside `OrcodeConfig` (types.ts) so the shared type
 * stays untouched; every consumer of `OrcodeConfig` keeps working and only
 * the budget-aware callers need the wider type. Every field added since
 * follows the same pattern: additive, validated here, never touching
 * `types.ts`.
 */
export interface OrcodeConfigWithBudget extends OrcodeConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
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
  /** Versioned, non-secret backend/account routing state. Independent of `provider`. */
  providerSetup: ProviderSetupState;
  /** Additive schema-v1 field; missing or malformed parts fall back per field. */
  appearance: AppearanceConfig;
  /**
   * Phase 14 (architect mode): the cheap executor route `/architect` runs the
   * accepted plan with, or `null` when never configured. Additive field,
   * deliberately NOT part of `providerSetup` — unlike Cross's lead/challenger
   * pair, this route has no cross-process CAS/migration needs of its own, so
   * it is validated and persisted exactly like every other plain config
   * field (`saveConfig`'s ordinary optimistic-concurrency snapshot), reusing
   * `validateRouteIdentityV1` (provider-state.ts) as a pure shape check only.
   * `null` (never a default model) is the intentional "not configured yet"
   * state `/architect` refuses on — see `ARCHITECT_EXECUTOR_UNSET_REFUSAL`.
   */
  architectExecutor: RouteIdentityV1 | null;
  /**
   * D6 (the cost thread): below this remaining-credit figure, the welcome
   * box's Balance row, the status line's shared balance/day segment, and
   * `/provider status`'s Billing line all switch to the warn state —
   * visibility only, this never blocks a run or changes budget/spend-cap
   * behavior. `0` disables the warn entirely, at any balance.
   */
  lowBalanceThresholdUsd: number;
}

/** Anything that may be handed to `validateConfig`/`saveConfig`. */
export type ConfigInput = OrcodeConfig & {
  schemaVersion?: unknown;
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
  providerSetup?: unknown;
  appearance?: unknown;
  lowBalanceThresholdUsd?: unknown;
  architectExecutor?: unknown;
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
  maxRepairRounds: 1,
};

export const DEFAULT_CONFIG: OrcodeConfigWithBudget = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
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
  providerSetup: createNeverConfiguredProviderState(),
  appearance: { ...DEFAULT_APPEARANCE },
  lowBalanceThresholdUsd: 2,
  architectExecutor: null,
};

export interface ConfigLoadOutcome {
  config: OrcodeConfigWithBudget;
  /** German, user facing. `null` when everything was fine. */
  warning: string | null;
  source: "file" | "defaults";
}

export interface ConfigLoadDependencies {
  randomUUID?: () => string;
}

let pendingWarning: string | null = null;

/**
 * Never throws: a broken, unreadable or half-written config must not keep
 * orcode from starting. The reason is reported through `warning`.
 */
export async function loadConfigDetailed(
  path = CONFIG_PATH,
  dependencies: ConfigLoadDependencies = {},
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
      warning: `Configuration ${path} could not be read (${errorMessage(error)}). orcode starts with the defaults.`,
      source: "defaults",
    };
  }

  const parsed = parseStoredConfig(raw, dependencies, { legacyProvider: "migrate" });
  switch (parsed.outcome) {
    case "config":
      return { config: parsed.config, warning: null, source: "file" };
    case "corrupt":
      return {
        config: defaults(),
        warning: `Configuration ${path} is corrupt (${parsed.detail}). orcode starts with the defaults; the broken file will be backed up as ${path}.corrupted on the next save.`,
        source: "defaults",
      };
    case "not-object":
      return {
        config: defaults(),
        warning: `Configuration ${path} does not contain an object. orcode starts with the defaults; the broken file will be backed up as ${path}.corrupted on the next save.`,
        source: "defaults",
      };
    case "future-version":
      return {
        config: defaults(),
        warning: `Configuration ${path} has the future schemaVersion ${parsed.version} and was not overwritten.`,
        source: "defaults",
      };
    case "invalid":
      return {
        config: defaults(),
        warning: `Configuration ${path} could not be evaluated (${parsed.detail}). orcode starts with the defaults.`,
        source: "defaults",
      };
  }
}

type StoredConfigParse =
  | { readonly outcome: "config"; readonly config: OrcodeConfigWithBudget }
  | { readonly outcome: "corrupt"; readonly detail: string }
  | { readonly outcome: "not-object" }
  | { readonly outcome: "future-version"; readonly version: number }
  | { readonly outcome: "invalid"; readonly detail: string };

interface StoredConfigParseOptions {
  /**
   * `"migrate"` allocates one fresh legacy connection identity in memory (the
   * startup contract); `"refuse"` treats bytes without `providerSetup` as
   * invalid so an edit can never allocate or persist an incidental identity.
   */
  readonly legacyProvider: "migrate" | "refuse";
}

/**
 * One pure parser for exact stored bytes, shared by the tolerant startup load
 * and the fail-closed edit snapshot so neither reads the file twice.
 */
function parseStoredConfig(
  raw: string,
  dependencies: ConfigLoadDependencies,
  options: StoredConfigParseOptions,
): StoredConfigParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { outcome: "corrupt", detail: errorMessage(error) };
  }
  if (!isRecord(parsed)) {
    return { outcome: "not-object" };
  }
  if (
    typeof parsed.schemaVersion === "number" &&
    parsed.schemaVersion > CONFIG_SCHEMA_VERSION
  ) {
    return { outcome: "future-version", version: parsed.schemaVersion };
  }
  if (!("providerSetup" in parsed) && options.legacyProvider === "refuse") {
    return { outcome: "invalid", detail: "legacy provider state requires startup migration" };
  }
  try {
    const providerSetup = "providerSetup" in parsed
      ? validateProviderSetupState(parsed.providerSetup)
      : migrateLegacyOpenRouterState(parsed, {
        connectionId: (dependencies.randomUUID ?? randomUUID)(),
      });
    return {
      outcome: "config",
      config: validateConfig({
        ...DEFAULT_CONFIG,
        ...(parsed as Partial<OrcodeConfigWithBudget>),
        providerSetup,
      }),
    };
  } catch (error) {
    return { outcome: "invalid", detail: errorMessage(error) };
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
  const requested = validateConfig(config);
  requirePersistableProviderState(requested.providerSetup);
  await withConfigWriteLock(path, async (ownership) => {
    const canonicalPath = ownership.canonicalPath;
    await ownership.assertHeld();
    await ensureSecureDirectory(dirname(canonicalPath));
    await ownership.assertHeld();
    const initialTarget = await readConfigFileSnapshot(canonicalPath);
    await ownership.assertHeld();
    refuseUnsafeStoredConfig(canonicalPath, initialTarget);
    const providerSetup = currentPersistableProviderSetup(initialTarget)
      ?? requested.providerSetup;
    const validated = { ...requested, providerSetup };
    await preserveBrokenConfig(canonicalPath, initialTarget);
    await ownership.assertHeld();
    const publishTarget = await readConfigFileSnapshot(canonicalPath);
    await ownership.assertHeld();
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    let writeError: unknown;
    try {
      await writeFileAtomicSecure(canonicalPath, content, async () => {
        await ownership.assertHeld();
        await assertConfigFileSnapshot(canonicalPath, publishTarget);
        await ownership.assertHeld();
      });
    } catch (error) {
      if (!isAtomicFilePostPublicationError(error)) throw error;
      writeError = error;
    }
    await ownership.assertHeld();
    let readback: string | null = null;
    try {
      const snapshot = await readConfigFileSnapshot(canonicalPath);
      readback = snapshot.kind === "file" ? snapshot.raw : null;
    } catch {
      // Classified below without exposing the underlying path or bytes.
    }
    await ownership.assertHeld();
    if (readback === content) {
      noteConfigDiskBaseline(canonicalPath, validated);
      return;
    }
    if (writeError !== undefined) throw writeError;
    throw new Error("Config publication could not be verified.");
  });
}

/** The exact stored state one editor was opened on; `file` is the raw-byte CAS token. */
export interface ConfigEditSnapshot {
  readonly config: OrcodeConfigWithBudget;
  readonly file: ConfigFileSnapshot;
}

/** The target no longer matches the edit snapshot; the caller must re-read and re-select. */
export class ConfigEditConflictError extends Error {
  readonly code = "config-edit-conflict" as const;

  constructor() {
    super("Config target changed since the edit snapshot was taken.");
    this.name = "ConfigEditConflictError";
  }
}

/** The stored config is corrupt, unreadable, future, or non-persistable and stays read-only. */
export class ConfigEditUnavailableError extends Error {
  readonly code = "config-edit-unavailable" as const;

  constructor() {
    super("Config cannot be edited in its current stored state.");
    this.name = "ConfigEditUnavailableError";
  }
}

/**
 * Publication was reached, so the candidate may be durable, but exact readback
 * could not confirm it. `expected` is no longer authoritative: re-read before
 * any further edit instead of retrying from the stale snapshot.
 */
export class ConfigEditUnverifiedError extends Error {
  readonly code = "config-edit-unverified" as const;

  constructor() {
    super("Config publication could not be verified after it was reached.");
    this.name = "ConfigEditUnverifiedError";
  }
}

/**
 * What THIS process last knows the stored config to be: the pristine baseline
 * a drift check compares the file against.
 *
 * Settings' read-only guard exists to catch a FOREIGN write — a second orcode
 * editing config.json while this one is running — and it used to answer that
 * question by comparing the file against the RUNTIME config. That copy is not
 * a baseline: it legitimately carries this session's own overrides, because a
 * resumed chat's model preference is restored into it in memory and
 * deliberately NOT written back to disk. Every install whose open chat uses a
 * model other than the stored `mainModel` therefore reported the process's own
 * legitimate override as foreign drift and locked Settings on a fresh launch.
 *
 * Keyed by `resolve(path)` — the exact spelling `resolveConfigLockTarget`
 * canonicalizes to — so a publication and a later read agree on one key. It is
 * seeded by the startup load and updated at the two points in this module
 * where this process publishes config bytes, so no caller has to remember to
 * keep it true, and a writer added later inherits it for free.
 */
const configDiskBaselines = new Map<string, OrcodeConfigWithBudget>();

/** Records what this process just proved the file to hold. */
export function noteConfigDiskBaseline(
  path: string,
  config: OrcodeConfigWithBudget,
): void {
  configDiskBaselines.set(resolve(path), deepFreeze(structuredClone(config)));
}

/** The last config this process published to (or loaded from) `path`, or null. */
export function readConfigDiskBaseline(
  path: string,
): OrcodeConfigWithBudget | null {
  return configDiskBaselines.get(resolve(path)) ?? null;
}

/**
 * Fail-closed editor load: parses exactly the bytes captured in `file`. Never
 * writes, backs up, migrates, or normalizes; unlike `loadConfigDetailed` an
 * unsafe stored state throws instead of yielding tolerant defaults. Stored
 * bytes without `providerSetup` are unavailable until the authoritative
 * startup migration has persisted stable provider identity, so identical bytes
 * always yield identical configs. The snapshot is deeply frozen.
 */
export async function readConfigEditSnapshot(
  path = CONFIG_PATH,
): Promise<ConfigEditSnapshot> {
  let file: ConfigFileSnapshot;
  try {
    file = await readConfigFileSnapshot(path);
  } catch {
    throw new ConfigEditUnavailableError();
  }
  if (file.kind === "absent") {
    return freezeEditSnapshot(defaults(), file);
  }
  const parsed = parseStoredConfig(file.raw, {}, { legacyProvider: "refuse" });
  if (parsed.outcome !== "config" || isProviderStateIssue(parsed.config.providerSetup)) {
    throw new ConfigEditUnavailableError();
  }
  return freezeEditSnapshot(parsed.config, file);
}

/**
 * Validates the complete candidate, acquires the config writer lock, then
 * CAS-publishes. The under-lock outcome is retained in a private closure (not
 * inferred from any message). If the lock's outer release fails after an
 * exactly confirmed commit, the target is read back exactly once more
 * (digest inside the bound parent): still exact → that frozen value is
 * returned; superseded or unreadable → `ConfigEditUnverifiedError`. After a
 * typed unverified outcome that same error is rethrown. Every earlier failure
 * (acquisition, pre-publication, conflict) surfaces verbatim.
 */
export async function saveConfigEdit(
  expected: ConfigEditSnapshot,
  candidate: ConfigInput,
  path = CONFIG_PATH,
): Promise<OrcodeConfigWithBudget> {
  const validated = validateConfig(candidate);
  requirePersistableProviderState(validated.providerSetup);
  const outcome: { current: ConfigEditOutcome | null } = { current: null };
  try {
    return await withConfigWriteLock(path, async (ownership) => {
      try {
        const confirmed = await saveConfigEditExact(ownership, expected, candidate);
        outcome.current = { kind: "confirmed", ...confirmed };
        return confirmed.value;
      } catch (error) {
        if (error instanceof ConfigEditUnverifiedError) {
          outcome.current = { kind: "unverified", error };
        }
        throw error;
      }
    });
  } catch (error) {
    const settled = outcome.current;
    if (settled?.kind === "confirmed") {
      if (await confirmExactPublication(settled.path, settled.digest, settled.parent)) {
        return settled.value;
      }
      throw new ConfigEditUnverifiedError();
    }
    if (settled?.kind === "unverified") throw settled.error;
    throw error;
  }
}

/** Exactly confirmed publication: the frozen value plus the proof needed to re-verify it. */
interface ConfirmedConfigEdit {
  readonly value: OrcodeConfigWithBudget;
  readonly path: string;
  readonly digest: string;
  readonly parent: ConfigParentIdentity;
}

/** Private, non-forgeable record of what the under-lock CAS actually reached. */
type ConfigEditOutcome =
  | ({ readonly kind: "confirmed" } & ConfirmedConfigEdit)
  | { readonly kind: "unverified"; readonly error: ConfigEditUnverifiedError };

/**
 * Exact compare-and-swap under an already held writer ownership. The current
 * target must equal `expected.file` in kind, parent identity, file identity
 * and exact bytes; an expected-absent target is published create-only so a
 * concurrent creator is never replaced, and an expected-absent parent is
 * created exclusively so a foreign directory is never adopted or touched.
 * Once publication is reached, only exact readback decides: a confirmed commit
 * is adopted, anything else is `ConfigEditUnverifiedError`. Never acquires a
 * nested lock and never mutates caller-owned objects; returns a deeply frozen
 * value.
 */
export async function saveConfigEditUnderLock(
  ownership: ConfigWriteOwnership,
  expected: ConfigEditSnapshot,
  candidate: ConfigInput,
): Promise<OrcodeConfigWithBudget> {
  return (await saveConfigEditExact(ownership, expected, candidate)).value;
}

async function saveConfigEditExact(
  ownership: ConfigWriteOwnership,
  expected: ConfigEditSnapshot,
  candidate: ConfigInput,
): Promise<ConfirmedConfigEdit> {
  const validated = validateConfig(candidate);
  requirePersistableProviderState(validated.providerSetup);
  const path = ownership.canonicalPath;
  await ownership.assertHeld();
  const current = await readExactEditTarget(path);
  await ownership.assertHeld();
  if (!sameConfigFileSnapshot(current, expected.file)) {
    throw new ConfigEditConflictError();
  }
  refuseUnsafeEditTarget(current);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  const digest = configBytesDigest(content);
  const publication = expected.file.kind === "absent"
    ? await prepareCreatePublication(ownership, path, expected.file)
    : { kind: "replace" as const, file: expected.file, parent: expected.file.parent };
  try {
    if (publication.kind === "create") {
      const { publishTarget, created } = publication;
      await writeFileAtomicCreateSecure(path, content, async () => {
        await ownership.assertHeld();
        await assertExactEditTarget(path, publishTarget);
        await ownership.assertHeld();
      }, undefined, undefined, {
        // Identity before any temp file; a directory this writer created is
        // already secured on its handle and is never chmod-ed by pathname.
        prepareDirectory: async () => {
          await assertExactEditTarget(path, publishTarget);
          if (created === null) await ensureSecureDirectory(dirname(path));
          await assertExactEditTarget(path, publishTarget);
        },
      });
    } else {
      await writeFileAtomicSecure(path, content, async () => {
        await ownership.assertHeld();
        await assertExactEditTarget(path, publication.file);
        await ownership.assertHeld();
      });
    }
  } catch (error) {
    // Ordinary rejection proves publication did not happen: `expected` stays authoritative.
    if (hasCode(error, "EEXIST")) throw new ConfigEditConflictError();
    if (!isAtomicFilePostPublicationError(error)) throw error;
  }
  // Publication was reached, so `expected` is no longer authoritative. Ownership
  // cannot un-publish durable bytes, so its outcome is not consulted here; only
  // exact readback distinguishes a confirmed commit from an unverifiable one.
  await ownership.assertHeld().catch(() => undefined);
  if (await confirmExactPublication(path, digest, publication.parent)) {
    const value = deepFreeze(validated);
    // Exactly confirmed bytes: this process now knows what the file holds, so
    // the next drift check must not read its own write as a foreign one. An
    // unverified outcome deliberately does NOT land here — nothing is known
    // about the file then, and the stale baseline keeps the guard fail-closed.
    noteConfigDiskBaseline(path, value);
    return { value, path, digest, parent: publication.parent };
  }
  throw new ConfigEditUnverifiedError();
}

interface CreatePublicationPlan {
  readonly kind: "create";
  /** Fresh absent snapshot inside the exact parent; the final fence before the create-only link. */
  readonly publishTarget: ConfigFileSnapshot & { readonly kind: "absent" };
  /** Identity of the parent this writer created, or `null` when the parent pre-existed. */
  readonly created: ConfigParentIdentity | null;
  readonly parent: ConfigParentIdentity;
}

/**
 * Pre-publication preparation of the create-only path: creates an absent
 * parent exclusively, then requires the publish snapshot to sit inside exactly
 * that created identity (or, for a pre-existing parent, to equal the edit
 * snapshot). Every rejection here is ordinary: nothing has been published.
 */
async function prepareCreatePublication(
  ownership: ConfigWriteOwnership,
  path: string,
  expected: ConfigFileSnapshot & { readonly kind: "absent" },
): Promise<CreatePublicationPlan> {
  const created = expected.parent.kind === "absent"
    ? await createExclusiveConfigParent(dirname(path))
    : null;
  await ownership.assertHeld();
  const publishTarget = await readExactEditTarget(path);
  if (
    publishTarget.kind !== "absent"
    || publishTarget.parent.kind !== "directory"
    || (created !== null && !sameConfigParentIdentity(publishTarget.parent, created))
    || (created === null && !sameConfigFileSnapshot(publishTarget, expected))
  ) {
    throw new ConfigEditConflictError();
  }
  await ownership.assertHeld();
  return { kind: "create", publishTarget, created, parent: created ?? publishTarget.parent };
}

/**
 * Edit-specific fail-closed classification of the exact current bytes, using
 * the same pure parser and `legacyProvider: "refuse"` contract as
 * `readConfigEditSnapshot`. Whatever a caller supplied as `expected`, the edit
 * CAS never overwrites corrupt, non-object, future, legacy-without-provider,
 * or non-persistable storage; tolerant `saveConfig()` semantics are untouched.
 */
function refuseUnsafeEditTarget(current: ConfigFileSnapshot): void {
  if (current.kind === "absent") return;
  const parsed = parseStoredConfig(current.raw, {}, { legacyProvider: "refuse" });
  if (parsed.outcome !== "config" || isProviderStateIssue(parsed.config.providerSetup)) {
    throw new ConfigEditUnavailableError();
  }
}

/** Exact readback proof inside the exact parent; never throws and never exposes the underlying path or bytes. */
async function confirmExactPublication(
  path: string,
  digest: string,
  parent: ConfigParentIdentity,
): Promise<boolean> {
  try {
    await assertConfigParentIdentity(dirname(path), parent);
    const snapshot = await readConfigFileSnapshot(path);
    return snapshot.kind === "file"
      && snapshot.digest === digest
      && sameConfigParentIdentity(snapshot.parent, parent);
  } catch {
    return false;
  }
}

/**
 * Exclusive, identity-bearing creation of a config parent that was absent in
 * the edit snapshot. An existing directory belongs to a concurrent creator: it
 * is a conflict and is never entered, chmod-ed, or published into. The
 * returned claim is the identity this writer created and secured on a handle;
 * every later pathname operation revalidates against it. Missing ancestors are
 * not identity-bearing and may be created non-exclusively.
 */
async function createExclusiveConfigParent(directory: string): Promise<ConfigParentIdentity> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(directory, { mode: SECURE_DIRECTORY_MODE });
      break;
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new ConfigEditConflictError();
      if (!hasCode(error, "ENOENT") || attempt > 0) throw error;
      await mkdir(dirname(directory), { recursive: true, mode: SECURE_DIRECTORY_MODE });
    }
  }
  return secureCreatedConfigParent(directory, SECURE_DIRECTORY_MODE);
}

function freezeEditSnapshot(
  config: OrcodeConfigWithBudget,
  file: ConfigFileSnapshot,
): ConfigEditSnapshot {
  return deepFreeze({ config, file });
}

/** Recursive freeze of validator-owned data; never applied to caller-owned objects. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

async function readExactEditTarget(path: string): Promise<ConfigFileSnapshot> {
  try {
    return await readConfigFileSnapshot(path);
  } catch {
    throw new ConfigEditConflictError();
  }
}

/** Final raw-byte fence immediately before publication. */
async function assertExactEditTarget(
  path: string,
  expected: ConfigFileSnapshot,
): Promise<void> {
  const current = await readExactEditTarget(path);
  if (!sameConfigFileSnapshot(current, expected)) {
    throw new ConfigEditConflictError();
  }
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
 * (N2). Ordinary rejection proves rename did not complete; only the
 * non-forgeable post-publication brand permits an exact-readback reconciliation.
 */
export async function writeFileAtomicSecure(
  path: string,
  content: string,
  beforePublish?: () => Promise<void>,
  beforeRename?: () => void,
  afterPublish?: () => void,
): Promise<void> {
  await ensureSecureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: SECURE_FILE_MODE,
      flag: "wx",
    });
    await beforePublish?.();
    const finalFenceResult: unknown = beforeRename?.();
    if (finalFenceResult !== undefined) {
      throw new Error("Atomic write beforeRename fence must be synchronous.");
    }
    await rename(temporary, path);
    published = true;
    const postPublishResult: unknown = afterPublish?.();
    if (postPublishResult !== undefined) {
      throw new Error("Atomic write afterPublish hook must be synchronous.");
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (published) {
      throw atomicFilePostPublicationError("replace", error);
    }
    throw error;
  }
  try {
    await chmod(path, SECURE_FILE_MODE);
  } catch (error) {
    throw atomicFilePostPublicationError("replace", error);
  }
}

export interface AtomicCreateOptions {
  /**
   * Replaces the default `ensureSecureDirectory(dirname(path))` step that runs
   * before the temp file is created; a caller that already holds the exact
   * parent identity revalidates it here instead of touching the pathname.
   */
  readonly prepareDirectory?: () => Promise<void>;
}

/**
 * Atomically publishes one newly created secure file without ever replacing an
 * existing target. The hard-link publish is the create-only CAS: if another
 * writer creates `path` after the last snapshot fence, `link` fails with
 * `EEXIST` and leaves those foreign bytes untouched. Ordinary rejection proves
 * link did not complete; only the non-forgeable post-publication brand permits
 * an exact-readback reconciliation.
 *
 * The temp file is created exclusively, written and secured to 0600 on its own
 * handle before the link, so the published link inherits the secure mode and
 * no pathname chmod ever follows publication. Its dev/inode identity is bound
 * at creation: the temp pathname is revalidated against it immediately before
 * the link, the published target is proven to carry that identity immediately
 * after the link (an exchange inside the lstat→link window is a branded
 * post-publication failure, never success), and cleanup unlinks the temp
 * pathname only while it still resolves to that identity — a foreign entry at
 * the temp pathname or at the target is never removed (Node has no
 * unlinkat/linkat, so the original temp may then remain, unpublished, wherever
 * its parent was moved).
 */
export async function writeFileAtomicCreateSecure(
  path: string,
  content: string,
  beforePublish?: () => Promise<void>,
  beforeLink?: () => void,
  afterPublish?: () => void,
  options: AtomicCreateOptions = {},
): Promise<void> {
  await (options.prepareDirectory ?? (() => ensureSecureDirectory(dirname(path))))();
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let identity: FileIdentity | null = null;
  let published = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      SECURE_FILE_MODE,
    );
    const created = await handle.stat({ bigint: true });
    identity = Object.freeze({ dev: created.dev, ino: created.ino });
    await handle.writeFile(content, "utf8");
    await handle.chmod(SECURE_FILE_MODE);
    await beforePublish?.();
    const finalFenceResult: unknown = beforeLink?.();
    if (finalFenceResult !== undefined) {
      throw new Error("Atomic create beforeLink fence must be synchronous.");
    }
    if (!(await pathHasFileIdentity(temporary, identity))) {
      throw new Error("Atomic create temp identity changed before publication.");
    }
    await link(temporary, path);
    published = true;
    // Node has no linkat: the temp pathname could have been exchanged between
    // the lstat above and the link. The published target must resolve to the
    // exact bound temp identity, or this is a branded post-publication failure;
    // foreign target bytes are never unlinked (documented bounded outcome).
    if (!(await pathHasFileIdentity(path, identity))) {
      throw new Error("Atomic create published target does not carry the bound temp identity.");
    }
    const postPublishResult: unknown = afterPublish?.();
    if (postPublishResult !== undefined) {
      throw new Error("Atomic create afterPublish hook must be synchronous.");
    }
    await unlinkBoundTemporary(temporary, identity);
  } catch (error) {
    if (identity !== null) {
      await unlinkBoundTemporary(temporary, identity).catch(() => {});
    }
    if (published) {
      throw atomicFilePostPublicationError("create", error);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** `true` only while `path` is a regular file (not a symlink) with exactly this identity. */
async function pathHasFileIdentity(path: string, identity: FileIdentity): Promise<boolean> {
  try {
    const current = await lstat(path, { bigint: true });
    return current.isFile() && !current.isSymbolicLink()
      && current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

/** Identity-bound cleanup: never unlinks a pathname that no longer resolves to the bound temp file. */
async function unlinkBoundTemporary(temporary: string, identity: FileIdentity): Promise<void> {
  if (!(await pathHasFileIdentity(temporary, identity))) return;
  await unlink(temporary);
}

export async function migrateAppHome(
  newHome: string = APP_HOME,
  legacyHome: string = LEGACY_APP_HOME,
  options: AppHomeMigrationOptions & ConfigLoadDependencies = {},
): Promise<AppHomeMigrationResult> {
  const { randomUUID: createConnectionId = randomUUID, ...storageOptions } = options;
  let legacyConnectionId: string | null = null;
  return migrateStorageHome(newHome, legacyHome, {
    ...storageOptions,
    normalizeConfig: (value, { originalSchemaVersion }) => {
      const hasProviderSetup = "providerSetup" in value;
      const providerSetup = hasProviderSetup
        ? validateProviderSetupState(value.providerSetup)
        : migrateLegacyOpenRouterState(value, {
          connectionId: legacyConnectionId ??= createConnectionId(),
        });
      requirePersistableProviderState(providerSetup);
      if (
        originalSchemaVersion === CONFIG_SCHEMA_VERSION
        && hasProviderSetup
      ) {
        return { ...value, providerSetup };
      }
      return validateConfig({
        ...DEFAULT_CONFIG,
        ...value,
        providerSetup,
      } as ConfigInput) as unknown as Record<string, unknown>;
    },
  });
}

export function validateConfig(value: ConfigInput): OrcodeConfigWithBudget {
  const approvalMode = includes(APPROVAL_MODES, value.approvalMode)
    ? value.approvalMode
    : DEFAULT_CONFIG.approvalMode;
  const compressionMode = includes(COMPRESSION_MODES, value.compressionMode)
    ? value.compressionMode
    : DEFAULT_CONFIG.compressionMode;

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
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
    providerSetup: normalizeProviderSetupInput(value.providerSetup),
    appearance: validateAppearance(value.appearance),
    lowBalanceThresholdUsd: boundedNumber(
      value.lowBalanceThresholdUsd,
      0,
      1_000,
      DEFAULT_CONFIG.lowBalanceThresholdUsd,
    ),
    architectExecutor: validateArchitectExecutor(value.architectExecutor),
  };
}

/**
 * Additive-field convention (matches `appearance`'s own doc comment above):
 * malformed input silently falls back to `null` ("not configured yet")
 * rather than throwing — a corrupt or hand-edited config.json must never
 * brick startup over one optional route. Only a fully resolved route with a
 * canonical model id is accepted, matching the same constraint Cross's own
 * `preferredLead`/`preferredChallenger` persist under (provider-state.ts).
 */
function validateArchitectExecutor(value: unknown): RouteIdentityV1 | null {
  const route = validateRouteIdentityV1(value);
  if (!route || route.resolutionState !== "resolved" || route.canonicalModelId === null) {
    return null;
  }
  return route;
}

/** Each field falls back on its own default; a malformed sibling never erases a valid one. */
export function validateAppearance(value: unknown): AppearanceConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_APPEARANCE };
  }
  return {
    showLargeLogo: typeof value.showLargeLogo === "boolean"
      ? value.showLargeLogo
      : DEFAULT_APPEARANCE.showLargeLogo,
    showHeaderMark: typeof value.showHeaderMark === "boolean"
      ? value.showHeaderMark
      : DEFAULT_APPEARANCE.showHeaderMark,
    glyphMode: includes(GLYPH_MODES, value.glyphMode)
      ? value.glyphMode
      : DEFAULT_APPEARANCE.glyphMode,
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
      `Panel needs at least ${PANEL_MIN_MODELS} distinct models, got: ${deduped.length}.`,
    );
  }
  if (deduped.length > PANEL_MAX_MODELS) {
    throw new Error(
      `Panel allows at most ${PANEL_MAX_MODELS} models, got: ${deduped.length}.`,
    );
  }
  const known = new Set(knownModelIds.map((id) => id.toLowerCase()));
  const unknown = deduped.filter((model) => !known.has(model.toLowerCase()));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown model ID(s): ${unknown.join(", ")}. Check the spelling with /models <search>.`,
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
  if (typeof value.allowFallbacks === "boolean") {
    result.allowFallbacks = value.allowFallbacks;
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
  const candidate = Object.hasOwn(value, "maxRepairRounds")
    ? value.maxRepairRounds
    : migrateLegacyRepairRounds(value.maxRounds);
  const maxRepairRounds = boundedInteger(
    candidate,
    0,
    VERIFY_MAX_ROUNDS,
    DEFAULT_VERIFY.maxRepairRounds,
  );
  return { commands, mode, maxRepairRounds };
}

/** Legacy `maxRounds` counted total verification passes; the new field counts only repairs. */
function migrateLegacyRepairRounds(value: unknown): unknown {
  return Number.isInteger(value) ? Math.max(0, Number(value) - 1) : undefined;
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
      message: `Daily budget reached: ${formatUsd(spend.dayUsd)} of ${formatUsd(budget.dailyLimitUsd)} spent today in this workspace.`,
    };
  }
  if (budget.totalLimitUsd !== null && spend.totalUsd >= budget.totalLimitUsd) {
    return {
      exceeded: true,
      scope: "total",
      action: budget.onExceed,
      message: `Total budget reached: ${formatUsd(spend.totalUsd)} of ${formatUsd(budget.totalLimitUsd)} spent in this workspace.`,
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
    providerSetup: createNeverConfiguredProviderState(),
    appearance: { ...DEFAULT_APPEARANCE },
  };
}

function refuseUnsafeStoredConfig(
  path: string,
  snapshot: ConfigFileSnapshot,
): void {
  if (snapshot.kind === "absent") return;
  try {
    const parsed: unknown = JSON.parse(snapshot.raw);
    if (
      isRecord(parsed) &&
      typeof parsed.schemaVersion === "number" &&
      parsed.schemaVersion > CONFIG_SCHEMA_VERSION
    ) {
      throw new Error(
        `Configuration ${path} has the future schemaVersion ${parsed.schemaVersion} and will not be overwritten.`,
      );
    }
    if (isRecord(parsed) && "providerSetup" in parsed) {
      const providerSetup = validateProviderSetupState(parsed.providerSetup);
      if (isProviderStateIssue(providerSetup)) {
        throw new Error(
          `Configuration ${path} has providerSetup ${providerSetup.kind} and will not be overwritten.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

function currentPersistableProviderSetup(
  snapshot: ConfigFileSnapshot,
): ProviderSetupState | null {
  if (snapshot.kind === "absent") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !("providerSetup" in parsed)) return null;
  const providerSetup = validateProviderSetupState(parsed.providerSetup);
  requirePersistableProviderState(providerSetup);
  return providerSetup;
}

function normalizeProviderSetupInput(value: unknown): ProviderSetupState {
  if (
    isRecord(value)
    && (value.kind === "corrupt" || value.kind === "future-version")
  ) {
    return value as unknown as ProviderSetupState;
  }
  return validateProviderSetupState(value);
}

/**
 * A config we could not parse is user data. Keep a copy instead of letting the
 * next write destroy it silently.
 */
async function preserveBrokenConfig(
  path: string,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  if (snapshot.kind === "absent") return;
  try {
    const parsed: unknown = JSON.parse(snapshot.raw);
    if (isRecord(parsed)) {
      return;
    }
  } catch {
    // fall through: unparsable
  }
  await assertConfigFileSnapshot(path, snapshot);
  await rename(path, `${path}.corrupted`).catch(() => {});
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
