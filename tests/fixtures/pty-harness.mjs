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

try {
  if (!ui.supported) {
    throw new Error("TerminalUi erkennt stdin/stdout nicht als unterstütztes TTY-Paar.");
  }
  ui.start();
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
