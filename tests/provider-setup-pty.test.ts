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
      assertNoRejectedEffects(result);
    });
  }
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
      assertTranscriptPrivate(result);
    });
  }
});

test("real POSIX Escape after activation is Later keeps the route ready and Cross off", POSIX_PTY_ONLY, async () => {
  const result = await run("escape-cross");

  assert.equal(result.result.failure, false);
  assert.equal(result.result.setupKind, "ready");
  assert.equal(result.result.chatAccepted, false);
  assert.equal(result.result.observedCleanOnly, true);
  assert.equal(result.result.counters.activation, 1);
  assert.equal(result.result.counters.network, 0);
  assert.equal(result.result.routeReady, true);
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
