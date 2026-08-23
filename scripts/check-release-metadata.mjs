#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PACKAGE_BINS = {
  orcode: "./dist/cli.js",
  routercode: "./dist/cli.js",
};
const LOCKFILE_BINS = {
  orcode: "dist/cli.js",
  routercode: "dist/cli.js",
};

export function resolveReleaseTag(argv, environmentTag) {
  let argumentTag;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value;
    if (argument === "--tag") {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--tag benötigt einen Release-Tag.");
      }
      index += 1;
    } else if (argument.startsWith("--tag=")) {
      value = argument.slice("--tag=".length);
    } else {
      throw new Error(`Unbekanntes oder unerwartetes Argument: ${argument}`);
    }
    if (argumentTag !== undefined) {
      throw new Error("--tag darf nur einmal angegeben werden.");
    }
    argumentTag = value;
  }

  const environmentValue = nonEmptyString(environmentTag);
  if (argumentTag !== undefined && environmentValue && argumentTag !== environmentValue) {
    throw new Error("--tag und ORCODE_RELEASE_TAG widersprechen einander.");
  }
  const tag = nonEmptyString(argumentTag) ?? environmentValue;
  if (!tag) {
    throw new Error("Release-Tag fehlt: --tag oder ORCODE_RELEASE_TAG angeben.");
  }
  assertSafeReleaseTag(tag);
  return tag;
}

export function assertReleaseMetadata(input) {
  const manifest = requireRecord(input?.packageJson, "package.json");
  const lockfile = requireRecord(input?.packageLock, "package-lock.json");
  const changelog = typeof input?.changelog === "string" ? input.changelog : "";
  const tag = typeof input?.tag === "string" ? input.tag : "";
  const today = input?.today ?? utcDate(new Date());

  if (manifest.name !== "orcode") {
    throw new Error("package.json name muss exakt orcode sein.");
  }
  const version = requireStableVersion(manifest.version, "package.json version");
  assertExactBins(manifest.bin, PACKAGE_BINS, "package.json bin");

  if (lockfile.name !== "orcode") {
    throw new Error("package-lock.json name weicht von package.json ab.");
  }
  if (lockfile.version !== version) {
    throw new Error("package-lock.json version weicht von package.json ab.");
  }
  const lockPackages = requireRecord(lockfile.packages, "package-lock.json packages");
  const lockRoot = requireRecord(lockPackages[""], "package-lock.json root");
  if (lockRoot.name !== "orcode") {
    throw new Error("package-lock.json root name weicht von package.json ab.");
  }
  if (lockRoot.version !== version) {
    throw new Error("package-lock.json root version weicht von package.json ab.");
  }
  assertExactBins(lockRoot.bin, LOCKFILE_BINS, "package-lock.json root bin");

  if (!tag) {
    throw new Error("Release-Tag fehlt.");
  }
  assertSafeReleaseTag(tag);
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    const relation = compareVersions(tag.slice(1), version);
    if (relation > 0) {
      throw new Error(`Release-Tag ${tag} verweist auf eine zukünftige Version; erwartet ist ${expectedTag}.`);
    }
    throw new Error(`Release-Tag ${tag} ist veraltet oder weicht ab; erwartet ist ${expectedTag}.`);
  }

  assertReleaseChangelog(changelog, version, today);

  const expectedVersionOutput = `orcode ${version}`;
  if (String(input?.cliVersion ?? "").trim() !== expectedVersionOutput) {
    throw new Error(`Gebautes dist/cli.js --version muss exakt ${expectedVersionOutput} liefern.`);
  }
  const bannerHeadline = firstNonEmptyLine(input?.renderedBanner);
  if (bannerHeadline !== expectedVersionOutput) {
    throw new Error(`Gerenderter Banner muss mit ${expectedVersionOutput} beginnen.`);
  }
  const renderedHelpHeadline = firstNonEmptyLine(input?.renderedHelp);
  if (!renderedHelpHeadline.startsWith(`${expectedVersionOutput} `)) {
    throw new Error(`Gerenderte Hilfe muss ${expectedVersionOutput} ausweisen.`);
  }
  const cliHelpHeadline = firstNonEmptyLine(input?.cliHelp);
  if (!cliHelpHeadline.startsWith(`${expectedVersionOutput} `)) {
    throw new Error(`Gebautes dist/cli.js --help muss ${expectedVersionOutput} ausweisen.`);
  }
  if (String(input?.cliHelp ?? "").trim() !== String(input?.renderedHelp ?? "").trim()) {
    throw new Error("Gebautes dist/cli.js --help und renderCliHelp weichen voneinander ab.");
  }

  return { name: "orcode", version, tag };
}

export async function checkReleaseMetadata(options = {}) {
  const rootInput = options.projectRoot ?? scriptProjectRoot;
  if (typeof rootInput !== "string" || rootInput.includes("\0")) {
    throw new Error("Unsicherer Projektpfad wurde abgelehnt.");
  }
  const requestedRoot = resolve(rootInput);
  const fileSystem = options.fileSystem ?? { lstat, readFile, realpath };
  const run = options.runCommand ?? runCommand;
  const loadModule = options.importModule ?? ((url) => import(url));
  const log = options.log ?? console.log;
  const platform = options.platform ?? process.platform;

  let root;
  try {
    root = await fileSystem.realpath(requestedRoot);
  } catch (error) {
    throw new Error(`Projektpfad ist nicht lesbar: ${requestedRoot}. ${errorMessage(error)}`);
  }
  if (root === parse(root).root) {
    throw new Error(`Unsicherer Projektpfad wurde abgelehnt: ${root}`);
  }

  const cliPath = join(root, "dist", "cli.js");
  const builtCli = await captureBuiltCliSnapshot(fileSystem, cliPath, platform);

  const [packageText, lockText, changelog] = await Promise.all([
    readRequiredText(fileSystem, join(root, "package.json"), "package.json"),
    readRequiredText(fileSystem, join(root, "package-lock.json"), "package-lock.json"),
    readRequiredText(fileSystem, join(root, "CHANGELOG.md"), "CHANGELOG.md"),
  ]);
  const packageJson = parseJson(packageText, "package.json");
  const packageLock = parseJson(lockText, "package-lock.json");

  const versionResult = await run(process.execPath, [cliPath, "--version"], {
    cwd: root,
    shell: false,
  });
  await assertBuiltCliUnchanged(fileSystem, cliPath, platform, builtCli, "--version");
  const helpResult = await run(process.execPath, [cliPath, "--help"], {
    cwd: root,
    shell: false,
  });
  await assertBuiltCliUnchanged(fileSystem, cliPath, platform, builtCli, "--help");
  const moduleUrl = `${pathToFileURL(cliPath).href}?release-metadata=${Date.now()}`;
  const builtModule = await loadModule(moduleUrl);
  await assertBuiltCliUnchanged(fileSystem, cliPath, platform, builtCli, "Import");
  if (
    typeof builtModule?.renderCliBanner !== "function" ||
    typeof builtModule?.renderCliHelp !== "function"
  ) {
    throw new Error("Gebautes dist/cli.js exportiert renderCliBanner/renderCliHelp nicht.");
  }

  const result = assertReleaseMetadata({
    packageJson,
    packageLock,
    changelog,
    tag: options.tag,
    cliVersion: versionResult.stdout,
    cliHelp: helpResult.stdout,
    renderedBanner: builtModule.renderCliBanner(
      "/release-check/workspace",
      "release/check-model",
    ),
    renderedHelp: builtModule.renderCliHelp(),
    ...(options.today ? { today: options.today } : {}),
  });
  log(`Release-Metadaten ${result.name}@${result.version} stimmen mit ${result.tag} überein.`);
  return result;
}

export function isReleaseMetadataEntrypoint(
  moduleUrl,
  argvEntry = process.argv[1],
  resolvePath = resolve,
) {
  if (!argvEntry) return false;
  try {
    return pathToFileURL(resolvePath(argvEntry)).href === moduleUrl;
  } catch {
    return false;
  }
}

function assertSafeReleaseTag(tag) {
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(`Ungültiger oder unsicherer Release-Tag: ${JSON.stringify(tag)}.`);
  }
}

function requireStableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw new Error(`${label} ist keine kanonische stabile SemVer-Version.`);
  }
  return value;
}

function assertExactBins(value, expected, label) {
  const bins = requireRecord(value, label);
  const actualKeys = Object.keys(bins).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => bins[key] !== expected[key])
  ) {
    throw new Error(`${label} ist unsicher oder weicht von den beiden dist/cli.js-Aliasen ab.`);
  }
}

function assertReleaseChangelog(changelog, version, today) {
  const todayDate = canonicalDate(today, "Prüfdatum");
  const escapedVersion = version.replaceAll(".", "\\.");
  const header = new RegExp(`^## \\[${escapedVersion}\\] - (\\d{4}-\\d{2}-\\d{2})\\r?$`, "gm");
  const matches = [...changelog.matchAll(header)];
  if (matches.length === 0) {
    throw new Error(`CHANGELOG.md: freigegebener Header für ${version} fehlt.`);
  }
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md: Header für ${version} ist mehrfach vorhanden.`);
  }
  const releaseDate = canonicalDate(matches[0][1], "CHANGELOG.md Datum");
  if (releaseDate > todayDate) {
    throw new Error(`CHANGELOG.md Datum ${matches[0][1]} liegt in der Zukunft.`);
  }
}

function canonicalDate(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} ist ungültig.`);
  }
  const match = RELEASE_DATE.exec(value);
  if (!match) {
    throw new Error(`${label} ist ungültig.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} ist ungültig.`);
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function firstNonEmptyLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "";
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} fehlt oder ist malformed.`);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function samePath(left, right, platform) {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function captureBuiltCliSnapshot(fileSystem, cliPath, platform) {
  let beforePath;
  let beforeStat;
  try {
    [beforePath, beforeStat] = await Promise.all([
      fileSystem.realpath(cliPath),
      fileSystem.lstat(cliPath),
    ]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Build fehlt: ${cliPath} wurde nicht gefunden. Zuerst npm run build ausführen.`);
    }
    throw new Error(`Build ${cliPath} ist nicht sicher lesbar: ${errorMessage(error)}`);
  }
  assertSafeBuiltCli(beforePath, beforeStat, cliPath, platform);

  let contents;
  try {
    contents = await fileSystem.readFile(cliPath);
  } catch (error) {
    throw new Error(`Build ${cliPath} konnte nicht gehasht werden: ${errorMessage(error)}`);
  }
  if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
    throw new Error(`Build ${cliPath} lieferte keine hashbaren Bytes.`);
  }

  const [afterPath, afterStat] = await Promise.all([
    fileSystem.realpath(cliPath),
    fileSystem.lstat(cliPath),
  ]);
  assertSafeBuiltCli(afterPath, afterStat, cliPath, platform);
  const beforeIdentity = builtFileIdentity(beforeStat);
  const afterIdentity = builtFileIdentity(afterStat);
  if (beforeIdentity !== afterIdentity) {
    throw new Error(`Build ${cliPath} wurde während der Identitätsprüfung geändert.`);
  }
  return {
    identity: afterIdentity,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function assertBuiltCliUnchanged(fileSystem, cliPath, platform, expected, consumer) {
  const actual = await captureBuiltCliSnapshot(fileSystem, cliPath, platform);
  if (actual.identity !== expected.identity || actual.sha256 !== expected.sha256) {
    throw new Error(
      `Build ${cliPath} wurde nach ${consumer} geändert; Identität oder SHA-256 weicht ab.`,
    );
  }
}

function assertSafeBuiltCli(realCliPath, cliStat, cliPath, platform) {
  if (
    !samePath(realCliPath, cliPath, platform) ||
    cliStat.isSymbolicLink() ||
    !cliStat.isFile()
  ) {
    throw new Error(`Unsicherer Build-Pfad abgelehnt: ${cliPath} muss eine reguläre Datei im Projekt sein.`);
  }
}

function builtFileIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].map((value) => String(value)).join(":");
}

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

async function readRequiredText(fileSystem, path, label) {
  try {
    return await fileSystem.readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} fehlt oder ist nicht lesbar: ${errorMessage(error)}`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ist malformed: ${errorMessage(error)}`);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      shell: options.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} fehlgeschlagen (${signal ?? code}).\n${stderr || stdout}`,
        ),
      );
    });
  });
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (isReleaseMetadataEntrypoint(import.meta.url)) {
  try {
    const tag = resolveReleaseTag(process.argv.slice(2), process.env.ORCODE_RELEASE_TAG);
    await checkReleaseMetadata({ tag });
  } catch (error) {
    console.error(`Release-Metadatenprüfung fehlgeschlagen: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
