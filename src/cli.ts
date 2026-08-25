#!/usr/bin/env node

import { input, confirm, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  AgentRunError,
  OrcodeAgent,
  assertSpendAvailable,
  bindModelRuntimeIdentity,
  isAbortError,
  readModelRuntimeIdentity,
  type AgentRunOutcome,
  type AgentRunResult,
  type ModelRuntimeBindingIdentityV1,
} from "./agent.js";
import {
  attachmentPromptSummary,
  formatBytes,
  inspectImageAttachment,
  validateImageAttachmentSet,
  type ImageAttachment,
} from "./attachments.js";
import { ApprovalManager } from "./approval.js";
import { pruneBrowserTempArtifacts } from "./browser.js";
import { resolveSlashCommand } from "./command-catalog.js";
import { RuleStore } from "./rules.js";
import { createSshSession, type SshSession } from "./ssh.js";
import {
  createPlainCommandOutput,
  handleSlashCommand,
  audioInputModelCandidates,
  compressorModelCandidates,
  mainModelCandidates,
  panelModelCandidates,
  ModelCapabilityError,
  ModelNotFoundError,
  rankModels,
  providerBackendActions,
  resolveCompressorModelCandidate,
  resolveMainModelCandidate,
  shouldReplaceCredential,
  validateAndActivateInferenceKey,
  type CommandContext,
  type CommandLocalRuntime,
  type CommandOutput,
  type ProviderCredentialIntentPort,
  type ProviderCommandIntent,
  type ProviderCommandIntentPort,
  type ProviderCommandBackendId,
  type ProviderCommandResult,
  type ProviderCommandStatusEntry,
  type ProviderRouteIntentPort,
  type SettingsCommandPort,
} from "./commands.js";
import {
  APP_HOME,
  DEFAULT_CONFIG,
  assertConfigFileSnapshot,
  consumeConfigWarning,
  configPath,
  isAtomicFilePostPublicationError,
  isApprovalMode,
  isCompressionMode,
  loadConfig,
  migrateAppHome,
  readConfigEditSnapshot,
  readConfigFileSnapshot,
  saveConfig,
  saveConfigEdit,
  validateConfig,
  withConfigWriteLock,
  writeFileAtomicCreateSecure,
  writeFileAtomicSecure,
  type OrcodeConfigWithBudget,
} from "./config.js";
import {
  SettingsController,
  SettingsExternalActionCancelledError,
  SettingsRunActiveError,
  projectSettingsConfig,
  type SettingsConfigProjection,
  type SettingsExternalAction,
} from "./settings-controller.js";
import { runSettingsSession } from "./settings-session.js";
import type {
  SettingsAuthoritativeSnapshot,
  SettingsProviderHealthProjection,
  SettingsProviderHeadline,
  SettingsProviderProjection,
  SettingsRouteProjection,
} from "./settings-registry.js";
import {
  CredentialStore,
  normalizeProviderSecret,
  type CredentialKind,
  type CredentialSlotRef,
  type CredentialStoreLike,
} from "./credentials.js";
import {
  OpenRouterService,
  createOpenRouterModelRuntime,
} from "./openrouter.js";
import type { PanelJudgment, PanelResult } from "./panel.js";
import {
  buildResumePrompt,
  findInterruptedRun,
  formatInterruptedRunNotice,
  formatUndoOutcome,
  markRunReviewed,
  summarizeRun,
  undoInterruptedRun,
  type InterruptedRun,
  type RunSummary,
} from "./resume.js";
import {
  getReasoningSetting,
  reasoningChoiceValue,
  reasoningChoices,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
import {
  SessionStore,
  dayKey,
  migratedOpenRouterSessionConnection,
  migrateLegacySession,
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  type SaveOutcome,
} from "./session.js";
import {
  TerminalUi,
  UiExitError,
  runOutcomeLabel,
  sanitizeTerminalText,
  type DashboardState,
  type SettingsEditorResolver,
} from "./tui.js";
import type {
  AgentRunEvent,
  ApprovalMode,
  BalanceInfo,
  ChatSummary,
  ModelInfo,
} from "./types.js";
import { APPROVAL_MODES } from "./types.js";
import { approvalDescription } from "./approval.js";
import { transcribeAudio } from "./transcribe.js";
import {
  createAudioRecorders,
  deleteRecordedAudio,
  ensureVoiceConsent,
  selectAudioRecorder,
  type AudioRecorder,
  type RecordedAudio,
  type RecordingHandle,
  type RecordingStopReason,
} from "./voice.js";
import {
  ChangeJournal,
  WorkspaceGuard,
  catastrophicGuardNotice,
  getGitStatus,
  pruneCheckpoints,
} from "./workspace.js";
import { errorMessage, formatUsd, isRecord } from "./utils.js";
import { RunLog } from "./runlog.js";
import { collectRetentionErrors } from "./storage.js";
import {
  createPlainSetupSurface,
  createSettingsSetupSurface,
  createTuiSetupSurface,
  runSetupHub,
  type SetupHubOptions,
  type SetupHubResult,
  type SetupPreparedRoles,
  type SetupSurface,
} from "./setup-ui.js";
import {
  BackendRegistry,
  ProviderSetupRequiredError,
  deriveProviderHeadline,
  sameRoute,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderInspection,
  type RouteIdentityV1,
} from "./backends.js";
import {
  ANTHROPIC_COMING_SOON_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
  OpenRouterBackendAdapter,
} from "./openrouter-backend.js";
import {
  KIMI_CODE_DESCRIPTOR,
  KimiCodeBackendAdapter,
} from "./kimi-code-backend.js";
import {
  KIMI_CODE_MODELS,
  KimiCodeService,
  issuedKimiCodeFailure,
} from "./kimi-code.js";
import {
  createKimiCodeModelRuntime,
  type ModelRuntime,
} from "./model-runtime.js";
import {
  PROVIDER_CREDENTIAL_FORGET_DIRECTORY,
  ProviderActivationCoordinator,
  createProviderPreferenceCommitPort,
  type ProviderPreferenceCommitPort,
  type ProviderCoordinatorLease,
  type ProviderActivationRuntimeGuard,
  type ProviderActivationRuntimeLease,
} from "./provider-activation.js";
import {
  recoverModelPreferenceTransactions,
  runModelPreferenceTransaction,
  type RecoveredModelPreferenceOwner,
  type ModelPreferenceAuthorityPublication,
  type ModelPreferenceAuthoritySnapshot,
  type ModelPreferenceRouteAuthority,
} from "./model-preference-transaction.js";
import { suggestVerifyCommands } from "./verify.js";
import {
  adoptDurablyCommittedProviderState,
  ProviderStateStore,
  readProviderStateCommitAdoption,
  requirePersistableProviderState,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV2,
  type ProviderStateCommitRequest,
} from "./provider-state.js";
import {
  SetupOrchestrator,
  runProviderStartupAttempt,
  type ProviderExecutionMode,
  type ProviderStartupStepContext,
  type StartupSetupResult,
} from "./setup.js";
import {
  ProviderCredentialAuthority,
  ProviderAuthoritySnapshot,
  parseOpenRouterCredentialPointer,
  selectProviderBinding,
  selectOpenRouterBinding,
  type ProviderCandidateAuthorityLease,
  type ProviderCandidateAuthorityResult,
  type ProviderCandidateCredentialPermit,
  type ProviderCredentialAuthorityLike,
} from "./provider-authority.js";
import { PrivateStore, type PrivateDirectoryClaim } from "./private-store.js";

const execFileAsync = promisify(execFile);

/**
 * How many past turns the dashboard shows when a chat opens. One value for
 * every entry point — startup used to show 12 and a chat switch 40, so the
 * same chat looked different depending on how you got there.
 */
const VISIBLE_TURNS = 40;

/** Binds the transport-neutral setup hub to the existing plain prompts. */
export function createCliPlainSetupSurface(prompts = { select, password, confirm }) {
  return createPlainSetupSurface({
    select: prompts.select,
    password: prompts.password,
    confirm: prompts.confirm,
  });
}

/**
 * K8: a "Bedienfehler" — bad CLI usage, caught by `main()`'s top-level
 * handler and reported with exit code 2. Distinct from a runtime failure
 * (network, model, tool), which is exit code 1.
 */
export class CliUsageError extends Error {}

export interface CliOptions {
  workspace: string;
  prompt?: string;
  model?: string;
  approval?: string;
  compression?: string;
  chatId?: string;
  newChat: boolean;
  continueChat: boolean;
  help: boolean;
  version: boolean;
  plain: boolean;
  /** K8: NDJSON run events on stdout, non-interactive, machine-readable. */
  json: boolean;
  /** Resume an interrupted run's context without asking (see src/resume.ts). */
  resume: boolean;
  /** Never mention an interrupted run this start. */
  noResume: boolean;
}

const TRUSTED_EXECUTION_MODE_DOWNGRADES: ReadonlySet<ProviderExecutionMode> = new Set([
  "scheduled",
  "relay",
  "multi-user",
  "collaborator",
  "shared-service",
  "unenrolled-device",
]);

export function deriveProviderExecutionMode(
  options: Pick<CliOptions, "json" | "prompt">,
  launcherMode?: ProviderExecutionMode,
): ProviderExecutionMode {
  const locallyDerived: ProviderExecutionMode = options.json
    ? "json"
    : options.prompt !== undefined
      ? "batch"
      : !process.stdin.isTTY || !process.stdout.isTTY
        ? "piped"
        : "local-interactive-owner";
  if (
    locallyDerived === "local-interactive-owner"
    && launcherMode
    && TRUSTED_EXECUTION_MODE_DOWNGRADES.has(launcherMode)
  ) return launcherMode;
  return locallyDerived;
}

export interface StartupStorageDependencies {
  migrateAppHome: typeof migrateAppHome;
  pruneRunLogs: (appHome: string) => Promise<unknown>;
  pruneCheckpoints: (appHome: string) => Promise<unknown>;
  pruneBrowserTempArtifacts: () => Promise<unknown>;
  loadConfig: typeof loadConfig;
  loadRules: typeof RuleStore.load;
  openSession: (
    workspace: string,
    appHome: string,
    options: { newChat: boolean; chatId?: string },
    providerConnection?: ProviderConnectionStateV1,
  ) => Promise<SessionStore>;
}

export interface StartupStorageResult {
  appHome: string;
  configPath: string;
  migrationWarning: string | null;
  retentionWarnings: string[];
  config: OrcodeConfigWithBudget;
  ruleStore: RuleStore;
  session: SessionStore;
}

/** The only CLI path that opens local state; migration is awaited first. */
export async function initializeStartupStorage(
  options: { workspace: string; newChat: boolean; chatId?: string },
  dependencies: Partial<StartupStorageDependencies> = {},
): Promise<StartupStorageResult> {
  const deps: StartupStorageDependencies = {
    migrateAppHome,
    pruneRunLogs: (appHome) => RunLog.prune(appHome),
    pruneCheckpoints,
    pruneBrowserTempArtifacts: () => pruneBrowserTempArtifacts(),
    loadConfig,
    loadRules: (appHome) => RuleStore.load(appHome),
    openSession: async (workspace, appHome, startup, providerConnection) => {
      if (startup.newChat || startup.chatId) {
        await migrateLegacySession(workspace, appHome);
        return startup.chatId
          ? SessionStore.openById(workspace, startup.chatId, appHome, providerConnection)
          : SessionStore.create(workspace, appHome);
      }
      return SessionStore.open(workspace, appHome, providerConnection);
    },
    ...dependencies,
  };
  const migration = await deps.migrateAppHome();
  if (migration.status !== "ready") {
    throw new Error(migration.warning ?? `Startup-Speicherstatus: ${migration.status}`);
  }
  const appHome = migration.appHome;
  const retentionWarnings: string[] = [];
  for (const [label, prune] of [
    ["redacted", () => deps.pruneRunLogs(appHome)],
    ["exact", () => deps.pruneCheckpoints(appHome)],
    ["browser", deps.pruneBrowserTempArtifacts],
  ] as const) {
    try {
      const result = await prune();
      for (const error of collectRetentionErrors(result)) {
        retentionWarnings.push(
          `Aufbewahrung (${label}) konnte nicht vollständig bereinigt werden: ${error.message} (${error.path})`,
        );
      }
    } catch (error) {
      retentionWarnings.push(`Aufbewahrung (${label}) konnte nicht vollständig bereinigt werden: ${errorMessage(error)}`);
    }
  }
  const config = await deps.loadConfig(configPath(appHome));
  const ruleStore = await deps.loadRules(appHome);
  const session = await deps.openSession(
    options.workspace,
    appHome,
    options,
    migratedOpenRouterSessionConnection(config.providerSetup),
  );
  return {
    appHome,
    configPath: configPath(appHome),
    migrationWarning: migration.warning,
    retentionWarnings,
    config,
    ruleStore,
    session,
  };
}

/**
 * Reads the version from package.json so it is stated in exactly one place.
 * Works from both src/ (tsx) and dist/ because both sit one level below the root.
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder below.
  }
  return "unbekannt";
}

export function createOpenRouterServiceForStartup(keys: {
  storedInferenceKey: StoredCredentialStartupInput;
  environmentInferenceKey: string | null;
  storedManagementKey?: StoredCredentialStartupInput;
  environmentManagementKey?: string | null;
}): OpenRouterService {
  const inference = selectAuthoritativeStartupCredential(
    keys.storedInferenceKey,
    () => keys.environmentInferenceKey,
    "API-Key",
  );
  const management = selectAuthoritativeStartupCredential(
    keys.storedManagementKey ?? null,
    () => keys.environmentManagementKey ?? null,
    "Management-Key",
  );
  return new OpenRouterService(
    inference.value,
    management.value,
    {
      ...(inference.origin ? { inference: inference.origin } : {}),
      ...(management.origin ? { management: management.origin } : {}),
    },
  );
}

export type StoredCredentialStartupState =
  | { kind: "absent" }
  | { kind: "present"; value: string }
  | { kind: "invalid" };

type StoredCredentialStartupInput = string | null | StoredCredentialStartupState;

function selectAuthoritativeStartupCredential(
  stored: StoredCredentialStartupInput,
  environment: () => string | null,
  label: string,
): { value: string | undefined; origin?: "keychain" | "environment" } {
  const state: StoredCredentialStartupState = typeof stored === "string"
    ? { kind: "present", value: stored }
    : stored === null
      ? { kind: "absent" }
      : stored;
  if (state.kind === "invalid") {
    throw new Error(`Gespeicherter ${label} ist ungültig oder nicht lesbar.`);
  }
  if (state.kind === "present") {
    return {
      value: normalizeProviderSecret(state.value),
      origin: "keychain",
    };
  }
  const processValue = environment();
  return processValue === null
    ? { value: undefined }
    : {
        value: normalizeProviderSecret(processValue),
        origin: "environment",
      };
}

export async function loadStoredCredentialForStartup(
  credentials: Pick<CredentialStoreLike, "get">,
  kind: CredentialKind,
): Promise<StoredCredentialStartupState> {
  try {
    const value = await credentials.get(kind);
    return value === null
      ? { kind: "absent" }
      : { kind: "present", value };
  } catch {
    return { kind: "invalid" };
  }
}

export interface StartupCredentialStoreOptions {
  globalHmacLockRoot?: string;
  instantiate?: (globalHmacLockRoot: string) => CredentialStore;
}

export function createCredentialStoreForStartup(
  _selectedAppHome: string,
  options: StartupCredentialStoreOptions = {},
): CredentialStore {
  const globalHmacLockRoot = options.globalHmacLockRoot ?? APP_HOME;
  return options.instantiate?.(globalHmacLockRoot) ?? new CredentialStore(
    undefined,
    undefined,
    undefined,
    globalHmacLockRoot,
  );
}

export interface ProviderRuntimeInput {
  startup: StartupStorageResult;
  environment: Readonly<Record<string, string | undefined>>;
  requestedModel?: string;
  executionMode: ProviderExecutionMode;
}

export interface ProviderRuntime extends ProviderRouteIntentPort, ProviderCommandIntentPort {
  readonly openRouter: OpenRouterService;
  readonly credentials: CredentialStore;
  readonly preparedRoles: SetupPreparedRoles | null;
  modelRuntime(route: RouteIdentityV1): ModelRuntime;
  migratedSessionConnection(): ProviderConnectionStateV1 | undefined;
  inspectStartup(): Promise<StartupSetupResult>;
  resolveLegacyDefaultRoute(): Promise<StartupSetupResult>;
  runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<SetupHubResult>;
  /** A cached counter projection; this never acquires a runtime lease. */
  settingsActivity?(): ProviderRuntimeActivity;
  activity?(): ProviderRuntimeActivity;
  readCachedSettingsModels?(): readonly ModelInfo[];
  readCachedModels?(): readonly ModelInfo[];
  readCachedProviderStatus?(): readonly ProviderCommandStatusEntry[];
  readCachedSettingsRoute?(): SettingsRouteProjection | null;
  readModelPreferenceAuthority?(): ModelPreferenceAuthoritySnapshot;
  runSettingsConfigMutation?<T>(task: () => Promise<T>): Promise<T>;
  prepareSettingsModelPublication?(route: RouteIdentityV1): { publish(): void };
  readCachedSettingsProjection?(): {
    readonly route: SettingsRouteProjection | null;
    readonly providers: readonly SettingsProviderProjection[];
  };
  ensureRunnableRoute(): RouteIdentityV1;
  currentSessionRoute(): RouteIdentityV1;
  selectSessionRoute(
    route: RouteIdentityV1,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1>;
  adoptSession(session: SessionStore): void;
  readonly providerCredentials: ProviderCredentialIntentPort;
  runWithReadyRoute<T>(
    run: (route: RouteIdentityV1) => Promise<T>,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<T>;
}

export class KimiOwnerInteractiveRequiredError extends Error {
  readonly code = "kimi-code-owner-interactive-required" as const;
  readonly exitCode = 1 as const;

  constructor() {
    super("Kimi Code Abo ist nur in einer lokalen, interaktiven Owner-Sitzung verfügbar.");
    this.name = "KimiOwnerInteractiveRequiredError";
  }
}

class KimiExecutionPolicyAdapter implements BackendAdapter {
  readonly backendId = "kimi-code" as const;

  async inspect(request: Parameters<BackendAdapter["inspect"]>[0]): Promise<ProviderInspection> {
    const health = {
      credential: "valid" as const,
      connectivity: "connected" as const,
      spend: "unknown" as const,
      runtime: "policy-unavailable" as const,
      observedAt: Date.now(),
      generation: request.generation,
    };
    return {
      backendId: "kimi-code",
      connectionId: request.connectionId,
      health,
      headline: deriveProviderHeadline(health),
      accountFingerprint: null,
      billingRealm: "kimi-code-membership-provider-managed-overage",
      routeEligible: false,
      retryable: false,
      explanationCode: "kimi-code-owner-interactive-required",
    };
  }

  async reconnect(request: Parameters<BackendAdapter["reconnect"]>[0]): Promise<ProviderInspection> {
    return this.inspect(request);
  }

  async connect(): Promise<ProviderCandidate> { throw new KimiOwnerInteractiveRequiredError(); }
  async listModels(): Promise<readonly BackendModelDescriptor[]> { throw new KimiOwnerInteractiveRequiredError(); }
  async activate(): Promise<CandidateProviderState> { throw new KimiOwnerInteractiveRequiredError(); }
  async logout(): Promise<void> { throw new KimiOwnerInteractiveRequiredError(); }
  async discardCandidate(): Promise<void> {}
}

export async function executeProviderModelAction<T>(input: {
  ensureRunnableRoute(): RouteIdentityV1;
  beginRun(): () => void;
  run(route: RouteIdentityV1): Promise<T>;
  isAuthenticationFailure(error: unknown): boolean;
  invalidateAndInspect(): Promise<void>;
  runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<unknown>;
  surface?: SetupSurface | "plain" | "fullscreen";
}): Promise<T> {
  const route = input.ensureRunnableRoute();
  const release = input.beginRun();
  let failure: unknown;
  try {
    return await input.run(route);
  } catch (error) {
    failure = error;
  } finally {
    release();
  }
  await recoverProviderAuthenticationFailure({
    failure,
    isAuthenticationFailure: input.isAuthenticationFailure,
    invalidateAndInspect: input.invalidateAndInspect,
    runSetup: input.runSetup,
    surface: input.surface,
  });
  throw failure;
}

/** Shared best-effort recovery used by model calls and Settings model transitions. */
export async function recoverProviderAuthenticationFailure(input: {
  readonly failure: unknown;
  readonly isAuthenticationFailure: (error: unknown) => boolean;
  readonly invalidateAndInspect: () => Promise<void>;
  readonly runSetup: (surface: SetupSurface | "plain" | "fullscreen") => Promise<unknown>;
  readonly surface?: SetupSurface | "plain" | "fullscreen";
}): Promise<void> {
  if (!input.isAuthenticationFailure(input.failure)) return;
  try {
    await input.invalidateAndInspect();
    if (input.surface) await input.runSetup(input.surface);
  } catch {
    // The original provider rejection is the only error safe and relevant
    // to the attempted action; recovery remains best effort and the proof
    // was invalidated before inspection began.
  }
}

function assertModelBoundToRoute(modelId: string, route: RouteIdentityV1): void {
  if (modelId !== route.requestedModelId && modelId !== route.canonicalModelId) {
    throw new ProviderSetupRequiredError();
  }
}

function sameExactRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function sameRouteOwner(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm;
}

function isProviderSetupRequired(error: unknown): boolean {
  return error instanceof ProviderSetupRequiredError
    || Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "provider-setup-required",
    );
}

export interface ProviderRuntimeActivity {
  readonly runActive: boolean;
  readonly activationHeld: boolean;
}

export class SessionProviderRuntimeGuard implements ProviderActivationRuntimeGuard {
  #activationHeld = false;
  #activeRuns = 0;

  async acquire(signal: AbortSignal): Promise<ProviderActivationRuntimeLease> {
    if (signal.aborted) throw signal.reason;
    if (this.#activationHeld || this.#activeRuns > 0) {
      throw new Error("Provider runtime is not idle.");
    }
    this.#activationHeld = true;
    let held = true;
    const assertHeld = () => {
      if (!held || !this.#activationHeld || this.#activeRuns > 0) {
        throw new Error("Provider runtime lease was lost.");
      }
    };
    return {
      assertHeld,
      assertHeldSynchronously: assertHeld,
      release: () => {
        if (!held) return;
        held = false;
        this.#activationHeld = false;
      },
    };
  }

  beginRun(): () => void {
    if (this.#activationHeld) throw new ProviderSetupRequiredError();
    this.#activeRuns += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#activeRuns -= 1;
    };
  }

  activity(): ProviderRuntimeActivity {
    return Object.freeze({
      runActive: this.#activeRuns > 0,
      activationHeld: this.#activationHeld,
    });
  }
}

export type SettingsRuntimeProjection = Omit<SettingsAuthoritativeSnapshot, "config"> & {
  readonly config: SettingsConfigProjection;
};

export interface SettingsRuntimeSnapshotPort {
  readCached(): SettingsRuntimeProjection;
}

export interface SettingsCachedRuntimeSource {
  activity(): ProviderRuntimeActivity;
  readCachedSettingsRoute(): SettingsRouteProjection | null;
  readCachedProviderStatus(): readonly ProviderCommandStatusEntry[];
  /** Exact current route/account-owned cache; preferred over legacy mixed caches. */
  readCachedSettingsModels?(): readonly ModelInfo[];
  readCachedModels?(): readonly ModelInfo[];
  /** Additional runtime methods are deliberately ignored by the cached mapper. */
  readonly [key: string]: unknown;
}

export interface SettingsRuntimeSnapshotInput {
  readonly config: OrcodeConfigWithBudget;
  readonly runtime: SettingsCachedRuntimeSource;
  readonly session: {
    readonly data: {
      readonly costs: {
        readonly mainUsd?: number;
        readonly compressorUsd?: number;
        readonly voiceUsd?: number;
        readonly totalUsd: number;
        readonly costKnowledge?: "known" | "unknown";
      };
      readonly dailySpendUsd: Readonly<Record<string, number>>;
    };
  };
  readonly ruleStore: {
    list(workspace: string): readonly { readonly id: string; readonly decision: "allow" | "deny" }[];
  };
  readonly workspace: string;
  readonly readCachedModels?: () => readonly ModelInfo[];
  readonly readCachedWorkspaceTotalUsd?: () => number;
  readonly now?: () => Date;
}

/** Pure synchronous projection: it has no provider command, credential, env, or fetch seam. */
export function createSettingsRuntimeSnapshotPort(
  input: SettingsRuntimeSnapshotInput,
): SettingsRuntimeSnapshotPort {
  return Object.freeze({
    readCached(): SettingsRuntimeProjection {
      const activity = input.runtime.activity();
      const sessionUsd = safeCachedUsd(input.session.data.costs.totalUsd);
      const dayUsd = safeCachedUsd(
        input.session.data.dailySpendUsd[dayKey((input.now ?? (() => new Date()))())] ?? 0,
      );
      const totalUsd = safeCachedUsd(input.readCachedWorkspaceTotalUsd?.() ?? sessionUsd);
      return deepFreezeSettingsProjection({
        config: projectSettingsConfig(input.config),
        runActive: activity.runActive || activity.activationHeld,
        route: projectCachedSettingsRoute(input.runtime.readCachedSettingsRoute()),
        providers: projectSettingsProviderStatus(input.runtime.readCachedProviderStatus()),
        approvalRules: input.ruleStore.list(input.workspace).map((rule) => ({
          id: rule.id,
          decision: rule.decision,
        })),
        costs: {
          costKnowledge: input.session.data.costs.costKnowledge === "unknown" ? "unknown" : "known",
          sessionUsd,
          dayUsd,
          totalUsd,
        },
        cachedModels: projectSettingsModelInfos(
          input.readCachedModels?.()
            ?? input.runtime.readCachedSettingsModels?.()
            ?? input.runtime.readCachedModels?.()
            ?? [],
        ),
      });
    },
  });
}

/**
 * Bridges the model-preference journal to the existing provider coordinator.
 * The returned authority creates exactly one opaque provider commit port; it
 * never owns a second runtime/provider lock or exposes the mutation token.
 */
export function createModelPreferenceRouteAuthority(input: {
  readonly runtime: ProviderRuntime;
  readonly candidate: {
    readonly requestedModelId: string;
    readonly canonicalModelId: string;
  };
  readonly surface?: SetupSurface | "plain" | "fullscreen";
}): ModelPreferenceRouteAuthority {
  const transition = input.runtime.transitionSessionModel;
  const read = input.runtime.readModelPreferenceAuthority;
  if (typeof transition !== "function" || typeof read !== "function") {
    throw new ProviderSetupRequiredError();
  }
  const candidate = Object.freeze({
    requestedModelId: input.candidate.requestedModelId,
    canonicalModelId: input.candidate.canonicalModelId,
  });
  let commitCalled = false;
  return Object.freeze({
    async read() {
      return structuredClone(read.call(input.runtime));
    },
    async commit(
      route: RouteIdentityV1,
      publication: ModelPreferenceAuthorityPublication,
    ) {
      if (commitCalled) throw new ProviderSetupRequiredError();
      commitCalled = true;
      const port = createProviderPreferenceCommitPort({
        persist: async ({ state }, authority) => {
          const staged = await publication.persist(state, authority);
          return authority.acknowledgePersistence(staged.configFence);
        },
        abortAndReconcile: (authority) => publication.abortAndReconcile(authority),
        complete: (_providerCandidate, authority) => publication.complete(authority),
        cleanup: (authority) => publication.cleanup(authority),
      });
      const committed = await transition.call(
        input.runtime,
        candidate,
        port,
        input.surface,
      );
      if (!sameExactRoute(committed, route)) throw new ProviderSetupRequiredError();
    },
  });
}

export function projectSettingsProviderStatus(
  entries: readonly ProviderCommandStatusEntry[],
): readonly SettingsProviderProjection[] {
  const seen = new Set<string>();
  const projected: SettingsProviderProjection[] = [];
  for (const entry of entries) {
    if (seen.has(entry.backendId)) continue;
    seen.add(entry.backendId);
    const comingSoon = entry.backendId === "anthropic";
    projected.push({
      backendId: entry.backendId,
      displayName: providerDisplayName(entry.backendId),
      availability: comingSoon ? "coming-soon" : "connectable",
      configuration: comingSoon ? "disabled" : entry.configuration,
      maturity: comingSoon
        ? "coming-soon"
        : entry.maturity === "preview" ? "preview" : "stable",
      billingRealm: entry.backendId === "openrouter"
        ? "openrouter-payg"
        : entry.backendId === "kimi-code"
          ? "kimi-code-membership-provider-managed-overage"
          : "none",
      headline: safeSettingsHeadline(entry.headline),
      health: safeSettingsHealth(entry.health),
      isDefault: comingSoon ? false : entry.isDefault,
      selectedModel: comingSoon || !entry.selectedModel
        ? null
        : {
            requestedModelId: entry.selectedModel.requestedModelId,
            canonicalModelId: entry.selectedModel.canonicalModelId,
            displayName: entry.selectedModel.displayName,
          },
      allowedActions: comingSoon ? [] : providerBackendActions(entry.backendId),
    });
  }
  return deepFreezeSettingsProjection(projected);
}

function projectCachedSettingsRoute(
  route: SettingsRouteProjection | null,
): SettingsRouteProjection | null {
  if (!route) return null;
  return {
    backendId: route.backendId,
    providerLabel: providerDisplayName(route.backendId),
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId,
    modelLabel: route.modelLabel,
    billingRealm: route.backendId === "openrouter"
      ? "openrouter-payg"
      : route.backendId === "kimi-code"
        ? "kimi-code-membership-provider-managed-overage"
        : "none",
  };
}

function providerDisplayName(backendId: ProviderCommandBackendId): string {
  if (backendId === "openrouter") return "OpenRouter";
  if (backendId === "kimi-code") return "Kimi Code";
  return "Anthropic";
}

function safeSettingsHeadline(value: string | null): SettingsProviderHeadline | null {
  const known = new Set<SettingsProviderHeadline>([
    "ready", "login-required", "auth-rejected", "credential-expired", "offline",
    "limit-reached", "runtime-missing", "incompatible-runtime", "policy-unavailable", "unknown",
  ]);
  return value === null ? null : known.has(value as SettingsProviderHeadline)
    ? value as SettingsProviderHeadline
    : "unknown";
}

function safeSettingsHealth(
  value: ProviderCommandStatusEntry["health"],
): SettingsProviderHealthProjection | null {
  if (!value) return null;
  const credential = ["valid", "rejected", "expired", "login-required", "unknown", "not-applicable"]
    .includes(value.credential) ? value.credential as SettingsProviderHealthProjection["credential"] : "unknown";
  const connectivity = ["connected", "offline", "unknown"].includes(value.connectivity)
    ? value.connectivity as SettingsProviderHealthProjection["connectivity"] : "unknown";
  const spend = ["available", "limit-reached", "unknown"].includes(value.spend)
    ? value.spend as SettingsProviderHealthProjection["spend"] : "unknown";
  const runtime = ["ready", "missing", "incompatible", "policy-unavailable", "not-applicable"]
    .includes(value.runtime) ? value.runtime as SettingsProviderHealthProjection["runtime"] : "policy-unavailable";
  return { credential, connectivity, spend, runtime };
}

function safeCachedUsd(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function projectSettingsModelInfos(values: readonly ModelInfo[]): readonly ModelInfo[] {
  const projected: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const model = projectSettingsModelInfo(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    projected.push(model);
  }
  return projected;
}

/** Explicit allowlist projection. Runtime-added properties, including request
 * metadata or credential canaries, never cross into the Settings snapshot. */
function projectSettingsModelInfo(value: ModelInfo): ModelInfo | null {
  if (!value
    || typeof value !== "object"
    || !safeCachedModelString(value.id)
    || !safeCachedModelString(value.name)
    || typeof value.description !== "string"
    || !safeCachedModelNumber(value.contextLength, 0)
    || !safeCachedModelNumber(value.promptPrice)
    || !safeCachedModelNumber(value.completionPrice)
    || !safeCachedStringArray(value.supportedParameters)
    || !safeCachedStringArray(value.inputModalities)
    || !safeCachedStringArray(value.outputModalities)) return null;
  if (value.canonicalSlug !== undefined && !safeCachedModelString(value.canonicalSlug)) return null;
  if (value.createdAt !== undefined && !safeCachedModelNumber(value.createdAt, 0)) return null;
  if (value.maxCompletionTokens !== undefined
    && value.maxCompletionTokens !== null
    && !safeCachedModelNumber(value.maxCompletionTokens, 0)) return null;
  if (value.modality !== undefined && typeof value.modality !== "string") return null;
  if (value.tokenizer !== undefined && typeof value.tokenizer !== "string") return null;
  if (value.isModerated !== undefined && typeof value.isModerated !== "boolean") return null;
  if (value.intelligenceIndex !== undefined && !safeCachedModelNumber(value.intelligenceIndex)) return null;
  if (value.codingIndex !== undefined && !safeCachedModelNumber(value.codingIndex)) return null;
  if (value.agenticIndex !== undefined && !safeCachedModelNumber(value.agenticIndex)) return null;
  const reasoning = projectCachedModelReasoning(value.reasoning);
  if (value.reasoning !== undefined && !reasoning) return null;
  return {
    id: value.id,
    ...(value.canonicalSlug === undefined ? {} : { canonicalSlug: value.canonicalSlug }),
    name: value.name,
    description: value.description,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    contextLength: value.contextLength,
    ...(value.maxCompletionTokens === undefined
      ? {}
      : { maxCompletionTokens: value.maxCompletionTokens }),
    promptPrice: value.promptPrice,
    completionPrice: value.completionPrice,
    supportedParameters: [...value.supportedParameters],
    ...(value.modality === undefined ? {} : { modality: value.modality }),
    inputModalities: [...value.inputModalities],
    outputModalities: [...value.outputModalities],
    ...(value.tokenizer === undefined ? {} : { tokenizer: value.tokenizer }),
    ...(value.isModerated === undefined ? {} : { isModerated: value.isModerated }),
    ...(reasoning ? { reasoning } : {}),
    ...(value.intelligenceIndex === undefined ? {} : { intelligenceIndex: value.intelligenceIndex }),
    ...(value.codingIndex === undefined ? {} : { codingIndex: value.codingIndex }),
    ...(value.agenticIndex === undefined ? {} : { agenticIndex: value.agenticIndex }),
  };
}

function projectCachedModelReasoning(
  value: ModelInfo["reasoning"],
): ModelInfo["reasoning"] | null {
  if (!value
    || typeof value !== "object"
    || typeof value.mandatory !== "boolean"
    || typeof value.supportsMaxTokens !== "boolean") return null;
  const allowedEfforts = new Set([
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
  if (value.defaultEffort !== undefined
    && value.defaultEffort !== null
    && !allowedEfforts.has(value.defaultEffort)) return null;
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== "boolean") return null;
  if (value.supportedEfforts !== null
    && (!Array.isArray(value.supportedEfforts)
      || value.supportedEfforts.some((effort) => !allowedEfforts.has(effort)))) return null;
  return {
    ...(value.defaultEffort === undefined ? {} : { defaultEffort: value.defaultEffort }),
    ...(value.defaultEnabled === undefined ? {} : { defaultEnabled: value.defaultEnabled }),
    mandatory: value.mandatory,
    supportedEfforts: value.supportedEfforts === null ? null : [...value.supportedEfforts],
    supportsMaxTokens: value.supportsMaxTokens,
  };
}

function safeCachedModelString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && [...value].length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function safeCachedStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 256
    && value.every((entry) => safeCachedModelString(entry));
}

function safeCachedModelNumber(value: unknown, minimum = Number.NEGATIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function deepFreezeSettingsProjection<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreezeSettingsProjection(item);
    }
    Object.freeze(value);
  }
  return value;
}

type ProviderDestructiveOperation = "disable" | "disconnect" | "logout";
type ProviderConfirmationResult = Extract<
  ProviderCommandResult,
  { kind: "confirmation-required" }
>;

interface ProviderConfirmationBinding {
  operation: ProviderDestructiveOperation;
  backendId: "openrouter" | "kimi-code";
  providerRevision: number;
  connection: {
    id: string;
    enabled: boolean;
    credentialSlot: string;
    accountFingerprint: string;
    billingRealm: string;
  } | null;
  defaultRoute: RouteIdentityV1 | null;
  sessionRoute: RouteIdentityV1 | null;
  processRouteGeneration: number;
}

const LEGACY_LOGOUT_COMMIT_PROOF = Symbol("legacy-logout-commit-proof");

interface LegacyLogoutCommittedOutcome {
  readonly proof: typeof LEGACY_LOGOUT_COMMIT_PROOF;
  readonly state: ProviderSetupStateV2;
  readonly result: Extract<ProviderCommandResult, { kind: "changed" }>;
  completed: boolean;
}

class ProviderConfirmationStaleError extends Error {
  constructor(readonly confirmation: ProviderConfirmationResult) {
    super("Provider confirmation is stale.");
    this.name = "ProviderConfirmationStaleError";
  }
}

export class DefaultProviderRuntime implements ProviderRuntime {
  #preparedRoles: SetupPreparedRoles | null = null;
  #sessionRoute: RouteIdentityV1 | null = null;
  #sessionRoutePersisted = false;
  #pendingSessionBinding: {
    route: RouteIdentityV1;
    connectionId: string;
    generation: number;
    ready: boolean;
  } | null = null;
  #processRouteGeneration = 0;
  #setupPublicationGeneration = 0;
  readonly #providerConfirmations = new Map<string, ProviderConfirmationBinding>();
  #startupAttemptGeneration = 0;
  #modelRuntimeCache: { key: string; runtime: ModelRuntime } | null = null;
  readonly #cachedSettingsModels = new Map<string, ModelInfo>(
    KIMI_CODE_MODELS.map((model) => {
      const projected = kimiDashboardModelInfo(model.id)!;
      return [projected.id, deepFreezeSettingsProjection(projected)] as const;
    }),
  );
  readonly #providerOwnedSettingsModels = new Map<
    string,
    { readonly route: RouteIdentityV1; readonly model: ModelInfo }
  >();

  constructor(
    readonly openRouter: OpenRouterService,
    readonly credentials: CredentialStore,
    private readonly registry: BackendRegistry,
    private readonly stateStore: ProviderStateStore,
    private readonly orchestrator: SetupOrchestrator,
    private readonly activationCoordinator: ProviderActivationCoordinator,
    private readonly runtimeGuard: SessionProviderRuntimeGuard,
    readonly providerCredentials: ProviderCredentialIntentPort,
    _legacySavedSecret: string | null,
    private environmentSecret: string | null,
    private readonly requestedModel: string,
    private readonly config: OrcodeConfigWithBudget,
    private session?: SessionStore,
    private readonly authorityOptions?: {
      credentialAuthority: ProviderCredentialAuthority;
      adapter: OpenRouterBackendAdapter;
      kimiAdapter?: KimiCodeBackendAdapter;
      forgetJournal: ProviderCredentialForgetJournal;
      recover(context: ProviderStartupStepContext): Promise<void>;
    },
    private readonly executionMode: ProviderExecutionMode = "local-interactive-owner",
  ) {}

  get preparedRoles(): SetupPreparedRoles | null {
    return this.#preparedRoles ? structuredClone(this.#preparedRoles) : null;
  }

  settingsActivity(): ProviderRuntimeActivity {
    return this.runtimeGuard.activity();
  }

  activity(): ProviderRuntimeActivity {
    return this.runtimeGuard.activity();
  }

  async runSettingsConfigMutation<T>(task: () => Promise<T>): Promise<T> {
    const lease = await this.runtimeGuard.acquire(new AbortController().signal);
    try {
      lease.assertHeldSynchronously?.();
      const result = await task();
      lease.assertHeldSynchronously?.();
      return result;
    } finally {
      await lease.release();
    }
  }

  readCachedModels(): readonly ModelInfo[] {
    const models = [...this.#cachedSettingsModels.values()];
    const route = this.#desiredSessionRoute(this.stateStore.read());
    if (route?.resolutionState === "resolved"
      && route.canonicalModelId
      && !models.some((model) =>
        model.id === route.requestedModelId || model.canonicalSlug === route.canonicalModelId)) {
      models.push(cachedModelInfoFromRoute(route));
    }
    return deepFreezeSettingsProjection(
      projectSettingsModelInfos(models).map((model) => structuredClone(model)),
    );
  }

  /**
   * Exact Settings catalogue for the current backend/account owner. Kimi uses
   * its pinned membership catalogue; OpenRouter entries are admitted only
   * after a catalogue call completed under this exact route.
   */
  readCachedSettingsModels(): readonly ModelInfo[] {
    const route = this.#desiredSessionRoute(this.stateStore.read());
    if (!route || route.resolutionState !== "resolved" || !route.canonicalModelId) return [];
    const models = route.backendId === "kimi-code"
      ? KIMI_CODE_MODELS.flatMap((candidate) => {
          const model = kimiDashboardModelInfo(candidate.id);
          return model ? [model] : [];
        })
      : route.backendId === "openrouter"
        ? [...this.#providerOwnedSettingsModels.values()]
            .filter((entry) => sameRouteOwner(entry.route, route))
            .map((entry) => entry.model)
        : [];
    if (!models.some((model) =>
      model.id === route.requestedModelId || model.canonicalSlug === route.canonicalModelId)) {
      models.push(cachedModelInfoFromRoute(route));
    }
    return deepFreezeSettingsProjection(
      projectSettingsModelInfos(models).map((model) => structuredClone(model)),
    );
  }

  readCachedProviderStatus(): readonly ProviderCommandStatusEntry[] {
    const status = this.#providerStatus();
    return status.kind === "status" ? status.providers : [];
  }

  readCachedSettingsRoute(): SettingsRouteProjection | null {
    const route = this.#desiredSessionRoute(this.stateStore.read());
    if (!route || route.resolutionState !== "resolved" || !route.canonicalModelId
      || (route.backendId !== "openrouter" && route.backendId !== "kimi-code"
        && route.backendId !== "anthropic")) return null;
    const modelLabel = route.backendId === "kimi-code"
      ? KIMI_CODE_MODELS.find((model) => model.id === route.canonicalModelId)?.displayName
        ?? route.canonicalModelId
      : route.canonicalModelId;
    return {
      backendId: route.backendId,
      providerLabel: providerDisplayName(route.backendId),
      requestedModelId: route.requestedModelId,
      canonicalModelId: route.canonicalModelId,
      modelLabel,
      billingRealm: route.backendId === "openrouter"
        ? "openrouter-payg"
        : route.backendId === "kimi-code"
          ? "kimi-code-membership-provider-managed-overage"
          : "none",
    };
  }

  readCachedSettingsProjection(): {
    readonly route: SettingsRouteProjection | null;
    readonly providers: readonly SettingsProviderProjection[];
  } {
    const state = this.stateStore.read();
    const route = this.#sessionRoute ?? state.defaultRoute;
    const projectedRoute = route && (route.backendId === "openrouter" || route.backendId === "kimi-code")
      && route.canonicalModelId
      && (route.billingRealm === "openrouter-payg" || route.billingRealm === "kimi-code-membership-provider-managed-overage") ? {
      backendId: route.backendId,
      providerLabel: route.backendId === "kimi-code" ? "Kimi Code" : "OpenRouter",
      requestedModelId: route.requestedModelId,
      canonicalModelId: route.canonicalModelId,
      modelLabel: route.requestedModelId,
      billingRealm: route.billingRealm,
    } satisfies SettingsRouteProjection : null;
    const providers: SettingsProviderProjection[] = state.connections
      .filter((connection): connection is typeof connection & { backendId: "openrouter" | "kimi-code" } =>
        connection.backendId === "openrouter" || connection.backendId === "kimi-code")
      .filter((connection): connection is typeof connection & { billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage" } =>
        connection.billingRealm === "openrouter-payg" || connection.billingRealm === "kimi-code-membership-provider-managed-overage")
      .map((connection) => ({
      backendId: connection.backendId,
      displayName: connection.backendId === "kimi-code" ? "Kimi Code" : "OpenRouter",
      availability: "connectable",
      configuration: connection.enabled ? "enabled" : "disabled",
      maturity: connection.maturity,
      billingRealm: connection.billingRealm,
      headline: connection.lastHealth?.credential === "valid" ? "ready" : "unknown",
      health: connection.lastHealth ? {
        credential: connection.lastHealth.credential,
        connectivity: connection.lastHealth.connectivity,
        spend: connection.lastHealth.spend,
        runtime: connection.lastHealth.runtime,
      } : null,
      isDefault: state.defaultRoute?.backendId === connection.backendId
        && state.defaultRoute.accountFingerprint === connection.accountFingerprint,
      selectedModel: null,
      allowedActions: providerBackendActions(connection.backendId),
    }));
    return { route: projectedRoute, providers };
  }

  modelRuntime(route: RouteIdentityV1): ModelRuntime {
    if ((route as Partial<RouteIdentityV1> | null | undefined)?.backendId === "kimi-code") {
      this.#assertKimiOwnerMode();
    }
    const validated = validateRouteIdentityV1(route);
    if (
      !validated
      || validated.resolutionState !== "resolved"
      || !validated.canonicalModelId
    ) throw new ProviderSetupRequiredError();
    const state = this.stateStore.read();
    const selected = selectProviderBinding(state, { kind: "route", route: validated });
    if (
      selected.kind !== "exact"
      || selected.binding.stateRevision !== state.revision
      || selected.binding.backendId !== validated.backendId
      || selected.binding.accountFingerprint !== validated.accountFingerprint
      || selected.binding.billingRealm !== validated.billingRealm
    ) throw new ProviderSetupRequiredError();
    const connection = state.connections.find((candidate) =>
      candidate.id === selected.binding.connectionId,
    );
    if (validated.backendId === "openrouter") {
      const key = JSON.stringify({
        backendId: "openrouter",
        stateRevision: state.revision,
        connectionId: selected.binding.connectionId,
        route: validated,
        mainModel: this.config.mainModel,
        fallbackModels: this.config.fallbackModels,
        provider: this.config.provider,
      });
      if (this.#modelRuntimeCache?.key === key) return this.#modelRuntimeCache.runtime;
      const observedGeneration = connection?.lastHealth?.generation;
      const runtime = bindModelRuntimeIdentity(
        createOpenRouterModelRuntime(this.openRouter, this.config, validated),
        {
          version: 1,
          stateRevision: state.revision,
          generation: Number.isSafeInteger(observedGeneration) && (observedGeneration ?? -1) >= 0
            ? observedGeneration as number
            : state.revision,
          connectionId: selected.binding.connectionId,
          backendId: "openrouter",
          route: validated,
        },
      );
      this.#modelRuntimeCache = { key, runtime };
      return runtime;
    }
    if (validated.backendId !== "kimi-code") throw new ProviderSetupRequiredError();
    if (
      validated.requestedModelId !== validated.canonicalModelId
      || !KIMI_CODE_MODELS.some((model) => model.id === validated.requestedModelId)
    ) throw new ProviderSetupRequiredError();
    const health = connection?.lastHealth;
    if (
      !connection
      || !connection.enabled
      || connection.backendId !== "kimi-code"
      || connection.accountFingerprint !== validated.accountFingerprint
      || connection.billingRealm !== "kimi-code-membership-provider-managed-overage"
      || !health
      || !Number.isSafeInteger(health.generation)
      || health.generation < 0
      || health.credential !== "valid"
      || health.connectivity !== "connected"
      || health.spend === "limit-reached"
      || health.runtime !== "not-applicable"
    ) throw new ProviderSetupRequiredError();
    const key = JSON.stringify({
      backendId: "kimi-code",
      stateRevision: state.revision,
      generation: health.generation,
      connectionId: connection.id,
      route: validated,
    });
    if (this.#modelRuntimeCache?.key === key) return this.#modelRuntimeCache.runtime;
    const runtime = bindModelRuntimeIdentity(
      createKimiCodeModelRuntime({
        route: validated,
        binding: Object.freeze({
          version: 1,
          stateRevision: state.revision,
          generation: health.generation,
          connectionId: connection.id,
          backendId: "kimi-code",
          accountFingerprint: connection.accountFingerprint,
          billingRealm: "kimi-code-membership-provider-managed-overage",
          canonicalModelId: validated.canonicalModelId as (typeof KIMI_CODE_MODELS)[number]["id"],
        }),
        credentialAuthority: this.authorityOptions?.credentialAuthority
          ?? (() => { throw new ProviderSetupRequiredError(); })(),
        fetch: (request, init) => globalThis.fetch(request, init),
        now: Date.now,
        createRequestDeadlineAt: () => Date.now() + 300_000,
      }),
      {
        version: 1,
        stateRevision: state.revision,
        generation: health.generation,
        connectionId: connection.id,
        backendId: "kimi-code",
        route: validated,
      },
    );
    this.#modelRuntimeCache = { key, runtime };
    return runtime;
  }

  #assertKimiOwnerMode(): void {
    if (this.executionMode !== "local-interactive-owner") {
      throw new KimiOwnerInteractiveRequiredError();
    }
  }

  #assertDesiredKimiPolicy(): void {
    if (this.executionMode === "local-interactive-owner") return;
    const state = this.stateStore.read();
    const sessionRoute = validateRouteIdentityV1(this.session?.data?.route);
    if (
      this.#sessionRoute?.backendId === "kimi-code"
      || sessionRoute?.backendId === "kimi-code"
      || state.defaultRoute?.backendId === "kimi-code"
    ) this.#assertKimiOwnerMode();
  }

  #adoptExactSessionRoute(
    route: RouteIdentityV1,
    persisted: boolean,
    synchronizeSession = true,
    forceGeneration = false,
    synchronizeConfig = true,
  ): void {
    const validated = validateRouteIdentityV1(route);
    if (
      !validated
      || validated.resolutionState !== "resolved"
      || !validated.canonicalModelId
    ) {
      throw new ProviderSetupRequiredError();
    }
    const hadPendingRoute = this.#pendingSessionBinding !== null;
    if (
      forceGeneration
      || hadPendingRoute
      || !this.#sessionRoute
      || !sameExactRoute(this.#sessionRoute, validated)
      || this.#sessionRoutePersisted !== persisted
    ) {
      this.#processRouteGeneration += 1;
    }
    this.#sessionRoute = structuredClone(validated);
    this.#sessionRoutePersisted = persisted;
    this.#pendingSessionBinding = null;
    this.#preparedRoles = null;
    if (synchronizeConfig) this.config.mainModel = validated.requestedModelId;
    if (synchronizeSession && this.session) {
      this.session.setPreferences(
        validated.requestedModelId,
        this.session.data.reasoning ?? getReasoningSetting(this.config),
        validated,
      );
    }
  }

  adoptCredentialActivation(
    route: RouteIdentityV1,
    persisted: boolean,
    secret: string,
  ): void {
    this.#adoptExactSessionRoute(route, persisted, true, true);
    this.environmentSecret = persisted ? null : secret;
    if (persisted) {
      this.#synchronizeAuthoritativeProviderState();
    }
  }

  adoptCredentialForget(): void {
    this.#processRouteGeneration += 1;
    this.#sessionRoute = null;
    this.#sessionRoutePersisted = false;
    this.#pendingSessionBinding = null;
    this.#preparedRoles = null;
    this.environmentSecret = null;
    this.#synchronizeAuthoritativeProviderState();
  }

  async inspectStartup(): Promise<StartupSetupResult> {
    this.#assertDesiredKimiPolicy();
    const generation = typeof this.orchestrator.nextStartupGeneration === "function"
      ? this.orchestrator.nextStartupGeneration()
      : ++this.#startupAttemptGeneration;
    let recoveredSessionRouteCleared = false;
    const startup = await runProviderStartupAttempt({
      generation,
      recover: (context) => this.authorityOptions?.recover(context) ?? Promise.resolve(),
      inspect: async (context) => {
        recoveredSessionRouteCleared = this.session?.data.routeCleared === true;
        if (recoveredSessionRouteCleared) {
          // Recovery still runs, but an intentionally detached chat performs
          // no provider inspection until its owner explicitly enters setup.
          this.#synchronizeAuthoritativeProviderState();
          return {
            mode: "setup-required",
            generation: context.generation,
            defaultRoute: null,
            readyRoutes: [],
            warnings: [],
            crossEnabled: false,
          };
        }
        const result = await this.orchestrator.inspectStartup({
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        });
        context.assertCurrent();
        if (result.generation !== context.generation) {
          throw new Error("Provider startup generation was superseded.");
        }
        this.#synchronizeAuthoritativeProviderState();
        return result;
      },
      resolveLegacy: async (result, context) => {
        if (result.defaultRoute?.resolutionState !== "legacy-unverified") return result;
        const resolved = await this.orchestrator.resolveLegacyDefaultRoute({
          signal: context.signal,
          deadlineAt: context.deadlineAt,
          providerTimeoutMs: context.remainingMs(),
        });
        context.assertCurrent();
        if (resolved.generation !== context.generation) {
          throw new Error("Provider startup generation was superseded.");
        }
        this.#synchronizeAuthoritativeProviderState();
        return resolved;
      },
      automaticEnvironment: async (result, context) => {
        if (recoveredSessionRouteCleared) return result;
        if (
          result.mode !== "setup-required"
          && result.mode !== "route-choice-required"
        ) return result;
        if (!this.environmentSecret) return result;
        const automatic = await this.runSetup(
          createAutomaticEnvironmentSetupSurface(this.requestedModel),
          context,
        );
        context.assertCurrent();
        if (automatic.kind !== "ready") return result;
        const route = this.ensureRunnableRoute();
        return {
          mode: "ready",
          generation: result.generation,
          defaultRoute: route,
          readyRoutes: [route],
          warnings: [],
          crossEnabled: false,
        };
      },
      bindRuntime: async (result, context) => {
        if (!this.authorityOptions || !result.defaultRoute) return;
        if (this.session?.data.routeCleared) throw new ProviderSetupRequiredError();
        if (
          this.#sessionRoute
          && !this.#sessionRoutePersisted
          && sameRoute(this.#sessionRoute, result.defaultRoute)
        ) {
          return;
        }
        const persistedSessionRoute = validateRouteIdentityV1(this.session?.data.route);
        const desiredRoute = persistedSessionRoute?.resolutionState === "resolved"
          ? persistedSessionRoute
          : result.defaultRoute;
        const provedRoute = this.orchestrator.ensureRunnableRoute(desiredRoute);
        const selected = selectProviderBinding(
          this.stateStore.read(),
          { kind: "route", route: provedRoute },
        );
        if (selected.kind !== "exact") throw new ProviderSetupRequiredError();
        const routeAdapter = this.registry.adapter(provedRoute.backendId);
        if (
          persistedSessionRoute?.resolutionState === "resolved"
          && !sameExactRoute(persistedSessionRoute, result.defaultRoute)
        ) {
          const models = await routeAdapter.listModels({
            connectionId: selected.binding.connectionId,
            signal: context.signal,
          });
          context.assertCurrent();
          const exact = models.filter((model) =>
            model.backendId === provedRoute.backendId
            && model.requestedModelId === provedRoute.requestedModelId
            && model.canonicalModelId === provedRoute.canonicalModelId
            && model.capabilities.textInput
            && model.capabilities.textOutput
          );
          if (exact.length !== 1) throw new ProviderSetupRequiredError();
        }
        if (provedRoute.backendId === "kimi-code") {
          this.modelRuntime(provedRoute);
        } else {
          if (!routeAdapter.bindRuntime) throw new ProviderSetupRequiredError();
          await routeAdapter.bindRuntime({
            connectionId: selected.binding.connectionId,
            generation: result.generation,
            deadlineAt: context.deadlineAt,
            signal: context.signal,
          });
        }
        context.assertCurrent();
        this.#adoptExactSessionRoute(provedRoute, true);
      },
    });
    if (
      !this.authorityOptions
      && (startup.mode === "ready" || startup.mode === "ready-with-warning")
      && startup.defaultRoute?.resolutionState === "resolved"
    ) {
      this.#adoptExactSessionRoute(startup.defaultRoute, true);
    }
    return startup;
  }

  async resolveLegacyDefaultRoute(): Promise<StartupSetupResult> {
    const result = await this.orchestrator.resolveLegacyDefaultRoute();
    this.#synchronizeAuthoritativeProviderState();
    return result;
  }

  async runSetup(
    surface: SetupSurface | "plain" | "fullscreen",
    startupAttempt?: ProviderStartupStepContext,
    initialBackendId?: "openrouter" | "kimi-code",
  ): Promise<SetupHubResult> {
    if (surface === "fullscreen") {
      throw new ProviderSetupRequiredError();
    }
    const resolvedSurface = surface === "plain"
      ? createCliPlainSetupSurface()
      : surface;
    const routePublicationGeneration = this.#processRouteGeneration;
    const setupPublicationGeneration = ++this.#setupPublicationGeneration;
    const setupPublicationOwnerIsCurrent = (): boolean => (
      this.#setupPublicationGeneration === setupPublicationGeneration
      && this.#processRouteGeneration === routePublicationGeneration
    );
    const setupAttemptIsCurrent = (): boolean => {
      if (
        !setupPublicationOwnerIsCurrent()
        || startupAttempt?.signal.aborted
      ) return false;
      if (!startupAttempt) return true;
      try {
        if (startupAttempt.remainingMs() <= 0) return false;
        startupAttempt.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };
    let activatedRoute: RouteIdentityV1 | null = null;
    let activatedPersisted = false;
    let activationSettledAfterInterruption = false;
    let cancellationCommitted = false;
    const setupOrchestrator = {
      nextStartupGeneration: () => this.orchestrator.nextStartupGeneration(),
      activateCandidate: async (
        request: Parameters<SetupOrchestrator["activateCandidate"]>[0],
      ) => {
        const result = await this.orchestrator.activateCandidate(request);
        activationSettledAfterInterruption = request.signal.aborted;
        const route = validateRouteIdentityV1(result.route);
        if (route?.resolutionState === "resolved" && route.canonicalModelId) {
          activatedRoute = route;
          activatedPersisted = result.persisted;
        }
        return result;
      },
      cancelSetup: async (
        request: Parameters<SetupOrchestrator["cancelSetup"]>[0],
      ) => {
        const result = await this.orchestrator.cancelSetup(request);
        const cancelled = this.stateStore.read();
        cancellationCommitted = request.expectedRevision !== undefined
          && cancelled.revision === request.expectedRevision + 1
          && cancelled.lifecycle === "cancelled";
        return result;
      },
    } as SetupOrchestrator;
    const manualController = startupAttempt ? null : new AbortController();
    const signal = startupAttempt?.signal ?? manualController!.signal;
    const deadlineAt = startupAttempt?.deadlineAt;
    let manualProviderDeadlineAt: number | undefined;
    const resolveProviderDeadline = (): number => {
      if (deadlineAt !== undefined) return deadlineAt;
      manualProviderDeadlineAt ??= Date.now() + 15_000;
      return manualProviderDeadlineAt;
    };
    const environmentCandidatePermit = this.environmentSecret && this.authorityOptions
      ? this.authorityOptions.credentialAuthority.environmentCandidatePermit?.(
          this.environmentSecret,
        ) ?? null
      : null;
    const preflightCandidate = async (): Promise<boolean> => {
      const preflight = this.authorityOptions?.credentialAuthority.preflightCandidate;
      if (!preflight) return true;
      const result = await preflight.call(
        this.authorityOptions!.credentialAuthority,
        { deadlineAt: resolveProviderDeadline(), signal },
      );
      return result.kind === "ready";
    };
    const guardCandidate = this.authorityOptions?.credentialAuthority.withCandidateAuthority
      ? <T>(
          credentialPermit: Parameters<NonNullable<SetupHubOptions["withCandidateAuthority"]>>[0],
          requireCredentialPermit: boolean,
          use: (lease: ProviderCandidateAuthorityLease) => Promise<T>,
        ): Promise<
          ProviderCandidateAuthorityResult<T>
        > => this.authorityOptions!.credentialAuthority.withCandidateAuthority!(
          {
            deadlineAt: resolveProviderDeadline(),
            signal,
            credentialPermit,
            requireCredentialPermit,
          },
          use,
        )
      : undefined;
    const guardManualKimiCandidate = this.authorityOptions?.credentialAuthority
      .withManualKimiCandidateAuthority
      ? this.authorityOptions.credentialAuthority.withManualKimiCandidateAuthority.bind(
          this.authorityOptions.credentialAuthority,
        )
      : undefined;
    const releaseManualKimiCandidatePermit = this.authorityOptions?.credentialAuthority
      .releaseManualKimiCandidatePermit
      ? this.authorityOptions.credentialAuthority.releaseManualKimiCandidatePermit.bind(
          this.authorityOptions.credentialAuthority,
        )
      : undefined;
    let terminalHub: Promise<SetupHubResult> | null = null;
    const executeHub = (
      savedSecret: string | null,
      targetConnectionId?: string,
      expectedRevision?: number,
      savedCandidatePermit?: Parameters<NonNullable<SetupHubOptions["withCandidateAuthority"]>>[0],
    ) => {
      const pending = runSetupHub({
        surface: resolvedSurface,
        orchestrator: setupOrchestrator,
        registry: this.registry,
        stateStore: this.stateStore,
        executionMode: this.executionMode,
        initialBackendId,
        savedSecret,
        environmentSecret: this.environmentSecret,
        signal,
        deadlineAt,
        resolveProviderDeadline,
        generation: startupAttempt?.generation,
        targetConnectionId,
        expectedRevision,
        savedCandidatePermit,
        environmentCandidatePermit,
        preflightCandidate: this.authorityOptions ? preflightCandidate : undefined,
        withCandidateAuthority: guardCandidate,
        withManualKimiCandidateAuthority: guardManualKimiCandidate,
        releaseManualKimiCandidatePermit,
        isCurrent: setupAttemptIsCurrent,
      });
      terminalHub = pending;
      return pending;
    };
    try {
      const state = this.stateStore.read();
      const persistedSessionRoute = validateRouteIdentityV1(this.session?.data.route);
      const desiredSavedRoute = this.#sessionRoute
        ?? (persistedSessionRoute?.resolutionState === "resolved"
          ? persistedSessionRoute
          : null);
      const savedBinding = desiredSavedRoute
        ? selectOpenRouterBinding(state, { kind: "route", route: desiredSavedRoute })
        : state.defaultRoute
          ? selectOpenRouterBinding(state, { kind: "default" })
          : selectOpenRouterBinding(state, { kind: "backend", backendId: "openrouter" });
      let result: SetupHubResult;
      if (initialBackendId === "kimi-code") {
        result = await executeHub(null);
      } else if (this.authorityOptions && savedBinding.kind === "exact") {
        const access = await this.authorityOptions.credentialAuthority.withCredential(
          {
            backendId: savedBinding.binding.backendId,
            connectionId: savedBinding.binding.connectionId,
            credentialKind: "inference",
            purpose: "explicit-repair",
            environmentEligibility: "forbidden",
            deadlineAt: resolveProviderDeadline(),
            signal,
          },
          (secret, context) => executeHub(
            secret,
            context.binding.connectionId,
            context.binding.stateRevision,
            context.candidatePermit,
          ),
        );
        if (access.kind === "available") {
          result = access.value;
        } else if (providerAuthorityBlocksSetup(access.kind)) {
          result = { kind: "cancelled", mode: "setup-required" };
        } else {
          result = await executeHub(null);
        }
      } else {
        result = this.authorityOptions && startupAttempt && !await preflightCandidate()
          ? { kind: "cancelled", mode: "setup-required" }
          : await executeHub(null);
      }
      if (result.kind === "ready") {
        const attemptIsCurrent = setupAttemptIsCurrent();
        const currentDefaultRoute = validateRouteIdentityV1(this.stateStore.read().defaultRoute);
        const activationCanPublish = activatedRoute !== null
          && (!activatedPersisted
            || (currentDefaultRoute !== null && sameExactRoute(currentDefaultRoute, activatedRoute)));
        const reconcileCommittedActivation = activationCanPublish
          && activationSettledAfterInterruption
          && setupPublicationOwnerIsCurrent();
        if (attemptIsCurrent || reconcileCommittedActivation) {
          const preparedRolesCanPublish = attemptIsCurrent
            && (activatedRoute === null || activationCanPublish);
          const nextSessionRoute = activationCanPublish
            ? activatedRoute
            : preparedRolesCanPublish
              ? result.preparedRoles?.lead ?? this.#sessionRoute
              : this.#sessionRoute;
          if (nextSessionRoute) {
            this.#adoptExactSessionRoute(
              nextSessionRoute,
              activationCanPublish ? activatedPersisted : this.#sessionRoutePersisted,
              true,
              activationCanPublish,
            );
          }
          this.#preparedRoles = preparedRolesCanPublish && result.preparedRoles
            ? structuredClone(result.preparedRoles)
            : null;
        }
      }
      this.#synchronizeAuthoritativeProviderState();
      return result;
    } catch (error) {
      if (signal.aborted && terminalHub !== null) {
        try {
          await terminalHub;
        } catch (terminalError) {
          this.#synchronizeAuthoritativeProviderState();
          if (!cancellationCommitted) throw terminalError;
        }
      }
      this.#synchronizeAuthoritativeProviderState();
      if (signal.aborted && cancellationCommitted) {
        return { kind: "cancelled", mode: "setup-required" };
      }
      throw error;
    } finally {
      if (manualController && !manualController.signal.aborted) {
        manualController.abort(new DOMException("The setup attempt settled.", "AbortError"));
      }
    }
  }

  migratedSessionConnection(): ProviderConnectionStateV1 | undefined {
    return migratedOpenRouterSessionConnection(this.stateStore.read());
  }

  #synchronizeAuthoritativeProviderState(): void {
    const state = requirePersistableProviderState(this.stateStore.read());
    this.config.providerSetup = state;
    this.session?.rebindPendingLegacyRoute(
      migratedOpenRouterSessionConnection(state),
    );
  }

  currentSessionRoute(): RouteIdentityV1 {
    return this.ensureRunnableRoute();
  }

  readModelPreferenceAuthority(): ModelPreferenceAuthoritySnapshot {
    const state = this.stateStore.read();
    const route = validateRouteIdentityV1(state.defaultRoute);
    if (!route || route.resolutionState !== "resolved" || !route.canonicalModelId) {
      return Object.freeze({ route: null, providerRevision: state.revision, connectionId: null });
    }
    const selected = selectProviderBinding(state, { kind: "route", route });
    if (selected.kind !== "exact") {
      return Object.freeze({
        route: structuredClone(route),
        providerRevision: state.revision,
        connectionId: null,
      });
    }
    return Object.freeze({
      route: structuredClone(route),
      providerRevision: state.revision,
      connectionId: selected.binding.connectionId,
    });
  }

  prepareSettingsModelPublication(route: RouteIdentityV1): { publish(): void } {
    const next = validateRouteIdentityV1(route);
    const current = this.ensureRunnableRoute();
    if (!next || next.resolutionState !== "resolved" || !next.canonicalModelId
      || next.backendId !== current.backendId
      || next.accountFingerprint !== current.accountFingerprint
      || next.billingRealm !== current.billingRealm) {
      throw new ProviderSetupRequiredError();
    }
    const exact = structuredClone(next);
    let published = false;
    return Object.freeze({
      publish: () => {
        if (published) return;
        published = true;
        this.#sessionRoute = exact;
        this.#sessionRoutePersisted = true;
        this.#pendingSessionBinding = null;
        this.#preparedRoles = null;
        this.#modelRuntimeCache = null;
      },
    });
  }

  adoptSession(session: SessionStore): void {
    const requestedRoute = validateRouteIdentityV1(session.data.route);
    if (session.data.routeCleared) {
      // Explicitly detached historical chats are setup-required. Adopt the
      // owner, but never inherit the previous chat or provider default route.
      this.#processRouteGeneration += 1;
      this.#sessionRoute = null;
      this.#sessionRoutePersisted = false;
      this.#pendingSessionBinding = null;
      this.#preparedRoles = null;
      this.session = session;
      this.#synchronizeAuthoritativeProviderState();
      return;
    }
    const pending = this.#pendingSessionBinding;
    if (pending) {
      if (
        !pending.ready
        || pending.generation !== this.#processRouteGeneration
        || requestedRoute?.resolutionState !== "resolved"
        || !requestedRoute.canonicalModelId
        || !sameExactRoute(requestedRoute, pending.route)
      ) {
        throw new ProviderSetupRequiredError();
      }
      const selected = selectProviderBinding(
        this.stateStore.read(),
        { kind: "route", route: pending.route },
      );
      if (
        selected.kind !== "exact"
        || selected.binding.connectionId !== pending.connectionId
      ) {
        throw new ProviderSetupRequiredError();
      }
      this.session = session;
      this.#synchronizeAuthoritativeProviderState();
      this.#adoptExactSessionRoute(requestedRoute, true);
      return;
    }

    let route: RouteIdentityV1;
    try {
      route = this.ensureRunnableRoute();
    } catch (error) {
      if (!isProviderSetupRequired(error) || requestedRoute?.resolutionState === "resolved") {
        throw error;
      }
      // A new/unresolved chat may own a setup-required runtime. It cannot run
      // model bytes until setup publishes an exact route for this owner.
      this.session = session;
      return;
    }
    if (
      requestedRoute?.resolutionState === "resolved"
      && !sameExactRoute(requestedRoute, route)
    ) {
      throw new ProviderSetupRequiredError();
    }
    this.session = session;
    session.setPreferences(
      route.requestedModelId,
      session.data.reasoning ?? getReasoningSetting(this.config),
      route,
    );
  }

  async selectSessionRoute(
    route: RouteIdentityV1,
    _surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1> {
    const validated = validateRouteIdentityV1(route);
    if (
      !validated
      || validated.resolutionState !== "resolved"
      || !validated.canonicalModelId
    ) {
      throw new ProviderSetupRequiredError();
    }
    if (validated.backendId === "kimi-code") this.#assertKimiOwnerMode();
    const initial = selectProviderBinding(
      this.stateStore.read(),
      { kind: "route", route: validated },
    );
    if (initial.kind !== "exact") throw new ProviderSetupRequiredError();
    if (
      this.#sessionRoute
      && this.#sessionRoutePersisted
      && sameExactRoute(this.#sessionRoute, validated)
    ) {
      return structuredClone(validated);
    }

    const controller = new AbortController();
    const runtimeLease = await this.runtimeGuard.acquire(controller.signal);
    let primaryFailed = false;
    try {
      await runtimeLease.assertHeld();
      const result = await this.orchestrator.reconnect(validated.backendId, {
        connectionId: initial.binding.connectionId,
        signal: controller.signal,
      });
      await runtimeLease.assertHeld();
      const proved = this.orchestrator.ensureRunnableRoute(validated);
      if (!sameExactRoute(proved, validated)) throw new ProviderSetupRequiredError();
      const current = selectProviderBinding(
        this.stateStore.read(),
        { kind: "route", route: proved },
      );
      if (
        current.kind !== "exact"
        || current.binding.connectionId !== initial.binding.connectionId
      ) {
        throw new ProviderSetupRequiredError();
      }
      const adapter = this.registry.adapter(validated.backendId);
      const models = await adapter.listModels({
        connectionId: current.binding.connectionId,
        signal: controller.signal,
      });
      await runtimeLease.assertHeld();
      const exact = models.filter((model) =>
        model.backendId === validated.backendId
        && model.requestedModelId === validated.requestedModelId
        && model.canonicalModelId === validated.canonicalModelId
        && model.capabilities.textInput
        && model.capabilities.textOutput
      );
      if (exact.length !== 1 || (validated.backendId === "openrouter" && !adapter.bindRuntime)) {
        throw new ProviderSetupRequiredError();
      }
      this.#processRouteGeneration += 1;
      const pendingGeneration = this.#processRouteGeneration;
      this.#pendingSessionBinding = {
        route: structuredClone(proved),
        connectionId: current.binding.connectionId,
        generation: pendingGeneration,
        ready: false,
      };
      if (validated.backendId === "kimi-code") {
        this.modelRuntime(proved);
      } else {
        await adapter.bindRuntime!({
          connectionId: current.binding.connectionId,
          generation: result.generation,
          deadlineAt: Date.now() + 5_000,
          signal: controller.signal,
        });
      }
      await runtimeLease.assertHeld();
      const rebound = selectProviderBinding(
        this.stateStore.read(),
        { kind: "route", route: proved },
      );
      const pending = this.#pendingSessionBinding;
      if (
        this.#processRouteGeneration !== pendingGeneration
        || !pending
        || pending.generation !== pendingGeneration
        || pending.connectionId !== current.binding.connectionId
        || !sameExactRoute(pending.route, proved)
        || pending.ready
        || rebound.kind !== "exact"
        || rebound.binding.connectionId !== current.binding.connectionId
      ) {
        throw new ProviderSetupRequiredError();
      }
      pending.ready = true;
      return structuredClone(proved);
    } catch (error) {
      primaryFailed = true;
      if (error instanceof ProviderSetupRequiredError) throw error;
      throw new ProviderSetupRequiredError();
    } finally {
      try {
        await Promise.resolve(runtimeLease.release());
      } catch (error) {
        if (!primaryFailed) throw error;
      }
    }
  }

  ensureRunnableRoute(): RouteIdentityV1 {
    this.#assertDesiredKimiPolicy();
    if (this.#pendingSessionBinding) throw new ProviderSetupRequiredError();
    if (this.session?.data.routeCleared) throw new ProviderSetupRequiredError();
    const requiredSessionRoute = validateRouteIdentityV1(this.session?.data.route);
    if (
      requiredSessionRoute?.resolutionState === "resolved"
      && !this.#sessionRoute
    ) {
      throw new ProviderSetupRequiredError();
    }
    if (this.#sessionRoute) {
      if (
        requiredSessionRoute?.resolutionState === "resolved"
        && !sameExactRoute(requiredSessionRoute, this.#sessionRoute)
      ) {
        throw new ProviderSetupRequiredError();
      }
      if (!this.#sessionRoutePersisted) {
        return structuredClone(this.#sessionRoute);
      }
      const state = this.stateStore.read();
      const selected = selectProviderBinding(
        state,
        { kind: "route", route: this.#sessionRoute },
      );
      if (
        selected.kind === "exact"
        && this.#sessionRoute.resolutionState === "resolved"
        && this.#sessionRoute.canonicalModelId
      ) {
        return structuredClone(this.#sessionRoute);
      }
      this.#sessionRoute = null;
      this.#sessionRoutePersisted = false;
      this.#processRouteGeneration += 1;
      if (requiredSessionRoute?.resolutionState === "resolved") {
        throw new ProviderSetupRequiredError();
      }
    }
    return this.orchestrator.ensureRunnableRoute();
  }

  async runModelCatalog<T>(
    run: () => Promise<T>,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<T> {
    let owner: RouteIdentityV1 | null = null;
    const result = await this.runWithReadyRoute(async (route) => {
      owner = structuredClone(route);
      return run();
    }, surface);
    this.#rememberCachedModels(result, owner);
    return result;
  }

  #rememberCachedModels(value: unknown, owner: RouteIdentityV1 | null): void {
    if (!Array.isArray(value) || !owner) return;
    for (const candidate of value) {
      const model = projectSettingsModelInfo(candidate as ModelInfo);
      if (!model) continue;
      const projected = deepFreezeSettingsProjection(model);
      this.#cachedSettingsModels.set(model.id, projected);
      this.#providerOwnedSettingsModels.set(
        `${owner.backendId}\u0000${owner.accountFingerprint}\u0000${owner.billingRealm}\u0000${model.id}`,
        Object.freeze({ route: structuredClone(owner), model: projected }),
      );
    }
  }

  async transitionModel(
    modelId: string,
    canonicalModelId?: string,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<void> {
    await this.#transitionModel(modelId, canonicalModelId, surface);
  }

  async transitionSessionModel(
    candidate: {
      readonly requestedModelId: string;
      readonly canonicalModelId: string;
    },
    publication: ProviderPreferenceCommitPort,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1> {
    const attemptedBackend = this.ensureRunnableRoute().backendId;
    if (attemptedBackend !== "openrouter" && attemptedBackend !== "kimi-code") {
      throw new ProviderSetupRequiredError();
    }
    try {
      return await this.#transitionModel(
        candidate.requestedModelId,
        candidate.canonicalModelId,
        surface,
        publication,
      );
    } catch (failure) {
      await recoverProviderAuthenticationFailure({
        failure,
        isAuthenticationFailure: (error) => this.#isAuthenticationFailure(attemptedBackend, error),
        invalidateAndInspect: () => this.#invalidateAuthenticationFailure(attemptedBackend),
        runSetup: (requestedSurface) => this.runSetup(requestedSurface),
        surface,
      });
      throw failure;
    }
  }

  async #transitionModel(
    modelId: string,
    canonicalModelId?: string,
    surface?: SetupSurface | "plain" | "fullscreen",
    preferencePublication?: ProviderPreferenceCommitPort,
  ): Promise<RouteIdentityV1> {
    const current = this.ensureRunnableRoute();
    if (current.backendId === "kimi-code") {
      return this.#transitionKimiModel(
        current,
        modelId,
        canonicalModelId,
        preferencePublication,
      );
    }
    const resolved = canonicalModelId === undefined
      ? await this.runModelCatalog(
          () => resolveMainModelCandidate(this.openRouter, modelId),
          surface,
        )
      : null;
    const selectedCanonicalModelId = canonicalModelId
      ?? resolved?.canonicalSlug
      ?? resolved?.id
      ?? modelId;
    if (
      current.requestedModelId === modelId
      && current.canonicalModelId === selectedCanonicalModelId
    ) {
      return structuredClone(current);
    }

    const state = this.stateStore.read();
    const persistedBinding = selectOpenRouterBinding(
      state,
      { kind: "route", route: current },
    );
    const currentIsPersisted = Boolean(
      persistedBinding.kind === "exact"
      && state.defaultRoute
      && sameRoute(state.defaultRoute, current)
      && state.defaultRoute.requestedModelId === current.requestedModelId
    );
    const persistence = this.#sessionRoute
      ? (this.#sessionRoutePersisted ? "persisted" : "process-only")
      : (currentIsPersisted ? "persisted" : "process-only");
    const effectAttempt = createProviderEffectAttempt();
    let terminalActivation: Promise<RouteIdentityV1> | null = null;
    const activateExactCandidate = async (
      candidate: string,
      expectedRevision: number,
      targetConnectionId?: string,
      candidatePermit?: ProviderCandidateCredentialPermit,
    ): Promise<RouteIdentityV1> => {
      if (terminalActivation) throw new ProviderSetupRequiredError();
      terminalActivation = (async () => {
        const result = await this.orchestrator.activateCandidate({
          backendId: "openrouter",
          expectedRevision,
          candidate,
          expectedRequestedModelId: modelId,
          selectedCanonicalModelId,
          signal: effectAttempt.signal,
          deadlineAt: effectAttempt.deadlineAt,
          persistence,
          candidatePermit,
          requireCandidatePermit: candidatePermit !== undefined,
          ...(preferencePublication
            ? { persistBeforeProviderConfigCommit: preferencePublication }
            : {}),
          ...(targetConnectionId ? { targetConnectionId } : {}),
        });
        const route = validateRouteIdentityV1(result.route);
        if (
          !route
          || route.resolutionState !== "resolved"
          || route.requestedModelId !== modelId
          || route.canonicalModelId !== selectedCanonicalModelId
          || route.backendId !== current.backendId
          || route.accountFingerprint !== current.accountFingerprint
          || route.billingRealm !== current.billingRealm
        ) {
          throw new ProviderSetupRequiredError();
        }
        if (preferencePublication) {
          if (!result.persisted) throw new ProviderSetupRequiredError();
        } else {
          this.adoptCredentialActivation(route, result.persisted, candidate);
        }
        return structuredClone(route);
      })();
      return terminalActivation;
    };

    try {
      if (persistence === "persisted") {
        if (persistedBinding.kind !== "exact" || !this.authorityOptions) {
          throw new ProviderSetupRequiredError();
        }
        const access = await this.authorityOptions.credentialAuthority.withCredential(
          {
            backendId: persistedBinding.binding.backendId,
            connectionId: persistedBinding.binding.connectionId,
            credentialKind: "inference",
            purpose: "explicit-repair",
            environmentEligibility: "forbidden",
            deadlineAt: effectAttempt.deadlineAt,
            signal: effectAttempt.signal,
          },
          async (candidate, context) => {
            if (
              context.binding.stateRevision !== state.revision
              || context.binding.connectionId !== persistedBinding.binding.connectionId
              || context.binding.accountFingerprint !== current.accountFingerprint
              || context.binding.billingRealm !== current.billingRealm
            ) {
              throw new ProviderSetupRequiredError();
            }
            await activateExactCandidate(
              candidate,
              context.binding.stateRevision,
              context.binding.connectionId,
              context.candidatePermit,
            );
          },
        );
        if (access.kind === "available" && terminalActivation) return await terminalActivation;
        if (terminalActivation) return await terminalActivation;
        throw new ProviderSetupRequiredError();
      }

      return await activateExactCandidate(this.openRouter.requireKey(), state.revision);
    } catch (error) {
      if (terminalActivation) return await terminalActivation;
      throw error;
    } finally {
      effectAttempt.close();
    }
  }

  async #transitionKimiModel(
    current: RouteIdentityV1,
    modelId: string,
    canonicalModelId?: string,
    preferencePublication?: ProviderPreferenceCommitPort,
  ): Promise<RouteIdentityV1> {
    this.#assertKimiOwnerMode();
    const selectedCanonicalModelId = canonicalModelId ?? modelId;
    if (
      selectedCanonicalModelId !== modelId
      || !KIMI_CODE_MODELS.some((model) => model.id === modelId)
    ) throw new ProviderSetupRequiredError();
    if (
      current.requestedModelId === modelId
      && current.canonicalModelId === selectedCanonicalModelId
    ) return structuredClone(current);
    if (preferencePublication) {
      return this.#transitionKimiModelWithPreference(
        current,
        modelId,
        selectedCanonicalModelId,
        preferencePublication,
      );
    }
    const adapter = this.authorityOptions?.kimiAdapter;
    if (!adapter) throw new ProviderSetupRequiredError();
    const controller = new AbortController();
    const deadlineAt = Date.now() + 15_000;
    let committedTuple: { state: ProviderSetupStateV2; route: RouteIdentityV1 } | null = null;
    let committedAdopted = false;
    const adoptCommittedTuple = (): boolean => {
      const tuple = committedTuple;
      if (!tuple) return false;
      if (committedAdopted) return true;
      this.config.providerSetup = requirePersistableProviderState(tuple.state);
      this.modelRuntime(tuple.route);
      this.#adoptExactSessionRoute(tuple.route, true, true, true, true);
      committedAdopted = true;
      return true;
    };
    try {
      await this.activationCoordinator.runExclusive(
        { signal: controller.signal, inspectCommitted: false },
        async (lease) => {
          try {
            await lease.assertHeld();
            const state = this.stateStore.read();
            const selected = selectProviderBinding(state, { kind: "route", route: current });
            if (selected.kind !== "exact" || selected.binding.backendId !== "kimi-code") {
              throw new ProviderSetupRequiredError();
            }
            const connection = state.connections.find((candidate) =>
              candidate.id === selected.binding.connectionId,
            );
            if (!connection) throw new ProviderSetupRequiredError();
            const generation = Math.max(
              state.revision,
              connection.lastHealth?.generation ?? 0,
            ) + 1;
            const inspection = await adapter.inspectUnderAuthorityLease({
              connectionId: connection.id,
              generation,
              deadlineAt,
              signal: controller.signal,
              purpose: "runtime-bind",
              environmentEligibility: "forbidden",
            }, lease);
            await lease.assertHeld();
            if (
              !inspection.routeEligible
              || inspection.accountFingerprint !== connection.accountFingerprint
              || inspection.billingRealm !== connection.billingRealm
            ) throw new ProviderSetupRequiredError();
            const models = await adapter.listModels({
              connectionId: connection.id,
              signal: controller.signal,
            });
            await lease.assertHeld();
            const exact = models.filter((model) =>
              model.backendId === "kimi-code"
              && model.requestedModelId === modelId
              && model.canonicalModelId === selectedCanonicalModelId
              && model.capabilities.textInput
              && model.capabilities.textOutput
              && model.capabilities.tools,
            );
            if (exact.length !== 1) throw new ProviderSetupRequiredError();
            const route: RouteIdentityV1 = {
              version: 1,
              backendId: "kimi-code",
              accountFingerprint: connection.accountFingerprint,
              billingRealm: "kimi-code-membership-provider-managed-overage",
              requestedModelId: modelId,
              canonicalModelId: selectedCanonicalModelId,
              resolutionState: "resolved",
            };
            const expectedCommittedState: ProviderSetupStateV2 = {
              ...state,
              revision: state.revision + 1,
              lifecycle: "configured",
              connections: state.connections.map((candidate) =>
                candidate.id === connection.id
                  ? { ...candidate, lastHealth: structuredClone(inspection.health) }
                  : candidate,
              ),
              defaultRoute: route,
              cross: { enabled: false, preferredLead: null, preferredChallenger: null },
            };
            let committed: ProviderSetupStateV2;
            try {
              committed = await this.stateStore.commit(state.revision, (authoritative) => {
                const binding = selectProviderBinding(authoritative, {
                  kind: "connection",
                  connectionId: connection.id,
                });
                if (
                  binding.kind !== "exact"
                  || binding.binding.backendId !== "kimi-code"
                  || binding.binding.accountFingerprint !== current.accountFingerprint
                  || binding.binding.billingRealm !== current.billingRealm
                ) throw new ProviderSetupRequiredError();
                return {
                  ...authoritative,
                  lifecycle: "configured",
                  connections: authoritative.connections.map((candidate) =>
                    candidate.id === connection.id
                      ? { ...candidate, lastHealth: structuredClone(inspection.health) }
                      : candidate,
                  ),
                  defaultRoute: route,
                  cross: { enabled: false, preferredLead: null, preferredChallenger: null },
                };
              });
            } catch (error) {
              const adopted = readProviderStateCommitAdoption(error);
              if (adopted) committed = adopted;
              else {
                const exactReadback = this.stateStore.read();
                if (JSON.stringify(exactReadback) !== JSON.stringify(expectedCommittedState)) throw error;
                committed = exactReadback;
              }
            }
            committedTuple = { state: committed, route };
            await lease.assertHeld();
            if (!adoptCommittedTuple()) throw new ProviderSetupRequiredError();
          } catch (error) {
            if (adoptCommittedTuple()) return;
            throw error;
          }
        },
      );
    } catch (error) {
      if (adoptCommittedTuple()) return structuredClone(committedTuple!.route);
      throw error;
    }
    const completed = committedTuple as {
      state: ProviderSetupStateV2;
      route: RouteIdentityV1;
    } | null;
    if (!completed || !committedAdopted) throw new ProviderSetupRequiredError();
    return structuredClone(completed.route);
  }

  async #transitionKimiModelWithPreference(
    current: RouteIdentityV1,
    modelId: string,
    selectedCanonicalModelId: string,
    preferencePublication: ProviderPreferenceCommitPort,
  ): Promise<RouteIdentityV1> {
    const authority = this.authorityOptions?.credentialAuthority;
    if (!authority || !this.authorityOptions?.kimiAdapter) {
      throw new ProviderSetupRequiredError();
    }
    const state = this.stateStore.read();
    const selected = selectProviderBinding(state, { kind: "route", route: current });
    if (selected.kind !== "exact"
      || selected.binding.backendId !== "kimi-code"
      || !state.defaultRoute
      || !sameExactRoute(state.defaultRoute, current)) {
      throw new ProviderSetupRequiredError();
    }
    const effectAttempt = createProviderEffectAttempt();
    let terminalActivation: Promise<RouteIdentityV1> | null = null;
    try {
      const access = await authority.withCredential({
        backendId: "kimi-code",
        connectionId: selected.binding.connectionId,
        credentialKind: "inference",
        purpose: "explicit-repair",
        environmentEligibility: "forbidden",
        deadlineAt: effectAttempt.deadlineAt,
        signal: effectAttempt.signal,
      }, async (candidate, context) => {
        if (context.binding.stateRevision !== state.revision
          || context.binding.connectionId !== selected.binding.connectionId
          || context.binding.accountFingerprint !== current.accountFingerprint
          || context.binding.billingRealm !== current.billingRealm) {
          throw new ProviderSetupRequiredError();
        }
        terminalActivation = (async () => {
          const result = await this.orchestrator.activateCandidate({
            backendId: "kimi-code",
            expectedRevision: context.binding.stateRevision,
            candidate,
            expectedRequestedModelId: modelId,
            selectedCanonicalModelId,
            signal: effectAttempt.signal,
            deadlineAt: effectAttempt.deadlineAt,
            persistence: "persisted",
            environmentEligibility: "forbidden",
            targetConnectionId: context.binding.connectionId,
            candidatePermit: context.candidatePermit,
            requireCandidatePermit: true,
            persistBeforeProviderConfigCommit: preferencePublication,
          });
          const route = validateRouteIdentityV1(result.route);
          if (!result.persisted
            || !route
            || route.resolutionState !== "resolved"
            || route.backendId !== "kimi-code"
            || route.accountFingerprint !== current.accountFingerprint
            || route.billingRealm !== current.billingRealm
            || route.requestedModelId !== modelId
            || route.canonicalModelId !== selectedCanonicalModelId) {
            throw new ProviderSetupRequiredError();
          }
          return structuredClone(route);
        })();
        await terminalActivation;
      });
      if (access.kind === "available" && terminalActivation) {
        return await terminalActivation;
      }
      if (terminalActivation) return await terminalActivation;
      throw new ProviderSetupRequiredError();
    } catch (error) {
      if (terminalActivation) return await terminalActivation;
      throw error;
    } finally {
      effectAttempt.close();
    }
  }

  async runWithReadyRoute<T>(
    run: (route: RouteIdentityV1) => Promise<T>,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<T> {
    let attemptedBackend: "openrouter" | "kimi-code" = "openrouter";
    return executeProviderModelAction({
      ensureRunnableRoute: () => {
        const route = this.ensureRunnableRoute();
        if (route.backendId === "kimi-code") attemptedBackend = "kimi-code";
        return route;
      },
      beginRun: () => this.runtimeGuard.beginRun(),
      run,
      isAuthenticationFailure: (error) => this.#isAuthenticationFailure(attemptedBackend, error),
      invalidateAndInspect: () => this.#invalidateAuthenticationFailure(attemptedBackend),
      runSetup: (requestedSurface) => this.runSetup(requestedSurface),
      surface,
    });
  }

  #isAuthenticationFailure(
    backendId: "openrouter" | "kimi-code",
    error: unknown,
  ): boolean {
    return backendId === "kimi-code"
      ? ["kimi-code-auth-rejected", "kimi-code-access-terminated"].includes(
          issuedKimiCodeFailure(error)?.code ?? "",
        )
      : shouldReplaceCredential(error, this.openRouter);
  }

  async #invalidateAuthenticationFailure(
    backendId: "openrouter" | "kimi-code",
  ): Promise<void> {
    const controller = new AbortController();
    const runtimeLease = await this.runtimeGuard.acquire(controller.signal);
    let primaryFailed = false;
    try {
      await runtimeLease.assertHeld();
      this.#processRouteGeneration += 1;
      this.#sessionRoute = null;
      this.#sessionRoutePersisted = false;
      this.#pendingSessionBinding = null;
      this.#preparedRoles = null;
      await this.orchestrator.reconnect(backendId, {
        signal: controller.signal,
      });
      await runtimeLease.assertHeld();
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      try {
        await Promise.resolve(runtimeLease.release());
      } catch (error) {
        if (!primaryFailed) throw error;
      }
    }
  }

  #desiredSessionRoute(state: ProviderSetupStateV2): RouteIdentityV1 | null {
    if (this.#sessionRoute?.resolutionState === "resolved") {
      return structuredClone(this.#sessionRoute);
    }
    const persistedSessionRoute = validateRouteIdentityV1(this.session?.data.route);
    if (persistedSessionRoute?.resolutionState === "resolved") {
      return structuredClone(persistedSessionRoute);
    }
    const defaultRoute = validateRouteIdentityV1(state.defaultRoute);
    return defaultRoute?.resolutionState === "resolved"
      ? structuredClone(defaultRoute)
      : null;
  }

  #selectedOpenRouterConnection(state: ProviderSetupStateV2) {
    return this.#selectedProviderConnection(state, "openrouter");
  }

  #selectedProviderConnection(
    state: ProviderSetupStateV2,
    backendId: "openrouter" | "kimi-code",
    allowDisabled = false,
  ) {
    const desiredRoute = this.#desiredSessionRoute(state);
    const selected = desiredRoute?.backendId === backendId
      ? selectProviderBinding(state, { kind: "route", route: desiredRoute }, allowDisabled)
      : state.defaultRoute?.backendId === backendId
        ? selectProviderBinding(state, { kind: "default" }, allowDisabled)
        : selectProviderBinding(state, { kind: "backend", backendId }, allowDisabled);
    return selected.kind === "exact"
      ? state.connections.find((connection) => connection.id === selected.binding.connectionId)
      : undefined;
  }

  #confirmationBinding(
    operation: ProviderDestructiveOperation,
    state: ProviderSetupStateV2,
    backendId: "openrouter" | "kimi-code" = "openrouter",
  ): ProviderConfirmationBinding {
    let connection = this.#selectedProviderConnection(state, backendId);
    if (!connection && operation === "logout") {
      const retained = selectProviderBinding(
        state,
        { kind: "backend", backendId },
        true,
      );
      if (retained.kind === "exact") {
        connection = state.connections.find((candidate) =>
          candidate.id === retained.binding.connectionId
        );
      }
    }
    return {
      operation,
      backendId,
      providerRevision: state.revision,
      connection: connection
        ? {
            id: connection.id,
            enabled: connection.enabled,
            credentialSlot: connection.credentialSlot,
            accountFingerprint: connection.accountFingerprint,
            billingRealm: connection.billingRealm,
          }
        : null,
      defaultRoute: state.defaultRoute ? structuredClone(state.defaultRoute) : null,
      sessionRoute: this.#sessionRoute ? structuredClone(this.#sessionRoute) : null,
      processRouteGeneration: this.#processRouteGeneration,
    };
  }

  #confirmationRequired(
    operation: ProviderDestructiveOperation,
    state = this.stateStore.read(),
    backendId: "openrouter" | "kimi-code" = "openrouter",
  ): ProviderConfirmationResult {
    const confirmationToken = randomUUID();
    this.#providerConfirmations.set(
      confirmationToken,
      this.#confirmationBinding(operation, state, backendId),
    );
    while (this.#providerConfirmations.size > 64) {
      const oldest = this.#providerConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#providerConfirmations.delete(oldest);
    }
    return {
      kind: "confirmation-required",
      operation,
      backendId,
      message: operation === "logout"
        ? `${backendId === "kimi-code" ? "Kimi-Code" : "OpenRouter"}-Zugang wirklich abmelden und nur seinen aktuellen versionierten Schlüssel entfernen?`
        : `Letzten nutzbaren ${backendId === "kimi-code" ? "Kimi-Code" : "OpenRouter"}-Zugang deaktivieren? Modellläufe stoppen, die Unterhaltung bleibt geöffnet.`,
      confirmationToken,
    };
  }

  #consumeConfirmation(
    token: string,
    operation: ProviderDestructiveOperation,
    state: ProviderSetupStateV2,
    backendId: "openrouter" | "kimi-code" = "openrouter",
  ): ProviderConfirmationBinding | null {
    const expected = this.#providerConfirmations.get(token);
    this.#providerConfirmations.delete(token);
    if (!expected) return null;
    return this.#confirmationMatches(expected, operation, state, backendId) ? expected : null;
  }

  #confirmationMatches(
    expected: ProviderConfirmationBinding,
    operation: ProviderDestructiveOperation,
    state: ProviderSetupStateV2,
    backendId: "openrouter" | "kimi-code" = "openrouter",
  ): boolean {
    return JSON.stringify(expected) === JSON.stringify(
      this.#confirmationBinding(operation, state, backendId),
    );
  }

  async #enableRetainedOpenRouter(): Promise<boolean | null> {
    if (!this.authorityOptions) return null;
    const retainedState = this.stateStore.read();
    const retained = selectOpenRouterBinding(
      retainedState,
      { kind: "backend", backendId: "openrouter" },
      true,
    );
    if (retained.kind !== "exact") return null;
    const wasEnabled = retained.binding.enabled;
    if (wasEnabled) {
      const route = this.#desiredSessionRoute(retainedState);
      const selected = route?.backendId === "openrouter"
        ? selectOpenRouterBinding(retainedState, { kind: "route", route })
        : null;
      if (
        route
        && selected?.kind === "exact"
        && selected.binding.connectionId === retained.binding.connectionId
      ) {
        this.#adoptExactSessionRoute(route, true, true, false, true);
        return true;
      }
    }

    const controller = new AbortController();
    const deadlineAt = Date.now() + 5_000;
    const deadlineError = new Error("Provider enable deadline expired.");
    deadlineError.name = "TimeoutError";
    const deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, Math.max(0, deadlineAt - Date.now()));
    const assertRetainedAttemptCurrent = (): void => {
      if (!controller.signal.aborted && Date.now() >= deadlineAt) {
        controller.abort(deadlineError);
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : deadlineError;
      }
    };
    const connectionId = retained.binding.connectionId;
    let committedTuple: {
      state: ProviderSetupStateV2;
      route: RouteIdentityV1;
    } | null = null;
    let committedAdopted = false;
    const adoptCommittedTuple = (): boolean => {
      const tuple = committedTuple;
      if (!tuple) return false;
      if (committedAdopted) return true;
      this.config.providerSetup = requirePersistableProviderState(tuple.state);
      this.#adoptExactSessionRoute(tuple.route, true, true, true, true);
      committedAdopted = true;
      return true;
    };
    try {
      return await this.activationCoordinator.runExclusive(
        { signal: controller.signal, inspectCommitted: false },
        async (lease) => {
          let runtimeBindAttempted = false;
          try {
            await lease.assertHeld();
            const current = this.stateStore.read();
            const selected = selectOpenRouterBinding(
              current,
              { kind: "connection", connectionId },
              true,
            );
            if (
              selected.kind !== "exact"
              || selected.binding.enabled !== wasEnabled
              || selected.binding.accountFingerprint !== retained.binding.accountFingerprint
              || selected.binding.billingRealm !== retained.binding.billingRealm
              || selected.binding.credentialPointer.kind !== retained.binding.credentialPointer.kind
              || (selected.binding.credentialPointer.kind === "legacy"
                ? retained.binding.credentialPointer.kind !== "legacy"
                : retained.binding.credentialPointer.kind !== "versioned"
                  || selected.binding.credentialPointer.slot.id !== retained.binding.credentialPointer.slot.id)
            ) return false;

            const connection = current.connections.find((item) => item.id === connectionId);
            if (!connection) return false;
            const generation = Math.max(
              current.revision,
              connection.lastHealth?.generation ?? 0,
            ) + 1;
            const inspection = await this.authorityOptions!.adapter.inspectUnderAuthorityLease({
              connectionId,
              generation,
              deadlineAt,
              signal: controller.signal,
              purpose: "explicit-enable",
              environmentEligibility: "forbidden",
              allowDisabled: true,
            }, lease);
            await lease.assertHeld();
            if (
              !inspection.routeEligible
              || inspection.accountFingerprint !== connection.accountFingerprint
              || inspection.billingRealm !== connection.billingRealm
            ) return false;

            const models = await abortableProviderAction(
              () => this.authorityOptions!.adapter.listModels({
                connectionId,
                signal: controller.signal,
              }),
              controller.signal,
            );
            await lease.assertHeld();
            const desired = this.#desiredSessionRoute(current);
            const requestedCandidates = [
              desired?.backendId === "openrouter" ? desired.requestedModelId : null,
              KIMI_CODE_MODELS.some((candidate) => candidate.id === this.requestedModel)
                ? null
                : this.requestedModel,
              DEFAULT_CONFIG.mainModel,
            ].filter((candidate): candidate is string => Boolean(candidate));
            let model: BackendModelDescriptor | null = null;
            for (const requestedModelId of new Set(requestedCandidates)) {
              const exact = models.filter((candidate) =>
                candidate.backendId === "openrouter"
                && candidate.requestedModelId === requestedModelId
                && candidate.capabilities.textInput
                && candidate.capabilities.textOutput
              );
              if (exact.length > 0 && new Set(exact.map((candidate) => candidate.canonicalModelId)).size === 1) {
                model = exact[0]!;
                break;
              }
            }
            if (!model) return false;
            const route: RouteIdentityV1 = {
              version: 1,
              backendId: "openrouter",
              accountFingerprint: connection.accountFingerprint,
              billingRealm: "openrouter-payg",
              requestedModelId: model.requestedModelId,
              canonicalModelId: model.canonicalModelId,
              resolutionState: "resolved",
            };
            runtimeBindAttempted = true;
            await this.authorityOptions!.adapter.bindRuntimeUnderAuthorityLease({
              connectionId,
              generation,
              deadlineAt,
              signal: controller.signal,
              allowDisabled: true,
            }, lease);
            await lease.assertHeld();
            if (wasEnabled) {
              const readback = this.stateStore.read();
              const rebound = selectOpenRouterBinding(
                readback,
                { kind: "connection", connectionId },
              );
              if (
                readback.revision !== current.revision
                || rebound.kind !== "exact"
                || rebound.binding.connectionId !== connectionId
                || rebound.binding.accountFingerprint !== connection.accountFingerprint
                || rebound.binding.billingRealm !== connection.billingRealm
                || rebound.binding.credentialPointer.kind !== selected.binding.credentialPointer.kind
                || (rebound.binding.credentialPointer.kind === "legacy"
                  ? selected.binding.credentialPointer.kind !== "legacy"
                  : selected.binding.credentialPointer.kind !== "versioned"
                    || rebound.binding.credentialPointer.slot.id
                      !== selected.binding.credentialPointer.slot.id)
              ) return false;
              this.config.providerSetup = requirePersistableProviderState(readback);
              this.#adoptExactSessionRoute(route, true, true, true, true);
              return true;
            }
            const expectedCommittedState: ProviderSetupStateV2 = {
              ...current,
              revision: current.revision + 1,
              lifecycle: "configured",
              connections: current.connections.map((item) => item.id === connectionId
                ? { ...item, enabled: true, lastHealth: structuredClone(inspection.health) }
                : item),
              defaultRoute: route,
              cross: { enabled: false, preferredLead: null, preferredChallenger: null },
            };
            let committed: ProviderSetupStateV2;
            try {
              committed = await this.stateStore.commit(
                current.revision,
                (authoritative) => {
                  const authoritativeSelection = selectOpenRouterBinding(
                    authoritative,
                    { kind: "connection", connectionId },
                    true,
                  );
                  const authoritativeConnection = authoritative.connections.find(
                    (item) => item.id === connectionId,
                  );
                  if (
                    authoritativeSelection.kind !== "exact"
                    || authoritativeSelection.binding.enabled
                    || !authoritativeConnection
                    || authoritativeConnection.credentialSlot !== connection.credentialSlot
                    || authoritativeConnection.accountFingerprint !== connection.accountFingerprint
                    || authoritativeConnection.billingRealm !== connection.billingRealm
                  ) {
                    throw new Error("Provider enable binding changed before commit.");
                  }
                  return {
                    ...authoritative,
                    lifecycle: "configured",
                    connections: authoritative.connections.map((item) => item.id === connectionId
                      ? { ...item, enabled: true, lastHealth: structuredClone(inspection.health) }
                      : item),
                    defaultRoute: route,
                    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
                  };
                },
                assertRetainedAttemptCurrent,
              );
            } catch (error) {
              const adopted = readProviderStateCommitAdoption(error);
              if (adopted) {
                committed = adopted;
              } else {
                const exactReadback = this.stateStore.read();
                if (JSON.stringify(exactReadback) !== JSON.stringify(expectedCommittedState)) {
                  throw error;
                }
                committed = exactReadback;
              }
            }
            committedTuple = { state: committed, route };
            await lease.assertHeld();
            return adoptCommittedTuple();
          } catch {
            if (adoptCommittedTuple()) return true;
            if (runtimeBindAttempted) {
              const cleanupSignal = new AbortController().signal;
              await this.authorityOptions!.adapter.logout({ signal: cleanupSignal })
                .catch(() => undefined);
            }
            return false;
          }
        },
      );
    } catch {
      return adoptCommittedTuple();
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async #enableRetainedKimi(): Promise<boolean | null> {
    this.#assertKimiOwnerMode();
    const kimiAdapter = this.authorityOptions?.kimiAdapter;
    if (!kimiAdapter) throw new KimiOwnerInteractiveRequiredError();
    const retainedState = this.stateStore.read();
    const retained = selectProviderBinding(
      retainedState,
      { kind: "backend", backendId: "kimi-code" },
      true,
    );
    if (retained.kind !== "exact") return null;
    const wasEnabled = retained.binding.enabled;
    if (wasEnabled) {
      const route = this.#desiredSessionRoute(retainedState);
      const selected = route?.backendId === "kimi-code"
        ? selectProviderBinding(retainedState, { kind: "route", route })
        : null;
      if (
        route
        && selected?.kind === "exact"
        && selected.binding.connectionId === retained.binding.connectionId
      ) {
        this.modelRuntime(route);
        this.#adoptExactSessionRoute(route, true, true, false, true);
        return true;
      }
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + 15_000;
    const deadlineError = new Error("Kimi enable deadline expired.");
    deadlineError.name = "TimeoutError";
    const deadlineTimer = setTimeout(() => controller.abort(deadlineError), 15_000);
    const assertRetainedAttemptCurrent = (): void => {
      if (!controller.signal.aborted && Date.now() >= deadlineAt) controller.abort(deadlineError);
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : deadlineError;
      }
    };
    const connectionId = retained.binding.connectionId;
    let committedTuple: { state: ProviderSetupStateV2; route: RouteIdentityV1 } | null = null;
    let committedAdopted = false;
    const adoptCommittedTuple = (): boolean => {
      const tuple = committedTuple;
      if (!tuple) return false;
      if (committedAdopted) return true;
      this.config.providerSetup = requirePersistableProviderState(tuple.state);
      this.modelRuntime(tuple.route);
      this.#adoptExactSessionRoute(tuple.route, true, true, true, true);
      committedAdopted = true;
      return true;
    };
    try {
      return await this.activationCoordinator.runExclusive(
        { signal: controller.signal, inspectCommitted: false },
        async (lease) => {
          try {
            await lease.assertHeld();
            const current = this.stateStore.read();
            const selected = selectProviderBinding(
              current,
              { kind: "connection", connectionId },
              true,
            );
            if (
              selected.kind !== "exact"
              || selected.binding.backendId !== "kimi-code"
              || selected.binding.enabled !== wasEnabled
              || selected.binding.accountFingerprint !== retained.binding.accountFingerprint
              || selected.binding.billingRealm !== retained.binding.billingRealm
              || selected.binding.credentialPointer.kind !== "versioned"
              || retained.binding.credentialPointer.kind !== "versioned"
              || selected.binding.credentialPointer.slot.id
                !== retained.binding.credentialPointer.slot.id
            ) return false;
            const connection = current.connections.find((candidate) => candidate.id === connectionId);
            if (!connection) return false;
            const generation = Math.max(
              current.revision,
              connection.lastHealth?.generation ?? 0,
            ) + 1;
            const inspection = await kimiAdapter.inspectUnderAuthorityLease({
              connectionId,
              generation,
              deadlineAt,
              signal: controller.signal,
              purpose: "explicit-enable",
              environmentEligibility: "forbidden",
              allowDisabled: true,
            }, lease);
            await lease.assertHeld();
            if (
              !inspection.routeEligible
              || inspection.accountFingerprint !== connection.accountFingerprint
              || inspection.billingRealm !== connection.billingRealm
            ) return false;
            const models = await kimiAdapter.listModels({
              connectionId,
              signal: controller.signal,
            });
            await lease.assertHeld();
            const desired = this.#desiredSessionRoute(current);
            const requestedModelId = desired?.backendId === "kimi-code"
              ? desired.requestedModelId
              : KIMI_CODE_MODELS.some((model) => model.id === this.requestedModel)
                ? this.requestedModel
                : "k3";
            const exact = models.filter((model) =>
              model.backendId === "kimi-code"
              && model.requestedModelId === requestedModelId
              && model.canonicalModelId === requestedModelId
              && model.capabilities.textInput
              && model.capabilities.textOutput
              && model.capabilities.tools,
            );
            if (exact.length !== 1) return false;
            const route: RouteIdentityV1 = {
              version: 1,
              backendId: "kimi-code",
              accountFingerprint: connection.accountFingerprint,
              billingRealm: "kimi-code-membership-provider-managed-overage",
              requestedModelId,
              canonicalModelId: requestedModelId,
              resolutionState: "resolved",
            };
            if (wasEnabled) {
              const readback = this.stateStore.read();
              const rebound = selectProviderBinding(
                readback,
                { kind: "connection", connectionId },
              );
              if (
                readback.revision !== current.revision
                || rebound.kind !== "exact"
                || rebound.binding.backendId !== "kimi-code"
                || rebound.binding.connectionId !== connectionId
                || rebound.binding.accountFingerprint !== connection.accountFingerprint
                || rebound.binding.billingRealm !== connection.billingRealm
                || rebound.binding.credentialPointer.kind !== "versioned"
                || selected.binding.credentialPointer.kind !== "versioned"
                || rebound.binding.credentialPointer.slot.id
                  !== selected.binding.credentialPointer.slot.id
              ) return false;
              this.config.providerSetup = requirePersistableProviderState(readback);
              this.modelRuntime(route);
              this.#adoptExactSessionRoute(route, true, true, true, true);
              return true;
            }
            const expectedCommittedState: ProviderSetupStateV2 = {
              ...current,
              revision: current.revision + 1,
              lifecycle: "configured",
              connections: current.connections.map((candidate) =>
                candidate.id === connectionId
                  ? { ...candidate, enabled: true, lastHealth: structuredClone(inspection.health) }
                  : candidate,
              ),
              defaultRoute: route,
              cross: { enabled: false, preferredLead: null, preferredChallenger: null },
            };
            let committed: ProviderSetupStateV2;
            try {
              committed = await this.stateStore.commit(current.revision, (authoritative) => {
                const authoritativeBinding = selectProviderBinding(
                  authoritative,
                  { kind: "connection", connectionId },
                  true,
                );
                const authoritativeConnection = authoritative.connections.find(
                  (candidate) => candidate.id === connectionId,
                );
                if (
                  authoritativeBinding.kind !== "exact"
                  || authoritativeBinding.binding.backendId !== "kimi-code"
                  || authoritativeBinding.binding.enabled
                  || !authoritativeConnection
                  || authoritativeConnection.credentialSlot !== connection.credentialSlot
                  || authoritativeConnection.accountFingerprint !== connection.accountFingerprint
                  || authoritativeConnection.billingRealm !== connection.billingRealm
                ) throw new ProviderSetupRequiredError();
                return {
                  ...authoritative,
                  lifecycle: "configured",
                  connections: authoritative.connections.map((candidate) =>
                    candidate.id === connectionId
                      ? { ...candidate, enabled: true, lastHealth: structuredClone(inspection.health) }
                      : candidate,
                  ),
                  defaultRoute: route,
                  cross: { enabled: false, preferredLead: null, preferredChallenger: null },
                };
              }, assertRetainedAttemptCurrent);
            } catch (error) {
              const adopted = readProviderStateCommitAdoption(error);
              if (adopted) committed = adopted;
              else {
                const exactReadback = this.stateStore.read();
                if (JSON.stringify(exactReadback) !== JSON.stringify(expectedCommittedState)) throw error;
                committed = exactReadback;
              }
            }
            committedTuple = { state: committed, route };
            await lease.assertHeld();
            return adoptCommittedTuple();
          } catch {
            return adoptCommittedTuple();
          }
        },
      );
    } catch {
      return adoptCommittedTuple();
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async execute(
    intent: ProviderCommandIntent,
    surface: SetupSurface | "plain" | "fullscreen",
  ): Promise<ProviderCommandResult> {
    if (intent.kind !== "setup" && intent.kind !== "status") {
      const descriptor = this.registry.descriptor(intent.backendId);
      if (descriptor.maturity === "coming-soon") {
        return {
          kind: "provider-coming-soon",
          backendId: "anthropic",
          displayName: descriptor.displayName,
          explanation: "Coming soon · Claude-Modelle sind heute über OpenRouter verfügbar.",
        };
      }
      if (intent.backendId === "kimi-code") this.#assertKimiOwnerMode();
    }

    if (intent.kind === "enable") {
      const retained = intent.backendId === "kimi-code"
        ? await this.#enableRetainedKimi()
        : await this.#enableRetainedOpenRouter();
      if (retained !== null) {
        return {
          kind: "setup",
          backendId: intent.backendId === "kimi-code" ? "kimi-code" : "openrouter",
          outcome: retained ? "ready" : "cancelled",
        };
      }
    }

    if (intent.kind === "setup" || intent.kind === "connect" || intent.kind === "enable") {
      const backendId = intent.kind === "setup"
        ? "openrouter"
        : intent.backendId === "kimi-code"
          ? "kimi-code"
          : "openrouter";
      const result = await this.runSetup(
        surface,
        undefined,
        intent.kind === "setup" ? undefined : backendId,
      );
      return {
        kind: "setup",
        backendId,
        outcome: result.kind === "ready" ? "ready" : "cancelled",
      };
    }

    if (intent.kind === "status") {
      return this.#providerStatus();
    }

    if (intent.kind === "models") {
      if (intent.backendId === "kimi-code") {
        const state = this.stateStore.read();
        const selected = this.#selectedProviderConnection(state, "kimi-code");
        const adapter = this.authorityOptions?.kimiAdapter;
        if (!selected || !adapter) {
          return { kind: "models", backendId: "kimi-code", models: [] };
        }
        const controller = new AbortController();
        const runtimeLease = await this.runtimeGuard.acquire(controller.signal);
        try {
          await runtimeLease.assertHeld();
          const generation = selected.lastHealth?.generation;
          if (!Number.isSafeInteger(generation) || generation! < 0) {
            return { kind: "models", backendId: "kimi-code", models: [] };
          }
          const inspection = await adapter.inspect({
            connectionId: selected.id,
            generation: generation!,
            deadlineAt: Date.now() + 15_000,
            signal: controller.signal,
            purpose: "explicit-repair",
            environmentEligibility: "forbidden",
          });
          await runtimeLease.assertHeld();
          if (!inspection.routeEligible) return { kind: "models", backendId: "kimi-code", models: [] };
          const models = await adapter.listModels({
            connectionId: selected.id,
            signal: controller.signal,
          });
          await runtimeLease.assertHeld();
          return {
            kind: "models",
            backendId: "kimi-code",
            models: models.map((model) => ({
              requestedModelId: model.requestedModelId,
              canonicalModelId: model.canonicalModelId,
              displayName: model.displayName,
            })),
          };
        } finally {
          await Promise.resolve(runtimeLease.release());
        }
      }
      const selected = this.#selectedProviderConnection(this.stateStore.read(), "openrouter");
      const models = this.authorityOptions && selected
        ? await (async () => {
            const controller = new AbortController();
            const deadlineAt = Date.now() + 15_000;
            const timer = setTimeout(
              () => controller.abort(new DOMException("Provider catalog deadline expired.", "TimeoutError")),
              15_000,
            );
            try {
              return await this.activationCoordinator.readAuthority(
                { signal: controller.signal, backendId: "openrouter" },
                async (lease) => {
                  await lease.assertHeld();
                  const generation = Number.isSafeInteger(selected.lastHealth?.generation)
                    ? selected.lastHealth!.generation
                    : this.stateStore.read().revision;
                  const inspection = await this.authorityOptions!.adapter.inspectUnderAuthorityLease({
                    connectionId: selected.id,
                    generation,
                    deadlineAt,
                    signal: controller.signal,
                    purpose: "explicit-repair",
                    environmentEligibility: "forbidden",
                  }, lease);
                  await lease.assertHeld();
                  if (
                    !inspection.routeEligible
                    || inspection.accountFingerprint !== selected.accountFingerprint
                    || inspection.billingRealm !== selected.billingRealm
                  ) return [];
                  const catalog = await this.authorityOptions!.adapter.listModels({
                    connectionId: selected.id,
                    signal: controller.signal,
                  });
                  await lease.assertHeld();
                  return catalog.filter((model) =>
                    model.backendId === "openrouter"
                    && model.capabilities.textInput
                    && model.capabilities.textOutput
                  );
                },
              );
            } finally {
              clearTimeout(timer);
            }
          })()
        : await this.runModelCatalog(
            async () => mainModelCandidates(await this.openRouter.listModels()),
            surface,
          );
      return {
        kind: "models",
        backendId: "openrouter",
        models: models.map((model) => ({
          requestedModelId: "requestedModelId" in model ? model.requestedModelId : model.id,
          canonicalModelId: "canonicalModelId" in model
            ? model.canonicalModelId
            : model.canonicalSlug ?? model.id,
          displayName: "displayName" in model ? model.displayName : model.name,
        })),
      };
    }

    if (intent.kind === "reconnect") {
      const backendId = intent.backendId === "kimi-code" ? "kimi-code" : "openrouter";
      const reconnectState = this.stateStore.read();
      const selected = this.#selectedProviderConnection(reconnectState, backendId);
      if (!selected) {
        return {
          kind: "reconnected",
          backendId,
          headline: "setup-required",
          generation: 0,
        };
      }
      const controller = new AbortController();
      const desiredRoute = this.#desiredSessionRoute(reconnectState);
      const reconnectRoute = desiredRoute?.backendId === backendId ? desiredRoute : null;
      const runtimeLease = await this.runtimeGuard.acquire(controller.signal);
      let result: StartupSetupResult;
      let primaryFailed = false;
      try {
        await runtimeLease.assertHeld();
        result = await this.orchestrator.reconnect(backendId, {
          connectionId: selected.id,
          signal: controller.signal,
        });
        await runtimeLease.assertHeld();
        const adapter = this.registry.adapter(backendId);
        let provedRoute: RouteIdentityV1 | null = null;
        if (reconnectRoute?.resolutionState === "resolved") {
          try {
            const candidate = this.orchestrator.ensureRunnableRoute(reconnectRoute);
            if (sameExactRoute(candidate, reconnectRoute)) provedRoute = candidate;
          } catch (error) {
            if (!isProviderSetupRequired(error)) throw error;
          }
        }
        const rebound = provedRoute
          ? selectProviderBinding(
              this.stateStore.read(),
              { kind: "route", route: provedRoute },
            )
          : null;
        if (
          provedRoute
          && rebound?.kind === "exact"
          && rebound.binding.connectionId === selected.id
        ) {
          const defaultRoute = validateRouteIdentityV1(reconnectState.defaultRoute);
          if (!defaultRoute || !sameExactRoute(defaultRoute, provedRoute)) {
            const catalogRoute = provedRoute;
            const models = await adapter.listModels({
              connectionId: selected.id,
              signal: controller.signal,
            });
            await runtimeLease.assertHeld();
            const exact = models.filter((model) =>
              model.backendId === catalogRoute.backendId
              && model.requestedModelId === catalogRoute.requestedModelId
              && model.canonicalModelId === catalogRoute.canonicalModelId
              && model.capabilities.textInput
              && model.capabilities.textOutput
            );
            if (exact.length !== 1) provedRoute = null;
          }
        } else {
          provedRoute = null;
        }
        if ((adapter.bindRuntime || backendId === "kimi-code") && provedRoute) {
          if (backendId === "kimi-code") {
            this.modelRuntime(provedRoute);
          } else if (adapter.bindRuntime) {
            await adapter.bindRuntime({
              connectionId: selected.id,
              generation: result.generation,
              deadlineAt: Date.now() + 5_000,
              signal: controller.signal,
            });
          }
          await runtimeLease.assertHeld();
          const bound = selectProviderBinding(
            this.stateStore.read(),
            { kind: "route", route: provedRoute },
          );
          if (bound.kind !== "exact" || bound.binding.connectionId !== selected.id) {
            throw new ProviderSetupRequiredError();
          }
          this.#synchronizeAuthoritativeProviderState();
          this.#adoptExactSessionRoute(provedRoute, true);
        } else {
          if (
            reconnectRoute
            && this.#sessionRoute
            && sameExactRoute(this.#sessionRoute, reconnectRoute)
          ) {
            this.#processRouteGeneration += 1;
            this.#sessionRoute = null;
            this.#sessionRoutePersisted = false;
            this.#preparedRoles = null;
          }
          this.#synchronizeAuthoritativeProviderState();
        }
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        try {
          await Promise.resolve(runtimeLease.release());
        } catch (error) {
          if (!primaryFailed) throw error;
        }
      }
      const connection = this.stateStore.read().connections.find((candidate) =>
        candidate.id === selected.id && candidate.backendId === backendId
      );
      return {
        kind: "reconnected",
        backendId,
        headline: connection?.lastHealth
          ? deriveProviderHeadline(connection.lastHealth)
          : result.mode,
        generation: result.generation,
      };
    }

    if (intent.kind === "logout") {
      return intent.backendId === "kimi-code"
        ? this.#logoutKimiProvider(intent.confirmationToken)
        : this.#logoutProvider(intent.confirmationToken);
    }

    if (intent.kind !== "disable" && intent.kind !== "disconnect") {
      throw new Error("Unsupported provider command intent.");
    }
    return this.#disableProvider({
      kind: intent.kind,
      backendId: intent.backendId === "kimi-code" ? "kimi-code" : "openrouter",
      ...(intent.confirmationToken ? { confirmationToken: intent.confirmationToken } : {}),
    });
  }

  #providerStatus(): ProviderCommandResult {
    const state = this.stateStore.read();
    const desiredSessionRoute = this.#desiredSessionRoute(state);
    const descriptors = this.registry.entries().filter(
      (descriptor): descriptor is BackendDescriptor & {
        id: "openrouter" | "kimi-code" | "anthropic";
      } => descriptor.id === "openrouter"
        || descriptor.id === "kimi-code"
        || descriptor.id === "anthropic",
    );
    const providers: ProviderCommandStatusEntry[] = descriptors.map((descriptor) => {
      if (descriptor.id === "anthropic") {
        return {
          backendId: "anthropic",
          displayName: descriptor.displayName,
          availability: "coming-soon",
          configuration: "disabled",
          maturity: "coming-soon",
          billingRealm: "none",
          accountFingerprintSuffix: null,
          headline: null,
          health: null,
          isDefault: false,
          selectedModel: null,
        };
      }
      const processRoute = !this.#sessionRoutePersisted
          && this.#sessionRoute?.backendId === descriptor.id
        ? this.#sessionRoute
        : null;
      const persistedSessionRoute = this.#sessionRoutePersisted
        && desiredSessionRoute?.backendId === descriptor.id
        ? desiredSessionRoute
        : null;
      const routeForDescriptor = persistedSessionRoute
        ?? (state.defaultRoute?.backendId === descriptor.id ? state.defaultRoute : null);
      const connection = processRoute
        ? undefined
        : (() => {
            const selected = routeForDescriptor
              ? selectProviderBinding(state, { kind: "route", route: routeForDescriptor })
              : selectProviderBinding(state, { kind: "backend", backendId: descriptor.id });
            return selected.kind === "exact"
              ? state.connections.find((candidate) => candidate.id === selected.binding.connectionId)
              : undefined;
          })();
      const health = connection?.lastHealth ?? null;
      const selectedRoute = processRoute
        ?? routeForDescriptor;
      const selectedModel = selectedRoute?.resolutionState === "resolved"
        && selectedRoute.canonicalModelId
        ? {
            requestedModelId: selectedRoute.requestedModelId,
            canonicalModelId: selectedRoute.canonicalModelId,
            displayName: descriptor.id === "kimi-code"
              ? KIMI_CODE_MODELS.find((model) => model.id === selectedRoute.canonicalModelId)?.displayName
                ?? selectedRoute.canonicalModelId
              : selectedRoute.canonicalModelId,
          }
        : null;
      return {
        backendId: descriptor.id,
        displayName: descriptor.displayName,
        availability: "connectable",
        configuration: connection?.enabled || processRoute ? "enabled" : "disabled",
        maturity: descriptor.maturity,
        billingRealm: descriptor.id === "kimi-code"
          ? "kimi-code-membership-provider-managed-overage"
          : "openrouter-payg",
        accountFingerprintSuffix: descriptor.id === "openrouter"
          && (connection?.accountFingerprint || processRoute?.accountFingerprint)
          ? `…${(connection?.accountFingerprint ?? processRoute!.accountFingerprint).slice(-6)}`
          : null,
        headline: health ? deriveProviderHeadline(health) : processRoute ? "ready" : null,
        health: health
          ? {
              credential: health.credential,
              connectivity: health.connectivity,
              spend: health.spend,
              runtime: health.runtime,
            }
          : processRoute
            ? {
                credential: "valid",
                connectivity: "connected",
                spend: "unknown",
                runtime: "not-applicable",
              }
            : null,
        isDefault: Boolean(
          processRoute
          || (connection
            && state.defaultRoute
            && connection.backendId === state.defaultRoute.backendId
            && connection.accountFingerprint === state.defaultRoute.accountFingerprint
            && connection.billingRealm === state.defaultRoute.billingRealm)
        ),
        selectedModel,
      };
    });
    return { kind: "status", providers, crossEnabled: false };
  }

  async #disableProvider(
    intent: {
      kind: "disable" | "disconnect";
      backendId: "openrouter" | "kimi-code";
      confirmationToken?: string;
    },
  ): Promise<ProviderCommandResult> {
    if (intent.backendId === "kimi-code") this.#assertKimiOwnerMode();
    const before = this.stateStore.read();
    const connection = this.#selectedProviderConnection(before, intent.backendId);
    const processRoute = !this.#sessionRoutePersisted
        && this.#sessionRoute?.backendId === intent.backendId
      ? this.#sessionRoute
      : null;
    if (!intent.confirmationToken && !connection && !processRoute) {
      return { kind: "unchanged", backendId: intent.backendId, reason: "bereits deaktiviert" };
    }
    const affectsDefault = Boolean(connection
      &&
      before.defaultRoute
      && before.defaultRoute.backendId === connection.backendId
      && before.defaultRoute.accountFingerprint === connection.accountFingerprint
      && before.defaultRoute.billingRealm === connection.billingRealm
    );
    const isFinalEnabled = before.connections.filter((candidate) => candidate.enabled).length === 1;
    if (!intent.confirmationToken && (processRoute || affectsDefault || isFinalEnabled)) {
      return this.#confirmationRequired(intent.kind, before, intent.backendId);
    }

    try {
      return await this.activationCoordinator.runExclusive(
        { signal: new AbortController().signal, inspectCommitted: false },
        async (lease) => {
          await lease.assertHeld();
          const current = this.stateStore.read();
          const authorization = intent.confirmationToken
            ? this.#consumeConfirmation(intent.confirmationToken, intent.kind, current, intent.backendId)
            : null;
          if (intent.confirmationToken && !authorization) {
            return this.#confirmationRequired(intent.kind, current, intent.backendId);
          }
          const mutationAuthority = authorization
            ?? this.#confirmationBinding(intent.kind, current, intent.backendId);
          const selected = mutationAuthority.connection
            ? current.connections.find((candidate) =>
                candidate.id === mutationAuthority.connection!.id
                && candidate.backendId === intent.backendId
                && candidate.enabled
                && candidate.credentialSlot === mutationAuthority.connection!.credentialSlot
                && candidate.accountFingerprint === mutationAuthority.connection!.accountFingerprint
                && candidate.billingRealm === mutationAuthority.connection!.billingRealm
              )
            : undefined;
          const activeProcessRoute = !this.#sessionRoutePersisted
              && this.#sessionRoute?.backendId === intent.backendId
            ? this.#sessionRoute
            : null;
          if (!selected && !activeProcessRoute) {
            return { kind: "unchanged", backendId: intent.backendId, reason: "bereits deaktiviert" };
          }
          const next = selected
            ? await this.stateStore.commit(current.revision, (authoritative) => {
                if (!this.#confirmationMatches(mutationAuthority, intent.kind, authoritative, intent.backendId)) {
                  throw new ProviderConfirmationStaleError(
                    this.#confirmationRequired(intent.kind, authoritative, intent.backendId),
                  );
                }
                return {
                  ...authoritative,
                  lifecycle: "configured",
                  connections: authoritative.connections.map((candidate) =>
                    candidate.id === selected.id ? { ...candidate, enabled: false } : candidate
                  ),
                  defaultRoute: authoritative.defaultRoute
                    && authoritative.defaultRoute.backendId === selected.backendId
                    && authoritative.defaultRoute.accountFingerprint === selected.accountFingerprint
                    && authoritative.defaultRoute.billingRealm === selected.billingRealm
                    ? null
                    : authoritative.defaultRoute,
                  cross: { enabled: false, preferredLead: null, preferredChallenger: null },
                };
              })
            : current;
          await lease.assertHeld();
          const persistedSessionRoute = validateRouteIdentityV1(this.session?.data.route);
          const persistedSessionBinding = persistedSessionRoute
            ? selectProviderBinding(current, { kind: "route", route: persistedSessionRoute }, true)
            : null;
          const sessionRouteToClear = selected
            && persistedSessionRoute?.resolutionState === "resolved"
            && persistedSessionBinding?.kind === "exact"
            && persistedSessionBinding.binding.connectionId === selected.id
            ? persistedSessionRoute
            : null;
          this.config.providerSetup = requirePersistableProviderState(next);
          if (sessionRouteToClear && this.session) {
            await this.session.clearRouteIfExact(sessionRouteToClear);
          }
          const defaultCleared = current.defaultRoute !== null && next.defaultRoute === null;
          const matchingSessionRoute = Boolean(
            selected
            && this.#sessionRoute?.backendId === selected.backendId
            && this.#sessionRoute.accountFingerprint === selected.accountFingerprint
            && this.#sessionRoute.billingRealm === selected.billingRealm,
          );
          if (defaultCleared || activeProcessRoute || matchingSessionRoute) {
            this.#processRouteGeneration += 1;
            this.#sessionRoute = null;
            this.#sessionRoutePersisted = false;
            this.#pendingSessionBinding = null;
            this.#preparedRoles = null;
          }
          if (activeProcessRoute && intent.backendId === "openrouter") {
            this.environmentSecret = null;
            this.authorityOptions?.credentialAuthority.revokeAutomaticEnvironment();
          }
          await lease.assertHeld();
          return {
            kind: "changed",
            operation: intent.kind,
            backendId: intent.backendId,
            setupRequired: next.defaultRoute === null,
            defaultCleared,
          };
        },
      );
    } catch (error) {
      if (error instanceof ProviderConfirmationStaleError) return error.confirmation;
      throw error;
    }
  }

  async #logoutProvider(confirmationToken?: string): Promise<ProviderCommandResult> {
    if (!confirmationToken) return this.#confirmationRequired("logout");
    const expected = this.#providerConfirmations.get(confirmationToken);
    if (
      expected?.operation === "logout"
      && expected.connection === null
      && this.stateStore.read().connections.some((connection) =>
        connection.backendId === "openrouter"
      )
    ) {
      this.#providerConfirmations.delete(confirmationToken);
      return this.#confirmationRequired("logout");
    }
    if (
      expected?.operation === "logout"
      && expected.connection?.credentialSlot.startsWith("v1:inference:")
    ) {
      try {
        await this.providerCredentials.apply({
          kind: "forget",
          credentialKind: "inference",
          targetConnectionId: expected.connection.id,
          targetCredentialSlot: expected.connection.credentialSlot,
          authorize: () => {
            const current = this.stateStore.read();
            if (this.#consumeConfirmation(confirmationToken, "logout", current)) return true;
            throw new ProviderConfirmationStaleError(
              this.#confirmationRequired("logout", current),
            );
          },
          onAuthoritativeMismatch: (rawState) => {
            const authoritative = requirePersistableProviderState(
              validateProviderSetupState(rawState),
            );
            throw new ProviderConfirmationStaleError(
              this.#confirmationRequired("logout", authoritative),
            );
          },
          onForgotten: () => this.adoptCredentialForget(),
        });
      } catch (error) {
        if (error instanceof ProviderConfirmationStaleError) return error.confirmation;
        throw error;
      }
      const after = this.stateStore.read();
      const selectedStillExists = after.connections.some((candidate) =>
        candidate.id === expected.connection!.id
      );
      if (selectedStillExists) {
        return { kind: "unchanged", backendId: "openrouter", reason: "Zugang blieb erhalten" };
      }
      return {
        kind: "changed",
        operation: "logout",
        backendId: "openrouter",
        setupRequired: after.defaultRoute === null,
        defaultCleared: expected.defaultRoute !== null && after.defaultRoute === null,
      };
    }
    return this.#logoutWithoutVersionedCredential(
      expected?.operation === "logout" ? expected.connection?.id ?? null : null,
      confirmationToken,
    );
  }

  async #logoutKimiProvider(confirmationToken?: string): Promise<ProviderCommandResult> {
    this.#assertKimiOwnerMode();
    const currentBinding = this.#confirmationBinding(
      "logout",
      this.stateStore.read(),
      "kimi-code",
    );
    if (!currentBinding.connection) {
      if (confirmationToken) this.#providerConfirmations.delete(confirmationToken);
      return { kind: "unchanged", backendId: "kimi-code", reason: "bereits abgemeldet" };
    }
    if (!confirmationToken) {
      return this.#confirmationRequired("logout", this.stateStore.read(), "kimi-code");
    }
    const expected = this.#providerConfirmations.get(confirmationToken);
    if (expected?.operation !== "logout" || expected.backendId !== "kimi-code") {
      this.#providerConfirmations.delete(confirmationToken);
      return this.#confirmationRequired("logout", this.stateStore.read(), "kimi-code");
    }
    const journal = this.authorityOptions?.forgetJournal;
    const adapter = this.authorityOptions?.kimiAdapter;
    if (!journal || !adapter) throw new KimiOwnerInteractiveRequiredError();
    try {
      const settled = await this.activationCoordinator.recoverAndRun(
        { signal: new AbortController().signal, inspectCommitted: false },
        async (lease) => {
          await lease.assertHeld();
          const state = this.stateStore.read();
          const authorization = this.#consumeConfirmation(
            confirmationToken,
            "logout",
            state,
            "kimi-code",
          );
          if (!authorization?.connection) {
            throw new ProviderConfirmationStaleError(
              this.#confirmationRequired("logout", state, "kimi-code"),
            );
          }
          const connection = state.connections.find((candidate) =>
            candidate.id === authorization.connection!.id
            && candidate.backendId === "kimi-code"
            && candidate.enabled === authorization.connection!.enabled
            && candidate.credentialSlot === authorization.connection!.credentialSlot
            && candidate.accountFingerprint === authorization.connection!.accountFingerprint
            && candidate.billingRealm === authorization.connection!.billingRealm,
          );
          if (
            !connection
            || !/^v1:kimi-code:[0-9a-f-]{36}$/.test(connection.credentialSlot)
          ) {
            throw new ProviderConfirmationStaleError(
              this.#confirmationRequired("logout", state, "kimi-code"),
            );
          }
          const persistedSessionRoute = validateRouteIdentityV1(this.session?.data.route);
          const persistedSessionBinding = persistedSessionRoute
            ? selectProviderBinding(state, { kind: "route", route: persistedSessionRoute }, true)
            : null;
          const sessionRouteToClear = persistedSessionRoute?.resolutionState === "resolved"
            && persistedSessionBinding?.kind === "exact"
            && persistedSessionBinding.binding.connectionId === connection.id
            ? persistedSessionRoute
            : null;
          const sessionRouteCleared = sessionRouteToClear && this.session
            ? await this.session.clearRouteIfExact(sessionRouteToClear)
            : false;
          await lease.assertHeld();
          const transaction = await journal.begin({
            backendId: "kimi-code",
            connectionId: connection.id,
            target: {
              kind: "versioned",
              slot: {
                version: 1,
                kind: "kimi-code",
                id: connection.credentialSlot,
              },
            },
          });
          const outcome = await settleProviderCredentialForget({
            transaction,
            journal,
            stateStore: this.stateStore,
            credentials: this.credentials,
            assertHeld: () => lease.assertHeld(),
            initialAuthoritativeState: state,
            onStatePublished: (published) => {
              this.config.providerSetup = requirePersistableProviderState(published);
            },
            onAuthoritativeMismatch: (authoritative) => {
              throw new ProviderConfirmationStaleError(
                this.#confirmationRequired("logout", authoritative, "kimi-code"),
              );
            },
          });
          if (outcome.cleanupPending) throw new Error("cleanup-pending");
          await adapter.logout({ signal: new AbortController().signal });
          await lease.assertHeld();
          const after = this.stateStore.read();
          const routedToForgotten = this.#sessionRoute?.backendId === "kimi-code"
            && this.#sessionRoute.accountFingerprint === connection.accountFingerprint
            && this.#sessionRoute.billingRealm === connection.billingRealm
            || sessionRouteCleared;
          if (routedToForgotten) {
            this.#processRouteGeneration += 1;
            this.#sessionRoute = null;
            this.#sessionRoutePersisted = false;
            this.#pendingSessionBinding = null;
            this.#preparedRoles = null;
          }
          return {
            before: state,
            after,
            connectionId: connection.id,
          };
        },
      );
      return {
        kind: "changed",
        operation: "logout",
        backendId: "kimi-code",
        setupRequired: settled.value.after.defaultRoute === null,
        defaultCleared: settled.value.before.defaultRoute !== null
          && settled.value.after.defaultRoute === null,
      };
    } catch (error) {
      if (error instanceof ProviderConfirmationStaleError) return error.confirmation;
      throw new Error("Provider credential cleanup is pending and will resume on restart.");
    }
  }

  async #logoutWithoutVersionedCredential(
    connectionId: string | null,
    confirmationToken: string,
  ): Promise<ProviderCommandResult> {
    const committedOutcome: { value: LegacyLogoutCommittedOutcome | null } = { value: null };
    try {
      return await this.activationCoordinator.runExclusive(
        { signal: new AbortController().signal, inspectCommitted: false },
        async (lease) => {
          await lease.assertHeld();
          const current = this.stateStore.read();
          const authorization = this.#consumeConfirmation(
            confirmationToken,
            "logout",
            current,
          );
          if (!authorization) return this.#confirmationRequired("logout", current);
          const selected = authorization.connection && connectionId === authorization.connection.id
            ? current.connections.find((candidate) =>
                candidate.id === authorization.connection!.id
                && candidate.backendId === "openrouter"
                && candidate.enabled === authorization.connection!.enabled
                && candidate.credentialSlot === authorization.connection!.credentialSlot
                && candidate.accountFingerprint === authorization.connection!.accountFingerprint
                && candidate.billingRealm === authorization.connection!.billingRealm
              )
            : undefined;
          if (authorization.connection && !selected) {
            return this.#confirmationRequired("logout", current);
          }
          let next: ProviderSetupStateV2;
          if (selected) {
            try {
              next = await this.stateStore.commit(current.revision, (authoritative) => {
                if (!this.#confirmationMatches(authorization, "logout", authoritative)) {
                  throw new ProviderConfirmationStaleError(
                    this.#confirmationRequired("logout", authoritative),
                  );
                }
                return {
                  ...authoritative,
                  lifecycle: "configured",
                  connections: authoritative.connections.map((candidate) =>
                    candidate.id === selected.id ? { ...candidate, enabled: false } : candidate
                  ),
                  defaultRoute: authoritative.defaultRoute
                    && authoritative.defaultRoute.backendId === selected.backendId
                    && authoritative.defaultRoute.accountFingerprint === selected.accountFingerprint
                    && authoritative.defaultRoute.billingRealm === selected.billingRealm
                    ? null
                    : authoritative.defaultRoute,
                  cross: { enabled: false, preferredLead: null, preferredChallenger: null },
                };
              });
            } catch (error) {
              const adopted = readProviderStateCommitAdoption(error);
              if (!adopted) throw error;
              const result: Extract<ProviderCommandResult, { kind: "changed" }> = {
                kind: "changed",
                operation: "logout",
                backendId: "openrouter",
                setupRequired: adopted.defaultRoute === null,
                defaultCleared: current.defaultRoute !== null && adopted.defaultRoute === null,
              };
              committedOutcome.value = {
                proof: LEGACY_LOGOUT_COMMIT_PROOF,
                state: requirePersistableProviderState(adopted),
                result,
                completed: false,
              };
              throw error;
            }
          } else {
            next = current;
          }
          const result: Extract<ProviderCommandResult, { kind: "changed" }> = {
            kind: "changed",
            operation: "logout",
            backendId: "openrouter",
            setupRequired: next.defaultRoute === null,
            defaultCleared: current.defaultRoute !== null && next.defaultRoute === null,
          };
          committedOutcome.value = {
            proof: LEGACY_LOGOUT_COMMIT_PROOF,
            state: requirePersistableProviderState(next),
            result,
            completed: false,
          };
          return this.#completeCommittedLegacyLogout(committedOutcome.value, lease);
        },
      );
    } catch (error) {
      if (error instanceof ProviderConfirmationStaleError) return error.confirmation;
      const committed = committedOutcome.value;
      if (committed?.proof === LEGACY_LOGOUT_COMMIT_PROOF) {
        if (committed.completed) return committed.result;
        try {
          return await this.activationCoordinator.runExclusive(
            { signal: new AbortController().signal, inspectCommitted: false },
            async (lease) => {
              await lease.assertHeld();
              if (
                JSON.stringify(this.stateStore.read())
                !== JSON.stringify(committed.state)
              ) {
                throw new ProviderSetupRequiredError();
              }
              return this.#completeCommittedLegacyLogout(committed, lease);
            },
          );
        } catch (recoveryError) {
          if (committed.completed) return committed.result;
          throw recoveryError;
        }
      }
      throw error;
    }
  }

  async #completeCommittedLegacyLogout(
    outcome: LegacyLogoutCommittedOutcome,
    lease: ProviderCoordinatorLease,
  ): Promise<Extract<ProviderCommandResult, { kind: "changed" }>> {
    await lease.assertHeld();
    this.config.providerSetup = requirePersistableProviderState(outcome.state);
    await lease.assertHeld();
    // The exact durable Legacy disable is now projected into this process.
    this.openRouter.forgetKey();
    this.#processRouteGeneration += 1;
    this.#sessionRoute = null;
    this.#sessionRoutePersisted = false;
    this.#pendingSessionBinding = null;
    this.#preparedRoles = null;
    this.environmentSecret = null;
    outcome.completed = true;
    await lease.assertHeld();
    return outcome.result;
  }
}

function credentialSlotFromState(
  state: ReturnType<ProviderStateStore["read"]>,
): "legacy:inference" | CredentialSlotRef {
  const raw = state.connections.find((connection) =>
    connection.backendId === "openrouter" && connection.enabled
  )?.credentialSlot;
  if (!raw) return "legacy:inference";
  const parsed = parseOpenRouterCredentialPointer(raw);
  if (!parsed) throw new ProviderSetupRequiredError();
  return parsed.kind === "legacy" ? parsed.id : parsed.slot;
}

async function loadCredentialReferenceForStartup(
  credentials: CredentialStore,
  reference: "legacy:inference" | CredentialSlotRef,
): Promise<StoredCredentialStartupState> {
  try {
    const value = reference === "legacy:inference"
      ? await credentials.get("inference")
      : await credentials.readSlot(reference);
    return value === null
      ? { kind: "absent" }
      : { kind: "present", value };
  } catch {
    return { kind: "invalid" };
  }
}

type ProviderCredentialForgetTarget =
  | { kind: "versioned"; slot: CredentialSlotRef }
  | { kind: "legacy" };

interface ProviderCredentialForgetManifestV1 {
  version: 1;
  phase: "prepared" | "credential-deleted";
  connectionId: string | null;
  target: ProviderCredentialForgetTarget;
}

interface ProviderCredentialForgetManifestV2 {
  version: 2;
  phase: "prepared" | "credential-deleted";
  backendId: "kimi-code";
  connectionId: string;
  target: { kind: "versioned"; slot: CredentialSlotRef & { kind: "kimi-code" } };
}

type ProviderCredentialForgetManifest =
  | ProviderCredentialForgetManifestV1
  | ProviderCredentialForgetManifestV2;

interface ProviderCredentialForgetTransaction {
  claim: PrivateDirectoryClaim;
  rawManifest: string;
  manifest: ProviderCredentialForgetManifest;
}

export class ProviderCredentialForgetJournal {
  readonly #path: string;

  constructor(private readonly input: {
    appHome: string;
    privateStore: PrivateStore;
  }) {
    this.#path = join(input.appHome, PROVIDER_CREDENTIAL_FORGET_DIRECTORY);
  }

  async begin(input: {
    connectionId: string | null;
    target: ProviderCredentialForgetTarget;
    backendId?: "openrouter" | "kimi-code";
  }): Promise<ProviderCredentialForgetTransaction> {
    const manifest = validateProviderForgetManifest(input.backendId === "kimi-code"
      ? {
          version: 2,
          phase: "prepared",
          backendId: "kimi-code",
          connectionId: input.connectionId,
          target: input.target,
        }
      : {
          version: 1,
          phase: "prepared",
          connectionId: input.connectionId,
          target: input.target,
        });
    const acquired = await this.input.privateStore.createDirectoryExclusive(this.#path);
    if (!acquired) {
      const existing = await this.resume();
      if (
        existing
        && providerForgetBackend(existing.manifest) === providerForgetBackend(manifest)
        && existing.manifest.connectionId === manifest.connectionId
        && sameProviderForgetTarget(existing.manifest.target, manifest.target)
      ) {
        return existing;
      }
      throw new Error("Provider credential cleanup is already pending.");
    }
    const transaction: ProviderCredentialForgetTransaction = {
      claim: acquired,
      rawManifest: "",
      manifest,
    };
    await this.#write(transaction, manifest);
    return transaction;
  }

  async resume(): Promise<ProviderCredentialForgetTransaction | null> {
    const acquired = await this.input.privateStore.createDirectoryExclusive(this.#path);
    if (acquired) {
      await this.input.privateStore.releaseDirectoryClaim(acquired, null);
      return null;
    }
    const adopted = await this.input.privateStore.adoptDirectoryClaim(this.#path);
    let rawManifest: string;
    try {
      rawManifest = await this.input.privateStore.readClaimManifest(adopted.claim);
    } catch {
      try {
        await this.input.privateStore.releaseDirectoryClaim(adopted.claim, null);
        return null;
      } catch {
        throw new Error("Provider credential cleanup journal is invalid.");
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      throw new Error("Provider credential cleanup journal is invalid.");
    }
    return {
      claim: adopted.claim,
      rawManifest,
      manifest: validateProviderForgetManifest(parsed),
    };
  }

  async markDeleted(transaction: ProviderCredentialForgetTransaction): Promise<void> {
    if (transaction.manifest.phase === "credential-deleted") return;
    await this.#write(transaction, {
      ...transaction.manifest,
      phase: "credential-deleted",
    });
  }

  async complete(transaction: ProviderCredentialForgetTransaction): Promise<void> {
    await this.input.privateStore.removeClaimManifest(
      transaction.claim,
      transaction.rawManifest,
    );
    await this.input.privateStore.releaseDirectoryClaim(transaction.claim, null);
  }

  async readPending(): Promise<{
    phase: ProviderCredentialForgetManifestV1["phase"];
    target: ProviderCredentialForgetTarget;
  } | null> {
    const pending = await this.resume();
    return pending
      ? {
          phase: pending.manifest.phase,
          target: structuredClone(pending.manifest.target),
        }
      : null;
  }

  async #write(
    transaction: ProviderCredentialForgetTransaction,
    manifest: ProviderCredentialForgetManifest,
  ): Promise<void> {
    const validated = validateProviderForgetManifest(manifest);
    const serialized = `${JSON.stringify(validated)}\n`;
    await this.input.privateStore.writeClaimManifest(
      transaction.claim,
      serialized,
      transaction.rawManifest || null,
    );
    const readback = await this.input.privateStore.readClaimManifest(transaction.claim);
    if (readback !== serialized) {
      throw new Error("Provider credential cleanup journal readback failed.");
    }
    transaction.rawManifest = readback;
    transaction.manifest = validated;
  }
}

function validateProviderForgetManifest(value: unknown): ProviderCredentialForgetManifest {
  if (!isRecord(value)) throw new Error("Provider credential cleanup journal is invalid.");
  const keys = Object.keys(value).sort();
  if (value.version === 2) {
    if (
      keys.join(",") !== "backendId,connectionId,phase,target,version"
      || value.backendId !== "kimi-code"
      || (value.phase !== "prepared" && value.phase !== "credential-deleted")
      || typeof value.connectionId !== "string"
      || value.connectionId.length === 0
      || value.connectionId.length > 512
      || !isRecord(value.target)
      || value.target.kind !== "versioned"
      || Object.keys(value.target).sort().join(",") !== "kind,slot"
      || !isRecord(value.target.slot)
      || Object.keys(value.target.slot).sort().join(",") !== "id,kind,version"
      || value.target.slot.version !== 1
      || value.target.slot.kind !== "kimi-code"
      || typeof value.target.slot.id !== "string"
      || !/^v1:kimi-code:[0-9a-f-]{36}$/.test(value.target.slot.id)
    ) throw new Error("Provider credential cleanup journal is invalid.");
    return {
      version: 2,
      phase: value.phase,
      backendId: "kimi-code",
      connectionId: value.connectionId,
      target: {
        kind: "versioned",
        slot: { version: 1, kind: "kimi-code", id: value.target.slot.id },
      },
    };
  }
  if (keys.join(",") !== "connectionId,phase,target,version"
    || value.version !== 1
    || (value.phase !== "prepared" && value.phase !== "credential-deleted")
    || (value.connectionId !== null
      && (typeof value.connectionId !== "string"
        || value.connectionId.length === 0
        || value.connectionId.length > 512))
    || !isRecord(value.target)) {
    throw new Error("Provider credential cleanup journal is invalid.");
  }
  let target: ProviderCredentialForgetTarget;
  if (value.target.kind === "legacy" && Object.keys(value.target).join(",") === "kind") {
    target = { kind: "legacy" };
  } else if (
    value.target.kind === "versioned"
    && Object.keys(value.target).sort().join(",") === "kind,slot"
    && isRecord(value.target.slot)
    && Object.keys(value.target.slot).sort().join(",") === "id,kind,version"
    && value.target.slot.version === 1
    && value.target.slot.kind === "inference"
    && typeof value.target.slot.id === "string"
    && /^v1:inference:[0-9a-f-]{36}$/.test(value.target.slot.id)
  ) {
    target = {
      kind: "versioned",
      slot: { version: 1, kind: "inference", id: value.target.slot.id },
    };
  } else {
    throw new Error("Provider credential cleanup journal is invalid.");
  }
  return {
    version: 1,
    phase: value.phase,
    connectionId: value.connectionId,
    target,
  };
}

function providerForgetBackend(
  manifest: ProviderCredentialForgetManifest,
): "openrouter" | "kimi-code" {
  return manifest.version === 2 ? manifest.backendId : "openrouter";
}

function sameProviderForgetTarget(
  left: ProviderCredentialForgetTarget,
  right: ProviderCredentialForgetTarget,
): boolean {
  return left.kind === right.kind
    && (left.kind === "legacy"
      || (right.kind === "versioned" && left.slot.id === right.slot.id));
}

export async function recoverProviderCredentialForget(input: {
  journal: ProviderCredentialForgetJournal;
  stateStore: ProviderStateStore;
  credentials: {
    delete?(kind: CredentialKind): Promise<boolean>;
    deleteSlot(slot: CredentialSlotRef): Promise<boolean>;
  };
  assertHeld?(): void | Promise<void>;
  onStatePublished?(state: ProviderSetupStateV2): void;
  allowedBackendIds?: readonly ("openrouter" | "kimi-code")[];
}): Promise<{ cleanupPending: boolean }> {
  try {
    await input.assertHeld?.();
    const transaction = await input.journal.resume();
    await input.assertHeld?.();
    if (!transaction) return { cleanupPending: false };
    if (
      input.allowedBackendIds
      && !input.allowedBackendIds.includes(providerForgetBackend(transaction.manifest))
    ) return { cleanupPending: true };
    const result = await settleProviderCredentialForget({
      ...input,
      transaction,
    });
    return { cleanupPending: result.cleanupPending };
  } catch {
    return { cleanupPending: true };
  }
}

async function settleProviderCredentialForget(input: {
  transaction: ProviderCredentialForgetTransaction;
  journal: Pick<ProviderCredentialForgetJournal, "markDeleted" | "complete">;
  stateStore: ProviderStateStore;
  credentials: {
    delete?(kind: CredentialKind): Promise<boolean>;
    deleteSlot(slot: CredentialSlotRef): Promise<boolean>;
  };
  assertHeld?(): void | Promise<void>;
  onStatePublished?(state: ProviderSetupStateV2): void;
  onAuthoritativeMismatch?(state: ProviderSetupStateV2): never;
  initialAuthoritativeState?: ProviderSetupStateV2;
}): Promise<{ cleanupPending: boolean; removed: boolean; retained: boolean }> {
  await input.assertHeld?.();
  const { connectionId, target } = input.transaction.manifest;
  const backendId = providerForgetBackend(input.transaction.manifest);
  let state = input.initialAuthoritativeState
    ? structuredClone(input.initialAuthoritativeState)
    : input.stateStore.read();
  let expectedAuthoritative = structuredClone(state);
  const connection = connectionId === null
    ? undefined
    : state.connections.find((candidate) => candidate.id === connectionId);
  const targetMatches = connection !== undefined
    && connection.backendId === backendId
    && connectionReferencesForgetTarget(connection, target);

  if (targetMatches) {
    state = await input.stateStore.commit(state.revision, (current) => {
      assertProviderForgetAuthoritative(
        current,
        expectedAuthoritative,
        input.onAuthoritativeMismatch,
      );
      const remaining = current.connections.filter((candidate) => candidate.id !== connectionId);
      const defaultRoute = routeHasCommittedConnection(current.defaultRoute, remaining)
        ? current.defaultRoute
        : null;
      const retainCross = current.cross.enabled
        && routeHasCommittedConnection(current.cross.preferredLead, remaining)
        && routeHasCommittedConnection(current.cross.preferredChallenger, remaining);
      return {
        ...current,
        lifecycle: "configured",
        // Keep the exact retiring pointer durable until deletion has been
        // confirmed. The journal plus this pointer make a pre-delete crash
        // retryable without ever falling back to a different credential.
        connections: current.connections,
        defaultRoute,
        cross: retainCross
          ? current.cross
          : { enabled: false, preferredLead: null, preferredChallenger: null },
      };
    });
    expectedAuthoritative = structuredClone(state);
    input.onStatePublished?.(state);
    await input.assertHeld?.();
  }

  const referenced = state.connections.some((candidate) =>
    (!targetMatches || candidate.id !== connectionId)
    && committedConnectionReferencesForgetTarget(candidate, target)
  );
  if (referenced) {
    if (targetMatches) {
      state = await input.stateStore.commit(state.revision, (current) => {
        assertProviderForgetAuthoritative(
          current,
          expectedAuthoritative,
          input.onAuthoritativeMismatch,
        );
        return stateWithoutForgottenConnection(current, connectionId);
      });
      expectedAuthoritative = structuredClone(state);
      input.onStatePublished?.(state);
    }
    await input.assertHeld?.();
    await input.journal.complete(input.transaction);
    await input.assertHeld?.();
    return { cleanupPending: false, removed: false, retained: true };
  }

  let removed = false;
  if (input.transaction.manifest.phase === "prepared") {
    await input.assertHeld?.();
    if (target.kind === "versioned") {
      removed = await input.credentials.deleteSlot(target.slot);
    } else if (input.credentials.delete) {
      removed = await input.credentials.delete("inference");
    } else {
      return { cleanupPending: true, removed: false, retained: false };
    }
    await input.assertHeld?.();
    await input.journal.markDeleted(input.transaction);
    await input.assertHeld?.();
  }
  if (targetMatches) {
    state = await input.stateStore.commit(state.revision, (current) => {
      assertProviderForgetAuthoritative(
        current,
        expectedAuthoritative,
        input.onAuthoritativeMismatch,
      );
      return stateWithoutForgottenConnection(current, connectionId);
    });
    expectedAuthoritative = structuredClone(state);
    input.onStatePublished?.(state);
    await input.assertHeld?.();
  }
  await input.journal.complete(input.transaction);
  await input.assertHeld?.();
  return { cleanupPending: false, removed, retained: false };
}

function assertProviderForgetAuthoritative(
  authoritative: ProviderSetupStateV2,
  expected: ProviderSetupStateV2,
  onMismatch?: (state: ProviderSetupStateV2) => never,
): void {
  if (JSON.stringify(authoritative) === JSON.stringify(expected)) return;
  if (onMismatch) onMismatch(authoritative);
  throw new Error("Provider credential cleanup requires authoritative recovery.");
}

function connectionReferencesForgetTarget(
  connection: ProviderSetupStateV2["connections"][number],
  target: ProviderCredentialForgetTarget,
): boolean {
  return target.kind === "versioned"
    ? connection.credentialSlot === target.slot.id
    : !connection.credentialSlot || connection.credentialSlot === "legacy:inference";
}

function committedConnectionReferencesForgetTarget(
  connection: ProviderSetupStateV2["connections"][number],
  target: ProviderCredentialForgetTarget,
): boolean {
  return target.kind === "versioned"
    ? connection.credentialSlot === target.slot.id
    : connection.backendId === "openrouter"
      && (!connection.credentialSlot || connection.credentialSlot === "legacy:inference");
}

function routeHasCommittedConnection(
  route: RouteIdentityV1 | null,
  connections: ProviderSetupStateV2["connections"],
): boolean {
  if (!route) return false;
  return connections.some((connection) =>
    connection.enabled
    && connection.backendId === route.backendId
    && connection.accountFingerprint === route.accountFingerprint
    && connection.billingRealm === route.billingRealm
  );
}

function stateWithoutForgottenConnection(
  state: ProviderSetupStateV2,
  connectionId: string | null,
): ProviderSetupStateV2 {
  const connections = state.connections.filter((candidate) => candidate.id !== connectionId);
  const defaultRoute = routeHasCommittedConnection(state.defaultRoute, connections)
    ? state.defaultRoute
    : null;
  const retainCross = state.cross.enabled
    && routeHasCommittedConnection(state.cross.preferredLead, connections)
    && routeHasCommittedConnection(state.cross.preferredChallenger, connections);
  return {
    ...state,
    lifecycle: "configured",
    connections,
    defaultRoute,
    cross: retainCross
      ? state.cross
      : { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

export async function recoverProviderCredentialBinding(input: {
  stateStore: ProviderStateStore;
  recover(): Promise<void | { cleanupPending: boolean }>;
  readCredential(
    reference: "legacy:inference" | CredentialSlotRef,
  ): Promise<StoredCredentialStartupState>;
  environmentCredential: string | null;
}): Promise<{
  reference: "legacy:inference" | CredentialSlotRef;
  stored: { kind: "absent" } | { kind: "present"; value: string };
  environment: string | null;
}> {
  const recovery = await input.recover();
  const reference = credentialSlotFromState(input.stateStore.read());
  if (recovery?.cleanupPending) {
    return { reference, stored: { kind: "absent" }, environment: null };
  }
  const selected = providerServiceStartupCredential(
    await input.readCredential(reference),
    input.environmentCredential,
  );
  return { reference, ...selected };
}

export function providerServiceStartupCredential(
  stored: StoredCredentialStartupState,
  environment: string | null,
): {
  stored: { kind: "absent" } | { kind: "present"; value: string };
  environment: string | null;
} {
  if (stored.kind === "absent") {
    return { stored, environment };
  }
  if (stored.kind === "present") {
    try {
      return {
        stored: { kind: "present", value: normalizeProviderSecret(stored.value) },
        environment: null,
      };
    } catch {
      // The unreadable/malformed saved value still shadows the environment;
      // the adapter reports setup-required without placing those bytes in the
      // model-facing service.
    }
  }
  return { stored: { kind: "absent" }, environment: null };
}

class ProviderAuthoritativeSnapshotRead extends Error {
  constructor(readonly state: ProviderSetupStateV2) {
    super("Provider authoritative snapshot read completed.");
    this.name = "ProviderAuthoritativeSnapshotRead";
  }
}

async function readAuthoritativeProviderState(
  stateStore: ProviderStateStore,
): Promise<ProviderSetupStateV2> {
  const expectedRevision = stateStore.read().revision;
  try {
    await stateStore.commit(expectedRevision, (authoritative) => {
      throw new ProviderAuthoritativeSnapshotRead(structuredClone(authoritative));
    });
  } catch (error) {
    if (error instanceof ProviderAuthoritativeSnapshotRead) {
      return structuredClone(error.state);
    }
    throw error;
  }
  throw new Error("Provider authoritative snapshot read did not settle.");
}

export function createProviderCredentialController(input: {
  stateStore: ProviderStateStore;
  openRouter: OpenRouterService;
  credentialAuthority?: ProviderCredentialAuthorityLike;
  credentials: {
    location?: string;
    set?(kind: CredentialKind, secret: string): Promise<void>;
    delete?(kind: CredentialKind): Promise<boolean>;
    deleteSlot(slot: CredentialSlotRef): Promise<boolean>;
  };
  activationCoordinator: Pick<
    ProviderActivationCoordinator,
    "activate" | "runExclusive" | "recoverAndRun"
  >;
  forgetJournal?: Pick<
    ProviderCredentialForgetJournal,
    "begin" | "markDeleted" | "complete"
  >;
  getInferenceRoute?(): RouteIdentityV1;
  onInferenceStatePublished?(state: ProviderSetupStateV2): void;
  onInferenceReady?(route: RouteIdentityV1, persisted: boolean, candidate: string): void;
  onInferenceForgotten?(): void;
}): ProviderCredentialIntentPort {
  const inferenceRoute = (): RouteIdentityV1 => {
    const route = input.getInferenceRoute?.() ?? input.stateStore.read().defaultRoute;
    if (!route?.canonicalModelId || route.resolutionState !== "resolved") {
      throw new ProviderSetupRequiredError();
    }
    return route;
  };
  return {
    async apply(intent) {
      if (intent.credentialKind === "inference" && intent.kind !== "forget") {
        const state = input.stateStore.read();
        const route = inferenceRoute();
        const selected = selectOpenRouterBinding(state, { kind: "route", route });
        if (selected.kind === "ambiguous" || selected.kind === "invalid-pointer") {
          throw new ProviderSetupRequiredError();
        }
        const targetConnection = selected.kind === "exact"
          ? state.connections.find((connection) => connection.id === selected.binding.connectionId)
          : undefined;
        const effectAttempt = createProviderEffectAttempt();
        const terminalActivation: {
          current: Promise<{ persisted: boolean }> | null;
        } = { current: null };
        const activateCandidate = async (
          candidate: string,
          expectedRevision: number,
          targetConnectionId?: string,
          candidatePermit?: ProviderCandidateCredentialPermit,
        ) => {
          if (terminalActivation.current) throw new ProviderSetupRequiredError();
          terminalActivation.current = (async () => {
            const result = await input.activationCoordinator.activate({
              backendId: "openrouter",
              expectedRevision,
              candidate,
              expectedRequestedModelId: route.requestedModelId,
              selectedCanonicalModelId: route.canonicalModelId!,
              generation: targetConnection?.lastHealth?.generation ?? 0,
              signal: effectAttempt.signal,
              deadlineAt: effectAttempt.deadlineAt,
              persistence: "persisted",
              candidatePermit,
              requireCandidatePermit: candidatePermit !== undefined,
              ...(targetConnectionId ? { targetConnectionId } : {}),
              onPersistenceFailure: intent.kind === "replace" && intent.allowProcessOnly
                ? async () => (await intent.allowProcessOnly!("inference", "Der sichere Credential-Speicher ist nicht verfügbar."))
                  ? "process-only"
                  : "decline"
                : undefined,
            });
            input.onInferenceReady?.(result.route, result.persisted, candidate);
            return { persisted: result.persisted };
          })();
          return terminalActivation.current;
        };
        try {
          let activation: { persisted: boolean };
          if (intent.kind === "save" && selected.kind === "exact") {
            if (!input.credentialAuthority) {
              await input.activationCoordinator.runExclusive(
                { signal: effectAttempt.signal, inspectCommitted: false },
                async (lease) => {
                  await lease.assertHeld();
                  throw new ProviderSetupRequiredError();
                },
              );
              throw new ProviderSetupRequiredError();
            }
            const access = await input.credentialAuthority.withCredential(
              {
                backendId: selected.binding.backendId,
                connectionId: selected.binding.connectionId,
                credentialKind: "inference",
                purpose: "explicit-repair",
                environmentEligibility: "forbidden",
                deadlineAt: effectAttempt.deadlineAt,
                signal: effectAttempt.signal,
              },
              (candidate, context) => {
                if (
                  context.binding.stateRevision !== state.revision
                  || context.binding.connectionId !== selected.binding.connectionId
                  || context.binding.accountFingerprint !== selected.binding.accountFingerprint
                  || context.binding.billingRealm !== selected.binding.billingRealm
                ) {
                  throw new ProviderSetupRequiredError();
                }
                return activateCandidate(
                  candidate,
                  context.binding.stateRevision,
                  context.binding.connectionId,
                  context.candidatePermit,
                );
              },
            );
            if (access.kind === "available") activation = access.value;
            else if (terminalActivation.current) activation = await terminalActivation.current;
            else throw new ProviderSetupRequiredError();
          } else {
            const candidate = intent.kind === "save"
              ? input.openRouter.requireKey()
              : intent.candidate;
            activation = await activateCandidate(
              candidate,
              state.revision,
              targetConnection?.id,
            );
          }
          return {
            kind: "ready",
            credentialKind: "inference",
            persisted: activation.persisted,
          };
        } catch (error) {
          if (terminalActivation.current) {
            const activation = await terminalActivation.current;
            return {
              kind: "ready",
              credentialKind: "inference",
              persisted: activation.persisted,
            };
          }
          throw error;
        } finally {
          effectAttempt.close();
        }
      }

      const signal = new AbortController().signal;
      if (intent.credentialKind === "inference") {
        if (intent.kind !== "forget") {
          throw new Error("Unsupported inference credential intent.");
        }
        try {
          const result = await input.activationCoordinator.recoverAndRun(
            { signal, inspectCommitted: false },
            async (lease: ProviderCoordinatorLease) => {
              if (!input.forgetJournal) {
                throw new Error("Provider credential cleanup journal is unavailable.");
              }
              if (intent.authorize && !intent.authorize()) {
                throw new Error("Provider confirmation authorization was rejected.");
              }
              await lease.assertHeld();
              const state = intent.targetConnectionId
                ? input.stateStore.read()
                : await readAuthoritativeProviderState(input.stateStore);
              await lease.assertHeld();
              const openRouterConnections = state.connections.filter((candidate) =>
                candidate.backendId === "openrouter"
              );
              if (!intent.targetConnectionId && openRouterConnections.length > 1) {
                return {
                  kind: "unchanged" as const,
                  credentialKind: "inference" as const,
                  reason: "shared-reference" as const,
                };
              }
              const connection = intent.targetConnectionId
                ? state.connections.find((candidate) =>
                    candidate.backendId === "openrouter"
                    && candidate.id === intent.targetConnectionId
                    && candidate.credentialSlot === intent.targetCredentialSlot
                  )
                : openRouterConnections[0];
              if (intent.targetConnectionId && !connection) {
                throw new Error("Provider confirmation target changed.");
              }
              const target: ProviderCredentialForgetTarget =
                connection?.credentialSlot?.startsWith("v1:inference:")
                  ? {
                      kind: "versioned",
                      slot: {
                        version: 1,
                      kind: "inference",
                      id: connection.credentialSlot,
                    },
                    }
                  : { kind: "legacy" };
              await lease.assertHeld();
              const forgetTransaction = await input.forgetJournal.begin({
                connectionId: connection?.id ?? null,
                target,
              });
              const settled = await settleProviderCredentialForget({
                transaction: forgetTransaction,
                journal: input.forgetJournal,
                stateStore: input.stateStore,
                credentials: input.credentials,
                assertHeld: () => lease.assertHeld(),
                onStatePublished: input.onInferenceStatePublished,
                onAuthoritativeMismatch: intent.onAuthoritativeMismatch,
                initialAuthoritativeState: intent.targetConnectionId ? undefined : state,
              });
              if (settled.cleanupPending) throw new Error("cleanup-pending");
              await lease.assertHeld();
              if (!settled.retained) {
                input.openRouter.forgetKey();
                await lease.assertHeld();
                if (intent.onForgotten) intent.onForgotten();
                else input.onInferenceForgotten?.();
              }
              return {
                kind: "forgotten" as const,
                credentialKind: "inference" as const,
                removed: settled.removed,
                retained: settled.retained,
              };
            },
          );
          return result.value;
        } catch (error) {
          if (error instanceof ProviderConfirmationStaleError) throw error;
          throw new Error(
            "Provider credential cleanup is pending and will resume on restart.",
          );
        }
      }

      return input.activationCoordinator.runExclusive({ signal }, async (lease) => {
        await lease.assertHeld();
        if (intent.kind === "forget") {
          await lease.assertHeld();
          const removed = await input.credentials.delete?.("management") ?? false;
          await lease.assertHeld();
          input.openRouter.forgetManagementKey();
          await lease.assertHeld();
          return { kind: "forgotten", credentialKind: "management", removed };
        }
        const candidate = intent.kind === "save"
          ? input.openRouter.requireManagementKey()
          : normalizeProviderSecret(intent.candidate);
        await lease.assertHeld();
        const credits = await input.openRouter.validateManagementKey(candidate);
        await lease.assertHeld();
        let persisted = true;
        try {
          if (!input.credentials.set) throw new Error("Credential persistence unavailable.");
          await lease.assertHeld();
          await input.credentials.set("management", candidate);
          await lease.assertHeld();
        } catch (error) {
          await lease.assertHeld();
          if (
            intent.kind !== "replace"
            || !intent.allowProcessOnly
            || !(await intent.allowProcessOnly("management", "Der sichere Credential-Speicher ist nicht verfügbar."))
          ) {
            throw error;
          }
          persisted = false;
          await lease.assertHeld();
        }
        await lease.assertHeld();
        input.openRouter.activateValidatedManagementKey(
          candidate,
          persisted ? "keychain" : "interactive",
          credits,
        );
        await lease.assertHeld();
        return { kind: "ready", credentialKind: "management", persisted, credits };
      });
    },
  };
}

export function createAutomaticEnvironmentSetupSurface(
  requestedModel: string,
): SetupSurface {
  return {
    async chooseHub(entries) {
      return entries.some((entry) => entry.id === "cross-later")
        ? "cross-later"
        : null;
    },
    async readSecret() {
      return null;
    },
    async chooseModel(request) {
      const exact = request.models.filter((model) =>
        model.backendId === "openrouter"
        && model.requestedModelId === requestedModel
        && model.capabilities.textInput
        && model.capabilities.textOutput
        && model.capabilities.tools
      );
      return exact.length === 1 ? exact[0]!.canonicalModelId : null;
    },
    async confirm() {
      return false;
    },
    present() {},
  };
}

/**
 * Commits only the raw top-level `providerSetup` value while holding the
 * canonical config writer. Setup inspection and legacy resolution therefore
 * share Task 5's exact-CAS boundary without rewriting unrelated config bytes.
 */
export async function persistProviderSetupState(
  path: string,
  request: ProviderStateCommitRequest,
): Promise<ProviderSetupStateV2> {
  try {
    return await persistProviderSetupStateOwned(path, request);
  } catch (error) {
    if (
      error instanceof ProviderConfirmationStaleError
      || error instanceof ProviderAuthoritativeSnapshotRead
      || error instanceof ProviderAuthoritySnapshot
    ) throw error;
    throw new Error("Provider state publication failed.");
  }
}

async function persistProviderSetupStateOwned(
  path: string,
  request: ProviderStateCommitRequest,
): Promise<ProviderSetupStateV2> {
  return withConfigWriteLock(path, async (ownership) => {
    await ownership.assertHeld();
    const target = await readConfigFileSnapshot(ownership.canonicalPath);
    await ownership.assertHeld();
    const raw = target.kind === "file"
      ? target.raw
      : `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Provider state publication requires a valid config.");
    }
    if (!isRecord(parsed) || !("providerSetup" in parsed)) {
      throw new Error("Provider state publication requires a valid config.");
    }
    const current = requirePersistableProviderState(
      validateProviderSetupState(parsed.providerSetup),
    );
    if (current.revision !== request.expectedRevision) {
      throw new Error("Provider state publication revision is stale.");
    }
    const span = findStartupTopLevelJsonValue(raw, "providerSetup");
    if (!span) {
      throw new Error("Provider state publication requires an exact config field.");
    }

    request.assertCurrent();
    const built = request.build(current);
    const candidate = requirePersistableProviderState(
      validateProviderSetupState(built),
    );
    if (
      candidate.revision !== request.expectedRevision + 1
      || JSON.stringify(candidate) !== JSON.stringify(built)
    ) {
      throw new Error("Provider state publication candidate is invalid.");
    }
    const nextRaw = `${raw.slice(0, span.start)}${JSON.stringify(candidate)}${raw.slice(span.end)}`;
    request.assertCurrent();
    await ownership.assertHeld();
    let writeError: unknown;
    try {
      const publish = target.kind === "absent"
        ? writeFileAtomicCreateSecure
        : writeFileAtomicSecure;
      await publish(
        ownership.canonicalPath,
        nextRaw,
        async () => {
          await ownership.assertHeld();
          await assertConfigFileSnapshot(ownership.canonicalPath, target);
          await ownership.assertHeld();
          request.assertCurrent();
        },
        () => {
          request.assertCurrent();
        },
      );
    } catch (error) {
      if (!isAtomicFilePostPublicationError(error)) throw error;
      writeError = error;
    }
    await ownership.assertHeld();
    const readback = await readConfigFileSnapshot(ownership.canonicalPath);
    await ownership.assertHeld();
    if (readback.kind !== "file" || readback.raw !== nextRaw) {
      if (writeError !== undefined) throw writeError;
      throw new Error("Provider state publication could not be verified.");
    }
    adoptDurablyCommittedProviderState(request, candidate);
    return structuredClone(candidate);
  });
}

function findStartupTopLevelJsonValue(
  raw: string,
  wantedKey: string,
): { start: number; end: number } | null {
  let index = skipStartupJsonWhitespace(raw, 0);
  if (raw[index] !== "{") return null;
  index = skipStartupJsonWhitespace(raw, index + 1);
  let found: { start: number; end: number } | null = null;
  while (index < raw.length && raw[index] !== "}") {
    const keyEnd = scanStartupJsonString(raw, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(index, keyEnd));
    } catch {
      return null;
    }
    index = skipStartupJsonWhitespace(raw, keyEnd);
    if (raw[index] !== ":") return null;
    const start = skipStartupJsonWhitespace(raw, index + 1);
    const end = scanStartupJsonValue(raw, start);
    if (end === null) return null;
    if (key === wantedKey) {
      if (found) return null;
      found = { start, end };
    }
    index = skipStartupJsonWhitespace(raw, end);
    if (raw[index] === ",") {
      index = skipStartupJsonWhitespace(raw, index + 1);
    } else if (raw[index] !== "}") {
      return null;
    }
  }
  return found;
}

function skipStartupJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
  return index;
}

function scanStartupJsonString(raw: string, start: number): number | null {
  if (raw[start] !== '"') return null;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") index += 1;
    else if (raw[index] === '"') return index + 1;
  }
  return null;
}

function scanStartupJsonValue(raw: string, start: number): number | null {
  if (raw[start] === '"') return scanStartupJsonString(raw, start);
  if (raw[start] === "{" || raw[start] === "[") {
    const stack = [raw[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < raw.length; index += 1) {
      if (raw[index] === '"') {
        const end = scanStartupJsonString(raw, index);
        if (end === null) return null;
        index = end - 1;
      } else if (raw[index] === "{") stack.push("}");
      else if (raw[index] === "[") stack.push("]");
      else if (raw[index] === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return null;
  }
  let index = start;
  while (index < raw.length && !/[\s,}\]]/.test(raw[index]!)) index += 1;
  return index > start ? index : null;
}

async function adoptRecoveredStartupOwners(
  startup: StartupStorageResult,
  recovered: readonly RecoveredModelPreferenceOwner[],
  lease: Pick<ProviderCoordinatorLease, "assertHeld">,
): Promise<void> {
  const configRecovered = recovered.some((owner) =>
    resolve(owner.configPath) === resolve(startup.configPath));
  const sessionRecovered = recovered.some((owner) =>
    resolve(owner.sessionPath) === resolve(startup.session.path));
  if (!configRecovered && !sessionRecovered) return;

  let recoveredConfig: OrcodeConfigWithBudget | null = null;
  let recoveredSessionPublication: ReturnType<
    SessionStore["prepareRecoveredPreferencePublication"]
  > | null = null;
  if (configRecovered) {
    await lease.assertHeld();
    recoveredConfig = structuredClone(
      (await readConfigEditSnapshot(startup.configPath)).config,
    );
    await lease.assertHeld();
  }
  if (sessionRecovered) {
    await lease.assertHeld();
    const snapshot = await readSessionEditSnapshot(startup.session.path);
    await lease.assertHeld();
    recoveredSessionPublication = startup.session.prepareRecoveredPreferencePublication(
      snapshot,
    );
  }
  // This is the final awaited authority fence. Both following publications
  // use already-cloned values and contain assignments only.
  await lease.assertHeld();
  if (recoveredConfig) {
    Object.assign(startup.config, recoveredConfig);
  }
  recoveredSessionPublication?.publish();
}

export async function createDefaultProviderRuntime(
  input: ProviderRuntimeInput,
): Promise<ProviderRuntime> {
  const { startup, environment } = input;
  const credentials = createCredentialStoreForStartup(startup.appHome);
  const stateStore = new ProviderStateStore(startup.config.providerSetup, {
    persist: (request) => persistProviderSetupState(startup.configPath, request),
  });
  const runtimeGuard = new SessionProviderRuntimeGuard();
  const privateStore = new PrivateStore({ root: startup.appHome });
  const forgetJournal = new ProviderCredentialForgetJournal({
    appHome: startup.appHome,
    privateStore,
  });

  // Construction is deliberately credential-free. Recovery and every read
  // run inside the one bounded startup attempt below.
  const openRouter = createOpenRouterServiceForStartup({
    storedInferenceKey: { kind: "absent" },
    environmentInferenceKey: null,
    storedManagementKey: { kind: "absent" },
    environmentManagementKey: null,
  });
  let activationCoordinator: ProviderActivationCoordinator | null = null;
  const credentialAuthority = new ProviderCredentialAuthority({
    stateStore,
    credentials,
    environment,
    coordinator: () => {
      if (!activationCoordinator) throw new ProviderSetupRequiredError();
      return activationCoordinator;
    },
  });
  const adapter = new OpenRouterBackendAdapter({
    service: openRouter,
    credentials,
    credentialAuthority,
  });
  const kimiAdapter: KimiCodeBackendAdapter | KimiExecutionPolicyAdapter =
    input.executionMode === "local-interactive-owner"
      ? new KimiCodeBackendAdapter({
          service: new KimiCodeService(),
          credentials,
          credentialAuthority,
        })
      : new KimiExecutionPolicyAdapter();
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: kimiAdapter },
    { descriptor: ANTHROPIC_COMING_SOON_DESCRIPTOR },
  ]);
  activationCoordinator = new ProviderActivationCoordinator({
    appHome: startup.appHome,
    configPath: startup.configPath,
    privateStore,
    credentials,
    adapterResolver: (backendId) => registry.adapter(backendId),
    stateStore,
    runtimeGuard,
    candidateAuthority: credentialAuthority,
  });
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator,
  });
  let runtimeOwner: DefaultProviderRuntime | null = null;
  const providerCredentials = createProviderCredentialController({
    stateStore,
    openRouter,
    credentialAuthority,
    credentials,
    activationCoordinator,
    forgetJournal,
    getInferenceRoute: () => {
      if (!runtimeOwner) throw new ProviderSetupRequiredError();
      return runtimeOwner.ensureRunnableRoute();
    },
    onInferenceReady: (route, persisted, candidate) => {
      runtimeOwner?.adoptCredentialActivation(route, persisted, candidate);
    },
    onInferenceStatePublished: (state) => {
      startup.config.providerSetup = requirePersistableProviderState(state);
    },
    onInferenceForgotten: () => runtimeOwner?.adoptCredentialForget(),
  });
  const automaticEnvironment = stateStore.read().lifecycle === "never-configured"
      && stateStore.read().connections.length === 0
    ? environment.OPENROUTER_API_KEY ?? null
    : null;
  runtimeOwner = new DefaultProviderRuntime(
    openRouter,
    credentials,
    registry,
    stateStore,
    orchestrator,
    activationCoordinator,
    runtimeGuard,
    providerCredentials,
    null,
    automaticEnvironment,
    input.requestedModel ?? startup.config.mainModel,
    startup.config,
    startup.session,
    {
      credentialAuthority,
      adapter,
      forgetJournal,
      ...(kimiAdapter instanceof KimiCodeBackendAdapter ? { kimiAdapter } : {}),
      recover: async (context) => {
        const allowedBackendIds = input.executionMode === "local-interactive-owner"
          ? undefined
          : (["openrouter"] as const);
        await activationCoordinator!.recoverAndRun(
          {
            signal: context.signal,
            inspectCommitted: true,
            ...(allowedBackendIds ? { allowedBackendIds } : {}),
          },
          async (lease) => {
            await recoverProviderCredentialForget({
              journal: forgetJournal,
              stateStore,
              credentials,
              assertHeld: () => lease.assertHeld(),
              onStatePublished: (state) => {
                startup.config.providerSetup = requirePersistableProviderState(state);
              },
              ...(allowedBackendIds ? { allowedBackendIds } : {}),
            });
            const recovered = await recoverModelPreferenceTransactions({
              appHome: startup.appHome,
              routeAuthority: {
                assertHeld: () => lease.assertHeld(),
                async read() {
                  const snapshot = runtimeOwner?.readModelPreferenceAuthority();
                  if (!snapshot) throw new ProviderSetupRequiredError();
                  return snapshot;
                },
              },
              ...(allowedBackendIds ? { allowedBackendIds } : {}),
            });
            await lease.assertHeld();
            await adoptRecoveredStartupOwners(startup, recovered, lease);
          },
        );
      },
    },
    input.executionMode,
  );
  return runtimeOwner;
}

export interface PlainRunInput extends Omit<RuntimeContext, "agent"> {
  agent: OrcodeAgent | null;
  ensureAgentForPrompt(surface?: SetupSurface): Promise<OrcodeAgent>;
  resumeFlag?: boolean;
  noResumeFlag?: boolean;
  /** Test/integration seam for a temporary Settings owner in plain mode. */
  createTemporarySettingsUi?: () => TerminalUi;
  /** Scripted line source; production deliberately falls back to Inquirer. */
  readPlainInput?: () => Promise<string>;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
}

/** The one deliberately small boundary between `/settings` parsing and an interactive owner UI. */
export interface SettingsSessionDependencies {
  open(): Promise<void>;
}

export interface SettingsCommandPortInput {
  readonly executionMode: ProviderExecutionMode;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly createSession: () => Promise<SettingsSessionDependencies>;
}

/**
 * Fences Settings before creating its controller, reading config, or touching
 * any provider surface.  The lazy session factory also prevents a rejected
 * command from accumulating UI resources.
 */
export function createSettingsCommandPort(
  input: SettingsCommandPortInput,
): SettingsCommandPort | undefined {
  if (
    input.executionMode !== "local-interactive-owner"
    || !input.stdinIsTty
    || !input.stdoutIsTty
  ) return undefined;
  return Object.freeze({
    async open(): Promise<void> {
      const session = await input.createSession();
      await session.open();
    },
  });
}

export async function runSettingsTerminalOwner(
  surface: Pick<TerminalUi, "start" | "stop">,
  ownsTerminal: boolean,
  run: () => Promise<void>,
): Promise<void> {
  if (ownsTerminal) surface.start();
  try {
    await run();
  } finally {
    if (ownsTerminal) surface.stop();
  }
}

export function createSettingsSession(
  context: RuntimeContext,
  surface: TerminalUi,
  ownsTerminal: boolean,
): SettingsSessionDependencies {
  return {
    async open(): Promise<void> {
      await runSettingsTerminalOwner(surface, ownsTerminal, async () => {
        const snapshotPort = createSettingsRuntimeSnapshotPort({
          config: context.config,
          runtime: {
            activity: () => context.providerRuntime.activity?.()
              ?? context.providerRuntime.settingsActivity?.()
              ?? { runActive: false, activationHeld: false },
            readCachedSettingsRoute: () => context.providerRuntime.readCachedSettingsRoute?.()
              ?? context.providerRuntime.readCachedSettingsProjection?.().route
              ?? null,
            readCachedProviderStatus: () => context.providerRuntime.readCachedProviderStatus?.()
              ?? [],
            readCachedSettingsModels: () => readProviderAwareSettingsModels(context),
          },
          session: context.session,
          ruleStore: context.ruleStore,
          workspace: context.workspace,
        });
        const controller = await SettingsController.open({
          configPath: context.configPath,
          snapshots: {
            read: async () => snapshotPort.readCached(),
          },
          externalActions: {
            async execute(action: SettingsExternalAction): Promise<void> {
              if (action.kind === "provider") {
                assertSettingsIdle(context);
                await mapSettingsBusyRace(context, () =>
                  executeSettingsProviderAction(context, surface, action.intent));
                return;
              }
              if (action.kind === "approval-forget") {
                await runSettingsConfigMutation(context, () => context.ruleStore.forget(action.ruleId));
                return;
              }
              if (action.kind === "approval-forget-all") {
                await runSettingsConfigMutation(context, () => context.ruleStore.forgetAll(context.workspace));
                return;
              }
              if (action.kind === "main-model") {
                assertSettingsIdle(context);
                await mapSettingsBusyRace(context, () =>
                  transitionSettingsMainModel(context, surface, action));
                return;
              }
              if (action.kind === "verify-suggest") {
                await suggestSettingsVerifyCommands(context, surface);
                return;
              }
              await persistSettingsExternalConfig(context, (next) => {
                if (action.kind === "compressor-model") next.compressorModel = action.modelId;
                else if (action.kind === "panel-models") next.panelModels = [...action.modelIds];
                else if (action.kind === "transcription-model") next.transcriptionModel = action.modelId;
              });
            },
          },
          liveConfig: {
            prepare(next) {
              return {
                publish: () => {
                  Object.assign(context.config, next);
                  surface.applyAppearance(next.appearance);
                },
              };
            },
          },
          readConfig: readConfigEditSnapshot,
          saveConfig: saveConfigEdit,
          runConfigMutation: (task) => runSettingsConfigMutation(context, task),
        });
        await runSettingsSession(controller, surface);
      });
    },
  };
}

function assertSettingsIdle(context: RuntimeContext): void {
  const activity = context.providerRuntime.activity?.()
    ?? context.providerRuntime.settingsActivity?.();
  if (activity?.runActive || activity?.activationHeld) {
    throw new SettingsRunActiveError();
  }
}

async function mapSettingsBusyRace<T>(
  context: RuntimeContext,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const activity = context.providerRuntime.activity?.()
      ?? context.providerRuntime.settingsActivity?.();
    if (activity?.runActive || activity?.activationHeld
      || /runtime is not idle|lauf aktiv/i.test(errorMessage(error))) {
      throw new SettingsRunActiveError();
    }
    throw error;
  }
}

async function runSettingsConfigMutation<T>(
  context: RuntimeContext,
  task: () => Promise<T>,
): Promise<T> {
  const run = context.providerRuntime.runSettingsConfigMutation;
  if (typeof run !== "function") {
    assertSettingsIdle(context);
    return task();
  }
  try {
    return await context.providerRuntime.runSettingsConfigMutation!(task);
  } catch (error) {
    const activity = context.providerRuntime.activity?.()
      ?? context.providerRuntime.settingsActivity?.();
    if (activity?.runActive || activity?.activationHeld
      || /runtime is not idle|lauf aktiv/i.test(errorMessage(error))) {
      throw new SettingsRunActiveError();
    }
    throw error;
  }
}

async function persistSettingsExternalConfig(
  context: RuntimeContext,
  edit: (candidate: OrcodeConfigWithBudget) => void,
): Promise<void> {
  await runSettingsConfigMutation(context, async () => {
    const expected = await readConfigEditSnapshot(context.configPath);
    const candidate = structuredClone(expected.config);
    edit(candidate);
    const saved = await saveConfigEdit(expected, candidate, context.configPath);
    Object.assign(context.config, saved);
  });
}

async function executeSettingsProviderAction(
  context: RuntimeContext,
  surface: TerminalUi,
  intent: ProviderCommandIntent,
): Promise<void> {
  const setupSurface = createSettingsSetupSurface(surface);
  await runSettingsProviderAction({
    intent,
    surface: setupSurface,
    execute: (next, nextSurface) => context.providerCommands.execute(next, nextSurface),
    confirm: (message) => surface.confirmAction(
      "Provider ändern?",
      message,
      false,
    ).then((result) => result.accepted),
  });
}

export async function runSettingsProviderAction(input: {
  readonly intent: ProviderCommandIntent;
  readonly surface: SetupSurface;
  readonly execute: (
    intent: ProviderCommandIntent,
    surface: SetupSurface,
  ) => Promise<ProviderCommandResult>;
  readonly confirm: (message: string) => Promise<boolean>;
}): Promise<void> {
  let result = await input.execute(input.intent, input.surface);
  if (result.kind !== "confirmation-required") return;
  if (input.intent.kind !== result.operation
    || !("backendId" in input.intent)
    || input.intent.backendId !== result.backendId) {
    throw new Error("Provider-Bestätigung ist nicht an die angeforderte Aktion gebunden.");
  }
  if (!await input.confirm(result.message)) throw new SettingsExternalActionCancelledError();
  const operation = result.operation;
  const backendId = result.backendId;
  result = await input.execute({
    kind: operation,
    backendId,
    confirmationToken: result.confirmationToken,
  }, input.surface);
  if (result.kind === "confirmation-required"
    || (result.kind === "changed"
      && (result.operation !== operation || result.backendId !== backendId))) {
    throw new Error("Provider-Bestätigung konnte nicht autoritativ abgeschlossen werden.");
  }
}

async function transitionSettingsMainModel(
  context: RuntimeContext,
  surface: TerminalUi,
  action: Extract<SettingsExternalAction, { kind: "main-model" }>,
): Promise<void> {
  const beforeRoute = context.providerRuntime.currentSessionRoute();
  const afterRoute = validateRouteIdentityV1({
    ...structuredClone(beforeRoute),
    requestedModelId: action.requestedModelId,
    canonicalModelId: action.canonicalModelId,
    resolutionState: "resolved",
  });
  if (!afterRoute || !afterRoute.canonicalModelId) throw new ProviderSetupRequiredError();

  const expectedConfig = await readConfigEditSnapshot(context.configPath);
  const expectedSession = await readSessionEditSnapshot(context.session.path);
  const nextSession = prepareSessionPreferenceEdit(expectedSession, {
    requestedModelId: action.requestedModelId,
    reasoning: getReasoningSetting(expectedConfig.config, action.requestedModelId),
    route: afterRoute,
  });
  const sessionPublication = context.session.preparePreferencePublication(
    expectedSession,
    nextSession,
  );
  const runtimePublication = context.providerRuntime.prepareSettingsModelPublication?.(afterRoute);
  if (!runtimePublication) throw new ProviderSetupRequiredError();
  let finalConfig: OrcodeConfigWithBudget | null = null;
  const routeAuthority = createModelPreferenceRouteAuthority({
    runtime: context.providerRuntime,
    candidate: action,
    surface: createSettingsSetupSurface(surface),
  });
  await runModelPreferenceTransaction({
    appHome: context.session.appHome,
    configPath: context.configPath,
    sessionPath: context.session.path,
    expectedConfig,
    nextConfig(nextProviderState) {
      const candidate = validateConfig({
        ...structuredClone(expectedConfig.config),
        mainModel: action.requestedModelId,
        providerSetup: structuredClone(nextProviderState),
      });
      finalConfig = candidate;
      return candidate;
    },
    expectedSession,
    nextSession,
    beforeRoute,
    afterRoute,
    routeAuthority,
    publish() {
      Object.assign(context.config, finalConfig!);
      sessionPublication.publish();
      runtimePublication.publish();
    },
  });
}

async function suggestSettingsVerifyCommands(
  context: RuntimeContext,
  surface: TerminalUi,
): Promise<void> {
  const packagePath = await context.localRuntime.guard.resolvePath("package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  await runSettingsVerifySuggestion({
    packageJson: parsed,
    confirm: (commands) => surface.confirmAction(
      "Prüfkommandos übernehmen?",
      commands.join("\n"),
      false,
    ).then((result) => result.accepted),
    persist: (commands) => persistSettingsExternalConfig(context, (next) => {
      next.verify = { ...next.verify, commands: [...commands] };
    }),
  });
}

export async function runSettingsVerifySuggestion(input: {
  readonly packageJson: unknown;
  readonly confirm: (commands: readonly string[]) => Promise<boolean>;
  readonly persist: (commands: readonly string[]) => Promise<void>;
}): Promise<void> {
  const commands = Object.freeze(suggestVerifyCommands(input.packageJson));
  if (commands.length === 0) {
    throw new Error("Keine passenden Prüfkommandos in package.json gefunden.");
  }
  if (!await input.confirm(commands)) {
    throw new SettingsExternalActionCancelledError();
  }
  await input.persist(commands);
}

export interface DashboardRunInput extends PlainRunInput {
  setupRequired: boolean;
  showChatPickerOnStart?: boolean;
}

export interface CliBootstrapDeps {
  initializeStorage: typeof initializeStartupStorage;
  createProviderRuntime(input: ProviderRuntimeInput): Promise<ProviderRuntime>;
  createAgent(input: Parameters<typeof OrcodeAgent.create>[0]): Promise<OrcodeAgent>;
  runPlain(input: PlainRunInput): Promise<void>;
  runDashboard(input: DashboardRunInput): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Trusted launchers may only downgrade a local interactive owner process. */
  executionMode?: ProviderExecutionMode;
}

const defaultCliBootstrapDeps: CliBootstrapDeps = {
  initializeStorage: initializeStartupStorage,
  createProviderRuntime: createDefaultProviderRuntime,
  createAgent: (input) => OrcodeAgent.create(input),
  runPlain: async (input) => runPlainLoop(input, {
    resume: input.resumeFlag === true,
    noResume: input.noResumeFlag === true,
  }),
  runDashboard,
  stdout: process.stdout,
  stderr: process.stderr,
  environment: process.env,
};

export interface NonInteractiveProviderFailure {
  type: "error";
  code: "provider-setup-required";
  headline: "setup-required";
  retryable: true;
  hint: "/provider setup";
}

export function renderNonInteractiveProviderFailure(
  json: boolean,
  deps: Pick<CliBootstrapDeps, "stdout" | "stderr">,
): void {
  const failure: NonInteractiveProviderFailure = {
    type: "error",
    code: "provider-setup-required",
    headline: "setup-required",
    retryable: true,
    hint: "/provider setup",
  };
  if (json) {
    deps.stdout.write(`${JSON.stringify(failure)}\n`);
    return;
  }
  deps.stderr.write(
    "provider-setup-required · setup-required · retryable · /provider setup\n",
  );
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliBootstrapDeps = defaultCliBootstrapDeps,
): Promise<number> {
  const options = parseArgs([...argv]);
  if (options.version) {
    dependencies.stdout.write(`orcode ${readPackageVersion()}\n`);
    return 0;
  }
  if (options.help) {
    dependencies.stdout.write(`${renderCliHelp()}\n`);
    return 0;
  }

  const executionMode = deriveProviderExecutionMode(options, dependencies.executionMode);

  const workspace = resolve(options.workspace);
  const startup = await dependencies.initializeStorage({
    workspace,
    newChat: options.newChat,
    ...(options.chatId ? { chatId: options.chatId } : {}),
  });
  if (startup.migrationWarning) {
    dependencies.stderr.write(`${startup.migrationWarning}\n`);
  }
  for (const warning of startup.retentionWarnings) {
    dependencies.stderr.write(`${warning}\n`);
  }
  const { config, configPath: runtimeConfigPath, ruleStore, session } = startup;
  let currentSession = session;
  const configWarning = consumeConfigWarning();
  if (configWarning) dependencies.stderr.write(`${configWarning}\n`);
  if (options.approval) {
    if (!isApprovalMode(options.approval)) {
      throw new CliUsageError(`Ungültiger Approval-Modus: ${options.approval}`);
    }
    config.approvalMode = options.approval;
  }
  if (options.compression) {
    if (!isCompressionMode(options.compression)) {
      throw new CliUsageError(`Ungültiger Kompressor-Modus: ${options.compression}`);
    }
    config.compressionMode = options.compression;
  }
  const homeWarning = homeWorkspaceWarning(workspace);
  if (homeWarning) dependencies.stderr.write(`${homeWarning}\n`);

  const providerRuntime = await dependencies.createProviderRuntime({
    startup,
    environment: dependencies.environment ?? process.env,
    requestedModel: options.model ?? config.mainModel,
    executionMode,
  });
  let startupSetup = await providerRuntime.inspectStartup();
  if (startupSetup.defaultRoute?.resolutionState === "legacy-unverified") {
    startupSetup = await providerRuntime.resolveLegacyDefaultRoute();
  }

  const approvals = new ApprovalManager(config.approvalMode);
  approvals.setRuleStore(ruleStore, workspace);
  const sshSession = createSshSession();
  const useTui = Boolean(
    !options.prompt
    && !options.plain
    && !options.json
    && process.stdin.isTTY
    && process.stdout.isTTY
  );
  const nonInteractive = options.prompt !== undefined || options.json;
  const out = options.json ? createStderrCommandOutput() : createPlainCommandOutput();
  let agent: OrcodeAgent | null = null;
  let agentRuntime: ModelRuntime | null = null;
  let agentSession: SessionStore | null = null;

  const bindAgentForRoute = async (route: RouteIdentityV1): Promise<OrcodeAgent> => {
    const routeRuntime = typeof providerRuntime.modelRuntime === "function"
      ? providerRuntime.modelRuntime(route)
      : null;
    const runtimeBinding: ModelRuntimeBindingIdentityV1 | undefined = routeRuntime
      ? readModelRuntimeIdentity(routeRuntime) ?? undefined
      : undefined;
    if (!agent) {
      agent = await dependencies.createAgent({
        ...(routeRuntime
          ? { runtime: routeRuntime, runtimeBinding, route }
          : { openRouter: providerRuntime.openRouter }),
        approvals,
        session: currentSession,
        config,
        workspace,
        sshSession,
      });
      agentRuntime = routeRuntime;
      agentSession = currentSession;
    } else if (
      routeRuntime
      && typeof agent.rebind === "function"
      && (agentRuntime !== routeRuntime || agentSession !== currentSession)
    ) {
      if (!runtimeBinding) throw new ProviderSetupRequiredError();
      agent.rebind({ session: currentSession, route, runtime: routeRuntime, runtimeBinding });
      agentRuntime = routeRuntime;
      agentSession = currentSession;
    }
    return agent;
  };

  const ensureAgentForPrompt = async (surface?: SetupSurface): Promise<OrcodeAgent> => {
    let route: RouteIdentityV1;
    try {
      route = providerRuntime.ensureRunnableRoute();
    } catch (error) {
      if (!(error instanceof ProviderSetupRequiredError) &&
        (typeof error !== "object" || error === null || !("code" in error) || error.code !== "provider-setup-required")) {
        throw error;
      }
      const setup = await providerRuntime.runSetup(surface ?? "plain");
      if (setup.kind !== "ready") throw new ProviderSetupRequiredError();
      route = providerRuntime.ensureRunnableRoute();
    }
    if (
      options.model
      && options.model !== route.requestedModelId
      && options.model !== route.canonicalModelId
    ) {
      if (nonInteractive) throw new ProviderSetupRequiredError();
      const setup = await providerRuntime.runSetup(surface ?? "plain");
      if (setup.kind !== "ready") throw new ProviderSetupRequiredError();
      route = providerRuntime.ensureRunnableRoute();
      if (
        options.model !== route.requestedModelId
        && options.model !== route.canonicalModelId
      ) {
        throw new ProviderSetupRequiredError();
      }
    }
    if (!options.model && currentSession.data.reasoning) {
      setReasoningSetting(config, currentSession.data.reasoning);
    }
    config.mainModel = route.requestedModelId;
    currentSession.setPreferences(config.mainModel, getReasoningSetting(config), route);
    return bindAgentForRoute(route);
  };

  if (nonInteractive) {
    try {
      // Non-interactive starts prove readiness before entering the helper that
      // is allowed to open an interactive setup surface.
      providerRuntime.ensureRunnableRoute();
    } catch (error) {
      if (error instanceof ProviderSetupRequiredError ||
        (typeof error === "object" && error !== null && "code" in error && error.code === "provider-setup-required")) {
        renderNonInteractiveProviderFailure(options.json, dependencies);
        return 1;
      }
      throw error;
    }
    const prompt = options.prompt ?? (!process.stdin.isTTY ? await readStdinPrompt() : "");
    if (!prompt.trim()) {
      throw new CliUsageError(
        "Kein Prompt: --json braucht -p/--prompt oder eine nicht-interaktive stdin.",
      );
    }
    const effectivePrompt = await applyInterruptedRunNonInteractive(
      currentSession,
      options,
      out,
      prompt,
    );
    const execute = (boundAgent: OrcodeAgent) =>
      runNonInteractive(boundAgent, effectivePrompt, { json: options.json });
    if (typeof providerRuntime.runWithReadyRoute === "function") {
      return providerRuntime.runWithReadyRoute(async (route) => {
        if (
          options.model
          && options.model !== route.requestedModelId
          && options.model !== route.canonicalModelId
        ) throw new ProviderSetupRequiredError();
        if (!options.model && currentSession.data.reasoning) {
          setReasoningSetting(config, currentSession.data.reasoning);
        }
        config.mainModel = route.requestedModelId;
        currentSession.setPreferences(config.mainModel, getReasoningSetting(config), route);
        assertModelBoundToRoute(config.mainModel, route);
        const boundAgent = await bindAgentForRoute(route);
        return execute(boundAgent);
      });
    }
    providerRuntime.ensureRunnableRoute();
    return execute(await ensureAgentForPrompt());
  }

  let interactiveSetupReady = true;
  if (startupSetup.mode === "setup-required" || startupSetup.mode === "route-choice-required") {
    if (!useTui) {
      interactiveSetupReady = (await providerRuntime.runSetup("plain")).kind === "ready";
    } else {
      interactiveSetupReady = false;
    }
  }
  const localRuntime: CommandLocalRuntime = {
    guard: await WorkspaceGuard.create(workspace),
    journal: new ChangeJournal({
      appHome: currentSession.appHome,
      chatId: currentSession.data.id,
    }),
    setSession(next) {
      this.journal = new ChangeJournal({ appHome: next.appHome, chatId: next.data.id });
    },
    resetConversationMemory() {},
  };

  const common = {
    executionMode,
    workspace,
    configPath: runtimeConfigPath,
    config,
    approvals,
    openRouter: providerRuntime.openRouter,
    session: currentSession,
    agent,
    credentials: providerRuntime.credentials,
    providerCredentials: providerRuntime.providerCredentials,
    providerCommands: providerRuntime,
    providerRoutes: providerRuntime,
    providerRouteSurface: "plain",
    localRuntime,
    out,
    ruleStore,
    sshSession,
    providerRuntime,
    commitSessionHandoff(next: SessionStore) {
      const previousRoute = validateRouteIdentityV1(currentSession.data.route);
      const nextRoute = validateRouteIdentityV1(next.data.route);
      providerRuntime.adoptSession(next);
      currentSession = next;
      this.session = next;
      if (
        this.agent
        && previousRoute
        && nextRoute
        && sameExactRoute(previousRoute, nextRoute)
      ) {
        this.agent.setSession(next);
        agentSession = next;
      } else if (this.agent) {
        this.agent = null;
        agent = null;
        agentRuntime = null;
        agentSession = null;
      }
      this.localRuntime.setSession(next);
    },
    ensureAgentForPrompt,
    resumeFlag: options.resume,
    noResumeFlag: options.noResume,
  } satisfies PlainRunInput;
  if (useTui) {
    await dependencies.runDashboard({
      ...common,
      setupRequired: !interactiveSetupReady,
      showChatPickerOnStart:
        !options.newChat && !options.continueChat && !options.chatId,
    });
    return 0;
  }
  if (!options.json) printBanner(workspace, config.mainModel);
  await dependencies.runPlain(common);
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

interface RuntimeContext {
  executionMode: ProviderExecutionMode;
  workspace: string;
  configPath: string;
  config: OrcodeConfigWithBudget;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: OrcodeAgent | null;
  commitSessionHandoff?(session: SessionStore): void;
  localRuntime: CommandLocalRuntime;
  providerCredentials: ProviderCredentialIntentPort;
  providerCommands: ProviderCommandIntentPort;
  providerRoutes: ProviderRouteIntentPort;
  providerRouteSurface: SetupSurface | "plain" | "fullscreen";
  providerRuntime: ProviderRuntime;
  credentials: CredentialStore;
  out: CommandOutput;
  settings?: SettingsCommandPort;
  ruleStore: RuleStore;
  /** `/ssh`'s remembered target — read by the dashboard header, mutated by `sshCommand` in commands.ts. */
  sshSession: SshSession;
  /** See `CommandContext.seedNextMessage` in commands.ts — set by `runPlainLoop`/`runDashboard` below, used by `/resume fortsetzen` and `/panel use <n>`. */
  seedNextMessage?: (text: string) => void;
  /** See `CommandContext.onPanelResult` in commands.ts — set by `runDashboard` only; the plain loop leaves it unset. */
  onPanelResult?: (
    result: PanelResult,
    judgment: PanelJudgment | null,
    expandedIndex: number | null,
  ) => void;
  /** Fullscreen destructive-chat confirmation; plain mode leaves this unset for Inquirer. */
  confirmChatDeletion?: (title: string, details: string) => Promise<boolean>;
  confirmCredentialForget?: CommandContext["confirmCredentialForget"];
  confirmProviderMutation?: CommandContext["confirmProviderMutation"];
  confirmProcessOnlyCredential?: CommandContext["confirmProcessOnlyCredential"];
  readCredentialSecret?: CommandContext["readCredentialSecret"];
  /** Direct slash-command process events (currently `/diff`) for the active dashboard. */
  onRunEvent?: (event: AgentRunEvent) => void;
}

export async function runPlainLoop(
  context: PlainRunInput,
  resumeOptions: Pick<CliOptions, "resume" | "noResume">,
): Promise<void> {
  console.log(chalk.dim("Schreibe eine Aufgabe oder /help. Ctrl+C beendet.\n"));
  // Set once, if the interrupted-run flow below resolves to "resume": the
  // resume context is prepended to the very next message the user actually
  // sends, then cleared — never sent on its own, never repeated.
  let pendingSeed = await checkInterruptedRunPlain(context as RuntimeContext, resumeOptions);
  // `/resume fortsetzen` and `/panel use <n>` (handleSlashCommand, below) seed
  // the same variable through this one hook — no separate insertion path for
  // a command reached mid-session vs. the one offered at startup above.
  context.seedNextMessage = (text) => {
    pendingSeed = text;
  };
  context.settings = createSettingsCommandPort({
    executionMode: context.executionMode,
    stdinIsTty: context.stdinIsTty ?? process.stdin.isTTY === true,
    stdoutIsTty: context.stdoutIsTty ?? process.stdout.isTTY === true,
    createSession: async () => {
      const ui = context.createTemporarySettingsUi?.()
        ?? new TerminalUi(() => plainSettingsDashboardState(context), process.stdin, process.stdout, undefined, {
          settingsEditorResolver: createSettingsEditorResolver(context),
        });
      return createSettingsSession(context, ui, true);
    },
  });
  while (true) {
    let value: string;
    try {
      value = context.readPlainInput
        ? await context.readPlainInput()
        : await input({ message: chalk.cyan("›") });
    } catch (error) {
      if (isPromptExit(error)) {
        process.stdout.write("\n");
        break;
      }
      throw error;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    try {
      if (trimmed.startsWith("/")) {
        const commandName = resolveCliCommandName(trimmed);
        const requiresRoute = commandRequiresRunnableRoute(
          commandName,
          commandArguments(trimmed),
        );
        const transitionsRoute = commandTransitionsRunnableRoute(
          commandName,
          commandArguments(trimmed),
        );
        const executeCommand = () => handleSlashCommand(trimmed, context as RuntimeContext);
        const outcome = requiresRoute && !transitionsRoute
          ? await context.providerRuntime.runWithReadyRoute(async (route) => {
              assertModelBoundToRoute(context.config.mainModel, route);
              context.agent = await context.ensureAgentForPrompt();
              return executeCommand();
            }, "plain")
          : await executeCommand();
        if (outcome === "exit") {
          break;
        }
        continue;
      }
      const effective = pendingSeed ? `${pendingSeed}\n\n${trimmed}` : trimmed;
      pendingSeed = undefined;
      const result = await context.providerRuntime.runWithReadyRoute(async (route) => {
        assertModelBoundToRoute(context.config.mainModel, route);
        if (route.backendId === "openrouter") {
          await ensureRunnableModelConfiguration(context.openRouter, context.config);
        }
        const boundAgent = await context.ensureAgentForPrompt();
        context.agent = boundAgent;
        return boundAgent.run(effective);
      }, "plain");
      printRunFooter(result);
    } catch (error) {
      console.error(chalk.red(context.openRouter.safeMessage(error)));
      if (error instanceof AgentRunError) {
        // The fragment is already in the chat file; name what it cost.
        printRunFooter(error.result);
      }
    }
  }

  await context.session.save();
  console.log("Bis bald.");
}

function plainSettingsDashboardState(context: RuntimeContext): DashboardState {
  return {
    workspace: context.workspace,
    projectStatus: "Settings",
    model: context.config.mainModel,
    approval: context.approvals.mode,
    compressor: context.config.compressionMode,
    compressorModel: context.config.compressorModel,
    reasoning: reasoningLabel(getReasoningSetting(context.config)),
    balance: "Providerstatus nicht geladen",
    sessionCost: context.session.data.costs.costKnowledge === "unknown"
      ? "providerverwaltet / unbekannt"
      : formatUsd(context.session.data.costs.totalUsd),
    maxCost: formatUsd(context.config.maxCostUsd),
    maxSteps: context.config.maxSteps,
    keyStatus: "nicht geprüft",
  };
}

export function createSettingsEditorResolver(context: RuntimeContext): SettingsEditorResolver {
  return {
    searchModels(request, query) {
      const route = context.providerRuntime.readCachedSettingsRoute?.();
      if (route?.backendId === "kimi-code"
        && request.editor.kind === "model"
        && request.editor.filter !== "main") return [];
      const cached = readProviderAwareSettingsModels(context).filter((model, index, models) => models.findIndex((candidate) =>
        candidate.id === model.id
        && candidate.canonicalSlug === model.canonicalSlug) === index);
      const eligible = request.editor.kind !== "model"
        ? []
        : request.editor.filter === "main"
          ? mainModelCandidates(cached)
          : request.editor.filter === "compressor"
            ? compressorModelCandidates(cached)
            : request.editor.filter === "panel"
              ? panelModelCandidates(cached)
              : audioInputModelCandidates(cached);
      return rankModels(eligible, query, context.config.mainModel);
    },
  };
}

function readProviderAwareSettingsModels(context: Pick<
  RuntimeContext,
  "providerRuntime" | "openRouter"
>): readonly ModelInfo[] {
  const exact = context.providerRuntime.readCachedSettingsModels?.();
  if (exact) return exact;
  const route = context.providerRuntime.readCachedSettingsRoute?.();
  const legacyRuntime = context.providerRuntime.readCachedModels?.() ?? [];
  if (route?.backendId === "kimi-code") {
    const kimiIds = new Set<string>(KIMI_CODE_MODELS.map((model) => model.id));
    return legacyRuntime.filter((model) => kimiIds.has(model.id));
  }
  return [
    ...legacyRuntime,
    ...context.openRouter.readCachedModels(),
  ];
}

// ---------------------------------------------------------------------------
// Interrupted-run detection at startup (src/resume.ts)
//
// Honesty constraint (see resume.ts's module doc): a real "continue mid-run"
// is impossible, since the SDK state of an interrupted run was deliberately
// never committed. What all three call sites below offer instead is a new
// run seeded with a factual summary of what happened — and only ever after
// the user explicitly says so. `--no-resume` skips the check outright;
// without either flag, an interactive session asks and a non-interactive one
// (`-p`/`--json`) only reports, never acts, never blocks.
// ---------------------------------------------------------------------------

type ResumeChoice = "resume" | "discard" | "undo" | null;

/**
 * Executes one already-made decision. Shared by every call site so the
 * *effect* of each choice — reuse `ChangeJournal.undoLastRun` for "undo" via
 * `undoInterruptedRun`, mark the run reviewed so it is not reported again —
 * is defined in exactly one place. `null` ("später entscheiden" / Escape /
 * Ctrl+C) does nothing at all, not even marking the run reviewed, so it is
 * reported again next start.
 */
async function applyResumeChoice(
  choice: ResumeChoice,
  context: RuntimeContext,
  run: InterruptedRun,
  summary: RunSummary,
  report: (text: string) => void,
): Promise<string | undefined> {
  if (choice === null) {
    return undefined;
  }
  if (choice === "discard") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    report("Verworfen. Die bisherigen Dateiänderungen dieses Laufs bleiben unverändert.");
    return undefined;
  }
  if (choice === "undo") {
    const local = context.agent ?? context.localRuntime;
    const outcome = await undoInterruptedRun(
      local.journal,
      local.guard,
      context.approvals,
      run,
    );
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    report(formatUndoOutcome(outcome));
    return undefined;
  }
  await markRunReviewed(context.session.appHome, context.session.data.id, run);
  return buildResumePrompt(summary);
}

/** Plain (`--plain` or non-TTY-fallback) loop: asks via `@inquirer/prompts`' `select`, defaulting to "später entscheiden". */
async function askResumeChoicePlain(): Promise<ResumeChoice> {
  try {
    return await select<ResumeChoice>({
      message: "Was tun mit dem abgebrochenen Lauf?",
      choices: [
        {
          name: "Später entscheiden (nichts verändern, beim nächsten Start erneut fragen)",
          value: null,
        },
        {
          name: "Fortsetzen (Zusammenfassung wird deiner nächsten Nachricht vorangestellt)",
          value: "resume",
        },
        {
          name: "Verwerfen (nicht mehr fragen, nichts wird zurückgenommen)",
          value: "discard",
        },
        { name: "Dateiänderungen dieses Laufs zurücknehmen (wie /undo)", value: "undo" },
      ],
      default: null,
    });
  } catch (error) {
    if (isPromptExit(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Runs the interrupted-run check for the plain (non-TUI) interactive loop.
 * Returns text to prepend to the user's next message when they chose to
 * resume, `undefined` otherwise. Never blocks and never acts without an
 * explicit choice from the user (`--no-resume` skips entirely; `--resume`
 * still prints what it is doing, since silence would be its own kind of
 * surprise).
 */
async function checkInterruptedRunPlain(
  context: RuntimeContext,
  options: Pick<CliOptions, "resume" | "noResume">,
): Promise<string | undefined> {
  if (options.noResume) {
    return undefined;
  }
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    return undefined;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  if (options.resume) {
    console.log(chalk.dim(notice));
    console.log(chalk.dim("Wird ohne Rückfrage fortgesetzt (--resume)."));
    return applyResumeChoice("resume", context, run, summary, (text) =>
      console.log(chalk.dim(text)),
    );
  }
  console.log(chalk.yellow(notice));
  const choice = await askResumeChoicePlain();
  return applyResumeChoice(choice, context, run, summary, (text) => console.log(chalk.dim(text)));
}

/**
 * TUI variant of the same check: shows the notice as a system message and,
 * without `--resume`, offers the three-way choice through `ui.pickChoice`
 * (Escape resolves to `null`, i.e. "später entscheiden" — same safe default
 * as everywhere else). A "resume" choice lands in the input line via
 * `insertInputText` — visible, editable, never auto-sent.
 */
async function checkInterruptedRunTui(
  ui: TerminalUi,
  context: RuntimeContext & { resumeFlag?: boolean; noResumeFlag?: boolean },
): Promise<string | undefined> {
  if (context.noResumeFlag) {
    return undefined;
  }
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    return undefined;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  const report = (text: string) => ui.addMessage("system", text, "Wiederaufnahme");

  if (context.resumeFlag) {
    report(`${notice}\nWird ohne Rückfrage fortgesetzt (--resume).`);
    return applyResumeChoice("resume", context, run, summary, report);
  }

  report(notice);
  const picked = await ui.pickChoice(
    "Abgebrochener Lauf",
    [
      {
        value: "later",
        label: "Später entscheiden",
        description: "Nichts wird verändert; die Meldung erscheint beim nächsten Start erneut.",
      },
      {
        value: "resume",
        label: "Fortsetzen",
        description:
          "Zusammenfassung wird in die Eingabezeile gelegt — du entscheidest, ob und wann du sie abschickst.",
      },
      {
        value: "discard",
        label: "Verwerfen",
        description: "Nichts wird zurückgenommen; nicht mehr melden.",
      },
      {
        value: "undo",
        label: "Änderungen zurücknehmen",
        description: "Macht die Dateiänderungen dieses Laufs rückgängig (wie /undo).",
      },
    ],
    "later",
    "later",
  );
  const choice: ResumeChoice =
    picked && picked.value !== "later" ? (picked.value as "resume" | "discard" | "undo") : null;
  return applyResumeChoice(choice, context, run, summary, report);
}

/**
 * Non-interactive (`-p`/`--json`): only ever acts on an explicit `--resume`
 * (combining the resume context with the actual prompt) or `--no-resume`
 * (silence). Without either flag the safe default applies — report and do
 * nothing, since there is no one to ask and a non-interactive run must never
 * block on input.
 */
async function applyInterruptedRunNonInteractive(
  session: SessionStore,
  options: Pick<CliOptions, "resume" | "noResume">,
  out: CommandOutput,
  prompt: string,
): Promise<string> {
  if (options.noResume) {
    return prompt;
  }
  const run = await findInterruptedRun(session.appHome, session.data.id);
  if (!run) {
    return prompt;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  if (!options.resume) {
    out.text(
      `${notice}\nNicht interaktiv, kein --resume/--no-resume: Es wird nichts verändert. ` +
        "Mit --resume automatisch übernehmen, mit --no-resume nicht mehr melden.",
    );
    return prompt;
  }
  out.text(`${notice}\nWird ohne Rückfrage fortgesetzt (--resume).`);
  await markRunReviewed(session.appHome, session.data.id, run);
  return `${buildResumePrompt(summary)}\n\n${prompt}`;
}

/**
 * Collects everything written during one command instead of writing it
 * immediately — the dashboard renders the whole result as a single block once
 * the command has finished (`flush`), which is what `captureConsole` used to
 * do by monkey-patching `console.log`/`console.error` globally.
 */
class BufferedCommandOutput implements CommandOutput {
  #lines: string[] = [];
  #level: "info" | "error" = "info";

  text(value: string): void {
    this.#lines.push(value);
  }

  error(value: string, hint?: string): void {
    this.#level = "error";
    this.#lines.push(hint ? `${value}\n${hint}` : value);
  }

  flush(): { output: string; level: "info" | "error" } {
    const output = sanitizeTerminalText(this.#lines.join("\n")).trim();
    const level = this.#level;
    this.#lines = [];
    this.#level = "info";
    return { output, level };
  }
}

async function runDashboard(
  context: DashboardRunInput,
): Promise<void> {
  let balance: BalanceInfo | null = null;
  let balanceLabel = "wird geprüft …";
  let resolvedModel = "";
  let projectStatus = `${basename(context.workspace)} · Workspace wird geprüft …`;
  let modelDetails = "Modellmetadaten werden geladen …";
  let currentModelInfo: ModelInfo | null = null;
  let pendingImages: ImageAttachment[] = [];
  let startingSessionCost = context.session.data.costs.totalUsd;
  const ui = new TerminalUi((): DashboardState => {
    const spentSinceStart = Math.max(
      0,
      context.session.data.costs.totalUsd - startingSessionCost,
    );
    return {
      workspace: context.workspace,
      projectStatus: `${projectStatus} · Chat „${context.session.data.title}“ · ${context.session.data.turns.length} Nachrichten`,
      model: context.config.mainModel,
      modelDetails,
      resolvedModel,
      approval: context.approvals.mode,
      compressor: context.config.compressionMode,
      compressorModel: context.config.compressorModel,
      reasoning: reasoningLabel(getReasoningSetting(context.config)),
      balance: balance
        ? formatBalanceSummary(balance, spentSinceStart)
        : balanceLabel,
      sessionCost: context.session.data.costs.costKnowledge === "unknown"
        ? "providerverwaltet / unbekannt"
        : formatUsd(context.session.data.costs.totalUsd),
      maxCost: formatUsd(context.config.maxCostUsd),
      maxSteps: context.config.maxSteps,
      keyStatus: dashboardKeyStatus(context.openRouter),
      sshHost: context.sshSession.active ?? undefined,
    };
  }, process.stdin, process.stdout, undefined, {
    settingsEditorResolver: createSettingsEditorResolver(context),
  });
  const dashboardOut = new BufferedCommandOutput();
  context.out = dashboardOut;
  // Same two seams as the plain loop above, wired to this UI instead:
  // `/resume fortsetzen` and `/panel use <n>` land their text in the input
  // line exactly like the interrupted-run "Fortsetzen" choice already does
  // (`ui.insertInputText`, see `checkInterruptedRunTui` below), and a
  // `/panel` result becomes its own block instead of flattened command text.
  context.seedNextMessage = (text) => ui.insertInputText(text);
  context.onPanelResult = (result, judgment, expandedIndex) =>
    ui.addPanelResult(result, judgment, expandedIndex);
  context.onRunEvent = (event) => ui.handleRunEvent(event);
  context.confirmChatDeletion = async (title, details) =>
    (await ui.confirmAction(title, details)).accepted;
  context.confirmCredentialForget = async (kind, details) =>
    (await ui.confirmAction(
      kind === "inference" ? "API-Key wirklich entfernen?" : "Management-Key wirklich entfernen?",
      details,
    )).accepted;
  context.confirmProviderMutation = async (operation, backendId, details) =>
    (await ui.confirmAction(
      `${backendId} ${operation} bestätigen?`,
      details,
    )).accepted;
  context.confirmProcessOnlyCredential = async (kind, reason) =>
    (await ui.confirmAction(
      kind === "inference"
        ? "Key nur für diesen Prozess verwenden?"
        : "Management-Key nur für diesen Prozess verwenden?",
      `${reason}\nEs wird keine Klartextdatei oder alternative Speicherung angelegt.`,
    )).accepted;
  context.readCredentialSecret = (kind) => ui.readSecret(
    kind === "inference" ? "OpenRouter API-Key" : "OpenRouter Management-Key",
  );
  context.settings = createSettingsCommandPort({
    executionMode: context.executionMode,
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    createSession: async () => createSettingsSession(context, ui, false),
  });
  // Showing a transcript behind the chat chooser contradicts the question it
  // asks: the user is picking a chat while already looking at one. Load only
  // once the choice is settled.
  if (!context.showChatPickerOnStart) {
    ui.loadTurns(context.session.recentTurns(VISIBLE_TURNS));
  }
  context.approvals.setPromptHandler((preview) => ui.confirmApproval(preview));
  ui.start();
  try {
    const setupSurface = createTuiSetupSurface(ui);
    context.providerRouteSurface = setupSurface;
    if (context.setupRequired) {
      await context.providerRuntime.runSetup(setupSurface);
    }
    if (context.showChatPickerOnStart) {
      const switched = await pickDashboardChat(ui, context as RuntimeContext, true);
      if (switched) {
        startingSessionCost = context.session.data.costs.totalUsd;
      } else {
        // Chooser dismissed — we stay in the current chat, so its transcript
        // still has to appear. `pickDashboardChat` loads it only on a switch.
        ui.loadTurns(context.session.recentTurns(VISIBLE_TURNS));
      }
    }
    const startupModel = context.config.mainModel;
    let startupRouteReady = false;
    try {
      context.providerRuntime.currentSessionRoute();
      startupRouteReady = true;
    } catch (error) {
      if (!(error instanceof ProviderSetupRequiredError)) throw error;
    }
    if (startupRouteReady) {
      void Promise.all([
        inspectWorkspace(context.workspace),
        loadProviderModelSnapshot(context as RuntimeContext, startupModel),
      ]).then(([nextProjectStatus, nextModel]) => {
        projectStatus = nextProjectStatus;
        if (context.config.mainModel === startupModel) {
          modelDetails = nextModel.details;
          currentModelInfo = nextModel.model;
        }
        ui.refresh();
      });
    } else {
      void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
        projectStatus = nextProjectStatus;
        modelDetails = "Provider-Setup erforderlich";
        ui.refresh();
      });
    }

    if (context.approvals.mode === "allow-all") {
      const keep = await ui.confirmAction(
        "Gespeichertes allow-all für diese Sitzung verwenden?",
        "Dateiänderungen und Shell-Befehle würden ohne Rückfrage ausgeführt.",
      );
      if (!keep.accepted) {
        context.approvals.mode = "ask";
        ui.addMessage(
          "system",
          "Diese Sitzung verwendet ask; die gespeicherte Einstellung bleibt unverändert.",
          "Approval",
        );
      }
    }

    balanceLabel = startupRouteReady ? "Provider bereit" : "Setup erforderlich";

    // Checked here (after a possible startup chat switch above, so it looks
    // at whichever chat is actually open) rather than before `runDashboard`
    // is even called.
    const seed = await checkInterruptedRunTui(ui, context as RuntimeContext & {
      resumeFlag?: boolean;
      noResumeFlag?: boolean;
    });
    if (seed) {
      ui.insertInputText(seed);
    }

    ui.setStatus("Bereit", false);

    while (true) {
      let value: string;
      try {
        value = await ui.readInput();
      } catch (error) {
        if (error instanceof UiExitError) {
          break;
        }
        throw error;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }

      let runController: AbortController | null = null;
      let submittedImages: ImageAttachment[] = [];
      try {
        if (trimmed.startsWith("/")) {
          ui.setStatus("Befehl wird ausgeführt");
          const modelBefore = context.config.mainModel;
          const resolvedCommand = resolveSlashCommand(trimmed);
          const completedCommand = resolveCliCommandName(trimmed);
          const completedCommandLabel = resolvedCommand
            ? `/${resolvedCommand.command.name}`
            : trimmed.split(/\s+/)[0];
          const commandArgs = commandArguments(trimmed);
          const sessionBefore = context.session;

          const dashboardRoute = currentDashboardRoute(context as RuntimeContext);
          const unsupported = dashboardRoute
            ? dashboardKimiUnsupportedMessage(dashboardRoute, completedCommand, commandArgs)
            : null;
          if (unsupported) throw new Error(unsupported);

          if (completedCommand === "image") {
            const action = commandTail(trimmed);
            if (action.toLowerCase() === "clear") {
              pendingImages = [];
              ui.setImageAttachments([]);
              ui.addMessage(
                "system",
                "Alle ausstehenden Bildanhänge wurden entfernt.",
                "/image",
              );
            } else if (action.toLowerCase() === "list") {
              ui.addMessage(
                "system",
                pendingImages.length
                  ? attachmentPromptSummary(pendingImages)
                  : "Keine Bilder für die nächste Nachricht angehängt.",
                "/image",
              );
            } else {
              const chosenPath =
                !action || action.toLowerCase() === "choose"
                  ? await chooseDashboardImage(ui)
                  : action;
              if (chosenPath) {
                const attachment = await inspectImageAttachment(
                  chosenPath,
                  context.workspace,
                );
                const withoutDuplicate = pendingImages.filter(
                  (candidate) => candidate.path !== attachment.path,
                );
                const next = [...withoutDuplicate, attachment];
                validateImageAttachmentSet(next);
                pendingImages = next;
                ui.setImageAttachments(pendingImages);
                ui.addMessage(
                  "system",
                  `${attachment.name} wurde für die nächste Nachricht angehängt.\n${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)}`,
                  "/image",
                );
              } else {
                ui.addMessage(
                  "system",
                  "Bildauswahl abgebrochen.",
                  "/image",
                );
              }
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "whisper") {
            await runVoiceCapture(ui, context as RuntimeContext, setupSurface);
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "model" && commandArgs.length === 0) {
            const selected = await pickDashboardModel(
              ui,
              context as RuntimeContext,
              setupSurface,
            );
            if (selected) {
              context.session.setPreferences(
                context.config.mainModel,
                getReasoningSetting(context.config),
              );
              await context.session.save();
              resolvedModel = "";
              currentModelInfo = selected;
              modelDetails = summarizeModel(selected);
              ui.addMessage(
                "system",
                [
                  `Modell ausgewählt: ${selected.name}`,
                  `ID: ${selected.id}`,
                  summarizeModel(selected),
                ].join("\n"),
                "/model",
              );
            } else {
              ui.addMessage("system", "Modellwahl abgebrochen.", "/model");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "compress" &&
            commandArgs.length === 1 &&
            commandArgs[0]?.toLowerCase() === "model"
          ) {
            const selected = await pickDashboardCompressorModel(ui, context as RuntimeContext);
            if (selected) {
              ui.addMessage(
                "system",
                [
                  `Kompressor-Modell ausgewählt: ${selected.name}`,
                  `ID: ${selected.id}`,
                  summarizeModel(selected),
                  `Modus: ${context.config.compressionMode} · Schwelle ${context.config.compressionThresholdChars.toLocaleString("de-DE")} Zeichen`,
                ].join("\n"),
                "/compress model",
              );
            } else {
              ui.addMessage(
                "system",
                "Kompressor-Modellwahl abgebrochen.",
                "/compress model",
              );
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "think" &&
            commandArgs.length === 0
          ) {
            if (!currentModelInfo) {
              const snapshot = await loadProviderModelSnapshot(
                context as RuntimeContext,
                context.config.mainModel,
              );
              currentModelInfo = snapshot.model;
              modelDetails = snapshot.details;
            }
            const current = getReasoningSetting(context.config);
            const options = reasoningChoices(currentModelInfo, current);
            const picked = await ui.pickChoice(
              `Thinking für ${context.config.mainModel}`,
              options,
              reasoningChoiceValue(current),
            );
            const selected = options.find(
              (option) => option.value === picked?.value,
            );
            if (selected) {
              validateReasoningSetting(selected.setting, currentModelInfo);
              setReasoningSetting(context.config, selected.setting);
              context.session.setPreferences(
                context.config.mainModel,
                selected.setting,
              );
              await Promise.all([
                saveConfig(context.config, context.configPath),
                context.session.save(),
              ]);
              ui.addMessage(
                "system",
                [
                  `Thinking: ${reasoningLabel(selected.setting)}`,
                  selected.description,
                  "Reasoning-Tokens zählen als Output-Tokens und können die Kosten erhöhen.",
                ].join("\n"),
                "/think",
              );
            } else {
              ui.addMessage("system", "Thinking-Auswahl abgebrochen.", "/think");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "allow" &&
            commandArgs.length === 0
          ) {
            const selected = await ui.pickChoice(
              "Approval-Modus",
              APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: approvalChoiceLabel(mode),
                description: approvalDescription(mode),
              })),
              context.approvals.mode,
            );
            if (selected) {
              const mode = selected.value as ApprovalMode;
              let accepted = true;
              if (mode === "allow-all") {
                accepted = (
                  await ui.confirmAction(
                    "allow-all aktivieren?",
                    `Dateiänderungen und Shell-Befehle laufen ohne weitere Rückfrage. ${catastrophicGuardNotice()}`,
                  )
                ).accepted;
              }
              if (accepted) {
                const previous = context.approvals.mode;
                context.approvals.mode = mode;
                context.config.approvalMode = mode;
                await saveConfig(context.config, context.configPath);
                ui.addMessage(
                  "system",
                  `✓ Approval geändert: ${previous} → ${mode}\n${approvalDescription(mode)}`,
                  "/allow",
                );
              } else {
                ui.addMessage(
                  "system",
                  "Approval-Modus blieb unverändert.",
                  "/allow",
                );
              }
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "chat" &&
            commandArgs.length === 0
          ) {
            const switched = await pickDashboardChat(ui, context as RuntimeContext, false);
            if (switched) {
              startingSessionCost = context.session.data.costs.totalUsd;
              resolvedModel = "";
              const snapshot = await loadProviderModelSnapshot(
                context as RuntimeContext,
                context.config.mainModel,
              );
              modelDetails = snapshot.details;
              currentModelInfo = snapshot.model;
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "clear" && commandArgs.length === 0) {
            const { accepted } = await ui.confirmAction(
              "Gespräch und Sitzungskosten zurücksetzen?",
              "Der gespeicherte Chat-Kontext und die Kostenstatistik dieses Workspaces werden gelöscht.",
            );
            if (accepted) {
              context.session.clear();
              context.agent?.resetConversationMemory();
              await context.session.save();
              ui.loadTurns([]);
              ui.addMessage("system", "Sitzung zurückgesetzt.", "/clear");
            } else {
              ui.addMessage("system", "Zurücksetzen abgebrochen.", "/clear");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "allow" &&
            commandArgs[0]?.toLowerCase() === "allow-all"
          ) {
            const { accepted } = await ui.confirmAction(
              "allow-all aktivieren?",
              `Dateiänderungen und Shell-Befehle werden dann ohne weitere Nachfrage ausgeführt. ${catastrophicGuardNotice()}`,
            );
            if (accepted) {
              context.approvals.mode = "allow-all";
              context.config.approvalMode = "allow-all";
              await saveConfig(context.config, context.configPath);
              ui.addMessage(
                "system",
                "Approval-Modus: allow-all. Änderungen und Shell-Befehle laufen ohne Rückfrage.",
                "/allow",
              );
            } else {
              ui.addMessage(
                "system",
                "Approval-Modus blieb unverändert.",
                "/allow",
              );
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          const executeCommand = () => handleSlashCommand(trimmed, context as RuntimeContext);
          const requiresRoute = commandRequiresRunnableRoute(
            completedCommand,
            commandArgs,
            "dashboard",
          );
          const outcome = requiresRoute
            && !commandTransitionsRunnableRoute(completedCommand, commandArgs)
            ? await context.providerRuntime.runWithReadyRoute(async (route) => {
                assertModelBoundToRoute(context.config.mainModel, route);
                context.agent = await context.ensureAgentForPrompt(setupSurface);
                return executeCommand();
              }, setupSurface)
            : await executeCommand();
          const captured = dashboardOut.flush();
          if (context.session !== sessionBefore) {
            startingSessionCost = context.session.data.costs.totalUsd;
            ui.loadTurns(context.session.recentTurns(VISIBLE_TURNS));
            pendingImages = [];
            ui.setImageAttachments([]);
            resolvedModel = "";
          }
          if (captured.output) {
            ui.addMessage(
              captured.level === "error" ? "error" : "system",
              captured.output,
              completedCommandLabel,
            );
          }
          if (
            completedCommand === "balance" ||
            completedCommand === "reconnect"
          ) {
            balance = await context.openRouter.checkBalance();
          }
          if (completedCommand === "key" && context.openRouter.hasKey) {
            balance = await context.openRouter.checkBalance();
          } else if (completedCommand === "key") {
            balance = null;
            balanceLabel = "kein Key";
          }
          if (context.agent && (
            context.config.mainModel !== modelBefore
            || completedCommand === "model"
            || context.session !== sessionBefore
          )) {
            resolvedModel = "";
            const snapshot = await loadProviderModelSnapshot(
              context as RuntimeContext,
              context.config.mainModel,
            );
            modelDetails = snapshot.details;
            currentModelInfo = snapshot.model;
          }
          if (completedCommand === "clear" && context.session.data.turns.length === 0) {
            ui.loadTurns([]);
            if (captured.output) {
              ui.addMessage("system", captured.output, "/clear");
            }
          }
          void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
            projectStatus = nextProjectStatus;
            ui.refresh();
          });
          if (outcome === "exit") {
            break;
          }
          ui.setStatus("Bereit", false);
          continue;
        }

        const controller = new AbortController();
        runController = controller;
        ui.setCancelHandler(() => {
          runController?.abort(new Error("Der aktuelle Lauf wurde vom Benutzer abgebrochen."));
        });
        const result = await context.providerRuntime.runWithReadyRoute(async (route) => {
          assertModelBoundToRoute(context.config.mainModel, route);
          if (route.backendId === "openrouter") {
            const runnableModels = await ensureRunnableModelConfiguration(
              context.openRouter,
              context.config,
            );
            if (runnableModels.main) {
              currentModelInfo = runnableModels.main;
              modelDetails = summarizeModel(runnableModels.main);
            }
            if (pendingImages.length && !currentModelInfo) {
              const snapshot = await loadModelSnapshot(
                context.openRouter,
                context.config.mainModel,
              );
              currentModelInfo = snapshot.model;
              modelDetails = snapshot.details;
            }
            if (
              pendingImages.length
              && currentModelInfo
              && !currentModelInfo.inputModalities.includes("image")
            ) {
              throw new Error(
                `Das aktive Modell ${context.config.mainModel} unterstützt laut OpenRouter keine Bilder. Wähle mit /model ein Modell mit „Bilder“-Fähigkeit; die Anhänge bleiben erhalten.`,
              );
            }
          } else if (pendingImages.length > 0) {
            throw new Error("Bilder sind mit Kimi Code Abo in Orcode noch nicht verfügbar.");
          }
          submittedImages = pendingImages.map((attachment) => ({ ...attachment }));
          pendingImages = [];
          ui.setImageAttachments([]);
          const imageSummary = attachmentPromptSummary(submittedImages);
          ui.addMessage(
            "user",
            imageSummary ? `${trimmed}\n\n🖼 ${imageSummary}` : trimmed,
          );
          ui.beginAssistant(context.config.mainModel);
          const boundAgent = await context.ensureAgentForPrompt(setupSurface);
          context.agent = boundAgent;
          return boundAgent.run(
            trimmed,
            {
              onStatus: (status) => ui.setStatus(status),
              onText: (delta) => ui.appendAssistant(delta),
              onEvent: (event) => {
                ui.handleRunEvent(event);
                // A7: the context-fill header segment is fed from outside —
                // model-end is the only event carrying a fresh inputTokens
                // measurement, ModelInfo.contextLength comes from the model
                // picker's last snapshot.
                if (event.type === "model-end" && currentModelInfo?.contextLength) {
                  ui.setContextPercent(
                    (event.inputTokens / currentModelInfo.contextLength) * 100,
                  );
                }
              },
              signal: controller.signal,
            },
            submittedImages,
          );
        }, setupSurface);
        submittedImages = [];
        ui.setCancelHandler();
        resolvedModel = result.resolvedModel;
        ui.finishAssistant(result.text);
        ui.setSuggestedReplies(result.suggestions);
        for (const notice of result.notices) {
          ui.addMessage("system", notice, "Hinweis");
        }
        ui.addMessage(
          "system",
          `${runResultLabel(result.outcome)} · ${formatRunCost(result)} · ${formatRouting(result.selectedModel, result.resolvedModel)}`,
        );
        void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
          projectStatus = nextProjectStatus;
          ui.refresh();
        });
      } catch (error) {
        const partial = error instanceof AgentRunError ? error.result : null;
        const cancelled =
          error instanceof AgentRunError
            ? error.outcome === "cancelled"
            : Boolean(runController?.signal.aborted) ||
              isAbortError(error);
        ui.setCancelHandler();
        // The fragment is already persisted; discarding it in the UI would only
        // hide what the model actually said before it stopped.
        ui.finishAssistant(partial?.text);
        if (submittedImages.length) {
          pendingImages = [...submittedImages, ...pendingImages];
          validateImageAttachmentSet(pendingImages);
          ui.setImageAttachments(pendingImages);
        }
        for (const notice of partial?.notices ?? []) {
          ui.addMessage("system", notice, "Hinweis");
        }
        ui.addMessage(
          cancelled ? "system" : "error",
          cancelled
            ? "Lauf abgebrochen. Bereits ausgeführte Tool-Aktionen wurden nicht automatisch zurückgenommen; der Teiltext wurde gespeichert."
            : context.openRouter.safeMessage(error),
        );
        if (partial && (partial.costUsd > 0 || partial.costKnowledge === "unknown")) {
          ui.addMessage(
            "system",
            `${runResultLabel(partial.outcome)} · ${formatRunCost(partial)}`,
          );
        }
        if (!cancelled) balanceLabel = "Provider-Setup mit /provider setup prüfen";
        ui.setStatus("Bereit", false);
      }
    }
  } finally {
    context.approvals.setPromptHandler(undefined);
    await context.session.save();
    ui.stop();
  }
  console.log("Bis bald.");
}

function approvalChoiceLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "Read only";
    case "ask":
      return "Ask · alles bestätigen";
    case "auto-edit":
      return "Auto edit · Shell bestätigen";
    case "allow-all":
      return "Allow all";
  }
}

/** Commits every mutable chat owner after the previous chat is durable. */
function commitDashboardSessionHandoff(
  context: RuntimeContext,
  next: SessionStore,
): void {
  if (context.commitSessionHandoff) {
    context.commitSessionHandoff(next);
    return;
  }
  context.providerRuntime.adoptSession?.(next);
  context.session = next;
  context.agent?.setSession(next);
  context.localRuntime.setSession(next);
}

/** @internal Exported so the dashboard chat-switch boundary can be regression tested. */
export async function pickDashboardChat(
  ui: TerminalUi,
  context: RuntimeContext,
  preferNew: boolean,
): Promise<boolean> {
  let selectedRoute: RouteIdentityV1 | null = null;
  let previousRoute = validateRouteIdentityV1(context.session.data.route);
  if (typeof context.providerRuntime.currentSessionRoute === "function") {
    try {
      selectedRoute = context.providerRuntime.currentSessionRoute();
      previousRoute = selectedRoute;
    } catch (error) {
      if (
        !(error instanceof ProviderSetupRequiredError)
        && !(typeof error === "object" && error !== null && "code" in error
          && error.code === "provider-setup-required")
      ) {
        throw error;
      }
    }
  }
  const migratedConnection = context.providerRuntime.migratedSessionConnection();
  const chats = await SessionStore.list(
    context.workspace,
    context.session.appHome,
    migratedConnection,
  );
  const items = [
    {
      value: "__new__",
      label: "＋ Neuer Chat",
      description: "Beginnt ohne bisherigen Gesprächskontext und mit eigener Kostenstatistik.",
    },
    ...chats.map((chat) => chatChoice(chat)),
  ];
  const picked = await ui.pickChoice(
    `Chats · ${basename(context.workspace)}`,
    items,
    context.session.data.id,
    preferNew ? "__new__" : context.session.data.id,
  );
  if (!picked) {
    return false;
  }

  let next: SessionStore;
  if (picked.value === "__new__") {
    next = SessionStore.create(context.workspace, context.session.appHome);
  } else {
    if (picked.value === context.session.data.id) {
      return false;
    }
    next = await SessionStore.openById(
      context.workspace,
      picked.value,
      context.session.appHome,
      migratedConnection,
    );
    const historicalRoute = validateRouteIdentityV1(next.data.route);
    if (next.data.routeCleared) {
      // The lifecycle tombstone is authoritative over the route of the chat
      // that happened to be open before the dashboard switch.
      selectedRoute = null;
    } else if (historicalRoute?.resolutionState === "resolved") {
      if (typeof context.providerRuntime.selectSessionRoute !== "function") {
        throw new ProviderSetupRequiredError();
      }
      selectedRoute = await context.providerRuntime.selectSessionRoute(
        historicalRoute,
        context.providerRouteSurface,
      );
    } else if (next.data.model && next.data.model !== context.config.mainModel) {
      await context.providerRuntime.transitionModel(
        next.data.model,
        undefined,
        context.providerRouteSurface,
      );
      selectedRoute = typeof context.providerRuntime.currentSessionRoute === "function"
        ? context.providerRuntime.currentSessionRoute()
        : historicalRoute;
    }
  }

  await saveDashboardSessionPreferences(context, ui, previousRoute ?? undefined);
  commitDashboardSessionHandoff(context, next);
  if (selectedRoute) context.config.mainModel = selectedRoute.requestedModelId;
  if (!selectedRoute && next.data.model) context.config.mainModel = next.data.model;
  if (next.data.reasoning) {
    setReasoningSetting(context.config, next.data.reasoning);
  }
  next.setPreferences(
    selectedRoute?.requestedModelId ?? next.data.model ?? context.config.mainModel,
    getReasoningSetting(context.config),
    selectedRoute ?? undefined,
  );
  await saveDashboardSessionPreferences(context, ui, selectedRoute ?? undefined);
  await saveConfig(context.config, context.configPath);
  ui.loadTurns(next.recentTurns(VISIBLE_TURNS));
  ui.setStatus(`Chat geöffnet: ${next.data.title}`, false);
  return true;
}

function chatChoice(
  chat: ChatSummary,
): {
  value: string;
  label: string;
  description: string;
} {
  const model = chat.model ? ` · ${chat.model}` : "";
  return {
    value: chat.id,
    label: chat.title,
    description: `${chat.turnCount} Nachrichten · ${formatChatCost(chat)}${model} · ${formatChatAge(chat.updatedAt)} · ${chat.id.slice(0, 8)}`,
  };
}

function formatChatAge(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "gerade eben";
  }
  if (minutes < 60) {
    return `vor ${minutes} Min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `vor ${hours} Std`;
  }
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

async function saveDashboardSessionPreferences(
  context: RuntimeContext,
  ui?: TerminalUi,
  route?: RouteIdentityV1,
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
    route,
  );
  reportSaveOutcome(await context.session.save(), ui);
}

/**
 * A second orcode window writing the same chat is resolved by a merge, not
 * by a silent overwrite — but the user should learn that it happened.
 */
function reportSaveOutcome(outcome: SaveOutcome, ui?: TerminalUi): void {
  if (!outcome.merged && !outcome.conflictBackupPath) {
    return;
  }
  const lines = [
    outcome.merged
      ? "Chat wurde mit den Änderungen einer zweiten orcode-Instanz zusammengeführt."
      : "",
    outcome.conflictBackupPath
      ? `Eine unlesbare Chat-Datei wurde gesichert: ${outcome.conflictBackupPath}`
      : "",
  ].filter(Boolean);
  const message = lines.join("\n");
  if (ui) {
    ui.addMessage("system", message, "Chat");
  } else {
    console.log(chalk.yellow(message));
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    newChat: false,
    continueChat: false,
    help: false,
    version: false,
    plain: false,
    json: false,
    resume: false,
    noResume: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--version" || argument === "-v") {
      options.version = true;
    } else if (argument === "--plain") {
      options.plain = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--cwd" || argument === "-C") {
      options.workspace = requireValue(args, ++index, argument);
    } else if (argument === "--prompt" || argument === "-p") {
      options.prompt = requireValue(args, ++index, argument);
    } else if (argument === "--model" || argument === "-m") {
      options.model = requireValue(args, ++index, argument);
    } else if (argument === "--approval" || argument === "-a") {
      options.approval = requireValue(args, ++index, argument);
    } else if (argument === "--compress") {
      options.compression = requireValue(args, ++index, argument);
    } else if (argument === "--new") {
      options.newChat = true;
    } else if (argument === "--continue") {
      options.continueChat = true;
    } else if (argument === "--resume") {
      options.resume = true;
    } else if (argument === "--no-resume") {
      options.noResume = true;
    } else if (argument === "--chat") {
      options.chatId = requireValue(args, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new CliUsageError(`Unbekannte Option: ${argument}`);
    } else {
      // K8: a bare positional argument used to be silently absorbed into the
      // prompt — that turns a typo ("orcode status") into an unnoticed,
      // paid run. It is rejected instead, with a pointer to -p/--prompt.
      throw new CliUsageError(
        `Unerwartetes Argument „${argument}“. Ein Prompt braucht -p/--prompt "…" (oder --json und stdin).`,
      );
    }
  }
  const chatModes = [
    options.newChat,
    options.continueChat,
    Boolean(options.chatId),
  ].filter(Boolean).length;
  if (chatModes > 1) {
    throw new CliUsageError("--new, --continue und --chat können nicht kombiniert werden.");
  }
  if (options.resume && options.noResume) {
    throw new CliUsageError("--resume und --no-resume können nicht kombiniert werden.");
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new CliUsageError(`${option} benötigt einen Wert.`);
  }
  return value;
}

export const HOME_WORKSPACE_WARNING =
  "Achtung: Der Workspace ist dein gesamtes Home-Verzeichnis — der Agent kann alles darunter lesen. Starte orcode im Projektordner oder mit -C <pfad>.";

/** Warnt, wenn orcode mit dem Home-Verzeichnis als Workspace läuft. `home` ist für Tests injizierbar. */
export function homeWorkspaceWarning(
  workspace: string,
  home: string = homedir(),
): string | null {
  return resolve(workspace) === resolve(home) ? HOME_WORKSPACE_WARNING : null;
}

function cliBannerParts(
  workspace: string,
  model: string,
  version: string = readPackageVersion(),
): { headline: string; workspace: string; model: string } {
  return {
    headline: `orcode ${version}`,
    workspace,
    model,
  };
}

export function renderCliBanner(
  workspace: string,
  model: string,
  version: string = readPackageVersion(),
): string {
  const parts = cliBannerParts(workspace, model, version);
  return [
    parts.headline,
    `Workspace ${parts.workspace}`,
    `Main      ${parts.model}`,
  ].join("\n");
}

function printBanner(workspace: string, model: string): void {
  const parts = cliBannerParts(workspace, model);
  console.log(chalk.bold.cyan(`\n${parts.headline}`));
  console.log(`${chalk.dim("Workspace")} ${parts.workspace}`);
  console.log(`${chalk.dim("Main")}      ${parts.model}`);
}

export function renderCliHelp(version: string = readPackageVersion()): string {
  return `
orcode ${version} – lokaler Coding-Agent über OpenRouter

Verwendung:
  orcode [optionen] -p "aufgabe"
  orcode -C /pfad/zum/projekt

Ein bloßes Positionsargument (z. B. „orcode status") wird abgelehnt —
das wäre sonst ein stiller, kostenpflichtiger Lauf. Nutze -p/--prompt.

Optionen:
  -C, --cwd <pfad>          Arbeitsverzeichnis
  -p, --prompt <text>       Einmaliger nicht-interaktiver Lauf
  -m, --model <id>          Main-Modell für diesen Start
  -a, --approval <modus>    read-only | ask | auto-edit | allow-all
      --compress <modus>    off | auto | always
      --new                 Direkt einen neuen Chat beginnen
      --continue            Zuletzt verwendeten Chat fortsetzen
      --chat <id>           Einen bestimmten Chat öffnen
      --resume              Abgebrochenen vorherigen Lauf ohne Rückfrage als
                             Kontext für den nächsten Lauf übernehmen
      --no-resume           Abgebrochenen vorherigen Lauf bei diesem Start
                             nicht melden
      --plain               Klassische Ausgabe ohne Fullscreen-TUI
      --json                NDJSON-Ereignisstrom auf stdout; Prompt aus -p
                             oder, wenn stdin kein TTY ist, aus stdin
  -h, --help                Hilfe
  -v, --version             Version anzeigen

Exit-Codes: 0 erfolgreich · 1 Laufzeitfehler · 2 Bedienfehler ·
3 unverifiziert · 124 Schritt-/Kostenlimit erreicht.

Shell-Ausführung:
  macOS/Linux: /bin/sh -c ohne Login-Shell.
  Windows: powershell.exe -NoProfile -NonInteractive -Command.
  ORCODE_SHELL gewinnt; ROUTERCODE_SHELL wird nur ohne ORCODE_SHELL zur Kompatibilität verwendet.

Bildauswahl:
  Der native /image-Picker ist macOS-spezifisch. Unter Windows und Linux wird
  ein Bild mit /image <pfad> angehängt.

Ein Schlüssel aus OPENROUTER_API_KEY bleibt zunächst nur im Prozess; /key save
speichert ihn nach erfolgreicher Prüfung. Verdeckte interaktive Eingaben werden
validiert und sicher im System-Schlüsselbund gespeichert. Ein --key-Argument
gibt es absichtlich nicht.
`;
}

function printUsage(): void {
  console.log(renderCliHelp());
}

/** K8: reads the whole of stdin as the prompt for `--json` when it is a pipe, not a TTY. */
async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** K8: same shape as `createPlainCommandOutput`, but never writes to stdout — for `--json`. */
function createStderrCommandOutput(): CommandOutput {
  return {
    text(value: string): void {
      console.error(value);
    },
    error(value: string, hint?: string): void {
      console.error(chalk.red(value));
      if (hint) {
        console.error(chalk.dim(hint));
      }
    },
  };
}

/**
 * K8 exit-code matrix: 0 erfolgreich · 1 Laufzeitfehler · 3 unverifiziert ·
 * 124 Schritt-/Kostenlimit. (2 Bedienfehler is thrown as `CliUsageError`
 * before any run starts, see the top-level `catch` below; `cancelled` is not
 * one of the five documented codes and uses the conventional SIGINT code.)
 */
export function runOutcomeExitCode(outcome: AgentRunOutcome): number {
  switch (outcome) {
    case "completed":
      return 0;
    case "step-limit":
    case "cost-limit":
      return 124;
    case "cancelled":
      return 130;
    case "error":
      return 1;
    default:
      // Forward-compatible: once `AgentRunOutcome` grows A4's "unverified"
      // outcome, it lands on exit 3 without another edit here.
      return (outcome as string) === "unverified" ? 3 : 1;
  }
}

/**
 * Runs one prompt to completion outside the TUI/plain-loop, either printing
 * the human footer or streaming NDJSON run events (K8), and returns the exit
 * code for that run.
 */
async function runNonInteractive(
  agent: OrcodeAgent,
  prompt: string,
  options: { json: boolean },
): Promise<number> {
  try {
    const result = await agent.run(prompt, {
      onEvent: options.json
        ? (event: AgentRunEvent) => {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          }
        : undefined,
    });
    if (!options.json) {
      printRunFooter(result);
    }
    return runOutcomeExitCode(result.outcome);
  } catch (error) {
    // `agent.run` already emitted its `run-end` event on this path (K8
    // testkriterium 3: the last NDJSON line is always `run-end`) before
    // rethrowing — nothing more to write to stdout here.
    if (!options.json) {
      console.error(chalk.red(errorMessage(error)));
    }
    if (error instanceof AgentRunError) {
      return runOutcomeExitCode(error.outcome);
    }
    return 1;
  }
}

function printRunFooter(result: AgentRunResult): void {
  for (const notice of result.notices) {
    console.log(chalk.yellow(notice));
  }
  console.log(
    chalk.dim(
      `${runResultLabel(result.outcome)} · Kosten dieses Laufs: ${formatRunCost(result)} · Schritte: ${result.modelSteps} · Modell: ${formatRouting(result.selectedModel, result.resolvedModel)}`,
    ),
  );
}

/** German label for an `AgentRunResult.outcome`. */
function runResultLabel(outcome: AgentRunOutcome): string {
  return runOutcomeLabel(outcome === "completed" ? "complete" : outcome);
}

export function formatRunCost(result: AgentRunResult): string {
  if (result.costKnowledge === "unknown") {
    return result.costUsd > 0
      ? `mindestens ${formatUsd(result.costUsd)} · weitere providerverwaltete Kosten unbekannt`
      : "providerverwaltet / unbekannt";
  }
  return result.compressorCostUsd > 0
    ? `${formatUsd(result.costUsd)} (Main ${formatUsd(result.mainCostUsd)} · Kompressor ${formatUsd(result.compressorCostUsd)})`
    : formatUsd(result.costUsd);
}

export function formatChatCost(chat: Pick<ChatSummary, "costKnowledge" | "costUsd">): string {
  if (chat.costKnowledge === "unknown") {
    return chat.costUsd > 0
      ? `mindestens ${formatUsd(chat.costUsd)} · weitere providerverwaltete Kosten unbekannt`
      : "providerverwaltet / unbekannt";
  }
  return formatUsd(chat.costUsd);
}

function formatRouting(selectedModel: string, resolvedModel: string): string {
  return resolvedModel === selectedModel
    ? selectedModel
    : `${selectedModel} → ${resolvedModel}`;
}

function formatBalanceSummary(balance: BalanceInfo, spentSinceStart: number): string {
  if (balance.credits) {
    return formatUsd(Math.max(0, balance.credits.remaining - spentSinceStart));
  }
  if (
    balance.key.limitRemaining !== null &&
    balance.key.limitRemaining !== undefined
  ) {
    return `${formatUsd(Math.max(0, balance.key.limitRemaining - spentSinceStart))} Key-Limit`;
  }
  return balance.key.isFreeTier ? "Free Tier" : "Key gültig";
}

function commandName(raw: string): string {
  return raw.trimStart().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function resolveCliCommandName(raw: string): string {
  return resolveSlashCommand(raw)?.handlerId ?? commandName(raw);
}

function commandArguments(raw: string): string[] {
  return raw.slice(1).trim().split(/\s+/).slice(1);
}

export function commandRequiresRunnableRoute(
  command: string,
  args: readonly string[],
  mode: "plain" | "dashboard" = "plain",
): boolean {
  if (command === "model" || command === "think") {
    return true;
  }
  if (command === "compress") {
    return (args[0] ?? "").toLowerCase() === "model";
  }
  if (command === "fallback") {
    return args[0]?.startsWith("+") ?? false;
  }
  if (command === "panel") {
    const subcommand = (args[0] ?? "").toLowerCase();
    if (!subcommand || subcommand === "show" || subcommand === "use" || subcommand === "judge") {
      return false;
    }
    if (subcommand === "models") {
      return args.length > 1;
    }
    return true;
  }
  return mode === "dashboard" && command === "whisper";
}

function commandTransitionsRunnableRoute(
  command: string,
  args: readonly string[],
): boolean {
  return command === "model" && (args[0] ?? "").toLowerCase() !== "current";
}

function commandTail(raw: string): string {
  return raw.match(/^\/\S+(?:\s+([\s\S]*))?$/)?.[1]?.trim() ?? "";
}

function recordingLimitLabel(reason: RecordingStopReason): string {
  return reason === "duration-limit"
    ? "Zeitlimit (120s) erreicht"
    : "Größenlimit (25 MB) erreicht";
}

/**
 * `/whisper` (`/voice`): asks for one-time consent, picks a recording
 * provider for this machine, runs the record → stop/cancel → transcribe →
 * insert-into-input-line flow. Every failure is reported through
 * `ui.addMessage("error", …)` instead of throwing, so a broken microphone or
 * a rejected model never crashes the dashboard loop.
 */
async function runVoiceCapture(
  ui: TerminalUi,
  context: RuntimeContext,
  setupSurface?: SetupSurface,
): Promise<void> {
  const consented = await ensureVoiceConsent(
    context.config,
    async () => {
      const decision = await ui.confirmAction(
        "Mikrofonaufnahme an OpenRouter senden?",
        "orcode nimmt dein Mikrofon auf und schickt die Aufnahme zur Transkription an ein Modell auf OpenRouter. Diese Zustimmung wird gespeichert und danach nicht erneut abgefragt.",
      );
      return decision.accepted;
    },
    () => saveConfig(context.config, context.configPath),
  );
  if (!consented) {
    ui.addMessage("system", "Spracheingabe abgebrochen: keine Einwilligung erteilt.", "/whisper");
    return;
  }

  let recorder: AudioRecorder;
  try {
    recorder = await selectAudioRecorder(createAudioRecorders());
  } catch (error) {
    ui.addMessage("error", errorMessage(error), "/whisper");
    return;
  }

  let handle: RecordingHandle;
  try {
    handle = await recorder.start();
  } catch (error) {
    ui.addMessage("error", `Aufnahme konnte nicht gestartet werden: ${errorMessage(error)}`, "/whisper");
    return;
  }

  const startedAt = handle.startedAt;
  const tick = (): void => {
    const seconds = Math.floor((Date.now() - startedAt) / 1_000);
    ui.updateRecordingStatus(`Aufnahme läuft · ${seconds}s · Enter stoppt · Esc bricht ab`);
  };
  const timer = setInterval(tick, 1_000);

  type ControlOutcome =
    | { via: "user"; action: "stop" | "cancel" }
    | { via: "limit"; reason: RecordingStopReason; audio: RecordedAudio };
  let outcome: ControlOutcome;
  try {
    outcome = await Promise.race<ControlOutcome>([
      ui
        .awaitRecordingControl("Aufnahme läuft · 0s · Enter stoppt · Esc bricht ab")
        .then((action) => ({ via: "user", action })),
      handle.autoStopped.then(({ reason, audio }) => ({ via: "limit", reason, audio })),
    ]);
  } finally {
    clearInterval(timer);
  }

  if (outcome.via === "limit") {
    // The keypress promise above is still pending — this ends "recording"
    // mode as if Enter had been pressed, without signalling the recorder
    // again (it already stopped itself).
    ui.triggerRecordingControl("stop");
    ui.addMessage(
      "system",
      `Aufnahme automatisch beendet: ${recordingLimitLabel(outcome.reason)}.`,
      "/whisper",
    );
    await transcribeAndInsert(ui, context, outcome.audio, { surface: setupSurface });
    return;
  }

  if (outcome.action === "cancel") {
    await handle.cancel();
    ui.addMessage("system", "Aufnahme abgebrochen.", "/whisper");
    return;
  }

  let audio: RecordedAudio;
  try {
    audio = await handle.stop();
  } catch (error) {
    ui.addMessage("error", errorMessage(error), "/whisper");
    return;
  }
  await transcribeAndInsert(ui, context, audio, { surface: setupSurface });
}

/** Sends the recording to `config.transcriptionModel`, inserts the result into the input line, and always deletes the temp file. */
export async function transcribeAndInsert(
  ui: TerminalUi,
  context: RuntimeContext,
  audio: RecordedAudio,
  dependencies: {
    transcribe?: typeof transcribeAudio;
    surface?: SetupSurface;
  } = {},
): Promise<void> {
  if (audio.quiet) {
    ui.addMessage(
      "system",
      "Die Aufnahme wirkt sehr leise. Bringt die Erkennung nichts, versuche es lauter oder näher am Mikrofon erneut.",
      "/whisper",
    );
  }
  ui.setStatus("Aufnahme wird erkannt …");
  try {
    const result = await context.providerRuntime.runWithReadyRoute(
      (route) => {
        if ((route as RouteIdentityV1 | undefined)?.backendId === "kimi-code") {
          throw new Error("Sprache und Transkription sind mit Kimi Code Abo in Orcode noch nicht verfügbar.");
        }
        return dependencies.transcribe
          ? dependencies.transcribe({
              client: undefined as never,
              openRouter: context.openRouter,
              modelId: context.config.transcriptionModel,
              audio,
            })
          : transcribeAudio({
              client: context.openRouter.client({ scope: "voice" }),
              openRouter: context.openRouter,
              modelId: context.config.transcriptionModel,
              audio,
            });
      },
      dependencies.surface,
    );
    if (!result.text) {
      ui.addMessage(
        "system",
        "Die Erkennung hat keinen Text geliefert — die Aufnahme war vermutlich zu leise oder unverständlich.",
        "/whisper",
      );
    } else {
      ui.insertInputText(result.text);
      ui.addMessage("system", `Erkannt: „${result.text}“ — steht jetzt in der Eingabezeile.`, "/whisper");
    }
    if (result.costUsd > 0) {
      context.session.addCost("voice", result.costUsd);
      await context.session.save();
    }
  } catch (error) {
    ui.addMessage("error", `Transkription fehlgeschlagen: ${context.openRouter.safeMessage(error)}`, "/whisper");
  } finally {
    await deleteRecordedAudio(audio);
  }
}

async function chooseDashboardImage(
  ui: TerminalUi,
): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error(
      "Automatische Dateiauswahl ist hier nicht verfügbar. Verwende /image <pfad>.",
    );
  }
  return ui.suspend(async () => {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-e",
          'POSIX path of (choose file with prompt "Bild für orcode auswählen" of type {"public.image"})',
        ],
        {
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 100_000,
        },
      );
      return stdout.trim() || null;
    } catch (error) {
      const message = errorMessage(error);
      if (/canceled|cancelled|-128/i.test(message)) {
        return null;
      }
      throw error;
    }
  });
}

export async function initializeDashboardKey(
  ui: TerminalUi,
  context: RuntimeContext,
  _fallbackKey?: string,
): Promise<BalanceInfo | null> {
  if (!context.openRouter.hasKey) {
    return promptDashboardInferenceKey(ui, context);
  }

  const controller = new AbortController();
  ui.setStatus("Aktiven API-Key und Guthaben prüfen");
  ui.setCancelHandler(() => {
    controller.abort(new Error("Die OpenRouter-Startprüfung wurde abgebrochen."));
  });
  try {
    const currentBalance = await context.openRouter.checkBalance(controller.signal);
    assertSpendAvailable(currentBalance);
    return currentBalance;
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      return null;
    }
    if (!shouldReplaceCredential(error, context.openRouter)) {
      throw error;
    }
    ui.addMessage(
      "error",
      `Der bisherige API-Key wurde von OpenRouter abgelehnt, bleibt aber bis zu einer validierten Ersetzung unverändert: ${context.openRouter.safeMessage(error)}`,
      "OpenRouter",
    );
  } finally {
    ui.setCancelHandler();
  }

  return promptDashboardInferenceKey(ui, context);
}

function currentDashboardRoute(context: RuntimeContext): RouteIdentityV1 | null {
  if (typeof context.providerRuntime?.currentSessionRoute !== "function") return null;
  try {
    return context.providerRuntime.currentSessionRoute();
  } catch (error) {
    if (
      error instanceof ProviderSetupRequiredError
      || (typeof error === "object" && error !== null && "code" in error
        && error.code === "provider-setup-required")
    ) return null;
    throw error;
  }
}

export function dashboardKimiUnsupportedMessage(
  route: RouteIdentityV1,
  command: string,
  args: readonly string[],
): string | null {
  if (route.backendId !== "kimi-code") return null;
  if (command === "image") return "Bilder sind mit Kimi Code Abo in Orcode noch nicht verfügbar.";
  if (command === "whisper") {
    return "Sprache und Transkription sind mit Kimi Code Abo in Orcode noch nicht verfügbar.";
  }
  if (command === "compress" && (args[0] ?? "").toLowerCase() === "model") {
    return "Kompressor-Modellwahl ist mit Kimi Code Abo in Orcode noch nicht verfügbar.";
  }
  return null;
}

function kimiDashboardModelInfo(modelId: string): ModelInfo | null {
  const model = KIMI_CODE_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) return null;
  return {
    id: model.id,
    canonicalSlug: model.id,
    name: model.displayName,
    description: "Kimi-Code-Membership-Modell",
    contextLength: model.effectiveContextDefault,
    promptPrice: -1,
    completionPrice: -1,
    supportedParameters: ["tools", "reasoning"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: {
      defaultEffort: "high",
      defaultEnabled: true,
      mandatory: true,
      supportedEfforts: model.reasoningEfforts === null ? null : [...model.reasoningEfforts],
      supportsMaxTokens: false,
    },
  };
}

function cachedModelInfoFromRoute(route: RouteIdentityV1): ModelInfo {
  const kimi = route.backendId === "kimi-code"
    ? kimiDashboardModelInfo(route.canonicalModelId ?? route.requestedModelId)
    : null;
  if (kimi) return kimi;
  return {
    id: route.requestedModelId,
    ...(route.canonicalModelId
      ? { canonicalSlug: route.canonicalModelId }
      : {}),
    name: route.canonicalModelId ?? route.requestedModelId,
    description: "Zuletzt bestätigte Provider-Modellroute",
    contextLength: 0,
    promptPrice: -1,
    completionPrice: -1,
    supportedParameters: [],
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}

function cachedModelInfoFromDescriptor(model: BackendModelDescriptor): ModelInfo {
  return {
    id: model.requestedModelId,
    canonicalSlug: model.canonicalModelId,
    name: model.displayName,
    description: "Bestätigtes Provider-Katalogmodell",
    contextLength: 0,
    promptPrice: model.backendId === "kimi-code" ? -1 : 0,
    completionPrice: model.backendId === "kimi-code" ? -1 : 0,
    supportedParameters: [
      ...(model.capabilities.tools ? ["tools"] : []),
      ...(model.capabilities.reasoning ? ["reasoning"] : []),
    ],
    inputModalities: model.capabilities.textInput ? ["text"] : [],
    outputModalities: model.capabilities.textOutput ? ["text"] : [],
  };
}

export async function loadProviderModelSnapshot(
  context: Pick<RuntimeContext, "openRouter" | "providerRuntime">,
  modelId: string,
): Promise<ModelSnapshot> {
  const route = currentDashboardRoute(context as RuntimeContext);
  if (route?.backendId !== "kimi-code") {
    return loadModelSnapshot(context.openRouter, modelId);
  }
  const model = kimiDashboardModelInfo(modelId);
  return model
    ? {
        model,
        details: `Kontext ${compactTokens(model.contextLength)} · Kosten providerverwaltet / unbekannt · Tools, Reasoning`,
        status: "available",
      }
    : {
        model: null,
        details: `Aktives Kimi-Code-Modell ist nicht verfügbar: ${modelId}`,
        status: "missing",
      };
}

export async function pickDashboardModel(
  ui: TerminalUi,
  context: RuntimeContext,
  setupSurface?: SetupSurface,
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  const route = currentDashboardRoute(context);
  ui.setStatus(route?.backendId === "kimi-code"
    ? "Kimi-Code-Modelle werden geladen"
    : "Tool-fähige OpenRouter-Modelle werden geladen");
  ui.setCancelHandler(() => {
    controller.abort(new Error("Das Laden der Modellliste wurde abgebrochen."));
  });
  let models: ModelInfo[];
  try {
    if (route?.backendId === "kimi-code") {
      const result = await context.providerCommands.execute(
        { kind: "models", backendId: "kimi-code" },
        setupSurface ?? "fullscreen",
      );
      if (result.kind !== "models") throw new ProviderSetupRequiredError();
      models = result.models.flatMap((entry) => {
        const model = kimiDashboardModelInfo(entry.canonicalModelId);
        return model && model.id === entry.requestedModelId ? [model] : [];
      });
    } else {
      const loadModels = () => context.openRouter.listModels("", false, controller.signal);
      models = mainModelCandidates(
        context.providerRuntime?.runModelCatalog
          ? await context.providerRuntime.runModelCatalog(loadModels, setupSurface)
          : await loadModels(),
      );
    }
  } finally {
    ui.setCancelHandler();
  }
  const selected = await ui.pickModel(
    (query) => rankModels(models, query, context.config.mainModel),
    context.config.mainModel,
  );
  if (!selected) {
    return null;
  }
  await context.providerRuntime?.transitionModel(
    selected.id,
    selected.canonicalSlug ?? selected.id,
    setupSurface,
  );
  context.config.mainModel = selected.id;
  await saveConfig(context.config, context.configPath);
  return selected;
}

export async function pickDashboardCompressorModel(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<ModelInfo | null> {
  if (currentDashboardRoute(context)?.backendId === "kimi-code") {
    throw new Error("Kompressor-Modellwahl ist mit Kimi Code Abo in Orcode noch nicht verfügbar.");
  }
  const controller = new AbortController();
  ui.setStatus("Textmodelle für den Kompressor werden geladen");
  ui.setCancelHandler(() => {
    controller.abort(
      new Error("Das Laden der Kompressor-Modellliste wurde abgebrochen."),
    );
  });
  let models: ModelInfo[];
  try {
    models = compressorModelCandidates(
      await context.openRouter.listModels("", false, controller.signal),
    );
  } finally {
    ui.setCancelHandler();
  }
  const selected = await ui.pickModel(
    (query) => rankModels(models, query, context.config.compressorModel),
    context.config.compressorModel,
    "Kompressor-Modell auswählen",
  );
  if (!selected) {
    return null;
  }
  context.config.compressorModel = selected.id;
  await saveConfig(context.config, context.configPath);
  return selected;
}

async function promptDashboardInferenceKey(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<BalanceInfo | null> {
  while (true) {
    const candidate = await ui.readSecret("OpenRouter API-Key");
    if (candidate === null) {
      ui.addMessage("system", "Key-Eingabe abgebrochen.", "/key");
      return null;
    }
    const controller = new AbortController();
    ui.setStatus("API-Key und Guthaben werden geprüft");
    ui.setCancelHandler(() => {
      controller.abort(new Error("Die Key-Prüfung wurde abgebrochen."));
    });
    try {
      const activated = await validateAndActivateInferenceKey(
        candidate,
        context,
        {
          signal: controller.signal,
          confirmProcessOnly: async (error) => (
            await ui.confirmAction(
              "Key nur für diesen Prozess verwenden?",
              `${errorMessage(error)}\nEs wird keine Klartextdatei oder alternative Speicherung angelegt.`,
            )
          ).accepted,
        },
      );
      if (!activated) {
        ui.addMessage(
          "system",
          "Key unverändert; prozesslokale Verwendung abgebrochen.",
          "/key",
        );
        return null;
      }
      ui.addMessage(
        "system",
        activated.persisted
          ? `OpenRouter-Key validiert und im ${context.credentials.location} gespeichert.`
          : "OpenRouter-Key validiert und nur für diesen Prozess aktiv.",
        "/key",
      );
      return activated.balance;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        ui.addMessage("system", "Key-Prüfung abgebrochen.", "/key");
        return null;
      }
      ui.addMessage("error", context.openRouter.safeMessage(error), "/key");
    } finally {
      ui.setCancelHandler();
    }
  }
}

function dashboardKeyStatus(openRouter: OpenRouterService): string {
  const origin = openRouter.keyOrigin === "keychain"
    ? "Schlüsselbund"
    : openRouter.keyOrigin === "environment"
      ? "Umgebung · prozesslokal"
      : openRouter.keyOrigin === "interactive"
        ? "Prozessspeicher"
        : "fehlt";
  const state = openRouter.runtimeState;
  const validity = state.inferenceValidity === "valid"
    ? "gültig"
    : state.inferenceValidity === "rejected"
      ? "abgelehnt"
      : "ungeprüft";
  const connection = state.connectivity === "connected"
    ? "verbunden"
    : state.connectivity === "reconnecting"
      ? "Reconnect"
      : state.connectivity === "disconnected"
        ? "offline"
        : "Verbindung ungeprüft";
  return `${origin} · ${validity} · ${connection}`;
}

async function inspectWorkspace(workspace: string): Promise<string> {
  try {
    const { stdout, code } = await getGitStatus(workspace);
    if (code !== 0) throw new Error("git status ist fehlgeschlagen");
    const lines = stdout.trimEnd().split(/\r?\n/);
    const branchLine = lines[0]?.startsWith("## ")
      ? lines.shift()!.slice(3)
      : "unbekannt";
    const branch = branchLine.split("...")[0]?.split(" ")[0] || "unbekannt";
    const changes = lines.filter(Boolean).length;
    return `${basename(workspace)} · Git ${branch} · ${
      changes ? `${changes} Änderung${changes === 1 ? "" : "en"}` : "sauber"
    }`;
  } catch {
    return `${basename(workspace)} · kein Git-Repository`;
  }
}

export interface ModelSnapshot {
  model: ModelInfo | null;
  details: string;
  status: "available" | "incompatible" | "missing" | "unavailable";
  error?: unknown;
}

/**
 * Applies an explicit `--model` only after the live catalogue has accepted it
 * for the main-agent role. The dashboard can save session preferences before
 * the first run (for example while opening the chat picker), so validation
 * must precede both the in-memory config change and `setPreferences`.
 */
export async function applyStartupModelPreference(
  openRouter: Pick<OpenRouterService, "listModels">,
  requestedModel: string | undefined,
  config: OrcodeConfigWithBudget,
  session: Pick<SessionStore, "setPreferences">,
): Promise<void> {
  if (requestedModel !== undefined) {
    await resolveMainModelCandidate(openRouter, requestedModel);
    config.mainModel = requestedModel;
  }
  session.setPreferences(
    config.mainModel,
    getReasoningSetting(config),
  );
}

export async function ensureRunnableModelConfiguration(
  openRouter: Pick<OpenRouterService, "listModels">,
  config: Pick<
    OrcodeConfigWithBudget,
    "mainModel" | "fallbackModels" | "compressorModel" | "compressionMode"
  >,
): Promise<{ main: ModelInfo | null; compressor: ModelInfo | null }> {
  const main = await resolveMainModelCandidate(openRouter, config.mainModel);
  for (const modelId of config.fallbackModels) {
    await resolveMainModelCandidate(openRouter, modelId);
  }
  const compressor = config.compressionMode === "off"
    ? null
    : await resolveCompressorModelCandidate(
        openRouter,
        config.compressorModel,
      );
  return { main, compressor };
}

export async function loadModelSnapshot(
  openRouter: Pick<OpenRouterService, "listModels">,
  modelId: string,
): Promise<ModelSnapshot> {
  try {
    const model = await resolveMainModelCandidate(openRouter, modelId);
    return {
      model,
      details: model
        ? summarizeModel(model)
        : "dynamische OpenRouter-Route",
      status: "available",
    };
  } catch (error) {
    if (error instanceof ModelCapabilityError) {
      return {
        model: null,
        details: `Aktives Modell ist für die Main-Rolle inkompatibel: ${modelId}`,
        status: "incompatible",
      };
    }
    if (error instanceof ModelNotFoundError) {
      return {
        model: null,
        details: `Aktives Modell fehlt im OpenRouter-Katalog: ${modelId}`,
        status: "missing",
      };
    }
    return {
      model: null,
      details: "Modellmetadaten momentan nicht verfügbar",
      status: "unavailable",
      error,
    };
  }
}

function summarizeModel(model: ModelInfo): string {
  const capabilities = [
    model.supportedParameters.includes("tools") ? "Tools" : "",
    model.supportedParameters.includes("reasoning") ? "Reasoning" : "",
    model.inputModalities.includes("image") ? "Bilder" : "",
    model.inputModalities.includes("audio") ? "Audio" : "",
  ].filter(Boolean);
  const price =
    model.promptPrice < 0 || model.completionPrice < 0
      ? "Preis dynamisch"
      : model.promptPrice === 0 && model.completionPrice === 0
        ? "kostenlos"
        : `In ${pricePerMillion(model.promptPrice)} · Out ${pricePerMillion(model.completionPrice)}`;
  return [
    `Kontext ${compactTokens(model.contextLength)}`,
    price,
    capabilities.length ? capabilities.join(", ") : "Text",
  ].join(" · ");
}

function providerAuthorityBlocksSetup(kind: string): boolean {
  return kind === "forget-pending"
    || kind === "recovery-required"
    || kind === "stale"
    || kind === "ambiguous"
    || kind === "invalid-pointer";
}

function createProviderEffectAttempt(timeoutMs = 8_000): {
  signal: AbortSignal;
  deadlineAt: number;
  close(): void;
} {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeout = new Error("Provider effect deadline expired.");
  timeout.name = "TimeoutError";
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeout);
  }, Math.min(timeoutMs, 0x7fff_ffff));
  return {
    signal: controller.signal,
    deadlineAt,
    close() {
      clearTimeout(timer);
    },
  };
}

function abortableProviderAction<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const abortReason = () => signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
  if (signal.aborted) return Promise.reject(abortReason());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(abortReason()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (settled || signal.aborted) throw abortReason();
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function pricePerMillion(value: number): string {
  return `$${(value * 1_000_000).toFixed(value * 1_000_000 < 0.1 ? 3 : 2)}/M`;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }
  return String(value);
}

function isPromptExit(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ExitPromptError" ||
    error.message.includes("force closed")
  );
}

// Only run `main()` when this file is the actual process entrypoint (`node
// dist/cli.js` / the `orcode` bin) — not when a test imports pure helpers
// like `parseArgs` or `runOutcomeExitCode` from this module.
// `argv[1]` keeps the path the user typed, while the module URL is always
// symlink-resolved. The installed `orcode` bin *is* a symlink, so comparing
// the two verbatim never matches and `main()` would silently never run.
export function isEntrypoint(
  moduleUrl: string,
  argv1: string | undefined,
  resolvePath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) {
    return false;
  }
  if (moduleUrl === pathToFileURL(argv1).href) {
    return true;
  }
  try {
    return moduleUrl === pathToFileURL(resolvePath(argv1)).href;
  } catch {
    // A deleted or unreadable entrypoint is simply not this module.
    return false;
  }
}

const isMainModule = isEntrypoint(import.meta.url, process.argv[1]);

if (isMainModule) {
  void main().catch((error) => {
    console.error(chalk.red(errorMessage(error)));
    // K8: a usage error (bad option, bare positional argument, invalid
    // --approval/--compress) never even starts a run — it is a
    // "Bedienfehler", exit 2, distinct from a runtime failure (exit 1).
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  });
}
