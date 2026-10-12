#!/usr/bin/env node

/**
 * The GUI's dev loop, its local build, and the shipped package, as one script.
 *
 *   npm run gui:dev      — build dist/, then `tauri dev` (Vite on :1420)
 *   npm run gui:build    — build dist/, then an unsigned local .app, in seconds
 *   npm run gui:package  — stage a bundled runtime, then a release .app + DMG
 *
 * `build` and `package` differ in the one way that matters for shipping:
 * `build` produces a debug app that resolves node from whatever the target
 * machine has, and `package` produces an app that CARRIES its own node, its
 * own `dist/` and its own production `node_modules`. G2 concern 6 was that
 * only the first existed, so the app worked on this Mac purely because
 * `/usr/local/bin/node` happened to be there.
 *
 * Three things this exists to get right, each one a fact from G0's discovery
 * rather than a preference:
 *
 *  1. **`~/.cargo/bin` is not on this machine's `PATH`.** rustup was
 *     installed without touching the shell profile, so `cargo` is invisible
 *     to `tauri dev` unless the loop puts it there.
 *  2. **The sidecar is not part of `tauri dev`'s chain.** `tauri dev` runs
 *     the Vite command and then `cargo run`; nothing in it builds
 *     `dist/gui-server.js`, and a stale `dist/` would silently ship
 *     yesterday's engine into today's window. So `tsc` runs first, always,
 *     unless the caller says `--no-build`.
 *  3. **The app home is a FIXTURE.** `gui/.devhome`, never `~/.orcode`, so a
 *     half-built GUI cannot touch the owner's real chats, config or keys.
 *     `--real-home` is the deliberate opt-in and is passed on to the shell.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guiRoot = join(projectRoot, "gui");
const cargoBin = join(process.env.HOME ?? "", ".cargo", "bin");

const mode = process.argv[2];
if (mode !== "dev" && mode !== "build" && mode !== "package") {
  console.error("usage: node scripts/gui.mjs <dev|build|package> [--no-build] [--real-home]");
  process.exit(2);
}
const flags = process.argv.slice(3);
const skipEngineBuild = flags.includes("--no-build");
const realHome = flags.includes("--real-home");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env },
  });
  if (result.error) {
    console.error(`${command} could not be started: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(cargoBin)) {
  console.error(
    `The Rust toolchain was not found at ${cargoBin}. Install rustup (https://rustup.rs) — Tauri needs cargo to build the shell.`,
  );
  process.exit(1);
}

if (!existsSync(join(guiRoot, "node_modules"))) {
  console.log("gui: installing the window's own dependencies …");
  run("npm", ["install"], { cwd: guiRoot });
}

if (!skipEngineBuild) {
  console.log("gui: building the engine (dist/gui-server.js) …");
  run("npm", ["run", "build"]);
}
if (!existsSync(join(projectRoot, "dist", "gui-server.js"))) {
  console.error("dist/gui-server.js is missing — run `npm run build` first, or drop --no-build.");
  process.exit(1);
}

const env = {
  PATH: `${cargoBin}:${process.env.PATH ?? ""}`,
  ...(realHome ? { ORCODE_GUI_REAL_HOME: "1" } : {}),
};

if (mode === "dev") {
  console.log(
    realHome
      ? "gui: starting against YOUR REAL orcode home."
      : "gui: starting against the fixture home gui/.devhome (your real ~/.orcode is untouched).",
  );
  run("npm", ["run", "tauri", "--", "dev"], { cwd: guiRoot, env });
} else if (mode === "build") {
  // `--debug` reuses the dev profile, which is what makes a local build take
  // seconds rather than minutes; it is unsigned, it bundles no runtime, and
  // it therefore resolves node from the machine it runs on. That is the DEV
  // shape — `package` below is the one that ships.
  run("npm", ["run", "tauri", "--", "build", "--debug", "--bundles", "app"], { cwd: guiRoot, env });
  console.log(
    `gui: built ${join(guiRoot, "src-tauri/target/debug/bundle/macos/orcode.app")}`,
  );
} else {
  stageRuntime();
  // Leftovers from an interrupted DMG run: `bundle_dmg.sh` writes its
  // read-write staging image next to the `.app` and only removes it on a
  // clean finish, so a failed run leaves a 170 MB file that the NEXT run
  // would happily fold into the bundle.
  rmSync(join(guiRoot, "src-tauri/target/release/bundle/macos"), {
    recursive: true,
    force: true,
  });
  run(
    "npm",
    [
      "run", "tauri", "--", "build",
      "--config", join(guiRoot, "src-tauri/tauri.package.conf.json"),
    ],
    {
      cwd: guiRoot,
      env: {
        ...env,
        // `bundle_dmg.sh` drives Finder through AppleScript to set the
        // volume window's icon layout — which needs the Automation
        // permission macOS only grants a human-approved app, and which fails
        // outright from a terminal that has not been granted it. `CI` is the
        // script's own documented switch for skipping exactly that step; the
        // DMG it produces is identical apart from the window's cosmetics.
        CI: "true",
      },
    },
  );
  const app = join(guiRoot, "src-tauri/target/release/bundle/macos/orcode.app");
  console.log(`gui: packaged ${app}`);
  console.log(`gui: dmg in ${join(guiRoot, "src-tauri/target/release/bundle/dmg")}`);
}

/**
 * Stages everything the shipped app needs to run WITHOUT the machine it lands
 * on having a node at all — G0 §1.3's answer, and G2 concern 6's ship-blocker.
 *
 * Three pieces, and each one is here for a reason that was measured rather
 * than assumed:
 *
 *  1. **node itself.** A double-clicked `.app` inherits launchd's minimal
 *     `PATH`, so the shipped app on a machine without `/usr/local/bin/node`
 *     simply did not start. The binary is thinned to this machine's own
 *     architecture (`lipo`), because the universal build on this Mac is
 *     210 MB and half of it is an architecture this app will never run on.
 *  2. **`dist/`** — the engine. Sources and maps are left behind.
 *  3. **`node_modules`, production only.** A bundle cannot be a single file:
 *     `@napi-rs/keyring` is a native `.node` addon (which is why G0 ruled a
 *     SEA out), and the package is ESM, so the imports have to resolve on
 *     disk. `npm ci --omit=dev` against the repo's own lockfile is what makes
 *     the staged tree the same tree the tests ran against.
 */
function stageRuntime() {
  const staging = join(guiRoot, "src-tauri/resources/orcode");
  console.log("gui: staging the bundled runtime …");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // --- 1. node -------------------------------------------------------------
  const nodePath = process.env.ORCODE_GUI_BUNDLE_NODE || process.execPath;
  if (!existsSync(nodePath)) {
    console.error(`gui: no node binary to bundle at ${nodePath}.`);
    process.exit(1);
  }
  const staged = join(staging, "node");
  const thin = spawnSync("lipo", ["-thin", process.arch === "arm64" ? "arm64" : "x86_64", nodePath, "-output", staged]);
  if (thin.status !== 0) {
    // Not fat, or no `lipo` on this machine: ship it as it is and say so.
    cpSync(nodePath, staged);
    console.log("gui: node was copied whole (not a universal binary, or lipo is unavailable).");
  }
  spawnSync("chmod", ["+x", staged]);

  // --- 2. the engine -------------------------------------------------------
  cpSync(join(projectRoot, "dist"), join(staging, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".js.map") && !source.endsWith(".d.ts"),
  });

  // --- 3. production dependencies -----------------------------------------
  // The repo's own manifest and lockfile, so the staged tree is the resolved
  // tree — never a fresh resolution that could pick up a different version
  // than the one every gate ran against.
  for (const file of ["package.json", "package-lock.json"]) {
    cpSync(join(projectRoot, file), join(staging, file));
  }
  run("npm", ["ci", "--omit=dev", "--ignore-scripts=false"], { cwd: staging });
  // The manifest is reduced, not deleted, and the version is why: the
  // sidecar's `hello` frame reports `readPackageVersion()`, which reads
  // `../package.json` relative to `dist/` — an app that shipped without it
  // announced itself as "unknown" to its own window. `type: "module"` is
  // load-bearing for the same tree. The `bin` entry and the `scripts` block
  // have no business inside an app bundle and stay behind.
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  writeFileSync(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: "orcode-runtime",
        private: true,
        version: manifest.version,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  rmSync(join(staging, "package-lock.json"), { force: true });

  const size = spawnSync("du", ["-sh", staging], { encoding: "utf8" });
  console.log(`gui: staged runtime is ${(size.stdout ?? "").trim()}`);
  console.log(`gui: node is ${(statSync(staged).size / (1024 * 1024)).toFixed(1)} MB`);
}
