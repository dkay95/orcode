import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendRegistry,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderInspection,
} from "../src/backends.js";
import { ProviderStateStore, createNeverConfiguredProviderState } from "../src/provider-state.js";
import { SetupOrchestrator, type SetupEvent } from "../src/setup.js";
import {
  createPlainSetupSurface,
  createTuiSetupSurface,
  runSetupHub,
  type SetupHubEntry,
  type SetupSurface,
} from "../src/setup-ui.js";
import type { ProviderActivationRequest, ProviderActivationResult } from "../src/provider-activation.js";

const OPENROUTER: BackendDescriptor = {
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: { models: true, tools: true, reasoning: true },
};

const ANTHROPIC: BackendDescriptor = {
  id: "anthropic",
  displayName: "Anthropic / Claude-Abo",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: { models: false, tools: false, reasoning: false },
};

const MODEL: BackendModelDescriptor = {
  backendId: "openrouter",
  requestedModelId: "openai/gpt-5",
  canonicalModelId: "openai/gpt-5",
  displayName: "GPT-5",
  capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
};

const CHALLENGER: BackendModelDescriptor = {
  ...MODEL,
  requestedModelId: "openai/gpt-5-mini",
  canonicalModelId: "openai/gpt-5-mini",
  displayName: "GPT-5 mini",
};

class ScriptedSurface implements SetupSurface {
  readonly entries: SetupHubEntry[][] = [];
  readonly events: Array<SetupEvent | { version: 1; type: "notice"; message: string }> = [];
  readonly calls: string[] = [];
  activePrompts = 0;
  maxActivePrompts = 0;

  constructor(
    private readonly hub: Array<string | null>,
    private readonly secrets: Array<string | null> = [],
    private readonly models: Array<string | null> = [],
    private readonly confirms: boolean[] = [],
  ) {}

  async chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null> {
    this.calls.push("hub");
    this.entries.push([...entries]);
    return this.prompt(this.hub.shift() ?? null);
  }

  async readSecret(): Promise<string | null> {
    this.calls.push("secret");
    return this.prompt(this.secrets.shift() ?? null);
  }

  async chooseModel(): Promise<string | null> {
    this.calls.push("model");
    return this.prompt(this.models.shift() ?? null);
  }

  async confirm(): Promise<boolean> {
    this.calls.push("confirm");
    return this.prompt(this.confirms.shift() ?? false);
  }

  present(event: SetupEvent | { version: 1; type: "notice"; message: string }): void {
    this.events.push(structuredClone(event));
  }

  private async prompt<T>(result: T): Promise<T> {
    this.activePrompts += 1;
    this.maxActivePrompts = Math.max(this.maxActivePrompts, this.activePrompts);
    try {
      await Promise.resolve();
      return result;
    } finally {
      this.activePrompts -= 1;
    }
  }
}

class Adapter implements BackendAdapter {
  readonly backendId = "openrouter" as const;
  readonly calls: string[] = [];
  readonly connected: string[] = [];
  readonly rejected = new Set<string>();
  readonly offline = new Set<string>();
  models: readonly BackendModelDescriptor[] = [MODEL];
  connectRequest: Parameters<BackendAdapter["connect"]>[0] | null = null;
  modelRequest: Parameters<BackendAdapter["listModels"]>[0] | null = null;

  async inspect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async reconnect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async logout(): Promise<void> { this.calls.push("logout"); }
  async discardCandidate(): Promise<void> { this.calls.push("discard"); }
  async connect(request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
    this.connectRequest = request;
    this.calls.push("connect");
    this.connected.push(String(request.candidate));
    return {
      candidateId: "candidate",
      backendId: "openrouter",
      connectionId: "connection",
      accountFingerprint: "acct",
      billingRealm: "openrouter-payg",
      health: this.rejected.has(String(request.candidate))
        ? { credential: "rejected", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 1, generation: 1 }
        : this.offline.has(String(request.candidate))
          ? { credential: "valid", connectivity: "offline", spend: "available", runtime: "ready", observedAt: 1, generation: 1 }
        : { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 1, generation: 1 },
    };
  }
  async listModels(request: Parameters<BackendAdapter["listModels"]>[0]): Promise<readonly BackendModelDescriptor[]> {
    this.modelRequest = request;
    this.calls.push("models");
    return this.models;
  }
  async activate(): Promise<CandidateProviderState> { throw new Error("not used"); }
}

function fixture(surface: SetupSurface, options: { processOnlyNullState?: boolean } = {}) {
  const adapter = new Adapter();
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const registry = new BackendRegistry([{ descriptor: OPENROUTER, adapter }, { descriptor: ANTHROPIC }]);
  const activations: ProviderActivationRequest[] = [];
  const activationCoordinator = {
    async activate(request: ProviderActivationRequest): Promise<ProviderActivationResult> {
      activations.push(request);
      const route = {
        version: 1 as const, backendId: "openrouter" as const, accountFingerprint: "acct", billingRealm: "openrouter-payg" as const,
        requestedModelId: request.selectedCanonicalModelId, canonicalModelId: request.selectedCanonicalModelId, resolutionState: "resolved" as const,
      };
      if (options.processOnlyNullState && request.persistence === "process-only") {
        return { persisted: false, warnings: [], state: null, route };
      }
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [{
          id: "connection", backendId: "openrouter", enabled: true, maturity: "stable", credentialSlot: "v1:inference:90000000-0000-4000-8000-000000000002",
          accountFingerprint: "acct", accountFingerprintState: "verified", billingRealm: "openrouter-payg", lastHealth: null,
        }],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }, previous.revision);
      return {
        persisted: request.persistence === "persisted",
        warnings: [],
        state,
        route,
      };
    },
  };
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  return { adapter, stateStore, registry, orchestrator, activations, surface };
}

interface ObservedSetupCancellation {
  reason: unknown;
  expectedRevision?: number;
  expectedGeneration?: number;
}

function observeSetupCancellations(
  orchestrator: SetupOrchestrator,
): ObservedSetupCancellation[] {
  const observed: ObservedSetupCancellation[] = [];
  const original = orchestrator.cancelSetup.bind(orchestrator);
  (orchestrator as SetupOrchestrator & {
    cancelSetup(request?: ObservedSetupCancellation): ReturnType<SetupOrchestrator["cancelSetup"]>;
  }).cancelSetup = async (request?: ObservedSetupCancellation) => {
    observed.push(request ?? { reason: undefined });
    return original(request as never);
  };
  return observed;
}

function assertOneInteractiveCancellation(
  observed: readonly ObservedSetupCancellation[],
  phase: "hub" | "secret" | "model" | "persistence",
): void {
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0]?.reason, {
    code: "provider-setup-cancelled",
    phase,
  });
  assert.equal(observed[0]?.expectedRevision, 0);
}

test("hub connects OpenRouter in secret, model, and explicit persistence order", async () => {
  const surface = new ScriptedSurface(["openrouter", "cross-later"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm", "hub"]);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 1);
  assert.equal(context.activations[0]?.persistence, "persisted");
  assert.equal(context.activations[0]?.selectedCanonicalModelId, MODEL.canonicalModelId);
});

test("automatic setup carries one startup signal generation and target through candidate catalog and activation", async () => {
  const surface = new ScriptedSurface(["openrouter", "cross-later"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);
  const controller = new AbortController();

  const result = await runSetupHub({
    ...context,
    surface,
    signal: controller.signal,
    deadlineAt: 9_000,
    generation: 41,
    targetConnectionId: "connection-startup",
  });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(context.adapter.connectRequest?.signal, controller.signal);
  assert.equal(context.adapter.connectRequest?.generation, 41);
  assert.equal(context.adapter.connectRequest?.connectionId, "connection-startup");
  assert.equal(context.adapter.modelRequest?.signal, controller.signal);
  assert.equal(context.activations[0]?.signal, controller.signal);
  assert.equal(context.activations[0]?.generation, 41);
  assert.equal(context.activations[0]?.targetConnectionId, "connection-startup");
});

test("startup abort revokes a connected candidate even when catalog ignores abort forever", async () => {
  const surface = new ScriptedSurface(["cross-later"]);
  const context = fixture(surface);
  context.adapter.listModels = async (request) => {
    context.adapter.modelRequest = request;
    context.adapter.calls.push("models");
    return new Promise<readonly BackendModelDescriptor[]>(() => undefined);
  };
  const controller = new AbortController();
  void runSetupHub({
    ...context,
    surface,
    environmentSecret: "sk-or-v1-test-key",
    signal: controller.signal,
    deadlineAt: 8_000,
    generation: 42,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(context.adapter.calls, ["connect", "models"]);

  controller.abort(new DOMException("startup timeout", "AbortError"));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
});

test("hub keeps exactly one setup prompt active at a time", async () => {
  const surface = new ScriptedSurface(["openrouter", "cross-later"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(surface.maxActivePrompts, 1);
});

test("hub cancellation publishes exactly one generation-aware cancelled lifecycle", async () => {
  const surface = new ScriptedSurface([null]);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface, generation: 17 });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assertOneInteractiveCancellation(cancellations, "hub");
  assert.equal(cancellations[0]?.expectedGeneration, 17);
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, ["hub"]);
  assert.deepEqual(context.adapter.calls, []);
});

test("secret cancellation publishes exactly one cancelled lifecycle and stops setup", async () => {
  const surface = new ScriptedSurface(["openrouter"], [null]);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assertOneInteractiveCancellation(cancellations, "secret");
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, ["hub", "secret"]);
  assert.deepEqual(context.adapter.calls, []);
});

test("model cancellation publishes exactly one cancelled lifecycle and emits no later setup action", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [null]);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assertOneInteractiveCancellation(cancellations, "model");
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 0);
});

test("persistence cancellation publishes exactly one cancelled lifecycle and emits no later setup action", async () => {
  const surface = new ScriptedSurface(
    ["openrouter"],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId],
    [false],
  );
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assertOneInteractiveCancellation(cancellations, "persistence");
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm"]);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 0);
});

test("caller abort cancellation preserves the exact reason object and performs no later setup action", async () => {
  const reason = new DOMException("exact setup caller cancellation", "AbortError");
  const controller = new AbortController();
  controller.abort(reason);
  const surface = new ScriptedSurface(["openrouter"]);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({
    ...context,
    surface,
    signal: controller.signal,
    generation: 23,
  });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0]?.reason, reason);
  assert.equal(cancellations[0]?.expectedRevision, 0);
  assert.equal(cancellations[0]?.expectedGeneration, 23);
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, []);
  assert.deepEqual(context.adapter.calls, []);
});

test("caller abort settles a pending hub prompt with the exact reason and one cancellation", async () => {
  const reason = new DOMException("exact pending hub cancellation", "AbortError");
  const controller = new AbortController();
  const surface = new ScriptedSurface([]);
  surface.chooseHub = async () => new Promise<string | null>(() => undefined);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);
  const pending = runSetupHub({
    ...context,
    surface,
    signal: controller.signal,
    generation: 29,
  });
  await Promise.resolve();

  controller.abort(reason);
  const notSettled = Symbol("not-settled");
  const result = await Promise.race([
    pending,
    new Promise<typeof notSettled>((resolve) => setImmediate(() => resolve(notSettled))),
  ]);

  assert.notEqual(result, notSettled);
  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0]?.reason, reason);
  assert.equal(cancellations[0]?.expectedGeneration, 29);
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(context.adapter.calls, []);
});

test("stale setup cancellation cannot overwrite a newer committed activation", async () => {
  const surface = new ScriptedSurface([]);
  const context = fixture(surface);
  const before = context.stateStore.read();
  const route = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct_newer_activation",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: MODEL.requestedModelId,
    canonicalModelId: MODEL.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  context.stateStore.replace({
    ...before,
    lifecycle: "configured",
    connections: [{
      id: "newer-activation",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:90000000-0000-4000-8000-000000000099",
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: route,
  }, before.revision);
  const activated = context.stateStore.read();

  await (context.orchestrator.cancelSetup as unknown as (
    request: ObservedSetupCancellation,
  ) => Promise<unknown>)({
    reason: new DOMException("stale cancellation", "AbortError"),
    expectedRevision: before.revision,
    expectedGeneration: 0,
  });

  assert.deepEqual(context.stateStore.read(), activated);
  assert.equal(context.stateStore.read().lifecycle, "configured");
});

test("Cross Escape after committed ready is Later and never cancels setup", async () => {
  const surface = new ScriptedSurface(
    ["openrouter", null],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(cancellations, []);
  assert.equal(context.stateStore.read().lifecycle, "configured");
  assert.equal(context.stateStore.read().cross.enabled, false);
});

test("coming-soon provider explains itself without adapter or activation effects", async () => {
  const surface = new ScriptedSurface(["anthropic", null]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
  assert.match(surface.events.map((event) => "message" in event ? event.message : "").join("\n"), /coming soon/i);
});

test("a non-connectable provider cannot replace an existing default route", async () => {
  const surface = new ScriptedSurface(["anthropic", null]);
  const context = fixture(surface);
  const previous = context.stateStore.read();
  const existing = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: "existing/default",
    canonicalModelId: "existing/default",
    resolutionState: "resolved" as const,
  };
  context.stateStore.replace({
    ...previous,
    lifecycle: "configured",
    connections: [{
      id: "connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:90000000-0000-4000-8000-000000000002",
      accountFingerprint: "acct",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: existing,
  }, previous.revision);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(context.stateStore.read().defaultRoute, existing);
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
});

test("cancel before activation leaves setup required and does not connect", async () => {
  const surface = new ScriptedSurface(["openrouter"], [null]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
});

test("a rejected saved credential offers but does not auto-validate the environment candidate", async () => {
  const saved = "sk-or-v1-saved";
  const environment = "sk-or-v1-environment";
  const surface = new ScriptedSurface(["openrouter", "openrouter:environment", "cross-later"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface);
  context.adapter.rejected.add(saved);

  const result = await runSetupHub({ ...context, surface, savedSecret: saved, environmentSecret: environment });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(context.adapter.connected, [saved, environment]);
  assert.equal(context.activations[0]?.persistence, "process-only");
  assert.equal(surface.entries[1]?.some((entry) => entry.id === "openrouter:environment"), true);
});

test("an environment candidate is automatically process-only only without a saved credential", async () => {
  const surface = new ScriptedSurface(["cross-later"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["model", "hub"]);
  assert.equal(context.activations[0]?.persistence, "process-only");
});

test("cancelling persistence returns setup-required without a second hub prompt", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [false]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm"]);
  assert.equal(context.activations.length, 0);
});

test("cancelling the explicit model choice leaves setup required without an activation", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [null]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 0);
  assert.equal(context.stateStore.read().defaultRoute, null);
});

test("Escape after activation is exactly Later and keeps the committed route with Cross off", async () => {
  const surface = new ScriptedSurface(["openrouter", null], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });
  const state = context.stateStore.read();

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(state.lifecycle, "configured");
  assert.equal(state.defaultRoute?.canonicalModelId, MODEL.canonicalModelId);
  assert.equal(state.cross.enabled, false);
});

test("caller abort during post-activation Cross settles as Later with no late effects", async () => {
  const surface = new ScriptedSurface(
    [],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId, CHALLENGER.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  context.adapter.models = [MODEL, CHALLENGER];
  const cancellations = observeSetupCancellations(context.orchestrator);
  const controller = new AbortController();
  let hubCalls = 0;
  let resolveCross!: (value: string | null) => void;
  let crossStarted!: () => void;
  const reachedCross = new Promise<void>((resolve) => { crossStarted = resolve; });
  surface.chooseHub = async (entries) => {
    surface.calls.push("hub");
    surface.entries.push([...entries]);
    hubCalls += 1;
    if (hubCalls === 1) return "openrouter";
    crossStarted();
    return new Promise<string | null>((resolve) => { resolveCross = resolve; });
  };

  const pending = runSetupHub({ ...context, surface, signal: controller.signal, generation: 31 });
  await reachedCross;
  const activated = context.stateStore.read();
  const reason = new DOMException("post-activation setup caller cancellation", "AbortError");
  controller.abort(reason);
  const notSettled = Symbol("not-settled");
  const result = await Promise.race([
    pending,
    new Promise<typeof notSettled>((resolve) => setImmediate(() => resolve(notSettled))),
  ]);

  assert.notEqual(result, notSettled);
  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(cancellations, []);
  assert.deepEqual(context.stateStore.read(), activated);

  resolveCross("cross-prepare");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(context.stateStore.read(), activated);
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm", "hub"]);
});

test("prepare roles stores distinct resolved models while Cross remains off and starts no collaboration", async () => {
  const surface = new ScriptedSurface(
    ["openrouter", "cross-prepare"],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId, CHALLENGER.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  context.adapter.models = [MODEL, CHALLENGER];

  const result = await runSetupHub({ ...context, surface });
  const state = context.stateStore.read();

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(state.cross.enabled, false);
  assert.equal(state.cross.preferredLead?.canonicalModelId, MODEL.canonicalModelId);
  assert.equal(state.cross.preferredChallenger?.canonicalModelId, CHALLENGER.canonicalModelId);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
});

test("prepare roles rejects a second realm that resolves to the current canonical model", async () => {
  const surface = new ScriptedSurface(
    ["openrouter", "cross-prepare"],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  context.adapter.models = [{ ...MODEL, requestedModelId: "alias/gpt-5", displayName: "GPT-5 alias" }];

  const result = await runSetupHub({ ...context, surface });
  const state = context.stateStore.read();

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm", "hub"]);
  assert.equal(state.cross.enabled, false);
  assert.equal(state.cross.preferredLead, null);
  assert.equal(state.cross.preferredChallenger, null);
  assert.match(surface.events.map((event) => "message" in event ? event.message : "").join("\n"), /unterschiedliche vollständig aufgelöste Modelle/i);
});

test("invalid secret bytes never reach an adapter or presentation event", async () => {
  const secret = `invalid\0${"x".repeat(20)}`;
  const surface = new ScriptedSurface(["openrouter", null], [secret]);
  const context = fixture(surface);

  await runSetupHub({ ...context, surface });

  assert.deepEqual(context.adapter.calls, []);
  assert.equal(JSON.stringify(surface.events).includes(secret), false);
});

test("a process-only activation with null durable state keeps Later ready without inventing persistence", async () => {
  const surface = new ScriptedSurface(["cross-later"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface, { processOnlyNullState: true });

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(context.stateStore.read().defaultRoute, null);
  assert.equal(context.activations[0]?.persistence, "process-only");
});

test("process-only role preparation sees the transient route but leaves durable state untouched", async () => {
  const surface = new ScriptedSurface(
    ["cross-prepare"],
    [],
    [MODEL.canonicalModelId, CHALLENGER.canonicalModelId],
  );
  const context = fixture(surface, { processOnlyNullState: true });
  context.adapter.models = [MODEL, CHALLENGER];

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.equal(result.kind, "ready");
  assert.equal(result.preparedRoles?.lead.canonicalModelId, MODEL.canonicalModelId);
  assert.equal(result.preparedRoles?.challenger.canonicalModelId, CHALLENGER.canonicalModelId);
  assert.deepEqual(surface.calls, ["model", "hub", "model"]);
  assert.equal(context.stateStore.read().defaultRoute, null);
});

test("offline saved credential stays authoritative and never exposes environment fallback", async () => {
  const saved = "sk-or-v1-saved";
  const environment = "sk-or-v1-environment";
  const surface = new ScriptedSurface(["openrouter", null]);
  const context = fixture(surface);
  context.adapter.offline.add(saved);

  const result = await runSetupHub({ ...context, surface, savedSecret: saved, environmentSecret: environment });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(context.adapter.connected, [saved]);
  assert.equal(surface.entries[1]?.some((entry) => entry.id === "openrouter:environment"), false);
});

test("runSetupHub retry through the plain adapter replaces the error with one current revision", async () => {
  const prompts: string[] = [];
  const selections = ["openrouter", "openrouter", MODEL.canonicalModelId, "cross-later"];
  const passwords = ["offline-key", "working-key"];
  const surface = createPlainSetupSurface({
    async select(request: { message: string }) { prompts.push(request.message); return selections.shift()!; },
    async password() { return passwords.shift()!; },
    async confirm() { return true; },
  } as never);
  const context = fixture(surface);
  context.adapter.offline.add("offline-key");

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.match(prompts[1] ?? "", /nicht bestätigen/i);
  assert.match(prompts.at(-1) ?? "", new RegExp(`OpenRouter.*Aktuell r${context.stateStore.read().revision}`));
  assert.match(prompts.at(-1) ?? "", /Anthropic \/ Claude-Abo.*Coming soon/);
  assert.doesNotMatch(prompts.at(-1) ?? "", /nicht bestätigen/i);
  assert.equal((prompts.at(-1)?.match(/Aktuell r/g) ?? []).length, 1);
});

test("runSetupHub success through the TUI adapter presents one current provider card before Cross", async () => {
  const cards: string[] = [];
  const status: string[] = [];
  const choices = ["openrouter", "cross-later"];
  const surface = createTuiSetupSurface({
    async pickChoice(_title, items) {
      const choice = choices.shift();
      return items.find((item) => item.value === choice) ?? null;
    },
    async readSecret() { return "sk-or-v1-test-key"; },
    async pickModel(search) { return search("")[0] ?? null; },
    async confirmAction() { return { accepted: true }; },
    addMessage(_role, content) { cards.push(content); },
    setStatus(message) { status.push(message); },
  });
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(cards.length, 1);
  assert.match(cards[0] ?? "", new RegExp(`OpenRouter.*Aktuell r${context.stateStore.read().revision}`));
  assert.match(cards[0] ?? "", /Anthropic \/ Claude-Abo.*Coming soon/);
  assert.equal((cards[0]?.match(/Aktuell r/g) ?? []).length, 1);
  assert.doesNotMatch(cards[0] ?? "", /nicht bestätigt|erneut versuchen/i);
  assert.doesNotMatch(status.at(-1) ?? "", /nicht bestätigt|erneut versuchen/i);
});

test("process-only Prepare roles returns only safe session routes without durable mutation", async () => {
  const surface = new ScriptedSurface(
    ["cross-prepare"],
    [],
    [MODEL.canonicalModelId, CHALLENGER.canonicalModelId],
  );
  const context = fixture(surface, { processOnlyNullState: true });
  context.adapter.models = [MODEL, CHALLENGER];

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, {
    kind: "ready",
    preparedRoles: {
      lead: {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: "acct",
        billingRealm: "openrouter-payg",
        requestedModelId: MODEL.requestedModelId,
        canonicalModelId: MODEL.canonicalModelId,
        resolutionState: "resolved",
      },
      challenger: {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: "acct",
        billingRealm: "openrouter-payg",
        requestedModelId: CHALLENGER.requestedModelId,
        canonicalModelId: CHALLENGER.canonicalModelId,
        resolutionState: "resolved",
      },
    },
  });
  assert.equal(context.stateStore.read().defaultRoute, null);
  assert.equal(context.stateStore.read().cross.preferredLead, null);
});

test("explicit runnable model replacement changes an existing default only through one activation transaction", async () => {
  const surface = new ScriptedSurface(["openrouter", "cross-later"], ["sk-or-v1-test-key"], [CHALLENGER.canonicalModelId], [true]);
  const context = fixture(surface);
  const previous = context.stateStore.read();
  const existing = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: MODEL.requestedModelId,
    canonicalModelId: MODEL.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  context.stateStore.replace({
    ...previous,
    lifecycle: "configured",
    connections: [{
      id: "connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialSlot: "v1:inference:90000000-0000-4000-8000-000000000002",
      accountFingerprint: "acct",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: existing,
  }, previous.revision);
  context.adapter.models = [MODEL, CHALLENGER];

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(context.activations.length, 1);
  assert.equal(context.activations[0]?.selectedCanonicalModelId, CHALLENGER.canonicalModelId);
  assert.equal(context.stateStore.read().defaultRoute?.canonicalModelId, CHALLENGER.canonicalModelId);
});
