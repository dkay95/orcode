import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MIN_COMPRESSION_SAVING,
  compressContext,
  uncompressedContext,
  type CompressorPrice,
} from "../src/compressor.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SessionStore } from "../src/session.js";
import type { OrcodeConfig } from "../src/types.js";

test("compressor off performs no model call", async () => {
  const session = await freshSession("off");
  const client = countingClient(() => "sollte nicht passieren");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "off" }),
    session,
  });

  assert.equal(client.calls, 0);
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "disabled");
  assert.doesNotMatch(result.handoff, /current task/);
});

// FIX-2: `/compact` runs one pass on request. `manual` replaces the
// mode/threshold ELIGIBILITY decision and nothing else — the two tests below
// pin exactly that boundary, so the manual verb can never quietly grow into a
// second compressor.
test("manual compression runs even with the mode off — an explicit request is not an automatic one", async () => {
  const session = await freshSession("manual-off");
  fill(session, 12);
  const raw = uncompressedContext(session);
  const client = countingClient(() => raw.slice(0, Math.floor(raw.length / 3)));

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "off", compressionThresholdChars: 2_000_000 }),
    session,
    manual: true,
  });

  assert.equal(client.calls, 1);
  assert.equal(result.used, true);
  assert.equal(result.skipReason, undefined);
});

test("manual compression still obeys every gate after the eligibility decision", async () => {
  const session = await freshSession("manual-gates");
  fill(session, 12);
  const raw = uncompressedContext(session);

  // The upfront USD limit.
  const expensive = countingClient(() => raw.slice(0, 10));
  const limited = await compressContext({
    client: expensive.client as never,
    config: config({ compressionMode: "off", compressorMaxCostUsd: 0.000_001 }),
    session,
    manual: true,
    lookupPrice: async () => price(0.001, 0.002),
  });
  assert.equal(expensive.calls, 0, "the cost gate still stops the call before it happens");
  assert.equal(limited.used, false);
  assert.equal(limited.skipReason, "estimated-cost-limit");

  // The minimum-saving gate.
  const weak = countingClient(() => raw.slice(0, raw.length - 5));
  const insufficient = await compressContext({
    client: weak.client as never,
    config: config({ compressionMode: "off" }),
    session,
    manual: true,
  });
  assert.equal(weak.calls, 1);
  assert.equal(insufficient.used, false);
  assert.equal(insufficient.skipReason, "insufficient-saving");

  // Unknown provider cost.
  const unknown = countingClient(() => raw.slice(0, 10));
  const blind = await compressContext({
    client: unknown.client as never,
    config: config({ compressionMode: "off" }),
    session,
    manual: true,
    costKnowledge: "unknown",
  });
  assert.equal(unknown.calls, 0);
  assert.equal(blind.used, false);
  assert.equal(blind.skipReason, "cost-unknown");
});

test("compressor auto stays silent below the threshold", async () => {
  const session = await freshSession("auto-below");
  const client = countingClient(() => "sollte nicht passieren");

  const result = await compressContext({
    client: client.client as never,
    config: config({
      compressionMode: "auto",
      compressionThresholdChars: 100_000,
    }),
    session,
  });

  assert.equal(client.calls, 0);
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "below-threshold");
  assert.equal(result.savedPercent, 0);
  assert.equal(result.handoff, uncompressedContext(session));
});

test("compressor auto compresses once the context reaches the threshold", async () => {
  const session = await freshSession("auto-above");
  fill(session, 12);
  const raw = uncompressedContext(session);
  const client = countingClient(() => raw.slice(0, Math.floor(raw.length / 3)));

  const result = await compressContext({
    client: client.client as never,
    config: config({
      compressionMode: "auto",
      compressionThresholdChars: raw.length,
    }),
    session,
  });

  assert.equal(client.calls, 1);
  assert.equal(result.used, true);
  assert.ok(result.savedPercent >= 60, `savedPercent war ${result.savedPercent}`);
  assert.equal(result.compressedChars, result.handoff.length);
});

test("compression never touches the session", async () => {
  const session = await freshSession("pure");
  fill(session, 8);
  const before = structuredClone(session.data);
  const client = countingClient(() => "Sehr kurzer Handoff.");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, true);
  assert.equal(result.costUsd, 0.002);
  assert.equal(session.data.summary, before.summary);
  assert.equal(session.data.turns.length, before.turns.length);
  assert.equal(session.data.costs.compressorUsd, 0);
  assert.equal(session.data.costs.totalUsd, 0);
  assert.equal(session.data.updatedAt, before.updatedAt);
});

test("a handoff that barely shrinks the context is discarded", async () => {
  const session = await freshSession("weak");
  fill(session, 8);
  const raw = uncompressedContext(session);
  const client = countingClient(() => raw.slice(0, Math.floor(raw.length * 0.9)));

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(client.calls, 1);
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "insufficient-saving");
  assert.equal(result.handoff, raw);
  assert.equal(result.savedPercent, 0);
  assert.equal(result.costUsd, 0.002, "die Kosten sind trotzdem angefallen");
  assert.match(result.warnings.join("\n"), /discarded/);
});

// --- Phase 13: the pin gate ------------------------------------------------

test("pinning every turn makes the target unreachable and the refusal names pinning as the cause", async () => {
  const session = await freshSession("over-pinned");
  fill(session, 8);
  for (const turn of session.data.turns) {
    assert.equal(session.pinTurn(turn.id!), true);
  }
  const raw = uncompressedContext(session);
  // A handoff this small would easily clear MIN_COMPRESSION_SAVING on an
  // unpinned context — the pin gate is what has to be the reason it fails.
  const client = countingClient(() => "x");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(client.calls, 1);
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "insufficient-saving");
  assert.equal(result.handoff, raw, "compressContext never touches the session on any path — the pin is never dropped");
  assert.deepEqual(session.data.pinnedTurns?.length, 8, "the compressor must never silently unpin on refusal");
  assert.match(
    result.warnings.join("\n"),
    /Compression target not met — 8 pinned turns held/,
  );
});

test("a single pinned turn still lets compression succeed, but its chars no longer count as saved", async () => {
  const session = await freshSession("lightly-pinned");
  fill(session, 8);
  const pinnedTurn = session.data.turns[0]!;
  session.pinTurn(pinnedTurn.id!);
  const raw = uncompressedContext(session);
  const pinnedChars = `${pinnedTurn.role === "user" ? "USER" : "ASSISTANT"}:\n${pinnedTurn.content}`.length;
  // Shrink everything else to almost nothing, same handoff every unpinned
  // test in this file uses to clear the bar comfortably.
  const client = countingClient(() => raw.slice(0, Math.floor(raw.length / 20)));

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, true);
  assert.equal(
    result.compressedChars,
    result.handoff.length + pinnedChars,
    "the pinned turn's chars are added back on the compressed side, never folded into a duplicate estimator",
  );
  assert.equal(
    result.savedPercent,
    Math.round((1 - (result.handoff.length + pinnedChars) / raw.length) * 100),
  );
  assert.deepEqual(session.data.pinnedTurns, [pinnedTurn.id]);
});

test("without any pins the savings accounting is byte-identical to before the pin gate existed", async () => {
  const session = await freshSession("no-pins-unchanged");
  fill(session, 8);
  const raw = uncompressedContext(session);
  const client = countingClient(() => raw.slice(0, Math.floor(raw.length / 10)));

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, true);
  assert.equal(result.compressedChars, result.handoff.length);
  assert.doesNotMatch(result.warnings.join("\n"), /pinned/i);
});

test("a handoff larger than the context never reports a negative saving", async () => {
  const session = await freshSession("bigger");
  fill(session, 4);
  const raw = uncompressedContext(session);
  const client = countingClient(() => `${raw}${raw}`);

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, false);
  assert.equal(result.savedPercent, 0);
  assert.equal(result.handoff, raw);
  assert.ok(MIN_COMPRESSION_SAVING > 0);
});

test("an estimate above the cost limit rejects the compressor call upfront", async () => {
  const session = await freshSession("estimate-block");
  fill(session, 8);
  const client = countingClient(() => "Kurz.");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always", compressorMaxCostUsd: 0.05 }),
    session,
    lookupPrice: async () => price(0.001, 0.002),
  });

  assert.equal(client.calls, 0, "der Aufruf darf gar nicht stattfinden");
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "estimated-cost-limit");
  assert.equal(result.limitEnforcedUpfront, true);
  assert.ok((result.estimatedCostUsd ?? 0) > 0.05);
  assert.equal(result.costUsd, 0);
  assert.match(result.warnings.join("\n"), /estimated cost/);
});

test("an estimate below the cost limit lets the compressor run", async () => {
  const session = await freshSession("estimate-ok");
  fill(session, 8);
  const client = countingClient(() => "Kurzer Handoff.");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always", compressorMaxCostUsd: 0.05 }),
    session,
    lookupPrice: async () => price(1e-8, 2e-8),
  });

  assert.equal(client.calls, 1);
  assert.equal(result.used, true);
  assert.equal(result.limitEnforcedUpfront, true);
  assert.deepEqual(result.warnings, []);
});

test("without a price the limit is named honestly instead of pretended", async () => {
  const session = await freshSession("no-price");
  fill(session, 8);
  const client = countingClient(() => "Kurzer Handoff.");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
    lookupPrice: async () => null,
  });

  assert.equal(client.calls, 1);
  assert.equal(result.limitEnforcedUpfront, false);
  assert.equal(result.estimatedCostUsd, null);
  assert.match(result.warnings.join("\n"), /could not be checked upfront/);
});

test("provider-managed unknown cost skips compression instead of synthesizing a zero-dollar cap", async () => {
  const session = await freshSession("unknown-provider-cost");
  fill(session, 8);
  const client = countingClient(() => "must not run");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
    costKnowledge: "unknown",
    lookupPrice: async () => null,
  });

  assert.equal(client.calls, 0);
  assert.equal(result.used, false);
  assert.equal(result.skipReason, "cost-unknown");
  assert.equal(result.costKnowledge, "unknown");
  assert.equal(result.costUsd, 0);
  assert.equal(result.limitEnforcedUpfront, false);
  assert.match(result.warnings.join("\n"), /provider-managed|unknown/i);
  assert.doesNotMatch(result.warnings.join("\n"), /kostenlos|0(?:[,.]0+)?\s*\$/i);
});

test("an actual cost above the limit is reported clearly", async () => {
  const session = await freshSession("overrun");
  fill(session, 8);
  const client = countingClient(() => "Kurzer Handoff.", 0.5);

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always", compressorMaxCostUsd: 0.05 }),
    session,
    lookupPrice: async () => price(1e-9, 1e-9),
  });

  assert.equal(result.costUsd, 0.5);
  assert.match(result.warnings.join("\n"), /blew past its limit/);
});

test("an empty handoff falls back to the raw context", async () => {
  const session = await freshSession("empty");
  fill(session, 4);
  const client = countingClient(() => "   ");

  const result = await compressContext({
    client: client.client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, false);
  assert.equal(result.skipReason, "empty-handoff");
  assert.equal(result.handoff, uncompressedContext(session));
});

test("the compressor handoff never owns the current request", async () => {
  const session = await freshSession("prompt-owner");
  fill(session, 4);
  let capturedInput = "";
  const client = {
    callModel(request: { input: string }) {
      capturedInput = request.input;
      return {
        getText: async () => "Kurzer Handoff.",
        getResponse: async () => ({ usage: { cost: 0.002 } }),
      };
    },
  };

  await compressContext({
    client: client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.doesNotMatch(capturedInput, /CURRENT REQUEST SENTINEL/);
  assert.equal(capturedInput, uncompressedContext(session));
});

test("the compressor call reads its OWN reasoningByModel entry, never the main model's", async () => {
  const session = await freshSession("compressor-reasoning");
  fill(session, 4);
  let capturedReasoning: unknown = "unset";
  const client = {
    callModel(request: { reasoning?: unknown }) {
      capturedReasoning = request.reasoning;
      return {
        getText: async () => "Kurzer Handoff.",
        getResponse: async () => ({ usage: { cost: 0.002 } }),
      };
    },
  };
  const compressorConfig = config({
    compressionMode: "always",
    mainModel: "vendor/main",
    compressorModel: "vendor/compressor",
  });
  // Deliberately different settings per role: a bleed-through from main
  // would show up as "low" reaching the compressor call.
  compressorConfig.reasoningByModel = {
    "vendor/main": { mode: "effort", effort: "low" },
    "vendor/compressor": { mode: "effort", effort: "high" },
  };

  await compressContext({
    client: client as never,
    config: compressorConfig,
    session,
  });

  assert.deepEqual(capturedReasoning, { enabled: true, effort: "high" });
});

test("a compressor model without reasoning support gets no reasoning field even when a role-specific effort is stored", async () => {
  const session = await freshSession("compressor-no-reasoning");
  fill(session, 4);
  let capturedReasoning: unknown = "unset";
  const client = {
    callModel(request: { reasoning?: unknown }) {
      capturedReasoning = request.reasoning;
      return {
        getText: async () => "Kurzer Handoff.",
        getResponse: async () => ({ usage: { cost: 0.002 } }),
      };
    },
  };
  const compressorConfig = config({
    compressionMode: "always",
    compressorModel: "vendor/plain-compressor",
  });
  compressorConfig.reasoningByModel = {
    "vendor/plain-compressor": { mode: "effort", effort: "high" },
  };

  const result = await compressContext({
    client: client as never,
    config: compressorConfig,
    session,
    modelInfo: { id: "vendor/plain-compressor", supportedParameters: [] },
  });

  assert.equal(capturedReasoning, undefined);
  assert.match(result.warnings.join("\n"), /reports no reasoning support/);
});

test("a compressor call with the default auto setting stays byte-identical to today: no reasoning field, no warning", async () => {
  const session = await freshSession("compressor-auto-default");
  fill(session, 4);
  let sawReasoningKey = "unset";
  const client = {
    callModel(request: Record<string, unknown>) {
      sawReasoningKey = "reasoning" in request ? "present" : "absent";
      return {
        getText: async () => "Kurzer Handoff.",
        getResponse: async () => ({ usage: { cost: 0.002 } }),
      };
    },
  };

  const result = await compressContext({
    client: client as never,
    config: config({ compressionMode: "always" }),
    session,
    lookupPrice: async () => price(1e-8, 2e-8),
  });

  assert.equal(sawReasoningKey, "absent");
  assert.deepEqual(result.warnings, []);
});

test("a compressor failure after provider usage returns a fallback and preserves the incurred cost once", async () => {
  const session = await freshSession("post-usage-failure");
  fill(session, 4);
  const client = {
    callModel(request: {
      hooks: { PostModelCall: Array<{ handler: (payload: unknown) => void }> };
    }) {
      request.hooks.PostModelCall[0]?.handler({ usage: { cost: 0.007 } });
      return {
        getText: async () => {
          throw new Error("compressor stream failed after usage");
        },
        getResponse: async () => ({ usage: { cost: 0.007 } }),
      };
    },
  };

  const result = await compressContext({
    client: client as never,
    config: config({ compressionMode: "always" }),
    session,
  });

  assert.equal(result.used, false);
  assert.equal(result.skipReason, "failed");
  assert.equal(result.handoff, uncompressedContext(session));
  assert.equal(result.costUsd, 0.007);
  assert.match(result.warnings.join("\n"), /stream failed after usage/);
});

// --- helpers -------------------------------------------------------------

async function freshSession(label: string): Promise<SessionStore> {
  const workspace = await mkdtemp(join(tmpdir(), `routercode-compress-${label}-`));
  return SessionStore.open(workspace, join(workspace, ".state"));
}

function fill(session: SessionStore, turns: number): void {
  for (let index = 0; index < turns; index += 1) {
    session.addTurn(
      index % 2 === 0 ? "user" : "assistant",
      `Turn ${index} mit etwas Inhalt, damit der Kontext nicht winzig ist.`,
    );
  }
}

function config(overrides: Partial<OrcodeConfig>): OrcodeConfig {
  return { ...DEFAULT_CONFIG, ...overrides, reasoningByModel: {} };
}

function price(prompt: number, completion: number): CompressorPrice {
  return {
    promptUsdPerToken: prompt,
    completionUsdPerToken: completion,
  };
}

function countingClient(
  handoff: () => string,
  costUsd = 0.002,
): { client: unknown; calls: number } {
  const state = {
    calls: 0,
    client: {
      callModel() {
        state.calls += 1;
        return {
          getText: async () => handoff(),
          getResponse: async () => ({ usage: { cost: costUsd } }),
        };
      },
    },
  };
  return state;
}
