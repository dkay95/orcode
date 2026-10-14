import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient, createCodexAppServerLaunchPlan, resolveOfficialCodexPayload,
  type CodexAppServerTransport } from "../src/codex-app-server.js";
import { CodexProfileRouteRuntime } from "../src/model-runtime.js";
import { codexAccountFingerprint } from "../src/codex-account-identity.js";
import { ProviderStateStore } from "../src/provider-state.js";
import { parseCodexHomeId } from "../src/codex-profile.js";

const homeId = parseCodexHomeId("codex-11111111111111111111111111111111");
const account = (email = "owner@example.invalid") => ({ account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true });
const model = (id: string) => ({ id, model: id, displayName: id, description: "", hidden: false,
  isDefault: id === "first-model", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }] });

class MetadataTransport implements CodexAppServerTransport {
  lines: Array<string | null> = []; pending: ((line: string | null) => void) | null = null;
  closed = false; calls: string[] = [];
  heldReadId: unknown = null;
  constructor(readonly home: string, readonly email: string, readonly ids: string[], readonly holdRead?: () => void,
    readonly initialEvent = true) {}
  emit(value: unknown) { const line = JSON.stringify(value); if (this.pending) { const done = this.pending; this.pending = null; done(line); } else this.lines.push(line); }
  async writeLine(line: string) {
    const frame = JSON.parse(line); this.calls.push(frame.method);
    if (frame.method === "initialize") {
      this.emit({ id: frame.id, result: { codexHome: this.home, platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.159.1" } });
      if (this.initialEvent) this.emit({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } });
    }
    if (frame.method === "account/read") {
      if (this.holdRead) { this.heldReadId = frame.id; this.holdRead(); }
      else this.emit({ id: frame.id, result: account(this.email) });
    }
    if (frame.method === "model/list") this.emit({ id: frame.id, result: { data: this.ids.map(model), nextCursor: null } });
  }
  async readLine() { if (this.lines.length) return this.lines.shift()!; if (this.closed) return null; return new Promise<string | null>((done) => { this.pending = done; }); }
  close() { this.closed = true; this.pending?.(null); this.pending = null; }
  async drain(): Promise<"closed"> { this.close(); return "closed"; }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, initialEvent = true, legacyFingerprint = false) {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-codex-renew-"));
  const clients: CodexAppServerClient[] = []; const transports: MetadataTransport[] = [];
  t.after(async () => { for (const client of clients) await client.drain(); await rm(appHome, { recursive: true, force: true }); });
  const fakePayload = join(appHome, "fake-payload"); await writeFile(fakePayload, "untrusted", { mode: 0o700 });
  await assert.rejects(resolveOfficialCodexPayload(fakePayload), /trusted signed Codex payload/i);
  const payload = await resolveOfficialCodexPayload(); // Verification only: no real provider process or auth read.
  const fingerprint = legacyFingerprint ? "legacy-opaque-profile" : codexAccountFingerprint(homeId, account());
  const route = { version: 1 as const, backendId: "codex" as const, accountFingerprint: fingerprint,
    billingRealm: "chatgpt-subscription-provider-managed-overage" as const,
    requestedModelId: "selected-model", canonicalModelId: "selected-model", resolutionState: "resolved" as const };
  const stateStore = new ProviderStateStore({ schemaVersion: 3, revision: 1, lifecycle: "configured", defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null }, connections: [{ id: "profile", backendId: "codex",
      enabled: true, maturity: "preview", credentialBinding: { kind: "provider-runtime", homeId }, accountFingerprint: fingerprint,
      accountFingerprintState: "verified", billingRealm: route.billingRealm, lastHealth: null }] });
  let email = "owner@example.invalid"; let models = ["first-model", "selected-model"];
  let holdRefresh = false;
  let readStarted: () => void = () => {};
  const refreshReadStarted = new Promise<void>((resolve) => { readStarted = resolve; });
  const runtime = new CodexProfileRouteRuntime({ appHome, stateStore, createClient: async ({ profile }) => {
    const transport = new MetadataTransport(profile.codexHome, email, models, holdRefresh ? readStarted : undefined, initialEvent);
    transports.push(transport);
    const client = new CodexAppServerClient(await createCodexAppServerLaunchPlan(profile, payload), async () => transport);
    clients.push(client); return client;
  } });
  await runtime.listModelsForProfile({ connectionId: "profile", stateRevision: 1, generation: 2, signal: new AbortController().signal });
  runtime.prepareRouteSelection({ connectionId: "profile", requestedModelId: "selected-model", canonicalModelId: "selected-model",
    stateRevision: 1, generation: 2 }).bind({ stateRevision: 1, generation: 2 });
  return { runtime, route, stateStore, transports, changeEmail: () => { email = "different@example.invalid"; },
    removeSelectedModel: () => { models = ["first-model"]; },
    holdNextRefresh: () => { holdRefresh = true; }, refreshReadStarted };
}

test("two turns acquire fresh concrete clients for the same explicit model after the prior child drained", async (t) => {
  const f = await fixture(t); let invalidations = 0; f.runtime.onRouteInvalidated(() => { invalidations++; });
  const before = f.stateStore.read();
  const first = (await f.runtime.currentExecutionAuthority(f.route))!;
  await first.client.drain();
  const second = (await f.runtime.currentExecutionAuthority(f.route))!;
  assert.notEqual(first.client, second.client);
  assert.ok(second.childGeneration > first.childGeneration);
  assert.equal(second.binding.modelId, "selected-model");
  assert.deepEqual(f.stateStore.read(), before);
  assert.equal(invalidations, 0, "initial auth observation of a renewed client does not disconnect the selected route");
  assert.equal(f.transports.flatMap((transport) => transport.calls).some((method) => method === "thread/start" || method === "turn/start"), false);
});

test("same-plan different identity on the fresh client cannot become execution authority", async (t) => {
  const f = await fixture(t); f.changeEmail();
  await assert.rejects(f.runtime.currentExecutionAuthority(f.route), /account changed|profile/i);
  assert.equal(f.runtime.hasCurrentRoute(f.route, 1, 2), false);
});

test("an explicit account refresh after a consumed turn does not reuse its drained child", async (t) => {
  const f = await fixture(t);
  const authority = (await f.runtime.currentExecutionAuthority(f.route))!;
  await authority.client.drain();
  const models = await f.runtime.listModelsForProfile({ connectionId: "profile", stateRevision: 1,
    generation: 2, signal: new AbortController().signal });
  assert.deepEqual(models.map((entry) => entry.canonicalModelId), ["first-model", "selected-model"]);
  assert.equal(f.transports.length, 3);
  assert.equal(f.stateStore.read().defaultRoute?.canonicalModelId, "selected-model");
});

test("a model removed from a fresh catalogue never falls back to the first model", async (t) => {
  const f = await fixture(t); f.removeSelectedModel();
  await assert.rejects(f.runtime.currentExecutionAuthority(f.route), /selection|model/i);
  assert.equal(f.stateStore.read().defaultRoute?.canonicalModelId, "selected-model");
  assert.equal(f.runtime.hasCurrentRoute(f.route, 1, 2), false);
});

test("owner cancellation interrupts a deferred account refresh before any task dispatch", async (t) => {
  const f = await fixture(t); f.holdNextRefresh();
  const abort = new AbortController();
  const pending = f.runtime.currentExecutionAuthority(f.route, abort.signal);
  void pending.catch(() => undefined);
  await f.refreshReadStarted;
  abort.abort(new Error("refresh cancelled by owner"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("refresh ignored owner cancellation")), 1_000);
    })]), /refresh cancelled by owner/);
  } finally { clearTimeout(timer); }
  assert.equal(f.transports.at(-1)?.closed, true);
  assert.equal(f.stateStore.read().defaultRoute?.canonicalModelId, "selected-model");
  assert.equal(f.transports.flatMap((transport) => transport.calls).includes("turn/start"), false);
});

test("a fresh child without unsolicited auth notification uses a real account read, not a synthetic event", async (t) => {
  const f = await fixture(t, false);
  const authority = await f.runtime.currentExecutionAuthority(f.route);
  assert.equal(authority?.binding.modelId, "selected-model");
  assert.equal(f.transports.at(-1)?.calls.filter((method) => method === "account/read").length, 1);
  assert.equal(f.stateStore.read().defaultRoute?.canonicalModelId, "selected-model");
});

test("initial-read discovery rejects same-plan account substitution without an unsolicited event", async (t) => {
  const f = await fixture(t, false); f.changeEmail();
  await assert.rejects(f.runtime.currentExecutionAuthority(f.route), /account changed/i);
  assert.equal(f.runtime.hasCurrentRoute(f.route, 1, 2), false);
});

test("an account update during fresh initial account read invalidates that response", async (t) => {
  const f = await fixture(t, false); f.holdNextRefresh();
  const pending = f.runtime.currentExecutionAuthority(f.route);
  void pending.catch(() => undefined);
  await f.refreshReadStarted;
  const transport = f.transports.at(-1)!;
  transport.emit({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } });
  transport.emit({ id: transport.heldReadId, result: account() });
  await assert.rejects(pending, /generation.*stale/i);
  assert.equal(transport.closed, true);
});

test("a later null auth notification never becomes an initial-read shortcut", async (t) => {
  const f = await fixture(t, false); let invalidations = 0;
  f.runtime.onRouteInvalidated(() => { invalidations++; });
  const transport = f.transports.at(-1)!;
  transport.emit({ method: "account/updated", params: { authMode: null, planType: null } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reads = transport.calls.filter((method) => method === "account/read").length;
  await assert.rejects(f.runtime.listModelsForProfile({ connectionId: "profile", stateRevision: 1,
    generation: 2, signal: new AbortController().signal }), /authentication.*current/i);
  assert.equal(transport.calls.filter((method) => method === "account/read").length, reads);
  assert.equal(f.runtime.hasCurrentRoute(f.route, 1, 2), false);
  assert.equal(invalidations, 1);
});

test("eventless initial discovery cannot substitute a legacy opaque fingerprint for verified account identity", async (t) => {
  await assert.rejects(fixture(t, false, true), /account identity.*Reconnect/i);
});

test("legacy profile handling still requires and respects its actual account event", async (t) => {
  const f = await fixture(t, true, true);
  assert.equal((await f.runtime.currentExecutionAuthority(f.route))?.binding.modelId, "selected-model");
});
