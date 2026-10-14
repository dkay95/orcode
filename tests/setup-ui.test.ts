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
import {
  ProviderStateStore,
  createNeverConfiguredProviderState,
  requireKeychainCredentialPointer,
} from "../src/provider-state.js";
import { SetupOrchestrator } from "../src/setup.js";
import {
  createPlainSetupSurface,
  createTuiSetupSurface,
  runSetupHub,
  setupModelRowLabel,
  type SetupHubEntry,
  type SetupPresentation,
  type SetupSurface,
} from "../src/setup-surface/index.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ProviderActivationRequest, ProviderActivationResult } from "../src/provider-activation.js";
import { KimiDesktopPermitReader } from "../src/kimi-desktop-permit.js";
import { desktopNativeKimiExecutionOrigin, isDesktopKimiRuntimeCapability } from "../src/kimi-execution-origin.js";
import {
  NativeSidecarChannel,
  decodeActionFrame,
  encodeControlFrame,
  type KimiNativeActionRecord,
  type KimiNativeActionRequest,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";
import { createAttestedDesktopKimiFixture } from "./kimi-desktop-capability-fixture.js";

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
  displayName: "Anthropic / Claude subscription",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: { models: false, tools: false, reasoning: false },
};

const KIMI: BackendDescriptor = {
  id: "kimi-code",
  displayName: "Kimi Code",
  maturity: "preview",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "provider-managed",
  capabilities: { models: true, tools: true, reasoning: true },
};

const KIMI_MODELS: readonly BackendModelDescriptor[] = [
  ["k3", "Kimi K3"],
  ["k3-256k", "Kimi K3 256K"],
  ["kimi-for-coding", "Kimi K2.7 Code"],
  ["kimi-for-coding-highspeed", "Kimi K2.7 Code HighSpeed"],
].map(([id, displayName]) => ({
  backendId: "kimi-code" as const,
  requestedModelId: id!,
  canonicalModelId: id!,
  displayName: displayName!,
  capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
}));

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

/**
 * OpenRouter's automatic router exactly as its catalog publishes it: no
 * input/output modalities and no supported parameters. It is nonetheless the
 * model a fresh install ships with (`DEFAULT_CONFIG.mainModel`) and the row
 * `/model` ranks first — the capability triple says nothing about it.
 */
const AUTOMATIC_MODEL: BackendModelDescriptor = {
  backendId: "openrouter",
  requestedModelId: "openrouter/auto",
  canonicalModelId: "openrouter/auto",
  displayName: "Auto",
  capabilities: { textInput: false, textOutput: false, tools: false, reasoning: false },
};

class ScriptedSurface implements SetupSurface {
  readonly entries: SetupHubEntry[][] = [];
  readonly events: SetupPresentation[] = [];
  readonly calls: string[] = [];
  readonly modelRequests: Array<{
    backendId: BackendDescriptor["id"];
    models: readonly BackendModelDescriptor[];
  }> = [];
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

  async chooseModel(request: {
    backendId: BackendDescriptor["id"];
    models: readonly BackendModelDescriptor[];
  }): Promise<string | null> {
    this.calls.push("model");
    this.modelRequests.push(structuredClone(request));
    return this.prompt(this.models.shift() ?? null);
  }

  async confirm(): Promise<boolean> {
    this.calls.push("confirm");
    return this.prompt(this.confirms.shift() ?? false);
  }

  present(event: SetupPresentation): void {
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
  connectObservedAt: number | null = null;
  modelRequest: Parameters<BackendAdapter["listModels"]>[0] | null = null;

  async inspect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async reconnect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async logout(): Promise<void> { this.calls.push("logout"); }
  async discardCandidate(): Promise<void> { this.calls.push("discard"); }
  async connect(request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
    this.connectObservedAt = Date.now();
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

function nanoSetupFixture(surface: ScriptedSurface, mode: "subscription" | "payg") {
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const nanoModel: BackendModelDescriptor = { ...MODEL, backendId: "nano-gpt", requestedModelId: "vendor/manual", canonicalModelId: "vendor/manual" };
  const nano: BackendAdapter = {
    backendId: "nano-gpt",
    async connect(request) {
      assert.deepEqual(request.candidate, { apiKey: "fixture-nano-key", billingMode: mode });
      return { candidateId: "nano-candidate", backendId: "nano-gpt", connectionId: "nano-main", accountFingerprint: "acct_nano_fixture", billingRealm: mode === "subscription" ? "nanogpt-subscription" : "nanogpt-payg", health: { credential: "valid", connectivity: "connected", spend: "unknown", runtime: "not-applicable", observedAt: 1, generation: request.generation } };
    },
    async listModels() { return [nanoModel, MODEL]; },
    async discardCandidate() {}, async logout() {},
    async inspect() { throw new Error("unused"); }, async reconnect() { throw new Error("unused"); }, async activate() { throw new Error("unused"); },
  };
  const registry = new BackendRegistry([{ descriptor: { ...KIMI, id: "nano-gpt", displayName: "Nano-GPT" }, adapter: nano }]);
  const activations: ProviderActivationRequest[] = [];
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator: { async activate(request) {
    activations.push(request);
    const route = { version: 1 as const, backendId: "nano-gpt" as const, accountFingerprint: "acct_nano_fixture", billingRealm: mode === "subscription" ? "nanogpt-subscription" as const : "nanogpt-payg" as const, requestedModelId: request.expectedRequestedModelId, canonicalModelId: request.selectedCanonicalModelId, resolutionState: "resolved" as const };
    const previous = stateStore.read();
    const id = request.targetConnectionId ?? "nano-main";
    const state = stateStore.replace({ ...previous, lifecycle: "configured", connections: [...previous.connections.filter((connection) => connection.id !== id), { id, backendId: "nano-gpt", maturity: "preview", enabled: true, credentialBinding: { kind: "orcode-keychain", pointer: "v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" }, accountFingerprint: route.accountFingerprint, accountFingerprintState: "verified", billingRealm: route.billingRealm, lastHealth: null }], defaultRoute: route }, previous.revision);
    return { persisted: true, route, state, warnings: [] };
  } } });
  return { surface, registry, stateStore, orchestrator, activations };
}

function retainNanoSetupMode(fixture: ReturnType<typeof nanoSetupFixture>, mode: "subscription" | "payg") {
  const previous = fixture.stateStore.read();
  const connection = { id: `nano-${mode}-existing`, backendId: "nano-gpt" as const, maturity: "preview" as const, enabled: true, credentialBinding: { kind: "orcode-keychain" as const, pointer: `v1:nano-gpt:018f8d77-2d52-7cc0-8f6a-9fb1f3fc07${mode === "subscription" ? "12" : "13"}` }, accountFingerprint: `acct_nano_${mode}_existing`, accountFingerprintState: "verified" as const, billingRealm: mode === "subscription" ? "nanogpt-subscription" as const : "nanogpt-payg" as const, lastHealth: null };
  fixture.stateStore.replace({ ...previous, lifecycle: "configured", connections: [...previous.connections, connection] }, previous.revision);
  return connection;
}

test("Nano-GPT adding PAYG preserves the saved subscription connection instead of replacing it", async () => {
  const surface = new ScriptedSurface(["nano-gpt", "nano-gpt:payg"], ["fixture-nano-key"], ["vendor/manual"]);
  const fixture = nanoSetupFixture(surface, "payg");
  const subscription = retainNanoSetupMode(fixture, "subscription");
  assert.deepEqual(await runSetupHub(fixture), { kind: "ready" });
  assert.equal(fixture.activations[0]?.targetConnectionId, undefined);
  assert.deepEqual(fixture.stateStore.read().connections.find((connection) => connection.id === subscription.id), subscription);
  assert.equal(fixture.stateStore.read().connections.length, 2);
});

test("Nano-GPT cannot replace a subscription owner through an explicit PAYG target", async () => {
  const surface = new ScriptedSurface(["nano-gpt", "nano-gpt:payg"], ["fixture-nano-key"], ["vendor/manual"]);
  const fixture = nanoSetupFixture(surface, "payg");
  const subscription = retainNanoSetupMode(fixture, "subscription");
  assert.deepEqual(await runSetupHub({ ...fixture, targetConnectionId: subscription.id }), { kind: "cancelled", mode: "setup-required" });
  assert.equal(fixture.activations.length, 0);
  assert.deepEqual(surface.calls, ["hub", "hub"]);
});

for (const mode of ["subscription", "payg"] as const) {
  test(`Nano-GPT with both saved billing modes replaces only the selected ${mode} connection`, async () => {
    const surface = new ScriptedSurface(["nano-gpt", `nano-gpt:${mode}`], ["fixture-nano-key"], ["vendor/manual"]);
    const fixture = nanoSetupFixture(surface, mode);
    const subscription = retainNanoSetupMode(fixture, "subscription");
    const payg = retainNanoSetupMode(fixture, "payg");
    assert.deepEqual(await runSetupHub(fixture), { kind: "ready" });
    assert.equal(fixture.activations[0]?.targetConnectionId, mode === "subscription" ? subscription.id : payg.id);
    const untouched = mode === "subscription" ? payg : subscription;
    assert.deepEqual(fixture.stateStore.read().connections.find((connection) => connection.id === untouched.id), untouched);
    assert.equal(fixture.stateStore.read().connections.length, 2);
  });
}

for (const mode of ["subscription", "payg"] as const) {
  test(`Nano-GPT setup requires explicit ${mode} billing before key and manual model selection`, async () => {
    const surface = new ScriptedSurface(["nano-gpt", `nano-gpt:${mode}`], ["fixture-nano-key"], ["vendor/manual"]);
    const fixture = nanoSetupFixture(surface, mode);
    const result = await runSetupHub(fixture);
    assert.deepEqual(result, { kind: "ready" });
    assert.deepEqual(surface.calls, ["hub", "hub", "secret", "model"]);
    assert.equal(surface.entries[0]![0]?.label, "Nano-GPT");
    assert.deepEqual(surface.entries[1]!.map((entry) => entry.id), ["nano-gpt:subscription", "nano-gpt:payg"]);
    assert.equal(surface.modelRequests[0]?.backendId, "nano-gpt");
    assert.deepEqual(surface.modelRequests[0]?.models.map((model) => model.canonicalModelId), ["vendor/manual"]);
    assert.equal(fixture.activations.length, 1);
    assert.equal(fixture.activations[0]?.billingMode, mode);
    assert.equal(fixture.activations[0]?.candidate, "fixture-nano-key");
    assert.equal(fixture.activations[0]?.persistence, "persisted");
    assert.equal(fixture.activations[0]?.environmentEligibility, "forbidden");
  });
}

test("Nano-GPT setup cancelled at billing choice reads no secret and activates nothing", async () => {
  const surface = new ScriptedSurface(["nano-gpt", null, null]);
  const fixture = nanoSetupFixture(surface, "subscription");
  assert.deepEqual(await runSetupHub(fixture), { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub", "hub", "hub"]);
  assert.equal(fixture.activations.length, 0);
});

test("an explicit Nano-GPT setup selection cannot be preempted by OpenRouter environment discovery", async () => {
  const surface = new ScriptedSurface(["nano-gpt:subscription"], ["fixture-nano-key"], ["vendor/manual"]);
  const fixture = nanoSetupFixture(surface, "subscription");
  const foreign = new Adapter();
  const registry = new BackendRegistry([{ descriptor: { ...KIMI, id: "nano-gpt", displayName: "Nano-GPT" }, adapter: fixture.registry.adapter("nano-gpt") }, { descriptor: OPENROUTER, adapter: foreign }]);
  assert.deepEqual(await runSetupHub({ ...fixture, registry, initialBackendId: "nano-gpt", environmentSecret: "fixture-foreign-openrouter-env" }), { kind: "ready" });
  assert.deepEqual(foreign.calls, []);
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.equal(fixture.activations.length, 1);
  assert.equal(fixture.activations[0]?.backendId, "nano-gpt");
});

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
          id: "connection", backendId: "openrouter", enabled: true, maturity: "stable", credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
          accountFingerprint: "acct", accountFingerprintState: "verified", billingRealm: "openrouter-payg", lastHealth: null,
        }],
        defaultRoute: route,
        cross: structuredClone(previous.cross),
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
  return {
    adapter,
    stateStore,
    registry,
    orchestrator,
    activations,
    surface,
    executionMode: "local-interactive-owner" as const,
  };
}

class KimiSetupAdapter implements BackendAdapter {
  readonly backendId = "kimi-code" as const;
  readonly calls: string[] = [];
  readonly candidates: string[] = [];
  readonly connectRequests: Array<Parameters<BackendAdapter["connect"]>[0]> = [];
  models: readonly BackendModelDescriptor[] = KIMI_MODELS;
  rejectNext = false;

  async inspect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async reconnect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async logout(): Promise<void> { this.calls.push("logout"); }
  async discardCandidate(): Promise<void> { this.calls.push("discard"); }
  async connect(request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
    this.calls.push("connect");
    this.candidates.push(String(request.candidate));
    this.connectRequests.push(request);
    return {
      candidateId: "candidate-kimi-setup",
      backendId: "kimi-code",
      connectionId: request.connectionId ?? "kimi-setup-connection",
      accountFingerprint: "acct_kimi_setup",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      health: {
        credential: this.rejectNext ? "rejected" : "valid",
        connectivity: "connected",
        spend: "unknown",
        runtime: "not-applicable",
        observedAt: 1,
        generation: request.generation,
      },
    };
  }
  async listModels(): Promise<readonly BackendModelDescriptor[]> {
    this.calls.push("models");
    return structuredClone(this.models);
  }
  async activate(): Promise<CandidateProviderState> { throw new Error("not used"); }
}

function kimiSetupFixture(
  surface: SetupSurface,
  options: { existing?: boolean } = {},
) {
  const openRouter = new Adapter();
  const kimi = new KimiSetupAdapter();
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  if (options.existing) {
    const current = stateStore.read();
    stateStore.replace({
      ...current,
      lifecycle: "configured",
      connections: [{
        id: "kimi-existing",
        backendId: "kimi-code",
        enabled: true,
        maturity: "preview",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711" },
        accountFingerprint: "acct_kimi_existing",
        accountFingerprintState: "verified",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        lastHealth: null,
      }],
      defaultRoute: {
        version: 1,
        backendId: "kimi-code",
        accountFingerprint: "acct_kimi_existing",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        requestedModelId: "k3",
        canonicalModelId: "k3",
        resolutionState: "resolved",
      },
      cross: { enabled: false, preferredLead: null, preferredChallenger: null },
    }, current.revision);
  }
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER, adapter: openRouter },
    { descriptor: KIMI, adapter: kimi },
    { descriptor: ANTHROPIC },
  ]);
  const activations: ProviderActivationRequest[] = [];
  const activationCoordinator = {
    async activate(request: ProviderActivationRequest): Promise<ProviderActivationResult> {
      activations.push(request);
      const route = {
        version: 1 as const,
        backendId: "kimi-code" as const,
        accountFingerprint: "acct_kimi_setup",
        billingRealm: "kimi-code-membership-provider-managed-overage" as const,
        requestedModelId: request.expectedRequestedModelId,
        canonicalModelId: request.selectedCanonicalModelId,
        resolutionState: "resolved" as const,
      };
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [{
          id: request.targetConnectionId ?? "kimi-setup-connection",
          backendId: "kimi-code",
          enabled: true,
          maturity: "preview",
          credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0712" },
          accountFingerprint: route.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: route.billingRealm,
          lastHealth: null,
        }],
        defaultRoute: route,
        cross: structuredClone(previous.cross),
      }, previous.revision);
      return { persisted: true, warnings: [], state, route };
    },
  };
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  const permits: object[] = [];
  const released: object[] = [];
  const authorityCalls: Array<Record<string, unknown>> = [];
  const withManualKimiCandidateAuthority = async <T>(
    request: Record<string, unknown>,
    use: (
      candidate: string,
      lease: { assertHeld(): Promise<void>; assertCurrent(): Promise<void> },
    ) => Promise<{ candidate: ProviderCandidate; value: T }>,
  ) => {
    authorityCalls.push(request);
    if (request.expectedRevision !== stateStore.read().revision) {
      return { kind: "stale" as const };
    }
    const normalized = String(request.candidate).trim();
    const observed = await use(normalized, {
      async assertHeld() {},
      async assertCurrent() {},
    });
    if (
      observed.candidate.backendId !== "kimi-code"
      || observed.candidate.health.credential !== "valid"
      || observed.candidate.health.connectivity !== "connected"
    ) return { kind: "stale" as const };
    const permit = Object.freeze({ version: 1 as const });
    permits.push(permit);
    return { kind: "ready" as const, value: { value: observed.value, candidatePermit: permit } };
  };
  const releaseManualKimiCandidatePermit = (permit: object) => { released.push(permit); };
  return {
    surface,
    openRouter,
    kimi,
    stateStore,
    registry,
    orchestrator,
    activations,
    authorityCalls,
    permits,
    released,
    executionMode: "local-interactive-owner" as const,
    withManualKimiCandidateAuthority,
    releaseManualKimiCandidatePermit,
  };
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

// FIX-12: the hub used to end with two rows whose entire content was that
// they could not be used — "Codex · Coming soon is not selectable" and the
// same line for Anthropic. The Codex row is gone outright: `codex` has no
// descriptor to speak for (`BackendRegistry`'s constructor throws on any
// attempt to register it), so the row was fabricated to announce that
// nothing was coming. The Anthropic row stays — it is a real registered
// descriptor and the place an owner hunting for Claude looks — but says
// what is true instead of promising a backend the registry forbids and
// nobody is building. The Kimi row's "· OAuth coming soon" goes for the
// same reason: no OAuth implementation exists for any backend.
test("the setup hub connects what it can and redirects the one backend it cannot", async () => {
  const surface = new ScriptedSurface([null]);
  const context = kimiSetupFixture(surface);

  await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(surface.entries[0]?.map(({ id, label, description, disabled }) => ({
    id,
    label,
    description,
    disabled,
  })), [
    {
      id: "openrouter",
      label: "OpenRouter",
      description: "API key · Pay as you go · Many models",
      disabled: false,
    },
    {
      id: "kimi-code",
      label: "Kimi Code membership",
      description: "Membership key · Provider-managed limits",
      disabled: false,
    },
    {
      id: "anthropic",
      label: "Anthropic / Claude",
      description: "Not available as a direct backend — Claude models run today via OpenRouter.",
      disabled: true,
    },
  ]);
  const rendered = surface.entries[0]!.map((entry) => `${entry.label} ${entry.description}`).join("\n");
  assert.doesNotMatch(rendered, /coming soon/i);
  assert.doesNotMatch(rendered, /codex/i);
  assert.doesNotMatch(rendered, /oauth/i);
});

// F7 (ruling 2): Kimi has exactly one real auth method, so its disabled
// "Sign in with Kimi" OAuth choice is no longer its own picker step — there
// is no `chooseAuthenticationMethod` call left in the flow at all (the
// fixture above already pins the fold's inline annotation on the hub row
// itself). This replaces the old picker-driven "hostile oauth-coming-soon
// return" test, whose premise (a value to return from a picker that no
// longer exists) is gone with the picker.
test("Kimi's disabled OAuth is an inline hub-row annotation, not a picker step", async () => {
  const surface = new ScriptedSurface(["kimi-code"], ["fixture-kimi-membership-key"], ["k3"]);
  const context = kimiSetupFixture(surface);

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "ready" });
  // No "authentication" entry anywhere in the call trace: the flow goes
  // straight from the hub row to the secret prompt.
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.equal(surface.calls.includes("authentication"), false);
});

test("Kimi membership setup discloses third-party billing before the secret, normalizes inside authority, and returns ready without Cross onboarding", async () => {
  const selected = "kimi-for-coding-highspeed";
  const raw = "\r\n  fixture-kimi-membership-key-not-real  \n";
  const surface = new ScriptedSurface(
    ["kimi-code"],
    [raw],
    [selected],
  );
  const context = kimiSetupFixture(surface);

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "ready" });
  // F7 (ruling 2): no "authentication" step — the flow goes straight from
  // the hub row to the secret prompt.
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.match(
    surface.events.map((event) => "message" in event ? event.message : "").join("\n"),
    /membership key.*third-party integration.*provider-managed limits.*paid Extra Usage may apply/is,
  );
  assert.deepEqual(context.authorityCalls.map((request) => ({
    backendId: request.backendId,
    candidate: request.candidate,
    expectedRevision: request.expectedRevision,
    generation: request.generation,
    purpose: request.purpose,
  })), [{
    backendId: "kimi-code",
    candidate: raw,
    expectedRevision: 0,
    generation: 1,
    purpose: "initial-setup",
  }]);
  assert.deepEqual(context.kimi.candidates, ["fixture-kimi-membership-key-not-real"]);
  assert.deepEqual(surface.modelRequests[0], {
    backendId: "kimi-code",
    models: KIMI_MODELS,
  });
  assert.equal(context.activations.length, 1);
  const activation = context.activations[0] as ProviderActivationRequest & Record<string, unknown>;
  assert.equal(activation.backendId, "kimi-code");
  assert.equal(activation.persistence, "persisted");
  assert.equal(activation.environmentEligibility, "forbidden");
  assert.equal(activation.requireCandidatePermit, true);
  assert.equal(activation.candidatePermit, context.permits[0]);
  assert.equal(activation.targetConnectionId, "kimi-setup-connection");
  assert.equal(activation.selectedCanonicalModelId, selected);
  assert.equal(activation.candidateAuthorityPurpose, "initial-setup");
  assert.equal(context.released.length, 1);
  assert.equal(context.released[0], context.permits[0]);
  assert.equal(context.stateStore.read().cross.enabled, false);
  assert.equal(context.stateStore.read().defaultRoute?.backendId, "kimi-code");
  assert.equal(context.stateStore.read().defaultRoute?.canonicalModelId, selected);
  assert.equal("preparedRoles" in result, false);
});

test("desktop Kimi setup denial settles before secret, provider deadline, authority, or adapter effects", async () => {
  const actions: KimiNativeActionRequest[] = [];
  const requirements: unknown[] = [];
  const desktop = await createAttestedDesktopKimiFixture({ generation: 77, now: () => 1_000,
    emitRequirement(requirement: unknown) { requirements.push(structuredClone(requirement)); },
    onAction(action) {
      actions.push(action);
      return {
        kind: "denied",
        requestId: action.requestId,
        sessionId: action.sessionId,
        childPid: action.childPid,
        revision: action.revision,
        generation: action.generation,
        deadlineAt: action.deadlineAt,
      };
    },
  });
  const surface = new ScriptedSurface(["kimi-code"], ["must-not-be-read"], ["k3"]);
  const context = kimiSetupFixture(surface);
  let providerDeadlines = 0;

  const result = await runSetupHub({
    ...context,
    surface,
    executionMode: "piped",
    kimiExecutionOrigin: desktopNativeKimiExecutionOrigin(desktop.permitReader),
    kimiDesktopSetupContext: {
      sessionId: "desktop-session",
      childPid: process.pid,
      setupId: "desktop-setup",
    },
    desktopKimiCapability: desktop.capability,
    resolveProviderDeadline() {
      providerDeadlines += 1;
      return 90_000;
    },
  } as never);

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub"]);
  assert.equal(providerDeadlines, 0);
  assert.deepEqual(context.authorityCalls, []);
  assert.deepEqual(context.kimi.calls, []);
  assert.deepEqual(context.activations, []);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    kind: "kimi-setup",
    requestId: actions[0]!.requestId,
    sessionId: "desktop-session",
    childPid: process.pid,
    setupId: "desktop-setup",
    provider: "kimi-code",
    operation: "initial-setup",
    revision: 0,
    generation: 77,
    deadlineAt: 61_000,
  });
  assert.deepEqual(requirements, [{
    kind: "kimi-setup",
    revision: 0,
    generation: 77,
    purposeCode: "connect-membership",
  }]);
  await desktop.close();
});

test("desktop Kimi setup writes privately then emits four fields before secret and starts provider time after secret", async () => {
  const order: string[] = [];
  const actions: KimiNativeActionRequest[] = [];
  const requirements: unknown[] = [];
  const desktop = await createAttestedDesktopKimiFixture({ generation: 78, now: () => 2_000,
    emitRequirement(requirement: unknown) {
      order.push("public-requirement");
      requirements.push(structuredClone(requirement));
    },
    onAction(action) {
      order.push("private-write");
      actions.push(action);
      return {
        kind: "permit",
        request: action,
        nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      };
    },
  });
  const surface = new ScriptedSurface(["kimi-code"], ["fixture-kimi-key-not-real"], ["k3"]);
  const readSecret = surface.readSecret.bind(surface);
  surface.readSecret = async () => {
    order.push("secret");
    return readSecret();
  };
  const context = kimiSetupFixture(surface);

  const result = await runSetupHub({
    ...context,
    surface,
    executionMode: "piped",
    kimiExecutionOrigin: desktopNativeKimiExecutionOrigin(desktop.permitReader),
    kimiDesktopSetupContext: {
      sessionId: "desktop-session-accepted",
      childPid: process.pid,
      setupId: "desktop-setup-accepted",
    },
    desktopKimiCapability: desktop.capability,
    resolveProviderDeadline() {
      order.push("provider-deadline");
      return 90_000;
    },
  } as never);

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(order.slice(0, 4), [
    "private-write",
    "public-requirement",
    "secret",
    "provider-deadline",
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.generation, 78);
  assert.equal(actions[0]!.deadlineAt, 62_000);
  assert.deepEqual(requirements, [{
    kind: "kimi-setup",
    revision: 0,
    generation: 78,
    purposeCode: "connect-membership",
  }]);
  assert.equal(context.authorityCalls.length, 1);
  assert.deepEqual(context.kimi.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 1);
  await desktop.close();
});

test("desktop Kimi setup action write and public projection failures cancel without secret or provider effects", async (t) => {
  for (const failure of ["write", "emit"] as const) {
    await t.test(failure, async () => {
      const frames: KimiNativeActionRecord[] = [];
      let emitted = 0;
      const desktop = await createAttestedDesktopKimiFixture({ generation: 79, now: () => 3_000,
        emitRequirement() {
          emitted += 1;
          if (failure === "emit") throw new Error("local public projection failed");
        },
        onAction(action) {
          frames.push(action);
          if (failure === "write") throw new Error("local action write failed");
          return { kind: "permit", request: action, nonce: "BBBBBBBBBBBBBBBBBBBBBB" };
        },
        onRevoke(record) { frames.push(record); },
      });
      const surface = new ScriptedSurface(["kimi-code"], ["must-not-be-read"], ["k3"]);
      const context = kimiSetupFixture(surface);
      assert.equal(isDesktopKimiRuntimeCapability(desktop.capability), true);
      assert.equal(desktop.permitReader.isOpen, true);

      const result = await runSetupHub({
        ...context,
        surface,
        executionMode: "piped",
        kimiExecutionOrigin: desktopNativeKimiExecutionOrigin(desktop.permitReader),
        kimiDesktopSetupContext: {
          sessionId: `desktop-session-${failure}`,
          childPid: process.pid,
          setupId: `desktop-setup-${failure}`,
        },
        desktopKimiCapability: desktop.capability,
      } as never);

      assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
      assert.deepEqual(surface.calls, ["hub"]);
      assert.deepEqual(context.authorityCalls, []);
      assert.deepEqual(context.kimi.calls, []);
      assert.deepEqual(context.activations, []);
      assert.equal(frames.filter((frame) => frame.kind === "kimi-setup").length, 1);
      assert.equal(emitted, failure === "emit" ? 1 : 0);
      assert.equal(frames.filter((frame) => frame.kind === "revoke").length, failure === "emit" ? 1 : 0);
      await desktop.close();
    });
  }
});

// F7 (ruling 3, replace-confirm fold): the separate "Replace the existing
// key?" confirm is gone; the decision point relocates to Escape at the
// (now merged) secret prompt, and produces the exact same zero-effect
// outcome and the exact same "not changed" notice the old confirm's "No"
// used to — deliberately preserved verbatim (ruling 7: no provider-logic
// change) even though every OTHER cancellation in this flow goes through
// `cancelOnce`/`orchestrator.cancelSetup`. Renamed and re-scripted from the
// old "Kimi replacement confirmation happens before secret input..." test.
test("declining a Kimi replacement at the secret prompt (Escape) steps back to the list and leaves the existing connection untouched", async () => {
  // FIX-18 (Esc depth): Escape at the key stage returns to the provider
  // list; the run below then cancels from the LIST level. The pre-F7
  // no-effect guarantee still holds at the decline itself: no authority,
  // adapter, or activation effect, and the existing connection survives.
  const surface = new ScriptedSurface(["kimi-code", null], [null]);
  const context = kimiSetupFixture(surface, { existing: true });
  const before = context.stateStore.read();

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub", "secret", "hub"]);
  assert.deepEqual(context.authorityCalls, []);
  assert.deepEqual(context.kimi.calls, []);
  assert.deepEqual(context.activations, []);
  assert.deepEqual(context.stateStore.read().connections, before.connections);
  assert.deepEqual(context.stateStore.read().defaultRoute, before.defaultRoute);
  const copy = surface.events.map((event) => "message" in event ? event.message : "").join("\n");
  assert.match(copy, /existing Kimi Code account was not changed/i);
  // Setup was still running at the list — the no-effect line must not
  // claim a cancel that had not happened yet.
  assert.doesNotMatch(copy, /Setup cancelled\. The existing Kimi Code account/i);
});

// F7 (ruling 3): the pre-secret notice states the existing key's presence
// (with its masked account tail) and the replace consequence before the
// prompt is even shown — this is the disclosure the removed confirm step
// used to gate on a separate "Yes".
test("a Kimi replacement's pre-secret notice discloses the existing account's masked tail and the replace consequence", async () => {
  const surface = new ScriptedSurface(["kimi-code"], ["replacement-membership-key"], ["k3"]);
  const context = kimiSetupFixture(surface, { existing: true });

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model"]);
  assert.match(
    surface.events.map((event) => "message" in event ? event.message : "").join("\n"),
    /existing Kimi Code membership key is connected \(account …[^)]+\)\. Submitting a new key replaces it; press Esc to keep the current one and go back\./i,
  );
});

test("submitting a replacement Kimi secret binds authority, connect, and activation to the one existing connection", async () => {
  const surface = new ScriptedSurface(
    ["kimi-code"],
    ["replacement-membership-key"],
    ["k3"],
  );
  const context = kimiSetupFixture(surface, { existing: true });

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(context.authorityCalls[0]?.targetConnectionId, "kimi-existing");
  assert.equal(context.kimi.connectRequests[0]?.connectionId, "kimi-existing");
  assert.equal(context.activations[0]?.targetConnectionId, "kimi-existing");
  assert.equal(context.stateStore.read().connections.length, 1);
  assert.equal(context.stateStore.read().connections[0]?.id, "kimi-existing");
});

// F7 (ruling 5-style test-update, applied here to ruling 3's fold): the
// separate confirm step is gone, so the revision-bound guard against a
// concurrent replacement now has to be exercised at the secret prompt
// directly instead of at a "Yes" confirm — renamed from "Kimi replacement
// confirmation is revision-bound before secret or authority effects".
test("a Kimi replacement secret submission is revision-bound before authority effects", async () => {
  const surface = new ScriptedSurface(
    ["kimi-code"],
    ["replacement-must-stale"],
    ["k3"],
  );
  const context = kimiSetupFixture(surface, { existing: true });
  const originalReadSecret = surface.readSecret.bind(surface);
  surface.readSecret = async () => {
    const current = context.stateStore.read();
    context.stateStore.replace({
      ...current,
      connections: current.connections.map((connection) => connection.id === "kimi-existing"
        ? {
            ...connection,
            credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0798" },
            accountFingerprint: "acct_kimi_concurrent_replacement",
          }
        : connection),
      defaultRoute: current.defaultRoute
        ? { ...current.defaultRoute, accountFingerprint: "acct_kimi_concurrent_replacement" }
        : null,
    }, current.revision);
    return originalReadSecret();
  };

  const result = await runSetupHub({ ...context, surface } as never);
  const foreign = context.stateStore.read();

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.equal(context.authorityCalls[0]?.expectedRevision, 1);
  assert.deepEqual(context.kimi.calls, []);
  assert.deepEqual(context.activations, []);
  assert.equal(foreign.revision, 2);
  assert.equal(foreign.connections[0]?.accountFingerprint, "acct_kimi_concurrent_replacement");
  assert.equal(
    requireKeychainCredentialPointer(foreign.connections[0]!),
    "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0798",
  );
});

test("ambiguous retained Kimi connections fail closed before the replace-consequence notice or secret prompt", async () => {
  const surface = new ScriptedSurface(
    ["kimi-code", null],
    ["must-not-be-read"],
    ["k3"],
  );
  const context = kimiSetupFixture(surface, { existing: true });
  const state = context.stateStore.read();
  const existing = state.connections[0]!;
  context.stateStore.replace({
    ...state,
    connections: [
      existing,
      {
        ...existing,
        id: "kimi-existing-ambiguous",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0799" },
        accountFingerprint: "acct_kimi_existing_ambiguous",
      },
    ],
  }, state.revision);
  const before = context.stateStore.read();

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surface.calls, ["hub"]);
  const noticeText = surface.events.map((event) => "message" in event ? event.message : "").join("\n");
  assert.match(noticeText, /multiple|ambiguous/i);
  // FIX-10 M2: the remedy named must be one that actually exists in the
  // /provider catalog — logout removes a connection outright, reducing the
  // count this gate checks. "Repair provider setup" named no real action.
  assert.match(noticeText, /\/provider logout kimi-code/);
  assert.doesNotMatch(noticeText, /Repair provider setup/);
  assert.deepEqual(context.authorityCalls, []);
  assert.deepEqual(context.kimi.calls, []);
  assert.deepEqual(context.activations, []);
  assert.deepEqual(context.stateStore.read(), before);
});

test("hub discloses OpenRouter API-key pay-as-you-go terms before secret input and returns ready without Cross onboarding", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);
  const originalReadSecret = surface.readSecret.bind(surface);
  surface.readSecret = async () => {
    const messages = surface.events
      .map((event) => "message" in event ? event.message : "")
      .join("\n");
    assert.match(messages, /API key.*pay as you go.*OpenRouter/is);
    return originalReadSecret();
  };

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm"]);
  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
  assert.equal(context.activations.length, 1);
  assert.equal(context.activations[0]?.backendId, "openrouter");
  assert.equal(context.activations[0]?.persistence, "persisted");
  assert.equal(context.activations[0]?.selectedCanonicalModelId, MODEL.canonicalModelId);
  assert.equal("preparedRoles" in result, false);
});

test("the shipped default main model is offered by the setup picker and can be activated", async () => {
  // FIX-13: setup used to re-derive the main-role rule from the descriptor
  // capability triple alone, so the one model a fresh install starts with was
  // the one model its own picker never listed.
  assert.equal(DEFAULT_CONFIG.mainModel, AUTOMATIC_MODEL.requestedModelId);
  const surface = new ScriptedSurface(
    ["openrouter"],
    ["sk-or-v1-test-key"],
    [AUTOMATIC_MODEL.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  context.adapter.models = [MODEL, AUTOMATIC_MODEL];

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(
    surface.modelRequests[0]?.models.map((model) => model.requestedModelId),
    [MODEL.requestedModelId, DEFAULT_CONFIG.mainModel],
  );
  assert.equal(context.activations[0]?.selectedCanonicalModelId, AUTOMATIC_MODEL.canonicalModelId);
});

test("the automatic route is the only capability exception — an incapable model stays out of the picker", async () => {
  const incapable: BackendModelDescriptor = {
    ...AUTOMATIC_MODEL,
    requestedModelId: "vendor/no-text",
    canonicalModelId: "vendor/no-text",
    displayName: "No text",
  };
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);
  context.adapter.models = [MODEL, incapable];

  await runSetupHub({ ...context, surface });

  assert.deepEqual(
    surface.modelRequests[0]?.models.map((model) => model.requestedModelId),
    [MODEL.requestedModelId],
  );
});

test("the automatic route's picker row states what it does and quotes no price", () => {
  assert.equal(
    setupModelRowLabel(AUTOMATIC_MODEL),
    "Automatic routing · OpenRouter picks per request · price dynamic",
  );
  assert.doesNotMatch(setupModelRowLabel(AUTOMATIC_MODEL), /\$|free|kostenlos/i);
  assert.equal(setupModelRowLabel(MODEL), MODEL.displayName);
  assert.equal(setupModelRowLabel(KIMI_MODELS[0]!), KIMI_MODELS[0]!.displayName);
});

test("automatic setup carries one startup signal generation and target through candidate catalog and activation", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);
  const controller = new AbortController();
  const deadlineAt = Date.now() + 9_000;

  const result = await runSetupHub({
    ...context,
    surface,
    signal: controller.signal,
    deadlineAt,
    generation: 41,
    targetConnectionId: "connection-startup",
  });

  assert.deepEqual(result, { kind: "ready" });
  const scopedSignal = context.adapter.connectRequest?.signal;
  assert.ok(scopedSignal);
  assert.notEqual(scopedSignal, controller.signal);
  assert.equal(context.adapter.connectRequest?.generation, 41);
  assert.equal(context.adapter.connectRequest?.connectionId, "connection-startup");
  assert.equal(context.adapter.connectRequest?.deadlineAt, deadlineAt);
  assert.equal(context.adapter.modelRequest?.signal, scopedSignal);
  assert.equal(context.activations[0]?.signal, scopedSignal);
  assert.equal(context.activations[0]?.generation, 41);
  assert.equal(context.activations[0]?.targetConnectionId, "connection-startup");
  assert.equal(context.activations[0]?.deadlineAt, deadlineAt);
});

test("manual provider contact creates one finite fifteen-second deadline for connect and activation", async () => {
  const surface = new ScriptedSurface(
    ["openrouter"],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId],
    [true],
  );
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  const observedAt = context.adapter.connectObservedAt;
  const connectDeadlineAt = context.adapter.connectRequest?.deadlineAt;
  assert.ok(observedAt !== null);
  assert.ok(connectDeadlineAt !== undefined);
  assert.ok(Number.isFinite(connectDeadlineAt));
  assert.ok(connectDeadlineAt > observedAt);
  assert.ok(connectDeadlineAt - observedAt <= 15_000);
  assert.equal(context.activations[0]?.deadlineAt, connectDeadlineAt);
});

test("manual provider deadline resolver stays lazy until secret input and is reused exactly", async () => {
  let releaseSecret!: (secret: string) => void;
  let secretReached!: () => void;
  const reachedSecret = new Promise<void>((resolve) => { secretReached = resolve; });
  const secret = new Promise<string>((resolve) => { releaseSecret = resolve; });
  let hubCalls = 0;
  const surface: SetupSurface = {
    async chooseHub() {
      hubCalls += 1;
      return "openrouter";
    },
    async readSecret() {
      secretReached();
      return secret;
    },
    async chooseModel() { return MODEL.canonicalModelId; },
    async confirm() { return true; },
    present() {},
  };
  const context = fixture(surface);
  const resolvedDeadlineAt = Date.now() + 12_345;
  let resolverCalls = 0;

  const pending = runSetupHub({
    ...context,
    surface,
    resolveProviderDeadline() {
      resolverCalls += 1;
      return resolvedDeadlineAt;
    },
  });
  await reachedSecret;

  assert.equal(resolverCalls, 0);
  assert.deepEqual(context.adapter.calls, []);
  assert.deepEqual([...context.activations], []);

  releaseSecret("sk-or-v1-test-key");
  assert.deepEqual(await pending, { kind: "ready" });
  assert.equal(resolverCalls, 1);
  assert.equal(context.adapter.connectRequest?.deadlineAt, resolvedDeadlineAt);
  assert.equal(context.activations[0]?.deadlineAt, resolvedDeadlineAt);
});

test("startup abort revokes a connected candidate even when catalog ignores abort forever", async () => {
  const surface = new ScriptedSurface(["cross-later"]);
  const context = fixture(surface);
  let catalogReached!: () => void;
  const reached = new Promise<void>((resolve) => { catalogReached = resolve; });
  context.adapter.listModels = async (request) => {
    context.adapter.modelRequest = request;
    context.adapter.calls.push("models");
    catalogReached();
    return new Promise<readonly BackendModelDescriptor[]>(() => undefined);
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + 8_000;
  const attempt = runSetupHub({
    ...context,
    surface,
    environmentSecret: "sk-or-v1-test-key",
    signal: controller.signal,
    deadlineAt,
    generation: 42,
  });
  await reached;
  assert.deepEqual(context.adapter.calls, ["connect", "models"]);

  controller.abort(new DOMException("startup timeout", "AbortError"));
  assert.deepEqual(await attempt, { kind: "cancelled", mode: "setup-required" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(context.adapter.calls, ["connect", "models", "discard"]);
});

test("startup cancellation settles a pending prompt and fences every late setup effect", async () => {
  let releaseSecret!: () => void;
  let secretReached!: () => void;
  const reached = new Promise<void>((resolve) => { secretReached = resolve; });
  const secret = new Promise<string>((resolve) => {
    releaseSecret = () => resolve("sk-or-v1-late-prompt-key");
  });
  const surfaceEffects: string[] = [];
  const surface: SetupSurface = {
    async chooseHub() {
      surfaceEffects.push("hub");
      return "openrouter";
    },
    async readSecret() {
      surfaceEffects.push("secret");
      secretReached();
      return secret;
    },
    async chooseModel() {
      surfaceEffects.push("model");
      return MODEL.canonicalModelId;
    },
    async confirm() {
      surfaceEffects.push("confirm");
      return true;
    },
    present() { surfaceEffects.push("present"); },
  };
  const context = fixture(surface);
  const controller = new AbortController();
  const attempt = runSetupHub({
    ...context,
    surface,
    signal: controller.signal,
    deadlineAt: Date.now() + 5_000,
    generation: 43,
  });
  await reached;
  controller.abort(new DOMException("fixed outer startup cancellation", "AbortError"));

  const settledAfterAbort = await Promise.race([
    attempt.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 50);
    }),
  ]);
  releaseSecret();
  const result = await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settledAfterAbort, "settled");
  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surfaceEffects, ["present", "hub", "present", "secret"]);
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
});

test("startup deadline settles a pending prompt and fences every late setup effect", async () => {
  let releaseSecret!: () => void;
  let secretReached!: () => void;
  const reached = new Promise<void>((resolve) => { secretReached = resolve; });
  const secret = new Promise<string>((resolve) => {
    releaseSecret = () => resolve("sk-or-v1-late-deadline-key");
  });
  const surfaceEffects: string[] = [];
  const surface: SetupSurface = {
    async chooseHub() {
      surfaceEffects.push("hub");
      return "openrouter";
    },
    async readSecret() {
      surfaceEffects.push("secret");
      secretReached();
      return secret;
    },
    async chooseModel() {
      surfaceEffects.push("model");
      return MODEL.canonicalModelId;
    },
    async confirm() {
      surfaceEffects.push("confirm");
      return true;
    },
    present() { surfaceEffects.push("present"); },
  };
  const context = fixture(surface);
  const attempt = runSetupHub({
    ...context,
    surface,
    deadlineAt: Date.now() + 50,
    generation: 44,
  });
  await reached;

  const settledAtDeadline = await Promise.race([
    attempt.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 500);
    }),
  ]);
  releaseSecret();
  const result = await attempt;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settledAtDeadline, "settled");
  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(surfaceEffects, ["present", "hub", "present", "secret"]);
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
});

test("hub keeps exactly one setup prompt active at a time", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
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
  assert.match(surface.events.map((event) => "message" in event ? event.message : "").join("\n"), /Setup cancelled/i);
});

test("Escape at the key stage steps back to the list; only the list level publishes the one cancelled lifecycle", async () => {
  // FIX-18 (Esc depth): the key stage's Escape is a one-level "back", not a
  // full cancel — the full cancel (one lifecycle publication, explicit
  // notice) belongs to the provider list alone.
  const surface = new ScriptedSurface(["openrouter", null], [null]);
  const context = fixture(surface);
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assertOneInteractiveCancellation(cancellations, "hub");
  assert.equal(context.stateStore.read().lifecycle, "cancelled");
  assert.deepEqual(surface.calls, ["hub", "secret", "hub"]);
  assert.deepEqual(context.adapter.calls, []);
  const cancellationCopy = surface.events.map((event) => "message" in event ? event.message : "").join("\n");
  assert.match(cancellationCopy, /Setup cancelled/i);
  assert.doesNotMatch(cancellationCopy, /account is ready|setup complete|saved successfully/i);
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

test("setup cancellation cannot report success when cancelled lifecycle persistence rejects", async () => {
  const surface = new ScriptedSurface([null]);
  const context = fixture(surface);
  context.orchestrator.cancelSetup = async () => {
    throw new Error("fixed cancelled lifecycle persistence failure");
  };

  await assert.rejects(
    runSetupHub({ ...context, surface, signal: AbortSignal.abort() }),
    /fixed cancelled lifecycle persistence failure/,
  );
  assert.equal(context.stateStore.read().lifecycle, "never-configured");
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
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000099" },
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

test("successful setup returns ready immediately without a second hub prompt or prepared Cross roles", async () => {
  const surface = new ScriptedSurface(
    ["openrouter", "cross-prepare"],
    ["sk-or-v1-test-key"],
    [MODEL.canonicalModelId, CHALLENGER.canonicalModelId],
    [true],
  );
  const context = fixture(surface);
  context.adapter.models = [MODEL, CHALLENGER];
  const cancellations = observeSetupCancellations(context.orchestrator);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(cancellations, []);
  assert.equal(context.stateStore.read().lifecycle, "configured");
  assert.equal(context.stateStore.read().cross.enabled, false);
  assert.equal(context.stateStore.read().cross.preferredLead, null);
  assert.equal(context.stateStore.read().cross.preferredChallenger, null);
  assert.equal("preparedRoles" in result, false);
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm"]);
});

test("hostile Codex and Anthropic hub values fail closed without credential, adapter, activation, or state effects", async (t) => {
  for (const backendId of ["codex", "anthropic"] as const) {
    await t.test(backendId, async () => {
      const surface = new ScriptedSurface([backendId, null]);
      const context = fixture(surface);
      const before = context.stateStore.read();

      const result = await runSetupHub({ ...context, surface });

      assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
      assert.deepEqual(context.adapter.calls, []);
      assert.equal(context.activations.length, 0);
      assert.deepEqual(context.stateStore.read(), before);
      assert.deepEqual(surface.calls, ["hub"]);
      // FIX-12: neither id is selectable — `codex` is not listed at all and
      // the Anthropic row is `disabled`, which every surface filters — so a
      // surface returning one is by definition hostile. The guard that
      // catches it stays (without it `anthropic` would fall through to the
      // OpenRouter branch and collect a credential under the wrong
      // provider's name); what it says is no longer a "Coming soon" that
      // was never true, and for Anthropic it is the same redirect the hub
      // row itself carries.
      const messages = surface.events.map((event) => "message" in event ? event.message : "").join("\n");
      assert.match(messages, backendId === "anthropic"
        ? /not available as a direct backend .* via OpenRouter/i
        : /this provider selection is unavailable and was not used/i);
      assert.doesNotMatch(messages, /coming soon/i);
    });
  }
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
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
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
  const surface = new ScriptedSurface(["openrouter", "openrouter:environment"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface);
  context.adapter.rejected.add(saved);

  const result = await runSetupHub({ ...context, surface, savedSecret: saved, environmentSecret: environment });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(context.adapter.connected, [saved, environment]);
  assert.equal(context.activations[0]?.persistence, "process-only");
  assert.equal(surface.entries[1]?.some((entry) => entry.id === "openrouter:environment"), true);
});

test("an environment candidate is automatically process-only only without a saved credential", async () => {
  const surface = new ScriptedSurface([], [], [MODEL.canonicalModelId]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, { kind: "ready" });
  assert.deepEqual(surface.calls, ["model"]);
  assert.equal(context.activations[0]?.persistence, "process-only");
});

test("saved candidate permit survives catalog and model choice into activation", async () => {
  const surface = new ScriptedSurface(["openrouter"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface);
  const permit = Object.freeze({ version: 1 as const });

  const result = await runSetupHub({
    ...context,
    surface,
    savedSecret: "sk-or-v1-saved-permit",
    savedCandidatePermit: permit,
    withCandidateAuthority: async (candidatePermit, requireCandidatePermit, use) => {
      assert.equal(candidatePermit, permit);
      assert.equal(requireCandidatePermit, true);
      return {
        kind: "ready",
        value: await use({ async assertHeld() {}, async assertCurrent() {} }),
      };
    },
  });
  const activation = context.activations[0] as ProviderActivationRequest & {
    candidatePermit?: unknown;
    requireCandidatePermit?: boolean;
  };

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(activation.candidatePermit, permit);
  assert.equal(activation.requireCandidatePermit, true);
});

test("environment candidate permit survives catalog and model choice into activation", async () => {
  const surface = new ScriptedSurface([], [], [MODEL.canonicalModelId]);
  const context = fixture(surface, { processOnlyNullState: true });
  const permit = Object.freeze({ version: 1 as const });

  const result = await runSetupHub({
    ...context,
    surface,
    environmentSecret: "sk-or-v1-environment-permit",
    environmentCandidatePermit: permit,
    withCandidateAuthority: async (candidatePermit, requireCandidatePermit, use) => {
      assert.equal(candidatePermit, permit);
      assert.equal(requireCandidatePermit, true);
      return {
        kind: "ready",
        value: await use({ async assertHeld() {}, async assertCurrent() {} }),
      };
    },
  });
  const activation = context.activations[0] as ProviderActivationRequest & {
    candidatePermit?: unknown;
    requireCandidatePermit?: boolean;
  };

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(activation.candidatePermit, permit);
  assert.equal(activation.requireCandidatePermit, true);
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

test("account setup preserves existing Cross preferences without offering onboarding role preparation", async () => {
  const surface = new ScriptedSurface(["openrouter", "cross-prepare"], ["sk-or-v1-test-key"], [MODEL.canonicalModelId], [true]);
  const context = fixture(surface);
  const before = context.stateStore.read();
  const preferredLead = {
    version: 1 as const,
    backendId: "openrouter" as const,
    accountFingerprint: "acct",
    billingRealm: "openrouter-payg" as const,
    requestedModelId: MODEL.requestedModelId,
    canonicalModelId: MODEL.canonicalModelId,
    resolutionState: "resolved" as const,
  };
  const preferredChallenger = {
    ...preferredLead,
    requestedModelId: CHALLENGER.requestedModelId,
    canonicalModelId: CHALLENGER.canonicalModelId,
  };
  context.stateStore.replace({
    ...before,
    lifecycle: "configured",
    connections: [{
      id: "connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
      accountFingerprint: "acct",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: preferredLead,
    cross: { enabled: false, preferredLead, preferredChallenger },
  }, before.revision);

  const result = await runSetupHub({ ...context, surface });
  const state = context.stateStore.read();

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(state.lifecycle, "configured");
  assert.equal(state.defaultRoute?.canonicalModelId, MODEL.canonicalModelId);
  assert.equal(state.cross.enabled, false);
  assert.deepEqual(state.cross.preferredLead, preferredLead);
  assert.deepEqual(state.cross.preferredChallenger, preferredChallenger);
  assert.deepEqual(surface.calls, ["hub", "secret", "model", "confirm"]);
  assert.equal("preparedRoles" in result, false);
});

test("invalid secret bytes never reach an adapter or presentation event", async () => {
  const secret = `invalid\0${"x".repeat(20)}`;
  const surface = new ScriptedSurface(["openrouter", null], [secret]);
  const context = fixture(surface);

  await runSetupHub({ ...context, surface });

  assert.deepEqual(context.adapter.calls, []);
  assert.equal(JSON.stringify(surface.events).includes(secret), false);
});

test("a process-only activation with null durable state returns ready without inventing persistence", async () => {
  const surface = new ScriptedSurface([], [], [MODEL.canonicalModelId]);
  const context = fixture(surface, { processOnlyNullState: true });

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal(context.stateStore.read().defaultRoute, null);
  assert.equal(context.activations[0]?.persistence, "process-only");
  assert.deepEqual(surface.calls, ["model"]);
  assert.equal("preparedRoles" in result, false);
});

test("process-only setup ignores hostile Cross onboarding choices and leaves durable preferences untouched", async () => {
  const surface = new ScriptedSurface(["cross-prepare"], [], [MODEL.canonicalModelId]);
  const context = fixture(surface, { processOnlyNullState: true });

  const result = await runSetupHub({ ...context, surface, environmentSecret: "sk-or-v1-environment" });

  assert.deepEqual(result, { kind: "ready" });
  assert.equal("preparedRoles" in result, false);
  assert.deepEqual(surface.calls, ["model"]);
  assert.equal(context.stateStore.read().defaultRoute, null);
  assert.equal(context.stateStore.read().cross.preferredLead, null);
  assert.equal(context.stateStore.read().cross.preferredChallenger, null);
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
  const printed: string[] = [];
  const selections = ["openrouter", "openrouter", MODEL.canonicalModelId];
  const passwords = ["offline-key", "working-key"];
  const surface = createPlainSetupSurface({
    async select(request: { message: string }) { prompts.push(request.message); return selections.shift()!; },
    async password() { return passwords.shift()!; },
    async confirm() { return true; },
    printNotice(message: string) { printed.push(message); },
  } as never);
  const context = fixture(surface);
  context.adapter.offline.add("offline-key");

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  // FIX-12: the first prompt carries the question and the one line that is
  // not a choice — where Claude actually runs. It used to carry the whole
  // provider list flattened into a single `·`-joined line, 240 characters
  // and eleven separators of scrollback restating, badly, the rows the
  // picker below was about to render properly.
  assert.deepEqual(prompts[0]?.split("\n"), [
    "Anthropic / Claude · Not available as a direct backend — Claude models run today via OpenRouter.",
    // FIX-11 at merge: one name for one screen, matching the fullscreen
    // surfaces' "Provider setup" title.
    "Provider setup",
  ]);
  // FIX-18: the validation failure is a settled outcome — it prints as its
  // own durable line instead of only riding along inside the next prompt's
  // status fold (which never showed when a flow ended without a next prompt).
  assert.match(printed.join("\n"), /could not validate the API key/i);
  assert.match(prompts.at(-1) ?? "", /Choose a model/i);
  assert.match(printed.at(-1) ?? "", /OpenRouter account is ready/i);
  assert.doesNotMatch(prompts.join("\n"), /Provider auswählen|Modell auswählen|nicht bestätigen/i);
});

// FIX-12: the picker gets the label and the facts as two fields, so the row
// renderer can give the provider its own column and mute the facts beside
// it — one provider per line. Pre-joining them into `name` handed it a
// single opaque string it could not lay out at all.
test("the plain setup picker receives each provider as a row, not one pre-joined string", async () => {
  const requests: Array<{
    message: string;
    choices: readonly { name: string; value: string; description?: string }[];
  }> = [];
  const surface = createPlainSetupSurface({
    async select(request: {
      message: string;
      choices: readonly { name: string; value: string; description?: string }[];
    }) {
      requests.push(request);
      return null;
    },
    async password() { return ""; },
    async confirm() { return true; },
  } as never);
  const context = fixture(surface);

  await runSetupHub({ ...context, surface });

  assert.deepEqual(requests[0]?.choices, [
    {
      name: "OpenRouter",
      value: "openrouter",
      description: "API key · Pay as you go · Many models",
    },
  ]);
  // The Anthropic row is never a choice — it says where Claude runs, above
  // the picker, exactly once and only while a provider is being chosen.
  assert.equal(
    requests[0]?.message,
    "Anthropic / Claude · Not available as a direct backend — Claude models run today via OpenRouter."
      // FIX-11 at merge: one name for one screen ("Provider setup",
      // matching the fullscreen surfaces).
      + "\nProvider setup",
  );
});

test("plain setup surface discloses OpenRouter's pay-as-you-go billing before the secret prompt", async () => {
  const passwordMessages: string[] = [];
  const selections = ["openrouter", MODEL.canonicalModelId];
  const surface = createPlainSetupSurface({
    async select() { return selections.shift()!; },
    async password(request: { message: string }) { passwordMessages.push(request.message); return "sk-or-v1-test-key"; },
    async confirm() { return true; },
  } as never);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "ready" });
  assert.match(passwordMessages[0] ?? "", /pay as you go[\s\S]*OpenRouter API key/i);
});

test("plain setup surface discloses Kimi's third-party billing before the secret prompt", async () => {
  const passwordMessages: string[] = [];
  // F7 (ruling 2): no "membership-key" auth-method selection anymore — the
  // hub row leads straight to the secret prompt.
  const selections = ["kimi-code", "kimi-for-coding"];
  const surface = createPlainSetupSurface({
    async select() { return selections.shift()!; },
    async password(request: { message: string }) { passwordMessages.push(request.message); return "fixture-kimi-membership-key"; },
    async confirm() { return true; },
  } as never);
  const context = kimiSetupFixture(surface);

  const result = await runSetupHub({ ...context, surface } as never);

  assert.deepEqual(result, { kind: "ready" });
  assert.match(passwordMessages[0] ?? "", /Extra Usage[\s\S]*Kimi Code membership key/i);
});

test("plain setup surface retains the notice across an unchanged provider-state generation even when labels differ", async () => {
  const promptMessages: string[] = [];
  const surface = createPlainSetupSurface({
    async select(request: { message: string }) { promptMessages.push(request.message); return "openrouter"; },
    async password() { return ""; },
    async confirm() { return false; },
  } as never);
  const first = [{ id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: false, generation: 4 }];
  // Same generation as `first` (same retry round) despite a cosmetically
  // different label/description/current flag: the notice must survive.
  const second = [{ id: "openrouter", label: "OpenRouter", description: "API key required", disabled: false, current: true, generation: 4 }];

  surface.present({ version: 1, type: "provider-state", entries: first });
  surface.present({ version: 1, type: "notice", message: "OpenRouter could not validate the API key." });
  surface.present({ version: 1, type: "provider-state", entries: second });
  await surface.chooseHub(second);

  assert.match(promptMessages[0] ?? "", /could not validate the API key/);
});

test("plain setup surface clears the notice once the provider-state generation changes even when the label text is unchanged", async () => {
  const promptMessages: string[] = [];
  const surface = createPlainSetupSurface({
    async select(request: { message: string }) { promptMessages.push(request.message); return "openrouter"; },
    async password() { return ""; },
    async confirm() { return false; },
  } as never);
  const atGeneration = (generation: number) => [
    { id: "openrouter", label: "OpenRouter", description: "Connect provider", disabled: false, current: false, generation },
  ];

  surface.present({ version: 1, type: "provider-state", entries: atGeneration(4) });
  surface.present({ version: 1, type: "notice", message: "OpenRouter could not validate the API key." });
  // Identical label text to generation 4's snapshot, but a new generation:
  // this is a fresh round, so the notice must not carry over.
  surface.present({ version: 1, type: "provider-state", entries: atGeneration(5) });
  await surface.chooseHub(atGeneration(5));

  assert.doesNotMatch(promptMessages[0] ?? "", /could not validate the API key/);
});

test("runSetupHub through the TUI adapter renders one honest redirect plus the cost disclosure and completes without Cross", async () => {
  const cards: string[] = [];
  const status: string[] = [];
  const choices = ["openrouter"];
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
  // FIX-12: the fabricated Codex explanation is gone with its row; the
  // Anthropic card stays — the redirect an owner looking for Claude needs —
  // but no longer promises a backend nobody is building. The disclosure
  // card survives the secret prompt's surface switch (F7 fix round 1,
  // Critical C1). FIX-18 adds the settled success outcome as its own card,
  // which must survive in the transcript instead of living only on the
  // clobberable status line — three cards in all.
  assert.equal(cards.length, 3);
  assert.match(cards.join("\n"), /pay as you go billing through OpenRouter/i);
  assert.match(cards.join("\n"), /Anthropic \/ Claude · Not available as a direct backend/);
  assert.doesNotMatch(cards.join("\n"), /coming soon/i);
  assert.doesNotMatch(cards.join("\n"), /Codex/i);
  assert.match(cards.at(-1) ?? "", /OpenRouter account is ready/i);
  assert.doesNotMatch(cards.join("\n"), /Prepare roles|Collaboration remains off/i);
  assert.match(status.at(-1) ?? "", /OpenRouter account is ready/i);
  assert.equal("preparedRoles" in result, false);
});

// FIX-18 structural guarantee: EVERY terminal path of the setup flow renders
// at least one settled outcome line (success / named failure with the reason /
// explicit cancel) — and never zero. The table enumerates the flow's terminal
// outcomes; a new exit path that presents nothing fails the final assertion.
function presentedOutcomes(surface: ScriptedSurface): string[] {
  return surface.events
    .filter((event): event is { version: 1; type: "notice"; message: string; busy: boolean; outcome: true } =>
      event.type === "notice" && (event as { outcome?: boolean }).outcome === true)
    .map((event) => event.message);
}

test("every terminal setup path renders one honest settled outcome per round (FIX-18)", async (t) => {
  const cases: Array<{
    name: string;
    surface: () => ScriptedSurface;
    prepare?: (context: ReturnType<typeof fixture>) => void;
    authority?: "stale" | "forget-pending" | "recovery-required";
    resultKind: "ready" | "cancelled";
    outcomes: RegExp[];
  }> = [
    {
      name: "success",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"], [MODEL.canonicalModelId], [true]),
      resultKind: "ready",
      outcomes: [/OpenRouter account is ready\./],
    },
    {
      name: "hub cancel",
      surface: () => new ScriptedSurface([null]),
      resultKind: "cancelled",
      outcomes: [/Setup cancelled\. No account was connected\./],
    },
    {
      name: "model cancel",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"], [null]),
      resultKind: "cancelled",
      outcomes: [/Setup cancelled\. No account was connected\./],
    },
    {
      name: "persistence declined",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"], [MODEL.canonicalModelId], [false]),
      resultKind: "cancelled",
      outcomes: [/Setup cancelled\. No account was connected\./],
    },
    {
      name: "key-stage Esc steps back; list-level Esc cancels",
      surface: () => new ScriptedSurface(["openrouter", null], [null]),
      resultKind: "cancelled",
      outcomes: [/Setup cancelled\. No account was connected\./],
    },
    {
      // FIX-12 at merge: the refusal names the honest redirect, never a
      // "coming soon" promise — same fail-closed guard, new truth.
      name: "unofferable redirect selection",
      surface: () => new ScriptedSurface(["anthropic"]),
      resultKind: "cancelled",
      outcomes: [/Not available as a direct backend — Claude models run today via OpenRouter\./],
    },
    {
      name: "unknown selection",
      surface: () => new ScriptedSurface(["bogus-backend"]),
      resultKind: "cancelled",
      outcomes: [/This provider selection is unavailable and was not used\./],
    },
    {
      name: "rejected key then hub cancel",
      surface: () => new ScriptedSurface(["openrouter", null], ["rejected-key"]),
      prepare: (context) => { context.adapter.rejected.add("rejected-key"); },
      resultKind: "cancelled",
      outcomes: [
        /OpenRouter could not validate the API key\./,
        /Setup cancelled\. No account was connected\./,
      ],
    },
    {
      name: "identity-less validated key then hub cancel (the F1 silent death)",
      surface: () => new ScriptedSurface(["openrouter", null], ["sk-or-key"]),
      prepare: (context) => {
        const connect = context.adapter.connect.bind(context.adapter);
        context.adapter.connect = async (request) => ({
          ...await connect(request),
          accountFingerprint: null,
        });
      },
      resultKind: "cancelled",
      outcomes: [
        /validated the API key but did not identify the account/,
        /Setup cancelled\. No account was connected\./,
      ],
    },
    {
      name: "spend limit reached then hub cancel",
      surface: () => new ScriptedSurface(["openrouter", null], ["sk-or-key"]),
      prepare: (context) => {
        const connect = context.adapter.connect.bind(context.adapter);
        context.adapter.connect = async (request) => {
          const candidate = await connect(request);
          return {
            ...candidate,
            health: { ...candidate.health, spend: "limit-reached" as const },
          };
        };
      },
      resultKind: "cancelled",
      outcomes: [
        /spend limit is already reached/,
        /Setup cancelled\. No account was connected\./,
      ],
    },
    {
      name: "empty model catalog then hub cancel",
      surface: () => new ScriptedSurface(["openrouter", null], ["sk-or-key"]),
      prepare: (context) => { context.adapter.models = []; },
      resultKind: "cancelled",
      outcomes: [
        /did not return a compatible main model\./,
        /Setup cancelled\. No account was connected\./,
      ],
    },
    {
      name: "authority stale blocks",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"]),
      authority: "stale",
      resultKind: "cancelled",
      outcomes: [/Provider setup stopped: the attempt is no longer current\. Run \/provider setup to try again\./],
    },
    {
      name: "authority forget-pending blocks",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"]),
      authority: "forget-pending",
      resultKind: "cancelled",
      outcomes: [/a previous disconnect is still being cleaned up\. Run \/provider setup to try again\./],
    },
    {
      name: "authority recovery-required blocks",
      surface: () => new ScriptedSurface(["openrouter"], ["sk-or-key"]),
      authority: "recovery-required",
      resultKind: "cancelled",
      outcomes: [/Provider setup failed before it could finish\. No account was connected — run \/provider setup to try again\./],
    },
  ];
  for (const terminal of cases) {
    await t.test(terminal.name, async () => {
      const surface = terminal.surface();
      const context = fixture(surface);
      terminal.prepare?.(context);
      const result = await runSetupHub({
        ...context,
        surface,
        ...(terminal.authority
          ? {
            withCandidateAuthority: async () => ({ kind: terminal.authority! }),
          }
          : {}),
      });
      assert.equal(result.kind, terminal.resultKind);
      const outcomes = presentedOutcomes(surface);
      assert.equal(
        outcomes.length,
        terminal.outcomes.length,
        `expected ${terminal.outcomes.length} settled outcome lines, saw: ${JSON.stringify(outcomes)}`,
      );
      terminal.outcomes.forEach((expected, index) => {
        assert.match(outcomes[index] ?? "", expected);
      });
      // The structural rule itself: no terminal path may end silently.
      assert.ok(outcomes.length > 0, "a setup flow ended with no settled outcome line");
    });
  }
});

test("explicit runnable model replacement changes an existing default only through one activation transaction", async () => {
  const surface = new ScriptedSurface(["openrouter"], ["sk-or-v1-test-key"], [CHALLENGER.canonicalModelId], [true]);
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
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
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

test("a keyless configured connection states its honest row state and names the cause once (FIX-18 F4)", async () => {
  // Configured default route, but the saved key was unreadable at startup:
  // the picker row must not present the account as intact, and the launch
  // notice names the cause exactly once — including across a retry round.
  const surface = new ScriptedSurface(["openrouter", null], [null]);
  const context = fixture(surface);
  const previous = context.stateStore.read();
  context.stateStore.replace({
    ...previous,
    lifecycle: "configured",
    connections: [{
      id: "connection",
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:90000000-0000-4000-8000-000000000002" },
      accountFingerprint: "acct",
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: null,
    }],
    defaultRoute: {
      version: 1,
      backendId: "openrouter",
      accountFingerprint: "acct",
      billingRealm: "openrouter-payg",
      requestedModelId: MODEL.requestedModelId,
      canonicalModelId: MODEL.canonicalModelId,
      resolutionState: "resolved",
    },
  }, previous.revision);

  const result = await runSetupHub({ ...context, surface, savedCredentialUnavailable: true });

  assert.equal(result.kind, "cancelled");
  const openRouterRows = surface.entries.map((round) =>
    round.find((entry) => entry.id === "openrouter"));
  assert.ok(openRouterRows.length >= 2, "secret Esc must return to the picker for a second round");
  for (const row of openRouterRows) {
    assert.equal(row?.description, "Key missing — enter it again");
    assert.equal(row?.current, true);
  }
  const causeNotices = surface.events.filter((event) =>
    event.type === "notice" && /could not be read/.test(event.message));
  assert.equal(causeNotices.length, 1, "the cause is named exactly once");
  assert.equal((causeNotices[0] as { outcome?: boolean }).outcome, true, "the cause uses the durable channel");
});

test("an intact configured connection keeps the standard OpenRouter row description (FIX-18 F4 guard)", async () => {
  const surface = new ScriptedSurface([null]);
  const context = fixture(surface);

  await runSetupHub({ ...context, surface });

  assert.equal(
    surface.entries[0]?.find((entry) => entry.id === "openrouter")?.description,
    "API key · Pay as you go · Many models",
  );
  assert.equal(
    surface.events.some((event) => event.type === "notice" && /could not be read/.test(event.message)),
    false,
  );
});
