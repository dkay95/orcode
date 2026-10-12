import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_IDS,
  BackendRegistry,
  ProviderComingSoonError,
  ProviderSetupRequiredError,
  deriveProviderHeadline,
  sameRoute,
  type BackendAdapter,
  type BackendDescriptor,
  type ProviderHealth,
  type RouteIdentityV1,
} from "../src/backends.js";
import { KIMI_CODE_DESCRIPTOR } from "../src/kimi-code-backend.js";

const ready: ProviderHealth = {
  credential: "valid",
  connectivity: "connected",
  spend: "available",
  runtime: "not-applicable",
  observedAt: 100,
  generation: 7,
};

const openRouterDescriptor: BackendDescriptor = {
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: { models: true, tools: true, reasoning: true },
};

function adapter(backendId: BackendAdapter["backendId"] = "openrouter"): BackendAdapter {
  return {
    backendId,
    async inspect() { throw new Error("not used"); },
    async connect() { throw new Error("not used"); },
    async listModels() { return []; },
    async activate() { throw new Error("not used"); },
    async reconnect() { throw new Error("not used"); },
    async logout() {},
    async discardCandidate() {},
  };
}

test("health dimensions reduce without turning unknown transport into auth rejection", () => {
  const cases: ReadonlyArray<{ health: ProviderHealth; expected: ReturnType<typeof deriveProviderHeadline> }> = [
    { health: ready, expected: "ready" },
    { health: { ...ready, spend: "unknown" }, expected: "ready" },
    { health: { ...ready, credential: "login-required" }, expected: "login-required" },
    { health: { ...ready, credential: "rejected" }, expected: "auth-rejected" },
    { health: { ...ready, credential: "expired" }, expected: "credential-expired" },
    { health: { ...ready, connectivity: "offline" }, expected: "offline" },
    { health: { ...ready, runtime: "missing" }, expected: "runtime-missing" },
    { health: { ...ready, runtime: "incompatible" }, expected: "incompatible-runtime" },
    { health: { ...ready, runtime: "policy-unavailable" }, expected: "policy-unavailable" },
    { health: { ...ready, spend: "limit-reached" }, expected: "limit-reached" },
    { health: { ...ready, credential: "unknown", connectivity: "unknown" }, expected: "unknown" },
  ];

  for (const { health, expected } of cases) {
    assert.equal(deriveProviderHeadline(health), expected);
  }
});

test("route identity compares backend account realm and canonical model", () => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_local_a",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/gpt",
    canonicalModelId: "openai/gpt-2026",
    resolutionState: "resolved",
  };
  assert.equal(sameRoute(route, { ...route }), true);
  assert.equal(sameRoute(route, { ...route, accountFingerprint: "acct_local_b" }), false);
  assert.equal(sameRoute(route, { ...route, backendId: "codex" }), false);
  assert.equal(sameRoute(route, { ...route, billingRealm: "none" }), false);
  assert.equal(sameRoute(route, { ...route, canonicalModelId: "openai/gpt-2027" }), false);
});

test("Kimi Code is a first-class route identity with its provider-managed realm", () => {
  const kimiRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_local_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  };

  assert.deepEqual(BACKEND_IDS, ["openrouter", "kimi-code", "codex", "anthropic"]);
  assert.equal(sameRoute(kimiRoute, { ...kimiRoute }), true);
});

test("coming-soon descriptors have no adapter and reject connect structurally", () => {
  const descriptor: BackendDescriptor = {
    id: "anthropic",
    displayName: "Anthropic / Claude subscription",
    maturity: "coming-soon",
    connectable: false,
    kind: "managed-agent",
    credentialOwner: "none",
    billingRealmKind: "none",
    capabilities: { models: false, tools: false, reasoning: false },
  };
  const registry = new BackendRegistry([{ descriptor }]);
  assert.equal(registry.descriptor("anthropic").maturity, "coming-soon");
  assert.throws(() => registry.adapter("anthropic"), ProviderComingSoonError);
});

test("registry preserves insertion order for valid descriptors", () => {
  const anthropic: BackendDescriptor = {
    id: "anthropic",
    displayName: "Anthropic / Claude subscription",
    maturity: "coming-soon",
    connectable: false,
    kind: "managed-agent",
    credentialOwner: "none",
    billingRealmKind: "none",
    capabilities: { models: false, tools: false, reasoning: false },
  };
  const registry = new BackendRegistry([
    { descriptor: openRouterDescriptor, adapter: adapter() },
    { descriptor: anthropic },
  ]);
  assert.deepEqual(registry.entries().map(({ id }) => id), ["openrouter", "anthropic"]);
});

test("registry permits exactly one explicitly Preview Kimi adapter", () => {
  const registry = new BackendRegistry([
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: adapter("kimi-code") },
  ]);
  assert.equal(registry.descriptor("kimi-code"), KIMI_CODE_DESCRIPTOR);
  assert.equal(registry.adapter("kimi-code").backendId, "kimi-code");

  for (const descriptor of [
    { ...KIMI_CODE_DESCRIPTOR, maturity: "stable" as const },
    { ...KIMI_CODE_DESCRIPTOR, maturity: "coming-soon" as const, connectable: false },
    { ...KIMI_CODE_DESCRIPTOR, connectable: false },
  ]) {
    assert.throws(
      () => new BackendRegistry([{ descriptor, adapter: adapter("kimi-code") }]),
      /kimi.*preview/i,
    );
  }
});

test("registry rejects contradictory descriptor and adapter combinations", () => {
  const comingSoon: BackendDescriptor = {
    id: "anthropic",
    displayName: "Anthropic / Claude subscription",
    maturity: "coming-soon",
    connectable: false,
    kind: "managed-agent",
    credentialOwner: "none",
    billingRealmKind: "none",
    capabilities: { models: false, tools: false, reasoning: false },
  };

  const cases: ReadonlyArray<{ entries: ConstructorParameters<typeof BackendRegistry>[0]; expected: RegExp }> = [
    {
      entries: [{ descriptor: openRouterDescriptor, adapter: adapter() }, { descriptor: openRouterDescriptor, adapter: adapter() }],
      expected: /duplicate backend descriptor/i,
    },
    {
      entries: [{ descriptor: openRouterDescriptor, adapter: adapter("codex") }],
      expected: /does not match descriptor/i,
    },
    {
      entries: [{ descriptor: openRouterDescriptor }],
      expected: /requires an adapter/i,
    },
    {
      entries: [{ descriptor: comingSoon, adapter: adapter("anthropic") }],
      expected: /must not have an adapter/i,
    },
  ];

  for (const { entries, expected } of cases) {
    assert.throws(() => new BackendRegistry(entries), expected);
  }
});

test("registry distinguishes an unknown backend from a registered coming-soon backend", () => {
  const registry = new BackendRegistry([{ descriptor: openRouterDescriptor, adapter: adapter() }]);
  assert.throws(() => registry.adapter("anthropic"), /unknown backend/i);
});

test("registry accepts only the exact preview managed-agent Codex contract", () => {
  const codex: BackendDescriptor = {
    ...openRouterDescriptor,
    id: "codex",
    displayName: "Codex",
    maturity: "preview",
    kind: "managed-agent",
    credentialOwner: "provider-runtime",
    billingRealmKind: "provider-managed",
  };

  assert.equal(
    new BackendRegistry([{ descriptor: codex, adapter: adapter("codex") }]).adapter("codex").backendId,
    "codex",
  );
  for (const descriptor of [
    { ...codex, maturity: "stable" as const },
    { ...codex, kind: "raw-model" as const },
    { ...codex, credentialOwner: "orcode-keychain" as const },
    { ...codex, billingRealmKind: "api-payg" as const },
  ]) {
    assert.throws(
      () => new BackendRegistry([{ descriptor, adapter: adapter("codex") }]),
      /codex/i,
    );
  }
});

test("Slice 1 rejects a runnable non-coming-soon Anthropic registration", () => {
  const anthropic: BackendDescriptor = {
    ...openRouterDescriptor,
    id: "anthropic",
    displayName: "Anthropic / Claude subscription",
    maturity: "preview",
    kind: "managed-agent",
    credentialOwner: "provider-runtime",
    billingRealmKind: "provider-managed",
  };

  assert.throws(
    () => new BackendRegistry([{ descriptor: anthropic, adapter: adapter("anthropic") }]),
    /coming-soon/i,
  );
});

test("provider setup required errors expose the stable non-interactive contract", () => {
  const error = new ProviderSetupRequiredError();
  assert.equal(error.name, "ProviderSetupRequiredError");
  assert.equal(error.code, "provider-setup-required");
  assert.equal(error.exitCode, 1);
});
