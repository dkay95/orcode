#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_PACKAGE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "assets/route-core.svg",
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

export function packagePackArguments(packDirectory, dryRun) {
  return [
    "pack",
    ...(dryRun ? ["--dry-run"] : []),
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDirectory,
  ];
}

export function packageInstallArguments(prefix, tarball, runScripts) {
  return [
    "install",
    "--prefix",
    prefix,
    "--no-save",
    `--ignore-scripts=${runScripts ? "false" : "true"}`,
    "--no-audit",
    "--no-fund",
    tarball,
  ];
}

export function assertSafePackageText(path, content, options) {
  const normalizedPath = normalizePackagePath(path);
  const categories = new Set(
    options.scanForSecrets(content).map((finding) =>
      String(finding.category ?? finding.kind ?? "unbekanntes Secret"),
    ),
  );
  const checkoutRoot = resolve(options.checkoutRoot);
  const normalizedCheckoutRoot = checkoutRoot.replaceAll("\\", "/");
  const normalizedContent = content.replaceAll("\\", "/");
  const collapsedCheckoutRoot = normalizedCheckoutRoot.replace(/\/{2,}/g, "/");
  const collapsedContent = normalizedContent.replace(/\/{2,}/g, "/");
  if (
    collapsedCheckoutRoot !== "/" &&
    collapsedContent.includes(collapsedCheckoutRoot)
  ) {
    categories.add("privater Checkout-Pfad");
  }
  if (
    /\/(?:Users|home)\/[^/\s"'<>]+(?:$|[\/\s"'<>?#])/i.test(collapsedContent)
  ) {
    categories.add("privater Home-Pfad");
  }
  if (categories.size > 0) {
    throw new Error(
      `${normalizedPath} enthält nicht veröffentlichbare Daten: ${[...categories].join(", ")}.`,
    );
  }
}

export function assertMatchingPackResults(dryRun, real) {
  const drySignature = packResultSignature(dryRun);
  const realSignature = packResultSignature(real);
  if (JSON.stringify(drySignature) !== JSON.stringify(realSignature)) {
    throw new Error(
      "npm pack dry-run und reales Tarball weichen in Inhalt, Integrity, Größe oder Dateimetadaten ab.",
    );
  }
}

export function assertTarballIntegrity(content, integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("npm pack lieferte keine unterstützte sha512-Integrity.");
  }
  const expected = integrity.slice("sha512-".length);
  const actual = createHash("sha512").update(content).digest("base64");
  if (actual !== expected) {
    throw new Error("Tarball-Hash stimmt nicht mit der npm-pack-Integrity überein.");
  }
}

export function packageShimPath(prefix, command, platform = process.platform) {
  return join(
    prefix,
    "node_modules",
    ".bin",
    `${command}${platform === "win32" ? ".cmd" : ""}`,
  );
}

export function resolvePackageOutputDirectory(argv, projectRoot) {
  if (argv.length === 0) return undefined;
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--output") {
      throw new Error(`Unbekanntes Paketprüfungsargument: ${argument}`);
    }
    if (value !== undefined) {
      throw new Error("--output darf nur einmal angegeben werden.");
    }
    value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--output benötigt ein Ausgabeverzeichnis.");
    }
    index += 1;
  }
  if (value.includes("\0")) {
    throw new Error("Unsicheres --output-Ausgabeverzeichnis.");
  }
  const root = resolve(projectRoot);
  const output = resolve(root, value);
  const relation = relative(root, output);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relation)
  ) {
    throw new Error("--output muss ein neues Verzeichnis innerhalb des Projekts sein.");
  }
  return output;
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
  const outputDirectory = options.outputDirectory === undefined
    ? undefined
    : resolvePackageOutputDirectory(["--output", options.outputDirectory], root);
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  const log = options.log ?? console.log;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "orcode-package-check-"));
  const distDirectory = resolve(root, "dist");
  const isolatedHome = join(temporaryRoot, "home");
  const childEnvironment = sanitizedPackageEnvironment(
    options.environment ?? process.env,
    isolatedHome,
  );

  if (dirname(distDirectory) !== root) {
    throw new Error(`Unsicheres Build-Ziel abgelehnt: ${distDirectory}`);
  }

  try {
    await mkdir(isolatedHome, { recursive: true });
    await rm(distDirectory, { recursive: true, force: true });
    await runNpm(["run", "build"], {
      cwd: root,
      platform,
      run,
      environment: childEnvironment,
    });

    const sourceFiles = (await listTypeScriptFiles(join(root, "src")))
      .map((path) => normalizePackagePath(relative(root, path)));
    const expectedFiles = expectedPackageFiles(sourceFiles);
    const packDirectory = join(temporaryRoot, "pack");
    await mkdir(packDirectory, { recursive: true });
    const dryPacked = await runNpm(
      packagePackArguments(packDirectory, true),
      { cwd: root, platform, run, environment: childEnvironment },
    );
    const dryPackResult = parsePackResult(dryPacked.stdout);
    assertExactPackageFiles(
      dryPackResult.files.map((file) => file.path),
      expectedFiles,
    );

    const { scanForSecrets } = await import(
      `${pathToFileURL(join(distDirectory, "redaction.js")).href}?package-check=${Date.now()}`
    );
    for (const file of dryPackResult.files) {
      const packagePath = normalizePackagePath(file.path);
      const content = await readFile(join(root, packagePath), "utf8");
      assertSafePackageText(packagePath, content, {
        checkoutRoot: root,
        scanForSecrets,
      });
    }

    const packed = await runNpm(packagePackArguments(packDirectory, false), {
      cwd: root,
      platform,
      run,
      environment: childEnvironment,
    });
    const packResult = parsePackResult(packed.stdout);
    const dryFiles = dryPackResult.files.map((file) => file.path);
    const realFiles = packResult.files.map((file) => file.path);
    assertExactPackageFiles(realFiles, expectedFiles);
    assertExactPackageFiles(realFiles, dryFiles);
    assertExactPackageFiles(dryFiles, realFiles);
    assertMatchingPackResults(dryPackResult, packResult);

    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assertPackageManifest(manifest);
    const cliEntry = packResult.files.find((file) => file.path === "dist/cli.js");
    if (platform !== "win32" && (!cliEntry || (cliEntry.mode & 0o111) === 0)) {
      throw new Error("dist/cli.js ist im Tarball nicht ausführbar.");
    }

    if (basename(packResult.filename) !== packResult.filename) {
      throw new Error(`Unsicherer Tarball-Dateiname: ${packResult.filename}`);
    }
    const tarball = join(packDirectory, packResult.filename);
    await access(tarball);
    assertTarballIntegrity(await readFile(tarball), packResult.integrity);

    const auditPrefix = join(temporaryRoot, "audit-install");
    await mkdir(auditPrefix, { recursive: true });
    await runNpm(
      packageInstallArguments(auditPrefix, tarball, false),
      {
        cwd: auditPrefix,
        platform,
        run,
        environment: childEnvironment,
      },
    );
    assertTarballIntegrity(await readFile(tarball), packResult.integrity);
    await scanInstalledPackage(
      join(auditPrefix, "node_modules", manifest.name),
      expectedFiles,
      root,
      scanForSecrets,
    );

    const installPrefix = join(temporaryRoot, "install");
    await mkdir(installPrefix, { recursive: true });
    await runNpm(
      packageInstallArguments(installPrefix, tarball, true),
      {
        cwd: installPrefix,
        platform,
        run,
        environment: childEnvironment,
      },
    );
    assertTarballIntegrity(await readFile(tarball), packResult.integrity);

    for (const command of ["orcode", "routercode"]) {
      const shim = packageShimPath(installPrefix, command, platform);
      await access(shim);
      const version = await run(shim, ["--version"], {
        cwd: installPrefix,
        shell: platform === "win32",
        environment: childEnvironment,
      });
      if (version.stdout.trim() !== `orcode ${manifest.version}`) {
        throw new Error(
          `${command} --version lieferte unerwartet: ${JSON.stringify(version.stdout.trim())}`,
        );
      }
      const help = await run(shim, ["--help"], {
        cwd: installPrefix,
        shell: platform === "win32",
        environment: childEnvironment,
      });
      if (!/Verwendung:\s*[\s\S]*orcode/.test(help.stdout) || !help.stdout.includes("--version")) {
        throw new Error(`${command} --help lieferte keine verwendbare CLI-Hilfe.`);
      }
    }

    let artifact;
    if (outputDirectory) {
      await mkdir(outputDirectory, { mode: 0o700 });
      const copiedTarball = join(outputDirectory, packResult.filename);
      await copyFile(tarball, copiedTarball);
      const copiedBytes = await readFile(copiedTarball);
      assertTarballIntegrity(copiedBytes, packResult.integrity);
      const sha512 = createHash("sha512").update(copiedBytes).digest("hex");
      const checksumFile = `${packResult.filename}.sha512`;
      await writeFile(
        join(outputDirectory, checksumFile),
        `${sha512}  ${packResult.filename}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await writeFile(
        join(outputDirectory, "release-manifest.json"),
        `${JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          bin: manifest.bin,
          filename: packResult.filename,
          integrity: packResult.integrity,
          sha512,
          size: copiedBytes.byteLength,
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      artifact = copiedTarball;
    }

    log(
      `Paket ${manifest.name}@${manifest.version}: ${expectedFiles.length} Dateien, beide Bin-Shims geprüft.`,
    );
    return {
      files: expectedFiles,
      name: manifest.name,
      version: manifest.version,
      ...(artifact ? { artifact } : {}),
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
    typeof result.integrity !== "string" ||
    typeof result.shasum !== "string" ||
    typeof result.size !== "number" ||
    typeof result.unpackedSize !== "number" ||
    typeof result.entryCount !== "number" ||
    !Array.isArray(result.files) ||
    result.files.some(
      (file) =>
        !file ||
        typeof file.path !== "string" ||
        typeof file.size !== "number" ||
        typeof file.mode !== "number",
    )
  ) {
    throw new Error("npm pack lieferte ein unerwartetes Ergebnisformat.");
  }
  return result;
}

function packResultSignature(result) {
  if (
    !result ||
    typeof result.filename !== "string" ||
    typeof result.integrity !== "string" ||
    typeof result.shasum !== "string" ||
    typeof result.size !== "number" ||
    typeof result.unpackedSize !== "number" ||
    typeof result.entryCount !== "number" ||
    !Array.isArray(result.files)
  ) {
    throw new Error("npm pack dry-run/real lieferte unvollständige Metadaten.");
  }
  return {
    filename: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
    size: result.size,
    unpackedSize: result.unpackedSize,
    entryCount: result.entryCount,
    files: result.files
      .map((file) => ({
        path: normalizePackagePath(file.path),
        size: file.size,
        mode: file.mode,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function scanInstalledPackage(packageDirectory, expectedFiles, checkoutRoot, scanForSecrets) {
  const canonicalPackageDirectory = await realpath(packageDirectory);
  for (const packagePath of expectedFiles) {
    const candidate = join(canonicalPackageDirectory, packagePath);
    const [info, canonicalCandidate] = await Promise.all([
      lstat(candidate),
      realpath(candidate),
    ]);
    const inside = relative(canonicalPackageDirectory, canonicalCandidate);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      inside === "" ||
      inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      inside === ".." ||
      isAbsolute(inside)
    ) {
      throw new Error(`Unsicherer installierter Paketpfad: ${packagePath}`);
    }
    assertSafePackageText(
      packagePath,
      await readFile(canonicalCandidate, "utf8"),
      { checkoutRoot, scanForSecrets },
    );
  }
}

export function assertPackageManifest(manifest) {
  if (
    !manifest ||
    manifest.name !== "orcode" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== "git+https://github.com/dkay95/orcode.git" ||
    manifest.bin?.orcode !== "./dist/cli.js" ||
    manifest.bin?.routercode !== "./dist/cli.js"
  ) {
    throw new Error("package.json enthält nicht die erwarteten orcode-Repository-, Versions- und Bin-Metadaten.");
  }
}

async function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return options.run(process.execPath, [npmExecPath, ...args], {
      cwd: options.cwd,
      shell: false,
      environment: options.environment,
    });
  }
  return options.run(options.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: options.cwd,
    shell: options.platform === "win32",
    environment: options.environment,
  });
}

export function sanitizedPackageEnvironment(environment, isolatedHome) {
  const sanitized = {};
  const portableNames = new Set([
    "CI",
    "COMSPEC",
    "ComSpec",
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
    "LANG",
    "NO_COLOR",
    "OS",
    "PATH",
    "Path",
    "PATHEXT",
    "RUNNER_OS",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "WINDIR",
    "windir",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (portableNames.has(name) || name.startsWith("LC_"))
    ) {
      sanitized[name] = value;
    }
  }
  const npmCache = join(isolatedHome, ".npm-cache");
  const npmUserConfig = join(isolatedHome, ".npmrc");
  const npmGlobalConfig = join(isolatedHome, ".npm-globalrc");
  return {
    ...sanitized,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, ".appdata", "roaming"),
    LOCALAPPDATA: join(isolatedHome, ".appdata", "local"),
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    XDG_STATE_HOME: join(isolatedHome, ".local", "state"),
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    npm_config_globalconfig: npmGlobalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
    NO_COLOR: "1",
  };
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment ?? { ...process.env, NO_COLOR: "1" },
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
  const outputDirectory = resolvePackageOutputDirectory(
    process.argv.slice(2),
    projectRoot,
  );
  await checkPackage({ outputDirectory });
}
