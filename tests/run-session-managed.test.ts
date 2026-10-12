import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { rawCompressionResult } from "../src/compressor.js";
import { createRunTurnState, runSessionTurn, type RunSessionTurnInput } from "../src/run-session.js";
import type { AgentRunResult } from "../src/agent.js";
import type { RouteIdentityV1 } from "../src/backends.js";

const route: RouteIdentityV1 = {
  version: 1, backendId: "codex", accountFingerprint: "codex-profile-owner",
  billingRealm: "chatgpt-subscription-provider-managed-overage",
  resolutionState: "resolved", canonicalModelId: "gpt-5.3-codex", requestedModelId: "gpt-5.3-codex",
};
const result: AgentRunResult = {
  text: "Antwort", suggestions: [], outcome: "completed", costUsd: 0, mainCostUsd: 0,
  compressorCostUsd: 0, costKnowledge: "unknown", compression: rawCompressionResult(""),
  selectedModel: "gpt-5.3-codex", resolvedModel: "gpt-5.3-codex", notices: [], partial: false, modelSteps: 1,
};

function fixture() {
  const calls: Array<[string, unknown]> = [];
  const fail = () => { throw new Error("OpenRouter agent path must not run for Codex"); };
  const input = {
    context: {
      config: structuredClone(DEFAULT_CONFIG), agent: null,
      openRouter: { safeMessage: String, listModels: fail },
      providerRuntime: {
        runWithReadyRoute: async (run: (r: RouteIdentityV1) => Promise<unknown>) => run(route),
        runSetup: fail, ensureRunnableRoute: () => route,
      },
      ensureAgentForPrompt: fail,
      runManagedCodexTurn: async (r: RouteIdentityV1, text: string, observer: { onText?: (text: string) => void; signal?: AbortSignal }) => {
        calls.push(["managed", r]); calls.push(["prompt", text]);
        assert.ok(observer.signal instanceof AbortSignal);
        observer.onText?.("Antwort"); return result;
      },
    },
    surface: {
      setCancelHandler: (x?: unknown) => calls.push(["cancel", x]),
      setInterjectHandler: (x?: unknown) => calls.push(["interject", x]),
      setEndThinkingHandler: (x?: unknown) => calls.push(["thinking", x]),
      setImageAttachments: () => {}, addMessage: (r: string, x: string) => calls.push([r, x]),
      beginAssistant: (x: string) => calls.push(["begin", x]),
      appendAssistant: (x: string) => calls.push(["delta", x]), finishAssistant: () => {},
      setStatus: () => {}, setSuggestedReplies: () => {}, setContextPercent: () => {},
      handleRunEvent: () => {}, restoreSubmittedDraft: () => {}, insertInputText: () => {},
    },
    deps: { routeIsRunnable: () => true, assertModelBoundToRoute: fail,
      ensureRunnableModelConfiguration: fail, loadModelSnapshot: fail,
      runFooter: () => "Aboverbrauch unbekannt", partialFooter: () => "", describeRunFailure: String },
    ports: { readAttachments: () => [], writeAttachments: () => {}, readModelInfo: () => null,
      writeModelInfo: () => {}, setResolvedModel: (x: string) => calls.push(["resolved", x]) },
    state: createRunTurnState(), setupSurface: {} as RunSessionTurnInput["setupSurface"], text: "Meine Aufgabe",
  } as unknown as RunSessionTurnInput;
  return { input, calls };
}

test("explicit Codex route dispatches managed execution despite an old OpenRouter preference", async () => {
  const { input, calls } = fixture();
  const outcome = await runSessionTurn(input);
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(calls.find(([key]) => key === "managed")?.[1], route);
  assert.deepEqual(calls.find(([key]) => key === "begin"), ["begin", route.canonicalModelId]);
  assert.deepEqual(calls.find(([key]) => key === "delta"), ["delta", "Antwort"]);
  assert.equal(input.state.runStarted, true);
});

test("Codex attachment refusal preserves the draft and gives the correct provider name", async () => {
  const { input, calls } = fixture();
  input.ports.readAttachments = () => [{ name: "skizze.png" }] as never;
  await assert.rejects(runSessionTurn(input), /Codex.*[Bb]ild|[Bb]ild.*Codex/);
  assert.equal(input.state.runStarted, false);
  assert.equal(calls.some(([key]) => key === "managed" || key === "user"), false);
});

test("a missing Codex authority implementation fails before consuming the user's prompt", async () => {
  const { input, calls } = fixture();
  delete (input.context as unknown as Record<string, unknown>).runManagedCodexTurn;
  await assert.rejects(runSessionTurn(input), /Codex/);
  assert.equal(input.state.runStarted, false);
  assert.equal(calls.some(([key]) => key === "user"), false);
});
