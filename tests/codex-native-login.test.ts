import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexProfileRouteRuntime, type CodexAccountModelClient } from "../src/model-runtime.js";
import { NativeSidecarChannel, decodeActionFrame, encodeControlFrame, type CodexNativeActionRequest } from "../src/native-sidecar-channel.js";
import { ProviderActivationCoordinator } from "../src/provider-activation.js";
import { ProviderStateStore } from "../src/provider-state.js";
import { PrivateStore } from "../src/private-store.js";

class LoginClient implements CodexAccountModelClient {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  calls: string[] = [];
  closed = false;
  epochDuringRead = false;
  complete = true;
  terminalListeners = new Set<() => void>();
  onTerminal(listener: () => void) { this.terminalListeners.add(listener); return () => { this.terminalListeners.delete(listener); }; }
  terminate() { for (const listener of this.terminalListeners) listener(); }
  email: string | null = "private-owner@example.invalid";
  onNotification(method: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener); this.listeners.set(method, listeners);
    return () => { listeners.delete(listener); };
  }
  emit(method: string, value: unknown) { for (const listener of this.listeners.get(method) ?? []) listener(value); }
  async start() { this.emit("account/updated", { authMode: null, planType: null }); }
  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push(method);
    if (method === "account/login/start") {
      assert.deepEqual(params, { type: "chatgptDeviceCode" });
      // Completion can precede the login/start response and native presentation.
      this.emit("account/updated", { authMode: "chatgpt", planType: "pro" });
      this.emit("account/login/completed", { loginId: "unrelated", success: false, error: "private-error" });
      if (this.complete) this.emit("account/login/completed", { loginId: "login-1", success: true, error: null });
      return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } as T;
    }
    if (method === "account/read") {
      assert.deepEqual(params, { refreshToken: false });
      if (this.epochDuringRead) this.emit("account/updated", { authMode: "chatgpt", planType: "pro" });
      return { account: { type: "chatgpt", email: this.email, planType: "pro" }, requiresOpenaiAuth: true } as T;
    }
    if (method === "account/login/cancel") return {} as T;
    throw new Error("unexpected request");
  }
  async drain(): Promise<"closed"> { this.closed = true; return "closed"; }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, afterAdopt?: () => void) {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-native-profile-"));
  t.after(() => rm(appHome, { recursive: true, force: true }));
  const initial = { schemaVersion: 3 as const, revision: 0, lifecycle: "never-configured" as const,
    connections: [], defaultRoute: null, cross: { enabled: false as const, preferredLead: null, preferredChallenger: null } };
  let durable = structuredClone(initial) as import("../src/provider-state.js").ProviderSetupStateV3;
  const stateStore = new ProviderStateStore(initial, { async persist(request) {
    const next = request.build(durable); durable = structuredClone(next); request.adopt(next);
    afterAdopt?.(); return structuredClone(next);
  } });
  const client = new LoginClient();
  const controls: Uint8Array[] = [];
  let pending: ((value: Uint8Array | null) => void) | null = null;
  let home = "";
  let nativePresented = false;
  let resolvePresented: () => void = () => {};
  const presented = new Promise<void>((resolve) => { resolvePresented = resolve; });
  const channel = new NativeSidecarChannel({
    async writeAction(frame) {
      const action = decodeActionFrame<CodexNativeActionRequest>(frame);
      if (action.kind !== "codex-native-action-commit") return;
      nativePresented = true;
      resolvePresented();
      assert.equal(action.childGeneration, 73, "native generation is the sidecar generation, not AppServer generation");
      const result = encodeControlFrame({ kind: "codex-native-action-result", requestId: action.requestId,
        childGeneration: action.childGeneration, status: "presented" });
      if (pending) { const resolve = pending; pending = null; resolve(result); } else controls.push(result);
    },
    async readControl() { return controls.shift() ?? new Promise<Uint8Array | null>((resolve) => { pending = resolve; }); },
    close() { pending?.(null); pending = null; },
  });
  t.after(async () => { channel.close(); });
  const runtime = new CodexProfileRouteRuntime({ appHome, stateStore,
    nativeLogin: { channel, childGeneration: 73 },
    createClient: async ({ profile }) => { home = profile.codexHome; return client; },
  });
  let credentialCalls = 0;
  const coordinator = new ProviderActivationCoordinator({ appHome, configPath: join(appHome, "config.json"),
    privateStore: new PrivateStore({ root: appHome }), stateStore,
    credentials: new Proxy({ location: "test" }, { get(target, key) {
      if (key === "location") return target.location;
      return () => { credentialCalls++; throw new Error("keychain forbidden"); };
    } }) as never,
    adapterResolver: () => { throw new Error("candidate adapter forbidden"); },
    runtimeGuard: { async acquire() { return { async assertHeld() {}, assertHeldSynchronously() {}, async release() {} }; } },
  });
  return { appHome, stateStore, client, runtime, coordinator, home: () => home,
    presented, nativePresented: () => nativePresented, credentialCalls: () => credentialCalls };
}

test("native first login retains one authenticated private home without selecting any model or keychain", async (t) => {
  const f = await fixture(t);
  const selection = await f.runtime.connectNative("chatgptDeviceCode", new AbortController().signal);
  assert.equal(f.client.closed, true, "login child is drained before retention");
  assert.equal(f.stateStore.read().connections.length, 0, "authentication alone is not a durable commit");
  const state = await f.coordinator.retainCodexProfile({ expectedRevision: 0, selection,
    signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 });
  assert.equal(state.revision, 1);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].credentialBinding.kind, "provider-runtime");
  assert.equal(state.defaultRoute, null);
  assert.equal(state.cross.enabled, false);
  assert.equal((await stat(f.home())).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(state).includes("private-owner"), false);
  assert.deepEqual(f.client.calls, ["account/login/start", "account/read"]);
  assert.equal(f.credentialCalls(), 0);
  await assert.rejects(f.runtime.connectNative("chatgptDeviceCode"), /profile|Profil/i);
});

test("login auth epoch changes during verification cannot retain a profile", async (t) => {
  const f = await fixture(t); f.client.epochDuringRead = true;
  await assert.rejects(f.runtime.connectNative("chatgptDeviceCode"), /current|stale|changed/i);
  assert.equal(f.client.closed, true);
  assert.equal(f.stateStore.read().connections.length, 0);
});

test("a competing state revision makes first-login retention stale without changing the route", async (t) => {
  const f = await fixture(t);
  const selection = await f.runtime.connectNative("chatgptDeviceCode");
  await f.stateStore.commit(0, (state) => ({ ...state }));
  await assert.rejects(f.coordinator.retainCodexProfile({ expectedRevision: 0, selection,
    signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 }), /stale|generation/i);
  assert.equal(f.stateStore.read().connections.length, 0);
});

test("null account identity fails closed without saving an authenticated-looking profile", async (t) => {
  const f = await fixture(t); f.client.email = null;
  await assert.rejects(f.runtime.connectNative("chatgptDeviceCode"), /Reconnect.*profile/i);
  assert.equal(f.client.closed, true);
  assert.equal(f.stateStore.read().connections.length, 0);
});

test("cancelling a presented login waiting for completion drains it without retention", async (t) => {
  const f = await fixture(t); f.client.complete = false;
  const abort = new AbortController();
  const login = f.runtime.connectNative("chatgptDeviceCode", abort.signal);
  const rejected = assert.rejects(login, /owner cancelled/);
  await Promise.race([f.presented, login]);
  assert.equal(f.nativePresented(), true);
  abort.abort(new Error("owner cancelled"));
  await rejected;
  assert.equal(f.client.closed, true);
  assert.equal(f.stateStore.read().connections.length, 0);
  assert.ok(f.client.calls.includes("account/login/cancel"));
});

test("without a private native presenter first login has zero runtime and credential effects", async (t) => {
  const f = await fixture(t);
  const runtime = new CodexProfileRouteRuntime({ appHome: f.appHome, stateStore: f.stateStore,
    createClient: async () => { throw new Error("must not spawn"); } });
  assert.equal(runtime.nativeLoginAvailable(), false);
  await assert.rejects(runtime.connectNative("chatgptDeviceCode"), /signed Desktop app/i);
  assert.equal(f.stateStore.read().connections.length, 0);
  assert.equal(f.credentialCalls(), 0);
});

for (const lateError of [false, true]) test(`durably adopted first login completes despite ${lateError ? "late writer failure" : "late owner cancellation"}`, async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, () => { abort.abort(new Error("late owner cancellation")); if (lateError) throw new Error("late writer failure"); });
  const selection = await f.runtime.connectNative("chatgptDeviceCode", abort.signal);
  const retained = await f.coordinator.retainCodexProfile({ expectedRevision: 0, selection, signal: abort.signal, deadlineAt: Date.now() + 10_000 });
  assert.equal(retained.revision, 1);
  assert.equal(retained.connections.length, 1);
  assert.equal(retained.defaultRoute, null);
  assert.deepEqual(retained, f.stateStore.read());
});

test("an AppServer terminal event after native presentation promptly releases the pending login", async (t) => {
  const f = await fixture(t); f.client.complete = false;
  const abort = new AbortController(); t.after(async () => { abort.abort(); });
  const login = f.runtime.connectNative("chatgptDeviceCode", abort.signal);
  const rejection = assert.rejects(login, /session ended|current|Reconnect/i);
  await Promise.race([f.presented, login]);
  f.client.terminate();
  await Promise.race([rejection, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal event did not settle login")), 1_000); timer.unref();
  })]);
  assert.equal(f.client.closed, true);
  assert.equal(f.client.terminalListeners.size, 0);
  assert.equal(f.stateStore.read().connections.length, 0);
});
