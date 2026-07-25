import assert from "node:assert/strict";
import test from "node:test";
import {
  RETRY_POLICY,
  SdkReconnectMonitor,
  backoffDelayMs,
  fetchWithReconnect,
  formatConnectionEvent,
  isTransientStatus,
  retryAfterMs,
  type ConnectionEvent,
} from "../src/reconnect.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

function collector(): {
  events: ConnectionEvent[];
  monitor: SdkReconnectMonitor;
} {
  const events: ConnectionEvent[] = [];
  return {
    events,
    monitor: new SdkReconnectMonitor((event) => events.push(event)),
  };
}

test("Retry-Zähler startet für jeden logischen Request neu", () => {
  const events: ConnectionEvent[] = [];
  const monitor = new SdkReconnectMonitor((event) => events.push(event), {
    scope: "main",
  });

  // First request exhausts its attempts and never succeeds.
  const first = { operationID: "createResponses" };
  for (let attempt = 1; attempt <= RETRY_POLICY.maxAttempts; attempt += 1) {
    monitor.beforeRequest(first);
    monitor.afterError(first, new Response("", { status: 503 }), {
      willRetry: attempt < RETRY_POLICY.maxAttempts,
    });
  }
  assert.deepEqual(
    events.filter((event) => event.phase === "retrying").map((event) => event.attempt),
    [2, 3],
  );

  // A brand new request must start at attempt 1 again.
  const second = { operationID: "createResponses" };
  monitor.beforeRequest(second);
  assert.equal(
    events.filter((event) => event.phase === "retrying").length,
    2,
    "der erste Versuch eines neuen Requests darf keinen Reconnect melden",
  );
  monitor.afterError(second, new Response("", { status: 503 }));
  monitor.beforeRequest(second);
  monitor.afterSuccess(second);

  const retrying = events.filter((event) => event.phase === "retrying");
  assert.equal(retrying.at(-1)?.attempt, 2);
  assert.match(formatConnectionEvent(retrying.at(-1)!), /Reconnect-Versuch 2/);

  const restored = events.at(-1)!;
  assert.equal(restored.phase, "restored");
  assert.equal(restored.attempt, 2);
  assert.match(formatConnectionEvent(restored), /2 Versuche/);
});

test("endgültig gescheiterter Request meldet keine Wiederherstellung", () => {
  const { events, monitor } = collector();
  const context = { operationID: "key" };
  monitor.beforeRequest(context);
  monitor.afterError(context, new Response("", { status: 401 }));
  assert.deepEqual(events, []);
  assert.equal(monitor.attemptOf(context), 0);
});

test("Kompressor und Hauptlauf sind unterscheidbare Kontexte", () => {
  const events: ConnectionEvent[] = [];
  const main = new SdkReconnectMonitor((event) => events.push(event), {
    scope: "main",
  });
  const compressor = new SdkReconnectMonitor((event) => events.push(event), {
    scope: "compressor",
  });

  const mainContext = { operationID: "createResponses" };
  main.beforeRequest(mainContext);
  main.afterError(mainContext, new Response("", { status: 500 }));
  main.beforeRequest(mainContext);

  const compressorContext = { operationID: "createResponses" };
  compressor.beforeRequest(compressorContext);
  compressor.afterError(compressorContext, new Response("", { status: 500 }));
  compressor.beforeRequest(compressorContext);

  const retrying = events.filter((event) => event.phase === "retrying");
  assert.deepEqual(
    retrying.map((event) => event.attempt),
    [2, 2],
  );
  assert.match(formatConnectionEvent(retrying[0]!), /Hauptlauf/);
  assert.match(formatConnectionEvent(retrying[1]!), /Kompressor/);
});

test("Backoff wächst exponentiell, jittert injizierbar und bleibt gedeckelt", () => {
  assert.equal(backoffDelayMs(1, { random: () => 0.5 }), 500);
  assert.equal(backoffDelayMs(2, { random: () => 0.5 }), 1_000);
  assert.equal(backoffDelayMs(3, { random: () => 0.5 }), 2_000);
  assert.equal(backoffDelayMs(1, { random: () => 0 }), 375);
  assert.equal(backoffDelayMs(1, { random: () => 1 }), 625);
  assert.equal(
    backoffDelayMs(9, { random: () => 1 }),
    RETRY_POLICY.maxDelayMs,
    "auch mit Jitter nie über das Maximum",
  );
});

test("Retry-After wird respektiert, aber auf 5 s gedeckelt", () => {
  assert.equal(backoffDelayMs(1, { retryAfterMs: 1_200 }), 1_200);
  assert.equal(backoffDelayMs(1, { retryAfterMs: 120_000 }), 5_000);
  assert.equal(backoffDelayMs(3, { retryAfterMs: 0 }), 0);

  assert.equal(
    retryAfterMs(new Response("", { headers: { "retry-after-ms": "250" } })),
    250,
  );
  assert.equal(
    retryAfterMs(new Response("", { headers: { "retry-after": "30" } })),
    30_000,
  );
  assert.equal(retryAfterMs(new Response("")), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

test("transiente Status sind 408, 429 und 5xx", () => {
  assert.equal(isTransientStatus(408), true);
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(401), false);
  assert.equal(isTransientStatus(404), false);
});

test("fetchWithReconnect wiederholt idempotente Anfragen höchstens dreimal", async () => {
  const { events, monitor } = collector();
  const delays: number[] = [];
  let calls = 0;

  const response = await fetchWithReconnect(
    MODELS_URL,
    {},
    {
      operation: "models",
      monitor,
      clock: {
        random: () => 0.5,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response("busy", { status: 503 });
      },
    },
  );

  assert.equal(calls, RETRY_POLICY.maxAttempts);
  assert.equal(response.status, 503);
  assert.deepEqual(delays, [500, 1_000]);
  assert.deepEqual(
    events.map((event) => event.phase),
    ["retry-scheduled", "retrying", "retry-scheduled", "retrying"],
  );
  assert.equal(events[0]?.delayMs, 500);
  assert.match(formatConnectionEvent(events[0]!), /neuer Versuch in 0,5 s/);
});

test("fetchWithReconnect deckelt Retry-After des Servers auf 5 s", async () => {
  const { monitor } = collector();
  const delays: number[] = [];
  const response = await fetchWithReconnect(
    MODELS_URL,
    {},
    {
      operation: "models",
      monitor,
      clock: {
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
      fetchImpl: async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    },
  );

  assert.equal(response.status, 429);
  assert.deepEqual(delays, [5_000, 5_000]);
});

test("nicht idempotente Anfragen werden nie wiederholt", async () => {
  const { monitor } = collector();
  let calls = 0;
  const response = await fetchWithReconnect(
    MODELS_URL,
    { method: "POST" },
    {
      operation: "createResponses",
      monitor,
      clock: { sleep: async () => {} },
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
});

test("Netzwerkfehler wird nach dem letzten Versuch weitergereicht", async () => {
  const { events, monitor } = collector();
  let calls = 0;
  await assert.rejects(
    fetchWithReconnect(
      MODELS_URL,
      {},
      {
        operation: "models",
        monitor,
        clock: { sleep: async () => {} },
        fetchImpl: async () => {
          calls += 1;
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ENOTFOUND" },
          });
        },
      },
    ),
    /fetch failed/,
  );
  assert.equal(calls, RETRY_POLICY.maxAttempts);
  assert.equal(
    events.filter((event) => event.phase === "retry-scheduled").length,
    2,
  );
});

test("Abbruchsignal beendet die Wartezeit sofort", async () => {
  const { monitor } = collector();
  const controller = new AbortController();
  const startedAt = Date.now();

  const pending = fetchWithReconnect(
    MODELS_URL,
    {},
    {
      operation: "models",
      monitor,
      signal: controller.signal,
      fetchImpl: async () =>
        new Response("", {
          status: 503,
          headers: { "retry-after": "5" },
        }),
    },
  );
  setTimeout(() => {
    controller.abort(new Error("Die Prüfung wurde abgebrochen."));
  }, 10);

  await assert.rejects(pending, /abgebrochen/);
  assert.ok(
    Date.now() - startedAt < 2_000,
    "der gedeckelte 5-Sekunden-Delay muss vorzeitig enden",
  );
});

test("bereits abgebrochene Läufe senden gar nicht erst", async () => {
  const { monitor } = collector();
  const controller = new AbortController();
  controller.abort(new Error("Vorher abgebrochen."));
  let calls = 0;
  await assert.rejects(
    fetchWithReconnect(
      MODELS_URL,
      {},
      {
        operation: "models",
        monitor,
        signal: controller.signal,
        fetchImpl: async () => {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      },
    ),
    /Vorher abgebrochen/,
  );
  assert.equal(calls, 0);
});
