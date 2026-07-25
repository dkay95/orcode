import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeGlobPattern,
  classifyPath,
  isSecretReadPath,
  pathSegments,
} from "../src/policy.js";

test("write policy protects git internals, secrets, and generated code", () => {
  assert.equal(classifyPath(".git/config", "write").verdict, "approve");
  assert.equal(classifyPath(".git/hooks/pre-commit", "write").verdict, "deny");
  assert.equal(classifyPath("node_modules/pkg/index.js", "write").verdict, "approve");
  assert.equal(classifyPath(".github/workflows/ci.yml", "write").verdict, "approve");
  assert.equal(classifyPath(".ssh/config", "write").verdict, "approve");
  assert.equal(classifyPath(".env", "write").verdict, "approve");
  assert.equal(classifyPath(".env.local", "write").verdict, "approve");
  assert.equal(classifyPath("certs/server.pem", "write").verdict, "approve");
  assert.equal(classifyPath("keys/id_ed25519", "write").verdict, "approve");

  assert.equal(classifyPath("src/index.ts", "write").verdict, "allow");
  assert.equal(classifyPath("README.md", "write").verdict, "allow");
  assert.equal(classifyPath(".github/dependabot.yml", "write").verdict, "allow");
});

test("read policy only guards secret material", () => {
  assert.equal(classifyPath(".env", "read").verdict, "approve");
  assert.equal(classifyPath("deploy/credentials.json", "read").verdict, "approve");
  assert.equal(classifyPath(".aws/config", "read").verdict, "approve");
  assert.equal(classifyPath(".ssh/id_rsa", "read").verdict, "approve");
  assert.equal(classifyPath("certs/key.pem", "read").verdict, "approve");

  assert.equal(classifyPath(".git/config", "read").verdict, "allow");
  assert.equal(classifyPath("src/id_utils.ts", "read").verdict, "allow");
  assert.equal(classifyPath("src/index.ts", "read").verdict, "allow");
  assert.equal(isSecretReadPath("src/index.ts"), false);
  assert.equal(isSecretReadPath(".env.production"), true);
});

test("policy rules carry an id and a German reason", () => {
  const decision = classifyPath(".git/hooks/pre-push", "write");
  assert.equal(decision.rule, "git-hooks");
  assert.match(decision.reason, /Git-Hooks/);
  assert.equal(classifyPath("x.pem", "write").rule, "pem-file");
});

test("glob patterns may not leave the workspace", () => {
  assert.throws(() => assertSafeGlobPattern("../**"), /\.\.-Segment/);
  assert.throws(() => assertSafeGlobPattern("../../**/*.txt"), /\.\.-Segment/);
  assert.throws(() => assertSafeGlobPattern("src/../../etc/*"), /\.\.-Segment/);
  assert.throws(() => assertSafeGlobPattern("/etc/*.conf"), /absolut/);
  assert.throws(() => assertSafeGlobPattern("~/**"), /~/);
  assert.throws(() => assertSafeGlobPattern("   "), /leer/);

  assert.doesNotThrow(() => assertSafeGlobPattern("**/*"));
  assert.doesNotThrow(() => assertSafeGlobPattern("src/**/*.ts"));
  assert.doesNotThrow(() => assertSafeGlobPattern("**/*..bak"));
});

test("path segments ignore separators and current-directory markers", () => {
  assert.deepEqual(pathSegments("./src//index.ts"), ["src", "index.ts"]);
  assert.deepEqual(pathSegments("."), []);
});
