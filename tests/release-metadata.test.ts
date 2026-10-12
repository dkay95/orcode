import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "check-release-metadata.mjs");
const execFileAsync = promisify(execFile);

interface ReleaseMetadataInput {
  packageJson: unknown;
  packageLock: unknown;
  changelog: string;
  tag: string;
  cliVersion: string;
  cliHelp: string;
  renderedBanner: string;
  renderedHelp: string;
  today?: string;
}

interface ReleaseMetadataModule {
  assertReleaseMetadata(input: ReleaseMetadataInput): {
    name: string;
    version: string;
    tag: string;
  };
  checkReleaseMetadata(options: {
    projectRoot: string;
    tag: string;
    today?: string;
    platform?: NodeJS.Platform;
    fileSystem?: {
      realpath(path: string): Promise<string>;
      lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
      readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
    };
    runCommand?(
      command: string,
      args: string[],
      options: { cwd: string; shell: boolean },
    ): Promise<{ stdout: string; stderr: string }>;
    importModule?(url: string): Promise<{
      renderCliBanner(workspace: string, model: string): string;
      renderCliHelp(): string;
    }>;
    log?(message: string): void;
  }): Promise<{ name: string; version: string; tag: string }>;
  isReleaseMetadataEntrypoint(
    moduleUrl: string,
    argvEntry?: string,
    resolvePath?: (path: string) => string,
  ): boolean;
  resolveReleaseTag(argv: string[], environmentTag?: string): string;
}

async function loadReleaseMetadata(): Promise<ReleaseMetadataModule> {
  const modulePath = "../scripts/check-release-metadata.mjs";
  return import(modulePath) as Promise<ReleaseMetadataModule>;
}

function validInput(
  overrides: Partial<ReleaseMetadataInput> = {},
): ReleaseMetadataInput {
  const renderedHelp = `\norcode 0.4.1 – lokaler Coding-Agent über OpenRouter\n\nVerwendung:\n  orcode [optionen]\n\n  -v, --version  Version anzeigen\n`;
  return {
    packageJson: {
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
    },
    packageLock: {
      name: "orcode",
      version: "0.4.1",
      packages: {
        "": {
          name: "orcode",
          version: "0.4.1",
          bin: {
            orcode: "dist/cli.js",
            routercode: "dist/cli.js",
          },
        },
      },
    },
    changelog: "# Changelog\n\n## [Unreleased]\n\n## [0.4.1] - 2026-08-23\n",
    tag: "v0.4.1",
    cliVersion: "orcode 0.4.1\n",
    cliHelp: renderedHelp,
    renderedBanner: "orcode 0.4.1\nWorkspace /release-check/workspace\nMain      release/check-model",
    renderedHelp,
    today: "2026-08-23",
    ...overrides,
  };
}

test("importing the release checker is side-effect free and exposes explicit seams", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "orcode-release-import-"));
  try {
    const scriptUrl = pathToFileURL(SCRIPT_PATH).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const module = await import(${JSON.stringify(scriptUrl)}); process.stdout.write(Object.keys(module).sort().join(","));`,
      ],
      {
        cwd: fakeHome,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      },
    );

    assert.equal(stderr, "");
    assert.equal(
      stdout,
      "assertReleaseMetadata,checkReleaseMetadata,isReleaseMetadataEntrypoint,resolveReleaseTag",
    );
    await assert.rejects(readFile(join(fakeHome, "package.json")), { code: "ENOENT" });
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("the pure validator accepts one internally consistent stable release", async () => {
  const { assertReleaseMetadata } = await loadReleaseMetadata();

  assert.deepEqual(assertReleaseMetadata(validInput()), {
    name: "orcode",
    version: "0.4.1",
    tag: "v0.4.1",
  });
});

test("release tag input is explicit, canonical, and cannot contain a path", async () => {
  const { resolveReleaseTag } = await loadReleaseMetadata();

  assert.equal(resolveReleaseTag(["--tag", "v0.4.1"]), "v0.4.1");
  assert.equal(resolveReleaseTag(["--tag=v0.4.1"]), "v0.4.1");
  assert.equal(resolveReleaseTag([], "v0.4.1"), "v0.4.1");
  assert.equal(resolveReleaseTag(["--tag", "v0.4.1"], "v0.4.1"), "v0.4.1");
  assert.throws(() => resolveReleaseTag([], undefined), /release-tag.*fehlt/i);
  assert.throws(() => resolveReleaseTag(["--tag", "../v0.4.1"]), /ungültig|unsicher/i);
  assert.throws(() => resolveReleaseTag(["--tag", "v01.4.1"]), /ungültig|unsicher/i);
  assert.throws(
    () => resolveReleaseTag(["--tag", "v0.4.1", "--publish"]),
    /unbekannt|unerwartet/i,
  );
  assert.throws(
    () => resolveReleaseTag(["--tag", "v0.4.1"], "v0.4.2"),
    /widersprechen|abweich/i,
  );
});

test("the validator rejects missing, future, stale, and malformed release tags", async () => {
  const { assertReleaseMetadata } = await loadReleaseMetadata();

  assert.throws(
    () => assertReleaseMetadata(validInput({ tag: "" })),
    /release-tag.*fehlt/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ tag: "v0.4.2" })),
    /zukünft/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ tag: "v0.4.0" })),
    /abweich|veraltet/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ tag: "v0.4" })),
    /ungültig/i,
  );
});

test("the validator rejects package, lockfile, and bin-path drift", async () => {
  const { assertReleaseMetadata } = await loadReleaseMetadata();
  const wrongPackage = validInput().packageJson as {
    name: string;
    version: string;
    repository: { type: string; url: string };
    bin: Record<string, string>;
  };
  const wrongLock = validInput().packageLock as {
    name: string;
    version: string;
    packages: Record<string, {
      name: string;
      version: string;
      bin: Record<string, string>;
    }>;
  };

  assert.throws(
    () => assertReleaseMetadata(validInput({ packageJson: { ...wrongPackage, name: "routercode" } })),
    /package\.json.*name/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({
      packageJson: {
        ...wrongPackage,
        repository: {
          ...wrongPackage.repository,
          url: "git+https://github.com/someone-else/orcode.git",
        },
      },
    })),
    /package\.json.*repository|github.*repository/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({
      packageJson: {
        ...wrongPackage,
        bin: { ...wrongPackage.bin, orcode: "../outside/cli.js" },
      },
    })),
    /package\.json.*bin|unsicher/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ packageLock: { ...wrongLock, version: "0.4.2" } })),
    /package-lock.*version/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({
      packageLock: {
        ...wrongLock,
        packages: {
          "": { ...wrongLock.packages[""], version: "0.4.0" },
        },
      },
    })),
    /package-lock.*root.*version/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({
      packageLock: {
        ...wrongLock,
        packages: {
          "": {
            ...wrongLock.packages[""],
            bin: { orcode: "dist/cli.js", routercode: "../dist/cli.js" },
          },
        },
      },
    })),
    /package-lock.*root.*bin|unsicher/i,
  );
});

test("the validator requires a real non-future changelog release header", async () => {
  const { assertReleaseMetadata } = await loadReleaseMetadata();

  assert.throws(
    () => assertReleaseMetadata(validInput({ changelog: "# Changelog\n\n## [Unreleased]\n" })),
    /changelog.*0\.4\.1.*fehlt/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ changelog: "## [0.4.1] - 2026-02-30\n" })),
    /changelog.*datum.*ungültig/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ changelog: "## [0.4.1] - 2026-08-24\n" })),
    /changelog.*zukunft/i,
  );
});

test("the validator rejects drift in the built CLI version, help, and renderers", async () => {
  const { assertReleaseMetadata } = await loadReleaseMetadata();

  assert.throws(
    () => assertReleaseMetadata(validInput({ cliVersion: "orcode 0.4.0\n" })),
    /--version.*0\.4\.1/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ cliHelp: "orcode 0.4.0\n" })),
    /--help.*render|--help.*0\.4\.1/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ renderedBanner: "orcode 0.4.0\nWorkspace x\nMain y" })),
    /banner.*0\.4\.1/i,
  );
  assert.throws(
    () => assertReleaseMetadata(validInput({ renderedHelp: "orcode 0.4.0\n" })),
    /render.*help.*0\.4\.1|hilfe.*0\.4\.1/i,
  );
});

test("the injected checker reads and executes the required built dist/cli.js", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-release-fixture-"));
  const dist = join(root, "dist");
  const renderedHelp = `\norcode 0.4.1 – fixture help\n\nVerwendung:\n  orcode\n\n  --version\n`;
  const cliSource = `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
export function renderCliBanner(workspace, model) {
  return ["orcode 0.4.1", "Workspace " + workspace, "Main      " + model].join("\\n");
}
export function renderCliHelp() { return ${JSON.stringify(renderedHelp)}; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--version") process.stdout.write("orcode 0.4.1\\n");
  else if (process.argv[2] === "--help") process.stdout.write(renderCliHelp());
  else process.exitCode = 2;
}
`;
  const packageJson = validInput().packageJson;
  const packageLock = validInput().packageLock;
  const changelog = validInput().changelog;

  try {
    await mkdir(dist);
    await writeFile(join(root, "package.json"), JSON.stringify({
      ...(packageJson as object),
      type: "module",
    }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify(packageLock));
    await writeFile(join(root, "CHANGELOG.md"), changelog);
    await writeFile(join(dist, "cli.js"), cliSource, { mode: 0o755 });

    const { checkReleaseMetadata } = await loadReleaseMetadata();
    const messages: string[] = [];
    const result = await checkReleaseMetadata({
      projectRoot: root,
      tag: "v0.4.1",
      today: "2026-08-23",
      log: (message) => messages.push(message),
    });

    assert.deepEqual(result, { name: "orcode", version: "0.4.1", tag: "v0.4.1" });
    assert.deepEqual(messages, ["Release-Metadaten orcode@0.4.1 stimmen mit v0.4.1 überein."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the checker rejects a built CLI replaced after the first execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-release-swap-"));
  const dist = join(root, "dist");
  const cliPath = join(dist, "cli.js");
  const input = validInput();
  const cliSource = `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
export function renderCliBanner(workspace, model) {
  return ["orcode 0.4.1", "Workspace " + workspace, "Main      " + model].join("\\n");
}
export function renderCliHelp() { return ${JSON.stringify(input.renderedHelp)}; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--version") process.stdout.write("orcode 0.4.1\\n");
  else if (process.argv[2] === "--help") process.stdout.write(renderCliHelp());
  else process.exitCode = 2;
}
`;

  try {
    await mkdir(dist);
    await writeFile(join(root, "package.json"), JSON.stringify({
      ...(input.packageJson as object),
      type: "module",
    }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify(input.packageLock));
    await writeFile(join(root, "CHANGELOG.md"), input.changelog);
    await writeFile(cliPath, cliSource, { mode: 0o755 });

    let replaced = false;
    const { checkReleaseMetadata } = await loadReleaseMetadata();
    await assert.rejects(
      checkReleaseMetadata({
        projectRoot: root,
        tag: "v0.4.1",
        today: "2026-08-23",
        async runCommand(command, args, options) {
          const result = await execFileAsync(command, args, {
            cwd: options.cwd,
            env: { ...process.env, NO_COLOR: "1" },
          });
          if (!replaced) {
            replaced = true;
            await writeFile(cliPath, `${cliSource}\n// replaced after --version\n`, { mode: 0o755 });
          }
          return result;
        },
        log: () => {},
      }),
      /build.*(?:geändert|identität|hash)|ausgetauscht/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the injected checker refuses a missing build before attempting metadata approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcode-release-no-dist-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify(validInput().packageJson));
    await writeFile(join(root, "package-lock.json"), JSON.stringify(validInput().packageLock));
    await writeFile(join(root, "CHANGELOG.md"), validInput().changelog);

    const { checkReleaseMetadata } = await loadReleaseMetadata();
    await assert.rejects(
      checkReleaseMetadata({
        projectRoot: root,
        tag: "v0.4.1",
        today: "2026-08-23",
        log: () => {},
      }),
      /build.*dist\/cli\.js.*fehlt|dist\/cli\.js.*build/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the injected checker accepts Windows realpath casing without weakening path checks", async () => {
  const { checkReleaseMetadata } = await loadReleaseMetadata();
  const root = "/Release/Project";
  const cliPath = join(root, "dist", "cli.js");
  const input = validInput();

  const result = await checkReleaseMetadata({
    projectRoot: root,
    tag: "v0.4.1",
    today: "2026-08-23",
    platform: "win32",
    fileSystem: {
      async realpath(path) {
        return path.endsWith("dist/cli.js") ? path.toLowerCase() : root;
      },
      async lstat(path) {
        assert.equal(path, cliPath);
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      async readFile(path) {
        if (path.endsWith("package.json")) return JSON.stringify(input.packageJson);
        if (path.endsWith("package-lock.json")) return JSON.stringify(input.packageLock);
        if (path.endsWith("CHANGELOG.md")) return input.changelog;
        if (path.endsWith("dist/cli.js")) return new TextEncoder().encode("synthetic stable cli");
        throw new Error(`unexpected fixture path: ${path}`);
      },
    },
    async runCommand(_command, args) {
      return args.includes("--version")
        ? { stdout: input.cliVersion, stderr: "" }
        : { stdout: input.cliHelp, stderr: "" };
    },
    async importModule() {
      return {
        renderCliBanner: () => input.renderedBanner,
        renderCliHelp: () => input.renderedHelp,
      };
    },
    log: () => {},
  });

  assert.equal(result.version, "0.4.1");
});
