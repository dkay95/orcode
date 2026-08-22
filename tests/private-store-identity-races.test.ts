import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const nativeOpen = fs.promises.open.bind(fs.promises);
const nativeLstat = fs.promises.lstat.bind(fs.promises);
let pendingOpenSwap: { path: string; run: () => Promise<void> } | null = null;
let pendingLstatSwap: { path: string; run: () => Promise<void> } | null = null;
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
  return (nativeLstat as unknown as (
    ...callArgs: unknown[]
  ) => ReturnType<typeof nativeLstat>)(...args);
}) as typeof nativeLstat;
Object.defineProperty(fs.promises, "lstat", {
  configurable: true,
  writable: true,
  value: wrappedLstat,
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
