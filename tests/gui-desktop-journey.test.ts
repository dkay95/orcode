import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// @ts-expect-error Task 3 deliberately exposes a plain-ESM built-child fixture.
import { createGuiProviderFake } from "./fixtures/gui-provider-fake.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "tests/fixtures/gui-provider-fake.mjs");
const distGui = pathToFileURL(join(root, "dist/gui-server.js")).href;
const routes = [
  { version: 1, backendId: "openrouter", accountFingerprint: "custom-lead", billingRealm: "fixture", requestedModelId: "custom/gpt-red", canonicalModelId: "custom/gpt-red", resolutionState: "resolved" },
  { version: 1, backendId: "openrouter", accountFingerprint: "custom-challenger", billingRealm: "fixture", requestedModelId: "custom/kimi-blue", canonicalModelId: "custom/kimi-blue", resolutionState: "resolved" },
];

function packetOf(prompt: string): string {
  const marker = "The following ContextPacket is the only source of the task.";
  const markerIndex = prompt.indexOf(marker);
  assert.notEqual(markerIndex, -1, "the ContextPacket prose marker must exist");
  const packetIndex = prompt.indexOf("{", markerIndex + marker.length);
  assert.notEqual(packetIndex, -1, "serialized ContextPacket JSON must follow the marker");
  const serialized = prompt.slice(packetIndex);
  let packet: unknown;
  try {
    packet = JSON.parse(serialized);
  } catch {
    assert.fail("serialized ContextPacket must be valid JSON");
  }
  assert.equal(
    typeof packet === "object" && packet !== null && !Array.isArray(packet)
      ? (packet as { version?: unknown }).version
      : undefined,
    1,
    "serialized ContextPacket must use version 1",
  );
  return serialized;
}

class Client {
  child: ReturnType<typeof spawn>;
  frames: Record<string, unknown>[] = [];
  stderr = "";
  stdout = "";
  next = 0;
  waiters: Array<{ match: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }> = [];
  constructor(forceExternal = false, guiModuleUrl: string | null = distGui) {
    const fake = createGuiProviderFake({ generation: 19, routes, requests: {} });
    const childEnv = { ...process.env, FORCE_COLOR: "0", NODE_TEST_CONTEXT: undefined, ...fake.childEnvironment(guiModuleUrl ?? "", forceExternal) };
    if (guiModuleUrl === null) delete childEnv.ORCODE_GUI_SERVER_MODULE;
    this.child = spawn(process.execPath, [harness], {
      cwd: root,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (text: string) => { this.stderr += text; });
    this.child.on("error", (error) => { this.stderr += `CHILD_ERROR:${error.message}`; });
    this.child.on("exit", (code) => { this.stderr += `CHILD_EXIT:${code}`; });
    createInterface({ input: this.child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
      this.stdout += `${line}\n`;
      if (!line.trim().startsWith("{")) return;
      const frame = JSON.parse(line) as Record<string, unknown>;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) if (waiter.match(frame)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame);
      }
    });
  }
  send(frame: Record<string, unknown>) { this.child.stdin!.write(`${JSON.stringify({ v: 2, ...frame })}\n`); }
  request(t: string, payload: Record<string, unknown> = {}) {
    const id = `j${++this.next}`;
    const response = this.wait((frame) => frame.t === "response" && frame.id === id);
    this.send({ t, id, ...payload });
    return response;
  }
  wait(match: (frame: Record<string, unknown>) => boolean, timeout = 15_000) {
    const found = this.frames.find(match); if (found) return Promise.resolve(found);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; stdout=${this.stdout}; stderr=${this.stderr}`)), timeout);
      this.waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); }, reject });
    });
  }
  waitAfter(index: number, match: (frame: Record<string, unknown>) => boolean, timeout = 15_000) {
    return this.wait((frame) => this.frames.indexOf(frame) >= index && match(frame), timeout);
  }
  async close() {
    if (this.child.exitCode !== null) return;
    await this.request("shutdown");
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }
  result() {
    const line = this.stderr.split("\n").find((value) => value.startsWith("ORCODE_GUI_FAKE_RESULT:"));
    return line ? JSON.parse(line.slice("ORCODE_GUI_FAKE_RESULT:".length)) : null;
  }
}

test("custom fake routes reach the real built GUI projection and Stop settles without fallback", async () => {
  const client = new Client();
  try {
    await client.wait((frame) => frame.t === "hello");
    await client.request("hello-ack", { protocol: 2, client: "cross-journey" });
    const desktop = await client.wait((frame) => frame.t === "event" && frame.e === "desktop.snapshot");
    assert.equal((desktop.snapshot as { generation: number }).generation, 19);
    const command = client.request("command", { raw: "/cross", draft: "same ContextPacket task" });
    let gate = await client.wait((frame) => frame.t === "ask" && frame.presentation === "cross-preflight");
    const answer = async (value: string) => {
      const previous = gate;
      const mark = client.frames.length;
      client.send({ t: "answer", askId: previous.askId, value });
      gate = await client.waitAfter(mark, (frame) => frame.t === "ask" && frame.presentation === "cross-preflight");
    };
    await answer("duration-one-task");
    for (const [role, model] of [["coding", "custom/gpt-red"], ["review", "custom/kimi-blue"]] as const) {
      const previous = gate;
      let mark = client.frames.length;
      client.send({ t: "answer", askId: previous.askId, value: role });
      const picker = await client.waitAfter(mark, (frame) => frame.t === "ask" && frame.kind === "choice" && frame.presentation !== "cross-preflight");
      const item = (picker.items as Array<{ value: string; label: string }>).find(({ label }) => label.includes(model));
      assert.ok(item, `${model} must come from the injected authority`);
      mark = client.frames.length;
      client.send({ t: "answer", askId: picker.askId, value: item.value });
      gate = await client.waitAfter(mark, (frame) => frame.t === "ask" && frame.presentation === "cross-preflight");
    }
    const previous = gate;
    client.send({ t: "answer", askId: previous.askId, value: "start" });
    const confirm = await client.wait((frame) => frame.t === "ask" && frame.kind === "confirm");
    client.send({ t: "answer", askId: confirm.askId, accepted: true });
    assert.equal((await command).ok, true);
    const active = await client.wait((frame) => frame.t === "event" && frame.e === "cross"
      && (frame.state as { active?: boolean; phase?: string } | null)?.active === true
      && /Review|Challenger|prüft/i.test(String((frame.state as { phase?: string }).phase)));
    const state = active.state as { lead: { displayName: string; accountLabel: string; canonicalModelId: string }; challenger: { displayName: string; accountLabel: string; canonicalModelId: string }; phase: string };
    assert.deepEqual(state.lead, { providerLabel: "OpenRouter", accountLabel: "Codex Privat", displayName: "GPT-5.4 Codex", canonicalModelId: "custom/gpt-red", reasoning: "supported", capabilities: ["text", "tools"] });
    assert.deepEqual(state.challenger, { providerLabel: "OpenRouter", accountLabel: "Kimi Privat", displayName: "Kimi K3", canonicalModelId: "custom/kimi-blue", reasoning: "supported", capabilities: ["text", "tools"] });
    assert.match(state.phase, /Review|Challenger|prüft/i);
    const catalog = await client.request("catalog.search", { query: "cross" });
    const stopRows = (catalog.result as { rows: Array<{ command?: string }> }).rows.filter(({ command }) => command === "/cross stop");
    assert.equal(stopRows.length, 1);
    const before = client.frames.length;
    assert.equal((await client.request("command", { raw: "/cross stop", draft: "" })).ok, true);
    await client.wait((frame) => client.frames.indexOf(frame) >= before && frame.t === "event" && frame.e === "cross" && (frame.state as { active?: boolean } | null)?.active === false);
  } finally { await client.close(); }
  const result = client.result();
  assert.deepEqual(result.injectedRoutes, routes);
  assert.equal(result.fakeGenerationSeen, 19);
  assert.equal(result.counters.external, 0);
  assert.ok(result.counters.authority >= 4);
  assert.equal(result.counters.localFake, 4);
  assert.equal(result.dispatchCallbacks, 4);
  assert.equal(result.singleModelFallbacks, 0);
  assert.equal(result.crossWorkersStarted, 4);
  assert.equal(result.crossWorkersAborted, 1);
  assert.equal(result.crossWorkersStarted, result.crossWorkersAborted + 3);
  assert.equal(packetOf(result.fakePrompts[0]), packetOf(result.fakePrompts[1]), "both roles receive the same ContextPacket");
});

test("ContextPacket comparison rejects identical malformed or wrong-version suffixes", () => {
  const marker = "The following ContextPacket is the only source of the task.";
  assert.throws(() => packetOf(`${marker} {not-json`), /valid JSON/);
  assert.throws(() => packetOf(`${marker} {"version":2}`), /version 1/);
});

test("external provider dispatch is counted in the child and refused before I/O", async () => {
  const client = new Client(true);
  await new Promise<void>((resolve) => client.child.once("exit", () => resolve()));
  const result = client.result();
  assert.deepEqual(result.counters, { authority: 0, localFake: 0, external: 1 });
  assert.equal(result.dispatchCallbacks, 0);
  assert.match(result.error, /forbidden before dispatch/);
});

test("the external guard cannot hide a missing built GUI module", async () => {
  const client = new Client(true, null);
  await new Promise<void>((resolve) => client.child.once("exit", () => resolve()));
  assert.equal(client.result(), null);
  assert.match(client.stderr, /ORCODE_GUI_SERVER_MODULE is missing/);
  assert.match(client.stderr, /CHILD_EXIT:1/);
});
