import assert from "node:assert/strict";
import test from "node:test";
import { ReadRegistry, sha256Hex } from "../src/read-registry.js";

test("check returns unknown for a path that was never noted", () => {
  const registry = new ReadRegistry();
  assert.equal(
    registry.check("/tmp/never-read.txt", { mtimeMs: 1, size: 1, sha256: "abc" }),
    "unknown",
  );
});

test("check returns fresh when mtime, size, and sha256 all still match", () => {
  const registry = new ReadRegistry();
  registry.note("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a", at: 1 });
  assert.equal(
    registry.check("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a" }),
    "fresh",
  );
});

test("check returns stale when the content changed, even with the same size", () => {
  const registry = new ReadRegistry();
  registry.note("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: sha256Hex("abc"), at: 1 });
  assert.equal(
    registry.check("/tmp/a.txt", { mtimeMs: 200, size: 3, sha256: sha256Hex("xyz") }),
    "stale",
  );
});

test("forget makes a previously noted path unknown again", () => {
  const registry = new ReadRegistry();
  registry.note("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a", at: 1 });
  registry.forget("/tmp/a.txt");
  assert.equal(
    registry.check("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a" }),
    "unknown",
  );
});

test("note overwrites the previous record for the same path", () => {
  const registry = new ReadRegistry();
  registry.note("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a", at: 1 });
  registry.note("/tmp/a.txt", { mtimeMs: 200, size: 4, sha256: "hash-b", at: 2 });
  assert.equal(
    registry.check("/tmp/a.txt", { mtimeMs: 100, size: 3, sha256: "hash-a" }),
    "stale",
  );
  assert.equal(
    registry.check("/tmp/a.txt", { mtimeMs: 200, size: 4, sha256: "hash-b" }),
    "fresh",
  );
});

test("one instance tracks many paths independently", () => {
  const registry = new ReadRegistry();
  registry.note("/tmp/a.txt", { mtimeMs: 1, size: 1, sha256: "a", at: 1 });
  registry.note("/tmp/b.txt", { mtimeMs: 1, size: 1, sha256: "b", at: 1 });
  assert.equal(registry.check("/tmp/a.txt", { mtimeMs: 1, size: 1, sha256: "a" }), "fresh");
  assert.equal(registry.check("/tmp/b.txt", { mtimeMs: 1, size: 1, sha256: "b" }), "fresh");
  assert.equal(registry.check("/tmp/c.txt", { mtimeMs: 1, size: 1, sha256: "c" }), "unknown");
});

test("sha256Hex hashes strings and buffers identically for the same bytes", () => {
  const fromString = sha256Hex("hallo");
  const fromBuffer = sha256Hex(Buffer.from("hallo", "utf8"));
  assert.equal(fromString, fromBuffer);
  assert.equal(fromString.length, 64);
  assert.notEqual(sha256Hex("hallo"), sha256Hex("hallo!"));
});
