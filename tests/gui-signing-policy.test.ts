import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// @ts-expect-error The production signing boundary is intentionally a plain Node ESM script.
import { withGuiPackageSigning } from "../scripts/gui-signing-policy.mjs";

type SigningSession = Readonly<{
  cargoEnv: Readonly<Record<string, string>>;
  signAndVerifyAppDeepestFirst(appPath: string): Promise<Record<string, unknown>>;
}>;

async function fixture(value: unknown): Promise<string> {
  const home = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "orcode-signing-")));
  const parent = join(home, "Library", "Application Support", "Orcode", "private");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, "orcode-desktop-signing.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test("signing config is closed and rejects requirement or TeamIdentifier injection before subprocess", async () => {
  const base = { schemaVersion: 1, certificateSha1: "A".repeat(40), teamIdentifier: "ABCDE12345" };
  for (const value of [
    { ...base, designatedRequirement: 'identifier "dev.orcode.gui" or true' },
    ...["SHORT", "lowercase1", 'AAAAA\"ORX', "AAAAA\nBBBB", "AAAAA BBBB", "AAAAAAAAAAA"]
      .map((teamIdentifier) => ({ ...base, teamIdentifier })),
  ]) {
    await assert.rejects(withGuiPackageSigning(await fixture(value), async () => undefined, {
      async run() { throw new Error("subprocess-must-not-run"); },
    }), /signing-config-invalid/);
  }
});

test("signing config rejects the original symlink and non-owner-only parent", async () => {
  const config = await fixture({ schemaVersion: 1, certificateSha1: "A".repeat(40), teamIdentifier: "ABCDE12345" });
  const link = `${config}.link`;
  await symlink(config, link);
  await assert.rejects(withGuiPackageSigning(link, async () => undefined, { async run() { return { stdout: "", stderr: "" }; } }), /signing-config-invalid/);
  await chmod(dirname(config), 0o755);
  await assert.rejects(withGuiPackageSigning(config, async () => undefined, { async run() { return { stdout: "", stderr: "" }; } }), /signing-config-invalid/);
});

test("real csreq output is atomically normalized to owner-only mode", { skip: process.platform !== "darwin" }, async () => {
  const config = await fixture({ schemaVersion: 1, certificateSha1: "A".repeat(40), teamIdentifier: "ABCDE12345" });
  const runReal = promisify(execFile);
  await withGuiPackageSigning(config, async (session: SigningSession) => {
    const policyPath = session.cargoEnv.ORCODE_GUI_PACKAGED_TRUST_POLICY!;
    const blob = join(dirname(policyPath), "requirement.bin");
    assert.equal((await lstat(blob)).mode & 0o777, 0o600);
  }, {
    async run(tool: string, args: readonly string[]) {
      const result = await runReal(tool, [...args], { encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  });
});

test("signing session exposes only safe cargo environment and never identity material", async () => {
  const config = await fixture({
    schemaVersion: 1,
    certificateSha1: "B".repeat(40),
    teamIdentifier: "ABCDE12345",
  });
  await withGuiPackageSigning(config, async (session: SigningSession) => {
    assert.deepEqual(Object.keys(session).sort(), ["cargoEnv", "signAndVerifyAppDeepestFirst"]);
    assert.deepEqual(Object.keys(session.cargoEnv), ["ORCODE_GUI_PACKAGED_TRUST_POLICY"]);
    assert.doesNotMatch(JSON.stringify(session), /BBBBBBBB|certificateSha1|orcode-desktop-signing\.json/);
  }, {
    async run(tool: string, args: readonly string[]) {
      if (tool.endsWith("csreq")) {
        const target = args[args.indexOf("-b") + 1]!;
        await writeFile(target, Buffer.from("compiled-requirement"), { mode: 0o600 });
      }
      if (tool.endsWith("codesign") && args.includes("--verbose=4")) return { stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" };
      if (tool.endsWith("codesign") && args.includes("--requirements")) return { stdout: "", stderr: 'designated => identifier "dev.orcode.gui" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"\n' };
      return { stdout: "", stderr: "" };
    },
  });
});

test("package signing orders nested native code before the outer app and returns safe evidence only", async () => {
  const config = await fixture({ schemaVersion: 1, certificateSha1: "C".repeat(40), teamIdentifier: "ABCDE12345" });
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "orcode-app-")));
  const app = join(root, "Orcode.app"); const macos = join(app, "Contents", "MacOS"); const nested = join(app, "Contents", "Frameworks", "Nested.framework");
  await mkdir(macos, { recursive: true }); await mkdir(nested, { recursive: true });
  const macho = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 1, 2, 3, 4]);
  await writeFile(join(macos, "orcode-gui"), macho); await writeFile(join(nested, "Nested"), macho);
  await writeFile(join(nested, "Universal64"), Buffer.from([0xca, 0xfe, 0xba, 0xbf, 1, 2, 3, 4]));
  const finallySigned = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 9, 8, 7, 6]);
  const calls: string[][] = [];
  const evidence = await withGuiPackageSigning(config, (session: SigningSession) => session.signAndVerifyAppDeepestFirst(app), {
    async run(tool: string, args: readonly string[]) {
      calls.push([tool, ...args]);
      if (tool.endsWith("csreq")) await writeFile(args[args.indexOf("-b") + 1]!, Buffer.from("compiled-requirement"), { mode: 0o600 });
      if (tool.endsWith("codesign") && args.includes("--sign") && args.at(-1)?.endsWith("/Orcode.app")) await writeFile(join(macos, "orcode-gui"), finallySigned);
      if (args.includes("--verbose=4")) return { stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" };
      if (args.includes("--requirements") && args.includes("--display")) return { stdout: "", stderr: 'designated => identifier "dev.orcode.gui" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"\n' };
      return { stdout: "", stderr: "" };
    },
  });
  const signCalls = calls.filter((call) => call[0]!.endsWith("codesign") && call.includes("--sign"));
  assert.match(signCalls[0]!.at(-1)!, /\/Contents\/Frameworks\/Nested\.framework\/Nested$/); assert.match(signCalls.at(-1)!.at(-1)!, /\/Orcode\.app$/);
  assert.equal(signCalls.some((call) => call.at(-1)?.endsWith("/Universal64")), true);
  assert.equal(evidence.codesignDeepStrict, true);
  assert.equal(evidence.executableSha256, createHash("sha256").update(finallySigned).digest("hex"));
  assert.deepEqual(Object.keys(evidence).sort(), ["bundleIdentifier", "codesignDeepStrict", "designatedRequirementSha256", "executableSha256", "nestedSignedBeforeOuter", "policySha256", "productVersion", "schemaVersion", "teamIdentifier"].sort());
  assert.doesNotMatch(JSON.stringify(evidence), /CCCCCCCC|certificateSha1|identity|@/i);
});

test("actual designated requirement comparison rejects an appended permissive clause", async () => {
  const config = await fixture({ schemaVersion: 1, certificateSha1: "D".repeat(40), teamIdentifier: "ABCDE12345" });
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "orcode-hostile-requirement-")));
  const app = join(root, "Orcode.app"); const macos = join(app, "Contents", "MacOS");
  await mkdir(macos, { recursive: true });
  await writeFile(join(macos, "orcode-gui"), Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 1, 2, 3, 4]));
  await assert.rejects(withGuiPackageSigning(config, (session: SigningSession) => session.signAndVerifyAppDeepestFirst(app), {
    async run(tool: string, args: readonly string[]) {
      if (tool.endsWith("csreq")) await writeFile(args[args.indexOf("-b") + 1]!, Buffer.from("compiled-requirement"), { mode: 0o600 });
      if (args.includes("--verbose=4")) return { stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" };
      if (args.includes("--requirements") && args.includes("--display")) return { stdout: "", stderr: 'designated => identifier "dev.orcode.gui" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" or true\n' };
      return { stdout: "", stderr: "" };
    },
  }), /signing-verification-failed/);
});
