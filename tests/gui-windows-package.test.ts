import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalRuntimeManifest, runtimeManifestDigest, collectWindowsRuntimeManifest, validateWindowsRuntimePin,
} from "../scripts/gui-windows-runtime.mjs";

const NODE_SHA = "ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c";
const PIN = { version: "24.22.0", platform: "win32", arch: "x64", archive: "node-v24.22.0-win-x64.zip",
  archiveSha256: "f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3", nodeSha256: NODE_SHA };
function manifest() {
  return { schemaVersion: 1, platform: "win32", arch: "x64", nodeVersion: "24.22.0", files: [
    { path: "node.exe", bytes: 100, sha256: NODE_SHA },
    { path: "orcode-platform-host.exe", bytes: 100, sha256: "a".repeat(64) },
    { path: "dist/gui-server.js", bytes: 10, sha256: "b".repeat(64) },
    { path: "package.json", bytes: 10, sha256: "c".repeat(64) },
    { path: "node_modules/example/index.js", bytes: 10, sha256: "d".repeat(64) },
  ] };
}

test("runtime pins reject wrong target, floating versions and substituted checksums", () => {
  assert.deepEqual(validateWindowsRuntimePin(PIN), PIN);
  for (const delta of [{ arch: "arm64" }, { platform: "darwin" }, { version: "latest" },
    { version: "24.21.0" }, { archive: "node.zip" }, { nodeSha256: "a".repeat(64) },
    { archiveSha256: "b".repeat(64) }, { shell: true }]) {
    assert.throws(() => validateWindowsRuntimePin({ ...PIN, ...delta }));
  }
});

test("runtime manifest canonically binds every resource and missing helper never passes", () => {
  const input = manifest();
  const canonical = canonicalRuntimeManifest(input);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.files), true);
  assert.equal(runtimeManifestDigest(input), runtimeManifestDigest({ ...input, files: [...input.files].reverse() }));
  assert.notEqual(runtimeManifestDigest(input), runtimeManifestDigest({ ...input, files: input.files.map((file) =>
    file.path === "dist/gui-server.js" ? { ...file, sha256: "e".repeat(64) } : file) }));
  for (const path of ["node.exe", "orcode-platform-host.exe", "dist/gui-server.js", "package.json"]) {
    assert.throws(() => canonicalRuntimeManifest({ ...input, files: input.files.filter((file) => file.path !== path) }));
  }
  assert.throws(() => canonicalRuntimeManifest({ ...input, files: [...input.files, { ...input.files[0]!, path: "NODE.EXE" }] }));
  assert.throws(() => canonicalRuntimeManifest({ ...input, files: input.files.map((file) =>
    file.path === "node.exe" ? { ...file, sha256: "0".repeat(64) } : file) }));
});

test("runtime manifests refuse app homes, credentials and Windows path aliases", () => {
  const input = manifest();
  for (const path of [".orcode/config.json", ".codex/auth.json", ".devhome/settings.json", "dist/.env",
    "node_modules/pkg/auth.json", "dist/../auth.json", "C:/node.exe", "dist/foo:stream", "dist/CON.txt", "dist/file.",
    "dist\\gui-server.js", "dist//bad.js", "dist/./bad.js"]) {
    assert.throws(() => canonicalRuntimeManifest({ ...input, files: [...input.files, { path, bytes: 1, sha256: "f".repeat(64) }] }), path);
  }
  assert.throws(() => canonicalRuntimeManifest({ ...input, rawHandle: "1" }));
  assert.throws(() => canonicalRuntimeManifest({ ...input, files: input.files.map((file) => ({ ...file, signed: true })) }));
});

async function stagingFixture() {
  const root = await mkdtemp(join(tmpdir(), "orcode-win-package-"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "node_modules", "example"), { recursive: true });
  for (const path of ["node.exe", "orcode-platform-host.exe", "dist/gui-server.js", "package.json", "node_modules/example/index.js"]) {
    await writeFile(join(root, path), "synthetic bytes, not a runnable trusted binary");
  }
  return root;
}

test("staging inspection rejects missing helper and foreign native addons before packaging", async (t) => {
  const root = await stagingFixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, "orcode-platform-host.exe"));
  assert.throws(() => collectWindowsRuntimeManifest(root), /missing.*helper|helper.*missing/i);
  await writeFile(join(root, "orcode-platform-host.exe"), "synthetic");
  await writeFile(join(root, "node_modules/example/addon.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  assert.throws(() => collectWindowsRuntimeManifest(root), /native.*addon|addon.*windows|PE.*x64/i);
});
