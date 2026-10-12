import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RouteIdentityV1 } from "../src/backends.js";
import {
  DEFAULT_CONFIG,
  readConfigFileSnapshot,
  readConfigEditSnapshot,
  sameConfigFileSnapshot,
  saveConfig,
  type OrcodeConfigWithBudget,
} from "../src/config.js";
import {
  createModelPreferenceRouteAuthorityBridge,
  ModelPreferenceCrashError,
  ModelPreferencePayloadTooLargeError,
  ModelPreferenceRecoveryRequiredError,
  recoverModelPreferenceTransactions,
  runModelPreferenceTransaction,
  sameExactModelPreferenceRoute,
  type ModelPreferenceAuthorityPublication,
  type ModelPreferenceAuthoritySnapshot,
  type ModelPreferenceFailpoint,
  type ModelPreferenceTransactionV1,
} from "../src/model-preference-transaction.js";
import {
  PRIVATE_STORE_CLAIM_PAYLOAD_NAMES,
  PrivateStore,
} from "../src/private-store.js";
import type {
  ProviderConnectionStateV3,
  ProviderSetupStateV3,
} from "../src/provider-state.js";
import type {
  ProviderPreferenceCleanupAuthority,
  ProviderPreferenceMutationAuthority,
} from "../src/provider-activation.js";
import {
  prepareSessionPreferenceEdit,
  readSessionEditSnapshot,
  SessionStore,
} from "../src/session.js";

interface PreferenceFixture {
  readonly root: string;
  readonly appHome: string;
  readonly configPath: string;
  readonly sessionPath: string;
  readonly beforeConfigBytes: string;
  readonly beforeSessionBytes: string;
  readonly beforeRoute: RouteIdentityV1;
  readonly afterRoute: RouteIdentityV1;
  readonly beforeConnectionId: string;
  readonly afterConnectionId: string;
  authority: ModelPreferenceAuthoritySnapshot;
  publishCount: number;
  commitCount: number;
  run(failpoint?: ModelPreferenceFailpoint): Promise<RouteIdentityV1>;
  recover(): Promise<unknown>;
}

function testMutationAuthority(options: {
  revokeAtMutationCheck?: number;
  failCompletionAcknowledgement?: boolean;
} = {}) {
  const controller = new AbortController();
  let phase:
    | "active"
    | "revoked"
    | "reconciling"
    | "provider-durable"
    | "completing"
    | "cleaning"
    | "completed" = "active";
  let mutationChecks = 0;
  let completionAcknowledged = false;
  let cleanupAcknowledged = false;
  const authority = Object.freeze<ProviderPreferenceMutationAuthority>({
    signal: controller.signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    assertMutationAllowed() {
      mutationChecks += 1;
      if (phase === "active" && mutationChecks === options.revokeAtMutationCheck) {
        phase = "revoked";
        controller.abort(new Error(
          `fixed preference revoke at mutation check ${mutationChecks}`,
        ));
      }
      if (phase !== "active" || controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("test preference authority revoked");
      }
    },
    async assertMutationAuthorityHeld() {
      this.assertMutationAllowed();
    },
    assertReconcileAllowed() {
      if (phase !== "reconciling") {
        throw new Error("test preference reconcile authority lost");
      }
    },
    async assertReconcileAuthorityHeld() {
      this.assertReconcileAllowed();
    },
    assertCompletionAllowed() {
      if (phase !== "completing") {
        throw new Error("test preference completion authority lost");
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
      if (options.failCompletionAcknowledgement) {
        throw new Error("fixed completion acknowledgement authority loss");
      }
      if (completionAcknowledged) {
        throw new Error("test preference completion replayed");
      }
      completionAcknowledged = true;
      return Object.freeze({ version: 1 as const });
    },
  });
  const cleanupAuthority = Object.freeze<ProviderPreferenceCleanupAuthority>({
    signal: new AbortController().signal,
    assertCleanupAllowed() {
      if (phase !== "cleaning" || cleanupAcknowledged) {
        throw new Error("test preference cleanup authority lost");
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
    beginReconcile(reason: unknown) {
      if (phase !== "active" && phase !== "revoked") {
        throw new Error("test preference authority is not active");
      }
      phase = "reconciling";
      if (!controller.signal.aborted) controller.abort(reason);
    },
    beginCompletion() {
      if (phase !== "active") throw new Error("test preference authority is not active");
      phase = "provider-durable";
      phase = "completing";
    },
    finishCompletion() {
      if (phase !== "completing" || !completionAcknowledged) {
        throw new Error("test preference completion is not acknowledged");
      }
      phase = "cleaning";
    },
    finishCleanup() {
      if (phase !== "cleaning" || !cleanupAcknowledged) {
        throw new Error("test preference cleanup is not acknowledged");
      }
      phase = "completed";
    },
  };
}

async function preferenceFixture(options: {
  direction?: "openrouter-to-kimi" | "kimi-to-openrouter";
  routeConflict?: boolean;
  hugeSession?: boolean;
  failAfterPreferences?: boolean;
  assertRollbackBeforeAuthorityRelease?: boolean;
  mismatchedFinalModel?: boolean;
  invalidUtf8Config?: boolean;
  publishThrows?: boolean;
  controlConnectionId?: boolean;
  revokeAtMutationCheck?: number;
  failCompletionAcknowledgement?: boolean;
} = {}): Promise<PreferenceFixture> {
  const root = await mkdtemp(join(tmpdir(), "orcode-model-preference-unit-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, ".orcode");
  const configPath = join(appHome, "config.json");
  await mkdir(workspace, { recursive: true });
  const connectionId = options.controlConnectionId
    ? "model-preference\nowner"
    : "model-preference-owner";
  const openRouterBeforeRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_model_preference_unit_owner",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/old-model",
    canonicalModelId: "openai/old-model",
    resolutionState: "resolved",
  };
  const openRouterAfterRoute: RouteIdentityV1 = {
    ...openRouterBeforeRoute,
    requestedModelId: "openai/new-model",
    canonicalModelId: "openai/new-model",
  };
  const kimiRoute: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_kimi_model_preference_unit_owner",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  };
  const beforeRoute = options.direction === "kimi-to-openrouter"
    ? kimiRoute
    : openRouterBeforeRoute;
  const selectedAfterRoute = options.direction === "openrouter-to-kimi"
    ? kimiRoute
    : openRouterAfterRoute;
  const afterRoute = options.routeConflict
    ? { ...selectedAfterRoute, accountFingerprint: "acct_stale_route_selection" }
    : selectedAfterRoute;
  const openRouterConnectionId = options.direction ? "model-preference-openrouter" : connectionId;
  const kimiConnectionId = "model-preference-kimi";
  const openRouterConnection: ProviderConnectionStateV3 = {
    id: openRouterConnectionId,
    backendId: "openrouter",
    enabled: true,
    maturity: "stable",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:73737373-7373-4373-8373-737373737373" },
    accountFingerprint: openRouterBeforeRoute.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "openrouter-payg",
    lastHealth: null,
  };
  const kimiConnection: ProviderConnectionStateV3 = {
    id: kimiConnectionId,
    backendId: "kimi-code",
    enabled: true,
    maturity: "preview",
    credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:74747474-7474-4474-8474-747474747474" },
    accountFingerprint: kimiRoute.accountFingerprint,
    accountFingerprintState: "verified",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    lastHealth: null,
  };
  const connections = options.direction
    ? [openRouterConnection, kimiConnection]
    : [openRouterConnection];
  const beforeConnectionId = beforeRoute.backendId === "kimi-code"
    ? kimiConnectionId
    : openRouterConnectionId;
  const afterConnectionId = afterRoute.backendId === "kimi-code"
    ? kimiConnectionId
    : openRouterConnectionId;
  const beforeConfig = structuredClone(DEFAULT_CONFIG);
  beforeConfig.mainModel = beforeRoute.requestedModelId;
  if (options.invalidUtf8Config) {
    beforeConfig.browserPath = "invalid-utf8-browser-marker";
  }
  beforeConfig.providerSetup = {
    schemaVersion: 3,
    revision: 4,
    lifecycle: "configured",
    connections,
    defaultRoute: beforeRoute,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  await saveConfig(beforeConfig, configPath);
  if (options.invalidUtf8Config) {
    const bytes = await readFile(configPath);
    const marker = Buffer.from("invalid-utf8-browser-marker", "utf8");
    const offset = bytes.indexOf(marker);
    assert.notEqual(offset, -1);
    bytes[offset] = 0x80;
    await writeFile(configPath, bytes);
  }
  const session = SessionStore.create(workspace, appHome, "Preference fixture");
  session.setPreferences(beforeRoute.requestedModelId, { mode: "auto" }, beforeRoute);
  if (options.hugeSession) session.addTurn("user", "x".repeat(16 * 1_024 * 1_024));
  await session.save();
  const expectedConfig = await readConfigEditSnapshot(configPath);
  const expectedSession = await readSessionEditSnapshot(session.path);
  const nextConfig = structuredClone(expectedConfig.config);
  nextConfig.mainModel = options.mismatchedFinalModel
    ? beforeRoute.requestedModelId
    : afterRoute.requestedModelId;
  nextConfig.providerSetup = {
    ...structuredClone(nextConfig.providerSetup),
    revision: 5,
    defaultRoute: afterRoute,
  } as ProviderSetupStateV3;
  const nextSession = prepareSessionPreferenceEdit(expectedSession, {
    requestedModelId: afterRoute.requestedModelId,
    reasoning: { mode: "auto" },
    route: afterRoute,
  });
  const beforeConfigBytes = await readFile(configPath, "utf8");
  const beforeSessionBytes = await readFile(session.path, "utf8");
  const fixture: PreferenceFixture = {
    root,
    appHome,
    configPath,
    sessionPath: session.path,
    beforeConfigBytes,
    beforeSessionBytes,
    beforeRoute,
    afterRoute,
    beforeConnectionId,
    afterConnectionId,
    authority: {
      route: structuredClone(beforeRoute),
      providerRevision: 4,
      connectionId: beforeConnectionId,
    },
    publishCount: 0,
    commitCount: 0,
    async run(failpoint) {
      return runModelPreferenceTransaction({
        appHome,
        configPath,
        sessionPath: session.path,
        expectedConfig,
        nextConfig,
        expectedSession,
        nextSession,
        beforeRoute,
        afterRoute,
        routeAuthority: {
          read: async () => structuredClone(fixture.authority),
          commit: async (
            route,
            publication: ModelPreferenceAuthorityPublication,
          ) => {
            fixture.commitCount += 1;
            const scope = testMutationAuthority({
              ...(options.revokeAtMutationCheck === undefined
                ? {}
                : { revokeAtMutationCheck: options.revokeAtMutationCheck }),
              ...(options.failCompletionAcknowledgement
                ? { failCompletionAcknowledgement: true }
                : {}),
            });
            let reconciledOld = false;
            let providerDurable = false;
            try {
              const { configFence } = await publication.persist(
                nextConfig.providerSetup as ProviderSetupStateV3,
                scope.authority,
              );
              assert.ok(sameConfigFileSnapshot(
                await readConfigFileSnapshot(configPath),
                configFence,
              ));
              if (configFence.kind !== "file") assert.fail("provider config fence must be a file");
              if (options.failAfterPreferences) {
                throw new Error("fixed-preference-publication-failure");
              }
              await writeFile(
                configPath,
                providerCommittedConfigRaw(
                  configFence.raw,
                  nextConfig.providerSetup as ProviderSetupStateV3,
                ),
                "utf8",
              );
              fixture.authority = {
                route: structuredClone(route),
                providerRevision: 5,
                connectionId: afterConnectionId,
              };
              providerDurable = true;
              scope.beginCompletion();
              const acknowledgement = await publication.complete(scope.authority);
              assert.equal(acknowledgement.version, 1);
              scope.finishCompletion();
              const cleanupAcknowledgement = await publication.cleanup(
                scope.cleanupAuthority,
              );
              assert.equal(cleanupAcknowledgement.version, 1);
              scope.finishCleanup();
            } catch (error) {
              if (error instanceof ModelPreferenceCrashError) throw error;
              if (providerDurable) throw new ModelPreferenceRecoveryRequiredError();
              scope.beginReconcile(error);
              const settlement = await publication.abortAndReconcile(scope.authority);
              if (settlement.kind !== "old") {
                throw new ModelPreferenceRecoveryRequiredError();
              }
              reconciledOld = true;
              throw error;
            } finally {
              if (options.assertRollbackBeforeAuthorityRelease && reconciledOld) {
                assert.equal(await readFile(configPath, "utf8"), beforeConfigBytes);
                assert.equal(await readFile(session.path, "utf8"), beforeSessionBytes);
              }
            }
          },
        },
        publish: () => {
          fixture.publishCount += 1;
          if (options.publishThrows) {
            throw new Error("fixed-live-publication-failure");
          }
        },
        ...(failpoint ? { failpoint } : {}),
      });
    },
    recover: () => recoverModelPreferenceTransactions({
      appHome,
      routeAuthority: {
        assertHeld: async () => undefined,
        read: async () => structuredClone(fixture.authority),
      },
    }),
  };
  return fixture;
}

async function readPreferenceManifest(
  fixture: PreferenceFixture,
): Promise<ModelPreferenceTransactionV1> {
  const transactionRoot = join(fixture.appHome, "transactions", "model-preference");
  const entries = await readdir(transactionRoot);
  assert.equal(entries.length, 1, "one exact preference journal must exist");
  return JSON.parse(
    await readFile(join(transactionRoot, entries[0]!, "manifest.json"), "utf8"),
  ) as ModelPreferenceTransactionV1;
}

function exactProviderState(config: OrcodeConfigWithBudget): ProviderSetupStateV3 {
  const state = config.providerSetup;
  if ("kind" in state) assert.fail(`provider state is ${state.kind}`);
  return state;
}

function unreachablePreferencePublication(): ModelPreferenceAuthorityPublication {
  return {
    async persist() {
      throw new Error("bridge test transition must own provider publication");
    },
    async abortAndReconcile() {
      throw new Error("bridge test transition must own provider publication");
    },
    async complete() {
      throw new Error("bridge test transition must own provider publication");
    },
    async cleanup() {
      throw new Error("bridge test transition must own provider publication");
    },
  };
}

function providerCommittedConfigRaw(
  stagingRaw: string,
  nextProviderState: ProviderSetupStateV3,
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

test("exact model-preference route equality compares the complete persisted identity", () => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_exact_route",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/requested",
    canonicalModelId: "openai/canonical",
    resolutionState: "resolved",
  };
  assert.equal(sameExactModelPreferenceRoute(route, structuredClone(route)), true);
  assert.equal(sameExactModelPreferenceRoute(route, { ...route, backendId: "kimi-code" }), false);
  assert.equal(sameExactModelPreferenceRoute(route, {
    ...route,
    accountFingerprint: "acct_other",
  }), false);
  assert.equal(sameExactModelPreferenceRoute(route, {
    ...route,
    billingRealm: "none",
  }), false);
  assert.equal(sameExactModelPreferenceRoute(route, {
    ...route,
    requestedModelId: "openai/other-request",
  }), false);
  assert.equal(sameExactModelPreferenceRoute(route, {
    ...route,
    canonicalModelId: "openai/other-canonical",
  }), false);
  assert.equal(sameExactModelPreferenceRoute(route, {
    ...route,
    resolutionState: "legacy-unverified",
    canonicalModelId: null,
  }), false);
});

test("model-preference authority bridge forwards one exact route and provider surface", async () => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: "acct_bridge_kimi",
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  };
  const snapshot: ModelPreferenceAuthoritySnapshot = {
    route,
    providerRevision: 7,
    connectionId: "bridge-kimi-connection",
  };
  const transitions: Array<{
    route: RouteIdentityV1;
    surface: string | undefined;
    publicationVersion: number;
  }> = [];
  const authority = createModelPreferenceRouteAuthorityBridge({
    read: () => snapshot,
    surface: "fullscreen",
    invalidError: () => new Error("fixed-invalid-bridge"),
    async transition(committedRoute, publication, surface) {
      transitions.push({
        route: structuredClone(committedRoute),
        surface,
        publicationVersion: publication.version,
      });
      return structuredClone(committedRoute);
    },
  });

  const observed = await authority.read();
  assert.deepEqual(observed, snapshot);
  assert.notEqual(observed, snapshot);
  assert.notEqual(observed.route, snapshot.route);
  await authority.commit!(route, unreachablePreferencePublication());
  assert.deepEqual(transitions, [{
    route,
    surface: "fullscreen",
    publicationVersion: 1,
  }]);
  await assert.rejects(
    authority.commit!(route, unreachablePreferencePublication()),
    /fixed-invalid-bridge/,
  );
});

test("model-preference authority bridge rejects a non-exact transition result", async () => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_bridge_openrouter",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/requested",
    canonicalModelId: "openai/canonical",
    resolutionState: "resolved",
  };
  const authority = createModelPreferenceRouteAuthorityBridge({
    read: () => ({ route, providerRevision: 3, connectionId: "bridge-openrouter" }),
    invalidError: () => new Error("fixed-invalid-bridge"),
    async transition() {
      return { ...route, canonicalModelId: "openai/wrong" };
    },
  });

  await assert.rejects(
    authority.commit!(route, unreachablePreferencePublication()),
    /fixed-invalid-bridge/,
  );
});

test("exact cross-provider preference transitions converge config, session, and authority", async (t) => {
  for (const direction of ["openrouter-to-kimi", "kimi-to-openrouter"] as const) {
    await t.test(direction, async () => {
      const fixture = await preferenceFixture({ direction });
      try {
        const result = await fixture.run();
        const config = JSON.parse(
          await readFile(fixture.configPath, "utf8"),
        ) as OrcodeConfigWithBudget;
        const session = JSON.parse(
          await readFile(fixture.sessionPath, "utf8"),
        ) as { model: string; route: RouteIdentityV1 };
        const providerState = exactProviderState(config);

        assert.deepEqual(result, fixture.afterRoute);
        assert.equal(config.mainModel, fixture.afterRoute.requestedModelId);
        assert.equal(providerState.revision, 5, "revision advances by exactly one");
        assert.deepEqual(providerState.defaultRoute, fixture.afterRoute);
        assert.equal(session.model, fixture.afterRoute.requestedModelId);
        assert.deepEqual(session.route, fixture.afterRoute);
        assert.deepEqual(fixture.authority, {
          route: fixture.afterRoute,
          providerRevision: 5,
          connectionId: fixture.afterConnectionId,
        });
        assert.equal(fixture.commitCount, 1);
        assert.equal(fixture.publishCount, 1);
        assert.deepEqual(await readdir(join(
          fixture.appHome,
          "transactions",
          "model-preference",
        )), []);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("cross-provider journal binds both exact routes and both connection owners", async (t) => {
  for (const direction of ["openrouter-to-kimi", "kimi-to-openrouter"] as const) {
    await t.test(direction, async () => {
      const fixture = await preferenceFixture({ direction });
      try {
        await assert.rejects(
          fixture.run("after-preferences-durable"),
          ModelPreferenceCrashError,
        );
        const manifest = await readPreferenceManifest(fixture);
        assert.equal(manifest.before.authority.providerRevision, 4);
        assert.equal(manifest.after.authority.providerRevision, 5);
        assert.equal(manifest.before.authority.connectionId, fixture.beforeConnectionId);
        assert.equal(manifest.after.authority.connectionId, fixture.afterConnectionId);
        assert.notEqual(manifest.before.authority.connectionId, manifest.after.authority.connectionId);
        assert.deepEqual(manifest.before.authority.route, fixture.beforeRoute);
        assert.deepEqual(manifest.after.authority.route, fixture.afterRoute);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("cross-provider persistence failure, route conflict, and cancellation keep OLD unpublished", async (t) => {
  await t.test("provider persistence failure", async () => {
    const fixture = await preferenceFixture({
      direction: "openrouter-to-kimi",
      failAfterPreferences: true,
      assertRollbackBeforeAuthorityRelease: true,
    });
    try {
      await assert.rejects(fixture.run(), /fixed-preference-publication-failure/);
      assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
      assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
      assert.deepEqual(fixture.authority, {
        route: fixture.beforeRoute,
        providerRevision: 4,
        connectionId: fixture.beforeConnectionId,
      });
      assert.equal(fixture.publishCount, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("stale target-route conflict", async () => {
    const fixture = await preferenceFixture({
      direction: "openrouter-to-kimi",
      routeConflict: true,
    });
    try {
      await assert.rejects(fixture.run(), /route identity|candidate/i);
      assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
      assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
      assert.deepEqual(fixture.authority, {
        route: fixture.beforeRoute,
        providerRevision: 4,
        connectionId: fixture.beforeConnectionId,
      });
      assert.equal(fixture.commitCount, 0);
      assert.equal(fixture.publishCount, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("authority cancellation", async () => {
    const fixture = await preferenceFixture({
      direction: "kimi-to-openrouter",
      revokeAtMutationCheck: 10,
      assertRollbackBeforeAuthorityRelease: true,
    });
    try {
      await assert.rejects(fixture.run(), /fixed preference revoke/);
      assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
      assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
      assert.deepEqual(fixture.authority, {
        route: fixture.beforeRoute,
        providerRevision: 4,
        connectionId: fixture.beforeConnectionId,
      });
      assert.equal(fixture.publishCount, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("cross-provider config conflict preserves the foreign bytes and exact OLD authority", async () => {
  const fixture = await preferenceFixture({ direction: "openrouter-to-kimi" });
  try {
    const foreign = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as OrcodeConfigWithBudget;
    foreign.maxSteps = 91;
    await saveConfig(foreign, fixture.configPath);
    const foreignBytes = await readFile(fixture.configPath, "utf8");

    await assert.rejects(fixture.run(), ModelPreferenceRecoveryRequiredError);
    assert.equal(await readFile(fixture.configPath, "utf8"), foreignBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
    assert.deepEqual(fixture.authority, {
      route: fixture.beforeRoute,
      providerRevision: 4,
      connectionId: fixture.beforeConnectionId,
    });
    assert.equal(fixture.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cross-provider recovery converges only from exact OLD or exact FINAL authority", async (t) => {
  await t.test("exact OLD", async () => {
    const fixture = await preferenceFixture({ direction: "openrouter-to-kimi" });
    try {
      await assert.rejects(
        fixture.run("after-preferences-durable"),
        ModelPreferenceCrashError,
      );
      await fixture.recover();
      assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
      assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
      assert.equal(fixture.publishCount, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("exact FINAL", async () => {
    const fixture = await preferenceFixture({ direction: "kimi-to-openrouter" });
    try {
      await assert.rejects(
        fixture.run("after-provider-commit"),
        ModelPreferenceCrashError,
      );
      await fixture.recover();
      const config = JSON.parse(
        await readFile(fixture.configPath, "utf8"),
      ) as OrcodeConfigWithBudget;
      const session = JSON.parse(
        await readFile(fixture.sessionPath, "utf8"),
      ) as { model: string; route: RouteIdentityV1 };
      const providerState = exactProviderState(config);
      assert.equal(config.mainModel, fixture.afterRoute.requestedModelId);
      assert.equal(providerState.revision, 5);
      assert.deepEqual(providerState.defaultRoute, fixture.afterRoute);
      assert.equal(session.model, fixture.afterRoute.requestedModelId);
      assert.deepEqual(session.route, fixture.afterRoute);
      assert.equal(fixture.publishCount, 0, "startup recovery never republishes live state");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("hybrid route, revision, and connection owner", async () => {
    const fixture = await preferenceFixture({ direction: "openrouter-to-kimi" });
    try {
      await assert.rejects(
        fixture.run("after-preferences-durable"),
        ModelPreferenceCrashError,
      );
      const stagingConfig = await readFile(fixture.configPath, "utf8");
      const stagingSession = await readFile(fixture.sessionPath, "utf8");
      fixture.authority = {
        route: structuredClone(fixture.afterRoute),
        providerRevision: 5,
        connectionId: fixture.beforeConnectionId,
      };

      await assert.rejects(fixture.recover(), ModelPreferenceRecoveryRequiredError);
      assert.equal(await readFile(fixture.configPath, "utf8"), stagingConfig);
      assert.equal(await readFile(fixture.sessionPath, "utf8"), stagingSession);
      assert.equal(fixture.publishCount, 0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("handled preference failure restores OLD before provider authority is released", async () => {
  const fixture = await preferenceFixture({
    failAfterPreferences: true,
    assertRollbackBeforeAuthorityRelease: true,
  });
  try {
    await assert.rejects(fixture.run(), /fixed-preference-publication-failure/);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
    assert.equal(fixture.publishCount, 0);
    assert.equal(fixture.authority.route?.requestedModelId, fixture.beforeRoute.requestedModelId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("revocation at every preference mutation boundary reconciles exact OLD before release", async (t) => {
  const boundaries = [
    ["before-journal-create", 5],
    ["after-journal-create", 6],
    ["before-config-cas", 7],
    ["after-config-cas", 8],
    ["after-config-readback", 9],
    ["before-session-write", 10],
    ["after-session-write", 11],
    ["after-session-readback", 12],
    ["before-preferences-durable", 13],
    ["after-preferences-durable", 14],
    ["before-provider-commit", 15],
  ] as const;
  for (const [name, revokeAtMutationCheck] of boundaries) {
    await t.test(name, async () => {
      const fixture = await preferenceFixture({
        revokeAtMutationCheck,
        assertRollbackBeforeAuthorityRelease: true,
      });
      try {
        await assert.rejects(
          fixture.run(),
          new RegExp(`fixed preference revoke at mutation check ${revokeAtMutationCheck}`),
        );
        assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
        assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
        assert.equal(fixture.authority.route?.requestedModelId, fixture.beforeRoute.requestedModelId);
        assert.equal(fixture.publishCount, 0);
        assert.deepEqual(await readdir(join(
          fixture.appHome,
          "transactions",
          "model-preference",
        )).catch(() => [] as string[]), []);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("transaction rejects a FINAL config model that does not own the exact new route", async () => {
  const fixture = await preferenceFixture({ mismatchedFinalModel: true });
  try {
    await assert.rejects(fixture.run(), /config model|route identity|candidate/i);
    assert.equal(fixture.commitCount, 0);
    assert.equal(fixture.publishCount, 0);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("transaction rejects a decoded snapshot that cannot preserve the exact stored UTF-8 bytes", async () => {
  const fixture = await preferenceFixture({ invalidUtf8Config: true });
  try {
    const beforeBytes = await readFile(fixture.configPath);
    await assert.rejects(fixture.run(), ModelPreferenceRecoveryRequiredError);
    assert.equal(fixture.commitCount, 0);
    assert.equal(fixture.publishCount, 0);
    assert.deepEqual(await readFile(fixture.configPath), beforeBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("run preflight rejects an authority identity that recovery would quarantine", async () => {
  const fixture = await preferenceFixture({ controlConnectionId: true });
  try {
    await assert.rejects(fixture.run(), /route identity|recovery/i);
    assert.equal(fixture.commitCount, 0);
    assert.equal(fixture.publishCount, 0);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery preflights both files before changing config when session bytes are foreign", async () => {
  const fixture = await preferenceFixture();
  try {
    await assert.rejects(fixture.run("after-provider-commit"), ModelPreferenceCrashError);
    const stagingConfig = await readFile(fixture.configPath, "utf8");
    const foreignSession = JSON.parse(
      await readFile(fixture.sessionPath, "utf8"),
    ) as { title: string };
    foreignSession.title = "foreign-session-edit";
    const foreignSessionBytes = `${JSON.stringify(foreignSession, null, 2)}\n`;
    await writeFile(fixture.sessionPath, foreignSessionBytes, "utf8");

    await assert.rejects(fixture.recover(), ModelPreferenceRecoveryRequiredError);
    assert.equal(await readFile(fixture.configPath, "utf8"), stagingConfig);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), foreignSessionBytes);
    assert.equal(fixture.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup recovery loses its provider lease before convergence and retains the journal", async () => {
  const fixture = await preferenceFixture();
  try {
    await assert.rejects(
      fixture.run("after-preferences-durable"),
      ModelPreferenceCrashError,
    );
    const stagingConfig = await readFile(fixture.configPath, "utf8");
    const stagingSession = await readFile(fixture.sessionPath, "utf8");
    let held = true;
    let reads = 0;

    await assert.rejects(recoverModelPreferenceTransactions({
      appHome: fixture.appHome,
      routeAuthority: {
        async assertHeld() {
          if (!held) throw new Error("fixed recovery lease reclaimed");
        },
        async read() {
          reads += 1;
          const observed = structuredClone(fixture.authority);
          fixture.authority = {
            route: structuredClone(fixture.afterRoute),
            providerRevision: 5,
            connectionId: "model-preference-owner",
          };
          held = false;
          return observed;
        },
      },
    }), /lease reclaimed|recovery/i);

    assert.equal(reads, 1);
    assert.equal(await readFile(fixture.configPath, "utf8"), stagingConfig);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), stagingSession);
    assert.equal((await readdir(join(
      fixture.appHome,
      "transactions",
      "model-preference",
    ))).length, 1);

    await fixture.recover();
    const recoveredConfig = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as { mainModel: string };
    const recoveredSession = JSON.parse(
      await readFile(fixture.sessionPath, "utf8"),
    ) as { model: string; route: RouteIdentityV1 };
    assert.equal(recoveredConfig.mainModel, fixture.afterRoute.requestedModelId);
    assert.equal(recoveredSession.model, fixture.afterRoute.requestedModelId);
    assert.deepEqual(recoveredSession.route, fixture.afterRoute);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup recovery fails closed when an invalid claim cannot be quarantined", async () => {
  const fixture = await preferenceFixture();
  try {
    const transactionRoot = join(fixture.appHome, "transactions", "model-preference");
    const invalidClaim = join(transactionRoot, "not-a-uuid");
    await mkdir(invalidClaim, { recursive: true });
    await writeFile(join(
      fixture.appHome,
      "transactions",
      "model-preference-quarantine",
    ), "blocks-quarantine-directory", "utf8");
    let authorityReads = 0;

    await assert.rejects(recoverModelPreferenceTransactions({
      appHome: fixture.appHome,
      routeAuthority: {
        async assertHeld() {},
        async read() {
          authorityReads += 1;
          return structuredClone(fixture.authority);
        },
      },
    }), ModelPreferenceRecoveryRequiredError);
    assert.equal(authorityReads, 0);
    assert.deepEqual(await readdir(transactionRoot), ["not-a-uuid"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a throwing live publication retains its route-durable journal", async () => {
  const fixture = await preferenceFixture({ publishThrows: true });
  try {
    await assert.rejects(fixture.run(), ModelPreferenceRecoveryRequiredError);
    assert.equal(fixture.publishCount, 1);
    assert.equal(fixture.authority.route?.requestedModelId, fixture.afterRoute.requestedModelId);
    const journals = await readdir(join(
      fixture.appHome,
      "transactions",
      "model-preference",
    ));
    assert.equal(journals.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("completion acknowledgement loss retains the committed preference journal", async () => {
  const fixture = await preferenceFixture({
    failCompletionAcknowledgement: true,
  });
  try {
    await assert.rejects(fixture.run(), ModelPreferenceRecoveryRequiredError);
    assert.equal(fixture.publishCount, 1);
    assert.equal(
      fixture.authority.route?.requestedModelId,
      fixture.afterRoute.requestedModelId,
    );
    const storedConfig = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as { mainModel: string };
    const storedSession = JSON.parse(
      await readFile(fixture.sessionPath, "utf8"),
    ) as { model: string; route: RouteIdentityV1 };
    assert.equal(storedConfig.mainModel, fixture.afterRoute.requestedModelId);
    assert.equal(storedSession.model, fixture.afterRoute.requestedModelId);
    assert.deepEqual(storedSession.route, fixture.afterRoute);
    assert.equal((await readdir(join(
      fixture.appHome,
      "transactions",
      "model-preference",
    ))).length, 1, "completion failure must retain exact FINAL recovery evidence");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery rejects stale authority revision without changing STAGING bytes or publishing live", async () => {
  const fixture = await preferenceFixture();
  try {
    await assert.rejects(
      fixture.run("after-preferences-durable"),
      ModelPreferenceCrashError,
    );
    const stagingConfig = await readFile(fixture.configPath, "utf8");
    const stagingSession = await readFile(fixture.sessionPath, "utf8");
    fixture.authority = { ...fixture.authority, providerRevision: 99 };

    await assert.rejects(fixture.recover(), ModelPreferenceRecoveryRequiredError);
    assert.equal(await readFile(fixture.configPath, "utf8"), stagingConfig);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), stagingSession);
    assert.equal(fixture.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery rejects third config bytes and never overwrites the foreign edit", async () => {
  const fixture = await preferenceFixture();
  try {
    await assert.rejects(
      fixture.run("after-preferences-durable"),
      ModelPreferenceCrashError,
    );
    const foreign = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as OrcodeConfigWithBudget;
    foreign.maxSteps = 77;
    await saveConfig(foreign, fixture.configPath);
    const foreignBytes = await readFile(fixture.configPath, "utf8");

    await assert.rejects(fixture.recover(), ModelPreferenceRecoveryRequiredError);
    assert.equal(await readFile(fixture.configPath, "utf8"), foreignBytes);
    assert.equal(fixture.publishCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery after an already attempted live publish never publishes a second time", async () => {
  const fixture = await preferenceFixture();
  try {
    await assert.rejects(fixture.run("after-live-publish"), ModelPreferenceCrashError);
    assert.equal(fixture.publishCount, 1);
    await fixture.recover();
    assert.equal(fixture.publishCount, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a payload over 16 MiB fails typed before journal, provider, config, session, or live mutation", async () => {
  const fixture = await preferenceFixture({ hugeSession: true });
  try {
    await assert.rejects(fixture.run(), ModelPreferencePayloadTooLargeError);
    assert.equal(fixture.commitCount, 0);
    assert.equal(fixture.publishCount, 0);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
    const transactionRoot = join(fixture.appHome, "transactions", "model-preference");
    const entries = await readdir(transactionRoot).catch(() => [] as string[]);
    assert.deepEqual(entries, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("orphan and future private claims are quarantined without authority or preference effects", async () => {
  const fixture = await preferenceFixture();
  try {
    const transactionRoot = join(fixture.appHome, "transactions", "model-preference");
    const store = new PrivateStore({ root: fixture.appHome });
    await store.ensureDirectory(transactionRoot);
    const orphan = await store.createDirectoryExclusive(join(
      transactionRoot,
      "88888888-8888-4888-8888-888888888881",
    ));
    assert.ok(orphan);
    await store.writeClaimPayload(orphan, "before-config.json", "{}\n");

    const future = await store.createDirectoryExclusive(join(
      transactionRoot,
      "88888888-8888-4888-8888-888888888882",
    ));
    assert.ok(future);
    for (const name of PRIVATE_STORE_CLAIM_PAYLOAD_NAMES) {
      await store.writeClaimPayload(future, name, "{}\n");
    }
    await store.writeClaimManifest(future, '{"version":2}\n', null);
    let authorityReads = 0;

    await recoverModelPreferenceTransactions({
      appHome: fixture.appHome,
      routeAuthority: {
        async assertHeld() {},
        async read() {
          authorityReads += 1;
          return structuredClone(fixture.authority);
        },
      },
    });

    assert.equal(authorityReads, 0);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.beforeConfigBytes);
    assert.equal(await readFile(fixture.sessionPath, "utf8"), fixture.beforeSessionBytes);
    assert.deepEqual(await readdir(transactionRoot), []);
    const quarantine = await readdir(join(
      fixture.appHome,
      "transactions",
      "model-preference-quarantine",
    ));
    assert.equal(quarantine.length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
