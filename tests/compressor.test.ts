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
  assert.match(result.warnings.join("\n"), /verworfen/);
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
  assert.match(result.warnings.join("\n"), /geschätzte Kosten/);
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
  assert.match(result.warnings.join("\n"), /konnte vorab nicht geprüft werden/);
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
  assert.match(result.warnings.join("\n"), /Limit gerissen/);
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
