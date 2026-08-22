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
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

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
