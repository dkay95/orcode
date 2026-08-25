#!/usr/bin/env node

const moduleUrl = process.env.ORCODE_PTY_TUI_MODULE;
if (!moduleUrl) {
  throw new Error("ORCODE_PTY_TUI_MODULE fehlt.");
}

const { TerminalUi } = await import(moduleUrl);

const state = {
  workspace: "/tmp/orcode-pty-workspace",
  projectStatus: "pty-smoke · Git main · sauber",
  model: "openrouter/auto",
  modelDetails: "PTY Release-Smoke",
  approval: "ask",
  compressor: "auto",
  compressorModel: "openrouter/free",
  reasoning: "auto",
  balance: "nicht abgefragt",
  sessionCost: "$0.000",
  maxCost: "$1.000",
  maxSteps: 1,
  keyStatus: "nicht benötigt",
};

const ready = {
  stdinTTY: process.stdin.isTTY === true,
  stdoutTTY: process.stdout.isTTY === true,
  columns: process.stdout.columns ?? null,
  rows: process.stdout.rows ?? null,
};
process.stdout.write(`ORCODE_PTY_READY:${JSON.stringify(ready)}\n`);

const ui = new TerminalUi(() => state, process.stdin, process.stdout);
let timeout;

const categories = [
  "Models & Reasoning", "Providers & Accounts", "Automation & Permissions",
  "Voice & Browser", "Costs & Limits", "Appearance",
].map((label, index) => ({ id: `category-${index + 1}`, label, description: label }));
const settingsView = {
  categories,
  items: [],
  allItems: [],
  selectedCategoryId: categories[0].id,
  selectedItemId: null,
  search: { active: false, query: "" },
  readOnlyReason: null,
  runActive: false,
  notice: null,
};

try {
  if (!ui.supported) {
    throw new Error("TerminalUi erkennt stdin/stdout nicht als unterstütztes TTY-Paar.");
  }
  ui.start();
  await ui.suspend(async () => {});
  process.stdout.write("ORCODE_PTY_RESUMED\n");
  ui.begin(settingsView);
  process.stdout.write("ORCODE_PTY_SETTINGS_READY\n");
  await ui.nextIntent(settingsView);
  process.stdout.write("ORCODE_PTY_SETTINGS_CATEGORY\n");
  await ui.nextIntent({ ...settingsView, selectedCategoryId: categories[5].id });
  ui.end();
  process.stdout.write("ORCODE_PTY_SETTINGS_RESTORED\n");
  const input = await Promise.race([
    ui.readInput(),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("TerminalUi lieferte innerhalb des Harness-Zeitlimits keine Eingabe.")),
        4_000,
      );
    }),
  ]);
  ui.stop();
  process.stdout.write(`\nORCODE_PTY_RESULT:${JSON.stringify({ value: input })}\n`);
} catch (error) {
  ui.stop();
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`\nORCODE_PTY_ERROR:${JSON.stringify({ message })}\n`);
  process.exitCode = 1;
} finally {
  if (timeout) clearTimeout(timeout);
}
