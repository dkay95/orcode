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

test("protected directory rules match case-insensitively (APFS/NTFS resolve the case away)", () => {
  // On case-insensitive filesystems (macOS APFS, Windows NTFS) the spelling
  // ".GIT/hooks/x" resolves to the real ".git/hooks/x" on disk. The policy
  // must judge what the filesystem will do, not the exact spelling.
  assert.equal(classifyPath(".GIT/hooks/pre-commit", "write").verdict, "deny");
  assert.equal(classifyPath(".Git/Hooks/pre-push", "write").verdict, "deny");
  assert.equal(classifyPath(".GIT/config", "write").verdict, "approve");
  assert.equal(classifyPath("NODE_MODULES/pkg/index.js", "write").verdict, "approve");
  assert.equal(classifyPath(".GITHUB/WORKFLOWS/ci.yml", "write").verdict, "approve");

  assert.equal(classifyPath(".SSH/id_rsa", "read").verdict, "approve");
  assert.equal(classifyPath(".AWS/credentials", "read").verdict, "approve");
});

test("npm and netrc credential files are guarded on read and write", () => {
  // Like .env: reading leaks tokens into the prompt, writing could inject
  // tokens or redirect registries/logins — both need an explicit yes.
  for (const name of [".npmrc", ".netrc", "_netrc"]) {
    assert.equal(classifyPath(name, "read").verdict, "approve", `${name} read`);
    assert.equal(classifyPath(name, "write").verdict, "approve", `${name} write`);
    assert.equal(classifyPath(`config/${name}`, "read").verdict, "approve", `nested ${name} read`);
  }
  assert.equal(classifyPath("npmrc.json", "read").verdict, "allow");
});

test("key stores and cloud/cluster credential locations are guarded", () => {
  // Name rules: secret on read, protected on write — like .env/.pem.
  for (const name of [".git-credentials", "server.key", "store.p12", "cert.pfx", "app.keystore", "keys.jks"]) {
    assert.equal(classifyPath(name, "read").verdict, "approve", `${name} read`);
    assert.equal(classifyPath(name, "write").verdict, "approve", `${name} write`);
  }
  // Directory rules: secret on read only — like .aws.
  for (const path of [".gnupg/secring.gpg", ".kube/config", ".docker/config.json"]) {
    assert.equal(classifyPath(path, "read").verdict, "approve", `${path} read`);
    assert.equal(classifyPath(path, "write").verdict, "allow", `${path} write`);
  }
  // Near-misses must stay allowed.
  assert.equal(classifyPath("src/keyStore.ts", "read").verdict, "allow");
  assert.equal(classifyPath("docs/keyboard.md", "read").verdict, "allow");
  assert.equal(classifyPath("docker-compose.yml", "read").verdict, "allow");
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
