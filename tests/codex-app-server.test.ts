import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, type TestContext } from "node:test";
import { CODEX_APP_SERVER_RUNTIME_POLICY } from "../src/backends.js";
import {
  CODEX_APP_SERVER_ARGV,
  CodexAppServerClient,
  createCodexAppServerLaunchPlan,
  resolveOfficialCodexPayload,
  type CodexAppServerLaunchPlan,
  type CodexAppServerTransport,
  type CodexAppServerTransportFactory,
} from "../src/codex-app-server.js";
import { createCodexHome, parseCodexHomeId } from "../src/codex-profile.js";

const HARNESS_SOURCE = fileURLToPath(new URL("./fixtures/codex-app-server-harness.mjs", import.meta.url));
const WRAPPER = "/usr/local/bin/codex";
const WRAPPER_REALPATH = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
const PACKAGE_ROOT = dirname(dirname(WRAPPER_REALPATH));
const PAYLOAD = join(
  PACKAGE_ROOT,
  "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
);
let trustedIdentityPromise: ReturnType<typeof resolveOfficialCodexPayload> | undefined;
let rejectedHarnessRoot = "";
let rejectedHarnessPath = "";
let fakeHarnessWasRejected = false;

before(async () => {
  rejectedHarnessRoot = await mkdtemp(join(tmpdir(), "orcode-rejected-codex-"));
  await chmod(rejectedHarnessRoot, 0o700);
  rejectedHarnessPath = join(rejectedHarnessRoot, "codex");
  await copyFile(HARNESS_SOURCE, rejectedHarnessPath);
  await chmod(rejectedHarnessPath, 0o755);
  await assert.rejects(resolveOfficialCodexPayload(rejectedHarnessPath), /trusted signed Codex payload/i);
  fakeHarnessWasRejected = true;
});

after(async () => {
  if (rejectedHarnessRoot !== "") await rm(rejectedHarnessRoot, { recursive: true, force: true });
});

function trustedIdentity() {
  trustedIdentityPromise ??= resolveOfficialCodexPayload(WRAPPER);
  return trustedIdentityPromise;
}

class HarnessTransport implements CodexAppServerTransport {
  readonly frames: unknown[] = [];
  readonly drainStarted: Promise<void>;
  readonly readAbortObserved: Promise<void>;
  readonly stalledWriteStarted: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #scenario: string;
  readonly #lines: Array<string | null> = [];
  readonly #waiters: Array<(line: string | null) => void> = [];
  readonly #resolveDrainStarted: () => void;
  readonly #resolveReadAbortObserved: () => void;
  readonly #resolveStalledWriteStarted: () => void;
  #resolveStalledWrite: (() => void) | null = null;
  #resolveStalledDrain: ((result: "closed" | "killed") => void) | null = null;
  #buffer = "";
  #closed = false;
  readonly #writeAbort = new AbortController();
  drainCalls = 0;

  constructor(scenario: string, launch: CodexAppServerLaunchPlan) {
    this.#scenario = scenario;
    let resolveDrainStarted!: () => void;
    let resolveReadAbortObserved!: () => void;
    let resolveStalledWriteStarted!: () => void;
    this.drainStarted = new Promise<void>((resolve) => {
      resolveDrainStarted = resolve;
    });
    this.stalledWriteStarted = new Promise<void>((resolve) => {
      resolveStalledWriteStarted = resolve;
    });
    this.readAbortObserved = new Promise<void>((resolve) => {
      resolveReadAbortObserved = resolve;
    });
    this.#resolveDrainStarted = resolveDrainStarted;
    this.#resolveReadAbortObserved = resolveReadAbortObserved;
    this.#resolveStalledWriteStarted = resolveStalledWriteStarted;
    assert.equal(fakeHarnessWasRejected, true, "production trust resolution must reject this fake before injection");
    this.#child = spawn(process.execPath, [rejectedHarnessPath, scenario, launch.profile.codexHome], {
      env: Object.freeze({}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.resume();
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#enqueue(line);
      }
    });
    this.#child.once("exit", () => {
      if (this.#scenario !== "open-read-after-drain") this.#enqueue(null);
    });
    this.#child.once("error", () => this.#enqueue(null));
  }

  async writeLine(line: string): Promise<void> {
    if (this.#closed) throw new Error("Fake App Server transport is closed.");
    const frame = JSON.parse(line) as { method?: unknown };
    this.frames.push(frame);
    if (this.#scenario === "missing-initialized" && frame.method === "initialized") {
      throw new Error("initialized notification was not accepted");
    }
    if (this.#scenario === "notify-write-error" && frame.method === "client/fail") {
      throw new Error("injected notification write failure");
    }
    if (this.#scenario === "silent-request" && frame.method === "account/read") return;
    if (this.#scenario === "stalled-request-write" && frame.method === "account/read") {
      return new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(
          this.#writeAbort.signal.reason instanceof Error
            ? this.#writeAbort.signal.reason
            : new Error("Fake App Server transport is closed."),
        );
        if (this.#writeAbort.signal.aborted) {
          onAbort();
          return;
        }
        this.#writeAbort.signal.addEventListener("abort", onAbort, { once: true });
        this.#resolveStalledWriteStarted();
      });
    }
    if (this.#scenario === "stalled-notification-write" && frame.method === "client/stall") {
      this.#resolveStalledWriteStarted();
      return new Promise<void>((resolve) => { this.#resolveStalledWrite = resolve; });
    }
    if (!this.#child.stdin.write(`${line}\n`)) await once(this.#child.stdin, "drain");
  }

  readLine(signal?: AbortSignal): Promise<string | null> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift()!);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(settle);
        if (index >= 0) this.#waiters.splice(index, 1);
        this.#resolveReadAbortObserved();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      };
      const settle = (line: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.#waiters.push(settle);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#writeAbort.abort(new Error("Fake App Server transport is closed."));
    this.#child.stdin.end();
  }

  releaseRead(): void {
    this.#enqueue(null);
  }

  releaseStalledWrite(): void {
    this.#resolveStalledWrite?.();
    this.#resolveStalledWrite = null;
  }

  releaseDrain(): void {
    this.#resolveStalledDrain?.("killed");
    this.#resolveStalledDrain = null;
  }

  async drain(): Promise<"closed" | "killed"> {
    this.drainCalls += 1;
    this.#resolveDrainStarted();
    this.close();
    if (this.#scenario === "stalled-transport-drain") {
      return new Promise<"closed" | "killed">((resolve) => {
        this.#resolveStalledDrain = resolve;
      });
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return this.#child.signalCode === null ? "closed" : "killed";
    }
    const result = await Promise.race([
      once(this.#child, "exit").then(([, signal]) => signal === null ? "closed" as const : "killed" as const),
      new Promise<"killed">((resolve) => {
        const timer = setTimeout(() => {
          this.#child.kill("SIGKILL");
          resolve("killed");
        }, 1_000);
        timer.unref();
      }),
    ]);
    return result;
  }

  #enqueue(line: string | null): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(line);
    else this.#lines.push(line);
  }
}

class InMemoryProtocolTransport implements CodexAppServerTransport {
  readonly frames: unknown[] = [];
  readonly #lines: Array<string | null> = [];
  readonly #waiters: Array<{
    resolve: (line: string | null) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  readonly secondServerRequestClaimed: Promise<void>;
  readonly #resolveSecondServerRequestClaimed: () => void;
  #serverRequestsClaimed = 0;
  #closed = false;

  constructor(readonly codexHome: string) {
    let resolveSecondServerRequestClaimed!: () => void;
    this.secondServerRequestClaimed = new Promise((resolve) => {
      resolveSecondServerRequestClaimed = resolve;
    });
    this.#resolveSecondServerRequestClaimed = resolveSecondServerRequestClaimed;
  }

  async writeLine(line: string): Promise<void> {
    const frame = JSON.parse(line) as Record<string, unknown>;
    this.frames.push(frame);
    if (frame.method === "initialize") {
      this.emit({ id: frame.id, result: {
        codexHome: this.codexHome,
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "codex_cli_rs/0.142.5",
      } });
    }
  }

  readLine(signal?: AbortSignal): Promise<string | null> {
    if (this.#lines.length > 0) {
      const line = this.#lines.shift()!;
      this.#observeClaim(line);
      return Promise.resolve(line);
    }
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as {
        resolve: (line: string | null) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      };
      waiter.onAbort = onAbort;
      if (signal?.aborted) onAbort();
      else {
        this.#waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  close(): void {
    this.#closed = true;
  }

  async drain(): Promise<"closed"> {
    this.close();
    return "closed";
  }

  emit(frame: unknown): void {
    const line = JSON.stringify(frame);
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      this.#observeClaim(line);
      waiter.resolve(line);
    } else {
      this.#lines.push(line);
    }
  }

  #observeClaim(line: string | null): void {
    if (line === null) return;
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (Object.hasOwn(frame, "id") && Object.hasOwn(frame, "method")) {
      this.#serverRequestsClaimed += 1;
      if (this.#serverRequestsClaimed === 2) this.#resolveSecondServerRequestClaimed();
    }
  }
}

async function requireAutomaticDrain(transport: HarnessTransport): Promise<void> {
  await Promise.race([
    transport.drainStarted,
    new Promise<never>((_resolve, reject) => {
      setImmediate(() => reject(new Error("failClosed did not start transport.drain automatically")));
    }),
  ]);
}

async function requireEventWithinShutdownBound(event: Promise<void>, detail: string): Promise<void> {
  await requireEventWithin(event, 2_000, detail);
}

async function requireEventWithinProcessDrainBound(event: Promise<void>, detail: string): Promise<void> {
  await requireEventWithin(event, 5_000, detail);
}

async function requireEventWithin(event: Promise<void>, timeoutMs: number, detail: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(detail)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fakeTransport(
  scenario: string,
  captures: HarnessTransport[] = [],
): CodexAppServerTransportFactory {
  return async (launch) => {
    const transport = new HarnessTransport(scenario, launch);
    captures.push(transport);
    return transport;
  };
}

async function temporaryRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function launchFixture(t: TestContext, executable?: Awaited<ReturnType<typeof resolveOfficialCodexPayload>>) {
  const trustedExecutable = executable ?? await trustedIdentity();
  const appHome = await temporaryRoot(t, "orcode-codex-app-server-");
  const profile = await createCodexHome({
    appHome,
    homeId: parseCodexHomeId("codex-0123456789abcdef0123456789abcdef"),
    accountLabel: "Persoenlich",
  });
  return createCodexAppServerLaunchPlan(profile, trustedExecutable);
}

async function inMemoryClient(t: TestContext): Promise<{
  client: CodexAppServerClient;
  transport: InMemoryProtocolTransport;
}> {
  const launch = await launchFixture(t);
  const transport = new InMemoryProtocolTransport(launch.profile.codexHome);
  const client = new CodexAppServerClient(launch, async () => transport);
  await client.start();
  return { client, transport };
}

async function copiedOfficialWrapper(t: TestContext): Promise<{
  wrapper: string;
  packageJson: string;
  platformPackageJson: string;
  payload: string;
}> {
  const root = await temporaryRoot(t, "orcode-codex-wrapper-");
  const packageRoot = join(root, "node_modules", "@openai", "codex");
  const wrapper = join(packageRoot, "bin", "codex.js");
  const packageJson = join(packageRoot, "package.json");
  const platformRoot = join(packageRoot, "node_modules", "@openai", "codex-darwin-arm64");
  const platformPackageJson = join(platformRoot, "package.json");
  const payload = join(platformRoot, "vendor", "aarch64-apple-darwin", "bin", "codex");
  await mkdir(dirname(wrapper), { recursive: true, mode: 0o700 });
  await mkdir(dirname(payload), { recursive: true, mode: 0o700 });
  await copyFile(WRAPPER_REALPATH, wrapper);
  await copyFile(join(PACKAGE_ROOT, "package.json"), packageJson);
  await copyFile(join(PACKAGE_ROOT, "node_modules/@openai/codex-darwin-arm64/package.json"), platformPackageJson);
  await copyFile(PAYLOAD, payload);
  await chmod(wrapper, 0o755);
  await chmod(packageJson, 0o644);
  await chmod(platformPackageJson, 0o644);
  await chmod(payload, 0o755);
  return { wrapper, packageJson, platformPackageJson, payload };
}

test("rejects a temporary executable before the fake transport seam", async () => {
  assert.equal(fakeHarnessWasRejected, true);
  await assert.rejects(resolveOfficialCodexPayload(rejectedHarnessPath), /trusted signed Codex payload/i);
});

test("exposes one immutable backend runtime trust policy", () => {
  assert.deepEqual(CODEX_APP_SERVER_RUNTIME_POLICY, {
    cliVersion: "0.142.5",
    versionOutput: "codex-cli 0.142.5",
    teamIdentifier: "2DC432GLL2",
  });
  assert.equal(Object.isFrozen(CODEX_APP_SERVER_RUNTIME_POLICY), true);
});

test("pins the official npm wrapper, package metadata, and signed native payload", async () => {
  const identity = await resolveOfficialCodexPayload(WRAPPER);
  assert.equal(identity.selectedRealpath, WRAPPER_REALPATH);
  assert.equal(identity.payloadRealpath, PAYLOAD);
  assert.equal(identity.packageRootRealpath, PACKAGE_ROOT);
  assert.match(identity.wrapperSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(identity.packageMetadataSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(identity.platformPackageMetadataSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(identity.machO, true);
  assert.equal(identity.teamIdentifier, "2DC432GLL2");
  assert.equal(identity.version, "codex-cli 0.142.5");
});

test("accepts the signed native payload directly without inventing npm provenance", async () => {
  const identity = await resolveOfficialCodexPayload(PAYLOAD);
  assert.equal(identity.selectedRealpath, PAYLOAD);
  assert.equal(identity.payloadRealpath, PAYLOAD);
  assert.equal(identity.packageRootRealpath, null);
  assert.equal(identity.wrapperSha256, null);
  assert.equal(identity.packageMetadataSha256, null);
  assert.equal(identity.platformPackageMetadataSha256, null);
});

test("rejects wrapper package and platform-package version mismatches", async (t) => {
  const first = await copiedOfficialWrapper(t);
  const packageDocument = JSON.parse(await readFile(first.packageJson, "utf8")) as Record<string, unknown>;
  packageDocument.version = "0.142.4";
  await writeFile(first.packageJson, `${JSON.stringify(packageDocument)}\n`, { mode: 0o644 });
  await assert.rejects(resolveOfficialCodexPayload(first.wrapper), /package version|trusted signed Codex payload/i);

  const second = await copiedOfficialWrapper(t);
  const platformDocument = JSON.parse(await readFile(second.platformPackageJson, "utf8")) as Record<string, unknown>;
  platformDocument.version = "0.142.4-darwin-arm64";
  await writeFile(second.platformPackageJson, `${JSON.stringify(platformDocument)}\n`, { mode: 0o644 });
  await assert.rejects(resolveOfficialCodexPayload(second.wrapper), /platform package version|trusted signed Codex payload/i);
});

test("rejects non Mach-O and non-OpenAI signed direct candidates", async () => {
  await assert.rejects(resolveOfficialCodexPayload(rejectedHarnessPath), /Mach-O|trusted signed Codex payload/i);
  await assert.rejects(resolveOfficialCodexPayload("/bin/ls"), /TeamIdentifier|OpenAI|trusted signed Codex payload/i);
});

test("builds the exact argv and a two-key profile-local environment", async (t) => {
  const launch = await launchFixture(t);
  assert.deepEqual(CODEX_APP_SERVER_ARGV, ["app-server", "--stdio", "--disable", "plugins", "--disable", "apps"]);
  assert.deepEqual(launch.argv, CODEX_APP_SERVER_ARGV);
  assert.deepEqual(launch.env, {
    CODEX_HOME: launch.profile.codexHome,
    HOME: launch.profile.codexHome,
  });
  assert.deepEqual(Object.keys(launch.env).sort(), ["CODEX_HOME", "HOME"]);
  const environment: Readonly<Record<string, string>> = launch.env;
  for (const forbidden of ["PATH", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    assert.equal(environment[forbidden], undefined);
  }
});

test("revalidates wrapper provenance after resolution and before the fake spawn seam", async (t) => {
  const copied = await copiedOfficialWrapper(t);
  const identity = await resolveOfficialCodexPayload(copied.wrapper);
  const launch = await launchFixture(t, identity);
  await writeFile(copied.wrapper, "// replaced after trust decision\n", { mode: 0o755 });
  let factoryCalls = 0;
  const client = new CodexAppServerClient(launch, async (plan) => {
    factoryCalls += 1;
    return fakeTransport("supported") (plan);
  });
  await assert.rejects(client.start(), /changed|provenance|trusted signed Codex payload/i);
  assert.equal(factoryCalls, 0);
});

test("revalidates a safe-looking payload mode change before the fake spawn seam", async (t) => {
  const copied = await copiedOfficialWrapper(t);
  const identity = await resolveOfficialCodexPayload(copied.wrapper);
  const launch = await launchFixture(t, identity);
  await chmod(copied.payload, 0o700);
  let factoryCalls = 0;
  const client = new CodexAppServerClient(launch, async (plan) => {
    factoryCalls += 1;
    return fakeTransport("supported") (plan);
  });
  await assert.rejects(client.start(), /changed|provenance|trusted signed Codex payload/i);
  assert.equal(factoryCalls, 0);
});

test("revalidates the executable after the final profile scan before the transport factory", async (t) => {
  const copied = await copiedOfficialWrapper(t);
  const identity = await resolveOfficialCodexPayload(copied.wrapper);
  const launch = await launchFixture(t, identity);
  const codexHome = launch.profile.codexHome;
  let codexHomeReads = 0;
  let factoryCalls = 0;
  const racingLaunch: CodexAppServerLaunchPlan = {
    ...launch,
    profile: {
      binding: launch.profile.binding,
      get codexHome() {
        codexHomeReads += 1;
        if (codexHomeReads === 4) chmodSync(copied.payload, 0o700);
        return codexHome;
      },
    },
  };
  const client = new CodexAppServerClient(racingLaunch, async (plan) => {
    factoryCalls += 1;
    return fakeTransport("supported") (plan);
  });
  try {
    await assert.rejects(client.start(), /changed|provenance|trusted signed Codex payload/i);
    assert.equal(factoryCalls, 0);
  } finally {
    await client.drain().catch(() => undefined);
  }
});

test("rejects forged argv or inherited environment before any transport factory", async (t) => {
  const launch = await launchFixture(t);
  let factoryCalls = 0;
  const factory: CodexAppServerTransportFactory = async (plan) => {
    factoryCalls += 1;
    return fakeTransport("supported") (plan);
  };
  const forgedArgv: CodexAppServerLaunchPlan = {
    ...launch,
    argv: ["app-server", "--stdio", "--disable", "plugins", "--disable", "apps", "--listen", "ws://0.0.0.0:4500"] as never,
  };
  await assert.rejects(new CodexAppServerClient(forgedArgv, factory).start(), /launch plan|argv/i);
  const forgedEnvironment: CodexAppServerLaunchPlan = {
    ...launch,
    env: { ...launch.env, OPENAI_API_KEY: "inherited-canary" },
  };
  await assert.rejects(new CodexAppServerClient(forgedEnvironment, factory).start(), /launch plan|environment/i);
  assert.equal(factoryCalls, 0);
});

test("sends initialize then id-less initialized before ordinary requests", async (t) => {
  const launch = await launchFixture(t);
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(launch, fakeTransport("supported", captures));
  assert.equal(client.isReady, false);
  await client.start();
  assert.equal(client.isReady, true);
  assert.deepEqual(captures[0]?.frames.slice(0, 2), [
    {
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "orcode", title: "Orcode", version: "0.7.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    },
    { method: "initialized", params: {} },
  ]);
  assert.equal((captures[0]?.frames[1] as { id?: unknown }).id, undefined);
  assert.deepEqual(await client.request("account/read", { refreshToken: false }), {
    ok: true,
    method: "account/read",
  });
  client.notify("client/test", {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((captures[0]?.frames[2] as { method?: unknown }).method, "account/read");
  assert.deepEqual((captures[0]?.frames[3] as { method?: unknown }).method, "client/test");
  assert.equal(await client.drain(), "closed");
  assert.equal(client.isReady, false);
});

test("rejects requests before initialization and duplicate starts", async (t) => {
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("supported"));
  await assert.rejects(client.request("account/read", {}), /not initialized/i);
  await client.start();
  await assert.rejects(client.start(), /already initialized/i);
  await client.drain();
});

test("drain flushes an already accepted notification before closing", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("supported", captures));
  await client.start();
  client.notify("client/final", { settled: true });
  assert.equal(await client.drain(), "closed");
  assert.deepEqual(captures[0]?.frames.at(-1), {
    method: "client/final",
    params: { settled: true },
  });
});

for (const [scenario, expected] of [
  ["malformed-initialize", /malformed JSON-RPC/i],
  ["unknown-initialize", /unknown JSON-RPC/i],
  ["unsupported", /unsupported.*protocol|0\.142\.5/i],
  ["wrong-home", /CODEX_HOME|profile/i],
  ["extra-initialize-field", /unsupported.*protocol|unknown.*field/i],
  ["missing-initialized", /initialized notification/i],
] as const) {
  test(`fails closed and drains for ${scenario}`, async (t) => {
    const captures: HarnessTransport[] = [];
    const client = new CodexAppServerClient(await launchFixture(t), fakeTransport(scenario, captures));
    await assert.rejects(client.start(), expected);
    assert.equal(await client.drain(), "closed");
  });
}

test("returns valid JSON-RPC errors without mistaking them for protocol corruption", async (t) => {
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("initialize-error"));
  await assert.rejects(client.start(), /initialization refused/i);
  assert.equal(await client.drain(), "closed");
});

test("an abort bounds a silent initialize and drains the child", async (t) => {
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("silent-initialize"));
  await assert.rejects(client.start(AbortSignal.timeout(50)), /abort|timeout/i);
  assert.equal(await client.drain(), "closed");
});

for (const scenario of ["malformed-request", "unknown-request"] as const) {
  test(`closes and drains on ${scenario} after initialization`, async (t) => {
    const captures: HarnessTransport[] = [];
    const client = new CodexAppServerClient(await launchFixture(t), fakeTransport(scenario, captures));
    try {
      await client.start();
      await assert.rejects(client.request("account/read", {}), /malformed JSON-RPC|unknown JSON-RPC/i);
      await requireAutomaticDrain(captures[0]!);
      assert.equal(captures[0]?.drainCalls, 1);
      assert.equal(await client.drain(), "closed");
      assert.equal(captures[0]?.drainCalls, 1);
    } finally {
      await client.drain().catch(() => undefined);
    }
  });
}

test("automatically drains after a post-ready notification write failure", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("notify-write-error", captures));
  try {
    await client.start();
    client.notify("client/fail", {});
    await requireAutomaticDrain(captures[0]!);
    assert.equal(captures[0]?.drainCalls, 1);
    assert.equal(await client.drain(), "closed");
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    await client.drain().catch(() => undefined);
  }
});

test("automatically drains after a post-ready request abort", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("silent-request", captures));
  try {
    await client.start();
    const controller = new AbortController();
    const request = client.request("account/read", {}, controller.signal);
    controller.abort(new Error("injected request abort"));
    await assert.rejects(request, /injected request abort/i);
    await requireAutomaticDrain(captures[0]!);
    assert.equal(captures[0]?.drainCalls, 1);
    assert.equal(await client.drain(), "closed");
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    await client.drain().catch(() => undefined);
  }
});

test("starts bounded drain after abort even when the request write is stalled", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("stalled-request-write", captures));
  try {
    await client.start();
    const controller = new AbortController();
    const request = client.request("account/read", {}, controller.signal);
    const rejection = assert.rejects(request, /abort stalled request write/i);
    await captures[0]?.stalledWriteStarted;
    controller.abort(new Error("abort stalled request write"));
    await requireAutomaticDrain(captures[0]!);
    await rejection;
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    if (captures[0]?.drainCalls === 0) await captures[0].drain().catch(() => undefined);
    await client.drain().catch(() => undefined);
  }
});

test("a queued guarded turn writes zero bytes after authority drifts during backpressure", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(
    await launchFixture(t), fakeTransport("stalled-notification-write", captures));
  await client.start();
  client.notify("client/stall", {});
  await captures[0]!.stalledWriteStarted;
  let current = true;
  const turn = client.requestGuarded("turn/start", { input: "secret-task" }, () => {
    if (!current) throw new Error("stale authority at physical write");
  });
  current = false;
  captures[0]!.releaseStalledWrite();
  await assert.rejects(turn, /stale authority/i);
  assert.equal(captures[0]!.frames.some((frame) =>
    (frame as { method?: unknown }).method === "turn/start"), false);
  assert.match(await client.drain(), /closed|killed/);
});

test("bounds manual drain when an accepted request write remains stalled", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("stalled-request-write", captures));
  try {
    await client.start();
    const request = client.request("account/read", {});
    const rejection = assert.rejects(request, /closed/i);
    await captures[0]?.stalledWriteStarted;
    const draining = client.drain();
    await requireEventWithinShutdownBound(
      captures[0]!.drainStarted,
      "client.drain did not advance past the stalled write within the shutdown bound",
    );
    await requireEventWithinShutdownBound(
      Promise.all([draining, rejection]).then(() => undefined),
      "client.drain or its accepted request write remained pending after transport close",
    );
    assert.equal(await draining, "closed");
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    if (captures[0]?.drainCalls === 0) await captures[0].drain().catch(() => undefined);
    await client.drain().catch(() => undefined);
  }
});

test("transport close rejects its accepted backpressure write without a fake drain rescue", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("stalled-request-write", captures));
  try {
    await client.start();
    const request = assert.rejects(client.request("account/read", {}), /closed/i);
    await captures[0]!.stalledWriteStarted;
    captures[0]!.close();
    await requireEventWithinShutdownBound(
      request,
      "transport.close did not reject its accepted backpressure write",
    );
    await requireAutomaticDrain(captures[0]!);
  } finally {
    await client.drain().catch(() => undefined);
  }
});

test("aborts an open read pump before the final home-policy check", async (t) => {
  const captures: HarnessTransport[] = [];
  const launch = await launchFixture(t);
  const client = new CodexAppServerClient(launch, fakeTransport("open-read-after-drain", captures));
  const configPath = join(launch.profile.codexHome, "config.toml");
  let draining: Promise<void> | undefined;
  try {
    await client.start();
    await chmod(configPath, 0o644);
    draining = assert.rejects(client.drain(), /permissions|0600|owner-only/i);
    await requireEventWithinShutdownBound(
      captures[0]!.readAbortObserved,
      "client.drain did not abort the open read pump after transport shutdown",
    );
    await draining;
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    captures[0]?.releaseRead();
    await draining?.catch(() => undefined);
    await chmod(configPath, 0o600).catch(() => undefined);
    await client.drain().catch(() => undefined);
  }
});

test("bounds a transport that never reports exit after its kill window", async (t) => {
  const captures: HarnessTransport[] = [];
  const client = new CodexAppServerClient(await launchFixture(t), fakeTransport("stalled-transport-drain", captures));
  let rejection: Promise<void> | undefined;
  try {
    await client.start();
    rejection = assert.rejects(client.drain(), /shutdown bound|terminate|exit/i);
    await captures[0]?.drainStarted;
    await requireEventWithinProcessDrainBound(
      rejection,
      "client.drain remained unbounded after the transport kill window",
    );
    assert.equal(captures[0]?.drainCalls, 1);
  } finally {
    captures[0]?.releaseDrain();
    captures[0]?.releaseRead();
    await rejection?.catch(() => undefined);
    await client.drain().catch(() => undefined);
  }
});

test("delivers queued server requests before a concurrently claimed live request", async (t) => {
  const { client, transport } = await inMemoryClient(t);
  transport.emit({ id: 41, method: "item/fileChange/requestApproval", params: {} });
  transport.emit({ id: 42, method: "item/fileChange/requestApproval", params: {} });
  await transport.secondServerRequestClaimed;
  const seen: Array<string | number> = [];
  client.onServerRequest((request) => { seen.push(request.id); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [41, 42]);
  await client.drain();
});

test("supports typed string server request ids end to end", async (t) => {
  const { client, transport } = await inMemoryClient(t);
  let received!: (id: string | number) => void;
  const requestId = new Promise<string | number>((resolve) => { received = resolve; });
  client.onServerRequest((request) => { received(request.id); });
  transport.emit({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} });
  assert.equal(await requireValueWithin(requestId, 500, "string request id was not dispatched"), "approval-1");
  await client.respondToServerRequest("approval-1", { decision: "decline" });
  assert.deepEqual(transport.frames.at(-1), { id: "approval-1", result: { decision: "decline" } });
  await client.drain();
});

test("rejects a second response for one typed request id before transport write", async (t) => {
  const { client, transport } = await inMemoryClient(t);
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  client.onServerRequest(() => { received(); });
  transport.emit({ id: 77, method: "item/fileChange/requestApproval", params: {} });
  await requireEventWithin(requestReceived, 500, "server request was not dispatched");
  await client.respondToServerRequest(77, { decision: "decline" });
  const writesAfterFirstResponse = transport.frames.length;
  await assert.rejects(client.respondToServerRequest(77, { decision: "accept" }),
    /already|claimed|response|request id/i);
  assert.equal(transport.frames.length, writesAfterFirstResponse);
  await client.drain();
});

test("rejects an unknown or concurrent response id before a second transport frame", async (t) => {
  await t.test("unknown", async (subtest) => {
    const { client, transport } = await inMemoryClient(subtest);
    const writesBefore = transport.frames.length;
    await assert.rejects(client.respondToServerRequest("never-claimed", { decision: "decline" }),
      /unknown|responding|responded/i);
    assert.equal(transport.frames.length, writesBefore);
    await client.drain().catch(() => undefined);
  });

  await t.test("concurrent", async (subtest) => {
    const { client, transport } = await inMemoryClient(subtest);
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    client.onServerRequest(() => { received(); });
    transport.emit({ id: "concurrent-1", method: "item/fileChange/requestApproval", params: {} });
    await requireEventWithin(requestReceived, 500, "concurrent server request was not dispatched");
    const writesBefore = transport.frames.length;
    const first = client.respondToServerRequest("concurrent-1", { decision: "decline" });
    await assert.rejects(client.respondToServerRequest("concurrent-1", { decision: "accept" }),
      /unknown|responding|responded/i);
    await first.catch(() => undefined);
    const responseFrames = transport.frames.slice(writesBefore).filter((frame) =>
      (frame as { id?: unknown }).id === "concurrent-1");
    assert.ok(responseFrames.length <= 1, "a concurrent retry must never write a second response frame");
    await client.drain().catch(() => undefined);
  });
});

async function requireValueWithin<T>(value: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(detail)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
