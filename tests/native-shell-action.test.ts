import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_SCOPE,
  CodexNativeShellActions,
} from "../src/native-shell-action.js";
import {
  NativeSidecarChannel,
  createFixedDescriptorTransportForTest,
  decodeActionFrame,
  encodeControlFrame,
  type CodexNativeActionRequest,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";

function browserUrl(overrides: Record<string, string> = {}): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  const values = {
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    scope: CODEX_OAUTH_SCOPE,
    redirect_uri: "http://localhost:1455/auth/callback",
    code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    originator: CODEX_OAUTH_ORIGINATOR,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

class FakeAppServer {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  loginResponse: unknown = { type: "chatgpt", loginId: "login-1", authUrl: browserUrl() };
  cancelResponse: unknown = {};
  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "account/login/start") return await this.loginResponse as T;
    if (method === "account/login/cancel") return await this.cancelResponse as T;
    if (method === "account/read") return { account: null, requiresOpenaiAuth: true } as T;
    if (method === "account/rateLimits/read") return { rateLimits: [] } as T;
    if (method === "model/list") return { data: [] } as T;
    return {} as T;
  }
}

function fixture(control: unknown | null = {
  kind: "codex-native-action-result",
  requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  childGeneration: 4,
  status: "presented",
}, keepOpen = false) {
  const writes: CodexNativeActionRequest[] = [];
  const controls = control === null ? [] : [encodeControlFrame(control as never)];
  const transport: NativeSidecarTransport = {
    async writeAction(frame) { writes.push(decodeActionFrame(frame) as CodexNativeActionRequest); },
    async readControl() {
      while (!writes.some(({ kind }) => kind === "codex-native-action-commit")) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const next = controls.shift();
      if (next) return next;
      if (keepOpen) return new Promise<Buffer | null>(() => {});
      return null;
    },
    close() {},
  };
  const appServer = new FakeAppServer();
  const actions = new CodexNativeShellActions({
    appServer,
    channel: new NativeSidecarChannel(transport),
    childGeneration: 4,
    now: () => 1_000,
    requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    nativePresentationTimeoutMs: 25,
  });
  return { actions, appServer, writes };
}

test("keeps a validated browser URL off every public transport and uses the private channel", async () => {
  const { actions, appServer, writes } = fixture();
  const result = await actions.beginLogin({ type: "chatgpt" });
  assert.deepEqual(result, { loginId: "login-1", type: "chatgpt" });
  assert.deepEqual(writes, [{
    kind: "codex-browser-login-prepare",
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    loginId: "login-1",
    authUrl: browserUrl(),
    deadlineAt: 1_025,
  }, {
    kind: "codex-native-action-commit",
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    deadlineAt: 1_025,
  }]);
  assert.doesNotMatch(JSON.stringify(appServer.calls), /auth\.openai\.com|userCode|deviceCode/i);
});

test("manufacturer CLI setup privately prepares and commits without any account API request", async () => {
  const {actions, appServer, writes} = fixture();
  const result = await actions.beginManufacturerAction({provider:'claude', action:'install'});
  assert.equal(result, 'presented');
  assert.deepEqual(writes, [{kind:'manufacturer-cli-prepare',
    requestId:'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', childGeneration:4,
    provider:'claude', action:'install', deadlineAt:1_025},
    {kind:'codex-native-action-commit', requestId:'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      childGeneration:4, deadlineAt:1_025}]);
  assert.deepEqual(appServer.calls, []);
});

test("manufacturer consent is revoked even after the dialog was presented", async () => {
  const {actions,writes} = fixture(undefined,true);
  const abort = new AbortController();
  await actions.beginManufacturerAction({provider:'claude',action:'login'},abort.signal);
  abort.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(writes.at(-1)?.kind,'codex-native-action-revoke');
});

test("cancelled manufacturer setup never reaches the private pipe", async () => {
  const {actions, appServer, writes} = fixture();
  const signal = new AbortController();
  signal.abort(new Error('owner cancelled'));
  await assert.rejects(actions.beginManufacturerAction({provider:'kimi', action:'login'}, signal.signal));
  assert.deepEqual(writes, []);
  assert.deepEqual(appServer.calls, []);
});

test("manufacturer setup has no arbitrary command or custom-provider escape", async () => {
  const {actions, writes} = fixture();
  await assert.rejects(actions.beginManufacturerAction({provider:'custom', action:'install'} as never));
  await assert.rejects(actions.beginManufacturerAction({provider:'claude', action:'exec'} as never));
  assert.deepEqual(writes, []);
});

test("keeps device URL and code private and discards provider-only deviceCode", async () => {
  const { actions, appServer, writes } = fixture();
  appServer.loginResponse = {
    type: "chatgptDeviceCode",
    loginId: "login-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    deviceCode: "must-never-cross",
  };
  assert.deepEqual(await actions.beginLogin({ type: "chatgptDeviceCode" }), {
    loginId: "login-1", type: "chatgptDeviceCode",
  });
  assert.deepEqual(writes.map(({ kind }) => kind), [
    "codex-device-login-prepare",
    "codex-native-action-commit",
  ]);
  assert.doesNotMatch(JSON.stringify(writes), /deviceCode|must-never-cross/);
});

test("rejects non-canonical browser and device presentations before the private pipe", async () => {
  const badBrowserUrls = [
    browserUrl({ redirect_uri: "http://127.0.0.1:1455/auth/callback" }),
    browserUrl({ redirect_uri: "http://localhost:80/auth/callback" }),
    browserUrl({ code_challenge_method: "plain" }),
    browserUrl({ originator: "other" }),
    browserUrl({ scope: "openid" }),
    browserUrl() + "#fragment",
    browserUrl().replace("https://", "http://"),
    browserUrl().replace("auth.openai.com", "auth.openai.com:443"),
    browserUrl() + "#",
    browserUrl() + "&",
    browserUrl({ redirect_uri: "http:\\localhost:1455\\auth\\callback" }),
    browserUrl({ redirect_uri: "http://localhost:01455/auth/callback" }),
  ];
  for (const authUrl of badBrowserUrls) {
    const { actions, appServer, writes } = fixture();
    appServer.loginResponse = { type: "chatgpt", loginId: "login-1", authUrl };
    await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /login presentation|URL/i);
    assert.equal(writes.length, 0);
    assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
  }

  for (const [verificationUrl, userCode] of [
    ["https://auth.openai.com/codex/device?secret=x", "ABCD-EFGH"],
    ["https://auth.openai.com/codex/device?", "ABCD-EFGH"],
    ["https://auth.openai.com/codex/device#", "ABCD-EFGH"],
    ["https://auth.openai.com:443/codex/device", "ABCD-EFGH"],
    ["HTTPS://AUTH.OPENAI.COM/codex/device", "ABCD-EFGH"],
    ["https://example.test/codex/device", "ABCD-EFGH"],
    ["https://auth.openai.com/codex/device", "bad code"],
  ]) {
    const { actions, appServer, writes } = fixture();
    appServer.loginResponse = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl, userCode };
    await assert.rejects(actions.beginLogin({ type: "chatgptDeviceCode" }), /login presentation|URL|code/i);
    assert.equal(writes.length, 0);
    assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
  }
});

test("cancels exactly once when native presentation fails, closes, mismatches, or times out", async () => {
  for (const control of [
    { kind: "codex-native-action-result", requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", childGeneration: 4, status: "failed" },
    { kind: "codex-native-action-result", requestId: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", childGeneration: 4, status: "presented" },
    { kind: "codex-native-action-result", requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", childGeneration: 5, status: "presented" },
    null,
  ]) {
    const { actions, appServer } = fixture(control);
    await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /native login presentation/i);
    assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
  }
});

test("a timed-out login cancels once and ignores a late native completion", async () => {
  const appServer = new FakeAppServer();
  let resolveControl!: (frame: Uint8Array | null) => void;
  const control = new Promise<Uint8Array | null>((resolve) => { resolveControl = resolve; });
  const channel = new NativeSidecarChannel({
    async writeAction() {},
    async readControl() { return control; },
    close() {},
  });
  const actions = new CodexNativeShellActions({
    appServer,
    channel,
    childGeneration: 4,
    now: () => 1_000,
    requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    nativePresentationTimeoutMs: 10,
  });
  await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /native login presentation/i);
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
  resolveControl(encodeControlFrame({
    kind: "codex-native-action-result",
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    status: "presented",
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
});

test("does not relabel a login-start response across a child generation", async () => {
  const { actions, appServer, writes } = fixture();
  let resolveStart!: (value: unknown) => void;
  appServer.loginResponse = new Promise((resolve) => { resolveStart = resolve; });
  const pending = actions.beginLogin({ type: "chatgpt" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  actions.setChildGeneration(5);
  resolveStart({ type: "chatgpt", loginId: "old-login", authUrl: browserUrl() });

  await assert.rejects(pending, /native login presentation/i);
  assert.equal(writes.length, 0);
  assert.deepEqual(
    appServer.calls.filter(({ method }) => method === "account/login/cancel"),
    [{ method: "account/login/cancel", params: { loginId: "old-login" } }],
  );
});

test("revalidates generation immediately after the private action write", async () => {
  const appServer = new FakeAppServer();
  let releaseWrite!: () => void;
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let readCalls = 0;
  const channel = new NativeSidecarChannel({
    async writeAction() {
      markWriteStarted();
      await writeGate;
    },
    async readControl() {
      readCalls += 1;
      return new Promise<Uint8Array | null>(() => {});
    },
    close() {},
  });
  const actions = new CodexNativeShellActions({
    appServer,
    channel,
    childGeneration: 4,
    requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    nativePresentationTimeoutMs: 100,
  });

  const pending = actions.beginLogin({ type: "chatgpt" });
  await writeStarted;
  actions.setChildGeneration(5);
  releaseWrite();
  const outcome = await Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 30)),
  ]);
  assert.equal(outcome, "rejected");
  assert.equal(readCalls, 1);
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
});

test("an accepted descriptor write cannot authorize presentation after caller or generation revocation", async () => {
  for (const interrupt of ["abort", "generation"] as const) {
    const appServer = new FakeAppServer();
    if (interrupt === "generation") {
      appServer.loginResponse = {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      };
    }
    const acceptedFrames: Uint8Array[] = [];
    let closed = false;
    let completedAfterClose = false;
    let markAccepted!: () => void;
    let releaseAcceptedWrite!: () => void;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    const writeCompletion = new Promise<void>((resolve) => { releaseAcceptedWrite = resolve; });
    const transport = createFixedDescriptorTransportForTest({
      read() { return new Promise<number>(() => {}); },
      async write(_fd, buffer) {
        acceptedFrames.push(Uint8Array.from(buffer));
        markAccepted();
        await writeCompletion;
        completedAfterClose = closed;
        return buffer.byteLength;
      },
      close() { closed = true; },
    });
    const actions = new CodexNativeShellActions({
      appServer,
      channel: new NativeSidecarChannel(transport),
      childGeneration: 4,
      now: () => 1_000,
      requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      nativePresentationTimeoutMs: 100,
    });
    const caller = new AbortController();

    const pending = actions.beginLogin({
      type: interrupt === "abort" ? "chatgpt" : "chatgptDeviceCode",
    }, caller.signal);
    await accepted;
    const acceptedPrepare = decodeActionFrame<CodexNativeActionRequest>(acceptedFrames[0]!);
    assert.ok(acceptedPrepare.deadlineAt > 1_000);
    if (interrupt === "abort") caller.abort(new Error("caller stopped"));
    else actions.setChildGeneration(5);
    await assert.rejects(pending, /native login presentation/i);

    releaseAcceptedWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completedAfterClose, true, interrupt);
    const acceptedKinds = acceptedFrames.map((frame) => decodeActionFrame<CodexNativeActionRequest>(frame).kind);
    assert.deepEqual(acceptedKinds, [
      interrupt === "abort" ? "codex-browser-login-prepare" : "codex-device-login-prepare",
    ], interrupt);
    assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
  }
});

test("a timed-out control wait cannot steal the next login result", async () => {
  const appServer = new FakeAppServer();
  const writes: CodexNativeActionRequest[] = [];
  const controlWaiters: Array<(frame: Uint8Array | null) => void> = [];
  const channel = new NativeSidecarChannel({
    async writeAction(frame) { writes.push(decodeActionFrame(frame) as CodexNativeActionRequest); },
    async readControl() {
      return new Promise<Uint8Array | null>((resolve) => { controlWaiters.push(resolve); });
    },
    close() {},
  });
  const ids = [
    "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  ];
  const actions = new CodexNativeShellActions({
    appServer,
    channel,
    childGeneration: 4,
    requestId: () => ids.shift()!,
    nativePresentationTimeoutMs: 10,
  });

  await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /native login presentation/i);
  appServer.loginResponse = { type: "chatgpt", loginId: "login-2", authUrl: browserUrl() };
  const second = actions.beginLogin({ type: "chatgpt" });
  while (!writes.some((record) => record.kind === "codex-native-action-commit"
      && record.requestId === "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD")
    || controlWaiters.length < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  controlWaiters[0]!(encodeControlFrame({
    kind: "codex-native-action-result",
    requestId: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    childGeneration: 4,
    status: "presented",
  }));
  assert.deepEqual(await second, { loginId: "login-2", type: "chatgpt" });
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
});

test("a nonresponsive cancel RPC cannot keep beginLogin pending", async () => {
  const { actions, appServer } = fixture({
    kind: "codex-native-action-result",
    requestId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    childGeneration: 4,
    status: "failed",
  });
  appServer.cancelResponse = new Promise(() => {});
  const outcome = await Promise.race([
    actions.beginLogin({ type: "chatgpt" }).then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 75)),
  ]);
  assert.equal(outcome, "rejected");
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);
});

test("a stalled private write times out, cancels once, and poisons later login attempts", async () => {
  const appServer = new FakeAppServer();
  let closeCalls = 0;
  const channel = new NativeSidecarChannel({
    writeAction() { return new Promise<void>(() => {}); },
    readControl() { return new Promise<Uint8Array | null>(() => {}); },
    close() { closeCalls += 1; },
  });
  const actions = new CodexNativeShellActions({
    appServer,
    channel,
    childGeneration: 4,
    requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    nativePresentationTimeoutMs: 10,
  });

  await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /native login presentation/i);
  assert.equal(closeCalls, 1);
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);

  appServer.loginResponse = { type: "chatgpt", loginId: "login-2", authUrl: browserUrl() };
  await assert.rejects(actions.beginLogin({ type: "chatgpt" }), /native login presentation/i);
  assert.equal(closeCalls, 1);
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 2);
});

test("caller abort and generation drift settle a stalled private write and cancel once", async () => {
  for (const interrupt of ["abort", "generation"] as const) {
    const appServer = new FakeAppServer();
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let closeCalls = 0;
    const channel = new NativeSidecarChannel({
      writeAction() {
        markWriteStarted();
        return new Promise<void>(() => {});
      },
      readControl() { return new Promise<Uint8Array | null>(() => {}); },
      close() { closeCalls += 1; },
    });
    const actions = new CodexNativeShellActions({
      appServer,
      channel,
      childGeneration: 4,
      requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      nativePresentationTimeoutMs: 100,
    });
    const caller = new AbortController();
    const pending = actions.beginLogin({ type: "chatgpt" }, caller.signal);
    await writeStarted;
    if (interrupt === "abort") caller.abort(new Error("caller stopped"));
    else actions.setChildGeneration(5);

    const outcome = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 30)),
    ]);
    assert.equal(outcome, "rejected", interrupt);
    assert.equal(closeCalls, 1, interrupt);
    assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1, interrupt);
  }
});

test("a stalled commit and queued revoke stay bounded and cannot hang the next attempt", async () => {
  const appServer = new FakeAppServer();
  const acceptedFrames: Uint8Array[] = [];
  let markCommitAccepted!: () => void;
  let releaseCommit!: () => void;
  const commitAccepted = new Promise<void>((resolve) => { markCommitAccepted = resolve; });
  const commitCompletion = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const closedFds: number[] = [];
  const transport = createFixedDescriptorTransportForTest({
    read() { return new Promise<number>(() => {}); },
    async write(_fd, buffer) {
      const copy = Uint8Array.from(buffer);
      acceptedFrames.push(copy);
      if (decodeActionFrame<CodexNativeActionRequest>(copy).kind === "codex-native-action-commit") {
        markCommitAccepted();
        await commitCompletion;
      }
      return buffer.byteLength;
    },
    close(fd) { closedFds.push(fd); },
  });
  const actions = new CodexNativeShellActions({
    appServer,
    channel: new NativeSidecarChannel(transport),
    childGeneration: 4,
    now: () => 1_000,
    requestId: () => "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    nativePresentationTimeoutMs: 20,
  });
  const caller = new AbortController();
  const first = actions.beginLogin({ type: "chatgpt" }, caller.signal);
  await commitAccepted;
  caller.abort(new Error("caller stopped"));

  const firstOutcome = await Promise.race([
    first.then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(firstOutcome, "rejected");
  assert.deepEqual(closedFds.sort((left, right) => left - right), [198, 199]);
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 1);

  releaseCommit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(acceptedFrames.map((frame) => decodeActionFrame<CodexNativeActionRequest>(frame).kind), [
    "codex-browser-login-prepare",
    "codex-native-action-commit",
  ]);

  appServer.loginResponse = { type: "chatgpt", loginId: "login-2", authUrl: browserUrl() };
  const secondOutcome = await Promise.race([
    actions.beginLogin({ type: "chatgpt" }).then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(secondOutcome, "rejected");
  assert.equal(appServer.calls.filter(({ method }) => method === "account/login/cancel").length, 2);
});

test("uses only the six allowed lifecycle/catalog methods", async () => {
  const { actions, appServer } = fixture();
  await actions.readAccount();
  await actions.readRateLimits();
  await actions.listModels();
  await actions.cancelLogin("login-1");
  await actions.logout();
  assert.deepEqual(appServer.calls.map(({ method }) => method), [
    "account/read", "account/rateLimits/read", "model/list",
    "account/login/cancel", "account/logout",
  ]);
  assert.deepEqual(appServer.calls[0]?.params, { refreshToken: false });
});
