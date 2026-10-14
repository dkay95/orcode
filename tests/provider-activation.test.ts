import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  loadConfigDetailed,
  readConfigEditSnapshot,
  saveConfig,
  withConfigWriteLock,
  writeFileAtomicCreateSecure,
  writeFileAtomicSecure,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ModelPreferenceRecoveryRequiredError,
  recoverModelPreferenceTransactions,
  runModelPreferenceTransaction,
  type ModelPreferenceAuthorityPublication,
} from "../src/model-preference-transaction.js";
import {
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  SessionStore,
} from "../src/session.js";
import {
  createNeverConfiguredProviderState,
  ProviderStateStore,
  requireKeychainCredentialPointer,
  type ProviderSetupStateV3,
} from "../src/provider-state.js";
import type {
  BackendAdapter,
  BackendModelDescriptor,
  CandidateProviderState,
  ProviderCandidate,
  ProviderHealth,
  RouteIdentityV1,
} from "../src/backends.js";

for (const billingMode of ["subscription", "payg"] as const) {
  test(`Nano-GPT explicit ${billingMode} activation persists only its selected realm and dedicated slot`, async () => {
    const appHome = await mkdtemp(join(tmpdir(), "orcode-nano-activation-"));
    const configPath = join(appHome, "config.json");
    const oldState = createNeverConfiguredProviderState();
    await saveConfig({ ...structuredClone(DEFAULT_CONFIG), providerSetup: oldState }, configPath);
    const credentials = new FakeCredentials(null);
    const model: BackendModelDescriptor = { ...MODEL, backendId: "nano-gpt", requestedModelId: "vendor/manual", canonicalModelId: "vendor/manual" };
    const billingRealm = billingMode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg";
    const route: RouteIdentityV1 = { version: 1, backendId: "nano-gpt", accountFingerprint: "acct_nano_fixture", billingRealm, requestedModelId: model.requestedModelId, canonicalModelId: model.canonicalModelId, resolutionState: "resolved" };
    let connects = 0;
    const adapter: BackendAdapter = {
      backendId: "nano-gpt",
      async connect(request) {
        assert.deepEqual(request.candidate, { apiKey: "fixture-nano-secret", billingMode });
        connects += 1;
        return { candidateId: `nano-${connects}`, backendId: "nano-gpt", connectionId: "nano-main", accountFingerprint: route.accountFingerprint, billingRealm, health: { credential: "valid", connectivity: "connected", spend: "unknown", runtime: "not-applicable", observedAt: 10000, generation: request.generation } };
      },
      async listModels() { return [model]; },
      async activate(request) { return { candidateId: request.candidateId, backendId: "nano-gpt", connectionId: "nano-main", accountFingerprint: route.accountFingerprint, billingRealm, route }; },
      async inspect() { throw new Error("unused"); }, async reconnect() { throw new Error("unused"); }, async logout() {}, async discardCandidate() {},
    };
    const coordinator = new ProviderActivationCoordinator({ appHome, configPath, privateStore: new PrivateStore({ root: appHome }), credentials, adapterResolver: () => adapter, stateStore: new ProviderStateStore(oldState), runtimeGuard: new FakeRuntimeGuard(), now: () => 10000, createUuid: sequentialUuid(), leaseDurationMs: 100 });
    const result = await coordinator.activate({ backendId: "nano-gpt", candidate: "fixture-nano-secret", billingMode, expectedRevision: 0, generation: 4, expectedRequestedModelId: model.requestedModelId, selectedCanonicalModelId: model.canonicalModelId, signal: new AbortController().signal, deadlineAt: Number.MAX_SAFE_INTEGER, persistence: "persisted", environmentEligibility: "forbidden", targetConnectionId: "nano-main" });
    assert.equal(result.persisted, true);
    assert.deepEqual(result.route, route);
    assert.equal(connects, 2);
    const loaded = await loadConfigDetailed(configPath);
    const state = loaded.config.providerSetup as ProviderSetupStateV3;
    assert.deepEqual(state.defaultRoute, route);
    const pointer = requireKeychainCredentialPointer(state.connections[0]!);
    assert.ok(pointer.startsWith("v1:nano-gpt:"));
    assert.equal(credentials.slots.get(pointer), "fixture-nano-secret");
  });
}
import type {
  CredentialKind,
  CredentialSlotRef,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";
import { ProviderCredentialAuthority } from "../src/provider-authority.js";
import {
  createProviderPreferenceCommitPort,
  ProviderActivationCoordinator,
  type ProviderActivationConfigCandidate,
  type ProviderActivationJournalV2,
  type ProviderPreferenceCleanupAuthority,
  type ProviderPreferenceCompletionAck,
  type ProviderPreferenceMutationAuthority,
} from "../src/provider-activation.js";

async function acknowledgePreferenceCompletion(
  _candidate: ProviderActivationConfigCandidate,
  authority: ProviderPreferenceMutationAuthority,
) {
  return authority.acknowledgeCompletion();
}

async function acknowledgePreferenceCleanup(
  authority: ProviderPreferenceCleanupAuthority,
) {
  return authority.acknowledgeCleanup();
}

const OLD_SLOT: CredentialSlotRef = Object.freeze({
  version: 1,
  kind: "inference",
  id: "v1:inference:00000000-0000-4000-8000-000000000001",
});
const NEW_SLOT_ID = "v1:inference:00000000-0000-4000-8000-000000000010";
const FOREIGN_SLOT: CredentialSlotRef = Object.freeze({
  version: 1,
  kind: "inference",
  id: "v1:inference:00000000-0000-4000-8000-000000000099",
});
const OLD_SECRET = "old-provider-secret-with-enough-bytes";
const NEW_SECRET = "new-provider-secret-with-enough-bytes";
const FOREIGN_SECRET = "foreign-provider-secret-with-enough-bytes";
const CONNECTION_ID = "connection-openrouter-main";
const TEST_OLD_STATE_SHA256 = "1".repeat(64);
const TEST_CANDIDATE_STATE_SHA256 = "2".repeat(64);
const OLD_FINGERPRINT = "acct_or_old_safe_fingerprint";
const NEW_FINGERPRINT = "acct_or_new_safe_fingerprint";
const MODEL: BackendModelDescriptor = Object.freeze({
  backendId: "openrouter",
  requestedModelId: "openai/new-requested",
  canonicalModelId: "openai/new-canonical",
  displayName: "New model",
  capabilities: {
    textInput: true,
    textOutput: true,
    tools: true,
    reasoning: true,
  },
});
const KIMI_MODEL: BackendModelDescriptor = Object.freeze({
  ...MODEL,
  backendId: "kimi-code",
  requestedModelId: "kimi-for-coding",
  canonicalModelId: "kimi-for-coding",
  displayName: "Kimi for Coding",
});
const KIMI_OLD_SLOT: CredentialSlotRef = Object.freeze({
  version: 1,
  kind: "kimi-code",
  id: "v1:kimi-code:00000000-0000-4000-8000-000000000041",
});
const KIMI_SECRET = "fixture-kimi-membership-key-not-a-real-secret";
const KIMI_CONNECTION_ID = "kimi-main";
const KIMI_FINGERPRINT = "acct_local_kimi";
const KIMI_REALM = "kimi-code-membership-provider-managed-overage" as const;
const KIMI_TEST_PERMIT = Object.freeze({ version: 1 as const });

const boundaries = [
  "candidate-validated",
  "journal-written",
  "slot-written",
  "slot-readback",
  "candidate-revalidated",
  "models-loaded",
  "model-selected",
  "config-written",
  "config-readback",
  "runtime-activated",
  "old-slot-cleaned",
] as const;

type Boundary = (typeof boundaries)[number];

interface RuntimeLease {
  assertHeld(): void;
  release(): Promise<void>;
}

class FakeRuntimeGuard {
  activeRuns = 0;
  held = false;
  acquisitions = 0;
  releaseCalls = 0;
  failRelease = false;

  async acquire(): Promise<RuntimeLease> {
    if (this.activeRuns > 0) {
      throw new Error("fixed-runtime-not-idle");
    }
    while (this.held) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.activeRuns > 0) throw new Error("fixed-runtime-not-idle");
    }
    this.held = true;
    this.acquisitions += 1;
    let released = false;
    return {
      assertHeld: () => {
        if (released || !this.held || this.activeRuns > 0) {
          throw new Error("fixed-runtime-guard-lost");
        }
      },
      release: async () => {
        this.releaseCalls += 1;
        if (this.failRelease) throw new Error("raw-runtime-release-secret-marker");
        if (!released) {
          released = true;
          this.held = false;
        }
      },
    };
  }

  tryStartRun(): boolean {
    if (this.held) return false;
    this.activeRuns += 1;
    return true;
  }

  drain(): void {
    this.activeRuns = 0;
  }

  lose(): void {
    this.held = false;
  }
}

class FakeCredentials implements VersionedCredentialStoreLike {
  readonly location = "exact-fake-keyring";
  readonly slots = new Map<string, string>();
  readonly legacy = new Map<CredentialKind, string>();
  readonly calls: string[] = [];
  readonly deleted: string[] = [];
  readonly reservations = new WeakSet<object>();
  reservationCounter = 0;
  failWrite: "before" | "after" | null = null;
  writePause: Promise<void> | null = null;
  writeReached: (() => void) | null = null;
  failDelete = false;

  constructor(oldSlot: CredentialSlotRef | "legacy:inference" | null = OLD_SLOT) {
    if (oldSlot === "legacy:inference") this.legacy.set("inference", OLD_SECRET);
    else if (oldSlot) this.slots.set(oldSlot.id, OLD_SECRET);
    this.slots.set(FOREIGN_SLOT.id, FOREIGN_SECRET);
  }

  reserveSlot(kind: CredentialKind): CredentialSlotRef {
    this.calls.push("reserveSlot");
    this.reservationCounter += 1;
    const suffix = String(9 + this.reservationCounter).padStart(12, "0");
    const slot = Object.freeze({
      version: 1 as const,
      kind,
      id: `v1:${kind}:00000000-0000-4000-8000-${suffix}`,
    });
    this.reservations.add(slot);
    return slot;
  }

  async writeSlot(slot: CredentialSlotRef, secret: string): Promise<void> {
    this.calls.push(`writeSlot:${slot.id}`);
    assert.equal(this.reservations.has(slot), true, "writeSlot must receive the exact frozen reservation");
    if (this.failWrite === "before") throw new Error("raw-keyring-write-before-secret-marker");
    this.writeReached?.();
    if (this.writePause) await this.writePause;
    this.slots.set(slot.id, secret);
    if (this.failWrite === "after") throw new Error("raw-keyring-write-after-secret-marker");
  }

  async readSlot(slot: CredentialSlotRef): Promise<string | null> {
    this.calls.push(`readSlot:${slot.id}`);
    return this.slots.get(slot.id) ?? null;
  }

  async deleteSlot(slot: CredentialSlotRef): Promise<boolean> {
    this.calls.push(`deleteSlot:${slot.id}`);
    if (this.failDelete) throw new Error("raw-keyring-delete-secret-marker");
    const deleted = this.slots.delete(slot.id);
    if (deleted) this.deleted.push(slot.id);
    return deleted;
  }

  async get(kind: CredentialKind): Promise<string | null> {
    this.calls.push(`get:${kind}`);
    return this.legacy.get(kind) ?? null;
  }

  async set(kind: CredentialKind, secret: string): Promise<void> {
    this.calls.push(`set:${kind}`);
    this.legacy.set(kind, secret);
  }

  async delete(kind: CredentialKind): Promise<boolean> {
    this.calls.push(`delete:${kind}`);
    return this.legacy.delete(kind);
  }

  async has(kind: CredentialKind): Promise<boolean> {
    return this.legacy.has(kind);
  }

  async getOrCreateAccountHmacKey(): Promise<Uint8Array> {
    this.calls.push("getOrCreateAccountHmacKey");
    return new Uint8Array(32).fill(7);
  }
}

class FakeAdapter {
  readonly backendId = "openrouter" as const;
  readonly calls: string[] = [];
  readonly candidates = new Map<string, string>();
  candidateCounter = 0;
  runtimeSecret = OLD_SECRET;
  runtimeRoute: RouteIdentityV1 | null = oldRoute();
  activateFailure: "before" | "after" | null = null;
  connectFailure: Error | null = null;
  connectReached: (() => void) | null = null;
  connectPause: Promise<void> | null = null;
  listModelsReached: (() => void) | null = null;
  listModelsPause: Promise<void> | null = null;
  activateReached: (() => void) | null = null;
  activatePause: Promise<void> | null = null;

  async connect(request: {
    candidate: unknown;
    generation: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    assert.equal(request.signal.aborted, false);
    assert.equal(typeof request.candidate, "string");
    this.calls.push("connect");
    this.connectReached?.();
    if (this.connectPause) await this.connectPause;
    if (this.connectFailure) throw this.connectFailure;
    const secret = request.candidate as string;
    const candidateId = `candidate-${++this.candidateCounter}`;
    this.candidates.set(candidateId, secret);
    return {
      candidateId,
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      accountFingerprint: secret === NEW_SECRET ? NEW_FINGERPRINT : OLD_FINGERPRINT,
      billingRealm: "openrouter-payg",
      health: healthy(request.generation),
    };
  }

  async listModels(request: {
    candidateId?: string;
    signal: AbortSignal;
  }): Promise<readonly BackendModelDescriptor[]> {
    assert.equal(request.signal.aborted, false);
    assert.equal(this.candidates.has(request.candidateId ?? ""), true);
    this.calls.push("listModels");
    this.listModelsReached?.();
    if (this.listModelsPause) await this.listModelsPause;
    return [MODEL];
  }

  async activate(request: {
    candidateId: string;
    model: BackendModelDescriptor;
    signal: AbortSignal;
  }): Promise<CandidateProviderState> {
    assert.equal(request.signal.aborted, false);
    this.calls.push("activate");
    if (this.activateFailure === "before") {
      throw new Error("raw-provider-bind-before-secret-marker");
    }
    const secret = this.candidates.get(request.candidateId);
    assert.ok(secret);
    const route = newRoute();
    this.runtimeSecret = secret;
    this.runtimeRoute = route;
    this.activateReached?.();
    if (this.activatePause) await this.activatePause;
    if (this.activateFailure === "after") {
      throw new Error("raw-provider-bind-after-secret-marker");
    }
    return {
      candidateId: request.candidateId,
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      accountFingerprint: NEW_FINGERPRINT,
      billingRealm: "openrouter-payg",
      route,
    };
  }

  async discardCandidate(candidateId: string): Promise<void> {
    this.calls.push("discardCandidate");
    this.candidates.delete(candidateId);
  }
}

class FakeKimiAdapter {
  readonly backendId = "kimi-code" as const;
  readonly candidates = new Map<string, string>();
  readonly calls: string[] = [];
  readonly deadlines: number[] = [];
  candidateCounter = 0;
  currentGeneration = 4;
  advanceGenerationAfterList = false;

  async connect(request: {
    candidate: unknown;
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    this.calls.push("connect");
    this.deadlines.push(request.deadlineAt);
    const candidateId = `kimi-candidate-${++this.candidateCounter}`;
    this.candidates.set(candidateId, request.candidate as string);
    return {
      candidateId,
      backendId: "kimi-code",
      connectionId: KIMI_CONNECTION_ID,
      accountFingerprint: KIMI_FINGERPRINT,
      billingRealm: KIMI_REALM,
      health: healthy(this.currentGeneration),
    };
  }

  async listModels(request: { candidateId?: string; signal: AbortSignal }): Promise<readonly BackendModelDescriptor[]> {
    assert.equal(this.candidates.has(request.candidateId ?? ""), true);
    this.calls.push("listModels");
    if (this.advanceGenerationAfterList) this.currentGeneration += 1;
    return [KIMI_MODEL];
  }

  async activate(request: { candidateId: string; model: BackendModelDescriptor; signal: AbortSignal }): Promise<CandidateProviderState> {
    assert.equal(this.candidates.has(request.candidateId), true);
    assert.equal(request.model.backendId, "kimi-code");
    this.calls.push("activate");
    return {
      candidateId: request.candidateId,
      backendId: "kimi-code",
      connectionId: KIMI_CONNECTION_ID,
      accountFingerprint: KIMI_FINGERPRINT,
      billingRealm: KIMI_REALM,
      route: kimiActivationRoute(),
    };
  }

  async discardCandidate(candidateId: string): Promise<void> {
    this.calls.push("discardCandidate");
    this.candidates.delete(candidateId);
  }
}

test("real activation coordinator retains OpenRouter and Kimi in either activation order", async (t) => {
  for (const order of [
    ["openrouter", "kimi-code"],
    ["kimi-code", "openrouter"],
  ] as const) {
    await t.test(order.join(" -> "), async (t) => {
      const appHome = await mkdtemp(join(tmpdir(), "orcode-two-provider-activation-"));
      t.after(() => rm(appHome, { recursive: true, force: true }));
      const configPath = join(appHome, "config.json");
      const initial = createNeverConfiguredProviderState();
      await saveConfig({
        ...structuredClone(DEFAULT_CONFIG),
        providerSetup: initial,
      }, configPath);
      const stateStore = new ProviderStateStore(initial);
      const credentials = new FakeCredentials(null);
      const openRouter = new FakeAdapter();
      const kimi = new FakeKimiAdapter();
      const runtimeGuard = new FakeRuntimeGuard();
      let uuid = 0;
      const coordinator = new ProviderActivationCoordinator({
        appHome,
        configPath,
        privateStore: new PrivateStore({ root: appHome }),
        credentials,
        adapterResolver: (backendId) => backendId === "kimi-code" ? kimi : openRouter,
        stateStore,
        runtimeGuard,
        candidateAuthority: {
          async validateCandidatePermitUnderLease() { return { kind: "ready" as const }; },
          async validateCandidatePermitAgainstSnapshotUnderLease() { return { kind: "ready" as const }; },
        },
        now: () => 10_000,
        createUuid: () => `20000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
        leaseDurationMs: 10_000,
      });

      for (const backendId of order) {
        const before = stateStore.read();
        const request = backendId === "kimi-code"
          ? {
              backendId,
              expectedRevision: before.revision,
              candidate: KIMI_SECRET,
              expectedRequestedModelId: KIMI_MODEL.requestedModelId,
              selectedCanonicalModelId: KIMI_MODEL.canonicalModelId,
              generation: 4,
              signal: new AbortController().signal,
              deadlineAt: 20_000,
              persistence: "persisted" as const,
              environmentEligibility: "forbidden" as const,
              targetConnectionId: KIMI_CONNECTION_ID,
              candidatePermit: KIMI_TEST_PERMIT,
              requireCandidatePermit: true as const,
              candidateAuthorityPurpose: "initial-setup" as const,
            }
          : {
              backendId,
              expectedRevision: before.revision,
              candidate: NEW_SECRET,
              expectedRequestedModelId: MODEL.requestedModelId,
              selectedCanonicalModelId: MODEL.canonicalModelId,
              generation: 4,
              signal: new AbortController().signal,
              deadlineAt: 20_000,
              persistence: "persisted" as const,
              environmentEligibility: "forbidden" as const,
              targetConnectionId: CONNECTION_ID,
            };
        const result = await coordinator.activate(request);
        const after = stateStore.read();

        assert.equal(result.persisted, true);
        assert.equal(result.route.backendId, backendId);
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.connections.length, before.connections.length + 1);
        assert.deepEqual(after.defaultRoute, result.route);
        assert.equal(after.cross.enabled, false);
        for (const retained of before.connections) {
          assert.deepEqual(
            after.connections.find((connection) => connection.id === retained.id),
            retained,
          );
        }
      }

      const final = stateStore.read();
      assert.deepEqual(final.connections.map((connection) => connection.backendId), order);
      assert.equal(final.defaultRoute?.backendId, order[1]);
      assert.equal(final.connections.find((connection) => connection.backendId === "openrouter")
        ?.credentialBinding.kind, "orcode-keychain");
      assert.equal(requireKeychainCredentialPointer(
        final.connections.find((connection) => connection.backendId === "openrouter")!,
      ).startsWith("v1:inference:"), true);
      assert.equal(final.connections.find((connection) => connection.backendId === "kimi-code")
        ?.credentialBinding.kind, "orcode-keychain");
      assert.equal(requireKeychainCredentialPointer(
        final.connections.find((connection) => connection.backendId === "kimi-code")!,
      ).startsWith("v1:kimi-code:"), true);
      assert.deepEqual(await journalDirectories(appHome), []);
      const loaded = await loadConfigDetailed(configPath);
      assert.deepEqual(loaded.config.providerSetup, final);
    });
  }
});

interface ActivationFixtureOptions {
  crashAfter?: Boundary;
  oldSlot?: CredentialSlotRef | "legacy:inference" | null;
  saveMode?: "normal" | "throw-before" | "throw-after" | "throw-branded-after" | "write-corrupt";
  now?: number;
}

async function activationFixture(options: ActivationFixtureOptions = {}) {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-provider-activation-"));
  const path = join(appHome, "config.json");
  const oldSlot = options.oldSlot === undefined ? OLD_SLOT : options.oldSlot;
  const oldState = providerState(oldSlot);
  const initialConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    mainModel: "preserve/exact-unrelated-main",
    compressorModel: "preserve/exact-unrelated-compressor",
    fallbackModels: ["preserve/fallback-a", "preserve/fallback-b"],
    providerSetup: oldState,
  } satisfies OrcodeConfigWithBudget;
  await saveConfig(initialConfig, path);
  const credentials = new FakeCredentials(oldSlot);
  const adapter = new FakeAdapter();
  const runtimeGuard = new FakeRuntimeGuard();
  const stateStore = new ProviderStateStore(oldState);
  const privateStore = new PrivateStore({ root: appHome });
  let now = options.now ?? 10_000;
  const calls: string[] = [];
  const uuidQueue = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000005",
    "10000000-0000-4000-8000-000000000006",
  ];
  const activationModule = ["../src", "provider-activation.js"].join("/");
  const api = await import(activationModule);
  const writeConfigAtomic = async (configPath: string, content: string) => {
    calls.push("saveConfig");
    if (options.saveMode === "throw-before") throw new Error("raw-config-before-secret-marker");
    if (options.saveMode === "write-corrupt") {
      await writeFile(configPath, "{corrupt-after-save", "utf8");
      return;
    }
    await writeFileAtomicSecure(
      configPath,
      content,
      undefined,
      undefined,
      options.saveMode === "throw-branded-after"
        ? () => { throw new Error("raw-config-branded-after-secret-marker"); }
        : undefined,
    );
    if (options.saveMode === "throw-after") throw new Error("raw-config-after-secret-marker");
  };
  const makeCoordinator = (overrides: Record<string, unknown> = {}) =>
    new api.ProviderActivationCoordinator({
      appHome,
      configPath: path,
      privateStore,
      credentials,
      adapterResolver: () => adapter,
      stateStore,
      runtimeGuard,
      now: () => now,
      createUuid: () => uuidQueue.shift() ?? "10000000-0000-4000-8000-000000000099",
      leaseDurationMs: 100,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      writeConfigAtomic,
      onBoundary: options.crashAfter
        ? async (boundary: Boundary) => {
          calls.push(`boundary:${boundary}`);
          if (boundary === options.crashAfter) throw new Error(`simulated-crash:${boundary}`);
        }
        : async (boundary: Boundary) => {
          calls.push(`boundary:${boundary}`);
        },
      ...overrides,
    });
  let coordinator = makeCoordinator();
  const request = {
    backendId: "openrouter" as const,
    expectedRevision: oldState.revision,
    candidate: NEW_SECRET,
    expectedRequestedModelId: MODEL.requestedModelId,
    selectedCanonicalModelId: MODEL.canonicalModelId,
    generation: 4,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted" as const,
  };
  return {
    api,
    appHome,
    path,
    credentials,
    adapter,
    runtimeGuard,
    stateStore,
    privateStore,
    calls,
    oldState,
    initialConfig,
    request,
    activate: () => coordinator.activate(request),
    setNow: (value: number) => { now = value; },
    restart: () => {
      now += 1_000;
      coordinator = makeCoordinator({
        runtimeGuard: new FakeRuntimeGuard(),
        onBoundary: async () => undefined,
      });
    },
    restartAndRecover: async (inspectCommitted = true) => {
      now += 1_000;
      const restartedGuard = new FakeRuntimeGuard();
      coordinator = makeCoordinator({
        runtimeGuard: restartedGuard,
        onBoundary: async () => undefined,
      });
      await coordinator.recover({
        signal: new AbortController().signal,
        inspectCommitted,
      });
      return readTuple(path, credentials);
    },
    recover: (inspectCommitted = false) => coordinator.recover({
      signal: new AbortController().signal,
      inspectCommitted,
    }),
    coordinator: () => coordinator,
    coordinatorWith: (overrides: Record<string, unknown>) => makeCoordinator(overrides),
  };
}

test("authority-internal preference hook persists before Provider-CAS and its config prefix survives", async () => {
  const fixture = await activationFixture();
  let calls = 0;
  const result = await fixture.coordinator().activate({
    ...fixture.request,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async ({
        route,
        state,
      }: ProviderActivationConfigCandidate, authority) => {
        authority.assertMutationAllowed();
        calls += 1;
        const before = await loadConfigDetailed(fixture.path);
        assert.deepEqual(before.config.providerSetup, fixture.oldState);
        assert.deepEqual(route, state.defaultRoute);
        assert.equal(state.revision, fixture.oldState.revision + 1);
        before.config.mainModel = "openai/preference-hook-survives";
        await saveConfig(before.config, fixture.path);
        authority.assertMutationAllowed();
        return authority.acknowledgePersistence(
          (await readConfigEditSnapshot(fixture.path)).file,
        );
      },
      abortAndReconcile: async () => ({ kind: "old" }),
      complete: acknowledgePreferenceCompletion,
      cleanup: acknowledgePreferenceCleanup,
    }),
  });

  const stored = await loadConfigDetailed(fixture.path);
  assert.equal(calls, 1);
  assert.equal(stored.config.mainModel, "openai/preference-hook-survives");
  assert.deepEqual(stored.config.providerSetup, result.state);
  assert.deepEqual("defaultRoute" in stored.config.providerSetup
    ? stored.config.providerSetup.defaultRoute
    : null, result.route);
});

test("preference completion runs exactly once under retained provider and runtime authority", async (t) => {
  for (const backendId of ["openrouter", "kimi-code"] as const) {
    await t.test(backendId, async () => {
      const fixture = backendId === "openrouter"
        ? await activationFixture()
        : await kimiActivationFixture();
      const oldSlot = backendId === "openrouter" ? OLD_SLOT : KIMI_OLD_SLOT;
      let completionCalls = 0;
      const result = await fixture.coordinator().activate({
        ...fixture.request,
        persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
          persist: async (_candidate, authority) => {
            authority.assertMutationAllowed();
            return authority.acknowledgePersistence(
              (await readConfigEditSnapshot(fixture.path)).file,
            );
          },
          abortAndReconcile: async () => ({ kind: "old" }),
          complete: async (candidate, authority) => {
            authority.assertCompletionAllowed();
            completionCalls += 1;
            assert.equal(fixture.runtimeGuard.held, true);
            assert.equal(fixture.runtimeGuard.tryStartRun(), false);
            assert.deepEqual(fixture.stateStore.read(), candidate.state);
            assert.deepEqual(candidate.route, candidate.state.defaultRoute);
            assert.equal(fixture.credentials.slots.has(oldSlot.id), true);
            assert.equal((await journalDirectories(fixture.appHome)).length, 1);
            assert.equal(fixture.adapter.calls.includes("activate"), true);
            return authority.acknowledgeCompletion();
          },
          cleanup: acknowledgePreferenceCleanup,
        }),
      });

      assert.equal(completionCalls, 1);
      assert.deepEqual(result.state, fixture.stateStore.read());
      assert.equal(fixture.runtimeGuard.held, false);
      assert.equal(fixture.credentials.slots.has(oldSlot.id), false);
      assert.deepEqual(await journalDirectories(fixture.appHome), []);
    });
  }
});

test("missing or forged completion acknowledgement retains the committed recovery journal", async (t) => {
  for (const [name, complete] of [
    ["missing", async () => undefined as never],
    ["forged", async () => Object.freeze({ version: 1 as const })],
  ] as const) {
    await t.test(name, async () => {
      const fixture = await activationFixture();
      let reconcileCalls = 0;
      await assert.rejects(
        fixture.coordinator().activate({
          ...fixture.request,
          persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
            persist: async (_candidate, authority) => authority.acknowledgePersistence(
              (await readConfigEditSnapshot(fixture.path)).file,
            ),
            abortAndReconcile: async () => {
              reconcileCalls += 1;
              return { kind: "old" };
            },
            complete,
            cleanup: acknowledgePreferenceCleanup,
          }),
        }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "provider-preference-completion-required",
      );

      assert.equal(reconcileCalls, 0, "provider durability makes OLD reconciliation too late");
      assert.deepEqual(fixture.stateStore.read().defaultRoute, newRoute());
      assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), true);
      assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), true);
      assert.equal((await journalDirectories(fixture.appHome)).length, 1);
    });
  }
});

test("missing or forged cleanup acknowledgement retains the committed provider journal", async (t) => {
  for (const [name, cleanup] of [
    ["missing", async () => undefined as never],
    ["forged", async () => Object.freeze({ version: 1 as const })],
  ] as const) {
    await t.test(name, async () => {
      const fixture = await activationFixture();
      let cleanupCalls = 0;
      await assert.rejects(
        fixture.coordinator().activate({
          ...fixture.request,
          persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
            persist: async (_candidate, authority) => authority.acknowledgePersistence(
              (await readConfigEditSnapshot(fixture.path)).file,
            ),
            abortAndReconcile: async () => {
              throw new Error("FINAL must never reconcile to OLD during cleanup");
            },
            complete: acknowledgePreferenceCompletion,
            cleanup: async (authority) => {
              authority.assertCleanupAllowed();
              cleanupCalls += 1;
              return cleanup();
            },
          }),
        }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "provider-preference-completion-required",
      );

      assert.equal(cleanupCalls, 1);
      assert.deepEqual(fixture.stateStore.read().defaultRoute, newRoute());
      assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), true);
      assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), true);
      assert.equal((await journalDirectories(fixture.appHome)).length, 1);
    });
  }
});

test("cleanup cannot acknowledge after the exact provider lease expires", async () => {
  const fixture = await activationFixture({ now: 10_000 });
  let passedAfterExpiry = false;
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => authority.acknowledgePersistence(
          (await readConfigEditSnapshot(fixture.path)).file,
        ),
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: acknowledgePreferenceCompletion,
        cleanup: async (authority) => {
          fixture.setNow(10_101);
          authority.assertCleanupAllowed();
          passedAfterExpiry = true;
          return authority.acknowledgeCleanup();
        },
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-completion-required",
  );
  assert.equal(passedAfterExpiry, false);
  assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), true);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), true);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("a completion acknowledgement cannot be replayed by another authority", async () => {
  const first = await activationFixture();
  let acknowledgement: ProviderPreferenceCompletionAck | null = null;
  await first.coordinator().activate({
    ...first.request,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async (_candidate, authority) => authority.acknowledgePersistence(
        (await readConfigEditSnapshot(first.path)).file,
      ),
      abortAndReconcile: async () => ({ kind: "old" }),
      complete: async (_candidate, authority) => {
        acknowledgement = await authority.acknowledgeCompletion();
        return acknowledgement;
      },
      cleanup: acknowledgePreferenceCleanup,
    }),
  });
  assert.ok(acknowledgement);

  const second = await activationFixture();
  await assert.rejects(
    second.coordinator().activate({
      ...second.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => authority.acknowledgePersistence(
          (await readConfigEditSnapshot(second.path)).file,
        ),
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: async () => acknowledgement!,
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-completion-required",
  );
  assert.equal((await journalDirectories(second.appHome)).length, 1);
  assert.equal(second.credentials.slots.has(OLD_SLOT.id), true);
});

test("caller abort after provider durability cannot revoke a late exact completion", async () => {
  const fixture = await activationFixture();
  const controller = new AbortController();
  const reason = new DOMException("fixed late caller abort", "AbortError");
  let reached!: () => void;
  let resume!: () => void;
  const completionReached = new Promise<void>((resolve) => { reached = resolve; });
  const completionResume = new Promise<void>((resolve) => { resume = resolve; });
  let completionCalls = 0;
  const activation = fixture.coordinator().activate({
    ...fixture.request,
    signal: controller.signal,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async (_candidate, authority) => authority.acknowledgePersistence(
        (await readConfigEditSnapshot(fixture.path)).file,
      ),
      abortAndReconcile: async () => {
        throw new Error("OLD reconciliation must not run after provider durability");
      },
      complete: async (_candidate, authority) => {
        completionCalls += 1;
        reached();
        await completionResume;
        authority.assertCompletionAllowed();
        return authority.acknowledgeCompletion();
      },
      cleanup: acknowledgePreferenceCleanup,
    }),
  });
  await completionReached;
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.runtimeGuard.held, true);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
  resume();

  const result = await activation;
  assert.equal(result.persisted, true);
  assert.equal(completionCalls, 1);
  assert.equal(fixture.runtimeGuard.held, false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("completion cannot acknowledge after the exact provider lease expires", async () => {
  const fixture = await activationFixture({ now: 10_000 });
  let passedAfterExpiry = false;
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => authority.acknowledgePersistence(
          (await readConfigEditSnapshot(fixture.path)).file,
        ),
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: async (_candidate, authority) => {
          fixture.setNow(10_101);
          authority.assertCompletionAllowed();
          passedAfterExpiry = true;
          return authority.acknowledgeCompletion();
        },
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-completion-required",
  );
  assert.equal(passedAfterExpiry, false);
  assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), true);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), true);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("completion acknowledgement rechecks the exact cross-process provider claim", async () => {
  const fixture = await activationFixture();
  const originalReadOwner = fixture.privateStore.readClaimOwner.bind(
    fixture.privateStore,
  );
  let exposeForeignOwner = false;
  fixture.privateStore.readClaimOwner = async (...args) => {
    const raw = await originalReadOwner(...args);
    if (!exposeForeignOwner) return raw;
    const parsed = JSON.parse(raw) as { ownerId: string };
    return `${JSON.stringify({
      ...parsed,
      ownerId: "91919191-9191-4191-8191-919191919191",
    })}\n`;
  };

  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => authority.acknowledgePersistence(
          (await readConfigEditSnapshot(fixture.path)).file,
        ),
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: async (_candidate, authority) => {
          authority.assertCompletionAllowed();
          exposeForeignOwner = true;
          return authority.acknowledgeCompletion();
        },
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-completion-required",
  );
  assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), true);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), true);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("preference capabilities close synchronously at persistence and completion acknowledgement", async () => {
  const fixture = await activationFixture();
  let mutationPassedAfterPersist = false;
  let completionPassedAfterAck = false;
  let cleanupPassedAfterAck = false;
  let persistMicrotask!: Promise<void>;
  let completionMicrotask!: Promise<void>;
  let cleanupMicrotask!: Promise<void>;
  await fixture.coordinator().activate({
    ...fixture.request,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async (_candidate, authority) => {
        const result = await authority.acknowledgePersistence(
          (await readConfigEditSnapshot(fixture.path)).file,
        );
        persistMicrotask = new Promise<void>((resolve) => queueMicrotask(() => {
          try {
            authority.assertMutationAllowed();
            mutationPassedAfterPersist = true;
          } catch {
            // Expected: the persist acknowledgement closed this capability.
          }
          resolve();
        }));
        return result;
      },
      abortAndReconcile: async () => ({ kind: "old" }),
      complete: async (_candidate, authority) => {
        const acknowledgement = await authority.acknowledgeCompletion();
        completionMicrotask = new Promise<void>((resolve) => queueMicrotask(() => {
          try {
            authority.assertCompletionAllowed();
            completionPassedAfterAck = true;
          } catch {
            // Expected: acknowledgement is the final authorized operation.
          }
          resolve();
        }));
        return acknowledgement;
      },
      cleanup: async (authority) => {
        const acknowledgement = await authority.acknowledgeCleanup();
        cleanupMicrotask = new Promise<void>((resolve) => queueMicrotask(() => {
          try {
            authority.assertCleanupAllowed();
            cleanupPassedAfterAck = true;
          } catch {
            // Expected: cleanup acknowledgement closes its separate capability.
          }
          resolve();
        }));
        return acknowledgement;
      },
    }),
  });
  await persistMicrotask;
  await completionMicrotask;
  await cleanupMicrotask;
  assert.equal(mutationPassedAfterPersist, false);
  assert.equal(completionPassedAfterAck, false);
  assert.equal(cleanupPassedAfterAck, false);
});

test("startup recovery idempotently completes FINAL when provider and preference journals coexist", async (t) => {
  const fixture = await kimiActivationFixture({ oldModelId: "k3-256k" });
  t.after(() => rm(fixture.appHome, { recursive: true, force: true }));
  const oldRoute = kimiActivationRoute("k3-256k");
  const finalRoute = kimiActivationRoute("kimi-for-coding");
  const workspace = join(fixture.appHome, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = SessionStore.create(workspace, fixture.appHome, "Both journals");
  session.setPreferences(oldRoute.requestedModelId, { mode: "auto" }, oldRoute);
  await session.save();
  const expectedConfig = await readConfigEditSnapshot(fixture.path);
  const expectedSession = await readSessionEditSnapshot(session.path);
  const nextSession = prepareSessionPreferenceEdit(expectedSession, {
    requestedModelId: finalRoute.requestedModelId,
    reasoning: { mode: "auto" },
    route: finalRoute,
  });
  let livePublications = 0;
  const readAuthority = async () => {
    const state = fixture.stateStore.read();
    const route = state.defaultRoute;
    const connection = route
      ? state.connections.find((candidate) =>
          candidate.backendId === route.backendId
          && candidate.accountFingerprint === route.accountFingerprint
          && candidate.billingRealm === route.billingRealm)
      : null;
    return {
      route: route ? structuredClone(route) : null,
      providerRevision: state.revision,
      connectionId: connection?.id ?? null,
    };
  };

  await assert.rejects(runModelPreferenceTransaction({
    appHome: fixture.appHome,
    configPath: fixture.path,
    sessionPath: session.path,
    expectedConfig,
    nextConfig: (nextProviderState) => ({
      ...structuredClone(expectedConfig.config),
      mainModel: finalRoute.requestedModelId,
      providerSetup: structuredClone(nextProviderState),
    }),
    expectedSession,
    nextSession,
    beforeRoute: oldRoute,
    afterRoute: finalRoute,
    routeAuthority: {
      read: readAuthority,
      async commit(route, publication: ModelPreferenceAuthorityPublication) {
        const result = await fixture.coordinator().activate({
          ...fixture.request,
          persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
            persist: async ({ state }, authority) => {
              const staged = await publication.persist(state, authority);
              return authority.acknowledgePersistence(staged.configFence);
            },
            abortAndReconcile: (authority) => publication.abortAndReconcile(authority),
            complete: (_candidate, authority) => publication.complete(authority),
            cleanup: (authority) => publication.cleanup(authority),
          }),
        });
        assert.deepEqual(result.route, route);
      },
    },
    publish(route) {
      assert.deepEqual(route, finalRoute);
      livePublications += 1;
    },
    failpoint: "before-journal-remove",
  }), ModelPreferenceRecoveryRequiredError);

  const preferenceRoot = join(
    fixture.appHome,
    "transactions",
    "model-preference",
  );
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
  assert.equal((await readdir(preferenceRoot)).length, 1);
  assert.equal(livePublications, 1);
  assert.deepEqual((await readAuthority()).route, finalRoute);

  const restarted = fixture.coordinatorWith({
    runtimeGuard: new FakeRuntimeGuard(),
    onBoundary: async () => undefined,
  });
  const recovered = await restarted.recoverAndRun(
    {
      signal: new AbortController().signal,
      inspectCommitted: true,
      allowedBackendIds: ["kimi-code"],
    },
    async (lease) => recoverModelPreferenceTransactions({
      appHome: fixture.appHome,
      routeAuthority: {
        assertHeld: () => lease.assertHeld(),
        read: readAuthority,
      },
      allowedBackendIds: ["kimi-code"],
    }),
  );

  assert.equal(recovered.value.length, 1);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
  assert.deepEqual(await readdir(preferenceRoot).catch(() => [] as string[]), []);
  assert.equal(livePublications, 1, "startup recovery must never republish live state");
  const storedConfig = await loadConfigDetailed(fixture.path);
  const storedSession = await readSessionEditSnapshot(session.path);
  assert.equal(storedConfig.config.mainModel, finalRoute.requestedModelId);
  assert.deepEqual("defaultRoute" in storedConfig.config.providerSetup
    ? storedConfig.config.providerSetup.defaultRoute
    : null, finalRoute);
  assert.equal(storedSession.data.model, finalRoute.requestedModelId);
  assert.deepEqual(storedSession.data.route, finalRoute);
  assert.deepEqual((await readAuthority()).route, finalRoute);
});

test("abort before preference persist returns exact OLD without invoking the publication reconciler", async () => {
  const fixture = await activationFixture();
  const controller = new AbortController();
  const reason = new DOMException("fixed abort before preference persist", "AbortError");
  const originalWriteManifest = fixture.privateStore.writeClaimManifest.bind(
    fixture.privateStore,
  );
  fixture.privateStore.writeClaimManifest = async (...args) => {
    await originalWriteManifest(...args);
    try {
      const manifest = JSON.parse(args[1]) as { phase?: string };
      if (manifest.phase === "credential-staged") controller.abort(reason);
    } catch {
      // Non-provider manifests are irrelevant to this exact boundary fixture.
    }
  };
  let persistCalls = 0;
  let reconcileCalls = 0;
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      signal: controller.signal,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => {
          persistCalls += 1;
          return authority.acknowledgePersistence(
            (await readConfigEditSnapshot(fixture.path)).file,
          );
        },
        abortAndReconcile: async () => {
          reconcileCalls += 1;
          return { kind: "old" };
        },
        complete: acknowledgePreferenceCompletion,
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(persistCalls, 0);
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("pre-Provider-CAS hook failure cleans the staged credential and journal before retry", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => {
          throw new Error("fixed-preference-persist-failure");
        },
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: acknowledgePreferenceCompletion,
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    /fixed-preference-persist-failure/,
  );

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);

  const retried = await fixture.coordinator().activate(fixture.request);
  assert.equal(retried.persisted, true);
});

test("returned preference config fence rejects a later edit without overwriting its bytes", async () => {
  const fixture = await activationFixture();
  let foreignBytes = "";
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => {
          const staged = await loadConfigDetailed(fixture.path);
          staged.config.mainModel = "openai/staged-preference";
          await saveConfig(staged.config, fixture.path);
          const configFence = (await readConfigEditSnapshot(fixture.path)).file;

          const foreign = await loadConfigDetailed(fixture.path);
          foreign.config.maxSteps = 77;
          await saveConfig(foreign.config, fixture.path);
          foreignBytes = await readFile(fixture.path, "utf8");
          return authority.acknowledgePersistence(configFence);
        },
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: acknowledgePreferenceCompletion,
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-config-stale",
  );

  assert.notEqual(foreignBytes, "");
  assert.equal(await readFile(fixture.path, "utf8"), foreignBytes);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("final preference fence rejects a same-inode edit immediately before Provider-CAS", async () => {
  const fixture = await activationFixture();
  let foreignBytes = "";
  let sameInode = false;
  const coordinator = fixture.coordinatorWith({
    writeConfigAtomic: async (
      path: string,
      content: string,
      beforePublish?: () => Promise<void>,
    ) => {
      const before = await lstat(path, { bigint: true });
      const foreign = await loadConfigDetailed(path);
      foreign.config.maxSteps = 83;
      foreignBytes = `${JSON.stringify(foreign.config, null, 2)}\n`;
      await writeFile(path, foreignBytes, "utf8");
      const after = await lstat(path, { bigint: true });
      sameInode = before.dev === after.dev && before.ino === after.ino;
      await beforePublish?.();
      await writeFileAtomicSecure(path, content);
    },
  });

  await assert.rejects(
    coordinator.activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
        persist: async (_candidate, authority) => {
          const staged = await loadConfigDetailed(fixture.path);
          staged.config.mainModel = "openai/staged-preference";
          await saveConfig(staged.config, fixture.path);
          return authority.acknowledgePersistence(
            (await readConfigEditSnapshot(fixture.path)).file,
          );
        },
        abortAndReconcile: async () => ({ kind: "old" }),
        complete: acknowledgePreferenceCompletion,
        cleanup: acknowledgePreferenceCleanup,
      }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-config-stale",
  );

  assert.equal(sameInode, true, "fixture must retain dev/inode while changing exact bytes");
  assert.notEqual(foreignBytes, "");
  assert.equal(await readFile(fixture.path, "utf8"), foreignBytes);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("preference commit requires one exact runtime config fence", async (t) => {
  for (const [name, result] of [
    ["missing", undefined],
    ["invalid", { configFence: { kind: "file", raw: "{}" } }],
  ] as const) {
    await t.test(name, async () => {
      const fixture = await activationFixture();
      const beforeConfig = await readFile(fixture.path, "utf8");
      await assert.rejects(
        fixture.coordinator().activate({
          ...fixture.request,
          persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
            persist: async () => result as never,
            abortAndReconcile: async () => ({ kind: "old" }),
            complete: acknowledgePreferenceCompletion,
            cleanup: acknowledgePreferenceCleanup,
          }),
        }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "provider-preference-config-fence-invalid",
      );
      assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
      assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
      assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
      assert.deepEqual(await journalDirectories(fixture.appHome), []);
    });
  }
});

test("an unbranded preference commit port fails closed and leaves exact OLD", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      persistBeforeProviderConfigCommit: Object.freeze({ version: 1 }) as never,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-port-invalid",
  );
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("deadline revokes a never-settling preference commit and permits an immediate clean retry", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  let reached!: () => void;
  const commitReached = new Promise<void>((resolve) => { reached = resolve; });
  let reconcileCalls = 0;
  const coordinator = fixture.coordinatorWith({
    now: Date.now,
    leaseDurationMs: 10_000,
  });
  const first = coordinator.activate({
    ...fixture.request,
    deadlineAt: Date.now() + 2_000,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async (_candidate, authority) => {
        authority.assertMutationAllowed();
        reached();
        return new Promise<never>(() => undefined);
      },
      abortAndReconcile: async (_authority) => {
        reconcileCalls += 1;
        return { kind: "old" };
      },
      complete: acknowledgePreferenceCompletion,
      cleanup: acknowledgePreferenceCleanup,
    }),
  });
  await commitReached;

  const firstError = await Promise.race([
    first.catch((error: unknown) => error),
    new Promise<"still-held">((resolve) => setTimeout(() => resolve("still-held"), 3_000)),
  ]);
  assert.notEqual(firstError, "still-held");
  assert.ok(firstError instanceof Error);
  assert.equal("code" in firstError ? firstError.code : null, "provider-activation-deadline");
  assert.equal(reconcileCalls, 1);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);

  const retried = await fixture.coordinator().activate(fixture.request);
  assert.equal(retried.persisted, true);
});

test("a preference continuation settling after revoke cannot mutate config or orphan a credential", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const controller = new AbortController();
  const reason = new DOMException("fixed preference cancellation", "AbortError");
  let reached!: () => void;
  let resume!: () => void;
  let lateSettled!: () => void;
  const commitReached = new Promise<void>((resolve) => { reached = resolve; });
  const resumeCommit = new Promise<void>((resolve) => { resume = resolve; });
  const lateSettlement = new Promise<void>((resolve) => { lateSettled = resolve; });
  const first = fixture.coordinator().activate({
    ...fixture.request,
    signal: controller.signal,
    persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
      persist: async (_candidate, authority) => {
        reached();
        try {
          await resumeCommit;
          authority.assertMutationAllowed();
          const config = await loadConfigDetailed(fixture.path);
          config.config.maxSteps = 91;
          await saveConfig(config.config, fixture.path);
          return authority.acknowledgePersistence(
            (await readConfigEditSnapshot(fixture.path)).file,
          );
        } finally {
          lateSettled();
        }
      },
      abortAndReconcile: async () => ({ kind: "old" }),
      complete: acknowledgePreferenceCompletion,
      cleanup: acknowledgePreferenceCleanup,
    }),
  });
  await commitReached;
  controller.abort(reason);
  await assert.rejects(first, (error: unknown) => error === reason);
  resume();
  await lateSettlement;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

interface KimiActivationFixtureOptions {
  crashAfter?: Boundary;
  oldModelId?: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed";
}

async function kimiActivationFixture(options: KimiActivationFixtureOptions = {}) {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-kimi-activation-"));
  const path = join(appHome, "config.json");
  const oldState = kimiActivationState(options.oldModelId);
  const initialConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    mainModel: oldState.defaultRoute?.requestedModelId ?? DEFAULT_CONFIG.mainModel,
    providerSetup: oldState,
  } satisfies OrcodeConfigWithBudget;
  await saveConfig(initialConfig, path);
  const credentials = new FakeCredentials(null);
  credentials.slots.set(KIMI_OLD_SLOT.id, OLD_SECRET);
  const adapter = new FakeKimiAdapter();
  const runtimeGuard = new FakeRuntimeGuard();
  const stateStore = new ProviderStateStore(oldState);
  const privateStore = new PrivateStore({ root: appHome });
  const resolverArguments: string[] = [];
  const api = await import("../src/provider-activation.js");
  let now = 10_000;
  const makeCoordinator = (overrides: Record<string, unknown> = {}) => new api.ProviderActivationCoordinator({
    appHome,
    configPath: path,
    privateStore,
    credentials,
    adapterResolver: (backendId) => {
      resolverArguments.push(backendId);
      assert.equal(backendId, "kimi-code");
      return adapter;
    },
    stateStore,
    runtimeGuard,
    candidateAuthority: {
      async validateCandidatePermitUnderLease() { return { kind: "ready" as const }; },
      async validateCandidatePermitAgainstSnapshotUnderLease() { return { kind: "ready" as const }; },
    },
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
    onBoundary: options.crashAfter
      ? async (boundary: Boundary) => {
        if (boundary === options.crashAfter) throw new Error(`simulated-crash:${boundary}`);
      }
      : async () => undefined,
    ...overrides,
  });
  let coordinator = makeCoordinator();
  const request = {
    backendId: "kimi-code" as const,
    expectedRevision: oldState.revision,
    candidate: KIMI_SECRET,
    expectedRequestedModelId: KIMI_MODEL.requestedModelId,
    selectedCanonicalModelId: KIMI_MODEL.canonicalModelId,
    generation: 4,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted" as const,
    environmentEligibility: "forbidden" as const,
    targetConnectionId: KIMI_CONNECTION_ID,
    candidatePermit: KIMI_TEST_PERMIT,
    requireCandidatePermit: true as const,
    candidateAuthorityPurpose: "initial-setup" as const,
  };
  return {
    api,
    appHome,
    path,
    oldState,
    initialConfig,
    credentials,
    adapter,
    runtimeGuard,
    stateStore,
    privateStore,
    resolverArguments,
    request,
    activate: () => coordinator.activate(request),
    coordinator: () => coordinator,
    coordinatorWith: (overrides: Record<string, unknown>) => makeCoordinator(overrides),
    restartAndRecover: async (inspectCommitted = true) => {
      now += 1_000;
      coordinator = makeCoordinator({
        runtimeGuard: new FakeRuntimeGuard(),
        onBoundary: async () => undefined,
      });
      await coordinator.recover({ signal: new AbortController().signal, inspectCommitted });
      return readTuple(path, credentials);
    },
  };
}

for (const persistence of ["persisted", "process-only"] as const) {
  test(`${persistence} activation rejects a reordered duplicate canonical alias before route, slot, or config mutation`, async () => {
    const fixture = await activationFixture();
    const selected = {
      ...MODEL,
      requestedModelId: "openai/selected-alias",
    };
    const reordered = {
      ...MODEL,
      requestedModelId: "openai/reordered-alias",
    };
    const duplicate = {
      ...MODEL,
      requestedModelId: "openai/duplicate-alias",
    };
    fixture.adapter.listModels = async () => [reordered, duplicate];
    fixture.adapter.activate = async (request) => ({
      candidateId: request.candidateId,
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      accountFingerprint: NEW_FINGERPRINT,
      billingRealm: "openrouter-payg",
      route: {
        ...newRoute(),
        requestedModelId: request.model.requestedModelId,
        canonicalModelId: request.model.canonicalModelId,
      },
    });
    const configBefore = await readFile(fixture.path, "utf8");
    const stateBefore = fixture.stateStore.read();
    const slotsBefore = new Map(fixture.credentials.slots);
    const runtimeBefore = structuredClone(fixture.adapter.runtimeRoute);

    await assert.rejects(
      fixture.coordinator().activate({
        ...fixture.request,
        expectedRequestedModelId: selected.requestedModelId,
        selectedCanonicalModelId: selected.canonicalModelId,
        persistence,
      }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "provider-model-selection-invalid"
      ),
    );

    assert.equal(await readFile(fixture.path, "utf8"), configBefore);
    assert.deepEqual(fixture.stateStore.read(), stateBefore);
    assert.deepEqual(fixture.credentials.slots, slotsBefore);
    assert.deepEqual(fixture.adapter.runtimeRoute, runtimeBefore);
  });
}

for (const boundary of boundaries) {
  test(`activation crash after ${boundary} recovers one complete tuple`, async () => {
    const fixture = await activationFixture({ crashAfter: boundary });
    await assert.rejects(fixture.activate(), new RegExp(`simulated-crash:${boundary}`));
    if (boundary === "config-written") {
      assert.equal((await journalDirectories(fixture.appHome)).length, 1);
      assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
    }
    const recovered = await fixture.restartAndRecover();
    const oldTuple = await tupleForState(fixture.initialConfig.providerSetup, fixture.credentials);
    const loaded = await loadConfigDetailed(fixture.path);
    const newTuple = await tupleForState(loaded.config.providerSetup as ProviderSetupStateV3, fixture.credentials);
    assert.ok(
      deepEqual(recovered, oldTuple) || recovered.secret === NEW_SECRET,
      `mixed tuple after ${boundary}: ${JSON.stringify(recovered)}`,
    );
    assert.equal(
      recovered.connection === null
        ? recovered.slotId === null
        : requireKeychainCredentialPointer(recovered.connection) === recovered.slotId,
      true,
    );
    assert.equal(
      newTuple.connection === null
        ? newTuple.slotId === null
        : requireKeychainCredentialPointer(newTuple.connection) === newTuple.slotId,
      true,
    );
  });
}

test("two parallel same-revision activations commit once and the loser is stale before reserve or journal", async () => {
  const fixture = await activationFixture();
  const second = fixture.coordinator().activate(fixture.request);
  const first = fixture.activate();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  assert.ok(rejected?.reason instanceof fixture.api.StaleProviderGenerationError);
  assert.equal(fixture.credentials.calls.filter((call) => call === "reserveSlot").length, 1);
});

test("an active run rejects before lease journal slot or config mutation and explicit drain permits activation", async () => {
  const fixture = await activationFixture();
  fixture.runtimeGuard.activeRuns = 1;
  const before = await fileTree(fixture.appHome);
  await assert.rejects(fixture.activate(), /runtime|idle|run/i);
  assert.deepEqual(await fileTree(fixture.appHome), before);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  fixture.runtimeGuard.drain();
  await fixture.activate();
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
});

test("stale expected revision blocks candidate network before activation", async () => {
  const fixture = await activationFixture();
  const current = fixture.stateStore.read();
  const changed = { ...current, revision: current.revision + 1 };
  fixture.stateStore.replace(changed, current.revision);
  const config = await loadConfigDetailed(fixture.path);
  await saveConfig({ ...config.config, providerSetup: changed }, fixture.path);
  const before = await fileTree(fixture.appHome);

  await assert.rejects(fixture.activate());

  assert.equal(fixture.adapter.calls.includes("connect"), false);
  assert.deepEqual(await fileTree(fixture.appHome), before);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("an active run rejects process-only activation before candidate or durable mutation", async () => {
  const fixture = await activationFixture();
  fixture.runtimeGuard.activeRuns = 1;
  const before = await fileTree(fixture.appHome);

  await assert.rejects(fixture.coordinator().activate({
    ...fixture.request,
    persistence: "process-only",
  }), /runtime|idle|run/i);

  assert.deepEqual(await fileTree(fixture.appHome), before);
  assert.equal(fixture.adapter.calls.includes("connect"), false);
  assert.equal(fixture.credentials.calls.length, 0);
});

test("cancellation while waiting on a live lease is preserved and writes no durable artifact", async () => {
  const fixture = await activationFixture({ now: 100 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const claim = await store.createDirectoryExclusive(join(fixture.appHome, "provider-setup.lock"));
  assert.ok(claim);
  const owner = '{"version":1,"ownerId":"60000000-0000-4000-8000-000000000010","acquiredAt":100,"expiresAt":1000}\n';
  await store.writeClaimOwner(claim, owner);
  const controller = new AbortController();
  const reason = new DOMException("fixed cancellation", "AbortError");
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 100,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    leaseAttempts: 2,
    waitForLease: async () => { controller.abort(reason); },
  });
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    coordinator.activate({ ...fixture.request, signal: controller.signal }),
    (error: unknown) => error === reason,
  );

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.equal(await store.readClaimOwner(claim), owner);
});

test("cancellation while waiting on config writer ownership preserves the exact reason", async () => {
  const fixture = await activationFixture();
  let lockReached!: () => void;
  let releaseLock!: () => void;
  const reached = new Promise<void>((resolve) => { lockReached = resolve; });
  const pause = new Promise<void>((resolve) => { releaseLock = resolve; });
  const held = withConfigWriteLock(fixture.path, async () => {
    lockReached();
    await pause;
  });
  await reached;
  let candidateRevalidated!: () => void;
  const staged = new Promise<void>((resolve) => { candidateRevalidated = resolve; });
  const controller = new AbortController();
  const reason = new DOMException("exact config wait cancellation", "AbortError");
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    onBoundary: (boundary: Boundary) => {
      if (boundary === "candidate-revalidated") candidateRevalidated();
    },
  });
  const beforeConfig = await readFile(fixture.path, "utf8");
  const activation = coordinator.activate({ ...fixture.request, signal: controller.signal });
  await staged;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(activation, (error: unknown) => error === reason);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  releaseLock();
  await held;
});

test("the held runtime guard prevents a run from starting through config commit and runtime bind", async () => {
  const fixture = await activationFixture();
  let tried = false;
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    onBoundary: async (boundary: Boundary) => {
      if (boundary === "config-readback") {
        tried = true;
        assert.equal(fixture.runtimeGuard.tryStartRun(), false);
      }
    },
  });
  await coordinator.activate(fixture.request);
  assert.equal(tried, true);
  assert.equal(fixture.runtimeGuard.held, false);
});

test("a config write that fails before publish keeps the old pointer and cleans only the owned candidate", async () => {
  const fixture = await activationFixture({ saveMode: "throw-before" });
  await assert.rejects(fixture.activate(), /config|persist|activation/i);
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(tuple.secret, OLD_SECRET);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.equal(fixture.credentials.slots.get(FOREIGN_SLOT.id), FOREIGN_SECRET);
});

test("an unbranded post-return config throw cannot authorize candidate adoption from exact readback", async () => {
  const fixture = await activationFixture({ saveMode: "throw-after" });
  await assert.rejects(
    fixture.activate(),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "provider-config-commit-ambiguous"
    ),
  );
  const durable = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  assert.equal(durable.providerSetup.revision, fixture.oldState.revision + 1);
  assert.equal(requireKeychainCredentialPointer(durable.providerSetup.connections[0]!), NEW_SLOT_ID);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.deepEqual(fixture.adapter.runtimeRoute, oldRoute());
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("a branded post-publication failure with exact candidate readback authorizes one complete adoption", async () => {
  const fixture = await activationFixture({ saveMode: "throw-branded-after" });
  const result = await fixture.activate();
  assert.equal(result.persisted, true);
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(tuple.secret, NEW_SECRET);
  assert.deepEqual(fixture.stateStore.read(), result.state);
  assert.deepEqual(fixture.adapter.runtimeRoute, newRoute());
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("a successful writer with exact old readback is recovery-required and retains candidate artifacts", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const coordinator = fixture.coordinatorWith({
    writeConfigAtomic: async (
      _path: string,
      _content: string,
      beforePublish?: () => Promise<void>,
      beforeRename?: () => void,
    ) => {
      await beforePublish?.();
      beforeRename?.();
    },
  });

  await assert.rejects(
    coordinator.activate(fixture.request),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "provider-config-commit-ambiguous"
    ),
  );

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), fixture.oldState);
  assert.deepEqual(fixture.adapter.runtimeRoute, oldRoute());
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("provider publication rejects a symlinked config target without consuming outside bytes", async () => {
  const fixture = await activationFixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), "orcode-provider-config-outside-"));
  const outside = join(outsideRoot, "outside.json");
  await rename(fixture.path, outside);
  await symlink(outside, fixture.path);
  const beforeOutside = await readFile(outside, "utf8");

  const error = await fixture.activate().catch((reason: unknown) => reason);

  assert.ok(error instanceof fixture.api.ProviderActivationRecoveryRequiredError);
  assert.doesNotMatch(String(error), /old-provider-secret|outside|secret-marker/i);
  assert.equal((await lstat(fixture.path)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), beforeOutside);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("a paused unrelated config writer is preserved by the final fenced reread and providerSetup-only merge", async () => {
  const fixture = await activationFixture();
  const preservedMainModel = "preserve/concurrent-writer-main";
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    onBoundary: async (boundary: Boundary) => {
      if (boundary !== "candidate-revalidated") return;
      const raw = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>;
      raw.mainModel = preservedMainModel;
      await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
    },
  });

  await coordinator.activate(fixture.request);

  const saved = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>;
  assert.equal(saved.mainModel, preservedMainModel);
});

test("provider publication serializes an independent saveConfig writer without losing either complete update", async () => {
  const fixture = await activationFixture();
  let publishReached!: () => void;
  let resumePublish!: () => void;
  const reached = new Promise<void>((resolve) => { publishReached = resolve; });
  const pause = new Promise<void>((resolve) => { resumePublish = resolve; });
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    writeConfigAtomic: async (path: string, content: string) => {
      publishReached();
      await pause;
      await writeFileAtomicSecure(path, content);
    },
  });
  const activation = coordinator.activate(fixture.request);
  await reached;

  const unrelated = structuredClone(fixture.initialConfig);
  unrelated.mainModel = "preserve/independent-config-writer";
  let unrelatedSettled = false;
  const unrelatedWrite = saveConfig(unrelated, fixture.path).then(() => {
    unrelatedSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledWhileProviderOwned = unrelatedSettled;
  resumePublish();
  await Promise.all([activation, unrelatedWrite]);

  const saved = JSON.parse(await readFile(fixture.path, "utf8")) as {
    mainModel: string;
    providerSetup: ProviderSetupStateV3;
  };
  assert.equal(settledWhileProviderOwned, false);
  assert.equal(saved.mainModel, "preserve/independent-config-writer");
  assert.equal(saved.providerSetup.revision, fixture.oldState.revision + 1);
  assert.equal(requireKeychainCredentialPointer(saved.providerSetup.connections[0]!), NEW_SLOT_ID);
  assert.deepEqual(saved.providerSetup.defaultRoute, newRoute());
});

test("a stale ordinary config writer after activation preserves the committed providerSetup", async () => {
  const fixture = await activationFixture();
  const stale = structuredClone(fixture.initialConfig);

  await fixture.activate();
  stale.mainModel = "preserve/stale-writer-after-activation";
  await saveConfig(stale, fixture.path);

  const saved = JSON.parse(await readFile(fixture.path, "utf8")) as {
    mainModel: string;
    providerSetup: ProviderSetupStateV3;
  };
  assert.equal(saved.mainModel, "preserve/stale-writer-after-activation");
  assert.equal(saved.providerSetup.revision, fixture.oldState.revision + 1);
  assert.equal(requireKeychainCredentialPointer(saved.providerSetup.connections[0]!), NEW_SLOT_ID);
  assert.deepEqual(saved.providerSetup.defaultRoute, newRoute());
});

test("raw config CAS preserves every unrelated byte including whitespace unknown fields and 21 fallbacks", async () => {
  const fixture = await activationFixture();
  const parsed = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>;
  parsed.fallbackModels = Array.from({ length: 21 }, (_, index) => `preserve/model-${index}`);
  parsed["futureTopLevelField"] = {
    keep: "byte exact",
    nested: [1, true, null, { exact: "spacing survives" }],
  };
  const before = `${JSON.stringify(parsed, null, 3)}\n\n`;
  await writeFile(fixture.path, before, "utf8");

  await fixture.activate();

  const after = await readFile(fixture.path, "utf8");
  assert.equal(maskProviderSetup(after), maskProviderSetup(before));
  const saved = JSON.parse(after) as Record<string, unknown>;
  assert.equal((saved.fallbackModels as unknown[]).length, 21);
  assert.deepEqual(saved.futureTopLevelField, parsed.futureTopLevelField);
});

test("same-revision providerSetup mutation before raw CAS is retained and blocks candidate commit", async () => {
  const fixture = await activationFixture();
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    onBoundary: async (boundary: Boundary) => {
      if (boundary !== "candidate-revalidated") return;
      const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
        providerSetup: ProviderSetupStateV3;
      };
      raw.providerSetup.lifecycle = "cancelled";
      await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
    },
  });

  await assert.rejects(
    coordinator.activate(fixture.request),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  const retained = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  assert.equal(retained.providerSetup.lifecycle, "cancelled");
  assert.equal(retained.providerSetup.revision, fixture.oldState.revision);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("ambiguous corrupt config readback retains journal and both slots as recovery-required", async () => {
  const fixture = await activationFixture({ saveMode: "write-corrupt" });
  await assert.rejects(fixture.activate(), fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("candidate cleanup failure returns a fixed warning and never deletes active or foreign slots", async () => {
  const fixture = await activationFixture();
  fixture.credentials.failDelete = true;
  const result = await fixture.activate();
  assert.equal(result.persisted, true);
  assert.deepEqual(result.warnings, ["provider-candidate-cleanup-retained"]);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal(fixture.credentials.slots.get(FOREIGN_SLOT.id), FOREIGN_SECRET);
  assert.doesNotMatch(JSON.stringify(result), /raw-keyring|secret-marker|provider-secret/);
});

test("old v1 cleanup retains a slot referenced by another exact pending journal", async () => {
  const fixture = await activationFixture();
  const otherTransactionId = "70000000-0000-4000-8000-000000000001";
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    onBoundary: async (boundary: Boundary) => {
      if (boundary !== "runtime-activated") return;
      await fixture.privateStore.writeTextAtomic(
        join(
          fixture.appHome,
          "provider-activation",
          otherTransactionId,
          "manifest.json",
        ),
        `${JSON.stringify({
          version: 1,
          transactionId: otherTransactionId,
          expectedRevision: fixture.oldState.revision,
          phase: "prepared",
          backendId: "openrouter",
          candidateSlot: OLD_SLOT,
          previousSlot: null,
          candidateConnectionId: CONNECTION_ID,
          candidateRoute: oldRoute(),
          expectedProviderSetupSha256: TEST_OLD_STATE_SHA256,
          candidateProviderSetupSha256: TEST_CANDIDATE_STATE_SHA256,
        })}\n`,
      );
    },
  });

  const result = await coordinator.activate(fixture.request);

  assert.deepEqual(result.warnings, ["provider-candidate-cleanup-retained"]);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 2);
});

test("committed recovery retains both slots until exact authenticated inspection then cleans only old v1", async () => {
  const crashed = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(crashed.activate());
  await crashed.restartAndRecover(false);
  assert.equal(crashed.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(crashed.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(crashed.appHome)).length, 1);
  await crashed.restartAndRecover(true);
  assert.equal(crashed.credentials.slots.has(OLD_SLOT.id), false);
  assert.equal(crashed.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(crashed.appHome)).length, 0);
});

test("committed recovery cleans the old slot before binding the runtime", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate(), /simulated-crash:config-readback/);
  assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
  const originalDeleteSlot = fixture.credentials.deleteSlot.bind(fixture.credentials);
  let runtimeSecretAtOldSlotCleanup: string | null = null;
  fixture.credentials.deleteSlot = async (slot) => {
    if (slot.id === OLD_SLOT.id) {
      runtimeSecretAtOldSlotCleanup = fixture.adapter.runtimeSecret;
    }
    return originalDeleteSlot(slot);
  };

  await fixture.restartAndRecover(true);

  assert.equal(runtimeSecretAtOldSlotCleanup, OLD_SECRET);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 0);
});

test("process-only activation branches before lease journal reservation slot and config writes", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);
  const result = await fixture.coordinator().activate({
    ...fixture.request,
    persistence: "process-only",
  });
  assert.equal(result.persisted, false);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("declining process-only after keychain failure leaves runtime config and keychain bytes unchanged", async () => {
  const fixture = await activationFixture();
  fixture.credentials.failWrite = "before";
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);
  await assert.rejects(fixture.coordinator().activate({
    ...fixture.request,
    onPersistenceFailure: async () => "decline",
  }), /credential|persist|activation/i);
  assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("approved process-only fallback removes failed persistence artifacts before ephemeral bind", async () => {
  const fixture = await activationFixture();
  fixture.credentials.failWrite = "before";
  const beforeConfig = await readFile(fixture.path, "utf8");
  const result = await fixture.coordinator().activate({
    ...fixture.request,
    onPersistenceFailure: async () => "process-only",
  });
  assert.equal(result.persisted, false);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("failed candidate cleanup retains a v1 slot referenced by another pending journal", async () => {
  const fixture = await activationFixture();
  fixture.credentials.failWrite = "after";
  const otherTransactionId = "70000000-0000-4000-8000-000000000004";

  await assert.rejects(fixture.coordinator().activate({
    ...fixture.request,
    onPersistenceFailure: async () => {
      await fixture.privateStore.writeTextAtomic(
        join(
          fixture.appHome,
          "provider-activation",
          otherTransactionId,
          "manifest.json",
        ),
        `${JSON.stringify({
          version: 1,
          transactionId: otherTransactionId,
          expectedRevision: fixture.oldState.revision,
          phase: "credential-staged",
          backendId: "openrouter",
          candidateSlot: {
            version: 1,
            kind: "inference",
            id: NEW_SLOT_ID,
          },
          previousSlot: OLD_SLOT,
          candidateConnectionId: CONNECTION_ID,
          candidateRoute: newRoute(),
          expectedProviderSetupSha256: TEST_OLD_STATE_SHA256,
          candidateProviderSetupSha256: TEST_CANDIDATE_STATE_SHA256,
        })}\n`,
      );
      return "decline";
    },
  }), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 2);
});

test("legacy v0 inference credential remains byte-exact after successful persisted replacement", async () => {
  const fixture = await activationFixture({ oldSlot: "legacy:inference" });
  await fixture.activate();
  assert.equal(fixture.credentials.legacy.get("inference"), OLD_SECRET);
  assert.equal(fixture.credentials.calls.some((call) => call === "delete:inference"), false);
});

test("future provider config causes zero journal slot config runtime or cleanup effects", async () => {
  const fixture = await activationFixture();
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>;
  raw.providerSetup = { schemaVersion: 99 };
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);
  await assert.rejects(fixture.activate(), /future|recovery|provider/i);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("revision overflow fails before reserve journal config or runtime effects", async () => {
  const fixture = await activationFixture();
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.revision = Number.MAX_SAFE_INTEGER;
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  await assert.rejects(fixture.coordinator().activate({
    ...fixture.request,
    expectedRevision: Number.MAX_SAFE_INTEGER,
  }), /revision|safe|generation/i);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("runtime bind failure before mutation retains committed candidate journal and blocks old-slot cleanup", async () => {
  const fixture = await activationFixture();
  fixture.adapter.activateFailure = "before";
  await assert.rejects(fixture.activate(), fixture.api.ProviderActivationRecoveryRequiredError);
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(tuple.secret, NEW_SECRET);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("runtime bind failure after internal mutation retains committed journal and both slots", async () => {
  const fixture = await activationFixture();
  fixture.adapter.activateFailure = "after";
  await assert.rejects(fixture.activate(), fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("lost runtime guard during awaited persisted bind blocks cleanup and success", async () => {
  const fixture = await activationFixture();
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  fixture.adapter.activateReached = reached;
  fixture.adapter.activatePause = new Promise<void>((resolve) => { resume = resolve; });

  const activation = fixture.activate();
  await reachedPromise;
  fixture.runtimeGuard.lose();
  resume();

  await assert.rejects(activation, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("lost runtime guard during awaited process-only bind blocks a success result", async () => {
  const fixture = await activationFixture();
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  fixture.adapter.activateReached = reached;
  fixture.adapter.activatePause = new Promise<void>((resolve) => { resume = resolve; });

  const activation = fixture.coordinator().activate({
    ...fixture.request,
    persistence: "process-only",
  });
  await reachedPromise;
  fixture.runtimeGuard.lose();
  resume();

  await assert.rejects(activation, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("lost runtime guard during recovery bind happens only after old-slot and journal cleanup", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  fixture.adapter.activateReached = reached;
  fixture.adapter.activatePause = new Promise<void>((resolve) => { resume = resolve; });
  const recoveryGuard = new FakeRuntimeGuard();
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: recoveryGuard,
    now: () => 20_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });

  const recovery = coordinator.recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  await reachedPromise;
  recoveryGuard.lose();
  resume();

  await assert.rejects(recovery, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), false);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 0);
});

test("recovery guard loss during awaited candidate connect prevents runtime bind", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  fixture.adapter.connectReached = reached;
  fixture.adapter.connectPause = new Promise<void>((resolve) => { resume = resolve; });
  const recoveryGuard = new FakeRuntimeGuard();
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: recoveryGuard,
    now: () => 20_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });
  const activateCallsBefore = fixture.adapter.calls.filter((call) => call === "activate").length;

  const recovery = coordinator.recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  await reachedPromise;
  recoveryGuard.lose();
  resume();

  await assert.rejects(recovery, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(
    fixture.adapter.calls.filter((call) => call === "activate").length,
    activateCallsBefore,
  );
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery guard loss during awaited model listing prevents runtime bind", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  fixture.adapter.listModelsReached = reached;
  fixture.adapter.listModelsPause = new Promise<void>((resolve) => { resume = resolve; });
  const recoveryGuard = new FakeRuntimeGuard();
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: recoveryGuard,
    now: () => 20_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });
  const activateCallsBefore = fixture.adapter.calls.filter((call) => call === "activate").length;

  const recovery = coordinator.recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  await reachedPromise;
  recoveryGuard.lose();
  resume();

  await assert.rejects(recovery, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(
    fixture.adapter.calls.filter((call) => call === "activate").length,
    activateCallsBefore,
  );
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery guard loss during the final provider fence prevents runtime bind", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const pause = new Promise<void>((resolve) => { resume = resolve; });
  let listCompleted = false;
  let fencePaused = false;
  fixture.adapter.listModelsReached = () => { listCompleted = true; };
  const originalAssert = fixture.privateStore.assertDirectoryClaim.bind(fixture.privateStore);
  fixture.privateStore.assertDirectoryClaim = async (claim) => {
    await originalAssert(claim);
    if (listCompleted && !fencePaused) {
      fencePaused = true;
      reached();
      await pause;
    }
  };
  const recoveryGuard = new FakeRuntimeGuard();
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: recoveryGuard,
    now: () => 20_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });
  const activateCallsBefore = fixture.adapter.calls.filter((call) => call === "activate").length;

  const recovery = coordinator.recover({
    signal: new AbortController().signal,
    inspectCommitted: true,
  });
  await reachedPromise;
  recoveryGuard.lose();
  resume();

  await assert.rejects(recovery, fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(
    fixture.adapter.calls.filter((call) => call === "activate").length,
    activateCallsBefore,
  );
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("runtime release failure after process-only bind is fixed recovery-required not success", async () => {
  const fixture = await activationFixture();
  fixture.runtimeGuard.failRelease = true;

  const error = await fixture.coordinator().activate({
    ...fixture.request,
    persistence: "process-only",
  }).catch((reason: unknown) => reason);

  assert.ok(error instanceof fixture.api.ProviderActivationRecoveryRequiredError);
  assert.doesNotMatch(String(error), /raw-runtime|secret-marker/i);
  assert.equal(fixture.runtimeGuard.releaseCalls, 1);
});

test("provider lease release failure after persisted bind is fixed recovery-required not success", async () => {
  const fixture = await activationFixture();
  const originalRelease = fixture.privateStore.releaseDirectoryClaim.bind(fixture.privateStore);
  fixture.privateStore.releaseDirectoryClaim = async (claim, expectedOwner) => {
    if (expectedOwner !== null) throw new Error("raw-provider-release-secret-marker");
    return originalRelease(claim, expectedOwner);
  };

  const error = await fixture.activate().catch((reason: unknown) => reason);

  assert.ok(error instanceof fixture.api.ProviderActivationRecoveryRequiredError);
  assert.doesNotMatch(String(error), /raw-provider|secret-marker/i);
  assert.equal(fixture.runtimeGuard.releaseCalls, 1);
});

test("provider and runtime release failures are both attempted and aggregated redacted", async () => {
  const fixture = await activationFixture();
  let providerReleaseCalls = 0;
  fixture.runtimeGuard.failRelease = true;
  const originalRelease = fixture.privateStore.releaseDirectoryClaim.bind(fixture.privateStore);
  fixture.privateStore.releaseDirectoryClaim = async (claim, expectedOwner) => {
    if (expectedOwner !== null) {
      providerReleaseCalls += 1;
      throw new Error("raw-provider-release-secret-marker");
    }
    return originalRelease(claim, expectedOwner);
  };

  const error = await fixture.activate().catch((reason: unknown) => reason);

  assert.ok(error instanceof fixture.api.ProviderActivationRecoveryRequiredError);
  assert.doesNotMatch(String(error), /raw-provider|raw-runtime|secret-marker/i);
  assert.equal(providerReleaseCalls, 1);
  assert.equal(fixture.runtimeGuard.releaseCalls, 1);
});

for (const primary of ["abort", "provider-error"] as const) {
  for (const releaseFailure of ["runtime", "provider", "both"] as const) {
    test(`${primary} primary survives ${releaseFailure} release failure while both releases are attempted`, async () => {
      const fixture = await activationFixture({ crashAfter: "config-readback" });
      await assert.rejects(fixture.activate());
      const staleLease = await fixture.privateStore.adoptDirectoryClaim(
        join(fixture.appHome, "provider-setup.lock"),
      );
      const staleOwner = await fixture.privateStore.readClaimOwner(staleLease.claim);
      await fixture.privateStore.releaseDirectoryClaim(staleLease.claim, staleOwner);
      fixture.runtimeGuard.lose();
      fixture.runtimeGuard.failRelease = releaseFailure !== "provider";
      fixture.adapter.connectFailure = primary === "abort"
        ? new DOMException("raw-abort-primary-secret-marker", "AbortError")
        : new Error("raw-provider-primary-secret-marker");
      let providerReleaseCalls = 0;
      const originalRelease = fixture.privateStore.releaseDirectoryClaim.bind(
        fixture.privateStore,
      );
      fixture.privateStore.releaseDirectoryClaim = async (claim, expectedOwner) => {
        if (expectedOwner !== null) {
          providerReleaseCalls += 1;
          if (releaseFailure !== "runtime") {
            throw new Error("raw-provider-release-secret-marker");
          }
        }
        return originalRelease(claim, expectedOwner);
      };

      const error = await fixture.recover(true).catch((reason: unknown) => reason);

      if (primary === "abort") {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, "AbortError");
      } else {
        assert.ok(error instanceof fixture.api.ProviderActivationError);
        assert.equal(error.code, "provider-candidate-validation-failed");
      }
      assert.doesNotMatch(
        String(error),
        /raw-provider|raw-runtime|raw-abort|secret-marker/i,
      );
      assert.equal(providerReleaseCalls, 1);
      assert.equal(fixture.runtimeGuard.releaseCalls, 1);
    });
  }
}

test("restart inspection after bind failure authenticates binds and only then cleans old v1", async () => {
  const fixture = await activationFixture();
  fixture.adapter.activateFailure = "before";
  await assert.rejects(fixture.activate(), fixture.api.ProviderActivationRecoveryRequiredError);
  fixture.adapter.activateFailure = null;

  await fixture.restartAndRecover(true);

  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal(fixture.credentials.slots.has(OLD_SLOT.id), false);
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("strict manifest contains no secret source raw account model response or path", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  const dirs = await journalDirectories(fixture.appHome);
  assert.equal(dirs.length, 1);
  const manifestPath = join(fixture.appHome, "provider-activation", dirs[0]!, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "backendId",
    "candidateConnectionId",
    "candidateProviderSetupSha256",
    "candidateRoute",
    "candidateSlot",
    "credentialSlotKind",
    "expectedProviderSetupSha256",
    "expectedRevision",
    "phase",
    "previousSlot",
    "transactionId",
    "version",
  ]);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.credentialSlotKind, "inference");
  assert.doesNotMatch(raw, /provider-secret|OPENROUTER_API_KEY|creator_user_id|raw-provider|\/Users\/|\\Users\\/i);
});

test("literal legacy OpenRouter journal v1 recovers through the frozen validator", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  const [transactionId] = await journalDirectories(fixture.appHome);
  assert.ok(transactionId);
  const manifestPath = join(fixture.appHome, "provider-activation", transactionId, "manifest.json");
  const v2 = JSON.parse(await readFile(manifestPath, "utf8")) as ProviderActivationJournalV2;
  const legacy = {
    version: 1,
    transactionId,
    expectedRevision: v2.expectedRevision,
    phase: v2.phase,
    backendId: "openrouter",
    candidateSlot: { version: 1, kind: "inference", id: v2.candidateSlot.id },
    previousSlot: v2.previousSlot,
    candidateConnectionId: v2.candidateConnectionId,
    candidateRoute: v2.candidateRoute,
    expectedProviderSetupSha256: v2.expectedProviderSetupSha256,
    candidateProviderSetupSha256: v2.candidateProviderSetupSha256,
  };
  await writeFile(manifestPath, `${JSON.stringify(legacy)}\n`, "utf8");

  await fixture.restartAndRecover(false);

  assert.deepEqual(await journalDirectories(fixture.appHome), []);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.has(v2.candidateSlot.id), false);
});

test("frozen journal-v1 rejects malformed historical identity and slot shapes without mutation", async (t) => {
  const mutations: Readonly<Record<string, (legacy: Record<string, unknown>) => void>> = {
    "empty account fingerprint": (legacy) => { (legacy.candidateRoute as Record<string, unknown>).accountFingerprint = ""; },
    "empty requested model": (legacy) => { (legacy.candidateRoute as Record<string, unknown>).requestedModelId = ""; },
    "empty canonical model": (legacy) => { (legacy.candidateRoute as Record<string, unknown>).canonicalModelId = ""; },
    "Kimi backend": (legacy) => { (legacy.candidateRoute as Record<string, unknown>).backendId = "kimi-code"; },
    "wrong realm": (legacy) => { (legacy.candidateRoute as Record<string, unknown>).billingRealm = "wrong-realm"; },
    "management candidate slot": (legacy) => { (legacy.candidateSlot as Record<string, unknown>).kind = "management"; },
    "Kimi previous slot": (legacy) => { legacy.previousSlot = { version: 1, kind: "kimi-code", id: "v1:kimi-code:10000000-0000-4000-8000-000000000009" }; },
    "extra key": (legacy) => { legacy.future = true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const fixture = await activationFixture({ crashAfter: "journal-written" });
      await assert.rejects(fixture.activate());
      const [transactionId] = await journalDirectories(fixture.appHome);
      assert.ok(transactionId);
      const manifestPath = join(fixture.appHome, "provider-activation", transactionId, "manifest.json");
      const v2 = JSON.parse(await readFile(manifestPath, "utf8")) as ProviderActivationJournalV2;
      const legacy: Record<string, unknown> = {
        version: 1,
        transactionId,
        expectedRevision: v2.expectedRevision,
        phase: v2.phase,
        backendId: "openrouter",
        candidateSlot: { version: 1, kind: "inference", id: v2.candidateSlot.id },
        previousSlot: v2.previousSlot,
        candidateConnectionId: v2.candidateConnectionId,
        candidateRoute: structuredClone(v2.candidateRoute),
        expectedProviderSetupSha256: v2.expectedProviderSetupSha256,
        candidateProviderSetupSha256: v2.candidateProviderSetupSha256,
      };
      mutate(legacy);
      const configBefore = await readFile(fixture.path, "utf8");
      const slotsBefore = new Map(fixture.credentials.slots);
      await writeFile(manifestPath, `${JSON.stringify(legacy)}\n`, "utf8");

      await assert.rejects(fixture.restartAndRecover(false));

      assert.equal(await readFile(fixture.path, "utf8"), configBefore);
      assert.deepEqual(fixture.credentials.slots, slotsBefore);
    });
  }
});

test("strict manifest carries only lowercase complete-state SHA-256 snapshots", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  const [transactionId] = await journalDirectories(fixture.appHome);
  assert.ok(transactionId);
  const parsed = JSON.parse(await readFile(
    join(fixture.appHome, "provider-activation", transactionId, "manifest.json"),
    "utf8",
  )) as Record<string, unknown>;

  assert.match(String(parsed.expectedProviderSetupSha256), /^[0-9a-f]{64}$/);
  assert.match(String(parsed.candidateProviderSetupSha256), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /provider-secret|creator_user_id|raw-account|\/Users\/|\\Users\\/i,
  );
});

test("coordinator dependency failures expose only fixed redacted errors", async () => {
  const rawLeak = "/Users/private/provider-secret creator_user_id raw-provider-body";
  const reserveFixture = await activationFixture();
  reserveFixture.credentials.reserveSlot = () => {
    throw new Error(rawLeak);
  };
  const reserveError = await reserveFixture.activate().catch((error: unknown) => error);
  assert.ok(reserveError instanceof reserveFixture.api.ProviderActivationError);
  assert.doesNotMatch(String(reserveError), /Users|provider-secret|creator_user_id|raw-provider-body/i);
  assert.equal("cause" in (reserveError as object), false);

  const journalFixture = await activationFixture();
  journalFixture.privateStore.writeClaimManifest = async () => {
    throw new Error(rawLeak);
  };
  const journalError = await journalFixture.activate().catch((error: unknown) => error);
  assert.ok(journalError instanceof journalFixture.api.ProviderActivationError);
  assert.doesNotMatch(String(journalError), /Users|provider-secret|creator_user_id|raw-provider-body/i);
  assert.equal("cause" in (journalError as object), false);

  const runtimeFixture = await activationFixture();
  runtimeFixture.adapter.activateFailure = "before";
  const runtimeError = await runtimeFixture.coordinator().activate({
    ...runtimeFixture.request,
    persistence: "process-only",
  }).catch((error: unknown) => error);
  assert.ok(runtimeError instanceof runtimeFixture.api.ProviderActivationError);
  assert.doesNotMatch(String(runtimeError), /secret-marker|raw-provider|provider-secret/i);
  assert.equal("cause" in (runtimeError as object), false);
});

test("a sole pending journal is recovered before a new activation may reserve or overwrite", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  fixture.setNow(20_000);
  const callsBefore = fixture.credentials.calls.filter((call) => call === "reserveSlot").length;
  fixture.restart();
  await fixture.coordinator().activate(fixture.request);
  assert.equal(fixture.credentials.calls.filter((call) => call === "reserveSlot").length, callsBefore + 1);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("a committed verification-pending journal blocks a second activation before every new effect", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  fixture.restart();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);
  const beforeJournals = await journalDirectories(fixture.appHome);
  const beforeReserveCount = fixture.credentials.calls.filter((call) => call === "reserveSlot").length;
  const beforeRuntimeSecret = fixture.adapter.runtimeSecret;

  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      expectedRevision: fixture.oldState.revision + 1,
    }),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.deepEqual(await journalDirectories(fixture.appHome), beforeJournals);
  assert.equal(
    fixture.credentials.calls.filter((call) => call === "reserveSlot").length,
    beforeReserveCount,
  );
  assert.equal(fixture.adapter.runtimeSecret, beforeRuntimeSecret);
});

test("malformed journal fails closed with no credential config runtime or artifact cleanup", async () => {
  const fixture = await activationFixture();
  const transactionId = "20000000-0000-4000-8000-000000000001";
  const directory = join(fixture.appHome, "provider-activation", transactionId);
  await fixture.privateStore.writeTextAtomic(
    join(directory, "manifest.json"),
    JSON.stringify({ version: 1, transactionId, phase: "prepared", extra: NEW_SECRET }),
  );
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);
  await assert.rejects(fixture.recover(), fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
  assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
});

test("journal validation rejects recursive extras and invalid digest fields without cleanup", async () => {
  const cases = [
    {
      name: "candidate route secret extra",
      includeDigests: true,
      mutate: (manifest: Record<string, any>) => {
        manifest.candidateRoute.secret = NEW_SECRET;
      },
    },
    {
      name: "candidate slot creator extra",
      includeDigests: true,
      mutate: (manifest: Record<string, any>) => {
        manifest.candidateSlot.creator_user_id = "raw-account-id";
      },
    },
    {
      name: "previous slot extra",
      includeDigests: true,
      mutate: (manifest: Record<string, any>) => {
        manifest.previousSlot.secret = OLD_SECRET;
      },
    },
    {
      name: "bad old digest",
      includeDigests: true,
      mutate: (manifest: Record<string, any>) => {
        manifest.expectedProviderSetupSha256 = "ABC";
      },
    },
    {
      name: "bad candidate digest",
      includeDigests: true,
      mutate: (manifest: Record<string, any>) => {
        manifest.candidateProviderSetupSha256 = "not-a-sha256";
      },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const fixture = await activationFixture();
    const transactionId = `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const manifest: Record<string, any> = {
      version: 1,
      transactionId,
      expectedRevision: fixture.oldState.revision,
      phase: "prepared",
      backendId: "openrouter",
      candidateSlot: {
        version: 1,
        kind: "inference",
        id: NEW_SLOT_ID,
      },
      previousSlot: OLD_SLOT,
      candidateConnectionId: CONNECTION_ID,
      candidateRoute: newRoute(),
    };
    if (entry.includeDigests) {
      manifest.expectedProviderSetupSha256 = "1".repeat(64);
      manifest.candidateProviderSetupSha256 = "2".repeat(64);
    }
    manifest.candidateSlot = structuredClone(manifest.candidateSlot);
    manifest.previousSlot = structuredClone(manifest.previousSlot);
    manifest.candidateRoute = structuredClone(manifest.candidateRoute);
    entry.mutate(manifest);
    await fixture.privateStore.writeTextAtomic(
      join(fixture.appHome, "provider-activation", transactionId, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    const beforeSlots = new Map(fixture.credentials.slots);

    await assert.rejects(
      fixture.recover(),
      fixture.api.ProviderActivationRecoveryRequiredError,
      entry.name,
    );

    assert.deepEqual(fixture.credentials.slots, beforeSlots, entry.name);
    assert.equal((await journalDirectories(fixture.appHome)).length, 1, entry.name);
  }
});

test("journal field lengths are bounded before state or credential cleanup", async () => {
  const fixture = await activationFixture();
  const transactionId = "71000000-0000-4000-8000-000000000010";
  await fixture.privateStore.writeTextAtomic(
    join(fixture.appHome, "provider-activation", transactionId, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      transactionId,
      expectedRevision: fixture.oldState.revision,
      phase: "prepared",
      backendId: "openrouter",
      candidateSlot: { version: 1, kind: "inference", id: NEW_SLOT_ID },
      previousSlot: OLD_SLOT,
      candidateConnectionId: "x".repeat(4_096),
      candidateRoute: newRoute(),
      expectedProviderSetupSha256: TEST_OLD_STATE_SHA256,
      candidateProviderSetupSha256: TEST_CANDIDATE_STATE_SHA256,
    })}\n`,
  );

  await assert.rejects(fixture.recover(), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery old pointer plus exact owned candidate deletes only candidate v1 and journal", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  assert.equal(fixture.credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  await fixture.restartAndRecover(false);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(FOREIGN_SLOT.id), FOREIGN_SECRET);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("recovery same revision with a different old slot is ambiguous and retains every artifact", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.connections[0]!.credentialBinding = {
    kind: "orcode-keychain",
    pointer: FOREIGN_SLOT.id,
  };
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery rejects a complete same-revision old providerSetup snapshot mismatch", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.lifecycle = "cancelled";
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery rejects a complete committed candidate providerSetup snapshot mismatch", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.lifecycle = "cancelled";
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.restartAndRecover(true),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("swapped real transaction directory with extra file survives recovery unchanged", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  const [transactionId] = await journalDirectories(fixture.appHome);
  assert.ok(transactionId);
  const transactionPath = join(fixture.appHome, "provider-activation", transactionId);
  const moved = `${transactionPath}.owned-before-swap`;
  const manifest = await readFile(join(transactionPath, "manifest.json"), "utf8");
  await rename(transactionPath, moved);
  await mkdir(transactionPath);
  await writeFile(join(transactionPath, "manifest.json"), manifest);
  await writeFile(join(transactionPath, "foreign.txt"), "foreign survives");

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.equal(await readFile(join(transactionPath, "foreign.txt"), "utf8"), "foreign survives");
  assert.equal(await readFile(join(moved, "manifest.json"), "utf8"), manifest);
});

test("symlinked transaction directory is rejected and its target survives recovery", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  const [transactionId] = await journalDirectories(fixture.appHome);
  assert.ok(transactionId);
  const transactionPath = join(fixture.appHome, "provider-activation", transactionId);
  const moved = `${transactionPath}.owned-before-link`;
  await rename(transactionPath, moved);
  await symlink(moved, transactionPath, "dir");
  const manifest = await readFile(join(moved, "manifest.json"), "utf8");

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.equal(await readFile(join(moved, "manifest.json"), "utf8"), manifest);
});

test("strict recovery rejects a management candidate slot without deleting it", async () => {
  const fixture = await activationFixture();
  const transactionId = "70000000-0000-4000-8000-000000000002";
  const managementSlot: CredentialSlotRef = Object.freeze({
    version: 1,
    kind: "management",
    id: "v1:management:70000000-0000-4000-8000-000000000003",
  });
  fixture.credentials.slots.set(managementSlot.id, FOREIGN_SECRET);
  await fixture.privateStore.writeTextAtomic(
    join(fixture.appHome, "provider-activation", transactionId, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      transactionId,
      expectedRevision: fixture.oldState.revision,
      phase: "credential-staged",
      backendId: "openrouter",
      candidateSlot: managementSlot,
      previousSlot: OLD_SLOT,
      candidateConnectionId: CONNECTION_ID,
      candidateRoute: newRoute(),
      expectedProviderSetupSha256: TEST_OLD_STATE_SHA256,
      candidateProviderSetupSha256: TEST_CANDIDATE_STATE_SHA256,
    })}\n`,
  );
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(fixture.recover(), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery old pointer plus absent candidate removes only the exact prepared journal", async () => {
  const fixture = await activationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  await fixture.restartAndRecover(false);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal(fixture.credentials.slots.get(FOREIGN_SLOT.id), FOREIGN_SECRET);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("recovery exact candidate pointer with absent slot retains old slot and journal as required", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  fixture.credentials.slots.delete(NEW_SLOT_ID);
  await assert.rejects(fixture.restartAndRecover(true), fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(fixture.credentials.slots.get(OLD_SLOT.id), OLD_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery compares exact connection slot fingerprint and route not same-account same-model alone", async () => {
  const fixture = await activationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.connections[0]!.credentialBinding = {
    kind: "orcode-keychain",
    pointer: FOREIGN_SLOT.id,
  };
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(fixture.restartAndRecover(true), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery advanced revision retains journal candidate active and foreign slots", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as {
    providerSetup: ProviderSetupStateV3;
  };
  raw.providerSetup.revision = fixture.oldState.revision + 2;
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(fixture.restartAndRecover(false), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery future provider state performs zero journal or credential cleanup", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  const raw = JSON.parse(await readFile(fixture.path, "utf8")) as Record<string, unknown>;
  raw.providerSetup = { schemaVersion: 99 };
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(fixture.restartAndRecover(false), fixture.api.ProviderActivationRecoveryRequiredError);

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("recovery unreadable config path performs zero journal or credential cleanup", async () => {
  const fixture = await activationFixture({ crashAfter: "slot-readback" });
  await assert.rejects(fixture.activate());
  const hiddenConfig = `${fixture.path}.hidden`;
  await rename(fixture.path, hiddenConfig);
  await mkdir(fixture.path);
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
});

test("a live strict owner lease fails boundedly before reserve journal config or runtime mutation", async () => {
  const fixture = await activationFixture({ now: 100 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const leasePath = join(fixture.appHome, "provider-setup.lock");
  const claim = await store.createDirectoryExclusive(leasePath);
  assert.ok(claim);
  const owner = '{"version":1,"ownerId":"60000000-0000-4000-8000-000000000001","acquiredAt":100,"expiresAt":200}\n';
  await store.writeClaimOwner(claim, owner);

  await assert.rejects(fixture.activate(), /busy|lease|activation/i);

  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.equal(fixture.adapter.runtimeSecret, OLD_SECRET);
  assert.equal(await store.readClaimOwner(claim), owner);
});

test("an abort-ignoring live lease wait settles at deadline and releases the runtime guard", async () => {
  const fixture = await activationFixture({ now: 100 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const leasePath = join(fixture.appHome, "provider-setup.lock");
  const claim = await store.createDirectoryExclusive(leasePath);
  assert.ok(claim);
  const owner = '{"version":1,"ownerId":"60000000-0000-4000-8000-000000000003","acquiredAt":100,"expiresAt":200}\n';
  await store.writeClaimOwner(claim, owner);
  const configBefore = await readFile(fixture.path, "utf8");
  const slotsBefore = new Map(fixture.credentials.slots);
  const activation = fixture.coordinatorWith({
    waitForLease: async () => new Promise<void>(() => undefined),
  }).activate({ ...fixture.request, deadlineAt: 120 });
  void activation.catch(() => undefined);
  const outcome = await Promise.race([
    activation.then(
      () => null,
      (error: unknown) => error,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 350)),
  ]);

  assert.ok(outcome, "provider lease wait must observe the activation deadline");
  assert.equal((outcome as { code?: unknown }).code, "provider-activation-deadline");
  assert.equal(fixture.runtimeGuard.releaseCalls, 1);
  assert.equal(await readFile(fixture.path, "utf8"), configBefore);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.equal(await store.readClaimOwner(claim), owner);
});

test("a stale strict owner lease is reclaimed by exact token before activation", async () => {
  const fixture = await activationFixture({ now: 500 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const leasePath = join(fixture.appHome, "provider-setup.lock");
  const claim = await store.createDirectoryExclusive(leasePath);
  assert.ok(claim);
  const owner = '{"version":1,"ownerId":"60000000-0000-4000-8000-000000000002","acquiredAt":100,"expiresAt":200}\n';
  await store.writeClaimOwner(claim, owner);

  const result = await fixture.activate();

  assert.equal(result.persisted, true);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
});

test("malformed or ambiguous lease owner fails closed and retains the exact claim", async () => {
  const fixture = await activationFixture({ now: 500 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const leasePath = join(fixture.appHome, "provider-setup.lock");
  const claim = await store.createDirectoryExclusive(leasePath);
  assert.ok(claim);
  const malformed = '{"version":1,"ownerId":"not-a-uuid","acquiredAt":100,"expiresAt":200,"extra":true}\n';
  await store.writeClaimOwner(claim, malformed);

  await assert.rejects(fixture.activate(), /lease|owner|recovery|activation/i);

  assert.equal(await store.readClaimOwner(claim), malformed);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("an ownerless fresh crash claim fails closed without polling sleeps or path cleanup", async () => {
  const fixture = await activationFixture({ now: 100 });
  const store = fixture.privateStore as unknown as TokenBoundPrivateStore;
  const leasePath = join(fixture.appHome, "provider-setup.lock");
  const claim = await store.createDirectoryExclusive(leasePath);
  assert.ok(claim);

  await assert.rejects(fixture.activate(), /lease|owner|activation/i);

  await store.assertDirectoryClaim(claim);
  assert.deepEqual(await readdir(leasePath), []);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("a paused expired owner is fenced after a newer activation reclaims the lease", async () => {
  const fixture = await activationFixture({ now: 100 });
  let now = 100;
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  const coordinatorA = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 10,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
    onBoundary: async (boundary: Boundary) => {
      if (boundary === "journal-written") {
        reached();
        await resumePromise;
      }
    },
  });
  const activationA = coordinatorA.activate(fixture.request);
  await paused;
  const callsAtPause = fixture.credentials.calls.length;
  now = 1_000;
  const guardB = new FakeRuntimeGuard();
  const coordinatorB = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: guardB,
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  await coordinatorB.activate(fixture.request);
  const callsAfterB = fixture.credentials.calls.length;
  resume();

  await assert.rejects(activationA, /fence|lease|stale|activation/i);

  assert.equal(fixture.credentials.calls.length, callsAfterB, "fenced A must make no effect after B");
  assert.ok(callsAfterB > callsAtPause);
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(tuple.secret, NEW_SECRET);
});

for (const persistence of ["persisted", "process-only"] as const) {
  test(`an expired ${persistence} owner cannot mutate runtime after a newer owner prepares credential forget`, async () => {
    const fixture = await activationFixture({ now: 100 });
    let now = 100;
    let resumeA!: () => void;
    let reachedA!: () => void;
    const pausedA = new Promise<void>((resolve) => { reachedA = resolve; });
    const resumePromiseA = new Promise<void>((resolve) => { resumeA = resolve; });
    const coordinatorA = new fixture.api.ProviderActivationCoordinator({
      appHome: fixture.appHome,
      configPath: fixture.path,
      privateStore: fixture.privateStore,
      credentials: fixture.credentials,
      adapterResolver: () => fixture.adapter,
      stateStore: fixture.stateStore,
      runtimeGuard: fixture.runtimeGuard,
      now: () => now,
      createUuid: sequentialUuid(),
      leaseDurationMs: 10,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      onBoundary: async (boundary: Boundary) => {
        if (boundary === "models-loaded") {
          reachedA();
          await resumePromiseA;
        }
      },
    });
    const activationA = coordinatorA.activate({ ...fixture.request, persistence });
    await pausedA;

    now = 1_000;
    const adapterB = new FakeAdapter();
    const coordinatorB = new fixture.api.ProviderActivationCoordinator({
      appHome: fixture.appHome,
      configPath: fixture.path,
      privateStore: fixture.privateStore,
      credentials: fixture.credentials,
      adapterResolver: () => adapterB,
      stateStore: fixture.stateStore,
      runtimeGuard: new FakeRuntimeGuard(),
      now: () => now,
      createUuid: sequentialUuid(),
      leaseDurationMs: 100,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
    await coordinatorB.activate({ ...fixture.request, persistence: "process-only" });
    assert.equal(adapterB.calls.filter((call) => call === "activate").length, 1);

    const forgetClaim = await fixture.privateStore.createDirectoryExclusive(
      join(fixture.appHome, fixture.api.PROVIDER_CREDENTIAL_FORGET_DIRECTORY),
    );
    assert.ok(forgetClaim);
    await fixture.privateStore.writeClaimManifest(
      forgetClaim,
      `${JSON.stringify({
        version: 1,
        phase: "prepared",
        connectionId: CONNECTION_ID,
        target: { kind: "versioned", slot: OLD_SLOT },
      })}\n`,
      null,
    );
    const reservationsBeforeResume = fixture.credentials.calls.filter(
      (call) => call === "reserveSlot",
    ).length;

    resumeA();
    await assert.rejects(activationA, /fence|lease|recovery|activation/i);

    assert.equal(
      fixture.adapter.calls.filter((call) => call === "activate").length,
      0,
      "the expired owner must not begin a runtime bind",
    );
    assert.equal(
      fixture.credentials.calls.filter((call) => call === "reserveSlot").length,
      reservationsBeforeResume,
      "the persisted control must not begin a durable candidate mutation",
    );
    await fixture.privateStore.assertDirectoryClaim(forgetClaim);
  });
}

test("process-only activation reports the exact lost fence when ownership changes during runtime bind", async () => {
  const fixture = await activationFixture({ now: 100 });
  let now = 100;
  let resumeA!: () => void;
  let reachedA!: () => void;
  const pausedA = new Promise<void>((resolve) => { reachedA = resolve; });
  fixture.adapter.activateReached = reachedA;
  fixture.adapter.activatePause = new Promise<void>((resolve) => { resumeA = resolve; });
  const coordinatorA = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 10,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  const activationA = coordinatorA.activate({
    ...fixture.request,
    persistence: "process-only",
  });
  await pausedA;
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET, "the external bind effect already happened");

  now = 1_000;
  const adapterB = new FakeAdapter();
  const coordinatorB = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => adapterB,
    stateStore: fixture.stateStore,
    runtimeGuard: new FakeRuntimeGuard(),
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  await coordinatorB.activate({ ...fixture.request, persistence: "process-only" });
  resumeA();

  const error = await activationA.catch((reason: unknown) => reason);
  assert.ok(error instanceof fixture.api.ProviderActivationRecoveryRequiredError);
  assert.equal(error.code, "provider-lease-fence-lost");
  assert.equal(fixture.runtimeGuard.releaseCalls, 1);
});

test("deadline and abort release authority ownership and block late publication", async (t) => {
  await t.test("hung credential read releases the real coordinator for an immediate retry", async () => {
    const fixture = await activationFixture();
    const originalReadSlot = fixture.credentials.readSlot.bind(fixture.credentials);
    let firstRead = true;
    let reached!: () => void;
    const readReached = new Promise<void>((resolve) => { reached = resolve; });
    fixture.credentials.readSlot = async (slot) => {
      if (firstRead) {
        firstRead = false;
        reached();
        return new Promise<string | null>(() => undefined);
      }
      return originalReadSlot(slot);
    };
    const authority = new ProviderCredentialAuthority({
      stateStore: fixture.stateStore,
      credentials: fixture.credentials,
      environment: {},
      coordinator: () => fixture.coordinator(),
      now: () => 10_000,
    });
    const controller = new AbortController();
    const reason = new DOMException("fixed authority cancellation", "AbortError");
    const first = authority.withCredential({
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      credentialKind: "inference",
      purpose: "startup-inspect",
      environmentEligibility: "forbidden",
      deadlineAt: 15_000,
      signal: controller.signal,
    }, async () => "must-not-run");
    await readReached;
    controller.abort(reason);

    const firstSettlement = await Promise.race([
      first.then(
        () => "fulfilled" as const,
        (error: unknown) => error === reason ? "aborted" as const : "wrong-error" as const,
      ),
      new Promise<"still-held">((resolve) => setTimeout(() => resolve("still-held"), 100)),
    ]);
    assert.equal(firstSettlement, "aborted");

    const second = await authority.withCredential({
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      credentialKind: "inference",
      purpose: "startup-inspect",
      environmentEligibility: "forbidden",
      deadlineAt: 15_000,
      signal: new AbortController().signal,
    }, async (secret) => secret);
    assert.deepEqual(second, { kind: "available", value: OLD_SECRET });
  });

  await t.test("absolute deadline releases an abort-ignoring credential read", async () => {
    const fixture = await activationFixture();
    const originalReadSlot = fixture.credentials.readSlot.bind(fixture.credentials);
    let firstRead = true;
    let reached!: () => void;
    const readReached = new Promise<void>((resolve) => { reached = resolve; });
    fixture.credentials.readSlot = async (slot) => {
      if (firstRead) {
        firstRead = false;
        reached();
        return new Promise<string | null>(() => undefined);
      }
      return originalReadSlot(slot);
    };
    const authority = new ProviderCredentialAuthority({
      stateStore: fixture.stateStore,
      credentials: fixture.credentials,
      environment: {},
      coordinator: () => fixture.coordinator(),
      now: Date.now,
    });
    const deadlineAt = Date.now() + 2_000;
    const first = authority.withCredential({
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      credentialKind: "inference",
      purpose: "startup-inspect",
      environmentEligibility: "forbidden",
      deadlineAt,
      signal: new AbortController().signal,
    }, async () => "must-not-run");

    const readEntrance = await Promise.race([
      readReached.then(() => "reached" as const),
      first.then(
        () => "settled-before-read" as const,
        () => "settled-before-read" as const,
      ),
      new Promise<"read-watchdog">((resolve) =>
        setTimeout(() => resolve("read-watchdog"), 1_000)),
    ]);
    assert.equal(
      readEntrance,
      "reached",
      "the fixture must enter the abort-ignoring read before testing its deadline",
    );

    const firstSettlement = await Promise.race([
      first.then((result) => result.kind),
      new Promise<"still-held">((resolve) =>
        setTimeout(() => resolve("still-held"), Math.max(1, deadlineAt - Date.now()) + 1_000)),
    ]);
    assert.equal(firstSettlement, "stale");

    const second = await authority.withCredential({
      backendId: "openrouter",
      connectionId: CONNECTION_ID,
      credentialKind: "inference",
      purpose: "startup-inspect",
      environmentEligibility: "forbidden",
      deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    }, async (secret) => secret);
    assert.deepEqual(second, { kind: "available", value: OLD_SECRET });
  });

  await t.test("abort immediately before config publication cannot publish config or provider state", async () => {
    const fixture = await activationFixture();
    const beforeConfig = await readFile(fixture.path, "utf8");
    const beforeState = fixture.stateStore.read();
    const controller = new AbortController();
    const reason = new DOMException("fixed pre-publication cancellation", "AbortError");
    const coordinator = new fixture.api.ProviderActivationCoordinator({
      appHome: fixture.appHome,
      configPath: fixture.path,
      privateStore: fixture.privateStore,
      credentials: fixture.credentials,
      adapterResolver: () => fixture.adapter,
      stateStore: fixture.stateStore,
      runtimeGuard: fixture.runtimeGuard,
      now: () => 10_000,
      createUuid: sequentialUuid(),
      leaseDurationMs: 100,
      writeConfigAtomic: async (path: string, content: string, beforePublish?: () => Promise<void>) => {
        controller.abort(reason);
        await beforePublish?.();
        await writeFileAtomicSecure(path, content);
      },
    });

    await assert.rejects(coordinator.activate({ ...fixture.request, signal: controller.signal }));

    assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
    assert.deepEqual(fixture.stateStore.read(), beforeState);
    assert.deepEqual(fixture.adapter.runtimeRoute, oldRoute());
  });
});

test("first-run persisted activation cannot replace a config created at the final publication fence", async () => {
  const activationModule = await import("../src/provider-activation.js");
  const appHome = await mkdtemp(join(tmpdir(), "orcode-provider-first-activation-race-"));
  const path = join(appHome, "config.json");
  const credentials = new FakeCredentials(null);
  const adapter = new FakeAdapter();
  const runtimeGuard = new FakeRuntimeGuard();
  const initialState = structuredClone(DEFAULT_CONFIG.providerSetup) as ProviderSetupStateV3;
  const stateStore = new ProviderStateStore(initialState);
  const privateStore = new PrivateStore({ root: appHome });
  const beforeRuntime = structuredClone(adapter.runtimeRoute);
  let foreignRaw: string | null = null;
  let foreignIdentity: { dev: bigint; ino: bigint } | null = null;
  const createForeignAfterSnapshot = async (
    content: string,
    beforePublish?: () => Promise<void>,
  ) => {
    await beforePublish?.();
    foreignRaw = content;
    await writeFile(path, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const created = await lstat(path, { bigint: true });
    foreignIdentity = { dev: created.dev, ino: created.ino };
  };
  const coordinator = new activationModule.ProviderActivationCoordinator({
    appHome,
    configPath: path,
    privateStore,
    credentials,
    adapterResolver: () => adapter,
    stateStore,
    runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    writeConfigAtomic: (
      configPath: string,
      content: string,
      beforePublish?: () => Promise<void>,
      beforeRename?: () => void,
    ) => writeFileAtomicSecure(
      configPath,
      content,
      () => createForeignAfterSnapshot(content, beforePublish),
      beforeRename,
    ),
    writeConfigAtomicCreate: (
      configPath: string,
      content: string,
      beforePublish?: () => Promise<void>,
      beforeLink?: () => void,
    ) => writeFileAtomicCreateSecure(
      configPath,
      content,
      () => createForeignAfterSnapshot(content, beforePublish),
      beforeLink,
    ),
  });

  await assert.rejects(
    coordinator.activate({
      backendId: "openrouter",
      expectedRevision: initialState.revision,
      candidate: NEW_SECRET,
      expectedRequestedModelId: MODEL.requestedModelId,
      selectedCanonicalModelId: MODEL.canonicalModelId,
      generation: 1,
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      persistence: "persisted",
    }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "provider-config-commit-ambiguous"
    ),
  );

  assert.ok(foreignRaw);
  const expectedForeignIdentity = foreignIdentity as { dev: bigint; ino: bigint } | null;
  assert.ok(expectedForeignIdentity);
  assert.equal(await readFile(path, "utf8"), foreignRaw);
  const retained = await lstat(path, { bigint: true });
  assert.equal(retained.dev, expectedForeignIdentity.dev);
  assert.equal(retained.ino, expectedForeignIdentity.ino);
  assert.deepEqual(stateStore.read(), initialState);
  assert.deepEqual(adapter.runtimeRoute, beforeRuntime);
  assert.equal(adapter.calls.includes("activate"), false);
  assert.equal(credentials.slots.get(NEW_SLOT_ID), NEW_SECRET);
  assert.equal((await journalDirectories(appHome)).length, 1);
});

test("real activation writer abort microtask at the last async fence preserves the old tuple", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeState = fixture.stateStore.read();
  const beforeSlots = new Map(fixture.credentials.slots);
  const beforeRuntime = structuredClone(fixture.adapter.runtimeRoute);
  const controller = new AbortController();
  const reason = new DOMException("fixed activation rename abort", "AbortError");
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    writeConfigAtomic: (
      path: string,
      content: string,
      beforePublish?: () => Promise<void>,
      beforeRename?: () => void,
    ) => writeFileAtomicSecure(path, content, async () => {
      await beforePublish?.();
      queueMicrotask(() => controller.abort(reason));
    }, beforeRename),
  });

  await assert.rejects(
    coordinator.activate({ ...fixture.request, signal: controller.signal }),
  );

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.deepEqual(fixture.adapter.runtimeRoute, beforeRuntime);
  assert.deepEqual(
    await readdir(join(fixture.appHome, "provider-activation")).catch(() => []),
    [],
  );
});

test("real activation writer lease expiry microtask cannot rename after the last async fence", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeState = fixture.stateStore.read();
  const beforeRuntime = structuredClone(fixture.adapter.runtimeRoute);
  let now = 10_000;
  let stagedSlots: Map<string, string> | null = null;
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => now,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    writeConfigAtomic: (
      path: string,
      content: string,
      beforePublish?: () => Promise<void>,
      beforeRename?: () => void,
    ) => writeFileAtomicSecure(path, content, async () => {
      await beforePublish?.();
      stagedSlots = new Map(fixture.credentials.slots);
      queueMicrotask(() => { now = 10_100; });
    }, beforeRename),
  });

  await assert.rejects(coordinator.activate(fixture.request));

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.adapter.runtimeRoute, beforeRuntime);
  assert.ok(stagedSlots);
  assert.deepEqual(fixture.credentials.slots, stagedSlots);
  assert.equal(
    (await readdir(join(fixture.appHome, "provider-activation"))).length,
    1,
  );
});

test("persisted saved candidate permit validates under existing real config ownership and commits one exact tuple", async () => {
  const failures: Array<{ source: "saved" | "environment"; message: string }> = [];
  const cli = await import("../src/cli.js");

  for (const source of ["saved", "environment"] as const) {
    try {
      const fixture = await activationFixture({ oldSlot: source === "saved" ? OLD_SLOT : null });
      const stateStore = new ProviderStateStore(fixture.oldState, {
        persist: (request) => cli.persistProviderSetupState(fixture.path, request),
      });
      const environment: Record<string, string | undefined> = source === "environment"
        ? { OPENROUTER_API_KEY: NEW_SECRET }
        : {};
      if (source === "saved") fixture.credentials.slots.set(OLD_SLOT.id, NEW_SECRET);
      let coordinator!: InstanceType<typeof fixture.api.ProviderActivationCoordinator>;
      const authority = new ProviderCredentialAuthority({
        stateStore,
        credentials: fixture.credentials,
        environment,
        coordinator: () => coordinator,
        now: () => 10_000,
      });
      coordinator = new fixture.api.ProviderActivationCoordinator({
        appHome: fixture.appHome,
        configPath: fixture.path,
        privateStore: fixture.privateStore,
        credentials: fixture.credentials,
        adapterResolver: () => fixture.adapter,
        stateStore,
        runtimeGuard: fixture.runtimeGuard,
        candidateAuthority: authority,
        now: () => 10_000,
        createUuid: sequentialUuid(),
        leaseDurationMs: 100,
      });

      let candidate = NEW_SECRET;
      let permit = authority.environmentCandidatePermit(candidate);
      if (source === "saved") {
        const access = await authority.withCredential({
          backendId: "openrouter",
          connectionId: CONNECTION_ID,
          credentialKind: "inference",
          purpose: "explicit-repair",
          environmentEligibility: "forbidden",
          deadlineAt: fixture.request.deadlineAt,
          signal: new AbortController().signal,
        }, async (secret, context) => ({ secret, permit: context.candidatePermit }));
        assert.equal(access.kind, "available");
        if (access.kind !== "available") throw new Error("saved permit was unavailable");
        candidate = access.value.secret;
        permit = access.value.permit;
      }
      assert.ok(permit);

      const result = await coordinator.activate({
        ...fixture.request,
        expectedRevision: stateStore.read().revision,
        candidate,
        candidatePermit: permit,
        requireCandidatePermit: true,
      });
      const memory = stateStore.read();
      const disk = (JSON.parse(await readFile(fixture.path, "utf8")) as {
        providerSetup: ProviderSetupStateV3;
      }).providerSetup;
      const tuple = await tupleForState(memory, fixture.credentials);

      assert.deepEqual(disk, memory);
      assert.deepEqual(result.state, memory);
      assert.deepEqual(result.route, memory.defaultRoute);
      assert.deepEqual(fixture.adapter.runtimeRoute, memory.defaultRoute);
      assert.equal(
        tuple.connection === null ? tuple.slotId : requireKeychainCredentialPointer(tuple.connection),
        tuple.slotId,
      );
      assert.equal(tuple.secret, NEW_SECRET);
      assert.deepEqual(await journalDirectories(fixture.appHome), []);
    } catch (error) {
      failures.push({
        source,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  assert.deepEqual(failures, []);
});

test("saved candidate swap after catalog and model choice has zero activation effects", async () => {
  const fixture = await activationFixture();
  fixture.credentials.slots.set(OLD_SLOT.id, NEW_SECRET);
  let coordinator: InstanceType<typeof fixture.api.ProviderActivationCoordinator>;
  const authority = new ProviderCredentialAuthority({
    stateStore: fixture.stateStore,
    credentials: fixture.credentials,
    environment: {},
    coordinator: () => coordinator,
    now: () => 10_000,
  });
  coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    candidateAuthority: authority,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeState = fixture.stateStore.read();
  const beforeRuntime = structuredClone(fixture.adapter.runtimeRoute);
  let callsAfterCatalog: string[] = [];
  let slotsAfterSwap = new Map<string, string>();

  const access = await authority.withCredential({
    backendId: "openrouter",
    connectionId: CONNECTION_ID,
    credentialKind: "inference",
    purpose: "explicit-repair",
    environmentEligibility: "forbidden",
    deadlineAt: fixture.request.deadlineAt,
    signal: new AbortController().signal,
  }, async (candidate, context) => {
    const catalog = await authority.withCandidateAuthority({
      deadlineAt: fixture.request.deadlineAt,
      signal: new AbortController().signal,
      credentialPermit: context.candidatePermit,
      requireCredentialPermit: true,
    }, async (lease) => {
      const connected = await fixture.adapter.connect({
        candidate,
        generation: 4,
        signal: new AbortController().signal,
      });
      await lease.assertCurrent();
      await fixture.adapter.listModels({
        candidateId: connected.candidateId,
        signal: new AbortController().signal,
      });
      await lease.assertCurrent();
      return connected.candidateId;
    });
    assert.equal(catalog.kind, "ready");
    callsAfterCatalog = [...fixture.adapter.calls];
    fixture.credentials.slots.set(OLD_SLOT.id, FOREIGN_SECRET);
    slotsAfterSwap = new Map(fixture.credentials.slots);
    return coordinator.activate({
      ...fixture.request,
      candidate,
      candidatePermit: context.candidatePermit,
      requireCandidatePermit: true,
    });
  });

  assert.notEqual(access.kind, "available");
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.adapter.runtimeRoute, beforeRuntime);
  assert.deepEqual(fixture.adapter.calls, callsAfterCatalog);
  assert.deepEqual(fixture.credentials.slots, slotsAfterSwap);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.deepEqual(
    await readdir(join(fixture.appHome, "provider-activation")).catch(() => []),
    [],
  );
});

test("environment candidate swap after catalog and model choice has zero activation effects", async () => {
  const fixture = await activationFixture({ oldSlot: null });
  const environment: Record<string, string | undefined> = {
    OPENROUTER_API_KEY: NEW_SECRET,
  };
  let coordinator: InstanceType<typeof fixture.api.ProviderActivationCoordinator>;
  const authority = new ProviderCredentialAuthority({
    stateStore: fixture.stateStore,
    credentials: fixture.credentials,
    environment,
    coordinator: () => coordinator,
    now: () => 10_000,
  });
  coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    candidateAuthority: authority,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });
  const permit = authority.environmentCandidatePermit(NEW_SECRET);
  assert.ok(permit);
  const catalog = await authority.withCandidateAuthority({
    deadlineAt: fixture.request.deadlineAt,
    signal: new AbortController().signal,
    credentialPermit: permit,
    requireCredentialPermit: true,
  }, async (lease) => {
    const connected = await fixture.adapter.connect({
      candidate: NEW_SECRET,
      generation: 4,
      signal: new AbortController().signal,
    });
    await lease.assertCurrent();
    await fixture.adapter.listModels({
      candidateId: connected.candidateId,
      signal: new AbortController().signal,
    });
    await lease.assertCurrent();
    return connected.candidateId;
  });
  assert.equal(catalog.kind, "ready");
  const callsAfterCatalog = [...fixture.adapter.calls];
  environment.OPENROUTER_API_KEY = FOREIGN_SECRET;
  const beforeConfig = await readFile(fixture.path, "utf8");
  const beforeState = fixture.stateStore.read();
  const beforeSlots = new Map(fixture.credentials.slots);
  const beforeRuntime = structuredClone(fixture.adapter.runtimeRoute);

  await assert.rejects(coordinator.activate({
    ...fixture.request,
    candidatePermit: permit,
    requireCandidatePermit: true,
  }));

  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.adapter.runtimeRoute, beforeRuntime);
  assert.deepEqual(fixture.adapter.calls, callsAfterCatalog);
  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.deepEqual(
    await readdir(join(fixture.appHome, "provider-activation")).catch(() => []),
    [],
  );
});

test("targeted replacement rejects duplicate account realm identity in both connection orders", async (t) => {
  for (const order of ["retained-first", "target-first"] as const) {
    await t.test(order, async () => {
      const fixture = await activationFixture();
      const target = fixture.oldState.connections[0]!;
      const retained = {
        ...structuredClone(target),
        id: "connection-openrouter-retained",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: FOREIGN_SLOT.id },
        accountFingerprint: NEW_FINGERPRINT,
      };
      const twoConnectionState: ProviderSetupStateV3 = {
        ...fixture.oldState,
        connections: order === "retained-first"
          ? [retained, target]
          : [target, retained],
      };
      const authoritativeState = fixture.stateStore.replace(
        twoConnectionState,
        fixture.oldState.revision,
      );
      await writeFile(
        fixture.path,
        `${JSON.stringify({
          ...fixture.initialConfig,
          providerSetup: authoritativeState,
        }, null, 2)}\n`,
        "utf8",
      );
      fixture.credentials.calls.length = 0;
      fixture.adapter.calls.length = 0;
      const beforeConfig = await readFile(fixture.path, "utf8");
      const beforeState = fixture.stateStore.read();
      const beforeSlots = new Map(fixture.credentials.slots);
      const beforeRuntime = structuredClone(fixture.adapter.runtimeRoute);

      await assert.rejects(
        fixture.coordinator().activate({
          ...fixture.request,
          expectedRevision: authoritativeState.revision,
          targetConnectionId: CONNECTION_ID,
        }),
        (error: unknown) => (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "provider-connection-identity-collision"
        ),
      );

      assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
      assert.deepEqual(fixture.stateStore.read(), beforeState);
      assert.deepEqual(fixture.credentials.slots, beforeSlots);
      assert.deepEqual(fixture.adapter.runtimeRoute, beforeRuntime);
      assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
      assert.deepEqual(fixture.adapter.calls, ["connect", "discardCandidate"]);
    });
  }
});

function kimiActivationRoute(
  modelId: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed" = "kimi-for-coding",
): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: KIMI_FINGERPRINT,
    billingRealm: KIMI_REALM,
    requestedModelId: modelId,
    canonicalModelId: modelId,
    resolutionState: "resolved",
  };
}

function kimiActivationState(
  modelId?: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed",
): ProviderSetupStateV3 {
  return {
    schemaVersion: 3,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: KIMI_CONNECTION_ID,
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: KIMI_OLD_SLOT.id },
      accountFingerprint: KIMI_FINGERPRINT,
      accountFingerprintState: "verified",
      billingRealm: KIMI_REALM,
      lastHealth: null,
    }],
    defaultRoute: kimiActivationRoute(modelId),
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function providerState(
  oldSlot: CredentialSlotRef | "legacy:inference" | null,
): ProviderSetupStateV3 {
  if (oldSlot === null) {
    return {
      schemaVersion: 3,
      revision: 3,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
  }
  const credentialPointer = typeof oldSlot === "string" ? oldSlot : oldSlot.id;
  return {
    schemaVersion: 3,
    revision: 3,
    lifecycle: oldSlot === "legacy:inference" ? "migrated" : "configured",
    connections: [{
      id: CONNECTION_ID,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: credentialPointer },
      accountFingerprint: oldSlot === "legacy:inference"
        ? `acct_legacy_${CONNECTION_ID}`
        : OLD_FINGERPRINT,
      accountFingerprintState: oldSlot === "legacy:inference" ? "provisional" : "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: oldSlot === "legacy:inference"
      ? {
        ...oldRoute(),
        accountFingerprint: `acct_legacy_${CONNECTION_ID}`,
        canonicalModelId: null,
        resolutionState: "legacy-unverified",
      }
      : oldRoute(),
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function oldRoute(): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: OLD_FINGERPRINT,
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/old-requested",
    canonicalModelId: "openai/old-canonical",
    resolutionState: "resolved",
  };
}

function newRoute(): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: NEW_FINGERPRINT,
    billingRealm: "openrouter-payg",
    requestedModelId: MODEL.requestedModelId,
    canonicalModelId: MODEL.canonicalModelId,
    resolutionState: "resolved",
  };
}

function healthy(generation: number): ProviderHealth {
  return {
    credential: "valid",
    connectivity: "connected",
    spend: "available",
    runtime: "not-applicable",
    observedAt: 1_000,
    generation,
  };
}

async function readTuple(path: string, credentials: FakeCredentials) {
  const loaded = await loadConfigDetailed(path);
  return tupleForState(loaded.config.providerSetup as ProviderSetupStateV3, credentials);
}

async function tupleForState(state: ProviderSetupStateV3, credentials: FakeCredentials) {
  const connection = state.connections.find((entry) => entry.enabled) ?? null;
  const slotId = connection === null ? null : requireKeychainCredentialPointer(connection);
  const secret = slotId === "legacy:inference"
    ? credentials.legacy.get("inference") ?? null
    : slotId
      ? credentials.slots.get(slotId) ?? null
      : null;
  return { state, connection, slotId, secret };
}

async function journalDirectories(appHome: string): Promise<string[]> {
  try {
    return (await readdir(join(appHome, "provider-activation"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function fileTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full, relative);
      else result[relative] = await readFile(full, "utf8");
    }
  }
  await visit(root, "");
  return result;
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function maskProviderSetup(raw: string): string {
  const key = '"providerSetup"';
  const keyIndex = raw.indexOf(key);
  assert.notEqual(keyIndex, -1);
  const colon = raw.indexOf(":", keyIndex + key.length);
  assert.notEqual(colon, -1);
  let start = colon + 1;
  while (/\s/.test(raw[start] ?? "")) start += 1;
  assert.equal(raw[start], "{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = start;
  for (; end < raw.length; end += 1) {
    const char = raw[end]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  assert.equal(depth, 0);
  return `${raw.slice(0, start)}<providerSetup>${raw.slice(end)}`;
}

function sequentialUuid(): () => string {
  let value = 40;
  return () => `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

type TokenBoundPrivateStore = PrivateStore & {
  writeClaimOwner(claim: object, content: string): Promise<void>;
  readClaimOwner(claim: object, maxBytes?: number): Promise<string>;
  assertDirectoryClaim(claim: object): Promise<void>;
};

test("activation journal v2 carries an exact Kimi backend and Kimi credential slot kind", () => {
  const journal: ProviderActivationJournalV2 = {
    version: 2,
    transactionId: "10000000-0000-4000-8000-000000000001",
    expectedRevision: 4,
    phase: "prepared",
    backendId: "kimi-code",
    credentialSlotKind: "kimi-code",
    candidateSlot: { version: 1, kind: "kimi-code", id: "v1:kimi-code:10000000-0000-4000-8000-000000000001" },
    previousSlot: null,
    candidateConnectionId: "kimi-main",
    candidateRoute: {
      version: 1,
      backendId: "kimi-code",
      accountFingerprint: "acct_local_kimi",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      requestedModelId: "kimi-for-coding",
      canonicalModelId: "kimi-for-coding",
      resolutionState: "resolved",
    },
    expectedProviderSetupSha256: "1".repeat(64),
    candidateProviderSetupSha256: "2".repeat(64),
  };
  assert.equal(journal.credentialSlotKind, journal.backendId);
});

test("activation pins one verified adapter instance for the entire transaction", async () => {
  const fixture = await activationFixture();
  const first = new FakeAdapter();
  const second = new FakeAdapter();
  let resolverCalls = 0;
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => {
      resolverCalls += 1;
      return resolverCalls === 1 ? first : second;
    },
    stateStore: fixture.stateStore,
    runtimeGuard: fixture.runtimeGuard,
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
    waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
  });

  const result = await coordinator.activate(fixture.request);

  assert.equal(result.persisted, true);
  assert.equal(resolverCalls, 1);
  assert.deepEqual(second.calls, []);
});

test("activation deadline settles despite a runtime guard that ignores its signal and publishes nothing", async () => {
  const fixture = await activationFixture();
  const beforeConfig = await readFile(fixture.path, "utf8");
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: {
      acquire: async () => new Promise<RuntimeLease>(() => undefined),
    },
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });

  const started = Date.now();
  await assert.rejects(
    coordinator.activate({ ...fixture.request, deadlineAt: 10_020 }),
    (error: unknown) => typeof error === "object" && error !== null
      && "code" in error && error.code === "provider-activation-deadline",
  );

  assert.ok(Date.now() - started < 500, "deadline must bound an abort-ignoring runtime acquire");
  assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("late runtime-guard acquisition after deadline is released and never begins activation", async () => {
  const fixture = await activationFixture();
  let resolveLateLease!: (lease: RuntimeLease) => void;
  let releases = 0;
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapterResolver: () => fixture.adapter,
    stateStore: fixture.stateStore,
    runtimeGuard: {
      acquire: async () => new Promise<RuntimeLease>((resolve) => { resolveLateLease = resolve; }),
    },
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });

  await assert.rejects(coordinator.activate({ ...fixture.request, deadlineAt: 10_020 }));
  resolveLateLease({
    assertHeld() {},
    async release() { releases += 1; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(releases, 1);
  assert.equal(fixture.adapter.calls.length, 0);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
});

test("late slot write retains journal ownership until settlement and cannot orphan a credential", async () => {
  const fixture = await activationFixture();
  let releaseWrite!: () => void;
  let reachedWrite!: () => void;
  fixture.credentials.writePause = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { reachedWrite = resolve; });
  fixture.credentials.writeReached = reachedWrite;
  let settled = false;
  const activation = fixture.coordinator().activate({ ...fixture.request, deadlineAt: 10_200 })
    .finally(() => { settled = true; });
  void activation.catch(() => undefined);

  await writeStarted;
  await new Promise<void>((resolve) => setTimeout(resolve, 230));
  assert.equal(settled, false, "an irreversible slot write must remain owned through settlement");
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);

  releaseWrite();
  await assert.rejects(activation);
  assert.equal(fixture.credentials.slots.has(NEW_SLOT_ID), false);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
  assert.equal((await readTuple(fixture.path, fixture.credentials)).slotId, OLD_SLOT.id);
});

test("a stalled pre-readback config-written observer is ignored after deadline and cannot prevent tuple adoption", { timeout: 10_000 }, async () => {
  const fixture = await activationFixture();
  let observerReached!: () => void;
  const reached = new Promise<void>((resolve) => { observerReached = resolve; });
  const coordinator = fixture.coordinatorWith({
    onBoundary: async (boundary: Boundary) => {
      if (boundary !== "config-written") return;
      observerReached();
      await new Promise<void>(() => undefined);
    },
  });
  const started = Date.now();
  // The test is about detaching an observer AFTER durable config publication,
  // not finishing all precommit filesystem work within 200ms under suite load.
  const activation = coordinator.activate({ ...fixture.request, deadlineAt: 12_000 });
  await Promise.race([reached, activation.then(() => {
    throw new Error("Activation completed without reaching the config-written observer.");
  })]);
  const result = await activation;
  assert.ok(Date.now() - started >= 1_800, "the observer must be detached by the activation deadline");
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(result.persisted, true);
  assert.equal(tuple.secret, NEW_SECRET);
  assert.equal(tuple.state.revision, fixture.oldState.revision + 1);
  assert.equal(fixture.stateStore.read().revision, fixture.oldState.revision + 1);
  assert.equal(fixture.adapter.runtimeSecret, NEW_SECRET);
  assert.equal((await journalDirectories(fixture.appHome)).length, 0);
});

test("Kimi persisted activation writes and publishes one exact v2 Kimi tuple through a Kimi resolver", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-kimi-activation-"));
  const configPath = join(appHome, "config.json");
  const oldState = kimiActivationState();
  await saveConfig({ ...structuredClone(DEFAULT_CONFIG), providerSetup: oldState }, configPath);
  const credentials = new FakeCredentials(null);
  credentials.slots.set(KIMI_OLD_SLOT.id, OLD_SECRET);
  const adapter = new FakeKimiAdapter();
  const resolverArguments: string[] = [];
  const activationModule = await import("../src/provider-activation.js");
  const coordinator = new activationModule.ProviderActivationCoordinator({
    appHome,
    configPath,
    privateStore: new PrivateStore({ root: appHome }),
    credentials,
    adapterResolver: (backendId) => {
      resolverArguments.push(backendId);
      assert.equal(backendId, "kimi-code");
      return adapter;
    },
    stateStore: new ProviderStateStore(oldState),
    runtimeGuard: new FakeRuntimeGuard(),
    candidateAuthority: {
      async validateCandidatePermitUnderLease() { return { kind: "ready" as const }; },
      async validateCandidatePermitAgainstSnapshotUnderLease() { return { kind: "ready" as const }; },
    },
    now: () => 10_000,
    createUuid: sequentialUuid(),
    leaseDurationMs: 100,
  });

  const result = await coordinator.activate({
    backendId: "kimi-code",
    expectedRevision: oldState.revision,
    candidate: KIMI_SECRET,
    expectedRequestedModelId: KIMI_MODEL.requestedModelId,
    selectedCanonicalModelId: KIMI_MODEL.canonicalModelId,
    generation: 4,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
    environmentEligibility: "forbidden",
    targetConnectionId: KIMI_CONNECTION_ID,
    candidatePermit: KIMI_TEST_PERMIT,
    requireCandidatePermit: true,
    candidateAuthorityPurpose: "initial-setup",
  });

  assert.equal(result.persisted, true);
  assert.deepEqual(resolverArguments, ["kimi-code"]);
  assert.equal(result.route.backendId, "kimi-code");
  assert.equal(result.route.billingRealm, KIMI_REALM);
  assert.equal(
    requireKeychainCredentialPointer(result.state!.connections[0]!).startsWith("v1:kimi-code:"),
    true,
  );
  assert.equal(adapter.calls.includes("activate"), true);
  const loaded = await loadConfigDetailed(configPath);
  assert.equal((loaded.config.providerSetup as ProviderSetupStateV3).connections[0]?.backendId, "kimi-code");
});

test("Kimi initial and post-slot revalidation receive the exact activation deadline", async () => {
  const fixture = await kimiActivationFixture();
  const exactDeadline = 77_777;

  await fixture.coordinator().activate({
    ...fixture.request,
    deadlineAt: exactDeadline,
  });

  assert.deepEqual(fixture.adapter.deadlines, [exactDeadline, exactDeadline]);
});

test("Kimi activation without the mandatory manual permit fails before every adapter and mutation effect", async () => {
  const fixture = await kimiActivationFixture();
  const configBefore = await readFile(fixture.path, "utf8");
  const stateBefore = fixture.stateStore.read();
  const slotsBefore = new Map(fixture.credentials.slots);
  const request = { ...fixture.request } as Record<string, unknown>;
  delete request.candidatePermit;
  delete request.requireCandidatePermit;

  await assert.rejects(
    fixture.coordinator().activate(request as never),
    /candidate|permit|authority|stale/i,
  );

  assert.deepEqual(fixture.adapter.calls, []);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  assert.equal(await readFile(fixture.path, "utf8"), configBefore);
  assert.deepEqual(fixture.stateStore.read(), stateBefore);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
  assert.equal(fixture.runtimeGuard.acquisitions, 0);
});

test("retained Kimi activation rejects an unbranded preference port before resolver, adapter, or mutation effects", async () => {
  const fixture = await kimiActivationFixture();
  const configBefore = await readFile(fixture.path, "utf8");
  const stateBefore = fixture.stateStore.read();
  const slotsBefore = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      candidateAuthorityPurpose: "retained-model-preference",
      persistBeforeProviderConfigCommit: Object.freeze({ version: 1 }) as never,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "provider-preference-port-invalid",
  );

  assert.deepEqual(fixture.resolverArguments, []);
  assert.deepEqual(fixture.adapter.calls, []);
  assert.deepEqual(fixture.credentials.calls, []);
  assert.equal(fixture.runtimeGuard.acquisitions, 0);
  assert.equal(await readFile(fixture.path, "utf8"), configBefore);
  assert.deepEqual(fixture.stateStore.read(), stateBefore);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.deepEqual(await journalDirectories(fixture.appHome), []);
});

test("retained Kimi activation requires persisted, environment-forbidden, exact-target publication", async (t) => {
  const invalid: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["process-only", { persistence: "process-only" }],
    ["environment eligible", { environmentEligibility: "automatic-if-no-saved" }],
    ["missing exact target", { targetConnectionId: "" }],
    ["persistence downgrade callback", {
      onPersistenceFailure: async () => "process-only" as const,
    }],
  ];
  for (const [name, mutation] of invalid) {
    await t.test(name, async (t) => {
      const fixture = await kimiActivationFixture();
      t.after(() => rm(fixture.appHome, { recursive: true, force: true }));
      const preferencePort = createProviderPreferenceCommitPort({
        persist: async () => { throw new Error("invalid retained request must not publish"); },
        abortAndReconcile: async () => { throw new Error("invalid retained request must not reconcile"); },
        complete: async () => { throw new Error("invalid retained request must not complete"); },
        cleanup: async () => { throw new Error("invalid retained request must not clean up"); },
      });
      const configBefore = await readFile(fixture.path, "utf8");
      const stateBefore = fixture.stateStore.read();
      const slotsBefore = new Map(fixture.credentials.slots);

      await assert.rejects(
        fixture.coordinator().activate({
          ...fixture.request,
          candidateAuthorityPurpose: "retained-model-preference",
          persistBeforeProviderConfigCommit: preferencePort,
          ...mutation,
        } as never),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "provider-candidate-authority-stale",
      );

      assert.deepEqual(fixture.resolverArguments, []);
      assert.deepEqual(fixture.adapter.calls, []);
      assert.deepEqual(fixture.credentials.calls, []);
      assert.equal(fixture.runtimeGuard.acquisitions, 0);
      assert.equal(await readFile(fixture.path, "utf8"), configBefore);
      assert.deepEqual(fixture.stateStore.read(), stateBefore);
      assert.deepEqual(fixture.credentials.slots, slotsBefore);
      assert.deepEqual(await journalDirectories(fixture.appHome), []);
    });
  }
});

test("real retained Kimi authority publishes only a healthy observed candidate", async (t) => {
  for (const runtime of ["not-applicable", "missing"] as const) {
    await t.test(runtime, async (t) => {
      const fixture = await kimiActivationFixture({ oldModelId: "k3" });
      t.after(() => rm(fixture.appHome, { recursive: true, force: true }));
      if (runtime === "missing") {
        const connect = fixture.adapter.connect.bind(fixture.adapter);
        fixture.adapter.connect = async (request) => {
          const candidate = await connect(request);
          return {
            ...candidate,
            health: { ...candidate.health, runtime: "missing" },
          };
        };
      }
      let coordinator!: ProviderActivationCoordinator;
      const authority = new ProviderCredentialAuthority({
        stateStore: fixture.stateStore,
        credentials: fixture.credentials,
        environment: {},
        coordinator: () => coordinator,
        now: () => 10_000,
      });
      coordinator = fixture.coordinatorWith({ candidateAuthority: authority });
      const owner = new AbortController();
      let publicationCalls = 0;
      const beforeConfig = await readFile(fixture.path, "utf8");
      const beforeState = fixture.stateStore.read();
      const beforeSlots = new Map(fixture.credentials.slots);

      const access = await authority.withCredential({
        backendId: "kimi-code",
        connectionId: KIMI_CONNECTION_ID,
        purpose: "retained-model-preference",
        environmentEligibility: "forbidden",
        deadlineAt: 20_000,
        signal: owner.signal,
      }, async (candidate, context) => coordinator.activate({
        ...fixture.request,
        candidate,
        signal: owner.signal,
        deadlineAt: 20_000,
        candidatePermit: context.candidatePermit,
        candidateAuthorityPurpose: "retained-model-preference",
        persistBeforeProviderConfigCommit: createProviderPreferenceCommitPort({
          persist: async (_candidate, mutationAuthority) => {
            publicationCalls += 1;
            return mutationAuthority.acknowledgePersistence(
              (await readConfigEditSnapshot(fixture.path)).file,
            );
          },
          abortAndReconcile: async () => ({ kind: "old" }),
          complete: acknowledgePreferenceCompletion,
          cleanup: acknowledgePreferenceCleanup,
        }),
      }));

      if (runtime === "not-applicable") {
        assert.equal(access.kind, "available");
        if (access.kind !== "available") throw new Error("retained activation was unavailable");
        assert.equal(access.value.persisted, true);
        assert.equal(access.value.route.requestedModelId, KIMI_MODEL.requestedModelId);
        assert.equal(publicationCalls, 1);
        assert.equal(fixture.adapter.calls.includes("activate"), true);
        assert.equal(fixture.stateStore.read().revision, beforeState.revision + 1);
      } else {
        assert.deepEqual(access, { kind: "recovery-required" });
        assert.equal(publicationCalls, 0);
        assert.equal(fixture.adapter.calls.includes("listModels"), false);
        assert.equal(fixture.adapter.calls.includes("activate"), false);
        assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
        assert.equal(await readFile(fixture.path, "utf8"), beforeConfig);
        assert.deepEqual(fixture.stateStore.read(), beforeState);
        assert.deepEqual(fixture.credentials.slots, beforeSlots);
        assert.deepEqual(await journalDirectories(fixture.appHome), []);
      }
    });
  }
});

test("non-owner OpenRouter startup skips an untouched pre-commit Kimi journal without Kimi effects", async () => {
  const fixture = await kimiActivationFixture({ crashAfter: "journal-written" });
  await assert.rejects(fixture.activate());
  fixture.adapter.calls.length = 0;
  fixture.credentials.calls.length = 0;
  const slotsBefore = new Map(fixture.credentials.slots);
  const journalsBefore = await journalDirectories(fixture.appHome);
  let startupOperations = 0;
  const coordinator = fixture.coordinatorWith({
    runtimeGuard: new FakeRuntimeGuard(),
    now: () => 20_000,
    onBoundary: async () => undefined,
  });

  const recovered = await coordinator.recoverAndRun({
    signal: new AbortController().signal,
    inspectCommitted: true,
    allowedBackendIds: ["openrouter"],
  } as never, async (lease) => {
    await lease.assertHeld();
    startupOperations += 1;
    return "openrouter-started";
  });
  const authorityRead = await coordinator.readAuthority({
    signal: new AbortController().signal,
    backendId: "openrouter",
  } as never, async (lease) => {
    await lease.assertHeld();
    return "openrouter-authority";
  });

  assert.deepEqual(recovered, {
    warnings: ["provider-activation-policy-skipped"],
    value: "openrouter-started",
  });
  assert.equal(authorityRead, "openrouter-authority");
  assert.equal(startupOperations, 1);
  assert.deepEqual(fixture.adapter.calls, []);
  assert.deepEqual(fixture.credentials.calls, []);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.deepEqual(await journalDirectories(fixture.appHome), journalsBefore);
});

test("non-owner OpenRouter startup fails closed when the pending Kimi candidate state was adopted", async () => {
  const fixture = await kimiActivationFixture({ crashAfter: "config-readback" });
  await assert.rejects(fixture.activate());
  fixture.adapter.calls.length = 0;
  fixture.credentials.calls.length = 0;
  const slotsBefore = new Map(fixture.credentials.slots);
  const journalsBefore = await journalDirectories(fixture.appHome);
  let startupOperations = 0;
  const coordinator = fixture.coordinatorWith({
    runtimeGuard: new FakeRuntimeGuard(),
    now: () => 20_000,
    onBoundary: async () => undefined,
  });

  await assert.rejects(
    coordinator.recoverAndRun({
      signal: new AbortController().signal,
      inspectCommitted: true,
      allowedBackendIds: ["openrouter"],
    } as never, async () => {
      startupOperations += 1;
      return "must-not-start";
    }),
    /policy|recovery|owner|pending/i,
  );

  assert.equal(startupOperations, 0);
  assert.deepEqual(fixture.adapter.calls, []);
  assert.deepEqual(fixture.credentials.calls, []);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.deepEqual(await journalDirectories(fixture.appHome), journalsBefore);
});

test("Kimi persistence failure cannot downgrade into a process-only activation", async () => {
  const fixture = await kimiActivationFixture();
  fixture.credentials.failWrite = "before";
  await assert.rejects(
    fixture.coordinator().activate({
      ...fixture.request,
      onPersistenceFailure: async () => "process-only",
    }),
    /persistence|candidate|authority|invalid/i,
  );
  assert.equal(fixture.adapter.calls.includes("activate"), false);
  assert.equal(fixture.stateStore.read().revision, fixture.oldState.revision);
});

test("Kimi activation claims one frozen attempt token and verifies the observed tuple before model listing", async () => {
  const fixture = await kimiActivationFixture();
  const owner = new AbortController();
  const permit = Object.freeze({ version: 1 as const });
  const events: string[] = [];
  const validationRequests: Array<Record<string, unknown>> = [];
  const connect = fixture.adapter.connect.bind(fixture.adapter);
  fixture.adapter.connect = async (request) => {
    events.push("connect");
    return connect(request);
  };
  const listModels = fixture.adapter.listModels.bind(fixture.adapter);
  fixture.adapter.listModels = async (request) => {
    events.push("listModels");
    return listModels(request);
  };
  let attemptToken: unknown = null;
  const validate = async (
    request: Record<string, unknown>,
    lease: { assertHeld(): Promise<void> },
  ) => {
    await lease.assertHeld();
    validationRequests.push(request);
    assert.equal(request.backendId, "kimi-code");
    assert.equal(request.candidate, KIMI_SECRET);
    assert.equal(request.expectedRevision, fixture.oldState.revision);
    assert.equal(request.generation, fixture.request.generation);
    assert.equal(request.targetConnectionId, KIMI_CONNECTION_ID);
    assert.equal(request.purpose, "initial-setup");
    assert.equal(request.originalOwnerSignal, owner.signal);
    assert.equal(request.credentialPermit, permit);
    assert.equal(request.requireCredentialPermit, true);
    assert.equal(typeof request.activationAttemptToken, "object");
    assert.equal(Object.isFrozen(request.activationAttemptToken), true);
    if (attemptToken === null) attemptToken = request.activationAttemptToken;
    else assert.equal(request.activationAttemptToken, attemptToken);
    const observed = request.observedCandidate as ProviderCandidate | undefined;
    if (observed) {
      events.push("permit:observed");
      assert.equal(observed.backendId, "kimi-code");
      assert.equal(observed.connectionId, KIMI_CONNECTION_ID);
      assert.equal(observed.accountFingerprint, KIMI_FINGERPRINT);
      assert.equal(observed.billingRealm, KIMI_REALM);
      assert.equal(observed.health.generation, fixture.request.generation);
    } else {
      events.push("permit:static");
    }
    return { kind: "ready" as const };
  };
  const coordinator = fixture.coordinatorWith({
    candidateAuthority: {
      validateCandidatePermitUnderLease: validate,
      validateCandidatePermitAgainstSnapshotUnderLease: validate,
    },
  });

  const result = await coordinator.activate({
    ...fixture.request,
    signal: owner.signal,
    candidateAuthorityPurpose: "initial-setup",
    targetConnectionId: KIMI_CONNECTION_ID,
    candidatePermit: permit,
    requireCandidatePermit: true,
  } as never);

  assert.equal(result.persisted, true);
  assert.deepEqual(events.slice(0, 4), [
    "permit:static",
    "connect",
    "permit:observed",
    "listModels",
  ]);
  assert.ok(validationRequests.length >= 4, "every later fence must reuse the same attempt token");
});

test("Kimi runtime activation rejects foreign top-level candidate backend and connection tuple fields", async (t) => {
  const mutations: ReadonlyArray<readonly [string, (value: CandidateProviderState) => CandidateProviderState]> = [
    ["candidate id", (value) => ({ ...value, candidateId: "foreign-candidate" })],
    ["backend", (value) => ({ ...value, backendId: "openrouter" })],
    ["connection", (value) => ({ ...value, connectionId: "foreign-connection" })],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = await kimiActivationFixture();
      const stateBefore = fixture.stateStore.read();
      const original = fixture.adapter.activate.bind(fixture.adapter);
      fixture.adapter.activate = async (request) => mutate(await original(request));

      await assert.rejects(fixture.activate(), /activation|route|binding|candidate|connection|backend/i);

      assert.equal(fixture.stateStore.read().revision, stateBefore.revision + 1);
      assert.equal(fixture.stateStore.read().defaultRoute?.backendId, "kimi-code");
      assert.equal((await journalDirectories(fixture.appHome)).length, 1);
      assert.equal(fixture.adapter.candidates.size, 0);
    });
  }
});

for (const boundary of boundaries) {
  test(`Kimi activation crash after ${boundary} recovers one complete Kimi tuple`, async () => {
    const fixture = await kimiActivationFixture({ crashAfter: boundary });
    await assert.rejects(fixture.activate(), new RegExp(`simulated-crash:${boundary}`));
    const journalIds = await journalDirectories(fixture.appHome);
    if (boundary === "config-written") {
      assert.equal(journalIds.length, 1);
      assert.equal(fixture.adapter.calls.includes("activate"), false);
    }
    if (journalIds.length > 0) {
      assert.equal(journalIds.length, 1);
      const manifest = JSON.parse(await readFile(
        join(fixture.appHome, "provider-activation", journalIds[0]!, "manifest.json"),
        "utf8",
      )) as ProviderActivationJournalV2;
      assert.equal(manifest.version, 2);
      assert.equal(manifest.backendId, "kimi-code");
      assert.equal(manifest.credentialSlotKind, "kimi-code");
      assert.equal(manifest.candidateRoute.backendId, "kimi-code");
      assert.equal(manifest.candidateRoute.billingRealm, KIMI_REALM);
    }

    const recovered = await fixture.restartAndRecover();
    assert.deepEqual(await journalDirectories(fixture.appHome), []);
    assert.ok(fixture.resolverArguments.length >= 1);
    assert.deepEqual(fixture.resolverArguments, fixture.resolverArguments.map(() => "kimi-code"));
    const route = recovered.state.defaultRoute;
    const connection = recovered.connection;
    assert.ok(route);
    assert.ok(connection);
    assert.equal(route.backendId, "kimi-code");
    assert.equal(route.billingRealm, KIMI_REALM);
    assert.equal(connection.backendId, "kimi-code");
    assert.equal(connection.billingRealm, KIMI_REALM);
    const credentialPointer = requireKeychainCredentialPointer(connection);
    assert.equal(credentialPointer.startsWith("v1:kimi-code:"), true);
    assert.equal(
      (credentialPointer === KIMI_OLD_SLOT.id && recovered.secret === OLD_SECRET)
        || (credentialPointer !== KIMI_OLD_SLOT.id && recovered.secret === KIMI_SECRET),
      true,
    );
  });
}

test("Kimi v2 journal mutations and resolver mismatches fail closed before credential or config publication", async (t) => {
  const invalidManifestMutations: Readonly<Record<string, (manifest: Record<string, unknown>) => void>> = {
    "wrong credential slot kind": (manifest) => { manifest.credentialSlotKind = "inference"; },
    "wrong candidate realm": (manifest) => {
      (manifest.candidateRoute as Record<string, unknown>).billingRealm = "openrouter-payg";
    },
    "extra manifest field": (manifest) => { manifest.future = true; },
  };
  for (const [name, mutate] of Object.entries(invalidManifestMutations)) {
    await t.test(name, async () => {
      const fixture = await kimiActivationFixture({ crashAfter: "journal-written" });
      await assert.rejects(fixture.activate());
      const [transactionId] = await journalDirectories(fixture.appHome);
      assert.ok(transactionId);
      const manifestPath = join(fixture.appHome, "provider-activation", transactionId, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      mutate(manifest);
      const configBefore = await readFile(fixture.path, "utf8");
      const slotsBefore = new Map(fixture.credentials.slots);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

      await assert.rejects(fixture.restartAndRecover(false));
      assert.equal(await readFile(fixture.path, "utf8"), configBefore);
      assert.deepEqual(fixture.credentials.slots, slotsBefore);
    });
  }

  await t.test("resolver returns OpenRouter instance", async () => {
    const fixture = await kimiActivationFixture();
    const configBefore = await readFile(fixture.path, "utf8");
    const slotsBefore = new Map(fixture.credentials.slots);
    await assert.rejects(fixture.coordinatorWith({ adapterResolver: () => new FakeAdapter() }).activate(fixture.request));
    assert.equal(await readFile(fixture.path, "utf8"), configBefore);
    assert.deepEqual(fixture.credentials.slots, slotsBefore);
    assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
  });

  await t.test("candidate reports the wrong backend", async () => {
    const fixture = await kimiActivationFixture();
    const connect = fixture.adapter.connect.bind(fixture.adapter);
    fixture.adapter.connect = async (request) => ({
      ...await connect(request),
      backendId: "openrouter",
    });
    const configBefore = await readFile(fixture.path, "utf8");
    const slotsBefore = new Map(fixture.credentials.slots);
    await assert.rejects(fixture.activate());
    assert.equal(await readFile(fixture.path, "utf8"), configBefore);
    assert.deepEqual(fixture.credentials.slots, slotsBefore);
    assert.equal(fixture.credentials.calls.includes("reserveSlot"), false);
    assert.equal(fixture.adapter.candidates.size, 0);
  });
});

test("Kimi generation supersession after catalog inspection fences revalidation and publishes nothing", async () => {
  const fixture = await kimiActivationFixture();
  const configBefore = await readFile(fixture.path, "utf8");
  const slotsBefore = new Map(fixture.credentials.slots);
  fixture.adapter.advanceGenerationAfterList = true;

  await assert.rejects(fixture.activate(), fixture.api.StaleProviderGenerationError);
  assert.equal(fixture.adapter.currentGeneration, fixture.request.generation + 1);
  assert.equal(await readFile(fixture.path, "utf8"), configBefore);
  assert.deepEqual(fixture.credentials.slots, slotsBefore);
  assert.equal(fixture.credentials.calls.includes("reserveSlot"), true);
  assert.equal(fixture.adapter.calls.includes("activate"), false);
  assert.equal(fixture.adapter.candidates.size, 0);
});
