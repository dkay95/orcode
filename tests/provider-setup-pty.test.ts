import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { scanForSecrets } from "../src/redaction.js";

interface ProviderPtyBuild {
  buildRoot: string;
  moduleRoot: string;
  cleanup(): Promise<void>;
}

interface ProviderPtyRun {
  homeAudit: {
    auditFailed: boolean;
    fileCount: number;
    privacyFindings: number;
    sha256: string;
    totalBytes: number;
  };
  output: string;
  outputBase64: string;
  ready: {
    homeIsolated: boolean;
    stdinTTY: boolean;
    stdoutTTY: boolean;
    columns: number;
    rows: number;
  };
  checkpoints: Array<Record<string, number>>;
  postFinishAcks: Array<{
    attempt: number;
    modelAttempt: number;
    confirmAttempt: number;
    counters: Record<string, number>;
  }>;
  result: {
    chatAccepted: boolean;
    counters: Record<string, number>;
    crossEnabled: boolean;
    failure: boolean;
    observedCandidateCount: number;
    observedCleanOnly: boolean;
    routeReady: boolean;
    setupKind: "ready" | "cancelled" | "failed";
    setupMode: "setup-required" | null;
    terminalLifecycle?: {
      activeDataListeners: number;
      finalDataListeners: number;
      firstSettlementCount: number;
      firstValueWasNull: boolean;
      restartedDataListeners: number;
      restartedValueLength: number;
      stoppedDataListeners: number;
    };
  };
}

interface ProviderPtyHarnessModule {
  buildFreshProviderSetupModules(
    projectRoot: string,
    options?: { pasteEndSubmits?: boolean },
  ): Promise<ProviderPtyBuild>;
  runProviderSetupPtyScenario(options: {
    controllerTimeoutMs?: number;
    platform?: string;
    projectRoot: string;
    pythonExecutable?: string;
    moduleRoot: string;
    scenario: string;
  }): Promise<ProviderPtyRun>;
  syntheticProviderCredential(): string;
  syntheticProviderCredentialFragments(): readonly string[];
  syntheticInvalidProviderCredentials(): Readonly<Record<string, string>>;
  containsPrivateHomeForProof(value: string): boolean;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_MODULE = "./fixtures/provider-setup-pty-harness.mjs";
let harness: ProviderPtyHarnessModule;
let build: ProviderPtyBuild | undefined;
const POSIX_PTY_ONLY = {
  skip: process.platform === "win32"
    ? "The real provider transcript proof requires a POSIX PTY; Windows ConPTY is not claimed."
    : false,
} as const;

before(async () => {
  harness = await import(HARNESS_MODULE) as ProviderPtyHarnessModule;
  if (process.platform !== "win32") {
    build = await harness.buildFreshProviderSetupModules(PROJECT_ROOT);
  }
});

after(async () => {
  await build?.cleanup();
});

async function run(scenario: string): Promise<ProviderPtyRun> {
  if (!build) throw new Error("The POSIX provider proof build is unavailable.");
  return harness.runProviderSetupPtyScenario({
    projectRoot: PROJECT_ROOT,
    moduleRoot: build.moduleRoot,
    scenario,
  });
}

function assertTranscriptPrivate(runResult: ProviderPtyRun): void {
  const candidate = harness.syntheticProviderCredential();
  const uniqueBody = ["task-ten-alpha", "task-ten-beta", "task-ten-gamma"].join("-");
  const raw = Buffer.from(runResult.outputBase64, "base64");
  assert.equal(runResult.output.includes(candidate), false);
  assert.equal(runResult.output.includes(uniqueBody), false);
  for (const fragment of harness.syntheticProviderCredentialFragments()) {
    assert.equal(raw.includes(Buffer.from(fragment)), false);
  }
  assert.deepEqual(scanForSecrets(runResult.output), []);
  assert.equal(containsPrivateHomeInTranscript(runResult.output), false);
  assert.deepEqual(runResult.homeAudit, {
    auditFailed: false,
    fileCount: 0,
    privacyFindings: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    totalBytes: 0,
  });
}

function containsPrivateHomeInTranscript(value: string): boolean {
  return /(?:file:\/\/)?(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root(?:\/|\b)|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+)/.test(value);
}

function serializedWindowsPrivateHomes(): string[] {
  const separator = "\\";
  const windowsHome = ["C:", ["Us", "ers"].join(""), "private-person", "project"]
    .join(separator);
  const windowsFileUrl = `file:///${windowsHome}`;
  return [
    windowsHome,
    JSON.stringify(windowsHome),
    JSON.stringify({ home: windowsHome }),
    JSON.stringify(windowsFileUrl),
  ];
}

function assertNoRejectedEffects(runResult: ProviderPtyRun): void {
  assert.deepEqual(runResult.result.counters, {
    activation: 0,
    adapter: 0,
    config: 0,
    credentialStore: 0,
    discard: 0,
    modelCatalog: 0,
    network: 0,
    state: 0,
  });
  assert.equal(runResult.result.observedCandidateCount, 0);
  assert.equal(runResult.result.routeReady, false);
  assert.equal(runResult.result.crossEnabled, false);
  assert.equal(runResult.result.setupKind, "cancelled");
  assert.equal(runResult.result.setupMode, "setup-required");
  assertTranscriptPrivate(runResult);
}

test("Windows CI skips only the POSIX transcript proof while privacy and unsupported-platform contracts pass", async () => {
  const error = await harness.runProviderSetupPtyScenario({
    platform: "win32",
    projectRoot: PROJECT_ROOT,
    moduleRoot: "unused-on-unsupported-platform",
    pythonExecutable: "must-not-be-invoked",
    scenario: "success",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: unknown }).code, "provider-pty-posix-unsupported");
  assert.match(error.message, /requires a POSIX PTY/);
  assert.doesNotMatch(error.message, /ConPTY/i);
});

test("serialized Windows private homes fail transcript and isolated-home scanning", async () => {
  for (const dirty of serializedWindowsPrivateHomes()) {
    assert.equal(containsPrivateHomeInTranscript(dirty), true);
    assert.equal(harness.containsPrivateHomeForProof(dirty), true);
  }
});

test("real POSIX provider setup masks Unicode-wrapped CRLF paste and submits only after later Enter", POSIX_PTY_ONLY, async () => {
  const result = await run("success");

  assert.deepEqual(result.ready, {
    homeIsolated: true,
    stdinTTY: true,
    stdoutTTY: true,
    columns: 100,
    rows: 30,
  });
  assert.deepEqual(result.checkpoints, [{
    activation: 0,
    adapter: 0,
    config: 0,
    credentialStore: 0,
    state: 0,
  }]);
  assert.deepEqual(result.postFinishAcks, [{
    attempt: 1,
    modelAttempt: 0,
    confirmAttempt: 0,
    counters: {
      activation: 0,
      adapter: 0,
      config: 0,
      credentialStore: 0,
      discard: 0,
      modelCatalog: 0,
      network: 0,
      state: 0,
    },
  }]);
  assert.equal(result.result.failure, false);
  assert.equal(result.result.observedCandidateCount, 1);
  assert.equal(result.result.observedCleanOnly, true);
  assert.equal(result.result.setupKind, "ready");
  assert.equal(result.result.routeReady, true);
  assert.equal(result.result.crossEnabled, false);
  assert.equal(result.result.counters.activation, 1);
  assert.equal(result.result.counters.adapter, 1);
  assert.equal(result.result.counters.credentialStore, 1);
  assert.equal(result.result.counters.config, 1);
  assert.equal(result.result.counters.network, 0);
  assert.equal(result.result.counters.state, 1);
  // FIX-12: there is no longer an "unavailable capability" explanation to
  // order against the secret prompt. It came from two hub rows — "Codex"
  // and "Anthropic / Claude", each saying only "Coming soon is not
  // selectable" — for backends `BackendRegistry` structurally refuses to
  // make connectable at all, pushed into the owner's chat transcript on
  // every setup run. Proven here on the real PTY: they are gone from it.
  assert.doesNotMatch(result.output, /Coming soon/i);
  const secretAt = result.output.indexOf('ORCODE_PROVIDER_STAGE:{"stage":"secret","attempt":1}');
  assert.ok(secretAt >= 0, "the secret prompt stage must be reached");
  // F7 fix round 1, Critical C1 (this is the real-PTY proof I1 asked for):
  // this harness already drives `createTuiSetupSurface` against a real
  // `TerminalUi` (`provider-setup-pty-harness.mjs`), so the pre-secret cost
  // disclosure's fullscreen visibility is provable here directly, on the
  // exact real rendering pipeline — not just the synthetic frame test in
  // tui.test.ts. Before the C1 fix this text was silently dropped.
  const costAt = result.output.indexOf("pay as you go billing through OpenRouter");
  assert.ok(costAt >= 0, "the pre-secret cost disclosure must be visible on the real fullscreen PTY surface");
  assert.ok(costAt < secretAt, "the cost disclosure must precede the secret prompt");
  assert.doesNotMatch(result.output, /Prepare roles|Collaboration remains off/i);
  assertTranscriptPrivate(result);
});

test("real POSIX provider setup rejects NUL ANSI and embedded controls before every provider or store effect", POSIX_PTY_ONLY, async (t) => {
  for (const scenario of ["reject-nul", "reject-ansi", "reject-control"] as const) {
    await t.test(scenario, async () => {
      const result = await run(scenario);
      const invalid = Buffer.from(
        harness.syntheticInvalidProviderCredentials()[scenario]!,
        "base64",
      );
      assert.equal(Buffer.from(result.outputBase64, "base64").includes(invalid), false);
      assert.match(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"rejected","attempt":1\}/);
      assert.match(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"hub","attempt":2\}/);
      // FIX-18: the failed round's settled outcome must be VISIBLE on the
      // real fullscreen surface — before the fix it only ever reached the
      // status line, which the returning picker clobbered same-tick.
      assert.match(result.output, /OpenRouter setup failed\. Try again\./);
      assertNoRejectedEffects(result);
    });
  }
});

test("real POSIX identity-less validated key names its failure instead of dying silently", POSIX_PTY_ONLY, async () => {
  // The F1 silent death (both 2026-08-28 flow hunters): a key that VALIDATES
  // (health valid/connected) but carries no account identity used to kill the
  // whole setup flow between credential validation and the model chooser —
  // /models never requested, nothing saved, no error, no cancel notice.
  const result = await run("identity-missing");

  assert.equal(result.result.failure, false);
  assert.equal(result.result.setupKind, "cancelled");
  assert.equal(result.result.setupMode, "setup-required");
  assert.equal(result.result.chatAccepted, true);
  // The catalog must never have been requested — and every store stays clean.
  assert.equal(result.result.counters.modelCatalog, 0);
  assert.equal(result.result.counters.activation, 0);
  assert.equal(result.result.counters.credentialStore, 0);
  assert.equal(result.result.counters.state, 0);
  assert.equal(result.result.routeReady, false);
  // The named failure is visible on the real PTY surface, and the flow
  // returned to the picker (hub attempt 2) instead of exiting silently.
  assert.match(result.output, /validated the API key but did not identify the account/);
  assert.match(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"hub","attempt":2\}/);
  assert.match(result.output, /Setup cancelled/i);
  assert.doesNotMatch(result.output, /account is ready|setup complete|saved successfully/i);
  assertTranscriptPrivate(result);
});

test("real POSIX rejected secret clears before one clean retry", POSIX_PTY_ONLY, async () => {
  const result = await run("retry-clean");

  assert.equal(result.result.failure, false);
  assert.equal(result.result.observedCandidateCount, 1);
  assert.equal(result.result.observedCleanOnly, true);
  assert.equal(result.result.counters.adapter, 1);
  assert.equal(result.result.counters.activation, 1);
  assert.equal(result.result.counters.network, 0);
  assert.equal(result.result.routeReady, true);
  assert.equal(result.result.crossEnabled, false);
  const invalid = Buffer.from(
    harness.syntheticInvalidProviderCredentials()["retry-clean"]!,
    "base64",
  );
  assert.equal(Buffer.from(result.outputBase64, "base64").includes(invalid), false);
  assert.match(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"rejected","attempt":1\}/);
  assert.match(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"hub","attempt":2\}/);
  // FIX-18: the failed first round's settled outcome is durably visible.
  assert.match(result.output, /OpenRouter setup failed\. Try again\./);
  assertTranscriptPrivate(result);
});

test("real POSIX Escape before secret or model activation keeps setup-required chat live", POSIX_PTY_ONLY, async (t) => {
  for (const scenario of ["escape-secret", "escape-model"] as const) {
    await t.test(scenario, async () => {
      const result = await run(scenario);
      assert.equal(result.result.failure, false);
      assert.equal(result.result.setupKind, "cancelled");
      assert.equal(result.result.setupMode, "setup-required");
      assert.equal(result.result.chatAccepted, true);
      assert.equal(result.result.counters.activation, 0);
      assert.equal(result.result.counters.credentialStore, 0);
      assert.equal(result.result.counters.config, 0);
      assert.equal(result.result.counters.state, 0);
      assert.equal(result.result.routeReady, false);
      assert.equal(result.result.crossEnabled, false);
      assert.match(result.output, /Setup cancelled/i);
      assert.doesNotMatch(result.output, /account is ready|setup complete|saved successfully/i);
      assertTranscriptPrivate(result);
    });
  }
});

// FIX-12: this scenario used to be called "unavailable-state" and proved
// that two non-selectable explanation rows reached the real terminal. One
// of them (Codex) was fabricated for a backend with no descriptor and is
// gone; the other survives on the real PTY as an honest redirect rather
// than a promise. The rest of what this proves is unchanged: escaping the
// hub cancels cleanly and leaves the chat live.
test("real POSIX escape at the hub cancels cleanly, redirects for Claude, and promises nothing", POSIX_PTY_ONLY, async () => {
  const result = await run("escape-hub");

  assertNoRejectedEffects(result);
  assert.equal(result.result.failure, false);
  assert.equal(result.result.chatAccepted, true);
  assert.match(result.output, /Not available as a direct backend/);
  assert.doesNotMatch(result.output, /Coming soon/i);
  assert.doesNotMatch(result.output, /Codex/i);
  assert.doesNotMatch(result.output, /ORCODE_PROVIDER_STAGE:\{"stage":"secret"/);
  assert.match(result.output, /Setup cancelled/i);
  assert.doesNotMatch(result.output, /account is ready|setup complete|saved successfully/i);
});

test("real POSIX stop clears a pending pasted secret before restart and balances raw listeners", POSIX_PTY_ONLY, async () => {
  const result = await run("stop-secret-restart");

  assert.equal(result.result.failure, false);
  assert.deepEqual(result.result.terminalLifecycle, {
    activeDataListeners: 2,
    finalDataListeners: 1,
    firstSettlementCount: 1,
    firstValueWasNull: true,
    restartedDataListeners: 2,
    restartedValueLength: 0,
    stoppedDataListeners: 1,
  });
  assert.equal(result.result.observedCandidateCount, 0);
  assert.equal(result.result.routeReady, false);
  assert.equal(result.result.crossEnabled, false);
  assertTranscriptPrivate(result);
});

test("bounded POSIX provider proof failures expose only safe counts and a one-way transcript digest", POSIX_PTY_ONLY, async () => {
  const error = await run("unknown-proof-scenario").then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  const safe = error as Error & {
    code?: unknown;
    homeAuditFailed?: unknown;
    homeFileCount?: unknown;
    homePrivacyFindings?: unknown;
    homeSha256?: unknown;
    homeTotalBytes?: unknown;
    outputBytes?: unknown;
    outputSha256?: unknown;
    privacyFindings?: unknown;
  };
  assert.equal(safe.code, "provider-pty-controller-failed");
  assert.equal(typeof safe.outputBytes, "number");
  assert.match(String(safe.outputSha256), /^[a-f0-9]{64}$/);
  assert.equal(safe.privacyFindings, 0);
  assert.equal(safe.homeAuditFailed, false);
  assert.equal(safe.homeFileCount, 0);
  assert.equal(safe.homePrivacyFindings, 0);
  assert.match(String(safe.homeSha256), /^[a-f0-9]{64}$/);
  assert.equal(safe.homeTotalBytes, 0);
  assert.equal("outputBase64" in safe, false);
  assert.equal("stdout" in safe, false);
  assert.equal("stderr" in safe, false);
  assert.deepEqual(scanForSecrets(JSON.stringify({
    code: safe.code,
    outputBytes: safe.outputBytes,
    outputSha256: safe.outputSha256,
    privacyFindings: safe.privacyFindings,
    homeAuditFailed: safe.homeAuditFailed,
    homeFileCount: safe.homeFileCount,
    homePrivacyFindings: safe.homePrivacyFindings,
    homeSha256: safe.homeSha256,
    homeTotalBytes: safe.homeTotalBytes,
  })), []);
});

test("forced outer POSIX controller timeout leaves no harness process group and exposes only safe cleanup facts", POSIX_PTY_ONLY, async () => {
  if (!build) throw new Error("The POSIX provider proof build is unavailable.");
  const error = await harness.runProviderSetupPtyScenario({
    controllerTimeoutMs: 1_500,
    projectRoot: PROJECT_ROOT,
    moduleRoot: build.moduleRoot,
    scenario: "force-outer-timeout",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  const safe = error as Error & {
    childStarted?: unknown;
    code?: unknown;
    homeAuditFailed?: unknown;
    homeFileCount?: unknown;
    homePrivacyFindings?: unknown;
    homeSha256?: unknown;
    homeTotalBytes?: unknown;
    outputBytes?: unknown;
    outputSha256?: unknown;
    privacyFindings?: unknown;
    processGroupAliveAfterCleanup?: unknown;
  };
  assert.equal(safe.code, "provider-pty-controller-failed");
  assert.equal(safe.childStarted, true);
  assert.equal(safe.processGroupAliveAfterCleanup, false);
  assert.equal(typeof safe.outputBytes, "number");
  assert.match(String(safe.outputSha256), /^[a-f0-9]{64}$/);
  assert.equal(safe.privacyFindings, 0);
  assert.equal(safe.homeAuditFailed, false);
  assert.equal(safe.homeFileCount, 0);
  assert.equal(safe.homePrivacyFindings, 0);
  assert.match(String(safe.homeSha256), /^[a-f0-9]{64}$/);
  assert.equal(safe.homeTotalBytes, 0);
  assert.equal("outputBase64" in safe, false);
  assert.equal("stdout" in safe, false);
  assert.equal("stderr" in safe, false);
  assert.equal("pid" in safe, false);
  assert.deepEqual(scanForSecrets(JSON.stringify({
    childStarted: safe.childStarted,
    code: safe.code,
    outputBytes: safe.outputBytes,
    outputSha256: safe.outputSha256,
    privacyFindings: safe.privacyFindings,
    homeAuditFailed: safe.homeAuditFailed,
    homeFileCount: safe.homeFileCount,
    homePrivacyFindings: safe.homePrivacyFindings,
    homeSha256: safe.homeSha256,
    homeTotalBytes: safe.homeTotalBytes,
    processGroupAliveAfterCleanup: safe.processGroupAliveAfterCleanup,
  })), []);
});

test("real provider PTY proof rejects an end-triggered secret submission mutant before explicit Enter", POSIX_PTY_ONLY, async (t) => {
  const mutant = await harness.buildFreshProviderSetupModules(PROJECT_ROOT, {
    pasteEndSubmits: true,
  });
  t.after(() => mutant.cleanup());
  const error = await harness.runProviderSetupPtyScenario({
    projectRoot: PROJECT_ROOT,
    moduleRoot: mutant.moduleRoot,
    scenario: "success",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  const safe = error as Error & {
    code?: unknown;
    outputBase64?: unknown;
    privacyFindings?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  assert.equal(safe.code, "provider-pty-premature-submit");
  assert.equal(safe.privacyFindings, 0);
  assert.equal("outputBase64" in safe, false);
  assert.equal("stdout" in safe, false);
  assert.equal("stderr" in safe, false);
});
