#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_PACKAGE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "scripts/check-package.mjs",
  "scripts/install-user.mjs",
];

export function expectedPackageFiles(sourceFiles) {
  const expected = new Set(STATIC_PACKAGE_FILES);
  for (const sourceFile of sourceFiles) {
    const normalized = normalizePackagePath(sourceFile);
    if (!normalized.startsWith("src/") || !normalized.endsWith(".ts")) {
      throw new Error(`Ungültiger TypeScript-Quellpfad für die Paket-Allowlist: ${sourceFile}`);
    }
    const outputStem = `dist/${normalized.slice("src/".length, -".ts".length)}`;
    expected.add(`${outputStem}.d.ts`);
    expected.add(`${outputStem}.js`);
    expected.add(`${outputStem}.js.map`);
  }
  return [...expected].sort();
}

export function assertExactPackageFiles(actualFiles, expectedFiles) {
  const actual = [...new Set(actualFiles.map(normalizePackagePath))].sort();
  const expected = [...new Set(expectedFiles.map(normalizePackagePath))].sort();
  const unexpected = actual.filter((path) => !expected.includes(path));
  const missing = expected.filter((path) => !actual.includes(path));
  if (unexpected.length === 0 && missing.length === 0) return;

  const details = [];
  if (unexpected.length > 0) details.push(`Unerwartet: ${unexpected.join(", ")}`);
  if (missing.length > 0) details.push(`Fehlt: ${missing.join(", ")}`);
  throw new Error(`Paket-Allowlist abgewichen. ${details.join(". ")}`);
}

export function packageShimPath(prefix, command, platform = process.platform) {
  return join(
    prefix,
    "node_modules",
    ".bin",
    `${command}${platform === "win32" ? ".cmd" : ""}`,
  );
}

export function isPackageCheckEntrypoint(
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

export async function checkPackage(options = {}) {
  const root = resolve(options.projectRoot ?? projectRoot);
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  const log = options.log ?? console.log;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orcode-package-check-"));
  const distDirectory = resolve(root, "dist");

  if (dirname(distDirectory) !== root) {
    throw new Error(`Unsicheres Build-Ziel abgelehnt: ${distDirectory}`);
  }

  try {
    await rm(distDirectory, { recursive: true, force: true });
    await runNpm(["run", "build"], { cwd: root, platform, run });

    const sourceFiles = (await listTypeScriptFiles(join(root, "src")))
      .map((path) => normalizePackagePath(relative(root, path)));
    const expectedFiles = expectedPackageFiles(sourceFiles);
    const packDirectory = join(temporaryRoot, "pack");
    await mkdir(packDirectory, { recursive: true });
    const packed = await runNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
      { cwd: root, platform, run },
    );
    const packResult = parsePackResult(packed.stdout);
    assertExactPackageFiles(
      packResult.files.map((file) => file.path),
      expectedFiles,
    );

    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assertManifest(manifest);
    const cliEntry = packResult.files.find((file) => file.path === "dist/cli.js");
    if (platform !== "win32" && (!cliEntry || (cliEntry.mode & 0o111) === 0)) {
      throw new Error("dist/cli.js ist im Tarball nicht ausführbar.");
    }

    if (basename(packResult.filename) !== packResult.filename) {
      throw new Error(`Unsicherer Tarball-Dateiname: ${packResult.filename}`);
    }
    const tarball = join(packDirectory, packResult.filename);
    await access(tarball);

    const installPrefix = join(temporaryRoot, "install");
    await mkdir(installPrefix, { recursive: true });
    await runNpm(
      [
        "install",
        "--prefix",
        installPrefix,
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: installPrefix, platform, run },
    );

    for (const command of ["orcode", "routercode"]) {
      const shim = packageShimPath(installPrefix, command, platform);
      await access(shim);
      const version = await run(shim, ["--version"], {
        cwd: installPrefix,
        shell: platform === "win32",
      });
      if (version.stdout.trim() !== `orcode ${manifest.version}`) {
        throw new Error(
          `${command} --version lieferte unerwartet: ${JSON.stringify(version.stdout.trim())}`,
        );
      }
      const help = await run(shim, ["--help"], {
        cwd: installPrefix,
        shell: platform === "win32",
      });
      if (!/Verwendung:\s*[\s\S]*orcode/.test(help.stdout) || !help.stdout.includes("--version")) {
        throw new Error(`${command} --help lieferte keine verwendbare CLI-Hilfe.`);
      }
    }

    log(
      `Paket ${manifest.name}@${manifest.version}: ${expectedFiles.length} Dateien, beide Bin-Shims geprüft.`,
    );
    return {
      files: expectedFiles,
      name: manifest.name,
      version: manifest.version,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizePackagePath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsicherer Paketpfad: ${path}`);
  }
  return normalized;
}

async function listTypeScriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found.sort();
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack lieferte kein JSON: ${errorMessage(error)}`);
  }
  const result = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  if (
    !result ||
    typeof result.filename !== "string" ||
    !Array.isArray(result.files) ||
    result.files.some(
      (file) =>
        !file ||
        typeof file.path !== "string" ||
        typeof file.mode !== "number",
    )
  ) {
    throw new Error("npm pack lieferte ein unerwartetes Ergebnisformat.");
  }
  return result;
}

function assertManifest(manifest) {
  if (
    !manifest ||
    manifest.name !== "orcode" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.bin?.orcode !== "./dist/cli.js" ||
    manifest.bin?.routercode !== "./dist/cli.js"
  ) {
    throw new Error("package.json enthält nicht die erwarteten orcode-Metadaten und Bin-Aliase.");
  }
}

async function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return options.run(process.execPath, [npmExecPath, ...args], {
      cwd: options.cwd,
      shell: false,
    });
  }
  return options.run(options.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: options.cwd,
    shell: options.platform === "win32",
  });
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (isPackageCheckEntrypoint(import.meta.url)) {
  await checkPackage();
}
