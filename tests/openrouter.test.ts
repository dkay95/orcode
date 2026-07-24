import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterService } from "../src/openrouter.js";
import {
  SdkReconnectMonitor,
  formatConnectionEvent,
} from "../src/reconnect.js";
import { redactSensitive } from "../src/session.js";

test("API key is required and short keys are rejected", () => {
  const service = new OpenRouterService();
  assert.throws(() => service.requireKey(), /Kein OpenRouter API-Key/);
  assert.throws(() => service.setKey("short"), /ungültig/);
});

test("key origins track keychain loading, replacement, and forgetting", () => {
  const service = new OpenRouterService(
    "sk-or-v1-this-is-a-keychain-test-secret",
    undefined,
    { inference: "keychain" },
  );
  assert.equal(service.keyOrigin, "keychain");

  service.setKey("sk-or-v1-this-is-an-interactive-test-secret");
  assert.equal(service.keyOrigin, "interactive");

  service.forgetKey();
  assert.equal(service.keyOrigin, "none");
});

test("errors redact the in-memory key", () => {
  const secret = "sk-or-v1-this-is-a-test-secret";
  const management = "sk-or-v1-this-is-a-management-secret";
  const service = new OpenRouterService(secret, management);
  const safe = service.safeMessage(
    new Error(`request failed for ${secret} and ${management}`),
  );
  assert.doesNotMatch(safe, /this-is-a-test-secret/);
  assert.doesNotMatch(safe, /this-is-a-management-secret/);
  assert.match(safe, /\[REDACTED\]/);
});

test("management key has separate in-memory lifecycle", () => {
  const service = new OpenRouterService("sk-or-v1-this-is-a-test-secret");
  assert.equal(service.hasManagementKey, false);
  assert.throws(() => service.setManagementKey("short"), /ungültig/);
  service.setManagementKey("sk-or-v1-this-is-a-management-secret");
  assert.equal(service.hasManagementKey, true);
  service.forgetManagementKey();
  assert.equal(service.hasManagementKey, false);
});

test("session redaction removes pasted API keys", () => {
  const redacted = redactSensitive(
    "one sk-or-v1-abcdefghijklmnopqrstuvwxyz and sk-abcdefghijklmnopqrstuv",
  );
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /\[REDACTED_OPENROUTER_KEY\]/);
  assert.match(redacted, /\[REDACTED_API_KEY\]/);
});

test("SDK reconnect monitor reports retry and restored connection", () => {
  const events: Parameters<ConstructorParameters<typeof SdkReconnectMonitor>[0]>[0][] = [];
  const monitor = new SdkReconnectMonitor((event) => events.push(event));

  monitor.beforeRequest("createResponses");
  monitor.afterError("createResponses", new Response("", { status: 503 }));
  monitor.beforeRequest("createResponses");
  monitor.afterSuccess("createResponses");

  assert.deepEqual(
    events.map((event) => event.phase),
    ["retry-scheduled", "retrying", "restored"],
  );
  assert.equal(events[1]?.attempt, 2);
  assert.match(formatConnectionEvent(events[1]!), /Reconnect-Versuch 2/);
  assert.match(formatConnectionEvent(events[2]!), /wiederhergestellt/);
});

test("REST requests reconnect after a transient OpenRouter response", async () => {
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary", {
        status: 503,
        headers: { "retry-after-ms": "0" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const service = new OpenRouterService();
    service.onConnectionEvent((event) => events.push(event.phase));
    assert.deepEqual(await service.listModels(), []);
    assert.equal(attempts, 2);
    assert.deepEqual(events, [
      "retry-scheduled",
      "retrying",
      "restored",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
