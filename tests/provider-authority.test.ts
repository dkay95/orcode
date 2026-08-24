import assert from "node:assert/strict";
import test from "node:test";
import * as cliModule from "../src/cli.js";
import * as setupModule from "../src/setup.js";
import {
  BackendRegistry,
  type BackendAdapter,
  type BackendModelDescriptor,
  type ProviderCandidate,
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
  adoptDurablyCommittedProviderState,
  ProviderStateStore,
  createNeverConfiguredProviderState,
  validateProviderSetupState,
  type ProviderConnectionStateV1,
  type ProviderStateCommitRequest,
  type ProviderSetupStateV2,
} from "../src/provider-state.js";
import { SetupOrchestrator, type SetupClock, type StartupSetupResult } from "../src/setup.js";
import {
  ProviderCredentialAuthority,
  type ProviderAuthorityCoordinator,
  type ProviderConnectionBindingV1,
  type ProviderConnectionBindingV2,
  type ProviderCredentialRequest,
  selectProviderBinding,
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
const KIMI_MANUAL_SECRET = "fixture-kimi-manual-membership-key-not-real";
const KIMI_MANUAL_FOREIGN_SECRET = "fixture-kimi-manual-membership-key-foreign";
const KIMI_MANUAL_CONNECTION = "kimi-manual-main";
const KIMI_MANUAL_FINGERPRINT = "acct_kimi_manual_fixture";

type ManualKimiPermit = { readonly version: 1 };
type ManualKimiAttemptToken = { readonly version: 1 };
type ManualKimiAuthorityApi = {
  withManualKimiCandidateAuthority<T>(
    request: {
      backendId: "kimi-code";
      candidate: string;
      expectedRevision: number;
      generation: number;
      targetConnectionId?: string;
      purpose: "initial-setup";
      deadlineAt: number;
      signal: AbortSignal;
    },
    inspect: (
      normalizedCandidate: string,
      lease: { assertHeld(): Promise<void>; assertCurrent(): Promise<void> },
    ) => Promise<{ candidate: ProviderCandidate; value: T }>,
  ): Promise<
    | { kind: "ready"; value: { value: T; candidatePermit: ManualKimiPermit } }
    | { kind: "forget-pending" | "recovery-required" | "stale" }
  >;
  validateCandidatePermitUnderLease(
    request: {
      backendId: "kimi-code";
      candidate: string;
      expectedRevision: number;
      generation: number;
      targetConnectionId?: string;
      purpose: "initial-setup";
      deadlineAt: number;
      signal: AbortSignal;
      originalOwnerSignal: AbortSignal;
      credentialPermit: ManualKimiPermit;
      requireCredentialPermit: true;
      activationAttemptToken: ManualKimiAttemptToken;
      observedCandidate?: ProviderCandidate;
    },
    lease: { assertHeld(): Promise<void> },
  ): Promise<{ kind: "ready" | "forget-pending" | "recovery-required" | "stale" }>;
  releaseManualKimiCandidatePermit(permit: ManualKimiPermit): void;
};

function manualKimiCandidate(generation = 7): ProviderCandidate {
  return {
    candidateId: "candidate-kimi-manual",
    backendId: "kimi-code",
    connectionId: KIMI_MANUAL_CONNECTION,
    accountFingerprint: KIMI_MANUAL_FINGERPRINT,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    health: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: NOW,
      generation,
    },
  };
}

async function withCappedProviderTimers<T>(
  run: (realDelay: (milliseconds: number) => Promise<void>) => Promise<T>,
): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  const realDelay = (milliseconds: number) => new Promise<void>((resolve) => {
    originalSetTimeout(resolve, milliseconds);
  });
  globalThis.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => originalSetTimeout(handler, Math.min(timeout ?? 0, 25), ...args)) as typeof setTimeout;
  try {
    return await run(realDelay);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

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
    use: (
      secret: string,
      context: {
        source: "saved" | "environment";
        binding: ProviderConnectionBindingV1;
        candidatePermit: { readonly version: 1 };
        publishIfCurrent(publish: () => void): Promise<void>;
      },
    ) => Promise<T>,
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
      const slotId = request.connectionId === "connection-b" ? SLOT_B : SLOT_A;
      return {
        kind: "available",
        value: await use(secret, {
          source: "saved",
          candidatePermit: Object.freeze({ version: 1 as const }),
          async publishIfCurrent(publish) { publish(); },
          binding: {
            version: 1,
            stateRevision: 4,
            connectionId: request.connectionId,
            backendId: "openrouter",
            enabled: true,
            credentialPointer: {
              kind: "versioned",
              slot: Object.freeze({ version: 1, kind: "inference", id: slotId }),
            },
            accountFingerprint: secret === SECRET_B ? FINGERPRINT_B : FINGERPRINT_A,
            billingRealm: "openrouter-payg",
            isDefault: true,
          },
        }),
      };
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
): ProviderSetupStateV2 {
  return {
    schemaVersion: 2,
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
      build: (current: ProviderSetupStateV2) => ProviderSetupStateV2,
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
  const authority = realAuthority({
    stateStore,
    credentials,
    environment: { OPENROUTER_API_KEY: SECRET_A },
    coordinator,
  });
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

test("transitionModel deadline fences a delayed prepublication activation", async () => {
  await withCappedProviderTimers(async (realDelay) => {
    const state = stateWithConnections([
      connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
    ], route(FINGERPRINT_B));
    const stateStore = new ProviderStateStore(state);
    const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
    const coordinator = authorityCoordinator();
    const authority = new ProviderCredentialAuthority({
      stateStore,
      credentials,
      environment: {},
      coordinator: () => coordinator,
      now: Date.now,
    });
    const observed = adapterWithAuthority({ authority: authority as never, credentials });
    const nextModel = "synthetic/deadline-transition-model";
    const nextRoute = {
      ...route(FINGERPRINT_B),
      requestedModelId: nextModel,
      canonicalModelId: nextModel,
    };
    let activationReached!: () => void;
    const reached = new Promise<void>((resolve) => { activationReached = resolve; });
    let releaseActivation!: () => void;
    const activationSignals: AbortSignal[] = [];
    const Runtime = (cliModule as unknown as {
      DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest & {
        transitionModel(modelId: string, canonicalModelId: string): Promise<void>;
      };
    }).DefaultProviderRuntime;
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = MODEL;
    config.providerSetup = stateStore.read();
    const runtime = new Runtime(
      observed.service,
      credentials,
      new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]),
      stateStore,
      {
        ensureRunnableRoute() { return route(FINGERPRINT_B); },
        async activateCandidate(request: { signal: AbortSignal }) {
          activationSignals.push(request.signal);
          activationReached();
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            releaseActivation = () => {
              if (settled) return;
              settled = true;
              request.signal.removeEventListener("abort", onAbort);
              resolve();
            };
          });
          return { persisted: true, route: nextRoute, state: stateStore.read(), warnings: [] };
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

    const attempt = runtime.transitionModel(nextModel, nextModel);
    await reached;
    const settlement = await Promise.race([
      attempt.then(() => "fulfilled" as const, () => "rejected" as const),
      realDelay(100).then(() => "still-pending" as const),
    ]);
    const configAtSettlement = config.mainModel;
    releaseActivation();
    await attempt.catch(() => undefined);
    await realDelay(20);

    assert.equal(settlement, "rejected");
    assert.equal(activationSignals[0]?.aborted, true);
    assert.equal(configAtSettlement, MODEL);
    assert.equal(config.mainModel, MODEL);
    assert.deepEqual(stateStore.read(), state);
  });
});

test("transitionModel publication boundary waits for exact terminal reconciliation", async () => {
  await withCappedProviderTimers(async (realDelay) => {
    const state = stateWithConnections([
      connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
    ], route(FINGERPRINT_B));
    const stateStore = new ProviderStateStore(state);
    const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
    const coordinator = authorityCoordinator();
    const authority = new ProviderCredentialAuthority({
      stateStore,
      credentials,
      environment: {},
      coordinator: () => coordinator,
      now: Date.now,
    });
    const observed = adapterWithAuthority({ authority: authority as never, credentials });
    const nextModel = "synthetic/committed-transition-model";
    const nextRoute = {
      ...route(FINGERPRINT_B),
      requestedModelId: nextModel,
      canonicalModelId: nextModel,
    };
    const committedState = {
      ...state,
      revision: state.revision + 1,
      defaultRoute: nextRoute,
    };
    let publicationReached!: () => void;
    const reached = new Promise<void>((resolve) => { publicationReached = resolve; });
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const Runtime = (cliModule as unknown as {
      DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest & {
        transitionModel(modelId: string, canonicalModelId: string): Promise<void>;
      };
    }).DefaultProviderRuntime;
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = MODEL;
    config.providerSetup = stateStore.read();
    const runtime = new Runtime(
      observed.service,
      credentials,
      new BackendRegistry([{ descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter }]),
      stateStore,
      {
        ensureRunnableRoute() { return route(FINGERPRINT_B); },
        async activateCandidate() {
          stateStore.replace(committedState, state.revision);
          publicationReached();
          await publicationGate;
          return { persisted: true, route: nextRoute, state: stateStore.read(), warnings: [] };
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

    const attempt = runtime.transitionModel(nextModel, nextModel);
    await reached;
    const beforeRelease = await Promise.race([
      attempt.then(() => "fulfilled" as const, () => "rejected" as const),
      realDelay(100).then(() => "still-pending" as const),
    ]);
    releasePublication();
    const terminal = await attempt.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );

    assert.equal(beforeRelease, "still-pending");
    assert.equal(terminal, "fulfilled");
    assert.equal(config.mainModel, nextModel);
    assert.deepEqual(config.providerSetup, stateStore.read());
    assert.deepEqual(stateStore.read(), committedState);
  });
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

test("inference key save deadline fences a delayed prepublication activation", async () => {
  await withCappedProviderTimers(async (realDelay) => {
    const state = stateWithConnections([
      connection({ id: "connection-b", slot: SLOT_B, fingerprint: FINGERPRINT_B }),
    ], route(FINGERPRINT_B));
    const stateStore = new ProviderStateStore(state);
    const credentials = new AuthorityCredentials({}, { [SLOT_B]: SECRET_B });
    const coordinator = authorityCoordinator();
    const authority = new ProviderCredentialAuthority({
      stateStore,
      credentials,
      environment: {},
      coordinator: () => coordinator,
      now: Date.now,
    });
    let activationReached!: () => void;
    const reached = new Promise<void>((resolve) => { activationReached = resolve; });
    let releaseActivation!: () => void;
    const activationSignals: AbortSignal[] = [];
    let readyCalls = 0;
    const controller = cliModule.createProviderCredentialController({
      stateStore,
      openRouter: new OpenRouterService(SECRET_A),
      credentials,
      credentialAuthority: authority,
      activationCoordinator: {
        async activate(request: { signal: AbortSignal }) {
          activationSignals.push(request.signal);
          activationReached();
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              reject(request.signal.reason);
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            releaseActivation = () => {
              if (settled) return;
              settled = true;
              request.signal.removeEventListener("abort", onAbort);
              resolve();
            };
          });
          return { persisted: true, route: route(FINGERPRINT_B), state, warnings: [] };
        },
      },
      getInferenceRoute: () => route(FINGERPRINT_B),
      onInferenceReady() { readyCalls += 1; },
    } as never);

    const attempt = controller.apply({ kind: "save", credentialKind: "inference" });
    await reached;
    const settlement = await Promise.race([
      attempt.then(() => "fulfilled" as const, () => "rejected" as const),
      realDelay(100).then(() => "still-pending" as const),
    ]);
    const readyAtSettlement = readyCalls;
    releaseActivation();
    await attempt.catch(() => undefined);
    await realDelay(20);

    assert.equal(settlement, "rejected");
    assert.equal(activationSignals[0]?.aborted, true);
    assert.equal(readyAtSettlement, 0);
    assert.equal(readyCalls, 0);
    assert.deepEqual(stateStore.read(), state);
  });
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

test("manual saved setup authority expiry aborts hub and forbids late activation", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: 1_000_000,
  });
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
  ], route(FINGERPRINT_A)));
  const coordinator = authorityCoordinator();
  const authority = new ProviderCredentialAuthority({
    stateStore,
    credentials,
    environment: {},
    coordinator: () => coordinator,
    now: () => Date.now(),
  });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
  let activationCalls = 0;
  const activationCoordinator = {
    async activate() {
      activationCalls += 1;
      return {
        persisted: true,
        route: route(FINGERPRINT_A),
        state: stateStore.read(),
        warnings: [],
      };
    },
  };
  const orchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator,
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
  let modelPromptReached!: () => void;
  let resolveModelPrompt!: (model: string) => void;
  const reached = new Promise<void>((resolve) => { modelPromptReached = resolve; });
  const modelPrompt = new Promise<string>((resolve) => { resolveModelPrompt = resolve; });
  let presentations = 0;
  let hubCalls = 0;
  const attempt = runtime.runSetup({
    async chooseHub(entries: ReadonlyArray<{ id: string }>) {
      hubCalls += 1;
      return entries.some((entry) => entry.id === "cross-later")
        ? "cross-later"
        : hubCalls === 1
          ? "openrouter"
          : null;
    },
    async readSecret() { throw new Error("saved pointer must not reprompt"); },
    async chooseModel() {
      modelPromptReached();
      return modelPrompt;
    },
    async confirm() { return true; },
    present() { presentations += 1; },
  });
  await reached;

  let settled = false;
  void attempt.then(() => { settled = true; });
  t.mock.timers.tick(14_999);
  await Promise.resolve();
  assert.equal(settled, false, "manual provider authority expired before the exact 15s budget");
  t.mock.timers.tick(1);
  const result = await attempt;
  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  const effectsAtSettlement = {
    activationCalls,
    presentations,
    networkCalls: observed.calls.length,
  };
  resolveModelPrompt(MODEL);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual({
    activationCalls,
    presentations,
    networkCalls: observed.calls.length,
  }, effectsAtSettlement);
  assert.equal(activationCalls, 0);
});

test("DefaultProviderRuntime propagates aborted setup cancellation persistence rejection", async () => {
  const failure = new Error("Provider cancellation persistence failed safely.");
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState(), {
    persist: async () => { throw failure; },
  });
  const credentials = new AuthorityCredentials();
  const observed = adapterWithAuthority({ authority: availableAuthority({}), credentials });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
  const realOrchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: fakeActivationCoordinator(),
  });
  let cancellationCalls = 0;
  const originalCancel = realOrchestrator.cancelSetup.bind(realOrchestrator);
  realOrchestrator.cancelSetup = async (request) => {
    cancellationCalls += 1;
    return originalCancel(request);
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
    realOrchestrator,
    authorityCoordinator(),
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
  );
  const reason = new DOMException("fixed public setup abort", "AbortError");
  const presentations: unknown[] = [];

  await assert.rejects(
    runtime.runSetup({
      async chooseHub() { throw new Error("aborted setup must not prompt"); },
      async readSecret() { throw new Error("aborted setup must not read a secret"); },
      async chooseModel() { throw new Error("aborted setup must not choose a model"); },
      async confirm() { throw new Error("aborted setup must not confirm"); },
      present(event: unknown) { presentations.push(event); },
    }, {
      generation: 41,
      signal: AbortSignal.abort(reason),
      deadlineAt: Date.now() + 1_000,
      remainingMs: () => 1_000,
      assertCurrent() { throw reason; },
    }),
    (error: unknown) => error === failure,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(cancellationCalls, 1);
  assert.equal(stateStore.read().lifecycle, "never-configured");
  assert.equal(stateStore.read().revision, 0);
  assert.deepEqual(observed.calls, []);
  assert.deepEqual(presentations, []);
});

test("DefaultProviderRuntime reconciles a committed cancelled lifecycle after persistence rejects", async () => {
  const initial = createNeverConfiguredProviderState();
  const stateStore = new ProviderStateStore(initial, {
    persist: async (request) => {
      const committed = request.build(initial);
      adoptDurablyCommittedProviderState(request, committed);
      throw new Error("fixed rejection after cancelled lifecycle publication");
    },
  });
  const credentials = new AuthorityCredentials();
  const observed = adapterWithAuthority({ authority: availableAuthority({}), credentials });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
  const realOrchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: fakeActivationCoordinator(),
  });
  let cancellationCalls = 0;
  const originalCancel = realOrchestrator.cancelSetup.bind(realOrchestrator);
  realOrchestrator.cancelSetup = async (request) => {
    cancellationCalls += 1;
    return originalCancel(request);
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
    realOrchestrator,
    authorityCoordinator(),
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
  );
  const reason = new DOMException("fixed postpublication setup abort", "AbortError");

  const result = await runtime.runSetup({
    async chooseHub() { throw new Error("aborted setup must not prompt"); },
    async readSecret() { throw new Error("aborted setup must not read a secret"); },
    async chooseModel() { throw new Error("aborted setup must not choose a model"); },
    async confirm() { throw new Error("aborted setup must not confirm"); },
    present() {},
  }, {
    generation: 42,
    signal: AbortSignal.abort(reason),
    deadlineAt: Date.now() + 1_000,
    remainingMs: () => 1_000,
    assertCurrent() { throw reason; },
  });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.equal(cancellationCalls, 1);
  assert.equal(stateStore.read().lifecycle, "cancelled");
  assert.equal(stateStore.read().revision, 1);
  assert.deepEqual(config.providerSetup, stateStore.read());
  assert.deepEqual(observed.calls, []);
});

test("pending provider authority blocks setup before prompt or candidate network", async (t) => {
  const blockedFixtures: Array<{
    name: string;
    accessKind: "forget-pending" | "recovery-required";
    slots: Readonly<Record<string, string | null>>;
    environmentSecret: string | null;
  }> = [
    {
      name: "saved slot with pending forget",
      accessKind: "forget-pending" as const,
      slots: { [SLOT_A]: SECRET_A },
      environmentSecret: null,
    },
    {
      name: "absent saved slot plus environment with pending forget",
      accessKind: "forget-pending" as const,
      slots: {},
      environmentSecret: SECRET_B,
    },
    {
      name: "saved slot with activation recovery required",
      accessKind: "recovery-required" as const,
      slots: { [SLOT_A]: SECRET_A },
      environmentSecret: null,
    },
  ];
  for (const fixture of blockedFixtures) {
    await t.test(fixture.name, async () => {
      const credentials = new AuthorityCredentials({}, fixture.slots);
      const stateStore = new ProviderStateStore(stateWithConnections([
        connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
      ], route(FINGERPRINT_A)));
      const authority = {
        async withCredential() { return { kind: fixture.accessKind }; },
      };
      const observed = adapterWithAuthority({ authority: authority as never, credentials });
      const registry = new BackendRegistry([
        { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
      ]);
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
        { async activateCandidate() { throw new Error("activation must remain blocked"); } },
        {},
        { beginRun() { return () => undefined; } },
        { async apply() { return { kind: "unchanged" }; } },
        null,
        fixture.environmentSecret,
        MODEL,
        config,
        undefined,
        { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
      );
      const surfaceCalls: string[] = [];
      let hubCalls = 0;
      const surface = {
        async chooseHub() {
          surfaceCalls.push("hub");
          hubCalls += 1;
          return hubCalls === 1 ? "openrouter" : null;
        },
        async readSecret() { surfaceCalls.push("secret"); return SECRET_B; },
        async chooseModel() { surfaceCalls.push("model"); return MODEL; },
        async confirm() { surfaceCalls.push("confirm"); return true; },
        present() { surfaceCalls.push("present"); },
      };

      const result = await runtime.runSetup(surface as never);

      assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
      assert.deepEqual(
        surfaceCalls.filter((call) => call !== "present"),
        [],
        "blocked authority must not reach an interactive prompt",
      );
      assert.deepEqual(observed.calls, []);
      assert.deepEqual(credentials.effects, []);
    });
  }

  await t.test("a journal appearing after the prompt is rechecked before connect", async () => {
    const credentials = new AuthorityCredentials();
    const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
    let preflights = 0;
    let cancellationCalls = 0;
    const authority = {
      async withCredential() { return { kind: "absent" as const }; },
      async preflightCandidate() {
        preflights += 1;
        return { kind: "recovery-required" as const };
      },
    };
    const observed = adapterWithAuthority({ authority: authority as never, credentials });
    const registry = new BackendRegistry([
      { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
    ]);
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
      {
        async activateCandidate() { throw new Error("activation must remain blocked"); },
        async cancelSetup() { cancellationCalls += 1; return {}; },
      },
      {},
      { beginRun() { return () => undefined; } },
      { async apply() { return { kind: "unchanged" }; } },
      null,
      null,
      MODEL,
      config,
      undefined,
      { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
    );
    let hubCalls = 0;
    let secretPrompts = 0;
    const surface = {
      async chooseHub() { hubCalls += 1; return hubCalls === 1 ? "openrouter" : null; },
      async readSecret() { secretPrompts += 1; return SECRET_A; },
      async chooseModel() { return MODEL; },
      async confirm() { return true; },
      present() {},
    };

    const result = await runtime.runSetup(surface as never);

    assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
    assert.equal(preflights, 1);
    assert.equal(secretPrompts, 1);
    assert.equal(cancellationCalls, 0, "recovery block returns setup-required without lifecycle cancellation");
    assert.deepEqual(observed.calls, []);
  });
});

test("candidate authority stays owned through connect and catalog", async (t) => {
  for (const journalAt of ["before-connect", "before-catalog"] as const) {
    await t.test(journalAt, async () => {
      const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
      const credentials = new AuthorityCredentials();
      let authorityCalls = 0;
      let authorityOwned = false;
      let journalRequested = false;
      let journalPending = false;
      let connectWhilePending = 0;
      let catalogWhilePending = 0;
      const lease = { async assertHeld() {} };
      const coordinator = {
        async readAuthority<T>(
          _request: unknown,
          operation: (held: typeof lease) => Promise<T>,
        ) {
          authorityCalls += 1;
          authorityOwned = true;
          try {
            return await operation(lease);
          } finally {
            authorityOwned = false;
            if (
              (journalAt === "before-connect" && authorityCalls === 2)
              || journalRequested
            ) {
              journalPending = true;
            }
          }
        },
        async runExclusive() {
          throw new Error("activation must not run after model cancellation");
        },
      };
      const authority = realAuthority({
        stateStore,
        credentials,
        coordinator: coordinator as never,
      });
      const adapter: BackendAdapter = {
        backendId: "openrouter",
        async inspect() { throw new Error("startup inspection is outside this setup test"); },
        async reconnect() { throw new Error("reconnect is outside this setup test"); },
        async connect() {
          if (journalPending) connectWhilePending += 1;
          if (journalAt === "before-catalog") {
            journalRequested = true;
            if (!authorityOwned) journalPending = true;
          }
          return {
            candidateId: "candidate-authority-race",
            backendId: "openrouter" as const,
            connectionId: "connection-authority-race",
            accountFingerprint: FINGERPRINT_A,
            billingRealm: "openrouter-payg" as const,
            health: healthyInspection(
              "connection-authority-race",
              FINGERPRINT_A,
              1,
            ).health,
          };
        },
        async listModels() {
          if (journalPending) catalogWhilePending += 1;
          return [{
            backendId: "openrouter" as const,
            requestedModelId: MODEL,
            canonicalModelId: MODEL,
            displayName: "Authority-race model",
            capabilities: {
              textInput: true,
              textOutput: true,
              tools: true,
              reasoning: false,
            },
          }];
        },
        async activate() { throw new Error("activation is outside this setup test"); },
        async discardCandidate() {},
        async logout() {},
      };
      const registry = new BackendRegistry([
        { descriptor: OPENROUTER_DESCRIPTOR, adapter },
      ]);
      const Runtime = (cliModule as unknown as {
        DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
      }).DefaultProviderRuntime;
      const config = structuredClone(DEFAULT_CONFIG);
      config.mainModel = MODEL;
      config.providerSetup = stateStore.read();
      const setupOrchestrator = new SetupOrchestrator({
        registry,
        stateStore,
        activationCoordinator: {
          async activate() { throw new Error("activation must not run"); },
        },
      });
      const runtime = new Runtime(
        {} as never,
        credentials,
        registry,
        stateStore,
        setupOrchestrator,
        coordinator,
        { beginRun() { return () => undefined; } },
        { async apply() { return { kind: "unchanged" }; } },
        null,
        null,
        MODEL,
        config,
        undefined,
        { credentialAuthority: authority, adapter: adapter as never, async recover() {} },
      );
      let hubCalls = 0;
      const result = await runtime.runSetup({
        async chooseHub() {
          hubCalls += 1;
          return hubCalls === 1 ? "openrouter" : null;
        },
        async readSecret() { return SECRET_A; },
        async chooseModel() { return null; },
        async confirm() { return true; },
        present() {},
      });

      assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
      assert.equal(connectWhilePending, 0);
      assert.equal(catalogWhilePending, 0);
    });
  }
});

test("queued bounded authority operations never start after synchronous abort or deadline", async (t) => {
  for (const mode of ["abort", "deadline"] as const) {
    await t.test(mode, async () => {
      const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
      const credentials = new AuthorityCredentials();
      let now = NOW;
      let leaseAssertions = 0;
      const coordinator: ProviderAuthorityCoordinator = {
        async readAuthority(_request, operation) {
          return operation({
            async assertHeld() { leaseAssertions += 1; },
          });
        },
      };
      const authority = new ProviderCredentialAuthority({
        stateStore,
        credentials,
        environment: {},
        coordinator: () => coordinator,
        now: () => now,
      });
      const controller = new AbortController();
      const deadlineAt = NOW + 1;
      const attempt = authority.preflightCandidate({
        deadlineAt,
        signal: controller.signal,
      });

      if (mode === "abort") {
        const reason = new DOMException("fixed synchronous authority abort", "AbortError");
        controller.abort(reason);
        await assert.rejects(attempt, (error: unknown) => error === reason);
      } else {
        now = deadlineAt;
        assert.deepEqual(await attempt, { kind: "stale" });
      }
      await Promise.resolve();
      assert.equal(leaseAssertions, 0);
    });
  }
});

test("candidate authority rejects saved and environment credential swaps before provider connect", async (t) => {
  for (const source of ["saved", "environment"] as const) {
    await t.test(source, async () => {
      const slots: Record<string, string | null> = source === "saved"
        ? { [SLOT_A]: SECRET_A }
        : {};
      const environment: Record<string, string | undefined> = source === "environment"
        ? { OPENROUTER_API_KEY: SECRET_A }
        : {};
      const credentials = new AuthorityCredentials({}, slots);
      const stateStore = new ProviderStateStore(source === "saved"
        ? stateWithConnections([
            connection({ id: "connection-a", slot: SLOT_A, fingerprint: FINGERPRINT_A }),
          ], route(FINGERPRINT_A))
        : createNeverConfiguredProviderState());
      let authorityCalls = 0;
      const lease = { async assertHeld() {} };
      const coordinator = {
        async readAuthority<T>(
          _request: unknown,
          operation: (held: typeof lease) => Promise<T>,
        ) {
          authorityCalls += 1;
          if (source === "environment" && authorityCalls === 1) {
            environment.OPENROUTER_API_KEY = SECRET_B;
          }
          return operation(lease);
        },
        async runExclusive() {
          throw new Error("activation must not run after a candidate permit swap");
        },
      };
      const authority = realAuthority({
        stateStore,
        credentials,
        environment,
        coordinator: coordinator as never,
      });
      const observed = adapterWithAuthority({
        authority: authority as never,
        credentials,
      });
      const registry = new BackendRegistry([
        { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
      ]);
      const Runtime = (cliModule as unknown as {
        DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
      }).DefaultProviderRuntime;
      const config = structuredClone(DEFAULT_CONFIG);
      config.mainModel = MODEL;
      config.providerSetup = stateStore.read();
      let cancellationCalls = 0;
      const runtime = new Runtime(
        observed.service,
        credentials,
        registry,
        stateStore,
        {
          async activateCandidate() { throw new Error("activation must remain fenced"); },
          async cancelSetup() { cancellationCalls += 1; return {}; },
        },
        coordinator,
        { beginRun() { return () => undefined; } },
        { async apply() { return { kind: "unchanged" }; } },
        null,
        source === "environment" ? SECRET_A : null,
        MODEL,
        config,
        undefined,
        { credentialAuthority: authority, adapter: observed.adapter, async recover() {} },
      );
      let hubCalls = 0;
      const result = await runtime.runSetup({
        async chooseHub() {
          hubCalls += 1;
          if (source === "saved" && hubCalls === 1) {
            slots[SLOT_A] = SECRET_B;
            return "openrouter";
          }
          return null;
        },
        async readSecret() { throw new Error("candidate permit test must not reprompt"); },
        async chooseModel() { return null; },
        async confirm() { return true; },
        present() {},
      });

      assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
      assert.deepEqual(observed.calls, []);
      assert.equal(observed.service.hasKey, false);
      assert.equal(
        cancellationCalls,
        0,
        "candidate-authority rejection remains a recovery block, not lifecycle cancellation",
      );
    });
  }
});

test("candidate inspection reuses its held authority lease without nested acquisition", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  let authorityOwned = false;
  let nestedAcquisitions = 0;
  const lease = { async assertHeld() {} };
  const coordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) {
      if (authorityOwned) {
        nestedAcquisitions += 1;
        throw new Error("nested provider authority acquisition");
      }
      authorityOwned = true;
      try {
        return await operation(lease);
      } finally {
        authorityOwned = false;
      }
    },
    async runExclusive() {
      throw new Error("activation must not run after model cancellation");
    },
  };
  const authority = realAuthority({
    stateStore,
    credentials,
    coordinator: coordinator as never,
  });
  const observed = adapterWithAuthority({
    authority: authority as never,
    credentials,
  });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = MODEL;
  config.providerSetup = stateStore.read();
  const setupOrchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: {
      async activate() { throw new Error("activation must not run"); },
    },
  });
  const runtime = new Runtime(
    observed.service,
    credentials,
    registry,
    stateStore,
    setupOrchestrator,
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
  let hubCalls = 0;

  await runtime.runSetup({
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : null;
    },
    async readSecret() { return SECRET_A; },
    async chooseModel() { return null; },
    async confirm() { return true; },
    present() {},
  });

  assert.equal(nestedAcquisitions, 0);
});

test("candidate authority abort releases ownership and fences an abort-ignoring catalog", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  let authorityOwned = false;
  const lease = { async assertHeld() {} };
  const coordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) {
      authorityOwned = true;
      try {
        return await operation(lease);
      } finally {
        authorityOwned = false;
      }
    },
    async runExclusive() {
      throw new Error("activation must remain fenced after candidate abort");
    },
  };
  const authority = realAuthority({
    stateStore,
    credentials,
    coordinator: coordinator as never,
  });
  let catalogReached!: () => void;
  let releaseCatalog!: () => void;
  const reached = new Promise<void>((resolve) => { catalogReached = resolve; });
  const catalog = new Promise<readonly BackendModelDescriptor[]>((resolve) => {
    releaseCatalog = () => resolve([{
      backendId: "openrouter",
      requestedModelId: MODEL,
      canonicalModelId: MODEL,
      displayName: "Late candidate model",
      capabilities: {
        textInput: true,
        textOutput: true,
        tools: true,
        reasoning: false,
      },
    }]);
  });
  let discardCalls = 0;
  let activationCalls = 0;
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("startup inspection is outside this setup test"); },
    async reconnect() { throw new Error("reconnect is outside this setup test"); },
    async connect() {
      return {
        candidateId: "candidate-abort-ignoring-catalog",
        backendId: "openrouter",
        connectionId: "connection-abort-ignoring-catalog",
        accountFingerprint: FINGERPRINT_A,
        billingRealm: "openrouter-payg",
        health: healthyInspection(
          "connection-abort-ignoring-catalog",
          FINGERPRINT_A,
          1,
        ).health,
      };
    },
    async listModels() {
      catalogReached();
      return catalog;
    },
    async activate() { throw new Error("adapter activation is outside this setup test"); },
    async discardCandidate() { discardCalls += 1; },
    async logout() {},
  };
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
  ]);
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = MODEL;
  config.providerSetup = stateStore.read();
  const setupOrchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: {
      async activate() { activationCalls += 1; throw new Error("late activation"); },
    },
  });
  const runtime = new Runtime(
    {} as never,
    credentials,
    registry,
    stateStore,
    setupOrchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: adapter as never, async recover() {} },
  );
  let hubCalls = 0;
  let modelPrompts = 0;
  const controller = new AbortController();
  const attempt = runtime.runSetup({
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : null;
    },
    async readSecret() { return SECRET_A; },
    async chooseModel() { modelPrompts += 1; return MODEL; },
    async confirm() { return true; },
    present() {},
  }, {
    generation: 91,
    deadlineAt: Date.now() + 1_000,
    signal: controller.signal,
    remainingMs: () => 1_000,
    assertCurrent() {},
  } as never);
  await reached;
  const abortReason = new DOMException("fixed candidate catalog abort", "AbortError");
  controller.abort(abortReason);

  const settledAfterAbort = await Promise.race([
    attempt.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 100);
    }),
  ]);
  const ownedAfterAbort = authorityOwned;
  releaseCatalog();
  await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settledAfterAbort, "settled");
  assert.equal(ownedAfterAbort, false);
  assert.equal(authorityOwned, false);
  assert.equal(activationCalls, 0);
  assert.equal(modelPrompts, 0);
  assert.equal(discardCalls, 1);
});

test("candidate deadline discards a late rejected connect without publication", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  const lease = { async assertHeld() {} };
  const coordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) {
      return operation(lease);
    },
    async runExclusive() {
      throw new Error("activation must remain fenced after candidate deadline");
    },
  };
  const authority = realAuthority({
    stateStore,
    credentials,
    coordinator: coordinator as never,
  });
  let connectReached!: () => void;
  let releaseConnect!: () => void;
  const reached = new Promise<void>((resolve) => { connectReached = resolve; });
  const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let discardCalls = 0;
  let catalogCalls = 0;
  const rejectedHealth = {
    ...healthyInspection("connection-late-rejected", FINGERPRINT_A, 1).health,
    credential: "rejected" as const,
  };
  const adapter: BackendAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("startup inspection is outside this setup test"); },
    async reconnect() { throw new Error("reconnect is outside this setup test"); },
    async connect() {
      connectReached();
      await connectGate;
      return {
        candidateId: "candidate-late-rejected",
        backendId: "openrouter",
        connectionId: "connection-late-rejected",
        accountFingerprint: FINGERPRINT_A,
        billingRealm: "openrouter-payg",
        health: rejectedHealth,
      };
    },
    async listModels() { catalogCalls += 1; return []; },
    async activate() { throw new Error("adapter activation is outside this setup test"); },
    async discardCandidate() { discardCalls += 1; },
    async logout() {},
  };
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter },
  ]);
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const config = structuredClone(DEFAULT_CONFIG);
  config.mainModel = MODEL;
  config.providerSetup = stateStore.read();
  const setupOrchestrator = new SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: {
      async activate() { throw new Error("late activation"); },
    },
  });
  const runtime = new Runtime(
    {} as never,
    credentials,
    registry,
    stateStore,
    setupOrchestrator,
    coordinator,
    { beginRun() { return () => undefined; } },
    { async apply() { return { kind: "unchanged" }; } },
    null,
    null,
    MODEL,
    config,
    undefined,
    { credentialAuthority: authority, adapter: adapter as never, async recover() {} },
  );
  let hubCalls = 0;
  let presentations = 0;
  const signal = new AbortController().signal;
  const attempt = runtime.runSetup({
    async chooseHub() {
      hubCalls += 1;
      return hubCalls === 1 ? "openrouter" : null;
    },
    async readSecret() { return SECRET_A; },
    async chooseModel() { throw new Error("late model prompt"); },
    async confirm() { return true; },
    present() { presentations += 1; },
  }, {
    generation: 92,
    deadlineAt: Date.now() + 75,
    signal,
    remainingMs: () => 75,
    assertCurrent() {},
  });
  await reached;
  const settled = await Promise.race([
    attempt.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 500);
    }),
  ]);
  const presentationsAtSettlement = presentations;
  releaseConnect();
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  assert.equal(settled, "settled");
  assert.equal(presentations, presentationsAtSettlement);
  assert.equal(discardCalls, 1);
  assert.equal(catalogCalls, 0);
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

test("runtime bind rejects a mutable saved or environment secret until that exact credential is inspected", async (t) => {
  for (const source of ["saved", "environment"] as const) {
    await t.test(source, async () => {
      let secret = SECRET_A;
      let binding = {
        version: 1 as const,
        stateRevision: 4,
        connectionId: "connection-a",
        backendId: "openrouter" as const,
        enabled: true,
        credentialPointer: source === "saved"
          ? {
              kind: "versioned" as const,
              slot: Object.freeze({ version: 1 as const, kind: "inference" as const, id: SLOT_A }),
            }
          : { kind: "legacy" as const, id: "legacy:inference" as const },
        accountFingerprint: FINGERPRINT_A,
        billingRealm: "openrouter-payg" as const,
        isDefault: true,
      };
      const authority = {
        async withCredential<T>(
          _request: DesiredCredentialRequest,
          use: (value: string, context: unknown) => Promise<T>,
        ) {
          return {
            kind: "available" as const,
            value: await use(secret, {
              source,
              binding: structuredClone(binding),
              candidatePermit: Object.freeze({ version: 1 as const }),
              async publishIfCurrent(publish: () => void) { publish(); },
            }),
          };
        },
      };
      const observed = adapterWithAuthority({ authority: authority as never });
      const signal = new AbortController().signal;
      const inspectedA = await observed.adapter.inspect({
        connectionId: "connection-a",
        generation: 41,
        deadlineAt: NOW + 5_000,
        signal,
      } as never);
      assert.equal(inspectedA.accountFingerprint, FINGERPRINT_A);

      secret = SECRET_B;
      await assert.rejects(observed.adapter.bindRuntime({
        connectionId: "connection-a",
        generation: 41,
        deadlineAt: NOW + 5_000,
        signal,
      }), /inspection|credential|binding|proof/i);
      assert.equal(observed.service.hasKey, false);

      binding = {
        ...binding,
        stateRevision: 5,
        accountFingerprint: FINGERPRINT_B,
      };
      const inspectedB = await observed.adapter.inspect({
        connectionId: "connection-a",
        generation: 42,
        deadlineAt: NOW + 5_000,
        signal,
      } as never);
      assert.equal(inspectedB.accountFingerprint, FINGERPRINT_B);
      await observed.adapter.bindRuntime({
        connectionId: "connection-a",
        generation: 42,
        deadlineAt: NOW + 5_000,
        signal,
      });
      assert.equal(observed.service.requireKey(), SECRET_B);
    });
  }
});

test("runtime bind re-inspects the same credential after authoritative identity adoption", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({
      id: "connection-a",
      slot: SLOT_A,
      fingerprint: FINGERPRINT_A,
    }),
  ], route(FINGERPRINT_A)));
  const authority = realAuthority({ stateStore, credentials });
  const observed = adapterWithAuthority({
    authority: authority as never,
    credentials,
  });
  const signal = new AbortController().signal;
  const inspected = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 43,
    deadlineAt: NOW + 5_000,
    signal,
  } as never);
  assert.equal(inspected.accountFingerprint, FINGERPRINT_A);

  const adopted = stateStore.read();
  stateStore.replace({ ...adopted }, adopted.revision);
  await observed.adapter.bindRuntime({
    connectionId: "connection-a",
    generation: 43,
    deadlineAt: NOW + 5_000,
    signal,
  });

  assert.equal(observed.service.requireKey(), SECRET_A);
  assert.equal(
    observed.calls.filter((call) => call.url.endsWith("/key")).length,
    2,
    "the unchanged adopted binding must receive and publish its own exact provider proof",
  );
});

test("aborted authoritative re-inspection cannot activate the runtime after late resolution", async () => {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const retained = connection({
    id: "connection-a",
    slot: SLOT_A,
    fingerprint: FINGERPRINT_A,
  });
  const stateStore = new ProviderStateStore(stateWithConnections([
    retained,
  ], route(FINGERPRINT_A)));
  const authority = realAuthority({ stateStore, credentials });
  const observed = adapterWithAuthority({
    authority: authority as never,
    credentials,
  });
  const signal = new AbortController().signal;
  const inspected = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 44,
    deadlineAt: NOW + 5_000,
    signal,
  } as never);
  assert.equal(inspected.accountFingerprint, FINGERPRINT_A);

  const current = stateStore.read();
  stateStore.replace({
    ...current,
  }, current.revision);

  const key = await observed.service.inspectKey(SECRET_A, signal);
  const lateKey = { ...key, isManagementKey: undefined };
  let releaseReinspection!: () => void;
  let reinspectionReached!: () => void;
  const reached = new Promise<void>((resolve) => { reinspectionReached = resolve; });
  observed.service.inspectKey = async () => {
    reinspectionReached();
    return new Promise((resolve) => {
      releaseReinspection = () => resolve(lateKey);
    });
  };
  const controller = new AbortController();
  const reason = new DOMException("fixed late reinspection abort", "AbortError");
  const binding = observed.adapter.bindRuntime({
    connectionId: "connection-a",
    generation: 44,
    deadlineAt: NOW + 5_000,
    signal: controller.signal,
  });
  await reached;
  controller.abort(reason);

  await assert.rejects(binding, (error: unknown) => error === reason);
  assert.equal(observed.service.hasKey, false);
  releaseReinspection();
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(
    observed.service.hasKey,
    false,
    "a late abort-ignoring provider result must not activate the singleton runtime",
  );
});

test("authoritative binding swap during re-inspection cannot publish a stale runtime", async () => {
  const credentials = new AuthorityCredentials({}, {
    [SLOT_A]: SECRET_A,
    [SLOT_B]: SECRET_B,
  });
  const stateStore = new ProviderStateStore(stateWithConnections([
    connection({
      id: "connection-a",
      slot: SLOT_A,
      fingerprint: FINGERPRINT_A,
    }),
  ], route(FINGERPRINT_A)));
  const authority = realAuthority({ stateStore, credentials });
  const observed = adapterWithAuthority({
    authority: authority as never,
    credentials,
  });
  const signal = new AbortController().signal;
  const inspected = await observed.adapter.inspect({
    connectionId: "connection-a",
    generation: 45,
    deadlineAt: NOW + 5_000,
    signal,
  } as never);
  assert.equal(inspected.accountFingerprint, FINGERPRINT_A);

  const adopted = stateStore.read();
  stateStore.replace({ ...adopted }, adopted.revision);

  const key = await observed.service.inspectKey(SECRET_A, signal);
  const lateKey = { ...key, isManagementKey: undefined };
  let releaseReinspection!: () => void;
  let reinspectionReached!: () => void;
  const reached = new Promise<void>((resolve) => { reinspectionReached = resolve; });
  observed.service.inspectKey = async () => {
    reinspectionReached();
    return new Promise((resolve) => {
      releaseReinspection = () => resolve(lateKey);
    });
  };
  const binding = observed.adapter.bindRuntime({
    connectionId: "connection-a",
    generation: 45,
    deadlineAt: NOW + 5_000,
    signal,
  });
  await reached;

  const current = stateStore.read();
  stateStore.replace({
    ...current,
    connections: current.connections.map((item) => item.id === "connection-a"
      ? {
        ...item,
        credentialSlot: SLOT_B,
        accountFingerprint: FINGERPRINT_B,
      }
      : item),
    defaultRoute: route(FINGERPRINT_B),
  }, current.revision);
  releaseReinspection();

  await assert.rejects(binding);
  assert.equal(stateStore.read().revision, current.revision + 1);
  assert.equal(stateStore.read().connections[0]?.credentialSlot, SLOT_B);
  assert.equal(observed.service.hasKey, false);
});

type RuntimeUnderTest = {
  execute(intent: Record<string, unknown>, surface: "plain"): Promise<Record<string, unknown>>;
  inspectStartup(): Promise<StartupSetupResult>;
  adoptCredentialActivation(route: RouteIdentityV1, persisted: boolean, secret: string): void;
  runSetup(surface: unknown, startupAttempt?: unknown): Promise<Record<string, unknown>>;
};

function runtimeFixture(
  initial: ProviderSetupStateV2,
  authorityOptions?: unknown,
  beforeExclusive?: () => void | Promise<void>,
): {
  runtime: RuntimeUnderTest;
  stateStore: ProviderStateStore;
  reconnectRequests: unknown[][];
  runtimeBindings: Array<{ connectionId?: string }>;
  coordinatorExclusiveCalls(): number;
} {
  const Runtime = (cliModule as unknown as {
    DefaultProviderRuntime: new (...args: unknown[]) => RuntimeUnderTest;
  }).DefaultProviderRuntime;
  const stateStore = new ProviderStateStore(initial);
  const reconnectRequests: unknown[][] = [];
  const runtimeBindings: Array<{ connectionId?: string }> = [];
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
      return {
        async bindRuntime(request: { connectionId?: string }) {
          runtimeBindings.push(request);
        },
      };
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
    runtimeBindings,
    coordinatorExclusiveCalls: () => coordinatorExclusiveCalls,
  };
}

function commandState(): ProviderSetupStateV2 {
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
  assert.equal(fixture.runtimeBindings.length, 1);
  assert.equal(fixture.runtimeBindings[0]?.connectionId, "connection-b");
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

function retainedEnableFixture(
  assertHeld: () => void | Promise<void> = () => undefined,
  afterOperation: () => void | Promise<void> = () => undefined,
  persist?: (request: ProviderStateCommitRequest) => Promise<ProviderSetupStateV2>,
) {
  const credentials = new AuthorityCredentials({}, { [SLOT_A]: SECRET_A });
  const initialState = stateWithConnections([
    connection({
      id: "connection-disabled",
      slot: SLOT_A,
      fingerprint: FINGERPRINT_A,
      enabled: false,
    }),
  ], null);
  const stateStore = new ProviderStateStore(
    initialState,
    persist ? { persist } : {},
  );
  let exclusiveActive = false;
  const lease = { async assertHeld() { await assertHeld(); } };
  const coordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) { return operation(lease); },
    async runExclusive<T>(
      _request: unknown,
      operation: (held: typeof lease) => Promise<T>,
    ) {
      exclusiveActive = true;
      try {
        const value = await operation(lease);
        await afterOperation();
        return value;
      } finally {
        exclusiveActive = false;
      }
    },
  };
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const observed = adapterWithAuthority({ authority: authority as never, credentials });
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: observed.adapter },
  ]);
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
  return {
    credentials,
    stateStore,
    observed,
    runtime,
    config,
    exclusiveActive: () => exclusiveActive,
  };
}

test("retained enable never publishes enabled default before a fallible runtime bind", async (t) => {
  for (const failure of [
    new Error("fixed retained runtime bind failure"),
    Object.assign(new Error("fixed retained runtime bind deadline"), { name: "TimeoutError" }),
  ]) {
    await t.test(failure.name, async () => {
      const fixture = retainedEnableFixture();
      const beforeState = fixture.stateStore.read();
      const beforeConfig = structuredClone(fixture.config.providerSetup);
      fixture.observed.adapter.bindRuntimeUnderAuthorityLease = async () => {
        throw failure;
      };

      const result = await fixture.runtime.execute(
        { kind: "enable", backendId: "openrouter" },
        "plain",
      );

      assert.deepEqual(result, {
        kind: "setup",
        backendId: "openrouter",
        outcome: "cancelled",
      });
      assert.deepEqual(fixture.stateStore.read(), beforeState);
      assert.deepEqual(fixture.config.providerSetup, beforeConfig);
      assert.equal(fixture.observed.service.hasKey, false);
      assert.equal(
        fixture.credentials.effects.some((effect) =>
          effect.startsWith("reserve:") || effect.startsWith("write:")
        ),
        false,
      );
    });
  }
});

test("retained enable maps model dependency failures to fixed safe output without mutation", async () => {
  const fixture = retainedEnableFixture();
  const beforeState = fixture.stateStore.read();
  const beforeConfig = structuredClone(fixture.config.providerSetup);
  const sentinels = [
    SECRET_B,
    CREATOR_B,
    "/Users/private-person/.orcode/provider-activation/private.json",
    "C:\\Users\\private-person\\AppData\\Roaming\\orcode\\private.json",
    '{"error":{"message":"provider raw body sentinel"}}',
  ];
  fixture.observed.adapter.listModels = async () => {
    throw new Error(sentinels.join(" | "));
  };

  const result = await fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  const rendered = JSON.stringify(result);

  assert.deepEqual(result, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "cancelled",
  });
  for (const sentinel of sentinels) assert.equal(rendered.includes(sentinel), false);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.config.providerSetup, beforeConfig);
  assert.equal(fixture.observed.service.hasKey, false);
});

test("retained enable bounds an abort-ignoring catalog and promptly releases ownership", async () => {
  const fixture = retainedEnableFixture();
  let catalogReached!: () => void;
  const reached = new Promise<void>((resolve) => { catalogReached = resolve; });
  fixture.observed.adapter.listModels = async () => {
    catalogReached();
    return new Promise(() => undefined);
  };
  const attempt = fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  await reached;

  const settled = await Promise.race([
    attempt,
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 5_250);
    }),
  ]);

  assert.deepEqual(settled, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "cancelled",
  });
  assert.equal(fixture.exclusiveActive(), false);
});

test("retained enable bounds a stalled state commit and fences its late adoption", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  let persistReached!: () => void;
  let releasePersist!: () => void;
  const reached = new Promise<void>((resolve) => { persistReached = resolve; });
  const gate = new Promise<void>((resolve) => { releasePersist = resolve; });
  fixture = retainedEnableFixture(
    () => undefined,
    () => undefined,
    async (request) => {
      const candidate = request.build(fixture.stateStore.read());
      persistReached();
      await gate;
      request.adopt(candidate);
      return structuredClone(candidate);
    },
  );
  const beforeState = fixture.stateStore.read();
  const beforeConfig = structuredClone(fixture.config.providerSetup);
  let logoutCalls = 0;
  fixture.observed.adapter.logout = async () => {
    logoutCalls += 1;
    fixture.observed.service.forgetKey();
  };
  const attempt = fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  await reached;

  const settled = await Promise.race([
    attempt,
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 5_250);
    }),
  ]);
  const ownedAtSettlement = fixture.exclusiveActive();
  assert.equal(settled, "still-pending");
  assert.equal(ownedAtSettlement, true);
  assert.equal(logoutCalls, 0);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.config.providerSetup, beforeConfig);
  releasePersist();
  const final = await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const cancelled = {
    kind: "setup",
    backendId: "openrouter",
    outcome: "cancelled",
  } as const;
  assert.deepEqual(final, cancelled);
  assert.equal(fixture.exclusiveActive(), false);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.config.providerSetup, beforeConfig);
  assert.equal(fixture.observed.service.hasKey, false);
  assert.equal(logoutCalls, 1);
});

test("retained enable completes an exact adopted tuple when persistence hangs after adoption", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  let persistReached!: () => void;
  let releasePersist!: () => void;
  const reached = new Promise<void>((resolve) => { persistReached = resolve; });
  const gate = new Promise<void>((resolve) => { releasePersist = resolve; });
  fixture = retainedEnableFixture(
    () => undefined,
    () => undefined,
    async (request) => {
      const candidate = request.build(fixture.stateStore.read());
      request.adopt(candidate);
      persistReached();
      await gate;
      return structuredClone(candidate);
    },
  );
  const beforeConfig = structuredClone(fixture.config.providerSetup);
  const attempt = fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  await reached;

  const settled = await Promise.race([
    attempt,
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 5_250);
    }),
  ]);
  const committed = fixture.stateStore.read();
  const ownedAtSettlement = fixture.exclusiveActive();
  assert.equal(settled, "still-pending");
  assert.equal(ownedAtSettlement, true);
  assert.deepEqual(fixture.config.providerSetup, beforeConfig);
  releasePersist();
  const final = await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const ready = {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  } as const;
  assert.deepEqual(final, ready);
  assert.equal(fixture.exclusiveActive(), false);
  assert.equal(committed.connections[0]?.enabled, true);
  assert.deepEqual(fixture.config.providerSetup, committed);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
});

test("retained enable does not settle or logout before a late genuine durable-adoption outcome", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  let durable: ProviderSetupStateV2 | null = null;
  let publicationReached!: () => void;
  let releaseAdoption!: () => void;
  let adoptionFinished!: () => void;
  const published = new Promise<void>((resolve) => { publicationReached = resolve; });
  const adoptionGate = new Promise<void>((resolve) => { releaseAdoption = resolve; });
  const finished = new Promise<void>((resolve) => { adoptionFinished = resolve; });
  fixture = retainedEnableFixture(
    () => undefined,
    () => undefined,
    async (request) => {
      const candidate = request.build(fixture.stateStore.read());
      durable = structuredClone(candidate);
      publicationReached();
      await adoptionGate;
      try {
        adoptDurablyCommittedProviderState(request, candidate);
      } finally {
        adoptionFinished();
      }
      return structuredClone(candidate);
    },
  );
  let logoutCalls = 0;
  fixture.observed.adapter.logout = async () => {
    logoutCalls += 1;
    fixture.observed.service.forgetKey();
  };
  const beforeState = fixture.stateStore.read();
  const beforeConfig = structuredClone(fixture.config.providerSetup);
  const attempt = fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  await published;

  const beforeAdoption = await Promise.race([
    attempt.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 5_250);
    }),
  ]);
  assert.equal(beforeAdoption, "still-pending");
  assert.equal(logoutCalls, 0);
  assert.equal(fixture.exclusiveActive(), true);
  assert.deepEqual(fixture.stateStore.read(), beforeState);
  assert.deepEqual(fixture.config.providerSetup, beforeConfig);

  releaseAdoption();
  await finished;
  const final = await attempt;
  const committed = fixture.stateStore.read();
  const durableReadback = durable as ProviderSetupStateV2 | null;

  assert.deepEqual(final, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  });
  assert.ok(durableReadback);
  assert.deepEqual(committed, durableReadback);
  assert.deepEqual(fixture.config.providerSetup, durableReadback);
  assert.equal(committed.connections[0]?.enabled, true);
  assert.equal(committed.defaultRoute?.canonicalModelId, MODEL);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
  assert.equal(logoutCalls, 0);
  assert.equal(fixture.exclusiveActive(), false);
});

test("retained enable preserves one complete tuple when the post-commit fence is lost", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  fixture = retainedEnableFixture(() => {
    if (fixture.stateStore.read().connections[0]?.enabled) {
      throw new Error("fixed post-commit provider fence loss");
    }
  });

  const result = await fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  const committed = fixture.stateStore.read();

  assert.deepEqual(result, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  });
  assert.equal(committed.connections[0]?.enabled, true);
  assert.equal(committed.defaultRoute?.canonicalModelId, MODEL);
  assert.deepEqual(fixture.config.providerSetup, committed);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
});

test("retained enable reports ready after an outer post-commit authority failure", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  fixture = retainedEnableFixture(
    () => undefined,
    () => {
      if (fixture.stateStore.read().connections[0]?.enabled) {
        throw new Error("fixed outer post-commit authority failure");
      }
    },
  );

  const result = await fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  const committed = fixture.stateStore.read();

  assert.deepEqual(result, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  });
  assert.equal(committed.connections[0]?.enabled, true);
  assert.equal(committed.defaultRoute?.canonicalModelId, MODEL);
  assert.deepEqual(fixture.config.providerSetup, committed);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
});

test("retained enable adopts a durable commit that rejects after exact adoption", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  let durable: ProviderSetupStateV2 | null = null;
  fixture = retainedEnableFixture(
    () => undefined,
    () => undefined,
    async (request) => {
      const authoritative = durable ?? fixture.stateStore.read();
      const candidate = request.build(structuredClone(authoritative));
      durable = structuredClone(candidate);
      request.adopt(candidate);
      throw new Error("fixed post-adopt persistence release failure");
    },
  );

  const result = await fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  const committed = fixture.stateStore.read();
  const durableCommit = durable as ProviderSetupStateV2 | null;

  assert.deepEqual(result, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  });
  assert.ok(durableCommit);
  assert.equal(durableCommit.connections[0]?.enabled, true);
  assert.deepEqual(committed, durableCommit);
  assert.deepEqual(fixture.config.providerSetup, durableCommit);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
});

test("retained enable adopts an exact commit when persistence resolves a wrong readback", async () => {
  let fixture!: ReturnType<typeof retainedEnableFixture>;
  let durable: ProviderSetupStateV2 | null = null;
  fixture = retainedEnableFixture(
    () => undefined,
    () => undefined,
    async (request) => {
      const authoritative = fixture.stateStore.read();
      const candidate = request.build(structuredClone(authoritative));
      durable = structuredClone(candidate);
      request.adopt(candidate);
      return structuredClone(authoritative);
    },
  );

  const result = await fixture.runtime.execute(
    { kind: "enable", backendId: "openrouter" },
    "plain",
  );
  const committed = fixture.stateStore.read();
  const durableCommit = durable as ProviderSetupStateV2 | null;

  assert.deepEqual(result, {
    kind: "setup",
    backendId: "openrouter",
    outcome: "ready",
  });
  assert.ok(durableCommit);
  assert.deepEqual(committed, durableCommit);
  assert.deepEqual(fixture.config.providerSetup, durableCommit);
  assert.equal(fixture.observed.service.requireKey(), SECRET_A);
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

const KIMI_SLOT = "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711";
const KIMI_FINGERPRINT = "acct_local_kimi";
const KIMI_REALM = "kimi-code-membership-provider-managed-overage" as const;

function kimiRoute(): RouteIdentityV1 {
  return {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: KIMI_FINGERPRINT,
    billingRealm: KIMI_REALM,
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  };
}

function kimiState(slot = KIMI_SLOT): ProviderSetupStateV2 {
  return {
    schemaVersion: 2,
    revision: 4,
    lifecycle: "configured",
    connections: [{
      id: "kimi-main",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialSlot: slot,
      accountFingerprint: KIMI_FINGERPRINT,
      accountFingerprintState: "verified",
      billingRealm: KIMI_REALM,
      lastHealth: null,
    }],
    defaultRoute: kimiRoute(),
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
}

test("Kimi authority binds the literal Kimi slot only inside its callback and never consults OpenRouter environment", async () => {
  const kimiSecret = "fixture-kimi-membership-key-not-a-real-secret";
  const credentials = new AuthorityCredentials({}, { [KIMI_SLOT]: kimiSecret });
  let openRouterEnvironmentReads = 0;
  const environment = new Proxy({} as Record<string, string | undefined>, {
    get(_target, property) {
      if (property === "OPENROUTER_API_KEY") {
        openRouterEnvironmentReads += 1;
        throw new Error("Kimi must not inspect OpenRouter environment");
      }
      return undefined;
    },
  });
  const authority = realAuthority({
    stateStore: new ProviderStateStore(kimiState()),
    credentials,
    environment,
  });
  let binding: ProviderConnectionBindingV2 | null = null;
  let observedInsideCallback: readonly string[] = [];
  const result = await authority.withCredential({
    backendId: "kimi-code",
    connectionId: "kimi-main",
    purpose: "runtime-bind",
    environmentEligibility: "forbidden",
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  }, async (secret, context) => {
    assert.equal(secret, kimiSecret);
    observedInsideCallback = [...credentials.effects];
    binding = context.binding;
    return "used";
  });
  assert.deepEqual(result, { kind: "available", value: "used" });
  assert.deepEqual(observedInsideCallback, [`read:${KIMI_SLOT}`]);
  assert.deepEqual(credentials.effects, [`read:${KIMI_SLOT}`]);
  assert.equal(openRouterEnvironmentReads, 0);
  assert.deepEqual(binding, {
    version: 2,
    stateRevision: 4,
    connectionId: "kimi-main",
    backendId: "kimi-code",
    enabled: true,
    credentialPointer: { kind: "versioned", slot: { version: 1, kind: "kimi-code", id: KIMI_SLOT } },
    accountFingerprint: KIMI_FINGERPRINT,
    billingRealm: KIMI_REALM,
    isDefault: true,
  } satisfies ProviderConnectionBindingV2);
});

test("generic selection rejects a Kimi connection whose slot kind belongs to OpenRouter", () => {
  const invalid = structuredClone(kimiState("v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711"));
  const selected = selectProviderBinding(invalid, {
    kind: "connection",
    connectionId: "kimi-main",
  });
  assert.deepEqual(selected, { kind: "invalid-pointer" });
});

test("Kimi exact authority tuple mutations fence publication", async (t) => {
  const mutations: Readonly<Record<string, (state: ProviderSetupStateV2) => ProviderSetupStateV2>> = {
    revision: (state) => state,
    connection: (state) => ({
      ...state,
      connections: [{ ...state.connections[0]!, id: "kimi-replaced" }],
    }),
    fingerprint: (state) => ({
      ...state,
      connections: [{ ...state.connections[0]!, accountFingerprint: "acct_kimi_changed" }],
      defaultRoute: { ...state.defaultRoute!, accountFingerprint: "acct_kimi_changed" },
    }),
    realm: (state) => ({
      ...state,
      connections: [{
        ...state.connections[0]!,
        backendId: "openrouter",
        maturity: "stable",
        credentialSlot: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0712",
        billingRealm: "openrouter-payg",
      }],
      defaultRoute: {
        ...state.defaultRoute!,
        backendId: "openrouter",
        billingRealm: "openrouter-payg",
      },
    }),
    slot: (state) => ({
      ...state,
      connections: [{
        ...state.connections[0]!,
        credentialSlot: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0712",
      }],
    }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const stateStore = new ProviderStateStore(kimiState());
      const authority = realAuthority({
        stateStore,
        credentials: new AuthorityCredentials({}, { [KIMI_SLOT]: "fixture-kimi-membership-key-not-a-real-secret" }),
      });
      let published = false;
      const result = await authority.withCredential({
        backendId: "kimi-code",
        connectionId: "kimi-main",
        purpose: "runtime-bind",
        environmentEligibility: "forbidden",
        deadlineAt: NOW + 5_000,
        signal: new AbortController().signal,
      }, async (_secret, context) => {
        const current = stateStore.read();
        stateStore.replace(mutate(current), current.revision);
        await context.publishIfCurrent(() => { published = true; });
      });
      assert.deepEqual(result, { kind: "stale" });
      assert.equal(published, false);
    });
  }
});

test("manual Kimi candidate authority issues one callback-scoped observed permit and releases before model choice", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  let authorityOwned = false;
  let callbackObservedOwned = false;
  const coordinator: ProviderAuthorityCoordinator = {
    async readAuthority(_request, operation) {
      assert.equal(authorityOwned, false);
      authorityOwned = true;
      try {
        return await operation({
          async assertHeld() {
            assert.equal(authorityOwned, true);
          },
        });
      } finally {
        authorityOwned = false;
      }
    },
  };
  const authority = realAuthority({ stateStore, credentials, coordinator });
  const api = authority as unknown as ManualKimiAuthorityApi;
  assert.equal(
    typeof api.withManualKimiCandidateAuthority,
    "function",
    "manual Kimi authority must be an explicit seam rather than reusing OpenRouter environment authority",
  );
  const owner = new AbortController();
  const result = await api.withManualKimiCandidateAuthority({
    backendId: "kimi-code",
    candidate: `\r\n  ${KIMI_MANUAL_SECRET}  \n`,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup",
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
  }, async (normalizedCandidate, lease) => {
    callbackObservedOwned = authorityOwned;
    assert.equal(normalizedCandidate, KIMI_MANUAL_SECRET);
    await lease.assertCurrent();
    return {
      candidate: manualKimiCandidate(),
      value: Object.freeze(["k3", "kimi-for-coding"]),
    };
  });

  assert.equal(callbackObservedOwned, true);
  assert.equal(authorityOwned, false, "human model choice must happen after authority release");
  assert.deepEqual(credentials.effects, [], "first manual Kimi paste must not read a credential slot");
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") throw new Error("manual Kimi candidate authority was unavailable");
  assert.deepEqual(result.value.value, ["k3", "kimi-for-coding"]);
  assert.deepEqual(result.value.candidatePermit, { version: 1 });
  assert.equal(Object.isFrozen(result.value.candidatePermit), true);
});

test("manual Kimi observation derives a first connection id and rejects incomplete or stale observations", async (t) => {
  const validRequest = {
    backendId: "kimi-code" as const,
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    purpose: "initial-setup" as const,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  };
  const invalid: ReadonlyArray<readonly [string, (candidate: ProviderCandidate) => ProviderCandidate]> = [
    ["backend", (candidate) => ({ ...candidate, backendId: "openrouter" })],
    ["connection", (candidate) => ({ ...candidate, connectionId: "" })],
    ["fingerprint", (candidate) => ({ ...candidate, accountFingerprint: "" })],
    ["realm", (candidate) => ({ ...candidate, billingRealm: "openrouter-payg" })],
    ["generation", (candidate) => ({
      ...candidate,
      health: { ...candidate.health, generation: validRequest.generation + 1 },
    })],
    ["credential health", (candidate) => ({
      ...candidate,
      health: { ...candidate.health, credential: "rejected" },
    })],
    ["connectivity health", (candidate) => ({
      ...candidate,
      health: { ...candidate.health, connectivity: "offline" },
    })],
  ];

  for (const [name, mutate] of invalid) {
    await t.test(name, async () => {
      const authority = realAuthority({
        stateStore: new ProviderStateStore(createNeverConfiguredProviderState()),
        credentials: new AuthorityCredentials(),
      }) as unknown as ManualKimiAuthorityApi;
      const result = await authority.withManualKimiCandidateAuthority(
        validRequest,
        async () => ({ candidate: mutate(manualKimiCandidate()), value: null }),
      );
      assert.deepEqual(result, { kind: "stale" });
    });
  }

  const authority = realAuthority({
    stateStore: new ProviderStateStore(createNeverConfiguredProviderState()),
    credentials: new AuthorityCredentials(),
  }) as unknown as ManualKimiAuthorityApi;
  const issued = await authority.withManualKimiCandidateAuthority(
    validRequest,
    async () => ({
      candidate: manualKimiCandidate(),
      value: { targetConnectionId: KIMI_MANUAL_CONNECTION },
    }),
  );
  assert.equal(issued.kind, "ready");
  if (issued.kind !== "ready") throw new Error("manual permit was not issued");
  assert.deepEqual(issued.value.value, { targetConnectionId: KIMI_MANUAL_CONNECTION });

  const lease = { async assertHeld() {} };
  const token = Object.freeze({ version: 1 as const });
  assert.deepEqual(await authority.validateCandidatePermitUnderLease({
    ...validRequest,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    originalOwnerSignal: validRequest.signal,
    credentialPermit: issued.value.candidatePermit,
    requireCredentialPermit: true,
    activationAttemptToken: token,
    observedCandidate: manualKimiCandidate(),
  }, lease), { kind: "ready" });
});

test("manual Kimi authority rejects equality deadlines, revision drift, and owner abort before issuing a permit", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const authority = realAuthority({
    stateStore,
    credentials: new AuthorityCredentials(),
  }) as unknown as ManualKimiAuthorityApi;
  const owner = new AbortController();
  const request = {
    backendId: "kimi-code" as const,
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    purpose: "initial-setup" as const,
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
  };

  assert.deepEqual(await authority.withManualKimiCandidateAuthority(
    { ...request, deadlineAt: NOW },
    async () => { throw new Error("expired authority must not inspect"); },
  ), { kind: "stale" });

  const current = stateStore.read();
  stateStore.replace({ ...current, lifecycle: "cancelled" }, current.revision);
  assert.deepEqual(await authority.withManualKimiCandidateAuthority(
    request,
    async () => { throw new Error("stale revision must not inspect"); },
  ), { kind: "stale" });

  const aborted = new AbortController();
  aborted.abort(new DOMException("owner stopped", "AbortError"));
  await assert.rejects(
    authority.withManualKimiCandidateAuthority(
      { ...request, expectedRevision: 1, signal: aborted.signal },
      async () => { throw new Error("aborted authority must not inspect"); },
    ),
    (error: unknown) => error === aborted.signal.reason,
  );
});

test("manual Kimi permit binds the full observation, claims one activation token, and rejects replay or release", async (t) => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const credentials = new AuthorityCredentials();
  const authority = realAuthority({ stateStore, credentials });
  const api = authority as unknown as ManualKimiAuthorityApi;
  assert.equal(typeof api.withManualKimiCandidateAuthority, "function");
  assert.equal(typeof api.releaseManualKimiCandidatePermit, "function");
  const owner = new AbortController();
  const observed = manualKimiCandidate();
  const issued = await api.withManualKimiCandidateAuthority({
    backendId: "kimi-code",
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup",
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
  }, async (_candidate, lease) => {
    await lease.assertCurrent();
    return { candidate: observed, value: null };
  });
  assert.equal(issued.kind, "ready");
  if (issued.kind !== "ready") throw new Error("manual Kimi permit was not issued");
  const permit = issued.value.candidatePermit;
  const tokenA = Object.freeze({ version: 1 as const });
  const tokenB = Object.freeze({ version: 1 as const });
  const base = {
    backendId: "kimi-code" as const,
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup" as const,
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
    originalOwnerSignal: owner.signal,
    credentialPermit: permit,
    requireCredentialPermit: true as const,
    activationAttemptToken: tokenA,
    observedCandidate: observed,
  };
  const lease = { async assertHeld() {} };

  assert.deepEqual(await api.validateCandidatePermitUnderLease(base, lease), { kind: "ready" });
  assert.deepEqual(
    await api.validateCandidatePermitUnderLease(base, lease),
    { kind: "ready" },
    "revalidation in the same activation attempt must remain valid",
  );
  assert.deepEqual(
    await api.validateCandidatePermitUnderLease({ ...base, activationAttemptToken: tokenB }, lease),
    { kind: "stale" },
    "a second activation token must not replay a claimed manual permit",
  );

  const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["backend", { backendId: "openrouter" }],
    ["candidate", { candidate: KIMI_MANUAL_FOREIGN_SECRET }],
    ["revision", { expectedRevision: 1 }],
    ["generation", { generation: 8 }],
    ["connection", { targetConnectionId: "kimi-manual-foreign" }],
    ["purpose", { purpose: "runtime-bind" }],
    ["deadline equality", { deadlineAt: NOW }],
    ["owner signal", { originalOwnerSignal: new AbortController().signal }],
    ["observed connection", {
      observedCandidate: { ...observed, connectionId: "kimi-manual-foreign" },
    }],
    ["observed generation", {
      observedCandidate: { ...observed, health: { ...observed.health, generation: 8 } },
    }],
    ["observed health", {
      observedCandidate: {
        ...observed,
        health: { ...observed.health, connectivity: "offline" },
      },
    }],
    ["observed fingerprint", {
      observedCandidate: { ...observed, accountFingerprint: "acct_kimi_manual_foreign" },
    }],
    ["observed realm", {
      observedCandidate: { ...observed, billingRealm: "openrouter-payg" },
    }],
  ];
  for (const [name, mutation] of mutations) {
    await t.test(name, async () => {
      assert.deepEqual(
        await api.validateCandidatePermitUnderLease({ ...base, ...mutation } as never, lease),
        { kind: "stale" },
      );
    });
  }

  assert.deepEqual(await api.validateCandidatePermitUnderLease({
    ...base,
    credentialPermit: Object.freeze({ version: 1 }),
  }, lease), { kind: "stale" });
  api.releaseManualKimiCandidatePermit(permit);
  assert.deepEqual(await api.validateCandidatePermitUnderLease(base, lease), { kind: "stale" });
});

test("manual Kimi issuance rechecks revision after observation and owner abort revokes validation", async () => {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const authority = realAuthority({
    stateStore,
    credentials: new AuthorityCredentials(),
  }) as unknown as ManualKimiAuthorityApi;
  const owner = new AbortController();
  const request = {
    backendId: "kimi-code" as const,
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup" as const,
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
  };
  const drifted = await authority.withManualKimiCandidateAuthority(request, async () => {
    const current = stateStore.read();
    stateStore.replace({ ...current, lifecycle: "cancelled" }, current.revision);
    return { candidate: manualKimiCandidate(), value: null };
  });
  assert.deepEqual(drifted, { kind: "stale" });

  const freshStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const freshAuthority = realAuthority({
    stateStore: freshStore,
    credentials: new AuthorityCredentials(),
  }) as unknown as ManualKimiAuthorityApi;
  const issued = await freshAuthority.withManualKimiCandidateAuthority(
    request,
    async () => ({ candidate: manualKimiCandidate(), value: null }),
  );
  assert.equal(issued.kind, "ready");
  if (issued.kind !== "ready") throw new Error("manual permit was not issued");
  owner.abort(new DOMException("owner cancelled after model choice", "AbortError"));
  let leaseEffects = 0;
  await assert.rejects(
    freshAuthority.validateCandidatePermitUnderLease({
      ...request,
      originalOwnerSignal: owner.signal,
      credentialPermit: issued.value.candidatePermit,
      requireCredentialPermit: true,
      activationAttemptToken: Object.freeze({ version: 1 }),
    }, { async assertHeld() { leaseEffects += 1; } }),
    (error: unknown) => error === owner.signal.reason,
  );
  assert.equal(leaseEffects, 0);
});

test("two concurrent Kimi activation tokens can claim a manual permit only once", async () => {
  const authority = realAuthority({
    stateStore: new ProviderStateStore(createNeverConfiguredProviderState()),
    credentials: new AuthorityCredentials(),
  }) as unknown as ManualKimiAuthorityApi;
  const owner = new AbortController();
  const issued = await authority.withManualKimiCandidateAuthority({
    backendId: "kimi-code",
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup",
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
  }, async () => ({ candidate: manualKimiCandidate(), value: null }));
  assert.equal(issued.kind, "ready");
  if (issued.kind !== "ready") throw new Error("manual permit was not issued");
  const common = {
    backendId: "kimi-code" as const,
    candidate: KIMI_MANUAL_SECRET,
    expectedRevision: 0,
    generation: 7,
    targetConnectionId: KIMI_MANUAL_CONNECTION,
    purpose: "initial-setup" as const,
    deadlineAt: NOW + 5_000,
    signal: owner.signal,
    originalOwnerSignal: owner.signal,
    credentialPermit: issued.value.candidatePermit,
    requireCredentialPermit: true as const,
  };
  const lease = { async assertHeld() { await Promise.resolve(); } };
  const [a, b] = await Promise.all([
    authority.validateCandidatePermitUnderLease({
      ...common,
      activationAttemptToken: Object.freeze({ version: 1 as const }),
    }, lease),
    authority.validateCandidatePermitUnderLease({
      ...common,
      activationAttemptToken: Object.freeze({ version: 1 as const }),
    }, lease),
  ]);

  assert.deepEqual([a.kind, b.kind].sort(), ["ready", "stale"]);
});

// Kimi requests must never be able to opt into an environment credential at
// the type boundary. Removing the discriminated request union must make this
// negative contract fail TypeScript compilation.
// @ts-expect-error Kimi has no environment-credential eligibility modes.
const KIMI_ENVIRONMENT_REQUEST_MUST_NOT_TYPECHECK: ProviderCredentialRequest = {
  backendId: "kimi-code",
  connectionId: "kimi-main",
  purpose: "runtime-bind",
  environmentEligibility: "automatic-if-no-saved",
  deadlineAt: NOW + 5_000,
  signal: new AbortController().signal,
};
void KIMI_ENVIRONMENT_REQUEST_MUST_NOT_TYPECHECK;
