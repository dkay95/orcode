import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_COMING_SOON_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
  OpenRouterBackendAdapter,
  openRouterAccountFingerprint,
} from "../src/openrouter-backend.js";
import { isMainModelCandidate, OpenRouterService } from "../src/openrouter.js";
import type {
  CredentialKind,
  CredentialSlotRef,
  VersionedCredentialStoreLike,
} from "../src/credentials.js";

const ACTIVE_KEY = ["active", "fixture", "key", "a".repeat(32)].join("-");
const INFERENCE_KEY = ["inference", "fixture", "key", "b".repeat(32)].join("-");
const MANAGEMENT_KEY = ["management", "fixture", "key", "c".repeat(32)].join("-");
const ENV_MANAGEMENT_KEY = ["environment", "management", "d".repeat(32)].join("-");
const CREATOR_A = ["user", "documented", "a"].join("_");
const CREATOR_B = ["user", "documented", "b"].join("_");
const HMAC_KEY = new Uint8Array(32).fill(7);
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function keyResponse(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      label: "Fixture label",
      is_free_tier: false,
      is_management_key: true,
      creator_user_id: CREATOR_A,
      limit: null,
      limit_remaining: null,
      usage: 1,
      usage_daily: 1,
      usage_weekly: 1,
      usage_monthly: 1,
      expires_at: null,
      ...extra,
    },
  });
}

function creditsResponse(totalCredits = 10, totalUsage = 4): Response {
  return jsonResponse({ data: { total_credits: totalCredits, total_usage: totalUsage } });
}

function bearerOf(init: RequestInit): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

class FakeCredentials implements VersionedCredentialStoreLike {
  readonly location = "fixture-keychain";
  readonly effects: string[] = [];
  readonly reads: CredentialKind[] = [];

  constructor(
    private readonly saved: Partial<Record<CredentialKind, string | null>> = {
      inference: INFERENCE_KEY,
      management: null,
    },
    private readonly hmacKey = HMAC_KEY,
  ) {}

  async get(kind: CredentialKind): Promise<string | null> {
    this.reads.push(kind);
    return this.saved[kind] ?? null;
  }

  async set(_kind: CredentialKind, _secret: string): Promise<void> {
    this.effects.push("set");
  }

  async delete(_kind: CredentialKind): Promise<boolean> {
    this.effects.push("delete");
    return false;
  }

  async has(kind: CredentialKind): Promise<boolean> {
    return (await this.get(kind)) !== null;
  }

  reserveSlot(kind: CredentialKind): CredentialSlotRef {
    this.effects.push("reserveSlot");
    return {
      version: 1,
      kind,
      id: `v1:${kind}:00000000-0000-4000-8000-000000000001`,
    };
  }

  async writeSlot(_slot: CredentialSlotRef, _secret: string): Promise<void> {
    this.effects.push("writeSlot");
  }

  async readSlot(_slot: CredentialSlotRef): Promise<string | null> {
    this.effects.push("readSlot");
    return null;
  }

  async deleteSlot(_slot: CredentialSlotRef): Promise<boolean> {
    this.effects.push("deleteSlot");
    return false;
  }

  async getOrCreateAccountHmacKey(): Promise<Uint8Array> {
    this.effects.push("accountHmac");
    return new Uint8Array(this.hmacKey);
  }
}

interface InspectFixtureOptions {
  keyStatus?: number;
  keyExtra?: Record<string, unknown>;
  keyFailure?: unknown;
  creditsStatus?: number;
  creditsFailure?: unknown;
  credits?: { total: number; usage: number };
  credentials?: FakeCredentials;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

async function inspectFixture(options: InspectFixtureOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const credentials = options.credentials ?? new FakeCredentials();
  const service = new OpenRouterService(
    ACTIVE_KEY,
    MANAGEMENT_KEY,
    { inference: "keychain", management: "keychain" },
    {
      now: () => NOW,
      clock: { sleep: async () => undefined },
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith("/models")) {
          throw new Error("model catalogue must not be requested during inspection");
        }
        if (url.endsWith("/credits")) {
          if (options.creditsFailure) throw options.creditsFailure;
          if (options.creditsStatus && options.creditsStatus !== 200) {
            return jsonResponse(
              { error: { message: `opaque-credit-body-${options.creditsStatus}` } },
              { status: options.creditsStatus },
            );
          }
          return creditsResponse(options.credits?.total, options.credits?.usage);
        }
        if (options.keyFailure) throw options.keyFailure;
        const status = options.keyStatus ?? 200;
        return status === 200
          ? keyResponse(options.keyExtra)
          : jsonResponse(
              { error: { message: `opaque-key-body-${status}` } },
              { status },
            );
      },
    },
  );
  service.activateValidatedKey(ACTIVE_KEY, "keychain", {
    key: { limitRemaining: 5 },
    credits: { totalCredits: 10, totalUsage: 4, remaining: 6 },
  });
  service.activateValidatedManagementKey(MANAGEMENT_KEY, "keychain", {
    totalCredits: 10,
    totalUsage: 4,
    remaining: 6,
  });
  const before = service.runtimeState;
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials,
    connectionId: "connection-local",
    environment: options.environment ?? {},
    now: () => NOW,
  });
  const result = await adapter.inspect({
    generation: 7,
    deadlineAt: NOW + 5_000,
    signal: options.signal ?? new AbortController().signal,
  });
  return {
    result,
    calls,
    service,
    credentials,
    before,
    creditRequests: calls.filter((call) => call.url.endsWith("/credits")).length,
    modelRequests: calls.filter((call) => call.url.endsWith("/models")).length,
  };
}

test("OpenRouter and Anthropic descriptors keep Slice-1 capability boundaries", () => {
  assert.deepEqual(OPENROUTER_DESCRIPTOR, {
    id: "openrouter",
    displayName: "OpenRouter",
    maturity: "stable",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "api-payg",
    capabilities: { models: true, tools: true, reasoning: true },
  });
  assert.deepEqual(ANTHROPIC_COMING_SOON_DESCRIPTOR, {
    id: "anthropic",
    displayName: "Anthropic / Claude-Abo",
    maturity: "coming-soon",
    connectable: false,
    kind: "managed-agent",
    credentialOwner: "none",
    billingRealmKind: "none",
    capabilities: { models: false, tools: false, reasoning: false },
  });
});

const healthCases = [
  { name: "valid", keyStatus: 200, expected: ["valid", "connected", "available"], credits: true },
  { name: "rejected", keyStatus: 401, expected: ["rejected", "connected", "unknown"], credits: false },
  { name: "ambiguous forbidden", keyStatus: 403, expected: ["unknown", "connected", "unknown"], credits: false },
  { name: "rate limited", keyStatus: 429, expected: ["unknown", "connected", "unknown"], credits: false },
  { name: "provider failure", keyStatus: 503, expected: ["unknown", "connected", "unknown"], credits: false },
] as const;

for (const fixture of healthCases) {
  test(`OpenRouter inspection classifies ${fixture.name}`, async () => {
    const observed = await inspectFixture({ keyStatus: fixture.keyStatus });
    assert.deepEqual(
      [
        observed.result.health.credential,
        observed.result.health.connectivity,
        observed.result.health.spend,
      ],
      fixture.expected,
    );
    assert.equal(observed.creditRequests > 0, fixture.credits);
    assert.equal(observed.modelRequests, 0);
    assert.deepEqual(observed.service.runtimeState, observed.before);
    assert.equal(observed.service.requireKey(), ACTIVE_KEY);
  });
}

for (const fixture of [
  {
    name: "DNS",
    failure: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    connectivity: "offline",
  },
  {
    name: "TLS",
    failure: Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
    connectivity: "offline",
  },
  {
    name: "timeout",
    failure: Object.assign(new Error("deadline"), { name: "TimeoutError" }),
    connectivity: "unknown",
  },
] as const) {
  test(`OpenRouter inspection keeps ${fixture.name} separate from rejection`, async () => {
    const observed = await inspectFixture({ keyFailure: fixture.failure });
    assert.deepEqual(
      [
        observed.result.health.credential,
        observed.result.health.connectivity,
        observed.result.health.spend,
      ],
      ["unknown", fixture.connectivity, "unknown"],
    );
    assert.equal(observed.result.retryable, true);
    assert.equal(observed.modelRequests, 0);
    assert.deepEqual(observed.service.runtimeState, observed.before);
  });
}

test("OpenRouter inspection classifies caller abort without mutating active state", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancel fixture", "AbortError"));
  const observed = await inspectFixture({ signal: controller.signal });
  assert.deepEqual(
    [
      observed.result.health.credential,
      observed.result.health.connectivity,
      observed.result.health.spend,
    ],
    ["unknown", "unknown", "unknown"],
  );
  assert.equal(observed.result.explanationCode, "openrouter-inspection-cancelled");
  assert.deepEqual(observed.service.runtimeState, observed.before);
});

for (const fixture of [
  { name: "past", expiresAt: new Date(NOW - 1).toISOString(), credential: "expired", eligible: false },
  { name: "exactly now", expiresAt: new Date(NOW).toISOString(), credential: "valid", eligible: true },
  { name: "future", expiresAt: new Date(NOW + 1).toISOString(), credential: "valid", eligible: true },
  { name: "missing", expiresAt: undefined, credential: "valid", eligible: true },
] as const) {
  test(`OpenRouter inspection classifies ${fixture.name} expires_at exactly`, async () => {
    const keyExtra = fixture.expiresAt === undefined
      ? { expires_at: undefined }
      : { expires_at: fixture.expiresAt };
    const observed = await inspectFixture({ keyExtra });
    assert.equal(observed.result.health.credential, fixture.credential);
    assert.equal(observed.result.routeEligible, fixture.eligible);
  });
}

test("known zero key limit blocks a run even when account credits are positive", async () => {
  const observed = await inspectFixture({ keyExtra: { limit_remaining: 0 } });
  assert.equal(observed.result.health.spend, "limit-reached");
  assert.equal(observed.result.headline, "limit-reached");
  assert.equal(observed.result.routeEligible, false);
});

test("known zero account credits block a run", async () => {
  const observed = await inspectFixture({ credits: { total: 4, usage: 4 } });
  assert.equal(observed.result.health.spend, "limit-reached");
  assert.equal(observed.result.headline, "limit-reached");
  assert.equal(observed.result.routeEligible, false);
});

test("a valid inference key without authoritative credits remains runnable with a qualifier", async () => {
  const credentials = new FakeCredentials({ inference: INFERENCE_KEY, management: null });
  const observed = await inspectFixture({
    credentials,
    keyExtra: { is_management_key: false, limit_remaining: null },
  });
  assert.equal(observed.creditRequests, 0);
  assert.equal(observed.result.health.spend, "unknown");
  assert.equal(observed.result.headline, "ready");
  assert.equal(observed.result.routeEligible, true);
  assert.ok(observed.result.qualifiers.includes("Guthaben unbekannt"));
});

test("unknown management capability skips credits instead of guessing", async () => {
  const credentials = new FakeCredentials({
    inference: INFERENCE_KEY,
    management: MANAGEMENT_KEY,
  });
  const observed = await inspectFixture({
    credentials,
    keyExtra: { is_management_key: undefined },
  });
  assert.equal(observed.creditRequests, 0);
  assert.deepEqual(credentials.reads, ["inference"]);
  assert.equal(observed.result.health.credential, "valid");
  assert.equal(observed.result.health.spend, "unknown");
});

test("a management-capable inference key is the authoritative credits bearer", async () => {
  const credentials = new FakeCredentials({
    inference: INFERENCE_KEY,
    management: MANAGEMENT_KEY,
  });
  const observed = await inspectFixture({ credentials });
  const creditsCall = observed.calls.find((call) => call.url.endsWith("/credits"));
  assert.equal(bearerOf(creditsCall?.init ?? {}), `Bearer ${INFERENCE_KEY}`);
  assert.deepEqual(credentials.reads, ["inference"]);
});

test("saved inference key wins and suppresses the process environment key", async () => {
  const credentials = new FakeCredentials({ inference: INFERENCE_KEY, management: null });
  let environmentReads = 0;
  const environment = new Proxy<Record<string, string | undefined>>({}, {
    get(_target, property) {
      if (property === "OPENROUTER_API_KEY") environmentReads += 1;
      return ACTIVE_KEY;
    },
  });
  const observed = await inspectFixture({
    credentials,
    environment,
    keyExtra: { is_management_key: false },
  });
  const keyCall = observed.calls.find((call) => call.url.endsWith("/key"));
  assert.equal(bearerOf(keyCall?.init ?? {}), `Bearer ${INFERENCE_KEY}`);
  assert.equal(environmentReads, 0);
  assert.deepEqual(credentials.effects, ["accountHmac"]);
});

test("absent saved inference key allows process-only environment inspection and never persists it", async () => {
  const credentials = new FakeCredentials({ inference: null, management: null });
  const observed = await inspectFixture({
    credentials,
    environment: { OPENROUTER_API_KEY: INFERENCE_KEY },
    keyExtra: { is_management_key: false },
  });
  const keyCall = observed.calls.find((call) => call.url.endsWith("/key"));
  assert.equal(bearerOf(keyCall?.init ?? {}), `Bearer ${INFERENCE_KEY}`);
  assert.deepEqual(credentials.effects, ["accountHmac"]);
});

test("an unreadable saved inference key blocks environment fallback and returns a safe unknown status", async () => {
  class UnreadableCredentials extends FakeCredentials {
    override async get(kind: CredentialKind): Promise<string | null> {
      if (kind === "inference") {
        throw new Error(`opaque-keychain-body-${INFERENCE_KEY}`);
      }
      return super.get(kind);
    }
  }
  let environmentReads = 0;
  const environment = new Proxy<Record<string, string | undefined>>({}, {
    get(_target, property) {
      if (property === "OPENROUTER_API_KEY") environmentReads += 1;
      return ACTIVE_KEY;
    },
  });
  const observed = await inspectFixture({
    credentials: new UnreadableCredentials(),
    environment,
  });
  assert.equal(observed.calls.length, 0);
  assert.equal(environmentReads, 0);
  assert.deepEqual(
    [
      observed.result.health.credential,
      observed.result.health.connectivity,
      observed.result.health.spend,
    ],
    ["unknown", "unknown", "unknown"],
  );
  assert.equal(observed.result.explanationCode, "openrouter-credential-unavailable");
  assert.doesNotMatch(JSON.stringify(observed.result), /opaque-keychain-body/);
  assert.doesNotMatch(JSON.stringify(observed.result), new RegExp(INFERENCE_KEY));
});

test("saved management key wins and suppresses the process environment key", async () => {
  const credentials = new FakeCredentials({
    inference: INFERENCE_KEY,
    management: MANAGEMENT_KEY,
  });
  let environmentReads = 0;
  const environment = new Proxy<Record<string, string | undefined>>({}, {
    get(_target, property) {
      if (property === "OPENROUTER_MANAGEMENT_KEY") environmentReads += 1;
      return ENV_MANAGEMENT_KEY;
    },
  });
  const observed = await inspectFixture({
    credentials,
    environment,
    keyExtra: { is_management_key: false },
  });
  const creditsCall = observed.calls.find((call) => call.url.endsWith("/credits"));
  assert.equal(bearerOf(creditsCall?.init ?? {}), `Bearer ${MANAGEMENT_KEY}`);
  assert.equal(environmentReads, 0);
  assert.deepEqual(credentials.effects, ["accountHmac"]);
});

test("absent saved management key allows process-only environment inspection and never persists it", async () => {
  const credentials = new FakeCredentials({ inference: INFERENCE_KEY, management: null });
  const observed = await inspectFixture({
    credentials,
    environment: { OPENROUTER_MANAGEMENT_KEY: ENV_MANAGEMENT_KEY },
    keyExtra: { is_management_key: false },
  });
  const creditsCall = observed.calls.find((call) => call.url.endsWith("/credits"));
  assert.equal(bearerOf(creditsCall?.init ?? {}), `Bearer ${ENV_MANAGEMENT_KEY}`);
  assert.deepEqual(credentials.effects, ["accountHmac"]);
});

for (const fixture of [
  { name: "401", status: 401 },
  { name: "403", status: 403 },
  { name: "429", status: 429 },
  { name: "5xx", status: 503 },
] as const) {
  test(`/credits ${fixture.name} changes only spend visibility`, async () => {
    const credentials = new FakeCredentials({
      inference: INFERENCE_KEY,
      management: MANAGEMENT_KEY,
    });
    const observed = await inspectFixture({
      credentials,
      keyExtra: { is_management_key: false },
      creditsStatus: fixture.status,
    });
    assert.deepEqual(
      [
        observed.result.health.credential,
        observed.result.health.connectivity,
        observed.result.health.spend,
      ],
      ["valid", "connected", "unknown"],
    );
    assert.equal(observed.result.routeEligible, true);
    assert.doesNotMatch(JSON.stringify(observed.result), /opaque-credit-body/);
    assert.deepEqual(observed.service.runtimeState, observed.before);
  });
}

test("/credits DNS failure preserves valid connected inference health", async () => {
  const credentials = new FakeCredentials({
    inference: INFERENCE_KEY,
    management: MANAGEMENT_KEY,
  });
  const observed = await inspectFixture({
    credentials,
    keyExtra: { is_management_key: false },
    creditsFailure: Object.assign(new TypeError("opaque credits transport"), {
      cause: { code: "ENOTFOUND" },
    }),
  });
  assert.deepEqual(
    [
      observed.result.health.credential,
      observed.result.health.connectivity,
      observed.result.health.spend,
    ],
    ["valid", "connected", "unknown"],
  );
  assert.equal(observed.result.routeEligible, true);
  assert.doesNotMatch(JSON.stringify(observed.result), /opaque credits transport/);
});

test("account fingerprints use the fixed provider namespace and never expose identity", async () => {
  const left = openRouterAccountFingerprint(HMAC_KEY, CREATOR_A);
  const again = openRouterAccountFingerprint(HMAC_KEY, CREATOR_A);
  const right = openRouterAccountFingerprint(HMAC_KEY, CREATOR_B);
  assert.equal(left, "acct_or_gqMCXWr0pvg-ha-tSFQDDC__zOECI_0KrZtyu2JzSmw");
  assert.equal(left, again);
  assert.notEqual(left, right);

  const observed = await inspectFixture();
  assert.equal(observed.result.accountFingerprint, left);
  assert.doesNotMatch(JSON.stringify(observed.result), new RegExp(CREATOR_A));
  assert.doesNotMatch(JSON.stringify(observed.result), new RegExp(INFERENCE_KEY));
});

for (const creatorUserId of [undefined, null] as const) {
  test(`missing creator_user_id ${String(creatorUserId)} authenticates but cannot bind a route`, async () => {
    const observed = await inspectFixture({ keyExtra: { creator_user_id: creatorUserId } });
    assert.equal(observed.result.health.credential, "valid");
    assert.equal(observed.result.health.connectivity, "connected");
    assert.equal(observed.result.accountFingerprint, null);
    assert.equal(observed.result.routeEligible, false);
    assert.equal(observed.result.explanationCode, "openrouter-account-identity-missing");
    assert.doesNotMatch(JSON.stringify(observed.result), new RegExp(INFERENCE_KEY));
  });
}

test("model catalog is unavailable before exact account inspection", async () => {
  let modelRequests = 0;
  const service = new OpenRouterService(undefined, undefined, {}, {
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) modelRequests += 1;
      return jsonResponse({ data: [] });
    },
  });
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials: new FakeCredentials(),
    connectionId: "connection-local",
    now: () => NOW,
  });
  await assert.rejects(
    adapter.listModels({ signal: new AbortController().signal }),
    /inspect|inspection|prüf/i,
  );
  assert.equal(modelRequests, 0);
});

test("setup main-model list follows the shared role predicate and keeps only openrouter auto exception", async () => {
  const models = [
    {
      id: "vendor/valid",
      name: "Valid",
      context_length: 8_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "vendor/no-text-input",
      name: "No text input",
      context_length: 8_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["image"], output_modalities: ["text"] },
    },
    {
      id: "vendor/no-text-output",
      name: "No text output",
      context_length: 8_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
    {
      id: "vendor/no-tools",
      name: "No tools",
      context_length: 8_000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: [],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "openrouter/auto",
      name: "Auto",
      context_length: 8_000,
      pricing: { prompt: "-1", completion: "-1" },
      supported_parameters: [],
      architecture: { input_modalities: [], output_modalities: [] },
    },
  ];
  const calls: string[] = [];
  const service = new OpenRouterService(ACTIVE_KEY, undefined, {}, {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/key")) return keyResponse({ is_management_key: false });
      if (url.endsWith("/models")) return jsonResponse({ data: models });
      throw new Error("unexpected endpoint");
    },
  });
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials: new FakeCredentials({ inference: INFERENCE_KEY, management: null }),
    connectionId: "connection-local",
    now: () => NOW,
  });
  const inspection = await adapter.inspect({
    generation: 1,
    deadlineAt: NOW + 5_000,
    signal: new AbortController().signal,
  });
  assert.equal(inspection.routeEligible, true);

  const listed = await adapter.listModels({ signal: new AbortController().signal });
  assert.deepEqual(listed.map((entry) => entry.requestedModelId), [
    "vendor/valid",
    "openrouter/auto",
  ]);
  assert.deepEqual(
    listed.map((entry) => entry.requestedModelId),
    models.filter((entry) => isMainModelCandidate({
      id: entry.id,
      name: entry.name,
      description: "",
      contextLength: entry.context_length,
      promptPrice: Number(entry.pricing.prompt),
      completionPrice: Number(entry.pricing.completion),
      supportedParameters: entry.supported_parameters,
      inputModalities: entry.architecture.input_modalities,
      outputModalities: entry.architecture.output_modalities,
    })).map((entry) => entry.id),
  );
  assert.equal(calls.filter((url) => url.endsWith("/models")).length, 1);
  assert.equal(service.modelCacheAgeMs(), null);
});

test("candidate connection is inspection-only until explicit activation", async () => {
  const credentials = new FakeCredentials({ inference: ACTIVE_KEY, management: null });
  const service = new OpenRouterService(ACTIVE_KEY, undefined, { inference: "keychain" }, {
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/key")) {
        assert.equal(bearerOf(init), `Bearer ${INFERENCE_KEY}`);
        return keyResponse({ is_management_key: false });
      }
      throw new Error("unexpected endpoint");
    },
  });
  service.activateValidatedKey(ACTIVE_KEY, "keychain", {
    key: { limitRemaining: 3 },
  });
  const before = service.runtimeState;
  const adapter = new OpenRouterBackendAdapter({
    service,
    credentials,
    connectionId: "connection-local",
    createCandidateId: () => "candidate-local",
    now: () => NOW,
  });
  const candidate = await adapter.connect({
    candidate: INFERENCE_KEY,
    generation: 9,
    signal: new AbortController().signal,
  });
  assert.equal(candidate.candidateId, "candidate-local");
  assert.equal(candidate.accountFingerprint, openRouterAccountFingerprint(HMAC_KEY, CREATOR_A));
  assert.deepEqual(service.runtimeState, before);
  assert.equal(service.requireKey(), ACTIVE_KEY);
  assert.deepEqual(credentials.effects, ["accountHmac"]);
});
