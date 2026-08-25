import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isEntrypoint } from "../src/cli.js";

const MODULE_URL = pathToFileURL("/opt/routercode/dist/cli.js").href;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

interface InstallerFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

interface InstallerModule {
  installUserAliases(options: {
    projectRoot: string;
    homeDirectory: string;
    fileSystem: InstallerFileSystem;
    log(message: string): void;
  }): Promise<void>;
}

interface PackageCheckModule {
  assertPackageManifest(manifest: unknown): void;
  assertExactPackageFiles(actual: string[], expected: string[]): void;
  assertMatchingPackResults(left: unknown, right: unknown): void;
  assertSafePackageText(
    path: string,
    text: string,
    options: {
      checkoutRoot: string;
      scanForSecrets(value: string): readonly { category: string }[];
    },
  ): void;
  assertTarballIntegrity(content: Buffer, integrity: string): void;
  expectedPackageFiles(sourceFiles: string[]): string[];
  packageInstallArguments(prefix: string, tarball: string, runScripts: boolean): string[];
  packagePackArguments(packDirectory: string, dryRun: boolean): string[];
  packageShimPath(prefix: string, command: string, platform: NodeJS.Platform): string;
  resolvePackageOutputDirectory(argv: string[], projectRoot: string): string | undefined;
  sanitizedPackageEnvironment(
    environment: NodeJS.ProcessEnv,
    isolatedHome: string,
  ): NodeJS.ProcessEnv;
}

type FakePath = { kind: "file" } | { kind: "symlink"; target: string };

function installerFileSystem(
  initial: Map<string, FakePath>,
  options: {
    onSymlink?(target: string, path: string, paths: Map<string, FakePath>): void;
  } = {},
): {
  fileSystem: InstallerFileSystem;
  paths: Map<string, FakePath>;
  events: string[];
  mutations: string[];
} {
  const paths = new Map(initial);
  const events: string[] = [];
  const mutations: string[] = [];
  const missing = (): Error & { code: string } =>
    Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    paths,
    events,
    mutations,
    fileSystem: {
      async lstat(path) {
        events.push(`lstat:${path}`);
        const entry = paths.get(path);
        if (!entry) throw missing();
        return { isSymbolicLink: () => entry.kind === "symlink" };
      },
      async readlink(path) {
        events.push(`readlink:${path}`);
        const entry = paths.get(path);
        if (!entry || entry.kind !== "symlink") throw missing();
        return entry.target;
      },
      async mkdir(path) {
        events.push(`mkdir:${path}`);
        mutations.push(`mkdir:${path}`);
      },
      async chmod(path) {
        events.push(`chmod:${path}`);
        mutations.push(`chmod:${path}`);
      },
      async symlink(target, path) {
        events.push(`symlink:${path}`);
        mutations.push(`symlink:${path}`);
        options.onSymlink?.(target, path, paths);
        if (paths.has(path)) {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        paths.set(path, { kind: "symlink", target });
      },
      async unlink(path) {
        events.push(`unlink:${path}`);
        mutations.push(`unlink:${path}`);
        if (!paths.delete(path)) throw missing();
      },
    },
  };
}

async function loadInstaller(): Promise<InstallerModule> {
  const modulePath = "../scripts/install-user.mjs";
  return import(modulePath) as Promise<InstallerModule>;
}

async function loadPackageCheck(): Promise<PackageCheckModule> {
  const modulePath = "../scripts/check-package.mjs";
  return import(modulePath) as Promise<PackageCheckModule>;
}

test("a direct invocation is recognised as the entrypoint", () => {
  assert.equal(isEntrypoint(MODULE_URL, "/opt/routercode/dist/cli.js"), true);
});

test("a symlinked bin is recognised as the entrypoint", () => {
  // `~/.local/bin/routercode` is a symlink to `dist/cli.js`. Node resolves the
  // module URL through the link but leaves argv[1] on the link itself, so the
  // naive comparison fails and main() never runs — the CLI just exits silently.
  const resolve = (path: string): string =>
    path === "/home/u/.local/bin/routercode"
      ? "/opt/routercode/dist/cli.js"
      : path;
  assert.equal(
    isEntrypoint(MODULE_URL, "/home/u/.local/bin/routercode", resolve),
    true,
  );
});

test("an unrelated entrypoint is not mistaken for this module", () => {
  // A test importing pure helpers from cli.ts must not start the dashboard.
  assert.equal(isEntrypoint(MODULE_URL, "/opt/other/tool.js", (p) => p), false);
});

test("a missing argv[1] is not an entrypoint", () => {
  assert.equal(isEntrypoint(MODULE_URL, undefined), false);
});

test("an unresolvable argv[1] does not throw", () => {
  const resolve = (): string => {
    throw new Error("ENOENT");
  };
  assert.doesNotThrow(() => isEntrypoint(MODULE_URL, "/nope", resolve));
});

test("the real --help entrypoint exits before app-home, key, provider, or model startup", async () => {
  const isolatedHome = await mkdtemp(join(tmpdir(), "orcode-help-bootstrap-"));
  try {
    const cliPath = join(PROJECT_ROOT, "src", "cli.ts");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "--help"],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          OPENROUTER_API_KEY: "synthetic-help-must-not-be-read",
        },
      },
    );
    assert.match(stdout, /Usage|Verwendung|Optionen/i);
    assert.equal(stderr, "");
    await assert.rejects(
      readFile(join(isolatedHome, ".orcode", "config.json")),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

test("release metadata packages both CLI names at version 0.7.0", async () => {
  const packageJson = JSON.parse(
    await readFile(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  };
  const packageLock = JSON.parse(
    await readFile(join(PROJECT_ROOT, "package-lock.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string; bin?: Record<string, string> }>;
  };
  const changelog = await readFile(join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");

  const bins = {
    orcode: "./dist/cli.js",
    routercode: "./dist/cli.js",
  };
  assert.equal(packageJson.name, "orcode");
  assert.equal(packageJson.version, "0.7.0");
  assert.deepEqual(packageJson.bin, bins);
  assert.equal(packageJson.scripts["install:user"], "node scripts/install-user.mjs");
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.ok(packageJson.files.includes("scripts/install-user.mjs"));
  assert.ok(packageJson.files.includes("scripts/check-package.mjs"));
  assert.equal(packageLock.name, "orcode");
  assert.equal(packageLock.version, "0.7.0");
  assert.equal(packageLock.packages[""]?.name, "orcode");
  assert.equal(packageLock.packages[""]?.version, "0.7.0");
  assert.deepEqual(packageLock.packages[""]?.bin, {
    orcode: "dist/cli.js",
    routercode: "dist/cli.js",
  });
  assert.match(changelog, /^## \[0\.7\.0\] - \d{4}-\d{2}-\d{2}$/m);
});

test("release scripts expose bounded package, metadata, migration, regression, and PTY gates", async () => {
  const manifest = JSON.parse(
    await readFile(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  assert.equal(manifest.scripts["check:package"], "node scripts/check-package.mjs");
  assert.equal(
    manifest.scripts["check:release"],
    "node scripts/check-release-metadata.mjs",
  );
  assert.match(manifest.scripts["test:migration"] ?? "", /app-home-migration\.test\.ts/);
  assert.match(manifest.scripts["test:migration"] ?? "", /private-store\.test\.ts/);
  assert.match(manifest.scripts["test:release-regressions"] ?? "", /cli\.test\.ts/);
  assert.match(manifest.scripts["test:release-regressions"] ?? "", /tui\.test\.ts/);
  assert.equal(manifest.scripts["test:pty"], "node scripts/check-pty.mjs");
  assert.equal(
    manifest.scripts.prepublishOnly,
    "npm run check && npm run check:package",
  );
  assert.doesNotMatch(manifest.scripts.prepublishOnly, /publish|check:release/i);
});

test("importing the user installer is side-effect free and exposes injected seams", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "orcode-installer-import-"));
  const installerUrl = pathToFileURL(join(PROJECT_ROOT, "scripts", "install-user.mjs")).href;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const module = await import(${JSON.stringify(installerUrl)}); process.stdout.write(Object.keys(module).sort().join(","));`,
      ],
      {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      },
    );

    assert.equal(stdout, "installUserAliases,isInstallerEntrypoint");
    await assert.rejects(
      readFile(join(fakeHome, ".local", "bin", "orcode")),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
    );
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("the user installer preflights both aliases before creating either one", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const orcodeLink = join(binDirectory, "orcode");
  const routercodeLink = join(binDirectory, "routercode");
  const fake = installerFileSystem(new Map([[target, { kind: "file" }]]));
  const messages: string[] = [];
  const { installUserAliases } = await loadInstaller();

  await installUserAliases({
    projectRoot,
    homeDirectory,
    fileSystem: fake.fileSystem,
    log: (message) => messages.push(message),
  });

  const firstMutation = fake.events.findIndex((event) =>
    event.startsWith("mkdir:") || event.startsWith("chmod:") || event.startsWith("symlink:"),
  );
  assert.ok(firstMutation >= 0);
  assert.ok(fake.events.indexOf(`lstat:${orcodeLink}`) < firstMutation);
  assert.ok(fake.events.indexOf(`lstat:${routercodeLink}`) < firstMutation);
  assert.deepEqual(fake.paths.get(orcodeLink), { kind: "symlink", target });
  assert.deepEqual(fake.paths.get(routercodeLink), { kind: "symlink", target });
  assert.equal(fake.mutations.filter((event) => event.startsWith("symlink:")).length, 2);
  assert.equal(messages.length, 2);

  await installUserAliases({
    projectRoot,
    homeDirectory,
    fileSystem: fake.fileSystem,
    log: (message) => messages.push(message),
  });
  assert.equal(fake.mutations.filter((event) => event.startsWith("symlink:")).length, 2);
});

test("a conflict on either alias prevents every installer mutation", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const routercodeLink = join(binDirectory, "routercode");
  const fake = installerFileSystem(new Map([
    [target, { kind: "file" }],
    [routercodeLink, { kind: "file" }],
  ]));
  const { installUserAliases } = await loadInstaller();

  await assert.rejects(
    installUserAliases({
      projectRoot,
      homeDirectory,
      fileSystem: fake.fileSystem,
      log: () => {},
    }),
    /kein Symlink|nichts überschrieben/i,
  );
  assert.deepEqual(fake.mutations, []);
});

test("a second alias failure keeps the first own link and makes retry safe", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const orcodeLink = join(binDirectory, "orcode");
  const routercodeLink = join(binDirectory, "routercode");
  let failSecondAlias = true;
  const fake = installerFileSystem(
    new Map([[target, { kind: "file" }]]),
    {
      onSymlink(_target, path) {
        if (path === routercodeLink && failSecondAlias) {
          failSecondAlias = false;
          throw Object.assign(new Error("synthetic second alias failure"), { code: "EIO" });
        }
      },
    },
  );
  const { installUserAliases } = await loadInstaller();

  await assert.rejects(
    installUserAliases({
      projectRoot,
      homeDirectory,
      fileSystem: fake.fileSystem,
      log: () => {},
    }),
    /teilweise.*sicher erneut|sicher erneut.*teilweise/is,
  );
  assert.deepEqual(fake.paths.get(orcodeLink), { kind: "symlink", target });
  assert.equal(fake.paths.has(routercodeLink), false);
  assert.equal(fake.mutations.some((event) => event.startsWith("unlink:")), false);

  await installUserAliases({
    projectRoot,
    homeDirectory,
    fileSystem: fake.fileSystem,
    log: () => {},
  });
  assert.deepEqual(fake.paths.get(orcodeLink), { kind: "symlink", target });
  assert.deepEqual(fake.paths.get(routercodeLink), { kind: "symlink", target });
  assert.equal(fake.mutations.filter((event) => event === `symlink:${orcodeLink}`).length, 1);
});

test("a foreign replacement during partial installation is never unlinked", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const orcodeLink = join(binDirectory, "orcode");
  const routercodeLink = join(binDirectory, "routercode");
  const { installUserAliases } = await loadInstaller();

  const replaced = installerFileSystem(
    new Map([[target, { kind: "file" }]]),
    {
      onSymlink(_target, path, paths) {
        if (path === routercodeLink) {
          paths.set(orcodeLink, { kind: "file" });
          throw Object.assign(new Error("synthetic second alias failure"), { code: "EIO" });
        }
      },
    },
  );
  await assert.rejects(
    installUserAliases({
      projectRoot,
      homeDirectory,
      fileSystem: replaced.fileSystem,
      log: () => {},
    }),
    /teilweise.*sicher erneut|sicher erneut.*teilweise/is,
  );
  assert.deepEqual(replaced.paths.get(orcodeLink), { kind: "file" });
  assert.equal(replaced.mutations.some((event) => event.startsWith("unlink:")), false);
});

test("the package checker derives an exact public allowlist and rejects drift", async () => {
  const {
    assertPackageManifest,
    assertExactPackageFiles,
    assertMatchingPackResults,
    assertSafePackageText,
    assertTarballIntegrity,
    expectedPackageFiles,
    packageInstallArguments,
    packagePackArguments,
    packageShimPath,
    resolvePackageOutputDirectory,
    sanitizedPackageEnvironment,
  } = await loadPackageCheck();
  const expected = expectedPackageFiles([
    "src/cli.ts",
    "src/ui/theme.ts",
  ]);

  const packageManifest = {
    name: "orcode",
    version: "0.4.1",
    repository: {
      type: "git",
      url: "git+https://github.com/dkay95/orcode.git",
    },
    bin: {
      orcode: "./dist/cli.js",
      routercode: "./dist/cli.js",
    },
  };
  assert.doesNotThrow(() => assertPackageManifest(packageManifest));
  assert.throws(
    () => assertPackageManifest({
      ...packageManifest,
      repository: { ...packageManifest.repository, url: "https://github.com/other/repo" },
    }),
    /repository|github/i,
  );

  assert.deepEqual(expected, [
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "dist/cli.d.ts",
    "dist/cli.js",
    "dist/cli.js.map",
    "dist/ui/theme.d.ts",
    "dist/ui/theme.js",
    "dist/ui/theme.js.map",
    "package.json",
    "scripts/check-package.mjs",
    "scripts/install-user.mjs",
  ]);
  assert.doesNotThrow(() => assertExactPackageFiles([...expected].reverse(), expected));
  assert.throws(
    () => assertExactPackageFiles([...expected, "tests/private.test.ts"], expected),
    /unerwartet.*tests\/private\.test\.ts/i,
  );
  assert.throws(
    () => assertExactPackageFiles(expected.slice(1), expected),
    /fehlt.*CHANGELOG\.md/i,
  );
  assert.equal(
    packageShimPath("/tmp/prefix", "orcode", "linux"),
    join("/tmp/prefix", "node_modules", ".bin", "orcode"),
  );
  assert.equal(resolvePackageOutputDirectory([], "/repo/orcode"), undefined);
  assert.equal(
    resolvePackageOutputDirectory(["--output", "release-artifact"], "/repo/orcode"),
    resolve("/repo/orcode", "release-artifact"),
  );
  assert.throws(
    () => resolvePackageOutputDirectory(["--output", "../outside"], "/repo/orcode"),
    /output|ausgabe.*projekt|unsicher/i,
  );
  assert.throws(
    () => resolvePackageOutputDirectory(["--output"], "/repo/orcode"),
    /output.*benötigt|ausgabe.*fehlt/i,
  );
  assert.throws(
    () => resolvePackageOutputDirectory(["--output", "a", "--output", "b"], "/repo/orcode"),
    /nur einmal|doppelt/i,
  );
  assert.equal(
    packageShimPath("C:\\prefix", "routercode", "win32"),
    join("C:\\prefix", "node_modules", ".bin", "routercode.cmd"),
  );

  assert.deepEqual(packagePackArguments("/tmp/pack", true), [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    "/tmp/pack",
  ]);
  assert.deepEqual(packagePackArguments("/tmp/pack", false), [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    "/tmp/pack",
  ]);
  assert.deepEqual(packageInstallArguments("/tmp/install", "/tmp/orcode.tgz", true), [
    "install",
    "--prefix",
    "/tmp/install",
    "--no-save",
    "--ignore-scripts=false",
    "--no-audit",
    "--no-fund",
    "/tmp/orcode.tgz",
  ]);

  const packResult = {
    filename: "orcode-0.4.1.tgz",
    integrity: "sha512-synthetic",
    shasum: "synthetic-sha1",
    size: 100,
    unpackedSize: 200,
    entryCount: 1,
    files: [{ path: "package.json", size: 200, mode: 0o644 }],
  };
  assert.doesNotThrow(() => assertMatchingPackResults(packResult, { ...packResult }));
  assert.throws(
    () => assertMatchingPackResults(packResult, { ...packResult, integrity: "sha512-other" }),
    /integrity|inhalt|dry.*real/i,
  );
  assert.throws(
    () => assertMatchingPackResults(packResult, { ...packResult, size: 101 }),
    /size|größe|dry.*real/i,
  );
  const tarballBytes = Buffer.from("synthetic tarball bytes", "utf8");
  const tarballIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  assert.doesNotThrow(() => assertTarballIntegrity(tarballBytes, tarballIntegrity));
  assert.throws(
    () => assertTarballIntegrity(Buffer.from("changed"), tarballIntegrity),
    /integrity|hash/i,
  );

  const lowerNpmConfigName = ["npm", "config", "ignore", "scripts"].join("_");
  const isolated = sanitizedPackageEnvironment({
    PATH: "/usr/bin",
    LANG: "de_DE.UTF-8",
    NPM_CONFIG_GLOBALCONFIG: "/untrusted/global-npmrc",
    [lowerNpmConfigName]: "true",
    NODE_OPTIONS: "--require=/untrusted/hook.cjs",
    OPENROUTER_API_KEY: "synthetic-not-a-real-key",
  }, "/isolated/home");
  assert.equal(isolated.PATH, "/usr/bin");
  assert.equal(isolated.LANG, "de_DE.UTF-8");
  assert.equal(isolated.NODE_OPTIONS, undefined);
  assert.equal(isolated.OPENROUTER_API_KEY, undefined);
  assert.equal(isolated[lowerNpmConfigName], undefined);
  assert.equal(isolated.HOME, "/isolated/home");
  assert.equal(isolated.USERPROFILE, "/isolated/home");
  assert.equal(isolated.APPDATA, join("/isolated/home", ".appdata", "roaming"));
  assert.equal(isolated.LOCALAPPDATA, join("/isolated/home", ".appdata", "local"));
  assert.equal(
    isolated.NPM_CONFIG_GLOBALCONFIG,
    join("/isolated/home", ".npm-globalrc"),
  );
  assert.equal(isolated.NPM_CONFIG_IGNORE_SCRIPTS, "false");

  const syntheticSecret = `${["sk", "or", "v1"].join("-")}-package-fixture-value`;
  const scanner = (value: string): readonly { category: string }[] =>
    value.includes(syntheticSecret) ? [{ category: "OpenRouter-Key" }] : [];
  assert.throws(
    () =>
      assertSafePackageText("dist/example.js", `const key = ${syntheticSecret}`, {
        checkoutRoot: "/checkout/orcode",
        scanForSecrets: scanner,
      }),
    (error: unknown) => {
      assert.match(String(error), /dist\/example\.js.*OpenRouter-Key/i);
      assert.doesNotMatch(String(error), new RegExp(syntheticSecret));
      return true;
    },
  );
  assert.throws(
    () =>
      assertSafePackageText(
        "dist/example.js.map",
        "sourceRoot=/checkout/orcode/src",
        { checkoutRoot: "/checkout/orcode", scanForSecrets: () => [] },
      ),
    /dist\/example\.js\.map.*checkout/i,
  );
  assert.throws(
    () =>
      assertSafePackageText("README.md", "path=/Users/example/private/file", {
        checkoutRoot: "/checkout/orcode",
        scanForSecrets: () => [],
      }),
    /README\.md.*private/i,
  );
  for (const privatePath of [
    "file:///Users/alice/project/file.ts",
    "file:///Users/alice",
    "file:///home/alice/project/file.ts",
    "/home/alice/",
    "C:/Users/alice/project/file.ts",
    "C:/Users/alice",
    String.raw`C:\\Users\\alice\\project\\file.ts`,
    String.raw`C:\\Users\\alice`,
  ]) {
    assert.throws(
      () =>
        assertSafePackageText("dist/example.js.map", privatePath, {
          checkoutRoot: "/checkout/orcode",
          scanForSecrets: () => [],
        }),
      /dist\/example\.js\.map.*private/i,
      privatePath,
    );
  }
  assert.doesNotThrow(() =>
    assertSafePackageText("dist/example.js", "export const safe = true;", {
      checkoutRoot: "/checkout/orcode",
      scanForSecrets: () => [],
    }),
  );
});
