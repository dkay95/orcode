import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("PrivateStore enforces 0700 directories and 0600 atomic files on POSIX", async () => {
  const { PosixPrivateStoreAdapter, PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-posix-"));
  const directory = join(root, "exact", "chat-a");
  const path = join(directory, "state.json");
  const store = new PrivateStore({ adapter: new PosixPrivateStoreAdapter() });

  await store.writeTextAtomic(path, "exact recovery state\n");

  assert.equal(await readFile(path, "utf8"), "exact recovery state\n");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("Windows PrivateStore applies and verifies the deterministic current-user plus SYSTEM DACL", async () => {
  const { PrivateStore, WindowsPrivateStoreAdapter } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-windows-"));
  const calls: Array<{ executable: string; args: string[] }> = [];
  const adapter = new WindowsPrivateStoreAdapter(async (executable, args) => {
    calls.push({ executable, args: [...args] });
    return { code: 0, stdout: "", stderr: "" };
  });
  const store = new PrivateStore({ adapter });
  const path = join(root, "exact", "state.json");

  await store.writeTextAtomic(path, "opaque\n");

  assert.equal(calls.length, 3, "one fail-closed probe plus directory and file DACLs");
  assert.match(calls[0]!.args[3] ?? "", /WindowsIdentity.*GetCurrent/);
  for (const call of calls.slice(1)) {
    assert.equal(call.executable, "powershell.exe");
    assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    const script = call.args[3] ?? "";
    assert.match(script, /WindowsIdentity.*GetCurrent/);
    assert.match(script, /S-1-5-18/);
    assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(script, /Get-Acl/);
    assert.match(script, /exit 17/);
  }
  assert.equal(calls[1]!.args.at(-1), "directory");
  assert.equal(calls[2]!.args.at(-1), "file");
});

test("PrivateStore fails closed and never publishes an exact file when its adapter cannot enforce privacy", async () => {
  const { PrivateStore } = await import("../src/private-store.js");
  const root = await mkdtemp(join(tmpdir(), "orcode-private-closed-"));
  const path = join(root, "exact", "state.json");
  const store = new PrivateStore({
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
