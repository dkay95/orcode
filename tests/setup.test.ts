import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendRegistry,
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderHealth,
  type ProviderInspection,
  type RouteIdentityV1,
} from "../src/backends.js";
import type {
  ProviderActivationRequest,
  ProviderActivationResult,
} from "../src/provider-activation.js";
import {
  createNeverConfiguredProviderState,
  migrateLegacyOpenRouterState,
  ProviderStateStore,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV2,
} from "../src/provider-state.js";

interface ClockTask {
  callback: () => void;
  dueAt: number;
  delayMs: number;
}

class FakeClock {
  #now: number;
  #nextHandle = 1;
  readonly #tasks = new Map<number, ClockTask>();
  readonly scheduledDelays: number[] = [];

  constructor(now = 1_000) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle++;
    this.scheduledDelays.push(delayMs);
    this.#tasks.set(handle, {
      callback,
      dueAt: this.#now + delayMs,
      delayMs,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  advanceBy(delayMs: number): void {
    const target = this.#now + delayMs;
    while (true) {
      const due = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort(([leftHandle, left], [rightHandle, right]) =>
          left.dueAt - right.dueAt || leftHandle - rightHandle
        )[0];
      if (!due) break;
      const [handle, task] = due;
      this.#tasks.delete(handle);
      this.#now = task.dueAt;
      task.callback();
    }
    this.#now = target;
  }

  activeTimers(): number {
    return this.#tasks.size;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const OPENROUTER_DESCRIPTOR: BackendDescriptor = {
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: { models: true, tools: true, reasoning: true },
};

const ANTHROPIC_DESCRIPTOR: BackendDescriptor = {
  id: "anthropic",
  displayName: "Anthropic / Claude-Abo",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: { models: false, tools: false, reasoning: false },
};

type InspectionRequest = Parameters<BackendAdapter["inspect"]>[0];
type InspectionScript = (
  request: InspectionRequest,
) => ProviderInspection | Promise<ProviderInspection>;

class FakeAdapter implements BackendAdapter {
  readonly backendId = "openrouter" as const;
  readonly calls: string[] = [];
  readonly inspectionSignals: AbortSignal[] = [];
  readonly reconnectSignals: AbortSignal[] = [];
  inspectionScripts: InspectionScript[] = [];
  reconnectScripts: InspectionScript[] = [];
  models: readonly BackendModelDescriptor[] = [];
  modelScript: ((request: Parameters<BackendAdapter["listModels"]>[0]) =>
    readonly BackendModelDescriptor[] | Promise<readonly BackendModelDescriptor[]>) | null = null;
  cloneModelResults = true;
  readonly modelSignals: AbortSignal[] = [];

  inspect(request: InspectionRequest): Promise<ProviderInspection> {
    this.calls.push("openrouter.inspect");
    this.inspectionSignals.push(request.signal);
    return this.#run(this.inspectionScripts, request);
  }

  async connect(_request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
    this.calls.push("openrouter.connect");
    throw new Error("connect must not be called by startup inspection");
  }

  async listModels(request: Parameters<BackendAdapter["listModels"]>[0]): Promise<readonly BackendModelDescriptor[]> {
    this.calls.push("openrouter.listModels");
    this.modelSignals.push(request.signal);
    const result = this.modelScript ? await this.modelScript(request) : this.models;
    return this.cloneModelResults ? structuredClone(result) : result;
  }

  async activate(_request: Parameters<BackendAdapter["activate"]>[0]): Promise<CandidateProviderState> {
    this.calls.push("openrouter.activate");
    throw new Error("activate must not be called by startup inspection");
  }

  reconnect(request: Parameters<BackendAdapter["reconnect"]>[0]): Promise<ProviderInspection> {
    this.calls.push("openrouter.reconnect");
    this.reconnectSignals.push(request.signal);
    const scripts = this.reconnectScripts.length > 0
      ? this.reconnectScripts
      : this.inspectionScripts;
    return this.#run(scripts, request);
  }

  async logout(_request: Parameters<BackendAdapter["logout"]>[0]): Promise<void> {
    this.calls.push("openrouter.logout");
  }

  async discardCandidate(_candidateId: string): Promise<void> {
    this.calls.push("openrouter.discardCandidate");
  }

  #run(scripts: InspectionScript[], request: InspectionRequest): Promise<ProviderInspection> {
    const script = scripts.shift();
    if (!script) return Promise.reject(new Error("missing deterministic inspection script"));
    return Promise.resolve().then(() => script(request));
  }
}

function connection(
  id = "connection-primary",
  accountFingerprint = `acct_${id}`,
  overrides: Partial<ProviderConnectionStateV1> = {},
): ProviderConnectionStateV1 {
  return {
    id,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "v1:inference:90000000-0000-4000-8000-000000000001",
    accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
    ...overrides,
  };
}

function route(
  owner: ProviderConnectionStateV1,
  requestedModelId = `vendor/${owner.id}`,
  canonicalModelId = requestedModelId,
): RouteIdentityV1 {
  return {
    version: 1,
    backendId: owner.backendId,
    accountFingerprint: owner.accountFingerprint,
    billingRealm: owner.billingRealm,
    requestedModelId,
    canonicalModelId,
    resolutionState: "resolved",
  };
}

function configuredState(options: {
  connections?: ProviderConnectionStateV1[];
  defaultRoute?: RouteIdentityV1 | null;
  preferredLead?: RouteIdentityV1 | null;
  preferredChallenger?: RouteIdentityV1 | null;
} = {}): ProviderSetupStateV2 {
  const primary = options.connections?.[0] ?? connection();
  return {
    schemaVersion: 2,
    revision: 0,
    lifecycle: "configured",
    connections: options.connections ?? [primary],
    defaultRoute: options.defaultRoute === undefined ? route(primary) : options.defaultRoute,
    cross: {
      enabled: false,
      preferredLead: options.preferredLead ?? null,
      preferredChallenger: options.preferredChallenger ?? null,
    },
  };
}

function health(
  generation: number,
  overrides: Partial<ProviderHealth> = {},
): ProviderHealth {
  return {
    credential: "valid",
    connectivity: "connected",
    spend: "available",
    runtime: "not-applicable",
    observedAt: 1_000,
    generation,
    ...overrides,
  };
}

function inspected(
  owner: ProviderConnectionStateV1,
  request: InspectionRequest,
  options: {
    health?: Partial<ProviderHealth>;
    accountFingerprint?: string | null;
    routeEligible?: boolean;
    retryable?: boolean;
    explanationCode?: string;
  } = {},
): ProviderInspection {
  const observedHealth = health(request.generation, options.health);
  const headline = deriveProviderHeadline(observedHealth);
  return {
    backendId: "openrouter",
    connectionId: owner.id,
    health: observedHealth,
    headline,
    accountFingerprint: options.accountFingerprint === undefined
      ? owner.accountFingerprint
      : options.accountFingerprint,
    billingRealm: "openrouter-payg",
    routeEligible: options.routeEligible ?? headline === "ready",
    retryable: options.retryable ?? headline !== "auth-rejected",
    explanationCode: options.explanationCode ?? `fixture-${headline}`,
  };
}

function model(
  requestedModelId: string,
  canonicalModelId = requestedModelId,
  capabilities: BackendModelDescriptor["capabilities"] = {
    textInput: true,
    textOutput: true,
    tools: true,
    reasoning: true,
  },
): BackendModelDescriptor {
  return {
    backendId: "openrouter",
    requestedModelId,
    canonicalModelId,
    displayName: requestedModelId,
    capabilities,
  };
}

interface ActivationDouble {
  calls: ProviderActivationRequest[];
  activate(request: ProviderActivationRequest): Promise<ProviderActivationResult>;
}

function forbiddenActivation(): ActivationDouble {
  const calls: ProviderActivationRequest[] = [];
  return {
    calls,
    async activate(request) {
      calls.push(request);
      throw new Error("activation must not be called");
    },
  };
}

async function setupFixture(options: {
  state?: ProviderSetupStateV2;
  stateStore?: ProviderStateStore;
  adapter?: FakeAdapter;
  clock?: FakeClock;
  activationCoordinator?: ActivationDouble;
  providerTimeoutMs?: number;
  startupTimeoutMs?: number;
  registry?: BackendRegistry;
  onEvent?: (event: Record<string, unknown>) => void;
} = {}) {
  const api = await import("../src/setup.js");
  const adapter = options.adapter ?? new FakeAdapter();
  const state = options.state ?? configuredState();
  const stateStore = options.stateStore ?? new ProviderStateStore(state);
  const clock = options.clock ?? new FakeClock();
  const activationCoordinator = options.activationCoordinator ?? forbiddenActivation();
  const events: Array<Record<string, unknown>> = [];
  const registry = options.registry ?? new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
    { descriptor: ANTHROPIC_DESCRIPTOR },
  ]);
  const orchestrator = new api.SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator,
    clock,
    providerTimeoutMs: options.providerTimeoutMs,
    startupTimeoutMs: options.startupTimeoutMs,
    emit: (event: Record<string, unknown>) => {
      const captured = structuredClone(event);
      events.push(captured);
      options.onEvent?.(captured);
    },
  });
  return {
    api,
    orchestrator,
    adapter,
    stateStore,
    clock,
    activationCoordinator,
    events,
  };
}

test("startup inspects only enabled runnable backends and never connects or lists models", async () => {
  const primary = connection();
  const disabled = connection("connection-disabled", "acct_disabled", { enabled: false });
  const state = configuredState({ connections: [primary, disabled] });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({ state, adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "ready");
  assert.deepEqual(fixture.adapter.calls, ["openrouter.inspect"]);
  assert.equal(result.crossEnabled, false);
  assert.equal(fixture.activationCoordinator.calls.length, 0);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a healthy default route is silent and returns ready", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "ready");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.defaultRoute, route(primary));
  assert.deepEqual(result.readyRoutes, [route(primary)]);
  assert.deepEqual(fixture.events.map((event) => event.type), ["inspection-start", "inspection-end"]);
});

test("a healthy default plus a degraded secondary warns without switching routes", async () => {
  const primary = connection("connection-primary", "acct_primary");
  const secondary = connection("connection-secondary", "acct_secondary");
  const defaultRoute = route(primary, "vendor/primary");
  const secondaryRoute = route(secondary, "vendor/secondary");
  const state = configuredState({
    connections: [primary, secondary],
    defaultRoute,
    preferredChallenger: secondaryRoute,
  });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(secondary, request, {
      health: { connectivity: "offline" },
      routeEligible: false,
      retryable: true,
    }),
  ];
  const fixture = await setupFixture({ state, adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "ready-with-warning");
  assert.deepEqual(result.defaultRoute, defaultRoute);
  assert.deepEqual(result.readyRoutes, [defaultRoute]);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(fixture.stateStore.read().defaultRoute, defaultRoute);
  assert.equal(fixture.activationCoordinator.calls.length, 0);
  assert.deepEqual(fixture.orchestrator.ensureRunnableRoute(), defaultRoute);
});

test("ready routes and inspection ends stay in captured connection-state order", async () => {
  const secondary = connection("connection-secondary", "acct_secondary");
  const primary = connection("connection-primary", "acct_primary");
  const secondaryRoute = route(secondary, "vendor/secondary");
  const defaultRoute = route(primary, "vendor/primary");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(secondary, request),
    (request) => inspected(primary, request),
  ];
  const fixture = await setupFixture({
    state: configuredState({
      connections: [secondary, primary],
      defaultRoute,
      preferredLead: secondaryRoute,
    }),
    adapter,
  });

  const result = await fixture.orchestrator.inspectStartup();

  assert.deepEqual(result.readyRoutes, [secondaryRoute, defaultRoute]);
  assert.deepEqual(
    fixture.events
      .filter((event) => event.type === "inspection-end")
      .map((event) => event.accountFingerprint),
    [secondary.accountFingerprint, primary.accountFingerprint],
  );
});

test("an unhealthy default plus a ready alternative requires explicit route choice", async () => {
  const primary = connection("connection-primary", "acct_primary");
  const secondary = connection("connection-secondary", "acct_secondary");
  const defaultRoute = route(primary, "vendor/primary");
  const alternative = route(secondary, "vendor/secondary");
  const state = configuredState({
    connections: [primary, secondary],
    defaultRoute,
    preferredLead: alternative,
  });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request, {
      health: { credential: "rejected" },
      routeEligible: false,
      retryable: false,
    }),
    (request) => inspected(secondary, request),
  ];
  const fixture = await setupFixture({ state, adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "route-choice-required");
  assert.deepEqual(result.defaultRoute, defaultRoute);
  assert.deepEqual(result.readyRoutes, [alternative]);
  assert.deepEqual(fixture.stateStore.read().defaultRoute, defaultRoute);
  assert.equal(fixture.activationCoordinator.calls.length, 0);
  assert.equal(fixture.events.filter((event) => event.type === "candidate-activation").length, 0);
});

test("no ready route returns setup-required", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request, {
    health: { connectivity: "offline" },
    routeEligible: false,
    retryable: true,
  })];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.events.at(-1)?.type, "setup-required");
  assert.equal(result.crossEnabled, false);
});

test("only rejected credentials request auth replacement while provider failures remain retryable", async (t) => {
  const cases = [
    { name: "rejected", health: { credential: "rejected" } as Partial<ProviderHealth>, replacement: true },
    { name: "offline", health: { connectivity: "offline" } as Partial<ProviderHealth>, replacement: false },
    { name: "403", health: { credential: "unknown" } as Partial<ProviderHealth>, replacement: false },
    { name: "429", health: { credential: "unknown" } as Partial<ProviderHealth>, replacement: false },
    { name: "5xx", health: { credential: "unknown" } as Partial<ProviderHealth>, replacement: false },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const primary = connection();
      const adapter = new FakeAdapter();
      adapter.inspectionScripts = [(request) => inspected(primary, request, {
        health: entry.health,
        routeEligible: false,
        retryable: !entry.replacement,
        explanationCode: `opaque-provider-body-${entry.name}`,
      })];
      const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

      const result = await fixture.orchestrator.inspectStartup();

      const authEvents = fixture.events.filter((event) =>
        event.type === "terminal-failure"
        && event.code === "provider-auth-replacement-required"
      );
      assert.equal(authEvents.length, entry.replacement ? 1 : 0);
      assert.deepEqual(result.warnings, [entry.replacement
        ? "Provider credential replacement is required."
        : "Provider inspection can be retried."]);
      if (!entry.replacement) {
        assert.ok(fixture.events.some((event) =>
          event.type === "warning"
          && event.code === "provider-inspection-retryable"
        ));
      }
    });
  }
});

test("default provider and whole-startup deadlines are exactly 5000 and 8000 milliseconds", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [() => new Promise<ProviderInspection>(() => {})];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  assert.deepEqual([...fixture.clock.scheduledDelays].sort((a, b) => a - b), [5_000, 8_000]);
  fixture.clock.advanceBy(5_000);
  await pending;
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("requested provider and whole-startup deadlines clamp to 15000 and 30000 milliseconds", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [() => new Promise<ProviderInspection>(() => {})];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    adapter,
    providerTimeoutMs: 99_000,
    startupTimeoutMs: 99_000,
  });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  assert.deepEqual([...fixture.clock.scheduledDelays].sort((a, b) => a - b), [15_000, 30_000]);
  fixture.clock.advanceBy(15_000);
  await pending;
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a provider timeout aborts only its own outstanding inspection", async () => {
  const stalled = connection("connection-stalled", "acct_stalled");
  const healthy = connection("connection-healthy", "acct_healthy");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    () => new Promise<ProviderInspection>(() => {}),
    (request) => inspected(healthy, request),
  ];
  const state = configuredState({
    connections: [stalled, healthy],
    defaultRoute: route(healthy),
    preferredLead: route(stalled),
  });
  const fixture = await setupFixture({ state, adapter });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  fixture.clock.advanceBy(5_000);
  const result = await pending;

  assert.equal(result.mode, "ready-with-warning");
  assert.equal(adapter.inspectionSignals[0]?.aborted, true);
  assert.equal(adapter.inspectionSignals[1]?.aborted, false);
  assert.ok(adapter.inspectionSignals[0]?.reason instanceof fixture.api.ProviderInspectionTimeoutError);
  assert.equal(adapter.inspectionSignals[0]?.reason.scope, "provider");
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a late settlement after provider timeout is discarded within the same generation", async () => {
  const primary = connection();
  const late = deferred<ProviderInspection>();
  let request!: InspectionRequest;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(observedRequest) => {
    request = observedRequest;
    return late.promise;
  }];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  fixture.clock.advanceBy(5_000);
  const timedOut = await pending;
  const afterTimeout = JSON.stringify(fixture.stateStore.read());
  const endCount = fixture.events.filter((event) => event.type === "inspection-end").length;
  late.resolve(inspected(primary, request));
  await flushMicrotasks();

  assert.equal(timedOut.mode, "setup-required");
  assert.equal(JSON.stringify(fixture.stateStore.read()), afterTimeout);
  assert.equal(fixture.events.filter((event) => event.type === "inspection-end").length, endCount);
  assert.ok(fixture.events.some((event) =>
    event.type === "inspection-discarded" && event.generation === 1
  ));
});

test("the whole-startup timeout aborts every outstanding inspection", async () => {
  const first = connection("connection-first", "acct_first");
  const second = connection("connection-second", "acct_second");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    () => new Promise<ProviderInspection>(() => {}),
    () => new Promise<ProviderInspection>(() => {}),
  ];
  const fixture = await setupFixture({
    state: configuredState({
      connections: [first, second],
      defaultRoute: route(first),
      preferredLead: route(second),
    }),
    adapter,
    providerTimeoutMs: 15_000,
  });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  fixture.clock.advanceBy(8_000);
  await pending;

  assert.equal(adapter.inspectionSignals.length, 2);
  for (const signal of adapter.inspectionSignals) {
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof fixture.api.ProviderInspectionTimeoutError);
    assert.equal(signal.reason.scope, "startup");
  }
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("whole-startup timeout returns the best completed route in deterministic state order", async () => {
  const primary = connection("connection-primary", "acct_primary");
  const secondary = connection("connection-secondary", "acct_secondary");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request),
    () => new Promise<ProviderInspection>(() => {}),
  ];
  const defaultRoute = route(primary);
  const fixture = await setupFixture({
    state: configuredState({
      connections: [primary, secondary],
      defaultRoute,
      preferredChallenger: route(secondary),
    }),
    adapter,
    providerTimeoutMs: 15_000,
  });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  fixture.clock.advanceBy(8_000);
  const result = await pending;

  assert.equal(result.mode, "ready-with-warning");
  assert.deepEqual(result.readyRoutes, [defaultRoute]);
  assert.deepEqual(result.defaultRoute, defaultRoute);
  assert.equal(fixture.stateStore.read().connections[1]?.lastHealth?.credential, "unknown");
  assert.equal(fixture.stateStore.read().connections[1]?.lastHealth?.connectivity, "unknown");
});

test("caller cancellation preserves exact identity, stores cancelled lifecycle, and permits retry", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [() => new Promise<ProviderInspection>(() => {})];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });
  const controller = new AbortController();
  const reason = new DOMException("exact-user-cancellation", "AbortError");

  const pending = fixture.orchestrator.inspectStartup({ signal: controller.signal });
  await flushMicrotasks();
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  const cancelled = fixture.stateStore.read();
  assert.equal(cancelled.lifecycle, "cancelled");
  assert.equal(cancelled.cross.enabled, false);
  assert.equal(adapter.inspectionSignals[0]?.reason, reason);
  assert.equal(fixture.clock.activeTimers(), 0);

  adapter.inspectionScripts.push((request) => inspected(primary, request));
  const retried = await fixture.orchestrator.inspectStartup();
  assert.equal(retried.mode, "ready");
});

test("late failures from an older generation cannot overwrite a healthy reconnect", async () => {
  const primary = connection();
  const oldInspection = deferred<ProviderInspection>();
  const newInspection = deferred<ProviderInspection>();
  let oldRequest!: InspectionRequest;
  let newRequest!: InspectionRequest;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => {
    oldRequest = request;
    return oldInspection.promise;
  }];
  adapter.reconnectScripts = [(request) => {
    newRequest = request;
    return newInspection.promise;
  }];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const oldRun = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  const newRun = fixture.orchestrator.reconnect("openrouter");
  await flushMicrotasks();
  newInspection.resolve(inspected(primary, newRequest));
  await newRun;
  oldInspection.resolve(inspected(primary, oldRequest, {
    health: { credential: "rejected" },
    routeEligible: false,
    retryable: false,
  }));
  await oldRun;
  await flushMicrotasks();

  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth?.generation, 2);
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth?.credential, "valid");
  assert.ok(fixture.events.some((event) =>
    event.type === "inspection-discarded" && event.generation === 1
  ));
});

test("late success from an older generation cannot restore a failed reconnect", async () => {
  const primary = connection();
  const oldInspection = deferred<ProviderInspection>();
  let oldRequest!: InspectionRequest;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => {
    oldRequest = request;
    return oldInspection.promise;
  }];
  adapter.reconnectScripts = [(request) => inspected(primary, request, {
    health: { connectivity: "offline" },
    routeEligible: false,
    retryable: true,
  })];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const oldRun = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  const newResult = await fixture.orchestrator.reconnect("openrouter");
  oldInspection.resolve(inspected(primary, oldRequest));
  await oldRun;
  await flushMicrotasks();

  assert.equal(newResult.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth?.generation, 2);
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth?.connectivity, "offline");
});

test("a concurrent provider revision change blocks inspection persistence", async () => {
  const primary = connection();
  const pendingInspection = deferred<ProviderInspection>();
  let request!: InspectionRequest;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(observedRequest) => {
    request = observedRequest;
    return pendingInspection.promise;
  }];
  const stateStore = new ProviderStateStore(configuredState({ connections: [primary] }));
  const fixture = await setupFixture({ stateStore, adapter });

  const pending = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  const external = stateStore.read();
  external.lifecycle = "cancelled";
  stateStore.replace(external, external.revision);
  pendingInspection.resolve(inspected(primary, request));
  await pending;

  const retained = stateStore.read();
  assert.equal(retained.revision, 1);
  assert.equal(retained.lifecycle, "cancelled");
  assert.equal(retained.connections[0]?.lastHealth, null);
  assert.deepEqual(fixture.events.map((event) => event.type), [
    "inspection-start",
    "inspection-discarded",
  ]);
});

test("mismatched adapter identity and generation never authorize or persist a route", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => ({
    ...inspected(primary, request),
    connectionId: "different-connection",
    health: health(request.generation + 1),
    headline: "ready",
    routeEligible: true,
  })];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth, null);
  assert.deepEqual(fixture.events.map((event) => event.type), [
    "inspection-start",
    "terminal-failure",
    "setup-required",
  ]);
});

test("a foreign fingerprint cannot impersonate the scheduled verified connection", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request, {
    accountFingerprint: "acct_foreign",
  })];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth, null);
  assert.deepEqual(fixture.events.map((event) => event.type), [
    "inspection-start",
    "terminal-failure",
    "setup-required",
  ]);
});

test("malformed adapter output becomes a fixed terminal outcome without persistence", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [async () => null as unknown as ProviderInspection];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth, null);
  assert.deepEqual(fixture.events.map((event) => event.type), [
    "inspection-start",
    "terminal-failure",
    "setup-required",
  ]);
  assert.equal(
    fixture.events.some((event) => JSON.stringify(event).includes("TypeError")),
    false,
  );
});

test("adapter route hints cannot suppress a recomputed healthy route", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request, {
    routeEligible: false,
  })];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "ready");
  assert.deepEqual(result.defaultRoute, route(primary));
  assert.deepEqual(fixture.events.map((event) => event.type), [
    "inspection-start",
    "inspection-end",
  ]);
});

test("ensureRunnableRoute returns only a freshly ready resolved route and otherwise does not mutate", async () => {
  const primary = connection();
  const defaultRoute = route(primary);
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(primary, request, {
      health: { connectivity: "offline" },
      routeEligible: false,
      retryable: true,
    }),
  ];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary], defaultRoute }),
    adapter,
  });

  await fixture.orchestrator.inspectStartup();
  assert.deepEqual(fixture.orchestrator.ensureRunnableRoute(), defaultRoute);

  await fixture.orchestrator.reconnect("openrouter");
  const before = JSON.stringify(fixture.stateStore.read());
  assert.throws(
    () => fixture.orchestrator.ensureRunnableRoute(),
    fixture.api.ProviderSetupRequiredError,
  );
  assert.equal(JSON.stringify(fixture.stateStore.read()), before);
});

test("startup performs zero candidate, credential, model, chat, or run side effects", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  await fixture.orchestrator.inspectStartup();

  assert.deepEqual(adapter.calls, ["openrouter.inspect"]);
  assert.equal(fixture.activationCoordinator.calls.length, 0);
  assert.equal(fixture.events.some((event) => event.type === "candidate-activation"), false);
  assert.equal(fixture.events.some((event) => String(event.type).startsWith("run-")), false);
});

test("healthy migrated legacy route resolves one exact compatible model and is byte-stable thereafter", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-connection" },
  );
  const provisional = state.connections[0]!;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(provisional, request, {
    accountFingerprint: "acct_or_verified",
  })];
  adapter.models = [model("vendor/legacy-requested", "vendor/canonical-id")];
  const fixture = await setupFixture({ state, adapter });

  const inspectedResult = await fixture.orchestrator.inspectStartup();
  assert.equal(inspectedResult.mode, "route-choice-required");
  assert.equal(fixture.stateStore.read().connections[0]?.accountFingerprintState, "verified");
  assert.equal(fixture.stateStore.read().defaultRoute?.accountFingerprint, "acct_or_verified");

  const resolved = await fixture.orchestrator.resolveLegacyDefaultRoute();
  assert.equal(resolved.mode, "ready");
  assert.equal(fixture.stateStore.read().defaultRoute?.canonicalModelId, "vendor/canonical-id");
  assert.equal(fixture.stateStore.read().defaultRoute?.resolutionState, "resolved");
  assert.equal(adapter.calls.filter((call) => call === "openrouter.listModels").length, 1);

  const stable = JSON.stringify(fixture.stateStore.read());
  const repeated = await fixture.orchestrator.resolveLegacyDefaultRoute();
  assert.equal(repeated.mode, "ready");
  assert.equal(JSON.stringify(fixture.stateStore.read()), stable);
  assert.equal(adapter.calls.filter((call) => call === "openrouter.listModels").length, 1);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("missing or incompatible legacy models require route choice without guessing", async (t) => {
  const cases: Array<{ name: string; models: readonly BackendModelDescriptor[] }> = [
    {
      name: "canonical alias only",
      models: [model("vendor/different-request", "vendor/legacy-requested")],
    },
    {
      name: "exact but incompatible",
      models: [model("vendor/legacy-requested", "vendor/canonical-id", {
        textInput: true,
        textOutput: false,
        tools: true,
        reasoning: true,
      })],
    },
    {
      name: "ambiguous duplicate canonical IDs",
      models: [
        model("vendor/legacy-requested", "vendor/canonical-a"),
        model("vendor/legacy-requested", "vendor/canonical-b"),
      ],
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const state = migrateLegacyOpenRouterState(
        { mainModel: "vendor/legacy-requested" },
        { connectionId: `legacy-${entry.name.replaceAll(" ", "-")}` },
      );
      const adapter = new FakeAdapter();
      adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
        accountFingerprint: `acct_verified_${entry.name.replaceAll(" ", "_")}`,
      })];
      adapter.models = entry.models;
      const fixture = await setupFixture({ state, adapter });
      await fixture.orchestrator.inspectStartup();
      const before = JSON.stringify(fixture.stateStore.read());

      const result = await fixture.orchestrator.resolveLegacyDefaultRoute();

      assert.equal(result.mode, "route-choice-required");
      assert.equal(fixture.stateStore.read().defaultRoute?.canonicalModelId, null);
      assert.equal(fixture.stateStore.read().defaultRoute?.resolutionState, "legacy-unverified");
      assert.equal(JSON.stringify(fixture.stateStore.read()), before);
    });
  }
});

test("malformed legacy catalog entries require route choice without mutation", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-malformed-catalog" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_malformed_catalog",
  })];
  adapter.models = [null as unknown as BackendModelDescriptor];
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();
  const before = JSON.stringify(fixture.stateStore.read());

  const result = await fixture.orchestrator.resolveLegacyDefaultRoute();

  assert.equal(result.mode, "route-choice-required");
  assert.equal(JSON.stringify(fixture.stateStore.read()), before);
  assert.equal(adapter.calls.filter((call) => call === "openrouter.listModels").length, 1);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("legacy model resolution loses a concurrent revision CAS without mutation", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-cas-loss" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_cas_loss",
  })];
  const models = deferred<readonly BackendModelDescriptor[]>();
  adapter.modelScript = () => models.promise;
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();

  const resolving = fixture.orchestrator.resolveLegacyDefaultRoute();
  await flushMicrotasks();
  const external = fixture.stateStore.read();
  external.lifecycle = "cancelled";
  fixture.stateStore.replace(external, external.revision);
  const retained = JSON.stringify(fixture.stateStore.read());
  models.resolve([model("vendor/legacy-requested", "vendor/canonical")]);

  const result = await resolving;
  assert.equal(result.mode, "route-choice-required");
  assert.equal(JSON.stringify(fixture.stateStore.read()), retained);
});

test("a superseded legacy lookup cannot publish an older generation route action", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-stale-generation" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_stale",
  })];
  const models = deferred<readonly BackendModelDescriptor[]>();
  adapter.modelScript = () => models.promise;
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();
  fixture.events.splice(0);

  const resolving = fixture.orchestrator.resolveLegacyDefaultRoute();
  await flushMicrotasks();
  const verified = fixture.stateStore.read().connections[0]!;
  adapter.reconnectScripts = [(request) => inspected(verified, request)];
  const reconnecting = fixture.orchestrator.reconnect("openrouter");

  await Promise.all([resolving, reconnecting]);

  assert.equal(adapter.modelSignals[0]?.aborted, true);
  assert.equal(fixture.events.every((event) => event.generation === 2), true);
  assert.equal(fixture.stateStore.read().defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("legacy model lookup has an owned bounded timeout and never mutates on timeout", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-timeout" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_timeout",
  })];
  adapter.modelScript = () => new Promise<readonly BackendModelDescriptor[]>(() => {});
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();
  const before = JSON.stringify(fixture.stateStore.read());

  const resolving = fixture.orchestrator.resolveLegacyDefaultRoute();
  await flushMicrotasks();
  fixture.clock.advanceBy(5_000);
  const result = await resolving;

  assert.equal(result.mode, "route-choice-required");
  assert.equal(JSON.stringify(fixture.stateStore.read()), before);
  assert.equal(adapter.modelSignals[0]?.aborted, true);
  assert.ok(adapter.modelSignals[0]?.reason instanceof fixture.api.ProviderInspectionTimeoutError);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a failed provisional migration inspection remains ephemeral and schema-valid", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy" },
    { connectionId: "legacy-failed" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    health: { connectivity: "offline", credential: "unknown" },
    accountFingerprint: null,
    routeEligible: false,
    retryable: true,
  })];
  const fixture = await setupFixture({ state, adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.accountFingerprintState, "provisional");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth, null);
});

test("a provisional placeholder cannot verify itself as an account identity", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy" },
    { connectionId: "legacy-self-identity" },
  );
  const provisional = state.connections[0]!;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(provisional, request, {
    accountFingerprint: provisional.accountFingerprint,
  })];
  const fixture = await setupFixture({ state, adapter });

  const result = await fixture.orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.equal(fixture.stateStore.read().connections[0]?.accountFingerprintState, "provisional");
  assert.equal(fixture.stateStore.read().connections[0]?.lastHealth, null);
  assert.equal(fixture.stateStore.read().defaultRoute?.accountFingerprint, provisional.accountFingerprint);
});

test("candidate activation delegates once and emits only privacy-safe normalized identity", async () => {
  const primary = connection();
  const activatedRoute = route(primary, "vendor/chosen", "vendor/canonical");
  const activatedState = configuredState({
    connections: [primary],
    defaultRoute: activatedRoute,
  });
  activatedState.revision = 1;
  const calls: ProviderActivationRequest[] = [];
  const activationCoordinator: ActivationDouble = {
    calls,
    async activate(request) {
      calls.push(request);
      return {
        persisted: true,
        route: activatedRoute,
        state: activatedState,
        warnings: [],
      };
    },
  };
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    activationCoordinator,
  });
  const secret = "sk-or-v1-private-candidate";

  const result = await fixture.orchestrator.activateCandidate({
    backendId: "openrouter",
    expectedRevision: 0,
    candidate: secret,
    expectedRequestedModelId: "vendor/chosen",
    selectedCanonicalModelId: "vendor/canonical",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  });

  assert.equal(result.persisted, true);
  assert.equal(calls.length, 1);
  const activationEvent = fixture.events.find((event) => event.type === "candidate-activation");
  assert.deepEqual(activationEvent, {
    version: 1,
    type: "candidate-activation",
    backendId: "openrouter",
    generation: 1,
    connectionId: primary.id,
    route: activatedRoute,
  });
  assert.equal(JSON.stringify(fixture.events).includes(secret), false);
});

test("concurrent candidate activations are serialized before coordinator commit", async () => {
  const primary = connection();
  const activatedRoute = route(primary);
  const activatedState = configuredState({ connections: [primary], defaultRoute: activatedRoute });
  activatedState.revision = 1;
  const releases = [
    deferred<ProviderActivationResult>(),
    deferred<ProviderActivationResult>(),
  ];
  const activationCoordinator: ActivationDouble = {
    calls: [],
    activate(request) {
      const release = releases[this.calls.length];
      this.calls.push(request);
      assert.ok(release);
      return release.promise;
    },
  };
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    activationCoordinator,
  });
  const activationRequest = {
    backendId: "openrouter" as const,
    expectedRevision: 0,
    candidate: "sk-or-v1-private-candidate",
    expectedRequestedModelId: activatedRoute.requestedModelId,
    selectedCanonicalModelId: "vendor/canonical",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted" as const,
  };

  const first = fixture.orchestrator.activateCandidate(activationRequest);
  const second = fixture.orchestrator.activateCandidate(activationRequest);
  await flushMicrotasks();

  assert.deepEqual(activationCoordinator.calls.map((call) => call.generation), [1]);
  releases[0]!.resolve({
    persisted: true,
    route: activatedRoute,
    state: activatedState,
    warnings: [],
  });
  await first;
  await flushMicrotasks();
  assert.deepEqual(activationCoordinator.calls.map((call) => call.generation), [1, 2]);

  releases[1]!.resolve({
    persisted: true,
    route: activatedRoute,
    state: activatedState,
    warnings: [],
  });
  await second;
});

test("new inspection generation waits for an in-flight activation before taking ownership", async () => {
  const primary = connection();
  const activationRelease = deferred<ProviderActivationResult>();
  const activationCoordinator: ActivationDouble = {
    calls: [],
    activate(request) {
      this.calls.push(request);
      return activationRelease.promise;
    },
  };
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    adapter,
    activationCoordinator,
  });

  const activation = fixture.orchestrator.activateCandidate({
    backendId: "openrouter",
    expectedRevision: 0,
    candidate: "sk-or-v1-private-candidate",
    expectedRequestedModelId: `vendor/${primary.id}`,
    selectedCanonicalModelId: "vendor/canonical",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  });
  await flushMicrotasks();
  const inspection = fixture.orchestrator.inspectStartup();
  await flushMicrotasks();
  assert.deepEqual(adapter.calls, []);

  const activatedRoute = route(primary);
  const activatedState = configuredState({ connections: [primary], defaultRoute: activatedRoute });
  activatedState.revision = 1;
  activationRelease.resolve({
    persisted: true,
    route: activatedRoute,
    state: activatedState,
    warnings: [],
  });
  await activation;
  await inspection;

  assert.deepEqual(adapter.calls, ["openrouter.inspect"]);
  assert.deepEqual(fixture.events.map((event) => event.generation), [1, 2, 2]);
});

test("inspection events use fixed privacy-safe fields and never provider error text", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  const sentinels = [
    "sk-or-v1-secret-sentinel",
    "raw-account-123",
    "provider-body-sentinel",
    "https://login.invalid/device",
    "device-code-ABCD",
  ];
  adapter.inspectionScripts = [async () => {
    throw new Error(sentinels.join(" | "));
  }];
  const fixture = await setupFixture({ state: configuredState({ connections: [primary] }), adapter });

  const result = await fixture.orchestrator.inspectStartup();

  const serialized = JSON.stringify({ result, events: fixture.events });
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false);
  const ended = fixture.events.find((event) => event.type === "inspection-end");
  assert.ok(ended);
  assert.deepEqual(Object.keys(ended).sort(), [
    "accountFingerprint",
    "backendId",
    "billingRealm",
    "durationMs",
    "generation",
    "headline",
    "health",
    "maturity",
    "type",
    "version",
  ]);
  const messageEvents = fixture.events.filter((event) => "message" in event);
  assert.ok(messageEvents.every((event) =>
    event.message === "Provider inspection can be retried."
    || event.message === "Provider setup is required."
  ));
});

test("pre-aborted legacy resolution performs no catalog work and stores exact cancellation", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-pre-aborted" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_pre_aborted",
  })];
  adapter.models = [model("vendor/legacy-requested", "vendor/canonical")];
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();
  const controller = new AbortController();
  const reason = new DOMException("exact-pre-aborted-legacy", "AbortError");
  controller.abort(reason);
  const catalogCallsBefore = adapter.calls.filter((call) => call === "openrouter.listModels").length;

  await assert.rejects(
    fixture.orchestrator.resolveLegacyDefaultRoute({ signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  await flushMicrotasks();

  assert.equal(
    adapter.calls.filter((call) => call === "openrouter.listModels").length,
    catalogCallsBefore,
  );
  assert.equal(fixture.stateStore.read().lifecycle, "cancelled");
  assert.equal(fixture.stateStore.read().cross.enabled, false);
  assert.equal(fixture.stateStore.read().defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("caller cancellation during durable legacy-route commit rejects exactly without route actions", async () => {
  const initial = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-durable-cancellation" },
  );
  let durable = structuredClone(initial);
  let persistCalls = 0;
  const legacyAdopted = deferred<void>();
  const releaseLegacy = deferred<void>();
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      persistCalls += 1;
      const next = request.build(durable);
      request.adopt(next);
      durable = structuredClone(next);
      if (persistCalls === 2) {
        legacyAdopted.resolve();
        await releaseLegacy.promise;
      }
      return structuredClone(next);
    },
  });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(initial.connections[0]!, request, {
    accountFingerprint: "acct_verified_durable_cancel",
  })];
  adapter.models = [model("vendor/legacy-requested", "vendor/canonical")];
  const fixture = await setupFixture({ state: initial, stateStore, adapter });
  await fixture.orchestrator.inspectStartup();
  fixture.events.splice(0);
  const controller = new AbortController();
  const reason = new DOMException("exact-legacy-durable-cancellation", "AbortError");

  const resolving = fixture.orchestrator.resolveLegacyDefaultRoute({
    signal: controller.signal,
  });
  await legacyAdopted.promise;
  controller.abort(reason);
  releaseLegacy.resolve();

  await assert.rejects(resolving, (error: unknown) => error === reason);
  assert.equal(stateStore.read().lifecycle, "cancelled");
  assert.equal(durable.lifecycle, "cancelled");
  assert.equal(stateStore.read().cross.enabled, false);
  assert.deepEqual(
    fixture.events.filter((event) =>
      event.type === "route-choice-required" || event.type === "setup-required"
    ),
    [],
  );
  assert.equal(adapter.calls.filter((call) => call === "openrouter.listModels").length, 1);
  assert.equal(fixture.clock.activeTimers(), 0);
});

async function durableLegacyCommitRejectionFixture() {
  const initial = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-durable-rejection" },
  );
  let durable = structuredClone(initial);
  let persistCalls = 0;
  const legacyCommitStarted = deferred<void>();
  const releaseLegacyCommit = deferred<void>();
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      persistCalls += 1;
      if (persistCalls === 2) {
        legacyCommitStarted.resolve();
        await releaseLegacyCommit.promise;
        throw new Error("durable legacy route commit rejected");
      }
      const next = request.build(durable);
      request.adopt(next);
      durable = structuredClone(next);
      return structuredClone(next);
    },
  });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(initial.connections[0]!, request, {
    accountFingerprint: "acct_verified_durable_rejection",
  })];
  adapter.models = [model("vendor/legacy-requested", "vendor/canonical")];
  const fixture = await setupFixture({ state: initial, stateStore, adapter });
  await fixture.orchestrator.inspectStartup();
  fixture.events.splice(0);
  return {
    fixture,
    stateStore,
    legacyCommitStarted,
    releaseLegacyCommit,
    durable: () => structuredClone(durable),
  };
}

test("caller cancellation dominates a rejected durable legacy-route commit", async () => {
  const subject = await durableLegacyCommitRejectionFixture();
  const controller = new AbortController();
  const reason = new DOMException("exact-rejected-legacy-cancellation", "AbortError");

  const resolving = subject.fixture.orchestrator.resolveLegacyDefaultRoute({
    signal: controller.signal,
  });
  await subject.legacyCommitStarted.promise;
  controller.abort(reason);
  subject.releaseLegacyCommit.resolve();

  await assert.rejects(resolving, (error: unknown) => error === reason);
  assert.equal(subject.stateStore.read().lifecycle, "cancelled");
  assert.equal(subject.durable().lifecycle, "cancelled");
  assert.deepEqual(
    subject.fixture.events.filter((event) =>
      event.type === "route-choice-required" || event.type === "setup-required"
    ),
    [],
  );
  assert.equal(subject.fixture.clock.activeTimers(), 0);
});

test("durable legacy-route commit failure without cancellation requires route choice", async () => {
  const subject = await durableLegacyCommitRejectionFixture();

  const resolving = subject.fixture.orchestrator.resolveLegacyDefaultRoute();
  await subject.legacyCommitStarted.promise;
  subject.releaseLegacyCommit.resolve();
  const result = await resolving;

  assert.equal(result.mode, "route-choice-required");
  assert.equal(subject.stateStore.read().lifecycle, "migrated");
  assert.deepEqual(
    subject.fixture.events.map((event) => event.type),
    ["route-choice-required"],
  );
  assert.equal(subject.fixture.clock.activeTimers(), 0);
});

test("caller cancellation during durable inspection commit wins before events and result", async () => {
  const primary = connection();
  const initial = configuredState({ connections: [primary] });
  let durable = structuredClone(initial);
  let persistCalls = 0;
  const firstAdopted = deferred<void>();
  const releaseFirst = deferred<void>();
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      persistCalls += 1;
      const next = request.build(durable);
      request.adopt(next);
      durable = structuredClone(next);
      if (persistCalls === 1) {
        firstAdopted.resolve();
        await releaseFirst.promise;
      }
      return structuredClone(next);
    },
  });
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({ state: initial, stateStore, adapter });
  const controller = new AbortController();
  const reason = new DOMException("exact-durable-cancellation", "AbortError");

  const pending = fixture.orchestrator.inspectStartup({ signal: controller.signal });
  await firstAdopted.promise;
  controller.abort(reason);
  releaseFirst.resolve();
  await assert.rejects(pending, (error: unknown) => error === reason);

  assert.equal(stateStore.read().lifecycle, "cancelled");
  assert.equal(durable.lifecycle, "cancelled");
  assert.equal(stateStore.read().cross.enabled, false);
  assert.equal(fixture.events.some((event) => event.type === "inspection-end"), false);
  assert.equal(fixture.events.some((event) => event.type === "warning"), false);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("back-to-back generations register ownership before an activation wait", async () => {
  const primary = connection();
  const activatedRoute = route(primary);
  const activatedState = configuredState({ connections: [primary], defaultRoute: activatedRoute });
  activatedState.revision = 1;
  const activationRelease = deferred<ProviderActivationResult>();
  const activationCoordinator: ActivationDouble = {
    calls: [],
    activate(request) {
      this.calls.push(request);
      return activationRelease.promise;
    },
  };
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  adapter.reconnectScripts = [(request) => inspected(primary, request)];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    adapter,
    activationCoordinator,
  });
  const activation = fixture.orchestrator.activateCandidate({
    backendId: "openrouter",
    expectedRevision: 0,
    candidate: "candidate-generation-gate",
    expectedRequestedModelId: activatedRoute.requestedModelId,
    selectedCanonicalModelId: activatedRoute.canonicalModelId!,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  });
  await flushMicrotasks();

  const superseded = fixture.orchestrator.inspectStartup();
  const current = fixture.orchestrator.reconnect("openrouter");
  await flushMicrotasks();
  assert.deepEqual(adapter.calls, []);
  activationRelease.resolve({
    persisted: true,
    route: activatedRoute,
    state: activatedState,
    warnings: [],
  });
  await activation;
  await Promise.all([superseded, current]);

  assert.deepEqual(adapter.calls, ["openrouter.reconnect"]);
  assert.deepEqual(
    fixture.events.filter((event) => event.type === "inspection-start").map((event) => event.generation),
    [3],
  );
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a superseded generation cannot publish after durable adoption returns", async () => {
  const primary = connection();
  const initial = configuredState({ connections: [primary] });
  let durable = structuredClone(initial);
  let persistCalls = 0;
  const firstAdopted = deferred<void>();
  const releaseFirst = deferred<void>();
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      persistCalls += 1;
      const next = request.build(durable);
      request.adopt(next);
      durable = structuredClone(next);
      if (persistCalls === 1) {
        firstAdopted.resolve();
        await releaseFirst.promise;
      }
      return structuredClone(next);
    },
  });
  const reconnectResult = deferred<ProviderInspection>();
  let reconnectRequest!: InspectionRequest;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  adapter.reconnectScripts = [(request) => {
    reconnectRequest = request;
    return reconnectResult.promise;
  }];
  const fixture = await setupFixture({ state: initial, stateStore, adapter });

  const older = fixture.orchestrator.inspectStartup();
  await firstAdopted.promise;
  const newer = fixture.orchestrator.reconnect("openrouter");
  await flushMicrotasks();
  const newerStartIndex = fixture.events.findIndex((event) =>
    event.type === "inspection-start" && event.generation === 2
  );
  assert.notEqual(newerStartIndex, -1);
  releaseFirst.resolve();
  await flushMicrotasks();
  const staleAuthoritativeEvents =
    fixture.events.slice(newerStartIndex).filter((event) =>
      event.generation === 1 && event.type !== "inspection-discarded"
    );
  reconnectResult.resolve(inspected(primary, reconnectRequest));
  await Promise.all([older, newer]);

  assert.deepEqual(staleAuthoritativeEvents, []);
  assert.equal(stateStore.read().connections[0]?.lastHealth?.generation, 2);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("runnable route proof is revoked by current provider state revision or disable", async (t) => {
  const cases: Array<{
    name: string;
    mutate(state: ProviderSetupStateV2): void;
  }> = [
    {
      name: "unrelated revision",
      mutate(state) {
        state.lifecycle = "cancelled";
      },
    },
    {
      name: "disabled connection",
      mutate(state) {
        state.connections[0]!.enabled = false;
      },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const primary = connection();
      const adapter = new FakeAdapter();
      adapter.inspectionScripts = [(request) => inspected(primary, request)];
      const fixture = await setupFixture({
        state: configuredState({ connections: [primary] }),
        adapter,
      });
      await fixture.orchestrator.inspectStartup();
      const externallyChanged = fixture.stateStore.read();
      entry.mutate(externallyChanged);
      fixture.stateStore.replace(externallyChanged, externallyChanged.revision);
      const before = JSON.stringify(fixture.stateStore.read());

      assert.throws(
        () => fixture.orchestrator.ensureRunnableRoute(),
        fixture.api.ProviderSetupRequiredError,
      );
      assert.equal(JSON.stringify(fixture.stateStore.read()), before);
    });
  }
});

test("runnable route proof is unavailable while a newer generation is pending", async () => {
  const primary = connection();
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(primary, request)];
  const reconnectStarted = deferred<void>();
  const releaseReconnect = deferred<void>();
  adapter.reconnectScripts = [async (request) => {
    reconnectStarted.resolve();
    await releaseReconnect.promise;
    return inspected(primary, request);
  }];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    adapter,
  });
  await fixture.orchestrator.inspectStartup();

  const pending = fixture.orchestrator.reconnect("openrouter");
  let thrown: unknown;
  try {
    fixture.orchestrator.ensureRunnableRoute();
  } catch (error) {
    thrown = error;
  }
  await flushMicrotasks();
  releaseReconnect.resolve();
  await pending;
  await reconnectStarted.promise;

  assert.ok(thrown instanceof fixture.api.ProviderSetupRequiredError);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("inspection normalization snapshots untrusted primitive and nested health getters once", async () => {
  const primary = connection();
  const fingerprintSentinel = "secret-from-seventh-fingerprint-read";
  const healthSentinel = "secret-from-second-health-read";
  let fingerprintReads = 0;
  let credentialReads = 0;
  const adversarialHealth = {
    get credential() {
      credentialReads += 1;
      return credentialReads === 1 ? "valid" : healthSentinel;
    },
    connectivity: "connected",
    spend: "available",
    runtime: "not-applicable",
    observedAt: 1_000,
    generation: 1,
  };
  const adversarialInspection = {
    backendId: "openrouter",
    connectionId: primary.id,
    health: adversarialHealth,
    headline: "ready",
    get accountFingerprint() {
      fingerprintReads += 1;
      return fingerprintReads < 7 ? primary.accountFingerprint : fingerprintSentinel;
    },
    billingRealm: "openrouter-payg",
    routeEligible: true,
    retryable: false,
    explanationCode: "untrusted-getters",
  } as unknown as ProviderInspection;
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [() => adversarialInspection];
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    adapter,
  });

  const result = await fixture.orchestrator.inspectStartup();
  const serialized = JSON.stringify({ result, events: fixture.events, state: fixture.stateStore.read() });

  assert.equal(result.mode, "ready");
  assert.equal(fingerprintReads, 1);
  assert.equal(credentialReads, 1);
  assert.equal(serialized.includes(fingerprintSentinel), false);
  assert.equal(serialized.includes(healthSentinel), false);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("legacy model normalization snapshots primitive and nested capability getters once", async () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/legacy-requested" },
    { connectionId: "legacy-model-getters" },
  );
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
    accountFingerprint: "acct_verified_model_getters",
  })];
  const canonicalSentinel = "secret-from-third-canonical-read";
  let canonicalReads = 0;
  let toolsReads = 0;
  const capabilities = {
    textInput: true,
    textOutput: true,
    get tools() {
      toolsReads += 1;
      return toolsReads === 1;
    },
    reasoning: true,
  };
  const adversarialModel = {
    backendId: "openrouter",
    requestedModelId: "vendor/legacy-requested",
    get canonicalModelId() {
      canonicalReads += 1;
      return canonicalReads < 3 ? "vendor/canonical-safe" : canonicalSentinel;
    },
    displayName: "Legacy model",
    capabilities,
  } as unknown as BackendModelDescriptor;
  adapter.cloneModelResults = false;
  adapter.modelScript = () => [adversarialModel];
  const fixture = await setupFixture({ state, adapter });
  await fixture.orchestrator.inspectStartup();

  const result = await fixture.orchestrator.resolveLegacyDefaultRoute();
  const serialized = JSON.stringify({ result, state: fixture.stateStore.read() });

  assert.equal(result.mode, "ready");
  assert.equal(fixture.stateStore.read().defaultRoute?.canonicalModelId, "vendor/canonical-safe");
  assert.equal(canonicalReads, 1);
  assert.equal(toolsReads, 1);
  assert.equal(serialized.includes(canonicalSentinel), false);
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("candidate activation event reconstructs only the exact safe route schema", async () => {
  const primary = connection();
  const safeRoute = route(primary, "vendor/chosen", "vendor/canonical");
  const secret = "secret-extra-candidate-route-field";
  const coordinatorRoute = {
    ...safeRoute,
    secret,
  } as RouteIdentityV1;
  const activatedState = configuredState({
    connections: [primary],
    defaultRoute: safeRoute,
  });
  activatedState.revision = 1;
  const activationCoordinator: ActivationDouble = {
    calls: [],
    async activate(request) {
      this.calls.push(request);
      return {
        persisted: true,
        route: coordinatorRoute,
        state: activatedState,
        warnings: [],
      };
    },
  };
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary] }),
    activationCoordinator,
  });

  await fixture.orchestrator.activateCandidate({
    backendId: "openrouter",
    expectedRevision: 0,
    candidate: "candidate-safe-route-event",
    expectedRequestedModelId: "vendor/chosen",
    selectedCanonicalModelId: "vendor/canonical",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  });
  const activationEvent = fixture.events.find((event) => event.type === "candidate-activation");

  assert.ok(activationEvent);
  assert.deepEqual(activationEvent.route, safeRoute);
  assert.deepEqual(Object.keys(activationEvent.route as unknown as Record<string, unknown>).sort(), [
    "accountFingerprint",
    "backendId",
    "billingRealm",
    "canonicalModelId",
    "requestedModelId",
    "resolutionState",
    "version",
  ]);
  assert.equal(JSON.stringify(activationEvent).includes(secret), false);
});

test("a reentrant newer generation at inspection start prevents the old adapter effect", async () => {
  const primary = connection();
  const secondary = connection("connection-secondary", "acct_secondary");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(secondary, request),
  ];
  adapter.reconnectScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(secondary, request),
  ];
  let startNewer: ((event: Record<string, unknown>) => void) | null = null;
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary, secondary] }),
    adapter,
    onEvent: (event) => startNewer?.(event),
  });
  let newer: Promise<unknown> | null = null;
  startNewer = (event) => {
    if (event.type !== "inspection-start" || event.generation !== 1 || newer) return;
    newer = fixture.orchestrator.reconnect("openrouter");
  };

  const older = fixture.orchestrator.inspectStartup();
  await older;
  assert.ok(newer);
  await newer;

  assert.deepEqual(adapter.calls, ["openrouter.reconnect", "openrouter.reconnect"]);
  assert.equal(
    fixture.events.filter((event) =>
      event.type === "inspection-start" && event.generation === 1
    ).length,
    1,
  );
  assert.equal(fixture.clock.activeTimers(), 0);
});

test("a reentrant newer generation stops the remaining old authoritative events", async () => {
  const primary = connection();
  const secondary = connection("connection-secondary", "acct_secondary");
  const adapter = new FakeAdapter();
  adapter.inspectionScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(secondary, request),
  ];
  adapter.reconnectScripts = [
    (request) => inspected(primary, request),
    (request) => inspected(secondary, request),
  ];
  const timeline: string[] = [];
  let handleEvent: ((event: Record<string, unknown>) => void) | null = null;
  const fixture = await setupFixture({
    state: configuredState({ connections: [primary, secondary] }),
    adapter,
    onEvent: (event) => handleEvent?.(event),
  });
  let newer: Promise<unknown> | null = null;
  handleEvent = (event) => {
    timeline.push(`${String(event.type)}:${String(event.generation)}`);
    if (event.type !== "inspection-end" || event.generation !== 1 || newer) return;
    timeline.push("new-generation-requested");
    newer = fixture.orchestrator.reconnect("openrouter");
  };

  const older = fixture.orchestrator.inspectStartup();
  await older;
  assert.ok(newer);
  await newer;
  const requestIndex = timeline.indexOf("new-generation-requested");

  assert.notEqual(requestIndex, -1);
  assert.deepEqual(
    timeline.slice(requestIndex + 1).filter((entry) => entry === "inspection-end:1"),
    [],
  );
  assert.equal(fixture.clock.activeTimers(), 0);
});

// ---------------------------------------------------------------------------
// Task 6A — safe Kimi route and model decoding
// ---------------------------------------------------------------------------

const KIMI_DESCRIPTOR: BackendDescriptor = {
  id: "kimi-code",
  displayName: "Kimi Code",
  maturity: "preview",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "provider-managed",
  capabilities: { models: true, tools: true, reasoning: true },
};

class FakeKimiAdapter implements BackendAdapter {
  readonly backendId = "kimi-code" as const;
  readonly calls: string[] = [];
  inspectionScripts: InspectionScript[] = [];
  models: readonly BackendModelDescriptor[] = [];

  inspect(request: InspectionRequest): Promise<ProviderInspection> {
    this.calls.push("kimi-code.inspect");
    const script = this.inspectionScripts.shift();
    if (!script) return Promise.reject(new Error("missing deterministic kimi inspection script"));
    return Promise.resolve().then(() => script(request));
  }

  async connect(): Promise<ProviderCandidate> {
    throw new Error("connect must not be called by startup inspection");
  }

  async listModels(): Promise<readonly BackendModelDescriptor[]> {
    this.calls.push("kimi-code.listModels");
    return structuredClone(this.models);
  }

  async activate(): Promise<CandidateProviderState> {
    throw new Error("activate must not be called by startup inspection");
  }

  reconnect(request: InspectionRequest): Promise<ProviderInspection> {
    return this.inspect(request);
  }

  async logout(): Promise<void> {
    this.calls.push("kimi-code.logout");
  }

  async discardCandidate(): Promise<void> {
    this.calls.push("kimi-code.discardCandidate");
  }
}

function kimiRegistry(adapter: FakeKimiAdapter): BackendRegistry {
  return new BackendRegistry([
    { descriptor: KIMI_DESCRIPTOR, adapter },
    { descriptor: ANTHROPIC_DESCRIPTOR },
  ]);
}

function kimiConnection(
  overrides: Partial<ProviderConnectionStateV1> = {},
): ProviderConnectionStateV1 {
  return {
    id: "kimi-connection",
    backendId: "kimi-code",
    enabled: true,
    maturity: "preview",
    credentialSlot: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    accountFingerprint: "acct_kimi_primary",
    accountFingerprintState: "verified",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    lastHealth: null,
    ...overrides,
  };
}

function kimiRoute(overrides: Partial<RouteIdentityV1> = {}): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_kimi_primary",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    resolutionState: "resolved",
    ...overrides,
  };
}

function kimiState(options: {
  defaultRoute?: RouteIdentityV1 | null;
} = {}): ProviderSetupStateV2 {
  return {
    schemaVersion: 2,
    revision: 0,
    lifecycle: "configured",
    connections: [kimiConnection()],
    defaultRoute: options.defaultRoute === undefined ? kimiRoute() : options.defaultRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function kimiInspected(
  owner: ProviderConnectionStateV1,
  request: InspectionRequest,
): ProviderInspection {
  const observedHealth = health(request.generation);
  const headline = deriveProviderHeadline(observedHealth);
  return {
    backendId: "kimi-code",
    connectionId: owner.id,
    health: observedHealth,
    headline,
    accountFingerprint: owner.accountFingerprint,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    routeEligible: headline === "ready",
    retryable: true,
    explanationCode: `fixture-${headline}`,
  };
}

function kimiModel(
  requestedModelId: string,
  canonicalModelId = requestedModelId,
): BackendModelDescriptor {
  return {
    backendId: "kimi-code",
    requestedModelId,
    canonicalModelId,
    displayName: requestedModelId,
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  };
}

function kimiActivation(
  route: RouteIdentityV1,
  state: ProviderSetupStateV2 | null,
): ActivationDouble {
  const calls: ProviderActivationRequest[] = [];
  return {
    calls,
    async activate(request) {
      calls.push(request);
      return { persisted: true, route, state, warnings: [] };
    },
  };
}

test("kimi candidate activation preserves the exact kimi route and billing realm", async () => {
  const safeRoute = kimiRoute();
  const secret = "secret-extra-kimi-route-field";
  const coordinatorRoute = { ...safeRoute, secret } as RouteIdentityV1;
  const activatedState = kimiState({ defaultRoute: safeRoute });
  activatedState.revision = 1;
  const fixture = await setupFixture({
    state: kimiState(),
    registry: kimiRegistry(new FakeKimiAdapter()),
    activationCoordinator: kimiActivation(coordinatorRoute, activatedState),
  });

  await fixture.orchestrator.activateCandidate({
    backendId: "kimi-code",
    expectedRevision: 0,
    candidate: "candidate-kimi-route-event",
    expectedRequestedModelId: "k3",
    selectedCanonicalModelId: "k3",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    persistence: "persisted",
  });
  const activationEvent = fixture.events.find((event) => event.type === "candidate-activation");

  assert.ok(activationEvent, "kimi activation must emit the safe-route event");
  assert.deepEqual(activationEvent.route, safeRoute);
  assert.equal(activationEvent.backendId, "kimi-code");
  assert.equal(activationEvent.connectionId, "kimi-connection");
  const serialized = JSON.stringify(activationEvent);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("openrouter"), false);
});

test("every catalog-gated kimi model id survives the safe-route projection", async () => {
  for (const modelId of ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]) {
    const safeRoute = kimiRoute({ requestedModelId: modelId, canonicalModelId: modelId });
    const fixture = await setupFixture({
      state: kimiState({ defaultRoute: null }),
      registry: kimiRegistry(new FakeKimiAdapter()),
      activationCoordinator: kimiActivation(safeRoute, null),
    });

    await fixture.orchestrator.activateCandidate({
      backendId: "kimi-code",
      expectedRevision: 0,
      candidate: `candidate-${modelId}`,
      expectedRequestedModelId: modelId,
      selectedCanonicalModelId: modelId,
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      persistence: "persisted",
    });
    const activationEvent = fixture.events.find((event) => event.type === "candidate-activation");

    assert.ok(activationEvent, `kimi model ${modelId} must project a safe route`);
    assert.deepEqual(activationEvent.route, safeRoute);
  }
});

function observedKimiRegistry(
  adapter: FakeKimiAdapter,
  openrouter: FakeAdapter,
): BackendRegistry {
  return new BackendRegistry([
    { descriptor: KIMI_DESCRIPTOR, adapter },
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: openrouter },
    { descriptor: ANTHROPIC_DESCRIPTOR },
  ]);
}

const KIMI_CATALOG_IDS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] as const;

test("unsafe, mismatched, or openrouter-fallback kimi routes never emit a safe-route event", async () => {
  const cases: Array<{ name: string; route: RouteIdentityV1 }> = [
    {
      name: "kimi backend on the openrouter billing realm",
      route: kimiRoute({ billingRealm: "openrouter-payg" }),
    },
    {
      name: "openrouter backend on the kimi billing realm",
      route: kimiRoute({ backendId: "openrouter" }),
    },
    {
      name: "unknown kimi model",
      route: kimiRoute({ requestedModelId: "k9", canonicalModelId: "k9" }),
    },
    {
      name: "non-catalog canonical model",
      route: kimiRoute({ canonicalModelId: "vendor/alien" }),
    },
    {
      name: "cross-paired catalog ids k3 -> kimi-for-coding",
      route: kimiRoute({ requestedModelId: "k3", canonicalModelId: "kimi-for-coding" }),
    },
    {
      name: "cross-paired catalog ids kimi-for-coding -> k3",
      route: kimiRoute({ requestedModelId: "kimi-for-coding", canonicalModelId: "k3" }),
    },
    {
      name: "cross-paired catalog ids k3-256k -> k3",
      route: kimiRoute({ requestedModelId: "k3-256k", canonicalModelId: "k3" }),
    },
    {
      name: "ambiguous legacy-unverified kimi route",
      route: kimiRoute({ canonicalModelId: null, resolutionState: "legacy-unverified" }),
    },
  ];
  for (const entry of cases) {
    const openrouter = new FakeAdapter();
    const fixture = await setupFixture({
      state: kimiState(),
      registry: observedKimiRegistry(new FakeKimiAdapter(), openrouter),
      activationCoordinator: kimiActivation(entry.route, null),
    });

    await fixture.orchestrator.activateCandidate({
      backendId: "kimi-code",
      expectedRevision: 0,
      candidate: "candidate-unsafe-kimi-route",
      expectedRequestedModelId: "k3",
      selectedCanonicalModelId: "k3",
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      persistence: "persisted",
    });

    assert.equal(
      fixture.events.some((event) => event.type === "candidate-activation"),
      false,
      `${entry.name} must not emit a candidate-activation event`,
    );
    assert.deepEqual(openrouter.calls, [], `${entry.name} must not fall back to openrouter`);
  }
});

test("kimi catalog normalization binds each requested id to its identical canonical id", async () => {
  const { api } = await setupFixture();
  const identityPairs = KIMI_CATALOG_IDS.map((modelId) => kimiModel(modelId));
  const crossPairs = [
    kimiModel("k3", "kimi-for-coding"),
    kimiModel("kimi-for-coding", "k3"),
    kimiModel("k3-256k", "k3"),
    kimiModel("kimi-for-coding-highspeed", "kimi-for-coding"),
    kimiModel("k3", "vendor/alien"),
    kimiModel("k9"),
  ];
  const openrouterAlias = model("vendor/requested", "vendor/canonical");

  const normalized = api.normalizeModelList([
    crossPairs[0],
    ...identityPairs,
    ...crossPairs.slice(1),
    openrouterAlias,
  ]);

  assert.deepEqual(normalized, [...identityPairs, openrouterAlias]);
  for (const crossPair of crossPairs) {
    assert.deepEqual(
      api.normalizeModelList([crossPair]),
      [],
      `${crossPair.requestedModelId} -> ${crossPair.canonicalModelId} must fail closed`,
    );
  }
});

test("a legacy-unverified kimi route is never auto-promoted and makes zero kimi or openrouter calls", async (t) => {
  const cases: Array<{
    name: string;
    requestedModelId: string;
    models: readonly BackendModelDescriptor[];
  }> = [
    {
      name: "exact catalog match that would resolve for openrouter",
      requestedModelId: "k3",
      models: [kimiModel("k3")],
    },
    {
      name: "unknown kimi model",
      requestedModelId: "k9",
      models: [kimiModel("k9"), kimiModel("k3")],
    },
    {
      name: "cross-paired catalog ids",
      requestedModelId: "k3",
      models: [kimiModel("k3", "kimi-for-coding")],
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const legacyRoute = kimiRoute({
        requestedModelId: entry.requestedModelId,
        canonicalModelId: null,
        resolutionState: "legacy-unverified",
      });
      const adapter = new FakeKimiAdapter();
      const openrouter = new FakeAdapter();
      const owner = kimiConnection();
      adapter.inspectionScripts = [(request) => kimiInspected(owner, request)];
      adapter.models = entry.models;
      const fixture = await setupFixture({
        state: kimiState({ defaultRoute: legacyRoute }),
        registry: observedKimiRegistry(adapter, openrouter),
      });
      const startup = await fixture.orchestrator.inspectStartup();
      assert.equal(startup.mode, "route-choice-required");
      assert.deepEqual(adapter.calls, ["kimi-code.inspect"]);
      const before = JSON.stringify(fixture.stateStore.read());
      fixture.events.splice(0);

      const first = await fixture.orchestrator.resolveLegacyDefaultRoute();
      const repeated = await fixture.orchestrator.resolveLegacyDefaultRoute();

      assert.equal(first.mode, "route-choice-required");
      assert.equal(repeated.mode, "route-choice-required");
      assert.deepEqual(first.readyRoutes, []);
      assert.deepEqual(first.defaultRoute, legacyRoute);
      assert.equal(JSON.stringify(fixture.stateStore.read()), before);
      assert.equal(fixture.stateStore.read().defaultRoute?.resolutionState, "legacy-unverified");
      assert.deepEqual(adapter.calls, ["kimi-code.inspect"], "zero kimi listModels calls");
      assert.deepEqual(openrouter.calls, [], "zero openrouter fallback calls");
      assert.deepEqual(fixture.activationCoordinator.calls, []);
      assert.deepEqual(fixture.events, [
        {
          version: 1,
          type: "route-choice-required",
          generation: first.generation,
          routeIds: [JSON.stringify(legacyRoute)],
        },
        {
          version: 1,
          type: "route-choice-required",
          generation: repeated.generation,
          routeIds: [JSON.stringify(legacyRoute)],
        },
      ]);
      assert.equal(fixture.clock.activeTimers(), 0);
    });
  }
});

test("openrouter model normalization and rejection behavior stays byte-compatible", async () => {
  async function resolveLegacy(catalog: readonly BackendModelDescriptor[]) {
    const state = migrateLegacyOpenRouterState(
      { mainModel: "vendor/legacy-requested" },
      { connectionId: "legacy-byte-compat" },
    );
    const adapter = new FakeAdapter();
    adapter.inspectionScripts = [(request) => inspected(state.connections[0]!, request, {
      accountFingerprint: "acct_verified_byte_compat",
    })];
    adapter.models = catalog;
    const fixture = await setupFixture({ state, adapter });
    await fixture.orchestrator.inspectStartup();
    const result = await fixture.orchestrator.resolveLegacyDefaultRoute();
    return {
      result: JSON.stringify(result),
      route: JSON.stringify(fixture.stateStore.read().defaultRoute),
      state: JSON.stringify(fixture.stateStore.read()),
      events: JSON.stringify(fixture.events),
      calls: JSON.stringify(adapter.calls),
      resolved: fixture.stateStore.read().defaultRoute,
      mode: result.mode,
    };
  }
  const control = await resolveLegacy([
    model("vendor/legacy-requested", "vendor/canonical-safe"),
  ]);
  const mixed = await resolveLegacy([
    kimiModel("k3"),
    kimiModel("k3", "kimi-for-coding"),
    kimiModel("k9"),
    model("vendor/legacy-requested", "vendor/canonical-safe"),
  ]);

  assert.equal(control.mode, "ready");
  assert.equal(control.resolved?.backendId, "openrouter");
  assert.equal(control.resolved?.canonicalModelId, "vendor/canonical-safe");
  assert.equal(control.resolved?.billingRealm, "openrouter-payg");
  assert.equal(mixed.result, control.result);
  assert.equal(mixed.route, control.route);
  assert.equal(mixed.state, control.state);
  assert.equal(mixed.events, control.events);
  assert.equal(mixed.calls, control.calls);
  assert.equal(control.state.includes("kimi"), false);
});
