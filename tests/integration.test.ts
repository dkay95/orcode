import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrcodeAgent } from "../src/agent.js";
import { ApprovalManager } from "../src/approval.js";
import {
  createPlainCommandOutput,
  handleSlashCommand,
  type CommandContext,
  type CommandOutput,
} from "../src/commands.js";
import {
  DEFAULT_CONFIG,
  loadConfigDetailed,
  readConfigFileSnapshot,
  readConfigEditSnapshot,
  sameConfigFileSnapshot,
  saveConfigEditUnderLock,
  saveConfig,
  withConfigWriteLock,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import type {
  CredentialKind,
  CredentialSlotRef,
  CredentialStoreLike,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";
import { executeProviderModelAction } from "../src/cli.js";
import { OpenRouterHttpError, OpenRouterService } from "../src/openrouter.js";
import {
  ProviderActivationCoordinator,
  type ProviderActivationBoundary,
  type ProviderPreferenceCleanupAuthority,
  type ProviderPreferenceMutationAuthority,
} from "../src/provider-activation.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ProviderStateStore,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV2,
} from "../src/provider-state.js";
import { createRunId, RunLog } from "../src/runlog.js";
import { RuleStore, rulesPath, shellApprovalSubject } from "../src/rules.js";
import {
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  SessionStore,
} from "../src/session.js";
import {
  MODEL_PREFERENCE_FAILPOINTS,
  ModelPreferenceCrashError,
  recoverModelPreferenceTransactions,
  runModelPreferenceTransaction,
  type ModelPreferenceAuthorityPublication,
} from "../src/model-preference-transaction.js";
import type {
  BackendModelDescriptor,
  CandidateProviderState,
  ProviderCandidate,
  RouteIdentityV1,
} from "../src/backends.js";
import type { ToolCallPreview } from "../src/types.js";
import { ChangeJournal, WorkspaceGuard } from "../src/workspace.js";

const TEST_KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

/**
 * These tests cover the seams between the modules, not the modules themselves:
 * whatever the command layer writes into the workspace must obey exactly the
 * same path policy as the write tools.
 */

interface Harness {
  context: CommandContext;
  workspace: string;
  asked: ToolCallPreview[];
}

function integrationPreferenceMutationAuthority() {
  const controller = new AbortController();
  let phase: "active" | "reconciling" | "completing" | "cleaning" | "completed" = "active";
  let completionAcknowledged = false;
  let cleanupAcknowledged = false;
  const authority = Object.freeze<ProviderPreferenceMutationAuthority>({
    signal: controller.signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    assertMutationAllowed() {
      if (phase !== "active" || controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("integration preference authority revoked");
      }
    },
    async assertMutationAuthorityHeld() {
      this.assertMutationAllowed();
    },
    assertReconcileAllowed() {
      if (phase !== "reconciling") {
        throw new Error("integration preference reconcile authority lost");
      }
    },
    async assertReconcileAuthorityHeld() {
      this.assertReconcileAllowed();
    },
    assertCompletionAllowed() {
      if (phase !== "completing") {
        throw new Error("integration preference completion authority lost");
      }
    },
    async acknowledgePersistence(configFence) {
      return Object.freeze({ configFence });
    },
    async assertCompletionAuthorityHeld() {
      this.assertCompletionAllowed();
    },
    async acknowledgeCompletion() {
      this.assertCompletionAllowed();
      if (completionAcknowledged) {
        throw new Error("integration preference completion replayed");
      }
      completionAcknowledged = true;
      return Object.freeze({ version: 1 as const });
    },
  });
  const cleanupAuthority = Object.freeze<ProviderPreferenceCleanupAuthority>({
    signal: new AbortController().signal,
    assertCleanupAllowed() {
      if (phase !== "cleaning" || cleanupAcknowledged) {
        throw new Error("integration preference cleanup authority lost");
      }
    },
    async assertCleanupAuthorityHeld() {
      this.assertCleanupAllowed();
    },
    async acknowledgeCleanup() {
      this.assertCleanupAllowed();
      cleanupAcknowledged = true;
      return Object.freeze({ version: 1 as const });
    },
  });
  return {
    authority,
    cleanupAuthority,
    beginCompletion() {
      if (phase !== "active") throw new Error("integration preference authority lost");
      phase = "completing";
    },
    finishCompletion() {
      if (phase !== "completing" || !completionAcknowledged) {
        throw new Error("integration preference completion is not acknowledged");
      }
      phase = "cleaning";
    },
    finishCleanup() {
      if (phase !== "cleaning" || !cleanupAcknowledged) {
        throw new Error("integration preference cleanup is not acknowledged");
      }
      phase = "completed";
    },
  };
}

function providerCommittedConfigRaw(
  stagingRaw: string,
  nextProviderState: ProviderSetupStateV2,
): string {
  const marker = '"providerSetup": ';
  const markerAt = stagingRaw.indexOf(marker);
  assert.notEqual(markerAt, -1);
  const start = markerAt + marker.length;
  assert.equal(stagingRaw[start], "{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = start;
  for (; end < stagingRaw.length; end += 1) {
    const character = stagingRaw[end]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  assert.equal(depth, 0);
  return `${stagingRaw.slice(0, start)}${JSON.stringify(nextProviderState)}${stagingRaw.slice(end)}`;
}

async function harness(
  options: { approve?: boolean } = {},
): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), "routercode-integration-"));
  const appHome = join(workspace, ".state");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
  const session = await SessionStore.open(workspace, appHome);
  session.addTurn("user", "Erste Frage");
  session.addTurn("assistant", "Erste Antwort");

  const approvals = new ApprovalManager("allow-all");
  const asked: ToolCallPreview[] = [];
  approvals.setPromptHandler(async (preview) => {
    asked.push(preview);
    return { accepted: options.approve === true };
  });

  const openRouter = new OpenRouterService(`${TEST_KEY_PREFIX}integration-test-key-0001`);
  const config = {
    ...DEFAULT_CONFIG,
    reasoningByModel: {},
    budget: { ...DEFAULT_CONFIG.budget },
  };
  const agent = await OrcodeAgent.create({
    openRouter,
    approvals,
    session,
    config,
    workspace,
  });
  const ruleStore = await RuleStore.load(appHome);
  const credentials: CredentialStoreLike = {
    location: "Test-Speicher",
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
  };
  return {
    workspace,
    asked,
    context: {
      config,
      approvals,
      openRouter,
      session,
      agent,
      workspace,
      credentials,
      out: createPlainCommandOutput(),
      ruleStore,
      // REGEL: no test may ever write to the real ~/.routercode/config.json —
      // every command that persists `config` must go through this instead of
      // `saveConfig`'s bare default path.
      configPath: join(appHome, "config.json"),
    },
  };
}

/** Collects `ctx.out` writes instead of printing them, for assertions. */
function collectOutput(): { out: CommandOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: {
      text(value: string): void {
        lines.push(value);
      },
      error(value: string, hint?: string): void {
        lines.push(hint ? `${value}\n${hint}` : value);
      },
    },
  };
}

interface TaskTenActivationTuple {
  revision: number;
  lifecycle: ProviderSetupStateV2["lifecycle"];
  connections: ProviderConnectionStateV1[];
  route: RouteIdentityV1 | null;
  cross: ProviderSetupStateV2["cross"];
  slots: Array<{
    id: string;
    secret: "old" | "new" | "foreign" | "other";
  }>;
  journals: string[];
}

const TASK_TEN_OLD_SLOT_ID = "v1:inference:10000000-0000-4000-8000-000000000001";
const TASK_TEN_NEW_SLOT_ID = "v1:inference:10000000-0000-4000-8000-000000000002";
const TASK_TEN_FOREIGN_SLOT_ID = "v1:inference:10000000-0000-4000-8000-000000000099";
const TASK_TEN_CONNECTION_ID = "task-ten-exact-activation-connection";
const TASK_TEN_OLD_FINGERPRINT = "acct_or_task_ten_old";
const TASK_TEN_NEW_FINGERPRINT = "acct_or_task_ten_new";

function expectedTaskTenActivationTuple(kind: "old" | "new"): TaskTenActivationTuple {
  const route: RouteIdentityV1 = kind === "old"
    ? {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: TASK_TEN_OLD_FINGERPRINT,
      billingRealm: "openrouter-payg",
      requestedModelId: "synthetic/task-ten-old-model",
      canonicalModelId: "synthetic/task-ten-old-model",
      resolutionState: "resolved",
    }
    : {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: TASK_TEN_NEW_FINGERPRINT,
      billingRealm: "openrouter-payg",
      requestedModelId: "synthetic/task-ten-new-requested",
      canonicalModelId: "synthetic/task-ten-new-canonical",
      resolutionState: "resolved",
    };
  return {
    revision: kind === "old" ? 3 : 4,
    lifecycle: "configured",
    connections: [{
      id: TASK_TEN_CONNECTION_ID,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: kind === "old" ? TASK_TEN_OLD_SLOT_ID : TASK_TEN_NEW_SLOT_ID,
      accountFingerprint: kind === "old"
        ? TASK_TEN_OLD_FINGERPRINT
        : TASK_TEN_NEW_FINGERPRINT,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: kind === "old"
        ? null
        : {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
          observedAt: 10,
          generation: 4,
        },
    }],
    route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    slots: kind === "old"
      ? [
        { id: TASK_TEN_OLD_SLOT_ID, secret: "old" },
        { id: TASK_TEN_FOREIGN_SLOT_ID, secret: "foreign" },
      ]
      : [
        { id: TASK_TEN_NEW_SLOT_ID, secret: "new" },
        { id: TASK_TEN_FOREIGN_SLOT_ID, secret: "foreign" },
      ],
    journals: [],
  };
}

async function recoverTaskTenActivationTuple(
  crashAfter: Extract<ProviderActivationBoundary, "slot-readback" | "config-readback">,
): Promise<TaskTenActivationTuple> {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-task-ten-activation-"));
  const configPath = join(appHome, "config.json");
  const oldSecret = ["task", "ten", "old", "credential", "safe", "bytes"].join("-");
  const newSecret = ["task", "ten", "new", "credential", "safe", "bytes"].join("-");
  const foreignSecret = ["task", "ten", "foreign", "credential", "safe", "bytes"].join("-");
  const connectionId = TASK_TEN_CONNECTION_ID;
  const oldFingerprint = TASK_TEN_OLD_FINGERPRINT;
  const newFingerprint = TASK_TEN_NEW_FINGERPRINT;
  const oldSlot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "inference",
    id: TASK_TEN_OLD_SLOT_ID,
  });
  const newSlot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "inference",
    id: TASK_TEN_NEW_SLOT_ID,
  });
  const foreignSlot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "inference",
    id: TASK_TEN_FOREIGN_SLOT_ID,
  });
  const oldRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: oldFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/task-ten-old-model",
    canonicalModelId: "synthetic/task-ten-old-model",
    resolutionState: "resolved",
  };
  const newRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: newFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/task-ten-new-requested",
    canonicalModelId: "synthetic/task-ten-new-canonical",
    resolutionState: "resolved",
  };
  const model: BackendModelDescriptor = {
    backendId: "openrouter",
    requestedModelId: newRoute.requestedModelId,
    canonicalModelId: newRoute.canonicalModelId!,
    displayName: "Task Ten New Model",
    capabilities: {
      textInput: true,
      textOutput: true,
      tools: true,
      reasoning: true,
    },
  };
  const oldState: ProviderSetupStateV2 = {
    schemaVersion: 2,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: connectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: oldSlot.id,
      accountFingerprint: oldFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: oldRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  await saveConfig({
    ...structuredClone(DEFAULT_CONFIG),
    providerSetup: oldState,
  } satisfies OrcodeConfigWithBudget, configPath);

  const slots = new Map([
    [oldSlot.id, oldSecret],
    [foreignSlot.id, foreignSecret],
  ]);
  let reserved = false;
  const credentials: VersionedCredentialStoreLike = {
    location: "task-ten-in-memory-store",
    reserveSlot(kind: CredentialKind) {
      assert.equal(kind, "inference");
      assert.equal(reserved, false);
      reserved = true;
      return newSlot;
    },
    async writeSlot(slot, secret) {
      assert.equal(slot, newSlot);
      slots.set(slot.id, secret);
    },
    async readSlot(slot) {
      return slots.get(slot.id) ?? null;
    },
    async deleteSlot(slot) {
      return slots.delete(slot.id);
    },
    async get() {
      return null;
    },
    async set() {},
    async delete() {
      return false;
    },
    async has() {
      return false;
    },
    async getOrCreateAccountHmacKey() {
      return new Uint8Array(32).fill(10);
    },
  };
  let candidateCounter = 0;
  const candidates = new Map<string, string>();
  const adapter = {
    backendId: "openrouter" as const,
    async connect(request: {
      candidate: unknown;
      generation: number;
      signal: AbortSignal;
    }): Promise<ProviderCandidate> {
      assert.equal(request.signal.aborted, false);
      assert.equal(typeof request.candidate, "string");
      const candidateId = `task-ten-candidate-${++candidateCounter}`;
      candidates.set(candidateId, request.candidate as string);
      return {
        candidateId,
        backendId: "openrouter",
        connectionId,
        accountFingerprint: request.candidate === newSecret
          ? newFingerprint
          : oldFingerprint,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
          observedAt: 10,
          generation: request.generation,
        },
      };
    },
    async listModels(request: {
      candidateId?: string;
      signal: AbortSignal;
    }): Promise<readonly BackendModelDescriptor[]> {
      assert.equal(request.signal.aborted, false);
      assert.equal(candidates.has(request.candidateId ?? ""), true);
      return [model];
    },
    async activate(request: {
      candidateId: string;
      model: BackendModelDescriptor;
      signal: AbortSignal;
    }): Promise<CandidateProviderState> {
      assert.equal(request.signal.aborted, false);
      assert.equal(candidates.get(request.candidateId), newSecret);
      assert.equal(request.model.canonicalModelId, model.canonicalModelId);
      return {
        candidateId: request.candidateId,
        backendId: "openrouter",
        connectionId,
        accountFingerprint: newFingerprint,
        billingRealm: "openrouter-payg",
        route: newRoute,
      };
    },
    async discardCandidate(candidateId: string) {
      candidates.delete(candidateId);
    },
  };
  const stateStore = new ProviderStateStore(oldState);
  const privateStore = new PrivateStore({ root: appHome });
  let now = 1_000;
  let uuidCounter = 10;
  const makeCoordinator = (boundary?: ProviderActivationBoundary) =>
    new ProviderActivationCoordinator({
      appHome,
      configPath,
      privateStore,
      credentials,
      adapterResolver: () => adapter,
      stateStore,
      runtimeGuard: {
        async acquire() {
          let held = true;
          return {
            assertHeld() {
              if (!held) throw new Error("task-ten-runtime-lease-lost");
            },
            async release() {
              held = false;
            },
          };
        },
      },
      now: () => now,
      createUuid: () => {
        uuidCounter += 1;
        return `10000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
      },
      leaseDurationMs: 100,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      onBoundary: boundary
        ? async (reached) => {
          if (reached === boundary) throw new Error("task-ten-simulated-crash");
        }
        : async () => undefined,
    });
  const crashing = makeCoordinator(crashAfter);
  await assert.rejects(crashing.activate({
    backendId: "openrouter",
    expectedRevision: oldState.revision,
    candidate: newSecret,
    expectedRequestedModelId: model.requestedModelId,
    selectedCanonicalModelId: model.canonicalModelId,
    generation: 4,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  }));
  now = 5_000;
  await makeCoordinator().recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });

  const loaded = await loadConfigDetailed(configPath);
  assert.equal("kind" in loaded.config.providerSetup, false);
  const state = loaded.config.providerSetup as ProviderSetupStateV2;
  let journals: string[];
  try {
    journals = (await readdir(join(appHome, "provider-activation"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journals = [];
  }
  const tuple: TaskTenActivationTuple = {
    revision: state.revision,
    lifecycle: state.lifecycle,
    connections: structuredClone(state.connections),
    route: state.defaultRoute ? structuredClone(state.defaultRoute) : null,
    cross: structuredClone(state.cross),
    slots: [...slots.entries()]
      .map(([id, value]) => ({
        id,
        secret: value === oldSecret
          ? "old" as const
          : value === newSecret
            ? "new" as const
            : value === foreignSecret
              ? "foreign" as const
              : "other" as const,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    journals,
  };
  await rm(appHome, { recursive: true, force: true });
  return tuple;
}

test("/export writes plain files without a fight", async () => {
  const { context, workspace, asked } = await harness({ approve: true });
  await handleSlashCommand("/export chat.md", context);
  const written = await readFile(join(workspace, "chat.md"), "utf8");
  assert.match(written, /## Verlauf/);
  assert.match(written, /Erste Antwort/);
  assert.equal(
    asked.length,
    0,
    "ein unverdächtiger Pfad darf in allow-all nicht nachfragen",
  );
});

test("/export cannot be used to slip past the deny list", async () => {
  // Same policy as write_file: .git/** always asks, .git/hooks/** is sealed.
  const denied = await harness({ approve: false });
  await assert.rejects(
    handleSlashCommand("/export .git/config", denied.context),
    /abgelehnt|gesperrt/i,
  );
  const gitConfig = denied.asked.at(-1);
  assert.equal(gitConfig?.risk, "edit");
  assert.match(String(gitConfig?.details), /git-metadata|\.git/);

  const hooks = await harness({ approve: true });
  await assert.rejects(
    handleSlashCommand("/export .git/hooks/pre-commit", hooks.context),
    /gesperrt/,
  );
  assert.equal(
    hooks.asked.length,
    0,
    "ein Git-Hook darf gar nicht erst zur Freigabe angeboten werden",
  );
});

test("/export refuses to leave the workspace", async () => {
  const { context } = await harness({ approve: true });
  await assert.rejects(
    handleSlashCommand("/export ../ausserhalb.md", context),
    /außerhalb des Arbeitsverzeichnisses/,
  );
});

test("/init creates its file through the guard, not through a raw path join", async () => {
  const { context, workspace, asked } = await harness({ approve: true });
  await handleSlashCommand("/init", context);
  const created = await readFile(join(workspace, "ORCODE.md"), "utf8");
  assert.match(created, /# orcode project instructions/);
  assert.equal(
    asked.length,
    0,
    "ORCODE.md ist kein geschützter Pfad und fragt in allow-all nicht nach",
  );
});

test("a protected path forces a question even in allow-all", async () => {
  // The mode decides how much the model may do on its own; the path policy
  // decides what nobody may do silently. This is the seam between the two.
  const { context, asked } = await harness({ approve: false });
  assert.equal(context.approvals.mode, "allow-all");
  await assert.rejects(
    handleSlashCommand("/export .env.backup", context),
    /abgelehnt/i,
  );
  assert.equal(asked.length, 1);
  assert.match(String(asked[0]?.details), /Geschützter Pfad|Zugangsdaten/);
});

test("/status reports the limits it can actually enforce", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/status", context);
  const output = lines.join("\n");
  assert.match(output, /Approval: allow-all/);
  assert.match(output, /Budget: kein Tageslimit/);
  // The compressor limit is only enforceable up front when a price is known.
  assert.match(output, /Kompressorlimit/);
});

test("model-independent slash commands remain available with one setup-required provider runtime and no agent", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  const providerRuntime = { status: "setup-required" };
  const setupRequiredContext = {
    ...context,
    agent: null,
    providerRuntime,
    out,
  } as unknown as CommandContext & { providerRuntime: unknown };

  assert.equal(await handleSlashCommand("/help", setupRequiredContext), "continue");
  assert.equal(setupRequiredContext.providerRuntime, providerRuntime);
  assert.match(lines.join("\n"), /orcode Befehle|\/help/i);
});

test("setup-required local chat, clear, checkpoint, and interrupted undo work with zero agent model client", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "orcode-local-no-agent-"));
  const appHome = join(workspace, ".state");
  const session = await SessionStore.open(workspace, appHome);
  session.rename("Original");
  session.addTurn("user", "vorher");
  await session.save();
  const guard = await WorkspaceGuard.create(workspace);
  const localRuntime = {
    guard,
    journal: new ChangeJournal({ appHome, chatId: session.data.id }),
    setSession(next: SessionStore) {
      this.journal = new ChangeJournal({ appHome, chatId: next.data.id });
    },
    resetConversationMemory() {},
  };
  const context = {
    config: structuredClone(DEFAULT_CONFIG),
    configPath: join(appHome, "config.json"),
    approvals: new ApprovalManager("allow-all"),
    openRouter: new OpenRouterService(undefined),
    session,
    agent: null,
    localRuntime,
    workspace,
    credentials: {
      location: "Test-Speicher",
      async get() { return null; },
      async set() {},
      async delete() { return false; },
      async has() { return false; },
    },
    out: collectOutput().out,
    ruleStore: await RuleStore.load(appHome),
    confirmClearSession: async () => true,
  } as unknown as CommandContext;

  await handleSlashCommand("/chat new Lokal", context);
  assert.equal(context.session.data.title, "Lokal");
  await handleSlashCommand("/chat open Original", context);
  assert.equal(context.session.data.title, "Original");

  await handleSlashCommand("/checkpoint new Basis", context);
  context.session.addTurn("assistant", "nachher");
  await handleSlashCommand("/checkpoint restore Basis", context);
  assert.equal(context.session.data.turns.length, 1);

  await handleSlashCommand("/clear", context);
  assert.equal(context.session.data.turns.length, 0);

  const runId = createRunId();
  const log = await RunLog.open(appHome, context.session.data.id, runId);
  log.write({
    type: "run-start",
    model: "vendor/main",
    maxSteps: 1,
    prompt: "unterbrochen",
    timestamp: 1,
  });
  await log.close();
  await handleSlashCommand("/resume undo", context);
});

test("inference key replace and forget delegate to the shared provider credential intent", async () => {
  const { context } = await harness();
  const candidate = `${TEST_KEY_PREFIX}${"r".repeat(48)}`;
  const intents: Array<Record<string, unknown>> = [];
  context.readCredentialSecret = async () => candidate;
  context.confirmCredentialForget = async () => true;
  context.credentials = {
    location: "legacy-store-must-not-run",
    async get() { throw new Error("legacy get bypass"); },
    async set() { throw new Error("legacy set bypass"); },
    async delete() { throw new Error("legacy delete bypass"); },
    async has() { throw new Error("legacy has bypass"); },
  };
  (context as CommandContext & {
    providerCredentials: { apply(intent: Record<string, unknown>): Promise<Record<string, unknown>> };
  }).providerCredentials = {
    async apply(intent) {
      intents.push(intent);
      return intent.kind === "forget"
        ? { kind: "forgotten", credentialKind: "inference", removed: true }
        : {
            kind: "ready",
            credentialKind: "inference",
            persisted: true,
            balance: { key: { isFreeTier: false } },
          };
    },
  };

  await handleSlashCommand("/key replace", context);
  await handleSlashCommand("/key forget", context);

  assert.deepEqual(intents, [
    {
      kind: "replace",
      credentialKind: "inference",
      candidate,
      allowProcessOnly: context.confirmProcessOnlyCredential,
    },
    { kind: "forget", credentialKind: "inference" },
  ]);
});

test("/model proves the selected route before mutating config or session preferences", async () => {
  const { context } = await harness();
  context.config.mainModel = "vendor/a";
  context.session.setPreferences("vendor/a", { mode: "auto" });
  context.openRouter.listModels = async () => [{
    id: "vendor/b",
    name: "Vendor B",
    description: "",
    contextLength: 128_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  }];
  const transitions: string[] = [];
  (context as CommandContext & {
    providerRoutes: { transitionModel(modelId: string): Promise<void> };
  }).providerRoutes = {
    async transitionModel(modelId) {
      assert.equal(context.config.mainModel, "vendor/a");
      assert.equal(context.session.data.model, "vendor/a");
      transitions.push(modelId);
    },
  };

  await handleSlashCommand("/model vendor/b", context);

  assert.deepEqual(transitions, ["vendor/b"]);
  assert.equal(context.config.mainModel, "vendor/b");
  assert.equal(context.session.data.model, "vendor/b");
});

test("/model catalog authentication rejection uses shared recovery before activation or preference bytes", async () => {
  const { context } = await harness();
  context.config.mainModel = "vendor/a";
  context.session.setPreferences("vendor/a", { mode: "auto" });
  const configBefore = structuredClone(context.config);
  const sessionBefore = structuredClone(context.session.data);
  const calls: string[] = [];
  const rejected = new OpenRouterHttpError(401, "raw private catalog response");
  context.openRouter.listModels = async () => {
    calls.push("catalog");
    throw rejected;
  };
  (context as CommandContext & {
    providerRoutes: {
      runModelCatalog<T>(run: () => Promise<T>): Promise<T>;
      transitionModel(modelId: string): Promise<void>;
    };
  }).providerRoutes = {
    runModelCatalog: (run) => executeProviderModelAction({
        ensureRunnableRoute() {
          calls.push("route:ensure");
          return {
            version: 1,
            backendId: "openrouter",
            accountFingerprint: "acct_fixture",
            billingRealm: "openrouter-payg",
            requestedModelId: "vendor/a",
            canonicalModelId: "vendor/a",
            resolutionState: "resolved",
          };
        },
        beginRun() {
          calls.push("run:begin");
          return () => calls.push("run:release");
        },
        run,
        isAuthenticationFailure: (error) => error === rejected,
        async invalidateAndInspect() { calls.push("route:invalidate+inspect"); },
        async runSetup() {
          calls.push("setup:plain");
          return { kind: "cancelled" };
        },
        surface: "plain",
      }),
    async transitionModel() {
      calls.push("activation");
    },
  };

  await assert.rejects(handleSlashCommand("/model vendor/b", context), (error) => error === rejected);

  assert.deepEqual(calls, [
    "route:ensure",
    "run:begin",
    "catalog",
    "run:release",
    "route:invalidate+inspect",
    "setup:plain",
  ]);
  assert.deepEqual(context.config, configBefore);
  assert.deepEqual(context.session.data, sessionBefore);
});

test("opening a chat with another saved model rejects before config or active-session mutation without route proof", async () => {
  const { context } = await harness();
  context.config.mainModel = "vendor/a";
  context.session.setPreferences("vendor/a", { mode: "auto" });
  await context.session.save();
  const originalId = context.session.data.id;
  const other = SessionStore.create(context.workspace, context.session.appHome, "Route B Chat");
  other.setPreferences("vendor/b", { mode: "auto" });
  await other.save();
  (context as CommandContext & {
    providerRoutes: { transitionModel(modelId: string): Promise<void> };
  }).providerRoutes = {
    async transitionModel(modelId) {
      assert.equal(modelId, "vendor/b");
      throw Object.assign(new Error("route transition required"), {
        code: "provider-setup-required",
      });
    },
  };

  await assert.rejects(
    handleSlashCommand("/chat open Route B Chat", context),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "provider-setup-required"
    ),
  );

  assert.equal(context.config.mainModel, "vendor/a");
  assert.equal(context.session.data.id, originalId);
  assert.equal(context.session.data.model, "vendor/a");
});

test("/checkpoint marks a point and rewinds to it", async () => {
  const { context } = await harness({ approve: true });
  await handleSlashCommand("/checkpoint new Basis", context);
  context.session.addTurn("user", "Zweite Frage");
  context.session.addTurn("assistant", "Zweite Antwort");
  assert.equal(context.session.data.turns.length, 4);

  await handleSlashCommand("/checkpoint restore Basis", context);
  assert.equal(context.session.data.turns.length, 2);

  const reopened = await SessionStore.openById(
    context.workspace,
    context.session.data.id,
    context.session.appHome,
  );
  assert.equal(
    reopened.data.turns.length,
    2,
    "der Rücksprung muss gespeichert worden sein",
  );
});

test("/chat operations keep using the app home selected by startup migration", async () => {
  const { context } = await harness();
  const migratedAppHome = context.session.appHome;

  await handleSlashCommand("/chat new Nach Migration", context);

  assert.equal(context.session.appHome, migratedAppHome);
  assert.equal(context.session.data.title, "Nach Migration");
});

test("/chat list with a migrated connection stays read-only and does not persist a projected route", async () => {
  const { context } = await harness();
  const connection: ProviderConnectionStateV1 = {
    id: "task-ten-list-migrated-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_or_task_ten_list_verified",
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 10,
      generation: 2,
    },
  };
  context.config.providerSetup = {
    schemaVersion: 2,
    revision: 2,
    lifecycle: "configured",
    connections: [connection],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const historical = SessionStore.create(
    context.workspace,
    context.session.appHome,
    "Read-only historical chat",
  );
  historical.setPreferences("synthetic/list-historical-model", { mode: "auto" });
  await historical.save();
  const bytesBefore = await readFile(historical.path, "utf8");

  await handleSlashCommand("/chat list", context);

  assert.equal(await readFile(historical.path, "utf8"), bytesBefore);
  const persisted = await SessionStore.openById(
    context.workspace,
    historical.data.id,
    context.session.appHome,
  );
  assert.equal(persisted.data.route, undefined);
  assert.equal(context.config.providerSetup.cross.enabled, false);
});

test("later /chat open keeps using the verified migrated OpenRouter connection for historical routes", async () => {
  const { context } = await harness();
  const nullableContext = context as unknown as CommandContext<OrcodeAgent | null>;
  nullableContext.commitSessionHandoff = (next) => {
    nullableContext.session = next;
    nullableContext.agent = null;
  };
  const connection: ProviderConnectionStateV1 = {
    id: "task-ten-migrated-chat-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_or_task_ten_migrated_verified",
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 10,
      generation: 2,
    },
  };
  context.config.providerSetup = {
    schemaVersion: 2,
    revision: 0,
    lifecycle: "migrated",
    connections: [{
      ...connection,
      accountFingerprint: "acct_legacy_task-ten-migrated-chat-connection",
      accountFingerprintState: "provisional",
      lastHealth: null,
    }],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const historical = SessionStore.create(
    context.workspace,
    context.session.appHome,
    "Historischer migrierter Chat",
  );
  historical.setPreferences("synthetic/historical-chat-model", { mode: "auto" });
  await historical.save();
  const transitions: string[] = [];
  (context as CommandContext & {
    providerRoutes: {
      migratedSessionConnection(): ProviderConnectionStateV1;
      transitionModel(modelId: string): Promise<void>;
    };
  }).providerRoutes = {
    migratedSessionConnection() {
      return structuredClone(connection);
    },
    async transitionModel(modelId) {
      transitions.push(modelId);
    },
  };

  await handleSlashCommand("/chat open Historischer migrierter Chat", nullableContext);

  assert.deepEqual(transitions, ["synthetic/historical-chat-model"]);
  assert.equal(context.session.data.id, historical.data.id);
  assert.equal(nullableContext.agent, null, "a route-changing handoff must discard the old agent owner");
  assert.deepEqual(context.session.data.route, {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: connection.accountFingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/historical-chat-model",
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  });
  const persisted = await SessionStore.openById(
    context.workspace,
    historical.data.id,
    context.session.appHome,
  );
  assert.deepEqual(persisted.data.route, context.session.data.route);
  assert.equal(context.config.providerSetup.cross.enabled, false);
});

test("activation restart yields only an exact old or exact new credential-route tuple", async (t) => {
  const oldTuple = expectedTaskTenActivationTuple("old");
  const newTuple = expectedTaskTenActivationTuple("new");
  await t.test("pre-config-publish journal recovers the exact old tuple", async () => {
    const tuple = await recoverTaskTenActivationTuple("slot-readback");
    assert.deepEqual(tuple, oldTuple);
  });
  await t.test("post-config-publish journal recovers the exact new tuple", async () => {
    const tuple = await recoverTaskTenActivationTuple("config-readback");
    assert.deepEqual(tuple, newTuple);
  });
});

test("/config reports and mutations use the config path selected by startup migration", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;
  const selectedPath = context.configPath!;

  await handleSlashCommand("/config", context);
  await handleSlashCommand("/steps 7", context);

  assert.match(lines.join("\n"), new RegExp(selectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const persisted = JSON.parse(await readFile(selectedPath, "utf8")) as { maxSteps: number };
  assert.equal(persisted.maxSteps, 7);
});

test("/allow list shows nothing, then a remembered rule, then nothing after forget", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/allow list", context);
  assert.match(lines.join("\n"), /Keine gemerkten Regeln/);

  const rule = await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "run_command",
    subject: shellApprovalSubject({
      platform: "linux",
      executable: "/bin/sh",
      mode: ["-c"],
      cwd: ".",
      command: "npm test",
    }),
    decision: "allow",
  });
  lines.length = 0;
  await handleSlashCommand("/allow list", context);
  assert.match(lines.join("\n"), /allow/);
  assert.match(lines.join("\n"), /npm test/);

  lines.length = 0;
  await handleSlashCommand(`/allow forget ${rule.id}`, context);
  assert.match(lines.join("\n"), /vergessen/);
  assert.equal(context.ruleStore.list(context.workspace).length, 0);
});

test("/allow list shows why an ambiguous migrated v1 rule is disabled", async () => {
  const { context } = await harness();
  const legacyHome = await mkdtemp(join(tmpdir(), "routercode-legacy-rules-"));
  await writeFile(rulesPath(legacyHome), JSON.stringify({
    version: 1,
    rules: [{
      id: "legacy-prefix",
      workspace: context.workspace,
      tool: "run_command",
      match: { kind: "command-prefix", value: "npm test" },
      decision: "allow",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
  }), "utf8");
  context.ruleStore = await RuleStore.load(legacyHome);
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/allow list", context);

  assert.match(lines.join("\n"), /deaktiviert/);
  assert.match(lines.join("\n"), /command-prefix war nicht exakt/);
});

test("/allow forget all clears every rule for this workspace", async () => {
  const { context } = await harness();
  await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "run_command",
    subject: shellApprovalSubject({
      platform: "linux",
      executable: "/bin/sh",
      mode: ["-c"],
      cwd: ".",
      command: "npm test",
    }),
    decision: "allow",
  });
  await context.ruleStore.remember({
    workspace: context.workspace,
    tool: "write_file",
    subject: { kind: "selected-path-glob", base: "src", pattern: "**" },
    decision: "allow",
  });
  assert.equal(context.ruleStore.list(context.workspace).length, 2);

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/allow forget all", context);
  assert.match(lines.join("\n"), /2 Regel/);
  assert.equal(context.ruleStore.list(context.workspace).length, 0);
});

test("/undo --dry-run restores nothing and leaves the journal intact", async () => {
  const { context, workspace } = await harness({ approve: true });
  const target = join(workspace, "dry-run.txt");
  await handleSlashCommand("/init", context); // exercises a real write path
  const before = await readFile(join(workspace, "ORCODE.md"), "utf8");

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/undo --dry-run", context);
  assert.match(lines.join("\n"), /würden wiederhergestellt|Keine orcode-Änderung/);

  const after = await readFile(join(workspace, "ORCODE.md"), "utf8");
  assert.equal(before, after, "--dry-run darf nichts auf die Platte schreiben");
  void target;
});

test("/web sets the config mode and rejects unknown values", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/web off", context);
  assert.equal(context.config.web, "off");
  assert.match(lines.join("\n"), /off/);

  await assert.rejects(handleSlashCommand("/web maybe", context), /Ungültiger Web-Modus/);
  assert.equal(context.config.web, "off", "eine ungültige Eingabe darf den Modus nicht ändern");
});

test("/provider sort, deny/allow, only, fallback policy, and clear round-trip through config", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/provider sort price", context);
  assert.equal(context.config.provider.sort, "price");

  await handleSlashCommand("/provider allow", context);
  assert.equal(context.config.provider.dataCollection, "allow");

  await handleSlashCommand("/provider only anthropic openai", context);
  assert.deepEqual(context.config.provider.only, ["anthropic", "openai"]);

  await handleSlashCommand("/provider fallback off", context);
  assert.equal(context.config.provider.allowFallbacks, false);

  await handleSlashCommand("/provider fallback on", context);
  assert.equal(context.config.provider.allowFallbacks, true);

  await handleSlashCommand("/provider clear", context);
  assert.equal(context.config.provider.sort, undefined);
  assert.equal(context.config.provider.only, undefined);
  assert.equal(context.config.provider.allowFallbacks, undefined);
  assert.equal(
    context.config.provider.dataCollection,
    "deny",
    "clear fällt auf den sicheren Default zurück",
  );
  void lines;
});

test("provider commands and legacy key intents share runtime ports without direct command-layer provider effects", async () => {
  const { context } = await harness();
  const providerIntents: Array<Record<string, unknown>> = [];
  const credentialIntents: Array<Record<string, unknown>> = [];
  (context as CommandContext & {
    providerCommands: { execute(intent: Record<string, unknown>): Promise<Record<string, unknown>> };
    providerCredentials: { apply(intent: Record<string, unknown>): Promise<Record<string, unknown>> };
  }).providerCommands = {
    async execute(intent) {
      providerIntents.push(intent);
      return { kind: "reconnected", backendId: "openrouter", headline: "ready", generation: 4 };
    },
  };
  context.providerCredentials = {
    async apply(intent) {
      credentialIntents.push(intent as unknown as Record<string, unknown>);
      return { kind: "ready", credentialKind: "inference", persisted: true };
    },
  };

  await handleSlashCommand("/provider reconnect openrouter", context);
  await handleSlashCommand("/key save", context);

  assert.deepEqual(providerIntents, [{ kind: "reconnect", backendId: "openrouter" }]);
  assert.deepEqual(credentialIntents, [{ kind: "save", credentialKind: "inference" }]);
});

test("/fallback adds, removes, and clears the fallback chain", async () => {
  const { context } = await harness();
  const compatibleModels = ["test/compatible-one", "test/compatible-two"].map((id) => ({
    id,
    name: id,
    description: "deterministic compatible fallback fixture",
    contextLength: 32_000,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  }));
  context.openRouter.listModels = async (search = "") =>
    compatibleModels.filter((model) => model.id === search);

  await handleSlashCommand("/fallback +test/compatible-one", context);
  assert.deepEqual(context.config.fallbackModels, ["test/compatible-one"]);

  await handleSlashCommand("/fallback +test/compatible-one", context);
  assert.deepEqual(
    context.config.fallbackModels,
    ["test/compatible-one"],
    "ein doppelter Eintrag darf die Kette nicht verlängern",
  );

  await handleSlashCommand("/fallback +test/compatible-two", context);
  assert.deepEqual(context.config.fallbackModels, ["test/compatible-one", "test/compatible-two"]);

  await handleSlashCommand("/fallback -test/compatible-one", context);
  assert.deepEqual(context.config.fallbackModels, ["test/compatible-two"]);

  await handleSlashCommand("/fallback clear", context);
  assert.deepEqual(context.config.fallbackModels, []);
});

test("/verify adds a command, then on/off/rounds/clear all persist", async () => {
  const { context } = await harness();
  const { out, lines } = collectOutput();
  context.out = out;

  await handleSlashCommand("/verify npm test", context);
  assert.deepEqual(context.config.verify.commands, ["npm test"]);

  await handleSlashCommand("/verify off", context);
  assert.equal(context.config.verify.mode, "off");
  await handleSlashCommand("/verify on", context);
  assert.equal(context.config.verify.mode, "on-edit");

  await handleSlashCommand("/verify rounds 2", context);
  assert.equal(context.config.verify.maxRepairRounds, 2);
  await assert.rejects(handleSlashCommand("/verify rounds 9", context), /zwischen 0 und/);

  await handleSlashCommand("/verify clear", context);
  assert.deepEqual(context.config.verify.commands, []);
  void lines;
});

test("/budget reports the workspace spend and rejects nonsense limits", async () => {
  // Only the paths that do NOT call saveConfig are exercised here: saveConfig
  // writes to the real ~/.routercode/config.json, which a test must not touch.
  // Validation and persistence of the budget are covered by config.test.ts.
  const { context } = await harness({ approve: true });
  context.session.addCost("main", 0.25);
  await context.session.save();
  context.config.budget.dailyLimitUsd = 5;

  const { out, lines } = collectOutput();
  context.out = out;
  await handleSlashCommand("/budget", context);
  assert.match(lines.join("\n"), /Tag \$5\.00/);
  assert.match(lines.join("\n"), /heute \$0\.25/);

  await assert.rejects(
    handleSlashCommand("/budget day tausend", context),
    /Budgetgrenze/,
  );
  await assert.rejects(
    handleSlashCommand("/budget on-exceed vielleicht", context),
    /on-exceed/,
  );
});

test("model preference journal converges every crash boundary to one complete OpenRouter or Kimi tuple", async (t) => {
  for (const backendId of ["openrouter", "kimi-code"] as const) {
    for (const boundary of MODEL_PREFERENCE_FAILPOINTS) {
      await t.test(`${backendId}:${boundary}`, async () => {
        const root = await mkdtemp(join(tmpdir(), `orcode-model-pref-${backendId}-`));
        try {
          const workspace = join(root, "workspace");
          const appHome = join(root, ".orcode");
          const configPath = join(appHome, "config.json");
          await mkdir(workspace, { recursive: true });
          const accountFingerprint = backendId === "openrouter"
            ? "acct_model_pref_openrouter_owner"
            : "acct_model_pref_kimi_owner";
          const billingRealm = backendId === "openrouter"
            ? "openrouter-payg" as const
            : "kimi-code-membership-provider-managed-overage" as const;
          const oldModel = backendId === "openrouter" ? "openai/old-model" : "k3";
          const newModel = backendId === "openrouter" ? "openai/new-model" : "k3-256k";
          const oldRoute: RouteIdentityV1 = {
            version: 1,
            backendId,
            accountFingerprint,
            billingRealm,
            requestedModelId: oldModel,
            canonicalModelId: oldModel,
            resolutionState: "resolved",
          };
          const newRoute: RouteIdentityV1 = {
            ...oldRoute,
            requestedModelId: newModel,
            canonicalModelId: newModel,
          };
          const connection: ProviderConnectionStateV1 = {
            id: `${backendId}-model-preference-owner`,
            backendId,
            enabled: true,
            maturity: backendId === "openrouter" ? "stable" : "preview",
            credentialSlot: backendId === "openrouter"
              ? "v1:inference:61616161-6161-4161-8161-616161616161"
              : "v1:kimi-code:62626262-6262-4262-8262-626262626262",
            accountFingerprint,
            accountFingerprintState: "verified",
            billingRealm,
            lastHealth: null,
          };
          const beforeConfig = structuredClone(DEFAULT_CONFIG);
          beforeConfig.mainModel = oldModel;
          beforeConfig.providerSetup = {
            schemaVersion: 2,
            revision: 7,
            lifecycle: "configured",
            connections: [connection],
            defaultRoute: oldRoute,
            cross: { enabled: false, preferredLead: null, preferredChallenger: null },
          };
          await saveConfig(beforeConfig, configPath);
          const session = SessionStore.create(workspace, appHome, "Model preference transaction");
          session.setPreferences(oldModel, { mode: "auto" }, oldRoute);
          await session.save();
          const expectedConfig = await readConfigEditSnapshot(configPath);
          const expectedSession = await readSessionEditSnapshot(session.path);
          const nextConfig = structuredClone(expectedConfig.config);
          nextConfig.mainModel = newModel;
          nextConfig.providerSetup = {
            ...structuredClone(nextConfig.providerSetup),
            revision: 8,
            defaultRoute: newRoute,
          } as ProviderSetupStateV2;
          const nextSession = prepareSessionPreferenceEdit(expectedSession, {
            requestedModelId: newModel,
            reasoning: { mode: "auto" },
            route: newRoute,
          });
          const stagingConfigRaw = `${JSON.stringify({
            ...structuredClone(nextConfig),
            providerSetup: structuredClone(expectedConfig.config.providerSetup),
          }, null, 2)}\n`;
          const committedConfigRaw = providerCommittedConfigRaw(
            stagingConfigRaw,
            nextConfig.providerSetup as ProviderSetupStateV2,
          );
          let authoritative = {
            route: structuredClone(oldRoute),
            providerRevision: 7,
            connectionId: connection.id,
          };
          let liveRoute = structuredClone(oldRoute);
          const routeAuthority = {
            async assertHeld() {},
            async read() {
              return structuredClone(authoritative);
            },
            async commit(
              route: RouteIdentityV1,
              publication: ModelPreferenceAuthorityPublication,
            ) {
              const scope = integrationPreferenceMutationAuthority();
              const { configFence } = await publication.persist(
                nextConfig.providerSetup as ProviderSetupStateV2,
                scope.authority,
              );
              const staging = await loadConfigDetailed(configPath);
              const stagingConfig = staging.config;
              const stagingSession = JSON.parse(
                await readFile(session.path, "utf8"),
              ) as { model: string; route: RouteIdentityV1 };
              assert.equal(stagingConfig.mainModel, newModel);
              assert.deepEqual("defaultRoute" in stagingConfig.providerSetup
                ? stagingConfig.providerSetup.defaultRoute
                : null, oldRoute, "STAGING keeps the old provider authority");
              assert.equal(stagingSession.model, newModel);
              assert.deepEqual(stagingSession.route, newRoute);
              assert.equal(
                await readFile(configPath, "utf8"),
                stagingConfigRaw,
              );
              assert.ok(sameConfigFileSnapshot(
                await readConfigFileSnapshot(configPath),
                configFence,
              ), "fake Provider-CAS consumes the exact returned STAGING fence");
              if (configFence.kind !== "file") assert.fail("provider config fence must be a file");
              const finalConfigRaw = providerCommittedConfigRaw(
                configFence.raw,
                nextConfig.providerSetup as ProviderSetupStateV2,
              );
              assert.equal(finalConfigRaw, committedConfigRaw);
              await writeFile(configPath, finalConfigRaw, "utf8");
              assert.equal(
                await readFile(configPath, "utf8"),
                finalConfigRaw,
              );
              authoritative = {
                route: structuredClone(route),
                providerRevision: 8,
                connectionId: connection.id,
              };
              scope.beginCompletion();
              const acknowledgement = await publication.complete(scope.authority);
              assert.equal(acknowledgement.version, 1);
              scope.finishCompletion();
              const cleanupAcknowledgement = await publication.cleanup(
                scope.cleanupAuthority,
              );
              assert.equal(cleanupAcknowledgement.version, 1);
              scope.finishCleanup();
            },
          };

          await assert.rejects(
            runModelPreferenceTransaction({
              appHome,
              configPath,
              sessionPath: session.path,
              expectedConfig,
              nextConfig,
              expectedSession,
              nextSession,
              beforeRoute: oldRoute,
              afterRoute: newRoute,
              routeAuthority,
              publish(route) {
                liveRoute = structuredClone(route);
              },
              failpoint: boundary,
            }),
            ModelPreferenceCrashError,
          );

          await recoverModelPreferenceTransactions({
            appHome,
            routeAuthority,
          });
          const storedConfig = JSON.parse(await readFile(configPath, "utf8")) as OrcodeConfigWithBudget;
          const storedSession = await SessionStore.openById(workspace, session.data.id, appHome);
          const expectedRoute = authoritative.route.requestedModelId === newModel ? newRoute : oldRoute;
          assert.equal(
            await readFile(configPath, "utf8"),
            authoritative.route.requestedModelId === newModel
              ? committedConfigRaw
              : expectedConfig.file.kind === "file"
                ? expectedConfig.file.raw
                : "",
          );
          assert.equal(
            await readFile(session.path, "utf8"),
            authoritative.route.requestedModelId === newModel
              ? `${JSON.stringify(nextSession, null, 2)}\n`
              : expectedSession.file.raw,
          );
          assert.equal(storedConfig.mainModel, expectedRoute.requestedModelId);
          assert.deepEqual("defaultRoute" in storedConfig.providerSetup
            ? storedConfig.providerSetup.defaultRoute
            : null, expectedRoute);
          assert.equal(storedSession.data.model, expectedRoute.requestedModelId);
          assert.deepEqual(storedSession.data.route, expectedRoute);
          assert.deepEqual(authoritative.route, expectedRoute);
          // Recovery is disk/provider-only. Normal startup adopts the exact
          // authoritative route later and must not receive a recovery callback.
          liveRoute = structuredClone(authoritative.route);
          assert.deepEqual(liveRoute, expectedRoute);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("model preference transaction rejects stale foreign-account routes before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-model-pref-stale-account-"));
  try {
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const oldRoute: RouteIdentityV1 = {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_model_pref_exact_owner",
      billingRealm: "openrouter-payg",
      requestedModelId: "openai/old",
      canonicalModelId: "openai/old",
      resolutionState: "resolved",
    };
    const beforeConfig = structuredClone(DEFAULT_CONFIG);
    beforeConfig.mainModel = oldRoute.requestedModelId;
    await saveConfig(beforeConfig, configPath);
    const session = SessionStore.create(workspace, appHome, "Stale account");
    session.setPreferences(oldRoute.requestedModelId, { mode: "auto" }, oldRoute);
    await session.save();
    const configBytes = await readFile(configPath, "utf8");
    const sessionBytes = await readFile(session.path, "utf8");
    const expectedConfig = await readConfigEditSnapshot(configPath);
    const expectedSession = await readSessionEditSnapshot(session.path);
    const foreignRoute: RouteIdentityV1 = {
      ...oldRoute,
      accountFingerprint: "acct_model_pref_foreign",
      requestedModelId: "openai/new",
      canonicalModelId: "openai/new",
    };

    await assert.rejects(runModelPreferenceTransaction({
      appHome,
      configPath,
      sessionPath: session.path,
      expectedConfig,
      nextConfig: { ...expectedConfig.config, mainModel: foreignRoute.requestedModelId },
      expectedSession,
      nextSession: structuredClone(expectedSession.data),
      beforeRoute: oldRoute,
      afterRoute: foreignRoute,
      routeAuthority: {
        async read() {
          return {
            route: oldRoute,
            providerRevision: 0,
            connectionId: "stale-account-fixture",
          };
        },
        async commit() { throw new Error("must not commit"); },
      },
      publish() { throw new Error("must not publish"); },
    }), /route identity/i);
    assert.equal(await readFile(configPath, "utf8"), configBytes);
    assert.equal(await readFile(session.path, "utf8"), sessionBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
