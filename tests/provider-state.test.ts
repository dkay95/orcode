import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNeverConfiguredProviderState,
  migrateLegacyOpenRouterState,
  projectLegacyModelRoutes,
  ProviderStateStore,
  type ProviderConnectionStateV1,
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
  assert.equal(result.connections[0]?.credentialSlot, "legacy:inference");
  assert.equal(result.connections[0]?.accountFingerprint, "acct_legacy_legacy-csprng-id");
  assert.equal(result.connections[0]?.accountFingerprintState, "provisional");
  assert.equal(result.defaultRoute?.requestedModelId, "openai/gpt-main");
  assert.equal(result.defaultRoute?.canonicalModelId, null);
  assert.equal(result.defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(result.cross.enabled, false);
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
    validateProviderSetupState({ ...current, connections: [{ ...legacyConnectionFixture(), backendId: "unknown" }] }),
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
    ...legacyConnectionFixture(),
    backendId: "anthropic",
  }];

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provider state rejects backend-specific maturity mismatches", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...legacyConnectionFixture(),
    maturity: "preview",
    credentialSlot: "openrouter:verified",
    accountFingerprint: "acct_verified_openrouter",
    accountFingerprintState: "verified",
  }];

  assert.deepEqual(validateProviderSetupState(state), { kind: "corrupt" });
});

test("provider state rejects backend-specific billing realm mismatches", () => {
  const state = createNeverConfiguredProviderState();
  state.lifecycle = "configured";
  state.connections = [{
    ...legacyConnectionFixture(),
    credentialSlot: "openrouter:verified",
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
  state.connections[0]!.credentialSlot = "openrouter:v1-candidate";

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
  const corrupt = validateProviderSetupState({ schemaVersion: 1, connections: "wrong" });
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
  ]) {
    try {
      callback();
      lateOutcomes.push("resolved");
    } catch {
      lateOutcomes.push("rejected");
    }
  }

  assert.deepEqual(lateOutcomes, ["rejected", "rejected", "rejected"]);
  assert.deepEqual(store.read(), initial);
});
