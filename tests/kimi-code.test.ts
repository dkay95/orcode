import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  KIMI_CODE_API_BASE,
  KIMI_CODE_MAX_METADATA_BODY_BYTES,
  KIMI_CODE_MODELS,
  KimiCodeRequestError,
  KimiCodeService,
  describeKimiCodeFailure,
  kimiCodeAccountFingerprint,
  type KimiCodeFailure,
} from "../src/kimi-code.js";

const MEMBERSHIP_KEY = "fixture-kimi-membership-key";
const DEADLINE_AT = 20_000;
const NOW = 10_000;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function catalogEntry(id: string): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 1_777_777_777,
    owned_by: "kimi-code",
  };
}

function catalogResponse(ids: readonly string[]): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: ids.map(catalogEntry),
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(
  status: number,
  message: string,
  canaries: FailureCanaries,
): Response {
  return new Response(JSON.stringify({
    error: {
      message,
      type: null,
      param: null,
      code: null,
    },
  }), {
    status,
    headers: failureHeaders(canaries, "application/json"),
  });
}

interface FailureCanaries {
  body: string;
  header: string;
  requestId: string;
  secret: string;
  authorization: string;
  path: string;
  dependency: string;
}

function failureCanaries(index: number): FailureCanaries {
  const secret = `sk-private-kimi-secret-${String(index).padStart(2, "0")}-${"x".repeat(32)}`;
  return {
    body: `private-kimi-body-canary-${index}`,
    header: `private-kimi-header-canary-${index}`,
    requestId: `private-kimi-request-id-${index}`,
    secret,
    authorization: `Bearer ${secret}`,
    path: `https://private-kimi-origin-${index}.invalid/secret/path`,
    dependency: `private-kimi-dependency-canary-${index}`,
  };
}

function failureHeaders(
  canaries: FailureCanaries,
  contentType = "application/json",
): Record<string, string> {
  return {
    "content-type": contentType,
    "x-private-header": canaries.header,
    "x-request-id": canaries.requestId,
    "x-private-path": canaries.path,
    "x-private-dependency": canaries.dependency,
    "x-private-body": canaries.body,
    "x-private-secret": canaries.secret,
    "x-private-authorization": canaries.authorization,
  };
}

function hostileKimiDependencyError(canaries: FailureCanaries): KimiCodeRequestError {
  const error = new KimiCodeRequestError({
    code: "kimi-code-auth-rejected",
    retryable: false,
    credential: "rejected",
    connectivity: "connected",
    spend: "unknown",
    [canaries.body]: canaries.secret,
  } as unknown as KimiCodeFailure);
  Object.assign(error, {
    dependency: canaries.dependency,
    requestId: canaries.requestId,
    path: canaries.path,
    headers: failureHeaders(canaries),
  });
  error.stack = Object.values(canaries).join(" ");
  return error;
}

function assertNoCanaries(value: unknown, canaries: FailureCanaries): void {
  const seen = new Set<unknown>();
  const publicStrings: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      publicStrings.push(candidate);
      return;
    }
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
      if (candidate !== undefined) publicStrings.push(String(candidate));
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (candidate instanceof Headers) {
      candidate.forEach((headerValue, headerName) => {
        publicStrings.push(headerName, headerValue);
      });
    }
    for (const key of Reflect.ownKeys(candidate)) {
      publicStrings.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  const serialized = publicStrings.join("\n");
  for (const canary of Object.values(canaries)) {
    assert.equal(serialized.includes(canary), false, `public failure leaked ${canary}`);
  }
}

async function rejectedFailure(
  operation: Promise<unknown>,
  canaries: FailureCanaries,
): Promise<KimiCodeFailure> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof KimiCodeRequestError);
  const failure = describeKimiCodeFailure(caught);
  assertNoCanaries(caught, canaries);
  assertNoCanaries(failure, canaries);
  assertNoCanaries([], canaries); // This boundary has no public/logging channel.
  assert.equal(Object.prototype.hasOwnProperty.call(caught, "cause"), false);
  return failure;
}

function serviceWith(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  options: Partial<ConstructorParameters<typeof KimiCodeService>[0]> = {},
): KimiCodeService {
  return new KimiCodeService({
    fetchImpl,
    now: () => NOW,
    ...options,
  });
}

test("Kimi constants freeze the reviewed Preview catalog and conservative effective contexts", () => {
  assert.equal(KIMI_CODE_API_BASE, "https://api.kimi.com/coding/v1");
  assert.deepEqual(KIMI_CODE_MODELS, [
    {
      id: "k3",
      displayName: "Kimi K3",
      advertisedMaxContext: 1_048_576,
      effectiveContextDefault: 262_144,
      reasoningEfforts: ["low", "high", "max"],
      thinkingRequired: true,
    },
    {
      id: "k3-256k",
      displayName: "Kimi K3 256K",
      advertisedMaxContext: 262_144,
      effectiveContextDefault: 262_144,
      reasoningEfforts: ["low", "high", "max"],
      thinkingRequired: true,
    },
    {
      id: "kimi-for-coding",
      displayName: "Kimi K2.7 Code",
      advertisedMaxContext: 262_144,
      effectiveContextDefault: 262_144,
      reasoningEfforts: null,
      thinkingRequired: true,
    },
    {
      id: "kimi-for-coding-highspeed",
      displayName: "Kimi K2.7 Code HighSpeed",
      advertisedMaxContext: 262_144,
      effectiveContextDefault: 262_144,
      reasoningEfforts: null,
      thinkingRequired: true,
    },
  ]);
  assert.equal(Object.isFrozen(KIMI_CODE_MODELS), true);
  for (const model of KIMI_CODE_MODELS) {
    assert.equal(Object.isFrozen(model), true);
    if (model.reasoningEfforts) assert.equal(Object.isFrozen(model.reasoningEfforts), true);
  }
});

test("metadata inspection sends one exact GET /models request and never a completion", async () => {
  const calls: FetchCall[] = [];
  const service = serviceWith(async (url, init) => {
    calls.push({ url, init });
    return catalogResponse(["kimi-for-coding"]);
  });

  const models = await service.inspectModels(MEMBERSHIP_KEY, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  });

  assert.deepEqual(models.map(({ id }) => id), ["kimi-for-coding"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.kimi.com/coding/v1/models");
  assert.equal(calls[0]?.url.includes("chat/completions"), false);
  assert.deepEqual(calls[0]?.init, {
    method: "GET",
    headers: {
      Authorization: "Bearer fixture-kimi-membership-key",
      "User-Agent": "orcode/0.4.1",
      Accept: "application/json",
    },
    redirect: "error",
    signal: calls[0]?.init.signal,
  });
  assert.equal(calls[0]?.init.body, undefined);
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
});

test("catalog intersection preserves provider order, ignores unknown IDs, and hides missing IDs", async () => {
  const service = serviceWith(async () => catalogResponse([
    "unknown-provider-model",
    "kimi-for-coding-highspeed",
    "k3",
    "another-unknown-model",
    "k3-256k",
  ]));

  const models = await service.inspectModels(MEMBERSHIP_KEY, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  });

  assert.deepEqual(models.map(({ id }) => id), [
    "kimi-for-coding-highspeed",
    "k3",
    "k3-256k",
  ]);
  assert.equal(models.some(({ id }) => id === "kimi-for-coding"), false);
  assert.equal(models[1]?.effectiveContextDefault, 262_144);
});

test("duplicate provider model IDs invalidate the complete catalog instead of reordering or deduplicating it", async () => {
  const canaries = failureCanaries(1);
  const service = serviceWith(async () => new Response(JSON.stringify({
    object: "list",
    data: [
      catalogEntry("kimi-for-coding"),
      ...Object.values(canaries).map((canary, index) => ({
        ...catalogEntry(`unknown-private-model-${index}`),
        owned_by: canary,
      })),
      catalogEntry("kimi-for-coding"),
    ],
  }), {
    status: 200,
    headers: failureHeaders(canaries),
  }));

  const failure = await rejectedFailure(service.inspectModels(MEMBERSHIP_KEY, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  }), canaries);
  assert.deepEqual(failure, {
    code: "kimi-code-invalid-response",
    retryable: false,
    credential: "unknown",
    connectivity: "unknown",
    spend: "unknown",
  });
});

test("metadata response parsing rejects malformed JSON, wrong content type, oversized bodies, and changed catalog shapes", async (t) => {
  const invalidResponses: ReadonlyArray<{
    name: string;
    response: (canaries: FailureCanaries) => Response;
  }> = [
    {
      name: "malformed JSON",
      response: (canaries) => new Response(
        `{"private":"${Object.values(canaries).join("|")}",`,
        {
        status: 200,
        headers: failureHeaders(canaries),
        },
      ),
    },
    {
      name: "wrong content type",
      response: (canaries) => new Response(JSON.stringify({
        object: "list",
        data: [],
        private: Object.values(canaries),
      }), {
        status: 200,
        headers: failureHeaders(canaries, "text/html"),
      }),
    },
    {
      name: "oversized body",
      response: (canaries) => new Response(
        `${Object.values(canaries).join("|")}${"x".repeat(KIMI_CODE_MAX_METADATA_BODY_BYTES + 1)}`,
        {
        status: 200,
        headers: failureHeaders(canaries),
        },
      ),
    },
    {
      name: "oversized declared content length",
      response: (canaries) => new Response(JSON.stringify({
        object: "list",
        data: [catalogEntry("k3")],
      }), {
        status: 200,
        headers: {
          ...failureHeaders(canaries),
          "content-length": String(KIMI_CODE_MAX_METADATA_BODY_BYTES + 1),
        },
      }),
    },
    {
      name: "unknown top-level field",
      response: (canaries) => new Response(JSON.stringify({
        object: "list",
        data: [],
        future: Object.values(canaries),
      }), {
        status: 200,
        headers: failureHeaders(canaries),
      }),
    },
    {
      name: "partial model entry",
      response: (canaries) => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "k3", owned_by: Object.values(canaries).join("|") }],
      }), {
        status: 200,
        headers: failureHeaders(canaries),
      }),
    },
    {
      name: "capability claim outside frozen schema",
      response: (canaries) => new Response(JSON.stringify({
        object: "list",
        data: [{
          ...catalogEntry("k3"),
          context_length: 1_048_576,
          private: Object.values(canaries),
        }],
      }), {
        status: 200,
        headers: failureHeaders(canaries),
      }),
    },
  ];

  for (const [index, entry] of invalidResponses.entries()) {
    await t.test(entry.name, async () => {
      const canaries = failureCanaries(10 + index);
      const service = serviceWith(async () => entry.response(canaries));
      const failure = await rejectedFailure(service.inspectModels(MEMBERSHIP_KEY, {
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }), canaries);
      assert.equal(failure.code, "kimi-code-invalid-response");
      assert.equal(failure.retryable, false);
    });
  }
});

const documentedFailures = [
  {
    name: "invalid key",
    status: 401,
    message: "The API Key appears to be invalid or may have expired. Please verify your credentials and try again.",
    expected: {
      code: "kimi-code-auth-rejected",
      retryable: false,
      credential: "rejected",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "invalid authentication",
    status: 401,
    message: "Invalid Authentication",
    expected: {
      code: "kimi-code-auth-rejected",
      retryable: false,
      credential: "rejected",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "K3 tier entitlement",
    status: 401,
    message: "Your current subscription does not have access to k3. Upgrade to an Moderato plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error",
    expected: {
      code: "kimi-code-model-unavailable",
      retryable: false,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      unavailableModelId: "k3",
    },
  },
  {
    name: "K3 1M context entitlement does not mark conservative 256K K3 unavailable",
    status: 401,
    message: "Your current plan supports only kimi-k3 up to 256K context. 1M context is available on higher-tier plans. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error",
    expected: {
      code: "kimi-code-model-unavailable",
      retryable: false,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "HighSpeed tier entitlement",
    status: 401,
    message: "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to an Allegretto plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_highspeed_error",
    expected: {
      code: "kimi-code-model-unavailable",
      retryable: false,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      unavailableModelId: "kimi-for-coding-highspeed",
    },
  },
  {
    name: "membership verification",
    status: 402,
    message: "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
    expected: {
      code: "kimi-code-membership-unavailable",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "access terminated",
    status: 403,
    message: "Access terminated.",
    expected: {
      code: "kimi-code-access-terminated",
      retryable: false,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "billing-cycle exhaustion",
    status: 403,
    message: "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    expected: {
      code: "kimi-code-limit-reached",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "limit-reached",
    },
  },
  {
    name: "rolling exhaustion",
    status: 429,
    message: "You've reached your usage limit for this period. Your quota will be refreshed in the next period.",
    expected: {
      code: "kimi-code-limit-reached",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "limit-reached",
    },
  },
  {
    name: "monthly exhaustion",
    status: 429,
    message: "You've reached kimi monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    expected: {
      code: "kimi-code-limit-reached",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "limit-reached",
    },
  },
  {
    name: "engine overload",
    status: 429,
    message: "The engine is currently overloaded, please try again later",
    expected: {
      code: "kimi-code-overloaded",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    },
  },
  {
    name: "concurrency overload",
    status: 429,
    message: "We're receiving too many requests at the moment. Please wait a moment and try again.",
    expected: {
      code: "kimi-code-overloaded",
      retryable: true,
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
    },
  },
] as const;

test("documented bounded Kimi errors map to fixed safe failure codes without invalidating entitlement failures", async (t) => {
  for (const [index, entry] of documentedFailures.entries()) {
    await t.test(entry.name, async () => {
      const canaries = failureCanaries(100 + index);
      const service = serviceWith(async () => errorResponse(
        entry.status,
        entry.message,
        canaries,
      ));
      const failure = await rejectedFailure(service.inspectModels(MEMBERSHIP_KEY, {
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }), canaries);
      assert.deepEqual(failure, entry.expected);
      if (failure.code === "kimi-code-model-unavailable") {
        assert.equal(failure.credential, "valid");
      }
    });
  }
});

test("a matching documented message with hostile structured fields never forges a classified account fact", async () => {
  const canaries = failureCanaries(190);
  const service = serviceWith(async () => new Response(JSON.stringify({
    error: {
      message: "The API Key appears to be invalid or may have expired. Please verify your credentials and try again.",
      code: canaries.dependency,
      type: canaries.body,
      param: `${canaries.secret} ${canaries.path}`,
    },
  }), {
    status: 401,
    headers: failureHeaders(canaries),
  }));

  const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  }), canaries);

  assert.deepEqual(failure, {
    code: "kimi-code-invalid-response",
    retryable: false,
    credential: "unknown",
    connectivity: "unknown",
    spend: "unknown",
  });
});

test("unknown 401/403/429 bodies never become credential rejection, termination, or quota facts", async (t) => {
  for (const [index, status] of [401, 403, 429].entries()) {
    await t.test(`HTTP ${status}`, async () => {
      const canaries = failureCanaries(200 + index);
      const service = serviceWith(async () => errorResponse(
        status,
        `Unknown provider wording ${canaries.body}`,
        canaries,
      ));
      const failure = await rejectedFailure(service.inspectModels(MEMBERSHIP_KEY, {
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }), canaries);
      assert.deepEqual(failure, {
        code: "kimi-code-invalid-response",
        retryable: false,
        credential: "unknown",
        connectivity: "unknown",
        spend: "unknown",
      });
    });
  }
});

test("5xx, DNS, TLS, timeout, and caller abort map without dependency-message leakage", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    run: (canaries: FailureCanaries) => {
      service: KimiCodeService;
      signal: AbortSignal;
      deadlineAt: number;
    };
    expectedCode: KimiCodeFailure["code"];
    retryable: boolean;
  }> = [
    {
      name: "HTTP 500",
      run: (canaries) => ({
        service: serviceWith(async () => errorResponse(500, canaries.body, canaries)),
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }),
      expectedCode: "kimi-code-offline",
      retryable: true,
    },
    {
      name: "DNS",
      run: (canaries) => ({
        service: serviceWith(async () => {
          throw Object.assign(new Error(
            `${canaries.body} ${canaries.secret} ${canaries.path} ${canaries.dependency}`,
          ), {
            code: "ENOTFOUND",
            headers: { private: canaries.header },
            requestId: canaries.requestId,
            url: canaries.path,
            dependency: canaries.dependency,
          });
        }),
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }),
      expectedCode: "kimi-code-offline",
      retryable: true,
    },
    {
      name: "TLS",
      run: (canaries) => ({
        service: serviceWith(async () => {
          throw Object.assign(new Error(
            `${canaries.body} ${canaries.secret} ${canaries.path} ${canaries.dependency}`,
          ), {
            code: "CERT_HAS_EXPIRED",
            header: canaries.header,
            requestId: canaries.requestId,
            path: canaries.path,
            dependency: canaries.dependency,
          });
        }),
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }),
      expectedCode: "kimi-code-offline",
      retryable: true,
    },
    {
      name: "timeout",
      run: (canaries) => ({
        service: serviceWith(async () => {
          throw Object.assign(new Error(
            `${canaries.body} ${canaries.secret} ${canaries.path} ${canaries.dependency}`,
          ), {
            name: "TimeoutError",
            header: canaries.header,
            requestId: canaries.requestId,
            path: canaries.path,
            dependency: canaries.dependency,
          });
        }),
        signal: new AbortController().signal,
        deadlineAt: DEADLINE_AT,
      }),
      expectedCode: "kimi-code-offline",
      retryable: true,
    },
    {
      name: "caller abort",
      run: (canaries) => {
        const controller = new AbortController();
        controller.abort(new Error(Object.values(canaries).join(" ")));
        return {
          service: serviceWith(async () => {
            throw new Error("fetch must not start for an already-aborted request");
          }),
          signal: controller.signal,
          deadlineAt: DEADLINE_AT,
        };
      },
      expectedCode: "kimi-code-cancelled",
      retryable: false,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const canaries = failureCanaries(300 + index);
      const { service, signal, deadlineAt } = entry.run(canaries);
      const failure = await rejectedFailure(service.inspectModels(MEMBERSHIP_KEY, {
        signal,
        deadlineAt,
      }), canaries);
      assert.equal(failure.code, entry.expectedCode);
      assert.equal(failure.retryable, entry.retryable);
    });
  }
});

test("5xx response bodies are byte-counted before their fixed offline classification", async () => {
  const canaries = failureCanaries(380);
  const chunks = [
    new TextEncoder().encode(JSON.stringify({ private: Object.values(canaries) })),
    new TextEncoder().encode("private-5xx-tail"),
  ];
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls];
      pulls += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const service = serviceWith(async () => new Response(body, {
    status: 500,
    headers: failureHeaders(canaries),
  }));

  const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  }), canaries);

  assert.equal(failure.code, "kimi-code-offline");
  assert.ok(pulls > 0);
});

test("injected timing dependency failures cannot escape or mask fixed public outcomes", async (t) => {
  const dependencyError = (canaries: FailureCanaries): Error => Object.assign(
    new Error(Object.values(canaries).join(" ")),
    {
      headers: failureHeaders(canaries),
      requestId: canaries.requestId,
      path: canaries.path,
      dependency: canaries.dependency,
    },
  );

  await t.test("now", async () => {
    const canaries = failureCanaries(381);
    const service = new KimiCodeService({
      fetchImpl: async () => catalogResponse(["k3"]),
      now() { throw dependencyError(canaries); },
    });
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-offline");
  });

  await t.test("now becomes non-finite", async () => {
    const canaries = failureCanaries(385);
    let reads = 0;
    const service = new KimiCodeService({
      fetchImpl: async () => catalogResponse(["k3"]),
      now() {
        reads += 1;
        return reads === 1 ? NOW : Number.NaN;
      },
    });
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-offline");
  });

  await t.test("scheduleTimeout", async () => {
    const canaries = failureCanaries(382);
    const service = serviceWith(async () => catalogResponse(["k3"]), {
      scheduleTimeout() { throw dependencyError(canaries); },
    });
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-offline");
  });

  await t.test("cancelTimeout", async () => {
    const canaries = failureCanaries(383);
    const service = serviceWith(async () => errorResponse(
      401,
      "Invalid Authentication",
      canaries,
    ), {
      scheduleTimeout() { return 1; },
      cancelTimeout() { throw dependencyError(canaries); },
    });
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-auth-rejected");
  });

  await t.test("cancelTimeout after success", async () => {
    const canaries = failureCanaries(384);
    const service = serviceWith(async () => catalogResponse(["k3"]), {
      scheduleTimeout() { return 1; },
      cancelTimeout() { throw dependencyError(canaries); },
    });
    const models = await service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    });
    assert.deepEqual(models.map(({ id }) => id), ["k3"]);
    assertNoCanaries(models, canaries);
  });
});

test("hostile dependency Kimi errors cannot leak fields or forge account classifications", async (t) => {
  await t.test("fetch rejection", async () => {
    const canaries = failureCanaries(386);
    const service = serviceWith(async () => {
      throw hostileKimiDependencyError(canaries);
    });
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-offline");
    assert.equal(failure.credential, "unknown");
  });

  await t.test("response body rejection", async () => {
    const canaries = failureCanaries(387);
    const service = serviceWith(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(hostileKimiDependencyError(canaries));
      },
    }), {
      status: 200,
      headers: failureHeaders(canaries),
    }));
    const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
      signal: new AbortController().signal,
      deadlineAt: DEADLINE_AT,
    }), canaries);
    assert.equal(failure.code, "kimi-code-invalid-response");
    assert.equal(failure.credential, "unknown");
  });
});

test("wrong-MIME discard is deadline-bounded even when stream cancellation never settles", async () => {
  const canaries = failureCanaries(388);
  const scheduled: Array<() => void> = [];
  let cancelStarted = false;
  const service = serviceWith(async () => new Response(new ReadableStream({
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => undefined);
    },
  }), {
    status: 200,
    headers: failureHeaders(canaries, "text/private-canary"),
  }), {
    scheduleTimeout(callback) {
      scheduled.push(callback);
      return 1;
    },
    cancelTimeout() {},
  });
  const operation = service.inspectModels(canaries.secret, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  });
  while (!cancelStarted) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  const result = await Promise.race([
    rejectedFailure(operation, canaries),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
  ]);
  assert.notEqual(result, null, "deadline did not settle an abort-ignoring body cancel");
  assert.equal(result?.code, "kimi-code-offline");
});

test("caller abort and deadline take precedence after a non-200 body has been read", async (t) => {
  for (const mode of ["caller", "deadline"] as const) {
    await t.test(mode, async () => {
      const canaries = failureCanaries(mode === "caller" ? 389 : 390);
      const caller = new AbortController();
      const scheduled: Array<() => void> = [];
      let statusReads = 0;
      const service = serviceWith(async () => new Proxy(errorResponse(
        401,
        "Invalid Authentication",
        canaries,
      ), {
        get(target, property) {
          if (property === "status") {
            statusReads += 1;
            if (statusReads === 4) {
              if (mode === "caller") caller.abort(new DOMException("private abort", "AbortError"));
              else scheduled[0]!();
            }
          }
          return Reflect.get(target, property, target) as unknown;
        },
      }), {
        scheduleTimeout(callback) {
          scheduled.push(callback);
          return 1;
        },
        cancelTimeout() {},
      });
      const failure = await rejectedFailure(service.inspectModels(canaries.secret, {
        signal: caller.signal,
        deadlineAt: DEADLINE_AT,
      }), canaries);
      assert.equal(statusReads, 4);
      assert.equal(
        failure.code,
        mode === "caller" ? "kimi-code-cancelled" : "kimi-code-offline",
      );
    });
  }
});

test("absolute deadline aborts an abort-ignoring fetch and late completion cannot publish a catalog", async () => {
  const canaries = failureCanaries(400);
  const scheduled: Array<() => void> = [];
  let lateResolve!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { lateResolve = resolve; });
  const service = serviceWith(async () => pending, {
    scheduleTimeout(callback) {
      scheduled.push(callback);
      return 1;
    },
    cancelTimeout() {},
  });
  const operation = service.inspectModels(MEMBERSHIP_KEY, {
    signal: new AbortController().signal,
    deadlineAt: DEADLINE_AT,
  });
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  const failure = await rejectedFailure(operation, canaries);
  assert.equal(failure.code, "kimi-code-offline");
  assert.equal(failure.retryable, true);
  lateResolve(catalogResponse(["k3"]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failure, describeKimiCodeFailure(new KimiCodeRequestError(failure)));
});

test("fingerprinting uses the exact domain-separated HMAC and never returns key material", () => {
  const hmacKey = new Uint8Array(32).fill(7);
  const normalizedKey = "fixture-kimi-membership-key";
  const digest = createHmac("sha256", hmacKey)
    .update("orcode-kimi-code-credential/v1\0", "utf8")
    .update(normalizedKey, "utf8")
    .digest("base64url");

  const fingerprint = kimiCodeAccountFingerprint(hmacKey, normalizedKey);
  assert.equal(fingerprint, `acct_kimi_${digest}`);
  assert.equal(fingerprint.includes(normalizedKey), false);
  assert.throws(
    () => kimiCodeAccountFingerprint(new Uint8Array(31), normalizedKey),
    /fingerprint/i,
  );
});
