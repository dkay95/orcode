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
