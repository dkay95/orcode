#!/usr/bin/env node

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildIsFresh, isPtyCheckEntrypoint } from "./check-pty.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ROOT = "dist";

export async function runProviderSetupCliPtyCheck(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error(
      "The command-to-provider-setup PTY check requires POSIX; ConPTY was not checked.",
    );
  }

  const root = resolve(options.projectRoot ?? projectRoot);
  const accessFile = options.accessFile ?? access;
  for (const artifact of [
    join(root, MODULE_ROOT, "cli.js"),
    join(root, MODULE_ROOT, "tui.js"),
  ]) {
    try {
      await accessFile(artifact);
    } catch (error) {
      throw new Error(
        `Build artifact missing: ${artifact}. Run \`npm run build\` before \`npm run test:pty\`.`,
        { cause: error },
      );
    }
  }
  const harnessPath = join(root, "tests", "fixtures", "provider-setup-cli-pty-harness.mjs");
  try {
    await accessFile(harnessPath);
  } catch (error) {
    throw new Error(`Provider setup CLI PTY harness missing: ${harnessPath}.`, { cause: error });
  }

  const assertFresh = options.assertBuildIsFresh ?? assertBuildIsFresh;
  await assertFresh(root);
  const runScenario = options.runScenario ?? (await import(
    "../tests/fixtures/provider-setup-cli-pty-harness.mjs"
  )).runProviderSetupCliPtyScenario;
  const run = await runScenario({ projectRoot: root, moduleRoot: MODULE_ROOT });
  validateProviderSetupCliPtyRun(run);

  const log = options.log ?? console.log;
  log(
    "Real command-to-provider-setup POSIX PTY checked: cancel without provider effects · immediate explicit retry ready · clean exit.",
  );
  return run;
}

export function validateProviderSetupCliPtyRun(run) {
  assert.deepEqual(run.ready, {
    cliModule: "dist/cli.js",
    stdinTTY: true,
    stdoutTTY: true,
  });
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.forcedTermination, false, "the real CLI must drain and exit without a harness kill");
  assert.equal(run.homeAudit.credentialFindings, 0);
  assert.equal(run.homeAudit.fileCount, 0);
  assert.equal(run.homeAudit.totalBytes, 0);
  assert.deepEqual(run.result.commands, [
    "/provider setup",
    "/provider setup",
    "/provider",
    "/provider status",
    "/provider setup extra",
  ]);
  assert.deepEqual(run.result.providerIntents, [
    { kind: "setup" },
    { kind: "setup" },
    { kind: "status" },
  ], "bare /provider remains the legacy policy command and setup extra never reaches the provider port");
  assert.deepEqual(run.result.providerSelections, [null, "openrouter"]);
  assert.deepEqual(run.result.modelCatalogs, [["vendor/cli-first", "vendor/cli-selected"]]);
  assert.deepEqual(
    run.result.modelSelections,
    ["vendor/cli-selected"],
    "the owner explicitly chose the non-default model",
  );
  assert.deepEqual(run.result.secretEntries, [{ supplied: true, length: 45 }]);
  assert.deepEqual(run.result.confirmations, [true]);

  const emptySnapshot = {
    activationCount: 0,
    configWriteCount: 0,
    configMainModel: "openrouter/auto",
    connectCount: 0,
    connectionCount: 0,
    credentialSlotCount: 0,
    defaultRoute: null,
    modelListCount: 0,
    sessionRoute: null,
  };
  assert.deepEqual(run.result.setupSnapshots[0], {
    before: emptySnapshot,
    after: emptySnapshot,
    outcome: "cancelled",
  }, "Escape cancels visibly without connecting, selecting, or storing anything");

  const selectedRoute = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_or_cli_pty_owner_6f2a91",
    billingRealm: "openrouter-payg",
    requestedModelId: "vendor/cli-selected",
    canonicalModelId: "vendor/cli-selected",
    resolutionState: "resolved",
  };
  assert.deepEqual(run.result.setupSnapshots[1], {
    before: emptySnapshot,
    after: {
      activationCount: 1,
      configWriteCount: 1,
      configMainModel: "vendor/cli-selected",
      connectCount: 1,
      connectionCount: 1,
      credentialSlotCount: 1,
      defaultRoute: selectedRoute,
      modelListCount: 1,
      sessionRoute: selectedRoute,
    },
    outcome: "ready",
  });
  assert.deepEqual(run.result.counters, {
    activation: 1,
    agent: 0,
    configWrites: 1,
    connect: 1,
    discard: 1,
    inspect: 0,
    kimi: 0,
    listModels: 1,
    network: 0,
    persistence: 2,
  });
  assert.deepEqual(run.result.state, {
    lifecycle: "configured",
    revision: 2,
    connectionCount: 1,
    accountFingerprint: "acct_or_cli_pty_owner_6f2a91",
    defaultRoute: selectedRoute,
  });
  assert.equal(run.result.configMainModel, "vendor/cli-selected");
  assert.equal(run.result.configDiskMainModel, "vendor/cli-selected");
  assert.deepEqual(run.result.sessionRoute, selectedRoute);
  assert.equal(run.result.credentialStored, true);
  assert.equal(run.result.credentialSlotCount, 1);

  assert.match(run.output, /Provider setup: cancelled/);
  assert.match(run.output, /Provider setup: ready/);
  assert.match(
    run.output,
    /Sort: Default \(price\/availability\).*Data sharing: deny.*Provider fallbacks: on/s,
    "bare /provider keeps its legacy routing-policy result",
  );
  assert.match(run.output, /Cross: off/);
  assert.match(
    run.output,
    /Usage: \/provider \[setup\|connect\|login\|logout\|enable/,
    "the invalid extra argument reaches the existing usage error instead of starting setup",
  );
}

if (isPtyCheckEntrypoint(import.meta.url)) {
  runProviderSetupCliPtyCheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
