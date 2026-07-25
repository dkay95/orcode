import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateAppHome } from "../src/config.js";

/**
 * The rename from `~/.routercode` to `~/.orcode` moves real user data: chats,
 * config, permission rules. These tests pin the four cases that decide whether
 * that data survives. Every path is injected — the real home is never touched.
 */

async function seedLegacy(root: string): Promise<string> {
  const legacy = join(root, ".routercode");
  await mkdir(join(legacy, "chats"), { recursive: true });
  await writeFile(join(legacy, "config.json"), '{"mainModel":"kimi"}');
  await writeFile(join(legacy, "chats", "a.json"), '{"turns":[1,2,3]}');
  return legacy;
}

test("the legacy directory is moved and its contents survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-"));
  const legacy = await seedLegacy(root);
  const target = join(root, ".orcode");

  const result = await migrateAppHome(target, legacy);

  assert.equal(result.appHome, target);
  assert.equal(result.warning, null);
  assert.equal(
    await readFile(join(target, "chats", "a.json"), "utf8"),
    '{"turns":[1,2,3]}',
  );
  assert.equal(
    await readFile(join(target, "config.json"), "utf8"),
    '{"mainModel":"kimi"}',
  );
  await rm(root, { recursive: true, force: true });
});

test("a second run changes nothing and never clobbers the new directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-"));
  const legacy = await seedLegacy(root);
  const target = join(root, ".orcode");

  await migrateAppHome(target, legacy);
  // A stale legacy directory reappearing must not overwrite newer state.
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "config.json"), '{"mainModel":"stale"}');

  const second = await migrateAppHome(target, legacy);

  assert.equal(second.appHome, target);
  assert.equal(second.warning, null);
  assert.equal(
    await readFile(join(target, "config.json"), "utf8"),
    '{"mainModel":"kimi"}',
  );
  await rm(root, { recursive: true, force: true });
});

test("a fresh install without a legacy directory is a no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-"));
  const target = join(root, ".orcode");

  const result = await migrateAppHome(target, join(root, ".routercode"));

  assert.equal(result.appHome, target);
  assert.equal(result.warning, null);
  await rm(root, { recursive: true, force: true });
});

test("a failed move leaves the old data untouched and keeps working with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-migration-"));
  const legacy = await seedLegacy(root);
  // An unwritable parent makes rename fail the way a cross-device move would.
  const target = join(root, "missing-parent", "does-not-exist", ".orcode");

  const result = await migrateAppHome(target, legacy);

  assert.equal(result.appHome, legacy, "must keep using the old directory");
  assert.match(String(result.warning), /konnte nicht/);
  assert.equal(
    await readFile(join(legacy, "chats", "a.json"), "utf8"),
    '{"turns":[1,2,3]}',
    "user data must survive a failed migration",
  );
  await rm(root, { recursive: true, force: true });
});
