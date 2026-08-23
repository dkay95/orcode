import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  assertExactPackageFiles(actual: string[], expected: string[]): void;
  expectedPackageFiles(sourceFiles: string[]): string[];
  packageShimPath(prefix: string, command: string, platform: NodeJS.Platform): string;
}

type FakePath = { kind: "file" } | { kind: "symlink"; target: string };

function installerFileSystem(
  initial: Map<string, FakePath>,
  options: {
    failSymlinkPaths?: ReadonlySet<string>;
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
        if (options.failSymlinkPaths?.has(path)) {
          throw Object.assign(new Error(`synthetic symlink failure: ${path}`), { code: "EIO" });
        }
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

test("release metadata packages both CLI names at version 0.4.1", async () => {
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
  assert.equal(packageJson.version, "0.4.1");
  assert.deepEqual(packageJson.bin, bins);
  assert.equal(packageJson.scripts["install:user"], "node scripts/install-user.mjs");
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.ok(packageJson.files.includes("scripts/install-user.mjs"));
  assert.ok(packageJson.files.includes("scripts/check-package.mjs"));
  assert.equal(packageLock.name, "orcode");
  assert.equal(packageLock.version, "0.4.1");
  assert.equal(packageLock.packages[""]?.name, "orcode");
  assert.equal(packageLock.packages[""]?.version, "0.4.1");
  assert.deepEqual(packageLock.packages[""]?.bin, {
    orcode: "dist/cli.js",
    routercode: "dist/cli.js",
  });
  assert.match(changelog, /^## \[0\.4\.1\] - \d{4}-\d{2}-\d{2}$/m);
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

test("a second alias creation failure restores the exact pre-call alias state", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const orcodeLink = join(binDirectory, "orcode");
  const routercodeLink = join(binDirectory, "routercode");
  const fake = installerFileSystem(
    new Map([[target, { kind: "file" }]]),
    { failSymlinkPaths: new Set([routercodeLink]) },
  );
  const { installUserAliases } = await loadInstaller();

  await assert.rejects(
    installUserAliases({
      projectRoot,
      homeDirectory,
      fileSystem: fake.fileSystem,
      log: () => {},
    }),
    /synthetic symlink failure/,
  );
  assert.equal(fake.paths.has(orcodeLink), false);
  assert.equal(fake.paths.has(routercodeLink), false);
  assert.ok(fake.mutations.includes(`unlink:${orcodeLink}`));
});

test("rollback keeps pre-existing aliases and surfaces an unsafe replacement", async () => {
  const projectRoot = resolve(PROJECT_ROOT, ".installer-project");
  const homeDirectory = resolve(PROJECT_ROOT, ".installer-home");
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const orcodeLink = join(binDirectory, "orcode");
  const routercodeLink = join(binDirectory, "routercode");
  const { installUserAliases } = await loadInstaller();

  const preExisting = installerFileSystem(
    new Map([
      [target, { kind: "file" }],
      [orcodeLink, { kind: "symlink", target }],
    ]),
    { failSymlinkPaths: new Set([routercodeLink]) },
  );
  await assert.rejects(
    installUserAliases({
      projectRoot,
      homeDirectory,
      fileSystem: preExisting.fileSystem,
      log: () => {},
    }),
    /synthetic symlink failure/,
  );
  assert.deepEqual(preExisting.paths.get(orcodeLink), { kind: "symlink", target });
  assert.equal(preExisting.mutations.some((event) => event === `unlink:${orcodeLink}`), false);

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
    /Rückrollen|unsicher|rollback/i,
  );
  assert.deepEqual(replaced.paths.get(orcodeLink), { kind: "file" });
  assert.equal(replaced.mutations.some((event) => event === `unlink:${orcodeLink}`), false);
});

test("the package checker derives an exact public allowlist and rejects drift", async () => {
  const {
    assertExactPackageFiles,
    expectedPackageFiles,
    packageShimPath,
  } = await loadPackageCheck();
  const expected = expectedPackageFiles([
    "src/cli.ts",
    "src/ui/theme.ts",
  ]);

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
  assert.equal(
    packageShimPath("C:\\prefix", "routercode", "win32"),
    join("C:\\prefix", "node_modules", ".bin", "routercode.cmd"),
  );
});
