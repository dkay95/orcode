import assert from "node:assert/strict";
import test from "node:test";

import { tool } from "@openrouter/agent";
import { z } from "zod";

import type { RouteIdentityV1 } from "../src/backends.js";
import {
  createKimiCodeModelRuntime,
  type KimiRuntimeBindingProof,
} from "../src/model-runtime.js";
import {
  createOpenRouterModelRuntime,
  type OpenRouterService,
} from "../src/openrouter.js";
import type {
  ProviderCredentialAuthorityLike,
  ProviderCredentialUseContext,
} from "../src/provider-authority.js";

const KIMI_ROUTE: RouteIdentityV1 = Object.freeze({
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "acct_kimi_runtime_fixture",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "k3",
  canonicalModelId: "k3",
  resolutionState: "resolved",
});

const KIMI_PROOF: KimiRuntimeBindingProof = Object.freeze({
  version: 1,
  stateRevision: 17,
  generation: 23,
  connectionId: "connection-kimi-runtime",
  backendId: "kimi-code",
  accountFingerprint: KIMI_ROUTE.accountFingerprint,
  billingRealm: "kimi-code-membership-provider-managed-overage",
  canonicalModelId: "k3",
});

const OPENROUTER_ROUTE: RouteIdentityV1 = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "acct_openrouter_runtime_fixture",
  billingRealm: "openrouter-payg",
  requestedModelId: "vendor/primary",
  canonicalModelId: "vendor/primary",
  resolutionState: "resolved",
});

const HEALTHY_BALANCE = {
  key: { limit: 10, limitRemaining: 9, usage: 1 },
  credits: { totalCredits: 20, totalUsage: 2, remaining: 18 },
};

function chatChunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null = null,
  usage: Record<string, unknown> | null = null,
): object {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_775_000_000,
    model: "k3",
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    usage,
  };
}

function sseResponse(events: readonly object[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function authorityContext(overrides: Partial<ProviderCredentialUseContext["binding"]> = {}): ProviderCredentialUseContext {
  return {
    source: "saved",
    binding: {
      version: 2,
      stateRevision: KIMI_PROOF.stateRevision,
      connectionId: KIMI_PROOF.connectionId,
      backendId: "kimi-code",
      enabled: true,
      credentialPointer: {
        kind: "versioned",
        slot: { version: 1, kind: "kimi-code", id: "11111111-1111-4111-8111-111111111111" },
      },
      accountFingerprint: KIMI_PROOF.accountFingerprint,
      billingRealm: KIMI_PROOF.billingRealm,
      isDefault: true,
      ...overrides,
    },
    candidatePermit: Object.freeze({ version: 1 }),
    publishIfCurrent: async () => {},
  };
}

test("the OpenRouter runtime projection preserves the exact legacy dispatch fields and service objects", async () => {
  const client = { callModel() { throw new Error("not used"); } };
  const listeners: unknown[] = [];
  let clientCalls = 0;
  const service = {
    client: ({ scope }: { scope?: string }) => {
      clientCalls += 1;
      assert.equal(scope, "main");
      return client;
    },
    checkBalance: async () => HEALTHY_BALANCE,
    listModels: async () => [{
      id: "vendor/primary",
      name: "Primary",
      description: "",
      contextLength: 131_072,
      promptPrice: 0.000_001,
      completionPrice: 0.000_002,
      supportedParameters: ["reasoning", "tools"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      reasoning: {
        mandatory: false,
        supportedEfforts: ["low", "high"],
        supportsMaxTokens: false,
      },
    }],
    onConnectionEvent: (listener: unknown) => {
      listeners.push(listener);
      return () => {};
    },
    safeMessage: () => "safe-openrouter",
  } as unknown as OpenRouterService;
  const runtime = createOpenRouterModelRuntime(service, {
    mainModel: "vendor/primary",
    fallbackModels: ["vendor/fallback", "vendor/primary"],
    provider: {
      sort: "latency",
      dataCollection: "deny",
      only: ["provider-a"],
      allowFallbacks: false,
    },
  }, OPENROUTER_ROUTE);

  assert.equal(runtime.backendId, "openrouter");
  assert.equal(runtime.createClient({ route: OPENROUTER_ROUTE, scope: "main" }), client);
  assert.deepEqual(await runtime.inspectSpend(), { kind: "known", balance: HEALTHY_BALANCE });
  assert.deepEqual(runtime.dispatchFields({ route: OPENROUTER_ROUTE, allowWeb: true }), {
    backendId: "openrouter",
    models: ["vendor/primary", "vendor/fallback"],
    provider: {
      sort: "latency",
      dataCollection: "deny",
      only: ["provider-a"],
      allowFallbacks: false,
    },
    plugins: [{ id: "web", maxResults: 5 }],
  });
  assert.deepEqual(await runtime.listModels("vendor/primary"), [{
    id: "vendor/primary",
    name: "Primary",
    contextLength: 131_072,
    reasoning: {
      mandatory: false,
      supportedEfforts: ["low", "high"],
      supportsMaxTokens: false,
    },
    price: {
      kind: "known",
      promptUsdPerToken: 0.000_001,
      completionUsdPerToken: 0.000_002,
    },
  }]);
  runtime.onConnectionEvent(() => {});
  assert.equal(listeners.length, 1);
  assert.equal(runtime.safeMessage(new Error("raw")), "safe-openrouter");

  const foreignRoute: RouteIdentityV1 = {
    ...OPENROUTER_ROUTE,
    accountFingerprint: "acct_openrouter_foreign",
  };
  assert.throws(
    () => runtime.createClient({ route: foreignRoute, scope: "main" }),
    /route|binding/i,
  );
  assert.throws(
    () => runtime.dispatchFields({ route: foreignRoute, allowWeb: false }),
    /route|binding/i,
  );
  assert.equal(clientCalls, 1, "a foreign OpenRouter route must fail before service client access");
});

test("the OpenRouter runtime keeps the legacy variable-price sentinel unknown", async () => {
  const service = {
    client: () => ({ callModel() { throw new Error("not used"); } }),
    checkBalance: async () => HEALTHY_BALANCE,
    listModels: async () => [{
      id: "openrouter/auto",
      name: "OpenRouter Auto",
      description: "",
      contextLength: 200_000,
      promptPrice: -1,
      completionPrice: -1,
      supportedParameters: ["tools"],
      inputModalities: ["text"],
      outputModalities: ["text"],
    }],
    onConnectionEvent: () => () => {},
    safeMessage: () => "safe-openrouter",
  } as unknown as OpenRouterService;
  const route: RouteIdentityV1 = {
    ...OPENROUTER_ROUTE,
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto",
  };
  const runtime = createOpenRouterModelRuntime(service, {
    mainModel: "openrouter/auto",
    fallbackModels: [],
    provider: {},
  }, route);

  assert.deepEqual(await runtime.listModels("openrouter/auto"), [{
    id: "openrouter/auto",
    name: "OpenRouter Auto",
    contextLength: 200_000,
    reasoning: undefined,
    price: { kind: "unknown" },
  }]);
});

test("the Kimi runtime is secretless, reports unknown spend and price, and emits no OpenRouter dispatch fields", async () => {
  let authorityRequests = 0;
  let networkRequests = 0;
  let deadlineRequests = 0;
  const exactDeadlineAt = 1_775_000_045_000;
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential(request, use) {
      authorityRequests += 1;
      assert.equal(request.backendId, "kimi-code");
      assert.equal(request.connectionId, KIMI_PROOF.connectionId);
      assert.equal(request.environmentEligibility, "forbidden");
      assert.equal(request.purpose, "runtime-bind");
      assert.equal(request.deadlineAt, exactDeadlineAt);
      return { kind: "available", value: await use("kimi-secret-runtime", authorityContext()) };
    },
  };
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority,
    fetch: async (input, init) => {
      networkRequests += 1;
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "Bearer kimi-secret-runtime");
      assert.match(request.headers.get("user-agent") ?? "", /^orcode\//);
      return sseResponse([
        chatChunk("chatcmpl-runtime", { role: "assistant", content: "Hallo" }, "stop", {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      ]);
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => {
      deadlineRequests += 1;
      return exactDeadlineAt;
    },
  });

  assert.equal(runtime.backendId, "kimi-code");
  assert.deepEqual(await runtime.inspectSpend(), { kind: "unknown" });
  assert.deepEqual(await runtime.listModels("k3"), [{
    id: "k3",
    name: "Kimi K3",
    contextLength: 262_144,
    reasoning: {
      defaultEffort: "high",
      defaultEnabled: true,
      mandatory: true,
      supportedEfforts: ["low", "high", "max"],
      supportsMaxTokens: false,
    },
    price: { kind: "unknown" },
  }]);
  assert.deepEqual(runtime.dispatchFields({ route: KIMI_ROUTE, allowWeb: true }), {
    backendId: "kimi-code",
    model: "k3",
  });
  const text = await runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "Hallo", tools: [] })
    .getText();
  assert.equal(text, "Hallo");
  assert.equal(authorityRequests, 1);
  assert.equal(networkRequests, 1);
  assert.equal(deadlineRequests, 1);
});

test("the Kimi authority callback closes before a tool runs and is reacquired for the follow-up model request", async () => {
  let acquisitions = 0;
  let openCallbacks = 0;
  let deadlineRequests = 0;
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential(_request, use) {
      acquisitions += 1;
      openCallbacks += 1;
      try {
        return { kind: "available", value: await use("kimi-secret-tool-loop", authorityContext()) };
      } finally {
        openCallbacks -= 1;
      }
    },
  };
  let upstreamCalls = 0;
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority,
    fetch: async () => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        const bytes = new TextEncoder().encode([
          ...[
          chatChunk("chatcmpl-tool", { role: "assistant", reasoning_content: "Need tool." }),
          chatChunk("chatcmpl-tool", {
            tool_calls: [{
              index: 0,
              id: "call_runtime_1",
              type: "function",
              function: { name: "read_value", arguments: "{}" },
            }],
          }, "tool_calls", {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 1 },
          }),
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`),
          "data: [DONE]\n\n",
        ].join(""));
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            assert.equal(openCallbacks, 0, "the first successful body pull must happen after authority release");
            if (sent) {
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(bytes);
          },
        }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse([
        chatChunk("chatcmpl-final", { role: "assistant", content: "Fertig" }, "stop", {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      ]);
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => {
      deadlineRequests += 1;
      return 1_775_000_045_000;
    },
  });
  const readValue = tool({
    name: "read_value",
    description: "Read one value",
    inputSchema: z.object({}),
    execute: async () => {
      assert.equal(openCallbacks, 0, "credential authority must be closed before tool execution");
      return { value: 42 };
    },
  });

  const text = await runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "Use the tool", tools: [readValue] as const })
    .getText();

  assert.equal(text, "Fertig");
  assert.equal(acquisitions, 2);
  assert.equal(upstreamCalls, 2);
  assert.equal(deadlineRequests, 2);
  assert.equal(openCallbacks, 0);
});

test("a changed authority binding fails before network and a route change evicts cached clients", async () => {
  let networkCalls = 0;
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential(_request, use) {
      return {
        kind: "available",
        value: await use("kimi-secret-stale", authorityContext({ stateRevision: 18 })),
      };
    },
  };
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority,
    fetch: async () => {
      networkCalls += 1;
      throw new Error("must not run");
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => 1_775_000_045_000,
  });
  const first = runtime.createClient({ route: KIMI_ROUTE, scope: "main" });
  assert.equal(runtime.createClient({ route: KIMI_ROUTE, scope: "main" }), first);
  await assert.rejects(
    first.callModel({ model: "k3", input: "stale", tools: [] }).getText(),
    /Kimi/i,
  );
  assert.equal(networkCalls, 0);

  const changedRoute = { ...KIMI_ROUTE, canonicalModelId: "k3-256k", requestedModelId: "k3-256k" } as RouteIdentityV1;
  assert.throws(
    () => runtime.createClient({ route: changedRoute, scope: "main" }),
    /Kimi/i,
  );
  assert.notEqual(runtime.createClient({ route: KIMI_ROUTE, scope: "main" }), first);
});

test("an SDK request for a different allowlisted model is rejected before Kimi authority", async () => {
  let authorityCalls = 0;
  let networkCalls = 0;
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential() {
        authorityCalls += 1;
        return { kind: "recovery-required" };
      },
    },
    fetch: async () => {
      networkCalls += 1;
      return new Response();
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => 1_775_000_045_000,
  });
  await assert.rejects(
    runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
      .callModel({ model: "k3-256k", input: "wrong model", tools: [] }).getText(),
    /Kimi/i,
  );
  assert.equal(authorityCalls, 0);
  assert.equal(networkCalls, 0);
});

test("missing or invalid per-request deadlines reject before Kimi authority and network", async () => {
  for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1_775_000_000_000, 1_774_999_999_999]) {
    let authorityCalls = 0;
    let networkCalls = 0;
    const runtime = createKimiCodeModelRuntime({
      route: KIMI_ROUTE,
      binding: KIMI_PROOF,
      credentialAuthority: {
        async withCredential() {
          authorityCalls += 1;
          return { kind: "recovery-required" as const };
        },
      },
      fetch: async () => {
        networkCalls += 1;
        throw new Error("must not run");
      },
      now: () => 1_775_000_000_000,
      ...(invalid === undefined
        ? {}
        : { createRequestDeadlineAt: () => invalid }),
    } as Parameters<typeof createKimiCodeModelRuntime>[0]);
    const client = runtime.createClient({ route: KIMI_ROUTE, scope: "main" });

    await assert.rejects(
      client.callModel({ model: "k3", input: "deadline", tools: [] }).getText(),
      /Kimi/i,
    );
    assert.equal(authorityCalls, 0, String(invalid));
    assert.equal(networkCalls, 0, String(invalid));
  }
});

test("the absolute deadline aborts a fetch that never returns provider headers", async () => {
  let observedSignal: AbortSignal | undefined;
  let authorityClosed = false;
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        try {
          return { kind: "available", value: await use("kimi-secret-deadline-headers", authorityContext()) };
        } finally {
          authorityClosed = true;
        }
      },
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      observedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("FETCH_HEADER_CANARY")), { once: true });
      });
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => 1_775_000_000_015,
  });

  await assert.rejects(
    runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
      .callModel({ model: "k3", input: "deadline", tools: [] }).getText(),
    (error: unknown) => {
      assert.match(String(error), /Kimi Code ist derzeit nicht erreichbar/i);
      assert.doesNotMatch(String(error), /abgebrochen/i);
      assert.doesNotMatch(String(error), /FETCH_HEADER_CANARY|kimi-secret/);
      return true;
    },
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(authorityClosed, true);
});

test("deadline and caller cancellation win when authority ignores the linked signal", async (t) => {
  await t.test("deadline crosses before a stale authority result", async () => {
    const clock = [1_000, 1_001];
    const runtime = createKimiCodeModelRuntime({
      route: KIMI_ROUTE,
      binding: KIMI_PROOF,
      credentialAuthority: {
        async withCredential() {
          return { kind: "stale" as const };
        },
      },
      fetch: async () => {
        throw new Error("network must not run");
      },
      now: () => clock.shift() ?? 1_001,
      createRequestDeadlineAt: () => 1_001,
    });

    await assert.rejects(
      runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
        .callModel({ model: "k3", input: "deadline before authority result", tools: [] }).getText(),
      (error: unknown) => {
        assert.match(String(error), /Kimi Code ist derzeit nicht erreichbar/i);
        const failure = (error as { cause?: { failure?: { code?: string; retryable?: boolean } } }).cause?.failure;
        assert.equal(failure?.code, "kimi-code-offline");
        assert.equal(failure?.retryable, true);
        return true;
      },
    );
  });

  await t.test("caller abort precedes an ignored stale authority result", async () => {
    const caller = new AbortController();
    let authorityEntered!: () => void;
    let releaseAuthority!: () => void;
    const entered = new Promise<void>((resolve) => { authorityEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    const runtime = createKimiCodeModelRuntime({
      route: KIMI_ROUTE,
      binding: KIMI_PROOF,
      credentialAuthority: {
        async withCredential() {
          authorityEntered();
          await release;
          return { kind: "stale" as const };
        },
      },
      fetch: async () => {
        throw new Error("network must not run");
      },
      now: () => 1_775_000_000_000,
      createRequestDeadlineAt: () => 1_775_000_045_000,
    });
    const pending = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
      .callModel({ model: "k3", input: "caller before authority result", tools: [] }, { signal: caller.signal })
      .getText();
    await entered;
    caller.abort(new Error("IGNORED_CALLER_ABORT_CANARY"));
    releaseAuthority();

    await assert.rejects(pending, (error: unknown) => {
      assert.match(String(error), /Die Kimi-Code-Anfrage wurde abgebrochen/i);
      const failure = (error as { cause?: { failure?: { code?: string } } }).cause?.failure;
      assert.equal(failure?.code, "kimi-code-cancelled");
      assert.doesNotMatch(String(error), /IGNORED_CALLER_ABORT_CANARY/);
      return true;
    });
  });

  await t.test("deadline crossing cancels an ignored available response body", async () => {
    const clock = [1_000, 1_000, 1_001];
    let bodyPulls = 0;
    let bodyCancels = 0;
    const runtime = createKimiCodeModelRuntime({
      route: KIMI_ROUTE,
      binding: KIMI_PROOF,
      credentialAuthority: {
        async withCredential(_request, use) {
          return { kind: "available", value: await use("kimi-secret-deadline-response", authorityContext()) };
        },
      },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          bodyPulls += 1;
        },
        cancel() {
          bodyCancels += 1;
        },
      }, { highWaterMark: 0 }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      now: () => clock.shift() ?? 1_001,
      createRequestDeadlineAt: () => 1_001,
    });

    await assert.rejects(
      runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
        .callModel({ model: "k3", input: "deadline response", tools: [] }).getText(),
      /Kimi Code ist derzeit nicht erreichbar/i,
    );
    assert.equal(bodyCancels, 1);
    assert.equal(bodyPulls, 0);
  });
});

test("Kimi HTTP 408 and 5xx outcomes stay retryable offline even with malformed bodies", async (t) => {
  for (const status of [408, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const runtime = createKimiCodeModelRuntime({
        route: KIMI_ROUTE,
        binding: KIMI_PROOF,
        credentialAuthority: {
          async withCredential(_request, use) {
            return { kind: "available", value: await use("kimi-secret-retryable-http", authorityContext()) };
          },
        },
        fetch: async () => new Response("not-json PRIVATE_HTTP_BODY_CANARY", {
          status,
          headers: { "content-type": "text/plain", "x-private": "PRIVATE_HTTP_HEADER_CANARY" },
        }),
        now: () => 1_775_000_000_000,
        createRequestDeadlineAt: () => 1_775_000_045_000,
      });

      await assert.rejects(
        runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
          .callModel({ model: "k3", input: "retryable http", tools: [] }).getText(),
        (error: unknown) => {
          assert.match(String(error), /Kimi Code ist derzeit nicht erreichbar/i);
          assert.doesNotMatch(String(error), /PRIVATE_HTTP|not-json|kimi-secret/);
          return true;
        },
      );
    });
  }
});

test("an absolute deadline beyond the platform timer maximum is not truncated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const now = 1_775_000_000_000;
  const timerMaximum = 2_147_483_647;
  let observedSignal: AbortSignal | undefined;
  let fetchEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    fetchEntered = resolve;
  });
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        return { kind: "available", value: await use("kimi-secret-long-deadline", authorityContext()) };
      },
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      observedSignal = request.signal;
      fetchEntered();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("LONG_DEADLINE_CANARY")), { once: true });
      });
    },
    now: () => now,
    createRequestDeadlineAt: () => now + timerMaximum + 1,
  });

  const outcome = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "long deadline", tools: [] })
    .getText()
    .then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
  await entered;

  t.mock.timers.tick(timerMaximum);
  assert.equal(observedSignal?.aborted, false, "the platform timer ceiling must only re-arm the deadline");
  t.mock.timers.tick(1);
  const result = await outcome;
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(String(result.error), /Kimi/i);
    assert.doesNotMatch(String(result.error), /LONG_DEADLINE_CANARY|kimi-secret/);
  }
  assert.equal(observedSignal?.aborted, true);
});

test("a forward clock jump aborts on the first long-deadline timer segment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timerMaximum = 2_147_483_647;
  let now = 1_775_000_000_000;
  const deadlineAt = now + (timerMaximum * 2) + 100;
  let observedSignal: AbortSignal | undefined;
  let fetchEntered!: () => void;
  const entered = new Promise<void>((resolve) => { fetchEntered = resolve; });
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        return { kind: "available", value: await use("kimi-secret-clock-jump", authorityContext()) };
      },
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      observedSignal = request.signal;
      fetchEntered();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("CLOCK_JUMP_CANARY")), { once: true });
      });
    },
    now: () => now,
    createRequestDeadlineAt: () => deadlineAt,
  });
  const outcome = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "clock jump", tools: [] })
    .getText()
    .then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
  await entered;

  now = deadlineAt + 1;
  t.mock.timers.tick(timerMaximum);
  const abortedAfterFirstSegment = observedSignal?.aborted ?? false;
  if (!abortedAfterFirstSegment) {
    t.mock.timers.tick(timerMaximum);
    t.mock.timers.tick(100);
  }
  const result = await outcome;
  assert.equal(abortedAfterFirstSegment, true, "the absolute clock must win over the remaining timer segments");
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(String(result.error), /Kimi Code ist derzeit nicht erreichbar/i);
    assert.doesNotMatch(String(result.error), /CLOCK_JUMP_CANARY|kimi-secret/);
  }
});

test("a partial forward clock jump shortens the already armed deadline timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let observedSignal: AbortSignal | undefined;
  let fetchEntered!: () => void;
  let releaseFetch!: () => void;
  const entered = new Promise<void>((resolve) => { fetchEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        return { kind: "available", value: await use("kimi-secret-shortened-deadline", authorityContext()) };
      },
    },
    fetch: async (input, init) => {
      observedSignal = new Request(input, init).signal;
      fetchEntered();
      await release;
      return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
    now: () => now,
    createRequestDeadlineAt: () => 10_000,
  });
  const outcome = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "shorten deadline", tools: [] })
    .getText()
    .then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
  await entered;
  now = 9_000;
  releaseFetch();
  await new Promise<void>((resolve) => setImmediate(resolve));

  t.mock.timers.tick(999);
  assert.equal(observedSignal?.aborted, false);
  t.mock.timers.tick(1);
  const abortedAtShortenedDeadline = observedSignal?.aborted ?? false;
  if (!abortedAtShortenedDeadline) t.mock.timers.tick(9_000);
  const result = await outcome;
  assert.equal(abortedAtShortenedDeadline, true, "post-authority clock progress must re-arm the shorter timer");
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.match(String(result.error), /Kimi Code ist derzeit nicht erreichbar/i);
});

test("provider HTTP failure classification leaves the authority as a secretless sanitized result", async () => {
  let callbackOpen = false;
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        callbackOpen = true;
        try {
          return { kind: "available", value: await use("kimi-secret-http-failure", authorityContext()) };
        } finally {
          callbackOpen = false;
        }
      },
    },
    fetch: async () => new Response(JSON.stringify({
      error: { message: "Invalid Authentication" },
      private_body: "BODY_CANARY",
    }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "x-request-id": "REQUEST_ID_CANARY",
        "x-secret": "kimi-secret-http-failure",
      },
    }),
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => 1_775_000_045_000,
  });

  await assert.rejects(
    runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
      .callModel({ model: "k3", input: "http failure", tools: [] }).getText(),
    (error: unknown) => {
      assert.equal(callbackOpen, false);
      assert.match(String(error), /Kimi/i);
      assert.doesNotMatch(String(error), /BODY_CANARY|REQUEST_ID_CANARY|kimi-secret-http-failure|Invalid Authentication/);
      return true;
    },
  );
});

test("deadline and caller abort keep their classifications while a 4xx error body is stalled", async (t) => {
  for (const trigger of ["deadline", "caller"] as const) {
    await t.test(trigger, async () => {
      let bodyCancelled = 0;
      const caller = new AbortController();
      const runtime = createKimiCodeModelRuntime({
        route: KIMI_ROUTE,
        binding: KIMI_PROOF,
        credentialAuthority: {
          async withCredential(_request, use) {
            return { kind: "available", value: await use("kimi-secret-stalled-error-body", authorityContext()) };
          },
        },
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled += 1;
          },
        }, { highWaterMark: 0 }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
        now: () => 1_775_000_000_000,
        createRequestDeadlineAt: () => trigger === "deadline"
          ? 1_775_000_000_020
          : 1_775_000_010_000,
      });
      const pending = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
        .callModel({ model: "k3", input: "stalled error body", tools: [] }, { signal: caller.signal })
        .getText();
      if (trigger === "caller") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        caller.abort(new Error("CALLER_ERROR_BODY_CANARY"));
      }
      await assert.rejects(pending, (error: unknown) => {
        assert.match(
          String(error),
          trigger === "deadline"
            ? /Kimi Code ist derzeit nicht erreichbar/i
            : /Die Kimi-Code-Anfrage wurde abgebrochen/i,
        );
        assert.doesNotMatch(String(error), /CALLER_ERROR_BODY_CANARY|kimi-secret|ungueltig|unterstützte Antwort/i);
        return true;
      });
      assert.equal(bodyCancelled, 1);
    });
  }
});

test("deadline and caller abort remain linked after headers and cancel a stalled provider body", async (t) => {
  for (const trigger of ["deadline", "caller"] as const) {
    await t.test(trigger, async () => {
      let authorityClosed = false;
      let bodyCancelled = 0;
      const caller = new AbortController();
      const runtime = createKimiCodeModelRuntime({
        route: KIMI_ROUTE,
        binding: KIMI_PROOF,
        credentialAuthority: {
          async withCredential(_request, use) {
            try {
              return { kind: "available", value: await use("kimi-secret-stalled-body", authorityContext()) };
            } finally {
              authorityClosed = true;
            }
          },
        },
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          pull() {
            assert.equal(authorityClosed, true);
          },
          cancel() {
            bodyCancelled += 1;
          },
        }, { highWaterMark: 0 }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
        now: () => 1_775_000_000_000,
        createRequestDeadlineAt: () => trigger === "deadline"
          ? 1_775_000_000_020
          : 1_775_000_010_000,
      });
      const pending = runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
        .callModel({ model: "k3", input: "stalled", tools: [] }, { signal: caller.signal })
        .getText();
      if (trigger === "caller") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        caller.abort(new Error("CALLER_ABORT_CANARY"));
      }
      await assert.rejects(pending, (error: unknown) => {
        assert.match(
          String(error),
          trigger === "deadline"
            ? /Kimi Code ist derzeit nicht erreichbar/i
            : /Die Kimi-Code-Anfrage wurde abgebrochen/i,
        );
        assert.doesNotMatch(String(error), /CALLER_ABORT_CANARY|kimi-secret/);
        return true;
      });
      assert.equal(authorityClosed, true);
      assert.equal(bodyCancelled, 1);
    });
  }
});

test("a completed provider body removes its linked deadline before it can fire", async () => {
  let observedSignal: AbortSignal | undefined;
  const runtime = createKimiCodeModelRuntime({
    route: KIMI_ROUTE,
    binding: KIMI_PROOF,
    credentialAuthority: {
      async withCredential(_request, use) {
        return { kind: "available", value: await use("kimi-secret-cleanup", authorityContext()) };
      },
    },
    fetch: async (input, init) => {
      observedSignal = new Request(input, init).signal;
      return sseResponse([
        chatChunk("chatcmpl-cleanup", { role: "assistant", content: "ok" }, "stop", {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      ]);
    },
    now: () => 1_775_000_000_000,
    createRequestDeadlineAt: () => 1_775_000_000_030,
  });
  assert.equal(await runtime.createClient({ route: KIMI_ROUTE, scope: "main" })
    .callModel({ model: "k3", input: "cleanup", tools: [] }).getText(), "ok");
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  assert.equal(observedSignal?.aborted, false);
});
