import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  loadConfigDetailed,
  saveConfig,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ProviderStateStore,
  type ProviderSetupStateV1,
} from "../src/provider-state.js";
import type {
  BackendModelDescriptor,
  CandidateProviderState,
  ProviderCandidate,
  ProviderHealth,
  RouteIdentityV1,
} from "../src/backends.js";
import type {
  CredentialKind,
  CredentialSlotRef,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";

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

  async connect(request: {
    candidate: unknown;
    generation: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    assert.equal(request.signal.aborted, false);
    assert.equal(typeof request.candidate, "string");
    this.calls.push("connect");
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

interface ActivationFixtureOptions {
  crashAfter?: Boundary;
  oldSlot?: CredentialSlotRef | "legacy:inference" | null;
  saveMode?: "normal" | "throw-before" | "throw-after" | "write-corrupt";
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
  const save = async (config: Parameters<typeof saveConfig>[0], configPath: string) => {
    calls.push("saveConfig");
    if (options.saveMode === "throw-before") throw new Error("raw-config-before-secret-marker");
    if (options.saveMode === "write-corrupt") {
      await writeFile(configPath, "{corrupt-after-save", "utf8");
      return;
    }
    await saveConfig(config, configPath);
    if (options.saveMode === "throw-after") throw new Error("raw-config-after-secret-marker");
  };
  const makeCoordinator = (overrides: Record<string, unknown> = {}) =>
    new api.ProviderActivationCoordinator({
      appHome,
      configPath: path,
      privateStore,
      credentials,
      adapter,
      stateStore,
      runtimeGuard,
      now: () => now,
      createUuid: () => uuidQueue.shift() ?? "10000000-0000-4000-8000-000000000099",
      leaseDurationMs: 100,
      waitForLease: async () => new Promise<void>((resolve) => setImmediate(resolve)),
      saveConfig: save,
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
    expectedRevision: oldState.revision,
    candidate: NEW_SECRET,
    selectedCanonicalModelId: MODEL.canonicalModelId,
    generation: 4,
    signal: new AbortController().signal,
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
  };
}

for (const boundary of boundaries) {
  test(`activation crash after ${boundary} recovers one complete tuple`, async () => {
    const fixture = await activationFixture({ crashAfter: boundary });
    await assert.rejects(fixture.activate(), new RegExp(`simulated-crash:${boundary}`));
    const recovered = await fixture.restartAndRecover();
    const oldTuple = await tupleForState(fixture.initialConfig.providerSetup, fixture.credentials);
    const loaded = await loadConfigDetailed(fixture.path);
    const newTuple = await tupleForState(loaded.config.providerSetup as ProviderSetupStateV1, fixture.credentials);
    assert.ok(
      deepEqual(recovered, oldTuple) || recovered.secret === NEW_SECRET,
      `mixed tuple after ${boundary}: ${JSON.stringify(recovered)}`,
    );
    assert.equal(recovered.connection?.credentialSlot === recovered.slotId, true);
    assert.equal(newTuple.connection?.credentialSlot === newTuple.slotId, true);
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
    adapter: fixture.adapter,
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

test("the held runtime guard prevents a run from starting through config commit and runtime bind", async () => {
  const fixture = await activationFixture();
  let tried = false;
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapter: fixture.adapter,
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

test("a post-rename config throw is classified by exact readback and continues with the new candidate", async () => {
  const fixture = await activationFixture({ saveMode: "throw-after" });
  const result = await fixture.activate();
  assert.equal(result.persisted, true);
  const tuple = await readTuple(fixture.path, fixture.credentials);
  assert.equal(tuple.secret, NEW_SECRET);
});

test("a paused unrelated config writer is preserved by the final fenced reread and providerSetup-only merge", async () => {
  const fixture = await activationFixture();
  const preservedMainModel = "preserve/concurrent-writer-main";
  const coordinator = new fixture.api.ProviderActivationCoordinator({
    appHome: fixture.appHome,
    configPath: fixture.path,
    privateStore: fixture.privateStore,
    credentials: fixture.credentials,
    adapter: fixture.adapter,
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
    adapter: fixture.adapter,
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
    providerSetup: ProviderSetupStateV1;
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
    "candidateRoute",
    "candidateSlot",
    "expectedRevision",
    "phase",
    "previousSlot",
    "transactionId",
    "version",
  ]);
  assert.doesNotMatch(raw, /provider-secret|OPENROUTER_API_KEY|creator_user_id|raw-provider|\/Users\/|\\Users\\/i);
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
  journalFixture.privateStore.writeTextAtomic = async () => {
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
    providerSetup: ProviderSetupStateV1;
  };
  raw.providerSetup.connections[0]!.credentialSlot = FOREIGN_SLOT.id;
  await writeFile(fixture.path, `${JSON.stringify(raw)}\n`, "utf8");
  const beforeSlots = new Map(fixture.credentials.slots);

  await assert.rejects(
    fixture.restartAndRecover(false),
    fixture.api.ProviderActivationRecoveryRequiredError,
  );

  assert.deepEqual(fixture.credentials.slots, beforeSlots);
  assert.equal((await journalDirectories(fixture.appHome)).length, 1);
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
    providerSetup: ProviderSetupStateV1;
  };
  raw.providerSetup.connections[0]!.credentialSlot = FOREIGN_SLOT.id;
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
    providerSetup: ProviderSetupStateV1;
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
    adapter: fixture.adapter,
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
    adapter: fixture.adapter,
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

function providerState(
  oldSlot: CredentialSlotRef | "legacy:inference" | null,
): ProviderSetupStateV1 {
  if (oldSlot === null) {
    return {
      schemaVersion: 1,
      revision: 3,
      lifecycle: "never-configured",
      connections: [],
      defaultRoute: null,
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    };
  }
  const credentialSlot = typeof oldSlot === "string" ? oldSlot : oldSlot.id;
  return {
    schemaVersion: 1,
    revision: 3,
    lifecycle: oldSlot === "legacy:inference" ? "migrated" : "configured",
    connections: [{
      id: CONNECTION_ID,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot,
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
  return tupleForState(loaded.config.providerSetup as ProviderSetupStateV1, credentials);
}

async function tupleForState(state: ProviderSetupStateV1, credentials: FakeCredentials) {
  const connection = state.connections.find((entry) => entry.enabled) ?? null;
  const slotId = connection?.credentialSlot ?? null;
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

function sequentialUuid(): () => string {
  let value = 40;
  return () => `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

type TokenBoundPrivateStore = PrivateStore & {
  writeClaimOwner(claim: object, content: string): Promise<void>;
  readClaimOwner(claim: object, maxBytes?: number): Promise<string>;
  assertDirectoryClaim(claim: object): Promise<void>;
};
