import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const nativeOpen = fs.promises.open.bind(fs.promises);
const nativeLstat = fs.promises.lstat.bind(fs.promises);
const nativeRmdir = fs.promises.rmdir.bind(fs.promises);
let pendingOpenSwap: { path: string; run: () => Promise<void> } | null = null;
let pendingLstatSwap: { path: string; run: () => Promise<void> } | null = null;
let pendingRmdirSwap: { path: string; run: () => Promise<void> } | null = null;
let deferredLstatSwap: {
  triggerPath: string | null;
  path: string;
  remaining: number;
  run: () => Promise<void>;
} | null = null;
let swappedOpenHandle: Awaited<ReturnType<typeof nativeOpen>> | null = null;
const wrappedOpen = (async (...args: unknown[]) => {
  const path = resolve(String(args[0]));
  let swapped = false;
  if (pendingOpenSwap?.path === path) {
    const swap = pendingOpenSwap.run;
    pendingOpenSwap = null;
    await swap();
    swapped = true;
  }
  const handle = await (nativeOpen as unknown as (
    ...callArgs: unknown[]
  ) => ReturnType<typeof nativeOpen>)(...args);
  if (swapped) swappedOpenHandle = handle;
  return handle;
}) as typeof nativeOpen;
Object.defineProperty(fs.promises, "open", {
  configurable: true,
  writable: true,
  value: wrappedOpen,
});
const wrappedLstat = (async (...args: unknown[]) => {
  const path = resolve(String(args[0]));
  if (pendingLstatSwap?.path === path) {
    const swap = pendingLstatSwap.run;
    pendingLstatSwap = null;
    await swap();
  }
  const result = await (nativeLstat as unknown as (
    ...callArgs: unknown[]
  ) => ReturnType<typeof nativeLstat>)(...args);
  const deferred = deferredLstatSwap;
  if (deferred?.triggerPath === path) {
    deferred.triggerPath = null;
  } else if (deferred?.triggerPath === null && deferred.path === path) {
    deferred.remaining -= 1;
    if (deferred.remaining === 0) {
      deferredLstatSwap = null;
      await deferred.run();
    }
  }
  return result;
}) as typeof nativeLstat;
Object.defineProperty(fs.promises, "lstat", {
  configurable: true,
  writable: true,
  value: wrappedLstat,
});
const wrappedRmdir = (async (...args: unknown[]) => {
  const path = resolve(String(args[0]));
  if (pendingRmdirSwap?.path === path) {
    const swap = pendingRmdirSwap.run;
    pendingRmdirSwap = null;
    await swap();
  }
  return (nativeRmdir as unknown as (
    ...callArgs: unknown[]
  ) => ReturnType<typeof nativeRmdir>)(...args);
}) as typeof nativeRmdir;
Object.defineProperty(fs.promises, "rmdir", {
  configurable: true,
  writable: true,
  value: wrappedRmdir,
});
syncBuiltinESMExports();

const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");

type TokenBoundClaimStore = InstanceType<typeof PrivateStore> & {
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
};

after(() => {
  Object.defineProperty(fs.promises, "open", {
    configurable: true,
    writable: true,
    value: nativeOpen,
  });
  Object.defineProperty(fs.promises, "lstat", {
    configurable: true,
    writable: true,
    value: nativeLstat,
  });
  Object.defineProperty(fs.promises, "rmdir", {
    configurable: true,
    writable: true,
    value: nativeRmdir,
  });
  syncBuiltinESMExports();
});

function swapAtNextOpen(path: string, run: () => Promise<void>): void {
  assert.equal(pendingOpenSwap, null);
  swappedOpenHandle = null;
  pendingOpenSwap = { path: resolve(path), run };
}

function swapAtNextLstat(path: string, run: () => Promise<void>): void {
  assert.equal(pendingLstatSwap, null);
  pendingLstatSwap = { path: resolve(path), run };
}

function swapAtNextRmdir(path: string, run: () => Promise<void>): void {
  assert.equal(pendingRmdirSwap, null);
  pendingRmdirSwap = { path: resolve(path), run };
}

function swapAtNthLstat(path: string, occurrence: number, run: () => Promise<void>): void {
  assert.equal(deferredLstatSwap, null);
  assert.ok(occurrence > 0);
  deferredLstatSwap = {
    triggerPath: null,
    path: resolve(path),
    remaining: occurrence,
    run,
  };
}

function swapAfterLstat(
  triggerPath: string,
  path: string,
  occurrence: number,
  run: () => Promise<void>,
): void {
  assert.equal(deferredLstatSwap, null);
  assert.ok(occurrence > 0);
  deferredLstatSwap = {
    triggerPath: resolve(triggerPath),
    path: resolve(path),
    remaining: occurrence,
    run,
  };
}

test("PrivateStore retries once when an existing holder disappears before its exact lstat", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-released-claim-"));
  const lease = join(root, "provider-setup.lock");
  await fs.promises.mkdir(lease, { mode: 0o700 });
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore & {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };

  swapAtNextLstat(lease, async () => {
    await fs.promises.rmdir(lease);
  });
  try {
    const claim = await store.createDirectoryExclusive(lease);
    assert.ok(claim, "the released holder must be reacquired as a fresh opaque claim");
    assert.equal(pendingLstatSwap, null, "the exact post-EEXIST hook must run once");
    await store.assertDirectoryClaim(claim);
    await store.releaseDirectoryClaim(claim, null);
    await assert.rejects(fs.promises.lstat(lease), /ENOENT/);
  } finally {
    pendingLstatSwap = null;
  }
});

test("PrivateStore never retries through a regular-file replacement at the post-EEXIST boundary", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-file-claim-"));
  const lease = join(root, "provider-setup.lock");
  const sentinel = "foreign sentinel must remain unchanged";
  await fs.promises.mkdir(lease, { mode: 0o700 });
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore & {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };

  swapAtNextLstat(lease, async () => {
    await fs.promises.rmdir(lease);
    await fs.promises.writeFile(lease, sentinel, { mode: 0o600 });
  });
  try {
    await assert.rejects(
      store.createDirectoryExclusive(lease),
      /not a real directory/,
    );
    assert.equal(pendingLstatSwap, null, "the exact post-EEXIST hook must run once");
    assert.equal(await fs.promises.readFile(lease, "utf8"), sentinel);
    assert.equal((await fs.promises.lstat(lease)).isFile(), true);
  } finally {
    pendingLstatSwap = null;
  }
});

test("PrivateStore exclusive creation refuses a swapped replacement before protection or rollback", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-exclusive-swap-"));
  const lease = join(root, "hmac-init.lock");
  const original = join(root, "hmac-init-before-swap");
  const outsideReplacement = join(root, "outside-replacement");
  const sentinel = join(outsideReplacement, "must-survive.txt");
  await fs.promises.mkdir(outsideReplacement, { mode: 0o755 });
  await fs.promises.writeFile(sentinel, "outside sentinel");
  await fs.promises.chmod(outsideReplacement, 0o755);
  swapAtNextOpen(lease, async () => {
    await fs.promises.rename(lease, original);
    await fs.promises.rename(outsideReplacement, lease);
  });
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };
  let rejected = false;

  try {
    await store.createDirectoryExclusive(lease);
  } catch {
    rejected = true;
  }

  const hookWasNotReached = pendingOpenSwap?.path === resolve(lease);
  if (hookWasNotReached) pendingOpenSwap = null;
  assert.equal(hookWasNotReached, false, "exclusive creation must bind the new directory through an identity handle");

  assert.equal(await fs.promises.readFile(join(lease, "must-survive.txt"), "utf8"), "outside sentinel");
  assert.equal((await fs.promises.stat(lease)).mode & 0o777, 0o755);
  assert.equal(rejected, true);
});

test("PrivateStore token-bound owner read rejects a swapped claim without reading outside bytes", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-owner-read-swap-"));
  const lease = join(root, "provider-setup.lock");
  const moved = join(root, "provider-setup-before-read");
  const replacement = join(root, "foreign-provider-setup");
  const ownerPath = join(lease, "owner.json");
  const expectedOwner = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000001","acquiredAt":100,"expiresAt":200}\n';
  const foreignOwner = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000099","acquiredAt":900,"expiresAt":999}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  const claim = await store.createDirectoryExclusive(lease);
  assert.ok(claim);
  await store.writeClaimOwner(claim, expectedOwner);
  await fs.promises.mkdir(replacement);
  await fs.promises.writeFile(join(replacement, "owner.json"), foreignOwner);
  swapAtNextOpen(ownerPath, async () => {
    await fs.promises.rename(lease, moved);
    await fs.promises.rename(replacement, lease);
  });

  await assert.rejects(
    store.readClaimOwner(claim),
    /swapped|identity|claim|lease/i,
  );

  assert.equal(await fs.promises.readFile(join(lease, "owner.json"), "utf8"), foreignOwner);
  assert.equal(await fs.promises.readFile(join(moved, "owner.json"), "utf8"), expectedOwner);
});

test("PrivateStore token-bound owner write rejects a swapped claim before its first effect", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-owner-write-swap-"));
  const lease = join(root, "provider-setup.lock");
  const moved = join(root, "provider-setup-before-write");
  const replacement = join(root, "foreign-provider-setup");
  const sentinel = join(replacement, "must-survive.txt");
  const owner = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000006","acquiredAt":100,"expiresAt":200}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  const claim = await store.createDirectoryExclusive(lease);
  assert.ok(claim);
  await fs.promises.mkdir(replacement);
  await fs.promises.writeFile(sentinel, "foreign sentinel");
  swapAtNextLstat(lease, async () => {
    await fs.promises.rename(lease, moved);
    await fs.promises.rename(replacement, lease);
  });

  await assert.rejects(
    store.writeClaimOwner(claim, owner),
    /swapped|identity|claim|lease/i,
  );

  assert.equal(await fs.promises.readFile(join(lease, "must-survive.txt"), "utf8"), "foreign sentinel");
  await assert.rejects(fs.promises.readFile(join(lease, "owner.json")), /ENOENT/);
  assert.deepEqual(await fs.promises.readdir(moved), []);
});

test("PrivateStore token-bound manifest read rejects a swapped real claim and exposes no replacement bytes", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-manifest-read-swap-"));
  const transaction = join(root, "provider-activation", "70000000-0000-4000-8000-000000000003");
  const moved = `${transaction}.owned-before-read`;
  const replacement = `${transaction}.foreign`;
  const manifestPath = join(transaction, "manifest.json");
  const expected = '{"version":1,"phase":"prepared"}\n';
  const foreign = '{"version":1,"secret":"foreign"}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "provider-activation"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  await store.writeClaimManifest(claim, expected, null);
  await fs.promises.mkdir(replacement);
  await fs.promises.writeFile(join(replacement, "manifest.json"), foreign);
  swapAtNextOpen(manifestPath, async () => {
    await fs.promises.rename(transaction, moved);
    await fs.promises.rename(replacement, transaction);
  });

  await assert.rejects(store.readClaimManifest(claim), /swap|identity|claim|manifest|ausgetauscht/i);

  assert.equal(await fs.promises.readFile(join(transaction, "manifest.json"), "utf8"), foreign);
  assert.equal(await fs.promises.readFile(join(moved, "manifest.json"), "utf8"), expected);
});

test("PrivateStore token-bound manifest removal rejects a swapped file and retains both artifacts", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-manifest-remove-swap-"));
  const transaction = join(root, "provider-activation", "70000000-0000-4000-8000-000000000004");
  const manifestPath = join(transaction, "manifest.json");
  const movedManifest = join(transaction, "manifest-before-remove.json");
  const expected = '{"version":1,"phase":"prepared"}\n';
  const replacement = '{"version":1,"phase":"foreign"}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "provider-activation"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  await store.writeClaimManifest(claim, expected, null);
  swapAtNthLstat(manifestPath, 2, async () => {
    await fs.promises.rename(manifestPath, movedManifest);
    await fs.promises.writeFile(manifestPath, replacement);
  });

  await assert.rejects(
    store.removeClaimManifest(claim, expected),
    /swap|identity|claim|manifest|ausgetauscht/i,
  );

  assert.equal(await fs.promises.readFile(manifestPath, "utf8"), replacement);
  assert.equal(await fs.promises.readFile(movedManifest, "utf8"), expected);
  deferredLstatSwap = null;
});

test("PrivateStore manifest update CAS rejects a final-name swap before publish", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-manifest-write-swap-"));
  const transaction = join(root, "provider-activation", "70000000-0000-4000-8000-000000000005");
  const manifestPath = join(transaction, "manifest.json");
  const movedManifest = join(root, "manifest-owned-before-update.json");
  const expected = '{"version":1,"phase":"prepared"}\n';
  const replacement = '{"version":1,"phase":"foreign"}\n';
  const update = '{"version":1,"phase":"credential-staged"}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  await store.ensureDirectory(join(root, "provider-activation"));
  const claim = await store.createDirectoryExclusive(transaction);
  assert.ok(claim);
  await store.writeClaimManifest(claim, expected, null);
  swapAtNthLstat(manifestPath, 2, async () => {
    await fs.promises.rename(manifestPath, movedManifest);
    await fs.promises.writeFile(manifestPath, replacement);
  });

  await assert.rejects(
    store.writeClaimManifest(claim, update, expected),
    /swap|identity|claim|manifest|ausgetauscht|stimmt/i,
  );

  assert.equal(await fs.promises.readFile(manifestPath, "utf8"), replacement);
  assert.equal(await fs.promises.readFile(movedManifest, "utf8"), expected);
  deferredLstatSwap = null;
});

test("PrivateStore token-bound release rejects an owner swapped after readback and retains both artifacts", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-owner-release-swap-"));
  const lease = join(root, "provider-setup.lock");
  const ownerPath = join(lease, "owner.json");
  const movedOwner = join(lease, "owner-before-release.json");
  const expectedOwner = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000002","acquiredAt":100,"expiresAt":200}\n';
  const replacementOwner = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000003","acquiredAt":300,"expiresAt":400}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  const claim = await store.createDirectoryExclusive(lease);
  assert.ok(claim);
  await store.writeClaimOwner(claim, expectedOwner);
  swapAtNthLstat(ownerPath, 2, async () => {
    await fs.promises.rename(ownerPath, movedOwner);
    await fs.promises.writeFile(ownerPath, replacementOwner);
  });

  await assert.rejects(
    store.releaseDirectoryClaim(claim, expectedOwner),
    /ausgetauscht|identity|owner|claim/i,
  );

  assert.equal(await fs.promises.readFile(ownerPath, "utf8"), replacementOwner);
  assert.equal(await fs.promises.readFile(movedOwner, "utf8"), expectedOwner);
  assert.equal((await fs.promises.stat(lease)).isDirectory(), true);
  deferredLstatSwap = null;
});

test("a stale claim token cannot release a newer lease inode or owner", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-stale-token-"));
  const lease = join(root, "provider-setup.lock");
  const ownerA = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000004","acquiredAt":100,"expiresAt":200}\n';
  const ownerB = '{"version":1,"ownerId":"50000000-0000-4000-8000-000000000005","acquiredAt":300,"expiresAt":400}\n';
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  const claimA = await store.createDirectoryExclusive(lease);
  assert.ok(claimA);
  await store.writeClaimOwner(claimA, ownerA);
  const adoptedA = await store.adoptDirectoryClaim(lease);
  await store.releaseDirectoryClaim(adoptedA.claim, ownerA);
  const claimB = await store.createDirectoryExclusive(lease);
  assert.ok(claimB);
  await store.writeClaimOwner(claimB, ownerB);

  await assert.rejects(
    store.releaseDirectoryClaim(claimA, ownerA),
    /swapped|identity|claim|lease/i,
  );

  assert.equal(await store.readClaimOwner(claimB), ownerB);
  assert.equal((await fs.promises.stat(lease)).isDirectory(), true);
});

test("an adopted ownerless empty crash claim can be released only through its exact token", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-ownerless-claim-"));
  const lease = join(root, "provider-setup.lock");
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as TokenBoundClaimStore;
  const crashedClaim = await store.createDirectoryExclusive(lease);
  assert.ok(crashedClaim);
  const adopted = await store.adoptDirectoryClaim(lease);

  await store.releaseDirectoryClaim(adopted.claim, null);

  await assert.rejects(fs.promises.stat(lease), /ENOENT/);
  await assert.rejects(store.assertDirectoryClaim(crashedClaim), /ENOENT|identity|claim/i);
});

test("PrivateStore claim protection failure never rmdirs a replacement during rollback", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-exclusive-rmdir-swap-"));
  const claim = join(root, "hmac-init.lock");
  const movedClaim = join(root, "hmac-init-before-rmdir");
  const replacement = join(root, "foreign-empty-replacement");
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  swapAtNextRmdir(claim, async () => {
    await fs.promises.rename(claim, movedClaim);
    await fs.promises.rename(replacement, claim);
  });
  class RejectingClaimAdapter extends PosixPrivateStoreAdapter {
    override async protectDirectory(path: string): Promise<void> {
      if (path === claim) throw new Error("synthetic claim protection refusal");
      await super.protectDirectory(path);
    }
  }
  const store = new PrivateStore({
    adapter: new RejectingClaimAdapter(),
    root,
  }) as unknown as {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };

  await assert.rejects(
    store.createDirectoryExclusive(claim),
    /protection refusal/,
  );

  const rollbackAttempted = pendingRmdirSwap === null;
  pendingRmdirSwap = null;
  assert.equal(rollbackAttempted, false, "claim creation must never path-rmdir after failure");
  assert.equal((await fs.promises.stat(claim)).isDirectory(), true);
});

test("PrivateStore exclusive root protection detects a replacement without deleting it", async () => {
  const fixture = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-root-open-swap-"));
  const root = join(fixture, "canonical-root");
  const claim = join(root, "hmac-init.lock");
  const movedRoot = join(fixture, "created-root-before-swap");
  const replacement = join(fixture, "foreign-root-replacement");
  const sentinel = "foreign root sentinel must survive";
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  await fs.promises.writeFile(join(replacement, "must-survive.txt"), sentinel);
  swapAtNextOpen(root, async () => {
    await fs.promises.rename(root, movedRoot);
    await fs.promises.rename(replacement, root);
  });
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };
  let failure: unknown;
  try {
    await store.createDirectoryExclusive(claim);
  } catch (error) {
    failure = error;
  }
  const swapTriggered = pendingOpenSwap === null;
  pendingOpenSwap = null;

  assert.ok(failure instanceof Error);
  assert.equal(swapTriggered, true, "root must reach bound protection after exclusive creation");
  assert.equal(
    await fs.promises.readFile(join(root, "must-survive.txt"), "utf8"),
    sentinel,
  );
  assert.equal((await fs.promises.stat(movedRoot)).isDirectory(), true);
});

test("PrivateStore exclusive claim rejects a root replaced after root protection", async () => {
  const fixture = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-root-post-protect-swap-"));
  const root = join(fixture, "canonical-root");
  const claim = join(root, "hmac-init.lock");
  const movedRoot = join(fixture, "protected-root-before-swap");
  const replacement = join(fixture, "foreign-root-after-protection");
  const sentinel = "post-protection replacement must stay exact";
  await fs.promises.mkdir(root, { mode: 0o700 });
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  await fs.promises.writeFile(join(replacement, "must-survive.txt"), sentinel);
  swapAtNthLstat(root, 6, async () => {
    await fs.promises.rename(root, movedRoot);
    await fs.promises.rename(replacement, root);
  });
  const store = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root,
  }) as unknown as {
    createDirectoryExclusive(path: string): Promise<object | null>;
  };

  await assert.rejects(
    store.createDirectoryExclusive(claim),
    /swapped|identity/i,
  );

  assert.equal(deferredLstatSwap, null);
  assert.equal(
    await fs.promises.readFile(join(root, "must-survive.txt"), "utf8"),
    sentinel,
  );
  assert.deepEqual(await fs.promises.readdir(root), ["must-survive.txt"]);
  assert.equal((await fs.promises.stat(movedRoot)).isDirectory(), true);
});

test("PrivateStore protect compares the pre-open snapshot before changing a replacement", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-preopen-protect-"));
  const tree = join(root, "backup");
  const original = join(root, "backup-before-swap");
  const outsideReplacement = join(root, "outside-replacement");
  await fs.promises.mkdir(tree, { mode: 0o755 });
  await fs.promises.mkdir(outsideReplacement, { mode: 0o755 });
  await fs.promises.chmod(tree, 0o755);
  await fs.promises.chmod(outsideReplacement, 0o755);
  swapAtNextOpen(tree, async () => {
    await fs.promises.rename(tree, original);
    await fs.promises.rename(outsideReplacement, tree);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);
  let rejected = false;

  try {
    await store.protectTree(tree);
  } catch {
    rejected = true;
  }

  assert.equal((await fs.promises.stat(tree)).mode & 0o777, 0o755);
  assert.equal(rejected, true);
});

test("PrivateStore remove compares the pre-open snapshot before deleting a replacement", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-preopen-remove-"));
  const tree = join(root, "staging");
  const original = join(root, "staging-before-swap");
  const outsideReplacement = join(root, "outside-replacement");
  const victim = join(outsideReplacement, "must-survive.txt");
  await fs.promises.mkdir(tree);
  await fs.promises.mkdir(outsideReplacement);
  await fs.promises.writeFile(victim, "outside sentinel");
  swapAtNextOpen(tree, async () => {
    await fs.promises.rename(tree, original);
    await fs.promises.rename(outsideReplacement, tree);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);
  let rejected = false;

  try {
    await store.removeTree(tree);
  } catch {
    rejected = true;
  }

  assert.equal(await fs.promises.readFile(join(tree, "must-survive.txt"), "utf8"), "outside sentinel");
  assert.equal(swappedOpenHandle?.fd, -1);
  assert.equal(rejected, true);
});

test("PrivateStore rename compares the pre-open snapshot before moving a replacement", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-preopen-rename-"));
  const source = join(root, "legacy");
  const original = join(root, "legacy-before-swap");
  const outsideReplacement = join(root, "outside-replacement");
  const destinationRoot = join(root, "home");
  const destination = join(destinationRoot, "migration-backups", "legacy");
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(outsideReplacement);
  await fs.promises.writeFile(join(outsideReplacement, "must-survive.txt"), "outside sentinel");
  await fs.promises.mkdir(join(destinationRoot, "migration-backups"), { recursive: true });
  swapAtNextOpen(source, async () => {
    await fs.promises.rename(source, original);
    await fs.promises.rename(outsideReplacement, source);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root: destinationRoot } as never);
  let rejected = false;

  try {
    await store.renameTree(source, destination, root);
  } catch {
    rejected = true;
  }

  assert.equal(await fs.promises.readFile(join(source, "must-survive.txt"), "utf8"), "outside sentinel");
  await assert.rejects(fs.promises.stat(destination), /ENOENT/);
  assert.equal(rejected, true);
});

test("PrivateStore rename rechecks the opened source after awaited destination inspection", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-recheck-rename-"));
  const source = join(root, "legacy");
  const original = join(root, "legacy-before-swap");
  const outsideReplacement = join(root, "outside-replacement");
  const destinationRoot = join(root, "home");
  const destination = join(destinationRoot, "migration-backups", "legacy");
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(outsideReplacement);
  await fs.promises.writeFile(join(outsideReplacement, "must-survive.txt"), "outside sentinel");
  await fs.promises.mkdir(join(destinationRoot, "migration-backups"), { recursive: true });
  swapAtNextLstat(destination, async () => {
    await fs.promises.rename(source, original);
    await fs.promises.rename(outsideReplacement, source);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root: destinationRoot } as never);
  let rejected = false;

  try {
    await store.renameTree(source, destination, root);
  } catch {
    rejected = true;
  }

  assert.equal(await fs.promises.readFile(join(source, "must-survive.txt"), "utf8"), "outside sentinel");
  await assert.rejects(fs.promises.stat(destination), /ENOENT/);
  assert.equal(rejected, true);
});

test("PrivateStore temp cleanup checks the bound name after its final ancestor await", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-final-temp-await-"));
  const target = join(root, "state.json");
  let temporary: string | null = null;
  let originalTemporary: string | null = null;
  class RejectingAdapter extends PosixPrivateStoreAdapter {
    override async protectFile(
      path: string,
      handle?: Awaited<ReturnType<typeof nativeOpen>>,
    ): Promise<void> {
      await super.protectFile(path, handle);
      temporary = path;
      originalTemporary = `${path}.before-cleanup`;
      swapAtNthLstat(root, 2, async () => {
        await fs.promises.rename(path, originalTemporary!);
        await fs.promises.writeFile(path, "replacement sentinel", { mode: 0o644 });
      });
      throw new Error("synthetic cleanup boundary failure");
    }
  }
  const store = new PrivateStore({ adapter: new RejectingAdapter(), root } as never);

  await assert.rejects(
    store.writeTextAtomic(target, "exact bytes"),
    /cleanup boundary failure/,
  );

  assert.notEqual(temporary, null);
  assert.notEqual(originalTemporary, null);
  assert.equal(await fs.promises.readFile(temporary!, "utf8"), "replacement sentinel");
  assert.equal(await fs.promises.readFile(originalTemporary!, "utf8"), "");
  await assert.rejects(fs.promises.stat(target), /ENOENT/);
  assert.equal(deferredLstatSwap, null);
});

test("PrivateStore protectTree keeps its caller snapshot through the helper ancestor await", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-helper-tree-await-"));
  const tree = join(root, "backup");
  const original = join(root, "backup-before-swap");
  const replacement = join(root, "outside-replacement");
  const sentinel = join(replacement, "must-survive.txt");
  await fs.promises.mkdir(tree, { mode: 0o755 });
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  await fs.promises.writeFile(sentinel, "outside sentinel", { mode: 0o644 });
  await fs.promises.chmod(tree, 0o755);
  await fs.promises.chmod(replacement, 0o755);
  await fs.promises.chmod(sentinel, 0o644);
  swapAfterLstat(tree, root, 1, async () => {
    await fs.promises.rename(tree, original);
    await fs.promises.rename(replacement, tree);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);
  let rejected = false;

  try {
    await store.protectTree(tree);
  } catch {
    rejected = true;
  }

  assert.equal((await fs.promises.stat(tree)).mode & 0o777, 0o755);
  assert.equal((await fs.promises.stat(join(tree, "must-survive.txt"))).mode & 0o777, 0o644);
  assert.equal(await fs.promises.readFile(join(tree, "must-survive.txt"), "utf8"), "outside sentinel");
  assert.equal(rejected, true);
  assert.equal(deferredLstatSwap, null);
});

test("PrivateStore ensureDirectory keeps its caller snapshot through the helper ancestor await", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-helper-ensure-await-"));
  const directory = join(root, "exact");
  const original = join(root, "exact-before-swap");
  const replacement = join(root, "outside-replacement");
  const sentinel = join(replacement, "must-survive.txt");
  await fs.promises.mkdir(directory, { mode: 0o755 });
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  await fs.promises.writeFile(sentinel, "outside sentinel", { mode: 0o644 });
  await fs.promises.chmod(directory, 0o755);
  await fs.promises.chmod(replacement, 0o755);
  await fs.promises.chmod(sentinel, 0o644);
  swapAfterLstat(directory, root, 2, async () => {
    await fs.promises.rename(directory, original);
    await fs.promises.rename(replacement, directory);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);
  let rejected = false;

  try {
    await store.ensureDirectory(directory);
  } catch {
    rejected = true;
  }

  assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o755);
  assert.equal((await fs.promises.stat(join(directory, "must-survive.txt"))).mode & 0o777, 0o644);
  assert.equal(await fs.promises.readFile(join(directory, "must-survive.txt"), "utf8"), "outside sentinel");
  assert.equal(rejected, true);
  assert.equal(deferredLstatSwap, null);
});

test("PrivateStore protectTree keeps a nested directory snapshot through the parent ancestor await", async () => {
  const root = await fs.promises.mkdtemp(join(tmpdir(), "orcode-private-nested-tree-await-"));
  const tree = join(root, "backup");
  const nested = join(tree, "nested");
  const original = join(tree, "nested-before-swap");
  const replacement = join(root, "outside-replacement");
  const sentinel = join(replacement, "must-survive.txt");
  await fs.promises.mkdir(nested, { recursive: true, mode: 0o755 });
  await fs.promises.mkdir(replacement, { mode: 0o755 });
  await fs.promises.writeFile(sentinel, "outside sentinel", { mode: 0o644 });
  await fs.promises.chmod(nested, 0o755);
  await fs.promises.chmod(replacement, 0o755);
  await fs.promises.chmod(sentinel, 0o644);
  swapAfterLstat(nested, tree, 1, async () => {
    await fs.promises.rename(nested, original);
    await fs.promises.rename(replacement, nested);
  });
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter(), root } as never);
  let rejected = false;

  try {
    await store.protectTree(tree);
  } catch {
    rejected = true;
  }

  assert.equal((await fs.promises.stat(nested)).mode & 0o777, 0o755);
  assert.equal((await fs.promises.stat(join(nested, "must-survive.txt"))).mode & 0o777, 0o644);
  assert.equal(await fs.promises.readFile(join(nested, "must-survive.txt"), "utf8"), "outside sentinel");
  assert.equal(rejected, true);
  assert.equal(deferredLstatSwap, null);
});
