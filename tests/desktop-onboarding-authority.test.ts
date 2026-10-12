import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODEX_DESCRIPTOR, BackendRegistry, type RouteIdentityV1 } from "../src/backends.js";
import { createCrossCommandRuntime, createSettingsSession, DefaultProviderRuntime, SessionProviderRuntimeGuard } from "../src/cli.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.js";
import { projectDesktopCapabilities, type DesktopCapabilityInput } from "../src/desktop-capabilities.js";
import type { DesktopCapabilitySnapshot } from "../src/desktop-contracts.js";
import { OpenRouterService } from "../src/openrouter.js";
import { OPENROUTER_DESCRIPTOR } from "../src/openrouter-backend.js";
import { CodexProfileRouteRuntime, type CodexAccountModelClient } from "../src/model-runtime.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { PrivateStore } from "../src/private-store.js";
import {
  ProviderStateStore,
  requireKeychainCredentialPointer,
  type ProviderSetupStateV3,
} from "../src/provider-state.js";
import { RuleStore } from "../src/rules.js";
import { SessionStore } from "../src/session.js";
import type { TerminalUi } from "../src/tui.js";
import { DesktopOnboardingController } from "../src/desktop-onboarding.js";
import { proveActivatedRoutePickerSelection, validateResolvedRoutePickerPair } from "../src/route-picker.js";
import type { ModelInfo } from "../src/types.js";

test("projects two same-provider connections without collapsing their opaque route choices", () => {
  const snapshot = projectDesktopCapabilities({
    state: {
      schemaVersion: 3, revision: 7, lifecycle: "configured", defaultRoute: null,
      connections: [
        connection("a-1", "first"),
        connection("a-2", "second"),
      ],
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
    generation: 4,
    routeRunnable: false,
    providers: [{
      providerId: "openrouter", providerLabel: "OpenRouter",
      connection: null, connectionId: null, accountLabel: null,
      state: "ready", setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: true },
      routes: [route("h-1", "a-1", "first"), route("h-2", "a-2", "second")],
    }],
    activeRoute: null, undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  });

  assert.deepEqual(snapshot.providers[0]?.routes.map((item) => [item.handle, item.connectionId]), [
    ["h-1", "a-1"], ["h-2", "a-2"],
  ]);
  assert.equal(snapshot.providers[0]?.multiProfile.enabled, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /credentialSlot|credentialBinding|pointer|homeId|codexHome|fingerprint|private-/i);
});

test("forces Kimi unavailable even when an authority cache claims it is ready", () => {
  const snapshot = projectDesktopCapabilities({
    state: {
      schemaVersion: 3, revision: 8, lifecycle: "configured", defaultRoute: null,
      connections: [connection("kimi-1", "kimi", "kimi-code")],
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    },
    generation: 5,
    routeRunnable: true,
    providers: [{
      providerId: "kimi-code", providerLabel: "Kimi Code",
      connection: authorityConnection("kimi-1", "kimi-code"), connectionId: "kimi-1",
      accountLabel: "Kimi Code", state: "ready", setupMethods: ["kimi-owner-connect"], multiProfile: { enabled: false },
      routes: [route("kimi-h", "kimi-1", "kimi", "kimi-code")],
    }],
    activeRoute: { routeHandle: "kimi-h", providerLabel: "Kimi Code", modelLabel: "kimi", accountLabel: "Kimi Code" },
    undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
  });
  assert.equal(snapshot.routeRunnable, false);
  assert.equal(snapshot.providers[0]?.state, "disabled");
  assert.equal(snapshot.providers[0]?.routes[0]?.runnable, false);
});

test("rejects aggregate providers with a missing or mismatched authoritative connection", () => {
  const input = authorityInput();
  const missing = {
    ...input,
    providers: [{ ...input.providers[0]!, routes: [route("h-1", "missing-connection", "first")] }],
  } satisfies DesktopCapabilityInput;
  assert.throws(() => projectDesktopCapabilities(missing), /sicher dargestellt/i);

  const mismatched = {
    ...input,
    providers: [{ ...input.providers[0]!, connectionId: "a-1" }],
  } satisfies DesktopCapabilityInput;
  assert.throws(() => projectDesktopCapabilities(mismatched), /sicher dargestellt/i);
});

test("runtime authority is passive, keeps epoch handles stable, and gives same-provider accounts distinct labels", async () => {
  const fixture = await runtimeFixture();
  const authority = fixture.runtime.desktopOnboardingAuthority();
  fixture.resetObservedCalls();

  const first = authority.snapshot();
  const second = authority.snapshot();
  const openrouter = first.providers.filter((provider) => provider.providerId === "openrouter");

  assert.deepEqual(
    [...new Map(openrouter.flatMap((provider) => provider.routes)
      .map((route) => [route.connectionId, route.accountLabel] as const)).entries()],
    [[OPENROUTER_A1, "Persönliches OpenRouter 1"], [OPENROUTER_A2, "Persönliches OpenRouter 2"]],
  );
  assert.deepEqual(
    first.providers.flatMap((provider) => provider.routes).map((route) => route.handle),
    second.providers.flatMap((provider) => provider.routes).map((route) => route.handle),
  );
  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.activationCalls.length, 0);
  assert.equal(fixture.adapterCalls.length, 0);
  assert.equal(fixture.mutations, 0);
});

test("runtime shared route picker owns opaque handles and resolves exact same-model account routes passively", async () => {
  const fixture = await runtimeFixture({ modelsA1: ["shared"], modelsA2: ["shared"] });
  const authority = fixture.runtime.routePickerAuthority();
  assert.equal(fixture.runtime.routePickerAuthority(), authority);
  fixture.resetObservedCalls();

  const first = authority.view({ role: "lead" });
  const second = authority.view({ role: "lead" });
  const shared = first.candidates.filter((candidate) => candidate.canonicalModelId === "vendor/shared");
  assert.equal(shared.length, 2);
  assert.deepEqual(second.candidates.map((candidate) => candidate.handle), first.candidates.map((candidate) => candidate.handle));
  assert.notEqual(shared[0]?.handle, shared[1]?.handle);
  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.activationCalls.length, 0);
  assert.equal(fixture.adapterCalls.length, 0);
  assert.equal(fixture.refreshCalls.length, 0);

  const resolved = shared.map((candidate) => authority.resolve({ role: "lead" }, {
    handle: candidate.handle, revision: first.revision, generation: first.generation,
  }));
  assert.deepEqual(resolved.map((entry) => entry.connectionId), [OPENROUTER_A1, OPENROUTER_A2]);
  assert.deepEqual(resolved.map((entry) => entry.route.accountFingerprint), ["acct_alpha_111111", "acct_beta_222222"]);
  assert.doesNotThrow(() => validateResolvedRoutePickerPair(resolved[0]!, resolved[1]!));
  assert.doesNotMatch(JSON.stringify(first), /acct_|billingRealm|credential|routeIdentity|private/i);
});

test("desktop onboarding publishes and activates only the shared route-picker handles", async () => {
  const fixture = await runtimeFixture();
  const desktop = fixture.runtime.desktopOnboardingAuthority();
  const snapshot = desktop.snapshot();
  const picker = fixture.runtime.routePickerAuthority().view({ role: "main" });
  assert.deepEqual(
    snapshot.providers.flatMap((provider) => provider.routes).map((candidate) => candidate.handle),
    picker.candidates.map((candidate) => candidate.handle),
  );

  const selected = picker.candidates.find((candidate) => candidate.connectionId === OPENROUTER_A2)!;
  fixture.resetObservedCalls();
  await desktop.activate({
    routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
    revision: picker.revision, generation: picker.generation,
  });
  assert.equal(fixture.activationCalls[0]?.targetConnectionId, OPENROUTER_A2);
});

test("runtime route picker rejects foreign, stale, and Kimi handles without provider effects", async () => {
  const fixture = await runtimeFixture();
  const foreign = await runtimeFixture();
  const authority = fixture.runtime.routePickerAuthority();
  const view = authority.view({ role: "main" });
  const selected = view.candidates.find((candidate) => candidate.providerId === "openrouter")!;
  fixture.resetObservedCalls();
  foreign.resetObservedCalls();

  assert.throws(() => foreign.runtime.routePickerAuthority().resolve({ role: "main" }, {
    handle: selected.handle, revision: view.revision, generation: view.generation,
  }));
  assert.throws(() => authority.resolve({ role: "main" }, {
    handle: "kimi-private-canary", revision: view.revision, generation: view.generation,
  }));
  await fixture.advanceGeneration();
  assert.throws(() => authority.resolve({ role: "main" }, {
    handle: selected.handle, revision: view.revision, generation: view.generation,
  }), /stale/i);
  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.activationCalls.length, 0);
  assert.equal(fixture.adapterCalls.length, 0);
  assert.equal(foreign.credentialCalls.length, 0);
});

test("runtime-backed disabled Kimi handle rejects in picker and Desktop with zero effects and no canary leak", async () => {
  const fixture = await runtimeFixture({ kimiDefault: true, warmCache: false });
  const desktop = fixture.runtime.desktopOnboardingAuthority();
  const snapshot = desktop.snapshot();
  const kimiProvider = snapshot.providers.find((provider) => provider.providerId === "kimi-code")!;
  const kimi = kimiProvider.routes[0]!;
  assert.equal(kimiProvider.state, "disabled");
  assert.equal(kimi.runnable, false);
  assert.ok(kimi.disabled);
  assert.equal(kimi.handle, fixture.runtime.routePickerAuthority().view({ role: "main" })
    .candidates.find((candidate) => candidate.providerId === "kimi-code")?.handle);
  assert.doesNotMatch(JSON.stringify(snapshot), /KIMI_ROUTE_PRIVATE_CANARY/);
  const beforeRoute = fixture.runtime.currentSessionRoute();
  fixture.resetObservedCalls();

  const caughtErrors: string[] = [];
  assert.throws(() => {
    fixture.runtime.routePickerAuthority().resolve({ role: "main" }, {
      handle: kimi.handle, revision: snapshot.revision, generation: snapshot.generation,
    });
  }, (error: unknown) => {
    caughtErrors.push(String(error));
    return true;
  });
  await assert.rejects(desktop.activate({
      routeHandle: kimi.handle, providerId: kimi.providerId, connectionId: kimi.connectionId,
      revision: snapshot.revision, generation: snapshot.generation,
    }), (error: unknown) => {
      caughtErrors.push(String(error));
      return true;
    });

  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.coordinatorCalls, 0);
  assert.equal(fixture.inspectionCalls, 0);
  assert.equal(fixture.catalogCalls, 0);
  assert.equal(fixture.adapterCalls.length, 0);
  assert.equal(fixture.kimiProviderEffects, 0);
  assert.equal(fixture.activationCalls.length, 0);
  assert.equal(fixture.refreshCalls.length, 0);
  assert.equal(fixture.mutations, 0);
  assert.deepEqual(fixture.runtime.currentSessionRoute(), beforeRoute);
  assert.deepEqual(fixture.outputSink, []);
  assert.doesNotMatch(JSON.stringify([caughtErrors, fixture.outputSink]), /KIMI_ROUTE_PRIVATE_CANARY/);
});

test("trusted terminal owner gets a distinct resolvable Kimi namespace while Desktop and non-owner stay closed", async () => {
  const owner = await runtimeFixture({ kimiDefault: true, warmCache: false });
  const desktop = owner.runtime.routePickerAuthority();
  const terminal = owner.runtime.terminalOwnerRoutePickerAuthority();
  assert.notEqual(terminal, desktop);
  const desktopView = desktop.view({ role: "main" });
  const terminalView = terminal.view({ role: "main" });
  const desktopKimi = desktopView.candidates.find((row) => row.providerId === "kimi-code")!;
  const terminalKimi = terminalView.candidates.find((row) => row.providerId === "kimi-code")!;
  assert.equal(desktopKimi.runnable, false);
  assert.equal(terminalKimi.runnable, true);
  owner.resetObservedCalls();
  assert.throws(() => desktop.resolve({ role: "main" }, {
    handle: terminalKimi.handle, revision: terminalView.revision, generation: terminalView.generation,
  }));
  const resolved = terminal.resolve({ role: "main" }, {
    handle: terminalKimi.handle, revision: terminalView.revision, generation: terminalView.generation,
  });
  assert.equal(resolved.route.backendId, "kimi-code");
  assert.equal(owner.kimiProviderEffects, 0);
  assert.equal(owner.credentialCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(terminalView), /KIMI_ROUTE_PRIVATE_CANARY/);

  const nonOwner = await runtimeFixture({ kimiDefault: true, warmCache: false, executionMode: "json" });
  assert.equal(nonOwner.runtime.terminalOwnerRoutePickerAuthority(), nonOwner.runtime.routePickerAuthority());
  const nonOwnerView = nonOwner.runtime.terminalOwnerRoutePickerAuthority().view({ role: "main" });
  assert.equal(nonOwnerView.candidates.find((row) => row.providerId === "kimi-code")?.runnable, false);
});

test("real terminal Settings composition selects healthy Kimi through only its captured owner authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-settings-owner-kimi-"));
  try {
    const fixture = await runtimeFixture({ kimiDefault: true, warmCache: false });
    const workspace = join(root, "workspace");
    const appHome = join(root, ".orcode");
    const configPath = join(appHome, "config.json");
    await mkdir(workspace, { recursive: true });
    const route = fixture.runtime.currentSessionRoute()!;
    const config = structuredClone(DEFAULT_CONFIG);
    config.mainModel = route.requestedModelId;
    config.providerSetup = fixture.providerState();
    await saveConfig(config, configPath);
    const session = SessionStore.create(workspace, appHome, "owner Kimi settings");
    session.setPreferences(route.requestedModelId, { mode: "auto" }, route);
    await session.save();
    const ruleStore = await RuleStore.load(appHome);
    const ownerSource = fixture.runtime.terminalOwnerRoutePickerAuthority();
    const desktopSource = fixture.runtime.routePickerAuthority();
    let ownerViews = 0;
    let ownerResolves = 0;
    let desktopViews = 0;
    let desktopResolves = 0;
    const ownerAuthority = {
      view(request: Parameters<typeof ownerSource.view>[0]) {
        ownerViews += 1;
        return ownerSource.view(request);
      },
      resolve(request: Parameters<typeof ownerSource.resolve>[0], selection: Parameters<typeof ownerSource.resolve>[1]) {
        ownerResolves += 1;
        return ownerSource.resolve(request, selection);
      },
    };
    const desktopAuthority = {
      view(request: Parameters<typeof desktopSource.view>[0]) {
        desktopViews += 1;
        return desktopSource.view(request);
      },
      resolve(request: Parameters<typeof desktopSource.resolve>[0], selection: Parameters<typeof desktopSource.resolve>[1]) {
        desktopResolves += 1;
        return desktopSource.resolve(request, selection);
      },
    };
    const initialOwnerView = ownerSource.view({ role: "main" });
    const kimi = initialOwnerView.candidates.find((row) => row.providerId === "kimi-code" && row.runnable)!;
    assert.ok(kimi, "the real terminal-owner authority must mint a runnable Kimi row");
    let editorCalls = 0;
    const notices: string[] = [];
    const intents = [
      { kind: "select-item" as const, itemId: "main-model" },
      { kind: "activate" as const },
      { kind: "back" as const },
    ];
    const surface = {
      begin() {},
      async nextIntent() { return intents.shift()!; },
      async edit() {
        editorCalls += 1;
        const ownerView = ownerAuthority.view({ role: "main" });
        const currentKimi = ownerView.candidates.find((row) => row.providerId === "kimi-code" && row.runnable)!;
        return { kind: "value" as const, value: { kind: "model-route" as const, selection: {
          handle: currentKimi.handle, revision: ownerView.revision, generation: ownerView.generation,
        } } };
      },
      end() {}, applyAppearance() {}, async confirmAction() { return { accepted: true }; },
      async pickChoice() { return null; }, async readSecret() { return null; }, async pickModel() { return null; },
      addMessage() {}, showSettingsNotice(message: string) { notices.push(message); }, restoreSettings() {},
    } as unknown as TerminalUi;
    fixture.resetObservedCalls();
    await createSettingsSession({
      executionMode: "local-interactive-owner", workspace, configPath, config, session, ruleStore,
      providerRuntime: {
        routePickerAuthority: () => desktopAuthority,
        terminalOwnerRoutePickerAuthority: () => ownerAuthority,
        activity: () => fixture.runtime.activity(),
        currentSessionRoute: () => fixture.runtime.currentSessionRoute(),
        readCachedSettingsRoute: () => fixture.runtime.readCachedSettingsRoute(),
        readCachedProviderStatus: () => fixture.runtime.readCachedProviderStatus(),
        readCachedSettingsModels: () => fixture.runtime.readCachedSettingsModels(),
      },
      localRuntime: { guard: { async resolvePath(path: string) { return join(workspace, path); } } },
    } as never, surface, false).open();

    assert.ok(ownerViews > 0, `the real Settings editor reads the captured owner authority; edits=${editorCalls}; notices=${notices.join(" | ")}`);
    assert.ok(ownerResolves > 0, "the real Settings mutation resolves through the captured owner authority");
    assert.equal(desktopViews, 0);
    assert.equal(desktopResolves, 0);
    assert.equal(fixture.kimiProviderEffects, 0, "reselecting current Kimi is a zero-effect no-op");
    assert.equal(fixture.credentialCalls.length, 0);
    assert.equal(fixture.mutations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime activation owns the chosen OpenRouter account, proves the exact route, and rotates its handle", async () => {
  const fixture = await runtimeFixture();
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const selected = before.providers.filter((provider) => provider.providerId === "openrouter")
    .flatMap((provider) => provider.routes).find((route) => route.connectionId === OPENROUTER_A2)!;
  fixture.resetObservedCalls();

  const accepted = await authority.activate({
    routeHandle: selected.handle,
    providerId: selected.providerId,
    connectionId: selected.connectionId,
    revision: before.revision,
    generation: before.generation,
  });
  const after = authority.snapshot();

  assert.equal(fixture.credentialCalls.length, 1);
  assert.equal(fixture.activationCalls.length, 1);
  assert.equal(fixture.activationCalls[0]?.targetConnectionId, OPENROUTER_A2);
  assert.equal(fixture.activationCalls[0]?.requireCandidatePermit, true);
  assert.equal(fixture.activationCalls[0]?.candidateAuthorityPurpose, "retained-model-preference");
  assert.equal(fixture.ensureCalls.some((route) => sameRoute(route, fixture.routeFor(OPENROUTER_A2, "vendor/two"))), true);
  assert.notEqual(accepted.routeHandle, selected.handle);
  assert.equal(after.activeRoute?.routeHandle, accepted.routeHandle);
  assert.equal(after.routeRunnable, true);
  await assert.rejects(
    authority.activate({
      routeHandle: selected.handle,
      providerId: selected.providerId,
      connectionId: selected.connectionId,
      revision: before.revision,
      generation: before.generation,
    }),
  );
  assert.equal(fixture.credentialCalls.length, 1, "a stale opaque handle never reopens credential access");
});

test("runtime activation delegates its post-inner rebound through the trusted production proof port", async () => {
  const fixture = await runtimeFixture({ observeRouteProof: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const selected = before.providers.flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === OPENROUTER_A2)!;
  const result = await authority.activate({
    routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
    revision: before.revision, generation: before.generation,
  });
  assert.equal(fixture.proofPortCalls, 1);
  assert.notEqual(result.routeHandle, selected.handle);
});

test("real runtime proof pauses after B commit and rejects a later durable competing route", async () => {
  const fixture = await runtimeFixture({ deferRouteProof: true, modelsA2: ["two", "competing-c"] });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const selected = before.providers.flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === OPENROUTER_A2)!;
  const pending = authority.activate({
    routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
    revision: before.revision, generation: before.generation,
  });
  await fixture.waitForRouteProof();
  const privateSourceHandle = fixture.proofSourceHandle!;
  assert.doesNotMatch(JSON.stringify(authority.snapshot()), new RegExp(privateSourceHandle));
  const afterB = authority.snapshot();
  const refreshed = await authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A2,
    revision: afterB.revision, generation: afterB.generation,
  });
  const competing = refreshed.providers.flatMap((provider) => provider.routes)
    .find((route) => route.canonicalModelId === "vendor/competing-c");
  assert.ok(competing, JSON.stringify(refreshed.providers));
  const competingResult = await authority.activate({
    routeHandle: competing.handle, providerId: competing.providerId, connectionId: competing.connectionId,
    revision: refreshed.revision, generation: refreshed.generation,
  });
  fixture.releaseRouteProof();
  await assert.rejects(pending);
  assert.equal(fixture.proofAcceptedHandles.length, 2);
  assert.notEqual(fixture.proofAcceptedHandles[0], fixture.proofAcceptedHandles[1]);
  assert.ok(fixture.proofCaptureKeys[1]!.length > 0);
  assert.equal(fixture.proofCaptureKeys[1]!.includes(fixture.proofAcceptedHandles[1]!), true);
  assert.equal(fixture.proofCaptureKeys[1]!.includes(fixture.proofAcceptedHandles[0]!), false);
  assert.equal(fixture.runtime.currentSessionRoute().canonicalModelId, "vendor/competing-c");
  assert.equal(authority.snapshot().activeRoute?.routeHandle, competingResult.routeHandle);
  assert.equal(fixture.proofCaptureHandles.includes(privateSourceHandle), false);
  assert.doesNotMatch(JSON.stringify(authority.snapshot()),
    new RegExp(fixture.proofAcceptedHandles.join("|")));
});

test("runtime authority keeps Kimi disabled and refuses it before credential or activation work", async () => {
  const fixture = await runtimeFixture();
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const snapshot = authority.snapshot();
  const kimi = snapshot.providers.find((provider) => provider.providerId === "kimi-code")!;
  fixture.resetObservedCalls();

  assert.equal(kimi.state, "disabled");
  assert.equal(kimi.disabled?.code, "native-local-action-unavailable");
  await assert.rejects(authority.activate({
    routeHandle: "unknown-kimi-handle",
    providerId: "kimi-code",
    connectionId: KIMI_CONNECTION,
    revision: snapshot.revision,
    generation: snapshot.generation,
  }));
  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.activationCalls.length, 0);
});

test("each cached model becomes its own exact candidate and selecting B activates B", async () => {
  const fixture = await runtimeFixture({ modelsA1: ["model-a", "model-b"] });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const candidates = before.providers
    .filter((provider) => provider.connectionId === OPENROUTER_A1)
    .flatMap((provider) => provider.routes);

  const cached = candidates.filter((route) => route.canonicalModelId !== "vendor/model");
  assert.deepEqual(cached.map((route) => route.canonicalModelId), ["vendor/model-a", "vendor/model-b"]);
  assert.notEqual(cached[0]?.handle, cached[1]?.handle);
  const modelB = cached.find((route) => route.canonicalModelId === "vendor/model-b")!;
  fixture.resetObservedCalls();
  await authority.activate({
    routeHandle: modelB.handle, providerId: "openrouter", connectionId: OPENROUTER_A1,
    revision: before.revision, generation: before.generation,
  });

  assert.equal(fixture.activationCalls[0]?.expectedRequestedModelId, "vendor/model-b");
  assert.equal(fixture.activationCalls[0]?.selectedCanonicalModelId, "vendor/model-b");
});

test("cold retained accounts are represented without a warm cache and refresh only the explicit account", async () => {
  const fixture = await runtimeFixture({ warmCache: false });
  const authority = fixture.runtime.desktopOnboardingAuthority() as unknown as {
    snapshot(): ReturnType<typeof fixture.runtime.desktopOnboardingAuthority>["snapshot"] extends () => infer Snapshot ? Snapshot : never;
    refreshAccount(selection: { providerId: string; connectionId: string; revision: number; generation: number }): Promise<unknown>;
  };
  const before = authority.snapshot();
  const accounts = before.providers.filter((provider) => provider.providerId === "openrouter");
  assert.deepEqual(accounts.map((provider) => provider.connectionId), [OPENROUTER_A1, OPENROUTER_A2]);
  assert.deepEqual(accounts.map((provider) => provider.routes.length), [1, 0], "only the active-route fallback is allowed cold");
  assert.deepEqual(accounts[0]?.routes[0]?.capabilities, ["text"]);
  assert.equal(accounts[0]?.routes[0]?.reasoning, "unknown", "the active-route fallback has no catalogue metadata");
  fixture.resetObservedCalls();

  await authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A2,
    revision: before.revision, generation: before.generation,
  });

  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A2]);
  assert.equal(fixture.credentialCalls.length, 0, "the deterministic adapter seam owns its retained read");
  assert.equal(fixture.adapterCalls.filter((call) => call === "refresh-list-models").length, 1);
  const after = authority.snapshot();
  assert.deepEqual(
    after.providers.find((provider) => provider.connectionId === OPENROUTER_A2)?.routes.map((route) => route.connectionId),
    [OPENROUTER_A2],
  );
});

test("a cold header picker can return to accounts and explicitly activate a different model", async () => {
  const fixture = await runtimeFixture({ warmCache: false, refreshedModelsA1: ["first", "chosen-second"] });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const before = authority.snapshot();
  await controller.dispatch({ kind: "open-model-picker", returnTo: "chat", revision: before.revision, generation: before.generation });
  await controller.dispatch({ kind: "back", revision: before.revision, generation: before.generation });
  assert.equal(controller.snapshot().step, "provider");
  assert.deepEqual(fixture.refreshCalls, []);

  await controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: before.revision, generation: before.generation });
  await controller.dispatch({ kind: "choose-account", connectionId: OPENROUTER_A1, revision: before.revision, generation: before.generation });
  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
  assert.deepEqual(fixture.activationCalls, [], "refresh must not choose the first returned model");
  const selected = controller.snapshot().candidates.find((candidate) => candidate.canonicalModelId === "vendor/chosen-second")!;
  const result = await controller.dispatch({ kind: "choose-model", routeHandle: selected.handle, revision: before.revision, generation: before.generation });
  assert.equal(result.kind, "ready");
  assert.equal(fixture.providerState().defaultRoute?.canonicalModelId, "vendor/chosen-second");
  assert.equal(fixture.activationCalls.length, 1);
});

test("explicit Cross catalogue preparation refreshes only the active account without selecting a model", async () => {
  const fixture = await runtimeFixture({ warmCache: false, refreshedModelsA1: ["lead", "challenger"] });
  const before = fixture.providerState();

  await fixture.runtime.refreshActiveDesktopRouteCatalog();

  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
  assert.deepEqual(fixture.providerState(), before);
  assert.deepEqual(fixture.activationCalls, []);
  assert.equal(fixture.kimiProviderEffects, 0);
  const choices = fixture.runtime.routePickerAuthority().view({ role: "lead" }).candidates;
  assert.deepEqual(choices.filter((candidate) => candidate.capabilities.includes("tools"))
    .map((candidate) => candidate.canonicalModelId), ["vendor/lead", "vendor/challenger"]);
  await fixture.runtime.refreshActiveDesktopRouteCatalog();
  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1], "current complete account catalogue is reused");
});

test("a cold real Cross gate refreshes before explicit non-default role choices and preserves the main route", async () => {
  const fixture = await runtimeFixture({ warmCache: false, refreshedModelsA1: ["not-selected", "lead", "review"] });
  const before = fixture.providerState();
  const order: string[] = [];
  let selectedPair: { lead: RouteIdentityV1 | null; challenger: RouteIdentityV1 | null } | null = null;
  const actions = ["coding", "review", "start"] as const;
  let visit = 0;
  const runtime = createCrossCommandRuntime({
    worker: {
      async analyze() { throw new Error("empty task must only arm after explicit confirmation"); },
      async implement() { throw new Error("must not implement"); },
      async review() { throw new Error("must not review"); },
    },
    verification: { async run() { throw new Error("must not verify"); } },
    readPreferences: () => ({ lead: null, challenger: null }),
    async publishPreferences(pair) { order.push("publish"); selectedPair = structuredClone(pair); },
    picker: { async pickModelRoute() { throw new Error("legacy picker must not run"); } },
    routeAuthority: fixture.runtime.routePickerAuthority(),
    prepareRoutePicker: () => fixture.runtime.refreshActiveDesktopRouteCatalog(),
    publicPicker: {
      async pickModelRoute({ request, view }) {
        const model = request.role === "lead" ? "vendor/lead" : "vendor/review";
        const chosen = view.candidates.find((candidate) => candidate.canonicalModelId === model)!;
        assert.ok(chosen, "fresh account catalogue must be visible before the picker opens");
        assert.equal(chosen.runnable, true);
        order.push(request.role);
        return { handle: chosen.handle, revision: view.revision, generation: view.generation };
      },
    },
    surface: { restoreDraft() {}, discardDraft() {}, publishResult() {} },
    gateSurface: { async chooseGate(view) {
      if (visit === 0) {
        assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
        assert.equal(view.leadCandidate, null);
        assert.equal(view.challengerCandidate, null);
        assert.equal(view.canStart, false);
      }
      return actions[visit++] ?? null;
    } },
    async armPendingOneShot(pair) {
      order.push("arm");
      assert.deepEqual(pair, selectedPair);
    },
    crossUnavailableReason: () => null,
    cachedModels: () => [],
    context: () => ({}),
  });
  await runtime.openGate("");
  assert.deepEqual(order, ["lead", "challenger", "publish", "arm"]);
  assert.equal(selectedPair!.lead?.canonicalModelId, "vendor/lead");
  assert.equal(selectedPair!.challenger?.canonicalModelId, "vendor/review");
  assert.deepEqual(fixture.providerState(), before);
  assert.deepEqual(fixture.activationCalls, []);
});

test("a pre-aborted desktop account refresh performs no coordinator or adapter work", async () => {
  const fixture = await runtimeFixture({ warmCache: false });
  const authority = fixture.runtime.desktopOnboardingAuthority() as unknown as {
    snapshot(): DesktopCapabilitySnapshot;
    refreshAccount(
      selection: { providerId: string; connectionId: string; revision: number; generation: number },
      signal?: AbortSignal,
    ): Promise<DesktopCapabilitySnapshot>;
  };
  const before = authority.snapshot();
  const abort = new AbortController();
  abort.abort(new DOMException("window closed", "AbortError"));
  fixture.resetObservedCalls();

  await assert.rejects(authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A2,
    revision: before.revision, generation: before.generation,
  }, abort.signal), /abort/i);

  assert.equal(fixture.coordinatorCalls, 0);
  assert.deepEqual(fixture.refreshCalls, []);
  assert.deepEqual(fixture.adapterCalls, []);
  assert.equal(fixture.mutations, 0);
});

test("a pre-aborted desktop OpenRouter setup never consults its supplied surface", async () => {
  const fixture = await runtimeFixture();
  const runtime = fixture.runtime as unknown as {
    runDesktopOpenRouterSetup(surface: {
      chooseHub(): Promise<string | null>;
      readSecret(): Promise<string | null>;
      chooseModel(): Promise<string | null>;
      confirm(): Promise<boolean>;
      present(): void;
    }, signal: AbortSignal): Promise<unknown>;
  };
  let callbacks = 0;
  const abort = new AbortController();
  abort.abort(new DOMException("window closed", "AbortError"));

  await assert.rejects(runtime.runDesktopOpenRouterSetup({
    async chooseHub() { callbacks += 1; return "kimi-code"; },
    async readSecret() { callbacks += 1; return "never"; },
    async chooseModel() { callbacks += 1; return "never"; },
    async confirm() { callbacks += 1; return true; },
    present() { callbacks += 1; },
  }, abort.signal), /abort/i);
  assert.equal(callbacks, 0);
});

test("aborting a deferred desktop inspection settles without publishing its late result", async () => {
  const fixture = await runtimeFixture({ warmCache: false, deferInspection: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const abort = new AbortController();
  const pending = authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A2,
    revision: before.revision, generation: before.generation,
  }, abort.signal);

  await fixture.waitForInspection();
  abort.abort(new DOMException("window closed", "AbortError"));
  await assert.rejects(pending, /abort/i);
  assert.equal(fixture.inspectionSignal?.aborted, true);
  fixture.resolveInspection();
  await Promise.resolve();
  assert.equal(routesFor(authority.snapshot(), OPENROUTER_A2).length, 0);
});

test("aborting a deferred desktop catalog settles without publishing its late result", async () => {
  const fixture = await runtimeFixture({ warmCache: false, deferCatalog: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const abort = new AbortController();
  const pending = authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A2,
    revision: before.revision, generation: before.generation,
  }, abort.signal);

  await fixture.waitForCatalog();
  abort.abort(new DOMException("window closed", "AbortError"));
  await assert.rejects(pending, /abort/i);
  assert.equal(fixture.catalogSignal?.aborted, true);
  fixture.resolveCatalog();
  await Promise.resolve();
  assert.equal(routesFor(authority.snapshot(), OPENROUTER_A2).length, 0);
});

test("desktop account refresh clears its real deadline after abort and success", async (t) => {
  const abortFixture = await runtimeFixture({ warmCache: false, deferCatalog: true });
  const successFixture = await runtimeFixture({ warmCache: false, deferCatalog: true });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const liveTimers = new Set<unknown>();
  const scheduled: Array<{ handle: unknown; delay: number | undefined }> = [];
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    liveTimers.add(handle);
    scheduled.push({ handle, delay });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    liveTimers.delete(handle);
    cleared.add(handle);
    return originalClearTimeout(handle);
  }) as typeof clearTimeout;
  t.after(() => {
    for (const handle of liveTimers) originalClearTimeout(handle as never);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const abortAuthority = abortFixture.runtime.desktopOnboardingAuthority();
  const abortBefore = abortAuthority.snapshot();
  const abortController = new AbortController();
  const aborted = abortAuthority.refreshAccount({
    providerId: "openrouter",
    connectionId: OPENROUTER_A2,
    revision: abortBefore.revision,
    generation: abortBefore.generation,
  }, abortController.signal);
  const observedAbort = aborted.then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  await abortFixture.waitForCatalog();
  assert.deepEqual(scheduled.map((entry) => entry.delay), [8_000]);
  assert.equal(liveTimers.size, 1);
  const abortTimer = scheduled[0]!.handle;
  abortController.abort(new DOMException("window closed during catalog refresh", "AbortError"));
  const notSettled = Symbol("not-settled");
  const abortOutcome = await Promise.race([
    observedAbort,
    new Promise<typeof notSettled>((resolve) => setImmediate(() => resolve(notSettled))),
  ]);

  assert.notEqual(abortOutcome, notSettled, "refresh must reject before the late catalog is released");
  assert.equal((abortOutcome as Awaited<typeof observedAbort>).kind, "rejected");
  assert.equal(abortFixture.catalogSignal?.aborted, true);
  assert.equal(liveTimers.size, 0);
  assert.equal(cleared.has(abortTimer), true);

  abortFixture.resolveCatalog();
  await abortFixture.waitForCatalogReturn();
  const abortAfter = abortAuthority.snapshot();
  assert.equal(abortAfter.revision, abortBefore.revision);
  assert.equal(abortAfter.generation, abortBefore.generation);
  assert.equal(routesFor(abortAfter, OPENROUTER_A2).length, 0);

  const successAuthority = successFixture.runtime.desktopOnboardingAuthority();
  const successBefore = successAuthority.snapshot();
  const succeeded = successAuthority.refreshAccount({
    providerId: "openrouter",
    connectionId: OPENROUTER_A2,
    revision: successBefore.revision,
    generation: successBefore.generation,
  });

  await successFixture.waitForCatalog();
  assert.deepEqual(scheduled.map((entry) => entry.delay), [8_000, 8_000]);
  assert.equal(liveTimers.size, 1);
  const successTimer = scheduled[1]!.handle;
  successFixture.resolveCatalog();
  await successFixture.waitForCatalogReturn();
  const successAfter = await succeeded;

  assert.equal(liveTimers.size, 0);
  assert.equal(cleared.has(successTimer), true);
  assert.deepEqual(
    routesFor(successAfter, OPENROUTER_A2).map((candidate) => candidate.canonicalModelId),
    ["vendor/two"],
  );
});

test("desktop candidates publish only authority-confirmed capabilities", async () => {
  const fixture = await runtimeFixture({ modelsA1: ["no-tools", "tools-reasoning"] });
  const candidates = fixture.runtime.desktopOnboardingAuthority().snapshot().providers
    .filter((provider) => provider.connectionId === OPENROUTER_A1)
    .flatMap((provider) => provider.routes);

  const noTools = candidates.find((candidate) => candidate.canonicalModelId === "vendor/no-tools")!;
  const toolsReasoning = candidates.find((candidate) => candidate.canonicalModelId === "vendor/tools-reasoning")!;
  assert.deepEqual(noTools.capabilities, ["text"]);
  assert.equal(noTools.reasoning, "unsupported");
  assert.equal(noTools.runnable, false, "a known no-tools model cannot be offered for coding activation");
  assert.equal(noTools.disabled?.code, "model-not-runnable");
  const compressor = fixture.runtime.routePickerAuthority().view({ role: "compressor" }).candidates
    .find((candidate) => candidate.canonicalModelId === "vendor/no-tools")!;
  assert.equal(compressor.runnable, true, "text-only models remain usable for compression");
  assert.equal(compressor.disabled, undefined);
  assert.deepEqual(toolsReasoning.capabilities, ["text", "image-input", "tools", "reasoning"]);
  assert.equal(toolsReasoning.reasoning, "supported");
});

test("desktop catalogue entries expire with their revision and generation epoch", async () => {
  const fixture = await runtimeFixture({ modelsA1: ["model-a", "model-b"] });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  assert.equal(before.providers.flatMap((provider) => provider.routes).some((route) => route.canonicalModelId === "vendor/model-b"), true);

  await fixture.advanceEpoch();
  const after = authority.snapshot();

  assert.equal(after.providers.flatMap((provider) => provider.routes).some((route) => route.canonicalModelId === "vendor/model-b"), false);
});

test("an already-advanced authoritative generation rejects the stale public selection before credential work", async () => {
  const fixture = await runtimeFixture();
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const snapshot = authority.snapshot();
  const selected = snapshot.providers.flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === OPENROUTER_A1)!;
  await fixture.advanceGeneration();
  fixture.resetObservedCalls();

  await assert.rejects(authority.activate({
    routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
    revision: snapshot.revision, generation: snapshot.generation,
  }));
  assert.equal(fixture.credentialCalls.length, 0);
  assert.equal(fixture.activationCalls.length, 0);
});

test("a true empty home retains honest connectable provider placeholders", async () => {
  const fixture = await runtimeFixture({ empty: true, warmCache: false });
  const snapshot = fixture.runtime.desktopOnboardingAuthority().snapshot();

  assert.deepEqual(snapshot.providers.map((provider) => [provider.providerId, provider.connectionId, provider.state]), [
    ["openrouter", null, "disconnected"],
    ["kimi-code", null, "disabled"],
    ["codex", null, "disabled"],
  ]);
});

test("runtime authority activates only the explicitly selected Codex profile and model", async (t) => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-desktop-authority-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const connection = {
    id: "codex-authority-a",
    backendId: "codex" as const,
    enabled: true,
    maturity: "preview" as const,
    credentialBinding: {
      kind: "provider-runtime" as const,
      homeId: "codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
    },
    accountFingerprint: "acct_codex_authority_a",
    accountFingerprintState: "verified" as const,
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    lastHealth: readyHealth(0, "codex"),
  };
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 1,
    lifecycle: "configured",
    connections: [connection],
    defaultRoute: null,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  let codexClient: DesktopAuthorityCodexClient | null = null;
  const codexRuntime = new CodexProfileRouteRuntime({
    appHome,
    stateStore,
    createClient: async () => {
      codexClient = new DesktopAuthorityCodexClient();
      return codexClient;
    },
  });
  const registry = new BackendRegistry([{ descriptor: CODEX_DESCRIPTOR, adapter: codexRuntime }]);
  const guard = new SessionProviderRuntimeGuard();
  const coordinator = new ProviderActivationCoordinator({
    appHome,
    configPath: join(appHome, "config.json"),
    privateStore: new PrivateStore({ root: appHome }),
    credentials: {} as never,
    adapterResolver: () => { throw new Error("candidate adapter must not be used"); },
    stateStore,
    runtimeGuard: guard,
  });
  const orchestrator = new (await import("../src/setup.js")).SetupOrchestrator({
    registry,
    stateStore,
    activationCoordinator: coordinator,
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.providerSetup = state;
  const runtime = new DefaultProviderRuntime(
    new OpenRouterService(), {} as never, registry, stateStore, orchestrator,
    coordinator, guard, {} as never, null, null, config.mainModel, config, undefined,
    {
      credentialAuthority: {} as never,
      adapter: {} as never,
      forgetJournal: {} as never,
      codexAdapter: codexRuntime,
      async recover() {},
    } as never,
  );
  const authority = runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const before = authority.snapshot();
  assert.deepEqual(before.providers.filter((provider) => provider.providerId === "codex")
    .flatMap((provider) => provider.routes), []);

  await controller.dispatch({ kind: "choose-provider", providerId: "codex", revision: 1, generation: 0 });
  assert.equal(controller.snapshot().step, "account");
  await controller.dispatch({ kind: "choose-account", connectionId: connection.id, revision: 1, generation: 0 });
  assert.deepEqual(controller.snapshot().candidates.map((candidate) => candidate.canonicalModelId), ["gpt-5.6-codex"]);
  assert.equal(authority.snapshot().routeRunnable, false);

  const result = await controller.dispatch({
    kind: "choose-model",
    routeHandle: controller.snapshot().candidates[0]!.handle,
    revision: 1,
    generation: 0,
  });
  assert.equal(result.kind, "ready");
  assert.equal(authority.snapshot().routeRunnable, true);
  assert.equal(stateStore.read().defaultRoute?.backendId, "codex");

  const client = codexClient!;
  for (const update of [
    { authMode: "chatgpt", planType: "plus" },
    { authMode: "apikey", planType: "pro" },
    null,
  ]) {
    client.emitAccountUpdated(update);
    const revoked = authority.snapshot();
    assert.equal(revoked.activeRoute, null);
    assert.equal(revoked.routeRunnable, false);
    assert.equal(stateStore.read().defaultRoute?.backendId, "codex");
    assert.throws(() => orchestrator.ensureRunnableRoute(stateStore.read().defaultRoute!));
    assert.throws(() => codexRuntime.currentRouteAuthority(stateStore.read().defaultRoute!));
    await assert.rejects(controller.dispatch({
      kind: "choose-model", routeHandle: result.routeHandle, revision: revoked.revision, generation: revoked.generation,
    }));
  }
});

test("a partial generic cache never suppresses the explicit account catalogue refresh", async () => {
  const fixture = await runtimeFixture({ warmSecondAccount: false });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const snapshot = authority.snapshot();
  fixture.resetObservedCalls();

  await controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: snapshot.revision, generation: snapshot.generation });
  await controller.dispatch({ kind: "choose-account", connectionId: OPENROUTER_A1, revision: snapshot.revision, generation: snapshot.generation });

  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
  assert.equal(controller.snapshot().candidates.some((candidate) => candidate.canonicalModelId === "vendor/refreshed"), true);
});

test("a complete account refresh replaces stale partial models for only that account", async () => {
  const fixture = await runtimeFixture({
    modelsA1: ["stale-b"], refreshedModelsA1: ["fresh-a"],
  });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const before = authority.snapshot();
  assert.equal(routesFor(before, OPENROUTER_A1).some((route) => route.canonicalModelId === "vendor/stale-b"), true);

  await controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: before.revision, generation: before.generation });
  await controller.dispatch({ kind: "choose-account", connectionId: OPENROUTER_A1, revision: before.revision, generation: before.generation });

  const after = authority.snapshot();
  assert.equal(routesFor(after, OPENROUTER_A1).some((route) => route.canonicalModelId === "vendor/fresh-a"), true);
  assert.equal(routesFor(after, OPENROUTER_A1).some((route) => route.canonicalModelId === "vendor/stale-b"), false);
  assert.equal(controller.snapshot().candidates.some((route) => route.canonicalModelId === "vendor/fresh-a"), true);
  assert.equal(controller.snapshot().candidates.some((route) => route.canonicalModelId === "vendor/stale-b"), false);
  assert.equal(routesFor(after, OPENROUTER_A2).some((route) => route.canonicalModelId === "vendor/two"), true);
});

test("a complete empty account refresh removes stale partial models", async () => {
  const fixture = await runtimeFixture({
    modelsA1: ["stale-b"], modelsA2: ["preserved-other"], refreshedModelsA1: [],
  });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  assert.equal(fixture.runtime.readCachedModels().some((model) => model.id === "vendor/stale-b"), true);

  await authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A1,
    revision: before.revision, generation: before.generation,
  });

  const after = authority.snapshot();
  assert.equal(routesFor(after, OPENROUTER_A1).some((route) => route.canonicalModelId === "vendor/stale-b"), false);
  assert.equal(routesFor(after, OPENROUTER_A2).some((route) => route.canonicalModelId === "vendor/preserved-other"), true);
  assert.equal(fixture.runtime.readCachedModels().some((model) => model.id === "vendor/stale-b"), true,
    "the general Settings cache is not deleted by an account-specific Desktop refresh");
});

test("a cold retained account with null health refreshes only after inspected ready health", async () => {
  const fixture = await runtimeFixture({ warmCache: false, nullHealthA1: true, refreshedModelsA1: ["inspected-a"] });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const cold = before.providers.find((provider) => provider.connectionId === OPENROUTER_A1)!;
  assert.equal(cold.state, "disconnected");
  assert.equal(cold.routes[0]?.runnable, false);
  fixture.resetObservedCalls();

  await authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A1,
    revision: before.revision, generation: before.generation,
  });

  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
  const refreshed = authority.snapshot();
  assert.equal(refreshed.providers.find((provider) => provider.connectionId === OPENROUTER_A1)?.state, "ready");
  const inspected = routesFor(refreshed, OPENROUTER_A1).find((route) => route.canonicalModelId === "vendor/inspected-a");
  assert.equal(inspected?.runnable, true);
});

test("a fully published account refresh remains the one current proof, catalog, and model view after abort", async () => {
  const fixture = await runtimeFixture({
    warmCache: false,
    nullHealthA1: true,
    refreshedModelsA1: ["model"],
  });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const before = authority.snapshot();
  const abort = new AbortController();
  fixture.resetObservedCalls();

  await controller.dispatch({
    kind: "choose-provider",
    providerId: "openrouter",
    revision: before.revision,
    generation: before.generation,
  });
  await controller.dispatch({
    kind: "choose-account",
    connectionId: OPENROUTER_A1,
    revision: before.revision,
    generation: before.generation,
  }, abort.signal);
  abort.abort(new DOMException("window closed after publication", "AbortError"));

  const published = authority.snapshot();
  const account = published.providers.find((provider) => provider.connectionId === OPENROUTER_A1)!;
  assert.equal(account.state, "ready");
  assert.deepEqual(account.routes.map((candidate) => candidate.canonicalModelId), ["vendor/model"]);
  assert.deepEqual(controller.snapshot().candidates.map((candidate) => candidate.canonicalModelId), ["vendor/model"]);
  assert.deepEqual(fixture.refreshCalls, [OPENROUTER_A1]);
  assert.equal(fixture.adapterCalls.filter((call) => call === "refresh-list-models").length, 1);
});

test("a null-health inspection proof expires with its revision and generation", async () => {
  const fixture = await runtimeFixture({ warmCache: false, nullHealthA1: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  await authority.refreshAccount({
    providerId: "openrouter", connectionId: OPENROUTER_A1,
    revision: before.revision, generation: before.generation,
  });
  assert.equal(authority.snapshot().providers.find((provider) => provider.connectionId === OPENROUTER_A1)?.state, "ready");

  await fixture.advanceEpoch();

  const stale = authority.snapshot().providers.find((provider) => provider.connectionId === OPENROUTER_A1)!;
  assert.equal(stale.state, "disconnected");
  assert.equal(stale.routes[0]?.runnable, false);
});

test("a competing durable commit after activation but before retained access returns cannot be adopted", async () => {
  const fixture = await runtimeFixture({ deferCredentialReturn: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const selected = before.providers.flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === OPENROUTER_A2)!;
  const pending = authority.activate({
    routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
    revision: before.revision, generation: before.generation,
  });

  await fixture.waitForCredentialReturn();
  await fixture.competingCommit(OPENROUTER_A1);
  fixture.resolveCredentialReturn();

  await assert.rejects(pending);
  assert.equal(fixture.runtime.currentSessionRoute().accountFingerprint, fixture.routeFor(OPENROUTER_A1).accountFingerprint);
});

test("cancel after durable activation but before authority resolution reports commit-won instead of a false cancel", async () => {
  const fixture = await runtimeFixture({ deferCredentialReturn: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const controller = new DesktopOnboardingController({ authority });
  const before = authority.snapshot();
  await controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: before.revision, generation: before.generation });
  await controller.dispatch({ kind: "choose-account", connectionId: OPENROUTER_A2, revision: before.revision, generation: before.generation });
  const model = controller.snapshot().candidates[0]!;
  const pending = controller.dispatch({ kind: "choose-model", routeHandle: model.handle, revision: before.revision, generation: before.generation });
  const operationHandle = controller.snapshot().operationHandle;
  assert.equal(typeof operationHandle, "string");

  await fixture.waitForCredentialReturn();
  await assert.rejects(
    controller.dispatch({
      kind: "cancel",
      revision: before.revision,
      generation: before.generation,
      operationHandle,
    }),
    /already committed/i,
  );
  fixture.resolveCredentialReturn();
  const result = await pending;

  assert.equal(result.kind, "ready");
});

test("runtime activation preserves the caller abort reason and does not adopt a late route", async () => {
  const fixture = await runtimeFixture({ deferCredentialEntry: true });
  const authority = fixture.runtime.desktopOnboardingAuthority();
  const before = authority.snapshot();
  const selected = before.providers.flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === OPENROUTER_A2)!;
  const abort = new AbortController();
  const reason = new Error("branded desktop cancellation");
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const providerTimers = new Set<ReturnType<typeof setTimeout>>();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    let timer: ReturnType<typeof setTimeout>;
    const wrapped = (...callbackArgs: unknown[]) => {
      providerTimers.delete(timer);
      callback(...callbackArgs);
    };
    timer = realSetTimeout(wrapped, delay, ...args);
    if (delay === 8_000) providerTimers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    providerTimers.delete(timer);
    return realClearTimeout(timer);
  }) as typeof clearTimeout;
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = authority.activate({
      routeHandle: selected.handle, providerId: selected.providerId, connectionId: selected.connectionId,
      revision: before.revision, generation: before.generation,
    }, abort.signal);
    await fixture.waitForCredentialReturn();
    assert.equal(fixture.activeProviderEffects, 1);
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    assert.equal(providerTimers.size, 1);
    abort.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    fixture.resolveCredentialReturn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.notEqual(fixture.runtime.currentSessionRoute().accountFingerprint, fixture.routeFor(OPENROUTER_A2).accountFingerprint);
    assert.equal(fixture.activeProviderEffects, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(providerTimers.size, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    fixture.resolveCredentialReturn();
  }
});

function authorityInput(): DesktopCapabilityInput {
  return {
    state: {
      schemaVersion: 3 as const, revision: 7, lifecycle: "configured" as const, defaultRoute: null,
      connections: [connection("a-1", "first"), connection("a-2", "second")],
      cross: { enabled: false as const, preferredLead: null, preferredChallenger: null },
    },
    generation: 4, routeRunnable: false,
    providers: [{
      providerId: "openrouter" as const, providerLabel: "OpenRouter",
      connection: null, connectionId: null, accountLabel: null,
      state: "ready" as const, setupMethods: ["openrouter-owner-connect"] as const,
      multiProfile: { enabled: true }, routes: [route("h-1", "a-1", "first"), route("h-2", "a-2", "second")],
    }],
    activeRoute: null, undoAvailable: false, appearance: { showLargeLogo: true, showHeaderMark: true },
  };
}

async function runtimeFixture(options: {
  modelsA1?: readonly string[];
  modelsA2?: readonly string[];
  refreshedModelsA1?: readonly string[];
  warmCache?: boolean;
  warmSecondAccount?: boolean;
  deferCredentialReturn?: boolean;
  deferCredentialEntry?: boolean;
  empty?: boolean;
  nullHealthA1?: boolean;
  deferInspection?: boolean;
  deferCatalog?: boolean;
  kimiDefault?: boolean;
  observeRouteProof?: boolean;
  deferRouteProof?: boolean;
  executionMode?: "local-interactive-owner" | "json";
} = {}) {
  const a1 = runtimeConnection(OPENROUTER_A1, "acct_alpha_111111");
  const a2 = runtimeConnection(OPENROUTER_A2, "acct_beta_222222");
  const kimi = runtimeConnection(KIMI_CONNECTION,
    options.kimiDefault ? "KIMI_ROUTE_PRIVATE_CANARY" : "acct_kimi_333333", "kimi-code");
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3, revision: 7, lifecycle: options.empty ? "never-configured" : "configured",
    connections: options.empty ? [] : [
      options.nullHealthA1 ? { ...a1, lastHealth: null } : a1,
      a2,
      kimi,
    ],
    defaultRoute: options.empty ? null : options.kimiDefault ? runtimeRoute(kimi, "kimi-for-coding") : runtimeRoute(a1),
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(state);
  let generation = 5;
  let mutations = 0;
  const ensureCalls: RouteIdentityV1[] = [];
  const activationCalls: Array<Record<string, unknown>> = [];
  const credentialCalls: Array<Record<string, unknown>> = [];
  const adapterCalls: string[] = [];
  const refreshCalls: string[] = [];
  let inspectionCalls = 0;
  let catalogCalls = 0;
  let coordinatorCalls = 0;
  let kimiProviderEffects = 0;
  let activeProviderEffects = 0;
  let proofPortCalls = 0;
  let proofSourceHandle: string | undefined;
  let proofCaptureHandles: string[] = [];
  const proofAcceptedHandles: string[] = [];
  const proofCaptureKeys: string[][] = [];
  let signalRouteProof!: () => void;
  let releaseRouteProof!: () => void;
  const routeProofReached = new Promise<void>((resolve) => { signalRouteProof = resolve; });
  const routeProofRelease = new Promise<void>((resolve) => { releaseRouteProof = resolve; });
  const outputSink: string[] = [];
  let signalCredentialReturn!: () => void;
  const credentialReturnReached = new Promise<void>((resolve) => { signalCredentialReturn = resolve; });
  let resolveCredentialReturn: (() => void) | undefined;
  const orchestrator = {
    currentGeneration: () => generation,
    nextStartupGeneration: () => generation + 1,
    ensureRunnableRoute(route?: RouteIdentityV1) {
      const current = route ?? stateStore.read().defaultRoute;
      if (!current) throw new Error("setup required");
      ensureCalls.push(structuredClone(current));
      return structuredClone(current);
    },
    async activateCandidate(request: Record<string, unknown>) {
      if (request.backendId === "kimi-code") { kimiProviderEffects += 1; outputSink.push("KIMI_ROUTE_PRIVATE_CANARY"); }
      activationCalls.push(structuredClone(request));
      const owner = stateStore.read().connections.find((connection) => connection.id === request.targetConnectionId);
      if (!owner || request.backendId !== "openrouter") throw new Error("wrong activation owner");
      const next = runtimeRoute(owner as ReturnType<typeof runtimeConnection>, String(request.expectedRequestedModelId));
      await stateStore.commit(stateStore.read().revision, (current) => ({
        ...current, defaultRoute: next,
      }));
      generation += 1;
      mutations += 1;
      return { persisted: true, route: next, state: stateStore.read(), warnings: [] };
    },
  };
  const authority = {
    async withCredential(
      request: Record<string, unknown>,
      use: (secret: string, context: Record<string, unknown>) => Promise<unknown>,
    ) {
      if (request.backendId === "kimi-code") { kimiProviderEffects += 1; outputSink.push("KIMI_ROUTE_PRIVATE_CANARY"); }
      credentialCalls.push(structuredClone(request));
      const owner = stateStore.read().connections.find((connection) => connection.id === request.connectionId)!;
      const context = {
        binding: {
          version: 2, stateRevision: stateStore.read().revision, connectionId: owner.id,
          backendId: owner.backendId,
          enabled: owner.enabled,
          credentialPointer: requireKeychainCredentialPointer(owner),
          accountFingerprint: owner.accountFingerprint, billingRealm: owner.billingRealm, isDefault: false,
        },
        candidatePermit: { version: 1 }, source: "saved",
        async publishIfCurrent(publish: () => void) { publish(); },
      };
      if (options.deferCredentialEntry) {
        activeProviderEffects += 1;
        try {
          signalCredentialReturn();
          await new Promise<void>((resolve) => { resolveCredentialReturn = resolve; });
        } finally {
          activeProviderEffects -= 1;
        }
      }
      const signal = request.signal as AbortSignal | undefined;
      if (signal?.aborted) throw signal.reason;
      const value = await use("retained-test-secret", context);
      if (options.deferCredentialReturn) {
        activeProviderEffects += 1;
        try {
          signalCredentialReturn();
          await new Promise<void>((resolve) => { resolveCredentialReturn = resolve; });
        } finally {
          activeProviderEffects -= 1;
        }
      }
      return { kind: "available", value };
    },
  };
  let refreshedConnectionId: string | null = null;
  let resolveInspection: (() => void) | undefined;
  let resolveCatalog: (() => void) | undefined;
  let signalInspectionStarted!: () => void;
  let signalCatalogStarted!: () => void;
  let signalCatalogReturned!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => { signalInspectionStarted = resolve; });
  const catalogStarted = new Promise<void>((resolve) => { signalCatalogStarted = resolve; });
  const catalogReturned = new Promise<void>((resolve) => { signalCatalogReturned = resolve; });
  let inspectionSignal: AbortSignal | undefined;
  let catalogSignal: AbortSignal | undefined;
  const refreshAdapter = {
    async inspectUnderAuthorityLease(request: { connectionId: string; signal: AbortSignal }) {
      if (request.connectionId === KIMI_CONNECTION) kimiProviderEffects += 1;
      inspectionCalls += 1;
      refreshCalls.push(request.connectionId);
      refreshedConnectionId = request.connectionId;
      inspectionSignal = request.signal;
      signalInspectionStarted();
      if (options.deferInspection) await new Promise<void>((resolve) => { resolveInspection = resolve; });
      const owner = stateStore.read().connections.find((connection) => connection.id === request.connectionId)!;
      return {
        backendId: "openrouter", connectionId: owner.id, accountFingerprint: owner.accountFingerprint,
        billingRealm: owner.billingRealm, routeEligible: true,
        health: options.deferRouteProof
          ? readyHealth(generation)
          : options.nullHealthA1 && request.connectionId === OPENROUTER_A1
          ? readyHealth(generation)
          : owner.lastHealth,
      };
    },
    async listModels(request: { signal: AbortSignal }) {
      if (refreshedConnectionId === KIMI_CONNECTION) kimiProviderEffects += 1;
      catalogCalls += 1;
      adapterCalls.push("refresh-list-models");
      catalogSignal = request.signal;
      signalCatalogStarted();
      if (options.deferCatalog) await new Promise<void>((resolve) => { resolveCatalog = resolve; });
      signalCatalogReturned();
      const models = refreshedConnectionId === OPENROUTER_A2
        ? options.modelsA2 ?? ["two"]
        : options.refreshedModelsA1 ?? ["refreshed"];
      return models.map((model) => ({
        backendId: "openrouter" as const, requestedModelId: `vendor/${model}`,
        canonicalModelId: `vendor/${model}`, displayName: "Aktualisiert",
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
      }));
    },
  };
  const activationCoordinator = {
    async readAuthority<T>(
      _request: unknown,
      operation: (lease: { assertHeld(): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      coordinatorCalls += 1;
      return operation({ async assertHeld() {} });
    },
  };
  const registry = new BackendRegistry([{
    descriptor: OPENROUTER_DESCRIPTOR,
    adapter: {
      backendId: "openrouter",
      async inspect() { adapterCalls.push("inspect"); throw new Error("not used"); },
      async connect() { adapterCalls.push("connect"); throw new Error("not used"); },
      async listModels() { adapterCalls.push("list-models"); return []; },
      async activate() { adapterCalls.push("activate"); throw new Error("not used"); },
      async reconnect() { adapterCalls.push("reconnect"); throw new Error("not used"); },
      async logout() { adapterCalls.push("logout"); },
      async discardCandidate() {},
    } as never,
  }]);
  const config = { ...structuredClone(DEFAULT_CONFIG), mainModel: state.defaultRoute?.requestedModelId ?? DEFAULT_CONFIG.mainModel, providerSetup: state };
  const runtime = new DefaultProviderRuntime(
    new OpenRouterService(), {} as never, registry, stateStore, orchestrator as never, activationCoordinator as never,
    new SessionProviderRuntimeGuard(), {} as never, null, null, config.mainModel, config,
    undefined, {
      credentialAuthority: authority as never, adapter: refreshAdapter as never, forgetJournal: {} as never, async recover() {},
      ...(options.observeRouteProof || options.deferRouteProof ? {
        async proveActivatedRoutePickerSelection(...args: Parameters<typeof proveActivatedRoutePickerSelection>) {
          proofPortCalls += 1;
          proofAcceptedHandles.push(args[2].routeHandle);
          const isHeldProof = options.deferRouteProof && proofPortCalls === 1;
          if (isHeldProof) {
            proofSourceHandle = args[2].routeHandle;
            signalRouteProof();
            await routeProofRelease;
          }
          const capture = await args[3]();
          proofCaptureKeys.push([...capture.bindings.keys()]);
          if (isHeldProof) proofCaptureHandles = [...capture.bindings.keys()];
          return proveActivatedRoutePickerSelection(args[0], args[1], args[2], () => capture);
        },
      } : {}),
    },
    options.executionMode ?? "local-interactive-owner",
  );

  // Fill the existing runtime-owned cache through its public catalog seam;
  // snapshots themselves must remain passive after this explicit setup work.
  if (options.warmCache !== false) {
    await runtime.runModelCatalog(async () => (options.modelsA1 ?? ["one"]).map(modelInfo));
    if (options.warmSecondAccount !== false) {
      const snapshot = runtime.desktopOnboardingAuthority().snapshot();
      await runtime.desktopOnboardingAuthority().refreshAccount({
        providerId: "openrouter", connectionId: OPENROUTER_A2,
        revision: snapshot.revision, generation: snapshot.generation,
      });
    }
  }

  return {
    runtime, ensureCalls, activationCalls, credentialCalls, adapterCalls, refreshCalls, outputSink,
    providerState: () => stateStore.read(),
    get coordinatorCalls() { return coordinatorCalls; },
    get kimiProviderEffects() { return kimiProviderEffects; },
    get inspectionCalls() { return inspectionCalls; },
    get catalogCalls() { return catalogCalls; },
    get mutations() { return mutations; },
    get activeProviderEffects() { return activeProviderEffects; },
    get proofPortCalls() { return proofPortCalls; },
    get proofSourceHandle() { return proofSourceHandle; },
    get proofCaptureHandles() { return proofCaptureHandles; },
    get proofAcceptedHandles() { return proofAcceptedHandles; },
    get proofCaptureKeys() { return proofCaptureKeys; },
    resetObservedCalls() { ensureCalls.length = 0; activationCalls.length = 0; credentialCalls.length = 0; adapterCalls.length = 0; refreshCalls.length = 0; coordinatorCalls = 0; inspectionCalls = 0; catalogCalls = 0; kimiProviderEffects = 0; mutations = 0; },
    routeFor: (connectionId: string, modelId?: string) => runtimeRoute(connectionId === OPENROUTER_A1 ? a1 : a2, modelId),
    async advanceEpoch() {
      await stateStore.commit(stateStore.read().revision, (current) => ({ ...current }));
      generation += 1;
    },
    async advanceGeneration() { generation += 1; },
    async competingCommit(connectionId: string) {
      const next = runtimeRoute(connectionId === OPENROUTER_A1 ? a1 : a2);
      await stateStore.commit(stateStore.read().revision, (current) => ({ ...current, defaultRoute: next }));
      generation += 1;
    },
    waitForCredentialReturn: () => credentialReturnReached,
    resolveCredentialReturn: () => resolveCredentialReturn?.(),
    waitForRouteProof: () => routeProofReached,
    releaseRouteProof: () => releaseRouteProof(),
    get inspectionSignal() { return inspectionSignal; },
    get catalogSignal() { return catalogSignal; },
    waitForInspection: () => inspectionStarted,
    waitForCatalog: () => catalogStarted,
    waitForCatalogReturn: () => catalogReturned,
    resolveInspection: () => resolveInspection?.(),
    resolveCatalog: () => resolveCatalog?.(),
  };
}

function runtimeConnection(id: string, fingerprint: string, backendId: "openrouter" | "kimi-code" = "openrouter") {
  return {
    id, backendId, enabled: true, maturity: backendId === "openrouter" ? "stable" as const : "preview" as const,
    credentialBinding: { kind: "orcode-keychain" as const, pointer: backendId === "openrouter" ? `v1:inference:${id}` : `v1:kimi-code:${id}` },
    accountFingerprint: fingerprint, accountFingerprintState: "verified" as const,
    billingRealm: backendId === "openrouter" ? "openrouter-payg" as const : "kimi-code-membership-provider-managed-overage" as const,
    lastHealth: readyHealth(5, backendId),
  };
}

class DesktopAuthorityCodexClient implements CodexAccountModelClient {
  readonly #listeners = new Set<(params: unknown) => void>();

  onNotification(_method: "account/updated", listener: (params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.emitAccountUpdated({ authMode: "chatgpt", planType: "pro" });
  }

  emitAccountUpdated(params: unknown): void {
    for (const listener of this.#listeners) listener(params);
  }

  async request<T>(method: string): Promise<T> {
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "private@example.invalid", planType: "pro" },
        requiresOpenaiAuth: true,
      } as T;
    }
    if (method === "model/list") {
      return {
        data: [{
          id: "gpt-5.6-codex", model: "gpt-5.6-codex", displayName: "GPT-5.6 Codex",
          description: "Codex", hidden: false, isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
          inputModalities: ["text", "image"],
        }],
        nextCursor: null,
      } as T;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async drain(): Promise<"closed"> { return "closed"; }
}

function readyHealth(generation: number, backendId: "openrouter" | "kimi-code" | "codex" = "openrouter") {
  return {
    credential: "valid" as const, connectivity: "connected" as const,
    spend: backendId === "openrouter" ? "available" as const : "unknown" as const,
    runtime: "ready" as const, observedAt: 1, generation,
  };
}

function routesFor(
  snapshot: DesktopCapabilitySnapshot,
  connectionId: string,
) {
  return snapshot.providers.filter((provider) => provider.connectionId === connectionId).flatMap((provider) => provider.routes);
}

function runtimeRoute(connection: ReturnType<typeof runtimeConnection>, modelId = "vendor/model"): RouteIdentityV1 {
  return {
    version: 1, backendId: connection.backendId, accountFingerprint: connection.accountFingerprint,
    billingRealm: connection.billingRealm, requestedModelId: modelId, canonicalModelId: modelId, resolutionState: "resolved",
  } as RouteIdentityV1;
}

function modelInfo(id: string): ModelInfo {
  const rich = id === "tools-reasoning";
  return {
    id: `vendor/${id}`, canonicalSlug: `vendor/${id}`, name: `Modell ${id}`, description: "Testmodell",
    contextLength: 1, promptPrice: 0, completionPrice: 0,
    supportedParameters: rich ? ["tools", "reasoning"] : id === "no-tools" ? [] : ["tools"], inputModalities: rich ? ["text", "image"] : ["text"], outputModalities: ["text"],
  };
}

function sameRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.backendId === right.backendId && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId && left.resolutionState === right.resolutionState;
}

const OPENROUTER_A1 = "11111111-1111-4111-8111-111111111111";
const OPENROUTER_A2 = "22222222-2222-4222-8222-222222222222";
const KIMI_CONNECTION = "33333333-3333-4333-8333-333333333333";

function connection(id: string, fingerprint: string, backendId: "openrouter" | "kimi-code" = "openrouter") {
  return {
    id, backendId, enabled: true, maturity: "stable" as const, credentialBinding: { kind: "orcode-keychain" as const, pointer: `private-${id}` },
    accountFingerprint: `private-${fingerprint}`, accountFingerprintState: "verified" as const,
    billingRealm: backendId === "kimi-code"
      ? "kimi-code-membership-provider-managed-overage" as const
      : "openrouter-payg" as const,
    lastHealth: null,
  };
}

function authorityConnection(id: string, backendId: "openrouter" | "kimi-code") {
  const value = connection(id, id, backendId);
  return {
    id: value.id, backendId: value.backendId, enabled: value.enabled,
    maturity: value.maturity, billingRealm: value.billingRealm, lastHealth: value.lastHealth,
  };
}

function route(handle: string, connectionId: string, model: string, providerId: "openrouter" | "kimi-code" = "openrouter") {
  return {
    handle, providerId, connectionId, accountLabel: providerId === "openrouter" ? "Persönliches OpenRouter" : "Kimi Code",
    canonicalModelId: model, displayName: model, reasoning: "unknown" as const, capabilities: ["text"] as const,
    cost: null, dataPolicy: null, runnable: true,
  };
}
