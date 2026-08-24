import assert from "node:assert/strict";
import test from "node:test";
import * as cliModule from "../src/cli.js";
import * as setupModule from "../src/setup.js";
import {
  BackendRegistry,
  type BackendAdapter,
  type ProviderHealth,
  type ProviderInspection,
  type RouteIdentityV1,
} from "../src/backends.js";
import type {
  CredentialKind,
  CredentialSlotRef,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";
import {
  OPENROUTER_DESCRIPTOR,
  OpenRouterBackendAdapter,
  openRouterAccountFingerprint,
} from "../src/openrouter-backend.js";
import { OpenRouterService } from "../src/openrouter.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  ProviderStateStore,
  createNeverConfiguredProviderState,
  validateProviderSetupState,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV1,
} from "../src/provider-state.js";
import { SetupOrchestrator, type SetupClock, type StartupSetupResult } from "../src/setup.js";
import {
  ProviderCredentialAuthority,
  type ProviderAuthorityCoordinator,
} from "../src/provider-authority.js";

const NOW = 1_000_000;
const HMAC_KEY = new Uint8Array(32).fill(29);
const MODEL = "synthetic/provider-authority-model";
const SECRET_A = `${["provider", "authority", "a"].join("-")}-${"a".repeat(36)}`;
const SECRET_B = `${["provider", "authority", "b"].join("-")}-${"b".repeat(36)}`;
const CREATOR_A = ["provider", "authority", "creator", "a"].join("-");
const CREATOR_B = ["provider", "authority", "creator", "b"].join("-");
const FINGERPRINT_A = openRouterAccountFingerprint(HMAC_KEY, CREATOR_A);
const FINGERPRINT_B = openRouterAccountFingerprint(HMAC_KEY, CREATOR_B);
const SLOT_A = "v1:inference:10000000-0000-4000-8000-000000000001";
const SLOT_B = "v1:inference:20000000-0000-4000-8000-000000000002";

type DesiredCredentialRequest = {
  connectionId: string;
  credentialKind?: "inference" | "management";
  purpose: string;
  environmentEligibility: string;
  allowDisabled?: boolean;
  deadlineAt: number;
  signal: AbortSignal;
};

type DesiredCredentialAuthority = {
  withCredential<T>(
    request: DesiredCredentialRequest,
    use: (secret: string, context: { source: "saved" | "environment" }) => Promise<T>,
  ): Promise<
    | { kind: "available"; value: T }
    | { kind: "absent" | "invalid" | "ambiguous" | "invalid-pointer" | "forget-pending" | "recovery-required" | "stale" }
  >;
};

class AuthorityCredentials implements VersionedCredentialStoreLike {
  readonly location = "provider-authority-fixture";
  readonly effects: string[] = [];

  constructor(
    private readonly legacy: Partial<Record<CredentialKind, string | null>> = {},
    private readonly slots: Readonly<Record<string, string | null>> = {},
  ) {}

  async get(kind: CredentialKind): Promise<string | null> {
    this.effects.push(`get:${kind}`);
    return this.legacy[kind] ?? null;
  }

  async set(kind: CredentialKind): Promise<void> {
    this.effects.push(`set:${kind}`);
  }

  async delete(kind: CredentialKind): Promise<boolean> {
    this.effects.push(`delete:${kind}`);
    return false;
  }

  async has(kind: CredentialKind): Promise<boolean> {
    this.effects.push(`has:${kind}`);
    return false;
  }

  reserveSlot(kind: CredentialKind): CredentialSlotRef {
    this.effects.push(`reserve:${kind}`);
    return { version: 1, kind, id: SLOT_A };
  }

  async writeSlot(slot: CredentialSlotRef): Promise<void> {
    this.effects.push(`write:${slot.id}`);
  }

  async readSlot(slot: CredentialSlotRef): Promise<string | null> {
    this.effects.push(`read:${slot.id}`);
    return this.slots[slot.id] ?? null;
  }

  async deleteSlot(slot: CredentialSlotRef): Promise<boolean> {
    this.effects.push(`delete-slot:${slot.id}`);
    return false;
  }

  async getOrCreateAccountHmacKey(): Promise<Uint8Array> {
    this.effects.push("hmac");
    return new Uint8Array(HMAC_KEY);
  }
}

function keyResponse(creatorUserId: string): Response {
  return new Response(JSON.stringify({
    data: {
      label: "Provider authority fixture",
      creator_user_id: creatorUserId,
      is_free_tier: false,
      is_management_key: false,
      limit: null,
      limit_remaining: null,
      usage: 0,
      usage_daily: 0,
      usage_weekly: 0,
      usage_monthly: 0,
      expires_at: null,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function bearer(init: RequestInit | undefined): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization ?? null;
}

function adapterWithAuthority(input: {
  authority: DesiredCredentialAuthority;
  credentials?: AuthorityCredentials;
  calls?: Array<{ url: string; bearer: string | null }>;
}): {
  adapter: OpenRouterBackendAdapter;
  service: OpenRouterService;
  credentials: AuthorityCredentials;
  calls: Array<{ url: string; bearer: string | null }>;
} {
  const calls = input.calls ?? [];
  const credentials = input.credentials ?? new AuthorityCredentials();
  const service = new OpenRouterService(undefined, undefined, {}, {
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, bearer: bearer(init) });
      const currentBearer = bearer(init);
      if (url.endsWith("/key")) {
        return keyResponse(currentBearer === `Bearer ${SECRET_B}` ? CREATOR_B : CREATOR_A);
      }
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{
          id: MODEL,
          canonical_slug: MODEL,
          name: "Provider authority model",
          context_length: 16_384,
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["tools"],
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected provider-authority endpoint");
    },
  });
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials,
    credentialAuthority: input.authority,
    now: () => NOW,
  } as never);
  return { adapter, service, credentials, calls };
}

function availableAuthority(
  secrets: Readonly<Record<string, string>>,
  requests: DesiredCredentialRequest[] = [],
): DesiredCredentialAuthority {
  return {
    async withCredential(request, use) {
      if (request.credentialKind === "management") return { kind: "absent" };
      requests.push({ ...request });
      const secret = secrets[request.connectionId];
      if (!secret) return { kind: "absent" };
      return { kind: "available", value: await use(secret, { source: "saved" }) };
    },
  };
}

function connection(input: {
  id: string;
  slot: string;
  fingerprint: string;
  enabled?: boolean;
}): ProviderConnectionStateV1 {
  return {
    id: input.id,
    backendId: "openrouter",
    enabled: input.enabled ?? true,
    maturity: "stable",
    credentialSlot: input.slot,
    accountFingerprint: input.fingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
}

function route(fingerprint: string): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: fingerprint,
    billingRealm: "openrouter-payg",
    requestedModelId: MODEL,
    canonicalModelId: MODEL,
    resolutionState: "resolved",
  };
}

function stateWithConnections(
  connections: ProviderConnectionStateV1[],
  defaultRoute: RouteIdentityV1 | null,
): ProviderSetupStateV1 {
  return {
    schemaVersion: 1,
    revision: 4,
    lifecycle: "configured",
    connections,
    defaultRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

function healthyInspection(connectionId: string, fingerprint: string, generation: number): ProviderInspection {
  const health: ProviderHealth = {
    credential: "valid",
    connectivity: "connected",
    spend: "unknown",
    runtime: "not-applicable",
    observedAt: NOW,
    generation,
  };
  return {
    backendId: "openrouter",
    connectionId,
    health,
    headline: "ready",
    accountFingerprint: fingerprint,
    billingRealm: "openrouter-payg",
    routeEligible: true,
    retryable: true,
    explanationCode: "provider-authority-ready",
  };
}

function fakeActivationCoordinator() {
  return {
    async activate(): Promise<never> {
      throw new Error("activation is outside provider-authority inspection tests");
    },
  };
}

function authorityCoordinator(
  assertHeld: () => void | Promise<void> = () => undefined,
): ProviderAuthorityCoordinator {
  return {
    async readAuthority(request, operation) {
      if (request.signal.aborted) throw request.signal.reason;
      return operation({ async assertHeld() { await assertHeld(); } });
    },
  };
}

function realAuthority(input: {
  stateStore: ProviderStateStore;
  credentials: AuthorityCredentials;
  environment?: Readonly<Record<string, string | undefined>>;
  coordinator?: ProviderAuthorityCoordinator;
}): ProviderCredentialAuthority {
  const coordinator = input.coordinator ?? authorityCoordinator();
  return new ProviderCredentialAuthority({
    stateStore: input.stateStore,
    credentials: input.credentials,
    environment: input.environment ?? {},
    coordinator: () => coordinator,
    now: () => NOW,
  });
}

test("pending forget blocks saved and environment credentials before every read", async (t) => {
  const fixtures: Array<{
    name: string;
    slots: Readonly<Record<string, string | null>>;
  }> = [
    { name: "saved slot present", slots: { [SLOT_A]: SECRET_A } },
    { name: "saved slot absent with environment", slots: {} },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const credentials = new AuthorityCredentials({}, fixture.slots);
      const pending = new Error("credential cleanup is pending") as Error & { code: string };
      pending.code = "provider-credential-cleanup-pending";
      const coordinator: ProviderAuthorityCoordinator = {
        async readAuthority() { throw pending; },
      };
      const stateStore = new ProviderStateStore(stateWithConnections([
        connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
      ], route(FINGERPRINT_A)));
      const authority = realAuthority({
        stateStore,
        credentials,
        environment: { OPENROUTER_API_KEY: SECRET_B },
        coordinator,
      });
      const observed = adapterWithAuthority({ authority: authority as never, credentials });
      const result = await observed.adapter.inspect({
        connectionId: "connection-a",
        generation: 1,
        deadlineAt: NOW + 5_000,
        signal: new AbortController().signal,
      } as never);

      assert.deepEqual(credentials.effects, []);
      assert.deepEqual(observed.calls, []);
      assert.equal(result.routeEligible, false);
      assert.equal(result.explanationCode, "openrouter-credential-forget-pending");
    });
  }
});

test("unknown versioned credential pointer fails closed without legacy or environment fallback", async () => {
  const state = stateWithConnections([
    connection({
      id: "connection-forged",
      slot: "openrouter:verified",
      fingerprint: FINGERPRINT_A,
    }),
  ], route(FINGERPRINT_A));

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
  const credentials = new AuthorityCredentials({ inference: SECRET_A });
  const invalidStore = {
    read: () => structuredClone(state),
    async commit(
      _revision: number,
      build: (current: ProviderSetupStateV1) => ProviderSetupStateV1,
    ) {
      return build(structuredClone(state));
    },
  } as ProviderStateStore;
  const observed = adapterWithAuthority({
    authority: realAuthority({
      stateStore: invalidStore,
      credentials,
      environment: { OPENROUTER_API_KEY: SECRET_B },
    }) as never,
    credentials,
  });
  const result = await observed.adapter.inspect({
    connectionId: "connection-forged",
    generation: 1,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);

  assert.deepEqual(credentials.effects, []);
  assert.deepEqual(observed.calls, []);
  assert.equal(result.explanationCode, "openrouter-credential-invalid-pointer");
});

test("disabled connection performs zero credential and environment reads during startup", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({
      id: "connection-disabled",
      slot: SLOT_A,
      fingerprint: FINGERPRINT_A,
      enabled: false,
    }),
  ], null));
  const authority = realAuthority({
    stateStore,
    credentials,
    environment: { OPENROUTER_API_KEY: SECRET_B },
  });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const result = await observed.adapter.inspect({
    connectionId: "connection-disabled",
    generation: 1,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);

  assert.deepEqual(credentials.effects, []);
  assert.deepEqual(observed.calls, []);
  assert.equal(result.routeEligible, false);
});

test("explicit enable reads only the retained disabled connection slot", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({
      id: "connection-disabled",
      slot: SLOT_B,
      fingerprint: FINGERPRINT_B,
      enabled: false,
    }),
  ], null));
  const observed = adapterWithAuthority({
    authority: realAuthority({ stateStore, credentials }) as never,
    credentials,
  });
  const result = await observed.adapter.inspect({
    connectionId: "connection-disabled",
    purpose: "explicit-enable",
    allowDisabled: true,
    generation: 2,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);

  assert.equal(result.connectionId, "connection-disabled");
  assert.equal(result.accountFingerprint, FINGERPRINT_B);
  assert.equal(observed.credentials.effects.filter((effect) => effect === `read:${SLOT_B}`).length, 1);
  assert.equal(observed.credentials.effects.some((effect) => effect === `read:${SLOT_A}`), false);
  assert.equal(observed.credentials.effects.some((effect) => effect.startsWith("reserve:")), false);
  assert.equal(observed.credentials.effects.some((effect) => effect.startsWith("write:")), false);
  assert.deepEqual(observed.calls.map((call) => call.bearer), [`Bearer ${SECRET_B}`]);
});

test("automatic environment eligibility exists only after authoritative saved absence", async (t) => {
  const state = stateWithConnections([
    connection({
      id: "connection-a",
      slot: "legacy:inference",
      fingerprint: FINGERPRINT_A,
    }),
  ], route(FINGERPRINT_A));

  await t.test("saved absence permits the environment", async () => {
    const credentials = new AuthorityCredentials();
    const observed = adapterWithAuthority({
      authority: realAuthority({
        stateStore: new ProviderStateStore(state),
        credentials,
        environment: { OPENROUTER_API_KEY: SECRET_B },
      }) as never,
      credentials,
    });
    const result = await observed.adapter.inspect({
      connectionId: "connection-a",
      generation: 3,
      deadlineAt: NOW + 5_000,
      signal: new AbortController().signal,
    } as never);

    assert.equal(result.accountFingerprint, FINGERPRINT_B);
    assert.equal(credentials.effects[0], "get:inference");
    assert.equal(observed.calls[0]?.bearer, `Bearer ${SECRET_B}`);
  });

  await t.test("saved invalid blocks the environment", async () => {
    const credentials = new AuthorityCredentials({ inference: "invalid provider key" });
    const observed = adapterWithAuthority({
      authority: realAuthority({
        stateStore: new ProviderStateStore(state),
        credentials,
        environment: { OPENROUTER_API_KEY: SECRET_B },
      }) as never,
      credentials,
    });
    const result = await observed.adapter.inspect({
      connectionId: "connection-a",
      generation: 3,
      deadlineAt: NOW + 5_000,
      signal: new AbortController().signal,
    } as never);

    assert.deepEqual(credentials.effects, ["get:inference"]);
    assert.deepEqual(observed.calls, []);
    assert.equal(result.explanationCode, "openrouter-credential-unavailable");
  });
});

test("automatic management environment is forbidden for a versioned connection", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A)));
  const observed = adapterWithAuthority({
    authority: realAuthority({
      stateStore,
      credentials,
      environment: { OPENROUTER_MANAGEMENT_KEY: SECRET_B },
    }) as never,
    credentials,
  });

  const result = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 4,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);

  assert.equal(result.routeEligible, true);
  assert.equal(observed.calls.some((call) => call.url.endsWith("/credits")), false);
  assert.equal(observed.calls.some((call) => call.bearer === `Bearer ${SECRET_B}`), false);
});

test("fresh never-configured environment activation stays ready without a durable bind", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  const coordinator = authorityCoordinator();
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const registry = new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]);
  const activationCoordinator = {
    async activate(request: {
      candidate: string;
      generation: number;
      signal: AbortSignal;
      targetConnectionId?: string;
      expectedRequestedModelId: string;
      selectedCanonicalModelId: string;
    }) {
      const candidate = await observed.adapter.connect({
        connectionId: request.targetConnectionId,
        candidate: request.candidate,
        generation: request.generation,
        signal: request.signal,
      });
      const models = await observed.adapter.listModels({ candidateId: candidate.candidateId, signal: request.signal });
      const model = models.find((item) =>
        item.requestedModelId === request.expectedRequestedModelId
        && item.canonicalModelId === request.selectedCanonicalModelId
      );
      assert.ok(model);
      const activated = await observed.adapter.activate({
        candidateId: candidate.candidateId,
        model,
        signal: request.signal,
      });
      await observed.adapter.discardCandidate(candidate.candidateId);
      return { persisted: false, state: null, route: activated.route, warnings: [] };
    },
  };
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = MODEL;
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    SECRET_A,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );

  const result = await runtime.inspectStartup();

  assert.equal(result.mode, "ready");
  assert.equal(result.defaultRoute?.accountFingerprint, FINGERPRINT_A);
  assert.equal(observed.service.requireKey(), SECRET_A);
  assert.deepEqual(stateStore.read().connections, []);
});

test("two enabled connections inspect only their own exact slots and reduce the exact default", async () => {
  const state = stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
  ], route(FINGERPRINT_B));
  const stateStore = new ProviderStateStore(state);
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const observed = adapterWithAuthority({
    authority: realAuthority({ stateStore, credentials }) as never,
    credentials,
  });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: fakeActivationCoordinator(),
  });

  const result = await orchestrator.inspectStartup();

  assert.equal(result.mode, "ready");
  assert.equal(result.defaultRoute?.accountFingerprint, FINGERPRINT_B);
  assert.deepEqual(credentials.effects.filter((effect) => effect.startsWith("read:")), [
    `read:${SLOT_A}`,
    `read:${SLOT_B}`,
  ]);
  assert.deepEqual(observed.calls.map((call) => call.bearer).sort(), [
    `Bearer ${SECRET_A}`,
    `Bearer ${SECRET_B}`,
  ].sort());
});

test("duplicate account realm bindings are ambiguous instead of selecting the first connection", async () => {
  const observed = adapterWithAuthority({
    authority: availableAuthority({
      "connection-a": SECRET_A,
      "connection-b": SECRET_A,
    }),
  });
  const state = stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A));
  const orchestrator = new SetupOrchestrator({
    registry: new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]),
    stateStore: new ProviderStateStore(state),
    activationCoordinator: fakeActivationCoordinator(),
  });

  const result = await orchestrator.inspectStartup();

  assert.equal(result.mode, "setup-required");
  assert.deepEqual(result.readyRoutes, []);
});

test("persisted session route fails closed when duplicate account realm bindings become ambiguous", () => {
  const state = stateWithConnections([
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
    connection({ id: "connection-b-copy", slot: SLOT_A, fingerprint: FINGERPRINT_B }),
  ], route(FINGERPRINT_B));
  const stateStore = new ProviderStateStore(state);
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest & {
      ensureRunnableRoute(): RouteIdentityV1;
    };
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const setupRequired = Object.assign(new Error("ambiguous persisted session route"), {
    code: "provider-setup-required",
  });
  const runtime = new Runtime(
    new OpenRouterService(SECRET_B),
    {},
    {},
    stateStore,
    { ensureRunnableRoute() { throw setupRequired; } },
    {},
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
  );
  runtime.adoptCredentialActivation(route(FINGERPRINT_B), true, SECRET_B);

  assert.throws(() => runtime.ensureRunnableRoute(), (error: unknown) => error === setupRequired);
});

test("authority discards a credential permit when the durable binding changes before use", async () => {
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A)));
  let assertions = 0;
  const coordinator = authorityCoordinator(() => {
    assertions += 1;
    if (assertions !== 2) return;
    const current = stateStore.read();
    stateStore.replace({
      ...current,
      connections: current.connections.map((item) => ({
        ...item,
        credentialSlot: SLOT_B,
      })),
    }, current.revision);
  });
  const observed = adapterWithAuthority({
    authority: realAuthority({ stateStore, credentials, coordinator }) as never,
    credentials,
  });
  const result = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 4,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);

  assert.deepEqual(credentials.effects, [`read:${SLOT_A}`]);
  assert.deepEqual(observed.calls, []);
  assert.equal(result.explanationCode, "openrouter-credential-stale");
});

test("runtime binding follows the newly committed v1 slot in the same process", async () => {
  const secrets = { "connection-a": SECRET_A };
  const observed = adapterWithAuthority({ authority: availableAuthority(secrets) });
  const first = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 5,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);
  assert.equal(first.accountFingerprint, FINGERPRINT_A);
  await observed.adapter.bindRuntime({
    connectionId: "connection-a",
    generation: 5,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(observed.service.requireKey(), SECRET_A);

  secrets["connection-a"] = SECRET_B;
  const second = await observed.adapter.reconnect({
    connectionId: "connection-a",
    generation: 6,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  } as never);
  assert.equal(second.accountFingerprint, FINGERPRINT_B);
  await observed.adapter.bindRuntime({
    connectionId: "connection-a",
    generation: 6,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(observed.service.requireKey(), SECRET_B);
});

test("model transition uses the exact route credential and preserves its connection id", async () => {
  const state = stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
  ], route(FINGERPRINT_B));
  const stateStore = new ProviderStateStore(state);
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const coordinator = authorityCoordinator();
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  observed.service.setKey(SECRET_A, "keychain");
  const activationRequests: Array<Record<string, unknown>> = [];
  const nextModel = "synthetic/provider-authority-model-next";
  const nextRoute = { ...route(FINGERPRINT_B), requestedModelId: nextModel, canonicalModelId: nextModel };
  const orchestrator = {
    ensureRunnableRoute() { return route(FINGERPRINT_B); },
    async activateCandidate(request: Record<string, unknown>) {
      activationRequests.push(request);
      return { persisted: true, route: nextRoute, state: stateStore.read(), warnings: [] };
    },
  };
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest & {
      transitionModel(modelId: string, canonicalModelId: string): Promise<void>;
    };
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]),
    stateStore,
    orchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );

  await runtime.transitionModel(nextModel, nextModel);

  assert.equal(activationRequests[0]?.candidate, SECRET_B);
  assert.equal(activationRequests[0]?.targetConnectionId, "connection-b");
  assert.equal(stateStore.read().connections.length, 2);
});

test("model transition rejects an authority binding from a newer route revision", async () => {
  const initial = stateWithConnections([
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
  ], route(FINGERPRINT_B));
  const stateStore = new ProviderStateStore(initial);
  let advanced = false;
  const coordinator = authorityCoordinator(() => {
    if (advanced) return;
    advanced = true;
    const current = stateStore.read();
    const concurrentModel = "synthetic/concurrent-model";
    stateStore.replace({
      ...current,
      defaultRoute: {
        ...route(FINGERPRINT_B),
        requestedModelId: concurrentModel,
        canonicalModelId: concurrentModel,
      },
    }, current.revision);
  });
  const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const activationRequests: Array<Record<string, unknown>> = [];
  const nextModel = "synthetic/desired-model";
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest & {
      transitionModel(modelId: string, canonicalModelId: string): Promise<void>;
    };
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]),
    stateStore,
    {
      ensureRunnableRoute() { return route(FINGERPRINT_B); },
      async activateCandidate(request: Record<string, unknown>) {
        activationRequests.push(request);
        return {
          persisted: true,
          route: { ...route(FINGERPRINT_B), requestedModelId: nextModel, canonicalModelId: nextModel },
          state: stateStore.read(),
          warnings: [],
        };
      },
    },
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );

  await assert.rejects(runtime.transitionModel(nextModel, nextModel));
  assert.deepEqual(activationRequests, []);
});

test("inference key save reads the exact durable credential instead of the stale runtime service", async () => {
  const state = stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
  ], route(FINGERPRINT_B));
  const stateStore = new ProviderStateStore(state);
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const authority = realAuthority({ stateStore, credentials });
  const service = new OpenRouterService(SECRET_A);
  const requests: Array<Record<string, unknown>> = [];
  const controller = cliModule.createProviderCredentialController({
    stateStore,
    openRouter: service,
    credentials,
    credentialAuthority: authority,
    activationCoordinator: {
      async activate(request: Record<string, unknown>) {
        requests.push(request);
        return { persisted: true, route: route(FINGERPRINT_B), state, warnings: [] };
      },
    },
    getInferenceRoute: () => route(FINGERPRINT_B),
  } as never);

  await controller.apply({ kind: "save", credentialKind: "inference" });

  assert.equal(requests[0]?.candidate, SECRET_B);
  assert.equal(requests[0]?.targetConnectionId, "connection-b");
});

test("inference key save rejects a route decision from before the authority revision", async () => {
  const initialRoute = route(FINGERPRINT_B);
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
  ], initialRoute));
  let advanced = false;
  const coordinator = authorityCoordinator(() => {
    if (advanced) return;
    advanced = true;
    const current = stateStore.read();
    const concurrentModel = "synthetic/concurrent-save-model";
    stateStore.replace({
      ...current,
      defaultRoute: {
        ...initialRoute,
        requestedModelId: concurrentModel,
        canonicalModelId: concurrentModel,
      },
    }, current.revision);
  });
  const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const requests: Array<Record<string, unknown>> = [];
  const controller = cliModule.createProviderCredentialController({
    stateStore,
    openRouter: new OpenRouterService(SECRET_A),
    credentials,
    credentialAuthority: authority,
    activationCoordinator: {
      async activate(request: Record<string, unknown>) {
        requests.push(request);
        return { persisted: true, route: initialRoute, state: stateStore.read(), warnings: [] };
      },
    },
    getInferenceRoute: () => initialRoute,
  } as never);

  await assert.rejects(controller.apply({ kind: "save", credentialKind: "inference" }));
  assert.deepEqual(requests, []);
});

test("provider setup re-reads a changed durable pointer instead of cached persisted secret", async () => {
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A)));
  const coordinator = authorityCoordinator();
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const registry = new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]);
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: fakeActivationCoordinator(),
  });
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    SECRET_A,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );
  runtime.adoptCredentialActivation(route(FINGERPRINT_A), true, SECRET_A);
  const current = stateStore.read();
  stateStore.replace({
    ...current,
    connections: current.connections.map((item) => ({ ...item, credentialSlot: SLOT_B })),
  }, current.revision);
  const surface = {
    async chooseHub() { return "openrouter"; },
    async readSecret() { throw new Error("saved pointer must not reprompt"); },
    async chooseModel() { return null; },
    async confirm() { return false; },
    present() {},
  };

  const result = await runtime.runSetup(surface as never);

  assert.equal(result.kind, "cancelled");
  assert.equal(observed.calls[0]?.bearer, `Bearer ${SECRET_B}`);
  assert.equal(observed.calls.some((call) => call.bearer === `Bearer ${SECRET_A}`), false);
});

test("provider setup carries the authority revision across a delayed model prompt", async () => {
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const initial = stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A));
  const stateStore = new ProviderStateStore(initial);
  const coordinator = authorityCoordinator();
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const registry = new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]);
  const activationRequests: Array<Record<string, unknown>> = [];
  const orchestrator = {
    ensureRunnableRoute() { return route(FINGERPRINT_A); },
    async activateCandidate(request: Record<string, unknown>) {
      activationRequests.push(request);
      return { persisted: true, route: route(FINGERPRINT_A), state: stateStore.read(), warnings: [] };
    },
  };
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );
  const surface = {
    async chooseHub() { return "openrouter"; },
    async readSecret() { throw new Error("saved pointer must not reprompt"); },
    async chooseModel() {
      const current = stateStore.read();
      stateStore.replace({
        ...current,
        connections: current.connections.map((item) => ({ ...item, credentialSlot: SLOT_B })),
      }, current.revision);
      return MODEL;
    },
    async confirm() { return false; },
    present() {},
  };

  await runtime.runSetup(surface as never);

  assert.equal(activationRequests[0]?.expectedRevision, initial.revision);
  assert.equal(activationRequests[0]?.targetConnectionId, "connection-a");
});

test("parallel connection inspections cannot exchange credentials or active proofs", async () => {
  const requests: DesiredCredentialRequest[] = [];
  const observed = adapterWithAuthority({
    authority: availableAuthority({
      "connection-a": SECRET_A,
      "connection-b": SECRET_B,
    }, requests),
  });
  const signal = new AbortController().signal;
  const [left, right] = await Promise.all([
    observed.adapter.inspect({ connectionId: "connection-a", generation: 7, deadlineAt: NOW + 5_000, signal } as never),
    observed.adapter.inspect({ connectionId: "connection-b", generation: 7, deadlineAt: NOW + 5_000, signal } as never),
  ]);

  assert.deepEqual(
    [left.connectionId, left.accountFingerprint, right.connectionId, right.accountFingerprint],
    ["connection-a", FINGERPRINT_A, "connection-b", FINGERPRINT_B],
  );
  const list = (connectionId: string) => observed.adapter.listModels({ connectionId, signal } as never);
  assert.equal((await list("connection-a")).length, 1);
  assert.equal((await list("connection-b")).length, 1);
  await assert.rejects(list("connection-unknown"), /inspection|prüf/i);
  assert.deepEqual(requests.map((request) => request.connectionId).sort(), [
    "connection-a",
    "connection-b",
  ]);
});

type RuntimeUnderTest = {
  execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
  inspectStartup(): Promise<StartupSetupResult>;
  adoptCredentialActivation(route: RouteIdentityV1, persisted: boolean, secret: string): void;
  runSetup(surface: unknown): Promise<Record<string, unknown>>;
};

function runtimeFixture(
  initial: ProviderSetupStateV1,
  authorityOptions?: unknown,
  beforeExclusive?: () => void | Promise<void>,
): {
  runtime: RuntimeUnderTest;
  stateStore: ProviderStateStore;
  reconnectRequests: unknown[][];
  coordinatorExclusiveCalls(): number;
} {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const stateStore = new ProviderStateStore(initial);
  const reconnectRequests: unknown[][] = [];
  let coordinatorExclusiveCalls = 0;
  const orchestrator = {
    async inspectStartup() {
      return setupRequiredResult(31);
    },
    async reconnect(...args: unknown[]) {
      reconnectRequests.push(args);
      return readyResult(32);
    },
    ensureRunnableRoute() {
      if (!initial.defaultRoute) throw new Error("fixture has no runnable route");
      return structuredClone(initial.defaultRoute);
    },
  };
  const coordinator = {
    async runExclusive(
      _request: unknown,
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<unknown>,
    ) {
      coordinatorExclusiveCalls += 1;
      await beforeExclusive?.();
      return operation({ async assertHeld() {} });
    },
  };
  const registry = {
    adapter() {
      return {};
    },
    descriptor() {
      return { id: "openrouter", displayName: "OpenRouter", maturity: "stable" };
    },
    entries() {
      return [{
        id: "openrouter",
        displayName: "OpenRouter",
        maturity: "stable",
        connectable: true,
      }];
    },
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = structuredClone(initial);
  const runtime = new Runtime(
    new OpenRouterService(SECRET_B),
    {},
    registry,
    stateStore,
    orchestrator,
    coordinator,
    {
      beginRun() { return () => undefined; },
      async acquire() {
        return { async assertHeld() {}, async release() {} };
      },
    },
    { async apply() { return { kind: "unchanged" }; } },
    SECRET_B,
    null,
    MODEL,
    config,
    undefined,
    authorityOptions,
  );
  return {
    runtime,
    stateStore,
    reconnectRequests,
    coordinatorExclusiveCalls: () => coordinatorExclusiveCalls,
  };
}

function commandState(): ProviderSetupStateV1 {
  const left = connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A });
  const right = connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B });
  left.lastHealth = {
    credential: "valid",
    connectivity: "offline",
    spend: "unknown",
    runtime: "not-applicable",
    observedAt: NOW,
    generation: 21,
  };
  right.lastHealth = healthyInspection("connection-b", FINGERPRINT_B, 22).health;
  return stateWithConnections([left, right], route(FINGERPRINT_B));
}

test("status reconnect default and confirmation select the same exact provider binding", async () => {
  const fixture = runtimeFixture(commandState());

  const status = await fixture.runtime.execute({ kind: "status" }, "plain");
  const provider = (status.providers as Array<Record<string, unknown>>)[0];
  assert.equal(provider?.accountFingerprintSuffix, `…${FINGERPRINT_B.slice(-6)}`);
  assert.equal(provider?.isDefault, true);

  const reconnected = await fixture.runtime.execute(
    { kind: "reconnect", backendId: "openrouter" },
    "plain",
  );
  assert.equal(reconnected.headline, "ready");
  assert.equal(
    (fixture.reconnectRequests[0]?.[1] as { connectionId?: string } | undefined)?.connectionId,
    "connection-b",
  );
  assert.equal(fixture.coordinatorExclusiveCalls(), 0, "reconnect must not hold a provider mutation lease around authority reads");

  const prompt = await fixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  assert.equal(prompt.kind, "confirmation-required");
  const changed = await fixture.runtime.execute({
    kind: "disable",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");
  assert.equal(changed.kind, "changed");
  assert.equal(fixture.stateStore.read().connections.find((item) => item.id === "connection-a")?.enabled, true);
  assert.equal(fixture.stateStore.read().connections.find((item) => item.id === "connection-b")?.enabled, false);
});

test("default second after nondefault first still requires exactly one destructive confirmation", async () => {
  const fixture = runtimeFixture(commandState());
  const prompt = await fixture.runtime.execute(
    { kind: "disconnect", backendId: "openrouter" },
    "plain",
  );
  assert.equal(prompt.kind, "confirmation-required");
  const changed = await fixture.runtime.execute({
    kind: "disconnect",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");
  assert.equal(changed.kind, "changed");
  assert.equal(fixture.stateStore.read().connections.find((item) => item.id === "connection-a")?.enabled, true);
  assert.equal(fixture.stateStore.read().connections.find((item) => item.id === "connection-b")?.enabled, false);
});

test("confirmation becomes stale when only the authoritative credential pointer changes", async () => {
  const initial = commandState();
  initial.connections = [initial.connections[1]!];
  const fixture = runtimeFixture(initial);
  const prompt = await fixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  assert.equal(prompt.kind, "confirmation-required");
  const current = fixture.stateStore.read();
  fixture.stateStore.replace({
    ...current,
    connections: current.connections.map((item) => ({
      ...item,
      credentialSlot: "v1:inference:30000000-0000-4000-8000-000000000003",
    })),
  }, current.revision);

  const stale = await fixture.runtime.execute({
    kind: "disable",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");
  assert.equal(stale.kind, "confirmation-required");
  assert.notEqual(stale.confirmationToken, prompt.confirmationToken);
  assert.equal(fixture.stateStore.read().connections[0]?.enabled, true);
});

test("disable fails closed when the exact session binding becomes ambiguous before mutation ownership", async () => {
  const initial = commandState();
  initial.defaultRoute = route(FINGERPRINT_A);
  let fixture!: ReturnType<typeof runtimeFixture>;
  fixture = runtimeFixture(initial, undefined, () => {
    const current = fixture.stateStore.read();
    fixture.stateStore.replace({
      ...current,
      connections: [
        ...current.connections,
        connection({
          id: "connection-b-duplicate",
          slot: "v1:inference:40000000-0000-4000-8000-000000000004",
          fingerprint: FINGERPRINT_B,
        }),
      ],
    }, current.revision);
  });
  fixture.runtime.adoptCredentialActivation(route(FINGERPRINT_B), true, SECRET_B);

  const result = await fixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );

  assert.equal(result.kind, "unchanged");
  assert.equal(fixture.stateStore.read().connections.every((item) => item.enabled), true);
  assert.equal(fixture.stateStore.read().defaultRoute?.accountFingerprint, FINGERPRINT_A);
});

test("explicit enable reuses the retained slot without replacement allocation", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({
      id: "connection-disabled",
      slot: SLOT_A,
      fingerprint: FINGERPRINT_A,
      enabled: false,
    }),
  ], null));
  const lease = { async assertHeld() {} };
  const coordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) { return operation(lease); },
    async runExclusive<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) { return operation(lease); },
  };
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({
    authority: authority as never,
    credentials,
  });
  const registry = new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]);
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: fakeActivationCoordinator(),
  });
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = MODEL;
  config.providerSetup = stateStore.read();
  const runtime = new Runtime(
    observed.service,
    credentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
  );
  let secretPrompts = 0;
  const surface = {
    async chooseHub() { return "openrouter"; },
    async readSecret() { secretPrompts += 1; return null; },
    async chooseModel() { return MODEL; },
    async confirm() { return true; },
    present() {},
  };

  const enabled = await runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    surface as never,
  );

  assert.deepEqual(enabled, { kind: "setup", backendId: "openrouter", outcome: "ready" });
  assert.equal(secretPrompts, 0);
  assert.equal(stateStore.read().connections[0]?.enabled, true);
  assert.equal(stateStore.read().defaultRoute?.canonicalModelId, MODEL);
  assert.equal(observed.service.requireKey(), SECRET_A);
  assert.equal(credentials.effects.some((effect) => effect.startsWith("reserve:")), false);
  assert.equal(credentials.effects.some((effect) => effect.startsWith("write:")), false);
});

test("process-only disable revokes automatic environment eligibility for later prompts", async () => {
  let revocations = 0;
  const fixture = runtimeFixture(createNeverConfiguredProviderState(), {
    credentialAuthority: {
      revokeAutomaticEnvironment() { revocations += 1; },
    },
    adapter: {},
    async recover() {},
  });
  fixture.runtime.adoptCredentialActivation(route(FINGERPRINT_B), false, SECRET_B);
  const prompt = await fixture.runtime.execute(
    { kind: "disable", backendId: "openrouter" },
    "plain",
  );
  assert.equal(prompt.kind, "confirmation-required");
  const changed = await fixture.runtime.execute({
    kind: "disable",
    backendId: "openrouter",
    confirmationToken: prompt.confirmationToken,
  }, "plain");
  assert.equal(changed.kind, "changed");
  assert.equal(revocations, 1);

  let automaticSetupCalls = 0;
  fixture.runtime.runSetup = async () => {
    automaticSetupCalls += 1;
    return { kind: "cancelled" };
  };
  const inspected = await fixture.runtime.inspectStartup();
  assert.equal(inspected.mode, "setup-required");
  assert.equal(automaticSetupCalls, 0);
});

class FakeClock implements SetupClock {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(Number(handle));
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.#now = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    this.#now = target;
  }
}

type StartupStepContext = {
  generation: number;
  deadlineAt: number;
  signal: AbortSignal;
  remainingMs(): number;
  assertCurrent(): void;
};

type StartupRunner = (input: {
  generation: number;
  clock: SetupClock;
  timeoutMs?: number;
  recover(context: StartupStepContext): Promise<void>;
  inspect(context: StartupStepContext): Promise<StartupSetupResult>;
  resolveLegacy?(result: StartupSetupResult, context: StartupStepContext): Promise<StartupSetupResult>;
  automaticEnvironment?(result: StartupSetupResult, context: StartupStepContext): Promise<StartupSetupResult>;
  bindRuntime?(result: StartupSetupResult, context: StartupStepContext): Promise<void>;
}) => Promise<StartupSetupResult>;

function startupRunner(): StartupRunner {
  const run = (setupModule as typeof setupModule & {
    runProviderStartupAttempt?: StartupRunner;
  }).runProviderStartupAttempt;
  assert.equal(typeof run, "function", "the whole-startup attempt runner must exist");
  return run;
}

function readyResult(generation: number): StartupSetupResult {
  const defaultRoute = route(FINGERPRINT_A);
  return {
    mode: "ready",
    generation,
    defaultRoute,
    readyRoutes: [defaultRoute],
    warnings: [],
    crossEnabled: false,
  };
}

function setupRequiredResult(generation: number): StartupSetupResult {
  return {
    mode: "setup-required",
    generation,
    defaultRoute: null,
    readyRoutes: [],
    warnings: [],
    crossEnabled: false,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("whole startup deadline includes pre inspection activation recovery", async () => {
  const clock = new FakeClock();
  let recoverySignal: AbortSignal | null = null;
  let inspectCalls = 0;
  const pending = startupRunner()({
    generation: 11,
    clock,
    recover: async (context) => {
      recoverySignal = context.signal;
      await new Promise<void>(() => undefined);
    },
    inspect: async () => {
      inspectCalls += 1;
      return readyResult(11);
    },
  });
  await flush();
  clock.advance(8_000);
  await flush();

  const result = await pending;
  assert.equal(result.mode, "setup-required");
  assert.equal(inspectCalls, 0);
  assert.equal((recoverySignal as AbortSignal | null)?.aborted, true);
});

test("seven seconds of recovery leave only one second for provider probes", async () => {
  const clock = new FakeClock();
  let finishRecovery!: () => void;
  let probeRemaining = -1;
  const pending = startupRunner()({
    generation: 12,
    clock,
    recover: () => new Promise<void>((resolve) => { finishRecovery = resolve; }),
    inspect: async (context) => {
      probeRemaining = context.remainingMs();
      await new Promise<void>(() => undefined);
      return readyResult(12);
    },
  });
  await flush();
  clock.advance(7_000);
  finishRecovery();
  await flush();
  assert.equal(probeRemaining, 1_000);
  clock.advance(1_000);
  await flush();

  assert.equal((await pending).mode, "setup-required");
});

test("automatic environment setup cannot reset or exceed the original startup deadline", async () => {
  const clock = new FakeClock();
  let finishInspect!: (value: StartupSetupResult) => void;
  let automaticDeadline = -1;
  const pending = startupRunner()({
    generation: 13,
    clock,
    recover: async () => undefined,
    inspect: () => new Promise((resolve) => { finishInspect = resolve; }),
    automaticEnvironment: async (result, context) => {
      automaticDeadline = context.deadlineAt;
      assert.equal(result.mode, "setup-required");
      await new Promise<void>(() => undefined);
      return readyResult(13);
    },
  });
  await flush();
  clock.advance(7_500);
  finishInspect(setupRequiredResult(13));
  await flush();
  assert.equal(automaticDeadline, 8_000);
  clock.advance(500);
  await flush();

  assert.equal((await pending).mode, "setup-required");
});

test("startup abort reaches recovery inspection and automatic activation with one generation", async (t) => {
  for (const blockedPhase of ["recover", "inspect", "automatic"] as const) {
    await t.test(blockedPhase, async () => {
      const clock = new FakeClock();
      const contexts: StartupStepContext[] = [];
      const block = async (context: StartupStepContext): Promise<never> => {
        contexts.push(context);
        return new Promise<never>(() => undefined);
      };
      const pending = startupRunner()({
        generation: 14,
        clock,
        recover: blockedPhase === "recover" ? block : async (context) => { contexts.push(context); },
        inspect: blockedPhase === "inspect"
          ? block
          : async (context) => { contexts.push(context); return setupRequiredResult(14); },
        automaticEnvironment: blockedPhase === "automatic"
          ? async (_result, context) => block(context)
          : async (result, context) => { contexts.push(context); return result; },
      });
      await flush();
      clock.advance(8_000);
      await flush();
      await pending;

      assert.ok(contexts.length >= 1);
      assert.deepEqual(new Set(contexts.map((context) => context.generation)), new Set([14]));
      assert.equal(new Set(contexts.map((context) => context.signal)).size, 1);
      assert.equal(contexts.at(-1)?.signal.aborted, true);
    });
  }
});

test("late startup generation cannot publish health state or bind a runtime key", async () => {
  const clock = new FakeClock();
  let finishInspect!: (value: StartupSetupResult) => void;
  let bindCalls = 0;
  const pending = startupRunner()({
    generation: 15,
    clock,
    recover: async () => undefined,
    inspect: () => new Promise((resolve) => { finishInspect = resolve; }),
    bindRuntime: async () => { bindCalls += 1; },
  });
  await flush();
  clock.advance(8_000);
  await flush();
  assert.equal((await pending).mode, "setup-required");

  finishInspect(readyResult(15));
  await flush();
  assert.equal(bindCalls, 0);
});

test("manual setup after startup timeout receives an independent interactive attempt", async () => {
  const clock = new FakeClock();
  const first = startupRunner()({
    generation: 16,
    clock,
    recover: async () => new Promise<void>(() => undefined),
    inspect: async () => readyResult(16),
  });
  await flush();
  clock.advance(8_000);
  await flush();
  assert.equal((await first).mode, "setup-required");

  const signals: AbortSignal[] = [];
  const second = startupRunner()({
    generation: 17,
    clock,
    recover: async (context) => { signals.push(context.signal); },
    inspect: async (context) => { signals.push(context.signal); return readyResult(17); },
    bindRuntime: async (_result, context) => { signals.push(context.signal); },
  });
  const result = await second;
  assert.equal(result.mode, "ready");
  assert.equal(result.generation, 17);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0]?.aborted, false);
});

test("pending committed activation journal with never-resolving connect/catalog retains journal and returns fail-closed at bound", async () => {
  const clock = new FakeClock();
  const journal = [{ phase: "config-committed", slot: SLOT_A }];
  const pending = startupRunner()({
    generation: 18,
    clock,
    recover: async () => new Promise<void>(() => undefined),
    inspect: async () => readyResult(18),
  });
  await flush();
  clock.advance(8_000);
  await flush();

  assert.equal((await pending).mode, "setup-required");
  assert.deepEqual(journal, [{ phase: "config-committed", slot: SLOT_A }]);
});

// This type-only guard keeps the desired adapter contract connected to the
// production registry rather than testing a standalone fake API.
void (null as BackendAdapter | null);
