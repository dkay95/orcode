import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RuleStore,
  deriveCommandSubject,
  matchesGlob,
  rulesPath,
} from "../src/rules.js";

async function tempAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-rules-test-"));
}

test("deriveCommandSubject: erstes Token plus erstes Nicht-Flag-Argument", () => {
  assert.equal(deriveCommandSubject("npm test"), "npm test");
  assert.equal(deriveCommandSubject("git status"), "git status");
  assert.equal(deriveCommandSubject("rm -rf"), "rm");
  assert.equal(deriveCommandSubject("rm -rf build"), "rm build");
  assert.equal(deriveCommandSubject("  npm   run   build  "), "npm run");
  assert.equal(deriveCommandSubject("ls"), "ls");
  assert.equal(deriveCommandSubject(""), "");
});

test("matchesGlob: * und ** wie erwartet, sonst literal", () => {
  assert.equal(matchesGlob(".env", ".env"), true);
  assert.equal(matchesGlob(".env", ".env.local"), false);
  assert.equal(matchesGlob("src/*.ts", "src/index.ts"), true);
  assert.equal(matchesGlob("src/*.ts", "src/sub/index.ts"), false);
  assert.equal(matchesGlob("src/**/*.ts", "src/sub/deep/index.ts"), true);
  assert.equal(matchesGlob("**/*.env", "a/b/c.env"), true);
  assert.equal(matchesGlob(".git/config", ".git/hooks/pre-commit"), false);
});

test("RuleStore.decide: kein Treffer ⇒ null, allow-Treffer ⇒ allow, deny gewinnt gegen allow", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    assert.equal(store.decide("/ws", "run_command", "npm test"), null);

    await store.remember({
      workspace: "/ws",
      tool: "run_command",
      match: { kind: "command-prefix", value: "npm test" },
      decision: "allow",
    });
    assert.equal(store.decide("/ws", "run_command", "npm test"), "allow");
    assert.equal(store.decide("/ws", "run_command", "npm test --watch"), "allow");
    assert.equal(store.decide("/ws", "run_command", "npm publish"), null);
    // Different workspace: no bleed-through.
    assert.equal(store.decide("/other", "run_command", "npm test"), null);

    await store.remember({
      workspace: "/ws",
      tool: "run_command",
      match: { kind: "command-prefix", value: "npm test" },
      decision: "deny",
    });
    assert.equal(
      store.decide("/ws", "run_command", "npm test"),
      "deny",
      "deny muss gegen eine vorhandene allow-Regel gewinnen",
    );
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore: any-Regel greift für jedes Subject des Tools", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    await store.remember({
      workspace: "/ws",
      tool: "read_file",
      match: { kind: "any" },
      decision: "allow",
    });
    assert.equal(store.decide("/ws", "read_file", "irgendwas.ts"), "allow");
    assert.equal(store.decide("/ws", "read_file", "anderes.ts"), "allow");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore.forget entfernt genau die passende Regel", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    const rule = await store.remember({
      workspace: "/ws",
      tool: "run_command",
      match: { kind: "command-prefix", value: "npm test" },
      decision: "allow",
    });
    assert.equal(store.list("/ws").length, 1);
    const removed = await store.forget(rule.id);
    assert.equal(removed, true);
    assert.equal(store.list("/ws").length, 0);
    assert.equal(store.decide("/ws", "run_command", "npm test"), null);

    const removedAgain = await store.forget(rule.id);
    assert.equal(removedAgain, false);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore: Persistenzdatei ist 0600 und übersteht einen Neustart", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    await store.remember({
      workspace: "/ws",
      tool: "write_file",
      match: { kind: "path-glob", value: "src/*.ts" },
      decision: "allow",
    });

    const path = rulesPath(appHome);
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);

    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version: number; rules: unknown[] };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.rules.length, 1);

    const reopened = await RuleStore.load(appHome);
    assert.equal(reopened.decide("/ws", "write_file", "src/index.ts"), "allow");
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});

test("RuleStore.load ohne vorhandene Datei liefert einen leeren Store", async () => {
  const appHome = await tempAppHome();
  try {
    const store = await RuleStore.load(appHome);
    assert.deepEqual(store.list("/ws"), []);
    assert.equal(store.decide("/ws", "run_command", "npm test"), null);
  } finally {
    await rm(appHome, { recursive: true, force: true });
  }
});
