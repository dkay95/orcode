import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { BrowserTimeoutError, pruneBrowserTempArtifacts } from "../src/browser.js";
import {
  inspectUrl,
  runWithHardTimeout,
  startManagedProcess,
  type FetchFn,
  type InspectUrlDeps,
  type ManagedProcess,
  type SpawnFn,
  type WebSocketLike,
} from "../src/browser-engine.js";

class FakeBrowserProcess extends EventEmitter {
  readonly pid = 987_654_321;
  readonly signals: NodeJS.Signals[] = [];
  exited = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit("exit", 0, signal));
    }
    return true;
  }
}

class FakeCdpSocket implements WebSocketLike {
  readonly #listeners = new Map<string, Array<(event: never) => void>>();

  constructor() {
    queueMicrotask(() => this.#emit("open", {}));
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: never) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string };
    let result: unknown = {};
    if (request.method === "Runtime.evaluate") {
      result = { result: { value: "Fixture page" } };
    } else if (request.method === "Page.captureScreenshot") {
      result = { data: Buffer.from("fixture-png").toString("base64") };
    }
    queueMicrotask(() => {
      this.#emit("message", { data: JSON.stringify({ id: request.id, result }) });
    });
    if (request.method === "Page.navigate") {
      setImmediate(() => {
        this.#emit("message", {
          data: JSON.stringify({ method: "Page.loadEventFired", params: {} }),
        });
      });
    }
  }

  close(): void {
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

function fakeSpawn(child: FakeBrowserProcess): SpawnFn {
  return (() => child as unknown as ChildProcess) as SpawnFn;
}

function browserFetch(options: {
  versionGate?: Promise<void>;
  versionStarted?: () => void;
  failNewTab?: boolean;
} = {}): FetchFn {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/json/version")) {
      options.versionStarted?.();
      await options.versionGate;
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/json/new")) {
      if (options.failNewTab) {
        return new Response("no tab", { status: 503 });
      }
      return new Response(
        JSON.stringify({ id: "tab-1", webSocketDebuggerUrl: "ws://fixture/tab-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/json/close/")) {
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected browser fetch: ${url}`);
  }) as FetchFn;
}

function fakeDeps(
  child: FakeBrowserProcess,
  options: {
    versionGate?: Promise<void>;
    versionStarted?: () => void;
    failNewTab?: boolean;
  } = {},
): InspectUrlDeps {
  return {
    spawnFn: fakeSpawn(child),
    fetchFn: browserFetch(options),
    wsFactory: () => new FakeCdpSocket(),
    findPort: async () => 41_237,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
}

async function withKeepAlive<T>(pending: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await pending;
  } finally {
    clearInterval(keepAlive);
  }
}

test("inspectUrl removes its profile and captured screenshot before successful return", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-success-"));
  const child = new FakeBrowserProcess();
  try {
    const report = await inspectUrl({
      url: "http://localhost:4173/",
      timeoutMs: 1_000,
      waitMs: 0,
      captureScreenshot: true,
      browserPath: process.execPath,
      tempDir: tempRoot,
      deps: fakeDeps(child),
    });

    assert.equal(report.title, "Fixture page");
    assert.equal(report.screenshotPath, null, "a deleted screenshot path must never escape");
    assert.deepEqual(await readdir(tempRoot), [], "the operation tree must be gone at settlement");
    assert.equal(child.exited, true, "the browser process must be reaped before success");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl removes its operation tree after port, spawn, and body failures", async (t) => {
  const cases: Array<{
    name: string;
    deps: (child: FakeBrowserProcess) => InspectUrlDeps;
    message: RegExp;
  }> = [
    {
      name: "port",
      deps: () => ({ findPort: async () => { throw new Error("fixture port failure"); } }),
      message: /fixture port failure/,
    },
    {
      name: "spawn",
      deps: () => ({
        findPort: async () => 41_238,
        spawnFn: (() => { throw new Error("fixture spawn failure"); }) as SpawnFn,
      }),
      message: /fixture spawn failure/,
    },
    {
      name: "body",
      deps: (child) => fakeDeps(child, { failNewTab: true }),
      message: /HTTP 503/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), `orcode-browser-${fixture.name}-`));
      const child = new FakeBrowserProcess();
      try {
        await assert.rejects(
          inspectUrl({
            url: "http://localhost:4173/",
            timeoutMs: 1_000,
            waitMs: 0,
            captureScreenshot: false,
            browserPath: process.execPath,
            tempDir: tempRoot,
            deps: fixture.deps(child),
          }),
          fixture.message,
        );
        assert.deepEqual(await readdir(tempRoot), []);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  }
});

test("inspectUrl aborts promptly and a late browser body cannot recreate artifacts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-abort-"));
  const child = new FakeBrowserProcess();
  const controller = new AbortController();
  let releaseVersion!: () => void;
  const versionGate = new Promise<void>((resolve) => { releaseVersion = resolve; });
  let markVersionStarted!: () => void;
  const versionStarted = new Promise<void>((resolve) => { markVersionStarted = resolve; });
  try {
    const startedAt = Date.now();
    const pending = inspectUrl({
      url: "http://localhost:4173/",
      timeoutMs: 2_000,
      waitMs: 0,
      captureScreenshot: true,
      browserPath: process.execPath,
      tempDir: tempRoot,
      signal: controller.signal,
      deps: fakeDeps(child, { versionGate, versionStarted: markVersionStarted }),
    });
    await versionStarted;
    controller.abort();

    const error = await withKeepAlive(pending.then(
      () => new Error("inspection unexpectedly succeeded"),
      (failure: unknown) => failure,
    ));
    const elapsedMs = Date.now() - startedAt;
    releaseVersion();
    await settle();

    assert.equal((error as Error).name, "AbortError");
    assert.ok(elapsedMs < 1_000, `abort settled only after ${elapsedMs}ms`);
    assert.equal(child.exited, true);
    assert.deepEqual(await readdir(tempRoot), [], "late CDP work recreated an artifact");
  } finally {
    releaseVersion();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl timeout stops the browser body without late artifact resurrection", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-timeout-"));
  const child = new FakeBrowserProcess();
  let releaseVersion!: () => void;
  const versionGate = new Promise<void>((resolve) => { releaseVersion = resolve; });
  try {
    const error = await withKeepAlive(inspectUrl({
      url: "http://localhost:4173/",
      timeoutMs: 25,
      waitMs: 0,
      captureScreenshot: true,
      browserPath: process.execPath,
      tempDir: tempRoot,
      deps: fakeDeps(child, { versionGate }),
    }).then(
      () => new Error("inspection unexpectedly succeeded"),
      (failure: unknown) => failure,
    ));
    releaseVersion();
    await settle();

    assert.ok(error instanceof BrowserTimeoutError);
    assert.equal(child.exited, true);
    assert.deepEqual(await readdir(tempRoot), [], "late timeout work recreated an artifact");
  } finally {
    releaseVersion();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl fails closed when its live operation tree cannot be removed", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-cleanup-failure-"));
  const child = new FakeBrowserProcess();
  const deps: InspectUrlDeps = {
    ...fakeDeps(child),
    removeTree: async () => { throw new Error("fixture cleanup denied"); },
  };
  try {
    await assert.rejects(
      inspectUrl({
        url: "http://localhost:4173/",
        timeoutMs: 1_000,
        waitMs: 0,
        captureScreenshot: false,
        browserPath: process.execPath,
        tempDir: tempRoot,
        deps,
      }),
      /fixture cleanup denied/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl validates the configured browser path before allocating or spawning", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-config-path-"));
  let spawned = false;
  try {
    await assert.rejects(
      inspectUrl({
        url: "http://localhost:4173/",
        timeoutMs: 1_000,
        waitMs: 0,
        captureScreenshot: false,
        browserPath: "/fixture/missing/browser",
        tempDir: tempRoot,
        deps: {
          fileExists: async () => false,
          findPort: async () => 41_239,
          spawnFn: (() => {
            spawned = true;
            throw new Error("spawn should not run");
          }) as SpawnFn,
        },
      }),
      /Configured browser path.*does not exist/,
    );
    assert.equal(spawned, false);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl with a pre-aborted root signal starts no browser-side effect", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-pre-abort-"));
  const controller = new AbortController();
  controller.abort();
  let fileChecks = 0;
  let portChecks = 0;
  let spawned = false;
  try {
    await assert.rejects(
      inspectUrl({
        url: "http://localhost:4173/",
        timeoutMs: 1_000,
        browserPath: process.execPath,
        signal: controller.signal,
        tempDir: tempRoot,
        deps: {
          fileExists: async () => {
            fileChecks += 1;
            return true;
          },
          findPort: async () => {
            portChecks += 1;
            return 41_240;
          },
          spawnFn: (() => {
            spawned = true;
            throw new Error("spawn should not run");
          }) as SpawnFn,
        },
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(fileChecks, 0);
    assert.equal(portChecks, 0);
    assert.equal(spawned, false);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("inspectUrl cancellation prevents an already queued browser search from starting", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-queued-abort-"));
  const controller = new AbortController();
  let fileChecks = 0;
  try {
    const pending = inspectUrl({
      url: "http://localhost:4173/",
      timeoutMs: 1_000,
      browserPath: process.execPath,
      signal: controller.signal,
      tempDir: tempRoot,
      deps: {
        fileExists: async () => {
          fileChecks += 1;
          return true;
        },
      },
    });
    controller.abort();

    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fileChecks, 0, "browser search started after the root cancellation won");
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("startManagedProcess owns a child error listener before checking its pid", () => {
  const child = new EventEmitter() as EventEmitter & { pid?: number; kill: () => boolean };
  child.pid = undefined;
  child.kill = () => true;
  const spawnFn = (() => child as unknown as ChildProcess) as SpawnFn;

  assert.throws(() => startManagedProcess("missing-browser", [], { spawnFn }), /could not be started/);
  assert.doesNotThrow(() => child.emit("error", new Error("spawn missing-browser ENOENT")));
});

test("runWithHardTimeout waits for the aborted browser body's own cleanup", async () => {
  const controller = new AbortController();
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  let bodyCleanupFinished = false;
  const proc: ManagedProcess = {
    pid: 123,
    kill() {},
    exited: Promise.resolve(),
  };
  const pending = runWithHardTimeout(
    proc,
    1_000,
    async (_deadline, signal) => {
      bodyStarted();
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        bodyCleanupFinished = true;
      }
      return "unreachable";
    },
    controller.signal,
  );
  await started;
  controller.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(bodyCleanupFinished, true, "outer cleanup settled before the browser body finished");
});

test("runWithHardTimeout does not start its body after cancellation already won", async () => {
  const controller = new AbortController();
  controller.abort();
  let bodyCalls = 0;
  const proc: ManagedProcess = {
    pid: 124,
    kill() {},
    exited: Promise.resolve(),
  };

  await assert.rejects(
    runWithHardTimeout(
      proc,
      1_000,
      async () => {
        bodyCalls += 1;
        return "unexpected";
      },
      controller.signal,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bodyCalls, 0);
});

test("runWithHardTimeout does not start its body after the timeout budget is exhausted", async () => {
  let bodyCalls = 0;
  const proc: ManagedProcess = {
    pid: 125,
    kill() {},
    exited: Promise.resolve(),
  };

  await assert.rejects(
    runWithHardTimeout(proc, 0, async () => {
      bodyCalls += 1;
      return "unexpected";
    }),
    (error: unknown) => error instanceof BrowserTimeoutError,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bodyCalls, 0);
});

async function age(path: string, milliseconds: number): Promise<void> {
  const at = new Date(milliseconds);
  await utimes(path, at, at);
}

test("startup browser cleanup removes only old exact owned artifact shapes", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink fixture needs elevated privileges on Windows");
    return;
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-prune-"));
  const outside = await mkdtemp(join(tmpdir(), "orcode-browser-prune-outside-"));
  const nowMs = Date.parse("2026-08-23T12:00:00.000Z");
  const oldMs = nowMs - 25 * 60 * 60 * 1_000;
  const freshMs = nowMs - 23 * 60 * 60 * 1_000;
  const boundaryMs = nowMs - 24 * 60 * 60 * 1_000;
  const oldOperation = join(tempRoot, "orcode-browser-operation-Ab12Z9");
  const oldProfile = join(tempRoot, "orcode-browser-profile-Xy12Qz");
  const oldScreenshot = join(
    tempRoot,
    "orcode-browser-screenshot-123e4567-e89b-12d3-a456-426614174000.png",
  );
  const freshOperation = join(tempRoot, "orcode-browser-operation-Fr35Hq");
  const boundaryProfile = join(tempRoot, "orcode-browser-profile-Bd12Ry");
  const foreign = join(tempRoot, "foreign-cache");
  const collision = join(tempRoot, "orcode-browser-operation-Ab12Z9-extra");
  const wrongType = join(tempRoot, "orcode-browser-operation-Fi12Le");
  const linkedArtifact = join(tempRoot, "orcode-browser-profile-Ln12Kq");
  const outsideMarker = join(outside, "must-stay.txt");
  try {
    for (const path of [oldOperation, oldProfile, freshOperation, boundaryProfile, foreign, collision]) {
      await mkdir(path);
      await writeFile(join(path, "marker.txt"), basename(path));
    }
    await writeFile(oldScreenshot, "png");
    await writeFile(wrongType, "not an owned profile directory");
    await writeFile(outsideMarker, "outside");
    await symlink(outside, linkedArtifact, "dir");
    for (const path of [oldOperation, oldProfile, oldScreenshot, foreign, collision, wrongType]) {
      await age(path, oldMs);
    }
    await age(freshOperation, freshMs);
    await age(boundaryProfile, boundaryMs);
    await lutimes(linkedArtifact, new Date(oldMs), new Date(oldMs));

    const report = await pruneBrowserTempArtifacts({ tempDir: tempRoot, nowMs });

    assert.deepEqual(
      report.removed.map((path) => basename(path)).sort(),
      [
        "orcode-browser-operation-Ab12Z9",
        "orcode-browser-profile-Xy12Qz",
        "orcode-browser-screenshot-123e4567-e89b-12d3-a456-426614174000.png",
      ],
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      (await readdir(tempRoot)).sort(),
      [
        "foreign-cache",
        "orcode-browser-operation-Ab12Z9-extra",
        "orcode-browser-operation-Fi12Le",
        "orcode-browser-operation-Fr35Hq",
        "orcode-browser-profile-Bd12Ry",
        "orcode-browser-profile-Ln12Kq",
      ].sort(),
    );
    assert.equal((await lstat(linkedArtifact)).isSymbolicLink(), true);
    assert.equal(await readFile(outsideMarker, "utf8"), "outside");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("browser cleanup only touches its own prefix and keeps a stable removal order", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-prune-bounded-"));
  const nowMs = Date.parse("2026-08-23T12:00:00.000Z");
  const oldMs = nowMs - 25 * 60 * 60 * 1_000;
  const artifacts = [
    "orcode-browser-profile-Zz99Yy",
    "orcode-browser-operation-Aa11Bb",
    "orcode-browser-profile-Mm55Nn",
  ];
  const inspected: string[] = [];
  try {
    // The shape of a real `os.tmpdir()`: mostly entries orcode does not own,
    // interleaved so directory order can never be the sorted order.
    for (let index = 0; index < 40; index += 1) {
      await mkdir(join(tempRoot, `unrelated-${39 - index}-cache`));
      await age(join(tempRoot, `unrelated-${39 - index}-cache`), oldMs);
      const artifact = artifacts[index % artifacts.length];
      if (index < artifacts.length) {
        await mkdir(join(tempRoot, artifact!));
        await age(join(tempRoot, artifact!), oldMs);
      }
    }

    const report = await pruneBrowserTempArtifacts({
      tempDir: tempRoot,
      nowMs,
      removeEntry: async (path) => {
        inspected.push(basename(path));
        await rm(path, { recursive: true, force: true });
      },
    });

    // Only the app's own prefix is ever a removal candidate …
    assert.deepEqual(inspected.sort(), [...artifacts].sort());
    // … and the report stays sorted no matter what order the FS enumerated.
    assert.deepEqual(report.removed, [...report.removed].sort());
    assert.deepEqual(report.removed.map((path) => basename(path)), [...artifacts].sort());
    assert.deepEqual(report.errors, []);
    assert.equal((await readdir(tempRoot)).length, 40);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("startup browser cleanup reports one removal error and continues with other old artifacts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "orcode-browser-prune-errors-"));
  const nowMs = Date.parse("2026-08-23T12:00:00.000Z");
  const first = join(tempRoot, "orcode-browser-profile-Er12Aa");
  const second = join(tempRoot, "orcode-browser-profile-Er12Bb");
  try {
    await mkdir(first);
    await mkdir(second);
    await age(first, nowMs - 25 * 60 * 60 * 1_000);
    await age(second, nowMs - 25 * 60 * 60 * 1_000);
    const report = await pruneBrowserTempArtifacts({
      tempDir: tempRoot,
      nowMs,
      removeEntry: async (path) => {
        if (path === first) throw new Error("fixture artifact busy");
        await rm(path, { recursive: true, force: true });
      },
    });

    assert.deepEqual(report.removed, [second]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.path, first);
    assert.match(report.errors[0]?.message ?? "", /fixture artifact busy/);
    assert.equal((await lstat(first)).isDirectory(), true);
    await assert.rejects(lstat(second), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
