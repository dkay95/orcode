import assert from "node:assert/strict";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

type ExclusiveDirectoryStore = {
  createDirectoryExclusive(path: string): Promise<object | null>;
  removeTree(path: string): Promise<void>;
};

type TokenBoundClaimStore = ExclusiveDirectoryStore & {
  ensureDirectory(path: string): Promise<void>;
  adoptDirectoryClaim(path: string): Promise<{ claim: object; modifiedAtMs: number }>;
  assertDirectoryClaim(claim: object): Promise<void>;
  writeClaimOwner(claim: object, content: string): Promise<void>;
  readClaimOwner(claim: object, maxBytes?: number): Promise<string>;
  releaseDirectoryClaim(claim: object, expectedOwner: string | null): Promise<void>;
  writeClaimManifest(
    claim: object,
    content: string,
    expectedContent: string | null,
  ): Promise<void>;
  readClaimManifest(claim: object, maxBytes?: number): Promise<string>;
  removeClaimManifest(claim: object, expectedContent: string): Promise<void>;
  writeClaimPayload(
    claim: object,
    name: ClaimPayloadName,
    content: string,
  ): Promise<void>;
  readClaimPayload(
    claim: object,
    name: ClaimPayloadName,
    maxBytes?: number,
  ): Promise<string>;
  removeClaimPayload(
    claim: object,
    name: ClaimPayloadName,
    expectedContent: string,
  ): Promise<void>;
};

type ClaimPayloadName =
  | "before-config.json"
  | "after-config.json"
  | "before-session.json"
  | "after-session.json";

const CLAIM_PAYLOAD_NAMES = [
  "before-config.json",
  "after-config.json",
  "before-session.json",
  "after-session.json",
] as const satisfies readonly ClaimPayloadName[];

const CLAIM_PAYLOAD_MAX_BYTES = 16 * 1_024 * 1_024;

test("PrivateStore exclusive directory creation returns one opaque claim token and null losers", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-exclusive-"));
  const lease = join(root, "hmac-init.lock");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as ExclusiveDirectoryStore;

  const outcomes = await Promise.all(
    Array.from({ length: 32 }, () => store.createDirectoryExclusive(lease)),
  );
  const winners = outcomes.filter((outcome) => outcome !== null);
  assert.equal(winners.length, 1);
  assert.equal(typeof winners[0], "object");
  assert.equal(Object.isFrozen(winners[0]), true);
  assert.equal(outcomes.filter((outcome) => outcome === null).length, 31);
  assert.equal((await stat(lease)).mode & 0o777, 0o700);
  await store.removeTree(lease);
  await assert.rejects(stat(lease), /ENOENT/);
});

test("PrivateStore claim owner lifecycle is token-bound and releases only exact owner.json plus an empty claim", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-owner-"));
  const lease = join(root, "provider-setup.lock");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  const claim = await store.createDirectoryExclusive(lease);
  assert.ok(claim);
  const owner = `${JSON.stringify({
    version: 1,
    ownerId: "40000000-0000-4000-8000-000000000001",
    acquiredAt: 100,
    expiresAt: 200,
  })}\n`;

  await store.writeClaimOwner(claim, owner);
  assert.equal(await store.readClaimOwner(claim), owner);
  await store.assertDirectoryClaim(claim);
  await store.releaseDirectoryClaim(claim, owner);
  await assert.rejects(stat(lease), /ENOENT/);
});

test("PrivateStore adopted claims preserve exact inode and owner readback for stale recovery", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-adopt-"));
  const lease = join(root, "provider-setup.lock");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  const created = await store.createDirectoryExclusive(lease);
  assert.ok(created);
  const owner = '{"version":1,"ownerId":"40000000-0000-4000-8000-000000000002","acquiredAt":100,"expiresAt":200}\n';
  await store.writeClaimOwner(created, owner);

  const adopted = await store.adoptDirectoryClaim(lease);
  assert.equal(Number.isFinite(adopted.modifiedAtMs), true);
  assert.equal(await store.readClaimOwner(adopted.claim), owner);
  await store.releaseDirectoryClaim(adopted.claim, owner);
  await assert.rejects(stat(lease), /ENOENT/);
});

test("PrivateStore claim release fails closed on owner mismatch or unexpected content", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-content-"));
  const lease = join(root, "provider-setup.lock");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  const claim = await store.createDirectoryExclusive(lease);
  assert.ok(claim);
  const owner = '{"version":1,"ownerId":"40000000-0000-4000-8000-000000000003","acquiredAt":100,"expiresAt":200}\n';
  await store.writeClaimOwner(claim, owner);
  await writeFile(join(lease, "foreign.txt"), "must survive");

  await assert.rejects(
    store.releaseDirectoryClaim(claim, owner.replace("200", "201")),
    /owner|claim|identity|Inhalt/i,
  );
  await assert.rejects(
    store.releaseDirectoryClaim(claim, owner),
    /empty|unerwartet|content|claim/i,
  );
  assert.equal(await readFile(join(lease, "foreign.txt"), "utf8"), "must survive");
  assert.equal(await readFile(join(lease, "owner.json"), "utf8"), owner);
});

test("PrivateStore transaction manifest lifecycle stays claim-scoped bounded and non-recursive", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-manifest-"));
  const transaction = join(root, "provider-activation", "70000000-0000-4000-8000-000000000001");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "provider-activation"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  const prepared = '{"version":1,"phase":"prepared"}\n';
  const committed = '{"version":1,"phase":"config-committed"}\n';

  await store.writeClaimManifest(claim, prepared, null);
  assert.equal(await store.readClaimManifest(claim, 64 * 1_024), prepared);
  await store.writeClaimManifest(claim, committed, prepared);
  assert.equal(await store.readClaimManifest(claim, 64 * 1_024), committed);
  await store.removeClaimManifest(claim, committed);
  assert.deepEqual(await readdir(transaction), []);
  await store.releaseDirectoryClaim(claim, null);
  await assert.rejects(stat(transaction), /ENOENT/);
});

test("PrivateStore fixed transaction payloads are write-once, exact, manifest-compatible, and cleanly removable", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-payloads-"));
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000101");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  const payloads: Readonly<Record<ClaimPayloadName, string>> = {
    "before-config.json": "{\"mainModel\":\"openai/old\"}\n",
    "after-config.json": "{\"mainModel\":\"openai/new\"}\n",
    "before-session.json": "{\"model\":\"openai/old\"}\n",
    "after-session.json": "{\"model\":\"openai/new\"}\n",
  };

  for (const name of CLAIM_PAYLOAD_NAMES) {
    await store.writeClaimPayload(claim, name, payloads[name]);
    assert.equal(await store.readClaimPayload(claim, name), payloads[name]);
    assert.equal((await stat(join(transaction, name))).mode & 0o777, 0o600);
  }
  await assert.rejects(
    store.writeClaimPayload(claim, "before-config.json", "replacement"),
    /exist|once|payload|claim/i,
  );
  assert.equal(
    await store.readClaimPayload(claim, "before-config.json"),
    payloads["before-config.json"],
  );

  const prepared = '{"version":1,"phase":"prepared"}\n';
  const committed = '{"version":1,"phase":"committed"}\n';
  await store.writeClaimManifest(claim, prepared, null);
  assert.equal(await store.readClaimManifest(claim), prepared);
  assert.equal(await store.readClaimPayload(claim, "after-session.json"), payloads["after-session.json"]);
  await store.writeClaimManifest(claim, committed, prepared);
  assert.equal(await store.readClaimManifest(claim), committed);
  await store.removeClaimManifest(claim, committed);
  assert.deepEqual(
    (await readdir(transaction)).sort(),
    [...CLAIM_PAYLOAD_NAMES].sort(),
  );

  await assert.rejects(
    store.removeClaimPayload(
      claim,
      "before-config.json",
      `${payloads["before-config.json"]}changed`,
    ),
    /exact|stimmt|payload/i,
  );
  assert.equal(
    await store.readClaimPayload(claim, "before-config.json"),
    payloads["before-config.json"],
  );

  for (const name of CLAIM_PAYLOAD_NAMES) {
    await store.removeClaimPayload(claim, name, payloads[name]);
  }
  assert.deepEqual(await readdir(transaction), []);
  await store.releaseDirectoryClaim(claim, null);
  await assert.rejects(stat(transaction), /ENOENT/);
});

test("PrivateStore payload names are a closed runtime allowlist and never traverse the claim", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const fixture = await mkdtemp(join(tmpdir(), "orcode-private-claim-payload-name-"));
  const root = join(fixture, "root");
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000102");
  const outside = join(fixture, "outside.json");
  await mkdir(root);
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);

  for (const invalid of ["../outside.json", "manifest.json", "/tmp/outside.json", "before-config.json/child"]) {
    await assert.rejects(
      store.writeClaimPayload(claim, invalid as ClaimPayloadName, "must not escape"),
      /allow|name|payload|claim/i,
    );
    await assert.rejects(
      store.readClaimPayload(claim, invalid as ClaimPayloadName),
      /allow|name|payload|claim/i,
    );
    await assert.rejects(
      store.removeClaimPayload(claim, invalid as ClaimPayloadName, "must not escape"),
      /allow|name|payload|claim/i,
    );
  }

  await assert.rejects(readFile(outside), /ENOENT/);
  assert.deepEqual(await readdir(transaction), []);
});

test("PrivateStore payload-name export is runtime-frozen and cannot weaken the private complete-set authority", async () => {
  const {
    PosixPrivateStoreAdapter,
    PRIVATE_STORE_CLAIM_PAYLOAD_NAMES,
    PrivateStore,
  } = await import("../src/private-store.js");
  assert.equal(Object.isFrozen(PRIVATE_STORE_CLAIM_PAYLOAD_NAMES), true);
  assert.throws(
    () => (PRIVATE_STORE_CLAIM_PAYLOAD_NAMES as unknown as string[]).pop(),
    TypeError,
  );

  const root = await mkdtemp(join(tmpdir(), "orcode-private-payload-authority-"));
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000109");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  for (const name of CLAIM_PAYLOAD_NAMES.slice(0, -1)) {
    await store.writeClaimPayload(claim, name, `{"name":${JSON.stringify(name)}}\n`);
  }

  await assert.rejects(
    store.writeClaimManifest(claim, '{"version":1,"phase":"prepared"}\n', null),
    /complete|payload|manifest|unvollständig/i,
  );
  assert.deepEqual(
    (await readdir(transaction)).sort(),
    CLAIM_PAYLOAD_NAMES.slice(0, -1).sort(),
  );
});

test("PrivateStore payload reads and removal compare canonical UTF-8 raw bytes", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-payload-utf8-"));
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000110");
  const payloadPath = join(transaction, "before-config.json");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  const expected = '{"value":"\uFFFD"}\n';
  await store.writeClaimPayload(claim, "before-config.json", expected);
  const tampered = Buffer.concat([
    Buffer.from('{"value":"', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}\n', "utf8"),
  ]);
  await writeFile(payloadPath, tampered);

  await assert.rejects(
    store.readClaimPayload(claim, "before-config.json"),
    /canonical|utf-?8|kanonisch|payload/i,
  );
  await assert.rejects(
    store.removeClaimPayload(claim, "before-config.json", expected),
    /exact|stimmt|changed|payload|utf-?8|kanonisch/i,
  );
  assert.deepEqual(await readFile(payloadPath), tampered);
});

test("PrivateStore payloads reject symlinks, oversize bytes, and unexpected claim entries without cleanup outside authority", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const fixture = await mkdtemp(join(tmpdir(), "orcode-private-claim-payload-bounds-"));
  const root = join(fixture, "root");
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000103");
  const outside = join(fixture, "outside.json");
  await mkdir(root);
  await writeFile(outside, "outside survives");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  const beforeConfigPath = join(transaction, "before-config.json");
  await symlink(outside, beforeConfigPath);

  await assert.rejects(
    store.readClaimPayload(claim, "before-config.json"),
    /link|regular|payload|claim/i,
  );
  await assert.rejects(
    store.writeClaimPayload(claim, "before-config.json", "replacement"),
    /link|regular|payload|claim|exist/i,
  );
  assert.equal(await readFile(outside, "utf8"), "outside survives");
  await unlink(beforeConfigPath);

  const oversized = "x".repeat(CLAIM_PAYLOAD_MAX_BYTES + 1);
  await assert.rejects(
    store.writeClaimPayload(claim, "before-config.json", oversized),
    /large|size|groß|payload/i,
  );
  await assert.rejects(stat(beforeConfigPath), /ENOENT/);
  await writeFile(beforeConfigPath, "x");
  await truncate(beforeConfigPath, CLAIM_PAYLOAD_MAX_BYTES + 1);
  await assert.rejects(
    store.readClaimPayload(claim, "before-config.json"),
    /large|size|groß|payload/i,
  );
  assert.equal((await stat(beforeConfigPath)).size, CLAIM_PAYLOAD_MAX_BYTES + 1);

  await unlink(beforeConfigPath);
  await store.writeClaimPayload(claim, "before-config.json", "small payload");
  await writeFile(join(transaction, "foreign.txt"), "foreign survives");
  await assert.rejects(
    store.readClaimPayload(claim, "before-config.json"),
    /entry|content|claim|unerwartet/i,
  );
  assert.equal(await readFile(join(transaction, "foreign.txt"), "utf8"), "foreign survives");
});

test("PrivateStore manifest coexistence requires the complete fixed regular payload set", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-manifest-payload-set-"));
  const transaction = join(root, "model-preference", "70000000-0000-4000-8000-000000000104");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "model-preference"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  for (const name of CLAIM_PAYLOAD_NAMES) {
    await store.writeClaimPayload(claim, name, `{\"name\":${JSON.stringify(name)}}\n`);
  }
  const manifest = '{"version":1,"phase":"prepared"}\n';
  await store.writeClaimManifest(claim, manifest, null);

  await unlink(join(transaction, "after-session.json"));
  await assert.rejects(
    store.readClaimManifest(claim),
    /complete|payload|manifest|content|entry|unerwartet/i,
  );
  await writeFile(join(transaction, "after-session.json"), "restored");
  await unlink(join(transaction, "before-session.json"));
  await mkdir(join(transaction, "before-session.json"));
  await assert.rejects(
    store.readClaimManifest(claim),
    /regular|payload|manifest|content|entry|unerwartet/i,
  );
  await rmdir(join(transaction, "before-session.json"));
  await writeFile(join(transaction, "before-session.json"), "restored");
  await writeFile(join(transaction, "foreign.txt"), "foreign survives");
  await assert.rejects(
    store.removeClaimManifest(claim, manifest),
    /content|entry|unexpected/i,
  );
  assert.equal(await readFile(join(transaction, "manifest.json"), "utf8"), manifest);
  assert.equal(await readFile(join(transaction, "foreign.txt"), "utf8"), "foreign survives");
});

test("PrivateStore bounded manifest read rejects oversized or multiple entries and retains all artifacts", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-claim-manifest-bounds-"));
  const transaction = join(root, "provider-activation", "70000000-0000-4000-8000-000000000002");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "provider-activation"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  const oversized = "x".repeat(64 * 1_024 + 1);
  await writeFile(join(transaction, "manifest.json"), oversized);

  await assert.rejects(store.readClaimManifest(claim, 64 * 1_024), /large|size|groß|manifest/i);
  assert.equal((await stat(join(transaction, "manifest.json"))).size, oversized.length);

  await writeFile(join(transaction, "foreign.txt"), "foreign survives");
  await assert.rejects(store.readClaimManifest(claim, 64 * 1_024), /entry|content|manifest|unexpected/i);
  assert.equal(await readFile(join(transaction, "foreign.txt"), "utf8"), "foreign survives");
});

test("PrivateStore exclusive directory creation rejects symlinked ancestors without touching outside", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const fixture = await mkdtemp(join(tmpdir(), "orcode-private-exclusive-symlink-"));
  const root = join(fixture, "home");
  const outside = join(fixture, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, "locks"), "dir");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as ExclusiveDirectoryStore;

  await assert.rejects(
    store.createDirectoryExclusive(join(root, "locks", "hmac-init.lock")),
    /symbol|symlink|link/i,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("PrivateStore leaves an empty exclusive claim on protection failure instead of path rollback", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-exclusive-protect-failure-"));
  const claimPath = join(root, "hmac-init.lock");
  const store = new PrivateStore({
    root,
    adapter: {
      name: "claim-protection-failure",
      available: async () => true,
      protectDirectory: async (path) => {
        if (path === claimPath) throw new Error("synthetic claim protection failure");
      },
      protectFile: async () => undefined,
    },
  }) as unknown as ExclusiveDirectoryStore;

  await assert.rejects(
    store.createDirectoryExclusive(claimPath),
    /protection failure/,
  );
  assert.equal((await stat(claimPath)).isDirectory(), true);
  assert.deepEqual(await readdir(claimPath), []);
});

test("PrivateStore exclusive root protection failure leaves the empty created root without rollback", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const fixture = await mkdtemp(join(tmpdir(), "orcode-private-exclusive-root-protect-"));
  const root = join(fixture, "canonical-root");
  const claimPath = join(root, "hmac-init.lock");
  const store = new PrivateStore({
    root,
    adapter: {
      name: "root-protection-failure",
      available: async () => true,
      protectDirectory: async (path) => {
        if (path === root) throw new Error("synthetic root protection failure");
      },
      protectFile: async () => undefined,
    },
  }) as unknown as ExclusiveDirectoryStore;

  await assert.rejects(
    store.createDirectoryExclusive(claimPath),
    /root protection failure/,
  );
  assert.equal((await stat(root)).isDirectory(), true);
  assert.deepEqual(await readdir(root), []);
});

test("PrivateStore enforces 0700 directories and 0600 atomic files on POSIX", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-posix-"));
  const directory = join(root, "exact", "chat-a");
  const path = join(directory, "state.json");
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root });

  await store.writeTextAtomic(path, "exact recovery state\n");

  assert.equal(await readFile(path, "utf8"), "exact recovery state\n");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("Windows PrivateStore binds every DACL operation to the expected file identity", async () => {
  const { PrivateStore, WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-windows-"));
  const calls: Array<{ executable: string; args: string[]; environment?: Record<string, string> }> = [];
  const adapter = new WindowsPrivateStoreAdapter(async (executable, args, options?: {
    environment?: Record<string, string>;
  }) => {
    calls.push({ executable, args: [...args], environment: options?.environment });
    return { code: 0, stdout: "", stderr: "" };
  });
  const store = new PrivateStore({ adapter, root });
  const path = join(root, "exact", "state.json");

  await store.writeTextAtomic(path, "opaque\n");

  assert.equal(calls.length, 5, "disposable directory/file probes plus root, directory, and file DACLs");
  for (const call of calls) {
    assert.equal(call.executable, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(call.args[3] ?? "", "base64").toString("utf16le");
    assert.match(script, /WindowsIdentity.*GetCurrent/);
    assert.match(script, /S-1-5-18/);
    assert.match(script, /CreateFileW/);
    assert.match(script, /FileFlagOpenReparsePoint/);
    assert.match(script, /GetFileInformationByHandle/);
    assert.match(script, /SetSecurityInfo\(\s*handle,/);
    assert.match(script, /GetSecurityInfo\(\s*handle,/);
    assert.doesNotMatch(script, /(?:Set|Get)-Acl/);
    assert.match(call.environment?.ORCODE_PRIVATE_EXPECTED_DEV ?? "", /^\d+$/);
    assert.match(call.environment?.ORCODE_PRIVATE_EXPECTED_INO ?? "", /^\d+$/);
  }
  assert.deepEqual(
    calls.map((call) => call.environment?.ORCODE_PRIVATE_KIND),
    ["directory", "file", "directory", "directory", "file"],
  );
});

test("Windows ACL invocation binds an untrusted path as data through an encoded parser boundary", async () => {
  const { WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-windows-injection-"));
  const maliciousPath = join(root, String.raw`C:\exact\'; Write-Output INJECTED; #\state.json`);
  await writeFile(maliciousPath, "");
  const captures: Array<{
    args: string[];
    environment?: Record<string, string>;
  }> = [];
  const adapter = new WindowsPrivateStoreAdapter(async (_executable, args, options?: {
    environment?: Record<string, string>;
  }) => {
    captures.push({ args: [...args], environment: options?.environment });
    return { code: 0, stdout: "", stderr: "" };
  });

  await adapter.protectFile(maliciousPath);

  const captured = captures[0]!;
  assert.equal(captured.args[2], "-EncodedCommand");
  const encoded = captured.args[3] ?? "";
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /ORCODE_PRIVATE_PATH/);
  assert.doesNotMatch(script, /INJECTED/);
  assert.equal(captured.environment?.ORCODE_PRIVATE_PATH, maliciousPath);
  assert.equal(captured.environment?.ORCODE_PRIVATE_KIND, "file");
  assert.equal(captured.args.includes(maliciousPath), false);
});

test("Windows availability proves disposable directory and file DACL enforceability", async () => {
  const { WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const adapter = new WindowsPrivateStoreAdapter(async (_executable, _args, options) => ({
    code: options?.environment?.ORCODE_PRIVATE_KIND === "file" ? 17 : 0,
    stdout: "",
    stderr: "synthetic file DACL refusal",
  }));

  assert.equal(await adapter.available(), false);
});

test("Windows PrivateStore child refuses a swapped file ID before changing the outside DACL", async () => {
  const { PrivateStore, WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-windows-child-swap-"));
  const exact = join(root, "exact");
  const moved = join(root, "exact-before-swap");
  const outside = join(root, "outside");
  await mkdir(exact, { mode: 0o755 });
  await mkdir(outside, { mode: 0o755 });
  await chmod(exact, 0o755);
  await chmod(outside, 0o755);
  let swapped = false;
  const adapter = new WindowsPrivateStoreAdapter(async (_executable, _args, options) => {
    const path = options?.environment?.ORCODE_PRIVATE_PATH;
    if (!swapped && path === exact) {
      swapped = true;
      await rename(exact, moved);
      await symlink(outside, exact, "dir");
      const expectedDev = options?.environment?.ORCODE_PRIVATE_EXPECTED_DEV;
      const expectedIno = options?.environment?.ORCODE_PRIVATE_EXPECTED_INO;
      if (expectedDev !== undefined && expectedIno !== undefined) {
        const current = await lstat(exact, { bigint: true });
        if (current.isSymbolicLink()
          || current.dev !== BigInt(expectedDev)
          || current.ino !== BigInt(expectedIno)) {
          return { code: 18, stdout: "", stderr: "synthetic handle identity refusal" };
        }
      }
      await chmod(exact, 0o700);
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const store = new PrivateStore({ adapter, root } as never);
  let rejected = false;

  try {
    await store.ensureDirectory(exact);
  } catch {
    rejected = true;
  }

  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.equal(rejected, true);
});

test("PrivateStore rolls back a newly-created destination root when protection fails", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const parent = await mkdtemp(join(tmpdir(), "orcode-private-rollback-"));
  const root = join(parent, "new-home");
  const target = join(root, "exact", "state.json");
  const store = new PrivateStore({
    root,
    adapter: {
      name: "later-protection-failure",
      available: async () => true,
      protectDirectory: async () => {
        throw new Error("synthetic protection failure");
      },
      protectFile: async () => undefined,
    },
  });

  await assert.rejects(store.writeTextAtomic(target, "must remain absent"), /protection failure/);
  await assert.rejects(stat(root), /ENOENT/);
  await assert.rejects(readFile(target), /ENOENT/);
});

test("Windows PrivateStore real DACL integration", { skip: process.platform !== "win32" }, async () => {
  const { PrivateStore, WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-windows-real-"));
  const path = join(root, "exact", "state.json");
  const store = new PrivateStore({ adapter: new WindowsPrivateStoreAdapter(), root } as never);

  await store.writeTextAtomic(path, "opaque\n");

  assert.equal(await readFile(path, "utf8"), "opaque\n");
});

test("PrivateStore rejects a symlink root and symlinked ancestors before exact content escapes", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-symlink-"));
  const outside = join(root, "outside");
  const home = join(root, "home");
  await mkdir(outside);
  await mkdir(home);
  await symlink(outside, join(home, "exact"), "dir");
  const ancestorStore = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root: home } as never);

  await assert.rejects(
    ancestorStore.writeTextAtomic(join(home, "exact", "state.json"), "must not escape"),
    /symbol|symlink|link/i,
  );
  await assert.rejects(readFile(join(outside, "state.json")), /ENOENT/);

  const linkedHome = join(root, "linked-home");
  await symlink(outside, linkedHome, "dir");
  const rootStore = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root: linkedHome } as never);
  await assert.rejects(
    rootStore.writeTextAtomic(join(linkedHome, "root-state.json"), "must not escape root"),
    /symbol|symlink|link/i,
  );
  await assert.rejects(readFile(join(outside, "root-state.json")), /ENOENT/);
});

test("PrivateStore rechecks ancestors after temp protection and before writing exact content", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-swap-"));
  const home = join(root, "home");
  const exact = join(home, "exact");
  const moved = join(home, "exact-before-swap");
  const outside = join(root, "outside");
  await mkdir(exact, { recursive: true });
  await mkdir(outside);
  let swapped = false;
  class SwappingAdapter extends PosixPrivateStoreAdapter {
    override async protectFile(path: string): Promise<void> {
      await super.protectFile(path);
      if (!swapped && path.endsWith(".private.tmp")) {
        swapped = true;
        await rename(dirname(path), moved);
        await symlink(outside, exact, "dir");
      }
    }
  }
  const store = new PrivateStore({ adapter: new SwappingAdapter(), root: home } as never);
  const secret = "exact bytes must never reach swapped storage";

  await assert.rejects(store.writeTextAtomic(join(exact, "state.json"), secret));

  const leaked = await Promise.all((await readdir(moved)).map(async (name) =>
    readFile(join(moved, name), "utf8").catch(() => "")));
  assert.equal(leaked.some((value) => value.includes(secret)), false);
  await assert.rejects(readFile(join(outside, "state.json")), /ENOENT/);
});

test("PrivateStore temp cleanup never unlinks a replacement name after ancestor mismatch", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-temp-cleanup-swap-"));
  const home = join(root, "home");
  const exact = join(home, "exact");
  const moved = join(home, "exact-before-swap");
  const outside = join(root, "outside");
  await mkdir(exact, { recursive: true });
  await mkdir(outside);
  let outsideTemp: string | null = null;
  class SwappingCleanupAdapter extends PosixPrivateStoreAdapter {
    override async protectFile(path: string, handle?: FileHandle): Promise<void> {
      await super.protectFile(path, handle);
      if (!outsideTemp && path.endsWith(".private.tmp")) {
        outsideTemp = join(outside, basename(path));
        await writeFile(outsideTemp, "outside sentinel", { mode: 0o644 });
        await rename(dirname(path), moved);
        await symlink(outside, exact, "dir");
      }
    }
  }
  const store = new PrivateStore({ adapter: new SwappingCleanupAdapter(), root: home } as never);

  await assert.rejects(store.writeTextAtomic(join(exact, "state.json"), "exact bytes"));

  assert.notEqual(outsideTemp, null);
  assert.equal(await readFile(outsideTemp!, "utf8"), "outside sentinel");
});

test("PrivateStore protectTree rejects a symlink root without changing its target", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-tree-link-"));
  const outside = join(root, "outside");
  const link = join(root, "backup-link");
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await symlink(outside, link, "dir");
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);

  await assert.rejects(store.protectTree(link), /symbol|symlink|link/i);

  assert.equal((await stat(outside)).mode & 0o777, 0o755);
});

test("PrivateStore ensureDirectory binds protection to the verified directory identity", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-directory-handle-"));
  const exact = join(root, "exact");
  const moved = join(root, "exact-before-swap");
  const outside = join(root, "outside");
  const victim = join(outside, "victim.txt");
  await mkdir(exact);
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await writeFile(victim, "outside content", { mode: 0o644 });
  await chmod(victim, 0o644);
  let swapped = false;
  class SwappingDirectoryAdapter extends PosixPrivateStoreAdapter {
    override async protectDirectory(path: string, handle?: FileHandle): Promise<void> {
      if (!swapped && path === exact) {
        swapped = true;
        await rename(exact, moved);
        await symlink(outside, exact, "dir");
      }
      const protect = super.protectDirectory as unknown as (
        path: string,
        handle?: FileHandle,
      ) => Promise<void>;
      await protect(path, handle);
    }
  }
  const store = new PrivateStore({ adapter: new SwappingDirectoryAdapter(), root } as never);
  let rejected = false;

  try {
    await store.ensureDirectory(exact);
  } catch {
    rejected = true;
  }

  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
  assert.equal(await readFile(victim, "utf8"), "outside content");
  assert.equal(rejected, true);
});

test("PrivateStore protectTree binds protection and traversal to the verified tree identity", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-tree-handle-"));
  const tree = join(root, "backup");
  const moved = join(root, "backup-before-swap");
  const outside = join(root, "outside");
  const victim = join(outside, "victim.txt");
  await mkdir(tree);
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await writeFile(victim, "outside content", { mode: 0o644 });
  await chmod(victim, 0o644);
  let swapped = false;
  class SwappingTreeAdapter extends PosixPrivateStoreAdapter {
    override async protectDirectory(path: string, handle?: FileHandle): Promise<void> {
      if (!swapped && path === tree) {
        swapped = true;
        await rename(tree, moved);
        await symlink(outside, tree, "dir");
      }
      const protect = super.protectDirectory as unknown as (
        path: string,
        handle?: FileHandle,
      ) => Promise<void>;
      await protect(path, handle);
    }
  }
  const store = new PrivateStore({ adapter: new SwappingTreeAdapter(), root } as never);
  let rejected = false;

  try {
    await store.protectTree(tree);
  } catch {
    rejected = true;
  }

  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
  assert.equal(await readFile(victim, "utf8"), "outside content");
  assert.equal(rejected, true);
});

test("PrivateStore fails closed and never publishes an exact file when its adapter cannot enforce privacy", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-closed-"));
  const path = join(root, "exact", "state.json");
  const store = new PrivateStore({
    root,
    adapter: {
      name: "unavailable-test-boundary",
      available: async () => false,
      protectDirectory: async () => {
        throw new Error("must not protect after failed availability");
      },
      protectFile: async () => {
        throw new Error("must not protect after failed availability");
      },
    },
  });

  await assert.rejects(store.writeTextAtomic(path, "must stay absent"), /nicht verfügbar|unavailable/i);
  await assert.rejects(readFile(path), /ENOENT/);
});
