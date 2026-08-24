import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackendModelDescriptor,
  ProviderInspectionRequest,
} from "../src/backends.js";
import type {
  ProviderCredentialAuthorityLike,
  ProviderCredentialUseContext,
} from "../src/provider-authority.js";
import {
  KIMI_CODE_DESCRIPTOR,
  KimiCodeBackendAdapter,
} from "../src/kimi-code-backend.js";
import {
  KimiCodeRequestError,
  KimiCodeService,
  kimiCodeAccountFingerprint,
} from "../src/kimi-code.js";

const KEY = "fixture-kimi-membership-key-backend";
const OPENROUTER_KEY = `sk-or-v1-${"o".repeat(48)}`;
const HMAC_KEY = new Uint8Array(32).fill(11);
const FINGERPRINT = kimiCodeAccountFingerprint(HMAC_KEY, KEY);
const CONNECTION_ID = "kimi-connection-local";
const DEADLINE_AT = 50_000;

async function fixedAdapterFailure(
  operation: Promise<unknown>,
  canary: string,
): Promise<KimiCodeRequestError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof KimiCodeRequestError);
  assert.equal(caught.failure.code, "kimi-code-offline");
  assert.equal(`${caught.message}\n${caught.stack ?? ""}\n${JSON.stringify(caught)}`.includes(canary), false);
  assert.equal(Object.prototype.hasOwnProperty.call(caught, "cause"), false);
  return caught;
}

function hostileAdapterKimiError(canary: string): KimiCodeRequestError {
  const error = new KimiCodeRequestError({
    code: "kimi-code-auth-rejected",
    retryable: false,
    credential: "rejected",
    connectivity: "connected",
    spend: "unknown",
  });
  Object.assign(error, { privateDependency: canary });
  error.stack = canary;
  return error;
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
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: null, param: null, code: null },
  }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "private-request-id-canary",
    },
  });
}

function bindingContext(
  request: Parameters<ProviderCredentialAuthorityLike["withCredential"]>[0],
): ProviderCredentialUseContext {
  return {
    source: "saved",
    candidatePermit: Object.freeze({ version: 1 as const }),
    async publishIfCurrent(publish) { publish(); },
    binding: {
      version: 2,
      stateRevision: 7,
      connectionId: request.connectionId,
      backendId: "kimi-code",
      enabled: true,
      credentialPointer: {
        kind: "versioned",
        slot: Object.freeze({
          version: 1,
          kind: "kimi-code",
          id: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
        }),
      },
      accountFingerprint: FINGERPRINT,
      billingRealm: "kimi-code-membership-provider-managed-overage",
      isDefault: true,
    },
  };
}

function authority(
  observed: Array<Parameters<ProviderCredentialAuthorityLike["withCredential"]>[0]>,
): ProviderCredentialAuthorityLike {
  return {
    async withCredential(request, use) {
      observed.push(request);
      return {
        kind: "available",
        value: await use(KEY, bindingContext(request)),
      };
    },
  };
}

function inspectionRequest(
  overrides: Partial<ProviderInspectionRequest> = {},
): ProviderInspectionRequest {
  return {
    connectionId: CONNECTION_ID,
    generation: 8,
    deadlineAt: DEADLINE_AT,
    signal: new AbortController().signal,
    purpose: "startup-inspect",
    environmentEligibility: "forbidden",
    ...overrides,
  };
}

test("Kimi descriptor is the single connectable Preview membership backend contract", () => {
  assert.deepEqual(KIMI_CODE_DESCRIPTOR, {
    id: "kimi-code",
    displayName: "Kimi Code",
    maturity: "preview",
    connectable: true,
    kind: "raw-model",
    credentialOwner: "orcode-keychain",
    billingRealmKind: "provider-managed",
    capabilities: { models: true, tools: true, reasoning: true },
  });
  assert.equal(Object.isFrozen(KIMI_CODE_DESCRIPTOR), true);
  assert.equal(Object.isFrozen(KIMI_CODE_DESCRIPTOR.capabilities), true);
});

test("saved inspection uses only exact Kimi authority and publishes metadata with spend unknown", async () => {
  const authorityRequests: Array<Parameters<ProviderCredentialAuthorityLike["withCredential"]>[0]> = [];
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return catalogResponse(["kimi-for-coding-highspeed", "kimi-for-coding"]);
      },
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority(authorityRequests),
    now: () => 10_000,
    createCandidateId: () => "candidate-inspection-unused",
    createConnectionId: () => "candidate-connection-unused",
  });

  const inspection = await adapter.inspect(inspectionRequest());
  assert.deepEqual(authorityRequests, [{
    backendId: "kimi-code",
    connectionId: CONNECTION_ID,
    credentialKind: "inference",
    purpose: "startup-inspect",
    environmentEligibility: "forbidden",
    allowDisabled: false,
    deadlineAt: DEADLINE_AT,
    signal: authorityRequests[0]?.signal,
  }]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "https://api.kimi.com/coding/v1/models");
  assert.equal((fetchCalls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.deepEqual(inspection, {
    backendId: "kimi-code",
    connectionId: CONNECTION_ID,
    health: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 10_000,
      generation: 8,
    },
    headline: "ready",
    accountFingerprint: FINGERPRINT,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    routeEligible: true,
    retryable: false,
    explanationCode: "kimi-code-ready",
  });
  const models = await adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), [
    "kimi-for-coding-highspeed",
    "kimi-for-coding",
  ]);
  assert.deepEqual(models.map(({ capabilities }) => capabilities), [
    { textInput: true, textOutput: true, tools: true, reasoning: true },
    { textInput: true, textOutput: true, tools: true, reasoning: true },
  ]);
  assert.equal(JSON.stringify({ inspection, models }).includes(KEY), false);
});

test("inspection metadata publishes only through current authority and newer authority failure fences prior metadata", async () => {
  let authorityMode: "ready" | "stale" | "disabled" = "ready";
  let published = 0;
  let catalogIds: readonly string[] = ["kimi-for-coding"];
  const credentialAuthority: ProviderCredentialAuthorityLike = {
    async withCredential(request, use) {
      if (authorityMode === "disabled") return { kind: "disabled" };
      const context = bindingContext(request);
      context.publishIfCurrent = async (publish) => {
        if (authorityMode === "stale") throw new Error("private-authority-stale");
        publish();
        published += 1;
      };
      try {
        return { kind: "available", value: await use(KEY, context) };
      } catch {
        return { kind: "stale" };
      }
    },
  };
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => catalogResponse(catalogIds),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority,
    now: () => 10_000,
  });

  const ready = await adapter.inspect(inspectionRequest({ generation: 8 }));
  assert.equal(ready.routeEligible, true);
  assert.equal(published, 1);

  authorityMode = "stale";
  catalogIds = ["k3"];
  const stale = await adapter.inspect(inspectionRequest({ generation: 9 }));
  assert.equal(stale.explanationCode, "kimi-code-credential-stale");
  assert.equal(published, 1);
  await assert.rejects(adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  }));

  authorityMode = "ready";
  const restored = await adapter.inspect(inspectionRequest({ generation: 10 }));
  assert.equal(restored.routeEligible, true);
  assert.equal(published, 2);

  authorityMode = "disabled";
  const disabled = await adapter.inspect(inspectionRequest({ generation: 11 }));
  assert.equal(disabled.explanationCode, "kimi-code-credential-disabled");
  await assert.rejects(adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  }));
});

test("candidate lifecycle stores only safe metadata, exact catalog, generation, and absolute deadline", async () => {
  let now = 10_000;
  const seenDeadlines: number[] = [];
  const service = new KimiCodeService({
    now: () => now,
    fetchImpl: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
      return catalogResponse(["k3", "kimi-for-coding"]);
    },
  });
  const originalInspect = service.inspectModels.bind(service);
  service.inspectModels = async (secret, request) => {
    seenDeadlines.push(request.deadlineAt);
    return originalInspect(secret, request);
  };
  const adapter = new KimiCodeBackendAdapter({
    service,
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => now,
    createCandidateId: () => "candidate-safe-metadata",
    createConnectionId: () => CONNECTION_ID,
  });

  const candidate = await adapter.connect({
    candidate: `  ${KEY}\n`,
    generation: 9,
    deadlineAt: 10_500,
    signal: new AbortController().signal,
  });
  assert.deepEqual(seenDeadlines, [10_500]);
  assert.deepEqual(candidate, {
    candidateId: "candidate-safe-metadata",
    backendId: "kimi-code",
    connectionId: CONNECTION_ID,
    accountFingerprint: FINGERPRINT,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    health: {
      credential: "valid",
      connectivity: "connected",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: 10_000,
      generation: 9,
    },
  });
  const models = await adapter.listModels({
    candidateId: candidate.candidateId,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), ["k3", "kimi-for-coding"]);
  assert.equal(JSON.stringify({ candidate, models, adapter }).includes(KEY), false);
  assert.equal("getKey" in adapter, false);
  assert.equal("rawKey" in adapter, false);

  const selected = models[1]!;
  const activated = await adapter.activate({
    candidateId: candidate.candidateId,
    model: selected,
    signal: new AbortController().signal,
  });
  assert.deepEqual(activated.route, {
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: FINGERPRINT,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding",
    canonicalModelId: "kimi-for-coding",
    resolutionState: "resolved",
  });
  assert.equal(JSON.stringify(activated).includes(KEY), false);

  now = 10_501;
  await assert.rejects(
    adapter.listModels({
      candidateId: candidate.candidateId,
      signal: new AbortController().signal,
    }),
    (error: unknown) => (
      error instanceof Error
      && "failure" in error
      && (error as { failure: { code: string } }).failure.code === "kimi-code-offline"
    ),
  );
  await assert.rejects(adapter.listModels({
    candidateId: candidate.candidateId,
    signal: new AbortController().signal,
  }));
});

test("candidate publication rechecks the absolute deadline after candidate ID creation", async () => {
  let now = 10_000;
  const deadlineAt = 10_500;
  const candidateId = "candidate-created-at-deadline";
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => catalogResponse(["k3"]),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => now,
    createCandidateId: () => {
      now = deadlineAt;
      return candidateId;
    },
  });

  await assert.rejects(
    adapter.connect({
      connectionId: CONNECTION_ID,
      candidate: KEY,
      generation: 9,
      deadlineAt,
      signal: new AbortController().signal,
    }),
    (error: unknown) => (
      error instanceof KimiCodeRequestError
      && error.failure.code === "kimi-code-offline"
    ),
  );
  await assert.rejects(adapter.listModels({
    candidateId,
    signal: new AbortController().signal,
  }));
});

test("activation accepts only the exact model object from that candidate catalog", async () => {
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => catalogResponse(["k3"]),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
    createCandidateId: () => "candidate-exact-model",
    createConnectionId: () => CONNECTION_ID,
  });
  const candidate = await adapter.connect({
    candidate: KEY,
    generation: 4,
    deadlineAt: DEADLINE_AT,
    signal: new AbortController().signal,
  });
  const [model] = await adapter.listModels({
    candidateId: candidate.candidateId,
    signal: new AbortController().signal,
  });
  assert.ok(model);

  const forged: BackendModelDescriptor = {
    ...model,
    displayName: "Forged K3",
  };
  await assert.rejects(
    adapter.activate({
      candidateId: candidate.candidateId,
      model: forged,
      signal: new AbortController().signal,
    }),
    /model selection is invalid/i,
  );
  await adapter.activate({
    candidateId: candidate.candidateId,
    model,
    signal: new AbortController().signal,
  });
});

test("recognized entitlement 401 reuses only an unexpired same-account catalog without extending it", async () => {
  let mode: "catalog" | "entitlement" = "catalog";
  let now = 100;
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => now,
      fetchImpl: async () => mode === "catalog"
        ? catalogResponse(["k3", "k3-256k", "kimi-for-coding"])
        : errorResponse(
            401,
            "Your current subscription does not have access to k3. Upgrade to an Moderato plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error",
          ),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => now,
  });
  const first = await adapter.inspect(inspectionRequest({
    generation: 8,
    deadlineAt: 200,
  }));
  assert.equal(first.routeEligible, true);
  mode = "entitlement";
  now = 150;
  const second = await adapter.inspect(inspectionRequest({
    generation: 9,
    deadlineAt: 400,
  }));
  assert.equal(second.health.credential, "valid");
  assert.equal(second.accountFingerprint, FINGERPRINT);
  assert.equal(second.explanationCode, "kimi-code-model-unavailable");
  assert.equal(second.routeEligible, true);
  const models = await adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), [
    "k3-256k",
    "kimi-for-coding",
  ]);

  now = 200;
  await assert.rejects(adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  }));
});

test("expired prior catalog cannot turn a later entitlement failure into a ready route", async () => {
  let mode: "catalog" | "entitlement" = "catalog";
  let now = 100;
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => now,
      fetchImpl: async () => mode === "catalog"
        ? catalogResponse(["k3", "k3-256k", "kimi-for-coding"])
        : errorResponse(
            401,
            "Your current subscription does not have access to k3. Upgrade to an Moderato plan or above. Upgrade: https://www.kimi.com/membership/pricing?from=server_k3_error",
          ),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => now,
  });

  const first = await adapter.inspect(inspectionRequest({
    generation: 8,
    deadlineAt: 200,
  }));
  assert.equal(first.routeEligible, true);

  mode = "entitlement";
  now = 300;
  const second = await adapter.inspect(inspectionRequest({
    generation: 9,
    deadlineAt: 400,
  }));
  assert.equal(second.health.credential, "valid");
  assert.equal(second.accountFingerprint, FINGERPRINT);
  assert.equal(second.explanationCode, "kimi-code-model-unavailable");
  assert.equal(second.routeEligible, false);
  assert.notEqual(second.headline, "ready");
  await assert.rejects(adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  }));
});

test("invalid-key inspection rejects only the credential dimension and exposes no body, header, request, or key canary", async () => {
  const privateValues = [
    "private-body-canary",
    "private-request-id-canary",
    KEY,
  ];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => errorResponse(
        401,
        "The API Key appears to be invalid or may have expired. Please verify your credentials and try again.",
      ),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const inspection = await adapter.inspect(inspectionRequest());
  assert.equal(inspection.health.credential, "rejected");
  assert.notEqual(inspection.headline, "ready");
  assert.equal(inspection.routeEligible, false);
  assert.equal(inspection.retryable, false);
  assert.equal(inspection.explanationCode, "kimi-code-auth-rejected");
  const serialized = JSON.stringify(inspection);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

test("membership verification failure is never presented as ready", async () => {
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => errorResponse(
        402,
        "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
      ),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const inspection = await adapter.inspect(inspectionRequest());

  assert.equal(inspection.routeEligible, false);
  assert.equal(inspection.headline, "unknown");
  assert.equal(inspection.explanationCode, "kimi-code-membership-unavailable");
  assert.equal(inspection.health.credential, "valid");
  assert.equal(inspection.health.connectivity, "connected");
});

test("HTTP overload stays connectivity-connected but is explicitly non-ready", async () => {
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => errorResponse(
        429,
        "The engine is currently overloaded, please try again later",
      ),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const inspection = await adapter.inspect(inspectionRequest());

  assert.equal(inspection.health.connectivity, "connected");
  assert.equal(inspection.routeEligible, false);
  assert.equal(inspection.headline, "unknown");
  assert.equal(inspection.explanationCode, "kimi-code-overloaded");
  assert.equal(inspection.retryable, true);
});

test("older inspection success cannot publish while a newer same-generation inspection is pending", async () => {
  const responses: Array<(response: Response) => void> = [];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const older = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const newer = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  responses[0]!(catalogResponse(["k3"]));
  const olderResult = await older;
  let pendingListResult: unknown;
  try {
    pendingListResult = await adapter.listModels({
      connectionId: CONNECTION_ID,
      signal: new AbortController().signal,
    });
  } catch (error) {
    pendingListResult = error;
  }
  responses[1]!(catalogResponse(["kimi-for-coding"]));
  const newerResult = await newer;

  assert.equal(olderResult.explanationCode, "kimi-code-inspection-stale");
  assert.ok(pendingListResult instanceof Error);
  assert.equal(newerResult.explanationCode, "kimi-code-ready");
  const models = await adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), ["kimi-for-coding"]);
});

test("older inspection failure cannot erase a newer same-generation result", async () => {
  const responses: Array<(response: Response) => void> = [];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const older = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const newer = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  responses[1]!(catalogResponse(["kimi-for-coding-highspeed"]));
  const newerResult = await newer;
  responses[0]!(errorResponse(500, "private-stale-dependency-failure"));
  const olderResult = await older;

  assert.equal(newerResult.explanationCode, "kimi-code-ready");
  assert.equal(olderResult.explanationCode, "kimi-code-inspection-stale");
  const models = await adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), [
    "kimi-for-coding-highspeed",
  ]);
});

test("older inspection failure cannot publish while a newer same-generation success is pending", async () => {
  const responses: Array<(response: Response) => void> = [];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const older = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const newer = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  responses[0]!(errorResponse(500, "private-older-failure"));
  const olderResult = await older;
  let pendingListResult: unknown;
  try {
    pendingListResult = await adapter.listModels({
      connectionId: CONNECTION_ID,
      signal: new AbortController().signal,
    });
  } catch (error) {
    pendingListResult = error;
  }
  responses[1]!(catalogResponse(["k3-256k"]));
  const newerResult = await newer;

  assert.equal(olderResult.explanationCode, "kimi-code-inspection-stale");
  assert.ok(pendingListResult instanceof Error);
  assert.equal(newerResult.explanationCode, "kimi-code-ready");
  const models = await adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models.map(({ canonicalModelId }) => canonicalModelId), ["k3-256k"]);
});

test("older inspection success cannot resurrect metadata after a newer same-generation failure", async () => {
  const responses: Array<(response: Response) => void> = [];
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => new Promise<Response>((resolve) => responses.push(resolve)),
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: authority([]),
    now: () => 10_000,
  });

  const older = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const newer = adapter.inspect(inspectionRequest({ generation: 8 }));
  while (responses.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  responses[1]!(errorResponse(500, "private-newer-failure"));
  const newerResult = await newer;
  responses[0]!(catalogResponse(["k3"]));
  const olderResult = await older;

  assert.equal(newerResult.explanationCode, "kimi-code-offline");
  assert.equal(olderResult.explanationCode, "kimi-code-inspection-stale");
  await assert.rejects(adapter.listModels({
    connectionId: CONNECTION_ID,
    signal: new AbortController().signal,
  }));
});

test("adapter timing, identity, HMAC, and ID seams fail with fixed non-leaking outcomes", async (t) => {
  const service = () => new KimiCodeService({
    now: () => 10_000,
    fetchImpl: async () => catalogResponse(["k3"]),
  });
  const connectRequest = {
    connectionId: CONNECTION_ID,
    candidate: KEY,
    generation: 8,
    deadlineAt: DEADLINE_AT,
    signal: new AbortController().signal,
  };

  await t.test("connect now", async () => {
    const canary = "private-adapter-now-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      now() { throw new Error(canary); },
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("inspect now", async () => {
    const canary = "private-adapter-inspect-now-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      now() { throw new Error(canary); },
    });
    const inspection = await adapter.inspect(inspectionRequest());
    assert.equal(inspection.routeEligible, false);
    assert.equal(inspection.explanationCode, "kimi-code-recovery-required");
    assert.equal(JSON.stringify(inspection).includes(canary), false);
  });

  await t.test("identity key", async () => {
    const canary = "private-adapter-identity-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { throw new Error(canary); } },
      credentialAuthority: authority([]),
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("HMAC", async () => {
    const canary = "private-adapter-hmac-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      accountFingerprint() { throw new Error(canary); },
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("connection ID", async () => {
    const canary = "private-adapter-connection-id-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      createConnectionId() { throw new Error(canary); },
      now: () => 10_000,
    });
    const { connectionId: _connectionId, ...withoutConnectionId } = connectRequest;
    await fixedAdapterFailure(adapter.connect(withoutConnectionId), canary);
  });

  await t.test("candidate ID", async () => {
    const canary = "private-adapter-candidate-id-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      createCandidateId() { throw new Error(canary); },
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("listModels now", async () => {
    const canary = "private-adapter-list-now-canary";
    let failNow = false;
    const adapter = new KimiCodeBackendAdapter({
      service: service(),
      credentials: { async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); } },
      credentialAuthority: authority([]),
      now() {
        if (failNow) throw new Error(canary);
        return 10_000;
      },
      createCandidateId: () => "candidate-list-now",
    });
    const candidate = await adapter.connect(connectRequest);
    failNow = true;
    await fixedAdapterFailure(adapter.listModels({
      candidateId: candidate.candidateId,
      signal: new AbortController().signal,
    }), canary);
  });
});

test("adapter bounds abort-ignoring identity and lease seams at the exact absolute deadline", async (t) => {
  const deadlineRequest = () => ({
    connectionId: CONNECTION_ID,
    candidate: KEY,
    generation: 9,
    deadlineAt: Date.now() + 20,
    signal: new AbortController().signal,
  });
  const boundedResult = async <T>(operation: Promise<T>): Promise<T | null> => Promise.race([
    operation,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
  ]);

  await t.test("identity key", async () => {
    const canary = "private-hung-identity-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: new KimiCodeService({
        now: Date.now,
        fetchImpl: async () => catalogResponse(["k3"]),
      }),
      credentials: {
        async getOrCreateAccountHmacKey() {
          return new Promise<Uint8Array>(() => undefined);
        },
      },
      credentialAuthority: authority([]),
      now: Date.now,
    });
    const result = await boundedResult(fixedAdapterFailure(
      adapter.connect(deadlineRequest()),
      canary,
    ));
    assert.notEqual(result, null, "identity-key await outlived the absolute deadline");
  });

  await t.test("authority lease", async () => {
    const canary = "private-hung-lease-canary";
    const adapter = new KimiCodeBackendAdapter({
      service: new KimiCodeService({
        now: Date.now,
        fetchImpl: async () => catalogResponse(["k3"]),
      }),
      credentials: {
        async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
      },
      credentialAuthority: authority([]),
      now: Date.now,
    });
    const result = await boundedResult(fixedAdapterFailure(
      adapter.connectUnderAuthorityLease!(deadlineRequest(), {
        async assertHeld() {
          return new Promise<void>(() => undefined);
        },
      }),
      canary,
    ));
    assert.notEqual(result, null, "lease await outlived the absolute deadline");
  });
});

test("hostile service, identity, and lease Kimi errors are rebuilt as fixed offline failures", async (t) => {
  const connectRequest = {
    connectionId: CONNECTION_ID,
    candidate: KEY,
    generation: 10,
    deadlineAt: DEADLINE_AT,
    signal: new AbortController().signal,
  };

  await t.test("service", async () => {
    const canary = "private-hostile-service-kimi-error";
    const adapter = new KimiCodeBackendAdapter({
      service: {
        async inspectModels() { throw hostileAdapterKimiError(canary); },
      } as unknown as KimiCodeService,
      credentials: {
        async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
      },
      credentialAuthority: authority([]),
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("identity key", async () => {
    const canary = "private-hostile-identity-kimi-error";
    const adapter = new KimiCodeBackendAdapter({
      service: new KimiCodeService({
        now: () => 10_000,
        fetchImpl: async () => catalogResponse(["k3"]),
      }),
      credentials: {
        async getOrCreateAccountHmacKey() { throw hostileAdapterKimiError(canary); },
      },
      credentialAuthority: authority([]),
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connect(connectRequest), canary);
  });

  await t.test("authority lease", async () => {
    const canary = "private-hostile-lease-kimi-error";
    const adapter = new KimiCodeBackendAdapter({
      service: new KimiCodeService({
        now: () => 10_000,
        fetchImpl: async () => catalogResponse(["k3"]),
      }),
      credentials: {
        async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
      },
      credentialAuthority: authority([]),
      now: () => 10_000,
    });
    await fixedAdapterFailure(adapter.connectUnderAuthorityLease!(connectRequest, {
      async assertHeld() { throw hostileAdapterKimiError(canary); },
    }), canary);
  });
});

test("Kimi adapter rejects an OpenRouter authority binding and known OpenRouter candidate before network", async () => {
  let fetchCount = 0;
  const wrongAuthority = {
    async withCredential(request: Parameters<ProviderCredentialAuthorityLike["withCredential"]>[0], use: (
      secret: string,
      context: ProviderCredentialUseContext,
    ) => Promise<unknown>) {
      const context = bindingContext(request);
      const wrong = {
        ...context,
        binding: {
          ...context.binding,
          backendId: "openrouter",
          credentialPointer: { kind: "legacy", id: "legacy:inference" },
          billingRealm: "openrouter-payg",
        },
      } as unknown as ProviderCredentialUseContext;
      return { kind: "available" as const, value: await use(OPENROUTER_KEY, wrong) };
    },
  } as ProviderCredentialAuthorityLike;
  const adapter = new KimiCodeBackendAdapter({
    service: new KimiCodeService({
      now: () => 10_000,
      fetchImpl: async () => {
        fetchCount += 1;
        return catalogResponse(["kimi-for-coding"]);
      },
    }),
    credentials: {
      async getOrCreateAccountHmacKey() { return new Uint8Array(HMAC_KEY); },
    },
    credentialAuthority: wrongAuthority,
    now: () => 10_000,
  });

  const inspection = await adapter.inspect(inspectionRequest());
  assert.equal(inspection.routeEligible, false);
  assert.equal(inspection.explanationCode, "kimi-code-credential-unavailable");
  assert.equal(fetchCount, 0);

  await assert.rejects(adapter.connect({
    candidate: OPENROUTER_KEY,
    generation: 8,
    deadlineAt: DEADLINE_AT,
    signal: new AbortController().signal,
  }));
  assert.equal(fetchCount, 0);
});
