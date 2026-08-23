#!/usr/bin/env node

import { input, confirm, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  AgentRunError,
  OrcodeAgent,
  assertSpendAvailable,
  isAbortError,
  type AgentRunOutcome,
  type AgentRunResult,
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
  compressorModelCandidates,
  mainModelCandidates,
  ModelCapabilityError,
  ModelNotFoundError,
  rankModels,
  resolveCompressorModelCandidate,
  resolveMainModelCandidate,
  shouldReplaceCredential,
  validateAndActivateInferenceKey,
  type CommandContext,
  type CommandOutput,
} from "./commands.js";
import {
  APP_HOME,
  assertConfigFileSnapshot,
  consumeConfigWarning,
  configPath,
  isApprovalMode,
  isCompressionMode,
  loadConfig,
  migrateAppHome,
  readConfigFileSnapshot,
  saveConfig,
  withConfigWriteLock,
  writeFileAtomicSecure,
  type OrcodeConfigWithBudget,
} from "./config.js";
import {
  CredentialStore,
  normalizeProviderSecret,
  type CredentialKind,
  type CredentialSlotRef,
  type CredentialStoreLike,
} from "./credentials.js";
import { OpenRouterService } from "./openrouter.js";
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
  migrateLegacySession,
  type SaveOutcome,
} from "./session.js";
import {
  TerminalUi,
  UiExitError,
  runOutcomeLabel,
  sanitizeTerminalText,
  type DashboardState,
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
  catastrophicGuardNotice,
  getGitStatus,
  pruneCheckpoints,
} from "./workspace.js";
import { errorMessage, formatUsd, isRecord } from "./utils.js";
import { RunLog } from "./runlog.js";
import { collectRetentionErrors } from "./storage.js";
import {
  createPlainSetupSurface,
  createTuiSetupSurface,
  runSetupHub,
  type SetupHubResult,
  type SetupPreparedRoles,
  type SetupSurface,
} from "./setup-ui.js";
import {
  BackendRegistry,
  ProviderSetupRequiredError,
  sameRoute,
  type RouteIdentityV1,
} from "./backends.js";
import {
  ANTHROPIC_COMING_SOON_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
  OpenRouterBackendAdapter,
} from "./openrouter-backend.js";
import {
  ProviderActivationCoordinator,
  type ProviderActivationRuntimeGuard,
  type ProviderActivationRuntimeLease,
} from "./provider-activation.js";
import {
  ProviderStateStore,
  requirePersistableProviderState,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderSetupStateV1,
  type ProviderStateCommitRequest,
} from "./provider-state.js";
import { SetupOrchestrator, type StartupSetupResult } from "./setup.js";
import { PrivateStore } from "./private-store.js";

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
    openSession: async (workspace, appHome, startup) => {
      if (startup.newChat || startup.chatId) {
        await migrateLegacySession(workspace, appHome);
        return startup.chatId
          ? SessionStore.openById(workspace, startup.chatId, appHome)
          : SessionStore.create(workspace, appHome);
      }
      return SessionStore.open(workspace, appHome);
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
  const session = await deps.openSession(options.workspace, appHome, options);
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
}

export interface ProviderRuntime {
  readonly openRouter: OpenRouterService;
  readonly credentials: CredentialStore;
  readonly preparedRoles: SetupPreparedRoles | null;
  inspectStartup(): Promise<StartupSetupResult>;
  resolveLegacyDefaultRoute(): Promise<StartupSetupResult>;
  runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<SetupHubResult>;
  ensureRunnableRoute(): RouteIdentityV1;
  runWithReadyRoute<T>(run: (route: RouteIdentityV1) => Promise<T>): Promise<T>;
}

class SessionProviderRuntimeGuard implements ProviderActivationRuntimeGuard {
  #activationHeld = false;
  #activeRuns = 0;

  async acquire(signal: AbortSignal): Promise<ProviderActivationRuntimeLease> {
    if (signal.aborted) throw signal.reason;
    if (this.#activationHeld || this.#activeRuns > 0) {
      throw new Error("Provider runtime is not idle.");
    }
    this.#activationHeld = true;
    let held = true;
    return {
      assertHeld: () => {
        if (!held || !this.#activationHeld || this.#activeRuns > 0) {
          throw new Error("Provider runtime lease was lost.");
        }
      },
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
}

class DefaultProviderRuntime implements ProviderRuntime {
  #preparedRoles: SetupPreparedRoles | null = null;
  #sessionRoute: RouteIdentityV1 | null = null;
  #sessionRoutePersisted = false;

  constructor(
    readonly openRouter: OpenRouterService,
    readonly credentials: CredentialStore,
    private readonly registry: BackendRegistry,
    private readonly stateStore: ProviderStateStore,
    private readonly orchestrator: SetupOrchestrator,
    private readonly runtimeGuard: SessionProviderRuntimeGuard,
    private readonly savedSecret: string | null,
    private readonly environmentSecret: string | null,
    private readonly requestedModel: string,
  ) {}

  get preparedRoles(): SetupPreparedRoles | null {
    return this.#preparedRoles ? structuredClone(this.#preparedRoles) : null;
  }

  async inspectStartup(): Promise<StartupSetupResult> {
    const result = await this.orchestrator.inspectStartup();
    if (
      (result.mode === "setup-required" || result.mode === "route-choice-required")
      && this.savedSecret === null
      && this.environmentSecret
    ) {
      const automatic = await this.runSetup(
        createAutomaticEnvironmentSetupSurface(this.requestedModel),
      );
      if (automatic.kind === "ready") {
        const route = this.ensureRunnableRoute();
        return {
          mode: "ready",
          generation: result.generation,
          defaultRoute: route,
          readyRoutes: [route],
          warnings: [],
          crossEnabled: false,
        };
      }
    }
    return result;
  }

  async resolveLegacyDefaultRoute(): Promise<StartupSetupResult> {
    return this.orchestrator.resolveLegacyDefaultRoute();
  }

  async runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<SetupHubResult> {
    if (surface === "fullscreen") {
      throw new ProviderSetupRequiredError();
    }
    const resolvedSurface = surface === "plain"
      ? createCliPlainSetupSurface()
      : surface;
    let activatedRoute: RouteIdentityV1 | null = null;
    let activatedPersisted = false;
    const setupOrchestrator = {
      activateCandidate: async (
        request: Parameters<SetupOrchestrator["activateCandidate"]>[0],
      ) => {
        const result = await this.orchestrator.activateCandidate(request);
        const route = validateRouteIdentityV1(result.route);
        if (route?.resolutionState === "resolved" && route.canonicalModelId) {
          activatedRoute = route;
          activatedPersisted = result.persisted;
        }
        return result;
      },
    } as SetupOrchestrator;
    const result = await runSetupHub({
      surface: resolvedSurface,
      orchestrator: setupOrchestrator,
      registry: this.registry,
      stateStore: this.stateStore,
      savedSecret: this.savedSecret,
      environmentSecret: this.environmentSecret,
    });
    if (result.kind === "ready") {
      this.#preparedRoles = result.preparedRoles
        ? structuredClone(result.preparedRoles)
        : null;
      this.#sessionRoute = activatedRoute
        ?? result.preparedRoles?.lead
        ?? this.#sessionRoute;
      if (activatedRoute) this.#sessionRoutePersisted = activatedPersisted;
    }
    return result;
  }

  ensureRunnableRoute(): RouteIdentityV1 {
    if (this.#sessionRoute) {
      if (!this.#sessionRoutePersisted) {
        return structuredClone(this.#sessionRoute);
      }
      const state = this.stateStore.read();
      const current = state.defaultRoute;
      const enabled = state.connections.some((connection) =>
        connection.enabled
        && connection.backendId === this.#sessionRoute!.backendId
        && connection.accountFingerprint === this.#sessionRoute!.accountFingerprint
        && connection.billingRealm === this.#sessionRoute!.billingRealm
      );
      if (
        current
        && enabled
        && sameRoute(current, this.#sessionRoute)
        && current.requestedModelId === this.#sessionRoute.requestedModelId
        && current.resolutionState === "resolved"
      ) {
        return structuredClone(this.#sessionRoute);
      }
      this.#sessionRoute = null;
      this.#sessionRoutePersisted = false;
    }
    return this.orchestrator.ensureRunnableRoute();
  }

  async runWithReadyRoute<T>(run: (route: RouteIdentityV1) => Promise<T>): Promise<T> {
    const route = this.ensureRunnableRoute();
    const release = this.runtimeGuard.beginRun();
    try {
      return await run(route);
    } finally {
      release();
    }
  }
}

function credentialSlotFromState(
  state: ReturnType<ProviderStateStore["read"]>,
): "legacy:inference" | CredentialSlotRef {
  const raw = state.connections.find((connection) =>
    connection.backendId === "openrouter" && connection.enabled
  )?.credentialSlot;
  if (!raw || raw === "legacy:inference") return "legacy:inference";
  const match = /^v1:(inference):([0-9a-f-]{36})$/.exec(raw);
  return match
    ? { version: 1, kind: "inference", id: raw }
    : "legacy:inference";
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
): Promise<ProviderSetupStateV1> {
  try {
    return await persistProviderSetupStateOwned(path, request);
  } catch {
    throw new Error("Provider state publication failed.");
  }
}

async function persistProviderSetupStateOwned(
  path: string,
  request: ProviderStateCommitRequest,
): Promise<ProviderSetupStateV1> {
  return withConfigWriteLock(path, async (ownership) => {
    await ownership.assertHeld();
    const target = await readConfigFileSnapshot(ownership.canonicalPath);
    await ownership.assertHeld();
    if (target.kind !== "file") {
      throw new Error("Provider state publication requires an initialized config.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(target.raw);
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
    const span = findStartupTopLevelJsonValue(target.raw, "providerSetup");
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
    const nextRaw = `${target.raw.slice(0, span.start)}${JSON.stringify(candidate)}${target.raw.slice(span.end)}`;
    request.assertCurrent();
    await ownership.assertHeld();
    let writeError: unknown;
    try {
      await writeFileAtomicSecure(
        ownership.canonicalPath,
        nextRaw,
        async () => {
          request.assertCurrent();
          await ownership.assertHeld();
          await assertConfigFileSnapshot(ownership.canonicalPath, target);
          await ownership.assertHeld();
        },
      );
    } catch (error) {
      writeError = error;
    }
    await ownership.assertHeld();
    const readback = await readConfigFileSnapshot(ownership.canonicalPath);
    await ownership.assertHeld();
    if (readback.kind !== "file" || readback.raw !== nextRaw) {
      if (writeError !== undefined) throw writeError;
      throw new Error("Provider state publication could not be verified.");
    }
    request.assertCurrent();
    request.adopt(candidate);
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

export async function createDefaultProviderRuntime(
  input: ProviderRuntimeInput,
): Promise<ProviderRuntime> {
  const { startup, environment } = input;
  const credentials = createCredentialStoreForStartup(startup.appHome);
  const stateStore = new ProviderStateStore(startup.config.providerSetup, {
    persist: (request) => persistProviderSetupState(startup.configPath, request),
  });
  const inferenceReference = credentialSlotFromState(stateStore.read());
  const storedInference = await loadCredentialReferenceForStartup(
    credentials,
    inferenceReference,
  );
  const storedManagement = await loadStoredCredentialForStartup(
    credentials,
    "management",
  );
  const inferenceServiceCredential = providerServiceStartupCredential(
    storedInference,
    environment.OPENROUTER_API_KEY ?? null,
  );
  const managementServiceCredential = providerServiceStartupCredential(
    storedManagement,
    environment.OPENROUTER_MANAGEMENT_KEY ?? null,
  );
  const openRouter = createOpenRouterServiceForStartup({
    storedInferenceKey: inferenceServiceCredential.stored,
    environmentInferenceKey: inferenceServiceCredential.environment,
    storedManagementKey: managementServiceCredential.stored,
    environmentManagementKey: managementServiceCredential.environment,
  });
  const connectionId = stateStore.read().connections.find((connection) =>
    connection.backendId === "openrouter" && connection.enabled
  )?.id ?? randomUUID();
  const adapter = new OpenRouterBackendAdapter({
    service: openRouter,
    credentials,
    connectionId,
    inferenceCredential: inferenceReference,
    environment,
  });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
    { descriptor: ANTHROPIC_COMING_SOON_DESCRIPTOR },
  ]);
  const runtimeGuard = new SessionProviderRuntimeGuard();
  const activationCoordinator = new ProviderActivationCoordinator({
    appHome: startup.appHome,
    configPath: startup.configPath,
    privateStore: new PrivateStore({ root: startup.appHome }),
    credentials,
    adapter,
    stateStore,
    runtimeGuard,
  });
  await activationCoordinator.recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator,
  });
  const savedSecret = inferenceServiceCredential.stored.kind === "present"
    ? inferenceServiceCredential.stored.value
    : null;
  return new DefaultProviderRuntime(
    openRouter,
    credentials,
    registry,
    stateStore,
    orchestrator,
    runtimeGuard,
    savedSecret,
    storedInference.kind === "absent"
      ? environment.OPENROUTER_API_KEY ?? null
      : null,
    input.requestedModel ?? startup.config.mainModel,
  );
}

export interface PlainRunInput extends Omit<RuntimeContext, "agent"> {
  agent: OrcodeAgent | null;
  ensureAgentForPrompt(surface?: SetupSurface): Promise<OrcodeAgent>;
  resumeFlag?: boolean;
  noResumeFlag?: boolean;
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
  let modelPreferencesApplied = false;

  const ensureAgentForPrompt = async (surface?: SetupSurface): Promise<OrcodeAgent> => {
    try {
      providerRuntime.ensureRunnableRoute();
    } catch (error) {
      if (!(error instanceof ProviderSetupRequiredError) &&
        (typeof error !== "object" || error === null || !("code" in error) || error.code !== "provider-setup-required")) {
        throw error;
      }
      const setup = await providerRuntime.runSetup(surface ?? "plain");
      if (setup.kind !== "ready") throw new ProviderSetupRequiredError();
      providerRuntime.ensureRunnableRoute();
    }
    if (!modelPreferencesApplied) {
      if (!options.model && session.data.model) config.mainModel = session.data.model;
      if (!options.model && session.data.reasoning) {
        setReasoningSetting(config, session.data.reasoning);
      }
      await applyStartupModelPreference(
        providerRuntime.openRouter,
        options.model,
        config,
        session,
      );
      modelPreferencesApplied = true;
    }
    if (!agent) {
      agent = await dependencies.createAgent({
        openRouter: providerRuntime.openRouter,
        approvals,
        session,
        config,
        workspace,
        sshSession,
      });
    }
    return agent;
  };

  if (nonInteractive) {
    try {
      // Non-interactive starts prove readiness before entering the helper that
      // is allowed to open an interactive setup surface.
      providerRuntime.ensureRunnableRoute();
      agent = await ensureAgentForPrompt();
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
    await ensureRunnableModelConfiguration(providerRuntime.openRouter, config);
    const effectivePrompt = await applyInterruptedRunNonInteractive(
      session,
      options,
      out,
      prompt,
    );
    const execute = () => runNonInteractive(agent!, effectivePrompt, { json: options.json });
    if (typeof providerRuntime.runWithReadyRoute === "function") {
      return providerRuntime.runWithReadyRoute(() => execute());
    }
    providerRuntime.ensureRunnableRoute();
    return execute();
  }

  let interactiveSetupReady = true;
  if (startupSetup.mode === "setup-required" || startupSetup.mode === "route-choice-required") {
    if (!useTui) {
      interactiveSetupReady = (await providerRuntime.runSetup("plain")).kind === "ready";
    } else {
      interactiveSetupReady = false;
    }
  }
  if (interactiveSetupReady) {
    try {
      agent = await ensureAgentForPrompt();
    } catch (error) {
      if (!(error instanceof ProviderSetupRequiredError) &&
        (typeof error !== "object" || error === null || !("code" in error) || error.code !== "provider-setup-required")) {
        throw error;
      }
    }
  }

  const common = {
    workspace,
    configPath: runtimeConfigPath,
    config,
    approvals,
    openRouter: providerRuntime.openRouter,
    session,
    agent,
    credentials: providerRuntime.credentials,
    out,
    ruleStore,
    sshSession,
    providerRuntime,
    ensureAgentForPrompt,
    resumeFlag: options.resume,
    noResumeFlag: options.noResume,
  } satisfies PlainRunInput;
  if (useTui) {
    await dependencies.runDashboard({
      ...common,
      setupRequired: agent === null,
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
  workspace: string;
  configPath: string;
  config: OrcodeConfigWithBudget;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: OrcodeAgent;
  providerRuntime: ProviderRuntime;
  credentials: CredentialStore;
  out: CommandOutput;
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
  confirmProcessOnlyCredential?: CommandContext["confirmProcessOnlyCredential"];
  readCredentialSecret?: CommandContext["readCredentialSecret"];
  /** Direct slash-command process events (currently `/diff`) for the active dashboard. */
  onRunEvent?: (event: AgentRunEvent) => void;
}

async function runPlainLoop(
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
  while (true) {
    let value: string;
    try {
      value = await input({
        message: chalk.cyan("›"),
      });
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
        if (commandRequiresRunnableRoute(commandName, commandArguments(trimmed))) {
          const agent = await context.ensureAgentForPrompt();
          context.agent = agent;
        }
        const outcome = await handleSlashCommand(trimmed, context as RuntimeContext);
        if (outcome === "exit") {
          break;
        }
        continue;
      }
      const agent = await context.ensureAgentForPrompt();
      context.agent = agent;
      await ensureRunnableModelConfiguration(context.openRouter, context.config);
      const effective = pendingSeed ? `${pendingSeed}\n\n${trimmed}` : trimmed;
      pendingSeed = undefined;
      const result = await context.providerRuntime.runWithReadyRoute(() =>
        agent.run(effective)
      );
      printRunFooter(result);
    } catch (error) {
      console.error(chalk.red(context.openRouter.safeMessage(error)));
      if (error instanceof AgentRunError) {
        // The fragment is already in the chat file; name what it cost.
        printRunFooter(error.result);
      }
      if (
        !(error instanceof ProviderSetupRequiredError)
        && shouldReplaceCredential(error, context.openRouter)
      ) {
        const setup = await context.providerRuntime.runSetup("plain");
        if (setup.kind === "ready") {
          context.agent = await context.ensureAgentForPrompt();
        }
      }
    }
  }

  await context.session.save();
  console.log("Bis bald.");
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
    const outcome = await undoInterruptedRun(
      context.agent.journal,
      context.agent.guard,
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
      sessionCost: formatUsd(context.session.data.costs.totalUsd),
      maxCost: formatUsd(context.config.maxCostUsd),
      maxSteps: context.config.maxSteps,
      keyStatus: dashboardKeyStatus(context.openRouter),
      sshHost: context.sshSession.active ?? undefined,
    };
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
    if (context.setupRequired) {
      const setup = await context.providerRuntime.runSetup(setupSurface);
      if (setup.kind === "ready") {
        try {
          context.agent = await context.ensureAgentForPrompt(setupSurface);
        } catch (error) {
          if (!(error instanceof ProviderSetupRequiredError)) throw error;
        }
      }
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
    if (context.agent) {
      void Promise.all([
        inspectWorkspace(context.workspace),
        loadModelSnapshot(context.openRouter, startupModel),
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

    balanceLabel = context.agent ? "Provider bereit" : "Setup erforderlich";

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

          if (commandRequiresRunnableRoute(completedCommand, commandArgs, "dashboard")) {
            context.agent = await context.ensureAgentForPrompt(setupSurface);
          }

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
            await runVoiceCapture(ui, context as RuntimeContext);
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "model" && commandArgs.length === 0) {
            const selected = await pickDashboardModel(ui, context as RuntimeContext);
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
              const snapshot = await loadModelSnapshot(
                context.openRouter,
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
            if (switched && context.agent) {
              startingSessionCost = context.session.data.costs.totalUsd;
              resolvedModel = "";
              const snapshot = await loadModelSnapshot(
                context.openRouter,
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

          const outcome = await handleSlashCommand(trimmed, context as RuntimeContext);
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
            const snapshot = await loadModelSnapshot(
              context.openRouter,
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

        const agent = await context.ensureAgentForPrompt(setupSurface);
        context.agent = agent;
        const runnableModels = await ensureRunnableModelConfiguration(
          context.openRouter,
          context.config,
        );
        if (runnableModels.main) {
          currentModelInfo = runnableModels.main;
          modelDetails = summarizeModel(runnableModels.main);
        }
        if (pendingImages.length) {
          if (!currentModelInfo) {
            const snapshot = await loadModelSnapshot(
              context.openRouter,
              context.config.mainModel,
            );
            currentModelInfo = snapshot.model;
            modelDetails = snapshot.details;
          }
          if (
            currentModelInfo &&
            !currentModelInfo.inputModalities.includes("image")
          ) {
            ui.addMessage(
              "error",
              `Das aktive Modell ${context.config.mainModel} unterstützt laut OpenRouter keine Bilder. Wähle mit /model ein Modell mit „Bilder“-Fähigkeit; die Anhänge bleiben erhalten.`,
              "Bilder",
            );
            ui.setStatus("Bereit", false);
            continue;
          }
        }
        submittedImages = pendingImages.map((attachment) => ({
          ...attachment,
        }));
        pendingImages = [];
        ui.setImageAttachments([]);
        const imageSummary = attachmentPromptSummary(submittedImages);
        ui.addMessage(
          "user",
          imageSummary ? `${trimmed}\n\n🖼 ${imageSummary}` : trimmed,
        );
        ui.beginAssistant(context.config.mainModel);
        const controller = new AbortController();
        runController = controller;
        ui.setCancelHandler(() => {
          runController?.abort(new Error("Der aktuelle Lauf wurde vom Benutzer abgebrochen."));
        });
        const result = await context.providerRuntime.runWithReadyRoute(() =>
          agent.run(
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
          )
        );
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
        if (partial && partial.costUsd > 0) {
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

async function pickDashboardChat(
  ui: TerminalUi,
  context: RuntimeContext,
  preferNew: boolean,
): Promise<boolean> {
  await saveDashboardSessionPreferences(context, ui);
  const chats = await SessionStore.list(context.workspace, context.session.appHome);
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
    next.setPreferences(
      context.config.mainModel,
      getReasoningSetting(context.config),
    );
  } else {
    if (picked.value === context.session.data.id) {
      return false;
    }
    next = await SessionStore.openById(
      context.workspace,
      picked.value,
      context.session.appHome,
    );
    if (next.data.model) {
      context.config.mainModel = next.data.model;
    }
    if (next.data.reasoning) {
      setReasoningSetting(context.config, next.data.reasoning);
    }
  }

  context.session = next;
  // Reuse the agent: rebuilding it dropped the cached model resolution, the
  // compressor price cache and the undo journal on every chat switch.
  context.agent.setSession(next);
  await saveDashboardSessionPreferences(context, ui);
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
    description: `${chat.turnCount} Nachrichten · ${formatUsd(chat.costUsd)}${model} · ${formatChatAge(chat.updatedAt)} · ${chat.id.slice(0, 8)}`,
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
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
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

function formatRunCost(result: AgentRunResult): string {
  return result.compressorCostUsd > 0
    ? `${formatUsd(result.costUsd)} (Main ${formatUsd(result.mainCostUsd)} · Kompressor ${formatUsd(result.compressorCostUsd)})`
    : formatUsd(result.costUsd);
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
  if (command === "model" || command === "models" || command === "think") {
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
async function runVoiceCapture(ui: TerminalUi, context: RuntimeContext): Promise<void> {
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
    await transcribeAndInsert(ui, context, outcome.audio);
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
  await transcribeAndInsert(ui, context, audio);
}

/** Sends the recording to `config.transcriptionModel`, inserts the result into the input line, and always deletes the temp file. */
async function transcribeAndInsert(
  ui: TerminalUi,
  context: RuntimeContext,
  audio: RecordedAudio,
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
    const result = await transcribeAudio({
      client: context.openRouter.client({ scope: "voice" }),
      openRouter: context.openRouter,
      modelId: context.config.transcriptionModel,
      audio,
    });
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

export async function pickDashboardModel(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  ui.setStatus("Tool-fähige OpenRouter-Modelle werden geladen");
  ui.setCancelHandler(() => {
    controller.abort(new Error("Das Laden der Modellliste wurde abgebrochen."));
  });
  let models: ModelInfo[];
  try {
    models = mainModelCandidates(
      await context.openRouter.listModels("", false, controller.signal),
    );
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
  context.config.mainModel = selected.id;
  await saveConfig(context.config, context.configPath);
  return selected;
}

export async function pickDashboardCompressorModel(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<ModelInfo | null> {
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
