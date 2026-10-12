import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopCapabilitySnapshot, DesktopProviderCapability } from "../src/desktop-contracts.js";
import {
  DesktopOnboardingController,
  type DesktopOnboardingActivation,
  type DesktopOnboardingAuthority,
} from "../src/desktop-onboarding.js";

test("controller sends only an opaque public selection to its onboarding authority", async () => {
  const fixture = fixtureAuthority({ activate: "ready" });
  await selectModel(fixture.controller);
  assert.deepEqual(fixture.activations, [{
    routeHandle: "m-1", providerId: "openrouter", connectionId: "a-1", revision: 3, generation: 2,
  }]);
  assert.doesNotMatch(JSON.stringify(fixture.activations), /candidate|credential|fingerprint|routeIdentity|private/i);
});

test("returns model selection after provider/account choice and rejects stale input", async () => {
  const fixture = fixtureAuthority();
  await fixture.controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: 3, generation: 2 });
  await fixture.controller.dispatch({ kind: "choose-account", connectionId: "a-1", revision: 3, generation: 2 });
  assert.equal(fixture.controller.snapshot().step, "model");
  await assert.rejects(
    fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 2, generation: 2 }),
    /stale/i,
  );
  assert.deepEqual(fixture.activations, []);
});

test("does not publish ready after a delayed activation is superseded", async () => {
  const fixture = fixtureAuthority({ activate: "deferred" });
  await selectSteps(fixture.controller);
  const pending = fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 });
  fixture.setSnapshot(snapshot({ revision: 4, generation: 3, activeRoute: "m-2" }));
  fixture.resolveActivation();
  await assert.rejects(pending, /stale/i);
  assert.notEqual(fixture.controller.snapshot().step, "ready");
});

test("projects authority refusals as error but rejects a mismatched activation result before ready", async () => {
  for (const scenario of ["wrong-account", "disabled"] as const) {
    const fixture = fixtureAuthority({ activate: scenario });
    await selectSteps(fixture.controller);
    const result = await fixture.controller.dispatch({
      kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2,
    });
    assert.equal(result.kind, "view");
    assert.equal(fixture.controller.snapshot().step, "error");
    assert.equal(fixture.controller.snapshot().error?.code, "route-activation-failed");
  }
  const mismatched = fixtureAuthority({ activate: "wrong-result" });
  await selectSteps(mismatched.controller);
  await assert.rejects(
    mismatched.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 }),
    /stale/i,
  );
  assert.notEqual(mismatched.controller.snapshot().step, "ready");
});

test("an activation failure becomes a closed error view and retry reuses the explicit route", async () => {
  const fixture = fixtureAuthority({ activate: "fail-once" });
  await selectSteps(fixture.controller);

  const failed = await fixture.controller.dispatch({
    kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2,
  });
  assert.equal(failed.kind, "view");
  const failedView = fixture.controller.snapshot();
  assert.equal(failedView.step, "error");
  assert.deepEqual(failedView.error, {
    code: "route-activation-failed",
    label: "Modellroute konnte nicht aktiviert werden.",
    recoveryLabel: "Erneut versuchen",
  });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_ACTIVATION_FAILURE/);
  assert.equal(fixture.controller.retryRouteHandle(), "m-1");

  const retried = await fixture.controller.dispatch({ kind: "retry", revision: 3, generation: 2 });
  assert.deepEqual(retried, { kind: "ready", routeHandle: "m-1-rebound", routeRunnable: true });
  assert.deepEqual(fixture.activations, [fixture.activations[0], fixture.activations[0]]);
  assert.equal(fixture.controller.retryRouteHandle(), null);
});

test("a repeated retry failure stays in error while Back and Cancel remain passive", async () => {
  const fixture = fixtureAuthority({ activate: "fail-always" });
  await selectSteps(fixture.controller);
  await fixture.controller.dispatch({
    kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2,
  });

  const retried = await fixture.controller.dispatch({ kind: "retry", revision: 3, generation: 2 });
  assert.equal(retried.kind, "view");
  assert.equal(fixture.controller.snapshot().step, "error");
  assert.equal(fixture.controller.snapshot().error?.code, "route-activation-failed");
  assert.deepEqual(fixture.activations, [fixture.activations[0], fixture.activations[0]]);

  const back = await fixture.controller.dispatch({ kind: "back", revision: 3, generation: 2 });
  assert.equal(back.kind, "view");
  assert.equal(fixture.controller.snapshot().step, "model");
  assert.equal(fixture.controller.retryRouteHandle(), null);
  const cancelled = await fixture.controller.dispatch({ kind: "cancel", revision: 3, generation: 2 });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(fixture.cancelCalls, 1);
  assert.equal(fixture.activations.length, 2);
});

test("permits exactly one explicit model activation while an earlier selection is in flight", async () => {
  const fixture = fixtureAuthority({ activate: "deferred" });
  await selectSteps(fixture.controller);
  const first = fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 });
  const second = fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 });
  fixture.resolveActivation();
  await first;
  await assert.rejects(second, /busy/i);
  assert.equal(fixture.activations.length, 1);
});

test("cancel and opening a picker do not activate a default or first candidate", async () => {
  const fixture = fixtureAuthority();
  const opened = await fixture.controller.dispatch({
    kind: "open-model-picker", returnTo: "model-picker", revision: 3, generation: 2,
  });
  assert.equal(opened.kind, "view");
  assert.equal(fixture.controller.snapshot().step, "provider");
  assert.equal(fixture.controller.snapshot().returnTo, "model-picker");
  assert.deepEqual(fixture.controller.snapshot().candidates, []);
  await assert.rejects(
    fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 }),
    /unavailable/i,
  );
  const result = await fixture.controller.dispatch({ kind: "cancel", revision: 3, generation: 2 });
  assert.equal(result.kind, "cancelled");
  assert.equal(fixture.controller.snapshot().step, "provider");
  assert.deepEqual(fixture.activations, []);
});

test("a runnable route keeps the explicit model picker and its candidates unchanged", async () => {
  const fixture = fixtureAuthority();
  fixture.setSnapshot(snapshot({ activeRoute: "m-1" }));
  const result = await fixture.controller.dispatch({
    kind: "open-model-picker", returnTo: "chat", revision: 3, generation: 2,
  });
  assert.equal(result.kind, "view");
  assert.equal(fixture.controller.snapshot().step, "model");
  assert.deepEqual(
    fixture.controller.snapshot().candidates.map(({ handle }) => handle),
    ["m-1", "m-1-rebound", "m-2"],
  );
});

test("Back from the header model picker opens provider choice without activating a route", async () => {
  const fixture = fixtureAuthority();
  fixture.setSnapshot(snapshot({ activeRoute: "m-1" }));
  await fixture.controller.dispatch({
    kind: "open-model-picker", returnTo: "chat", revision: 3, generation: 2,
  });

  await fixture.controller.dispatch({ kind: "back", revision: 3, generation: 2 });

  assert.equal(fixture.controller.snapshot().step, "provider");
  assert.equal(fixture.controller.snapshot().providerId, undefined);
  assert.deepEqual(fixture.controller.snapshot().candidates, []);
  assert.deepEqual(fixture.activations, []);
});

test("a cancel supersedes an in-flight activation so its late completion cannot publish ready", async () => {
  const fixture = fixtureAuthority({ activate: "deferred" });
  await selectSteps(fixture.controller);
  const pending = fixture.controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 });
  const cancelled = await fixture.controller.dispatch({
    kind: "cancel", revision: 3, generation: 2,
    operationHandle: fixture.controller.snapshot().operationHandle,
  });
  fixture.resolveActivation();

  assert.equal(cancelled.kind, "cancelled");
  await assert.rejects(pending, /cancelled|stale/i);
  assert.notEqual(fixture.controller.snapshot().step, "ready");
});

test("a stale Cancel cannot abort or cancel the current activation epoch", async () => {
  const fixture = fixtureAuthority({ activate: "deferred" });
  fixture.setSnapshot(snapshot({ revision: 4, generation: 3 }));
  await fixture.controller.dispatch({
    kind: "choose-provider", providerId: "openrouter", revision: 4, generation: 3,
  });
  await fixture.controller.dispatch({
    kind: "choose-account", connectionId: "a-1", revision: 4, generation: 3,
  });
  const abort = new AbortController();
  const activation = fixture.controller.dispatch({
    kind: "choose-model", routeHandle: "m-1", revision: 4, generation: 3,
  }, abort.signal);

  await assert.rejects(
    fixture.controller.dispatch({
      kind: "cancel", revision: 3, generation: 2,
      operationHandle: fixture.controller.snapshot().operationHandle,
    }),
    /stale/i,
  );
  assert.equal(abort.signal.aborted, false);
  assert.equal(fixture.cancelCalls, 0);
  assert.equal(fixture.activationSignal, abort.signal);

  fixture.resolveActivation();
  assert.deepEqual(await activation, {
    kind: "ready", routeHandle: "m-1-rebound", routeRunnable: true,
  });
});

test("a Cancel handle from operation A cannot cancel operation B in the same epoch", async () => {
  const fixture = fixtureAuthority({ activate: "deferred-without-commit" });
  await selectSteps(fixture.controller);

  const activationA = fixture.controller.dispatch({
    kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2,
  });
  const operationA = fixture.controller.snapshot().operationHandle;
  assert.equal(typeof operationA, "string");
  const cancelledA = await fixture.controller.dispatch({
    kind: "cancel", revision: 3, generation: 2, operationHandle: operationA,
  });
  fixture.resolveActivation();
  assert.equal(cancelledA.kind, "cancelled");
  assert.equal(cancelledA.view.operationHandle, undefined);
  await assert.rejects(activationA, /cancelled|stale/i);

  await selectSteps(fixture.controller);
  const activationB = fixture.controller.dispatch({
    kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2,
  });
  const operationB = fixture.controller.snapshot().operationHandle;
  assert.equal(typeof operationB, "string");
  assert.notEqual(operationB, operationA);

  await assert.rejects(
    fixture.controller.dispatch({
      kind: "cancel", revision: 3, generation: 2, operationHandle: operationA,
    }),
    /stale/i,
  );
  assert.equal(fixture.cancelCalls, 1);

  const cancelledB = await fixture.controller.dispatch({
    kind: "cancel", revision: 3, generation: 2, operationHandle: operationB,
  });
  fixture.resolveActivation();
  assert.equal(cancelledB.kind, "cancelled");
  assert.equal(cancelledB.view.operationHandle, undefined);
  await assert.rejects(activationB, /cancelled|stale/i);
  assert.equal(fixture.cancelCalls, 2);
});

test("a delayed account refresh cannot resurrect the model view after cancel", async () => {
  const fixture = fixtureAuthority({ refresh: "deferred" });
  await fixture.controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: 3, generation: 2 });
  const pending = fixture.controller.dispatch({ kind: "choose-account", connectionId: "a-1", revision: 3, generation: 2 });
  const cancelled = await fixture.controller.dispatch({
    kind: "cancel", revision: 3, generation: 2,
    operationHandle: fixture.controller.snapshot().operationHandle,
  });
  fixture.resolveRefresh();

  assert.equal(cancelled.kind, "cancelled");
  await assert.rejects(pending, /cancelled/i);
  assert.notEqual(fixture.controller.snapshot().step, "model");
});

test("an aborted account refresh cannot publish a model view after its authority returns", async () => {
  const fixture = fixtureAuthority({ refresh: "deferred" });
  const abort = new AbortController();
  await fixture.controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: 3, generation: 2 });
  const pending = fixture.controller.dispatch(
    { kind: "choose-account", connectionId: "a-1", revision: 3, generation: 2 },
    abort.signal,
  );

  await fixture.waitForRefresh();
  fixture.resolveRefresh();
  abort.abort(new DOMException("window closed", "AbortError"));

  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(fixture.refreshSignal, abort.signal);
  assert.notEqual(fixture.controller.snapshot().step, "model");
});

test("the latest overlapping account refresh owns the model view", async () => {
  const fixture = fixtureAuthority({ refresh: "deferred-by-account" });
  await fixture.controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: 3, generation: 2 });
  const accountA = fixture.controller.dispatch({ kind: "choose-account", connectionId: "a-1", revision: 3, generation: 2 });
  const accountB = fixture.controller.dispatch({ kind: "choose-account", connectionId: "a-2", revision: 3, generation: 2 });

  fixture.resolveRefreshFor("a-2");
  await accountB;
  fixture.resolveRefreshFor("a-1");

  await assert.rejects(accountA, /cancelled|superseded/i);
  assert.equal(fixture.controller.snapshot().step, "model");
  assert.equal(fixture.controller.snapshot().connectionId, "a-2");
  assert.deepEqual(fixture.controller.snapshot().candidates.map((candidate) => candidate.connectionId), ["a-2"]);
});

async function selectSteps(controller: DesktopOnboardingController): Promise<void> {
  await controller.dispatch({ kind: "choose-provider", providerId: "openrouter", revision: 3, generation: 2 });
  await controller.dispatch({ kind: "choose-account", connectionId: "a-1", revision: 3, generation: 2 });
}

test("choose-model forwards the caller's exact abort signal to authority", async () => {
  const fixture = fixtureAuthority();
  await selectSteps(fixture.controller);
  const abort = new AbortController();
  const reason = new Error("owned desktop abort");
  const pending = fixture.controller.dispatch(
    { kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 },
    abort.signal,
  );
  abort.abort(reason);
  await pending;
  assert.equal(fixture.activationSignal, abort.signal);
  assert.equal(fixture.activationSignal?.reason, reason);
});

async function selectModel(controller: DesktopOnboardingController): Promise<void> {
  await selectSteps(controller);
  await controller.dispatch({ kind: "choose-model", routeHandle: "m-1", revision: 3, generation: 2 });
}

function fixtureAuthority(options: {
  activate?: "ready" | "deferred" | "deferred-without-commit" | "wrong-account" | "disabled" | "wrong-result" | "fail-once" | "fail-always";
  refresh?: "deferred" | "deferred-by-account";
} = {}) {
  let current = snapshot();
  const activations: DesktopOnboardingActivation[] = [];
  let resolveActivation: (() => void) | undefined;
  let resolveRefresh: (() => void) | undefined;
  let signalRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { signalRefreshStarted = resolve; });
  let refreshSignal: AbortSignal | undefined;
  let activationSignal: AbortSignal | undefined;
  let cancelCalls = 0;
  const resolveRefreshFor = new Map<string, () => void>();
  const authority: DesktopOnboardingAuthority = {
    snapshot: () => current,
    async refreshAccount(selection, signal) {
      refreshSignal = signal;
      if (options.refresh === "deferred") {
        signalRefreshStarted();
        await new Promise<void>((resolve) => { resolveRefresh = resolve; });
      }
      if (options.refresh === "deferred-by-account") {
        await new Promise<void>((resolve) => { resolveRefreshFor.set(selection.connectionId, resolve); });
      }
      return current;
    },
    async cancelActivation() { cancelCalls += 1; return "none"; },
    async activate(selection, signal) {
      activationSignal = signal;
      activations.push(selection);
      if (options.activate === "fail-always" || (options.activate === "fail-once" && activations.length === 1)) {
        throw new Error("PRIVATE_ACTIVATION_FAILURE");
      }
      if (options.activate === "wrong-account" || options.activate === "disabled") {
        throw new Error("The selected route is unavailable.");
      }
      if (options.activate === "deferred" || options.activate === "deferred-without-commit") {
        await new Promise<void>((resolve) => { resolveActivation = resolve; });
      }
      if (options.activate !== "deferred-without-commit"
        && current.revision === selection.revision && current.generation === selection.generation) {
        current = snapshot({
          revision: selection.revision + 1,
          generation: selection.generation + 1,
          activeRoute: "m-1-rebound",
        });
      }
      return {
        routeHandle: options.activate === "wrong-result" ? "m-2" : "m-1-rebound",
        revision: selection.revision + 1,
        generation: selection.generation + 1,
      };
    },
  };
  return {
    controller: new DesktopOnboardingController({ authority }), activations,
    get refreshSignal() { return refreshSignal; },
    get activationSignal() { return activationSignal; },
    get cancelCalls() { return cancelCalls; },
    setSnapshot: (next: DesktopCapabilitySnapshot) => { current = next; },
    resolveActivation: () => resolveActivation?.(),
    resolveRefresh: () => resolveRefresh?.(),
    waitForRefresh: () => refreshStarted,
    resolveRefreshFor: (connectionId: string) => resolveRefreshFor.get(connectionId)?.(),
  };
}

function snapshot(options: { revision?: number; generation?: number; activeRoute?: "m-1" | "m-2" | "m-1-rebound" } = {}): DesktopCapabilitySnapshot {
  const routes = [route("m-1", "a-1"), route("m-1-rebound", "a-1", "m-1"), route("m-2", "a-2")];
  const active = routes.find((candidate) => candidate.handle === options.activeRoute) ?? null;
  const providerOne: DesktopProviderCapability = {
    providerId: "openrouter", providerLabel: "OpenRouter",
    connectionId: "a-1", accountLabel: "Konto Eins", state: "ready",
    setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: true }, routes: routes.filter((route) => route.connectionId === "a-1"),
  };
  const providerTwo: DesktopProviderCapability = {
    providerId: "openrouter", providerLabel: "OpenRouter",
    connectionId: "a-2", accountLabel: "Konto Zwei", state: "ready",
    setupMethods: ["openrouter-owner-connect"], multiProfile: { enabled: true }, routes: routes.filter((route) => route.connectionId === "a-2"),
  };
  return {
    schemaVersion: 1, revision: options.revision ?? 3, generation: options.generation ?? 2,
    routeRunnable: active !== null, activeRoute: active && {
      routeHandle: active.handle, providerLabel: "OpenRouter", modelLabel: active.displayName, accountLabel: active.accountLabel,
    }, providers: [providerOne, providerTwo], undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  };
}

function route(handle: "m-1" | "m-1-rebound" | "m-2", connectionId: string, canonicalModelId = handle) {
  return {
    handle, providerId: "openrouter", connectionId,
    accountLabel: connectionId === "a-1" ? "Konto Eins" : "Konto Zwei",
    canonicalModelId, displayName: canonicalModelId, reasoning: "supported" as const,
    capabilities: ["text"] as const,
    cost: { kind: "unknown" as const, label: "Kosten unbekannt" as const },
    dataPolicy: { kind: "unknown" as const, label: "Datenrichtlinie unbekannt" as const },
    runnable: true,
  };
}
