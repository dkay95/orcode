import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenRouterHttpError,
  OpenRouterService,
  describeKeyCapabilities,
  describeOpenRouterFailure,
  detectsWebSearchNeed,
  filterModels,
  modelCapabilities,
  modelsField,
  providerField,
  providerSwitchNotice,
  shouldEnableWebSearch,
  webSearchPlugin,
} from "../src/openrouter.js";
import { redactSensitive } from "../src/session.js";
import type { ModelInfo } from "../src/types.js";

const INFERENCE_KEY = "sk-or-v1-this-is-a-test-secret";
const MANAGEMENT_KEY = "sk-or-v1-this-is-a-management-secret";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function keyResponse(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      label: "RouterCode Test",
      is_free_tier: false,
      usage: 1,
      usage_daily: 1,
      usage_weekly: 1,
      usage_monthly: 1,
      limit: null,
      limit_remaining: null,
      ...extra,
    },
  });
}

function creditsResponse(): Response {
  return jsonResponse({ data: { total_credits: 10, total_usage: 4 } });
}

function bearerOf(init: RequestInit): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    description: "",
    contextLength: 8_000,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
    supportedParameters: ["tools"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Key lifecycle
// --------------------------------------------------------------------------

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
  const service = new OpenRouterService(INFERENCE_KEY, MANAGEMENT_KEY);
  const safe = service.safeMessage(
    new Error(`request failed for ${INFERENCE_KEY} and ${MANAGEMENT_KEY}`),
  );
  assert.doesNotMatch(safe, /this-is-a-test-secret/);
  assert.doesNotMatch(safe, /this-is-a-management-secret/);
  assert.match(safe, /\[REDACTED\]/);
});

test("management key has separate in-memory lifecycle", () => {
  const service = new OpenRouterService(INFERENCE_KEY);
  assert.equal(service.hasManagementKey, false);
  assert.throws(() => service.setManagementKey("short"), /ungültig/);
  service.setManagementKey(MANAGEMENT_KEY);
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

// --------------------------------------------------------------------------
// Management key evaluation
// --------------------------------------------------------------------------

test("reiner Inference-Key spart sich die nutzlose /credits-Runde", async () => {
  const stub = stubFetch((url) => {
    assert.ok(url.endsWith("/key"), `unerwarteter Aufruf: ${url}`);
    return keyResponse({ is_management_key: false });
  });
  try {
    const service = new OpenRouterService(INFERENCE_KEY);
    const balance = await service.checkBalance();
    assert.equal(stub.calls.length, 1);
    assert.equal(balance.credits, undefined);
    assert.equal(balance.capabilities?.creditsSource, "none");
    assert.equal(balance.capabilities?.accountCredits, false);
    assert.match(balance.creditsUnavailableReason ?? "", /Management-Key/);
  } finally {
    stub.restore();
  }
});

test("Inference-Key mit Management-Flag liest das Guthaben selbst", async () => {
  const stub = stubFetch((url) =>
    url.endsWith("/credits")
      ? creditsResponse()
      : keyResponse({ is_management_key: true }),
  );
  try {
    const service = new OpenRouterService(INFERENCE_KEY);
    const balance = await service.checkBalance();
    assert.equal(stub.calls.length, 2);
    assert.equal(
      bearerOf(stub.calls[1]!.init),
      `Bearer ${INFERENCE_KEY}`,
    );
    assert.equal(balance.credits?.remaining, 6);
    assert.equal(balance.capabilities?.creditsSource, "inference-key");
  } finally {
    stub.restore();
  }
});

test("gesetzter Management-Key wird für /credits benutzt", async () => {
  const stub = stubFetch((url) =>
    url.endsWith("/credits")
      ? creditsResponse()
      : keyResponse({ is_management_key: false }),
  );
  try {
    const service = new OpenRouterService(INFERENCE_KEY, MANAGEMENT_KEY);
    const balance = await service.checkBalance();
    assert.equal(stub.calls.length, 2);
    assert.equal(bearerOf(stub.calls[0]!.init), `Bearer ${INFERENCE_KEY}`);
    assert.equal(bearerOf(stub.calls[1]!.init), `Bearer ${MANAGEMENT_KEY}`);
    assert.equal(balance.capabilities?.creditsSource, "management-key");
    assert.match(balance.capabilities?.summary ?? "", /Management-Key/);
  } finally {
    stub.restore();
  }
});

test("abgelehnter Management-Key fällt auf das Key-Limit zurück", async () => {
  const stub = stubFetch((url) =>
    url.endsWith("/credits")
      ? jsonResponse({ error: { message: "No permission" } }, { status: 403 })
      : keyResponse({ is_management_key: false }),
  );
  try {
    const service = new OpenRouterService(INFERENCE_KEY, MANAGEMENT_KEY);
    const balance = await service.checkBalance();
    assert.equal(balance.credits, undefined);
    assert.equal(balance.capabilities?.accountCredits, false);
    assert.match(balance.creditsUnavailableReason ?? "", /abgelehnt/);
  } finally {
    stub.restore();
  }
});

test("Key-Fähigkeiten werden ohne Rateschritt beschrieben", () => {
  assert.equal(
    describeKeyCapabilities({ isManagementKey: false }, false).creditsSource,
    "none",
  );
  assert.equal(
    describeKeyCapabilities({ isManagementKey: true }, false).creditsSource,
    "inference-key",
  );
  assert.equal(
    describeKeyCapabilities({ isManagementKey: false }, true).creditsSource,
    "management-key",
  );
  const unknown = describeKeyCapabilities({}, false);
  assert.equal(unknown.creditsSource, "unknown");
  assert.equal(unknown.accountCredits, true);
});

// --------------------------------------------------------------------------
// Error translation
// --------------------------------------------------------------------------

test("HTTP-Fehler werden in klare deutsche Handlungsanweisungen übersetzt", () => {
  const cases: Array<{
    status: number;
    kind: string;
    message: RegExp;
    action: RegExp;
  }> = [
    { status: 401, kind: "auth", message: /abgelehnt/, action: /\/key set/ },
    { status: 402, kind: "credits", message: /Guthaben/, action: /credits/ },
    { status: 403, kind: "permission", message: /verweigert/, action: /Management-Key/ },
    { status: 404, kind: "not-found", message: /kennt dieses Modell/, action: /\/model/ },
    { status: 408, kind: "timeout", message: /Zeitüberschreitung/, action: /erneut/ },
    { status: 429, kind: "rate-limit", message: /Rate-Limit/, action: /erneut/ },
    { status: 500, kind: "provider", message: /Störung/, action: /warten/ },
    { status: 400, kind: "invalid-request", message: /abgelehnt/, action: /Modell-ID/ },
  ];
  for (const expectation of cases) {
    const failure = describeOpenRouterFailure(
      new OpenRouterHttpError(expectation.status, "Server sagt nein"),
    );
    assert.equal(failure.kind, expectation.kind, `Status ${expectation.status}`);
    assert.equal(failure.status, expectation.status);
    assert.match(failure.message, expectation.message);
    assert.match(failure.action, expectation.action);
    assert.match(failure.detail, /Server sagt nein/);
  }
});

test("Rate-Limit nennt die Wartezeit aus Retry-After", () => {
  const failure = describeOpenRouterFailure(
    new OpenRouterHttpError(429, "slow down", { retryAfterMs: 30_000 }),
  );
  assert.equal(failure.retryAfterMs, 30_000);
  assert.match(failure.action, /30 Sekunden/);
});

test("Netz-, DNS-, Timeout- und Abbruchfehler werden unterschieden", () => {
  const dns = describeOpenRouterFailure(
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    }),
  );
  assert.equal(dns.kind, "network");
  assert.match(dns.message, /DNS/);

  const refused = describeOpenRouterFailure(
    Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    }),
  );
  assert.equal(refused.kind, "network");
  assert.match(refused.action, /Proxy/);

  const timeout = describeOpenRouterFailure(
    Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
  );
  assert.equal(timeout.kind, "timeout");
  assert.match(timeout.message, /Zeitüberschreitung/);

  const cancelled = describeOpenRouterFailure(
    Object.assign(new Error("Der aktuelle Lauf wurde abgebrochen."), {
      name: "AbortError",
    }),
  );
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.message, "Der aktuelle Lauf wurde abgebrochen.");
});

test("ungültiger Key liefert Klartext statt rohem HTTP 401 und bleibt redigiert", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      { error: { message: `No auth credentials found for ${INFERENCE_KEY}` } },
      { status: 401 },
    ),
  );
  try {
    const service = new OpenRouterService(INFERENCE_KEY);
    await assert.rejects(service.checkBalance(), (error: unknown) => {
      assert.ok(error instanceof OpenRouterHttpError);
      assert.equal(error.status, 401);
      const safe = service.safeMessage(error);
      assert.match(safe, /OpenRouter hat den API-Key abgelehnt/);
      assert.match(safe, /openrouter\.ai\/keys/);
      assert.match(safe, /Details: /);
      assert.match(safe, /\[REDACTED\]/);
      assert.doesNotMatch(safe, /this-is-a-test-secret/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("Netzfehler der REST-Schicht wird übersetzt weitergereicht", async () => {
  const stub = stubFetch(() => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
  });
  try {
    const service = new OpenRouterService(INFERENCE_KEY);
    await assert.rejects(service.getCurrentKey(), (error: unknown) => {
      assert.match(String(error), /DNS/);
      assert.match(service.safeMessage(error), /Internetverbindung/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

// --------------------------------------------------------------------------
// Reconnect behaviour of the REST layer
// --------------------------------------------------------------------------

test("REST requests reconnect after a transient OpenRouter response", async () => {
  const events: string[] = [];
  let attempts = 0;
  const stub = stubFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary", {
        status: 503,
        headers: { "retry-after-ms": "0" },
      });
    }
    return jsonResponse({ data: [] });
  });

  try {
    const service = new OpenRouterService();
    service.onConnectionEvent((event) => events.push(event.phase));
    assert.deepEqual(await service.listModels(), []);
    assert.equal(attempts, 2);
    assert.deepEqual(events, ["retry-scheduled", "retrying", "restored"]);
  } finally {
    stub.restore();
  }
});

// --------------------------------------------------------------------------
// Model cache, search and capabilities
// --------------------------------------------------------------------------

const MODEL_PAYLOAD = {
  data: [
    {
      id: "vendor/cheap-tools",
      name: "Cheap Tools",
      context_length: 128_000,
      pricing: { prompt: "0.0000005", completion: "0.000001" },
      supported_parameters: ["tools", "reasoning"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "vendor/expensive-vision",
      name: "Expensive Vision",
      context_length: 1_000_000,
      pricing: { prompt: "0.00001", completion: "0.00003" },
      supported_parameters: ["tools"],
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    },
    {
      id: "vendor/chat-only",
      name: "Chat Only",
      context_length: 4_096,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
  ],
};

test("Modellliste wird zwischengespeichert und gezielt invalidiert", async () => {
  let fetches = 0;
  let clock = 1_000;
  const stub = stubFetch(() => {
    fetches += 1;
    return jsonResponse(MODEL_PAYLOAD);
  });
  try {
    const service = new OpenRouterService(undefined, undefined, {}, {
      now: () => clock,
      modelCacheTtlMs: 60_000,
    });

    const first = await service.listModels();
    const second = await service.listModels("vision", false);
    assert.equal(fetches, 1, "zweiter Aufruf muss aus dem Cache kommen");
    assert.deepEqual(first.map((entry) => entry.id), [
      "vendor/cheap-tools",
      "vendor/expensive-vision",
    ]);
    assert.deepEqual(second.map((entry) => entry.id), ["vendor/expensive-vision"]);
    assert.equal(service.modelCacheAgeMs(), 0);

    service.invalidateModelCache();
    assert.equal(service.modelCacheAgeMs(), null);
    await service.listModels();
    assert.equal(fetches, 2, "nach der Invalidierung wird neu geladen");

    clock += 59_000;
    await service.listModels();
    assert.equal(fetches, 2, "innerhalb der Gültigkeitsdauer bleibt es beim Cache");

    clock += 2_000;
    await service.listModels();
    assert.equal(fetches, 3, "nach Ablauf der Gültigkeitsdauer wird neu geladen");
  } finally {
    stub.restore();
  }
});

test("Modellsuche filtert und sortiert für die Oberfläche", async () => {
  const stub = stubFetch(() => jsonResponse(MODEL_PAYLOAD));
  try {
    const service = new OpenRouterService();
    const all = await service.loadModels();
    assert.equal(all.length, 3);

    assert.deepEqual(
      (await service.searchModels({ toolsOnly: true, imageInput: true })).map(
        (entry) => entry.id,
      ),
      ["vendor/expensive-vision"],
    );
    assert.deepEqual(
      (await service.searchModels({ freeOnly: true })).map((entry) => entry.id),
      ["vendor/chat-only"],
    );
    assert.deepEqual(
      (await service.searchModels({ sort: "context", limit: 2 })).map(
        (entry) => entry.id,
      ),
      ["vendor/expensive-vision", "vendor/cheap-tools"],
    );
    assert.deepEqual(
      (await service.searchModels({ reasoningOnly: true })).map((entry) => entry.id),
      ["vendor/cheap-tools"],
    );
    assert.equal((await service.findModel("vendor/chat-only"))?.name, "Chat Only");
    assert.equal(await service.findModel("vendor/unknown"), null);
  } finally {
    stub.restore();
  }
});

test("Modellfilter arbeiten auf Kontext, Preis, Fähigkeiten und Text", () => {
  const models = [
    model({
      id: "a/tools-big",
      name: "Tools Big",
      contextLength: 200_000,
      promptPrice: 0.000003,
      completionPrice: 0.000015,
      supportedParameters: ["tools", "reasoning"],
      intelligenceIndex: 70,
    }),
    model({
      id: "b/vision-small",
      name: "Vision Small",
      contextLength: 32_000,
      promptPrice: 0.0000001,
      completionPrice: 0.0000002,
      inputModalities: ["text", "image"],
      intelligenceIndex: 40,
    }),
    model({
      id: "c/dynamic",
      name: "Dynamic Router",
      promptPrice: -1,
      completionPrice: -1,
      supportedParameters: [],
    }),
  ];

  assert.deepEqual(
    filterModels(models, { minContextLength: 100_000 }).map((entry) => entry.id),
    ["a/tools-big"],
  );
  assert.deepEqual(
    filterModels(models, { maxPromptPricePerMillion: 1 }).map((entry) => entry.id),
    ["b/vision-small"],
  );
  assert.deepEqual(
    filterModels(models, { requiredParameters: ["reasoning"] }).map(
      (entry) => entry.id,
    ),
    ["a/tools-big"],
  );
  assert.deepEqual(
    filterModels(models, { sort: "intelligence" }).map((entry) => entry.id),
    ["a/tools-big", "b/vision-small", "c/dynamic"],
  );
  assert.deepEqual(
    filterModels(models, { search: "router", deepSearch: true }).map(
      (entry) => entry.id,
    ),
    ["c/dynamic"],
  );
  assert.deepEqual(
    filterModels(models, { search: "vision" }).map((entry) => entry.id),
    ["b/vision-small"],
  );
  assert.deepEqual(
    filterModels(models, { sort: "price" }).map((entry) => entry.id),
    ["b/vision-small", "a/tools-big", "c/dynamic"],
  );

  const capabilities = modelCapabilities(models[1]!);
  assert.equal(capabilities.imageInput, true);
  assert.equal(capabilities.tools, true);
  assert.equal(capabilities.free, false);
  assert.ok(Math.abs(capabilities.promptPricePerMillion - 0.1) < 1e-9);
  assert.equal(modelCapabilities(models[2]!).variablePricing, true);
});

// --------------------------------------------------------------------------
// Reconnect as a real operation
// --------------------------------------------------------------------------

test("reconnect baut Verbindung neu auf, prüft den Key und leert den Modellcache", async () => {
  let modelFetches = 0;
  const stub = stubFetch((url) => {
    if (url.endsWith("/models")) {
      modelFetches += 1;
      return jsonResponse(MODEL_PAYLOAD);
    }
    if (url.endsWith("/credits")) {
      return creditsResponse();
    }
    return keyResponse({ is_management_key: true });
  });
  try {
    const service = new OpenRouterService(INFERENCE_KEY);
    await service.listModels();
    await service.listModels();
    assert.equal(modelFetches, 1);

    const report = await service.reconnect();
    assert.equal(report.clientRebuilt, true);
    assert.equal(report.modelCacheCleared, true);
    assert.equal(report.credits?.remaining, 6);
    assert.equal(report.capabilities?.creditsSource, "inference-key");
    assert.equal(service.modelCacheAgeMs(), null);
    assert.match(report.message, /Modell-Cache/);
    assert.equal(report.steps.length, 3);

    await service.listModels();
    assert.equal(modelFetches, 2, "nach /reconnect wird die Liste neu geladen");
  } finally {
    stub.restore();
  }
});

test("Schlüsselwechsel verwirft zwischengespeicherte Clients", () => {
  const service = new OpenRouterService(INFERENCE_KEY);
  const first = service.client({ scope: "main" });
  assert.equal(service.client({ scope: "main" }), first);
  assert.notEqual(service.client({ scope: "compressor" }), first);
  service.setKey("sk-or-v1-this-is-another-test-secret");
  assert.notEqual(service.client({ scope: "main" }), first);
});

// --------------------------------------------------------------------------
// A3 — Ausfallsicherheit
// --------------------------------------------------------------------------

test("modelsField setzt Hauptmodell voran und dedupliziert", () => {
  assert.deepEqual(
    modelsField("openrouter/auto", ["anthropic/x", "openai/y"]),
    ["openrouter/auto", "anthropic/x", "openai/y"],
  );
  assert.deepEqual(modelsField("openrouter/auto", []), ["openrouter/auto"]);
  assert.deepEqual(
    modelsField("a/b", ["a/b", " a/b ", "c/d"]),
    ["a/b", "c/d"],
    "identische oder nur durch Leerraum verschiedene Modelle erscheinen nur einmal",
  );
});

test("providerField reicht nur gesetzte Felder durch", () => {
  assert.deepEqual(providerField({ dataCollection: "deny" }), {
    dataCollection: "deny",
  });
  assert.deepEqual(
    providerField({ sort: "price", only: ["anthropic"], ignore: [] }),
    { sort: "price", only: ["anthropic"] },
  );
  assert.deepEqual(providerField({}), {});
});

test("providerSwitchNotice meldet nur einen tatsächlichen Wechsel", () => {
  assert.equal(providerSwitchNotice("anthropic", "anthropic"), null);
  assert.equal(providerSwitchNotice(null, "anthropic"), null);
  assert.equal(providerSwitchNotice("anthropic", undefined), null);

  const notice = providerSwitchNotice("anthropic", "openai");
  assert.deepEqual(notice, {
    level: "info",
    code: "provider-switch",
    message: "Anbieter gewechselt: anthropic → openai.",
  });
});

// --------------------------------------------------------------------------
// A2 — Websuche
// --------------------------------------------------------------------------

test("detectsWebSearchNeed erkennt URL, Versionsnummer und Fehlerzitat", () => {
  assert.equal(detectsWebSearchNeed("Sieh dir https://example.com/docs an"), true);
  assert.equal(detectsWebSearchNeed("Wir sind bei Node 22.4.1 unterwegs"), true);
  assert.equal(
    detectsWebSearchNeed("Ich bekomme TypeError: x is not a function"),
    true,
  );
  assert.equal(detectsWebSearchNeed("error TS2345: Argument mismatch"), true);
  assert.equal(detectsWebSearchNeed("Schreib mir bitte eine kurze Zusammenfassung"), false);
});

test("shouldEnableWebSearch respektiert den Modus", () => {
  assert.equal(shouldEnableWebSearch("off", "https://example.com"), false);
  assert.equal(shouldEnableWebSearch("on", "Hallo"), true);
  assert.equal(shouldEnableWebSearch("auto", "Hallo"), false);
  assert.equal(shouldEnableWebSearch("auto", "https://example.com"), true);
});

test("webSearchPlugin liefert die exakte Plugin-Form", () => {
  assert.deepEqual(webSearchPlugin(), { id: "web", maxResults: 5 });
  assert.deepEqual(webSearchPlugin(3), { id: "web", maxResults: 3 });
});
