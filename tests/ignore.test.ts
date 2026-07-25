import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadIgnore } from "../src/ignore.js";

async function withGitignore(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "routercode-ignore-"));
  await writeFile(join(root, ".gitignore"), content, "utf8");
  return root;
}

test("no .gitignore means nothing is ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "routercode-ignore-none-"));
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("anything.txt", false), false);
  assert.equal(matcher.unsupportedCount, 0);
});

test("comments and blank lines are skipped", async () => {
  const root = await withGitignore("# comment\n\n*.log\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("a.log", false), true);
  assert.equal(matcher.matches("a.txt", false), false);
});

test("unanchored patterns match at any depth", async () => {
  const root = await withGitignore("*.log\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("a.log", false), true);
  assert.equal(matcher.matches("sub/deep/a.log", false), true);
});

test("a leading slash anchors a pattern to the root only", async () => {
  const root = await withGitignore("/root-only\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("root-only", false), true);
  assert.equal(matcher.matches("sub/root-only", false), false);
});

test("a trailing slash matches the directory and everything inside it", async () => {
  const root = await withGitignore("dist/\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("dist", true), true);
  assert.equal(matcher.matches("dist/other.js", false), true);
  assert.equal(matcher.matches("distant.txt", false), false);
});

test("negation re-includes a file inside an otherwise ignored directory", async () => {
  const root = await withGitignore("dist/\n!dist/keep.txt\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("dist/keep.txt", false), false);
  assert.equal(matcher.matches("dist/other.js", false), true);
});

test("later rules win over earlier ones for the same path", async () => {
  const root = await withGitignore("*.txt\n!keep.txt\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("a.txt", false), true);
  assert.equal(matcher.matches("keep.txt", false), false);
});

test("** matches across directory boundaries", async () => {
  const root = await withGitignore("**/generated/**\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.matches("a/generated/b/c.txt", false), true);
  assert.equal(matcher.matches("generated/c.txt", false), true);
  assert.equal(matcher.matches("a/gen/c.txt", false), false);
});

test("character classes are unsupported and counted, not silently mis-applied", async () => {
  const root = await withGitignore("[abc].txt\nnormal.log\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.unsupportedCount, 1);
  // The one supported line still works.
  assert.equal(matcher.matches("normal.log", false), true);
  // The unsupported line must not silently match either.
  assert.equal(matcher.matches("a.txt", false), false);
});

test("backslash escapes are unsupported and counted", async () => {
  const root = await withGitignore("a\\ b.txt\n");
  const matcher = await loadIgnore(root);
  assert.equal(matcher.unsupportedCount, 1);
});

test("the full K4 fixture: dist/, negation, *.log, and /root-only together", async () => {
  const root = await withGitignore("dist/\n!dist/keep.txt\n*.log\n/root-only\n");
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "sub"), { recursive: true });
  const matcher = await loadIgnore(root);

  assert.equal(matcher.matches("dist/keep.txt", false), false);
  assert.equal(matcher.matches("dist/other.js", false), true);
  assert.equal(matcher.matches("a.log", false), true);
  assert.equal(matcher.matches("root-only", false), true);
  assert.equal(matcher.matches("sub/root-only", false), false);
});

test("the matcher is cached and reloaded only when the .gitignore's mtime changes", async () => {
  const root = await withGitignore("*.log\n");
  const first = await loadIgnore(root);
  const second = await loadIgnore(root);
  assert.equal(first, second, "unveränderte .gitignore sollte denselben Matcher liefern");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  await writeFile(join(root, ".gitignore"), "*.txt\n", "utf8");
  const third = await loadIgnore(root);
  assert.notEqual(second, third, "geänderte .gitignore sollte neu geladen werden");
  assert.equal(third.matches("a.log", false), false);
  assert.equal(third.matches("a.txt", false), true);
});
