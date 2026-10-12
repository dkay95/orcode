import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptDurablyCommittedProviderState,
  createNeverConfiguredProviderState,
  credentialBindingForConnection,
  migrateLegacyOpenRouterState,
  migrateProviderSetupV1ToV2,
  migrateProviderSetupStateV2ToV3,
  projectLegacyModelRoutes,
  ProviderStateStore,
  readProviderStateCommitAdoption,
  requireKeychainCredentialPointer,
  type ProviderConnectionStateV1,
  type ProviderConnectionStateV3,
  type ProviderSetupStateV2,
  type ProviderSetupStateV3,
  type ProviderSetupStateV1,
  type ProviderStateCommitRequest,
  validateProviderSetupState,
} from "../src/provider-state.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";

function legacyConnectionFixture(): ProviderConnectionStateV1 {
  return {
    id: "legacy-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialSlot: "legacy:inference",
    accountFingerprint: "acct_legacy_legacy-connection",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
}

function currentConnectionFixture(
  overrides: Partial<ProviderConnectionStateV3> = {},
): ProviderConnectionStateV3 {
  return {
    id: "current-connection",
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain", pointer: "legacy:inference" },
    accountFingerprint: "acct_legacy_current-connection",
    accountFingerprintState: "provisional",
    billingRealm: "openrouter-payg",
    lastHealth: null,
    ...overrides,
  };
}

function legacyConfigFixture() {
  return {
    mainModel: "vendor/main",
    fallbackModels: ["vendor/a/b"],
    compressorModel: "vendor/compressor",
    transcriptionModel: "vendor/audio",
    panelModels: ["vendor/judge"],
    reasoningByModel: {
      "vendor/a/b": { mode: "effort", effort: "high" as const },
    },
  };
}

test("a missing nested state in an existing config migrates OpenRouter without network or key reads", () => {
  const result = migrateLegacyOpenRouterState({
    mainModel: "openai/gpt-main",
    fallbackModels: ["anthropic/claude-fallback"],
    compressorModel: "qwen/compressor",
    transcriptionModel: "mistral/voice",
    panelModels: ["google/judge"],
    reasoningByModel: { "openai/gpt-main": { mode: "effort", effort: "high" } },
  }, { connectionId: "legacy-csprng-id" });

  assert.equal(result.lifecycle, "migrated");
  assert.equal(result.connections[0]?.backendId, "openrouter");
  assert.equal(requireKeychainCredentialPointer(result.connections[0]!), "legacy:inference");
  assert.equal(result.connections[0]?.accountFingerprint, "acct_legacy_legacy-csprng-id");
  assert.equal(result.connections[0]?.accountFingerprintState, "provisional");
  assert.equal(result.defaultRoute?.requestedModelId, "openai/gpt-main");
  assert.equal(result.defaultRoute?.canonicalModelId, null);
  assert.equal(result.defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(result.cross.enabled, false);
});

test("schema-1 provider setup migrates byte-stably to V2 without adding Kimi", () => {
  const v1 = {
    schemaVersion: 1,
    revision: 7,
    lifecycle: "configured",
    connections: [{
      id: "openrouter-verified",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
      accountFingerprint: "acct_openrouter_verified",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct_openrouter_verified",
      billingRealm: "openrouter-payg",
      requestedModelId: "openai/gpt-5",
      canonicalModelId: "openai/gpt-5",
      resolutionState: "resolved",
    },
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("migration must not fetch"); }) as typeof fetch;
  try {
    const first = migrateProviderSetupV1ToV2(v1);
    const second = migrateProviderSetupV1ToV2(first);
    assert.equal(first.schemaVersion, 2);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(first.connections.some((connection) => connection.backendId === "kimi-code"), false);
    assert.equal(first.connections[0]?.credentialSlot, v1.connections[0]?.credentialSlot);
    assert.deepEqual(first.defaultRoute, v1.defaultRoute);
    assert.deepEqual(first.cross, v1.cross);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("schema-1 input cannot satisfy the V3 runtime type boundary", () => {
  const legacy: ProviderSetupStateV1 = {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "never-configured",
    connections: [],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  // @ts-expect-error schema 1 must remain a distinct migration-only input.
  const current: ProviderSetupStateV3 = legacy;
  void current;
});

test("V2 Kimi and OpenRouter connections migrate only their own slots and realms", () => {
  const kimiRoute = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_local_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  } as const;
  const base: ProviderSetupStateV2 = {
    schemaVersion: 2,
    revision: 1,
    lifecycle: "configured",
    connections: [{
      id: "kimi-connection",
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialSlot: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
      accountFingerprint: "acct_local_kimi",
      accountFingerprintState: "verified",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      lastHealth: null,
    }],
    defaultRoute: kimiRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const migrated = migrateProviderSetupStateV2ToV3(base);
  assert.deepEqual(validateProviderSetupState(base), migrated);
  assert.deepEqual(
    credentialBindingForConnection(migrated.connections[0]!),
    { kind: "orcode-keychain", pointer: base.connections[0]!.credentialSlot },
  );
  assert.deepEqual(validateProviderSetupState({
    ...base,
    connections: [{ ...base.connections[0]!, credentialSlot: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" }],
  }), { kind: "corrupt" });
  assert.deepEqual(validateProviderSetupState({
    ...base,
    connections: [{ ...base.connections[0]!, billingRealm: "openrouter-payg" }],
  }), { kind: "corrupt" });
  assert.deepEqual(validateProviderSetupState({
    ...base,
    connections: [{ ...base.connections[0]!, backendId: "openrouter" }],
  }), { kind: "corrupt" });
});

test("legacy model projection preserves every role without slash parsing", () => {
  const projected = projectLegacyModelRoutes(legacyConfigFixture(), legacyConnectionFixture());
  assert.equal(projected.default?.requestedModelId, "vendor/main");
  assert.deepEqual(projected.fallbacks.map((route) => route.requestedModelId), ["vendor/a/b"]);
  assert.equal(projected.compressor?.requestedModelId, "vendor/compressor");
  assert.equal(projected.transcription?.requestedModelId, "vendor/audio");
  assert.deepEqual(projected.panel.map((route) => route.requestedModelId), ["vendor/judge"]);
  assert.equal(projected.reasoning["vendor/a/b"]?.requestedModelId, "vendor/a/b");
});

test("validation accepts the exact current schema and rejects malformed nested members", () => {
  const current = createNeverConfiguredProviderState();
  assert.deepEqual(validateProviderSetupState(current), current);
  assert.deepEqual(
    validateProviderSetupState({
      ...current,
      connections: [{ ...currentConnectionFixture(), backendId: "unknown" }],
    }),
    { kind: "corrupt" },
  );
  assert.deepEqual(
    validateProviderSetupState({ ...current, defaultRoute: { requestedModelId: "missing tuple" } }),
    { kind: "corrupt" },
  );
});

test("provider state rejects Anthropic connections while the backend is coming-soon in Slice 1", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...currentConnectionFixture(),
    backendId: "anthropic",
  }];

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("Cross preferences persist only resolved routes and keep execution disabled", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...currentConnectionFixture(),
    credentialBinding: {
      kind: "orcode-keychain",
      pointer: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    },
    accountFingerprint: "acct_verified_openrouter",
    accountFingerprintState: "verified",
  }];
  state.cross.preferredLead = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_verified_openrouter",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/lead",
    canonicalModelId: "vendor/lead",
    resolutionState: "resolved",
  };

  assert.deepEqual(validateProviderSetupState(state), state);
  assert.equal(state.cross.enabled, false);

  const unresolved = structuredClone(state);
  unresolved.cross.preferredLead = {
    ...unresolved.cross.preferredLead!,
    canonicalModelId: null,
    resolutionState: "legacy-unverified",
  };
  assert.deepEqual(validateProviderSetupState(unresolved), { kind: "corrupt" });
});

test("Cross preferences reject the same exact canonical route", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...currentConnectionFixture(),
    credentialBinding: {
      kind: "orcode-keychain",
      pointer: "v1:inference:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    },
    accountFingerprint: "acct_verified_openrouter",
    accountFingerprintState: "verified",
  }];
  state.cross.preferredLead = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_verified_openrouter",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/lead",
    canonicalModelId: "vendor/lead",
    resolutionState: "resolved",
  };
  state.cross.preferredChallenger = {
    ...state.cross.preferredLead,
    requestedModelId: "provider-alias/lead",
  };

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provider state rejects backend-specific maturity mismatches", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...currentConnectionFixture(),
    maturity: "preview",
    credentialBinding: { kind: "orcode-keychain", pointer: "openrouter:verified" },
    accountFingerprint: "acct_verified_openrouter",
    accountFingerprintState: "verified",
  }];

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provider state rejects backend-specific billing realm mismatches", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...currentConnectionFixture(),
    credentialBinding: { kind: "orcode-keychain", pointer: "openrouter:verified" },
    accountFingerprint: "acct_verified_openrouter",
    accountFingerprintState: "verified",
    billingRealm: "none",
  }];

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provisional fingerprints are valid only for the exact migrated OpenRouter legacy slot", () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/main" },
    { connectionId: "legacy-exact-id" },
  );
  state.connections[0]!.credentialBinding = {
    kind: "orcode-keychain",
    pointer: "openrouter:v1-candidate",
  };

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provider routes must match one persisted connection identity tuple", () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/main" },
    { connectionId: "legacy-route-id" },
  );
  state.defaultRoute = {
    ...state.defaultRoute!,
    accountFingerprint: "acct_unmatched",
  };

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("resolved routes cannot be backed by a provisional account identity", () => {
  const state = migrateLegacyOpenRouterState(
    { mainModel: "vendor/main" },
    { connectionId: "legacy-provisional-id" },
  );
  state.defaultRoute = {
    ...state.defaultRoute!,
    canonicalModelId: "vendor/main",
    resolutionState: "resolved",
  };

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("future and corrupt provider state remain distinct and cannot be saved over", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-provider-state-refusal-"));
  const path = join(root, "config.json");
  const future = validateProviderSetupState({ schemaVersion: 99 });
  const corrupt = validateProviderSetupState({ schemaVersion: 2, connections: "wrong" });
  assert.deepEqual(future, { kind: "future-version", version: 99 });
  assert.deepEqual(corrupt, { kind: "corrupt" });
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: future }, path), /future-version/);
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: corrupt }, path), /corrupt/);

  const raw = `${JSON.stringify({ ...DEFAULT_CONFIG, providerSetup: { schemaVersion: 99, opaque: "keep-exactly" } })}\n`;
  await writeFile(path, raw);
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, budget: { dailyLimitUsd: 2, totalLimitUsd: null, onExceed: "warn" } }, path), /future-version/);
  assert.equal(await readFile(path, "utf8"), raw);
});

test("provider state revisions reject unsafe integers and cannot overflow", () => {
  const unsafe = createNeverConfiguredProviderState();
  unsafe.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(validateProviderSetupState(unsafe), { kind: "corrupt" });

  const maximal = createNeverConfiguredProviderState();
  maximal.revision = Number.MAX_SAFE_INTEGER;
  const store = new ProviderStateStore(maximal);
  assert.throws(
    () => store.replace({ ...maximal, lifecycle: "cancelled" }, maximal.revision),
    /revision|overflow|safe/i,
  );
  assert.deepEqual(store.read(), maximal);
});

test("provider state replace accepts one already-incremented candidate under explicit CAS", () => {
  const initial = createNeverConfiguredProviderState();
  const store = new ProviderStateStore(initial);
  const candidate = {
    ...initial,
    revision: initial.revision + 1,
    lifecycle: "cancelled" as const,
  };

  const committed = store.replace(candidate, initial.revision);

  assert.deepEqual(committed, candidate);
  assert.deepEqual(store.read(), candidate);
});

test("provider state commit delegates one exact captured-revision CAS with a generation fence", async () => {
  const initial = createNeverConfiguredProviderState();
  const observed: Array<{ expectedRevision: number; nextRevision: number }> = [];
  let fenceChecks = 0;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const next = request.build(initial);
      observed.push({
        expectedRevision: request.expectedRevision,
        nextRevision: next.revision,
      });
      request.adopt(next);
      return structuredClone(next);
    },
  });

  const committed = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
    () => {
      fenceChecks += 1;
    },
  );

  assert.deepEqual(observed, [{ expectedRevision: 0, nextRevision: 1 }]);
  assert.equal(fenceChecks, 2);
  assert.equal(committed.revision, 1);
  assert.equal(committed.lifecycle, "cancelled");
  assert.deepEqual(store.read(), committed);
});

test("durable provider state commit rejects adopt before its authoritative build", async () => {
  const initial = createNeverConfiguredProviderState();
  const forged = { ...initial, revision: 1 };
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      try {
        request.adopt(forged);
      } catch {
        // A suppressed out-of-order adopt must poison the entire scoped protocol.
      }
      const built = request.build(initial);
      request.adopt(built);
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit adopts only the byte-exact built candidate", async () => {
  const initial = createNeverConfiguredProviderState();
  let builderCalls = 0;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      const forged = { ...built, lifecycle: "never-configured" as const };
      try {
        request.adopt(forged);
      } catch {
        // A suppressed non-authoritative adopt must not permit a later retry.
      }
      request.adopt(built);
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => {
      builderCalls += 1;
      return { ...current, lifecycle: "cancelled" };
    },
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.equal(builderCalls, 1);
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit rejects a suppressed duplicate build before adoption", async () => {
  const initial = createNeverConfiguredProviderState();
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      try {
        request.build(initial);
      } catch {
        // The durable boundary must remain invalid even if its caller suppresses this error.
      }
      request.adopt(built);
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit rejects a suppressed build after adoption", async () => {
  const initial = createNeverConfiguredProviderState();
  let builderCalls = 0;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      request.adopt(built);
      try {
        request.build(initial);
      } catch {
        // A post-adoption build attempt must poison settlement even when suppressed.
      }
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => {
      builderCalls += 1;
      return { ...current, lifecycle: "cancelled" };
    },
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.equal(builderCalls, 1);
});

test("durable provider state commit rejects a suppressed duplicate adoption", async () => {
  const initial = createNeverConfiguredProviderState();
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      request.adopt(built);
      try {
        request.adopt(built);
      } catch {
        // A duplicate adoption attempt must poison settlement even when suppressed.
      }
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
});

test("durable provider state commit rejects a suppressed wrong-revision adoption", async () => {
  const initial = createNeverConfiguredProviderState();
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      const wrongRevision = { ...built, revision: built.revision + 1 };
      try {
        request.adopt(wrongRevision);
      } catch {
        // A wrong-revision adoption must poison a later otherwise-valid adoption.
      }
      request.adopt(built);
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit rejects a suppressed pre-build fence failure", async () => {
  const initial = createNeverConfiguredProviderState();
  let generationCurrent = false;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      try {
        request.assertCurrent();
      } catch {
        // Every failed open capability invocation must poison final settlement.
      }
      generationCurrent = true;
      const built = request.build(initial);
      request.adopt(built);
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
    () => {
      if (!generationCurrent) throw new Error("provider generation is stale");
    },
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit rejects a suppressed post-adoption fence failure without state change", async () => {
  const initial = createNeverConfiguredProviderState();
  let generationCurrent = true;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      request.adopt(built);
      generationCurrent = false;
      try {
        request.assertCurrent();
      } catch {
        // A stale post-adoption fence must poison settlement even when suppressed.
      }
      return structuredClone(built);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
    () => {
      if (!generationCurrent) throw new Error("provider generation is stale");
    },
  ).then(() => "resolved", () => "rejected");

  assert.equal(outcome, "rejected");
  assert.deepEqual(store.read(), initial);
});

test("durable provider state commit reports the exact adopted tuple after a later persistence rejection", async () => {
  const initial = createNeverConfiguredProviderState();
  let durable = structuredClone(initial);
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(durable);
      durable = structuredClone(built);
      request.adopt(built);
      throw new Error("fixed post-adoption ownership release failure");
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(
    (state) => ({ kind: "resolved" as const, state }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.name : null,
        "ProviderStateCommitAdoptedError",
      );
      const committed = readProviderStateCommitAdoption(error);
      assert.ok(committed);
      return {
        kind: "committed" as const,
        state: committed,
      };
    },
  );

  assert.equal(outcome.kind, "committed");
  assert.deepEqual(outcome.state, durable);
  assert.deepEqual(store.read(), durable);
  outcome.state.lifecycle = "never-configured";
  assert.deepEqual(store.read(), durable);
});

test("durable provider state commit reports exact adoption after a resolved wrong readback", async () => {
  const initial = createNeverConfiguredProviderState();
  let durable = structuredClone(initial);
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(durable);
      durable = structuredClone(built);
      request.adopt(built);
      return structuredClone(initial);
    },
  });

  const outcome = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).then(
    (state) => ({ kind: "resolved" as const, state }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.name : null,
        "ProviderStateCommitAdoptedError",
      );
      const committed = readProviderStateCommitAdoption(error);
      assert.ok(committed);
      return {
        kind: "committed" as const,
        state: committed,
      };
    },
  );

  assert.equal(outcome.kind, "committed");
  assert.deepEqual(outcome.state, durable);
  assert.deepEqual(store.read(), durable);
});

test("committed provider state readback rejects a structurally forged outcome", async () => {
  const providerState = await import("../src/provider-state.js") as unknown as {
    readProviderStateCommitAdoption?: (error: unknown) => ProviderSetupStateV3 | null;
  };
  const forged = Object.assign(new Error("fixed forged committed outcome"), {
    name: "ProviderStateCommitAdoptedError",
    readCommitted: () => ({
      ...createNeverConfiguredProviderState(),
      revision: 1,
      lifecycle: "configured" as const,
    }),
  });

  assert.equal(typeof providerState.readProviderStateCommitAdoption, "function");
  assert.equal(providerState.readProviderStateCommitAdoption!(forged), null);
});

test("durable provider state commit reconciles an exact publication after a later fence loss", async () => {
  const initial = createNeverConfiguredProviderState();
  let generationCurrent = true;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const built = request.build(initial);
      request.assertCurrent();
      generationCurrent = false;
      adoptDurablyCommittedProviderState(request, built);
      request.assertCurrent();
      return structuredClone(built);
    },
  });

  const committed = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
    () => {
      if (!generationCurrent) throw new Error("provider generation is stale");
    },
  ).catch((error: unknown) => {
    const adopted = readProviderStateCommitAdoption(error);
    assert.ok(adopted);
    return adopted;
  });

  assert.equal(committed.revision, 1);
  assert.equal(committed.lifecycle, "cancelled");
  assert.deepEqual(store.read(), committed);
});

test("committed provider outcome rejects a prototype-shaped object with an own readCommitted override", async () => {
  const initial = createNeverConfiguredProviderState();
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      const candidate = request.build(initial);
      adoptDurablyCommittedProviderState(request, candidate);
      throw new Error("fixed post-publication persistence failure");
    },
  });
  let genuine: unknown;
  await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  ).catch((error: unknown) => {
    genuine = error;
  });
  assert.ok(genuine);
  assert.ok(readProviderStateCommitAdoption(genuine));

  const forged = Object.create(Object.getPrototypeOf(genuine)) as Record<string, unknown>;
  Object.defineProperty(forged, "readCommitted", {
    configurable: true,
    enumerable: true,
    value: () => ({
      ...createNeverConfiguredProviderState(),
      revision: 1,
      lifecycle: "configured" as const,
    }),
  });

  assert.equal(readProviderStateCommitAdoption(forged), null);
});

test("durable provider state capabilities are closed after successful settlement", async () => {
  const initial = createNeverConfiguredProviderState();
  let retained!: ProviderStateCommitRequest;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      retained = request;
      const built = request.build(initial);
      request.adopt(built);
      return structuredClone(built);
    },
  });
  const committed = await store.commit(
    initial.revision,
    (current) => ({ ...current, lifecycle: "cancelled" }),
  );
  const beforeLateCalls = store.read();

  assert.throws(() => retained.assertCurrent(), /closed|settled|capability/i);
  assert.throws(() => retained.build(initial), /closed|settled|capability/i);
  assert.throws(() => retained.adopt(committed), /closed|settled|capability/i);
  assert.throws(
    () => adoptDurablyCommittedProviderState(retained, committed),
    /closed|settled|capability/i,
  );
  assert.deepEqual(store.read(), beforeLateCalls);
});

test("durable provider state capabilities are closed after failed settlement", async () => {
  const initial = createNeverConfiguredProviderState();
  let retained!: ProviderStateCommitRequest;
  const store = new ProviderStateStore(initial, {
    persist: async (request) => {
      retained = request;
      throw new Error("durable persistence failed");
    },
  });
  await assert.rejects(
    store.commit(
      initial.revision,
      (current) => ({ ...current, lifecycle: "cancelled" }),
    ),
    /durable persistence failed/,
  );
  const forged = { ...initial, revision: 1, lifecycle: "cancelled" as const };
  const lateOutcomes: string[] = [];
  for (const callback of [
    () => retained.assertCurrent(),
    () => retained.build(initial),
    () => retained.adopt(forged),
    () => adoptDurablyCommittedProviderState(retained, forged),
  ]) {
    try {
      callback();
      lateOutcomes.push("resolved");
    } catch {
      lateOutcomes.push("rejected");
    }
  }

  assert.deepEqual(lateOutcomes, ["rejected", "rejected", "rejected", "rejected"]);
  assert.deepEqual(store.read(), initial);
});
