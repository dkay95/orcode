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

  constructor(
    private readonly hub: Array<string | null>,
    private readonly secrets: Array<string | null> = [],
    private readonly models: Array<string | null> = [],
    private readonly confirms: boolean[] = [],
  ) {}

  async chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null> {
    this.calls.push("hub");
    this.entries.push([...entries]);
    return this.hub.shift() ?? null;
  }

  async readSecret(): Promise<string | null> {
    this.calls.push("secret");
    return this.secrets.shift() ?? null;
  }

  async chooseModel(): Promise<string | null> {
    this.calls.push("model");
    return this.models.shift() ?? null;
  }

  async confirm(): Promise<boolean> {
    this.calls.push("confirm");
    return this.confirms.shift() ?? false;
  }

  present(event: SetupEvent | { version: 1; type: "notice"; message: string }): void {
    this.events.push(structuredClone(event));
  }
}

class Adapter implements BackendAdapter {
  readonly backendId = "openrouter" as const;
  readonly calls: string[] = [];
  readonly connected: string[] = [];
  readonly rejected = new Set<string>();
  models: readonly BackendModelDescriptor[] = [MODEL];

  async inspect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async reconnect(): Promise<ProviderInspection> { throw new Error("not used"); }
  async logout(): Promise<void> { this.calls.push("logout"); }
  async discardCandidate(): Promise<void> { this.calls.push("discard"); }
  async connect(request: Parameters<BackendAdapter["connect"]>[0]): Promise<ProviderCandidate> {
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
        : { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 1, generation: 1 },
    };
  }
  async listModels(): Promise<readonly BackendModelDescriptor[]> {
    this.calls.push("models");
    return this.models;
  }
  async activate(): Promise<CandidateProviderState> { throw new Error("not used"); }
}

function fixture(surface: SetupSurface) {
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
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [{
          id: "connection", backendId: "openrouter", enabled: true, maturity: "stable", credentialSlot: "inference:connection",
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

test("coming-soon provider explains itself without adapter or activation effects", async () => {
  const surface = new ScriptedSurface(["anthropic", null]);
  const context = fixture(surface);

  const result = await runSetupHub({ ...context, surface });

  assert.deepEqual(result, { kind: "cancelled", mode: "setup-required" });
  assert.deepEqual(context.adapter.calls, []);
  assert.equal(context.activations.length, 0);
  assert.match(surface.events.map((event) => "message" in event ? event.message : "").join("\n"), /coming soon/i);
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

test("invalid secret bytes never reach an adapter or presentation event", async () => {
  const secret = `invalid\0${"x".repeat(20)}`;
  const surface = new ScriptedSurface(["openrouter", null], [secret]);
  const context = fixture(surface);

  await runSetupHub({ ...context, surface });

  assert.deepEqual(context.adapter.calls, []);
  assert.equal(JSON.stringify(surface.events).includes(secret), false);
});
