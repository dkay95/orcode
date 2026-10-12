#!/usr/bin/env node

/**
 * The release gate, as one command.
 *
 * `npm run gui:gate` runs every check the GUI phases accumulated, in the order
 * that fails cheapest first, and prints one table at the end. It exists
 * because the gate had become a list in a report that a person had to
 * re-assemble by hand before every merge — and a gate nobody can run in one
 * step is a gate that gets run in pieces.
 *
 * What it does NOT do is decide anything. Every step is an existing script or
 * an existing test runner; this file only sequences them and reports.
 *
 *   --skip-cargo     leave the Rust half out (no toolchain on this machine)
 *   --skip-package   leave the .app/DMG build out (minutes, not seconds)
 *   --only <name>    run one step by name
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const guiRoot = join(projectRoot, "gui");
const cargoBin = join(process.env.HOME ?? "", ".cargo", "bin");

const flags = process.argv.slice(2);
const only = flags.includes("--only") ? flags[flags.indexOf("--only") + 1] : null;
const skipCargo = flags.includes("--skip-cargo") || !existsSync(cargoBin);
const skipPackage = flags.includes("--skip-package");

/**
 * The gate, in order. `build` first because everything downstream reads
 * `dist/`; `package` last because it is the only step measured in minutes.
 */
const STEPS = [
  {
    name: "build",
    what: "tsc → dist/",
    command: ["npm", ["run", "build"]],
  },
  {
    name: "typecheck",
    what: "the test tsconfig",
    command: ["npx", ["tsc", "-p", "tsconfig.tests.json", "--noEmit"]],
  },
  {
    name: "gui-dist",
    what: "the protocol pins against the BUILT engine",
    command: ["npm", ["run", "test:gui-dist"]],
  },
  {
    name: "journeys",
    what: "the shipped binary's own journeys (the TUI must be untouched)",
    command: ["npm", ["run", "test:journeys"]],
  },
  {
    name: "pty",
    what: "the terminal surface over a real PTY",
    command: ["npm", ["run", "test:pty"]],
  },
  {
    name: "gui-vitest",
    what: "the window's own suites",
    command: ["npm", ["--prefix", "gui", "test"]],
  },
  {
    name: "gui-browser",
    what: "the window's real Chromium Browser Mode suite",
    command: ["npm", ["--prefix", "gui", "run", "test:browser"]],
  },
  {
    name: "gui-bundle",
    what: "the WebView bundle type-checks and builds",
    command: ["npm", ["run", "build"]],
    cwd: guiRoot,
  },
  {
    name: "cargo",
    what: "the shell's lifecycle and pipe proofs",
    command: ["cargo", ["test"]],
    cwd: join(guiRoot, "src-tauri"),
    skip: skipCargo && "no cargo toolchain (or --skip-cargo)",
  },
  {
    name: "package",
    what: "the .app and the DMG, with the runtime bundled",
    command: ["npm", ["run", "gui:package"]],
    skip: skipPackage && "--skip-package",
  },
];

const env = { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ""}` };
const results = [];
let failed = 0;

for (const step of STEPS) {
  if (only && step.name !== only) continue;
  if (step.skip) {
    results.push({ name: step.name, state: "skipped", detail: step.skip, ms: 0 });
    continue;
  }
  process.stdout.write(`\n─── ${step.name}: ${step.what}\n`);
  const began = Date.now();
  const [command, args] = step.command;
  const outcome = spawnSync(command, args, {
    stdio: "inherit",
    cwd: step.cwd ?? projectRoot,
    env,
  });
  const ms = Date.now() - began;
  if (outcome.error) {
    results.push({ name: step.name, state: "FAILED", detail: outcome.error.message, ms });
    failed += 1;
    continue;
  }
  if (outcome.status !== 0) {
    results.push({ name: step.name, state: "FAILED", detail: `exit ${outcome.status}`, ms });
    failed += 1;
    continue;
  }
  results.push({ name: step.name, state: "pass", detail: "", ms });
}

// The artifact's own size is part of the gate's answer: a bundled runtime is
// the point of `package`, and its cost is a fact the report has to carry.
const app = join(guiRoot, "src-tauri/target/release/bundle/macos/orcode.app");
if (existsSync(app)) {
  const size = spawnSync("du", ["-sh", app], { encoding: "utf8" }).stdout ?? "";
  results.push({ name: "artifact", state: ".app", detail: size.trim().split("\t")[0] ?? "", ms: 0 });
}
const dmgDir = join(guiRoot, "src-tauri/target/release/bundle/dmg");
if (existsSync(dmgDir)) {
  const listing = spawnSync("sh", ["-c", `ls -1 ${JSON.stringify(dmgDir)}/*.dmg 2>/dev/null | head -1`], {
    encoding: "utf8",
  }).stdout?.trim();
  if (listing && existsSync(listing)) {
    results.push({
      name: "artifact",
      state: "dmg",
      detail: `${(statSync(listing).size / (1024 * 1024)).toFixed(1)} MB`,
      ms: 0,
    });
  }
}

process.stdout.write("\n─── gate\n");
for (const result of results) {
  const seconds = result.ms ? ` ${(result.ms / 1000).toFixed(1)}s` : "";
  process.stdout.write(
    `  ${result.state.padEnd(8)} ${result.name.padEnd(12)}${result.detail}${seconds}\n`,
  );
}
process.stdout.write(failed ? `\n${failed} step(s) failed.\n` : "\nEvery step passed.\n");
process.exit(failed ? 1 : 0);
