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

test("custom fake routes stay explicit while the built GUI refuses legacy Cross without fallback",async()=>{
  const client=new Client();
  try{
    await client.wait(frame=>frame.t==="hello");
    await client.request("hello-ack",{protocol:2,client:"local-safety-journey"});
    const desktop=await client.wait(frame=>frame.t==="event"&&frame.e==="desktop.snapshot");
    const snapshot=desktop.snapshot as {generation:number;providers:{routes:{canonicalModelId:string}[]}[]};
    assert.equal(snapshot.generation,19);
    assert.equal(snapshot.providers[0]?.routes[0]?.canonicalModelId,"custom/gpt-red");
    const refused=await client.request("command",{raw:"/cross",draft:"same ContextPacket task"});
    assert.equal(refused.ok,false);assert.equal((refused.error as {code:string}).code,"local-flow-required");
    const catalog=await client.request("catalog.search",{query:"cross"});
    const rows=(catalog.result as {rows:{command?:string;presentation:{disabled?:{code:string}}}[]}).rows;
    assert.equal(rows.filter(row=>row.command==="/cross stop").length,1);
    assert.equal(rows.find(row=>row.command==="/cross run")?.presentation.disabled?.code,"local-flow-required");
    assert.equal(client.frames.some(frame=>frame.t==="ask"),false);
    assert.equal(client.frames.some(frame=>frame.t==="event"&&frame.e==="cross"&&(frame.state as {active?:boolean})?.active),false);
  }finally{await client.close();}
  const result=client.result();
  assert.deepEqual(result.injectedRoutes,routes);assert.equal(result.fakeGenerationSeen,19);
  assert.deepEqual(result.counters,{authority:0,localFake:0,external:0});
  assert.equal(result.dispatchCallbacks,0);assert.equal(result.singleModelFallbacks,0);
  assert.equal(result.crossWorkersStarted,0);assert.equal(result.crossWorkersAborted,0);
  assert.deepEqual(result.fakePrompts,[]);
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
