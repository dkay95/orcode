#!/usr/bin/env node

/**
 * Runs the GUI protocol pins against the BUILT `dist/gui-server.js`.
 *
 * `npm test` runs the same pins against `src/gui-server.ts` so a fresh clone
 * needs no build; this one proves the artifact a Tauri sidecar will actually
 * spawn. Same split as `check-pty.mjs`/`check-journeys.mjs`: a small driver
 * so the environment wiring is portable instead of shell-specific.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(projectRoot, "dist", "gui-server.js");
if (!existsSync(built)) {
  console.error("dist/gui-server.js is missing — run `npm run build` first.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "tests/gui-server-protocol.test.ts"],
  {
    cwd: projectRoot,
    env: { ...process.env, ORCODE_GUI_TEST_MODULE: pathToFileURL(built).href },
    stdio: "inherit",
  },
);
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`GUI protocol pins were killed by ${signal}.`);
    process.exit(1);
  }
  if (code === 0) {
    console.log("GUI protocol pins checked against the real built dist/gui-server.js.");
  }
  process.exit(code ?? 1);
});
