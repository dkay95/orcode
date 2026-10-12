import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUI_GATE = join(PROJECT_ROOT, "scripts", "gui-gate.mjs");

test("gui gate runs and reports the selected Browser Mode suite", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "orcode-gui-browser-gate-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const bin = join(fixture, "bin");
  const invocationLog = join(fixture, "npm-arguments.txt");
  await mkdir(bin);
  const npm = join(bin, "npm");
  await writeFile(
    npm,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$GUI_GATE_INVOCATION_LOG"',
      "printf 'BROWSER_STEP_EXECUTED\\n'",
      "",
    ].join("\n"),
  );
  await chmod(npm, 0o755);

  const result = spawnSync(process.execPath, [GUI_GATE, "--only", "gui-browser"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GUI_GATE_INVOCATION_LOG: invocationLog,
      PATH: bin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /─── gui-browser:/);
  assert.match(result.stdout, /BROWSER_STEP_EXECUTED/);
  assert.match(result.stdout, /pass\s+gui-browser/);
  assert.deepEqual(
    (await readFile(invocationLog, "utf8")).trimEnd().split("\n"),
    ["--prefix", "gui", "run", "test:browser"],
  );
});
