import assert from "node:assert/strict";
import test from "node:test";

import type { RouteIdentityV1 } from "../src/backends.js";
import {
  CodexRouteGate,
  type CodexAccountUpdatedObservation,
} from "../src/codex-route-gate.js";
import { CodexAppServerClient } from "../src/codex-app-server.js";
import { codexAccountFingerprint } from "../src/codex-account-identity.js";

class FakeAccountClient {
  readonly listenerOrder: string[] = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];
  detachCalls = 0;
  #listener: ((params: unknown) => void) | null = null;
  #reads: Array<unknown | (() => Promise<unknown>)> = [];

  onNotification(method: "account/updated", listener: (params: unknown) => void): () => void {
    this.listenerOrder.push(method);
    this.#listener = listener;
    return () => {
      this.detachCalls += 1;
      if (this.#listener === listener) this.#listener = null;
    };
  }

  queueRead(value: unknown | (() => Promise<unknown>)): void {
    this.#reads.push(value);
  }

  emit(params: unknown): void {
    this.#listener?.(params);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.listenerOrder.push(method);
    this.requests.push({ method, params });
    const next = this.#reads.shift();
    if (next === undefined) throw new Error("No queued account read.");
    return (typeof next === "function" ? await next() : next) as T;
  }
}

const route: RouteIdentityV1 = {
  version: 1,
  backendId: "codex",
  accountFingerprint: "owner-profile-1",
  billingRealm: "chatgpt-subscription-provider-managed-overage",
  requestedModelId: "gpt-5-codex",
  canonicalModelId: "gpt-5-codex",
  resolutionState: "resolved",
};

function binding() {
  return {
    profileId: "profile-1",
    codexHomeRealpath: "/private/orcode/providers/codex/profile-1",
    route,
    modelId: "gpt-5-codex",
  } as const;
}

function fixture() {
  const client = new FakeAccountClient();
  const gate = new CodexRouteGate({
    client,
    childGeneration: 4,
    profileId: binding().profileId,
    codexHomeRealpath: binding().codexHomeRealpath,
    route: binding().route,
    modelId: binding().modelId,
    createPermitId: () => "permit-1",
  });
  return { client, gate };
}

function identityFixture() {
  const homeId = "codex-0123456789abcdef0123456789abcdef";
  const account = { account: { type: "chatgpt", email: "owner@example.invalid", planType: "pro" }, requiresOpenaiAuth: true };
  const selected = { ...binding(), profileId: homeId,
    route: { ...route, accountFingerprint: codexAccountFingerprint(homeId, account) } };
  const client = new FakeAccountClient();
  return { account, selected, client, gate: new CodexRouteGate({ ...selected, client, childGeneration: 4 }) };
}

test("a same-plan account substitution revokes the old permit and cannot mint a new one", async () => {
  const homeId = "codex-0123456789abcdef0123456789abcdef";
  const original = { account: { type: "chatgpt", email: "first@example.test", planType: "pro" }, requiresOpenaiAuth: true };
  const selected = { ...binding(), profileId: homeId,
    route: { ...route, accountFingerprint: codexAccountFingerprint(homeId, original) } };
  const client = new FakeAccountClient();
  const gate = new CodexRouteGate({ ...selected, client, childGeneration: 4 });
  client.emit({ authMode: "chatgpt", planType: "pro" });
  client.queueRead(original);
  const oldPermit = await gate.refreshAndIssueDispatchPermit(selected);
  client.queueRead({ ...original, account: { ...original.account, email: "replacement@example.test" } });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /account changed/i);
  assert.equal(gate.consumeDispatchPermit(oldPermit, selected), false);
  assert.equal(gate.taskBytesSent, 0);
});

test("a fresh child without unsolicited auth events requires a fresh identity-bound ChatGPT read", async () => {
  const { client, gate, selected, account } = identityFixture();
  client.queueRead(account);
  const permit = await gate.refreshAndIssueDispatchPermit(selected);
  assert.equal(permit.epochs.auth, 0, "a successful read must not fabricate an account notification");
  assert.equal(permit.binding.planType, "pro");
  assert.throws(() => JSON.stringify(permit), /serializ/i);
  assert.equal(gate.consumeDispatchPermit(permit, selected), true);
  assert.equal(gate.consumeDispatchPermit(permit, selected), false);
  client.queueRead({ ...account, account: { ...account.account, email: "other@example.invalid" } });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /account changed/i);
  assert.deepEqual(client.listenerOrder, ["account/updated", "account/read", "account/read"]);
});

test("official 0.159 account reads with null workspace routing retain identity-bound dispatch", async () => {
  const {client, gate, selected, account} = identityFixture();
  client.queueRead({...account, workspaceRouting:null});
  const permit = await gate.refreshAndIssueDispatchPermit(selected);
  assert.equal(gate.consumeDispatchPermit(permit, selected), true);
  assert.equal(gate.taskBytesSent, 0);
});

test("unverified backend workspace routing cannot authorize dispatch", async () => {
  const {client, gate, selected, account} = identityFixture();
  client.queueRead({...account, workspaceRouting:{backendOrigin:'https://unexpected.invalid',
    chatgptAccountId:'private-account', accountRoutingOverride:'NO_CONSTRAINT'}});
  await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /authentication|routing/i);
  assert.equal(gate.taskBytesSent, 0);
});

test("a first account event during the initial read invalidates its result", async () => {
  const { client, gate, selected, account } = identityFixture();
  client.queueRead(async () => {
    client.emit({ authMode: "chatgpt", planType: "pro" });
    return account;
  });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /stale account read/i);
  assert.equal(gate.taskBytesSent, 0);
});

test("initial-read eligibility never returns after logout, malformed auth, or explicit revocation", async () => {
  for (const revoke of [
    (client: FakeAccountClient, gate: CodexRouteGate) => gate.observeLogout(),
    (client: FakeAccountClient) => client.emit({ invalid: "auth" }),
    (client: FakeAccountClient, gate: CodexRouteGate) => gate.revoke(),
  ]) {
    const { client, gate, selected, account } = identityFixture();
    revoke(client, gate);
    client.queueRead(account);
    await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /authentication/i);
    assert.equal(client.requests.length, 0);
  }
});

test("initial account reads reject non-ChatGPT, unknown plans, and a different billing realm", async () => {
  for (const account of [null, { type: "apiKey" },
    { type: "chatgpt", email: null, planType: "unrecognized-plan" },
    { type: "chatgpt", email: null, planType: "free" }]) {
    const { client, gate, selected } = identityFixture();
    client.queueRead({ account, requiresOpenaiAuth: true });
    await assert.rejects(gate.refreshAndIssueDispatchPermit(selected), /account|authentication|plan|billing/i);
    assert.equal(gate.taskBytesSent, 0);
  }
});

test("an unbound legacy fingerprint cannot use the eventless initial-read shortcut", async () => {
  const { client, gate } = fixture();
  client.queueRead({ account: { type: "chatgpt", email: "other@example.invalid", planType: "pro" }, requiresOpenaiAuth: true });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(binding()), /identity|reconnect/i);
  assert.equal(client.requests.length, 0);
  assert.equal(gate.taskBytesSent, 0);
});

class BackpressuredTurnClient extends CodexAppServerClient {
  readonly taskFrames: unknown[] = [];
  #listener: ((params: unknown) => void) | null = null;
  #release!: () => void;
  readonly blocked = new Promise<void>((resolve) => { this.#release = resolve; });
  constructor() { super({} as never); }
  override onNotification(_method: string, listener: (params: unknown) => void): () => void {
    this.#listener = listener;
    return () => { this.#listener = null; };
  }
  emit(params: unknown): void { this.#listener?.(params); }
  release(): void { this.#release(); }
  override async request<T>(): Promise<T> {
    return { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true } as T;
  }
  override async requestGuarded<T>(_method: string, params: unknown, guard: () => void): Promise<T> {
    await this.blocked;
    guard();
    this.taskFrames.push(params);
    return { turn: { id: "turn-1", items: [], itemsView: "full", status: "inProgress",
      error: null, startedAt: 1, completedAt: null, durationMs: null } } as T;
  }
}

test("drift during a blocked physical stdin write sends zero task bytes", async () => {
  const client = new BackpressuredTurnClient();
  const gate = new CodexRouteGate({ ...binding(), client, childGeneration: 4,
    createPermitId: () => "permit-backpressure" });
  client.emit({ authMode: "chatgpt", planType: "pro" });
  const permit = await gate.refreshAndIssueDispatchPermit(binding());
  const params = { threadId: "thread-1", cwd: binding().codexHomeRealpath,
    input: [{ type: "text", text: "secret", text_elements: [] }] } as const;
  const pending = gate.consumeAndWriteTurn(permit, client, binding(), params, {
    childGeneration: 4, threadId: "thread-1", stagingRealpath: params.cwd,
    routeDigest: (await import("node:crypto")).createHash("sha256")
      .update(JSON.stringify(binding())).digest("hex"),
  });
  gate.observeRateLimits({ changed: true });
  client.release();
  await assert.rejects(pending, /stale route dispatch permit/i);
  assert.equal(client.taskFrames.length, 0);
  assert.equal(gate.taskBytesSent, 0);
});

for (const authMode of [
  "apikey", "chatgptAuthTokens", "agentIdentity", "personalAccessToken",
  "bedrockApiKey", null, "unknown",
] as const) {
  test(`sends zero task bytes for ${String(authMode)}`, async () => {
    const { client, gate } = fixture();
    client.emit({ authMode, planType: "pro" } satisfies CodexAccountUpdatedObservation["params"]);
    await assert.rejects(gate.refreshAndIssueDispatchPermit(binding()), /authentication/i);
    assert.equal(gate.taskBytesSent, 0);
    assert.equal(client.requests.length, 0);
  });
}

test("attaches account/updated before the first read and allows only current ChatGPT true", async () => {
  const { client, gate } = fixture();
  client.emit({ authMode: "chatgpt", planType: "pro" });
  client.queueRead({
    account: { type: "chatgpt", email: "must-not-survive@example.test", planType: "pro" },
    requiresOpenaiAuth: true,
  });
  const permit = await gate.refreshAndIssueDispatchPermit(binding());
  assert.deepEqual(client.listenerOrder, ["account/updated", "account/read"]);
  assert.deepEqual(client.requests, [{ method: "account/read", params: { refreshToken: false } }]);
  assert.equal(permit.binding.accountType, "chatgpt");
  assert.equal(permit.binding.planType, "pro");
  assert.doesNotMatch(JSON.stringify(permit.binding), /must-not-survive|@/);
  assert.throws(() => JSON.stringify(permit), /serializ/i);
  assert.equal(gate.consumeDispatchPermit(permit, binding()), true);
  assert.equal(gate.consumeDispatchPermit(permit, binding()), false);
});

for (const denied of [
  { label: "ChatGPT false", response: { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: false } },
  { label: "null account", response: { account: null, requiresOpenaiAuth: true } },
  { label: "apiKey account", response: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
  { label: "amazonBedrock account", response: { account: { type: "amazonBedrock", credentialSource: "awsManaged" }, requiresOpenaiAuth: true } },
  { label: "plan mismatch", response: { account: { type: "chatgpt", email: null, planType: "team" }, requiresOpenaiAuth: true } },
] as const) {
  test(`sends zero task bytes for ${denied.label}`, async () => {
    const { client, gate } = fixture();
    client.emit({ authMode: "chatgpt", planType: "pro" });
    client.queueRead(denied.response);
    await assert.rejects(gate.refreshAndIssueDispatchPermit(binding()), /authentication|account|plan/i);
    assert.equal(gate.taskBytesSent, 0);
  });
}

test("requires account/read after the newest event and revokes permits on every event", async () => {
  const { client, gate } = fixture();
  client.emit({ authMode: "chatgpt", planType: "pro" });
  let resolveRead!: (value: unknown) => void;
  client.queueRead(() => new Promise((resolve) => { resolveRead = resolve; }));
  const pending = gate.refreshAndIssueDispatchPermit(binding());
  await new Promise<void>((resolve) => setImmediate(resolve));
  client.emit({ authMode: "chatgpt", planType: "team" });
  resolveRead({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
  await assert.rejects(pending, /stale account read/i);

  client.queueRead({ account: { type: "chatgpt", email: null, planType: "team" }, requiresOpenaiAuth: true });
  const permit = await gate.refreshAndIssueDispatchPermit(binding());
  client.emit({ authMode: "chatgpt", planType: "team" });
  assert.equal(gate.consumeDispatchPermit(permit, binding()), false);
  assert.equal(gate.taskBytesSent, 0);
});

test("model, rate-limit, logout, and profile/home/route changes revoke one-shot permits", async () => {
  for (const revoke of [
    (gate: CodexRouteGate) => gate.observeModelCatalog(["gpt-5-codex", "gpt-5-mini"]),
    (gate: CodexRouteGate) => gate.observeRateLimits({ primary: { usedPercent: 90 } }),
    (gate: CodexRouteGate) => gate.observeLogout(),
    (gate: CodexRouteGate) => gate.updateBinding({ ...binding(), profileId: "profile-2" }),
    (gate: CodexRouteGate) => gate.updateBinding({ ...binding(), codexHomeRealpath: "/private/other" }),
    (gate: CodexRouteGate) => gate.updateBinding({
      ...binding(),
      route: { ...binding().route, accountFingerprint: "owner-profile-2" },
    }),
  ]) {
    const { client, gate } = fixture();
    client.emit({ authMode: "chatgpt", planType: "pro" });
    client.queueRead({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
    const permit = await gate.refreshAndIssueDispatchPermit(binding());
    revoke(gate);
    assert.equal(gate.consumeDispatchPermit(permit, binding()), false);
  }
});

test("fails closed for malformed events, generation drift, route drift, and model drift", async () => {
  for (const mutate of [
    (value: ReturnType<typeof binding>) => ({ ...value, modelId: "other" }),
    (value: ReturnType<typeof binding>) => ({ ...value, route: { ...value.route, requestedModelId: "other" } }),
    (value: ReturnType<typeof binding>) => ({ ...value, profileId: "profile-2" }),
    (value: ReturnType<typeof binding>) => ({ ...value, codexHomeRealpath: "/other" }),
  ]) {
    const { client, gate } = fixture();
    client.emit({ authMode: "chatgpt", planType: "pro" });
    client.queueRead({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
    await assert.rejects(gate.refreshAndIssueDispatchPermit(mutate(binding()) as never), /binding|route|profile|model|home/i);
    assert.equal(gate.taskBytesSent, 0);
  }

  const { client, gate } = fixture();
  client.emit({ authMode: "chatgpt", planType: "pro", account: { type: "chatgpt" } });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(binding()), /authentication/i);
  gate.setChildGeneration(5);
  assert.equal(client.detachCalls, 1);
  gate.observeAccountUpdated({ childGeneration: 4, params: { authMode: "chatgpt", planType: "pro" } });
  await assert.rejects(gate.refreshAndIssueDispatchPermit(binding()), /authentication/i);
  client.emit({ authMode: "chatgpt", planType: "pro" });
  client.queueRead({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true });
  const permit = await gate.refreshAndIssueDispatchPermit(binding());
  assert.equal(permit.epochs.childGeneration, 5);
  assert.equal(gate.consumeDispatchPermit(permit, binding()), true);
  assert.equal(gate.taskBytesSent, 0);
});

test("rejects unknown and accessor-backed binding authority without reading it", async () => {
  const client = new FakeAccountClient();
  const unknownBinding = { ...binding(), futureAuthority: "tenant-2" };
  assert.throws(() => new CodexRouteGate({
    client,
    childGeneration: 4,
    ...unknownBinding,
  } as never), /binding/i);

  const unknownRoute = { ...route, futureAuthority: "tenant-2" };
  assert.throws(() => new CodexRouteGate({
    client,
    childGeneration: 4,
    ...binding(),
    route: unknownRoute,
  } as never), /binding|route/i);

  let authorityReads = 0;
  const accessorRoute = { ...route } as RouteIdentityV1 & { futureAuthority?: string };
  Object.defineProperty(accessorRoute, "futureAuthority", {
    enumerable: true,
    get() {
      authorityReads += 1;
      return "tenant-2";
    },
  });
  assert.throws(() => new CodexRouteGate({
    client,
    childGeneration: 4,
    ...binding(),
    route: accessorRoute,
  }), /binding|route/i);
  assert.equal(authorityReads, 0);
});
