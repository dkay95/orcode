import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUNDLE_IDENTIFIER = "dev.orcode.gui";
const PRODUCT_VERSION = "0.7.0";
const CONFIG_NAME = "orcode-desktop-signing.json";
const POLICY_ENV = "ORCODE_GUI_PACKAGED_TRUST_POLICY";
const SHA1 = /^[0-9A-F]{40}$/;
const TEAM = /^[A-Z0-9]{10}$/;

function fail() { throw new Error("signing-config-invalid"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function hashOpenedNoFollow(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("signing-verification-failed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (bytesRead === 0) throw new Error("signing-verification-failed");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}
async function defaultRun(tool, args) {
  try {
    const result = await execFileAsync(tool, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch { throw new Error("signing-tool-failed"); }
}
async function ownerOnlyFile(path) {
  const info = await lstat(path).catch(fail);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) fail();
}
async function ownerOnlyDirectory(path) {
  const info = await lstat(path).catch(fail);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail();
}
function canonicalConfigSuffix(path) {
  return path.endsWith(`${sep}Library${sep}Application Support${sep}Orcode${sep}private${sep}${CONFIG_NAME}`);
}

/** Closed package-signing boundary. The optional third argument is a test-only subprocess port. */
export async function withGuiPackageSigning(configPath, callback, ports = {}) {
  if (typeof configPath !== "string" || typeof callback !== "function") fail();
  const original = await lstat(configPath).catch(fail);
  if (original.isSymbolicLink()) fail();
  const canonical = await realpath(configPath).catch(fail);
  if (basename(canonical) !== CONFIG_NAME || !canonicalConfigSuffix(canonical)) fail();
  const parent = dirname(canonical);
  if (await realpath(parent).catch(fail) !== parent) fail();
  await ownerOnlyDirectory(parent);
  if (ports.run === undefined) {
    const production = await realpath(join(homedir(), "Library", "Application Support", "Orcode", "private", CONFIG_NAME)).catch(fail);
    if (canonical !== production) fail();
  }
  await ownerOnlyFile(canonical);
  let parsed; let source;
  try { source = await readFile(canonical, "utf8"); parsed = JSON.parse(source); } catch { fail(); }
  for (const key of ["schemaVersion", "certificateSha1", "teamIdentifier"]) {
    if ((source.match(new RegExp(`"${key}"\\s*:`, "g")) ?? []).length !== 1) fail();
  }
  exactObject(parsed, ["schemaVersion", "certificateSha1", "teamIdentifier"]);
  if (parsed.schemaVersion !== 1 || !SHA1.test(parsed.certificateSha1) || !TEAM.test(parsed.teamIdentifier)) fail();

  const certificateSha1 = parsed.certificateSha1;
  const teamIdentifier = parsed.teamIdentifier;
  const requirement = `identifier "${BUNDLE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
  const run = ports.run ?? defaultRun;
  const root = join(await realpath(process.cwd()), "gui", ".devhome", "package-policy");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const transient = await mkdtemp(join(root, `${randomBytes(8).toString("hex")}-`));
  await chmod(transient, 0o700);
  const requirementPath = join(transient, "requirement.txt");
  const rawBlobPath = join(transient, "requirement.raw");
  const blobPath = join(transient, "requirement.bin");
  const policyPath = join(transient, "policy.json");
  try {
    await writeFile(requirementPath, requirement, { mode: 0o600, flag: "wx" });
    await run("/usr/bin/csreq", ["-r", requirementPath, "-b", rawBlobPath]);
    await chmod(rawBlobPath, 0o600);
    await ownerOnlyFile(rawBlobPath);
    await rename(rawBlobPath, blobPath);
    await ownerOnlyFile(blobPath);
    const designatedRequirementSha256 = sha256(await readFile(blobPath));
    const safe = {
      schemaVersion: 1,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      productVersion: PRODUCT_VERSION,
      teamIdentifier,
      designatedRequirementSha256,
    };
    const policySha256 = sha256(JSON.stringify({
      bundleIdentifier: safe.bundleIdentifier,
      designatedRequirementSha256: safe.designatedRequirementSha256,
      productVersion: safe.productVersion,
      schemaVersion: safe.schemaVersion,
      teamIdentifier: safe.teamIdentifier,
    }));
    await writeFile(policyPath, JSON.stringify({ ...safe, policySha256 }), { mode: 0o600, flag: "wx" });
    const cargoEnv = Object.freeze({ [POLICY_ENV]: policyPath });
    const signAndVerifyAppDeepestFirst = async (appPath) => {
      if (typeof appPath !== "string" || !appPath.endsWith(".app")) throw new Error("signing-app-invalid");
      const app = await realpath(appPath).catch(() => { throw new Error("signing-app-invalid"); });
      const executable = join(app, "Contents", "MacOS", "orcode-gui");
      const native = await nativeFilesDeepestFirst(app);
      for (const path of native) await run("/usr/bin/codesign", ["--force", "--sign", certificateSha1, path]);
      await run("/usr/bin/codesign", ["--force", "--sign", certificateSha1, "--requirements", requirementPath, app]);
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
      const details = await run("/usr/bin/codesign", ["--display", "--verbose=4", app]);
      if (!`${details.stdout}\n${details.stderr}`.split(/\r?\n/).includes(`TeamIdentifier=${teamIdentifier}`)) throw new Error("signing-verification-failed");
      const requirementDetails = await run("/usr/bin/codesign", ["--display", "--requirements", "-", app]);
      const requirementLines = `${requirementDetails.stdout}\n${requirementDetails.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (requirementLines.length !== 1 || requirementLines[0] !== `designated => ${requirement}`) throw new Error("signing-verification-failed");
      const executableSha256 = await hashOpenedNoFollow(executable);
      return Object.freeze({ schemaVersion: 1, bundleIdentifier: BUNDLE_IDENTIFIER, productVersion: PRODUCT_VERSION,
        teamIdentifier, designatedRequirementSha256, policySha256, executableSha256,
        nestedSignedBeforeOuter: true, codesignDeepStrict: true });
    };
    return await callback(Object.freeze({ cargoEnv, signAndVerifyAppDeepestFirst }));
  } finally {
    await rm(transient, { recursive: true, force: true });
  }
}

async function nativeFilesDeepestFirst(root) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const handle = await open(child, "r");
        try {
          const bytes = Buffer.alloc(4); const { bytesRead } = await handle.read(bytes, 0, 4, 0);
          if (bytesRead === 4 && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0))) found.push(child);
        } finally { await handle.close(); }
      }
    }
  }
  await visit(root);
  return found.filter((path) => !path.endsWith(`${sep}Contents${sep}MacOS${sep}orcode-gui`))
    .sort((a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b));
}
